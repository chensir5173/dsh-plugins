// dsh-plugin-manager: HOST-core — pure, side-effect-free logic.
//
// Everything that can be unit-tested lives here (repo scanning, stable-id row
// transforms on the profile patch list, per-plugin state derivation, migration
// planning, YAML-engine factories). src/index.js only wires this core to the
// DSH host (HTTP endpoints, pnpm spawning, file writes) — same split that kept
// esc-rewind's delete logic testable.
//
// ESM module format (cordis bundle rule): only src/index.js needs to be a
// valid plugin body; this file is imported by it and by the node tests.

import fs from 'node:fs'
import path from 'node:path'
import os from 'node:os'

// --- constants ---------------------------------------------------------------

/** This manager's own directory name (excluded from the managed set). */
export const MANAGER_DIR = 'dsh-plugin-manager'
/** Bundle id / row id / package name of the manager itself. */
export const MANAGER_ID = 'dsh-plugin-manager'
/** Target profile when nothing overrides it. */
export const DEFAULT_PROFILE = 'web'
/** Every local plugin folder in this monorepo starts with this prefix. */
export const PLUGIN_DIR_PREFIX = 'dsh-'
/** Sub-directory holding the sibling plugin packages (preferred layout). */
export const PLUGINS_DIRNAME = 'sub-plugins'
/**
 * Plugin directories that stay in the repo as readable source but are RETIRED:
 * the scan skips them, so they never appear in Settings → 本地插件 and the
 * manager can no longer activate them. Retire by ADDING a name here (with the
 * date and the reason) instead of deleting the directory — the code, its
 * README/ACCEPTANCE and its tests keep working as reference.
 */
export const RETIRED_PLUGIN_DIRS = [
  // 2026-09-18 — superseded by DSH core: `@deepseek-ai/dsh-client-ui-open-in-app`
  // already puts an "Open In…" split button on the session header
  // (`conversation.session.header.utilities`), launches the remembered
  // application on the session cwd, and lists every app the host probed as
  // installed (Explorer, Git Bash, editors, terminals). This local plugin was
  // the stopgap for that gap and is now redundant. Source kept for reference.
  'dsh-open-session-workdir',
  // 2026-10-09 — 用户要求「暂时废弃」：Hindsight（Vectorize 的长期记忆层）那个
  // 独立 Python 守护进程的模型面板与启停控制不再由本仓维护，先从面板摘掉。
  // 源码、README/ACCEPTANCE 与测试全部留在仓库作参考实现。
  // 恢复：把名字从这里删掉，并去掉 profile `cordis.patch.yml` 里
  // `hindsight-model` 那一行的 `disabled: true`。
  // 见 docs/knowledge/2026-10-09-retire-hindsight-model.md。
  'dsh-hindsight-model',
]
/**
 * Profile workspace file. Older manager versions kept a repo glob in
 * <profile>/pnpm-workspace.yaml so a sibling could be declared `workspace:*`;
 * pnpm SKIPS node_modules when it expands a workspace glob, so on a
 * git-installed profile (manager root inside node_modules) every managed
 * dependency failed with ERR_PNPM_WORKSPACE_PKG_NOT_FOUND. The anchor is RETIRED:
 * this file is now read only to strip a leftover glob, never to add one.
 */
export const WORKSPACE_FILE = 'pnpm-workspace.yaml'
/** Legacy spec prefix, recognised only to rewrite an old key into a link: spec. */
export const WORKSPACE_PROTOCOL = 'workspace:'
/**
 * Relative link: prefix — the ONLY spec form the manager writes into
 * devDependencies. A managed sibling is declared as a link to the copy shipped
 * inside this profile (<profile>/node_modules/<manager>/sub-plugins/<dir>), which
 * resolves identically from a git snapshot and from a local checkout.
 */
export const LINK_PROTOCOL = 'link:'
/** Profile devDependency the host needs for patch-file YAML round-trips. */
export const YAML_PKG = 'js-yaml'
export const YAML_PKG_RANGE = '^4.1.0'
/** HTTP endpoints namespace. */
export const HTTP_PREFIX = '/__dsh-plugin-manager'
/**
 * How long switch requests are merged before one patch-file write. Each write
 * costs DSH core a full config-tree re-application that blocks the host event
 * loop (~0.7-1.2 s measured), so N quick clicks must collapse into one write.
 */
export const INTENT_DEBOUNCE_MS = 400

// --- path helpers ------------------------------------------------------------

/** $DSH_HOME or ~/.dsh (mirrors @deepseek-ai/dsh-home-paths). */
export function dshHome(env = process.env) {
  const v = env && env.DSH_HOME
  if (typeof v === 'string' && v.trim() !== '') return v.trim()
  return path.join(os.homedir(), '.dsh')
}

export function profileDirOf(home, name = DEFAULT_PROFILE) {
  return path.join(home, 'profiles', name)
}

export function patchPathOf(home, name = DEFAULT_PROFILE) {
  return path.join(profileDirOf(home, name), 'cordis.patch.yml')
}

export function manifestPathOf(home, name = DEFAULT_PROFILE) {
  return path.join(profileDirOf(home, name), 'package.json')
}

/** <repo>/dsh-plugin-manager/src → <repo> (the scanned sibling root). */
export function repoRootOfPluginSrc(srcDir) {
  return path.resolve(srcDir, '..', '..')
}

/** Stable activation row id for a plugin dir: dir name minus the dsh- prefix. */
export function rowIdOfDir(dir) {
  return dir.startsWith(PLUGIN_DIR_PREFIX) ? dir.slice(PLUGIN_DIR_PREFIX.length) : dir
}

