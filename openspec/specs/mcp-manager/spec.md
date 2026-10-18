# mcp-manager Specification

## Purpose

让用户在 DSH 里集中管理 MCP 服务器：每台服务器在全局 patch 里只有一份唯一定义，按 profile 的生效矩阵决定它落在哪一层，全局默认参数统一新条目的初始值；并在设置页「本地插件」里查看静态状态、按需探测连接、查看每台服务器的工具清单。

## Requirements

### Requirement: MCP 定义的落点由生效矩阵决定

每台 MCP 服务器的定义 SHALL 是一条 `- insert:` 行，条目形如 `{ id, name: '@deepseek-ai/dsh-mcp-client', config }`，行块之前 SHALL 紧邻标记 `# dsh-mcp-manager:2:server:<id>`。落点 SHALL 由它生效的 profile 集合 `S` 与已知 profile 集合 `P` 决定：

- `S == P`（全员生效，`P` 非空）→ 只写 `$DSH_HOME/cordis.patch.yml`（home 层）一条，不带 `disabled`；
- `∅ ≠ S ⊊ P` → 写进每个 `p ∈ S` 的 `profiles/<p>/cordis.patch.yml`，且 home 层与其它 profile MUST NOT 残留该 id 的行；
- `S == ∅` → 保留 home 层一条并在该 insert 行内部带 `disabled: true`（定义与元数据不丢）。

写入前 SHALL 硬校验「同一 id 不同时存在于 home 层与任一 profile 层」，违反即拒绝并返回可读错误，文件不变。

本插件 MUST NOT 写 `$DSH_HOME/dsh-mcp.json`；MUST NOT 依赖 profile 层的 disable 覆盖行去禁用定义在 home 层的条目——核心的补丁应用顺序（bundle → profile → home → CLI overlay）使该覆盖在 home 层 insert 之前被跳过（已用 `vendor/include` 的真实实现实测）。

#### Scenario: 全员生效只写 home 层

- **WHEN** 用户在面板新增服务器 `mcp-demo`（stdio，`command: demo`）并在 desktop/web/dsh-tui 全部勾选后保存
- **THEN** 只有 `$DSH_HOME/cordis.patch.yml` 出现一条带 `# dsh-mcp-manager:2:server:mcp-demo` 标记的 `- insert:` 行块，三个 profile 的 patch 与 `dsh-mcp.json` 均未被改动

#### Scenario: 部分生效写进被选中的 profile

- **WHEN** 用户把 `mcp-demo` 改为只在 desktop 与 web 生效
- **THEN** home 层不再有该 id 的行；`profiles/desktop/cordis.patch.yml` 与 `profiles/web/cordis.patch.yml` 各出现一条带标记的 insert 行；`profiles/dsh-tui/cordis.patch.yml` 未被改动

#### Scenario: 全部取消勾选保留定义但停用

- **WHEN** 用户在所有 profile 上取消勾选 `mcp-demo`
- **THEN** home 层保留一条带 `:2:` 标记的 insert 行且其内部为 `disabled: true`，任何 profile 都不残留该 id

#### Scenario: 编辑只影响目标行块

- **WHEN** 面板把 `mcp-demo`（部分生效形态）的 `command` 改为 `demo2` 并保存
- **THEN** 只有各副本的标记行块内的 `command` 行发生变化，所有文件内其它行、注释、空行与 `!!js` 表达式逐字不变

#### Scenario: 同 id 跨层重复被拒绝

- **WHEN** 目标写入会使同一 id 同时存在于 home 层与某 profile 层
- **THEN** 写入被拒绝并返回可读错误，相关文件未被修改、未产生备份

### Requirement: 按 profile 的生效矩阵

插件 SHALL 扫描 `$DSH_HOME/profiles/*`（排除 `node_modules`）自动发现 profile，并在面板上为每台服务器提供「在哪些 profile 生效」的复选矩阵；矩阵的每次变更 SHALL 按上一节的落点规则重排文件，且 SHALL 只改动涉及该服务器的行块。

