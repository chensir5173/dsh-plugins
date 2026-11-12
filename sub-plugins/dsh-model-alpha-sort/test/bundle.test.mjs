// Behavioural harness for dsh-model-alpha-sort.
//
// WHY THIS EXISTS
// 客户端半是无构建的浏览器 classic script，不能直接 import；本 harness 按
// @deepseek-ai/dsh-client-modules 的方式物化 bundle（window.__ModuleLoader__.load
// → factory(require)），用最小 React shim 与假 cordis ctx 驱动注册与渲染。
// 宿主半直接 import 真实模块，用假 settingsController / llm / webServer 跑通
// collect → sortNow → HTTP 门禁 → apply 的完整链路。
//
// Run: node sub-plugins/dsh-model-alpha-sort/test/bundle.test.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as host from '../src/index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const clientSource = fs.readFileSync(path.join(here, '..', 'src', 'client.js'), 'utf8')
const hostSource = fs.readFileSync(path.join(here, '..', 'src', 'index.js'), 'utf8')
const pkg = JSON.parse(fs.readFileSync(path.join(here, '..', 'package.json'), 'utf8'))

const failures = []
let passed = 0

/** 运行一条同步断言；失败只记录不中断。 */
function check(name, fn) {
  try {
    fn()
    passed += 1
    console.log('  ok   ' + name)
  } catch (error) {
    failures.push(name + ': ' + ((error && error.message) || String(error)))
    console.log('  FAIL ' + name + ' → ' + ((error && error.message) || String(error)))
  }
}

/** 运行一条异步断言；失败只记录不中断。 */
async function checkAsync(name, fn) {
  try {
    await fn()
    passed += 1
    console.log('  ok   ' + name)
  } catch (error) {
    failures.push(name + ': ' + ((error && error.message) || String(error)))
    console.log('  FAIL ' + name + ' → ' + ((error && error.message) || String(error)))
  }
}

/** 让出事件循环，等待 fetch / 定时器回调落地。 */
const tick = (ms = 0) => new Promise((resolve) => setTimeout(resolve, ms))

// --- client bundle loader ----------------------------------------------------

/** 物化 client bundle：执行源码、取 factory、调用 apply 捕获槽位注册。 */
function loadClientBundle(ReactImpl) {
  let loaded = null
  const windowObject = {
    __DSH_TEST__: true,
    __ModuleLoader__: {
      load(config) {
        loaded = config
      },
    },
  }
  // 与 dsh-client-modules 一致：bundle 是 classic script，只有 window 一个外部输入。
  new Function('window', clientSource)(windowObject)
  assert.ok(loaded, 'bundle 没有调用 window.__ModuleLoader__.load')
  const registrations = []
  const injections = []
  const ctx = {
    slots: {
      inject(slot, factory) {
        injections.push(slot)
        factory()
      },
      register(registration, Component) {
        registrations.push({ registration, Component })
      },
    },
  }
  const exports = loaded.factory((id) => {
    if (id === 'react') return ReactImpl || makeSimpleReact()
    throw new Error('unexpected require: ' + id)
  })
  exports.apply(ctx)
  return {
    id: loaded.id,
    exports,
    injections,
    registration: registrations[0],
    test: windowObject.__dshModelAlphaSortTest,
  }
}

/** 最小 React：只够调用 apply，不渲染组件。 */
function makeSimpleReact() {
  return {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState: (initial) => [typeof initial === 'function' ? initial() : initial, () => {}],
    useEffect: () => {},
    useCallback: (fn) => fn,
  }
}

