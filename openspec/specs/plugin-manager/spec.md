# plugin-manager Specification

> ### ⚠️ 2026-10-09 变更（A15）：依赖声明改用 pnpm workspace 协议
>
> 自本日起，下文所有「在 profile devDependencies 写入 `link:<子插件的绝对目录>`」一律按下述读：
> 写入的是 **`"<name>": "workspace:*"`（不含任何路径）**；可解析性由 profile 的 `pnpm-workspace.yaml` 里
> **唯一一条**指向本仓库插件目录的 glob（`<repo>/sub-plugins/*`）提供，该 glob 由管理器自动维护与自愈
> （`workspaceStateOf()` / `upsertWorkspaceGlob()`，幂等：已就位时零写入）。
>
> 连带变化（逐条规格文本随下一次 openspec 归档一并更新）：
>
> - 状态词表：`fresh` = 规格是 `workspace:` 协议 **且** 锚点放行本仓库；`stale-mismatch` = 规格不是 `workspace:`（遗留 `link:` / 版本号 / `file:`）；
>   `stale-target-missing` = 规格对但**锚点缺失或指向旧位置**；`stale-unresolved` = 仓库里连插件目录都不存在；`unknown` = IO 失败。
> - 函数改名：`linkStateOf → depStateOf`、`staleLinkSpec → staleDepSpec`、`relinkPlan → repairPlan`、`LINK_STATES → DEP_STATES`、`LINK_IO → FS_IO`；
>   派生字段 `linkState/linkDeclared/linkExpected → depState/depDeclared/depExpected`。
> - 新增：`WORKSPACE_FILE`、`WORKSPACE_PROTOCOL`、`WORKSPACE_SPEC`（`workspace:*`）、`isWorkspaceSpec`、`workspaceDepSpec`、`pluginsGlobOf`、`workspaceGlobCandidates`、`isPluginGlobShape`。
> - 卸载范围：受管依赖键按**包名**识别（`workspace:*` 不含路径），并额外摘掉 `pnpm-workspace.yaml` 里本仓库那条 glob。
> - 面板与端点：「重定位」→「修复依赖」、`POST /__dsh-plugin-manager/relink` → `/repair`（前者保留为别名）、`/list` 的 `linkPlan` → `repairPlan`。
> - 管理器自身那条 `link:<repo>` 属于**安装入口**（由 `dsh plugin add` 写入），管理器不自行改写它。


## Purpose
在 DSH Web 设置页提供一个「本地插件」面板，让用户只安装 `dsh-plugin-manager` 一个插件即可管理本仓库（monorepo）内全部 `dsh-*` 子插件在 web profile 中的激活状态：列出子包与各自状态、一键激活/停用/移除、缺失依赖时自动安装、以及把旧的「逐个 dependencies+bundles」布局一键迁移为新模型。
## Requirements
### Requirement: 面板列出仓库子插件并推导状态

系统 SHALL 在设置页新增一级入口「本地插件」，列出管理器所在仓库的**子插件根**下的每一个 `dsh-*` 子包（排除管理器自身），并为每个子包显示：包名、目录名、`package.json` 描述，以及推导出的状态之一——`已激活`（profile 激活清单中存在且未 disabled，且包已在 profile 中可解析）、`已停用`（清单中存在但 disabled）、`未安装`（包未在 profile 依赖中，无法解析）、`非插件目录`（缺少有效插件 `package.json`）。扫描到的新子包（从未激活过）MUST 以「未安装/未激活」状态出现并可被用户激活。

子插件根 SHALL 依次取「仓库根下的 `sub-plugins/`（存在时）」与「仓库根自身（旧扁平布局）」两处，扫描结果 MUST NOT 因同名目录出现两行；同名时以 `sub-plugins/` 下的副本为准。面板头部 SHALL 显示仓库路径，并在子插件目录与仓库路径不同时同时显示子插件目录。

#### Scenario: 打开设置「本地插件」看到全部子包

- **WHEN** 用户安装管理器后打开设置页的「本地插件」入口，子插件根存在多个 `dsh-*` 子包
- **THEN** 面板列出全部子包（不含管理器自身），每个显示包名、目录名、描述与当前状态，状态与 profile 实际激活情况一致

#### Scenario: 子包位于 sub-plugins 子目录

- **WHEN** 子包位于 `<仓库>/sub-plugins/dsh-xxx`，仓库根没有同名的 `dsh-xxx`
- **THEN** 面板列出该子包，其目录信息指向 `sub-plugins/dsh-xxx`，状态推导与它位于仓库根时一致

#### Scenario: 半迁移仓库（部分子包仍在仓库根）

- **WHEN** 仓库中一部分子包已移动到 `sub-plugins/`，另一部分仍在仓库根
- **THEN** 面板同时列出两处的子包且状态正确，不因布局混合而漏项或报错

#### Scenario: 同名目录两处都存在

- **WHEN** `<仓库>/dsh-xxx` 与 `<仓库>/sub-plugins/dsh-xxx` 同时存在
- **THEN** 面板只列出一行，且该行指向 `sub-plugins/dsh-xxx`（嵌套副本优先）

#### Scenario: 从未安装过的子包显示为未激活

- **WHEN** 子插件根存在一个尚未被激活的 `dsh-*` 子包（不在 profile 依赖、激活清单无其行）
- **THEN** 面板将其显示为「未激活/未安装」并提供可用的「启用」操作

#### Scenario: 非插件目录被识别

- **WHEN** 子插件根存在名为 `dsh-*` 但缺少有效插件 `package.json` 的目录
- **THEN** 面板将其显示为「非插件目录」，不提供激活操作且不报错中断

#### Scenario: 管理器自身不列入

- **WHEN** 面板扫描子插件根
- **THEN** 管理器自己的目录 `dsh-plugin-manager` 不作为一个可管理的子插件出现

### Requirement: 主开关激活/停用子插件并持久化

