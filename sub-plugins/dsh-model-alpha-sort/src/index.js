/**
 * dsh-model-alpha-sort — 宿主半。
 *
 * 职责只有一件：把每个 provider 用户段里已有的模型数组按显示名重排，并用官方
 * `settingsController.mutate` 写回。排序顺序就是 `llm.listModels` 的顺序，
 * 因此设置页列表、composer 选择器与 /model 弹窗会同时变成字母序。
 *
 * 约束：本文件不得 import 任何 `@deepseek-ai/*`（仓库既有硬规则）；能力一律
 * 经 inject / ctx.get 取得，服务缺席时静默降级。
 */

import {
  DEFAULT_OPTIONS,
  getAtPath,
  isSorted,
  movedCount,
  normalizeOptions,
  sortModels,
  sortPathOf,
} from './sort.js'

export const name = 'dsh-model-alpha-sort'
export const inject = []
export const HTTP_PREFIX = '/__dsh-model-alpha-sort'
export const PLUGIN_HEADER = 'x-dsh-plugin'
export const PLUGIN_HEADER_VALUE = 'dsh-model-alpha-sort'
export const STARTUP_DELAYS = Object.freeze([1500, 5000, 12000])

/** 配置默认值：排序键、方向、locale、启动自动排序、是否连继承清单一起排。 */
export const CONFIG_DEFAULTS = Object.freeze({
  ...DEFAULT_OPTIONS,
  sortOnStartup: true,
  includeInherited: false,
})

/** 模块级运行状态（apply 每次按新 ctx 重置，见 resetRuntime）。 */
const STATE = {
  ctx: null,
  options: { ...CONFIG_DEFAULTS },
  startup: { ok: false, pending: 0, running: false, attempts: 0, lastError: null, lastResult: null },
  http: { mounted: false, reason: null },
  lastRun: null,
  timers: [],
}

/**
 * 判断一个值是否为普通对象（排除 null 与数组）。
 * @param {unknown} value 任意值，例 {}
 * @returns {boolean} 例 true
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 取错误文案；未知错误也给出字符串而不是 undefined。
 * @param {unknown} error 任意抛出的值，例 new Error('boom')
 * @returns {string} 例 'boom'
 */
function errorMessage(error) {
  if (error === undefined || error === null) return 'unknown error'
  if (typeof error === 'string') return error
  if (typeof error.message === 'string' && error.message !== '') return error.message
  return String(error)
}

/**
 * 取宿主服务：优先 ctx.get(name)，退路是属性访问；两者都缺席返回 undefined。
 * @param {object} ctx cordis 上下文，例 { get: (key) => … }
 * @param {string} key 服务名，例 'settingsController'
 * @returns {unknown} 服务实例或 undefined
 */
function serviceOf(ctx, key) {
  if (!ctx) return undefined
  try {
    if (typeof ctx.get === 'function') {
      const value = ctx.get(key)
      if (value !== undefined && value !== null) return value
    }
  } catch {
    // ctx.get 抛错视同服务缺席，继续尝试属性访问。
  }
  try {
    const value = ctx[key]
    return value === null ? undefined : value
  } catch {
    return undefined
  }
}

/**
 * 把入口配置（profile 行解析后的值）归一化成运行选项。
 * @param {unknown} input 例 { sortOnStartup: false, direction: 'desc' }
 * @returns {{ sortBy: 'name'|'id', direction: 'asc'|'desc', collation: string, sortOnStartup: boolean, includeInherited: boolean }} 例 { sortBy: 'name', direction: 'asc', collation: 'zh-CN', sortOnStartup: true, includeInherited: false }
 * @example normalizeConfig({ sortBy: 'id' })
 */
export function normalizeConfig(input) {
  const source = isPlainObject(input) ? input : {}
  const options = normalizeOptions(source)
  return {
    ...options,
    sortOnStartup: typeof source.sortOnStartup === 'boolean' ? source.sortOnStartup : CONFIG_DEFAULTS.sortOnStartup,
    includeInherited: typeof source.includeInherited === 'boolean' ? source.includeInherited : CONFIG_DEFAULTS.includeInherited,
  }
}

/** 0.2.0 入口配置的归一化函数，Config 的 validate 与 apply 共用。 */
export const normalizeEntryConfig = normalizeConfig

