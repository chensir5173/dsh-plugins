/**
 * dsh-mcp-manager — 宿主半（cordis 插件）
 *
 * 职责（tasks.md §2.1–2.6）：
 *   1. 锚定 DSH home 与当前 profile：profileContext → ctx.settings.prepareDocument() → $DSH_PROFILE_DIR
 *      （最后补一个 ctx.baseUrl 兜底；绝不硬编码 `profiles/web`）；
 *   2. 把「一台 MCP 服务器」的定义按生效矩阵落到正确的补丁层 —— **落层判定全在 ./host-core.js**，
 *      本文件只做 `target` → 真实路径映射与写盘；
 *   3. 行级块拼贴 + 原子写（同目录临时文件 + rename）+ 写前备份 `<file>.bak-<yyyyMMdd-HHmmss>`（保留最近 10 份）
 *      + 同文件写串行化 + **每次操作先重读文件**；
 *   4. 暴露 `POST /__dsh-mcp-manager/api`（11 个端点；`x-dsh-plugin` 头 + 同源门 + body ≤ 1 MiB）；
 *   5. 在 `@deepseek-ai/dsh-tools` 可解析时注册 4 个模型工具（缺包即跳过并写诊断）；
 *   6. 任何失败就地捕获并写 `$DSH_HOME/.dsh-mcp-manager/host-diag.json` —— **apply() 永不抛**。
 *
 * 不变量：
 *   - 绝不冒泡：路由注册、工具注册、state 读写、诊断写入的异常全部吞掉并记录诊断。
 *     （cordis 会因 apply() 抛错回滚本插件的全部 effect —— 面板会「路由消失但客户端半还在」。）
 *   - 只读降级：任何目标文件不是合法 YAML → 写端点返回 `ok:false` / `patch-unparsable`，文件与备份都不动。
 *   - 不碰别人的行：只重写目标 id 的行块；激活行、中文注释、`!!js`、行序、EOL 逐字保留（host-core 负责）。
 *   - 不读写 `$DSH_HOME/dsh-mcp.json`（spec: 与既有条目互不干扰）。
 *
 * 端点请求/响应形状（与 t3 客户端对齐，见 README「宿主端点」）：
 *   请求：POST /__dsh-mcp-manager/api
 *         headers: { 'content-type': 'application/json', 'x-dsh-plugin': 'dsh-mcp-manager' }
 *         body:    { action: '<端点名>', payload?: { ... } }   // 亦接受 `endpoint` / `op` 别名与扁平写法
 *   响应：{ ok: true, data: {...} } | { ok: false, error: { code, message, fields } }
 *   HTTP：403 缺头/跨源、413 超 1 MiB、405 非 POST、400 JSON 坏；业务错误一律 200 + ok:false。
 */

import fs from 'node:fs'
import fsp from 'node:fs/promises'
import { createRequire } from 'node:module'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

// ══════════════════════════════════ 常量 ══════════════════════════════════

const PLUGIN_ID = 'dsh-mcp-manager'
const PLUGIN_VERSION = '0.1.0'
const API_PATH = '/__dsh-mcp-manager/api'
const HEADER_NAME = 'x-dsh-plugin'
const MAX_BODY_BYTES = 1024 * 1024
const STATE_DIR_NAME = '.dsh-mcp-manager'
const DIAG_FILE_NAME = 'host-diag.json'
const BACKUP_KEEP = 10
const TOOLS_PACKAGE = '@deepseek-ai/dsh-tools'
const MCP_CLIENT_PACKAGE = '@deepseek-ai/dsh-mcp-client'
const STATE_VERSION = 2

/** host-core 缺失或未导出 `defaultState()` 时的兜底默认值（权威值在 host-core）。 */
const FALLBACK_DEFAULTS = Object.freeze({
  toolCallTimeoutMs: 60000,
  failOnStartupError: false,
  maxInstructionBytes: 32768,
  probeTimeoutMs: 8000,
  defaultTransport: 'stdio',
})

const ENDPOINT_NAMES = Object.freeze([
  'list', 'add', 'update', 'remove', 'setEnabled', 'setMatrix',
  'getDefaults', 'setDefaults', 'probe', 'migrate', 'patchInfo', 'tools',
])

/**
 * 静态工具清单的口径说明（与 list 的「工具数估计」列同源）：
 * 公开工具名由核心按 `mcp__<serverName>__<tool>` 生成，超长会被归一化，因此只是估计值。
 */
const TOOLS_STATIC_NOTE = '静态清单按 `mcp__<serverName>__` 前缀统计，工具名超长会被归一化，属估计值'

// ═══════════════════════ host-core（惰性、可缺、绝不冒泡） ═══════════════════════

/**
 * 功能作用：以命名空间方式加载同目录纯逻辑模块 `./host-core.js`。
 *          用「动态 import + try/catch」而不是静态 import：静态 import 的链接失败会让整个插件模块
 *          无法求值（apply 根本不会跑），而缺函数/坏文件时本文件仍要能加载并降级到诊断。
 * 参数：无。
 * 返回值：{ module: object|null, error: string|null }。
 * 调用样例：const { module, error } = await loadHostCore()
 */
let core = null
let coreImportError = null
try {
  core = await import('./host-core.js')
} catch (err) {
  coreImportError = errText(err)
}

/** 取 host-core 的某个函数；缺失时返回 null（调用方决定降级或报错）。 */
function coreFn(name) {
  const fn = core ? core[name] : null
  return typeof fn === 'function' ? fn : null
}

// ══════════════════════════════════ 诊断 ══════════════════════════════════

/** 进程内诊断快照；apply 末尾与每次写失败时落到 $DSH_HOME/.dsh-mcp-manager/host-diag.json。 */
const HOST_DIAG = {
  plugin: PLUGIN_ID,
  pid: process.pid,
  diagFile: null,
  home: null,
  profile: null,
  profileDir: null,
  profilePatchPath: null,
  anchorSource: null,
  anchorErrors: [],
  coreImportError: null,
  httpRegistered: false,
  httpSkipped: null,
  httpError: null,
  toolsRegistered: [],
  toolsSkipped: null,
  toolsError: null,
  settingsError: null,
  stateError: null,
  lastError: null,
  mergeSanitizedRows: 0,
  mergeFallback: null,
  runtimeProbe: null,
  toolsLookup: null,
  applyError: null,
  updatedAt: null,
}

function freshDiag() {
  HOST_DIAG.diagFile = null
  HOST_DIAG.home = null
  HOST_DIAG.profile = null
  HOST_DIAG.profileDir = null
  HOST_DIAG.profilePatchPath = null
  HOST_DIAG.anchorSource = null
  HOST_DIAG.anchorErrors = []
  HOST_DIAG.coreImportError = coreImportError
  HOST_DIAG.httpRegistered = false
  HOST_DIAG.httpSkipped = null
  HOST_DIAG.httpError = null
  HOST_DIAG.toolsRegistered = []
  HOST_DIAG.toolsSkipped = null
  HOST_DIAG.toolsError = null
  HOST_DIAG.settingsError = null
  HOST_DIAG.stateError = null
  HOST_DIAG.lastError = null
  HOST_DIAG.mergeSanitizedRows = 0
  HOST_DIAG.mergeFallback = null
  HOST_DIAG.runtimeProbe = null
  HOST_DIAG.toolsLookup = null
  HOST_DIAG.applyError = null
}

/**
 * 功能作用：把诊断快照写到 `$DSH_HOME/.dsh-mcp-manager/host-diag.json`（best-effort，永不抛）。
 *          面板拿不到路由时（404 空体）唯一的可诊断落点；home 未知时不写、只留在内存。
 * 参数：home（string|null）。
 * 返回值：写成功返回文件路径，否则 null。
 */
function writeDiag(home) {
  try {
    const dir = home ? path.join(home, STATE_DIR_NAME) : null
    if (!dir) return null
    fs.mkdirSync(dir, { recursive: true })
    const file = path.join(dir, DIAG_FILE_NAME)
    HOST_DIAG.diagFile = file
    HOST_DIAG.updatedAt = new Date().toISOString()
    fs.writeFileSync(file, `${JSON.stringify(HOST_DIAG, null, 2)}\n`)
    return file
  } catch (err) {
    HOST_DIAG.lastError = errText(err)
    return null
  }
}

// ══════════════════════════ 测试缝（仅供 node:test） ══════════════════════════

const SEAMS = { importModule: null, probeRunner: null }

/** 测试用：替换模块加载器（缺包降级路径 / 工具注册成功路径都要能确定性驱动）。 */
export function __setImportOverride(fn) {
  SEAMS.importModule = typeof fn === 'function' ? fn : null
}

/** 测试用：替换 MCP 探测执行器（离线测试绝不起真实子进程）。 */
export function __setProbeRunner(fn) {
  SEAMS.probeRunner = typeof fn === 'function' ? fn : null
}

/** 测试用：清空所有缝并复位进程内诊断。 */
export function __resetTestSeams() {
  SEAMS.importModule = null
  SEAMS.probeRunner = null
  freshDiag()
}

/** 测试用：读进程内诊断快照（诊断文件是 best-effort 的，断言用内存快照更稳）。 */
export function __diag() {
  return { ...HOST_DIAG }
}

/**
 * 功能作用：加载一个模块（默认走真实 import；测试缝可覆盖）。
 * 参数：spec 模块名。
 * 返回值：模块命名空间。
 */
async function loadModule(spec) {
  if (SEAMS.importModule) return SEAMS.importModule(spec)
  return import(spec)
}

// ══════════════════════════════════ 小工具 ══════════════════════════════════

function errText(err) {
  if (err === null || err === undefined) return 'unknown error'
  if (typeof err === 'string') return err
  return (err && err.message) || String(err)
}

/** host-core 的 `error` 是 `{ code, message, line? }` 对象（不是字符串）。 */
function errMessage(err) {
  if (!err) return '未知错误'
  if (typeof err === 'string') return err
  const code = err.code ? `${err.code}: ` : ''
  return `${code}${err.message || errText(err)}`
}

/** 服务/传输层错误：`code` 直接进 `{ ok:false, error:{ code, message, fields } }`。 */
class ServiceError extends Error {
  constructor(code, message, fields) {
    super(message)
    this.name = 'ServiceError'
    this.code = code
    this.fields = fields || null
  }
}

function fail(code, message, fields) {
  const error = { code, message, fields: fields === undefined ? null : fields }
  // 便利镜像：探测类失败把耗时也放在 error.latencyMs（面板在错误态要能显示耗时）。
  if (fields && typeof fields === 'object' && typeof fields.latencyMs === 'number') error.latencyMs = fields.latencyMs
  return { ok: false, error }
}

/** 读 ctx 上的服务：`ctx.get()` 在服务缺失时返回 null（不是 undefined），两种都要当「没有」。 */
function safeGet(ctx, name) {
  try {
    if (!ctx || typeof ctx.get !== 'function') return null
    return ctx.get(name) ?? null
  } catch (err) {
    HOST_DIAG.lastError = `${name}: ${errText(err)}`
    return null
  }
}

function firstString(...values) {
  for (const v of values) {
    if (typeof v === 'string' && v.trim() !== '') return v
  }
  return null
}

/** 本地时间戳 `yyyyMMdd-HHmmss`（备份文件名用；字典序 = 时间序）。 */
function stamp(date = new Date()) {
  const p = (n) => String(n).padStart(2, '0')
  return `${date.getFullYear()}${p(date.getMonth() + 1)}${p(date.getDate())}-${p(date.getHours())}${p(date.getMinutes())}${p(date.getSeconds())}`
}

function isInside(parent, child) {
  const rel = path.relative(path.resolve(parent), path.resolve(child))
  return rel !== '' && !rel.startsWith('..') && !path.isAbsolute(rel)
}

