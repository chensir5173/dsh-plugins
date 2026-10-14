// Profile-anchor resolution for the manager HOST half (src/host-core.js + src/index.js).
//
// WHY THIS FILE EXISTS
// ctx.baseUrl is documented as 'the profile directory file:URL', and that holds for
// the bundle layer. It does NOT hold for dshmarket's restart-free hot mount, which
// attaches an Include subtree whose baseUrl is <profile>/.dsh-market/. Up to 0.3.14
// the host took that path at face value, so the running manager believed its profile
// was a phantom named '.dsh-market': the panel printed 「目标 profile .dsh-market」,
// listed nothing (patch/manifest were built as $DSH_HOME/profiles/.dsh-market/…, a
// directory that does not exist) and every toggle died with a copyfile ENOENT for
// '….dsh/profiles/.dsh-market/package.json', while the real activation rows sat in
// the profile that was actually running.
//
// This file locks down the anchor walk itself, the precedence between an explicit
// config.profile and ctx.baseUrl, and the invariant that patch/manifest/workspace
// paths are derived from profileDir rather than from the display name.
//
// Run: node dsh-plugin-manager/test/profile-anchor.test.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const hostCore = await import(pathToFileURL(path.join(here, '..', 'src', 'host-core.js')).href)
const hostIndex = await import(pathToFileURL(path.join(here, '..', 'src', 'index.js')).href)
const { profileAnchorOf, resolveProfile } = hostCore

let passed = 0
const failures = []
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed += 1; console.log('ok -', name) })
    .catch((error) => { failures.push([name, error]); console.log('FAIL -', name, '::', error && error.message) })
}

const HOME = path.join('C:', 'Users', 'x', '.dsh')
const prof = (...parts) => path.join(HOME, 'profiles', ...parts)

await test('a profile directory anchors to itself', () => {
  assert.deepEqual(profileAnchorOf(HOME, prof('desktop')), { profileDir: prof('desktop'), profileName: 'desktop' })
})

await test('a trailing separator does not change the anchor', () => {
  assert.equal(profileAnchorOf(HOME, prof('desktop') + path.sep).profileName, 'desktop')
})

await test('the market hot dir (.dsh-market) anchors back to the profile that owns it', () => {
  const got = profileAnchorOf(HOME, path.join(prof('desktop'), '.dsh-market'))
  assert.equal(got.profileName, 'desktop', 'a subdirectory of a profile is not a profile')
  assert.equal(got.profileDir, prof('desktop'))
})

await test('the market hot file path anchors back to the profile', () => {
  assert.equal(profileAnchorOf(HOME, path.join(prof('desktop'), '.dsh-market', 'hot-1.yml')).profileName, 'desktop')
})

await test('a deep path inside the profile still anchors to the profile', () => {
  // The exact URL dshmarket hot-mounts the manager by (see .dsh-market/hot-1.yml):
  // node_modules/dsh-plugin-manager/dsh-plugin-manager/src/index.js
  const deep = path.join(prof('desktop'), 'node_modules', 'dsh-plugin-manager', 'dsh-plugin-manager', 'src', 'index.js')
  assert.equal(profileAnchorOf(HOME, deep).profileName, 'desktop')
})

await test('the anchor follows the first segment, whatever profile it is', () => {
  assert.equal(profileAnchorOf(HOME, path.join(prof('web'), '.dsh-market')).profileName, 'web')
  assert.equal(profileAnchorOf(HOME, prof('dsh-tui')).profileName, 'dsh-tui')
})

await test('a path outside <home>/profiles has no anchor', () => {
  assert.equal(profileAnchorOf(HOME, path.join('D:', 'ChenSirDocument', 'Dsh-Projects', 'dsh-plugins')), null)
  assert.equal(profileAnchorOf(HOME, prof()), null, 'the profiles root itself is not a profile dir')
})

await test('empty input has no anchor', () => {
  assert.equal(profileAnchorOf('', prof('desktop')), null)
  assert.equal(profileAnchorOf(HOME, ''), null)
  assert.equal(profileAnchorOf(HOME, null), null)
})

await test('an explicit config.profile wins when that profile exists', () => {
  const got = resolveProfile({ home: HOME, baseUrlDir: prof('desktop'), configured: 'web', dirExists: () => true })
  assert.deepEqual(got, { profileDir: prof('web'), profileName: 'web', source: 'config' })
})