/**
 * 0.2.0 入口配置 schema（手写，零依赖）。
 *
 * 0.2.0 已退役 settings.installSection，设置服务把每个插件条目导出的 Config
 * 投影到「条目 id」命名空间；`link:` 宿主半 import @deepseek-ai/schemastery 会
 * ERR_MODULE_NOT_FOUND，因此这里手写三个消费者需要的形状：
 *   - loader 的 resolveConfig → `Config[~standard].validate(raw)`；
 *   - settings 服务 → `meta.volatile` 与 `toJSON()`；
 *   - loader 的差异比较 → `~standard.vendor`（故意不写 schemastery，让写配置走
 *     普通路径重启条目，apply 才能拿到新值）。
 * refs 表按 schemastery 的 toJSON 形态手工维护（根节点标记 volatile）。
 */
const CONFIG_SCHEMA_JSON = Object.freeze({
  uid: 5,
  refs: {
    11: { type: 'string', meta: { default: 'name' } },
    12: { type: 'string', meta: { default: 'asc' } },
    13: { type: 'string', meta: { default: 'zh-CN' } },
    14: { type: 'boolean', meta: { default: true } },
    15: { type: 'boolean', meta: { default: false } },
    5: {
      type: 'object',
      meta: { default: {}, volatile: true },
      dict: { sortBy: 11, direction: 12, collation: 13, sortOnStartup: 14, includeInherited: 15 },
    },
  },
})

/**
 * 构造导出的 Config：接受任意输入并归一化，供 loader / settings / 测试共用。
 * @returns {Function} 带 meta / type / toJSON / '~standard' 的 schema 函数
 */
function entryConfigSchema() {
  const schema = (input) => normalizeConfig(input)
  schema.meta = { volatile: true }
  schema.type = 'object'
  schema.toJSON = () => JSON.parse(JSON.stringify(CONFIG_SCHEMA_JSON))
  schema['~standard'] = {
    version: 1,
    vendor: 'dsh-model-alpha-sort',
    validate(value) {
      try {
        return { value: normalizeConfig(value) }
      } catch (error) {
        return { issues: [{ message: errorMessage(error) }] }
      }
    },
  }
  return schema
}

/** 导出给 loader 的入口配置 schema。 */
export const Config = entryConfigSchema()

/**
 * 空统计对象，供错误分支复用。
 * @returns {{ providers: number, models: number, pending: number, moved: number }} 例 { providers: 0, models: 0, pending: 0, moved: 0 }
 */
function emptyTotals() {
  return { providers: 0, models: 0, pending: 0, moved: 0 }
}

/**
 * 检查单个 provider 的模型目录状态（只读，不写入）。
 * @param {object} entry listConfigurableProviders() 的一项，例 { provider: 'codemaker', settingsNs: 'llm-pi-ai', settingsPath: ['providers','codemaker'] }
 * @param {Map<string, object>} byNs 命名空间视图表，例 new Map([['llm-pi-ai', { user, value, revision }]])
 * @param {object} options 排序选项，例 { sortBy: 'name', direction: 'asc', collation: 'zh-CN', includeInherited: false }
 * @returns {object} 例 { provider: 'codemaker', state: 'user', count: 54, pending: true, moved: 41, list, revision: 7 }
 */
function inspectProvider(entry, byNs, options) {
  const provider = typeof entry.provider === 'string' ? entry.provider : String(entry.provider ?? '')
  const displayName = typeof entry.displayName === 'string' && entry.displayName.trim() !== ''
    ? entry.displayName.trim()
    : provider
  const settingsNs = typeof entry.settingsNs === 'string' ? entry.settingsNs : ''
  const settingsPath = Array.isArray(entry.settingsPath) ? entry.settingsPath.slice() : []
  const base = { provider, displayName, settingsNs, settingsPath, count: 0, pending: false, moved: 0, list: [], revision: undefined }

  if (settingsNs === '') {
    return { ...base, state: 'namespace-absent', reason: '提供方没有 settingsNs' }
  }
  const nsView = byNs.get(settingsNs)
  if (!nsView) {
    return { ...base, state: 'namespace-absent', reason: '设置文档里没有这个命名空间' }
  }

  const modelsPath = sortPathOf(settingsPath)
  const userList = getAtPath(nsView.user, modelsPath)
  if (Array.isArray(userList)) {
    const sorted = sortModels(userList, options)
    return {
      ...base,
      state: 'user',
      count: userList.length,
      pending: userList.length > 1 && !isSorted(userList, options),
      moved: movedCount(userList, sorted),
      list: userList,
      revision: nsView.revision,
    }
  }

  const resolvedList = getAtPath(nsView.value, modelsPath)
  if (!Array.isArray(resolvedList)) {
    return { ...base, state: 'absent', reason: '命名空间里没有模型数组', revision: nsView.revision }
  }
  const sorted = sortModels(resolvedList, options)
  const unsorted = resolvedList.length > 1 && !isSorted(resolvedList, options)
  if (options.includeInherited) {
    return {
      ...base,
      state: 'inherited-writable',
      count: resolvedList.length,
      pending: unsorted,
      moved: movedCount(resolvedList, sorted),
      list: resolvedList,
      revision: nsView.revision,
    }
  }
  return {
    ...base,
    state: 'inherited',
    count: resolvedList.length,
    pending: false,
    moved: movedCount(resolvedList, sorted),
    list: resolvedList,
    revision: nsView.revision,
  }
}

