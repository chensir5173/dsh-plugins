// dsh-plugin-manager: HOST half.
//
// Runs in the `dsh web` process (unsandboxed Node). Exposes the management
// surface the browser panel calls:
//
//   GET  /__dsh-plugin-manager/status   — health/diagnostics
//   GET  /__dsh-plugin-manager/list     — repo scan + per-plugin profile state
//   POST /__dsh-plugin-manager/set-enabled  {dir, enabled}  — activate/disable
//   POST /__dsh-plugin-manager/remove        {dir}          — remove (row + devDep)
//   POST /__dsh-plugin-manager/migrate       {}             — one-click takeover
//   POST /__dsh-plugin-manager/repair        {}             — repair stale deps (alias: /relink)
//
// Activation model (design.md): the manager is the ONLY local bundle in the
// profile (`dsh.profile.bundles`); each managed dsh-* sibling is a profile
// devDependency written as the plain `workspace:*` spec (NEVER an absolute
// path) and gets a canonical stable-id insert row in profile cordis.patch.yml.
// The ONE path that remains — the plugin-root glob in <profile>/pnpm-workspace.yaml
// — is maintained by this host, so a repo that moved folder or machine repairs
// itself on the next start instead of failing with ERR_PNPM_WORKSPACE_PKG_NOT_FOUND.
// That patch file is live-watched by DSH's patch HMR (patchReload:'live'), so
// host-side rows start/stop immediately; client-side UI needs one page reload
// (the panel tells the user, never auto-reloads).
//
// Profile discovery: ctx.baseUrl is the profile directory file:URL (anchored on
// dirname(<profile>/cordis.yml) by the boot loader), so this host never needs
// to hardcode 'web' — it reads the directory it is actually running in.
//
// All file mutations are bracketed by timestamped backups of package.json and
// cordis.patch.yml. YAML round-trips use the profile's own js-yaml via
// createRequire(profile/package.json) — the profile uses pnpm's hoisted
// nodeLinker, so js-yaml (a transitive of dsh-mcp-manager) sits at the top of
// the profile's node_modules (verified on this machine).
//
// ESM module format (cordis bundle rule): named exports apply/inject/name.

import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import { createRequire } from 'node:module'
import { spawn } from 'node:child_process'

import {
  MANAGER_ID,
  DEFAULT_PROFILE,
  HTTP_PREFIX,
  INTENT_DEBOUNCE_MS,
  YAML_PKG,
  YAML_PKG_RANGE,
  WORKSPACE_FILE,
  applyIntents,
  upsertManagedMany,
  batchPlan,
  removePlan,
  mergeIntent,
  dshHome,
  profileDirOf,
  patchPathOf,
  manifestPathOf,
  repoRootOfPluginSrc,
  listRepoPluginDirs,
  readPluginMeta,
  readManifest,
  makeYamlEngine,
  readPatchRows,
  writePatchRows,
  removeManaged,
  deriveStates,
  planMigration,
  linkDepSpec,
  pluginsGlobOf,
  repairPlan,
  retireWorkspaceGlob,
  workspaceStateOf,
  pluginRootsOf,
} from './host-core.js'

const name = 'dsh-plugin-manager'
const inject = []

const HERE = path.dirname(fileURLToPath(import.meta.url))
const REPO_ROOT = repoRootOfPluginSrc(HERE)
/** Root actually scanned for plugin packages (sub-plugins/ when present). */
const PLUGINS_ROOT = pluginRootsOf(REPO_ROOT)[0]

/** Visible diagnostics for the /status endpoint. */
export const HOST_DIAG = {
  repoRoot: REPO_ROOT,
  pluginsRoot: PLUGINS_ROOT,
  profileName: DEFAULT_PROFILE,
  endpointsRegistered: false,
  yamlResolved: false,
  yamlError: null,
  /** Switch intents accepted but not yet written to the patch file. */
  pendingWrites: 0,
  /** Last debounced-flush failure (null when the last flush succeeded). */
  lastFlushError: null,
  /** Last 全部开启/全部关闭/全部移除 batch outcome (null until one runs). */
  lastBatch: null,
  /** Last automatic stale-link relink outcome (null until the host tried once). */
  autoRelink: null,
  /** Last relink (auto or panel) outcome. */
  lastRelink: null,
  /** Whether the automatic dependency-repair switch is on. */
  autoRelinkEnabled: true,
  /** Retired workspace-anchor (pnpm-workspace.yaml) view: { file, glob, ok, repoGlobs }. */
  workspace: null,
  /** Last automatic cleanup of retired workspace globs (null until one happens). */
  workspaceRepair: null,
}

// --- settings: the automatic relink switch (optional capability) -------------

/** Settings namespace / field (the client half mirrors these exact keys). */
export const SETTINGS_NS = 'dsh-plugin-manager'
export const AUTO_RELINK_FIELD = 'autoRelink'
/** Default: repair determinable stale links once per host start. */
export const DEFAULT_AUTO_RELINK = true

/** Host-side mirror of the switch, kept in sync by the settings provider. */
let __autoRelink = DEFAULT_AUTO_RELINK

/** One-shot latch: at most ONE automatic relink per host start (a failure burns it too). */
const AUTO_RELINK_LATCH = { done: false }

/**
 * 功能作用：零依赖的设置段 schema——宿主解析 bundle 的裸 specifier 走插件源码目录，
 *           link: 安装下 @deepseek-ai/schemastery 可能解析不到；此时仍要注册命名空间，
 *           否则客户端的 settings.update() 会被宿主拒绝（"namespace is not registered"）。
 * 参数：
 *   field: string -- 字段名，例 'autoRelink'
 *   fallback: boolean -- 默认值，例 true
 * 返回值：
 *   function -- 既是 schema 又带 toJSON()，例 schema({}) → { autoRelink: true }
 * 调用样例：
 *   register(fallbackSectionSchema(AUTO_RELINK_FIELD, DEFAULT_AUTO_RELINK))
 */
function fallbackSectionSchema(field, fallback) {
  const schema = (input) => {
    const source = (input && typeof input === 'object' && !Array.isArray(input)) ? input : {}
    const out = { ...source }
    out[field] = typeof source[field] === 'boolean' ? source[field] : fallback
    return out
  }
  schema.toJSON = () => ({ type: 'object', properties: { [field]: { type: 'boolean', default: fallback } } })
  return schema
}

/**
 * 功能作用：注册设置命名空间并跟踪开关值（可选能力；settings 缺席时静默跳过）。
 * 参数：
 *   ctx: object -- cordis 上下文（installSection 的 owner）
 *   settings: object -- settings 服务，例 { installSection(ctx, ns, Config, entry, hooks) }
 * 返回值：
 *   无
 * 调用样例：
 *   installSettingsSection(ctx, ctx.get('settings'))
 */
function installSettingsSection(ctx, settings) {
  if (!settings || typeof settings.installSection !== 'function') return
  const register = (Config) => {
    if (!Config) return
    settings.installSection(ctx, SETTINGS_NS, Config, { [AUTO_RELINK_FIELD]: DEFAULT_AUTO_RELINK }, {
      setSource(source) {
        try {
          const current = source()
          __autoRelink = current && typeof current === 'object'
            ? current[AUTO_RELINK_FIELD] !== false
            : DEFAULT_AUTO_RELINK
        } catch { /* source not ready yet */ }
        HOST_DIAG.autoRelinkEnabled = __autoRelink
      },
      onChange() { HOST_DIAG.autoRelinkEnabled = __autoRelink },
    })
  }
  Promise.resolve()
    .then(() => import('@deepseek-ai/schemastery'))
    .then((mod) => {
      const z = mod && mod.default
      if (!z || typeof z.object !== 'function' || typeof z.boolean !== 'function') {
        register(fallbackSectionSchema(AUTO_RELINK_FIELD, DEFAULT_AUTO_RELINK))
        return
      }
      register(z.object({ [AUTO_RELINK_FIELD]: z.boolean().default(DEFAULT_AUTO_RELINK) }))
    })
    .catch(() => register(fallbackSectionSchema(AUTO_RELINK_FIELD, DEFAULT_AUTO_RELINK)))
}


