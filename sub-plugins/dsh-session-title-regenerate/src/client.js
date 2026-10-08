// dsh-session-title-regenerate: CLIENT half.
//
// Two entry points, one shared flow:
//   1. session-header action button  (conversation.session.header.actions)
//   2. sidebar session-row "..." menu item (DOM injection, title-matched) —
//      core ui-workspace hard-codes that menu (rename/fork/archive) with no
//      extension slot, so the item is injected at the DOM level exactly like
//      @huanlin/dsh-plugin-session-delete does — but as a row ISOMORPHIC to the
//      native ones (own wrapper + icon slot + label slot), because third-party
//      plugins clone the last item's parentElement as "one row".
//
// Both trigger the host's `/regenerate-title` command through
// `remote.commands.execute(sessionId, '/regenerate-title', [])` — a core
// Remote whose `agent` lookup auto-resumes non-open sessions, so the item
// works on ANY session row without switching the conversation. The host
// commits the new title via sessionTitle.rename; the client list updates
// through the title projection. Success/failure feedback is a shared Toast
// rendered by a root-scoped `shell.overlay` occupant that listens for a
// window event both entry points dispatch.
//
// The DOM-injected menu item has no session id (the row DOM carries none), so
// its click resolves the row title against the client sessions list store
// (exact -> fork-suffix-stripped -> contains), mirroring session-delete.
//
// Locale: all client copy lives in the zh/en dictionaries below and follows
// the client's active language through the `locale` service. Without the
// service a browser-language sniff selects the dictionary. Host-side error
// strings are returned verbatim by the command handler and are zh-first.
//
// Bundle format (client-modules protocol): classic script registering a
// factory via window.__ModuleLoader__.load({ id, factory }); the factory
// receives `require` and returns the plugin's exports (apply etc.).
// No JSX: plain React.createElement. Theme tokens only (--dsw-*).
window.__ModuleLoader__.load({
  id: 'dsh-session-title-regenerate',
  factory: (require) => {
    const React = require('react')
    const { useCallback, useEffect, useRef, useState } = React
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

    const SLOT = 'conversation.session.header.actions'
    const ROW_ID = 'regenerate-title'
    // Header-action ordering: schedule-catalog(10) -> job-list(20) ->
    // open-session-workdir(25) -> this button(27) -> session-delete(30).
    const ROW_ORDER = 27
    const OVERLAY_SLOT = 'shell.overlay'
    const OVERLAY_ID = 'session-title-regen-feedback'
    const NS = 'session-title-regenerate'
    const COMMAND = '/regenerate-title'
    const RESULT_EVENT = 'session-title-regen:result'
    /** 核心「本地插件」设置页里的分页槽位（本插件贡献一个 tab）。 */
    const TAB_SLOT = 'settings.localPlugins.tab'
    const TAB_ID = 'session-title-regenerate'
    const TAB_ORDER = 45
    /** 设置命名空间 = profile 行的 entry id（= 本插件名），与宿主半导出的 Config 对应。 */
    const SETTINGS_NS = 'session-title-regenerate'
    /** 推理强度档位全集（与宿主半 REASONING_EFFORTS 同表；off 仍用于写入校验与老配置兼容）。 */
    const EFFORT_OPTIONS = ['off', 'low', 'medium', 'high', 'max']
    /** 设置页单选里提供的档位：off 由「思考开关」表达，不再单列一档（否则「思考开 + off」语义自相矛盾）。 */
    const ACTIVE_EFFORT_OPTIONS = ['low', 'medium', 'high', 'max']
    /** 三项设置的默认值（与宿主半 DEFAULTS 对齐）。 */
    const SETTINGS_DEFAULTS = { thinking: false, reasoningEffort: 'off', maxOutputTokens: 512 }
    const MAX_OUTPUT_TOKENS_MIN = 16
    const MAX_OUTPUT_TOKENS_MAX = 8192

    // --- locale ---------------------------------------------------------------

    const zhDict = {
      'header.button': '重新生成标题',
      'header.busy': '正在生成标题…',
      'menu.regenerate': '重新生成标题',
      'toast.success': '标题已更新：',
      'toast.failed': '重新生成标题失败',
      'toast.noCommand': '当前 DSH 版本没有可用的命令通道（remote.commands 缺失）',
      'toast.noSession': '未能定位该会话，请刷新会话列表后重试',
      'tab.title': '重新生成标题',
      'settings.intro': '这三项决定 /regenerate-title 调用模型时的思考与输出上限；保存后插件重载，下一次命令生效。',
      'settings.thinking': '思考开关',
      'settings.thinkingHint': '关（默认）＝不下发 reasoningEffort，标题生成最省 token；打开后在下面选一个档位（未选过则默认 low）。',
      'settings.effort': '推理强度',
      'settings.effortHint': '档位需当前模型支持；不支持时这一次调用会自动去掉该参数重试。',
      'settings.effort.off': 'off（不思考）',
      'settings.effort.low': 'low（低）',
      'settings.effort.medium': 'medium（中）',
      'settings.effort.high': 'high（高）',
      'settings.effort.max': 'max（最高）',
      'settings.effortWhenOff': '当前不思考：本次调用不下发 reasoningEffort（等价 off，最省 token）。打开上面的开关后可选档位。',
      'settings.maxTokens': '最大输出 tokens',
      'settings.maxTokensHint': '默认 512（旧默认 100 常被上游截断，报 title output reached maxTokens）；范围 16–8192，离开输入框时自动夹取。',
      'settings.save': '保存',
      'settings.saving': '保存中…',
      'settings.reset': '填入默认值',
      'settings.reload': '重新读取',
      'settings.saved': '已保存；插件重载后生效。',
      'settings.resetReady': '已填入默认值，点「保存」写入。',
      'settings.dirty': '● 有未保存的改动。',
      'settings.clean': '当前值与已保存的一致。',
      'settings.effective': '本次调用：',
      'settings.effectiveOff': '不下发 reasoningEffort',
      'settings.effectiveTokens': 'maxTokens ',
      'settings.noEntry': '还没有这个插件的配置项：先在「本地插件」里启用它，再回到本页。',
      'settings.error': '设置操作失败：',
    }

    const enDict = {
      'header.button': 'Regenerate title',
      'header.busy': 'Regenerating title…',
      'menu.regenerate': 'Regenerate title',
      'toast.success': 'Title updated: ',
      'toast.failed': 'Failed to regenerate title',
      'toast.noCommand': 'No command channel available in this DSH build (remote.commands missing)',
      'toast.noSession': 'Could not locate that session; refresh the session list and try again',
      'tab.title': 'Regenerate title',
      'settings.intro': 'These three drive the thinking/output budget of /regenerate-title. Saving reloads the plugin; the next command uses the new values.',
      'settings.thinking': 'Thinking',
      'settings.thinkingHint': 'Off (default) = no reasoningEffort at all, the cheapest title call. When on, pick a tier below (defaults to low).',
      'settings.effort': 'Reasoning effort',
      'settings.effortHint': 'The tier must be supported by the current model, otherwise this call retries without the parameter.',
      'settings.effort.off': 'off (no thinking)',
      'settings.effort.low': 'low',
      'settings.effort.medium': 'medium',
      'settings.effort.high': 'high',
      'settings.effort.max': 'max (highest)',
      'settings.effortWhenOff': 'Not thinking: this call sends no reasoningEffort (equivalent to off, cheapest). Turn the switch on to pick a tier.',
      'settings.maxTokens': 'Max output tokens',
      'settings.maxTokensHint': 'Default 512 (the old 100 was truncated upstream as "title output reached maxTokens"); range 16-8192, clamped when the field loses focus.',
      'settings.save': 'Save',
      'settings.saving': 'Saving…',
      'settings.reset': 'Fill in defaults',
      'settings.reload': 'Reload',
      'settings.saved': 'Saved; takes effect when the plugin reloads.',
      'settings.resetReady': 'Defaults filled in — press Save to write them.',
      'settings.dirty': '● Unsaved changes.',
      'settings.clean': 'Matches the saved value.',
      'settings.effective': 'This call: ',
      'settings.effectiveOff': 'no reasoningEffort',
      'settings.effectiveTokens': 'maxTokens ',
      'settings.noEntry': 'This plugin has no config entry yet: enable it under Local plugins first.',
      'settings.error': 'Settings request failed: ',
    }

    var __locale = null

    function localeFallbackLang() {
      if (typeof navigator === 'undefined') return 'zh'
      for (const tag of (navigator.languages || []).concat([navigator.language])) {
        const primary = String(tag || '').toLowerCase().split('-')[0]
        if (primary === 'zh' || primary === 'en') return primary
      }
      return 'zh'
    }

    /** 解析一条文案：优先 locale 服务，回退浏览器语言嗅探字典。 */
    function __t(key) {
      if (__locale && typeof __locale.translate === 'function') {
        const text = __locale.translate(NS, key)
        if (typeof text === 'string' && text !== key) return text
      }
      return (localeFallbackLang() === 'en' ? enDict : zhDict)[key] || key
    }

    /** 随 locale 快照变化重渲染（覆盖未带 t 座位的条目）。 */
    function useLocaleRevision() {
      const [, setRev] = useState(0)
      useEffect(() => {
        if (!__locale || typeof __locale.subscribe !== 'function') return undefined
        return __locale.subscribe(() => setRev((v) => v + 1))
      }, [])
    }

    // --- services -------------------------------------------------------------

    var __scope = null
    var __ctx = null
    var __commands = null
    var __sessionsSvc = null

    /** 读取一个 cordis 服务（先 get 再属性回退）。 */
    function __readService(ctx, name) {
      try {
        if (ctx && typeof ctx.get === 'function') {
          const viaGet = ctx.get(name)
          if (viaGet) return viaGet
        }
      } catch { /* unmounted or unknown: fall through */ }
      if (name.indexOf('.') !== -1) return null
      try {
        return (ctx && ctx[name]) || null
      } catch {
        return null
      }
    }

    /** 在注入作用域与应用 ctx 两级查找一个服务名。 */
    function __lookup(name) {
      const scopes = [__scope, __ctx]
      for (const scope of scopes) {
        const found = __readService(scope, name)
        if (found) return found
      }
      return null
    }

    /**
     * 解析 `remote.commands` 控制器。外部插件不能直接读 bare `remote` 根的
     * `.commands`：网关把它装成需要先注入的访问器，直接读会抛
     * `cannot get property "remote.commands" without inject`。必须先经
     * `ctx.get('remote.commands')`（dotted cordis 名）或在注入作用域里取。
     * 与 open-session-workdir 读 `remote.session` 是同一个坑、同一种解法。
     * - 参数类型：scope -- Context 或注入作用域。
     * - 返回值：commands 控制器 | null。
     * - 调用样例：const commands = __readCommands(__ctx)
     */
    function __readCommands(scope) {
      try {
        if (scope && typeof scope.get === 'function') {
          const viaGet = scope.get('remote.commands')
          if (viaGet) return viaGet
        }
      } catch { /* 尚未注入：fall through 到兜底路径 */ }
      try {
        const root = scope && (typeof scope.get === 'function' ? scope.get('remote') : scope.remote)
        if (root && root.commands) return root.commands
      } catch { /* bare-root 访问器同样要求注入：忽略 */ }
      return null
    }

    /** 在注入作用域与应用 ctx 两级查找 commands 控制器。 */
    function __lookupCommands() {
      const scopes = [__scope, __ctx]
      for (const scope of scopes) {
        const found = __readCommands(scope)
        if (found) return found
      }
      return null
    }

    // --- shared flow ----------------------------------------------------------

    /**
     * 触发一次标题重新生成（命令通道）。
     * - 参数类型：sessionId -- string：目标会话 id。
     * - 返回值：Promise<{ok, message?, title?}>：命令结果。
     * - 调用样例：const r = await executeRegenerate(sessionId)
     */
    async function executeRegenerate(sessionId) {
      // 必须拿到已注入的 commands 控制器：不能读 bare remote 根的 .commands。
      const commands = __commands || __lookupCommands()
      if (!commands || typeof commands.execute !== 'function') {
        return { ok: false, message: __t('toast.noCommand') }
      }
      let result
      try {
        result = await commands.execute(sessionId, COMMAND, [])
      } catch (error) {
        return { ok: false, message: (error && error.message) ? String(error.message) : String(error) }
      }
      if (!result || !result.ok) {
        const err = result && result.error
        const message = (err && (err.message || err.code)) || __t('toast.failed')
        return { ok: false, message: String(message) }
      }
      const value = result.value
      const outcome = value && value.result ? value.result : null
      if (!outcome || outcome.kind === 'error') {
        const text = outcome && typeof outcome.text === 'string' ? outcome.text : __t('toast.failed')
        return { ok: false, message: text }
      }
      const title = typeof outcome.text === 'string' ? outcome.text : ''
      return { ok: true, title }
    }

    /**
     * 派发统一结果事件，由 overlay 宿主渲染 Toast。
     * - 参数类型：ok -- boolean；message -- string；title -- string（成功时的标题）。
     * - 返回值：无。
     * - 调用样例：notify(true, '', '写插件')
     */
    function notify(ok, message, title) {
      try {
        window.dispatchEvent(new CustomEvent(RESULT_EVENT, {
          detail: { ok: ok === true, message: message || '', title: title || '' },
        }))
      } catch { /* a missing window must never break the UI */ }
    }

    // --- 标题 -> 会话 id 解析（菜单项用） --------------------------------------

    /** 归一化标题文本（仅显示层比较用）。 */
    function normalizeTitle(t) {
      return String(t || '').trim().replace(/\s+/g, ' ')
    }

    /** 去掉 fork 会话的 ' (N)' 后缀，便于标题匹配。 */
    function stripForkSuffix(t) {
      return normalizeTitle(t).replace(/\s*\(\d+\)\s*$/, '')
    }

    /**
     * 从客户端会话列表 store 按标题反查会话 id（行 DOM 不携带 id）。
     * 匹配级别：精确 -> 去 fork 后缀 -> 互相包含。
     * - 参数类型：title -- string：行标题文本。
     * - 返回值：string | null：会话 id 或 null。
     * - 调用样例：const id = resolveSessionIdByTitle(title)
     */
    function resolveSessionIdByTitle(title) {
      const want = normalizeTitle(title)
      if (!want) return null
      const wantBase = stripForkSuffix(want)
      const svc = __sessionsSvc || __lookup('sessions')
      if (!svc || !svc.list) return null
      let byId = null
      try {
        const snap = svc.list.getSnapshot()
        byId = snap && snap.byId ? snap.byId : {}
      } catch { return null }
      const ids = Object.keys(byId)
      for (const id of ids) {
        if (normalizeTitle(byId[id].title) === want) return id
      }
      if (wantBase) {
        for (const id of ids) {
          if (stripForkSuffix(byId[id].title) === wantBase) return id
        }
      }
      let best = null
      for (const id of ids) {
        const t = normalizeTitle(byId[id].title)
        if (t && (t.indexOf(want) >= 0 || want.indexOf(t) >= 0)) best = id
      }
      return best
    }

    // --- header button ---------------------------------------------------------

    const buttonStyle = {
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

    /**
     * 会话头部操作区的"重新生成标题"按钮。
     * - 参数类型：props -- {sessionId, useSessions, t}：槽位注入的座席。
     * - 返回值：React 元素（null 当无 sessionId）。
     * - 调用样例：由 slots 以 conversation.session.header.actions 注册。
     */
    function RegenerateTitleButton(props) {
      const t = (typeof props.t === 'function') ? props.t : __t
      useLocaleRevision()
      const sessionId = props.sessionId
      const [busy, setBusy] = useState(false)

      const run = useCallback(async () => {
        if (busy || !sessionId) return
        setBusy(true)
        const result = await executeRegenerate(sessionId)
        setBusy(false)
        if (result.ok) notify(true, __t('toast.success'), result.title)
        else notify(false, result.message || __t('toast.failed'))
      }, [busy, sessionId, t])

      if (!sessionId) return null
      const title = busy ? t('header.busy') : t('header.button')
      return React.createElement('button', {
        type: 'button',
        title,
        'aria-label': title,
        'aria-busy': busy ? 'true' : 'false',
        style: { ...buttonStyle, ...(busy ? { opacity: 0.6 } : {}) },
        onClick: () => { void run() },
      }, React.createElement(busy ? IconLoadingOutline16 : IconRefreshOutline16, { size: 16 }))
    }

    // --- sidebar session-row "..." menu injection ------------------------------

    // The core menu is hard-coded with no extension slot (verified against
    // ui-workspace 0.1.1-rc.2 and 0.1.2-rc.1). We inject at the DOM level,
    // exactly like @huanlin/dsh-plugin-session-delete does.
    //
    // The core renders its items inside the menu's content viewport:
    //   <div role="menu">
    //     <div role="presentation">            <- native items live here
    //       <div class="itemWrap"><button role="menuitem">重命名</button></div>
    //       ...
    //     </div>
    //   </div>
    // while plugin-injected items (session-delete etc.) are appended as DIRECT
    // children of [role=menu] (siblings AFTER the viewport). So to read as an
    // official action rather than a plugin afterthought, we append our own item
    // INTO that viewport: it lands directly under 重命名/分叉/归档 and above
    // every plugin group, with no separator of ours.
    //
    // The injected row is ISOMORPHIC to a native one: our own wrapper div holds
    // the role=menuitem button, which holds an icon-slot span and a label-slot span
    // (a native row is `div.itemWrap > button[role=menuitem] > span.itemIcon +
    // span.itemLabel`). Third-party plugins parse that shape STRUCTURALLY —
    // dsh-flowglass 0.7.0's "join current parallel branch" enhancement takes
    // `items[items.length - 1].parentElement` as "the row container" and deep-clones
    // it. With a bare button that parent is the whole viewport, so the clone copies
    // EVERY row (rename/fork/archive included) and only relabels its first — the menu
    // then shows 分叉/归档/… twice. One wrapper per row keeps such a clone to one row.

    /**
     * 定位原生菜单项所在的内容区：第一个同时带 role=presentation 且内含
     * role=menuitem 的容器（核心 Menu 的 viewport）。找不到则回退到 menu 本身。
     * - 参数类型：menu -- Element：打开的 [role=menu]。
     * - 返回值：Element -- 应注入的容器。
     * - 调用样例：const root = menuContentRoot(menu)
     */
    function menuContentRoot(menu) {
      try {
        const presentational = menu.querySelectorAll('[role=presentation]')
        for (let i = 0; i < presentational.length; i++) {
          const node = presentational[i]
          if (node && node.querySelector && node.querySelector('[role=menuitem]')) return node
        }
      } catch { /* degraded DOM: fall back to the menu itself */ }
      return menu
    }

    /**
     * 把"重新生成标题"注入原生内容区（viewport），使其紧跟官方三项、位于所有
     * 直接 append 到 [role=menu] 的插件项之前。不创建自己的分隔线。
     * entry 是自带包裹层的一整行（见上方同构说明），不是裸按钮。
     * - 参数类型：menu -- Element：打开的 [role=menu]；entry -- Element：待插入的行容器。
     * - 返回值：无。
     * - 调用样例：insertMenuEntry(menu, wrap)
     */
    function insertMenuEntry(menu, entry) {
      const root = menuContentRoot(menu)
      try {
        root.appendChild(entry)
      } catch {
        menu.appendChild(entry)
      }
    }

    /**
     * 从打开的会话行读取标题文本。
     * - 参数类型：row -- Element：会话行 DOM。
     * - 返回值：string | ''：行内标题。
     * - 调用样例：const title = readRowTitle(row)
     */
    function readRowTitle(row) {
      if (!row || typeof row.querySelector !== 'function') return ''
      const titleEl = row.querySelector('[class*=title]')
      return titleEl ? String(titleEl.innerText || titleEl.textContent || '').trim() : ''
    }

    /**
     * 找到当前处于菜单打开状态的会话行。
     * - 参数类型：无。
     * - 返回值：Element | null。
     * - 调用样例：const row = findOpenSessionRow()
     */
    function findOpenSessionRow() {
      const rows = document.querySelectorAll('[class*=sessionRow]')
      for (let i = 0; i < rows.length; i++) {
        if (String(rows[i].className || '').indexOf('menuOpen') >= 0) return rows[i]
      }
      return null
    }

    /** 菜单注入项的 hover/离开背景反馈。 */
    function bindMenuItemHover(item) {
      item.addEventListener('mouseenter', () => {
        item.style.background = 'var(--dsw-alias-interactive-bg-hover,rgba(128,128,128,.14))'
      })
      item.addEventListener('mouseleave', () => {
        item.style.background = 'transparent'
      })
    }

    /**
     * 向已打开的 [role=menu] 注入"重新生成标题"菜单项（幂等）。
     * - 参数类型：无。
     * - 返回值：无。
     * - 调用样例：由 MutationObserver 回调调用。
     */
    function ensureMenuItem() {
      const menu = document.querySelector('[role=menu]')
      if (!menu) return
      if (menu.querySelector('[data-session-title-regen]')) return
      const row = findOpenSessionRow()
      if (!row) return // 不是会话行菜单
      // 行容器：官方每行都是 `div > button[role=menuitem]`，注入项必须自带这一层，
      // 否则会破坏第三方按「最后一个 menuitem 的 parentElement」做的整行克隆（见上方注释）。
      const wrap = document.createElement('div')
      const item = document.createElement('button')
      item.type = 'button'
      item.setAttribute('role', 'menuitem')
      item.setAttribute('data-session-title-regen', '1')
      item.style.cssText = [
        'display:flex', 'align-items:center', 'gap:8px', 'width:100%',
        'padding:6px 12px', 'border:none', 'background:transparent',
        'color:var(--dsw-alias-label-primary,inherit)',
        'font:inherit', 'font-size:13px', 'line-height:20px',
        'text-align:left', 'border-radius:6px', 'cursor:pointer',
      ].join(';')
      // DeepSeek circular refresh icon (matches the ui-workspace regenerate
      // affordance glyph the user asked to mirror), 16x16 currentColor.
      // 图标槽：只占一个 span，与核心 .itemIcon 同形（inline-flex / flex:none），
      // 不依赖核心的 hash 类名。
      const icon = document.createElement('span')
      icon.style.cssText = 'display:inline-flex;align-items:center;flex:none'
      icon.innerHTML = '<svg width="16" height="16" viewBox="0 0 16 16" fill="none" xmlns="http://www.w3.org/2000/svg" style="flex:none"><path d="M7.92136 0.349152C10.3744 0.349234 12.5564 1.5052 13.9557 3.29894L15.1281 2.12759C15.3303 1.92546 15.6767 2.06943 15.6767 2.35538V5.53923C15.6766 5.71626 15.5329 5.85976 15.3559 5.86002H12.171C11.8854 5.8597 11.7426 5.51465 11.9443 5.31249L12.9641 4.29056C11.8237 2.74305 9.98908 1.74106 7.92136 1.74097C4.46436 1.74097 1.66233 4.543 1.66233 8C1.66233 11.457 4.46436 14.259 7.92136 14.259C11.3782 14.2589 14.1804 11.4569 14.1804 8H15.5722C15.5722 12.2251 12.1465 15.6507 7.92136 15.6508C3.69614 15.6508 0.270508 12.2252 0.270508 8C0.270508 3.77478 3.69614 0.349152 7.92136 0.349152Z" fill="currentColor"/></svg>'
      const label = document.createElement('span')
      label.setAttribute('data-session-title-regen-label', '1')
      label.textContent = __t('menu.regenerate')
      item.appendChild(icon)
      item.appendChild(label)
      bindMenuItemHover(item)
      item.addEventListener('click', () => {
        const title = readRowTitle(row)
        if (!title) return
        const sessionId = resolveSessionIdByTitle(title)
        if (!sessionId) {
          notify(false, __t('toast.noSession'))
          return
        }
        executeRegenerate(sessionId).then((result) => {
          if (result.ok) notify(true, __t('toast.success'), result.title)
          else notify(false, result.message || __t('toast.failed'))
        })
      })
      wrap.appendChild(item)
      insertMenuEntry(menu, wrap)
    }

    /** 语言切换时刷新已注入菜单项的文案。 */
    function refreshMenuLabel() {
      const labels = document.querySelectorAll('[data-session-title-regen-label]')
      for (let i = 0; i < labels.length; i++) {
        labels[i].textContent = __t('menu.regenerate')
      }
    }

    var __menuInstalled = false

    /** 安装菜单注入：一次性 MutationObserver 常驻观察 body。 */
    function installMenuInjection() {
      if (__menuInstalled) return
      __menuInstalled = true
      try { ensureMenuItem() } catch { /* never crash the UI */ }
      const observer = new MutationObserver(() => {
        try { ensureMenuItem() } catch { /* never crash the UI */ }
      })
      observer.observe(document.body, { childList: true, subtree: true })
    }

    // --- settings tab: 思考开关 / 推理强度 / max tokens ------------------------

    /** 设置分页的样式（主题 token，跟随核心明暗）。 */
    const STY = {
      wrap: { display: 'flex', flexDirection: 'column', gap: '14px', fontSize: '13px', lineHeight: 1.6 },
      card: { border: '1px solid var(--dsw-border,rgba(127,127,127,.25))', borderRadius: '10px', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '12px' },
      field: { display: 'flex', flexDirection: 'column', gap: '4px' },
      row: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      label: { fontSize: '13px', fontWeight: 500 },
      hint: { color: 'var(--dsw-text-secondary,#8b8b8b)', fontSize: '12px' },
      input: { width: '120px', padding: '6px 8px', borderRadius: '6px', border: '1px solid var(--dsw-border,rgba(127,127,127,.3))', background: 'transparent', color: 'inherit', font: 'inherit', boxSizing: 'border-box' },
      choice: { display: 'inline-flex', alignItems: 'center', gap: '4px', marginRight: '12px', cursor: 'pointer', fontSize: '13px' },
      btn: { padding: '5px 12px', borderRadius: '6px', border: '1px solid var(--dsw-border,rgba(127,127,127,.3))', background: 'transparent', color: 'inherit', cursor: 'pointer', font: 'inherit' },
      btnPrimary: { padding: '5px 12px', borderRadius: '6px', border: '1px solid var(--dsw-accent,#4c8bf5)', background: 'var(--dsw-accent,#4c8bf5)', color: '#fff', cursor: 'pointer', font: 'inherit' },
      ok: { color: 'var(--dsw-success,#2e9e5b)', fontSize: '12px' },
      bad: { color: 'var(--dsw-danger,#d9534f)', fontSize: '12px' },
    }

    function describeError(error) {
      return error && error.message ? String(error.message) : String(error)
    }

    function isPlainObject(value) {
      return !!value && typeof value === 'object' && !Array.isArray(value)
    }

    /** 把输入夹成 [min, max] 内的整数；非数字回落 fallback。 */
    function clampInt(value, min, max, fallback) {
      const n = typeof value === 'number' ? value : Number(value)
      if (!Number.isFinite(n)) return fallback
      const i = Math.trunc(n)
      if (i < min) return min
      if (i > max) return max
      return i
    }

    /** 单选里应选中的档位：不在可选表内（off / 空 / 非法）时回落 low。 */
    function activeEffortOf(effort) {
      return ACTIVE_EFFORT_OPTIONS.indexOf(effort) >= 0 ? effort : ACTIVE_EFFORT_OPTIONS[0]
    }

    /** 三项设置是否等价（输出上限按「夹取后的整数」比较，避免 "512" 与 512 被当成改动）。 */
    function sameSettings(a, b) {
      const left = a && typeof a === 'object' ? a : {}
      const right = b && typeof b === 'object' ? b : {}
      const tokens = (v) => clampInt(
        v && v.maxOutputTokens,
        MAX_OUTPUT_TOKENS_MIN,
        MAX_OUTPUT_TOKENS_MAX,
        SETTINGS_DEFAULTS.maxOutputTokens,
      )
      return (left.thinking === true) === (right.thinking === true)
        && String(left.reasoningEffort || '') === String(right.reasoningEffort || '')
        && tokens(left) === tokens(right)
    }

    /** 「本次调用实际会发什么」的一行回显（开关决定档位是否下发，数字先夹取）。 */
    function effectiveSummary(value) {
      const thinking = !!value && value.thinking === true
      const tokens = clampInt(
        value && value.maxOutputTokens,
        MAX_OUTPUT_TOKENS_MIN,
        MAX_OUTPUT_TOKENS_MAX,
        SETTINGS_DEFAULTS.maxOutputTokens,
      )
      const body = thinking
        ? 'reasoningEffort = ' + activeEffortOf(value && value.reasoningEffort)
        : __t('settings.effectiveOff')
      return __t('settings.effective') + body + ' · ' + __t('settings.effectiveTokens') + String(tokens)
    }

    /**
     * 逐候选读取客户端 remote.settings 控制器：每个候选各自 try —— 真身 ctx 对
     * 未注入的裸属性会抛 `cannot get property "settings" without inject`，
     * 共用一次 try 会在第一个候选处直接放弃。
     */
    function readRemoteSettings(scope) {
      if (!scope) return null
      try {
        if (typeof scope.get === 'function') {
          const viaGet = scope.get('remote.settings')
          if (viaGet) return viaGet
        }
      } catch { /* 未挂载的名字：下一个候选 */ }
      try {
        const viaKey = scope['remote.settings']
        if (viaKey) return viaKey
      } catch { /* guarded */ }
      let remote = null
      try { if (typeof scope.get === 'function') remote = scope.get('remote') || null } catch { /* 未注入 */ }
      if (!remote) { try { remote = scope.remote || null } catch { /* guarded */ } }
      if (remote) {
        try { const viaRemote = remote.settings || null; if (viaRemote) return viaRemote } catch { /* guarded */ }
      }
      try { if (scope.remote && scope.remote.settings) return scope.remote.settings } catch { /* guarded */ }
      try {
        if (typeof scope.get === 'function') {
          const shortGet = scope.get('settings')
          if (shortGet && typeof shortGet.describe === 'function') return shortGet
        }
      } catch { /* 未注入 */ }
      try {
        const viaProp = scope.settings || null
        if (viaProp && typeof viaProp.describe === 'function') return viaProp
      } catch { /* guarded */ }
      return null
    }

    /** 解 typert 信封 {ok,value} / {ok:false,error}。 */
    function unwrapResult(response) {
      if (response && typeof response === 'object' && 'ok' in response) {
        if (response.ok === false) {
          const err = response.error
          const message = (err && (err.message || err.code)) || 'settings-request-failed'
          const failure = new Error(String(message))
          failure.remoteError = err || null
          throw failure
        }
        return Object.prototype.hasOwnProperty.call(response, 'value') ? response.value : response
      }
      return response
    }

    /** describe() 里本命名空间那一行 → 三个设置项（缺字段/非法值回落默认）。 */
    function settingsFromRow(row) {
      const value = isPlainObject(row && row.value) ? row.value : {}
      return {
        thinking: value.thinking === true,
        reasoningEffort: EFFORT_OPTIONS.indexOf(value.reasoningEffort) >= 0
          ? value.reasoningEffort
          : SETTINGS_DEFAULTS.reasoningEffort,
        maxOutputTokens: clampInt(value.maxOutputTokens, MAX_OUTPUT_TOKENS_MIN, MAX_OUTPUT_TOKENS_MAX, SETTINGS_DEFAULTS.maxOutputTokens),
      }
    }

    /**
     * 读一次设置：describe() → 找 ns === SETTINGS_NS 的那一行。
     * - 参数类型：settings -- remote.settings 控制器（可为 null）。
     * - 返回值：Promise<{settings, row}>；控制器不可用时抛 settings-unavailable。
     * - 调用样例：const { settings } = await readSettings(readRemoteSettings(ctx))
     */
    async function readSettings(settings) {
      if (!settings || typeof settings.describe !== 'function') throw new Error('settings-unavailable')
      const view = unwrapResult(await settings.describe())
      const namespaces = view && Array.isArray(view.namespaces) ? view.namespaces : []
      const row = namespaces.find((entry) => entry && entry.ns === SETTINGS_NS) || null
      return { settings: settingsFromRow(row), row }
    }

    /**
     * 写一次设置。update 在设置服务里是深合并，但这里写的都是标量键，
     * 不存在「删键」问题，所以不需要 replace。
     * - 参数类型：settings -- remote.settings 控制器；patch -- 三个设置项。
     * - 返回值：Promise<object> -- 实际写入的归一化值。
     * - 调用样例：await saveSettings(settings, { thinking: true, reasoningEffort: 'high', maxOutputTokens: 512 })
     */
    async function saveSettings(settings, patch) {
      if (!settings || typeof settings.update !== 'function') throw new Error('settings-unavailable')
      const source = isPlainObject(patch) ? patch : {}
      const payload = {
        thinking: source.thinking === true,
        reasoningEffort: EFFORT_OPTIONS.indexOf(source.reasoningEffort) >= 0
          ? source.reasoningEffort
          : SETTINGS_DEFAULTS.reasoningEffort,
        maxOutputTokens: clampInt(source.maxOutputTokens, MAX_OUTPUT_TOKENS_MIN, MAX_OUTPUT_TOKENS_MAX, SETTINGS_DEFAULTS.maxOutputTokens),
      }
      unwrapResult(await settings.update(SETTINGS_NS, payload, undefined))
      return payload
    }

    /** 档位文案（缺翻译时回落档位 id）。 */
    function effortLabel(id) {
      const text = __t('settings.effort.' + id)
      return text === 'settings.effort.' + id ? id : text
    }

    /**
     * 设置分页组件（槽位 settings.localPlugins.tab，无 props）。
     * - 参数类型：无。
     * - 返回值：React 元素。
     * - 调用样例：由 slots 以 settings.localPlugins.tab 注册。
     */
    function SettingsSection() {
      useLocaleRevision()
      const [draft, setDraft] = useState(null)
      const [busy, setBusy] = useState(null)
      const [notice, setNotice] = useState(null)
      const [failure, setFailure] = useState(null)
      const [baseline, setBaseline] = useState(null) // 最近一次从服务端读到/写回的值，用来算「未保存」
      const settingsRef = useRef(undefined)

      const settingsOf = () => {
        if (settingsRef.current === undefined) settingsRef.current = readRemoteSettings(__ctx)
        return settingsRef.current
      }

      const load = useCallback(async () => {
        setBusy('load')
        setFailure(null)
        try {
          const result = await readSettings(settingsOf())
          setDraft(result.settings)
          setBaseline(result.settings)
          setNotice(null)
        } catch (error) {
          setFailure(describeError(error))
        } finally {
          setBusy(null)
        }
      }, [])

      useEffect(() => { load() }, [load])

      const save = useCallback(async () => {
        if (!draft) return
        setBusy('save')
        setNotice(null)
        setFailure(null)
        try {
          const saved = await saveSettings(settingsOf(), draft)
          setDraft(saved)
          setBaseline(saved)
        } catch (error) {
          setFailure(describeError(error))
        } finally {
          setBusy(null)
        }
      }, [draft])

      const restoreDefaults = useCallback(() => {
        setDraft(Object.assign({}, SETTINGS_DEFAULTS))
        setNotice(__t('settings.resetReady'))
        setFailure(null)
      }, [])

      const value = draft || SETTINGS_DEFAULTS
      const locked = busy !== null
      const patch = (bucket) => setDraft(Object.assign({}, value, bucket))
      // 是否有未保存改动（baseline = 最近一次读写成功的值；未加载完成时不算脏）。
      const dirty = draft !== null && baseline !== null && !sameSettings(draft, baseline)

      // 一行状态区：未保存提示 + 本次调用实际下发的参数，省得用户自己推演三项的相互作用。
      const statusLine = React.createElement('div', { key: 'status', style: STY.field }, [
        React.createElement('div', { key: 'dirty', style: dirty ? STY.ok : STY.hint }, dirty ? __t('settings.dirty') : __t('settings.clean')),
        React.createElement('div', { key: 'effective', style: STY.hint }, effectiveSummary(value)),
      ])

      const thinkingField = React.createElement('div', { key: 'thinking', style: STY.field }, [
        React.createElement('div', { key: 'head', style: STY.row }, [
          React.createElement('input', {
            key: 'box',
            type: 'checkbox',
            checked: value.thinking === true,
            disabled: locked,
            style: { margin: 0 },
            onChange: (event) => {
              const on = !!(event && event.target && event.target.checked)
              // 打开时把档位抬到可选表内（默认 low），避免「思考开 + off」这种自相矛盾的组合。
              patch(on
                ? { thinking: true, reasoningEffort: activeEffortOf(value.reasoningEffort) }
                : { thinking: false })
            },
          }),
          React.createElement('span', { key: 'label', style: STY.label }, __t('settings.thinking')),
        ]),
        React.createElement('div', { key: 'hint', style: STY.hint }, __t('settings.thinkingHint')),
      ])

      // 档位：思考关时只解释「不下发」，打开后才出现单选（4 档，无 off —— off 就是关）。
      const effortField = value.thinking === true
        ? React.createElement('div', { key: 'effort', style: STY.field }, [
            React.createElement('div', { key: 'label', style: STY.label }, __t('settings.effort')),
            React.createElement('div', { key: 'choices', style: STY.row }, ACTIVE_EFFORT_OPTIONS.map((id) => React.createElement('label', {
              key: id,
              style: STY.choice,
            }, [
              React.createElement('input', {
                key: 'radio',
                type: 'radio',
                name: 'session-title-regen-effort',
                checked: activeEffortOf(value.reasoningEffort) === id,
                disabled: locked,
                style: { margin: 0 },
                onChange: () => patch({ reasoningEffort: id }),
              }),
              React.createElement('span', { key: 'text' }, effortLabel(id)),
            ]))),
            React.createElement('div', { key: 'hint', style: STY.hint }, __t('settings.effortHint')),
          ])
        : React.createElement('div', { key: 'effort', style: STY.field }, [
            React.createElement('div', { key: 'label', style: STY.label }, __t('settings.effort')),
            React.createElement('div', { key: 'hint', style: STY.hint }, __t('settings.effortWhenOff')),
          ])

      const tokenField = React.createElement('div', { key: 'tokens', style: STY.field }, [
        React.createElement('div', { key: 'label', style: STY.label }, __t('settings.maxTokens')),
        React.createElement('input', {
          key: 'input',
          type: 'number',
          min: MAX_OUTPUT_TOKENS_MIN,
          max: MAX_OUTPUT_TOKENS_MAX,
          value: String(value.maxOutputTokens),
          disabled: locked,
          style: STY.input,
          // 输入过程中保留原串（否则打不出 8、清空会被立刻弹回旧值），离开输入框时再夹取。
          onChange: (event) => patch({ maxOutputTokens: event && event.target ? event.target.value : '' }),
          onBlur: () => patch({ maxOutputTokens: clampInt(value.maxOutputTokens, MAX_OUTPUT_TOKENS_MIN, MAX_OUTPUT_TOKENS_MAX, SETTINGS_DEFAULTS.maxOutputTokens) }),
        }),
        React.createElement('div', { key: 'hint', style: STY.hint }, __t('settings.maxTokensHint')),
      ])

      const actions = React.createElement('div', { key: 'actions', style: STY.row }, [
        React.createElement('button', { key: 'save', type: 'button', style: STY.btnPrimary, disabled: locked || !draft, onClick: save },
          busy === 'save' ? __t('settings.saving') : __t('settings.save')),
        React.createElement('button', { key: 'reset', type: 'button', style: STY.btn, disabled: locked, onClick: restoreDefaults }, __t('settings.reset')),
        React.createElement('button', { key: 'reload', type: 'button', style: STY.btn, disabled: locked, onClick: load }, __t('settings.reload')),
      ])

      return React.createElement('div', { style: STY.wrap }, [
        React.createElement('div', { key: 'card', style: STY.card }, [
          React.createElement('div', { key: 'intro', style: STY.hint }, __t('settings.intro')),
          thinkingField,
          effortField,
          tokenField,
          React.createElement('div', { key: 'sep', style: { borderTop: '1px solid var(--dsw-border,rgba(127,127,127,.25))' } }),
          statusLine,
        ]),
        actions,
        notice ? React.createElement('div', { key: 'notice', style: STY.ok }, notice) : null,
        failure ? React.createElement('div', { key: 'failure', style: STY.bad }, __t('settings.error') + failure) : null,
      ])
    }

    // --- feedback overlay host -------------------------------------------------

    /**
     * shell.overlay 占位：监听结果事件并渲染一条 Toast。
     * - 参数类型：无（槽位组件）。
     * - 返回值：React 元素（无事件时 null）。
     * - 调用样例：由 slots 以 shell.overlay 注册。
     */
    function TitleFeedbackHost() {
      const [toast, setToast] = useState(null) // {seq, ok, message}
      const seqRef = useRef(0)

      useEffect(() => {
        const handler = (e) => {
          const d = (e && e.detail) || {}
          seqRef.current += 1
          setToast({
            seq: seqRef.current,
            ok: d.ok === true,
            message: (d.ok ? (d.title || '') : (d.message || '')),
          })
        }
        window.addEventListener(RESULT_EVENT, handler)
        return () => window.removeEventListener(RESULT_EVENT, handler)
      }, [])

      if (!toast) return null
      const text = toast.ok
        ? __t('toast.success') + toast.message
        : (toast.message || __t('toast.failed'))
      const icon = toast.ok
        ? React.createElement(IconCheckOutline16, { size: 14 })
        : React.createElement(IconWarningOutline16, { size: 14 })
      return React.createElement(Toast, {
        key: toast.seq,
        text,
        icon,
        onDone: () => setToast(null),
      })
    }

    // --- apply ----------------------------------------------------------------

    /** 接管 locale 服务并注册中英文字典。 */
    function adoptLocale(locale, ctx) {
      if (!locale) return
      __locale = locale
      try {
        if (typeof locale.register === 'function') {
          ctx.effect(() => locale.register(NS, { zh: zhDict, en: enDict }))
        }
      } catch { /* namespace already registered: keep the existing copy */ }
    }

    /**
     * 客户端插件入口：注册头部按钮、反馈 overlay 与菜单注入。
     * - 参数类型：ctx -- Context（client root）。
     * - 返回值：无。
     * - 调用样例：由 dsh-client-modules 按 inject/apply 约定调用。
     */
    function apply(ctx) {
      __ctx = ctx
      // remote.commands 是 dotted 控制器：必须经 ctx.get('remote.commands') 或
      // 注入作用域取得，直接读 bare `remote` 根的 .commands 会抛 without inject。
      __commands = __readCommands(__ctx)
      if (!__commands) {
        ctx.inject(['remote.commands'], (sub) => {
          __scope = sub
          __commands = __readCommands(sub)
        })
      }
      __sessionsSvc = __lookup('sessions')
      if (!__sessionsSvc) {
        ctx.inject(['sessions'], (sub) => {
          __scope = sub
          __sessionsSvc = sub.sessions
        })
      }
      adoptLocale(ctx.get('locale'), ctx)
      if (!__locale) {
        ctx.inject(['locale'], (sub) => {
          __scope = sub
          adoptLocale(__readService(sub, 'locale') || sub.locale, ctx)
          refreshMenuLabel()
        })
      }
      ctx.on('locale/change', refreshMenuLabel)
      ctx.slots.inject(SLOT, () => ctx.slots.register({
        name: SLOT,
        id: ROW_ID,
        order: ROW_ORDER,
        ...(__locale ? { locale: NS } : {}),
      }, RegenerateTitleButton))
      ctx.slots.inject(OVERLAY_SLOT, () => ctx.slots.register({
        name: OVERLAY_SLOT,
        id: OVERLAY_ID,
        order: 100,
        ...(__locale ? { locale: NS } : {}),
      }, TitleFeedbackHost))
      // 核心「本地插件」页里的分页（本插件只贡献这一个 tab，不占用设置导航行）。
      ctx.slots.inject(TAB_SLOT, () => ctx.slots.register({
        name: TAB_SLOT,
        id: TAB_ID,
        order: TAB_ORDER,
        label: () => __t('tab.title'),
        ...(__locale ? { locale: NS } : {}),
      }, SettingsSection))
      installMenuInjection()
    }

    // Test-only hooks: exposed only when the harness sets window.__DSH_TEST__,
    // so the logic harness can drive the module-scoped helpers without a
    // browser (see test/bundle.test.mjs). `reset` clears the module-level
    // service handles so each harness boot starts from a clean slate. Inert
    // in production (apply runs once per page life).
    if (typeof window !== 'undefined' && window.__DSH_TEST__) {
      window.__sessionTitleRegenTest = {
        executeRegenerate,
        resolveSessionIdByTitle,
        ensureMenuItem,
        findOpenSessionRow,
        readRowTitle,
        __t,
        SettingsSection,
        settingsFromRow,
        readSettings,
        saveSettings,
        readRemoteSettings,
        unwrapResult,
        clampInt,
        activeEffortOf,
        sameSettings,
        effectiveSummary,
        TAB_SLOT,
        SETTINGS_NS,
        EFFORT_OPTIONS,
        ACTIVE_EFFORT_OPTIONS,
        SETTINGS_DEFAULTS,
        reset() {
          __scope = null
          __ctx = null
          __commands = null
          __sessionsSvc = null
          __locale = null
          __menuInstalled = false
        },
      }
    }

    // The loader gates apply() until `slots` exists; remote/sessions/locale
    // are resolved independently above through deferred injects.
    return { apply, inject: ['slots'] }
  },
})
//# sourceURL=/dsh-session-title-regenerate/src/client.js
