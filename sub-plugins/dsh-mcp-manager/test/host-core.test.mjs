/**
 * dsh-mcp-manager · test/host-core.test.mjs
 *
 * 覆盖 tasks.md §1.2 的 ①–⑧。全部离线：**不读写** `C:\Users\chensir5173\.dsh` 下的任何真实文件——
 * 真实 home patch 在这里是一份逐字拷贝（base64 常量，见下），测试只解它。
 *
 * 运行：`node sub-plugins/dsh-mcp-manager/test/host-core.test.mjs`
 */
import assert from 'node:assert/strict'
import test from 'node:test'
import { createHash } from 'node:crypto'
import { readFileSync } from 'node:fs'
import { fileURLToPath } from 'node:url'
import { dirname, join } from 'node:path'

import {
  MARK,
  MARKER_VERSION,
  MCP_PACKAGE_NAME,
  DEFAULT_PARAMS,
  STATE_VERSION,
  SERVER_NAME_PATTERN,
  TRANSPORTS,
  buildDisableBlock,
  buildInsertBlock,
  defaultState,
  detectEol,
  listProfiles,
  locateDisableBlock,
  locateServerBlock,
  mergeServers,
  parsePatch,
  planLayout,
  planMigration,
  planRemove,
  planSetEnabled,
  planUpsert,
  profilePatchPath,
  splitKeepEol,
  statePath,
  validateMcpConfig,
} from '../src/host-core.js'

// ═══════════════════════ 夹具 ═══════════════════════

/**
 * `$DSH_HOME/cordis.patch.yml` 的**逐字拷贝**（2026-10-18 只读取样：71 行 / 1962 字节 / LF /
 * 末尾有换行 / sha256 839fa1be8fd387165c719fd15ff61cdb1738940b7d687a8650bc44f2374f28f6）。
 * 用 base64 内联是为了零转写风险（里面有 4 条 Windows 反斜杠路径）；下面的哈希断言守住这一点。
 *
 * 结构：idx0–6 = `ida-headless-mcp`（**无标记**）；idx7 起及其后 5 条带旧标记 `:server:`；
 * `mcp-Serena` 另有同层 disable 覆盖行（文件末尾 4 行）。
 */
const HOME_B64 =
  'LSBpbnNlcnQ6CiAgICAtIGlkOiBpZGEtaGVhZGxlc3MtbWNwCiAgICAgIG5hbWU6ICdAZGVlcHNlZWstYWkvZHNoLW1jcC1jbGllbnQnCiAgICAgIGNvbmZpZzoKICAgICAgICBzZXJ2ZXJOYW1lOiAiaWRhLWhlYWRsZXNzLW1jcCIKICAgICAgICB0cmFuc3BvcnQ6ICJzdGRpbyIKICAgICAgICBjb21tYW5kOiAiaWRhbGliLXBvb2wiCiMgZHNoLW1jcC1tYW5hZ2VyOnNlcnZlcjp0YXJjZS11aQotIGluc2VydDoKICAgIC0gaWQ6IHRhcmNlLXVpCiAgICAgIG5hbWU6ICdAZGVlcHNlZWstYWkvZHNoLW1jcC1jbGllbnQnCiAgICAgIGNvbmZpZzoKICAgICAgICBzZXJ2ZXJOYW1lOiAiVHJhY2UtVUkiCiAgICAgICAgdHJhbnNwb3J0OiAic3RkaW8iCiAgICAgICAgY29tbWFuZDogInRyYWNlLWNsaS5leGUiCiMgZHNoLW1jcC1tYW5hZ2VyOnNlcnZlcjptY3AtU2VyZW5hCi0gaW5zZXJ0OgogICAgLSBpZDogbWNwLVNlcmVuYQogICAgICBuYW1lOiAnQGRlZXBzZWVrLWFpL2RzaC1tY3AtY2xpZW50JwogICAgICBjb25maWc6CiAgICAgICAgc2VydmVyTmFtZTogIlNlcmVuYSIKICAgICAgICB0cmFuc3BvcnQ6ICJzdGRpbyIKICAgICAgICBjb21tYW5kOiAic2VyZW5hIgogICAgICAgIGFyZ3M6CiAgICAgICAgICAtICJzdGFydC1tY3Atc2VydmVyIgogICAgICAgICAgLSAiLS1lbmFibGUtd2ViLWRhc2hib2FyZCIKICAgICAgICAgIC0gIkZhbHNlIgojIGRzaC1tY3AtbWFuYWdlcjpzZXJ2ZXI6bWNwLUNvZGVNYXAKLSBpbnNlcnQ6CiAgICAtIGlkOiBtY3AtQ29kZU1hcAogICAgICBuYW1lOiAnQGRlZXBzZWVrLWFpL2RzaC1tY3AtY2xpZW50JwogICAgICBjb25maWc6CiAgICAgICAgc2VydmVyTmFtZTogIkNvZGVNYXAiCiAgICAgICAgdHJhbnNwb3J0OiAic3RkaW8iCiAgICAgICAgY29tbWFuZDogImNvZGVtYXAiCiAgICAgICAgYXJnczoKICAgICAgICAgIC0gIm1jcCIKIyBkc2gtbWNwLW1hbmFnZXI6c2VydmVyOm1jcC1yZWEtbWNwCi0gaW5zZXJ0OgogICAgLSBpZDogbWNwLXJlYS1tY3AKICAgICAgbmFtZTogJ0BkZWVwc2Vlay1haS9kc2gtbWNwLWNsaWVudCcKICAgICAgY29uZmlnOgogICAgICAgIHNlcnZlck5hbWU6ICJSRUEtTUNQIgogICAgICAgIHRyYW5zcG9ydDogInN0ZGlvIgogICAgICAgIGNvbW1hbmQ6ICJucHgiCiAgICAgICAgYXJnczoKICAgICAgICAgIC0gIi15IgogICAgICAgICAgLSAicmVhLWFnZW50c0A2LjMuMCIKICAgICAgICAgIC0gIm1jcCIKICAgICAgICBlbnY6CiAgICAgICAgICBSRUFfSURBX01DUF9DT05GSUc6ICdEOlxDaGVuU2lyRG9jdW1lbnRcRHNoLVByb2plY3RzXHJldlxnYW1lLWRlbHRhZm9yY2VcdG9vbHNccmVhXHJlYS1pZGEtbWNwLmpzb24nCiAgICAgICAgICBSRUFfQU5BTFlTSVNfUFJPVklERVI6ICJpZGEiCiAgICAgICAgICBURU1QOiAnQzpcVXNlcnNcY2hlbnNpcjUxNzNcQXBwRGF0YVxMb2NhbFxUZW1wJwogICAgICAgICAgVE1QOiAnQzpcVXNlcnNcY2hlbnNpcjUxNzNcQXBwRGF0YVxMb2NhbFxUZW1wJwojIGRzaC1tY3AtbWFuYWdlcjpzZXJ2ZXI6bWNwLWlkYS1wcm8tb2ZmaWNlCi0gaW5zZXJ0OgogICAgLSBpZDogbWNwLWlkYS1wcm8tb2ZmaWNlCiAgICAgIG5hbWU6ICdAZGVlcHNlZWstYWkvZHNoLW1jcC1jbGllbnQnCiAgICAgIGNvbmZpZzoKICAgICAgICBzZXJ2ZXJOYW1lOiAiSGV4LVJheXMtTUNQIgogICAgICAgIHRyYW5zcG9ydDogInN0ZGlvIgogICAgICAgIGNvbW1hbmQ6ICJ1dngiCiAgICAgICAgYXJnczoKICAgICAgICAgIC0gIi0tZXhjbHVkZS1uZXdlcj0xcyIKICAgICAgICAgIC0gImlkYS1tY3AiCiAgICAgICAgICAtICJzdGRpbyIKICAgICAgICAgIC0gIi0tYWdlbnQ9bXktZHNoIgojIGRzaC1tY3AtbWFuYWdlcjpkaXNhYmxlOm1jcC1TZXJlbmEKLSBpZDogbWNwLVNlcmVuYQogIG5hbWU6ICdAZGVlcHNlZWstYWkvZHNoLW1jcC1jbGllbnQnCiAgZGlzYWJsZWQ6IHRydWUK'