/**
 * 0.2.0 条目配置：插件自己的 profile 行就是设置命名空间。
 *
 * 0.2.0 退役了 `settings.installSection`；设置服务改为投影每个条目导出的 `Config`
 * （ns = **条目 id**），对其它 ns 一律抛 `No configurable plugin entry`。link: 宿主半
 * 解析不到 `@deepseek-ai/schemastery`（实测 ERR_MODULE_NOT_FOUND），所以 schema 手写：
 *   - cordis `resolveConfig` → `Config[~standard].validate(raw)`；
 *   - 设置服务 → `meta.volatile` + `toJSON()`（真实 schemastery 的 refs 表）；
 *   - loader diff → `~standard.vendor`：**故意不叫 schemastery**，让写配置走普通路径
 *     （条目重启 → apply(ctx, config) 拿到新值），而不是我们表达不了的 volatile 原地提交。
 * 校验保持**宽松**：本行的 config 还带着 repoRoot/pluginsRoot/profile 等安装参数，
 * 任何未声明的键都原样透传。
 */
const CONFIG_SCHEMA_JSON = Object.freeze({"uid":3,"refs":{"1":{"type":"boolean","meta":{"default":true}},"3":{"type":"object","meta":{"default":{},"volatile":true},"dict":{"autoRelink":1}}}})

/** 归一化条目配置：只认领 autoRelink，其余键原样保留。 */
export function normalizeEntryConfig(input) {
  const source = (input && typeof input === 'object' && !Array.isArray(input)) ? input : {}
  const raw = source[AUTO_RELINK_FIELD]
  return Object.assign({}, source, { [AUTO_RELINK_FIELD]: typeof raw === 'boolean' ? raw : DEFAULT_AUTO_RELINK })
}

/** 导出给 loader / 设置服务（见上面的块注释）。 */
function entryConfigSchema() {
  const schema = (input) => normalizeEntryConfig(input)
  schema.meta = { volatile: true }
  schema.type = 'object'
  schema.toJSON = () => JSON.parse(JSON.stringify(CONFIG_SCHEMA_JSON))
  schema['~standard'] = {
    version: 1,
    vendor: 'dsh-plugin-manager',
    validate(value) {
      try { return { value: normalizeEntryConfig(value) } }
      catch (error) { return { issues: [{ message: (error && error.message) ? error.message : String(error) }] } }
    },
  }
  return schema
}

/** 导出的 Config（loader 读 runtime.Config；设置服务据此把本行变成可配置条目）。 */
export const Config = entryConfigSchema()
// --- tiny HTTP helpers -------------------------------------------------------

function sendJson(res, status, obj) {
  const body = JSON.stringify(obj)
  try {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
    })
    res.end(body)
  } catch { /* connection already gone */ }
}

function readBody(req) {
  return new Promise((resolve, reject) => {
    let data = ''
    req.on('data', (d) => {
      data += d
      if (data.length > 1e6) req.destroy()
    })
    req.on('end', () => resolve(data))
    req.on('error', reject)
    req.on('aborted', () => reject(new Error('aborted')))
  })
}

// --- pnpm --------------------------------------------------------------------

/** Spawn pnpm in the profile dir (Windows needs the .cmd shim → shell). */
function execPnpm(profileDir, args, timeoutMs = 180000) {
  return new Promise((resolve) => {
    const child = spawn('pnpm', args, {
      cwd: profileDir,
      shell: process.platform === 'win32',
      windowsHide: true,
    })
    let stdout = ''
    let stderr = ''
    child.stdout.on('data', (d) => { stdout += d })
    child.stderr.on('data', (d) => { stderr += d })
    const timer = setTimeout(() => { child.kill() }, timeoutMs)
    child.on('error', (err) => {
      clearTimeout(timer)
      resolve({ ok: false, code: 1, error: String(err.message || err), stdout, stderr })
    })
    child.on('close', (code) => {
      clearTimeout(timer)
      resolve({ ok: code === 0, code: code == null ? 1 : code, error: code === 0 ? null : (stderr.trim() || stdout.trim()), stdout, stderr })
    })
  })
}

/**
 * 功能作用：真正执行 pnpm 的函数（模块级变量，便于测试替换成桩）。
 * 参数：
 *   profileDir: string -- 目标 profile 目录，例如 'C:/Users/x/.dsh/profiles/web'
 *   args: string[] -- pnpm 参数，例如 ['install']
 *   timeoutMs?: number -- 超时毫秒数，默认 180000
 * 返回值：
 *   Promise<{ ok: boolean, code: number, error: string|null, stdout: string, stderr: string }>
 * 调用样例：
 *   const res = await pnpmRunner(profileDir, ['install'])
 */
let pnpmRunner = execPnpm

/**
 * 功能作用：替换 pnpm 执行器（仅测试使用：真实 handler harness 里避免真的跑 pnpm）。
 * 参数：fn: Function|null -- 新的执行器；传 null/非函数恢复默认实现
 * 返回值：undefined
 * 调用样例：__setPnpmRunner(async () => ({ ok: true, code: 0, error: null, stdout: '', stderr: '' }))
 */
export function __setPnpmRunner(fn) {
  pnpmRunner = typeof fn === 'function' ? fn : execPnpm
}

function backupFile(file) {
  const stamp = new Date().toISOString().replace(/[:.]/g, '-')
  const dest = `${file}.bak-${stamp}`
  fs.copyFileSync(file, dest)
  return dest
}

function writeJsonPretty(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, `${JSON.stringify(obj, null, 2)}\n`, 'utf8')
}

// --- resolution --------------------------------------------------------------

/**
 * Resolve the context the manager operates on. Profile directory comes from the
 * running loader's ctx.baseUrl (file URL of <profile>/), falling back to
 * $DSH_HOME/profiles/<config.profile || 'web'> when no web surface exists.
 */
function resolveContext(config, baseUrl) {
  const home = dshHome()
  let profileDir = null
  let profileName = config && typeof config.profile === 'string' && config.profile.trim() !== ''
    ? config.profile.trim()
    : null
  if (baseUrl) {
    try {
      profileDir = fileURLToPath(baseUrl)
    } catch { profileDir = null }
  }
  if (!profileDir) profileDir = profileDirOf(home, profileName || DEFAULT_PROFILE)
  if (!profileName) profileName = path.basename(profileDir)
  return {
    home,
    profileName,
    profileDir,
    patchFile: patchPathOf(home, profileName),
    manifestFile: manifestPathOf(home, profileName),
    workspaceFile: path.join(profileDir, WORKSPACE_FILE),
    repoRoot: REPO_ROOT,
    pluginsRoot: PLUGINS_ROOT,
  }
}

/** Resolve the profile's own js-yaml through createRequire(profile package). */
function requireProfileYaml(profileDir) {
  try {
    const req = createRequire(path.join(profileDir, 'package.json'))
    const jsyaml = req(YAML_PKG)
    if (jsyaml && typeof jsyaml.load === 'function' && typeof jsyaml.dump === 'function') {
      return { jsyaml, error: null }
    }
    return { jsyaml: null, error: `${YAML_PKG} did not load from profile node_modules` }
  } catch (e) {
    return { jsyaml: null, error: (e && (e.message || e.code)) || String(e) }
  }
}

async function ensureYaml(profileDir) {
  const first = requireProfileYaml(profileDir)
  if (first.jsyaml) return { engine: makeYamlEngine(first.jsyaml), error: null, installed: false }
  const res = await pnpmRunner(profileDir, ['add', '-D', `${YAML_PKG}@${YAML_PKG_RANGE}`])
  if (!res.ok) return { engine: null, error: `js-yaml unavailable and install failed: ${res.error || res.stderr}` }
  const second = requireProfileYaml(profileDir)
  if (!second.jsyaml) return { engine: null, error: `js-yaml still unavailable after install: ${second.error}` }
  return { engine: makeYamlEngine(second.jsyaml), error: null, installed: true }
}

