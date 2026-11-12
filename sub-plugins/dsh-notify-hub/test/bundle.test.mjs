// Behavioural harness for dsh-notify-hub — client bundle + host-half safety.
//
// Part A materializes src/client.js the way @deepseek-ai/dsh-client-modules
// does (window.__ModuleLoader__.load then factory(require)) with a minimal
// deps-aware React shim, a stateful fetch stub and a remote.settings stub, and
// asserts what the user can observe: the section registration, the rule rows,
// the master switch write, a rule save, a test run, the presence heartbeat, and
// that nothing ever reloads the page by itself.
// Part B is the safety contract of the host half: it must not import
// @deepseek-ai/*, and the two observe-only waterfalls must pass the chain
// through unchanged (prepend + return next()) — otherwise an approval would end
// up fail-closed 'unavailable'.
//
// This is a LOGIC harness, not a browser render. Real-browser checks live in
// ACCEPTANCE.md.
//
// Run: node sub-plugins/dsh-notify-hub/test/bundle.test.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const bundlePath = path.join(here, '..', 'src', 'client.js')
const hostPath = path.join(here, '..', 'src', 'index.js')
const PKG_ID = 'dsh-notify-hub'
const NS = 'notify-hub'

// --- browser-ish globals -----------------------------------------------------

Object.defineProperty(globalThis, 'navigator', { configurable: true, value: { languages: ['zh-CN'], language: 'zh-CN' } })

const factories = new Map()
const fetchCalls = []
let reloaded = false
/** Set by a test to make the next /test-run answer a specific (failing) entry. */
let testRunOverride = null
const windowObj = {
  __DSH_TEST__: true,
  location: { reload: () => { reloaded = true } },
  addEventListener() {},
  removeEventListener() {},
}
windowObj.__ModuleLoader__ = { load: ({ id, factory }) => factories.set(id, factory) }
globalThis.window = windowObj
globalThis.document = {
  visibilityState: 'visible',
  hasFocus: () => true,
  addEventListener() {},
  removeEventListener() {},
}

// --- remote.settings stub ----------------------------------------------------

const baseRule = {
  id: 'rule-a',
  name: '空闲提醒',
  enabled: true,
  command: '/tmp/notify.sh',
  args: ['--reason', '{reason}'],
  interpreter: '',
  cwd: '',
  triggers: { turnEnd: true, approval: true, question: false },
  precondition: 'page-closed',
  debounceMs: 3000,
  timeoutMs: 30000,
  shell: false,
}

/** Mirror of packages/settings/settings mergeLayers (non-plain values replace). */
function deepMerge(under, over) {
  if (over === undefined) return under
  if (!under || typeof under !== 'object' || Array.isArray(under)
    || !over || typeof over !== 'object' || Array.isArray(over)) return over
  const merged = Object.assign({}, under)
  for (const key of Object.keys(over)) {
    merged[key] = Object.prototype.hasOwnProperty.call(merged, key) ? deepMerge(merged[key], over[key]) : over[key]
  }
  return merged
}

function baseConfig() {
  return { enabled: true, seeded: true, rules: [JSON.parse(JSON.stringify(baseRule))] }
}

const settingsState = { value: baseConfig(), calls: [] }

/** Each test starts from the same stored config (writes mutate the stub). */
function resetSettings() {
  settingsState.value = baseConfig()
  settingsState.calls.length = 0
}
const settingsStub = {
  async describe() {
    return { ok: true, value: { namespaces: [{ ns: NS, value: settingsState.value, revision: 7 }] } }
  },
  /** 忠实于核心 mergeLayers：普通对象逐键深合并（所以写 {} 删不掉任何键） */
  async update(ns, patch, revision) {
    settingsState.calls.push({ ns, patch, revision, verb: 'update' })
    settingsState.value = deepMerge(settingsState.value, patch)
    return { ok: true, value: { revision: 8 } }
  },
  /** 整段替换用户层（删键的唯一办法） */
  async replace(ns, section, revision) {
    settingsState.calls.push({ ns, section, revision, verb: 'replace' })
    settingsState.value = JSON.parse(JSON.stringify(section))
    return { ok: true, value: { revision: 9 } }
  },
}

// --- fetch stub --------------------------------------------------------------

function statusPayload() {
  return {
    plugin: PKG_ID,
    pluginDir: '/repo/dsh-notify-hub',
    platform: 'darwin',
    settings: { ready: true, error: null, namespace: NS },
    config: {
      enabled: settingsState.value.enabled,
      seeded: settingsState.value.seeded,
      env: settingsState.value.env || {},
      rules: settingsState.value.rules.map(redactForStatus),
      count: settingsState.value.rules.length,
    },
    sampleRule: {
      id: 'sample-notify',
      name: '示例：macOS 通知＋提示音（默认关闭）',
      enabled: false,
      command: '/repo/dsh-notify-hub/examples/notify-macos.sh',
      args: [],
      interpreter: '',
      cwd: '',
      triggers: { turnEnd: true, approval: true, question: true },
      precondition: 'page-closed',
      debounceMs: 3000,
      timeoutMs: 30000,
      shell: false,
    },
    presence: { state: 'closed', lastSeenAt: null, visible: false, focused: false },
    presenceIntervalMs: 5000,
    runtime: {
      'rule-a': { consecutiveFailures: 0, lastRunAt: 1700000000000, lastStatus: 'ok', lastExitCode: 0, lastDurationMs: 12 },
    },
    history: { count: 1, limit: 200, file: '/home/u/.dsh/notify-hub-history.json' },
    defaults: { debounceMs: 3000, timeoutMs: 30000, failureLimit: 3 },
    lastError: null,
  }
}

