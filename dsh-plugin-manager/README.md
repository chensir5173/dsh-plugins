# dsh-plugin-manager

**本地插件管理器**：装上这一个插件，DSH Web 设置页左侧就多一个一级入口**「本地插件」**——本入口由本插件拥有并在内部用 **tab** 承载各本地插件的面板（管理器自己 = 第一个 tab「本地插件」，其余由各子插件贡献）。在这里管理本仓库全部 `dsh-*` 子插件：查看状态、逐个或批量开关（激活 / 停用）、移除、把旧布局一键迁移到管理器模型。

## 安装

```bash
dsh plugin --profile web add git+https://github.com/Chen5173/dsh-plugins.git
# 本机开发：dsh plugin --profile web add <仓库根>
```

**重启 `dsh web`** → 设置 → 左侧「本地插件」。各入口写法与限制见根 [`README.md`](../README.md)。

首次进入若面板顶部提示「仍以旧布局安装」，点 **一键接管/迁移** —— 它会先备份 profile 的 `package.json` 与 `cordis.patch.yml`（`*.bak-<时间戳>`），迁移前后你的插件激活集合不变。

## 面板怎么用

每行 = 状态标签 + 包名/目录 + 描述 + 主开关 + 移除；顶部 = 仓库路径 / 子插件目录 / 目标 profile / **全部开启·全部关闭·全部移除** / 刷新 / 一键迁移。

- **启用**：自动补依赖并写入激活行，宿主侧即时生效。
- **停用**：保留激活行与依赖，只是关掉，随时可再开。
- **移除**：删激活行 + 摘依赖；仓库里的源码目录保留，之后可再启用。
- **依赖自愈（默认开）**：子插件的依赖写成**相对本 profile 的 `link:` 规格** `"<name>": "link:./node_modules/dsh-plugin-manager/sub-plugins/<dir>"`——它指向 profile 里那份管理器拷贝，所以**不含盘符、用户名或仓库绝对路径**；只有当 profile 里那份拷贝不可达（例如刚做完本地检出、还没落盘）时才退回 `link:<插件绝对目录>`。换机器 / 换 `DSH_HOME` / 换仓库目录后，宿主加载时会**只读检测**规格（`fresh` / `陈旧：规格不是当前形态（旧 workspace:* 键、绝对 link:、版本号…）` / `陈旧：规格指向的目录不存在` / `无法确定`）；对**能确定**的项自动改写规格，并只跑**一次** `pnpm install`（**每次宿主启动最多一次**，写前留 `*.bak-<ts>` 备份），确定不了的只在面板横幅里列为「需人工处理」——**绝不猜路径**。面板顶部横幅给出计数、逐条「声明 → 期望」与「修复依赖」按钮；开关在设置页的 `dsh-plugin-manager` 段（字段 `autoRelink`，默认开，关掉后只检测与提示）。
- **启用即自愈**：单行「开启」与「全部开启」在依赖仍是旧写法（遗留的 `workspace:*` 键、绝对 `link:` 规格）时同样会改写（不再是"键在就信任"）。
- **带界面的子插件**其客户端 UI 只在**一次页面刷新**后进/出。面板开关后会提示并给出刷新按钮，**不会自动刷新**。
- **批量按钮**上的数字 = 这一步真能改动的插件数（为 0 时置灰）。「全部开启」处理 `已停用` 与 `未激活`；「全部关闭」处理 `已激活`；「全部移除」处理**在 profile 里留下痕迹的**那些（`已激活`、`已停用`、`未激活(仅依赖)`）。`未安装`（对移除而言）、`旧布局`、`非插件目录` 一律跳过（旧布局请先迁移，确认框与结果里会点明跳过了几个）。批量只作用于面板列出的受管子插件，profile 里其它插件的行（`mcp-*`、`dsh-liquid-glass` …）一行都不碰。
- **全部移除**：一次删掉全部受管子插件的激活行与 devDependencies 键，只跑一次 `pnpm install`；源码目录保留，之后可逐个重新启用。它是**破坏性**动作，插件会立刻停止运行——**迁移过 profile / 换过机器**时这正是清掉旧依赖痕迹的办法：先「全部移除」，再按需「全部开启」或逐个启用，管理器就会按当前形态（指向本 profile 拷贝的相对 `link:` 规格）重新声明。执行时仍在 400 ms 合并窗口里的开关点击会随行作废（结果提示会说明作废了几次）。
- **失败逐项回报**：批量中某项失败只影响该项（原因可见、状态不变、可重试），其余照常生效，提示条逐条列出。
- **执行期锁定**：批量进行中（可能正在装依赖）所有开关、移除与「一键迁移」都禁用并显示「处理中…」。
- **连点会合并**：短时间内多次开关只落盘一次。落盘会让核心重应用整棵配置树，界面可能短暂无响应。
- **没有**撤销按钮，也不会自动迁移旧布局。「全部移除」只摘依赖键与激活行，**不会删除**仓库里的子插件目录，所以恢复成本 = 重新点一次「全部开启」。
- **安全更新（退出后再落盘）**：面板下方列出**可安全更新**的依赖（`git` / registry 规格；本地 `link:` / `file:` / `workspace:` 依赖不在列，避免把本仓库的链接改坏）。勾选后点「准备更新」只会生成 `<profile>/.plugin-manager/apply-update.cmd`（POSIX 下 `apply-update.sh`）与一份待更新记录——**这一步不装任何东西、不改任何 profile 文件**。完全退出 DSH 后运行该脚本：它先等到宿主进程与端口都空闲、备份 `package.json` / `pnpm-lock.yaml`，再对每个目标跑 `pnpm add <规格>`（PATH 里没有 pnpm 时回退 `dsh plugin --profile <名字> add <规格>`）；失败打印回滚命令，退出前暂停让你读到结果。点了「取消准备」只删这两个文件。

