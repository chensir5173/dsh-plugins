// Behavioural harness for dsh-esc-rewind/src/client.js.
//
// WHY THIS EXISTS
// The plugin is a browser classic-script bundle with no build step, so it
// cannot be imported normally. This harness materializes the bundle the way
// @deepseek-ai/dsh-client-modules does — window.__ModuleLoader__.load({id,
// factory}) then factory(require) — with a minimal deps-aware React shim and
// fake client services (sessions/workspaces/conversation/uiConversation/
// commandUi), then drives the pure decision helpers, the ESC capture listener,
// the doRewind engine and the /rewind contribution so the logic is executed
// and asserted instead of eyeballed.
//
// It is a LOGIC harness, not a browser render: real Lexical/React rendering,
// DOM overlay detection and host round-trips are approximated. The parts that
// need a real browser are listed in ACCEPTANCE.md.
//
// Run: node dsh-esc-rewind/test/bundle.test.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const bundlePath = path.join(here, '..', 'src', 'client.js')
const PKG_ID = 'dsh-esc-rewind'
const NS = 'esc-rewind'

// --- browser-ish globals -----------------------------------------------------

Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { languages: ['zh-CN'], language: 'zh-CN' },
})

// Minimal localStorage so the persisted /rewind history cache is exercised.
const lsStore = new Map()
globalThis.localStorage = {
  getItem: (k) => (lsStore.has(k) ? lsStore.get(k) : null),
  setItem: (k, v) => { lsStore.set(k, String(v)) },
  removeItem: (k) => { lsStore.delete(k) },
}

let keydownHandler = null
let keydownCapture = null
globalThis.window = {
  addEventListener() {},
  removeEventListener() {},
}
globalThis.document = {
  addEventListener: (type, fn, capture) => {
    if (type === 'keydown') { keydownHandler = fn; keydownCapture = capture === true }
  },
  removeEventListener: (type) => { if (type === 'keydown') keydownHandler = null },
}

const factories = new Map()
globalThis.window.__ModuleLoader__ = { load: ({ id, factory }) => factories.set(id, factory) }

// --- deps-aware React shim ---------------------------------------------------

function sameDeps(a, b) {
  if (a === b) return true
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false
  return true
}

function makeReact() {
  let slots = []
  let index = 0
  let dirty = false
  const React = {
    createElement: (type, props, ...children) => ({
      __element: true, type,
      props: { ...(props || {}), children: children.length === 1 ? children[0] : children },
    }),
    Fragment: Symbol('Fragment'),
    useState(initial) {
      const i = index++
      if (!(i in slots)) slots[i] = { value: typeof initial === 'function' ? initial() : initial }
      const slot = slots[i]
      return [slot.value, (next) => {
        const v = typeof next === 'function' ? next(slot.value) : next
        if (v !== slot.value) { slot.value = v; dirty = true }
      }]
    },
    useRef(initial) {
      const i = index++
      if (!(i in slots)) slots[i] = { current: initial }
      return slots[i]
    },
    useEffect(effect, deps) {
      const i = index++
      if (!(i in slots)) slots[i] = { init: false, deps: undefined, cleanup: undefined }
      const slot = slots[i]
      if (!slot.init || !sameDeps(slot.deps, deps)) {
        if (typeof slot.cleanup === 'function') { try { slot.cleanup() } catch { /* noop */ } }
        slot.cleanup = effect()
        slot.deps = deps
        slot.init = true
      }
    },
    useCallback(fn, deps) {
      const i = index++
      if (!(i in slots)) slots[i] = { fn, deps }
      const slot = slots[i]
      if (!sameDeps(slot.deps, deps)) { slot.fn = fn; slot.deps = deps }
      return slot.fn
    },
    useMemo(fn, deps) {
      const i = index++
      if (!(i in slots)) slots[i] = { init: false, deps: undefined, value: undefined }
      const slot = slots[i]
      if (!slot.init || !sameDeps(slot.deps, deps)) { slot.value = fn(); slot.deps = deps; slot.init = true }
      return slot.value
    },
  }
  return {
    React,
    beginRender() { index = 0; dirty = false },
    freshInstance() { slots = []; index = 0; dirty = false },
    isDirty: () => dirty,
  }
}

const { React, beginRender, freshInstance, isDirty } = makeReact()

const toasts = []
const primitives = {
  Toast: ({ text }) => { toasts.push(text); return { __toast: text } },
  // Headless modal stub: the harness never materializes its subtree.
  Modal: ({ children, ...rest }) => ({ __modal: true, rest, children }),
}

function requireStub(specifier) {
  if (specifier === 'react') return React
  if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return primitives
  throw new Error(`unexpected require("${specifier}")`)
}

// --- load the bundle ---------------------------------------------------------

const source = fs.readFileSync(bundlePath, 'utf8')
// eslint-disable-next-line no-new-func -- mirroring the browser classic-script evaluation
new Function('window', 'navigator', 'document', source)(globalThis.window, globalThis.navigator, globalThis.document)

const tests = []
const test = (name, fn) => tests.push([name, fn])

function freshApply() {
  const factory = factories.get(PKG_ID)
  assert.ok(factory, `bundle did not register id "${PKG_ID}"`)
  return factory(requireStub)
}

// --- fake services -----------------------------------------------------------

function makeChatNode({ kind, seq, time = 0, text = '', images = [], extra = {} }) {
  if (kind === 'assistant') {
    return { kind, anchorSeq: seq, data: { status: extra.status || 'settled', blocks: text ? [{ kind: 'text', text }] : [], time } }
  }
  const content = []
  if (text) content.push({ type: 'text', text })
  for (const image of images) content.push({ type: 'image', attachment: { attachmentId: image } })
  return { kind, anchorSeq: seq, data: { kind, seq, time, content, source: {} } }
}

function makeServices(overrides = {}) {
  const calls = {
    cancels: [],
    forks: [],
    creates: [],
    opens: [],
    archived: [],
    archiveOptions: [],
    queueRemoves: [],
    renames: [],
    readAttachments: [],
    loadThrough: [],
    loadOlder: [],
    // 草稿附件桥接：记录实际被调用的世代（新名/旧名各一条）。
    draftCreates: [],
    draftReleases: [],
  }
  const bindings = {}
  const summaries = {}
  let nextId = 1

  const makeBinding = (id, runningNow) => {
    // 真机 SessionSnapshot 的形态：queue（宿主 queue 帧）/ pendingSubmissions（本地回声）
    // 都在快照里；inbox 走宿主投影通道（projections.faceOf('inbox')），未广播时是 undefined。
    const live = { running: runningNow === true, queue: [], hasMore: false, pendingSubmissions: [], inbox: undefined }
    const face = {
      sessionId: id,
      live,
      getSnapshot: () => live,
      // 0.1.5 起宿主把收件箱做成耐久投影（{'next-turn','next-step'}），随页面 baseline 下发。
      projections: {
        faceOf: (key) => ({ getSnapshot: () => (key === 'inbox' ? live.inbox : undefined) }),
      },
      cancel: async () => { calls.cancels.push(id); live.running = false; return { ok: true } },
      updateQueue: async (itemId, action) => {
        calls.queueRemoves.push([itemId, action])
        if (action && action.kind === 'remove' && overrides.stubbornQueue !== true) {
          live.queue = live.queue.filter((item) => item.id !== itemId)
          // 宿主删除同样落在收件箱投影上，删除后投影必须能被确认清空。
          if (live.inbox && typeof live.inbox === 'object') {
            live.inbox = {
              'next-turn': (live.inbox['next-turn'] || []).filter((m) => m.id !== itemId),
              'next-step': (live.inbox['next-step'] || []).filter((m) => m.id !== itemId),
            }
          }
        }
        return { ok: true }
      },
      rename: async (title) => { calls.renames.push([id, title]); summaries[id].title = title; return { ok: true, value: { title, seq: 0 } } },
      readAttachment: async (attachmentId) => {
        calls.readAttachments.push(attachmentId)
        if (typeof overrides.readAttachment === 'function') return overrides.readAttachment(attachmentId)
        return { ok: false }
      },
      loadThrough: async (seq) => {
        calls.loadThrough.push([id, seq])
        if (typeof overrides.onLoadThrough === 'function') await overrides.onLoadThrough(face, seq)
        live.hasMore = false
      },
      loadOlder: async () => {
        calls.loadOlder.push(id)
        if (typeof overrides.onLoadOlder === 'function') await overrides.onLoadOlder(face)
        live.hasMore = false
      },
    }
    bindings[id] = { sessionId: id, session: face }
    return face
  }

  const sessions = {
    list: { getSnapshot: () => ({ ids: Object.keys(summaries), byId: { ...summaries } }) },
    binding: (id) => bindings[id] || undefined,
    fork: async (opts) => {
      calls.forks.push(opts)
      if (overrides.failFork === true) throw new Error('fork exploded')
      const childId = 'child-' + (nextId++)
      summaries[childId] = { id: childId, title: 'Fork Title', displayTitle: 'Fork Title' }
      makeBinding(childId, false)
      if (typeof overrides.onForked === 'function') overrides.onForked(childId, bindings[childId])
      return childId
    },
    create: async (opts) => {
      calls.creates.push(opts || {})
      const childId = 'blank-' + (nextId++)
      summaries[childId] = { id: childId, blank: true, displayTitle: childId }
      makeBinding(childId, false)
      return childId
    },
    // 0.2.0 的 sessions 面**没有** open —— 真机调用它会抛 "sessions.open is not a
    // function"（/rewind 选择器里的那条红字）。夹具必须与真机一致，否则插件里残留的
    // sessions.open 会被这层假能力掩盖。切换会话的动词在 uiWorkspace 上（见下）。
  }
  const uiWorkspace = overrides.noUiWorkspace === true
    ? undefined
    : {
        openSession: (id) => {
          calls.opens.push(id)
          // 真机顺序：openSession 触发 React 提交（子会话的桥先挂载），插件的 arm 在其后。
          if (typeof overrides.onOpen === 'function') overrides.onOpen(id)
        },
      }
  const workspaces = {
    list: { getSnapshot: () => ({ items: [{ workspaceId: 'w1', sessionIds: Object.keys(summaries) }] }) },
    // 0.2.0：archiveSession(id, options?) 返回 RemoteResult（拒绝不抛异常），
    // 且对「仍有运行中工作」的会话默认拒绝，需要 { stopActivity: true } 才停+归档。
    archiveSession: async (id, options) => {
      calls.archived.push(id)
      calls.archiveOptions.push(options)
      if (typeof overrides.archiveSession === 'function') return overrides.archiveSession(id, options, calls)
      return undefined
    },
  }
  // 草稿附件桥接的夹具：0.1.5-rc.2 起核心把「图片草稿」泛化为「附件草稿」并改名，
  // 所以 fixture 可以按世代装配——'legacy'（0.1.2 及更早）/ 'next'（0.1.5+）/ 'none'。
  // 插件必须只靠能力探测选名字，两代都走通，缺能力时降级而不是抛错。
  const draftApi = overrides.draftApi || 'legacy'
  const conversation = draftApi === 'none'
    ? {}
    : draftApi === 'next'
      ? {
          createDrafts: (sessionId, files) => {
            calls.draftCreates.push(['createDrafts', sessionId, files.length])
            return files.map((file, i) => ({ id: 'att-' + (nextId++) + '-' + i, file }))
          },
          releaseDraftAttachment: (id) => { calls.draftReleases.push(['releaseDraftAttachment', id]) },
        }
      : {
          createDraftImages: (files) => {
            calls.draftCreates.push(['createDraftImages', undefined, files.length])
            return files.map((file, i) => ({ id: 'img-' + (nextId++) + '-' + i, file }))
          },
          releaseDraftImage: (id) => { calls.draftReleases.push(['releaseDraftImage', id]) },
        }
  const contributions = []
  const uiConversation = {
    binding: (id) => {
      const chat = overrides.chatOf ? overrides.chatOf(id) : null
      // Real core: SnapshotStore/ObservableSnapshot expose getSnapshot().
      return { snapshot: { getSnapshot: () => ({ views: { get: (key) => (key === 'chat' ? chat : undefined) } }) } }
    },
  }
  const commandUi = {
    register: (contribution) => { contributions.push(contribution); return () => {} },
  }

  // Fake client remote.settings controller (delete-mode switch persistence).
  const settingsCalls = { describes: 0, updates: [] }
  let settingsValue = { deleteOldOnRewind: false }
  let settingsDescribeError = null
  let settingsUpdateError = null
  const settings = {
    describe: async () => {
      settingsCalls.describes += 1
      if (settingsDescribeError) throw settingsDescribeError
      return {
        namespaces: [
          { ns: 'esc-rewind', value: { ...settingsValue }, revision: 1 },
        ],
      }
    },
    update: async (ns, patch, rev) => {
      settingsCalls.updates.push([ns, patch, rev])
      if (settingsUpdateError) throw settingsUpdateError
      if (ns === 'esc-rewind') settingsValue = { ...settingsValue, ...patch }
      return { ns, value: { ...settingsValue }, revision: (rev || 0) + 1 }
    },
  }
  const setSettingsValue = (v) => { settingsValue = { deleteOldOnRewind: v === true } }
  const setSettingsDescribeError = (e) => { settingsDescribeError = e || null }
  const setSettingsUpdateError = (e) => { settingsUpdateError = e || null }

  const state = { bindings, summaries, sessions, uiWorkspace, workspaces, conversation, uiConversation, commandUi, contributions, calls,
    settings, settingsCalls, setSettingsValue, setSettingsDescribeError, setSettingsUpdateError,
    // 槽位存在性：null = 全部存在（默认）；数组 = 只认这些槽名（模拟旧核心没有 main.conversation）。
    slotsAvailable: Array.isArray(overrides.slotsAvailable) ? overrides.slotsAvailable : null }
  state.seed = (id, { running = false, title = 'Title', queue = [], inbox = undefined, pendingSubmissions = [] } = {}) => {
    summaries[id] = { id, title, displayTitle: title }
    const face = makeBinding(id, running)
    face.live.queue = queue
    face.live.pendingSubmissions = pendingSubmissions
    if (inbox !== undefined) face.live.inbox = inbox
    bindings[id] = { sessionId: id, session: face }
  }
  state.setRunning = (id, running) => {
    const binding = bindings[id]
    if (binding && binding.session && binding.session.live) {
      binding.session.live.running = running
    }
  }
  state.setHasMore = (id, hasMore) => {
    const binding = bindings[id]
    if (binding && binding.session && binding.session.live) {
      binding.session.live.hasMore = hasMore
    }
  }
  return state
}

function makeCtx(services) {
  const registered = []
  if (services && typeof services === 'object') services.registered = registered
  const ctx = {
    registered,
    get: (name) => (services[name] !== undefined ? services[name] : undefined),
    effect: () => () => {},
    on: () => () => {},
    inject: (names, cb) => {
      const sub = {}
      let complete = true
      for (const name of names) {
        if (services[name] !== undefined) sub[name] = services[name]
        else complete = false
      }
      if (complete) cb(sub)
      return () => {}
    },
    slots: {
      inject: (slotName, build) => {
        const available = services.slotsAvailable
        if (available === null || available.includes(slotName)) build()
      },
      register: (options, component) => { registered.push({ options, component }); return { dispose() {} } },
    },
  }
  return ctx
}

function applyWith(services) {
  freshApply().apply(makeCtx(services))
  return services
}

// --- internals ---------------------------------------------------------------

function internals() {
  return globalThis.window.__dsewInternals
}

function moduleState() {
  // Reads current internal module state through the exported probe.
  return globalThis.window.__dsewProbe ? globalThis.window.__dsewProbe() : null
}

// --- node-list scenario helpers ----------------------------------------------

const settled = (seq, text) => makeChatNode({ kind: 'assistant', seq, text, extra: { status: 'settled' } })
const interrupted = (seq, text) => makeChatNode({ kind: 'assistant', seq, text, extra: { status: 'interrupted' } })
const runningAssistant = (seq) => makeChatNode({ kind: 'assistant', seq, text: '', extra: { status: 'running' } })
const user = (seq, text, images) => makeChatNode({ kind: 'user', seq, text, images })

function chatOf(nodes) {
  const order = []
  const map = new Map()
  nodes.forEach((node, i) => {
    const key = String(i)
    order.push(key)
    map.set(key, node)
  })
  return { order, nodes: { get: (k) => map.get(k) }, legacy: null }
}

// --- production-shaped chat (what the real GUI hands the plugin) --------------
//
// 真机里插件的 chatNodeList() 走 `chat.legacy.nodes` 分支，而那份列表是
// LegacySliceBuilder 的产物，与上面 chatOf() 的 view-node 形态有两处关键差别：
//   1) 运行中的 assistant 行**不产出节点**（内容只进 legacy.partial），
//      所以生成期间列表的尾部是「本轮刚发出的 user 提问」；
//   2) 节点是宿主耐久记录（assistant 行带 blocks / 可选 interrupted），
//      **没有 status 字段**——「是否被中断」只能靠 interrupted 标记判断。
// 提示判据必须在真机形态下成立，故新增这组构造器与对应用例。

/** 真机形态的 user 记录节点。 */
function legacyUser(seq, text) {
  return {
    kind: 'user',
    seq,
    time: seq * 1000,
    content: text === undefined ? [] : [{ type: 'text', text }],
    source: { kind: 'user' },
  }
}

/** 真机形态的 assistant 耐久节点（interrupted 由宿主仅在取消回合时写入）。 */
function legacyAssistant(seq, text, interrupted = false) {
  return {
    kind: 'assistant',
    seq,
    time: seq * 1000,
    turn: 1,
    step: 1,
    blocks: text === undefined ? [] : [{ kind: 'text', text }],
    ...(interrupted === true ? { interrupted: true } : {}),
  }
}