function readPlugins(repoRoot) {
  return listRepoPluginDirs(repoRoot).map((dir) => readPluginMeta(repoRoot, dir))
}

// --- retired workspace anchor (pnpm-workspace.yaml) -------------------------
//
// Older builds declared managed siblings as `workspace:*` devDependencies and
// pointed one glob in <profile>/pnpm-workspace.yaml at this repository. pnpm
// refuses workspace members that live under node_modules, so a git-installed
// manager could never resolve them (ERR_PNPM_WORKSPACE_PKG_NOT_FOUND). Sibling
// specs are now relative `link:` paths (see linkDepSpec in host-core) and the
// anchor is retired: a glob that still points at this repository's shape is
// stripped so the stale entry cannot break the next install. Unrelated globs
// (packages/*, apps/*) are kept, and an already clean file is never rewritten.

/** Read the profile's pnpm-workspace.yaml (missing/unreadable → empty document). */
function readWorkspaceDoc(c) {
  const probe = requireProfileYaml(c.profileDir)
  if (!probe.jsyaml) return { doc: {}, engine: null, error: probe.error }
  const engine = makeYamlEngine(probe.jsyaml)
  let text = ''
  try {
    if (fs.existsSync(c.workspaceFile)) text = fs.readFileSync(c.workspaceFile, 'utf8')
  } catch { text = '' }
  if (text.trim() === '') return { doc: {}, engine, error: null }
  try {
    return { doc: engine.loadDoc(text), engine, error: null }
  } catch (e) {
    return { doc: {}, engine, error: WORKSPACE_FILE + ' 解析失败：' + ((e && e.message) || e) }
  }
}

/** Anchor snapshot: parsed document + evaluated retirement state (no writes). */
function workspaceSnapshot(c) {
  const read = readWorkspaceDoc(c)
  const state = workspaceStateOf(read.doc, c.repoRoot)
  return { doc: read.doc, engine: read.engine, error: read.error, state }
}

/**
 * 功能作用：清理 profile 的 pnpm-workspace.yaml 里指向本仓库的残留 workspace 锚点——幂等，
 *           已干净时零写入；需要删条目时先备份再整体重写（YAML 注释不会保留，故只在必要时写）。
 * 参数：c: object -- resolveContext() 的结果（用到 workspaceFile / profileDir / repoRoot）
 * 返回值：{ changed, error, glob, backup, removed }
 */
function ensureWorkspaceRetired(c) {
  const snap = workspaceSnapshot(c)
  const glob = snap.state.glob
  if (!snap.engine) return { changed: false, error: snap.error, glob, backup: null, removed: [] }
  const next = retireWorkspaceGlob(snap.doc, c.repoRoot)
  HOST_DIAG.workspace = { file: c.workspaceFile, glob, ok: next.state.ok, repoGlobs: next.state.repoGlobs }
  if (!next.changed) return { changed: false, error: null, glob, backup: null, removed: [] }
  let backup = null
  try { if (fs.existsSync(c.workspaceFile)) backup = backupFile(c.workspaceFile) } catch { backup = null }
  try {
    fs.mkdirSync(path.dirname(c.workspaceFile), { recursive: true })
    fs.writeFileSync(c.workspaceFile, snap.engine.dumpDoc(next.doc), 'utf8')
  } catch (e) {
    return { changed: false, error: `写入 ${WORKSPACE_FILE} 失败：${(e && e.message) || e}`, glob, backup, removed: [] }
  }
  HOST_DIAG.workspaceRepair = { at: Date.now(), removed: next.removed, backup }
  HOST_DIAG.workspace = { file: c.workspaceFile, glob, ok: true, repoGlobs: [] }
  return { changed: true, error: null, glob, backup, removed: next.removed }
}

// --- pending switch intents (debounced patch writes) -------------------------
//
// ONE patch-file write costs DSH core a full config-tree re-application that
// blocks the host event loop — measured 681 / 797 / 1021 / 1184 ms with a 5 ms
// /status probe, while the same write with identical bytes costs nothing (core
// short-circuits unchanged config). Switch requests therefore merge here for
// INTENT_DEBOUNCE_MS and reach disk as ONE write: N clicks = one write = one
// re-application. Responses overlay the queued intents (see snapshot), so the
// panel shows the requested state immediately without waiting for the flush.

/** Queued {id, name, enabled} switch intents; [] once everything is persisted. */
let pendingIntents = []
let flushTimer = null
let flushChain = Promise.resolve()

function queueIntent(intent) {
  pendingIntents = mergeIntent(pendingIntents, intent)
  HOST_DIAG.pendingWrites = pendingIntents.length
}

function scheduleFlush(ctx, config) {
  if (flushTimer) clearTimeout(flushTimer)
  flushTimer = setTimeout(() => {
    flushTimer = null
    flushChain = flushChain.then(() => flushPending(ctx, config)).catch(() => {})
  }, INTENT_DEBOUNCE_MS)
}

/**
 * Write every queued intent in one pass, re-reading the disk rows first so a
 * concurrent writer (hand edit, another tool) is never clobbered by a copy we
 * captured earlier in the debounce window.
 */
async function flushPending(ctx, config) {
  if (pendingIntents.length === 0) return
  const intents = pendingIntents
  pendingIntents = []
  HOST_DIAG.pendingWrites = 0
  const c = resolveContext(config, ctx && ctx.baseUrl)
  const y = await ensureYaml(c.profileDir)
  if (!y.engine) {
    HOST_DIAG.lastFlushError = y.error
    return
  }
  HOST_DIAG.yamlResolved = true
  HOST_DIAG.yamlError = null
  try {
    const rows = upsertManagedMany(readPatchRows(y.engine, c.patchFile), intents)
    writePatchRows(y.engine, c.patchFile, rows)
    HOST_DIAG.lastFlushError = null
  } catch (e) {
    // Loud, and disk truth wins: the intents are dropped so the next /list
    // reports what is actually on disk instead of a state that never landed.
    HOST_DIAG.lastFlushError = (e && e.message) || String(e)
  }
}

/** Best-effort synchronous flush for the dispose path (host shutting down). */
function flushPendingSync(c) {
  if (pendingIntents.length === 0) return
  const intents = pendingIntents
  try {
    const probe = requireProfileYaml(c.profileDir)
    if (!probe.jsyaml) return
    const engine = makeYamlEngine(probe.jsyaml)
    const rows = upsertManagedMany(readPatchRows(engine, c.patchFile), intents)
    writePatchRows(engine, c.patchFile, rows)
    pendingIntents = []
    HOST_DIAG.pendingWrites = 0
    HOST_DIAG.lastFlushError = null
  } catch (e) {
    HOST_DIAG.lastFlushError = (e && e.message) || String(e)
  }
}

/**
 * 功能作用：读一次磁盘现场（仓库扫描 + profile manifest + patch 行）并推导每个子插件的状态。
 * 参数：
 *   ctx: object -- DSH 插件上下文（取 ctx.baseUrl 定位 profile）
 *   config: object -- 插件行 config（可用 profile 覆盖）
 *   extraIntents?: Array -- 显式指定「视作已生效」的待写意图；默认用模块级 pendingIntents。
 *                          批量开关会先接管队列再计算，所以需要显式传入它刚取走的意图。
 * 返回值：
 *   { c, manifest, rows, plugins, derived, legacyDetected, yamlError }
 * 调用样例：
 *   const s = snapshot(ctx, cfg)                       // 常规路径（含排队意图）
 *   const s2 = snapshot(ctx, cfg, queuedIntents)       // 批量：队列已被自己取走
 */
