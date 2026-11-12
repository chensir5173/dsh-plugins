// dsh-sidebar-footer-stack: node (host) half.
//
// WHY THIS HALF EXISTS
// The core sidebar (@deepseek-ai/dsh-client-ui-sidebar) renders the bottom-left
// corner as
//     div.hHd-Xa_footArea (flex-direction: column)
//       > div.hHd-Xa_footerActions   <- slot "sidebar.footer.action" (kind: "list")
//       > div.hHd-Xa_settingsArea    <- slot "sidebar.settings"     (kind: "single")
// and its stylesheet gives .hHd-Xa_footerActions { display: flex } with NO
// flex-direction, so it defaults to `row`: every plugin registered into
// "sidebar.footer.action" (remote bridge, usage/billing, update, ...) is packed
// side by side into the same 264px row.
//
// THE WRAPPER LAYER (measured in a real browser, DSH 0.3.x)
// The list slot never puts plugin elements directly under footerActions: it
// renders ONE wrapper child, and the plugin entries are that wrapper's children:
//     footerActions (264x64, row)
//       > div            (the slot wrapper)
//           > div.dshRemoteSidebarEntry   (264x36)
//           > span.KFXqYa_triggerWrap     (264x64)  <- starts at x=272: outside the rail
// So a rule that only touches footerActions or only its direct children CANNOT
// stack the entries. Both layers must be turned into columns, and the entries
// themselves must get width:100%.
//
// WHAT WENT WRONG IN v0.1.0 (do not regress this)
// v0.1.0 used `:not(:has(> * + *))` to detect "only one footer entry" and fall
// back to the core row layout. But footerActions has ONE direct child (the
// wrapper), so the guard always fired: the row override landed after the column
// rule with the same specificity and flipped the stack back to row, while
// `> * {width:100%}` made the wrapper full-width and the two entries (each
// width:100% inside the wrapper's row) started at x=8 and x=272 — the usage card
// was pushed completely outside the 264px rail, leaving an 8px sliver visible.
// The guard therefore counts THROUGH the wrapper:
//     :not(:has(> * + *)):not(:has(> * > * + *))
// -> "at most one direct child AND none of them has two children" == at most one
// entry. Never drop the second :not().
//
// INJECTION SEAM
// @deepseek-ai/dsh-host-webserver hands every plugin an index-injection table
// (`const table = []; ctx.emit('webserver/index-inject', table)` -> rows of
// { kind: 'style', text }) which is rendered into <head>. Web collects it per
// request (a reload is enough); desktop collects once at app-ready (a restart is
// required). cordis dispatch is a global broadcast, so a plain ctx.on() from a
// profile-level plugin context receives it and no service has to be injected.
//
// TWO GUARDS, both load-bearing:
//   1. COLLAPSED RAIL. In the collapsed sidebar the core already forces
//      `.collapsed .footerActions{width:auto;justify-content:center}` and there
//      is no room for a full-width stack. The collapsed state is expressed as an
//      ancestor class (hHd-Xa_collapsed), so the guard is a plain descendant rule
//      `[class*="_collapsed"] [class*="_footArea"] > [class*="_footerActions"]`
//      written LAST: same-or-higher specificity, later in the sheet, wins.
//      (v0.1.0 used a @container (min-width:120px) query instead, which required
//      `container-type:inline-size` on footArea — an extra contain:layout in the
//      page for no benefit. Dropped: no containment side effects now.)
//   2. SINGLE ENTRY. With one footer plugin (or none) a column is pointless and
//      would change today's look for no reason, so the two :not(:has()) guards
//      above restore the core row layout.
//
// Class names are CSS-module hashes ("hHd-Xa_footerActions"): the hash prefix
// changes between DSH versions, the _footArea / _footerActions suffixes do not,
// and the DOM carries no data-* anchor — hence the [class*="_..."] match.
//
// ESM module format (cordis bundle rule): named exports name / inject / apply.

const name = 'sidebar-footer-stack'

/** The seam is a plain cordis event, so nothing has to be injected. */
const inject = []

// --- defaults -----------------------------------------------------------------

/**
 * Plugin defaults.
 * - enabled: false ships no CSS at all (the core, horizontal layout stays).
 * - gap: distance between stacked footer entries, in px.
 * - stackSingle: false keeps a lone footer entry horizontal (core behaviour).
 */
const DEFAULTS = {
  enabled: true,
  gap: 4,
  stackSingle: false,
}

/** Accepted bounds: a larger gap overlaps neighbours. */
const GAP_MIN = 0
const GAP_MAX = 24

/** Marker the injected stylesheet starts with; the client half greps <style> for it. */
const STYLE_MARKER = '/* dsh-sidebar-footer-stack */'

/** Suffix-stable halves of the two core CSS-module class names. */
const FOOT_AREA_SELECTOR = '[class*="_footArea"]'
const FOOTER_ACTIONS_SELECTOR = '[class*="_footerActions"]'

/** Marker attribute the client half looks for (it never injects a second copy). */
const STYLE_ID = 'dsh-sidebar-footer-stack'

// --- pure helpers (unit-tested without a browser) ------------------------------

/**
 * 把任意输入夹到 [min, max]；非数字回落 fallback（整数化，CSS 里只用 px 整数）。
 * @param {unknown} value 配置值
 * @param {number} min 下界
 * @param {number} max 上界
 * @param {number} fallback 非法输入时的回落值
 * @returns {number}
 */
function clampInt(value, min, max, fallback) {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  const rounded = Math.round(n)
  if (rounded < min) return min
  if (rounded > max) return max
  return rounded
}

