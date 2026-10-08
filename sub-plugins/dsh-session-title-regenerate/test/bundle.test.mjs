// Behavioural harness for dsh-session-title-regenerate (host + client).
//
// WHY THIS EXISTS
// The plugin has two halves:
//   - src/index.js is a plain ESM cordis plugin with NO host-package import:
//     it reaches the host only through injected ctx services (commands / llm /
//     sessionTitle) and carries its own local message + stream helpers. The
//     harness drives the command handler with a fake ctx / agent / llm stream,
//     so this whole file runs with no node_modules at all.
//   - src/client.js is a browser classic-script bundle (no build step), so it
//     is materialized the way @deepseek-ai/dsh-client-modules does —
//     window.__ModuleLoader__.load({id, factory}) then factory(require) — with
//     real module ids and stub UI primitives. apply() registers the header
//     button and the feedback overlay; the DOM-injected sidebar menu item and
//     the shared flow are driven through the test-only hooks
//     (window.__sessionTitleRegenTest, gated by window.__DSH_TEST__).
//
// It is a LOGIC harness, not a browser render: no React rendering, no portal.
// Visual behaviour still needs the manual checks in README.
//
// Run: node dsh-session-title-regenerate/test/bundle.test.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import {
  apply as hostApply,
  inject as hostInject,
  name as hostName,
  Config as hostConfig,
  DEFAULTS as hostDefaults,
  clampInt as hostClampInt,
  normalizeEntryConfig as hostNormalizeEntryConfig,
  resolveReasoningEffort as hostResolveReasoningEffort,
} from '../src/index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const clientBundlePath = path.join(here, '..', 'src', 'client.js')
const PKG_ID = 'dsh-session-title-regenerate'

const tests = []
const test = (name, fn) => tests.push([name, fn])
const tick = () => new Promise((resolve) => setImmediate(resolve))

// =============================================================================
// Host-side fakes
// =============================================================================

/** One eligible user/message event in the session log. */
function userEvent(seq, text, kind = 'user') {
  return {
    type: 'user/message',
    seq,
    data: { source: { kind }, content: [{ type: 'text', text }] },
  }
}

/** Fake agent whose session exposes the log and the last request header. */
function makeAgent({ events = [], route = { provider: 'deepseek', model: 'deepseek-chat' }, id = 'sess-1' } = {}) {
  return {
    session: {
      id,
      snapshotEvents: () => events,
      requestHeader: () => (route ? { config: route } : undefined),
    },
  }
}

/**
 * Fake host ctx: llm.stream (async generator, scriptable), sessionTitle.rename
 * (spy), commands.register (captures the definition).
 */
function makeHost({ streamImpl, rename } = {}) {
  const calls = { streamOptions: [], rename: [], registered: [] }
  const llm = {
    async *stream(options) {
      calls.streamOptions.push(options)
      if (typeof streamImpl === 'function') yield* streamImpl(options)
    },
  }
  const sessionTitle = {
    rename(session, title) {
      calls.rename.push({ session, title })
      return { title, eventSeq: 99 }
    },
  }
  const commands = {
    register(definition) {
      calls.registered.push(definition)
      return () => {}
    },
  }
  const ctx = { llm, sessionTitle, commands, get: (n) => ({ llm, sessionTitle, commands }[n]) }
  return { ctx, calls, llm, sessionTitle, commands }
}

/** An llm stream that emits one text block then a finish reason. */
function* textStream(text, finish = { kind: 'stop' }) {
  yield { type: 'block-start', index: 0, blockType: 'text' }
  yield { type: 'text-delta', index: 0, text }
  yield { type: 'finish', reason: finish }
}

function registeredDefinition(host, ctx = host.ctx) {
  hostApply(ctx, undefined)
  assert.equal(host.calls.registered.length, 1)
  return host.calls.registered[0]
}

function signal() {
  return new AbortController().signal
}

// =============================================================================
// Host: registration
// =============================================================================

test('host exports cordis contract and registers the command', () => {
  assert.equal(hostName, 'session-title-regenerate')
  assert.deepEqual(hostInject.sort(), ['commands', 'llm', 'sessionTitle'].sort())
  const host = makeHost({})
  const def = registeredDefinition(host)
  assert.equal(def.name, 'regenerate-title')
  assert.equal(def.recordInput, false)
  assert.equal(typeof def.description, 'string')
  assert.equal(typeof def.handler, 'function')
})

// =============================================================================
// Host: link-install safety
// =============================================================================

