
// dsh-agent-preset-manager — host half tests.
//
// The point of these tests is that the whole feature is exercised against a
// throwaway $DSH_HOME: no DSH host, no profile, no registry service. Every
// filesystem effect is asserted on disk, and every rejection path asserts that
// NOTHING was written (the panel promises the user a rollback it must keep).
//
// Run: node --test test/bundle.test.mjs

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { EventEmitter } from 'node:events'
import { pathToFileURL } from 'node:url'

import {
  API_PREFIX,
  COMPOSITION_FILE,
  METADATA_FILE,
  ROUTE_TABLE,
  prepareRows,
  checkRowNames,
  collectState,
  compositionText,
  createOperations,
  createRuntimeProbe,
  dumpRows,
  loadState,
  parseYaml,
  runCommand,
  scanLibraries,
} from '../src/host-core.js'
import { _module, apply, inject, name as pluginName } from '../src/index.js'

const HOME_BACKUP = process.env.DSH_HOME

/** A fake $DSH_HOME plus the real filesystem behind the injected deps. */
function makeWorld(t) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-apm-'))
  const home = path.join(root, 'home')
  fs.mkdirSync(home, { recursive: true })
  t.after(() => fs.rmSync(root, { recursive: true, force: true }))

  const deps = {
    home,
    profileDir: path.join(root, 'profile'),
    exists: (target) => fs.existsSync(target),
    readText: (file) => {
      try {
        return fs.readFileSync(file, 'utf8')
      } catch {
        return null
      }
    },
    readdir: (dir) => fs.readdirSync(dir),
    isDirectory: (target) => {
      // A missing directory is not an error, so ask the cheap question first:
      // that keeps broken-directory tests from tripping over statSync itself.
      if (!fs.existsSync(target)) return false
      try {
        return fs.statSync(target).isDirectory()
      } catch {
        return false
      }
    },
    ensureDir: (dir) => fs.mkdirSync(dir, { recursive: true }),
    writeTextAtomic: (file, text) => {
      const tmp = file + '.tmp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 7)
      fs.writeFileSync(tmp, text, 'utf8')
      fs.renameSync(tmp, file)
    },
    removeDir: (dir) => fs.rmSync(dir, { recursive: true, force: true }),
    copyFile: (from, to) => {
      fs.mkdirSync(path.dirname(to), { recursive: true })
      fs.copyFileSync(from, to)
      return fs.statSync(to).size
    },
    backupFile: (file, keep) => {
      if (!fs.existsSync(file)) return null
      const dir = path.join(path.dirname(file), '.backup')
      fs.mkdirSync(dir, { recursive: true })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-') + '-' + Math.random().toString(36).slice(2, 6)
      const target = path.join(dir, path.basename(file) + '.' + stamp)
      fs.copyFileSync(file, target)
      const prefix = path.basename(file) + '.'
      const old = fs.readdirSync(dir).filter((entry) => entry.startsWith(prefix)).sort()
      for (let i = 0; i < old.length - Math.max(1, keep); i += 1) fs.rmSync(path.join(dir, old[i]))
      return target
    },
    // Resolution only — this is the contract the row health check relies on.
    // A fake that imported modules would hide the bug that killed the launcher.
    resolveSpec: (spec) => (spec.startsWith('missing-') ? null : '/fake/node_modules/' + spec),
    resolvePackageDir: () => null,
    standardSkeletonCandidates: () => [],
  }

  /** A registry stub recording every declared definition. */
  const registry = {
    declared: [],
    register(definition) {
      registry.declared.push(definition)
      const dispose = () => {
        const index = registry.declared.findIndex((row) => row.id === definition.id)
        if (index >= 0) registry.declared.splice(index, 1)
      }
      return dispose
    },
  }

  const runtime = createRuntimeProbe(null, { dsh: 'test' })
  // host-core reads the runtime off the injected deps, so inject it once here and
  // every later swap of world.runtime is visible to the operations.
  deps.runtime = runtime
  const world = {
    root,
    home,
    deps,
    registry,
    runtime,
    core: { deps, runtime, home: () => home },
    ops: null,
    opsFor(targetDeps = deps) {
      return createOperations(targetDeps)
    },
  }
  world.ops = world.opsFor()
  return world
}

/** Write one preset directory; every file is optional. */
function writePreset(world, id, { legacy = false, metadata, composition, extraFiles = {} } = {}) {
  const dir = path.join(world.home, legacy ? '.agent-presets' : 'agent-presets', id)
  fs.mkdirSync(dir, { recursive: true })
  if (metadata !== undefined) fs.writeFileSync(path.join(dir, METADATA_FILE), metadata, 'utf8')
  if (composition !== undefined) fs.writeFileSync(path.join(dir, COMPOSITION_FILE), composition, 'utf8')
  for (const [file, text] of Object.entries(extraFiles)) fs.writeFileSync(path.join(dir, file), text, 'utf8')
  return dir
}

const SAMPLE_ROWS = [
  { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { suffix: 'cwd {{cwd}}' } },
  { id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' },
]

test('package surface: host half exports the cordis contract and stays importable', () => {
  assert.equal(pluginName, 'dsh-agent-preset-manager')
  assert.deepEqual(inject, [])
  assert.equal(typeof apply, 'function')
  assert.equal(typeof _module.runCommand, 'function')
  assert.equal(API_PREFIX, '/__dsh-agent-presets')
  assert.equal(ROUTE_TABLE.length, 8)
  // Every row is complete on its own: the host registers route.path verbatim and
  // runCommand dispatches route.action — no concatenation, no second lookup table.
  const seen = new Set()
  for (const route of ROUTE_TABLE) {
    assert.equal(typeof route.path, 'string')
    assert.ok(route.path.startsWith(API_PREFIX + '/'), 'route path keeps its prefix: ' + route.path)
    assert.ok(route.method === 'GET' || route.method === 'POST')
    assert.ok(route.action && !seen.has(route.action), 'action is unique: ' + route.action)
    seen.add(route.action)
  }
  assert.deepEqual(ROUTE_TABLE, _module.ROUTE_TABLE)
  assert.equal(typeof _module.runCommand, 'function')
})

test('yaml subset: parses the built-in standard preset shape', () => {
  const text = [
    '- insert:',
    '    - id: preset-standard',
    "      name: '@deepseek-ai/dsh-agent-preset'",
    '      config:',
    '        id: standard',
    '        plugins:',
    "          - id: persona",
    "            name: '@deepseek-ai/dsh-persona'",
    '            config:',
    '              suffix: |',
    '                line one',
    '                line two',
    '          - id: tool-bash',
    "            name: '@deepseek-ai/dsh-tool-bash'",
    "            disabled: !!js process.platform === 'win32'",
    '',
  ].join('\n')
  const parsed = parseYaml(text)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.errors.length, 0)
  const rows = parsed.value[0].insert
  assert.equal(rows.length, 1)
  assert.equal(rows[0].id, 'preset-standard')
  const plugins = rows[0].config.plugins
  assert.equal(plugins.length, 2)
  assert.equal(plugins[0].name, '@deepseek-ai/dsh-persona')
  assert.equal(plugins[0].config.suffix, 'line one\nline two\n')
  assert.deepEqual(plugins[1].disabled, { __js: "process.platform === 'win32'" })
})

test('yaml subset: refuses what it cannot represent instead of guessing', () => {
  // Anchors/aliases are still refused, and so is a flow collection that spills
  // across lines — guessing at either would mount a preset the user did not write.
  for (const bad of ['- id: a\n  name: *anchor\n', '- id: a\n  name: &x b\n', '- id: a\n  name: [\n    bash,\n  ]\n', '- id: a\n  name: {a: 1\n']) {
    const parsed = parseYaml(bad)
    assert.equal(parsed.ok, false, 'expected a refusal for: ' + JSON.stringify(bad))
    assert.match(parsed.errors[0].message, /unsupported YAML feature|流式/)
  }
  // One-line flow collections, by contrast, are part of the accepted subset.
  assert.equal(parseYaml('- id: a\n  name: [1, 2]\n').ok, true)
})