矩阵意图 SHALL 由行分布反推：行在 home 层且不带 `disabled` = 全员生效；行出现在部分 profile = 只对那部分生效；home 层一条且 `disabled: true` = 全不生效。

当 profile 集合变化（新增/删除 profile 目录）使已存布局与期望形态不一致时，插件 SHALL 在面板标记「布局待修复 / 待确认」并给出建议动作与目标文件，MUST NOT 静默改写文件。

#### Scenario: 矩阵按行分布反推

- **WHEN** `$DSH_HOME/cordis.patch.yml` 有 5 条普通 insert 行、1 条带 `disabled: true` 的 insert 行，`profiles/desktop/cordis.patch.yml` 另有 1 条 insert 行
- **THEN** 面板显示前 5 台对全部 profile 生效、第 6 台全不生效、profile 层那一台只对 desktop 生效

#### Scenario: profile 列表来自磁盘

- **WHEN** `$DSH_HOME/profiles` 下存在 `desktop`、`web`、`dsh-tui` 与 `node_modules`
- **THEN** 矩阵列出三个 profile（`node_modules` 不作为 profile），且每台的取舍相互独立

#### Scenario: 新增 profile 不影响全员生效的服务器

- **WHEN** 用户新建 profile 目录 `profiles/foo`，而某服务器是「全员生效」形态（home 层一条）
- **THEN** 面板显示它对新 profile 也生效，且不产生任何写入

#### Scenario: 部分生效的服务器遇到新 profile 时提示

- **WHEN** 只对 desktop 生效的服务器遇上新出现的 profile `foo`
- **THEN** 面板把它标记为「布局待确认」并提示可让 `foo` 也生效，MUST NOT 自动写入

### Requirement: 全局默认参数

插件 SHALL 在 `$DSH_HOME/.dsh-mcp-manager/state.json` 维护全局默认参数（至少 `toolCallTimeoutMs`、`failOnStartupError`、`maxInstructionBytes`、`probeTimeoutMs`、`defaultTransport`），并在新增表单里以这些值作为初始值。保存服务器时这些值 SHALL 落成该条目 `config` 内的具体字段，MUST NOT 以引用或继承方式留在 patch 之外。

默认参数 MUST NOT 写入任何 `cordis.patch.yml`；`state.json` 解析失败或不存在时 MUST 回退到内置默认值且不报错。

#### Scenario: 默认参数决定新表单初值

- **WHEN** 用户把 `toolCallTimeoutMs` 默认值改为 45000，然后打开新增表单
- **THEN** 表单的该字段初值为 45000

#### Scenario: 默认参数不落进 patch

- **WHEN** 用户用默认参数新增一台服务器并保存
- **THEN** 该条目 `config` 内出现具体值（如 `toolCallTimeoutMs: 45000`），而 `state.json` 之外没有任何地方出现「默认」语义的键

### Requirement: 标记、所有权与一次性迁移

插件 SHALL 只修改「带 `# dsh-mcp-manager:2:` 标记的行块」以及被用户显式纳入管理的行块；其它内容 MUST 逐字保留。

插件 SHALL 提供一次性迁移动作：把旧标记 `# dsh-mcp-manager:server:<id>` 与 `# dsh-mcp-manager:disable:<id>` 改写为新标记，并把**形态匹配**（位于 `- insert:` 列表内、`name: '@deepseek-ai/dsh-mcp-client'`）但**没有标记**的条目补上新标记。迁移 SHALL 幂等、SHALL 在执行前备份原文件、SHALL 在结果中如实报告「改写条数 / 补齐条数 / 跳过条数及原因」。

#### Scenario: 迁移改写旧标记并补齐无标记条目

- **WHEN** 对含 5 条旧标记条目、1 条无标记同类条目、若干无关注释的文件执行迁移
- **THEN** 6 条全部带 `:2:` 新标记（5 条改写、1 条补齐），无关注释逐字不变，且再次执行迁移不产生任何写入

#### Scenario: 不碰无标记且形态不匹配的行

