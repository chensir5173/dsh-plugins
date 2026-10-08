// dsh-terminal-font: node half.
//
// WHY THIS HALF EXISTS (and why the font fix cannot be client-only)
// The sidebar terminal is the core package @deepseek-ai/dsh-client-ui-sidebar-terminal,
// whose terminal.tsx hard-codes the font:
//     fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace', fontSize: 13
// There is no Config field and no CSS variable behind it. Chromium has no
// "ui-monospace" generic, SF Mono / Menlo are absent on Windows, so the real match is
// Consolas — whose cmap has no Nerd Font private-use glyphs, which is why oh-my-posh
// Powerline separators (\ue0b0), branch icons (\uf015) and locks (\ue0a0) render as tofu.
//
// Swapping the family from CSS alone is NOT safe: xterm renders and measures with the
// SAME font string. DomRenderer._injectCss writes `.xterm-rows{font-family:...}` into
// the screen while CharSizeService measures 'W' through an OffscreenCanvas and
// _setDefaultSpacing derives letter-spacing from that measurement. A family with a
// different advance therefore breaks cell math (columns drift, the cursor lands off the
// grid). The trick this plugin ships is a pair of @font-face rules that bind local()
// fonts at a size-adjust factor chosen so the new advance equals Consolas 13px exactly:
//     Consolas advance = 1126/2048 em = 0.5498046875em -> 13px * 0.5498046875 = 7.1474609375px
//     0xProto Nerd Font (Mono) advance = 0.6200em -> size-adjust 88.6781% (= 0.5498046875/0.6200)
//     Sarasa Term SC Nerd advance      = 0.5000em -> size-adjust 109.9609%
// Sarasa's full-width CJK advance is exactly twice its Latin advance, so after scaling
// CJK cells are 2 x 7.1475px — the grid xterm assumes. Because the measured advance never
// changes, nothing else has to: font-size, letter-spacing and the DOM renderer stay as
// they are, and a machine without these fonts simply falls back to Consolas (i.e. exactly
// today's behaviour).
//
// INJECTION SEAM
// @deepseek-ai/dsh-host-webserver hands every plugin an index-injection table:
//     const table = []; this.ctx.emit('webserver/index-inject', table); return table
// and renders {kind:'style'} rows into <head>. Desktop reuses the very same collect path
// (dsh-desktop-host main(): runProfile({profile:'desktop', patchFiles: []}) then
// collectIndexInjections() at app-ready), so one listener covers web AND desktop. cordis
// dispatch is a global broadcast over a shared `_hooks` map — a plain ctx.on() from any
// profile-level plugin context receives that emit, which is why this half needs no
// injected service at all.
// Timing: the web build collects per request, so a reload is enough; desktop collects once
// at app-ready, so a desktop restart is required (see ACCEPTANCE.md).
//
// ESM module format (cordis bundle rule): named exports apply/inject/name.

const name = 'terminal-font'

/** No service is required: the seam is a plain cordis event. */
const inject = []

// --- defaults -----------------------------------------------------------------

/**
 * Plugin defaults (mirrored by the entry Config schema and the client settings page).
 * - enabled: false ships no CSS at all (the page keeps the core font).
 * - monoFont / cjkFont: comma-separated @font-face local() candidates, first hit wins.
 *   The mono slot carries the Nerd Font glyphs; the CJK slot carries the CJK face.
 * - monoSizeAdjust / cjkSizeAdjust: percentages that normalize the font advance to the
 *   Consolas 13px cell (see the header). 88.6781 / 109.9609 are the values computed above
 *   for 0xProto Nerd Font Mono and Sarasa Term SC Nerd.
 */
const DEFAULTS = {
  enabled: true,
  monoFont: '0xProto Nerd Font Mono, 0xProto Nerd Font',
  cjkFont: 'Sarasa Term SC Nerd',
  monoSizeAdjust: 88.6781,
  cjkSizeAdjust: 109.9609,
}

/** size-adjust bounds (a typo of 1000 would render the terminal unreadable). */
const SIZE_ADJUST_MIN = 10
const SIZE_ADJUST_MAX = 400

/** Marker the injected stylesheet starts with; the client tab greps for it. */
const STYLE_MARKER = '/* dsh-terminal-font */'

