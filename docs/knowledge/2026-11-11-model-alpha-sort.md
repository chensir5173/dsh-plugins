# dsh-model-alpha-sort — 模型目录按首字母排序（2026-11-11）

## 一句话

模型在设置页 / composer / `/model` 里看到的顺序，就是各 provider **配置数组 `models` 的顺序**；用官方 `settingsController.mutate` 重写这个数组，三处同时变成字母序，不需要 DOM 注入或猴补丁。

## 顺序链（源码实证）

```
buildModelCatalog (dsh-api-session-controller/lib/index.js:473)
  → ctx.llm.listProviders()
  → ctx.llm.listModels(provider.id)          # 每个 provider
  → ctx.llm.resolveModelInfo(provider.id, id)
  → groups[].models = 按 listModels 原序
pi-ai：resolveRouteModels → configured = request.models ?? [] → 逐条 push
      → listModels 原序返回（dsh-llm-pi-ai/lib/index.js:657/1927）
客户端 ModelSelect：groups = orderModelProviders(catalog) → 组内不再排序
```

⇒ 想改顺序只有两条路：改配置数组（持久、三处同序），或在客户端重排（脆弱、只影响显示）。

## 写设置的官方通道

- 服务：`ctx.get('settingsController')`（`SettingsController`）。
- 读：`describe()` → `{ writable, hasDocument, namespaces }`；每个 namespace 有 `user`（用户覆盖段）、`base`（继承段）、`value`（生效值）、`revision`。
- 写：`mutate(ns, ops, expectedRevision)`，`ops = [{ op: 'set', path: [...provider.settingsPath, 'models'], value }]`。
- 可写性由三件事决定：条目必须是可配置插件条目、必须有 volatile 字段、**被触碰路径必须 volatile**。pi-ai 的 `providers` 整字典是 `.volatile()`，所以 `providers.<id>.models` 可写。
- provider → ns/path 的映射不猜：`llm.listConfigurableProviders()` 返回 `{ provider, displayName, settingsNs, settingsPath }`。
- `expectedRevision` 必须带：撞车抛 `SettingsConflictError`，客户端包成 `details.code = 'settings/conflict'`——**重试前先重读**，别用旧 revision 硬写。

## 只排「用户段」的取舍

`describe()` 同时给了 `user` 与 `value`：只有 `user` 段里**已经存在** models 数组的 provider 才是「用户拥有这份清单」。默认只排它；继承清单（`base`/`value` 有、`user` 没有）默认跳过，否则第一次运行就会把上游默认清单固化成用户覆盖，之后上游更新再也进不来。需要时用 `includeInherited` 显式打开。

## 0.2.0 插件形态要点

- 宿主半零 `@deepseek-ai/*` import；能力全部经 `ctx.get` / `ctx.inject`。
- 配置随条目投影：命名空间 = **条目 id**（`dsh-model-alpha-sort`）；`apply(ctx, config)` 第二参就是归一化后的值。
- `Config` 手写：`meta.volatile` + `type` + `toJSON()`（schemastery refs 形态）+ `['~standard'].validate`；`vendor` **不写** `schemastery`，否则配置写入会走 volatile in-place 路径、条目不重启，`apply` 看不到新值。

## 客户端卡片

- 槽位 `settings.models.footer`（list、root 域、replaceRisk none、registration `{id, order, label}`），渲染在 provider 行与「添加模型」之后，**ownerProps 故意为空**，只能拿 standardProps。
- 卡片不直连 `remote.settings`：写路径只在宿主半，客户端经 `GET /__dsh-model-alpha-sort/status` 与 `POST /sort` 触发，避免两套写入实现。
- 端点门禁抄 mcp-manager：`x-dsh-plugin` 头 + 同源（`Origin` 缺席放行，`new URL(origin).host === headers.host`）。

## 踩坑

1. **幂等断言要按「对象身份」比位置**：`movedCount` 算的是元素是否换了位置，3 个元素反序通常只有 2 个位置变化（中间那个没动）。写测试时别按「长度 - 相同下标数」期望。
2. **源码审计先剥注释**：断言「宿主半无 `@deepseek-ai/` import」时，注释里的示例会误伤；`stripComments` 要保护 `http://`（`[^:]`）。
3. **React 测试树里 children 常是嵌套数组**：`findButton` 先判 `Array.isArray` 再递归，否则找不到按钮。
4. **`webServer` 缺席的降级状态要在 apply 里就写好**：只靠晚挂的 `ctx.inject(['webServer'])` 回调，状态会一直停在 `reason: null`，与「如实降级」不符。
5. **不监听 `settings/document-updated`**：监听就必然要重排，否则用户手动拖拽会被立刻改回去——排序只在启动与点按钮时发生。