function looksLikeHome(dir) {
  if (typeof dir !== 'string' || dir === '') return false
  try {
    return fs.existsSync(path.join(dir, 'profiles')) || fs.existsSync(path.join(dir, 'cordis.patch.yml'))
  } catch {
    return false
  }
}

/** 从 `<home>/profiles/<name>[/...]` 取首段 profile 名（热挂载给的是 `<profile>/.dsh-market/`）。 */
function profileNameOf(home, dir) {
  if (!home || !dir) return null
  const rel = path.relative(path.join(home, 'profiles'), path.resolve(dir))
  if (!rel || rel.startsWith('..') || path.isAbsolute(rel)) return null
  const seg = rel.split(/[\\/]/).filter(Boolean)[0]
  return seg || null
}

/** 从 profile 目录反推 home：`<home>/profiles/<name>` → `<home>`。 */
function homeFromProfileDir(dir) {
  if (typeof dir !== 'string' || dir === '') return null
  const parent = path.dirname(path.resolve(dir))
  if (path.basename(parent) !== 'profiles') return null
  const home = path.dirname(parent)
  return looksLikeHome(home) ? home : null
}

// ══════════════════════════════ 锚定（§2.2） ══════════════════════════════

/**
 * 功能作用：解析 DSH home / 当前 profile / home patch 路径。
 *          优先级：ctx.profileContext → ctx.settings.prepareDocument() 推 home → $DSH_PROFILE_DIR
 *          （仅当属于同一 home）→ ctx.baseUrl（同规则兜底）。禁止硬编码 `profiles/web`。
 * 参数：ctx（cordis 上下文，可缺 get/inject）。
 * 返回值：{ home, profile, profileDir, homePatch, source, errors }（home 可能是 null）。
 * 调用样例：const anchor = await resolveAnchor(ctx)
 */
async function resolveAnchor(ctx) {
  const out = { home: null, profile: null, profileDir: null, homePatch: null, source: null, errors: [] }

  // ── 1) profileContext（最权威）
  const pc = safeGet(ctx, 'profileContext')
  if (pc && typeof pc === 'object') {
    const pcHome = firstString(pc.home, pc.homeDir, pc.dshHome, pc.homePath)
    const pcDir = firstString(pc.profileDir, pc.profileDirectory, pc.profilePath, pc.dir)
    const pcPatch = firstString(pc.patchPath, pc.patch, pc.profilePatchPath, pc.patchFile)
    if (pcHome && looksLikeHome(pcHome)) {
      out.home = path.resolve(pcHome)
      out.source = 'profileContext'
    }
    const dir = pcDir || (pcPatch ? path.dirname(pcPatch) : null)
    if (dir) {
      out.profileDir = path.resolve(dir)
      if (!out.home) {
        const derived = homeFromProfileDir(out.profileDir)
        if (derived) {
          out.home = derived
          out.source = 'profileContext'
        }
      }
    }
    if (out.home && out.profileDir && isInside(path.join(out.home, 'profiles'), out.profileDir)) {
      out.profile = profileNameOf(out.home, out.profileDir)
    }
  }

  // ── 2) settings.prepareDocument() 推 home（文档路径一般在 home 根下）
  if (!out.home) {
    const settings = safeGet(ctx, 'settings')
    if (settings && typeof settings.prepareDocument === 'function') {
      try {
        const doc = await Promise.resolve(settings.prepareDocument())
        const file = firstString(
          typeof doc === 'string' ? doc : null,
          doc && doc.path, doc && doc.filePath, doc && doc.filename, doc && doc.file, doc && doc.target,
        )
        if (file) {
          const dir = path.dirname(path.resolve(file))
          if (looksLikeHome(dir)) {
            out.home = dir
            out.source = 'settings.prepareDocument'
          } else if (looksLikeHome(path.dirname(dir))) {
            out.home = path.dirname(dir)
            out.source = 'settings.prepareDocument'
          }
        }
      } catch (err) {
        out.errors.push(`settings.prepareDocument: ${errText(err)}`)
      }
    } else if (!settings) {
      out.errors.push('settings service is not available')
    }
  }

  // ── 3) $DSH_PROFILE_DIR（仅当属于同一 home）
  const envDir = firstString(process.env.DSH_PROFILE_DIR, process.env.DSH_PROFILE_PATH)
  if (envDir) {
    const dir = path.resolve(envDir)
    if (!out.home) {
      const derived = homeFromProfileDir(dir)
      if (derived) {
        out.home = derived
        out.profileDir = dir
        out.profile = profileNameOf(derived, dir)
        out.source = out.source || 'DSH_PROFILE_DIR'
      } else {
        out.errors.push('DSH_PROFILE_DIR is not under any <home>/profiles')
      }
    } else if (!out.profileDir && isInside(path.join(out.home, 'profiles'), dir)) {
      out.profileDir = dir
      out.profile = profileNameOf(out.home, dir)
    }
  }

  // ── 4) ctx.baseUrl 兜底（同规则；热挂载会给出 <profile>/.dsh-market/，取首段）
  if (!out.home && ctx && typeof ctx.baseUrl === 'string' && ctx.baseUrl !== '') {
    try {
      const raw = ctx.baseUrl.startsWith('file:') ? fileURLToPath(ctx.baseUrl) : ctx.baseUrl
      const dir = path.resolve(raw)
      const derived = homeFromProfileDir(dir) || (looksLikeHome(dir) ? dir : null)
      if (derived) {
        out.home = derived
        out.source = 'baseUrl'
        if (isInside(path.join(derived, 'profiles'), dir)) {
          out.profileDir = dir
          out.profile = profileNameOf(derived, dir)
        }
      }
    } catch (err) {
      out.errors.push(`baseUrl: ${errText(err)}`)
    }
  }

  if (out.home) {
    out.homePatch = path.join(out.home, 'cordis.patch.yml')
    if (!out.profileDir && out.profile) out.profileDir = path.join(out.home, 'profiles', out.profile)
    if (out.profileDir && !out.profile) out.profile = profileNameOf(out.home, out.profileDir)
  }
  return out
}

// ═══════════════════════════ state.json（§2.3） ═══════════════════════════

function defaultsOf() {
  const fn = coreFn('defaultState')
  if (!fn) return { ...FALLBACK_DEFAULTS }
  try {
    const st = fn()
    const defaults = st && typeof st === 'object' && st.defaults && typeof st.defaults === 'object' ? st.defaults : st
    return { ...FALLBACK_DEFAULTS, ...(defaults && typeof defaults === 'object' ? defaults : {}) }
  } catch (err) {
    HOST_DIAG.lastError = `defaultState: ${errText(err)}`
    return { ...FALLBACK_DEFAULTS }
  }
}

function statePathOf(home) {
  const fn = coreFn('statePath')
  if (fn) {
    try {
      const p = fn(home)
      if (typeof p === 'string' && p !== '') return p
    } catch (err) {
      HOST_DIAG.stateError = `statePath: ${errText(err)}`
    }
  }
  return path.join(home, STATE_DIR_NAME, 'state.json')
}

/**
 * 功能作用：读 state.json；缺失或损坏都回退内置默认值且**不报错**（A3.3）。
 * 参数：home。
 * 返回值：{ file, state, ok, error }。
 */
async function readState(home) {
  const file = statePathOf(home)
  const base = { version: STATE_VERSION, defaults: defaultsOf() }
  try {
    const text = await fsp.readFile(file, 'utf8')
    const parsed = JSON.parse(text)
    const defaults = parsed && typeof parsed === 'object' && parsed.defaults && typeof parsed.defaults === 'object' ? parsed.defaults : {}
    return { file, state: { ...base, ...parsed, defaults: { ...base.defaults, ...defaults } }, ok: true, error: null }
  } catch (err) {
    if (err && err.code === 'ENOENT') return { file, state: base, ok: true, error: null }
    HOST_DIAG.stateError = `state.json 不可用，已回退默认值：${errText(err)}`
    return { file, state: base, ok: false, error: HOST_DIAG.stateError }
  }
}

/** 写 state.json（原子写 + 备份；调用方保证已串行化）。 */
async function writeState(home, state) {
  const file = statePathOf(home)
  await fsp.mkdir(path.dirname(file), { recursive: true })
  const payload = `${JSON.stringify({ ...state, version: state.version || STATE_VERSION, updatedAt: new Date().toISOString() }, null, 2)}\n`
  const backup = await backupOnce(file)
  const tmp = tmpNameFor(file)
  try {
    await fsp.writeFile(tmp, payload, 'utf8')
    await fsp.rename(tmp, file)
  } catch (err) {
    try { await fsp.unlink(tmp) } catch { /* best effort */ }
    throw new ServiceError('write-failed', `写 state.json 失败：${errText(err)}`)
  }
  return { file, backup }
}

// ═══════════════════════ 写盘：串行化 / 原子 / 备份 ═══════════════════════

/** 每文件的写链（同一文件的写操作串行化，A5.3）。 */
const writeChains = new Map()
/** 全局操作链：让「重读 → 规划 → 写」整体串行，避免两个操作基于同一份旧文本各自规划。 */
let opChain = Promise.resolve()

function withOpLock(task) {
  const run = opChain.then(task, task)
  opChain = run.then(() => {}, () => {})
  return run
}

function withFileLock(file, task) {
  const key = path.resolve(file)
  const prev = writeChains.get(key) || Promise.resolve()
  const run = prev.then(task, task)
  const settled = run.then(() => {}, () => {})
  writeChains.set(key, settled)
  settled.then(() => {
    if (writeChains.get(key) === settled) writeChains.delete(key)
  })
  return run
}

function tmpNameFor(file) {
  const rand = Math.random().toString(36).slice(2, 8)
  return path.join(path.dirname(file), `.${path.basename(file)}.tmp-${process.pid.toString(36)}-${Date.now().toString(36)}-${rand}`)
}

function backupCountOf(file) {
  try {
    const base = `${path.basename(file)}.bak-`
    return fs.readdirSync(path.dirname(file)).filter((n) => n.startsWith(base)).length
  } catch {
    return 0
  }
}

/**
 * 功能作用：写前备份 `<file>.bak-<yyyyMMdd-HHmmss>`，同目录只保留最近 10 份（A5.2）。
 * 参数：file；keep 保留份数。
 * 返回值：备份文件路径（源文件不存在时 null）。
 */
async function backupOnce(file, keep = BACKUP_KEEP) {
  if (!fs.existsSync(file)) return null
  const dst = `${file}.bak-${stamp()}`
  await fsp.copyFile(file, dst)
  try {
    const base = `${path.basename(file)}.bak-`
    const names = (await fsp.readdir(path.dirname(file))).filter((n) => n.startsWith(base)).sort()
    for (const n of names.slice(0, Math.max(0, names.length - keep))) {
      try { await fsp.unlink(path.join(path.dirname(file), n)) } catch { /* best effort */ }
    }
  } catch { /* 清理失败不影响本次写入 */ }
  return dst
}

/**
 * 功能作用：原子写一个补丁文件（同目录临时文件 + rename），写前备份。
 * 参数：file、text（原样写盘 —— EOL 由 host-core 的 plan* 负责沿用）。
 * 返回值：{ path, backup }。
 */
async function writePatchFile(file, text) {
  return withFileLock(file, async () => {
    const backup = await backupOnce(file)
    const tmp = tmpNameFor(file)
    try {
      await fsp.writeFile(tmp, text, 'utf8')
      await fsp.rename(tmp, file)
    } catch (err) {
      try { await fsp.unlink(tmp) } catch { /* best effort */ }
      throw new ServiceError('write-failed', `写 ${file} 失败：${errText(err)}`)
    }
    return { path: file, backup }
  })
}

/**
 * 功能作用：读补丁文件（缺失视为空文本；其它错误如实报告）。
 * 返回值：{ exists, text, error }。
 */
