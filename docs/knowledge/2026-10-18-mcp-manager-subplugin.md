# dsh-mcp-manager：MCP 定义的「落点」为什么必须由矩阵决定（0.2.0-rc.2 实证）

日期：2026-10-18 ｜ 关联变更：`openspec/changes/add-mcp-manager-subplugin/` ｜ 产物：`sub-plugins/dsh-mcp-manager/`

## 一句话

DSH 的 loader 按 **bundle 层 → profile 的 `cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml`（home 层）→ CLI overlay** 顺序应用补丁，且 `{ id, ... }` 形式的覆盖补丁**只能命中当时已存在的条目**；因此「在未选中的 profile 写 `disabled: true` 想关掉 home 层的定义」是**静默失效**的——覆盖行在 home 层 insert 之前被跳过。MCP 管理器的「按 profile 生效」因此不能靠覆盖行，必须**把定义写到能决定生效范围的那一层**。

## 实证方法与三种排列

脚本：`tmp/probe-patch-order.mjs`（直接 `import { applyEntryPatches } from 'file:///D:/ChenSirDocument/GitHub-Projects/deepseek-harness/vendor/include/lib/index.js'`，即启动时同一份实现）。

| 排列 | 输入 | 结果 |
|---|---|---|
| A profile 先 disable、home 后 insert | profile: `[{id:'mcp-demo',disabled:true}]`；home: `[{insert:[{id:'mcp-demo',name:'@deepseek-ai/dsh-mcp-client',config:…}]}]` | `[warn] patch: entry %s not found mcp-demo`，最终条目 **enabled**（覆盖被丢弃） |
| B home 先 insert、profile 后 disable | 顺序相反 | 最终条目 **disabled: true**（覆盖生效） |
| C 同层 insert → override | 同一文件内先 insert 再 `{id,disabled:true}` | **disabled: true**（同层覆盖生效） |

⇒ 落点算法（`planLayout`）的存在理由就是 A：**能写 disable 覆盖的前提是那条 insert 已经先被应用**，而 home 层永远晚于 profile 层。

## 落点算法（矩阵 → 文件）

设某服务器生效的 profile 集合 `S`、磁盘上已知 profile 集合 `P`（`$DSH_HOME/profiles/*`，排除 `node_modules`）：

| 情形 | 定义写在哪 | `disabled` |
|---|---|---|
| `S == P`（且 P 非空） | 只写 home 层一条 | 无 |
| `∅ ≠ S ⊊ P` | 写进每个 `p ∈ S` 的 profile patch | 无 |
| `S == ∅` | home 层保留一条 | 行内 `true` |

- **不允许**同一 id 同时存在于 home 层与任一 profile 层（写入前硬校验，冲突即拒绝且不落盘）。
- 反推矩阵：home 层不带 `disabled` = 全员；出现在部分 profile = 只对那部分；home 层 `disabled: true` = 全不生效。
- profile 目录增删会让既有布局与期望形态脱节 ⇒ 面板标记「布局待修复/待确认」并给建议动作，**不静默改写**。

## 相关核心契约（0.2.0-rc.2）

