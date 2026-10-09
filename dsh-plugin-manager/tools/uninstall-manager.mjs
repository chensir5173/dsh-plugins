// dsh-plugin-manager: one-command, self-contained uninstall.
//
// WHY THIS EXISTS
// The core CLI (dsh plugin --profile web remove dsh-plugin-manager) is a thin
// pnpm forwarder that only reconciles dsh.profile.bundles — it does not know
// about the activation rows this manager wrote into the profile cordis.patch.yml,
// and it does not touch the sub-plugins' devDependencies or the workspace anchor.
// Removing the manager alone therefore leaves dangling rows and unmanaged
// dependencies behind, and the next dsh web start fails with:
// failed to import loader entry <id> …: Cannot find package …
//
// This script does the whole job without the DSH host and without the dsh CLI: it
// removes every managed sub-plugin row plus the dependency keys pointing at this
// repository (workspace:* entries, and legacy link: specs into the repo), drops
// this repo's glob from the profile pnpm-workspace.yaml, then removes the manager
// dependency key and its
// dsh.profile.bundles entry, then runs ONE pnpm install.
//
// Safety: both profile files are backed up as <file>.bak-<ts> first; NOTHING is
// deleted from the filesystem (the installed snapshot disappears only because
// pnpm removes the dependency); other plugins' rows, keys and bundle entries are
// left byte-identical. Running it twice is an idempotent no-op.
//
// Usage (dry run is the default; pass --yes to actually uninstall):
//   node <this file> [--profile web] [--dry-run] [--yes] [--pnpm-cmd pnpm]
//
// ESM module; also importable — planUninstall / runUninstall are the testable
// core, the CLI at the bottom is a thin shell.

import fs from 'node:fs'
import path from 'node:path'
import { createRequire } from 'node:module'
import { spawnSync } from 'node:child_process'
import { fileURLToPath } from 'node:url'

import {
  DEFAULT_PROFILE,
  MANAGER_ID,
  YAML_PKG,
  dshHome,
  listRepoPluginDirs,
  makeYamlEngine,
  manifestPathOf,
  patchPathOf,
  pluginRootsOf,
  profileDirOf,
  readManifest,
  readPatchRows,
  readPluginMeta,
  removeManaged,
  repoRootOfPluginSrc,
  writePatchRows,
  isPluginGlobShape,
  pluginsGlobOf,
  samePath,
  WORKSPACE_FILE,
} from '../src/host-core.js'

const SEPARATOR = String.fromCharCode(92)
const SLASH = 47
const NEWLINE = String.fromCharCode(10)

/** Repo root as seen from this file: <repo> (or the installed clone root). */
export function repoRootFromHere(here = path.dirname(fileURLToPath(import.meta.url))) {
  return repoRootOfPluginSrc(path.join(here, '..', 'src'))
}

/** Where the panel/user should point at: this script inside the current install. */
export function scriptPathOf(repoRoot) {
  return path.join(repoRoot, 'dsh-plugin-manager', 'tools', 'uninstall-manager.mjs')
}

/** Normalize a path for comparison: forward slashes, no trailing separator. */
export function normalizeForCompare(value) {
  const forward = String(value).split(SEPARATOR).join('/')
  let end = forward.length
  while (end > 0 && forward.charCodeAt(end - 1) === SLASH) end -= 1
  return forward.slice(0, end)
}

/** Case-insensitive (win32/darwin) 'is inside one of these roots' check. */
export function insideRoots(target, roots, platform = process.platform) {
  const caseInsensitive = platform === 'win32' || platform === 'darwin'
  const norm = (value) => {
    const text = normalizeForCompare(value)
    return caseInsensitive ? text.toLowerCase() : text
  }
  const t = norm(target)
  return roots.some((root) => {
    const r = norm(root)
    return t === r || t.indexOf(r + '/') === 0
  })
}

/** Resolve the profile files this script will edit. */
export function resolveProfile({ home = dshHome(), profile = DEFAULT_PROFILE } = {}) {
  return {
    home,
    profileName: profile,
    profileDir: profileDirOf(home, profile),
    patchFile: patchPathOf(home, profile),
    manifestFile: manifestPathOf(home, profile),
    workspaceFile: path.join(profileDirOf(home, profile), WORKSPACE_FILE),
  }
}