/**
 * 读取设置文档与 provider 清单，算出一份只读排序计划。
 * @param {object} ctx cordis 上下文，例 { get: (key) => … }
 * @param {object} [optionsInput] 覆盖选项（测试用），例 { includeInherited: true }
 * @returns {Promise<object>} 例 { ok: true, writable: true, options, providers: [...], totals: { providers: 1, models: 54, pending: 1, moved: 41 } }
 */
export async function collect(ctx, optionsInput) {
  const options = normalizeConfig(optionsInput === undefined ? STATE.options : optionsInput)
  const settingsController = serviceOf(ctx, 'settingsController')
  if (settingsController === undefined || typeof settingsController.describe !== 'function') {
    return { ok: false, code: 'settings-controller-absent', writable: false, options, providers: [], totals: emptyTotals() }
  }

  let described
  try {
    described = await settingsController.describe()
  } catch (error) {
    return { ok: false, code: 'settings-describe-failed', message: errorMessage(error), writable: false, options, providers: [], totals: emptyTotals() }
  }

  const namespaceList = isPlainObject(described) && Array.isArray(described.namespaces) ? described.namespaces : []
  const byNs = new Map()
  for (const view of namespaceList) {
    if (isPlainObject(view) && typeof view.ns === 'string') byNs.set(view.ns, view)
  }

  let configurable = []
  const llm = serviceOf(ctx, 'llm')
  if (llm !== undefined && typeof llm.listConfigurableProviders === 'function') {
    try {
      const list = await llm.listConfigurableProviders()
      if (Array.isArray(list)) configurable = list
    } catch (error) {
      return { ok: false, code: 'llm-providers-failed', message: errorMessage(error), writable: described.writable === true, options, providers: [], totals: emptyTotals() }
    }
  }

  const providers = configurable
    .filter((entry) => isPlainObject(entry))
    .map((entry) => inspectProvider(entry, byNs, options))

  const actionable = providers.filter((item) => item.state === 'user' || item.state === 'inherited-writable')
  const totals = {
    providers: actionable.length,
    models: actionable.reduce((sum, item) => sum + item.count, 0),
    pending: actionable.filter((item) => item.pending).length,
    moved: actionable.reduce((sum, item) => sum + (item.pending ? item.moved : 0), 0),
  }
  return {
    ok: true,
    code: null,
    writable: described.writable !== false,
    options,
    providers,
    totals,
  }
}

/**
 * 把内部计划裁剪成可经 HTTP 返回的公开状态（不暴露模型清单本身）。
 * @param {object} plan collect() 的返回值，例 { ok: true, providers: [...] }
 * @returns {object} 例 { ok: true, writable: true, totals: {...}, providers: [{ provider, state, count, pending, moved }] }
 */
export function statusPayload(plan) {
  const providers = Array.isArray(plan && plan.providers) ? plan.providers : []
  return {
    ok: plan ? plan.ok !== false : false,
    code: (plan && plan.code) || null,
    message: (plan && plan.message) || null,
    writable: Boolean(plan && plan.writable),
    options: plan ? plan.options : { ...STATE.options },
    totals: plan ? plan.totals : emptyTotals(),
    providers: providers.map((item) => ({
      provider: item.provider,
      displayName: item.displayName,
      settingsNs: item.settingsNs,
      state: item.state,
      count: item.count,
      pending: item.pending,
      moved: item.moved,
      revision: item.revision,
      reason: item.reason || null,
    })),
    startup: { ...STATE.startup },
    http: { ...STATE.http },
    lastRun: STATE.lastRun,
  }
}

