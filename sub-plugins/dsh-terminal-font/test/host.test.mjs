// Behavioural harness for dsh-terminal-font — NODE half only.
//
// WHY THIS EXISTS
// The node half never renders anything: it turns one row of entry Config into a
// CSS string and pushes that string into the core index-injection table through
// the 'webserver/index-inject' event. Both halves of that contract are pure, so
// the whole file runs offline with no node_modules, no browser and no DSH.
//
// The numeric half of the assertions is the load-bearing part: the CSS only
// works because size-adjust maps the Nerd Font advance onto the Consolas 13px
// cell EXACTLY. Those products are recomputed here from first principles
// (advance x size-adjust x font-size) so a typo in the shipped percentages
// fails the suite instead of quietly drifting the xterm column grid.
//
// Run: node sub-plugins/dsh-terminal-font/test/host.test.mjs
import assert from 'node:assert/strict'

import {
  name,
  inject,
  apply,
  Config,
  DEFAULTS,
  MONO_FAMILY,
  CJK_FAMILY,
  STYLE_MARKER,
  TAIL_STACK,
  TARGET_SELECTORS,
  SIZE_ADJUST_MIN,
  SIZE_ADJUST_MAX,
  TERMINAL_FONT_SIZE_PX,
  CONSOLAS_ADVANCE_EM,
  TARGET_CELL_WIDTH_PX,
  buildCss,
  normalizeEntryConfig,
  parseFontStack,
  sanitizeFontName,
  formatPercent,
  fontFaceRule,
  clampNumber,
  pushStyleRow,
} from '../src/index.js'

const tests = []
const test = (label, fn) => tests.push([label, fn])

// =============================================================================
// Cordis contract
// =============================================================================

test('host exports the cordis contract (apply / inject / name)', () => {
  assert.equal(name, 'terminal-font')
  assert.ok(Array.isArray(inject))
  assert.equal(inject.length, 0, 'the seam is a plain event, so nothing is injected')
  assert.equal(typeof apply, 'function')
})

// =============================================================================
// Numbers: the cell width the CSS must preserve
// =============================================================================

test('target cell width is Consolas 13px, recomputed from the font metrics', () => {
  assert.equal(CONSOLAS_ADVANCE_EM, 1126 / 2048)
  assert.equal(TERMINAL_FONT_SIZE_PX, 13)
  assert.equal(TARGET_CELL_WIDTH_PX, 7.1474609375)
  assert.equal(TARGET_CELL_WIDTH_PX, CONSOLAS_ADVANCE_EM * TERMINAL_FONT_SIZE_PX)
})

test('shipped size-adjust values land on the Consolas cell', () => {
  // 0xProto Nerd Font (Mono) advance = 0.6200em
  const mono = 0.62 * (DEFAULTS.monoSizeAdjust / 100) * TERMINAL_FONT_SIZE_PX
  assert.ok(Math.abs(mono - TARGET_CELL_WIDTH_PX) < 0.0005, 'mono advance ' + mono + ' != ' + TARGET_CELL_WIDTH_PX)
  // Sarasa Term SC Nerd advance = 0.5000em, and its CJK advance is exactly 2x
  const cjkLatin = 0.5 * (DEFAULTS.cjkSizeAdjust / 100) * TERMINAL_FONT_SIZE_PX
  assert.ok(Math.abs(cjkLatin - TARGET_CELL_WIDTH_PX) < 0.0005, 'cjk latin advance ' + cjkLatin)
  assert.ok(Math.abs(cjkLatin * 2 - TARGET_CELL_WIDTH_PX * 2) < 0.001)
})

// =============================================================================
// clampNumber / sanitizeFontName / parseFontStack / formatPercent
// =============================================================================

test('clampNumber clamps, coerces and falls back', () => {
  assert.equal(clampNumber(88.6781, 10, 400, 1), 88.6781)
  assert.equal(clampNumber('90.5', 10, 400, 1), 90.5)
  assert.equal(clampNumber(5, 10, 400, 1), SIZE_ADJUST_MIN)
  assert.equal(clampNumber(10000, 10, 400, 1), SIZE_ADJUST_MAX)
  assert.equal(clampNumber(Number.NaN, 10, 400, 42), 42)
  assert.equal(clampNumber(undefined, 10, 400, 42), 42)
  assert.equal(clampNumber({}, 10, 400, 42), 42)
  assert.equal(clampNumber(Infinity, 10, 400, 42), 42, 'Infinity is not a usable size')
})

