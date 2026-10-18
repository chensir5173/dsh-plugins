// dsh-esc-rewind: CLIENT half — the whole plugin lives here.
//
// Two entry points, one rewind engine:
//
//  1. Keyboard: while a session's turn is RUNNING, ESC once stops it; with the
//     turn stopped (ESC-stop or the toolbar Stop button) ESC again "rewinds"
//     the whole last exchange — the engine forks a branch from the previous
//     completed turn, archives the original session, opens the branch and
//     restores the prompt (text + best-effort images) into the composer.
//     Natural completions never arm; editing the draft, sending, or switching
//     sessions disarms.
//
//  2. Command: a client-owned `/rewind` contribution (ctx.commandUi popupSelect)
//     opens the core picker whose options cover the ENTIRE conversation: when
//     the picker opens, options() first pages ALL history into the client
//     window with one session.loadThrough(0) call (the same turn-jump loader
//     the core chat uses), then lists every user exchange newest-first with
//     round number + relative time. Because everything is loaded before the
//     rows render, the native shell's search + arrow navigation can reach any
//     exchange, however old — nothing is dynamically appended afterwards.
//     Picking one restarts from before it (same engine, including the
//     first-exchange fallback to a fresh same-workspace session).
//
//  DSH is append-only: no plugin can delete messages in place, so "rewind" is
//  expressed with the officially supported, non-destructive primitives — fork
//  a branch (like the core Branch button), archive the original (the row-menu
//  Archive action keeps the log recoverable). The only client services used:
//  sessions (binding/fork/create/loadOlder/loadThrough), uiWorkspace (openSession —
//  the 0.2.0 home of the switch-session verb), workspaces
//  (archiveSession), conversation (cancel/updateQueue/createDrafts — pre-0.1.5
//  core spells the last one createDraftImages; both are probed by capability),
//  uiConversation (per-session node snapshots), commandUi (the '/'-menu).
//
// Why a document capture listener: the composer is a Lexical contenteditable
// whose keyboard face is package-private, so the ESC bridge listens on
// document in the CAPTURE phase (before every core bubble-phase Escape close)
// and — hard-gated on "session rewindable + no overlay/menu open + no foreign
// text field" — otherwise returns without touching the event.
//
// Diagnostics: a read-only snapshot is published on window.__dsew plus the pure
// node/decision helpers (for the logic harness) — counters and last decisions
// only, never full message content.
//
// Bundle format (client-modules protocol): classic script registering a factory
// via window.__ModuleLoader__.load({ id, factory }); the factory receives
// `require` and returns { apply, inject }. No JSX: plain React.createElement.

