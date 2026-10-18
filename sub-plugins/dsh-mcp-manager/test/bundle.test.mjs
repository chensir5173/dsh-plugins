// Behavioural harness for dsh-mcp-manager — CLIENT half only.
//
// WHY THIS EXISTS
// src/client.js is a browser classic-script bundle (no build step), so it is
// materialized the way @deepseek-ai/dsh-client-modules does it:
// window.__ModuleLoader__.load({ id, factory }) then factory(require), with a
// stub react whose hooks actually work (useState re-renders, useEffect runs once
// on mount) — the panel is a real component, so a passive stub would render one
// frame of "loading" and assert nothing.
//
// WHAT IT PINS
//   * the manifest contract of a local sub-plugin: name/main/exports["./client"]/
//     dsh.client, NO dsh.bundle, and no cordis.patch.yml inside the package;
//   * the slot: exactly one tab on settings.localPlugins.tab;
//   * one full `list` render from a fetch stub: 6 managed rows with every column
//     the spec asks for (id/serverName/transport/layer/profiles/state/tools), the
//     disabled row, the layout-drift row, the profile-layer row whose effective
//     set excludes the active profile, and the raw-YAML entry;
//   * every write path (setEnabled / setMatrix / remove / probe / add /
//     setDefaults / migrate / patchInfo) posts the pinned { action, payload }
//     envelope with the x-dsh-plugin header, and the two destructive ones ask for
//     confirmation first (cross-profile matrix write, delete);
//   * the degradation face: unreachable endpoint (404 + non-JSON body), an
//     { ok:false, error } payload with fields, an unparseable-patch read-only
//     notice, and an empty list — none of them may throw or render blank.
//
// It is a LOGIC harness, not a browser render: no layout, no CSS, no real HTTP.
// Visual behaviour still needs the manual checks in ACCEPTANCE.md.
//
// Run: node sub-plugins/dsh-mcp-manager/test/bundle.test.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const root = path.join(here, '..')
const PKG_ID = 'dsh-mcp-manager'
const clientPath = path.join(root, 'src', 'client.js')
const manifestPath = path.join(root, 'package.json')
const API = '/__dsh-mcp-manager/api'

const tests = []
const test = (label, fn) => tests.push([label, fn])

// =============================================================================
// React stub with working hooks
// =============================================================================

/**
 * One shared stub instance: the bundle captures `require('react')` at factory
 * evaluation time, so the renderer below has to drive the very same object.
 */
const render = {
  states: {},
  refs: {},
  effects: {},
  index: 0,
  dirty: false,
  mounted: false,
  component: null,
  props: {},
  tree: null,
  renders: 0,
  cleanups: [],
}

const ReactStub = {
  createElement: (type, props, ...children) => ({ __element: true, type, props: { ...(props || {}), children } }),
  Fragment: Symbol('Fragment'),
  useState(initial) {
    const index = render.index++
    if (!(index in render.states)) render.states[index] = typeof initial === 'function' ? initial() : initial
    const setState = (next) => {
      const value = typeof next === 'function' ? next(render.states[index]) : next
      if (Object.is(value, render.states[index])) return
      render.states[index] = value
      render.dirty = true
    }
    return [render.states[index], setState]
  },
  useRef(initial) {
    const index = render.index++
    if (!(index in render.refs)) render.refs[index] = { current: initial }
    return render.refs[index]
  },
  useEffect(fn) {
    const index = render.index++
    render.effects[index] = fn
  },
  useCallback(fn) {
    render.index++
    return fn
  },
  useMemo(fn) {
    render.index++
    return fn()
  },
}

function requireStub(specifier) {
  if (specifier === 'react') return ReactStub
  throw new Error('unexpected require("' + specifier + '")')
}

// =============================================================================
// Bundle plumbing
// =============================================================================

const factories = new Map()
const logs = []
const errors = []
const unhandled = []

// The bundle writes progress lines to console.log; keep the harness reporter on
// process.stdout so those lines stay visible for debugging.
console.log = (...args) => logs.push(args.map(String).join(' '))
console.error = (...args) => errors.push(args.map(String).join(' '))
process.on('unhandledRejection', (reason) => unhandled.push(reason))

// The bundle reads navigator at call time (through the closure parameter), so a
// language test can mutate this object in place.
const navigatorStub = { languages: ['zh-CN'], language: 'zh-CN' }
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: navigatorStub })

const confirmations = []
let confirmAnswer = true
const windowStub = {
  __ModuleLoader__: { load: ({ id, factory }) => factories.set(id, factory) },
  __DSH_TEST__: true,
  confirm: (text) => {
    confirmations.push(String(text))
    return confirmAnswer
  },
  addEventListener() {},
  removeEventListener() {},
}
globalThis.window = windowStub
globalThis.document = { createElement: () => ({ style: {} }), querySelector: () => null }

const clientSource = fs.readFileSync(clientPath, 'utf8')
// eslint-disable-next-line no-new-func -- mirroring the browser classic-script evaluation
new Function('window', 'navigator', 'document', clientSource)(
  globalThis.window,
  navigatorStub,
  globalThis.document,
)

const tick = () => new Promise((resolve) => setImmediate(resolve))

function renderNow() {
  render.index = 0
  render.effects = {}
  render.tree = render.component(render.props)
  render.renders += 1
  if (!render.mounted) {
    render.mounted = true
    for (const key of Object.keys(render.effects)) {
      const cleanup = render.effects[key]()
      if (typeof cleanup === 'function') render.cleanups.push(cleanup)
    }
  }
}

/** Re-render while state is dirty; returns how many extra frames were drawn. */
function pump() {
  let frames = 0
  while (render.dirty && frames < 50) {
    render.dirty = false
    renderNow()
    frames += 1
  }
  return frames
}

/** Let pending promises (fetch, timers) settle, re-rendering after every turn. */
async function settle(rounds = 25) {
  for (let i = 0; i < rounds; i += 1) {
    await tick()
    pump()
  }
}

function mountPanel(component, props) {
  render.states = {}
  render.refs = {}
  render.effects = {}
  render.index = 0
  render.dirty = false
  render.mounted = false
  render.cleanups = []
  render.renders = 0
  render.component = component
  render.props = props || {}
  renderNow()
}

function unmountPanel() {
  for (const cleanup of render.cleanups) cleanup()
  render.cleanups = []
}

// =============================================================================
// Tree helpers
// =============================================================================

function textOf(node) {
  if (node === null || node === undefined || node === false || node === true) return ''
  if (typeof node === 'string') return node
  if (typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (typeof node === 'object' && node.__element) return (node.props.children || []).map(textOf).join('')
  return ''
}

function elementsOf(node, out = []) {
  if (node === null || node === undefined || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) elementsOf(child, out)
    return out
  }
  if (!node.__element) return out
  out.push(node)
  for (const child of node.props.children || []) elementsOf(child, out)
  return out
}

const all = () => elementsOf(render.tree)
const withProp = (name, value) => all().filter((node) => node.props[name] === value)
const buttons = () => all().filter((node) => node.type === 'button')
const buttonByText = (text) => buttons().find((node) => textOf(node).indexOf(text) !== -1)
const checkboxes = () => all().filter((node) => node.type === 'input' && node.props.type === 'checkbox')
const cards = () => withProp('data-card', undefined).length ? all().filter((node) => node.props['data-card'] !== undefined) : []
const treeText = () => textOf(render.tree)

