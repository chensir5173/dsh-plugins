// Behavioural harness for dsh-sidebar-footer-stack/src/index.js (the host half).
//
// The host half has no DOM and no dependencies: it builds one CSS string and
// pushes it into the core's index-injection table. Everything asserted here is
// therefore pure logic — the rendered layout itself is covered by ACCEPTANCE.md
// (real browser).
//
// TWO REGRESSION PINS, both from a real incident (v0.1.0, measured in DSH 0.3.x):
//   A. The stack must reach the WRAPPER layer. The core list slot puts one
//      wrapper child under footerActions and the plugin entries inside it, so a
//      rule that only sets footerActions to column leaves the entries horizontal
//      inside the wrapper and pushes the second one outside the rail.
//   B. The single-entry guard must count THROUGH the wrapper. With
//      `:not(:has(> * + *))` alone the guard always fires (one wrapper child),
//      the row override lands after the column rule and flips the layout back.
//
// Run: node dsh-sidebar-footer-stack/test/host.test.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

import * as host from '../src/index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const pkgDir = path.join(here, '..')

const tests = []
const test = (name, fn) => tests.push([name, fn])

// --- module shape -------------------------------------------------------------

test('module exports the cordis entry triple and needs no injected service', () => {
  assert.equal(host.name, 'sidebar-footer-stack')
  assert.deepEqual(host.inject, [])
  assert.equal(typeof host.apply, 'function')
})

// --- buildCss: stack rules ----------------------------------------------------

test('default CSS is marker-first and ends with a newline', () => {
  const css = host.buildCss(host.DEFAULTS)
  assert.equal(css.split('\n')[0], host.STYLE_MARKER, 'marker must be the first line')
  assert.ok(css.endsWith('\n'), 'stylesheets always end with a newline')
})

