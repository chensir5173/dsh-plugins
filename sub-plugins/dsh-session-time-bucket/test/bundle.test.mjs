// Behavioural harness for dsh-session-time-bucket/src/client.js.
//
// WHY THIS EXISTS
// The plugin is a browser classic-script bundle with no build step, so it
// cannot be imported normally, and the profile has no jsdom. This harness
// materializes the bundle the way @deepseek-ai/dsh-client-modules does —
// window.__ModuleLoader__.load({id, factory}) then factory(require) — with
// the window.__DSH_TEST__ hook enabled, and asserts the pure projection
// logic (calendar bucket boundaries, visibility filtering, workspace-title
// prefix, empty-bucket hiding, bucket ordering, locale copy) plus the
// bundle contract. DOM mounting itself is left to ACCEPTANCE.md.
//
// Run: node dsh-session-time-bucket/test/bundle.test.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import path from 'node:path'
import { fileURLToPath } from 'node:url'

const here = path.dirname(fileURLToPath(import.meta.url))
const bundlePath = path.join(here, '..', 'src', 'client.js')
const PKG_ID = 'dsh-session-time-bucket'

// --- browser-ish globals ------------------------------------------------

Object.defineProperty(globalThis, 'navigator', {
  configurable: true,
  value: { languages: ['zh-CN'], language: 'zh-CN' },
})

const factories = new Map()
globalThis.window = {
  __ModuleLoader__: { load: ({ id, factory }) => factories.set(id, factory) },
  __DSH_TEST__: true,
  addEventListener() {},
  removeEventListener() {},
  setInterval: () => 1,
  clearInterval() {},
}
globalThis.document = {
  createElement: () => ({ style: {}, setAttribute() {}, appendChild() {} }),
  createTextNode: () => ({}),
  querySelector: () => null,
  querySelectorAll: () => [],
  addEventListener() {},
  removeEventListener() {},
  body: { appendChild() {} },
}

// localStorage stub: the follower reads the core's persisted view store.
const storage = new Map()
globalThis.window.localStorage = {
  getItem: (key) => (storage.has(key) ? storage.get(key) : null),
  setItem: (key, value) => { storage.set(key, String(value)) },
  removeItem: (key) => { storage.delete(key) },
}

// --- load the bundle ----------------------------------------------------

const source = fs.readFileSync(bundlePath, 'utf8')
// eslint-disable-next-line no-new-func -- mirroring the browser classic-script evaluation
new Function('window', 'navigator', 'document', source)(globalThis.window, globalThis.navigator, globalThis.document)

const tests = []
const test = (name, fn) => tests.push([name, fn])

const factory = factories.get(PKG_ID)
assert.ok(factory, `bundle did not register id "${PKG_ID}"`)
// This plugin requires nothing from the module loader (no React, no primitives).
const exports = factory(() => { throw new Error('unexpected require()') })
const hooks = globalThis.window.__sessionTimeBucketTest
assert.ok(hooks, 'window.__DSH_TEST__ hook object missing')

const { bucketKeyOf, bucketTimeOf, collectRows, rowTitle, wsPrefixText, sortRowsByRecency, matchRowTitles, planBuckets, deriveBuckets, relativeLabel, readDomRows, workspaceTitleBySession, isFlatUpdatedView, __t, enDict } = hooks
const DAY = 86400000
// Fixed local "now": 2026-09-06 12:00 (Sep 6 is a Sunday; weekday is irrelevant).
const nowMs = new Date(2026, 8, 6, 12, 0, 0).getTime()
const startToday = new Date(2026, 8, 6).getTime()

// --- assertions ----------------------------------------------------------

test('bundle registers under the package id and declares only slots', () => {
  assert.deepEqual(exports.inject, ['slots'])
  assert.equal(typeof exports.apply, 'function')
})

