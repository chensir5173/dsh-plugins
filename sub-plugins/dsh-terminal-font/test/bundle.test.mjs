// Behavioural harness for dsh-terminal-font — CLIENT half only.
//
// WHY THIS EXISTS
// src/client.js is a browser classic-script bundle (no build step), so it is
// materialized the way @deepseek-ai/dsh-client-modules does it:
// window.__ModuleLoader__.load({id, factory}) then factory(require), with real
// module ids and a stub react. Everything below then drives the module-scoped
// helpers through the test-only hooks (window.__terminalFontTest, gated by
// window.__DSH_TEST__) on a hand-made DOM.
//
// The interesting part is the DIAGNOSIS, because the fix fails silently: a
// missing Nerd Font, an un-injected stylesheet and a drifted xterm cell all
// look like "the terminal still shows boxes". The probe is therefore the only
// feedback the user gets, and these assertions pin its three signals:
// the marker stylesheet, the FontFace status after fonts.load(), and the
// measured cell width against the Consolas 13px target.
//
// It is a LOGIC harness, not a browser render: no React rendering, no layout,
// no real FontFaceSet. Visual behaviour still needs the manual checks in
// ACCEPTANCE.md.
//
// Run: node sub-plugins/dsh-terminal-font/test/bundle.test.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const clientBundlePath = path.join(here, '..', 'src', 'client.js')
const PKG_ID = 'dsh-terminal-font'

const tests = []
const test = (label, fn) => tests.push([label, fn])

// =============================================================================
// Fake DOM
// =============================================================================

function makeStyleNode(text) {
  return { tagName: 'STYLE', textContent: text }
}

/**
 * A minimal document. Everything the client half touches is injectable so each
 * scenario can express exactly one defect (no stylesheet / no font / no
 * terminal / wrong cell width).
 */
function makeDoc(options = {}) {
  const {
    styles = [],
    faces = [],
    terminal = null,
    cellWidth = null,
    hasBody = true,
    loadImpl = null,
  } = options
  const fonts = {
    loadCalls: [],
    forEach(cb) { faces.forEach((face, index) => cb(face, index, fonts)) },
    async load(spec, text) {
      fonts.loadCalls.push([spec, text])
      if (typeof loadImpl === 'function') loadImpl(spec, faces, fonts)
    },
  }
  const created = []
  const removed = []
  const doc = {
    styles,
    faces,
    fonts,
    created,
    removed,
    defaultView: {
      getComputedStyle() {
        return terminal ? { fontFamily: terminal.fontFamily, fontSize: terminal.fontSizePx + 'px' } : {}
      },
    },
    createElement(tag) {
      const el = { tagName: String(tag).toUpperCase(), style: {}, textContent: '' }
      if (cellWidth !== null) {
        el.getBoundingClientRect = () => ({ width: cellWidth * 32 })
      }
      created.push(el)
      return el
    },
    querySelectorAll(selector) {
      if (selector === 'style') return styles.slice()
      return []
    },
    querySelector(selector) {
      if (!terminal) return null
      if (selector === terminal.selector) return { tagName: 'DIV' }
      return null
    },
  }
  if (hasBody) {
    doc.body = {
      appendChild(node) { created.push(node); return node },
      removeChild(node) { removed.push(node); return node },
    }
  }
  return doc
}

function makeFace(family, status) {
  return { family, status }
}

// =============================================================================
// Bundle plumbing
// =============================================================================

const factories = new Map()
const windowEvents = []

function makeReactStub() {
  return {
    createElement: (type, props, ...children) => ({ __element: true, type, props: { ...(props || {}), children } }),
    Fragment: Symbol('Fragment'),
    useState(initial) { return [typeof initial === 'function' ? initial() : initial, () => {}] },
    useEffect() {},
    useRef(initial) { return { current: initial } },
    useCallback: (fn) => fn,
  }
}
const ReactStub = makeReactStub()

function requireStub(specifier) {
  if (specifier === 'react') return ReactStub
  throw new Error('unexpected require("' + specifier + '")')
}

