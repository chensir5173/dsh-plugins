# dsh-terminal-font

修好 **DSH 侧边栏终端里的乱码 / 豆腐块**：oh-my-posh、Starship 一类提示符用的 Nerd Font 私用区字形（Powerline 分隔符 U+E0B0、分支 U+F015、锁 U+E0A0）在核心终端里显示成方块。

插件用 **CSS `@font-face` + `local()` + `size-adjust`** 把本机已装的 Nerd 字体接进终端字体栈，并把它的小数级字宽精确归一到核心 xterm 现有的单元格宽度上 —— **不改核心源码、不改字号、不破坏列宽与光标对齐**。

纯客户端插件：宿主半是一个空壳（只为让 `@deepseek-ai/dsh-client-modules` 扫到本包的 `dsh.client`），真正的样式由宿主半的 `webserver/index-inject` 监听推进页面 `<head>`。

## 问题与根因

1. 核心终端把字体写死在核心包 `ui-sidebar-terminal` 的 `src/client/terminal.tsx`：`fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"`、`fontSize: 13`，没有任何 `Config` 或 CSS 变量可覆盖。
2. 该栈在本机（Windows）实际命中的是 **Consolas**：Chromium 不认 `ui-monospace`，SF Mono / Menlo 未安装。
3. Consolas 的 cmap **不含 Nerd Font 私用区字形**（直读 `consola.ttf` 确认 MISSING），于是这些字符全部落到豆腐块 —— 即使你已经在 shell 里装好了 oh-my-posh 主题。

**为什么不能"只加一条 CSS 改字体名"**：xterm 用**同一个 fontFamily 字符串**既渲染（DomRenderer 把 `.xterm-rows{font-family}` 注入 `.xterm-screen`）又度量（CharSizeService 用 OffscreenCanvas 量 `W`、WidthCache 逐字符量）。换一个 advance 不同的字体 → xterm 仍按 Consolas 的单元格宽度排版 → 列宽、竖线、光标定位全部错位。

## 方案：@font-face + size-adjust 归一

把候选字体的 advance **精确缩放到核心当前的单元格宽度**，渲染与度量重新一致：

- 目标宽度 = `13px × 1126/2048 = 7.1474609375px`（Consolas 的 advance 是 1126/2048 em）。
- `0xProto Nerd Font Mono`：advance 0.6200em → `size-adjust: 88.6781%`（= 0.5498046875 / 0.62）。
- `Sarasa Term SC Nerd`：advance 0.5000em → `size-adjust: 109.9609%`；它的 CJK 全角字宽恰为 Latin 的 2 倍，归一后正好 = 2 个单元格。

插件注入的样式等价于：

```css
/* dsh-terminal-font */
@font-face {
  font-family: "DSH Terminal Mono";
  src: local("0xProto Nerd Font Mono"), local("0xProto Nerd Font");
  size-adjust: 88.6781%;
  font-display: swap;
}
@font-face {
  font-family: "DSH Terminal CJK";
  src: local("Sarasa Term SC Nerd");
  size-adjust: 109.9609%;
  font-display: swap;
}
.xterm-rows, .xterm .composition-view {
  font-family: "DSH Terminal Mono", "DSH Terminal CJK", Consolas, monospace !important;
}
```

字体缺失时 @font-face 直接失效、回退 Consolas —— 列宽与装插件前**逐像素一致**（安全默认）。

已知限制：Powerline / 方块字形上下各被裁约 1.5px。行高由字体包围盒锁定且写在行元素内联样式上，插件无法安全介入；Sarasa（1.250em）比 0xProto（1.576em）更轻。

## 字体前提

本机需装（用户级 `%LOCALAPPDATA%\Microsoft\Windows\Fonts` 即可，无需管理员）：

