// Behavioural harness for dsh-sidebar-footer-stack/src/client.js.
//
// WHY THIS EXISTS
// The client half is a browser classic-script bundle with no build step, so it
// cannot be imported normally and the profile has no jsdom. This harness
// materializes it exactly the way @deepseek-ai/dsh-client-modules does —
// window.__ModuleLoader__.load({ id, factory }) then factory() — with a fake
// <style>/footArea DOM and a fake getComputedStyle, then asserts the diagnostic
// verdicts (installed / count / stacked / single / note) instead of eyeballing
// them in DevTools.
//
// It is a LOGIC harness, not a browser render: the real CSS cascade and the
// @container (width<=210px) fallback of the usage card are only observable in a
// real browser and are listed in ACCEPTANCE.md.
//
// Run: node dsh-sidebar-footer-stack/test/bundle.test.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const bundlePath = path.join(here, '..', 'src', 'client.js')
const PKG_ID = 'dsh-sidebar-footer-stack'
const MARKER = '/* dsh-sidebar-footer-stack */'

const source = fs.readFileSync(bundlePath, 'utf8')

// --- fake DOM ----------------------------------------------------------------

/** A fake <style> node carrying the injected marker (or arbitrary text). */
function styleNode(id, textContent) {
  return { id, textContent }
}

/** A fake plugin entry: no children of its own, unmeasurable by default. */
function fakeEntry(index) {
  return {
    className: 'fake-entry-' + index,
    children: [],
    getBoundingClientRect() {
      return { x: 0, y: 0, width: 0, height: 0 }
    },
  }
}

/**
 * A fake footArea that mirrors the REAL core structure measured in a browser:
 *   footerActions > wrapper > entry, entry, ...
 * The list slot renders exactly one wrapper child, so a fixture that hands the
 * entries straight to footerActions would let a wrapper-blind counter pass.
 */
function footArea(entryCount) {
  const entries = []
  for (let i = 0; i < entryCount; i += 1) entries.push(fakeEntry(i))
  const wrapper = { className: 'fake-slot-wrapper', children: entries }
  const actions = { children: entryCount > 0 ? [wrapper] : [] }
  return {
    actions,
    wrapper,
    entries,
    querySelector(selector) {
      if (selector === '[class*="_footerActions"]') return actions
      return null
    },
  }
}

function makeDocument(spec) {
  const styles = spec.styles || []
  return {
    getElementById(id) {
      if (spec.getElementByIdThrows) throw new Error('boom')
      return styles.find((node) => node.id === id) || null
    },
    querySelectorAll(selector) {
      if (spec.querySelectorAllThrows) throw new Error('boom')
      return selector === 'style' ? styles : []
    },
    querySelector(selector) {
      if (spec.querySelectorThrows) throw new Error('boom')
      if (selector === '[class*="_footArea"]') return spec.footArea || null
      return null
    },
  }
}

// --- loader ------------------------------------------------------------------

/**
 * Evaluate the classic-script bundle against fresh globals, then run apply().
 * @returns {{exports:any, win:any, warnings:string[]}}
 */
function load(spec) {
  const options = spec || {}
  const factories = new Map()
  const warnings = []
  const win = {
    __ModuleLoader__: {
      load({ id, factory }) {
        factories.set(id, factory)
      },
    },
  }
  // getComputedStyle only exists while the test wants a computed flex-direction.
  if (options.computed) {
    win.getComputedStyle = () => ({
      flexDirection: options.computed.flexDirection,
      width: options.computed.width,
    })
  }
  const doc = options.noDocument ? undefined : makeDocument(options)

  // globalThis.console, not the bare name: a test runner may shadow `console`.
  const realWarn = globalThis.console.warn
  globalThis.console.warn = (...args) => {
    warnings.push(args.map(String).join(' '))
  }
  try {
    // eslint-disable-next-line no-new-func -- mirrors the browser classic script
    new Function('window', 'document', source)(win, doc)
    const factory = factories.get(PKG_ID)
    assert.ok(typeof factory === 'function', 'bundle registers the package id through __ModuleLoader__')
    const exports = factory()
    exports.apply()
    return { exports, win, warnings, factory }
  } finally {
    globalThis.console.warn = realWarn
  }
}

