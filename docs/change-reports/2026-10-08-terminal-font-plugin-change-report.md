# 变更报告 — dsh-terminal-font：侧边栏终端 Nerd Font 豆腐块（新插件，2026-10-08）

新插件 `sub-plugins/dsh-terminal-font` 0.1.0 ｜ 仓库外壳与 dsh-plugin-manager 0.3.8 → 0.3.9 ｜ 新增测试 host 18/18 + bundle 23/23

## 1. 触发

用户报：**DSH 侧边栏终端里 oh-my-posh 的提示符字形全是豆腐块**，并已自行做过调研（`tmp/terminal-font/`：README + index.mjs + package.json 实验稿），要求把这套方案做成正式插件；随后追加一句「加个 ui tab，支持设置字体的终端的字体，或者大小的信息」。

## 2. 根因

| 环 | 事实 |
| --- | --- |
| 1 | 核心把终端字体写死在 `ui-sidebar-terminal` 的 `terminal.tsx`：`fontFamily: "ui-monospace, SFMono-Regular, Menlo, Consolas, monospace"`、`fontSize: 13`，无 `Config`、无 CSS 变量 |
| 2 | 本机（Windows）实际命中 **Consolas**（Chromium 不认 `ui-monospace`，SF Mono / Menlo 未装） |
| 3 | Consolas 的 cmap 不含 Nerd Font 私用区字形（直读 `consola.ttf` 确认 MISSING）⇒ 提示符方块 |
| 4 | **不能只换字体名**：xterm 用同一个 fontFamily 串既渲染（DomRenderer 注入 `.xterm-rows{font-family}`）又度量（CharSizeService 的 canvas 测量 / WidthCache）⇒ 换 advance 不同的字体必然列宽与光标错位 |

## 3. 修改摘要

| 文件 | 改动 |
| --- | --- |
| `sub-plugins/dsh-terminal-font/src/index.js`（新） | 宿主半：`buildCss()` 生成「marker + 两条 @font-face + 一条字体栈规则」，纯函数 `parseFontStack` / `sanitizeFontName` / `formatPercent` / `normalizeEntryConfig` / `clampNumber` / `pushStyleRow`；`apply()` 监听 `webserver/index-inject` 推入 `{kind:"style"}`（同表去重、坏表不炸）；导出真实 schemastery 形状的 `Config`（`meta.volatile`、`~standard.vendor="dsh-terminal-font"`，故意不是 `schemastery`） |
| `sub-plugins/dsh-terminal-font/src/client.js`（新） | 设置 tab（`settings.localPlugins.tab`，id `terminal-font`，order 46）：诊断卡（CSS 注入 / Nerd Font 字形 / 中文字体 / **终端字号** / 终端单元格宽度 / 终端字体栈）+ 设置卡（`enabled` / `monoFont` / `cjkFont` / `monoSizeAdjust` / `cjkSizeAdjust`，blur 夹取）+ 0.2.0 条目设置读写（`remote.settings.describe()` → `update(ns, …)`）+ zh/en 字典 + `window.__terminalFontTest` 测试钩子 |
| `sub-plugins/dsh-terminal-font/package.json`（新） | `dsh.client.platform="web"`；不声明 `dsh.bundle`、目录内无 `cordis.patch.yml`（2026-09-10 规则） |
| `sub-plugins/dsh-terminal-font/test/host.test.mjs`（新） | 18 条：默认 CSS 形状与 marker、归一算式自洽（`0.62×88.6781%×13 == 0.5×109.9609%×13 == 7.1474609375`，CJK 两倍）、夹取与坏类型回落、`apply()` 注入与去重、敌意表、`Config` 契约与 `toJSON` 形状 |
| `sub-plugins/dsh-terminal-font/test/bundle.test.mjs`（新） | 23 条：注册契约、tab 注册（id/order/locale/label）、locale 服务迟到与优先、`__t`/`__tf`、语言嗅探、`styleInjected` / `collectFontFaces` / `pickFaceStatus` / `probeFonts` / `readTerminalProbe` / `measureCellWidth` / `runDiagnostics`（含 0.05px 容差边界）、`readRemoteSettings` / `unwrapResult` / `settingsFromRow` / `readSettings` / `saveSettings` / `sameSettings` |
| `README.md`、`ACCEPTANCE.md`（新） | 行为表、设计约束（字号只读、size-adjust 归一、注入通道、已知裁切）、安装/启停、9 条自动化 + 5 条真机验收项 |
| `docs/plugins.md` | 一览表新增一行 + 新增「dsh-terminal-font — 侧边栏终端字体（修豆腐块）」小节 |
| `docs/knowledge/2026-10-08-dsh-terminal-font.md`（新）与索引 | 沉淀可复用结论：xterm 同串度量、size-adjust 归一算式、注入通道与两条生效路径、字号只读的证明、DOM 而非 canvas 的度量验证法 |
| 根 `package.json` + `dsh-plugin-manager/package.json` | 版本同步 0.3.8 → 0.3.9 |

## 4. 验证证据

| 证据 | 结果 |
| --- | --- |
| `node sub-plugins/dsh-terminal-font/test/host.test.mjs` | **18/18 passed** |
| `node sub-plugins/dsh-terminal-font/test/bundle.test.mjs` | **23/23 passed** |
| 版本一致性护栏 `node dsh-plugin-manager/test/root-install-shell.test.mjs` | PASS（两处 0.3.9 一致） |
| 全仓 sweep（`sub-plugins/**` + `dsh-plugin-manager/**` 共 21 支用例） | **17 绿 / 4 红，4 支红灯全部是本沙箱的环境限制、与本次改动无关**：`dsh-plugin-manager` 的 `batch-remove-all.test.mjs`、`debounce.test.mjs` 死于 `EPERM: operation not permitted, symlink … js-yaml`（沙箱不允许建符号链接）；`dsh-idle-hook` 的 `host-core.test.mjs`、`bundle.test.mjs` 死于 `spawn 失败：spawn EPERM`（沙箱不允许派生子进程） |

## 5. 边界与遗留

- **用户侧还需两步**：在管理器面板启用本插件；桌面版**重启 DSH Desktop**（Web 刷新页面即可）。
- **字号没有输入框**：13px 由核心硬编码，xterm 的度量缓存建立在同一字号上；改 CSS `font-size` 会让渲染与度量脱钩，用 size-adjust 补偿又把字形缩放回去 ⇒ tab 只读展示字号，可调的是两个 `size-adjust`。
- 字体前提：本机需装 `0xProto Nerd Font (Mono)` 与 `Sarasa Term SC Nerd`（用户级即可）；缺字体时插件静默回退 Consolas、观感与未启用一致。
- 已知限制：Powerline 字形上下各裁约 1.5px（行高由字体包围盒锁定）。
- 真机 4.1–4.5 五条验收项待用户重启后在 GUI 内确认（ACCEPTANCE.md「真机」段）。
