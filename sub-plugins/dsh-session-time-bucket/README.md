# dsh-session-time-bucket

给 DSH Web GUI **侧栏会话列表**的“单列表 + 最近更新”视图加时间桶分组：今天 / 昨天 / 前7天 / 前30天 / 更早（按会话**最近更新时间**、本地自然日分桶），行标题恒带所属工作区前缀。

采用**跟随核心视图 + 就地增强**的架构：插件读取核心持久化的视图状态（localStorage `dsh.workspace.view.v5`），当核心处于 **单列表(flat) + 最近更新(updated)** 时，在核心自己渲染的列表上**增量注入**两组节点——时间桶组头 + 行内工作区前缀——**不重绘、不替换任何官方元素**：

- 会话行保持核心原生渲染：状态点（进行中蓝色追逐/已完成绿点）、悬停提示卡、行尾 `…` 操作菜单（重命名/分叉/归档）、点行打开、拖拽排序——全部是核心自己的 React 组件与 CSS，插件完全不复制。
- 只在两处做注入：① 每桶首行上方插一个组头（官方项目行同款 34px/三角 slot/gap 6）；② 每行官方标题 span 前插一个 `[工作区]` 前缀 span。
- React 安全性：核心按 fiber 记录调和子节点，只操作它自己创建的节点；注入节点对 React 透明，行顺序变化时插件用 MutationObserver 即时重锚组头。

纯客户端插件。不注册宿主端点、不新增模型工具；数据来自核心 `sessions` / `workspaces` 两个客户端服务（仅用于分桶、工作区名与行身份匹配——不做任何渲染）。

## 行为

| 情况 | 表现 |
| --- | --- |
| 核心处于 单列表+最近更新 | 自动激活：核心列表**保持原样渲染**，仅在其行间/行内注入组头与工作区前缀 |
| 时间桶组头 | 出现在每桶首行上方：今天/昨天/前7天/前30天/更早（**空桶不出现**）；chevron（▾/▸）+ 数量；点击折叠（隐藏该桶全部行）/展开，折叠态持久化 |
| 桶内顺序 | **严格按最近更新，最新在前**。核心“最近更新”本身是活动提升+持久化账号顺序（只提升 updatedAt 增长的会话、手动拖拽会被钉住），会出现旧会话排在新会话前面；插件把官方行按 桶序+updatedAt 重排，退出时还原核心顺序 |
| 新建会话 | 核心“+新会话”会**复用工作区里仍为空白（从未发过消息）的旧会话**并保留其旧 updatedAt——若不处理，跨天后该行会滑进 昨天/前7天。插件把**当前正在编辑的空白新会话**（blank && current，列表里唯一可见的空白行）按“现在”分桶：始终落在 今天 且桶内最新；一旦发消息 updatedAt 变真实时间，自然留在 今天 |
| 会话行 | 核心原生行：状态点、悬停提示卡、`…` 菜单、拖拽、打开全部为核心行为；插件只加 `[工作区名]`/`[未分组]` 前缀（12px tertiary，贴标题前） |
| 行身份匹配 | 渲染顺序 == 核心 recency 顺序，按**核心实际渲染的文案**逐行匹配：空白新会话 = 本地化「新会话」、**无标题会话 = 本地化「未命名」**（core 0.2.0-rc.2 起）、其余 = 会话标题（重复文案按序映射）；匹配失败的行不注入、保持原样 |
| 点某一行 | 核心原生 `onOpen`（插件不接管） |
| 切回 按工作区 / 手动排序 | 自动退出：移除全部注入节点，核心列表原样保留 |
| 进入搜索 | 自动退出（搜索树接管列表区域），退出搜索后若仍在 单列表+最近更新 则自动恢复 |
| 窄栏（rail） | 不激活 |
| 刷新 | 折叠态记住；核心视图状态由核心自己持久化，恢复后自动跟随 |

## 设计约束与取舍

