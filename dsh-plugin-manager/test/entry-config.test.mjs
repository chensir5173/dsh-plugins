// Entry-config (0.2.0) contract for the manager HOST half (src/index.js).
//
// WHY THIS FILE EXISTS
// 0.2.0 retired `settings.installSection`: the settings service now projects each
// plugin entry's own exported `Config` under the ENTRY ID and refuses every other
// namespace with `No configurable plugin entry "<ns>"`. A `link:`ed host half
// cannot import @deepseek-ai/schemastery (measured: ERR_MODULE_NOT_FOUND), so the
// schema is hand-rolled — this file locks down the three members the core actually
// consumes, the permissive validation that must keep the install options alive,
// and the apply-time read that makes the switch work on 0.2.0 while 0.1.x keeps
// using installSection.
//
// Run: node dsh-plugin-manager/test/entry-config.test.mjs
import assert from 'node:assert/strict'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.join(here, '..', '..')
const hostIndex = await import(pathToFileURL(path.join(here, '..', 'src', 'index.js')).href)

/** Minimal cordis-ish ctx: only what apply() reaches for, everything else absent. */
function makeCtx(services = {}) {
  const registered = []
  return {
    baseUrl: pathToFileURL(path.join(repoRoot, 'package.json')).href,
    get: (key) => (key === 'webServer'
      ? { register: (route) => { registered.push(route); return () => {} } }
      : services[key]),
    inject: () => {},
    on: () => () => {},
    effect: (fn) => fn(),
    _registered: registered,
  }
}

let passed = 0
const failures = []
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed += 1; console.log('ok -', name) })
    .catch((error) => { failures.push([name, error]); console.log('FAIL -', name, '::', error && error.message) })
}

await test('Config carries the three members the 0.2.0 core consumes', () => {
  const Config = hostIndex.Config
  assert.equal(typeof Config, 'function', 'cordis resolveConfig calls it')
  assert.equal(typeof Config['~standard'].validate, 'function')
  assert.equal(Config['~standard'].vendor !== 'schemastery', true,
    'the vendor is deliberately NOT schemastery: our plain values carry no Volatile refs, so a config write must take the ordinary path (entry restart) for apply() to see it')
  assert.equal(Config.meta.volatile, true, 'volatileForm() drops every non-volatile field')
  assert.equal(typeof Config.toJSON, 'function', "the settings service requires 'toJSON' in schema")
  const refs = Config.toJSON()
  assert.equal(typeof refs.uid, 'number')
  const declared = Object.values(refs.refs).filter((node) => node && node.dict).flatMap((node) => Object.keys(node.dict))
  assert.ok(declared.includes('autoRelink'), 'the captured refs table still declares the switch')
})

await test('validation is permissive: install options survive, the switch defaults to true', () => {
  const validate = hostIndex.Config['~standard'].validate
  assert.deepEqual(validate({ repoRoot: 'D:/repo', profileDir: 'D:/home/profiles/web' }).value,
    { repoRoot: 'D:/repo', profileDir: 'D:/home/profiles/web', autoRelink: true },
    'an undeclared install option is passed through, never stripped')
  assert.deepEqual(validate({ autoRelink: false }).value, { autoRelink: false })
  assert.deepEqual(validate({ autoRelink: 'yes' }).value, { autoRelink: true }, 'a non-boolean falls back to the default')
})

await test('apply(ctx, config) adopts the entry config on a 0.2.0 settings service', () => {
  // A 0.2.0 settings service: describe/update/replace, and NO installSection.
  // The plugin probes with `typeof settings.installSection !== 'function'` and must
  // then read the switch from its own entry config instead of registering anything.
  const settings = {
    describe: () => [],
    update: async () => {},
    replace: async () => {},
  }
  hostIndex.apply(makeCtx({ settings }), { repoRoot, autoRelink: false })
  assert.equal(hostIndex.HOST_DIAG.autoRelinkEnabled, false, 'the switch follows the entry config')
  assert.equal(hostIndex.HOST_DIAG.yamlResolved, false, 'the rest of apply() still runs')
})

await test('apply(ctx, config) never clobbers the switch when the field is absent', () => {
  hostIndex.__setAutoRelink(false)
  hostIndex.apply(makeCtx({}), { repoRoot })
  assert.equal(hostIndex.HOST_DIAG.autoRelinkEnabled, false, 'absent/non-boolean leaves the current value alone')
  hostIndex.apply(makeCtx({}), { repoRoot, autoRelink: true })
  assert.equal(hostIndex.HOST_DIAG.autoRelinkEnabled, true, 'a boolean still wins')
})

