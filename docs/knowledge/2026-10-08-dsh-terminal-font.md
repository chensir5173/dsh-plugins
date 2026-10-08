# 2026-10-08 — dsh-terminal-font：侧边栏终端 Nerd Font 豆腐块的根因与 size-adjust 归一闪法

结论先行：核心终端的字体栈与字号**双重硬编码**，而 xterm 用**同一个 fontFamily 字符串既渲染又度量** —— 所以「换一个 Nerd Font」不能只改 CSS 字体名；可行解是把候选字体的 advance 用 `@font-face { size-adjust }` 精确归一到**核心现有的单元格宽度**上。

## 1. 现象与根因链

1. 侧边栏终端里 oh-my-posh / Starship 的提示符字形（Powerline `U+E0B0`、分支 `U+F015`、锁 `U+E0A0`）显示成豆腐块。
2. 核心把字体写死在 `packages/client/ui-sidebar-terminal/src/client/terminal.tsx`：`fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"`、`fontSize: 13`；**没有任何 `Config`、也没有 CSS 变量**可覆盖。
3. 本机（Windows）实际命中 **Consolas**：Chromium 不认 `ui-monospace`，SF Mono / Menlo 未安装。
4. Consolas 的 cmap **不含 Nerd Font 私用区字形**（直读 `consola.ttf` 命中 MISSING）⇒ 方块。注意这一步与 shell 配置无关：oh-my-posh 已经装好、字体也已经装在用户目录，**问题在 DSH 这一侧**。

## 2. 为什么不能只改 CSS 字体名（本条是实现的总约束）

xterm 用**同一个 fontFamily 字符串**做两件事：

- **渲染**：DomRenderer 把 `.xterm-rows { font-family: … }` 注入 `.xterm-screen`；
- **度量**：CharSizeService 用 OffscreenCanvas 量 `W`、WidthCache 逐字符量，据此算 `letter-spacing` 与单元格尺寸。

换一个 advance 不同的字体 ⇒ xterm 仍按 Consolas 的单元格宽度排版，而字形宽度变了 ⇒ **列宽、竖线、光标定位全部错位**。所以必须让「渲染字宽 == 度量字宽」。

## 3. 解：@font-face + local() + size-adjust 归一

- 目标单元格宽度 = `13px × 1126/2048 = 7.1474609375px`（Consolas 的 advance 是 **1126/2048 em**）。
- `0xProto Nerd Font Mono`：advance **0.6200em** ⇒ `size-adjust: 88.6781%`（= 0.5498046875 / 0.62）。
- `Sarasa Term SC Nerd`：advance **0.5000em** ⇒ `size-adjust: 109.9609%`（= 0.5498046875 / 0.50）；它的 CJK 全角恰为 Latin 的 **2 倍**宽 ⇒ 归一后正好 2 个单元格（14.295px）。
- 字体用 `local("…")` 引用**本机已装**字体，不打包字体文件；字体缺失时 @font-face 静默失效、回退栈赢 ⇒ 观感与未启用插件逐像素一致（安全默认）。
- `0xProto Nerd Font` 与 `… Mono` 可互换；`… Propo` 是**比例字体**，不能用于终端。

## 4. 注入通道与生效时机

- 宿主半：`ctx.on("webserver/index-inject", (table) => table.push({ kind: "style", text: css }))`。
- cordis 的 `emit` 是**全局广播**（`dispatch` 从共享 `_hooks` 取监听器，只按 `hook.global || !filter` 过滤），所以 profile 里任意插件的 ctx 都能收到核心 `webServer` 服务发的这个事件 —— 不需要是 webServer 的子 ctx。
- 生效时机**两条路径不同**：`dsh web` 每次页面请求都重新 `collectIndexInjections()` ⇒ **刷新页面即生效**；DSH Desktop 的 host 只在 app ready 时收集一次并 `process.send({type:"ready", injections})` ⇒ **必须重启 DSH Desktop**。

## 5. 字号为什么只读（别浪费时间试）

- 字号 13px 硬编码在核心，xterm 的字符尺寸缓存也建立在同一个字号上。
- 纯 CSS 改 `font-size`：只改 DOM 渲染，不改 canvas 度量 ⇒ 渲染与单元格宽度脱钩（列错位、光标漂移）。
- 想用 `size-adjust` 反向补偿：它把字形**宽高一起**缩放 ⇒ 补偿后视觉大小回到原样，等于什么都没改。
- 结论：字号只能**只读展示**，真正可调的是 `size-adjust`（字形相对单元格的大小）。

## 6. 诊断与验证方法（可复用）

- 字体是否生效：`document.fonts.check('13px "DSH Terminal Mono"', "W")`；或遍历 `document.fonts` 找 family 的 status。
- 单元格宽度必须用 **DOM 离屏 span + getBoundingClientRect**（32 个字符宽 ÷ 32），**不要用 canvas 量**：canvas 不保证应用 `size-adjust`，量出来是未归一的值。
- 字体缺失时 @font-face 是**静默失效**的 ⇒ 诊断卡必须显式展示字体面状态（loaded / missing），否则「没生效」无法自证。

## 7. 已知限制

- Powerline / 方块字形上下各被裁约 1.5px：行高由字体包围盒锁定并写在行元素内联样式上，插件无法安全介入；Sarasa（1.250em）比 0xProto（1.576em）更轻。
- 字体名匹配是 `local()` 精确名，写错只是"没生效"，不会报错。

## 8. 本仓库落地

- 插件 `sub-plugins/dsh-terminal-font`：宿主半空壳 + 注入（`src/index.js`）、设置 tab（`src/client.js`，`settings.localPlugins.tab` order 46）。
- 配置项（写 profile 条目 `config:`，命名空间 = 条目 id `terminal-font`）：`enabled` / `monoFont` / `cjkFont` / `monoSizeAdjust`（默认 88.6781）/ `cjkSizeAdjust`（默认 109.9609）。
- 测试：`node sub-plugins/dsh-terminal-font/test/host.test.mjs`（18/18）、`node sub-plugins/dsh-terminal-font/test/bundle.test.mjs`（23/23）。