// The bundle captures the navigator it was evaluated with, so the language
// sniffing case must mutate THIS object (rebinding globalThis.navigator would
// leave the captured reference untouched).
const navigatorStub = { languages: ['zh-CN'], language: 'zh-CN' }
Object.defineProperty(globalThis, 'navigator', { configurable: true, value: navigatorStub })
globalThis.window = {
  __ModuleLoader__: { load: ({ id, factory }) => factories.set(id, factory) },
  __DSH_TEST__: true,
  dispatchEvent: (event) => { windowEvents.push(event) },
  addEventListener() {},
  removeEventListener() {},
}
globalThis.document = makeDoc()

const clientSource = fs.readFileSync(clientBundlePath, 'utf8')
// eslint-disable-next-line no-new-func -- mirroring the browser classic-script evaluation
new Function('window', 'navigator', 'document', clientSource)(
  globalThis.window,
  navigatorStub,
  globalThis.document,
)

/** Fake locale service shaped like the core one. */
function makeLocale({ translate = null } = {}) {
  const registered = []
  const listeners = []
  return {
    registered,
    listeners,
    register(ns, dict) { registered.push({ ns, dict }); return () => {} },
    translate(ns, key) {
      if (typeof translate === 'function') return translate(ns, key)
      const dict = registered.length ? registered[registered.length - 1].dict : null
      const table = dict && (dict.zh || dict.en)
      return table && typeof table[key] === 'string' ? table[key] : key
    },
    subscribe(fn) { listeners.push(fn); return () => {} },
  }
}

/** Fake client ctx: services through get(), slots captured, inject deferred. */
function makeClientCtx({ locale, settings, injectImmediately = true } = {}) {
  const registered = []
  const injected = []
  const deferred = []
  const effects = []
  const services = { locale, 'remote.settings': settings }
  const scope = {
    get: (n) => services[n],
    effect: (fn) => { effects.push(fn); return fn() },
    on: () => {},
  }
  const ctx = {
    registered,
    injected,
    deferred,
    effects,
    get: (n) => services[n],
    effect: (fn) => { effects.push(fn); return fn() },
    on: () => {},
    inject: (names, fn) => {
      injected.push(names)
      if (injectImmediately) fn(scope)
      else deferred.push(fn)
    },
    slots: {
      inject: (name, build) => { build() },
      register: (options, component) => { registered.push({ options, component }); return { dispose() {} } },
    },
  }
  return ctx
}

function bootClient(options = {}) {
  const factory = factories.get(PKG_ID)
  assert.ok(factory, 'client bundle did not register id "' + PKG_ID + '"')
  const previous = globalThis.window.__terminalFontTest
  if (previous && typeof previous.reset === 'function') previous.reset()
  const ctx = makeClientCtx(options)
  const exports = factory(requireStub)
  exports.apply(ctx)
  return { ctx, exports, hooks: globalThis.window.__terminalFontTest }
}

/**
 * Boot the bundle and adopt THAT boot's hooks. Every factory(require) call
 * rebuilds the module scope (a fresh __terminalFontTest object), so a hook
 * captured once would keep reading the first boot's dead module state.
 */
let hooks = null
function bootHooks(options) {
  const booted = bootClient(options)
  hooks = booted.hooks
  return booted
}
bootHooks({ locale: undefined })

// =============================================================================
// Bundle + slot registration
// =============================================================================

test('client bundle registers the module id and the cordis contract', () => {
  const { exports } = bootHooks({ locale: undefined })
  assert.equal(typeof exports.apply, 'function')
  assert.deepEqual(exports.inject, ['slots'])
})

test('apply contributes the local-plugins settings tab', () => {
  const locale = makeLocale()
  const { ctx } = bootHooks({ locale })
  const tab = ctx.registered.find((r) => r.options.name === 'settings.localPlugins.tab')
  assert.ok(tab, 'settings tab was not registered')
  assert.equal(tab.options.id, 'terminal-font')
  assert.equal(tab.options.order, 46)
  assert.equal(typeof tab.component, 'function')
  assert.equal(tab.options.locale, 'terminal-font', 'the tab declares its locale namespace')
  assert.equal(tab.options.label(), '终端字体')
  assert.equal(locale.registered.length, 1)
  assert.equal(locale.registered[0].ns, 'terminal-font')
  assert.equal(typeof locale.registered[0].dict.zh['tab.title'], 'string')
  assert.equal(typeof locale.registered[0].dict.en['tab.title'], 'string')
  assert.ok(ctx.effects.length >= 1, 'the locale registration runs inside ctx.effect')
})