await test('0.1.x keeps the installSection route when the service offers it', async () => {
  const installed = []
  const settings = {
    installSection: (ctx, ns, schema, entry, hooks) => {
      installed.push({ ns, entry })
      hooks.setSource(() => ({ autoRelink: false }))
      hooks.onChange()
    },
  }
  hostIndex.apply(makeCtx({ settings }), { repoRoot })
  for (let i = 0; i < 20 && installed.length === 0; i += 1) await new Promise((resolve) => setImmediate(resolve))
  assert.equal(installed.length, 1, 'the namespace is registered through the legacy API')
  assert.equal(installed[0].ns, hostIndex.SETTINGS_NS)
  assert.deepEqual(installed[0].entry, { autoRelink: true }, 'with the documented default')
  assert.equal(hostIndex.HOST_DIAG.autoRelinkEnabled, false, 'the section source still feeds the switch')
})

await test('a null webServer service is not mistaken for a live one (regression: silent 404 panel)', () => {
  let injected = 0
  const ctx = {
    baseUrl: pathToFileURL(path.join(repoRoot, 'package.json')).href,
    get: (key) => (key === 'webServer' ? null : undefined),
    inject: () => { injected += 1 },
    on: () => () => {},
    effect: (fn) => fn(),
  }
  hostIndex.apply(ctx, { repoRoot })
  assert.equal(hostIndex.HOST_DIAG.httpMounted, false, 'nothing is mounted when the service is absent')
  assert.match(String(hostIndex.HOST_DIAG.httpSkipped || ''), /webServer/, 'the reason is recorded instead of vanishing')
  assert.equal(injected >= 1, true, 'the inject() fallback is still attempted')
})

await test('a refused route registration is recorded, not thrown (a live patch reload leaves duplicates)', () => {
  hostIndex.HOST_DIAG.applyError = null
  hostIndex.HOST_DIAG.httpSkipped = null
  const ctx = {
    baseUrl: pathToFileURL(path.join(repoRoot, 'package.json')).href,
    get: (key) => (key === 'webServer'
      ? { register: () => { throw new Error('webserver: duplicate route "/__dsh-plugin-manager"') } }
      : undefined),
    inject: () => {},
    on: () => () => {},
    effect: (fn) => fn(),
  }
  hostIndex.apply(ctx, { repoRoot })
  assert.equal(hostIndex.HOST_DIAG.applyError, null, 'the host survived the refusal')
  assert.equal(hostIndex.HOST_DIAG.httpMounted, false, 'and knows the routes are not live')
  assert.match(String(hostIndex.HOST_DIAG.httpSkipped || ''), /duplicate route/, 'the reason is recorded verbatim')
})

await test('a throwing service getter cannot roll back the panel transport', () => {
  hostIndex.HOST_DIAG.applyError = null
  hostIndex.HOST_DIAG.settingsError = null
  const registered = []
  const ctx = {
    baseUrl: pathToFileURL(path.join(repoRoot, 'package.json')).href,
    get: (key) => {
      if (key === 'webServer') return { register: (route) => { registered.push(route); return () => {} } }
      if (key === 'settings') throw new Error('boom settings')
      return undefined
    },
    inject: () => {},
    on: () => () => {},
    effect: (fn) => fn(),
  }
  hostIndex.apply(ctx, { repoRoot })
  assert.equal(hostIndex.HOST_DIAG.applyError, null, 'the failure stayed inside its guard')
  assert.equal(hostIndex.HOST_DIAG.settingsError, 'boom settings', 'and is recorded for diagnosis')
  assert.equal(registered.length, 1, 'the panel transport is mounted anyway')
})

await test('a settings service that refuses the namespace is recorded, not thrown', async () => {
  hostIndex.HOST_DIAG.applyError = null
  hostIndex.HOST_DIAG.settingsError = null
  const settings = { installSection: () => { throw new Error('No configurable plugin entry "dshPluginManager"') } }
  hostIndex.apply(makeCtx({ settings }), { repoRoot })
  for (let i = 0; i < 20 && !hostIndex.HOST_DIAG.settingsError; i += 1) await new Promise((resolve) => setImmediate(resolve))
  assert.match(String(hostIndex.HOST_DIAG.settingsError || ''), /No configurable plugin entry/, 'the refusal is recorded')
  assert.equal(hostIndex.HOST_DIAG.applyError, null, 'apply() itself never threw')
})

console.log()
if (failures.length > 0) {
  console.log(failures.length + ' failing:')
  for (const [name, error] of failures) console.log('  -', name, ':', (error && error.stack ? error.stack.split('\n').slice(0, 3).join(' | ') : error))
  process.exit(1)
}
console.log(passed + ' entry-config checks passed')
