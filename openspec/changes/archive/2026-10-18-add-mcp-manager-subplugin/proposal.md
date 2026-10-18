## Why

MCP 服务器在这台机器上是「有定义、无管理」的状态：

- 6 台服务器（`ida-headless-mcp` / `tarce-ui` / `mcp-Serena` / `mcp-CodeMap` / `mcp-rea-mcp` / `mcp-ida-pro-office`）全部定义在 **DSH home 的 `$DSH_HOME/cordis.patch.yml`**，靠 `# dsh-mcp-manager:server:<id>` 注释标记 + 手工编辑维护；没有面板、没有 profile 归属视图、没有连接状态、没有探测。
- 参考实现 `@js2hou/dsh-mcp-manager@0.1.5` 在 0.2.x 上是**静默失效**的：它的 patch 路径**硬编码 `$DSH_HOME/profiles/web/cordis.patch.yml`**（桌面版用的是 `desktop` profile，写进去不会生效，也不会报错）；枚举依赖 `ctx.loader.entries()` 的 id 前缀约定；工具数按 `mcp__<serverName>__` 前缀统计，而超长工具名会退化成 `整理名_<hash>` 前缀（漏计）；`dsh.client.inject` 里还挂着 0.2.0 已删除的 `@deepseek-ai/dsh-client-runtime`。
- 更关键的是**它的写盘算法**：`readPatchList` + `yaml.dump` **整文件重写**，注释、行序、`!!js` 表达式一律丢失——而 DSH 自己的 `boot/plugin-manager` 用的是 `yaml.parseDocument` + `writeFileAtomic`（保注释、保 CST）。整文件重写会破坏 `$DSH_HOME/cordis.patch.yml` 里别人的注释与 `!!js` 守卫行。

本机另有一份自研实现 `@xxxyz/dsh-mcp-manager` v3.0.0（`D:\ChenSirDocument\GitHub-Projects\ChenSir5173\DeepSeekHarness-MCP-Manager`，71 提交，已适配 DSH 0.2.0-rc.2）：它已经有 profile 目标矩阵、全局层写入、YAML 块级拼贴（保注释）、写锁、7 支 `node:test`，但**不在本仓库**、且它自己的 `~/.dsh/cordis.patch.yml` 产物没有 UI 可复用。

用户要求：**在本仓库以子插件形式**写一个自己的 MCP 管理器，支持新版本 DSH，并补上上游没有的两件事——**按 profile 的场景开关**与**全局 MCP 设置**。

## What Changes

- **新增子插件 `sub-plugins/dsh-mcp-manager/`**（包名 `dsh-mcp-manager`，不声明 `dsh.bundle`、目录内无 `cordis.patch.yml`），宿主半 `src/index.js` + 纯逻辑 `src/host-core.js` + 浏览器半 `src/client.js`，面板落在 core「本地插件」设置页的 tab 槽位 `settings.localPlugins.tab`（与本仓库其它子插件一致）。
- **三层数据面**（本变更的核心模型）：
  1. **全局层 = MCP 定义的唯一真源**：`$DSH_HOME/cordis.patch.yml`，每条服务器一行 `- insert: [{ id, name: '@deepseek-ai/dsh-mcp-client', config }]`，行前带新标记 `# dsh-mcp-manager:2:server:<id>`。
  2. **profile 层 = 只写覆盖**：对**未勾选**该服务器的 profile 写 `- id: <id> / name: '@deepseek-ai/dsh-mcp-client' / disabled: true`（标记 `# dsh-mcp-manager:2:disable:<id>`）；勾选则删除该覆盖行。profile 列表由 `$DSH_HOME/profiles/*` 自动探测。
  3. **插件自有状态**：`$DSH_HOME/.dsh-mcp-manager/state.json` 存**全局默认参数**（新建服务器时的字段默认值：`toolCallTimeoutMs` / `failOnStartupError` / `maxInstructionBytes` / 探测超时等）、面板偏好与迁移元数据；**绝不写进任何 patch 文件**（patch 只接受 loader 方言）。