/** 真机形态的 timeline：每轮 turn/end 终态（reason 省略 = 该轮尚未收尾）。 */
function timelineOf(entries) {
  const turns = new Map()
  const turnOrder = []
  for (const entry of entries) {
    turnOrder.push(entry.turn)
    turns.set(entry.turn, {
      turn: entry.turn,
      start: { type: 'turn/start', seq: 0, time: 0, data: { turn: entry.turn } },
      end: entry.reason === undefined
        ? undefined
        : { type: 'turn/end', seq: 90 + entry.turn, time: 0, data: { turn: entry.turn, reason: entry.reason } },
      status: entry.reason === undefined ? 'open' : 'closed',
      steps: [],
      data: { get: () => undefined },
    })
  }
  return { turnOrder, turns }
}

/** 真机形态的 chat 快照：legacy 节点列表 + timeline（插件只读这两处）。 */
function legacyChatOf(nodes, turnEntries = []) {
  return {
    order: [],
    nodes: { get: () => undefined },
    legacy: { nodes, turnTimings: new Map(), turnEnds: new Map(), partial: null, runningCalls: [] },
    timeline: timelineOf(turnEntries),
  }
}

// --- component mounting ------------------------------------------------------

function mount({ services, sessionId, chat, running = false, draft = '', interruptedTail = false, inputsApi = 'legacy', extraProps = {} }) {
  const component = services.registered[0].component
  const env = {
    sessionId,
    chat,
    running,
    draft,
    inputs: [],
  }
  env.inputActions = {
    setDraft: (text) => { env.inputs.push(['setDraft', text]); env.draft = text },
  }
  // 附件回填的世代：'legacy' = addImages（0.1.2 及更早），'next' = addAttachments（0.1.5+）。
  if (inputsApi !== 'none') {
    const name = inputsApi === 'next' ? 'addAttachments' : 'addImages'
    env.inputActions[name] = (ids) => { env.inputs.push([name, ids]); return true }
  }
  env.state = { running, subagent: null, queue: [] }
  const props = () => ({
    sessionId: env.sessionId,
    useSession: (sel) => sel(env.state),
    useConversation: (sel) => sel({ views: { get: (t) => (t === 'chat' ? env.chat : undefined) } }),
    useInput: (sel) => sel({ draft: env.draft }),
    inputActions: env.inputActions,
    t: (k, vars) => k,
    ...extraProps,
  })
  const render = (first) => { if (first) freshInstance(); else beginRender(); return component(props()) }
  const materialize = (tree) => {
    if (tree && tree.__element && typeof tree.type === 'function') { try { tree.type(tree.props) } catch { /* noop */ } }
    if (tree && tree.props && tree.props.children) {
      const kids = Array.isArray(tree.props.children) ? tree.props.children : [tree.props.children]
      for (const kid of kids) materialize(kid)
    }
    return tree
  }
  env.render = () => { let tree = render(true); if (isDirty()) tree = render(false); return materialize(tree) }
  env.rerender = () => { let tree = render(false); if (isDirty()) tree = render(false); return materialize(tree) }
  env.press = (key, extra = {}) => {
    let prevented = false
    const event = { key, isComposing: false, shiftKey: false, ctrlKey: false, altKey: false, metaKey: false,
      preventDefault() { prevented = true }, stopPropagation() {}, ...extra }
    keydownHandler(event)
    env.rerender()
    return prevented
  }
  env.render()
  return env
}

// --- tests -------------------------------------------------------------------

test('bundle registers under the package id and declares only slots', () => {
  assert.ok(factories.has(PKG_ID), 'no __ModuleLoader__.load for the package id')
  const exports = freshApply()
  assert.deepEqual(exports.inject, ['slots'])
  assert.equal(typeof exports.apply, 'function')
})

test('apply registers one overlay entry and the /rewind contribution', () => {
  const services = makeServices()
  applyWith(services)
  assert.equal(services.registered.length, 2, 'overlay bridge + header dispose toggle（孤儿 tab 已休眠，不再注册）')
  assert.equal(orphanTabEntry(services), undefined, '休眠期不往本地插件 tab 槽注册')
  assert.equal(window.__dsew.orphanTabDormant, true, '诊断标记「有意不注册」')
  assert.equal(window.__dsew.orphanTabRegistered, false)
  const overlay = services.registered.find((r) => r.options.name === 'conversation.input.overlay')
  assert.ok(overlay, 'overlay bridge registered')
  assert.equal(overlay.options.id, 'esc-rewind')
  assert.equal(overlay.options.order, 60)
  const header = services.registered.find((r) => r.options.name === 'conversation.session.header.actions')
  assert.ok(header, 'header dispose toggle registered')
  assert.equal(header.options.id, 'esc-rewind-dispose')
  assert.equal(header.options.order, 28)
  assert.equal(services.contributions.length, 1)
  assert.equal(services.contributions[0].name, 'rewind')
  assert.equal(services.contributions[0].ui.kind, 'popupSelect')
})

test('pure decisions: first ESC stops a running turn', () => {
  const list = [user(1, 'q1'), settled(2, 'a1'), user(3, 'q2'), runningAssistant(4)]
  const d = internals().decideEsc({ running: true, draft: '', list, stopIssued: false })
  assert.equal(d.action, 'stop')
})

test('pure decisions: ESC again while running (stop issued) rewinds', () => {
  const list = [user(1, 'q1'), settled(2, 'a1'), user(3, 'q2'), runningAssistant(4)]
  const d = internals().decideEsc({ running: true, draft: '', list, stopIssued: true })
  assert.equal(d.action, 'rewind')
  assert.equal(d.exchange.seq, 3)
})

test('pure decisions: armed interrupted tail arms on first ESC, rewinds on second', () => {
  const list = [user(1, 'q1'), settled(2, 'a1'), user(3, 'q2'), interrupted(4, 'partial')]
  const d1 = internals().decideEsc({ running: false, draft: '', list, stopIssued: false })
  assert.equal(d1.action, 'arm')
  assert.equal(d1.exchange.seq, 3)
  const d2 = internals().decideEsc({ running: false, draft: '', list, stopIssued: true })
  assert.equal(d2.action, 'rewind')
  assert.equal(d2.exchange.seq, 3)
})

test('pure decisions: natural completion never rewinds', () => {
  const list = [user(1, 'q1'), settled(2, 'a1'), user(3, 'q2'), settled(4, 'full answer')]
  const d = internals().decideEsc({ running: false, draft: '', list, stopIssued: false })
  assert.equal(d.action, 'none')
})

test('pure decisions: an unsettled user-tail question arms first, rewinds second', () => {
  // Tail is a just-sent user question with no assistant reply yet — not settled,
  // so an empty-draft ESC is allowed to rewind (tailUnsettled), but only on the
  // second ESC. Rewind target is that last (unanswered) question itself.
  const list = [user(1, 'q1'), settled(2, 'a1'), user(3, 'q2'), user(4, 'q3 waiting')]
  const d1 = internals().decideEsc({ running: false, draft: '', list, stopIssued: false })
  assert.equal(d1.action, 'arm')
  assert.equal(d1.exchange.seq, 4)
  const d2 = internals().decideEsc({ running: false, draft: '', list, stopIssued: true })
  assert.equal(d2.action, 'rewind')
  assert.equal(d2.exchange.seq, 4)
})

test('pure decisions: an unrecognised-status assistant tail arms first, rewinds second', () => {
  const unknown = makeChatNode({ kind: 'assistant', seq: 4, text: 'x', extra: { status: 'unknown' } })
  const list = [user(1, 'q1'), settled(2, 'a1'), user(3, 'q2'), unknown]
  const d1 = internals().decideEsc({ running: false, draft: '', list, stopIssued: false })
  assert.equal(d1.action, 'arm')
  assert.equal(d1.exchange.seq, 3)
  const d2 = internals().decideEsc({ running: false, draft: '', list, stopIssued: true })
  assert.equal(d2.action, 'rewind')
  assert.equal(d2.exchange.seq, 3)
})

test('pure decisions: an edited draft disarms the armed state', () => {
  const list = [user(1, 'q1'), settled(2, 'a1'), user(3, 'q2'), interrupted(4, 'partial')]
  const d = internals().decideEsc({ running: false, draft: 'typing a new prompt', list, stopIssued: false })
  assert.equal(d.action, 'none')
})

test('pure decisions: a running first exchange can still stop', () => {
  const list = [user(1, 'only question'), runningAssistant(2)]
  const d = internals().decideEsc({ running: true, draft: '', list, stopIssued: false })
  assert.equal(d.action, 'stop')
})

test('pure decisions: images and text both survive exchange derivation', () => {
  const list = [user(1, 'with image', ['att-1'])]
  const exs = internals().buildExchanges(list)
  assert.equal(exs.length, 1)
  assert.equal(exs[0].text, 'with image')
  assert.deepEqual(exs[0].imageRefs.map((r) => r.attachmentId), ['att-1'])
  assert.equal(exs[0].isFirst, true)
})

test('exchanges anchor on the previous settled assistant only', () => {
  // interrupted + settled variants: anchor must be the settled one
  const list = [user(1, 'q0'), interrupted(2, 'aborted'), user(3, 'q1'), settled(4, 'ok'), user(5, 'q2')]
  const exs = internals().buildExchanges(list)
  assert.equal(exs[0].anchorSeq, null) // nothing settled before q0
  assert.equal(exs[0].isFirst, true)
  assert.equal(exs[1].anchorSeq, null) // only an interrupted assistant before q1 -> no clean boundary
  assert.equal(exs[1].isFirst, false)
  assert.equal(exs[2].anchorSeq, 4)    // settled assistant before q2
  assert.equal(internals().qualifyExchange(exs[0]), true)  // first exchange: allowed (fresh session)
  assert.equal(internals().qualifyExchange(exs[1]), false) // no boundary -> not offered
  assert.equal(internals().qualifyExchange(exs[2]), true)
})

test('ESC stop integration: first ESC cancels the running turn and hints', async () => {
  const services = makeServices()
  services.seed('s1', { running: true })
  applyWith(services)
  services.setRunning('s1', true)
  const env = mount({
    services,
    sessionId: 's1',
    chat: chatOf([user(1, 'q1'), settled(2, 'a1'), user(3, 'q2'), runningAssistant(4)]),
    running: true,
  })
  toasts.length = 0
  const prevented = env.press('Escape')
  assert.equal(prevented, true, 'ESC must be consumed on stop')
  assert.deepEqual(services.calls.cancels, ['s1'])
  assert.ok(toasts.length > 0, 'stop hint toast expected')
})

test('post-stop hint: switching INTO an already-unsettled session does NOT hint', () => {
  // e.g. a 429-failed turn where the tail is unsettled but NEVER went running→idle
  // in this session: the user just opened the session, so running stays false the
  // whole time. No falling edge → no tooltip. (prevRunning is null on mount.)
  const env = mount({
    services: applyWith(makeServices()),
    sessionId: 's1',
    chat: chatOf([user(1, 'q1'), settled(2, 'a1'), user(3, 'q2'), interrupted(4, 'partial')]),
    running: false,
  })
  env.render()
  toasts.length = 0
  env.rerender()
  assert.ok(toasts.length === 0, 'must not hint when merely switching into an unsettled session')
})

test('post-stop hint: toolbar-Stop (running→idle falling edge) does hint once', () => {
  const services = makeServices()
  services.seed('s1', { running: true })
  applyWith(services)
  const env = mount({
    services,
    sessionId: 's1',
    chat: chatOf([user(1, 'q1'), settled(2, 'a1'), user(3, 'q2'), runningAssistant(4)]),
    running: true,
  })
  env.render()
  // Simulate the host settling after the toolbar Stop: running true→false with an
  // unsettled (interrupted) tail.
  services.setRunning('s1', false)
  env.state.running = false
  env.chat = chatOf([user(1, 'q1'), settled(2, 'a1'), user(3, 'q2'), interrupted(4, 'partial')])
  toasts.length = 0
  env.rerender()
  assert.ok(toasts.length > 0, 'post-stop hint appears after a real running→idle stop')
})

// --- hint evidence (真机形态 + 投影落后一帧) ----------------------------------
// 缺陷回归：自然结束时 running 位先掉、对话投影还没落定，旧判据（尾部非 settled）
// 会误弹提示。下面 4 条按真机数据形态与到达顺序建模。

test('hint evidence: natural completion must NOT hint even while the projection lags', () => {
  const services = makeServices()
  services.seed('s1', { running: true })
  applyWith(services)
  // 生成中：运行中的 assistant 行在 legacy 列表里不产出节点 → 尾巴是本轮的 user 提问
  const streaming = [legacyUser(1, 'q1'), legacyAssistant(2, 'a1'), legacyUser(3, 'q2')]
  const env = mount({
    services,
    sessionId: 's1',
    chat: legacyChatOf(streaming, [{ turn: 1, reason: { kind: 'completed' } }, { turn: 2 }]),
    running: true,
  })
  env.render()
  toasts.length = 0
  const hintedBefore = window.__dsew.hintToasts

  // 自然结束：running 位先到，投影尚未落定
  env.state.running = false
  env.rerender()
  assert.equal(toasts.length, 0, 'running 下降沿那一刻不得提示（本轮尚未定型）')

  // 随后 settled 的 assistant 行落定，该轮 turn/end 也是 completed
  env.chat = legacyChatOf(
    [...streaming, legacyAssistant(4, 'a2')],
    [{ turn: 1, reason: { kind: 'completed' } }, { turn: 2, reason: { kind: 'completed' } }],
  )
  env.rerender()
  assert.equal(toasts.length, 0, '自然结束的回合定型后也不得提示')
  assert.equal(window.__dsew.hintToasts, hintedBefore, 'hintToasts 不得递增')
})

test('hint evidence: toolbar Stop resolves once the interrupted row lands', () => {
  const services = makeServices()
  services.seed('s1', { running: true })
  applyWith(services)
  const streaming = [legacyUser(1, 'q1'), legacyAssistant(2, 'a1'), legacyUser(3, 'q2')]
  const env = mount({
    services,
    sessionId: 's1',
    chat: legacyChatOf(streaming, [{ turn: 1, reason: { kind: 'completed' } }, { turn: 2 }]),
    running: true,
  })
  env.render()
  toasts.length = 0
  const hintedBefore = window.__dsew.hintToasts

  env.state.running = false
  env.rerender()
  assert.equal(toasts.length, 0, '下降沿只记候选，不得抢在定型前提示')

  env.chat = legacyChatOf(
    [...streaming, legacyAssistant(4, 'half answer', true)],
    [{ turn: 1, reason: { kind: 'completed' } }, { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } }],
  )
  env.rerender()
  assert.ok(toasts.includes('esc.hint'), '中断行落定后提示一次')
  assert.equal(window.__dsew.hintToasts - hintedBefore, 1, '恰好一次提示（发布计数）')
  assert.equal(window.__dsew.lastHint, 'tail-interrupted', '判据应为尾部 interrupted 证据')

  // toasts 数组记录的是 Toast 的每次渲染，故重复提示要用发布计数判定
  env.rerender()
  env.rerender()
  assert.equal(window.__dsew.hintToasts - hintedBefore, 1, '每回合至多一次提示')
})

test('hint evidence: a stop with no content resolves through turn/end aborted/user', () => {
  const services = makeServices()
  services.seed('s1', { running: true })
  applyWith(services)
  // 尚无内容即被停：对话里没有 assistant 行，尾巴一直是 user 提问
  const nodes = [legacyUser(1, 'q1'), legacyAssistant(2, 'a1'), legacyUser(3, 'q2')]
  const env = mount({
    services,
    sessionId: 's1',
    chat: legacyChatOf(nodes, [{ turn: 1, reason: { kind: 'completed' } }, { turn: 2 }]),
    running: true,
  })
  env.render()
  toasts.length = 0

  env.state.running = false
  env.rerender()
  assert.equal(toasts.length, 0, 'turn/end 未落定前不得提示')

  env.chat = legacyChatOf(
    [...nodes],
    [{ turn: 1, reason: { kind: 'completed' } }, { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } }],
  )
  env.rerender()
  assert.deepEqual(toasts, ['esc.hint'], '无内容停止也要提示一次')
  assert.equal(window.__dsew.lastHint, 'turn-aborted', '判据应为 turn/end aborted/user')
})

test('hint evidence: non-user aborts and failed turns never count as a user stop', () => {
  const services = makeServices()
  services.seed('s1', { running: true })
  applyWith(services)
  const nodes = [legacyUser(1, 'q1'), legacyAssistant(2, 'a1'), legacyUser(3, 'q2')]
  const env = mount({
    services,
    sessionId: 's1',
    chat: legacyChatOf(nodes, [{ turn: 1, reason: { kind: 'completed' } }, { turn: 2 }]),
    running: true,
  })
  env.render()
  toasts.length = 0
  env.state.running = false
  env.rerender()

  // hook/parent/disposed 的取消不是用户停止；error（如 429）同样不是
  env.chat = legacyChatOf(
    [...nodes],
    [{ turn: 1, reason: { kind: 'completed' } }, { turn: 2, reason: { kind: 'aborted', reason: { kind: 'hook' } } }],
  )
  env.rerender()
  assert.equal(toasts.length, 0, '非 user 原因的 abort 不得提示')

  env.chat = legacyChatOf(
    [...nodes],
    [{ turn: 1, reason: { kind: 'completed' } }, { turn: 2, reason: { kind: 'error', error: { code: 'RATE_LIMIT' } } }],
  )
  env.rerender()
  assert.equal(toasts.length, 0, '失败的回合不得提示')
})