function cardOf(id) {
  return all().find((node) => node.props['data-card'] === id)
}

function cellOf(attr, id) {
  const node = all().find((item) => item.props[attr] === id)
  return node ? textOf(node) : ''
}

// =============================================================================
// Host stubs
// =============================================================================

const HOME = String.raw`D:\dsh\.dsh_home`
const PROFILES = ['desktop', 'web', 'dsh-tui']
const ACTIVE = 'desktop'

/**
 * One server row. The default shape is the **real** host shape produced by
 * `host-core.mergeServers`:
 *   { id, serverName, transport, config, location, layers, profiles, matrix,
 *     effective, disabled, layoutDrift, copies }
 * `enabled` / `staticState` / `toolCountEstimate` belong to the earlier contract
 * and are NOT produced by the host today — the panel has to accept both, so the
 * fixture exercises both (rows below that omit them prove the fallbacks).
 */
function server(overrides) {
  const row = Object.assign({
    id: 'mcp-example',
    serverName: 'example',
    transport: 'stdio',
    config: { serverName: 'example', transport: 'stdio', command: 'npx', args: ['-y', 'example-mcp'] },
    location: 'home',
    layers: ['home'],
    profiles: PROFILES.slice(),
    matrix: { desktop: true, web: true, 'dsh-tui': true },
    effective: { desktop: true, web: true, 'dsh-tui': true },
    disabled: false,
    layoutDrift: null,
    copies: 1,
  }, overrides || {})
  // 真实宿主半把顶层字段从 config 派生出来；桩数据保持一致，免得面板读 config 时拿到旧值。
  row.config = Object.assign({}, row.config, { serverName: row.serverName, transport: row.transport })
  return row
}

/** The six pre-existing rows A6.2 talks about (five home rows + one profile row). */
function existingServers() {
  return [
    // home 层 disabled:true → 矩阵全 false、生效集合为空。
    server({
      id: 'mcp-Serena',
      serverName: 'Serena',
      matrix: { desktop: false, web: false, 'dsh-tui': false },
      effective: { desktop: false, web: false, 'dsh-tui': false },
      profiles: [],
      disabled: true,
      staticState: 'disabled',
      toolCountEstimate: 0,
      layoutDrift: { code: 'DUPLICATE_ID', message: 'home 层同 id mcp-Serena 出现多次', layers: ['home'] },
    }),
    server({ id: 'mcp-context7', serverName: 'context7', toolCountEstimate: 12, config: { serverName: 'context7', transport: 'stdio', command: 'npx', args: ['-y', '@upstash/context7-mcp'] } }),
    // 宿主不提供 staticState / toolCountEstimate → 面板必须回退成「未上报」与「—」。
    server({ id: 'mcp-chrome-devtools', serverName: 'chrome-devtools' }),
    server({ id: 'mcp-sqlite', serverName: 'sqlite' }),
    server({ id: 'mcp-fetch', serverName: 'fetch', staticState: 'failed' }),
    // 只在 profile 层存在：生效集合不含 desktop（A6.2 要的那条）。
    server({
      id: 'mcp-brave-search',
      serverName: 'brave-search',
      transport: 'streamable-http',
      config: { serverName: 'brave-search', transport: 'streamable-http', url: 'https://mcp.example.test/brave' },
      location: 'profile',
      layers: ['web'],
      profiles: ['web'],
      matrix: { desktop: false, web: true, 'dsh-tui': false },
      effective: { desktop: false, web: true, 'dsh-tui': false },
      copies: 1,
    }),
  ]
}

function listData(overrides) {
  return Object.assign({
    home: HOME,
    profile: ACTIVE,
    profileDir: HOME + '\\profiles\\' + ACTIVE,
    profiles: PROFILES.slice(),
    servers: existingServers(),
    defaults: { toolCallTimeoutMs: 60000, failOnStartupError: false, maxInstructionBytes: 32768, probeTimeoutMs: 8000, defaultTransport: 'stdio' },
    // 真实宿主半的 diagnostics 是对象（见 src/index.js 的 diagPayload）。
    diagnostics: {
      plugin: 'dsh-mcp-manager',
      anchorSource: 'config',
      coreAvailable: true,
      httpRegistered: true,
      httpSkipped: null,
      toolsRegistered: true,
      toolsSkipped: null,
      lastError: null,
      state: { path: HOME + String.raw`\.mcp-manager\state.json`, ok: true, error: null },
      anchorErrors: [],
      mergeConflicts: [],
      mergeSanitizedRows: 0,
      lastProbe: null,
    },
    // 真实形状：{ home: fileInfo, profiles: { <name>: fileInfo } }。
    patchInfo: {
      home: { target: 'home', path: HOME + String.raw`\cordis.patch.yml`, exists: true, ok: true, entries: [{ id: 'mcp-Serena' }], backups: 0 },
      profiles: {
        desktop: { target: 'desktop', path: HOME + String.raw`\profiles\desktop\cordis.patch.yml`, exists: true, ok: true, entries: [], backups: 0 },
        web: { target: 'web', path: HOME + String.raw`\profiles\web\cordis.patch.yml`, exists: false, ok: true, entries: [], backups: 0 },
      },
    },
  }, overrides || {})
}

const ok = (data) => ({ body: { ok: true, data } })
const fail = (error, extra) => ({ body: Object.assign({ ok: false, error }, extra || {}) })

const calls = []
let route = () => ok(listData())

function installFetch() {
  globalThis.fetch = async (url, init) => {
    const request = JSON.parse(String(init && init.body))
    const call = { url, method: init.method, headers: init.headers, action: request.action, payload: request.payload }
    calls.push(call)
    const reply = (await route(call)) || {}
    if (reply.networkError) throw new Error(reply.networkError)
    const status = reply.status || 200
    return {
      ok: status >= 200 && status < 300,
      status,
      async json() {
        if (reply.jsonThrows) throw new Error('Unexpected end of JSON input')
        return reply.body === undefined ? null : reply.body
      },
    }
  }
}

function makeLocale() {
  const registered = []
  const listeners = []
  return {
    registered,
    register(ns, dict) { registered.push({ ns, dict }); return () => {} },
    translate(ns, key) {
      const dict = registered.length ? registered[registered.length - 1].dict : null
      const table = dict && (dict.zh || dict.en)
      return table && typeof table[key] === 'string' ? table[key] : key
    },
    subscribe(fn) { listeners.push(fn); return () => {} },
  }
}

/** Fake client ctx: services through get(), the tab captured, locale inject deferred. */
function makeClientCtx({ locale, injectImmediately = true } = {}) {
  const registered = []
  const injected = []
  const deferred = []
  const services = { locale }
  const scope = { get: (n) => services[n], effect: (fn) => fn(), on: () => {} }
  return {
    registered,
    injected,
    deferred,
    get: (n) => services[n],
    effect: (fn) => fn(),
    on: () => {},
    inject: (names, fn) => {
      injected.push(names)
      if (injectImmediately) fn(scope)
      else deferred.push(fn)
    },
    slots: {
      inject: (name, build) => { build() },
      register: (options, component) => { registered.push({ options, component }); return { dispose() {} } },
    },
  }
}

/**
 * Boot the bundle (fresh module scope per call), apply it, mount the registered
 * tab against a stubbed fetch, and let the first `list` land.
 */