/** Load the profile's own js-yaml (the same contract the host half uses). */
export function loadYamlEngine(profileDir) {
  try {
    const req = createRequire(path.join(profileDir, 'package.json'))
    const jsyaml = req(YAML_PKG)
    if (jsyaml && typeof jsyaml.load === 'function' && typeof jsyaml.dump === 'function') {
      return { engine: makeYamlEngine(jsyaml), error: null }
    }
    return { engine: null, error: YAML_PKG + ' has no load/dump' }
  } catch (error) {
    const message = (error && error.message) ? error.message : String(error)
    return { engine: null, error: 'cannot resolve ' + YAML_PKG + ' from the profile: ' + message }
  }
}

/** One row id, whichever row shape it is. */
function rowIdOf(entry) {
  if (!entry || typeof entry !== 'object') return null
  return typeof entry.id === 'string' ? entry.id : null
}

/**
 * 功能作用：算出这次卸载将删除什么（只读）——受管子插件的激活行、指向本仓库的 link 依赖键、
 *           管理器自身的依赖键，以及 dsh.profile.bundles 里的管理器条目；其它行/键/条目一概不动。
 * 参数：
 *   { profileDir, repoRoot, engine, profile, home } -- profile 目录、仓库根、yaml 引擎、profile 名、DSH_HOME
 * 返回值：
 *   { rowIds, depNames, nextRows, nextManifest, summary }
 *   例：planUninstall({...}).summary -> { rows: 7, deps: 7, managerEntry: true, installs: true }
 * 调用样例：
 *   const plan = planUninstall({ profileDir, repoRoot, engine })
 */
export function planUninstall({ profileDir, repoRoot, engine, profile = DEFAULT_PROFILE, home = dshHome(process.env) }) {
  const patchFile = patchPathOf(home, profile)
  const manifestFile = manifestPathOf(home, profile)
  const manifest = readManifest(manifestFile)
  const rows = readPatchRows(engine, patchFile)
  const roots = pluginRootsOf(repoRoot)
  const managed = listRepoPluginDirs(repoRoot)
    .map((dir) => readPluginMeta(repoRoot, dir))
    .filter((meta) => meta.valid)
  const managedIds = new Set(managed.map((meta) => meta.rowId))

  const rowIds = []
  for (const entry of rows) {
    const id = rowIdOf(entry)
    if (id !== null && managedIds.has(id)) rowIds.push(id)
    if (Array.isArray(entry && entry.insert)) {
      for (const item of entry.insert) {
        const itemId = rowIdOf(item)
        if (itemId !== null && managedIds.has(itemId)) rowIds.push(itemId)
      }
    }
  }

  // A managed dependency key is either one of THIS repo's plugin packages (the
  // workspace:* form carries no path, so the package name is the only handle) or a
  // legacy absolute link: spec pointing into the repo (pre-migration profiles).
  const managedNames = new Set(managed.map((meta) => meta.name))
  const depNames = []
  for (const field of ['dependencies', 'devDependencies']) {
    const map = manifest[field] || {}
    for (const [name, spec] of Object.entries(map)) {
      if (name === MANAGER_ID) continue
      if (depNames.includes(name)) continue
      if (managedNames.has(name)) { depNames.push(name); continue }
      if (typeof spec !== 'string' || spec.indexOf('link:') !== 0) continue
      const target = spec.slice('link:'.length)
      if (insideRoots(target, roots)) depNames.push(name)
    }
  }

  const bundles = Array.isArray(manifest.dsh && manifest.dsh.profile && manifest.dsh.profile.bundles)
    ? manifest.dsh.profile.bundles
    : []
  const managerEntry = bundles.includes(MANAGER_ID)
  const managerDependency = Object.prototype.hasOwnProperty.call(manifest.dependencies || {}, MANAGER_ID)
    || Object.prototype.hasOwnProperty.call(manifest.devDependencies || {}, MANAGER_ID)

  let nextRows = rows
  for (const id of rowIds) nextRows = removeManaged(nextRows, id)

  const nextManifest = { ...manifest }
  const nextDeps = { ...(manifest.dependencies || {}) }
  const nextDevDeps = { ...(manifest.devDependencies || {}) }
  for (const name of depNames) { delete nextDeps[name]; delete nextDevDeps[name] }
  delete nextDeps[MANAGER_ID]
  delete nextDevDeps[MANAGER_ID]
  nextManifest.dependencies = nextDeps
  nextManifest.devDependencies = nextDevDeps
  if (manifest.dsh) {
    nextManifest.dsh = {
      ...manifest.dsh,
      profile: { ...(manifest.dsh.profile || {}), bundles: bundles.filter((name) => name !== MANAGER_ID) },
    }
  }

  // The workspace anchor: this repo contributed one glob to the profile
  // pnpm-workspace.yaml. Drop it (shape-matched, so a glob left behind by an older
  // clone location goes too); every other entry and key stays byte-identical.
  const workspaceFile = path.join(profileDir, WORKSPACE_FILE)
  let workspaceDoc = null
  let nextWorkspaceDoc = null
  try {
    if (fs.existsSync(workspaceFile) && engine && typeof engine.loadDoc === 'function') {
      const wsText = fs.readFileSync(workspaceFile, 'utf8')
      if (wsText.trim() !== '') {
        const doc = engine.loadDoc(wsText)
        if (Array.isArray(doc.packages)) {
          const kept = doc.packages.filter((e) => typeof e !== 'string' || (!isPluginGlobShape(e) && !samePath(e, pluginsGlobOf(repoRoot))))
          workspaceDoc = doc
          nextWorkspaceDoc = { ...doc, packages: kept }
        }
      }
    }
  } catch {
    workspaceDoc = null
    nextWorkspaceDoc = null
  }
  const workspaceChanged = Boolean(workspaceDoc && nextWorkspaceDoc && workspaceDoc.packages.length !== nextWorkspaceDoc.packages.length)

  return {
    profileDir,
    profileName: profile,
    patchFile,
    manifestFile,
    workspaceFile,
    repoRoot,
    rows,
    nextRows,
    manifest,
    nextManifest,
    rowIds,
    depNames,
    managerEntry,
    managerDependency,
    workspaceDoc,
    nextWorkspaceDoc,
    workspaceChanged,
    summary: {
      rows: rowIds.length,
      deps: depNames.length,
      managerEntry: managerEntry || managerDependency,
      workspaceChanged,
      installs: rowIds.length > 0 || depNames.length > 0 || managerEntry || managerDependency || workspaceChanged,
    },
  }
}