test('sanitizeFontName strips quotes, structure characters and control chars', () => {
  assert.equal(sanitizeFontName('0xProto Nerd Font Mono'), '0xProto Nerd Font Mono')
  assert.equal(sanitizeFontName('  Weird\t  Font  '), 'Weird Font')
  assert.equal(sanitizeFontName('E"vil;{}()\\ Font'), 'Evil Font')
  assert.equal(sanitizeFontName('a\u0000b'), 'a b')
  assert.equal(sanitizeFontName(5), '')
  assert.equal(sanitizeFontName(null), '')
})

test('parseFontStack splits, cleans, dedupes and keeps order', () => {
  assert.deepEqual(parseFontStack('0xProto Nerd Font Mono, 0xProto Nerd Font'), [
    '0xProto Nerd Font Mono',
    '0xProto Nerd Font',
  ])
  assert.deepEqual(parseFontStack('A,,B , A'), ['A', 'B'])
  assert.deepEqual(parseFontStack('   '), [])
  assert.deepEqual(parseFontStack(undefined), [])
  assert.deepEqual(parseFontStack(7), [])
  assert.deepEqual(parseFontStack('"Quoted Font"'), ['Quoted Font'])
})

test('formatPercent prints at most four decimals', () => {
  assert.equal(formatPercent(88.6781), '88.6781')
  assert.equal(formatPercent(100), '100')
  assert.equal(formatPercent(109.9609), '109.9609')
  assert.equal(formatPercent(0.1 + 0.2), '0.3')
})

// =============================================================================
// CSS generation
// =============================================================================

test('fontFaceRule emits a local()-bound face with size-adjust', () => {
  assert.equal(
    fontFaceRule(MONO_FAMILY, ['0xProto Nerd Font Mono', '0xProto Nerd Font'], 88.6781),
    '@font-face{font-family:"' + MONO_FAMILY + '";src:local("0xProto Nerd Font Mono"), local("0xProto Nerd Font");size-adjust:88.6781%;font-display:swap}',
  )
})

test('buildCss ships the marker, both faces and the terminal override', () => {
  const css = buildCss(DEFAULTS)
  const lines = css.trimEnd().split('\n')
  assert.equal(lines[0], STYLE_MARKER)
  assert.equal(lines.length, 4)
  assert.ok(lines[1].startsWith('@font-face{font-family:"' + MONO_FAMILY + '"'))
  assert.ok(lines[1].includes('size-adjust:88.6781%'))
  assert.ok(lines[2].startsWith('@font-face{font-family:"' + CJK_FAMILY + '"'))
  assert.ok(lines[2].includes('size-adjust:109.9609%'))
  assert.equal(
    lines[3],
    TARGET_SELECTORS + '{font-family:"' + MONO_FAMILY + '", "' + CJK_FAMILY + '", ' + TAIL_STACK + ' !important}',
  )
  assert.ok(css.endsWith('\n'))
})

test('buildCss degrades: disabled, empty stacks, single stack', () => {
  assert.equal(buildCss({ enabled: false }), '')
  assert.equal(buildCss({ monoFont: '', cjkFont: '' }), '')
  assert.equal(buildCss({ monoFont: 5, cjkFont: 5 }), buildCss(DEFAULTS), 'wrong types fall back to the default stacks')
  const monoOnly = buildCss({ cjkFont: '' })
  assert.ok(monoOnly.includes('@font-face{font-family:"' + MONO_FAMILY + '"'))
  assert.ok(!monoOnly.includes(CJK_FAMILY))
  assert.ok(monoOnly.includes('{font-family:"' + MONO_FAMILY + '", ' + TAIL_STACK + ' !important}'))
  assert.equal(buildCss(undefined).includes('@font-face'), true, 'no config = defaults')
})

test('normalizeEntryConfig fills defaults, clamps bounds and drops wrong types', () => {
  assert.deepEqual(normalizeEntryConfig(undefined), DEFAULTS)
  assert.deepEqual(normalizeEntryConfig(null), DEFAULTS)
  assert.deepEqual(normalizeEntryConfig('nope'), DEFAULTS)
  assert.deepEqual(normalizeEntryConfig([1, 2]), DEFAULTS)
  assert.equal(normalizeEntryConfig({ enabled: false }).enabled, false)
  assert.equal(normalizeEntryConfig({}).enabled, true)
  assert.equal(normalizeEntryConfig({ monoSizeAdjust: 0.5 }).monoSizeAdjust, SIZE_ADJUST_MIN)
  assert.equal(normalizeEntryConfig({ cjkSizeAdjust: 9999 }).cjkSizeAdjust, SIZE_ADJUST_MAX)
  assert.equal(normalizeEntryConfig({ monoSizeAdjust: '95' }).monoSizeAdjust, 95)
  assert.equal(normalizeEntryConfig({ monoFont: 42 }).monoFont, DEFAULTS.monoFont)
  assert.equal(normalizeEntryConfig({ cjkFont: 'X' }).cjkFont, 'X')
})

