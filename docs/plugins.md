# 插件目录：每个插件做了什么、怎么用

> 本页是**用法索引**（做什么 + 在哪触发 + 前提）。每个插件的完整行为表、设计取舍与验收清单在各自的 `README.md` / `ACCEPTANCE.md`，本页只做已核对的摘要，不重复细节。
>
> 表中每条**触发方式、槽位、order、设置项、端点**都是 2026-09-11 从 `src/` 源码逐项核对过的（不是照抄旧文档）；核对方法见文末。

## 先装哪个

**只装 `dsh-plugin-manager` 一个**，其余全部在它的面板里开关——不需要、也不应该逐个 `dsh plugin add`：

```bash
dsh plugin --profile web add git+https://github.com/Chen5173/dsh-plugins.git   # 从 git
dsh plugin --profile web add <本机仓库根>                                       # 本机开发（活链接）
```

装完重启 `dsh web` → 设置 →「本地插件」→ 打开想用的插件开关 → **再刷新一次页面**（宿主侧即时生效，客户端 UI 需要一次刷新）。两种入口的差别（快照 vs 热改）见根 `README.md`「统一安装模型」。

## 一览表

| 插件 | 一句话 | 你在哪用它 | 形态 | 启用前提 |
|---|---|---|---|---|
| [`dsh-plugin-manager`](../dsh-plugin-manager/README.md) | 管理本仓库全部子插件的唯一控制台 | 设置 → **本地插件** | 宿主 + 客户端 | 装它本身即可 |
| [`dsh-composer-history-recall`](../sub-plugins/dsh-composer-history-recall/README.md) | 输入框里 `↑`/`↓` 逐条召回**本会话你发过的**消息 | composer 键盘 | 纯客户端 | 需 `conversation.input.overlay` 槽 + composer 根 `data-composer-input`；缺席则惰性不生效 |
| [`dsh-esc-rewind`](../sub-plugins/dsh-esc-rewind/README.md) | `Esc` 停止、`Esc Esc` 回退本轮重来、`/rewind` 从任意历史轮重来；旧会话可归档或真删 | composer 键盘 + `/rewind` + 会话头图标 | 客户端 + **宿主半**（删除模式） | 删除模式需要 `webServer`；无则自动降级为归档 |
| [`dsh-composer-provider-label`](../sub-plugins/dsh-composer-provider-label/README.md) | 在模型名左边显示**实际打到哪个 provider**，并给出提供方/模型两级选择菜单 | composer 右侧标签（点开即菜单） | 客户端 + 可选宿主设置段 | 核心 **≥ 0.1.2-rc.1**；无 `Menu` 原语时退化为只读标签 |
| [`dsh-session-title-regenerate`](../sub-plugins/dsh-session-title-regenerate/README.md) | 用**当前模型**摘要本会话全部提问，重生成 ≤60 字标题；**思考开关 / 推理强度 / 输出上限**可在设置页调（默认关思考、512） | 会话头按钮 / 侧栏行 `⋯` 菜单 / `/regenerate-title` / 设置 →「本地插件」tab | 客户端 + 宿主命令 | 核心 ≥ 0.1.1-rc.2 |
| [`dsh-session-time-bucket`](../sub-plugins/dsh-session-time-bucket/README.md) | 侧栏会话列表按**今天/昨天/前7天/前30天/更早**分组 | 自动：核心处于「单列表 + 最近更新」时接管观感 | 纯客户端 | 无需操作；切到按工作区/手动排序或搜索时自动退出 |
| ~~[`dsh-open-session-workdir`](../sub-plugins/dsh-open-session-workdir/README.md)~~ **已退役** | ~~一键用**系统文件管理器**打开当前会话的工作目录~~ —— 核心已自带「Open In…」分体按钮（探测已装应用 + 记住上次选择） | 不再出现在管理器面板；源码保留在仓库 | — | 退役中：管理器扫描跳过它（`RETIRED_PLUGIN_DIRS`），无法再激活 |
| ~~[`dsh-hindsight-model`](../sub-plugins/dsh-hindsight-model/README.md)~~ **已退役** | ~~看清 **Hindsight 守护进程**当前跑的是哪个模型、改掉它，**启停它**，并按需自动拉起 —— 四层对照（落盘 / 进程实际生效 / 外层冲突源 / 生效判据）~~ —— 用户 2026-10-09 要求暂时废弃 | 不再出现在管理器面板；源码保留在仓库 | — | 退役中：管理器扫描跳过它（`RETIRED_PLUGIN_DIRS`），无法再激活 |
| [`dsh-idle-hook`](../sub-plugins/dsh-idle-hook/README.md) | 模型不在运行时（一轮结束 / 等待批准 / 等待回答）按规则执行**本机脚本**（py/bat/ps1/sh/可执行），把通知送到页面关掉也能到的地方 | 设置 → **空闲通知** | 宿主 + 客户端 | 需 `settings` 服务读规则与 `webServer` 提供设置页/心跳；二者缺席时降级为「无规则不触发」，宿主半照常加载 |
| [`dsh-agent-preset-manager`](../sub-plugins/dsh-agent-preset-manager/README.md) | 让**本地目录里的 agent preset** 在 0.2.0 上继续可用：运行期声明进宿主注册表，可开关 / 新增 / 编辑 / 删除 / 导入 / 迁移 | 设置 → **本地插件** → tab「Agent 预设」 | 宿主 + 客户端 | 需宿主提供 `agentPresets` 注册表服务（缺席即只读）；不碰 profile 配置 |
| [`dsh-terminal-font`](../sub-plugins/dsh-terminal-font/README.md) | 把本机已装的 **Nerd Font** 接进侧边栏终端字体栈（`@font-face` + `size-adjust` 归一），修掉 oh-my-posh 提示符的豆腐块 | 自动：样式进页面 `<head>`；设置 →「本地插件」→ tab「终端字体」看诊断 / 改字体 | 客户端 + 空壳宿主（注入样式） | 本机需装 `0xProto Nerd Font (Mono)` 与 `Sarasa Term SC Nerd`；**桌面版须重启 DSH Desktop** |