function snapshot(ctx, config, extraIntents) {
  const c = resolveContext(config, ctx && ctx.baseUrl)
  const plugins = readPlugins(c.repoRoot)
  const manifest = readManifest(c.manifestFile)
  const yaml = requireProfileYaml(c.profileDir)
  const rows = yaml.jsyaml ? readPatchRows(makeYamlEngine(yaml.jsyaml), c.patchFile) : []
  // Queued intents are what the user asked for: report them as the current
  // state (the flush makes them durable a few hundred ms later).
  const intents = Array.isArray(extraIntents) ? extraIntents : pendingIntents
  const wsSnap = workspaceSnapshot(c)
  const derived = deriveStates({ repoPlugins: plugins, manifest, rows: applyIntents(rows, intents), profileDir: c.profileDir })
  const legacyDetected = derived.some((p) => p.legacyBundle)
  return { c, manifest, rows, plugins, derived, legacyDetected, yamlError: yaml.error, workspace: wsSnap }
}

/**
 * 功能作用：把一次快照转成 /list 的响应体，并顺带算出两个批量按钮的可作用数量与跳过数量。
 * 参数：s: object -- snapshot() 的结果
 * 返回值：{ ok: true, data: { ..., plugins, batchCounts } }；batchCounts.enable/disable/remove = { count, skippedLegacy, skippedInactive, skippedInvalid }（remove 的口径来自 removePlan）
 * 调用样例：sendJson(res, 200, listPayload(snapshot(ctx, cfg)))
 */
function batchCountsOf(derived) {
  /** 同一个 batchPlan 口径算出某一方向的「可作用数 + 分类跳过数」。 */
  const one = (enabled) => {
    const plan = batchPlan(derived, enabled)
    const byReason = (reason) => plan.skipped.filter((x) => x.reason === reason).length
    return {
      count: plan.count,
      needsInstall: plan.targets.filter((t) => t.needsInstall).length,
      skippedLegacy: byReason('legacy-layout'),
      skippedInactive: byReason('inactive-dep-only'),
      skippedInvalid: byReason('invalid-dir'),
    }
  }
  // 「全部移除」的 N 口径来自 removePlan（有痕迹才计数），跳过原因词表也不同。
  const removePlanCounts = (() => {
    const plan = removePlan(derived)
    const byReason = (reason) => plan.skipped.filter((x) => x.reason === reason).length
    return {
      count: plan.count,
      needsInstall: 0,
      skippedLegacy: byReason('legacy-layout'),
      skippedInactive: 0,
      skippedInvalid: byReason('invalid-dir'),
    }
  })()
  return { enable: one(true), disable: one(false), remove: removePlanCounts }
}

/**
 * 功能作用：拼出面板要展示/复制的"一键卸载"命令——脚本随包分发，路径按当前安装位置拼；
 *           命令显式带 --profile 与 --yes（脚本默认干跑，避免误执行）。
 * 参数：
 *   c: object -- resolveContext() 的结果（用到 profileName）
 * 返回值：
 *   string -- 可直接粘贴的命令
 * 调用样例：
 *   const cmd = uninstallCommandOf(c)
 */
function uninstallCommandOf(c) {
  const script = path.join(REPO_ROOT, 'dsh-plugin-manager', 'tools', 'uninstall-manager.mjs')
  return 'node "' + script + '" --profile ' + c.profileName + ' --yes'
}

/**
 * 功能作用：把快照里已知的事实翻成"这条命令会删除什么"的只读预览（与脚本 planUninstall 同口径的近似），
 *           供面板在复制前告知用户；不写文件、不执行安装。
 * 参数：
 *   s: object -- 宿主半快照（derived / manifest）
 * 返回值：
 *   { rows, deps, managerEntry, installs }
 * 调用样例：
 *   const preview = uninstallPreviewOf(s)
 */
function uninstallPreviewOf(s) {
  const derived = Array.isArray(s.derived) ? s.derived : []
  const rows = derived.filter((p) => p && p.hasRow === true).length
  const deps = derived.filter((p) => p && p.installed === true).length
  const bundles = s.manifest && s.manifest.dsh && s.manifest.dsh.profile && s.manifest.dsh.profile.bundles
  const managerEntry = Array.isArray(bundles) && bundles.includes(MANAGER_ID)
  return { rows, deps, managerEntry, installs: rows > 0 || deps > 0 || managerEntry }
}

function listPayload(s) {
  return {
    ok: true,
    data: {
      repoRoot: s.c.repoRoot,
      pluginsRoot: s.c.pluginsRoot,
      profileName: s.c.profileName,
      profileDir: s.c.profileDir,
      patchFile: s.c.patchFile,
      managerId: MANAGER_ID,
      legacyDetected: s.legacyDetected,
      yamlError: s.yamlError,
      plugins: s.derived,
      batchCounts: batchCountsOf(s.derived),
      // Dependency-repair face: what the panel banner renders and what the
      //「修复依赖」按钮 posts back. auto = repairable (legacy link: spec or a
      // missing workspace glob); manual = the plugin directory itself is gone.
      repairPlan: (() => {
        const plan = repairPlan(s.derived)
        return { count: plan.count, manualCount: plan.manualCount, auto: plan.auto, manual: plan.manual }
      })(),
      // Retired workspace anchor: a glob left over from older builds must be gone.
      workspace: s.workspace ? {
        file: s.workspace.state.file,
        path: s.c.workspaceFile,
        glob: s.workspace.state.glob,
        ok: s.workspace.state.ok,
        packages: s.workspace.state.packages,
        repoGlobs: s.workspace.state.repoGlobs,
        error: s.workspace.error || null,
      } : null,
      autoRelink: HOST_DIAG.autoRelink,
      autoRelinkEnabled: __autoRelink === true,
      // Self-uninstall face: the command the panel offers to copy (never executed
      // here) plus a read-only preview of what it would remove.
      uninstall: {
        command: uninstallCommandOf(s.c),
        willRemove: uninstallPreviewOf(s),
      },
    },
  }
}

// --- actions -----------------------------------------------------------------

async function ensureDevDep(c, meta) {
  const manifest = readManifest(c.manifestFile)
  const inDeps = Object.prototype.hasOwnProperty.call(manifest.dependencies || {}, meta.name)
  const spec = (manifest.devDependencies || {})[meta.name]
  const expected = linkDepSpec(c.profileDir, meta)
  // 就位 = profile 的 devDependency 恰好是期望的相对 link: 规格；旧的 workspace:* 键和遗留的
  // 绝对 link: 规格都会被改写成它（这就是老 profile 迁到相对规格的那一步）。
  const ready = !inDeps && expected !== null && spec === expected
  const ws = ensureWorkspaceRetired(c)
  if (ws.error) return { installed: false, ranPnpm: false, error: ws.error, glob: ws.glob }
  if (ready && !ws.changed) return { installed: true, ranPnpm: false, error: null, glob: ws.glob }
  if (expected === null) {
    return { installed: false, ranPnpm: false, error: `无法为 ${meta.name} 生成依赖规格：插件目录缺失`, glob: ws.glob }
  }
  const backup = backupFile(c.manifestFile)
  const manifest2 = { ...manifest }
  manifest2.dependencies = { ...(manifest.dependencies || {}) }
  delete manifest2.dependencies[meta.name]
  manifest2.devDependencies = { ...(manifest.devDependencies || {}), [meta.name]: expected }
  writeJsonPretty(c.manifestFile, manifest2)
  const res = await pnpmRunner(c.profileDir, ['install'])
  if (!res.ok) {
    try { fs.copyFileSync(backup, c.manifestFile) } catch { /* best effort */ }
    return { installed: false, ranPnpm: true, error: res.error || 'pnpm install failed' }
  }
  return { installed: true, ranPnpm: true, error: null, backup, glob: ws.glob, workspaceChanged: ws.changed }
}
/**
 * 功能作用：批量确保多个子插件可解析——先清掉 profile 里指向本仓库的残留 workspace 锚点，
 *           再把缺失或仍是旧协议的 devDependency 一次性写成期望的相对 link: 规格，
 *           然后只执行一次 pnpm install（批量开启时用；逐项安装会 N 次改写 + N 次安装，慢且没必要）。
 * 参数：
 *   c: object -- resolveContext() 的结果（用到 manifestFile / profileDir / repoRoot / workspaceFile）
 *   entries: Array -- [{ name, dir, dirPath }]，例如 [{ name: 'dsh-esc-rewind', dir: 'dsh-esc-rewind' }]
 * 返回值：
 *   { installed: string[], failed: [{ name, error }], ranPnpm: boolean, backup: string|null, workspaceChanged: boolean }
 *   例：{ installed: ['dsh-aaa'], failed: [], ranPnpm: true, backup: '.../package.json.bak-...', workspaceChanged: false }
 * 调用样例：
 *   const ins = await ensureDevDeps(c, needInstall.map((t) => ({ name: t.name, dir: t.dir })))
 */
