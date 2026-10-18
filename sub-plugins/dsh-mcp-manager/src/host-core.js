/**
 * dsh-mcp-manager · src/host-core.js
 * 纯逻辑宿主核：把 patch 文本算成「新文本 / 写入计划」。不碰文件系统、零第三方依赖、不做整文件 YAML 重写。
 *
 * ── 补丁层序结论（本模块落点算法的存在理由）─────────────────────────────
 * 实测（脚本 `tmp/probe-patch-order.mjs`，用的是核心真实实现
 * `vendor/include/lib/index.js` 的 `applyEntryPatches`，与启动 / `dsh --dump-config` 同一代码路径；
 * 结论同时记在 `docs/knowledge/2026-10-18-mcp-manager-subplugin.md`）：
 *
 *   | 补丁顺序 | 结果 |
 *   |---|---|
 *   | profile 层 `{id, disabled:true}` → home 层 `{insert:[{id,…}]}`（**核心的真实顺序**） | `[warn] patch: entry <id> not found`，覆盖被跳过，条目最终**启用** |
 *   | home 层 insert → profile 层 override（反序） | `disabled: true` 生效 |
 *   | 同一层内 insert → override（现状 `mcp-Serena` 的形态） | `disabled: true` 生效 |
 *
 * 即：loader 的层序是 bundle → profile → home → CLI overlay，而 `{id,…}` 覆盖补丁**只能命中当时已存在的条目**。
 * 所以「在未选中的 profile 写一条 disable 覆盖行」**无效**；一台服务器的定义必须写到**能决定它生效范围的那一层**：
 *
 *   - 全员生效（`S == P`）→ home 层一条 insert，不带 `disabled`；
 *   - 部分生效（`∅ ≠ S ⊊ P`）→ 写进每个被选中的 profile，home 与其它 profile 不留该 id；
 *   - 全不生效（`S == ∅`）→ home 层保留一条，且该 insert 行内部带 `disabled: true`。
 *
 * ── 所有权与保真 ────────────────────────────────────────────────────────
 * 只改「带 `# dsh-mcp-manager:2:` 标记的行块」以及用户显式纳入迁移的形态匹配行块；其它行、注释、空行、
 * `!!js` 表达式、行尾风格（CRLF/LF）逐字不动。所有 `plan*` 都是纯函数：输入文本 → 输出新文本（或计划），
 * 落盘（原子写 / 备份 / 串行化）由宿主半 `src/index.js` 负责。
 */

// ═══════════════════════════ 常量 ═══════════════════════════

/** MCP 条目在 loader 里的包名（形态匹配用）。 */
export const MCP_PACKAGE_NAME = '@deepseek-ai/dsh-mcp-client'

/** 标记版本号。旧版本：`# dsh-mcp-manager:<kind>:<id>`；本版本：`# dsh-mcp-manager:2:<kind>:<id>`。 */
export const MARKER_VERSION = 2

/** 行块标记构造器（返回不带行尾的一行文本）。 */
export const MARK = Object.freeze({
  server: (id) => `# dsh-mcp-manager:2:server:${id}`,
  disable: (id) => `# dsh-mcp-manager:2:disable:${id}`,
})

/** `@deepseek-ai/dsh-mcp-client` 的 `serverName` 约束（`packages/mcp/mcp-client/src/index.ts` L40）。 */
export const SERVER_NAME_PATTERN = /^[A-Za-z0-9_-]{1,32}$/

/** profile 目录名约束（`$DSH_HOME/profiles/<name>`）。 */
export const PROFILE_NAME_PATTERN = /^[A-Za-z0-9._-]{1,64}$/

/** 条目 id 约束：要能安全地写进标记行与 `- id:` 行。 */
export const MCP_ID_PATTERN = /^[A-Za-z0-9._-]{1,64}$/

/** 合法的 `transport`（核心的 Config 是 `stdio | streamable-http` 联合，其它值会被 zod 判非法）。 */
export const TRANSPORTS = Object.freeze(['stdio', 'streamable-http'])

/** `listProfiles` 排除的目录名。 */
export const EXCLUDED_PROFILE_DIRS = Object.freeze(['node_modules'])

/** 全局默认参数的内置值（与 `state.json` 的缺省回退一致）。 */
export const DEFAULT_PARAMS = Object.freeze({
  toolCallTimeoutMs: 60000,
  failOnStartupError: false,
  maxInstructionBytes: 32768,
  probeTimeoutMs: 8000,
  defaultTransport: 'stdio',
})

/** `state.json` 的结构版本号。 */
export const STATE_VERSION = 2

/** config 段内字段的规范顺序（新建 / 补字段时的落位依据）。 */
const CONFIG_FIELD_ORDER = [
  'serverName', 'transport',
  'command', 'args', 'env', 'cwd',
  'url', 'headers',
  'toolCallTimeoutMs', 'maxInstructionBytes', 'failOnStartupError',
]

/** config 段里按「容器」成块渲染的字段。 */
const CONTAINER_FIELDS = Object.freeze({ args: 'list', env: 'map', headers: 'map' })

/** 顶层条目缩进（与 `$DSH_HOME/cordis.patch.yml` 现有条目逐字对齐）。 */
const IND_HEAD = 0
const IND_ITEM = 4
const IND_ITEM_KEY = 6
const IND_CONFIG = 6
const IND_CONFIG_KEY = 8
const IND_CONTAINER_ITEM = 10
const IND_OVERRIDE_KEY = 2

// ═══════════════════════════ 文本 / 行工具 ═══════════════════════════

const EOL_TAIL = /(\r\n|\n|\r)$/

/** 取一行（可含行尾）的行尾串；无行尾返回 `''`。 */
function eolOfRaw(raw) {
  const m = EOL_TAIL.exec(raw)
  return m ? m[1] : ''
}

/** 去掉行尾，得到行内容。 */
function bareOf(raw) {
  return String(raw).replace(EOL_TAIL, '')
}

/**
 * 判定文本的行尾风格：CRLF 占多数（且至少一条）→ `'\r\n'`，否则 `'\n'`。
 * 纯 LF 文件恒为 `'\n'`；无行尾信息时回退 `'\n'`。
 */
export function detectEol(text) {
  const s = String(text ?? '')
  let crlf = 0
  let lf = 0
  for (let i = 0; i < s.length; i++) {
    if (s[i] === '\n') {
      if (i > 0 && s[i - 1] === '\r') crlf++
      else lf++
    }
  }
  return crlf > 0 && crlf >= lf ? '\r\n' : '\n'
}

/**
 * 按行切分并**保留每行的行尾**（`'a\nb'` → `['a\n', 'b']`）；空串 → `[]`。
 * 手工切分而不是 `split(/\r?\n/)`，因为后者既丢行尾也无法区分孤立的 `\r`。
 */
export function splitKeepEol(text) {
  const s = String(text ?? '')
  const out = []
  let i = 0
  while (i < s.length) {
    let j = i
    while (j < s.length && s[j] !== '\n' && s[j] !== '\r') j++
    let end = j
    if (j < s.length) end = s[j] === '\r' && s[j + 1] === '\n' ? j + 2 : j + 1
    out.push(s.slice(i, end))
    i = end
  }
  return out
}

/** 行内容的前导空白长度。 */
function indentOf(bare) {
  const m = /^[ \t]*/.exec(bare)
  return m ? m[0].length : 0
}

/** 缩进里出现 Tab → 解析拒绝（我们按空格数做层级判定，Tab 会让层级不可判定）。 */
function hasTabIndent(bare) {
  return /^[ \t]*\t/.test(bare)
}

/** 顶层条目起始行：`- ` 或裸 `-`。`---` 不算（YAML 文档分隔符当作不透明行）。 */
function isEntryHead(bare) {
  const t = bare.trim()
  return t === '-' || /^-\s/.test(t)
}

// ═══════════════════════════ 标量渲染 / 解析 ═══════════════════════════

/** YAML 标量渲染：字符串走 JSON 双引号（转义反斜杠，Windows 路径安全），其它走 `String()`。 */
function yq(v) {
  return typeof v === 'string' ? JSON.stringify(v) : String(v)
}

/** 键名渲染：安全字符集内原样，否则加双引号。 */
function yplain(v) {
  const s = String(v)
  return /^[A-Za-z0-9_.:@%+=/-]+$/.test(s) ? s : JSON.stringify(s)
}

/** 去引号 / 还原标量：双引号→`JSON.parse`（失败则剥引号）；单引号→剥引号并把 `''`→`'`；`[a,b]`→数组；布尔 / 整数。 */
function unquote(v) {
  if (v === undefined || v === null) return v
  const s = String(v).trim()
  if (s.length >= 2 && s[0] === '"' && s[s.length - 1] === '"') {
    try {
      return JSON.parse(s)
    } catch {
      return s.slice(1, -1)
    }
  }
  if (s.length >= 2 && s[0] === "'" && s[s.length - 1] === "'") {
    return s.slice(1, -1).replace(/''/g, "'")
  }
  if (s.length >= 2 && s[0] === '[' && s[s.length - 1] === ']') {
    return s
      .slice(1, -1)
      .split(',')
      .map((x) => unquote(x.trim()))
      .filter((x) => x !== '')
  }
  if (s === 'true') return true
  if (s === 'false') return false
  if (/^-?\d+$/.test(s)) return Number(s)
  return s
}

/**
 * `key: value` 切分。比旧项目的正则多一层守卫：整行以引号开头时，只有在引号**闭合后紧跟冒号**
 * 才当键，否则视为标量（旧正则会把 `"a:b"` 切成 `key='"a'`）。
 */