test('yaml subset: round-trips rows including !!js, blocks and groups', () => {
  const rows = [
    { id: 'persona', name: '@deepseek-ai/dsh-persona', config: { suffix: 'plain value' } },
    { id: 'tool-bash', name: '@deepseek-ai/dsh-tool-bash', disabled: { __js: "process.platform === 'win32'" } },
    {
      id: 'delegation',
      name: 'cordis:group',
      group: true,
      isolate: { workflowEngine: true },
      config: [{ id: 'tool-subagent', name: '@deepseek-ai/dsh-tool-subagent', config: { section: 'a\nb' } }],
    },
  ]
  const text = dumpRows(rows)
  // Package names stay plain: quoting every value would diverge from the built-ins.
  assert.match(text, /name: '@deepseek-ai\/dsh-persona'/)
  assert.match(text, /disabled: !!js process\.platform === 'win32'/)
  const parsed = parseYaml(text)
  assert.equal(parsed.ok, true)
  assert.equal(parsed.value.length, 3)
  assert.equal(parsed.value[2].config[0].config.section, 'a\nb\n')
  assert.deepEqual(parsed.value[1].disabled, { __js: "process.platform === 'win32'" })
})

test('state file: missing, corrupt and unknown-version inputs degrade to the empty set', (t) => {
  const world = makeWorld(t)
  assert.deepEqual(loadState(world.deps, world.home).state, { version: 1, enabled: [], updatedAt: null })

  fs.mkdirSync(path.join(world.home, 'agent-preset-manager'), { recursive: true })
  const stateFile = path.join(world.home, 'agent-preset-manager', 'state.json')
  fs.writeFileSync(stateFile, '{ not json', 'utf8')
  assert.deepEqual(loadState(world.deps, world.home).state.enabled, [])

  fs.writeFileSync(stateFile, JSON.stringify({ version: 9, enabled: ['a', 42, 'b'] }), 'utf8')
  const loaded = loadState(world.deps, world.home)
  assert.deepEqual(loaded.state.enabled, ['a', 'b'])
})

test('first run enables nothing: an empty home reports zero presets and no enabled ids', (t) => {
  const world = makeWorld(t)
  const state = collectState(world.core)
  assert.equal(state.ok, true)
  assert.equal(state.presets.length, 0)
  assert.deepEqual(state.enabled, [])
  // Before adopt() a panel must read "this DSH build has no preset registry".
  assert.equal(state.runtime.supported, false)
  assert.equal(state.runtime.error, null)
  world.runtime.adopt(world.registry)
  assert.equal(collectState(world.core).runtime.supported, true)
  assert.equal(fs.existsSync(path.join(world.home, 'agent-preset-manager')), false)
})

test('scan: metadata is optional, a missing composition is reported not fatal', (t) => {
  const world = makeWorld(t)
  writePreset(world, 'alpha', { metadata: 'name: 甲\norder: 3\n', composition: compositionText(SAMPLE_ROWS) })
  writePreset(world, 'beta', { composition: compositionText(SAMPLE_ROWS) })
  writePreset(world, 'gamma', { metadata: 'name: [1\n', composition: compositionText(SAMPLE_ROWS) })
  writePreset(world, 'delta', { metadata: 'name: delta\n' })
  fs.mkdirSync(path.join(world.home, 'agent-presets', '.hidden'), { recursive: true })
  fs.writeFileSync(path.join(world.home, 'agent-presets', 'stray.txt'), 'x', 'utf8')

  const state = collectState(world.core)
  assert.deepEqual(state.presets.map((row) => row.id), ['alpha', 'beta', 'delta', 'gamma'])
  const byId = Object.fromEntries(state.presets.map((row) => [row.id, row]))

  assert.equal(byId.alpha.name, '甲')
  assert.equal(byId.alpha.order, 3)
  assert.equal(byId.alpha.status, 'disabled')
  assert.equal(byId.alpha.rowCount, 2)
  assert.equal(byId.alpha.verdict, 'ok')

  // No preset.yml: the directory name is the display name, and that is not an error.
  assert.equal(byId.beta.name, 'beta')
  assert.equal(byId.beta.metadataError, null)

  // Broken metadata is reported and does NOT make the preset invalid: only a broken
  // composition does. The user can still open and fix the file from the panel.
  assert.match(byId.gamma.metadataError, /流式|unsupported YAML feature/)
  assert.equal(byId.gamma.status, 'disabled')
  assert.equal(byId.gamma.name, 'gamma')

  assert.match(byId.delta.compositionError, /agent\.cordis\.yml/)
  assert.equal(byId.delta.status, 'invalid')
})

test('scan: both libraries are read, the legacy directory wins a duplicate id', (t) => {
  const world = makeWorld(t)
  writePreset(world, 'dup', { legacy: true, metadata: 'name: 旧的\n', composition: compositionText(SAMPLE_ROWS) })
  writePreset(world, 'dup', { metadata: 'name: 新的\n', composition: compositionText(SAMPLE_ROWS) })
  writePreset(world, 'fresh', { metadata: 'name: 新的\n', composition: compositionText(SAMPLE_ROWS) })

  const scanned = scanLibraries(world.deps, world.home)
  assert.deepEqual(scanned.shadowed, ['dup'])
  const state = collectState(world.core)
  const byId = Object.fromEntries(state.presets.map((row) => [row.id, row]))
  assert.equal(byId.dup.name, '旧的')
  assert.equal(byId.dup.legacy, true)
  assert.equal(byId.dup.status, 'conflict')
  assert.match(byId.dup.statusDetail, /两个库目录/)
  assert.equal(byId.fresh.status, 'disabled')
})

test('row health: three colours, group rows recursed, disabled rows still judged', (t) => {
  const world = makeWorld(t)
  writePreset(world, 'mixed', {
    metadata: 'name: mixed\n',
    composition: compositionText([
      { id: 'good', name: '@deepseek-ai/dsh-persona' },
      { id: 'gone', name: 'missing-package' },
      { id: 'local-ok', name: './helper.mjs' },
      { id: 'local-gone', name: './absent.mjs' },
      { id: 'off', name: '@deepseek-ai/dsh-persona', disabled: true },
      { id: 'group', name: 'cordis:group', group: true, config: [{ id: 'inner', name: 'missing-inner' }] },
      { id: 'empty-group', name: 'cordis:group', group: true },
    ]),
    extraFiles: { 'helper.mjs': 'export const x = 1\n' },
  })

  const state = collectState(world.core)
  const preset = state.presets[0]
  assert.equal(preset.verdict, 'unavailable')
  assert.deepEqual(preset.verdictCounts, { ok: 4, suspect: 1, unavailable: 3 })
  assert.equal(preset.rowCount, 8, 'group children count as rows too')
  // problems lists the rows of the worst level, group children included.
  const problems = Object.fromEntries(preset.problems.map((row) => [row.rowId, row]))
  assert.deepEqual(Object.keys(problems).sort(), ['gone', 'inner', 'local-gone'])
  assert.match(problems.gone.reason, /missing-package/)
  assert.equal(problems['local-gone'].level, 'unavailable')
  assert.equal(problems['local-gone'].name, './absent.mjs')
  assert.match(problems.inner.reason, /missing-inner/)
  assert.equal(preset.status, 'disabled', 'health never blocks enabling')
  assert.equal(preset.enabled, false)
})
// --- enabling ---------------------------------------------------------------

