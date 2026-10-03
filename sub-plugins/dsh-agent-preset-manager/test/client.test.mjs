import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import test from 'node:test'
import vm from 'node:vm'
import { fileURLToPath } from 'node:url'

// 客户端半区跑在浏览器里，这里用一个最小的 React 外壳把它装进 vm：
// createElement 只造对象，hooks 由一个可重入的渲染循环驱动。这样可以在 node 里
// 断言「注册了哪个 tab」和「面板向宿主请求了什么」，而不引入任何浏览器依赖。
const here = path.dirname(fileURLToPath(import.meta.url))
const CLIENT_FILE = path.join(here, '..', 'src', 'client.js')
const SOURCE = fs.readFileSync(CLIENT_FILE, 'utf8')
const API = '/__dsh-agent-presets'
const TAB_SLOT = 'settings.localPlugins.tab'

const STATE_PAYLOAD = {
  ok: true,
  plugin: 'dsh-agent-preset-manager',
  home: 'C:/home/.dsh',
  runtime: { supported: true, error: null, declared: ['mine'] },
  enabled: ['mine'],
  presets: [
    {
      id: 'mine', dir: 'C:/home/.dsh/agent-presets/mine', legacy: false, library: 'current',
      name: '示例预设', description: '测试用', order: 30, status: 'enabled', statusDetail: '',
      metadataError: null, compositionError: null, rowCount: 2, topLevelRows: 2,
      verdict: 'ok', verdictCounts: { ok: 2, suspect: 0, unavailable: 0 }, problems: [], enabled: true,
    },
    {
      id: 'old-one', dir: 'C:/home/.dsh/.agent-presets/old-one', legacy: true, library: 'legacy',
      name: '旧预设', description: '', order: 0, status: 'disabled', statusDetail: '',
      metadataError: null, compositionError: null, rowCount: 1, topLevelRows: 1,
      verdict: 'suspect', verdictCounts: { ok: 0, suspect: 1, unavailable: 0 },
      problems: [{ rowId: 'empty', name: null, level: 'suspect', reason: '缺少 name 字段' }], enabled: false,
    },
  ],
}

function loadClient(payload) {
  const requests = []
  const answer = typeof payload === 'function' ? payload : () => payload
  const fetchStub = async (url, options) => {
    requests.push({ url: url, options: options || {} })
    const body = answer(url, options)
    return { ok: true, status: 200, async json() { return body } }
  }
  const slot = { cursor: 0, values: [], refs: [], pending: [], dirty: false }
  const React = {
    createElement(type, props, ...children) { return { type: type, props: props || {}, children: children } },
    useState(init) {
      const index = slot.cursor++
      if (!(index in slot.values)) slot.values[index] = typeof init === 'function' ? init() : init
      const set = (next) => {
        slot.values[index] = typeof next === 'function' ? next(slot.values[index]) : next
        slot.dirty = true
      }
      return [slot.values[index], set]
    },
    useRef(init) { const index = slot.cursor++; if (!(index in slot.refs)) slot.refs[index] = { current: init }; return slot.refs[index] },
    useCallback(fn) { slot.cursor++; return fn },
    useEffect(fn) { slot.cursor++; slot.pending.push(fn) },
  }
  const captured = { spec: null }
  const sandbox = {
    console: console,
    setTimeout: setTimeout,
    clearTimeout: clearTimeout,
    fetch: fetchStub,
    window: { __ModuleLoader__: { load(spec) { captured.spec = spec } }, confirm: () => true },
  }
  const context = vm.createContext(sandbox)
  vm.runInContext(SOURCE, context, { filename: CLIENT_FILE })
  const client = captured.spec.factory((word) => (word === 'react' ? React : {}))

  async function render(Component, props, rounds = 3) {
    let tree = null
    for (let round = 0; round < rounds; round++) {
      slot.cursor = 0
      slot.pending = []
      slot.dirty = false
      tree = Component(props || {})
      for (const effect of slot.pending) effect()
      await new Promise((resolve) => setTimeout(resolve, 0))
      if (!slot.dirty) break
    }
    return tree
  }

  return { spec: captured.spec, client: client, requests: requests, render: render }
}

// 函数组件按名字内联展开：断言只关心「屏幕上出现了哪些字」，所以这里在渲染结束后
// 再补一轮求值（子组件若有 hooks 会写坏槽位，但那时渲染循环已经结束）。
function texts(node, out = [], depth = 0) {
  if (node === null || node === undefined || node === false) return out
  if (typeof node === 'string' || typeof node === 'number') { out.push(String(node)); return out }
  if (Array.isArray(node)) { for (const child of node) texts(child, out, depth); return out }
  if (typeof node !== 'object' || node.type === undefined) return out
  if (typeof node.type === 'function') {
    if (depth >= 4) { out.push('<' + (node.type.name || 'anonymous') + '>'); return out }
    let child = null
    try { child = node.type(node.props || {}) } catch (error) { out.push('<error:' + error.message + '>'); return out }
    return texts(child, out, depth + 1)
  }
  const props = node.props || {}
  if (props.value !== undefined) out.push(String(props.value))
  if (props.placeholder !== undefined) out.push(String(props.placeholder))
  for (const child of node.children || []) texts(child, out, depth)
  return out
}

function findByText(node, needle) {
  if (node === null || node === undefined || typeof node !== 'object') return null
  if (Array.isArray(node)) {
    for (const child of node) { const hit = findByText(child, needle); if (hit) return hit }
    return null
  }
  if (typeof node.type === 'function') return null
  const own = texts({ type: node.type, props: node.props, children: [] })
  if (own.some((line) => line.indexOf(needle) >= 0)) return node
  for (const child of node.children || []) { const hit = findByText(child, needle); if (hit) return hit }
  return null
}

