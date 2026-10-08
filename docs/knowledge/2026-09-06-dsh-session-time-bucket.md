# DSH 插件：侧栏「按时间桶」分组（dsh-session-time-bucket）

> 日期：2026-09-06　产物：`dsh-session-time-bucket/`（README/ACCEPTANCE 见该目录）

## 目标与定稿（v3：跟随核心视图 + 就地增强）

给 DSH Web 侧栏的会话列表加「按时间桶」分组：今天/昨天/前7天/前30天/更早（按 updatedAt、本地自然日），组标题带数量可折叠并记忆、行标题**恒**带 `[工作区名]` 前缀（未分组 `[未分组]`）。

**最终架构（v3，2026-09-06 定稿）：跟随核心视图 + 对官方渲染列表做外科手术式注入，不再重绘**——插件读取核心持久化视图状态 `dsh.workspace.view.v5`（localStorage 整值 JSON `{groupBy, orderBy, …}`，核心每次变更同步写回），当核心处于 **单列表(flat) + 最近更新(updated)** 时激活，但**核心列表保持原样渲染可见**，插件只注入两类节点：

1. **时间桶组头**（button，官方 projectRow 同款几何：34px、三角在 16×20 slot、gap 6、pad 0 8px）插在每桶首行上方——核心没有时间桶概念，这是唯一自绘元素；
2. **`[工作区]` 前缀 span**（12px tertiary、max-width 40% 截断）插在每个官方标题 span 之前；官方 slot→标题的 4px 间隙从标题 margin 转移到前缀上，标题 margin-left 归零，总几何不变。

行的一切（状态点追逐动画、hover 卡、`…` 行菜单 rename/fork/archive、点行打开、拖拽、相对时间）全部是核心 React 组件原生行为，插件**零复制**。折叠 = 对桶内行设 inline display:none（React 不管理这些行的 style，故不被清掉）。

v1（cf8a5ad）独立入口+整节接管 → v2（4a89eed 起）跟随视图+自绘列表 → v3（本版）就地增强。v2 遗留的 `relativeLabel`/`deriveBuckets` 纯函数保留（harness 固定，渲染器已不用）。

## 可复用结论

1. **核心 ui-workspace 的“分组方式”菜单（ViewOptionsMenu）在真实运行时无法安全注入**：它是 portal + 两阶段定位渲染的 React 菜单；向其中插入/追加行会导致“菜单空/一闪即没”（本仓库多轮实测：jsdom 静态复现正常、真机必现，无 console 报错）。结论：**不要对该菜单做任何 DOM 注入**。
2. **核心视图状态可外部读取，且可靠**：`createWorkspaceViewStore()`（ui-workspace/src/client/stores.ts）`persist: 'dsh.workspace.view.v5'`；`packages/client/store/src/index.ts` 的 `attachPersistence` 把**整值 JSON 同步写 localStorage**（key 即 persist 名，每次变更都写回）。外部插件读该 key 即得 groupBy/orderBy，无需 DOM 推断。
3. **核心“最近更新”顺序 ≠ 严格 recency**：`nextSessionOrderAccount`（WorkspaceBrowser.tsx）是「活动提升 + 持久化账号顺序」——只有 `updatedAt` 比上次记录值增长的会话被提到最前，其余保持历史/手动拖拽顺序；所以旧会话排在新会话前是官方正常现象。插件因此**在桶内自行按 updatedAt 重排官方 wrapper**（React 不校验 DOM 实际顺序、只在其 vdom 顺序变化时搬节点，故重排稳定；dragstart/dragend 期间暂停；退出时按进入前快照还原核心顺序）。另注意：工作区分组树也含 sessionRow 后代——`findFlatTree` 不能有宽松 fallback，且 reconcile 每次要复检 `isFlatUpdatedView()`，否则视图切换瞬间会把组头注入错误的树并引发 MutationObserver 微任务风暴（真机踩坑：切换分组方式时页面主线程卡死）。
4. **React 列表的“注入安全”规律（v3 核心发现，可推广）**：
   - 官方 flat 列表全量渲染（无虚拟化），行 `key=sessionId`；React 调和只看自己的 fiber 记录，**只操作它创建的节点，对插入其间的陌生节点完全透明**——因此在官方行之间插组头、在行内插前缀 span 是安全的；
   - 但 React 重排行时（updated 排序随运行会话持续变化）用 insertBefore 搬自己行，注入节点会留在原地 → 必须用 **MutationObserver（childList+characterData，关闭 attributes 防自触发）** 即时重锚组头；所有写操作先比较后写，保证幂等、不触发观察器死循环；
   - **绝不能搬动官方行本身**（换父级/重排会被 React 按 fiber 拽回）。
