// Handler-free harness for the self-contained uninstall script
// (dsh-plugin-manager/tools/uninstall-manager.mjs).
//
// WHY THIS FILE EXISTS
// The core CLI removes only the dependency and reconciles dsh.profile.bundles;
// the manager-written activation rows and the sub-plugins' link: keys survive it.
// This script is the way out, so its invariants are asserted here against a
// throwaway $DSH_HOME + a fake repo + a stubbed pnpm runner:
//   * exactly one patch write, exactly one manifest write, exactly one install
//   * managed rows/keys/bundle entry gone; everything else byte-identical
//   * source directories survive; reruns are idempotent no-ops
//   * timestamps backups exist; a failing install reports a retry command
//
// Run: node dsh-plugin-manager/test/uninstall.test.mjs

import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const mod = await import(pathToFileURL(path.join(here, '..', 'tools', 'uninstall-manager.mjs')).href)

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-pm-uninstall-'))
const home = path.join(tmpRoot, 'home')
const profileDir = path.join(home, 'profiles', 'web')
const repoRoot = path.join(tmpRoot, 'repo')
const manifestFile = path.join(profileDir, 'package.json')
const patchFile = path.join(profileDir, 'cordis.patch.yml')

for (const dir of ['dsh-aaa', 'dsh-bbb']) {
  fs.mkdirSync(path.join(repoRoot, 'sub-plugins', dir), { recursive: true })
  fs.writeFileSync(path.join(repoRoot, 'sub-plugins', dir, 'package.json'), JSON.stringify({ name: dir, main: 'index.js' }))
}
fs.mkdirSync(profileDir, { recursive: true })

/** JSON-subset patch engine: the fixture file is JSON, so load/dump === parse/stringify. */
const engine = {
  loadText: (text) => JSON.parse(text),
  dumpText: (rows) => JSON.stringify(rows, null, 1),
}

const MANAGED_ROW_ID = (dir) => dir.slice(4)

function writeFixture() {
  fs.writeFileSync(manifestFile, JSON.stringify({
    name: 'web',
    private: true,
    dependencies: {
      'third-party-plugin': '1.2.3',
      'dsh-plugin-manager': 'github:Chen5173/dsh-plugins',
    },
    devDependencies: {
      'dsh-aaa': 'link:' + path.join(repoRoot, 'sub-plugins', 'dsh-aaa'),
      'dsh-bbb': 'link:D:/elsewhere/dsh-bbb',
      unrelated: 'link:D:/elsewhere/unrelated',
    },
    dsh: { profile: { bundles: ['@deepseek-ai/dsh-base', 'dsh-plugin-manager', 'dsh-flowglass'] } },
  }, null, 2) + String.fromCharCode(10))
  const rows = [
    { insert: [
      { id: MANAGED_ROW_ID('dsh-aaa'), name: 'dsh-aaa' },
      { id: MANAGED_ROW_ID('dsh-bbb'), name: 'dsh-bbb' },
      { id: 'mcp-Serena', name: '@deepseek-ai/dsh-mcp-client' },
    ] },
    { id: 'third-party-plugin' },
  ]
  fs.writeFileSync(patchFile, JSON.stringify(rows, null, 1))
}

function planOf() {
  return mod.planUninstall({ profileDir, repoRoot, engine, profile: 'web', home })
}

const readManifest = () => JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
const readRows = () => JSON.parse(fs.readFileSync(patchFile, 'utf8'))
const rowIdsOf = (rows) => {
  const ids = []
  for (const entry of rows) {
    if (entry && typeof entry.id === 'string') ids.push(entry.id)
    if (entry && Array.isArray(entry.insert)) for (const item of entry.insert) ids.push(item.id)
  }
  return ids
}

