# dsh-session-title-regenerate 变更报告：设置页 tab（思考开关 / 推理强度 / 输出上限）

日期：2026-10-08 · 相关：`docs/knowledge/2026-09-06-dsh-session-title-regenerate.md` 末节 · 交付物：宿主 + 客户端插件 + 测试 + 文档

## 1. 触发（用户报障 + 需求）

desktop（0.2.0-rc.2）点「重新生成标题」直接失败，提示（截图两行）：`>- regenerate-title · 重新生成标题失败: title output reached maxTokens`。

用户同时提出需求：给这个插件加一个设置 tab，可以设置**推理强度 / 思考开关 / max_token**，都给默认值，**max_token 默认 512**。

## 2. 根因

标题生成被**输出长度截断**，而插件在截断时直接抛错丢弃文本：

| 环节 | 事实（源码位置） | 后果 |
|---|---|---|
| 映射 | pi-ai 适配器把上游 `finish_reason: length` 映射成 `{ kind: 'max-tokens' }`（`…\@deepseek-ai\dsh-llm-pi-ai\lib\index.js:1422`） | 插件 `src/index.js` 收到该 kind 就抛「title output reached maxTokens」 |
| 预算 | 插件原 `DEFAULTS.maxOutputTokens = 100` | 思考一旦开跑，思考 token 与标题**共享** 100 |
| 路由 | desktop 走 codemaker（openai-responses）⇒ `dsh-llm-pi-ai`；pi-ai **不识别 `purpose`**（全文件 0 命中） | 适配器里 `purpose === 'session-title' ? 'off'`（`dsh-llm-deepseek\lib\index.js:1694`）的「强制关思考」**不生效** |
| 语义 | pi-ai `:1675` `const enabledReasoning = reasoning === 'off' ? void 0 : reasoning`（注释 `:1710-1721` 明说） | 插件发的 `reasoningEffort: 'off'` 被翻成「**省略 reasoning 字段**」⇒ 上游默认开思考时照样思考 |
| 能力面 | DSH llm 层没有独立 thinking 字段（`dsh-llm\lib\index.js:2169-2194` `resolveCallWithInfo`） | 「思考开关」在插件层只能实现为「发 / 不发 `reasoningEffort`」 |

结论：不能再假设「发个 `off` 就不思考」，必须①把默认预算放大、②让使用者能自己开关思考与调档位。

## 3. 修改摘要

| 文件 | 内容 |
|---|---|
| `sub-plugins/dsh-session-title-regenerate/src/index.js` | `DEFAULTS`：`maxOutputTokens` 100 → **512**，新增 `thinking: false` / `reasoningEffort: 'off'`；新增 `clampInt` / `normalizeReasoningEffort` / `resolveReasoningEffort`（思考关 ⇒ 一律 `'off'`）/ `normalizeEntryConfig`（`maxOutputTokens` 夹到 16–8192 等）；命令调用改为 `reasoningEffort: resolveReasoningEffort(config)`；末尾新增手写 `Config`（`CONFIG_SCHEMA_JSON` + `entryConfigSchema()`：`meta.volatile`、精确 `toJSON()`、`~standard = { version: 1, vendor: 'dsh-session-title-regenerate', validate }`）并导出 |
| `sub-plugins/dsh-session-title-regenerate/src/client.js` | 新增常量 `SETTINGS_NS='session-title-regenerate'` / `TAB_SLOT='settings.localPlugins.tab'` / `TAB_ORDER=45` / `ACTIVE_EFFORT_OPTIONS`（四档）；新增 `SettingsSection()`（思考开关 / 档位自绘单选 `low`–`max`（思考关时该栏只显示「当前不思考」说明）/ 上限数字框（失焦夹取）/ 保存 / 填入默认值 / 重新读取 / 状态区「本次调用：…」）与 `settingsFromRow` / `readSettings` / `saveSettings` / `readRemoteSettings` / `unwrapResult` / `clampInt` / `activeEffortOf` / `sameSettings` / `effectiveSummary`；`apply()` 注册 tab；新增 zh/en 文案 |
| `sub-plugins/dsh-session-title-regenerate/test/bundle.test.mjs` | 新增 6 条用例（宿主 3：`Config` 默认投影 / 思考开关决定档位且预算夹取 / entry config 驱动调用参数；客户端 3：tab 注册 / 设置行归一与夹取 / 控制器走 `get()`）；假客户端补 `remote.settings` 抛错访问器与 `settings` 参数；25 → 31 条 |
| `sub-plugins/dsh-session-title-regenerate/README.md`、`ACCEPTANCE.md` | README 改简介/工作原理/新增「设置页」小节（含默认值表与手写 schema 说明）/配置示例补 `thinking`、`reasoningEffort`、`maxOutputTokens: 512`；ACCEPTANCE 断言数改 31（宿主 19 + 客户端 12）、4.6 条改默认预算口径、新增第 10 节「设置页 tab」9 条验收（含 [H] 归一与夹取） |
| `docs/plugins.md`（本插件行与小节） | 表格行改「用当前模型…设置页可调（默认关思考、512）」；「配置」一条重写为两层（设置页 / profile 行） |
| `docs/knowledge/2026-09-06-dsh-session-title-regenerate.md`、`docs/knowledge/README.md` | 篇末新增 2026-10-08 小节（根因链、settings 契约、手写 schema、`refs[uid]` 坑、离线探针法、验证）；索引追加一行 |
| `package.json`、`dsh-plugin-manager/package.json` | 版本同步 patch+1：0.3.5 → **0.3.6**（AGENTS.md 硬规则，由 `root-install-shell.test.mjs` 的版本一致护栏守住） |；UI 复核后再次 patch+1 → **0.3.7**
| `sub-plugins/dsh-session-title-regenerate/package.json` | 版本 0.1.2 → **0.1.3** → UI 复核后 **0.1.4**；description 重写（默认关思考 + 512 预算、设置页 tab 与命名空间、档位 = 打开思考后的四档自绘单选） |