test('the slot itself becomes a vertical stack with a real gap', () => {
  const css = host.buildCss(host.DEFAULTS)
  assert.match(css, /\[class\*="_footArea"\] > \[class\*="_footerActions"\]\{flex-direction:column !important/)
  assert.match(css, /align-items:stretch !important/)
  assert.match(css, /gap:4px !important/)
})

test('REGRESSION A: the wrapper layer is stacked too, not just the slot', () => {
  const css = host.buildCss(host.DEFAULTS)
  // wrapper = footerActions' direct child
  assert.match(
    css,
    /_footerActions"\] > \*\{flex:0 0 auto !important;display:flex !important;flex-direction:column !important;align-items:stretch !important/,
    'the slot wrapper must be a column, otherwise the entries stay side by side inside it',
  )
  // entry = wrapper's child
  assert.match(
    css,
    /_footerActions"\] > \* > \*\{flex:0 0 auto !important;width:100% !important;min-width:0 !important/,
    'every entry must take the full rail width',
  )
})

test('no container query / containment is used any more', () => {
  const css = host.buildCss(host.DEFAULTS)
  assert.ok(css.indexOf('@container') < 0, 'the fix must not depend on a container query')
  assert.ok(css.indexOf('container-type') < 0, 'footArea must not get contain:layout')
})

test('REGRESSION B: the single-entry guard counts through the wrapper', () => {
  const css = host.buildCss(host.DEFAULTS)
  const guard = /:not\(:has\(> \* \+ \*\)\):not\(:has\(> \* > \* \+ \*\)\)/g
  assert.ok(guard.test(css), 'the guard needs BOTH :not(:has()) conditions')
  assert.match(css, /:not\(:has\(> \* \+ \*\)\):not\(:has\(> \* > \* \+ \*\)\)\{flex-direction:row !important;align-items:center !important/)
})

test('the row fallback is emitted only after the column rules', () => {
  const css = host.buildCss(host.DEFAULTS)
  const columnAt = css.indexOf('flex-direction:column !important')
  const rowAt = css.indexOf('flex-direction:row !important')
  assert.ok(columnAt >= 0 && rowAt > columnAt, 'row fallback must come last so it is not overridden by accident')
})

test('the collapsed rail guard is the very last rule', () => {
  const css = host.buildCss(host.DEFAULTS)
  const lines = css.trimEnd().split('\n')
  const tail = lines.slice(-3).join('\n')
  assert.match(tail, /^\[class\*="_collapsed"\] /, 'collapsed rules must close the sheet')
  assert.match(tail, /justify-content:center !important/)
  assert.match(tail, /width:auto !important/)
})

test('stackSingle:true drops the single-entry guard but keeps the collapsed guard', () => {
  const css = host.buildCss({ stackSingle: true })
  assert.ok(css.indexOf(':has(') < 0, 'no :has() rule when every entry stacks')
  assert.match(css, /\[class\*="_collapsed"\] /)
})

test('enabled:false ships no CSS at all', () => {
  assert.equal(host.buildCss({ enabled: false }), '')
  assert.equal(host.buildCss(Object.assign({}, host.DEFAULTS, { enabled: false })), '')
})

test('the configured gap reaches every stacked layer', () => {
  const css = host.buildCss({ gap: 10 })
  assert.equal(css.split('gap:10px !important').length - 1, 2, 'slot + wrapper both use the gap')
  assert.ok(css.indexOf('gap:4px') < 0)
})

// --- normalizeEntryConfig / clampInt ------------------------------------------

test('gap is clamped to 0..24 and non-numbers fall back', () => {
  assert.equal(host.normalizeEntryConfig({ gap: 99 }).gap, host.GAP_MAX)
  assert.equal(host.normalizeEntryConfig({ gap: -5 }).gap, host.GAP_MIN)
  assert.equal(host.normalizeEntryConfig({ gap: 'nope' }).gap, host.DEFAULTS.gap)
  assert.equal(host.normalizeEntryConfig({ gap: '6' }).gap, 6, 'numeric strings are accepted')
  assert.equal(host.normalizeEntryConfig({ gap: 3.6 }).gap, 4, 'fractional px is rounded')
})

test('minWidth is gone: the old threshold key is ignored, not honoured', () => {
  const resolved = host.normalizeEntryConfig({ minWidth: 300 })
  assert.equal('minWidth' in resolved, false, 'the container-query threshold must not come back')
  assert.match(host.buildCss({ minWidth: 300 }), /flex-direction:column !important/)
})

test('a non-object config keeps the defaults (null / array / string / undefined)', () => {
  for (const bad of [null, undefined, [], 'x', 42]) {
    const resolved = host.normalizeEntryConfig(bad)
    assert.deepEqual(resolved, host.DEFAULTS, 'input ' + JSON.stringify(bad))
  }
})

test('enabled defaults to true and only false disables it', () => {
  assert.equal(host.normalizeEntryConfig({}).enabled, true)
  assert.equal(host.normalizeEntryConfig({ enabled: 0 }).enabled, true, 'only literal false disables')
  assert.equal(host.normalizeEntryConfig({ enabled: false }).enabled, false)
})

test('clampInt bounds and falls back', () => {
  assert.equal(host.clampInt(5, 0, 10, 3), 5)
  assert.equal(host.clampInt(-1, 0, 10, 3), 0)
  assert.equal(host.clampInt(11, 0, 10, 3), 10)
  assert.equal(host.clampInt(NaN, 0, 10, 3), 3)
  assert.equal(host.clampInt(Infinity, 0, 10, 3), 3)
})

// --- pushStyleRow -------------------------------------------------------------

test('pushStyleRow writes once and deduplicates the same CSS', () => {
  const table = []
  const css = host.buildCss(host.DEFAULTS)
  assert.equal(host.pushStyleRow(table, css), true)
  assert.equal(table.length, 1)
  assert.deepEqual(table[0], { kind: 'style', text: css })
  assert.equal(host.pushStyleRow(table, css), false, 'same CSS must not be added twice')
  assert.equal(table.length, 1)
})

test('pushStyleRow ignores a non-array table or empty css', () => {
  assert.equal(host.pushStyleRow(null, 'x'), false)
  assert.equal(host.pushStyleRow({}, 'x'), false)
  assert.equal(host.pushStyleRow([], ''), false)
  assert.equal(host.pushStyleRow([], null), false)
})

test('pushStyleRow tolerates foreign rows in the same table', () => {
  const table = [{ kind: 'script', text: 'x' }, null, { kind: 'style', text: 'other' }]
  assert.equal(host.pushStyleRow(table, host.buildCss(host.DEFAULTS)), true)
  assert.equal(table.length, 4)
})

// --- apply -------------------------------------------------------------------

function makeCtx() {
  const listeners = []
  return {
    listeners,
    on(event, fn) {
      listeners.push([event, fn])
      return () => { const i = listeners.findIndex(([e, f]) => e === event && f === fn); if (i >= 0) listeners.splice(i, 1) }
    },
  }
}

test('apply listens on webserver/index-inject and injects one style row', () => {
  const ctx = makeCtx()
  const dispose = host.apply(ctx, undefined)
  assert.equal(typeof dispose, 'function', 'apply returns the disposer')
  assert.equal(ctx.listeners.length, 1)
  assert.equal(ctx.listeners[0][0], 'webserver/index-inject')
  const table = []
  ctx.listeners[0][1](table)
  assert.equal(table.length, 1)
  assert.equal(table[0].kind, 'style')
  assert.equal(table[0].text, host.buildCss(host.DEFAULTS))
})

test('the listener is idempotent across two collects of the same table', () => {
  const ctx = makeCtx()
  host.apply(ctx, {})
  const table = []
  const emit = ctx.listeners[0][1]
  emit(table)
  emit(table)
  assert.equal(table.length, 1)
})

test('apply with enabled:false registers nothing', () => {
  const ctx = makeCtx()
  assert.equal(host.apply(ctx, { enabled: false }), undefined)
  assert.equal(ctx.listeners.length, 0)
})

test('a hostile injection table cannot throw out of the listener', () => {
  const ctx = makeCtx()
  host.apply(ctx, {})
  const table = new Proxy([], { get(target, prop) { if (prop === 'push') return () => { throw new Error('boom') }; return Reflect.get(target, prop) } })
  assert.doesNotThrow(() => ctx.listeners[0][1](table))
})

test('apply reads gap / stackSingle from the entry config', () => {
  const ctx = makeCtx()
  host.apply(ctx, { gap: 8, stackSingle: true })
  const table = []
  ctx.listeners[0][1](table)
  assert.match(table[0].text, /gap:8px !important/)
  assert.ok(table[0].text.indexOf(':has(') < 0)
})

// --- package contract ---------------------------------------------------------

test('package.json follows the local-plugin contract (no dsh.bundle, both halves declared)', () => {
  const pkg = JSON.parse(fs.readFileSync(path.join(pkgDir, 'package.json'), 'utf8'))
  assert.equal(pkg.name, 'dsh-sidebar-footer-stack')
  assert.equal(pkg.type, 'module')
  assert.equal(pkg.main, 'src/index.js')
  assert.equal(pkg.exports['.'], './src/index.js')
  assert.equal(pkg.exports['./client'], './src/client.js')
  assert.equal(pkg.dsh.client.platform, 'web')
  assert.equal(pkg.dsh.bundle, undefined, 'a sub-plugin must NOT declare dsh.bundle')
  assert.equal(fs.existsSync(path.join(pkgDir, 'cordis.patch.yml')), false, 'a sub-plugin must NOT ship its own patch file')
  assert.ok(fs.existsSync(path.join(pkgDir, 'src', 'client.js')))
  assert.ok(fs.existsSync(path.join(pkgDir, 'README.md')))
  assert.ok(fs.existsSync(path.join(pkgDir, 'ACCEPTANCE.md')))
})

test('the client bundle registers the package id through the module loader', () => {
  const source = fs.readFileSync(path.join(pkgDir, 'src', 'client.js'), 'utf8')
  assert.match(source, /window\.__ModuleLoader__\.load\(\{/)
  assert.match(source, /id: 'dsh-sidebar-footer-stack'/)
  assert.ok(source.indexOf(host.STYLE_MARKER) >= 0, 'the client must look for the exact host marker')
  // the client must count through the wrapper too, or report() lies about "single"
  assert.match(source, /function itemsOf/, 'client diagnostics need the wrapper-aware entry counter')
  assert.ok(source.indexOf('thresholdPx') < 0, 'the container-query threshold is gone')
})

// --- run ---------------------------------------------------------------------

let failed = 0
for (const [name, fn] of tests) {
  try {
    await fn()
    console.log('  ok   ' + name)
  } catch (error) {
    failed += 1
    console.log('  FAIL ' + name + '\n       ' + (error && error.message))
  }
}
console.log(failed === 0 ? '\n' + tests.length + '/' + tests.length + ' passed' : '\n' + failed + '/' + tests.length + ' FAILED')
process.exit(failed === 0 ? 0 : 1)