/** True when a devDependency spec uses pnpm's workspace protocol. */
export function isWorkspaceSpec(spec) {
  return typeof spec === 'string' && spec.startsWith(WORKSPACE_PROTOCOL)
}

/** Profile-side mirror directory of one plugin: the copy inside THIS profile. */
export function mirrorDirOf(profileDir, meta) {
  const dir = meta && typeof meta.dir === 'string' ? meta.dir : ''
  if (typeof profileDir !== 'string' || profileDir === '' || dir === '') return null
  return path.join(profileDir, 'node_modules', MANAGER_DIR, PLUGINS_DIRNAME, dir)
}

/**
 * 功能作用：算出一个子插件在 profile package.json 里应该写的 devDependency 规格（纯函数 + 注入 io）——
 *           优先写成相对 link:（指向本 profile 自己 node_modules 里的那份拷贝），那份拷贝不存在时才退回
 *           绝对 link:（老写法）。相对规格在「git 快照安装」与「本地 checkout link 安装」两种形态下都指向
 *           profile 里实际生效的那份源码，因此不含机器相关的盘符/用户名。
 * 参数：
 *   profileDir: string -- profile 目录（pnpm 项目根），例 'C:/Users/x/.dsh/profiles/desktop'
 *   meta: object -- readPluginMeta() 的结果，例 { name:'dsh-aaa', dir:'dsh-aaa', dirPath:'D:/repo/sub-plugins/dsh-aaa' }
 *   io: object -- { exists }，默认真实文件系统（测试注入假实现）
 * 返回值：
 *   string|null -- 规格，例 'link:./node_modules/dsh-plugin-manager/sub-plugins/dsh-aaa'；无法推导时为 null
 * 调用样例：
 *   const spec = linkDepSpec(c.profileDir, meta)   // 'link:./node_modules/dsh-plugin-manager/sub-plugins/dsh-aaa'
 */
export function linkDepSpec(profileDir, meta, io = FS_IO) {
  const mirror = mirrorDirOf(profileDir, meta)
  if (mirror) {
    try {
      if (io.exists(mirror)) return LINK_PROTOCOL + './' + forwardPath(path.relative(profileDir, mirror))
    } catch { /* fall through to the absolute form */ }
  }
  const direct = meta && typeof meta.dirPath === 'string' ? meta.dirPath : ''
  return direct === '' ? null : LINK_PROTOCOL + forwardPath(direct)
}

/** Forward-slashed path (Windows separators never reach the YAML we write). */
export function forwardPath(value) {
  return String(value).split('\\').join('/')
}

/**
 * 功能作用：比较两个路径是否指向同一处——按目标平台决定是否大小写敏感，并把反斜杠/
 *           正斜杠与结尾分隔符归一化（Windows 上 D:/Repo/x 与 D:\Repo\X 视为同一处）。
 * 参数：
 *   a: string -- 路径，例 'D:/Repo/x/'
 *   b: string -- 路径，例 'D:\Repo\X'
 *   platform: string -- 目标平台，例 'win32' | 'darwin' | 'linux'
 * 返回值：
 *   boolean -- 同处为 true，例 true
 * 调用样例：
 *   if (samePath('D:/repo/x/', 'D:\\Repo\\X', 'win32')) { ... }
 */
export function samePath(a, b, platform = process.platform) {
  const norm = (v) => forwardPath(v).replace(/\/+$/, '')
  const left = norm(a)
  const right = norm(b)
  const caseInsensitive = platform === 'win32' || platform === 'darwin'
  return caseInsensitive ? left.toLowerCase() === right.toLowerCase() : left === right
}

/**
 * Candidate workspace globs (`<plugin-root>/*`) for every scanned root, most
 * specific first: `<repo>/sub-plugins/*` before the legacy flat `<repo>/*`.
 * Only used to RECOGNISE a retired anchor: a profile that still carries one of
 * these globs gets it stripped (pnpm skips node_modules while expanding a
 * workspace glob, so a git-installed profile could never resolve workspace:*).
 */
/**
 * A workspace glob that points at SOME clone of this project: `<root>/sub-plugins/*`
 * (or the legacy flat `<root>/*`, matched through workspaceGlobCandidates).
 * Shape matching — not path matching — is what lets a profile carried over from
 * another machine drop the glob that pointed at the OLD repository location;
 * unrelated globs (packages/*, apps/*) are never touched.
 */
export function isPluginGlobShape(entry) {
  if (typeof entry !== 'string') return false
  const norm = forwardPath(entry).replace(/\/+$/, '')
  return norm === PLUGINS_DIRNAME + '/*' || norm.endsWith('/' + PLUGINS_DIRNAME + '/*')
}

export function workspaceGlobCandidates(repoRoot) {
  return pluginRootsOf(repoRoot).map((root) => forwardPath(path.join(root, '*')).replace(/\/+$/, ''))
}

/** The glob the manager maintains: the first (most specific) plugin root. */
export function pluginsGlobOf(repoRoot) {
  return workspaceGlobCandidates(repoRoot)[0]
}

/**
 * Machine-readable dependency states (host payload and panel copy share this vocabulary).
 * `missing` (stale-target-missing) is a HISTORICAL entry: it came from the retired
 * workspace anchor and is no longer produced, but it stays in the vocabulary so an
 * older payload and the panel copy built against it cannot shift meaning.
 */
export const DEP_STATES = {
  absent: 'absent',
  fresh: 'fresh',
  mismatch: 'stale-mismatch',
  missing: 'stale-target-missing',
  unresolved: 'stale-unresolved',
  unknown: 'unknown',
}