系统 SHALL 为每个可管理子插件提供主开关：停用 = 在其激活行上写 `disabled`（保留行与现场，可再启用）；启用 = 移除 `disabled` 并确保行存在。激活状态 MUST 持久化为 profile `cordis.patch.yml` 中由管理器维护的行（稳定 id、`name`=子插件包名），DSH 对 profile patch 的实时热重载 MUST 让宿主侧即时启停；对带浏览器客户端 UI 的子插件，界面侧 MUST 经一次页面刷新进入/离开引导图。管理器 MUST 不触碰 `dsh-mcp-manager` 等其它插件的行。对主开关请求的持久化 SHALL 在短窗口内合并（见「开关写入合并与重应用可见性」）：面板 MUST 在用户点击后立即按目标状态呈现该行，而行的落盘可以在合并窗口后完成。

#### Scenario: 停用已激活子插件

- **WHEN** 用户关闭某已激活子插件的主开关
- **THEN** 其激活行被写入 `disabled`，宿主行为实时停止；再次打开面板时状态为「已停用」，行与包依赖保留

#### Scenario: 重新启用已停用子插件

- **WHEN** 用户重新打开某已停用子插件的主开关
- **THEN** 其行的 `disabled` 被移除，宿主行为恢复；无需重装依赖

#### Scenario: 状态在重启后保持

- **WHEN** 用户停用某子插件后重启 DSH
- **THEN** 该子插件仍处于停用状态（面板与行为一致）

#### Scenario: 不动其它插件的行

- **WHEN** profile `cordis.patch.yml` 中已有 `dsh-mcp-manager` 等其它插件维护的行，用户对某个本地子插件执行开关
- **THEN** 其它行原样保留、内容不被破坏或改写

#### Scenario: 开关目标状态立即呈现

- **WHEN** 用户点击某子插件的主开关
- **THEN** 该行在他看到响应时已经处于目标状态（面板不显示中间态等待落盘），行的落盘可在其后完成

### Requirement: 启用缺失依赖的子插件时自动安装

系统 SHALL 在用户启用一个子插件时（单行「开启」与批量「全部开启」使用同一实现），先确保该包已可解析：需要时在目标 profile 目录写入 devDependency `link:<子插件实际所在绝对目录>`（仅加 devDependency，不加进 `dsh.profile.bundles`），并在需要时执行 `pnpm install`，安装成功后再写入激活行。**判定必须区分"键在不在"与"指向对不对"**：当 devDependency 已存在但 `link:` 指向的不是该子插件当前所在目录（目录已被移动、换机器/换 profile、安装入口变更等）时，系统 SHALL 把它视为需要修复并改写为当前目录，MUST NOT 因为"键已存在"而跳过修复、MUST NOT 直接信任旧路径。只有"键存在且指向当前实际目录"时才可以不写文件、不跑安装。安装或写行失败时，MUST NOT 出现“看似已启用”的半状态：面板给出可理解的错误并可重试，子插件保持原状态，profile `package.json` 由备份回滚。

#### Scenario: 启用未安装子插件自动装依赖

- **WHEN** 子插件根有一个从未安装的子插件，用户点击启用
- **THEN** 管理器自动将其加入 profile devDependencies 并安装，随后写入激活行，插件变为「已激活」

#### Scenario: 陈旧链接在启用时被修复

- **WHEN** profile devDependencies 中该子插件的 `link:` 指向旧目录（如移动前的仓库根路径），用户点击启用
- **THEN** 管理器把该 `link:` 改写为子插件当前所在目录并执行安装，随后写入激活行，插件变为「已激活」

#### Scenario: 陈旧链接在「全部开启」时也被修复

- **WHEN** 多个子插件的 `link:` 都已陈旧，用户点击「全部开启」
- **THEN** 管理器把它们的 `link:` 一次性全部改写为各自当前目录，只执行**一次** `pnpm install`，随后写入激活行

#### Scenario: 链接已正确时不写文件不安装

- **WHEN** devDependency 已存在且 `link:` 正指向该子插件当前所在目录，用户点击启用
- **THEN** 管理器不写 `package.json`、不跑 `pnpm install`，只写激活行

#### Scenario: 安装失败不产生半状态

- **WHEN** 对未安装子插件执行启用，但安装失败（如网络/磁盘/路径错误）
- **THEN** 面板显示失败错误卡片，子插件状态不变（仍可重试或取消），激活清单不被写入，profile `package.json` 回到改动前

#### Scenario: 安装不改变 bundles 列表

- **WHEN** 管理器为某子插件执行自动安装后运行 `dsh plugin --profile web install`（或其它 reconcile 触发）
- **THEN** `dsh.profile.bundles` 中本地插件仍只有管理器一个条目，子插件不会被重新塞进 bundles

### Requirement: 移除子插件

系统 SHALL 为已管理的子插件提供次操作「移除」：删除其激活行并从 profile devDependencies 摘除该 `link:` 依赖（需要时执行移除安装）；移除后子插件回到「未激活/未安装」状态，后续可重新启用。

#### Scenario: 移除已激活子插件

- **WHEN** 用户对某已激活子插件执行移除
- **THEN** 其激活行被删除、devDependencies 中对应 `link:` 被摘除，插件不再加载；面板显示为未激活

#### Scenario: 移除后重新启用

- **WHEN** 某子插件被移除后，用户在面板再次启用它
- **THEN** 管理器重新安装依赖并写入激活行，行为与首次启用一致

### Requirement: 一键迁移旧布局

系统 SHALL 检测子插件仍以旧布局存在的情形：本地子插件列在 profile `dependencies` 且各自出现在 `dsh.profile.bundles`。此时面板 MUST 提供「一键接管/迁移」操作：把本地子插件从 `dependencies` 移到 `devDependencies`（保留 `link:` 与安装）、把 `dsh.profile.bundles` 的本地条目收敛为仅管理器、并按迁移前的实际激活状态（各 bundle 行是否 disabled/存在）补齐管理器维护的激活行，使迁移前后用户可见的激活集合不变。迁移须先备份 profile `package.json` 与 `cordis.patch.yml` 以便回滚。

#### Scenario: 检测到旧布局时给出迁移按钮

- **WHEN** profile 中本地子插件仍以 `dependencies` + 各自 `dsh.profile.bundles` 条目存在
- **THEN** 面板出现「一键接管/迁移」提示与按钮；迁移前不擅自改写 profile

#### Scenario: 迁移后激活集合不变