function splitKV(text) {
  const t = String(text)
  const quoted = /^("(?:\\.|[^"\\])*"|'(?:[^']|'')*')\s*:\s*([\s\S]*)$/.exec(t)
  if (quoted) return { key: unquote(quoted[1]), value: quoted[2] }
  if (/^["']/.test(t.trim())) return null
  const m = /^([^:]+?)\s*:\s*([\s\S]*)$/.exec(t)
  if (!m) return null
  return { key: unquote(m[1].trim()), value: m[2] }
}

function isPlainObject(v) {
  return !!v && typeof v === 'object' && !Array.isArray(v)
}

function deepEqual(a, b) {
  if (a === b) return true
  if (Array.isArray(a) && Array.isArray(b)) {
    return a.length === b.length && a.every((x, i) => deepEqual(x, b[i]))
  }
  if (isPlainObject(a) && isPlainObject(b)) {
    const ka = Object.keys(a)
    const kb = Object.keys(b)
    return ka.length === kb.length && ka.every((k) => Object.prototype.hasOwnProperty.call(b, k) && deepEqual(a[k], b[k]))
  }
  return false
}

// ═══════════════════════════ 路径 / 状态 ═══════════════════════════

/**
 * 从目录名列表里挑出 profile 名：排除 `node_modules`、点开头、不匹配 `PROFILE_NAME_PATTERN` 的项，
 * 去重后按字母序排序（保证写入顺序稳定）。入参可以是字符串数组，也可以是 `{ name }` 数组。
 */
export function listProfiles(dirNames) {
  const out = []
  const src = Array.isArray(dirNames) ? dirNames : []
  for (const raw of src) {
    const name = typeof raw === 'string' ? raw : raw && typeof raw === 'object' ? raw.name : null
    if (typeof name !== 'string' || name === '') continue
    if (EXCLUDED_PROFILE_DIRS.includes(name)) continue
    if (name.startsWith('.')) continue
    if (!PROFILE_NAME_PATTERN.test(name)) continue
    if (!out.includes(name)) out.push(name)
  }
  return out.sort()
}

/** 取路径分隔符：`home` 里出现 `\` 就用 `\`，否则用 `/`（不猜平台，跟着入参走）。 */
function sepOf(p) {
  return String(p).includes('\\') ? '\\' : '/'
}

/** `$DSH_HOME/profiles/<profile>/cordis.patch.yml`。 */
export function profilePatchPath(home, profile) {
  const base = String(home ?? '').replace(/[\\/]+$/, '')
  return [base, 'profiles', String(profile), 'cordis.patch.yml'].join(sepOf(home))
}

/** `$DSH_HOME/.dsh-mcp-manager/state.json`。 */
export function statePath(home) {
  const base = String(home ?? '').replace(/[\\/]+$/, '')
  return [base, '.dsh-mcp-manager', 'state.json'].join(sepOf(home))
}

/**
 * `state.json` 的内置默认值。`knownProfiles` 是「上次确认矩阵时的 profile 集合」，
 * `mergeServers` 用它把「部分生效的服务器遇上新 profile」判成「布局待确认」。
 */
export function defaultState() {
  return {
    version: STATE_VERSION,
    defaults: { ...DEFAULT_PARAMS },
    panel: { locale: 'auto', tab: null, expandedId: null },
    migration: { done: false, at: null, from: null },
    knownProfiles: [],
    diagnostics: { lastError: null, lastWriteAt: null },
  }
}

// ═══════════════════════════ 行块生成 ═══════════════════════════

/**
 * 生成 `- insert:` 行块（缩进与 `$DSH_HOME/cordis.patch.yml` 现有条目逐字对齐，移植自旧项目
 * `DeepSeekHarness-MCP-Manager/src/index.ts:386-420`，标记换 `:2:`）。
 *
 * @param {string} id 条目 id
 * @param {object} config `@deepseek-ai/dsh-mcp-client` 的 Config（`serverName`/`transport`/…）
 * @param {string} [eol] 行尾，缺省 `'\n'`
 * @param {{disabled?: boolean}} [opts] `disabled: true` → 在 insert 条目内部追加 `disabled: true`（全不生效形态）
 * @returns {string} 带行尾的多行文本（末尾行含行尾）
 */
export function buildInsertBlock(id, config, eol, opts) {
  const cfg = isPlainObject(config) ? config : {}
  const nl = typeof eol === 'string' && eol ? eol : '\n'
  const disabled = opts && opts.disabled !== undefined ? opts.disabled === true : cfg.disabled === true
  const transport = typeof cfg.transport === 'string' ? cfg.transport : 'stdio'
  const lines = []
  lines.push(MARK.server(id))
  lines.push('- insert:')
  lines.push(`${' '.repeat(IND_ITEM)}- id: ${yplain(id)}`)
  lines.push(`${' '.repeat(IND_ITEM_KEY)}name: '${MCP_PACKAGE_NAME}'`)
  if (disabled) lines.push(`${' '.repeat(IND_ITEM_KEY)}disabled: true`)
  lines.push(`${' '.repeat(IND_CONFIG)}config:`)
  const k = (key) => `${' '.repeat(IND_CONFIG_KEY)}${key}: `
  if (cfg.serverName !== undefined) lines.push(k('serverName') + yq(cfg.serverName))
  lines.push(k('transport') + yq(transport))
  if (transport === 'stdio') {
    if (cfg.command !== undefined) lines.push(k('command') + yq(cfg.command))
    if (Array.isArray(cfg.args) && cfg.args.length) {
      lines.push(`${' '.repeat(IND_CONFIG_KEY)}args:`)
      for (const a of cfg.args) lines.push(`${' '.repeat(IND_CONTAINER_ITEM)}- ${yq(a)}`)
    }
    if (isPlainObject(cfg.env) && Object.keys(cfg.env).length) {
      lines.push(`${' '.repeat(IND_CONFIG_KEY)}env:`)
      for (const [ek, ev] of Object.entries(cfg.env)) {
        lines.push(`${' '.repeat(IND_CONTAINER_ITEM)}${yplain(ek)}: ${yq(ev)}`)
      }
    }
    if (cfg.cwd !== undefined && cfg.cwd !== '') lines.push(k('cwd') + yq(cfg.cwd))
  } else {
    if (cfg.url !== undefined) lines.push(k('url') + yq(cfg.url))
    if (isPlainObject(cfg.headers) && Object.keys(cfg.headers).length) {
      lines.push(`${' '.repeat(IND_CONFIG_KEY)}headers:`)
      for (const [hk, hv] of Object.entries(cfg.headers)) {
        lines.push(`${' '.repeat(IND_CONTAINER_ITEM)}${yplain(hk)}: ${yq(hv)}`)
      }
    }
  }
  for (const key of ['toolCallTimeoutMs', 'maxInstructionBytes', 'failOnStartupError']) {
    if (cfg[key] !== undefined && cfg[key] !== null) lines.push(k(key) + yq(cfg[key]))
  }
  return lines.map((l) => l + nl).join('')
}

/**
 * 生成 `- id:` 覆盖行块（旧形态；新版本落点算法已不再需要它，仅在兼容 / 测试与 `locateDisableBlock`
 * 配对时使用）。移植自旧项目 `src/index.ts:422-429`。
 *
 * @param {string} id 目标条目 id
 * @param {string} [eol] 行尾，缺省 `'\n'`
 * @param {{disabled?: boolean}} [opts] `disabled: false` → 生成 `enable` 标记 + `disabled: false`
 * @returns {string}
 */
export function buildDisableBlock(id, eol, opts) {
  const nl = typeof eol === 'string' && eol ? eol : '\n'
  const disabled = opts && opts.disabled !== undefined ? opts.disabled === true : true
  const marker = disabled ? MARK.disable(id) : `# dsh-mcp-manager:2:enable:${id}`
  return [
    marker,
    `- id: ${yplain(id)}`,
    `${' '.repeat(IND_OVERRIDE_KEY)}name: '${MCP_PACKAGE_NAME}'`,
    `${' '.repeat(IND_OVERRIDE_KEY)}disabled: ${disabled ? 'true' : 'false'}`,
  ]
    .map((l) => l + nl)
    .join('')
}

// ═══════════════════════════ 行解析 ═══════════════════════════

const MARKER_RE = /^#\s*dsh-mcp-manager:(?:(\d+):)?(server|disable|enable):([A-Za-z0-9._-]{1,64})\s*$/

/** 解析标记行：v1（无版本段）与 v2 都认，返回 `{ version, kind, id }`；不是标记行返回 `null`。 */
function matchMarker(bare) {
  const m = MARKER_RE.exec(String(bare).trim())
  if (!m) return null
  return { version: m[1] ? Number(m[1]) : 1, kind: m[2], id: m[3] }
}

/** 下一个「内容行」（跳过空行）的下标；没有返回 `null`。 */
function nextContent(lines, from, to) {
  for (let i = from; i < to; i++) {
    if (bareOf(lines[i]).trim() !== '') return i
  }
  return null
}

/** 从 `from` 起，跳过「缩进 > indent 或空行」的续行，返回第一个兄弟行下标（`<= indent` 或末尾）。 */
function childEnd(lines, from, to, indent) {
  let j = from
  while (j < to) {
    const bare = bareOf(lines[j])
    if (bare.trim() === '') {
      j++
      continue
    }
    if (indentOf(bare) <= indent) break
    j++
  }
  return j
}

/**
 * 收集 `[from,to)` 内缩进恰为 `indent` 的「映射子项」。序列项行（`- key: v`）会被剥掉 `- ` 后当子项，
 * 其续行（更深缩进）并入该项的 `[start,end)`。
 */
function mapChildren(lines, from, to, indent) {
  const out = []
  let i = from
  while (i < to) {
    const bare = bareOf(lines[i])
    const t = bare.trim()
    if (t === '') {
      i++
      continue
    }
    const ind = indentOf(bare)
    if (ind < indent) break
    if (ind > indent) {
      i++
      continue
    }
    if (t.startsWith('#')) {
      i++
      continue
    }
    const body = t === '-' ? '' : t.replace(/^-\s/, '')
    const kv = body === '' ? null : splitKV(body)
    const end = childEnd(lines, i + 1, to, ind)
    if (kv) out.push({ key: kv.key, valueText: kv.value.trim(), lineIndex: i, start: i, end, indent: ind })
    else if (body !== '') out.push({ key: null, valueText: '', raw: body, lineIndex: i, start: i, end, indent: ind })
    i = end > i ? end : i + 1
  }
  return out
}

/** 序列项（`- key: v`）内部的键缩进：取第一条续行的缩进；没有续行则 `indent + 2`。 */
function itemKeyIndentOf(lines, child) {
  const nx = nextContent(lines, child.start + 1, child.end)
  if (nx === null) return child.indent + 2
  return indentOf(bareOf(lines[nx]))
}

/** 块级扫描：把整个文档切成「标记块 / 条目块 / 其它行」的线性视图（不改内容，只记范围）。 */
function scanBlocks(lines) {
  const blocks = []
  let i = 0
  while (i < lines.length) {
    const bare = bareOf(lines[i])
    const t = bare.trim()
    const ind = indentOf(bare)
    if (ind === 0 && t !== '' && (t.startsWith('#') || isEntryHead(bare))) {
      const marker = matchMarker(bare)
      let bodyStart = -1
      if (isEntryHead(bare)) bodyStart = i
      else if (marker) {
        // 标记行 + 紧跟的顶层条目 = 一个行块（普通注释不并入，避免误删别人的注释）
        const nx = nextContent(lines, i + 1, lines.length)
        if (nx !== null && indentOf(bareOf(lines[nx])) === 0 && isEntryHead(bareOf(lines[nx]))) bodyStart = nx
      }
      let j = i + 1
      if (bodyStart >= 0) {
        j = bodyStart + 1
        while (j < lines.length) {
          // 顶格（缩进 0）的任意行都结束本块 —— 空行也是块间分隔，不属于块体
          if (indentOf(bareOf(lines[j])) === 0) break
          j++
        }
      }
      blocks.push({
        kind: marker ? 'marker' : isEntryHead(bare) ? 'entry' : 'comment',
        start: i,
        end: j,
        marker,
        comment: marker ? null : t,
      })
      i = j
      continue
    }
    let j = i + 1
    while (j < lines.length) {
      const bj = bareOf(lines[j])
      const tj = bj.trim()
      if (indentOf(bj) === 0 && tj !== '' && (tj.startsWith('#') || isEntryHead(bj))) break
      j++
    }
    blocks.push({ kind: 'free', start: i, end: j, marker: null, comment: null })
    i = j
  }
  return blocks
}

/** 块的「条目头」行下标（跳过标记行与空行）；没有条目行返回 `null`。 */
function entryHeadOf(lines, chunk) {
  for (let k = chunk.start; k < chunk.end; k++) {
    const bare = bareOf(lines[k])
    if (indentOf(bare) === 0 && isEntryHead(bare)) return k
  }
  return null
}

/** 解析一个 `- insert:` 块体 → 条目结构；不是 insert 形态返回 `null`。 */
function parseInsertBody(lines, headIndex, to) {
  const head = bareOf(lines[headIndex]).trim().replace(/^-\s/, '')
  const headKv = splitKV(head)
  if (!headKv || headKv.key !== 'insert') return null
  if (headKv.value !== '') {
    return { flowStyle: true, id: null, config: {}, fields: {}, configFields: {} }
  }
  const firstNested = nextContent(lines, headIndex + 1, to)
  const itemIndent = firstNested === null ? IND_ITEM : indentOf(bareOf(lines[firstNested]))
  const items = mapChildren(lines, headIndex + 1, to, itemIndent)
  const item = items[0] || null
  if (!item) return { flowStyle: false, empty: true, id: null, config: {}, fields: {}, configFields: {} }
  const itemHead = splitKV(bareOf(lines[item.start]).trim().replace(/^-\s/, ''))
  const keyIndent = itemKeyIndentOf(lines, item)
  const fields = mapChildren(lines, item.start + 1, item.end, keyIndent)
  const byKey = {}
  for (const f of fields) byKey[f.key] = f
  const itemLineKv = itemHead && itemHead.key ? { key: itemHead.key, valueText: itemHead.value.trim(), lineIndex: item.start, indent: item.indent } : null
  if (itemLineKv && !byKey[itemLineKv.key === 'id' ? 'id' : itemLineKv.key]) {
    if (itemLineKv.key === 'id') byKey.id = itemLineKv
  }
  const configField = byKey.config
  const configFields = {}
  let configChildIndent = IND_CONFIG_KEY
  if (configField) {
    const nx = nextContent(lines, configField.start + 1, configField.end)
    configChildIndent = nx === null ? configField.indent + 2 : indentOf(bareOf(lines[nx]))
    for (const f of mapChildren(lines, configField.start + 1, configField.end, configChildIndent)) {
      configFields[f.key] = f
    }
  }
  const config = {}
  for (const [key, f] of Object.entries(configFields)) {
    config[key] = readConfigFieldValue(lines, key, f, configChildIndent)
  }
  return {
    flowStyle: false,
    empty: false,
    id: byKey.id ? String(unquote(byKey.id.valueText)) : null,
    idField: byKey.id || null,
    name: byKey.name ? String(unquote(byKey.name.valueText)) : null,
    disabledField: byKey.disabled || null,
    disabledValue: byKey.disabled ? unquote(byKey.disabled.valueText) === true : false,
    configField: configField || null,
    config,
    configFields,
    configChildIndent,
    fields: byKey,
    itemStart: item.start,
    itemEnd: item.end,
    itemKeyIndent: keyIndent,
  }
}

/** 读一个 config 子字段的值（标量 / `args` 列表 / `env`·`headers` 映射）。 */
function readConfigFieldValue(lines, key, f, childIndent) {
  const kind = CONTAINER_FIELDS[key]
  const inner = (() => {
    const nx = nextContent(lines, f.start + 1, f.end)
    return nx === null ? childIndent + 2 : indentOf(bareOf(lines[nx]))
  })()
  if (kind === 'list') {
    const out = []
    for (const c of mapChildren(lines, f.start + 1, f.end, inner)) {
      if (c.key === null) out.push(String(unquote(c.raw)))
      else out.push(String(unquote(c.valueText)))
    }
    const inline = f.valueText
    if (out.length === 0 && inline !== '') {
      const v = unquote(inline)
      return Array.isArray(v) ? v : [String(v)]
    }
    return out
  }
  if (kind === 'map') {
    const out = {}
    for (const c of mapChildren(lines, f.start + 1, f.end, inner)) {
      if (c.key === null) continue
      out[String(c.key)] = String(unquote(c.valueText))
    }
    return out
  }
  return unquote(f.valueText)
}

/** 解析 `- id:` / 其它顶层映射条目 → `{ id, fields, disabled }`。 */
function parseOverrideBody(lines, headIndex, to) {
  const head = bareOf(lines[headIndex]).trim().replace(/^-\s/, '')
  const kv = splitKV(head)
  if (!kv) return null
  const keyIndentGuess = (() => {
    const nx = nextContent(lines, headIndex + 1, to)
    return nx === null ? IND_OVERRIDE_KEY : indentOf(bareOf(lines[nx]))
  })()
  const fields = {}
  for (const f of mapChildren(lines, headIndex + 1, to, keyIndentGuess)) fields[f.key] = f
  return {
    key: kv.key,
    value: unquote(kv.value),
    fields,
    disabled: fields.disabled ? unquote(fields.disabled.valueText) === true : undefined,
    name: fields.name ? String(unquote(fields.name.valueText)) : null,
  }
}

/**
 * 解析 patch 文本（纯行解析，容错；不依赖 YAML 库）。
 *
 * @param {string} text patch 文件全文
 * @returns {{
 *   ok: boolean,
 *   error: null | { code: string, message: string, line: number },
 *   entries: Array<object>,
 *   overrides: Array<object>,
 *   others: Array<object>,
 *   eol: string,
 *   lines: string[],
 *   raw: string
 * }}
 *   `entries` 是**受管的 MCP insert 条目**（`{ id, serverName, transport, hasMarker, markerKind,
 *   blockStart, blockEnd, disabled, … }`；同层 disable 覆盖行的效果已折算进 `disabled`）。
 */
export function parsePatch(text) {
  const raw = String(text ?? '')
  const lines = splitKeepEol(raw)
  const eol = detectEol(raw)
  const parseError = detectParseError(lines)
  const base = { ok: false, error: parseError, entries: [], overrides: [], others: [], eol, lines, raw }
  if (parseError) return base

  const scan = scanBlocks(lines)
  const entries = []
  const overrides = []
  const others = []

  for (const chunk of scan) {
    if (chunk.kind === 'free' || chunk.kind === 'comment') continue
    const headIndex = entryHeadOf(lines, chunk)
    if (headIndex === null) {
      if (chunk.marker) others.push({ kind: 'marker', marker: chunk.marker, blockStart: chunk.start, blockEnd: chunk.end })
      continue
    }
    const insert = parseInsertBody(lines, headIndex, chunk.end)
    if (insert && !insert.flowStyle) {
      const name = insert.name
      const isMcp = name === MCP_PACKAGE_NAME
      const entry = {
        id: insert.id,
        serverName: insert.config.serverName !== undefined ? String(insert.config.serverName) : null,
        transport: insert.config.transport !== undefined ? String(insert.config.transport) : null,
        hasMarker: !!chunk.marker,
        markerKind: chunk.marker ? chunk.marker.kind : null,
        markerVersion: chunk.marker ? chunk.marker.version : null,
        markerLine: chunk.marker ? chunk.start : null,
        blockStart: chunk.start,
        blockEnd: chunk.end,
        bodyStart: headIndex,
        disabled: insert.disabledValue === true,
        name,
        isMcp,
        config: insert.config,
        _insert: insert,
        _overrides: [],
      }
      if (isMcp && entry.id) entries.push(entry)
      else others.push({ kind: 'insert', id: entry.id, name, blockStart: chunk.start, blockEnd: chunk.end, reason: isMcp ? 'no-id' : 'not-mcp-package' })
      continue
    }
    const ov = parseOverrideBody(lines, headIndex, chunk.end)
    if (ov && ov.key === 'id') {
      const rec = {
        id: String(ov.value),
        disabled: ov.disabled,
        name: ov.name,
        hasMarker: !!chunk.marker,
        markerKind: chunk.marker ? chunk.marker.kind : null,
        markerVersion: chunk.marker ? chunk.marker.version : null,
        markerLine: chunk.marker ? chunk.start : null,
        blockStart: chunk.start,
        blockEnd: chunk.end,
        bodyStart: headIndex,
        fields: ov.fields,
      }
      overrides.push(rec)
      const owner = entries.find((e) => e.id === rec.id)
      if (owner && rec.disabled === true) {
        owner.disabled = true
        owner._overrides.push(rec)
      }
      continue
    }
    others.push({ kind: 'other', key: ov ? ov.key : null, blockStart: chunk.start, blockEnd: chunk.end, reason: 'not-managed-entry' })
  }

  for (const e of entries) e.sameLayerOverride = e._overrides[0] || null
  return { ...base, ok: true, entries, overrides, others }
}

/** 文档级结构错误 → `{ code, message, line }`；能安全改写才 `ok`。 */
function detectParseError(lines) {
  for (let i = 0; i < lines.length; i++) {
    const bare = bareOf(lines[i])
    if (hasTabIndent(bare)) {
      return { code: 'E_TAB_INDENT', message: `第 ${i + 1} 行用 Tab 缩进：无法判定层级，拒绝写入（请改成空格）`, line: i + 1 }
    }
  }
  for (let i = 0; i < lines.length; i++) {
    const bare = bareOf(lines[i])
    const t = bare.trim()
    if (indentOf(bare) !== 0 || t === '') continue
    if (t.startsWith('#') || isEntryHead(bare) || t.startsWith('---') || t.startsWith('%')) continue
    return { code: 'E_NOT_SEQUENCE', message: `第 ${i + 1} 行不是顶层数组条目（patch 必须是顶层 YAML 数组）：${t.slice(0, 60)}`, line: i + 1 }
  }
  for (let i = 0; i < lines.length; i++) {
    const bare = bareOf(lines[i])
    if (indentOf(bare) !== 0) continue
    const t = bare.trim()
    if (!/^-\s*insert\s*:/.test(t)) continue
    if (!/^-\s*insert\s*:\s*$/.test(t)) {
      return { code: 'E_FLOW_STYLE', message: `第 ${i + 1} 行是流式（flow）形式的 insert：无法安全做行级拼贴，拒绝写入`, line: i + 1 }
    }
  }
  for (const chunk of scanBlocks(lines)) {
    if (chunk.kind !== 'free') continue
    for (let i = chunk.start; i < chunk.end; i++) {
      const t = bareOf(lines[i]).trim()
      if (t === '' || /^(---|\.\.\.|%)/.test(t)) continue
      return { code: 'E_ORPHAN_INDENT', message: `第 ${i + 1} 行是孤立缩进行（不属于任何顶层条目）：无法安全做行级拼贴，拒绝写入`, line: i + 1 }
    }
  }
  return null
}

/**
 * 定位某 id 的 `- insert:` 行块（含紧邻标记行）。
 *
 * @param {string[]} lines `splitKeepEol` 的结果（可含行尾）
 * @param {string} id 条目 id
 * @param {{includeUnmarked?: boolean}} [opts] 缺省 `true`（定位器本身不限所有权；`plan*` 自行决定）
 * @returns {null | { start: number, end: number, hasMarker: boolean, markerKind: string|null, entry: object|null }}
 */
export function locateServerBlock(lines, id, opts) {
  const includeUnmarked = !opts || opts.includeUnmarked !== false
  const arr = Array.isArray(lines) ? lines : splitKeepEol(lines)
  const scan = scanBlocks(arr)
  let fallback = null
  for (const chunk of scan) {
    const headIndex = entryHeadOf(arr, chunk)
    if (headIndex === null) continue
    const insert = parseInsertBody(arr, headIndex, chunk.end)
    if (!insert || insert.flowStyle) continue
    const blockId = insert.id
    const isMcp = insert.name === MCP_PACKAGE_NAME
    if (String(blockId) !== String(id)) continue
    const hit = {
      start: chunk.start,
      end: chunk.end,
      bodyStart: headIndex,
      hasMarker: !!chunk.marker,
      markerKind: chunk.marker ? chunk.marker.kind : null,
      markerVersion: chunk.marker ? chunk.marker.version : null,
      markerLine: chunk.marker ? chunk.start : null,
      isMcp,
    }
    if (chunk.marker && chunk.marker.kind === 'server' && chunk.marker.version >= MARKER_VERSION) return hit
    if (chunk.marker && chunk.marker.kind === 'server') {
      if (!fallback) fallback = hit
      continue
    }
    if (!includeUnmarked) continue
    if (isMcp && !fallback) fallback = hit
  }
  return fallback
}

/**
 * 定位某 id 的 `- id:` 覆盖行块（旧形态 disable/enable 行）。
 *
 * @param {string[]} lines `splitKeepEol` 的结果
 * @param {string} id 目标条目 id
 * @param {{includeUnmarked?: boolean}} [opts] 缺省 `false`：只认带标记的覆盖行（标记即所有权）
 * @returns {null | { start: number, end: number, disabled: boolean|null, hasMarker: boolean, markerKind: string|null }}
 */
export function locateDisableBlock(lines, id, opts) {
  const includeUnmarked = !!(opts && opts.includeUnmarked)
  const arr = Array.isArray(lines) ? lines : splitKeepEol(lines)
  const scan = scanBlocks(arr)
  for (const chunk of scan) {
    const headIndex = entryHeadOf(arr, chunk)
    if (headIndex === null) continue
    const ov = parseOverrideBody(arr, headIndex, chunk.end)
    if (!ov || ov.key !== 'id' || String(ov.value) !== String(id)) continue
    if (ov.disabled === undefined) continue
    const marked = !!(chunk.marker && (chunk.marker.kind === 'disable' || chunk.marker.kind === 'enable') && chunk.marker.id === String(id))
    if (!marked && !includeUnmarked) continue
    return {
      start: chunk.start,
      end: chunk.end,
      disabled: ov.disabled,
      hasMarker: !!chunk.marker,
      markerKind: chunk.marker ? chunk.marker.kind : null,
      markerVersion: chunk.marker ? chunk.marker.version : null,
    }
  }
  return null
}

// ═══════════════════════════ 行级改写（块拼贴） ═══════════════════════════

/** 把行数组转成可变记录（保留原行尾透传）。 */
function toRecs(lines) {
  return lines.map((raw) => ({ bare: bareOf(raw), eol: eolOfRaw(raw) }))
}

function recsToText(recs) {
  return recs.map((r) => r.bare + r.eol).join('')
}

/** 按 ops 重建 `[from,to)` 段：`drop` / `text` / `insertBefore` / `insertAfter`。 */
function applyOps(recs, from, to, ops, eol) {
  const out = []
  for (let i = from; i < to; i++) {
    const op = ops.get(i)
    if (op && op.insertBefore) for (const t of op.insertBefore) out.push({ bare: t, eol })
    if (op && op.drop) continue
    if (op && op.text !== undefined) out.push({ bare: op.text, eol: recs[i].eol || eol })
    else out.push(recs[i])
    if (op && op.insertAfter) for (const t of op.insertAfter) out.push({ bare: t, eol })
  }
  return out
}

function ensureOp(ops, index) {
  let op = ops.get(index)
  if (!op) {
    op = {}
    ops.set(index, op)
  }
  return op
}

/** 渲染 `key` 的规范值：标量 / `args` 列表 / `env`·`headers` 映射。 */
function renderFieldLines(key, value, indent, eol) {
  const pad = ' '.repeat(indent)
  const kind = CONTAINER_FIELDS[key]
  if (kind === 'list') {
    const arr = Array.isArray(value) ? value : []
    return [`${pad}${key}:`, ...arr.map((v) => `${' '.repeat(indent + 2)}- ${yq(v)}`)]
  }
  if (kind === 'map') {
    const obj = isPlainObject(value) ? value : {}
    return [`${pad}${key}:`, ...Object.entries(obj).map(([k, v]) => `${' '.repeat(indent + 2)}${yplain(k)}: ${yq(v)}`)]
  }
  return [`${pad}${key}: ${yq(value)}`]
}

/** 值是否「空」：`null`/`undefined`/空串/空数组/空对象 → 视为「删除该字段」。 */
function isEmptyValue(v) {
  if (v === undefined || v === null) return true
  if (typeof v === 'string') return v === ''
  if (Array.isArray(v)) return v.length === 0
  if (isPlainObject(v)) return Object.keys(v).length === 0
  return false
}

/**
 * 把一个已存在的 `- insert:` 条目块按 config 做**最小行级改写**（只动需要变的行）。
 * @returns {{ recs: object[], error: null|object }}
 */
function rewriteInsertBlock(recs, entry, id, config, desiredDisabled, eol) {
  const ins = entry._insert
  if (!ins || ins.flowStyle || ins.empty) {
    return { recs: null, error: { code: 'E_UNSUPPORTED_BLOCK', message: `条目 ${id} 的行块形态无法安全改写（缺少 config / id 行）` } }
  }
  const ops = new Map()
  const insertRange = entry.bodyStart
  // 1) 标记行：只在**缺标记**时补 `:2:` 标记；已有标记（含旧版 `:server:`）逐字保留，
  //    版本升级是显式动作（`planMigration`），普通编辑不做无谓改写。
  //    例外：挂在 insert 块前的标记 kind 不是 server（形态不对）→ 纠正成 server 标记。
  if (entry.markerLine === null) {
    ensureOp(ops, entry.bodyStart).insertBefore = [MARK.server(id)]
  } else if (entry.markerKind !== 'server') {
    ensureOp(ops, entry.markerLine).text = MARK.server(id)
  }
  // 2) 行内 disabled
  if (desiredDisabled === true) {
    if (ins.disabledField) {
      if (unquote(ins.disabledField.valueText) !== true) ensureOp(ops, ins.disabledField.lineIndex).text = `${' '.repeat(ins.itemKeyIndent)}disabled: true`
    } else {
      const afterName = ins.fields.name ? ins.fields.name.lineIndex : ins.itemStart
      const op = ensureOp(ops, afterName)
      op.insertAfter = [...(op.insertAfter || []), `${' '.repeat(ins.itemKeyIndent)}disabled: true`]
    }
  } else if (desiredDisabled === false && ins.disabledField) {
    ensureOp(ops, ins.disabledField.lineIndex).drop = true
  }
  // 3) config 段：标量就地替换、容器整块重渲染、缺失字段按规范顺序补位
  const wanted = {}
  for (const [k, v] of Object.entries(isPlainObject(config) ? config : {})) {
    if (k === 'disabled') continue
    if (CONFIG_FIELD_ORDER.includes(k)) wanted[k] = v
  }
  const present = ins.configFields
  const missing = Object.keys(wanted).filter((k) => !present[k] && !isEmptyValue(wanted[k]))
  for (const key of Object.keys(wanted)) {
    if (!CONFIG_FIELD_ORDER.includes(key)) continue
    const value = wanted[key]
    const cur = present[key]
    if (!cur) continue
    const current = ins.config[key]
    if (isEmptyValue(value)) {
      ops.set(cur.lineIndex, { ...(ops.get(cur.lineIndex) || {}), drop: true })
      continue
    }
    if (deepEqual(current, value) && !CONTAINER_FIELDS[key]) continue
    if (CONTAINER_FIELDS[key] && deepEqual(current, value)) continue
    const lines = renderFieldLines(key, value, cur.indent, eol)
    if (lines.length === 1) {
      ops.set(cur.lineIndex, { ...(ops.get(cur.lineIndex) || {}), text: lines[0] })
    } else {
      const op = ensureOp(ops, cur.lineIndex)
      op.text = lines[0]
      op.drop = false
      for (let i = cur.lineIndex + 1; i < cur.end; i++) ensureOp(ops, i).drop = true
      const tail = ensureOp(ops, cur.end - 1)
      tail.insertAfter = [...(tail.insertAfter || []), ...lines.slice(1)]
    }
  }
  if (missing.length) {
    if (!ins.configField) {
      const anchor = ins.fields.name ? ins.fields.name.lineIndex : ins.itemStart
      const op = ensureOp(ops, anchor)
      const block = [`${' '.repeat(IND_CONFIG)}config:`]
      for (const key of CONFIG_FIELD_ORDER.filter((k) => missing.includes(k))) {
        block.push(...renderFieldLines(key, wanted[key], IND_CONFIG_KEY, eol))
      }
      op.insertAfter = [...(op.insertAfter || []), ...block]
    } else {
      const cfg = ins.configField
      const cfgIndent = ins.configChildIndent
      for (const key of CONFIG_FIELD_ORDER.filter((k) => missing.includes(k))) {
        const lines = renderFieldLines(key, wanted[key], cfgIndent, eol)
        const laterKey = CONFIG_FIELD_ORDER.slice(CONFIG_FIELD_ORDER.indexOf(key) + 1).find((k) => present[k])
        if (laterKey) {
          ensureOp(ops, present[laterKey].lineIndex).insertBefore = [...(ensureOp(ops, present[laterKey].lineIndex).insertBefore || []), ...lines]
        } else {
          const op = ensureOp(ops, cfg.end - 1)
          op.insertAfter = [...(op.insertAfter || []), ...lines]
        }
      }
    }
  }
  const rangeEnd = Math.max(entry.blockEnd, entry.bodyStart + 1)
  const rebuilt = applyOps(recs, entry.blockStart, rangeEnd, ops, eol)
  return { recs: rebuilt, error: null, insertRange }
}

/** 组装：`[0,start)` + 重建段 + `[end,…)`；`skips` 为要整段丢弃的 `[start,end)`。 */
function assemble(recs, head, rebuilt, tail, skips) {
  const out = []
  out.push(...recs.slice(0, head))
  out.push(...rebuilt)
  for (let i = tail; i < recs.length; i++) {
    if (skips.some((s) => i >= s.start && i < s.end)) continue
    out.push(recs[i])
  }
  return out
}

/**
 * 单文件行变换：新增或更新一台服务器的 `- insert:` 条目块。
 *
 * @param {string} text 目标文件全文
 * @param {string} id 条目 id
 * @param {object} config `@deepseek-ai/dsh-mcp-client` 的 Config（部分字段即可：未给出的字段保持原样）
 * @param {{disabled?: boolean, create?: boolean}} [opts] `disabled` 缺省保持原状态；`create:false` 时找不到不新建
 * @returns {{ text: string, changed: boolean, action: 'insert'|'update'|'none', error: null|object }}
 */
export function planUpsert(text, id, config, opts) {
  return applyUpsert(text, id, config, opts)
}

function applyUpsert(text, id, config, opts) {
  const raw = String(text ?? '')
  const parsed = parsePatch(raw)
  if (!parsed.ok) return { text: raw, changed: false, action: 'none', error: parsed.error }
  if (!MCP_ID_PATTERN.test(String(id))) {
    return { text: raw, changed: false, action: 'none', error: { code: 'E_BAD_ID', message: `条目 id 非法：${id}` } }
  }
  const hits = parsed.entries.filter((e) => e.id === String(id))
  if (hits.length > 1) {
    return { text: raw, changed: false, action: 'none', error: { code: 'E_DUPLICATE', message: `同一文件内 id ${id} 出现 ${hits.length} 次，拒绝写入` } }
  }
  const eol = parsed.eol
  const create = !opts || opts.create !== false
  if (!hits.length) {
    if (!create) return { text: raw, changed: false, action: 'none', error: { code: 'E_NOT_FOUND', message: `未找到条目 ${id}` } }
    const block = buildInsertBlock(id, config, eol, opts)
    const recs = toRecs(parsed.lines)
    const out = recs.slice()
    if (out.length && out[out.length - 1].eol === '') out[out.length - 1] = { ...out[out.length - 1], eol }
    for (const line of splitKeepEol(block)) out.push({ bare: bareOf(line), eol: eolOfRaw(line) || eol })
    const next = recsToText(out)
    return { text: next, changed: next !== raw, action: 'insert', error: null }
  }
  const entry = hits[0]
  const desiredDisabled = opts && opts.disabled !== undefined ? opts.disabled === true : entry.disabled === true
  const cfg = isPlainObject(config) ? config : {}
  const res = rewriteInsertBlock(toRecs(parsed.lines), entry, String(id), cfg, desiredDisabled, eol)
  if (res.error) return { text: raw, changed: false, action: 'none', error: res.error }
  const skips = []
  for (const ov of entry._overrides) skips.push({ start: ov.blockStart, end: ov.blockEnd })
  const next = recsToText(assemble(toRecs(parsed.lines), entry.blockStart, res.recs, entry.blockEnd, skips))
  return { text: next, changed: next !== raw, action: 'update', error: null }
}

/**
 * 单文件行变换：删除一台服务器的行块（insert 块 + 同 id 的旧覆盖行；文件里其它字节不动）。
 */
export function planRemove(text, id) {
  const raw = String(text ?? '')
  const parsed = parsePatch(raw)
  if (!parsed.ok) return { text: raw, changed: false, action: 'none', error: parsed.error }
  const hits = parsed.entries.filter((e) => e.id === String(id))
  const overrides = parsed.overrides.filter((o) => o.id === String(id))
  if (!hits.length && !overrides.length) {
    return { text: raw, changed: false, action: 'none', error: { code: 'E_NOT_FOUND', message: `未找到条目 ${id}` } }
  }
  const recs = toRecs(parsed.lines)
  const skips = []
  for (const h of hits) skips.push({ start: h.blockStart, end: h.blockEnd })
  for (const o of overrides) skips.push({ start: o.blockStart, end: o.blockEnd })
  const keep = []
  for (let i = 0; i < recs.length; i++) {
    if (skips.some((s) => i >= s.start && i < s.end)) continue
    keep.push(recs[i])
  }
  const next = recsToText(keep)
  return { text: next, changed: next !== raw, action: 'remove', error: null }
}

/**
 * 单文件行变换：启用 / 停用一台服务器。
 *
 * 停用 → 在该 insert 条目内部写 `disabled: true`；启用 → 撤掉行内 `disabled`。
 * 两种情况都会顺带清掉同文件里同 id 的旧 `- id:` 覆盖行（语义已被行内 disabled 取代）。
 */
export function planSetEnabled(text, id, enabled) {
  const raw = String(text ?? '')
  const parsed = parsePatch(raw)
  if (!parsed.ok) return { text: raw, changed: false, action: 'none', error: parsed.error }
  const hits = parsed.entries.filter((e) => e.id === String(id))
  if (hits.length > 1) {
    return { text: raw, changed: false, action: 'none', error: { code: 'E_DUPLICATE', message: `同一文件内 id ${id} 出现 ${hits.length} 次，拒绝写入` } }
  }
  if (!hits.length) {
    return { text: raw, changed: false, action: 'none', error: { code: 'E_NOT_FOUND', message: `未找到条目 ${id}` } }
  }
  const eol = parsed.eol
  const entry = hits[0]
  const res = rewriteInsertBlock(toRecs(parsed.lines), entry, String(id), {}, enabled !== true, eol)
  if (res.error) return { text: raw, changed: false, action: 'none', error: res.error }
  const skips = []
  for (const ov of entry._overrides) skips.push({ start: ov.blockStart, end: ov.blockEnd })
  const next = recsToText(assemble(toRecs(parsed.lines), entry.blockStart, res.recs, entry.blockEnd, skips))
  return { text: next, changed: next !== raw, action: 'update', error: null }
}

// ═══════════════════════════ 迁移 ═══════════════════════════

/**
 * 一次性迁移（幂等）：旧标记 → `:2:`；形态匹配但无标记的条目补标记；同层 disable 覆盖行收敛为
 * 该 insert 行自身的 `disabled: true`。
 *
 * @param {string} text 目标文件全文
 * @param {{target?: string}} [opts] `target` 只用于回填 `writes[].target`（默认 `'home'`；本函数不做路径映射）
 * @returns {{ ok: boolean, error: null|object, writes: Array<{target: string, text: string}>,
 *   stats: { relabeled: number, tagged: number, converged: number, skipped: Array<{reason: string, count: number}> } }}
 *   `writes` 为空数组即「无需改动」（幂等：第二次执行恒为空）。
 */
export function planMigration(text, opts) {
  const raw = String(text ?? '')
  const target = opts && typeof opts.target === 'string' && opts.target ? opts.target : 'home'
  const empty = { ok: false, error: null, writes: [], stats: { relabeled: 0, tagged: 0, converged: 0, skipped: [] } }
  const parsed = parsePatch(raw)
  if (!parsed.ok) return { ...empty, error: parsed.error }
  const eol = parsed.eol
  const lines = parsed.lines
  const scan = scanBlocks(lines)
  const recs = toRecs(lines)

  // 第一遍：算出「要收敛掉的覆盖行」与其归属 insert 条目。
  const collapseByEntry = new Map()
  const collapsible = new Set()
  const collapses = []
  for (const chunk of scan) {
    if (!chunk.marker) continue
    if (chunk.marker.kind === 'server') continue
    const owner = parsed.entries.find((e) => e.id === chunk.marker.id)
    if (!owner) continue
    const headIndex = entryHeadOf(lines, chunk)
    if (headIndex === null) continue
    const ov = parseOverrideBody(lines, headIndex, chunk.end)
    if (!ov || ov.key !== 'id' || ov.disabled === undefined) continue
    collapsible.add(chunk.start)
    collapseByEntry.set(owner.id, ov.disabled === true)
  }

  const skippedCount = new Map()
  const bump = (reason) => skippedCount.set(reason, (skippedCount.get(reason) || 0) + 1)
  const skippedList = () =>
    [...skippedCount.entries()]
      .sort((a, b) => (a[0] < b[0] ? -1 : a[0] > b[0] ? 1 : 0))
      .map(([reason, count]) => ({ reason, count }))
  const taggedIds = new Set(
    parsed.entries.filter((e) => e.hasMarker && e.markerKind === 'server' && e.markerVersion >= MARKER_VERSION).map((e) => e.id),
  )
  const out = []
  let relabeled = 0
  let tagged = 0
  let converged = 0

  for (const chunk of scan) {
    if (collapsible.has(chunk.start)) {
      converged++
      continue
    }
    if (chunk.kind === 'free' || chunk.kind === 'comment') {
      out.push(...recs.slice(chunk.start, chunk.end))
      continue
    }
    const headIndex = entryHeadOf(lines, chunk)
    if (headIndex === null) {
      if (chunk.marker) {
        if (chunk.marker.version >= MARKER_VERSION) out.push(...recs.slice(chunk.start, chunk.end))
        else {
          out.push({ bare: markerTextOf(chunk.marker), eol: recs[chunk.start].eol || eol })
          out.push(...recs.slice(chunk.start + 1, chunk.end))
          relabeled++
        }
      } else out.push(...recs.slice(chunk.start, chunk.end))
      continue
    }
    const insert = parseInsertBody(lines, headIndex, chunk.end)
    if (insert && !insert.flowStyle) {
      const isMcp = insert.name === MCP_PACKAGE_NAME
      if (!isMcp) {
        bump('not-mcp-package')
        out.push(...recs.slice(chunk.start, chunk.end))
        continue
      }
      if (!insert.id) {
        bump('no-id')
        out.push(...recs.slice(chunk.start, chunk.end))
        continue
      }
      const markerIsServerV2 = !!(chunk.marker && chunk.marker.kind === 'server' && chunk.marker.version >= MARKER_VERSION)
      const sameIdCount = parsed.entries.filter((e) => e.id === insert.id).length
      if (!chunk.marker) {
        if (taggedIds.has(insert.id) || sameIdCount > 1) {
          bump('duplicate-id')
          out.push(...recs.slice(chunk.start, chunk.end))
          continue
        }
        out.push({ bare: MARK.server(insert.id), eol: recs[chunk.start].eol || eol })
        tagged++
        out.push(...recs.slice(chunk.start, chunk.end))
      } else if (!markerIsServerV2) {
        out.push({ bare: MARK.server(insert.id), eol: recs[chunk.start].eol || eol })
        relabeled++
        out.push(...recs.slice(chunk.start + 1, chunk.end))
      } else {
        out.push(...recs.slice(chunk.start, chunk.end))
      }
      if (collapseByEntry.has(insert.id)) collapses.push({ disabled: collapseByEntry.get(insert.id), insert })
      continue
    }
    const ov = parseOverrideBody(lines, headIndex, chunk.end)
    if (ov && ov.key === 'id' && chunk.marker && chunk.marker.kind !== 'server') {
      if (chunk.marker.version >= MARKER_VERSION) out.push(...recs.slice(chunk.start, chunk.end))
      else {
        out.push({ bare: markerTextOf(chunk.marker), eol: recs[chunk.start].eol || eol })
        out.push(...recs.slice(chunk.start + 1, chunk.end))
        relabeled++
      }
      continue
    }
    if (ov && ov.key === 'id') bump('not-managed-entry')
    else bump('not-managed-entry')
    out.push(...recs.slice(chunk.start, chunk.end))
  }
  for (const c of collapses) applyCollapse(out, recs, c.disabled, c.insert, eol)
  const next = recsToText(out)
  const stats = {
    relabeled,
    tagged,
    converged,
    skipped: skippedList(),
  }
  if (next === raw) return { ok: true, error: null, writes: [], stats }
  return { ok: true, error: null, writes: [{ target, text: next }], stats }
}

/** 把一个 insert 条目块内的 `disabled` 收敛成期望值（迁移用；只动一行）。 */
function applyCollapse(out, recs, disabled, insert, eol) {
  const target = { bare: `${' '.repeat(insert.itemKeyIndent)}disabled: ${disabled ? 'true' : 'false'}`, eol }
  if (insert.disabledField) {
    const idx = out.indexOf(recs[insert.disabledField.lineIndex])
    if (idx >= 0) out[idx] = target
    return
  }
  if (disabled !== true) return
  const anchor = insert.fields.name ? insert.fields.name.lineIndex : insert.itemStart
  const idx = out.indexOf(recs[anchor])
  if (idx >= 0) out.splice(idx + 1, 0, target)
}

function markerTextOf(marker) {
  if (marker.kind === 'server') return MARK.server(marker.id)
  if (marker.kind === 'disable') return MARK.disable(marker.id)
  return `# dsh-mcp-manager:2:enable:${marker.id}`
}

// ═══════════════════════════ 校验 ═══════════════════════════

function normalizeTaken(taken) {
  const out = []
  const src = Array.isArray(taken) ? taken : taken ? [taken] : []
  for (const t of src) {
    if (typeof t === 'string') out.push({ id: t, serverName: t })
    else if (t && typeof t === 'object') out.push({ id: t.id != null ? String(t.id) : null, serverName: t.serverName != null ? String(t.serverName) : null })
  }
  return out
}

/**
 * 按 `@deepseek-ai/dsh-mcp-client` 的 Config 校验（写前硬校验，违反即拒绝）。
 *
 * @param {string} id 条目 id
 * @param {object} config Config（`serverName` 可单独作为第 2 参…也可只出现在 `config` 内）
 * @param {Array<{id?: string, serverName?: string}|string>} [taken] 已占用者。对象形态精确；字符串形态
 *   按「id 与 serverName 都是它」保守判定。
 * @returns {{ ok: boolean, fields: Record<string,string>, conflicts: Array<{code: string, field: string, message: string}> }}
 */
export function validateMcpConfig(id, config, taken) {
  const fields = {}
  const conflicts = []
  const add = (code, field, message) => {
    if (!fields[field]) fields[field] = message
    conflicts.push({ code, field, message })
  }
  const cfg = isPlainObject(config) ? config : null
  const occupied = normalizeTaken(taken)

  if (typeof id !== 'string' || !MCP_ID_PATTERN.test(id)) {
    add('E_BAD_ID', 'id', `id 非法：只允许字母 / 数字 / . _ -（1–64 字符）`)
  } else if (occupied.some((t) => t.id === id)) {
    add('E_ID_TAKEN', 'id', `id ${id} 已被占用`)
  }
  if (!cfg) {
    add('E_CONFIG', 'config', '缺少 config 对象')
    return { ok: false, fields, conflicts }
  }
  const transport = cfg.transport
  if (transport === undefined || transport === null || transport === '') add('E_REQUIRED', 'transport', 'transport 必填（stdio 或 streamable-http）')
  else if (!TRANSPORTS.includes(transport)) add('E_BAD_TRANSPORT', 'transport', `transport 只能是 ${TRANSPORTS.join(' / ')}，收到 ${JSON.stringify(transport)}`)
  const serverName = cfg.serverName
  if (typeof serverName !== 'string' || serverName === '') add('E_REQUIRED', 'serverName', 'serverName 必填')
  else if (!SERVER_NAME_PATTERN.test(serverName)) add('E_BAD_SERVER_NAME', 'serverName', 'serverName 只允许字母 / 数字 / _ -，长度 1–32')
  else if (occupied.some((t) => t.serverName === serverName)) add('E_SERVER_NAME_TAKEN', 'serverName', `serverName ${serverName} 已被其它服务器占用`)

  if (transport === 'stdio') {
    if (typeof cfg.command !== 'string' || cfg.command === '') add('E_REQUIRED', 'command', 'stdio 传输必须有 command')
    if (cfg.args !== undefined && (!Array.isArray(cfg.args) || cfg.args.some((a) => typeof a !== 'string'))) {
      add('E_BAD_ARGS', 'args', 'args 必须是字符串数组')
    }
    if (cfg.env !== undefined && (!isPlainObject(cfg.env) || Object.values(cfg.env).some((v) => typeof v !== 'string'))) {
      add('E_BAD_ENV', 'env', 'env 必须是「字符串 → 字符串」映射')
    }
    if (cfg.cwd !== undefined && typeof cfg.cwd !== 'string') add('E_BAD_CWD', 'cwd', 'cwd 必须是字符串')
  } else if (TRANSPORTS.includes(transport)) {
    if (typeof cfg.url !== 'string' || cfg.url === '') add('E_REQUIRED', 'url', 'streamable-http 传输必须有 url')
    else if (!/^https?:\/\//.test(cfg.url)) add('E_BAD_URL', 'url', 'url 必须以 http:// 或 https:// 开头')
    if (cfg.headers !== undefined && (!isPlainObject(cfg.headers) || Object.values(cfg.headers).some((v) => typeof v !== 'string'))) {
      add('E_BAD_HEADERS', 'headers', 'headers 必须是「字符串 → 字符串」映射')
    }
  }
  if (cfg.toolCallTimeoutMs !== undefined && (!Number.isInteger(cfg.toolCallTimeoutMs) || cfg.toolCallTimeoutMs <= 0)) {
    add('E_BAD_TIMEOUT', 'toolCallTimeoutMs', 'toolCallTimeoutMs 必须是正整数')
  }
  if (cfg.maxInstructionBytes !== undefined && (!Number.isInteger(cfg.maxInstructionBytes) || cfg.maxInstructionBytes < 1)) {
    add('E_BAD_MAX_INSTRUCTION_BYTES', 'maxInstructionBytes', 'maxInstructionBytes 必须是 ≥ 1 的整数')
  }
  if (cfg.failOnStartupError !== undefined && typeof cfg.failOnStartupError !== 'boolean') {
    add('E_BAD_FAIL_ON_STARTUP_ERROR', 'failOnStartupError', 'failOnStartupError 必须是布尔值')
  }
  if (cfg.reconnect !== undefined && !isPlainObject(cfg.reconnect)) {
    add('E_BAD_RECONNECT', 'reconnect', 'reconnect 必须是对象')
  }
  return { ok: conflicts.length === 0, fields, conflicts }
}

// ═══════════════════════════ 落点规划（矩阵） ═══════════════════════════

function normalizeProfiles(profiles, extraNames) {
  const out = []
  const push = (name, text) => {
    if (typeof name !== 'string' || name === '') return
    if (out.some((p) => p.name === name)) return
    out.push({ name, text: typeof text === 'string' ? text : '' })
  }
  for (const p of Array.isArray(profiles) ? profiles : []) {
    if (typeof p === 'string') push(p, '')
    else if (p && typeof p === 'object') push(p.name, p.text)
  }
  for (const n of Array.isArray(extraNames) ? extraNames : []) push(typeof n === 'string' ? n : n && n.name, '')
  return out.sort((a, b) => (a.name < b.name ? -1 : a.name > b.name ? 1 : 0))
}

/**
 * 按 design.md 的「矩阵落点算法」把**一台服务器**的定义重排到正确的层。
 *
 * 输入只有文本与选择，不做任何路径映射（`target: 'home'` → `$DSH_HOME/cordis.patch.yml`、
 * `target: '<profile 名>'` → `$DSH_HOME/profiles/<名>/cordis.patch.yml` 由宿主半完成）。
 *
 * @param {{
 *   id: string, serverName?: string, config?: object,
 *   homeText?: string, profiles?: Array<{name: string, text: string}|string>, selected?: string[]
 * }} input
 * @returns {{
 *   ok: boolean,
 *   writes: Array<{ target: 'home'|string, text: string, action: 'insert'|'update'|'remove' }>,
 *   conflicts: Array<{ code: string, id?: string, layers?: string[], field?: string, message: string }>,
 *   notes: string[]
 * }} 有冲突时 `ok:false` 且 `writes` 恒为空数组（零写入）；`writes` 里只出现**真的会变**的文件。
 */
export function planLayout(input) {
  const src = isPlainObject(input) ? input : {}
  const id = src.id != null ? String(src.id) : ''
  const notes = []
  const conflicts = []
  const fail = () => ({ ok: false, writes: [], conflicts, notes })
  const profiles = normalizeProfiles(src.profiles)
  const profileNames = profiles.map((p) => p.name)
  const homeText = typeof src.homeText === 'string' ? src.homeText : ''
  const config = { ...(isPlainObject(src.config) ? src.config : {}) }
  if (src.serverName !== undefined) config.serverName = src.serverName

  const homeParsed = parsePatch(homeText)
  if (!homeParsed.ok) conflicts.push({ code: homeParsed.error.code, layers: ['home'], message: `home：${homeParsed.error.message}` })
  const fileViews = []
  for (const p of profiles) {
    const parsed = parsePatch(p.text)
    if (!parsed.ok) conflicts.push({ code: parsed.error.code, layers: [p.name], message: `${p.name}：${parsed.error.message}` })
    fileViews.push({ target: p.name, text: p.text, parsed })
  }
  if (conflicts.length) return fail()

  // 跨层重复 / 同文件重复（当前状态，写前硬校验）
  const homeHits = homeParsed.entries.filter((e) => e.id === id)
  if (homeHits.length > 1) conflicts.push({ code: 'E_DUPLICATE', id, layers: ['home'], message: `home 层同 id ${id} 出现 ${homeHits.length} 次` })
  for (const v of fileViews) {
    const hits = v.parsed.entries.filter((e) => e.id === id)
    if (hits.length > 1) conflicts.push({ code: 'E_DUPLICATE', id, layers: [v.target], message: `${v.target} 内同 id ${id} 出现 ${hits.length} 次` })
  }
  const crossLayers = fileViews.filter((v) => v.parsed.entries.some((e) => e.id === id)).map((v) => v.target)
  if (homeHits.length && crossLayers.length) {
    conflicts.push({
      code: 'E_CROSS_LAYER',
      id,
      layers: ['home', ...crossLayers],
      message: `同一 id ${id} 同时存在于 home 层与 profile 层（${crossLayers.join(', ')}）：重复的 loader 条目 id 会导致启动失败，请先修复布局`,
    })
  }

  // config 校验 + serverName 跨服务器唯一
  const taken = []
  const collect = (entries) => {
    for (const e of entries) {
      if (e.id === id) continue
      taken.push({ id: e.id, serverName: e.serverName })
    }
  }
  collect(homeParsed.entries)
  for (const v of fileViews) collect(v.parsed.entries)
  const validated = validateMcpConfig(id, config, taken)
  for (const c of validated.conflicts) conflicts.push({ ...c, id, message: `config.${c.field}: ${c.message}` })
  if (conflicts.length) return fail()

  const selected = new Set((Array.isArray(src.selected) ? src.selected : []).filter((n) => typeof n === 'string'))
  const unknown = [...selected].filter((n) => !profileNames.includes(n))
  if (unknown.length) {
    conflicts.push({ code: 'E_UNKNOWN_PROFILE', id, layers: unknown, message: `选中的 profile 不存在：${unknown.join(', ')}` })
    return fail()
  }
  const S = profileNames.filter((n) => selected.has(n))
  const P = profileNames
  let mode
  if (P.length === 0) {
    mode = 'none'
    notes.push('当前没有任何 profile 目录：按「全不生效」落在 home 层（行内 disabled: true）')
  } else if (S.length === P.length) mode = 'all'
  else if (S.length === 0) mode = 'none'
  else mode = 'some'

  const disabled = mode === 'none'
  const writes = []
  const plan = (target, text, wantPresent) => {
    const parsed = target === 'home' ? homeParsed : fileViews.find((v) => v.target === target).parsed
    const has = parsed.entries.some((e) => e.id === id)
    if (!wantPresent) {
      if (!has) return
      const res = planRemove(text, id)
      if (res.error) {
        conflicts.push({ code: res.error.code, id, layers: [target], message: `${target}：${res.error.message}` })
        return
      }
      if (res.changed) writes.push({ target, text: res.text, action: 'remove' })
      return
    }
    const res = applyUpsert(text, id, config, { disabled, create: true })
    if (res.error) {
      conflicts.push({ code: res.error.code, id, layers: [target], message: `${target}：${res.error.message}` })
      return
    }
    if (res.changed) writes.push({ target, text: res.text, action: has ? 'update' : 'insert' })
  }

  if (mode === 'all') {
    plan('home', homeText, true)
    for (const v of fileViews) plan(v.target, v.text, false)
  } else if (mode === 'some') {
    plan('home', homeText, false)
    for (const v of fileViews) plan(v.target, v.text, S.includes(v.target))
  } else {
    plan('home', homeText, true)
    for (const v of fileViews) plan(v.target, v.text, false)
  }
  if (conflicts.length) return fail()
  return { ok: true, writes, conflicts: [], notes }
}

// ═══════════════════════════ 面板列表（矩阵反推） ═══════════════════════════

/**
 * 把 home 层与各 profile 层的 patch 文本合并成面板用的统一列表，并反推矩阵与布局漂移。
 *
 * @param {{
 *   homeText?: string,
 *   profiles?: Array<{name: string, text: string}|string>,
 *   profilesOnDisk?: Array<string|{name: string}>,
 *   knownProfiles?: string[]
 * }} input `profilesOnDisk` 补上「磁盘上有、但还没有 patch 文件」的 profile（text 按空串算）；
 *   `knownProfiles` 是上次确认矩阵时的 profile 集合（`state.json`），缺失时无法判定「新 profile」漂移。
 * @returns {{
 *   ok: boolean,
 *   profiles: string[],
 *   servers: Array<object>,
 *   conflicts: Array<{code: string, id?: string, layers?: string[], message: string}>
 * }}
 *   每台服务器含 `matrix`（面板勾选 = 用户意图）、`effective`（按层序的运行期结论）、`location`、`layoutDrift`。
 */
export function mergeServers(input) {
  const src = isPlainObject(input) ? input : {}
  const homeText = typeof src.homeText === 'string' ? src.homeText : ''
  const profiles = normalizeProfiles(src.profiles, src.profilesOnDisk)
  const P = profiles.map((p) => p.name)
  const conflicts = []
  const homeParsed = parsePatch(homeText)
  if (!homeParsed.ok) conflicts.push({ code: homeParsed.error.code, layers: ['home'], message: `home：${homeParsed.error.message}` })
  const views = []
  for (const p of profiles) {
    const parsed = parsePatch(p.text)
    if (!parsed.ok) conflicts.push({ code: parsed.error.code, layers: [p.name], message: `${p.name}：${parsed.error.message}` })
    views.push({ name: p.name, parsed, lines: parsed.lines })
  }
  const known = Array.isArray(src.knownProfiles) ? src.knownProfiles.filter((n) => typeof n === 'string') : null

  const ids = []
  const homeById = new Map()
  for (const e of homeParsed.entries) {
    if (!ids.includes(e.id)) ids.push(e.id)
    if (homeById.has(e.id)) {
      conflicts.push({ code: 'E_DUPLICATE', id: e.id, layers: ['home'], message: `home 层同 id ${e.id} 出现多次` })
    } else homeById.set(e.id, e)
  }
  const byProfile = new Map()
  for (const v of views) {
    const m = new Map()
    for (const e of v.parsed.entries) {
      if (!ids.includes(e.id)) ids.push(e.id)
      if (m.has(e.id)) conflicts.push({ code: 'E_DUPLICATE', id: e.id, layers: [v.name], message: `${v.name} 内同 id ${e.id} 出现多次` })
      else m.set(e.id, e)
    }
    byProfile.set(v.name, m)
  }

  // 覆盖行（`- id: x` + `disabled:`）：只有「我们的」覆盖行才参与判定——
  // 带管理器标记，或 `name` 就是 MCP 客户端包。真实 profile patch 里有几十条别人插件的
  // `- id:` 覆盖行（web / ui-settings / llm-deepseek …），一律无视、不进 servers、不报错。
  // 我们的覆盖行若找不到任何 insert 条目，就是悬空行（insert 被删了、覆盖行还在）→ 报错给面板。
  const orphanSeen = new Set()
  const orphanOverrides = []
  for (const o of homeParsed.overrides) orphanOverrides.push({ target: 'home', id: o.id, markerKind: o.markerKind, name: o.name })
  for (const v of views) for (const o of v.parsed.overrides) orphanOverrides.push({ target: v.name, id: o.id, markerKind: o.markerKind, name: o.name })
  for (const o of orphanOverrides) {
    if (!(o.markerKind || o.name === MCP_PACKAGE_NAME)) continue
    if (ids.includes(o.id)) continue
    const key = `${o.target}:${o.id}`
    if (orphanSeen.has(key)) continue
    orphanSeen.add(key)
    conflicts.push({
      code: 'E_ORPHAN_OVERRIDE',
      id: o.id,
      layers: [o.target],
      message: `${o.target}：悬空的覆盖行（id ${o.id} 没有任何 insert 条目），请删除该行或恢复对应服务器`,
    })
  }

  const servers = []
  for (const id of ids) {
    const home = homeById.get(id) || null
    const inProfiles = P.filter((n) => byProfile.get(n).has(id))
    const layers = [...(home ? ['home'] : []), ...inProfiles]
    const sample = home || (inProfiles.length ? byProfile.get(inProfiles[0]).get(id) : null) || null
    const matrix = {}
    const effective = {}
    const requested = {}
    for (const n of P) matrix[n] = false
    const sameLayerDisable = !!(home && home.sameLayerOverride && home.sameLayerOverride.disabled === true)
    if (home) {
      for (const n of P) matrix[n] = home.disabled || sameLayerDisable ? false : true
    }
    for (const n of inProfiles) {
      const e = byProfile.get(n).get(id)
      const blocked = !!(e.sameLayerOverride && e.sameLayerOverride.disabled === true)
      matrix[n] = blocked || e.disabled ? false : true
    }
    // 运行期结论 = 只看 insert 定义（profile 层覆盖行按实测层序命中不了 home 层条目）
    for (const n of P) effective[n] = matrix[n]
    // profile 层覆盖行：`- id: x` + `disabled:`（带我们的标记，或 name 就是 MCP 客户端包）。
    // 面板勾选 = 用户意图（matrix）；若该 profile 自己没有同 id 的 insert 条目，这行按实测层序
    // **命中不了 home 层 insert**（warn+skip）⇒ 运行期仍然生效 ⇒ 记 ineffective 并标漂移。
    const profileIntent = new Map()
    const ineffective = []
    for (const v of views) {
      for (const o of v.parsed.overrides) {
        if (o.id !== id) continue
        const ours = o.markerKind === 'disable' || o.markerKind === 'enable' || o.name === MCP_PACKAGE_NAME
        if (!ours) continue
        profileIntent.set(v.name, o.disabled === true)
        if (!byProfile.get(v.name).has(id)) ineffective.push({ target: v.name, disabled: o.disabled === true })
      }
    }
    for (const [n, dis] of profileIntent) if (n in matrix) matrix[n] = !dis
    for (const n of P) requested[n] = matrix[n]

    let location
    if (home && inProfiles.length) location = 'conflict'
    else if (home) location = 'home'
    else if (inProfiles.length) location = 'profile'
    else location = 'home'

    let layoutDrift = null
    if (home && inProfiles.length) {
      layoutDrift = {
        code: 'CROSS_LAYER',
        message: `同一 id 同时存在于 home 层与 ${inProfiles.join(', ')}：重复的 loader 条目 id 会导致启动失败，请修复`,
        layers,
      }
    } else if (sameLayerDisable) {
      layoutDrift = {
        code: 'NEEDS_MIGRATION',
        message: '存在同层 disable 覆盖行（当前等同停用）：迁移后收敛为 insert 行内 disabled: true',
        layers,
      }
    } else if (ineffective.length) {
      layoutDrift = {
        code: 'INEFFECTIVE_OVERRIDE',
        message: `profile 层覆盖行在补丁层序下会被跳过（实际仍生效）：${ineffective.map((i) => i.target).join(', ')}`,
        layers,
      }
    } else if (!home && inProfiles.length && known) {
      const appeared = P.filter((n) => !known.includes(n) && !inProfiles.includes(n))
      if (appeared.length) {
        layoutDrift = {
          code: 'NEW_PROFILE',
          message: `新增 profile ${appeared.join(', ')} 未纳入：可勾选让其生效（不会自动写入）`,
          layers: appeared,
        }
      }
    }
    if (home && homeParsed.entries.filter((e) => e.id === id).length > 1) {
      layoutDrift = { code: 'DUPLICATE_ID', message: `home 层同 id ${id} 出现多次`, layers: ['home'] }
    }

    const copies = []
    if (home) copies.push({ target: 'home', blockStart: home.blockStart, blockEnd: home.blockEnd, hasMarker: home.hasMarker, markerKind: home.markerKind, disabled: home.disabled || sameLayerDisable })
    for (const n of inProfiles) {
      const e = byProfile.get(n).get(id)
      copies.push({ target: n, blockStart: e.blockStart, blockEnd: e.blockEnd, hasMarker: e.hasMarker, markerKind: e.markerKind, disabled: e.disabled || !!(e.sameLayerOverride && e.sameLayerOverride.disabled === true) })
    }

    const sampleTarget = home ? 'home' : (inProfiles[0] || null)
    const sampleView = sampleTarget && sampleTarget !== 'home' ? views.find((v) => v.name === sampleTarget) : null
    const sampleLines = sampleTarget === 'home' ? homeParsed.lines : sampleView ? sampleView.lines : []
    servers.push({
      id,
      serverName: sample ? sample.serverName : null,
      transport: sample ? sample.transport : null,
      name: sample ? sample.name : null,
      config: sample ? sample.config : {},
      location,
      layers,
      profiles: P.filter((n) => matrix[n]),
      matrix,
      requested,
      effective,
      disabled: !home && inProfiles.length ? false : !!(home && (home.disabled || sameLayerDisable)),
      hasMarker: sample ? sample.hasMarker : false,
      markerKind: sample ? sample.markerKind : null,
      layoutDrift,
      copies,
      raw: sample ? rawBlockText(sampleLines, sample) : '',
    })
  }
  const cross = new Set()
  for (const s of servers) {
    if (s.location === 'conflict') {
      cross.add(s.id)
      conflicts.push({ code: 'E_CROSS_LAYER', id: s.id, layers: s.layers, message: `同一 id 同时存在于 ${s.layers.join(' + ')}` })
    }
  }
  return { ok: conflicts.length === 0, profiles: P, servers, conflicts }
}

/** 取某条目的原始行块文本（面板「原始 YAML 兜底编辑」用）。 */
function rawBlockText(lines, entry) {
  return lines
    .slice(entry.blockStart, entry.blockEnd)
    .map((l) => bareOf(l))
    .join('\n')
}
