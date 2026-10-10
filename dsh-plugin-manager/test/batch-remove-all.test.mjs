// Handler-level harness for the 「全部移除」 batch endpoint (POST /remove-all).
//
// WHY THIS FILE EXISTS
// 「全部移除」是破坏性动作：它一次删掉全部受管激活行、一次摘掉 profile 的
// dependencies/devDependencies 键、再跑一次 pnpm install。它必须守住四条不变式：
//   1. 恰好一次 patch 写入（一次核心配置重应用）+ 恰好一次 manifest 改写 + 恰好一次安装；
//   2. 只动受管子插件——mcp-* 行、dsh.profile.bundles、管理器自身的依赖键逐字节不变；
//   3. 合并窗口里排队的开关意图被丢弃（而不是先落盘再删），条数如实回报；
//   4. 任一步失败 → manifest 与 patch 一起回滚，不留「行没了、依赖还在」的半状态。
// 与 debounce.test.mjs 同一手法：驱动真 registerHttp() + 假 web 服务器 + 假 req/res，
// 对着一次性 $DSH_HOME 跑，pnpm 用 __setPnpmRunner 桩（本文件绝不真的跑 pnpm）。
//
// Run: node dsh-plugin-manager/test/batch-remove-all.test.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const indexPath = path.join(here, '..', 'src', 'index.js')

const sleep = (ms) => new Promise((r) => setTimeout(r, ms))

// --- skip when the profile's js-yaml is not reachable (never run pnpm here) ---

const realHome = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
  ? process.env.DSH_HOME.trim()
  : path.join(os.homedir(), '.dsh')
const realYaml = path.join(realHome, 'profiles', 'web', 'node_modules', 'js-yaml')
if (!fs.existsSync(realYaml)) {
  console.log(`batch-remove-all tests: SKIP (no js-yaml at ${realYaml})`)
  process.exit(0)
}

// --- throwaway profile -------------------------------------------------------

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-manager-remove-all-'))
const profileDir = path.join(tmpRoot, 'profiles', 'web')
fs.mkdirSync(profileDir, { recursive: true })

const ROWS = ['dsh-session-time-bucket', 'dsh-esc-rewind']
const rowId = (dir) => dir.replace(/^dsh-/, '')

const manifestPath = path.join(profileDir, 'package.json')
const patchFile = path.join(profileDir, 'cordis.patch.yml')

/** 一份「什么都有一点」的现场：两个受管子插件 + 管理器自身 + 外部插件行。 */
function seedManifest() {
  const manifest = {
    name: 'web',
    private: true,
    dependencies: { 'dsh-plugin-manager': 'github:Chen5173/dsh-plugins' },
    devDependencies: Object.fromEntries(ROWS.map((d) => [d, `link:D:/repo/sub-plugins/${d}`])),
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-plugin-manager'], patchReload: 'live' } },
  }
  fs.writeFileSync(manifestPath, `${JSON.stringify(manifest, null, 2)}\n`, 'utf8')
  return manifest
}

function seedPatch() {
  const text = [
    '- insert:',
    '    - id: mcp-CodeMap',
    '      name: "@deepseek-ai/dsh-mcp-client"',
    '    - id: session-time-bucket',
    '      name: dsh-session-time-bucket',
    '    - id: esc-rewind',
    '      name: dsh-esc-rewind',
    '      disabled: true',
    '',
  ].join('\n')
  fs.writeFileSync(patchFile, text, 'utf8')
  return text
}

// js-yaml via junction, mirroring the live profile's hoisted install.
fs.mkdirSync(path.join(profileDir, 'node_modules'), { recursive: true })
const jsYamlLink = path.join(profileDir, 'node_modules', 'js-yaml')
try {
  fs.symlinkSync(realYaml, jsYamlLink, 'junction')
} catch {
  // Restricted Windows shells refuse junction creation (EPERM); a plain copy
  // keeps the throwaway profile resolvable and never touches the real profile.
  fs.cpSync(realYaml, jsYamlLink, { recursive: true })
}

const probe = createRequire(path.join(profileDir, 'package.json'))
try {
  assert.equal(typeof probe('js-yaml').load, 'function')
} catch (e) {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
  console.log(`batch-remove-all tests: SKIP (js-yaml not resolvable from the temp profile: ${e && e.message})`)
  process.exit(0)
}