test('hint evidence: switching into a stopped session does NOT hint (no falling edge)', () => {
  const services = makeServices()
  services.seed('s1', { running: false })
  applyWith(services)
  const env = mount({
    services,
    sessionId: 's1',
    chat: legacyChatOf(
      [legacyUser(1, 'q1'), legacyAssistant(2, 'a1'), legacyUser(3, 'q2'), legacyAssistant(4, 'half', true)],
      [{ turn: 1, reason: { kind: 'completed' } }, { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } }],
    ),
    running: false,
  })
  env.render()
  toasts.length = 0
  env.rerender()
  assert.equal(toasts.length, 0, '切进历史上被中断的会话不得提示')
})

test('hint evidence: a non-empty draft consumes the candidate without hinting', () => {
  const services = makeServices()
  services.seed('s1', { running: true })
  applyWith(services)
  const streaming = [legacyUser(1, 'q1'), legacyAssistant(2, 'a1'), legacyUser(3, 'q2')]
  const env = mount({
    services,
    sessionId: 's1',
    chat: legacyChatOf(streaming, [{ turn: 1, reason: { kind: 'completed' } }, { turn: 2 }]),
    running: true,
  })
  env.render()
  toasts.length = 0
  env.state.running = false
  env.rerender()

  // 用户已开始写新草稿：该轮定型为中断也不提示（不打扰编辑）
  env.draft = 'typing a new prompt'
  env.chat = legacyChatOf([...streaming, legacyAssistant(4, 'half', true)], [{ turn: 1, reason: { kind: 'completed' } }, { turn: 2 }])
  env.rerender()
  assert.equal(toasts.length, 0, '草稿非空不得提示')

  // 候选已结算为一次性判定：事后清空草稿也不补提示
  env.draft = ''
  env.rerender()
  assert.equal(toasts.length, 0, '候选不得因草稿清空而复活')
})

test('hint evidence: the bare falling edge never hints in either chat shape', () => {
  // 回归核心：只下 running 下降沿、没有任何停止证据（尾部仍是本轮 user 提问），
  // 两种 chat 形态（view-node / 真机 legacy）都不得弹提示。
  for (const shape of ['view-node', 'legacy']) {
    const services = makeServices()
    services.seed('s1', { running: true })
    applyWith(services)
    const nodes = shape === 'view-node'
      ? chatOf([user(1, 'q1'), settled(2, 'a1'), user(3, 'q2')])
      : legacyChatOf([legacyUser(1, 'q1'), legacyAssistant(2, 'a1'), legacyUser(3, 'q2')], [{ turn: 1, reason: { kind: 'completed' } }, { turn: 2 }])
    const env = mount({ services, sessionId: 's1', chat: nodes, running: true })
    env.render()
    toasts.length = 0
    const hintedBefore = window.__dsew.hintToasts
    env.state.running = false
    env.rerender()
    env.rerender()
    assert.equal(toasts.length, 0, `${shape}: 下降沿本身不得触发提示`)
    assert.equal(window.__dsew.hintToasts, hintedBefore, `${shape}: hintToasts 不得递增`)
  }
})

test('hint evidence: delete mode keeps the irreversible warning wording', async () => {
  const services = makeServices()
  services.seed('s1', { running: true })
  applyWith(services)
  services.setSettingsValue(true)
  await internals()._module.loadDeleteMode()
  const streaming = [legacyUser(1, 'q1'), legacyAssistant(2, 'a1'), legacyUser(3, 'q2')]
  const env = mount({
    services,
    sessionId: 's1',
    chat: legacyChatOf(streaming, [{ turn: 1, reason: { kind: 'completed' } }, { turn: 2 }]),
    running: true,
  })
  env.render()
  toasts.length = 0
  env.state.running = false
  env.rerender()
  env.chat = legacyChatOf([...streaming, legacyAssistant(4, 'half', true)], [{ turn: 1, reason: { kind: 'completed' } }, { turn: 2 }])
  env.rerender()
  assert.ok(toasts.includes('esc.hint.delete'), '删除模式用警示文案')
  assert.ok(!toasts.includes('esc.hint'), '不得用普通文案')
})

test('hint evidence: definitive stop evidence wins over a stale settled row', () => {
  // 多步回合：第 1 步已有 settled 回复（成为列表尾部），第 2 步无内容即被停。
  // 此时只有该轮 turn/end 的 aborted/user 能证明用户停过 → 必须提示。
  const nodes = [
    legacyUser(1, 'q1'), legacyAssistant(2, 'a1'),
    legacyUser(3, 'q2'), legacyAssistant(4, 'step-1 text'),
  ]
  const services = makeServices()
  services.seed('s1', { running: true })
  applyWith(services)
  const env = mount({
    services,
    sessionId: 's1',
    chat: legacyChatOf(nodes, [{ turn: 1, reason: { kind: 'completed' } }, { turn: 2 }]),
    running: true,
  })
  env.render()
  toasts.length = 0
  const hintedBefore = window.__dsew.hintToasts
  env.state.running = false
  env.rerender()
  env.chat = legacyChatOf(
    nodes,
    [{ turn: 1, reason: { kind: 'completed' } }, { turn: 2, reason: { kind: 'aborted', reason: { kind: 'user' } } }],
  )
  env.rerender()
  assert.ok(toasts.includes('esc.hint'), 'settled 尾 + aborted/user 仍应提示')
  assert.equal(window.__dsew.hintToasts - hintedBefore, 1)
  assert.equal(window.__dsew.lastHint, 'turn-aborted')
})

test('pure: tailStatus / lastTurnEndEvidence contracts (真机形态与形状容错)', () => {
  const api = internals()
  assert.equal(api.tailStatus([]), null, '空列表 → null')
  assert.equal(api.tailStatus([legacyUser(1, 'q')]), null, '尾部非 assistant → null')
  assert.equal(api.tailStatus([legacyAssistant(2, 'a')]), 'settled', '耐久 settled 行（无 status 字段）')
  assert.equal(api.tailStatus([legacyAssistant(3, 'x', true)]), 'interrupted', 'interrupted 标记')
  assert.equal(api.tailStatus([runningAssistant(4)]), 'running', 'view-node 形态的 running 行')
  assert.equal(api.tailInterrupted([legacyAssistant(3, 'x', true)]), true)

  assert.equal(api.lastTurnEndEvidence(undefined), null, '无 chat → null')
  assert.equal(api.lastTurnEndEvidence({ timeline: { turnOrder: [], turns: new Map() } }), null, '空 timeline → null')
  assert.equal(api.lastTurnEndEvidence({ timeline: { turnOrder: [1], turns: null } }), null, '形状不符 → null')
  assert.equal(
    api.lastTurnEndEvidence(legacyChatOf([], [{ turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } }])),
    'aborted:user',
  )
  assert.equal(
    api.lastTurnEndEvidence(legacyChatOf([], [{ turn: 1, reason: { kind: 'aborted', reason: { kind: 'hook' } } }])),
    'aborted:hook',
  )
  assert.equal(api.lastTurnEndEvidence(legacyChatOf([], [{ turn: 1, reason: { kind: 'completed' } }])), 'completed')
  assert.equal(api.lastTurnEndEvidence(legacyChatOf([], [{ turn: 1 }])), null, '该轮尚未收尾 → null')
})

test('ESC twice rewinds: fork at the previous settled boundary, archive, open, stage restore', async () => {
  const services = makeServices()
  services.seed('s1', { running: true, title: 'Original Title' })
  applyWith(services)
  services.setRunning('s1', true)
  const env = mount({
    services,
    sessionId: 's1',
    chat: chatOf([user(1, 'q1'), settled(2, 'a1'), user(3, 'q2'), runningAssistant(4)]),
    running: true,
  })
  toasts.length = 0
  env.press('Escape') // stop (cancels)
  assert.equal(services.calls.cancels.length, 1)
  // model the host settling: now interrupted tail, not running
  services.setRunning('s1', false)
  env.chat = chatOf([user(1, 'q1'), settled(2, 'a1'), user(3, 'q2'), interrupted(4, 'partial')])
  env.running = false
  env.rerender()
  toasts.length = 0
  // second ESC while still "running" (before settle) is the double-tap case:
  services.setRunning('s1', true)
  env.running = true
  env.rerender()
  env.press('Escape') // rewind
  // ensureIdle cancels again then settles
  services.setRunning('s1', false)
  await new Promise((r) => setTimeout(r, 30)) // let the async rewind finish
  assert.equal(services.calls.forks.length, 1)
  assert.equal(services.calls.forks[0].sessionId, 's1')
  assert.equal(services.calls.forks[0].atSeq, 2, 'anchor = previous settled assistant')
  assert.equal(services.calls.forks[0].increaseTitle, false)
  assert.ok(services.calls.archived.includes('s1'), 'original session archived')
  assert.equal(services.calls.opens[0], services.calls.forks[0] && services.calls.opens[0], 'child opened')
  const childId = services.calls.opens[0]
  assert.ok(childId, 'a child session was opened')
})

test('/rewind reads the whole history up front and lists every exchange newest first', async () => {
  // The loaded window starts with only the recent tail (2 exchanges); the full
  // history has 4 exchanges and only appears after the picker's loadThrough.
  const fullChat = chatOf([
    user(1, 'oldest question'), settled(2, 'old reply'),
    user(3, 'middle question'), settled(4, 'middle reply'),
    user(5, 'recent question'), settled(6, 'recent reply'),
    user(7, 'newest question'), runningAssistant(8),
  ])
  const tailChat = chatOf([user(5, 'recent question'), settled(6, 'recent reply'), user(7, 'newest question'), runningAssistant(8)])
  const model = { full: false }
  const services = makeServices({
    chatOf: () => (model.full ? fullChat : tailChat),
    // Simulate the host delivering every older page once loadThrough lands.
    onLoadThrough: () => { model.full = true },
  })
  services.seed('s1', { title: 'T' })
  services.setHasMore('s1', true)
  applyWith(services)
  const contribution = services.contributions[0]
  assert.equal(contribution.available({ sessionId: 's1' }), true, 'normal session always offers /rewind')
  const options = await contribution.ui.options({ sessionId: 's1' }, new AbortController().signal)
  // With no older history loaded the loader runs loadThrough(0) to page it in.
  assert.deepEqual(services.calls.loadThrough, [['s1', 0]], 'loadThrough(0) pages the entire history')
  assert.equal(options.length, 4, 'every exchange across the whole history is offered')
  assert.equal(options[0].value, '7', 'newest first')
  assert.equal(options[1].value, '5')
  assert.equal(options[2].value, '3')
  assert.equal(options[3].value, '1', 'the very first exchange is reachable even though it was never rendered')

  // Second open in the same page: the live window is already fully loaded, so
  // NO further host call happens — this is the load-once guarantee.
  const optionsAgain = await contribution.ui.options({ sessionId: 's1' }, new AbortController().signal)
  assert.equal(services.calls.loadThrough.length, 1, 'second open does not re-load the history')
  assert.equal(optionsAgain.length, 4, 'same full list served from the loaded window')
})

test('cached record serves after a reload; new messages trigger one merge reload', async () => {
  const tailChat = chatOf([user(5, 'recent question'), settled(6, 'recent reply'), user(7, 'newest question'), runningAssistant(8)])
  const fullChat = chatOf([
    user(1, 'oldest question'), settled(2, 'old reply'),
    user(3, 'middle question'), settled(4, 'middle reply'),
    user(5, 'recent question'), settled(6, 'recent reply'),
    user(7, 'newest question'), runningAssistant(8),
  ])
  const fullChatPlusNew = chatOf([
    user(1, 'oldest question'), settled(2, 'old reply'),
    user(3, 'middle question'), settled(4, 'middle reply'),
    user(5, 'recent question'), settled(6, 'recent reply'),
    user(7, 'newest question'), settled(8, 'newest reply'), user(9, 'brand new question'), runningAssistant(10),
  ])
  const model = { chat: tailChat, fullTarget: fullChat }
  const services = makeServices({
    chatOf: () => model.chat,
    // loadThrough delivers the whole log (up to the current tail) into the
    // window, like the host does.
    onLoadThrough: () => { model.chat = model.fullTarget },
  })
  services.seed('cache-s1', { title: 'T' })
  services.setHasMore('cache-s1', true)
  applyWith(services)
  const contribution = services.contributions[0]

  // First open: full load once, persisted to localStorage.
  const first = await contribution.ui.options({ sessionId: 'cache-s1' }, new AbortController().signal)
  assert.equal(first.length, 4)
  assert.equal(services.calls.loadThrough.length, 1)

  // Simulate a page reload: page-local state is gone, localStorage record lives.
  internals()._module.resetHistoryCache()
  model.chat = tailChat
  services.setHasMore('cache-s1', true)

  // Second open with NO new content: served from the cached record, no host call.
  const afterReload = await contribution.ui.options({ sessionId: 'cache-s1' }, new AbortController().signal)
  assert.equal(afterReload.length, 4, 'full list restored from the cached record')
  assert.equal(services.calls.loadThrough.length, 1, 'no host call when the record is still fresh')

  // Now the session grew (one new exchange): the cache watermark is older than
  // the newest live exchange → one merge reload fetches the new content too.
  model.fullTarget = fullChatPlusNew
  model.chat = fullChatPlusNew
  services.setHasMore('cache-s1', true)
  const afterGrowth = await contribution.ui.options({ sessionId: 'cache-s1' }, new AbortController().signal)
  assert.equal(services.calls.loadThrough.length, 2, 'one reload happens when the session grew')
  assert.equal(afterGrowth.length, 5, 'merged list includes the newest exchange')
  assert.equal(afterGrowth[0].value, '9', 'brand-new exchange is at the top, not lost to the cache')
})

test('/rewind availability: subagent and blank sessions are excluded', () => {
  const services = makeServices()
  services.seed('s1', { title: 'T' })
  services.summaries.s1.origin = 'subagent'
  services.seed('s2', { title: 'T2' })
  services.summaries.s2.blank = true
  services.seed('s3', { title: 'T3' })
  applyWith(services)
  const contribution = services.contributions[0]
  assert.equal(contribution.available({ sessionId: 's1' }), false, 'subagent transcript: no rewind')
  assert.equal(contribution.available({ sessionId: 's2' }), false, 'blank session: no rewind')
  assert.equal(contribution.available({ sessionId: 's3' }), true)
})

test('/rewind option rows carry text, image fallback, round and time', async () => {
  const fullChat = chatOf([user(1, '', ['att-1']), settled(2, 'a1'), user(3, 'plain question'), runningAssistant(4)])
  const services = makeServices({ chatOf: () => fullChat })
  services.seed('s1', { title: 'T' })
  applyWith(services)
  const contribution = services.contributions[0]
  const options = await contribution.ui.options({ sessionId: 's1' }, new AbortController().signal)
  assert.equal(options.length, 2)
  assert.equal(options[0].value, '3', 'newest first')
  assert.equal(options[1].value, '1')
  assert.match(options[1].label, /图片消息/, 'image-only exchange gets a text placeholder')
  assert.match(options[0].detail, /第 1 轮/, 'round number shown')
})

test('/rewind engine: first exchange degrades to a fresh same-workspace session', async () => {
  const chat = chatOf([user(1, 'only question'), runningAssistant(2)])
  const services = makeServices({ chatOf: () => chat })
  services.seed('s1', { title: 'T' })
  applyWith(services)
  const first = internals()._module.exchangesOfSession('s1').find((ex) => ex.isFirst === true)
  assert.ok(first, 'first exchange present')
  const result = await internals()._module.doRewind('s1', first)
  assert.equal(result.ok, true)
  assert.equal(services.calls.forks.length, 0, 'no fork for a first exchange')
  assert.equal(services.calls.creates.length, 1)
  assert.equal(services.calls.creates[0].workspaceId, 'w1')
  assert.ok(services.calls.archived.includes('s1'))
})

test('pending restore applies the prompt on the branch mount', async () => {
  const services = makeServices()
  services.seed('s1', { title: 'T' })
  applyWith(services)
  const chat = chatOf([user(1, 'please rewrite'), settled(2, 'old reply'), user(3, 'rewind me'), runningAssistant(4)])
  const env = mount({ services, sessionId: 's1', chat, running: true })
  toasts.length = 0
  env.press('Escape') // stop
  services.setRunning('s1', true)
  env.rerender()
  env.press('Escape') // rewind (double-tap path)
  services.setRunning('s1', false)
  await new Promise((r) => setTimeout(r, 30))
  // Now the child mounts: simulate the branch bridge with an empty draft.
  const childId = services.calls.opens[0]
  assert.ok(childId)
  const childEnv = mount({ services, sessionId: childId, chat: chatOf([]), draft: '' })
  await new Promise((r) => setTimeout(r, 150)) // allow the 80ms restore timer
  childEnv.rerender() // materialize the Toast the timer published
  const setDraftCalls = childEnv.inputs.filter(([op]) => op === 'setDraft')
  assert.equal(setDraftCalls.length, 1, 'prompt restored exactly once on the branch')
  assert.equal(setDraftCalls[0][1], 'rewind me')
  assert.ok(toasts.some((t) => t === 'rewind.done'), 'done toast expected')
})

// --- 草稿附件 API 桥接（0.1.2-rc.1 ⇄ 0.1.5-rc.2） -----------------------------
//
// 0.1.5-rc.2 把「图片草稿」泛化为「附件草稿」并改名：
//   conversation.createDraftImages(files) → createDrafts(sessionId, files)
//   conversation.releaseDraftImage(id)    → releaseDraftAttachment(id)
//   inputActions.addImages(ids)           → addAttachments(ids)
// 插件不读宿主版本号，只按能力探测选名字：两代都必须走通，两代都缺时必须降级
// （不抛错、不误报），并把探测结果留在 __dsew 诊断里。