async function readPatchSafe(file) {
  try {
    const text = await fsp.readFile(file, 'utf8')
    return { exists: true, text, error: null }
  } catch (err) {
    const exists = fs.existsSync(file)
    if (err && err.code === 'ENOENT') return { exists: false, text: '', error: null }
    return { exists, text: '', error: errText(err) }
  }
}

// ═══════════════════════════ 源文件集合与解析 ═══════════════════════════

/** 磁盘 profile 名（A2.2：只认目录，排除 node_modules）。 */
async function listProfileNames(anchor) {
  const dirNames = []
  try {
    const entries = await fsp.readdir(path.join(anchor.home, 'profiles'), { withFileTypes: true })
    for (const e of entries) if (e.isDirectory()) dirNames.push(e.name)
  } catch (err) {
    HOST_DIAG.lastError = `profiles: ${errText(err)}`
  }
  let names = dirNames
  const fn = coreFn('listProfiles')
  if (fn) {
    try {
      const res = fn(dirNames)
      if (Array.isArray(res)) names = res
    } catch (err) {
      HOST_DIAG.lastError = `listProfiles: ${errText(err)}`
    }
  }
  const filtered = names.filter((n) => typeof n === 'string' && n !== '' && n !== 'node_modules')
  return [...new Set(filtered)].sort()
}

/**
 * 功能作用：重读 home patch 与全部 profile patch（**每次操作都重读**，§2.3）。
 * 返回值：{ home: {target,name,path,text,exists,error}, profiles: [...] }。
 */
async function readAllSources(anchor) {
  const homeRead = await readPatchSafe(anchor.homePatch)
  const home = { target: 'home', name: null, path: anchor.homePatch, ...homeRead }
  const profiles = []
  for (const name of await listProfileNames(anchor)) {
    const file = profilePatchPathOf(anchor.home, name)
    const read = await readPatchSafe(file)
    profiles.push({ target: name, name, path: file, ...read })
  }
  return { home, profiles }
}

function profilePatchPathOf(home, name) {
  const fn = coreFn('profilePatchPath')
  if (fn) {
    try {
      const p = fn(home, name)
      if (typeof p === 'string' && p !== '') return p
    } catch (err) {
      HOST_DIAG.lastError = `profilePatchPath: ${errText(err)}`
    }
  }
  return path.join(home, 'profiles', name, 'cordis.patch.yml')
}

function parseOf(text) {
  const fn = coreFn('parsePatch')
  if (!fn) return null
  try {
    return fn(text)
  } catch (err) {
    return { ok: false, error: errText(err), entries: [] }
  }
}

function detectEolOf(text) {
  const fn = coreFn('detectEol')
  if (!fn) return null
  try {
    return fn(text)
  } catch {
    return null
  }
}

function fileInfo(src) {
  const parsed = parseOf(src.text)
  const entries = parsed && Array.isArray(parsed.entries) ? parsed.entries : []
  const overrides = parsed && Array.isArray(parsed.overrides) ? parsed.overrides : []
  return {
    target: src.target,
    path: src.path,
    exists: src.exists,
    ok: parsed ? parsed.ok !== false : false,
    errorCode: parsed && parsed.error ? parsed.error.code || null : null,
    error: parsed && parsed.error
      ? errMessage(parsed.error)
      : (src.error || (core ? null : `host-core 不可用：${coreImportError}`)),
    eol: detectEolOf(src.text),
    backups: backupCountOf(src.path),
    bytes: src.text.length,
    entries: entries.map((e) => ({
      id: e.id, serverName: e.serverName, transport: e.transport,
      hasMarker: e.hasMarker, markerKind: e.markerKind, disabled: e.disabled,
    })),
    overrideIds: overrides.map((o) => o.id),
  }
}

/**
 * 功能作用：写前守卫 —— 任何**已存在**的目标文件不是合法 YAML 就拒绝（§2.3 / A5.4）。
 *          在规划与备份之前抛出，因此不会产生备份残留。
 * 参数：sources（readAllSources 的返回值）。
 * 返回值：无（不合法时抛 ServiceError('patch-unparsable')）。
 */
function assertParsable(sources) {
  if (!core) throw new ServiceError('core-unavailable', `host-core.js 不可用：${coreImportError}`)
  const all = [sources.home, ...sources.profiles]
  const bad = []
  for (const src of all) {
    if (!src.exists || src.error) {
      if (src.error) bad.push({ path: src.path, error: src.error })
      continue
    }
    const parsed = parseOf(src.text)
    if (!parsed || parsed.ok === false) {
      bad.push({
        path: src.path,
        code: parsed && parsed.error ? parsed.error.code || null : null,
        error: parsed && parsed.error ? errMessage(parsed.error) : '解析失败',
      })
    }
  }
  if (bad.length > 0) {
    throw new ServiceError('patch-unparsable', `补丁文件不是合法 YAML，已拒绝写入：${bad.map((b) => b.path).join('、')}`, {
      files: bad,
    })
  }
}

// ═══════════════════════ 落层调用（唯一的适配点） ═══════════════════════

/**
 * 功能作用：调用 host-core 的落层规划（**本文件唯一与 host-core 签名耦合的地方**）。
 *          规范签名（Lead 裁决）：
 *            planLayout({ id, serverName, config, homeText, profiles: [{name,text}], selected: string[] })
 *              → { ok, writes: [{ target: 'home'|'<profile 名>', text, action }], conflicts, notes }
 *          另兼容 tasks.md §1.1 早期记的三参位置形式 `planLayout(server, selected, profiles)`（按 arity 判定）。
 * 参数：server { id, serverName, config }；selected（选中的 profile 名数组）；sources。
 * 返回值：{ ok, writes, conflicts, notes }。
 */
function planLayoutCall(server, selected, sources) {
  const fn = coreFn('planLayout')
  if (!fn) throw new ServiceError('core-unavailable', `host-core.planLayout 不可用：${coreImportError}`)
  const profiles = sources.profiles.map((p) => ({ name: p.name, text: p.text }))
  const input = {
    id: server.id,
    serverName: server.serverName,
    config: server.config,
    homeText: sources.home.text,
    profiles,
    selected: [...selected],
  }
  let out
  try {
    out = fn.length >= 3 ? fn(input, [...selected], profiles) : fn(input)
  } catch (err) {
    throw new ServiceError('layout-plan-failed', `落层规划失败：${errText(err)}`)
  }
  if (!out || typeof out !== 'object') throw new ServiceError('layout-plan-failed', 'planLayout 未返回结果')
  const writes = Array.isArray(out.writes) ? out.writes : []
  const conflicts = Array.isArray(out.conflicts) ? out.conflicts : []
  return {
    ok: out.ok !== false && conflicts.length === 0,
    writes,
    conflicts,
    notes: Array.isArray(out.notes) ? out.notes : [],
  }
}

function targetFileOf(anchor, target) {
  if (target === 'home' || target === 'homePatch') return anchor.homePatch
  if (typeof target !== 'string' || target === '') throw new ServiceError('bad-target', '写入目标为空')
  if (path.isAbsolute(target)) {
    if (!isInside(anchor.home, target)) throw new ServiceError('bad-target', `写入目标越界：${target}`)
    return target
  }
  const file = profilePatchPathOf(anchor.home, target)
  if (!isInside(anchor.home, file)) throw new ServiceError('bad-target', `写入目标越界：${target}`)
  return file
}

/**
 * 功能作用：把 planLayout 的 writes 落到磁盘（home 优先，其余按目标名排序，保证可复现）。
 * 参数：anchor、writes。
 * 返回值：[{ target, path, action, changed, backedUp }]。
 */
async function applyWrites(anchor, writes) {
  const ordered = [...writes].sort((a, b) => {
    const rank = (t) => (t === 'home' || t === 'homePatch' ? 0 : 1)
    const ra = rank(a && a.target)
    const rb = rank(b && b.target)
    if (ra !== rb) return ra - rb
    return String(a && a.target).localeCompare(String(b && b.target))
  })
  const results = []
  for (const w of ordered) {
    if (!w || typeof w.text !== 'string') continue
    const file = targetFileOf(anchor, w.target)
    // planLayout / plan* 只会把**真的会变**的文件放进 writes；action 是 insert/update/remove 的语义标签，
    // 三者都必须落盘（remove = 该层的副本要被删掉）。
    if (w.changed === false || w.action === 'none') {
      results.push({ target: w.target, path: file, action: w.action || 'update', changed: false, backedUp: null })
      continue
    }
    const { backup } = await writePatchFile(file, w.text)
    results.push({ target: w.target, path: file, action: w.action || 'update', changed: true, backedUp: backup })
  }
  return results
}

// ═══════════════════════════ 探测（§2.5） ═══════════════════════════

const MCP_SDK_PACKAGE = '@modelcontextprotocol/client'
const MCP_SDK_STDIO = '@modelcontextprotocol/client/stdio'
const SUBPROCESS_PACKAGE = '@deepseek-ai/dsh-subprocess'
const probeResolveCache = new Map()

/**
 * 功能作用：从模块命名空间里挑一个函数/构造器（兼容 ESM 命名导出与 CJS default 互操作）。
 * 参数：mod 模块命名空间；names 候选名字数组。
 * 返回值：function 或 null。
 */
function pickFn(mod, names) {
  for (const name of names) {
    const cands = [mod && mod[name], mod && mod.default && mod.default[name]]
    for (const c of cands) if (typeof c === 'function') return c
  }
  const d = mod && mod.default
  return typeof d === 'function' ? d : null
}

function resolveFirst(spec, bases) {
  for (const base of bases) {
    try {
      const hit = createRequire(base).resolve(spec)
      if (hit) return hit
    } catch { /* 换下一个解析原点 */ }
  }
  return null
}

/** 真实 probe 的模块解析原点：profile 目录 → 共享 `<home>/profiles` → `@deepseek-ai/dsh-mcp-client` 自己。 */
function probeBases() {
  const a = STATE.anchor || {}
  const bases = []
  if (a.profileDir) bases.push(path.join(a.profileDir, 'package.json'))
  if (a.home) bases.push(path.join(a.home, 'profiles', 'package.json'))
  const viaClient = resolveFirst(MCP_CLIENT_PACKAGE, bases)
  if (viaClient) bases.push(viaClient)
  return bases
}

/**
 * 功能作用：两级解析一个 MCP SDK 模块（实测：`@modelcontextprotocol/client` 在 profile 根解析不到，
 *          但能从 `@deepseek-ai/dsh-mcp-client` 自己的解析原点解析到 —— 它是该包的依赖）。
 * 参数：spec 模块名。
 * 返回值：绝对路径 或 null（结果按 spec+home 缓存）。
 */
function resolveProbeModule(spec) {
  const key = `${spec}|${(STATE.anchor && STATE.anchor.home) || ''}`
  if (probeResolveCache.has(key)) return probeResolveCache.get(key)
  const hit = resolveFirst(spec, probeBases())
  probeResolveCache.set(key, hit)
  return hit
}

async function loadResolved(file) {
  if (!file) throw new Error('模块路径为空')
  return import(pathToFileURL(file).href)
}

/** 父进程环境变量擦洗：优先用 `@deepseek-ai/dsh-subprocess` 的 scrubbedParentEnv，缺失则本地兜底。 */
async function scrubbedEnv() {
  try {
    const p = resolveProbeModule(SUBPROCESS_PACKAGE)
    if (p) {
      const fn = pickFn(await loadResolved(p), ['scrubbedParentEnv', 'scrubParentEnv'])
      if (fn) {
        const out = fn()
        if (out && typeof out === 'object') return out
      }
    }
  } catch { /* 落到本地兜底 */ }
  const deny = /(token|secret|password|passwd|api[_-]?key|credential|authorization|cookie)/i
  const out = {}
  for (const [k, v] of Object.entries(process.env)) if (!deny.test(k)) out[k] = v
  return out
}