5. **行身份匹配（官方 DOM 无 sessionId 可读）**：官方行没有 data-id；按行标题文本逐行与 recency 快照匹配（重复标题按序映射，blank 行标题 = 本地化“新会话”），匹配失败的行跳过不注入。⚠️ **匹配要用「核心实际渲染的文案」，不是快照的 `displayTitle`**：core **0.2.0-rc.2** 起无标题会话渲染本地化「未命名」（`displayTitle(node,t)` = `node.title || t('session.untitled')`，且 `sessionTitle(session)` 只取 `session.title`、**不再回落目录名**），而快照侧 `displayTitleOf(title,cwd,id)` 仍回落工作区目录名 ⇒ 按快照标题匹配的无标题行**永远失配**（症状与修法见篇末 v3.1）。anchor 发现：flat 树 = `[class*=flatList][role="tree"]`（**不要** fallback 到任意含 sessionRow 的 tree——工作区分组树也有，会误注入）；行=`role=treeitem` 且 class 含 `sessionRow`；标题=`[class*=title]`；slot=`[class*=slot]`。
6. 数据通道：`sessions`/`workspaces` 客户端服务可直接 ctx.get/inject；归档是 workspace 快照 `archivedSessionIds`；可见性 = 非 subagent、未归档、blank 仅 current（`sessionVisible`）；打开/重命名/分叉/归档 v3 全走核心行内菜单，插件无需自建（v2 的 `sessions.open/scope/sessionOf` 通道因此删除）。
7. DOM 锚点：核心“视图选项”按钮 aria-label = `视图选项`/`View options`（随 locale）；CSS Modules 子串 class `[class*=headerActions]`/`[class*=sectionHeader]`/`[class*=listArea]`/`[class*=flatList]`/`[class*=searchExpanded]`/`[class*=searchTree]`；无稳定 id/data-*。**真实运行 DOM 的两条实测结论（2026-09-08 无头 Chrome 对 `dsh web` 真机验证）**：① flat 列表 `[class*=flatList][role=tree]` 的直接子节点是 hover-card 锚点 span（`_root_1b2ny_3` 这类纯 hash 类名），`role=treeitem` 的 sessionRow 行在 wrapper 内部——必须用后代查询 `tree.querySelectorAll('[role=treeitem]')` 找行，且组头/折叠锚定到 `row.parentElement`（wrapper），否则 `tree.insertBefore` 会因 anchor 非直接子节点抛错、注入静默失败；② CSSOM 给 style 赋数值会静默丢失（`node.style.fontSize = 12` 无单位被丢弃），内联样式一律写带单位字符串（`'12px'`）。
8. **真实 GUI 诊断工作流（可复用）**：`dsh web` 打印的 URL 带一次性 token；用 curl 带 `-c/-b` cookie jar 即可拿 index.html（含 boot manifest 与各插件 bundle URL `/plugins/??<id>/client.js&rev=...`，改文件后 rev 内容即时更新、无需重启）；装 `puppeteer-core` + 系统 Chrome headless 加载 token URL，等 ~15s 后即可 evaluate 读真实 DOM/localStorage（视图状态 key `dsh.workspace.view.v5` 可先写入再 reload 强制进入 flat+updated）。注意 headless 每次 launch 默认全新临时 profile：折叠态等 localStorage 持久化测试要在同一 browser 实例内 reload 验证。
9. 外部插件 `src/client.js` 是纯 JS 被原样伺服：改后**刷新页面**即可；`pnpm run dev:web` 的 HMR 不管本仓库。
10. 测试形态：`window.__DSH_TEST__` 暴露纯函数（分桶/投影/前缀/行匹配/桶区间规划/相对时间/字典/视图跟随判定），`test/bundle.test.mjs` 用 `new Function` 物化 bundle 断言逻辑，localStorage 用 stub（bundle 内取 localStorage 需经 `getStorage()` 兼容 Node）；DOM 交互留 ACCEPTANCE 手工清单。