## 逐个怎么说"怎么用"

### dsh-plugin-manager — 本地插件管理器

- **入口**：设置页左侧一级导航「本地插件」（`settings.section`，`order: 16`）。
- **能做什么**：列出仓库 `sub-plugins/` 下全部 `dsh-*`（管理器自己不列入），每行一个主开关 + 「移除」；顶部有 **全部开启 / 全部关闭 / 全部移除** 三个批量按钮（按钮上的数字就是本次真正会改动的项数，跳过的旧布局/非插件目录不计）与「一键接管/迁移」。
- **开关语义**：开 = 自动补 profile `devDependencies` 的**相对 `link:` 规格**（`link:./node_modules/dsh-plugin-manager/sub-plugins/<dir>`，指向 profile 里那份管理器拷贝，**不含盘符/用户名/仓库绝对路径**；只有该镜像不可达时才退回 `link:<插件绝对目录>`）+ 写激活行；关 = 行保留、写 `disabled: true`（可随时再开，不丢配置）；移除 = 删激活行 + 摘依赖（**仓库源码目录保留**）。
- **全部移除**（破坏性，`POST /__dsh-plugin-manager/remove-all`）：一次清空全部受管子插件的激活行与依赖键、只跑一次 `pnpm install`；源码目录不动，之后可逐个或全部重新启用。**迁移过 profile / 换过 `DSH_HOME` 后**面板可能显示「未激活(仅依赖)」或横幅「依赖待修复」——先「全部移除」再重新启用，或直接点「修复依赖」，管理器就按当前 profile 的位置重写相对 `link:` 规格（并顺手清掉早期版本留下的锚点 glob）。合并窗口里未落盘的开关点击会随行作废（结果里报出作废条数）。
- **诊断**：`GET /__dsh-plugin-manager/status`（含 `pendingWrites` 未落盘数、`lastFlushError`、`lastBatch`、`workspace` / `workspaceRepair` —— **锚点退役视图**，`workspace.ok` 表示已无残留 glob）、`GET /list`（`batchCounts` 含 `enable`/`disable`/`remove` 三向计数，`workspace` 同上，`repairPlan` 为待修依赖）。
- **注意**：切换带界面的子插件后，面板只会**提示**你刷新，不会自动刷新页面。