- **WHEN** 用户执行一键迁移，迁移前有 5 个子插件激活、1 个停用
- **THEN** 迁移后 `dsh.profile.bundles` 只剩管理器，5 个仍激活（以管理器维护行存在且未 disabled）、1 个仍停用，devDependencies 含全部本地子插件

#### Scenario: 迁移失败可回滚

- **WHEN** 迁移中途失败（如 pnpm 安装失败）
- **THEN** profile 的 `package.json`/`cordis.patch.yml` 可由管理器留下的备份恢复，迁移不产生半状态，面板给出错误

### Requirement: 设置入口与生效模型

系统 SHALL 在设置页左侧拥有**一个自有的一级入口「本地插件」**（注册 `settings.section`：id `local-plugins`，order 16，label「本地插件」），并由该入口**声明子槽 `settings.localPlugins.tab`（list）与渲染 tab chrome**；管理器自己的管理面板 MUST 是该入口内的一个 tab（id `plugins`，order 0），本仓库其它插件的设置面板 MUST 作为同一入口内的其它 tab 出现——设置左侧导航里本仓插件 MUST NOT 再各占一行，也 MUST NOT 把本仓内容混进核心「插件」页。面板 SHALL 展示目标 profile 名与仓库路径；tab 栏 SHALL 与核心「插件」页同款（当前 tab 有下划线指示，首次选中的 tab 挂载后保持挂载以便切换不丢本地草稿）。开关/移除/迁移后：宿主侧行为经 profile patch 热重载实时生效；对带浏览器客户端 UI 的子插件，MUST 提示「刷新页面使界面生效」并提供刷新按钮，MUST NOT 自动刷新页面。目标 profile 默认取当前 GUI 运行的 web profile，且 SHOULD 允许通过设置覆盖；目录定位优先用管理器自身所在目录的上一级，找不到时 MUST 给出可读错误而非静默空列表。当运行的核心没有声明 `settings.localPlugins.tab` 槽时，注册 MUST 被跳过且 MUST NOT 抛出未捕获错误。

#### Scenario: 入口出现在设置左侧导航

- **WHEN** 用户打开设置页
- **THEN** 左侧导航出现**「本地插件」一级入口**（核心「插件」入口保持原样）；进入后 tab 列表里第一个 tab 就是管理面板，点开即渲染；管理器不再占用其它导航行

#### Scenario: 客户端插件开关后提示手动刷新

- **WHEN** 用户启用或停用某个带客户端 UI 的子插件
- **THEN** 宿主行为即时变化，同时面板提示需要刷新页面使该插件的界面生效，并提供刷新按钮；页面不会被自动刷新

#### Scenario: 仓库目录不可达时给出错误

- **WHEN** 管理器无法定位/读取其所在仓库根（目录被移动或权限不足）
- **THEN** 面板显示可读错误与目标路径，而不是空白列表或崩溃

#### Scenario: 核心没有插件页 tab 槽时降级

- **WHEN** 运行的核心未声明 `settings.localPlugins.tab`（旧核心）
- **THEN** 注册被跳过、不产生未捕获错误，管理器的宿主侧能力与其它插件不受影响

### Requirement: 子插件目录布局与行 id 稳定性

系统 SHALL 支持把子插件包放在仓库根或 `sub-plugins/` 子目录下，且两种布局下同一子插件的**激活行 id 保持不变**（行 id = 目录名去掉 `dsh-` 前缀，与目录所在层级无关）。因此在布局迁移前后，profile `cordis.patch.yml` 中既有的行、`disabled` 状态与用户覆盖 MUST 继续保持有效，无需改写行 id。

#### Scenario: 迁移布局不改变行 id

- **WHEN** 某个子插件从仓库根移动到 `sub-plugins/`（或反向移动）
- **THEN** 它在 profile 激活清单中的行 id、`disabled` 状态与所在条件保持不变，不需要新增/重命名任何行

#### Scenario: 迁移可任意顺序完成

- **WHEN** 先更新管理器代码再移动目录，或先移动目录再更新代码
- **THEN** 两种顺序下管理器都能枚举到同一组子插件（双根并集），不出现“子插件全部消失”的中间态

#### Scenario: 目录移回即可回滚

- **WHEN** 用户把 `sub-plugins/` 下的子包移回仓库根
- **THEN** 管理器仍能枚举它们，行 id 与状态不变，无需改代码或改 profile 行

### Requirement: 开关写入合并与重应用可见性

系统 SHALL 把短时间内的多次主开关请求合并为一次 profile `cordis.patch.yml` 写入（默认 400 ms 合并窗口），使 N 次点击最多只触发一次 DSH 核心的配置重应用；窗口内对同一行的再次请求 SHALL 覆盖该行的待写意图，MUST NOT 产生多次写入。合并后的落盘 SHALL 以磁盘当前内容为基础再套用待写意图，MUST NOT 用陈旧副本覆盖其它写入者的改动。`/__dsh-plugin-manager/status` SHALL 暴露未落盘的待写数量，面板 SHALL 在「仍有未落盘变更」或「宿主未恢复响应」期间显示「正在应用」提示，并在两者都消解后自动撤下，MUST NOT 要求用户手动刷新。合并落盘失败时系统 MUST 让失败可见（面板提示与诊断字段），并使后续列表以磁盘真实状态为准，MUST NOT 静默丢弃意图。宿主进程正常退出时，仍待写的意图 SHALL 被尽力落盘。

#### Scenario: 连点多个开关只写一次文件

- **WHEN** 用户在合并窗口内对两个不同子插件各发出一次开关请求
- **THEN** profile `cordis.patch.yml` 只被写入一次，DSH 核心只发生一次配置重应用，两行最终都等于用户的目标状态

#### Scenario: 同一行重复点击合并为一次写入

- **WHEN** 用户在合并窗口内对同一子插件连续切换两次（例如关再开）
- **THEN** 只有最后一次的目标状态被写入，文件不出现该行的中间状态

#### Scenario: 面板显示正在应用并在宿主恢复后自动消失

- **WHEN** 用户点击开关，落盘与随后的核心配置重应用开始
- **THEN** 面板显示「正在应用」提示；当待写数量归零且宿主恢复响应后，提示自动撤下，无需用户操作