### 面板报错怎么自查

面板顶部的红字现在分三种情况给话：宿主端点未注册（HTTP 404 → 重启 DSH；仍失败就看下面）、响应不是 JSON（端点未注册或已回滚）、连不上宿主（DSH 可能正在重启）。这三种以前都只会显示浏览器原生的 `Failed to execute 'json' on 'Response': Unexpected end of JSON input`。

宿主半每次启动会把一份诊断快照写到 `<profile>/.plugin-manager/host-diag.json`（**只在装进 profile 时写**，在仓库里跑测试不会留文件）：

- `httpMounted` / `endpointsRegistered`：路由是否真的挂上。
- `httpSkipped`：没挂上的原因原文（`webServer service is not available`、`register failed: webserver: duplicate route …` 等）。**0.3.15 起点名同进程的孪生实例**：同一个 `src/index.js` 被 dshmarket 的免重启热挂载在**同一进程**里加载第二次时，两个 fiber 只有一个能持有 `(kind:'prefix', path:'/__dsh-plugin-manager')`，输的那个写成 `another instance of this plugin already serves /__dsh-plugin-manager in this process — this fiber serves nothing (…)`。
- `applyError` / `applyErrorStack`：`apply()` 本体抛错时的前 8 帧；`settingsError`：设置段失败的原因。
- `yamlResolved` / `yamlVersion` / `yamlFlavor` / `yamlError`：profile 那份 `js-yaml` 解析到没有、什么版本、走的哪族 API（`type-extend` = 4.x；`define-tag` = 5.x）、不可用时的原因原文。
- `profileSource`：这次是怎么认出 profile 的 —— `config`（显式配置且目录存在）/ `baseUrl`（由运行中的 loader 给出并已锚回 `$DSH_HOME/profiles/<名字>`）/ `baseUrl-raw`（锚不上，按原样使用该目录）/ `default`（回退 `web`）。

配合 stderr 上的一行 `dsh-plugin-manager: …`，这几项足以判断是「宿主没起来」、「路由被占」还是「设置段连累」。

**两个实例的识别**：dshmarket 的免重启热挂载会把本插件在同一进程里再加载一次（条目 id `mkt-dsh-plugin-manager`，来自 `<profile>/.dsh-market/hot-<n>.yml`）。两个实例共享模块级状态，但只有一个能持有 `/__dsh-plugin-manager` 前缀路由 —— 输的那个在诊断文件里留下上面那句 `another instance …`；诊断文件**只保留最后一个写入者**，所以它与面板顶部显示的 profile 不一致时，就是双实例在场。重启 DSH 即回到单实例（热挂载目录每次启动都会被清空）。

### 退役的子插件不会出现在面板里

`src/host-core.js` 里有一份 `RETIRED_PLUGIN_DIRS`：登记在那里的目录**仍然留在仓库当参考源码**（README / ACCEPTANCE / 测试照旧可读可跑），但 `listRepoPluginDirs()` 扫描时会跳过它，所以面板既不会列出、也不会再激活它，`/list` 与三个批量按钮的计数里也没有它。

当前退役名单：

| 目录 | 日期 | 为什么 |
|---|---|---|
| `dsh-open-session-workdir` | 2026-09-18 | 核心自带「Open In…」分体按钮（`@deepseek-ai/dsh-client-ui-open-in-app`）已覆盖同一需求：会话头 `conversation.session.header.utilities` 上，主按钮=上次选过的应用打开会话 `cwd`、箭头列出宿主探测到的全部已装应用 |
| `dsh-hindsight-model` | 2026-10-09 | 用户要求**暂时废弃**：这个面板管的是 Hindsight（Vectorize 的长期记忆层）那个**独立 Python 守护进程**的模型配置与启停 —— 与 DSH 解耦、配置落在 `~/.hindsight/`，本仓不再跟着维护 |