/**
 * Default IO for {@link depStateOf}: the real filesystem. Tests inject a fake so
 * the matrix (missing directories, IO failures) is asserted without touching disk.
 */
export const FS_IO = {
  platform: process.platform,
  exists: (p) => { try { return fs.existsSync(p) } catch { return false } },
  realpath: (p) => {
    const impl = typeof fs.realpathSync.native === 'function' ? fs.realpathSync.native : fs.realpathSync
    return impl(p)
  },
}

/**
 * 功能作用：读一个 profile 的 pnpm-workspace.yaml 解析结果，指出其中「指向本仓库插件目录」的
 *           条目（只读，纯函数）。这些条目是已退役的 workspace 锚点残留——管理器只做清理，
 *           不再补写。与本仓库无关的 glob（packages/*、apps/*）永远不动。
 * 参数：
 *   doc: object -- pnpm-workspace.yaml 解析结果，例 { packages: ['.', 'C:/repo/sub-plugins/*'] }
 *   repoRoot: string -- 本仓库根，例 'C:/repo'
 *   platform?: string -- 路径比较平台，默认 process.platform
 * 返回值：
 *   { file, glob, candidates, packages, repoGlobs, ok }
 *   例：workspaceStateOf({ packages: ['.', 'C:/repo/sub-plugins/*'] }, 'C:/repo') → { ok: false, repoGlobs: ['C:/repo/sub-plugins/*'], ... }
 * 调用样例：
 *   const ws = workspaceStateOf(doc, repoRoot)   // ws.ok === false 表示还有退役残留要清
 */
export function workspaceStateOf(doc, repoRoot, platform = process.platform) {
  const glob = pluginsGlobOf(repoRoot)
  const candidates = workspaceGlobCandidates(repoRoot)
  const packages = Array.isArray(doc && doc.packages)
    ? doc.packages.filter((e) => typeof e === 'string' && e.trim() !== '')
    : []
  const repoGlobs = packages.filter((e) => isPluginGlobShape(e) || candidates.some((c) => samePath(e, c, platform)))
  return { file: WORKSPACE_FILE, glob, candidates, packages, repoGlobs, ok: repoGlobs.length === 0 }
}

/**
 * 功能作用：把「指向本仓库插件目录」的条目从 workspace 文档里摘掉——workspace 锚点已退役
 *           （pnpm 展开 workspace glob 时会跳过 node_modules，git 安装下必然解析失败），
 *           所以这里是清理而不是补写。幂等：已干净时 changed=false 且零写入。
 * 参数：
 *   doc: object -- pnpm-workspace.yaml 解析结果（缺失或非法时按空对象处理）
 *   repoRoot: string -- 本仓库根，例 'C:/repo'
 *   platform?: string -- 路径比较平台
 * 返回值：
 *   { doc: object, changed: boolean, removed: string[], state: object }
 *   例：retireWorkspaceGlob({ packages: ['.', 'C:/old/sub-plugins/*'] }, 'C:/repo') → { changed: true, removed: ['C:/old/sub-plugins/*'] }
 * 调用样例：
 *   const next = retireWorkspaceGlob(doc, repoRoot); if (next.changed) writeDoc(next.doc)
 */
export function retireWorkspaceGlob(doc, repoRoot, platform = process.platform) {
  const state = workspaceStateOf(doc, repoRoot, platform)
  if (state.ok) return { doc, changed: false, removed: [], state }
  const hit = new Set(state.repoGlobs)
  const base = (doc && typeof doc === 'object' && !Array.isArray(doc)) ? doc : {}
  return { doc: { ...base, packages: state.packages.filter((e) => !hit.has(e)) }, changed: true, removed: state.repoGlobs, state }
}

/**
 * 功能作用：判定一个子插件的 profile devDependency 是否已按当前协议就位（只读，不写文件）——
 *           absent（无键）/ fresh（spec 与期望的相对 link: 规格逐字相同，且目标目录存在）/
 *           stale-mismatch（仍是 workspace:*、绝对 link: 或别的规格，需要改写）/
 *           stale-unresolved（本仓库/本 profile 里连插件目录都不存在）/ unknown（IO 失败）。
 * 参数：
 *   manifest: object -- profile package.json，例 { devDependencies: { 'dsh-aaa': 'link:./node_modules/…' } }
 *   meta: object -- readPluginMeta() 的结果，例 { name: 'dsh-aaa', dirPath: 'D:/repo/sub-plugins/dsh-aaa' }
 *   expected: string -- linkDepSpec() 算出的期望规格；null/空 → 一律判为需要改写
 *   io: object -- { platform, exists, realpath }，默认真实文件系统（测试注入假实现）
 * 返回值：
 *   string -- DEP_STATES 之一，例 'stale-mismatch'
 * 调用样例：
 *   const state = depStateOf(manifest, meta, linkDepSpec(profileDir, meta))
 */
export function depStateOf(manifest, meta, expected, io = FS_IO) {
  const dev = (manifest && manifest.devDependencies) || {}
  const spec = dev[meta.name]
  if (typeof spec !== 'string' || spec.trim() === '') return DEP_STATES.absent
  if (typeof expected !== 'string' || expected === '' || spec !== expected) return DEP_STATES.mismatch
  try {
    if (!io.exists(meta.dirPath)) return DEP_STATES.unresolved
    return DEP_STATES.fresh
  } catch {
    return DEP_STATES.unknown
  }
}

/**
 * Compare one profile devDependency spec with the spec the manager now writes.
 * Returns null when there is nothing to repair (or when the package is not one
 * of our devDependencies); otherwise {from, to}. This is what makes enabling a
 * plugin rewrite the legacy `workspace:*` or absolute `link:` spec an older
 * install left behind — the migration path onto relative link: specs.
 */