/**
 * 功能作用：按 config 造传输（与 `@deepseek-ai/dsh-mcp-client` 的 transport.ts 同形：stdio / streamable-http）。
 *          先做配置自检（缺 url/command 直接报错，连模块系统都不碰），再解析 SDK —— 这样坏配置绝不会
 *          走到「起客户端」那一步。
 */
async function buildProbeTransport(config) {
  const transport = firstString(config.transport) || 'stdio'
  const isHttp = transport === 'streamable-http' || transport === 'http'
  const url = isHttp ? firstString(config.url) : ''
  const command = isHttp ? '' : firstString(config.command)
  if (isHttp && !url) throw new Error('streamable-http 传输缺少 url')
  if (!isHttp && !command) throw new Error('stdio 传输缺少 command')
  const sdkPath = resolveProbeModule(MCP_SDK_PACKAGE)
  if (!sdkPath) throw new Error(`无法解析 ${MCP_SDK_PACKAGE}（已试 profile 与 dsh-mcp-client 两处解析原点）`)
  const sdk = await loadResolved(sdkPath)
  if (isHttp) {
    const Ctor = pickFn(sdk, ['StreamableHTTPClientTransport', 'StreamableHttpClientTransport'])
    if (!Ctor) throw new Error(`${MCP_SDK_PACKAGE} 未导出 StreamableHTTPClientTransport`)
    const headers = config.headers && typeof config.headers === 'object' ? config.headers : null
    return { transport: new Ctor(new URL(url), headers ? { requestInit: { headers } } : undefined), sdk }
  }
  const stdioPath = resolveProbeModule(MCP_SDK_STDIO)
  const stdioMod = stdioPath ? await loadResolved(stdioPath) : sdk
  const Ctor = pickFn(stdioMod, ['StdioClientTransport']) || pickFn(sdk, ['StdioClientTransport'])
  if (!Ctor) throw new Error(`${MCP_SDK_STDIO} 未导出 StdioClientTransport`)
  const env = { ...(await scrubbedEnv()), ...(config.env && typeof config.env === 'object' ? config.env : {}) }
  const cwd = firstString(config.cwd)
  return { transport: new Ctor({ command, args: Array.isArray(config.args) ? config.args : [], env, ...(cwd ? { cwd } : {}) }), sdk }
}

/**
 * 功能作用：把 MCP SDK / 探测桩返回的工具数组归一成 `[{ name, description }]`。
 *          形状对齐核心 `ToolSchema = { name, description, parameters }`（描述可缺失 → ''）。
 * 参数：value（任意；数组或 `{ tools: [...] }`）。
 * 返回值：新数组（非法项丢弃，绝不抛）。
 */
function normalizeToolList(value) {
  const arr = Array.isArray(value) ? value : value && Array.isArray(value.tools) ? value.tools : []
  const out = []
  for (const item of arr) {
    if (!item || typeof item.name !== 'string' || item.name === '') continue
    out.push({ name: item.name, description: typeof item.description === 'string' ? item.description : '' })
  }
  return out
}

/**
 * 功能作用：真实路径的探测执行器 —— 按 config 起一次 MCP 客户端（stdio/http），**任何路径都关闭客户端**。
 *          客户端形状对齐 `@deepseek-ai/dsh-mcp-client` 的 connection.ts（Client + 能力协商 + listTools）。
 *          离线测试一律走 `__setProbeRunner` 的桩，因此这里不做网络/子进程实测。
 * 参数：config（mcp-client Config）、{ signal }。
 * 返回值：{ ok: true, toolCount?, tools? }；失败抛错（由 probeOnce 统一成 `{ ok:false, error }`）。
 */
async function realProbeRunner(config, { signal } = {}) {
  const { transport, sdk } = await buildProbeTransport(config)
  const ClientCtor = pickFn(sdk, ['Client', 'McpClient'])
  if (!ClientCtor) throw new Error(`${MCP_SDK_PACKAGE} 未导出 Client`)
  const client = new ClientCtor(
    { name: PLUGIN_ID, version: PLUGIN_VERSION },
    {
      capabilities: {},
      versionNegotiation: { mode: 'auto' },
      listChanged: { tools: { autoRefresh: false, debounceMs: 0, onChanged() {} } },
    },
  )
  let closed = false
  const closeQuietly = async () => {
    if (closed) return
    closed = true
    for (const [obj, methods] of [[client, ['close', 'stop', 'disconnect']], [transport, ['close', 'stop']]]) {
      for (const m of methods) {
        if (obj && typeof obj[m] === 'function') {
          try { await obj[m]() } catch { /* best effort */ }
          break
        }
      }
    }
  }
  try {
    if (signal && typeof signal.addEventListener === 'function') {
      signal.addEventListener('abort', () => { void closeQuietly() })
    }
    await client.connect(transport)
    let toolCount
    let tools
    try {
      const res = await client.listTools()
      const arr = Array.isArray(res) ? res : res && Array.isArray(res.tools) ? res.tools : null
      if (arr) {
        toolCount = arr.length
        tools = normalizeToolList(arr)
      }
    } catch { /* 工具数拿不到不算探测失败 */ }
    return { ok: true, toolCount, tools }
  } finally {
    await closeQuietly()
  }
}

/**
 * 功能作用：跑一次探测，超时按 probeTimeoutMs（A7.2），任何路径都返回统一形状（A7.1）。
 * 参数：config、timeoutMs、opts（`{ wantTools: true }` 时额外带回 `tools` 清单）。
 * 返回值：{ ok, latencyMs, toolCount? | error? }；wantTools 时多一个 `tools`。
 */
async function probeOnce(config, timeoutMs, opts = {}) {
  const started = Date.now()
  const runner = SEAMS.probeRunner || ((cfg, opts) => realProbeRunner(cfg, opts))
  const controller = typeof AbortController === 'function' ? new AbortController() : null
  let timer = null
  try {
    const timeout = new Promise((_resolve, reject) => {
      timer = setTimeout(() => {
        if (controller) { try { controller.abort() } catch { /* best effort */ } }
        reject(new Error(`probe timed out after ${timeoutMs}ms`))
      }, timeoutMs)
      if (timer && typeof timer.unref === 'function') timer.unref()
    })
    const res = await Promise.race([
      Promise.resolve().then(() => runner(config, { timeoutMs, signal: controller ? controller.signal : undefined })),
      timeout,
    ])
    const latencyMs = res && typeof res.latencyMs === 'number' ? res.latencyMs : Date.now() - started
    if (res && res.ok === false) return { ok: false, latencyMs, error: errText(res.error || 'probe failed') }
    const out = { ok: true, latencyMs }
    if (res && typeof res.toolCount === 'number') out.toolCount = res.toolCount
    if (opts.wantTools) out.tools = normalizeToolList(res && res.tools)
    return out
  } catch (err) {
    return { ok: false, latencyMs: Date.now() - started, error: errText(err) }
  } finally {
    if (timer) clearTimeout(timer)
  }
}

// ═══════════════════════════ 服务层（§2.4 的业务实现） ═══════════════════════════

