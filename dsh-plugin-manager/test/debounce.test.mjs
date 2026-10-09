// Handler-level harness for the host half (src/index.js).
//
// WHY THIS FILE EXISTS
// A single write to the profile's cordis.patch.yml costs DSH core a full
// config-tree re-application that blocks the host event loop for 681-1184 ms
// (measured with a 5 ms /status probe; an identical-bytes write costs nothing,
// so the price is the config change itself). The regression this file locks
// down is therefore about COUNT, not milliseconds: N switch requests inside the
// debounce window must reach disk as exactly ONE write.
//
// It drives the REAL registerHttp() handler with a fake web-server and fake
// req/res against a throwaway $DSH_HOME, so the seam is the actual endpoint —
// not a re-implementation of it. The temp profile gets its js-yaml through a
// junction to the live profile's copy (the same resolution contract the plugin
// uses); when that copy is unavailable the file skips instead of installing
// anything.
//
// Run: node dsh-plugin-manager/test/debounce.test.mjs
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
  console.log(`debounce tests: SKIP (no js-yaml at ${realYaml})`)
  process.exit(0)
}

// --- throwaway profile -------------------------------------------------------

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-manager-debounce-'))
const profileDir = path.join(tmpRoot, 'profiles', 'web')
fs.mkdirSync(profileDir, { recursive: true })

const ROWS = ['dsh-session-time-bucket', 'dsh-esc-rewind']
const rowId = (dir) => dir.replace(/^dsh-/, '')

fs.writeFileSync(path.join(profileDir, 'package.json'), `${JSON.stringify({
  name: 'web',
  private: true,
  devDependencies: Object.fromEntries(ROWS.map((d) => [d, `link:D:/repo/sub-plugins/${d}`])),
}, null, 2)}\n`, 'utf8')

const patchFile = path.join(profileDir, 'cordis.patch.yml')
const seedRows = () => `- insert:\n${ROWS.map((d) => `    - id: ${rowId(d)}\n      name: ${d}`).join('\n')}\n`
fs.writeFileSync(patchFile, seedRows(), 'utf8')

// js-yaml via junction, mirroring the live profile's hoisted install.
fs.mkdirSync(path.join(profileDir, 'node_modules'), { recursive: true })
fs.symlinkSync(realYaml, path.join(profileDir, 'node_modules', 'js-yaml'), 'junction')

const probe = createRequire(path.join(profileDir, 'package.json'))
try {
  const jsyaml = probe('js-yaml')
  assert.equal(typeof jsyaml.load, 'function')
} catch (e) {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
  console.log(`debounce tests: SKIP (js-yaml not resolvable from the temp profile: ${e && e.message})`)
  process.exit(0)
}

process.env.DSH_HOME = tmpRoot
const {
  registerHttp,
  __setPnpmRunner,
  __setAutoRelink,
  __resetAutoRelinkLatch,
  __autoRelinkOnce,
  HOST_DIAG,
} = await import(pathToFileURL(indexPath).href)
const { workspaceDepSpec } = await import(pathToFileURL(path.join(here, '..', 'src', 'host-core.js')).href)

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
const host = {
  register(options) {
    handler = options.handler
    return () => { handler = null }
  },
}

// The load-time automatic pass is inert unless a test turns it on: it would
// otherwise rewrite this fixture's intentionally-stale links and spawn pnpm.
__setAutoRelink(false)
registerHttp(ctx, host, {})
assert.equal(typeof handler, 'function', 'registerHttp installed a prefix handler')

const repoRoot = path.join(here, '..', '..')
const manifestPath = path.join(profileDir, 'package.json')
const manifest = () => JSON.parse(fs.readFileSync(manifestPath, 'utf8'))
const writeManifest = (m) => fs.writeFileSync(manifestPath, `${JSON.stringify(m, null, 2)}\n`, 'utf8')
const URL_ = (suffix) => `/__dsh-plugin-manager/${suffix}`
let installs = 0
__setPnpmRunner(async () => { installs += 1; return { ok: true, code: 0, error: null, stdout: '', stderr: '' } })

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