export function staleDepSpec(manifest, meta, expected) {
  const dev = (manifest && manifest.devDependencies) || {}
  const current = dev[meta.name]
  if (typeof current !== 'string') return null
  if (typeof expected !== 'string' || expected === '' || current === expected) return null
  return { from: current, to: expected }
}

/** Human-facing reasons a stale dependency cannot be repaired automatically. */
export const REPAIR_REASONS = {
  [DEP_STATES.unresolved]: '实际目录不存在',
  [DEP_STATES.unknown]: '无法解析路径',
}

/**
 * 功能作用：按面板派生状态把待修复依赖分成「可自动修」与「只能提示」两类（纯函数）——
 *           auto = 规格仍不是 workspace:（如遗留 link:）或 workspace 锚点缺失，但本仓库里能唯一定位到实际目录；
 *           manual = 连实际目录都找不到（或路径解析失败），绝不猜路径。
 * 参数：
 *   derived: Array -- deriveStates() 的结果（每项带 depState/depDeclared/depExpected）
 * 返回值：
 *   { auto: Array, manual: Array, count: number, manualCount: number }
 *   例：repairPlan(states) → { auto: [2 项], manual: [1 项], count: 2, manualCount: 1 }
 * 调用样例：
 *   const plan = repairPlan(s.derived); if (plan.count > 0) await ensureDevDeps(c, plan.auto)
 */
export function repairPlan(derived) {
  const list = Array.isArray(derived) ? derived : []
  const auto = []
  const manual = []
  for (const p of list) {
    if (!p || p.dir === MANAGER_DIR) continue
    const entry = {
      dir: p.dir,
      name: p.name || p.dir,
      rowId: p.rowId,
      dirPath: p.dirPath,
      depState: p.depState,
      declared: typeof p.depDeclared === 'string' ? p.depDeclared : null,
      expected: typeof p.depExpected === 'string' ? p.depExpected : null,
    }
    if (p.depState === DEP_STATES.mismatch || p.depState === DEP_STATES.missing) auto.push(entry)
    else if (p.depState === DEP_STATES.unresolved || p.depState === DEP_STATES.unknown) {
      manual.push({ ...entry, reason: REPAIR_REASONS[p.depState] || p.depState })
    }
  }
  return { auto, manual, count: auto.length, manualCount: manual.length }
}

// --- repo scanning -----------------------------------------------------------

/**
 * Candidate roots that may hold plugin packages, most specific first:
 * `<repo>/sub-plugins` when it exists, then the legacy flat `<repo>` root. Both
 * are scanned so a half-migrated repo (some dirs still flat) stays fully usable
 * and the move can be done in any order.
 */
export function pluginRootsOf(repoRoot) {
  const nested = path.join(repoRoot, PLUGINS_DIRNAME)
  let hasNested = false
  try {
    hasNested = fs.statSync(nested).isDirectory()
  } catch {
    hasNested = false
  }
  return hasNested ? [nested, repoRoot] : [repoRoot]
}

/** Absolute directory of one plugin, preferring the nested layout when present. */
export function pluginAbsDirOf(repoRoot, dir) {
  for (const root of pluginRootsOf(repoRoot)) {
    const abs = path.join(root, dir)
    try {
      if (fs.statSync(abs).isDirectory()) return abs
    } catch {
      // try the next root
    }
  }
  return path.join(repoRoot, dir)
}

/**
 * dsh-* plugin directory names across the candidate roots, deduped by name
 * (the nested copy wins) and sorted. The manager's own dir and every
 * {@link RETIRED_PLUGIN_DIRS} entry are excluded: a retired plugin is still
 * source in the repo, but it is not a manageable plugin any more.
 */
export function listRepoPluginDirs(repoRoot) {
  const seen = new Set()
  for (const root of pluginRootsOf(repoRoot)) {
    let entries = []
    try {
      entries = fs.readdirSync(root, { withFileTypes: true })
    } catch {
      continue
    }
    for (const e of entries) {
      if (!e.isDirectory()) continue
      if (!e.name.startsWith(PLUGIN_DIR_PREFIX)) continue
      if (e.name === MANAGER_DIR) continue
      if (RETIRED_PLUGIN_DIRS.includes(e.name)) continue
      seen.add(e.name)
    }
  }
  return [...seen].sort()
}

/** Read one plugin's package.json metadata; invalid dirs are flagged, never throw. */
export function readPluginMeta(repoRoot, dir) {
  const dirPath = pluginAbsDirOf(repoRoot, dir)
  const pkgPath = path.join(dirPath, 'package.json')
  const base = {
    dir,
    dirPath,
    rowId: rowIdOfDir(dir),
    name: dir,
    description: '',
    hasClient: false,
    hasHost: false,
  }
  try {
    const pkg = JSON.parse(fs.readFileSync(pkgPath, 'utf8'))
    const name = typeof pkg.name === 'string' && pkg.name !== '' ? pkg.name : dir
    const description = typeof pkg.description === 'string' ? pkg.description : ''
    const hasClient = Boolean(pkg.dsh && pkg.dsh.client) || Boolean(pkg.exports && pkg.exports['./client'])
    const hasHost = typeof pkg.main === 'string' || Boolean(pkg.exports && pkg.exports['.'])
    return { ...base, valid: true, name, description, hasClient, hasHost }
  } catch {
    return { ...base, valid: false, error: 'no-plugin-package' }
  }
}

// --- profile manifest / patch file IO ----------------------------------------

/** profile package.json → object (missing/unreadable → {}). */
export function readManifest(file) {
  try {
    return JSON.parse(fs.readFileSync(file, 'utf8'))
  } catch {
    return {}
  }
}