test('apply still registers the tab when the locale service arrives late', () => {
  const { ctx } = bootHooks({ locale: undefined, injectImmediately: false })
  assert.deepEqual(ctx.injected, [['locale']], 'locale is resolved through a deferred inject')
  const tab = ctx.registered.find((r) => r.options.name === 'settings.localPlugins.tab')
  assert.ok(tab, 'the tab must not depend on locale timing')
  assert.equal(tab.options.locale, undefined, 'no locale service = no namespace claim')
  assert.equal(tab.options.label(), '终端字体', 'the bundled dictionary still works')
  // the service shows up afterwards: the deferred callback adopts it
  const late = makeLocale({ translate: (ns, key) => (key === 'tab.title' ? 'LATE' : key) })
  assert.equal(ctx.deferred.length, 1)
  ctx.deferred[0]({ get: (n) => (n === 'locale' ? late : undefined), effect: (f) => f(), on: () => {} })
  assert.equal(hooks.__t('tab.title'), 'LATE')
  assert.equal(late.registered.length, 1, 'the late service gets the dictionaries')
})

// =============================================================================
// i18n
// =============================================================================

test('__t prefers the locale service and falls back to the bundled dictionary', () => {
  let calls = 0
  bootHooks({ locale: makeLocale({ translate: (ns, key) => { calls += 1; return key === 'tab.title' ? 'FROM-SERVICE' : key } }) })
  assert.equal(hooks.__t('tab.title'), 'FROM-SERVICE')
  assert.ok(calls > 0, 'the locale service is asked first')
  // a service that does not know the key must not shadow the bundled copy
  bootHooks({ locale: makeLocale({ translate: (ns, key) => key }) })
  assert.equal(hooks.__t('tab.title'), '终端字体')
  bootHooks({ locale: undefined })
  assert.equal(hooks.__t('tab.title'), '终端字体')
  assert.equal(hooks.__t('missing.key'), 'missing.key')
})

test('__tf substitutes the {name} placeholders', () => {
  bootHooks({ locale: undefined })
  assert.equal(hooks.__tf('diag.cellValue', { m: '7.147', t: '7.147' }), '实测 7.147px / 目标 7.147px')
  assert.equal(hooks.__tf('diag.cellValue', null), '实测 {m}px / 目标 {t}px')
  // Font size is READ-ONLY information: the core hard-codes 13px, so the tab
  // reports it instead of offering a control that would desync xterm metrics.
  assert.equal(hooks.__t('diag.fontSize'), '终端字号')
  assert.equal(hooks.__tf('diag.fontSizeValue', { v: '13' }), '13px（由核心固定）')
})

test('language sniffing: an English browser gets the English dictionary', () => {
  navigatorStub.languages = ['en-US']
  navigatorStub.language = 'en-US'
  bootHooks({ locale: undefined })
  assert.equal(hooks.__t('tab.title'), 'Terminal font')
  assert.equal(hooks.__t('diag.injected'), 'CSS injection')
  assert.equal(hooks.__t('diag.fontSize'), 'Font size')
  navigatorStub.languages = ['zh-CN']
  navigatorStub.language = 'zh-CN'
  bootHooks({ locale: undefined })
  assert.equal(hooks.__t('tab.title'), '终端字体')
})

// =============================================================================
// Diagnosis: stylesheet
// =============================================================================

test('styleInjected finds the marker stylesheet', () => {
  assert.equal(hooks.styleInjected(makeDoc({ styles: [makeStyleNode('body{}')] })), false)
  assert.equal(
    hooks.styleInjected(makeDoc({ styles: [makeStyleNode('body{}'), makeStyleNode('/* dsh-terminal-font */\n@font-face{}')] })),
    true,
  )
  assert.equal(hooks.styleInjected(null), false)
  assert.equal(hooks.styleInjected({}), false)
})

// =============================================================================
// Diagnosis: FontFace status
// =============================================================================