const SAMPLE_METADATA = 'name: 示例预设\ndescription: 测试用\norder: 30\n'

/**
 * The host's real contract: register() is ASYNC and resolves with the function
 * that undeclares, only after the preset tree has mounted (see
 * agent-preset-registry/src/index.ts:80-100). Modelling it synchronously would
 * hide the very bug this file has to keep out: a promise nobody awaits.
 */
function adoptRegistry(world, spy = null) {
  const registry = {
    declared: [],
    async register(definition) {
      if (spy) spy(definition)
      registry.declared.push(definition)
      await Promise.resolve()
      return async () => {
        const index = registry.declared.findIndex((row) => row.id === definition.id)
        if (index >= 0) registry.declared.splice(index, 1)
      }
    },
  }
  world.runtime.adopt(registry)
  return registry
}

function stateFileOf(world) {
  return path.join(world.home, 'agent-preset-manager', 'state.json')
}

test('enable: declares on the registry and remembers the id in state.json', async (t) => {
  const world = makeWorld(t)
  const registry = adoptRegistry(world)
  writePreset(world, 'mine', { metadata: SAMPLE_METADATA, composition: compositionText(SAMPLE_ROWS) })

  const result = await world.ops.applyEnabled('mine', true)
  assert.equal(result.ok, true)
  assert.equal(registry.declared.length, 1)
  assert.equal(registry.declared[0].id, 'mine')
  assert.equal(registry.declared[0].name, '示例预设')
  assert.equal(registry.declared[0].order, 30)
  assert.deepEqual(registry.declared[0].plugins.map((row) => row.id), ['persona', 'tool-fs'])

  const saved = JSON.parse(fs.readFileSync(stateFileOf(world), 'utf8'))
  assert.deepEqual(saved.enabled, ['mine'])
  assert.equal(saved.version, 1)
  assert.equal(loadState(world.deps, world.home).state.enabled.includes('mine'), true)

  const row = collectState(world.core).presets[0]
  assert.equal(row.enabled, true)
  assert.equal(row.status, 'enabled')
})

test('disable: undeclares and drops every trace of the id', async (t) => {
  const world = makeWorld(t)
  const registry = adoptRegistry(world)
  writePreset(world, 'mine', { metadata: SAMPLE_METADATA, composition: compositionText(SAMPLE_ROWS) })
  await world.ops.applyEnabled('mine', true)

  const off = await world.ops.applyEnabled('mine', false)
  assert.equal(off.ok, true)
  assert.equal(registry.declared.length, 0)
  assert.deepEqual(loadState(world.deps, world.home).state.enabled, [])
  assert.equal(collectState(world.core).presets[0].status, 'disabled')
})

test('enable refuses without a registry, without a directory and without rows', async (t) => {
  const world = makeWorld(t)
  writePreset(world, 'mine', { metadata: SAMPLE_METADATA, composition: compositionText(SAMPLE_ROWS) })

  // No registry adopted yet: 0.2.0-rc2 may not expose one at all.
  const noService = await world.ops.applyEnabled('mine', true)
  assert.equal(noService.ok, false)
  assert.match(noService.error, /没有 agent preset 注册表服务/)
  assert.equal(fs.existsSync(stateFileOf(world)), false, 'a refusal writes no state file')

  const registry = adoptRegistry(world)
  const noDir = await world.ops.applyEnabled('ghost', true)
  assert.equal(noDir.ok, false)
  assert.equal(noDir.error, '找不到这个预设的目录，无法启用：ghost')

  // An empty composition has nothing to declare.
  writePreset(world, 'empty', { metadata: SAMPLE_METADATA, composition: '# 只有注释\n' })
  const noRows = await world.ops.applyEnabled('empty', true)
  assert.equal(noRows.ok, false)
  assert.match(noRows.error, /组成是空的/)
  assert.equal(registry.declared.length, 0)
  assert.deepEqual(loadState(world.deps, world.home).state.enabled, [])
})

test('enable keeps the disk clean when the registry refuses the declaration', async (t) => {
  const world = makeWorld(t)
  const throwing = {
    register() { throw new Error('Duplicate preset id: mine') },
  }
  world.runtime.adopt(throwing)
  writePreset(world, 'mine', { metadata: SAMPLE_METADATA, composition: compositionText(SAMPLE_ROWS) })

  const result = await world.ops.applyEnabled('mine', true)
  assert.equal(result.ok, false)
  assert.match(result.error, /宿主注册预设失败：Duplicate preset id: mine/)
  assert.match(result.error, /已经有一个同名声明/)
  assert.equal(fs.existsSync(stateFileOf(world)), false)

  // A registry that registers but cannot undeclare is refused too.
  const forgetful = makeWorld(t)
  writePreset(forgetful, 'mine', { metadata: SAMPLE_METADATA, composition: compositionText(SAMPLE_ROWS) })
  forgetful.runtime.adopt({ register: () => undefined })
  const noDispose = await forgetful.ops.applyEnabled('mine', true)
  assert.equal(noDispose.ok, false)
  assert.match(noDispose.error, /没有返回撤销函数/)
  assert.equal(forgetful.runtime.getHandles().size, 0)
  assert.equal(fs.existsSync(stateFileOf(forgetful)), false)
})

test('enable rolls the declaration back when the state file cannot be written', async (t) => {
  const world = makeWorld(t)
  const registry = adoptRegistry(world)
  writePreset(world, 'mine', { metadata: SAMPLE_METADATA, composition: compositionText(SAMPLE_ROWS) })
  world.deps.writeTextAtomic = () => { throw new Error('EACCES: read-only file system') }

  const result = await world.ops.applyEnabled('mine', true)
  assert.equal(result.ok, false)
  assert.match(result.error, /保存启用状态失败：EACCES/)
  assert.equal(registry.declared.length, 0, 'the declaration was undone, so a retry can succeed')
  assert.equal(world.runtime.getHandles().size, 0)
})

// Regression: the host declares register() as async, so the disposer arrives in a
// promise. Reading that promise as a function used to refuse every enable AND to
// leave a rejection unhandled -- which the dsh launcher reports as
// `fatal load failure`. These four tests pin the whole contract down.

test('enable awaits an async registry and keeps its late disposer', async (t) => {
  const world = makeWorld(t)
  const declared = []
  world.runtime.adopt({
    async register(definition) {
      await Promise.resolve()
      declared.push(definition)
      return async () => {
        const index = declared.findIndex((row) => row.id === definition.id)
        if (index >= 0) declared.splice(index, 1)
      }
    },
  })
  writePreset(world, 'mine', { metadata: SAMPLE_METADATA, composition: compositionText(SAMPLE_ROWS) })

  const on = await world.ops.applyEnabled('mine', true)
  assert.equal(on.ok, true)
  assert.equal(declared.length, 1)
  assert.equal(world.runtime.getHandles().size, 1)

  // The disposer the host resolved with is the one 「停用」 must reach.
  const off = await world.ops.applyEnabled('mine', false)
  assert.equal(off.ok, true)
  assert.equal(declared.length, 0)
  assert.equal(world.runtime.getHandles().size, 0)
  assert.deepEqual(loadState(world.deps, world.home).state.enabled, [])
})

test('a refused declaration is a failure, never an unhandled rejection', async (t) => {
  const world = makeWorld(t)
  const seen = []
  const onUnhandled = (reason) => seen.push(String((reason && reason.message) || reason))
  process.on('unhandledRejection', onUnhandled)
  try {
    world.runtime.adopt({
      async register() { throw new Error('Duplicate agent preset: mine') },
    })
    writePreset(world, 'mine', { metadata: SAMPLE_METADATA, composition: compositionText(SAMPLE_ROWS) })

    const result = await world.ops.applyEnabled('mine', true)
    assert.equal(result.ok, false)
    assert.match(result.error, /宿主注册预设失败：Duplicate agent preset: mine/)
    assert.match(result.error, /已经有一个同名声明/)
    assert.equal(fs.existsSync(stateFileOf(world)), false, 'a refusal never reaches state.json')

    await new Promise((resolve) => setImmediate(resolve))
    assert.deepEqual(seen, [])
  } finally {
    process.off('unhandledRejection', onUnhandled)
  }
})

