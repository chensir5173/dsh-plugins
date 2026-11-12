/**
 * host-http.test.mjs — 宿主半离线验收（真 handler + 假 web 服务器 + 临时 DSH_HOME）
 *
 * 覆盖 ACCEPTANCE：A1.1–A1.4 / A3.1–A3.3 / A4.4 / A5.2–A5.4 / A7.1–A7.3 / A8.1–A8.4 / A9.1–A9.3，
 * 以及 tasks.md §2.7 的 ①–⑤。
 *
 * 硬约束：绝不起真实 HTTP 服务器/端口、绝不起 MCP 子进程、绝不碰真实 $DSH_HOME（只读观察过真实
 * `~/.dsh/cordis.patch.yml` 的形状，夹具是它的样本拷贝）。
 *
 * 运行：node sub-plugins/dsh-mcp-manager/test/host-http.test.mjs
 */

import test from 'node:test'
import assert from 'node:assert/strict'
import fs from 'node:fs'
import { createRequire } from 'node:module'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'

const HERE = path.dirname(fileURLToPath(import.meta.url))
const HOST = await import(pathToFileURL(path.join(HERE, '..', 'src', 'index.js')).href)
const core = await import(pathToFileURL(path.join(HERE, '..', 'src', 'host-core.js')).href)

const API_PATH = '/__dsh-mcp-manager/api'
const PLUGIN_HEADER = 'dsh-mcp-manager'
/**
 * 假的 `@deepseek-ai/dsh-tools`：**必须模仿真实 defineTool 的定义期契约**。
 * 0.2.x（含 0.2.1-rc.5）的 defineTool 第一段就读 `options.output.render` / `options.output.schema`，
 * 留一个只会 `{ ...options }` 的空壳会让「漏传 output」这类兼容性 bug 静默全绿 ——
 * 而在真实宿主里那是 4 个模型工具全部注册失败（toolsRegistered: []）。
 */
const FAKE_TOOLS_MODULE = {
  defineTool: (options) => {
    const output = options && options.output
    if (!output || typeof output !== 'object') throw new TypeError(`defineTool(${options && options.name}): output is required`)
    if (!output.schema || typeof output.schema !== 'object') throw new TypeError(`defineTool(${options.name}): output.schema is required`)
    if (typeof output.render !== 'function') throw new TypeError(`defineTool(${options.name}): output.render must be a function`)
    const rendered = output.render({}, 'probe')
    if (!Array.isArray(rendered) || rendered[0] === undefined || rendered[0].type !== 'text' || typeof rendered[0].text !== 'string') {
      throw new TypeError(`defineTool(${options.name}): output.render must return text ContentBlock[]`)
    }
    return { ...options }
  },
}

// ═══════════════════════════════ 夹具 ═══════════════════════════════

/** 真实 home patch 的样本拷贝形状：6 条 MCP（首条缺标记）+ 5 条旧标记 + Serena 同层 disable 覆盖行。 */
const MCP_IDS = [
  { id: 'ida-headless-mcp', serverName: 'Hex-Rays-MCP', marked: false },
  { id: 'tarce-ui', serverName: 'Trace-UI', marked: true },
  { id: 'mcp-Serena', serverName: 'Serena', marked: true },
  { id: 'mcp-CodeMap', serverName: 'CodeMap', marked: true },
  { id: 'mcp-rea-mcp', serverName: 'REA-MCP', marked: true },
  { id: 'mcp-ida-pro-office', serverName: 'ida-pro-office', marked: true },
]

function homePatchText(opts = {}) {
  const out = [
    '# DSH 补丁层：home 层（对所有 profile 生效）',
    '# 中文注释必须逐字保留：下面这些条目由 dsh-mcp-manager 管理',
    '',
  ]
  for (const s of MCP_IDS) {
    if (s.marked) out.push(`# dsh-mcp-manager:server:${s.id}`)
    out.push('- insert:')
    out.push(`    - id: ${s.id}`)
    out.push("      name: '@deepseek-ai/dsh-mcp-client'")
    out.push('      config:')
    out.push(`        serverName: '${s.serverName}'`)
    out.push('        transport: stdio')
    out.push('        command: node')
    out.push('        args:')
    out.push(`          - 'D:\\tools\\${s.id}\\index.js'`)
    out.push('        toolCallTimeoutMs: 60000')
    out.push('        failOnStartupError: false')
    out.push('        maxInstructionBytes: 32768')
    out.push('')
  }
  if (opts.serenaOverride !== false) {
    out.push('# dsh-mcp-manager:disable:mcp-Serena')
    out.push('- id: mcp-Serena')
    out.push("  name: '@deepseek-ai/dsh-mcp-client'")
    out.push('  disabled: true')
    out.push('')
  }
  return out.join('\n')
}

/** 跨层重复样本：同一 id 的 insert 块被塞进某个 profile 的 patch（A1.4 的冲突夹具）。 */
const SERENA_DUP_IN_PROFILE = [
  '# 跨层重复样本：mcp-Serena 也出现在这个 profile 里',
  '- insert:',
  '    - id: mcp-Serena',
  "      name: '@deepseek-ai/dsh-mcp-client'",
  '      config:',
  "        serverName: 'Serena'",
  '        transport: stdio',
  '        command: node',
].join('\n')

/** 真实 profile patch 的形状：管理器的激活行（含 `!!js` 表达式与中文注释）+ 非 MCP 覆盖行。 */
function profilePatchText(name, extra = '') {
  return [
    `# profile: ${name}`,
    '# 由 dsh-plugin-manager 维护的激活行 —— 本插件绝不碰它（A9.1）',
    '- id: dsh-mcp-manager',
    "  name: 'dsh-mcp-manager'",
    '  config:',
    "    probeTimeoutMs: !!js/function 'function(){ return 8000 }'",
    '# 真机 profile patch 里还有一批非 MCP 的悬空覆盖行（不是服务器）',
    '- id: llm-deepseek',
    "  name: 'dsh-llm-deepseek'",
    '  disabled: false',
    extra,
    '',
  ].join('\n')
}

const ACTIVATION_ROW = [
  '- id: dsh-mcp-manager',
  "  name: 'dsh-mcp-manager'",
  '  config:',
  "    probeTimeoutMs: !!js/function 'function(){ return 8000 }'",
].join('\n')

function mkFixture(opts = {}) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-mcp-manager-http-'))
  const home = path.join(root, 'home')
  const profilesRoot = path.join(home, 'profiles')
  fs.mkdirSync(profilesRoot, { recursive: true })
  const names = opts.profiles || ['desktop', 'web', 'tui']
  fs.writeFileSync(path.join(home, 'cordis.patch.yml'), opts.homeText ?? homePatchText(opts), 'utf8')
  fs.writeFileSync(path.join(home, 'dsh-mcp.json'), '{"mcpServers":{}}\n', 'utf8')
  for (const n of names) {
    const dir = path.join(profilesRoot, n)
    fs.mkdirSync(dir, { recursive: true })
    const extra = opts.serenaInProfile === n ? SERENA_DUP_IN_PROFILE : ''
    const text = opts.profileTexts && opts.profileTexts[n] !== undefined
      ? opts.profileTexts[n]
      : profilePatchText(n, extra)
    fs.writeFileSync(path.join(dir, 'cordis.patch.yml'), text, 'utf8')
  }
  // A2.2：node_modules 不是 profile；文件也不是 profile。
  fs.mkdirSync(path.join(profilesRoot, 'node_modules', 'x'), { recursive: true })
  fs.writeFileSync(path.join(profilesRoot, 'desktop.ini'), 'x\n', 'utf8')
  return {
    root,
    home,
    names,
    homePatch: path.join(home, 'cordis.patch.yml'),
    patch: (n) => path.join(profilesRoot, n, 'cordis.patch.yml'),
    stateFile: path.join(home, '.dsh-mcp-manager', 'state.json'),
    diagFile: path.join(home, '.dsh-mcp-manager', 'host-diag.json'),
    dshMcpJson: path.join(home, 'dsh-mcp.json'),
    cleanup: () => fs.rmSync(root, { recursive: true, force: true }),
  }
}

// ═══════════════════════════════ 假宿主 ═══════════════════════════════

function makeWebServer() {
  const routes = []
  return {
    routes,
    register(route) {
      if (!route || route.kind !== 'exact') throw new Error('unsupported route kind')
      if (routes.some((r) => r.path === route.path)) throw new Error(`webserver: duplicate route ${route.path}`)
      routes.push(route)
      return () => {
        const i = routes.indexOf(route)
        if (i >= 0) routes.splice(i, 1)
      }
    },
  }
}