const tests = []
function test(name, fn) {
  tests.push({ name, fn })
}

// --- registration ------------------------------------------------------------

test('bundle registers one factory under the package id and exports apply/inject', () => {
  const { exports, factory } = load({})
  assert.equal(typeof factory, 'function')
  assert.equal(typeof exports.apply, 'function')
  assert.ok(Array.isArray(exports.inject), 'inject is an array')
  assert.equal(exports.inject.length, 0, 'no service has to be injected')
})

test('apply exposes the diagnostic handle with marker, styleId and helpers', () => {
  const { win } = load({})
  const handle = win.__dshSidebarFooterStack
  assert.ok(handle, 'window.__dshSidebarFooterStack exists')
  assert.equal(handle.marker, MARKER)
  assert.equal(handle.styleId, 'dsh-sidebar-footer-stack')
  assert.equal(typeof handle.snapshot, 'function')
  assert.equal(typeof handle.report, 'function')
  assert.equal(typeof handle.styleEl, 'function')
})

// --- verdicts ----------------------------------------------------------------

test('a page that never got the stylesheet reports installed:false and tells how to fix it', () => {
  const { win, warnings } = load({})
  const state = win.__dshSidebarFooterStack.report()
  assert.equal(state.installed, false)
  assert.equal(state.ok, false)
  assert.match(state.note, /没有本插件的 <style>/)
  assert.equal(warnings.length, 1, 'exactly one console.warn for the missing stylesheet')
  assert.match(warnings[0], /dsh-sidebar-footer-stack/)
})

test('entries are counted THROUGH the slot wrapper, not as one wrapper child', () => {
  const { win } = load({
    styles: [styleNode('dsh-sidebar-footer-stack', MARKER)],
    footArea: footArea(3),
    computed: { flexDirection: 'column', width: '264px' },
  })
  const state = win.__dshSidebarFooterStack.report()
  assert.equal(state.count, 3, 'a wrapper-blind counter would report 1 and hide the bug')
  assert.equal(state.single, false)
  assert.equal(state.ok, true)
  assert.match(state.note, /3 个条目/)
})

test('a stacked two-entry footer reports ok:true with count, width and column direction', () => {
  const { win } = load({
    styles: [styleNode('dsh-sidebar-footer-stack', MARKER + '\nfoo{}')],
    footArea: footArea(2),
    computed: { flexDirection: 'column', width: '264px' },
  })
  const state = win.__dshSidebarFooterStack.report()
  assert.equal(state.installed, true)
  assert.equal(state.hasFootArea, true)
  assert.equal(state.hasFooterActions, true)
  assert.equal(state.count, 2)
  assert.equal(state.flexDirection, 'column')
  assert.equal(state.width, '264px')
  assert.equal(state.stacked, true)
  assert.equal(state.single, false)
  assert.equal(state.ok, true)
  assert.match(state.note, /已竖排/)
  assert.match(state.note, /2 个条目/)
})

test('a wrapper holding exactly one entry still counts as a single entry', () => {
  const { win } = load({
    styles: [styleNode('dsh-sidebar-footer-stack', MARKER)],
    footArea: footArea(1),
    computed: { flexDirection: 'row', width: '264px' },
  })
  const state = win.__dshSidebarFooterStack.report()
  assert.equal(state.count, 1)
  assert.equal(state.single, true)
  assert.equal(state.ok, true)
})

test('the stylesheet is also found by marker when the id is missing', () => {
  const { win } = load({
    styles: [styleNode(undefined, '/* other */'), styleNode(undefined, MARKER + '\nbar{}')],
    footArea: footArea(2),
    computed: { flexDirection: 'column', width: '264px' },
  })
  const state = win.__dshSidebarFooterStack.report()
  assert.equal(state.installed, true, 'marker scan finds the style even without an id')
  assert.equal(state.ok, true)
})

