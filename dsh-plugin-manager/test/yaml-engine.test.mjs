// js-yaml compatibility of the patch engine: 4.x (`Type` + `JSON_SCHEMA.extend`) and
// 5.x (`defineScalarTag` + `Schema.withTags`) must both build a working `!!js` schema.
//
// WHY THIS FILE EXISTS
// 0.3.13 built its schema with js-yaml 4's `new jsyaml.Type(...)` + `JSON_SCHEMA.extend(...)`.
// The live desktop profile resolves js-yaml 5.4.3 (hoisted there by dsh-mcp-manager), where
// `Type` no longer exists, so that constructor call threw "jsyaml.Type is not a constructor"
// inside workspaceSnapshot() at the TOP of applyHost(). The throw escaped before mountHttp(),
// cordis rolled back every effect of the plugin — /__dsh-plugin-manager included — while the
// client half stayed loaded, and the panel could only show the JSON-parse error of a 404 with
// an empty body. All seven manager suites stayed green through it because every one of them
// injects a FAKE engine: nothing ever built a real schema. This file closes that gap —
// both API shapes, the machine's real js-yaml when one is reachable, and the real apply()
// against throwaway profiles whose js-yaml is v5-shaped or outright unrecognisable.
//
// Run: node dsh-plugin-manager/test/yaml-engine.test.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { createRequire } from 'node:module'
import { fileURLToPath, pathToFileURL } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const repoRoot = path.join(here, '..', '..')
const core = await import(pathToFileURL(path.join(here, '..', 'src', 'host-core.js')).href)
const { JS_EXPR_TAG, buildPatchSchema, probeYamlEngine, makeYamlEngine } = core

let passed = 0
const failures = []
function test(name, fn) {
  return Promise.resolve()
    .then(fn)
    .then(() => { passed += 1; console.log('ok -', name) })
    .catch((error) => { failures.push([name, error]); console.log('FAIL -', name, '::', error && error.message) })
}

// --- the two API shapes, as stubs -------------------------------------------

/** js-yaml 5.x: `defineScalarTag` + `Schema.withTags`, and NO `Type` at all. */
function jsYamlV5() {
  const seen = { tags: [], loads: [], dumps: [] }
  class StubSchema {
    constructor(tags) { this.tags = tags }
    withTags(...tags) { return new StubSchema([...this.tags, ...tags]) }
  }
  return {
    seen,
    api: {
      JSON_SCHEMA: new StubSchema([]),
      defineScalarTag: (tagName, options) => { seen.tags.push({ tagName, options }); return { tagName, nodeKind: 'scalar' } },
      load: (text, options) => { seen.loads.push({ text, options }); return [{ id: 'from-load' }] },
      dump: (doc, options) => { seen.dumps.push({ doc, options }); return '- id: from-dump\n' },
    },
  }
}

/** js-yaml 4.x: `new Type(...)` + `JSON_SCHEMA.extend(...)`. */
function jsYamlV4() {
  const seen = { types: [], loads: [], dumps: [] }
  class StubType { constructor(tagName, options) { this.tagName = tagName; this.options = options; seen.types.push(this) } }
  return {
    seen,
    api: {
      Type: StubType,
      JSON_SCHEMA: { tags: [], extend(type) { return { base: 'JSON_SCHEMA', tags: [...this.tags, type] } } },
      load: (text, options) => { seen.loads.push({ text, options }); return [{ id: 'from-load' }] },
      dump: (doc, options) => { seen.dumps.push({ doc, options }); return '- id: from-dump\n' },
    },
  }
}

await test('a 5.x copy builds the !!js schema through defineScalarTag (regression: 0.3.13 threw here)', () => {
  const v5 = jsYamlV5()
  assert.equal(typeof v5.api.Type, 'undefined', 'the stub really is the shape that broke 0.3.13')
  assert.throws(() => new v5.api.Type(JS_EXPR_TAG, {}), TypeError, 'the old code path dies on this shape')
  assert.deepEqual(probeYamlEngine(v5.api), { ok: true, flavor: 'define-tag', error: null })
  assert.doesNotThrow(() => makeYamlEngine(v5.api), 'building the engine must not throw any more')

  const engine = makeYamlEngine(v5.api)
  assert.equal(engine.flavor, 'define-tag')
  assert.equal(v5.seen.tags.length >= 1, true, 'the custom tag is declared')
  assert.equal(v5.seen.tags.every((t) => t.tagName === JS_EXPR_TAG), true, 'and it is the only tag declared')
  const tag = v5.seen.tags.at(-1)
  assert.equal(tag.tagName, JS_EXPR_TAG)
  assert.equal(tag.options.implicit, false, 'the tag must never claim untagged scalars')
  assert.deepEqual(tag.options.resolve('process.env.DSH_FLAG'), { __jsExpr: 'process.env.DSH_FLAG' }, 'resolve is the construct role in 5.x')
  assert.equal(tag.options.identify({ __jsExpr: 'x' }), true, 'identify is the predicate role in 5.x')
  assert.equal(tag.options.identify('x'), false)
  assert.equal(tag.options.represent({ __jsExpr: 'x' }), 'x', 'and represent keeps the round trip')
})

