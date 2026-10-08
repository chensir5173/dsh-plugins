// dsh-terminal-font: CLIENT half.
//
// One contribution: a Settings > 本地插件 tab (slot settings.localPlugins.tab) that
// (a) DIAGNOSES whether the injected @font-face pair actually resolved on this machine
// and whether the terminal cell width still matches Consolas 13px, and (b) edits the same
// five keys the host half reads (entry Config, namespace `terminal-font`).
//
// Why a tab and not a silent CSS injection: the fix only works when the Nerd Font is
// installed, and the failure mode is invisible (tofu glyphs look the same as a missing
// font). The probe therefore reports, in one screen:
//   - whether the marker stylesheet reached <head> at all (desktop collects injections
//     once at app-ready, so a stale page shows "not injected" until a restart);
//   - the FontFace status of each injected family after document.fonts.load() forces
//     resolution of the local() source (loaded / error = font missing / missing);
//   - the REAL rendered cell width, measured by appending an offscreen span in the
//     terminal's computed font stack and dividing by the character count. Measured in the
//     DOM on purpose: canvas measureText is not a reliable proxy for size-adjust.
//
// Bundle format (client-modules protocol): classic script registering a factory via
// window.__ModuleLoader__.load({ id, factory }); the factory receives `require` and
// returns the plugin exports. No JSX: plain React.createElement, theme tokens only.
window.__ModuleLoader__.load({
  id: 'dsh-terminal-font',
  factory: (require) => {
    const React = require('react')
    const { useCallback, useEffect, useRef, useState } = React

    // --- constants ------------------------------------------------------------

    const NS = 'terminal-font'
    const SETTINGS_NS = 'terminal-font'
    const TAB_SLOT = 'settings.localPlugins.tab'
    const TAB_ID = 'terminal-font'
    const TAB_ORDER = 46

    const MONO_FAMILY = 'DSH Terminal Mono'
    const CJK_FAMILY = 'DSH Terminal CJK'
    const STYLE_MARKER = '/* dsh-terminal-font */'
    const TERMINAL_FONT_SIZE_PX = 13
    /** Consolas advance: 1126/2048 em — the cell width the injected CSS must preserve. */
    const CONSOLAS_ADVANCE_EM = 1126 / 2048
    const SIZE_ADJUST_MIN = 10
    const SIZE_ADJUST_MAX = 400
    const CELL_TOLERANCE_PX = 0.05

    const SETTINGS_DEFAULTS = {
      enabled: true,
      monoFont: '0xProto Nerd Font Mono, 0xProto Nerd Font',
      cjkFont: 'Sarasa Term SC Nerd',
      monoSizeAdjust: 88.6781,
      cjkSizeAdjust: 109.9609,
    }

    // --- locale ---------------------------------------------------------------

    const zhDict = {
      'tab.title': '终端字体',
      'intro': '侧边栏终端（xterm）用核心硬编码的 Consolas 字体栈，Powerline / Nerd Font 图标会显示成豆腐块。本插件往页面注入两条带 size-adjust 的 @font-face，把本地 Nerd Font 的字符宽度归一到 Consolas 13px 的单元格宽度，所以列宽与光标位置不变。',
      'diag.title': '诊断',
      'diag.refresh': '重新检测',
      'diag.running': '检测中…',
      'diag.injected': 'CSS 注入',
      'diag.injectedYes': '已注入',
      'diag.injectedNo': '未注入（Web 端刷新页面；桌面端需重启 DSH Desktop）',
      'diag.fontMono': 'Nerd Font 字形',
      'diag.fontCjk': '中文字体',
      'diag.fontSize': '终端字号',
  'diag.fontSizeValue': '{v}px（由核心固定）',
  'diag.cell': '终端单元格宽度',
      'diag.cellValue': '实测 {m}px / 目标 {t}px',
      'diag.cellMismatch': '实测与目标不一致：字号或字体栈被改过？',
      'diag.noTerminal': '未检测到终端（先打开侧边栏终端再检测）',
      'diag.stack': '终端字体栈',
      'diag.status.loaded': '已加载',
      'diag.status.loading': '加载中',
      'diag.status.unloaded': '未加载',
      'diag.status.error': '加载失败（本机没装这个字体？）',
      'diag.status.missing': '未声明（CSS 未注入，或字体族名不匹配）',
      'settings.title': '设置',
      'settings.enabled': '启用注入',
      'settings.enabledHint': '关掉后页面回到核心字体栈。',
      'settings.monoFont': '等宽 / Nerd Font 候选',
      'settings.monoFontHint': '逗号分隔，按顺序 local() 匹配，命中即用。',
      'settings.cjkFont': '中文字体候选',
      'settings.cjkFontHint': '同上；全角宽度会被缩放到 2 个单元格。',
      'settings.monoAdjust': '等宽 size-adjust (%)',
      'settings.monoAdjustHint': '88.6781 让 0xProto Nerd Font（advance 0.62em）对齐 Consolas 13px。',
      'settings.cjkAdjust': '中文 size-adjust (%)',
      'settings.cjkAdjustHint': '109.9609 让 Sarasa Term SC Nerd（advance 0.5em）对齐 Consolas 13px。',
      'settings.save': '保存',
      'settings.saving': '保存中…',
      'settings.reset': '恢复默认',
      'settings.reload': '重新读取',
      'settings.dirty': '● 有未保存改动',
      'settings.clean': '与已保存值一致',
      'settings.savedHint': '已保存：Web 端刷新页面生效，桌面端需重启 DSH Desktop。',
      'settings.error': '设置请求失败：',
    }

    const enDict = {
      'tab.title': 'Terminal font',
      'intro': 'The sidebar terminal (xterm) uses the core hard-coded Consolas stack, so Powerline / Nerd Font glyphs render as tofu. This plugin injects two @font-face rules with size-adjust that normalize a locally installed Nerd Font to the Consolas 13px cell width, keeping columns and the cursor on the same grid.',
      'diag.title': 'Diagnostics',
      'diag.refresh': 'Re-check',
      'diag.running': 'Checking…',
      'diag.injected': 'CSS injection',
      'diag.injectedYes': 'injected',
      'diag.injectedNo': 'not injected (reload the page; Desktop needs a DSH Desktop restart)',
      'diag.fontMono': 'Nerd Font glyphs',
      'diag.fontCjk': 'CJK face',
      'diag.fontSize': 'Font size',
  'diag.fontSizeValue': '{v}px (fixed by the core)',
  'diag.cell': 'Terminal cell width',
      'diag.cellValue': 'measured {m}px / target {t}px',
      'diag.cellMismatch': 'Measured width differs from the target: font-size or stack changed?',
      'diag.noTerminal': 'No terminal found (open the sidebar terminal, then re-check)',
      'diag.stack': 'Terminal font stack',
      'diag.status.loaded': 'loaded',
      'diag.status.loading': 'loading',
      'diag.status.unloaded': 'not loaded yet',
      'diag.status.error': 'failed to load (font not installed?)',
      'diag.status.missing': 'not declared (CSS not injected, or family name mismatch)',
      'settings.title': 'Settings',
      'settings.enabled': 'Enable injection',
      'settings.enabledHint': 'Off returns the page to the core font stack.',
      'settings.monoFont': 'Mono / Nerd Font candidates',
      'settings.monoFontHint': 'Comma separated; local() is tried in order, first hit wins.',
      'settings.cjkFont': 'CJK candidates',
      'settings.cjkFontHint': 'Same syntax; full-width glyphs scale to 2 cells.',
      'settings.monoAdjust': 'Mono size-adjust (%)',
      'settings.monoAdjustHint': '88.6781 aligns 0xProto Nerd Font (0.62em advance) to Consolas 13px.',
      'settings.cjkAdjust': 'CJK size-adjust (%)',
      'settings.cjkAdjustHint': '109.9609 aligns Sarasa Term SC Nerd (0.5em advance) to Consolas 13px.',
      'settings.save': 'Save',
      'settings.saving': 'Saving…',
      'settings.reset': 'Restore defaults',
      'settings.reload': 'Reload',
      'settings.dirty': '● Unsaved changes',
      'settings.clean': 'Matches the saved value',
      'settings.savedHint': 'Saved: reload the page on web, restart DSH Desktop otherwise.',
      'settings.error': 'Settings request failed: ',
    }

    var __locale = null
    var __ctx = null
    var __scope = null

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

    /** 文案模板：把 {name} 占位符换成实参。 */
    function __tf(key, params) {
      let text = __t(key)
      const source = params && typeof params === 'object' ? params : {}
      for (const name_ of Object.keys(source)) {
        text = text.split('{' + name_ + '}').join(String(source[name_]))
      }
      return text
    }

    /** 随 locale 快照变化重渲染。 */
    function useLocaleRevision() {
      const [, setRev] = useState(0)
      useEffect(() => {
        if (!__locale || typeof __locale.subscribe !== 'function') return undefined
        return __locale.subscribe(() => setRev((v) => v + 1))
      }, [])
    }

    // --- diagnostics (pure enough to unit-test with a stub document) -----------

    function clampNumber(value, min, max, fallback) {
      const n = typeof value === 'number' ? value : Number(value)
      if (!Number.isFinite(n)) return fallback
      if (n < min) return min
      if (n > max) return max
      return n
    }

    function normalizeFaceName(value) {
      return String(value || '').replace(/^["']/, '').replace(/["']$/, '').toLowerCase()
    }

    /** 页面 <head> / <body> 里是否存在本插件注入的样式（看 marker 注释）。 */
    function styleInjected(doc) {
      try {
        if (!doc || typeof doc.querySelectorAll !== 'function') return false
        for (const node of doc.querySelectorAll('style')) {
          if (String((node && node.textContent) || '').indexOf(STYLE_MARKER) >= 0) return true
        }
      } catch { /* 探测失败按未注入处理 */ }
      return false
    }

    /** 收集当前文档里已声明的 FontFace（FontFaceSet 是 iterable）。 */
    function collectFontFaces(doc) {
      const faces = []
      try {
        const fonts = doc && doc.fonts
        if (!fonts) return faces
        if (typeof fonts.forEach === 'function') {
          fonts.forEach((face) => faces.push(face))
          return faces
        }
        if (typeof fonts[Symbol.iterator] === 'function') {
          for (const face of fonts) faces.push(face)
        }
      } catch { /* 按空集合处理 */ }
      return faces
    }

    /** 某个注入 family 的 FontFace 状态；没有声明返回 'missing'。 */
    function pickFaceStatus(faces, family) {
      const wanted = normalizeFaceName(family)
      let found = null
      for (const face of faces || []) {
        if (normalizeFaceName(face && face.family) === wanted) found = face
      }
      if (!found) return 'missing'
      const status = String(found.status || '')
      return status === 'loaded' || status === 'loading' || status === 'error' ? status : 'unloaded'
    }

    /**
     * 触发 local() 源解析并回报两个 family 的状态。
     * load() 是让浏览器真正去解析 @font-face 的唯一手段：没装字体时 FontFace 会落到 'error'。
     */
    async function probeFonts(doc) {
      const fonts = doc && doc.fonts
      const trigger = async (family) => {
        try {
          if (fonts && typeof fonts.load === 'function') await fonts.load('13px "' + family + '"', 'W')
        } catch { /* 加载失败由 status 反映 */ }
      }
      await trigger(MONO_FAMILY)
      await trigger(CJK_FAMILY)
      const faces = collectFontFaces(doc)
      return { mono: pickFaceStatus(faces, MONO_FAMILY), cjk: pickFaceStatus(faces, CJK_FAMILY) }
    }

    /** 终端文本宿主的真实字号与字体栈（没开终端时 null）。 */
    function readTerminalProbe(doc) {
      try {
        if (!doc || typeof doc.querySelector !== 'function') return null
        const el = doc.querySelector('.xterm-rows') || doc.querySelector('.xterm')
        if (!el) return null
        const view = doc.defaultView || (typeof window !== 'undefined' ? window : null)
        if (!view || typeof view.getComputedStyle !== 'function') return null
        const style = view.getComputedStyle(el)
        const size = Number.parseFloat(style && style.fontSize)
        return {
          fontFamily: (style && style.fontFamily) || '',
          fontSizePx: Number.isFinite(size) ? size : TERMINAL_FONT_SIZE_PX,
        }
      } catch { return null }
    }

    /**
     * 用离屏 span 在真实渲染路径上量单元格宽度（canvas measureText 不保证应用 size-adjust）。
     * - 参数类型：doc -- Document；fontFamily -- computed font-family 串；fontSizePx -- number。
     * - 返回值：number | null —— 单字符平均宽度，量不到返回 null。
     * - 调用样例：measureCellWidth(document, getComputedStyle(el).fontFamily, 13)
     */
    function measureCellWidth(doc, fontFamily, fontSizePx, sample) {
      try {
        if (!doc || typeof doc.createElement !== 'function' || !doc.body) return null
        const glyph = typeof sample === 'string' && sample ? sample : 'M'
        const repeats = 32
        const span = doc.createElement('span')
        span.textContent = new Array(repeats + 1).join(glyph)
        span.style.cssText = 'position:absolute;left:-9999px;top:0;visibility:hidden;white-space:pre;'
          + 'font-family:' + fontFamily + ';font-size:' + fontSizePx + 'px;line-height:normal;'
        doc.body.appendChild(span)
        let width = 0
        try {
          const rect = typeof span.getBoundingClientRect === 'function' ? span.getBoundingClientRect() : null
          width = rect && rect.width ? rect.width / repeats : 0
        } finally {
          if (doc.body.removeChild) doc.body.removeChild(span)
        }
        return Number.isFinite(width) && width > 0 ? width : null
      } catch { return null }
    }

    /** 一次完整探测：注入态 + 两个 family 状态 + 单元格宽度（异步，含字体加载）。 */
    async function runDiagnostics(doc) {
      const target = doc || (typeof document !== 'undefined' ? document : null)
      const injected = styleInjected(target)
      const faces = await probeFonts(target)
      const terminal = readTerminalProbe(target)
      const measured = terminal ? measureCellWidth(target, terminal.fontFamily, terminal.fontSizePx) : null
      const expected = terminal ? terminal.fontSizePx * CONSOLAS_ADVANCE_EM : null
      const cellOk = measured !== null && expected !== null && Math.abs(measured - expected) <= CELL_TOLERANCE_PX
      return { injected, faces, terminal, measured, expected, cellOk }
    }

    /** 宽度显示：保留 3 位小数（7.1474609375 -> "7.147"）。 */
    function formatPx(value) {
      if (!Number.isFinite(value)) return '—'
      return String(Math.round(value * 1000) / 1000)
    }

    // --- settings service ------------------------------------------------------

    /**
     * 逐候选读取客户端 remote.settings 控制器：每个候选各自 try —— 真身 ctx 对
     * 未注入的裸属性会抛 `cannot get property "settings" without inject`。
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

    function isPlainObject(value) {
      return !!value && typeof value === 'object' && !Array.isArray(value)
    }

    /** describe() 里本命名空间那一行 → 五个设置项（缺字段/非法值回落默认）。 */
    function settingsFromRow(row) {
      const value = isPlainObject(row && row.value) ? row.value : {}
      const source = value.settings && isPlainObject(value.settings) ? value.settings : value
      return {
        enabled: source.enabled !== false,
        monoFont: typeof source.monoFont === 'string' ? source.monoFont : SETTINGS_DEFAULTS.monoFont,
        cjkFont: typeof source.cjkFont === 'string' ? source.cjkFont : SETTINGS_DEFAULTS.cjkFont,
        monoSizeAdjust: clampNumber(source.monoSizeAdjust, SIZE_ADJUST_MIN, SIZE_ADJUST_MAX, SETTINGS_DEFAULTS.monoSizeAdjust),
        cjkSizeAdjust: clampNumber(source.cjkSizeAdjust, SIZE_ADJUST_MIN, SIZE_ADJUST_MAX, SETTINGS_DEFAULTS.cjkSizeAdjust),
      }
    }

    /** 读一次设置：describe() → 找 ns === SETTINGS_NS 的那一行。 */
    async function readSettings(settings) {
      if (!settings || typeof settings.describe !== 'function') throw new Error('settings-unavailable')
      const view = unwrapResult(await settings.describe())
      const namespaces = view && Array.isArray(view.namespaces) ? view.namespaces : []
      const row = namespaces.find((entry) => entry && entry.ns === SETTINGS_NS) || null
      return { settings: settingsFromRow(row), row }
    }

    /** 写一次设置（标量键，深合并即可）。 */
    async function saveSettings(settings, patch) {
      if (!settings || typeof settings.update !== 'function') throw new Error('settings-unavailable')
      const source = isPlainObject(patch) ? patch : {}
      const payload = {
        enabled: source.enabled !== false,
        monoFont: typeof source.monoFont === 'string' ? source.monoFont : SETTINGS_DEFAULTS.monoFont,
        cjkFont: typeof source.cjkFont === 'string' ? source.cjkFont : SETTINGS_DEFAULTS.cjkFont,
        monoSizeAdjust: clampNumber(source.monoSizeAdjust, SIZE_ADJUST_MIN, SIZE_ADJUST_MAX, SETTINGS_DEFAULTS.monoSizeAdjust),
        cjkSizeAdjust: clampNumber(source.cjkSizeAdjust, SIZE_ADJUST_MIN, SIZE_ADJUST_MAX, SETTINGS_DEFAULTS.cjkSizeAdjust),
      }
      unwrapResult(await settings.update(SETTINGS_NS, payload, undefined))
      return payload
    }

    /** 五项设置是否等价（size-adjust 按夹取后的数值比较）。 */
    function sameSettings(a, b) {
      const left = isPlainObject(a) ? a : {}
      const right = isPlainObject(b) ? b : {}
      return (left.enabled !== false) === (right.enabled !== false)
        && String(left.monoFont || '') === String(right.monoFont || '')
        && String(left.cjkFont || '') === String(right.cjkFont || '')
        && clampNumber(left.monoSizeAdjust, SIZE_ADJUST_MIN, SIZE_ADJUST_MAX, SETTINGS_DEFAULTS.monoSizeAdjust)
          === clampNumber(right.monoSizeAdjust, SIZE_ADJUST_MIN, SIZE_ADJUST_MAX, SETTINGS_DEFAULTS.monoSizeAdjust)
        && clampNumber(left.cjkSizeAdjust, SIZE_ADJUST_MIN, SIZE_ADJUST_MAX, SETTINGS_DEFAULTS.cjkSizeAdjust)
          === clampNumber(right.cjkSizeAdjust, SIZE_ADJUST_MIN, SIZE_ADJUST_MAX, SETTINGS_DEFAULTS.cjkSizeAdjust)
    }

    // --- styles ----------------------------------------------------------------

    const STY = {
      wrap: { display: 'flex', flexDirection: 'column', gap: '14px', fontSize: '13px', lineHeight: 1.6 },
      card: { border: '1px solid var(--dsw-border,rgba(127,127,127,.25))', borderRadius: '10px', padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: '10px' },
      field: { display: 'flex', flexDirection: 'column', gap: '4px' },
      row: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      title: { fontSize: '13px', fontWeight: 600 },
      label: { fontSize: '13px', fontWeight: 500 },
      hint: { color: 'var(--dsw-text-secondary,#8b8b8b)', fontSize: '12px' },
      mono: { fontFamily: 'ui-monospace, Consolas, monospace', fontSize: '12px', wordBreak: 'break-all' },
      input: { width: '100%', padding: '6px 8px', borderRadius: '6px', border: '1px solid var(--dsw-border,rgba(127,127,127,.3))', background: 'transparent', color: 'inherit', font: 'inherit', boxSizing: 'border-box' },
      num: { width: '120px', padding: '6px 8px', borderRadius: '6px', border: '1px solid var(--dsw-border,rgba(127,127,127,.3))', background: 'transparent', color: 'inherit', font: 'inherit', boxSizing: 'border-box' },
      btn: { padding: '5px 12px', borderRadius: '6px', border: '1px solid var(--dsw-border,rgba(127,127,127,.3))', background: 'transparent', color: 'inherit', cursor: 'pointer', font: 'inherit' },
      btnPrimary: { padding: '5px 12px', borderRadius: '6px', border: '1px solid var(--dsw-accent,#4c8bf5)', background: 'var(--dsw-accent,#4c8bf5)', color: '#fff', cursor: 'pointer', font: 'inherit' },
      ok: { color: 'var(--dsw-success,#2e9e5b)', fontSize: '12px' },
      bad: { color: 'var(--dsw-danger,#d9534f)', fontSize: '12px' },
    }

    /** 一行诊断：左标签 + 右值（值可带语气色）。 */
    function diagRow(key, label, value, tone) {
      return React.createElement('div', { key, style: STY.row }, [
        React.createElement('span', { key: 'l', style: Object.assign({}, STY.hint, { minWidth: '132px' }) }, label),
        React.createElement('span', { key: 'v', style: tone === 'ok' ? STY.ok : (tone === 'bad' ? STY.bad : Object.assign({}, STY.mono)) }, value),
      ])
    }

    /**
     * 设置分页组件（槽位 settings.localPlugins.tab，无 props）。
     * - 参数类型：无。
     * - 返回值：React 元素。
     * - 调用样例：由 slots 以 settings.localPlugins.tab 注册。
     */
    function SettingsSection() {
      useLocaleRevision()
      const [diag, setDiag] = useState(null)
      const [probing, setProbing] = useState(true)
      const [draft, setDraft] = useState(null)
      const [baseline, setBaseline] = useState(null)
      const [busy, setBusy] = useState(null)
      const [notice, setNotice] = useState(null)
      const [failure, setFailure] = useState(null)
      const settingsRef = useRef(undefined)

      const settingsOf = () => {
        if (settingsRef.current === undefined) settingsRef.current = readRemoteSettings(__ctx)
        return settingsRef.current
      }

      const recheck = useCallback(async () => {
        setProbing(true)
        try {
          const result = await runDiagnostics(typeof document !== 'undefined' ? document : null)
          setDiag(result)
        } catch (error) {
          setDiag({ error: error && error.message ? String(error.message) : String(error) })
        } finally {
          setProbing(false)
        }
      }, [])

      const load = useCallback(async () => {
        setBusy('load')
        setFailure(null)
        try {
          const result = await readSettings(settingsOf())
          setDraft(result.settings)
          setBaseline(result.settings)
          setNotice(null)
        } catch (error) {
          setFailure(error && error.message ? String(error.message) : String(error))
        } finally {
          setBusy(null)
        }
      }, [])

      useEffect(() => { recheck() }, [recheck])
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
          setNotice(__t('settings.savedHint'))
        } catch (error) {
          setFailure(error && error.message ? String(error.message) : String(error))
        } finally {
          setBusy(null)
        }
      }, [draft])

      const value = draft || SETTINGS_DEFAULTS
      const locked = busy !== null
      const patch = (bucket) => setDraft(Object.assign({}, value, bucket))
      const dirty = draft !== null && baseline !== null && !sameSettings(draft, baseline)

      const statusOf = (status) => __t('diag.status.' + status)

      const diagCard = React.createElement('div', { key: 'diag', style: STY.card }, [
        React.createElement('div', { key: 'head', style: STY.row }, [
          React.createElement('span', { key: 't', style: STY.title }, __t('diag.title')),
          React.createElement('button', {
            key: 'refresh', type: 'button', style: STY.btn, disabled: probing, onClick: recheck,
          }, probing ? __t('diag.running') : __t('diag.refresh')),
        ]),
        !diag ? React.createElement('div', { key: 'wait', style: STY.hint }, __t('diag.running')) : null,
        diag && diag.error ? React.createElement('div', { key: 'err', style: STY.bad }, diag.error) : null,
        diag && !diag.error ? diagRow('inj', __t('diag.injected'),
          diag.injected ? __t('diag.injectedYes') : __t('diag.injectedNo'),
          diag.injected ? 'ok' : 'bad') : null,
        diag && !diag.error ? diagRow('mono', __t('diag.fontMono'), MONO_FAMILY + ' · ' + statusOf(diag.faces.mono),
          diag.faces.mono === 'loaded' ? 'ok' : 'bad') : null,
        diag && !diag.error ? diagRow('cjk', __t('diag.fontCjk'), CJK_FAMILY + ' · ' + statusOf(diag.faces.cjk),
          diag.faces.cjk === 'loaded' ? 'ok' : 'bad') : null,
        diag && !diag.error ? diagRow('size', __t('diag.fontSize'),
          diag.terminal ? __tf('diag.fontSizeValue', { v: formatPx(diag.terminal.fontSizePx) }) : __t('diag.noTerminal'),
          null) : null,
        diag && !diag.error ? diagRow('cell', __t('diag.cell'),
          diag.terminal
            ? __tf('diag.cellValue', { m: formatPx(diag.measured), t: formatPx(diag.expected) })
            : __t('diag.noTerminal'),
          diag.terminal ? (diag.cellOk ? 'ok' : 'bad') : null) : null,
        diag && !diag.error && diag.terminal && !diag.cellOk
          ? React.createElement('div', { key: 'cellhint', style: STY.hint }, __t('diag.cellMismatch')) : null,
        diag && !diag.error && diag.terminal
          ? React.createElement('div', { key: 'stack', style: STY.field }, [
              React.createElement('div', { key: 'l', style: STY.hint }, __t('diag.stack')),
              React.createElement('div', { key: 'v', style: STY.mono }, diag.terminal.fontFamily),
            ]) : null,
      ])

      const settingsCard = React.createElement('div', { key: 'settings', style: STY.card }, [
        React.createElement('div', { key: 't', style: STY.title }, __t('settings.title')),
        React.createElement('label', { key: 'enabled', style: STY.row }, [
          React.createElement('input', {
            key: 'box', type: 'checkbox', checked: value.enabled !== false, disabled: locked,
            style: { margin: 0 },
            onChange: (event) => patch({ enabled: !!(event && event.target && event.target.checked) }),
          }),
          React.createElement('span', { key: 'l', style: STY.label }, __t('settings.enabled')),
        ]),
        React.createElement('div', { key: 'enabledHint', style: STY.hint }, __t('settings.enabledHint')),
        React.createElement('div', { key: 'mono', style: STY.field }, [
          React.createElement('div', { key: 'l', style: STY.label }, __t('settings.monoFont')),
          React.createElement('input', {
            key: 'i', type: 'text', value: String(value.monoFont), disabled: locked, style: STY.input,
            onChange: (event) => patch({ monoFont: event && event.target ? event.target.value : '' }),
          }),
          React.createElement('div', { key: 'h', style: STY.hint }, __t('settings.monoFontHint')),
        ]),
        React.createElement('div', { key: 'cjk', style: STY.field }, [
          React.createElement('div', { key: 'l', style: STY.label }, __t('settings.cjkFont')),
          React.createElement('input', {
            key: 'i', type: 'text', value: String(value.cjkFont), disabled: locked, style: STY.input,
            onChange: (event) => patch({ cjkFont: event && event.target ? event.target.value : '' }),
          }),
          React.createElement('div', { key: 'h', style: STY.hint }, __t('settings.cjkFontHint')),
        ]),
        React.createElement('div', { key: 'adjusts', style: STY.row }, [
          React.createElement('div', { key: 'ma', style: STY.field }, [
            React.createElement('div', { key: 'l', style: STY.label }, __t('settings.monoAdjust')),
            React.createElement('input', {
              key: 'i', type: 'number', min: SIZE_ADJUST_MIN, max: SIZE_ADJUST_MAX, step: '0.0001',
              value: String(value.monoSizeAdjust), disabled: locked, style: STY.num,
              onChange: (event) => patch({ monoSizeAdjust: event && event.target ? event.target.value : '' }),
              onBlur: () => patch({ monoSizeAdjust: clampNumber(value.monoSizeAdjust, SIZE_ADJUST_MIN, SIZE_ADJUST_MAX, SETTINGS_DEFAULTS.monoSizeAdjust) }),
            }),
          ]),
          React.createElement('div', { key: 'ca', style: STY.field }, [
            React.createElement('div', { key: 'l', style: STY.label }, __t('settings.cjkAdjust')),
            React.createElement('input', {
              key: 'i', type: 'number', min: SIZE_ADJUST_MIN, max: SIZE_ADJUST_MAX, step: '0.0001',
              value: String(value.cjkSizeAdjust), disabled: locked, style: STY.num,
              onChange: (event) => patch({ cjkSizeAdjust: event && event.target ? event.target.value : '' }),
              onBlur: () => patch({ cjkSizeAdjust: clampNumber(value.cjkSizeAdjust, SIZE_ADJUST_MIN, SIZE_ADJUST_MAX, SETTINGS_DEFAULTS.cjkSizeAdjust) }),
            }),
          ]),
        ]),
        React.createElement('div', { key: 'mh', style: STY.hint }, __t('settings.monoAdjustHint') + ' ' + __t('settings.cjkAdjustHint')),
        React.createElement('div', { key: 'sep', style: { borderTop: '1px solid var(--dsw-border,rgba(127,127,127,.25))' } }),
        React.createElement('div', { key: 'dirty', style: dirty ? STY.ok : STY.hint }, dirty ? __t('settings.dirty') : __t('settings.clean')),
      ])

      const actions = React.createElement('div', { key: 'actions', style: STY.row }, [
        React.createElement('button', { key: 'save', type: 'button', style: STY.btnPrimary, disabled: locked || !draft, onClick: save },
          busy === 'save' ? __t('settings.saving') : __t('settings.save')),
        React.createElement('button', {
          key: 'reset', type: 'button', style: STY.btn, disabled: locked,
          onClick: () => patch(Object.assign({}, SETTINGS_DEFAULTS)),
        }, __t('settings.reset')),
        React.createElement('button', { key: 'reload', type: 'button', style: STY.btn, disabled: locked, onClick: load }, __t('settings.reload')),
      ])

      return React.createElement('div', { style: STY.wrap }, [
        React.createElement('div', { key: 'intro', style: STY.card }, React.createElement('div', { style: STY.hint }, __t('intro'))),
        diagCard,
        settingsCard,
        actions,
        notice ? React.createElement('div', { key: 'notice', style: STY.ok }, notice) : null,
        failure ? React.createElement('div', { key: 'failure', style: STY.bad }, __t('settings.error') + failure) : null,
      ])
    }

    // --- apply -----------------------------------------------------------------

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
     * 客户端插件入口：注册设置分页。
     * - 参数类型：ctx -- Context（client root）。
     * - 返回值：无。
     * - 调用样例：由 dsh-client-modules 按 inject/apply 约定调用。
     */
    function apply(ctx) {
      __ctx = ctx
      adoptLocale(ctx.get('locale'), ctx)
      if (!__locale) {
        ctx.inject(['locale'], (sub) => {
          __scope = sub
          let locale = null
          try { locale = typeof sub.get === 'function' ? sub.get('locale') : null } catch { /* guarded */ }
          adoptLocale(locale || sub.locale, ctx)
        })
      }
      ctx.slots.inject(TAB_SLOT, () => ctx.slots.register({
        name: TAB_SLOT,
        id: TAB_ID,
        order: TAB_ORDER,
        label: () => __t('tab.title'),
        ...(__locale ? { locale: NS } : {}),
      }, SettingsSection))
    }

    // Test-only hooks: exposed only when the harness sets window.__DSH_TEST__, so the
    // logic harness can drive the module-scoped helpers without a browser.
    if (typeof window !== 'undefined' && window.__DSH_TEST__) {
      window.__terminalFontTest = {
        runDiagnostics,
        styleInjected,
        collectFontFaces,
        pickFaceStatus,
        probeFonts,
        readTerminalProbe,
        measureCellWidth,
        settingsFromRow,
        readSettings,
        saveSettings,
        readRemoteSettings,
        unwrapResult,
        sameSettings,
        clampNumber,
        formatPx,
        __t,
        __tf,
        SettingsSection,
        TAB_SLOT,
        TAB_ID,
        TAB_ORDER,
        SETTINGS_NS,
        MONO_FAMILY,
        CJK_FAMILY,
        STYLE_MARKER,
        SETTINGS_DEFAULTS,
        zhDict,
        enDict,
        reset() {
          __ctx = null
          __scope = null
          __locale = null
        },
      }
    }

    // The loader gates apply() until slots exists; locale is resolved independently
    // above through a deferred inject.
    return { apply, inject: ['slots'] }
  },
})
//# sourceURL=/dsh-terminal-font/src/client.js