async function ensureDevDeps(c, entries) {
  const wanted = (Array.isArray(entries) ? entries : []).filter((e) => e && e.name)
  const expectedOf = (e) => linkDepSpec(c.profileDir, { name: e.name, dir: e.dir, dirPath: e.dirPath })
  const ws = ensureWorkspaceRetired(c)
  if (ws.error) {
    return { installed: [], failed: wanted.map((e) => ({ name: e.name, error: ws.error })), ranPnpm: false, backup: null, workspaceChanged: false }
  }

  const manifest = readManifest(c.manifestFile)
  const next = { ...manifest }
  next.dependencies = { ...(manifest.dependencies || {}) }
  next.devDependencies = { ...(manifest.devDependencies || {}) }
  const changed = []
  for (const e of wanted) {
    const expected = expectedOf(e)
    if (!expected) continue
    const already = next.devDependencies[e.name] === expected
      && !Object.prototype.hasOwnProperty.call(next.dependencies, e.name)
    if (already) continue
    delete next.dependencies[e.name]
    next.devDependencies[e.name] = expected
    changed.push(e.name)
  }
  // 依赖键都已就位、锚点也没动过 → 无需改写也无需安装，直接视为可解析。
  if (changed.length === 0 && !ws.changed) {
    return { installed: wanted.map((e) => e.name), failed: [], ranPnpm: false, backup: null, workspaceChanged: false }
  }
  // 只清理了残留锚点、没有依赖要写：不跑 install（缺锚点时旧协议键本来就装不回来）。
  if (changed.length === 0) {
    return { installed: wanted.map((e) => e.name), failed: [], ranPnpm: false, backup: null, workspaceChanged: true }
  }

  const backup = backupFile(c.manifestFile)
  writeJsonPretty(c.manifestFile, next)
  const res = await pnpmRunner(c.profileDir, ['install'])
  if (!res.ok) {
    try { fs.copyFileSync(backup, c.manifestFile) } catch { /* best effort */ }
    const error = res.error || 'pnpm install failed'
    return { installed: [], failed: wanted.map((e) => ({ name: e.name, error })), ranPnpm: true, backup, workspaceChanged: ws.changed }
  }
  return { installed: wanted.map((e) => e.name), failed: [], ranPnpm: true, backup, workspaceChanged: ws.changed }
}

async function dropDevDep(c, pkgName) {
  const manifest = readManifest(c.manifestFile)
  const hadDep = Object.prototype.hasOwnProperty.call(manifest.dependencies || {}, pkgName)
  const hadDev = Object.prototype.hasOwnProperty.call(manifest.devDependencies || {}, pkgName)
  if (!hadDep && !hadDev) return { removed: true, ranPnpm: false, error: null }
  const backup = backupFile(c.manifestFile)
  const manifest2 = { ...manifest }
  manifest2.dependencies = { ...(manifest.dependencies || {}) }
  manifest2.devDependencies = { ...(manifest.devDependencies || {}) }
  delete manifest2.dependencies[pkgName]
  delete manifest2.devDependencies[pkgName]
  writeJsonPretty(c.manifestFile, manifest2)
  const res = await pnpmRunner(c.profileDir, ['install'])
  if (!res.ok) {
    try { fs.copyFileSync(backup, c.manifestFile) } catch { /* best effort */ }
    return { removed: false, ranPnpm: true, error: res.error || 'pnpm install failed' }
  }
  return { removed: true, ranPnpm: true, error: null, backup }
}

/**
 * 功能作用：批量摘除多个子插件的依赖键（「全部移除」用）——一次读 manifest、一次备份、一次改写、
 *           一次 pnpm install，失败整体回滚；与 ensureDevDeps 形态对称（逐项安装既慢又多付备份）。
 * 参数：
 *   c: object -- resolveContext() 的结果（用到 manifestFile / profileDir）
 *   names: string[] -- 要摘除的包名，例如 ['dsh-esc-rewind', 'dsh-session-time-bucket']
 * 返回值：
 *   { removed: string[], ranPnpm: boolean, error: string|null, backup: string|null }
 *   例：{ removed: ['dsh-aaa'], ranPnpm: true, error: null, backup: '.../package.json.bak-...' }
 * 调用样例：
 *   const dropped = await dropDevDeps(c, plan.targets.map((t) => t.name))
 */
async function dropDevDeps(c, names) {
  const wanted = (Array.isArray(names) ? names : []).filter((n) => typeof n === 'string' && n !== '')
  if (wanted.length === 0) return { removed: [], ranPnpm: false, error: null, backup: null }

  const manifest = readManifest(c.manifestFile)
  const deps = { ...(manifest.dependencies || {}) }
  const devDeps = { ...(manifest.devDependencies || {}) }
  const present = wanted.filter((n) => Object.prototype.hasOwnProperty.call(deps, n) || Object.prototype.hasOwnProperty.call(devDeps, n))
  // 一个键都不在 → 无需改写也无需安装，直接视为已摘除。
  if (present.length === 0) return { removed: wanted, ranPnpm: false, error: null, backup: null }

  const backup = backupFile(c.manifestFile)
  const next = { ...manifest, dependencies: deps, devDependencies: devDeps }
  for (const n of present) {
    delete next.dependencies[n]
    delete next.devDependencies[n]
  }
  writeJsonPretty(c.manifestFile, next)
  const res = await pnpmRunner(c.profileDir, ['install'])
  if (!res.ok) {
    try { fs.copyFileSync(backup, c.manifestFile) } catch { /* best effort */ }
    return { removed: [], ranPnpm: true, error: res.error || 'pnpm install failed', backup }
  }
  return { removed: wanted, ranPnpm: true, error: null, backup }
}

// --- HTTP registration -------------------------------------------------------