test('collectFontFaces reads the FontFaceSet', () => {
  const faces = [makeFace('DSH Terminal Mono', 'loaded')]
  assert.equal(hooks.collectFontFaces(makeDoc({ faces })).length, 1)
  assert.equal(hooks.collectFontFaces(makeDoc()).length, 0)
  assert.equal(hooks.collectFontFaces(null).length, 0)
})

test('pickFaceStatus maps FontFace status and reports missing families', () => {
  const loaded = [makeFace('DSH Terminal Mono', 'loaded'), makeFace('DSH Terminal CJK', 'error')]
  assert.equal(hooks.pickFaceStatus(loaded, 'DSH Terminal Mono'), 'loaded')
  assert.equal(hooks.pickFaceStatus(loaded, 'DSH Terminal CJK'), 'error')
  assert.equal(hooks.pickFaceStatus(loaded, 'Other Font'), 'missing')
  assert.equal(hooks.pickFaceStatus([makeFace('"DSH Terminal Mono"', 'loading')], 'dsh terminal mono'), 'loading')
  assert.equal(hooks.pickFaceStatus([makeFace('DSH Terminal Mono', '')], 'DSH Terminal Mono'), 'unloaded')
  assert.equal(hooks.pickFaceStatus([makeFace('DSH Terminal Mono', 'weird')], 'DSH Terminal Mono'), 'unloaded')
})

test('probeFonts forces local() resolution through fonts.load()', async () => {
  const faces = [makeFace('DSH Terminal Mono', ''), makeFace('DSH Terminal CJK', '')]
  const doc = makeDoc({
    faces,
    loadImpl: (spec) => {
      for (const face of faces) if (spec.includes(face.family)) face.status = 'loaded'
    },
  })
  const status = await hooks.probeFonts(doc)
  assert.deepEqual(status, { mono: 'loaded', cjk: 'loaded' })
  assert.equal(doc.fonts.loadCalls.length, 2)
  assert.deepEqual(doc.fonts.loadCalls[0], ['13px "DSH Terminal Mono"', 'W'])
  assert.deepEqual(doc.fonts.loadCalls[1], ['13px "DSH Terminal CJK"', 'W'])
})

test('probeFonts reports a missing font instead of throwing', async () => {
  const status = await hooks.probeFonts(makeDoc())
  assert.deepEqual(status, { mono: 'missing', cjk: 'missing' })
  const hostile = { fonts: { forEach() { throw new Error('boom') }, load() { throw new Error('boom') } } }
  assert.doesNotThrow(async () => { await hooks.probeFonts(hostile) })
})

// =============================================================================
// Diagnosis: cell width
// =============================================================================

test('readTerminalProbe reads the core terminal font metrics', () => {
  const doc = makeDoc({ terminal: { selector: '.xterm-rows', fontFamily: 'DSH Terminal Mono, Consolas, monospace', fontSizePx: 13 } })
  assert.deepEqual(hooks.readTerminalProbe(doc), {
    fontFamily: 'DSH Terminal Mono, Consolas, monospace',
    fontSizePx: 13,
  })
  assert.equal(hooks.readTerminalProbe(makeDoc()), null, 'no terminal open = nothing to measure')
  assert.equal(hooks.readTerminalProbe(null), null)
})

test('measureCellWidth measures through layout, not canvas', () => {
  const doc = makeDoc({ cellWidth: 7.1474609375 })
  const width = hooks.measureCellWidth(doc, 'DSH Terminal Mono', 13)
  assert.ok(Math.abs(width - 7.1474609375) < 1e-9)
  const span = doc.created.find((n) => n.tagName === 'SPAN')
  assert.equal(span.textContent.length, 32, 'a long sample averages out hinting noise')
  assert.ok(span.style.cssText.includes('font-family:DSH Terminal Mono'))
  assert.ok(span.style.cssText.includes('font-size:13px'))
  assert.equal(doc.removed.length, 1, 'the probe element is always removed')
  assert.equal(hooks.measureCellWidth(makeDoc({ cellWidth: null }), 'X', 13), null)
  assert.equal(hooks.measureCellWidth(makeDoc({ hasBody: false }), 'X', 13), null)
  assert.equal(hooks.measureCellWidth(null, 'X', 13), null)
})

// =============================================================================
// Diagnosis: the combined probe
// =============================================================================