### dsh-composer-history-recall — 输入框历史召回

- **怎么用**：光标停在草稿**首行**按 `↑` 进入召回，继续 `↑`/`↓` 逐条走；到最早一条再 `↑` 会停在原地并提示「已是最早一条历史」；手动编辑一下就退出浏览。
- **不会做什么**：只写草稿，**绝不自动发送**；不改动会话消息与运行状态；不写任何持久数据。
- **什么时候让路**：光标在中间行、草稿含 `@文件` chip、正在输入 `/命令` 或 `@提及`（补全菜单打开）——这些情况方向键交回编辑器/菜单。
- 按会话隔离：切换会话游标重置。

### dsh-esc-rewind — 停止 / 回退重来

- **三个触发**：① 生成中按 `Esc` = 停止（等价 Stop 按钮）；② 停止后**再按一次** `Esc` = 回退整个最后一条，`fork` 新分支 + 把原问题还原到输入框；③ 输入 `/rewind` 打开回合选择器，可从**历史任意一轮**重来。
- **旧会话怎么处置**：会话头右侧一个图标切换（档案柜 = 归档，默认；红色带叉垃圾桶 = 真删）。这是**全局偏好**，持久化在 settings 命名空间 `esc-rewind.deleteOldOnRewind`（默认 `false`），设置页也能改。删除态**没有二次确认**，且删除失败会自动降级为归档而不是让回退失败。
- **防误触**：自然正常结束的回合**不会** armed（尾部是 settled assistant 时 `Esc` 不接管）；编辑过输入框草稿、切换会话、有弹层/菜单打开时都会让路或失效。
- **`/rewind` 性能语义**：同一页面内首次打开会 `session.loadThrough(0)` 一次性读全历史（之后直接读活会话），刷新后走 localStorage 缓存 + 水位判定，过期才合并重载。
- **回退前会先清「未落定的排队消息」**：宿主的 fork 用事件种子重建子会话，父会话里刚发出、还没落盘的排队输入会被一起复制过去（子会话会先执行它、用户新发的只能排队）。所以回退前会删排队项并**等到快照确认清空**；清不掉就**放弃本次回退**并提示「该会话还有没发出的消息在排队…」。诊断：`__dsew.pendingCleared` / `pendingBlocked` / `childPendingCleared`。
- **跨核心世代的契约**（都用能力探测，不读版本号）：草稿附件族（0.1.5 起 `createDrafts`/`releaseDraftAttachment`/`addAttachments`，旧名回退）；命令描述（0.1.5 起 `description` 由字符串变函数，用 getter 在读取时定型，见 `__dsew.commandDescShape`）。
- **诊断**：宿主 `GET /__esc-rewind/status`（settings 段是否注册成功 + 当前删除模式）、删除走 `POST /__esc-rewind/session/delete`；客户端 `window.__dsew`（门控计数，不含消息内容）。
- **改宿主半（`src/index.js`）需重启 GUI host**，改 `src/client.js` 刷新页面即可。

### dsh-composer-provider-label — provider 标签与两级选择

- **在哪**：composer 工具行右侧组、**模型选择器左边一格**：`[…] [provider] [DeepSeek-V4-Flash · high] [上下文] [发送]`。
- **怎么用**：点标签弹出菜单 → 根层有「提供方」「模型」两行 → 点提供方**立即切换**（当前模型仍属于它就保留，否则优先 profile 默认模型、再否则该方第一个模型），随后自动进入模型层方便接着选；底部常驻「全部提供方 / 仅当前提供方」互斥开关。键盘 Tab/Enter/Esc。
- **只读信息**：悬停/聚焦标签 → tooltip 给出 provider 完整名 · 模型 id · 当前推理档 · **路由来源**（本会话显式选择 / 跟随 profile 默认）。
- **短名从哪来**：settings 别名 > 内置表（只预置 `deepseek-official → office`）> 注册显示名剪掉尾部括号 > provider id。
  ```yaml
  dsh-composer-provider-label:
    providerAliases:
      codemaker: cm
  ```
  ⚠️ 已知限制：settings 段只有在宿主半能解析到 `@deepseek-ai/schemastery` 时才注册，**`link:` 安装形态下解析不到**，此时 `providerAliases` 不生效（只用内置别名）。