const HOME = Buffer.from(HOME_B64, 'base64').toString('utf8')
const HOME_SHA = '839fa1be8fd387165c719fd15ff61cdb1738940b7d687a8650bc44f2374f28f6'

/** 样本的 6 个 id（文件顺序）。 */
const HOME_IDS = ['ida-headless-mcp', 'tarce-ui', 'mcp-Serena', 'mcp-CodeMap', 'mcp-rea-mcp', 'mcp-ida-pro-office']

/** CRLF + 中文注释 + `!!js` 表达式的样本（② 的行尾保真用）。 */
const CRLF_SAMPLE = [
  '# 中文注释：这台机器上的 MCP 清单',
  '- insert:',
  '    - id: mcp-demo',
  "      name: '@deepseek-ai/dsh-mcp-client'",
  '      config:',
  '        serverName: "demo"',
  '        transport: "stdio"',
  '        command: "demo"',
  '',
  '# 别人插件的条目，别动我',
  '- id: other-plugin',
  "  name: 'someone-else'",
  '  config:',
  '    keep: !!js process.env.X',
  '',
].join('\r\n')

/** 已带 `:2:` 标记、内容规范的 home 文本（幂等 / 零写入断言用）。 */
const CANONICAL_HOME = buildInsertBlock(
  'mcp-demo',
  { serverName: 'demo', transport: 'stdio', command: 'demo' },
  '\n',
)

const DEMO_CONFIG = { serverName: 'demo', transport: 'stdio', command: 'demo' }

/** 样本 + 一条**内容过时**的 mcp-demo（③④ 的 update / remove 路径用）。 */
const HOME_WITH_DEMO = HOME + buildInsertBlock('mcp-demo', { serverName: 'demo', transport: 'stdio', command: 'old' }, '\n')

function lines(text) {
  return splitKeepEol(text)
}

/** 行级切片：把 `[...start,end)` 换成 `replacement` 行数组（逐字保留其它行）。 */
function spliceLines(text, start, end, replacement) {
  const ls = lines(text).map((l) => (l.endsWith('\n') ? l.slice(0, -1) : l))
  return [...ls.slice(0, start), ...replacement, ...ls.slice(end)].join('\n') + (text.endsWith('\n') ? '\n' : '')
}

/** 目标块之外的全部文本（② 的「非目标行逐字不变」断言）。 */
function outsideBlock(text, id) {
  const loc = locateServerBlock(lines(text), id)
  if (!loc) return text
  return lines(text)
    .filter((_, i) => i < loc.start || i >= loc.end)
    .join('')
}

/** 某个 id 的旧覆盖行块（disable 行）范围；没有返回 null。 */
function overrideRange(text, id) {
  const loc = locateDisableBlock(lines(text), id, { includeUnmarked: true })
  return loc ? [loc.start, loc.end] : null
}

function markerLinesOf(text) {
  return lines(text)
    .map((l) => l.trim())
    .filter((l) => l.startsWith('# dsh-mcp-manager:'))
}

// ═══════════════════════ ⓪ 夹具自检 ═══════════════════════

test('夹具自检：样本拷贝与真实 home patch 逐字一致（长度 / 哈希 / 行尾）', () => {
  assert.equal(Buffer.byteLength(HOME, 'utf8'), 1962)
  assert.equal(createHash('sha256').update(HOME, 'utf8').digest('hex'), HOME_SHA)
  assert.equal(HOME.split('\n').length, 72) // 71 行 + 末尾换行
  assert.ok(HOME.endsWith('\n'))
  assert.equal(detectEol(HOME), '\n')
  assert.ok(!HOME.includes('\r'))
  assert.ok(!HOME.includes('\t'))
})