/** 可回退的最后一轮：带图提问 + 运行中的 assistant。 */
function imageRewindChat() {
  return chatOf([user(1, 'q1'), settled(2, 'a1'), user(3, '带图提问', ['att-9']), runningAssistant(4)])
}

/** readAttachment 成功响应（真机形态：attachment 元数据 + 字节）。 */
function imageBytes() {
  return { ok: true, value: { attachment: { mediaType: 'image/png', name: 'shot.png' }, data: new Uint8Array([1, 2, 3]) } }
}

for (const [generation, createName, restoreName] of [
  ['next', 'createDrafts', 'addAttachments'],
  ['legacy', 'createDraftImages', 'addImages'],
]) {
  test(`draft bridge (${generation}): 图片回退经 ${createName} 建草稿并经 ${restoreName} 回填`, async () => {
    const chat = imageRewindChat()
    const services = makeServices({ chatOf: () => chat, draftApi: generation, readAttachment: imageBytes })
    services.seed('s1', { title: 'T' })
    applyWith(services)
    const target = internals()._module.exchangesOfSession('s1').find((ex) => ex.seq === 3)
    assert.ok(target, '带图的那一轮可回退')
    const result = await internals()._module.doRewind('s1', target)
    assert.equal(result.ok, true)
    // 新签名带 sessionId，旧签名不带——这一处差异必须真的被区分。
    assert.equal(services.calls.draftCreates.length, 1, '恰好建一次草稿')
    assert.equal(services.calls.draftCreates[0][0], createName)
    assert.equal(services.calls.draftCreates[0][2], 1, '一个附件')
    // 读走的是耐久引用，字节从 readAttachment 来。
    assert.deepEqual(services.calls.readAttachments, ['att-9'])
    // 分支挂载后回填草稿附件。
    const childEnv = mount({ services, sessionId: result.childId, chat: chatOf([]), draft: '', inputsApi: generation })
    await new Promise((r) => setTimeout(r, 150))
    const added = childEnv.inputs.filter(([op]) => op === restoreName)
    assert.equal(added.length, 1, `${restoreName} 恰好调用一次`)
    assert.equal(added[0][1].length, 1, '回填一个草稿 id')
    assert.equal(window.__dsew.draftCreateApi, createName)
    assert.equal(window.__dsew.draftRestoreApi, restoreName)
  })

  test(`draft bridge (${generation}): 回退中途失败会释放已建草稿（${restoreName ? '同名世代' : ''}）`, async () => {
    const chat = imageRewindChat()
    const services = makeServices({ chatOf: () => chat, draftApi: generation, readAttachment: imageBytes, failFork: true })
    services.seed('s1', { title: 'T' })
    applyWith(services)
    const target = internals()._module.exchangesOfSession('s1').find((ex) => ex.seq === 3)
    await assert.rejects(() => internals()._module.doRewind('s1', target), /fork exploded/)
    const releaseName = generation === 'next' ? 'releaseDraftAttachment' : 'releaseDraftImage'
    assert.equal(services.calls.draftReleases.length, 1, '未采用的草稿必须释放')
    assert.equal(services.calls.draftReleases[0][0], releaseName)
  })
}

test('draft bridge: 两代草稿 API 都缺时静默降级，回退本身仍然成功', async () => {
  const chat = imageRewindChat()
  const services = makeServices({ chatOf: () => chat, draftApi: 'none', readAttachment: imageBytes })
  services.seed('s1', { title: 'T' })
  applyWith(services)
  const target = internals()._module.exchangesOfSession('s1').find((ex) => ex.seq === 3)
  const result = await internals()._module.doRewind('s1', target)
  assert.equal(result.ok, true, '缺草稿能力不影响回退')
  assert.equal(services.calls.draftCreates.length, 0)
  assert.deepEqual(services.calls.readAttachments, [], '不会白读附件字节')
  assert.equal(window.__dsew.draftCreateApi, null, '诊断留存「两代都没有」')
  assert.ok(services.calls.archived.includes('s1'), '归档路径不受影响')
})

// --- 0.1.5 契约：命令描述（字符串 ⇄ 函数）与「未落定输入」 -----------------------
//
// 两处 0.1.5-rc.2 的真实破坏，都由真机日志/源码核出：
// 1) `CommandContribution.description` 由字符串变成 `() => string`（核心会调用它）；
//    旧核心把它当 React 子节点渲染，函数会抛 "Functions are not valid as a React child"
//    ⇒ 两个契约无法用同一个值满足，只能按能力探测选形态（不读版本号）。
// 2) fork 用事件种子重建子会话，父会话里「刚发出、还没落盘」的排队输入会被一起复制
//    过去（真机日志：session/end-seed 之前就有 agent/inbox/spliced 的那条插入）
//    ⇒ 必须在 fork 前清掉并**确认**为空，清不掉就放弃回退。

/** 可回退的最后一轮（普通形态，不带图片）。 */
function plainRewindChat() {
  return chatOf([user(1, 'q1'), settled(2, 'a1'), user(3, 'q2'), runningAssistant(4)])
}

test('command contract: 旧核心（无 main.conversation 槽）注册字符串 description', () => {
  const services = makeServices({ slotsAvailable: ['conversation.input.overlay', 'conversation.session.header.actions'] })
  applyWith(services)
  const contribution = services.contributions[0]
  assert.ok(contribution, '贡献已注册')
  assert.equal(typeof contribution.description, 'string', '旧核心按值渲染')
  assert.equal(window.__dsew.commandDescShape, 'string')
})

test('command contract: 新核心（有 main.conversation 槽）注册函数 description 且调用得文案', () => {
  const services = makeServices()
  applyWith(services)
  const contribution = services.contributions[0]
  assert.equal(typeof contribution.description, 'function', '新核心会调用它')
  assert.equal(typeof contribution.description(), 'string')
  assert.ok(contribution.description().length > 0, '调用后得到非空文案')
  assert.equal(window.__dsew.commandDescShape, 'function')
})

test('command contract: 槽位新标准 props（usePanelInfo）作为第二信号也能判定新核心', () => {
  const services = makeServices({ slotsAvailable: ['conversation.input.overlay', 'conversation.session.header.actions'] })
  applyWith(services)
  assert.equal(window.__dsew.commandDescShape, 'string', '探针未命中前保持旧契约')
  const env = mount({ services, sessionId: 's1', chat: chatOf([user(1, 'q')]), extraProps: { usePanelInfo: () => {} } })
  env.render()
  assert.equal(window.__dsew.commandDescShape, 'function', 'props 信号生效')
  assert.equal(typeof services.contributions[0].description, 'function')
})

test('pending 输入：回退前清掉排队项并确认清空，仍照常 fork', async () => {
  const services = makeServices({ chatOf: plainRewindChat })
  services.seed('s1', { title: 'T', queue: [{ id: 'q-pending', placement: 'queued' }] })
  applyWith(services)
  const target = internals()._module.exchangesOfSession('s1').find((ex) => ex.seq === 3)
  const result = await internals()._module.doRewind('s1', target)
  assert.equal(result.ok, true)
  assert.ok(
    services.calls.queueRemoves.some(([id, action]) => id === 'q-pending' && action.kind === 'remove'),
    '排队项被删除',
  )
  assert.equal(services.calls.forks.length, 1, '清空后照常 fork')
  assert.ok(window.__dsew.pendingCleared >= 1)
  assert.equal(window.__dsew.pendingBlocked, false)
})

test('pending 输入：清不掉就放弃本次回退（不 fork、不复制进新分支）并明确提示', async () => {
  const services = makeServices({ chatOf: plainRewindChat, stubbornQueue: true })
  services.seed('s1', { title: 'T', queue: [{ id: 'q-stuck', placement: 'queued' }] })
  applyWith(services)
  toasts.length = 0
  // 挂上桥组件，才能把 doRewind 发布的 toast 渲染出来（toast 走 bridge 的局部状态）。
  const env = mount({ services, sessionId: 's1', chat: plainRewindChat() })
  const target = internals()._module.exchangesOfSession('s1').find((ex) => ex.seq === 3)
  const result = await internals()._module.doRewind('s1', target)
  env.rerender()
  assert.equal(result.ok, false)
  assert.equal(result.code, 'pending-input')
  assert.equal(services.calls.forks.length, 0, '绝不 fork 出带 pending 输入的分支')
  assert.equal(services.calls.opens.length, 0)
  assert.equal(services.calls.archived.length, 0, '原会话也不动')
  assert.equal(window.__dsew.pendingBlocked, true)
  assert.equal(window.__dsew.lastGate, 'pending-input')
  assert.ok(
    toasts.some((text) => text.includes('还有没发出的消息在排队')),
    `给出可理解的提示（实际：${JSON.stringify(toasts)}）`,
  )
})

// --- 0.2.0 契约：会话切换动词迁移到 uiWorkspace.openSession ---------------------
//
// 真机报错：/rewind 选择器里红字 "sessions.open is not a function"。0.2.0 的 sessions
// 面只剩 binding/fork/create/scope/search/retain/using，切换会话的动词搬到
// uiWorkspace.openSession(target)。夹具复刻真机（sessions 上**没有** open），
// 所以这组用例只有插件真的改走 uiWorkspace 才会绿。

test('0.2.0 契约：夹具的 sessions 面不再有 open，切换动词在 uiWorkspace 上', () => {
  const services = makeServices()
  assert.equal(typeof services.sessions.open, 'undefined', 'sessions 面没有 open（与真机一致）')
  assert.equal(typeof services.uiWorkspace.openSession, 'function', '切换动词在 uiWorkspace 上')
})

test('0.2.0 契约：回退经 uiWorkspace.openSession 切到分支，并照常归档原会话', async () => {
  const services = makeServices({ chatOf: plainRewindChat })
  services.seed('s1', { title: 'T' })
  applyWith(services)
  const target = internals()._module.exchangesOfSession('s1').find((ex) => ex.seq === 3)
  const result = await internals()._module.doRewind('s1', target)
  assert.equal(result.ok, true)
  assert.deepEqual(services.calls.opens, [result.childId], 'openSession 收到分支 id')
  assert.ok(services.calls.archived.includes('s1'), '归档路径不受影响')
})

test('宿主没有会话切换通道时：放弃回退、原会话不动、给出可读提示', async () => {
  const services = makeServices({ chatOf: plainRewindChat, noUiWorkspace: true })
  services.seed('s1', { title: 'T' })
  applyWith(services)
  toasts.length = 0
  const env = mount({ services, sessionId: 's1', chat: plainRewindChat() })
  const target = internals()._module.exchangesOfSession('s1').find((ex) => ex.seq === 3)
  const result = await internals()._module.doRewind('s1', target)
  env.rerender()
  assert.equal(result.ok, false)
  assert.equal(result.code, 'open-unavailable')
  assert.equal(services.calls.opens.length, 0)
  assert.equal(services.calls.archived.length, 0, '切不过去就不动原会话')
  assert.ok(window.__dsew.openFail, '诊断留下失败原因')
  assert.ok(
    toasts.some((text) => text.includes('切换会话失败')),
    `给出可理解的提示（实际：${JSON.stringify(toasts)}）`,
  )
})

test('pending 输入：子会话若继承了残留，打开后立刻清掉', async () => {
  const services = makeServices({
    chatOf: plainRewindChat,
    // 模拟「父会话已清空，但切点之前仍挤进了一条」：孩子建好后塞一条继承来的排队项。
    onForked: (childId, binding) => { binding.session.live.queue = [{ id: 'q-inherited', placement: 'queued' }] },
  })
  services.seed('s1', { title: 'T' })
  applyWith(services)
  const target = internals()._module.exchangesOfSession('s1').find((ex) => ex.seq === 3)
  const result = await internals()._module.doRewind('s1', target)
  assert.equal(result.ok, true)
  assert.ok(
    services.calls.queueRemoves.some(([id, action]) => id === 'q-inherited' && action.kind === 'remove'),
    '继承来的残留被清掉，不会替用户执行',
  )
  assert.ok(window.__dsew.childPendingCleared >= 1)
})

// --- 未落定输入：真机形态（0.1.5 收件箱是耐久投影 + fork 种子会带出插入事件） --------------
//
// 真机日志（会话日志即耐久真相）证明了两件事，旧守卫都看不到：
//   1) `sessions.fork` 的种子 = 父会话 [0, cut)，cut 从边界 turn/end 一路走到下一个
//      turn/start；被回退那条消息的 `agent/inbox/spliced`(insert) 正好排在它的 turn/start
//      之前、claim 之后 → 子会话收件箱投影里有一条继承来的 pending 旧消息，用户再发消息时
//      agent 先执行它，新消息排队（session-8c693ecf / 1aacc7bb / 716995b9 都能对上）。
//   2) 宿主的 queue 帧只在「有活跃 agent 且 session 匹配」时广播，inbox 投影帧才无条件广播；
//      刚按下回车的输入还可能只存在于本地回声 pendingSubmissions（「等待队列」UI 就是它）。

/** 宿主 inbox 投影值：`{'next-turn','next-step'}`，条目即待执行输入。 */
function inboxOf(entries) {
  return {
    'next-turn': entries.map(([id, text]) => ({ id, content: [{ type: 'text', text }] })),
    'next-step': [],
  }
}

test('pending 输入：queue 镜像为空但 inbox 投影有排队项时，回退前也要清掉', async () => {
  const services = makeServices({ chatOf: plainRewindChat })
  services.seed('s1', { title: 'T', inbox: inboxOf([['m-proj', '还没落盘的提问']]) })
  applyWith(services)
  const target = internals()._module.exchangesOfSession('s1').find((ex) => ex.seq === 3)
  const result = await internals()._module.doRewind('s1', target)
  assert.equal(result.ok, true)
  assert.ok(
    services.calls.queueRemoves.some(([id, action]) => id === 'm-proj' && action.kind === 'remove'),
    '宿主投影里的排队项必须被删掉（queue 镜像没广播到也不能漏）',
  )
  assert.equal(services.calls.forks.length, 1)
  assert.match(String(window.__dsew.pendingSource || ''), /inbox-projection/)
})

test('pending 输入：未对账的本地回声也算未落定，不许 fork', async () => {
  const services = makeServices({ chatOf: plainRewindChat })
  services.seed('s1', {
    title: 'T',
    pendingSubmissions: [{ requestId: 'r-echo', placement: 'queued', text: '刚按下回车' }],
  })
  applyWith(services)
  const target = internals()._module.exchangesOfSession('s1').find((ex) => ex.seq === 3)
  const result = await internals()._module.doRewind('s1', target)
  assert.equal(result.ok, false, '回声还在飞的时候不能 fork')
  assert.equal(result.code, 'pending-input')
  assert.equal(services.calls.forks.length, 0, '不得 fork 出带未落定输入的分支')
  assert.match(String(window.__dsew.pendingSource || ''), /echo/)
})

test('pending 输入：子会话投影里继承来的旧消息被清掉（不替用户重复执行）', async () => {
  const services = makeServices({
    chatOf: plainRewindChat,
    // 真机形态：种子把被回退那条消息的 inbox 插入带进子会话 —— 投影里有、queue 镜像里没有。
    onForked: (childId, binding) => { binding.session.live.inbox = inboxOf([['m-inherited', '继续']]) },
  })
  services.seed('s1', { title: 'T' })
  applyWith(services)
  const target = internals()._module.exchangesOfSession('s1').find((ex) => ex.seq === 3)
  const result = await internals()._module.doRewind('s1', target)
  assert.equal(result.ok, true)
  assert.ok(
    services.calls.queueRemoves.some(([id, action]) => id === 'm-inherited' && action.kind === 'remove'),
    '继承来的 pending 必须被删掉，否则用户再发消息时先执行它、新消息只能排队',
  )
  assert.ok(window.__dsew.childPendingCleared >= 1)
  assert.match(String(window.__dsew.childPendingSource || ''), /inbox-projection/)
})

test('还原时序：子会话先挂载、还原晚武装时，文本仍回到输入框（真机 open 早于 arm 的顺序）', async () => {
  let childEnv = null
  const services = makeServices({
    chatOf: plainRewindChat,
    onOpen: (id) => { childEnv = mount({ services, sessionId: id, chat: chatOf([]), draft: '' }) },
  })
  services.seed('s1', { title: 'T' })
  applyWith(services)
  const target = internals()._module.exchangesOfSession('s1').find((ex) => ex.seq === 3)
  const result = await internals()._module.doRewind('s1', target)
  assert.equal(result.ok, true)
  assert.ok(childEnv, '子会话应当在 open 时就挂载（真机顺序）')
  await new Promise((r) => setTimeout(r, 250))
  childEnv.rerender()
  const setDraftCalls = childEnv.inputs.filter(([op]) => op === 'setDraft')
  assert.equal(setDraftCalls.length, 1, '晚武装也要把被撤销的提问写回输入框')
  assert.equal(setDraftCalls[0][1], 'q2')
  assert.equal(window.__dsew.pendingApplied, 1)
})