- **注意**：`session/selectModel` 会顺带更新 profile 默认模型——一次选择既是本会话下一次请求、也成为默认。
- 显示范围偏好存浏览器 localStorage（`dsh.composer-provider-label.v1`），不写宿主配置。

### dsh-session-title-regenerate — 重新生成标题

- **三个入口，同一套逻辑**：会话头部操作区按钮 / 侧栏会话行 `⋯` 菜单项「重新生成标题」/ 宿主命令 `/regenerate-title`。
- **为什么菜单项对任意历史会话都有效**：走 `remote.commands.execute(sessionId, …)`，该 Remote 的 `agent` 查找会**自动恢复未打开的会话**，且**不切换你当前对话**。
- **产出**：单行 ≤60 字、跟随消息语言的标题，直接覆盖旧标题；成功 Toast「标题已更新：…」。**副作用**：标题以 `user` 来源固定，此后新消息不会再自动更新它，要改得再点一次。
- **配置有两层**：① **设置页**（设置 →「本地插件」→ tab「重新生成标题」，`settings.localPlugins.tab`，id = entry id `session-title-regenerate`）改**思考开关 / 推理强度（`off`/`low`/`medium`/`high`/`max`）/ 输出上限**，默认 关思考 · `off` · **512**，保存即写进 profile 行 `config:` 并对后续生成生效；② profile 行 `config:` 可再写 `provider` / `model`（必须成对）、`targetWords` / `targetCjkCharacters` / `maxInputBytes` / `thinking` / `reasoningEffort` / `maxOutputTokens` / `timeoutMs`（写配置请写管理器生成的 insert 项，不要另起顶层覆盖行，否则首次开关会被规范化并丢掉字段）。思考关闭时不下发 `reasoningEffort`（等价 `off`），这是避免标题预算被思考 token 吃光的关键。
- **可观测**：会话流里会留下一对 `command/run`/`command/done` 节点（`recordInput:false`，不记录参数）。

### dsh-session-time-bucket — 侧栏时间桶分组

- **怎么用**：**没有按钮**，全自动。核心侧栏处于「单列表 + 最近更新」时激活，在核心原生列表上注入组头与 `[工作区]` 前缀；切回「按工作区」或「手动排序」、或进入搜索，自动完整退出、零残留。
- **能操作什么**：点组头的 chevron 折叠/展开该桶，折叠态持久化（刷新仍记住）。
- **明确保留的核心原生行为**：状态点、悬停提示卡、行尾 `⋯` 菜单、点行打开、拖拽排序——插件一律不接管。窄栏（rail）不激活。
- **实现约束值得知道**：它读核心的 localStorage 视图状态 `dsh.workspace.view.v5` 判定是否激活，并会按「桶序 + updatedAt」重排官方行；核心「+新会话」复用空白旧会话的特例被单独处理（始终落在「今天」且桶内最新）。行身份按**核心实际渲染的文案**匹配（空白行=「新会话」、无标题行=「未命名」/`Untitled`、其余=标题），读不到标题的行只当空隙、不会把同一时间桶拆成两个同名组头。

### dsh-terminal-font — 侧边栏终端字体（修豆腐块）

