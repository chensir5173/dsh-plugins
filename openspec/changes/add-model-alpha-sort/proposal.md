# Proposal

## Why

设置 →「模型」里，每个 provider 的模型目录只能**手动拖动**排序（`dsh-client-ui-settings-models/lib/client.js` 的中文串 `reorderModel: '调整模型顺序'`、`reorderModelHelp: '拖动排序，或使用上下方向键调整顺序。'`）。本机 `codemaker` 一个 provider 就有 54 个模型：想选 `gemini-3.8-flash` 得先在一长串里翻找；改名、加模型之后顺序还会散掉。

模型在 composer 选择器和 `/model` 弹窗里的顺序继承同一份目录：`buildModelCatalog`（`dsh-api-session-controller/lib/index.js:473-520`）按 `ctx.llm.listModels(provider.id)` 的返回顺序组装 `groups[].models`，组内不做字母排序（`dsh-client-ui-model-selection/lib/client.js:1112` 的 `orderModelProviders` 只调整 provider 之间的顺序，注释写明 "model order within each group is unchanged"）。因此「按首字母排序」既没有官方开关，也没有现成插件；唯一稳定的写入通道是官方的 `settingsController.mutate`。

## What Changes

- 新增子插件 `sub-plugins/dsh-model-alpha-sort`（宿主半 + 客户端半 + README + ACCEPTANCE + 测试）。按 2026-09-10 起的仓库规则**不声明 `dsh.bundle`、目录内不放置 `cordis.patch.yml`**，激活行由管理器维护。
- 宿主半：读 `settingsController.describe()`，对每个 provider **用户段里已有**的模型数组按显示名重排，再经 `settingsController.mutate(ns, ops, revision)` 写回。只改顺序，不增删模型字段。
- 自动时机：宿主启动时排一次（可配 `sortOnStartup`），外加手动「立即按首字母排序」；**不监听设置变更自动重排**，避免抹掉用户手动拖出来的顺序。
- 客户端半：在设置 →「模型」页底部（`settings.models.footer`，官方 list 扩展位，`replaceRisk: none`）注册一张卡片，显示「可排 provider 数 / 模型数 / 待排序数」，并提供「立即按首字母排序」与「刷新状态」。
- 新端点：`GET /__dsh-model-alpha-sort/status`（只读状态）、`POST /__dsh-model-alpha-sort/sort`（执行一次排序）；两者都要求 `x-dsh-plugin: dsh-model-alpha-sort` 请求头 + 同源。
- 排序规则：`sortBy=name`（显示名，空则回退模型 id）、`direction=asc`、`collation=zh-CN`（数字感知，中文按拼音）。排序稳定：键相同的模型保持原有相对顺序。
- 降级：只读部署（`writable:false`）→ 不写，卡片显示原因；没有 `llm` / `settingsController` → 宿主半静默，端点如实回报；没有 `webServer` → 只保留启动排序，卡片显示「宿主端点不可用」。
- 明确不做：不给 adapter 自动发现、不在配置里的模型（如 `deepseek-official`）排序；不改 provider 之间的顺序；不改默认模型选择（`agent-default-model` 按 id 记录，重排不影响）；不建自绘模型选择器。

## Capabilities

### New Capabilities

- `model-alpha-sort`: 按显示名对每个 provider 的模型目录做稳定、幂等的字母排序——涵盖启动/按钮两种触发、用户段与继承段的取舍、只读与冲突降级、HTTP 契约与设置页卡片。

### Modified Capabilities

（无：本变更不改动 `plugin-manager` / `esc-rewind` / `idle-hook` / `composer-provider-label` 等任何既有需求。）

## Impact

- **新增代码**：`sub-plugins/dsh-model-alpha-sort/`（`package.json`（无 `dsh.bundle`）、`src/index.js` 宿主半、`src/sort.js` 纯逻辑、`src/client.js` 客户端半、`README.md`、`ACCEPTANCE.md`、`test/sort.test.mjs`、`test/bundle.test.mjs`）。
- **安装方式**：由 dsh-plugin-manager 的「本地插件」面板扫描 `sub-plugins/` 后启用（管理器写入 profile 的激活行）；**不改** 仓库根 `package.json`（安装外壳）、**不改** 任何既有激活行。
- **运行时副作用（宿主半，需在 README 显著位置声明）**：会**改写**设置文档里各 provider 命名空间的 `models` 数组顺序（经官方 `settingsController.mutate`，与设置页拖动排序同一条写入通道）；注册 `/__dsh-model-alpha-sort/*` HTTP 前缀路由；宿主启动后约 1.5s 触发一次排序尝试（失败在 5s / 12s 各重试一次）。
- **接缝风险**：`settingsController.mutate` 在「条目未声明 volatile 字段 / 路径不可写 / 版本冲突」时会拒绝；本插件把这些情况如实回报（HTTP 200 + `writes[].ok=false` + `code`），不重试覆盖。继承态（用户段没有 `models`）默认不写，只有显式 `includeInherited` 才把继承清单快照进用户段。
- **依赖**：仅 Node 内建与浏览器内建能力；宿主半**零** `@deepseek-ai/*` import（仓库既有硬规则）。
- **不影响**：`agent-default-model`（按 id 记录，重排不改变默认选择）、provider 之间的顺序、`/model` 弹窗与 composer 的其它行为、设置页拖动排序本身（用户之后仍可手动调整）。