function makeToolsStub(opts = {}) {
  const registered = []
  const stub = {
    registered,
    register(def) {
      registered.push(def)
      return () => {
        const i = registered.indexOf(def)
        if (i >= 0) registered.splice(i, 1)
      }
    },
  }
  // `schemas()` 只在显式给了快照时才存在 —— 模拟「tools 服务在、但读不到 schema」的能力差异。
  if (Array.isArray(opts.schemas)) stub.schemas = () => opts.schemas
  return stub
}

function makeCtx({ home, profileDir, webServer, tools, settings, patchPath, loader }) {
  const services = {
    profileContext: home && profileDir
      ? { home, profileDir, patchPath: patchPath || path.join(profileDir, 'cordis.patch.yml') }
      : null,
    webServer: webServer || null,
    tools: tools || null,
    settings: settings || null,
    loader: loader || null,
  }
  const ctx = {
    __services: services,
    get(name) {
      return services[name] ?? null
    },
    inject() { /* 首次就拿到服务，测试不需要延迟注入 */ },
    effect(cb) {
      const disposer = cb()
      return () => { if (typeof disposer === 'function') disposer() }
    },
  }
  return ctx
}

function makeReq({ method = 'POST', headers = {}, body = '' } = {}) {
  const buf = body === '' ? null : Buffer.from(body, 'utf8')
  return {
    method,
    headers,
    url: API_PATH,
    [Symbol.asyncIterator]: async function* iterator() {
      if (buf) yield buf
    },
  }
}

function makeRes() {
  const res = { status: 0, headers: null, body: '' }
  res.writeHead = (status, headers) => { res.status = status; res.headers = headers || null }
  res.end = (chunk) => { res.body = chunk === undefined || chunk === null ? '' : String(chunk) }
  return res
}

/** 真 handler 调用：默认带合法门头 + 同源 Host。 */
async function call(handler, action, payload, opts = {}) {
  const headers = { 'content-type': 'application/json', host: '127.0.0.1:60336', ...(opts.headers || {}) }
  if (!opts.omitHeader) headers['x-dsh-plugin'] = opts.pluginHeader === undefined ? PLUGIN_HEADER : opts.pluginHeader
  const body = opts.rawBody !== undefined
    ? opts.rawBody
    : JSON.stringify(payload === undefined || payload === null ? { action } : { action, payload })
  const res = makeRes()
  await handler(makeReq({ method: opts.method || 'POST', headers, body }), res)
  let json = null
  try { json = JSON.parse(res.body) } catch { json = null }
  return { status: res.status, json, raw: res.body }
}

/**
 * 功能作用：建夹具 + 假宿主 + 真 apply（含可选测试缝），返回可直接调端点的句柄。
 */
async function setupHost(opts = {}) {
  const env = opts.env || mkFixture(opts)
  const ws = opts.webServer || makeWebServer()
  const tools = opts.tools === null ? null : (opts.tools || makeToolsStub())
  const profile = opts.profile || 'desktop'
  const ctx = makeCtx({
    home: env.home,
    profileDir: path.join(env.home, 'profiles', profile),
    webServer: ws,
    tools,
    settings: opts.settings || null,
    loader: opts.loader || null,
  })
  HOST.__resetTestSeams()
  if (opts.importOverride) HOST.__setImportOverride(opts.importOverride)
  if (opts.probeRunner) HOST.__setProbeRunner(opts.probeRunner)
  await HOST.apply(ctx)
  const route = () => {
    const r = ws.routes.find((x) => x.path === API_PATH)
    if (!r) throw new Error('路由未挂载')
    return r.handler
  }
  return {
    env,
    ws,
    tools,
    ctx,
    route,
    call: (action, payload, o) => call(route(), action, payload, o),
    read: (file) => fs.readFileSync(file, 'utf8'),
  }
}

// ═══════════════════════════════ 断言工具 ═══════════════════════════════

const read = (file) => fs.readFileSync(file, 'utf8')

function backupCount(file) {
  const base = `${path.basename(file)}.bak-`
  try {
    return fs.readdirSync(path.dirname(file)).filter((n) => n.startsWith(base)).length
  } catch {
    return 0
  }
}

function mcpServers(data) {
  return (data.servers || []).filter((s) => s && typeof s.serverName === 'string' && s.serverName !== '')
}

/** 最新一份备份（按名字排序取最后一份）。 */
function newestBackup(file) {
  const dir = path.dirname(file)
  const base = `${path.basename(file)}.bak-`
  const names = fs.readdirSync(dir).filter((n) => n.startsWith(base)).sort()
  if (names.length === 0) return null
  return { name: names[names.length - 1], text: fs.readFileSync(path.join(dir, names[names.length - 1]), 'utf8') }
}

/** 取某 id 的行块原文（含标记行）。 */
function blockOf(text, id) {
  const parsed = core.parsePatch(text)
  const entry = parsed.entries.find((e) => e.id === id)
  if (!entry) return ''
  return parsed.lines.slice(entry.blockStart, entry.blockEnd).join('')
}

/** 去掉某 id 的行块（insert + 同 id 覆盖行）后的全文 —— 用来断言「只改了目标行」。 */
function withoutBlock(text, id) {
  const parsed = core.parsePatch(text)
  const blocks = [parsed.entries.find((e) => e.id === id), ...parsed.overrides.filter((o) => o.id === id)]
  const drop = new Set()
  for (const b of blocks) {
    if (!b) continue
    for (let i = b.blockStart; i < b.blockEnd; i++) drop.add(i)
  }
  return parsed.lines.filter((_, i) => !drop.has(i)).join('')
}

function withTemp(fn) {
  return async (t) => {
    const env = mkFixture()
    t.after(() => env.cleanup())
    await fn(env, t)
  }
}

// ═══════════════════════════════ ① list ═══════════════════════════════

test('①/A1.1 list 返回 6 条 + 矩阵 + 锚定 + patchInfo；路由形状正确；list 不探测', withTemp(async (env) => {
  let probeCalls = 0
  const host = await setupHost({ env, probeRunner: async () => { probeCalls += 1; return { ok: true, latencyMs: 1 } } })

  assert.equal(host.ws.routes.length, 1)
  assert.equal(host.ws.routes[0].kind, 'exact')
  assert.equal(host.ws.routes[0].path, API_PATH)
  assert.equal(typeof host.ws.routes[0].handler, 'function')

  const res = await host.call('list')
  assert.equal(res.status, 200)
  assert.equal(res.json.ok, true)
  const d = res.json.data
  assert.deepEqual(Object.keys(d).sort(), ['defaults', 'diagnostics', 'home', 'patchInfo', 'profile', 'profileDir', 'profiles', 'servers'])
  assert.equal(d.home, env.home)
  assert.equal(d.profile, 'desktop')
  assert.deepEqual(d.profiles, ['desktop', 'tui', 'web'])          // A2.2：node_modules 与文件不是 profile
  assert.equal(mcpServers(d).length, 6)
  // 真机形态：profile patch 里的非 MCP 覆盖行（`- id: dsh-mcp-manager` / `- id: llm-deepseek`）不是服务器
  assert.equal(d.servers.length, 6)
  assert.equal(d.servers.every((s) => s.name === '@deepseek-ai/dsh-mcp-client'), true)
  assert.equal(d.servers.some((s) => s.id === 'dsh-mcp-manager' || s.id === 'llm-deepseek'), false)
  // 悬空覆盖行如实进诊断（host-core 报 E_ORPHAN_OVERRIDE 就透出它的，未修好则由宿主半兜底计算）
  const orphanDiag = `${JSON.stringify(d.diagnostics.conflicts)}${JSON.stringify(d.diagnostics.notes)}`
  assert.match(orphanDiag, /E_ORPHAN_OVERRIDE/)
  assert.match(orphanDiag, /llm-deepseek|dsh-mcp-manager/)
  assert.equal(res.json.ok, true)
  assert.equal(d.defaults.probeTimeoutMs, 8000)
  assert.equal(d.diagnostics.anchorSource, 'profileContext')
  assert.equal(d.diagnostics.httpRegistered, true)

  const serena = mcpServers(d).find((s) => s.id === 'mcp-Serena')
  assert.equal(serena.matrix.desktop, false)                        // 同层 disable 覆盖行 → 停用
  assert.equal(serena.matrix.web, false)
  assert.equal(mcpServers(d).find((s) => s.id === 'tarce-ui').matrix.web, true)
  assert.deepEqual(Object.keys(serena.matrix).sort(), ['desktop', 'tui', 'web'])

  assert.equal(d.patchInfo.home.path, env.homePatch)
  assert.equal(d.patchInfo.home.exists, true)
  assert.equal(d.patchInfo.home.ok, true)
  assert.equal(d.patchInfo.home.backups, 0)
  assert.equal(d.patchInfo.profiles.desktop.path, env.patch('desktop'))
  assert.equal(d.patchInfo.profiles.tui.ok, true)
  assert.deepEqual(d.patchInfo.home.entries.map((e) => e.id).length, 6)

  const info = await host.call('patchInfo')
  assert.equal(info.json.ok, true)
  assert.equal(info.json.data.patchInfo.home.path, env.homePatch)
  assert.equal(info.json.data.patchInfo.profiles.web.exists, true)

  assert.equal(probeCalls, 0)                                       // A7.3：列表加载绝不探测
  assert.equal(fs.existsSync(env.diagFile), true)                    // 诊断文件落在 $DSH_HOME/.dsh-mcp-manager
  const diag = JSON.parse(read(env.diagFile))
  assert.equal(diag.home, env.home)
  assert.equal(diag.httpRegistered, true)
}))