function createService(ctx) {
  const ensureAnchor = async () => {
    if (!STATE.anchor) STATE.anchor = await resolveAnchor(ctx)
    return STATE.anchor
  }

  async function snapshot() {
    const anchor = await ensureAnchor()
    if (!anchor.home) {
      throw new ServiceError('anchor-unavailable', '无法锚定 DSH home（profileContext / settings / $DSH_PROFILE_DIR / baseUrl 都不可用）', {
        anchorErrors: anchor.errors,
      })
    }
    const sources = await readAllSources(anchor)
    const stateInfo = await readState(anchor.home)
    return { anchor, sources, stateInfo }
  }

  /**
   * 悬空覆盖行（override-only id）：该 id 在**所有层**都没有同名 insert 条目。真机 profile patch 里
   * 全是这种行（`- id: dsh-plugin-manager` / `- id: ui-settings` / `- id: llm-deepseek` …），
   * 它们不构成任何服务器。
   * host-core 的 `mergeServers` 修好后会自己报 `E_ORPHAN_OVERRIDE`（那时这里不再重复计算）；
   * 未修好前由这里兜底，保证面板始终看得到，并顺手绕开它在空值分支上的崩溃。
   */
  function orphanOverridesOf(sources) {
    const parse = coreFn('parsePatch')
    if (!parse) return []
    const entryIds = new Set()
    try {
      for (const e of parse(sources.home.text).entries) entryIds.add(e.id)
      for (const p of sources.profiles) for (const e of parse(p.text).entries) entryIds.add(e.id)
    } catch (err) {
      HOST_DIAG.lastError = `orphanOverridesOf: ${errText(err)}`
      return []
    }
    const out = []
    for (const p of sources.profiles) {
      let parsed = null
      try { parsed = parse(p.text) } catch { continue }
      for (const o of parsed.overrides) {
        if (!o.id || entryIds.has(o.id)) continue
        if (out.some((x) => x.id === o.id && x.layer === p.name)) continue
        out.push({ code: 'E_ORPHAN_OVERRIDE', id: o.id, layer: p.name, message: `${p.name}：覆盖行 ${o.id} 在所有层都没有同名 insert 条目` })
      }
    }
    return out
  }

  /** 从 profile 文本里剔除悬空覆盖行的行块（`mergeServers` 未修好时的兜底输入）。 */
  function stripOrphanOverrideRows(sources) {
    const parse = coreFn('parsePatch')
    const profiles = sources.profiles.map((p) => ({ name: p.name, text: p.text }))
    if (!parse) return profiles
    const orphans = orphanOverridesOf(sources)
    if (orphans.length === 0) return profiles
    const byLayer = new Map()
    for (const o of orphans) byLayer.set(o.layer, new Set([...(byLayer.get(o.layer) || []), o.id]))
    let dropped = 0
    const out = profiles.map((p) => {
      const ids = byLayer.get(p.name)
      if (!ids || ids.size === 0) return p
      let parsed = null
      try { parsed = parse(p.text) } catch { return p }
      const drop = new Set()
      for (const o of parsed.overrides) {
        if (!o.id || !ids.has(o.id)) continue
        for (let i = o.blockStart; i < o.blockEnd; i += 1) drop.add(i)
        dropped += 1
      }
      if (drop.size === 0) return p
      return { name: p.name, text: parsed.lines.filter((_, i) => !drop.has(i)).join('') }
    })
    HOST_DIAG.mergeSanitizedRows = dropped
    return out
  }

  /**
   * host-core `mergeServers({ homeText, profiles, profilesOnDisk, knownProfiles })`
   * → `{ ok, profiles, servers, conflicts, notes? }`。
   * `profilesOnDisk`（盘上全部 profile 目录名，含还没有 patch 文件的新 profile）与
   * `knownProfiles`（state.json 里上次确认矩阵时的 profile 集合）一起，才能把「部分生效的服务器
   * 遇上新 profile」判成「布局待确认」（A2.4 / layoutDrift.code = NEW_PROFILE）。
   * 先用**原始**输入调用（这样 host-core 自带的 `E_ORPHAN_OVERRIDE` 等诊断能如实透出）；只有它抛错时
   * 才退到「剔除悬空覆盖行」的兜底输入，并置 `mergeFallback`。任何情况下都不向上抛。
   */
  function mergeOf(sources, stateInfo) {
    const fn = coreFn('mergeServers')
    const empty = { ok: false, servers: [], profiles: sources.profiles.map((p) => p.name), conflicts: [], notes: [], orphanOverrides: 0 }
    if (!fn) return empty
    const knownProfiles = (stateInfo && stateInfo.state && stateInfo.state.knownProfiles) || undefined
    const profilesOnDisk = sources.profiles.map((p) => p.name)
    const rawProfiles = sources.profiles.map((p) => ({ name: p.name, text: p.text }))
    let res = null
    let fellBack = false
    try {
      res = fn({ homeText: sources.home.text, profiles: rawProfiles, profilesOnDisk, knownProfiles })
    } catch (err) {
      fellBack = true
      HOST_DIAG.mergeFallback = `mergeServers: ${errText(err)}`
      try {
        res = fn({ homeText: sources.home.text, profiles: stripOrphanOverrideRows(sources), profilesOnDisk, knownProfiles })
      } catch (err2) {
        HOST_DIAG.lastError = `mergeServers(兜底): ${errText(err2)}`
        return empty
      }
    }
    if (!res || typeof res !== 'object') return empty
    const conflicts = Array.isArray(res.conflicts) ? res.conflicts : []
    const notes = Array.isArray(res.notes) ? res.notes : []
    const reported = JSON.stringify(conflicts).includes('E_ORPHAN_OVERRIDE') || JSON.stringify(notes).includes('E_ORPHAN_OVERRIDE')
    // host-core 自己报了就不再重复；它没报（含它抛错走兜底的情况）则由这里补齐，面板永远看得到。
    const orphanOverrides = reported ? [] : orphanOverridesOf(sources)
    return {
      ok: res.ok !== false,
      servers: Array.isArray(res.servers) ? res.servers : [],
      profiles: Array.isArray(res.profiles) ? res.profiles : empty.profiles,
      conflicts: [...conflicts, ...orphanOverrides],
      notes,
      orphanOverrides: orphanOverrides.length,
    }
  }

  function allProfileNames(sources) {
    const names = sources.profiles.map((p) => p.name)
    const anchorProfile = STATE.anchor && STATE.anchor.profile
    if (anchorProfile && !names.includes(anchorProfile) && STATE.anchor.profileDir && fs.existsSync(STATE.anchor.profileDir)) {
      names.push(anchorProfile)
      names.sort()
    }
    return names
  }

  function patchInfoOf(sources) {
    const info = { home: fileInfo(sources.home), profiles: {} }
    for (const p of sources.profiles) info.profiles[p.name] = fileInfo(p)
    return info
  }

  /** 含该 id（insert 条目或覆盖行）的源文件；调用方传进来的 text 一律是**本次操作刚重读**的（§2.3）。 */
  function sourcesWithId(sources, id) {
    return [sources.home, ...sources.profiles].filter((src) => {
      if (!src.exists) return false
      const parsed = parseOf(src.text)
      if (!parsed || parsed.ok === false) return false
      const entries = Array.isArray(parsed.entries) ? parsed.entries : []
      const overrides = Array.isArray(parsed.overrides) ? parsed.overrides : []
      return entries.some((e) => e && e.id === id) || overrides.some((o) => o && o.id === id)
    })
  }

  function matrixOf(payload, names) {
    if (Array.isArray(payload.profiles)) {
      const wanted = payload.profiles.filter((n) => typeof n === 'string')
      return names.filter((n) => wanted.includes(n))
    }
    if (payload.matrix && typeof payload.matrix === 'object') {
      return names.filter((n) => payload.matrix[n] === true)
    }
    return [...names]
  }

  function requireId(payload) {
    const id = firstString(payload.id, payload.serverId)
    if (!id) throw new ServiceError('bad-request', '缺少 id', { id: '必填' })
    return id
  }

  // ─────────────── 静态运行态（D7 静态层：loader 条目态 + 已注册工具数） ───────────────

  /**
   * 功能作用：归一 loader 条目 id —— 嵌套 `include:` 子树里的条目 id 会带前缀，剥掉前缀链后才能与
   *          服务器 id 对齐（不猜值，只做前缀剥离）。
   * 参数：raw 原始 id。
   * 返回值：候选 id 数组（含原值）。
   */
  function entryIdCandidates(raw) {
    const out = []
    let key = String(raw === undefined || raw === null ? '' : raw)
    if (key === '') return out
    out.push(key)
    while (key.startsWith('include:')) {
      key = key.slice('include:'.length)
      out.push(key)
    }
    if (key.includes(':')) out.push(key.slice(key.lastIndexOf(':') + 1))
    return out
  }

  /** cordis `FiberState` 镜像（vendor/cordis/lib/types/fiber.d.ts:67-73）。 */
  const FIBER_STATES = Object.freeze({ 0: 'pending', 1: 'loading', 2: 'active', 3: 'failed', 4: null, 5: 'loading' })
  /** 同一 id 多条目时的取值优先级：disabled 最高。 */
  const STATE_PRIORITY = Object.freeze({ disabled: 0, failed: 1, active: 2, loading: 3, pending: 4 })

  /** 只认「确实是 number / 确实是已知字符串」的 fiber 态，其余一律 null（不猜）。 */
  function fiberStateOf(entry) {
    const values = [entry && entry.fiber && entry.fiber.state, entry && entry.state]
    for (const value of values) {
      if (typeof value === 'number') {
        const mapped = FIBER_STATES[value]
        if (mapped !== undefined) return mapped
      } else if (typeof value === 'string') {
        const s = value.toLowerCase()
        if (s === 'pending' || s === 'loading' || s === 'active' || s === 'failed' || s === 'disabled') return s
        if (s === 'unloading') return 'loading'
        if (s === 'disposed') return null
      }
    }
    return null
  }

  /**
   * 功能作用：采集 `loader.entries()` 里 MCP 条目的态（一次，供整个 list 复用）。
   *          跳过 group 条目，只留 `name === '@deepseek-ai/dsh-mcp-client'`；`entry.disabled` 优先。
   * 参数：无。
   * 返回值：Map<id, state>；loader 服务不可用返回 null。
   */
  function loaderStates() {
    const loader = safeGet(ctx, 'loader')
    if (!loader || typeof loader.entries !== 'function') return null
    let entries
    try {
      entries = [...loader.entries()]
    } catch (err) {
      HOST_DIAG.lastError = `loader.entries: ${errText(err)}`
      return null
    }
    const byId = new Map()
    for (const entry of entries) {
      const options = entry && entry.options
      if (!options || options.group) continue
      if (options.name !== MCP_CLIENT_PACKAGE) continue
      const state = entry.disabled === true ? 'disabled' : fiberStateOf(entry)
      for (const key of entryIdCandidates(options.id)) {
        const prev = byId.has(key) ? byId.get(key) : null
        if (prev === null) byId.set(key, state)
        else if (state !== null && (STATE_PRIORITY[state] ?? 9) < (STATE_PRIORITY[prev] ?? 9)) byId.set(key, state)
      }
    }
    return byId
  }

  /**
   * 已注册工具快照（一次）：`[{ name, description }]`。
   * `tools` 服务缺失或 `schemas()` 抛错 → `{ ok:false, reason }`（调用方降级，不报错）。
   */
  function registeredTools() {
    const tools = safeGet(ctx, 'tools')
    if (!tools || typeof tools.schemas !== 'function') {
      return { ok: false, tools: [], reason: 'tools service is not available' }
    }
    try {
      const schemas = tools.schemas()
      if (!Array.isArray(schemas)) return { ok: false, tools: [], reason: 'tools.schemas() did not return an array' }
      return { ok: true, tools: normalizeToolList(schemas), reason: null }
    } catch (err) {
      HOST_DIAG.lastError = `tools.schemas: ${errText(err)}`
      return { ok: false, tools: [], reason: `tools.schemas() threw: ${errText(err)}` }
    }
  }

  /**
   * 功能作用：给 list 的 servers 补 `staticState` / `toolCountEstimate`（D7 静态层，能力探测）。
   *          **绝不抛**：loader/tools 缺失或抛错都退化成 null 字段，list 仍然 ok。
   *          `tools.schemas()` 每次调用只取一次快照（不按服务器重复取）。
   * 参数：servers（mergeServers 的结果）、toolSnapshot（可选，复用同一份工具快照）。
   * 返回值：新数组（每项多两个字段）。
   */
  function enrichRuntime(servers, toolSnapshot) {
    let states = null
    let snap = toolSnapshot || null
    try { states = loaderStates() } catch (err) { HOST_DIAG.lastError = `loaderStates: ${errText(err)}` }
    if (!snap) {
      try { snap = registeredTools() } catch (err) { HOST_DIAG.lastError = `registeredTools: ${errText(err)}` }
    }
    if (!snap) snap = { ok: false, tools: [], reason: 'tools snapshot unavailable' }
    HOST_DIAG.runtimeProbe = { loader: states !== null, tools: snap.ok }
    return servers.map((s) => {
      let staticState = null
      if (states && s && typeof s.id === 'string') {
        for (const key of entryIdCandidates(s.id)) {
          if (states.has(key)) { staticState = states.get(key); break }
        }
      }
      let toolCountEstimate = null
      if (snap.ok && s && typeof s.serverName === 'string' && s.serverName !== '') {
        const prefix = `mcp__${s.serverName}__`
        toolCountEstimate = snap.tools.filter((t) => t.name.startsWith(prefix)).length
      }
      return { ...s, staticState, toolCountEstimate }
    })
  }

  // ─────────────── 原始 YAML（面板提交的 config 体） ───────────────

  /**
   * 功能作用：把面板提交的「原始 YAML（config 体）」包成标准 insert 块，交给 host-core `parsePatch`
   *          做结构化解析 —— **不引入 js-yaml**，缩进/注释/`!!js` 规则与真实 patch 完全同源。
   *          解析失败/未解析出 config 一律抛 `bad-yaml`（HTTP 200 业务错误、零写入）。
   * 参数：id 条目 id；yamlText 用户 YAML（`transport:` 起头的键值体）。
   * 返回值：解析出的 config 对象。
   */
  function configFromYaml(id, yamlText) {
    const parse = coreFn('parsePatch')
    if (!parse) throw new ServiceError('bad-yaml', `host-core.parsePatch 不可用：${coreImportError}`, { yaml: '无法解析' })
    const idPattern = (core && core.MCP_ID_PATTERN) || /^[A-Za-z0-9._-]{1,64}$/
    if (!idPattern.test(String(id))) {
      throw new ServiceError('bad-yaml', `条目 id 不合法：${id}`, { id: '不合法' })
    }
    const body = String(yamlText).replace(/\r\n?/g, '\n').replace(/\s+$/, '')
    if (body.trim() === '') throw new ServiceError('bad-yaml', 'yaml 为空', { yaml: '必填' })
    const indented = body.split('\n').map((line) => (line.trim() === '' ? '' : `        ${line}`)).join('\n')
    const wrapped = `- insert:\n    - id: ${id}\n      name: '${MCP_CLIENT_PACKAGE}'\n      config:\n${indented}\n`
    let res
    try {
      res = parse(wrapped)
    } catch (err) {
      throw new ServiceError('bad-yaml', `YAML 解析失败：${errText(err)}`, { yaml: errText(err) })
    }
    if (!res || res.ok === false) {
      const detail = res && res.error ? `${res.error.code || 'parse-error'}${res.error.message ? `：${res.error.message}` : ''}` : '未知解析错误'
      throw new ServiceError('bad-yaml', `YAML 解析失败：${detail}`, { yaml: detail })
    }
    const entry = (Array.isArray(res.entries) ? res.entries : []).find((e) => e && e.id === id)
    if (!entry || !entry.config || typeof entry.config !== 'object') {
      throw new ServiceError('bad-yaml', 'YAML 未解析出 config 对象（需是 `transport:` 起头的键值体）', { yaml: '未解析出 config' })
    }
    return entry.config
  }

  /** 取 payload.yaml（只在确实是字符串且非空时生效；否则 null）。 */
  function yamlOf(payload) {
    const raw = payload && payload.yaml
    return typeof raw === 'string' && raw.trim() !== '' ? raw : null
  }

  /**
   * 功能作用：YAML 路径下的**校验**失败一律归到 `bad-yaml` —— 用户交的是原始 YAML，问题在 YAML 里，
   *          面板要能定位到「YAML 有问题」而不是笼统的配置非法。非 yaml 路径原样抛出。
   * 参数：err 捕获到的错误。
   * 返回值：要抛出的错误（调用方 `throw asBadYaml(err)`）。
   */
  function asBadYaml(err) {
    if (err instanceof ServiceError && (err.code === 'invalid-config' || err.code === 'validate-failed')) {
      const base = err.fields && typeof err.fields === 'object' ? err.fields : {}
      return new ServiceError('bad-yaml', err.message, { ...base, yaml: err.message })
    }
    return err
  }

  function findServer(servers, id) {
    return servers.find((s) => s && s.id === id) || null
  }

  function normalizeConfig(input, defaults) {
    const config = input && typeof input === 'object' ? { ...input } : {}
    if (config.transport === undefined && defaults.defaultTransport !== undefined) config.transport = defaults.defaultTransport
    for (const key of ['toolCallTimeoutMs', 'failOnStartupError', 'maxInstructionBytes']) {
      if (config[key] === undefined && defaults[key] !== undefined) config[key] = defaults[key]
    }
    return config
  }

  /**
   * host-core `validateMcpConfig(id, config, taken)` 的 `taken` 是 `[{ id, serverName }]` 记录数组
   * （见 host-core `normalizeTaken`），不是名字数组。
   */
  function takenOf(servers, excludeServerName) {
    return servers
      .filter((s) => s && typeof s.serverName === 'string' && s.serverName !== excludeServerName)
      .map((s) => ({ id: s.id, serverName: s.serverName }))
  }

  function validateOrThrow(id, config, taken, servers) {
    if (servers.some((s) => s && s.id === id)) {
      throw new ServiceError('invalid-config', `id 已存在：${id}`, { id: '已存在' })
    }
    const fn = coreFn('validateMcpConfig')
    if (!fn) return
    let res
    try {
      res = fn(id, config, taken)
    } catch (err) {
      throw new ServiceError('validate-failed', `配置校验失败：${errText(err)}`)
    }
    if (res && res.ok === false) {
      throw new ServiceError('invalid-config', '配置校验未通过', res.fields && Object.keys(res.fields).length ? res.fields : null)
    }
  }

  /** 矩阵/布局变更成功后，把「本次确认的 profile 集合」记进 state.json（供 A2.3/A2.4 的漂移判定）。 */
  async function rememberProfiles(anchor, stateInfo, names) {
    try {
      const known = stateInfo && stateInfo.state && Array.isArray(stateInfo.state.knownProfiles) ? stateInfo.state.knownProfiles : null
      const same = known && known.length === names.length && names.every((n) => known.includes(n))
      if (same) return null
      const written = await writeState(anchor.home, { ...stateInfo.state, knownProfiles: [...names] })
      return written.file
    } catch (err) {
      HOST_DIAG.lastError = `knownProfiles: ${errText(err)}`
      return null
    }
  }

  /** 落层 + 写盘（调用方必须已持有操作锁，并传入**刚重读**的 sources）。 */
  async function layoutAndWrite(anchor, server, selected, sources, stateInfo) {
    const plan = planLayoutCall(server, selected, sources)
    if (!plan.ok) {
      throw new ServiceError('layout-conflict', '落层冲突，已拒绝写入', { conflicts: plan.conflicts })
    }
    const writes = await applyWrites(anchor, plan.writes)
    const stateFile = stateInfo ? await rememberProfiles(anchor, stateInfo, allProfileNames(sources)) : null
    return { writes, notes: plan.notes, stateFile }
  }

  return {
    ensureAnchor,
    snapshot,

    /** 端点 list：`{ home, profile, profiles, servers, defaults, diagnostics, patchInfo }`。 */
    async list() {
      const { anchor, sources, stateInfo } = await snapshot()
      const merged = mergeOf(sources, stateInfo)
      const servers = enrichRuntime(merged.servers)
      return {
        home: anchor.home,
        profile: anchor.profile,
        profileDir: anchor.profileDir,
        profiles: merged.profiles.length > 0 ? merged.profiles : allProfileNames(sources),
        servers,
        defaults: stateInfo.state.defaults,
        diagnostics: {
          plugin: PLUGIN_ID,
          anchorSource: anchor.source,
          anchorErrors: anchor.errors,
          coreAvailable: Boolean(core),
          coreImportError,
          state: { path: stateInfo.file, ok: stateInfo.ok, error: stateInfo.error },
          diagFile: HOST_DIAG.diagFile,
          httpRegistered: HOST_DIAG.httpRegistered,
          httpSkipped: HOST_DIAG.httpSkipped,
          toolsRegistered: HOST_DIAG.toolsRegistered,
          toolsSkipped: HOST_DIAG.toolsSkipped,
          lastError: HOST_DIAG.lastError,
          mergeSanitizedRows: HOST_DIAG.mergeSanitizedRows,
          mergeFallback: HOST_DIAG.mergeFallback,
          mergeConflicts: merged.conflicts,
          conflicts: merged.conflicts,
          notes: merged.notes,
          orphanOverrides: merged.orphanOverrides,
          lastProbe: HOST_DIAG.lastProbe || null,
        },
        patchInfo: patchInfoOf(sources),
      }
    },

    async patchInfo() {
      const { anchor, sources } = await snapshot()
      return { home: anchor.home, profile: anchor.profile, patchInfo: patchInfoOf(sources) }
    },

    async getDefaults() {
      const { anchor, stateInfo } = await snapshot()
      return { defaults: stateInfo.state.defaults, path: stateInfo.file, version: stateInfo.state.version || STATE_VERSION, ok: stateInfo.ok, error: stateInfo.error }
    },

    async setDefaults(payload) {
      return withOpLock(async () => {
        const { anchor, stateInfo } = await snapshot()
        const incoming = payload && typeof payload.defaults === 'object' && payload.defaults ? payload.defaults : payload
        const next = { ...stateInfo.state.defaults }
        for (const key of Object.keys(FALLBACK_DEFAULTS)) {
          if (incoming && incoming[key] !== undefined) next[key] = incoming[key]
        }
        if (next.probeTimeoutMs !== undefined && !(Number(next.probeTimeoutMs) > 0)) {
          throw new ServiceError('invalid-config', 'probeTimeoutMs 必须是正数', { probeTimeoutMs: '必须是正数' })
        }
        const state = { ...stateInfo.state, defaults: next }
        const written = await writeState(anchor.home, state)
        return { defaults: next, path: written.file, backedUp: written.backup }
      })
    },

    async add(payload) {
      return withOpLock(async () => {
        const { anchor, sources, stateInfo } = await snapshot()
        assertParsable(sources)
        const defaults = stateInfo.state.defaults
        const merged = mergeOf(sources, stateInfo)
        const servers = merged.servers
        const serverName = firstString(payload.serverName, payload.name)
        if (!serverName) throw new ServiceError('bad-request', '缺少 serverName', { serverName: '必填' })
        const id = firstString(payload.id) || `mcp-${serverName.replace(/[^A-Za-z0-9_-]/g, '-')}`
        // 面板的「原始 YAML 兜底」：给了 yaml 就用它（经 host-core.parsePatch 结构化解析），优先于 config。
        const yamlText = yamlOf(payload)
        const config = yamlText
          ? normalizeConfig({ serverName, ...configFromYaml(id, yamlText) }, defaults)
          : normalizeConfig(payload.config, defaults)
        if (config.serverName === undefined) config.serverName = serverName
        try {
          validateOrThrow(id, config, takenOf(servers, serverName), servers)
        } catch (err) {
          throw yamlText ? asBadYaml(err) : err
        }
        const names = allProfileNames(sources)
        const selected = matrixOf(payload, names)
        const server = { id, serverName, config }
        const { writes, notes, stateFile } = await layoutAndWrite(anchor, server, selected, sources, stateInfo)
        return { server, matrix: Object.fromEntries(names.map((n) => [n, selected.includes(n)])), writes, notes }
      })
    },

    async update(payload) {
      return withOpLock(async () => {
        const { anchor, sources, stateInfo } = await snapshot()
        assertParsable(sources)
        const id = requireId(payload)
        const merged = mergeOf(sources, stateInfo)
        const servers = merged.servers
        const existing = findServer(servers, id)
        if (!existing) throw new ServiceError('not-found', `未找到条目 ${id}`)
        const defaults = stateInfo.state.defaults
        const serverName = firstString(payload.serverName) || existing.serverName || id
        const baseConfig = existing.config && typeof existing.config === 'object' ? existing.config : {}
        // 面板的「原始 YAML 兜底」：给了 yaml 就整块以它为准（优先于 config / 现有配置）。
        const yamlText = yamlOf(payload)
        const config = yamlText
          ? normalizeConfig({ serverName, ...configFromYaml(id, yamlText) }, defaults)
          : normalizeConfig({ ...baseConfig, ...(payload.config && typeof payload.config === 'object' ? payload.config : {}) }, defaults)
        config.serverName = firstString(config.serverName, serverName)
        const fn = coreFn('validateMcpConfig')
        if (fn) {
          let res
          try {
            try { res = fn(id, config, takenOf(servers, serverName)) } catch (err) { throw new ServiceError('validate-failed', `配置校验失败：${errText(err)}`) }
            if (res && res.ok === false) {
              throw new ServiceError('invalid-config', '配置校验未通过', res.fields && Object.keys(res.fields).length ? res.fields : null)
            }
          } catch (err) {
            throw yamlText ? asBadYaml(err) : err
          }
        }
        const names = allProfileNames(sources)
        const selected = payload.matrix === undefined && payload.profiles === undefined
          ? names.filter((n) => (existing.matrix ? existing.matrix[n] !== false : true))
          : matrixOf(payload, names)
        const server = { id, serverName, config }
        const { writes, notes, stateFile } = await layoutAndWrite(anchor, server, selected, sources, stateInfo)
        return { server, matrix: Object.fromEntries(names.map((n) => [n, selected.includes(n)])), writes, notes }
      })
    },

    async remove(payload) {
      return withOpLock(async () => {
        const { anchor, sources } = await snapshot()
        assertParsable(sources)
        const id = requireId(payload)
        const planRemove = coreFn('planRemove')
        if (!planRemove) throw new ServiceError('core-unavailable', `host-core.planRemove 不可用：${coreImportError}`)
        const targets = sourcesWithId(sources, id)
        if (targets.length === 0) throw new ServiceError('not-found', `未找到条目 ${id}`)
        const writes = []
        for (const src of targets) {
          let res
          try { res = planRemove(src.text, id) } catch (err) { throw new ServiceError('layout-plan-failed', `删除规划失败：${errText(err)}`) }
          if (res && res.error) throw new ServiceError('patch-unparsable', `${src.path}：${errMessage(res.error)}`)
          if (res && res.changed && typeof res.text === 'string') {
            writes.push({ target: src.target, text: res.text, action: 'remove' })
          }
        }
        const results = await applyWrites(anchor, writes)
        return { id, writes: results, removed: results.filter((r) => r.changed).length }
      })
    },

    async setEnabled(payload) {
      return withOpLock(async () => {
        const { anchor, sources, stateInfo } = await snapshot()
        assertParsable(sources)
        const id = requireId(payload)
        const merged = mergeOf(sources, stateInfo)
        const servers = merged.servers
        const existing = findServer(servers, id)
        if (!existing) throw new ServiceError('not-found', `未找到条目 ${id}`)
        const names = allProfileNames(sources)
        const enabled = payload.enabled !== false
        const selected = enabled ? [...names] : []
        const server = { id, serverName: existing.serverName, config: existing.config || {} }
        const { writes, notes, stateFile } = await layoutAndWrite(anchor, server, selected, sources, stateInfo)
        return { id, enabled, matrix: Object.fromEntries(names.map((n) => [n, selected.includes(n)])), writes, notes }
      })
    },

    async setMatrix(payload) {
      return withOpLock(async () => {
        const { anchor, sources, stateInfo } = await snapshot()
        assertParsable(sources)
        const id = requireId(payload)
        const merged = mergeOf(sources, stateInfo)
        const servers = merged.servers
        const existing = findServer(servers, id)
        if (!existing) throw new ServiceError('not-found', `未找到条目 ${id}`)
        const names = allProfileNames(sources)
        const selected = matrixOf(payload, names)
        const server = { id, serverName: existing.serverName, config: existing.config || {} }
        const { writes, notes, stateFile } = await layoutAndWrite(anchor, server, selected, sources, stateInfo)
        return { id, matrix: Object.fromEntries(names.map((n) => [n, selected.includes(n)])), writes, notes }
      })
    },

    async probe(payload) {
      const { anchor, sources, stateInfo } = await snapshot()
      const defaults = stateInfo.state.defaults
      const timeoutMs = Number(defaults.probeTimeoutMs) > 0 ? Number(defaults.probeTimeoutMs) : FALLBACK_DEFAULTS.probeTimeoutMs
      let config = payload && payload.config && typeof payload.config === 'object' ? payload.config : null
      let id = firstString(payload && payload.id)
      if (!config && id) {
        const merged = mergeOf(sources, stateInfo)
        const existing = findServer(merged.servers, id)
        if (!existing) throw new ServiceError('not-found', `未找到条目 ${id}`)
        config = existing.config && typeof existing.config === 'object' ? existing.config : null
        if (!config) throw new ServiceError('probe-failed', `条目 ${id} 没有可用的 config（mergeServers 需返回 config）`)
      }
      if (!config) throw new ServiceError('bad-request', 'probe 需要 id 或 config', { id: 'id 或 config 必填' })
      const result = await probeOnce(config, timeoutMs)
      HOST_DIAG.lastProbe = { id: id || null, timeoutMs, ok: result.ok, at: new Date().toISOString() }
      return { id: id || null, timeoutMs, ...result }
    },

    /**
     * 端点 tools（第 12 个动作）：给面板「工具」按钮供数。
     * 静态（默认 mode）：只从宿主**已注册工具**里挑公开名以 `mcp__<serverName>__` 开头的条目，
     *   **绝不连接、绝不起子进程**（list 与静态 tools 都不碰 probeRunner）；
     *   `tools` 服务缺失/schemas 抛错 → 空清单 + note 说明原因（不报错，面板要能显示原因）。
     * 探测（mode:'probe'）：复用 probe 的连接与超时，连接后取真实工具清单；失败走 `probe-failed`。
     */
    async tools(payload) {
      const p = payload && typeof payload === 'object' ? payload : {}
      const mode = firstString(p.mode) === 'probe' ? 'probe' : 'static'
      const { sources, stateInfo } = await snapshot()
      const merged = mergeOf(sources, stateInfo)
      const id = firstString(p.id)
      const wantedName = firstString(p.serverName)
      let server = null
      if (id) server = findServer(merged.servers, id)
      else if (wantedName) server = merged.servers.find((s) => s && s.serverName === wantedName) || null
      if (!server) {
        const label = id || wantedName || '(空)'
        throw new ServiceError('not-found', `未找到条目 ${label}`, id ? { id: '未找到' } : { serverName: '未找到' })
      }
      const serverName = typeof server.serverName === 'string' ? server.serverName : ''

      if (mode === 'static') {
        const snap = registeredTools()
        const prefix = serverName ? `mcp__${serverName}__` : ''
        const list = prefix ? snap.tools.filter((t) => t.name.startsWith(prefix)) : []
        HOST_DIAG.toolsLookup = {
          id: server.id,
          serverName: serverName || null,
          mode,
          registryAvailable: snap.ok,
          matched: list.length,
          at: new Date().toISOString(),
        }
        const note = snap.ok ? TOOLS_STATIC_NOTE : `${TOOLS_STATIC_NOTE}（当前读不到宿主工具清单：${snap.reason}）`
        return {
          mode: 'static',
          serverName,
          source: 'registry',
          tools: list,
          note,
          reason: snap.ok ? null : 'tools-unavailable',
        }
      }

      const defaults = stateInfo.state.defaults
      const timeoutMs = Number(defaults.probeTimeoutMs) > 0 ? Number(defaults.probeTimeoutMs) : FALLBACK_DEFAULTS.probeTimeoutMs
      const config = server.config && typeof server.config === 'object' ? server.config : null
      if (!config) {
        throw new ServiceError('probe-failed', `条目 ${server.id} 没有可用的 config（mergeServers 需返回 config）`, {
          latencyMs: 0,
          error: 'config unavailable',
        })
      }
      const result = await probeOnce(config, timeoutMs, { wantTools: true })
      HOST_DIAG.lastProbe = { id: server.id, timeoutMs, ok: result.ok, at: new Date().toISOString(), mode: 'tools' }
      if (!result.ok) {
        throw new ServiceError('probe-failed', `探测失败：${result.error}`, { latencyMs: result.latencyMs, error: result.error })
      }
      return { mode: 'probe', serverName, source: 'probe', latencyMs: result.latencyMs, tools: result.tools || [] }
    },

    async migrate(payload) {
      return withOpLock(async () => {
        const { anchor, sources } = await snapshot()
        assertParsable(sources)
        const apply = !(payload && payload.apply === false)
        const fn = coreFn('planMigration')
        if (!fn) throw new ServiceError('core-unavailable', `host-core.planMigration 不可用：${coreImportError}`)
        const files = []
        const writes = []
        for (const src of [sources.home, ...sources.profiles]) {
          if (!src.exists) {
            files.push({ target: src.target, path: src.path, exists: false, changed: false, stats: null })
            continue
          }
          let res
          try { res = fn(src.text, { target: src.target }) } catch (err) { throw new ServiceError('layout-plan-failed', `迁移规划失败：${errText(err)}`) }
          if (res && res.error) throw new ServiceError('patch-unparsable', `${src.path}：${errMessage(res.error)}`)
          const fileWrites = Array.isArray(res && res.writes) ? res.writes : []
          for (const w of fileWrites) {
            if (w && typeof w.text === 'string') writes.push({ target: w.target || src.target, text: w.text, action: 'update' })
          }
          files.push({
            target: src.target,
            path: src.path,
            exists: true,
            changed: fileWrites.length > 0,
            stats: (res && res.stats) || { relabeled: 0, tagged: 0, converged: 0, skipped: [] },
          })
        }
        const results = apply ? await applyWrites(anchor, writes) : []
        const totals = files.reduce((acc, f) => {
          const st = f.stats || {}
          acc.relabeled += st.relabeled || 0
          acc.tagged += st.tagged || 0
          acc.converged += st.converged || 0
          return acc
        }, { relabeled: 0, tagged: 0, converged: 0 })
        return { applied: apply, files, totals, writes: results, changed: files.filter((f) => f.changed).length }
      })
    },

    /** 模型工具 restart：重写该条目所在文件以触发配置重应用（不承诺进程重启，N2）。 */
    async restart(payload) {
      return withOpLock(async () => {
        const { anchor, sources } = await snapshot()
        const id = requireId(payload)
        const targets = sourcesWithId(sources, id)
        if (targets.length === 0) throw new ServiceError('not-found', `未找到条目 ${id}`)
        const rewritten = []
        for (const src of targets) {
          const { backup } = await writePatchFile(src.path, src.text)
          rewritten.push({ target: src.target, path: src.path, backedUp: backup })
        }
        return { id, rewritten, note: '已重写条目所在文件以触发配置重应用；不承诺进程已重启。' }
      })
    },
  }
}