test('calendar bucket boundaries (local natural days)', () => {
  // today: [startToday, +inf)
  assert.equal(bucketKeyOf(startToday, nowMs), 'today')
  assert.equal(bucketKeyOf(startToday + 2 * 3600 * 1000, nowMs), 'today')
  // yesterday: [startToday-1d, startToday)
  assert.equal(bucketKeyOf(startToday - 1, nowMs), 'yesterday')
  assert.equal(bucketKeyOf(startToday - DAY + 3 * 3600 * 1000, nowMs), 'yesterday')
  // last7: [startToday-7d, startToday-1d)
  assert.equal(bucketKeyOf(startToday - 3 * DAY, nowMs), 'last7')
  assert.equal(bucketKeyOf(startToday - 6 * DAY, nowMs), 'last7')
  assert.equal(bucketKeyOf(startToday - DAY - 1, nowMs), 'last7')
  // last30: [startToday-30d, startToday-7d)
  assert.equal(bucketKeyOf(startToday - 7 * DAY - 1, nowMs), 'last30')
  assert.equal(bucketKeyOf(startToday - 29 * DAY, nowMs), 'last30')
  // older
  assert.equal(bucketKeyOf(startToday - 30 * DAY - 1, nowMs), 'older')
  assert.equal(bucketKeyOf(startToday - 400 * DAY, nowMs), 'older')
})

test('startOfLocalDay is DST/midnight-safe for the reference instant', () => {
  assert.equal(hooks.startOfLocalDay(startToday + 12 * 3600 * 1000), startToday)
})

test('workspaceTitleBySession maps membership to titles', () => {
  const items = [
    { workspaceId: 'w1', title: 'dsh-tmp', sessionIds: ['a', 'b'] },
    { workspaceId: 'w2', title: 'repo', sessionIds: ['c'] },
  ]
  const map = workspaceTitleBySession(items)
  assert.equal(map.a, 'dsh-tmp')
  assert.equal(map.b, 'dsh-tmp')
  assert.equal(map.c, 'repo')
  assert.equal(map.z, undefined)
})

test('collectRows applies core-equivalent visibility', () => {
  const byId = {
    a: { id: 'a', displayTitle: '会话A', title: '会话A', updatedAt: nowMs, blank: false },
    b: { id: 'b', displayTitle: '子代理', updatedAt: nowMs, origin: 'subagent', blank: false },
    c: { id: 'c', displayTitle: '别的空白', updatedAt: nowMs, blank: true },
    d: { id: 'd', displayTitle: '当前空白', updatedAt: nowMs, blank: true },
    e: { id: 'e', displayTitle: '已归档', updatedAt: nowMs, blank: false },
    f: { id: 'f', displayTitle: '', title: '', updatedAt: nowMs, blank: false },
    g: { id: 'g', displayTitle: '运行中', title: '运行中', updatedAt: nowMs, blank: false, running: true },
    h: { id: 'h', displayTitle: '已完成', title: '已完成', updatedAt: nowMs, blank: false, completed: true },
    // No `title` key at all: core >= 0.2.0-rc.2 renders 未命名 while the
    // snapshot displayTitle still names the workspace directory.
    i: { id: 'i', displayTitle: 'dsh-tmp', updatedAt: nowMs, blank: false },
  }
  const list = { byId, current: 'd' }
  const rows = collectRows(list, ['e'], workspaceTitleBySession([{ workspaceId: 'w', title: 'ws-a', sessionIds: ['a'] }]))
  const ids = rows.map((row) => row.id).sort()
  assert.deepEqual(ids, ['a', 'd', 'f', 'g', 'h', 'i'])
  const a = rows.find((row) => row.id === 'a')
  const d = rows.find((row) => row.id === 'd')
  assert.equal(a.wsTitle, 'ws-a')
  assert.equal(a.blank, false)
  assert.equal(a.current, false)
  assert.equal(d.blank, true)
  assert.equal(d.current, true)
  assert.equal(d.wsTitle, undefined)
  const f = rows.find((row) => row.id === 'f')
  assert.equal(f.title, '')
  assert.equal(f.untitled, true)
  const i = rows.find((row) => row.id === 'i')
  // Display keeps the directory-name fallback; the flag drives DOM matching.
  assert.equal(i.title, 'dsh-tmp')
  assert.equal(i.untitled, true)
  assert.equal(a.untitled, false)
  assert.equal(d.untitled, false)
  const g = rows.find((row) => row.id === 'g')
  assert.equal(g.running, true)
  assert.equal(g.completed, false)
  const h = rows.find((row) => row.id === 'h')
  assert.equal(h.running, false)
  assert.equal(h.completed, true)
})