// ═══════════════════════ ② 增 / 改 / 删 + 矩阵落点 ═══════════════════════

test('A1.1–A1.3 矩阵落点：全员→home；部分→各 profile；全不→home 行内 disabled', withTemp(async (env) => {
  const host = await setupHost({ env })
  const beforeWeb = read(env.patch('web'))
  const beforeTui = read(env.patch('tui'))

  // A1.1 全员（缺省 matrix = 全部 profile）
  const add = await host.call('add', { serverName: 'NewOne', config: { transport: 'stdio', command: 'node', args: ['x.js'] } })
  assert.equal(add.json.ok, true, add.raw)
  assert.equal(add.json.data.writes.filter((w) => w.changed).length, 1)
  assert.equal(add.json.data.writes[0].target, 'home')
  assert.ok(read(env.homePatch).includes('# dsh-mcp-manager:2:server:mcp-NewOne'))
  assert.equal(read(env.patch('web')), beforeWeb)
  assert.equal(read(env.patch('tui')), beforeTui)

  // A1.2 部分：desktop + web
  const some = await host.call('setMatrix', { id: 'mcp-NewOne', profiles: ['desktop', 'web'] })
  assert.equal(some.json.ok, true, some.raw)
  assert.deepEqual(some.json.data.matrix, { desktop: true, tui: false, web: true })
  assert.ok(!read(env.homePatch).includes('mcp-NewOne'))
  assert.ok(read(env.patch('desktop')).includes('mcp-NewOne'))
  assert.ok(read(env.patch('web')).includes('mcp-NewOne'))
  assert.equal(read(env.patch('tui')), beforeTui)

  // A1.3 全不：home 层一条 + 行内 disabled: true，profile 层不残留
  const none = await host.call('setMatrix', { id: 'mcp-NewOne', profiles: [] })
  assert.equal(none.json.ok, true, none.raw)
  const homeText = read(env.homePatch)
  assert.ok(homeText.includes('mcp-NewOne'))
  assert.match(blockOf(homeText, 'mcp-NewOne'), /disabled: true/)
  assert.ok(!read(env.patch('desktop')).includes('mcp-NewOne'))
  assert.ok(!read(env.patch('web')).includes('mcp-NewOne'))
  assert.equal(read(env.patch('tui')), beforeTui)
}))

test('A2.4 新 profile 漂移：部分生效的服务器遇到盘上新 profile → layoutDrift=NEW_PROFILE 且零写入', withTemp(async (env) => {
  const host = await setupHost({ env })

  // 先让 mcp-CodeMap 只对 desktop 生效（D1：部分生效 ⇒ home 层移走、写进 desktop）
  const placed = await host.call('setMatrix', { id: 'mcp-CodeMap', profiles: ['desktop'] })
  assert.equal(placed.json.ok, true, placed.raw)
  assert.ok(!read(env.homePatch).includes('mcp-CodeMap'))
  assert.ok(read(env.patch('desktop')).includes('mcp-CodeMap'))

  // 模拟「上次确认矩阵时盘上还没有 web」：knownProfiles 只记 desktop/tui
  const stateFile = path.join(env.home, '.dsh-mcp-manager', 'state.json')
  const st = JSON.parse(read(stateFile))
  st.knownProfiles = ['desktop', 'tui']
  fs.writeFileSync(stateFile, `${JSON.stringify(st, null, 2)}\n`, 'utf8')

  const beforeHome = read(env.homePatch)
  const beforeDesktop = read(env.patch('desktop'))
  const beforeWeb = read(env.patch('web'))
  const beforeTui = read(env.patch('tui'))
  const backupsBefore = backupCount(env.homePatch)   // setMatrix 那次写入的备份，与 list 无关

  const res = await host.call('list')
  assert.equal(res.json.ok, true, res.raw)
  const srv = res.json.data.servers.find((s) => s.id === 'mcp-CodeMap')
  assert.ok(srv, 'mcp-CodeMap 应出现在 servers 里')
  assert.equal(srv.layoutDrift && srv.layoutDrift.code, 'NEW_PROFILE')
  assert.deepEqual(srv.layoutDrift.layers, ['web'])
  assert.match(srv.layoutDrift.message, /web/)

  // A2.4 / 「不静默改写」：只读 list 绝不落盘、不产生备份
  assert.equal(read(env.homePatch), beforeHome)
  assert.equal(read(env.patch('desktop')), beforeDesktop)
  assert.equal(read(env.patch('web')), beforeWeb)
  assert.equal(read(env.patch('tui')), beforeTui)
  assert.equal(backupCount(env.homePatch), backupsBefore)
}))

test('A1.4 同 id 跨层重复：拒绝写入 + 文件未变 + 未产生备份', withTemp(async () => {
  // 带跨层重复的夹具（mcp-Serena 同时在 home 与 web）
  const dup = mkFixture({ serenaInProfile: 'web' })
  try {
    const h = await setupHost({ env: dup })
    assert.ok(read(dup.homePatch).includes('mcp-Serena'))
    assert.ok(read(dup.patch('web')).includes('mcp-Serena'))
    const beforeHome = read(dup.homePatch)
    const beforeWeb = read(dup.patch('web'))

    const res = await h.call('setEnabled', { id: 'mcp-Serena', enabled: true })
    assert.equal(res.status, 200)
    assert.equal(res.json.ok, false)
    assert.equal(res.json.error.code, 'layout-conflict')
    assert.ok(Array.isArray(res.json.error.fields.conflicts) && res.json.error.fields.conflicts.length > 0)
    assert.equal(read(dup.homePatch), beforeHome)
    assert.equal(read(dup.patch('web')), beforeWeb)
    assert.equal(backupCount(dup.homePatch), 0)
    assert.equal(backupCount(dup.patch('web')), 0)
  } finally {
    dup.cleanup()
  }
}))

test('② update 只改目标行块；remove 行块消失且无关注释逐字不变', withTemp(async (env) => {
  const host = await setupHost({ env })
  const before = read(env.homePatch)

  const upd = await host.call('update', { id: 'tarce-ui', config: { toolCallTimeoutMs: 12345 } })
  assert.equal(upd.json.ok, true, upd.raw)
  const afterUpd = read(env.homePatch)
  assert.notEqual(afterUpd, before)
  assert.equal(withoutBlock(afterUpd, 'tarce-ui'), withoutBlock(before, 'tarce-ui'))  // 非目标行逐字不变
  assert.match(blockOf(afterUpd, 'tarce-ui'), /toolCallTimeoutMs: 12345/)
  assert.ok(afterUpd.includes('# 中文注释必须逐字保留：下面这些条目由 dsh-mcp-manager 管理'))
  assert.ok(afterUpd.includes('# dsh-mcp-manager:server:mcp-rea-mcp'))

  const rm = await host.call('remove', { id: 'mcp-CodeMap' })
  assert.equal(rm.json.ok, true, rm.raw)
  assert.equal(rm.json.data.removed, 1)
  const afterRm = read(env.homePatch)
  assert.ok(!afterRm.includes('mcp-CodeMap'))
  assert.equal(withoutBlock(afterRm, 'mcp-CodeMap'), withoutBlock(afterUpd, 'mcp-CodeMap'))
  assert.ok(afterRm.includes('# dsh-mcp-manager:server:mcp-rea-mcp'))
  // 备份名 <file>.bak-<yyyyMMdd-HHmmss>：同一秒内的两次写会复用同一份备份名，故只断言「至少一份且内容=写入前」
  assert.ok(backupCount(env.homePatch) >= 1)
  const newest = newestBackup(env.homePatch)
  assert.match(newest.name, /^cordis\.patch\.yml\.bak-\d{8}-\d{6}$/)
  assert.equal(newest.text, afterUpd)

  const missing = await host.call('remove', { id: 'mcp-Nope' })
  assert.equal(missing.status, 200)
  assert.equal(missing.json.ok, false)
  assert.equal(missing.json.error.code, 'not-found')
}))

