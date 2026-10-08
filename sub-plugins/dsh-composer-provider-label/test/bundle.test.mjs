// Behavioural harness for dsh-composer-provider-label.
//
// WHY THIS EXISTS
// The plugin is a browser classic-script bundle with no build step, so it
// cannot be imported normally, and the profile has no jsdom. This harness
// materializes the bundle the way @deepseek-ai/dsh-client-modules does —
// window.__ModuleLoader__.load({id, factory}) then factory(require) — with a
// fake React + ui-primitives and a fake cordis ctx, then drives the registered
// `conversation.input.right` component through a minimal hook shim so the
// whole resolution path (projection -> catalog -> aliases -> tooltip) is
// executed and asserted instead of eyeballed.
//
// It is a LOGIC harness, not a browser render: React semantics are
// approximated (one effect run per slot, state visible only after an explicit
// re-render). Visual/layout behaviour (Tooltip positioning, ellipsis width,
// theme tokens) still needs the manual checks in ACCEPTANCE.md.
//
// Each test re-evaluates the bundle in a FRESH module so module-level cache
// (catalog/aliases/listeners/event binding) never leaks across cases.
//
// Run: node dsh-composer-provider-label/test/bundle.test.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const bundlePath = path.join(here, '..', 'src', 'client.js')
const indexPath = path.join(here, '..', 'src', 'index.js')
const PKG_ID = 'dsh-composer-provider-label'
const NS = 'composer-provider-label'
const SLOT = 'conversation.input.right'
const SETTINGS_NS = 'dsh-composer-provider-label'
const BUILTIN = { 'deepseek-official': 'office' }

const source = fs.readFileSync(bundlePath, 'utf8')

// --- tiny React shim (per-test instance) -------------------------------------

function makeReact() {
  let slots = []
  let index = 0
  let dirty = false
  const React = {
    createElement: (type, props, ...children) => ({
      __element: true,
      type,
      props: { ...(props || {}), children: children.length === 1 ? children[0] : children },
    }),
    useState(initial) {
      const i = index++
      if (!(i in slots)) slots[i] = { value: typeof initial === 'function' ? initial() : initial }
      const slot = slots[i]
      return [slot.value, (next) => {
        slot.value = typeof next === 'function' ? next(slot.value) : next
        dirty = true
      }]
    },
    useEffect(effect) {
      const i = index++
      if (!(i in slots)) slots[i] = { ran: false }
      const slot = slots[i]
      if (!slot.ran) {
        slot.ran = true
        effect()
      }
    },
  }
  return {
    React,
    beginRender() { index = 0; dirty = false },
    freshInstance() { slots = []; index = 0; dirty = false },
    isDirty: () => dirty,
  }
}

// --- fresh browser globals + module load -------------------------------------

/** Evaluate the bundle once in a fresh window; returns the factory map. */
function bootModule(language, storage) {
  const factories = new Map()
  const window = { __ModuleLoader__: { load: ({ id, factory }) => factories.set(id, factory) } }
  if (storage !== undefined && storage !== null) window.localStorage = storage
  const navigator = { languages: [language || 'zh-CN'], language: language || 'zh-CN' }
  const styles = []
  const document = {
    body: {},
    head: { appendChild: (element) => { styles.push(element) } },
    createElement: () => ({ style: {}, setAttribute() {} }),
    getElementById: (id) => styles.find((element) => element.id === id) || null,
  }
  // eslint-disable-next-line no-new-func -- mirroring browser classic-script evaluation
  new Function('window', 'navigator', 'document', source)(window, navigator, document)
  return { window, factories, document, styles }
}

function makeLocale(log) {
  const registered = []
  return {
    registered,
    register: (ns, dicts) => { log.registered.push([ns, dicts]); return () => {} },
    // translate() returning undefined forces __t's navigator-languages fallback,
    // which is how each test pins the language.
    translate: () => undefined,
    subscribe: () => () => {},
  }
}

/**
 * A fake cordis ctx. `remote` may gain session/settings/$on later; get() reads
 * live so a late-arriving controller is picked up by the next render's
 * __ensureLoaded. ctx.on records handlers (so tests can fire connection/reset);
 * remote.$on handlers are recorded too.
 */
function makeCtx({ locale, remote, log, sessions }) {
  const registered = []
  const handlers = { on: [], remoteEvents: [], reset: [] }
  const ctx = {
    registered,
    log,
    get(name) {
      if (name === 'locale') return locale
      if (name === 'remote') return remote
      if (name === 'remote.session') return remote && remote.session
      if (name === 'remote.settings') return remote && remote.settings
      if (name === 'sessions') return sessions
      return undefined
    },
    effect: (fn) => { fn(); return () => {} },
    on(event, handler) {
      handlers.on.push([event, handler])
      if (event === 'connection/reset') handlers.reset.push(handler)
      return () => {}
    },
    inject(names, fn) {
      const sub = { get: (n) => ctx.get(n), locale }
      if (remote) sub.remote = remote
      fn(sub)
    },
    slots: {
      inject: (_slot, build) => { build(); return {} },
      register: (options, component) => {
        registered.push({ options, component })
        return { dispose() {} }
      },
    },
  }
  if (remote && typeof remote.$on === 'function') {
    const original = remote.$on
    remote.$on = (event, handler) => {
      handlers.remoteEvents.push([event, handler])
      return typeof original === 'function' ? undefined : () => {}
    }
  }
  // Simulate the real guarded context: reading `ctx.remote` as a bare property
  // when the service has not been injected throws (this is exactly what killed
  // apply on a real profile — the property fallback in __bindEvents used to
  // live outside its try/catch).
  if (remote === undefined || remote === null) {
    Object.defineProperty(ctx, 'remote', {
      configurable: true,
      enumerable: false,
      get() { throw new Error('cannot get property "remote" without inject') },
    })
  }
  ctx.handlers = handlers
  return ctx
}

/** Menu stub: a marker component so tests can drive items/footer/onSelect directly. */
function makeMenuStub() {
  const Menu = (props) => ({ __element: true, type: { __menuStub: true }, props })
  Menu.__menuStub = true
  return Menu
}

function requireStub(React, { withMenu = true } = {}) {
  return (specifier) => {
    if (specifier === 'react') return React
    if (specifier === '@deepseek-ai/dsh-client-ui-primitives') {
      const lib = { Tooltip: (props) => props.children }
      if (withMenu) {
        lib.Menu = makeMenuStub()
        lib.IconChevronDownOutline14 = (props) => ({ __element: true, type: 'chevron', props: props || {} })
      }
      return lib
    }
    throw new Error(`unexpected require("${specifier}")`)
  }
}

/**
 * Boot one module, apply the plugin with the given remote handles, and return
 * everything needed to drive the registered component.
 */
