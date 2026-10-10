import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath } from 'node:url'

import {
  retiredRowIds,
  stripRetiredPatchRows,
  stripRetiredManifestKeys,
  findRow,
  readPatchRows,
  makeYamlEngine,
} from '../src/host-core.js'
import { ensureRetiredSwept } from '../src/index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.resolve(here, '..', '..')
const realHome = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
  ? process.env.DSH_HOME.trim()
  : path.join(os.homedir(), '.dsh')
const realYaml = path.join(realHome, 'profiles', 'web', 'node_modules', 'js-yaml')

// --- 1. pure functions (no js-yaml needed) -----------------------------------

assert.deepEqual(
  retiredRowIds(),
  ['open-session-workdir', 'hindsight-model'],
  'retired row ids are derived from RETIRED_PLUGIN_DIRS in order',
)

{
  const rows = [
    { insert: [{ id: 'esc-rewind', name: 'dsh-esc-rewind' }] },
    { insert: [{ id: 'hindsight-model', name: 'dsh-hindsight-model' }] },
    { id: 'mcp-something', host: { 'mcpServers': { x: { command: 'x' } } } },
  ]
  const snapshot = JSON.stringify(rows)
  const { rows: next, removed } = stripRetiredPatchRows(rows)
  assert.deepEqual(removed, ['hindsight-model'], 'only the retired id is reported removed')
  assert.equal(next.length, 2, 'retired insert row (now empty) is dropped entirely')
  assert.equal(
    JSON.stringify(next[0]), JSON.stringify(rows[0]),
    'surviving rows are unchanged (same object content)',
  )
  assert.notEqual(next, rows, 'a fresh array is returned when something was removed')
  assert.equal(JSON.stringify(rows), snapshot, 'input array is not mutated')

  // idempotence at the pure level: a clean array returns the SAME reference
  const again = stripRetiredPatchRows(next)
  assert.deepEqual(again.removed, [], 'clean rows: nothing removed')
  assert.equal(again.rows, next, 'clean rows: same reference back (zero-write signal)')

  // an override row keyed by a retired id is removed too (removeManaged semantics)
  const withOverride = [
    { id: 'open-session-workdir', disabled: true },
    { insert: [{ id: 'terminal-font', name: 'dsh-terminal-font' }] },
  ]
  const swept = stripRetiredPatchRows(withOverride)
  assert.deepEqual(swept.removed, ['open-session-workdir'])
  assert.equal(swept.rows.length, 1)
  assert.equal(swept.rows[0].insert[0].id, 'terminal-font')
}

{
  const manifest = {
    dependencies: { 'dsh-open-session-workdir': 'link:D:/old/sub-plugins/dsh-open-session-workdir' },
    devDependencies: {
      'dsh-hindsight-model': 'workspace:*',
      'dsh-esc-rewind': 'link:./node_modules/dsh-plugin-manager/sub-plugins/dsh-esc-rewind',
    },
  }
  const snapshot = JSON.stringify(manifest)
  const { manifest: next, removedKeys } = stripRetiredManifestKeys(manifest)
  assert.deepEqual(
    [...removedKeys].sort(),
    ['dsh-hindsight-model', 'dsh-open-session-workdir'],
    'keys hit in BOTH sections are all reported',
  )
  assert.equal(next.dependencies['dsh-open-session-workdir'], undefined, 'dependencies key removed')
  assert.equal(next.devDependencies['dsh-hindsight-model'], undefined, 'devDependencies key removed')
  assert.equal(
    next.devDependencies['dsh-esc-rewind'],
    manifest.devDependencies['dsh-esc-rewind'],
    'a live sibling key survives byte-identical',
  )
  assert.equal(JSON.stringify(manifest), snapshot, 'manifest argument is not mutated')

  const clean = stripRetiredManifestKeys(next)
  assert.deepEqual(clean.removedKeys, [], 'clean manifest: nothing removed')
  assert.equal(clean.manifest, next, 'clean manifest: same reference back')

  // degraded shapes never throw
  assert.deepEqual(stripRetiredManifestKeys(null).removedKeys, [])
  assert.deepEqual(stripRetiredManifestKeys({}, ['dsh-hindsight-model']).removedKeys, [])
  assert.deepEqual(stripRetiredManifestKeys({ dependencies: null, devDependencies: 'x' }).removedKeys, [])
}

// --- 2. ensureRetiredSwept integration (needs the real js-yaml) --------------