test('还原：同一次页面里第二次回退也能把提问写回输入框（不再被一次性 ref 卡住）', async () => {
  const services = makeServices({ chatOf: plainRewindChat })
  services.seed('s1', { title: 'T' })
  applyWith(services)
  const target = internals()._module.exchangesOfSession('s1').find((ex) => ex.seq === 3)
  const first = await internals()._module.doRewind('s1', target)
  assert.equal(first.ok, true)
  const env = mount({ services, sessionId: first.childId, chat: chatOf([]), draft: '' })
  await new Promise((r) => setTimeout(r, 150))
  env.rerender()
  assert.equal(env.inputs.filter(([op]) => op === 'setDraft').length, 1, '第一次回退回填一次')
  // 第二次回退：同一个桥组件实例被复用（真机会话区按 sessionId keyed，但插件不能依赖它）。
  const second = await internals()._module.doRewind('s1', target)
  assert.equal(second.ok, true)
  env.sessionId = second.childId
  env.chat = chatOf([])
  env.draft = ''
  env.rerender()
  await new Promise((r) => setTimeout(r, 150))
  env.rerender()
  assert.equal(
    env.inputs.filter(([op]) => op === 'setDraft').length,
    2,
    '第二次回退同样要把提问写回输入框',
  )
})

test('pending 输入：核心没有 inbox 投影时降级走 queue 镜像（不报错、诊断可见）', async () => {
  const services = makeServices({ chatOf: plainRewindChat })
  services.seed('s1', { title: 'T', queue: [{ id: 'q-old-core', placement: 'queued' }] })
  applyWith(services)
  const target = internals()._module.exchangesOfSession('s1').find((ex) => ex.seq === 3)
  const result = await internals()._module.doRewind('s1', target)
  assert.equal(result.ok, true)
  assert.ok(services.calls.queueRemoves.some(([id]) => id === 'q-old-core'), '旧核心仍走 queue 镜像')
  assert.match(String(window.__dsew.pendingSource || ''), /queue-mirror/)
})

test('还原：武装晚于挂载（open→arm 的极端顺序）时，模块级通知补跑一次回填', async () => {
  const services = makeServices()
  services.seed('s1', { title: 'T' })
  applyWith(services)
  // 桥先挂载（此时 __pending 为 null，挂载 effect 什么也看不到）……
  const env = mount({ services, sessionId: 's1', chat: chatOf([]), draft: '' })
  await new Promise((r) => setTimeout(r, 20))
  assert.equal(env.inputs.filter(([op]) => op === 'setDraft').length, 0)
  // ……武装才到（真机：open 早于 arm）。
  internals()._module.armPendingRestore('s1', '晚到的提问', [])
  await new Promise((r) => setTimeout(r, 150))
  env.rerender()
  const calls = env.inputs.filter(([op]) => op === 'setDraft')
  assert.equal(calls.length, 1, '晚武装必须由通知补跑，不能永久错过')
  assert.equal(calls[0][1], '晚到的提问')
  assert.equal(window.__dsew.pendingLateArm, 1)
})

test('真机场景合体：子会话继承旧提问 + 子会话先挂载 → 继承项清掉且问题照样回到输入框', async () => {
  let childEnv = null
  const services = makeServices({
    chatOf: plainRewindChat,
    onForked: (childId, binding) => { binding.session.live.inbox = inboxOf([['m-inherited', 'q2']]) },
    onOpen: (id) => { childEnv = mount({ services, sessionId: id, chat: chatOf([]), draft: '' }) },
  })
  services.seed('s1', { title: 'T' })
  applyWith(services)
  const target = internals()._module.exchangesOfSession('s1').find((ex) => ex.seq === 3)
  const result = await internals()._module.doRewind('s1', target)
  assert.equal(result.ok, true)
  assert.ok(
    services.calls.queueRemoves.some(([id, action]) => id === 'm-inherited' && action.kind === 'remove'),
    '继承项必须清掉（否则重发时先执行它、新消息排队）',
  )
  await new Promise((r) => setTimeout(r, 250))
  childEnv.rerender()
  const setDraftCalls = childEnv.inputs.filter(([op]) => op === 'setDraft')
  assert.equal(setDraftCalls.length, 1, '清理子会话的同时，提问仍要回到输入框')
  assert.equal(setDraftCalls[0][1], 'q2')
  assert.equal(window.__dsew.pendingApplied, 1)
  assert.ok(window.__dsew.childPendingCleared >= 1)
})

// --- delete mode (group 7) ---------------------------------------------------

/** Mount the header dispose toggle (registered[1] = header slot entry). */
function mountHeader({ services, sessionId, summary }) {
  const component = services.registered.find((r) => r.options.name === 'conversation.session.header.actions').component
  const env = { clicks: 0 }
  const props = () => ({
    sessionId,
    t: (k) => k,
    useSessions: (sel) => sel({ byId: { [sessionId]: summary } }),
  })
  const render = (first) => { if (first) freshInstance(); else beginRender(); return component(props()) }
  const materialize = (tree) => {
    if (tree && tree.__element && typeof tree.type === 'function') { try { tree.type(tree.props) } catch { /* noop */ } }
    if (tree && tree.props && tree.props.children) {
      const kids = Array.isArray(tree.props.children) ? tree.props.children : [tree.props.children]
      for (const kid of kids) materialize(kid)
    }
    return tree
  }
  env.render = () => { let tree = render(true); if (isDirty()) tree = render(false); return materialize(tree) }
  env.rerender = () => { let tree = render(false); if (isDirty()) tree = render(false); return materialize(tree) }
  env.buttonOf = (tree) => {
    // Fragment wraps [button, toast?]
    const children = tree && tree.props && tree.props.children
    const list = Array.isArray(children) ? children : [children]
    return list.find((c) => c && c.props && c.props.type === 'button' && typeof c.props.onClick === 'function')
  }
  env.click = () => {
    env.clicks += 1
    const button = env.buttonOf(env.rerender())
    if (button && typeof button.props.onClick === 'function') button.props.onClick()
  }
  env.render()
  return env
}

/** Stub global fetch for one test; restores the previous value afterwards. */
async function withFetch(stub, fn) {
  const previous = globalThis.fetch
  globalThis.fetch = stub
  try {
    return await fn()
  } finally {
    if (previous === undefined) delete globalThis.fetch
    else globalThis.fetch = previous
  }
}

test('delete mode: describe true arms delete; describe failure falls back to archive', async () => {
  const services = makeServices()
  applyWith(services)
  assert.equal(internals()._module.deleteModeOn(), false, 'default is archive')
  services.setSettingsValue(true)
  await internals()._module.loadDeleteMode()
  assert.equal(internals()._module.deleteModeOn(), true, 'delete armed after describe true')
  services.setSettingsValue(false)
  await internals()._module.loadDeleteMode()
  assert.equal(internals()._module.deleteModeOn(), false)
  services.setSettingsDescribeError(new Error('settings down'))
  await internals()._module.loadDeleteMode()
  assert.equal(internals()._module.deleteModeOn(), false, 'describe failure must never arm delete')
})

test('delete mode: setDeleteMode persists and toasts the outcome', async () => {
  const services = makeServices()
  services.seed('s1', { title: 'T' })
  applyWith(services)
  // Mount the overlay bridge so a toast listener is registered (in the GUI the
  // header toggle click goes through the same fan-out).
  const env = mount({ services, sessionId: 's1', chat: chatOf([]) })
  toasts.length = 0
  const result = await internals()._module.setDeleteMode(true)
  assert.equal(result.ok, true)
  assert.deepEqual(services.settingsCalls.updates[0][0], 'esc-rewind')
  assert.equal(services.settingsCalls.updates[0][1].deleteOldOnRewind, true)
  env.rerender() // surface the toast
  assert.ok(toasts.includes('已开启：回退将删除旧会话（不可恢复）'), 'enabled toast shown')
  assert.equal(internals()._module.deleteModeOn(), true)
  toasts.length = 0
  await internals()._module.setDeleteMode(false)
  env.rerender()
  assert.equal(services.settingsCalls.updates[1][1].deleteOldOnRewind, false)
  assert.ok(toasts.includes('已关闭：回退将归档旧会话'), 'disabled toast shown')
})

test('delete mode: failed settings write rolls back to the previous value', async () => {
  const services = makeServices()
  services.seed('s1', { title: 'T' })
  applyWith(services)
  const env = mount({ services, sessionId: 's1', chat: chatOf([]) })
  services.setSettingsValue(true)
  await internals()._module.loadDeleteMode()
  assert.equal(internals()._module.deleteModeOn(), true)
  services.setSettingsUpdateError(new Error('write rejected'))
  toasts.length = 0
  const result = await internals()._module.setDeleteMode(false)
  assert.equal(result.ok, false)
  assert.equal(internals()._module.deleteModeOn(), true, 'rolls back to delete after failed write')
  env.rerender()
  assert.ok(toasts.some((t) => t.startsWith('切换失败：')), 'error toast shown')
})

test('delete mode: doRewind deletes the old session after the branch opens', async () => {
  const chat = chatOf([user(1, 'q1'), settled(2, 'a1'), user(3, 'rewind me'), runningAssistant(4)])
  const services = makeServices({ chatOf: () => chat })
  services.seed('s1', { title: 'Original' })
  applyWith(services)
  const env = mount({ services, sessionId: 's1', chat })
  services.setSettingsValue(true)
  await internals()._module.loadDeleteMode()
  const target = internals()._module.exchangesOfSession('s1').find((ex) => ex.seq === 3)
  assert.ok(target)
  const fetches = []
  await withFetch(async (url, opts) => {
    fetches.push([url, opts])
    return { ok: true, status: 200, json: async () => ({ ok: true }) }
  }, async () => {
    const result = await internals()._module.doRewind('s1', target)
    assert.equal(result.ok, true)
  })
  assert.deepEqual(fetches[0][0], '/__esc-rewind/session/delete')
  assert.equal(JSON.parse(fetches[0][1].body).sessionId, 's1')
  assert.ok(!services.calls.archived.includes('s1'), 'delete mode must NOT archive')
  env.rerender()
  assert.ok(toasts.includes('旧会话已删除'), 'deleted toast shown')
})

test('delete mode: failed delete degrades to archive and warns', async () => {
  const chat = chatOf([user(1, 'q1'), settled(2, 'a1'), user(3, 'rewind me'), runningAssistant(4)])
  const services = makeServices({ chatOf: () => chat })
  services.seed('s1', { title: 'Original' })
  applyWith(services)
  const env = mount({ services, sessionId: 's1', chat })
  services.setSettingsValue(true)
  await internals()._module.loadDeleteMode()
  const target = internals()._module.exchangesOfSession('s1').find((ex) => ex.seq === 3)
  assert.ok(target, 'target exchange found')
  await withFetch(async () => ({ ok: false, status: 500, json: async () => ({ error: 'boom' }) }), async () => {
    const result = await internals()._module.doRewind('s1', target)
    assert.equal(result.ok, true, 'rewind itself still succeeds')
  })
  assert.ok(services.calls.archived.includes('s1'), 'failed delete falls back to archive')
  env.rerender()
  assert.ok(toasts.includes('删除失败，已改为归档'), 'degrade warning shown')
})

test('archive (0.2.0): 被「仍活跃」拒绝 → 带 stopActivity 重试成功（不再静默失败）', async () => {
  const chat = chatOf([user(1, 'q1'), settled(2, 'a1'), user(3, 'rewind me'), runningAssistant(4)])
  let attempts = 0
  const services = makeServices({
    chatOf: () => chat,
    archiveSession: (id, options) => {
      attempts += 1
      if (attempts === 1) {
        return { ok: false, error: { code: 'workspace/session-active', message: 'session has running work' } }
      }
      assert.equal(options && options.stopActivity, true, '重试必须带 stopActivity')
      return { ok: true, value: { archivedSessionIds: [id] } }
    },
  })
  services.seed('s1', { title: 'Original' })
  applyWith(services)
  const env = mount({ services, sessionId: 's1', chat })
  const target = internals()._module.exchangesOfSession('s1').find((ex) => ex.seq === 3)
  assert.ok(target, 'target exchange found')
  const result = await internals()._module.doRewind('s1', target)
  assert.equal(result.ok, true, '回退成功')
  assert.equal(attempts, 2, '先普通归档、被拒后重试一次')
  assert.equal(services.calls.archiveOptions[0], undefined, '第一次不带 options')
  assert.equal(services.calls.archiveOptions[1].stopActivity, true, '第二次带 stopActivity')
  assert.equal(window.__dsew.archiveStopActivity, true, '诊断记录走了「停止并归档」')
  assert.equal(window.__dsew.archiveFail, null, '最终成功，无失败诊断')
  env.rerender()
  assert.ok(!toasts.some((text) => String(text).indexOf('归档失败') >= 0), '成功时不得弹归档失败')
})

test('archive (0.2.0): 其它拒绝如实记录并提示（绝不静默）', async () => {
  const chat = chatOf([user(1, 'q1'), settled(2, 'a1'), user(3, 'rewind me'), runningAssistant(4)])
  const services = makeServices({
    chatOf: () => chat,
    archiveSession: () => ({ ok: false, error: { code: 'session/not-found', message: 'gone' } }),
  })
  services.seed('s1', { title: 'Original' })
  applyWith(services)
  const env = mount({ services, sessionId: 's1', chat })
  const target = internals()._module.exchangesOfSession('s1').find((ex) => ex.seq === 3)
  const result = await internals()._module.doRewind('s1', target)
  assert.equal(result.ok, true, '回退本身仍然成功')
  assert.equal(services.calls.archived.length, 1, '非「仍活跃」的拒绝不重试')
  assert.equal(window.__dsew.archiveFail, 'gone', '拒绝原因进诊断')
  assert.equal(window.__dsew.archiveStopActivity, false)
  env.rerender()
  assert.ok(toasts.some((text) => String(text).indexOf('旧会话归档失败') >= 0 && String(text).indexOf('gone') >= 0), '归档失败必须可见')
})

test('archive (0.1.x 兼容): 旧实现抛异常时被记录且不影响回退', async () => {
  const chat = chatOf([user(1, 'q1'), settled(2, 'a1'), user(3, 'rewind me'), runningAssistant(4)])
  const services = makeServices({
    chatOf: () => chat,
    archiveSession: () => { throw new Error('legacy-boom') },
  })
  services.seed('s1', { title: 'Original' })
  applyWith(services)
  mount({ services, sessionId: 's1', chat })
  const target = internals()._module.exchangesOfSession('s1').find((ex) => ex.seq === 3)
  const result = await internals()._module.doRewind('s1', target)
  assert.equal(result.ok, true, '回退成功')
  assert.equal(window.__dsew.archiveFail, 'legacy-boom', '旧世代的抛错同样被记录')
  assert.equal(window.__dsew.archiveStopActivity, false, '抛错不触发 stopActivity 重试')
})


test('delete mode: 宿主拒绝真删（仍有子代理）→ 降级归档 + 专用提示', async () => {
  const chat = chatOf([user(1, 'q1'), settled(2, 'a1'), user(3, 'rewind me'), runningAssistant(4)])
  const services = makeServices({ chatOf: () => chat })
  services.seed('s1', { title: 'Original' })
  applyWith(services)
  const env = mount({ services, sessionId: 's1', chat })
  services.setSettingsValue(true)
  await internals()._module.loadDeleteMode()
  const target = internals()._module.exchangesOfSession('s1').find((ex) => ex.seq === 3)
  assert.ok(target, 'target exchange found')
  await withFetch(async () => ({
    ok: false,
    status: 409,
    json: async () => ({
      error: 'refusing to delete session "s1": it still owns 2 subagent session(s) (1 running)',
      reason: 'subagents',
      children: 2,
      running: 1,
    }),
  }), async () => {
    const result = await internals()._module.doRewind('s1', target)
    assert.equal(result.ok, true, '回退本身仍然成功')
  })
  assert.ok(services.calls.archived.includes('s1'), '宿主拒绝 → 降级归档旧会话')
  assert.equal(window.__dsew.lastDelete.ok, false)
  assert.equal(window.__dsew.lastDelete.reason, 'subagents')
  assert.equal(window.__dsew.lastDelete.children, 2)
  assert.equal(window.__dsew.lastDelete.running, 1)
  env.rerender()
  assert.ok(toasts.includes('该会话还有 2 个子代理（运行中 1），已改为归档（不删除）'), '专用提示')
  assert.ok(!toasts.includes('旧会话已删除'), '不得谎报已删除')
})

test('delete mode: 子代理状态读不到时也不真删（fail-safe 归档 + 原因）', async () => {
  const chat = chatOf([user(1, 'q1'), settled(2, 'a1'), user(3, 'rewind me'), runningAssistant(4)])
  const services = makeServices({ chatOf: () => chat })
  services.seed('s1', { title: 'Original' })
  applyWith(services)
  const env = mount({ services, sessionId: 's1', chat })
  services.setSettingsValue(true)
  await internals()._module.loadDeleteMode()
  const target = internals()._module.exchangesOfSession('s1').find((ex) => ex.seq === 3)
  assert.ok(target, 'target exchange found')
  await withFetch(async () => ({
    ok: false,
    status: 409,
    json: async () => ({
      error: 'refusing to delete session "s1": subagent state unavailable (listing exploded)',
      reason: 'subagents-unknown',
      children: 0,
      running: 0,
    }),
  }), async () => {
    const result = await internals()._module.doRewind('s1', target)
    assert.equal(result.ok, true, '回退本身仍然成功')
  })
  assert.ok(services.calls.archived.includes('s1'), '未知态同样降级归档')
  assert.equal(window.__dsew.lastDelete.reason, 'subagents-unknown')
  env.rerender()
  assert.ok(toasts.some((text) => String(text).startsWith('读不到该会话的子代理状态')), '未知态提示带原因')
  assert.ok(!toasts.includes('旧会话已删除'), '不得谎报已删除')
})