function boot({ language = 'zh-CN', remote, sessions, storage, withMenu = true } = {}) {
  const { window, factories, document: fakeDocument, styles } = bootModule(language, storage)
  const { React, beginRender, freshInstance, isDirty } = makeReact()
  const log = { registered: [] }
  const locale = makeLocale(log)
  const ctx = makeCtx({ locale, remote, log, sessions })
  const factory = factories.get(PKG_ID)
  assert.ok(factory, `bundle did not register id "${PKG_ID}"`)
  const exports_ = factory(requireStub(React, { withMenu }))
  assert.equal(typeof exports_.apply, 'function')
  exports_.apply(ctx)
  const entry = ctx.registered[0]
  const Component = entry ? entry.component : null

  const renderStable = (ComponentRef, props, first) => {
    if (first) freshInstance()
    else beginRender()
    let tree = ComponentRef(props)
    let guard = 0
    while (isDirty() && guard < 6) {
      beginRender()
      tree = ComponentRef(props)
      guard += 1
    }
    return tree
  }

  const env = {
    window,
    ctx,
    log,
    entry,
    Component,
    styles,
    document: fakeDocument,
    render: (props) => renderStable(Component, props, true),
    rerender: (props) => renderStable(Component, props, false),
    flush: async () => {
      for (let tick = 0; tick < 8; tick += 1) await Promise.resolve()
    },
  }
  return env
}

/** Concatenate the text of a (possibly nested/array) element tree. */
function textOf(node) {
  if (node === null || node === undefined || node === false) return ''
  if (typeof node === 'string' || typeof node === 'number') return String(node)
  if (Array.isArray(node)) return node.map(textOf).join('')
  if (node.__element) return textOf(node.props && node.props.children)
  return ''
}

/** The Menu element when the picker rendered, else null (degraded/read-only label). */
function menuOf(tree) {
  return tree && tree.__element && tree.type && tree.type.__menuStub === true ? tree : null
}

/** The Tooltip-wrapped entry: the Menu anchor when present, else the tree itself. */
function anchorOf(tree) {
  const menu = menuOf(tree)
  return menu ? menu.props.anchor : tree
}

/** The interactive button of the entry (null on the degraded read-only label). */
function buttonOf(tree) {
  const anchor = anchorOf(tree)
  if (!anchor || !anchor.__element) return null
  const node = anchor.props && anchor.props.children
  if (node && node.__element && node.type === 'button') return node
  if (Array.isArray(node)) {
    const found = node.find((child) => child && child.__element && child.type === 'button')
    if (found) return found
  }
  return null
}

function clickEntry(tree) {
  const button = buttonOf(tree)
  assert.ok(button, 'the entry renders an interactive button')
  button.props.onClick()
}

function hoverEntry(tree) {
  const button = buttonOf(tree)
  assert.ok(button, 'the entry renders an interactive button')
  button.props.onMouseEnter()
}

/** Unwrap the entry: { tooltip, text, aria } or null when nothing renders. */
function labelOf(tree) {
  const anchor = anchorOf(tree)
  if (!anchor || !anchor.__element) return null
  const tooltip = anchor.props && anchor.props.label
  const node = anchor.props && anchor.props.children
  const aria = node && node.props && node.props['aria-label']
  return { tooltip, text: textOf(node), aria }
}

function menuProps(tree) {
  const menu = menuOf(tree)
  return menu ? menu.props : null
}

function itemsOf(tree) {
  const props = menuProps(tree)
  return props ? props.items : []
}

function footerOf(tree) {
  const props = menuProps(tree)
  return props ? props.footer || [] : []
}

function itemById(tree, id) {
  return itemsOf(tree).find((entry) => entry && entry.id === id)
}

function selectItem(tree, id) {
  const props = menuProps(tree)
  assert.ok(props, 'the menu is rendered')
  props.onSelect(id)
}

/** A fake localStorage backed by a Map, mirroring the browser surface used. */
function makeStorage(initial) {
  const map = new Map(Object.entries(initial || {}))
  return {
    getItem: (key) => (map.has(key) ? map.get(key) : null),
    setItem: (key, value) => { map.set(key, String(value)) },
    removeItem: (key) => { map.delete(key) },
    dump: () => Object.fromEntries(map),
  }
}

// --- fake catalog + projection ----------------------------------------------