if (!fs.existsSync(realYaml)) {
  console.log(`retired-sweep tests: PARTIAL PASS (pure functions); SKIP integration (no js-yaml at ${realYaml})`)
} else {
  const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-retired-sweep-'))
  try {
    const profileDir = path.join(tmpRoot, 'profiles', 'web')
    fs.mkdirSync(path.join(profileDir, 'node_modules'), { recursive: true })
    // js-yaml copied in (symlink/junction to node_modules dirs can EPERM: cpSync instead)
    fs.cpSync(realYaml, path.join(profileDir, 'node_modules', 'js-yaml'), { recursive: true })

    const patchFile = path.join(profileDir, 'cordis.patch.yml')
    const manifestFile = path.join(profileDir, 'package.json')
    const retVal = path.join(profileDir, 'node_modules', 'dsh-hindsight-model')
    const srcDir = path.join(repoRoot, 'sub-plugins', 'dsh-hindsight-model')

    // seed: ghost insert row + live sibling row, retired keys in BOTH manifest
    // sections, and ajunction link at node_modules/dsh-hindsight-model
    fs.writeFileSync(patchFile, [
      '- insert:',
      '    - id: esc-rewind',
      '      name: dsh-esc-rewind',
      '- insert:',
      '    - id: hindsight-model',
      '      name: dsh-hindsight-model',
      '- insert:',
      '    - id: hindsight-model',
      '      name: dsh-hindsight-model',
      '      disabled: true',
    ].join('\n') + '\n', 'utf8')
    fs.writeFileSync(manifestFile, JSON.stringify({
      name: 'web',
      private: true,
      dependencies: { 'dsh-open-session-workdir': 'link:D:/dsh-plugins/sub-plugins/dsh-open-session-workdir' },
      devDependencies: {
        'dsh-hindsight-model': 'workspace:*',
        'dsh-esc-rewind': 'link:./node_modules/dsh-plugin-manager/sub-plugins/dsh-esc-rewind',
      },
    }, null, 2) + '\n', 'utf8')
    fs.symlinkSync(srcDir, retVal, 'junction')
    assert.ok(fs.existsSync(retVal), 'junction resolves to the real source dir before the sweep')

    const c = { profileDir, patchFile, manifestFile }
    const result = ensureRetiredSwept(c)
    assert.equal(result.changed, true, 'first sweep changes the profile')
    assert.deepEqual(result.rows, ['hindsight-model'])
    assert.deepEqual(
      [...result.keys].sort(),
      ['dsh-hindsight-model', 'dsh-open-session-workdir'],
      'retired keys from BOTH sections are removed',
    )
    assert.deepEqual(result.unlinked, ['dsh-hindsight-model'])
    assert.equal(result.backups.length, 2, 'patch + manifest each get one timestamped backup')
    assert.ok(result.backups.every((b) => fs.existsSync(b)), 'backup files exist on disk')

    // patch rows: ghost gone, sibling row intact, file still parseable
    const req = createRequire(path.join(profileDir, 'package.json'))
    const jsmod = req('js-yaml')
    const engine = makeYamlEngine(jsmod.default || jsmod)
    const rows = readPatchRows(engine, patchFile)
    assert.equal(findRow(rows, 'hindsight-model'), null, 'ghost row is gone')
    const live = findRow(rows, 'esc-rewind')
    assert.notEqual(live, null, 'live sibling row survives the sweep')
    assert.equal(rows.length, 1, 'collapsed duplicate ghost rows leave exactly the live row')

    // manifest: retired keys gone, sibling key identical
    const after = JSON.parse(fs.readFileSync(manifestFile, 'utf8'))
    assert.equal(after.dependencies['dsh-open-session-workdir'], undefined)
    assert.equal(after.devDependencies['dsh-hindsight-model'], undefined)
    assert.equal(
      after.devDependencies['dsh-esc-rewind'],
      'link:./node_modules/dsh-plugin-manager/sub-plugins/dsh-esc-rewind',
    )

    // link point removed, real source directory untouched
    assert.ok(!fs.existsSync(retVal), 'junction link point is removed')
    assert.ok(fs.existsSync(path.join(srcDir, 'package.json')), 'repo source dir is NOT touched')
    assert.ok(!fs.existsSync(path.join(profileDir, 'node_modules', 'dsh-open-session-workdir')),
      'no link existed for the other retired dir: nothing created')

    // idempotence: second sweep is a zero-write no-op
    const backupsBefore = fs.readdirSync(profileDir).filter((f) => f.includes('.bak-')).length
    const second = ensureRetiredSwept(c)
    assert.equal(second.changed, false, 'second sweep: nothing to do')
    assert.equal(second.error, null, 'second sweep: no diagnostics')
    assert.deepEqual(second.rows, [])
    assert.deepEqual(second.keys, [])
    assert.deepEqual(second.unlinked, [])
    assert.deepEqual(second.backups, [], 'second sweep: zero new backups')
    const backupsAfter = fs.readdirSync(profileDir).filter((f) => f.includes('.bak-')).length
    assert.equal(backupsAfter, backupsBefore, 'backup count on disk is unchanged')

    // degraded: profile without js-yaml still sweeps keys (patch step skipped)
    const noYamlRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-retired-sweep-ny-'))
    const nyProfile = path.join(noYamlRoot, 'profiles', 'web')
    fs.mkdirSync(nyProfile, { recursive: true })
    const nyManifest = path.join(nyProfile, 'package.json')
    fs.writeFileSync(nyManifest, JSON.stringify({
      devDependencies: { 'dsh-hindsight-model': 'workspace:*' },
    }, null, 2) + '\n', 'utf8')
    const nyResult = ensureRetiredSwept({ profileDir: nyProfile, patchFile: path.join(nyProfile, 'cordis.patch.yml'), manifestFile: nyManifest })
    assert.ok(nyResult.error && nyResult.error.includes('js-yaml'), 'missing yaml is reported as diagnostics')
    assert.deepEqual(nyResult.keys, ['dsh-hindsight-model'], 'key sweep still ran without yaml')
    assert.equal(JSON.parse(fs.readFileSync(nyManifest, 'utf8')).devDependencies['dsh-hindsight-model'], undefined)
    fs.rmSync(noYamlRoot, { recursive: true, force: true })
  } finally {
    fs.rmSync(tmpRoot, { recursive: true, force: true })
  }
}

console.log('retired-sweep tests: PASS')