function registerHttp(ctx, host, config) {
  if (!host || typeof host.register !== 'function') return
  const __cfg = config || {}

  const h = async (req, res) => {
    try {
      const method = String(req.method || 'GET').toUpperCase()
      const url = (req.url || '').split('?')[0]

      if (url === `${HTTP_PREFIX}/status` && method === 'GET') {
        const c = resolveContext(__cfg, ctx && ctx.baseUrl)
        sendJson(res, 200, {
          ok: true,
          plugin: 'dsh-plugin-manager',
          repoRoot: c.repoRoot,
          pluginsRoot: c.pluginsRoot,
          profileName: c.profileName,
          profileDir: c.profileDir,
          patchFile: c.patchFile,
          endpointsRegistered: true,
          yamlResolved: HOST_DIAG.yamlResolved,
          yamlError: HOST_DIAG.yamlError,
          pendingWrites: pendingIntents.length,
          lastFlushError: HOST_DIAG.lastFlushError,
          lastBatch: HOST_DIAG.lastBatch,
          autoRelinkEnabled: __autoRelink === true,
          autoRelink: HOST_DIAG.autoRelink,
          lastRelink: HOST_DIAG.lastRelink,
          workspace: HOST_DIAG.workspace,
          workspaceRepair: HOST_DIAG.workspaceRepair,
        })
        return
      }

      if (url === `${HTTP_PREFIX}/list` && method === 'GET') {
        sendJson(res, 200, listPayload(snapshot(ctx, __cfg)))
        return
      }

      if ((url === `${HTTP_PREFIX}/set-enabled` || url === `${HTTP_PREFIX}/remove` || url === `${HTTP_PREFIX}/migrate` || url === `${HTTP_PREFIX}/set-all-enabled` || url === `${HTTP_PREFIX}/remove-all` || url === `${HTTP_PREFIX}/relink` || url === `${HTTP_PREFIX}/repair`) && method === 'POST') {
        let args = {}
        const body = await readBody(req)
        if (body) {
          try { args = JSON.parse(body) } catch { sendJson(res, 400, { ok: false, error: 'bad json body' }); return }
        }
        // 全部开启 / 全部关闭 —— 一次安装 + 一次写入（design.md D3/D4/D5）。
        if (url === `${HTTP_PREFIX}/set-all-enabled`) {
          const enabled = args.enabled !== false
          // 接管仍在 400 ms 合并窗口里的单行意图：与批量目标并进同一次写入，
          // 既不吞掉用户的点击，也不额外多一次核心配置重应用。
          const queued = pendingIntents
          pendingIntents = []
          HOST_DIAG.pendingWrites = 0
          if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }

          const s = snapshot(ctx, __cfg, queued)
          const c = s.c
          const plan = batchPlan(s.derived, enabled)
          const results = plan.skipped.map((x) => ({
            dir: x.dir,
            name: x.name,
            hasClient: x.hasClient,
            outcome: 'skipped',
            reason: x.reason,
          }))

          if (plan.count === 0 && queued.length === 0) {
            const payload = listPayload(snapshot(ctx, __cfg, []))
            payload.noop = true
            payload.results = results
            payload.counts = { total: 0, applied: 0, skipped: results.length, failed: 0, installed: 0, ranPnpm: false, wrotePatch: false }
            sendJson(res, 200, payload)
            return
          }

          const y = await ensureYaml(c.profileDir)
          if (!y.engine) { sendJson(res, 500, { ok: false, error: y.error }); return }
          HOST_DIAG.yamlResolved = true
          HOST_DIAG.yamlError = null

          // ① 需要安装的目标：一次写齐全部 link: 后只跑一次 pnpm install
          const needInstall = enabled ? plan.targets.filter((t) => t.needsInstall) : []
          const failedInstall = new Map()
          let ranPnpm = false
          if (needInstall.length > 0) {
            const ins = await ensureDevDeps(c, needInstall.map((t) => ({ name: t.name, dir: t.dir, dirPath: t.dirPath })))
            ranPnpm = ins.ranPnpm
            for (const f of ins.failed) failedInstall.set(f.name, f.error)
          }

          // ② 一次写入：排队意图 + 全部批量目标
          const applied = plan.targets.filter((t) => !failedInstall.has(t.name))
          let writeError = null
          let wrote = false
          try {
            const diskRows = readPatchRows(y.engine, c.patchFile)
            const nextRows = upsertManagedMany(
              upsertManagedMany(diskRows, queued),
              applied.map((t) => ({ id: t.rowId, name: t.name, enabled })),
            )
            if (JSON.stringify(nextRows) !== JSON.stringify(diskRows)) {
              writePatchRows(y.engine, c.patchFile, nextRows)
              wrote = true
            }
            HOST_DIAG.lastFlushError = null
          } catch (e) {
            writeError = (e && e.message) || String(e)
            HOST_DIAG.lastFlushError = writeError
          }

          for (const t of plan.targets) {
            const installError = failedInstall.get(t.name)
            if (installError) {
              results.push({ dir: t.dir, rowId: t.rowId, name: t.name, hasClient: t.hasClient, outcome: 'failed', reason: 'install-failed', error: installError })
            } else if (writeError) {
              results.push({ dir: t.dir, rowId: t.rowId, name: t.name, hasClient: t.hasClient, outcome: 'failed', reason: 'write-failed', error: writeError })
            } else {
              results.push({ dir: t.dir, rowId: t.rowId, name: t.name, hasClient: t.hasClient, outcome: 'applied', reason: null })
            }
          }

          const failedList = results.filter((r) => r.outcome === 'failed')
          const counts = {
            total: plan.count,
            applied: results.filter((r) => r.outcome === 'applied').length,
            skipped: results.filter((r) => r.outcome === 'skipped').length,
            failed: failedList.length,
            installed: needInstall.length - failedInstall.size,
            ranPnpm,
            wrotePatch: wrote,
          }
          const payload = listPayload(snapshot(ctx, __cfg, []))
          payload.results = results
          payload.counts = counts
          payload.noop = counts.applied === 0 && !wrote
          if (failedList.length > 0) {
            payload.warning = `批量${enabled ? '开启' : '关闭'}有 ${failedList.length} 项失败：${failedList.map((r) => `${r.name}（${r.error || r.reason}）`).join('、')}`
          }
          HOST_DIAG.lastBatch = {
            enabled,
            at: Date.now(),
            applied: counts.applied,
            skipped: counts.skipped,
            failed: counts.failed,
            installed: counts.installed,
            wrotePatch: wrote,
            error: writeError,
          }
          sendJson(res, 200, payload)
          return
        }

        // 全部移除 —— 一次删行 + 一次摘依赖 + 一次安装（design.md D2/D3/D4）。
        if (url === `${HTTP_PREFIX}/remove-all`) {
          // 排队的开关意图一律丢弃：它们的目标行本来就要被删除，先落盘只会白付一次
          // 核心配置重应用（与批量开关的「接管」语义刻意相反）；丢弃条数如实回报。
          const discardedIntents = pendingIntents.length
          pendingIntents = []
          HOST_DIAG.pendingWrites = 0
          if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
          // 已在飞行中的一次 flush 先落地，保证我们的删除是最后写盘的那一次。
          try { await flushChain } catch { /* 该链自身已吞掉异常 */ }

          const s = snapshot(ctx, __cfg, [])
          const c = s.c
          const plan = removePlan(s.derived)
          const results = plan.skipped.map((x) => ({
            dir: x.dir,
            name: x.name,
            hasClient: x.hasClient,
            outcome: 'skipped',
            reason: x.reason,
          }))

          if (plan.count === 0) {
            const payload = listPayload(snapshot(ctx, __cfg, []))
            payload.noop = true
            payload.discardedIntents = discardedIntents
            payload.results = results
            payload.counts = { total: 0, applied: 0, skipped: results.length, failed: 0, installed: 0, ranPnpm: false, wrotePatch: false }
            sendJson(res, 200, payload)
            return
          }

          const y = await ensureYaml(c.profileDir)
          if (!y.engine) { sendJson(res, 500, { ok: false, error: y.error }); return }
          HOST_DIAG.yamlResolved = true
          HOST_DIAG.yamlError = null

          // 操作前的 patch 原文：任一步失败都要用它把「行已删」这个副作用一起回滚，
          // 否则会留下「行没了、依赖还在」的半状态。
          let patchBackupText = null
          if (fs.existsSync(c.patchFile)) {
            try { patchBackupText = fs.readFileSync(c.patchFile, 'utf8') } catch { patchBackupText = null }
          }

          // ① 一次删掉全部受管行（一次写入 = 一次核心配置重应用）
          let writeError = null
          let wrote = false
          try {
            const diskRows = readPatchRows(y.engine, c.patchFile)
            const nextRows = plan.targets.reduce((acc, t) => removeManaged(acc, t.rowId), diskRows)
            if (JSON.stringify(nextRows) !== JSON.stringify(diskRows)) {
              writePatchRows(y.engine, c.patchFile, nextRows)
              wrote = true
            }
          } catch (e) {
            writeError = (e && e.message) || String(e)
          }

          // ② 一次摘依赖（内含一次 pnpm install）；③ 失败 → manifest 与 patch 一起回滚
          let dropped = { removed: [], ranPnpm: false, error: null, backup: null }
          if (!writeError) {
            dropped = await dropDevDeps(c, plan.targets.map((t) => t.name))
            if (dropped.error) writeError = `dependency cleanup failed: ${dropped.error}`
          }
          if (writeError && patchBackupText !== null) {
            try { fs.writeFileSync(c.patchFile, patchBackupText, 'utf8') } catch { /* best effort */ }
            wrote = false
          }
          HOST_DIAG.lastFlushError = writeError

          for (const t of plan.targets) {
            results.push(writeError
              ? { dir: t.dir, rowId: t.rowId, name: t.name, hasClient: t.hasClient, outcome: 'failed', reason: 'remove-failed', error: writeError }
              : { dir: t.dir, rowId: t.rowId, name: t.name, hasClient: t.hasClient, outcome: 'applied', reason: null })
          }

          const failedList = results.filter((r) => r.outcome === 'failed')
          const counts = {
            total: plan.count,
            applied: results.filter((r) => r.outcome === 'applied').length,
            skipped: results.filter((r) => r.outcome === 'skipped').length,
            failed: failedList.length,
            installed: 0,
            ranPnpm: dropped.ranPnpm === true,
            wrotePatch: wrote,
          }
          const payload = listPayload(snapshot(ctx, __cfg, []))
          payload.results = results
          payload.counts = counts
          payload.discardedIntents = discardedIntents
          payload.noop = counts.applied === 0 && !wrote
          if (failedList.length > 0) {
            payload.warning = `全部移除失败：${failedList.map((r) => `${r.name}（${r.error || r.reason}）`).join('、')}`
          }
          // 与批量开关对称地留一份诊断（/status 可读），便于事后核对这次到底做了什么。
          HOST_DIAG.lastBatch = {
            mode: 'remove',
            enabled: null,
            at: Date.now(),
            applied: counts.applied,
            skipped: counts.skipped,
            failed: counts.failed,
            installed: counts.installed,
            wrotePatch: wrote,
            discardedIntents,
            error: writeError,
          }
          sendJson(res, 200, payload)
          return
        }

        if (url === `${HTTP_PREFIX}/set-enabled` || url === `${HTTP_PREFIX}/remove`) {
          const dir = String(args.dir || '').trim()
          const snap0 = snapshot(ctx, __cfg)
          const meta = dir ? readPluginMeta(snap0.c.repoRoot, dir) : null
          if (!meta || !meta.valid) {
            sendJson(res, 400, { ok: false, error: `unknown or invalid plugin dir: ${dir || '(empty)'}` })
            return
          }
          // Prefer a fresh snapshot for state decisions.
          const s = snapshot(ctx, __cfg)
          const st = s.derived.find((p) => p.dir === dir)
          const c = s.c
          const y = await ensureYaml(c.profileDir)
          if (!y.engine) { sendJson(res, 500, { ok: false, error: y.error }); return }
          HOST_DIAG.yamlResolved = true
          HOST_DIAG.yamlError = null
          let rows = readPatchRows(y.engine, c.patchFile)

          if (url.endsWith('/set-enabled')) {
            const enabled = args.enabled !== false
            // Legacy layout: the bundle layer already owns this id — a second
            // insert would collide loader-wide. Ask the user to migrate first.
            if (st && st.legacyBundle) {
              sendJson(res, 409, {
                ok: false,
                code: 'legacy-layout',
                error: `${meta.name} 仍以旧布局(dependencies+bundles)安装，请先执行「一键接管/迁移」再开关`,
              })
              return
            }
            if (enabled) {
              const check = readManifest(c.manifestFile)
              const inDeps = Object.prototype.hasOwnProperty.call(check.dependencies || {}, meta.name)
              const devSpec = (check.devDependencies || {})[meta.name]
              const expectedSpec = linkDepSpec(c.profileDir, meta)
              // 键在 ≠ 就位：规格仍是旧协议（workspace:* 或绝对 link:）时同样要修；
              // 只有「devDependency 恰好是期望的相对 link: 规格」才跳过安装。
              const ready = !inDeps && expectedSpec !== null && devSpec === expectedSpec
              if (!ready) {
                const ins = await ensureDevDep(c, meta)
                if (!ins.installed) {
                  sendJson(res, 500, { ok: false, error: `install ${meta.name} failed: ${ins.error || 'unknown'}` })
                  return
                }
              }
            }
            // Merge instead of writing: one write = one core config-tree
            // re-application (~1 s host stall), so a burst of clicks has to
            // collapse into a single write (design.md R1/R4).
            queueIntent({ id: meta.rowId, name: meta.name, enabled })
            scheduleFlush(ctx, __cfg)
            sendJson(res, 200, listPayload(snapshot(ctx, __cfg)))
            return
          }

          // remove — only for non-legacy managed rows
          if (st && st.legacyBundle) {
            sendJson(res, 409, {
              ok: false,
              code: 'legacy-layout',
              error: `${meta.name} 仍以旧布局安装，请先执行「一键接管/迁移」再移除`,
            })
            return
          }
          // Persist queued intents first, then re-read: the flush rewrote the file.
          await flushPending(ctx, __cfg)
          rows = readPatchRows(y.engine, c.patchFile)
          rows = removeManaged(rows, meta.rowId)
          writePatchRows(y.engine, c.patchFile, rows)
          const dropped = await dropDevDep(c, meta.name)
          const payload = listPayload(snapshot(ctx, __cfg))
          if (!dropped.removed) payload.warning = `row removed; devDependency cleanup failed: ${dropped.error || 'unknown'}`
          sendJson(res, 200, payload)
          return
        }

        if (url === `${HTTP_PREFIX}/repair` || url === `${HTTP_PREFIX}/relink`) {
          const s0 = snapshot(ctx, __cfg)
          const plan = repairPlan(s0.derived)
          const wanted = Array.isArray(args.dirs) && args.dirs.length > 0
            ? plan.auto.filter((p) => args.dirs.includes(p.dir))
            : plan.auto
          if (wanted.length === 0) {
            HOST_DIAG.lastRelink = { at: Date.now(), relinked: [], ranPnpm: false, failed: [], source: 'panel', manualCount: plan.manualCount }
            sendJson(res, 200, { ...listPayload(snapshot(ctx, __cfg)), relink: { noop: true, relinked: [], ranPnpm: false, manualCount: plan.manualCount } })
            return
          }
          const ins = await ensureDevDeps(s0.c, wanted.map((p) => ({ name: p.name, dir: p.dir, dirPath: p.dirPath })))
          const ok = ins.failed.length === 0
          HOST_DIAG.lastRelink = {
            at: Date.now(),
            relinked: ins.installed,
            failed: ins.failed,
            ranPnpm: ins.ranPnpm,
            source: 'panel',
            manualCount: plan.manualCount,
          }
          sendJson(res, ok ? 200 : 500, {
            ...listPayload(snapshot(ctx, __cfg)),
            relink: { noop: false, relinked: ins.installed, failed: ins.failed, ranPnpm: ins.ranPnpm, backup: ins.backup, manualCount: plan.manualCount },
          })
          return
        }

        // migrate — settle queued switch intents first so the plan is computed
        // against the file the user's clicks already asked for.
        await flushPending(ctx, __cfg)
        const s = snapshot(ctx, __cfg)
        const c = s.c
        const y = await ensureYaml(c.profileDir)
        if (!y.engine) { sendJson(res, 500, { ok: false, error: y.error }); return }
        HOST_DIAG.yamlResolved = true
        HOST_DIAG.yamlError = null
        const plan = planMigration({
          repoPlugins: s.plugins,
          manifest: s.manifest,
          rows: s.rows,
          repoRoot: c.repoRoot,
          profileDir: c.profileDir,
          workspace: s.workspace ? s.workspace.doc : {},
        })
        if (!plan.needsMigration) {
          sendJson(res, 200, { ok: true, noop: true, data: { ...listPayload(snapshot(ctx, __cfg)).data } })
          return
        }
        const bakManifest = fs.existsSync(c.manifestFile) ? backupFile(c.manifestFile) : null
        const bakPatch = fs.existsSync(c.patchFile) ? backupFile(c.patchFile) : null
        const bakWorkspace = plan.workspaceChanged && fs.existsSync(c.workspaceFile) ? backupFile(c.workspaceFile) : null
        try {
          if (plan.workspaceChanged) {
            fs.mkdirSync(path.dirname(c.workspaceFile), { recursive: true })
            fs.writeFileSync(c.workspaceFile, y.engine.dumpDoc(plan.newWorkspace || {}), 'utf8')
          }
          writeJsonPretty(c.manifestFile, plan.newManifest)
          writePatchRows(y.engine, c.patchFile, plan.finalRows)
          const resPnpm = await pnpmRunner(c.profileDir, ['install'])
          if (!resPnpm.ok) {
            throw new Error(`pnpm install failed: ${resPnpm.error || resPnpm.stderr.trim()}`)
          }
          sendJson(res, 200, {
            ok: true,
            backups: [bakManifest, bakPatch, bakWorkspace].filter(Boolean),
            summary: plan.summary,
            data: { ...listPayload(snapshot(ctx, __cfg)).data },
          })
        } catch (e) {
          if (bakManifest) { try { fs.copyFileSync(bakManifest, c.manifestFile) } catch { /* best effort */ } }
          if (bakPatch) { try { fs.copyFileSync(bakPatch, c.patchFile) } catch { /* best effort */ } }
          if (bakWorkspace) { try { fs.copyFileSync(bakWorkspace, c.workspaceFile) } catch { /* best effort */ } }
          sendJson(res, 500, { ok: false, error: (e && e.message) || String(e) })
        }
        return
      }

      sendJson(res, 404, { ok: false, error: 'not found' })
    } catch (e) {
      sendJson(res, 500, { ok: false, error: (e && e.message) || String(e) })
    }
  }

  ctx.effect(() => {
    const registered = host.register({ kind: 'prefix', path: HTTP_PREFIX, handler: h })
    return () => {
      if (flushTimer) { clearTimeout(flushTimer); flushTimer = null }
      // A queued switch must not evaporate when the host exits.
      try { flushPendingSync(resolveContext(__cfg, ctx && ctx.baseUrl)) } catch { /* best effort */ }
      if (typeof registered === 'function') { try { registered() } catch { /* best effort */ } }
    }
  })
  HOST_DIAG.endpointsRegistered = true
  // Fire-and-forget: the first load doubles as the automatic stale-link self-check
  // (determinable items only; one action per host start).
  void autoRelinkOnce(ctx, __cfg)
}