要新退役一个子插件，**往那份数组加名字**（连日期与理由一起写），而不是删目录；要它重新回到面板，把名字从数组里删掉即可——目录与依赖声明都还在。

> **已退役实例的存量清理（0.3.12 起自动）**：退役前已激活过的 profile 会留三种残留——`cordis.patch.yml` 的激活行（DSH 插件列表里那个「幽灵条目」）、`package.json` 的依赖键、`node_modules/<包名>` 的链接点。宿主每次启动会自动清一次（也挂在每次安装/迁移之前）：先快照、真有残留才先备份再改写，干净时零写入；键清掉**不跑** pnpm（下次任何 install 自然同步），`node_modules` 只删**链接点**（symlink / junction / 断链），真实目录与管理器自己的 `sub-plugins` 镜像绝不动。清理结果记在 `/status` 的 `hostDiag.retiredSweep`。
>
> 历史：`dsh-hindsight-model`（2026-10-10 desktop profile）是唯一一次手动收尾——当时管理器还带不动清理，靠手工删行；此后同类问题不再需要人工。恢复一个退役插件 = 把名字从 `RETIRED_PLUGIN_DIRS` 删掉 + 重新点开它（清理只会删 retired 名单里的行）。

### 为什么不在这里直接替换（更新卡住的由来）

**运行中替换 = pnpm 去覆盖正被 DSH 加载的文件**。Windows 上这些文件被占用，pnpm 只能重试或报 `EBUSY` / `EPERM`，用户看到的就是「点了更新，界面卡住，只能重启」。所以本面板把两件事拆开：**登记要更新什么**（随时可做，零副作用）与**替换文件**（必须在 DSH 退出后）。

- 期间文件只有三个，都在 `<profile>/.plugin-manager/` 下：`update-pending.json`（目标、脚本路径、生成时的宿主 pid 与端口）、`apply-update.cmd` / `apply-update.sh`（替换脚本）、`update-apply.ndjson`（脚本自己的执行日志）。**它们都不进 profile 的依赖与激活行**，所以面板与 DSH 的加载状态都不会因此变化。
- 脚本等待的判据是「宿主 pid 已消失 **且** 端口不再 LISTEN」（两样都拿不到就跳过等待），默认最多等 300 秒；超时不动任何文件，提示你彻底退出（含托盘）后再运行一次。
- 更新参数由**已声明的依赖规格**派生，面板只能勾选 manifest 里已有的名字：请求里传不了任意命令，脚本里也不会拼出用户没声明过的包。
- 「取消准备」只删待更新记录与脚本（不动任何本机配置）；替换失败时备份仍在，按脚本打印的 `copy /Y` 命令即可回滚。

## 它会改动你机器上的什么

- 读写目标 profile 的 `package.json`（`devDependencies`）、`cordis.patch.yml`（激活行）与 `pnpm-workspace.yaml`（**只清理早期版本留下的那条指向本仓库插件目录的 glob**，其它 glob 与键一个都不动；新装的 profile 根本不会有这个文件）；每次改动前生成 `*.bak-<时间戳>` 备份，失败自动回滚。
- 退役插件的存量清理：摘掉 `RETIRED_PLUGIN_DIRS` 名单内插件的 `cordis.patch.yml` 激活行、`package.json` 依赖键（不跑 pnpm）与 `node_modules/<包名>` **链接点**（junction/symlink/断链，真实目录绝不动），详见上文「退役的子插件」小节。
- 需要装依赖时在 profile 目录执行 `pnpm install`。
- YAML 处理用 profile 自带的 `js-yaml`，**4.x 与 5.x 都支持**：启动时按 API 特征探测（4.x = `new Type(...)` + `JSON_SCHEMA.extend`；5.x = `defineScalarTag` + `JSON_SCHEMA.withTags`），两族等价处理，`!!js` 标量的往返语义不变。profile 里**完全没有** js-yaml 时自动 `pnpm add -D js-yaml` 一次；若解析到的是**两族都不认识**的版本，则**不安装、不改动** profile 依赖（那份很可能是别的插件的传递依赖），只在诊断里记 `yamlError` 并降级运行（面板照常可用，依赖 YAML 的功能给出可读错误）。
- 默认管理**当前正在运行的那个 profile**：目录由运行中的 loader 给出的 `ctx.baseUrl` 决定，并**锚回** `$DSH_HOME/profiles/<名字>` —— `ctx.baseUrl` 不一定是 profile 目录本身（dshmarket 的热挂载把它设成 `<profile>/.dsh-market/`，0.3.14 及以前据此认定出一个名为 `.dsh-market` 的幽灵 profile：面板列空、开关报 `copyfile … ENOENT`，而真正的激活行在 desktop）。锚不上时（自定义布局）才按原样使用该目录。`config: { profile: '名字' }` 在该目录**存在**时优先于 `ctx.baseUrl`；没有 Web 界面可探测时（例如 headless 宿主）回退到 `$DSH_HOME/profiles/<config.profile || 'web'>`。
- 除以上之外不写任何持久数据。

