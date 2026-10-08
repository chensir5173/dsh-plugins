// dsh-session-time-bucket: CLIENT half — the whole feature lives here.
//
// v3 — surgical enhancement on top of the OFFICIAL flat session list:
//   · Follow-the-core (unchanged): the plugin rides the core "单列表 + 最近更新"
//     view. It reads the workspace browser viewing store persisted under
//     localStorage key 'dsh.workspace.view.v5' ({ groupBy: 'flat',
//     orderBy: 'updated' }); only in that mode does it enhance the list.
//   · NO list replacement: the core list keeps rendering and stays visible.
//     The plugin only injects two kinds of nodes between/inside the official
//     rows — (1) a time-bucket group header (今天/昨天/前7天/前30天/更早)
//     directly above each bucket's first row, and (2) a [工作区] prefix span
//     right before each row's official title span. Rows are never moved,
//     re-parented or re-styled: hover cards, status dots, trailing time,
//     the ⋯ row actions (rename/fork/archive), click-to-open and drag & drop
//     all remain the core's own rendering and behavior.
//   · Why this is safe: React reconciles its children against its own fiber
//     record, never against the live DOM, and only touches nodes it created.
//     Injected nodes are invisible to it; when the core reorders rows (the
//     updated order ticks while sessions run) its insertBefore ops only move
//     its own rows. A MutationObserver re-anchors our headers immediately
//     after core mutations, so grouping stays coherent frame-by-frame.
//   · Group headers fold (chevron + persisted under 'dsh.sessionTimeBucket.v1');
//     folded rows are collapsed with display:none and restored on expand/exit.
//   · Rail (icon) sidebar, workspace-grouped view, manual ordering and search
//     never get enhanced — the watcher exits and removes every injected node.
//
// Data comes from two core client services (for bucketing + workspace names
// + row identity matching — never for rendering):
//   - sessions  -> list.getSnapshot() { ids, byId: {SessionSummary}, current }
//   - workspaces-> list.getSnapshot() { items: WorkspaceView[], ... }
//
// No React: plain DOM + inline styles + --dsw-* tokens. A 1s watcher re-checks
// the core view store; within the mode, subscriptions + a MutationObserver
// drive instant reconciles.
//
// Bundle format (client-modules protocol): classic script registering a
// factory via window.__ModuleLoader__.load({id, factory}); returns
// { apply, inject: ['slots'] }.
window.__ModuleLoader__.load({
  id: 'dsh-session-time-bucket',
  factory: (require) => {
    const NS = 'session-time-bucket'
    const STORE_KEY = 'dsh.sessionTimeBucket.v1'
    const CORE_VIEW_KEY = 'dsh.workspace.view.v5'
    const BUCKET_ORDER = ['today', 'yesterday', 'last7', 'last30', 'older']
    const DAY_MS = 86400000

    // --- locale ---------------------------------------------------------------
    const zhDict = {
      'bucket.today': '今天',
      'bucket.yesterday': '昨天',
      'bucket.last7': '前7天',
      'bucket.last30': '前30天',
      'bucket.older': '更早',
      'ungrouped': '未分组',
      'session.new': '新会话',
      'session.untitled': '未命名',
      'rel.now': '刚刚',
      'rel.minute': '{n}分钟前',
      'rel.hour': '{n}小时前',
      'rel.day': '{n}天前',
      'rel.month': '{n}个月前',
      'rel.year': '{n}年前',
    }
    const enDict = {
      'bucket.today': 'Today',
      'bucket.yesterday': 'Yesterday',
      'bucket.last7': 'Last 7 days',
      'bucket.last30': 'Last 30 days',
      'bucket.older': 'Older',
      'ungrouped': 'Ungrouped',
      'session.new': 'New Session',
      'session.untitled': 'Untitled',
      'rel.now': 'just now',
      'rel.minute': '{n}m ago',
      'rel.hour': '{n}h ago',
      'rel.day': '{n}d ago',
      'rel.month': '{n}mo ago',
      'rel.year': '{n}y ago',
    }

    var __locale = null
    function localeLang() {
      if (typeof navigator === 'undefined') return 'zh'
      for (const tag of (navigator.languages || []).concat([navigator.language])) {
        const primary = String(tag || '').toLowerCase().split('-')[0]
        if (primary === 'zh' || primary === 'en') return primary
      }
      return 'zh'
    }
    function __t(key, params) {
      let text = key
      if (__locale && typeof __locale.t === 'function') {
        try {
          const localized = __locale.t(NS, key)
          if (localized != null && String(localized) !== key) text = String(localized)
        } catch { /* fall through */ }
      }
      if (text === key) {
        const dict = localeLang() === 'en' ? enDict : zhDict
        if (Object.prototype.hasOwnProperty.call(dict, key)) text = dict[key]
      }
      if (params) {
        for (const name of Object.keys(params)) text = text.split('{' + name + '}').join(String(params[name]))
      }
      return text
    }

    // --- services -------------------------------------------------------------
    var __ctx = null
    var __scope = null
    var __sessions = null
    var __workspaces = null
    var __servicesOk = false
    var __subscribed = false

    function __readService(scope, name) {
      if (!scope) return null
      try { if (typeof scope.get === 'function') { const viaGet = scope.get(name); if (viaGet) return viaGet } } catch { /* */ }
      try { if (scope[name]) return scope[name] } catch { /* */ }
      return null
    }
    function __lookup(name) {
      for (const scope of [__scope, __ctx]) { const found = __readService(scope, name); if (found) return found }
      return null
    }
    function refreshServiceStatus() {
      const sessions = __sessions || __lookup('sessions')
      if (sessions) __sessions = sessions
      const workspaces = __workspaces || __lookup('workspaces')
      if (workspaces) __workspaces = workspaces
      __servicesOk = !!(
        __sessions && __sessions.list && typeof __sessions.list.getSnapshot === 'function'
        && __workspaces && __workspaces.list && typeof __workspaces.list.getSnapshot === 'function'
      )
      if (__servicesOk) ensureSubscriptions()
      return __servicesOk
    }
    function ensureSubscriptions() {
      if (__subscribed || !__servicesOk) return
      try {
        if (__sessions.list && typeof __sessions.list.subscribe === 'function') __sessions.list.subscribe(() => { scheduleReconcile() })
        if (__workspaces.list && typeof __workspaces.list.subscribe === 'function') __workspaces.list.subscribe(() => { scheduleReconcile() })
        __subscribed = true
      } catch { /* best-effort */ }
    }

    // --- persistence (folded buckets only) ------------------------------------
    /** localStorage access that also works inside the Node test harness
     *  (which stubs window.localStorage but has no global localStorage). */
    function getStorage() {
      try {
        if (typeof localStorage !== 'undefined') return localStorage
        if (typeof window !== 'undefined' && window.localStorage) return window.localStorage
      } catch { /* */ }
      return null
    }
    function readStore() {
      const storage = getStorage()
      try {
        const raw = storage && storage.getItem(STORE_KEY)
        if (raw) {
          const parsed = JSON.parse(raw)
          return {
            folded: Array.isArray(parsed.folded) ? parsed.folded.filter((k) => BUCKET_ORDER.indexOf(k) >= 0) : [],
          }
        }
      } catch { /* storage unavailable */ }
      return { folded: [] }
    }
    function writeStore(state) {
      const storage = getStorage()
      try {
        if (storage) storage.setItem(STORE_KEY, JSON.stringify({
          folded: Array.isArray(state.folded) ? state.folded.filter((k) => BUCKET_ORDER.indexOf(k) >= 0) : [],
        }))
      } catch { /* never break the UI over persistence */ }
    }
    var __store = readStore()
    function isBucketFolded(key) { return Array.isArray(__store.folded) && __store.folded.indexOf(key) >= 0 }
    function setBucketFolded(key, folded) {
      const set = new Set(Array.isArray(__store.folded) ? __store.folded : [])
      if (folded) set.add(key); else set.delete(key)
      __store.folded = BUCKET_ORDER.filter((k) => set.has(k))
      writeStore(__store)
      reconcile()
    }

    // --- core view follower ---------------------------------------------------
    /** Read the workspace browser viewing store the core persists on every change. */
    function readCoreView() {
      const storage = getStorage()
      try {
        const raw = storage && storage.getItem(CORE_VIEW_KEY)
        if (!raw) return null
        const parsed = JSON.parse(raw)
        return { groupBy: parsed.groupBy, orderBy: parsed.orderBy }
      } catch { return null }
    }
    /** True only while the core is in 单列表 (flat) + 最近更新 (updated) mode. */
    function isFlatUpdatedView() {
      const view = readCoreView()
      return !!view && view.groupBy === 'flat' && view.orderBy === 'updated'
    }

    // --- pure bucketing / projection (exposed for the logic harness) ----------
    function startOfLocalDay(ms) {
      const d = new Date(ms)
      return new Date(d.getFullYear(), d.getMonth(), d.getDate()).getTime()
    }
    function bucketKeyOf(updatedAtMs, nowMs) {
      const startToday = startOfLocalDay(nowMs)
      if (updatedAtMs >= startToday) return 'today'
      if (updatedAtMs >= startToday - DAY_MS) return 'yesterday'
      if (updatedAtMs >= startToday - 7 * DAY_MS) return 'last7'
      if (updatedAtMs >= startToday - 30 * DAY_MS) return 'last30'
      return 'older'
    }
    /** Bucketing time for a row. The core reuses a workspace's still-blank
     *  session for 新会话 (connectWorkspace) and keeps its old updatedAt, so a
     *  freshly opened New Session row can surface under 昨天/前7天. The only
     *  blank row the list shows is the current one (sessionVisible), so pin
     *  blank && current rows to now: the session you are editing right now
     *  always lands in 今天 and newest-first inside it. Everything else keeps
     *  its real updatedAt. */
    function bucketTimeOf(row, nowMs) {
      const ref = typeof nowMs === 'number' ? nowMs : Date.now()
      if (row && row.blank === true && row.current === true) return ref
      return row && typeof row.updatedAt === 'number' ? row.updatedAt : 0
    }
    function workspaceTitleBySession(items) {
      const map = {}
      for (const item of items || []) {
        const title = item && (item.title || '')
        for (const id of (item.sessionIds || [])) if (map[id] === undefined) map[id] = title
      }
      return map
    }
    /** Core-equivalent visibility (tree.ts sessionVisible): ordinary sessions
     *  only, no subagent lineage, no archived ids, blank only when current. */
    function collectRows(list, archived, titleBySession) {
      const archivedSet = new Set(archived || [])
      const rows = []
      const byId = (list && list.byId) || {}
      const current = list && list.current
      for (const id of Object.keys(byId)) {
        const s = byId[id]
        if (!s) continue
        if (s.origin === 'subagent') continue
        if (archivedSet.has(id)) continue
        if (s.blank === true && id !== current) continue
        rows.push({
          id,
          title: s.blank === true ? '' : String(s.displayTitle || s.title || ''),
          // Core >= 0.2.0-rc.2 renders t('session.untitled') for a session whose
          // stored title is missing or blank (lib/client.js displayTitle:
          // node.title || t('session.untitled')), while the snapshot displayTitle
          // still falls back to the workspace directory name. The flag — not the
          // display text — is what the DOM matcher must trust.
          untitled: s.blank === true ? false : !(typeof s.title === 'string' && s.title.trim() !== ''),
          blank: s.blank === true,
          current: id === current,
          running: s.running === true,
          completed: s.completed === true,
          updatedAt: typeof s.updatedAt === 'number' ? s.updatedAt : 0,
          wsTitle: titleBySession[id],
        })
      }
      return rows
    }
    /** Newest-first order — the order the core renders in flat + updated
     *  (deriveFlat sorts byRecency before persisting the account order). */
    function sortRowsByRecency(rows) {
      return (rows || []).slice().sort((a, b) =>
        (b.updatedAt !== a.updatedAt ? b.updatedAt - a.updatedAt : (a.id < b.id ? -1 : (a.id > b.id ? 1 : 0))))
    }
    function rowTitle(row, showWorkspace, ungroupedLabel) {
      if (row.blank) return ''
      if (!showWorkspace) return row.title
      return '[' + (row.wsTitle ? row.wsTitle : ungroupedLabel) + '] ' + row.title
    }
    /** The [工作区] / [未分组] prefix injected before the official title span.
     *  Blank rows (the provisional 新会话 row) carry no prefix. */
    function wsPrefixText(row, ungroupedLabel) {
      if (!row || row.blank) return ''
      return '[' + (row.wsTitle ? row.wsTitle : ungroupedLabel) + '] '
    }
    /** The text the CORE actually renders for a row: the localized New Session
     *  label for the provisional blank row, the localized Untitled label when
     *  the session has no stored title, the session title otherwise. Matching
     *  against the core's own wording — not against the snapshot displayTitle —
     *  is what keeps render order and snapshot order aligned. */
    function visibleRowTitle(row, blankLabel, untitledLabel) {
      if (!row) return ''
      if (row.blank) return blankLabel
      if (row.untitled === true) return untitledLabel || row.title || ''
      return row.title
    }
    /** Align DOM row titles (read in render order) with known sessions.
     *  `rows` must be recency-sorted (core render order); titles are matched
     *  in order, so duplicated titles map newest-DOM-row -> newest session.
     *  `blankLabel` is the localized New Session row title and `untitledLabel`
     *  the localized Untitled row title (both as the core renders them). */
    function matchRowTitles(domTitles, rows, blankLabel, untitledLabel) {
      const used = new Set()
      const out = []
      for (const t of domTitles || []) {
        let hit = null
        for (const r of rows || []) {
          if (used.has(r.id)) continue
          if (visibleRowTitle(r, blankLabel, untitledLabel) === t) { hit = r; break }
        }
        if (hit) used.add(hit.id)
        out.push(hit)
      }
      return out
    }
    /** Contiguous bucket runs over the render-order row keys. A missing key
     *  (unmapped row) does NOT end the current run: it contributes no header of
     *  its own, and the run it interrupts keeps collapsing into one header.
     *  Ending the run here used to fork one header per fragment, so an unmapped
     *  row in the middle of a bucket rendered that bucket label twice in a row.
     *  Rows are never reordered and a run always counts its mapped rows only. */
    function planBuckets(keys) {
      const runs = []
      let cur = null
      for (let i = 0; i < (keys ? keys.length : 0); i++) {
        const key = keys[i]
        if (!key) continue
        if (cur && cur.key === key) { cur.count++; continue }
        cur = { key, count: 1, index: i }
        runs.push(cur)
      }
      return runs
    }
    /** Canonical bucket derivation: BUCKET_ORDER, newest-first inside each
     *  bucket. The sorted layout path re-sequences official wrappers into
     *  exactly this order. */
    function deriveBuckets(rows, nowMs) {
      const buckets = {}
      for (const key of BUCKET_ORDER) buckets[key] = []
      for (const row of rows || []) buckets[bucketKeyOf(bucketTimeOf(row, nowMs), nowMs)].push(row)
      const out = []
      for (const key of BUCKET_ORDER) {
        const list = buckets[key]
        if (list.length === 0) continue
        list.sort((a, b) => {
          const at = bucketTimeOf(a, nowMs)
          const bt = bucketTimeOf(b, nowMs)
          return (bt !== at ? bt - at : (a.id < b.id ? -1 : (a.id > b.id ? 1 : 0)))
        })
        out.push({ key, rows: list })
      }
      return out
    }
    function relativeLabel(ms, nowMs, resolve) {
      const ref = typeof nowMs === 'number' ? nowMs : Date.now()
      const diff = Math.max(0, ref - ms)
      const MIN = 60000
      const HOUR = 3600000
      const interpolate = (key, n) => String(resolve(key) || key).replace('{n}', String(n))
      if (diff < MIN) return interpolate('rel.now', 0)
      if (diff < HOUR) return interpolate('rel.minute', Math.floor(diff / MIN))
      if (diff < DAY_MS) return interpolate('rel.hour', Math.floor(diff / HOUR))
      if (diff < 30 * DAY_MS) return interpolate('rel.day', Math.max(1, Math.floor(diff / DAY_MS)))
      if (diff < 365 * DAY_MS) return interpolate('rel.month', Math.max(1, Math.floor(diff / (30 * DAY_MS))))
      return interpolate('rel.year', Math.max(1, Math.floor(diff / (365 * DAY_MS))))
    }

    // --- DOM helpers ----------------------------------------------------------
    function el(tag, attrs, children) {
      const node = document.createElement(tag)
      if (attrs) {
        for (const key of Object.keys(attrs)) {
          const value = attrs[key]
          if (value == null) continue
          if (key === 'style' && typeof value === 'object') { for (const prop of Object.keys(value)) node.style[prop] = value[prop] }
          else if (key === 'class') { node.className = value }
          else if (key === 'text') { node.textContent = value }
          else if (key === 'html') { node.innerHTML = value }
          else if (key.startsWith('data-')) { node.setAttribute(key, value) }
          else { node.setAttribute(key, value) }
        }
      }
      for (const child of children || []) {
        if (child == null) continue
        node.appendChild(typeof child === 'string' ? document.createTextNode(child) : child)
      }
      return node
    }

    // Core ic_ds_triangle_right_fill_14: solid triangle pointing right;
    // the core rotates it 90° for the open (expanded) state.
    const TRIANGLE_SVG = '<svg width="14" height="14" viewBox="0 0 14 14" fill="none" aria-hidden="true"><path d="M4.25 2.82782L4.25 11.1722C4.25 11.6622 4.84243 11.9076 5.18891 11.5611L9.36109 7.38891C9.57588 7.17412 9.57588 6.82588 9.36109 6.61109L5.18891 2.43891C4.84243 2.09243 4.25 2.33782 4.25 2.82782Z" fill="currentColor"/></svg>'

    // --- anchors --------------------------------------------------------------
    function findViewButton() {
      const candidates = document.querySelectorAll('button')
      for (let i = 0; i < candidates.length; i++) {
        const label = String(candidates[i].getAttribute('aria-label') || '').trim()
        if (label === '视图选项' || label === 'View options') return candidates[i]
      }
      return null
    }
    function locateCore() {
      try {
        const viewButton = findViewButton()
        if (!viewButton) return null
        const headerActions = viewButton.closest('[class*="headerActions"]') || viewButton.parentElement
        const header = headerActions && (headerActions.closest('[class*="sectionHeader"]') || headerActions.parentElement)
        if (!header) return null
        const root = header.parentElement
        if (!root) return null
        const listArea = root.querySelector('[class*="listArea"]')
        const rail = !!root.className && String(root.className).indexOf('rail') >= 0
        return { header, root, listArea, rail }
      } catch { return null }
    }
    /** Search expansion swaps the flat list for the search tree inside listArea:
     *  never enhance while a search is active. */
    function isSearchActive(root) {
      if (!root) return false
      try {
        if (root.querySelector('[class*="searchExpanded"]')) return true
        if (root.querySelector('[class*="searchTree"]')) return true
      } catch { /* */ }
      return false
    }
    /**
     * The official flat session list element (tree role + flatList class).
     * No fallback: the workspace-grouped tree also contains sessionRow
     * descendants, and matching it would make the plugin fight the core's
     * own grouping during a view switch.
     */
    function findFlatTree(core) {
      if (!core || !core.root) return null
      try {
        const direct = core.root.querySelector('[class*="flatList"][role="tree"]')
        if (direct) return direct
      } catch { /* */ }
      return null
    }
    /**
     * Official session rows inside the flat tree, in render order.
     * The live DOM nests every row under a React wrapper span (the hover-card
     * anchor), so rows are located via role/class descendants rather than
     * tree children; `wrapper` is the tree's direct child we anchor headers
     * against, and `el` is the row itself.
     */
    function readDomRows(tree) {
      const out = []
      try {
        const rows = tree.querySelectorAll('[role="treeitem"]')
        for (const child of rows) {
          if (String(child.className || '').indexOf('sessionRow') < 0) continue
          const titleEl = child.querySelector('[class*="title"]')
          if (!titleEl) continue
          const slotEl = child.querySelector('[class*="slot"]')
          out.push({
            el: child,
            wrapper: child.parentElement,
            titleEl,
            hasSlot: !!slotEl,
            titleText: String(titleEl.textContent || '').replace(/\s+/g, ' ').trim(),
          })
        }
      } catch { /* */ }
      return out
    }

    // --- enhancement state ----------------------------------------------------
    var __mode = false
    var __core = null
    var __mapped = new Map()      // official row element -> { row, titleEl, wrapper } (mapped session)
    var __headers = new Map()     // run identity (key#n) -> injected header element
    var __observer = null
    var __observerRoot = null
    var __pending = false
    var __watch = null
    var __dragging = false        // a core row drag is in flight: never reorder mid-drag
    var __exitOrder = null        // official children order snapshot, restored on exit
    var __snapTree = null         // the tree __exitOrder belongs to

    function detachObserver() {
      if (__observer) { try { __observer.disconnect() } catch { /* */ } __observer = null }
      __observerRoot = null
    }
    function ensureObserver(core) {
      if (!core || !core.root) return
      if (__observer && __observerRoot === core.root) return
      detachObserver()
      try {
        if (typeof MutationObserver === 'undefined') return
        __observer = new MutationObserver(() => { scheduleReconcile() })
        // childList + subtree: rows/menus/dialogs created or moved by React.
        // characterData: title renames and time-label refresh.
        // attributes off on purpose: our fold/display style writes would loop.
        __observer.observe(core.root, { childList: true, subtree: true, characterData: true })
        __observerRoot = core.root
      } catch { /* */ }
    }
    /** Debounce to the microtask after the mutation batch; idempotent. */
    function scheduleReconcile() {
      if (__pending) return
      __pending = true
      try {
        if (typeof queueMicrotask === 'function') queueMicrotask(flushScheduledReconcile)
        else setTimeout(flushScheduledReconcile, 0)
      } catch { __pending = false }
    }
    function flushScheduledReconcile() {
      __pending = false
      try { reconcile() } catch { /* never crash the core UI */ }
    }

    // --- injected nodes -------------------------------------------------------
    // Group header (styled per the core project row: 34px, triangle in a
    // 16x20 slot, gap 6, padding 0 8px) — the one piece with no core
    // equivalent, since the core has no time-bucket concept.
    function makeGroupHeader(key, identity) {
      const folded = isBucketFolded(key)
      const head = el('button', {
        type: 'button',
        'data-dsh-time-bucket-group': identity,
        'aria-expanded': folded ? 'false' : 'true',
        style: {
          display: 'flex', alignItems: 'center', gap: 6, width: '100%', margin: '2px 0 6px',
          padding: '7px 8px', border: 'none', background: 'transparent', borderRadius: 8,
          cursor: 'pointer', textAlign: 'left', fontSize: '14px', lineHeight: '20px',
          color: 'var(--dsw-alias-label-secondary, #b0b0b4)', boxSizing: 'border-box',
        },
      })
      const chevron = el('span', {
        html: TRIANGLE_SVG,
        style: { flex: 'none', width: 16, height: 20, display: 'inline-flex', alignItems: 'center', justifyContent: 'center', color: 'var(--dsw-alias-label-quaternary, rgba(138,138,142,.7))', transition: 'transform 150ms ease' },
      })
      chevron.style.transform = folded ? 'rotate(0deg)' : 'rotate(90deg)'
      head.appendChild(chevron)
      head.appendChild(el('span', {
        'data-dsh-time-bucket-headlabel': '1',
        text: __t('bucket.' + key),
        style: { flex: 1, minWidth: 0, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', fontWeight: 600 },
      }))
      head.appendChild(el('span', {
        'data-dsh-time-bucket-headcount': '1',
        text: '',
        style: { flex: 'none', color: 'var(--dsw-alias-label-quaternary, rgba(138,138,142,.7))' },
      }))
      head.addEventListener('click', () => { setBucketFolded(key, !isBucketFolded(key)) })
      head.addEventListener('mouseenter', () => { head.style.background = 'var(--dsw-alias-interactive-bg-hover, rgba(128,128,128,.14))' })
      head.addEventListener('mouseleave', () => { head.style.background = 'transparent' })
      return head
    }
    /** Idempotent presentation refresh: aria-expanded, chevron rotation,
     *  label and count — every write is compare-first (observer no-op). */
    function refreshHeader(header, key, count) {
      const folded = isBucketFolded(key)
      try { header.setAttribute('aria-expanded', folded ? 'false' : 'true') } catch { /* */ }
      try {
        const chevron = header.firstElementChild && header.querySelector('svg') ? header.firstElementChild : null
        if (chevron) {
          const want = folded ? 'rotate(0deg)' : 'rotate(90deg)'
          if (chevron.style.transform !== want) chevron.style.transform = want
        }
      } catch { /* */ }
      try {
        const label = header.querySelector('[data-dsh-time-bucket-headlabel]')
        const text = __t('bucket.' + key)
        if (label && label.textContent !== text) label.textContent = text
      } catch { /* */ }
      try {
        const countEl = header.querySelector('[data-dsh-time-bucket-headcount]')
        const text = String(count)
        if (countEl && countEl.textContent !== text) countEl.textContent = text
      } catch { /* */ }
    }
    /**
     * Inject/refresh the [工作区] span directly before the official title.
     * Mirrors the core slot→title geometry: the 4px lead gap moves from the
     * title's margin to the prefix span, so the official layout is unchanged.
     */
    function ensureWsPrefix(domRow, row, ungroupedLabel) {
      const text = wsPrefixText(row, ungroupedLabel)
      const parent = domRow.titleEl.parentElement
      if (!parent) return
      let ws = null
      try { ws = parent.querySelector('[data-dsh-time-bucket-ws]') } catch { /* */ }
      if (!text) {
        if (ws) { try { ws.remove() } catch { /* */ } }
        try { domRow.titleEl.style.marginLeft = '' } catch { /* */ }
        return
      }
      if (!ws) {
        ws = el('span', {
          'data-dsh-time-bucket-ws': '1',
          style: {
            flex: 'none', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap',
            maxWidth: '40%', fontSize: '12px', lineHeight: '20px',
            color: 'var(--dsw-alias-label-tertiary, #8a8a8e)',
          },
        })
        parent.insertBefore(ws, domRow.titleEl)
      }
      if (ws.textContent !== text) ws.textContent = text
      // Prefix must sit immediately before the title: when the core inserts
      // its own nodes (e.g. the status slot appearing on a running row) it
      // anchors them before the title, so re-assert our position (no-op when
      // already correct — MutationObserver idempotency).
      if (ws.nextElementSibling !== domRow.titleEl) {
        try { parent.insertBefore(ws, domRow.titleEl) } catch { /* */ }
      }
      // Official geometry: slot -> 4px -> prefix-title. The title owns the
      // 4px margin in the core; hand that gap to the prefix and zero the
      // title's, keeping total spacing identical (flat rows without a status
      // slot have zero lead gap in the core too).
      const wantGap = domRow.hasSlot ? '4px' : '0px'
      try { if (ws.style.marginLeft !== wantGap) ws.style.marginLeft = wantGap } catch { /* */ }
      try { if (domRow.titleEl.style.marginLeft !== '0px') domRow.titleEl.style.marginLeft = '0px' } catch { /* */ }
    }
    function removeWsPrefix(domRow) {
      try {
        const parent = domRow.titleEl && domRow.titleEl.parentElement
        let ws = parent && parent.querySelector('[data-dsh-time-bucket-ws]')
        if (ws) ws.remove()
        if (domRow.titleEl) domRow.titleEl.style.marginLeft = ''
      } catch { /* */ }
    }
    /** Remove every injected node and unfold every row (exit / search guard). */
    function clearEnhancements() {
      for (const [elm, info] of __mapped) {
        removeWsPrefix(info)
        try { elm.style.display = '' } catch { /* */ }
        try { if (info && info.wrapper) info.wrapper.style.display = '' } catch { /* */ }
      }
      __mapped = new Map()
      for (const header of __headers.values()) { try { header.remove() } catch { /* */ } }
      __headers = new Map()
    }

    // --- reconciliation -------------------------------------------------------
    function reconcile() {
      if (!__mode || !__servicesOk) return
      // The watcher gates on the view store too, but reconcile also runs
      // from subscriptions/microtasks between ticks — re-check so a view
      // switch that just happened (flat tree unmounted, workspace tree
      // mounted) can never receive injections.
      if (!isFlatUpdatedView()) { exitMode(); return }
      const core = (__core && document.contains(__core.root)) ? __core : locateCore()
      if (!core || core.rail) { exitMode(); return }
      __core = core
      if (isSearchActive(core.root)) { clearEnhancements(); return }
      const tree = findFlatTree(core)
      if (!tree) { clearEnhancements(); return }
      ensureObserver(core)
      try {
        if (tree.__dshTbDragWired !== 1) {
          tree.__dshTbDragWired = 1
          tree.addEventListener('dragstart', () => { __dragging = true }, true)
          tree.addEventListener('dragend', () => { __dragging = false; scheduleReconcile() }, true)
        }
      } catch { /* */ }
      // Snapshot the official order once per tree mount so exit can restore
      // the core's own sequence (we re-sequence wrappers while active).
      if (__snapTree !== tree) {
        try { __exitOrder = Array.from(tree.children); __snapTree = tree } catch { __exitOrder = null }
      }

      const nowMs = Date.now()
      const listSnap = __sessions.list.getSnapshot()
      const wsSnap = __workspaces.list.getSnapshot()
      const rows = sortRowsByRecency(collectRows(
        listSnap,
        (wsSnap && wsSnap.archivedSessionIds) || [],
        workspaceTitleBySession((wsSnap && wsSnap.items) || []),
      ))
      const domRows = readDomRows(tree)
      const ungroupedLabel = __t('ungrouped')

      // Row identity: render order == core recency order; titles confirm it.
      // Duplicated titles map sequentially (newest DOM row -> newest session).
      const mapped = matchRowTitles(
        domRows.map((d) => d.titleText), rows, __t('session.new'), __t('session.untitled'),
      )

      // Detach enhancements from rows that went away / unmapped, then apply.
      const old = __mapped
      __mapped = new Map()
      for (let i = 0; i < domRows.length; i++) {
        const domRow = domRows[i]
        const row = mapped[i]
        if (!row) {
          if (old.has(domRow.el)) {
            removeWsPrefix(domRow)
            try { domRow.el.style.display = '' } catch { /* */ }
            try { if (domRow.wrapper) domRow.wrapper.style.display = '' } catch { /* */ }
          }
          continue
        }
        __mapped.set(domRow.el, { row, titleEl: domRow.titleEl, wrapper: domRow.wrapper })
        if (!old.has(domRow.el)) {
          try { domRow.el.style.display = '' } catch { /* */ }
          try { if (domRow.wrapper) domRow.wrapper.style.display = '' } catch { /* */ }
        }
        ensureWsPrefix(domRow, row, ungroupedLabel)
      }
      for (const [elm, info] of old) {
        if (!__mapped.has(elm)) {
          removeWsPrefix(info)
          try { elm.style.display = '' } catch { /* */ }
          try { if (info && info.wrapper) info.wrapper.style.display = '' } catch { /* */ }
        }
      }

      // Buckets in canonical order, newest-first INSIDE each bucket (the
      // v2 guarantee). The core's "最近更新" order is an activity-promotion +
      // persisted account order — it only lifts sessions whose updatedAt
      // grew and otherwise keeps historical/manual order, so older rows can
      // legitimately sit above newer ones. React never validates DOM order
      // against its vdom (it moves nodes only when ITS order changes), so
      // re-sequencing the official wrappers is stable; the observer
      // reconciles after any core-driven move.
      const mappedRows = domRows.map((d, i) => mapped[i]).filter(Boolean)
      const allMapped = domRows.length > 0 && mappedRows.length === domRows.length
      const liveIdentities = new Set()
      const collectStale = () => {
        for (const [identity, header] of __headers) {
          if (!liveIdentities.has(identity)) { try { header.remove() } catch { /* */ } __headers.delete(identity) }
        }
      }
      if (allMapped) {
        // Sorted layout: [header, wrappers...] per bucket, all children
        // re-appended when the live sequence diverges.
        const wrapperOf = new Map()
        for (let i = 0; i < domRows.length; i++) {
          if (mapped[i]) wrapperOf.set(mapped[i].id, domRows[i].wrapper || domRows[i].el)
        }
        const seq = []
        for (const bucket of deriveBuckets(mappedRows, nowMs)) {
          const identity = bucket.key + '#1'
          liveIdentities.add(identity)
          let header = __headers.get(identity)
          if (!header) {
            header = makeGroupHeader(bucket.key, identity)
            __headers.set(identity, header)
          }
          refreshHeader(header, bucket.key, bucket.rows.length)
          seq.push(header)
          for (const row of bucket.rows) {
            const node = wrapperOf.get(row.id)
            if (node) seq.push(node)
          }
        }
        collectStale()
        if (!__dragging) {
          let orderChanged = false
          try { orderChanged = tree.children.length !== seq.length } catch { /* */ }
          if (!orderChanged) {
            for (let i = 0; i < seq.length; i++) {
              if (tree.children[i] !== seq[i]) { orderChanged = true; break }
            }
          }
          if (orderChanged) {
            for (const node of seq) { try { tree.appendChild(node) } catch { /* */ } }
          }
        }
      } else {
        // Partial mapping fallback: keep render order, anchor headers above
        // the first row of each contiguous run. An unmapped row is a gap, not
        // a boundary (planBuckets), so a bucket that a gap splits keeps ONE
        // header; occurrence identities still keep two genuine runs apart.
        const keys = []
        for (let i = 0; i < domRows.length; i++) {
          const r = mapped[i]
          keys.push(r ? bucketKeyOf(bucketTimeOf(r, nowMs), nowMs) : null)
        }
        const runs = planBuckets(keys)
        const keyOccurrence = {}
        for (const run of runs) {
          const occ = (keyOccurrence[run.key] = (keyOccurrence[run.key] || 0) + 1)
          const identity = run.key + '#' + occ
          liveIdentities.add(identity)
          const anchor = domRows[run.index].wrapper || domRows[run.index].el
          let header = __headers.get(identity)
          if (!header) {
            header = makeGroupHeader(run.key, identity)
            __headers.set(identity, header)
          }
          let attached = false
          try { attached = header.parentElement !== null } catch { /* */ }
          if (!attached) {
            try { tree.insertBefore(header, anchor) } catch { /* */ }
          } else if (header.nextElementSibling !== anchor) {
            try { tree.insertBefore(header, anchor) } catch { /* */ }
          }
          refreshHeader(header, run.key, run.count)
        }
        collectStale()
      }

      // Fold: collapse every mapped row whose bucket is folded. The wrapper
      // is the tree's direct child, so hiding it (and the row) removes the
      // item from layout entirely.
      for (let i = 0; i < domRows.length; i++) {
        const domRow = domRows[i]
        const row = mapped[i]
        let want = ''
        if (row) {
          const key = bucketKeyOf(bucketTimeOf(row, nowMs), nowMs)
          if (isBucketFolded(key)) want = 'none'
        }
        try { if (domRow.el.style.display !== want) domRow.el.style.display = want } catch { /* */ }
        try {
          if (domRow.wrapper && domRow.wrapper.style.display !== want) domRow.wrapper.style.display = want
        } catch { /* */ }
      }
    }

    // --- mode control ---------------------------------------------------------
    function enterMode() {
      if (__mode) return
      refreshServiceStatus()
      __mode = true
      reconcile()
    }
    function restoreCoreOrder() {
      const order = __exitOrder
      __exitOrder = null
      __snapTree = null
      if (!order || !__core) return
      try {
        const tree = findFlatTree(__core)
        if (!tree) return
        for (const node of order) {
          try { if (node && node.parentElement === tree) tree.appendChild(node) } catch { /* */ }
        }
      } catch { /* */ }
    }
    function exitMode() {
      if (!__mode) return
      __mode = false
      restoreCoreOrder()
      clearEnhancements()
      detachObserver()
      __core = null
    }

    // --- watcher --------------------------------------------------------------
    function tick() {
      try {
        if (!refreshServiceStatus()) return
        const core = locateCore()
        if (core && !core.rail && isFlatUpdatedView() && !isSearchActive(core.root)) {
          if (!__mode) enterMode()
          else reconcile()
          return
        }
        if (__mode) exitMode()
      } catch { /* watcher never crashes the UI */ }
    }

    // --- apply ----------------------------------------------------------------
    function adoptLocale(locale, ctx) {
      if (!locale) return
      __locale = locale
      try { if (typeof locale.register === 'function') ctx.effect(() => locale.register(NS, { zh: zhDict, en: enDict })) } catch { /* */ }
    }
    function apply(ctx) {
      __ctx = ctx
      refreshServiceStatus()
      if (!__sessions) ctx.inject(['sessions'], (sub) => { __scope = sub; __sessions = __readService(sub, 'sessions') || sub.sessions; refreshServiceStatus() })
      if (!__workspaces) ctx.inject(['workspaces'], (sub) => { __scope = sub; __workspaces = __readService(sub, 'workspaces') || sub.workspaces; refreshServiceStatus() })
      adoptLocale(ctx.get('locale'), ctx)
      if (!__locale) ctx.inject(['locale'], (sub) => { __scope = sub; adoptLocale(__readService(sub, 'locale') || sub.locale, ctx); tick() })
      ctx.on('locale/change', () => { tick() })
      ensureSubscriptions()
      if (!__watch) {
        __watch = window.setInterval(() => { tick() }, 1000)
        try { tick() } catch { /* DOM may not be ready yet */ }
      }
    }

    // Test-only hooks (window.__DSH_TEST__ is set by test/bundle.test.mjs only).
    if (typeof window !== 'undefined' && window.__DSH_TEST__) {
      window.__sessionTimeBucketTest = {
        bucketKeyOf, bucketTimeOf, startOfLocalDay, workspaceTitleBySession, collectRows,
        sortRowsByRecency, rowTitle, wsPrefixText, matchRowTitles, planBuckets,
        deriveBuckets, relativeLabel, readDomRows, findFlatTree,
        readCoreView, isFlatUpdatedView,
        BUCKET_ORDER, __t, zhDict, enDict,
        reset() {
          __scope = null; __ctx = null; __sessions = null; __workspaces = null
          __servicesOk = false; __subscribed = false
          __mode = false; __core = null
          __mapped = new Map()
          __headers = new Map()
          __pending = false
          __dragging = false
          __exitOrder = null
          __snapTree = null
          detachObserver()
          if (__watch) { clearInterval(__watch); __watch = null }
        },
      }
    }

    return { apply, inject: ['slots'] }
  },
})
//# sourceURL=/dsh-session-time-bucket/src/client.js