/**
 * 归一化 Loader 行 / 配置对象（补默认、夹边界、丢非法类型）。
 * @param {unknown} input 原始配置
 * @returns {{enabled:boolean,gap:number,stackSingle:boolean}}
 */
function normalizeEntryConfig(input) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  return {
    enabled: source.enabled !== false,
    gap: clampInt(source.gap, GAP_MIN, GAP_MAX, DEFAULTS.gap),
    stackSingle: source.stackSingle === true,
  }
}

/**
 * 生成注入用的整段 CSS：marker + 两条竖排规则（槽位层、包装层、条目层）
 * + 可选单条回退 + 折叠态回退（永远最后）。
 * @param {unknown} input 原始配置
 * @returns {string} 空串表示禁用（调用方不注册监听器）
 */
function buildCss(input) {
  const config = normalizeEntryConfig(input)
  if (!config.enabled) return ''
  const gap = config.gap
  const actions = FOOT_AREA_SELECTOR + ' > ' + FOOTER_ACTIONS_SELECTOR
  const wrapper = actions + ' > *'
  const entry = wrapper + ' > *'

  const rules = [
    // 1) 槽位本身竖排：stretch 让每个条目都拿到整条侧边栏宽度（usage 卡片因此
    //    离开它自己的 @container (width<=210px) 降级区间）。
    actions + '{flex-direction:column !important;align-items:stretch !important;justify-content:flex-start !important;gap:' + gap + 'px !important;width:100% !important}',
    // 2) 槽位包装层也必须是竖排——核心只在这里放一个 wrapper，插件条目是它的
    //    子元素；少了这条，两个条目会在 wrapper 内部继续横排并各自撑满宽度，
    //    第二个条目直接被顶到侧边栏外面（v0.1.0 的真实事故）。
    wrapper + '{flex:0 0 auto !important;display:flex !important;flex-direction:column !important;align-items:stretch !important;justify-content:flex-start !important;gap:' + gap + 'px !important;width:100% !important;min-width:0 !important;max-width:100% !important;box-sizing:border-box !important}',
    // 3) 条目本身占满整宽：usage 卡片自带 min-width:96px，容器够宽时无需它兜底，
    //    留着反而会在窄轨里溢出。
    entry + '{flex:0 0 auto !important;width:100% !important;min-width:0 !important;max-width:100% !important;box-sizing:border-box !important}',
  ]

  if (!config.stackSingle) {
    // 只有「总条目数 <= 1」才回退核心横向布局。判据必须穿透包装层：
    //   :not(:has(> * + *))        直接子元素 <= 1
    //   :not(:has(> * > * + *))    且没有任何直接子元素内部存在兄弟对
    // 两条同时成立才是真的只有一个条目。缺了第二条，单 wrapper 的常规结构会被
    // 误判成「单条」，row 覆盖 column，v0.1.0 的事故就是这样产生的。
    const single = actions + ':not(:has(> * + *)):not(:has(> * > * + *))'
    rules.push(single + '{flex-direction:row !important;align-items:center !important;justify-content:flex-start !important;gap:0 !important;width:100% !important}')
    rules.push(single + ' > *{display:block !important;flex:0 1 auto !important;width:auto !important;min-width:0 !important;max-width:none !important}')
    rules.push(single + ' > * > *{width:auto !important;max-width:none !important}')
  }

  // 折叠轨：核心自己的布局是居中横排，这里显式还原。特异性 (0,3,0) 高于上面
  // 所有 (0,2,0) 规则，且排在最后，双保险。
  const collapsed = '[class*="_collapsed"] ' + actions
  rules.push(collapsed + '{flex-direction:row !important;align-items:center !important;justify-content:center !important;gap:0 !important;width:auto !important}')
  rules.push(collapsed + ' > *{display:flex !important;flex-direction:row !important;align-items:center !important;justify-content:center !important;gap:0 !important;flex:0 1 auto !important;width:auto !important;min-width:0 !important;max-width:none !important}')
  rules.push(collapsed + ' > * > *{width:auto !important;max-width:none !important}')

  return STYLE_MARKER + '\n' + rules.join('\n') + '\n'
}

/**
 * 把一段 CSS 追加进 index 注入表（同一段只出现一次：web 每次请求都会重新 collect）。
 * @param {unknown} table 核心传进来的行数组
 * @param {string} css 样式文本
 * @returns {boolean} 是否真的写入了行
 */
function pushStyleRow(table, css) {
  if (!Array.isArray(table) || !css) return false
  for (const row of table) {
    if (row && row.kind === 'style' && row.text === css) return false
  }
  table.push({ kind: 'style', text: css })
  return true
}

// --- plugin body --------------------------------------------------------------

/**
 * 宿主入口：监听 index 注入事件，往表里塞一条 <style> 行。
 * @param {{on:Function}} ctx cordis 上下文
 * @param {unknown} config Loader 行配置（可选）
 * @returns {Function|undefined} 取消监听的 disposer；禁用时为 undefined
 */
function apply(ctx, config) {
  const resolved = normalizeEntryConfig(Object.assign({}, DEFAULTS, config && typeof config === 'object' ? config : {}))
  const css = buildCss(resolved)
  if (!css) return undefined
  return ctx.on('webserver/index-inject', (table) => {
    try {
      pushStyleRow(table, css)
    } catch {
      // 注入表由核心拥有：畸形输入绝不能把页面渲染带崩。
    }
  })
}

export {
  name,
  inject,
  apply,
  DEFAULTS,
  STYLE_MARKER,
  STYLE_ID,
  FOOT_AREA_SELECTOR,
  FOOTER_ACTIONS_SELECTOR,
  GAP_MIN,
  GAP_MAX,
  buildCss,
  normalizeEntryConfig,
  clampInt,
  pushStyleRow,
}