test('host: src/index.js imports no host package (link-install safe)', () => {
  const source = fs.readFileSync(path.join(here, '..', 'src', 'index.js'), 'utf8')
  assert.ok(!/from\s+'@deepseek-ai\//.test(source), 'host half must not import host packages')
  assert.ok(!/require\('@deepseek-ai\//.test(source), 'host half must not require host packages')
})

// =============================================================================
// Host: happy path
// =============================================================================

test('host: success — collects messages, lowest reasoning, commits via rename', async () => {
  const events = [userEvent(1, '帮我写一个Dsh插件'), userEvent(2, '要支持右键菜单')]
  const agent = makeAgent({ events })
  const host = makeHost({ streamImpl: () => textStream('“帮我写一个Dsh插件”  ') })
  const def = registeredDefinition(host)

  const result = await def.handler({ agent, signal: signal() })

  assert.equal(result.kind, 'success')
  assert.equal(result.text, '帮我写一个Dsh插件')

  const options = host.calls.streamOptions[0]
  assert.equal(options.provider, 'deepseek')
  assert.equal(options.model, 'deepseek-chat')
  assert.equal(options.reasoningEffort, 'off')
  assert.equal(options.purpose, 'session-title')
  assert.equal(options.maxTokens, 512)
  assert.equal(options.sessionId, 'sess-1')
  assert.equal(typeof options.system, 'string')
  assert.ok(options.system.includes('60'))
  assert.equal(options.messages.length, 1)
  assert.equal(options.messages[0].role, 'user')
  // Both user questions travel to the model, framed as JSON.
  const framed = options.messages[0].content[0].text
  assert.ok(framed.includes('帮我写一个Dsh插件'))
  assert.ok(framed.includes('要支持右键菜单'))

  assert.equal(host.calls.rename.length, 1)
  assert.equal(host.calls.rename[0].session, agent.session)
  assert.equal(host.calls.rename[0].title, '帮我写一个Dsh插件')
})

test('host: config provider/model overrides the session route', async () => {
  const agent = makeAgent({ events: [userEvent(1, 'hello')] })
  const host = makeHost({ streamImpl: () => textStream('hello world') })
  hostApply(host.ctx, { provider: 'lite', model: 'lite-model' })
  const def = host.calls.registered[0]

  const result = await def.handler({ agent, signal: signal() })
  assert.equal(result.kind, 'success')
  assert.equal(host.calls.streamOptions[0].provider, 'lite')
  assert.equal(host.calls.streamOptions[0].model, 'lite-model')
})

// =============================================================================
// Host: entry config (settings tab contract)
// =============================================================================

test('host: Config projects the settings defaults (thinking off, effort off, 512 tokens)', () => {
  assert.equal(hostConfig.type, 'object')
  assert.equal(hostConfig.meta.volatile, true)

  const json = hostConfig.toJSON()
  const root = json.refs[String(json.uid)]
  assert.equal(root.type, 'object')
  assert.deepEqual(root.meta, { default: {}, volatile: true })
  assert.deepEqual(
    Object.keys(root.dict).sort(),
    ['maxInputBytes', 'maxOutputTokens', 'reasoningEffort', 'targetCjkCharacters', 'targetWords', 'thinking', 'timeoutMs'].sort(),
  )
  const entry = (name) => json.refs[String(root.dict[name])]
  assert.equal(entry('thinking').type, 'boolean')
  assert.equal(entry('thinking').meta.default, false)
  assert.equal(entry('reasoningEffort').type, 'string')
  assert.equal(entry('reasoningEffort').meta.default, 'off')
  assert.equal(entry('maxOutputTokens').meta.default, 512)
  assert.equal(entry('maxInputBytes').meta.default, 12288)
  assert.equal(entry('timeoutMs').meta.default, 30000)
  assert.equal(json.refs[String(json.uid)].type, 'object')

  const standard = hostConfig['~standard']
  assert.equal(standard.version, 1)
  // vendor 故意不写 'schemastery'：配置写入要走普通 entry restart
  assert.equal(standard.vendor, 'dsh-session-title-regenerate')

  const validated = standard.validate({ thinking: true, reasoningEffort: 'max', maxOutputTokens: 99999, provider: 'lite' })
  assert.equal(validated.value.thinking, true)
  assert.equal(validated.value.reasoningEffort, 'max')
  assert.equal(validated.value.maxOutputTokens, 8192)
  assert.ok(!('issues' in validated))
  // 未声明的 provider/model 原样保留（仍由 Loader 行配置提供）
  assert.equal(validated.value.provider, 'lite')

  const fallback = standard.validate(undefined).value
  assert.equal(fallback.thinking, false)
  assert.equal(fallback.reasoningEffort, 'off')
  assert.equal(fallback.maxOutputTokens, 512)
  assert.equal(fallback.maxInputBytes, 12288)

  // toJSON 返回深拷贝，调用方改不坏内部表
  const copy = hostConfig.toJSON()
  copy.refs['11'].meta.default = 1
  assert.equal(hostConfig.toJSON().refs['11'].meta.default, 512)
})

test('host: the thinking switch decides the reasoning effort and the budget is clamped', () => {
  assert.equal(hostDefaults.thinking, false)
  assert.equal(hostDefaults.reasoningEffort, 'off')
  assert.equal(hostDefaults.maxOutputTokens, 512)

  assert.equal(hostResolveReasoningEffort(undefined), 'off')
  assert.equal(hostResolveReasoningEffort({ thinking: false, reasoningEffort: 'max' }), 'off')
  assert.equal(hostResolveReasoningEffort({ thinking: true, reasoningEffort: 'high' }), 'high')
  assert.equal(hostResolveReasoningEffort({ thinking: true, reasoningEffort: 'max' }), 'max')
  // 大小写/类型不合法 -> 回落默认档位（而不是把脏值透传给提供方）
  assert.equal(hostResolveReasoningEffort({ thinking: true, reasoningEffort: 'HIGH' }), 'off')
  assert.equal(hostResolveReasoningEffort({ thinking: true, reasoningEffort: 7 }), 'off')

  const low = hostNormalizeEntryConfig({ maxOutputTokens: 5, targetWords: 0, targetCjkCharacters: 'x', maxInputBytes: 1, timeoutMs: 10 })
  assert.equal(low.maxOutputTokens, 16)
  assert.equal(low.targetWords, 1)
  assert.equal(low.targetCjkCharacters, 60)
  assert.equal(low.maxInputBytes, 256)
  assert.equal(low.timeoutMs, 1000)

  const high = hostNormalizeEntryConfig({
    maxOutputTokens: 99999,
    targetWords: 9999,
    maxInputBytes: 99 * 1024 * 1024,
    thinking: 'yes',
    reasoningEffort: 'max',
    provider: 'lite',
    model: 'lite-model',
  })
  assert.equal(high.maxOutputTokens, 8192)
  assert.equal(high.targetWords, 400)
  assert.equal(high.maxInputBytes, 4 * 1024 * 1024)
  // 只有严格 true 才算打开思考
  assert.equal(high.thinking, false)
  assert.equal(hostNormalizeEntryConfig({ thinking: true }).thinking, true)
  // 开了思考但没给档位 -> 默认档位
  assert.equal(hostNormalizeEntryConfig({ thinking: true }).reasoningEffort, 'off')

  assert.equal(hostClampInt('12.9', 16, 8192, 512), 16)
  assert.equal(hostClampInt(4096, 16, 8192, 512), 4096)
  assert.equal(hostClampInt('nope', 16, 8192, 512), 512)
})

test('host: entry config drives reasoningEffort and maxTokens on the llm call', async () => {
  const agent = makeAgent({ events: [userEvent(1, '帮我把标题改短一点')] })

  const on = makeHost({ streamImpl: () => textStream('帮我把标题改短一点') })
  hostApply(on.ctx, { thinking: true, reasoningEffort: 'high', maxOutputTokens: 2048 })
  const onResult = await on.calls.registered[0].handler({ agent, signal: signal() })
  assert.equal(onResult.kind, 'success')
  assert.equal(on.calls.streamOptions[0].reasoningEffort, 'high')
  assert.equal(on.calls.streamOptions[0].maxTokens, 2048)

  const off = makeHost({ streamImpl: () => textStream('帮我把标题改短一点') })
  hostApply(off.ctx, { thinking: false, reasoningEffort: 'max' })
  await off.calls.registered[0].handler({ agent, signal: signal() })
  assert.equal(off.calls.streamOptions[0].reasoningEffort, 'off')
  assert.equal(off.calls.streamOptions[0].maxTokens, 512)

  // 行配置缺失时退回默认：reasoningEffort 'off' + 512
  const bare = makeHost({ streamImpl: () => textStream('帮我把标题改短一点') })
  hostApply(bare.ctx, undefined)
  await bare.calls.registered[0].handler({ agent, signal: signal() })
  assert.equal(bare.calls.streamOptions[0].reasoningEffort, 'off')
  assert.equal(bare.calls.streamOptions[0].maxTokens, 512)
})

// =============================================================================
// Host: error paths
// =============================================================================

test('host: no user messages -> error, no llm call', async () => {
  const agent = makeAgent({ events: [] })
  const host = makeHost({})
  const def = registeredDefinition(host)

  const result = await def.handler({ agent, signal: signal() })
  assert.equal(result.kind, 'error')
  assert.ok(result.text.includes('没有'))
  assert.equal(host.calls.streamOptions.length, 0)
  assert.equal(host.calls.rename.length, 0)
})

test('host: non-user messages are ignored', async () => {
  const events = [userEvent(1, 'from tool', 'tool')]
  const agent = makeAgent({ events })
  const host = makeHost({})
  const def = registeredDefinition(host)
  const result = await def.handler({ agent, signal: signal() })
  assert.equal(result.kind, 'error')
  assert.equal(host.calls.streamOptions.length, 0)
})

test('host: missing route -> error', async () => {
  const agent = makeAgent({ events: [userEvent(1, 'hi')], route: null })
  const host = makeHost({})
  const def = registeredDefinition(host)
  const result = await def.handler({ agent, signal: signal() })
  assert.equal(result.kind, 'error')
  assert.ok(result.text.includes('路由'))
  assert.equal(host.calls.streamOptions.length, 0)
})

test('host: empty model output -> error, rename not called', async () => {
  const agent = makeAgent({ events: [userEvent(1, 'hi')] })
  const host = makeHost({ streamImpl: () => textStream('   \n  ') })
  const def = registeredDefinition(host)
  const result = await def.handler({ agent, signal: signal() })
  assert.equal(result.kind, 'error')
  assert.ok(result.text.includes('没有产生'))
  assert.equal(host.calls.rename.length, 0)
})

test('host: finish kind max-tokens -> error', async () => {
  const agent = makeAgent({ events: [userEvent(1, 'hi')] })
  const host = makeHost({ streamImpl: () => textStream('partial', { kind: 'max-tokens' }) })
  const def = registeredDefinition(host)
  const result = await def.handler({ agent, signal: signal() })
  assert.equal(result.kind, 'error')
  assert.ok(result.text.includes('maxTokens'))
  assert.equal(host.calls.rename.length, 0)
})

test('host: finish kind error surfaces the provider message', async () => {
  const agent = makeAgent({ events: [userEvent(1, 'hi')] })
  const host = makeHost({ streamImpl: () => textStream('', { kind: 'error', failure: { message: 'boom', code: 'E' } }) })
  const def = registeredDefinition(host)
  const result = await def.handler({ agent, signal: signal() })
  assert.equal(result.kind, 'error')
  assert.ok(result.text.includes('boom'))
  assert.equal(host.calls.rename.length, 0)
})

test('host: abort -> cancelled error', async () => {
  const agent = makeAgent({ events: [userEvent(1, 'hi')] })
  const host = makeHost({
    streamImpl(options) {
      if (options.signal.aborted) throw new Error('aborted by signal')
      return textStream('title')
    },
  })
  const def = registeredDefinition(host)
  const controller = new AbortController()
  controller.abort(new Error('cancelled'))
  const result = await def.handler({ agent, signal: controller.signal })
  assert.equal(result.kind, 'error')
  assert.ok(result.text.includes('取消'))
})

// =============================================================================
// Host: normalization & policy
// =============================================================================

test('host: output normalized to one clean line without quotes, capped at 60 code points', async () => {
  const agent = makeAgent({ events: [userEvent(1, 'hi')] })
  const long = 'x'.repeat(90)
  const host = makeHost({ streamImpl: () => textStream(`\u201C${long}\u201D\n\nsecond line`) })
  const def = registeredDefinition(host)
  const result = await def.handler({ agent, signal: signal() })
  assert.equal(result.kind, 'success')
  assert.equal(result.text.length, 60)
  assert.ok(!result.text.includes('"'))
  assert.ok(!result.text.includes('\n'))
  assert.equal(host.calls.rename[0].title, result.text)
})

test('host: unsupported reasoning effort retries without it', async () => {
  const agent = makeAgent({ events: [userEvent(1, 'hi')] })
  let calls = 0
  const host = makeHost({
    streamImpl(options) {
      calls += 1
      if (calls === 1) {
        const error = new Error('provider does not support reasoning effort "off"')
        error.code = 'UNSUPPORTED_REASONING_EFFORT'
        throw error
      }
      return textStream('retried title')
    },
  })
  const def = registeredDefinition(host)
  const result = await def.handler({ agent, signal: signal() })
  assert.equal(result.kind, 'success')
  assert.equal(result.text, 'retried title')
  assert.equal(calls, 2)
  assert.equal(host.calls.streamOptions[0].reasoningEffort, 'off')
  assert.ok(!('reasoningEffort' in host.calls.streamOptions[1]))
})

test('host: input is truncated by the byte budget', async () => {
  const agent = makeAgent({ events: [userEvent(1, 'short'), userEvent(2, 'Z'.repeat(500))] })
  const host = makeHost({ streamImpl: () => textStream('ok title') })
  hostApply(host.ctx, { maxInputBytes: 40 })
  const def = host.calls.registered[0]
  const result = await def.handler({ agent, signal: signal() })
  assert.equal(result.kind, 'success')
  const framed = host.calls.streamOptions[0].messages[0].content[0].text
  assert.ok(framed.includes('short'))
  assert.ok(!framed.includes('ZZZZ'))
})

test('host: reads events through the 0.1.1 `events` getter shape', async () => {
  const events = [userEvent(1, '老接口标题')]
  const agent = {
    session: {
      id: 'sess-1',
      get events() { return events },
      requestHeader: () => ({ config: { provider: 'deepseek', model: 'deepseek-chat' } }),
    },
  }
  const host = makeHost({ streamImpl: () => textStream('老接口标题') })
  const def = registeredDefinition(host)
  const result = await def.handler({ agent, signal: signal() })
  assert.equal(result.kind, 'success')
  assert.equal(result.text, '老接口标题')
})

test('host: unknown event API degrades to empty input without throwing', async () => {
  const agent = { session: { id: 'sess-1', requestHeader: () => ({ config: { provider: 'p', model: 'm' } }) } }
  const host = makeHost({})
  const def = registeredDefinition(host)
  const result = await def.handler({ agent, signal: signal() })
  assert.equal(result.kind, 'error')
  assert.ok(result.text.includes('没有'))
  assert.equal(host.calls.streamOptions.length, 0)
})

// =============================================================================
// Client-side harness
// =============================================================================

// --- browser-ish globals -----------------------------------------------------

const windowEvents = []
class FakeCustomEvent {
  constructor(type, opts) {
    this.type = type
    this.detail = (opts && opts.detail) || {}
  }
}

/** Minimal selector matcher for the selectors this plugin uses. */
function matches(node, sel) {
  if (sel === 'span') return node.tagName === 'SPAN'
  if (sel.startsWith('[') && sel.endsWith(']')) {
    const inner = sel.slice(1, -1)
    // `class*=substring` — substring match on the class attribute.
    if (inner.startsWith('class*=')) {
      return String(node.className || '').includes(inner.slice('class*='.length))
    }
    const eq = inner.match(/^([a-z][a-z0-9-]*)=(.*)$/)
    if (eq) {
      const [, attr, value] = eq
      if (value.startsWith('*') && value.endsWith('*')) {
        return String(node.attrs[attr] || '').includes(value.slice(1, -1))
      }
      if (value.startsWith('*')) return String(node.attrs[attr] || '').includes(value.slice(1))
      if (value.endsWith('*')) return String(node.attrs[attr] || '').includes(value.slice(0, -1))
      return node.attrs[attr] === value
    }
    const presence = inner.match(/^[a-z][a-z0-9-]*$/)
    if (presence) return node.attrs[presence[0]] !== undefined
  }
  return false
}

function findIn(node, sel, all, out) {
  if (matches(node, sel)) {
    if (!all) return node
    out.push(node)
  }
  for (const child of node.children || []) {
    const found = findIn(child, sel, all, out)
    if (!all && found) return found
  }
  return all ? out : null
}

function makeElement(tag) {
  const el = {
    tagName: String(tag).toUpperCase(),
    attrs: {},
    style: {},
    children: [],
    handlers: {},
    parentElement: null,
    className: '',
    innerText: '',
    textContent: '',
    innerHTML: '',
    setAttribute(k, v) { el.attrs[k] = String(v) },
    appendChild(child) { el.children.push(child); child.parentElement = el; return child },
    insertBefore(child, ref) {
      const i = el.children.indexOf(ref)
      if (i >= 0) el.children.splice(i, 0, child)
      else el.children.push(child)
      child.parentElement = el
      return child
    },
    addEventListener(type, fn) { el.handlers[type] = fn },
    querySelector(sel) { return findIn(el, sel, false, null) },
    querySelectorAll(sel) {
      const out = []
      findIn(el, sel, true, out)
      return out
    },
  }
  return el
}

function makeDocument() {
  // Faithful to the core Menu: native items live inside a role=presentation
  // viewport that is a CHILD of the [role=menu] element; plugin-injected items
  // (session-delete etc.) are appended as DIRECT children of [role=menu].
  const menuEl = makeElement('DIV')
  menuEl.setAttribute('role', 'menu')
  menuEl.className = 'uV2eYG_menu'
  const viewport = makeElement('DIV')
  viewport.setAttribute('role', 'presentation')
  menuEl.appendChild(viewport)
  const titleEl = makeElement('SPAN')
  titleEl.className = 'uV2eYG_title'
  titleEl.innerText = 'Foo'
  const rowEl = makeElement('DIV')
  rowEl.className = 'uV2eYG_sessionRow uV2eYG_menuOpen'
  rowEl.appendChild(titleEl)
  const body = makeElement('BODY')
  return {
    body,
    menuEl,
    viewport,
    rowEl,
    createElement: (tag) => makeElement(tag),
    querySelector: (sel) => (sel === '[role=menu]' ? menuEl : null),
    querySelectorAll: (sel) => (sel === '[class*=sessionRow]' ? [rowEl] : []),
  }
}

Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { languages: ['zh-CN'], language: 'zh-CN' },
})
globalThis.CustomEvent = FakeCustomEvent
globalThis.MutationObserver = class { observe() {} disconnect() {} }
globalThis.window = {
  __ModuleLoader__: { load: ({ id, factory }) => factories.set(id, factory) },
  __DSH_TEST__: true,
  dispatchEvent: (e) => { windowEvents.push(e) },
  addEventListener() {},
  removeEventListener() {},
  MutationObserver: globalThis.MutationObserver,
}
globalThis.document = makeDocument()

const factories = new Map()

const IconStub = () => null
const primitives = {
  IconCheckOutline16: IconStub,
  IconLoadingOutline16: IconStub,
  IconRefreshOutline16: IconStub,
  IconWarningOutline16: IconStub,
  Toast: ({ text }) => ({ __toast: text }),
}

function makeReactStub() {
  const React = {
    createElement: (type, props, ...children) => ({ __element: true, type, props: { ...(props || {}), children } }),
    Fragment: Symbol('Fragment'),
    useState(initial) { return [typeof initial === 'function' ? initial() : initial, () => {}] },
    useEffect() {},
    useRef(initial) { return { current: initial } },
    useCallback: (fn) => fn,
  }
  return React
}
const ReactStub = makeReactStub()

function requireStub(specifier) {
  if (specifier === 'react') return ReactStub
  if (specifier === 'react-dom') return { createPortal: (node) => node }
  if (specifier === '@deepseek-ai/dsh-client-ui-primitives') return primitives
  throw new Error(`unexpected require("${specifier}")`)
}

// --- load the client bundle --------------------------------------------------

const clientSource = fs.readFileSync(clientBundlePath, 'utf8')
// eslint-disable-next-line no-new-func -- mirroring the browser classic-script evaluation
new Function('window', 'navigator', 'document', clientSource)(
  globalThis.window,
  globalThis.navigator,
  globalThis.document,
)

/**
 * Fake client ctx shaped like the REAL runtime for the `remote` root: the bare
 * root exposes every controller as an accessor that THROWS
 * `cannot get property "remote.commands" without inject` until the dotted name
 * has been injected. Only `ctx.get('remote.commands')` / an inject scope
 * resolves the commands controller — mirroring the gateway's configurable
 * getters that external plugins must not read directly.
 */
function makeRemoteRoot() {
  const root = {}
  for (const name of ['commands', 'settings']) {
    Object.defineProperty(root, name, {
      configurable: true,
      enumerable: true,
      get() {
        throw new Error(`cannot get property "remote.${name}" without inject`)
      },
    })
  }
  return root
}

/** Fake client ctx: services resolved through get(), slots captured. */
function makeClientCtx({ remoteCommands, sessions, locale, settings }) {
  const registered = []
  const services = {
    remote: makeRemoteRoot(),
    'remote.commands': remoteCommands,
    'remote.settings': settings,
    sessions,
    locale,
  }
  return {
    registered,
    get: (n) => services[n],
    effect: (fn) => fn(),
    on: () => {},
    inject: (names, fn) => {
      fn({
        get: (n) => services[n],
        effect: (fn2) => fn2(),
        on: () => {},
      })
    },
    slots: {
      inject: (name, build) => { build() },
      register: (options, component) => { registered.push({ options, component }); return { dispose() {} } },
    },
  }
}

function bootClient({ remoteCommands, sessions, locale, settings }) {
  const factory = factories.get(PKG_ID)
  assert.ok(factory, `client bundle did not register id "${PKG_ID}"`)
  // Module-level service handles persist across boots in the same bundle
  // instance; reset them so every scenario starts from a clean slate.
  const prev = globalThis.window.__sessionTitleRegenTest
  if (prev && typeof prev.reset === 'function') prev.reset()
  // Reset the fake menu to a fresh core-shaped tree (empty role=presentation
  // viewport under the [role=menu]) so injection starts from scratch.
  const menu = globalThis.document.menuEl
  menu.children.length = 0
  const viewport = globalThis.document.createElement('div')
  viewport.setAttribute('role', 'presentation')
  menu.appendChild(viewport)
  globalThis.document.viewport = viewport
  const ctx = makeClientCtx({ remoteCommands, sessions, locale, settings })
  const exports = factory(requireStub)
  exports.apply(ctx)
  return { ctx, hooks: globalThis.window.__sessionTitleRegenTest }
}

/**
 * Faithful core Menu session-row menu: every native row is a
 * `div.itemWrap > button[role=menuitem] > span.itemIcon + span.itemLabel`, all
 * inside the role=presentation viewport under [role=menu]. A third-party item
 * (session-delete etc.) is a DIRECT child of [role=menu] AFTER that viewport.
 */
function buildCoreSessionMenu({ withSiblingPluginItem = false } = {}) {
  const menu = globalThis.document.menuEl
  menu.children.length = 0
  const viewport = globalThis.document.createElement('div')
  viewport.setAttribute('role', 'presentation')
  menu.appendChild(viewport)
  globalThis.document.viewport = viewport
  const rows = ['重命名', '分叉会话', '归档会话'].map((text) => {
    const wrap = globalThis.document.createElement('div')
    const button = globalThis.document.createElement('button')
    button.setAttribute('role', 'menuitem')
    const icon = globalThis.document.createElement('span')
    const label = globalThis.document.createElement('span')
    label.textContent = text
    button.appendChild(icon)
    button.appendChild(label)
    wrap.appendChild(button)
    viewport.appendChild(wrap)
    return wrap
  })
  if (withSiblingPluginItem) {
    const sibling = globalThis.document.createElement('button')
    sibling.setAttribute('role', 'menuitem')
    sibling.setAttribute('data-chameleon-delete', '1')
    menu.appendChild(sibling)
  }
  return { menu, viewport, rows }
}

// =============================================================================
// Client: slot registration
// =============================================================================

test('client: registers header button and feedback overlay slots', () => {
  const { ctx } = bootClient({ remoteCommands: undefined, sessions: {}, locale: undefined })
  const names = ctx.registered.map((r) => r.options.name)
  assert.ok(names.includes('conversation.session.header.actions'))
  assert.ok(names.includes('shell.overlay'))
  const header = ctx.registered.find((r) => r.options.name === 'conversation.session.header.actions')
  assert.equal(header.options.id, 'regenerate-title')
  assert.equal(typeof header.component, 'function')
  const overlay = ctx.registered.find((r) => r.options.name === 'shell.overlay')
  assert.equal(overlay.options.id, 'session-title-regen-feedback')
})

// =============================================================================
// Client: settings tab
// =============================================================================

test('client: contributes a local-plugins settings tab for the entry namespace', () => {
  const { ctx } = bootClient({ remoteCommands: undefined, sessions: {}, locale: undefined })
  const tab = ctx.registered.find((r) => r.options.name === 'settings.localPlugins.tab')
  assert.ok(tab, 'settings tab was not registered')
  assert.equal(tab.options.id, 'session-title-regenerate')
  assert.equal(tab.options.order, 45)
  assert.equal(typeof tab.component, 'function')
  assert.ok(/标题|title/i.test(String(tab.options.label())))
})

test('client: settings helpers normalize the describe() row and clamp writes', async () => {
  const { hooks } = bootClient({ remoteCommands: undefined, sessions: {}, locale: undefined })
  assert.equal(hooks.SETTINGS_NS, 'session-title-regenerate')
  assert.deepEqual(hooks.EFFORT_OPTIONS, ['off', 'low', 'medium', 'high', 'max'])
  assert.deepEqual(hooks.SETTINGS_DEFAULTS, { thinking: false, reasoningEffort: 'off', maxOutputTokens: 512 })

  assert.deepEqual(hooks.settingsFromRow(undefined), { thinking: false, reasoningEffort: 'off', maxOutputTokens: 512 })
  assert.deepEqual(
    hooks.settingsFromRow({ value: { thinking: true, reasoningEffort: 'high', maxOutputTokens: 2048 } }),
    { thinking: true, reasoningEffort: 'high', maxOutputTokens: 2048 },
  )
  assert.equal(hooks.settingsFromRow({ value: { reasoningEffort: 'HIGH' } }).reasoningEffort, 'off')
  assert.equal(hooks.settingsFromRow({ value: { reasoningEffort: 7 } }).reasoningEffort, 'off')
  assert.equal(hooks.settingsFromRow({ value: { maxOutputTokens: 1 } }).maxOutputTokens, 16)
  assert.equal(hooks.settingsFromRow({ value: { maxOutputTokens: 99999 } }).maxOutputTokens, 8192)
  assert.equal(hooks.settingsFromRow({ value: { maxOutputTokens: 'nope' } }).maxOutputTokens, 512)
  assert.equal(hooks.settingsFromRow({ value: { thinking: 'yes' } }).thinking, false)

  // 档位单选表：不带 off（off 由思考开关表达）；非法/空值一律落到 low。
  assert.deepEqual(hooks.ACTIVE_EFFORT_OPTIONS, ['low', 'medium', 'high', 'max'])
  assert.equal(hooks.activeEffortOf('off'), 'low')
  assert.equal(hooks.activeEffortOf(''), 'low')
  assert.equal(hooks.activeEffortOf('nope'), 'low')
  assert.equal(hooks.activeEffortOf('high'), 'high')

  // 未保存判定：数字项按夹取后的整数比较，开关/档位严格比较。
  const clean = { thinking: false, reasoningEffort: 'off', maxOutputTokens: 512 }
  assert.equal(hooks.sameSettings(clean, { thinking: false, reasoningEffort: 'off', maxOutputTokens: '512' }), true)
  assert.equal(hooks.sameSettings(clean, { thinking: true, reasoningEffort: 'off', maxOutputTokens: 512 }), false)
  assert.equal(hooks.sameSettings(clean, { thinking: false, reasoningEffort: 'low', maxOutputTokens: 512 }), false)
  assert.equal(hooks.sameSettings(clean, null), false)
  assert.equal(hooks.sameSettings({ ...clean, maxOutputTokens: '' }, { ...clean, maxOutputTokens: 16 }), true)

  // 本次调用回显：思考关不下发档位；思考开时 off/非法被抬到 low；数字先夹取。
  assert.match(hooks.effectiveSummary({ thinking: false, reasoningEffort: 'off', maxOutputTokens: 512 }), /(不下发 reasoningEffort|no reasoningEffort)/)
  assert.ok(hooks.effectiveSummary({ thinking: false, maxOutputTokens: 512 }).includes('512'))
  assert.ok(hooks.effectiveSummary({ thinking: true, reasoningEffort: 'off', maxOutputTokens: 700 }).includes('reasoningEffort = low'))
  assert.ok(hooks.effectiveSummary({ thinking: true, reasoningEffort: 'max', maxOutputTokens: 99999 }).includes('maxTokens 8192'))

  const seen = []
  const settings = {
    describe: async () => ({
      ok: true,
      value: {
        namespaces: [
          { ns: 'dsh-other-plugin', value: { thinking: true, maxOutputTokens: 64 } },
          { ns: 'session-title-regenerate', value: { thinking: true, reasoningEffort: 'medium', maxOutputTokens: 900 } },
        ],
      },
    }),
    update: async (ns, payload) => {
      seen.push({ ns, payload })
      return { ok: true, value: { revision: 2 } }
    },
  }

  const read = await hooks.readSettings(settings)
  assert.equal(read.row.ns, 'session-title-regenerate')
  assert.deepEqual(read.settings, { thinking: true, reasoningEffort: 'medium', maxOutputTokens: 900 })

  const written = await hooks.saveSettings(settings, { thinking: true, reasoningEffort: 'max', maxOutputTokens: 99999 })
  assert.deepEqual(written, { thinking: true, reasoningEffort: 'max', maxOutputTokens: 8192 })
  assert.equal(seen.length, 1)
  assert.equal(seen[0].ns, 'session-title-regenerate')
  assert.deepEqual(seen[0].payload, { thinking: true, reasoningEffort: 'max', maxOutputTokens: 8192 })

  await assert.rejects(() => hooks.readSettings(null), /settings-unavailable/)
  await assert.rejects(() => hooks.readSettings({}), /settings-unavailable/)
  await assert.rejects(() => hooks.saveSettings({}, {}), /settings-unavailable/)
  await assert.rejects(
    () => hooks.readSettings({ describe: async () => ({ ok: false, error: { code: 'SettingsUnavailable', message: 'no settings service' } }) }),
    /no settings service/,
  )

  // 组件本身可渲染（React stub 下 useEffect 不跑，draft 为空 -> 展示默认值）
  const tree = hooks.SettingsSection()
  assert.equal(tree.__element, true)

  // 思考关（默认）这一支：档位下拉已删掉、不渲染单选，只给「不思考」说明 + 本次调用回显。
  const tags = []
  const texts = []
  const walk = (node) => {
    if (node === null || node === undefined) return
    if (typeof node === 'string' || typeof node === 'number') { texts.push(String(node)); return }
    if (Array.isArray(node)) { node.forEach(walk); return }
    if (typeof node !== 'object') return
    if (node.__element === true) { tags.push(node.type); walk(node.props && node.props.children); return }
    Object.keys(node).forEach((key) => walk(node[key]))
  }
  walk(tree)
  assert.equal(tags.includes('select'), false, 'the effort dropdown must be gone')
  assert.equal(tags.includes('radio'), false, 'no effort radios while thinking is off')
  assert.ok(texts.some((s) => /(不下发 reasoningEffort|no reasoningEffort)/.test(s)), 'the not-thinking note is missing')
  assert.ok(texts.some((s) => /(本次调用|This call)/.test(s)), 'the effective-call summary is missing')
})

test('client: the settings controller is resolved via get(), never the throwing bare accessor', () => {
  const { hooks } = bootClient({ remoteCommands: undefined, sessions: {}, locale: undefined })
  const settings = { describe: async () => ({ ok: true, value: { namespaces: [] } }) }
  const scope = { get: (n) => (n === 'remote.settings' ? settings : undefined) }
  assert.equal(hooks.readRemoteSettings(scope), settings)

  const throwing = {}
  Object.defineProperty(throwing, 'remote.settings', {
    configurable: true,
    get() { throw new Error('cannot get property "remote.settings" without inject') },
  })
  Object.defineProperty(throwing, 'settings', {
    configurable: true,
    get() { throw new Error('cannot get property "settings" without inject') },
  })
  assert.equal(hooks.readRemoteSettings(throwing), null)
  assert.equal(hooks.readRemoteSettings(null), null)
})

// =============================================================================
// Client: shared flow (test hooks)
// =============================================================================

test('client: executeRegenerate resolves a successful command result despite throwing remote-root accessor', async () => {
  const executeCalls = []
  const remoteCommands = {
    execute: async (sessionId, line, images) => {
      executeCalls.push({ sessionId, line, images })
      return { ok: true, value: { commandId: 'c1', result: { kind: 'success', text: '新标题' } } }
    },
  }
  // Production shape: reading `remote.commands` on the bare root throws
  // "cannot get property ... without inject"; the flow must still work because
  // it resolves the controller through the injected dotted name.
  assert.throws(() => {
    const { ctx } = bootClient({ remoteCommands, sessions: {}, locale: undefined })
    ctx.get('remote').commands
  }, /without inject/)
  const { hooks } = bootClient({ remoteCommands, sessions: {}, locale: undefined })
  const result = await hooks.executeRegenerate('sess-9')
  assert.deepEqual(result, { ok: true, title: '新标题' })
  assert.equal(executeCalls.length, 1)
  assert.equal(executeCalls[0].sessionId, 'sess-9')
  assert.equal(executeCalls[0].line, '/regenerate-title')
  assert.deepEqual(executeCalls[0].images, [])
})

test('client: executeRegenerate surfaces a handler error result', async () => {
  const remoteCommands = {
    execute: async () => ({ ok: true, value: { commandId: 'c2', result: { kind: 'error', text: '这个会话还没有可总结的用户提问' } } }),
  }
  const { hooks } = bootClient({ remoteCommands, sessions: {}, locale: undefined })
  const result = await hooks.executeRegenerate('sess-9')
  assert.equal(result.ok, false)
  assert.equal(result.message, '这个会话还没有可总结的用户提问')
})

test('client: executeRegenerate surfaces a failed remote result', async () => {
  const remoteCommands = {
    execute: async () => ({ ok: false, error: { code: 'gateway/internal', message: 'boom' } }),
  }
  const { hooks } = bootClient({ remoteCommands, sessions: {}, locale: undefined })
  const result = await hooks.executeRegenerate('sess-9')
  assert.equal(result.ok, false)
  assert.equal(result.message, 'boom')
})

test('client: executeRegenerate reports a missing command channel', async () => {
  const { hooks } = bootClient({ remoteCommands: undefined, sessions: {}, locale: undefined })
  const result = await hooks.executeRegenerate('sess-9')
  assert.equal(result.ok, false)
  assert.ok(result.message.length > 0)
})

test('client: resolves session id from the list store by title (exact/fork/contains)', () => {
  const sessions = {
    list: {
      getSnapshot: () => ({
        byId: {
          a: { title: 'Foo' },
          b: { title: 'Foo (1)' },
          c: { title: 'Bar' },
          d: { title: 'Foxtrot' },
        },
      }),
    },
  }
  const { hooks } = bootClient({ remoteCommands: undefined, sessions, locale: undefined })
  assert.equal(hooks.resolveSessionIdByTitle('Foo'), 'a')
  assert.equal(hooks.resolveSessionIdByTitle('Foo (1)'), 'b')
  assert.equal(hooks.resolveSessionIdByTitle('Foxt'), 'd')
  assert.equal(hooks.resolveSessionIdByTitle('Bar'), 'c')
  assert.equal(hooks.resolveSessionIdByTitle('zzz-not-there'), null)
})

// =============================================================================
// Client: sidebar "..." menu DOM injection
// =============================================================================

test('client: injects the regenerate item into the open session-row menu and fires the flow', async () => {
  const executeCalls = []
  const remoteCommands = {
    execute: async (sessionId) => {
      executeCalls.push(sessionId)
      return { ok: true, value: { commandId: 'c3', result: { kind: 'success', text: 'Foo 新标题' } } }
    },
  }
  const sessions = {
    list: {
      getSnapshot: () => ({
        byId: { a: { title: 'Foo' } },
      }),
    },
  }
  const { hooks } = bootClient({ remoteCommands, sessions, locale: undefined })

  // The apply-time injection already ran; the fake document holds the open menu.
  const menu = globalThis.document.menuEl
  const item = menu.querySelector('[data-session-title-regen]')
  assert.ok(item, 'menu item should be injected')
  assert.equal(item.attrs['data-session-title-regen'], '1')
  assert.equal(item.attrs.role, 'menuitem')
  const label = item.querySelector('[data-session-title-regen-label]')
  assert.equal(label.textContent, '重新生成标题')
  // Row shape: own wrapper > button (icon slot + label slot), never a bare child of
  // the viewport — third-party plugins clone `lastItem.parentElement` as "one row".
  const row = item.parentElement
  assert.equal(row.tagName, 'DIV')
  assert.equal(row.children.length, 1)
  assert.equal(item.children.length, 2, 'icon slot + label slot')
  // This fixture's viewport is empty (no native item yet), so menuContentRoot falls
  // back to the [role=menu] itself — the row wrapper is what protects the clone rule.
  assert.equal(row.parentElement, globalThis.document.menuEl)

  // Clicking it resolves the row title 'Foo' -> session 'a' and fires the flow.
  await item.handlers.click()
  await tick()
  assert.deepEqual(executeCalls, ['a'])
  assert.ok(windowEvents.some((e) => e.type === 'session-title-regen:result' && e.detail.ok === true))

  // Idempotent: a second ensureMenuItem call must not duplicate the item.
  hooks.ensureMenuItem()
  assert.equal(menu.querySelectorAll('[data-session-title-regen]').length, 1)
})

test('client: menu item lands inside the viewport, after the official items and before sibling plugin items', () => {
  const remoteCommands = { execute: async () => ({ ok: true, value: { commandId: 'c4', result: { kind: 'success', text: 'x' } } }) }
  const sessions = { list: { getSnapshot: () => ({ byId: { a: { title: 'Foo' } } }) } }
  const { hooks } = bootClient({ remoteCommands, sessions, locale: undefined })

  // Rebuild a faithful core-shaped menu: the native trio are `div > button` rows inside
  // the role=presentation viewport; session-delete's item is a DIRECT child of
  // [role=menu] AFTER the viewport (its observer ran first).
  const { menu, viewport, rows } = buildCoreSessionMenu({ withSiblingPluginItem: true })
  const deleteItem = menu.children[menu.children.length - 1]
  assert.equal(deleteItem.attrs['data-chameleon-delete'], '1')

  hooks.reset()
  hooks.ensureMenuItem()

  // Ours is a WHOLE ROW appended INSIDE the viewport, right after the native trio.
  assert.equal(viewport.children.length, 4, 'viewport grows by exactly one — no separator')
  assert.equal(viewport.children.indexOf(rows[0]), 0)
  assert.equal(viewport.children.indexOf(rows[1]), 1)
  assert.equal(viewport.children.indexOf(rows[2]), 2)
  const ourRow = viewport.children[3]
  assert.equal(ourRow.children.length, 1, 'injected row is one wrapper + one button')
  assert.equal(ourRow.children[0].attrs['data-session-title-regen'], '1')

  // The delete plugin item stays a sibling AFTER the viewport => visually below ours.
  const menuChildren = menu.children
  assert.ok(menuChildren.indexOf(deleteItem) > menuChildren.indexOf(viewport))
})

test('client: injected row is self-contained, so a third-party "last item" clone copies ONE row', () => {
  const remoteCommands = { execute: async () => ({ ok: true, value: { commandId: 'c5', result: { kind: 'success', text: 'x' } } }) }
  const sessions = { list: { getSnapshot: () => ({ byId: { a: { title: 'Foo' } } }) } }
  const { hooks } = bootClient({ remoteCommands, sessions, locale: undefined })
  const { menu, viewport } = buildCoreSessionMenu()

  hooks.reset()
  hooks.ensureMenuItem()

  // dsh-flowglass 0.7.0（「加入当前并发分支」）取最后一个 [role=menuitem]、把它的
  // parentElement 当作「这一行」的容器 cloneNode(true)。裸 button 的 parentElement 是
  // 整个 viewport ⇒ 克隆会复制整张菜单、而只改其中第一行（分叉/归档/… 成排重复）。
  // 这里把那条规则原样跑一遍，断言我们不会踩中它。
  const items = menu.querySelectorAll('[role=menuitem]')
  const template = items[items.length - 1]
  assert.equal(template.attrs['data-session-title-regen'], '1', '注入项就是最后一个菜单项')
  const rowContainer = template.parentElement
  assert.notEqual(rowContainer, viewport, '最后一项的 parentElement 必须是这一行自己')
  assert.equal(rowContainer.parentElement, viewport)
  assert.equal(rowContainer.children.length, 1, '克隆这一行只得到一行')
  // 图标槽 + 文案槽各占一个 span：第三方按 spans[0]/spans[1] 改写文案时结构不塌。
  assert.equal(template.querySelectorAll('span').length, 2)
})

// =============================================================================
// Runner
// =============================================================================

let failed = 0
for (const [name, fn] of tests) {
  try {
    const maybe = fn()
    if (maybe && typeof maybe.then === 'function') await maybe
    console.log(`  ok  ${name}`)
  } catch (error) {
    failed += 1
    console.error(`FAIL  ${name}`)
    console.error(error && error.stack ? error.stack : error)
  }
}
console.log(`\n${tests.length - failed}/${tests.length} tests passed`)
if (failed > 0) process.exit(1)