test('runDiagnostics: healthy machine reports injected + loaded + on-grid cells', async () => {
  const faces = [makeFace('DSH Terminal Mono', ''), makeFace('DSH Terminal CJK', '')]
  const doc = makeDoc({
    styles: [makeStyleNode('/* dsh-terminal-font */')],
    faces,
    terminal: { selector: '.xterm-rows', fontFamily: 'DSH Terminal Mono', fontSizePx: 13 },
    cellWidth: 7.1474609375,
    loadImpl: (spec) => { for (const face of faces) if (spec.includes(face.family)) face.status = 'loaded' },
  })
  const diag = await hooks.runDiagnostics(doc)
  assert.equal(diag.injected, true)
  assert.deepEqual(diag.faces, { mono: 'loaded', cjk: 'loaded' })
  assert.equal(diag.terminal.fontSizePx, 13)
  assert.equal(diag.measured, 7.1474609375)
  assert.equal(diag.expected, 7.1474609375)
  assert.equal(diag.cellOk, true)
})

test('runDiagnostics: drifted cells and a missing stylesheet are visible', async () => {
  const drifted = await hooks.runDiagnostics(makeDoc({
    terminal: { selector: '.xterm-rows', fontFamily: 'Consolas', fontSizePx: 13 },
    cellWidth: 8,
  }))
  assert.equal(drifted.injected, false)
  assert.equal(drifted.cellOk, false, 'more than 0.05px off target must fail the check')
  assert.deepEqual(drifted.faces, { mono: 'missing', cjk: 'missing' })

  // 0.05px is the tolerance the UI promises: just inside passes, just outside fails
  const inside = await hooks.runDiagnostics(makeDoc({
    terminal: { selector: '.xterm-rows', fontFamily: 'X', fontSizePx: 13 },
    cellWidth: 7.1474609375 + 0.04,
  }))
  assert.equal(inside.cellOk, true)
  const outside = await hooks.runDiagnostics(makeDoc({
    terminal: { selector: '.xterm-rows', fontFamily: 'X', fontSizePx: 13 },
    cellWidth: 7.1474609375 + 0.06,
  }))
  assert.equal(outside.cellOk, false)
})

test('runDiagnostics: no terminal open degrades to nulls, never throws', async () => {
  const diag = await hooks.runDiagnostics(makeDoc())
  assert.equal(diag.terminal, null)
  assert.equal(diag.measured, null)
  assert.equal(diag.expected, null)
  assert.equal(diag.cellOk, false)
})

test('formatPx rounds for display and marks unusable values', () => {
  assert.equal(hooks.formatPx(7.1474609375), '7.147')
  assert.equal(hooks.formatPx(13), '13')
  assert.equal(hooks.formatPx(null), '—')
  assert.equal(hooks.formatPx(Number.NaN), '—')
})

// =============================================================================
// Settings plumbing
// =============================================================================

test('readRemoteSettings walks the candidate chain', () => {
  const controller = { describe() {}, update() {} }
  assert.equal(hooks.readRemoteSettings(null), null)
  assert.equal(hooks.readRemoteSettings({ get: () => controller }), controller, 'dotted name through get()')
  assert.equal(
    hooks.readRemoteSettings({ get: (n) => (n === 'remote' ? { settings: controller } : undefined) }),
    controller,
    'through the remote root',
  )
  assert.equal(hooks.readRemoteSettings({ settings: controller }), controller, 'short name on the scope')
  const throwing = {
    get() { throw new Error('cannot get property "settings" without inject') },
    get remote() { throw new Error('cannot get property "remote" without inject') },
  }
  assert.equal(hooks.readRemoteSettings(throwing), null, 'every candidate is guarded independently')
})

test('unwrapResult unwraps the typert envelope and surfaces failures', () => {
  assert.equal(hooks.unwrapResult({ ok: true, value: { a: 1 } }).a, 1)
  assert.equal(hooks.unwrapResult({ ok: true }).ok, true)
  assert.equal(hooks.unwrapResult('raw'), 'raw')
  assert.throws(() => hooks.unwrapResult({ ok: false, error: { message: 'nope' } }), /nope/)
  try {
    hooks.unwrapResult({ ok: false, error: { code: 'E_X' } })
    assert.fail('should throw')
  } catch (error) {
    assert.equal(error.message, 'E_X')
    assert.deepEqual(error.remoteError, { code: 'E_X' })
  }
})