async function boot({ locale, data, handler, overrides } = {}) {
  calls.length = 0
  confirmations.length = 0
  confirmAnswer = true
  route = handler || (() => ok(data || listData(overrides)))
  installFetch()
  const ctx = makeClientCtx({ locale })
  const exports = factories.get(PKG_ID)(requireStub)
  exports.apply(ctx)
  const hooks = globalThis.window.__dshMcpManager
  const tab = ctx.registered.find((item) => item.options.name === 'settings.localPlugins.tab')
  assert.ok(tab, 'the panel was not registered on settings.localPlugins.tab')
  mountPanel(tab.component, {})
  await settle()
  return { ctx, exports, hooks, tab }
}

// =============================================================================
// Manifest + slot
// =============================================================================

test('client bundle registers the module id and the cordis contract', () => {
  assert.ok(factories.has(PKG_ID), 'no __ModuleLoader__.load for "' + PKG_ID + '"')
  const exports = factories.get(PKG_ID)(requireStub)
  assert.equal(typeof exports.apply, 'function')
  assert.deepEqual(exports.inject, ['slots'])
})

test('manifest keeps the local sub-plugin contract and declares no dsh.bundle', () => {
  const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  assert.equal(manifest.name, PKG_ID)
  assert.equal(manifest.main, 'src/index.js')
  assert.equal(manifest.exports['.'], './src/index.js')
  assert.equal(manifest.exports['./client'], './src/client.js')
  assert.equal(manifest.dsh.client.platform, 'web')
  assert.equal(manifest.dsh.bundle, undefined, 'a sub-plugin must not declare dsh.bundle')
  assert.equal(fs.existsSync(path.join(root, 'cordis.patch.yml')), false, 'a sub-plugin must not ship its own cordis.patch.yml')
})

test('apply contributes one tab to settings.localPlugins.tab and registers both dictionaries', () => {
  const locale = makeLocale()
  const ctx = makeClientCtx({ locale })
  const exports = factories.get(PKG_ID)(requireStub)
  exports.apply(ctx)
  const tab = ctx.registered.find((item) => item.options.name === 'settings.localPlugins.tab')
  assert.ok(tab, 'settings.localPlugins.tab was not registered')
  assert.equal(tab.options.id, 'mcp-servers')
  assert.equal(tab.options.order, 30)
  assert.equal(typeof tab.options.label, 'function')
  assert.equal(tab.options.label(), 'MCP 服务器')
  assert.equal(typeof tab.component, 'function')
  const dict = locale.registered.find((item) => item.ns === PKG_ID)
  assert.ok(dict, 'no locale dictionary registered for ' + PKG_ID)
  assert.equal(dict.dict.zh['tab.title'], 'MCP 服务器')
  assert.equal(dict.dict.en['tab.title'], 'MCP servers')
  assert.equal(typeof dict.dict.zh['matrixReloadHint'], 'string')
  assert.equal(typeof dict.dict.en['matrixReloadHint'], 'string')
})

// =============================================================================
// list render (A6.1 / A6.2)
// =============================================================================

test('the first paint calls list only — probing stays on demand', async () => {
  await boot({ locale: makeLocale() })
  assert.deepEqual(calls.map((call) => call.action), ['list'])
  assert.equal(calls[0].url, API)
  assert.equal(calls[0].method, 'POST')
  assert.equal(calls[0].headers['x-dsh-plugin'], PKG_ID)
  assert.equal(calls[0].headers['content-type'], 'application/json')
  assert.deepEqual(calls[0].payload, {})
  assert.equal(calls.filter((call) => call.action === 'tools').length, 0, 'the tool dialog must not be prefetched')
  assert.equal(calls.filter((call) => call.action === 'probe').length, 0, 'no row may be probed on load')
})

test('all six managed servers render with the spec columns', async () => {
  await boot({ locale: makeLocale() })
  const rows = all().filter((node) => node.props['data-card'] !== undefined)
  assert.equal(rows.length, 6, 'expected the six pre-existing rows')
  for (const id of ['mcp-Serena', 'mcp-context7', 'mcp-chrome-devtools', 'mcp-sqlite', 'mcp-fetch', 'mcp-brave-search']) {
    assert.ok(cardOf(id), 'missing row for ' + id)
    assert.equal(cellOf('data-entry-id', id), '条目 id：' + id)
    assert.ok(cellOf('data-server-name', id).indexOf('serverName：') === 0, id + ' lost its serverName cell')
    assert.ok(cellOf('data-transport', id).indexOf('transport：') === 0, id + ' lost its transport cell')
    assert.ok(cellOf('data-location', id).indexOf('来源层：') === 0, id + ' lost its layer cell')
    assert.ok(cellOf('data-profiles', id).indexOf('生效 profile：') === 0, id + ' lost its profiles cell')
    assert.ok(cellOf('data-state', id).indexOf('静态状态：') === 0, id + ' lost its state cell')
    assert.ok(cellOf('data-tools', id).indexOf('工具数估计：') === 0, id + ' lost its tools cell')
  }
  assert.equal(cellOf('data-transport', 'mcp-brave-search'), 'transport：streamable-http')
  assert.equal(cellOf('data-location', 'mcp-brave-search'), '来源层：仅 profile 覆盖 · web')
  assert.equal(cellOf('data-tools', 'mcp-context7'), '工具数估计：12 个')
  assert.equal(cellOf('data-tools', 'mcp-Serena'), '工具数估计：—', 'a zero estimate must render as a dash')
  assert.equal(cellOf('data-state', 'mcp-chrome-devtools'), '静态状态：—', 'a missing loader state renders as a dash, not a host complaint')
  assert.equal(cellOf('data-state', 'mcp-fetch'), '静态状态：失败')
  assert.equal(cellOf('data-state', 'mcp-Serena'), '静态状态：已停用', 'a disabled row falls back to disabled when no loader state exists')
})

test('the profile-layer row is not effective in the active profile (A6.2)', async () => {
  await boot({ locale: makeLocale() })
  const profiles = cellOf('data-profiles', 'mcp-brave-search')
  assert.ok(profiles.indexOf('web') !== -1, 'the profile-layer row must list its own profile')
  assert.ok(profiles.indexOf(ACTIVE) === -1, 'the profile-layer row must not claim the active profile')
  assert.equal(profiles, '生效 profile：web')
  assert.equal(cellOf('data-profiles', 'mcp-context7'), '生效 profile：3 个 profile · 全部 profile')
})

test('a row present in both layers is flagged as layout drift (location=conflict)', async () => {
  const row = server({
    id: 'mcp-conflict',
    serverName: 'conflict',
    location: 'conflict',
    layers: ['home', 'web'],
    layoutDrift: {
      code: 'E_CROSS_LAYER',
      message: '同一 id 同时存在于 home + web：重复的 loader 条目 id 会导致启动失败，请修复',
      layers: ['home', 'web'],
      action: '移除其中一层',
      target: 'web/cordis.patch.yml',
    },
  })
  await boot({ locale: makeLocale(), data: listData({ servers: [row] }) })
  assert.equal(cellOf('data-location', 'mcp-conflict'), '来源层：两层同时存在（布局漂移） · home + web')
  const text = textOf(cardOf('mcp-conflict'))
  assert.ok(text.indexOf('布局待修复') !== -1, 'the drift must be labelled')
  assert.ok(text.indexOf('同一 id 同时存在于 home + web') !== -1, 'the drift message must be shown')
  assert.ok(text.indexOf('移除其中一层') !== -1, 'the suggested action must be shown')
  assert.ok(text.indexOf('web/cordis.patch.yml') !== -1, 'the drift target file must be shown')
})