- **不重绘、不复制官方行**：行的一切交互与样式（状态点、hover 卡、行菜单、拖拽）由核心 React 组件原生提供；插件注入的只有组头与 4px 宽的文本前缀，官方视觉格式天然一致，无“适配漂移”。
- **React 调和安全性**：React 用 key 调和 `list` 子节点、只读写它自己 fiber 里记录的节点；插入其间的组头对 diff 不可见。核心按更新顺序重排行时，MutationObserver（childList/characterData，关闭 attributes 防自触发）即时重锚组头；所有写操作先比较后写，保证幂等不死循环。**真实 DOM 中每行外层包着一个 hover-card 锚点 span（如 `_root_1b2ny_3`），行不是树的直接子节点**——行探测用 `[role=treeitem]` 后代查询，组头/折叠锚定到该 wrapper 上（已用无头 Chrome 对真实 GUI 验证）。
- **行重排是安全的**：React 只在它自己的 vdom 顺序变化时才搬动节点，从不校验 DOM 实际顺序——插件把官方 wrapper 按 桶序+updatedAt 重排后布局稳定；核心自身发生移动（提升/拖拽）时 MutationObserver 在微任务里立即恢复桶序（绘制前完成，无闪烁）。行拖拽进行中（dragstart→dragend）暂停重排，避免干扰拖放。
- **行匹配用核心的文案，不是快照的 `displayTitle`**：core 0.2.0-rc.2 对**无标题会话**渲染本地化「未命名」（`displayTitle(node,t): node.title || t('session.untitled')`），而会话快照的 `displayTitle` 仍回落工作区目录名——两者不一致时该行永远匹配不上、注入缺失。插件按「blank→新会话 / 无 title→未命名 / 否则→标题」取候选文案，并把**未映射行当作 gap 而不是边界**：同一时间桶不会因为一行读不到标题就裂成两个同名组头。
- **视图状态读取不靠 DOM**：核心把 `{groupBy, orderBy, …}` 整值 JSON 同步持久化到 `dsh.workspace.view.v5`，插件 1s 观察器读它判定激活；搜索态/rail 由 DOM 特征判断。
- **退出零残留**：exit 时删除组头、删除前缀 span、还原标题 margin、展开全部折叠行；React 列表不受影响。
- 列表数据不爬 DOM：会话元数据由 sessions/workspaces 服务快照推导；任何异常 try/catch 兜底。
- 无 React：纯 DOM + `--dsw-*` 令牌；文案跟随 locale（zh/en）。

## 安装 / 启停

本插件由仓库的**本地插件管理器**（`dsh-plugin-manager`）统一安装与启停，**不要**单独用 `dsh plugin add` 装它：

1. 只装管理器一次（仓库根就是它的安装外壳，两种入口等价）：
   ```bash
   dsh plugin --profile web add git+https://github.com/Chen5173/dsh-plugins.git
   # 或 dsh plugin --profile web add <本机仓库根>   # 本机开发：改代码即时生效
   ```
2. 重启 `dsh web`，打开设置 →「本地插件」。
3. 在面板里打开本插件的主开关：管理器自动把本包以 `link:<本插件目录>` 写进 profile `devDependencies`（按需跑 `pnpm install`），并写入激活行 `- insert: [{ id: session-time-bucket, name: 'dsh-session-time-bucket' }]`。profile patch 被 DSH **实时热重载**，宿主侧即时生效；本插件带界面，**刷新页面**后界面才进引导图。

- **停用**：面板里关掉主开关（行内写 `disabled: true`；行与依赖都保留，可随时再开）。
- **卸载**：面板里点「移除」（删激活行 + 摘 devDependency；**仓库里的源码目录保留**，可随时再启用）。

### ⚠️ 不要用 `dsh plugin add` 装/卸本子插件

- **装**：本子插件包不声明 `dsh.bundle`，`dsh plugin --profile web add <本子插件目录或包名>` 只会把它装成 profile 的普通依赖并打印 `declares no dsh.bundle — installed as a plain dependency, not a profile layer`，**不会激活它**。激活一律走管理器面板。
- **卸**：`dsh plugin --profile web remove <本子插件包名>` 只摘依赖、**不会删除管理器写的激活行**——残留的悬空行会让下次 `dsh web` 启动直接失败（`failed to import loader entry <id> (<name>): Cannot find package …`）。卸载请用面板「移除」。

**开发形态**：外部 client bundle 原样伺服，改 `src/client.js` 后**刷新页面**即可（`pnpm run dev:web` 时走 HMR）。

## 开发 / 验证

```bash
node sub-plugins/dsh-session-time-bucket/test/bundle.test.mjs   # 逻辑 harness（18 条）
node --check sub-plugins/dsh-session-time-bucket/src/client.js
```

浏览器手测见 `ACCEPTANCE.md`。