/**
 * 把错误归类成稳定代码，优先读 RemoteError.details.code。
 * @param {unknown} error 写入抛出的值，例 { details: { code: 'settings/conflict' } }
 * @returns {string} 例 'settings/conflict'
 */
function classifyError(error) {
  if (isPlainObject(error) && isPlainObject(error.details) && typeof error.details.code === 'string') {
    return error.details.code
  }
  if (isPlainObject(error) && typeof error.code === 'string') return error.code
  const message = errorMessage(error)
  if (message.includes('settings/conflict')) return 'settings/conflict'
  if (message.includes('is not volatile')) return 'settings/path-not-volatile'
  if (message.includes('No configurable plugin entry')) return 'settings/entry-absent'
  return 'settings-write-failed'
}

/**
 * 执行一次排序：按命名空间分组写入，逐个报告成功 / 失败。
 * @param {object} ctx cordis 上下文，例 { get: (key) => … }
 * @param {object} [optionsInput] 覆盖选项（测试用），例 { direction: 'desc' }
 * @returns {Promise<object>} 例 { ok: true, changed: 1, skipped: null, writes: [{ ns: 'llm-pi-ai', ok: true, providers: ['codemaker'] }] }
 */
export async function sortNow(ctx, optionsInput) {
  const plan = await collect(ctx, optionsInput)
  if (!plan.ok) {
    return { ok: false, code: plan.code, message: plan.message || null, changed: 0, writes: [], totals: plan.totals, options: plan.options }
  }
  if (!plan.writable) {
    return { ok: true, changed: 0, skipped: 'read-only', writes: [], totals: plan.totals, options: plan.options }
  }

  const settingsController = serviceOf(ctx, 'settingsController')
  if (settingsController === undefined || typeof settingsController.mutate !== 'function') {
    return { ok: false, code: 'settings-controller-absent', changed: 0, writes: [], totals: plan.totals, options: plan.options }
  }

  const groups = new Map()
  for (const item of plan.providers) {
    if (!item.pending) continue
    if (item.state !== 'user' && item.state !== 'inherited-writable') continue
    const sorted = sortModels(item.list, plan.options)
    if (sorted.length === 0) continue
    if (!groups.has(item.settingsNs)) groups.set(item.settingsNs, { revision: item.revision, items: [] })
    groups.get(item.settingsNs).items.push({ provider: item.provider, settingsPath: item.settingsPath, value: sorted })
  }

  const writes = []
  let changed = 0
  for (const [ns, group] of groups) {
    const ops = group.items.map((item) => ({ op: 'set', path: sortPathOf(item.settingsPath), value: item.value }))
    try {
      await settingsController.mutate(ns, ops, group.revision)
      changed += group.items.length
      writes.push({ ns, ok: true, providers: group.items.map((item) => item.provider), ops: ops.length })
    } catch (error) {
      writes.push({
        ns,
        ok: false,
        providers: group.items.map((item) => item.provider),
        code: classifyError(error),
        message: errorMessage(error),
      })
    }
  }

  const result = { ok: true, changed, skipped: null, writes, totals: plan.totals, options: plan.options }
  STATE.lastRun = {
    at: Date.now(),
    trigger: 'sort',
    changed,
    writes: writes.map((item) => ({ ns: item.ns, ok: item.ok, code: item.code || null })),
  }
  return result
}

/**
 * 判断请求是否带本插件的身份头。
 * @param {object} req node 请求对象，例 { headers: { 'x-dsh-plugin': 'dsh-model-alpha-sort' } }
 * @returns {boolean} 例 true
 */
function hasPluginHeader(req) {
  const headers = req && req.headers
  if (!headers || typeof headers !== 'object') return false
  return headers[PLUGIN_HEADER] === PLUGIN_HEADER_VALUE
}

/**
 * 同源校验：没有 Origin（同源 fetch / curl）放行，有 Origin 时 host 必须等于 Host 头。
 * @param {object} req node 请求对象，例 { headers: { origin: 'http://127.0.0.1:1030', host: '127.0.0.1:1030' } }
 * @returns {boolean} 例 true
 */