// ═══════════════════════════ HTTP 层（§2.4） ═══════════════════════════

function headerOf(req, name) {
  const headers = req && req.headers ? req.headers : {}
  const value = headers[name] ?? headers[name.toLowerCase()] ?? headers[name.toUpperCase()]
  if (Array.isArray(value)) return value[0]
  return value === undefined || value === null ? null : String(value)
}

/** 同源判定：Host 完全相同，或双方都是回环地址且端口相同。 */
function isSameOrigin(origin, host) {
  if (!host) return false
  let parsed
  try {
    parsed = new URL(origin)
  } catch {
    return false
  }
  if (parsed.host === host) return true
  const loopback = (h) => ['127.0.0.1', 'localhost', '::1', '[::1]'].includes(String(h).replace(/:\d+$/, '').toLowerCase())
  const port = (h) => { const m = String(h).match(/:(\d+)$/); return m ? m[1] : '' }
  return loopback(parsed.host) && loopback(host) && port(parsed.host) === port(host)
}

async function readBody(req, max) {
  const declared = Number(headerOf(req, 'content-length'))
  if (Number.isFinite(declared) && declared > max) {
    const err = new Error(`body 超过 ${max} 字节上限`)
    err.code = 'body-too-large'
    throw err
  }
  if (!req || typeof req[Symbol.asyncIterator] !== 'function') {
    const inline = req && typeof req.body === 'string' ? req.body : ''
    return inline ? JSON.parse(inline) : {}
  }
  const chunks = []
  let total = 0
  for await (const chunk of req) {
    const buf = Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk)
    total += buf.length
    if (total > max) {
      const err = new Error(`body 超过 ${max} 字节上限`)
      err.code = 'body-too-large'
      throw err
    }
    chunks.push(buf)
  }
  const raw = Buffer.concat(chunks).toString('utf8')
  if (raw.trim() === '') return {}
  try {
    return JSON.parse(raw)
  } catch {
    const err = new Error('请求体不是合法 JSON')
    err.code = 'bad-json'
    throw err
  }
}

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  try {
    if (res && typeof res.writeHead === 'function') {
      res.writeHead(status, { 'content-type': 'application/json; charset=utf-8', 'cache-control': 'no-store' })
    }
    if (res && typeof res.end === 'function') res.end(body)
  } catch (err) {
    HOST_DIAG.lastError = `sendJson: ${errText(err)}`
  }
}