test('client: the factory follows the module-table contract', () => {
  const harness = loadClient(STATE_PAYLOAD)
  assert.equal(harness.spec.id, 'dsh-agent-preset-manager')
  assert.equal(typeof harness.spec.factory, 'function')
  assert.equal(typeof harness.client.apply, 'function')
  assert.equal(Array.isArray(harness.client.inject), true)
  assert.equal(harness.client.inject.indexOf('slots') >= 0, true, 'it needs the slots service to add a tab')
})

test('client: apply adds one tab to the local-plugins settings page', () => {
  const harness = loadClient(STATE_PAYLOAD)
  const seen = { slots: [], spec: null, panel: null }
  const ctx = {
    slots: {
      inject(name, callback) { seen.slots.push(name); callback() },
      register(spec, Component) { seen.spec = spec; seen.panel = Component; return () => {} },
    },
  }
  harness.client.apply(ctx)
  assert.deepEqual(seen.slots, [TAB_SLOT])
  assert.equal(seen.spec.name, TAB_SLOT)
  assert.equal(seen.spec.id, 'agent-presets')
  assert.equal(seen.spec.order, 20)
  assert.equal(seen.spec.label(), 'Agent 预设')
  assert.equal(typeof seen.panel, 'function')
})

test('client: the panel loads its state from the host and renders the preset list', async () => {
  const harness = loadClient(STATE_PAYLOAD)
  const seen = { panel: null }
  harness.client.apply({
    slots: {
      inject(name, callback) { callback() },
      register(spec, Component) { seen.panel = Component; return () => {} },
    },
  })
  const tree = await harness.render(seen.panel)
  assert.equal(harness.requests.length >= 1, true, 'the panel asks the host for state on mount')
  assert.equal(harness.requests[0].url, API + '/state')
  assert.equal(harness.requests[0].options.method, undefined, 'state is a GET')
  const lines = texts(tree).join(' | ')
  assert.equal(lines.indexOf('从本地目录加载 agent preset') >= 0, true, 'the intro copy renders: ' + lines)
  assert.equal(lines.indexOf('mine') >= 0, true, lines)
  assert.equal(lines.indexOf('old-one') >= 0, true, lines)
  assert.equal(lines.indexOf('已启用') >= 0, true, 'an enabled preset shows the enabled tag: ' + lines)
})

test('client: a rejected state answer surfaces the host error and keeps rendering', async () => {
  const harness = loadClient(() => ({ ok: false, error: '内部错误：磁盘只读', state: null }))
  const seen = { panel: null }
  harness.client.apply({
    slots: {
      inject(name, callback) { callback() },
      register(spec, Component) { seen.panel = Component; return () => {} },
    },
  })
  const tree = await harness.render(seen.panel)
  const lines = texts(tree).join(' | ')
  assert.equal(lines.indexOf('内部错误：磁盘只读') >= 0, true, lines)
})

// 开关是 toggle 形态：role=switch + aria-checked 反映真实状态，滑块本体必须可见。
// 真机反馈「开关不好辨认」的根因有两处：开启态轨道用了文字色（label-primary，深色
// 主题下近白），以及 knob 是 span 却没设 display:block —— inline 元素会忽略
// width/height，圆点根本不渲染，轨道里就只剩一条色块。
function flatten(node, out = [], depth = 0) {
  if (node === null || node === undefined || node === false) return out
  if (Array.isArray(node)) { for (const child of node) flatten(child, out, depth); return out }
  if (typeof node !== 'object' || node.type === undefined) return out
  if (typeof node.type === 'function') {
    if (depth >= 4) return out
    let child = null
    try { child = node.type(node.props || {}) } catch (error) { return out }
    return flatten(child, out, depth + 1)
  }
  out.push(node)
  for (const child of node.children || []) flatten(child, out, depth)
  return out
}

test('client: every preset card exposes a toggle that shows its own state', async () => {
  const harness = loadClient(STATE_PAYLOAD)
  const seen = { panel: null }
  harness.client.apply({
    slots: {
      inject(name, callback) { callback() },
      register(spec, Component) { seen.panel = Component; return () => {} },
    },
  })
  const tree = await harness.render(seen.panel)
  const switches = flatten(tree).filter((node) => (node.props || {}).role === 'switch')
  assert.equal(switches.length, 2, 'one toggle per preset card')
  const on = switches[0].props
  const off = switches[1].props
  assert.equal(on['aria-checked'], 'true', 'an enabled preset reads as checked')
  assert.equal(off['aria-checked'], 'false', 'a disabled preset reads as unchecked')
  assert.equal(on['aria-pressed'], undefined, 'switch semantics replaced the old pressed-button semantics')
  assert.match(String(on.style.background), /brand-primary/, 'the on track uses the brand colour: ' + String(on.style.background))
  assert.match(String(off.style.background), /border-l3/, 'the off track stays muted: ' + String(off.style.background))
  const onKnob = (switches[0].children || [])[0]
  const offKnob = (switches[1].children || [])[0]
  assert.equal(onKnob.props.style.display, 'block', 'the knob must be a block element or its size is ignored')
  assert.equal(onKnob.props.style.transform, 'translateX(16px)', 'the knob slides right when on')
  assert.equal(offKnob.props.style.transform, 'translateX(0)', 'the knob sits left when off')
})