/** Count patch-file writes for `ms`, sampling the mtime the way a watcher would. */
async function countWrites(ms) {
  const seen = new Set()
  let last = fs.statSync(patchFile).mtimeMs
  const t0 = Date.now()
  while (Date.now() - t0 < ms) {
    await sleep(10)
    const m = fs.statSync(patchFile).mtimeMs
    if (m !== last) { seen.add(m); last = m }
  }
  return seen.size
}

const stateOf = (res, dir) => {
  const p = (res.json.data.plugins || []).find((x) => x.dir === dir)
  return p ? p.state : '(missing)'
}

try {
  // --- one burst, one write -------------------------------------------------
  fs.writeFileSync(patchFile, seedRows(), 'utf8')

  const writes = countWrites(1200)
  const first = await call('POST', '/__dsh-plugin-manager/set-enabled', { dir: ROWS[0], enabled: false })
  assert.equal(first.status, 200)
  const second = await call('POST', '/__dsh-plugin-manager/set-enabled', { dir: ROWS[1], enabled: false })
  assert.equal(second.status, 200)

  // Responses are optimistic-consistent: the queued state is already reported,
  // so the panel never has to wait for the flush to show the target position.
  assert.equal(stateOf(first, ROWS[0]), 'disabled', 'first response already reports the requested state')
  assert.equal(stateOf(second, ROWS[1]), 'disabled', 'second response already reports the requested state')

  const status = await call('GET', '/__dsh-plugin-manager/status')

  assert.equal(await writes, 1, 'two quick switches produced exactly ONE patch-file write')

  const text = fs.readFileSync(patchFile, 'utf8')
  assert.equal((text.match(/disabled: true/g) || []).length, 2, 'the single write carries both rows')
  assert.ok(text.includes(`id: ${rowId(ROWS[0])}`) && text.includes(`id: ${rowId(ROWS[1])}`))

  assert.ok(status.json.pendingWrites >= 1, 'queued writes are visible in /status while the burst is in flight')
  assert.equal(status.json.lastFlushError, null)

  const drained = await call('GET', '/__dsh-plugin-manager/status')
  assert.equal(drained.json.pendingWrites, 0, 'queue drains after the flush')

  // --- re-clicking a row replaces its intent (still one write) --------------
  fs.writeFileSync(patchFile, seedRows(), 'utf8')
  const rerun = countWrites(1200)
  await call('POST', '/__dsh-plugin-manager/set-enabled', { dir: ROWS[0], enabled: false })
  await call('POST', '/__dsh-plugin-manager/set-enabled', { dir: ROWS[0], enabled: true })
  assert.equal(await rerun, 1, 'off-then-on inside the window is one write, not two')
  assert.doesNotMatch(fs.readFileSync(patchFile, 'utf8'), /disabled: true/, 'only the last intent for that row landed')

  // --- dispose while queued: best-effort synchronous flush (design.md R7) ---
  fs.writeFileSync(patchFile, seedRows(), 'utf8')
  await call('POST', '/__dsh-plugin-manager/set-enabled', { dir: ROWS[1], enabled: false })
  dispose()
  assert.match(fs.readFileSync(patchFile, 'utf8'), /disabled: true/, 'queued intent survives a host shutdown')
  // The dispose above nulled the handler; re-register for the stale-link cases.
  __resetAutoRelinkLatch()
  __setAutoRelink(false)
  registerHttp(ctx, host, {})

  // --- /list 暴露「一键卸载」命令与将删预览（只读） --------------------------
  {
    const listed = await call('GET', URL_('list'))
    assert.equal(listed.status, 200)
    const uninstall = listed.json.data.uninstall
    assert.ok(uninstall && typeof uninstall.command === 'string', 'uninstall command exposed on /list')
    assert.match(uninstall.command, /uninstall-manager\.mjs/, 'command points at the shipped script')
    assert.match(uninstall.command, /--profile web/, 'command targets the resolved profile')
    assert.equal(uninstall.command.endsWith('--yes'), true, 'command carries the explicit --yes (script defaults to dry run)')
    assert.ok(uninstall.willRemove.rows >= 1 && uninstall.willRemove.deps >= 1, 'preview counts managed rows and link keys')
    assert.equal(typeof uninstall.willRemove.managerEntry, 'boolean', 'preview reports the manager entry state')
  }

  // --- 陈旧链接：单行启用时修复（恰好一次 install） --------------------------
  {
    const dir = ROWS[1]
    const currentSpec = workspaceDepSpec(path.join(repoRoot, 'sub-plugins', dir))
    fs.writeFileSync(patchFile, seedRows(), 'utf8')
    const m = manifest()
    m.devDependencies[dir] = `link:D:/gone/${dir}`
    writeManifest(m)
    installs = 0
    const res = await call('POST', URL_('set-enabled'), { dir, enabled: true })
    assert.equal(res.status, 200)
    await sleep(150)
    assert.equal(installs, 1, '陈旧链接被修复时恰好一次 pnpm install')
    assert.equal(manifest().devDependencies[dir], currentSpec, 'link: 被改写为当前实际目录')
    const listed = (res.json.data.plugins || []).find((p) => p.dir === dir)
    assert.equal(listed.depState, 'fresh', '响应里的链接态已回到 fresh')
  }

  // --- 链接已正确：不写 package.json、不安装 --------------------------------
  {
    installs = 0
    const res = await call('POST', URL_('set-enabled'), { dir: ROWS[1], enabled: true })
    assert.equal(res.status, 200)
    await sleep(150)
    assert.equal(installs, 0, '链接正确时不写文件也不安装')
  }

  // --- 面板「重定位」：两条一起修、只一次 install；再点 noop ----------------
  {
    fs.writeFileSync(patchFile, seedRows(), 'utf8')
    const m = manifest()
    for (const dir of ROWS) m.devDependencies[dir] = `link:D:/gone/${dir}`
    writeManifest(m)
    installs = 0
    const res = await call('POST', URL_('relink'), {})
    assert.equal(res.status, 200)
    assert.equal(installs, 1, '重定位两个条目只跑一次 install')
    assert.equal(res.json.relink.relinked.length, 2)
    for (const dir of ROWS) {
      assert.equal(manifest().devDependencies[dir], workspaceDepSpec(path.join(repoRoot, 'sub-plugins', dir)))
    }
    assert.equal(res.json.data.linkPlan.count, 0, '修完后面板不再报陈旧')
    const again = await call('POST', URL_('relink'), {})
    assert.equal(again.status, 200)
    assert.equal(again.json.relink.noop, true, '没有陈旧项时是 noop')
    assert.equal(installs, 1, 'noop 不再安装')
  }

  // --- 自动重定位：一次启动最多一次（闩锁），开关关闭时只跳过 ----------------
  {
    const m = manifest()
    for (const dir of ROWS) m.devDependencies[dir] = `link:D:/gone/${dir}`
    writeManifest(m)
    installs = 0
    __setAutoRelink(true)
    __resetAutoRelinkLatch()
    await __autoRelinkOnce(ctx, {})
    assert.equal(installs, 1, '自动重定位恰好一次 install')
    assert.equal(HOST_DIAG.autoRelink.relinked.length, 2)
    assert.equal(HOST_DIAG.lastRelink.source, 'auto')
    await __autoRelinkOnce(ctx, {})
    assert.equal(installs, 1, '同一进程内第二次调用被闩锁挡住')

    const m2 = manifest()
    for (const dir of ROWS) m2.devDependencies[dir] = `link:D:/gone/${dir}`
    writeManifest(m2)
    installs = 0
    __setAutoRelink(false)
    __resetAutoRelinkLatch()
    await __autoRelinkOnce(ctx, {})
    assert.equal(installs, 0, '开关关闭时绝不写、绝不安装')
    assert.equal(HOST_DIAG.autoRelink.skipped, 'disabled')
    __setAutoRelink(true)
  }
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
}

console.log('debounce tests: PASS')