/** Timestamped sibling backup (same naming as the host half). */
export function backupFile(file) {
  if (!fs.existsSync(file)) return null
  const stamp = new Date().toISOString().split(':').join('-').split('.').join('-')
  const dest = file + '.bak-' + stamp
  fs.copyFileSync(file, dest)
  return dest
}

/** Pretty JSON write for the profile manifest (2-space indent + trailing newline). */
export function writeJsonPretty(file, obj) {
  fs.mkdirSync(path.dirname(file), { recursive: true })
  fs.writeFileSync(file, JSON.stringify(obj, null, 2) + NEWLINE, 'utf8')
}

/**
 * 功能作用：执行一次卸载——写前备份两份文件、各写一次、跑一次 pnpm install；失败时如实回报并给出
 *           重跑一次 pnpm install 的收尾命令（此时行与键已清干净，不留半态）。
 * 参数：
 *   plan: object -- planUninstall() 的结果
 *   { pnpm, dryRun, engine } -- 注入的安装执行器与干跑开关
 * 返回值：
 *   { dryRun?, noop?, wrote, installed, backups, error?, retry? }
 * 调用样例：
 *   const result = await runUninstall(plan, { pnpm: defaultPnpmRunner })
 */
export async function runUninstall(plan, { pnpm, dryRun = false, engine } = {}) {
  if (dryRun) return { dryRun: true, noop: false, wrote: false, installed: false, plan: plan.summary }
  if (plan.rowIds.length === 0 && plan.depNames.length === 0 && !plan.summary.managerEntry && !plan.workspaceChanged) {
    return { dryRun: false, noop: true, wrote: false, installed: false }
  }
  const backups = []
  const backedManifest = backupFile(plan.manifestFile)
  if (backedManifest !== null) backups.push(backedManifest)
  const backedPatch = backupFile(plan.patchFile)
  if (backedPatch !== null) backups.push(backedPatch)

  let wrote = false
  if (plan.rowIds.length > 0) {
    try {
      writePatchRows(engine, plan.patchFile, plan.nextRows)
      wrote = true
    } catch (error) {
      const message = (error && error.message) ? error.message : String(error)
      return { noop: false, wrote, installed: false, backups, error: 'patch write failed: ' + message }
    }
  }
  try {
    writeJsonPretty(plan.manifestFile, plan.nextManifest)
    wrote = true
  } catch (error) {
    const message = (error && error.message) ? error.message : String(error)
    return { noop: false, wrote, installed: false, backups, error: 'manifest write failed: ' + message }
  }
  if (plan.workspaceChanged && plan.nextWorkspaceDoc) {
    const backedWorkspace = backupFile(plan.workspaceFile)
    if (backedWorkspace !== null) backups.push(backedWorkspace)
    try {
      fs.writeFileSync(plan.workspaceFile, engine.dumpDoc(plan.nextWorkspaceDoc), 'utf8')
      wrote = true
    } catch (error) {
      const message = (error && error.message) ? error.message : String(error)
      return { noop: false, wrote, installed: false, backups, error: 'workspace write failed: ' + message }
    }
  }

  const runner = typeof pnpm === 'function' ? pnpm : defaultPnpmRunner
  const res = await runner(plan.profileDir)
  if (!res || res.ok !== true) {
    const detail = res && (res.error || res.stderr) ? (res.error || res.stderr) : 'pnpm install failed'
    return {
      noop: false,
      wrote,
      installed: false,
      backups,
      error: detail,
      retry: 'pnpm install --dir "' + plan.profileDir + '"',
    }
  }
  return { noop: false, wrote, installed: true, backups }
}