/**
 * 功能作用：宿主启动后的一次性自检——检测待修依赖（遗留 link: 绝对路径规格、或 workspace 锚点缺失/
 *           指向旧位置），对「可确定」的那些自动改写并只跑一次 pnpm install；每次宿主启动最多执行
 *           一次（失败也消耗额度，避免坏环境反复写）。开关关闭时只记录"已跳过"，不做任何写入。
 * 参数：
 *   ctx: object -- cordis 上下文（供快照解析 profile）
 *   cfg: object -- 插件配置（profile 覆盖等），例 {}
 * 返回值：
 *   Promise<void>；结果写入 HOST_DIAG.autoRelink / lastRelink
 * 调用样例：
 *   void autoRelinkOnce(ctx, config)
 */
async function autoRelinkOnce(ctx, cfg) {
  if (AUTO_RELINK_LATCH.done) return
  AUTO_RELINK_LATCH.done = true
  if (__autoRelink !== true) {
    HOST_DIAG.autoRelink = { at: Date.now(), skipped: 'disabled', relinked: [], ranPnpm: false }
    return
  }
  try {
    const s = snapshot(ctx, cfg)
    const plan = repairPlan(s.derived)
    const anchorClean = Boolean(s.workspace && s.workspace.state && s.workspace.state.repoGlobs.length === 0)
    // 无事可做 = 没有待修依赖 且 没有残留 workspace 锚点；有残留也要清一次（老 profile 自愈）。
    if (plan.count === 0 && anchorClean) {
      HOST_DIAG.autoRelink = { at: Date.now(), relinked: [], ranPnpm: false, manualCount: plan.manualCount, workspaceOk: true }
      return
    }
    const ins = await ensureDevDeps(s.c, plan.auto.map((p) => ({ name: p.name, dir: p.dir, dirPath: p.dirPath })))
    HOST_DIAG.autoRelink = {
      at: Date.now(),
      relinked: ins.installed,
      failed: ins.failed,
      ranPnpm: ins.ranPnpm,
      manualCount: plan.manualCount,
      workspaceChanged: ins.workspaceChanged === true,
    }
    HOST_DIAG.lastRelink = { ...HOST_DIAG.autoRelink, source: 'auto' }
  } catch (error) {
    HOST_DIAG.autoRelink = { at: Date.now(), error: (error && error.message) ? error.message : String(error) }
  }
}