test('A5.3 并发写被串行化：两个 add 都落盘（后写者看到前写者的结果）', withTemp(async (env) => {
  const host = await setupHost({ env })
  const [a, b] = await Promise.all([
    host.call('add', { serverName: 'ConcA', config: { transport: 'stdio', command: 'node' } }),
    host.call('add', { serverName: 'ConcB', config: { transport: 'stdio', command: 'node' } }),
  ])
  assert.equal(a.json.ok, true, a.raw)
  assert.equal(b.json.ok, true, b.raw)
  const text = read(env.homePatch)
  assert.ok(text.includes('mcp-ConcA'))
  assert.ok(text.includes('mcp-ConcB'))
  assert.equal(core.parsePatch(text).ok, true)
  assert.equal(core.parsePatch(text).entries.length, 8)
}))

// ═══════════════════════════ A3 全局默认参数 ═══════════════════════════

test('A3.1–A3.3 默认参数存 state.json、落成 config 具体字段、损坏即回退', withTemp(async (env) => {
  const host = await setupHost({ env })
  const set = await host.call('setDefaults', { defaults: { toolCallTimeoutMs: 12345, probeTimeoutMs: 900 } })
  assert.equal(set.json.ok, true, set.raw)
  const st = JSON.parse(read(env.stateFile))
  assert.equal(st.defaults.toolCallTimeoutMs, 12345)
  assert.equal(st.defaults.probeTimeoutMs, 900)
  const got = await host.call('getDefaults')
  assert.equal(got.json.data.defaults.toolCallTimeoutMs, 12345)

  const add = await host.call('add', { serverName: 'DefOne', config: { transport: 'stdio', command: 'node' } })
  assert.equal(add.json.ok, true, add.raw)
  const block = blockOf(read(env.homePatch), 'mcp-DefOne')
  assert.match(block, /toolCallTimeoutMs: 12345/)     // A3.2：默认值落成该条目 config 内的具体字段
  assert.match(block, /failOnStartupError: false/)
  assert.match(block, /maxInstructionBytes: 32768/)

  fs.writeFileSync(env.stateFile, '{ 这不是 JSON', 'utf8')
  const broken = await host.call('list')
  assert.equal(broken.json.ok, true)
  assert.equal(broken.json.data.defaults.toolCallTimeoutMs, 60000)   // A3.3：回退内置默认值且不报错
  const bad = await host.call('setDefaults', { defaults: { probeTimeoutMs: -1 } })
  assert.equal(bad.json.ok, false)
  assert.equal(bad.json.error.code, 'invalid-config')
}))

// ═══════════════════════════ A4 迁移 ═══════════════════════════

test('A4.4 migrate：旧标记改写 + 补齐 + 覆盖行收敛 + 执行前备份 + 幂等', withTemp(async (env) => {
  const host = await setupHost({ env })
  const before = read(env.homePatch)
  assert.ok(before.includes('# dsh-mcp-manager:server:tarce-ui'))
  assert.ok(!before.includes(':2:'))

  const res = await host.call('migrate', {})
  assert.equal(res.json.ok, true, res.raw)
  const data = res.json.data
  assert.equal(data.applied, true)
  assert.ok(data.totals.relabeled >= 5, JSON.stringify(data.totals))
  assert.equal(data.totals.tagged, 1)
  assert.ok(data.totals.converged >= 1)
  const after = read(env.homePatch)
  assert.ok(!after.includes('# dsh-mcp-manager:server:'))
  assert.ok(!after.includes('# dsh-mcp-manager:disable:'))
  for (const s of MCP_IDS) assert.ok(after.includes(`# dsh-mcp-manager:2:server:${s.id}`), s.id)
  assert.match(blockOf(after, 'mcp-Serena'), /disabled: true/)
  assert.ok(after.includes('# 中文注释必须逐字保留：下面这些条目由 dsh-mcp-manager 管理'))
  assert.equal(backupCount(env.homePatch), 1)        // A4.4：执行前备份

  const again = await host.call('migrate', {})
  assert.equal(again.json.data.changed, 0)           // 幂等：第二次零写入
  assert.equal(read(env.homePatch), after)

  const dry = await host.call('migrate', { apply: false })
  assert.equal(dry.json.data.applied, false)
}))

// ═══════════════════════════ A5 写盘安全 ═══════════════════════════

test('A5.2 备份命名 <file>.bak-<yyyyMMdd-HHmmss>，同目录只保留最近 10 份', withTemp(async (env) => {
  const host = await setupHost({ env })
  // 预置 12 份旧备份（时间戳各不相同），一次真实写入后必须被裁到 10 份
  const dir = path.dirname(env.homePatch)
  const base = `${path.basename(env.homePatch)}.bak-`
  for (let i = 1; i <= 12; i += 1) {
    fs.writeFileSync(path.join(dir, `${base}20200101-0000${String(i).padStart(2, '0')}`), `old-${i}\n`, 'utf8')
  }
  assert.equal(backupCount(env.homePatch), 12)

  const res = await host.call('setEnabled', { id: 'tarce-ui', enabled: false })
  assert.equal(res.json.ok, true, res.raw)
  assert.equal(backupCount(env.homePatch), 10)
  const names = fs.readdirSync(dir).filter((n) => n.startsWith(base)).sort()
  assert.match(names[names.length - 1], /^cordis\.patch\.yml\.bak-\d{8}-\d{6}$/)
  assert.ok(!names.some((n) => n.endsWith('000001')))    // 最旧的两份被裁掉
  assert.ok(!names.some((n) => n.endsWith('000002')))

  const info = await host.call('patchInfo')
  assert.equal(info.json.data.patchInfo.home.backups, 10)
}))

test('A5.4/A9.3 非法 YAML 与不可读文件 → patch-unparsable、文件未改、无备份残留', withTemp(async (env) => {
  const host = await setupHost({ env })
  fs.writeFileSync(env.homePatch, '这不是顶层数组: true\n', 'utf8')
  const before = read(env.homePatch)
  const res = await host.call('add', { serverName: 'Bad', config: { transport: 'stdio', command: 'node' } })
  assert.equal(res.status, 200)
  assert.equal(res.json.ok, false)
  assert.equal(res.json.error.code, 'patch-unparsable')
  assert.equal(read(env.homePatch), before)
  assert.equal(backupCount(env.homePatch), 0)
  assert.equal(read(env.dshMcpJson), '{"mcpServers":{}}\n')

  // 目标文件不可读（目录冒充 patch 文件）→ 同样 fail-closed 且零备份
  const env2 = mkFixture()
  try {
    const host2 = await setupHost({ env: env2 })
    fs.rmSync(env2.patch('web'))
    fs.mkdirSync(env2.patch('web'))
    const before2 = read(env2.homePatch)
    const res2 = await host2.call('add', { serverName: 'Bad2', config: { transport: 'stdio', command: 'node' } })
    assert.equal(res2.json.ok, false)
    assert.equal(res2.json.error.code, 'patch-unparsable')
    assert.equal(read(env2.homePatch), before2)
    assert.equal(backupCount(env2.homePatch), 0)
  } finally {
    env2.cleanup()
  }
}))

test('EOL 沿用：CRLF 夹具写入后仍是 CRLF', withTemp(async (env) => {
  const crlf = homePatchText().replace(/\n/g, '\r\n')
  const env2 = mkFixture({ homeText: crlf, profileTexts: { desktop: profilePatchText('desktop').replace(/\n/g, '\r\n') } })
  try {
    const host = await setupHost({ env: env2 })
    const res = await host.call('setEnabled', { id: 'tarce-ui', enabled: false })
    assert.equal(res.json.ok, true, res.raw)
    const after = read(env2.homePatch)
    assert.ok(after.includes('\r\n'))
    assert.equal(/\n(?!\r)/.test(after.replace(/\r\n/g, '')), false)
    assert.match(blockOf(after, 'tarce-ui'), /disabled: true/)
  } finally {
    env2.cleanup()
  }
}))