/** Default install executor: one pnpm install in the profile directory. */
export function defaultPnpmRunner(profileDir, cmd = 'pnpm') {
  const res = spawnSync(cmd, ['install'], { cwd: profileDir, shell: process.platform === 'win32', encoding: 'utf8' })
  if (res.error) return { ok: false, code: null, error: res.error.message }
  return { ok: res.status === 0, code: res.status, stderr: res.stderr || '', stdout: res.stdout || '' }
}

// --- CLI ---------------------------------------------------------------------

function parseArgs(argv) {
  const out = { profile: DEFAULT_PROFILE, dryRun: false, yes: false, pnpmCmd: 'pnpm' }
  for (let i = 0; i < argv.length; i += 1) {
    const arg = argv[i]
    if (arg === '--profile') { out.profile = String(argv[i + 1] || DEFAULT_PROFILE); i += 1; continue }
    if (arg === '--pnpm-cmd') { out.pnpmCmd = String(argv[i + 1] || 'pnpm'); i += 1; continue }
    if (arg === '--dry-run') { out.dryRun = true; continue }
    if (arg === '--yes' || arg === '-y') { out.yes = true; continue }
    if (arg === '--help' || arg === '-h') { out.help = true; continue }
  }
  return out
}

async function main() {
  const args = parseArgs(process.argv.slice(2))
  const repoRoot = repoRootFromHere()
  const target = resolveProfile({ profile: args.profile })
  if (args.help) {
    process.stdout.write('usage: node uninstall-manager.mjs [--profile web] [--dry-run] [--yes] [--pnpm-cmd pnpm]' + NEWLINE)
    return 0
  }
  const loaded = loadYamlEngine(target.profileDir)
  if (!loaded.engine) {
    process.stderr.write('dsh-plugin-manager uninstall: ' + loaded.error + NEWLINE)
    return 2
  }
  const plan = planUninstall({ profileDir: target.profileDir, repoRoot, engine: loaded.engine, profile: args.profile })
  const s = plan.summary
  process.stdout.write('profile: ' + target.profileDir + NEWLINE)
  process.stdout.write('will remove: ' + s.rows + ' activation row(s), ' + s.deps + ' dependency key(s), manager entry: ' + (s.managerEntry ? 'yes' : 'no') + '; pnpm install: ' + (s.installs ? 'yes (once)' : 'no') + NEWLINE)
  process.stdout.write('source directories are never deleted.' + NEWLINE)
  if (!args.yes) {
    process.stdout.write('dry run — pass --yes to execute.' + NEWLINE)
    return 0
  }
  const result = await runUninstall(plan, {
    engine: loaded.engine,
    dryRun: args.dryRun,
    pnpm: (dir) => defaultPnpmRunner(dir, args.pnpmCmd),
  })
  if (result.noop) {
    process.stdout.write('nothing to remove — already uninstalled (noop).' + NEWLINE)
    return 0
  }
  if (result.error) {
    process.stderr.write('uninstall failed: ' + result.error + NEWLINE)
    if (result.retry) process.stderr.write('rows and keys are already clean — finish with: ' + result.retry + NEWLINE)
    return 1
  }
  process.stdout.write('removed ' + plan.rowIds.length + ' row(s), ' + plan.depNames.length + ' dependency key(s), manager entry: ' + (s.managerEntry ? 'yes' : 'no') + '; pnpm install ran once.' + NEWLINE)
  process.stdout.write('backups: ' + ((result.backups || []).join(', ') || '(none needed)') + NEWLINE)
  process.stdout.write('restart dsh web to pick up the removal.' + NEWLINE)
  return 0
}

if (process.argv[1] && path.resolve(process.argv[1]) === path.resolve(fileURLToPath(import.meta.url))) {
  main().then((code) => { process.exitCode = code }, (error) => {
    process.stderr.write('uninstall crashed: ' + ((error && error.stack) || String(error)) + NEWLINE)
    process.exitCode = 1
  })
}