test('rowTitle prefixes workspace / ungrouped and honors the switch', () => {
  const plain = { blank: false, title: '写插件', wsTitle: 'dsh-tmp' }
  assert.equal(rowTitle(plain, true, '未分组'), '[dsh-tmp] 写插件')
  assert.equal(rowTitle({ ...plain, wsTitle: undefined }, true, '未分组'), '[未分组] 写插件')
  assert.equal(rowTitle({ ...plain, wsTitle: '' }, true, '未分组'), '[未分组] 写插件')
  assert.equal(rowTitle(plain, false, '未分组'), '写插件')
  assert.equal(rowTitle({ ...plain, blank: true }, true, '未分组'), '')
})

test('deriveBuckets groups, sorts newest-first and hides empty buckets', () => {
  const mk = (id, updatedAt, extra) => ({ id, title: id, updatedAt, blank: false, wsTitle: undefined, current: false, ...extra })
  const rows = [
    mk('o', startToday - 40 * DAY),                 // older
    mk('d', startToday - 3 * DAY + 1000),           // last7
    mk('y', startToday - 1),                        // yesterday
    mk('t1', startToday + 3600 * 1000),             // today (older of the two)
    mk('t2', startToday + 7200 * 1000),             // today (newest)
    // no last30 row on purpose
  ]
  const buckets = deriveBuckets(rows, nowMs)
  assert.deepEqual(buckets.map((b) => b.key), ['today', 'yesterday', 'last7', 'older'])
  assert.deepEqual(buckets[0].rows.map((r) => r.id), ['t2', 't1'])
  assert.deepEqual(buckets[1].rows.map((r) => r.id), ['y'])
  assert.deepEqual(buckets[2].rows.map((r) => r.id), ['d'])
  assert.deepEqual(buckets[3].rows.map((r) => r.id), ['o'])
})

test('current blank New Session is pinned to today (reused stale blanks land under 今天)', () => {
  // Core reuses a workspace's still-blank session for 新会话 and keeps its old
  // updatedAt; the only blank row the list shows is the current one, so the
  // plugin buckets it as "now" while the user is editing it.
  const mk = (id, updatedAt, extra) => ({ id, title: id, updatedAt, blank: false, wsTitle: undefined, current: false, ...extra })
  const stale = mk('blank-cur', startToday - 3 * DAY, { blank: true, current: true })
  const staleOther = mk('blank-old', startToday - 3 * DAY, { blank: true, current: false })
  const ordinaryOld = mk('old', startToday - 2 * DAY, {})

  // bucketTimeOf: only blank && current is pinned to now; everything else keeps
  // its real updatedAt.
  assert.equal(bucketTimeOf(stale, nowMs), nowMs)
  assert.equal(bucketTimeOf(staleOther, nowMs), startToday - 3 * DAY)
  assert.equal(bucketTimeOf(ordinaryOld, nowMs), startToday - 2 * DAY)
  assert.equal(bucketTimeOf(null, nowMs), 0)

  // deriveBuckets: the current blank row joins 今天 and sorts newest-first even
  // though its stored updatedAt is three days old; other stale blanks keep
  // their own bucket.
  const buckets = deriveBuckets([stale, ordinaryOld, staleOther], nowMs)
  assert.deepEqual(buckets.map((b) => b.key), ['today', 'last7'])
  assert.deepEqual(buckets[0].rows.map((r) => r.id), ['blank-cur'])
  assert.deepEqual(buckets[1].rows.map((r) => r.id).sort(), ['blank-old', 'old'])

  // collectRows still reports the real updatedAt: pinning is a display-layer
  // decision (row identity / core-order matching keep the true timestamp).
  const list = { byId: { [stale.id]: { id: stale.id, displayTitle: '', updatedAt: stale.updatedAt, blank: true } }, current: stale.id }
  const rows = collectRows(list, [], {})
  assert.equal(rows[0].updatedAt, stale.updatedAt)
  assert.equal(rows[0].blank, true)
  assert.equal(rows[0].current, true)
})

