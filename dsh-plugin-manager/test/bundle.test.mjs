// Behavioural harness for dsh-plugin-manager/src/client.js.
//
// Materializes the bundle the way @deepseek-ai/dsh-client-modules does —
// window.__ModuleLoader__.load({ id, factory }) then factory(require) — with a
// minimal deps-aware React shim and a stateful fetch stub, then asserts:
//   1. the bundle registers id 'dsh-plugin-manager';
//   2. apply() registers the 'local-plugins' tab (order 20) on the core
//      "Plugins" settings page (settings.plugins.tab);
//   3. rendering the section fetches /list and shows one row per plugin with
//      the right state text + controls;
//   4. toggling posts set-enabled and shows a reload hint for client plugins
//      (never an automatic reload);
//   5. legacy rows show the migrate banner and migrate asks for confirmation.
//
// It is a LOGIC harness, not a browser render: real React reconciliation, CSS
// variables and layout are approximated. Real-browser checks are listed in
// ACCEPTANCE.md.
//
// Run: node dsh-plugin-manager/test/bundle.test.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const bundlePath = path.join(here, '..', 'src', 'client.js')
const PKG_ID = 'dsh-plugin-manager'

// --- browser-ish globals -----------------------------------------------------

Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { languages: ['zh-CN'], language: 'zh-CN' },
})

const factories = new Map()
const fetchCalls = []
const confirms = []
let confirmAnswer = true
let reloaded = false
const windowObj = {
  __DSH_TEST__: true,
  location: { reload: () => { reloaded = true } },
  confirm: (msg) => { confirms.push(msg); return confirmAnswer },
}
windowObj.__ModuleLoader__ = { load: ({ id, factory }) => factories.set(id, factory) }
globalThis.window = windowObj
globalThis.document = { addEventListener() {}, removeEventListener() {} }

// Stateful server stub the bundle's `fetch` parameter talks to.
const BATCH_COUNTS = () => ({
  enable: { count: 1, needsInstall: 1, skippedLegacy: 0, skippedInactive: 1, skippedInvalid: 1 },
  disable: { count: 1, needsInstall: 0, skippedLegacy: 0, skippedInactive: 1, skippedInvalid: 1 },
  remove: { count: 1, needsInstall: 0, skippedLegacy: 0, skippedInactive: 0, skippedInvalid: 1 },
})
const state = {
  // 'ok' | 'http404' | 'badjson' | 'offline' — failure modes of the /list route.
  listMode: 'ok',
  legacyDetected: false,
  pendingWrites: 0,
  batchCounts: BATCH_COUNTS(),
  batchResults: null,
  repairPlan: { count: 0, manualCount: 0, auto: [], manual: [] },
  uninstall: {
    command: 'node "D:/repo/dsh-plugin-manager/tools/uninstall-manager.mjs" --profile web --yes',
    willRemove: { rows: 2, deps: 2, managerEntry: true, installs: true },
  },
  autoRelinkEnabled: true,
  relinkResult: { noop: false, relinked: ['dsh-aaa'], failed: [], ranPnpm: true },
  discardedIntents: 0,
  holdBatch: false,
  releaseBatch: null,
  plugins: [
    { dir: 'dsh-aaa', rowId: 'aaa', name: 'dsh-aaa', description: 'AAA plugin', valid: true, hasClient: true, state: 'active', active: true, legacyBundle: false },
    { dir: 'dsh-bbb', rowId: 'bbb', name: 'dsh-bbb', description: 'BBB plugin', valid: true, hasClient: true, state: 'uninstalled', active: false, legacyBundle: false },
    { dir: 'dsh-bad', rowId: 'bad', name: 'dsh-bad', description: '', valid: false, state: 'invalid', active: false, legacyBundle: false },
  ],
}
function payload() {
  return { ok: true, data: { repoRoot: 'D:/repo', pluginsRoot: 'D:/repo/sub-plugins', profileName: 'web', legacyDetected: state.legacyDetected, plugins: state.plugins, batchCounts: state.batchCounts, repairPlan: state.repairPlan, autoRelinkEnabled: state.autoRelinkEnabled, uninstall: state.uninstall } }
}
async function fetchStub(url, opts) {
  fetchCalls.push({ url, opts })
  if (url === '/__dsh-plugin-manager/list') {
    // The host half can be missing while the client half is loaded: DSH then answers
    // the plugin prefix route with 404 and an EMPTY body.
    if (state.listMode === 'offline') throw new Error('Failed to fetch')
    if (state.listMode === 'http404') {
      return { ok: false, status: 404, json: async () => { throw new SyntaxError("Failed to execute 'json' on 'Response': Unexpected end of JSON input") } }
    }
    if (state.listMode === 'badjson') {
      return { ok: false, status: 502, json: async () => { throw new SyntaxError('Unexpected token < in JSON') } }
    }
    return { ok: true, json: async () => payload() }
  }
  if (url === '/__dsh-plugin-manager/status') {
    return { ok: true, json: async () => ({ ok: true, pendingWrites: state.pendingWrites || 0, lastFlushError: null }) }
  }
  if (url === '/__dsh-plugin-manager/set-enabled') {
    const body = JSON.parse((opts && opts.body) || '{}')
    const p = state.plugins.find((x) => x.dir === body.dir)
    if (p) {
      p.active = body.enabled !== false
      p.state = p.active ? 'active' : 'disabled'
    }
    return { ok: true, json: async () => payload() }
  }
  if (url === '/__dsh-plugin-manager/repair') {
    const res = payload()
    res.relink = state.relinkResult
    // A real repair fixes what it can: the panel re-renders from the next payload.
    if (state.relinkResult && state.relinkResult.noop !== true) {
      state.repairPlan = { count: 0, manualCount: state.repairPlan.manualCount, auto: [], manual: state.repairPlan.manual }
    }
    return { ok: true, json: async () => res }
  }
  if (url === '/__dsh-plugin-manager/set-all-enabled') {
    const body = JSON.parse((opts && opts.body) || '{}')
    const enabled = body.enabled !== false
    const respond = () => {
      state.plugins = state.plugins.map((p) => (p.state === 'invalid' ? p : { ...p, active: enabled, state: enabled ? 'active' : 'disabled' }))
      const res = payload()
      const results = state.batchResults || []
      res.results = results
      res.counts = {
        total: results.length,
        applied: results.filter((r) => r.outcome === 'applied').length,
        skipped: results.filter((r) => r.outcome === 'skipped').length,
        failed: results.filter((r) => r.outcome === 'failed').length,
        installed: 0,
        ranPnpm: false,
        wrotePatch: true,
      }
      return { ok: true, json: async () => res }
    }
    // Deferred mode lets a test observe the panel while the batch is in flight.
    if (state.holdBatch) return new Promise((resolve) => { state.releaseBatch = () => resolve(respond()) })
    return respond()
  }
  if (url === '/__dsh-plugin-manager/remove-all') {
    const respond = () => {
      // 全部移除后：每个有痕迹的项都回到「未激活」，依赖键也没了。
      state.plugins = state.plugins.map((p) => (p.installed || p.hasRow ? { ...p, state: 'uninstalled', active: false, installed: false, hasRow: false } : p))
      const res = payload()
      res.results = state.batchResults || []
      res.discardedIntents = state.discardedIntents || 0
      res.counts = {
        total: res.results.length,
        applied: res.results.filter((r) => r.outcome === 'applied').length,
        skipped: res.results.filter((r) => r.outcome === 'skipped').length,
        failed: res.results.filter((r) => r.outcome === 'failed').length,
        installed: 0,
        ranPnpm: true,
        wrotePatch: true,
      }
      return { ok: true, json: async () => res }
    }
    if (state.holdBatch) return new Promise((resolve) => { state.releaseBatch = () => resolve(respond()) })
    return respond()
  }
  if (url === '/__dsh-plugin-manager/remove') {
    const body = JSON.parse((opts && opts.body) || '{}')
    state.plugins = state.plugins.filter((x) => x.dir !== body.dir)
    return { ok: true, json: async () => payload() }
  }
  if (url === '/__dsh-plugin-manager/migrate') {
    state.legacyDetected = false
    state.plugins = state.plugins.map((p) => (p.state === 'legacy' ? { ...p, state: 'active', active: true, legacyBundle: false } : p))
    return { ok: true, json: async () => payload() }
  }
  return { ok: false, json: async () => ({ ok: false, error: 'not found' }) }
}

