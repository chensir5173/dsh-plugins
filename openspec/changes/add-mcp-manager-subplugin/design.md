## Context

- 目标机器：Windows（`D:\ChenSirDocument\Dsh-Projects\dsh-plugins`），DSH 桌面版 **0.2.1-rc.2**，核心 `@deepseek-ai/*` 为 **0.2.0-rc.2**（profile `node_modules` 指向检出 `D:\ChenSirDocument\GitHub-Projects\deepseek-harness`）。
- `$DSH_HOME` = `C:\Users\chensir5173\.dsh`，profile 目录：`desktop` / `web` / `dsh-tui`（+ `node_modules` 共享 store）。
- `packages/boot/app-boot/src/profile-context.ts:63-74` 决定补丁分层顺序：**bundle 层 → profile 自己的 `cordis.patch.yml` → `$DSH_HOME/cordis.patch.yml`（home 层）→ CLI overlay**；`packages/boot/hmr/src/index.ts:215` 让 profile patch 与 home patch 都被 chokidar 监视并触发热重载。
- 既有 6 台 MCP 全在 home 层（`mcp-Serena` 另有同层 disable 覆盖行），标记为旧格式 `# dsh-mcp-manager:server:<id>` / `:disable:<id>`；`ida-headless-mcp` 一条无标记。

## 补丁分层语义（实证，2026-10-18）

用核心真实实现（`vendor/include/lib/index.js` 导出的 `applyEntryPatches`，与启动/`dsh --dump-config` 同一代码路径）跑 `tmp/probe-patch-order.mjs`：

| 补丁顺序 | 结果 |
|---|---|
| profile 层 `{id, disabled:true}` → home 层 `{insert:[{id, …}]}`（**核心的真实顺序**） | `[warn] patch: entry mcp-demo not found` → 覆盖被跳过，条目最终**启用** |
| home 层 insert → profile 层 override（反序） | `disabled: true` 生效 |
| 同一层内 insert → override（现状 Serena 的形态） | `disabled: true` 生效 |

结论（本设计的硬约束）：**覆盖面只能在「条目已经存在」之后生效**。对定义在 home 层的条目，profile 层**无法**单独禁用它；`override` 只认同层或更早层已插入的 id。

## Goals / Non-Goals

**Goals**：新版本 DSH（0.2.x 基线，能力探测兼容 0.2.0/0.1.x）下可用的 MCP 管理面板；按 profile 的生效矩阵；全局默认参数；对现有 6 条的一次性迁移；写盘不破坏他人内容；离线可测。

**Non-Goals**：不改核心、不做 skills 管理、不动 `~/.dsh/dsh-mcp.json`、不在实现期修改真实 profile、不与上游标记长期兼容、不自动归档 change。

## Decisions

| # | 决策 | 依据 |
|---|---|---|
| D1 | **按矩阵自动分层**（见下「矩阵落点算法」）：全员生效的服务器只写 home 层一条（全局唯一）；只有部分 profile 生效的，写在**被选中的那些 profile** 的 patch 里；全不生效的，保留 home 层一条并自带 `disabled: true` | 用户选定（混合方案）。这是在上面的分层语义下唯一可行的表达方式：行写在哪一层，就决定了谁能控制它。 |
| D2 | 标记统一为 `# dsh-mcp-manager:2:server:<id>` / `# dsh-mcp-manager:2:disable:<id>`，旧标记一次性迁移 | 用户选定。`2:` 段让「本插件的行」无歧义识别。迁移后不再使用 profile 级 disable 覆盖行（语义已被 D1 取代）。 |
| D3 | 迁移时**形态匹配即纳入**（`name: '@deepseek-ai/dsh-mcp-client'` + `insert` 结构），无标记条目补新标记 | 用户选定。`ida-headless-mcp` 无标记，若只认标记就管不到它。 |
| D4 | 「全局」= 清单 + 默认参数；默认参数存插件自有 `state.json`，不进 patch | 用户选定。patch 只接受 loader 方言，非 loader 键会被核心判非法；默认参数落成具体 config 值后 patch 仍自包含。 |
| D5 | 写盘 = **读用行解析（YAML 可选增强）/ 写用行级块拼贴 + 原子写**，写前备份 | 核心 `boot/plugin-manager/src/patch.ts` 用 `parseDocument` + `writeFileAtomic` 保 CST；上游 `yaml.dump` 整文件重写会丢注释与 `!!js`；旧项目的块级拼贴已验证。 |
| D6 | 面板入口 = 本仓库管理器的「本地插件」设置页 tab（槽位 `settings.localPlugins.tab`） | 用户选定。该槽位由 `dsh-plugin-manager/src/client.js:263,675-680` 自己声明（`settings.section` id `local-plugins` order 16 + `children`），与本仓库其它 6 个子插件同机制。 |
| D7 | 探测分两层：**静态**（loader 条目态 + 工具数）+ **按需 probe**（真起 MCP 客户端，默认 8s 超时） | 用户选定。静态便宜无副作用；probe 会起子进程，必须显式点击、可取消。 |
| D8 | 三种对外面全给：面板 + `POST /__dsh-mcp-manager/api` + 4 个模型工具 | 用户选定。HTTP 走 `ctx.webServer` 精确路由 + 同源/自定义头 CSRF 门；工具经 `ctx.tools.register(defineTool(...))`（`@deepseek-ai/dsh-tools` **惰性 import + 失败降级**）。 |
| D9 | 以旧项目 v3.0.0 为蓝本移植（不改其仓库），上游只作交互参考 | 用户选定。旧项目已适配 0.2.0-rc.2、已有 profile 锚定/矩阵/全局写入/测试网。 |
| D10 | 所有 profile 相关路径从**锚定的 profile 目录**派生，禁止硬编码 `profiles/web` | 上游在桌面版静默失效的根因；本仓库既有教训（`ctx.baseUrl` ≠ profile 目录）。 |
| D11 | 一台服务器的多个副本内容**始终一致**（面板是唯一编辑器，编辑即同步所有副本） | 用户选定。规避「同一个 serverName 在两处参数不一致」的漂移。 |