function normalizeAction(body) {
  const raw = firstString(body && body.action, body && body.endpoint, body && body.op)
  if (!raw) return { action: null, payload: {} }
  const exact = ENDPOINT_NAMES.find((n) => n === raw)
  const action = exact || ENDPOINT_NAMES.find((n) => n.toLowerCase() === raw.toLowerCase()) || null
  const payload = body && typeof body.payload === 'object' && body.payload !== null ? body.payload : {}
  // 扁平写法兜底：`{action:'tools', id:'x'}` —— 只在没有 payload（或 payload 为空）时把顶层其余键当参数。
  if (Object.keys(payload).length === 0 && body && typeof body === 'object') {
    for (const [key, value] of Object.entries(body)) {
      if (key === 'action' || key === 'endpoint' || key === 'op' || key === 'payload') continue
      payload[key] = value
    }
  }
  return { action, payload, raw }
}

/** 端点分发表（每个端点只依赖服务层的同名方法）。 */
function dispatch(svc, action, payload) {
  switch (action) {
    case 'list': return svc.list(payload)
    case 'add': return svc.add(payload)
    case 'update': return svc.update(payload)
    case 'remove': return svc.remove(payload)
    case 'setEnabled': return svc.setEnabled(payload)
    case 'setMatrix': return svc.setMatrix(payload)
    case 'getDefaults': return svc.getDefaults(payload)
    case 'setDefaults': return svc.setDefaults(payload)
    case 'probe': return svc.probe(payload)
    case 'migrate': return svc.migrate(payload)
    case 'patchInfo': return svc.patchInfo(payload)
    case 'tools': return svc.tools(payload)
    default: throw new ServiceError('unknown-action', `未知端点：${action || '(空)'}`, { action: `支持：${ENDPOINT_NAMES.join(' | ')}` })
  }
}