test('the earlier contract shape (enabled / staticState / toolCountEstimate) still renders', async () => {
  const row = server({ id: 'mcp-contract', serverName: 'contract', enabled: true, staticState: 'active', toolCountEstimate: 7 })
  delete row.disabled
  await boot({ locale: makeLocale(), data: listData({ servers: [row] }) })
  assert.equal(cellOf('data-state', 'mcp-contract'), '静态状态：已激活')
  assert.equal(cellOf('data-tools', 'mcp-contract'), '工具数估计：7 个')
  assert.equal(withProp('data-field', 'enabled')[0].props['aria-checked'], 'true', 'a row without `disabled` must still read as enabled')
})

test('the disabled row and the drifted row are marked, and the raw YAML entry exists', async () => {
  await boot({ locale: makeLocale() })
  const serena = textOf(cardOf('mcp-Serena'))
  assert.ok(serena.indexOf('未启用') !== -1, 'a disabled row must be labelled')
  assert.ok(serena.indexOf('布局待修复') !== -1, 'a drifted row must be labelled')
  assert.ok(serena.indexOf('布局漂移') === -1 || serena.indexOf('布局待修复') !== -1)
  assert.ok(textOf(cardOf('mcp-context7')).indexOf('未启用') === -1, 'an enabled row must not be labelled disabled')
  for (const id of ['mcp-Serena', 'mcp-context7']) {
    assert.ok(withProp('data-raw', id).length === 1, 'row ' + id + ' has no raw-YAML entry')
  }
  assert.ok(treeText().indexOf('本 profile：desktop') !== -1, 'the header must name the active profile')
  assert.ok(treeText().indexOf('共 6 台') !== -1, 'the header must count the rows')
  assert.ok(treeText().indexOf('5/6 台已启用') !== -1, 'the header must count the enabled rows')
})

test('the raw YAML entry opens the config YAML (no insert shell) with the new contract', async () => {
  await boot({ locale: makeLocale() })
  const button = withProp('data-raw', 'mcp-Serena')[0]
  button.props.onClick()
  await settle(3)
  const area = withProp('data-raw-yaml', 'mcp-Serena')[0]
  assert.ok(area, 'the raw YAML textarea did not open')
  const text = String(area.props.value)
  assert.ok(text.indexOf('serverName: Serena') === 0, 'the config YAML must start with serverName')
  assert.ok(text.indexOf('transport: stdio') !== -1, 'the config YAML must carry the transport')
  assert.ok(text.indexOf('command: npx') !== -1, 'the config YAML must carry the command')
  assert.ok(text.indexOf('- insert:') === -1, 'the yaml payload must NOT carry the insert shell')
  assert.ok(text.indexOf('# dsh-mcp-manager') === -1, 'the yaml payload must NOT carry the ownership marker')
  assert.ok(withProp('data-field', 'serverName').length === 1, 'the edit form must open with the row pre-filled')
  assert.ok(treeText().indexOf('宿主做结构化校验') !== -1, 'the raw editor must state the host-side validation contract')
})

test('editing the raw YAML submits the yaml field with the pinned request shape', async () => {
  await boot({ locale: makeLocale(), handler: (call) => (call.action === 'list' ? ok(listData()) : ok({})) })
  withProp('data-raw', 'mcp-Serena')[0].props.onClick()
  await settle(3)
  const area = withProp('data-raw-yaml', 'mcp-Serena')[0]
  area.props.onChange({ target: { value: 'serverName: Serena\ntransport: stdio\ncommand: uvx\n' } })
  await settle(2)
  buttonByText('保存').props.onClick()
  await settle(6)
  const call = calls.filter((item) => item.action === 'update').pop()
  assert.ok(call, 'the yaml edit must post an update')
  assert.equal(call.url, '/__dsh-mcp-manager/api')
  assert.equal(call.method, 'POST')
  assert.equal(call.headers['content-type'], 'application/json')
  assert.equal(call.headers['x-dsh-plugin'], 'dsh-mcp-manager')
  assert.equal(call.payload.id, 'mcp-Serena')
  assert.equal(call.payload.yaml, 'serverName: Serena\ntransport: stdio\ncommand: uvx\n')
  assert.ok(call.payload.yaml.indexOf('- insert:') === -1, 'the submitted yaml must be the bare config')
})

test('a bad-yaml rejection keeps the raw input and shows the host field errors', async () => {
  const failure = { ok: false, error: { code: 'bad-yaml', message: '配置校验未通过', fields: { command: '必须是字符串' } } }
  await boot({ locale: makeLocale(), handler: (call) => (call.action === 'list' ? ok(listData()) : { body: failure }) })
  withProp('data-raw', 'mcp-Serena')[0].props.onClick()
  await settle(3)
  const area = withProp('data-raw-yaml', 'mcp-Serena')[0]
  const typed = 'serverName: Serena\ncommand: [1, 2\n'
  area.props.onChange({ target: { value: typed } })
  await settle(2)
  buttonByText('保存').props.onClick()
  await settle(6)
  assert.ok(withProp('data-raw-errors', 'mcp-Serena').length === 1, 'the raw sub-page must list the host field errors')
  assert.ok(treeText().indexOf('command：必须是字符串') !== -1, 'the offending field must be named')
  const kept = withProp('data-raw-yaml', 'mcp-Serena')[0]
  assert.ok(kept, 'the raw sub-page must stay open after a rejection')
  assert.equal(String(kept.props.value), typed, 'the user input must be kept verbatim')
})

test('the host loader state and tool estimate render when the host reports them', async () => {
  await boot({
    locale: makeLocale(),
    data: Object.assign({}, listData(), {
      servers: [
        server({ id: 'mcp-a', serverName: 'a', staticState: 'active', toolCountEstimate: 7 }),
        server({ id: 'mcp-b', serverName: 'b', staticState: 'failed' }),
        server({ id: 'mcp-c', serverName: 'c', staticState: 'disabled' }),
        server({ id: 'mcp-d', serverName: 'd', staticState: 'pending' }),
        server({ id: 'mcp-e', serverName: 'e', staticState: 'loading' }),
      ],
    }),
  })
  assert.equal(cellOf('data-state', 'mcp-a'), '静态状态：已激活')
  assert.equal(cellOf('data-tools', 'mcp-a'), '工具数估计：7 个')
  assert.equal(cellOf('data-state', 'mcp-b'), '静态状态：失败')
  assert.equal(cellOf('data-tools', 'mcp-b'), '工具数估计：—')
  assert.equal(cellOf('data-state', 'mcp-c'), '静态状态：已停用')
  assert.equal(cellOf('data-state', 'mcp-d'), '静态状态：未加载')
  assert.equal(cellOf('data-state', 'mcp-e'), '静态状态：加载中')
})