- **为什么需要它**：核心把终端字体写死在 `ui-sidebar-terminal`（`fontFamily: 'ui-monospace, SFMono-Regular, Menlo, Consolas, monospace'` + `fontSize: 13`），本机实际落到 **Consolas**，而它的 cmap **没有 Nerd Font 私用区字形** ⇒ oh-my-posh 的 Powerline / 分支 / 锁图标全是方块。核心既无 `Config`、也无 CSS 变量可改。
- **插件怎么修**：向页面 `<head>` 注入两段 `@font-face`（`local()` 引用本机字体 + `size-adjust` 把 advance 精确归一到 `13px × 1126/2048 = 7.1474609375px`）与一条 `.xterm-rows / .xterm .composition-view` 字体栈规则。**xterm 用同一个 fontFamily 字符串既渲染又度量**，所以必须归一而不是简单换字体名 —— 否则列宽、竖线、光标全部错位；字体缺失时 @font-face 失效、回退 Consolas，逐像素等于没装。
- **何时生效**：Web 刷新页面；**桌面版必须重启 DSH Desktop**（桌面 host 只在 app ready 收集一次 `webserver/index-inject`）。
- **设置页**：设置 →「本地插件」→ tab「终端字体」（`settings.localPlugins.tab`，order 46）。诊断卡给「CSS 注入 / Nerd Font 字形 / 中文字体 / 终端字号 / 终端单元格宽度 / 终端字体栈」；设置卡写 profile 条目 `config:` 的 `enabled` / `monoFont` / `cjkFont` / `monoSizeAdjust` / `cjkSizeAdjust`（默认 `88.6781` / `109.9609`）。
- **没有字号输入框**：13px 是核心硬编码，xterm 的字符尺寸缓存也建立在同一个字号上；改 CSS `font-size` 会让 DOM 渲染与 xterm 的度量脱钩，而用 `size-adjust` 反向补偿又会把字形整体缩放回去、视觉等于没改 ⇒ 字号只读展示，可调的是 `size-adjust`。
- **已知限制**：Powerline / 方块字形上下各被裁约 1.5px（行高由字体包围盒锁定、写在行元素内联样式上）。

### ~~dsh-open-session-workdir — 打开会话工作目录~~（已退役 2026-09-18）

> **不要再启用它。** 它当年补的那个缺口，核心已经自己补上了：`@deepseek-ai/dsh-client-ui-open-in-app` 在会话头部 `conversation.session.header.utilities` 放了一枚「Open In…」分体按钮 —— 主按钮用**上次选过的应用**打开会话 `cwd`、右侧箭头列出宿主探测到的**全部已装应用**（Explorer / Git Bash / 编辑器 / 终端）。本插件源码、README、ACCEPTANCE 与测试全部保留在仓库里作参考，但 `dsh-plugin-manager` 的扫描会跳过它（`src/host-core.js` 的 `RETIRED_PLUGIN_DIRS`），因此它不再出现在「本地插件」面板、也无法再被激活。退役原因与实测证据见 [`docs/knowledge/2026-09-18-retire-open-session-workdir.md`](knowledge/2026-09-18-retire-open-session-workdir.md)。
>
> 下面几段是它退役前的行为记录，只作历史参考：

- **在哪**：会话头部那一行右侧图标排，只有图标（悬停「打开工作目录」）。不在左侧列表行上，也不在右侧文件面板里。
- **怎么用**：点一下 → 系统文件管理器打开该会话 `cwd`；成功 Toast「已交给系统打开」。
- **两个容易误判的点**：① 对**同一目录**再点一次，Windows 资源管理器会复用已有窗口，**不会新开**——所以文案变成「该目录已在文件管理器中打开」，这不是坏了；② 目录开在**宿主机器**上，不是浏览器所在机器（远程 Web UI 场景的常见困惑），失败卡片里始终备着完整路径 + 复制按钮。
- **失败时**：目录不可访问 / 宿主报错 / 8s 超时都会给锚定卡片说明原因。三条打开通道全不可用时按钮**仍然出现**并给出写明三个服务名的失败卡片——故意不做成不可见，好让故障能被发现了。
- **与 `dsh-better-sidebar` 可共存**：后者会把 `openWorkspacePath` 影子化（让文件链接开在它自己的侧边栏编辑器），本插件改走 `workspaces.openPath` 绕开，两者可同时启用。

### dsh-hindsight-model — Hindsight 模型面板

> **⛔ 已退役（2026-10-09）**：管理器面板不再列出它（`RETIRED_PLUGIN_DIRS`），desktop profile 里那一行已置 `disabled: true` ⇒ 面板与守护进程按需自动拉起都停了。源码与下面这节说明**原样保留**作参考；原因与恢复步骤见 [`knowledge/2026-10-09-retire-hindsight-model.md`](knowledge/2026-10-09-retire-hindsight-model.md)。