function isSameOrigin(req) {
  const headers = req && req.headers
  if (!headers || typeof headers !== 'object') return false
  const origin = headers.origin
  if (origin === undefined || origin === null || origin === '') return true
  const host = headers.host
  if (typeof host !== 'string' || host === '') return false
  try {
    const parsed = new URL(String(origin))
    return parsed.host === host
  } catch {
    return false
  }
}

/**
 * 发送 JSON 响应（同时设置 no-store，避免卡片读到缓存的旧状态）。
 * @param {object} res node 响应对象，例 { statusCode: 200, setHeader(){}, end(){} }
 * @param {number} status HTTP 状态码，例 200
 * @param {object} body 响应体，例 { ok: true }
 * @returns {void}
 */
function sendJson(res, status, body) {
  let text
  try {
    text = JSON.stringify(body)
  } catch {
    text = '{"ok":false,"error":"serialize-failed"}'
  }
  if (res && typeof res.setHeader === 'function') {
    res.setHeader('content-type', 'application/json; charset=utf-8')
    res.setHeader('cache-control', 'no-store')
  }
  if (res) res.statusCode = status
  if (res && typeof res.end === 'function') res.end(text)
}

/**
 * 创建 HTTP 处理器：GET /status 只读状态，POST /sort 执行一次排序。
 * 两个端点都要求 `x-dsh-plugin: dsh-model-alpha-sort` 与同源。
 * @param {object} ctx cordis 上下文，例 { get: (key) => … }
 * @returns {(req: object, res: object) => Promise<void>} 例 handler(req, res)
 */
export function createHttpHandler(ctx) {
  return async function handle(req, res) {
    try {
      const method = String((req && req.method) || 'GET').toUpperCase()
      const rawUrl = String((req && req.url) || '/')
      const pathname = rawUrl.split('?')[0]
      const statusPath = `${HTTP_PREFIX}/status`
      const sortPath = `${HTTP_PREFIX}/sort`

      if (pathname !== statusPath && pathname !== sortPath) {
        sendJson(res, 404, { ok: false, error: 'unknown-endpoint', endpoint: pathname })
        return
      }
      if (!hasPluginHeader(req)) {
        sendJson(res, 403, { ok: false, error: 'forbidden-plugin-header' })
        return
      }
      if (!isSameOrigin(req)) {
        sendJson(res, 403, { ok: false, error: 'forbidden-origin' })
        return
      }
      if ((pathname === statusPath && method !== 'GET') || (pathname === sortPath && method !== 'POST')) {
        sendJson(res, 405, { ok: false, error: 'method-not-allowed', method })
        return
      }

      if (pathname === statusPath) {
        const plan = await collect(ctx)
        sendJson(res, 200, statusPayload(plan))
        return
      }

      const result = await sortNow(ctx)
      const plan = await collect(ctx)
      sendJson(res, 200, { ...result, status: statusPayload(plan) })
    } catch (error) {
      sendJson(res, 500, { ok: false, error: 'internal-error', message: errorMessage(error) })
    }
  }
}

/**
 * 在 webServer 上注册 HTTP 前缀路由；没有 webServer 时只记录原因。
 * @param {object} ctx cordis 上下文，例 { effect: (fn) => fn() }
 * @param {object} host webServer 服务，例 { register: ({ kind, path, handler }) => dispose }
 * @returns {void}
 */
export function registerHttp(ctx, host) {
  if (!host || typeof host.register !== 'function') {
    STATE.http = { mounted: false, reason: 'webServer-absent' }
    return
  }
  try {
    const handler = createHttpHandler(ctx)
    if (typeof ctx.effect === 'function') {
      ctx.effect(() => host.register({ kind: 'prefix', path: HTTP_PREFIX, handler }))
    } else {
      host.register({ kind: 'prefix', path: HTTP_PREFIX, handler })
    }
    STATE.http = { mounted: true, reason: null }
  } catch (error) {
    STATE.http = { mounted: false, reason: 'webServer-register-failed', message: errorMessage(error) }
  }
}

/**
 * 执行一次启动排序尝试；已成功或正在跑时直接返回。
 * @param {object} ctx cordis 上下文，例 { get: (key) => … }
 * @returns {Promise<void>}
 */