test('missing or null state fields render a dash instead of blaming the host', async () => {
  await boot({
    locale: makeLocale(),
    data: Object.assign({}, listData(), {
      servers: [
        server({ id: 'mcp-null', serverName: 'nullstate', staticState: null, toolCountEstimate: null }),
        server({ id: 'mcp-absent', serverName: 'absent' }),
      ],
    }),
  })
  const absent = server({ id: 'x', serverName: 'x' })
  delete absent.staticState
  delete absent.toolCountEstimate
  assert.equal(cellOf('data-state', 'mcp-null'), '静态状态：—')
  assert.equal(cellOf('data-tools', 'mcp-null'), '工具数估计：—')
  assert.equal(cellOf('data-state', 'mcp-absent'), '静态状态：—')
  assert.equal(cellOf('data-tools', 'mcp-absent'), '工具数估计：—')
  assert.equal(treeText().indexOf('未上报'), -1, 'the panel must not complain about the host')
  assert.ok(cardOf('mcp-null') && cardOf('mcp-absent'), 'both rows must still render')
})

test('a successful list shows the host diagnostics too', async () => {
  await boot({ locale: makeLocale() })
  assert.ok(treeText().indexOf('宿主诊断') !== -1)
  assert.ok(treeText().indexOf('plugin: dsh-mcp-manager') !== -1)
  assert.ok(treeText().indexOf('httpRegistered: true') !== -1)
  assert.ok(treeText().indexOf('state: path=') !== -1, 'nested diagnostic objects must be flattened, not dumped as JSON')
})

// =============================================================================
// Write paths
// =============================================================================

test('the enable switch posts setEnabled with the next value', async () => {
  await boot({ locale: makeLocale() })
  const toggle = all().find((node) => node.props['data-field'] === 'enabled' && node.props['data-target'] === 'mcp-context7')
  assert.ok(toggle, 'no enable switch on the row')
  assert.equal(toggle.props['aria-checked'], 'true')
  toggle.props.onClick()
  await settle()
  const call = calls.find((item) => item.action === 'setEnabled')
  assert.ok(call, 'setEnabled was not posted')
  assert.deepEqual(call.payload, { id: 'mcp-context7', enabled: false })
})

test('a matrix change touching another profile asks first and then posts setMatrix (A6.4)', async () => {
  await boot({ locale: makeLocale() })
  const box = checkboxes().find((node) => node.props['data-server'] === 'mcp-context7' && node.props['data-profile'] === 'web')
  assert.ok(box, 'no matrix checkbox for context7 × web')
  assert.equal(box.props.checked, true)

  confirmAnswer = false
  box.props.onChange()
  await settle()
  assert.equal(confirmations.length, 1, 'a cross-profile write must ask for confirmation')
  assert.ok(confirmations[0].indexOf('本 profile 热生效、其它 profile 待其自身重载') !== -1, 'the confirmation must spell out the reload scope')
  assert.equal(calls.filter((item) => item.action === 'setMatrix').length, 0, 'cancelling must not write')

  confirmAnswer = true
  all().find((node) => node.props['data-server'] === 'mcp-context7' && node.props['data-profile'] === 'web').props.onChange()
  await settle()
  const call = calls.find((item) => item.action === 'setMatrix')
  assert.ok(call, 'setMatrix was not posted after confirming')
  assert.equal(call.payload.id, 'mcp-context7')
  assert.equal(call.payload.matrix.web, false, 'the toggled profile must be turned off')
  assert.equal(call.payload.matrix.desktop, true, 'other profiles must be carried over unchanged')
  assert.ok(treeText().indexOf('本 profile 热生效；其它 profile 待其自身重载。') !== -1, 'the panel must state the reload scope')
})

test('a matrix change confined to the active profile does not ask', async () => {
  // 落点就是本 profile，且取消勾选后仍只写本 profile ⇒ 不该弹确认。
  const own = [server({ id: 'mcp-local', serverName: 'local', location: ACTIVE, matrix: { desktop: true, web: true, 'dsh-tui': false } })]
  await boot({ locale: makeLocale(), data: listData({ servers: own }) })
  const box = checkboxes().find((node) => node.props['data-server'] === 'mcp-local' && node.props['data-profile'] === 'web')
  assert.ok(box, 'no matrix checkbox for the local server')
  confirmAnswer = true
  box.props.onChange()
  await settle()
  assert.equal(confirmations.length, 0, 'a same-profile write must not nag')
  const call = calls.find((item) => item.action === 'setMatrix')
  assert.ok(call)
  assert.equal(call.payload.matrix.web, false)
  assert.equal(call.payload.matrix.desktop, true)
})

test('delete asks for confirmation and posts remove with confirm:true', async () => {
  await boot({ locale: makeLocale() })
  const remove = buttons().find((node) => node.props['data-card'] === undefined && textOf(node) === '删除' && node.props['data-raw'] === undefined)
  assert.ok(remove, 'no delete button on the row')
  confirmAnswer = false
  remove.props.onClick()
  await settle()
  assert.equal(confirmations.length, 1)
  assert.equal(calls.filter((item) => item.action === 'remove').length, 0, 'cancelling must not delete')

  confirmAnswer = true
  buttons().find((node) => textOf(node) === '删除').props.onClick()
  await settle()
  const call = calls.find((item) => item.action === 'remove')
  assert.ok(call, 'remove was not posted after confirming')
  assert.deepEqual(call.payload, { id: 'mcp-Serena', confirm: true })
  assert.ok(treeText().indexOf('已删除 mcp-Serena') !== -1, 'the panel must report the deletion')
})

test('test connection posts probe for one row and shows latency plus tool count', async () => {
  await boot({
    locale: makeLocale(),
    handler: (call) => (call.action === 'probe'
      ? ok({ ok: true, latencyMs: 42, toolCount: 7 })
      : ok(listData())),
  })
  const probe = withProp('data-probe', 'mcp-context7')[0]
  assert.ok(probe, 'no test-connection button on the row')
  assert.ok(treeText().indexOf('会真的起一次子进程') !== -1, 'the panel must warn about the child process')
  probe.props.onClick()
  await settle()
  const call = calls.find((item) => item.action === 'probe')
  assert.ok(call, 'probe was not posted')
  assert.deepEqual(call.payload, { id: 'mcp-context7' })
  assert.equal(calls.filter((item) => item.action === 'probe').length, 1, 'one click, one probe')
  assert.ok(treeText().indexOf('42ms') !== -1, 'the latency must be shown')
  assert.ok(treeText().indexOf('7 个工具') !== -1, 'the tool count must be shown')
})

test('a failed probe renders its reason without touching the rows', async () => {
  await boot({
    locale: makeLocale(),
    handler: (call) => (call.action === 'probe'
      ? ok({ ok: false, latencyMs: 8001, error: 'spawn npx ENOENT' })
      : ok(listData())),
  })
  withProp('data-probe', 'mcp-fetch')[0].props.onClick()
  await settle()
  assert.ok(treeText().indexOf('spawn npx ENOENT') !== -1, 'the probe error must be visible')
  assert.ok(treeText().indexOf('8001ms') !== -1)
  assert.equal(all().filter((node) => node.props['data-card'] !== undefined).length, 6, 'rows must survive a failed probe')
})

// =============================================================================
// Forms
// =============================================================================

