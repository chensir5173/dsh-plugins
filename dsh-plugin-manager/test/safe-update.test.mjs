// Host-level harness for the safe updater (src/safe-update.js + the
// /update/prepare and /update/cancel endpoints in src/index.js).
//
// WHY THIS FILE EXISTS
// Replacing a plugin WHILE DSH runs is what makes an update hang on Windows: pnpm
// cannot overwrite files the running host has loaded. The safe updater therefore
// only STAGES work - a record plus a script under <profileDir>/.plugin-manager/ -
// and the replacement happens after the host has exited.
//
// The regression locked down here is the contract that makes that safe: preparing
// an update must run NO pnpm and must not touch a single profile file
// (package.json / cordis.patch.yml / node_modules). It drives the REAL
// registerHttp() handler against a throwaway $DSH_HOME with the pnpm runner
// stubbed to count calls.
//
// Run: node dsh-plugin-manager/test/safe-update.test.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const BS = String.fromCharCode(92) // backslash: never write it as a literal here
const here = path.dirname(fileURLToPath(import.meta.url))
const srcDir = path.join(here, '..', 'src')
const indexPath = path.join(srcDir, 'index.js')

// --- skip when the profile's js-yaml is not reachable (never run pnpm here) ---
const realHome = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
  ? process.env.DSH_HOME.trim()
  : path.join(os.homedir(), '.dsh')
const realYaml = path.join(realHome, 'profiles', 'web', 'node_modules', 'js-yaml')
if (!fs.existsSync(realYaml)) {
  console.log('safe-update tests: SKIP (no js-yaml at ' + realYaml + ')')
  process.exit(0)
}

// --- throwaway profile -------------------------------------------------------
const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-manager-safe-update-'))
const profileDir = path.join(tmpRoot, 'profiles', 'web')
fs.mkdirSync(profileDir, { recursive: true })
const pmDir = path.join(profileDir, '.plugin-manager')
const manifestPath = path.join(profileDir, 'package.json')
const patchFile = path.join(profileDir, 'cordis.patch.yml')

const MANIFEST = {
  name: 'web',
  private: true,
  dependencies: {
    'dsh-plugin-manager': 'github:chensir5173/dsh-plugins#4c4325f0a3deae82a94600cb48781e9c96787ca5',
    dshmarket: '^1.66.15',
  },
  devDependencies: { 'dsh-idle-hook': 'link:./node_modules/dsh-plugin-manager/sub-plugins/dsh-idle-hook' },
}
fs.writeFileSync(manifestPath, JSON.stringify(MANIFEST, null, 2), 'utf8')
fs.writeFileSync(patchFile, ['- insert:', '    - id: idle-hook', '      name: dsh-idle-hook', ''].join('\n'), 'utf8')

// js-yaml via junction, mirroring the live profile's hoisted install.
fs.mkdirSync(path.join(profileDir, 'node_modules'), { recursive: true })
const jsYamlLink = path.join(profileDir, 'node_modules', 'js-yaml')
try {
  fs.symlinkSync(realYaml, jsYamlLink, 'junction')
} catch {
  fs.cpSync(realYaml, jsYamlLink, { recursive: true })
}
const probe = createRequire(manifestPath)
try {
  assert.equal(typeof probe('js-yaml').load, 'function')
} catch (e) {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
  console.log('safe-update tests: SKIP (js-yaml not resolvable from the temp profile: ' + (e && e.message) + ')')
  process.exit(0)
}

process.env.DSH_HOME = tmpRoot
const { registerHttp, __setPnpmRunner, __setAutoRelink, HOST_DIAG } = await import(pathToFileURL(indexPath).href)
const mod = await import(pathToFileURL(path.join(srcDir, 'safe-update.js')).href)

let handler = null
const ctx = {
  baseUrl: pathToFileURL(profileDir + path.sep).href,
  effect(callback) { callback() },
}
const host = { register(options) { handler = options.handler; return () => { handler = null } } }
__setAutoRelink(false)
registerHttp(ctx, host, {})
assert.equal(typeof handler, 'function', 'registerHttp installed a prefix handler')

const URL_ = (suffix) => '/__dsh-plugin-manager/' + suffix
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

const scriptName = process.platform === 'win32' ? 'apply-update.cmd' : 'apply-update.sh'
const scriptPath = path.join(pmDir, scriptName)
const pendingPath = path.join(pmDir, 'update-pending.json')
const readPending = () => JSON.parse(fs.readFileSync(pendingPath, 'utf8'))