#### Scenario: 合并窗口内仍可继续操作

- **WHEN** 面板正在显示「正在应用」，用户去点另一个子插件的开关
- **THEN** 该操作被接受并并入同一次待写意图（不因提示而被拒绝），且不额外增加一次核心配置重应用

#### Scenario: 落盘失败不静默

- **WHEN** 合并后的写入失败（例如 patch 文件不可写）
- **THEN** 面板显示错误，诊断字段记录失败原因，后续列表返回磁盘上的真实状态（不呈现「看似已生效」的假状态）

#### Scenario: 退出时尽力落盘

- **WHEN** 宿主进程在合并窗口尚未结束时正常退出
- **THEN** 尚未落盘的意图被尽力写入 patch 文件；无法写入时保留磁盘原状，不产生半个文件或损坏的 YAML

### Requirement: 本地插件不提供 bundle 安装路径

本仓库 MUST NOT 为本地子插件提供 bundle 层：`sub-plugins/` 下每个子插件的 `package.json` MUST NOT 声明 `dsh.bundle`，目录内 MUST NOT 存在包自带的 `cordis.patch.yml`。仓库根 MUST NOT 提供聚合伞包清单，也 MUST NOT 存在根 `cordis.patch.yml`；仓库根**唯一允许**的清单是管理器的**安装外壳**（见下一条 Requirement），该外壳 MUST NOT 列出任何子插件依赖或子插件激活行。据此，`dsh plugin --profile <name> add <子插件目录>` 这一路径 MUST NOT 让子插件进入 `dsh.profile.bundles`、MUST NOT 产生与管理器激活行重复的 loader entry id（否则 `dsh web` 启动会因 `duplicate loader entry id` 直接失败）；该路径的可见后果 SHALL 限于"装成普通 profile 依赖 + 打印 `declares no dsh.bundle` 警告 + 不激活"，且 MUST 不影响已有激活行，管理器 SHALL 仍能在启用时接管该包（把同名依赖改写为 `devDependencies` 的 `link:`）。卸载子插件的唯一受支持路径 SHALL 是管理器面板的「移除」；文档 MUST 明确警示 `dsh plugin --profile <name> remove <子插件包名>` 只摘依赖而不删管理器写的激活行，会留下指向不存在包的悬空行并使下次启动失败（`failed to import loader entry <id> (<name>): Cannot find package …`）。

#### Scenario: 子插件包不自带 bundle 层

- **WHEN** 检查 `sub-plugins/` 下每个子插件的 manifest 与目录内容
- **THEN** 没有任何 manifest 声明 `dsh.bundle`，目录内也不存在包自带的 `cordis.patch.yml`

#### Scenario: 仓库根不再提供聚合伞包

- **WHEN** 检查仓库根的清单内容
- **THEN** 根 `cordis.patch.yml` 不存在，根 `package.json`（若有）只是管理器安装外壳：不列子插件依赖、不列子插件激活行、`dsh.profile.bundles` 不由它提供，`dsh-local-plugins` 不再是一个可被 `dsh plugin add` 装进 profile 的包

#### Scenario: CLI 误装只装成普通依赖且不激活

- **WHEN** 在某个 profile 上执行 `dsh plugin --profile <name> add <某子插件目录>`
- **THEN** 该包进入 profile `dependencies` 而**不进入** `dsh.profile.bundles`，CLI 打印 `declares no dsh.bundle — installed as a plain dependency, not a profile layer` 警告，管理器维护的激活行数量与内容不变，且该 profile 仍能正常启动（不出现 `duplicate loader entry id`）

#### Scenario: 卸载路径唯一且在文档中被明确警示

- **WHEN** 用户想卸载某个子插件
- **THEN** 文档指示的唯一路径是管理器面板「移除」（删激活行 + 摘依赖，仓库源码目录保留）；同时明确写出用 `dsh plugin --profile <name> remove <子插件包名>` 的后果是留下悬空激活行、导致下次启动报 `failed to import loader entry …: Cannot find package …`

### Requirement: 仓库根安装外壳让 git 地址可直接安装

仓库 MUST 能被 `dsh plugin --profile <name> add <git 地址>`（`git+https://`、`github:` 简写、`git+ssh://`）与 `add <仓库根路径>` 两种入口安装，且安装后的插件身份 MUST 是 `dsh-plugin-manager`。为此仓库根 MUST 提供一个**安装外壳** `package.json`，且 MUST 满足：`name` = `dsh-plugin-manager`（pnpm 安装 git 依赖时把 clone 的**根目录当作包**，包名即 profile `dependencies` 键、bundle 层名、激活行 id 与浏览器模块表 id）；`private: true`；`type: module`；`main` 与 `exports["."]` 指向 `dsh-plugin-manager/src/index.js`；`exports["./client"]` 指向 `dsh-plugin-manager/src/client.js`；`dsh.client` 与包内清单逐字段一致；`dsh.bundle.patch` 指向 `dsh-plugin-manager/cordis.patch.yml`。外壳 MUST NOT 声明任何 `dependencies`/`devDependencies`/`optionalDependencies`，MUST NOT 设 `files` 白名单（那会把 `sub-plugins/` 从安装内容里裁掉），MUST NOT 自带激活行。这些约束 MUST 由 `dsh-plugin-manager/test/root-install-shell.test.mjs` 强制。

安装后的 clone MUST 保持管理器现有的仓库定位方式可用：宿主半从 `<安装目录>/dsh-plugin-manager/src` 反推出的仓库根即该安装目录，扫描到的子插件集合与直接在仓库里跑时一致；用户在面板启用某个子插件时，管理器写入的 `link:` 指向 clone 内的子插件目录且 MUST 能被 profile 解析。

文档 MUST 写明 git 安装得到的是**快照而非活链接**（改仓库源码不即时生效，升级走 `dsh plugin --profile <name> update`），以及缺少该外壳时的真实后果（包名退化为仓库目录名、被判成普通依赖、永不激活）。

#### Scenario: 用 git 地址安装后插件名是 dsh-plugin-manager