test('the add form prefills the global defaults and refuses an incomplete save', async () => {
  await boot({ locale: makeLocale() })
  buttonByText('新增服务器').props.onClick()
  await settle(3)
  assert.equal(withProp('data-field', 'serverName')[0].props.value, '')
  assert.equal(withProp('data-field', 'transport')[0].props.value, 'stdio')
  assert.equal(withProp('data-field', 'toolCallTimeoutMs')[0].props.value, '60000', 'defaults must prefill the form')
  assert.equal(withProp('data-field', 'maxInstructionBytes')[0].props.value, '32768')
  buttonByText('保存').props.onClick()
  await settle()
  assert.equal(calls.filter((item) => item.action === 'add').length, 0, 'an invalid form must not be posted')
  assert.ok(treeText().indexOf('请先补齐表单') !== -1, 'the validation failure must be visible')
  assert.ok(treeText().indexOf('请填写 serverName。') !== -1)
  assert.ok(treeText().indexOf('stdio 传输必须填 command。') !== -1)
})

test('a valid add posts the generated config and the matrix intent', async () => {
  await boot({ locale: makeLocale() })
  buttonByText('新增服务器').props.onClick()
  await settle(3)
  withProp('data-field', 'serverName')[0].props.onChange({ target: { value: 'playwright' } })
  await settle(2)
  withProp('data-field', 'command')[0].props.onChange({ target: { value: 'npx' } })
  await settle(2)
  const argsArea = all().find((node) => node.type === 'textarea' && String(node.props.value || '').indexOf('mcp') === -1)
  assert.ok(argsArea, 'no args textarea')
  argsArea.props.onChange({ target: { value: '-y\n@playwright/mcp' } })
  await settle(2)
  buttonByText('保存').props.onClick()
  await settle()
  const call = calls.find((item) => item.action === 'add')
  assert.ok(call, 'add was not posted')
  assert.equal(call.payload.id, 'mcp-playwright', 'a blank id must default to mcp-<serverName>')
  assert.equal(call.payload.serverName, 'playwright')
  assert.equal(call.payload.transport, 'stdio')
  assert.deepEqual(call.payload.config.args, ['-y', '@playwright/mcp'])
  assert.equal(call.payload.config.command, 'npx')
  assert.equal(call.payload.config.toolCallTimeoutMs, 60000, 'the form value lands inside the entry config')
  assert.deepEqual(call.payload.matrix, { desktop: true, web: true, 'dsh-tui': true }, 'the home level means every profile')
  assert.ok(treeText().indexOf('已新增 mcp-playwright') !== -1)
})

test('the defaults panel loads and saves the global defaults', async () => {
  await boot({ locale: makeLocale() })
  buttonByText('全局默认参数').props.onClick()
  await settle()
  assert.equal(calls.filter((item) => item.action === 'getDefaults').length, 1, 'opening the panel reads the defaults')
  assert.equal(withProp('data-field', 'defaults.toolCallTimeoutMs')[0].props.value, '60000')
  assert.equal(withProp('data-field', 'defaults.probeTimeoutMs')[0].props.value, '8000')
  withProp('data-field', 'defaults.probeTimeoutMs')[0].props.onChange({ target: { value: '12000' } })
  await settle(2)
  withProp('data-field', 'defaults.failOnStartupError')[0].props.onClick()
  await settle(2)
  buttonByText('保存默认参数').props.onClick()
  await settle()
  const call = calls.find((item) => item.action === 'setDefaults')
  assert.ok(call, 'setDefaults was not posted')
  assert.equal(call.payload.defaults.probeTimeoutMs, 12000)
  assert.equal(call.payload.defaults.failOnStartupError, true)
  assert.equal(call.payload.defaults.toolCallTimeoutMs, 60000)
  assert.equal(call.payload.defaults.defaultTransport, 'stdio')
  assert.ok(treeText().indexOf('默认参数已保存') !== -1)
})

test('migration previews the plan, then applies it on confirmation', async () => {
  await boot({
    locale: makeLocale(),
    handler: (call) => (call.action === 'migrate'
      ? ok({
          applied: call.payload.apply === true,
          files: [{ target: 'home', path: HOME + String.raw`\cordis.patch.yml`, exists: true, changed: true, stats: { relabeled: 2, tagged: 1, converged: 4, skipped: [{ reason: 'already v2', count: 3 }] } }],
          totals: { relabeled: 2, tagged: 1, converged: 4 },
          writes: [],
          changed: true,
        })
      : ok(listData())),
  })
  buttonByText('迁移旧标记').props.onClick()
  await settle()
  assert.deepEqual(calls.find((item) => item.action === 'migrate').payload, { apply: false }, 'the preview must ask for apply:false, never an empty payload')
  assert.ok(treeText().indexOf('将改写 2 条、补齐 1 条、收敛 4 条、跳过 3 条。') !== -1, 'the plan must be shown')
  assert.ok(treeText().indexOf('.bak-<时间戳>') !== -1, 'the backup promise must be shown')
  assert.ok(treeText().indexOf('already v2') !== -1, 'the skip reasons must be shown')
  buttonByText('确认').props.onClick()
  await settle()
  const applied = calls.filter((item) => item.action === 'migrate')
  assert.equal(applied.length, 2)
  assert.equal(applied[1].payload.apply, true)
  assert.ok(treeText().indexOf('迁移完成：改写 2、补齐 1、收敛 4、跳过 3') !== -1)
})

test('the write-target panel reads patchInfo and falls back to the list payload', async () => {
  await boot({
    locale: makeLocale(),
    handler: (call) => (call.action === 'patchInfo'
      ? fail({ code: 'unsupported', message: 'patchInfo is not available' })
      : ok(listData())),
  })
  buttonByText('写入位置').props.onClick()
  await settle()
  assert.equal(calls.filter((item) => item.action === 'patchInfo').length, 1)
  assert.ok(treeText().indexOf(String.raw`\cordis.patch.yml`) !== -1, 'the fallback must come from list')
  assert.ok(treeText().indexOf('宿主端点不可用') !== -1, 'the failed patchInfo must be reported')
})

// =============================================================================
// Degradation (A6.3)
// =============================================================================

test('an unreachable endpoint renders the reason, the diagnostics and never throws', async () => {
  await boot({
    locale: makeLocale(),
    handler: () => ({ status: 404, jsonThrows: true }),
  })
  assert.ok(treeText().indexOf('宿主端点不可用') !== -1, 'the panel must name the failure')
  assert.ok(treeText().indexOf('错误码：host-unavailable') !== -1, 'the panel must carry a code')
  assert.ok(treeText().indexOf('HTTP 404') !== -1, 'the panel must carry the status instead of a JSON parse error')
  assert.ok(treeText().indexOf('宿主诊断') !== -1, 'the diagnostics section must still render')
  assert.ok(treeText().indexOf(API) !== -1, 'the endpoint must be named')
  assert.ok(errors.length >= 0)
  assert.equal(unhandled.length, 0, 'the failure path must not leak a rejection')
})

test('a host error payload shows its code, message and fields', async () => {
  await boot({
    locale: makeLocale(),
    handler: () => fail(
      { code: 'invalid-config', message: '配置校验失败', fields: { url: '必须是 http(s) 地址' } },
      { diagnostics: ['profile: web/cordis.patch.yml 第 12 行无法定位行块'] },
    ),
  })
  assert.ok(treeText().indexOf('invalid-config') !== -1)
  assert.ok(treeText().indexOf('配置校验失败') !== -1)
  assert.ok(treeText().indexOf('url: 必须是 http(s) 地址') !== -1)
  assert.ok(treeText().indexOf('web/cordis.patch.yml 第 12 行无法定位行块') !== -1, 'error diagnostics must be shown')
})

