// dsh-plugin-manager: SAFE UPDATE half — PREPARE the update, never apply it here.
//
// WHY THIS FILE EXISTS (2026-10-14)
// Both the market and the official plugin manager run pnpm WHILE DSH is running.
// On Windows the files pnpm must replace are the ones DSH has loaded, so pnpm
// retries or stalls and the app looks frozen: the user's report was
// 「更新了 plugins 插件后卡住 DSH Desktop，只能重启」. A better progress bar does not
// fix that; moving the disk write to a moment when nothing holds those files does.
//
// So this module only PREPARES. It turns the profile's installed dependencies into
//   (a) a pending record   <profile>/.plugin-manager/update-pending.json
//   (b) a self-contained script  <profile>/.plugin-manager/apply-update.cmd|.sh
// that waits for DSH to be gone, backs up the profile manifests, runs ONE install
// and appends the outcome to update-apply.ndjson.
//
// BOUNDARY (locked down by test/safe-update.test.mjs): prepareSafeUpdate() touches
// exactly those two files. It never runs pnpm, never writes node_modules, and never
// rewrites package.json / cordis.patch.yml. A user who never runs the script has
// changed nothing but two files inside .plugin-manager/.
//
// The update argument is derived from the INSTALLED spec, not from client input:
// the panel can only name a dependency that the profile manifest already declares,
// so a request can never inject an arbitrary command into the generated script.

import fs from 'node:fs'
import path from 'node:path'

export const UPDATE_DIRNAME = '.plugin-manager'
export const PENDING_FILE = 'update-pending.json'
export const LOG_FILE = 'update-apply.ndjson'
export const SCRIPT_NAMES = { win32: 'apply-update.cmd', posix: 'apply-update.sh' }
/** How long the script waits for DSH to exit before giving up (seconds). */
export const MAX_WAIT_SECONDS = 300
/** Poll interval of that wait loop (seconds). */
export const WAIT_POLL_SECONDS = 2

/** Directory that holds every file this module writes. */
export function updateDirOf(profileDir) { return path.join(profileDir, UPDATE_DIRNAME) }
export function pendingPathOf(profileDir) { return path.join(updateDirOf(profileDir), PENDING_FILE) }
export function logPathOf(profileDir) { return path.join(updateDirOf(profileDir), LOG_FILE) }
export function scriptPathOf(profileDir, platform = process.platform) {
  return path.join(updateDirOf(profileDir), platform === 'win32' ? SCRIPT_NAMES.win32 : SCRIPT_NAMES.posix)
}

/** Profile names end up inside a generated shell script — never accept anything else. */
export function isSafeProfileName(name) {
  return typeof name === 'string' && /^[A-Za-z0-9._-]{1,64}$/.test(name) && name !== '.' && name !== '..'
}

// --- which dependencies can be updated at all ---------------------------------

/**
 * 功能作用：判断一条依赖 spec 的种类（决定它能不能被「退出后更新」，以及该用什么参数更新）。
 * 参数：spec: string -- profile manifest 里的依赖值，例如 'github:o/r#abc'、'^1.2.3'、'link:../x'
 * 返回值：'link' | 'workspace' | 'file' | 'git' | 'registry'
 * 调用样例：depKindOf('github:chensir5173/dsh-plugins')  // 'git'
 */
export function depKindOf(spec) {
  const s = String(spec == null ? '' : spec).trim()
  if (s.startsWith('link:')) return 'link'
  if (s.startsWith('workspace:')) return 'workspace'
  if (s.startsWith('file:')) return 'file'
  if (/^(github:|gitlab:|bitbucket:|gist:|git\+|git:|https?:\/\/.*\.git)/i.test(s)) return 'git'
  return 'registry'
}

/** Local sources are maintained by this manager itself; the safe updater must not touch them. */
export function isUpdatableKind(kind) { return kind === 'git' || kind === 'registry' }

/**
 * 功能作用：把「已声明的 spec」转成「取最新」的更新参数（git 去掉 commit 钉、registry 取 latest）。
 * 参数：name: string -- 包名；spec: string -- 当前声明；kind?: string -- depKindOf(spec)
 * 返回值：string -- 直接交给 `pnpm add` / `dsh plugin add` 的 spec
 * 调用样例：updateArgFor('dsh-plugin-manager', 'github:o/r#4c4325f')  // 'github:o/r'
 */
