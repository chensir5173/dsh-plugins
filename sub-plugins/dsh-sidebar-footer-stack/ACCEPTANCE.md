# dsh-sidebar-footer-stack — 验收

把 DSH 侧边栏左下角（`sidebar.footer.action` 槽位，`kind: "list"`）里注册的多个插件条目，从**核心默认的横向并排**改成**竖向逐行堆叠**，且不依赖任何皮肤。

做法：宿主半监听核心 web 服务的 `webserver/index-inject` 事件，往页面 `<head>` 注入一条样式 —— 让 `.…_footerActions` 竖排、**让它的包装层也竖排**、让每个条目占满整宽；并用「双 `:not(:has())`」在真的只有一个条目时回退横向、用 `[class*="_collapsed"]` 祖先类在收起轨里逐像素还原核心布局。

**不改核心、不改皮肤、不接管插件自身样式**：核心 `@deepseek-ai/dsh-client-ui-sidebar` 的 `.…_footerActions{display:flex}` 没有 `flex-direction`，默认 `row` 才是横排的根因；皮肤只改 `--dsw-alias-*` 颜色变量，与本问题无关。

客户端半零 UI，只提供诊断句柄 `window.__dshSidebarFooterStack`（`snapshot()` / `report()` / `itemsOf()`）。

## 行为

| 情况 | 表现 |
| --- | --- |
| 展开侧边栏 + 两个及以上 footer 条目 | 每个条目独占一行、撑满侧边栏宽度（264px）；标签不再被截断成 `Re...`；第二个条目的左边缘不再越过侧边栏右边界（v0.1.0 曾溢出到 x272） |
| 展开侧边栏 + 只有一个 footer 条目 | 保持核心横向布局（双 `:not(:has())` 护栏），不做无意义的竖排 |
| 收起侧边栏（rail） | `[class*="_collapsed"]` 三条规则（特异性 (0,3,0)，排在最后）把 `footerActions` 还原成 `width:auto` 居中横排 → 逐像素等于核心原样 |
| `stackSingle: true` | 连单条目也竖排（显式关掉护栏 1） |
| `enabled: false` | 宿主半不注册监听、不注入任何样式，footer 回到核心横排 |
| 用量卡片（`@kenz1117/dsh-ui-usage-billing`） | 竖排后宽度从 199px 变成 264px，**离开**它自己的 `@container (width<=210px)` 降级区间，恢复玻璃底 + 边框 + 仪表 + spark 柱 |
| 用量卡片浮层 | 浮层是 `createPortal(…, document.body)` + `position:fixed`，按 `triggerWrap` 的 `getBoundingClientRect().left/top` 定位；本插件让 triggerWrap 回到侧边栏内（x8），浮层随之对齐到侧边栏左缘 |
| `sidebar.settings` 槽位（如 `@linxin666/dsh-usage`） | 不受影响（它本来就在 footArea 里单独占一行） |
| 切换皮肤（furina ↔ 其它） | 仍是竖排 —— 规则只依赖类名后缀与 `_collapsed`，与 `--dsw-alias-*` 无关 |
| Web（`dsh web`） | **首次启用后重启一次 `dsh web`** 才生效（新 entry 只在 boot 时加载）；之后改 config 刷新页面即可（index 注入每次请求重新收集） |
| 桌面版（DSH Desktop） | **重启 DSH Desktop** 才生效（桌面 host 只在 app ready 收集一次注入；改 config 同样要重启） |
| 浏览器不支持 `:has()` | 只丢掉「单条目回退横向」那几条规则，仍然竖排，功能不受损 |
| 上游类名后缀变化 | 规则不命中；`report()` 返回 `hasFooterActions:false` 并给出提示（见已知限制） |

## 设计约束与取舍