- **mcp-client 条目**：`name: '@deepseek-ai/dsh-mcp-client'`，一台服务器 = 一条 loader 条目。Config 为 union：`transport` 必填（`'stdio' | 'streamable-http'`）；stdio 需 `command`（`args`/`env`/`cwd` 默认 `[]`/`{}`）；http 需 `url`（`headers` 默认 `{}`）；`serverName` 必填且匹配 `^[A-Za-z0-9_-]{1,32}$`、跨 live 实例唯一；默认 `toolCallTimeoutMs = 60000`、`maxInstructionBytes = 32768`、`failOnStartupError = false`、`reconnect = {enabled,initialDelayMs,maxDelayMs,maxAttempts}`。
- **工具命名**：`mcp__<serverName>__<rawName>`，超长/非法名会被核心归一化 + 哈希 ⇒ 按前缀统计工具数**可能低估**（面板因此标注为「估计」）。
- **无运行期增删/重连 API**：`dsh-mcp-client` 自己处理重连（超过 `maxAttempts` 后日志提示「重载插件或重启宿主」）；条目级启停只能改写 patch 触发配置重应用。
- **HMR**：`packages/boot/hmr/src/index.ts` 同时监视 `profile.patchPath` 与 `join(profile.home, PROFILE_PATCH_FILENAME)`；`watch-config.ts` 用 chokidar（`awaitWriteFinish: true`，监听最近存在的父目录）⇒ **写入即触发热重载**（整树重应用，本仓既往实测 0.7–1.2s），因此原子写（临时文件 + rename）是安全且必需的。
- **官方改 patch 的姿势**：`packages/boot/plugin-manager/src/patch.ts` 用 `parseDocument`（CST，保留注释）+ 自定义 `tag:yaml.org,2002:js` + `writeFileAtomic(..., { mode: 0o600 })`。本插件采用**行级块替换**而不是整树 dump：既保留注释/`!!js`/行序，也不必赌 profile 顶层那份 `js-yaml` 的版本（本仓踩过 5.x 无 `Type` 的坑，见 `2026-10-13-js-yaml-v5-patch-engine.md`）。

## 面板落点

`settings.localPlugins.tab` 由本仓 `dsh-plugin-manager` 的客户端半**自己声明**（`dsh-plugin-manager/src/client.js:263`，测试 `dsh-plugin-manager/test/bundle.test.mjs:359` 断言该子槽），本插件作为子 tab 注册其中。核心自带的「插件」导航行由 `ui-settings-plugins` 独占，插件不能凭空造设置导航行。

## 本机现状（迁移输入）

`$DSH_HOME/cordis.patch.yml`（home 层，1962 B）现有 6 台 MCP：`ida-headless-mcp`、`tarce-ui`(serverName `Trace-UI`)、`mcp-Serena`(行内 `disabled: true`)、`mcp-CodeMap`、`mcp-rea-mcp`(serverName `REA-MCP`)、`mcp-ida-pro-office`(serverName `Hex-Rays-MCP`)。三条 `cordis.patch.yml`（desktop/web/dsh-tui）中 MCP 命中数为 0 ⇒ 现状正是「全员生效 + 一台全局停用」。5 条带旧标记 `# dsh-mcp-manager:server:<id>`（`ida-headless-mcp` 无标记，系手工添加），旧标记由旧项目 `DeepSeekHarness-MCP-Manager` v3.0.0 的写入器产生（其 `src/index.ts:388` 就是同一格式）——该旧项目**未安装在任何 profile**（三个 profile 的 `package.json` 无它的依赖键），因此不存在双写冲突。

## 尚未实测（全部按能力探测实现，失败即降级并写诊断）

1. `ctx.loader.entries()` 在 0.2.1-rc.2 的条目形状（id 是否带 `include:` 前缀、`options.name`/`disabled` 字段名、fiber 状态字段）。
2. `profileContext` 是否提供 `{ profileDir, home }`；`ctx.webServer.register({kind:'exact'})` 在 desktop profile 的可用性；`await import('@deepseek-ai/dsh-tools')` 从子插件位置能否解析出 `defineTool`。
3. 「重写 patch 里同一块内容（字节不变、仅 mtime 变化）是否触发重应用、耗时、MCP 子进程是否真重启」——本机未做实验（不愿在运行中的 profile 上起停全部 MCP）。因此 `mcp_manager_restart` 的语义定为「重写该条目块以触发重应用」，面板文案不承诺「进程已重启」。

## 实现契约（落盘后定稿的部分）