- **WHEN** 文件中存在 `name: '@deepseek-ai/dsh-mcp-client'` 之外的 `insert` 条目或顶层其它键
- **THEN** 迁移不修改它们，并在结果里报告为跳过

### Requirement: 写盘安全（保注释、原子、可回滚）

所有对 `cordis.patch.yml` 的写入 SHALL 采用行级块替换 + 原子写（同目录临时文件 + rename），MUST NOT 整文件重新序列化。写操作 SHALL 保留原文件的行尾风格（CRLF/LF）与末尾换行状态，SHALL 在写前把原文件备份为同目录 `<文件名>.bak-<时间戳>`，并 SHALL 只在最近 10 份备份中保留。

写入前 SHALL 重新读取目标文件并重新定位行块；同一文件的写操作 SHALL 串行化。若文件无法解析为合法 YAML，插件 MUST 拒绝写入并在面板说明原因（只读降级）。

#### Scenario: 非目标行逐字保留

- **WHEN** 对含中文注释、`!!js` 表达式、CRLF 行尾的样本文件执行「加/改/删/启停/矩阵/迁移」任一操作
- **THEN** 除目标行块外的全部字节与操作前完全一致，行尾风格不变

#### Scenario: 解析失败时拒绝写入

- **WHEN** 目标文件内容不是合法 YAML
- **THEN** 面板显示只读与原因，任何写端点返回错误码且文件未被修改、未产生备份

### Requirement: 面板与状态展示

插件 SHALL 在 core 设置页「本地插件」的 tab 槽位 `settings.localPlugins.tab` 注册一个分页，列出所有受管服务器，并显示：条目 id、`serverName`、transport（stdio/http）、来源层（全局 / 仅 profile 覆盖）、生效 profile 集合、静态状态（未加载 / 加载中 / 已激活 / 失败 / 已停用）、静态工具数估计、以及原始 YAML 兜底编辑入口。

面板的失败面 MUST NOT 阻塞设置页渲染：宿主端点不可用时 SHALL 显示可读原因，而不是空白或抛错。

#### Scenario: 列出 home patch 中的既有条目

- **WHEN** `$DSH_HOME/cordis.patch.yml` 含 6 条 MCP 条目（其中 1 条在 `desktop` 有覆盖行）
- **THEN** 面板列出 6 行，其中该条的生效 profile 集合不含 `desktop`，其余条目的生效集合包含全部 profile

#### Scenario: 宿主端点不可用时的降级

- **WHEN** 宿主半未能注册 HTTP 路由
- **THEN** 面板显示「宿主端点不可用」与原因，设置页其余部分正常渲染

### Requirement: 按需探测连接

插件 SHALL 提供「测试连接」动作：按条目 `config` 启动一次 MCP 客户端（stdio 或 streamable-http），在 `probeTimeoutMs`（默认 8000）内完成 `initialize` 与 `tools/list`，返回 `{ ok, latencyMs, toolCount }` 或 `{ ok:false, latencyMs, error }`，并在任何结果下关闭客户端、不留子进程。

探测 MUST 由用户显式触发（或脚本显式调用），MUST NOT 在面板加载时自动对全部条目发起；探测失败 MUST NOT 影响条目本身与面板其它功能。

#### Scenario: 探测成功返回工具数

- **WHEN** 用户对一台可用的 stdio 服务器点「测试连接」
- **THEN** 面板显示成功、延迟与工具数，且进程在返回后被关闭

#### Scenario: 探测超时

- **WHEN** 目标服务器在 `probeTimeoutMs` 内没有完成握手
- **THEN** 返回 `ok:false` 与超时原因、延迟为实际等待时长，条目与文件不变

### Requirement: HTTP API 与模型工具

插件 SHALL 在宿主注册精确路由 `POST /__dsh-mcp-manager/api`，端点为 `list | add | update | remove | setEnabled | setMatrix | getDefaults | setDefaults | probe | migrate | patchInfo`，统一响应 `{ ok, data }` 或 `{ ok:false, error:{ code, message, fields } }`；请求 MUST 带 `x-dsh-plugin: dsh-mcp-manager` 头且 `Origin` 同源（或缺失），body MUST ≤ 1 MiB。

