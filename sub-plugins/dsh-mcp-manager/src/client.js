// dsh-mcp-manager: CLIENT half — the「MCP 服务器」tab.
//
// One tab inside the core「本地插件」settings entry (settings.localPlugins.tab,
// order 30). The entry itself is declared by dsh-plugin-manager, so this client
// only contributes the child slot row and renders its panel — no Settings nav
// row of its own.
//
// Every fact on screen comes from the host half's single endpoint
// POST /__dsh-mcp-manager/api with body { endpoint, payload }: the panel never
// touches the filesystem, the profile patch files or the host registry. The
// panel is therefore a pure view over `list` plus ten verbs
// (add / update / remove / setEnabled / setMatrix / getDefaults / setDefaults /
// probe / migrate / patchInfo).
//
// Degradation contract: the endpoint may simply not be there (host half not
// loaded, route registration failed, older DSH build). In that case —
// non-2xx, non-JSON body, network error, timeout — the panel shows
// 「宿主端点不可用」 plus the reason and the host `diagnostics` lines, and the
// rest of the settings page keeps rendering. This client MUST NOT throw and
// MUST NOT render an empty page.
//
// Layout of this file: constants → locale dictionaries → pure helpers →
// one stateful component (McpServersPanel) with pure render helpers → apply().
// The render helpers are deliberately plain functions (no hooks): calling them
// inside the panel keeps the hook order of the single stateful component stable,
// which is also what the offline bundle test renders against.
//
// Bundle format (client-modules protocol): classic script registering a factory
// via window.__ModuleLoader__.load({ id, factory }); the factory receives the
// module-table `require` (react is a seeded word) and returns { apply, inject }.
// No JSX — plain React.createElement + inline styles on --dsw-* tokens.
window.__ModuleLoader__.load({
  id: 'dsh-mcp-manager',
  factory: (require) => {
    'use strict'
    const React = require('react')
    const { useCallback, useEffect, useRef, useState } = React

    // --- constants ------------------------------------------------------------

    const NS = 'dsh-mcp-manager'
    const TAB_SLOT = 'settings.localPlugins.tab'
    const TAB_ID = 'mcp-servers'
    const TAB_ORDER = 30

    /** 宿主半注册的精确路由；客户端唯一的对外通道。 */
    const API = '/__dsh-mcp-manager/api'
    /** 同源/CSRF 门禁头，宿主半按此值校验，缺了会被直接拒。 */
    const PLUGIN_HEADER = 'dsh-mcp-manager'
    /** 多个端点共用的空载荷，避免 body 里出现 undefined。 */
    const NO_PAYLOAD = {}

    const SERVER_NAME_RE = /^[A-Za-z0-9_-]{1,32}$/
    const ENTRY_ID_RE = /^[A-Za-z0-9_.-]{1,64}$/
    const TRANSPORTS = ['stdio', 'streamable-http']

    /** 内置兜底：state.json 缺失/解析失败时宿主也用这套（spec: 全局默认参数）。 */
    const FALLBACK_DEFAULTS = {
      toolCallTimeoutMs: 60000,
      failOnStartupError: false,
      maxInstructionBytes: 32768,
      probeTimeoutMs: 8000,
      defaultTransport: 'stdio',
    }
    /** state.json 里数值字段的白名单（面板只渲染这些，避免把未知键写回去）。 */
    const NUMERIC_DEFAULTS = ['toolCallTimeoutMs', 'maxInstructionBytes', 'probeTimeoutMs']

    /** 静态状态键 → 文案键；宿主给了未知值就原样显示。宿主枚举：pending|loading|active|failed|disabled|null。 */
    const STATIC_STATE_KEYS = {
      unloaded: 'stateUnloaded',
      notloaded: 'stateUnloaded',
      pending: 'stateUnloaded',
      loading: 'stateLoading',
      active: 'stateActive',
      connected: 'stateActive',
      failed: 'stateFailed',
      error: 'stateFailed',
      disabled: 'stateDisabled',
      inactive: 'stateDisabled',
      unloading: 'stateUnloading',
    }

    // --- locale ---------------------------------------------------------------

    const zhDict = {
      'tab.title': 'MCP 服务器',
      intro: '受管的 MCP 服务器定义就在 profile 的 cordis.patch.yml 里：全员生效的写在 DSH home 层一条，只对部分 profile 生效的写进那些 profile。本插件额外提供生效矩阵、全局默认参数与按需连接测试。',
      profileLine: '本 profile：{profile}　全局默认层：{home}',
      refresh: '刷新',
      busy: '处理中…',
      busyWith: '处理中：{action}',

      // 端点不可用（降级面）
      hostUnavailable: '宿主端点不可用',
      hostUnavailableHint: '宿主半没有响应 {api}（插件未加载、加载失败，或该 DSH 版本不支持精确路由）。面板其它部分照常可用。',
      hostUnavailableRetry: '重试',
      hostUnavailableCode: '错误码：{code}',
      hostUnavailableFields: '字段：{fields}',
      diagnostics: '宿主诊断',
      diagnosticsEmpty: '（宿主未提供诊断）',

      // 补丁文件与备份
      files: '写入位置',
      filesHint: '受管条目会写进下列文件；每次写入前宿主都把原文件备份为 <文件名>.bak-<时间戳>，只保留最近 10 份。',
      filesHome: '全局层（所有 profile）',
      filesProfile: '本 profile',
      filesBackups: '备份 {n} 份',
      filesProfileOf: 'profile {name}',
      fileMissing: '文件不存在',
      fileUnparsable: '无法解析',
      fileEntries: '受管条目 {n} 条',
      filesReload: '重新读取',

      // 列表
      total: '共 {n} 台',
      enabledOf: '{on}/{total} 台已启用',
      empty: '本机还没有受管的 MCP 服务器。',
      emptyHint: '点「新增服务器」写一条定义（也可以先点「迁移旧标记」收编已有条目）。',
      colId: '条目 id',
      colServerName: 'serverName',
      colTransport: 'transport',
      colLocation: '来源层',
      colProfiles: '生效 profile',
      colState: '静态状态',
      colTools: '工具数估计',
      layerHome: '全局层（home）',
      layerProfile: '仅 profile 覆盖',
      layerProfileOnly: '仅 profile 层',
      layerConflict: '两层同时存在（布局漂移）',
      toolsCount: '{n} 个',
      toolsDash: '—',
      toolsHint: '按 mcp__<serverName>__ 前缀静态统计；工具名超长会退化成改名后的前缀，因此这是估计值，为 0 时显示「—」。',
      stateUnloaded: '未加载',
      stateNoHost: '未上报',
      stateLoading: '加载中',
      stateActive: '已激活',
      stateFailed: '失败',
      stateDisabled: '已停用',
      stateUnloading: '卸载中',
      stateUnknown: '未知（{raw}）',
      profilesAll: '全部 profile',
      profilesNone: '全不生效',
      profilesCount: '{n} 个 profile',

      // 布局漂移
      drift: '布局待修复',
      driftHint: '磁盘上的行分布与矩阵期望不一致（常见原因：新增/删除 profile 目录，或手工搬动过行块）。宿主不会静默改写，请按提示操作或点「刷新」后重看。',
      driftConfirm: '待确认',
      driftAction: '建议动作：{action}',
      driftTarget: '目标文件：{target}',

      // 矩阵
      matrixTitle: '生效矩阵',
      matrixHint: '勾选 = 该服务器在那个 profile 生效。全员勾选 → 只写全局层一条；部分勾选 → 写进被选中的 profile；全不勾选 → 全局层保留一条 disabled 行。',
      matrixThis: '（本 profile）',
      matrixConfirm: '矩阵变更会改写：{targets}。本 profile 热生效、其它 profile 待其自身重载。继续？',
      matrixApplied: '矩阵已更新：{targets}',
      matrixReloadHint: '本 profile 热生效；其它 profile 待其自身重载。',
      matrixFailed: '矩阵更新失败',
      matrixLocked: '端点不可用时不能改矩阵',

      // 行操作
      enabled: '已启用',
      disabled: '未启用',
      toggleTitle: '启用/停用（写进条目行内的 disabled）',
      edit: '编辑',
      collapse: '收起',
      remove: '删除',
      removeConfirm: '删除 {id} 会从 patch 里移除它的行块（写前备份）。确定删除？',
      removed: '已删除 {id}',
      removeFailed: '删除失败',

      // 探测
      probe: '测试连接',
      probeBusy: '连接中…',
      probeSpawnHint: '「测试连接」会真的起一次子进程（stdio 启动命令、http 建连接），按 probeTimeoutMs 限时，返回后关闭客户端；失败不影响条目与面板。',
      probeOk: '✓ {ms}ms · {n} 个工具',
      probeOkNoTools: '✓ {ms}ms · 未列出工具',
      probeFail: '✗ {error}（{ms}ms）',
      probeFailed: '测试失败',
      probeNoLatency: '—',

      // 工具清单（每行「工具」按钮 → 对话框）
      tools: '工具',
      toolsTitle: '工具：{name}（{n} 个）',
      toolsTitleEmpty: '工具：{name}',
      toolsBadgeStatic: '本机已注册',
      toolsBadgeProbe: '真探测',
      toolsLoading: '正在读取工具清单…',
      toolsProbeLoading: '正在真探测（会启动一次 MCP 服务器子进程）…',
      toolsEmpty: '没有可显示的工具：该服务器可能未在本 profile 生效、尚未连接成功，或尚未注册任何工具。',
      toolsProbe: '真探测',
      toolsProbeHint: '「真探测」会启动一次 MCP 服务器子进程（按 probeTimeoutMs 限时，返回后关闭）。',
      toolsStaticHint: '「本机已注册」取自核心工具注册表，是当前进程已注册的工具名，可能与服务器实际工具数不同。',
      toolsRetry: '重试',
      toolsClose: '关闭',
      toolsCopy: '复制',
      toolsCopied: '已复制',
      toolsLatency: '延迟 {ms}ms',
      toolsFailed: '工具清单读取失败',

      // 新增/编辑表单
      add: '新增服务器',
      addTitle: '新增 MCP 服务器',
      editTitle: '编辑 {id}',
      save: '保存',
      cancel: '取消',
      confirm: '确认',
      create: '添加',
      fieldId: '条目 id',
      idPlaceholder: '留空 = mcp-<serverName>',
      idHint: '写进 patch 的条目 id（也是标记 # dsh-mcp-manager:2:server:<id> 的后缀）。',
      fieldServerName: 'serverName',
      serverNamePlaceholder: '1-32 位字母、数字、下划线或短横线，跨服务器唯一',
      fieldTransport: 'transport',
      fieldCommand: 'command',
      commandPlaceholder: '例如 npx',
      fieldArgs: 'args',
      argsHint: '每行一个参数（也可以空格分隔）。',
      fieldEnv: 'env',
      fieldEnvHint: '每行 key=value；路径按系统写法填（Windows 用 \\，macOS/Linux 用 /）。',
      fieldCwd: 'cwd',
      fieldUrl: 'url',
      urlPlaceholder: 'https://host/mcp',
      fieldHeaders: 'headers',
      fieldHeadersHint: '每行 key=value，例如 Authorization=Bearer xxx',
      fieldTimeout: 'toolCallTimeoutMs',
      fieldTimeoutHint: '仅作用于工具调用（tools/call），默认 {n}。',
      fieldMaxBytes: 'maxInstructionBytes',
      fieldMaxBytesHint: '单条指令字节上限，默认 {n}。',
      fieldFailStartup: 'failOnStartupError',
      fieldFailStartupHint: '启动失败是否让整轮加载失败，默认关。',
      fieldLevel: '写入层级',
      levelHome: '全局层（所有 profile）',
      levelProfileOption: '仅 {profile} 生效',
      fieldsTitle: '原始 YAML 兜底',
      fieldsHint: 'YAML 提交会先由宿主做结构化校验，通过后按与表单相同的方式写盘；这里填整段 config 的 YAML（不含 - insert: 外壳）。改过之后以这段 YAML 为准，表单字段只作兜底。',
      fieldsDirty: '● 以 YAML 为准',
      fieldsReset: '还原为表单生成',
      fieldsErrors: '宿主校验未通过（输入已保留）：',
      fieldsShow: '展开原始 YAML',
      fieldsHide: '收起原始 YAML',

      // 只读降级
      readOnlyTitle: '只读降级',
      readOnlyHint: 'patch 文件无法解析，宿主已进入只读：所有写端点都会被拒绝，文件不改、也不产生备份。修好 YAML 后点「重新读取」。',
      rawEntry: '原始 YAML',

      // 校验
      validationFailed: '请先补齐表单：{fields}',
      needId: '请填写条目 id。',
      needIdPattern: '条目 id 只允许字母、数字、点、下划线、短横线（1-64 位）。',
      needIdTaken: '这个条目 id 已被占用。',
      needName: '请填写 serverName。',
      needNamePattern: 'serverName 必须是 1-32 位字母、数字、下划线或短横线。',
      needNameTaken: '这个 serverName 已被另一台服务器占用。',
      needCommand: 'stdio 传输必须填 command。',
      needUrl: 'http 传输必须填 url。',
      needNumber: '请填一个大于 0 的整数。',
      hostFields: '宿主拒绝了这次写入：{fields}',
      hostFieldsGeneric: '（未指出字段）',

      added: '已新增 {id}',
      saved: '已保存 {id}',
      saveFailed: '保存失败',
      addFailed: '新增失败',
      loadFailed: '读取服务器列表失败',

      // 全局默认参数
      defaultsTitle: '全局默认参数',
      defaultsHint: '新增表单以此预填；保存服务器时这些值会落成条目 config 里的具体字段，默认值本身不写进任何 cordis.patch.yml。',
      defaultsShow: '展开默认参数',
      defaultsHide: '收起默认参数',
      defaultsSave: '保存默认参数',
      defaultsSaved: '默认参数已保存',
      defaultsFailed: '保存默认参数失败',
      defaultsReset: '恢复内置默认',
      defaultsLoadFailed: '读取默认参数失败',
      defaultsTransport: '默认 transport',
      defaultsProbeTimeout: 'probeTimeoutMs',
      defaultsProbeTimeoutHint: '「测试连接」的握手超时，默认 {n}。',
      fallbackNotice: '默认参数来自内置值（宿主 state.json 缺失或不可读）。',

      // 迁移
      migrate: '迁移旧标记',
      migrateTitle: '迁移旧标记',
      migrateHint: '把旧标记 # dsh-mcp-manager:server:<id> / :disable:<id> 改写成 :2: 新标记，并给形态匹配（- insert: 内、name 为 @deepseek-ai/dsh-mcp-client）但无标记的条目补上标记。',
      migratePreview: '预览迁移',
      migrateNothing: '没有需要迁移的条目。',
      migratePlan: '将改写 {rewrites} 条、补齐 {additions} 条、收敛 {converged} 条、跳过 {skipped} 条。',
      migrateBackup: '执行前宿主会把每个目标文件备份为 <文件名>.bak-<时间戳>；迁移幂等，再次执行不产生写入。',
      migrateSkipped: '跳过原因：{reasons}',
      migrateConfirmText: '确认执行迁移？',
      migrated: '迁移完成：改写 {rewrites}、补齐 {additions}、收敛 {converged}、跳过 {skipped}',
      migrateFailed: '迁移失败',
      close: '关闭',
    }

    const enDict = {
      'tab.title': 'MCP servers',
      intro: 'Managed MCP definitions live in the profile cordis.patch.yml: servers that apply to every profile are one row in the DSH home layer, servers that apply to a subset live in those profiles. This plugin adds the per-profile matrix, global defaults and an on-demand connection test.',
      profileLine: 'This profile: {profile}　Home layer: {home}',
      refresh: 'Refresh',
      busy: 'Working…',
      busyWith: 'Working: {action}',

      hostUnavailable: 'Host endpoint unavailable',
      hostUnavailableHint: 'The host half did not answer {api} (plugin not loaded, load failed, or this DSH build has no exact routes). The rest of the panel keeps working.',
      hostUnavailableRetry: 'Retry',
      hostUnavailableCode: 'Code: {code}',
      hostUnavailableFields: 'Fields: {fields}',
      diagnostics: 'Host diagnostics',
      diagnosticsEmpty: '(no diagnostics reported)',

      files: 'Write targets',
      filesHint: 'Managed rows are written into the files below; before every write the host backs the file up to <name>.bak-<timestamp>, keeping the 10 most recent.',
      filesHome: 'Home layer (all profiles)',
      filesProfile: 'This profile',
      filesBackups: 'backups: {n}',
      filesProfileOf: 'profile {name}',
      fileMissing: 'missing',
      fileUnparsable: 'unparsable',
      fileEntries: '{n} managed rows',
      filesReload: 'Reload',

      total: '{n} servers',
      enabledOf: '{on}/{total} enabled',
      empty: 'No managed MCP server on this machine yet.',
      emptyHint: 'Use "Add server" to write one (or "Migrate legacy markers" to adopt existing rows).',
      colId: 'Entry id',
      colServerName: 'serverName',
      colTransport: 'transport',
      colLocation: 'Layer',
      colProfiles: 'Active profiles',
      colState: 'Static state',
      colTools: 'Tool estimate',
      layerHome: 'Home layer',
      layerProfile: 'Profile override',
      layerProfileOnly: 'Profile layer only',
      layerConflict: 'Present in both layers (layout drift)',
      toolsCount: '{n}',
      toolsDash: '—',
      toolsHint: 'Counted statically by the mcp__<serverName>__ prefix; over-long tool names degrade to a renamed prefix, so this is an estimate and 0 is shown as "—".',
      stateUnloaded: 'Not loaded',
      stateNoHost: 'Not reported',
      stateLoading: 'Loading',
      stateActive: 'Active',
      stateFailed: 'Failed',
      stateDisabled: 'Disabled',
      stateUnloading: 'Unloading',
      stateUnknown: 'Unknown ({raw})',
      profilesAll: 'all profiles',
      profilesNone: 'no profile',
      profilesCount: '{n} profiles',

      drift: 'Layout drift',
      driftHint: 'Rows on disk no longer match the matrix intent (usually a profile directory was added/removed, or a row block was moved by hand). The host never rewrites silently: act on the hint or refresh.',
      driftConfirm: 'Needs confirmation',
      driftAction: 'Suggested action: {action}',
      driftTarget: 'Target file: {target}',

      matrixTitle: 'Enable matrix',
      matrixHint: 'Checked = the server is active in that profile. All checked writes one row in the home layer; a subset writes into the selected profiles; none keeps one disabled row in the home layer.',
      matrixThis: '(this profile)',
      matrixConfirm: 'Changing the matrix rewrites: {targets}. This profile reloads hot; other profiles pick it up on their own reload. Continue?',
      matrixApplied: 'Matrix updated: {targets}',
      matrixReloadHint: 'This profile reloads hot; other profiles wait for their own reload.',
      matrixFailed: 'Matrix update failed',
      matrixLocked: 'The matrix needs a reachable host endpoint',

      enabled: 'Enabled',
      disabled: 'Disabled',
      toggleTitle: 'Enable/disable (writes disabled into the row)',
      edit: 'Edit',
      collapse: 'Collapse',
      remove: 'Delete',
      removeConfirm: 'Deleting {id} removes its row block from the patch (with a backup first). Delete it?',
      removed: 'Deleted {id}',
      removeFailed: 'Delete failed',

      probe: 'Test connection',
      probeBusy: 'Connecting…',
      probeSpawnHint: '"Test connection" really spawns a child process (stdio runs the command, http opens a connection), bounded by probeTimeoutMs, and closes the client afterwards; a failure leaves the row and the panel untouched.',
      probeOk: '✓ {ms}ms · {n} tools',
      probeOkNoTools: '✓ {ms}ms · no tools listed',
      probeFail: '✗ {error} ({ms}ms)',
      probeFailed: 'Probe failed',
      probeNoLatency: '—',

      tools: 'Tools',
      toolsTitle: 'Tools: {name} ({n})',
      toolsTitleEmpty: 'Tools: {name}',
      toolsBadgeStatic: 'registered locally',
      toolsBadgeProbe: 'live probe',
      toolsLoading: 'Loading the tool list…',
      toolsProbeLoading: 'Probing live (this spawns one MCP server child process)…',
      toolsEmpty: 'No tools to show: this server may not be effective in this profile, may not have connected yet, or registers no tools.',
      toolsProbe: 'Live probe',
      toolsProbeHint: '"Live probe" spawns one MCP server child process (bounded by probeTimeoutMs, closed afterwards).',
      toolsStaticHint: '"registered locally" comes from the core tool registry: the tool names registered in this process, which may differ from the server\'s real tool count.',
      toolsRetry: 'Retry',
      toolsClose: 'Close',
      toolsCopy: 'Copy',
      toolsCopied: 'Copied',
      toolsLatency: '{ms}ms',
      toolsFailed: 'Could not load the tool list',

      add: 'Add server',
      addTitle: 'Add MCP server',
      editTitle: 'Edit {id}',
      save: 'Save',
      cancel: 'Cancel',
      confirm: 'Confirm',
      create: 'Add',
      fieldId: 'Entry id',
      idPlaceholder: 'blank = mcp-<serverName>',
      idHint: 'Entry id written into the patch (also the suffix of # dsh-mcp-manager:2:server:<id>).',
      fieldServerName: 'serverName',
      serverNamePlaceholder: '1-32 letters, digits, underscore or dash; unique across servers',
      fieldTransport: 'transport',
      fieldCommand: 'command',
      commandPlaceholder: 'e.g. npx',
      fieldArgs: 'args',
      argsHint: 'One argument per line (spaces also work).',
      fieldEnv: 'env',
      fieldEnvHint: 'One key=value per line; write paths the way the OS does (\\ on Windows, / elsewhere).',
      fieldCwd: 'cwd',
      fieldUrl: 'url',
      urlPlaceholder: 'https://host/mcp',
      fieldHeaders: 'headers',
      fieldHeadersHint: 'One key=value per line, e.g. Authorization=Bearer xxx',
      fieldTimeout: 'toolCallTimeoutMs',
      fieldTimeoutHint: 'Tool calls (tools/call) only; default {n}.',
      fieldMaxBytes: 'maxInstructionBytes',
      fieldMaxBytesHint: 'Per-instruction byte cap; default {n}.',
      fieldFailStartup: 'failOnStartupError',
      fieldFailStartupHint: 'Whether a startup failure fails the whole load; default off.',
      fieldLevel: 'Target layer',
      levelHome: 'Home layer (all profiles)',
      levelProfileOption: '{profile} only',
      fieldsTitle: 'Raw YAML fallback',
      fieldsHint: 'Submitting YAML makes the host parse and validate it structurally, then write it the same way as the form; put the whole config YAML here (no - insert: wrapper). Once edited, this YAML wins and the form fields are only a fallback.',
      fieldsDirty: '● YAML wins now',
      fieldsReset: 'Reset to the generated form',
      fieldsErrors: 'Host validation failed (your input was kept):',
      fieldsShow: 'Show raw YAML',
      fieldsHide: 'Hide raw YAML',

      readOnlyTitle: 'Read-only fallback',
      readOnlyHint: 'A patch file does not parse, so the host is read-only: every write endpoint is refused, no file is touched and no backup is made. Fix the YAML and press Reload.',
      rawEntry: 'Raw YAML',

      validationFailed: 'Fill in the form first: {fields}',
      needId: 'Fill in the entry id.',
      needIdPattern: 'The entry id allows letters, digits, dot, underscore and dash (1-64).',
      needIdTaken: 'That entry id is already taken.',
      needName: 'Fill in serverName.',
      needNamePattern: 'serverName must be 1-32 letters, digits, underscore or dash.',
      needNameTaken: 'That serverName belongs to another server.',
      needCommand: 'stdio requires a command.',
      needUrl: 'http requires a url.',
      needNumber: 'Enter an integer greater than 0.',
      hostFields: 'The host rejected this write: {fields}',
      hostFieldsGeneric: '(no field named)',

      added: 'Added {id}',
      saved: 'Saved {id}',
      saveFailed: 'Save failed',
      addFailed: 'Add failed',
      loadFailed: 'Could not read the server list',

      defaultsTitle: 'Global defaults',
      defaultsHint: 'The add form starts from these values; saving a server lands them as concrete fields inside that entry config. The defaults themselves never go into any cordis.patch.yml.',
      defaultsShow: 'Show defaults',
      defaultsHide: 'Hide defaults',
      defaultsSave: 'Save defaults',
      defaultsSaved: 'Defaults saved',
      defaultsFailed: 'Saving defaults failed',
      defaultsReset: 'Restore built-ins',
      defaultsLoadFailed: 'Could not read the defaults',
      defaultsTransport: 'Default transport',
      defaultsProbeTimeout: 'probeTimeoutMs',
      defaultsProbeTimeoutHint: 'Handshake timeout of "Test connection"; default {n}.',
      fallbackNotice: 'Defaults come from the built-in values (host state.json missing or unreadable).',

      migrate: 'Migrate legacy markers',
      migrateTitle: 'Migrate legacy markers',
      migrateHint: 'Rewrites the legacy markers # dsh-mcp-manager:server:<id> / :disable:<id> into the :2: form, and adds a marker to shape-matching rows (inside - insert:, name @deepseek-ai/dsh-mcp-client) that have none.',
      migratePreview: 'Preview migration',
      migrateNothing: 'Nothing to migrate.',
      migratePlan: 'Will rewrite {rewrites}, add markers to {additions}, converge {converged}, skip {skipped}.',
      migrateBackup: 'Before writing, the host backs each target file up to <name>.bak-<timestamp>; migration is idempotent, so a second run writes nothing.',
      migrateSkipped: 'Skip reasons: {reasons}',
      migrateConfirmText: 'Run the migration now?',
      migrated: 'Migrated: rewrote {rewrites}, added {additions}, converged {converged}, skipped {skipped}',
      migrateFailed: 'Migration failed',
      close: 'Close',
    }

    var __locale = null

    /** 语言嗅探兜底：没有 locale 服务时按浏览器语言选字典，默认中文。 */
    function localeFallbackLang() {
      if (typeof navigator === 'undefined') return 'zh'
      for (const tag of (navigator.languages || []).concat([navigator.language])) {
        const primary = String(tag || '').toLowerCase().split('-')[0]
        if (primary === 'zh' || primary === 'en') return primary
      }
      return 'zh'
    }

    /** 解析一条文案：优先 locale 服务，回退浏览器语言嗅探字典，再回退键名。 */
    function __t(key) {
      if (__locale && typeof __locale.translate === 'function') {
        const text = __locale.translate(NS, key)
        if (typeof text === 'string' && text !== key) return text
      }
      return (localeFallbackLang() === 'en' ? enDict : zhDict)[key] || key
    }

    /** 文案模板：把 {name} 占位符换成实参。参数：key/params。返回值：string。 */
    function __tf(key, params) {
      let text = __t(key)
      const source = params && typeof params === 'object' ? params : {}
      for (const name of Object.keys(source)) {
        text = text.split('{' + name + '}').join(String(source[name]))
      }
      return text
    }

    /** 随 locale 快照变化重渲染（覆盖未带 locale 座位的条目）。 */
    function useLocaleRevision() {
      const [, setRev] = useState(0)
      useEffect(() => {
        if (!__locale || typeof __locale.subscribe !== 'function') return undefined
        return __locale.subscribe(() => setRev((v) => v + 1))
      }, [])
    }

    /** 接管 locale 服务并注册中英文字典。参数：locale/ctx。返回值：无。 */
    function adoptLocale(locale, ctx) {
      if (!locale) return
      __locale = locale
      try {
        if (typeof locale.register === 'function') {
          ctx.effect(() => locale.register(NS, { zh: zhDict, en: enDict }))
        }
      } catch { /* 命名空间已注册：保留既有文案 */ }
    }

    // --- styles ---------------------------------------------------------------

    const S = {
      root: { display: 'flex', flexDirection: 'column', gap: 12, padding: '4px 0 24px', fontSize: 13, color: 'var(--dsw-alias-label-primary)' },
      intro: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
      toolbar: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
      spacer: { flex: 1 },
      button: { font: 'inherit', cursor: 'pointer', color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-1)', border: '.5px solid var(--dsw-alias-border-l3)', borderRadius: 8, padding: '4px 12px', fontSize: 12 },
      buttonPrimary: { background: 'var(--dsw-alias-label-primary)', color: 'var(--dsw-alias-bg-layer-3)', border: 'none' },
      buttonDanger: { color: 'var(--dsw-alias-status-error, #d4380d)', borderColor: 'var(--dsw-alias-status-error, #d4380d)' },
      buttonDisabled: { opacity: 0.5, cursor: 'default' },
      input: { font: 'inherit', color: 'inherit', background: 'var(--dsw-alias-bg-layer-1)', border: '.5px solid var(--dsw-alias-border-l3)', borderRadius: 4, padding: '6px 8px', minWidth: 200 },
      textarea: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, lineHeight: '18px', color: 'inherit', background: 'var(--dsw-alias-bg-layer-1)', border: '.5px solid var(--dsw-alias-border-l3)', borderRadius: 8, padding: 10, minHeight: 120, width: '100%', boxSizing: 'border-box', resize: 'vertical' },
      card: { border: '.5px solid var(--dsw-alias-border-l4)', background: 'var(--dsw-alias-bg-layer-3)', borderRadius: 14, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10 },
      cardHead: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' },
      cardTitle: { fontSize: 13, fontWeight: 600 },
      cardId: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
      cardMeta: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
      cardActions: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
      tag: { fontSize: 11, lineHeight: '16px', padding: '1px 8px', borderRadius: 999, border: '.5px solid var(--dsw-alias-border-l3)', color: 'var(--dsw-alias-label-secondary)' },
      tagOn: { color: 'var(--dsw-alias-label-primary)', borderColor: 'var(--dsw-alias-label-primary)' },
      tagWarn: { color: 'var(--dsw-alias-status-warning, #d48806)', borderColor: 'var(--dsw-alias-status-warning, #d48806)' },
      tagBad: { color: 'var(--dsw-alias-status-error, #d4380d)', borderColor: 'var(--dsw-alias-status-error, #d4380d)' },
      banner: { border: '.5px solid var(--dsw-alias-border-l4)', background: 'var(--dsw-alias-bg-layer-3)', borderRadius: 12, padding: '10px 14px', display: 'flex', flexDirection: 'column', gap: 6, fontSize: 13 },
      bannerHead: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' },
      bannerWarn: { borderColor: 'var(--dsw-alias-status-warning, #d48806)' },
      bannerBad: { borderColor: 'var(--dsw-alias-status-error, #d4380d)' },
      bannerGood: { borderColor: 'var(--dsw-alias-status-success, #52c41a)' },
      error: { fontSize: 12, color: 'var(--dsw-alias-status-error, #d4380d)', whiteSpace: 'pre-wrap' },
      success: { fontSize: 12, color: 'var(--dsw-alias-status-success, #52c41a)', whiteSpace: 'pre-wrap' },
      problems: { margin: 0, paddingLeft: 18, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
      form: { display: 'flex', flexDirection: 'column', gap: 8, border: '.5px solid var(--dsw-alias-border-l3)', borderRadius: 12, padding: '12px 14px' },
      grid: { display: 'flex', flexWrap: 'wrap', gap: 10 },
      field: { display: 'flex', flexDirection: 'column', gap: 4, minWidth: 220, flex: '1 1 220px' },
      fieldLabel: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' },
      fieldFull: { display: 'flex', flexDirection: 'column', gap: 4, flex: '1 1 100%' },
      fieldError: { fontSize: 11, color: 'var(--dsw-alias-status-error, #d4380d)' },
      switch: { boxSizing: 'border-box', width: 38, height: 22, borderRadius: 11, padding: 2, background: 'var(--dsw-alias-border-l3)', cursor: 'pointer', border: 'none', flex: 'none', display: 'inline-flex', alignItems: 'center', transition: 'background .15s ease' },
      switchOn: { background: 'var(--dsw-alias-brand-primary)' },
      knob: { boxSizing: 'border-box', display: 'block', width: 18, height: 18, borderRadius: '50%', background: 'var(--dsw-alias-label-primary-foreground, #fff)', boxShadow: '0 1px 2px rgba(0, 0, 0, .35)', transition: 'transform .15s ease', transform: 'translateX(0)' },
      knobOn: { transform: 'translateX(16px)' },
      matrix: { display: 'flex', flexWrap: 'wrap', gap: 10, border: '.5px solid var(--dsw-alias-border-l3)', borderRadius: 10, padding: '8px 10px' },
      matrixCell: { display: 'inline-flex', gap: 6, alignItems: 'center', fontSize: 12, cursor: 'pointer' },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, wordBreak: 'break-all' },
      hidden: { display: 'none' },
      muted: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 12 },
      // 工具对话框：覆盖层 + 卡片；窄屏用 maxWidth/min 兜住，内容超高时对话框内滚动。
      overlay: { position: 'fixed', inset: 0, zIndex: 1000, background: 'rgba(0, 0, 0, .38)', display: 'flex', alignItems: 'center', justifyContent: 'center', padding: 16, boxSizing: 'border-box' },
      dialog: { boxSizing: 'border-box', width: 'min(680px, 94vw)', maxHeight: '80vh', overflow: 'auto', background: 'var(--dsw-alias-bg-layer-3)', border: '.5px solid var(--dsw-alias-border-l3)', borderRadius: 14, padding: '14px 16px', display: 'flex', flexDirection: 'column', gap: 10, boxShadow: '0 12px 32px rgba(0, 0, 0, .28)' },
      dialogHead: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' },
      toolRow: { display: 'flex', flexDirection: 'column', gap: 4, borderTop: '.5px solid var(--dsw-alias-border-l4)', paddingTop: 8 },
      toolHead: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
      toolName: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, fontWeight: 600, wordBreak: 'break-all' },
      toolDesc: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)', cursor: 'pointer', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', maxWidth: '100%' },
      toolDescOpen: { whiteSpace: 'pre-wrap', overflow: 'visible' },
    }

    /** 合并样式对象（后者覆盖前者）。参数：base/extra/…。返回值：object。 */
    function merge(base, ...rest) {
      let out = base
      for (const extra of rest) if (extra) out = Object.assign({}, out, extra)
      return out
    }

    // --- host api -------------------------------------------------------------

    /** 把任意值塞进一行诊断文本。参数：value。返回值：string。 */
    function compact(value) {
      if (value === null || value === undefined) return ''
      if (typeof value === 'string') return value
      if (typeof value === 'number' || typeof value === 'boolean') return String(value)
      try {
        const text = JSON.stringify(value)
        return typeof text === 'string' ? text : String(value)
      } catch { return String(value) }
    }

    /**
     * 功能作用：把宿主返回的 diagnostics 折成可读行。宿主可能给数组（字符串或对象）、
     *           字符串，或一个键值对象（如 { home, profile, httpSkipped, applyError }）。
     * 参数：diagnostics -- 任意形状的诊断载荷
     * 返回值：string[] -- 最多 12 行
     * 调用样例：diagnosticLines({ httpSkipped: 'duplicate route' })
     */
    function diagnosticLines(diagnostics) {
      const lines = []
      if (!diagnostics) return lines
      if (typeof diagnostics === 'string') return [diagnostics]
      if (Array.isArray(diagnostics)) {
        for (const item of diagnostics) {
          const text = compact(item)
          if (text) lines.push(text)
        }
        return lines.slice(0, 12)
      }
      if (typeof diagnostics === 'object') {
        for (const key of Object.keys(diagnostics)) {
          const value = diagnostics[key]
          if (value === null || value === undefined || value === '') continue
          if (Array.isArray(value)) {
            // 数组逐项一行（如 anchorErrors / mergeConflicts），空数组直接跳过。
            for (const item of value) {
              const text = compact(item)
              if (text) lines.push(key + ': ' + text)
              if (lines.length >= 12) return lines
            }
            continue
          }
          if (typeof value === 'object') {
            // 嵌套对象（如 state: { path, ok, error }）压成一行 key: a=1 · b=2，别打 JSON。
            const inner = Object.keys(value).filter((name) => value[name] !== null && value[name] !== undefined && value[name] !== '')
            if (!inner.length) continue
            lines.push(key + ': ' + inner.map((name) => name + '=' + compact(value[name])).join(' · '))
            if (lines.length >= 12) break
            continue
          }
          lines.push(key + ': ' + compact(value))
          if (lines.length >= 12) break
        }
      }
      return lines
    }

    /**
     * 功能作用：调用宿主半的唯一端点。无论 HTTP 状态码是多少都不抛错：网络层失败、
     *           非 JSON 响应、载荷形状不对都折成 { ok:false, error }，让面板能显示
     *           可读原因（spec：端点不可用时不得空白、不得抛错）。非 2xx 也照读
     *           body，因为 403（缺头/跨源）、413（请求过大）的原因只写在 body 里。
     * 参数：
     *   action: string -- list / add / update / remove / setEnabled / setMatrix /
     *                     getDefaults / setDefaults / probe / migrate / patchInfo
     *   payload: object|null -- POST 体里的 payload；null/undefined 视作 {}
     * 返回值：Promise<{ ok:boolean, data?:object, error?:{code,message,fields}, diagnostics?:any }>
     * 调用样例：const result = await callApi('list', {})
     */
    async function callApi(action, payload) {
      let response = null
      try {
        response = await fetch(API, {
          method: 'POST',
          headers: { 'content-type': 'application/json', 'x-dsh-plugin': PLUGIN_HEADER },
          body: JSON.stringify({ action: action, payload: payload === null || payload === undefined ? NO_PAYLOAD : payload }),
        })
      } catch (error) {
        return {
          ok: false,
          error: { code: 'network', message: String((error && error.message) || error) },
        }
      }
      let body = null
      try { body = await response.json() } catch { body = null }
      if (!body || typeof body !== 'object') {
        // 路由没注册时这里通常是 404 + HTML/空体：报状态码而不是浏览器的 JSON 解析文案。
        return {
          ok: false,
          error: {
            code: 'host-unavailable',
            message: __tf('hostUnavailableHint', { api: API }) + ' (HTTP ' + String((response && response.status) || '?') + ')',
          },
        }
      }
      const diagnostics = body.diagnostics !== undefined
        ? body.diagnostics
        : (body.error && body.error.diagnostics !== undefined ? body.error.diagnostics : (body.data && body.data.diagnostics))
      if (body.ok) return { ok: true, data: body.data === undefined ? body : body.data, diagnostics: diagnostics }
      const error = body.error && typeof body.error === 'object' ? body.error : {}
      return {
        ok: false,
        error: {
          code: error.code || 'error',
          message: error.message || __t('loadFailed'),
          fields: error.fields && typeof error.fields === 'object' ? error.fields : null,
        },
        diagnostics: diagnostics,
      }
    }

    /**
     * 功能作用：把宿主半的一行服务器归一到面板要用的形状。宿主半
     *           （host-core.mergeServers）给的是
     *           { id, serverName, transport, config, location:'home'|'profile'|'conflict',
     *             layers, profiles, matrix, effective, disabled, layoutDrift }；
     *           早期契约里的 { enabled, staticState, toolCountEstimate } 也照收，
     *           缺的一律给安全值（缺 staticState 时 staticStateText 会如实说「未上报」，
     *           不假装「未加载」）。
     * 参数：server -- list 里的一行；profiles -- 全部 profile 名
     * 返回值：object -- 面板内部形状
     */
    function normalizeServer(server, profiles) {
      const row = server && typeof server === 'object' ? server : {}
      const config = row.config && typeof row.config === 'object' ? row.config : {}
      const matrix = matrixMap(row.matrix, profiles)
      const selected = selectedProfiles(matrix, profiles)
      const enabled = row.enabled !== undefined
        ? Boolean(row.enabled)
        : (row.disabled !== undefined ? !row.disabled : selected.length > 0)
      const onProfiles = Array.isArray(row.profiles)
        ? row.profiles.map((item) => String(item))
        : selected
      return merge(row, {
        id: String(row.id || ''),
        serverName: String(row.serverName || config.serverName || row.id || ''),
        transport: String(row.transport || config.transport || ''),
        config: config,
        location: String(row.location || 'home'),
        layers: Array.isArray(row.layers) ? row.layers.map((item) => String(item)) : [],
        profiles: onProfiles,
        matrix: matrix,
        effective: row.effective && typeof row.effective === 'object' ? row.effective : null,
        enabled: enabled,
        disabled: row.disabled !== undefined ? Boolean(row.disabled) : !enabled,
        staticState: row.staticState !== undefined ? row.staticState : (row.loaderState !== undefined ? row.loaderState : null),
        toolCountEstimate: row.toolCountEstimate !== undefined ? row.toolCountEstimate : (row.toolCount !== undefined ? row.toolCount : null),
      })
    }

    /**
     * 功能作用：把 list 的 data 归一到面板用的快照。宿主半可能把载荷放在 data 里，
     *           也可能直接平铺在响应体上；两种都接受，缺字段一律给安全空值。
     * 参数：data -- 响应 data（或整个响应体）
     * 返回值：{ home, profile, profiles, servers, defaults, diagnostics, patchInfo }
     */
    function normalizeSnapshot(data) {
      const source = data && typeof data === 'object' ? data : {}
      const inner = source.data && typeof source.data === 'object' && (source.data.servers || source.data.profiles) ? source.data : source
      const profiles = Array.isArray(inner.profiles) ? inner.profiles.map((item) => String(item)) : []
      const servers = Array.isArray(inner.servers)
        ? inner.servers.filter((item) => item && typeof item === 'object').map((item) => normalizeServer(item, profiles))
        : []
      const defaults = inner.defaults && typeof inner.defaults === 'object' ? inner.defaults : null
      return {
        home: typeof inner.home === 'string' ? inner.home : '',
        profile: typeof inner.profile === 'string' ? inner.profile : '',
        profiles: profiles,
        servers: servers,
        defaults: defaults,
        diagnostics: inner.diagnostics === undefined ? null : inner.diagnostics,
        patchInfo: inner.patchInfo === undefined ? null : inner.patchInfo,
      }
    }

    // --- pure helpers ---------------------------------------------------------

    /** 矩阵对象 → 只含 true 的 profile 数组（键序按 profiles）。参数：matrix/profiles。返回值：string[]。 */
    function selectedProfiles(matrix, profiles) {
      const map = matrix && typeof matrix === 'object' ? matrix : {}
      return profiles.filter((profile) => Boolean(map[profile]))
    }

    /** 矩阵对象 → 完备布尔映射（未知 profile 键也保留）。参数：matrix/profiles。返回值：object。 */
    function matrixMap(matrix, profiles) {
      const out = {}
      const map = matrix && typeof matrix === 'object' ? matrix : {}
      for (const profile of profiles) out[profile] = Boolean(map[profile])
      return out
    }

    /** 生效 profile 摘要文案。宿主半给了 profiles 数组就用它（权威），否则由矩阵反推。参数：server/profiles。返回值：string。 */
    function profilesText(server, profiles) {
      if (profiles.length === 0) return __t('profilesNone')
      const selected = Array.isArray(server && server.profiles) && server.profiles.length
        ? profiles.filter((profile) => server.profiles.indexOf(profile) >= 0)
        : selectedProfiles(server && server.matrix, profiles)
      if (selected.length === profiles.length) return __tf('profilesCount', { n: profiles.length }) + ' · ' + __t('profilesAll')
      if (selected.length === 0) return __t('profilesNone')
      return selected.join('、')
    }

    /**
     * 功能作用：来源层文案。宿主半的 location 只有三种取值：
     *           'home'（只在 home 层）、'profile'（只在 profile 层）、
     *           'conflict'（home 层与某个 profile 层同时存在 —— 布局漂移，待用户决定）。
     * 参数：server。返回值：string。
     */
    function layerText(server) {
      const location = String((server && server.location) || 'home')
      const layers = Array.isArray(server && server.layers) ? server.layers.map((item) => String(item)) : []
      if (location === 'home') return __t('layerHome')
      if (location === 'conflict') return __t('layerConflict') + ' · ' + (layers.join(' + ') || __t('layerHome'))
      if (location === 'profile') {
        const named = layers.filter((name) => name !== 'home')
        return __t('layerProfile') + ' · ' + (named.length ? named.join('、') : __t('layerProfileOnly'))
      }
      return __t('layerProfile') + ' · ' + location
    }

    /**
     * 功能作用：静态状态文案（宿主枚举 pending|loading|active|failed|disabled；未知值原样回显）。
     *           字段缺失或 null 时：先保留 disabled → 已停用 的回退，再退到「—」——
     *           不在界面上抱怨宿主（字段没有就不显示）。
     * 参数：server。返回值：string。
     */
    function staticStateText(server) {
      const raw = String((server && (server.staticState || server.loaderState)) || '').trim()
      if (raw && raw.toLowerCase() !== 'null') {
        const key = STATIC_STATE_KEYS[raw.toLowerCase().replace(/[\s_-]/g, '')]
        if (key) return __t(key)
        return __tf('stateUnknown', { raw: raw })
      }
      if (server && server.disabled === true) return __t('stateDisabled')
      return __t('toolsDash')
    }

    /** 静态状态对应的 tag 样式。参数：server。返回值：样式对象或 null。 */
    function staticStateStyle(server) {
      const raw = String((server && (server.staticState || server.loaderState)) || '').toLowerCase()
      if (raw.indexOf('fail') !== -1 || raw.indexOf('error') !== -1) return S.tagBad
      if (raw.indexOf('load') === 0 && raw.indexOf('unload') !== 0) return S.tagWarn
      if (raw.indexOf('active') !== -1 || raw.indexOf('connect') !== -1) return S.tagOn
      return null
    }

    /** 工具数估计文案；0/缺失显示「—」。参数：server。返回值：string。 */
    function toolsText(server) {
      const value = server && (server.toolCountEstimate !== undefined ? server.toolCountEstimate : server.toolCount)
      const n = typeof value === 'number' ? value : Number(value)
      if (!Number.isFinite(n) || n <= 0) return __t('toolsDash')
      return __tf('toolsCount', { n: n })
    }

    /**
     * 功能作用：把 `tools` 端点的响应折成对话框状态。兼容旧形状（无 mode/source 按静态处理）、
     *           字符串数组、缺失 description（显示为空而不是 undefined）、失败载荷（error）。
     * 参数：result -- callApi 的返回值 { ok, data?, error? }
     * 返回值：{ phase:'ready'|'error', mode:'static'|'probe', tools:[{name,description}], latencyMs, note, error }
     * 调用样例：const state = toolsOutcome(await callApi('tools', { id: 'mcp-x' }))
     */
    /**
     * 功能作用：从成功或失败载荷里取延迟毫秒 —— 宿主的探测失败把 latencyMs 放在 error 上
     *           （镜像在 error.fields.latencyMs），成功则放在 data 上，这里统一兜住。
     * 参数：data -- 成功载荷或 data 信封；error -- 错误对象
     * 返回值：number 或 null
     * 调用样例：latencyOf(data, error)
     */
    function latencyOf(data, error) {
      const bag = data && typeof data === 'object' ? data : {}
      const err = error && typeof error === 'object' ? error : {}
      const fields = err.fields && typeof err.fields === 'object' ? err.fields : {}
      const candidates = [bag.latencyMs, bag.latency, err.latencyMs, err.latency, fields.latencyMs]
      for (const value of candidates) {
        if (typeof value === 'number' && isFinite(value)) return value
      }
      return null
    }

    function toolsOutcome(result, requested) {
      const wanted = requested === 'probe' ? 'probe' : 'static'
      const fallback = { phase: 'error', mode: wanted, serverName: '', tools: [], latencyMs: null, note: '', error: null }
      if (!result || result.ok !== true) {
        const error = (result && result.error) || {}
        return Object.assign({}, fallback, {
          latencyMs: latencyOf(result && result.data, error),
          error: {
            code: error.code === undefined || error.code === null ? 'host-unavailable' : String(error.code),
            message: String(error.message === undefined || error.message === null ? __t('toolsFailed') : error.message),
            fields: error.fields === undefined ? null : error.fields,
          },
        })
      }
      const data = result.data && typeof result.data === 'object' ? result.data : {}
      const raw = Array.isArray(data.tools) ? data.tools : Array.isArray(data.items) ? data.items : []
      const tools = []
      for (const item of raw) {
        if (typeof item === 'string') {
          if (item) tools.push({ name: item, description: '' })
          continue
        }
        const row = item && typeof item === 'object' ? item : {}
        const name = row.name === undefined || row.name === null ? '' : String(row.name)
        if (!name) continue
        const description = row.description === undefined || row.description === null ? '' : String(row.description)
        tools.push({ name: name, description: description })
      }
      const mode = data.mode === 'probe' || data.source === 'probe' || data.mode === 'live' ? 'probe' : wanted
      const note = data.note === undefined || data.note === null ? '' : String(data.note)
      if (data.ok === false) {
        const error = data.error && typeof data.error === 'object' ? data.error : {}
        return Object.assign({}, fallback, {
          mode: wanted,
          latencyMs: latencyOf(data, error),
          note: note,
          error: {
            code: error.code === undefined || error.code === null ? 'probe-failed' : String(error.code),
            message: String(error.message !== undefined && error.message !== null ? error.message : data.error !== undefined && data.error !== null && typeof data.error !== 'object' ? data.error : __t('toolsFailed')),
            fields: error.fields === undefined ? null : error.fields,
          },
        })
      }
      return {
        phase: 'ready',
        mode: mode,
        serverName: data.serverName === undefined || data.serverName === null ? '' : String(data.serverName),
        tools: tools,
        latencyMs: latencyOf(data, null),
        note: note,
        error: null,
      }
    }

    /** 布局漂移的说明行（boolean / 对象 / 数组都吃）。参数：drift。返回值：string[]。 */
    function driftLines(drift) {
      if (!drift) return []
      if (drift === true) return [__t('driftHint')]
      if (typeof drift === 'string') return [drift]
      if (Array.isArray(drift)) return drift.map(compact).filter(Boolean).slice(0, 6)
      if (typeof drift === 'object') {
        const lines = []
        const message = drift.message || drift.reason || drift.hint
        if (message) lines.push(String(message))
        if (drift.action) lines.push(__tf('driftAction', { action: compact(drift.action) }))
        if (drift.target) lines.push(__tf('driftTarget', { target: compact(drift.target) }))
        if (!lines.length) lines.push(__t('driftHint'))
        return lines
      }
      return []
    }

    /** 每行 key=value → 对象。参数：text。返回值：object。 */
    function linesToMap(text) {
      const out = {}
      for (const line of String(text || '').split(/\r?\n/)) {
        const trimmed = line.trim()
        if (!trimmed || trimmed.indexOf('=') < 0) continue
        const index = trimmed.indexOf('=')
        out[trimmed.slice(0, index).trim()] = trimmed.slice(index + 1).trim()
      }
      return out
    }

    /** 对象 → 每行 key=value。参数：map。返回值：string。 */
    function mapToLines(map) {
      if (!map || typeof map !== 'object') return ''
      return Object.keys(map).map((key) => key + '=' + compact(map[key])).join('\n')
    }

    /** args 文本 → 数组（按行拆，行内再按空格拆）。参数：text。返回值：string[]。 */
    function splitArgs(text) {
      const out = []
      for (const line of String(text || '').split(/\r?\n/)) {
        const trimmed = line.trim()
        if (!trimmed) continue
        if (trimmed.indexOf(' ') > 0) out.push.apply(out, trimmed.split(/\s+/))
        else out.push(trimmed)
      }
      return out
    }

    /** 数组 → 每行一个参数。参数：args。返回值：string。 */
    function joinArgs(args) {
      return Array.isArray(args) ? args.map((item) => String(item)).join('\n') : ''
    }

    /** 数字输入 → 有限正数或 null。参数：value。返回值：number|null。 */
    function positiveNumber(value) {
      if (value === '' || value === null || value === undefined) return null
      const n = Number(value)
      if (!Number.isFinite(n) || n <= 0) return null
      return Math.floor(n)
    }

    /** YAML 标量：必要时加引号。参数：value。返回值：string。 */
    function yamlScalar(value) {
      const text = compact(value)
      if (text === '') return "''"
      if (/^[A-Za-z0-9_./@+-]+$/.test(text)) return text
      return "'" + text.split("'").join("''") + "'"
    }

    /**
     * 功能作用：把表单草稿序列化成条目行块预览（原始 YAML 兜底框的初始内容）。
     *           这是给人看的预览，真正的落盘由宿主半的块拼贴算法完成。
     * 参数：draft -- 表单状态
     * 返回值：string
     */
    function serializeEntryYaml(draft) {
      const entry = draft || {}
      const id = String(entry.id || '').trim() || '<id>'
      const lines = []
      lines.push('# dsh-mcp-manager:2:server:' + id)
      lines.push('- insert:')
      lines.push('    - id: ' + yamlScalar(id))
      lines.push("      name: '@deepseek-ai/dsh-mcp-client'")
      lines.push('      config:')
      const config = configOf(entry)
      for (const key of Object.keys(config)) {
        const value = config[key]
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          lines.push('        ' + key + ':')
          for (const sub of Object.keys(value)) lines.push('          ' + sub + ': ' + yamlScalar(value[sub]))
        } else if (Array.isArray(value)) {
          lines.push('        ' + key + ':')
          for (const item of value) lines.push('          - ' + yamlScalar(item))
        } else {
          lines.push('        ' + key + ': ' + yamlScalar(value))
        }
      }
      return lines.join('\n')
    }

    /**
     * 功能作用：把条目 config 序列化成 YAML（YAML 子页的初始内容，也是提交时的 `yaml` 字段）。
     *           **不含 `- insert:` 外壳、不含标记注释** —— 宿主收到后先结构化解析再校验。
     * 参数：config -- 条目 config 对象
     * 返回值：string
     */
    function serializeConfigYaml(config) {
      const source = config && typeof config === 'object' ? config : {}
      const lines = []
      for (const key of Object.keys(source)) {
        const value = source[key]
        if (value && typeof value === 'object' && !Array.isArray(value)) {
          lines.push(key + ':')
          for (const sub of Object.keys(value)) lines.push('  ' + sub + ': ' + yamlScalar(value[sub]))
        } else if (Array.isArray(value)) {
          lines.push(key + ':')
          for (const item of value) lines.push('  - ' + yamlScalar(item))
        } else {
          lines.push(key + ': ' + yamlScalar(value))
        }
      }
      return lines.join('\n')
    }

    /**
     * 功能作用：从用户提交的 YAML 原文里取 serverName（YAML 为准时表单可能没填）。
     *           只认顶层的 `serverName:` 行，取不到就返回空串交给调用方兜底。
     * 参数：text -- YAML 原文
     * 返回值：string
     */
    function yamlServerName(text) {
      for (const line of String(text || '').split(/\r?\n/)) {
        const match = /^serverName\s*:\s*(.+?)\s*$/.exec(line)
        if (!match) continue
        return match[1].replace(/^['"]|['"]$/g, '').trim()
      }
      return ''
    }


    /** 表单草稿 → 条目 config（只放有值的键，默认值已在表单里落成具体值）。参数：draft。返回值：object。 */
    function configOf(draft) {
      const entry = draft || {}
      const transport = TRANSPORTS.indexOf(entry.transport) >= 0 ? entry.transport : 'stdio'
      const config = { serverName: String(entry.serverName || '').trim(), transport: transport }
      if (transport === 'stdio') {
        const command = String(entry.command || '').trim()
        if (command) config.command = command
        const args = splitArgs(entry.args)
        if (args.length) config.args = args
        const env = linesToMap(entry.env)
        if (Object.keys(env).length) config.env = env
        const cwd = String(entry.cwd || '').trim()
        if (cwd) config.cwd = cwd
      } else {
        const url = String(entry.url || '').trim()
        if (url) config.url = url
        const headers = linesToMap(entry.headers)
        if (Object.keys(headers).length) config.headers = headers
      }
      const timeout = positiveNumber(entry.toolCallTimeoutMs)
      if (timeout !== null) config.toolCallTimeoutMs = timeout
      const maxBytes = positiveNumber(entry.maxInstructionBytes)
      if (maxBytes !== null) config.maxInstructionBytes = maxBytes
      config.failOnStartupError = Boolean(entry.failOnStartupError)
      return config
    }

    /** 条目 → 表单草稿。参数：server/defaults。返回值：object。 */
    function draftOf(server, defaults) {
      const entry = server || {}
      const config = entry.config && typeof entry.config === 'object' ? entry.config : {}
      const fallback = Object.assign({}, FALLBACK_DEFAULTS, defaults || {})
      const transport = TRANSPORTS.indexOf(config.transport) >= 0
        ? config.transport
        : (TRANSPORTS.indexOf(fallback.defaultTransport) >= 0 ? fallback.defaultTransport : 'stdio')
      return {
        id: String(entry.id || ''),
        serverName: String(config.serverName || entry.serverName || ''),
        transport: transport,
        command: String(config.command || ''),
        args: joinArgs(config.args),
        env: mapToLines(config.env),
        cwd: String(config.cwd || ''),
        url: String(config.url || ''),
        headers: mapToLines(config.headers),
        toolCallTimeoutMs: String(config.toolCallTimeoutMs !== undefined ? config.toolCallTimeoutMs : fallback.toolCallTimeoutMs),
        maxInstructionBytes: String(config.maxInstructionBytes !== undefined ? config.maxInstructionBytes : fallback.maxInstructionBytes),
        failOnStartupError: config.failOnStartupError !== undefined ? Boolean(config.failOnStartupError) : Boolean(fallback.failOnStartupError),
        level: entry.location && entry.location !== 'home' ? entry.location : 'home',
        rawDirty: false,
        raw: '',
      }
    }

    /** 新增表单的初始草稿（全局默认参数预填）。参数：defaults。返回值：object。 */
    function blankDraft(defaults) {
      const fallback = Object.assign({}, FALLBACK_DEFAULTS, defaults || {})
      const transport = TRANSPORTS.indexOf(String(fallback.defaultTransport)) >= 0 ? String(fallback.defaultTransport) : 'stdio'
      return {
        id: '',
        serverName: '',
        transport: transport,
        command: '',
        args: '',
        env: '',
        cwd: '',
        url: '',
        headers: '',
        toolCallTimeoutMs: String(fallback.toolCallTimeoutMs),
        maxInstructionBytes: String(fallback.maxInstructionBytes),
        failOnStartupError: Boolean(fallback.failOnStartupError),
        level: 'home',
        rawDirty: false,
        raw: '',
      }
    }

    /**
     * 功能作用：保存前的必填校验（spec：保存前做必填校验）。rawDirty 时只校验
     *           id/serverName —— 原文以宿主校验为准，字段值可能已被用户绕开。
     * 参数：
     *   draft: object -- 表单草稿
     *   taken: { ids: string[], names: string[] } -- 已占用集合（编辑时由调用方剔除自己）
     * 返回值：{ ok: boolean, fields: { field: message } }
     */
    function validateDraft(draft, taken) {
      const fields = {}
      const skip = taken && typeof taken === 'object' ? taken : {}
      const ids = Array.isArray(skip.ids) ? skip.ids : []
      const names = Array.isArray(skip.names) ? skip.names : []
      const serverName = String((draft && draft.serverName) || '').trim()
      // id 可留空：留空时按 serverName 派生 mcp-<serverName>，再按派生值做格式与占用校验。
      const id = String((draft && draft.id) || '').trim() || (serverName ? 'mcp-' + serverName : '')
      if (draft && draft.rawDirty) {
        // YAML 子页：正文由宿主结构化校验，这里只保证「写哪一条」可定位 ——
        // serverName/id 优先取 YAML 原文里的顶层 serverName，其次才用表单值。
        const fromYaml = yamlServerName(draft.raw)
        const name = fromYaml || serverName
        const yamlId = String((draft && draft.id) || '').trim() || (name ? 'mcp-' + name : '')
        if (!yamlId) fields.id = __t('needId')
        else if (!ENTRY_ID_RE.test(yamlId)) fields.id = __t('needIdPattern')
        else if (ids.indexOf(yamlId) !== -1) fields.id = __t('needIdTaken')
        if (!name) fields.serverName = __t('needName')
        else if (!SERVER_NAME_RE.test(name)) fields.serverName = __t('needNamePattern')
        else if (names.indexOf(name) !== -1) fields.serverName = __t('needNameTaken')
        return { ok: Object.keys(fields).length === 0, fields: fields }
      }
      if (!id) fields.id = __t('needId')
      else if (!ENTRY_ID_RE.test(id)) fields.id = __t('needIdPattern')
      else if (ids.indexOf(id) !== -1) fields.id = __t('needIdTaken')
      if (!serverName) fields.serverName = __t('needName')
      else if (!SERVER_NAME_RE.test(serverName)) fields.serverName = __t('needNamePattern')
      else if (names.indexOf(serverName) !== -1) fields.serverName = __t('needNameTaken')
      const transport = draft && TRANSPORTS.indexOf(draft.transport) >= 0 ? draft.transport : 'stdio'
      if (transport === 'stdio') {
        if (!String((draft && draft.command) || '').trim()) fields.command = __t('needCommand')
      } else if (!String((draft && draft.url) || '').trim()) {
        fields.url = __t('needUrl')
      }
      for (const key of ['toolCallTimeoutMs', 'maxInstructionBytes']) {
        const raw = draft ? draft[key] : ''
        if (String(raw === undefined || raw === null ? '' : raw).trim() === '') continue
        if (positiveNumber(raw) === null) fields[key] = __t('needNumber')
      }
      return { ok: Object.keys(fields).length === 0, fields: fields }
    }

    /**
     * 功能作用：算出一次矩阵变更会写哪些文件、是否需要二次确认。落点规则见 spec：
     *           全员 → home 层；部分 → 被选中的 profile（并从 home 层删行）；全不 → home 一条 disabled。
     * 参数：server/nextMap/profiles/activeProfile
     * 返回值：{ selected: string[], targets: string[], touchesOthers: boolean }
     */
    function matrixPlan(server, nextMap, profiles, activeProfile) {
      const selected = selectedProfiles(nextMap, profiles)
      const files = []
      const location = server && server.location ? String(server.location) : 'home'
      files.push(location === 'home' ? 'home' : location)
      for (const profile of selected) files.push(profile)
      if (selected.length === 0 && files.indexOf('home') < 0) files.push('home')
      const unique = []
      for (const file of files) if (unique.indexOf(file) < 0) unique.push(file)
      // home 行影响每个 profile；任何落在「本 profile」之外的文件都要二次确认。
      const touchesOthers = unique.some((file) => file !== activeProfile)
      return { selected: selected, targets: unique, touchesOthers: touchesOthers }
    }

    /**
     * 功能作用：列表每行的字段摘要（id/serverName/transport/落点层/生效 profile/
     *           静态状态/工具数估计）。每个字段是一个带 data-* 标记的独立 span，
     *           既便于人读也便于离线测试精确断言（见 test/bundle.test.mjs）。
     * 参数：server -- 一台服务器；profiles -- 全部 profile 名
     * 返回值：React 元素
     */
    function renderMeta(server, profiles) {
      const cell = (label, value, attr) => React.createElement('span', { style: S.cardMeta, [attr]: server.id }, label + '：' + value)
      return React.createElement('div', { style: S.cardMeta },
        cell(__t('colId'), String(server.id || ''), 'data-entry-id'),
        cell(__t('colServerName'), String(server.serverName || ''), 'data-server-name'),
        cell(__t('colTransport'), String(server.transport || ''), 'data-transport'),
        cell(__t('colLocation'), layerText(server), 'data-location'),
        cell(__t('colProfiles'), profilesText(server, profiles), 'data-profiles'),
        cell(__t('colState'), staticStateText(server), 'data-state'),
        cell(__t('colTools'), toolsText(server), 'data-tools'),
      )
    }

    /** 开关滑块。参数：props = { on, disabled, title, field, onToggle }。返回值：React 元素。 */
    function renderToggle(props) {
      const disabled = Boolean(props.disabled)
      return React.createElement('button', {
        type: 'button',
        role: 'switch',
        'aria-checked': props.on ? 'true' : 'false',
        title: props.title || '',
        'data-field': props.field,
        'data-target': props.target,
        disabled: disabled,
        onClick: () => { if (!disabled) props.onToggle() },
        style: merge(S.switch, props.on ? S.switchOn : null, disabled ? S.buttonDisabled : null),
      }, React.createElement('span', { style: merge(S.knob, props.on ? S.knobOn : null) }))
    }

    /** 一行字段错误。参数：message。返回值：React 元素或 null。 */
    function renderFieldError(message) {
      return message ? React.createElement('span', { style: S.fieldError }, message) : null
    }

    /** 数字输入。参数：{ value, onChange, disabled, field }。返回值：React 元素。 */
    function renderNumberInput(props) {
      return React.createElement('input', {
        type: 'number',
        min: '1',
        step: '1',
        style: S.input,
        value: props.value,
        'data-field': props.field,
        disabled: Boolean(props.disabled),
        spellCheck: false,
        onChange: (event) => props.onChange(event.target.value),
      })
    }

    // --- panel ----------------------------------------------------------------

    /**
     * 功能作用：面板根组件——持有全部状态并驱动宿主端点。所有子视图都是本次渲染里
     *           直接调用的纯函数（不额外挂 hook），这样 hook 顺序只由本组件决定。
     * 参数：props -- 核心传入（本 tab 无 props）
     * 返回值：React 元素
     */
    function McpServersPanel() {
      useLocaleRevision()
      const [snapshot, setSnapshot] = useState(null)
      const [failure, setFailure] = useState(null)
      const [notice, setNotice] = useState(null)
      const [busy, setBusy] = useState('')
      const [editing, setEditing] = useState('')
      const [draft, setDraft] = useState(null)
      const [fieldErrors, setFieldErrors] = useState({})
      const [showRaw, setShowRaw] = useState(false)
      const [defaultsOpen, setDefaultsOpen] = useState(false)
      const [defaultsDraft, setDefaultsDraft] = useState(null)
      const [defaultsNote, setDefaultsNote] = useState('')
      const [migratePlan, setMigratePlan] = useState(null)
      const [probes, setProbes] = useState({})
      const [filesOpen, setFilesOpen] = useState(false)
      // 工具对话框：toolsFor = 打开的服务器 id（null 表示关闭）；toolsState = toolsOutcome 的形状。
      const [toolsFor, setToolsFor] = useState(null)
      const [toolsState, setToolsState] = useState(null)
      const [toolsExpanded, setToolsExpanded] = useState({})
      const [copiedTool, setCopiedTool] = useState('')
      const toolsReqRef = useRef('')
      const [filesInfo, setFilesInfo] = useState(null)
      const [filesFailure, setFilesFailure] = useState(null)
      const aliveRef = useRef(true)
      useEffect(() => {
        aliveRef.current = true
        return () => { aliveRef.current = false }
      }, [])

      const applySnapshot = useCallback((data) => {
        setSnapshot(normalizeSnapshot(data))
      }, [])

      // 首次挂载读一次列表；失败只置 failure，不抛错也不清空已有内容。
      const load = useCallback(async () => {
        setBusy('list')
        const result = await callApi('list', NO_PAYLOAD)
        if (!aliveRef.current) return
        if (result.ok) {
          applySnapshot(result.data)
          setFailure(null)
        } else {
          setFailure({
            code: result.error.code,
            message: result.error.message,
            fields: result.error.fields,
            diagnostics: result.diagnostics,
          })
        }
        setBusy('')
      }, [applySnapshot])
      useEffect(() => { load() }, [load])

      /**
       * 功能作用：跑一个写端点并统一处理 loading / 成功提示 / 失败横幅。
       *           成功时优先用响应里的 state/servers 刷新快照，否则回读一次 list。
       */
      const submit = useCallback(async (endpoint, payload, okKey, values) => {
        setBusy(endpoint)
        setNotice(null)
        const result = await callApi(endpoint, payload)
        if (!aliveRef.current) return result
        if (result.ok) {
          setFailure(null)
          setNotice({ tone: 'ok', text: okKey ? __tf(okKey, values || {}) : '' })
          if (result.data && (result.data.servers || result.data.profiles)) applySnapshot(result.data)
          else await load()
        } else {
          setFailure({
            code: result.error.code,
            message: result.error.message,
            fields: result.error.fields,
            diagnostics: result.diagnostics,
          })
          setNotice(null)
        }
        setBusy('')
        return result
      }, [applySnapshot, load])

      const servers = snapshot ? snapshot.servers : []
      const profiles = snapshot ? snapshot.profiles : []
      const activeProfile = snapshot ? snapshot.profile : ''
      const defaults = snapshot && snapshot.defaults ? snapshot.defaults : FALLBACK_DEFAULTS
      const patch = snapshot && snapshot.patchInfo && typeof snapshot.patchInfo === 'object' ? snapshot.patchInfo : null
      // patch 文件不可解析时宿主只读降级：写端点一律会被拒，面板先把写入口锁掉。
      // 真实形状是 { home: fileInfo, profiles: { <name>: fileInfo } }，fileInfo.ok=false 即不可解析；
      // 早期契约里的扁平 { readOnly, parseError, error } 也照收。
      const badFiles = (() => {
        if (!patch) return []
        const list = []
        const collect = (label, file) => {
          if (!file || typeof file !== 'object') return
          if (file.ok === false || file.parseError || file.error) list.push(label + '：' + compact(file.error || file.parseError))
        }
        collect(__t('filesHome'), patch.home)
        if (patch.profiles && typeof patch.profiles === 'object') {
          for (const name of Object.keys(patch.profiles)) collect(name, patch.profiles[name])
        }
        if (Array.isArray(patch.targets)) {
          for (const target of patch.targets) collect(String((target && target.target) || ''), target)
        }
        return list
      })()
      const readOnly = Boolean(patch && (patch.readOnly === true || patch.parseError || patch.error)) || badFiles.length > 0
      const readOnlyReason = readOnly
        ? (badFiles.length ? badFiles.join('；') : compact((patch && (patch.parseError || patch.error || patch.message)) || ''))
        : ''
      const endpointDown = Boolean(failure)
      const locked = Boolean(busy) || endpointDown || readOnly
      const enabledCount = servers.filter((server) => server.enabled !== false).length
      const driftServers = servers.filter((server) => Boolean(server.layoutDrift))

      /** 矩阵勾选：先算落点，跨 profile 时二次确认，再调 setMatrix。 */
      const onMatrixToggle = (server, profile, next) => {
        if (locked) return
        const current = matrixMap(server.matrix, profiles)
        const nextMap = matrixMap(server.matrix, profiles)
        nextMap[profile] = next
        const plan = matrixPlan(server, nextMap, profiles, activeProfile)
        const labels = plan.targets.map((file) => (file === 'home' ? __t('filesHome') : (file === activeProfile ? file + ' ' + __t('matrixThis') : file)))
        if (plan.touchesOthers) {
          const ok = typeof window !== 'undefined' && typeof window.confirm === 'function'
            ? window.confirm(__tf('matrixConfirm', { targets: labels.join('、') }))
            : true
          if (!ok) return
        }
        void current
        if (!nextMap[profile]) nextMap[profile] = false
        submit('setMatrix', { id: server.id, matrix: nextMap }, 'matrixApplied', { targets: labels.join('、') })
      }

      /** 删除：二次确认后才调 remove。 */
      const onRemove = (server) => {
        if (locked) return
        const ok = typeof window !== 'undefined' && typeof window.confirm === 'function'
          ? window.confirm(__tf('removeConfirm', { id: server.id }))
          : true
        if (!ok) return
        submit('remove', { id: server.id, confirm: true }, 'removed', { id: server.id })
      }

      /** 启停开关。 */
      const onToggleEnabled = (server) => {
        if (locked) return
        submit('setEnabled', { id: server.id, enabled: server.enabled === false }, null, null)
      }

      /** 探测：结果进 per-id 表，失败也只影响那一行。 */
      const onProbe = async (server) => {
        setBusy('probe:' + server.id)
        setProbes(Object.assign({}, probes, { [server.id]: { phase: 'running' } }))
        const result = await callApi('probe', { id: server.id })
        if (!aliveRef.current) return
        const data = result.ok && result.data && typeof result.data === 'object' ? result.data : {}
        const latencyMs = data.latencyMs !== undefined ? data.latencyMs : data.latency
        const toolCount = data.toolCount !== undefined ? data.toolCount : data.tools
        const outcome = {
          phase: result.ok && data.ok !== false ? 'ok' : 'failed',
          latencyMs: typeof latencyMs === 'number' ? latencyMs : null,
          toolCount: typeof toolCount === 'number' ? toolCount : null,
          error: result.ok ? (data.error ? String(data.error) : null) : result.error.message,
        }
        setProbes(Object.assign({}, probes, { [server.id]: outcome }))
        setBusy('')
      }

      /** 打开「工具」对话框：打开即按 id 请求静态清单（mode 缺省 = 静态，不探测）。 */
      const onOpenTools = async (server) => {
        toolsReqRef.current = server.id
        setToolsFor(server.id)
        setToolsState({ phase: 'loading', mode: 'static', tools: [], latencyMs: null, note: '', error: null })
        setToolsExpanded({})
        setCopiedTool('')
        const result = await callApi('tools', { id: server.id })
        if (!aliveRef.current) return
        if (toolsReqRef.current !== server.id) return
        setToolsState(toolsOutcome(result, 'static'))
      }

      /** 「真探测」：显式带 mode:'probe'（宿主会起一次 MCP 子进程）；失败也留在对话框里。 */
      const onProbeTools = async () => {
        const id = toolsFor
        if (!id) return
        toolsReqRef.current = id
        setToolsState({ phase: 'loading', mode: 'probe', tools: [], latencyMs: null, note: '', error: null })
        const result = await callApi('tools', { id: id, mode: 'probe' })
        if (!aliveRef.current) return
        if (toolsReqRef.current !== id) return
        setToolsState(toolsOutcome(result, 'probe'))
      }

      /** 错误态的「重试」：按上次用的模式重发（静态失败就重发静态，探测失败就重发探测）。 */
      const onRetryTools = () => {
        if (!toolsFor) return
        if (toolsState && toolsState.mode === 'probe') onProbeTools()
        else onOpenTools({ id: toolsFor })
      }

      const onCloseTools = () => {
        setToolsFor(null)
        setToolsState(null)
        setToolsExpanded({})
        setCopiedTool('')
      }

      /** 复制工具名：优先 clipboard，缺 API 也不抛错（只做提示）。 */
      const onCopyTool = (name) => {
        try {
          const nav = typeof navigator === 'undefined' ? null : navigator
          if (nav && nav.clipboard && typeof nav.clipboard.writeText === 'function') nav.clipboard.writeText(name)
        } catch { /* 剪贴板不可用：仍然给出「已复制」提示，不打断阅读 */ }
        setCopiedTool(name)
      }

      const onToggleTool = (name) => {
        setToolsExpanded(Object.assign({}, toolsExpanded, { [name]: !toolsExpanded[name] }))
      }

      /** 打开/刷新「写入位置」：单独调 patchInfo，端点缺失时退回 list 里的那份。 */
      const onFiles = async () => {
        if (filesOpen) { setFilesOpen(false); return }
        setFilesOpen(true)
        setBusy('patchInfo')
        const result = await callApi('patchInfo', NO_PAYLOAD)
        if (!aliveRef.current) return
        if (result.ok) {
          // 宿主半的 patchInfo 端点把结果包在 data.patchInfo 里（data 另含 home/profile 路径）。
          const data = result.data && typeof result.data === 'object' ? result.data : null
          const info = data && data.patchInfo && typeof data.patchInfo === 'object' ? data.patchInfo : data
          setFilesInfo(info)
          setFilesFailure(null)
        } else {
          // 端点缺失不算致命：列表里那份 patchInfo 仍可用，但失败原因必须显示出来。
          setFilesFailure({ code: result.error.code, message: result.error.message, diagnostics: result.diagnostics })
        }
        setBusy('')
      }

      /** 打开全局默认参数：先回读端点，再填表单。 */
      const onDefaults = async () => {
        if (defaultsOpen) { setDefaultsOpen(false); return }
        setDefaultsOpen(true)
        setDefaultsNote('')
        setBusy('getDefaults')
        const result = await callApi('getDefaults', NO_PAYLOAD)
        if (!aliveRef.current) return
        setBusy('')
        if (result.ok && result.data && typeof result.data === 'object') {
          const data = result.data.defaults && typeof result.data.defaults === 'object' ? result.data.defaults : result.data
          setDefaultsDraft(defaultsForm(data))
          if (data.fallback === true || data.source === 'builtin') setDefaultsNote('fallbackNotice')
        } else if (!result.ok) {
          setDefaultsDraft(defaultsForm(null))
          setFailure({ code: result.error.code, message: result.error.message, fields: result.error.fields, diagnostics: result.diagnostics })
        }
      }

      /** 保存默认参数：只提交面板认得的键。 */
      const onSaveDefaults = async () => {
        const draftValues = defaultsDraft || defaultsForm(null)
        const payload = {
          toolCallTimeoutMs: positiveNumber(draftValues.toolCallTimeoutMs),
          maxInstructionBytes: positiveNumber(draftValues.maxInstructionBytes),
          probeTimeoutMs: positiveNumber(draftValues.probeTimeoutMs),
          failOnStartupError: Boolean(draftValues.failOnStartupError),
          defaultTransport: draftValues.defaultTransport,
        }
        const bad = {}
        for (const key of NUMERIC_DEFAULTS.concat(['probeTimeoutMs'])) {
          if (payload[key] === null) bad[key] = __t('needNumber')
        }
        setFieldErrors(bad)
        if (Object.keys(bad).length) return
        await submit('setDefaults', { defaults: payload }, 'defaultsSaved', null)
      }

      /** 新增表单。 */
      const onAdd = () => {
        setFieldErrors({})
        setEditing('')
        setShowRaw(false)
        setDraft(blankDraft(defaults))
      }

      /** 展开行内编辑（预填该条目 + 全局默认）；withRaw 时直接摊开原始 YAML 兜底框。 */
      const onEdit = (server, withRaw) => {
        setFieldErrors({})
        setShowRaw(Boolean(withRaw))
        setEditing(server.id)
        setDraft(draftOf(server, defaults))
      }

      const onCancelForm = () => {
        setFieldErrors({})
        setDraft(null)
        setEditing('')
        setShowRaw(false)
      }

      /** 表单字段更新（raw 变脏由调用点显式标记）。 */
      const setField = (name, value) => {
        setDraft(Object.assign({}, draft, { [name]: value }))
      }

      /** 保存（新增或编辑）：先本地必填校验，再走 add/update。 */
      const onSaveDraft = async () => {
        const current = draft || blankDraft(defaults)
        const taken = { ids: [], names: [] }
        for (const server of servers) {
          if (server.id === editing) continue
          taken.ids.push(server.id)
          if (server.serverName) taken.names.push(server.serverName)
        }
        const verdict = validateDraft(current, taken)
        setFieldErrors(verdict.fields)
        if (!verdict.ok) {
          const names = Object.keys(verdict.fields).map((key) => __tf(verdict.fields[key], {}))
          setNotice({ tone: 'bad', text: __tf('validationFailed', { fields: names.join(' / ') }) })
          return
        }
        // YAML 子页被改过：以原文为准（宿主先结构化解析再校验），表单字段只作为兜底一起提交。
        const yamlText = current.rawDirty ? String(current.raw || '') : ''
        const serverName = String(current.serverName || '').trim() || yamlServerName(yamlText)
        const id = String(current.id || '').trim() || 'mcp-' + serverName
        const next = Object.assign({}, current, { id: id, serverName: serverName })
        const payload = {
          id: id,
          serverName: serverName,
          transport: next.transport,
          config: configOf(next),
          matrix: matrixMapForLevel(next, profiles),
          yaml: current.rawDirty ? yamlText : undefined,
        }
        if (editing) {
          const result = await submit('update', payload, 'saved', { id: id })
          if (result && result.ok) onCancelForm()
          else if (result && result.error && result.error.fields) setFieldErrors(result.error.fields)
        } else {
          const result = await submit('add', payload, 'added', { id: id })
          if (result && result.ok) onCancelForm()
          else if (result && result.error && result.error.fields) setFieldErrors(result.error.fields)
        }
      }

      /** 矩阵工具：按「写入层级」下拉算 add 的完整矩阵意图。 */
      const matrixMapForLevel = (current, known) => {
        const out = {}
        const level = current.level === 'home' || !current.level ? 'home' : current.level
        for (const profile of known) out[profile] = level === 'home' ? true : profile === level
        return out
      }

      /**
       * 功能作用：迁移。宿主半的语义是 `apply !== false` 就真写盘 —— 预览必须显式传
       *           `{ apply: false }`（不能传空载荷，否则会直接改写文件）。
       * 参数：confirmed -- true=执行（apply:true），false=只看计划（apply:false）
       */
      const onMigrate = async (confirmed) => {
        setBusy('migrate')
        const result = await callApi('migrate', { apply: Boolean(confirmed) })
        if (!aliveRef.current) return
        if (result.ok) {
          setFailure(null)
          const data = result.data && typeof result.data === 'object' ? result.data : {}
          const totals = data.totals && typeof data.totals === 'object' ? data.totals : data
          const files = Array.isArray(data.files) ? data.files : []
          let skipped = 0
          const reasons = []
          for (const file of files) {
            const stats = file && file.stats && typeof file.stats === 'object' ? file.stats : null
            const list = stats && Array.isArray(stats.skipped) ? stats.skipped : []
            for (const item of list) {
              const count = item && typeof item === 'object' ? Number(item.count || 0) : 0
              if (Number.isFinite(count)) skipped += count
              const reason = item && typeof item === 'object' ? item.reason : item
              if (reason && reasons.indexOf(String(reason)) < 0) reasons.push(String(reason))
            }
          }
          const writes = Array.isArray(data.writes) ? data.writes : []
          const backups = writes.map((item) => item && item.backedUp).filter(Boolean).map(String)
          const plan = {
            rewrites: Number(totals.relabeled || totals.rewrites || 0),
            additions: Number(totals.tagged || totals.additions || 0),
            converged: Number(totals.converged || 0),
            skipped: skipped || Number(totals.skipped || 0),
            reasons: reasons,
            backups: backups,
          }
          if (confirmed) {
            setMigratePlan(null)
            setNotice({
              tone: 'ok',
              text: __tf('migrated', { rewrites: plan.rewrites, additions: plan.additions, converged: plan.converged, skipped: plan.skipped }),
            })
            await load()
          } else {
            setMigratePlan(plan)
          }
        } else {
          setFailure({ code: result.error.code, message: result.error.message, fields: result.error.fields, diagnostics: result.diagnostics })
          setNotice(null)
        }
        setBusy('')
      }

      // ---- 纯渲染片段（无 hook） ----

      const renderFailure = () => {
        if (!failure) return null
        const lines = diagnosticLines(failure.diagnostics)
        const fieldText = failure.fields
          ? Object.keys(failure.fields).map((key) => key + ': ' + compact(failure.fields[key])).join('；')
          : ''
        return React.createElement('div', { style: merge(S.banner, S.bannerBad) },
          React.createElement('div', { style: S.bannerHead },
            React.createElement('strong', null, __t('hostUnavailable')),
            React.createElement('span', { style: S.muted }, __tf('hostUnavailableCode', { code: failure.code })),
            React.createElement('span', { style: S.spacer }),
            React.createElement('button', { type: 'button', style: S.button, onClick: () => load() }, __t('hostUnavailableRetry')),
            React.createElement('button', { type: 'button', style: S.button, onClick: () => setFailure(null) }, __t('close')),
          ),
          React.createElement('div', { style: S.error }, failure.message),
          React.createElement('div', { style: S.muted }, __tf('hostUnavailableHint', { api: API })),
          fieldText ? React.createElement('div', { style: S.muted }, __tf('hostUnavailableFields', { fields: fieldText })) : null,
          React.createElement('div', { style: S.cardMeta }, __t('diagnostics')),
          React.createElement('ul', { style: S.problems },
            (lines.length ? lines : [__t('diagnosticsEmpty')]).map((line, index) => React.createElement('li', { key: index }, line)),
          ),
        )
      }

      const renderNotice = () => {
        if (!notice || !notice.text) return null
        const bad = notice.tone === 'bad'
        return React.createElement('div', { style: merge(S.banner, bad ? S.bannerBad : S.bannerGood) },
          React.createElement('div', { style: S.bannerHead },
            React.createElement('span', { style: bad ? S.error : S.success }, notice.text),
            React.createElement('span', { style: S.spacer }),
            React.createElement('button', { type: 'button', style: S.button, onClick: () => setNotice(null) }, __t('close')),
          ),
        )
      }

      /** patch 不可解析 → 只读降级横幅（spec：只读降级时要说明原因）。 */
      const renderReadOnly = () => {
        if (!readOnly) return null
        return React.createElement('div', { style: merge(S.banner, S.bannerWarn) },
          React.createElement('div', { style: S.bannerHead },
            React.createElement('strong', null, __t('readOnlyTitle')),
            React.createElement('span', { style: S.spacer }),
            React.createElement('button', { type: 'button', style: S.button, disabled: Boolean(busy), onClick: () => load() }, __t('filesReload')),
          ),
          React.createElement('div', { style: S.muted }, __t('readOnlyHint')),
          readOnlyReason ? React.createElement('div', { style: S.error }, readOnlyReason) : null,
        )
      }

      const renderFiles = () => {
        if (!filesOpen) return null
        const info = filesInfo || (snapshot && snapshot.patchInfo) || {}
        const rows = []
        // 宿主半真实形状：{ home: fileInfo, profiles: { <name>: fileInfo } }；
        // 早期契约里的 { home:'路径', profile:'路径', targets:[], backups:[] } 也照收。
        const pushFile = (label, file) => {
          if (file === null || file === undefined) return
          if (typeof file !== 'object') { rows.push(label + '：' + String(file)); return }
          const parts = [label + '：' + String(file.path || file.target || '?')]
          if (file.exists === false) parts.push(__t('fileMissing'))
          if (file.ok === false) parts.push(__t('fileUnparsable') + (file.error ? '（' + compact(file.error) + '）' : ''))
          if (Array.isArray(file.entries)) parts.push(__tf('fileEntries', { n: file.entries.length }))
          if (typeof file.backups === 'number') parts.push(__tf('filesBackups', { n: file.backups }))
          rows.push(parts.join(' · '))
        }
        if (info.home && typeof info.home === 'object') pushFile(__t('filesHome'), info.home)
        else if (info.home) rows.push(__t('filesHome') + '：' + String(info.home))
        if (info.profiles && typeof info.profiles === 'object') {
          for (const name of Object.keys(info.profiles)) pushFile(__tf('filesProfileOf', { name: name }), info.profiles[name])
        }
        if (info.profile && typeof info.profile === 'string') rows.push(__t('filesProfile') + '：' + String(info.profile))
        const targets = Array.isArray(info.targets) ? info.targets : []
        for (const target of targets) rows.push(compact(target))
        const backups = Array.isArray(info.backups) ? info.backups : []
        if (backups.length) rows.push(__tf('filesBackups', { n: backups.length }))
        if (filesFailure) for (const line of diagnosticLines(filesFailure.diagnostics)) rows.push(line)
        return React.createElement('div', { style: S.form },
          React.createElement('div', { style: S.cardTitle }, __t('files')),
          React.createElement('div', { style: S.muted }, __t('filesHint')),
          filesFailure
            ? React.createElement('div', { style: S.error },
                __t('hostUnavailable') + '：' + filesFailure.message + '（' + filesFailure.code + '）',
              )
            : null,
          rows.length
            ? React.createElement('ul', { style: S.problems }, rows.map((line, index) => React.createElement('li', { key: index, style: S.mono }, line)))
            : React.createElement('div', { style: S.muted }, __t('diagnosticsEmpty')),
          React.createElement('div', { style: S.cardActions },
            React.createElement('button', { type: 'button', style: S.button, disabled: locked, onClick: () => onFiles() }, __t('filesReload')),
          ),
        )
      }

      const renderDefaults = () => {
        if (!defaultsOpen) return null
        const values = defaultsDraft || defaultsForm(defaults)
        const set = (name, value) => setDefaultsDraft(Object.assign({}, values, { [name]: value }))
        return React.createElement('div', { style: S.form },
          React.createElement('div', { style: S.cardTitle }, __t('defaultsTitle')),
          React.createElement('div', { style: S.muted }, __t('defaultsHint')),
          defaultsNote ? React.createElement('div', { style: S.muted }, __t(defaultsNote)) : null,
          React.createElement('div', { style: S.grid },
            React.createElement('label', { style: S.field },
              React.createElement('span', { style: S.fieldLabel }, __t('fieldTimeout')),
              renderNumberInput({ value: values.toolCallTimeoutMs, field: 'defaults.toolCallTimeoutMs', onChange: (v) => set('toolCallTimeoutMs', v), disabled: locked }),
              renderFieldError(fieldErrors.toolCallTimeoutMs),
              React.createElement('span', { style: S.muted }, __tf('fieldTimeoutHint', { n: FALLBACK_DEFAULTS.toolCallTimeoutMs })),
            ),
            React.createElement('label', { style: S.field },
              React.createElement('span', { style: S.fieldLabel }, __t('fieldMaxBytes')),
              renderNumberInput({ value: values.maxInstructionBytes, field: 'defaults.maxInstructionBytes', onChange: (v) => set('maxInstructionBytes', v), disabled: locked }),
              renderFieldError(fieldErrors.maxInstructionBytes),
              React.createElement('span', { style: S.muted }, __tf('fieldMaxBytesHint', { n: FALLBACK_DEFAULTS.maxInstructionBytes })),
            ),
            React.createElement('label', { style: S.field },
              React.createElement('span', { style: S.fieldLabel }, __t('defaultsProbeTimeout')),
              renderNumberInput({ value: values.probeTimeoutMs, field: 'defaults.probeTimeoutMs', onChange: (v) => set('probeTimeoutMs', v), disabled: locked }),
              renderFieldError(fieldErrors.probeTimeoutMs),
              React.createElement('span', { style: S.muted }, __tf('defaultsProbeTimeoutHint', { n: FALLBACK_DEFAULTS.probeTimeoutMs })),
            ),
            React.createElement('label', { style: S.field },
              React.createElement('span', { style: S.fieldLabel }, __t('defaultsTransport')),
              React.createElement('select', {
                style: S.input,
                value: values.defaultTransport,
                disabled: locked,
                onChange: (event) => set('defaultTransport', event.target.value),
              }, TRANSPORTS.map((item) => React.createElement('option', { key: item, value: item }, item))),
            ),
            React.createElement('label', { style: S.field },
              React.createElement('span', { style: S.fieldLabel }, __t('fieldFailStartup')),
              renderToggle({
                on: Boolean(values.failOnStartupError),
                disabled: locked,
                field: 'defaults.failOnStartupError',
                title: __t('fieldFailStartupHint'),
                onToggle: () => set('failOnStartupError', !values.failOnStartupError),
              }),
            ),
          ),
          React.createElement('div', { style: S.cardActions },
            React.createElement('button', {
              type: 'button',
              style: merge(S.button, S.buttonPrimary, locked ? S.buttonDisabled : null),
              disabled: locked,
              onClick: () => onSaveDefaults(),
            }, __t('defaultsSave')),
            React.createElement('button', {
              type: 'button',
              style: S.button,
              onClick: () => setDefaultsDraft(defaultsForm(null)),
            }, __t('defaultsReset')),
          ),
        )
      }

      const renderMigrate = () => {
        if (!migratePlan) return null
        const nothing = migratePlan.rewrites + migratePlan.additions + migratePlan.converged === 0
        return React.createElement('div', { style: S.form },
          React.createElement('div', { style: S.cardTitle }, __t('migrateTitle')),
          React.createElement('div', { style: S.cardMeta },
            nothing
              ? __t('migrateNothing')
              : __tf('migratePlan', {
                  rewrites: migratePlan.rewrites,
                  additions: migratePlan.additions,
                  converged: migratePlan.converged,
                  skipped: migratePlan.skipped,
                }),
          ),
          migratePlan.reasons.length
            ? React.createElement('div', { style: S.muted }, __tf('migrateSkipped', { reasons: migratePlan.reasons.slice(0, 4).join('；') }))
            : null,
          React.createElement('div', { style: S.muted }, __t('migrateBackup')),
          React.createElement('div', { style: S.cardActions },
            React.createElement('button', {
              type: 'button',
              style: merge(S.button, S.buttonPrimary, locked || nothing ? S.buttonDisabled : null),
              disabled: locked || nothing,
              onClick: () => onMigrate(true),
            }, __t('confirm')),
            React.createElement('button', { type: 'button', style: S.button, onClick: () => setMigratePlan(null) }, __t('cancel')),
          ),
        )
      }

      const renderMatrix = (server) => {
        const map = matrixMap(server.matrix, profiles)
        const plan = matrixPlan(server, map, profiles, activeProfile)
        return React.createElement('div', { style: S.matrix },
          profiles.length === 0
            ? React.createElement('span', { style: S.muted }, __t('profilesNone'))
            : profiles.map((profile) => React.createElement('label', { key: profile, style: S.matrixCell },
                React.createElement('input', {
                  type: 'checkbox',
                  checked: Boolean(map[profile]),
                  disabled: locked,
                  'data-server': server.id,
                  'data-profile': profile,
                  onChange: () => onMatrixToggle(server, profile, !map[profile]),
                }),
                React.createElement('span', null, profile + (profile === activeProfile ? ' ' + __t('matrixThis') : '')),
              )),
          React.createElement('span', { style: S.spacer }),
          React.createElement('span', { style: S.muted },
            plan.selected.length === profiles.length && profiles.length > 0
              ? __t('profilesAll')
              : (plan.selected.length === 0 ? __t('profilesNone') : plan.selected.join('、')),
          ),
        )
      }

      const renderServer = (server) => {
        const drift = driftLines(server.layoutDrift)
        const probe = probes[server.id] || null
        const probeText = (() => {
          if (!probe) return null
          if (probe.phase === 'running') return __t('probeBusy')
          if (probe.phase === 'ok') {
            const ms = probe.latencyMs === null ? __t('probeNoLatency') : probe.latencyMs
            return probe.toolCount ? __tf('probeOk', { ms: ms, n: probe.toolCount }) : __tf('probeOkNoTools', { ms: ms })
          }
          const ms = probe.latencyMs === null ? __t('probeNoLatency') : probe.latencyMs
          return __tf('probeFail', { error: probe.error || __t('probeFailed'), ms: ms })
        })()
        return React.createElement('div', { style: S.card, 'data-card': server.id },
          React.createElement('div', { style: S.cardHead },
            React.createElement('span', { style: S.cardTitle }, server.serverName || server.id),
            React.createElement('span', { style: S.cardId }, server.id),
            React.createElement('span', { style: S.tag }, String(server.transport || '')),
            React.createElement('span', { style: S.tag }, layerText(server)),
            React.createElement('span', { style: merge(S.tag, staticStateStyle(server)) }, staticStateText(server)),
            server.enabled === false ? React.createElement('span', { style: merge(S.tag, S.tagWarn) }, __t('disabled')) : null,
            drift.length ? React.createElement('span', { style: merge(S.tag, S.tagWarn), 'data-drift': server.id }, __t('drift')) : null,
            React.createElement('span', { style: S.spacer }),
            renderToggle({
              on: server.enabled !== false,
              disabled: locked,
              field: 'enabled',
              target: server.id,
              title: __t('toggleTitle'),
              onToggle: () => onToggleEnabled(server),
            }),
          ),
          renderMeta(server, profiles),
          drift.length
            ? React.createElement('div', { style: S.cardMeta },
                __t('driftHint'),
                React.createElement('ul', { style: S.problems },
                  drift.map((line, index) => React.createElement('li', { key: index }, line)),
                ),
              )
            : null,
          renderMatrix(server),
          React.createElement('div', { style: S.cardActions },
            React.createElement('button', {
              type: 'button',
              style: S.button,
              'data-tools-open': server.id,
              onClick: () => onOpenTools(server),
            }, __t('tools')),
            React.createElement('button', {
              type: 'button',
              style: S.button,
              disabled: locked,
              onClick: () => (editing === server.id ? onCancelForm() : onEdit(server)),
            }, editing === server.id ? __t('collapse') : __t('edit')),
            React.createElement('button', {
              type: 'button',
              style: S.button,
              disabled: locked,
              'data-raw': server.id,
              onClick: () => onEdit(server, true),
            }, __t('rawEntry')),
            React.createElement('button', {
              type: 'button',
              style: merge(S.button, locked ? null : S.buttonDanger),
              disabled: locked,
              onClick: () => onRemove(server),
            }, __t('remove')),
            React.createElement('button', {
              type: 'button',
              style: merge(S.button, busy === 'probe:' + server.id ? S.buttonDisabled : null),
              disabled: locked,
              'data-probe': server.id,
              onClick: () => onProbe(server),
            }, __t('probe')),
            React.createElement('span', { style: S.spacer }),
            probeText ? React.createElement('span', { style: probe && probe.phase === 'failed' ? S.error : S.muted }, probeText) : null,
          ),
          React.createElement('div', { style: S.muted }, __t('probeSpawnHint')),
          editing === server.id ? renderDraftForm() : null,
        )
      }

      const renderDraftForm = () => {
        const current = draft || blankDraft(defaults)
        const editingRow = Boolean(editing)
        // YAML 子页：内容是整段 config 的 YAML（不含 - insert: 外壳），改过就以它为准。
        const rawText = current.rawDirty ? current.raw : serializeConfigYaml(configOf(current))
        const errorLines = Object.keys(fieldErrors || {}).map((key) => key + '：' + __tf(fieldErrors[key], {}))
        return React.createElement('div', { style: S.form },
          React.createElement('div', { style: S.cardTitle }, editingRow ? __tf('editTitle', { id: editing }) : __t('addTitle')),
          React.createElement('div', { style: S.grid },
            React.createElement('label', { style: S.field },
              React.createElement('span', { style: S.fieldLabel }, __t('fieldServerName')),
              React.createElement('input', {
                style: S.input,
                value: current.serverName,
                spellCheck: false,
                'data-field': 'serverName',
                disabled: Boolean(busy),
                placeholder: __t('serverNamePlaceholder'),
                onChange: (event) => setField('serverName', event.target.value),
              }),
              renderFieldError(fieldErrors.serverName),
            ),
            React.createElement('label', { style: S.field },
              React.createElement('span', { style: S.fieldLabel }, __t('fieldId')),
              React.createElement('input', {
                style: S.input,
                value: current.id,
                spellCheck: false,
                'data-field': 'id',
                disabled: editingRow || Boolean(busy),
                placeholder: __t('idPlaceholder'),
                onChange: (event) => setField('id', event.target.value),
              }),
              renderFieldError(fieldErrors.id),
              React.createElement('span', { style: S.muted }, __t('idHint')),
            ),
            React.createElement('label', { style: S.field },
              React.createElement('span', { style: S.fieldLabel }, __t('fieldTransport')),
              React.createElement('select', {
                style: S.input,
                value: current.transport,
                'data-field': 'transport',
                disabled: Boolean(busy),
                onChange: (event) => setField('transport', event.target.value),
              }, TRANSPORTS.map((item) => React.createElement('option', { key: item, value: item }, item))),
              renderFieldError(fieldErrors.transport),
            ),
            editingRow
              ? null
              : React.createElement('label', { style: S.field },
                  React.createElement('span', { style: S.fieldLabel }, __t('fieldLevel')),
                  React.createElement('select', {
                    style: S.input,
                    value: current.level,
                    disabled: Boolean(busy),
                    onChange: (event) => setField('level', event.target.value),
                  }, [{ value: 'home', label: __t('levelHome') }].concat(
                    profiles.map((profile) => ({ value: profile, label: __tf('levelProfileOption', { profile: profile }) })),
                  ).map((option) => React.createElement('option', { key: option.value, value: option.value }, option.label))),
                ),
          ),
          current.transport === 'stdio'
            ? React.createElement('div', { style: S.grid },
                React.createElement('label', { style: S.field },
                  React.createElement('span', { style: S.fieldLabel }, __t('fieldCommand')),
                  React.createElement('input', {
                    style: S.input,
                    value: current.command,
                    spellCheck: false,
                    'data-field': 'command',
                    disabled: Boolean(busy),
                    placeholder: __t('commandPlaceholder'),
                    onChange: (event) => setField('command', event.target.value),
                  }),
                  renderFieldError(fieldErrors.command),
                ),
                React.createElement('label', { style: S.field },
                  React.createElement('span', { style: S.fieldLabel }, __t('fieldCwd')),
                  React.createElement('input', {
                    style: S.input,
                    value: current.cwd,
                    spellCheck: false,
                    disabled: Boolean(busy),
                    onChange: (event) => setField('cwd', event.target.value),
                  }),
                ),
                React.createElement('label', { style: S.fieldFull },
                  React.createElement('span', { style: S.fieldLabel }, __t('fieldArgs')),
                  React.createElement('textarea', {
                    style: merge(S.textarea, { minHeight: 60 }),
                    value: current.args,
                    spellCheck: false,
                    disabled: Boolean(busy),
                    onChange: (event) => setField('args', event.target.value),
                  }),
                  React.createElement('span', { style: S.muted }, __t('argsHint')),
                ),
                React.createElement('label', { style: S.fieldFull },
                  React.createElement('span', { style: S.fieldLabel }, __t('fieldEnv')),
                  React.createElement('textarea', {
                    style: merge(S.textarea, { minHeight: 60 }),
                    value: current.env,
                    spellCheck: false,
                    disabled: Boolean(busy),
                    onChange: (event) => setField('env', event.target.value),
                  }),
                  React.createElement('span', { style: S.muted }, __t('fieldEnvHint')),
                ),
              )
            : React.createElement('div', { style: S.grid },
                React.createElement('label', { style: S.fieldFull },
                  React.createElement('span', { style: S.fieldLabel }, __t('fieldUrl')),
                  React.createElement('input', {
                    style: S.input,
                    value: current.url,
                    spellCheck: false,
                    disabled: Boolean(busy),
                    placeholder: __t('urlPlaceholder'),
                    onChange: (event) => setField('url', event.target.value),
                  }),
                  renderFieldError(fieldErrors.url),
                ),
                React.createElement('label', { style: S.fieldFull },
                  React.createElement('span', { style: S.fieldLabel }, __t('fieldHeaders')),
                  React.createElement('textarea', {
                    style: merge(S.textarea, { minHeight: 60 }),
                    value: current.headers,
                    spellCheck: false,
                    disabled: Boolean(busy),
                    onChange: (event) => setField('headers', event.target.value),
                  }),
                  React.createElement('span', { style: S.muted }, __t('fieldHeadersHint')),
                ),
              ),
          React.createElement('div', { style: S.grid },
            React.createElement('label', { style: S.field },
              React.createElement('span', { style: S.fieldLabel }, __t('fieldTimeout')),
              renderNumberInput({ value: current.toolCallTimeoutMs, field: 'toolCallTimeoutMs', onChange: (v) => setField('toolCallTimeoutMs', v), disabled: Boolean(busy) }),
              renderFieldError(fieldErrors.toolCallTimeoutMs),
              React.createElement('span', { style: S.muted }, __tf('fieldTimeoutHint', { n: FALLBACK_DEFAULTS.toolCallTimeoutMs })),
            ),
            React.createElement('label', { style: S.field },
              React.createElement('span', { style: S.fieldLabel }, __t('fieldMaxBytes')),
              renderNumberInput({ value: current.maxInstructionBytes, field: 'maxInstructionBytes', onChange: (v) => setField('maxInstructionBytes', v), disabled: Boolean(busy) }),
              renderFieldError(fieldErrors.maxInstructionBytes),
              React.createElement('span', { style: S.muted }, __tf('fieldMaxBytesHint', { n: FALLBACK_DEFAULTS.maxInstructionBytes })),
            ),
            React.createElement('label', { style: S.field },
              React.createElement('span', { style: S.fieldLabel }, __t('fieldFailStartup')),
              renderToggle({
                on: Boolean(current.failOnStartupError),
                disabled: Boolean(busy),
                field: 'failOnStartupError',
                title: __t('fieldFailStartupHint'),
                onToggle: () => setField('failOnStartupError', !current.failOnStartupError),
              }),
            ),
          ),
          React.createElement('div', { style: S.cardActions },
            React.createElement('button', { type: 'button', style: S.button, onClick: () => setShowRaw(!showRaw) },
              showRaw ? __t('fieldsHide') : __t('fieldsShow')),
            current.rawDirty ? React.createElement('span', { style: S.tagWarn }, __t('fieldsDirty')) : null,
          ),
          showRaw
            ? React.createElement('div', { style: S.fieldFull },
                React.createElement('div', { style: S.muted }, __t('fieldsHint')),
                React.createElement('div', { style: S.cardTitle }, __t('fieldsTitle')),
                current.rawDirty && errorLines.length
                  ? React.createElement('div', { style: S.bannerBad, 'data-raw-errors': current.id || 'new' },
                      React.createElement('div', null, __t('fieldsErrors')),
                      errorLines.map((line) => React.createElement('div', { key: line, style: S.mono }, line)),
                    )
                  : null,
                React.createElement('textarea', {
                  style: S.textarea,
                  value: rawText,
                  spellCheck: false,
                  disabled: Boolean(busy),
                  'data-raw-yaml': current.id || 'new',
                  onChange: (event) => setDraft(Object.assign({}, current, { rawDirty: true, raw: event.target.value })),
                }),
                React.createElement('button', {
                  type: 'button',
                  style: S.button,
                  onClick: () => setDraft(Object.assign({}, current, { rawDirty: false, raw: '' })),
                }, __t('fieldsReset')),
              )
            : null,
          React.createElement('div', { style: S.cardActions },
            React.createElement('button', {
              type: 'button',
              style: merge(S.button, S.buttonPrimary, busy ? S.buttonDisabled : null),
              disabled: Boolean(busy),
              onClick: () => onSaveDraft(),
            }, __t('save')),
            React.createElement('button', { type: 'button', style: S.button, onClick: () => onCancelForm() }, __t('cancel')),
          ),
        )
      }

      /**
       * 工具对话框：加载 / 结果 / 空态 / 错误四态就地显示；关闭、重试、真探测都只影响这个对话框。
       * 打开即请求静态清单（mode 缺省），只有点「真探测」才带 mode:'probe'。
       */
      const renderTools = () => {
        if (!toolsFor) return null
        const row = servers.filter((server) => server.id === toolsFor)[0] || null
        const state = toolsState || { phase: 'loading', mode: 'static', serverName: '', tools: [], latencyMs: null, note: '', error: null }
        // 标题优先用宿主回报的 serverName（该条目可能不在本 profile 的列表里），其次用行上的名字。
        const name = state.serverName || (row && (row.serverName || row.id)) || toolsFor
        const tools = Array.isArray(state.tools) ? state.tools : []
        const ready = state.phase === 'ready'
        const probeMode = state.mode === 'probe'
        const title = ready && tools.length ? __tf('toolsTitle', { name: name, n: tools.length }) : __tf('toolsTitleEmpty', { name: name })
        const note = state.note || (ready && !probeMode ? __t('toolsStaticHint') : '')
        const latency = probeMode && typeof state.latencyMs === 'number' ? __tf('toolsLatency', { ms: state.latencyMs }) : null
        const body = []
        if (state.phase === 'loading') {
          body.push(React.createElement('div', { style: S.muted, 'data-tools-loading': 'true' },
            probeMode ? __t('toolsProbeLoading') : __t('toolsLoading')))
        } else if (state.phase === 'error') {
          const error = state.error || {}
          const fields = error.fields && typeof error.fields === 'object' ? error.fields : {}
          body.push(React.createElement('div', { style: merge(S.banner, S.bannerBad), 'data-tools-error': error.code || 'error' },
            React.createElement('div', null, __t('toolsFailed') + '：' + String(error.message || '')),
            error.code ? React.createElement('div', { style: S.muted }, __tf('hostUnavailableCode', { code: error.code })) : null,
            Object.keys(fields).map((key) => React.createElement('div', { key: key, style: S.error }, key + '：' + String(fields[key]))),
          ))
        } else if (!tools.length) {
          body.push(React.createElement('div', { style: S.muted, 'data-tools-empty': 'true' }, __t('toolsEmpty')))
        } else {
          for (const tool of tools) {
            const expanded = Boolean(toolsExpanded[tool.name])
            body.push(React.createElement('div', { style: S.toolRow, key: tool.name, 'data-tool': tool.name },
              React.createElement('div', { style: S.toolHead },
                React.createElement('span', { style: S.toolName }, tool.name),
                React.createElement('button', {
                  type: 'button',
                  style: S.button,
                  'data-tool-copy': tool.name,
                  onClick: () => onCopyTool(tool.name),
                }, copiedTool === tool.name ? __t('toolsCopied') : __t('toolsCopy')),
              ),
              tool.description
                ? React.createElement('div', {
                    style: merge(S.toolDesc, expanded ? S.toolDescOpen : null),
                    'data-tool-desc': tool.name,
                    'data-expanded': expanded ? 'true' : 'false',
                    title: tool.description,
                    onClick: () => onToggleTool(tool.name),
                  }, tool.description)
                : null,
            ))
          }
        }
        const actions = []
        if (state.phase === 'error') {
          actions.push(React.createElement('button', {
            type: 'button',
            style: S.button,
            'data-tools-retry': 'true',
            onClick: () => onRetryTools(),
          }, __t('toolsRetry')))
        }
        if (state.phase !== 'loading') {
          actions.push(React.createElement('button', {
            type: 'button',
            style: merge(S.button, S.buttonPrimary),
            'data-tools-probe': toolsFor,
            onClick: () => onProbeTools(),
          }, __t('toolsProbe')))
        }
        return React.createElement('div', {
          style: S.overlay,
          'data-tools-dialog': toolsFor,
          onClick: (event) => { if (event && event.target === event.currentTarget) onCloseTools() },
        },
          React.createElement('div', { style: S.dialog, role: 'dialog', 'aria-modal': 'true' },
            React.createElement('div', { style: S.dialogHead },
              React.createElement('span', { style: S.cardTitle, 'data-tools-title': toolsFor }, title),
              React.createElement('span', {
                style: merge(S.tag, probeMode ? S.tagOn : null),
                'data-tools-badge': probeMode ? 'probe' : 'static',
              }, probeMode ? __t('toolsBadgeProbe') : __t('toolsBadgeStatic')),
              latency ? React.createElement('span', { style: S.muted, 'data-tools-latency': 'true' }, latency) : null,
              React.createElement('span', { style: S.spacer }),
              React.createElement('button', {
                type: 'button',
                style: S.button,
                'data-tools-close': 'true',
                onClick: () => onCloseTools(),
              }, __t('toolsClose')),
            ),
            body,
            note ? React.createElement('div', { style: S.muted, 'data-tools-note': 'true' }, note) : null,
            React.createElement('div', { style: S.dialogHead },
              React.createElement('span', { style: S.muted }, __t('toolsProbeHint')),
              React.createElement('span', { style: S.spacer }),
              actions,
            ),
          ),
        )
      }

      return React.createElement('div', { style: S.root, 'data-panel': 'dsh-mcp-manager' },
        React.createElement('div', { style: S.intro }, __t('intro')),
        React.createElement('div', { style: S.toolbar },
          React.createElement('button', { type: 'button', style: merge(S.button, busy === 'list' ? S.buttonDisabled : null), disabled: Boolean(busy), onClick: () => load() }, __t('refresh')),
          React.createElement('button', { type: 'button', style: merge(S.button, locked ? S.buttonDisabled : null), disabled: locked, onClick: () => onAdd() }, __t('add')),
          React.createElement('button', { type: 'button', style: merge(S.button, locked ? S.buttonDisabled : null), disabled: locked, onClick: () => onFiles() }, __t('files')),
          React.createElement('button', { type: 'button', style: merge(S.button, locked ? S.buttonDisabled : null), disabled: locked, onClick: () => onDefaults() }, __t('defaultsTitle')),
          React.createElement('button', { type: 'button', style: merge(S.button, locked ? S.buttonDisabled : null), disabled: locked, onClick: () => onMigrate(false) }, __t('migrate')),
          React.createElement('span', { style: S.spacer }),
          busy ? React.createElement('span', { style: S.muted }, __tf('busyWith', { action: busy })) : null,
        ),
        snapshot
          ? React.createElement('div', { style: S.cardMeta },
              __tf('profileLine', { profile: activeProfile || __t('profilesNone'), home: snapshot.home || '' }),
              ' · ',
              __tf('total', { n: servers.length }),
              ' · ',
              __tf('enabledOf', { on: enabledCount, total: servers.length }),
              driftServers.length ? ' · ' + __t('drift') + ' ' + driftServers.length : '',
            )
          : null,
        renderFailure(),
        renderNotice(),
        renderReadOnly(),
        renderFiles(),
        renderDefaults(),
        renderMigrate(),
        busy === 'list' && !snapshot ? React.createElement('div', { style: S.muted }, __t('busy')) : null,
        snapshot
          ? React.createElement('div', { style: S.toolbar },
              React.createElement('span', { style: S.cardTitle }, __t('matrixTitle')),
              React.createElement('span', { style: S.muted }, __t('matrixHint')),
              React.createElement('span', { style: S.spacer }),
              React.createElement('span', { style: S.muted }, __t('matrixReloadHint')),
            )
          : null,
        snapshot && servers.length === 0
          ? React.createElement('div', null,
              React.createElement('div', { style: S.muted }, __t('empty')),
              React.createElement('div', { style: S.muted }, __t('emptyHint')),
            )
          : null,
        (draft && !editing ? renderDraftForm() : null),
        servers.map((server) => renderServer(server)),
        snapshot ? renderDiagnostics(snapshot.diagnostics) : null,
        renderTools(),
      )

      /** 宿主诊断（成功路径也显示，便于排查「矩阵没生效」这类问题）。 */
      function renderDiagnostics(diagnostics) {
        const lines = diagnosticLines(diagnostics)
        if (!lines.length) return null
        return React.createElement('div', { style: S.form },
          React.createElement('div', { style: S.cardTitle }, __t('diagnostics')),
          React.createElement('ul', { style: S.problems },
            lines.map((line, index) => React.createElement('li', { key: index, style: S.mono }, line)),
          ),
        )
      }
    }

    /** 全局默认参数表单草稿。参数：source（宿主返回值或 null）。返回值：object。 */
    function defaultsForm(source) {
      const values = Object.assign({}, FALLBACK_DEFAULTS, source && typeof source === 'object' ? source : {})
      const transport = TRANSPORTS.indexOf(String(values.defaultTransport)) >= 0 ? String(values.defaultTransport) : 'stdio'
      return {
        toolCallTimeoutMs: String(values.toolCallTimeoutMs),
        maxInstructionBytes: String(values.maxInstructionBytes),
        probeTimeoutMs: String(values.probeTimeoutMs),
        defaultTransport: transport,
        failOnStartupError: Boolean(values.failOnStartupError),
      }
    }

    // --- apply ----------------------------------------------------------------

    /**
     * 功能作用：把面板挂进核心「本地插件」设置页的 tab 槽（无 props）。
     * 参数：ctx -- client 插件上下文
     * 返回值：无
     */
    function apply(ctx) {
      adoptLocale(ctx.get('locale'), ctx)
      if (!__locale) {
        try {
          ctx.inject(['locale'], (sub) => {
            let locale = null
            try { locale = typeof sub.get === 'function' ? sub.get('locale') : null } catch { /* guarded */ }
            adoptLocale(locale || sub.locale, ctx)
          })
        } catch { /* 没有 locale 服务：走嗅探兜底字典 */ }
      }
      ctx.slots.inject(TAB_SLOT, () => ctx.slots.register({
        name: TAB_SLOT,
        id: TAB_ID,
        order: TAB_ORDER,
        label: () => __t('tab.title'),
        ...(__locale ? { locale: NS } : {}),
      }, McpServersPanel))
    }

    // Test-only hooks: only exposed when the harness sets window.__DSH_TEST__, so the
    // offline harness can drive the module-scoped helpers without a browser.
    if (typeof window !== 'undefined' && window.__DSH_TEST__) {
      window.__dshMcpManager = {
        callApi,
        normalizeSnapshot,
        diagnosticLines,
        selectedProfiles,
        matrixMap,
        matrixPlan,
        profilesText,
        layerText,
        staticStateText,
        toolsText,
        toolsOutcome,
        driftLines,
        linesToMap,
        mapToLines,
        splitArgs,
        positiveNumber,
        serializeEntryYaml,
        serializeConfigYaml,
        yamlServerName,
        configOf,
        draftOf,
        blankDraft,
        validateDraft,
        defaultsForm,
        McpServersPanel,
        __t,
        __tf,
        API,
        NS,
        TAB_SLOT,
        TAB_ID,
        TAB_ORDER,
        PLUGIN_HEADER,
        FALLBACK_DEFAULTS,
        zhDict,
        enDict,
        reset() { __locale = null },
      }
    }

    // The loader gates apply() until slots exists; locale is resolved independently
    // above through a deferred inject.
    return { apply, inject: ['slots'] }
  },
})
//# sourceURL=/dsh-mcp-manager/src/client.js