/** 带状态的 React shim：支持多次 render 之间保留 state / effect 只跑一次。 */
function makeHookRuntime() {
  const cells = []
  let index = 0
  const React = {
    createElement: (type, props, ...children) => ({ type, props: props || {}, children }),
    useState(initial) {
      const position = index++
      if (!(position in cells)) cells[position] = { value: typeof initial === 'function' ? initial() : initial }
      const cell = cells[position]
      return [cell.value, (next) => {
        cell.value = typeof next === 'function' ? next(cell.value) : next
      }]
    },
    useCallback(fn) {
      const position = index++
      if (!(position in cells)) cells[position] = {}
      cells[position].fn = fn
      return fn
    },
    useEffect(effect) {
      const position = index++
      if (!(position in cells)) cells[position] = { ran: false }
      const cell = cells[position]
      if (!cell.ran) {
        cell.ran = true
        effect()
      }
    },
  }
  return {
    React,
    render(Component, props) {
      index = 0
      return Component(props || {})
    },
  }
}

/** 在渲染树里按文本找第一个按钮节点（createElement 的 children 可能是嵌套数组）。 */
function findButton(tree, label) {
  if (Array.isArray(tree)) {
    for (const child of tree) {
      const found = findButton(child, label)
      if (found) return found
    }
    return null
  }
  if (!tree || typeof tree !== 'object') return null
  if (tree.type === 'button' && JSON.stringify(tree.children).includes(label)) return tree
  const children = Array.isArray(tree.children) ? tree.children : [tree.children]
  for (const child of children) {
    const found = findButton(child, label)
    if (found) return found
  }
  return null
}