/**
 * Build a YAML engine wrapper around the real js-yaml (mirrors
 * dsh-mcp-manager: JSON_SCHEMA extended with the `!!js` scalar type that maps
 * to/from `{ __jsExpr }`, whole-file dump with lineWidth 120).
 */
export function makeYamlEngine(jsyaml) {
  const isJsExpr = (value) => value instanceof Object && '__jsExpr' in value
  const JsExprType = new jsyaml.Type('tag:yaml.org,2002:js', {
    kind: 'scalar',
    resolve: (data) => typeof data === 'string',
    construct: (data) => ({ __jsExpr: data }),
    predicate: isJsExpr,
    represent: (data) => data.__jsExpr,
  })
  const ENTRY_LIST_SCHEMA = jsyaml.JSON_SCHEMA.extend(JsExprType)
  return {
    loadText(text) {
      const parsed = jsyaml.load(text, { schema: ENTRY_LIST_SCHEMA })
      if (parsed === undefined || parsed === null) return []
      if (!Array.isArray(parsed)) throw new Error('patch file must be a top-level array')
      return parsed
    },
    dumpText(rows) {
      return rows.length > 0 ? jsyaml.dump(rows, { schema: ENTRY_LIST_SCHEMA, lineWidth: 120 }) : '[]\n'
    },
    /** Plain-object load (pnpm-workspace.yaml and any non-list document). */
    loadDoc(text) {
      const parsed = jsyaml.load(text, { schema: ENTRY_LIST_SCHEMA })
      return (parsed && typeof parsed === 'object' && !Array.isArray(parsed)) ? parsed : {}
    },
    dumpDoc(doc) {
      return jsyaml.dump(doc, { schema: ENTRY_LIST_SCHEMA, lineWidth: 120 })
    },
  }
}

/** Load profile cordis.patch.yml rows (missing file = []). Throws on bad YAML. */
export function readPatchRows(yaml, file) {
  if (!fs.existsSync(file)) return []
  const text = fs.readFileSync(file, 'utf8')
  const trimmed = (text || '').trim()
  if (trimmed === '') return []
  return yaml.loadText(trimmed)
}

/** Persist rows back to the profile cordis.patch.yml (whole-file rewrite). */
export function writePatchRows(yaml, file, rows) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, yaml.dumpText(rows), 'utf8')
}

// --- pure row transforms (rows = parsed patch list) --------------------------

/** Locate a row by id: plain override row (`row.id`) or insert item (`insert[].id`). */
export function findRow(rows, id) {
  for (const row of rows) {
    if (!row || typeof row !== 'object') continue
    if (row.id === id) return { kind: 'row', row }
    if (Array.isArray(row.insert)) {
      const item = row.insert.find((e) => e && e.id === id)
      if (item) return { kind: 'item', row, item }
    }
  }
  return null
}

function withDisabled(item, disabled) {
  const next = { ...item }
  if (disabled) next.disabled = true
  else delete next.disabled
  return next
}

/**
 * Ensure a managed plugin exists as an insert item with the given enabled
 * state. Canonical storage is one `- insert:` row per plugin with item fields
 * {id, name, disabled?}. A pre-existing plain override row for the id is
 * converted (it can no longer target a bundle row once children move to
 * devDependencies). Returns a NEW rows array; never mutates input.
 */
export function upsertManaged(rows, id, name, enabled) {
  const found = findRow(rows, id)
  if (!found) {
    const item = { id, name }
    if (!enabled) item.disabled = true
    return [...rows, { insert: [item] }]
  }
  if (found.kind === 'item') {
    const item = withDisabled({ ...found.item, name }, !enabled)
    return rows.map((row) =>
      row === found.row
        ? { ...row, insert: row.insert.map((e) => (e === found.item ? item : e)) }
        : row,
    )
  }
  // plain override row → replace with a canonical insert item
  const rest = rows.filter((row) => row !== found.row)
  const item = { id, name }
  if (!enabled) item.disabled = true
  return [...rest, { insert: [item] }]
}

/** Remove every occurrence of a managed id (insert items + plain override rows). */
export function removeManaged(rows, id) {
  const out = []
  for (const row of rows) {
    if (!row || typeof row !== 'object') {
      out.push(row)
      continue
    }
    if (row.id === id) continue
    if (Array.isArray(row.insert)) {
      const filtered = row.insert.filter((e) => !(e && e.id === id))
      if (filtered.length === 0) continue
      out.push({ ...row, insert: filtered })
      continue
    }
    out.push(row)
  }
  return out
}

/**
 * Merge one requested switch state into the pending-intent list: intents are
 * keyed by row id, so re-clicking a row replaces its earlier intent instead of
 * queueing a second write. Returns a NEW list; never mutates input.
 */
export function mergeIntent(intents, intent) {
  const list = Array.isArray(intents) ? intents : []
  const id = String(intent && intent.id || '')
  const name = String(intent && intent.name || id)
  const enabled = !(intent && intent.enabled === false)
  return [...list.filter((it) => it && it.id !== id), { id, name, enabled }]
}

/**
 * 功能作用：把多条「目标开关状态」一次套用到 patch 行上（批量开关的单次落盘用）。
 * 参数：
 *   rows: Array -- 已解析的 patch 行数组，例如 [{ insert: [{ id: 'aaa', name: 'dsh-aaa' }] }]
 *   entries: Array -- 多个 { id, name, enabled } 意图，例如 [{ id: 'aaa', name: 'dsh-aaa', enabled: false }]
 * 返回值：
 *   Array -- 新的行数组（不修改入参）；逐条语义与 upsertManaged 完全一致
 * 调用样例：
 *   const next = upsertManagedMany(rows, targets.map((t) => ({ id: t.rowId, name: t.name, enabled: false })))
 */