- **在哪**：设置页 →「Hindsight 模型」（夹在「本地插件」与「MCP」之间）。它是一个**诊断优先**的面板，不是一组开关。
- **四层是什么意思**：① `~/.hindsight/profiles/<profile>.env` 落盘值 ② 守护进程启动日志里它**真正读到**的 provider/model/endpoint ③ 会覆盖 ① 的外层值，**分两组**（用户级环境变量 / 宿主进程环境变量）④ 生效判据 = ①② 的三件套是否一致。
- **⚠️ 为什么 ③ 要分两组**：**用户级**（`HKCU\Environment`）本插件能一键清理（先导出备份）；**宿主进程**那层**清不掉**——它来自你启动 `dsh web` 的上层环境，面板只如实显示并保证自己给的重启命令做了净化。
- **怎么用**：`从 DSH 读取`（只预填表单、**不写盘**）→ 核对 → `保存`（行级改写 + 备份 + 原子写，留空即删除该键）→ 点 `重启`（或 `启动`/`停止`）→ 点 `验证`。
- **启停两半实现不同（重要）**：**启动**走官方 CLI，并把子进程环境净化（剔掉全部 profile 管理的键）——**这一步不能省**：上游 `cli.py` 载入 profile 时不覆盖已存在的键，不净化就会被外层变量写回覆盖。**停止不走官方 CLI**：`hindsight-embed daemon stop` 靠解码 `netstat` 找 PID，而 Windows 吐 cp936 字节 ⇒ `Could not find PID` 拒绝停止；关掉 Python 的 UTF-8 模式又会让它读自己那份 UTF-8 profile 时崩（gbk）——**开也错、关也错**。故停止改为：取监听端口 PID → 校验命令行含 `hindsight_api.main`/`--daemon`/端口匹配 → 才终止，保留上游「不向无法确认的进程发信号」的安全性质。`停止/重启` 需二次确认。
- **⚠️ 生效判据的一个坑**（真机实测后修订）：不能用「进程 StartTime > 文件 mtime」——上游启动路径**自己会回写**该文件，本机实测文件 `18:56:29` 晚于进程 `18:55:46` 而两者取值完全一致，只按时间判会对健康配置长期误报「尚未生效」。正确主判据是「文件三件套 vs 进程实际读到的三件套」。
- **密钥**：`api_key` 字段**只写不读回**，页面只显示长度；勾选「保存时使用 DSH 的密钥」后由宿主半解析并使用，**明文不出宿主进程**。
- **按需自动启动（默认开）**：会话开始时先探 `/health` —— 已经在跑就**采纳**（不重启、不写文件），没在跑才**后台冷启动**（约 44–73s，不阻塞会话；失败按 1/5/15/30 分钟退避）。开关是本插件 settings 键 `hindsight-model.autoStart`；宿主不提供会话事件时如实降级为仅手动。官方 `hindsight` 行的自动拉在本机不生效（`detectLlm()` 只看宿主 env，且它的启动器会闪一下控制台），所以这条现在归本插件。
- **启动前自愈 `pythonw.exe`**：启动前读 `<embed>\.venv\Scripts\pythonw.exe` 的可执行文件头；若是「会分配控制台」的形态，先备份原件到 `.venv` 之外、再换成同一发行版的无控制台版本，然后才启动（换没换都如实报告；取不到替代品或替换失败则**拒绝启动**）。
- **启动来源与窗口风险**：面板标注守护进程是 **自动 / 手动 / 外部 / 未知** 拉起的（判定只用监听进程与镜像路径，不写标记文件），镜像是控制台程序时同时标「有控制台窗口风险」。

### dsh-idle-hook — 空闲通知