// =============================================================================
// Injection table
// =============================================================================

test('pushStyleRow appends once per table and refuses bad input', () => {
  const table = []
  assert.equal(pushStyleRow(table, 'a{}'), true)
  assert.equal(pushStyleRow(table, 'a{}'), false)
  assert.equal(table.length, 1)
  assert.deepEqual(table[0], { kind: 'style', text: 'a{}' })
  assert.equal(pushStyleRow(table, 'b{}'), true)
  assert.equal(table.length, 2)
  assert.equal(pushStyleRow(table, ''), false)
  assert.equal(pushStyleRow(null, 'a{}'), false)
  assert.equal(pushStyleRow('nope', 'a{}'), false)
  // a fresh table per request (web collects per request, desktop once)
  const fresh = []
  assert.equal(pushStyleRow(fresh, 'a{}'), true)
})

test('apply listens on webserver/index-inject and feeds the table', () => {
  const listeners = []
  const disposer = () => {}
  const ctx = { on: (event, handler) => { listeners.push([event, handler]); return disposer } }
  const returned = apply(ctx, undefined)
  assert.equal(listeners.length, 1)
  assert.equal(listeners[0][0], 'webserver/index-inject')
  assert.equal(returned, disposer, 'the disposer is handed back to cordis')
  const table = []
  listeners[0][1](table)
  listeners[0][1](table)
  assert.equal(table.length, 1, 'duplicate collect of the same table must not double-push')
  assert.equal(table[0].kind, 'style')
  assert.equal(table[0].text, buildCss(DEFAULTS))
})

test('apply honors entry config overrides', () => {
  const listeners = []
  const ctx = { on: (event, handler) => { listeners.push([event, handler]); return () => {} } }
  apply(ctx, { monoFont: 'My Nerd Font', monoSizeAdjust: 100, cjkSizeAdjust: 1000 })
  const table = []
  listeners[0][1](table)
  assert.ok(table[0].text.includes('local("My Nerd Font")'))
  assert.ok(table[0].text.includes('size-adjust:100%'))
  assert.ok(table[0].text.includes('size-adjust:400%'), 'out-of-range sizes are clamped, never trusted')
})

test('apply ships nothing when disabled', () => {
  const listeners = []
  const ctx = { on: (event, handler) => { listeners.push([event, handler]); return () => {} } }
  assert.equal(apply(ctx, { enabled: false }), undefined)
  assert.equal(listeners.length, 0, 'nothing to inject = no listener at all')
})

test('a hostile injection table cannot break the page render', () => {
  const listeners = []
  const ctx = { on: (event, handler) => { listeners.push([event, handler]); return () => {} } }
  apply(ctx, undefined)
  const hostile = new Proxy([], {
    get(target, prop) {
      if (prop === 'push') throw new Error('boom')
      return Reflect.get(target, prop)
    },
  })
  assert.doesNotThrow(() => listeners[0][1](hostile))
})

// =============================================================================
// 0.2.0 entry config contract
// =============================================================================

test('Config is a hand-written schemastery-shaped entry config', () => {
  assert.equal(typeof Config, 'function')
  assert.equal(Config.type, 'object')
  assert.equal(Config.meta.volatile, true)
  assert.equal(Config['~standard'].version, 1)
  assert.equal(Config['~standard'].vendor, 'dsh-terminal-font', 'vendor must NOT be schemastery (that would imply an in-place commit)')
  const shaped = Config['~standard'].validate({ monoSizeAdjust: 1 })
  assert.deepEqual(shaped.value, normalizeEntryConfig({ monoSizeAdjust: 1 }))
})

test('Config.toJSON() matches the real schemastery output shape', () => {
  const json = Config.toJSON()
  assert.equal(json.uid, 11)
  assert.equal(json.refs['11'].type, 'object')
  assert.equal(json.refs['11'].meta.volatile, true)
  assert.deepEqual(json.refs['11'].dict, {
    enabled: 1,
    monoFont: 3,
    cjkFont: 5,
    monoSizeAdjust: 7,
    cjkSizeAdjust: 9,
  })
  assert.equal(json.refs['1'].type, 'boolean')
  assert.equal(json.refs['3'].meta.default, DEFAULTS.monoFont)
  assert.equal(json.refs['7'].meta.default, DEFAULTS.monoSizeAdjust)
  // the copy is not the internal frozen object
  json.refs['7'].meta.default = 1
  assert.equal(Config.toJSON().refs['7'].meta.default, DEFAULTS.monoSizeAdjust)
  assert.equal(Object.isFrozen(Config.toJSON()), false)
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