test('delete mode: first-exchange degradation deletes the old session too', async () => {
  const chat = chatOf([user(1, 'only question'), runningAssistant(2)])
  const services = makeServices({ chatOf: () => chat })
  services.seed('s1', { title: 'T' })
  applyWith(services)
  const env = mount({ services, sessionId: 's1', chat })
  services.setSettingsValue(true)
  await internals()._module.loadDeleteMode()
  const first = internals()._module.exchangesOfSession('s1').find((ex) => ex.isFirst === true)
  assert.ok(first, 'first exchange present')
  await withFetch(async () => ({ ok: true, status: 200, json: async () => ({ ok: true }) }), async () => {
    const result = await internals()._module.doRewind('s1', first)
    assert.equal(result.ok, true)
  })
  assert.equal(services.calls.creates.length, 1, 'fresh same-workspace session created')
  assert.ok(!services.calls.archived.includes('s1'), 'no archive in delete mode')
  env.rerender()
  assert.ok(toasts.includes('旧会话已删除'), 'deleted toast shown')
})

test('header toggle: renders archive glyph by default and flips to delete on click', async () => {
  const services = makeServices()
  services.seed('s1', { title: 'T' })
  applyWith(services)
  toasts.length = 0
  const env = mountHeader({ services, sessionId: 's1', summary: { title: 'T' } })
  const first = env.buttonOf(env.rerender())
  assert.ok(first, 'button renders')
  assert.equal(first.props.title, 'dispose.title.archive', 'archive state by default')
  env.click()
  await new Promise((r) => setTimeout(r, 0)) // async settings write
  assert.equal(internals()._module.deleteModeOn(), true, 'click arms delete mode')
  env.rerender() // surface the toast the click published
  assert.ok(toasts.includes('已开启：回退将删除旧会话（不可恢复）'))
  const second = env.buttonOf(env.rerender())
  assert.equal(second.props.title, 'dispose.title.delete', 'delete state after toggle')
})

test('header toggle: hidden for subagent and blank sessions', async () => {
  const services = makeServices()
  services.seed('s1', { title: 'T' })
  applyWith(services)
  const subagent = mountHeader({ services, sessionId: 's1', summary: { title: 'T', origin: 'subagent' } })
  assert.equal(subagent.render(), null, 'subagent session: no toggle')
  const blank = mountHeader({ services, sessionId: 's1', summary: { title: 'T', blank: true } })
  assert.equal(blank.render(), null, 'blank session: no toggle')
  const normal = mountHeader({ services, sessionId: 's1', summary: { title: 'T' } })
  assert.ok(normal.render(), 'normal session: toggle visible')
})

test('delete mode: ESC stop hint carries the irreversible warning', async () => {
  const services = makeServices()
  services.seed('s1', { running: true })
  applyWith(services)
  services.setSettingsValue(true)
  await internals()._module.loadDeleteMode()
  services.setRunning('s1', true)
  const env = mount({
    services,
    sessionId: 's1',
    chat: chatOf([user(1, 'q1'), settled(2, 'a1'), user(3, 'q2'), runningAssistant(4)]),
    running: true,
  })
  toasts.length = 0
  env.press('Escape')
  assert.ok(toasts.includes('esc.hint.delete'), 'warning hint used in delete mode')
  assert.ok(!toasts.includes('esc.hint'), 'plain hint not used')
})

// --- orphan reclaim（宿主扫描 + 核心「插件」页 tab） ---------------------------

/** All rendered nodes of a shim element tree (depth-first). */
function collectNodes(node, out = []) {
  if (node === null || node === undefined) return out
  if (Array.isArray(node)) { for (const kid of node) collectNodes(kid, out); return out }
  if (typeof node !== 'object') return out
  out.push(node)
  collectNodes(node.props && node.props.children, out)
  return out
}

/** Concatenated text of a shim element tree. */
function treeText(node) {
  if (node === null || node === undefined) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(treeText).join(' ')
  if (typeof node !== 'object') return ''
  return treeText(node.props && node.props.children)
}

/** The orphan tab entry as registered by the bundle. */
function orphanTabEntry(services) {
  return services.registered.find((entry) => entry.options.name === 'settings.localPlugins.tab')
}

/**
 * Render the orphan panel (effects run per render in the shim). Pass the same
 * \`state\` object to keep component state across calls; omit it for a fresh mount.
 */
async function renderOrphans(services, state = {}, rounds = 8) {
  const entry = orphanTabEntry(services)
  // 2026-10-18: the orphan TAB is dormant (nothing registers on
  // settings.localPlugins.tab), so the component is reached through the
  // bundle's exported internals. Panel logic itself is unchanged.
  const component = entry ? entry.component : internals()._module.orphansPanel
  assert.equal(typeof component, 'function', 'orphan panel reachable (dormant tab: via exported internals)')
  if (state.entry === undefined) { freshInstance(); state.entry = component }
  let tree = null
  for (let i = 0; i < rounds; i += 1) {
    beginRender()
    tree = state.entry({})
    await new Promise((resolve) => setTimeout(resolve, 0))
  }
  return tree
}

/** One rendered button whose visible text is exactly \`label\`. */
function buttonByText(tree, label) {
  return collectNodes(tree).find((node) => node.type === 'button' && treeText(node) === label)
}

test('orphan tab 休眠（2026-10-18）：不再注册 tab 槽，但面板与宿主端点全部保留、经导出可达', async () => {
  const services = makeServices()
  applyWith(services)
  assert.equal(orphanTabEntry(services), undefined, '不再往 settings.localPlugins.tab 注册（界面上没有该 tab）')
  assert.equal(window.__dsew.orphanTabRegistered, false)
  assert.equal(window.__dsew.orphanTabDormant, true, '诊断区分「有意不注册」与「注册失败」')
  assert.equal(window.__dsew.orphanTabError, null, '休眠不是错误')
  const mod = internals()._module
  assert.equal(typeof mod.orphansPanel, 'function', '面板实现仍导出（可测试、可一键恢复注册）')
  for (const fn of ['fetchOrphans', 'stopOrphans', 'rescueOrphan', 'stopResultText']) {
    assert.equal(typeof mod[fn], 'function', fn + ' 仍导出（宿主端点未变）')
  }
  // 旧核心（连槽都没有）与休眠期行为一致：都是「没有 entry」，且都不算错误。
  const legacy = makeServices({ slotsAvailable: ['conversation.input.overlay', 'conversation.session.header.actions'] })
  applyWith(legacy)
  assert.equal(orphanTabEntry(legacy), undefined, '旧核心没有该槽 ⇒ 同样不注册')
  assert.equal(window.__dsew.orphanTabError, null, '槽不存在不算错误')
  assert.equal(window.__dsew.orphanTabDormant, true)
})

test('orphan tab: 打开面板只读扫描（GET）并按行渲染事实', async () => {
  const rows = [
    { id: 'ffffffff-1111-2222-3333-444444444444', label: 'Mac 侧重建与回归流水线', parentId: 'eeeeeeee-1111-2222-3333-444444444444', running: true, canRescue: true, atSeq: 42, lastActivity: 1790064186000, error: null },
    { id: 'aaaaaaaa-1111-2222-3333-444444444444', label: 'aaaaaaaa-1111-2222-3333-444444444444', parentId: null, running: false, canRescue: false, atSeq: null, lastActivity: null, error: null },
  ]
  const services = makeServices()
  applyWith(services)
  const seen = []
  await withFetch(async (url, opts) => {
    seen.push([String(url), (opts || {}).method || 'GET'])
    return { ok: true, status: 200, json: async () => ({ ok: true, count: 2, orphans: rows }) }
  }, async () => {
    const tree = await renderOrphans(services)
    const text = treeText(tree)
    assert.ok(text.indexOf('Mac 侧重建与回归流水线') !== -1, 'label 渲染')
    assert.ok(text.indexOf('运行中') !== -1, '在跑标记渲染')
    assert.ok(text.indexOf('共 2 个') !== -1, '计数渲染')
    assert.equal(buttonByText(tree, '找回').props.disabled, false)
    assert.equal(buttonByText(tree, '停止').props.disabled, false)
  })
  assert.deepEqual(seen, [['/__esc-rewind/orphans', 'GET']], '打开只发一次 GET')
  assert.deepEqual(services.calls.cancels, [], '打开不取消任何运行')
  assert.deepEqual(services.calls.forks, [], '打开不 fork')
  assert.equal(window.__dsew.orphans.count, 2)
  assert.equal(window.__dsew.orphans.phase, 'ready')
})

test('orphan tab: 空态与失败态如实呈现（失败不得冒充 0 个孤儿）', async () => {
  const empty = makeServices()
  applyWith(empty)
  await withFetch(async () => ({ ok: true, status: 200, json: async () => ({ ok: true, count: 0, orphans: [] }) }), async () => {
    const tree = await renderOrphans(empty)
    assert.ok(treeText(tree).indexOf('没有孤儿子代理') !== -1, '空态')
  })
  const failing = makeServices()
  applyWith(failing)
  await withFetch(async () => ({ ok: false, status: 500, json: async () => ({ error: 'scan exploded' }) }), async () => {
    const tree = await renderOrphans(failing)
    assert.ok(treeText(tree).indexOf('读取失败') !== -1, '失败态')
    assert.ok(treeText(tree).indexOf('scan exploded') !== -1, '失败原因可见')
  })
  assert.equal(window.__dsew.orphans.phase, 'error')
  assert.equal(window.__dsew.orphans.count, null, '失败时不得报 0')
})

test('orphan tab: 逐行「停止」走宿主端点，未确认静默如实渲染', async () => {
  const sid = 'ffffffff-1111-2222-3333-444444444444'
  const services = makeServices()
  applyWith(services)
  const posts = []
  await withFetch(async (url, opts) => {
    if (String(url).indexOf('/stop') !== -1) {
      posts.push(JSON.parse(opts.body))
      return { ok: true, status: 200, json: async () => ({ ok: true, results: [{ id: sid, stopped: true, confirmed: false, reason: 'timeout' }], stopped: 0 }) }
    }
    return { ok: true, status: 200, json: async () => ({ ok: true, count: 1, orphans: [{ id: sid, label: '孤儿', parentId: 'gone', running: true, canRescue: true, atSeq: 7, lastActivity: 1, error: null }] }) }
  }, async () => {
    const state = {}
    const tree = await renderOrphans(services, state)
    buttonByText(tree, '停止').props.onClick()
    const after = await renderOrphans(services, state)
    assert.deepEqual(posts, [{ ids: [sid] }], 'POST 体是 {ids:[...]}')
    assert.ok(treeText(after).indexOf('已请求取消，未确认静默（timeout）') !== -1, '未确认静默不谎报成功')
  })
})

test('orphan tab: 「找回」= 运行中先停 → fork(atSeq) → 沿用标签 → open；不删原孤儿', async () => {
  const sid = 'ffffffff-1111-2222-3333-444444444444'
  const services = makeServices()
  applyWith(services)
  const order = []
  await withFetch(async (url, opts) => {
    if (String(url).indexOf('/stop') !== -1) {
      order.push('stop')
      return { ok: true, status: 200, json: async () => ({ ok: true, results: [{ id: sid, stopped: true, confirmed: true, reason: null }], stopped: 1 }) }
    }
    order.push('scan')
    return { ok: true, status: 200, json: async () => ({ ok: true, count: 1, orphans: [{ id: sid, label: 'Mac 流水线', parentId: 'gone', running: true, canRescue: true, atSeq: 42, lastActivity: 1, error: null }] }) }
  }, async () => {
    const state = {}
    const tree = await renderOrphans(services, state)
    buttonByText(tree, '找回').props.onClick()
    const after = await renderOrphans(services, state)
    assert.ok(treeText(after).indexOf('已找回为普通会话') !== -1, '成功提示')
  })
  assert.deepEqual(order.slice(0, 2), ['scan', 'stop'], '运行中的孤儿先停再 fork')
  assert.deepEqual(services.calls.forks[0], { sessionId: sid, atSeq: 42, increaseTitle: false }, 'fork 用孤儿的完整回合边界')
  assert.deepEqual(services.calls.renames, [['child-1', 'Mac 流水线']], '标题沿用孤儿标签')
  assert.ok(services.calls.opens.includes('child-1'), '分支被打开')
  assert.deepEqual(services.calls.archived, [], '不归档、不删除任何会话')
})

test('orphan tab: 无完整回合的孤儿禁用「找回」并给出原因；批量按钮需先勾选', async () => {
  const services = makeServices()
  applyWith(services)
  await withFetch(async () => ({
    ok: true, status: 200,
    json: async () => ({ ok: true, count: 1, orphans: [{ id: 'aaaaaaaa-1111-2222-3333-444444444444', label: '半截孤儿', parentId: 'gone', running: false, canRescue: false, atSeq: null, lastActivity: null, error: null }] }),
  }), async () => {
    const state = {}
    const tree = await renderOrphans(services, state)
    const rescue = buttonByText(tree, '找回')
    assert.equal(rescue.props.disabled, true, '没有完整回合 ⇒ 不可点')
    assert.equal(rescue.props.title, '没有完整回合，无法找回', '原因可见')
    assert.equal(buttonByText(tree, '停止选中').props.disabled, true)
    assert.equal(buttonByText(tree, '找回选中').props.disabled, true)
    const box = collectNodes(tree).find((node) => node.type === 'input')
    box.props.onChange()
    const after = await renderOrphans(services, state)
    assert.equal(buttonByText(after, '停止选中').props.disabled, false, '勾选后批量可用')
  })
  assert.deepEqual(services.calls.forks, [], '禁用状态下没有 fork')
})

test('orphan tab: 「删除」逐行/批量都走受守卫端点；全选→批量→结果如实（含守卫拒绝）', async () => {
  const blocked = 'aaaaaaaa-1111-2222-3333-444444444444'
  const plain = 'bbbbbbbb-1111-2222-3333-444444444444'
  const services = makeServices()
  applyWith(services)
  const posts = []
  const confirms = []
  const previousConfirm = globalThis.window.confirm
  globalThis.window.confirm = (message) => { confirms.push(message); return true }
  try {
    await withFetch(async (url, opts) => {
      if (String(url).indexOf('/orphans/delete') !== -1) {
        posts.push(JSON.parse(opts.body))
        return {
          ok: true, status: 200,
          json: async () => ({
            ok: true, deleted: 1, blocked: 1,
            results: [
              { id: blocked, deleted: false, reason: 'subagents', children: 2, status: 409 },
              { id: plain, deleted: true },
            ],
          }),
        }
      }
      return {
        ok: true, status: 200,
        json: async () => ({
          ok: true, count: 2,
          orphans: [
            { id: blocked, label: '父级孤儿', parentId: 'gone', running: false, canRescue: true, atSeq: 3, lastActivity: 1, error: null },
            { id: plain, label: '普通孤儿', parentId: 'gone', running: false, canRescue: true, atSeq: 3, lastActivity: 1, error: null },
          ],
        }),
      }
    }, async () => {
      const state = {}
      const tree = await renderOrphans(services, state)
      assert.equal(buttonByText(tree, '删除').props.disabled, false, '逐行删除可点')
      assert.equal(buttonByText(tree, '删除选中').props.disabled, true, '未勾选时批量删除禁用')
      assert.ok(buttonByText(tree, '全选'), '提供全选')
      buttonByText(tree, '全选').props.onClick()
      const all = await renderOrphans(services, state)
      assert.ok(buttonByText(all, '取消全选'), '全选后按钮变取消全选')
      assert.equal(buttonByText(all, '删除选中').props.disabled, false, '全选后批量可用')
      buttonByText(all, '取消全选').props.onClick()
      const cleared = await renderOrphans(services, state)
      assert.ok(buttonByText(cleared, '全选'), '取消全选后回到全选')
      assert.equal(buttonByText(cleared, '删除选中').props.disabled, true, '清空选择后批量重新禁用')
      buttonByText(cleared, '全选').props.onClick()
      const selectedAgain = await renderOrphans(services, state)
      buttonByText(selectedAgain, '删除选中').props.onClick()
      const after = await renderOrphans(services, state)
      assert.deepEqual(posts, [{ ids: [blocked, plain] }], '批量删除 POST 全部勾选 id')
      assert.match(String(confirms[0]), /2/, '确认框写明数量')
      assert.match(String(confirms[0]), /不可恢复/, '确认框写明不可恢复')
      const text = treeText(after)
      assert.ok(text.indexOf('已删除') !== -1, '成功项如实回报')
      assert.ok(text.indexOf('未删除：自己还挂着 2 个子代理（请先删子级）') !== -1, '守卫拒绝如实回报（含子级数）')
    })
  } finally {
    if (previousConfirm === undefined) delete globalThis.window.confirm
    else globalThis.window.confirm = previousConfirm
  }
})

test('orphan tab: 取消删除确认时一个请求都不发（破坏性动作必须显式确认）', async () => {
  const sid = 'cccccccc-1111-2222-3333-444444444444'
  const services = makeServices()
  applyWith(services)
  const posts = []
  const previousConfirm = globalThis.window.confirm
  globalThis.window.confirm = () => false
  try {
    await withFetch(async (url, opts) => {
      if (String(url).indexOf('/orphans/delete') !== -1) {
        posts.push(JSON.parse(opts.body))
        return { ok: true, status: 200, json: async () => ({ ok: true, deleted: 1, blocked: 0, results: [{ id: sid, deleted: true }] }) }
      }
      return {
        ok: true, status: 200,
        json: async () => ({ ok: true, count: 1, orphans: [{ id: sid, label: '孤儿', parentId: 'gone', running: false, canRescue: true, atSeq: 1, lastActivity: 1, error: null }] }),
      }
    }, async () => {
      const state = {}
      const tree = await renderOrphans(services, state)
      buttonByText(tree, '删除').props.onClick()
      const after = await renderOrphans(services, state)
      assert.deepEqual(posts, [], '取消确认 ⇒ 不发请求')
      assert.equal(treeText(after).indexOf('已删除'), -1, '没有删除结果')
    })
  } finally {
    if (previousConfirm === undefined) delete globalThis.window.confirm
    else globalThis.window.confirm = previousConfirm
  }
})