test('settingsFromRow reads both shapes and rejects junk', () => {
  const nested = hooks.settingsFromRow({ value: { settings: { enabled: false, monoFont: 'A', monoSizeAdjust: 50 } } })
  assert.deepEqual(nested, {
    enabled: false,
    monoFont: 'A',
    cjkFont: hooks.SETTINGS_DEFAULTS.cjkFont,
    monoSizeAdjust: 50,
    cjkSizeAdjust: hooks.SETTINGS_DEFAULTS.cjkSizeAdjust,
  })
  const flat = hooks.settingsFromRow({ value: { monoFont: 'B' } })
  assert.equal(flat.monoFont, 'B')
  assert.equal(flat.enabled, true)
  const junk = hooks.settingsFromRow({ value: 'nonsense' })
  assert.deepEqual(junk, hooks.SETTINGS_DEFAULTS)
  assert.deepEqual(hooks.settingsFromRow(null), hooks.SETTINGS_DEFAULTS)
  assert.equal(hooks.settingsFromRow({ value: { monoSizeAdjust: 0.1 } }).monoSizeAdjust, 10, 'clamped')
  assert.equal(hooks.settingsFromRow({ value: { monoSizeAdjust: 9999 } }).monoSizeAdjust, 400, 'clamped')
})

test('readSettings finds our namespace row in describe()', async () => {
  const settings = {
    async describe() {
      return { ok: true, value: { namespaces: [{ ns: 'other' }, { ns: 'terminal-font', value: { monoFont: 'C' } }] } }
    },
  }
  const read = await hooks.readSettings(settings)
  assert.equal(read.settings.monoFont, 'C')
  assert.equal(read.row.ns, 'terminal-font')
  const missing = await hooks.readSettings({ async describe() { return { ok: true, value: { namespaces: [] } } } })
  assert.deepEqual(missing.settings, hooks.SETTINGS_DEFAULTS)
  await assert.rejects(() => hooks.readSettings(null), /settings-unavailable/)
})

test('saveSettings normalizes before writing the entry namespace', async () => {
  const calls = []
  const settings = {
    async update(ns, payload, extra) { calls.push([ns, payload, extra]); return { ok: true, value: {} } },
  }
  const payload = await hooks.saveSettings(settings, { enabled: false, monoFont: 'D', monoSizeAdjust: 1 })
  assert.equal(calls.length, 1)
  assert.equal(calls[0][0], 'terminal-font')
  assert.equal(calls[0][2], undefined)
  assert.deepEqual(calls[0][1], payload)
  assert.equal(payload.monoSizeAdjust, 10)
  assert.equal(payload.enabled, false)
  assert.equal(payload.cjkFont, hooks.SETTINGS_DEFAULTS.cjkFont)
  await assert.rejects(() => hooks.saveSettings(null, {}), /settings-unavailable/)
})

test('sameSettings compares the clamped five keys', () => {
  const base = hooks.SETTINGS_DEFAULTS
  assert.equal(hooks.sameSettings(base, { ...base }), true)
  assert.equal(hooks.sameSettings(base, { ...base, monoFont: 'other' }), false)
  assert.equal(hooks.sameSettings(base, { ...base, enabled: false }), false)
  assert.equal(hooks.sameSettings({ ...base, monoSizeAdjust: 1 }, { ...base, monoSizeAdjust: 0.5 }), true, 'both clamp to 10')
  assert.equal(hooks.sameSettings(base, { ...base, monoSizeAdjust: 1 }), false, 'a real difference is a difference')
  assert.equal(hooks.sameSettings(base, {}), false)
})

// =============================================================================

let passed = 0
let failed = 0
for (const [label, fn] of tests) {
  try {
    await fn()
    passed += 1
    console.log('ok    - ' + label)
  } catch (error) {
    failed += 1
    console.error('FAIL  - ' + label)
    console.error(error && error.stack ? error.stack : String(error))
  }
}
console.log(passed + '/' + (passed + failed) + ' assertions passed')
if (failed) process.exitCode = 1