test('follows the core view store: enhances only 单列表+最近更新', () => {
  const view = (groupBy, orderBy) => storage.set('dsh.workspace.view.v5', JSON.stringify({ groupBy, orderBy }))
  view('flat', 'updated')
  assert.equal(isFlatUpdatedView(), true)
  view('workspace', 'updated')
  assert.equal(isFlatUpdatedView(), false)
  view('flat', 'manual')
  assert.equal(isFlatUpdatedView(), false)
  view('workspace', 'manual')
  assert.equal(isFlatUpdatedView(), false)
  storage.delete('dsh.workspace.view.v5')
  assert.equal(isFlatUpdatedView(), false)
  storage.set('dsh.workspace.view.v5', '{broken')
  assert.equal(isFlatUpdatedView(), false)
  storage.delete('dsh.workspace.view.v5')
})

test('zh copy resolves and en dictionary exists', () => {
  assert.equal(__t('bucket.today'), '今天')
  assert.equal(__t('bucket.yesterday'), '昨天')
  assert.equal(__t('bucket.last7'), '前7天')
  assert.equal(__t('bucket.last30'), '前30天')
  assert.equal(__t('bucket.older'), '更早')
  assert.equal(__t('ungrouped'), '未分组')
  assert.equal(enDict['bucket.today'], 'Today')
  assert.equal(enDict['ungrouped'], 'Ungrouped')
})

test('relative time labels humanize instants', () => {
  const at = (delta) => relativeLabel(nowMs - delta, nowMs, __t)
  assert.equal(at(5 * 1000), '刚刚')
  assert.equal(at(2 * 60 * 1000), '2分钟前')
  assert.equal(at(3 * 3600 * 1000), '3小时前')
  assert.equal(at(2 * DAY), '2天前')
  assert.equal(at(40 * DAY), '1个月前')
  assert.equal(at(400 * DAY), '1年前')
  assert.equal(__t('rel.day'), '{n}天前')
})

test('wsPrefixText: [工作区] / [未分组] prefix, none for blank rows', () => {
  const plain = { blank: false, title: '写插件', wsTitle: 'dsh-tmp' }
  assert.equal(wsPrefixText(plain, '未分组'), '[dsh-tmp] ')
  assert.equal(wsPrefixText({ ...plain, wsTitle: undefined }, '未分组'), '[未分组] ')
  assert.equal(wsPrefixText({ ...plain, wsTitle: '' }, '未分组'), '[未分组] ')
  assert.equal(wsPrefixText({ ...plain, blank: true }, '未分组'), '')
})

test('sortRowsByRecency orders newest-first with a stable id tiebreak', () => {
  const mk = (id, updatedAt) => ({ id, updatedAt })
  const rows = [mk('a', 1000), mk('b', 5000), mk('c', 3000), mk('d', 5000)]
  assert.deepEqual(sortRowsByRecency(rows).map((r) => r.id), ['b', 'd', 'c', 'a'])
  assert.deepEqual(rows.map((r) => r.id), ['a', 'b', 'c', 'd'], 'input not mutated')
})

test('matchRowTitles aligns DOM order to recency order, incl. duplicates and blanks', () => {
  const mk = (id, title, updatedAt, extra) => ({ id, title, updatedAt, blank: false, ...extra })
  const rows = sortRowsByRecency([
    mk('new', '分享链接', 9000),
    mk('t2', '写插件', 5000),
    mk('t1', '写插件', 4000),
    mk('b', '', 3000, { blank: true }),
  ])
  const domTitles = ['写插件', '写插件', '新会话', '分享链接']
  const mapped = matchRowTitles(domTitles, rows, '新会话')
  assert.deepEqual(mapped.map((r) => (r ? r.id : null)), ['t2', 't1', 'b', 'new'])
  // Unknown title -> null (row stays unenhanced), used ids never reassigned.
  assert.deepEqual(matchRowTitles(['不存在', '写插件'], rows, '新会话').map((r) => (r ? r.id : null)), [null, 't2'])
})