test('a single footer entry keeps the core layout and is not treated as a failure', () => {
  const { win, warnings } = load({
    styles: [styleNode('dsh-sidebar-footer-stack', MARKER)],
    footArea: footArea(1),
    computed: { flexDirection: 'row', width: '264px' },
  })
  const state = win.__dshSidebarFooterStack.report()
  assert.equal(state.single, true)
  assert.equal(state.ok, true)
  assert.match(state.note, /1 个条目/)
  assert.match(state.note, /居中/)
  assert.equal(warnings.length, 0, 'single entry is the documented behaviour, no warning')
})

test('injected but still horizontal with two entries is reported as a failure with the width', () => {
  const { win, warnings } = load({
    styles: [styleNode('dsh-sidebar-footer-stack', MARKER)],
    footArea: footArea(2),
    computed: { flexDirection: 'row', width: '96px' },
  })
  const state = win.__dshSidebarFooterStack.report()
  assert.equal(state.stacked, false)
  assert.equal(state.ok, false)
  assert.match(state.note, /仍横向/)
  assert.match(state.note, /96px/)
  assert.match(state.note, /条目 2 个/)
  assert.equal(warnings.length, 1, 'one console.warn explains why the stack did not apply')
  assert.match(warnings[0], /report\(\)/)
})

test('a missing footArea (renamed classes or the Windows titlebar mode) reports hasFootArea:false', () => {
  const { win } = load({
    styles: [styleNode('dsh-sidebar-footer-stack', MARKER)],
    footArea: null,
  })
  const state = win.__dshSidebarFooterStack.report()
  assert.equal(state.installed, true)
  assert.equal(state.hasFootArea, false)
  assert.equal(state.hasFooterActions, false)
  assert.equal(state.ok, false)
  assert.match(state.note, /没找到侧边栏 footer 容器/)
})

// --- robustness --------------------------------------------------------------

test('a hidden sidebar element without a footerActions child is handled without throwing', () => {
  const { win } = load({
    styles: [styleNode('dsh-sidebar-footer-stack', MARKER)],
    footArea: { querySelector: () => null },
  })
  const state = win.__dshSidebarFooterStack.report()
  assert.equal(state.hasFootArea, true)
  assert.equal(state.hasFooterActions, false)
  assert.equal(state.ok, false)
  assert.match(state.note, /没有 footerActions/)
})

test('no getComputedStyle (unusual host) degrades to flexDirection:null instead of throwing', () => {
  const { win } = load({
    styles: [styleNode('dsh-sidebar-footer-stack', MARKER)],
    footArea: footArea(2),
  })
  const state = win.__dshSidebarFooterStack.snapshot()
  assert.equal(state.flexDirection, null)
  assert.equal(state.width, null)
  assert.equal(state.stacked, false)
  assert.equal(state.count, 2)
})

test('a hostile document (throwing DOM accessors) cannot break the diagnostics', () => {
  const { win } = load({
    styles: [styleNode('dsh-sidebar-footer-stack', MARKER)],
    getElementByIdThrows: true,
    querySelectorAllThrows: true,
    querySelectorThrows: true,
  })
  const state = win.__dshSidebarFooterStack.report()
  assert.equal(state.installed, false)
  assert.equal(state.hasFooterActions, false)
  assert.equal(state.ok, false)
})

test('with no document at all the client half still registers and reports cleanly', () => {
  const { win } = load({ noDocument: true })
  const state = win.__dshSidebarFooterStack.report()
  assert.equal(state.installed, false)
  assert.equal(state.hasFootArea, false)
  assert.equal(state.count, 0)
  assert.equal(state.ok, false)
})

// --- run ---------------------------------------------------------------------

let failed = 0
for (const item of tests) {
  try {
    await item.fn()
    console.log('  ok   ' + item.name)
  } catch (error) {
    failed += 1
    console.log('  FAIL ' + item.name)
    console.log('       ' + String(error && error.message).replace(/\n/g, '\n       '))
  }
}

console.log('')
console.log((tests.length - failed) + '/' + tests.length + (failed ? ' FAILED' : ' passed'))
process.exit(failed === 0 ? 0 : 1)