// --- plugin ------------------------------------------------------------------

function apply(ctx, config = {}) {
  const c0 = resolveContext(config, ctx && ctx.baseUrl)
  HOST_DIAG.profileName = c0.profileName
  HOST_DIAG.repoRoot = c0.repoRoot
  const ws0 = workspaceSnapshot(c0)
  HOST_DIAG.workspace = { file: c0.workspaceFile, glob: ws0.state.glob, ok: ws0.state.ok, repoGlobs: ws0.state.repoGlobs }
  // 0.2.0：条目 Config 里的开关值（0.1.x 的行没有 config，此分支不生效，仍走 installSection）。
  if (config && typeof config[AUTO_RELINK_FIELD] === 'boolean') {
    __autoRelink = config[AUTO_RELINK_FIELD] !== false
    HOST_DIAG.autoRelinkEnabled = __autoRelink
  }

  // Settings section (optional): the automatic stale-link relink switch.
  const settings = typeof ctx.get === 'function' ? ctx.get('settings') : null
  if (settings !== undefined) {
    installSettingsSection(ctx, settings)
  } else {
    try {
      ctx.inject(['settings'], (sub) => {
        installSettingsSection(ctx, sub && sub.settings ? sub.settings : sub)
      })
    } catch { /* no settings service: auto-relink stays at its default (on) */ }
  }
  const ws = typeof ctx.get === 'function' ? ctx.get('webServer') : null
  if (ws !== undefined) {
    registerHttp(ctx, ws, config)
  } else {
    try {
      ctx.inject(['webServer'], (sub) => {
        registerHttp(ctx, sub && sub.webServer ? sub.webServer : sub, config)
      })
    } catch {
      // terminal-only profile: no web surface, nothing to serve.
    }
  }
  // Lazy yaml diag for /status
  const probe = requireProfileYaml(c0.profileDir)
  HOST_DIAG.yamlResolved = Boolean(probe.jsyaml)
  HOST_DIAG.yamlError = probe.error
}

/** Test-only: flip the automatic-relink switch without a settings service. */
export function __setAutoRelink(value) {
  __autoRelink = value !== false
  HOST_DIAG.autoRelinkEnabled = __autoRelink
}

/** Test-only: re-arm the one-shot latch so the automatic pass can be driven again. */
export function __resetAutoRelinkLatch() {
  AUTO_RELINK_LATCH.done = false
}

export { apply, inject, name, registerHttp, autoRelinkOnce as __autoRelinkOnce }