test('orphan tab: 宿主半缺端点（404/405）时给出「重启 dsh web」的可操作提示，而不是裸错误码', async () => {
  const sid = 'dddddddd-1111-2222-3333-444444444444'
  const services = makeServices()
  applyWith(services)
  const previousConfirm = globalThis.window.confirm
  globalThis.window.confirm = () => true
  try {
    await withFetch(async (url) => {
      if (String(url).indexOf('/orphans/delete') !== -1) {
        // 运行中的宿主没注册这条路由：隧道回 405 且没有 JSON body（实测现场）
        return { ok: false, status: 405, json: async () => { throw new Error('no json body') } }
      }
      return {
        ok: true, status: 200,
        json: async () => ({ ok: true, count: 1, orphans: [{ id: sid, label: '孤儿', parentId: 'gone', running: false, canRescue: true, atSeq: 1, lastActivity: 1, error: null }] }),
      }
    }, async () => {
      const state = {}
      const tree = await renderOrphans(services, state)
      buttonByText(tree, '删除').props.onClick()
      const after = await renderOrphans(services, state)
      const text = treeText(after)
      assert.ok(text.indexOf('宿主半没有这个端点') !== -1, '提示宿主半缺端点')
      assert.ok(text.indexOf('重启 dsh web') !== -1, '提示需要重启宿主')
      assert.equal(text.indexOf('delete-failed-405'), -1, '不再暴露裸错误码')
    })
  } finally {
    if (previousConfirm === undefined) delete globalThis.window.confirm
    else globalThis.window.confirm = previousConfirm
  }
})

test('orphan tab: 全手动不变量（无定时器；刷新只发 GET）', async () => {
  const source = fs.readFileSync(bundlePath, 'utf8')
  assert.ok(!/setInterval/.test(source), '面板不得有定时器')
  const services = makeServices()
  applyWith(services)
  const seen = []
  await withFetch(async (url, opts) => {
    seen.push((opts || {}).method || 'GET')
    return { ok: true, status: 200, json: async () => ({ ok: true, count: 0, orphans: [] }) }
  }, async () => {
    const state = {}
    const tree = await renderOrphans(services, state)
    buttonByText(tree, '刷新统计').props.onClick()
    await renderOrphans(services, state)
  })
  assert.deepEqual(seen, ['GET', 'GET'], '打开与刷新都只有 GET')
  assert.deepEqual(services.calls.cancels, [])
  assert.deepEqual(services.calls.forks, [])
})

test('capability audit: delete goes through the self-hosted channel only', () => {
  const clientSource = fs.readFileSync(path.join(here, '..', 'src', 'client.js'), 'utf8')
  // The client must not reach any third-party endpoint or host surface: the
  // only delete path is the self-owned DELETE_ENDPOINT (fetched), with the
  // archive fallback via workspaces.archiveSession. No chameleon endpoints.
  assert.ok(!/__chameleon|@huanlin/.test(clientSource), 'no third-party delete endpoint referenced')
  assert.ok(clientSource.includes("'/__esc-rewind/session/delete'"), 'self-owned delete endpoint constant present')
  assert.ok(clientSource.includes('archiveSession'), 'archive fallback present')
  const hostSource = fs.readFileSync(path.join(here, '..', 'src', 'index.js'), 'utf8')
  assert.ok(hostSource.includes("'/__esc-rewind/session/delete'"), 'host half serves the self-owned endpoint')
  assert.ok(!/__chameleon/.test(hostSource), 'host half does not call chameleon')
  assert.ok(hostSource.includes("BLOCK_REASON_CHILDREN = 'subagents'"), 'host declares the children refusal reason')
  assert.ok(hostSource.includes("BLOCK_REASON_UNKNOWN = 'subagents-unknown'"), 'host declares the unknown refusal reason')
  assert.ok(clientSource.includes("REASON_SUBAGENTS = 'subagents'"), 'client mirrors the children refusal reason')
  assert.ok(clientSource.includes("REASON_SUBAGENTS_UNKNOWN = 'subagents-unknown'"), 'client mirrors the unknown refusal reason')
  assert.ok(clientSource.includes("'settings.localPlugins.tab'"), 'orphan panel lives on the「本地插件」entry tab slot')
})

// --- host half (src/index.js, real ESM — delete core + endpoint) -------------

let hostMod = null
test('host half: deleteSessionCore removes log dir, projcache and workspace rows', async () => {
  const { pathToFileURL } = await import('node:url')
  hostMod = await import(pathToFileURL(path.join(here, '..', 'src', 'index.js')).href)
  const os = await import('node:os')
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsew-host-'))
  try {
    const sid = '11111111-2222-3333-4444-555555555555'
    const slug = path.join(root, 'myslug')
    fs.mkdirSync(path.join(slug, sid), { recursive: true })
    fs.writeFileSync(path.join(slug, sid, 'session.jsonl'), '{}')
    fs.mkdirSync(path.join(slug, 'session-' + sid), { recursive: true })
    // Fake storageDomain: projcache + workspace tables + archived global.
    const tables = {}
    const makeTable = (seed) => {
      const map = new Map(Object.entries(seed || {}))
      return {
        get: (k) => map.get(k),
        entries: () => [...map.entries()],
        put: async (k, v) => { map.set(k, v) },
        delete: async (k) => { map.delete(k) },
      }
    }
    const proj = makeTable({ [sid]: { identity: {} }, other: { identity: {} } })
    const wsTable = makeTable({ w1: { sessionIds: [sid, 'other'] } })
    const wsGlobal = { state: { archivedSessionIds: ['session-' + sid, 'zz'] }, get: () => wsGlobal.state, set: async (v) => { wsGlobal.state = v } }
    const sd = {
      get: (n) => n === 'session_projcache'
        ? { table: (t) => (t === 'sessions' ? proj : null) }
        : n === 'workspace' ? { table: (t) => (t === 'workspaces' ? wsTable : null), global: wsGlobal } : null,
    }
    const ctx = { get: (n) => (n === 'storageDomain' ? sd : undefined) }
    const result = await hostMod.deleteSessionCore(ctx, sid, root)
    assert.equal(result.dirRemoved, true)
    assert.equal(result.projRemoved, true)
    assert.equal(result.workspaceRemoved, true)
    assert.deepEqual(hostMod.findSessionDirs(sid, root), [], 'log dir gone')
    assert.equal(proj.get(sid), undefined, 'projcache row gone')
    assert.equal(proj.get('other') !== undefined, true, 'other rows untouched')
    assert.deepEqual(wsTable.get('w1').sessionIds, ['other'])
    assert.deepEqual(wsGlobal.state.archivedSessionIds, ['zz'])
    // Idempotency: a second delete is a 404-style error, not a throw-crash.
    await assert.rejects(() => hostMod.deleteSessionCore(ctx, sid, root), /session not found/)
  } finally {
    fs.rmSync(root, { recursive: true, force: true })
  }
})

/** Temp sessions root (both id spellings) + storageDomain fake for the guard tests. */
function makeHostFixture(sid) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsew-guard-'))
  fs.mkdirSync(path.join(root, 'slug', sid), { recursive: true })
  fs.writeFileSync(path.join(root, 'slug', sid, 'session.jsonl'), '{}')
  fs.mkdirSync(path.join(root, 'slug', 'session-' + sid), { recursive: true })
  const makeTable = (seed) => {
    const map = new Map(Object.entries(seed || {}))
    return {
      get: (k) => map.get(k),
      entries: () => [...map.entries()],
      put: async (k, v) => { map.set(k, v) },
      delete: async (k) => { map.delete(k) },
    }
  }
  const proj = makeTable({ [sid]: { identity: {} }, other: { identity: {} } })
  const wsTable = makeTable({ w1: { sessionIds: [sid, 'other'] } })
  const wsGlobal = { state: { archivedSessionIds: ['session-' + sid, 'zz'] }, get: () => wsGlobal.state, set: async (v) => { wsGlobal.state = v } }
  const sd = {
    get: (n) => n === 'session_projcache'
      ? { table: (t) => (t === 'sessions' ? proj : null) }
      : n === 'workspace' ? { table: (t) => (t === 'workspaces' ? wsTable : null), global: wsGlobal } : null,
  }
  return { root, sid, proj, wsTable, wsGlobal, sd }
}

test('host half: 会话仍有子代理时拒绝真删（409 + 原因/计数，磁盘与存储零改动）', async () => {
  const sid = '11111111-2222-3333-4444-555555555555'
  const fx = makeHostFixture(sid)
  try {
    const children = [
      { kind: 'child', id: 'c1', activity: 'running' },
      { kind: 'child', id: 'c2', activity: 'inactive' },
    ]
    let asked = null
    const ctx = {
      get: (name) => name === 'subagents'
        ? { listChildren: async (id) => { asked = id; return children } }
        : name === 'storageDomain' ? fx.sd : undefined,
    }
    await assert.rejects(() => hostMod.deleteSessionCore(ctx, sid, fx.root), (error) => {
      assert.equal(error.status, 409)
      assert.equal(error.details.reason, 'subagents')
      assert.equal(error.details.children, 2)
      assert.equal(error.details.running, 1)
      assert.match(error.message, /still owns 2 subagent/)
      return true
    })
    assert.equal(asked, sid, '守卫按本会话 id 查子代理')
    assert.equal(hostMod.findSessionDirs(sid, fx.root).length, 2, '两种拼写的日志目录都还在')
    assert.ok(fx.proj.get(sid) !== undefined, 'projcache 行未动')
    assert.deepEqual(fx.wsTable.get('w1').sessionIds, [sid, 'other'], 'workspace 记账未动')
    assert.deepEqual(fx.wsGlobal.state.archivedSessionIds, ['session-' + sid, 'zz'], '归档记账未动')
    assert.equal(hostMod.HOST_DIAG.lastGuard.reason, 'subagents', '诊断留存守卫结论')
    assert.equal(hostMod.HOST_DIAG.lastGuard.running, 1)
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true })
  }
})

test('host half: 读不到子代理状态时不真删（fail-safe：409 subagents-unknown）', async () => {
  const sid = '11111111-2222-3333-4444-666666666666'
  const fx = makeHostFixture(sid)
  try {
    const ctx = {
      get: (name) => name === 'subagents'
        ? { listChildren: async () => { throw new Error('listing exploded') } }
        : name === 'storageDomain' ? fx.sd : undefined,
    }
    await assert.rejects(() => hostMod.deleteSessionCore(ctx, sid, fx.root), (error) => {
      assert.equal(error.status, 409)
      assert.equal(error.details.reason, 'subagents-unknown')
      assert.match(error.message, /subagent state unavailable \(listing exploded\)/)
      return true
    })
    assert.equal(hostMod.findSessionDirs(sid, fx.root).length, 2, '日志目录未被删')
    assert.ok(fx.proj.get(sid) !== undefined, 'projcache 行未动')
  } finally {
    fs.rmSync(fx.root, { recursive: true, force: true })
  }
})

test('host half: 没有子代理（空列表或缺 subagents 服务）时照常真删', async () => {
  const sid = '11111111-2222-3333-4444-777777777777'
  for (const withService of [true, false]) {
    const fx = makeHostFixture(sid)
    try {
      let asked = 0
      const ctx = {
        get: (name) => name === 'subagents' && withService
          ? { listChildren: async () => { asked += 1; return [] } }
          : name === 'storageDomain' ? fx.sd : undefined,
      }
      const result = await hostMod.deleteSessionCore(ctx, sid, fx.root)
      assert.equal(result.dirRemoved, true)
      assert.equal(result.projRemoved, true)
      assert.deepEqual(hostMod.findSessionDirs(sid, fx.root), [], '日志目录已删')
      assert.equal(asked, withService ? 1 : 0, withService ? '空列表也算查过' : '缺服务时不查询')
    } finally {
      fs.rmSync(fx.root, { recursive: true, force: true })
    }
  }
})

/** Fake host ctx for the orphan scan/stop tests (only the services they read). */
function makeOrphanCtx({ headers = [], agents = {}, events = {}, observeError = null, services = true } = {}) {
  const calls = { listed: 0, observed: [], disposed: 0 }
  const ctx = {
    get: (name) => {
      if (name === 'sessionQuery' && services) {
        return {
          listSessions: async () => { calls.listed += 1; return headers.map((h) => ({ header: h })) },
          observeSession: async (id) => {
            calls.observed.push(id)
            if (observeError !== null) throw new Error(observeError)
            const list = events[id] || []
            return { events: list, [Symbol.dispose]: () => { calls.disposed += 1 } }
          },
        }
      }
      if (name === 'agents' && services) return { get: (id) => agents[id] }
      return undefined
    },
  }
  return { ctx, calls }
}

/** One running orphan agent stub whose cancel/whenIdle behavior is scripted. */
function makeOrphanAgent({ idle = true, waitMs = 0 } = {}) {
  const record = { cancels: 0 }
  return {
    status: 'running',
    cancel(cause) { record.cancels += 1; record.cause = cause },
    whenIdle: () => (idle ? Promise.resolve() : new Promise((resolve) => setTimeout(resolve, waitMs))),
    record,
  }
}

test('host half: orphanSetOf 按可达性判定（父缺失 / 父在 / 父本身是孤儿 / 非子代理）', () => {
  const wrap = (list) => list.map((header) => ({ header }))
  assert.deepEqual(hostMod.orphanSetOf(wrap([
    { id: 'p' },
    { id: 'c1', origin: 'subagent', parentSession: 'p' },
  ])), [], '父在 ⇒ 不算孤儿')
  assert.deepEqual(hostMod.orphanSetOf(wrap([
    { id: 'c1', origin: 'subagent', parentSession: 'gone' },
  ])), [{ id: 'c1', parentId: 'gone' }], '父缺失 ⇒ 孤儿')
  assert.deepEqual(hostMod.orphanSetOf(wrap([
    { id: 'mid', origin: 'subagent', parentSession: 'gone' },
    { id: 'leaf', origin: 'subagent', parentSession: 'mid' },
  ])), [{ id: 'leaf', parentId: 'mid' }, { id: 'mid', parentId: 'gone' }], '父本身是孤儿 ⇒ 后代也算（传递）')
  assert.deepEqual(hostMod.orphanSetOf(wrap([
    { id: 'plain' },
    { id: 'noparent', origin: 'subagent' },
  ])), [{ id: 'noparent', parentId: null }], '普通会话不算；无父记录的子代理算孤儿')
  assert.deepEqual(hostMod.orphanSetOf(undefined), [], '空语料不抛错')
})

test('host half: scanOrphans 只读扫描（label/canRescue/running/释放租约）', async () => {
  const headers = [
    { id: 'plain' },
    { id: 'orphan-a', origin: 'subagent', parentSession: 'gone' },
    { id: 'orphan-b', origin: 'subagent', parentSession: 'gone' },
  ]
  const events = {
    'orphan-a': [
      { type: 'session', seq: 0, time: 1000 },
      { type: 'subagent/descriptor', seq: 0, time: 1001, data: { mode: 'continuable', label: 'Mac 侧重建与回归流水线' } },
      { type: 'turn/end', seq: 42, time: 2000 },
    ],
    'orphan-b': [{ type: 'session', seq: 0, time: 500 }],
  }
  const agentA = makeOrphanAgent({ idle: true })
  const { ctx, calls } = makeOrphanCtx({ headers, events, agents: { 'orphan-a': agentA } })
  const result = await hostMod.scanOrphans(ctx)
  assert.equal(result.ok, true)
  assert.equal(result.count, 2)
  assert.deepEqual(result.orphans.map((row) => row.id), ['orphan-a', 'orphan-b'])
  const rowA = result.orphans[0]
  assert.equal(rowA.label, 'Mac 侧重建与回归流水线', 'label 取自 descriptor')
  assert.equal(rowA.running, true)
  assert.equal(rowA.canRescue, true)
  assert.equal(rowA.atSeq, 42, 'atSeq = 最后一个 turn/end')
  assert.equal(rowA.lastActivity, 2000)
  assert.equal(rowA.error, null, '普通会话不参与、未在跑的行也要如实')
  const rowB = result.orphans[1]
  assert.equal(rowB.label, 'orphan-b', '没有 descriptor 时回退 id')
  assert.equal(rowB.running, false)
  assert.equal(rowB.canRescue, false, '没有完整回合 ⇒ 不可找回')
  assert.equal(calls.disposed, 2, '每个观察租约都被释放')
  assert.equal(calls.listed, 1, '只列一次语料')
  assert.equal(agentA.record.cancels, 0, '扫描不停止任何 agent')
  assert.equal(hostMod.HOST_DIAG.lastOrphanScan.count, 2, '诊断留存')
})

test('host half: scanOrphans 单条读失败只降级该行；缺服务时返回空并记诊断', async () => {
  const headers = [{ id: 'orphan-a', origin: 'subagent', parentSession: 'gone' }]
  const failing = makeOrphanCtx({ headers, observeError: 'listing exploded' })
  const result = await hostMod.scanOrphans(failing.ctx)
  assert.equal(result.ok, true)
  assert.equal(result.count, 1)
  assert.match(result.orphans[0].error, /listing exploded/)
  assert.equal(result.orphans[0].canRescue, false)
  assert.equal(result.orphans[0].label, 'orphan-a')
  const missing = makeOrphanCtx({ headers, services: false })
  const empty = await hostMod.scanOrphans(missing.ctx)
  assert.equal(empty.ok, false)
  assert.equal(empty.code, 'session-query-unavailable')
  assert.equal(empty.count, 0)
  assert.equal(hostMod.HOST_DIAG.lastOrphanScan.error, 'session-query-unavailable')
})