/** 与 host 的 redactRule 一致：/status 永远不回显授权码，只给 passConfigured 标记。 */
function redactForStatus(rule) {
  if (!rule || rule.channel !== 'email' || !rule.email) return rule
  return Object.assign({}, rule, {
    email: Object.assign({}, rule.email, { pass: '', passConfigured: Boolean(rule.email.pass) }),
  })
}

function historyPayload() {
  return {
    entries: [
      {
        id: 'e1',
        ruleId: 'rule-a',
        ruleName: '空闲提醒',
        trigger: 'turn-end',
        detail: 'completed',
        sessionId: 'session-1',
        sessionTitle: '修复登录',
        startedAt: 1700000000000,
        durationMs: 12,
        status: 'ok',
        exitCode: 0,
        test: false,
        error: null,
        stdout: 'sent',
        stderr: '',
      },
    ],
    runtime: {},
    limit: 200,
  }
}

async function fetchStub(url, opts) {
  fetchCalls.push({ url, opts })
  if (url === '/__notify-hub/status') return { ok: true, status: 200, json: async () => ({ ok: true, data: statusPayload() }) }
  if (url === '/__notify-hub/presence') return { ok: true, status: 200, json: async () => ({ ok: true, data: { state: 'visible-focused' } }) }
  if (url === '/__notify-hub/history') return { ok: true, status: 200, json: async () => ({ ok: true, data: historyPayload() }) }
  if (url === '/__notify-hub/reset-rule') return { ok: true, status: 200, json: async () => ({ ok: true, data: { runtime: {} } }) }
  if (url === '/__notify-hub/clear-history') return { ok: true, status: 200, json: async () => ({ ok: true, data: { entries: [] } }) }
  if (url === '/__notify-hub/test-run') {
    if (testRunOverride) {
      return { ok: true, status: 200, json: async () => ({ ok: true, data: testRunOverride }) }
    }
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        data: {
          entry: {
            id: 'e2', ruleId: 'rule-a', ruleName: '空闲提醒', status: 'ok', exitCode: 0,
            durationMs: 5, trigger: 'turn-end', detail: 'completed', test: true,
            stdout: '', stderr: '', error: null,
          },
          context: { sample: false, sessionId: 'session-1', sessionTitle: '修复登录', cwd: '/proj/app' },
        },
      }),
    }
  }
  if (url === '/__notify-hub/test-email') {
    return {
      ok: true,
      status: 200,
      json: async () => ({
        ok: true,
        data: {
          entry: {
            id: 'e-mail', ruleId: 'rule-mail', ruleName: '邮件通知', status: 'ok', exitCode: null,
            durationMs: 128, trigger: 'turn-end', detail: 'completed', test: true,
            stdout: '', stderr: '', error: null, note: '已投递至 me@qq.com', channel: 'email',
          },
          context: { sample: false, sessionId: 'session-1', sessionTitle: '修复登录', cwd: '/proj/app' },
        },
      }),
    }
  }
  return { ok: false, status: 404, json: async () => ({ ok: false, error: 'not found' }) }
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
      props: Object.assign({}, props || {}, { children: children.length === 1 ? children[0] : children }),
    }),
    Fragment: Symbol('Fragment'),
    useState(initial) {
      const i = index++
      if (!(i in slots)) slots[i] = { value: typeof initial === 'function' ? initial() : initial }
      const slot = slots[i]
      return [slot.value, (next) => { slot.value = typeof next === 'function' ? next(slot.value) : next }]
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
  return { React, begin() { index = 0 }, fresh() { slots = []; index = 0 } }
}

const { React, begin, fresh } = makeReact()
function requireStub(specifier) {
  if (specifier === 'react') return React
  throw new Error('unexpected require(' + specifier + ')')
}

// --- load the bundle ---------------------------------------------------------

const source = fs.readFileSync(bundlePath, 'utf8')
new Function('window', 'navigator', 'document', 'fetch', source)(
  globalThis.window, globalThis.navigator, globalThis.document, fetchStub,
)

const failures = []
const tests = []
/** SKIP 计数：仅用于「需要真实子进程」的用例（DSH 沙箱下 spawn 一律 EPERM） */
let skipped = 0
let passed = 0
const test = (name, fn) => tests.push([name, fn])

function factoryApi() {
  const factory = factories.get(PKG_ID)
  assert.ok(factory, 'bundle did not register id ' + PKG_ID)
  return factory(requireStub)
}

const disposers = []
function mountSection() {
  const api = factoryApi()
  let registered = null
  let section = null
  const slots = {
    inject: (name, cb) => { registered = cb },
    register: (opts, comp) => { section = comp },
  }
  const ctx = {
    slots,
    get: (key) => (key === 'remote.settings' ? settingsStub : null),
    effect: (fn) => { const disposer = fn(); if (typeof disposer === 'function') disposers.push(disposer) },
  }
  api.apply(ctx)
  assert.ok(registered, 'slots.inject called')
  registered(slots)
  assert.ok(section, 'section registered')
  return section
}