- **写盘算法（相对上游的改进）**：不整文件 dump —— 读用 YAML 解析（`js-yaml` 双族能力探测，4.x/5.x 都能用，且不覆盖 profile 里那份传递依赖），写用**行级块拼贴 + 原子写**（临时文件 + rename），逐字保留他人注释、`!!js` 表达式、行序与 CRLF；解析失败即只读降级并拒绝写入。写前自动备份（`<file>.bak-<ts>`）。
- **功能面**：列表（含来源层与生效 profile）、新增/编辑/删除/启停、**生效矩阵**（MCP × profile 复选）、**全局默认参数**、静态状态（loader 条目态 + 工具数）+ **按需探测**（真起进程 / MCP 握手，限时 8s、可取消、失败不阻塞面板）、表单全字段（stdio/http，transport、serverName、command/args/env/cwd、url/headers、超时与失败策略、`maxInstructionBytes`）+ 原始 YAML 兜底编辑（保存前必须通过 `@deepseek-ai/dsh-mcp-client` 的 Config 校验）、**一次性迁移**（旧标记 `# dsh-mcp-manager:server:<id>` / `:disable:<id>`，以及**无标记但形态匹配**的条目，统一换成新标记）。
- **三种对外面（用户明确要求全给）**：设置面板 tab、本地 HTTP 端点（`POST /__dsh-mcp-manager/api`，带同源 + 自定义头 CSRF 门、body 上限）、以及 4 个模型工具（`mcp_manager_list` / `mcp_manager_set_enabled` / `mcp_manager_restart` / `mcp_manager_add`，经 `ctx.tools.register` + `defineTool`）。
- **迁移旧实现的产物**：`~/.dsh/cordis.patch.yml` 现有的 6 条（其中 `ida-headless-mcp` 无标记）在面板上一键迁移到新标记并纳入矩阵管理；旧项目 `DeepSeekHarness-MCP-Manager` 保持只读、不再安装使用（文档注明来源与差异）。

## Capabilities

### Added Capabilities

- `mcp-manager`：新能力规格，覆盖三层数据面、生效矩阵、全局默认参数、标记与迁移、写盘安全（保注释/原子写/备份/只读降级）、面板与状态、探测、HTTP API 与模型工具、以及与既有条目的互不干扰。

### Modified Capabilities

- 无。不修改 `plugin-manager` 的任何既有 Requirement：新插件的激活行仍由管理器写、仍遵守「子插件不声明 `dsh.bundle`」红线，tab 注册沿用 core 槽位 `settings.localPlugins.tab`（与本仓库其它 6 个子插件同一机制）。

## Non-goals

- **不改 DSH 核心**：不动 `dsh-mcp-client`、不动 `boot/hmr` 的 patch 监视与重载、不动 `dsh plugin` 的 reconcile。
- **不做 skills 管理**：旧项目 3.0.0 已删除该特性，不回搬。
- **不动 `~/.dsh/dsh-mcp.json`**（另一套空的 MCP 存储，`{"version":1,"servers":[]}`）：不迁移、不删除、不读它。
- **不在开发期改动任何真实 profile**：测试一律用临时 `DSH_HOME`；对本机 6 台服务器的迁移只是**面板上可点的一个动作**，不在实现期自动执行。
- **不追求与上游 js2hou 的产物/标记兼容**：旧标记只做一次性迁移，之后只认新标记。
- **不自动归档本 change**：实现完成、`openspec validate` 通过后停下等用户确认。

## 成功判据

1. `sub-plugins/dsh-mcp-manager/test/` 下的测试全绿（离线、临时 `DSH_HOME`、不起服务、不碰真实 profile）：纯逻辑（解析/拼贴/矩阵规划/迁移规划/校验）、客户端注册（manifest + patch + tab 槽位 + fetch 桩）、端到端（真 handler + 假 web 服务器 + 临时 home：加/改/删/启停/矩阵/迁移各写一次且只改预期行）。
2. 保真性可验证：对含注释、`!!js` 表达式、CRLF 的样本 patch 做「加/改/矩阵/删/迁移」后，非目标行**逐字不变**（测试里做行级 diff 断言），且解析失败时拒绝写入。
3. 仓库既有测试无回归：管理器 7 支 + 其它子插件测试（既有 3 处已知失败除外：`dsh-idle-hook` 的 spawn EPERM、`dsh-open-session-workdir/test/interception.test.mjs` 依赖已退役的第三方 bundle）。
4. `openspec validate add-mcp-manager-subplugin --strict` 通过。
5. 交付面齐全：`README.md`、`ACCEPTANCE.md`、`test/bundle.test.mjs`、`docs/plugins.md` 用法索引新增一行、`docs/knowledge/` 新增一篇并在索引登记、仓库根 `package.json` 与 `dsh-plugin-manager/package.json` 的 `version` 同步 patch 递增。