插件 SHALL 注册 4 个模型工具：`mcp_manager_list`、`mcp_manager_set_enabled`、`mcp_manager_restart`、`mcp_manager_add`，其能力与 HTTP 端点等价。`@deepseek-ai/dsh-tools` 不可用时插件 MUST 跳过工具注册并保持其它功能可用。

#### Scenario: 缺头或缺同源被拒

- **WHEN** 请求没有 `x-dsh-plugin` 头，或 `Origin` 与宿主不同源
- **THEN** 返回拒绝（非 2xx），且不发生任何文件写入

#### Scenario: 工具缺包时降级

- **WHEN** `@deepseek-ai/dsh-tools` 无法解析
- **THEN** 插件不注册模型工具、不抛错，面板与 HTTP 端点仍可用

### Requirement: 单台服务器的工具列表

面板 MUST 为每台服务器提供「工具」入口，展示该服务器的工具清单（工具名 + 一句话描述）。

工具来源 MUST 分两级：默认读取本宿主已注册的工具（`ctx.tools.schemas()` 中公开名以 `mcp__<serverName>__` 开头的条目，零副作用）；静态结果为空时（该服务器未在本 profile 生效、尚未连接成功或未注册任何工具），面板 MUST 说明原因并提供显式的「真探测」动作。

真探测 MUST 只在用户显式触发时执行，MUST 复用「按需探测连接」的超时与错误语义，且面板 MUST 标注它会启动一次 MCP 服务器子进程。

`list` 端点的响应 MUST NOT 触发任何探测或连接（首屏零副作用），这一点不因本需求改变。

#### Scenario: 静态列出已注册工具

- **WHEN** 用户点击某台服务器的「工具」按钮，且该服务器的工具已在本宿主注册
- **THEN** 对话框列出这些工具的名称与描述（描述单行截断、可展开），标注来源为「本机已注册」，且不启动任何子进程

#### Scenario: 静态为空时提示真探测

- **WHEN** 静态结果为空（例如该服务器只在不属于当前宿主的 profile 中生效，或尚未连接成功）
- **THEN** 对话框显示空结果与原因提示，并提供「真探测」按钮，明确标注会启动一次 MCP 服务器子进程

#### Scenario: 真探测返回工具清单

- **WHEN** 用户点击「真探测」
- **THEN** 宿主真实连接该服务器并请求工具列表，对话框列出返回的工具名与描述；失败或超时则就地显示错误文案，面板其它功能不受影响

#### Scenario: 工具名归一化导致的静态漏计

- **WHEN** 某工具的公开名超过阈值被归一化，不再带 `mcp__<serverName>__` 前缀
- **THEN** 该工具不出现在静态清单中，且对话框 MUST 说明静态清单与「工具数估计」列同口径、属估计值

### Requirement: 与既有插件和条目互不干扰

插件的任何操作 MUST NOT 触碰：管理器写入的激活行（`dsh-plugin-manager` 与其它子插件）、`dsh.profile.bundles`、profile `dependencies`，以及不在本插件管理范围内的 MCP 条目。

插件 MUST NOT 让自身 effect 的失败影响宿主启动：路由注册、工具注册、状态文件读写、诊断写入的异常 MUST 被就地捕获并记录。

#### Scenario: 管理操作不改变插件激活状态

- **WHEN** 在面板上完成一轮「新增 / 矩阵切换 / 删除」操作
- **THEN** profile patch 中本插件与其它子插件的激活行、`dsh.profile.bundles` 与 `dependencies` 全部保持不变

#### Scenario: 路由重复注册不拖垮宿主

- **WHEN** 该路由已被注册（例如插件被加载两次）
- **THEN** 第二次注册失败被就地捕获、记录诊断，插件其余功能（含面板）不受影响，宿主启动正常