await test('a 5.x copy keeps the load/dump contract (tag schema, lineWidth 120)', () => {
  const v5 = jsYamlV5()
  const engine = makeYamlEngine(v5.api)
  assert.deepEqual(engine.loadText('- id: a\n'), [{ id: 'from-load' }])
  assert.match(engine.dumpText([{ id: 'a' }]), /from-dump/)
  assert.equal(engine.dumpText([]), '[]\n', 'an empty patch is written as an empty list')
  assert.equal(v5.seen.loads.at(-1).options.schema.tags[0].tagName, JS_EXPR_TAG, 'load() receives the schema carrying the !!js tag')
  assert.equal(v5.seen.dumps.at(-1).options.schema.tags[0].tagName, JS_EXPR_TAG, 'dump() receives it too')
  assert.equal(v5.seen.dumps.at(-1).options.lineWidth, 120, 'the patch-file line width is preserved')
  // loadDoc() is the non-list reader (pnpm-workspace.yaml): a non-mapping document
  // degrades to {} instead of throwing, a mapping passes through untouched.
  assert.deepEqual(engine.loadDoc('a: 1\n'), {}, 'the stub returns rows here, so a non-mapping input degrades')
  v5.api.load = () => ({ a: 1 })
  assert.deepEqual(makeYamlEngine(v5.api).loadDoc('a: 1\n'), { a: 1 }, 'a mapping node loads as a plain object')
})

await test('a 5.x list that is not a list is refused (loadText contract)', () => {
  const v5 = jsYamlV5()
  v5.api.load = () => ({ not: 'a list' })
  const engine = makeYamlEngine(v5.api)
  assert.throws(() => engine.loadText('x'), /top-level array/)
  v5.api.load = () => null
  assert.deepEqual(makeYamlEngine(v5.api).loadText('x'), [], 'an empty document is an empty patch')
})

await test('a 4.x copy still builds the schema through Type + JSON_SCHEMA.extend', () => {
  const v4 = jsYamlV4()
  assert.deepEqual(probeYamlEngine(v4.api), { ok: true, flavor: 'type-extend', error: null })
  const engine = makeYamlEngine(v4.api)
  assert.equal(engine.flavor, 'type-extend')
  assert.equal(v4.seen.types.length >= 1, true)
  assert.equal(v4.seen.types.at(-1).tagName, JS_EXPR_TAG)
  const options = v4.seen.types.at(-1).options
  assert.equal(options.kind, 'scalar')
  assert.deepEqual(options.construct('process.env.X'), { __jsExpr: 'process.env.X' })
  assert.equal(options.predicate({ __jsExpr: 'x' }), true)
  assert.equal(options.represent({ __jsExpr: 'x' }), 'x')
  engine.loadText('- id: a\n')
  engine.dumpText([{ id: 'a' }])
  assert.equal(v4.seen.loads.at(-1).options.schema.tags[0].tagName, JS_EXPR_TAG)
  assert.equal(v4.seen.dumps.at(-1).options.lineWidth, 120)
})

await test('an unrecognisable js-yaml becomes a readable error, never a throw from probe', () => {
  const shapes = [
    { load: () => [], dump: () => '', JSON_SCHEMA: {} },
    { load: () => [], dump: () => '', JSON_SCHEMA: { extend: () => ({}) } },
    { load: () => [], dump: () => '', Type: () => {}, defineScalarTag: () => ({}) },
    {},
  ]
  for (const api of shapes) {
    const probe = probeYamlEngine(api)
    assert.equal(probe.ok, false, 'the shape is not usable')
    assert.match(probe.error, /unsupported js-yaml API: need 4\.x \(Type \+ JSON_SCHEMA\.extend\) or 5\.x \(defineScalarTag \+ JSON_SCHEMA\.withTags\)/)
    assert.throws(() => makeYamlEngine(api), /unsupported js-yaml API/, 'makeYamlEngine keeps its throwing contract')
  }
  assert.equal(probeYamlEngine(null).ok, false, 'a missing module is not an engine either')
  assert.equal(buildPatchSchema(undefined).schema, null)
})