- **WHEN** 在一个干净 profile 上执行 `dsh plugin --profile <name> add git+https://…/dsh-plugins.git`
- **THEN** profile `dependencies` 只多出 `dsh-plugin-manager` 一个键（值是该 git 地址），`dsh.profile.bundles` 只多出 `dsh-plugin-manager` 一层，启动组合出 `- id: dsh-plugin-manager`，且不出现 `duplicate loader entry id`

#### Scenario: 换安装入口不产生第二个 bundle 层

- **WHEN** profile 已用 `link:`（或仓库根路径）装了管理器，用户改用 git 地址再 `add` 一次
- **THEN** 同一个 `dsh-plugin-manager` 依赖键被改写为新地址，`dsh.profile.bundles` 仍只有一个 `dsh-plugin-manager` 条目，激活行数量不变

#### Scenario: 从 git 装的 clone 仍能管理其子插件

- **WHEN** 通过 git 地址装好管理器后，用户在面板启用某个子插件
- **THEN** 管理器把指向 clone 内 `sub-plugins/<pkg>` 的 `link:` 写进 profile `devDependencies` 并完成安装，该子插件变为「已激活」，profile 能解析到它的入口

#### Scenario: 外壳被改动时测试判红

- **WHEN** 有人改掉外壳的 `name`、删掉某个转发（`main`/`exports`/`dsh.client`/`dsh.bundle.patch`）、给它加依赖、加 `files` 白名单，或在仓库根新增 `cordis.patch.yml`
- **THEN** `dsh-plugin-manager/test/root-install-shell.test.mjs` 失败

### Requirement: 批量全部开启 / 全部关闭的作用范围与计数口径

面板 SHALL 提供两个批量动作「全部开启」与「全部关闭」，每个按钮 SHALL 显示本步可作用数量 N（例如「全部关闭 (6)」），N 为 **0** 时该按钮 MUST 置灰不可点。批量的作用域 MUST 限于面板列出的受管仓库子插件（管理器自身除外），MUST NOT 改动 profile 激活清单中其它插件的行（如 `mcp-*`、其它非本仓库插件）。

批量目标按子插件状态收敛：

- **全部开启** SHALL 作用于 `已停用`（去掉行内 `disabled`）与 `未安装`（补 `link:` devDependency、装依赖、写激活行）；MUST 跳过 `已激活`、`未激活(仅依赖)`、`旧布局`、`非插件目录`。
- **全部关闭** SHALL 作用于 `已激活`（写 `disabled: true`，保留行与依赖）；MUST 跳过 `已停用`、`未激活(仅依赖)`、`未安装`、`旧布局`、`非插件目录`——系统 MUST NOT 为从未启用过的子插件新增激活行。

N SHALL 等于上述「真能改动」的项数：`全部开启` 的 N = 已停用 + 未安装；`全部关闭` 的 N = 已激活。被跳过的项（`未激活(仅依赖)`、`旧布局`、`非插件目录`）MUST NOT 计入 N，且当存在 `旧布局` 项时面板 MUST 提示用户先执行「一键接管/迁移」。

#### Scenario: 全部关闭停用所有已激活子插件

- **WHEN** 面板列出 6 个全部 `已激活` 的子插件，用户点「全部关闭」并确认
- **THEN** 6 个子插件的激活行都被写入 `disabled: true`（行与 devDependency 保留），宿主行为全部停止，面板显示全部「已停用」

#### Scenario: 全部开启补齐已停用与未安装

- **WHEN** 面板现状为 3 个已停用、1 个从未安装、2 个已激活，用户点「全部开启」并确认
- **THEN** 3 个已停用的行去掉 `disabled`、1 个未安装的补上 devDependency 与激活行、2 个已激活的不变，最终全部为「已激活」

#### Scenario: 未激活(仅依赖)在批量中被跳过

- **WHEN** 某子插件已装为 profile `devDependencies` 但没有激活行（面板显示「未激活(仅依赖)」），用户执行「全部开启」或「全部关闭」
- **THEN** 该子插件状态不变（不新增行、不写 `disabled`），也不计入按钮的可作用数量 N

#### Scenario: 非插件目录不计入数量

- **WHEN** 受管目录中存在缺少有效插件 `package.json` 的 `dsh-*` 目录
- **THEN** 它不计入两个批量按钮的 N，批量执行不影响它，也不报错中断整批

#### Scenario: 不触碰其它插件的行

- **WHEN** profile 激活清单中另有 `mcp-*`、其它非本仓库插件等行，用户执行任意批量动作
- **THEN** 这些行的内容与顺序原样保留，仅受管子插件的行被改写，且 `dsh.profile.bundles` 不被改动

### Requirement: 批量执行一次落盘、一次安装

一次批量动作 SHALL 至多产生一次 profile `cordis.patch.yml` 写入（因而至多一次 DSH 核心配置重应用），MUST NOT 按项各写一次；当批量需要为多个 `未安装` 子插件补依赖时 SHALL 先把全部缺失的 `link:` devDependency 写齐，再执行**一次** `pnpm install`，MUST NOT 逐项安装。批量开始前系统 SHALL 接管仍在合并窗口中的单行开关意图，把它们与批量目标合并进**同一次** `cordis.patch.yml` 写入（既不静默丢弃先前的点击，也不额外产生第二次写入），并基于「这些意图已生效」的状态计算批量目标。

#### Scenario: N 项批量只写一次文件

- **WHEN** 用户点击「全部关闭」，受影响子插件为 N 个
- **THEN** profile `cordis.patch.yml` 只被写入一次，所有 N 行在同一次写入中落盘，DSH 核心只发生一次配置重应用

#### Scenario: 多个未安装项一次安装

- **WHEN** 「全部开启」遇到 3 个未安装的子插件
- **THEN** 管理器一次写齐 3 个 `link:` devDependency 后执行一次 `pnpm install`，成功则 3 个都被激活；MUST NOT 执行 3 次安装

#### Scenario: 排队中的单行意图先被兑现

- **WHEN** 用户刚点了某行开关（意图仍在 400 ms 合并窗口中），随即点击「全部关闭」
- **THEN** 该排队意图与批量目标落在同一次文件写入里（不额外多写一次），批量按「该意图已生效」的状态计算，最终状态等于「批量关闭」的语义，不出现被吞掉的中间态