## v3.1（2026-10-08）：desktop 0.2.0-rc.2 时间桶标签重复 —— 行匹配抄错了口径

**症状（用户报障，截图）**：侧栏同一时间桶标签出现两次：`今天 1 / 前7天 3 / 前7天 2 / 前30天 5 / 前30天 2`，条目名多为「未命名」。

**根因：核心换了行标题口径，插件还在按旧口径匹配。**

- core 0.2.0-rc.2（`resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-client-ui-workspace\lib\client.js`）`:1121-1123` `function displayTitle(node, t) { return node.blank ? t("session.new") : node.title || t("session.untitled"); }`；`:391-393` `function sessionTitle(session) { return session.blank ? "" : session.title?.trim() ?? ""; }` ⇒ **无标题会话渲染「未命名」**（en `Untitled`，字典 `:3870-3871`），且**不再回落目录名**。
- 快照侧没同步改：`...\@deepseek-ai\dsh-api-session-controller\lib\types\client\sessions\service.js` `:45-54` `displayTitleOf(title, cwd, id)` 仍是 `title ?? workspaceTitleOf(cwd) ?? id`（`:500` 调用、`:508` 只在 `entry.title !== undefined` 时带 `title` 字段）⇒ 插件 `collectRows` 拿到的 `displayTitle` 是**工作区目录名**（如 `dsh-tmp`）。
- 于是 `matchRowTitles`（严格相等 + 顺序贪心 + used 集合）对每个无标题行都返回 `null` ⇒ `allMapped = false` ⇒ 走 **partial-mapping fallback**：`keys[i] = null`，而当时的 `planBuckets` 把 `null` 当**断段**（`if (!key) { cur = null; continue }`），组头 identity = `key + '#' + occ` ⇒ **同一时间桶被失配行切成几段就渲染几个同名组头**。

**修法（两处，都在 `sub-plugins/dsh-session-time-bucket/src/client.js`）**

1. **匹配用核心文案**：`collectRows` 增记 `untitled`（`typeof s.title === 'string' && s.title.trim() !== ''` 取反，blank 恒 false）；新增 `visibleRowTitle(row, blankLabel, untitledLabel)`（blank→新会话 / untitled→未命名 / 否则→标题）；`matchRowTitles(domTitles, rows, blankLabel, untitledLabel)` 改用它；调用点传 `__t('session.untitled')`，zh/en 字典各加一条。
2. **未映射行是 gap、不是边界**：`planBuckets` 改 `if (!key) continue`（原 `cur = null`）⇒ 同一 key 被失配行夹住仍是**一个** run，`count` 只数已映射行；fallback 分支本身不动（occurrence identity 仍能区分真正乱序的两段）。

**验证**

- `node sub-plugins/dsh-session-time-bucket/test/bundle.test.mjs` → **18/18**（新增 3 条：未命名文案匹配、gap 语义、端到端「组头标签不重复」）。
- 红绿：把 `visibleRowTitle` 的 untitled 分支删掉 + `planBuckets` 恢复断段，同一套件 **15/18**，红的正是那 3 条新用例。
- 该 profile（`desktop`）装的是**符号链接**（`C:\Users\chenjunhao04\.dsh\profiles\desktop\node_modules\dsh-plugin-manager` → 本仓库根），所以改完源码**刷新页面**即生效，无需重新安装（git 快照装法才需要 `dsh plugin update`）。

**可复用教训**

- 跨版本适配要对齐「核心**渲染**什么」，不是「快照**给**什么」；凡是用快照字段去对齐 DOM 文本的地方，先确认那里没有第二个回落源（本例：目录名 vs 「未命名」）。
- 防御侧同理：把「认不出的行」当**空隙**而不是**分段边界**，单个未知行最多让某个标签少出现一次，永远不会让同名标签翻倍。