- **入口**：设置页左侧一级导航「空闲通知」（`settings.section`，`order: 19`）。
- **触发点**（宿主半，页面关着也生效）：`session/event` 里的 `turn/end`（`completed`/`blocked`/`error`/`max-tokens`，以及除 `aborted:user`/`aborted:disposed` 外的 aborted；触发前延时复查 agent 空闲且 `inbox` 无排队输入）、`approval/request` 瀑布、`user-questions/request` 瀑布（后两者**只观察**：`{ prepend: true }` + 立即 `return next()` + 不 await 脚本）。**子代理会话静默**（按 `ctx.agents.roots()` 判定顶层会话）。
- **它做什么**：按你配置的规则执行本机脚本（`.py`→python3/python、`.bat`/`.cmd`→cmd /c、`.ps1`→powershell、`.sh`→bash、其它直接执行；参数数组直传默认不过 shell，可用占位符 `{sessionId}`/`{cwd}`/`{title}`/`{reason}`）；上下文走 stdin JSON（含会话标题）＋ ASCII 安全环境变量（`IDLE_HOOK_*`），**不含对话正文**。
- **节奏与失败**：边沿触发；同规则+同会话去抖 3s（可配）；同规则并发时跳过；超时 30s（可配）杀进程；连续失败 3 次自动停用并在面板标红，重新启用清零。
- **页面在场**：客户端每 5s 上报可见性/聚焦到 `/__idle-hook/presence`；30s 无心跳即判「页面关着」。规则的「触发前提」三档（任意 / 仅页面关着 / 仅不可见或失焦）就是靠它实现——**这是与 `dsh-notification`（浏览器原生通知、只在页面开着时响）分工互斥的开关**。
- **配置存放**：规则在 `<DSH_HOME 或 ~/.dsh>/settings.yaml` 的 `idle-hook:` 命名空间（`enabled` / `seeded` / `rules[]`，客户端经 `remote.settings` 整份写）；执行历史与运行状态落 `<DSH_HOME 或 ~/.dsh>/idle-hook-history.json`（滚动 200 条）。
- **环境变量（两层）**：设置页顶部「全局环境变量」框（所有规则共用）+ 每条规则表单里的「环境变量」框（同名覆盖全局）；表格形式（变量名 / 值两列，可增可删），值支持 `{cwd}` 等占位符，`IDLE_HOOK_*` 由插件注入、不可覆盖（仅提示）。文本格式：值明文落在 `<DSH_HOME 或 ~/.dsh>/settings.yaml`，执行历史只记变量名不记值。
- **示例脚本**：通用渠道在 `examples/`（本机通知、Bark/ntfy、Webhook、路由器）；**内网接口**的三个（POPO / 邮件 / 二合一）放在 `examples/private/` —— 该目录被 `.gitignore` 忽略（`**/examples/private/`），刻意不入库，你自己不想提交的脚本也放这儿。
- **端点**：`/__idle-hook/{status,presence,history,clear-history,test-run,reset-rule}`。
- **副作用**：以 DSH 进程身份执行你配置的本地进程（**不经** DSH 的 sandbox 策略）；不注册任何面向模型的工具。

### dsh-agent-preset-manager — 本地 agent preset

- **入口**：设置 →「本地插件」→ tab **「Agent 预设」**（`settings.localPlugins.tab`，id `agent-presets`，order 20）。
- **它补的是哪个缺口**：0.2.0 线把 agent preset 改成 **bundle 形态加载**，本地目录（`~/.dsh/agent-presets/`，以及 0.2.0 之前的 `~/.dsh/.agent-presets/`）不再被自动读取。本插件把这两个目录里的 preset **运行期声明**进宿主注册表（`agentPresets`），**不改写** profile 的 `cordis.patch.yml`——那份文件由「本地插件」面板独占维护，且每次写入都会让核心整树重应用、独占宿主事件循环约 1 秒。
- **能做什么**：每个预设一张卡（名称 / id / 来源库 / 行数 / 体检结论）+ 一个启用开关；组合原文（`agent.cordis.yml`）可就地编辑保存；可新增（用内置 standard 预设的插件行清单播种）、删除（二次确认）、从任意目录导入（先预检再确认）、把旧目录整体迁移到新目录（**复制**，原目录保留）。
- **两库优先关系**：同名 id 时**旧目录优先**（面板标「旧目录优先：…」），迁移因此只复制不删除。
- **写盘纪律**：保存组合前先备份（`<预设>/.backup/` 保留 3 份）再原子写；文本为空 / YAML 解析失败 / 行 id 重复一律**拒绝且一个字节都不写**。
- **降级**：宿主没有 `agentPresets` 注册表服务（老核心）→ 面板只读（能看能编辑，开关禁用并写明原因）；没有 `webServer` → 宿主半静默不挂端点，不抛错。
- **端点**：`GET /__dsh-agent-presets/state`、`GET /__dsh-agent-presets/file?id=`，以及 `POST /__dsh-agent-presets/{set-enabled,create,save,remove,import,migrate}`。失败时 HTTP 400，但响应体里始终有 `{ ok:false, error, state }`——面板读 body 而不是只看 status。
- **注意**：启用/停用**立即**作用于宿主；但已启用预设的**组合改动不会热重载**（面板提示关掉再开）。