### Requirement: 批量失败逐项回报且不产生半状态

批量执行 SHALL 采用尽力而为语义：能改动的项照常落盘，失败项 MUST 保持原状态（不出现「看似已启用/已停用」的假状态），并在响应中逐项给出结果与原因，面板 MUST 把这些失败项逐条呈现给用户以便重试。批量中的依赖安装失败 MUST NOT 阻止已安装项的开关落盘。

#### Scenario: 安装失败时已安装项仍照批

- **WHEN** 「全部开启」中部分子插件需要安装依赖而 `pnpm install` 失败
- **THEN** 这些未安装项被逐条报告为失败（原因可见、状态不变、可重试），而其余已安装子插件仍被正常开启

#### Scenario: 失败项在面板上逐条可见

- **WHEN** 批量结束后有 k 项失败
- **THEN** 面板提示条逐条列出失败子插件与失败原因，而不是只给一个失败总数

#### Scenario: 全批失败时状态与磁盘一致

- **WHEN** 批量过程中 patch 文件写入失败
- **THEN** 面板与诊断报出错误原因，后续列表返回磁盘上的真实状态，子插件保持操作前的状态

### Requirement: 批量全部移除的作用范围与计数口径

面板 SHALL 提供一个批量动作「全部移除」，其按钮 SHALL 显示本步将影响的数量 N（例如「全部移除 (6)」），N 为 **0** 时该按钮 MUST 置灰不可点。

批量的作用域 MUST 限于面板列出的受管仓库子插件（管理器自身除外），且 MUST 只作用于**有痕迹**的项——即该子插件在 profile 中留有激活行、或留有 `dependencies`/`devDependencies` 依赖键。按状态收敛：

- 全部移除 SHALL 作用于 `已激活`、`已停用`、`未激活(仅依赖)`。
- 全部移除 MUST 跳过 `未激活(未安装)`（无痕迹可清）、`旧布局`、`非插件目录`；对 `旧布局` 项面板 MUST 提示先执行「一键接管/迁移」，与其它批量动作一致。

N SHALL 等于上述「真能改动」的项数。执行后每个受管子插件 MUST 回到「未激活(未安装)」状态（激活行不存在、依赖键不存在），且其源码目录 MUST NOT 被删除。

该动作 MUST NOT 触碰管理器自身、`dsh.profile.bundles`、以及 `mcp-*` 等其它插件的行与依赖键。

#### Scenario: 全部移除清空全部受管痕迹

- **WHEN** 面板列出 6 个受管子插件（状态混合：已激活、已停用、未激活(仅依赖)），用户点「全部移除 (6)」并确认
- **THEN** 6 个的激活行全部被删除、profile 中对应的 `dependencies`/`devDependencies` 键全部被摘除，面板显示全部「未激活」

#### Scenario: 未安装项不计入数量也不被触碰

- **WHEN** 受管目录中某子插件从未被启用（不在依赖、无激活行）
- **THEN** 它不计入「全部移除」的 N，批量执行不改变它的状态，也不为它写任何文件

#### Scenario: 非插件目录与旧布局项被跳过

- **WHEN** 受管目录中存在缺少有效插件 `package.json` 的目录，或仍以旧布局（`dependencies` + `bundles`）安装的子插件
- **THEN** 它们被跳过且不计入 N；存在旧布局项时面板提示先执行「一键接管/迁移」

#### Scenario: 不触碰管理器自身与其它插件

- **WHEN** profile 中另有 `dsh-plugin-manager` 自身依赖、`mcp-*` 等其它插件的行与依赖
- **THEN** 执行「全部移除」后这些键与行原样保留，`dsh.profile.bundles` 不被改动

### Requirement: 全部移除一次落盘、一次安装、失败可回滚

一次「全部移除」SHALL 至多产生一次 profile `cordis.patch.yml` 写入与一次 profile `package.json` 改写，并 SHALL 至多执行一次 `pnpm install`，MUST NOT 逐项删除或逐项安装。执行前系统 SHALL 备份这两份文件。

与批量开关不同，全部移除 MUST 丢弃仍排在合并窗口中的单行开关意图——这些行本来就要被删除，先落盘只会额外产生一次 DSH 核心配置重应用；被丢弃的条数 MUST 在响应中如实报告，MUST NOT 静默丢弃。

任一环节失败时，系统 MUST 用操作前的备份回滚 `cordis.patch.yml` 与 `package.json`，MUST NOT 留下「行已删但依赖还在」或「依赖已摘但行还在」的半状态，并在响应中给出可读原因。

#### Scenario: N 项移除只写一次文件、只安装一次

- **WHEN** 用户对 N 个有痕迹的受管子插件执行「全部移除」
- **THEN** `cordis.patch.yml` 只被写入一次、`package.json` 只被改写一次、`pnpm install` 至多执行一次

#### Scenario: 排队中的开关意图被丢弃并如实报告

- **WHEN** 用户刚点了某行开关（意图仍在 400 ms 合并窗口中），随即点击「全部移除」
- **THEN** 该意图不再落盘（其目标行本来就要删除），响应中报告被丢弃的意图条数，最终状态为「全部移除」的语义

#### Scenario: 安装失败时整体回滚

- **WHEN** 摘除依赖后的 `pnpm install` 失败
- **THEN** `package.json` 与 `cordis.patch.yml` 都回到操作前的内容，面板状态与磁盘一致，并给出可读的失败原因

### Requirement: 移除后可重新启用并按当前目录重新定位

全部移除之后，用户 SHALL 能在面板上重新启用任一子插件；重新启用 SHALL 走「依赖键不存在」的安装路径，按该子插件**当前实际所在目录**重新写入 `link:` 依赖并安装，使 profile 从一台机器/一个 `DSH_HOME` 迁移到另一处后，遗留的旧绝对路径不会阻止插件重新定位。

#### Scenario: 迁移后重新启用重新定位

- **WHEN** profile 被迁移到另一处（原 `link:` 绝对路径已失效），用户先执行「全部移除」再对某子插件点启用
- **THEN** 管理器按该子插件当前所在目录重新写入 `link:` 依赖并安装成功，插件变为「已激活」

#### Scenario: 移除后状态与磁盘一致

