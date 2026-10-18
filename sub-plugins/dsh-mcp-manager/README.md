# dsh-mcp-manager

在 **设置 → 本地插件** 里管理 DSH 的 MCP 服务器：定义只写一处、按 profile 决定生效范围、支持全局默认参数、按需真实探测、以及把历史遗留条目一键迁移到本插件名下。

- 面板入口：设置 → 本地插件 → **MCP 服务器**（tab id `mcp-servers`、order 30；槽位 `settings.localPlugins.tab` 由 `dsh-plugin-manager` 提供）
- 宿主端点：`POST /__dsh-mcp-manager/api`（需 `x-dsh-plugin: dsh-mcp-manager` 头 + 同源）
- 模型工具：`mcp_manager_list` / `mcp_manager_set_enabled` / `mcp_manager_restart` / `mcp_manager_add`
- 插件自有状态：`$DSH_HOME/.dsh-mcp-manager/state.json`（全局默认参数、已知 profile 集合、迁移元数据）；宿主诊断：`$DSH_HOME/.dsh-mcp-manager/host-diag.json`

## 定义写在哪：矩阵自动分层

DSH 的 loader 按 **bundle 层 → profile 自己的 `cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml`（home 层）→ CLI overlay** 的顺序应用补丁，并且 `{ id, ... }` 形式的覆盖补丁**只能命中当时已存在的条目**（命中不了就告警跳过）。实测证据与脚本见 `docs/knowledge/` 与 `tmp/probe-patch-order.mjs`。因此「在未选中的 profile 写 `disabled: true` 覆盖行」是**无效**的 —— 覆盖会在 home 层的 insert 之前被跳过。

本插件据此把「一台服务器的定义」写到**能决定它生效范围的那一层**：

| 生效的 profile 集合 | 定义写在哪 | 面板含义 |
|---|---|---|
| 全部 profile | `$DSH_HOME/cordis.patch.yml` 一条（不带 `disabled`） | 全员生效 |
| 部分 profile | 每个被选中的 `$DSH_HOME/profiles/<p>/cordis.patch.yml` 各一条 | 只在选中的 profile 生效 |
| 一个都没有 | `$DSH_HOME/cordis.patch.yml` 一条，行内 `disabled: true` | 全局停用（定义与参数保留） |

写盘规则：同一 id **不允许**同时出现在 home 层与某个 profile 层（写入前硬校验，冲突即拒绝）；某台服务器的多个副本内容**始终一致**（面板是唯一编辑器，编辑即同步所有副本）。

## 面板能力

- **列表**：id、`serverName`、transport、落点层、生效 profile、静态状态（未加载/加载中/已激活/失败/已停用；宿主能力缺失时显示「—」）、工具数估计（同样可为「—」）、布局漂移标记。
- **新增 / 编辑 / 删除 / 启停**：全字段表单（`transport`、`serverName`、`command`/`args`/`env`/`cwd`、`url`/`headers`、`toolCallTimeoutMs`、`failOnStartupError`、`maxInstructionBytes`）+ **YAML 兜底提交**（填整段 config 的 YAML，不含 `- insert:` 外壳与标记；宿主先结构化校验，通过后与表单走同一条写盘路径，失败返回 `bad-yaml` + 逐字段原因且零写入）；保存前一律按 `@deepseek-ai/dsh-mcp-client` 的 Config 校验。
- **矩阵**：每台服务器 × 每个 profile 的复选；变更会按上表重排文件（跨 profile 写入前二次确认）。
- **全局默认参数**：新建表单的默认值（`toolCallTimeoutMs`、`failOnStartupError`、`maxInstructionBytes`、`probeTimeoutMs`、`defaultTransport`）。它们**不写进 patch** —— 保存时会落成该条目 `config` 内的具体值。
- **测试连接**（按需，会起子进程）：按 config 真起一次 MCP 客户端，默认 8 秒超时，返回延迟与工具数；任何结果都会关闭客户端。
- **迁移**：把旧标记 `# dsh-mcp-manager:server:<id>` / `:disable:<id>` 改写成 `# dsh-mcp-manager:2:server:<id>`；把形态匹配（`insert` + `name: '@deepseek-ai/dsh-mcp-client'`）但没有标记的条目补上标记；把同层 disable 覆盖行收敛为该 insert 行自身的 `disabled: true`。幂等，执行前自动备份。

## 写盘安全

- 行级块拼贴（**不做整文件 YAML 重写**）：别人的注释、`!!js` 表达式、行序、行尾风格（CRLF/LF）逐字保留。
- 原子写：同目录临时文件 + `rename`；写前备份 `<文件名>.bak-<yyyyMMdd-HHmmss>`（同目录保留最近 10 份）。
- 每次操作先重读文件、重新定位行块；同一文件的写操作串行化。
- 文件无法解析时**只读降级**：面板说明原因，所有写端点拒绝且不产生备份。

## 已知行为与限制

- **热生效范围**：改 patch 会触发 DSH 的配置热重载（核心同时监视 profile patch 与 home patch）。面板文案不会承诺「进程已重启」——`restart` 的实际语义是「重写该条目块以触发重应用」，真实重启延迟未在本机实测。
- **探测有副作用**：会按配置启动一次 MCP 服务器进程。默认不在列表加载时探测。
- **工具数是静态估计**：按 `mcp__<serverName>__` 前缀统计；超长工具名会被核心归一化+哈希，可能低估。为 0 时显示 `—`。
- **布局漂移**：profile 目录增删、或有人手工搬动行，会让落点与矩阵意图不一致；面板标记「布局待修复/待确认」，由你点击修复，插件不会静默改文件。
- **不做 skills 管理**、不读写 `$DSH_HOME/dsh-mcp.json`。

## 安装 / 卸载

- 安装：在管理器的「本地插件」面板里启用本子插件（激活行由管理器写在 profile 的 `cordis.patch.yml`）。**不要**用 `dsh plugin add` / `remove` 装卸子插件（会留下悬空激活行）。
- 卸载：先在面板里把 MCP 条目按需迁移/删除，再在管理器面板停用本插件。
- 回滚：patch 文件的每次写入都有 `.bak-<时间戳>` 备份；恢复即把备份覆盖回原文件。

## 与上游 / 旧实现的关系

- 交互参考 `@js2hou/dsh-mcp-manager@0.1.5`（面板分区、探测、双语文案），但**不沿用**它的写盘方式（`yaml.dump` 整文件重写会丢注释与 `!!js`）与路径（硬编码 `profiles/web`，在桌面版静默失效）。
- 宿主逻辑移植自本机旧项目 `@xxxyz/dsh-mcp-manager` v3.0.0（`DeepSeekHarness-MCP-Manager` 仓库），本项目落地后旧项目保持只读、不再安装使用。

## 开发与测试

```bash
node sub-plugins/dsh-mcp-manager/test/host-core.test.mjs   # 纯逻辑：解析/拼贴/落点/迁移/校验
node sub-plugins/dsh-mcp-manager/test/host-http.test.mjs   # 宿主半：HTTP + 写盘 + 降级（临时 DSH_HOME）
node sub-plugins/dsh-mcp-manager/test/bundle.test.mjs      # 浏览器半：manifest + 槽位注册 + 渲染
```

全部离线、用临时 `DSH_HOME`、不起真实服务、不碰正在运行的 profile。验收清单见 `ACCEPTANCE.md`。