try {
  // --- 1) pure planning: which specs are safely updatable --------------------
  assert.equal(mod.isSafeProfileName('desktop'), true)
  assert.equal(mod.isSafeProfileName('a; rm -rf /'), false)
  assert.equal(mod.isSafeProfileName('..'), false)
  assert.equal(mod.depKindOf('link:../x'), 'link')
  assert.equal(mod.depKindOf('workspace:*'), 'workspace')
  assert.equal(mod.depKindOf('git+https://h/x.git'), 'git')
  assert.equal(mod.depKindOf('^1.2.3'), 'registry')

  const targets = mod.safeUpdateTargets(MANIFEST)
  assert.deepEqual(targets.map((x) => x.name), ['dsh-plugin-manager', 'dshmarket'])
  assert.equal(targets[0].arg, 'github:chensir5173/dsh-plugins')
  assert.equal(targets[1].arg, 'dshmarket@latest')
  assert.deepEqual(mod.suggestedTargets(targets), ['dsh-plugin-manager'])

  const plan = mod.buildUpdatePlan(MANIFEST, ['dsh-plugin-manager', 'dsh-idle-hook', 'nope'])
  assert.deepEqual(plan.targets.map((x) => x.name), ['dsh-plugin-manager'])
  assert.deepEqual(plan.skipped, [{ name: 'dsh-idle-hook', reason: 'local-source' }, { name: 'nope', reason: 'unknown' }])
  assert.equal(mod.buildUpdatePlan(MANIFEST, []).error, 'no target selected')

  // --- 2) /list carries the updatable targets, nothing staged yet ------------
  const list0 = await call('GET', URL_('list'))
  assert.equal(list0.status, 200)
  const su0 = list0.json.data.safeUpdate
  assert.deepEqual(su0.targets.map((x) => x.name), ['dsh-plugin-manager', 'dshmarket'])
  assert.deepEqual(su0.suggested, ['dsh-plugin-manager'])
  assert.equal(su0.pending, null)
  assert.equal(su0.scriptExists, false)

  const manifestBefore = fs.readFileSync(manifestPath)
  const patchBefore = fs.readFileSync(patchFile)
  const nmBefore = fs.readdirSync(path.join(profileDir, 'node_modules')).sort().join(',')

  // --- 3) prepare: stages only, runs NO pnpm, touches NO profile file --------
  const prep = await call('POST', URL_('update/prepare'), { targets: ['dsh-plugin-manager', 'dshmarket'] })
  assert.equal(prep.status, 200)
  assert.equal(installs, 0, 'prepare must not run pnpm')

  const pending = readPending()
  assert.deepEqual(pending.targets.map((x) => x.name), ['dsh-plugin-manager', 'dshmarket'])
  assert.equal(pending.profileDir, profileDir)
  assert.equal(pending.profileName, 'web')
  assert.equal(pending.hostPid, process.pid)
  assert.equal(pending.scriptPath, scriptPath)

  const script = fs.readFileSync(scriptPath, 'utf8')
  assert.ok(script.includes('pnpm add "github:chensir5173/dsh-plugins"'), 'script installs the git target')
  if (process.platform === 'win32') {
    assert.ok(script.includes('%PROFILE%' + BS + 'package.json'), 'cmd script keeps the path separator')
    assert.ok(script.includes('tasklist'), 'cmd script waits for the host pid')
  } else {
    assert.ok(script.includes('kill -0'), 'sh script waits for the host pid')
  }

  assert.deepEqual(fs.readFileSync(manifestPath), manifestBefore, 'prepare left package.json untouched')
  assert.deepEqual(fs.readFileSync(patchFile), patchBefore, 'prepare left cordis.patch.yml untouched')
  assert.equal(fs.readdirSync(path.join(profileDir, 'node_modules')).sort().join(','), nmBefore, 'prepare touched no dependency')
  assert.equal(fs.readdirSync(pmDir).filter((f) => f.endsWith('.bak')).length, 0, 'prepare wrote no backup of a live file')

  // --- 4) the record is visible to the panel --------------------------------
  const list1 = await call('GET', URL_('list'))
  assert.equal(list1.json.data.safeUpdate.scriptExists, true)
  assert.deepEqual(list1.json.data.safeUpdate.pending.targets.map((x) => x.name), ['dsh-plugin-manager', 'dshmarket'])

  // --- 5) cancel removes the staged files only ------------------------------
  const cancel = await call('POST', URL_('update/cancel'), {})
  assert.equal(cancel.status, 200)
  assert.equal(cancel.json.data.safeUpdate.pending, null)
  assert.equal(fs.existsSync(pendingPath), false)
  assert.equal(fs.existsSync(scriptPath), false)
  assert.deepEqual(fs.readFileSync(manifestPath), manifestBefore)
  assert.deepEqual(fs.readFileSync(patchFile), patchBefore)

  // --- 6) bad input is refused, still without touching anything -------------
  const unknown = await call('POST', URL_('update/prepare'), { targets: ['nope'] })
  assert.equal(unknown.status, 400)
  assert.ok(String(unknown.json.error).indexOf('no target selected') >= 0 || String(unknown.json.error).indexOf('nope') >= 0)
  const empty = await call('POST', URL_('update/prepare'), { targets: [] })
  assert.equal(empty.status, 400)
  assert.equal(empty.json.error, 'no target selected')
  assert.equal(fs.existsSync(pendingPath), false)
  assert.deepEqual(fs.readFileSync(manifestPath), manifestBefore)

  assert.equal(installs, 0, 'no path through the safe updater runs pnpm')
  assert.equal(HOST_DIAG.safeUpdate && HOST_DIAG.safeUpdate.action, 'prepare')
  console.log('safe-update tests: PASS')
} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
}