## 矩阵落点算法（D1 的落地）

输入：服务器的矩阵意图 `S ⊆ 已知 profile 集合 P`。

1. `S == P`（全员，含 `P` 非空）→ 写 home 层一条 insert 行（不带 `disabled`）。**home 层无该行时先插入；已存在则就地更新。**
2. `∅ ≠ S ⊊ P` → 对每个 `p ∈ S`：在 `profiles/<p>/cordis.patch.yml` 写一条 insert 行；并从 home 层与该服务器的其它 profile patch 中删除同名 id 的行。
3. `S == ∅` → 保留 home 层一条并给该行加 `disabled: true`（定义与元数据不丢，面板显示「全局停用」）。

硬校验（写前执行，违反即拒绝并报错）：同一 id 在「home 层」与任一「profile 层」**不得同时存在**；目标 profile 内不得有同 id 的第二条；`serverName` 不得与其它服务器冲突。

漂移检测：`list` 时按当前 `P` 重算期望形态，与实际形态不一致（例如新增了 profile、或用户手工搬动了行）则在面板标记「布局待修复」，由用户点击修复（不静默改文件）。

## 架构

```
sub-plugins/dsh-mcp-manager/
├── package.json          # name/main/exports["./client"]/dsh.client；不声明 dsh.bundle
├── src/host-core.js      # 纯逻辑：行解析、块拼贴、矩阵分层规划、迁移规划、校验、profile 探测、路径派生
├── src/index.js          # cordis 宿主半：inject、effect、HTTP 路由、模型工具、state.json、诊断
├── src/client.js         # 浏览器半：settings.localPlugins.tab 面板（列表/矩阵/表单/迁移/probe/i18n）
├── test/*.test.mjs       # 纯逻辑 + 客户端注册 + 端到端（临时 DSH_HOME）
├── README.md / ACCEPTANCE.md
```

数据面：

| 层 | 文件 | 写什么 | 何时写 |
|---|---|---|---|
| home | `$DSH_HOME/cordis.patch.yml` | 全员生效（或全不生效且带 `disabled: true`）的 `- insert: [{ id, name: '@deepseek-ai/dsh-mcp-client', config }]`，前置 `:2:server:` 标记 | 新增/编辑/删除/矩阵变化 |
| profile | `$DSH_HOME/profiles/<p>/cordis.patch.yml` | 只在部分 profile 生效的服务器：同样的 insert 行 + 标记 | 同上 |
| 插件 | `$DSH_HOME/.dsh-mcp-manager/state.json` | 全局默认参数、面板偏好、迁移元数据、诊断快照 | 改默认参数、迁移、启动诊断 |

定义真源 = patch 行本身（home + 各 profile）；矩阵意图由行的分布反推；`state.json` **不**再存一份定义，避免三方漂移。

## 关键契约

