# dsh-terminal-font — 验收

把本机已装的 Nerd 字体接进 DSH 侧边栏终端的字体栈，修掉 oh-my-posh / Starship 提示符的私用区字形豆腐块。

做法：宿主半监听 `webserver/index-inject`，向页面 `<head>` 注入两段 `@font-face`（`local()` 引用本机字体 + `size-adjust` 把 advance 精确归一到核心 xterm 现有单元格宽度 `13px × 1126/2048 = 7.1474609375px`）与一条 `.xterm-rows / .composition-view` 字体栈规则。

**不接管 xterm**：不改字号、不改行高、不改任何 xterm 选项、不做 DOM 注入；字体缺失时 @font-face 失效并回退 Consolas，终端行为与未启用插件时逐像素一致。

纯客户端插件 + 空壳宿主半（`@deepseek-ai/dsh-client-modules` 只扫 ENABLED 条目的 `dsh.client` 包，所以宿主半必须存在、可以为空）。

## 行为

| 情况 | 表现 |
| --- | --- |
| 字体已装 + 样式已注入 | 侧边栏终端里 Powerline / 分支 / 锁等私用区字形正常显示；列宽、竖线、光标与装插件前一致 |
| 字体未装 | @font-face 解析失败 → 回退 Consolas，终端观感与未启用插件一致（诊断卡显示 missing） |
| `enabled: false` | 宿主半不注册监听、不注入任何样式 |
| Web（`dsh web`） | 刷新页面即生效（索引注入每次请求重新收集） |
| 桌面版（DSH Desktop） | **重启 DSH Desktop** 才生效（桌面 host 只在 app ready 收集一次注入） |
| 终端未打开 | 诊断卡显示「未检测到终端（先打开侧边栏终端再检测）」，不报错 |
| 设置页保存 | 写 profile 该条目 `config:`（命名空间 = 条目 id `terminal-font`），随后按 0.2.0 条目配置重应用 |

## 设计约束与取舍

- **字号只读**：字号是核心硬编码的 13px，xterm 的字符尺寸缓存（canvas 测量）建立在同一个字号上。纯 CSS 改 `font-size` 会让 DOM 渲染与 xterm 认的单元格宽度脱钩（列错位、光标漂移）；用 `size-adjust` 反向补偿又会把字形整体缩放回去、视觉等于没改。因此 tab 只读展示字号，可调的是两个 `size-adjust`（字形相对单元格的大小）。
- **用 `size-adjust` 而不是直接换字体名**：xterm 用同一 fontFamily 串既渲染又度量，换 advance 不同的字体会让列宽失配；归一后渲染字宽 = 度量字宽。
- **走 `webserver/index-inject` 而不是客户端 DOM 注入**：样式一次性进 `<head>`，不需要 MutationObserver、不会与 React 调和打架；代价是桌面版要重启才生效。
- **注入去重**：同一张注入表只 push 一次（每个请求一张新表，Web 端每请求都会重新收集）。
- **手写 Config**：`meta.volatile` + 真实 refs 表 `toJSON()`，`~standard.vendor` 故意不是 `schemastery` —— 让 0.2.0 的设置写入走普通条目重启路径。
- 遵守 2026-09-10 规则：子插件不声明 `dsh.bundle`、目录内不放 `cordis.patch.yml`、宿主半不 import 宿主内部包。

## 安装 / 启停

由仓库的**本地插件管理器**统一安装与启停，**不要**单独 `dsh plugin add`：

1. 设置 →「本地插件」→ 打开 `dsh-terminal-font`；
2. Web 刷新页面、桌面版重启 DSH Desktop；
3. 打开侧边栏终端确认字形；设置 →「本地插件」→ tab「终端字体」看诊断卡。

## 验收清单

### 1. 自动化（离线可跑）

- [x] 1.1 `[A]` CSS 生成：默认配置产出「marker 注释 + 2 条 @font-face + 1 条字体栈规则」，marker 在首行、末尾有换行；`enabled:false` 或两个字体栈都为空时产出空串 —— `test/host.test.mjs`
- [x] 1.2 `[A]` 归一算式自洽：`0.62 × 88.6781% × 13px` 与 `0.5 × 109.9609% × 13px` 都等于 `7.1474609375px`（±0.0005），且 CJK advance 恰为 Latin 两倍 —— `test/host.test.mjs`
- [x] 1.3 `[A]` 注入：`apply()` 注册 `webserver/index-inject` 监听、返回 disposer；同一张表只 push 一次；`enabled:false` 时返回 undefined 且不注册；敌意表（push 抛错）不炸 —— `test/host.test.mjs`
- [x] 1.4 `[A]` 配置夹取：越界值夹到 10–400、字符串数字 `"95"` 转数字、坏类型/非对象回落默认 —— `test/host.test.mjs`
- [x] 1.5 `[A]` Config 契约：`type==="object"`、`meta.volatile`、`~standard.vendor==="dsh-terminal-font"`、`toJSON()` 形状与真实 schemastery 输出一致且不污染内部 —— `test/host.test.mjs`
- [x] 1.6 `[A]` 客户端注册：bundle 装载后向 `settings.localPlugins.tab` 注册 `id: terminal-font`、`order: 46`、`locale: terminal-font`，label 随语言变化 —— `test/bundle.test.mjs`
- [x] 1.7 `[A]` i18n：locale 服务优先于内置字典、服务返回 key 时不遮蔽内置字典、服务缺席回退 zh/en、locale 服务迟到时 tab 仍注册 —— `test/bundle.test.mjs`
- [x] 1.8 `[A]` 诊断：`<style>` 注入检测、字体面状态映射（loaded/loading/error/unloaded/missing）、单元格宽度实测与 0.05px 容差、无终端时降级为 null 不抛 —— `test/bundle.test.mjs`
- [x] 1.9 `[A]` 设置读写：五个候选源探测、typert 信封解包、`describe()` 找本命名空间行、写入前归一化 —— `test/bundle.test.mjs`

### 2. 真机（需人工在 GUI 里确认）

- [ ] 4.1 `[B]` 装好 `0xProto Nerd Font (Mono)` 与 `Sarasa Term SC Nerd` → 启用插件 → 重启桌面版 → 侧边栏终端里 oh-my-posh 提示符**无豆腐块**
- [ ] 4.2 `[B]` 诊断卡：CSS 注入 = 已注入、Nerd Font 字形 = loaded、中文字体 = loaded、终端字号 = 13px、单元格宽度「实测 7.147px / 目标 7.147px」
- [ ] 4.3 `[B]` 在 tab 里把 `monoSizeAdjust` 改成 `100` 保存并刷新 → 单元格宽度仍是 7.1475px（xterm 度量未变）但字形变宽、字符互相重叠；改回 `88.6781` 恢复正常
- [ ] 4.4 `[B]` 关掉 `enabled` 保存并重启 → 终端回到 Consolas、豆腐块复现；重新打开 → 恢复
- [ ] 4.5 `[B]` 把 `monoFont` 改成一个不存在的字体名保存重启 → 诊断卡显示 missing、终端列宽与未启用插件时一致（无错位、无布局跳动）