## 卸载 / 回滚

**先分清两种装法**（面板顶部的「仓库路径」能告诉你现在是哪种）：

| 装法 | 子插件的依赖怎么写 | 删管理器之后 |
|---|---|---|
| **git 快照**（`dsh plugin add git+https://…`） | 包名写成相对 profile 的 `link:./node_modules/dsh-plugin-manager/sub-plugins/<dir>`，指向克隆里那份拷贝 | 那 7 个子插件的**代码随克隆一起消失**，而激活行与这些 `link:` 键**留在 profile 里** → 下次启动报 `failed to import loader entry …: Cannot find package …` |
| **本地 `link:`**（`dsh plugin add <仓库根>`） | 同上（相对规格指向 profile 里生效的那份拷贝）；仅当 profile 里还没落盘那份拷贝时退回 `link:<开发仓库>/sub-plugins/<dir>` | 依上面那条命令的说明：源码不动；`package.json` 里会留下本仓库插件的 `link:` 键 |

**核心 CLI 帮不了你**：`dsh plugin --profile web remove dsh-plugin-manager` 只是 pnpm 转发 + 只对账 `dsh.profile.bundles`——它**不认识** `cordis.patch.yml` 里由管理器写下的激活行，也**不会**碰子插件的依赖键与可能残留的锚点 glob（核心也没有卸载钩子）。

**请用这条一键卸载**（脚本随包分发，不依赖 DSH 宿主与 `dsh` CLI）：

```bash
node "<面板里「复制卸载命令」复制到的那条命令>"   # 面板已按当前 profile 拼好，含 --profile <name> --yes
# 或者手写：
node "~/.dsh/profiles/web/node_modules/dsh-plugin-manager/dsh-plugin-manager/tools/uninstall-manager.mjs" --profile web --yes
```

它一次做完：删除全部受管子插件的激活行与指向本仓库的依赖键 → 从 `pnpm-workspace.yaml` 摘掉早期版本留下的那条 glob（若还在）→ 删除管理器自身的依赖键与 `dsh.profile.bundles` 条目 → 跑**一次** `pnpm install`。改到的 profile 文件写前各留一份 `*.bak-<ts>`；**不删任何源码目录**；重复执行是 noop。默认**干跑**（只打印将删除什么），`--yes` 才真删——所以面板只提供「复制命令」，不会替你执行。

失败降级：若最后一步 `pnpm install` 失败（Windows 上删脚本自身所在目录偶发 EBUSY），行与键**已经清干净**，按它打印的 `pnpm install --dir "<profile>"` 重跑一次即可收尾。

要回到迁移前的样子：先还原 `*.bak-<ts>`，再按「安装」重装管理器。

> ⚠️ **卸载子插件不要用 CLI**：`remove <子插件包名>` 只摘依赖、不会删管理器写的激活行，下次 `dsh web` 启动会失败。请用面板的「移除」（或上面的一键卸载）。

## 版本要求

- Node ≥ 20（`package.json` 的 `engines`）。
- 宿主：profile 顶层能解析 `js-yaml`（web profile 已具备；**4.x / 5.x 都支持**，见上文「它会改动你机器上的什么」），并由 pnpm 管理（**不需要** `pnpm-workspace.yaml` 锚点；早期版本留下的那条 glob 会被自动清掉）。解析到 4.x/5.x 之外的版本时插件**降级运行**：面板与批量开关照常，依赖 YAML 的功能给出可读错误；要修就把 profile 那份 `js-yaml` 换成 4.x 或 5.x（先确认它不是别的插件的传递依赖，别直接覆盖）。
- 浏览器：需要核心提供 `react` 模块字与 `settings.localPlugins.tab` 槽（旧核心没有该槽时面板不出现，但管理器宿主机能照常工作）。客户端不依赖任何 `@deepseek-ai/*` 宿主包。
- 宿主半导出 `Config`（`autoRelink`）：0.2.0 退役了 `settings.installSection`，设置命名空间改为「profile 条目 id 的 Config」——本包因此在设置页出现「自动修复依赖」开关；0.1.x 仍走 installSection。

---

每个子插件的作用与触发位置见 [`docs/plugins.md`](../docs/plugins.md)。本包的机制说明、约束与实测证据在仓库根 `AGENTS.md`、`docs/knowledge/`、`openspec/`；逐条验收项见 [`ACCEPTANCE.md`](ACCEPTANCE.md)。