### 3.1 UI 复核（同日补充，插件 v0.1.4）

用户看完首版面板后问「这个 ui 你看看设置合理吗」，复核出 5 个真问题并全部修掉：

| 问题 | 为什么算问题 | 改法 |
|---|---|---|
| 「思考开关 + 档位 `off`」双控件语义重叠 | 勾上开关后档位仍是默认的 `off`，实际下发等同关闭；且 `off` 档与开关表达同一件事 | `off` 从档位表移除（`ACTIVE_EFFORT_OPTIONS` 只留四档）；打开开关时把 `off` 抬成 `low` |
| 原生 `select` 的展开项发灰像禁用 | `select` 用了 `background: transparent` / `color: inherit`，`option` 由 UA 渲染、拿不到主题色 | 改为自绘 `input[type=radio]`（`STY.choice`），不再依赖 UA 弹层 |
| 数字框逐字符夹取 | `onChange` 里直接 `clampInt`：打不出中间态、清空立刻弹回旧值 | `onChange` 只存原串，`onBlur` / 保存时再夹取 |
| 没有「未保存」态 | 保存按钮 `disabled: locked || !draft` 恒可点；「恢复默认值」只改内存，易被当成已生效 | 新增 `baseline` state + `sameSettings()` 计算 `dirty`，状态区显示「● 有未保存的改动。」／「当前值与已保存的一致。」 |
| 没有「本次实际会发什么」的回显 | 三项互相牵连（关思考时档位无意义、思考与标题共享同一个 token 预算），用户看不出组合结果 | 状态区追加 `effectiveSummary(value)`：「本次调用：不下发 reasoningEffort · maxTokens 512」 |

文案同步：「恢复默认值」→「填入默认值」（说明它只改面板、需再点「保存」才写回）；英文侧同步同名键值。
## 4. 验证证据

| 项 | 结果 |
|---|---|
| `node sub-plugins/dsh-session-title-regenerate/test/bundle.test.mjs` | **31/31 通过**（宿主 19 + 客户端 12；新增 6 条用例全绿；UI 复核后在既有客户端用例内追加 13 条纯函数断言 + 4 条渲染树断言，用例总数不变） |
| 红绿（UI 复核）：把 `activeEffortOf` 的 `return` 改成直接 `return effort`、把 `const effortField = value.thinking === true` 改成 `= true` | **30/31**，唯一红的正是 `client: settings helpers normalize the describe() row and clamp writes`（新增纯函数与渲染树断言） |
| 版本（UI 复核后 patch+1） | 插件 **0.1.4**、根与 `dsh-plugin-manager` **0.3.7**；`node dsh-plugin-manager/test/root-install-shell.test.mjs` PASS（含版本一致护栏） |
| 红绿：512→100、去掉 `resolveReasoningEffort` 的思考判断、`settingsFromRow` 不夹取、tab 注册包进 `if (false)` | **25/31**，红的正是新增的 5 条 + 既有 `host: success`（其 `maxTokens` 断言 512） |
| `node dsh-plugin-manager/test/root-install-shell.test.mjs` | 全绿（含「shell and inner package carry the SAME version」护栏） |
| `node --check`（host + client） | 语法通过 |
| 生效方式 | profile `desktop` 的 `node_modules` 是**符号链接**指向本仓库 ⇒ 改客户端刷新页面即生效；宿主半随 entry 重载即时生效 |

## 5. 边界与遗留

- **思考开关不是真的「关闭模型思考」**，而是「不下发 `reasoningEffort`」：DSH llm 层没有 thinking 字段，上游若在缺省时默认思考，仍可能产生思考 token——所以默认预算才必须放大到 512；真要彻底关思考需要适配器层配合（deepseek 适配器有此优惠，pi-ai 路线没有）。
- `provider` / `model` **故意不进设置 schema**（仍由 profile 行 `config:` 提供）：进 schema 会让设置页出现两个「必须成对」的自由文本字段，校验复杂度不划算。
- 设置页值落在 profile 行 `config:`（entry restart 语义），不是热更新的内存态；宿主半重载期间正在跑的标题生成不受影响（下一次生成读新值）。
- 仍需人工按 `ACCEPTANCE.md` 第 10 节在真机逐条验收（GUI 无法自动化）：档位是否真的传到提供方、语言/主题、以及「settings 服务缺失时 tab 不白屏」。
- `maxOutputTokens: 100` 的旧配置**不会被自动迁移**：设置页回显靠 schema 默认值填充，老 profile 行若显式写了 100 会继续用 100，需在面板里改一次或删掉该键。
- UI 复核后仍遗留：面板只能回显**插件下发的参数**，「档位是否真的被提供方采纳」取决于上游（`off` 在 pi-ai 路由下仍是「省略 reasoning 字段」）；「未保存」判定用 `sameSettings()`（`''` 视同 `16`、`'512'` 视同 `512`），因此把 512 改成 `512`（字符串）不会提示改动。