- **WHEN** 「全部移除」完成后面板重新读取列表
- **THEN** 所有受管子插件显示为「未激活」，且 profile 中不再有任何指向这些子插件的依赖键或激活行

### Requirement: 批量操作的面板交互与生效提示

面板 SHALL 提供三个批量动作：「全部开启」「全部关闭」「全部移除」，每个按钮 SHALL 显示本步将影响的数量 N。三个按钮 SHALL 在执行前请求用户确认，确认文案 MUST 包含将影响的数量，并在存在被跳过项（旧布局）时说明；「全部移除」的确认文案 MUST 额外说明删除后果（激活行与依赖链接会被删除、源码目录保留、可随时重新启用）。批量执行期间面板 SHALL 锁住每行的开关/移除与「一键接管/迁移」并显示进行中提示，批量结束（含落盘与应用窗口消解）后 MUST 解锁。批量若改动了任何带浏览器界面的子插件，MUST 沿用既有约定提示「刷新页面使界面生效」并提供刷新按钮，MUST NOT 自动刷新页面。

#### Scenario: 确认文案带数量

- **WHEN** 用户点击「全部关闭 (6)」或「全部移除 (6)」
- **THEN** 弹出确认框，文案包含数量 6（以及「跳过 N 个旧布局插件，请先迁移」之类的说明，若适用）；取消则不改动任何状态

#### Scenario: 移除确认说明后果

- **WHEN** 用户点击「全部移除 (6)」
- **THEN** 确认文案说明将删除激活行与依赖链接、子插件源码目录保留、可随时重新启用；取消则不改动任何状态

#### Scenario: 批量执行期间锁定面板

- **WHEN** 任一批量正在执行（可能正在跑 `pnpm install`）
- **THEN** 每行的开关/移除与「一键接管/迁移」不可点，三个批量按钮均不可点，面板显示进行中提示；批量结束后恢复可点

#### Scenario: 批量完成后提示刷新界面

- **WHEN** 批量改动中包含带客户端 UI 的子插件
- **THEN** 面板提示需要刷新页面使这些子插件的界面生效，并提供刷新按钮；页面不会被自动刷新

### Requirement: 陈旧链接的自动检测是只读的

系统 SHALL 为每个受管子插件判定其 profile 依赖态之一：`absent`（无依赖键）、`fresh`（键存在且 `link:` 指向该子插件当前实际目录）、`stale-mismatch`（键存在、目标目录存在但不是当前实际目录）、`stale-target-missing`（键存在但目标目录不存在）。判定 SHALL 使用解析后的真实路径比较，并在大小写不敏感的文件系统（Windows/macOS 默认）上把仅大小写/分隔符差异视为 `fresh`。检测 SHALL 在宿主半加载时与面板每次拉取数据时各执行一次，MUST 是只读的：MUST NOT 因检测写 profile 文件、MUST NOT 因检测执行安装。判定结果 SHALL 随面板数据面暴露（每个插件带 `linkState`）。

#### Scenario: 检测出目标不存在的陈旧链接

- **WHEN** 某子插件的 `link:` 指向一个已不存在的目录
- **THEN** 该插件在面板数据里是 `linkState: 'stale-target-missing'`，且此过程没有写任何文件、没有执行安装

#### Scenario: 检测出指向别处的陈旧链接

- **WHEN** 某子插件的 `link:` 指向的目录存在，但不是它当前所在的目录
- **THEN** 该插件为 `linkState: 'stale-mismatch'`，并在数据里带上"声明指向 vs 当前实际目录"

#### Scenario: 仅大小写或分隔符差异不算陈旧

- **WHEN** `link:` 的写法与该子插件当前实际目录只在大小写或路径分隔符上不同（如 `D:/Repo/x` vs `D:\\Repo\\X`）
- **THEN** 判定为 `fresh`，不触发任何修复

#### Scenario: 检测不改环境

- **WHEN** 系统完成一次检测（无论结果如何）
- **THEN** profile 的 `package.json` 与 `cordis.patch.yml` 逐字节不变

### Requirement: 能确定就自动修，不确定只提示

系统 SHALL 在检测到陈旧项后自动修复**可确定**的那些：仅当该子插件在当前仓库中能唯一定位到实际目录、且自动重定位开关开启时，才改写其 `link:` 为当前目录，并在一次动作内为全部可修项只执行**一次** `pnpm install`，写文件前留下带时间戳的备份；任何失败 MUST 回滚到动作前状态且 MUST NOT 留半状态。**每次宿主启动最多自动执行一次**重定位动作。对 `stale-target-missing` 且当前仓库里找不到该插件实际目录、或存在多个候选的项，系统 MUST NOT 猜路径，MUST 只提示（不写文件、不安装）。自动重定位的结果（时间、处理了哪些条目、成功或失败原因）SHALL 在面板与诊断数据中可见。

#### Scenario: 可确定时自动重写并只安装一次

- **WHEN** 宿主半加载时检测到 2 个子插件的 `link:` 陈旧，且它们在当前仓库中都能唯一定位
- **THEN** 管理器改写这 2 条 `link:`、恰好执行一次 `pnpm install`、留下 `*.bak-<ts>` 备份，并在面板/诊断中记录本次自动重定位的条目与结果

#### Scenario: 确定不了的一律不猜

- **WHEN** 检测到某子插件的 `link:` 目标目录不存在，且当前仓库里没有它的实际目录
- **THEN** 不写任何文件、不执行安装，只在面板横幅中把它列入"需人工处理"，并说明原因

#### Scenario: 一次启动最多修一次

- **WHEN** 同一次宿主运行期间，面板被反复刷新并多次拉取数据
- **THEN** 自动重定位动作最多再次发生 0 次（该启动的额度已用尽），后续检测只读

#### Scenario: 开关关闭时只检测

- **WHEN** 用户在设置里关闭自动重定位开关，随后宿主重启并检测到可修项
- **THEN** 不写文件、不安装，只在面板显示横幅与可修项清单

#### Scenario: 自动修失败时回滚且不留半状态

- **WHEN** 自动重定位过程中写文件或安装失败
- **THEN** profile `package.json` 回滚到动作前内容，插件状态保持原样，面板与诊断给出失败原因，且该启动不再重试