export function updateArgFor(name, spec, kind) {
  const k = kind || depKindOf(spec)
  const s = String(spec == null ? '' : spec).trim()
  if (k === 'git') return s.replace(/#.*$/, '')
  if (s.startsWith('npm:')) return s
  return `${name}@latest`
}

/**
 * 功能作用：列出 profile manifest 里可安全更新的依赖（排除 link/workspace/file 与非法项）。
 * 参数：manifest: object -- profile package.json 解析结果
 * 返回值：Array<{ name, spec, kind, arg, scope }>（按包名排序）
 * 调用样例：safeUpdateTargets(manifest).map((x) => x.name)
 */
export function safeUpdateTargets(manifest) {
  const m = manifest && typeof manifest === 'object' ? manifest : {}
  const out = []
  const seen = new Set()
  for (const scope of ['dependencies', 'devDependencies']) {
    const block = m[scope]
    if (!block || typeof block !== 'object') continue
    for (const [name, spec] of Object.entries(block)) {
      if (seen.has(name)) continue
      seen.add(name)
      const kind = depKindOf(spec)
      if (!isUpdatableKind(kind)) continue
      if (!name || /[\s"'`$;&|<>]/.test(name)) continue
      out.push({ name, spec: String(spec), kind, arg: updateArgFor(name, spec, kind), scope })
    }
  }
  return out.sort((a, b) => a.name.localeCompare(b.name))
}

/** Default selection: the manager itself when it is installed through a remote spec. */
export function suggestedTargets(targets) {
  const list = Array.isArray(targets) ? targets : []
  const self = list.find((x) => x.name === 'dsh-plugin-manager')
  return self ? [self.name] : []
}

/**
 * 功能作用：把「用户勾选的名字」解析成更新计划（名字必须已经在 manifest 里声明）。
 * 参数：manifest: object；names: string[] -- 勾选的包名
 * 返回值：{ targets, skipped, error } -- skipped = [{name, reason}]，reason: 'unknown' | 'local-source'
 * 调用样例：buildUpdatePlan(manifest, ['dsh-plugin-manager'])
 */
export function buildUpdatePlan(manifest, names) {
  const all = safeUpdateTargets(manifest)
  const byName = new Map(all.map((x) => [x.name, x]))
  const m = manifest && typeof manifest === 'object' ? manifest : {}
  const declared = new Set([
    ...Object.keys(m.dependencies && typeof m.dependencies === 'object' ? m.dependencies : {}),
    ...Object.keys(m.devDependencies && typeof m.devDependencies === 'object' ? m.devDependencies : {}),
  ])
  const wanted = Array.isArray(names) ? names.map((n) => String(n)) : []
  const targets = []
  const skipped = []
  const seen = new Set()
  for (const name of wanted) {
    if (seen.has(name)) continue
    seen.add(name)
    const hit = byName.get(name)
    if (hit) { targets.push(hit); continue }
    skipped.push({ name, reason: declared.has(name) ? 'local-source' : 'unknown' })
  }
  if (targets.length === 0) {
    return { targets: [], skipped, error: skipped.length > 0 ? `no updatable target selected (${skipped.map((s) => `${s.name}: ${s.reason}`).join(', ')})` : 'no target selected' }
  }
  return { targets, skipped, error: null }
}

// --- pending record -----------------------------------------------------------

/**
 * 功能作用：读回待更新的记录（不存在/损坏 → null，绝不抛）。
 * 参数：profileDir: string
 * 返回值：object|null
 * 调用样例：readPending('C:/Users/x/.dsh/profiles/desktop')?.targets
 */
export function readPending(profileDir) {
  try {
    const raw = fs.readFileSync(pendingPathOf(profileDir), 'utf8')
    const doc = JSON.parse(raw)
    return doc && typeof doc === 'object' && Array.isArray(doc.targets) ? doc : null
  } catch {
    return null
  }
}

/**
 * 功能作用：构造待更新记录（纯函数，不落盘）。
 * 参数：见下方字段；now?: number -- 测试可注入时间戳
 * 返回值：object -- 记录（含 scriptPath / logPath / targets）
 * 调用样例：buildPendingRecord({ profileDir, profileName: 'desktop', targets, hostPid: 4412, hostPort: 19387 })
 */
export function buildPendingRecord(input = {}) {
  const profileDir = String(input.profileDir || '')
  const platform = input.platform === 'win32' ? 'win32' : 'posix'
  const at = new Date(typeof input.now === 'number' ? input.now : Date.now()).toISOString()
  return {
    v: 1,
    at,
    manager: 'dsh-plugin-manager',
    profileName: String(input.profileName || ''),
    profileDir,
    platform,
    hostPid: Number.isFinite(input.hostPid) ? input.hostPid : null,
    hostPort: Number.isFinite(input.hostPort) ? input.hostPort : null,
    maxWaitSeconds: MAX_WAIT_SECONDS,
    targets: (Array.isArray(input.targets) ? input.targets : []).map((x) => ({ name: x.name, spec: x.spec, kind: x.kind, arg: x.arg })),
    scriptPath: scriptPathOf(profileDir, platform),
    pendingPath: pendingPathOf(profileDir),
    logPath: logPathOf(profileDir),
  }
}

// --- script rendering ---------------------------------------------------------

const stampOf = (iso) => String(iso).replace(/[:.]/g, '-').replace('T', '_').replace('Z', '')

/**
 * 功能作用：渲染 Windows 批处理更新脚本（等 DSH 退出 → 备份 → 一次安装 → 写日志）。
 * 参数：record: object -- buildPendingRecord() 的结果
 * 返回值：string -- .cmd 文本
 * 调用样例：fs.writeFileSync(scriptPathOf(dir, 'win32'), renderCmdScript(record))
 */
export function renderCmdScript(record) {
  const r = record || {}
  const profileDir = String(r.profileDir || '')
  const profileName = String(r.profileName || '')
  const logPath = String(r.logPath || logPathOf(profileDir))
  const stamp = stampOf(r.at || new Date().toISOString())
  const ticks = Math.max(1, Math.round((Number(r.maxWaitSeconds) || MAX_WAIT_SECONDS) / WAIT_POLL_SECONDS))
  const targets = Array.isArray(r.targets) ? r.targets : []
  const guard = !isSafeProfileName(profileName)
  const lines = []
  lines.push('@echo off')
  lines.push('chcp 65001 >nul')
  lines.push('setlocal enableextensions')
  lines.push('title dsh-plugin-manager safe update')
  lines.push(`rem generated ${r.at || ''} by dsh-plugin-manager`)
  lines.push(`rem targets: ${targets.map((x) => x.name).join(', ')}`)
  lines.push('rem This script replaces files ONLY while DeepSeek Harness is not running.')
  lines.push('')
  lines.push(`set "PROFILE=${profileDir}"`)
  lines.push(`set "LOG=${logPath}"`)
  lines.push(`set "STAMP=${stamp}"`)
  lines.push(`set "PID=${r.hostPid == null ? '' : r.hostPid}"`)
  lines.push(`set "PORT=${r.hostPort == null ? '' : r.hostPort}"`)
  lines.push(`set "TICKS=${ticks}"`)
  lines.push(`set "NAME=${guard ? '' : profileName}"`)
  lines.push('')
  lines.push('echo [safe-update] profile: %PROFILE%')
  lines.push('if not exist "%PROFILE%\\package.json" (echo [safe-update] package.json not found & exit /b 1)')
  lines.push('cd /d "%PROFILE%"')
  lines.push('')
  lines.push('rem --- 1) wait until DeepSeek Harness is gone ------------------------------')
  lines.push('if "%PID%%PORT%"=="" goto applying')
  lines.push('echo [safe-update] waiting for DeepSeek Harness to exit (pid %PID%, port %PORT%)...')
  lines.push('set /a WAITED=0')
  lines.push(':waitloop')
  lines.push('set "BUSY="')
  lines.push('if not "%PID%"=="" (tasklist /FI "PID eq %PID%" 2>nul | find "%PID%" >nul && set "BUSY=1")')
  lines.push('if not "%PORT%"=="" (netstat -ano | findstr ":%PORT%" | findstr "LISTENING" >nul && set "BUSY=1")')
  lines.push('if not defined BUSY goto applying')
  lines.push('set /a WAITED+=1')
  lines.push('if %WAITED% GEQ %TICKS% goto timeout')
  lines.push('timeout /t 2 /nobreak >nul')
  lines.push('goto waitloop')
  lines.push('')
  lines.push(':applying')
  lines.push('echo [safe-update] no running DeepSeek Harness detected; applying now.')
  lines.push('call :log apply-start')
  lines.push('copy /Y "%PROFILE%\\package.json" "%PROFILE%\\package.json.bak-%STAMP%" >nul')
  lines.push('if exist "%PROFILE%\\pnpm-lock.yaml" copy /Y "%PROFILE%\\pnpm-lock.yaml" "%PROFILE%\\pnpm-lock.yaml.bak-%STAMP%" >nul')
  lines.push('')
  lines.push('rem --- 2) one install per target ------------------------------------------')
  lines.push('set "RC=0"')
  lines.push('where pnpm >nul 2>nul')
  lines.push('if errorlevel 1 goto use_dsh')
  for (const t of targets) {
    lines.push(`echo [safe-update] run: pnpm add "${t.arg}"`)
    lines.push(`pnpm add "${t.arg}"`)
    lines.push('if errorlevel 1 set "RC=1"')
  }
  lines.push('goto settle')
  lines.push('')
  lines.push(':use_dsh')
  lines.push('where dsh >nul 2>nul')
  lines.push('if errorlevel 1 (echo [safe-update] neither pnpm nor dsh is on PATH. & call :log runner-missing & exit /b 1)')
  lines.push('echo [safe-update] pnpm not found on PATH; falling back to the dsh CLI.')
  for (const t of targets) {
    lines.push(`echo [safe-update] run: dsh plugin --profile %NAME% add "${t.arg}"`)
    lines.push(`dsh plugin --profile %NAME% add "${t.arg}"`)
    lines.push('if errorlevel 1 set "RC=1"')
  }
  lines.push('')
  lines.push(':settle')
  lines.push('if not "%RC%"=="0" goto failed')
  lines.push('call :log apply-ok')
  lines.push('echo [safe-update] update applied. Start DeepSeek Harness again.')
  lines.push('goto end')
  lines.push('')
  lines.push(':failed')
  lines.push('call :log apply-failed')
  lines.push('echo [safe-update] one or more steps FAILED. Backups:')
  lines.push('echo [safe-update]   %PROFILE%\\package.json.bak-%STAMP%')
  lines.push('echo [safe-update]   %PROFILE%\\pnpm-lock.yaml.bak-%STAMP%')
  lines.push('echo [safe-update] to roll back: copy /Y "%PROFILE%\\package.json.bak-%STAMP%" "%PROFILE%\\package.json" then pnpm install')
  lines.push('goto end')
  lines.push('')
  lines.push(':timeout')
  lines.push('call :log apply-timeout')
  lines.push('echo [safe-update] TIMEOUT: DeepSeek Harness is still running.')
  lines.push('echo [safe-update] Quit it completely (check the tray), then run this script again.')
  lines.push('goto end')
  lines.push('')
  lines.push(':log')
  lines.push('>>"%LOG%" echo {"at":"%DATE% %TIME%","event":"%~1","profile":"%NAME%"}')
  lines.push('exit /b 0')
  lines.push('')
  lines.push(':end')
  lines.push('pause')
  return lines.join('\r\n') + '\r\n'
}

/**
 * 功能作用：渲染 POSIX shell 更新脚本（与 .cmd 同语义）。
 * 参数：record: object
 * 返回值：string -- .sh 文本
 * 调用样例：fs.writeFileSync(scriptPathOf(dir, 'posix'), renderShScript(record), { mode: 0o755 })
 */
export function renderShScript(record) {
  const r = record || {}
  const profileDir = String(r.profileDir || '')
  const profileName = String(r.profileName || '')
  const logPath = String(r.logPath || logPathOf(profileDir))
  const stamp = stampOf(r.at || new Date().toISOString())
  const ticks = Math.max(1, Math.round((Number(r.maxWaitSeconds) || MAX_WAIT_SECONDS) / WAIT_POLL_SECONDS))
  const targets = Array.isArray(r.targets) ? r.targets : []
  const guard = !isSafeProfileName(profileName)
  const q = (s) => `'${String(s).replace(/'/g, `'\\''`)}'`
  const lines = []
  lines.push('#!/bin/sh')
  lines.push('# generated ' + (r.at || '') + ' by dsh-plugin-manager')
  lines.push('# targets: ' + targets.map((x) => x.name).join(', '))
  lines.push('# This script replaces files ONLY while DeepSeek Harness is not running.')
  lines.push(`PROFILE=${q(profileDir)}`)
  lines.push(`LOG=${q(logPath)}`)
  lines.push(`STAMP=${q(stamp)}`)
  lines.push(`PID=${q(r.hostPid == null ? '' : String(r.hostPid))}`)
  lines.push(`PORT=${q(r.hostPort == null ? '' : String(r.hostPort))}`)
  lines.push(`TICKS=${ticks}`)
  lines.push(`NAME=${q(guard ? '' : profileName)}`)
  lines.push('echo "[safe-update] profile: $PROFILE"')
  lines.push('[ -f "$PROFILE/package.json" ] || { echo "[safe-update] package.json not found"; exit 1; }')
  lines.push('cd "$PROFILE" || exit 1')
  lines.push('log() { printf \'{"at":"%s","event":"%s","profile":"%s"}\\n\' "$(date -u +%Y-%m-%dT%H:%M:%SZ)" "$1" "$NAME" >> "$LOG"; }')
  lines.push('')
  lines.push('if [ -n "$PID" ] || [ -n "$PORT" ]; then')
  lines.push('  echo "[safe-update] waiting for DeepSeek Harness to exit (pid $PID, port $PORT)..."')
  lines.push('  waited=0')
  lines.push('  while :; do')
  lines.push('    busy=0')
  lines.push('    [ -n "$PID" ] && kill -0 "$PID" 2>/dev/null && busy=1')
  lines.push('    [ -n "$PORT" ] && command -v lsof >/dev/null 2>&1 && lsof -iTCP:"$PORT" -sTCP:LISTEN >/dev/null 2>&1 && busy=1')
  lines.push('    [ "$busy" = 0 ] && break')
  lines.push('    waited=$((waited + 1))')
  lines.push('    if [ "$waited" -ge "$TICKS" ]; then log apply-timeout; echo "[safe-update] TIMEOUT: quit DeepSeek Harness completely, then run this script again."; exit 1; fi')
  lines.push('    sleep 2')
  lines.push('  done')
  lines.push('fi')
  lines.push('echo "[safe-update] no running DeepSeek Harness detected; applying now."')
  lines.push('log apply-start')
  lines.push('cp -p package.json "package.json.bak-$STAMP"')
  lines.push('[ -f pnpm-lock.yaml ] && cp -p pnpm-lock.yaml "pnpm-lock.yaml.bak-$STAMP"')
  lines.push('RC=0')
  lines.push('if command -v pnpm >/dev/null 2>&1; then')
  for (const t of targets) {
    lines.push(`  echo "[safe-update] run: pnpm add ${t.arg}"`)
    lines.push(`  pnpm add ${q(t.arg)} || RC=1`)
  }
  lines.push('elif command -v dsh >/dev/null 2>&1; then')
  for (const t of targets) {
    lines.push(`  echo "[safe-update] run: dsh plugin --profile $NAME add ${t.arg}"`)
    lines.push(`  dsh plugin --profile "$NAME" add ${q(t.arg)} || RC=1`)
  }
  lines.push('else')
  lines.push('  log runner-missing; echo "[safe-update] neither pnpm nor dsh is on PATH."; exit 1')
  lines.push('fi')
  lines.push('if [ "$RC" = 0 ]; then')
  lines.push('  log apply-ok')
  lines.push('  echo "[safe-update] update applied. Start DeepSeek Harness again."')
  lines.push('else')
  lines.push('  log apply-failed')
  lines.push('  echo "[safe-update] one or more steps FAILED. Backups: package.json.bak-$STAMP, pnpm-lock.yaml.bak-$STAMP"')
  lines.push('fi')
  return lines.join('\n') + '\n'
}

// --- write / cancel -----------------------------------------------------------

/**
 * 功能作用：把计划落成「待更新记录 + 更新脚本」（只写 .plugin-manager/ 下的两个文件）。
 * 参数：{ profileDir, profileName, manifest, names, hostPid, hostPort, platform, now }
 * 返回值：{ ok, error?, record?, scriptPath?, script?, skipped }
 * 调用样例：prepareSafeUpdate({ profileDir, profileName: 'desktop', manifest, names: ['dsh-plugin-manager'], hostPid: 4412, hostPort: 19387 })
 */
export function prepareSafeUpdate(input = {}) {
  const profileDir = String(input.profileDir || '')
  if (!profileDir) return { ok: false, error: 'no profile directory resolved', skipped: [] }
  const profileName = String(input.profileName || '')
  const platform = input.platform === 'win32' || (input.platform == null && process.platform === 'win32') ? 'win32' : 'posix'
  const plan = buildUpdatePlan(input.manifest, input.names)
  if (plan.error) return { ok: false, error: plan.error, skipped: plan.skipped }
  const weak = profileName && !isSafeProfileName(profileName)
  const record = buildPendingRecord({
    profileDir,
    profileName: weak ? '' : profileName,
    platform,
    hostPid: input.hostPid,
    hostPort: input.hostPort,
    targets: plan.targets,
    now: input.now,
  })
  const script = platform === 'win32' ? renderCmdScript(record) : renderShScript(record)
  try {
    fs.mkdirSync(updateDirOf(profileDir), { recursive: true })
    fs.writeFileSync(record.pendingPath, JSON.stringify(record, null, 2) + '\n', 'utf8')
    fs.writeFileSync(record.scriptPath, script, platform === 'win32' ? 'utf8' : { encoding: 'utf8', mode: 0o755 })
  } catch (e) {
    return { ok: false, error: (e && e.message) || String(e), skipped: plan.skipped }
  }
  return { ok: true, error: null, record, scriptPath: record.scriptPath, script, skipped: plan.skipped }
}

/**
 * 功能作用：撤销待更新（删除记录与脚本；日志与备份保留，便于事后核对）。
 * 参数：profileDir: string
 * 返回值：{ ok: boolean, removed: string[] }
 * 调用样例：clearSafeUpdate(profileDir)
 */
export function clearSafeUpdate(profileDir) {
  const pending = readPending(profileDir)
  const files = [pendingPathOf(profileDir), scriptPathOf(profileDir, 'win32'), scriptPathOf(profileDir, 'posix')]
  const removed = []
  for (const f of files) {
    try { if (fs.existsSync(f)) { fs.rmSync(f); removed.push(f) } } catch { /* best effort */ }
  }
  return { ok: true, removed, hadPending: pending != null }
}

/**
 * 功能作用：给 /list 与 /update 用的视图对象（可更新目标 + 待更新记录 + 脚本状态）。
 * 参数：{ profileDir, manifest, platform }
 * 返回值：{ targets, suggested, pending, scriptPath, scriptExists, logPath, pendingPath, maxWaitSeconds }
 * 调用样例：safeUpdateView({ profileDir, manifest })
 */
export function safeUpdateView(input = {}) {
  const profileDir = String(input.profileDir || '')
  const platform = input.platform === 'win32' || (input.platform == null && process.platform === 'win32') ? 'win32' : 'posix'
  const targets = safeUpdateTargets(input.manifest)
  const pending = profileDir ? readPending(profileDir) : null
  const scriptPath = profileDir ? scriptPathOf(profileDir, platform) : null
  let scriptExists = false
  try { scriptExists = Boolean(scriptPath && fs.existsSync(scriptPath)) } catch { scriptExists = false }
  return {
    targets,
    suggested: suggestedTargets(targets),
    pending,
    pendingPath: profileDir ? pendingPathOf(profileDir) : null,
    scriptPath,
    scriptExists,
    logPath: profileDir ? logPathOf(profileDir) : null,
    maxWaitSeconds: MAX_WAIT_SECONDS,
  }
}