await test('a stale config.profile does NOT beat the running ctx.baseUrl anchor', () => {
  // The shape that produced the bug: the entry carried a profile name that has no
  // directory, while the process was demonstrably serving `desktop`.
  const got = resolveProfile({
    home: HOME,
    baseUrlDir: path.join(prof('desktop'), '.dsh-market'),
    configured: '.dsh-market',
    dirExists: () => false,
  })
  assert.deepEqual(got, { profileDir: prof('desktop'), profileName: 'desktop', source: 'baseUrl' })
})

await test('an unanchorable baseUrl directory is used as-is (custom layouts keep working)', () => {
  const got = resolveProfile({ home: HOME, baseUrlDir: path.join('D:', 'elsewhere', 'profilex'), dirExists: () => true })
  assert.equal(got.source, 'baseUrl-raw')
  assert.equal(got.profileName, 'profilex')
})

await test('no baseUrl and a missing configured profile falls back to the default profile', () => {
  const got = resolveProfile({ home: HOME, baseUrlDir: null, dirExists: () => false })
  assert.deepEqual(got, { profileDir: prof('web'), profileName: 'web', source: 'default' })
})

await test('no baseUrl keeps the historical config.profile fallback', () => {
  const got = resolveProfile({ home: HOME, baseUrlDir: null, configured: 'dsh-tui', dirExists: () => false })
  assert.deepEqual(got, { profileDir: prof('dsh-tui'), profileName: 'dsh-tui', source: 'config' })
})

// --- end to end: the real resolveContext() against a real DSH_HOME -------------

const tmpHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-profile-anchor-'))
fs.mkdirSync(path.join(tmpHome, 'profiles', 'desktop', '.dsh-market'), { recursive: true })
const prevHome = process.env.DSH_HOME
process.env.DSH_HOME = tmpHome
const hotBaseUrl = pathToFileURL(path.join(tmpHome, 'profiles', 'desktop', '.dsh-market') + path.sep).href

await test('resolveContext() reads a hot-mounted baseUrl as the profile that owns it', () => {
  const c = hostIndex.__resolveContext({}, hotBaseUrl)
  assert.equal(c.profileName, 'desktop', 'not .dsh-market')
  assert.equal(c.profileSource, 'baseUrl')
  assert.equal(c.profileDir, path.join(tmpHome, 'profiles', 'desktop'))
  assert.equal(c.patchFile, path.join(tmpHome, 'profiles', 'desktop', 'cordis.patch.yml'))
  assert.equal(c.manifestFile, path.join(tmpHome, 'profiles', 'desktop', 'package.json'))
  assert.equal(c.workspaceFile, path.join(tmpHome, 'profiles', 'desktop', 'pnpm-workspace.yaml'))
  for (const p of [c.profileDir, c.patchFile, c.manifestFile, c.workspaceFile]) {
    assert.ok(p.indexOf('.dsh-market') === -1, 'no derived path may point into the market dir: ' + p)
  }
})

await test('resolveContext() ignores a configured profile whose directory is absent', () => {
  const c = hostIndex.__resolveContext({ profile: '.dsh-market' }, hotBaseUrl)
  assert.equal(c.profileName, 'desktop')
  assert.equal(c.patchFile, path.join(tmpHome, 'profiles', 'desktop', 'cordis.patch.yml'))
})

await test('resolveContext() without a web surface still targets the default profile', () => {
  const c = hostIndex.__resolveContext({}, null)
  assert.equal(c.profileName, 'web')
  assert.equal(c.profileSource, 'default')
  assert.equal(c.patchFile, path.join(tmpHome, 'profiles', 'web', 'cordis.patch.yml'))
})

if (prevHome === undefined) delete process.env.DSH_HOME
else process.env.DSH_HOME = prevHome
fs.rmSync(tmpHome, { recursive: true, force: true })

console.log()
if (failures.length > 0) {
  console.log(failures.length + ' failing:')
  for (const [name, error] of failures) console.log('  -', name, ':', (error && error.stack ? error.stack.split(String.fromCharCode(10)).slice(0, 4).join(' | ') : error))
  process.exit(1)
}
console.log(passed + ' profile-anchor checks passed')