// --- the machine's real js-yaml, when there is one ---------------------------

const realHome = process.env.DSH_HOME && process.env.DSH_HOME.trim() !== ''
  ? process.env.DSH_HOME.trim()
  : path.join(os.homedir(), '.dsh')

function loadRealYaml() {
  for (const name of ['desktop', 'web']) {
    const pkgFile = path.join(realHome, 'profiles', name, 'package.json')
    if (!fs.existsSync(pkgFile)) continue
    try {
      const req = createRequire(pkgFile)
      const api = req('js-yaml')
      if (!api || typeof api.load !== 'function' || typeof api.dump !== 'function') continue
      let dir = path.dirname(req.resolve('js-yaml'))
      let version = null
      for (let i = 0; i < 8 && dir && dir !== path.dirname(dir); i += 1) {
        const meta = path.join(dir, 'package.json')
        if (fs.existsSync(meta)) {
          const json = JSON.parse(fs.readFileSync(meta, 'utf8'))
          if (json && json.name === 'js-yaml') { version = json.version; break }
        }
        dir = path.dirname(dir)
      }
      return { api, profileName: name, version }
    } catch { /* try the next profile */ }
  }
  return null
}

const real = loadRealYaml()
if (!real) {
  console.log(`SKIP - no js-yaml reachable under ${realHome}/profiles (the stub checks above still ran)`)
} else {
  await test(`the real js-yaml ${real.version || '?'} (profile: ${real.profileName}) is recognised and round-trips !!js`, () => {
    const probe = probeYamlEngine(real.api)
    assert.equal(probe.ok, true, probe.error || '')
    assert.equal(probe.flavor, typeof real.api.Type === 'function' ? 'type-extend' : 'define-tag',
      'the flavour follows the API actually present')
    const engine = makeYamlEngine(real.api)
    const doc = [{ id: 'dsh-x', insert: [{ id: 'row-y', config: { flag: { __jsExpr: 'process.env.DSH_FLAG' }, plain: 'v', num: 3 } }] }]
    const text = engine.dumpText(doc)
    assert.match(text, /!!js process\.env\.DSH_FLAG/, 'the !!js scalar is written as a tag, not as a mapping')
    assert.deepEqual(engine.loadText(text), doc, 'and it comes back as the same rows object')
  })

  const realPatch = path.join(realHome, 'profiles', real.profileName, 'cordis.patch.yml')
  if (!fs.existsSync(realPatch)) {
    console.log('SKIP - no cordis.patch.yml in that profile')
  } else {
    await test('the profile patch file survives a load/dump round trip', () => {
      const engine = makeYamlEngine(real.api)
      const text = fs.readFileSync(realPatch, 'utf8')
      const rows = engine.loadText(text)
      assert.ok(rows.length > 0, 'the live patch parses into rows')
      assert.deepEqual(engine.loadText(engine.dumpText(rows)), rows, 'a rewrite is lossless')
    })
  }
}

// --- the real apply(): an unusable js-yaml must not take the routes down ------

const tmpRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-plugin-manager-yaml-'))
process.env.DSH_HOME = tmpRoot
const { apply, __setPnpmRunner, __setAutoRelink, HOST_DIAG } = await import(pathToFileURL(path.join(here, '..', 'src', 'index.js')).href)

let installs = 0
__setPnpmRunner(async () => { installs += 1; return { ok: true, code: 0, error: null, stdout: '', stderr: '' } })
__setAutoRelink(false)