function walk(node, pred, out = []) {
  if (!node || typeof node !== 'object') return out
  if (Array.isArray(node)) {
    for (const child of node) walk(child, pred, out)
    return out
  }
  if (node.__element) {
    if (pred(node)) out.push(node)
    const ch = node.props && node.props.children
    if (Array.isArray(ch)) for (const c of ch) walk(c, pred, out)
    else if (ch && typeof ch === 'object') walk(ch, pred, out)
  }
  return out
}
const byType = (tree, type) => walk(tree, (n) => n.type === type)
function textOf(node) {
  const parts = []
  const collect = (n) => {
    if (Array.isArray(n)) { n.forEach(collect); return }
    if (typeof n === 'string' || typeof n === 'number') { parts.push(String(n)); return }
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
const settle = async (times = 4) => { for (let i = 0; i < times; i += 1) await flush() }
const buttonByText = (tree, text) => byType(tree, 'button').find((b) => textOf(b).includes(text))
/** Exact match: '保存' must not pick up the global '保存环境变量' button. */
const buttonExact = (tree, text) => byType(tree, 'button').find((b) => textOf(b).trim() === text)
/** 表单字段定位：同一个 field div 里，label 文本之后跟的那个 input/textarea。 */
function fieldControl(tree, labelText, type = 'input') {
  for (const div of byType(tree, 'div')) {
    const kids = [].concat(div.props.children || [])
    const labelled = kids.some((k) => k && k.type === 'label' && textOf(k).trim() === labelText)
    if (!labelled) continue
    const ctrl = kids.find((k) => k && k.type === type)
    if (ctrl) return ctrl
  }
  return null
}
/** 一条已经存好的邮件规则：pass 在 settings 里是明文，/status 里会被抹成 ''。 */
function storedEmailRule() {
  return {
    id: 'rule-mail', name: '邮件通知', enabled: true, channel: 'email',
    command: '', args: [], interpreter: '', cwd: '',
    triggers: { turnEnd: true, approval: false, question: false },
    precondition: 'any', debounceMs: 0, timeoutMs: 5000, shell: false, env: {},
    email: {
      host: 'smtp.qq.com', port: 465, secure: true, starttls: false,
      user: 'me@qq.com', pass: 'AUTH123', passEnv: '', from: 'me@qq.com', to: 'me@qq.com',
      subject: 'DSH 通知：{reason} · {title}', body: '正文', allowInsecureTls: false,
    },
  }
}
/** 环境变量表格的定位：单元格/按钮都带 data-env / data-env-scope / data-row */
const envCell = (tree, scope, kind, row) => byType(tree, 'input')
  .find((i) => i.props['data-env'] === kind && i.props['data-env-scope'] === scope && i.props['data-row'] === row)
const envButton = (tree, scope, action, row) => byType(tree, 'button')
  .find((b) => b.props['data-env'] === action && b.props['data-env-scope'] === scope
    && (row === undefined || b.props['data-row'] === row))
const envRowCount = (tree, scope) => byType(tree, 'input')
  .filter((i) => i.props['data-env'] === 'key' && i.props['data-env-scope'] === scope).length
/** 给某一行填值：先渲染、改 key、再渲染、改 value、再渲染 */
async function fillEnvRow(section, scope, row, key, value) {
  let tree = await renderOnce(section)
  envCell(tree, scope, 'key', row).props.onChange({ target: { value: key } })
  await settle(1)
  tree = await renderOnce(section)
  envCell(tree, scope, 'value', row).props.onChange({ target: { value } })
  await settle(1)
  return renderOnce(section)
}
const renderOnce = async (section) => { begin(); const tree = section(); await settle(1); return tree }

// --- Part A: the client bundle ----------------------------------------------

test('bundle registers id dsh-notify-hub and injects slots only', () => {
  assert.deepEqual(factoryApi().inject, ['slots'])
})

test('apply registers tab notify-hub (order 40) inside the「本地插件」entry', () => {
  const api = factoryApi()
  let registered = null
  const entry = []
  const slots = { inject: (name, cb) => { registered = cb }, register: (opts, comp) => entry.push({ opts, comp }) }
  api.apply({ slots, get: () => null, effect: (fn) => { const d = fn(); if (typeof d === 'function') disposers.push(d) } })
  assert.equal(typeof registered, 'function')
  registered(slots)
  assert.equal(entry.length, 1)
  assert.equal(entry[0].opts.name, 'settings.localPlugins.tab')
  assert.equal(entry[0].opts.id, NS)
  assert.equal(entry[0].opts.order, 40)
  assert.equal(entry[0].opts.label(), '通知中心')
  assert.equal(typeof entry[0].comp, 'function')
})

test('renders the rule list from /status with run status, and never auto-reloads', async () => {
  fetchCalls.length = 0
  resetSettings()
  const section = mountSection()
  fresh()
  section()
  await settle()
  const tree = await renderOnce(section)
  const text = textOf(tree)
  assert.match(text, /通知中心/)
  assert.match(text, /空闲提醒/)
  assert.ok(text.includes('/tmp/notify.sh'), 'the command is shown')
  assert.match(text, /上次运行/)
  assert.match(text, /页面关着/)
  assert.ok(fetchCalls.some((c) => c.url === '/__notify-hub/status'), 'status fetched on mount')
  assert.equal(reloaded, false, 'no automatic reload on plain render')
})

test('the master switch writes enabled:false through remote.settings', async () => {
  resetSettings()
  const section = mountSection()
  fresh()
  section()
  await settle()
  const tree = await renderOnce(section)
  const master = buttonByText(tree, '总开关')
  assert.ok(master, 'master switch button found')
  master.props.onClick()
  await settle()
  assert.equal(settingsState.calls.length, 1, 'exactly one settings write')
  assert.equal(settingsState.calls[0].ns, NS)
  assert.deepEqual(settingsState.calls[0].patch, { enabled: false })
  assert.equal(reloaded, false, 'no automatic reload after a write')
})

test('saving an edited rule writes the whole rules array', async () => {
  resetSettings()
  const section = mountSection()
  fresh()
  section()
  await settle()
  let tree = await renderOnce(section)
  buttonByText(tree, '编辑').props.onClick()
  await settle(1)
  tree = await renderOnce(section)
  const commandInput = byType(tree, 'input').find((i) => i.props.value === '/tmp/notify.sh')
  assert.ok(commandInput, 'the command input is bound to the rule')
  commandInput.props.onChange({ target: { value: '/tmp/other.sh' } })
  await settle(1)
  tree = await renderOnce(section)
  const save = buttonExact(tree, '保存')
  assert.ok(save, 'save button found')
  save.props.onClick()
  await settle()
  assert.equal(settingsState.calls.length, 1)
  const patch = settingsState.calls[0].patch
  assert.ok(Array.isArray(patch.rules), 'the rules array is written wholesale')
  assert.equal(patch.rules[0].command, '/tmp/other.sh')
  assert.equal(patch.rules.length, settingsState.value.rules.length)
})

test('test-run posts the rule to the host and reports the outcome', async () => {
  fetchCalls.length = 0
  resetSettings()
  const section = mountSection()
  fresh()
  section()
  await settle()
  const tree = await renderOnce(section)
  buttonByText(tree, '试跑').props.onClick()
  await settle()
  const call = fetchCalls.find((c) => c.url === '/__notify-hub/test-run')
  assert.ok(call, 'the test-run endpoint is called')
  const body = JSON.parse(call.opts.body)
  assert.equal(body.rule.command, '/tmp/notify.sh')
  assert.deepEqual(body.rule.args, ['--reason', '{reason}'])
  const after = await renderOnce(section)
  assert.match(textOf(after), /试跑完成/)
})

test('the presence heartbeat reports visible/focused to the host', async () => {
  fetchCalls.length = 0
  mountSection()
  await settle()
  const beats = fetchCalls.filter((c) => c.url === '/__notify-hub/presence')
  assert.ok(beats.length >= 1, 'at least the initial heartbeat is sent')
  assert.deepEqual(JSON.parse(beats[0].opts.body), { visible: true, focused: true })
})

test('the history panel loads on demand and shows the session', async () => {
  fetchCalls.length = 0
  resetSettings()
  const section = mountSection()
  fresh()
  section()
  await settle()
  const tree = await renderOnce(section)
  const toggle = buttonByText(tree, '执行历史')
  assert.ok(toggle, 'history toggle found')
  toggle.props.onClick()
  await settle()
  await renderOnce(section)
  await settle()
  const after = await renderOnce(section)
  assert.ok(fetchCalls.some((c) => c.url === '/__notify-hub/history'), 'history fetched when opened')
  assert.match(textOf(after), /修复登录/)
})

test('the global env table saves env through remote.settings', async () => {
  resetSettings()
  const section = mountSection()
  fresh()
  section()
  await settle()
  let tree = await renderOnce(section)
  assert.equal(envRowCount(tree, 'global'), 0, '一开始没有行')
  envButton(tree, 'global', 'add').props.onClick()   // + 添加一行
  await settle(1)
  tree = await fillEnvRow(section, 'global', 0, 'NOTIFY_ACCESS_KEY', 'abc123')
  envButton(tree, 'global', 'add').props.onClick()
  await settle(1)
  tree = await fillEnvRow(section, 'global', 1, 'MAIL_RECEIVER', 'me@corp.netease.com')
  const save = buttonExact(tree, '保存环境变量')
  assert.ok(save, 'global env save button found')
  save.props.onClick()
  await settle()
  assert.equal(settingsState.calls.length, 1, 'exactly one settings write')
  // 环境变量框是「整份列表」编辑器：删键必须整段替换（update 是深合并，删不掉键）
  assert.equal(settingsState.calls[0].verb, 'replace')
  assert.deepEqual(settingsState.calls[0].section.env, {
    NOTIFY_ACCESS_KEY: 'abc123',
    MAIL_RECEIVER: 'me@corp.netease.com',
  })
  assert.equal(settingsState.value.rules.length, 1, '同一段里的其它键（rules）原样保留')
})

test('a rule carries its own env, overriding the global one at run time', async () => {
  resetSettings()
  const section = mountSection()
  fresh()
  section()
  await settle()
  let tree = await renderOnce(section)
  buttonByText(tree, '编辑').props.onClick()
  await settle(1)
  tree = await renderOnce(section)
  assert.equal(envRowCount(tree, 'rule'), 0, '规则初始没有环境变量行')
  envButton(tree, 'rule', 'add').props.onClick()
  await settle(1)
  tree = await fillEnvRow(section, 'rule', 0, 'MAIL_RECEIVER', 'only-me@corp.netease.com')
  envButton(tree, 'rule', 'add').props.onClick()
  await settle(1)
  tree = await fillEnvRow(section, 'rule', 1, 'MAIL_IS_HTML', '1')
  buttonExact(tree, '保存').props.onClick()
  await settle()
  assert.equal(settingsState.calls.length, 1)
  assert.deepEqual(settingsState.calls[0].patch.rules[0].env, {
    MAIL_RECEIVER: 'only-me@corp.netease.com',
    MAIL_IS_HTML: '1',
  })
})

test('a row without a name blocks saving, NOTIFY_HUB_* only warns', async () => {
  resetSettings()
  const section = mountSection()
  fresh()
  section()
  await settle()
  let tree = await renderOnce(section)
  buttonByText(tree, '编辑').props.onClick()
  await settle(1)
  tree = await renderOnce(section)
  envButton(tree, 'rule', 'add').props.onClick()
  await settle(1)
  tree = await renderOnce(section)
  envCell(tree, 'rule', 'value', 0).props.onChange({ target: { value: '这个值没有名字' } })  // 只填值、不填名
  await settle(1)
  tree = await renderOnce(section)
  buttonExact(tree, '保存').props.onClick()
  await settle()
  assert.equal(settingsState.calls.length, 0, '写了值却没写变量名 → 不允许保存')
  tree = await renderOnce(section)
  assert.match(textOf(tree), /变量名不能为空/, 'the reason is shown to the user')

  tree = await fillEnvRow(section, 'rule', 0, 'NOTIFY_HUB_REASON', 'fake')
  envButton(tree, 'rule', 'add').props.onClick()
  await settle(1)
  tree = await fillEnvRow(section, 'rule', 1, 'MAIL_RECEIVER', 'me@corp.netease.com')
  buttonExact(tree, '保存').props.onClick()
  await settle()
  assert.equal(settingsState.calls.length, 1, 'a contract key warns but still saves')
  tree = await renderOnce(section)
  assert.match(textOf(tree), /NOTIFY_HUB_/)
})

test('test-run sends the rule env plus the unsaved global env', async () => {
  resetSettings()
  settingsState.value = Object.assign({}, settingsState.value, { env: { NOTIFY_ACCESS_KEY: 'global-key' } })
  fetchCalls.length = 0
  const section = mountSection()
  fresh()
  section()
  await settle()
  const tree = await renderOnce(section)
  buttonByText(tree, '试跑').props.onClick()
  await settle()
  const call = fetchCalls.find((c) => c.url === '/__notify-hub/test-run')
  assert.ok(call, 'test-run endpoint called')
  const body = JSON.parse(call.opts.body)
  assert.deepEqual(body.env, { NOTIFY_ACCESS_KEY: 'global-key' }, 'the global env rides along')
  assert.deepEqual(body.rule.env, {}, 'the fixture rule has no env of its own')
})

test('the not-registered error is explained with an actionable hint', async () => {
  resetSettings()
  const section = mountSection()
  fresh()
  section()
  await settle()
  let tree = await renderOnce(section)
  const original = settingsStub.update
  settingsStub.update = async () => ({
    ok: false,
    error: { code: 'settings/unknown-namespace', message: 'settings namespace "notify-hub" is not registered' },
  })
  try {
    buttonByText(tree, '编辑').props.onClick()
    await settle(1)
    tree = await renderOnce(section)
    buttonExact(tree, '保存').props.onClick()
    await settle()
    tree = await renderOnce(section)
    const text = textOf(tree)
    assert.match(text, /not registered/, 'the raw reason stays visible')
    assert.match(text, /本地插件/, 'and the user is told how to fix it')
  } finally {
    settingsStub.update = original
  }
})

test('a rule whose command has a newline cannot be saved (and says why)', async () => {
  resetSettings()
  const section = mountSection()
  fresh()
  section()
  await settle()
  let tree = await renderOnce(section)
  buttonByText(tree, '编辑').props.onClick()
  await settle(1)
  tree = await renderOnce(section)
  const commandInput = byType(tree, 'input').find((i) => i.props.value === '/tmp/notify.sh')
  commandInput.props.onChange({ target: { value: 'python3.11\n/tmp/notify.sh' } })
  await settle(1)
  tree = await renderOnce(section)
  buttonExact(tree, '保存').props.onClick()
  await settle()
  assert.equal(settingsState.calls.length, 0, 'nothing is written while the command is malformed')
  tree = await renderOnce(section)
  assert.match(textOf(tree), /不要写换行/, 'the user is told what to change')
})

test('the precondition select paints its own background so its options stay readable', async () => {
  resetSettings()
  const section = mountSection()
  fresh()
  section()
  await settle()
  let tree = await renderOnce(section)
  buttonByText(tree, '编辑').props.onClick()
  await settle(1)
  tree = await renderOnce(section)
  const selects = byType(tree, 'select')
  assert.equal(selects.length, 2, 'the rule editor renders two native selects (delivery channel + precondition)')
  // 通道下拉与 precondition 都用同一个 S.select；precondition 那个的 option 里有 'any'
  const optionsOf = (sel) => [].concat(sel.props.children || [])
  const precondition = selects.find((s) => optionsOf(s).some((o) => o && o.props && o.props.value === 'any'))
  assert.ok(precondition, 'one of the two selects is the precondition picker (its options include「any」)')
  const style = precondition.props.style
  // 原生 <select> 的弹层用控件自身的 background/color 绘制：background: transparent 会让暗色主题下的
  // 弹层退回白底 + 继承浅色文字，未选中的选项看起来像被禁用。必须给不透明底色与显式文字色。
  assert.notEqual(style.background, 'transparent', 'the popup must not fall back to a transparent background')
  assert.match(String(style.background), /--dsw-alias-bg-layer-3/, 'and uses the theme surface token')
  assert.match(String(style.color), /--dsw-alias-label-primary/, 'with an explicit theme label color')
})

test('an email rule renders the SMTP form and saves channel=email', async () => {
  resetSettings()
  const section = mountSection()
  fresh()
  section()
  await settle()
  let tree = await renderOnce(section)
  buttonByText(tree, '新建规则').props.onClick()
  await settle(1)
  tree = await renderOnce(section)

  const channelSelect = byType(tree, 'select')[0]
  assert.ok(channelSelect, 'the editor has a delivery-channel select')
  channelSelect.props.onChange({ target: { value: 'email' } })
  await settle(1)
  tree = await renderOnce(section)
  assert.match(textOf(tree), /SMTP 服务器/, 'switching to email reveals the SMTP fields')

  const fill = async (label, value) => {
    tree = await renderOnce(section)
    const ctrl = fieldControl(tree, label)
    assert.ok(ctrl, 'the「' + label + '」field is rendered')
    ctrl.props.onChange({ target: { value } })
    await settle(1)
  }
  await fill('名称', '邮件通知')
  await fill('SMTP 服务器', 'smtp.qq.com')
  await fill('收件人', 'me@qq.com')
  await fill('授权码 / 密码', 'AUTH123')

  tree = await renderOnce(section)
  buttonExact(tree, '保存').props.onClick()
  await settle(6)

  const call = settingsState.calls[settingsState.calls.length - 1]
  assert.ok(call, 'the editor wrote the config')
  const sectionValue = call.section || call.patch
  const saved = (sectionValue.rules || []).find((r) => r.channel === 'email')
  assert.ok(saved, 'the saved rule carries channel=email')
  assert.equal(saved.email.host, 'smtp.qq.com')
  assert.equal(saved.email.to, 'me@qq.com')
  assert.equal(saved.email.pass, 'AUTH123', 'the authorization code is stored exactly as typed')
})

test('testing an email rule posts to /test-email and refills the redacted code', async () => {
  resetSettings()
  settingsState.value = { enabled: true, seeded: true, env: {}, rules: [storedEmailRule()] }
  fetchCalls.length = 0
  const section = mountSection()
  fresh()
  section()
  await settle()
  let tree = await renderOnce(section)

  const btn = buttonByText(tree, '发送测试邮件')
  assert.ok(btn, 'an email rule row offers「发送测试邮件」instead of the script 试跑')
  btn.props.onClick()
  await settle(6)

  const post = fetchCalls.find((c) => c.url === '/__notify-hub/test-email')
  assert.ok(post, 'the test goes to /test-email, never /test-run')
  const body = JSON.parse(post.opts.body)
  assert.equal(body.rule.channel, 'email')
  // /status 只给 passConfigured，明文必须从 settings 回填，否则真发信会「授权码没有来源」
  assert.equal(body.rule.email.pass, 'AUTH123', 'the redacted authorization code is refilled from settings')
  tree = await renderOnce(section)
  assert.match(textOf(tree), /已投递至 me@qq.com/)
})

test('a failed test run shows the script error, not just the exit code', async () => {
  resetSettings()
  testRunOverride = {
    entry: {
      id: 'e9', ruleId: 'rule-a', ruleName: '空闲提醒', status: 'failed', exitCode: 2,
      durationMs: 40, trigger: 'turn-end', detail: 'completed', test: true,
      error: null, note: null,
      stdout: '',
      stderr: "python3: can't open file '/tmp/notify.sh': [Errno 2] No such file or directory",
    },
    context: { sample: false, sessionId: 'session-1', sessionTitle: '修复登录', cwd: '/proj/app' },
  }
  try {
    const section = mountSection()
    fresh()
    section()
    await settle()
    const tree = await renderOnce(section)
    buttonByText(tree, '试跑').props.onClick()
    await settle()
    const after = await renderOnce(section)
    const text = textOf(after)
    assert.match(text, /退出码 2/, 'the exit code is still shown')
    assert.match(text, /can't open file/, "and so is the script's own error")
  } finally {
    testRunOverride = null
  }
})

test('the trigger path reports where it stopped (diag counters)', async () => {
  const host = await import('../src/index.js')
  const listeners = []
  const ctx = { on: (name, fn) => listeners.push({ name, fn }), get: () => null, inject: () => {}, effect: () => {} }
  host.apply(ctx)
  const onSession = listeners.find((l) => l.name === 'session/event').fn
  const before = Object.assign({}, host.statusPayload().diag)   // snapshot: statusPayload stays live

  onSession({ id: 'session-z' }, { type: 'turn/end', seq: 1, time: Date.now(), data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } } })
  const after1 = Object.assign({}, host.statusPayload().diag)
  assert.equal(after1.sessionEvents, before.sessionEvents + 1, 'the turn/end event was seen')
  assert.equal(after1.turnEndEligible, before.turnEndEligible, "the user's own Stop is not eligible")

  onSession({ id: 'session-z' }, { type: 'turn/end', seq: 2, time: Date.now(), data: { turn: 1, reason: { kind: 'completed' } } })
  const after2 = Object.assign({}, host.statusPayload().diag)
  assert.equal(after2.turnEndEligible, after1.turnEndEligible + 1, 'a completed turn is eligible')

  await new Promise((resolve) => setTimeout(resolve, 450)) // the 250ms settle check
  const settled = Object.assign({}, host.statusPayload().diag)
  assert.ok(settled.turnEndConfirmed > after2.turnEndConfirmed, 'confirmed once the agent reads as idle')
  assert.ok(settled.lastDispatch && settled.lastDispatch.rules === 0, 'dispatch ran (0 rules here: no settings service in this ctx)')
})

test('clearing the global env really removes the keys (update would merge them back)', async () => {
  resetSettings()
  settingsState.value = Object.assign(baseConfig(), {
    env: { NOTIFY_ACCESS_KEY: 'old-key', MAIL_RECEIVER: 'old@corp.netease.com' },
  })
  const section = mountSection()
  fresh()
  section()
  await settle()
  let tree = await renderOnce(section)
  assert.equal(envRowCount(tree, 'global'), 2, '已保存的两个变量各占一行')
  assert.equal(String(envCell(tree, 'global', 'key', 0).props.value), 'NOTIFY_ACCESS_KEY', '第一行就是它')

  // 用户逐行删除（等价于清空）
  envButton(tree, 'global', 'remove', 0).props.onClick()
  await settle(1)
  tree = await renderOnce(section)
  envButton(tree, 'global', 'remove', 0).props.onClick()
  await settle(1)
  tree = await renderOnce(section)
  assert.equal(envRowCount(tree, 'global'), 0, '两行都删掉了')
  buttonExact(tree, '保存环境变量').props.onClick()
  await settle()

  assert.equal(settingsState.calls.length, 1, 'exactly one write')
  assert.equal(settingsState.calls[0].verb, 'replace', 'clearing must REPLACE — update deep-merges and keeps old keys')
  assert.deepEqual(settingsState.value.env, {}, 'the stored env is really empty now')
  await settle(6)
  tree = await renderOnce(section)
  assert.equal(envRowCount(tree, 'global'), 0, '保存后表格里没有残留行')
})

// --- Part B: host-half safety ------------------------------------------------
//
// The host half keeps its state in $DSH_HOME/notify-hub-history.json. Point it at
// a throwaway home so a stray write can never touch the developer's live file.
const hostHome = fs.mkdtempSync(path.join(here, '.tmp-home-'))
process.env.DSH_HOME = hostHome

const hostSource = fs.readFileSync(hostPath, 'utf8')

test('the host half imports no @deepseek-ai/* module (link: resolution rule)', () => {
  assert.equal(hostSource.includes("from '@deepseek-ai/"), false, 'no static core import')
  assert.equal(hostSource.includes("require('@deepseek-ai/"), false, 'no core require')
})

test('both observe-only waterfalls prepend and hand the chain through unchanged', async () => {
  const host = await import('../src/index.js')
  const listeners = new Map()
  const ctx = {
    on: (eventName, fn, opts) => { listeners.set(eventName, { fn, opts }) },
    get: () => null,
    inject: () => {},
    effect: () => {},
  }
  host.apply(ctx)
  for (const eventName of ['approval/request', 'user-questions/request']) {
    const entry = listeners.get(eventName)
    assert.ok(entry, eventName + ' is observed')
    assert.equal(entry.opts && entry.opts.prepend, true, eventName + ' must prepend: the remotes forwarder claims the chain first')
    let nextCalled = 0
    let returned = null
    assert.doesNotThrow(() => {
      returned = entry.fn({ agent: { id: 'session-x' }, toolName: 'bash' }, () => { nextCalled += 1; return 'CHAIN-VALUE' })
    }, eventName + ' listener must not throw')
    assert.equal(nextCalled, 1, eventName + ' must call next()')
    assert.equal(returned, 'CHAIN-VALUE', eventName + ' must return the next() result unchanged')
  }
})

test('a settings provider that mounts late still gets the namespace registered', async () => {
  const host = await import('../src/index.js')
  const injected = []
  const installs = []
  const ctx = {
    on: () => {},
    get: () => null, // the provider is NOT mounted yet when this row loads
    inject: (names, cb) => { injected.push({ names, cb }) },
    effect: () => {},
  }
  host.apply(ctx)
  const late = injected.find((i) => Array.isArray(i.names) && i.names.indexOf('settings') !== -1)
  assert.ok(late, 'ctx.get() alone is not enough: apply must also ask for a late-mounting settings service')

  const settingsStub = {
    installSection(owner, ns, schema, entry, hooks) {
      installs.push({ ns, owner: Boolean(owner), hasSchema: Boolean(schema) })
      hooks.setSource(() => ({ enabled: true, seeded: true, env: { A: '1' }, rules: [] }))
    },
  }
  late.cb({ settings: settingsStub })
  await settle(3)
  assert.equal(installs.length, 1, 'the namespace registers once the provider appears')
  assert.equal(installs[0].ns, 'notify-hub')
  assert.equal(installs[0].owner, true, 'the plugin context owns the section')

  late.cb({ settings: settingsStub })
  await settle(2)
  assert.equal(installs.length, 1, 'a second mount event must not register twice')
})

test('a real turn/end envelope is what the trigger path reads (reason lives in event.data)', async () => {
  const host = await import('../src/index.js')
  const listeners = []
  const ctx = {
    on: (eventName, fn) => listeners.push({ eventName, fn }),
    get: () => null,
    inject: () => {},
    effect: () => {},
  }
  host.apply(ctx)
  const sessionEvents = listeners.filter((l) => l.eventName === 'session/event').map((l) => l.fn)
  assert.equal(sessionEvents.length, 1, 'session/event is observed once')
  const session = { id: 'session-y' }
  const diag = () => Object.assign({}, host.statusPayload().diag)
  const base = diag().turnEndEligible

  // 线上真实形状：{ type, seq, time, data: { turn, reason } }
  sessionEvents[0](session, { type: 'turn/end', seq: 1, time: Date.now(), data: { turn: 1, reason: { kind: 'aborted', reason: { kind: 'user' } } } })
  assert.equal(diag().turnEndEligible, base, "the user's own Stop must not be eligible")

  sessionEvents[0](session, { type: 'turn/end', seq: 2, time: Date.now(), data: { turn: 1, reason: { kind: 'completed' } } })
  assert.equal(diag().turnEndEligible, base + 1, 'a completed turn IS eligible — regression guard for the event.data.reason bug')

  // 上一步是一次真的派发（config 由更早的用例铺好，规则真的会跑）。必须等它落地：
  // 同一规则还在执行时，下一个端到端用例会被记成 skipped（"上一次同规则执行还在进行中"），
  // 而派发本身要等 settle 检查（250ms）后才发生，所以先给 settle 留出时间再等 inflight 清空。
  // 派发要等 settle 检查（250ms）后才发生，先跨过那个窗口再等 inflight 清空；
  // 没有派发时（例如 config 里没有规则）这一步只是 700ms 的固定开销，不会干等十几秒。
  await new Promise((resolve) => setTimeout(resolve, 700))
  const done = Date.now() + 15000
  while (Date.now() < done && host.statusPayload().diag.inflight.length > 0) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
})

test('a real turn/end runs an enabled rule end-to-end (the wiring both bugs hid in)', async () => {
  const host = await import('../src/index.js')
  const marker = path.join(hostHome, 'fired.txt')
  fs.rmSync(marker, { force: true })
  // A real script both rules point at: `/usr/bin/touch` does not exist on Windows, and
  // the `.mjs` fixture is picked up by the automatic node interpreter on every platform.
  const scriptFixture = path.join(here, 'fixtures', 'probe.mjs')
  const config = {
    enabled: true,
    seeded: true,
    env: {},
    rules: [
      {
        id: 'r-fire', name: '应触发', enabled: true, command: scriptFixture, args: [marker],
        interpreter: '', cwd: '', triggers: { turnEnd: true, approval: false, question: false },
        precondition: 'any', debounceMs: 0, timeoutMs: 5000, shell: false, env: {},
      },
      {
        id: 'r-off', name: '已停用', enabled: false, command: scriptFixture, args: [marker + '.off'],
        interpreter: '', cwd: '', triggers: { turnEnd: true, approval: true, question: true },
        precondition: 'any', debounceMs: 0, timeoutMs: 5000, shell: false, env: {},
      },
    ],
  }
  const listeners = []
  const ctx = {
    on: (name, fn) => listeners.push({ name, fn }),
    get: (key) => (key === 'settings'
      ? { installSection: (owner, ns, schema, entry, hooks) => hooks.setSource(() => config) }
      : null),
    inject: () => {},
    effect: () => {},
  }
  host.apply(ctx)
  await settle(3) // let installSection land (dynamic import + fallback schema)
  const onSession = listeners.find((l) => l.name === 'session/event').fn

  // 线上真实形状的信封
  const historyFile = path.join(hostHome, 'notify-hub-history.json')
  const readHistory = () => {
    try { return JSON.parse(fs.readFileSync(historyFile, 'utf8')) } catch { return { entries: [], runtime: {} } }
  }

  // 上一个测试（a real turn/end envelope …）也会触发一次真实派发；同一规则还在执行时
  // 本次会被记成 skipped（"上一次同规则执行还在进行中"）。先等到没有在飞的执行再打这一枪。
  for (let i = 0; i < 60 && host.statusPayload().diag.inflight.length > 0; i += 1) {
    await new Promise((resolve) => setTimeout(resolve, 100))
  }

  // 线上真实形状的信封
  const firedAt = Date.now()
  onSession({ id: 'session-fire' }, { type: 'turn/end', seq: 1, time: firedAt, data: { turn: 1, reason: { kind: 'completed' } } })

  // 轮询而不是固定 sleep：turn/end 要先过几段 settle 检查才派发，之后还有一次真实的
  // node 冷启动（Windows 实测 600ms 以上），固定 900ms 会偶发跑不过。
  // 这里等到「marker 出现」或「历史里出现本次触发的 r-fire 条目」为止，最多 8s。
  let state = { entries: [], runtime: {} }
  const deadline = Date.now() + 12000
  while (Date.now() < deadline) {
    state = readHistory()
    // 等「本次触发的历史条目」而不是 marker：probe 先写 marker，插件随后才在子进程 close 里写历史，
    // 只等 marker 会拿到「marker 已在、历史还差一步」的快照（2026-11-12 实测 5 次里 3 次这样失败）。
    if (state.entries.some((e) => e.ruleId === 'r-fire' && e.startedAt >= firedAt)) break
    await new Promise((resolve) => setTimeout(resolve, 100))
  }
  // marker 可能刚在上一拍之后出现、历史还差一步落盘：收尾再读一遍，避免 fired 为空
  state = readHistory()
  const fired = state.entries.find((e) => e.ruleId === 'r-fire' && e.startedAt >= firedAt)
  // DSH 沙箱里 spawn(node) 会直接 EPERM：链路本身（观察→过滤→派发→记录）已经跑通，
  // 只有「脚本真的被执行」这一步依赖真实子进程，普通终端下才成立。
  if (!fs.existsSync(marker) && fired && /spawn EPERM|EPERM|EACCES/.test(String(fired.error || ''))) return 'sandbox-skip'

  assert.ok(fs.existsSync(marker), 'the enabled rule really ran — the whole chain dispatched, filtered and executed it')
  assert.equal(fs.existsSync(marker + '.off'), false, 'the disabled rule must not run')
  assert.ok(fired, 'a history entry was written for the real (non-test) run')
  assert.equal(fired.test, false, 'and it is marked as a real trigger, not a test run')
  assert.equal(fired.status, 'ok', JSON.stringify(fired))
  assert.equal(fired.trigger, 'turn-end')
  assert.equal(fired.detail, 'completed')
  assert.ok(state.runtime['r-fire'], 'runtime counters were updated for the real run')
})

// --- run ---------------------------------------------------------------------

for (const entry of tests) {
  try {
    const outcome = await entry[1]()
    if (outcome === 'sandbox-skip') {
      skipped += 1
      console.log('  SKIP ' + entry[0] + ' → 当前沙箱禁止派生子进程（spawn EPERM）；普通终端下会真正执行')
      continue
    }
    passed += 1
    console.log('  ok   ' + entry[0])
  } catch (e) {
    failures.push(entry[0] + ': ' + ((e && e.message) || String(e)))
    console.log('  FAIL ' + entry[0] + ' -> ' + ((e && e.message) || String(e)))
  }
}

for (const dispose of disposers) { try { dispose() } catch { /* noop */ } }
disposers.length = 0
try { fs.rmSync(hostHome, { recursive: true, force: true }) } catch { /* noop */ }

console.log('')
if (failures.length > 0) {
  console.log(failures.length + ' failing:')
  for (const f of failures) console.log('  - ' + f)
  process.exit(1)
}
console.log(passed + ' checks passed' + (skipped > 0 ? ', ' + skipped + ' skipped (sandbox blocks child processes)' : ''))
process.exit(0)