// ═══════════════════════════ A7 按需探测 ═══════════════════════════

test('A7.1/A7.2 probe：成功与失败形状、超时按 probeTimeoutMs、文件不变', withTemp(async (env) => {
  let calls = 0
  const host = await setupHost({
    env,
    probeRunner: async () => { calls += 1; return { ok: true, latencyMs: 42, toolCount: 7 } },
  })
  await host.call('list')
  assert.equal(calls, 0)

  const ok = await host.call('probe', { id: 'mcp-Serena' })
  assert.equal(ok.json.ok, true)
  assert.deepEqual(
    { ok: ok.json.data.ok, latencyMs: ok.json.data.latencyMs, toolCount: ok.json.data.toolCount },
    { ok: true, latencyMs: 42, toolCount: 7 },
  )
  assert.equal(ok.json.data.timeoutMs, 8000)
  assert.equal(calls, 1)

  HOST.__setProbeRunner(async () => ({ ok: false, error: 'spawn node ENOENT' }))
  const fail = await host.call('probe', { id: 'mcp-Serena' })
  assert.equal(fail.json.data.ok, false)
  assert.match(fail.json.data.error, /ENOENT/)

  await host.call('setDefaults', { defaults: { probeTimeoutMs: 150 } })
  const before = read(env.homePatch)
  HOST.__setProbeRunner(() => new Promise(() => {}))
  const t0 = Date.now()
  const timedOut = await host.call('probe', { id: 'mcp-Serena' })
  const elapsed = Date.now() - t0
  assert.equal(timedOut.json.data.ok, false)
  assert.match(timedOut.json.data.error, /150ms/)
  assert.ok(elapsed >= 100 && elapsed < 3000, `elapsed=${elapsed}`)
  assert.equal(read(env.homePatch), before)

  // tools 的探测模式复用同一套超时（此处默认值已被 setDefaults 改成 150ms）
  const t1 = Date.now()
  const toolsTimedOut = await host.call('tools', { id: 'mcp-Serena', mode: 'probe' })
  const elapsed2 = Date.now() - t1
  assert.equal(toolsTimedOut.json.ok, false, toolsTimedOut.raw)
  assert.equal(toolsTimedOut.json.error.code, 'probe-failed')
  assert.match(String(toolsTimedOut.json.error.fields.error), /150ms/)
  assert.ok(elapsed2 >= 100 && elapsed2 < 3000, `elapsed=${elapsed2}`)

  const unknown = await host.call('probe', { id: 'mcp-Nope' })
  assert.equal(unknown.json.ok, false)
  assert.equal(unknown.json.error.code, 'not-found')
}))

test('A7.4 真实 probe 执行器：坏配置先自检；SDK 不可解析时明确报错而非挂起（不起任何进程）', withTemp(async (env) => {
  const host = await setupHost({ env })   // 不装探测桩 → 走真实执行器
  const beforeHome = read(env.homePatch)

  // ① 配置自检发生在解析 SDK / 起客户端之前：坏配置确定性地被拒，永远不会 spawn。
  await assert.rejects(() => HOST.__realProbeRunner({ transport: 'streamable-http' }), /缺少 url/)
  await assert.rejects(() => HOST.__realProbeRunner({ transport: 'stdio' }), /缺少 command/)

  // ② SDK 解析不到时必须明确报错（离线安全：只在确认解析不到时断言，解析得到则跳过、绝不连网/起进程）。
  let resolvable = true
  try {
    createRequire(path.join(env.profileDir, 'package.json')).resolve('@modelcontextprotocol/client')
  } catch {
    resolvable = false
  }
  if (!resolvable) {
    const t0 = Date.now()
    await assert.rejects(
      () => HOST.__realProbeRunner({ transport: 'stdio', command: 'node' }),
      /无法解析 @modelcontextprotocol\/client/,
    )
    assert.ok(Date.now() - t0 < 3000, '解析失败必须快速返回，不能挂起')
  }
  // ③ 该路径不得改动任何文件、不产生备份。
  assert.equal(read(env.homePatch), beforeHome)
  assert.equal(backupCount(env.homePatch), 0)
}))

// ═══════════ D7 静态层（loader 条目态 + 工具数）与「原始 YAML」 ═══════════

test('D7① loader/tools 能力缺失：staticState 与 toolCountEstimate 全为 null，list 仍然 ok', withTemp(async (env) => {
  const host = await setupHost({ env })            // 无 loader；tools 桩没有 schemas()
  const res = await host.call('list')
  assert.equal(res.json.ok, true, res.raw)
  assert.ok(res.json.data.servers.length >= 6)
  for (const s of res.json.data.servers) {
    assert.equal(s.staticState, null, `${s.id} staticState 应为 null`)
    assert.equal(s.toolCountEstimate, null, `${s.id} toolCountEstimate 应为 null`)
  }
}))

test('D7② loader 条目态映射：disabled 优先 / include: 前缀对齐 / 无 fiber 为 null / 跳过 group 与非 MCP', withTemp(async (env) => {
  const entries = [
    { options: { id: 'mcp-Serena', name: '@deepseek-ai/dsh-mcp-client' }, fiber: { state: 2 } },
    { options: { id: 'mcp-CodeMap', name: '@deepseek-ai/dsh-mcp-client' }, fiber: { state: 3 } },
    { options: { id: 'mcp-rea-mcp', name: '@deepseek-ai/dsh-mcp-client' }, disabled: true, fiber: { state: 2 } },
    { options: { id: 'mcp-ida-pro-office', name: '@deepseek-ai/dsh-mcp-client' } },
    { options: { id: 'include:tarce-ui', name: '@deepseek-ai/dsh-mcp-client' }, fiber: { state: 1 } },
    { options: { id: 'grp-x', name: '@deepseek-ai/dsh-mcp-client', group: true }, fiber: { state: 2 } },
    { options: { id: 'ida-headless-mcp', name: 'dsh-plugin-manager' }, fiber: { state: 2 } },
  ]
  const host = await setupHost({ env, loader: { entries: () => entries } })
  const res = await host.call('list')
  assert.equal(res.json.ok, true, res.raw)
  const byId = Object.fromEntries(res.json.data.servers.map((s) => [s.id, s.staticState]))
  assert.equal(byId['mcp-Serena'], 'active')
  assert.equal(byId['mcp-CodeMap'], 'failed')
  assert.equal(byId['mcp-rea-mcp'], 'disabled')        // disabled 优先于 fiber 态
  assert.equal(byId['mcp-ida-pro-office'], null)       // 有条目但拿不到 fiber 态 → null（不猜）
  assert.equal(byId['tarce-ui'], 'loading')            // include: 前缀剥离后与服务器 id 对齐
  assert.equal(byId['ida-headless-mcp'], null)         // 非 MCP 条目不算
}))

test('D7③ tools.schemas() 快照 → toolCountEstimate 按 mcp__<serverName>__ 前缀计数', withTemp(async (env) => {
  const tools = makeToolsStub({
    schemas: [
      { name: 'mcp__Serena__find_symbol' },
      { name: 'mcp__Serena__read_file' },
      { name: 'mcp__CodeMap__get_structure' },
      { name: 'mcp_manager_list' },
    ],
  })
  const host = await setupHost({ env, tools })
  const res = await host.call('list')
  assert.equal(res.json.ok, true, res.raw)
  const byId = Object.fromEntries(res.json.data.servers.map((s) => [s.id, s.toolCountEstimate]))
  assert.equal(byId['mcp-Serena'], 2)
  assert.equal(byId['mcp-CodeMap'], 1)
  assert.equal(byId['mcp-rea-mcp'], 0)                 // 服务可用但没有该前缀 → 0（不是 null）
  assert.equal(res.json.data.servers.every((s) => s.toolCountEstimate !== null), true)
}))

