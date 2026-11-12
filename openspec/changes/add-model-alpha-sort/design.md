# Design

## Context

- **顺序链路**：`buildModelCatalog`（`dsh-api-session-controller/lib/index.js:473-520`）用 `ctx.llm.listProviders()` + 每个 provider 的 `ctx.llm.listModels(provider.id)` 组装 `groups[].models`，**组内顺序 = listModels 顺序**；空组被过滤，失败隔离成 `failures`。
- **pi-ai 的 models 数组就是顺序来源**：`dsh-llm-pi-ai/lib/index.js:661` `const configured = request.models ?? []`，逐条保序推入（`:714-725`）；`listModels`（`:1927-1943`）按原序映射成目录项。因此重排已落盘的 `models` 数组即重排目录。
- **设置页的模型行存在用户段**：`draftAt(schema, namespace, path)` = `schema.getPath(namespace.user, path)`（`dsh-client-ui-settings-models/lib/client.js:1935-1939`），写回用路径 op（`:1950-1966`），提交走 `ctx.remote.settings.mutate(ns, ops, expectedRevision)`（`:3308`）。
- **官方写入通道**：`SettingsController.mutate(ns, ops, expectedRevision)`（`dsh-api-settings-controller/lib/types/index.d.ts:78`）→ `settings.write`（`dsh-settings/lib/types/index.js:336-347`）：条目必须可配置、必须有 volatile 字段、每条被触碰路径必须可写；revision 不符抛 `SettingsConflictError` → RemoteError details `{ code: 'settings/conflict' }`。
- **pi-ai 的 Config 可写**：`z.object({ providers: z.dict(profile).default({}).volatile() })`（`dsh-llm-pi-ai/lib/index.js:1086`）⇒ `providers.<id>.models` 是 volatile 路径。
- **官方扩展位**：设置 →「模型」页底部有 list 槽 `settings.models.footer`（purpose: "Ordered extension area after the provider rows and the add controls."，`replaceRisk: none`），外部插件可安全注册卡片；ownerProps 故意为空，卡片只能拿 standardProps 并自取数据。
- **客户端不直连 `remote.settings`**：写语义集中在宿主半一处，客户端只调 HTTP，避免两套实现与两套错误处理。

## Goals / Non-Goals

**Goals**

- 不改核心源码，让设置页列表、composer 选择器、`/model` 弹窗三处顺序一致地按显示名排列。
- 幂等：已经有序时零写入；重复触发不产生 revision 抖动。
- 只读部署、继承态、并发冲突都如实降级，不猜、不覆盖。

**Non-Goals**

- 不排 adapter 自动发现、不在配置里的模型（如 `deepseek-official`）。
- 不改 provider 之间的顺序（那是 `orderModelProviders` 的职责）、不改默认模型。
- 不做自绘模型选择器、不做每次设置变更后的自动重排。

## Decisions

### D1 用官方 `settingsController.mutate` 写，不用 DOM 注入 / 猴补丁

**决定**：宿主半读 `describe()`、按命名空间分组调 `mutate()`，把排序后的 `models` 数组写回。
**理由**：这是设置页拖动排序走的同一条通道，写入后设置页与选择器天然同序；客户端 Service 目录里没有公开的 `modelDirectories`，DOM 重排只改一处显示且脆弱。
**备选**：① 客户端 DOM 重排菜单项（脆弱、只改显示）；② 包装 `remote.session.modelCatalog`（设置页仍乱）；③ 改 `buildModelCatalog`（模块私有函数，不是扩展点）。

### D2 默认只排用户段里已有的数组

**决定**：`namespaceView.user` 下存在 `...models` 数组才排；只有 `value`（继承/生效值）时默认跳过，`includeInherited=true` 才写。
**理由**：继承态是 adapter 的默认清单，整份写进用户段会让后续 adapter 升级失效，也扩大写入面。
**备选**：无条件排生效值——会把默认清单固化，回退成本高。

### D3 启动 + 按钮，不监听设置变更

**决定**：`apply` 时按 `sortOnStartup` 延迟排序（1.5s / 5s / 12s 三次尝试，成功一次后不再试）；其余由卡片按钮触发。
**理由**：启动一次能保证常态有序；不监听 `settings/document-updated` 就不会把用户刚拖出来的顺序立刻改回去（官方拖动排序与"自动保持有序"直接冲突）。
**备选**：每次变更后自动重排——会与手动拖动打架。

### D4 幂等：写入前先判序

**决定**：`isSorted()` 为真就不产生 op；一次 `mutate` 只带该命名空间里真正需要改的 provider。
**理由**：启动排序与按钮重复执行应当零写入；也避免无意义的 revision 变更触发条目重启。
**备选**：无条件写——每次启动都改 revision，触发无关重载。

### D5 排序键：显示名优先，空则回退 id；locale 感知

**决定**：`sortBy=name` 取 `model.name?.trim() || model.id`；比较用 `Intl.Collator(collation, { numeric: true, sensitivity: 'base' })`；`direction` 可反序；`id` 用作稳定性 tie-break。
**理由**：用户看到的是显示名；数字感知让 `gpt-4` / `gpt-10` 符合直觉；`zh-CN` 让中文按拼音；`sensitivity: 'base'` 让大小写不干扰。
**备选**：裸 `localeCompare`（数字序不符合直觉）、按 id 排（与界面显示不一致）。

### D6 客户端卡片 + 宿主端点，写路径只有一条

**决定**：卡片注册在 `settings.models.footer`，只调 `GET /status` 与 `POST /sort`；端点要求 `x-dsh-plugin` 头 + 同源。
**理由**：与仓库其它面板（mcp-manager）一致的安全惯例；客户端不需要 `remote.settings` 注入，逻辑与测试都集中在宿主半。
**备选**：客户端直连 `remote.settings.mutate`——两套实现、两套错误处理。

## Risks / Trade-offs

- `describe()` 只列「活跃且可配置」的条目；若某个 provider 的 adapter 没有注册可配置条目，就看不到它，卡片显示「设置文档里没有这个命名空间」——如实展示，不猜。
- 设置文档被别处同时修改时，`mutate` 以 `settings/conflict` 拒绝；本插件不重试覆盖，卡片提示再点一次（避免把并发编辑写丢）。
- 启动排序发生在插件加载后 1.5s，若此时 provider 尚未注册（慢 adapter），会在 5s / 12s 重试；仍失败则留给按钮。
- 中文排序随宿主 Node 的 ICU 版本；极端生僻字可能与直觉不同。
- 排 `models` 数组会让宿主把该命名空间的配置写回（条目可能重启一次）；这是官方写入通道的固有行为，只在真正需要重排时发生（D4）。