- **必须穿透包装层**：`kind:"list"` 的槽位只渲染一个 wrapper，插件条目在 wrapper 内部。判据（单条回退）与样式（竖排）都必须穿透到条目层，否则会同时出现「竖排失效」和「第二个条目溢出侧边栏」——v0.1.0 的真实事故，已在 `test/host.test.mjs` 里用 REGRESSION A / B 两条断言钉住。
- **用后缀匹配而不是 hash 类名**：核心类名是 CSS module 生成的 `hHd-Xa_footerActions`，hash 前缀随 DSH 版本变、DOM 上也没有 `data-*` 锚点，所以选择器写成 `[class*="_footArea"]` / `[class*="_footerActions"]`，只依赖稳定的模块名后缀。
- **不用容器查询**（v0.1.0 曾用 `container-type:inline-size` + `@container (min-width:120px)`）：容器查询会给 footArea 引入 `contain: layout` 的副作用；一旦没有元素匹配容器，整块 @container 规则失效且诊断上看不出原因。收起态改用稳定后缀的祖先类 `[class*="_collapsed"]` 判断，并靠特异性 + 文件末尾顺序双保险。
- **不碰插件自己的样式**：只做 `flex-direction` / `width` 级别的容器规则；用量卡片内部的 `@container` 规则由它自己响应宽度变化，插件不替它决定形态。
- **样式只由宿主半注入一次**：客户端半只做只读诊断，绝不注入第二份 CSS（否则 `<head>` 会出现两条一模一样的规则，且无法判断哪条生效）。
- **注入去重**：同一张注入表只 push 一次（Web 端每个请求一张新表；桌面端只 collect 一次）。
- **诊断不打扰页面**：`snapshot()` / `report()` / `apply()` 全部 `try/catch` 兜底，畸形 DOM（抛错的 `querySelector`）下也返回「未生效」而不是把页面带崩。
- **不新增设置页**：配置项只有 3 个、改动频率极低，写激活行的 `config:` 即可，省掉一个 client 面板与 `Config` 契约。
- 遵守 2026-09-10 规则：子插件**不声明 `dsh.bundle`**、目录内**不放** `cordis.patch.yml`、宿主半不 import 宿主内部包。

## 安装 / 启停

由仓库的**本地插件管理器**统一安装与启停，**不要**单独 `dsh plugin add`：

1. 设置 →「本地插件」（或管理器面板）→ 打开 `dsh-sidebar-footer-stack`；
2. **重启一次 `dsh web`**（新 entry 只在 boot 时读取 `cordis.patch.yml`）；桌面版重启 DSH Desktop。之后再改 `config` 时 Web 只需刷新页面；
3. 侧边栏左下角应变成两行；控制台跑 `window.__dshSidebarFooterStack.report()` 看结论。

停用：在同一面板关掉它，或在 `cordis.patch.yml` 那条激活行加 `disabled: true`（管理器写的是同一个字段）；同样要**重启一次 `dsh web`** 才会真正卸载该 entry，重启后 footer 回到核心横排。

## 验收清单

### 1. 自动化（离线可跑，无需浏览器/服务器）

运行方式（本机沙箱下 `spawn` 被禁，用临时文件 + 动态 import 的 harness）：

```js
// 复制测试到同目录临时名，把 process.exit( 换成 globalThis.__exitCode = (，再 import
await import('file:///…/test/__run_host.test.mjs.' + Date.now() + '.mjs')
```