- `0xProto Nerd Font Mono`（`0xProtoNerdFontMono-*.ttf`；普通的 `0xProto Nerd Font` 也可互换，`Propo` 是比例字体**不能**用于终端）
- `Sarasa Term SC Nerd`（`SarasaTermSCNerd-*.ttf`，用于 CJK 对齐）

## 怎么用

1. 在**本地插件管理器**里打开 `dsh-terminal-font`（不要单独用 `dsh plugin add` 装子插件）。
2. 让样式生效：
   - Web（`dsh web`）：**刷新页面**即可（索引注入每次请求重新收集）。
   - 桌面版（DSH Desktop）：**必须重启 DSH Desktop** —— 桌面 host 只在 app ready 时收集一次注入。
3. 打开侧边栏终端：提示符方块应变成真实字形。

## 设置页

设置 →「本地插件」→ tab **终端字体**（槽位 `settings.localPlugins.tab`，id = 条目 id `terminal-font`，order 46）。

**诊断卡**（点「重新检测」随时刷新）：

| 行 | 含义 |
| --- | --- |
| CSS 注入 | 页面里能否找到本插件注入的 `<style>`；「未注入」= 还没重启（桌面版）或没刷新（Web） |
| Nerd Font 字形 | `DSH Terminal Mono` 的字体面状态（loaded / missing …） |
| 中文字体 | `DSH Terminal CJK` 的字体面状态 |
| 终端字号 | 核心写死的字号（只读，见下） |
| 终端单元格宽度 | 实际量到的单元格宽度 / 目标 7.1475px；不一致即字号或字体栈被改过 |
| 终端字体栈 | 当前生效的 computed `font-family` |

**设置卡**（保存后写进 profile 行的 `config:`，命名空间 = 条目 id `terminal-font`）：

| 键 | 默认 | 说明 |
| --- | --- | --- |
| `enabled` | `true` | 关掉即不注入任何样式（回到核心原样） |
| `monoFont` | `0xProto Nerd Font Mono, 0xProto Nerd Font` | Latin / Nerd 字形候选栈（逗号分隔，按序 `local()`） |
| `cjkFont` | `Sarasa Term SC Nerd` | CJK 候选字体 |
| `monoSizeAdjust` | `88.6781` | 上面那条 @font-face 的 `size-adjust`（%，范围 10–400） |
| `cjkSizeAdjust` | `109.9609` | CJK 那条的 `size-adjust`（%，范围 10–400） |

profile 行里也可以手写（等价）：

```yaml
- insert:
    - id: terminal-font
      name: dsh-terminal-font
      config:
        monoFont: "0xProto Nerd Font Mono"
        cjkSizeAdjust: 109.9609
```

**为什么没有「字号」输入框**：字号由核心硬编码为 13px，xterm 的字符尺寸缓存（canvas 测量）也建立在同一个字号上。纯 CSS 改 `font-size` 只会让 DOM 渲染的字符与 xterm 认的单元格宽度脱钩（列错位、光标漂移）；而用 `size-adjust` 反向补偿又会把字形整体缩放回去，视觉上等于什么都没改。所以 tab 里**只读展示**字号，真正可调的是上面两个 `size-adjust`（它决定字形相对单元格的大小）。

## 验证

```bash
node sub-plugins/dsh-terminal-font/test/host.test.mjs     # 18/18：CSS 生成、归一算式、Config、注入去重
node sub-plugins/dsh-terminal-font/test/bundle.test.mjs   # 23/23：注册、i18n、诊断、设置读写
```

页面内手工核对：`document.fonts.check("13px \"DSH Terminal Mono\"", "W")` 应为 true，且离屏量 32 个 `W` 的宽度 ÷ 32 ≈ 7.1475px。

## 已知边界

- 不改字号、不改行高、不改 xterm 的任何选项；只接字体。
- 桌面版新增/重启窗口都需要重启 DSH Desktop 才会带上样式（注入只在 app ready 收集一次）。
- 字体名匹配是 `local()` 精确名，写错就是"没生效"，诊断卡会显示 missing。