/** Injected family names (deliberately not a system font name, so nothing else matches). */
const MONO_FAMILY = 'DSH Terminal Mono'
const CJK_FAMILY = 'DSH Terminal CJK'

/** Fonts tried after the injected families when they are missing. */
const TAIL_STACK = 'Consolas, monospace'

/** DOM hosts the core terminal renders text into (DomRenderer output). */
const TARGET_SELECTORS = '.xterm-rows, .xterm .composition-view'

/** Core terminal font-size and Consolas advance — the cell width the CSS must preserve. */
const TERMINAL_FONT_SIZE_PX = 13
const CONSOLAS_ADVANCE_EM = 1126 / 2048

/** The cell width every metric below is aimed at (7.1474609375px at 13px). */
const TARGET_CELL_WIDTH_PX = TERMINAL_FONT_SIZE_PX * CONSOLAS_ADVANCE_EM

// --- pure helpers (unit-tested without a browser) ------------------------------

/** 把任意输入夹到 [min, max]；非数字回落 fallback（保留小数，size-adjust 需要）。 */
function clampNumber(value, min, max, fallback) {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  if (n < min) return min
  if (n > max) return max
  return n
}

/**
 * 清洗单个字体名：去掉控制字符、引号、反斜杠与结构性字符（, ; { } ( )），
 * 折叠空白。清洗后为空则调用方丢弃该候选。
 */