try {
  // --- planning --------------------------------------------------------------
  writeFixture()
  const plan = planOf()
  assert.deepEqual(plan.rowIds, ['aaa', 'bbb'], 'managed rows found by repo scan')
  assert.deepEqual(plan.depNames, ['dsh-aaa', 'dsh-bbb'], 'every managed dependency key is removed, whatever its spec points at')
  assert.deepEqual(plan.summary, { rows: 2, deps: 2, managerEntry: true, workspaceChanged: false, installs: true })

  // --- dry run writes nothing ------------------------------------------------
  const before = [fs.readFileSync(manifestFile, 'utf8'), fs.readFileSync(patchFile, 'utf8')]
  const dry = await mod.runUninstall(plan, { dryRun: true, engine })
  assert.equal(dry.dryRun, true)
  assert.deepEqual([fs.readFileSync(manifestFile, 'utf8'), fs.readFileSync(patchFile, 'utf8')], before, 'dry run leaves both files untouched')

  // --- the real thing: one write each, one install ---------------------------
  let installs = 0
  const result = await mod.runUninstall(plan, { engine, pnpm: async () => { installs += 1; return { ok: true, code: 0 } } })
  assert.equal(result.installed, true)
  assert.equal(installs, 1, 'exactly one pnpm install')
  assert.equal((result.backups || []).length, 2, 'both files backed up before writing')
  for (const backup of result.backups) assert.ok(fs.existsSync(backup), 'backup exists: ' + backup)

  const rowsAfter = readRows()
  assert.deepEqual(rowIdsOf(rowsAfter), ['mcp-Serena', 'third-party-plugin'], 'managed rows gone, other rows byte-identical')
  const manifestAfter = readManifest()
  assert.equal(manifestAfter.dependencies['third-party-plugin'], '1.2.3', 'third-party dependency untouched')
  assert.equal(manifestAfter.dependencies['dsh-plugin-manager'], undefined, 'manager dependency key gone')
  assert.equal(manifestAfter.devDependencies['dsh-aaa'], undefined, 'managed dependency key gone')
  assert.equal(manifestAfter.devDependencies['dsh-bbb'], undefined, 'a managed key goes even when its legacy spec pointed outside the repo')
  assert.equal(manifestAfter.devDependencies.unrelated, 'link:D:/elsewhere/unrelated', 'unrelated link key untouched')
  assert.deepEqual(manifestAfter.dsh.profile.bundles, ['@deepseek-ai/dsh-base', 'dsh-flowglass'], 'only the manager bundle entry removed')
  assert.ok(fs.existsSync(path.join(repoRoot, 'sub-plugins', 'dsh-aaa', 'package.json')), 'source directories are never deleted')

  // --- idempotent rerun ------------------------------------------------------
  const again = await mod.runUninstall(planOf(), { engine, pnpm: async () => { installs += 1; return { ok: true, code: 0 } } })
  assert.equal(again.noop, true, 'second run is a noop')
  assert.equal(installs, 1, 'noop must not install')

  // --- failing install reports a retry command and keeps the cleanup ---------
  writeFixture()
  const failing = await mod.runUninstall(planOf(), { engine, pnpm: async () => { installs += 1; return { ok: false, code: 1, stderr: 'EBUSY' } } })
  assert.equal(failing.installed, false)
  assert.match(String(failing.error), /EBUSY/)
  assert.match(String(failing.retry), /pnpm install --dir/)
  assert.equal(readManifest().devDependencies['dsh-aaa'], undefined, 'rows/keys are already clean when the install step fails')
  assert.equal(readRows().length > 0, true)

  // --- path comparison helpers ----------------------------------------------
  assert.equal(mod.insideRoots('D:/Repo/sub-plugins/x', ['d:/repo'], 'win32'), true, 'win32 comparison is case-insensitive')
  assert.equal(mod.insideRoots('D:/RepoX/sub-plugins/x', ['D:/Repo'], 'win32'), false, 'prefix must be a path boundary')
  assert.equal(mod.insideRoots(path.join('C:', 'a', 'b'), ['C:/a'], 'win32'), true, 'separators are normalized')

  // --- relative link: profile (the current layout) ---------------------------
  {
    const relHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-uninstall-rel-'))
    const relProfile = path.join(relHome, 'profiles', 'web')
    fs.mkdirSync(relProfile, { recursive: true })
    const relSpecOf = (dir) => 'link:./node_modules/dsh-plugin-manager/sub-plugins/' + dir
    fs.writeFileSync(path.join(relProfile, 'package.json'), JSON.stringify({
      name: 'dsh-profile-web',
      dependencies: { 'dsh-plugin-manager': 'link:' + repoRoot },
      devDependencies: { 'dsh-aaa': relSpecOf('dsh-aaa'), 'dsh-bbb': relSpecOf('dsh-bbb') },
      dsh: { profile: { bundles: ['dsh-plugin-manager'] } },
    }, null, 2))
    const relEngine = { loadDoc: (t) => JSON.parse(t), dumpDoc: (d) => JSON.stringify(d) }
    const plan = mod.planUninstall({ profileDir: relProfile, repoRoot, engine: relEngine, profile: 'web', home: relHome })
    assert.deepEqual(plan.depNames, ['dsh-aaa', 'dsh-bbb'], 'relative link: keys are recognised by package name')
    assert.equal(plan.workspaceChanged, false, 'no retired anchor present → nothing to rewrite')
    const res = await mod.runUninstall(plan, { engine: relEngine, pnpm: async () => ({ ok: true, code: 0 }) })
    assert.equal(res.installed, true)
    const after = JSON.parse(fs.readFileSync(path.join(relProfile, 'package.json'), 'utf8'))
    assert.equal(after.devDependencies['dsh-aaa'], undefined, 'relative link: dependency key removed')
    fs.rmSync(relHome, { recursive: true, force: true })
  }

  // --- retired workspace:* profile: keys and the anchor glob are still cleaned -
  {
    const wsHome = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-uninstall-ws-'))
    const wsProfile = path.join(wsHome, 'profiles', 'web')
    fs.mkdirSync(wsProfile, { recursive: true })
    fs.writeFileSync(path.join(wsProfile, 'package.json'), JSON.stringify({
      name: 'dsh-profile-web',
      dependencies: { 'dsh-plugin-manager': 'link:' + repoRoot },
      devDependencies: { 'dsh-aaa': 'workspace:*', 'dsh-bbb': 'workspace:*' },
      dsh: { profile: { bundles: ['dsh-plugin-manager'] } },
    }, null, 2))
    const wsFile = path.join(wsProfile, 'pnpm-workspace.yaml')
    const glob = path.join(repoRoot, 'sub-plugins', '*').split(String.fromCharCode(92)).join('/')
    fs.writeFileSync(wsFile, JSON.stringify({ packages: ['.', glob, 'packages/*'], nodeLinker: 'hoisted' }))
    // The profile carries js-yaml for real; a JSON-subset stub keeps this offline.
    const wsEngine = { loadDoc: (t) => JSON.parse(t), dumpDoc: (d) => JSON.stringify(d) }
    const plan = mod.planUninstall({ profileDir: wsProfile, repoRoot, engine: wsEngine, profile: 'web', home: wsHome })
    assert.deepEqual(plan.depNames, ['dsh-aaa', 'dsh-bbb'], 'workspace:* keys are recognised without any path')
    assert.equal(plan.workspaceChanged, true, 'the glob naming this repo is dropped from the anchor')
    assert.deepEqual(plan.nextWorkspaceDoc.packages, ['.', 'packages/*'], 'other globs survive')
    assert.equal(plan.nextWorkspaceDoc.nodeLinker, 'hoisted', 'unrelated keys are byte-identical')
    const res = await mod.runUninstall(plan, { engine: wsEngine, pnpm: async () => ({ ok: true, code: 0 }) })
    assert.equal(res.installed, true)
    assert.deepEqual(JSON.parse(fs.readFileSync(wsFile, 'utf8')).packages, ['.', 'packages/*'], 'anchor rewritten on disk')
    assert.equal(JSON.parse(fs.readFileSync(path.join(wsProfile, 'package.json'), 'utf8')).devDependencies['dsh-aaa'], undefined, 'workspace dependency key removed')
    fs.rmSync(wsHome, { recursive: true, force: true })
  }

} finally {
  fs.rmSync(tmpRoot, { recursive: true, force: true })
}

console.log('uninstall tests: PASS')