test('untitled rows match the core Untitled label, not the directory name', () => {
  // Regression for the duplicated bucket headers in desktop 0.2.0-rc2: the
  // snapshot displayTitle of a titleless session is the workspace directory
  // name (dsh-tmp) while the core row renders 未命名, so every such row stayed
  // unmapped -> the partial-mapping path forked one header per bucket fragment.
  const mk = (id, title, updatedAt, extra) => ({ id, title, updatedAt, blank: false, ...extra })
  const rows = sortRowsByRecency([
    mk('u1', 'dsh-tmp', 5000, { untitled: true }),
    mk('named', '写插件', 4000),
    mk('u2', 'dsh-tmp', 3000, { untitled: true }),
  ])
  const domTitles = ['未命名', '写插件', '未命名']
  assert.deepEqual(
    matchRowTitles(domTitles, rows, '新会话', '未命名').map((r) => (r ? r.id : null)),
    ['u1', 'named', 'u2'],
  )
  // The English core renders Untitled; the label is whatever the core passes.
  assert.deepEqual(
    matchRowTitles(['Untitled', '写插件'], rows, 'New Session', 'Untitled').map((r) => (r ? r.id : null)),
    ['u1', 'named'],
  )
  // Without the core label the old behaviour is explicit: no mapping at all.
  assert.deepEqual(
    matchRowTitles(domTitles, rows, '新会话').map((r) => (r ? r.id : null)),
    [null, 'named', null],
  )
})

test('planBuckets groups contiguous render-order keys into fold runs', () => {
  assert.deepEqual(planBuckets(['today', 'today', 'yesterday', 'today', null, 'older', 'older']), [
    { key: 'today', count: 2, index: 0 },
    { key: 'yesterday', count: 1, index: 2 },
    { key: 'today', count: 1, index: 3 },
    { key: 'older', count: 2, index: 5 },
  ])
  assert.deepEqual(planBuckets([]), [])
  assert.deepEqual(planBuckets([null, null]), [])
  // An unmapped row is a gap, not a boundary: it used to end the run and the
  // renderer then emitted one header per fragment (前7天 … 前7天 in the GUI).
  assert.deepEqual(planBuckets(['last7', null, 'last7', 'older']), [
    { key: 'last7', count: 2, index: 0 },
    { key: 'older', count: 1, index: 3 },
  ])
  assert.deepEqual(planBuckets([null, 'today', null, null, 'today']), [{ key: 'today', count: 2, index: 1 }])
  // A genuine key change still starts a new run, and the count only counts rows.
  assert.deepEqual(planBuckets(['today', null, 'older']), [
    { key: 'today', count: 1, index: 0 },
    { key: 'older', count: 1, index: 2 },
  ])
})

test('a gap in the row mapping cannot duplicate a bucket label end-to-end', () => {
  // The reported GUI symptom: 前7天 rendered twice because one unmapped row sat
  // between two rows of the same bucket. Replay the exact decision chain the
  // renderer runs (matched rows -> bucket keys -> fold runs -> header identities).
  const mk = (id, title, updatedAt, extra) => ({ id, title, updatedAt, blank: false, ...extra })
  const rows = sortRowsByRecency([
    mk('n1', '写插件', nowMs - 3600 * 1000),
    mk('n2', 'publish', startToday - 2 * DAY),
    mk('n3', 'dsh-tmp', startToday - 3 * DAY, { untitled: true }),
    mk('o1', '旧会话', startToday - 40 * DAY),
  ])
  const mapped = matchRowTitles(['写插件', 'publish', '未命名', '旧会话'], rows, '新会话', '未命名')
  assert.deepEqual(mapped.map((r) => (r ? r.id : null)), ['n1', 'n2', 'n3', 'o1'])
  const runs = planBuckets(mapped.map((r) => (r ? bucketKeyOf(bucketTimeOf(r, nowMs), nowMs) : null)))
  const identities = runs.map((run) => run.key)
  assert.deepEqual(identities, ['today', 'last7', 'older'])
  assert.deepEqual(runs.map((run) => run.count), [1, 2, 1])
  assert.equal(new Set(identities).size, identities.length, 'no bucket label repeats')
  // The guarded failure mode: ONE row lost to a title the plugin cannot read
  // (a mid-rename row here). Sitting between two 前7天 rows it used to end the
  // run, and the same label was then rendered twice.
  const partial = matchRowTitles(
    ['写插件', 'publish', '重命名中', '未命名', '旧会话'], rows, '新会话', '未命名',
  )
  assert.deepEqual(partial.map((r) => (r ? r.id : null)), ['n1', 'n2', null, 'n3', 'o1'])
  const partialRuns = planBuckets(partial.map((r) => (r ? bucketKeyOf(bucketTimeOf(r, nowMs), nowMs) : null)))
  assert.equal(new Set(partialRuns.map((run) => run.key)).size, partialRuns.length)
  assert.deepEqual(partialRuns.map((run) => [run.key, run.count]), [['today', 1], ['last7', 2], ['older', 1]])
})