- [x] 1.1 `[A]` 模块契约：导出 `name` / `inject`（空数组）/ `apply`，无需注入任何服务 —— `test/host.test.mjs`
- [x] 1.2 `[A]` 默认 CSS 结构：marker 在首行、末尾有换行、槽位层 `flex-direction:column` + `align-items:stretch` + `gap:4px` + `width:100%`，且**不含** `@container` / `container-type` —— `test/host.test.mjs`
- [x] 1.3 `[A]` **REGRESSION A**：包装层也被竖排 —— 断言 `_footerActions"] > *{flex:0 0 auto !important;display:flex !important;flex-direction:column !important;align-items:stretch !important` 与条目层 `> * > *{flex:0 0 auto !important;width:100% !important;min-width:0 !important` 同时存在 —— `test/host.test.mjs`
- [x] 1.4 `[A]` **REGRESSION B**：单条判据穿透包装层 —— 断言存在双条件 `:not(:has(> * + *)):not(:has(> * > * + *))`，且其行是 `flex-direction:row !important;align-items:center !important` —— `test/host.test.mjs`
- [x] 1.5 `[A]` 规则顺序：column 规则在 row 回退之前；collapsed 三条必须是文件最后三条 —— `test/host.test.mjs`
- [x] 1.6 `[A]` `stackSingle:true` 去掉单条回退、但保留 collapsed 护栏；`enabled:false` 产出空串 —— `test/host.test.mjs`
- [x] 1.7 `[A]` 配置夹取：`gap` → 0–24、字符串数字被转换、非对象配置与坏类型回落默认、`enabled` 只有 `false` 才关 —— `test/host.test.mjs`
- [x] 1.8 `[A]` `minWidth` 已移除：旧键被忽略（`normalizeEntryConfig` 结果里没有该键，也不改变输出），`clampInt` 边界与回落 —— `test/host.test.mjs`
- [x] 1.9 `[A]` 注入：`apply()` 注册 `webserver/index-inject`、同一张表只 push 一次、两张独立表各 push 一次、敌意表（`push` 抛错 / 非数组）不炸、`enabled:false` 不注册监听、返回 disposer —— `test/host.test.mjs`
- [x] 1.10 `[A]` `apply()` 从激活行 `config` 读取 `gap` / `stackSingle` 并反映到产出 CSS —— `test/host.test.mjs`
- [x] 1.11 `[A]` 包契约：`package.json` 同时声明宿主半与客户端半、**不声明 `dsh.bundle`**、client bundle 用包 id 注册且含宿主半的 marker —— `test/host.test.mjs`
- [x] 1.12 `[A]` 客户端注册：bundle 经 `window.__ModuleLoader__.load` 注册、factory 返回 `{apply, inject:[]}`、`apply()` 挂出 `window.__dshSidebarFooterStack`（含 `marker` / `styleId` / `snapshot` / `report` / `itemsOf` / `styleEl`） —— `test/bundle.test.mjs`
- [x] 1.13 `[A]` 诊断判定：无样式 → `installed:false` + 一条 `console.warn`；两条目 + `column` → `ok:true` 且 count/width 正确；只有 id 缺失时靠 marker 扫描仍能命中 —— `test/bundle.test.mjs`
- [x] 1.14 `[A]` **条目计数穿透包装层**：`footerActions > wrapper > 3 entries` 报 `count:3`（wrapper 不算作 1 条）；`wrapper` 里只有 1 条时报 `count:1 / single:true` —— `test/bundle.test.mjs`
- [x] 1.15 `[A]` 单条目 → `single:true`、`ok:true`、不告警；注入但两条目仍 `row` → `ok:false` 且 note 含条目数与宽度；无 footArea → `hasFooterActions:false` —— `test/bundle.test.mjs`
- [x] 1.16 `[A]` 健壮性：无 `getComputedStyle` 时降级为 `flexDirection:null`；抛错的 DOM 访问器不抛；`footerActions` 无子元素不抛；连 `document` 都不存在时仍能注册并给出 `ok:false` —— `test/bundle.test.mjs`

当前结果：**host 26/26 通过，bundle 14/14 通过**。

### 2. 真机（需要真实 DSH Web / 桌面 + 浏览器）

- [ ] 2.1 `[B]` 启用并重启 `dsh web` 后刷新页面：`window.__dshSidebarFooterStack.report()` 返回 `ok:true`、`installed:true`、`stacked:true`、`count:2`
- [ ] 2.2 `[B]` 几何：`footerActions` 的 `getComputedStyle().flexDirection === "column"`；两个条目 `width ≈ 264`、`x ≈ 8`（不再出现 x≈272）、第二个条目的 `y` 大于第一个
- [ ] 2.3 `[B]` 视觉：远程桥（Remote）与用量卡片各占一行；Remote 标签完整（不再显示 `Re...`）
- [ ] 2.4 `[B]` 视觉：用量卡片宽度约 264px，恢复玻璃底 + 边框 + 仪表 + spark 柱（不再是无边框的 `@container (width<=210px)` 降级形态）
- [ ] 2.5 `[B]` 浮层：点开用量卡片，浮层左缘与侧边栏左缘对齐（`left ≈ triggerWrap.left ≈ 8`），不被裁到侧边栏外
- [ ] 2.6 `[B]` 收起侧边栏：footer 回到核心的居中横向布局，`snapshot().hasFootArea` 仍为 true、`stacked:false`
- [ ] 2.7 `[B]` 只启用一个 footer 插件：footer 保持横向，`report()` 显示 `single:true` 且 `ok:true`
- [ ] 2.8 `[B]` `sidebar.settings` 条目（`@linxin666/dsh-usage` 若启用）位置与外观不变
- [ ] 2.9 `[B]` 切换皮肤（如 furina ↔ 其它）后仍是竖排 —— 证明与皮肤无关
- [ ] 2.10 `[B]` 停用插件 + 重启 `dsh web`：竖排消失、footer 回到横排
- [ ] 2.11 `[B]` 桌面版（DSH Desktop）：重启后同样竖排（验证 app-ready 注入路径）

> `[A]` = 离线自动化断言；`[B]` = 真实浏览器/桌面观察项，无法用无头逻辑 harness 覆盖（CSS 级联、包装层的真实 DOM、插件自身的 `@container` 降级区间）。