test('enable hands the host absolute file URLs for rows written relative', async (t) => {
  const world = makeWorld(t)
  const seen = []
  adoptRegistry(world, (definition) => seen.push(definition))
  writePreset(world, 'local', {
    metadata: 'name: local\n',
    composition: compositionText([
      { id: 'persona', name: '@deepseek-ai/dsh-persona' },
      { id: 'helper', name: './helper.mjs' },
      { id: 'up', name: '../shared.mjs' },
      { id: 'group', name: 'cordis:group', group: true, config: [{ id: 'inner', name: './inner.mjs' }] },
      // Written as `disabled: !!js …`, read back as a wrapper, handed over as a boolean.
      { id: 'win-only', name: '@deepseek-ai/dsh-persona', disabled: { __js: "process.platform === 'win32'" } },
    ]),
    extraFiles: { 'helper.mjs': 'export const x = 1\n' },
  })

  const result = await world.ops.applyEnabled('local', true)
  assert.equal(result.ok, true)
  const presetDir = path.join(world.home, 'agent-presets', 'local')
  const byId = Object.fromEntries(seen[0].plugins.map((row) => [row.id, row]))
  assert.equal(byId.persona.name, '@deepseek-ai/dsh-persona', 'a package name is left alone')
  assert.equal(byId.helper.name, pathToFileURL(path.join(presetDir, 'helper.mjs')).href)
  assert.equal(byId.up.name, pathToFileURL(path.join(presetDir, '..', 'shared.mjs')).href)
  assert.equal(byId.group.config[0].name, pathToFileURL(path.join(presetDir, 'inner.mjs')).href)
  assert.equal(byId['win-only'].disabled, process.platform === 'win32', 'the host gets a boolean, not {__js}')
  // The rewrite is for the host only: the file on disk still reads as written.
  assert.match(fs.readFileSync(path.join(presetDir, 'agent.cordis.yml'), 'utf8'), /name: \.\/helper\.mjs/)
})

test('prepareRows rewrites only relative row names', (t) => {
  const base = path.resolve(os.tmpdir(), 'preset')
  const rows = prepareRows([
    { id: 'a', name: '@deepseek-ai/dsh-persona' },
    { id: 'b', name: 'cordis:group' },
    { id: 'c', name: 'file:///tmp/x.mjs' },
    { id: 'd', name: 'C:\\tmp\\x.mjs' },
    { id: 'e', name: './x.mjs' },
  ], base)
  assert.deepEqual(rows.map((row) => row.name), [
    '@deepseek-ai/dsh-persona',
    'cordis:group',
    'file:///tmp/x.mjs',
    'C:\\tmp\\x.mjs',
    pathToFileURL(path.join(base, 'x.mjs')).href,
  ])
  // No base directory: the row keeps its legacy spelling instead of guessing.
  assert.equal(prepareRows([{ id: 'e', name: './x.mjs' }], null)[0].name, './x.mjs', 'no base directory: the legacy spelling is kept')
})