process.env.DSH_HOME = tmpRoot
const { registerHttp, __setPnpmRunner } = await import(pathToFileURL(indexPath).href)

// --- pnpm stub + IO counters -------------------------------------------------
//
// Count writes on the SHARED node:fs object the handler itself uses (exact
// counting, not mtime sampling).

let pnpmCalls = []
let pnpmOk = true
__setPnpmRunner(async (dir, args) => {
  pnpmCalls.push({ dir, args })
  if (!pnpmOk) return { ok: false, code: 1, error: 'stub install failure', stdout: '', stderr: 'stub install failure' }
  return { ok: true, code: 0, error: null, stdout: '', stderr: '' }
})

const realWriteFileSync = fs.writeFileSync
const writeCounts = { patch: 0, manifest: 0 }
fs.writeFileSync = (file, ...rest) => {
  const p = String(file)
  if (p === patchFile) writeCounts.patch += 1
  if (p === manifestPath) writeCounts.manifest += 1
  return realWriteFileSync(file, ...rest)
}
const resetCounts = () => { writeCounts.patch = 0; writeCounts.manifest = 0; pnpmCalls = [] }

// --- fake web server + req/res ----------------------------------------------

let handler = null
let dispose = null
const ctx = {
  baseUrl: pathToFileURL(`${profileDir}${path.sep}`).href,
  effect(callback) {
    const cleanup = callback()
    dispose = () => { if (typeof cleanup === 'function') cleanup() }
  },
}
const host = { register(options) { handler = options.handler; return () => { handler = null } } }

registerHttp(ctx, host, {})
assert.equal(typeof handler, 'function', 'registerHttp installed a prefix handler')

function call(method, url, body) {
  return new Promise((resolve, reject) => {
    const req = new EventEmitter()
    req.method = method
    req.url = url
    let status = 0
    let payload = ''
    const res = {
      writeHead(code) { status = code },
      end(chunk) { payload += chunk === undefined ? '' : String(chunk); resolve({ status, json: JSON.parse(payload) }) },
    }
    Promise.resolve(handler(req, res)).catch(reject)
    setImmediate(() => {
      if (body !== undefined) req.emit('data', JSON.stringify(body))
      req.emit('end')
    })
  })
}

const stateOf = (res, dir) => {
  const p = (res.json.data.plugins || []).find((x) => x.dir === dir)
  return p ? p.state : '(missing)'
}