function catalogOf(overrides = {}) {
  const catalog = {
    default: { provider: 'codemaker', model: 'deepseek-v4-flash' },
    routableProviders: ['deepseek-official', 'ark', 'codemaker', 'bai', 'openroputer'],
    groups: [
      { id: 'deepseek-official', name: 'DeepSeek', models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' }] },
      { id: 'ark', name: 'ARK (Coding Plan)', models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' }] },
      { id: 'codemaker', name: 'codemaker', models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' }] },
      { id: 'bai', name: 'B.AI', models: [{ id: 'deepseek-v4-flash', name: 'DeepSeek-V4-Flash' }] },
      { id: 'openroputer', name: 'Open Router', models: [{ id: 'deepseek/deepseek-v4-flash', name: 'DeepSeek: DeepSeek V4 Flash' }] },
    ],
    failures: [],
    ...overrides,
  }
  return catalog
}

function projectionOf(next, lastUsed = null) {
  return { lastUsed, next }
}

/** Props the runtime hands a session-scoped input.right entry: a live useProjection hook. */
function compProps(sessionId, projection) {
  return { sessionId, useProjection: (key) => (key === 'modelSelection' ? projection : undefined) }
}

const SESS = { provider: 'ark', model: 'deepseek-v4-flash' }
const OFFICIAL = { provider: 'deepseek-official', model: 'deepseek-v4-flash' }

// --- tests -------------------------------------------------------------------

const tests = []
const test = (name, fn) => tests.push([name, fn])

// --- registration & locale ---------------------------------------------------

test('bundle registers under the package id and declares only slots', () => {
  const { window, factories } = bootModule('zh-CN')
  const { React } = makeReact()
  const exports_ = factories.get(PKG_ID)(requireStub(React))
  assert.deepEqual(exports_.inject, ['slots'])
  assert.equal(typeof exports_.apply, 'function')
  assert.ok(window.__cpl, 'diagnostics handle published on window.__cpl')
})

test('apply registers one entry on conversation.input.right at id/order 10', () => {
  const env = boot()
  assert.equal(env.ctx.registered.length, 1)
  const { options } = env.ctx.registered[0]
  assert.equal(options.name, SLOT)
  assert.equal(options.id, 'composer-provider-label')
  assert.equal(options.order, 10)
})

test('locale dictionaries are registered under the plugin namespace', () => {
  const env = boot()
  assert.equal(env.log.registered.length, 1)
  assert.equal(env.log.registered[0][0], NS)
  assert.deepEqual(Object.keys(env.log.registered[0][1]), ['zh', 'en'])
})

// --- route resolution --------------------------------------------------------

test('no session renders nothing', async () => {
  const env = boot({ remote: { session: { modelCatalog: async () => ({ ok: true, value: catalogOf() }) } } })
  const tree = env.render(compProps(undefined, projectionOf(SESS)))
  assert.equal(tree, null)
})

test('no projection and no catalog renders nothing', () => {
  const env = boot()
  assert.equal(env.render({ sessionId: 's1', projection: undefined }), null)
})

test('explicit projection.next renders immediately, display name lands after catalog', async () => {
  const env = boot({ remote: { session: { modelCatalog: async () => ({ ok: true, value: catalogOf() }) } } })
  const early = env.render(compProps('s1', projectionOf(SESS)))
  // Catalog still loading: route known from the projection, so we show the raw id.
  assert.equal(labelOf(early).text, 'ark')
  await env.flush()
  const late = env.rerender(compProps('s1', projectionOf(SESS)))
  const label = labelOf(late)
  assert.equal(label.text, 'ARK')
  assert.match(label.tooltip, /ARK \(Coding Plan\)/)
})

test('follows the profile default when the session never selected a model', async () => {
  const env = boot({ remote: { session: { modelCatalog: async () => ({ ok: true, value: catalogOf() }) } } })
  env.render(compProps('s1', projectionOf(null, null)))
  await env.flush()
  const tree = env.rerender(compProps('s1', projectionOf(null, null)))
  assert.equal(labelOf(tree).text, 'codemaker')
})

test('official provider shows office via the built-in alias', async () => {
  const env = boot({ remote: { session: { modelCatalog: async () => ({ ok: true, value: catalogOf() }) } } })
  env.render(compProps('s1', projectionOf(OFFICIAL)))
  await env.flush()
  const tree = env.rerender(compProps('s1', projectionOf(OFFICIAL)))
  const label = labelOf(tree)
  assert.equal(label.text, 'office')
  assert.match(label.tooltip, /DeepSeek/) // full registered name still visible
})

test('provider absent from the catalog falls back to its raw id', async () => {
  const env = boot({ remote: { session: { modelCatalog: async () => ({ ok: true, value: catalogOf() }) } } })
  const route = { provider: 'unknown-router', model: 'x' }
  env.render(compProps('s1', projectionOf(route)))
  await env.flush()
  const tree = env.rerender(compProps('s1', projectionOf(route)))
  assert.equal(labelOf(tree).text, 'unknown-router')
})

// --- tooltip content & source classification --------------------------------

test('tooltip carries provider full name, model id and an explicit-source note', async () => {
  const env = boot({ remote: { session: { modelCatalog: async () => ({ ok: true, value: catalogOf() }) } } })
  env.render(compProps('s1', projectionOf(SESS)))
  await env.flush()
  const label = labelOf(env.rerender(compProps('s1', projectionOf(SESS))))
  assert.match(label.tooltip, /ARK \(Coding Plan\)/)
  assert.match(label.tooltip, /deepseek-v4-flash/)
  assert.match(label.tooltip, /本会话显式选择/)
})

test('tooltip reports a carried-over last request when next equals lastUsed', async () => {
  const env = boot({ remote: { session: { modelCatalog: async () => ({ ok: true, value: catalogOf() }) } } })
  env.render(compProps('s1', projectionOf(SESS, SESS)))
  await env.flush()
  const label = labelOf(env.rerender(compProps('s1', projectionOf(SESS, SESS))))
  assert.match(label.tooltip, /沿用上一条请求/)
})

test('tooltip reports the profile default when nothing was ever chosen', async () => {
  const env = boot({ remote: { session: { modelCatalog: async () => ({ ok: true, value: catalogOf() }) } } })
  env.render(compProps('s1', projectionOf(null, null)))
  await env.flush()
  const label = labelOf(env.rerender(compProps('s1', projectionOf(null, null))))
  assert.match(label.tooltip, /跟随 profile 默认/)
})

// --- user-configured aliases (settings namespace) ----------------------------

test('user aliases from the settings namespace override built-in and display names', async () => {
  const describe = async () => ({
    ok: true,
    value: {
      namespaces: [{ ns: SETTINGS_NS, value: { providerAliases: { codemaker: 'cm' } } }],
    },
  })
  const env = boot({
    remote: {
      session: { modelCatalog: async () => ({ ok: true, value: catalogOf() }) },
      settings: { describe },
    },
  })
  const route = { provider: 'codemaker', model: 'deepseek-v4-flash' }
  env.render(compProps('s1', projectionOf(route)))
  await env.flush()
  const tree = env.rerender(compProps('s1', projectionOf(route)))
  assert.equal(labelOf(tree).text, 'cm')
})

test('describe failure keeps the built-in alias map and never errors', async () => {
  const env = boot({
    remote: {
      session: { modelCatalog: async () => ({ ok: true, value: catalogOf() }) },
      settings: { describe: async () => { throw new Error('settings provider down') } },
    },
  })
  env.render(compProps('s1', projectionOf(OFFICIAL)))
  await env.flush()
  const tree = env.rerender(compProps('s1', projectionOf(OFFICIAL)))
  assert.equal(labelOf(tree).text, 'office')
})

test('describe without our namespace keeps the built-in alias map', async () => {
  const env = boot({
    remote: {
      session: { modelCatalog: async () => ({ ok: true, value: catalogOf() }) },
      settings: { describe: async () => ({ ok: true, value: { namespaces: [] } }) },
    },
  })
  env.render(compProps('s1', projectionOf(OFFICIAL)))
  await env.flush()
  const tree = env.rerender(compProps('s1', projectionOf(OFFICIAL)))
  assert.equal(labelOf(tree).text, 'office')
})

// --- refresh on the three signals --------------------------------------------

test('llm/adapters-updated reloads the catalog', async () => {
  let calls = 0
  const modelCatalog = async () => {
    calls += 1
    return { ok: true, value: calls === 1 ? catalogOf() : catalogOf({ groups: [{ id: 'ark', name: 'ARK Two' }] }) }
  }
  const env = boot({
    remote: {
      session: { modelCatalog },
      settings: { describe: async () => ({ ok: true, value: { namespaces: [] } }) },
      $on: () => () => {},
    },
  })
  env.render(compProps('s1', projectionOf(SESS)))
  await env.flush()
  assert.equal(calls, 1)
  assert.equal(labelOf(env.rerender(compProps('s1', projectionOf(SESS)))).text, 'ARK')
  const adapter = env.ctx.handlers.remoteEvents.find(([e]) => e === 'llm/adapters-updated')
  assert.ok(adapter, 'llm/adapters-updated was subscribed')
  adapter[1]() // invalidates + notifies; the next render re-loads
  env.rerender(compProps('s1', projectionOf(SESS)))
  await env.flush()
  assert.equal(calls, 2, 'adapter update invalidated and reloaded the catalog')
  const tree = env.rerender(compProps('s1', projectionOf(SESS)))
  assert.equal(labelOf(tree).text, 'ARK Two')
})

test('settings/document-updated for our namespace reloads the alias map', async () => {
  let aliasVersion = 0
  const describe = async () => {
    aliasVersion += 1
    const aliases = aliasVersion === 1 ? {} : { 'deepseek-official': '火山官方' }
    return { ok: true, value: { namespaces: [{ ns: SETTINGS_NS, value: { providerAliases: aliases } }] } }
  }
  const env = boot({
    remote: {
      session: { modelCatalog: async () => ({ ok: true, value: catalogOf() }) },
      settings: { describe },
      $on: () => () => {},
    },
  })
  env.render(compProps('s1', projectionOf(OFFICIAL)))
  await env.flush()
  assert.equal(labelOf(env.rerender(compProps('s1', projectionOf(OFFICIAL)))).text, 'office')
  const doc = env.ctx.handlers.remoteEvents.find(([e]) => e === 'settings/document-updated')
  assert.ok(doc, 'settings/document-updated was subscribed')
  doc[1](SETTINGS_NS) // invalidates catalog + allows one fresh alias describe
  env.rerender(compProps('s1', projectionOf(OFFICIAL))) // queued alias reload
  await env.flush()
  const tree = env.rerender(compProps('s1', projectionOf(OFFICIAL)))
  assert.equal(labelOf(tree).text, '火山官方')
})

test('connection/reset is subscribed and reloads through a fresh read', async () => {
  let calls = 0
  const modelCatalog = async () => {
    calls += 1
    const name = calls === 1 ? 'ARK' : 'New Ark Branding'
    return { ok: true, value: { default: { provider: 'ark', model: 'deepseek-v4-flash' }, groups: [{ id: 'ark', name }] } }
  }
  const env = boot({
    remote: {
      session: { modelCatalog },
      settings: { describe: async () => ({ ok: true, value: { namespaces: [] } }) },
      $on: () => () => {},
    },
  })
  env.render(compProps('s1', projectionOf(null, null)))
  await env.flush()
  assert.equal(labelOf(env.rerender(compProps('s1', projectionOf(null, null)))).text, 'ARK')
  assert.ok(env.ctx.handlers.reset.length >= 1, 'connection/reset was subscribed via ctx.on')
  env.ctx.handlers.reset[0]() // clears the catalog; the next render re-loads
  env.rerender(compProps('s1', projectionOf(null, null)))
  await env.flush()
  assert.equal(calls, 2, 'reset invalidated and reloaded the catalog')
  const tree = env.rerender(compProps('s1', projectionOf(null, null)))
  assert.equal(labelOf(tree).text, 'New Ark Branding')
})

// --- language ----------------------------------------------------------------

test('labels follow the client language', async () => {
  const en = boot({ language: 'en-US', remote: { session: { modelCatalog: async () => ({ ok: true, value: catalogOf() }) } } })
  en.render(compProps('s1', projectionOf(SESS)))
  await en.flush()
  const enLabel = labelOf(en.rerender(compProps('s1', projectionOf(SESS))))
  assert.match(enLabel.aria, /Model provider/)
  assert.match(enLabel.tooltip, /explicitly chosen/)

  const zh = boot({ language: 'zh-CN', remote: { session: { modelCatalog: async () => ({ ok: true, value: catalogOf() }) } } })
  zh.render(compProps('s1', projectionOf(SESS)))
  await zh.flush()
  const zhLabel = labelOf(zh.rerender(compProps('s1', projectionOf(SESS))))
  assert.match(zhLabel.aria, /模型提供方/)
})

// --- pure helpers ------------------------------------------------------------

test('pure: stripParenthetical trims only the trailing parenthetical', () => {
  const env = boot()
  const pure = env.window.__cpl.pure
  assert.equal(pure.stripParenthetical('ARK (Coding Plan)'), 'ARK')
  assert.equal(pure.stripParenthetical('ARK（正式）'), 'ARK')
  assert.equal(pure.stripParenthetical('A (B) (C)'), 'A (B)')
  assert.equal(pure.stripParenthetical('B.AI'), 'B.AI')
  assert.equal(pure.stripParenthetical('(only)'), '(only)')
  assert.equal(pure.stripParenthetical(''), '')
})

test('pure: resolveRoute follows next -> lastUsed -> default', () => {
  const env = boot()
  const pure = env.window.__cpl.pure
  const catalog = catalogOf()
  const next = { provider: 'ark', model: 'm' }
  const last = { provider: 'bai', model: 'm' }
  assert.equal(pure.resolveRoute({ next, lastUsed: last }, catalog), next)
  assert.equal(pure.resolveRoute({ next: null, lastUsed: last }, catalog), last)
  assert.equal(pure.resolveRoute({ next: null, lastUsed: null }, catalog).provider, 'codemaker')
  assert.equal(pure.resolveRoute(null, catalog).provider, 'codemaker')
  assert.equal(pure.resolveRoute({ next: null, lastUsed: null }, null), null)
})

test('pure: routeSourceKey classifies explicit / reused / default', () => {
  const env = boot()
  const pure = env.window.__cpl.pure
  const next = { provider: 'ark', model: 'm' }
  assert.equal(pure.routeSourceKey({ next, lastUsed: null }, next), 'source.explicit')
  assert.equal(pure.routeSourceKey({ next, lastUsed: next }, next), 'source.reused')
  assert.equal(pure.routeSourceKey({ next: null, lastUsed: null }, null), 'source.default')
  assert.equal(pure.routeSourceKey(null, { provider: 'ark' }), 'source.default')
})

test('pure: client built-in alias map matches the node half', async () => {
  const env = boot()
  assert.deepEqual(env.window.__cpl.pure.BUILTIN_ALIASES, BUILTIN)
  const node = await import('../src/index.js')
  assert.deepEqual(node.BUILTIN_ALIASES, BUILTIN)
  assert.equal(node.NS, SETTINGS_NS)
  assert.deepEqual(node.inject, [])
})

// --- node half ---------------------------------------------------------------

test('node half apply never throws when settings is absent', async () => {
  const node = await import('../src/index.js')
  let called = false
  const ctx = { inject: (names, fn) => { called = true; fn({}) } }
  assert.doesNotThrow(() => node.apply(ctx))
  assert.equal(called, true, 'the lazy settings inject was registered')
})

test('node half installs nothing when settings lacks installSection', async () => {
  const node = await import('../src/index.js')
  let registered = 0
  const ctx = { inject: (_names, fn) => fn({ settings: { register: () => { registered += 1 } } }) }
  assert.doesNotThrow(() => node.apply(ctx))
  assert.equal(registered, 0, 'only installSection (not register) may be used')
})

// --- picker: entry, panes and the whitelisted write --------------------------

const STORE_KEY = 'dsh.composer-provider-label.v1'

/** Boot a picker-ready environment: a catalog, a recording selectModel, storage. */
function pickerBoot(extra = {}) {
  const writes = []
  const catalogCalls = { count: 0 }
  const remote = {
    session: {
      modelCatalog: async () => {
        catalogCalls.count += 1
        if (extra.failCatalog) return { ok: false, error: { code: 'catalog-down', message: 'catalog down' } }
        return { ok: true, value: extra.catalog ? extra.catalog() : catalogOf() }
      },
      selectModel: async (request) => {
        writes.push(request)
        return extra.selectModel ? extra.selectModel(request) : { ok: true, value: { selected: request } }
      },
    },
  }
  const env = boot({ remote, sessions: extra.sessions, storage: extra.storage })
  env.writes = writes
  env.catalogCalls = catalogCalls
  return env
}

/** Render, settle the catalog, then click the entry open; returns the open tree. */
async function openPicker(env, projection = projectionOf(SESS), sessionId = 's1') {
  env.render(compProps(sessionId, projection))
  await env.flush()
  let tree = env.rerender(compProps(sessionId, projection))
  clickEntry(tree)
  tree = env.rerender(compProps(sessionId, projection))
  return tree
}

test('picker: the entry is a menu button and opening it writes nothing', async () => {
  const env = pickerBoot()
  const tree = await openPicker(env)
  const button = buttonOf(tree)
  assert.equal(button.type, 'button')
  assert.equal(button.props['aria-haspopup'], 'menu')
  assert.equal(button.props['aria-expanded'], true)
  assert.ok(menuProps(tree).open)
  assert.deepEqual(env.writes, [], 'opening the picker is read-only')
})

test('entry chrome: the entry is the same 28px pill chip as the model seat next door', async () => {
  const env = pickerBoot()
  const tree = await openPicker(env)
  const style = buttonOf(tree).props.style
  assert.equal(style.height, '28px', 'same height as the core model trigger')
  assert.equal(style.borderRadius, '24px', 'pill radius, like the core model trigger')
  assert.equal(style.padding, '0 10px', 'one step wider than the trigger 8px side pad')
  assert.equal(style.boxSizing, 'border-box', "the ellipsis cap still measures the whole chip")
  assert.equal(style.background, 'var(--dsw-alias-interactive-bg-hover-solid)', 'dark chip when no theme repaints it')
  assert.equal(style.maxWidth, '11em', 'the narrow-window cap is unchanged')
})

test('entry chrome: the degraded read-only label keeps the identical chip', async () => {
  const env = boot({
    withMenu: false,
    remote: { session: { modelCatalog: async () => ({ ok: true, value: catalogOf() }) } },
  })
  env.render(compProps('s1', projectionOf(SESS)))
  await env.flush()
  const tree = env.rerender(compProps('s1', projectionOf(SESS)))
  const style = anchorOf(tree).props.children.props.style
  assert.equal(style.height, '28px')
  assert.equal(style.borderRadius, '24px')
  assert.equal(style.padding, '0 10px')
})

test('picker: root pane shows the provider and model rows with their current values', async () => {
  const env = pickerBoot()
  const tree = await openPicker(env)
  const providerRow = itemById(tree, 'provider')
  const modelRow = itemById(tree, 'model')
  assert.ok(providerRow && modelRow)
  assert.match(textOf(providerRow.label), /提供方/)
  assert.match(textOf(providerRow.label), /ARK/)
  assert.match(textOf(modelRow.label), /模型/)
  assert.match(textOf(modelRow.label), /DeepSeek-V4-Flash/)
})

test('picker: provider pane lists advertised providers in catalog order', async () => {
  const env = pickerBoot()
  let tree = await openPicker(env)
  selectItem(tree, 'provider')
  tree = env.rerender(compProps('s1', projectionOf(SESS)))
  const ids = itemsOf(tree).map((entry) => entry.id).filter((id) => id.startsWith('provider:'))
  assert.deepEqual(ids, [
    'provider:deepseek-official', 'provider:ark', 'provider:codemaker', 'provider:bai', 'provider:openroputer',
  ])
  const ark = itemById(tree, 'provider:ark')
  assert.match(textOf(ark.label), /ARK/)
  assert.match(textOf(ark.label), /ARK \(Coding Plan\)/)
  assert.ok(menuProps(tree).selectedIds.includes('provider:ark'), 'current provider is marked')
})

test('picker: failed providers are disabled and carry their failure text', async () => {
  const env = pickerBoot({
    catalog: () => catalogOf({
      groups: catalogOf().groups.filter((group) => group.id !== 'bai'),
      failures: [{ id: 'bai', name: 'B.AI', message: 'no key' }],
    }),
  })
  let tree = await openPicker(env)
  selectItem(tree, 'provider')
  tree = env.rerender(compProps('s1', projectionOf(SESS)))
  const row = itemById(tree, 'provider:bai')
  assert.equal(row.disabled, true)
  assert.match(textOf(row.label), /加载失败: no key/)
})

test('picker: an unadvertised current provider gets a synthetic top row', async () => {
  const env = pickerBoot()
  const route = { provider: 'ghost-router', model: 'x' }
  let tree = await openPicker(env, projectionOf(route))
  selectItem(tree, 'provider')
  tree = env.rerender(compProps('s1', projectionOf(route)))
  const rows = itemsOf(tree).filter((entry) => entry.id.startsWith('provider:'))
  assert.equal(rows[0].id, 'provider:ghost-router')
  assert.match(textOf(rows[0].label), /当前路由/)
})

test('picker: choosing another provider writes the profile default when it belongs there', async () => {
  const env = pickerBoot({
    catalog: () => catalogOf({
      default: { provider: 'bai', model: 'bai-model' },
      groups: [
        { id: 'ark', name: 'ARK', models: [{ id: 'ark-model', name: 'Ark Model' }] },
        { id: 'bai', name: 'B.AI', models: [{ id: 'bai-model', name: 'Bai Model' }, { id: 'bai-2', name: 'Bai Two' }] },
      ],
    }),
  })
  const route = { provider: 'ark', model: 'ark-model' }
  let tree = await openPicker(env, projectionOf(route))
  selectItem(tree, 'provider')
  tree = env.rerender(compProps('s1', projectionOf(route)))
  selectItem(tree, 'provider:bai')
  await env.flush()
  assert.deepEqual(env.writes, [{ sessionId: 's1', provider: 'bai', model: 'bai-model' }])
})

test('picker: choosing another provider without a default there writes its first model', async () => {
  const env = pickerBoot({
    catalog: () => catalogOf({
      default: { provider: 'ark', model: 'ark-model' },
      groups: [
        { id: 'ark', name: 'ARK', models: [{ id: 'ark-model', name: 'Ark Model' }] },
        { id: 'bai', name: 'B.AI', models: [{ id: 'bai-first', name: 'Bai First' }, { id: 'bai-second', name: 'Bai Second' }] },
      ],
    }),
  })
  const route = { provider: 'ark', model: 'ark-model' }
  let tree = await openPicker(env, projectionOf(route))
  selectItem(tree, 'provider')
  tree = env.rerender(compProps('s1', projectionOf(route)))
  selectItem(tree, 'provider:bai')
  await env.flush()
  assert.deepEqual(env.writes, [{ sessionId: 's1', provider: 'bai', model: 'bai-first' }])
})

test('picker: choosing the same provider keeps the current model', async () => {
  const env = pickerBoot({
    catalog: () => catalogOf({
      default: { provider: 'codemaker', model: 'deepseek-v4-flash' },
      groups: [
        { id: 'ark', name: 'ARK', models: [{ id: 'ark-one', name: 'Ark One' }, { id: 'ark-two', name: 'Ark Two' }] },
      ],
    }),
  })
  const route = { provider: 'ark', model: 'ark-two' }
  let tree = await openPicker(env, projectionOf(route))
  selectItem(tree, 'provider')
  tree = env.rerender(compProps('s1', projectionOf(route)))
  selectItem(tree, 'provider:ark')
  await env.flush()
  assert.deepEqual(env.writes, [{ sessionId: 's1', provider: 'ark', model: 'ark-two' }])
})

test('picker: choosing a provider auto-enters the model pane', async () => {
  const env = pickerBoot({
    catalog: () => catalogOf({
      default: { provider: 'ark', model: 'ark-model' },
      groups: [
        { id: 'ark', name: 'ARK', models: [{ id: 'ark-model', name: 'Ark Model' }] },
        { id: 'bai', name: 'B.AI', models: [{ id: 'bai-model', name: 'Bai Model' }] },
      ],
    }),
  })
  const route = { provider: 'ark', model: 'ark-model' }
  let tree = await openPicker(env, projectionOf(route))
  selectItem(tree, 'provider')
  tree = env.rerender(compProps('s1', projectionOf(route)))
  selectItem(tree, 'provider:bai')
  await env.flush()
  tree = env.rerender(compProps('s1', projectionOf(route)))
  assert.ok(itemById(tree, 'model:bai:bai-model'), 'the model pane is showing')
  assert.ok(!itemById(tree, 'provider:bai'), 'the provider pane is left behind')
})

test('picker: choosing a provider keeps an effort the new model still supports', async () => {
  const env = pickerBoot({
    catalog: () => catalogOf({
      default: { provider: 'ark', model: 'ark-high' },
      groups: [
        { id: 'ark', name: 'ARK', models: [{ id: 'ark-high', name: 'Ark High', reasoning: { efforts: [{ id: 'high', name: 'High' }], defaultEffort: 'high' } }] },
        { id: 'bai', name: 'B.AI', models: [{ id: 'bai-high', name: 'Bai High', reasoning: { efforts: [{ id: 'high', name: 'High' }] } }] },
      ],
    }),
  })
  const route = { provider: 'ark', model: 'ark-high', reasoningEffort: 'high' }
  let tree = await openPicker(env, projectionOf(route))
  selectItem(tree, 'provider')
  tree = env.rerender(compProps('s1', projectionOf(route)))
  selectItem(tree, 'provider:bai')
  await env.flush()
  assert.deepEqual(env.writes, [{ sessionId: 's1', provider: 'bai', model: 'bai-high', reasoningEffort: 'high' }])
})

test('picker: choosing a provider drops an effort the new model does not support', async () => {
  const env = pickerBoot({
    catalog: () => catalogOf({
      default: { provider: 'ark', model: 'ark-high' },
      groups: [
        { id: 'ark', name: 'ARK', models: [{ id: 'ark-high', name: 'Ark High', reasoning: { efforts: [{ id: 'high', name: 'High' }, { id: 'low', name: 'Low' }] } }] },
        { id: 'bai', name: 'B.AI', models: [{ id: 'bai-plain', name: 'Bai Plain' }] },
      ],
    }),
  })
  const route = { provider: 'ark', model: 'ark-high', reasoningEffort: 'low' }
  let tree = await openPicker(env, projectionOf(route))
  selectItem(tree, 'provider')
  tree = env.rerender(compProps('s1', projectionOf(route)))
  selectItem(tree, 'provider:bai')
  await env.flush()
  assert.deepEqual(env.writes, [{ sessionId: 's1', provider: 'bai', model: 'bai-plain' }])
})

test('picker: model pane in "all" scope groups by provider with headings', async () => {
  const env = pickerBoot()
  let tree = await openPicker(env)
  selectItem(tree, 'model')
  tree = env.rerender(compProps('s1', projectionOf(SESS)))
  const headings = itemsOf(tree).filter((entry) => entry.type === 'label')
  assert.ok(headings.length >= 4, 'one heading per advertised provider')
  assert.match(headings[0].text, /office · DeepSeek/)
  const item = itemById(tree, 'model:ark:deepseek-v4-flash')
  assert.ok(item)
  assert.match(textOf(item.label), /DeepSeek-V4-Flash/)
  assert.ok(menuProps(tree).selectedIds.includes('model:ark:deepseek-v4-flash'))
})

test('picker: model pane in "provider" scope lists only that provider, no headings', async () => {
  const env = pickerBoot({ storage: makeStorage({ [STORE_KEY]: JSON.stringify({ scope: 'provider' }) }) })
  let tree = await openPicker(env)
  selectItem(tree, 'model')
  tree = env.rerender(compProps('s1', projectionOf(SESS)))
  assert.deepEqual(itemsOf(tree).filter((entry) => entry.type === 'label'), [])
  const modelIds = itemsOf(tree).filter((entry) => entry.id.startsWith('model:')).map((entry) => entry.id)
  assert.deepEqual(modelIds, ['model:ark:deepseek-v4-flash'])
})

test('picker: the scope toggle persists and is restored on the next mount', async () => {
  const storage = makeStorage()
  const env = pickerBoot({ storage })
  let tree = await openPicker(env)
  assert.ok(footerOf(tree).some((entry) => entry.id === 'scope:all'))
  assert.ok(footerOf(tree).some((entry) => entry.id === 'scope:provider'))
  assert.ok(menuProps(tree).selectedIds.includes('scope:all'))
  selectItem(tree, 'scope:provider')
  tree = env.rerender(compProps('s1', projectionOf(SESS)))
  assert.deepEqual(JSON.parse(storage.getItem(STORE_KEY)), { scope: 'provider' })
  assert.ok(menuProps(tree).selectedIds.includes('scope:provider'))
  assert.deepEqual(env.writes, [], 'the scope toggle never writes a selection')

  const second = pickerBoot({ storage })
  const secondTree = await openPicker(second)
  assert.ok(menuProps(secondTree).selectedIds.includes('scope:provider'), 'preference restored')
})

test('picker: "provider" scope with no models shows the empty state and a switch-back', async () => {
  const env = pickerBoot({
    catalog: () => catalogOf({ groups: [{ id: 'ark', name: 'ARK', models: [] }] }),
    storage: makeStorage({ [STORE_KEY]: JSON.stringify({ scope: 'provider' }) }),
  })
  let tree = await openPicker(env)
  selectItem(tree, 'model')
  tree = env.rerender(compProps('s1', projectionOf(SESS)))
  const empty = itemById(tree, 'empty')
  assert.ok(empty)
  assert.equal(empty.disabled, true)
  assert.match(textOf(empty.label), /该提供方暂无可用模型/)
  const switchBack = itemById(tree, 'scope:all')
  assert.ok(switchBack, 'a one-click switch back to all providers')
  selectItem(tree, 'scope:all')
  tree = env.rerender(compProps('s1', projectionOf(SESS)))
  assert.ok(menuProps(tree).selectedIds.includes('scope:all'))
})

test('picker: choosing a model writes the pair and closes the menu', async () => {
  const env = pickerBoot()
  let tree = await openPicker(env)
  selectItem(tree, 'model')
  tree = env.rerender(compProps('s1', projectionOf(SESS)))
  selectItem(tree, 'model:codemaker:deepseek-v4-flash')
  await env.flush()
  assert.deepEqual(env.writes, [{ sessionId: 's1', provider: 'codemaker', model: 'deepseek-v4-flash' }])
  tree = env.rerender(compProps('s1', projectionOf(SESS)))
  assert.equal(menuProps(tree).open, false, 'the menu closed after a successful write')
})

test('picker: the entry reports busy while a write is in flight', async () => {
  let release
  const env = pickerBoot({
    selectModel: () => new Promise((resolve) => { release = () => resolve({ ok: true, value: {} }) }),
  })
  let tree = await openPicker(env)
  selectItem(tree, 'model')
  tree = env.rerender(compProps('s1', projectionOf(SESS)))
  selectItem(tree, 'model:codemaker:deepseek-v4-flash')
  await env.flush()
  tree = env.rerender(compProps('s1', projectionOf(SESS)))
  assert.equal(buttonOf(tree).props['aria-busy'], true)
  assert.equal(typeof release, 'function', 'the write reached the session remote')
  release()
  await env.flush()
  tree = env.rerender(compProps('s1', projectionOf(SESS)))
  assert.equal(buttonOf(tree).props['aria-busy'], undefined)
})

test('picker: a rejected write shows the error indicator and keeps the route', async () => {
  const env = pickerBoot({
    selectModel: async () => ({ ok: false, error: { code: 'session/model-unavailable', message: 'no route' } }),
  })
  let tree = await openPicker(env)
  selectItem(tree, 'model')
  tree = env.rerender(compProps('s1', projectionOf(SESS)))
  selectItem(tree, 'model:codemaker:deepseek-v4-flash')
  await env.flush()
  tree = env.rerender(compProps('s1', projectionOf(SESS)))
  const label = labelOf(tree)
  assert.match(label.tooltip, /切换失败: session\/model-unavailable: no route/)
  assert.equal(label.text, 'ARK', 'the route did not change')
  const children = buttonOf(tree).props.children
  assert.ok(
    Array.isArray(children) && children.some((child) => child && child.props && child.props.style
      && child.props.style.background === 'var(--dsw-alias-state-error-primary)'),
    'an inline error indicator is rendered',
  )
})

test('picker: a subagent session disables selection rows and writes nothing', async () => {
  const env = pickerBoot({
    sessions: { subagentAddress: (id) => (id === 'sub-1' ? { sessionId: 'parent' } : undefined) },
  })
  let tree = await openPicker(env, projectionOf(SESS), 'sub-1')
  assert.ok(itemById(tree, 'unavailable'), 'the reason is stated')
  selectItem(tree, 'provider')
  tree = env.rerender(compProps('sub-1', projectionOf(SESS)))
  assert.equal(itemById(tree, 'provider:ark').disabled, true)
  selectItem(tree, 'provider:ark')
  await env.flush()
  assert.deepEqual(env.writes, [], 'a disabled row never writes')
})

test('picker: a catalog failure with a known route keeps the raw id and offers retry', async () => {
  const env = pickerBoot({ failCatalog: true })
  const route = { provider: 'ark', model: 'deepseek-v4-flash' }
  env.render(compProps('s1', projectionOf(route)))
  await env.flush()
  let tree = env.rerender(compProps('s1', projectionOf(route)))
  assert.equal(labelOf(tree).text, 'ark', 'falls back to the raw provider id')
  clickEntry(tree)
  tree = env.rerender(compProps('s1', projectionOf(route)))
  const retry = itemById(tree, 'retry')
  assert.ok(retry, 'the menu offers a retry row')
  assert.ok(!retry.disabled, 'the retry row is actionable')
  const before = env.catalogCalls.count
  selectItem(tree, 'retry')
  await env.flush()
  assert.ok(env.catalogCalls.count > before, 'retrying requests the catalog again')
})

test('picker: a catalog failure without a known route renders a retry entry', async () => {
  const env = pickerBoot({ failCatalog: true })
  env.render(compProps('s1', projectionOf(null, null)))
  await env.flush()
  const tree = env.rerender(compProps('s1', projectionOf(null, null)))
  const button = buttonOf(tree)
  assert.ok(button, 'an error-state entry appears')
  assert.equal(textOf(button), '!')
  const before = env.catalogCalls.count
  button.props.onClick()
  await env.flush()
  assert.ok(env.catalogCalls.count > before, 'the entry requests the catalog again')
})

test('picker: without the Menu primitive the entry degrades to the v1 read-only label', async () => {
  const env = boot({
    withMenu: false,
    remote: { session: { modelCatalog: async () => ({ ok: true, value: catalogOf() }) } },
  })
  env.render(compProps('s1', projectionOf(SESS)))
  await env.flush()
  const tree = env.rerender(compProps('s1', projectionOf(SESS)))
  assert.equal(menuOf(tree), null)
  assert.equal(buttonOf(tree), null, 'no interactive button without the primitive')
  const label = labelOf(tree)
  assert.equal(label.text, 'ARK')
  assert.match(label.tooltip, /ARK \(Coding Plan\)/)
})

test('pure: chooseSelection keeps, defaults, or takes the first model', () => {
  const env = boot()
  const pure = env.window.__cpl.pure
  const catalog = catalogOf({
    default: { provider: 'bai', model: 'b2' },
    groups: [
      { id: 'ark', name: 'ARK', models: [{ id: 'a1', name: 'A1' }, { id: 'a2', name: 'A2' }] },
      { id: 'bai', name: 'B.AI', models: [{ id: 'b1', name: 'B1' }, { id: 'b2', name: 'B2', reasoning: { efforts: [{ id: 'high', name: 'High' }] } }] },
    ],
  })
  assert.deepEqual(pure.chooseSelection('ark', { provider: 'ark', model: 'a2' }, catalog), { provider: 'ark', model: 'a2' })
  assert.deepEqual(pure.chooseSelection('bai', { provider: 'ark', model: 'a1' }, catalog), { provider: 'bai', model: 'b2' })
  assert.deepEqual(pure.chooseSelection('ark', { provider: 'bai', model: 'b2' }, catalog), { provider: 'ark', model: 'a1' })
  assert.deepEqual(
    pure.chooseSelection('bai', { provider: 'ark', model: 'a1', reasoningEffort: 'high' }, catalog),
    { provider: 'bai', model: 'b2', reasoningEffort: 'high' },
  )
  assert.deepEqual(
    pure.chooseSelection('bai', { provider: 'ark', model: 'a1', reasoningEffort: 'low' }, catalog),
    { provider: 'bai', model: 'b2' },
  )
  assert.equal(pure.chooseSelection('nope', { provider: 'ark', model: 'a1' }, catalog), null)
  assert.equal(pure.chooseSelection('ark', null, { groups: [{ id: 'ark', name: 'ARK', models: [] }] }), null)
})

test('pure: providerRows and modelRows shape the two levels', () => {
  const env = boot()
  const pure = env.window.__cpl.pure
  const catalog = catalogOf({
    failures: [{ id: 'bai', name: 'B.AI', message: 'boom' }],
    groups: [
      { id: 'ark', name: 'ARK', models: [{ id: 'a1', name: 'A1' }, { id: 'a2', name: 'A2' }] },
      { id: 'codemaker', name: 'codemaker', models: [{ id: 'c1', name: 'C1' }] },
    ],
  })
  const rows = pure.providerRows(catalog, 'ark', {})
  assert.deepEqual(rows.map((row) => row.id), ['ark', 'codemaker', 'bai'])
  assert.equal(rows[0].current, true)
  assert.equal(rows[2].disabled, true)
  assert.equal(rows[2].failure, 'boom')
  const withGhost = pure.providerRows(catalog, 'ghost', {})
  assert.equal(withGhost[0].id, 'ghost')
  assert.equal(withGhost[0].synthetic, true)

  const all = pure.modelRows(catalog, { provider: 'ark', model: 'a2' }, 'all', {})
  assert.deepEqual(all.filter((row) => row.kind === 'heading').map((row) => row.id), ['heading:ark', 'heading:codemaker'])
  assert.equal(all.find((row) => row.id === 'model:ark:a2').selected, true)
  const only = pure.modelRows(catalog, { provider: 'ark', model: 'a2' }, 'provider', {})
  assert.deepEqual(only.map((row) => row.id), ['model:ark:a1', 'model:ark:a2'])
})

test('pure: the scope helpers round-trip through storage and survive garbage', () => {
  const env = boot()
  const pure = env.window.__cpl.pure
  const storage = makeStorage()
  assert.equal(pure.readScope(storage), 'all')
  pure.writeScope(storage, 'provider')
  assert.deepEqual(JSON.parse(storage.getItem(pure.STORE_KEY)), { scope: 'provider' })
  assert.equal(pure.readScope(storage), 'provider')
  assert.equal(pure.parseScope('bogus'), 'all')
  assert.equal(pure.readScope({ getItem: () => 'not json' }), 'all')
  assert.equal(pure.readScope(null), 'all')
  assert.equal(pure.writeScope(null, 'provider'), undefined, 'a missing storage must not throw')
})

test('picker: the menu is scoped and long lists are height-capped instead of overflowing', async () => {
  const env = pickerBoot()
  const tree = await openPicker(env)
  assert.equal(menuProps(tree).className, 'cpl-picker', 'the anchor wrapper carries our scope class')
  assert.equal(menuProps(tree).listClassName, 'cpl-picker-list', 'the card itself carries our style hook')
  assert.equal(env.styles.length, 1, 'exactly one stylesheet is injected')
  const sheet = env.styles[0]
  assert.equal(sheet.id, 'dsh-composer-provider-label-style')
  // Scoped to the card, not to a child of it: core renders a decorative material
  // backdrop as the card's first child, so a `> div:first-child` rule would paint
  // the cap onto the backdrop and leave the items area unbounded.
  assert.ok(sheet.textContent.includes('[role="menu"].cpl-picker-list'), 'selector is scoped to the card')
  assert.ok(!sheet.textContent.includes('first-child'), 'no rule reaches for the card first child')
  assert.match(sheet.textContent, /overflow-y: auto/)
  assert.match(sheet.textContent, /max-height: 342px/)
  env.rerender(compProps('s1', projectionOf(SESS)))
  env.rerender(compProps('s1', projectionOf(SESS)))
  assert.equal(env.styles.length, 1, 're-rendering never injects a second sheet')
})

test('pure: the list cap fits five dense rows plus the back row', () => {
  const env = boot()
  const pure = env.window.__cpl.pure
  // Row geometry of ui-primitives Menu.module.css at `dense: true`.
  const STACKED = 46 // 20px label + 2px gap + 16px detail + 2x4px padding
  const PLAIN = 30 // the back row, one dense line
  const SEPARATOR = 7
  const FOOTER = 67 // the pinned scope footer, always visible below the scroll area
  const PADDING = 8
  const FIVE = 5 * STACKED
  assert.equal(pure.LIST_VISIBLE_ROWS, 5)
  assert.ok(pure.LIST_MAX_HEIGHT >= FIVE + PLAIN + SEPARATOR, 'five model rows and the back row stay visible')
  assert.ok(pure.LIST_MAX_HEIGHT <= FIVE + PLAIN + SEPARATOR + FOOTER + PADDING, 'and the cap leaves no room for a sixth row')
  assert.equal(pure.LIST_CLASS, 'cpl-picker-list')
  assert.equal(pure.PICKER_CLASS, 'cpl-picker')
})
// --- capability audit (spec: write scope limited to model selection) --------

test('capability audit: the only state-changing call is session.selectModel', () => {
  const clientSource = fs.readFileSync(bundlePath, 'utf8')
  const nodeSource = fs.readFileSync(indexPath, 'utf8')
  // Whitelisted write: exactly one call site, inside the picker's write path.
  const codeOnly = clientSource.replace(/\/\*[\s\S]*?\*\//g, '').replace(/^\s*\/\/.*$/gm, '')
  const writeCalls = codeOnly.match(/\.selectModel\(/g) || []
  assert.equal(writeCalls.length, 1, 'exactly one selectModel call site')
  // Every other state-changing session remote stays forbidden.
  const forbidden = [
    'session/selectModel', 'updateQueue', 'prompt(', 'rename(',
    'fork(', 'create(', 'attachment(', 'cancel(', 'control(', 'rewind(', 'follow(',
  ]
  for (const token of forbidden) {
    assert.ok(!clientSource.includes(token), `client bundle must not reference state-changing "${token}"`)
    assert.ok(!nodeSource.includes(token), `node half must not reference state-changing "${token}"`)
  }
  // The only session remote it reads is the model catalog; the only settings
  // call is the read-only describe.
  assert.ok(clientSource.includes('modelCatalog'), 'client reads session.modelCatalog')
  assert.ok(clientSource.includes('describe'), 'client reads settings.describe')
  // Theme tokens only: no hardcoded colours.
  assert.ok(!/#[0-9a-fA-F]{3,8}/.test(clientSource), 'no hex colour literals')
  assert.ok(!clientSource.includes('rgb('), 'no rgb() colour literals')
  assert.ok(!clientSource.includes('hsl('), 'no hsl() colour literals')
  // Writes to settings (update/replace/mutate) are forbidden too.
  for (const token of ['settings.mutate', 'settings.update', 'settings.replace']) {
    assert.ok(!clientSource.includes(token), `client must not write settings via ${token}`)
  }
})

// --- run ---------------------------------------------------------------------

let failed = 0
for (const [name, fn] of tests) {
  try {
    await fn()
    console.log(`  ok   ${name}`)
  } catch (error) {
    failed += 1
    console.log(`  FAIL ${name}\n       ${error && error.stack ? error.stack.split('\n').slice(0, 4).join('\n       ') : error}`)
  }
}
console.log(failed === 0 ? `\n${tests.length}/${tests.length} passed` : `\n${failed}/${tests.length} FAILED`)
process.exit(failed === 0 ? 0 : 1)