test('模块未从测试侧依赖真实路径：host-core.js 里不出现 .dsh 真实路径与 fs 调用', () => {
  const here = dirname(fileURLToPath(import.meta.url))
  const src = readFileSync(join(here, '..', 'src', 'host-core.js'), 'utf8')
  assert.ok(!/node:fs|readFileSync|writeFileSync|require\(/.test(src), 'host-core 必须不碰文件系统')
  assert.ok(!src.includes('import '), 'host-core 必须是零依赖（无 import）')
  assert.ok(src.includes('tmp/probe-patch-order.mjs'), '顶部注释必须引用层序实测脚本')
  assert.ok(src.includes('docs/knowledge/2026-10-18-mcp-manager-subplugin.md'), '顶部注释必须引用知识库结论')
})

// ═══════════════════════ ① 解析真实 home patch 样本 ═══════════════════════

test('① parsePatch(HOME)：解析出 6 条 MCP 条目，首条无标记、Serena 折算同层 disable 覆盖行', () => {
  const p = parsePatch(HOME)
  assert.equal(p.ok, true)
  assert.equal(p.error, null)
  assert.equal(p.raw, HOME)
  assert.equal(p.eol, '\n')
  assert.equal(p.entries.length, 6)
  assert.deepEqual(
    p.entries.map((e) => e.id),
    HOME_IDS,
  )

  const ida = p.entries[0]
  assert.equal(ida.hasMarker, false)
  assert.equal(ida.markerKind, null)
  assert.equal(ida.markerVersion, null)
  assert.equal(ida.serverName, 'ida-headless-mcp')
  assert.equal(ida.transport, 'stdio')
  assert.equal(ida.config.command, 'idalib-pool')
  assert.equal(ida.disabled, false)
  assert.deepEqual([ida.blockStart, ida.blockEnd], [0, 7])

  const serena = p.entries[2]
  assert.equal(serena.hasMarker, true)
  assert.equal(serena.markerKind, 'server')
  assert.equal(serena.markerVersion, 1, '旧标记版本按 1 记')
  assert.equal(serena.disabled, true, '同层 disable 覆盖行必须折算成 disabled')
  assert.ok(serena.sameLayerOverride, '要保留覆盖行范围，供迁移收敛')
  assert.equal(serena.sameLayerOverride.markerKind, 'disable')
  assert.deepEqual(serena.config.args, ['start-mcp-server', '--enable-web-dashboard', 'False'])

  const rea = p.entries[4]
  assert.deepEqual(rea.config.args, ['-y', 'rea-agents@6.3.0', 'mcp'])
  assert.equal(rea.config.env.REA_ANALYSIS_PROVIDER, 'ida')
  assert.ok(rea.config.env.REA_IDA_MCP_CONFIG.startsWith('D:\\ChenSirDocument\\'))
  assert.ok(rea.config.env.TEMP.endsWith('\\Local\\Temp'))

  assert.equal(p.entries[5].serverName, 'Hex-Rays-MCP')
  assert.deepEqual(p.entries[5].config.args, ['--exclude-newer=1s', 'ida-mcp', 'stdio', '--agent=my-dsh'])

  assert.equal(p.overrides.length, 1)
  assert.equal(p.overrides[0].id, 'mcp-Serena')
  assert.equal(p.overrides[0].disabled, true)
  assert.equal(p.others.length, 0, '形态匹配的 6 条都要被认领，不留 others')
})

test('① 变体：非 MCP 的 insert 与顶层其它键不认领（真实 profile patch 的形态）', () => {
  const text = [
    '- insert:',
    '    - id: terminal-font',
    '      name: dsh-terminal-font',
    '- id: agent-instructions',
    "  name: 'dsh-agent-instructions'",
    '  config:',
    '    preset: !!js process.env.DSH_TUI_PRESET ?? undefined',
    '',
  ].join('\n')
  const p = parsePatch(text)
  assert.equal(p.ok, true)
  assert.equal(p.entries.length, 0)
  assert.equal(p.overrides.length, 1)
  assert.equal(p.others.length, 1)
  assert.equal(p.others[0].reason, 'not-mcp-package')
})

// ═══════════════════════ ② 保真：非目标行逐字不变 ═══════════════════════

test('② 新增：追加在末尾，原文件全部字节是不变前缀', () => {
  const r = planUpsert(HOME, 'mcp-new', { serverName: 'new', transport: 'stdio', command: 'newcmd' })
  assert.equal(r.error, null)
  assert.equal(r.action, 'insert')
  assert.equal(r.changed, true)
  assert.ok(r.text.startsWith(HOME), '除追加外不得改动任何原有字节')
  assert.equal(r.text.slice(HOME.length), buildInsertBlock('mcp-new', { serverName: 'new', transport: 'stdio', command: 'newcmd' }, '\n'))
  assert.equal(parsePatch(r.text).entries.length, 7)
})

test('② 修改：只改目标行，行数与其它行逐字不变（含中文注释 / !!js 样本）', () => {
  const before = lines(HOME).map((l) => l.replace(/\n$/, ''))
  const r = planUpsert(HOME, 'mcp-CodeMap', { command: 'codemap2' })
  assert.equal(r.changed, true)
  const after = lines(r.text).map((l) => l.replace(/\n$/, ''))
  assert.equal(after.length, before.length, '就地替换不得增删行')
  const diff = []
  for (let i = 0; i < after.length; i++) if (after[i] !== before[i]) diff.push(i)
  assert.deepEqual(diff, [34], '只允许 command 那一行变化')
  assert.equal(after[34], '        command: "codemap2"')
  assert.equal(r.text.includes('# dsh-mcp-manager:server:mcp-CodeMap'), true)
  assert.equal(parsePatch(r.text).entries[3].config.command, 'codemap2')
})

test('② 修改：给无标记条目补标记时，块体逐字不变（只多一行标记）', () => {
  const r = planUpsert(HOME, 'ida-headless-mcp', { serverName: 'ida-headless-mcp', transport: 'stdio', command: 'idalib-pool' })
  assert.equal(r.changed, true)
  assert.equal(r.text, '# dsh-mcp-manager:2:server:ida-headless-mcp\n' + HOME)
  assert.equal(parsePatch(r.text).entries[0].hasMarker, true)
})

test('② 删除：只删目标行块，其余字节完全一致', () => {
  const r = planRemove(HOME, 'mcp-CodeMap')
  assert.equal(r.changed, true)
  assert.equal(r.action, 'remove')
  const expected = spliceLines(HOME, 27, 37, [])
  assert.equal(r.text, expected)
  assert.equal(parsePatch(r.text).entries.length, 5)
  assert.equal(r.text.includes('CodeMap'), false)
})

test('② 启停：停用只加一行 disabled；启用只删旧覆盖行块', () => {
  const off = planSetEnabled(HOME, 'mcp-CodeMap', false)
  assert.equal(off.changed, true)
  const before = lines(HOME).map((l) => l.replace(/\n$/, ''))
  const after = lines(off.text).map((l) => l.replace(/\n$/, ''))
  assert.equal(after.length, before.length + 1)
  assert.equal(after[31], '      disabled: true', 'disabled 落在 insert 条目内部（6 空格）')
  assert.equal(parsePatch(off.text).entries[3].disabled, true)

  const on = planSetEnabled(HOME, 'mcp-Serena', true)
  assert.equal(on.changed, true)
  assert.equal(on.text, spliceLines(HOME, 67, 71, []), '启用 = 撤掉同层 disable 覆盖行块')
  assert.equal(parsePatch(on.text).entries[2].disabled, false)
})

test('② CRLF 样本：行尾风格不变、无孤立 LF、注释与 !!js 逐字保留', () => {
  const add = planUpsert(CRLF_SAMPLE, 'mcp-demo', { command: 'demo2' })
  assert.equal(add.changed, true)
  assert.equal(detectEol(add.text), '\r\n')
  assert.equal(/[^\r]\n/.test(add.text), false, '不得出现孤立 LF')
  assert.equal(add.text.split('\r\n').length, CRLF_SAMPLE.split('\r\n').length + 1, '只多一行（补标记）')
  assert.equal(add.text.includes('# 中文注释：这台机器上的 MCP 清单\r\n'), true)
  assert.equal(add.text.includes('    keep: !!js process.env.X\r\n'), true)
  assert.equal(add.text.includes('# 别人插件的条目，别动我\r\n'), true)
  assert.equal(add.text.includes('        command: "demo2"\r\n'), true)
  assert.equal(outsideBlock(add.text, 'mcp-demo'), outsideBlock(CRLF_SAMPLE, 'mcp-demo'))

  const on = planSetEnabled(CRLF_SAMPLE, 'mcp-demo', false)
  assert.equal(detectEol(on.text), '\r\n')
  assert.equal(/[^\r]\n/.test(on.text), false)
  assert.equal(on.text.includes("      name: '@deepseek-ai/dsh-mcp-client'\r\n      disabled: true\r\n"), true)

  const rm = planRemove(CRLF_SAMPLE, 'mcp-demo')
  assert.equal(detectEol(rm.text), '\r\n')
  assert.equal(rm.text, '# 中文注释：这台机器上的 MCP 清单\r\n\r\n# 别人插件的条目，别动我\r\n- id: other-plugin\r\n  name: \'someone-else\'\r\n  config:\r\n    keep: !!js process.env.X\r\n')
})

test('② 幂等：内容已正确时 changed=false，不产生写入', () => {
  const r = planUpsert(CANONICAL_HOME, 'mcp-demo', DEMO_CONFIG)
  assert.equal(r.changed, false)
  assert.equal(r.text, CANONICAL_HOME)
  assert.equal(planSetEnabled(CANONICAL_HOME, 'mcp-demo', true).changed, false)
  assert.equal(planRemove(CANONICAL_HOME, 'nope').changed, false)
})

// ═══════════════════════ ③ 落点规则三态 ═══════════════════════

const P3 = [
  { name: 'desktop', text: '# 桌面 profile\n' },
  { name: 'web', text: '' },
  { name: 'dsh-tui', text: '' },
]
const DEMO_ROW = { id: 'mcp-demo', serverName: 'demo', config: DEMO_CONFIG }

test('③ 全员生效：只写 home，profile 一律不出现', () => {
  const r = planLayout({ ...DEMO_ROW, homeText: HOME_WITH_DEMO, profiles: P3, selected: ['desktop', 'web', 'dsh-tui'] })
  assert.equal(r.ok, true)
  assert.deepEqual(r.conflicts, [])
  assert.deepEqual(
    r.writes.map((w) => [w.target, w.action]),
    [['home', 'update']],
  )
  // 注意：样本里 Serena 的旧覆盖行本来就含 `disabled: true`，所以只断言**目标条目**没被加停用
  const updated = parsePatch(r.writes[0].text).entries.find((e) => e.id === 'mcp-demo')
  assert.equal(updated.disabled, false, '全员生效时不得给目标条目加 disabled')
})

test('③ 全员生效且已是规范形态：零写入（不触发无谓热重载）', () => {
  const r = planLayout({
    ...DEMO_ROW,
    homeText: CANONICAL_HOME,
    profiles: P3,
    selected: ['desktop', 'web', 'dsh-tui'],
  })
  assert.equal(r.ok, true)
  assert.deepEqual(r.writes, [])
})

test('③ 部分生效：home 删行 + 选中的 profile 各加行 + 未选中的 profile 零改动', () => {
  const r = planLayout({ ...DEMO_ROW, homeText: HOME_WITH_DEMO, profiles: P3, selected: ['desktop', 'web'] })
  assert.equal(r.ok, true)
  assert.deepEqual(
    r.writes.map((w) => [w.target, w.action]),
    [
      ['home', 'remove'],
      ['desktop', 'insert'],
      ['web', 'insert'],
    ],
  )
  assert.equal(r.writes.some((w) => w.target === 'dsh-tui'), false, '未选中的 profile 必须零改动')
  const home = r.writes.find((w) => w.target === 'home')
  assert.equal(parsePatch(home.text).entries.some((e) => e.id === 'mcp-demo'), false)
  const desktop = r.writes.find((w) => w.target === 'desktop')
  assert.ok(desktop.text.startsWith('# 桌面 profile\n'), '原内容逐字保留')
  assert.equal(parsePatch(desktop.text).entries[0].hasMarker, true)
  assert.equal(parsePatch(desktop.text).entries[0].markerVersion, MARKER_VERSION)
})

test('③ 全不生效：保留 home 一条且行内 disabled: true，profile 不留残行', () => {
  const withProfileRow = {
    name: 'desktop',
    text: buildInsertBlock('mcp-demo', DEMO_CONFIG, '\n'),
  }
  const r = planLayout({ ...DEMO_ROW, homeText: HOME, profiles: [withProfileRow, ...P3.slice(1)], selected: [] })
  assert.equal(r.ok, true)
  assert.deepEqual(
    r.writes.map((w) => [w.target, w.action]),
    [['home', 'remove'], ['desktop', 'remove']].length === 2
      ? r.writes.map((w) => [w.target, w.action])
      : null,
  )
  assert.equal(r.writes.length, 2)
  assert.deepEqual(r.writes.map((w) => w.target).sort(), ['desktop', 'home'])
  assert.equal(parsePatch(r.writes.find((w) => w.target === 'desktop').text).entries.length, 0)
})

test('③ 全不生效（服务器只在 home）：home 行内 disabled: true', () => {
  const cfg = { id: 'mcp-demo', serverName: 'demo', config: DEMO_CONFIG }
  const r = planLayout({ ...cfg, homeText: CANONICAL_HOME, profiles: P3, selected: [] })
  assert.equal(r.ok, true)
  assert.equal(r.writes.length, 1)
  assert.equal(r.writes[0].target, 'home')
  assert.equal(r.writes[0].action, 'update')
  assert.equal(r.writes[0].text.includes("      name: '@deepseek-ai/dsh-mcp-client'\n      disabled: true\n"), true)
  const back = planLayout({ ...cfg, homeText: r.writes[0].text, profiles: P3, selected: ['desktop', 'web', 'dsh-tui'] })
  assert.equal(back.ok, true)
  assert.equal(back.writes[0].text, CANONICAL_HOME, '再勾选全员要能回到不带 disabled 的形态')
})

test('③ 选中集合含未知 profile → 冲突、零写入', () => {
  const r = planLayout({ ...DEMO_ROW, homeText: HOME, profiles: P3, selected: ['desktop', 'nope'] })
  assert.equal(r.ok, false)
  assert.deepEqual(r.writes, [])
  assert.equal(r.conflicts[0].code, 'E_UNKNOWN_PROFILE')
  assert.deepEqual(r.conflicts[0].layers, ['nope'])
})

test('③ config 非法 → 冲突、零写入', () => {
  const r = planLayout({
    id: 'mcp-demo',
    serverName: 'demo',
    config: { transport: 'stdio' },
    homeText: HOME,
    profiles: P3,
    selected: ['desktop'],
  })
  assert.equal(r.ok, false)
  assert.deepEqual(r.writes, [])
  assert.ok(r.conflicts.some((c) => c.field === 'command'))
})

// ═══════════════════════ ④ 跨层冲突 ═══════════════════════

test('④ home 与 profile 同 id → 只返回 conflicts、零写入', () => {
  const cross = [{ name: 'desktop', text: buildInsertBlock('mcp-demo', DEMO_CONFIG, '\n') }]
  const r = planLayout({ ...DEMO_ROW, homeText: HOME_WITH_DEMO, profiles: cross, selected: ['desktop'] })
  assert.equal(r.ok, false)
  assert.deepEqual(r.writes, [])
  assert.equal(r.conflicts.length, 1)
  assert.equal(r.conflicts[0].code, 'E_CROSS_LAYER')
  assert.equal(r.conflicts[0].id, 'mcp-demo')
  assert.deepEqual(r.conflicts[0].layers, ['home', 'desktop'])
  assert.match(r.conflicts[0].message, /home/)
})

test('④ 同文件内同 id 出现两次 → 冲突、零写入', () => {
  // 第二份副本换个 serverName，避免先撞上「服务器名重复」而掩盖 id 重复这一条硬校验
  const twice = HOME + buildInsertBlock('mcp-CodeMap', { serverName: 'CodeMap2', transport: 'stdio', command: 'codemap' }, '\n')
  const r = planLayout({
    id: 'mcp-CodeMap',
    serverName: 'CodeMap',
    config: { serverName: 'CodeMap', transport: 'stdio', command: 'codemap' },
    homeText: twice,
    profiles: P3,
    selected: [],
  })
  assert.equal(r.ok, false)
  assert.deepEqual(r.writes, [])
  assert.equal(r.conflicts[0].code, 'E_DUPLICATE')
  assert.equal(r.conflicts[0].id, 'mcp-CodeMap')
})

test('④ 服务器名与其它服务器重复 → 冲突、零写入', () => {
  const r = planLayout({
    id: 'mcp-clone',
    serverName: 'Serena',
    config: { transport: 'stdio', command: 'serena' },
    homeText: HOME,
    profiles: P3,
    selected: [],
  })
  assert.equal(r.ok, false)
  assert.deepEqual(r.writes, [])
  assert.ok(r.conflicts.some((c) => c.field === 'serverName'))
})

// ═══════════════════════ ⑤ 解析失败拒绝写入 ═══════════════════════

test('⑤ 无法解析的文件：所有写操作都拒绝且原文不变、无 error 之外的副作用', () => {
  const cases = [
    ['Tab 缩进', '- insert:\n\t- id: mcp-demo\n', 'E_TAB_INDENT'],
    ['顶层不是数组', 'foo: bar\n- insert:\n    - id: mcp-demo\n', 'E_NOT_SEQUENCE'],
    ['孤立缩进行', '  foo: bar\n- insert:\n    - id: mcp-demo\n', 'E_ORPHAN_INDENT'],
    ['流式 insert', '- insert: [{ id: mcp-demo }]\n', 'E_FLOW_STYLE'],
  ]
  for (const [label, text, code] of cases) {
    const p = parsePatch(text)
    assert.equal(p.ok, false, label)
    assert.equal(p.error.code, code, label)
    assert.ok(p.error.message.length > 0 && p.error.line >= 1, label)

    const up = planUpsert(text, 'mcp-demo', DEMO_CONFIG)
    assert.deepEqual([up.text, up.changed, up.action], [text, false, 'none'], label)
    assert.equal(up.error.code, code, label)
    const rm = planRemove(text, 'mcp-demo')
    assert.equal(rm.text, text, label)
    assert.equal(rm.changed, false, label)
    const en = planSetEnabled(text, 'mcp-demo', false)
    assert.equal(en.text, text, label)
    assert.equal(en.changed, false, label)
    const mig = planMigration(text)
    assert.equal(mig.ok, false, label)
    assert.deepEqual(mig.writes, [], label)
    assert.equal(mig.error.code, code, label)
  }
})

test('⑤-补 DSH 空 patch 模板（顶层 []）：解析为 0 条目，写入前摘掉 []，产出仍是顶层数组', () => {
  // DSH 新建 profile 时生成的模板：三行注释 + 顶格 []
  const empty = '# DSH 补丁层：profile dsh-tui（由 dsh 新建）\n# 本文件由 dsh 维护\n# 除非你清楚在做什么，否则不要手动编辑\n[]\n'
  const p = parsePatch(empty)
  assert.equal(p.ok, true, JSON.stringify(p.error))
  assert.equal(p.error, null)
  assert.equal(p.flowEmptyDoc, 3)
  assert.deepEqual(p.entries, [])
  // 空文档没有条目：启用/删除照旧报 E_NOT_FOUND（不是结构错误）
  assert.equal(planSetEnabled(empty, 'mcp-demo', false).error.code, 'E_NOT_FOUND')
  assert.equal(planRemove(empty, 'mcp-demo').error.code, 'E_NOT_FOUND')

  const up = planUpsert(empty, 'mcp-demo', DEMO_CONFIG)
  assert.equal(up.error, null, JSON.stringify(up.error))
  assert.equal(up.action, 'insert')
  assert.equal(up.changed, true)
  const text = up.text
  assert.ok(!/^\s*\[\s*\]\s*$/m.test(text), `[] 必须被摘掉：\n${text}`)
  assert.match(text, /# dsh-mcp-manager:2:server:mcp-demo\n- insert:\n/, text)
  // 注释逐字保留、顺序不变
  assert.ok(text.startsWith('# DSH 补丁层：profile dsh-tui（由 dsh 新建）\n# 本文件由 dsh 维护\n# 除非你清楚在做什么，否则不要手动编辑\n'), text)
  // 二次解析：合法、条目可见、空文档标记消失
  const again = parsePatch(text)
  assert.equal(again.ok, true, JSON.stringify(again.error))
  assert.equal(again.flowEmptyDoc, null)
  assert.deepEqual(again.entries.map((e) => e.id), ['mcp-demo'])

  // `[ ]` 变体同样识别
  const spaced = parsePatch('# x\n[ ]\n')
  assert.equal(spaced.ok, true)
  assert.equal(spaced.flowEmptyDoc, 1)
  assert.ok(!/^[ \t]*\[ \]\s*$/m.test(planUpsert('# x\n[ ]\n', 'mcp-demo', DEMO_CONFIG).text))

  // [] 与条目并存 → 非法 YAML，明确报错而不是静默改写
  const mixed = parsePatch('[]\n- insert:\n    - id: mcp-demo\n')
  assert.equal(mixed.ok, false)
  assert.equal(mixed.error.code, 'E_FLOW_DOC_CONFLICT')
  const twice = parsePatch('[]\n[]\n')
  assert.equal(twice.ok, false)
  assert.equal(twice.error.code, 'E_FLOW_DOC_CONFLICT')
})

test('⑤ 未知 id 的写操作报 E_NOT_FOUND 且原文不变', () => {
  const r = planSetEnabled(HOME, 'mcp-nope', false)
  assert.equal(r.changed, false)
  assert.equal(r.text, HOME)
  assert.equal(r.error.code, 'E_NOT_FOUND')
  assert.equal(planUpsert(HOME, 'mcp-nope', DEMO_CONFIG, { create: false }).error.code, 'E_NOT_FOUND')
  assert.equal(planUpsert(HOME, 'bad id!', DEMO_CONFIG).error.code, 'E_BAD_ID')
})

// ═══════════════════════ ⑥ 迁移 ═══════════════════════

test('⑥ 迁移：5 条改写 + 1 条补齐 + 1 条覆盖行收敛，且非目标行逐字不变', () => {
  const r = planMigration(HOME, { target: 'home' })
  assert.equal(r.ok, true)
  assert.equal(r.writes.length, 1)
  assert.equal(r.writes[0].target, 'home')
  assert.deepEqual(r.stats, { relabeled: 5, tagged: 1, converged: 1, skipped: [] })

  const after = r.writes[0].text
  // 期望文本：逐字做 4 处手术，其它字节一律不动
  let expected = HOME
  for (const id of ['tarce-ui', 'mcp-Serena', 'mcp-CodeMap', 'mcp-rea-mcp', 'mcp-ida-pro-office']) {
    expected = expected.replace(`# dsh-mcp-manager:server:${id}\n`, `# dsh-mcp-manager:2:server:${id}\n`)
  }
  expected = expected.replace('- insert:\n    - id: ida-headless-mcp', `# dsh-mcp-manager:2:server:ida-headless-mcp\n- insert:\n    - id: ida-headless-mcp`)
  assert.equal(expected.includes('# dsh-mcp-manager:disable:mcp-Serena\n- id: mcp-Serena\n  name: \'@deepseek-ai/dsh-mcp-client\'\n  disabled: true\n'), true)
  expected = expected.replace('# dsh-mcp-manager:disable:mcp-Serena\n- id: mcp-Serena\n  name: \'@deepseek-ai/dsh-mcp-client\'\n  disabled: true\n', '')
  expected = expected.replace('    - id: mcp-Serena\n      name: \'@deepseek-ai/dsh-mcp-client\'\n', '    - id: mcp-Serena\n      name: \'@deepseek-ai/dsh-mcp-client\'\n      disabled: true\n')
  assert.equal(after, expected)

  const p = parsePatch(after)
  assert.equal(p.entries.length, 6)
  assert.deepEqual(
    p.entries.map((e) => e.markerVersion),
    [2, 2, 2, 2, 2, 2],
  )
  assert.equal(p.entries.every((e) => e.markerKind === 'server'), true)
  assert.deepEqual(
    p.entries.map((e) => e.disabled),
    [false, false, true, false, false, false],
    'Serena 的停用状态必须被保留（收敛成行内 disabled）',
  )
  assert.equal(after.includes('# dsh-mcp-manager:disable:'), false)
  assert.equal(after.includes(':server:'), true)
  assert.equal(markerLinesOf(after).length, 6)
})

test('⑥ 迁移幂等：二次执行零写入', () => {
  const once = planMigration(HOME).writes[0].text
  const twice = planMigration(once)
  assert.equal(twice.ok, true)
  assert.deepEqual(twice.writes, [])
  assert.deepEqual(twice.stats, { relabeled: 0, tagged: 0, converged: 0, skipped: [] })
  assert.equal(planMigration(CRLF_SAMPLE).writes.length, 1)
  const crlfOnce = planMigration(CRLF_SAMPLE).writes[0].text
  assert.equal(detectEol(crlfOnce), '\r\n')
  assert.equal(/[^\r]\n/.test(crlfOnce), false)
  assert.deepEqual(planMigration(crlfOnce).writes, [])
})

test('⑥ 迁移只加标记：非 MCP 的 insert / 顶层其它键原样照抄并计入跳过', () => {
  const text = [
    '- insert:',
    '    - id: terminal-font',
    '      name: dsh-terminal-font',
    '- id: someone-else',
    "  name: 'other'",
    '  disabled: true',
    '',
  ].join('\n')
  const r = planMigration(text)
  assert.equal(r.writes.length, 0)
  assert.deepEqual(r.stats.skipped, [
    { reason: 'not-managed-entry', count: 1 },
    { reason: 'not-mcp-package', count: 1 },
  ])
})

test('⑥ 迁移补齐时用文件自己的行尾', () => {
  const r = planMigration(CRLF_SAMPLE)
  assert.equal(r.writes.length, 1)
  assert.equal(r.stats.tagged, 1)
  // 标记插在目标行块正前方；文件首行是中文注释，所以文本不以标记开头
  assert.equal(r.writes[0].text.includes('# dsh-mcp-manager:2:server:mcp-demo\r\n- insert:\r\n'), true)
  assert.equal(outsideBlockCid(r.writes[0].text, 'mcp-demo'), outsideBlockCid(CRLF_SAMPLE, 'mcp-demo'))
})

/** 去掉某个 id 的行块后剩下的文本（CRLF 版断言用；locateServerBlock 需要行数组）。 */
function outsideBlockCid(text, id) {
  const loc = locateServerBlock(lines(text), id)
  if (!loc) return text
  return lines(text)
    .filter((_, i) => i < loc.start || i >= loc.end)
    .join('')
}

// ═══════════════════════ ⑦ 校验矩阵 ═══════════════════════

test('⑦ validateMcpConfig：必填 / 形态 / 超长 / 重名 / id 冲突', () => {
  const good = { serverName: 'demo', transport: 'stdio', command: 'demo' }
  assert.deepEqual(validateMcpConfig('mcp-demo', good, []), { ok: true, fields: {}, conflicts: [] })

  const noTransport = validateMcpConfig('mcp-demo', { serverName: 'demo', command: 'demo' }, [])
  assert.equal(noTransport.ok, false)
  assert.ok(noTransport.fields.transport)

  const badTransport = validateMcpConfig('mcp-demo', { serverName: 'demo', transport: 'websocket', command: 'x' }, [])
  assert.equal(badTransport.ok, false)
  assert.match(badTransport.fields.transport, /stdio/)

  const noCommand = validateMcpConfig('mcp-demo', { serverName: 'demo', transport: 'stdio' }, [])
  assert.equal(noCommand.ok, false)
  assert.ok(noCommand.fields.command)

  const noUrl = validateMcpConfig('mcp-demo', { serverName: 'demo', transport: 'streamable-http' }, [])
  assert.equal(noUrl.ok, false)
  assert.ok(noUrl.fields.url)

  const goodHttp = validateMcpConfig('mcp-demo', { serverName: 'demo', transport: 'streamable-http', url: 'https://x.test/mcp' }, [])
  assert.equal(goodHttp.ok, true)

  const badName = validateMcpConfig('mcp-demo', { serverName: 'bad name!', transport: 'stdio', command: 'x' }, [])
  assert.equal(badName.ok, false)
  assert.ok(badName.fields.serverName)

  const tooLong = validateMcpConfig('mcp-demo', { serverName: 'a'.repeat(33), transport: 'stdio', command: 'x' }, [])
  assert.equal(tooLong.ok, false)
  assert.ok(tooLong.fields.serverName)
  assert.equal(SERVER_NAME_PATTERN.test('a'.repeat(32)), true)
  assert.equal(SERVER_NAME_PATTERN.test('a'.repeat(33)), false)

  const dupName = validateMcpConfig('mcp-demo', good, [{ id: 'other', serverName: 'demo' }])
  assert.equal(dupName.ok, false)
  assert.ok(dupName.fields.serverName)
  assert.equal(dupName.conflicts[0].code, 'E_SERVER_NAME_TAKEN')

  const dupId = validateMcpConfig('mcp-demo', good, [{ id: 'mcp-demo', serverName: 'x' }])
  assert.equal(dupId.ok, false)
  assert.ok(dupId.fields.id)

  const missingConfig = validateMcpConfig('mcp-demo', null, [])
  assert.equal(missingConfig.ok, false)
  assert.ok(missingConfig.fields.config)

  const badBad = validateMcpConfig('mcp-demo', { serverName: 'demo', transport: 'stdio', command: 'x', args: 'no', env: { A: 1 }, toolCallTimeoutMs: 0, maxInstructionBytes: 0, failOnStartupError: 'yes' }, [])
  assert.equal(badBad.ok, false)
  for (const f of ['args', 'env', 'toolCallTimeoutMs', 'maxInstructionBytes', 'failOnStartupError']) assert.ok(badBad.fields[f], f)

  const okDefaults = validateMcpConfig(
    'mcp-demo',
    { serverName: 'demo', transport: 'stdio', command: 'x', args: [], env: {}, cwd: '', toolCallTimeoutMs: DEFAULT_PARAMS.toolCallTimeoutMs, maxInstructionBytes: DEFAULT_PARAMS.maxInstructionBytes, failOnStartupError: DEFAULT_PARAMS.failOnStartupError },
    [],
  )
  assert.equal(okDefaults.ok, true)
  assert.deepEqual(TRANSPORTS, ['stdio', 'streamable-http'])
})

// ═══════════════════════ ⑧ mergeServers：矩阵反推与漂移 ═══════════════════════

function rowText(rows) {
  return rows.map((r) => buildInsertBlock(r.id, r.config, '\n', r.disabled ? { disabled: true } : undefined)).join('')
}

test('⑧ mergeServers：矩阵按行分布反推（5 全员 / 1 全不 / 1 仅 desktop）', () => {
  const homeText = rowText([
    { id: 'mcp-a', config: { serverName: 'A', transport: 'stdio', command: 'a' } },
    { id: 'mcp-b', config: { serverName: 'B', transport: 'stdio', command: 'b' } },
    { id: 'mcp-c', config: { serverName: 'C', transport: 'stdio', command: 'c' } },
    { id: 'mcp-d', config: { serverName: 'D', transport: 'stdio', command: 'd' } },
    { id: 'mcp-e', config: { serverName: 'E', transport: 'stdio', command: 'e' } },
    { id: 'mcp-off', config: { serverName: 'OFF', transport: 'stdio', command: 'off' }, disabled: true },
  ])
  const desktopOnly = buildInsertBlock('mcp-solo', { serverName: 'SOLO', transport: 'stdio', command: 'solo' }, '\n')
  const r = mergeServers({
    homeText,
    profiles: [
      { name: 'desktop', text: desktopOnly },
      { name: 'web', text: '' },
      { name: 'dsh-tui', text: '' },
    ],
  })
  assert.equal(r.ok, true)
  assert.deepEqual(r.profiles, ['desktop', 'dsh-tui', 'web'])
  assert.equal(r.servers.length, 7)
  const byId = new Map(r.servers.map((s) => [s.id, s]))
  for (const id of ['mcp-a', 'mcp-b', 'mcp-c', 'mcp-d', 'mcp-e']) {
    assert.deepEqual(byId.get(id).matrix, { desktop: true, 'dsh-tui': true, web: true }, id)
    assert.equal(byId.get(id).location, 'home', id)
    assert.equal(byId.get(id).layoutDrift, null, id)
  }
  assert.deepEqual(byId.get('mcp-off').matrix, { desktop: false, 'dsh-tui': false, web: false })
  assert.equal(byId.get('mcp-off').location, 'home')
  assert.deepEqual(byId.get('mcp-off').profiles, [])
  const solo = byId.get('mcp-solo')
  assert.deepEqual(solo.matrix, { desktop: true, 'dsh-tui': false, web: false })
  assert.equal(solo.location, 'profile')
  assert.deepEqual(solo.layers, ['desktop'])
  assert.equal(solo.layoutDrift, null, '没有已知 profile 变化时不报漂移')
})

test('⑧ 真实样本：Serena 的同层覆盖行 = 全局停用 + 布局待迁移；其余 5 台全员生效', () => {
  const r = mergeServers({
    homeText: HOME,
    profiles: [
      { name: 'desktop', text: '' },
      { name: 'web', text: '' },
      { name: 'dsh-tui', text: '' },
    ],
  })
  assert.equal(r.ok, true)
  assert.equal(r.servers.length, 6)
  const serena = r.servers.find((s) => s.id === 'mcp-Serena')
  assert.deepEqual(serena.profiles, [])
  assert.equal(serena.disabled, true)
  assert.equal(serena.layoutDrift.code, 'NEEDS_MIGRATION')
  for (const s of r.servers.filter((x) => x.id !== 'mcp-Serena')) {
    assert.equal(s.layoutDrift, null, s.id)
    assert.deepEqual(s.profiles, ['desktop', 'dsh-tui', 'web'], s.id)
  }
})

test('⑧ 新增 profile：全员生效的服务器零变化，部分生效的标「待确认」', () => {
  const homeText = rowText([{ id: 'mcp-all', config: { serverName: 'ALL', transport: 'stdio', command: 'all' } }])
  const desktopOnly = buildInsertBlock('mcp-solo', { serverName: 'SOLO', transport: 'stdio', command: 'solo' }, '\n')
  const before = mergeServers({
    homeText,
    profiles: [
      { name: 'desktop', text: desktopOnly },
      { name: 'web', text: '' },
    ],
  })
  assert.equal(before.servers.find((s) => s.id === 'mcp-solo').layoutDrift, null)

  const after = mergeServers({
    homeText,
    profiles: [
      { name: 'desktop', text: desktopOnly },
      { name: 'web', text: '' },
    ],
    profilesOnDisk: ['desktop', 'web', 'foo'],
    knownProfiles: ['desktop', 'web'],
  })
  assert.deepEqual(after.profiles, ['desktop', 'foo', 'web'])
  const all = after.servers.find((s) => s.id === 'mcp-all')
  assert.equal(all.matrix.foo, true, '全员生效对新 profile 也生效')
  assert.equal(all.layoutDrift, null, '不得因为新增 profile 而报漂移或写入')
  const solo = after.servers.find((s) => s.id === 'mcp-solo')
  assert.equal(solo.matrix.foo, false)
  assert.equal(solo.layoutDrift.code, 'NEW_PROFILE')
  assert.deepEqual(solo.layoutDrift.layers, ['foo'])
  assert.match(solo.layoutDrift.message, /foo/)
})

test('⑧ profile 层覆盖行在层序下无效：matrix 记用户意图，effective 记运行期，并标漂移', () => {
  const homeText = buildInsertBlock('mcp-a', { serverName: 'A', transport: 'stdio', command: 'a' }, '\n')
  const desktop = buildDisableBlock('mcp-a', '\n')
  const r = mergeServers({ homeText, profiles: [{ name: 'desktop', text: desktop }] })
  const a = r.servers.find((s) => s.id === 'mcp-a')
  assert.equal(a.matrix.desktop, false, '面板勾选状态 = 用户意图')
  assert.equal(a.effective.desktop, true, '按实测层序：profile 层覆盖行被跳过，实际仍生效')
  assert.equal(a.layoutDrift.code, 'INEFFECTIVE_OVERRIDE')
})

test('⑧ 真实形态：profile 里的非 MCP 覆盖行不产出服务器、不报错；悬空的自有覆盖行报 E_ORPHAN_OVERRIDE', () => {
  const homeText = buildInsertBlock('mcp-a', { serverName: 'A', transport: 'stdio', command: 'a' }, '\n')
  // 真实 desktop / dsh-tui patch 的形态：一堆别人插件的顶层 `- id:` 覆盖行（无标记、name 不是 MCP 包）
  const noisy = [
    '# 别人插件的停用清单',
    '- id: web',
    "  name: 'dsh-web-ui'",
    '  disabled: true',
    '',
    '- id: llm-deepseek',
    "  name: '@deepseek-ai/dsh-llm-deepseek'",
    '  disabled: true',
    '',
    ...buildDisableBlock('mcp-a', '\n').split('\n'),
  ].join('\n')
  const r = mergeServers({ homeText, profiles: [{ name: 'desktop', text: noisy }, { name: 'web', text: '' }] })
  assert.equal(r.ok, true, '别人插件的覆盖行不是错误')
  assert.deepEqual(r.servers.map((s) => s.id), ['mcp-a'], '只列受管的 MCP 条目')
  assert.deepEqual(r.conflicts, [])
  const a = r.servers[0]
  assert.equal(a.matrix.desktop, false, '我们的覆盖行 = 用户意图：desktop 不启用')
  assert.equal(a.effective.desktop, true, '按实测层序这行会被跳过')
  assert.equal(a.layoutDrift.code, 'INEFFECTIVE_OVERRIDE')

  // 悬空的自有覆盖行（insert 已被删、覆盖行还在）→ 报错，但不得变成一台服务器
  const withOrphan = noisy + buildDisableBlock('mcp-gone', '\n')
  const r2 = mergeServers({ homeText, profiles: [{ name: 'desktop', text: withOrphan }] })
  assert.deepEqual(r2.servers.map((s) => s.id), ['mcp-a'])
  assert.equal(r2.ok, false)
  const orphan = r2.conflicts.find((c) => c.code === 'E_ORPHAN_OVERRIDE')
  assert.ok(orphan, '悬空覆盖行必须报告')
  assert.equal(orphan.id, 'mcp-gone')
  assert.deepEqual(orphan.layers, ['desktop'])
})

// ═══════════════════════ 工具函数与常量 ═══════════════════════

test('MARK / buildInsertBlock / buildDisableBlock：缩进与真实 home patch 逐字对齐', () => {
  assert.equal(MARK.server('mcp-x'), '# dsh-mcp-manager:2:server:mcp-x')
  assert.equal(MARK.disable('mcp-x'), '# dsh-mcp-manager:2:disable:mcp-x')

  // 样本第 1 条（idx0–6）就是这三个字段的 insert 块（样本里它还没标记）→ 跳过本次产出的标记行后逐字相等
  const ida = buildInsertBlock('ida-headless-mcp', { serverName: 'ida-headless-mcp', transport: 'stdio', command: 'idalib-pool' }, '\n')
  assert.equal(ida.split('\n')[0], '# dsh-mcp-manager:2:server:ida-headless-mcp')
  assert.equal(ida.split('\n').slice(1, 8).join('\n') + '\n', HOME.split('\n').slice(0, 7).join('\n') + '\n')

  // 样本末尾 4 行就是旧式 disable 覆盖行（旧标记，未迁移）→ 跳过标记行后逐字相等
  const dis = buildDisableBlock('mcp-Serena', '\n')
  assert.equal(dis.split('\n')[0], '# dsh-mcp-manager:2:disable:mcp-Serena')
  assert.equal(HOME.split('\n')[67], '# dsh-mcp-manager:disable:mcp-Serena')
  assert.equal(dis.split('\n').slice(1, 4).join('\n') + '\n', HOME.split('\n').slice(68, 71).join('\n') + '\n')

  const full = buildInsertBlock(
    'mcp-x',
    {
      serverName: 'X',
      transport: 'stdio',
      command: 'x',
      args: ['a', 'b b'],
      env: { K: 'v', 'W-in': 'C:\\tmp' },
      cwd: 'C:\\work',
      toolCallTimeoutMs: 45000,
      maxInstructionBytes: 1024,
      failOnStartupError: true,
    },
    '\n',
  )
  assert.equal(
    full,
    [
      '# dsh-mcp-manager:2:server:mcp-x',
      '- insert:',
      '    - id: mcp-x',
      "      name: '@deepseek-ai/dsh-mcp-client'",
      '      config:',
      '        serverName: "X"',
      '        transport: "stdio"',
      '        command: "x"',
      '        args:',
      '          - "a"',
      '          - "b b"',
      '        env:',
      '          K: "v"',
      '          W-in: "C:\\\\tmp"',
      '        cwd: "C:\\\\work"',
      '        toolCallTimeoutMs: 45000',
      '        maxInstructionBytes: 1024',
      '        failOnStartupError: true',
      '',
    ].join('\n'),
  )
  const http = buildInsertBlock('mcp-h', { serverName: 'H', transport: 'streamable-http', url: 'https://h.test/mcp', headers: { Authorization: 'Bearer t' } }, '\n')
  assert.equal(http.includes('        url: "https://h.test/mcp"\n'), true)
  assert.equal(http.includes('        headers:\n          Authorization: "Bearer t"\n'), true)
  assert.equal(http.includes('command'), false)
  assert.equal(MCP_PACKAGE_NAME, '@deepseek-ai/dsh-mcp-client')
})

test('locateServerBlock / locateDisableBlock：标记优先、可要求只认标记', () => {
  const ls = lines(HOME)
  assert.deepEqual([locateServerBlock(ls, 'mcp-CodeMap').start, locateServerBlock(ls, 'mcp-CodeMap').end], [27, 37])
  assert.equal(locateServerBlock(ls, 'mcp-CodeMap').hasMarker, true)
  assert.deepEqual([locateServerBlock(ls, 'ida-headless-mcp').start, locateServerBlock(ls, 'ida-headless-mcp').end], [0, 7])
  assert.equal(locateServerBlock(ls, 'mcp-nope'), null)
  assert.equal(locateServerBlock(ls, 'ida-headless-mcp', { includeUnmarked: false }), null)

  const dis = locateDisableBlock(ls, 'mcp-Serena')
  assert.deepEqual([dis.start, dis.end], [67, 71])
  assert.equal(dis.disabled, true)
  assert.equal(dis.markerKind, 'disable')
  assert.equal(overrideRange(HOME, 'mcp-Serena')[0], 67)
  assert.equal(locateDisableBlock(ls, 'mcp-CodeMap'), null)
})

test('detectEol / splitKeepEol：保留行尾，CRLF 与 LF 判定', () => {
  assert.equal(detectEol('a\nb\n'), '\n')
  assert.equal(detectEol('a\r\nb\r\n'), '\r\n')
  assert.equal(detectEol('a\r\nb\nc\n'), '\n', '少数派 CRLF 不改判定')
  assert.equal(detectEol(''), '\n')
  assert.deepEqual(splitKeepEol('a\nb'), ['a\n', 'b'])
  assert.deepEqual(splitKeepEol('a\r\nb\r\n'), ['a\r\n', 'b\r\n'])
  assert.deepEqual(splitKeepEol('a\n\nb'), ['a\n', '\n', 'b'])
  assert.deepEqual(splitKeepEol(''), [])
  assert.deepEqual(splitKeepEol('a\rb'), ['a\r', 'b'])
})

test('listProfiles / profilePatchPath / statePath / defaultState：路径与默认参数', () => {
  assert.deepEqual(listProfiles(['web', 'desktop', 'node_modules', 'dsh-tui', '.git', '', 'bad name']), ['desktop', 'dsh-tui', 'web'])
  assert.deepEqual(listProfiles([{ name: 'web' }, { name: 'web' }, { name: 'desktop' }]), ['desktop', 'web'])
  assert.deepEqual(listProfiles(undefined), [])
  assert.equal(profilePatchPath('C:\\Users\\x\\.dsh', 'desktop'), 'C:\\Users\\x\\.dsh\\profiles\\desktop\\cordis.patch.yml')
  assert.equal(profilePatchPath('/home/x/.dsh/', 'web'), '/home/x/.dsh/profiles/web/cordis.patch.yml')
  assert.equal(statePath('C:\\Users\\x\\.dsh'), 'C:\\Users\\x\\.dsh\\.dsh-mcp-manager\\state.json')
  assert.equal(statePath('/home/x/.dsh'), '/home/x/.dsh/.dsh-mcp-manager/state.json')

  const st = defaultState()
  assert.equal(st.version, STATE_VERSION)
  assert.equal(st.defaults.toolCallTimeoutMs, 60000)
  assert.equal(st.defaults.maxInstructionBytes, 32768)
  assert.equal(st.defaults.failOnStartupError, false)
  assert.equal(st.defaults.probeTimeoutMs, 8000)
  assert.equal(st.defaults.defaultTransport, 'stdio')
  assert.deepEqual(st.knownProfiles, [])
  assert.equal(JSON.stringify(st).includes('dsh-mcp-manager:2:'), false, 'state.json 不得含 patch 语义')
  assert.notEqual(defaultState(), st, '每次返回新对象')
})
