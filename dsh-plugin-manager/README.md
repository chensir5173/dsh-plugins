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

### 退役的子插件不会出现在面板里

`src/host-core.js` 里有一份 `RETIRED_PLUGIN_DIRS`：登记在那里的目录**仍然留在仓库当参考源码**（README / ACCEPTANCE / 测试照旧可读可跑），但 `listRepoPluginDirs()` 扫描时会跳过它，所以面板既不会列出、也不会再激活它，`/list` 与三个批量按钮的计数里也没有它。

当前退役名单：

| 目录 | 日期 | 为什么 |
|---|---|---|
| `dsh-open-session-workdir` | 2026-09-18 | 核心自带「Open In…」分体按钮（`@deepseek-ai/dsh-client-ui-open-in-app`）已覆盖同一需求：会话头 `conversation.session.header.utilities` 上，主按钮=上次选过的应用打开会话 `cwd`、箭头列出宿主探测到的全部已装应用 |
| `dsh-hindsight-model` | 2026-10-09 | 用户要求**暂时废弃**：这个面板管的是 Hindsight（Vectorize 的长期记忆层）那个**独立 Python 守护进程**的模型配置与启停 —— 与 DSH 解耦、配置落在 `~/.hindsight/`，本仓不再跟着维护 |

要新退役一个子插件，**往那份数组加名字**（连日期与理由一起写），而不是删目录；要它重新回到面板，把名字从数组里删掉即可——目录与依赖声明都还在。

> 已退役但仍在运行中的实例：如果它退役**之前**已经激活在 profile 里，退役**不会**自动摘掉那行 —— 先按它的 README/history 在面板里「移除」（若那时面板还列着它），或手工删掉 profile `cordis.patch.yml` 的对应 `- insert:` 行与 `package.json` 的 devDependency 后再 `pnpm install`。
>
> 本次退役的 `dsh-hindsight-model` 退役前在 desktop profile 里是**激活**的：已把 `- id: hindsight-model` 那一行改成 `disabled: true`（**保留激活行与依赖，只关掉**），所以功能随下一次 DSH 启动停止。恢复 = 删掉那个字段（要让面板重新列出它，还得把名字从 `RETIRED_PLUGIN_DIRS` 里删掉）。

## 它会改动你机器上的什么

- 读写目标 profile 的 `package.json`（`devDependencies`）、`cordis.patch.yml`（激活行）与 `pnpm-workspace.yaml`（**只清理早期版本留下的那条指向本仓库插件目录的 glob**，其它 glob 与键一个都不动；新装的 profile 根本不会有这个文件）；每次改动前生成 `*.bak-<时间戳>` 备份，失败自动回滚。
- 需要装依赖时在 profile 目录执行 `pnpm install`。
- YAML 处理用 profile 自带的 `js-yaml`；缺失时自动 `pnpm add -D js-yaml` 一次。
- 默认管理**当前正在运行的那个 profile**。没有 Web 界面可探测时（例如 headless 宿主）回退到 `$DSH_HOME/profiles/<config.profile || 'web'>` —— 要改这个回退目标，在 `dsh.profile.bundles` 里本插件行加 `config: { profile: '名字' }`。
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
- 宿主：profile 顶层能解析 `js-yaml`（web profile 已具备），并由 pnpm 管理（**不需要** `pnpm-workspace.yaml` 锚点；早期版本留下的那条 glob 会被自动清掉）。
- 浏览器：需要核心提供 `react` 模块字与 `settings.localPlugins.tab` 槽（旧核心没有该槽时面板不出现，但管理器宿主机能照常工作）。客户端不依赖任何 `@deepseek-ai/*` 宿主包。
- 宿主半导出 `Config`（`autoRelink`）：0.2.0 退役了 `settings.installSection`，设置命名空间改为「profile 条目 id 的 Config」——本包因此在设置页出现「自动修复依赖」开关；0.1.x 仍走 installSection。

---

每个子插件的作用与触发位置见 [`docs/plugins.md`](../docs/plugins.md)。本包的机制说明、约束与实测证据在仓库根 `AGENTS.md`、`docs/knowledge/`、`openspec/`；逐条验收项见 [`ACCEPTANCE.md`](ACCEPTANCE.md)。