test('prepareRows evaluates !!js values instead of handing the wrapper to the host', (t) => {
  const rows = prepareRows([
    { id: 'win', name: 'pkg', disabled: { __js: "process.platform === 'win32'" } },
    { id: 'group', name: 'cordis:group', group: true, config: [{ id: 'inner', name: 'pkg', disabled: { __js: '1 === 1' } }] },
  ], null)
  assert.equal(rows[0].disabled, process.platform === 'win32')
  assert.equal(typeof rows[0].disabled, 'boolean')
  assert.equal(rows[1].config[0].disabled, true)
  // An expression that cannot run is refused by name, never silently ignored.
  let caught = null
  try {
    prepareRows([{ id: 'bad', name: 'pkg', disabled: { __js: '(((' } }], null)
  } catch (error) {
    caught = error
  }
  assert.match(String(caught && caught.message), /!!js 表达式无法求值/)
  assert.match(String(caught && caught.message), /\(\(\(/)
})

test('parseYaml reads the one-line flow collections real compositions use', (t) => {
  const text = [
    '- id: a',
    '  name: pkg',
    '  config:',
    '    shellTools: [bash]',
    '    messageSources: [user, goal]',
    '    nested: {a: 1, b: [x, y]}',
    '    empty: []',
    '    quoted: ["a, b", "c"]',
  ].join('\n')
  const parsed = parseYaml(text)
  assert.equal(parsed.ok, true, JSON.stringify(parsed.errors))
  const config = parsed.value[0].config
  assert.deepEqual(config.shellTools, ['bash'])
  assert.deepEqual(config.messageSources, ['user', 'goal'])
  assert.deepEqual(config.nested, { a: 1, b: ['x', 'y'] })
  assert.deepEqual(config.empty, [])
  assert.deepEqual(config.quoted, ['a, b', 'c'])
  // A collection that spills across lines is refused by name, never silently
  // truncated: half a tool list would mount as a preset the user did not write.
  const split = parseYaml('- id: a\n  config:\n    tools: [\n      bash,\n    ]\n')
  assert.equal(split.ok, false)
  assert.match(String(split.errors[0] && split.errors[0].message), /流式/)
})

// --- create -----------------------------------------------------------------

/** The built-in standard preset: the skeleton a new preset is seeded from. */
const STANDARD_PATCH = [
  "- insert:",
  "    - id: preset-standard",
  "      name: '@deepseek-ai/dsh-agent-preset'",
  "      config:",
  "        plugins:",
  "          - id: persona",
  "            name: '@deepseek-ai/dsh-persona'",
  "            config:",
  "              suffix: |-",
  "                cwd {{cwd}}",
  "          - id: tool-fs",
  "            name: '@deepseek-ai/dsh-tool-fs'",
  "",
].join('\n')

function withSkeleton(world) {
  const file = path.join(world.root, 'standard.patch.yml')
  fs.writeFileSync(file, STANDARD_PATCH, 'utf8')
  world.deps.standardSkeletonCandidates = () => [file]
  return file
}

test('create: seeds a new preset from the built-in standard skeleton', async (t) => {
  const world = makeWorld(t)
  const skeletonFile = withSkeleton(world)

  const result = await world.ops.create({ id: 'brand-new', name: '新预设', description: '说明', order: 12 })
  assert.equal(result.ok, true)
  assert.equal(result.rowCount, 2)
  assert.equal(result.skeletonSource, skeletonFile)

  const dir = path.join(world.home, 'agent-presets', 'brand-new')
  assert.equal(fs.existsSync(path.join(dir, METADATA_FILE)), true)
  assert.equal(fs.existsSync(path.join(dir, COMPOSITION_FILE)), true)
  const metadata = fs.readFileSync(path.join(dir, METADATA_FILE), 'utf8')
  assert.match(metadata, /^name: "新预设"$/m)
  assert.match(metadata, /^description: "说明"$/m)
  assert.match(metadata, /^order: 12$/m)

  // The seeded composition is the skeleton, and it survives a round-trip.
  const roundTrip = parseYaml(fs.readFileSync(path.join(dir, COMPOSITION_FILE), 'utf8'))
  assert.equal(roundTrip.ok, true)
  assert.deepEqual(roundTrip.value.map((row) => row.id), ['persona', 'tool-fs'])
  assert.equal(roundTrip.value[0].config.suffix, 'cwd {{cwd}}\n')

  const row = collectState(world.core).presets[0]
  assert.equal(row.id, 'brand-new')
  assert.equal(row.name, '新预设')
  assert.equal(row.status, 'disabled')
})

test('create: refuses a bad id, an existing id and a missing skeleton', async (t) => {
  const world = makeWorld(t)

  const badId = await world.ops.create({ id: 'Bad Id!' })
  assert.equal(badId.ok, false)
  assert.match(badId.error, /预设 id 只能是/)
  assert.equal(fs.existsSync(path.join(world.home, 'agent-presets')), false)

  // No skeleton readable: the create is cancelled instead of half-written.
  const noSkeleton = await world.ops.create({ id: 'brand-new' })
  assert.equal(noSkeleton.ok, false)
  assert.match(noSkeleton.error, /读取内置 standard 预设的插件清单失败/)
  assert.equal(fs.existsSync(path.join(world.home, 'agent-presets', 'brand-new')), false)

  withSkeleton(world)
  writePreset(world, 'taken', { metadata: SAMPLE_METADATA, composition: compositionText(SAMPLE_ROWS) })
  const taken = await world.ops.create({ id: 'taken' })
  assert.equal(taken.ok, false)
  assert.equal(taken.error, '同名预设已经存在，拒绝覆盖：taken')
  assert.match(fs.readFileSync(path.join(world.home, 'agent-presets', 'taken', METADATA_FILE), 'utf8'), /示例预设/)
})

// --- save -------------------------------------------------------------------

test('save: writes the file, keeps a backup and rotates it at three', async (t) => {
  const world = makeWorld(t)
  writePreset(world, 'mine', { metadata: SAMPLE_METADATA, composition: compositionText(SAMPLE_ROWS) })
  const file = path.join(world.home, 'agent-presets', 'mine', COMPOSITION_FILE)
  const backupDir = path.join(world.home, 'agent-presets', 'mine', '.backup')

  const edited = compositionText([{ id: 'persona', name: '@deepseek-ai/dsh-persona', config: { suffix: '第一次编辑' } }])
  const first = await world.ops.save({ id: 'mine', text: edited })
  assert.equal(first.ok, true)
  assert.equal(first.rowCount, 1)
  assert.equal(path.dirname(first.backup), backupDir)
  assert.match(fs.readFileSync(file, 'utf8'), /第一次编辑/)

  for (let i = 2; i <= 5; i += 1) {
    const next = await world.ops.save({ id: 'mine', text: compositionText([{ id: 'persona', name: '@deepseek-ai/dsh-persona', config: { suffix: '第' + i + '次编辑' } }]) })
    assert.equal(next.ok, true)
  }
  const kept = fs.readdirSync(backupDir).filter((name) => name.startsWith(COMPOSITION_FILE + '.'))
  assert.equal(kept.length, 3, 'only three backups are kept')
})

test('save: a rejected edit leaves the file byte-for-byte untouched', async (t) => {
  const world = makeWorld(t)
  writePreset(world, 'mine', { metadata: SAMPLE_METADATA, composition: compositionText(SAMPLE_ROWS) })
  const file = path.join(world.home, 'agent-presets', 'mine', COMPOSITION_FILE)
  const before = fs.readFileSync(file, 'utf8')
  const backupDir = path.join(world.home, 'agent-presets', 'mine', '.backup')

  const empty = await world.ops.save({ id: 'mine', text: '   ' })
  assert.equal(empty.ok, false)
  assert.equal(empty.error, '提交的组合是空的，已拒绝保存。')

  const broken = await world.ops.save({ id: 'mine', text: '- id: persona\n  name: [1\n' })
  assert.equal(broken.ok, false)
  assert.match(broken.error, /^第 \d+ 行：流式/)

  const commentOnly = await world.ops.save({ id: 'mine', text: '# 只有注释\n' })
  assert.equal(commentOnly.ok, false)
  assert.equal(commentOnly.error, '组合里没有任何插件行，已拒绝保存。')

  const duplicate = await world.ops.save({ id: 'mine', text: compositionText([SAMPLE_ROWS[0], SAMPLE_ROWS[0]]) })
  assert.equal(duplicate.ok, false)
  assert.equal(duplicate.error, '行 id 重复：persona')

  assert.equal(fs.readFileSync(file, 'utf8'), before)
  assert.equal(fs.existsSync(backupDir), false, 'a rejected save takes no backup either')

  const unknown = await world.ops.save({ id: 'ghost', text: compositionText(SAMPLE_ROWS) })
  assert.equal(unknown.ok, false)
  assert.match(unknown.error, /找不到预设目录：ghost/)
})

test('save: a backup failure aborts the write instead of losing the old file', async (t) => {
  const world = makeWorld(t)
  writePreset(world, 'mine', { metadata: SAMPLE_METADATA, composition: compositionText(SAMPLE_ROWS) })
  const file = path.join(world.home, 'agent-presets', 'mine', COMPOSITION_FILE)
  const before = fs.readFileSync(file, 'utf8')
  world.deps.backupFile = () => { throw new Error('ENOSPC: no space left on device') }

  const result = await world.ops.save({ id: 'mine', text: compositionText([{ id: 'tool-fs', name: '@deepseek-ai/dsh-tool-fs' }]) })
  assert.equal(result.ok, false)
  assert.match(result.error, /写入备份失败，已拒绝保存/)
  assert.equal(fs.readFileSync(file, 'utf8'), before)
})

// --- remove -----------------------------------------------------------------

test('remove: asks once, then undeclares, forgets the id and deletes the dir', async (t) => {
  const world = makeWorld(t)
  const registry = adoptRegistry(world)
  writePreset(world, 'mine', { metadata: SAMPLE_METADATA, composition: compositionText(SAMPLE_ROWS) })
  await world.ops.applyEnabled('mine', true)

  const asked = await world.ops.remove({ id: 'mine' })
  assert.equal(asked.ok, false)
  assert.equal(asked.needsConfirm, true)
  assert.equal(asked.error, '删除是不可撤销的操作，需要二次确认。')
  assert.equal(fs.existsSync(asked.dir), true)
  assert.equal(registry.declared.length, 1, 'nothing happens before the confirmation')

  const done = await world.ops.remove({ id: 'mine', confirm: true })
  assert.equal(done.ok, true)
  assert.equal(done.dirRemoved, true)
  assert.equal(registry.declared.length, 0)
  assert.equal(fs.existsSync(done.dir), false)
  assert.deepEqual(loadState(world.deps, world.home).state.enabled, [])
  assert.deepEqual(collectState(world.core).presets, [])
})

test('remove: a failed directory delete is reported, not hidden', async (t) => {
  const world = makeWorld(t)
  writePreset(world, 'mine', { metadata: SAMPLE_METADATA, composition: compositionText(SAMPLE_ROWS) })
  world.deps.removeDir = () => { throw new Error('EPERM: operation not permitted') }

  const result = await world.ops.remove({ id: 'mine', confirm: true })
  assert.equal(result.ok, true)
  assert.equal(result.dirRemoved, false)
  assert.match(result.warning, /已撤除声明，但目录未能删除：/)
  assert.match(result.warning, /EPERM/)
  assert.equal(fs.existsSync(result.dir), true)
})

// --- import and migrate ------------------------------------------------------

function writeSource(world, name, { metadata = SAMPLE_METADATA, composition = compositionText(SAMPLE_ROWS), files = {} } = {}) {
  const dir = path.join(world.root, 'sources', name)
  fs.mkdirSync(dir, { recursive: true })
  if (metadata !== null) fs.writeFileSync(path.join(dir, METADATA_FILE), metadata, 'utf8')
  if (composition !== null) fs.writeFileSync(path.join(dir, COMPOSITION_FILE), composition, 'utf8')
  for (const [file, text] of Object.entries(files)) fs.writeFileSync(path.join(dir, file), text, 'utf8')
  return dir
}

test('import: preflight first, then copy the whole directory', async (t) => {
  const world = makeWorld(t)
  const source = writeSource(world, 'shared', { files: { 'notes.txt': 'hello' } })

  const plan = await world.ops.import({ sourceDir: source })
  assert.equal(plan.ok, true)
  assert.equal(plan.preflight, true)
  assert.equal(plan.id, 'shared')
  assert.equal(plan.rowCount, 2)
  assert.equal(plan.targetDir, path.join(world.home, 'agent-presets', 'shared'))
  assert.equal(fs.existsSync(plan.targetDir), false, 'a preflight writes nothing')

  const done = await world.ops.import({ sourceDir: source, confirm: true })
  assert.equal(done.ok, true)
  assert.equal(fs.existsSync(path.join(done.targetDir, 'notes.txt')), true)
  assert.equal(fs.existsSync(path.join(done.targetDir, COMPOSITION_FILE)), true)
  assert.equal(fs.readFileSync(path.join(done.targetDir, 'notes.txt'), 'utf8'), 'hello')
  assert.deepEqual(collectState(world.core).presets.map((row) => row.id), ['shared'])
})

test('import: refuses a non-directory, a foreign directory and a taken id', async (t) => {
  const world = makeWorld(t)
  const notADir = path.join(world.root, 'file.txt')
  fs.writeFileSync(notADir, 'x', 'utf8')
  const foreign = writeSource(world, 'foreign', { metadata: null, composition: null, files: { 'readme.md': 'x' } })

  const missing = await world.ops.import({ sourceDir: notADir })
  assert.equal(missing.ok, false)
  assert.match(missing.error, /不是一个目录/)

  const foreignResult = await world.ops.import({ sourceDir: foreign })
  assert.equal(foreignResult.ok, false)
  assert.match(foreignResult.error, /没有 preset\.yml/)

  writePreset(world, 'shared', { metadata: SAMPLE_METADATA, composition: compositionText(SAMPLE_ROWS) })
  const taken = await world.ops.import({ sourceDir: writeSource(world, 'shared'), confirm: true })
  assert.equal(taken.ok, false)
  assert.equal(taken.error, '同名预设已经存在，拒绝覆盖：shared')
})

test('migrate: plans the old library, then copies it into the current one', async (t) => {
  const world = makeWorld(t)
  writePreset(world, 'old-one', { legacy: true, metadata: 'name: 旧的一号\n', composition: compositionText(SAMPLE_ROWS) })
  writePreset(world, 'old-two', { legacy: true, metadata: 'name: 旧的两号\n', composition: compositionText(SAMPLE_ROWS) })
  writePreset(world, 'old-one', { metadata: 'name: 新的一号\n', composition: compositionText(SAMPLE_ROWS) })

  const plan = await world.ops.migrate({})
  assert.equal(plan.ok, true)
  assert.equal(plan.preflight, true)
  assert.deepEqual(plan.plans.map((row) => row.id).sort(), ['old-one', 'old-two'])
  assert.deepEqual(plan.migrated, [])
  const conflict = plan.plans.find((row) => row.id === 'old-one')
  assert.equal(conflict.status, 'conflict', 'the plan warns before touching anything')
  assert.equal(conflict.conflict, true, 'the plan says the id already lives in the current library')
  assert.equal(fs.existsSync(path.join(world.home, 'agent-presets', 'old-two')), false)

  const done = await world.ops.migrate({ confirm: true })
  assert.equal(done.preflight, false)
  assert.deepEqual(done.migrated.map((row) => row.id).sort(), ['old-one', 'old-two'])
  assert.deepEqual(done.skipped, [])
  assert.equal(fs.existsSync(path.join(world.home, 'agent-presets', 'old-two', COMPOSITION_FILE)), true)
  // The legacy entry keeps winning the duplicate id: migration copies, never moves.
  const rows = collectState(world.core).presets.filter((row) => row.id === 'old-one')
  assert.equal(rows.length, 1)
  assert.equal(rows[0].legacy, true)
})

// --- HTTP surface ------------------------------------------------------------

function makeReq(method, body, url) {
  const req = new EventEmitter()
  req.method = method
  req.url = url === undefined ? '/' : url
  queueMicrotask(() => {
    if (body !== undefined && body !== null) req.emit('data', Buffer.from(body, 'utf8'))
    req.emit('end')
  })
  return req
}

function makeRes() {
  return {
    status: 0,
    headers: null,
    body: '',
    writeHead(status, headers) { this.status = status; this.headers = headers },
    end(chunk) { this.body = String(chunk === undefined ? '' : chunk) }
  }
}

function callHandler(handlers, routePath, method, body, query) {
  const res = makeRes()
  const search = query ? '?' + new URLSearchParams(query).toString() : ''
  return Promise.resolve(handlers[routePath](makeReq(method, body, routePath + search), res)).then(() => ({
    status: res.status,
    headers: res.headers,
    json: JSON.parse(res.body),
  }))
}

test('routes: every registered path is dispatched by its own action and method', (t) => {
  const world = makeWorld(t)
  assert.equal(ROUTE_TABLE.length, 8)
  for (const route of ROUTE_TABLE) assert.equal(route.path.startsWith(API_PREFIX + '/'), true, route.path)
  assert.deepEqual(ROUTE_TABLE.map((route) => route.path), [
    API_PREFIX + '/state', API_PREFIX + '/set-enabled', API_PREFIX + '/create',
    API_PREFIX + '/save', API_PREFIX + '/remove', API_PREFIX + '/import', API_PREFIX + '/migrate',
    API_PREFIX + '/file',
  ])
  const handlers = _module.createHandlers(world.core, null)
  assert.equal(typeof _module.registerRoutes, 'function')
  assert.equal(typeof apply, 'function')
  assert.equal(Array.isArray(inject), true, 'the host half injects no service, so it must not block startup')
  assert.deepEqual(Object.keys(handlers).sort(), ROUTE_TABLE.map((route) => route.path).sort())
})

test('http: GET /file hands the panel a preset composition and rejects an unknown id', (t) => {
  const world = makeWorld(t)
  writePreset(world, 'mine', { metadata: SAMPLE_METADATA, composition: compositionText(SAMPLE_ROWS) })
  const handlers = _module.createHandlers(world.core, null)

  return callHandler(handlers, API_PREFIX + '/file', 'GET', null, { id: 'mine' })
    .then((response) => {
      assert.equal(response.status, 200)
      assert.equal(response.json.ok, true)
      assert.equal(response.json.id, 'mine')
      assert.equal(response.json.file.endsWith(COMPOSITION_FILE), true)
      assert.equal(response.json.text.indexOf('id: persona') >= 0, true)
      assert.equal(typeof response.json.state, 'object')
    })
    .then(() => callHandler(handlers, API_PREFIX + '/file', 'GET', null, { id: 'ghost' }))
    .then((response) => {
      assert.equal(response.status, 400)
      assert.match(response.json.error, /找不到预设目录/)
    })
})

test('http: GET /state answers the panel state as JSON', (t) => {
  const world = makeWorld(t)
  writePreset(world, 'mine', { metadata: SAMPLE_METADATA, composition: compositionText(SAMPLE_ROWS) })
  const handlers = _module.createHandlers(world.core, () => ({ ok: true, restored: { attempted: 0, restored: [], failed: [] } }))

  return callHandler(handlers, API_PREFIX + '/state', 'GET').then((response) => {
    assert.equal(response.status, 200)
    assert.equal(response.headers['content-type'], 'application/json; charset=utf-8')
    assert.equal(response.headers['cache-control'], 'no-store')
    assert.equal(response.json.ok, true)
    assert.equal(response.json.presets.length, 1)
    assert.equal(response.json.presets[0].id, 'mine')
    assert.equal(typeof response.json.restore, 'object', 'state carries the restore report')
  })
})

test('http: the handler is strict about method, route and body', (t) => {
  const world = makeWorld(t)
  const handlers = _module.createHandlers(world.core, null)
  const paths = ROUTE_TABLE.map((route) => route.path)

  return Promise.all([
    callHandler(handlers, paths[0], 'OPTIONS').then((response) => assert.equal(response.status, 204)),
    callHandler(handlers, paths[0], 'POST').then((response) => {
      assert.equal(response.status, 405)
      assert.match(response.json.error, /^只接受 GET /)
    }),
    callHandler(handlers, paths[1], 'GET').then((response) => assert.equal(response.status, 405)),
    callHandler(handlers, paths[1], 'POST', '{"id":').then((response) => {
      assert.equal(response.status, 400)
      assert.equal(response.json.error, '请求体不是合法 JSON')
    }),
    callHandler(handlers, paths[1], 'POST', '[1,2]').then((response) => {
      assert.equal(response.status, 400)
      assert.equal(response.json.error, '缺少参数 id')
    }),
  ])
})

test('http: a rejected command is a 400 and a crash is a 500 with state', (t) => {
  const world = makeWorld(t)
  const handlers = _module.createHandlers(world.core, null)
  const setEnabled = API_PREFIX + '/set-enabled'

  return callHandler(handlers, setEnabled, 'POST', JSON.stringify({ id: 'ghost', enabled: true }))
    .then((response) => {
      assert.equal(response.status, 400)
      assert.equal(response.json.ok, false)
      assert.equal(response.json.error, '找不到这个预设的目录，无法启用：ghost')
      assert.deepEqual(response.json.state.presets, [])
      // Nothing was written, so the panel state is still the empty library.
      assert.equal(world.deps.exists(stateFileOf(world)), false)
    })
    .then(() => {
      // A library that cannot be listed is not a crash: listIdsIn swallows the
      // readdir failure, the scan comes back empty and the command is simply
      // rejected. The panel must still get an answer (400), never a hang.
      const realReaddir = world.deps.readdir
      world.deps.readdir = () => { throw new Error('EIO: i/o error') }
      return callHandler(handlers, setEnabled, 'POST', JSON.stringify({ id: 'mine', enabled: true }))
        .finally(() => { world.deps.readdir = realReaddir })
    })
    .then((response) => {
      assert.equal(response.status, 400)
      assert.equal(response.json.error, '找不到这个预设的目录，无法启用：mine')
      assert.deepEqual(response.json.state.presets, [])
    })
    .then(() => {
      // The library is listable again, and the enable now fails on its very last
      // step instead: writing the state file.
      assert.equal(typeof world.deps.readdir, 'function', 'the fixture restored readdir')
      adoptRegistry(world)
      writePreset(world, 'mine', { metadata: 'name: 我的预设' + String.fromCharCode(10), composition: compositionText(SAMPLE_ROWS) })
      const realWrite = world.deps.writeTextAtomic
      world.deps.writeTextAtomic = (file, text) => {
        if (String(file).endsWith('state.json')) throw new Error('boom: the state store is read-only')
        return realWrite(file, text)
      }
      return callHandler(handlers, setEnabled, 'POST', JSON.stringify({ id: 'mine', enabled: true }))
        .finally(() => { world.deps.writeTextAtomic = realWrite })
    })
    .then((response) => {
      assert.equal(response.status, 400, 'the state write failure is a rejection, not a crash')
      assert.equal(response.json.ok, false)
      assert.match(String(response.json.error), /保存启用状态失败/)
      assert.match(String(response.json.error), /boom: the state store is read-only/)
      assert.equal(world.registry.declared.length, 0, 'a failed enable leaves no declaration behind')
      assert.equal(response.json.state.presets[0].enabled, false, 'and the preset stays disabled in the panel')
    })
    .then(() => {
      // Nothing above crashed, so the tab is alive: the same handler still answers.
      return callHandler(handlers, API_PREFIX + '/state', 'GET')
    })
    .then((response) => {
      assert.equal(response.status, 200)
      assert.equal(response.json.plugin, 'dsh-agent-preset-manager')
    })
})

test('http: create, save, remove and migrate answer 200 on success', (t) => {
  const world = makeWorld(t)
  withSkeleton(world)
  const handlers = _module.createHandlers(world.core, () => ({ ok: true, restored: { attempted: 1, restored: ['x'], failed: [] } }))

  return callHandler(handlers, API_PREFIX + '/create', 'POST', JSON.stringify({ id: 'fresh' }))
    .then((response) => {
      assert.equal(response.status, 200)
      assert.equal(response.json.ok, true)
      assert.equal(response.json.id, 'fresh')
      return callHandler(handlers, API_PREFIX + '/save', 'POST', JSON.stringify({ id: 'fresh', text: compositionText(SAMPLE_ROWS) }))
    })
    .then((response) => {
      assert.equal(response.status, 200)
      assert.equal(response.json.rowCount, 2)
      return callHandler(handlers, API_PREFIX + '/remove', 'POST', JSON.stringify({ id: 'fresh' }))
    })
    .then((response) => {
      assert.equal(response.status, 400, 'remove without confirmation is a client error')
      assert.equal(response.json.needsConfirm, true)
      return callHandler(handlers, API_PREFIX + '/remove', 'POST', JSON.stringify({ id: 'fresh', confirm: true }))
    })
    .then((response) => {
      assert.equal(response.status, 200)
      assert.equal(response.json.dirRemoved, true)
      return callHandler(handlers, API_PREFIX + '/migrate', 'POST', JSON.stringify({}))
    })
    .then((response) => {
      assert.equal(response.status, 200)
      assert.equal(response.json.preflight, true)
      assert.equal(typeof response.json.restore, 'object', 'migrate also refreshes the restore report')
    })
})

test('http: a GET-only state route never writes, and an empty POST body is allowed', (t) => {
  const world = makeWorld(t)
  writePreset(world, 'mine', { metadata: SAMPLE_METADATA, composition: compositionText(SAMPLE_ROWS) })
  const handlers = _module.createHandlers(world.core, null)

  return callHandler(handlers, API_PREFIX + '/migrate', 'POST')
    .then((response) => {
      assert.equal(response.status, 200)
      assert.equal(response.json.preflight, true)
      assert.deepEqual(response.json.migrated, [])
    })
    .then(() => callHandler(handlers, API_PREFIX + '/state', 'GET'))
    .then((response) => {
      assert.equal(response.json.presets.length, 1)
      assert.equal(response.json.restore, null)
    })
})

// --- regression: a probe resolves, it never imports --------------------------
//
// The first shipped version probed a row with `load(spec) { return import(spec) }`
// called synchronously. import() returns a truthy promise, so every row looked
// healthy, and the rejection of a missing package nobody awaited escaped as an
// unhandled rejection: the launcher printed
//   dsh: fatal load failure: ERR_MODULE_NOT_FOUND … imported from …/src/index.js
// and the app died on the health check. These tests pin the resolve-only contract.

test('host deps expose resolveSpec and never a module loader', () => {
  const deps = _module.makeDeps({ baseUrl: undefined, get: () => undefined })
  assert.equal(deps.load, undefined, 'a module loader here is what killed the launcher')
  assert.equal(typeof deps.resolveSpec, 'function')
  const answer = deps.resolveSpec('@deepseek-ai/dsh-package-that-does-not-exist')
  assert.equal(answer, null, 'an unresolvable name answers null instead of throwing')
  assert.ok(!(answer && typeof answer.then === 'function'), 'and never a thenable')
})

test('row health is synchronous, resolution-only, and honest about a null answer', () => {
  const rows = [{ id: 'persona', name: '@deepseek-ai/dsh-persona' }]
  let probes = 0
  const hit = checkRowNames(rows, {
    baseDir: process.cwd(),
    resolve: (spec) => { probes += 1; return path.join('/fake', spec) },
    exists: () => true,
  })
  assert.equal(probes, 1)
  assert.equal(hit[0].level, 'ok')

  // A resolver answering null is NOT a healthy row — with import() it always was.
  const miss = checkRowNames(rows, { baseDir: process.cwd(), resolve: () => null, exists: () => true })
  assert.equal(miss[0].level, 'unavailable')
  assert.match(miss[0].reason, /解析器没有找到该包/)
  assert.match(miss[0].reason, /@deepseek-ai\/dsh-persona/)

  // No resolver at all is reported, never guessed.
  const none = checkRowNames(rows, { baseDir: process.cwd(), exists: () => true })
  assert.equal(none[0].level, 'unavailable')
  assert.match(none[0].reason, /没有可用的模块解析器/)
})

// --- boot: the replay waits for the registry ---------------------------------
//
// A restart used to lose every declaration: mount() ran the replay on the same
// tick as the registry probe, read "no agentPresets service here yet" as "this
// DSH line has no registry", refused every remembered id, and wrote that refusal
// into the report. The registry then arrived, nothing replayed, and state.json
// kept the panel switches on while no session could select a preset.

/** Point makeDeps at this test's throwaway home for the length of the test. */
function useHome(t, home) {
  const previous = process.env.DSH_HOME
  process.env.DSH_HOME = home
  t.after(() => {
    if (previous === undefined) delete process.env.DSH_HOME
    else process.env.DSH_HOME = previous
  })
}

/** The host's contract once more: register() is async and resolves a disposer. */
function asyncRegistry() {
  const registry = {
    declared: [],
    async register(definition) {
      registry.declared.push(definition)
      await Promise.resolve()
      return async () => {
        const index = registry.declared.findIndex((row) => row.id === definition.id)
        if (index >= 0) registry.declared.splice(index, 1)
      }
    },
  }
  return registry
}

/** Write the ledger alone: what the panel believes is enabled. */
function writeLedger(world, ids) {
  fs.mkdirSync(path.join(world.home, 'agent-preset-manager'), { recursive: true })
  fs.writeFileSync(
    stateFileOf(world),
    JSON.stringify({ version: 1, enabled: ids, updatedAt: '2026-10-08T00:00:00.000Z' }),
    'utf8',
  )
}

/**
 * The ctx the boot path sees. Services stay empty unless the test fills them in,
 * which is how a composition that composes the registry AFTER this plugin looks:
 * get() answers nothing and inject() is the only way in.
 */
function makeBootContext({ injectSurface = true, services = {} } = {}) {
  const injected = []
  const registered = []
  const ctx = {
    baseUrl: null,
    services,
    effect(factory) { return typeof factory === 'function' ? factory() : undefined },
    get(key) {
      if (key === 'webServer') {
        return {
          register(route) {
            registered.push(route)
            return () => {}
          },
        }
      }
      return ctx.services[key]
    },
  }
  if (injectSurface) ctx.inject = (names, callback) => injected.push({ names, callback })
  return { ctx, injected, registered }
}

async function waitFor(predicate, timeoutMs = 2000) {
  const deadline = Date.now() + timeoutMs
  for (;;) {
    if (predicate()) return true
    if (Date.now() > deadline) return false
    await new Promise((resolve) => setTimeout(resolve, 5))
  }
}

test('boot: a registry that arrives late is awaited, then the ledger is replayed', async (t) => {
  const world = makeWorld(t)
  writePreset(world, 'mine', { metadata: SAMPLE_METADATA, composition: compositionText(SAMPLE_ROWS) })
  writeLedger(world, ['mine'])
  useHome(t, world.home)

  const { ctx, injected } = makeBootContext()
  const handle = apply(ctx)
  await new Promise((resolve) => setTimeout(resolve, 30))

  assert.equal(handle.describe().restore, null, 'nothing is replayed before a registry exists')
  assert.equal(handle.describe().restorePending, true, 'the pass stays pending, not failed')
  assert.deepEqual(handle.describe().errors, [])

  const registry = asyncRegistry()
  const injection = injected.find((row) => row.names.includes('agentPresets'))
  assert.ok(injection, 'the host half asks to be injected with the registry')
  injection.callback({ agentPresets: registry })

  assert.equal(await waitFor(() => handle.describe().restorePending === false), true, 'the replay settles when the registry does arrive')
  const report = handle.describe().restore
  assert.deepEqual(report.restored, ['mine'])
  assert.deepEqual(report.failed, [])
  assert.deepEqual(registry.declared.map((row) => row.id), ['mine'])
  assert.equal(handle.describe().runtimeSupported, true)
  assert.deepEqual(handle.describe().handles, ['mine'])
})

test('boot: without an injection surface the pass settles instead of hanging', async (t) => {
  const world = makeWorld(t)
  writePreset(world, 'mine', { metadata: SAMPLE_METADATA, composition: compositionText(SAMPLE_ROWS) })
  writeLedger(world, ['mine'])
  useHome(t, world.home)

  const { ctx, injected } = makeBootContext({ injectSurface: false })
  const handle = apply(ctx)
  assert.deepEqual(injected, [], 'nothing is asked for when the composition has no injection surface')
  assert.equal(await waitFor(() => handle.describe().restorePending === false), true)

  const report = handle.describe().restore
  assert.equal(report.attempted, 1)
  assert.deepEqual(report.restored, [])
  assert.match(report.failed[0].error, /没有 agent preset 注册表服务/)
})

test('boot: the first panel read repairs a pass that could not complete', async (t) => {
  const world = makeWorld(t)
  writeLedger(world, ['mine'])
  useHome(t, world.home)

  const registry = asyncRegistry()
  const { ctx, registered } = makeBootContext({ services: { agentPresets: registry } })
  const handle = apply(ctx)
  assert.equal(await waitFor(() => handle.describe().restorePending === false), true)
  assert.deepEqual(handle.describe().restore.restored, [])
  assert.equal(handle.describe().restore.failed.length, 1, 'the remembered id has no directory yet')

  // The directory appears (a preset was imported, a disk finished mounting…):
  // the next /state read is the healing checkpoint.
  writePreset(world, 'mine', { metadata: SAMPLE_METADATA, composition: compositionText(SAMPLE_ROWS) })
  const handlers = {}
  for (const route of registered) handlers[route.path] = route.handler

  // /state carries the report under restore.restored, exactly like /bootstrap.
  const first = await callHandler(handlers, API_PREFIX + '/state', 'GET')
  assert.equal(first.status, 200)
  assert.deepEqual(first.json.restore.restored.restored, [], 'this answer still carries the failed report…')
  assert.equal(first.json.restore.restoredPending, true, '…and the read itself started the retry')
  assert.equal(await waitFor(() => handle.describe().restorePending === false), true)

  const second = await callHandler(handlers, API_PREFIX + '/state', 'GET')
  assert.deepEqual(second.json.restore.restored.restored, ['mine'])
  assert.deepEqual(second.json.restore.restored.failed, [])
  assert.equal(second.json.runtime.declared.includes('mine'), true)

  const third = await callHandler(handlers, API_PREFIX + '/state', 'GET')
  assert.deepEqual(third.json.restore.restored.restored, ['mine'], 'a settled pass is not repeated by every poll')
  assert.equal(registry.declared.length, 1, 'and no id is ever declared twice')
})