try {
  // --- 1. one removal pass: one patch write, one manifest write, one install -
  seedManifest(); seedPatch(); resetCounts()

  const before = await call('GET', '/__dsh-plugin-manager/list')
  assert.equal(before.json.data.batchCounts.remove.count, 2, '/list exposes the removal count')

  const res = await call('POST', '/__dsh-plugin-manager/remove-all', {})
  assert.equal(res.status, 200)
  assert.equal(res.json.ok, true)
  assert.equal(res.json.counts.applied, 2, 'both traced plugins were removed')
  assert.equal(res.json.counts.failed, 0)
  assert.equal(res.json.counts.wrotePatch, true)
  assert.equal(res.json.discardedIntents, 0, 'nothing was queued in this run')

  assert.equal(writeCounts.patch, 1, 'one removal pass = exactly ONE patch-file write')
  assert.equal(writeCounts.manifest, 1, 'one removal pass = exactly ONE manifest write')
  assert.equal(pnpmCalls.length, 1, 'one removal pass = exactly ONE pnpm install')
  assert.deepEqual(pnpmCalls[0].args, ['install'])
  assert.equal(path.resolve(pnpmCalls[0].dir), path.resolve(profileDir), 'install runs in the profile dir')

  const patchAfter = fs.readFileSync(patchFile, 'utf8')
  for (const d of ROWS) assert.doesNotMatch(patchAfter, new RegExp(`id: ${rowId(d)}`), `${d} row is gone`)
  assert.match(patchAfter, /id: mcp-CodeMap/, 'foreign rows survive')

  const manifestAfter = JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
  for (const d of ROWS) {
    assert.equal(Object.prototype.hasOwnProperty.call(manifestAfter.devDependencies, d), false, `${d} devDep is gone`)
  }
  assert.equal(manifestAfter.dependencies['dsh-plugin-manager'], 'github:Chen5173/dsh-plugins', 'the manager itself is never dropped')
  assert.deepEqual(manifestAfter.dsh.profile.bundles, ['@deepseek-ai/dsh-base', 'dsh-plugin-manager'], 'bundles untouched')

  // Every plugin now reads as never-installed, and the count drops to 0.
  assert.equal(stateOf(res, ROWS[0]), 'uninstalled')
  assert.equal(stateOf(res, ROWS[1]), 'uninstalled')
  assert.equal(res.json.data.batchCounts.remove.count, 0, 'N drops to 0 once every trace is gone')

  // --- 2. queued switch intents are DISCARDED (never written) ----------------
  seedManifest(); seedPatch(); resetCounts()

  const queued = await call('POST', '/__dsh-plugin-manager/set-enabled', { dir: ROWS[0], enabled: false })
  assert.equal(queued.status, 200)
  assert.equal(stateOf(queued, ROWS[0]), 'disabled', 'the queued intent is visible immediately')

  const wiped = await call('POST', '/__dsh-plugin-manager/remove-all', {})
  assert.equal(wiped.status, 200)
  assert.equal(wiped.json.discardedIntents, 1, 'the queued intent is reported as discarded')
  assert.equal(writeCounts.patch, 1, 'discarding the intent avoids the extra flush write')
  assert.equal(writeCounts.manifest, 1)
  assert.equal(pnpmCalls.length, 1)
  assert.doesNotMatch(fs.readFileSync(patchFile, 'utf8'), /id: session-time-bucket/, 'the discarded row is gone, not disabled')

  // The debounced flush must not resurrect the discarded intent afterwards.
  await sleep(600)
  assert.doesNotMatch(fs.readFileSync(patchFile, 'utf8'), /id: session-time-bucket/, 'no late flush resurrects the row')
  assert.equal(writeCounts.patch, 1, 'the discard produced no second write')

  // --- 3. failure rolls BOTH files back --------------------------------------
  const seededManifest = seedManifest()
  const seededPatch = seedPatch()
  resetCounts()
  pnpmOk = false
  const failed = await call('POST', '/__dsh-plugin-manager/remove-all', {})
  pnpmOk = true
  assert.equal(failed.status, 200)
  assert.equal(failed.json.counts.applied, 0, 'nothing is reported as applied when the install fails')
  assert.equal(failed.json.counts.failed, 2)
  // 注意：扫描根是真实仓库，所以结果里还有其它「无痕迹」子插件被逐条跳过——
  // 这里只断言有痕迹的两项失败、且没有任何一项被误报为 applied。
  const failedRows = failed.json.results.filter((r) => r.outcome === 'failed').map((r) => r.name).sort()
  assert.deepEqual(failedRows, [...ROWS].sort(), 'both traced plugins report failure')
  assert.equal(failed.json.results.filter((r) => r.outcome === 'applied').length, 0, 'nothing is falsely reported as applied')
  assert.match(String(failed.json.warning || ''), /失败/, 'the failure is surfaced to the panel')
  assert.deepEqual(JSON.parse(fs.readFileSync(manifestPath, 'utf8')), seededManifest, 'manifest rolled back byte-for-byte')
  assert.equal(fs.readFileSync(patchFile, 'utf8'), seededPatch, 'patch rolled back byte-for-byte (no half state)')

  // --- 4. noop: nothing traced → no write, no install ------------------------
  seedManifest(); seedPatch(); resetCounts()
  await call('POST', '/__dsh-plugin-manager/remove-all', {})
  resetCounts()
  const again = await call('POST', '/__dsh-plugin-manager/remove-all', {})
  assert.equal(again.status, 200)
  assert.equal(again.json.noop, true, 'a second removal is a no-op')
  assert.equal(again.json.counts.total, 0)
  assert.equal(writeCounts.patch, 0, 'noop writes nothing')
  assert.equal(writeCounts.manifest, 0)
  assert.equal(pnpmCalls.length, 0, 'noop never installs')
  assert.ok(again.json.results.every((r) => r.outcome === 'skipped'), 'every plugin is reported as skipped')
} finally {
  fs.writeFileSync = realWriteFileSync
  fs.rmSync(tmpRoot, { recursive: true, force: true })
}

console.log('batch-remove-all tests: PASS')