test('a network failure is reported, not thrown', async () => {
  await boot({ locale: makeLocale(), handler: () => ({ networkError: 'Failed to fetch' }) })
  assert.ok(treeText().indexOf('宿主端点不可用') !== -1)
  assert.ok(treeText().indexOf('Failed to fetch') !== -1)
})

test('an unparseable patch turns the panel read-only instead of blank', async () => {
  await boot({
    locale: makeLocale(),
    data: listData({ patchInfo: { home: { target: 'home', path: HOME + String.raw`\cordis.patch.yml`, exists: true, ok: false, error: 'home: 第 3 行不是合法 YAML' }, profiles: {} } }),
  })
  assert.ok(treeText().indexOf('只读降级') !== -1, 'the read-only notice must render')
  assert.ok(treeText().indexOf('第 3 行不是合法 YAML') !== -1, 'the reason must be shown')
  assert.equal(buttonByText('新增服务器').props.disabled, true, 'write entry points must lock')
  assert.equal(withProp('data-field', 'enabled')[0].props.disabled, true, 'row switches must lock')
})

test('an empty server list renders the empty state', async () => {
  await boot({ locale: makeLocale(), data: listData({ servers: [], patchInfo: null, diagnostics: null }) })
  assert.ok(treeText().indexOf('本机还没有受管的 MCP 服务器') !== -1)
  assert.ok(treeText().indexOf('新增服务器') !== -1, 'the add entry point must stay reachable')
  assert.equal(all().filter((node) => node.props['data-card'] !== undefined).length, 0)
})

test('without a locale service the panel falls back to English when the browser is English', async () => {
  navigatorStub.languages = ['en-US']
  navigatorStub.language = 'en-US'
  try {
    const session = await boot({})
    assert.equal(session.tab.options.label(), 'MCP servers', 'the tab label must use the English dictionary')
    assert.ok(treeText().indexOf('Managed MCP definitions live in the profile') !== -1, 'the English dictionary must be used')
    assert.ok(treeText().indexOf('Add server') !== -1)
    assert.ok(treeText().indexOf('Enable matrix') !== -1)
    assert.ok(treeText().indexOf('本 profile 热生效') === -1, 'no Chinese string may leak into the English face')
  } finally {
    navigatorStub.languages = ['zh-CN']
    navigatorStub.language = 'zh-CN'
  }
})

test('a late locale service is adopted through the deferred inject', async () => {
  const late = makeLocale()
  const ctx = makeClientCtx({ locale: undefined, injectImmediately: false })
  const exports = factories.get(PKG_ID)(requireStub)
  exports.apply(ctx)
  assert.equal(ctx.deferred.length, 1, 'locale must be injected lazily when absent at apply time')
  ctx.deferred[0]({ get: (name) => (name === 'locale' ? late : undefined), effect: (fn) => fn(), on: () => {} })
  assert.equal(late.registered.length, 1, 'the late service must receive the dictionaries')
  assert.equal(late.registered[0].dict.en['tab.title'], 'MCP servers')
})

test('the tools button opens one dialog and asks the host exactly once', async () => {
  const toolsPayload = {
    mode: 'static',
    tools: [
      { name: 'mcp__context7__resolve-library-id', description: 'Resolve a package name to a Context7 library id' },
      { name: 'mcp__context7__get-library-docs', description: 'Fetch up-to-date documentation for a library' },
    ],
    note: '静态清单为估计值（取自核心工具注册表）',
  }
  await boot({
    locale: makeLocale(),
    handler: (call) => (call.action === 'tools' ? ok(toolsPayload) : ok(listData())),
  })
  assert.deepEqual(calls.map((call) => call.action), ['list'], 'the first paint must only call list')
  const button = all().find((node) => node.props['data-tools-open'] === 'mcp-context7')
  assert.ok(button, 'every row must expose a tools button')
  assert.equal(textOf(button), '工具')
  button.props.onClick()
  await settle()
  const toolsCalls = calls.filter((call) => call.action === 'tools')
  assert.equal(toolsCalls.length, 1, 'opening the dialog must ask the host exactly once')
  assert.equal(toolsCalls[0].url, API)
  assert.equal(toolsCalls[0].method, 'POST')
  assert.equal(toolsCalls[0].headers['x-dsh-plugin'], PKG_ID)
  assert.deepEqual(toolsCalls[0].payload, { id: 'mcp-context7' }, 'the static call must not carry mode')
  assert.equal(withProp('data-tools-dialog', 'mcp-context7').length, 1, 'the dialog must open for that row')
  assert.equal(cellOf('data-tools-title', 'mcp-context7'), '工具：context7（2 个）')
  assert.equal(cellOf('data-tools-badge', 'static'), '本机已注册')
  assert.equal(withProp('data-tool', 'mcp__context7__resolve-library-id').length, 1)
  assert.equal(cellOf('data-tool-desc', 'mcp__context7__get-library-docs'), 'Fetch up-to-date documentation for a library')
  assert.ok(treeText().indexOf('静态清单为估计值') !== -1, 'the host note must be shown under the list')
  const desc = withProp('data-tool-desc', 'mcp__context7__get-library-docs')[0]
  assert.equal(desc.props['data-expanded'], 'false', 'descriptions start truncated')
  desc.props.onClick()
  await settle()
  assert.equal(withProp('data-tool-desc', 'mcp__context7__get-library-docs')[0].props['data-expanded'], 'true')
  const copy = withProp('data-tool-copy', 'mcp__context7__get-library-docs')[0]
  assert.ok(copy, 'every tool must offer a copy button')
  copy.props.onClick()
  await settle()
  assert.equal(textOf(withProp('data-tool-copy', 'mcp__context7__get-library-docs')[0]), '已复制')
})

test('an empty tool list offers a live probe labelled as spawning a subprocess', async () => {
  await boot({
    locale: makeLocale(),
    handler: (call) => {
      if (call.action !== 'tools') return ok(listData())
      return call.payload.mode === 'probe'
        ? ok({ mode: 'probe', tools: [{ name: 'mcp__context7__resolve-library-id', description: 'resolved live' }], latencyMs: 42 })
        : ok({ mode: 'static', tools: [] })
    },
  })
  all().find((node) => node.props['data-tools-open'] === 'mcp-context7').props.onClick()
  await settle()
  assert.equal(withProp('data-tools-empty', 'true').length, 1, 'the empty state must be explicit')
  assert.ok(treeText().indexOf('没有可显示的工具') !== -1)
  const probe = withProp('data-tools-probe', 'mcp-context7')
  assert.equal(probe.length, 1, 'the empty state must offer a live probe')
  assert.ok(treeText().indexOf('会启动一次 MCP 服务器子进程') !== -1, 'the subprocess warning must be visible')
  assert.equal(calls.filter((call) => call.action === 'tools').length, 1, 'no probe may run before the user asks')
  probe[0].props.onClick()
  await settle()
  const toolsCalls = calls.filter((call) => call.action === 'tools')
  assert.equal(toolsCalls.length, 2)
  assert.deepEqual(toolsCalls[1].payload, { id: 'mcp-context7', mode: 'probe' })
  assert.equal(cellOf('data-tools-badge', 'probe'), '真探测')
  assert.equal(cellOf('data-tools-latency', 'true'), '延迟 42ms')
  assert.equal(withProp('data-tool', 'mcp__context7__resolve-library-id').length, 1, 'the probe result replaces the empty state')
  assert.equal(withProp('data-tools-empty', 'true').length, 0)
})