function sanitizeFontName(raw) {
  if (typeof raw !== 'string') return ''
  return raw
    .replace(/[\u0000-\u001f\u007f]/g, ' ')
    .replace(/["'\\;{}()]/g, '')
    .trim()
    .replace(/\s+/g, ' ')
}

/**
 * 解析逗号分隔的字体族候选串为去重后的名字数组。
 * - 参数类型：value -- unknown（配置里的字符串）。
 * - 返回值：string[] —— 可能为空（调用方据此跳过该 @font-face）。
 * - 调用样例：parseFontStack('0xProto Nerd Font Mono, 0xProto Nerd Font')
 */
function parseFontStack(value) {
  if (typeof value !== 'string') return []
  const names = []
  for (const raw of value.split(',')) {
    const cleaned = sanitizeFontName(raw)
    if (cleaned && names.indexOf(cleaned) < 0) names.push(cleaned)
  }
  return names
}

/** 百分比输出：最多 4 位小数，去掉浮点噪声（88.6781 -> "88.6781"）。 */
function formatPercent(value) {
  return String(Math.round(value * 10000) / 10000)
}

/** 生成一条 @font-face：local() 候选列表 + size-adjust + font-display:swap。 */
function fontFaceRule(family, names, sizeAdjust) {
  const sources = names.map((n) => 'local("' + n + '")').join(', ')
  return '@font-face{font-family:"' + family + '";src:' + sources + ';size-adjust:' + formatPercent(sizeAdjust) + '%;font-display:swap}'
}

/**
 * 归一化 Loader 行 / 设置页传入的配置（补默认、夹边界、丢非法类型）。
 * - 参数类型：input -- unknown。
 * - 返回值：object —— 五个归一键。
 * - 调用样例：const resolved = normalizeEntryConfig({ monoSizeAdjust: 90 })
 */
function normalizeEntryConfig(input) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  return {
    enabled: source.enabled !== false,
    monoFont: typeof source.monoFont === 'string' ? source.monoFont : DEFAULTS.monoFont,
    cjkFont: typeof source.cjkFont === 'string' ? source.cjkFont : DEFAULTS.cjkFont,
    monoSizeAdjust: clampNumber(source.monoSizeAdjust, SIZE_ADJUST_MIN, SIZE_ADJUST_MAX, DEFAULTS.monoSizeAdjust),
    cjkSizeAdjust: clampNumber(source.cjkSizeAdjust, SIZE_ADJUST_MIN, SIZE_ADJUST_MAX, DEFAULTS.cjkSizeAdjust),
  }
}

/**
 * 生成注入用的整段 CSS：marker + 两个 @font-face + 一条作用在终端文本宿主的规则。
 * - 参数类型：input -- unknown（原始配置）。
 * - 返回值：string —— 空串表示禁用或没有可用字体名（调用方不注册监听器）。
 * - 调用样例：const css = buildCss(DEFAULTS)
 */
function buildCss(input) {
  const config = normalizeEntryConfig(input)
  if (!config.enabled) return ''
  const mono = parseFontStack(config.monoFont)
  const cjk = parseFontStack(config.cjkFont)
  if (!mono.length && !cjk.length) return ''
  const lines = [STYLE_MARKER]
  if (mono.length) lines.push(fontFaceRule(MONO_FAMILY, mono, config.monoSizeAdjust))
  if (cjk.length) lines.push(fontFaceRule(CJK_FAMILY, cjk, config.cjkSizeAdjust))
  const stack = []
  if (mono.length) stack.push('"' + MONO_FAMILY + '"')
  if (cjk.length) stack.push('"' + CJK_FAMILY + '"')
  stack.push(TAIL_STACK)
  lines.push(TARGET_SELECTORS + '{font-family:' + stack.join(', ') + ' !important}')
  return lines.join('\n') + '\n'
}

/**
 * 把一段 CSS 追加进 index 注入表（同一段只出现一次：web 每次请求都会重新 collect）。
 * - 参数类型：table -- 核心传进来的行数组；css -- 字符串。
 * - 返回值：boolean —— 是否真的写入了行。
 * - 调用样例：pushStyleRow(table, buildCss(DEFAULTS))
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
 * - 参数类型：ctx -- Context；config -- Loader 行配置（可选）。
 * - 返回值：function —— 取消监听的 disposer（随插件卸载执行）；禁用时为 undefined。
 * - 调用样例：由 cordis Loader 按 apply/inject/name 约定调用。
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

// --- 0.2.0 entry config（设置页命名空间）---------------------------------------

/**
 * 0.2.0 把「插件行配置」投影成设置分页：settings 服务读 entry 导出的 Config，再在
 * ENTRY ID（本插件 = terminal-font）下读写，向别的 ns 写入直接抛
 * `No configurable plugin entry "<ns>"`。`link:` 形态的宿主半无法 import
 * @deepseek-ai/schemastery（ERR_MODULE_NOT_FOUND），所以这里手写 schema，需要满足三个消费者：
 *   - cordis resolveConfig → Config[~standard].validate(raw)；
 *   - settings 服务 → meta.volatile（volatileForm）+ toJSON()：它用
 *     `new z(schema.toJSON())` 重建真 schemastery（dsh-settings lib/types/schema.js plainSchema），
 *     所以这张 refs 表必须与真实输出同形；
 *   - loader diff → ~standard.vendor：故意不写 'schemastery'，让配置写入走普通
 *     entry restart（apply(ctx, config) 拿到新值），而不是我们表达不了的 in-place commit。
 * 下表由等价的 schemastery schema（z.object({...}).volatile().toJSON()）生成并回灌验证过。
 */
const CONFIG_SCHEMA_JSON = Object.freeze({"uid":11,"refs":{"1":{"type":"boolean","meta":{"default":true}},"3":{"type":"string","meta":{"default":"0xProto Nerd Font Mono, 0xProto Nerd Font"}},"5":{"type":"string","meta":{"default":"Sarasa Term SC Nerd"}},"7":{"type":"number","meta":{"default":88.6781}},"9":{"type":"number","meta":{"default":109.9609}},"11":{"type":"object","meta":{"default":{},"volatile":true},"dict":{"enabled":1,"monoFont":3,"cjkFont":5,"monoSizeAdjust":7,"cjkSizeAdjust":9}}}})

/** 导出给 Loader / 设置服务的 Config schema（见上方说明）。 */
function entryConfigSchema() {
  const schema = (input) => normalizeEntryConfig(input)
  schema.meta = { volatile: true }
  schema.type = 'object'
  schema.toJSON = () => JSON.parse(JSON.stringify(CONFIG_SCHEMA_JSON))
  schema['~standard'] = {
    version: 1,
    vendor: 'dsh-terminal-font',
    validate(value) {
      try { return { value: normalizeEntryConfig(value) } }
      catch (error) { return { issues: [{ message: error && error.message ? error.message : String(error) }] } }
    },
  }
  return schema
}

/** 0.2.0 行配置 schema（测试断言其形状与 vendor）。 */
export const Config = entryConfigSchema()

export {
  name,
  inject,
  apply,
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
}