export function upsertManagedMany(rows, entries) {
  let out = rows
  for (const e of Array.isArray(entries) ? entries : []) {
    if (!e || typeof e.id !== 'string' || e.id === '') continue
    out = upsertManaged(out, e.id, e.name || e.id, e.enabled !== false)
  }
  return out
}

/**
 * Apply pending intents onto parsed patch rows (pure). An empty list is the
 * identity transform; unknown ids become new canonical insert items, so a
 * queued intent is exactly what a later flush writes.
 * (Thin alias of upsertManagedMany — one implementation, two readings of it.)
 */
export function applyIntents(rows, intents) {
  return upsertManagedMany(rows, intents)
}

/** Drop plain override rows (non-insert) whose id is in the given set. */
export function stripOverrideRows(rows, ids) {
  const set = new Set(ids)
  return rows.filter((row) => !(row && typeof row === 'object' && !Array.isArray(row.insert) && set.has(row.id)))
}

// --- state derivation --------------------------------------------------------

/**
 * Derive the per-plugin panel state from repo metadata + profile manifest +
 * current patch rows.
 *
 * Takes profileDir so the expected devDependency spec (a relative link: into this
 * profile) can be derived per plugin; `workspace` is no longer an input — the
 * retired anchor never decides whether a dependency is fresh.
 *
 * Returns for each repo plugin: {dir,rowId,name,description,hasClient,valid,
 * error?, installed, installWhere:'dependencies'|'devDependencies'|null,
 * legacyBundle:boolean, hasRow, disabled, active, state, depState, depDeclared,
 * depExpected}
 * state ∈ active | disabled | legacy | uninstalled | invalid
 */
/** Raw devDependency spec of one package name (declared form), or undefined. */
function devSpecOf(manifest, name) {
  const dev = (manifest && manifest.devDependencies) || {}
  return dev[name]
}

export function deriveStates({ repoPlugins, manifest, rows, profileDir, io = FS_IO }) {
  const deps = new Set(Object.keys(manifest.dependencies || {}))
  const devDeps = new Set(Object.keys(manifest.devDependencies || {}))
  const bundles = Array.isArray(manifest.dsh && manifest.dsh.profile && manifest.dsh.profile.bundles)
    ? manifest.dsh.profile.bundles
    : []
  const bundleSet = new Set(bundles)

  return repoPlugins.map((p) => {
    if (!p.valid) {
      return { ...p, installed: false, installWhere: null, legacyBundle: false, hasRow: false, disabled: false, active: false, state: 'invalid' }
    }
    const found = findRow(rows, p.rowId)
    const hasRow = Boolean(found)
    const disabled = hasRow
      ? found.kind === 'row'
        ? found.row.disabled === true
        : found.item.disabled === true
      : false
    const inDeps = deps.has(p.name)
    const inDevDeps = devDeps.has(p.name)
    const installed = inDeps || inDevDeps
    const legacyBundle = bundleSet.has(p.name)

    // The spec this profile should carry for the package (null when it cannot be
    // derived — then any declared spec counts as stale).
    const expected = p.valid ? linkDepSpec(profileDir, p, io) : null

    let state
    if (legacyBundle) state = installed ? 'legacy' : 'uninstalled'
    else if (hasRow && !disabled) state = installed ? 'active' : 'uninstalled'
    else if (hasRow && disabled) state = installed ? 'disabled' : 'uninstalled'
    else state = installed ? 'inactive' : 'uninstalled'

    return {
      ...p,
      installed,
      installWhere: inDeps ? 'dependencies' : inDevDeps ? 'devDependencies' : null,
      legacyBundle,
      hasRow,
      disabled,
      active: state === 'active' || (state === 'legacy' && !disabled),
      state,
      // Dependency state is what makes "key exists" vs "declared the way this
      // repo needs" distinguishable: 'inactive' alone cannot tell "not installed"
      // from "installed through a legacy absolute link: spec".
      depState: depStateOf(manifest, p, expected, io),
      depDeclared: typeof devSpecOf(manifest, p.name) === 'string' ? devSpecOf(manifest, p.name) : null,
      depExpected: expected,
    }
  })
}

// --- batch switch planning (全部开启 / 全部关闭) ------------------------------

/**
 * 批量跳过原因的机器可读取值（宿主逐项回报与面板文案共用同一套词表）。
 */
export const BATCH_REASONS = {
  alreadyActive: 'already-active',
  alreadyDisabled: 'already-disabled',
  inactiveDepOnly: 'inactive-dep-only',
  notInstalled: 'not-installed',
  legacyLayout: 'legacy-layout',
  invalidDir: 'invalid-dir',
  /** 兜底：出现了 deriveStates 之外的未知状态。 */
  unsupportedState: 'unsupported-state',
}

/**
 * 功能作用：按面板派生状态算出一次批量动作的目标集与跳过集（纯函数；宿主执行与面板按钮计数共用同一口径，
 *           避免「按钮写 6 实际只动 4」）。
 * 参数：
 *   derived: Array -- deriveStates() 的结果，例如 [{ dir, rowId, name, state: 'active', valid: true, ... }]
 *   enabled: boolean -- true=全部开启（disabled + uninstalled），false=全部关闭（仅 active）
 * 返回值：
 *   { targets: [{ dir, rowId, name, hasClient, state, dirPath, needsInstall }], skipped: [{ dir, name, reason }], count: number }
 *   例：batchPlan(states, false) → { targets: [6 个 active], skipped: [legacy/invalid/inactive 项], count: 6 }
 * 调用样例：
 *   const plan = batchPlan(s.derived, false); if (plan.count === 0) return noop()
 */