test('host half: stopOrphanRun 三态（未在跑 no-op / 已停 / 未确认静默）', async () => {
  const sid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  const absent = makeOrphanCtx({ services: true })
  const noop = await hostMod.stopOrphanRun(absent.ctx, sid)
  assert.deepEqual(noop, { id: sid, stopped: false, confirmed: false, reason: 'not-running' })
  const agent = makeOrphanAgent({ idle: true })
  const running = makeOrphanCtx({ agents: { [sid]: agent } })
  const stopped = await hostMod.stopOrphanRun(running.ctx, sid)
  assert.equal(stopped.stopped, true)
  assert.equal(stopped.confirmed, true)
  assert.equal(agent.record.cancels, 1, 'cancel 恰好一次')
  assert.deepEqual(agent.record.cause, { kind: 'user' }, '取消原因与既有停止一致')
  const stuck = makeOrphanAgent({ idle: false, waitMs: 5000 })
  const stalled = makeOrphanCtx({ agents: { [sid]: stuck } })
  const unconfirmed = await hostMod.stopOrphanRun(stalled.ctx, sid, { waitMs: 20 })
  assert.equal(unconfirmed.stopped, true)
  assert.equal(unconfirmed.confirmed, false, '未观察到静默不得谎报成功')
  assert.equal(unconfirmed.reason, 'timeout')
})

test('host half: 孤儿端点（GET 扫描 / POST 停止 / 方法与非法的拒绝）', async () => {
  const registered = []
  const host = { register: (entry) => { registered.push(entry); return () => {} } }
  const sid = 'ffffffff-1111-2222-3333-444444444444'
  const headers = [{ id: sid, origin: 'subagent', parentSession: 'gone' }]
  const events = { [sid]: [{ type: 'turn/end', seq: 7, time: 900 }] }
  const agent = makeOrphanAgent({ idle: true })
  const { ctx } = makeOrphanCtx({ headers, events, agents: { [sid]: agent } })
  ctx.effect = (fn) => { const dispose = fn(); return dispose || (() => {}) }
  hostMod.registerHttp(ctx, host)
  const list = registered.find((entry) => entry.path === hostMod.ORPHANS_PATH)
  const stop = registered.find((entry) => entry.path === hostMod.ORPHANS_STOP_PATH)
  assert.ok(list && stop, '两个孤儿端点都注册了')
  const resList = { writeHead: (status) => { resList.status = status }, end: (body) => { resList.body = body } }
  await list.handler({ method: 'GET' }, resList)
  assert.equal(resList.status, 200)
  const body = JSON.parse(resList.body)
  assert.equal(body.count, 1)
  assert.equal(body.orphans[0].id, sid)
  const res405 = { writeHead: (status) => { res405.status = status }, end: (body) => { res405.body = body } }
  await list.handler({ method: 'POST' }, res405)
  assert.equal(res405.status, 405)
  const postReq = (payload) => ({
    method: 'POST',
    on: (event, cb) => { if (event === 'data') cb(JSON.stringify(payload)); if (event === 'end') cb() },
    destroy: () => {},
  })
  const resEmpty = { writeHead: (status) => { resEmpty.status = status }, end: (body) => { resEmpty.body = body } }
  await stop.handler(postReq({ ids: [] }), resEmpty)
  assert.equal(resEmpty.status, 400)
  const resBad = { writeHead: (status) => { resBad.status = status }, end: (body) => { resBad.body = body } }
  await stop.handler(postReq({ ids: ['nope'] }), resBad)
  assert.equal(resBad.status, 400)
  const resStop = { writeHead: (status) => { resStop.status = status }, end: (body) => { resStop.body = body } }
  await stop.handler(postReq({ ids: [sid] }), resStop)
  assert.equal(resStop.status, 200)
  const stopBody = JSON.parse(resStop.body)
  assert.equal(stopBody.ok, true)
  assert.equal(stopBody.stopped, 1)
  assert.equal(stopBody.results[0].id, sid)
})

test('host half: settings field and endpoint constants are stable', () => {
  assert.equal(hostMod.NS, 'esc-rewind')
  assert.equal(hostMod.SETTINGS_FIELD, 'deleteOldOnRewind')
  assert.equal(hostMod.DEFAULT_DELETE_OLD, false)
  assert.equal(hostMod.DELETE_PATH, '/__esc-rewind/session/delete')
  assert.equal(hostMod.STATUS_PATH, '/__esc-rewind/status')
  assert.deepEqual(hostMod.sessionIdVariants('aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'),
    ['aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee', 'session-aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'])
  assert.equal(hostMod.BLOCK_REASON_CHILDREN, 'subagents')
  assert.equal(hostMod.BLOCK_REASON_UNKNOWN, 'subagents-unknown')
  assert.equal(hostMod.ORPHANS_PATH, '/__esc-rewind/orphans')
  assert.equal(hostMod.ORPHANS_STOP_PATH, '/__esc-rewind/orphans/stop')
})

test('host half: fallback schema registers the namespace without schemastery', async () => {
  const { pathToFileURL } = await import('node:url')
  // In the test environment @deepseek-ai/schemastery cannot resolve from the
  // plugin dir (same as an external link: bundle in a real host), so
  // installSettingsSection must register through the zero-dep fallback schema.
  let installed = null
  const fakeSettings = {
    installSection: (owner, ns, Config, entry, hooks) => {
      installed = { owner, ns, Config, entry, hooks }
      hooks.setSource(() => entry)
    },
  }
  // Wait for the dynamic schemastery import to fail and the fallback to run.
  await new Promise((r) => setTimeout(r, 150))
  // Re-run through a tiny driver: export installSettingsSection? Not exported;
  // drive the public apply() with a settings service present.
  const hostCtx = {
    get: (name) => (name === 'settings' ? fakeSettings : name === 'webServer' || name === 'tools' ? undefined : undefined),
    effect: () => () => {},
    inject: () => () => {},
  }
  const exports = await import(pathToFileURL(path.join(here, '..', 'src', 'index.js')).href)
  exports.apply(hostCtx)
  await new Promise((r) => setTimeout(r, 200)) // dynamic import settle
  assert.ok(installed, 'installSection was called despite schemastery being unresolvable')
  assert.equal(installed.ns, 'esc-rewind')
  // The fallback schema must validate+default like z.boolean().default(false).
  assert.equal(installed.Config({})[hostMod.SETTINGS_FIELD], false, 'default false')
  assert.equal(installed.Config({ deleteOldOnRewind: true })[hostMod.SETTINGS_FIELD], true, 'true passes through')
  assert.equal(typeof installed.Config.toJSON, 'function', 'serializable for describe')
  assert.equal(exports.HOST_DIAG.settingsSectionRegistered, true, 'diag reports registered')
})

test('host half: registerHttp serves status + delete, rejecting wrong method/missing id', async () => {
  const registered = []
  const host = {
    register: (entry) => { registered.push(entry); return () => {} },
  }
  // cordis ctx.effect runs the registration callback immediately.
  const ctx = { get: () => undefined, effect: (fn) => { const dispose = fn(); return dispose || (() => {}) } }
  hostMod.registerHttp(ctx, host)
  assert.equal(registered.length, 5, 'status + delete + orphans + orphans/stop + orphans/delete registered')
  assert.ok(registered.find((e) => e.path === hostMod.ORPHANS_PATH), 'orphan scan endpoint registered')
  assert.ok(registered.find((e) => e.path === hostMod.ORPHANS_STOP_PATH), 'orphan stop endpoint registered')
  assert.ok(registered.find((e) => e.path === hostMod.ORPHANS_DELETE_PATH), 'orphan delete endpoint registered')
  const status = registered.find((e) => e.path === hostMod.STATUS_PATH)
  const del = registered.find((e) => e.path === hostMod.DELETE_PATH)
  assert.ok(status && del, 'both endpoints present')
  assert.equal(status.kind, 'exact')
  assert.equal(del.kind, 'exact')
  // Status probe answers GET with diagnostics (no mutation).
  const resStatus = { writeHead: (s, h) => { resStatus.status = s }, end: (b) => { resStatus.body = b } }
  await status.handler({ method: 'GET' }, resStatus)
  assert.equal(resStatus.status, 200)
  assert.match(resStatus.body, /settingsSectionRegistered/)
  // Wrong method → 405 on the delete endpoint.
  const res405 = { writeHead: (s, h) => { res405.status = s }, end: (b) => { res405.body = b } }
  await del.handler({ method: 'GET' }, res405)
  assert.equal(res405.status, 405)
  // Missing sessionId → 400.
  const res400 = { writeHead: (s, h) => { res400.status = s }, end: (b) => { res400.body = b } }
  const req400 = { on: (ev, cb) => { if (ev === 'end') cb() }, destroy: () => {} }
  await del.handler({ method: 'POST' }, res400)
  assert.equal(res400.status, 400)
})

test('host half: 端点把子代理守卫的拒绝透传给客户端（409 + reason/计数，先于任何磁盘动作）', async () => {
  const registered = []
  const host = { register: (entry) => { registered.push(entry); return () => {} } }
  const sid = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  const ctx = {
    get: (name) => name === 'subagents'
      ? { listChildren: async () => [{ kind: 'child', id: sid + '-child', activity: 'running' }] }
      : undefined,
    effect: (fn) => { const dispose = fn(); return dispose || (() => {}) },
  }
  hostMod.registerHttp(ctx, host)
  const del = registered.find((e) => e.path === hostMod.DELETE_PATH)
  const res = { writeHead: (status) => { res.status = status }, end: (body) => { res.body = body } }
  const req = {
    method: 'POST',
    on: (event, cb) => { if (event === 'data') cb(JSON.stringify({ sessionId: sid })); if (event === 'end') cb() },
    destroy: () => {},
  }
  await del.handler(req, res)
  assert.equal(res.status, 409)
  const body = JSON.parse(res.body)
  assert.equal(body.reason, 'subagents')
  assert.equal(body.children, 1)
  assert.equal(body.running, 1)
  assert.match(body.error, /subagent/)
})

test('host half: 孤儿删除端点——逐项受守卫真删，拒绝如实回报（不级联，未受守卫的真删）', async () => {
  const registered = []
  const host = { register: (entry) => { registered.push(entry); return () => {} } }
  const blockedId = 'aaaaaaaa-bbbb-cccc-dddd-eeeeeeeeeeee'
  const okId = '11111111-2222-3333-4444-555555555555'
  const children = { [blockedId]: [{ kind: 'child', id: blockedId + '-kid', activity: 'running' }] }
  const ctx = {
    get: (name) => {
      if (name === 'subagents') return { listChildren: async (parent) => children[parent] || [] }
      if (name === 'agents') return { get: () => undefined }
      return undefined
    },
    effect: (fn) => { const dispose = fn(); return dispose || (() => {}) },
  }
  const previousHome = process.env.DSH_HOME
  const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsew-orphan-del-'))
  process.env.DSH_HOME = tmpHome
  try {
    const slug = path.join(tmpHome, 'sessions', 'myslug')
    fs.mkdirSync(path.join(slug, okId), { recursive: true })
    fs.writeFileSync(path.join(slug, okId, 'session.jsonl'), '{}')
    hostMod.registerHttp(ctx, host)
    const endpoint = registered.find((e) => e.path === hostMod.ORPHANS_DELETE_PATH)
    const call = async (body) => {
      const res = { writeHead: (status) => { res.status = status }, end: (payload) => { res.body = payload } }
      const req = {
        method: 'POST',
        on: (event, cb) => { if (event === 'data') cb(JSON.stringify(body)); if (event === 'end') cb() },
        destroy: () => {},
      }
      await endpoint.handler(req, res)
      return { status: res.status, body: res.body ? JSON.parse(res.body) : null }
    }
    assert.equal((await call({ ids: [] })).status, 400, 'empty ids rejected')
    assert.equal((await call({ ids: ['not-an-id'] })).status, 400, 'invalid id rejected')
    const guarded = await call({ ids: [blockedId] })
    assert.equal(guarded.status, 200)
    assert.equal(guarded.body.results[0].deleted, false)
    assert.equal(guarded.body.results[0].reason, 'subagents', 'guard reason surfaced verbatim')
    assert.equal(guarded.body.results[0].children, 1, 'child count surfaced')
    assert.equal(guarded.body.deleted, 0)
    assert.equal(guarded.body.blocked, 1)
    assert.equal(fs.existsSync(path.join(slug, blockedId)), false, 'refusal happens before any disk action')
    const done = await call({ ids: [okId] })
    assert.equal(done.body.results[0].deleted, true, 'an unguarded orphan really is deleted')
    assert.equal(done.body.deleted, 1)
    assert.equal(hostMod.findSessionDirs(okId, path.join(tmpHome, 'sessions')).length, 0, 'log dir gone')
  } finally {
    if (previousHome === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previousHome
    fs.rmSync(tmpHome, { recursive: true, force: true })
  }
})

// --- settings reader shapes (guards a real cordis ctx puts on the surface) ----

test('settings reader: a guarded ctx whose bare `settings` read THROWS still binds', () => {
  applyWith(makeServices())
  const reader = internals()._module.readRemoteSettings
  const controller = { describe: async () => ({ ok: true, value: { namespaces: [] } }) }
  // Real guard shape: an uninjected bare property read throws, while the
  // service actually lives at scope.remote.settings.
  const guarded = {
    get settings() { throw new Error('cannot get property "settings" without inject') },
    get remote() { return { settings: controller, $on: () => () => {} } },
  }
  assert.equal(reader(guarded), controller, 'resolves through scope.remote.settings')
  // Same via get('remote.settings').
  const viaGet = { get: (name) => { if (name === 'remote.settings') return controller; throw new Error('no such service: ' + name) } }
  assert.equal(reader(viaGet), controller, 'resolves through get("remote.settings")')
  // Same via the get('remote') root.
  const viaRoot = { get: (name) => { if (name === 'remote') return { settings: controller }; throw new Error('nope') } }
  assert.equal(reader(viaRoot), controller, 'resolves through the remote root')
  // Nothing reachable → null, never a throw.
  const empty = {
    get settings() { throw new Error('guarded') },
    get remote() { throw new Error('guarded') },
    get() { throw new Error('guarded') },
  }
  assert.equal(reader(empty), null, 'all candidates throwing degrades to null')
})

test('settings envelope: ok:true unwraps the value, ok:false raises the message', () => {
  applyWith(makeServices())
  const unwrap = internals()._module.unwrapResult
  assert.deepEqual(unwrap({ ok: true, value: { namespaces: [{ ns: 'x' }] } }), { namespaces: [{ ns: 'x' }] })
  assert.throws(() => unwrap({ ok: false, error: { code: 'settings/rejected', message: 'no such namespace' } }), /no such namespace/)
  assert.deepEqual(unwrap({ namespaces: [] }), { namespaces: [] }, 'plain payloads pass through')
})

test('regression: applying with a guard-shaped ctx binds settings and toggles', async () => {
  const services = makeServices()
  services.seed('s1', { title: 'T' })
  const settingsService = services.settings
  const factory = factories.get(PKG_ID)
  const remoteRoot = { settings: settingsService, $on: () => () => {} }
  // Wrap the harness ctx in the guard shape the real runtime uses: only the
  // injected names answer, every other bare property or get() THROWS, and the
  // settings controller is reachable as `remote.settings` on that scope.
  const base = makeCtx(services)
  const registered = base.registered
  services.registered = registered
  const guardSlot = (name) => {
    if (name === 'remote') return remoteRoot
    if (name === 'remote.settings') return settingsService
    throw new Error('cannot get property "' + name + '" without inject')
  }
  const ctx = Object.assign({}, base, {
    get: (name) => {
      if (name === 'slots' || name === 'locale' || name === 'commandUi' || name === 'sessions' || name === 'workspaces' || name === 'conversation' || name === 'uiConversation') return base.get(name)
      return guardSlot(name)
    },
    inject: (names, cb) => {
      const sub = {
        get: guardSlot,
        get remote() { return remoteRoot },
        get settings() { throw new Error('cannot get property "settings" without inject') },
      }
      sub['remote.settings'] = settingsService
      cb(sub)
      return () => {}
    },
  })
  factory(requireStub).apply(ctx)
  assert.equal(registered.length, 2, 'overlay + header registered on a guard ctx（孤儿 tab 已休眠）')
  assert.equal(internals()._module.getSettings(), settingsService, 'settings controller bound through the guard shape')
  const env = mount({ services, sessionId: 's1', chat: chatOf([]) })
  toasts.length = 0
  const result = await internals()._module.setDeleteMode(true)
  assert.equal(result.ok, true, 'write succeeds when the controller is reachable')
  env.rerender()
  assert.ok(!toasts.some((text) => String(text).indexOf('settings-unavailable') !== -1), 'never claims settings-unavailable')
  assert.equal(internals()._module.deleteModeOn(), true)
})

// --- run ---------------------------------------------------------------------

let failed = 0
for (const [name, fn] of tests) {
  try {
    toasts.length = 0
    keydownHandler = null
    keydownCapture = null
    lsStore.clear()
    try { internals()._module.resetHistoryCache() } catch { /* module not bound yet */ }
    await fn()
    console.log('  ok  -', name)
  } catch (error) {
    failed += 1
    console.error('FAIL -', name)
    console.error(error && error.stack ? error.stack : error)
  }
}
console.log(`\n${tests.length - failed}/${tests.length} tests passed`)
process.exit(failed > 0 ? 1 : 0)