// --- minimal React shim ------------------------------------------------------

function sameDeps(a, b) {
  if (a === b) return true
  if (!Array.isArray(a) || !Array.isArray(b) || a.length !== b.length) return false
  for (let i = 0; i < a.length; i += 1) if (a[i] !== b[i]) return false
  return true
}

function makeReact() {
  let slots = []
  let index = 0
  const React = {
    createElement: (type, props, ...children) => ({
      __element: true,
      type,
      props: { ...(props || {}), children: children.length === 1 ? children[0] : children },
    }),
    Fragment: Symbol('Fragment'),
    useState(initial) {
      const i = index++
      if (!(i in slots)) slots[i] = { value: typeof initial === 'function' ? initial() : initial }
      const slot = slots[i]
      return [slot.value, (next) => {
        const v = typeof next === 'function' ? next(slot.value) : next
        slot.value = v
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
  }
  return {
    React,
    begin() { index = 0 },
    fresh() { slots = []; index = 0 },
  }
}

const { React, begin, fresh } = makeReact()
function requireStub(specifier) {
  if (specifier === 'react') return React
  throw new Error(`unexpected require("${specifier}")`)
}

// --- load the bundle ---------------------------------------------------------

const source = fs.readFileSync(bundlePath, 'utf8')
// eslint-disable-next-line no-new-func -- mirroring the browser classic-script evaluation
new Function('window', 'navigator', 'document', 'fetch', source)(
  globalThis.window, globalThis.navigator, globalThis.document, fetchStub,
)

const tests = []
const test = (name, fn) => tests.push([name, fn])

function factoryApi() {
  const factory = factories.get(PKG_ID)
  assert.ok(factory, `bundle did not register id "${PKG_ID}"`)
  return factory(requireStub)
}

// Mount helpers: get the section component via apply()/slots.
/** Mount one registration by slot name (the manager now owns a nav entry + its tabs). */
function mountSection(target = 'settings.localPlugins.tab') {
  const api = factoryApi()
  const pending = []
  const registered = []
  const slots = {
    inject: (name, cb) => { pending.push({ name, cb }) },
    // Mirror the real registry entry shape: .options (ledger) + .opts (assertions).
    register: (opts, comp) => { registered.push({ opts, comp, options: opts, component: comp }); return { dispose() {} } },
    entries: (name) => registered.filter((e) => e.options.name === name),
    subscribe: () => () => {},
  }
  api.apply({ slots })
  for (const item of pending) item.cb()
  const found = registered.find((entry) => entry.opts.name === target)
  assert.ok(found, 'registered slot: ' + target)
  return found.comp
}

// Walking helpers.
function walk(node, pred, out = []) {
  if (!node || typeof node !== 'object') return out
  if (node.__element) {
    if (pred(node)) out.push(node)
    const ch = node.props && node.props.children
    if (Array.isArray(ch)) for (const c of ch) walk(c, pred, out)
    else if (ch && typeof ch === 'object') walk(ch, pred, out)
  }
  return out
}
const byType = (tree, type) => walk(tree, (n) => n.type === type)
const textOf = (node) => {
  const parts = []
  const collect = (n) => {
    if (typeof n === 'string' || typeof n === 'number') { parts.push(String(n)); return }
    // Nested children arrays (a .map() inside a children list) must be walked
    // too — otherwise their text silently disappears from the assertion input.
    if (Array.isArray(n)) { n.forEach(collect); return }
    if (n && n.__element) {
      const ch = n.props && n.props.children
      if (Array.isArray(ch)) ch.forEach(collect)
      else if (ch !== undefined && ch !== null) collect(ch)
    }
  }
  collect(node)
  return parts.join('')
}
const flush = () => new Promise((resolve) => setImmediate(resolve))

// --- tests -------------------------------------------------------------------

test('an unregistered host route (HTTP 404, empty body) reports a human reason, never the JSON parse error', async () => {
  const section = mountSection()
  fresh()
  state.listMode = 'http404'
  try {
    section()
    await flush()
    begin()
    const texts = textOf(section())
    assert.match(texts, /404/, 'the panel surfaces the HTTP status')
    assert.match(texts, /重启 DSH/, 'and names the concrete fix')
    assert.match(texts, /__dsh-plugin-manager/, 'and names the missing route')
    assert.doesNotMatch(texts, /Unexpected end of JSON input/, 'the raw parse error never reaches the user')
  } finally {
    state.listMode = 'ok'
  }
})

test('a non-JSON response and an unreachable host each get their own readable reason', async () => {
  for (const [mode, expected] of [['badjson', /非 JSON 响应（HTTP 502）/], ['offline', /连接插件宿主失败/]]) {
    const section = mountSection()
    fresh()
    state.listMode = mode
    try {
      section()
      await flush()
      begin()
      assert.match(textOf(section()), expected, `mode ${mode}`)
    } finally {
      state.listMode = 'ok'
    }
  }
})

test('bundle owns the「本地插件」nav entry (order 16) and its own panel tab (order 0)', () => {
  const api = factoryApi()
  assert.deepEqual(api.inject, ['slots'])
  const pending = []
  const entry = []
  const slots = {
    inject: (name, cb) => { pending.push(cb) },
    register: (opts, comp) => entry.push({ opts, comp }),
  }
  api.apply({ slots })
  for (const cb of pending) cb()
  assert.equal(entry.length, 2, 'nav entry + the manager panel tab')
  const nav = entry.find((e) => e.opts.name === 'settings.section')
  assert.ok(nav, 'registers the local-plugins settings section')
  assert.equal(nav.opts.id, 'local-plugins')
  assert.equal(nav.opts.order, 16)
  assert.equal(nav.opts.label(), '本地插件')
  assert.equal(nav.opts.children['settings.localPlugins.tab'].kind, 'list', 'declares the tab child slot')
  const tab = entry.find((e) => e.opts.name === 'settings.localPlugins.tab')
  assert.ok(tab, 'the manager panel is one tab of the entry')
  assert.equal(tab.opts.id, 'plugins')
  assert.equal(tab.opts.order, 0)
  assert.equal(typeof nav.comp, 'function', 'nav entry component is the tab chrome')
  assert.equal(typeof tab.comp, 'function', 'panel component registered as a tab')
})

test('the nav entry renders a tab bar over the declared child slot', async () => {
  const section = mountSection('settings.section')
  const calls = []
  fresh()
  begin()
  const tree = section({
    renderSlot: (name, owner, select) => { calls.push({ name, select }); return { __element: true, type: 'div', props: { children: 'slot:' + (select && select.only) } } },
  })
  const labels = byType(tree, 'button').map((b) => textOf(b))
  assert.deepEqual(labels, ['本地插件'], 'the tab bar lists the contributed tabs')
  assert.equal(tree.props.children.length >= 2, true, 'heading + tabs + panel')
  assert.deepEqual(calls, [{ name: 'settings.localPlugins.tab', select: { only: 'plugins' } }], 'the active tab mounts through renderSlot(..., { only })')
})

test('renders plugin rows from /list with state text and no auto reload', async () => {
  const section = mountSection()
  fresh()
  section()
  await flush()
  begin()
  const tree = section()
  const texts = textOf(tree)
  assert.match(texts, /dsh-aaa/)
  assert.match(texts, /dsh-bbb/)
  assert.match(texts, /dsh-bad/)
  assert.match(texts, /已激活/)
  assert.match(texts, /非插件目录/)
  assert.ok(fetchCalls.some((c) => c.url === '/__dsh-plugin-manager/list'), 'list fetched on mount')
  assert.equal(reloaded, false, 'no automatic reload on plain render')
})

test('header shows the repo root and the scanned plugins root (sub-plugins)', async () => {
  const section = mountSection()
  fresh()
  section()
  await flush()
  begin()
  const texts = textOf(section())
  assert.match(texts, /仓库目录/, 'repo root still shown')
  assert.match(texts, /子插件目录/, 'plugins root label rendered')
  assert.match(texts, /D:\/repo\/sub-plugins/, 'nested plugins root path shown')
})

test('toggling a client plugin posts set-enabled and shows a reload hint (no auto reload)', async () => {
  fetchCalls.length = 0
  const section = mountSection()
  fresh()
  section()
  await flush()
  begin()
  const tree = section()
  const switches = walk(tree, (n) => n.props && n.props.role === 'switch')
  assert.equal(switches.length, 2, 'one switch for aaa and bbb, none for the invalid row')
  const bbbEl = byType(tree, 'li').find((li) => /dsh-bbb/.test(textOf(li)))
  const bbbSwitch = walk(bbbEl, (n) => n.props && n.props.role === 'switch')[0]
  bbbSwitch.props.onClick()
  await flush()
  begin()
  const after = section()
  const setCalls = fetchCalls.filter((c) => c.url === '/__dsh-plugin-manager/set-enabled')
  assert.equal(setCalls.length, 1)
  assert.equal(JSON.parse(setCalls[0].opts.body).dir, 'dsh-bbb')
  assert.equal(JSON.parse(setCalls[0].opts.body).enabled, true)
  assert.match(textOf(after), /刷新页面使界面生效/, 'reload hint shown after client-plugin toggle')
  assert.equal(reloaded, false, 'no automatic reload after toggle')
})

test('shows 「正在应用」 while the host still owes a write, without locking other rows', async () => {
  fetchCalls.length = 0
  const pump = async () => { for (let i = 0; i < 8; i += 1) await flush() }

  state.pendingWrites = 1
  const section = mountSection()
  fresh()
  section()
  await flush()
  begin()
  let tree = section()
  const bbbEl = byType(tree, 'li').find((li) => /dsh-bbb/.test(textOf(li)))
  walk(bbbEl, (n) => n.props && n.props.role === 'switch')[0].props.onClick()
  await pump()
  begin()
  tree = section()
  assert.ok(
    fetchCalls.some((c) => c.url === '/__dsh-plugin-manager/status'),
    'host is probed for unflushed writes',
  )
  assert.match(textOf(tree), /正在应用/, 'applying banner while the queued write is not on disk yet')
  const aaaSwitch = walk(byType(tree, 'li').find((li) => /dsh-aaa/.test(textOf(li))), (n) => n.props && n.props.role === 'switch')[0]
  assert.ok(!aaaSwitch.props.disabled, 'other rows stay clickable so the host can merge the burst')

  // Host drains the queue: the banner must clear on its own (no manual refresh).
  state.pendingWrites = 0
  await new Promise((resolve) => setTimeout(resolve, 400))
  await pump()
  begin()
  assert.doesNotMatch(textOf(section()), /正在应用/, 'banner clears once pendingWrites is back to zero')
})

test('legacy rows show migrate banner; migrate asks confirmation', async () => {
  fetchCalls.length = 0
  confirms.length = 0
  state.legacyDetected = true
  state.plugins = [
    { dir: 'dsh-old', rowId: 'old', name: 'dsh-old', description: 'old', valid: true, hasClient: false, state: 'legacy', active: true, legacyBundle: true },
  ]
  const section = mountSection()
  fresh()
  section()
  await flush()
  begin()
  const tree = section()
  const texts = textOf(tree)
  assert.match(texts, /一键接管/, 'migrate banner visible when legacy detected')
  assert.match(texts, /旧布局/)
  const migrateBtn = byType(tree, 'button').find((b) => /一键接管/.test(textOf(b)))
  migrateBtn.props.onClick()
  await flush()
  assert.ok(confirms.length >= 1, 'migrate asks for confirmation')
  assert.ok(fetchCalls.some((c) => c.url === '/__dsh-plugin-manager/migrate'), 'migrate endpoint called')
  assert.equal(reloaded, false, 'migrate does not auto-reload')
  // restore baseline state
  state.legacyDetected = false
  state.plugins = [
    { dir: 'dsh-aaa', rowId: 'aaa', name: 'dsh-aaa', description: 'AAA plugin', valid: true, hasClient: true, state: 'active', active: true, legacyBundle: false },
    { dir: 'dsh-bbb', rowId: 'bbb', name: 'dsh-bbb', description: 'BBB plugin', valid: true, hasClient: true, state: 'uninstalled', active: false, legacyBundle: false },
    { dir: 'dsh-bad', rowId: 'bad', name: 'dsh-bad', description: '', valid: false, state: 'invalid', active: false, legacyBundle: false },
  ]
})

// --- batch switch (全部开启 / 全部关闭) -------------------------------------

test('batch toolbar renders all three buttons with the host-provided counts', async () => {
  fetchCalls.length = 0
  state.batchCounts = BATCH_COUNTS()
  state.batchResults = null
  state.plugins = [
    { dir: 'dsh-aaa', rowId: 'aaa', name: 'dsh-aaa', description: 'AAA plugin', valid: true, hasClient: true, state: 'active', active: true, legacyBundle: false },
    { dir: 'dsh-bbb', rowId: 'bbb', name: 'dsh-bbb', description: 'BBB plugin', valid: true, hasClient: true, state: 'uninstalled', active: false, legacyBundle: false },
    { dir: 'dsh-bad', rowId: 'bad', name: 'dsh-bad', description: '', valid: false, state: 'invalid', active: false, legacyBundle: false },
  ]
  const section = mountSection()
  fresh()
  section()
  await flush()
  begin()
  const tree = section()
  const enableBtn = byType(tree, 'button').find((b) => /全部开启/.test(textOf(b)))
  const disableBtn = byType(tree, 'button').find((b) => /全部关闭/.test(textOf(b)))
  const removeBtn = byType(tree, 'button').find((b) => /全部移除/.test(textOf(b)))
  assert.ok(enableBtn && disableBtn && removeBtn, 'all three batch buttons render in the toolbar')
  assert.equal(textOf(enableBtn), '全部开启 (1)', 'count comes from /list batchCounts, not from the panel')
  assert.equal(textOf(disableBtn), '全部关闭 (1)')
  assert.equal(textOf(removeBtn), '全部移除 (1)', 'the removal count comes from batchCounts.remove')
  assert.ok(!enableBtn.props.disabled && !disableBtn.props.disabled && !removeBtn.props.disabled)

  // N = 0 → greyed out, so an empty batch can never be fired.
  state.batchCounts = {
    enable: { count: 0, needsInstall: 0, skippedLegacy: 0, skippedInactive: 1, skippedInvalid: 1 },
    disable: { count: 0, needsInstall: 0, skippedLegacy: 0, skippedInactive: 1, skippedInvalid: 1 },
    remove: { count: 0, needsInstall: 0, skippedLegacy: 0, skippedInactive: 0, skippedInvalid: 1 },
  }
  const section2 = mountSection()
  fresh()
  section2()
  await flush()
  begin()
  const tree2 = section2()
  const enable2 = byType(tree2, 'button').find((b) => /全部开启/.test(textOf(b)))
  const disable2 = byType(tree2, 'button').find((b) => /全部关闭/.test(textOf(b)))
  const remove2 = byType(tree2, 'button').find((b) => /全部移除/.test(textOf(b)))
  assert.equal(textOf(enable2), '全部开启 (0)')
  assert.ok(enable2.props.disabled, 'enable-all is greyed out at N=0')
  assert.ok(disable2.props.disabled, 'disable-all is greyed out at N=0')
  assert.ok(remove2.props.disabled, 'remove-all is greyed out at N=0')
  state.batchCounts = BATCH_COUNTS()
})

test('全部关闭 confirms with the count, posts the batch endpoint and hints a reload', async () => {
  fetchCalls.length = 0
  confirms.length = 0
  reloaded = false
  confirmAnswer = true
  state.batchResults = [
    { dir: 'dsh-aaa', name: 'dsh-aaa', hasClient: true, outcome: 'applied', reason: null },
    { dir: 'dsh-bbb', name: 'dsh-bbb', hasClient: true, outcome: 'applied', reason: null },
    { dir: 'dsh-old', name: 'dsh-old', hasClient: false, outcome: 'skipped', reason: 'legacy-layout' },
  ]
  state.batchCounts = {
    enable: { count: 1, needsInstall: 1, skippedLegacy: 0, skippedInactive: 1, skippedInvalid: 1 },
    disable: { count: 2, needsInstall: 0, skippedLegacy: 1, skippedInactive: 0, skippedInvalid: 1 },
  }
  state.plugins = [
    { dir: 'dsh-aaa', rowId: 'aaa', name: 'dsh-aaa', description: 'AAA plugin', valid: true, hasClient: true, state: 'active', active: true, legacyBundle: false },
    { dir: 'dsh-bbb', rowId: 'bbb', name: 'dsh-bbb', description: 'BBB plugin', valid: true, hasClient: true, state: 'uninstalled', active: false, legacyBundle: false },
    { dir: 'dsh-bad', rowId: 'bad', name: 'dsh-bad', description: '', valid: false, state: 'invalid', active: false, legacyBundle: false },
  ]
  const section = mountSection()
  fresh()
  section()
  await flush()
  begin()
  const btn = byType(section(), 'button').find((b) => /全部关闭/.test(textOf(b)))
  assert.equal(textOf(btn), '全部关闭 (2)')
  btn.props.onClick()
  await flush()
  await flush()
  assert.equal(confirms.length, 1, 'the batch asks for confirmation exactly once')
  assert.match(confirms[0], /2/, 'the confirmation carries the affected count')
  assert.match(confirms[0], /旧布局/, 'the confirmation warns about skipped legacy rows')
  const calls = fetchCalls.filter((c) => c.url === '/__dsh-plugin-manager/set-all-enabled')
  assert.equal(calls.length, 1)
  assert.equal(JSON.parse(calls[0].opts.body).enabled, false)
  begin()
  const after = textOf(section())
  assert.match(after, /已停用 2 个本地插件/, 'notice reports how many rows were disabled')
  assert.match(after, /旧布局/, 'the legacy skip is surfaced in the notice too')
  assert.match(after, /刷新页面使界面生效/, 'a client plugin was touched → reload hint')
  assert.equal(reloaded, false, 'never auto-reloads')
  state.batchResults = null
  state.batchCounts = BATCH_COUNTS()
})

test('全部移除 confirms with the count, posts /remove-all and reports discarded intents', async () => {
  fetchCalls.length = 0
  confirms.length = 0
  reloaded = false
  confirmAnswer = true
  state.discardedIntents = 1
  state.batchCounts = {
    enable: { count: 1, needsInstall: 1, skippedLegacy: 0, skippedInactive: 1, skippedInvalid: 1 },
    disable: { count: 0, needsInstall: 0, skippedLegacy: 0, skippedInactive: 1, skippedInvalid: 1 },
    remove: { count: 2, needsInstall: 0, skippedLegacy: 1, skippedInactive: 0, skippedInvalid: 1 },
  }
  state.batchResults = [
    { dir: 'dsh-aaa', name: 'dsh-aaa', hasClient: true, outcome: 'applied', reason: null },
    { dir: 'dsh-bbb', name: 'dsh-bbb', hasClient: false, outcome: 'applied', reason: null },
    { dir: 'dsh-old', name: 'dsh-old', hasClient: false, outcome: 'skipped', reason: 'legacy-layout' },
  ]
  state.plugins = [
    { dir: 'dsh-aaa', rowId: 'aaa', name: 'dsh-aaa', description: 'AAA plugin', valid: true, hasClient: true, state: 'active', active: true, installed: true, hasRow: true, legacyBundle: false },
    { dir: 'dsh-bbb', rowId: 'bbb', name: 'dsh-bbb', description: 'BBB plugin', valid: true, hasClient: false, state: 'disabled', active: false, installed: true, hasRow: true, legacyBundle: false },
    { dir: 'dsh-bad', rowId: 'bad', name: 'dsh-bad', description: '', valid: false, state: 'invalid', active: false, legacyBundle: false },
  ]
  const section = mountSection()
  fresh()
  section()
  await flush()
  begin()
  const btn = byType(section(), 'button').find((b) => /全部移除/.test(textOf(b)))
  assert.equal(textOf(btn), '全部移除 (2)')
  btn.props.onClick()
  await flush()
  await flush()
  assert.equal(confirms.length, 1, 'the removal asks for confirmation exactly once')
  assert.match(confirms[0], /2/, 'the confirmation carries the affected count')
  assert.match(confirms[0], /源码目录保留/, 'the confirmation spells out the consequence')
  assert.match(confirms[0], /旧布局/, 'the confirmation warns about skipped legacy rows')
  const calls = fetchCalls.filter((c) => c.url === '/__dsh-plugin-manager/remove-all')
  assert.equal(calls.length, 1, 'the removal posts the dedicated endpoint')
  assert.deepEqual(JSON.parse(calls[0].opts.body || '{}'), {}, 'no enabled flag is sent to a removal')
  begin()
  const after = textOf(section())
  assert.match(after, /已移除 2 个本地插件的激活行与依赖/, 'notice reports how many were removed')
  assert.match(after, /1 次未落盘的开关操作随行一起作废/, 'discarded intents are surfaced, never silent')
  assert.match(after, /旧布局/, 'the legacy skip is surfaced in the notice too')
  assert.match(after, /刷新页面使界面生效/, 'a client plugin was touched → reload hint')
  assert.equal(reloaded, false, 'never auto-reloads')
  state.batchResults = null
  state.discardedIntents = 0
  state.batchCounts = BATCH_COUNTS()
})

test('cancelling the batch confirmation sends nothing', async () => {
  fetchCalls.length = 0
  confirms.length = 0
  confirmAnswer = false
  state.plugins = [
    { dir: 'dsh-aaa', rowId: 'aaa', name: 'dsh-aaa', description: 'AAA plugin', valid: true, hasClient: true, state: 'active', active: true, legacyBundle: false },
    { dir: 'dsh-bbb', rowId: 'bbb', name: 'dsh-bbb', description: 'BBB plugin', valid: true, hasClient: true, state: 'uninstalled', active: false, legacyBundle: false },
    { dir: 'dsh-bad', rowId: 'bad', name: 'dsh-bad', description: '', valid: false, state: 'invalid', active: false, legacyBundle: false },
  ]
  state.batchCounts = {
    enable: { count: 1, needsInstall: 1, skippedLegacy: 0, skippedInactive: 1, skippedInvalid: 1 },
    disable: { count: 1, needsInstall: 0, skippedLegacy: 0, skippedInactive: 1, skippedInvalid: 1 },
  }
  const section = mountSection()
  fresh()
  section()
  await flush()
  begin()
  byType(section(), 'button').find((b) => /全部关闭/.test(textOf(b))).props.onClick()
  await flush()
  assert.equal(confirms.length, 1)
  assert.equal(fetchCalls.filter((c) => c.url.indexOf('set-all-enabled') >= 0).length, 0, 'cancel sends no request')
  confirmAnswer = true
  state.batchCounts = BATCH_COUNTS()
})

test('the panel locks rows and migrate while a batch is still in flight', async () => {
  fetchCalls.length = 0
  confirms.length = 0
  confirmAnswer = true
  state.legacyDetected = true
  state.holdBatch = true
  state.releaseBatch = null
  state.plugins = [
    { dir: 'dsh-aaa', rowId: 'aaa', name: 'dsh-aaa', description: 'AAA plugin', valid: true, hasClient: true, state: 'active', active: true, legacyBundle: false },
    { dir: 'dsh-bbb', rowId: 'bbb', name: 'dsh-bbb', description: 'BBB plugin', valid: true, hasClient: true, state: 'uninstalled', active: false, legacyBundle: false },
    { dir: 'dsh-bad', rowId: 'bad', name: 'dsh-bad', description: '', valid: false, state: 'invalid', active: false, legacyBundle: false },
  ]
  state.batchCounts = {
    enable: { count: 1, needsInstall: 1, skippedLegacy: 0, skippedInactive: 1, skippedInvalid: 1 },
    disable: { count: 1, needsInstall: 0, skippedLegacy: 0, skippedInactive: 1, skippedInvalid: 1 },
  }
  const section = mountSection()
  fresh()
  section()
  await flush()
  begin()
  byType(section(), 'button').find((b) => /全部关闭/.test(textOf(b))).props.onClick()
  await flush()
  begin()
  const during = section()
  assert.match(textOf(during), /处理中…/, 'the batch button reports progress while in flight')
  const switches = walk(during, (n) => n.props && n.props.role === 'switch')
  assert.ok(switches.length >= 1)
  assert.ok(switches.every((s) => s.props.disabled), 'every row switch is locked during the batch')
  const migrateBtn = byType(during, 'button').find((b) => /一键接管/.test(textOf(b)))
  assert.ok(migrateBtn && migrateBtn.props.disabled, 'migrate is locked during the batch too')
  const removeBtn = byType(during, 'button').find((b) => /全部移除/.test(textOf(b)))
  assert.ok(removeBtn && removeBtn.props.disabled, 'remove-all is locked during any batch')
  state.releaseBatch()
  await flush()
  await flush()
  begin()
  const after = section()
  assert.doesNotMatch(textOf(after), /处理中…/, 'lock is released once the batch settles')
  assert.ok(walk(after, (n) => n.props && n.props.role === 'switch').every((s) => !s.props.disabled))
  state.holdBatch = false
  state.releaseBatch = null
  state.legacyDetected = false
  state.batchCounts = BATCH_COUNTS()
})

test('batch failures are listed per plugin in the notice', async () => {
  fetchCalls.length = 0
  confirms.length = 0
  confirmAnswer = true
  state.batchCounts = {
    enable: { count: 1, needsInstall: 1, skippedLegacy: 0, skippedInactive: 0, skippedInvalid: 1 },
    disable: { count: 0, needsInstall: 0, skippedLegacy: 0, skippedInactive: 0, skippedInvalid: 1 },
  }
  state.batchResults = [
    { dir: 'dsh-aaa', name: 'dsh-aaa', hasClient: true, outcome: 'applied', reason: null },
    { dir: 'dsh-bbb', name: 'dsh-bbb', hasClient: true, outcome: 'failed', reason: 'install-failed', error: 'registry unreachable' },
  ]
  state.plugins = [
    { dir: 'dsh-aaa', rowId: 'aaa', name: 'dsh-aaa', description: 'AAA plugin', valid: true, hasClient: true, state: 'active', active: true, legacyBundle: false },
    { dir: 'dsh-bbb', rowId: 'bbb', name: 'dsh-bbb', description: 'BBB plugin', valid: true, hasClient: true, state: 'uninstalled', active: false, legacyBundle: false },
    { dir: 'dsh-bad', rowId: 'bad', name: 'dsh-bad', description: '', valid: false, state: 'invalid', active: false, legacyBundle: false },
  ]
  const section = mountSection()
  fresh()
  section()
  await flush()
  begin()
  byType(section(), 'button').find((b) => /全部开启/.test(textOf(b))).props.onClick()
  await flush()
  await flush()
  begin()
  const after = textOf(section())
  assert.match(after, /已开启 1 个本地插件/)
  assert.match(after, /失败 1 项/)
  assert.match(after, /dsh-bbb/, 'the failing plugin is named')
  assert.match(after, /registry unreachable/, 'the failure reason is shown, not just a count')
  state.batchResults = null
  state.batchCounts = BATCH_COUNTS()
})

test('pure helper exports map every state', () => {
  factoryApi()
  const t = windowObj.__dshPluginManagerTest
  assert.ok(t, 'test hooks exported')
  assert.equal(t.stateText('active'), '已激活')
  assert.equal(t.stateText('disabled'), '已停用')
  assert.equal(t.stateText('legacy'), '旧布局')
  assert.equal(t.stateText('uninstalled'), '未激活')
  assert.equal(t.stateText('inactive'), '未激活(仅依赖)')
  assert.equal(t.stateText('invalid'), '非插件目录')
  assert.equal(t.API, '/__dsh-plugin-manager')
  // Client-side fallback counter (used only when an older host half sends no batchCounts).
  const counts = t.localBatchCounts([
    { dir: 'a', valid: true, state: 'active' },
    { dir: 'b', valid: true, state: 'disabled' },
    { dir: 'c', valid: true, state: 'uninstalled' },
    { dir: 'd', valid: true, state: 'inactive' },
    { dir: 'e', valid: true, state: 'legacy' },
    { dir: 'f', valid: false, state: 'invalid' },
  ])
  assert.deepEqual(counts.enable, { count: 2, skippedLegacy: 1, skippedInactive: 1, skippedInvalid: 1 })
  assert.deepEqual(counts.disable, { count: 1, skippedLegacy: 1, skippedInactive: 1, skippedInvalid: 1 })
})

// --- run ---------------------------------------------------------------------

// --- stale links (自检横幅 + 重定位) ----------------------------------------

test('stale deps: banner splits repairable vs manual and repair posts once', async () => {
  fetchCalls.length = 0
  const baselinePlugins = state.plugins
  state.repairPlan = {
    count: 1,
    manualCount: 1,
    auto: [{ dir: 'dsh-aaa', name: 'dsh-aaa', declared: 'link:D:/old/dsh-aaa', expected: 'link:D:/repo/sub-plugins/dsh-aaa' }],
    manual: [{ dir: 'dsh-bbb', name: 'dsh-bbb', reason: '实际目录不存在' }],
  }
  state.autoRelinkEnabled = false
  state.plugins = [
    { dir: 'dsh-aaa', rowId: 'aaa', name: 'dsh-aaa', description: 'AAA plugin', valid: true, hasClient: true, state: 'active', active: true, legacyBundle: false, depState: 'stale-mismatch', depDeclared: 'link:D:/old/dsh-aaa' },
    { dir: 'dsh-bbb', rowId: 'bbb', name: 'dsh-bbb', description: 'BBB plugin', valid: true, hasClient: true, state: 'inactive', active: false, legacyBundle: false, depState: 'stale-unresolved', depDeclared: 'link:D:/nope/dsh-bbb' },
  ]
  const section = mountSection()
  fresh()
  section()
  await flush()
  begin()
  const tree = section()
  const texts = textOf(tree)
  assert.match(texts, /检测到 2 处依赖待修复：1 处可自动修复、1 处需人工处理/, 'banner counts both buckets')
  assert.match(texts, /link:D:\/old\/dsh-aaa → link:D:\/repo\/sub-plugins\/dsh-aaa/, 'declared vs expected shown')
  assert.match(texts, /自动修复依赖已关闭/, 'switch state is visible')
  assert.match(texts, /依赖待修复/, 'row badge for a deprecated declaration')

  const relinkBtn = byType(tree, 'button').find((b) => /^修复依赖$/.test(textOf(b)))
  assert.ok(relinkBtn, 'repair button rendered when something is repairable')
  relinkBtn.props.onClick()
  await flush()
  assert.ok(fetchCalls.some((c) => c.url === '/__dsh-plugin-manager/repair'), 'repair endpoint called')

  // No stale links → no banner, no button.
  state.repairPlan = { count: 0, manualCount: 0, auto: [], manual: [] }
  state.autoRelinkEnabled = true
  state.plugins = baselinePlugins
  begin()
  const stale = section()
  const refreshBtn = byType(stale, 'button').find((b) => /^刷新$/.test(textOf(b)))
  assert.ok(refreshBtn, 'refresh button present')
  refreshBtn.props.onClick()
  await flush()
  begin()
  const clean = section()
  assert.doesNotMatch(textOf(clean), /陈旧链接/, 'banner hidden when nothing is stale')
  assert.equal(byType(clean, 'button').filter((b) => /^修复依赖$/.test(textOf(b))).length, 0, 'no repair button when clean')
})

test('uninstall: the panel shows what will be removed and copies the command', async () => {
  fetchCalls.length = 0
  const copied = []
  // The bundle is evaluated with `navigator` bound as a parameter, so the clipboard
  // stub has to land ON the harness's navigator object (not on a replaced global).
  const setClipboard = (value) => Object.defineProperty(globalThis.navigator, 'clipboard', { value, configurable: true, writable: true })
  const clearClipboard = () => { try { delete globalThis.navigator.clipboard } catch { /* already gone */ } }
  setClipboard({ writeText: async (text) => { copied.push(text) } })
  try {
    const section = mountSection()
    fresh()
    section()
    await flush()
    begin()
    const tree = section()
    const texts = textOf(tree)
    assert.match(texts, /卸载管理器（含全部子插件）/, 'uninstall block renders')
    assert.match(texts, /将删除 2 条激活行、2 个依赖键/, 'preview counts come from the payload')
    assert.match(texts, /uninstall-manager\.mjs/, 'the command is visible in the panel')
    const copyBtn = byType(tree, 'button').find((b) => /复制卸载命令/.test(textOf(b)))
    assert.ok(copyBtn, 'copy button rendered')
    copyBtn.props.onClick()
    await flush()
    assert.deepEqual(copied, [state.uninstall.command], 'clipboard got exactly the host-provided command')
    begin()
    assert.match(textOf(section()), /已复制卸载命令/, 'copy is acknowledged without executing anything')
    assert.equal(fetchCalls.some((c) => /uninstall/.test(c.url)), false, 'the panel never calls an uninstall endpoint')
  } finally {
    clearClipboard()
  }
  // Clipboard unavailable → the panel still tells the user to copy manually.
  try {
    const section = mountSection()
    fresh()
    section()
    await flush()
    begin()
    const tree = section()
    const copyBtn = byType(tree, 'button').find((b) => /复制卸载命令/.test(textOf(b)))
    copyBtn.props.onClick()
    await flush()
    begin()
    assert.match(textOf(section()), /剪贴板不可用/, 'no clipboard → manual-copy hint')
  } finally {
    clearClipboard()
  }
})

let failed = 0
for (const [name, fn] of tests) {
  try {
    await fn()
    console.log(`ok - ${name}`)
  } catch (e) {
    failed += 1
    console.error(`FAIL - ${name}`)
    console.error(e && e.stack ? e.stack : e)
  }
}
if (failed > 0) {
  console.error(`bundle tests: ${failed} failed`)
  process.exit(1)
}
console.log('bundle tests: PASS')