/** A throwaway profile whose node_modules/js-yaml is the given CommonJS stub. */
function makeProfile(name, version, source) {
  const profileDir = path.join(tmpRoot, 'profiles', name)
  const yamlDir = path.join(profileDir, 'node_modules', 'js-yaml')
  fs.mkdirSync(yamlDir, { recursive: true })
  fs.writeFileSync(path.join(profileDir, 'package.json'), JSON.stringify({ name, private: true }, null, 2) + '\n')
  fs.writeFileSync(path.join(profileDir, 'cordis.patch.yml'), '- insert:\n    - id: ui-chat\n      name: @deepseek-ai/dsh-client-ui-chat\n')
  fs.writeFileSync(path.join(yamlDir, 'package.json'), JSON.stringify({ name: 'js-yaml', version, main: 'index.js' }, null, 2) + '\n')
  fs.writeFileSync(path.join(yamlDir, 'index.js'), source)
  return profileDir
}

function makeCtx(profileDir) {
  const registered = []
  return {
    registered,
    baseUrl: pathToFileURL(profileDir + path.sep).href,
    get: (key) => (key === 'webServer' ? { register: (route) => { registered.push(route); return () => {} } } : undefined),
    inject: () => {},
    on: () => () => {},
    effect: (fn) => fn(),
  }
}

const V5_STUB = [
  'module.exports = {',
  '  JSON_SCHEMA: { withTags: (...tags) => ({ tags }) },',
  '  defineScalarTag: (tagName, options) => ({ tagName, nodeKind: \'scalar\', options }),',
  '  load: () => ({ packages: [\'.\'] }),',
  '  dump: () => \'packages:\\n  - .\\n\',',
  '}',
  '',
].join('\n')

await test('apply() mounts the panel transport on a 5.x profile (the live failure shape)', async () => {
  HOST_DIAG.applyError = null
  const profileDir = makeProfile('v5-profile', '5.4.3', V5_STUB)
  const ctx = makeCtx(profileDir)
  apply(ctx, { repoRoot })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(HOST_DIAG.applyError, null, 'nothing escaped apply()')
  assert.equal(HOST_DIAG.httpMounted, true, 'the routes are live')
  assert.equal(ctx.registered.length, 1, 'exactly one prefix route was registered')
  assert.equal(HOST_DIAG.yamlResolved, true)
  assert.equal(HOST_DIAG.yamlFlavor, 'define-tag', 'the diagnostics name the API that was used')
  assert.equal(HOST_DIAG.yamlVersion, '5.4.3')
  assert.equal(HOST_DIAG.yamlError, null)
  assert.equal(HOST_DIAG.workspace.ok, true, 'the workspace snapshot still ran (after the mount)')
  assert.match(String(HOST_DIAG.diagFile || ''), /host-diag\.json$/, 'the diagnosis file is written beside the profile')
  assert.match(fs.readFileSync(HOST_DIAG.diagFile, 'utf8'), /"yamlFlavor": "define-tag"/)
})

await test('apply() survives an unrecognisable js-yaml: readable error, routes still live, no auto-install', async () => {
  HOST_DIAG.applyError = null
  HOST_DIAG.yamlError = null
  const profileDir = makeProfile('odd-profile', '6.0.0', 'module.exports = { load: () => ({}), dump: () => \'\', JSON_SCHEMA: {} }\n')
  const ctx = makeCtx(profileDir)
  const before = installs
  apply(ctx, { repoRoot })
  await new Promise((resolve) => setImmediate(resolve))
  assert.equal(HOST_DIAG.applyError, null, 'apply() itself never threw')
  assert.equal(HOST_DIAG.httpMounted, true, 'the panel transport outlives a broken engine')
  assert.equal(ctx.registered.length, 1)
  assert.equal(HOST_DIAG.yamlResolved, false)
  assert.equal(HOST_DIAG.yamlFlavor, null)
  assert.match(String(HOST_DIAG.yamlError || ''), /js-yaml@6\.0\.0: unsupported js-yaml API/, 'the reason is readable and names the version')
  // js-yaml@4 must never be installed over a profile copy: dsh-mcp-manager depends on the
  // hoisted version, so "fixing" it here would downgrade somebody else's dependency.
  assert.equal(installs, before, 'no dependency was installed to work around it')
  assert.equal(HOST_DIAG.workspace.ok === true || Boolean(HOST_DIAG.workspace.error), true, 'the workspace step is recorded either way')
})

fs.rmSync(tmpRoot, { recursive: true, force: true })

console.log()
if (failures.length > 0) {
  console.log(failures.length + ' failing:')
  for (const [name, error] of failures) console.log('  -', name, ':', (error && error.stack ? error.stack.split('\n').slice(0, 3).join(' | ') : error))
  process.exit(1)
}
console.log(passed + ' yaml-engine checks passed')