export function batchPlan(derived, enabled) {
  const list = Array.isArray(derived) ? derived : []
  const open = enabled !== false
  const targets = []
  const skipped = []
  const skip = (p, reason) => skipped.push({
    dir: p.dir,
    name: p.name || p.dir,
    hasClient: Boolean(p.hasClient),
    reason,
  })

  for (const p of list) {
    if (!p || typeof p.dir !== 'string' || p.dir === '') continue
    const state = p.state
    if (!p.valid || state === 'invalid') { skip(p, BATCH_REASONS.invalidDir); continue }
    if (state === 'legacy' || p.legacyBundle === true) { skip(p, BATCH_REASONS.legacyLayout); continue }
    const staleLink = p.depState === DEP_STATES.mismatch || p.depState === DEP_STATES.missing
    if (open) {
      // 开启方向：动「已有行但停用」「从未安装」，外加「有激活行但链接陈旧」的项
      // （后者只修链接、把行写成 enabled，属于幂等写）；「未激活(仅依赖)」按约定
      // 不凭空补行——它的修复走单行开启或「重定位」。
      if (state === 'disabled' || state === 'uninstalled') {
        targets.push({
          dir: p.dir,
          rowId: p.rowId,
          name: p.name || p.dir,
          hasClient: Boolean(p.hasClient),
          dirPath: p.dirPath,
          state,
          needsInstall: state === 'uninstalled' || staleLink,
        })
        continue
      }
      if (staleLink && p.hasRow === true) {
        targets.push({
          dir: p.dir,
          rowId: p.rowId,
          name: p.name || p.dir,
          hasClient: Boolean(p.hasClient),
          dirPath: p.dirPath,
          state,
          needsInstall: true,
        })
        continue
      }
      if (state === 'active') { skip(p, BATCH_REASONS.alreadyActive); continue }
      if (state === 'inactive') { skip(p, BATCH_REASONS.inactiveDepOnly); continue }
      skip(p, BATCH_REASONS.unsupportedState)
      continue
    }
    // 关闭方向：只写「已激活」的行；其余保持原样。
    if (state === 'active') {
      targets.push({
        dir: p.dir,
        rowId: p.rowId,
        name: p.name || p.dir,
        hasClient: Boolean(p.hasClient),
        dirPath: p.dirPath,
        state,
        needsInstall: false,
      })
      continue
    }
    if (state === 'disabled') { skip(p, BATCH_REASONS.alreadyDisabled); continue }
    if (state === 'inactive') { skip(p, BATCH_REASONS.inactiveDepOnly); continue }
    if (state === 'uninstalled') { skip(p, BATCH_REASONS.notInstalled); continue }
    skip(p, BATCH_REASONS.unsupportedState)
  }

  return { enabled: open, targets, skipped, count: targets.length }
}

// --- bulk removal planning (全部移除) ----------------------------------------

/**
 * 「全部移除」的跳过原因（机器可读；与 BATCH_REASONS 分开是因为词表不同）。
 */
export const REMOVE_REASONS = {
  notInstalled: 'not-installed',
  legacyLayout: 'legacy-layout',
  invalidDir: 'invalid-dir',
  /** 兜底：出现了 deriveStates 之外的未知状态。 */
  unsupportedState: 'unsupported-state',
}

/**
 * 功能作用：按面板派生状态算出「全部移除」的目标集与跳过集（纯函数）。目标 = 在 profile 中留下
 *           痕迹的受管子插件（有激活行，或有 dependencies/devDependencies 键）——「未激活(仅依赖)」
 *           正是换机器/换 DSH_HOME 后遗留绝对 link: 的状态，必须计入。
 * 参数：
 *   derived: Array -- deriveStates() 的结果，例如 [{ dir:'dsh-aaa', rowId:'aaa', state:'active', installed:true, hasRow:true, ... }]
 * 返回值：
 *   { targets: [{ dir, rowId, name, hasClient, dirPath, state }], skipped: [{ dir, name, hasClient, reason }], count: number }
 *   例：removePlan(states) → { targets: [6 个有痕迹项], skipped: [未安装/旧布局/非插件目录], count: 6 }
 * 调用样例：
 *   const plan = removePlan(s.derived); if (plan.count === 0) return noop()
 */
export function removePlan(derived) {
  const list = Array.isArray(derived) ? derived : []
  const targets = []
  const skipped = []
  const skip = (p, reason) => skipped.push({
    dir: p.dir,
    name: p.name || p.dir,
    hasClient: Boolean(p.hasClient),
    reason,
  })

  for (const p of list) {
    if (!p || typeof p.dir !== 'string' || p.dir === '') continue
    const state = p.state
    if (!p.valid || state === 'invalid') { skip(p, REMOVE_REASONS.invalidDir); continue }
    if (state === 'legacy' || p.legacyBundle === true) { skip(p, REMOVE_REASONS.legacyLayout); continue }
    // 有痕迹 = 装过（依赖键在）或激活过（行在）；两者皆无则没有可清理的东西。
    const hasTrace = p.installed === true || p.hasRow === true
    if (!hasTrace) { skip(p, REMOVE_REASONS.notInstalled); continue }
    if (state !== 'active' && state !== 'disabled' && state !== 'inactive') {
      skip(p, REMOVE_REASONS.unsupportedState)
      continue
    }
    targets.push({
      dir: p.dir,
      rowId: p.rowId,
      name: p.name || p.dir,
      hasClient: Boolean(p.hasClient),
      dirPath: p.dirPath,
      state,
    })
  }

  return { targets, skipped, count: targets.length }
}