async function attemptStartup(ctx) {
  if (STATE.startup.ok || STATE.startup.running) return
  STATE.startup.running = true
  STATE.startup.attempts += 1
  try {
    const result = await sortNow(ctx)
    if (result.ok) {
      STATE.startup.ok = true
      STATE.startup.lastError = null
      STATE.startup.lastResult = { changed: result.changed, skipped: result.skipped || null }
      STATE.lastRun = { at: Date.now(), trigger: 'startup', changed: result.changed, skipped: result.skipped || null }
    } else {
      STATE.startup.lastError = result.code || 'startup-failed'
    }
  } catch (error) {
    STATE.startup.lastError = errorMessage(error)
  } finally {
    STATE.startup.running = false
  }
}

/**
 * 排启动排序定时器（默认 1.5s / 5s / 12s）；只成功一次，之后不再重试。
 * @param {object} ctx cordis 上下文，例 { get: (key) => … }
 * @param {number[]} [delays] 延迟数组（测试用），例 [1, 2, 3]
 * @returns {void}
 */
export function scheduleStartup(ctx, delays = STARTUP_DELAYS) {
  if (!STATE.options.sortOnStartup) return
  if (STATE.startup.ok || STATE.startup.running || STATE.startup.pending > 0) return
  const list = Array.isArray(delays) && delays.length > 0 ? delays : STARTUP_DELAYS
  STATE.startup.pending = list.length
  for (const delay of list) {
    const timer = setTimeout(() => {
      STATE.startup.pending = Math.max(0, STATE.startup.pending - 1)
      void attemptStartup(ctx)
    }, delay)
    if (timer && typeof timer.unref === 'function') timer.unref()
    STATE.timers.push(timer)
  }
}

/**
 * 重置运行状态（apply 与测试共用）。
 * @param {object} config 归一化后的配置，例 { sortOnStartup: false }
 * @returns {void}
 */
function resetRuntime(config) {
  for (const timer of STATE.timers) clearTimeout(timer)
  STATE.timers = []
  STATE.options = normalizeConfig(config)
  STATE.startup = { ok: false, pending: 0, running: false, attempts: 0, lastError: null, lastResult: null }
  STATE.lastRun = null
}

/**
 * 测试用：清空模块级状态并返回当前状态快照。
 * @returns {object} 例 { options, startup, http, lastRun }
 */
export function __resetForTests() {
  resetRuntime(null)
  STATE.ctx = null
  STATE.http = { mounted: false, reason: null }
  return { options: STATE.options, startup: STATE.startup, http: STATE.http, lastRun: STATE.lastRun }
}

/**
 * 插件入口：记录配置、挂 HTTP、排启动排序；服务晚挂时用 ctx.inject 兜底。
 * @param {object} ctx cordis 上下文，例 { get: (key) => …, inject: (keys, cb) => … }
 * @param {object} [config] profile 行解析后的入口配置，例 { sortOnStartup: true }
 * @returns {void}
 */
export function apply(ctx, config) {
  STATE.ctx = ctx
  STATE.http = { mounted: false, reason: null }
  resetRuntime(config)

  const webServer = serviceOf(ctx, 'webServer')
  if (webServer !== undefined) {
    registerHttp(ctx, webServer)
  } else {
    // 先如实标记为未挂载；ctx.inject 稍后拿到服务时再改为 mounted。
    STATE.http = { mounted: false, reason: 'webServer-absent' }
    try {
      if (typeof ctx.inject === 'function') {
        ctx.inject(['webServer'], (sub) => {
          const resolved = sub && sub.webServer ? sub.webServer : sub
          registerHttp(ctx, resolved)
        })
      }
    } catch {
      STATE.http = { mounted: false, reason: 'webServer-inject-failed' }
    }
  }

  scheduleStartup(ctx)

  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['settingsController', 'llm'], () => {
        if (!STATE.startup.ok) scheduleStartup(ctx)
      })
    }
  } catch {
    // 服务晚挂兜底失败不影响启动定时器（它自己会重试三次）。
  }

  if (typeof ctx.effect === 'function') {
    ctx.effect(() => () => {
      for (const timer of STATE.timers) clearTimeout(timer)
      STATE.timers = []
      STATE.startup.pending = 0
    })
  }
}

/** 测试入口：立即执行一次启动排序尝试（与定时器回调同一实现）。 */
export const runStartupOnce = attemptStartup