window.__ModuleLoader__.load({
  id: 'dsh-esc-rewind',
  factory: (require) => {
    const React = require('react')
    const { useCallback, useEffect, useMemo, useRef, useState } = React

    // --- self-owned controls (0.2.0 contract: no host client package imports) ---
    // The 0.2.0 module table refuses require() of a package that is not a boot
    // row ("runtime mirror of the bundle purity gate"). @deepseek-ai/dsh-client-ui-primitives
    // is not guaranteed to be a row on a 0.2.0 profile, so the primitives
    // import below is OPTIONAL: when it resolves (pre-0.2.0 installs) it wins,
    // otherwise the plugin renders with its own token-based controls mirroring
    // the host look (copied minimal from the primitives' 0.2.0 sources).
    var _uc_primitives = null
    try {
      _uc_primitives = require('@deepseek-ai/dsh-client-ui-primitives')
    } catch { _uc_primitives = null }

    /** Inline SVG icon factory (16x16 currentColor, host style). */
    function _ucIcon(pathD, size) {
      return React.createElement('svg', {
        width: size || 16, height: size || 16, viewBox: '0 0 16 16',
        fill: 'none', xmlns: 'http://www.w3.org/2000/svg',
        style: { flex: 'none', display: 'inline-block', verticalAlign: 'middle' },
        'aria-hidden': true,
      }, React.createElement('path', { d: pathD, fill: 'currentColor' }))
    }
    const uIconRefresh = (p) => _ucIcon('M7.92136 0.349152C10.3744 0.349234 12.5564 1.5052 13.9557 3.29894L15.1281 2.12759C15.3303 1.92546 15.6767 2.06943 15.6767 2.35538V5.53923C15.6766 5.71626 15.5329 5.85976 15.3559 5.86002H12.171C11.8854 5.8597 11.7426 5.51465 11.9443 5.31249L12.9641 4.29056C11.8237 2.74305 9.98908 1.74106 7.92136 1.74097C4.46436 1.74097 1.66233 4.543 1.66233 8C1.66233 11.457 4.46436 14.259 7.92136 14.259C11.3782 14.2589 14.1804 11.4569 14.1804 8H15.5722C15.5722 12.2251 12.1465 15.6507 7.92136 15.6508C3.69614 15.6508 0.270508 12.2252 0.270508 8C0.270508 3.77478 3.69614 0.349152 7.92136 0.349152Z', p && p.size)
    const uIconCheck = (p) => _ucIcon('M13.5 3.5L6.5 12.5L2.5 8', p && p.size)
    const uIconWarning = (p) => _ucIcon('M8 1.5L15 14H1L8 1.5ZM8 6V9.5M8 11.5V11.6', p && p.size)
    const uIconClose = (p) => _ucIcon('M4 4L12 12M12 4L4 12', p && p.size)
    const uIconCopy = (p) => _ucIcon('M5.5 5.5H12.5V12.5H5.5V5.5ZM3.5 10.5V3.5H10.5', p && p.size)
    const uIconFolderOpen = (p) => _ucIcon('M1.5 4H6L7.5 5.5H14.5V12.5H1.5V4ZM1.5 6.5V12.5L4 7.5H14.5', p && p.size)
    const uIconLoading = (p) => _ucIcon('M8 1.5V4M8 12V14.5M1.5 8H4M12 8H14.5M3.4 3.4L5.2 5.2M10.8 10.8L12.6 12.6M12.6 3.4L10.8 5.2M5.2 10.8L3.4 12.6', p && p.size)
    const uIconChevronDown = (p) => _ucIcon('M3 5.5L8 10.5L13 5.5', p && p.size)
    const uIconCheckCircle = (p) => _ucIcon('M8 1.5C11.59 1.5 14.5 4.41 14.5 8C14.5 11.59 11.59 14.5 8 14.5C4.41 14.5 1.5 11.59 1.5 8C1.5 4.41 4.41 1.5 8 1.5ZM5.5 8L7.2 9.7L10.5 6.5', p && p.size)
    const IconRefreshOutline16 = uIconRefresh
    const IconCheckOutline16 = uIconCheck
    const IconWarningOutline16 = uIconWarning
    const IconCloseOutline16 = uIconClose
    const IconCopyOutline16 = uIconCopy
    const IconFolderOpenOutline16 = uIconFolderOpen
    const IconLoadingOutline16 = uIconLoading
    const IconChevronDownOutline14 = uIconChevronDown
    const IconCheckCircleOutlineRegular = uIconCheckCircle

    /** Self-owned Toast: top-center banner mirroring the primitives surface. */
    function UcToast({ text, icon, tone, onDone, holdMs }) {
      const latestOnDone = React.useRef(onDone)
      React.useLayoutEffect(() => { latestOnDone.current = onDone }, [onDone])
      React.useEffect(() => {
        const timer = setTimeout(() => { try { latestOnDone.current() } catch { /* noop */ } }, (holdMs || 3000) + 1000)
        return () => { clearTimeout(timer) }
      }, [holdMs])
      const portal = (typeof document !== 'undefined' && typeof ReactDOM !== 'undefined' && ReactDOM.createPortal)
        ? ReactDOM.createPortal : null
      const el = React.createElement('div', {
        role: 'alert',
        style: {
          position: 'fixed', top: 40, left: '50%', zIndex: 1100, pointerEvents: 'none',
          display: 'flex', alignItems: 'center', gap: 10, width: 'max-content',
          maxWidth: 'min(640px, calc(100vw - 48px))', padding: '12px 16px',
          borderRadius: 'var(--dsw-radius-lg)',
          background: 'var(--dsw-alias-toast-bg)', color: 'var(--dsw-alias-toast-label)',
          fontSize: 14, lineHeight: '22px', boxShadow: 'var(--dsw-shadow-lv3)',
          transform: 'translateX(-50%)', opacity: 1,
        },
      }, [
        tone === 'success'
          ? React.createElement('span', { key: 'i', style: { display: 'grid', placeItems: 'center', flex: 'none', color: 'var(--dsw-alias-state-success-primary)' }, 'aria-hidden': true },
            React.createElement(IconCheckCircleOutlineRegular, { size: 16 }))
          : (icon !== undefined && icon !== null
            ? React.createElement('span', { key: 'i', style: { display: 'grid', placeItems: 'center', flex: 'none', color: 'var(--dsw-alias-state-warn-label)' }, 'aria-hidden': true }, icon)
            : null),
        React.createElement('span', { key: 't', style: { minWidth: 0 } }, text),
      ])
      return portal ? portal(el, document.body) : el
    }

    /** Self-owned Tooltip: hover bubble; children's handlers are chained. */
    function UcTooltip({ label, side, delayMs, children }) {
      const [pos, setPos] = React.useState(null)
      const anchor = React.useRef(null)
      const timer = React.useRef(null)
      const side_ = side || 'top'
      const show = () => {
        const el = anchor.current
        if (!el) return
        const r = el.getBoundingClientRect()
        let left = r.left + r.width / 2
        let top = r.top - 8
        if (side_ === 'bottom') top = r.bottom + 8
        setPos({ left, top })
      }
      const delayed = (fn) => {
        if (timer.current) clearTimeout(timer.current)
        timer.current = setTimeout(fn, delayMs || 0)
      }
      React.useEffect(() => () => { if (timer.current) clearTimeout(timer.current) }, [])
      const child = React.Children.only(children)
      return React.createElement(React.Fragment, null, [
        React.cloneElement(child, {
          ref: (el) => { anchor.current = el; if (typeof child.ref === 'function') child.ref(el) },
          onMouseEnter: (e) => { if (child.props.onMouseEnter) child.props.onMouseEnter(e); delayed(show) },
          onMouseLeave: (e) => { if (child.props.onMouseLeave) child.props.onMouseLeave(e); if (timer.current) clearTimeout(timer.current); setPos(null) },
          onFocus: (e) => { if (child.props.onFocus) child.props.onFocus(e); delayed(show) },
          onBlur: (e) => { if (child.props.onBlur) child.props.onBlur(e); if (timer.current) clearTimeout(timer.current); setPos(null) },
        }),
        pos === null ? null : React.createElement('span', {
          role: 'tooltip',
          style: {
            position: 'fixed', left: pos.left, top: pos.top, zIndex: 1200,
            transform: side_ === 'bottom' ? 'translateX(-50%)' : 'translateX(-50%) translateY(-100%)',
            padding: '4px 8px', borderRadius: 'var(--dsw-radius-md)',
            background: 'var(--dsw-alias-tooltip-bg)', color: 'var(--dsw-alias-tooltip-label)',
            fontSize: 12, lineHeight: '16px', whiteSpace: 'nowrap',
            boxShadow: 'var(--dsw-shadow-lv2)', pointerEvents: 'none',
          },
        }, typeof label === 'function' ? label() : label),
      ])
    }

    /** Resolve the shared controls: prefer the primitives row (pre-0.2.0), else self-owned. */
    const Toast = (_uc_primitives && _uc_primitives.Toast) || UcToast
    const Tooltip = (_uc_primitives && _uc_primitives.Tooltip) || UcTooltip
    const Menu = (_uc_primitives && _uc_primitives.Menu) || null
    const writeClipboard = (_uc_primitives && _uc_primitives.writeClipboard) || (async (text) => {
      try { await navigator.clipboard.writeText(text); return { ok: true } } catch (e) { return { ok: false, error: e } }
    })


    const SLOT = 'conversation.input.overlay'
    const ROW_ID = 'esc-rewind'
    const ROW_ORDER = 60
    /** Session-header slot hosting the dispose-mode toggle (delete mode). */
    const HEADER_SLOT = 'conversation.session.header.actions'
    const HEADER_ROW_ID = 'esc-rewind-dispose'
    const HEADER_ORDER = 28
    const NS = 'esc-rewind'
    /** Settings namespace/field (node half registers the same keys). */
    const SETTINGS_NS = 'esc-rewind'
    const SETTINGS_FIELD = 'deleteOldOnRewind'
    /** Host delete endpoint (node half serves it when a web surface exists). */
    const DELETE_ENDPOINT = '/__esc-rewind/session/delete'
    /** Host refusal reasons (mirror of the node half constants). */
    const REASON_SUBAGENTS = 'subagents'
    const REASON_SUBAGENTS_UNKNOWN = 'subagents-unknown'
    /** Read-only orphan scan / stop endpoints (host half mirrors the paths). */
    const ORPHANS_ENDPOINT = '/__esc-rewind/orphans'
    const ORPHANS_STOP_ENDPOINT = '/__esc-rewind/orphans/stop'
    const ORPHANS_DELETE_ENDPOINT = '/__esc-rewind/orphans/delete'
    /** Tab slot declared by dsh-plugin-manager's「本地插件」settings entry. */
    const TAB_SLOT = 'settings.localPlugins.tab'
    const TAB_ID = 'subagents'
    const TAB_ORDER = 50
    const COMPOSER_ATTR = 'data-composer-input'
    const REWIND_COMMAND = 'rewind'
    /** How many draft images a rewind may try to restore. */
    const MAX_IMAGES = 9
    /** Pending composer-restore expiry (ms). */
    const PENDING_TTL_MS = 30000
    /** 还原写入前的等待（ms）：让分支的输入 store 先水合，再 setDraft。 */
    const RESTORE_DELAY_MS = 80
    /**
     * 子会话继承残留的确认预算（ms）：0.1.5 起宿主把收件箱做成耐久投影，随页面 baseline
     * 下发，正常几十毫秒就到；等不到就退回 queue 镜像的判定（等价于旧行为，不更差）。
     */
    const CHILD_PROJECTION_GRACE_MS = 300
    /** Safety cap for the loadOlder fallback loop (loadThrough is preferred). */
    const MAX_OLDER_PAGES = 400

    // --- module state ---------------------------------------------------------

    /** Services captured lazily via ctx.inject inside apply(). */
    var __svc = {
      sessions: null,
      workspaces: null,
      conversation: null,
      uiConversation: null,
      commandUi: null,
    }
    /**
     * Global delete-mode switch (client cache of settings `deleteOldOnRewind`).
     * false (default) = after a rewind the old session is ARCHIVED (recoverable);
     * true = the old session is permanently DELETED via the host half. Read from
     * remote.settings.describe() once settings is reachable; any failure falls
     * back to false (safety first — never delete because a read failed).
     */
    var __deleteMode = false
    /** Whether describe() has been consulted at least once (diagnostics). */
    var __deleteModeLoaded = false
    /** Lazy handle to the client remote.settings controller. */
    var __settings = null
    /** Whether the settings/document-updated subscription was established. */
    var __settingsEventsBound = false
    /** Subscribers notified when the delete-mode switch changes (header icons). */
    var __disposeListeners = new Set()
    /** One outstanding "restore me after I mount" draft, keyed by target session. */
    var __pending = null
    /**
     * 是否在本页见过宿主 inbox 投影值。核心世代的能力探针（不读版本号）：见过的核心才有
     * 「收件箱是耐久投影」这回事，子会话的继承残留也才只在这份投影里可见 —— 只有见过的
     * 时候才值得为它多等一个宽限；旧核心/形状不符时保持旧行为，不凭空多等。
     */
    var __inboxProjectionSeen = false
    /**
     * 订阅「还原被武装」的桥组件。真机顺序是 open 先于 arm（React 提交早于我们的 await），
     * 挂载那一刻 __pending 还是 null，只靠挂载 effect 会永久错过 —— 武装时广播一次补跑。
     */
    var __pendingListeners = new Set()
    /** sessionId -> seq of the run for which we already issued an ESC stop. */
    var __stopMarks = new Map()
    /** sessionIds currently inside a rewind (dedupe double triggers). */
    var __busy = new Set()
    /** Toast fan-out: listeners registered by mounted bridges. */
    var __toastListeners = new Set()
    /**
     * sessionIds whose conversation window this page has already fully loaded
     * (window anchored at the very start and growing live at the tail). Once
     * set, /rewind reads the live snapshot and never re-pages the whole log.
     */
    var __fullLoaded = new Set()
    /**
     * Per-session known user exchanges (chronological, full fields), kept in
     * memory and mirrored to localStorage (keyed by session) so a page reload
     * can serve /rewind from the record instead of re-reading the whole log.
     * Freshness: each entry carries watermarkSeq (newest user exchange seq at
     * build time); when the live tail shows something newer, the cache is
     * stale and a reload merges the delta.
     */
    var __known = new Map()
    const CACHE_PREFIX = 'dsh-esc-rewind.history.'
    /** Upper bound for a persisted entry (localStorage quota safety). */
    const CACHE_MAX_BYTES = 2500000
    /** Locale helpers (wired lazily, like the sibling plugins). */
    var __locale = null

    // 核心世代标志（命令描述契约用）：'string' = 旧核心当值渲染，'function' = 新核心会调用。
    var __commandDescShape = 'string'

    var __diag = {
      loaded: true,
      applied: false,
      mounted: 0,
      services: { sessions: false, workspaces: false, conversation: false, uiConversation: false, commandUi: false, settings: false },
      escStops: 0,
      rewinds: 0,
      pendingApplied: 0,
      historyLoads: 0,
      /** 自动弹出的「再按 Esc 回退」提示次数（非用户按键路径）。 */
      hintToasts: 0,
      /** 最近一次提示的判据：'tail-interrupted' | 'turn-aborted' | null。 */
      lastHint: null,
      lastGate: 'init',
      lastAction: null,
      rewindAvail: null,
      imageFail: null,
      // 草稿附件桥接探测结果：createDrafts（新）/createDraftImages（旧）/null（都缺）；
      // addAttachments（新）/addImages（旧）/null（都缺）。真机排障时一眼看出核心世代。
      draftCreateApi: null,
      draftRestoreApi: null,
      // 命令描述契约形态：0.1.5-rc.2 起核心把 `description` 由字符串改成 `() => string`。
      // 值 = 'function'（新契约，核心会调用） / 'string'（旧契约，核心当值渲染）。
      commandDescShape: 'string',
      // 回退前后的「未落定输入」处理：清掉的排队项数 / 是否因清不掉而放弃回退 /
      // 子会话打开后清掉的继承残留数（见 settlePendingInputs）。
      pendingCleared: 0,
      pendingBlocked: false,
      childPendingCleared: 0,
      // 命中来源（'inbox-projection' | 'queue-mirror' | 'echo'，命中多个时 '+' 连接）：
      // 宿主 queue 帧只在有活跃 agent 时才广播，inbox 投影帧才无条件广播，真机排障先看这个。
      pendingSource: null,
      childPendingSource: null,
      // 确认「清空」实际等了多久（ms）：0 附近 = 一次读就空，接近预算 = 一直在轮询。
      pendingConfirmMs: 0,
      childPendingConfirmMs: 0,
      // 还原回填：武装次数 / 由晚武装通知补跑的成功次数 / 因草稿非空而放弃的次数。
      pendingStaged: 0,
      pendingLateArm: 0,
      pendingDropped: null,
      /** 本页是否见过宿主 inbox 投影（核心世代能力探针；旧核心恒 false）。 */
      inboxProjectionSeen: false,
      titleFail: null,
      archiveFail: null,
      /** 归档是否走了「停止并归档」重试（0.2.0 的会话仍活跃拒绝）。 */
      archiveStopActivity: false,
      deleteFail: null,
      settingsReadFail: null,
      deleteMode: false,
      deleteModeLoaded: false,
      settingsEventsBound: false,
      disposeToggles: 0,
      lastDelete: null,
      lastRewind: null,
      orphanTabRegistered: false,
      orphanTabDormant: false,
      orphanTabError: null,
      orphans: null,
      orphanActions: [],
      orphanRenameFail: null,
    }
    try { if (typeof window !== 'undefined') window.__dsew = __diag } catch { /* no window */ }

    // --- locale ---------------------------------------------------------------

    const zhDict = {
      'esc.hint': '已停止 · 再按 Esc 回退本轮',
      'rewind.busy': '正在回退…',
      'rewind.done': '已回退，可改写问题后重新发送',
      'rewind.error': '回退失败：{msg}',
      'rewind.cmd.desc': '从历史某个回合重新开始（原会话将归档）',
      'rewind.loading': '正在读取全部历史…',
      'rewind.load.fail': '读取历史失败：{msg}',
      'rewind.image.only': '（图片消息）',
      'rewind.round': '第 {n} 轮',
      'rewind.none': '没有可回退的历史回合',
      'rewind.pending': '该会话还有没发出的消息在排队，等它落定后再回退（避免把它复制进新分支）',
      'esc.hint.delete': '已停止 · 再按 Esc 将删除本轮并重来（不可恢复）',
      'dispose.title.archive': '回退后归档旧会话（可恢复）',
      'dispose.title.delete': '回退后删除旧会话（不可恢复）',
      'dispose.on': '已开启：回退将删除旧会话（不可恢复）',
      'dispose.off': '已关闭：回退将归档旧会话',
      'dispose.error': '切换失败：{msg}',
      'rewind.deleted': '旧会话已删除',
      'rewind.delete.fail': '删除失败，已改为归档',
      'rewind.archive.fail': '旧会话归档失败：{msg}（它仍留在列表里）',
      'rewind.open.fail': '切换会话失败：宿主没有可用的会话切换接口（uiWorkspace.openSession）',
      'rewind.subagents': '该会话还有 {n} 个子代理（运行中 {r}），已改为归档（不删除）',
      'rewind.subagents.unknown': '读不到该会话的子代理状态，已改为归档（不删除）：{msg}',
      'orphans.tab': '子代理',
      'orphans.title': '孤儿子代理',
      'orphans.intro': '这些子代理的父会话已不存在：界面里没有入口，完成通知也无处投递。可以「停止」它（放弃其结果），或「找回」成普通会话继续使用。全部动作手动执行。',
      'orphans.refresh': '刷新统计',
      'orphans.loading': '正在统计…',
      'orphans.empty': '没有孤儿子代理',
      'orphans.error': '读取失败：{msg}',
      'orphans.count': '共 {n} 个',
      'orphans.running': '运行中',
      'orphans.parent': '父会话',
      'orphans.stop': '停止',
      'orphans.rescue': '找回',
      'orphans.remove': '删除',
      'orphans.removeSelected': '删除选中',
      'orphans.selectAll': '全选',
      'orphans.clearSelection': '取消全选',
      'orphans.removeConfirm': '删除选中的 {n} 个不可达子代理？删除不可恢复（会话日志、投影缓存与工作区记账一并移除）。仍挂着子代理的会被拒绝并原样保留。',
      'orphans.removed': '已删除',
      'orphans.removeBlocked': '未删除：自己还挂着 {n} 个子代理（请先删子级）',
      'orphans.removeUnknownBlock': '未删除：读不到子代理状态（fail-safe）',
      'orphans.removeMissing': '未删除：会话已不存在',
      'orphans.removeFailed': '删除失败：{msg}',
      'orphans.hostStale': '宿主半没有这个端点（404/405）：宿主半的改动需要重启 dsh web 才生效——重启后刷新本页再试',
      'orphans.stopSelected': '停止选中',
      'orphans.rescueSelected': '找回选中',
      'orphans.noBoundary': '没有完整回合，无法找回',
      'orphans.stopped': '已停止',
      'orphans.stopUnconfirmed': '已请求取消，未确认静默（{reason}）',
      'orphans.stopNoop': '无需停止（{reason}）',
      'orphans.stopFailed': '停止失败：{msg}',
      'orphans.rescued': '已找回为普通会话',
      'orphans.rescueFailed': '找回失败：{msg}',
    }
    const enDict = {
      'esc.hint': 'Stopped · press Esc again to rewind this turn',
      'rewind.busy': 'Rewinding…',
      'rewind.done': 'Rewound — edit the prompt and resend',
      'rewind.error': 'Rewind failed: {msg}',
      'rewind.cmd.desc': 'Restart from an earlier exchange (the original session is archived)',
      'rewind.loading': 'Reading the whole history…',
      'rewind.load.fail': 'Failed to read history: {msg}',
      'rewind.image.only': '(image message)',
      'rewind.round': 'Turn {n}',
      'rewind.none': 'No rewindable exchanges in this session',
      'rewind.pending': 'A message is still queued in this session — rewind once it lands (avoids copying it into the new branch)',
      'esc.hint.delete': 'Stopped · press Esc again to DELETE this turn and restart (irreversible)',
      'dispose.title.archive': 'After rewinding, archive the old session (recoverable)',
      'dispose.title.delete': 'After rewinding, DELETE the old session (irreversible)',
      'dispose.on': 'Enabled: rewinding will delete the old session (irreversible)',
      'dispose.off': 'Disabled: rewinding will archive the old session',
      'dispose.error': 'Switch failed: {msg}',
      'rewind.deleted': 'Old session deleted',
      'rewind.delete.fail': 'Delete failed — archived instead',
      'rewind.archive.fail': 'Failed to archive the old session: {msg} (it stays in the list)',
      'rewind.open.fail': 'Failed to switch sessions: the host exposes no session-switch API (uiWorkspace.openSession)',
      'rewind.subagents': 'Old session still owns {n} subagent(s) ({r} running) — archived instead of deleted',
      'rewind.subagents.unknown': 'Subagent state unreadable — archived instead of deleted: {msg}',
      'orphans.tab': 'Subagents',
      'orphans.title': 'Orphan subagents',
      'orphans.intro': 'These subagents lost their parent session, so nothing lists them and nothing delivers their result. Stop one (its result is dropped) or rescue it into an ordinary session you can keep using. Everything is manual.',
      'orphans.refresh': 'Refresh',
      'orphans.loading': 'Scanning…',
      'orphans.empty': 'No orphan subagents',
      'orphans.error': 'Scan failed: {msg}',
      'orphans.count': '{n} total',
      'orphans.running': 'running',
      'orphans.parent': 'parent',
      'orphans.stop': 'Stop',
      'orphans.rescue': 'Rescue',
      'orphans.remove': 'Delete',
      'orphans.removeSelected': 'Delete selected',
      'orphans.selectAll': 'Select all',
      'orphans.clearSelection': 'Clear selection',
      'orphans.removeConfirm': 'Delete {n} unreachable subagent(s)? This cannot be undone (session logs, projection cache and workspace accounting are removed). Any session that still owns subagents is refused and left untouched.',
      'orphans.removed': 'Deleted',
      'orphans.removeBlocked': 'Not deleted: it still owns {n} subagent(s) — delete the children first',
      'orphans.removeUnknownBlock': 'Not deleted: subagent state unavailable (fail-safe)',
      'orphans.removeMissing': 'Not deleted: session no longer exists',
      'orphans.removeFailed': 'Delete failed: {msg}',
      'orphans.hostStale': 'The running host does not expose this endpoint (404/405): host-half changes need a dsh web RESTART — restart, refresh this page, then retry',
      'orphans.stopSelected': 'Stop selected',
      'orphans.rescueSelected': 'Rescue selected',
      'orphans.noBoundary': 'No completed turn — cannot rescue',
      'orphans.stopped': 'Stopped',
      'orphans.stopUnconfirmed': 'Cancel requested, quiescence unconfirmed ({reason})',
      'orphans.stopNoop': 'Nothing to stop ({reason})',
      'orphans.stopFailed': 'Stop failed: {msg}',
      'orphans.rescued': 'Rescued as an ordinary session',
      'orphans.rescueFailed': 'Rescue failed: {msg}',
    }

    function localeFallbackLang() {
      if (typeof navigator === 'undefined') return 'zh'
      for (const tag of (navigator.languages || []).concat([navigator.language])) {
        const primary = String(tag || '').toLowerCase().split('-')[0]
        if (primary === 'zh' || primary === 'en') return primary
      }
      return 'zh'
    }

    /** Resolve a key through the locale service, falling back to the sniffed dict. */
    function __t(key, vars) {
      let text = null
      if (__locale && typeof __locale.translate === 'function') {
        const candidate = __locale.translate(NS, key)
        if (typeof candidate === 'string' && candidate !== key) text = candidate
      }
      if (text === null) text = (localeFallbackLang() === 'en' ? enDict : zhDict)[key] || key
      if (vars) {
        for (const k of Object.keys(vars)) {
          text = text.split('{' + k + '}').join(String(vars[k]))
        }
      }
      return text
    }

    // --- pure node readers (shape-tolerant across core versions) --------------

    /** Normalize one view/record node's kind, or null. */
    function nodeKind(node) {
      if (!node) return null
      if (typeof node.kind === 'string') return node.kind
      const data = node.data
      if (data && typeof data.kind === 'string') return data.kind
      return null
    }

    /** Normalize one node's durable seq (view anchor or record seq). */
    function nodeSeq(node) {
      if (!node) return null
      if (typeof node.seq === 'number') return node.seq
      if (typeof node.anchorSeq === 'number') return node.anchorSeq
      const data = node.data
      if (data) {
        if (typeof data.seq === 'number') return data.seq
        if (typeof data.anchorSeq === 'number') return data.anchorSeq
      }
      return null
    }

    /** Normalize one node's epoch-ms time. */
    function nodeTime(node) {
      if (!node) return null
      if (typeof node.time === 'number') return node.time
      const data = node.data
      if (data && typeof data.time === 'number') return data.time
      return null
    }

    /** Ordered content blocks of a message node (user/steering/context). */
    function contentOf(node) {
      if (!node) return []
      if (Array.isArray(node.content)) return node.content
      const data = node.data
      if (data && Array.isArray(data.content)) return data.content
      return []
    }

    /** The assistant lifecycle status ('running'|'settled'|'interrupted'|null). */
    function assistantStatusOf(node) {
      const kind = nodeKind(node)
      if (kind !== 'assistant') return null
      if (node && (node.status === 'running' || node.status === 'settled' || node.status === 'interrupted')) {
        return node.status
      }
      const data = node && node.data
      if (data) {
        if (data.status === 'running' || data.status === 'settled' || data.status === 'interrupted') return data.status
        if (data.interrupted === true) return 'interrupted'
        if (Array.isArray(data.blocks) && data.finalNode) return 'settled'
        if (Array.isArray(data.blocks)) return 'running'
      }
      if (node && node.interrupted === true) return 'interrupted'
      if (node && Array.isArray(node.blocks)) return 'settled'
      return 'settled'
    }

    /** Concatenated plain text of a message node's content blocks. */
    function nodeText(node) {
      const blocks = contentOf(node)
      let text = ''
      for (const block of blocks) {
        if (!block) continue
        const type = block.type || block.kind
        if (type === 'text' && typeof block.text === 'string') text += (text ? '\n' : '') + block.text
      }
      return text.trim()
    }

    /** Durable image attachment references embedded in a message node's content. */
    function nodeImageRefs(node) {
      const refs = []
      const blocks = contentOf(node)
      for (const block of blocks) {
        if (!block) continue
        const type = block.type || block.kind
        if (type !== 'image') continue
        const source = block.attachment || block.image || null
        const attachmentId = source && (source.attachmentId || source.id)
        if (attachmentId) {
          refs.push({
            attachmentId,
            mediaType: (source.mediaType) || 'image/png',
            name: source.name,
          })
        }
      }
      return refs
    }

    // --- draft-attachment bridge (shape-tolerant across core generations) -----

    /**
     * 创建浏览器侧草稿附件，返回其 id 数组。
     * - 0.1.5-rc.2 起核心把「图片草稿」泛化为「附件草稿」，签名变为
     *   `createDrafts(sessionId, files)`；旧版是 `createDraftImages(files)`。
     *   两代都返回 `[{ id }]`，所以只按能力探测选名字，不按版本号分支。
     * - 参数类型：conversation -- object|undefined：注入的 conversation 服务；
     *   sessionId -- string：目标会话（新签名需要）；files -- File[]
     * - 返回值：string[]｜null —— id 数组；两代 API 都不可用时返回 null
     */
    function createDraftAttachments(conversation, sessionId, files) {
      if (!conversation || !Array.isArray(files) || files.length === 0) return null
      __diag.draftCreateApi = null
      try {
        if (typeof conversation.createDrafts === 'function' && sessionId) {
          __diag.draftCreateApi = 'createDrafts'
          const drafts = conversation.createDrafts(sessionId, files)
          return Array.isArray(drafts) ? drafts.map((draft) => draft && draft.id).filter(Boolean) : []
        }
        if (typeof conversation.createDraftImages === 'function') {
          __diag.draftCreateApi = 'createDraftImages'
          const drafts = conversation.createDraftImages(files)
          return Array.isArray(drafts) ? drafts.map((draft) => draft && draft.id).filter(Boolean) : []
        }
      } catch (error) {
        __diag.imageFail = (error && error.message) ? error.message : String(error)
      }
      return null
    }

    /**
     * 释放未被采用的草稿附件（回退失败时不留垃圾草稿）。
     * - 新名 `releaseDraftAttachment(id)`（0.1.5-rc.2 起），旧名 `releaseDraftImage(id)`。
     * - 参数类型：conversation -- object|undefined；id -- string
     * - 返回值：boolean —— true 表示已调用某个世代的释放 API
     */
    function releaseDraftAttachment(conversation, id) {
      if (!conversation || !id) return false
      if (typeof conversation.releaseDraftAttachment === 'function') {
        conversation.releaseDraftAttachment(id)
        return true
      }
      if (typeof conversation.releaseDraftImage === 'function') {
        conversation.releaseDraftImage(id)
        return true
      }
      return false
    }

    /**
     * 把草稿附件 id 交回编辑器（回退后恢复原提问里的图片）。
     * - 新名 `addAttachments(ids)`（0.1.5-rc.2 起），旧名 `addImages(ids)`。
     * - 参数类型：actions -- object|undefined：槽位注入的 inputActions；ids -- string[]
     * - 返回值：boolean —— true 表示已交给某个世代的 API
     */
    function restoreDraftAttachments(actions, ids) {
      if (!actions || !Array.isArray(ids) || ids.length === 0) return false
      if (typeof actions.addAttachments === 'function') {
        __diag.draftRestoreApi = 'addAttachments'
        try { actions.addAttachments(ids); return true } catch { return false }
      }
      if (typeof actions.addImages === 'function') {
        __diag.draftRestoreApi = 'addImages'
        try { actions.addImages(ids); return true } catch { return false }
      }
      __diag.draftRestoreApi = null
      return false
    }

    /** Ordered node list from a 'chat' view snapshot (tolerant of shapes). */
    function chatNodeList(chat) {
      if (!chat) return []
      // Raw ConversationNode[] records path.
      if (chat.legacy) {
        if (Array.isArray(chat.legacy.nodes)) return chat.legacy.nodes.filter(Boolean)
        if (Array.isArray(chat.legacy)) return chat.legacy.filter(Boolean)
      }
      if (Array.isArray(chat)) return chat.filter(Boolean)
      // View-node store path: order keys + nodes.get(key).
      if (Array.isArray(chat.order) && chat.nodes && typeof chat.nodes.get === 'function') {
        const out = []
        for (const key of chat.order) {
          const node = chat.nodes.get(key)
          if (node) out.push(node)
        }
        return out
      }
      return []
    }

    /** One selectable rewind point (a user exchange start). */
    function buildExchanges(list) {
      const out = []
      for (let i = 0; i < list.length; i += 1) {
        const node = list[i]
        if (nodeKind(node) !== 'user') continue
        let anchorSeq = null
        for (let j = i - 1; j >= 0; j -= 1) {
          const prior = list[j]
          if (nodeKind(prior) === 'assistant' && assistantStatusOf(prior) === 'settled') {
            anchorSeq = nodeSeq(prior)
            break
          }
        }
        out.push({
          index: i,
          seq: nodeSeq(node),
          time: nodeTime(node),
          text: nodeText(node),
          imageRefs: nodeImageRefs(node),
          anchorSeq,
          isFirst: i === 0,
        })
      }
      return out
    }

    /** Whether an exchange can be forked to (blank first turn or after a completed turn). */
    function qualifyExchange(ex) {
      if (!ex) return false
      if (ex.isFirst) return true
      return ex.anchorSeq !== null && ex.anchorSeq !== undefined
    }

    /** Newest (chronologically last) user exchange. */
    function lastExchange(list) {
      const exchanges = buildExchanges(list)
      return exchanges.length === 0 ? null : exchanges[exchanges.length - 1]
    }

    /**
     * - 函数功能：取「对话尾部是 assistant 行」时的生命周期状态；尾部不是 assistant 行（例如本轮刚发出的 user 提问）时返回 null，表示本轮尚未定型。
     * - 参数类型：
     *     list: Array -- 会话节点列表，例如 [user(1,'q'), { kind:'assistant', seq:2, interrupted:true }]
     * - 返回值：
     *     retval: string|null -- 'running' | 'settled' | 'interrupted'，或 null（尾部非 assistant / 空列表）
     * - 调用样例：
     *     tailStatus(list) === 'interrupted'   // 该轮被中断（用户停止）
     */
    function tailStatus(list) {
      const tail = list && list.length ? list[list.length - 1] : null
      if (!tail || nodeKind(tail) !== 'assistant') return null
      return assistantStatusOf(tail)
    }

    /**
     * - 函数功能：判断对话尾部是否为「被中断（用户停止）」的 assistant 回复——即宿主写入的耐久停止证据。
     * - 参数类型：
     *     list: Array -- 会话节点列表，例如 [{ kind:'assistant', seq:2, blocks:[…], interrupted:true }]
     * - 返回值：
     *     retval: boolean -- true 表示尾部是带 interrupted 证据的 assistant 行
     * - 调用样例：
     *     tailInterrupted(list) === true
     */
    function tailInterrupted(list) {
      return tailStatus(list) === 'interrupted'
    }

    /**
     * - 函数功能：读「最后一轮」的 turn/end 终态证据（宿主写入、只有该轮真正收尾后才存在），用于区分「用户停止（aborted/user）」与「自然结束（completed/error/…）」；覆盖「尚未产出任何内容即被停」的回合（此时对话里没有 assistant 行）。
     * - 参数类型：
     *     chat: object -- 会话 chat 视图快照，例如 { timeline: { turnOrder:[1,2], turns: Map{…} } }
     * - 返回值：
     *     retval: string|null -- 'aborted:user' | 'aborted:<cause>' | 'completed' | 'error' | 'max-tokens' | 'blocked' | 'interrupted'；缺失或形状不符为 null
     * - 调用样例：
     *     lastTurnEndEvidence(chat) === 'aborted:user'
     *
     * 注意：kind 为 'interrupted' 的是持久化层崩溃修复标记（loop 不产出），不是用户停止。
     */
    function lastTurnEndEvidence(chat) {
      const timeline = chat && chat.timeline
      if (!timeline) return null
      const order = timeline.turnOrder
      const turns = timeline.turns
      if (!Array.isArray(order) || order.length === 0) return null
      if (!turns || typeof turns.get !== 'function') return null
      const turn = turns.get(order[order.length - 1])
      const end = turn && turn.end
      const reason = end && end.data && end.data.reason
      const kind = reason && typeof reason.kind === 'string' ? reason.kind : null
      if (kind === null) return null
      if (kind !== 'aborted') return kind
      const cause = reason.reason && typeof reason.reason.kind === 'string' ? reason.reason.kind : 'unknown'
      return 'aborted:' + cause
    }

    /** Whether the conversation tail ended abnormally, i.e. is NOT a naturally
     *  settled assistant. Running / interrupted / unrecognised / non-assistant
     *  tails (e.g. a just-sent user question without a reply yet) all qualify.
     *  An empty or settled tail does not arm a rewind. */
    function tailUnsettled(list) {
      const tail = list && list.length ? list[list.length - 1] : null
      if (!tail) return false
      if (nodeKind(tail) === 'assistant') return assistantStatusOf(tail) !== 'settled'
      return true
    }

    /**
     * Pure ESC decision. Returns { action, exchange }:
     *   'none'   — let Escape fall through to core (menus/close/etc.).
     *   'stop'   — cancel the running turn (first ESC).
     *   'rewind' — second ESC: stop (if needed) then fork/archive/open/restore.
     */
    function decideEsc(opts) {
      const running = opts && opts.running === true
      const draft = typeof opts.draft === 'string' ? opts.draft : ''
      const list = Array.isArray(opts.list) ? opts.list : []
      const exchange = lastExchange(list)
      const qualified = !!exchange && qualifyExchange(exchange)
      if (running) {
        if (opts.stopIssued === true && qualified) return { action: 'rewind', exchange }
        return { action: 'stop', exchange: qualified ? exchange : null }
      }
      if (qualified && draft === '' && tailUnsettled(list)) {
        // Non-running two-step arming: first ESC arms, second (stopIssued) rewinds.
        if (opts.stopIssued === true) return { action: 'rewind', exchange }
        return { action: 'arm', exchange }
      }
      return { action: 'none', exchange: null }
    }

    /** Short single-line snippet for picker rows. */
    function snippet(text, max) {
      const flat = String(text || '').replace(/\s+/g, ' ').trim()
      if (flat.length <= max) return flat
      return flat.slice(0, max) + '…'
    }

    /** Relative-ish clock label for picker rows. */
    function timeLabel(ms) {
      if (typeof ms !== 'number' || !Number.isFinite(ms)) return ''
      try {
        const date = new Date(ms)
        const now = new Date()
        const sameDay = date.toDateString() === now.toDateString()
        const hh = String(date.getHours()).padStart(2, '0')
        const mm = String(date.getMinutes()).padStart(2, '0')
        if (sameDay) return hh + ':' + mm
        return (date.getMonth() + 1) + '-' + date.getDate() + ' ' + hh + ':' + mm
      } catch {
        return ''
      }
    }

    function imageFileName(mediaType) {
      const ext = { 'image/png': 'png', 'image/jpeg': 'jpg', 'image/webp': 'webp', 'image/gif': 'gif' }
      return 'image.' + (ext[mediaType] || 'png')
    }

    // --- toast fan-out --------------------------------------------------------

    function publishToast(text) {
      for (const listener of [...__toastListeners]) {
        try { listener(text) } catch { /* listener errors never break the turn */ }
      }
    }

    // --- service helpers (guarded, version-tolerant) --------------------------

    function sleep(ms) {
      return new Promise((resolve) => { setTimeout(resolve, ms) })
    }

    function summaryOf(sessionId) {
      try {
        const sessions = __svc.sessions
        if (!sessions || !sessions.list || typeof sessions.list.getSnapshot !== 'function') return null
        const state = sessions.list.getSnapshot()
        const row = state && state.byId ? state.byId[sessionId] : undefined
        return row || null
      } catch { return null }
    }

    function workspaceOf(sessionId) {
      try {
        const workspaces = __svc.workspaces
        if (!workspaces || !workspaces.list || typeof workspaces.list.getSnapshot !== 'function') return null
        const state = workspaces.list.getSnapshot()
        const items = state && Array.isArray(state.items) ? state.items : []
        for (const workspace of items) {
          if (Array.isArray(workspace.sessionIds) && workspace.sessionIds.includes(sessionId)) {
            return workspace.workspaceId
          }
        }
        return null
      } catch { return null }
    }

    function readSnapshot(value) {
      if (!value) return null
      if (typeof value.getSnapshot === 'function') return value.getSnapshot()
      if (typeof value.get === 'function') return value.get()
      return value
    }

    /** Imperative 'chat' snapshot for one session (for the /rewind command). */
    function snapshotChat(sessionId) {
      try {
        const uiConversation = __svc.uiConversation
        if (!uiConversation || typeof uiConversation.binding !== 'function') return null
        const binding = uiConversation.binding(sessionId)
        if (!binding) return null
        const snapshot = readSnapshot(binding.snapshot)
        if (!snapshot || !snapshot.views || typeof snapshot.views.get !== 'function') return null
        return snapshot.views.get('chat') || null
      } catch {
        return null
      }
    }

    function exchangesOfSession(sessionId) {
      return buildExchanges(chatNodeList(snapshotChat(sessionId)))
    }

    function findExchange(sessionId, seq) {
      const matches = exchangesOfSession(sessionId).filter((ex) => String(ex.seq) === String(seq))
      return matches.length ? matches[0] : null
    }

    /** Session-level facts (all guarded, never throws). */
    function sessionFacts(sessionId) {
      try {
        const sessions = __svc.sessions
        if (!sessions) return { hasMore: false, blank: false }
        const binding = sessions.binding(sessionId)
        if (!binding || !binding.session) return { hasMore: false, blank: false }
        const snapshot = typeof binding.session.getSnapshot === 'function' ? binding.session.getSnapshot() : null
        const summary = summaryOf(sessionId)
        return {
          hasMore: !!(snapshot && snapshot.hasMore),
          blank: !!(summary && summary.blank),
        }
      } catch {
        return { hasMore: false, blank: false }
      }
    }

    /** True when the session is a subagent transcript (forking is not offered there). */
    function isSubagentSession(sessionId) {
      const summary = summaryOf(sessionId)
      if (summary && summary.origin === 'subagent') return true
      return false
    }

    /** Wait until the assembled node count stops growing (assembler flush settles). */
    async function waitForSettled(sessionId, timeoutMs) {
      const limit = timeoutMs || 8000
      const started = Date.now()
      let last = -1
      let stable = 0
      for (;;) {
        const count = chatNodeList(snapshotChat(sessionId)).length
        const facts = sessionFacts(sessionId)
        if (count === last) stable += 1
        else { stable = 0; last = count }
        if (stable >= 2 && !facts.hasMore) return true
        if (Date.now() - started > limit) return true
        await sleep(150)
      }
    }

    // --- full-history refresh with load-once + cache --------------------------

    function cacheKey(sessionId) { return CACHE_PREFIX + sessionId }

    function localCacheGet(sessionId) {
      try {
        if (typeof localStorage === 'undefined') return null
        const raw = localStorage.getItem(cacheKey(sessionId))
        if (!raw) return null
        const parsed = JSON.parse(raw)
        if (!parsed || !Array.isArray(parsed.exchanges) || typeof parsed.watermarkSeq !== 'number') return null
        return parsed
      } catch {
        return null
      }
    }

    function localCacheSet(sessionId, entry) {
      try {
        if (typeof localStorage === 'undefined') return
        const serialized = JSON.stringify(entry)
        if (serialized.length > CACHE_MAX_BYTES) return // too big: memory only
        localStorage.setItem(cacheKey(sessionId), serialized)
      } catch {
        /* quota/availability: memory entry still works for this page */
      }
    }

    /** In-memory + (on first touch) localStorage entry for one session. */
    function entryOf(sessionId) {
      const inMemory = __known.get(sessionId)
      if (inMemory) return inMemory
      const persisted = localCacheGet(sessionId)
      if (persisted) __known.set(sessionId, persisted)
      return persisted
    }

    /** Newest user-exchange seq across a chronological list (-1 when none). */
    function maxExchangeSeq(exchanges) {
      let max = -1
      for (const ex of exchanges) {
        const seq = Number(ex && ex.seq)
        if (Number.isFinite(seq) && seq > max) max = seq
      }
      return max
    }

    /** Remember a (chronological) exchange list for a session. */
    function rememberExchanges(sessionId, exchanges, persist) {
      const entry = { watermarkSeq: maxExchangeSeq(exchanges), exchanges }
      __known.set(sessionId, entry)
      if (persist) localCacheSet(sessionId, entry)
      return entry
    }

    /**
     * The best-known full exchange list for /rewind: memory → localStorage →
     * live window (whatever is currently assembled).
     */
    function knownExchangesOf(sessionId) {
      const entry = entryOf(sessionId)
      if (entry && Array.isArray(entry.exchanges)) return entry.exchanges
      return exchangesOfSession(sessionId)
    }

    /** Page-local reset of the full-load flags and caches (diagnostics/tests). */
    function resetHistoryCache() {
      __fullLoaded.clear()
      __known.clear()
    }

    /** Bring the ENTIRE conversation in, but only when needed (load-once). */
    async function refreshHistory(sessionId, signal) {
      const live = exchangesOfSession(sessionId)
      const liveLatest = maxExchangeSeq(live)
      const facts = sessionFacts(sessionId)

      // 1) This page already has the window anchored at the start: the live
      //    snapshot IS the whole history (new messages append at the tail and
      //    are always included). No request, nothing stale.
      if (__fullLoaded.has(sessionId) && !facts.hasMore) {
        const all = exchangesOfSession(sessionId)
        rememberExchanges(sessionId, all, false)
        return { ok: true, exchanges: all, from: 'live' }
      }

      // 2) Short-session fast path: hasMore false AND the very first exchange
      //    is visible → the window already covers everything.
      if (!facts.hasMore && live.some((ex) => ex.isFirst === true)) {
        __fullLoaded.add(sessionId)
        rememberExchanges(sessionId, live, true)
        return { ok: true, exchanges: live, from: 'live' }
      }

      // 3) Fresh record/cache that already reaches the newest exchange: serve
      //    it without touching the host (this is what makes the second open —
      //    and an open after a page reload with no new messages — instant).
      const known = entryOf(sessionId)
      if (known && known.watermarkSeq >= liveLatest && known.watermarkSeq >= 0) {
        return { ok: true, exchanges: known.exchanges, from: 'cache' }
      }

      // 4) No usable record, or the session grew since the record was taken
      //    (watermark older than the newest live exchange): load the whole log
      //    once and merge everything (this is the only "full reload" case).
      const sessions = __svc.sessions
      if (!sessions) return { ok: false, code: 'services-unavailable', exchanges: known ? known.exchanges : [] }
      const binding = sessions.binding(sessionId)
      if (!binding || !binding.session) {
        return { ok: false, code: 'no-binding', exchanges: known ? known.exchanges : [] }
      }
      const face = binding.session
      let all = known ? known.exchanges : []
      try {
        if (typeof face.loadThrough === 'function') {
          await face.loadThrough(0)
        } else {
          let guard = 0
          while (sessionFacts(sessionId).hasMore && guard < MAX_OLDER_PAGES) {
            if (signal && signal.aborted) break
            guard += 1
            await face.loadOlder()
          }
        }
        await waitForSettled(sessionId)
        __diag.historyLoads += 1
        all = exchangesOfSession(sessionId)
        __fullLoaded.add(sessionId)
        rememberExchanges(sessionId, all, true)
        return { ok: true, exchanges: all, from: 'load' }
      } catch (error) {
        return {
          ok: false,
          code: (error && error.message) ? error.message : String(error),
          exchanges: all,
        }
      }
    }

    async function sessionRunning(sessionId) {
      try {
        const sessions = __svc.sessions
        if (!sessions) return false
        const binding = sessions.binding(sessionId)
        if (!binding || !binding.session) return false
        const snapshot = typeof binding.session.getSnapshot === 'function' ? binding.session.getSnapshot() : null
        return !!(snapshot && snapshot.running)
      } catch { return false }
    }

    /** Cancel the running turn and wait until the session is quiescent. */
    async function ensureIdle(sessionId, timeoutMs) {
      const limit = timeoutMs || 8000
      const binding = __svc.sessions && __svc.sessions.binding(sessionId)
      if (!binding || !binding.session) return true
      const face = binding.session
      const running = async () => {
        try {
          const snapshot = typeof face.getSnapshot === 'function' ? face.getSnapshot() : null
          return !!(snapshot && snapshot.running)
        } catch { return false }
      }
      if (!(await running())) return true
      try { await face.cancel() } catch { /* host may already be stopping */ }
      const start = Date.now()
      while (await running()) {
        if (Date.now() - start > limit) return false
        await sleep(120)
      }
      return true
    }

    /**
     * Drop still-pending (queued, unexecuted) messages of this session, best effort.
     * 与 settlePendingInputs 共用同一份来源判定（投影 ∪ 镜像），但不做确认等待；
     * 回退路径请用 settlePendingInputs（它保证删除落在 fork 切点之前）。
     */
    async function clearQueue(sessionId) {
      try {
        const binding = __svc.sessions && __svc.sessions.binding(sessionId)
        if (!binding || !binding.session) return
        const pending = pendingInputsOf(sessionId)
        for (const id of pending.ids) {
          try { await binding.session.updateQueue(id, { kind: 'remove' }) } catch { /* best effort */ }
        }
      } catch { /* best effort */ }
    }

    /** 读取一个会话的当前快照（拿不到就返回 null）。 */
    function sessionSnapshotOf(sessionId) {
      try {
        const binding = __svc.sessions && __svc.sessions.binding(sessionId)
        if (!binding || !binding.session) return null
        if (typeof binding.session.getSnapshot !== 'function') return null
        return binding.session.getSnapshot() || null
      } catch { return null }
    }

    /**
     * 一个会话此刻「未落定输入」的全量清单（三个来源缺一不可）：
     *   1) 宿主 inbox 投影 `{'next-turn','next-step'}`——0.1.5 起收件箱是**耐久投影**
     *      （fold `agent/inbox/spliced`），随页面 baseline 与 `projection` 帧下发；fork 的
     *      事件种子正是这份状态长出来的，所以它是「种子会带出什么」的第一现场。
     *   2) queue 镜像 `snapshot.queue`——宿主只在「有活跃 agent 且 session 匹配」时才广播
     *      `{type:'queue'}` 帧（旧核心唯一来源），投影缺席时靠它兜底。
     *   3) 本地未对账回声 `snapshot.pendingSubmissions`——刚按下回车、宿主还没接收的那一瞬
     *      （「等待队列」UI 就是拿它渲染的）；此刻 fork，随后落盘的插入事件仍可能被切进种子。
     *
     * - 参数类型：sessionId -- string
     * - 返回值：
     *     retval: object -- { ids, sources, echoes }
     *       ids     -- string[]，可直接交给 updateQueue(id,{kind:'remove'}) 的宿主条目 id
     *       sources -- string[]，命中的来源名（'inbox-projection' | 'queue-mirror' | 'echo'）
     *       echoes  -- number，尚未对账的本地回声条数（没有宿主 id，只能等它落定）
     * - 调用样例：
     *     const p = pendingInputsOf('session-x'); p.ids.length === 0 && p.echoes === 0
     */
    function pendingInputsOf(sessionId) {
      const ids = []
      const sources = []
      const noteSource = (source) => { if (sources.indexOf(source) < 0) sources.push(source) }
      const push = (id) => {
        if (typeof id !== 'string' || id === '' || ids.indexOf(id) >= 0) return
        ids.push(id)
      }
      let binding = null
      try { binding = __svc.sessions && typeof __svc.sessions.binding === 'function' ? __svc.sessions.binding(sessionId) : null } catch { binding = null }
      const session = binding && binding.session ? binding.session : null
      // 1) 宿主 inbox 投影（新核心；无条件广播，最可靠）。值缺席 = 这一代核心没有该能力。
      try {
        const projections = session && session.projections ? session.projections : null
        const face = projections && typeof projections.faceOf === 'function' ? projections.faceOf('inbox') : null
        const value = face && typeof face.getSnapshot === 'function' ? face.getSnapshot() : null
        if (value && typeof value === 'object') {
          noteSource('inbox-projection')
          if (!__inboxProjectionSeen) { __inboxProjectionSeen = true; __diag.inboxProjectionSeen = true }
          for (const target of ['next-turn', 'next-step']) {
            const rows = Array.isArray(value[target]) ? value[target] : []
            for (const row of rows) if (row) push(row.id)
          }
        }
      } catch { /* 形状容错：下一来源顶上 */ }
      // 2) queue 镜像行 + 3) 本地回声的对账判定（同一份快照）。
      const snapshot = sessionSnapshotOf(sessionId)
      let echoes = 0
      try {
        const rows = snapshot && Array.isArray(snapshot.queue) ? snapshot.queue : []
        for (const row of rows) {
          if (!row) continue
          push(row.id)
          noteSource('queue-mirror')
        }
        const admitted = new Set()
        for (const row of rows) if (row && typeof row.rpcId === 'string') admitted.add(row.rpcId)
        const pendingSubmissions = snapshot && Array.isArray(snapshot.pendingSubmissions) ? snapshot.pendingSubmissions : []
        for (const echo of pendingSubmissions) {
          if (!echo) continue
          if (echo.placement !== 'queued' && echo.placement !== 'steering') continue
          if (typeof echo.requestId === 'string' && admitted.has(echo.requestId)) continue
          echoes += 1
        }
        if (echoes > 0) noteSource('echo')
      } catch { /* 形状容错 */ }
      return { ids, sources, echoes }
    }

    /**
     * 把会话的「未落定输入」清干净并**确认**清空——回退前必须做，否则 fork 的
     * 事件种子会把这条 pending 输入一起复制进子会话（实测：子会话会执行它，
     * 而用户新发的那条排队等待，看起来就像同一条消息被执行了又被挂起）。
     *
     * 为什么必须「确认」而不是「发一次删除就算」：删除要作为事件落进宿主日志，
     * 且必须落在 fork 切点**之前**，子会话重放种子时才看不到这条插入。
     *
     * - 参数类型：
     *     sessionId -- string
     *     options.budgetMs -- number|undefined：有界等待预算（默认 1500ms）
     *     options.requireProjectionMs -- number|undefined：额外等 inbox 投影出现的宽限
     *       （ms，0/缺省 = 不等）；用于刚 open 的子会话——它的投影随页面 baseline 到，
     *       等不到就退回 queue 镜像判定（等价旧行为，不更差）。
     * - 返回值：
     *     retval: { cleared, remaining, empty, sources, waitedMs } —— cleared=已请求删除的
     *       条数；remaining=预算用尽后仍未落定的条数；empty=是否已确认空；
     *       sources=命中来源；waitedMs=实际等待毫秒数
     */
    async function settlePendingInputs(sessionId, options) {
      const opts = options || {}
      const budgetMs = typeof opts.budgetMs === 'number' ? opts.budgetMs : 1500
      const projectionGraceMs = typeof opts.requireProjectionMs === 'number' ? opts.requireProjectionMs : 0
      const stepMs = 60
      const started = Date.now()
      const deadline = started + budgetMs
      let cleared = 0
      const sources = []
      for (;;) {
        const pending = pendingInputsOf(sessionId)
        for (const source of pending.sources) if (sources.indexOf(source) < 0) sources.push(source)
        const projectable = sources.indexOf('inbox-projection') >= 0
        // 投影还没到时不能宣布「干净」：种子里的继承项只在那份投影里可见。
        const confirmable = projectionGraceMs <= 0 || projectable || (Date.now() - started) >= projectionGraceMs
        if (pending.ids.length === 0 && pending.echoes === 0 && confirmable) {
          return { cleared, remaining: 0, empty: true, sources, waitedMs: Date.now() - started }
        }
        for (const id of pending.ids) {
          try {
            const binding = __svc.sessions && __svc.sessions.binding(sessionId)
            if (binding && binding.session) {
              await binding.session.updateQueue(id, { kind: 'remove' })
              cleared += 1
            }
          } catch { /* 单条失败不阻断：下一轮重试 */ }
        }
        if (Date.now() >= deadline) {
          const after = pendingInputsOf(sessionId)
          const left = after.ids.length + after.echoes
          return { cleared, remaining: left, empty: left === 0, sources, waitedMs: Date.now() - started }
        }
        await sleep(stepMs)
      }
    }

    /**
     * Switch the UI to a session. The verb MOVED in 0.2.0: it used to be
     * sessions.open(id), but the sessions face no longer carries it (it exposes
     * binding/fork/create/scope/search/retain/using) — the switch verb is now
     * uiWorkspace.openSession(target). Probed by capability at call time (never
     * by version number), and the reason is kept in __diag so callers can report
     * something readable instead of a "sessions.open is not a function" TypeError.
     */
    function openSessionInUi(childId) {
      const ui = __svc.uiWorkspace
      if (ui && typeof ui.openSession === 'function') {
        try { ui.openSession(childId); return true } catch (error) {
          __diag.openFail = (error && error.message) ? error.message : String(error)
          return false
        }
      }
      const sessions = __svc.sessions
      // 0.1.x hosts: the verb still lives on the sessions face.
      if (sessions && typeof sessions.open === 'function') {
        try { sessions.open(childId); return true } catch (error) {
          __diag.openFail = (error && error.message) ? error.message : String(error)
          return false
        }
      }
      __diag.openFail = 'no session-switch channel (uiWorkspace.openSession / sessions.open)'
      return false
    }

    // --- the rewind engine ----------------------------------------------------

    /**
     * Rewind one session to just before a user exchange: cancel + clear the
     * queue, resolve images best-effort, fork (or create a fresh session for
     * the first exchange), keep the title, archive the original, open the
     * child, and queue a pending composer restore for the child.
     */
    async function doRewind(sessionId, exchange) {
      const sessions = __svc.sessions
      const workspaces = __svc.workspaces
      if (!sessions || !workspaces) return { ok: false, code: 'services-unavailable' }
      if (__busy.has(sessionId)) return { ok: false, code: 'busy' }
      __busy.add(sessionId)
      try {
        const binding = sessions.binding(sessionId)
        if (!binding) return { ok: false, code: 'no-binding' }
        const idle = await ensureIdle(sessionId)
        if (!idle) return { ok: false, code: 'stop-timeout' }
        // 未落定输入必须先清掉并**确认**为空再 fork：宿主的 fork 用事件种子重建子
        // 会话，父会话里那条刚发出、还没落盘的排队输入会被一并复制过去，于是子会话
        // 会先执行它，而用户此刻新发的消息只能排队（真机实测的「一条在执行、一条在
        // 等待、内容相同」）。清不掉就放弃本次回退，宁可不回退也不复制一份输入。
        const settled = await settlePendingInputs(sessionId)
        __diag.pendingCleared = settled.cleared
        __diag.pendingSource = settled.sources.length ? settled.sources.join('+') : null
        __diag.pendingConfirmMs = settled.waitedMs
        if (!settled.empty) {
          __diag.pendingBlocked = true
          __diag.lastGate = 'pending-input'
          publishToast(__t('rewind.pending'))
          return { ok: false, code: 'pending-input' }
        }
        __diag.pendingBlocked = false

        // Best-effort image restore (D11): durable refs -> bytes -> draft files.
        let imageDraftIds = []
        const imageRefs = exchange && Array.isArray(exchange.imageRefs) ? exchange.imageRefs : []
        if (imageRefs.length > 0 && __svc.conversation
          && (typeof __svc.conversation.createDrafts === 'function'
            || typeof __svc.conversation.createDraftImages === 'function')
          && typeof File !== 'undefined') {
          const files = []
          try {
            for (const ref of imageRefs.slice(0, MAX_IMAGES)) {
              if (!ref || !ref.attachmentId) continue
              const result = await binding.session.readAttachment(ref.attachmentId).catch(() => null)
              if (!result || !result.ok || !result.value) continue
              const attachment = result.value.attachment || {}
              const data = result.value.data
              const name = attachment.name || imageFileName(ref.mediaType || attachment.mediaType)
              files.push(new File([data], name, { type: attachment.mediaType || 'image/png' }))
            }
          } catch (error) {
            __diag.imageFail = (error && error.message) ? error.message : String(error)
          }
          imageDraftIds = createDraftAttachments(__svc.conversation, sessionId, files) || []
        }

        // 分支会话 id：fork/create 之后才能知道，catch 里要用它撤掉已武装的还原。
        let childId = null
        try {
          const oldSummary = summaryOf(sessionId)
          const oldTitle = oldSummary ? (oldSummary.title || oldSummary.displayTitle) : null
          if (exchange.isFirst === true) {
            // First-exchange edge (D9/D18): no history to fork — new blank
            // session in the same workspace.
            const workspaceId = workspaceOf(sessionId)
            childId = workspaceId
              ? await sessions.create({ workspaceId })
              : await sessions.create()
          } else {
            childId = await sessions.fork({ sessionId, atSeq: exchange.anchorSeq, increaseTitle: false })
          }
          // Keep the original title on the branch (D10).
          if (oldTitle) {
            try {
              const childSummary = summaryOf(childId)
              const childTitle = childSummary ? (childSummary.title || childSummary.displayTitle) : null
              if (childTitle && childTitle !== oldTitle) {
                const childBinding = sessions.binding(childId)
                if (childBinding) await childBinding.session.rename(oldTitle)
              }
            } catch (error) {
              __diag.titleFail = (error && error.message) ? error.message : String(error)
            }
          }
          // 先武装还原、再 open（理由见 armPendingRestore）。__pending 按 childId 键控，
          // 父会话的桥不会消费它，所以提前武装是安全的。
          armPendingRestore(childId, (exchange && exchange.text) || '', imageDraftIds)
          // Open the branch BEFORE disposing the original: opening the child
          // first means the archive/delete only affects the original (never
          // clears the current selection out from under the user).
          // 切换会话的动词：0.2.0 起是 uiWorkspace.openSession（sessions.open 已不存在）。
          // 切不过去就不再往下走：原会话保持不动（不归档/删除），撤掉刚武装的还原与
          // 已建草稿，把原因交回调用方转成提示，而不是抛 "not a function" 的 TypeError。
          if (!openSessionInUi(childId)) {
            clearPendingRestore(childId)
            if (imageDraftIds.length > 0 && __svc.conversation) {
              try { for (const id of imageDraftIds) releaseDraftAttachment(__svc.conversation, id) } catch { /* noop */ }
            }
            publishToast(__t('rewind.open.fail'))
            return { ok: false, code: 'open-unavailable' }
          }
          // 兜底，且这是主因：0.1.5 的 fork 种子 = 父会话 [0, cut)，cut 从边界 turn/end
          // 一路走到**下一个 turn/start**；被回退那条消息的 inbox 插入事件恰好排在它的
          // turn/start 之前、claim 之后 ⇒ 种子必然带出一条继承来的 pending 旧消息。
          // 它不在父会话的队列里（早就被 claim 了），只能打开分支后按投影+镜像清掉；
          // 否则用户再发消息时 agent 先执行这条旧的，新消息只能排队。
          const childSettled = await settlePendingInputs(childId, {
            budgetMs: 900,
            // 见过 inbox 投影的核心才值得为它多等一个宽限（见 __inboxProjectionSeen）。
            requireProjectionMs: __inboxProjectionSeen ? CHILD_PROJECTION_GRACE_MS : 0,
          })
          __diag.childPendingCleared = childSettled.cleared
          __diag.childPendingSource = childSettled.sources.length ? childSettled.sources.join('+') : null
          __diag.childPendingConfirmMs = childSettled.waitedMs
          // Dispose the original AFTER the child exists (D8) and — in delete
          // mode — only after the branch is confirmed open & usable (D7). A
          // failed delete degrades to archive; a failed archive is recorded.
          if (deleteModeOn()) {
            await deleteOldSession(sessionId)
          } else {
            // 0.2.0 起 archiveSession 返回 RemoteResult 且默认拒绝「仍活跃」的会话，
            // 旧的 try/catch 写法会静默失败 —— 见 archiveOldSession 的桥接。
            const archived = await archiveOldSession(sessionId)
            if (!archived.ok) {
              publishToast(__t('rewind.archive.fail', { msg: archived.message || archived.code || 'unknown' }))
            }
          }
          __diag.rewinds += 1
          __diag.lastRewind = { from: sessionId, to: childId, seq: exchange ? exchange.seq : null }
          return { ok: true, childId }
        } catch (error) {
          // The branch never became usable: drop the staged restore and release
          // the drafts we created but never delivered.
          clearPendingRestore(childId === null ? undefined : childId)
          if (imageDraftIds.length > 0 && __svc.conversation) {
            try { for (const id of imageDraftIds) releaseDraftAttachment(__svc.conversation, id) } catch { /* noop */ }
          }
          throw error
        }
      } finally {
        __busy.delete(sessionId)
      }
    }

    /**
     * Stage a composer restore for the just-forked branch (applied on mount).
     * **必须在切换会话（openSessionInUi）之前调用**：open 会立刻触发 React 提交，子会话的桥
     * 先挂载，而挂载 effect 读到的 __pending 仍是 null；只靠挂载那一刻去看，这次还原就永远
     * 丢了（真机「回退后文字没回到输入框」的成因之一）。武装时同时广播一次，让已经挂载的
     * 桥也能补跑。
     */
    function armPendingRestore(sessionId, text, imageDraftIds) {
      __pending = { sessionId, text, imageDraftIds, stagedAt: Date.now() }
      __diag.pendingApplied = 0
      __diag.pendingStaged += 1
      __diag.pendingDropped = null
      for (const listener of [...__pendingListeners]) {
        try { listener(__pending) } catch { /* 单个订阅者出错不影响其他人 */ }
      }
      if (typeof setTimeout === 'function') {
        setTimeout(() => {
          if (__pending && __pending.sessionId === sessionId) __pending = null
        }, PENDING_TTL_MS)
      }
    }

    /** Drop a staged restore (branch never opened / rewind failed after arming). */
    function clearPendingRestore(sessionId) {
      if (!__pending) return
      if (sessionId === undefined || __pending.sessionId === sessionId) __pending = null
    }

    function issueStop(sessionId, exchange) {
      try {
        const binding = __svc.sessions && __svc.sessions.binding(sessionId)
        if (binding && binding.session && typeof binding.session.cancel === 'function') {
          binding.session.cancel().catch(() => { /* host already quiescent */ })
        }
      } catch { /* noop */ }
      if (exchange) __stopMarks.set(sessionId, exchange.seq)
    }

    // --- delete mode: settings read/write + host delete channel ----------------

    /**
     * Safely resolve the client remote.settings controller from any scope.
     * EVERY candidate gets its OWN try: a real guarded cordis context THROWS
     * on an uninjected bare property (`cannot get property "settings" without
     * inject`), so one shared try would abort after the first candidate and
     * never reach `ctx.remote.settings` — the exact bug this reader avoids.
     * Candidate order mirrors core's ui-settings usage (`ctx.remote.settings`)
     * and the sibling plugin's `get('remote.settings')` fallback.
     */
    function readRemoteSettings(scope) {
      if (!scope) return null
      // 1) sub.get('remote.settings') — an injected dotted name answers.
      try {
        if (typeof scope.get === 'function') {
          const viaGet = scope.get('remote.settings')
          if (viaGet) return viaGet
        }
      } catch { /* unmounted name: next candidate */ }
      // 2) literal dotted key — how a scope can mount an injected dotted name.
      try {
        const viaKey = scope['remote.settings']
        if (viaKey) return viaKey
      } catch { /* guarded */ }
      // 3) remote root, then its `settings` controller.
      let remote = null
      try {
        if (typeof scope.get === 'function') remote = scope.get('remote') || null
      } catch { /* not injected on this scope */ }
      if (!remote) {
        try { remote = scope.remote || null } catch { /* guarded */ }
      }
      if (remote) {
        try {
          const viaRemote = remote.settings || null
          if (viaRemote) return viaRemote
        } catch { /* guarded */ }
      }
      // 4) nested `scope.remote.settings` (same object, different mount).
      try {
        if (scope.remote && scope.remote.settings) return scope.remote.settings
      } catch { /* guarded */ }
      // 4b) short service name on scopes that mount the controller directly.
      try {
        if (typeof scope.get === 'function') {
          const shortGet = scope.get('settings')
          if (shortGet && typeof shortGet.describe === 'function') return shortGet
        }
      } catch { /* not injected here */ }
      // 5) bare `scope.settings` last: on a guarded ctx this is the candidate
      //    most likely to throw, and it must not short-circuit 1–4 above.
      try {
        const viaProp = scope.settings || null
        if (viaProp && typeof viaProp.describe === 'function') return viaProp
      } catch { /* guarded */ }
      return null
    }

    /** Unwrap a typert RemoteResult envelope ({ok,value}|{ok:false,error}). */
    function unwrapResult(response) {
      if (response && typeof response === 'object' && 'ok' in response) {
        if (response.ok === false) {
          const err = response.error
          const msg = (err && (err.message || err.code)) || 'settings-request-failed'
          const failure = new Error(String(msg))
          failure.remoteError = err || null
          throw failure
        }
        return Object.prototype.hasOwnProperty.call(response, 'value') ? response.value : response
      }
      return response
    }

    /** Read the delete-mode switch from remote.settings (falls back to false). */
    async function loadDeleteMode() {
      __deleteMode = false
      try {
        const settings = __settings
        if (!settings || typeof settings.describe !== 'function') {
          __deleteModeLoaded = true
          return false
        }
        const view = unwrapResult(await settings.describe())
        const namespaces = view && Array.isArray(view.namespaces) ? view.namespaces : []
        const row = namespaces.find((entry) => entry && entry.ns === SETTINGS_NS)
        const value = row && row.value && typeof row.value === 'object' ? row.value[SETTINGS_FIELD] : undefined
        __deleteMode = value === true
        __deleteModeLoaded = true
        __diag.deleteMode = __deleteMode
        __diag.deleteModeLoaded = true
      } catch (error) {
        // Any failure lands on the safe side: archive, never delete.
        __deleteMode = false
        __deleteModeLoaded = true
        __diag.deleteMode = false
        __diag.deleteModeLoaded = true
        __diag.settingsReadFail = (error && error.message) ? error.message : String(error)
      }
      notifyDisposeListeners()
      return __deleteMode
    }

    /** Persist the switch through remote.settings (never deletes on failure). */
    async function setDeleteMode(next) {
      const previous = __deleteMode
      const want = next === true
      try {
        const settings = __settings
        if (!settings || typeof settings.update !== 'function') {
          throw new Error('settings-unavailable')
        }
        unwrapResult(await settings.update(SETTINGS_NS, { [SETTINGS_FIELD]: want }, undefined))
        __deleteMode = want
        __deleteModeLoaded = true
        __diag.deleteMode = __deleteMode
        __diag.disposeToggles += 1
        notifyDisposeListeners()
        publishToast(__t(want ? 'dispose.on' : 'dispose.off'))
        return { ok: true }
      } catch (error) {
        // The write failed (or was refused): restore the displayed mode.
        __deleteMode = previous
        __diag.deleteFail = (error && error.message) ? error.message : String(error)
        publishToast(__t('dispose.error', { msg: __diag.deleteFail }))
        notifyDisposeListeners()
        return { ok: false, code: __diag.deleteFail }
      }
    }

    /** Notify mounted header icons (and diagnostics) that the switch changed. */
    function notifyDisposeListeners() {
      for (const listener of [...__disposeListeners]) {
        try { listener() } catch { /* listener errors never break the switch */ }
      }
    }

    /**
     * Permanently delete one session through the host half. Called ONLY after
     * the new branch is open and usable (see doRewind); a failure degrades to
     * archiving the old session so nothing is ever lost to a failed delete.
     * The host refuses (409 + reason) while the session still owns subagent
     * children — a child is reachable only through its own header, so the parent
     * log is the single handle it has — and that refusal gets its own toast.
     * Returns { deleted, archived, blocked } — blocked carries the host reason.
     */
    /**
     * 归档原会话（回退的默认处置）。
     *
     * 0.2.0 的两处契约变化，0.1.x 的写法（只 catch 异常）在 0.2.0 上会**静默失败**：
     *   1. `workspaces.archiveSession(id, options?)` 返回 RemoteResult
     *      （`{ok:true,value}` / `{ok:false,error}`），**被拒绝时不抛异常** ——
     *      只 catch 不检查返回值 = 归档没发生却当成功；
     *   2. 仍有运行中工作的会话默认被拒绝（`WorkspaceActiveSessionError` →
     *      `workspace/session-active`），要带 `{ stopActivity: true }` 才会
     *      「停止并归档」—— 与核心「归档会话」确认框的 stopAndArchiveSession 同款语义。
     * 回退本来就是要放弃原会话，所以命中「仍活跃」时补一次 stopActivity 重试；
     * 其余拒绝如实记录并让调用方提示，绝不静默。
     * - 参数类型：sessionId -- string：被回退的原会话。
     * - 返回值：Promise<{ok, code, message, stopped}>；stopped 表示走了重试。
     * - 调用样例：const archived = await archiveOldSession('session-…')
     */
    async function archiveOldSession(sessionId) {
      const workspaces = __svc.workspaces
      if (!workspaces || typeof workspaces.archiveSession !== 'function') {
        return { ok: false, code: 'archive-unavailable', message: null, stopped: false }
      }
      const attempt = async (options) => {
        const result = options === undefined
          ? await workspaces.archiveSession(sessionId)
          : await workspaces.archiveSession(sessionId, options)
        // 0.2.0：拒绝走返回值；0.1.x：旧实现直接抛（下方 catch 同一处理）。
        if (result && typeof result === 'object' && 'ok' in result && result.ok === false) {
          const failure = new Error(String((result.error && (result.error.message || result.error.code)) || 'archive-failed'))
          failure.code = (result.error && result.error.code) || null
          throw failure
        }
        return result
      }
      try {
        await attempt(undefined)
        __diag.archiveFail = null
        __diag.archiveStopActivity = false
        return { ok: true, code: null, message: null, stopped: false }
      } catch (error) {
        const code = (error && error.code) || null
        const message = (error && error.message) ? String(error.message) : String(error)
        const active = code === 'workspace/session-active' || /session-active|running work/i.test(message)
        if (!active) {
          __diag.archiveFail = message
          return { ok: false, code, message, stopped: false }
        }
        try {
          await attempt({ stopActivity: true })
          __diag.archiveFail = null
          __diag.archiveStopActivity = true
          return { ok: true, code: null, message: null, stopped: true }
        } catch (retryError) {
          __diag.archiveFail = (retryError && retryError.message) ? String(retryError.message) : String(retryError)
          return { ok: false, code: (retryError && retryError.code) || null, message: __diag.archiveFail, stopped: false }
        }
      }
    }
    async function deleteOldSession(sessionId) {
      let deleted = false
      let blocked = null
      try {
        if (typeof fetch !== 'function') throw new Error('fetch-unavailable')
        const response = await fetch(DELETE_ENDPOINT, {
          method: 'POST',
          headers: { 'content-type': 'application/json' },
          body: JSON.stringify({ sessionId }),
        })
        const body = await response.json().catch(() => ({}))
        if (!response.ok || body.ok !== true) {
          if (body && typeof body.reason === 'string') {
            blocked = {
              reason: body.reason,
              children: Number(body.children) || 0,
              running: Number(body.running) || 0,
            }
          }
          throw new Error(body.error || ('delete-failed-' + response.status))
        }
        deleted = true
        __diag.lastDelete = { sessionId, ok: true }
      } catch (error) {
        __diag.deleteFail = (error && error.message) ? error.message : String(error)
        __diag.lastDelete = {
          sessionId,
          ok: false,
          error: __diag.deleteFail,
          reason: blocked ? blocked.reason : null,
          children: blocked ? blocked.children : null,
          running: blocked ? blocked.running : null,
        }
      }
      if (deleted) {
        publishToast(__t('rewind.deleted'))
        return { deleted: true, archived: false, blocked: null }
      }
      // Degrade: keep the old session recoverable instead of leaving a half state.
      const fallback = await archiveOldSession(sessionId)
      const archived = fallback.ok
      if (blocked && blocked.reason === REASON_SUBAGENTS) {
        publishToast(__t('rewind.subagents', { n: blocked.children, r: blocked.running }))
      } else if (blocked && blocked.reason === REASON_SUBAGENTS_UNKNOWN) {
        publishToast(__t('rewind.subagents.unknown', { msg: __diag.deleteFail }))
      } else {
        publishToast(__t('rewind.delete.fail'))
      }
      return { deleted: false, archived, blocked: blocked ? blocked.reason : null }
    }

    /** True when delete mode is armed (safe default: archive). */
    function deleteModeOn() {
      return __deleteMode === true
    }

    // --- 核心世代探测（命令描述契约） ----------------------------------------

    /**
     * 标记「核心 ≥ 0.1.5-rc.2 的命令契约（description 为函数）」。
     * - 参数类型：无（幂等；重复调用只覆盖同一个标志）
     * - 返回值：无
     */
    function markModernCore() {
      __commandDescShape = 'function'
      __diag.commandDescShape = 'function'
    }

    /**
     * 探测核心世代。**不读版本号**，只用 0.1.5-rc.2 起才存在的两个能力信号：
     * 1) 新增的 `main.conversation` 槽位注册成功；
     * 2) 槽位标准 props 里出现 `useResource` / `usePanelInfo`（由 EscBridge 上报）。
     * 任一成立即判定新契约。信号都缺席时保持旧契约（安全默认：旧核心把
     * description 当值渲染，函数会抛 "Functions are not valid as a React child"）。
     * - 参数类型：ctx -- 客户端 cordis 上下文
     * - 返回值：无
     */
    function probeCoreGeneration(ctx) {
      try {
        ctx.slots.inject('main.conversation', () => markModernCore())
      } catch { /* 旧核心没有这个槽位：保持旧契约 */ }
    }

    // --- /rewind contribution (ctx.commandUi popupSelect, full history) -------

    function registerRewindContribution(commandUi) {
      try {
        const disposer = commandUi.register({
          name: REWIND_COMMAND,
          // 契约双代兼容：旧核心读这个属性当字符串渲染，新核心读到的值必须是函数。
          // 用 getter 在「读取时」决定形态，所以探测晚于注册也没关系。
          get description() {
            if (__commandDescShape === 'function') return () => __t('rewind.cmd.desc')
            return __t('rewind.cmd.desc')
          },
          // Availability is decoupled from the loaded history window: a normal
          // (non-subagent, non-blank) session can always open /rewind, which
          // reads the whole history before showing the options.
          available: (session) => {
            try {
              if (!session || !session.sessionId) { __diag.rewindAvail = { reason: 'no-session' }; return false }
              if (isSubagentSession(session.sessionId)) { __diag.rewindAvail = { reason: 'subagent' }; return false }
              if (sessionFacts(session.sessionId).blank) { __diag.rewindAvail = { reason: 'blank' }; return false }
              __diag.rewindAvail = { reason: 'ok' }
              return true
            } catch (error) {
              __diag.rewindAvail = { reason: 'error', msg: (error && error.message) ? error.message : String(error) }
              return false
            }
          },
          ui: {
            kind: 'popupSelect',
            options: async (session, signal) => {
              const sessionId = session && session.sessionId
              if (!sessionId) return []
              // Load-once: only the first open (per page, or after the session
              // grew past a cached record) hits the host; repeats read the
              // live window / cache. The shell shows its native loading status
              // on that first call.
              const loaded = await refreshHistory(sessionId, signal)
              if (!loaded.ok) publishToast(__t('rewind.load.fail', { msg: loaded.code || 'unknown' }))
              const exchanges = (loaded.exchanges || [])
                .filter(qualifyExchange)
                .reverse()
              return exchanges.map((ex, index) => ({
                id: String(ex.seq) + ':' + index,
                value: String(ex.seq),
                label: snippet(ex.text, 72) || __t('rewind.image.only'),
                detail: [
                  __t('rewind.round', { n: String(index + 1) }),
                  timeLabel(ex.time),
                ].filter(Boolean).join(' · '),
              }))
            },
            onSelect: async (option, session) => {
              const sessionId = session && session.sessionId
              if (!sessionId || !option || option.value === undefined) return
              // Look the exchange up in the same record the options were built
              // from (covers exchanges the current chat window does not hold).
              const exchange = knownExchangesOf(sessionId)
                .filter(qualifyExchange)
                .find((ex) => String(ex.seq) === String(option.value))
              if (!exchange) return
              publishToast(__t('rewind.busy'))
              const result = await doRewind(sessionId, exchange)
              if (!result.ok) {
                publishToast(__t('rewind.error', { msg: result.code || 'unknown' }))
              }
            },
          },
        })
        __diag.services.commandUi = true
        return disposer
      } catch (error) {
        __diag.lastGate = 'contribution:' + ((error && error.message) ? error.message : String(error))
        return null
      }
    }

    // --- the bridge component -------------------------------------------------

    function EscBridge({ sessionId, useSession, useConversation, useInput, inputActions, t: seatT, usePanelInfo, useResource }) {
      const t = typeof seatT === 'function' ? seatT : __t
      // 世代探测的第二信号：0.1.5-rc.2 起槽位会额外下发这两个标准 props。
      if (typeof usePanelInfo === 'function' || typeof useResource === 'function') markModernCore()

      const session = useSession ? useSession((s) => s) : undefined
      const running = !!(session && session.running)
      const subagent = !!(session && session.subagent)
      const chat = useConversation
        ? useConversation((s) => (s && s.views && typeof s.views.get === 'function' ? s.views.get('chat') : undefined))
        : undefined
      const list = useMemo(() => chatNodeList(chat), [chat])
      const exchanges = useMemo(() => buildExchanges(list), [list])
      const target = exchanges.length ? exchanges[exchanges.length - 1] : null
      // 提示判据所需的两份「耐久证据」（都是原始值，便于放进 effect 依赖）：
      // 尾部 assistant 行的状态，以及最后一轮 turn/end 的终态。
      const tailState = tailStatus(list)
      const roundEnd = lastTurnEndEvidence(chat)
      const input = useInput ? useInput((s) => s) : undefined
      const draft = input && typeof input.draft === 'string' ? input.draft : ''

      __diag.mounted += 1
      __diag.services.sessions = !!__svc.sessions
      __diag.services.workspaces = !!__svc.workspaces
      __diag.services.conversation = !!__svc.conversation
      __diag.services.uiConversation = !!__svc.uiConversation

      // Refs the document listener reads (fresh on every render).
      const sessionRef = useRef(sessionId)
      sessionRef.current = sessionId
      const runningRef = useRef(running)
      runningRef.current = running
      const subagentRef = useRef(subagent)
      subagentRef.current = subagent
      const listRef = useRef(list)
      listRef.current = list
      const targetRef = useRef(target)
      targetRef.current = target
      const draftRef = useRef(draft)
      draftRef.current = draft
      const tRef = useRef(t)
      tRef.current = t
      const stopMarkRef = useRef(null)
      // One-hint-per-exchange guard (ESC stop and toolbar-Stop both arm; the
      // armed-tail effect must not re-toast what the ESC handler already did).
      const hintedRef = useRef(null)
      // 上一次 running→idle 下降沿记下的「候选回合」＝该回合首个 user 节点的 seq。
      // 下降沿只证明「本会话刚结束了一轮」，并不证明它是被停止的（自然结束同形），
      // 因此这里只记候选，等本轮定型（尾部出现 assistant 行 / turn/end 落定）后再结算。
      const stopCandidateRef = useRef(null)
      // Track the previous render's running flag so the post-stop hint can only
      // be considered after a running→idle falling edge in this session — never
      // when just switching into an already-unsettled session (running stays
      // false the whole time, so there is no edge).
      const prevRunningRef = useRef(null)

      const [toast, setToast] = useState(null)
      const toastSeq = useRef(0)
      const showToast = useCallback((text) => {
        if (!Toast) return
        toastSeq.current += 1
        setToast({ seq: toastSeq.current, text })
      }, [])

      // Subscribe to cross-entry toast fan-out (keyboard + /rewind onSelect).
      useEffect(() => {
        __toastListeners.add(showToast)
        return () => { __toastListeners.delete(showToast) }
      }, [showToast])

      // Reset per-session state when the active session changes.
      useEffect(() => {
        stopMarkRef.current = null
        prevRunningRef.current = null
        stopCandidateRef.current = null
      }, [sessionId])

      // The single document capture listener for this session's lifetime.
      useEffect(() => {
        if (typeof document === 'undefined' || typeof document.addEventListener !== 'function') {
          return undefined
        }
        const onKey = (event) => {
          if (!event || event.key !== 'Escape') return
          if (event.isComposing === true || event.keyCode === 229) { __diag.lastGate = 'composing'; return }
          if (event.shiftKey || event.ctrlKey || event.altKey || event.metaKey) { __diag.lastGate = 'modifier'; return }
          if (subagentRef.current) { __diag.lastGate = 'subagent'; return }

          // ESC layering: any open overlay/menu/dialog or a foreign text field
          // keeps this Escape for core (close the overlay), never hijacked.
          if (hasOpenOverlay(event)) { __diag.lastGate = 'overlay'; return }

          const stopIssued = stopMarkRef.current === (targetRef.current && targetRef.current.seq)
          // decideEsc 内部用 listRef 实时重算「尾部非 settled」，不再传渲染期快照
          // （旧代码传的 unsettled 参数在函数体内从未被读取，属死参数）。
          const decision = decideEsc({
            running: runningRef.current,
            draft: draftRef.current,
            list: listRef.current,
            stopIssued,
          })

          if (decision.action === 'none') { __diag.lastGate = 'idle-or-settled'; return }

          const consume = () => {
            try { event.preventDefault() } catch { /* synthetic */ }
            try { event.stopPropagation() } catch { /* synthetic */ }
          }

          if (decision.action === 'stop') {
            consume()
            __diag.escStops += 1
            __diag.lastAction = 'stop'
            __diag.lastGate = 'esc-stop'
            stopMarkRef.current = targetRef.current ? targetRef.current.seq : null
            if (targetRef.current && targetRef.current.seq !== null && targetRef.current.seq !== undefined) {
              hintedRef.current = targetRef.current.seq
            }
            issueStop(sessionRef.current, targetRef.current)
            // In delete mode the next ESC is terminal: the hint must say so.
            publishToast(tRef.current(deleteModeOn() ? 'esc.hint.delete' : 'esc.hint'))
            return
          }

          if (decision.action === 'arm') {
            // Non-running first ESC: only arm (remember this target so the next
            // ESC treats stopIssued=true and rewinds). No issueStop — nothing is
            // running. Mirrors the running-path hint so the user knows the next
            // ESC rewinds.
            consume()
            __diag.lastAction = 'arm'
            __diag.lastGate = 'esc-arm'
            stopMarkRef.current = targetRef.current ? targetRef.current.seq : null
            publishToast(tRef.current(deleteModeOn() ? 'esc.hint.delete' : 'esc.hint'))
            return
          }

          if (decision.action === 'rewind' && decision.exchange) {
            consume()
            __diag.lastAction = 'rewind'
            __diag.lastGate = 'esc-rewind'
            stopMarkRef.current = null
            publishToast(tRef.current('rewind.busy'))
            doRewind(sessionRef.current, decision.exchange).then((result) => {
              if (!result.ok) {
                publishToast(tRef.current('rewind.error', { msg: result.code || 'unknown' }))
              }
            })
          }
        }
        document.addEventListener('keydown', onKey, true)
        return () => document.removeEventListener('keydown', onKey, true)
      }, [])

      // 工具栏 Stop 也补「再按 Esc 回退」提示：下降沿只用来记候选，是否提示由
      // **宿主耐久停止证据**结算（尾部 assistant 带 interrupted，或该轮 turn/end
      // 为 aborted/user）。这样与「running 位 / 对话投影谁先到」无关：自然结束
      // （尾部 settled、或 turn/end 为 completed 等）会被静默丢弃，不再误弹。
      useEffect(() => {
        const wasRunning = prevRunningRef.current
        prevRunningRef.current = running
        // 下降沿：本会话刚结束了一轮（可能是主动停止，也可能是自然结束）。
        if (wasRunning === true && !running) {
          stopCandidateRef.current = target ? target.seq : null
        }
        const candidate = stopCandidateRef.current
        if (candidate === null || candidate === undefined) return
        if (running) return
        // 候选只对「当轮」有效：用户发了新消息（target.seq 变了）即作废。
        if (!target || target.seq !== candidate) {
          stopCandidateRef.current = null
          return
        }
        // 未定型：尾部还没有 assistant 行（如运行中的行在投影里不产出节点时，
        // 尾巴是刚发出的 user 提问），且该轮还没有 turn/end 终态 → 等下一帧。
        // 结算顺序（先确定的停止证据，后收尾终态）：
        //   1) 尾部带 interrupted —— 有内容被停，直接判定停止；
        //   2) 该轮 turn/end 为 aborted/user —— 无内容被停，或最后一步无内容、
        //      尾部停在上一步那条 settled 行上（settled 尾此时是**歧义**证据）；
        //   3) 其它 turn/end 终态（completed/error/max-tokens/blocked/非 user 的
        //      abort）—— 判定自然结束，静默丢弃候选；
        //   4) 该轮尚未收尾而尾部已是 settled —— 保持等待，等 turn/end 落定再判，
        //      避免把「后续步骤被停」误判成自然结束（宁晚勿错）。
        let evidence = null
        if (tailState === 'interrupted') evidence = 'tail-interrupted'
        else if (roundEnd === 'aborted:user') evidence = 'turn-aborted'
        else if (roundEnd !== null) evidence = 'settled'
        if (evidence === null) return
        stopCandidateRef.current = null
        if (evidence === 'settled') return
        if (draft !== '' || !qualifyExchange(target)) return
        if (hintedRef.current === target.seq) return
        hintedRef.current = target.seq
        __diag.hintToasts += 1
        __diag.lastHint = evidence
        publishToast(tRef.current(deleteModeOn() ? 'esc.hint.delete' : 'esc.hint'))
      }, [running, draft, target, tailState, roundEnd])

      // Apply the staged composer restore once the rewound branch mounts.
      //
      // 两个入口，缺一不可：
      //   a) 挂载/会话切换/输入面变化时的 effect —— 常规路径（武装时间早于挂载）；
      //   b) 模块级晚武装通知 —— 真机顺序是 open 先于 arm（React 提交早于我们 await 之后
      //      的那次武装），子会话挂载时 __pending 还是 null，effect 只按
      //      [sessionId, draft, inputActions] 重跑，之后不会再跑，那次还原就永久丢了。
      // 「一次回退只回填一次」用「已回填的会话 id」表达，而不是布尔 ref：下一次回退会 open
      // 出新的 childId，天然可再回填（旧的布尔 ref 会让同页第二次回退永远不回填）。
      const appliedSessionRef = useRef(null)
      const restoreScheduledRef = useRef(false)
      const inputActionsRef = useRef(inputActions)
      inputActionsRef.current = inputActions
      // 挂载期间才允许写入：桥卸载（切走会话）后，残留定时器不得再往旧会话的输入面写草稿。
      const restoreAliveRef = useRef(true)
      useEffect(() => () => {
        restoreAliveRef.current = false
        restoreScheduledRef.current = false
      }, [])

      /** 把被撤销的提问（含图片草稿）写回输入框；写入成功返回 true。 */
      const applyPendingRestore = useCallback(() => {
        if (!restoreAliveRef.current) return false
        const pending = __pending
        if (!pending) return false
        if (pending.sessionId !== sessionRef.current) return false
        if (appliedSessionRef.current === pending.sessionId) return false
        const actions = inputActionsRef.current
        if (!actions) return false
        if (draftRef.current !== '') {
          // 用户已经在分支里打字：放弃这次回填，绝不覆盖用户输入
          // （与「编辑草稿即解除预备态」同一原则）。
          __diag.pendingDropped = 'draft'
          clearPendingRestore(pending.sessionId)
          return false
        }
        appliedSessionRef.current = pending.sessionId
        try {
          if (pending.text) actions.setDraft(pending.text)
        } catch { /* 输入框还没就绪：交由 TTL 丢弃，不循环重试 */ }
        try {
          if (pending.imageDraftIds && pending.imageDraftIds.length) restoreDraftAttachments(actions, pending.imageDraftIds)
        } catch { /* images are best-effort */ }
        clearPendingRestore(pending.sessionId)
        __diag.pendingApplied += 1
        publishToast(tRef.current('rewind.done'))
        return true
      }, [])

      /** 等输入 store 水合一个拍子再写入（同一时刻只排一个）。 */
      const scheduleRestore = useCallback((delayMs) => {
        if (restoreScheduledRef.current) return
        restoreScheduledRef.current = true
        setTimeout(() => {
          restoreScheduledRef.current = false
          applyPendingRestore()
        }, typeof delayMs === 'number' ? delayMs : RESTORE_DELAY_MS)
      }, [applyPendingRestore])

      useEffect(() => {
        if (!inputActions) return undefined
        const pending = __pending
        if (!pending || pending.sessionId !== sessionId) return undefined
        scheduleRestore(RESTORE_DELAY_MS)
        return undefined
      }, [sessionId, draft, inputActions, scheduleRestore])

      useEffect(() => {
        const listener = (pending) => {
          if (!pending || pending.sessionId !== sessionRef.current) return
          if (appliedSessionRef.current === pending.sessionId) return
          setTimeout(() => {
            if (applyPendingRestore()) __diag.pendingLateArm += 1
          }, RESTORE_DELAY_MS)
        }
        __pendingListeners.add(listener)
        return () => { __pendingListeners.delete(listener) }
      }, [applyPendingRestore])

      if (!toast) return null
      return React.createElement(Toast, {
        key: toast.seq,
        text: toast.text,
        onDone: () => setToast(null),
      })
    }

    /** True when the focused composer has an active '/' or '@' trigger token at the caret. */
    function composerTriggerTokenOpen() {
      if (typeof document === 'undefined') return false
      try {
        const ae = document.activeElement
        if (!ae || typeof ae.closest !== 'function') return false
        const root = ae.closest('[' + COMPOSER_ATTR + ']')
        if (!root) return false
        const sel = (typeof window !== 'undefined' && typeof window.getSelection === 'function')
          ? window.getSelection()
          : null
        if (!sel || !sel.rangeCount || sel.isCollapsed !== true) return false
        const node = sel.anchorNode
        if (!node) return false
        const beforeCaret = node.nodeType === 3 && typeof node.textContent === 'string'
          ? node.textContent.slice(0, sel.anchorOffset || 0)
          : ''
        return /(?:^|\s)[/@]\S*$/.test(beforeCaret || '')
      } catch {
        return false
      }
    }

    /** True when an open overlay/menu/dialog, a trigger token, or a non-composer
     *  text field owns Escape (we must yield so core closes it first). */
    function hasOpenOverlay(event) {
      if (typeof document === 'undefined') return false
      try {
        const path = event && typeof event.composedPath === 'function' ? event.composedPath() : null
        const ancestors = path && path.length ? path : []
        if (typeof event !== 'undefined' && event.target) ancestors.push(event.target)
        for (const el of ancestors) {
          if (!el || typeof el !== 'object' || typeof el.closest !== 'function') continue
          if (el.closest('[role="dialog"], [role="menu"], [role="listbox"], [aria-modal="true"], [data-dsh-overlay]')) {
            return true
          }
          const editable = el.closest('input, textarea, [contenteditable="true"]')
          if (editable && !editable.closest('[' + COMPOSER_ATTR + ']')) return true
        }
      } catch { /* tolerant */ }
      if (composerTriggerTokenOpen()) return true
      return false
    }

    // --- session-header dispose-mode toggle (archive ⇄ delete) ----------------

    /** 28x28 icon button matching the header actions row (sibling plugins). */
    const disposeBtnStyle = {
      display: 'inline-flex',
      alignItems: 'center',
      justifyContent: 'center',
      width: 28,
      height: 28,
      padding: 0,
      border: 'none',
      borderRadius: 6,
      background: 'transparent',
      color: 'var(--dsw-alias-label-tertiary, #8a8a8e)',
      cursor: 'pointer',
      flex: 'none',
    }

    /** Archive cabinet glyph (default state: old session is archived). */
    const ARCHIVE_PATH = 'M3.5 2.5h9v11h-9zM1.75 4.75h1.75v-1.5h9v1.5h1.75v-1.5a1.5 1.5 0 0 0-1.5-1.5h-10a1.5 1.5 0 0 0-1.5 1.5zM8 8h1.5v2.5H8z'

    /** Trash-with-X glyph (delete mode: old session is permanently removed). */
    const DELETE_PATH = 'M6.2 4.9l1.8 1.8 1.8-1.8 1.3 1.3-1.8 1.8 1.8 1.8-1.3 1.3-1.8-1.8-1.8 1.8-1.3-1.3 1.8-1.8-1.8-1.8zM4 2.5l-1.5 12h11l-1.5-12zM5.2 4h5.6l1 10H4.2z'

    /** True when the session should show the dispose toggle (normal only). */
    function disposeVisible({ sessionId, summary }) {
      if (!sessionId) return false
      if (summary) {
        if (summary.origin === 'subagent') return false
        if (summary.blank === true) return false
      }
      return true
    }

    /**
     * Header icon button: archive ⇄ delete (global preference). Renders for
     * normal (non-subagent, non-blank) sessions only; clicking flips the switch
     * through remote.settings and toasts the outcome.
     */
    // --- orphan reclaim (settings → 插件 → 子代理) --------------------------------

    /** Fetch the host half's read-only orphan scan. */
    async function fetchOrphans() {
      if (typeof fetch !== 'function') throw new Error('fetch-unavailable')
      const response = await fetch(ORPHANS_ENDPOINT, { method: 'GET' })
      const body = await response.json().catch(() => ({}))
      if (!response.ok || body.ok !== true) {
        throw new Error(body.error || body.code || ('scan-failed-' + response.status))
      }
      return { count: Number(body.count) || 0, orphans: Array.isArray(body.orphans) ? body.orphans : [] }
    }

    /** Stop one batch of orphan runs through the host half (cancel + quiescence). */
    async function stopOrphans(ids) {
      const list = Array.isArray(ids) ? ids.filter(Boolean) : []
      if (list.length === 0) return []
      if (typeof fetch !== 'function') throw new Error('fetch-unavailable')
      const response = await fetch(ORPHANS_STOP_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ids: list }),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok || body.ok !== true) {
        if (response.status === 404 || response.status === 405) throw new Error('host-endpoint-missing:' + response.status)
        throw new Error(body.error || ('stop-failed-' + response.status))
      }
      return Array.isArray(body.results) ? body.results : []
    }

    /** Delete one batch of orphans for real (guarded delete per id). */
    async function deleteOrphans(ids) {
      const list = Array.isArray(ids) ? ids.filter(Boolean) : []
      if (list.length === 0) return []
      if (typeof fetch !== 'function') throw new Error('fetch-unavailable')
      const response = await fetch(ORPHANS_DELETE_ENDPOINT, {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ ids: list }),
      })
      const body = await response.json().catch(() => ({}))
      if (!response.ok || body.ok !== true) {
        if (response.status === 404 || response.status === 405) throw new Error('host-endpoint-missing:' + response.status)
        throw new Error(body.error || ('delete-failed-' + response.status))
      }
      return Array.isArray(body.results) ? body.results : []
    }

    /** Human text for one delete result (deleted / refused by the guard / missing / failed). */
    function deleteResultText(t, row) {
      if (row && row.deleted === true) return t('orphans.removed')
      if (row && row.reason === 'subagents') return t('orphans.removeBlocked', { n: Number(row.children) || 0 })
      if (row && row.reason === 'subagents-unknown') return t('orphans.removeUnknownBlock')
      if (row && row.reason === 'not-found') return t('orphans.removeMissing')
      return t('orphans.removeFailed', { msg: (row && (row.reason || row.message)) || 'unknown' })
    }

    /** Human text for one stop result (confirmed / unconfirmed / no-op). */
    function stopResultText(t, row) {
      if (row && row.confirmed === true) return t('orphans.stopped')
      if (row && row.stopped === true) return t('orphans.stopUnconfirmed', { reason: (row.reason || 'unknown') })
      return t('orphans.stopNoop', { reason: (row && row.reason) || 'unknown' })
    }

    /** Short display form of a session id (settings rows stay readable). */
    function shortId(id) {
      const text = String(id || '')
      return text.length > 20 ? text.slice(0, 8) + '…' + text.slice(-4) : text
    }

    /**
     * Rescue one orphan as an ordinary session: stop it first when it is still
     * running (in-flight content can never enter the fork seed), fork it at its
     * last completed turn boundary, keep its label, then open the branch. The
     * orphan itself is never deleted.
     */
    async function rescueOrphan(row) {
      const sessions = __svc.sessions
      if (!sessions || typeof sessions.fork !== 'function') throw new Error('sessions-unavailable')
      const atSeq = row && typeof row.atSeq === 'number' ? row.atSeq : null
      if (atSeq === null) throw new Error('no-completed-turn')
      let stopped = null
      if (row && row.running === true) {
        const results = await stopOrphans([row.id])
        stopped = results[0] || null
      }
      const childId = await sessions.fork({ sessionId: row.id, atSeq, increaseTitle: false })
      try {
        const label = row && typeof row.label === 'string' ? row.label : null
        const binding = typeof sessions.binding === 'function' ? sessions.binding(childId) : null
        if (label && label !== row.id && binding && binding.session && typeof binding.session.rename === 'function') {
          await binding.session.rename(label)
        }
      } catch (error) {
        __diag.orphanRenameFail = (error && error.message) ? error.message : String(error)
      }
      openSessionInUi(childId)
      __diag.orphanActions = __diag.orphanActions.concat([{ kind: 'rescue', id: row.id, childId, at: Date.now() }]).slice(-10)
      return { childId, stopped }
    }

    /** Settings → 插件 → 「子代理」: orphan reclaim, manual only (open = read-only). */
    /** Core-matching outline button (same geometry as the settings plugin cards). */
    const O_BTN = {
      display: 'inline-flex',
      alignItems: 'center',
      height: 26,
      padding: '0 10px',
      border: '.5px solid var(--dsw-alias-border-l3)',
      borderRadius: 6,
      background: 'transparent',
      color: 'var(--dsw-alias-label-primary)',
      font: 'inherit',
      fontSize: 13,
      lineHeight: '20px',
      cursor: 'pointer',
      flex: 'none',
    }
    /** Destructive variant used by「停止」(it drops the run's result for good). */
    const O_BTN_DANGER = { ...O_BTN, borderColor: 'var(--dsw-alias-state-error-primary)', color: 'var(--dsw-alias-state-error-primary)' }
    const O_TOOLS = { display: 'flex', alignItems: 'center', gap: 8, flexWrap: 'wrap' }
    const O_COUNT = { marginLeft: 'auto', fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }
    const O_ROW = {
      display: 'flex',
      alignItems: 'center',
      gap: 10,
      flexWrap: 'wrap',
      padding: '8px 0',
      borderBottom: '.5px solid var(--dsw-alias-border-l2)',
      listStyle: 'none',
    }
    const O_META = { display: 'flex', flexDirection: 'column', gap: 2, minWidth: 0 }
    const O_NAME = { fontSize: 13, color: 'var(--dsw-alias-label-primary)', wordBreak: 'break-all' }
    const O_SUB = { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }
    const O_ACTIONS = { marginLeft: 'auto', display: 'inline-flex', alignItems: 'center', gap: 8, flex: 'none' }
    const O_RESULT = { width: '100%', fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' }

    function OrphansPanel(props) {
      const seatT = props && typeof props.t === 'function' ? props.t : null
      const t = seatT || __t
      const [phase, setPhase] = React.useState('loading')
      const [rows, setRows] = React.useState([])
      const [error, setError] = React.useState(null)
      const [selected, setSelected] = React.useState({})
      const [results, setResults] = React.useState({})
      const [busy, setBusy] = React.useState(false)

      const load = React.useCallback(async () => {
        setPhase('loading')
        try {
          const scanned = await fetchOrphans()
          setRows(scanned.orphans)
          setError(null)
          setPhase('ready')
          __diag.orphans = { count: scanned.count, phase: 'ready', error: null, at: Date.now() }
        } catch (err) {
          const message = (err && err.message) ? err.message : String(err)
          setError(message)
          setPhase('error')
          __diag.orphans = { count: null, phase: 'error', error: message, at: Date.now() }
        }
      }, [])

      React.useEffect(() => { load() }, [load])

      const note = React.useCallback((id, text) => {
        setResults((previous) => { const next = { ...previous }; next[id] = text; return next })
      }, [])

      const act = React.useCallback(async (ids, kind) => {
        const list = (Array.isArray(ids) ? ids : []).filter(Boolean)
        if (list.length === 0) return
        if (kind === 'delete' && typeof window !== 'undefined' && typeof window.confirm === 'function') {
          if (!window.confirm(t('orphans.removeConfirm', { n: list.length }))) return
        }
        setBusy(true)
        try {
          if (kind === 'stop') {
            const stopped = await stopOrphans(list)
            for (const row of stopped) note(row.id, stopResultText(t, row))
            __diag.orphanActions = __diag.orphanActions.concat([{ kind: 'stop', ids: list, at: Date.now() }]).slice(-10)
          } else if (kind === 'delete') {
            const removed = await deleteOrphans(list)
            for (const row of removed) note(row.id, deleteResultText(t, row))
            __diag.orphanDeletes = (__diag.orphanDeletes || []).concat([{ ids: list, deleted: removed.filter((row) => row.deleted === true).length, at: Date.now() }]).slice(-10)
            for (const row of removed) {
              if (row.deleted === true) setSelected((previous) => { const next = { ...previous }; delete next[row.id]; return next })
            }
          } else {
            for (const id of list) {
              const row = rows.find((candidate) => candidate.id === id)
              if (!row) continue
              try {
                const outcome = await rescueOrphan(row)
                note(id, t('orphans.rescued') + ' → ' + shortId(outcome.childId))
              } catch (err) {
                note(id, t('orphans.rescueFailed', { msg: (err && err.message) ? err.message : String(err) }))
              }
            }
          }
          await load()
        } catch (err) {
          const message = (err && err.message) ? err.message : String(err)
          const stale = message.indexOf('host-endpoint-missing:') === 0
          const failureKey = kind === 'stop' ? 'orphans.stopFailed' : kind === 'delete' ? 'orphans.removeFailed' : 'orphans.rescueFailed'
          for (const id of list) note(id, stale ? t('orphans.hostStale') : t(failureKey, { msg: message }))
        } finally {
          setBusy(false)
        }
      }, [rows, load, note])

      const selectedIds = rows.filter((row) => selected[row.id] === true).map((row) => row.id)
      const allSelected = rows.length > 0 && selectedIds.length === rows.length
      const toggleAll = () => setSelected(() => {
        if (allSelected) return {}
        const next = {}
        for (const row of rows) next[row.id] = true
        return next
      })
      const head = [
        React.createElement('h2', { key: 'title' }, t('orphans.title')),
        React.createElement('p', { key: 'intro' }, t('orphans.intro')),
        React.createElement('div', { key: 'tools', style: O_TOOLS },
          React.createElement('button', { type: 'button', style: O_BTN, disabled: busy, onClick: () => { load() } }, t('orphans.refresh')),
          React.createElement('button', { type: 'button', style: O_BTN, disabled: rows.length === 0, onClick: toggleAll }, allSelected ? t('orphans.clearSelection') : t('orphans.selectAll')),
          React.createElement('button', { type: 'button', style: O_BTN_DANGER, disabled: busy || selectedIds.length === 0, onClick: () => { act(selectedIds, 'stop') } }, t('orphans.stopSelected')),
          React.createElement('button', { type: 'button', style: O_BTN, disabled: busy || selectedIds.length === 0, onClick: () => { act(selectedIds, 'rescue') } }, t('orphans.rescueSelected')),
          React.createElement('button', { type: 'button', style: O_BTN_DANGER, disabled: busy || selectedIds.length === 0, onClick: () => { act(selectedIds, 'delete') } }, t('orphans.removeSelected')),
          React.createElement('span', { key: 'count', style: O_COUNT }, selectedIds.length === 0 ? t('orphans.count', { n: rows.length }) : t('orphans.count', { n: rows.length }) + ' · ' + selectedIds.length + '/' + rows.length),
        ),
      ]
      let body
      if (phase === 'loading') body = React.createElement('p', { key: 'loading' }, t('orphans.loading'))
      else if (phase === 'error') body = React.createElement('p', { key: 'error' }, t('orphans.error', { msg: error }))
      else if (rows.length === 0) body = React.createElement('p', { key: 'empty' }, t('orphans.empty'))
      else body = React.createElement('ul', { key: 'rows', style: { margin: 0, padding: 0, listStyle: 'none' } },
        rows.map((row) => React.createElement('li', { key: row.id, style: O_ROW },
          React.createElement('div', { style: { display: 'flex', alignItems: 'center', gap: 8, minWidth: 0, flex: 1 } },
            React.createElement('input', {
              type: 'checkbox',
              checked: selected[row.id] === true,
              onChange: () => { setSelected((previous) => { const next = { ...previous }; next[row.id] = !(previous[row.id] === true); return next }) },
            }),
            React.createElement('div', { style: O_META },
              React.createElement('span', { style: O_NAME }, row.label || row.id),
              React.createElement('span', { style: O_SUB },
                (row.running === true ? t('orphans.running') + ' · ' : '')
                + t('orphans.parent') + ': ' + shortId(row.parentId)),
            ),
          ),
          React.createElement('div', { style: O_ACTIONS },
            React.createElement('button', { type: 'button', style: O_BTN_DANGER, disabled: busy, onClick: () => { act([row.id], 'stop') } }, t('orphans.stop')),
            React.createElement('button', {
              type: 'button',
              style: O_BTN,
              disabled: busy || row.canRescue !== true,
              title: row.canRescue === true ? '' : t('orphans.noBoundary'),
              onClick: () => { act([row.id], 'rescue') },
            }, t('orphans.rescue')),
            React.createElement('button', { type: 'button', style: O_BTN_DANGER, disabled: busy, onClick: () => { act([row.id], 'delete') } }, t('orphans.remove')),
          ),
          results[row.id] ? React.createElement('span', { style: O_RESULT }, results[row.id]) : null,
        )))
      return React.createElement('div', { className: 'dsew-orphans' }, head.concat([body]))
    }

    function DisposeToggle(props) {
      const t = (props && props.t) || __t
      const sessionId = props && props.sessionId
      // useSessions gives the session list snapshot (sibling plugins' header
      // buttons read running/blank/origin from it). Tolerate absence.
      const useSessions = props && typeof props.useSessions === 'function' ? props.useSessions : null
      const sessions = useSessions ? useSessions((s) => s) : undefined
      const summary = sessions && sessions.byId ? sessions.byId[sessionId] : undefined
      const [, force] = React.useState(0)
      const [toast, setToast] = React.useState(null)
      const toastSeq = React.useRef(0)
      const showToast = React.useCallback((text) => {
        if (!Toast) return
        toastSeq.current += 1
        setToast({ seq: toastSeq.current, text })
      }, [])
      React.useEffect(() => {
        __toastListeners.add(showToast)
        return () => { __toastListeners.delete(showToast) }
      }, [showToast])
      React.useEffect(() => {
        const listener = () => force((v) => v + 1)
        __disposeListeners.add(listener)
        return () => { __disposeListeners.delete(listener) }
      }, [])
      if (!disposeVisible({ sessionId, summary })) return null
      const on = deleteModeOn()
      return React.createElement(React.Fragment, null,
        React.createElement('button', {
          type: 'button',
          title: t(on ? 'dispose.title.delete' : 'dispose.title.archive'),
          'aria-label': t(on ? 'dispose.title.delete' : 'dispose.title.archive'),
          style: on
            ? { ...disposeBtnStyle, color: 'var(--dsw-alias-state-error-primary, #e5484d)' }
            : disposeBtnStyle,
          onClick: () => { setDeleteMode(!on) },
        }, React.createElement('svg', {
          width: 16,
          height: 16,
          viewBox: '0 0 16 16',
          fill: 'currentColor',
          'aria-hidden': true,
          style: { flex: 'none' },
        }, React.createElement('path', { d: on ? DELETE_PATH : ARCHIVE_PATH }))),
        toast
          ? React.createElement(Toast, { key: toast.seq, text: toast.text, onDone: () => setToast(null) })
          : null,
      )
    }

    // --- apply ----------------------------------------------------------------

    function adoptLocale(locale, ctx) {
      if (!locale) return
      __locale = locale
      try {
        if (typeof locale.register === 'function') {
          ctx.effect(() => locale.register(NS, { zh: zhDict, en: enDict }))
        }
      } catch { /* namespace already registered: keep the existing copy */ }
    }

    /** Lazily bind one client service into __svc without blocking apply. */
    function bindService(ctx, name) {
      try {
        const disposer = ctx.inject([name], (sub) => {
          try { __svc[name] = sub[name] || null } catch { __svc[name] = null }
        })
        if (typeof disposer === 'function') return disposer
      } catch { /* service may be absent on older hosts */ }
      return null
    }

    function apply(ctx) {
      __diag.applied = true
      adoptLocale(ctx.get('locale'), ctx)
      if (!__locale) {
        try {
          ctx.inject(['locale'], (sub) => { adoptLocale(sub.locale, ctx) })
        } catch { /* no locale service */ }
      }

      const disposers = []
      // uiWorkspace: 0.2.0 起会话切换动词（openSession）落在这个面，sessions 面已无 open。
      const names = ['sessions', 'uiWorkspace', 'workspaces', 'conversation', 'uiConversation', 'commandUi']
      for (const name of names) {
        try {
          const disposer = bindService(ctx, name)
          if (disposer) disposers.push(disposer)
        } catch { /* keep going */ }
      }
      try {
        ctx.effect(() => () => { for (const d of disposers) { try { d() } catch { /* noop */ } } })
      } catch { /* effect may be absent in the harness */ }

      // 命令描述契约的世代探测（不读版本号，见 probeCoreGeneration）。
      probeCoreGeneration(ctx)

      // Register the conversation overlay bridge once the slot exists.
      ctx.slots.inject(SLOT, () => ctx.slots.register({
        name: SLOT,
        id: ROW_ID,
        order: ROW_ORDER,
        ...(__locale ? { locale: NS } : {}),
      }, EscBridge))

      // Register the session-header dispose toggle (archive ⇄ delete).
      ctx.slots.inject(HEADER_SLOT, () => ctx.slots.register({
        name: HEADER_SLOT,
        id: HEADER_ROW_ID,
        order: HEADER_ORDER,
        ...(__locale ? { locale: NS } : {}),
      }, DisposeToggle))

      // 孤儿回收 tab 已休眠（2026-10-18，用户要求「暂时不用了，把 UI tab 先撤掉」）：
      // 面板实现（OrphansPanel / fetchOrphans / stopOrphans / deleteOrphans / rescueOrphan）、
      // 宿主半端点（/__esc-rewind/orphans | orphans/stop | orphans/delete）与全部中英文案都保留，
      // 只是不再往 `settings.localPlugins.tab` 注册入口 ⇒ 界面上看不到这个 tab。
      // 恢复方式：把下面这段注册块接回来即可（原实现见本文件 git 历史）：
      //   ctx.slots.inject(TAB_SLOT, () => {
      //     let disposer = null
      //     try {
      //       disposer = ctx.slots.register({ name: TAB_SLOT, id: TAB_ID, order: TAB_ORDER,
      //         label: () => __t('orphans.tab'), ...(__locale ? { locale: NS } : {}) }, OrphansPanel)
      //       __diag.orphanTabRegistered = true
      //     } catch (error) { __diag.orphanTabError = String(error && error.message || error) }
      //     return () => { __diag.orphanTabRegistered = false; if (typeof disposer === 'function') { try { disposer() } catch {} } }
      //   })
      // 诊断口径：`orphanTabDormant === true` = 有意不注册；`orphanTabError` 只在真出错时才有值。
      __diag.orphanTabDormant = true
      __diag.orphanTabRegistered = false

      // Delete-mode switch: resolve the client remote.settings controller
      // through the SAFE reader (each candidate guarded on its own, because a
      // bare property read throws on a real guarded ctx), bind it once, load
      // the value, and re-read when our namespace changes. All optional —
      // absent settings simply means archive mode.
      const bindSettings = (scope) => {
        if (!__settings) {
          const settings = readRemoteSettings(scope)
          if (settings) {
            __settings = settings
            __diag.services.settings = true
            loadDeleteMode()
          }
        }
        // Event subscription needs the remote root; own try, never blocks the
        // settings binding above.
        if (!__settingsEventsBound) {
          let remote = null
          try {
            if (scope && typeof scope.get === 'function') remote = scope.get('remote') || null
          } catch { /* not injected on this scope */ }
          if (!remote) {
            try { remote = scope && scope.remote ? scope.remote : null } catch { /* guarded */ }
          }
          if (remote && typeof remote.$on === 'function') {
            __settingsEventsBound = true
            __diag.settingsEventsBound = true
            try {
              const disposer = remote.$on('settings/document-updated', (ns) => {
                if (!ns || ns === SETTINGS_NS) {
                  if (!__settings) {
                    const found = readRemoteSettings(scope)
                    if (found) { __settings = found; __diag.services.settings = true }
                  }
                  loadDeleteMode()
                }
              })
              if (typeof disposer === 'function') disposers.push(disposer)
            } catch { /* event subscription optional */ }
          }
        }
      }
      try { bindSettings(ctx) } catch { /* the injects below still get a shot */ }
      // Inject the dotted service name, and the bare remote root as a second
      // chance: either scope can answer `remote.settings`.
      const injectSettings = (names) => {
        try {
          const disposer = ctx.inject(names, (sub) => bindSettings(sub))
          if (typeof disposer === 'function') disposers.push(disposer)
        } catch { /* absent: stays archive mode */ }
      }
      if (!__settings || !__settingsEventsBound) injectSettings(['remote.settings'])
      if (!__settings || !__settingsEventsBound) injectSettings(['remote'])

      // Register the /rewind contribution once commandUi is bound. The
      // contribution re-checks availability per candidate pass, so registering
      // before a session exists is harmless.
      try {
        const commandDisposer = ctx.inject(['commandUi'], (sub) => {
          if (sub && sub.commandUi) {
            const disposer = registerRewindContribution(sub.commandUi)
            if (disposer) disposers.push(disposer)
          }
        })
        if (typeof commandDisposer === 'function') disposers.push(commandDisposer)
      } catch { /* commandUi absent: /rewind just won't exist */ }
    }

    // Expose internals for the logic harness + diagnostics.
    function exposeInternals() {
      if (typeof window === 'undefined') return
      try {
        window.__dsewInternals = {
          nodeKind, nodeSeq, nodeTime, nodeText, nodeImageRefs, assistantStatusOf,
          chatNodeList, buildExchanges, qualifyExchange, lastExchange, tailInterrupted,
          tailStatus, lastTurnEndEvidence,
          tailUnsettled, decideEsc, snippet, timeLabel,
          _module: {
            publishToast, doRewind, issueStop, ensureIdle, clearQueue,
            settlePendingInputs, pendingInputsOf, armPendingRestore, clearPendingRestore,
            probeCoreGeneration, markModernCore, sessionSnapshotOf,
            createDraftAttachments, releaseDraftAttachment, restoreDraftAttachments, archiveOldSession,
            exchangesOfSession, isSubagentSession, sessionFacts,
            refreshHistory, knownExchangesOf, resetHistoryCache,
            loadDeleteMode, setDeleteMode, deleteOldSession, deleteModeOn,
            fetchOrphans, stopOrphans, rescueOrphan, stopResultText, orphansPanel: OrphansPanel,
            disposeVisible, notifyDisposeListeners, readRemoteSettings, unwrapResult,
            getSettings: () => __settings,
          },
        }
      } catch { /* no window */ }
    }
    exposeInternals()

    return { apply, inject: ['slots'] }
  },
})
