## Purpose

让每个 provider 的模型目录按**显示名**稳定地字母排序：设置 →「模型」的列表、composer 的模型选择器、`/model` 弹窗共用同一份顺序。排序由官方设置写入通道落盘，可在启动时自动执行，也可由设置页底部卡片手动触发；继承态、只读部署与并发冲突都如实降级。

## ADDED Requirements

### Requirement: 启动时自动排序

宿主半 SHOULD 在插件加载后延迟执行一次排序，默认启用；规则为：

- 只处理「用户段里已有 `models` 数组」且元素数 ≥ 2 的 provider；
- 已按当前规则有序时 MUST NOT 产生写入；
- 首次尝试失败（服务未就绪）时 MAY 在后续延迟点重试，成功一次后不再重试。

#### Scenario: 启动时把乱序目录排好

- **WHEN** 宿主启动、`sortOnStartup` 为 true，某 provider 用户段里的 `models` 为乱序数组
- **THEN** 插件在该命名空间写入一次，`models` 变为按显示名升序，元素内容（除顺序外）完全不变

#### Scenario: 已有序不写

- **WHEN** 用户段里的 `models` 已经按当前规则有序
- **THEN** 不调用 `mutate`，状态接口报告该 provider「已按当前规则有序」

#### Scenario: 关闭自动排序

- **WHEN** 配置 `sortOnStartup` 为 false
- **THEN** 插件加载后不安排任何启动排序定时器，只有手动端点/按钮会触发排序

### Requirement: 手动一键排序

插件 MUST 提供 `POST /__dsh-model-alpha-sort/sort`，执行一次与启动排序相同的逻辑并返回结构化结果；MUST 提供 `GET /__dsh-model-alpha-sort/status` 返回只读计划（可写性、每个 provider 的状态与待排数）。

#### Scenario: 按钮触发排序

- **WHEN** 客户端以 `POST /__dsh-model-alpha-sort/sort` 调用（带 `x-dsh-plugin: dsh-model-alpha-sort` 头、同源）且设置文档可写
- **THEN** 返回 `{ ok: true, changed: <写入的 provider 数>, writes: [...] }`，设置页列表按新顺序渲染

#### Scenario: 状态查询不写入

- **WHEN** 客户端 `GET /__dsh-model-alpha-sort/status`
- **THEN** 返回每个 provider 的 `state`（`user` / `inherited` / `absent` / `namespace-absent`）、`count`、`pending`、`moved`，且不产生任何写入

#### Scenario: 方法或头不符

- **WHEN** 以 GET 调 `/sort`、或缺 `x-dsh-plugin` 头、或 Origin 与 Host 不同源
- **THEN** 分别返回 405 / 403 / 403，且不产生任何写入

### Requirement: 只排用户段、继承态需显式开启

插件 MUST 默认只重排 `namespaceView.user` 里存在的 `models` 数组；当该数组缺失（继承 adapter 默认清单）时 MUST NOT 写入，除非配置 `includeInherited` 为 true。

#### Scenario: 继承态默认不动

- **WHEN** 某 provider 的用户段没有 `models`，只有生效值（继承清单）
- **THEN** 该 provider 状态为 `inherited`，排序与按钮都不产生写入

#### Scenario: 显式开启继承态排序

- **WHEN** 配置 `includeInherited` 为 true，且继承清单乱序
- **THEN** 插件把排序后的继承清单写入用户段，后续目录顺序为新顺序

### Requirement: 排序规则

插件 MUST 默认按显示名（`name`，空白则回退 `id`）升序排列，并使用 locale 感知、数字感知的字符串比较；MUST 提供 `sortBy`（`name` / `id`）、`direction`（`asc` / `desc`）、`collation`（默认 `zh-CN`）三项配置；排序 MUST 稳定（键相同者保持原有相对顺序）。

#### Scenario: 显示名升序

- **WHEN** 用户段模型为 `[GPT 6 Astra, Claude Haiku 5.5, Qwen 3.8 Flash]`
- **THEN** 排序结果为 `[Claude Haiku 5.5, GPT 6 Astra, Qwen 3.8 Flash]`

#### Scenario: 数字感知

- **WHEN** 显示名为 `gpt-2` 与 `gpt-10`
- **THEN** `gpt-2` 排在 `gpt-10` 之前

#### Scenario: 中文按拼音

- **WHEN** 显示名为「波」与「阿」（`collation: 'zh-CN'`）
- **THEN**「阿」排在「波」之前

### Requirement: 只读与冲突降级

当设置文档只读（`writable: false`）时插件 MUST NOT 写入，并如实返回原因为 `read-only`；当某命名空间写入以 `settings/conflict` 失败时 MUST 返回该命名空间失败信息，MUST NOT 重试覆盖，且其它命名空间照常处理。

#### Scenario: 只读部署

- **WHEN** `describe()` 返回 `writable: false`
- **THEN** `sort` 返回 `{ ok: true, changed: 0, skipped: 'read-only' }`，`mutate` 未被调用

#### Scenario: 并发冲突

- **WHEN** `mutate` 因 revision 变化抛出 `settings/conflict`
- **THEN** 该命名空间在 `writes` 中为 `{ ok: false, code: 'settings/conflict' }`，其它命名空间仍被处理

### Requirement: 设置页卡片

客户端半 MUST 在 `settings.models.footer` 注册一张卡片，显示可排 provider 数、模型总数与待排序数，提供「立即按首字母排序」与「刷新状态」；卡片 MUST NOT 自行刷新页面，也 MUST NOT 直接调用设置写入 API。

#### Scenario: 卡片出现在模型页底部

- **WHEN** 用户打开设置 →「模型」
- **THEN** 页面底部出现「模型排序」卡片，显示统计与两个按钮

#### Scenario: 宿主半缺席时降级

- **WHEN** 宿主端点不可用（无 `webServer` 或插件未加载宿主半）
- **THEN** 卡片显示「宿主端点不可用」而不是抛错，页面其它部分不受影响