1. **Config 校验**：保存前按 `@deepseek-ai/dsh-mcp-client` 的 Config 校验（`transport` 必填；stdio 需 `command`；http 需 `url`；`serverName` 匹配 `^[A-Za-z0-9_-]{1,32}$` 且跨服务器唯一；`toolCallTimeoutMs` 默认 60000、`maxInstructionBytes` 默认 32768、`failOnStartupError` 默认 false）。
2. **标记即所有权**：只碰带 `:2:` 标记的行块，以及用户显式纳入迁移的形态匹配行块；其它行、注释、空行、`!!js` 表达式逐字不动。
3. **原子写**：同目录临时文件 + `rename`；写前备份 `<file>.bak-<yyyyMMdd-HHmmss>`（保留最近 10 份）；EOL 沿用原文件。
4. **并发**：同一文件的写操作串行化；每次操作先重读文件再定位，不缓存行号。
5. **降级**：YAML/行解析失败 → 面板只读并说明原因；`ctx.webServer` 不可用 → 面板显示「宿主端点不可用」；`@deepseek-ai/dsh-tools` 缺失 → 不注册模型工具；任何 effect 内失败不得冒泡拖垮 `apply()`。
6. **HTTP API**：`POST /__dsh-mcp-manager/api`，端点 `list | add | update | remove | setEnabled | setMatrix | getDefaults | setDefaults | probe | migrate | patchInfo`；要求 `x-dsh-plugin: dsh-mcp-manager` + 同源（或缺失 `Origin`）；body ≤ 1 MiB；响应 `{ ok, data }` / `{ ok:false, error:{ code, message, fields } }`。
7. **模型工具**：`mcp_manager_list`、`mcp_manager_set_enabled`、`mcp_manager_restart`、`mcp_manager_add`（与旧项目同名同义）。
8. **`restart` 语义**：核心没有运行期增删/重连 MCP 的服务（`packages/mcp/mcp-client/src` 无 registry/reload），唯一通道是改 patch 触发热重载 ⇒ `restart` = 重写该条目块（内容等价、mtime 变化）并如实返回「已触发配置重应用」；实际重启效果由 task 0.3 实测后写进 README。
9. **迁移**：旧标记 → `:2:`；形态匹配的无标记条目补标记；把 home 层里 `mcp-Serena` 那种「同层 disable 覆盖行」收敛为该 insert 行自身的 `disabled: true` 并删除覆盖行（语义等价）；幂等；结果报告「改写 / 补齐 / 收敛 / 跳过」。

## 移植映射（旧项目 → 本插件）

| 旧项目（`ChenSir5173/DeepSeekHarness-MCP-Manager`） | 本插件 | 说明 |
|---|---|---|
| `src/index.ts:386-429` `buildInsertBlock` / `buildDisableBlock` | `src/host-core.js` | 块文本生成，标记换 `:2:` |
| `src/index.ts:437-480` `splitKV` / `unquote` / `parseEntry` | `src/host-core.js` | 行级迷你解析，矩阵/迁移只依赖它 |
| `src/index.ts:138-300` profile 锚定与 `pathsFor` | `src/host-core.js` | `profileContext` → `settings.prepareDocument()` → `$DSH_PROFILE_DIR` 兜底 |
| `withWriteLock` / `sandboxPolicy.resolve` | `src/index.js` | 串行化 + 写权限，失败降级只读 |
| `src/index.ts:1260-1330` 4 个 `defineTool` 工具 | `src/index.js` | 惰性 import `@deepseek-ai/dsh-tools` |
| `src/index.ts:1333-1423` `webServer.register` 精确路由 | `src/index.js` | 包在 `ctx.effect` + try/catch，沿用 CSRF 门 |
| `lib/client.js:559-575` `settings.section` 注册 | `src/client.js` | 改为 `settings.localPlugins.tab` |
| `tests/*.test.mjs`（7 支） | `test/*.test.mjs` | 离线网：纯逻辑 + 客户端注册 + 端到端（临时 DSH_HOME、假 web 服务器） |

## Risks / Trade-offs

| 风险 | 缓解 |
|---|---|
| 用户手工搬动行造成布局漂移（行在错误的层） | `list` 重算期望形态 + 面板标记「布局待修复」+ 用户点击修复 |
| profile 集合变化（新增/删除 profile）后语义变化 | 新增 profile 会让「全员生效」仍成立（home 层无需改）；`∅ ⊊ S ⊊ P` 的服务器需要用户确认是否给新 profile 也生效 |
| 同一 serverName 的两个副本同时被加载（若布局漂移没被发现） | 写前硬校验「同 id 不得跨层重复」；面板把冲突显示为错误而不是静默写入 |
| 手工编辑 patch 与面板写入竞争 | 每次操作重读 + 行级定位；写前备份；只替换自己标记的块 |
| 工具名超长退化导致工具数低估 | 工具数标注为「静态估计」，按 `mcp__<serverName>__` 前缀计数，为 0 时显示 `—` |
| 真实 profile 被误改 | 测试只用临时 `DSH_HOME`；跨 profile 写操作二次确认；迁移不自动执行 |

## Migration Plan

1. 面板点「迁移」：home 层 6 条换 `:2:` 标记；`ida-headless-mcp` 补标记；`mcp-Serena` 的 disable 覆盖行收敛为行内 `disabled: true`（当前语义 = 全局禁用，矩阵显示为「全不勾选」）。
2. 用户按需调整矩阵：全员 → 留 home；部分 → 面板自动搬到被选中的 profile。
3. 旧项目仓库保持只读、不再安装。

## Open Questions

- HMR 重载延迟与「重写同内容」是否真的触发重应用（task 0.3 实测）。
- `ctx.loader.entries()` 在 0.2.1-rc.2 的 id 形状（是否带 `include:` 前缀）。
- 桌面版是否总能拿到 `profileContext`（拿不到时用 `settings.prepareDocument()` / `$DSH_PROFILE_DIR` 兜底）。