function statusForError(code) {
  switch (code) {
    case 'forbidden-header':
    case 'forbidden-origin': return 403
    case 'body-too-large': return 413
    case 'method-not-allowed': return 405
    case 'bad-json': return 400
    default: return 200
  }
}

/**
 * 功能作用：构造 HTTP handler（真 handler，测试里直接喂假 req/res）。
 *          门：POST + `x-dsh-plugin: dsh-mcp-manager` + 同源（Origin 缺失或与 Host 同源）+ body ≤ 1 MiB。
 * 参数：ctx。
 * 返回值：(req, res) => Promise<void>。
 */
function makeHandler(ctx) {
  const svc = createService(ctx)
  return async function handler(req, res) {
    try {
      const method = String((req && req.method) || 'GET').toUpperCase()
      if (method === 'OPTIONS') return sendJson(res, 403, fail('forbidden-origin', '预检请求未授权'))
      if (method !== 'POST') return sendJson(res, 405, fail('method-not-allowed', '仅支持 POST'))
      const header = headerOf(req, HEADER_NAME)
      if (String(header || '').trim().toLowerCase() !== PLUGIN_ID) {
        return sendJson(res, 403, fail('forbidden-header', `缺少或错误的 ${HEADER_NAME} 头`))
      }
      const origin = headerOf(req, 'origin')
      const host = headerOf(req, 'host')
      if (origin && !isSameOrigin(origin, host)) {
        return sendJson(res, 403, fail('forbidden-origin', '跨源请求被拒绝'))
      }
      let body
      try {
        body = await readBody(req, MAX_BODY_BYTES)
      } catch (err) {
        const code = err && err.code === 'body-too-large' ? 'body-too-large' : 'bad-json'
        return sendJson(res, statusForError(code), fail(code, errText(err)))
      }
      const { action, payload, raw } = normalizeAction(body)
      try {
        const data = await dispatch(svc, action, payload)
        return sendJson(res, 200, { ok: true, data })
      } catch (err) {
        const code = err instanceof ServiceError ? err.code : 'internal'
        const fields = err instanceof ServiceError ? err.fields : null
        HOST_DIAG.lastError = `${raw || action || '?'}: ${errText(err)}`
        if (code !== 'unknown-action' && code !== 'bad-request') writeDiag(STATE.anchor && STATE.anchor.home)
        return sendJson(res, statusForError(code), fail(code, errText(err), fields))
      }
    } catch (err) {
      HOST_DIAG.lastError = `handler: ${errText(err)}`
      return sendJson(res, 200, fail('internal', errText(err)))
    }
  }
}

/**
 * 功能作用：挂载精确路由。`ctx.get('webServer')` 在服务缺失时返回 null（不是 undefined），
 *          首次拿不到就留 `ctx.inject(['webServer'])` 兜底；注册抛错（如插件被加载两次 →
 *          `webserver: duplicate route`）就地捕获写诊断，**绝不让 effect 抛出拖垮 apply**。
 * 参数：ctx。
 * 返回值：true=已挂载。
 */
function mountHttp(ctx) {
  let started = false
  const mount = (host) => {
    if (started) return
    if (!host || typeof host.register !== 'function') return
    started = true
    const handler = makeHandler(ctx)
    try {
      ctx.effect(() => {
        try {
          const disposer = host.register({ kind: 'exact', path: API_PATH, handler })
          HOST_DIAG.httpRegistered = true
          HOST_DIAG.httpSkipped = null
          return typeof disposer === 'function' ? disposer : undefined
        } catch (err) {
          HOST_DIAG.httpRegistered = false
          HOST_DIAG.httpError = errText(err)
          HOST_DIAG.httpSkipped = `webServer.register 抛错：${errText(err)}`
          return undefined
        }
      })
    } catch (err) {
      HOST_DIAG.httpRegistered = false
      HOST_DIAG.httpError = errText(err)
      HOST_DIAG.httpSkipped = `ctx.effect 抛错：${errText(err)}`
    }
  }
  const ws = safeGet(ctx, 'webServer')
  mount(ws)
  if (!started && ctx && typeof ctx.inject === 'function') {
    try {
      ctx.inject(['webServer'], (sub) => mount(sub && sub.webServer ? sub.webServer : sub))
    } catch (err) {
      HOST_DIAG.httpSkipped = `ctx.inject 不可用：${errText(err)}`
    }
  }
  if (!started) {
    HOST_DIAG.httpRegistered = false
    HOST_DIAG.httpSkipped = HOST_DIAG.httpSkipped
      || (ws === null ? 'webServer 服务不可用' : 'webServer.register 不是函数')
    process.stderr.write(`dsh-mcp-manager: HTTP 路由未挂载：${HOST_DIAG.httpSkipped}\n`)
  }
  return started
}

// ═══════════════════════════ 模型工具（§2.6） ═══════════════════════════

const TOOL_SPECS = [
  {
    name: 'mcp_manager_list',
    description: '列出 DSH 里全部 MCP 服务器（id、serverName、transport、落点层、按 profile 的生效矩阵、静态状态、工具数估计）与全局默认参数。只读，不探测连接。',
    parameters: {},
    run: (svc) => svc.list({}),
  },
  {
    name: 'mcp_manager_set_enabled',
    description: '启用或停用一台 MCP 服务器：启用=全员生效（定义写 home 层、不带 disabled）；停用=home 层保留定义并加 disabled: true。',
    parameters: {
      id: { type: 'string', description: 'MCP 条目 id（如 mcp-Serena）', required: true },
      enabled: { type: 'boolean', description: 'true 启用 / false 停用', required: true },
    },
    run: (svc, args) => svc.setEnabled(args),
  },
  {
    name: 'mcp_manager_restart',
    description: '重写该条目所在补丁文件以触发 DSH 配置重应用（不承诺进程重启）。用于改完 config 后让 MCP 客户端重新加载。',
    parameters: {
      id: { type: 'string', description: 'MCP 条目 id', required: true },
    },
    run: (svc, args) => svc.restart(args),
  },
  {
    name: 'mcp_manager_add',
    description: '新增一台 MCP 服务器，并按生效矩阵写到 home 层或选中的 profile 层。缺省 matrix=全部 profile 生效。',
    parameters: {
      serverName: { type: 'string', description: 'MCP 服务名（^[A-Za-z0-9_-]{1,32}$，工具名前缀用它）', required: true },
      id: { type: 'string', description: '条目 id，缺省由 serverName 派生（mcp-<serverName>）' },
      config: { type: 'object', description: 'MCP 客户端 config：transport + （stdio: command/args/env/cwd | http: url/headers）+ toolCallTimeoutMs 等' },
      profiles: { type: 'array', description: '生效的 profile 名数组，缺省=全部', items: { type: 'string' } },
    },
    run: (svc, args) => svc.add(args),
  },
]

/**
 * 功能作用：`@deepseek-ai/dsh-tools` 可解析时注册 4 个模型工具；缺包/缺服务即跳过并写诊断（A8.3/A8.4）。
 *          每个工具的 execute 都返回 `{ ok, data }` / `{ ok:false, error }` 的 JSON 文本，
 *          与 HTTP 端点等价（同一服务层）。
 * 参数：ctx。
 * 返回值：无。
 */
async function registerTools(ctx) {
  let mod = null
  try {
    mod = await loadModule(TOOLS_PACKAGE)
  } catch (err) {
    HOST_DIAG.toolsSkipped = `无法解析 ${TOOLS_PACKAGE}：${errText(err)}`
    return
  }
  const defineTool = [
    mod && mod.defineTool,
    mod && mod.default && mod.default.defineTool,
  ].find((f) => typeof f === 'function')
  if (!defineTool) {
    HOST_DIAG.toolsSkipped = `${TOOLS_PACKAGE} 未导出 defineTool`
    return
  }
  const tools = safeGet(ctx, 'tools')
  if (!tools || typeof tools.register !== 'function') {
    HOST_DIAG.toolsSkipped = 'ctx.tools 服务不可用'
    return
  }
  const svc = createService(ctx)
  const defs = []
  for (const spec of TOOL_SPECS) {
    try {
      defs.push(defineTool({
        name: spec.name,
        description: spec.description,
        parameters: spec.parameters,
        execute: async (args) => {
          try {
            return JSON.stringify({ ok: true, data: await spec.run(svc, args && typeof args === 'object' ? args : {}) })
          } catch (err) {
            const code = err instanceof ServiceError ? err.code : 'internal'
            const fields = err instanceof ServiceError ? err.fields : null
            return JSON.stringify({ ok: false, error: { code, message: errText(err), fields } })
          }
        },
      }))
    } catch (err) {
      HOST_DIAG.toolsError = `${spec.name}: ${errText(err)}`
    }
  }
  if (defs.length === 0) {
    HOST_DIAG.toolsSkipped = HOST_DIAG.toolsError || 'defineTool 全部失败'
    return
  }
  try {
    ctx.effect(() => {
      const disposers = []
      for (const def of defs) {
        try {
          const disposer = tools.register(def)
          if (typeof disposer === 'function') disposers.push(disposer)
        } catch (err) {
          HOST_DIAG.toolsError = `register ${def && def.name}: ${errText(err)}`
        }
      }
      HOST_DIAG.toolsRegistered = defs.map((d) => d && d.name).filter(Boolean)
      return () => {
        for (const d of disposers) {
          try { d() } catch { /* best effort */ }
        }
      }
    })
  } catch (err) {
    HOST_DIAG.toolsError = `ctx.effect: ${errText(err)}`
  }
}

// ═══════════════════════════ 插件入口 ═══════════════════════════

/** 进程内状态：锚定结果与工具/路由锁存（热挂载会加载第二份实例，锁存各自独立）。 */
const STATE = { anchor: null, toolsLoaded: false }

export const name = PLUGIN_ID
/** 空注入：所有服务都用 `ctx.get` + `ctx.inject` 能力探测，缺服务也要能加载并写诊断。 */
export const inject = []

/**
 * 功能作用：插件入口。锚定 → 挂路由 → 注册模型工具 → 写诊断；**任何异常都就地捕获**。
 * 参数：ctx（cordis 上下文）。
 * 返回值：Promise<void>（永不 reject）。
 */
export async function apply(ctx) {
  freshDiag()
  try {
    STATE.anchor = await resolveAnchor(ctx)
    const anchor = STATE.anchor
    HOST_DIAG.home = anchor.home
    HOST_DIAG.profile = anchor.profile
    HOST_DIAG.profileDir = anchor.profileDir
    HOST_DIAG.profilePatchPath = anchor.homePatch
    HOST_DIAG.anchorSource = anchor.source
    HOST_DIAG.anchorErrors = anchor.errors
    if (!anchor.home) {
      process.stderr.write(`dsh-mcp-manager: 无法锚定 DSH home：${anchor.errors.join('; ') || '未知原因'}\n`)
    }

    // 1) HTTP 先行：面板的唯一传输（后面的诊断/探测失败都不能把它带走）。
    mountHttp(ctx)

    // 2) 模型工具（缺包即跳过）。
    try {
      await registerTools(ctx)
    } catch (err) {
      HOST_DIAG.toolsError = errText(err)
    }

    // 3) 诊断最后写。
    writeDiag(anchor.home)
  } catch (err) {
    HOST_DIAG.applyError = errText(err)
    try { writeDiag(STATE.anchor && STATE.anchor.home) } catch { /* best effort */ }
  }
}

export { API_PATH, PLUGIN_ID }

/**
 * 测试缝：真实 probe 执行器（离线测试只验证「SDK 不可解析 → 明确报错、不起任何进程、不挂起」）。
 * 生产路径不经由它导出，仅供 node:test 断言降级形状。
 */
export { realProbeRunner as __realProbeRunner }