### Requirement: 面板自检横幅与一键重定位

面板 SHALL 在存在陈旧链接时显示横幅：包含总数、逐条明细（插件名、`linkState`、声明指向与当前实际目录）以及"可自动修复"与"需人工处理"的分区；并提供「重定位」按钮，对全部可确定项执行与自动修复相同的动作（一次安装、写前备份、失败回滚）。不存在陈旧项时 MUST NOT 显示横幅、MUST NOT 写任何文件。按钮执行中与执行后 SHALL 明确呈现结果（处理条目、安装是否发生、失败原因）。

#### Scenario: 横幅列出可修与不可修

- **WHEN** 面板检测到 3 条陈旧项，其中 2 条可确定、1 条目标缺失
- **THEN** 横幅显示总数 3，可自动修复区列出 2 条并可直接点「重定位」，需人工处理区列出剩余 1 条及其原因

#### Scenario: 一键重定位只安装一次

- **WHEN** 用户点击「重定位」处理 2 条可修项
- **THEN** 两条 `link:` 被一次改写、`pnpm install` 恰好执行一次，成功后横幅消失

#### Scenario: 无陈旧项时零副作用

- **WHEN** 所有子插件的链接都正确，用户打开面板
- **THEN** 不显示横幅，且 profile 两份文件逐字节不变、没有执行任何安装

### Requirement: 自包含的一键卸载命令

系统 SHALL 提供一个**不依赖 DSH 宿主与 `dsh` CLI** 的卸载命令（随 `dsh-plugin-manager` 包分发的 Node 脚本），一次调用完成：解析目标 profile → 删除该 profile 中**全部受管子插件的激活行**（`cordis.patch.yml`）与**指向本仓库 `sub-plugins/` 的 `link:` 依赖键**（`package.json`）→ 删除 `dsh-plugin-manager` 自身的依赖键与其在 `dsh.profile.bundles` 中的条目 → 在 profile 目录执行**恰好一次** `pnpm install`。命令 MUST 在写文件前为两份文件各留一份带时间戳的备份（`*.bak-<ts>`），MUST NOT 删除任何源码目录，MUST NOT 触碰其它插件的激活行、依赖键或 bundles 条目。

命令 SHALL 支持**干跑**（只打印将删除的内容，不写文件、不安装）与**逐项结果输出**（删了哪些行/键、是否执行了安装、备份路径）。当没有可删除项时，命令 SHALL 是幂等 `noop`（不写文件、不安装、不报错）。

#### Scenario: 一条命令清空子插件并移除管理器

- **WHEN** 在一个装有管理器的 profile 上运行该卸载命令
- **THEN** 受管子插件的激活行与 `link:` 依赖键、管理器自身的依赖键、`dsh.profile.bundles` 中的管理器条目全部消失；`cordis.patch.yml` 与 `package.json` 各被写入一次、各留一份 `*.bak-<ts>`；`pnpm install` 恰好执行一次

#### Scenario: 干跑不动任何文件

- **WHEN** 用户带干跑参数运行该命令
- **THEN** 输出列出将删除的行、依赖键与是否会执行安装；两份文件逐字节不变、没有执行安装

#### Scenario: 其它插件与源码目录不受影响

- **WHEN** profile 中同时存在非本仓库插件的行（如 `mcp-*`、第三方插件）与其依赖键
- **THEN** 它们逐字节不变；本仓库各子插件的源码目录、以及被 `link:` 指向的任何开发 checkout 目录都仍然存在

#### Scenario: 重复执行是幂等 noop

- **WHEN** 对已经卸载过的 profile 再次运行该命令
- **THEN** 命令报告无可删除项，不写文件、不执行安装，退出码为成功

#### Scenario: 安装阶段失败时给出可收尾的降级路径

- **WHEN** 最后的 `pnpm install` 失败（例如 Windows 上删除脚本自身所在目录遇到 EBUSY/EPERM）
- **THEN** 命令如实报告失败原因，并打印"重跑一次 `pnpm install`"的收尾命令；此前的删除结果保持可用（用户重跑即可收尾），且不谎报成功

### Requirement: 面板提供复制卸载命令且不自动执行

管理器的设置面板 SHALL 提供一个「复制卸载命令」入口：按**当前 profile** 拼出可直接粘贴执行的那条命令（兼容两种装法：git 快照下脚本路径在 `node_modules/dsh-plugin-manager/dsh-plugin-manager/tools/` 下，本地 `link:` 装法下在仓库目录里），并在复制前展示**将删除什么**（受管子插件行数、依赖键数、是否会执行一次安装、以及"源码目录不会被删除"的说明）。该入口 MUST 只复制命令、MUST NOT 自动执行卸载，MUST 在剪贴板不可用时给出可手动复制的文本。

#### Scenario: 复制到的命令与将删除内容一致

- **WHEN** 用户点击「复制卸载命令」
- **THEN** 剪贴板得到一条指向当前 profile 的卸载命令，且面板同时显示"将删除 N 条激活行 / M 个依赖键 + 管理器自身，源码目录保留"

#### Scenario: 只复制不执行

- **WHEN** 用户点击该入口
- **THEN** 不写任何文件、不执行安装、不改变任何插件状态；卸载仍必须由用户在终端亲自运行那条命令

### Requirement: 卸载后 profile 状态可自证干净

卸载命令执行成功后，profile SHALL 处于"启动不需要任何本仓库子插件"的状态：不存在受管子插件的激活行、不存在指向本仓库 `sub-plugins/` 的 `link:` 依赖键、`dsh.profile.bundles` 中不含 `dsh-plugin-manager`。系统 SHALL 让这一点可核对（命令逐项列出清掉了什么，或在结束时输出可直接比对的文件路径与条目数）。

#### Scenario: 卸载后按文件自证

- **WHEN** 卸载命令成功结束
- **THEN** 输出或后续核对显示：`cordis.patch.yml` 中受管子插件行数为 0、`package.json` 中指向本仓库 `sub-plugins/` 的键数为 0、`dsh.profile.bundles` 不含管理器；随后启动 GUI host 不再出现 `failed to import loader entry` / `Cannot find package`