// --- migration planning ------------------------------------------------------

/**
 * Plan the one-click takeover of the legacy layout. Pure: returns the complete
 * new documents + a change summary; nothing is written here.
 *
 * Legacy layout = local children present in profile `dependencies` and/or
 * `dsh.profile.bundles`. Target layout = children in `devDependencies` only,
 * bundles keep only the manager, and every previously-active child is
 * represented by a canonical (non-disabled) managed row.
 */
/**
 * Plan the one-click takeover of the legacy layout. Pure: returns the complete
 * new documents + a change summary; nothing is written here.
 *
 * Legacy layout = local children present in profile `dependencies` and/or
 * `dsh.profile.bundles`, or carrying an absolute-path devDependency spec.
 * Target layout = children in `devDependencies` as relative `link:` specs into
 * this profile's own node_modules copy, the retired workspace anchor stripped out
 * of pnpm-workspace.yaml, bundles carrying only the manager, and every
 * previously-active child represented by a canonical (non-disabled) managed row.
 */
export function planMigration({ repoPlugins, manifest, rows, repoRoot, profileDir, managerId = MANAGER_ID, workspace, io = FS_IO }) {
  const deps = { ...(manifest.dependencies || {}) }
  const devDeps = { ...(manifest.devDependencies || {}) }
  const bundles = Array.isArray(manifest.dsh && manifest.dsh.profile && manifest.dsh.profile.bundles)
    ? [...manifest.dsh.profile.bundles]
    : []

  const moved = []
  const addedDev = []
  const relinkedDev = []
  const removedBundles = []
  const originalRowsJson = JSON.stringify(rows)

  const valid = repoPlugins.filter((p) => p.valid)

  // For each valid repo plugin, migrate any legacy presence.
  for (const p of valid) {
    const found = findRow(rows, p.rowId)
    const rowDisabled = found
      ? found.kind === 'row'
        ? found.row.disabled === true
        : found.item.disabled === true
      : false
    const inBundles = bundles.includes(p.name)
    const inDeps = Object.prototype.hasOwnProperty.call(deps, p.name)
    const inDevDeps = Object.prototype.hasOwnProperty.call(devDeps, p.name)

    // Spec pass, independent of the activation state: anything that is not the
    // relative link: spec this profile needs (legacy workspace:*, an absolute
    // link:, a version range) is rewritten. This is the repair an "installed on
    // another machine" profile needs, and it never changes whether the plugin is
    // active.
    const spec = linkDepSpec(profileDir, p, io)
    if (spec && inDevDeps && devDeps[p.name] !== spec) {
      devDeps[p.name] = spec
      relinkedDev.push(p.name)
    }

    // Never installed (no bundle, no dependency, no row) → leave alone.
    if (!inBundles && !inDeps && !found) continue

    if (inDeps) {
      delete deps[p.name]
      moved.push(p.name)
      if (!inDevDeps && spec) {
        devDeps[p.name] = spec
        addedDev.push(p.name)
      }
    } else if (inBundles && !inDevDeps && spec) {
      // bundle-only legacy presence without a dependency: declare it as a link devDep.
      devDeps[p.name] = spec
      addedDev.push(p.name)
    }
    if (inBundles) {
      bundles.splice(bundles.indexOf(p.name), 1)
      removedBundles.push(p.name)
    }
    // Canonical row reflecting the previously-intended state (disabled stays
    // disabled; everything else becomes an enabled insert item).
    rows = upsertManaged(rows, p.rowId, p.name, !rowDisabled)
  }

  // Remove any stale plain-override rows targeting migrated children.
  rows = stripOverrideRows(rows, valid.map((p) => p.rowId))

  // Retire the old umbrella bundle if a profile still carries it.
  if (bundles.includes('dsh-local-plugins')) {
    bundles.splice(bundles.indexOf('dsh-local-plugins'), 1)
    removedBundles.push('dsh-local-plugins')
  }
  if (Object.prototype.hasOwnProperty.call(deps, 'dsh-local-plugins')) {
    delete deps['dsh-local-plugins']
    moved.push('dsh-local-plugins')
  }
  if (Object.prototype.hasOwnProperty.call(devDeps, 'dsh-local-plugins')) {
    delete devDeps['dsh-local-plugins']
  }

  // Ensure the manager itself is the only local bundle entry.
  if (!bundles.includes(managerId)) {
    bundles.push(managerId)
  }

  // The workspace anchor is RETIRED: any leftover glob naming a clone of this
  // repo (this machine or a former one) is stripped from pnpm-workspace.yaml.
  // Nothing is added — relative link: specs need no workspace root.
  const wsNext = retireWorkspaceGlob(workspace || {}, repoRoot)

  const newManifest = {
    ...manifest,
    dependencies: deps,
    devDependencies: devDeps,
    dsh: {
      ...(manifest.dsh || {}),
      profile: {
        ...((manifest.dsh && manifest.dsh.profile) || {}),
        bundles,
      },
    },
  }

  const manifestChanged = JSON.stringify(newManifest) !== JSON.stringify(manifest)
  const rowsChanged = JSON.stringify(rows) !== originalRowsJson
  const needsMigration = manifestChanged || rowsChanged || wsNext.changed
  return {
    needsMigration,
    newManifest,
    finalRows: rows,
    newWorkspace: wsNext.doc,
    workspaceChanged: wsNext.changed,
    summary: {
      moved,
      addedDev,
      relinkedDev,
      removedBundles,
      workspaceChanged: wsNext.changed,
      retiredWorkspaceGlobs: wsNext.removed,
      bundlesAfter: bundles,
    },
  }
}