test('a failed live probe stays inside the dialog and leaves the rows alone', async () => {
  await boot({
    locale: makeLocale(),
    handler: (call) => {
      if (call.action !== 'tools') return ok(listData())
      // 真实宿主形状：HTTP 200 + { ok:false, error:{ code, message, latencyMs, fields } }
      return call.payload.mode === 'probe'
        ? fail({ code: 'probe-failed', message: 'spawn npx ENOENT', latencyMs: 8001, fields: { latencyMs: 8001, error: 'spawn npx ENOENT' } })
        : ok({ mode: 'static', tools: [] })
    },
  })
  all().find((node) => node.props['data-tools-open'] === 'mcp-context7').props.onClick()
  await settle()
  withProp('data-tools-probe', 'mcp-context7')[0].props.onClick()
  await settle()
  assert.equal(withProp('data-tools-error', 'probe-failed').length, 1, 'the failure must be shown in place')
  assert.ok(treeText().indexOf('spawn npx ENOENT') !== -1)
  assert.ok(treeText().indexOf('错误码：probe-failed') !== -1)
  assert.equal(cellOf('data-tools-badge', 'probe'), '真探测', 'a failed probe still reports the mode the user asked for')
  assert.equal(cellOf('data-tools-latency', 'true'), '延迟 8001ms', 'the latency rides on error.latencyMs')
  assert.equal(withProp('data-tools-retry', 'true').length, 1, 'the dialog must offer a retry')
  assert.equal(all().filter((node) => node.props['data-card'] !== undefined).length, 6, 'the rows must stay untouched')
  withProp('data-tools-retry', 'true')[0].props.onClick()
  await settle()
  const toolsCalls = calls.filter((call) => call.action === 'tools')
  assert.equal(toolsCalls.length, 3, 'the retry must re-ask the host')
  assert.deepEqual(toolsCalls[2].payload, { id: 'mcp-context7', mode: 'probe' }, 'the retry keeps the failing mode')
  withProp('data-tools-close', 'true')[0].props.onClick()
  await settle()
  assert.equal(withProp('data-tools-dialog', 'mcp-context7').length, 0, 'closing must remove the dialog')
  assert.equal(all().filter((node) => node.props['data-card'] !== undefined).length, 6, 'the panel stays intact after closing')
})

test('the dialog reads the data-envelope failure and the tools-unavailable note', async () => {
  await boot({
    locale: makeLocale(),
    handler: (call) => {
      if (call.action !== 'tools') return ok(listData())
      if (call.payload.mode === 'probe') {
        return ok({ ok: false, mode: 'probe', error: { code: 'probe-failed', message: 'connect ECONNREFUSED', latencyMs: 7000 } })
      }
      return ok({
        mode: 'static',
        source: 'registry',
        serverName: 'context7',
        tools: [],
        note: '静态清单按 mcp__<serverName>__ 前缀统计，工具名超长会被归一化，属估计值（当前读不到宿主工具清单：tools service missing）',
        reason: 'tools-unavailable',
      })
    },
  })
  all().find((node) => node.props['data-tools-open'] === 'mcp-context7').props.onClick()
  await settle()
  assert.equal(withProp('data-tools-empty', 'true').length, 1)
  assert.ok(treeText().indexOf('当前读不到宿主工具清单：tools service missing') !== -1, 'the host note must reach the bottom even when the list is empty')
  assert.equal(cellOf('data-tools-badge', 'static'), '本机已注册')
  withProp('data-tools-probe', 'mcp-context7')[0].props.onClick()
  await settle()
  assert.equal(withProp('data-tools-error', 'probe-failed').length, 1)
  assert.ok(treeText().indexOf('connect ECONNREFUSED') !== -1)
  assert.equal(cellOf('data-tools-badge', 'probe'), '真探测')
  assert.equal(cellOf('data-tools-latency', 'true'), '延迟 7000ms', 'a data-envelope failure keeps its latency too')
})

test('the tools dialog accepts the older payload shape and never prints undefined', async () => {
  await boot({
    locale: makeLocale(),
    handler: (call) => (call.action === 'tools' ? ok({ tools: [{ name: 'legacy-tool' }, 'string-tool'] }) : ok(listData())),
  })
  all().find((node) => node.props['data-tools-open'] === 'mcp-chrome-devtools').props.onClick()
  await settle()
  assert.equal(withProp('data-tools-dialog', 'mcp-chrome-devtools').length, 1)
  assert.equal(cellOf('data-tools-title', 'mcp-chrome-devtools'), '工具：chrome-devtools（2 个）', 'a payload without mode falls back to the static list')
  assert.equal(cellOf('data-tools-badge', 'static'), '本机已注册')
  assert.equal(withProp('data-tool', 'legacy-tool').length, 1)
  assert.equal(withProp('data-tool', 'string-tool').length, 1, 'a bare string is accepted as a tool name')
  assert.equal(withProp('data-tool-desc', 'legacy-tool').length, 0, 'a missing description renders nothing')
  assert.ok(treeText().indexOf('undefined') === -1, 'no undefined may leak into the dialog')
})

test('the tools dialog shows a loading state while the host answers', async () => {
  let release = null
  await boot({
    locale: makeLocale(),
    handler: (call) => {
      if (call.action !== 'tools') return ok(listData())
      return new Promise((resolve) => {
        release = () => resolve(ok({ mode: 'static', tools: [{ name: 'late-tool', description: 'arrives late' }] }))
      })
    },
  })
  all().find((node) => node.props['data-tools-open'] === 'mcp-context7').props.onClick()
  pump()
  assert.equal(withProp('data-tools-loading', 'true').length, 1, 'the dialog must open in a loading state')
  assert.ok(treeText().indexOf('正在读取工具清单') !== -1)
  release()
  await settle()
  assert.equal(withProp('data-tools-loading', 'true').length, 0)
  assert.equal(withProp('data-tool', 'late-tool').length, 1)
})

test('both dictionaries stay in sync so no face silently falls back to a key name', async () => {
  const session = await boot({ locale: makeLocale() })
  const hooks = session.hooks
  const zh = Object.keys(hooks.zhDict).sort()
  const en = Object.keys(hooks.enDict).sort()
  const missingEn = zh.filter((key) => !(key in hooks.enDict))
  const missingZh = en.filter((key) => !(key in hooks.zhDict))
  assert.deepEqual(missingEn, [], 'these keys exist only in the Chinese dictionary')
  assert.deepEqual(missingZh, [], 'these keys exist only in the English dictionary')
  const empty = zh.filter((key) => !String(hooks.zhDict[key]).length || !String(hooks.enDict[key]).length)
  assert.deepEqual(empty, [], 'no dictionary value may be empty')
})

test('no rejection escaped the panel during the whole run', async () => {
  await settle(5)
  assert.deepEqual(unhandled.map(String), [])
})

// =============================================================================

let passed = 0
let failed = 0
for (const [label, fn] of tests) {
  try {
    await fn()
    passed += 1
    process.stdout.write('ok    - ' + label + '\n')
  } catch (error) {
    failed += 1
    process.stdout.write('FAIL  - ' + label + '\n')
    process.stdout.write((error && error.stack ? error.stack : String(error)) + '\n')
  }
}
unmountPanel()
process.stdout.write(passed + '/' + (passed + failed) + ' assertions passed\n')
if (failed) process.exitCode = 1