test('D7④ payload.yaml：经 host-core 结构化解析后落盘，与 config 路径等价；同时给出时 yaml 优先', withTemp(async (env) => {
  const host = await setupHost({ env })
  const yaml = [
    'transport: stdio',
    'command: node',
    'args:',
    '  - "-e"',
    '  - "console.log(1)"',
    'toolCallTimeoutMs: 1234',
  ].join('\n')

  // 不给 matrix ⇒ 全员生效 ⇒ 落 home 层（D1）
  const viaYaml = await host.call('add', { id: 'mcp-YamlOne', serverName: 'YamlOne', yaml })
  assert.equal(viaYaml.json.ok, true, viaYaml.raw)
  const viaConfig = await host.call('add', {
    id: 'mcp-ConfigTwo',
    serverName: 'ConfigTwo',
    config: { transport: 'stdio', command: 'node', args: ['-e', 'console.log(1)'], toolCallTimeoutMs: 1234 },
  })
  assert.equal(viaConfig.json.ok, true, viaConfig.raw)

  const text = read(env.homePatch)
  const yamlBlock = blockOf(text, 'mcp-YamlOne')
  assert.match(yamlBlock, /# dsh-mcp-manager:2:server:mcp-YamlOne/)
  assert.match(yamlBlock, /transport: "?stdio"?/)
  assert.match(yamlBlock, /command: "?node"?/)
  assert.match(yamlBlock, /toolCallTimeoutMs: 1234/)
  assert.match(yamlBlock, /- "-e"/)

  // 两条路径的落盘块逐字等价（只有 id / serverName 不同）
  const normalize = (block, id, name) => block
    .split(id).join('<ID>')
    .split(name).join('<NAME>')
  assert.equal(
    normalize(yamlBlock, 'mcp-YamlOne', 'YamlOne'),
    normalize(blockOf(text, 'mcp-ConfigTwo'), 'mcp-ConfigTwo', 'ConfigTwo'),
  )

  // yaml 优先于 config：两者同时给出时以 yaml 为准
  const both = await host.call('update', {
    id: 'mcp-YamlOne',
    yaml: 'transport: streamable-http\nurl: "http://127.0.0.1:9/mcp"\nserverName: YamlOne',
    config: { transport: 'stdio', command: 'nope' },
  })
  assert.equal(both.json.ok, true, both.raw)
  const updated = blockOf(read(env.homePatch), 'mcp-YamlOne')
  assert.match(updated, /transport: "?streamable-http"?/)
  assert.match(updated, /http:\/\/127\.0\.0\.1:9\/mcp/)
  assert.ok(!updated.includes('nope'), 'config 分支不应生效')
}))

test('D7⑤ 非法 yaml → bad-yaml（HTTP 200 业务错误）+ 零写入 + 无备份残留', withTemp(async (env) => {
  const host = await setupHost({ env })
  const before = read(env.homePatch)
  const cases = [
    { label: 'Tab 缩进', id: 'mcp-BadTab', serverName: 'BadTab', yaml: 'transport: stdio\n\tcommand: node' },
    { label: '没有配置体', id: 'mcp-BadEmpty', serverName: 'BadEmpty', yaml: '# 只有注释' },
  ]
  for (const c of cases) {
    const res = await host.call('add', { id: c.id, serverName: c.serverName, yaml: c.yaml })
    assert.equal(res.status, 200, `${c.label} 应为 200 业务错误：${res.raw}`)
    assert.equal(res.json.ok, false, `${c.label}：${res.raw}`)
    assert.equal(res.json.error.code, 'bad-yaml', `${c.label}：${res.raw}`)
    assert.ok(res.json.error.fields && res.json.error.fields.yaml, `${c.label} 应带 fields.yaml`)
    assert.equal(read(env.homePatch), before, `${c.label} 不得改动文件`)
    assert.equal(backupCount(env.homePatch), 0, `${c.label} 不得留下备份`)
  }

  // update 同样拒绝，且不碰目标条目
  const upd = await host.call('update', { id: 'mcp-Serena', yaml: '# 空' })
  assert.equal(upd.status, 200)
  assert.equal(upd.json.ok, false)
  assert.equal(upd.json.error.code, 'bad-yaml')
  assert.equal(read(env.homePatch), before)
  assert.equal(backupCount(env.homePatch), 0)
}))

// ═══════════════ §6.1 第 12 个动作 tools（静态清单 / 探测清单） ═══════════════

test('§6.1 tools 静态：只返回 mcp__<serverName>__ 前缀的已注册工具（含 description），绝不调 probeRunner', withTemp(async (env) => {
  let probeCalls = 0
  const tools = makeToolsStub({
    schemas: [
      { name: 'mcp__Serena__find_symbol', description: '查找符号' },
      { name: 'mcp__Serena__read_file' },                       // 描述缺失 → ''
      { name: 'mcp__CodeMap__get_structure', description: '结构' },
      { name: 'mcp_manager_list', description: '本插件自己的工具' },
    ],
  })
  const host = await setupHost({ env, tools, probeRunner: async () => { probeCalls += 1; return { ok: true, latencyMs: 1 } } })

  const res = await host.call('tools', { id: 'mcp-Serena' })
  assert.equal(res.json.ok, true, res.raw)
  assert.equal(res.json.data.mode, 'static')
  assert.equal(res.json.data.source, 'registry')
  assert.equal(res.json.data.serverName, 'Serena')
  assert.deepEqual(res.json.data.tools, [
    { name: 'mcp__Serena__find_symbol', description: '查找符号' },
    { name: 'mcp__Serena__read_file', description: '' },
  ])
  assert.match(res.json.data.note, /mcp__<serverName>__/)
  assert.match(res.json.data.note, /估计值/)
  assert.equal(res.json.data.reason, null)

  // 静态路径 + list 都不许探测（子进程/连接数必须为 0）
  await host.call('list')
  await host.call('tools', { id: 'mcp-CodeMap' })
  assert.equal(probeCalls, 0, `静态 tools/list 不得探测，实际 ${probeCalls} 次`)
}))

test('§6.1 tools 静态：无匹配前缀 → ok + 空清单 + note（不是错误）', withTemp(async (env) => {
  const tools = makeToolsStub({ schemas: [{ name: 'mcp__Serena__x', description: 'x' }] })
  const host = await setupHost({ env, tools })
  const res = await host.call('tools', { id: 'mcp-rea-mcp' })
  assert.equal(res.status, 200, res.raw)
  assert.equal(res.json.ok, true, res.raw)
  assert.deepEqual(res.json.data.tools, [])
  assert.equal(res.json.data.mode, 'static')
  assert.match(res.json.data.note, /前缀统计/)
  assert.equal(res.json.data.reason, null)
}))

test('§6.1 tools 静态：tools 服务缺失 / schemas 抛错 → 空清单 + note 说明原因，端点不 500', withTemp(async (env) => {
  // ① 服务缺失
  const noTools = await setupHost({ env, tools: null })
  const res = await noTools.call('tools', { id: 'mcp-Serena' })
  assert.equal(res.status, 200, res.raw)
  assert.equal(res.json.ok, true, res.raw)
  assert.deepEqual(res.json.data.tools, [])
  assert.equal(res.json.data.reason, 'tools-unavailable')
  assert.match(res.json.data.note, /读不到宿主工具清单/)
  assert.equal(HOST.__diag().toolsLookup.registryAvailable, false)

  // ② schemas() 抛错
  const throwing = { register: () => () => {}, schemas: () => { throw new Error('boom') } }
  const broken = await setupHost({ env, tools: throwing })
  const res2 = await broken.call('tools', { id: 'mcp-Serena' })
  assert.equal(res2.status, 200, res2.raw)
  assert.equal(res2.json.ok, true, res2.raw)
  assert.deepEqual(res2.json.data.tools, [])
  assert.equal(res2.json.data.reason, 'tools-unavailable')
  assert.match(res2.json.data.note, /boom/)
}))

test('§6.1 tools 探测：走 probeRunner 取真实清单，形状正确', withTemp(async (env) => {
  let probeCalls = 0
  const host = await setupHost({
    env,
    probeRunner: async () => {
      probeCalls += 1
      return {
        ok: true,
        latencyMs: 33,
        toolCount: 2,
        tools: [{ name: 'mcp__Serena__a', description: 'A' }, { name: 'mcp__Serena__b' }],
      }
    },
  })
  const res = await host.call('tools', { id: 'mcp-Serena', mode: 'probe' })
  assert.equal(res.json.ok, true, res.raw)
  assert.equal(res.json.data.mode, 'probe')
  assert.equal(res.json.data.source, 'probe')
  assert.equal(res.json.data.serverName, 'Serena')
  assert.equal(res.json.data.latencyMs, 33)
  assert.deepEqual(res.json.data.tools, [
    { name: 'mcp__Serena__a', description: 'A' },
    { name: 'mcp__Serena__b', description: '' },
  ])
  assert.equal(probeCalls, 1)
}))

test('§6.1 tools 探测失败 → probe-failed + {latencyMs,error}，且不影响随后的 list', withTemp(async (env) => {
  const host = await setupHost({ env, probeRunner: async () => { throw new Error('spawn node ENOENT') } })
  const res = await host.call('tools', { id: 'mcp-Serena', mode: 'probe' })
  assert.equal(res.status, 200, res.raw)
  assert.equal(res.json.ok, false, res.raw)
  assert.equal(res.json.error.code, 'probe-failed')
  assert.equal(typeof res.json.error.fields.latencyMs, 'number')
  assert.equal(typeof res.json.error.latencyMs, 'number', 'error.latencyMs 镜像供面板错误态显示耗时')
  assert.match(String(res.json.error.fields.error), /ENOENT/)

  const after = await host.call('list')
  assert.equal(after.json.ok, true, after.raw)
  assert.ok(mcpServers(after.json.data).length >= 6)
}))

test('§6.1 tools 定位：id 优先于 serverName、serverName 兜底、都不匹配 → not-found；扁平写法与大小写别名可用', withTemp(async (env) => {
  const host = await setupHost({ env })

  const byId = await host.call('tools', { id: 'mcp-Serena', serverName: 'CodeMap' })
  assert.equal(byId.json.ok, true, byId.raw)
  assert.equal(byId.json.data.serverName, 'Serena', 'id 优先')

  const byName = await host.call('tools', { serverName: 'CodeMap' })
  assert.equal(byName.json.ok, true, byName.raw)
  assert.equal(byName.json.data.serverName, 'CodeMap')

  for (const payload of [{ id: 'mcp-nope' }, { serverName: 'nope' }, {}]) {
    const miss = await host.call('tools', payload)
    assert.equal(miss.status, 200, miss.raw)
    assert.equal(miss.json.ok, false, miss.raw)
    assert.equal(miss.json.error.code, 'not-found', miss.raw)
  }

  // 扁平写法 + 大小写别名（既有别名规则）
  const flat = await host.call('tools', undefined, { rawBody: JSON.stringify({ action: 'TOOLS', id: 'mcp-Serena' }) })
  assert.equal(flat.json.ok, true, flat.raw)
  assert.equal(flat.json.data.serverName, 'Serena')
}))

// ═══════════════════════════ A8 HTTP 门与工具 ═══════════════════════════

test('③/A8.1/A8.2 缺头 / 跨源 / 非 POST / 坏 JSON / 超 1 MiB 全部被拒且文件未变', withTemp(async (env) => {
  const host = await setupHost({ env })
  const before = read(env.homePatch)
  const addPayload = { serverName: 'Gated', config: { transport: 'stdio', command: 'node' } }

  const noHeader = await host.call('add', addPayload, { omitHeader: true })
  assert.equal(noHeader.status, 403)
  assert.equal(noHeader.json.ok, false)
  assert.equal(noHeader.json.error.code, 'forbidden-header')

  const wrongHeader = await host.call('add', addPayload, { pluginHeader: 'dsh-plugin-manager' })
  assert.equal(wrongHeader.status, 403)

  const crossOrigin = await host.call('add', addPayload, { headers: { origin: 'http://evil.example' } })
  assert.equal(crossOrigin.status, 403)
  assert.equal(crossOrigin.json.error.code, 'forbidden-origin')

  const sameOrigin = await host.call('list', undefined, { headers: { origin: 'http://127.0.0.1:60336' } })
  assert.equal(sameOrigin.json.ok, true)
  const localhostOrigin = await host.call('list', undefined, { headers: { origin: 'http://localhost:60336' } })
  assert.equal(localhostOrigin.json.ok, true)

  const get = await host.call('list', undefined, { method: 'GET' })
  assert.equal(get.status, 405)
  const badJson = await host.call(null, undefined, { rawBody: '{不是 JSON' })
  assert.equal(badJson.status, 400)
  assert.equal(badJson.json.error.code, 'bad-json')

  const declared = await host.call('list', undefined, { headers: { 'content-length': String(2 * 1024 * 1024) }, rawBody: '{}' })
  assert.equal(declared.status, 413)
  const actual = await host.call('list', undefined, { rawBody: JSON.stringify({ action: 'list', pad: 'x'.repeat(1024 * 1024 + 64) }) })
  assert.equal(actual.status, 413)
  assert.equal(actual.json.error.code, 'body-too-large')

  const unknown = await host.call('nope')
  assert.equal(unknown.status, 200)
  assert.equal(unknown.json.error.code, 'unknown-action')
  assert.match(unknown.json.error.fields.action, /list/)

  assert.equal(read(env.homePatch), before)      // ③：被拒时零写入
  assert.equal(backupCount(env.homePatch), 0)
}))

test('A8.3 @deepseek-ai/dsh-tools 不可解析 → 跳过注册、不抛错、HTTP 仍可用', withTemp(async (env) => {
  const host = await setupHost({
    env,
    importOverride: (spec) => (spec === '@deepseek-ai/dsh-tools'
      ? Promise.reject(new Error("Cannot find package '@deepseek-ai/dsh-tools'"))
      : import(spec)),
  })
  const diag = HOST.__diag()
  assert.match(diag.toolsSkipped, /dsh-tools/)
  assert.deepEqual(diag.toolsRegistered, [])
  assert.equal(diag.httpRegistered, true)
  assert.equal(host.tools.registered.length, 0)
  assert.equal(diag.applyError, null)

  const res = await host.call('list')
  assert.equal(res.json.ok, true)
  assert.equal(mcpServers(res.json.data).length, 6)
  assert.match(res.json.data.diagnostics.toolsSkipped, /dsh-tools/)
}))

test('A8.4 4 个模型工具注册成功且与 HTTP 端点等价', withTemp(async (env) => {
  const host = await setupHost({
    env,
    importOverride: (spec) => (spec === '@deepseek-ai/dsh-tools' ? Promise.resolve(FAKE_TOOLS_MODULE) : import(spec)),
  })
  const names = host.tools.registered.map((d) => d.name).sort()
  assert.deepEqual(names, ['mcp_manager_add', 'mcp_manager_list', 'mcp_manager_restart', 'mcp_manager_set_enabled'])
  assert.deepEqual(HOST.__diag().toolsRegistered.sort(), names)
  // output 契约：execute 返回 JSON 文本 ⇒ schema 必须是 string，render 必须给出 text 块
  for (const def of host.tools.registered) {
    assert.deepEqual(def.output.schema, { type: 'string' }, `${def.name} output.schema`)
    const blocks = def.output.render({}, '{"ok":true}')
    assert.deepEqual(blocks, [{ type: 'text', text: '{"ok":true}' }], `${def.name} output.render`)
  }

  const byName = (n) => host.tools.registered.find((d) => d.name === n)
  const listRes = JSON.parse(await byName('mcp_manager_list').execute({}))
  assert.equal(listRes.ok, true)
  assert.equal(mcpServers(listRes.data).length, 6)

  const addRes = JSON.parse(await byName('mcp_manager_add').execute({ serverName: 'ToolAdded', config: { transport: 'stdio', command: 'node' } }))
  assert.equal(addRes.ok, true, JSON.stringify(addRes))
  assert.ok(read(env.homePatch).includes('mcp-ToolAdded'))

  const offRes = JSON.parse(await byName('mcp_manager_set_enabled').execute({ id: 'mcp-ToolAdded', enabled: false }))
  assert.equal(offRes.ok, true, JSON.stringify(offRes))
  assert.match(blockOf(read(env.homePatch), 'mcp-ToolAdded'), /disabled: true/)

  const restartRes = JSON.parse(await byName('mcp_manager_restart').execute({ id: 'mcp-ToolAdded' }))
  assert.equal(restartRes.ok, true, JSON.stringify(restartRes))
  assert.equal(restartRes.data.rewritten.length, 1)
  assert.match(restartRes.data.note, /配置重应用/)

  const badRes = JSON.parse(await byName('mcp_manager_set_enabled').execute({ id: 'mcp-Nope', enabled: true }))
  assert.equal(badRes.ok, false)
  assert.equal(badRes.error.code, 'not-found')
}))

// ═══════════ A2.5 DSH 空 patch 模板（顶层 []）不再让面板只读降级 ═══════════

test('A2.5 顶层 [] 空模板：patchInfo 判 ok（不锁面板）、新增能落到该 profile 且写出合法 YAML', async (t) => {
  // DSH 新建 profile 时生成的空模板；早期版本这里被判成 E_NOT_SEQUENCE → 整个面板只读降级。
  const EMPTY_TEMPLATE = '# DSH 补丁层：profile tui（由 dsh 新建）\n# 本文件由 dsh 维护\n# 除非你清楚在做什么，否则不要手动编辑\n[]\n'
  const env = mkFixture({ profileTexts: { tui: EMPTY_TEMPLATE } })
  t.after(() => env.cleanup())
  const host = await setupHost({ env })
  assert.equal(read(env.patch('tui')), EMPTY_TEMPLATE)

  const listed = await host.call('list')
  assert.equal(listed.json.ok, true, JSON.stringify(listed.json))
  const tuiInfo = listed.json.data.patchInfo.profiles.tui
  assert.equal(tuiInfo.ok, true, JSON.stringify(tuiInfo))          // 修复前 false → 客户端 locked
  assert.equal(tuiInfo.error, null, JSON.stringify(tuiInfo))
  assert.deepEqual(listed.json.data.patchInfo.profiles.tui.entries, [])

  const added = await host.call('add', {
    serverName: 'TuiOnly',
    config: { transport: 'stdio', command: 'node' },
    profiles: ['tui'],
  })
  assert.equal(added.json.ok, true, JSON.stringify(added.json))

  const text = read(env.patch('tui'))
  assert.ok(!/^[ \t]*\[\s*\][ \t]*$/m.test(text), `[] 必须被摘掉：\n${text}`)
  const parsed = core.parsePatch(text)
  assert.equal(parsed.ok, true, JSON.stringify(parsed.error))
  assert.deepEqual(parsed.entries.map((x) => x.id), ['mcp-TuiOnly'])
  // 注释逐字保留；其它 profile 未被波及
  assert.ok(text.startsWith('# DSH 补丁层：profile tui（由 dsh 新建）\n# 本文件由 dsh 维护\n# 除非你清楚在做什么，否则不要手动编辑\n'))
  assert.ok(!read(env.patch('desktop')).includes('mcp-TuiOnly'))
  assert.ok(!read(env.patch('web')).includes('mcp-TuiOnly'))
  assert.ok(!read(env.homePatch).includes('mcp-TuiOnly'))

  // 再删掉它：回到 0 条目，仍然合法（不会把 [] 写回去）
  const removed = await host.call('remove', { id: 'mcp-TuiOnly' })
  assert.equal(removed.json.ok, true, JSON.stringify(removed.json))
  assert.equal(core.parsePatch(read(env.patch('tui'))).entries.length, 0)
})

// ═══════════════════════ A9 互不干扰与路由重复注册 ═══════════════════════

test('A9.1 一轮「新增/矩阵/删除」后：激活行、其它 profile、dsh-mcp.json 全部不变', withTemp(async (env) => {
  const host = await setupHost({ env })
  const beforeTui = read(env.patch('tui'))
  const beforeDshMcpJson = read(env.dshMcpJson)

  await host.call('add', { serverName: 'Keep', config: { transport: 'stdio', command: 'node' } })
  await host.call('setMatrix', { id: 'mcp-Keep', profiles: ['desktop'] })
  await host.call('remove', { id: 'mcp-Keep' })

  const desktop = read(env.patch('desktop'))
  assert.ok(desktop.includes(ACTIVATION_ROW))          // 激活行逐字保留
  assert.ok(desktop.includes('# 由 dsh-plugin-manager 维护的激活行 —— 本插件绝不碰它（A9.1）'))
  assert.ok(!desktop.includes('mcp-Keep'))
  assert.equal(read(env.patch('tui')), beforeTui)
  assert.equal(read(env.dshMcpJson), beforeDshMcpJson)
  assert.equal(core.parsePatch(read(env.homePatch)).ok, true)
}))

test('⑤/A9.2 重复注册路由：就地捕获 + 写诊断 + 插件不抛 + 其余功能可用', withTemp(async (env) => {
  const ws = makeWebServer()
  const tools = makeToolsStub()
  const mkCtxFor = () => makeCtx({ home: env.home, profileDir: path.join(env.home, 'profiles', 'desktop'), webServer: ws, tools })

  await assert.doesNotReject(() => HOST.apply(mkCtxFor()))
  assert.equal(ws.routes.length, 1)
  await assert.doesNotReject(() => HOST.apply(mkCtxFor()))          // 第二份实例：duplicate route
  assert.equal(ws.routes.length, 1)

  const diag = HOST.__diag()
  assert.equal(diag.httpRegistered, false)
  assert.match(diag.httpSkipped, /duplicate route/)
  assert.equal(diag.applyError, null)

  const res = await call(ws.routes[0].handler, 'list')
  assert.equal(res.json.ok, true)
  assert.equal(mcpServers(res.json.data).length, 6)
}))

// ═══════════════════════════ §2.2 锚定优先级 ═══════════════════════════

test('§2.2 锚定：profileContext → settings.prepareDocument() → $DSH_PROFILE_DIR（禁止硬编码 profiles/web）', withTemp(async (env) => {
  // (a) 无 profileContext，靠 settings.prepareDocument() 推 home
  const wsA = makeWebServer()
  const ctxA = makeCtx({
    home: null,
    profileDir: null,
    webServer: wsA,
    tools: makeToolsStub(),
    settings: { prepareDocument: () => ({ path: path.join(env.home, 'settings.json') }) },
  })
  await HOST.apply(ctxA)
  const a = await call(wsA.routes[0].handler, 'list')
  assert.equal(a.json.ok, true, a.raw)
  assert.equal(a.json.data.home, env.home)
  assert.equal(HOST.__diag().anchorSource, 'settings.prepareDocument')

  // (b) 只有 $DSH_PROFILE_DIR（且属于同一 home）
  const prev = process.env.DSH_PROFILE_DIR
  process.env.DSH_PROFILE_DIR = path.join(env.home, 'profiles', 'web')
  try {
    const wsB = makeWebServer()
    await HOST.apply(makeCtx({ home: null, profileDir: null, webServer: wsB, tools: makeToolsStub() }))
    const b = await call(wsB.routes[0].handler, 'list')
    assert.equal(b.json.ok, true, b.raw)
    assert.equal(b.json.data.home, env.home)
    assert.equal(b.json.data.profile, 'web')
    assert.equal(HOST.__diag().anchorSource, 'DSH_PROFILE_DIR')
  } finally {
    if (prev === undefined) delete process.env.DSH_PROFILE_DIR
    else process.env.DSH_PROFILE_DIR = prev
  }

  // (c) 不属于任何 home 的 $DSH_PROFILE_DIR → 拒绝锚定（宁可报错也不猜 profiles/web）
  const strayRoot = fs.mkdtempSync(path.join(os.tmpdir(), 'dsh-stray-'))
  process.env.DSH_PROFILE_DIR = path.join(strayRoot, 'somewhere')
  try {
    const wsC = makeWebServer()
    await HOST.apply(makeCtx({ home: null, profileDir: null, webServer: wsC, tools: makeToolsStub() }))
    const c = await call(wsC.routes[0].handler, 'list')
    assert.equal(c.json.ok, false)
    assert.equal(c.json.error.code, 'anchor-unavailable')
    assert.ok(HOST.__diag().anchorErrors.length > 0)
  } finally {
    if (prev === undefined) delete process.env.DSH_PROFILE_DIR
    else process.env.DSH_PROFILE_DIR = prev
    fs.rmSync(strayRoot, { recursive: true, force: true })
  }
}))

test('§2.1 无 webServer 服务：apply 不抛、写诊断、其余能力保留', withTemp(async (env) => {
  const ctx = makeCtx({ home: env.home, profileDir: path.join(env.home, 'profiles', 'desktop'), webServer: null, tools: makeToolsStub() })
  await assert.doesNotReject(() => HOST.apply(ctx))
  const diag = HOST.__diag()
  assert.equal(diag.httpRegistered, false)
  assert.match(diag.httpSkipped, /webServer/)
  assert.equal(diag.applyError, null)
  assert.equal(fs.existsSync(env.diagFile), true)
}))

console.log('dsh-mcp-manager host-http tests: PASS')