## UI 触点分布（核对过的槽位与 order）

同一槽位内按 `order` 升序排列；不同插件的 order **互不相同**，所以启用任意组合都不会互相遮蔽。

| 触点位置（槽位） | 插件行（order） |
|---|---|
| composer 覆盖层 `conversation.input.overlay` | `dsh-composer-history-recall`（50）· `dsh-esc-rewind`（60） |
| composer 右侧组 `conversation.input.right` | `dsh-composer-provider-label`（10，紧邻核心模型选择器左侧） |
| 会话头操作区 `conversation.session.header.actions` | `dsh-session-title-regenerate`（27）· `dsh-esc-rewind` 处置开关（28）；核心自身另有 日程(10)/任务(20)/删除(30)。~~`dsh-open-session-workdir`（25）~~ 已于 2026-09-18 退役 |
| 设置页 `settings.section` | `dsh-plugin-manager`「本地插件」（16）——本仓**唯一**的一条导航行，其余插件不再各占一行 |
| 「本地插件」页内的 tab `settings.localPlugins.tab` | `dsh-plugin-manager`（`plugins` 0）· `dsh-agent-preset-manager`「Agent 预设」（`agent-presets` 20）· `dsh-idle-hook`（`idle-hook` 40）· `dsh-esc-rewind`「子代理」（`subagents` 50） |
| 斜杠命令 | `/rewind`（客户端 `commandUi` 贡献）· `/regenerate-title`（宿主命令） |
| 侧栏会话行 `⋯` 菜单 | `dsh-session-title-regenerate`（DOM 注入，核心无插件槽） |
| 侧栏会话列表 | `dsh-session-time-bucket`（就地注入组头 + `[工作区]` 前缀，非槽位） |
| 宿主 HTTP | `/__dsh-plugin-manager/{status,list,set-enabled,set-all-enabled,remove,migrate}` · `/__esc-rewind/{status,session/delete}` · `/__idle-hook/{status,presence,history,clear-history,test-run,reset-rule}` · `/__dsh-agent-presets/{state,file,set-enabled,create,save,remove,import,migrate}` |

> `/__hindsight-model/*` 与「本地插件」页里的 `hindsight-model` tab 随 2026-10-09 退役一并消失（源码保留在仓库）。

> ⚠️ 会话头图标排现在只剩**两个**插件行（27/28，`dsh-open-session-workdir` 的 25 已随插件退役）：`dsh-session-title-regenerate` 与 `dsh-esc-rewind`。核心自身另有 日程(10)/任务(20)/删除(30)，以及**另一枚分体按钮**「Open In…」——它不在 `actions` 槽，而在 `conversation.session.header.utilities`。

## 核对方法（本页怎么保证不是抄来的假信息）

本仓库有过「文档声称存在、实际文件不存在」的事故（见 `docs/knowledge/2026-09-11-install-via-git-url.md`），所以整理时**没有信任旧 README**，而是：

1. 把每个 `.md` 里的 `node <path>` / `node --check <path>` 命令逐条拿去查文件是否存在 → 抓出 6 处**子插件迁进 `sub-plugins/` 之前的旧扁平路径**（已修）。
2. 扫每个 `src/client.js` 的 `slots.register` 与顶部常量，取真实 `SLOT`/`ROW_ID`/`ROW_ORDER` → 与文档逐条比对，抓出 `dsh-open-session-workdir` 会话头顺序描述不完整。
3. 扫宿主半的 `HTTP_PREFIX`/`SETTINGS_FIELD`/`DELETE_PATH`/`STATUS_PATH` 与 `DEFAULTS` 键名 → 补上 `dsh-esc-rewind` 未记载的只读端点 `/__esc-rewind/status`。
4. 抽查只有纯客户端半的插件（`history-recall`、`time-bucket`）宿主入口确实为 0，「不含宿主端点」的说法成立。