test('readDomRows finds rows nested under React wrapper spans (live DOM shape)', () => {
  // Mirror the real flat tree: every row sits inside a hover-card wrapper
  // span, so role/class live on descendants — direct-children scanning must
  // not be required (regression: live GUI rendered zero rows and the
  // enhancement never appeared).
  const el = (props = {}) => {
    const node = {
      _cls: props.cls || '', _role: props.role || null,
      textContent: props.text || '',
      children: [],
      parentElement: null,
    }
    for (const child of props.children || []) {
      child.parentElement = node
      node.children.push(child)
    }
    node.className = node._cls
    node.getAttribute = (name) => (name === 'role' ? node._role : null)
    node.querySelectorAll = (sel) => {
      const hits = []
      const walk = (n) => {
        for (const c of n.children) {
          if (sel === '[role="treeitem"]' && c._role === 'treeitem') hits.push(c)
          walk(c)
        }
      }
      walk(node)
      return hits
    }
    node.querySelector = (sel) => {
      const hits = []
      const walk = (n) => {
        for (const c of n.children) {
          if (c._cls.indexOf((sel.match(/\*="([^"]+)"/) || [])[1] || '') >= 0) hits.push(c)
          walk(c)
        }
      }
      walk(node)
      return hits[0] || null
    }
    return node
  }
  const mkRow = (cls, title, extra) => {
    const titleEl = el({ cls: 'fPQ3ha_title', text: title })
    const kids = [titleEl]
    if (extra && extra.slot) kids.unshift(el({ cls: 'fPQ3ha_slot' }))
    return el({ cls: 'fPQ3ha_sessionRow' + cls, role: 'treeitem', children: kids })
  }
  const wrap = (row) => el({ cls: '_root_1b2ny_3', children: [row] })
  const rowA = mkRow('', '写插件', { slot: true })
  const rowB = mkRow(' fPQ3ha_flatSessionRowWithoutStatus', '看readme', {})
  const rowNoTitle = el({ cls: 'fPQ3ha_sessionRow', role: 'treeitem', children: [el({ cls: 'x' })] })
  const notARow = el({ cls: 'MV_2aq_empty', role: null })
  const tree = el({ children: [wrap(rowA), notARow, wrap(rowB), wrap(rowNoTitle)] })

  const rows = readDomRows(tree)
  assert.equal(rows.length, 2)
  assert.equal(rows[0].el, rowA)
  assert.equal(rows[0].wrapper, rowA.parentElement)
  assert.equal(rows[0].hasSlot, true)
  assert.equal(rows[0].titleText, '写插件')
  assert.equal(rows[1].el, rowB)
  assert.equal(rows[1].hasSlot, false)
  assert.equal(rows[1].titleText, '看readme')
})

let failed = 0
for (const [name, fn] of tests) {
  try { fn(); console.log('ok  -', name) }
  catch (error) { failed += 1; console.error('FAIL-', name); console.error(error) }
}
console.log(`\n${tests.length - failed}/${tests.length} assertions passed`)
if (failed > 0) process.exitCode = 1