- **写盘**：行级块替换 + 原子写（同目录临时文件 + rename）+ 写前备份 `<文件名>.bak-<yyyyMMdd-HHmmss>`（只留最近 10 份）+ 同文件写操作串行化；除目标行块外逐字不变（含中文注释、`!!js`、CRLF/LF、末尾换行）。
- **标记**：`# dsh-mcp-manager:2:server:<id>` / `# dsh-mcp-manager:2:disable:<id>`；旧 `:server:`/`:disable:`（无版本段）由**显式迁移**升级，编辑操作只动目标行块、不顺手改标记版本。
- **迁移**：`planMigration(text)` → `stats = { relabeled, tagged, converged, skipped }`（本机真实 home patch 实测 `{5, 1, 1, []}`，二次执行零写入）。`converged` 指把同层 `disable` 覆盖行合并成 insert 行内 `disabled: true`——因此**迁移后总行数会合法地减少**，验证保真度必须按「非 MCP 相关行逐字不变（顺序 + 字节）」比对，而不是比总行数（Lead 的 `tmp/verify-mcp-manager.mjs` 起初就踩了这个坑）。
- **静态状态与工具数（能力探测）**：`loader` 可用时按 `options.name === '@deepseek-ai/dsh-mcp-client'` 枚举（跳过 `options.group`，id 剥 `include:` 前缀），`options.disabled === true` → `disabled` 优先，否则探测 fiber 态映射为 `pending|loading|active|failed|unloaded|disabled`，**取不到一律 `null`（界面显示「—」），绝不猜**；`toolCountEstimate` = `tools.schemas()` 里 `mcp__<serverName>__` 前缀计数，`loader`/`tools` 任一不可用即 `null`。`list` 永不探测（不起进程、不联网）。
- **YAML 兜底 = 与表单同一条写盘路径**：面板提交**整段 config 的 YAML**（无 `- insert:` 外壳、无标记）；宿主把它包成 `- insert:` 壳后交给 `host-core` 的 `parsePatch` 结构化解析 → 取 `config` → 与表单路径同一个 `validateMcpConfig` + 同一套块拼贴，测试断言两条路径产出的块**逐字相同**。非法 YAML（含 Tab 缩进 `E_TAB_INDENT`、只有注释的空体）→ HTTP 200 + `{ok:false,error:{code:'bad-yaml',fields}}`，**零写入、零备份**。
- **模型工具**：`mcp_manager_list` / `mcp_manager_set_enabled` / `mcp_manager_restart` / `mcp_manager_add`，仅当 `@deepseek-ai/dsh-tools` 可解析时注册（缺包跳过并写诊断，HTTP 与面板不受影响）。
- **与参考实现的差异（3 条）**：① 上游 `@js2hou/dsh-mcp-manager@0.1.5` 与旧项目 v3.0.0 都只认单个 profile（上游硬编码 `profiles/web`），本插件改成**矩阵 → 落点**；② 两者写盘都会整文件重新 dump（注释全丢），本插件行级块替换；③ 本插件额外有**全局默认参数**（`$DSH_HOME/.dsh-mcp-manager/state.json`）与**旧标记一次性迁移**。

## 交付与验收（2026-10-18）

| 验收 | 命令 | 结果 |
|---|---|---|
| 纯逻辑 | `node sub-plugins/dsh-mcp-manager/test/host-core.test.mjs` | tests 37 / pass 37 / fail 0 |
| 宿主半 | `node sub-plugins/dsh-mcp-manager/test/host-http.test.mjs` | tests 25 / pass 25 / fail 0 |
| 面板 | `node sub-plugins/dsh-mcp-manager/test/bundle.test.mjs` | 34/34 assertions passed |
| 真实 `$DSH_HOME` 只读 | `node tmp/verify-mcp-manager.mjs` | pass 23 / fail 0（6 台解析、矩阵反推、迁移 5+1+1、与 MCP 无关行逐字不变、跨层冲突零写入） |
| 仓库回归 | 管理器 7 支 + `sub-plugins/*/test/*.test.mjs` | 除 `dsh-idle-hook` 两支既有 `spawn EPERM`（沙箱禁起子进程）外全绿 |

**未做真机首跑**：面板与端点只在离线测试里跑过；真实桌面 profile 上第一次使用时，建议先点一次「测试连接」确认探测路径（会起一次 MCP 子进程），并看 `$DSH_HOME/.dsh-mcp-manager/host-diag.json` 的 `httpSkipped` / `applyError` / `loaderMissing` 字段判断宿主能力。