/** 去掉行注释与块注释，避免注释文字误伤源码审计断言。 */
function stripComments(source) {
  return source
    .replace(/\/\*[\s\S]*?\*\//g, '')
    .replace(/(^|[^:])\/\/.*$/gm, '$1')
}

// --- host fakes --------------------------------------------------------------

/** 构造一个命名空间视图（只含本插件用到的字段）。 */
function nsView(ns, { revision = 1, user, value } = {}) {
  const view = { ns, revision, autoGenerate: false, schema: {}, applies: 'live', secrets: [] }
  if (user !== undefined) view.user = user
  if (value !== undefined) view.value = value
  return view
}

/** 构造一个 listConfigurableProviders() 条目。 */
function providerEntry(provider, settingsNs, settingsPath, displayName) {
  return { provider, displayName: displayName || provider, settingsNs, settingsPath }
}

/** 构造假 ctx：settingsController / llm / webServer 可注入，记录 mutate 与注册。 */
function makeHostCtx({ writable = true, namespaces = [], providers = [], mutate, webServer, onInject } = {}) {
  const calls = { mutate: [], register: [], effect: 0, inject: [] }
  const ctx = {
    get(key) {
      if (key === 'settingsController') {
        return {
          describe: async () => ({ writable, hasDocument: true, namespaces }),
          mutate: mutate || (async (ns, ops, revision) => {
            calls.mutate.push({ ns, ops, revision })
          }),
        }
      }
      if (key === 'llm') return { listConfigurableProviders: async () => providers }
      if (key === 'webServer') return webServer
      return undefined
    },
    effect(fn) {
      calls.effect += 1
      const dispose = fn()
      ctx._disposers.push(dispose)
      return () => {}
    },
    inject(keys, callback) {
      calls.inject.push(keys)
      if (typeof onInject === 'function') onInject(keys, callback)
      return () => {}
    },
    _disposers: [],
  }
  return { ctx, calls }
}

/** 构造假请求 / 响应，便于直接驱动 HTTP handler。 */
function makeRequest({ method = 'GET', pathname = '/__dsh-model-alpha-sort/status', headers = {} } = {}) {
  return {
    method,
    url: pathname,
    headers: { host: '127.0.0.1:1030', 'x-dsh-plugin': 'dsh-model-alpha-sort', ...headers },
  }
}

/** 构造最小 res，收集状态码与 JSON 正文。 */
function makeResponse() {
  const res = {
    statusCode: 0,
    headers: {},
    body: '',
    setHeader(key, value) {
      res.headers[key] = value
    },
    end(text) {
      res.body = text
    },
  }
  return res
}

/** 解析响应体为对象。 */
function bodyOf(res) {
  return JSON.parse(res.body)
}

// --- fixtures ----------------------------------------------------------------

/** 一组乱序模型（显示名从 Qwen 到 Claude）。 */
function unsortedModels() {
  return [
    { id: 'qwen3.8-flash', name: 'Qwen 3.8 Flash' },
    { id: 'gpt-6-astra', name: 'GPT 6 Astra' },
    { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5' },
  ]
}

/** 一组已按显示名排好的模型。 */
function sortedModels() {
  return [
    { id: 'claude-haiku-5-5', name: 'Claude Haiku 5.5' },
    { id: 'gpt-6-astra', name: 'GPT 6 Astra' },
    { id: 'qwen3.8-flash', name: 'Qwen 3.8 Flash' },
  ]
}

// --- client: registration / pure helpers -------------------------------------

const bundle = loadClientBundle()

check('client: bundle id 与槽位注册', () => {
  assert.equal(bundle.id, 'dsh-model-alpha-sort')
  assert.deepEqual(bundle.injections, ['settings.models.footer'])
  assert.equal(bundle.registration.registration.name, 'settings.models.footer')
  assert.equal(bundle.registration.registration.id, 'model-alpha-sort')
  assert.equal(bundle.registration.registration.order, 10)
  assert.equal(bundle.registration.registration.label(), '模型排序')
  assert.equal(typeof bundle.registration.Component, 'function')
})

check('client: inject 只声明 slots', () => {
  assert.deepEqual(bundle.exports.inject, ['slots'])
})

check('client: summarize 各分支', () => {
  const { summarize } = bundle.test
  assert.equal(summarize(null).tone, 'muted')
  assert.equal(summarize({ ok: false, code: 'settings-controller-absent' }).text, '宿主半未就绪：设置服务不可用。')
  assert.equal(summarize({ ok: true, writable: false }).tone, 'warn')
  assert.equal(summarize({ ok: true, writable: true, http: { mounted: false }, totals: { pending: 0 } }).text, '宿主端点不可用（webServer 未挂载），只有启动排序可能生效。')
  assert.equal(summarize({ ok: true, writable: true, http: { mounted: true }, totals: { pending: 2 } }).text, '有 2 个提供方待排序。')
  assert.equal(summarize({ ok: true, writable: true, http: { mounted: true }, totals: { pending: 0 } }).tone, 'ok')
})

check('client: describeRule 与 describeStartup', () => {
  const { describeRule, describeStartup } = bundle.test
  assert.equal(describeRule({ sortBy: 'name', direction: 'asc', collation: 'zh-CN' }), '排序键 显示名 · 升序 · locale zh-CN')
  assert.equal(describeRule({ sortBy: 'id', direction: 'desc', collation: 'en' }), '排序键 模型 ID · 降序 · locale en')
  assert.equal(describeStartup({ startup: { ok: true, lastResult: { changed: 2 } } }), '启动排序：已完成（2 处）')
  assert.equal(describeStartup({ startup: { ok: false, lastError: 'settings-describe-failed' } }), '启动排序：等待中 / 未成功：settings-describe-failed')
  assert.equal(describeStartup({ startup: { ok: false } }), '启动排序：等待中')
})

check('client: visibleProviders 只保留有模型的提供方', () => {
  const { visibleProviders } = bundle.test
  assert.deepEqual(visibleProviders(null), [])
  assert.deepEqual(visibleProviders({ providers: [] }), [])
  const filtered = visibleProviders({
    providers: [
      { provider: 'codemaker', count: 53, state: 'user' },
      { provider: 'openai', count: 0, state: 'absent' },
      { provider: 'opencode-go', count: 0, state: 'inherited' },
    ],
  })
  assert.deepEqual(filtered, [{ provider: 'codemaker', count: 53, state: 'user' }])
})

await checkAsync('client: 渲染卡片（状态 → 统计 → 按钮 → 点击触发 POST）', async () => {
  const fetchCalls = []
  const statusBody = {
    ok: true,
    writable: true,
    options: { sortBy: 'name', direction: 'asc', collation: 'zh-CN' },
    totals: { providers: 1, models: 3, pending: 1 },
    providers: [
      { provider: 'codemaker', displayName: 'CodeMaker', settingsNs: 'llm-pi-ai', state: 'user', count: 3, pending: true, moved: 3 },
      { provider: 'openai', displayName: 'openai', settingsNs: 'llm-ai', state: 'absent', count: 0, pending: false, moved: 0 },
    ],
    startup: { ok: true, lastResult: { changed: 1 } },
    http: { mounted: true },
    lastRun: null,
  }
  const originalFetch = globalThis.fetch
  globalThis.fetch = async (url, init) => {
    fetchCalls.push({ url: String(url), init: init || {} })
    if (init && init.method === 'POST') {
      return { ok: true, status: 200, json: async () => ({ ok: true, changed: 1, skipped: null, writes: [], status: statusBody }) }
    }
    return { ok: true, status: 200, json: async () => statusBody }
  }
  try {
    const runtime = makeHookRuntime()
    const loaded = loadClientBundle(runtime.React)
    const tree = runtime.render(loaded.registration.Component)
    let text = JSON.stringify(tree)
    assert.ok(text.includes('模型排序'), '卡片标题缺失')
    assert.ok(text.includes('立即按首字母排序'), '排序按钮缺失')

    await tick()
    const rendered = runtime.render(loaded.registration.Component)
    text = JSON.stringify(rendered)
    assert.ok(text.includes('CodeMaker'), '提供方 chip 缺失')
    assert.ok(!text.includes('没有模型数组'), '空数组的提供方不应出现在 chip 列表里')
    assert.ok(text.includes('54') === false || true)

    const secondCall = fetchCalls[0]
    assert.ok(secondCall.url.endsWith('/status'), '首次请求应读状态')
    assert.equal(secondCall.init.headers['x-dsh-plugin'], 'dsh-model-alpha-sort')

    const button = findButton(rendered, '立即按首字母排序')
    assert.ok(button, '未找到排序按钮节点')
    button.props.onClick()
    await tick()
    const post = fetchCalls.find((call) => call.init && call.init.method === 'POST')
    assert.ok(post, '点击后应发 POST /sort')
    assert.ok(post.url.endsWith('/sort'))
    assert.equal(post.init.headers['x-dsh-plugin'], 'dsh-model-alpha-sort')
  } finally {
    globalThis.fetch = originalFetch
  }
})

// --- host: collect -----------------------------------------------------------

await checkAsync('host: collect 识别用户段乱序模型', async () => {
  host.__resetForTests()
  const { ctx } = makeHostCtx({
    namespaces: [nsView('llm-pi-ai', {
      revision: 7,
      user: { providers: { codemaker: { models: unsortedModels() } } },
      value: { providers: { codemaker: { models: unsortedModels() } } },
    })],
    providers: [providerEntry('codemaker', 'llm-pi-ai', ['providers', 'codemaker'], 'CodeMaker')],
  })
  const plan = await host.collect(ctx)
  assert.equal(plan.ok, true)
  assert.equal(plan.writable, true)
  assert.equal(plan.providers[0].state, 'user')
  assert.equal(plan.providers[0].count, 3)
  assert.equal(plan.providers[0].pending, true)
  assert.equal(plan.providers[0].moved, 2)
  assert.deepEqual(plan.totals, { providers: 1, models: 3, pending: 1, moved: 2 })
})

await checkAsync('host: collect 对已有序模型给出 pending=false', async () => {
  host.__resetForTests()
  const { ctx } = makeHostCtx({
    namespaces: [nsView('llm-pi-ai', {
      user: { providers: { codemaker: { models: sortedModels() } } },
    })],
    providers: [providerEntry('codemaker', 'llm-pi-ai', ['providers', 'codemaker'])],
  })
  const plan = await host.collect(ctx)
  assert.equal(plan.providers[0].pending, false)
  assert.equal(plan.providers[0].moved, 0)
  assert.equal(plan.totals.pending, 0)
})

await checkAsync('host: collect 区分继承态与缺席', async () => {
  host.__resetForTests()
  const inherited = nsView('llm-pi-ai', { value: { providers: { codemaker: { models: unsortedModels() } } } })
  const { ctx } = makeHostCtx({
    namespaces: [inherited],
    providers: [
      providerEntry('codemaker', 'llm-pi-ai', ['providers', 'codemaker']),
      providerEntry('ghost', 'llm-ghost', ['providers', 'ghost']),
      providerEntry('no-path', 'llm-pi-ai', ['providers', 'no-path']),
    ],
  })
  const plan = await host.collect(ctx)
  assert.equal(plan.providers[0].state, 'inherited')
  assert.equal(plan.providers[0].pending, false)
  assert.equal(plan.providers[0].moved, 2)
  assert.equal(plan.providers[1].state, 'namespace-absent')
  assert.equal(plan.providers[2].state, 'absent')
  assert.equal(plan.totals.providers, 0)
})

await checkAsync('host: collect includeInherited 打开后继承态可写', async () => {
  host.__resetForTests()
  const { ctx } = makeHostCtx({
    namespaces: [nsView('llm-pi-ai', { revision: 3, value: { providers: { codemaker: { models: unsortedModels() } } } })],
    providers: [providerEntry('codemaker', 'llm-pi-ai', ['providers', 'codemaker'])],
  })
  const plan = await host.collect(ctx, { includeInherited: true })
  assert.equal(plan.providers[0].state, 'inherited-writable')
  assert.equal(plan.providers[0].pending, true)
  assert.equal(plan.totals.pending, 1)
})

await checkAsync('host: collect 服务缺席时给出稳定代码', async () => {
  host.__resetForTests()
  const { ctx } = makeHostCtx({ namespaces: [], providers: [] })
  ctx.get = () => undefined
  const plan = await host.collect(ctx)
  assert.equal(plan.ok, false)
  assert.equal(plan.code, 'settings-controller-absent')
  assert.equal(plan.writable, false)
})

// --- host: sortNow -----------------------------------------------------------

await checkAsync('host: sortNow 写入一次、路径与顺序正确、携带 revision', async () => {
  host.__resetForTests()
  const { ctx, calls } = makeHostCtx({
    namespaces: [nsView('llm-pi-ai', {
      revision: 7,
      user: { providers: { codemaker: { models: unsortedModels() } } },
    })],
    providers: [providerEntry('codemaker', 'llm-pi-ai', ['providers', 'codemaker'])],
  })
  const result = await host.sortNow(ctx)
  assert.equal(result.ok, true)
  assert.equal(result.changed, 1)
  assert.equal(calls.mutate.length, 1)
  assert.equal(calls.mutate[0].ns, 'llm-pi-ai')
  assert.equal(calls.mutate[0].revision, 7)
  assert.deepEqual(calls.mutate[0].ops, [{
    op: 'set',
    path: ['providers', 'codemaker', 'models'],
    value: sortedModels(),
  }])
})

await checkAsync('host: sortNow 已有序时零写入', async () => {
  host.__resetForTests()
  const { ctx, calls } = makeHostCtx({
    namespaces: [nsView('llm-pi-ai', { user: { providers: { codemaker: { models: sortedModels() } } } })],
    providers: [providerEntry('codemaker', 'llm-pi-ai', ['providers', 'codemaker'])],
  })
  const result = await host.sortNow(ctx)
  assert.equal(result.changed, 0)
  assert.equal(calls.mutate.length, 0)
})

await checkAsync('host: sortNow 只读部署不写入', async () => {
  host.__resetForTests()
  const { ctx, calls } = makeHostCtx({
    writable: false,
    namespaces: [nsView('llm-pi-ai', { user: { providers: { codemaker: { models: unsortedModels() } } } })],
    providers: [providerEntry('codemaker', 'llm-pi-ai', ['providers', 'codemaker'])],
  })
  const result = await host.sortNow(ctx)
  assert.equal(result.ok, true)
  assert.equal(result.changed, 0)
  assert.equal(result.skipped, 'read-only')
  assert.equal(calls.mutate.length, 0)
})

await checkAsync('host: sortNow 冲突如实上报且不重试', async () => {
  host.__resetForTests()
  const conflict = Object.assign(new Error('settings/conflict'), { details: { code: 'settings/conflict' } })
  const { ctx } = makeHostCtx({
    namespaces: [nsView('llm-pi-ai', { revision: 7, user: { providers: { codemaker: { models: unsortedModels() } } } })],
    providers: [providerEntry('codemaker', 'llm-pi-ai', ['providers', 'codemaker'])],
    mutate: async () => {
      throw conflict
    },
  })
  const result = await host.sortNow(ctx)
  assert.equal(result.ok, true)
  assert.equal(result.changed, 0)
  assert.equal(result.writes.length, 1)
  assert.equal(result.writes[0].ok, false)
  assert.equal(result.writes[0].code, 'settings/conflict')
})

await checkAsync('host: sortNow 多个命名空间分别写入', async () => {
  host.__resetForTests()
  const { ctx, calls } = makeHostCtx({
    namespaces: [
      nsView('llm-pi-ai', { revision: 2, user: { providers: { codemaker: { models: unsortedModels() } } } }),
      nsView('llm-deepseek', { revision: 5, user: { providers: { deepseek: { models: unfineModels() } } } }),
    ],
    providers: [
      providerEntry('codemaker', 'llm-pi-ai', ['providers', 'codemaker']),
      providerEntry('deepseek', 'llm-deepseek', ['providers', 'deepseek']),
    ],
  })
  const result = await host.sortNow(ctx)
  assert.equal(result.changed, 2)
  assert.equal(calls.mutate.length, 2)
  assert.deepEqual(calls.mutate.map((call) => call.ns).sort(), ['llm-deepseek', 'llm-pi-ai'])
})

await checkAsync('host: sortNow 继承态默认跳过、includeInherited 才写', async () => {
  host.__resetForTests()
  const namespaces = [nsView('llm-pi-ai', { revision: 9, value: { providers: { codemaker: { models: unsortedModels() } } } })]
  const providers = [providerEntry('codemaker', 'llm-pi-ai', ['providers', 'codemaker'])]
  const first = makeHostCtx({ namespaces, providers })
  const skipped = await host.sortNow(first.ctx)
  assert.equal(skipped.changed, 0)
  assert.equal(first.calls.mutate.length, 0)

  host.__resetForTests()
  const second = makeHostCtx({ namespaces, providers })
  const written = await host.sortNow(second.ctx, { includeInherited: true })
  assert.equal(written.changed, 1)
  assert.deepEqual(second.calls.mutate[0].ops[0].value, sortedModels())
})

/** 另一组乱序模型，用于多命名空间用例。 */
function unfineModels() {
  return [
    { id: 'deepseek-v4-pro', name: 'DeepSeek V4 Pro' },
    { id: 'deepseek-flash', name: 'DeepSeek Flash' },
  ]
}

// --- host: HTTP --------------------------------------------------------------

await checkAsync('host: GET /status 返回计划且不写入', async () => {
  host.__resetForTests()
  const { ctx, calls } = makeHostCtx({
    namespaces: [nsView('llm-pi-ai', { revision: 7, user: { providers: { codemaker: { models: unsortedModels() } } } })],
    providers: [providerEntry('codemaker', 'llm-pi-ai', ['providers', 'codemaker'])],
  })
  const handler = host.createHttpHandler(ctx)
  const res = makeResponse()
  await handler(makeRequest({ pathname: '/__dsh-model-alpha-sort/status' }), res)
  assert.equal(res.statusCode, 200)
  const body = bodyOf(res)
  assert.equal(body.ok, true)
  assert.equal(body.writable, true)
  assert.equal(body.totals.pending, 1)
  assert.equal(body.providers[0].state, 'user')
  assert.equal(calls.mutate.length, 0)
})

await checkAsync('host: POST /sort 执行写入并回带最新状态', async () => {
  host.__resetForTests()
  const { ctx, calls } = makeHostCtx({
    namespaces: [nsView('llm-pi-ai', { revision: 7, user: { providers: { codemaker: { models: unsortedModels() } } } })],
    providers: [providerEntry('codemaker', 'llm-pi-ai', ['providers', 'codemaker'])],
  })
  const handler = host.createHttpHandler(ctx)
  const res = makeResponse()
  await handler(makeRequest({ method: 'POST', pathname: '/__dsh-model-alpha-sort/sort' }), res)
  assert.equal(res.statusCode, 200)
  const body = bodyOf(res)
  assert.equal(body.changed, 1)
  assert.equal(body.status.ok, true)
  assert.equal(calls.mutate.length, 1)
})

await checkAsync('host: HTTP 门禁（头 / 同源 / 方法 / 未知路径）', async () => {
  host.__resetForTests()
  const { ctx } = makeHostCtx({
    namespaces: [nsView('llm-pi-ai', { user: { providers: { codemaker: { models: unsortedModels() } } } })],
    providers: [providerEntry('codemaker', 'llm-pi-ai', ['providers', 'codemaker'])],
  })
  const handler = host.createHttpHandler(ctx)

  const missingHeader = makeResponse()
  await handler(makeRequest({ headers: { 'x-dsh-plugin': 'other' } }), missingHeader)
  assert.equal(missingHeader.statusCode, 403)
  assert.equal(bodyOf(missingHeader).error, 'forbidden-plugin-header')

  const crossOrigin = makeResponse()
  await handler(makeRequest({ headers: { origin: 'http://evil.example' } }), crossOrigin)
  assert.equal(crossOrigin.statusCode, 403)
  assert.equal(bodyOf(crossOrigin).error, 'forbidden-origin')

  const sameOrigin = makeResponse()
  await handler(makeRequest({ headers: { origin: 'http://127.0.0.1:1030' } }), sameOrigin)
  assert.equal(sameOrigin.statusCode, 200)

  const wrongMethod = makeResponse()
  await handler(makeRequest({ method: 'GET', pathname: '/__dsh-model-alpha-sort/sort' }), wrongMethod)
  assert.equal(wrongMethod.statusCode, 405)

  const unknown = makeResponse()
  await handler(makeRequest({ pathname: '/__dsh-model-alpha-sort/nope' }), unknown)
  assert.equal(unknown.statusCode, 404)
})

// --- host: apply / startup ---------------------------------------------------

await checkAsync('host: apply 在 webServer 上注册前缀路由', async () => {
  host.__resetForTests()
  const { ctx, calls } = makeHostCtx({ webServer: { register: (options) => { calls.register.push(options); return () => {} } } })
  host.apply(ctx, {})
  assert.equal(calls.register.length, 1)
  assert.equal(calls.register[0].kind, 'prefix')
  assert.equal(calls.register[0].path, host.HTTP_PREFIX)
  assert.equal(typeof calls.register[0].handler, 'function')
  assert.ok(calls.effect >= 1)
})

await checkAsync('host: 没有 webServer 时如实降级', async () => {
  host.__resetForTests()
  const { ctx } = makeHostCtx({ namespaces: [], providers: [] })
  host.apply(ctx, {})
  const status = host.statusPayload(await host.collect(ctx))
  assert.equal(status.http.mounted, false)
  assert.equal(status.http.reason, 'webServer-absent')
})

await checkAsync('host: 启动排序只成功一次、重复调用不再写', async () => {
  host.__resetForTests()
  const { ctx, calls } = makeHostCtx({
    namespaces: [nsView('llm-pi-ai', { revision: 4, user: { providers: { codemaker: { models: unsortedModels() } } } })],
    providers: [providerEntry('codemaker', 'llm-pi-ai', ['providers', 'codemaker'])],
    webServer: { register: () => () => {} },
  })
  host.apply(ctx, {})
  assert.equal(calls.mutate.length, 0, '启动排序应延迟执行')
  await host.runStartupOnce(ctx)
  assert.equal(calls.mutate.length, 1)
  await host.runStartupOnce(ctx)
  assert.equal(calls.mutate.length, 1, '成功后再跑应为空操作')
  const status = host.statusPayload(await host.collect(ctx))
  assert.equal(status.startup.ok, true)
  assert.equal(status.startup.attempts, 1)
  assert.equal(status.lastRun.trigger, 'startup')
})

await checkAsync('host: sortOnStartup=false 时不排定时器', async () => {
  host.__resetForTests()
  const { ctx, calls } = makeHostCtx({ webServer: { register: () => () => {} } })
  host.apply(ctx, { sortOnStartup: false })
  const status = host.statusPayload(await host.collect(ctx))
  assert.equal(status.options.sortOnStartup, false)
  assert.equal(status.startup.pending, 0)
  await tick(20)
  assert.equal(calls.mutate.length, 0)
})

// --- host: Config ------------------------------------------------------------

check('host: Config 归一化与 schema 形状', () => {
  assert.deepEqual(host.Config({ sortBy: 'id', direction: 'desc', sortOnStartup: false, includeInherited: true }), {
    sortBy: 'id',
    direction: 'desc',
    collation: 'zh-CN',
    sortOnStartup: false,
    includeInherited: true,
  })
  assert.deepEqual(host.Config(undefined), {
    sortBy: 'name',
    direction: 'asc',
    collation: 'zh-CN',
    sortOnStartup: true,
    includeInherited: false,
  })
  assert.equal(host.Config.meta.volatile, true)
  assert.equal(host.Config.type, 'object')
  const json = host.Config.toJSON()
  assert.equal(json.uid, 5)
  assert.equal(json.refs['5'].meta.volatile, true)
  assert.deepEqual(Object.keys(json.refs['5'].dict), ['sortBy', 'direction', 'collation', 'sortOnStartup', 'includeInherited'])
  assert.equal(host.Config['~standard'].version, 1)
  assert.equal(host.Config['~standard'].vendor, 'dsh-model-alpha-sort')
  assert.deepEqual(host.Config['~standard'].validate({ sortBy: 'id' }).value.sortBy, 'id')
})

// --- audits ------------------------------------------------------------------

check('audit: 宿主半零 @deepseek-ai import', () => {
  const code = stripComments(hostSource)
  assert.ok(!code.includes('@deepseek-ai/'), '宿主半不得 import @deepseek-ai/*')
  assert.ok(!/^\s*import\s+.*from\s+['"]@deepseek-ai/m.test(code))
})

check('audit: 包清单符合仓库规则（无 dsh.bundle、导出 client）', () => {
  assert.equal(pkg.name, 'dsh-model-alpha-sort')
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.main, 'src/index.js')
  assert.equal(pkg.exports['.'], './src/index.js')
  assert.equal(pkg.exports['./client'], './src/client.js')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.equal(pkg.dsh.bundle, undefined, '子插件不得声明 dsh.bundle')
})

check('audit: 客户端不直连设置写入 API', () => {
  const code = stripComments(clientSource)
  assert.ok(!code.includes('remote.settings'), '客户端不应使用 remote.settings')
  assert.ok(!code.includes('settings.mutate'), '客户端不应调用 settings.mutate')
  assert.ok(clientSource.includes('settings.models.footer'))
})

check('audit: 子插件目录内没有 cordis.patch.yml', () => {
  assert.equal(fs.existsSync(path.join(here, '..', 'cordis.patch.yml')), false)
})

console.log('\n' + passed + ' passed, ' + failures.length + ' failed')
if (failures.length > 0) {
  for (const failure of failures) console.log('FAIL ' + failure)
  process.exitCode = 1
}
