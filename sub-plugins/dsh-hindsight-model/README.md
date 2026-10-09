# dsh-hindsight-model
> ## ⛔ 已退役（2026-10-09）——暂时废弃，源码留作参考
>
> 用户要求**暂时废弃**这个子插件。它管的是 Hindsight（Vectorize 的长期记忆层）那个**独立 Python 守护进程**的模型配置与启停——进程、凭据、模型语义三样都和 DSH 隔离，本仓不再跟着维护它。
>
> 因此：
> - **管理器面板不再列出它** —— `dsh-plugin-manager/src/host-core.js` 的 `RETIRED_PLUGIN_DIRS` 里登记了 `dsh-hindsight-model`，扫描直接跳过（`dsh-plugin-manager/test/root-install-shell.test.mjs` 有一条断言钉住「源码在、面板不列」）。
> - **desktop profile 里那一行已置 `disabled: true`**（保留激活行与依赖，只关掉）—— 会话开始时的 `/health` 探测与守护进程按需自动拉起随之停止。
> - **源码、本文档、`ACCEPTANCE.md` 与测试全部保留**，作为「外部 Python 守护进程的配置面板 + 环境净化启停」的参考实现（`node test/bundle.test.mjs` 仍可跑）。
> - **恢复**：把 `dsh-hindsight-model` 从 `RETIRED_PLUGIN_DIRS` 里删掉，并去掉 profile `cordis.patch.yml` 里 `hindsight-model` 行的 `disabled: true`。
> - 退役背景与恢复步骤：[`docs/knowledge/2026-10-09-retire-hindsight-model.md`](../../docs/knowledge/2026-10-09-retire-hindsight-model.md)。
>
> 下面保留的是退役前的原始说明，**只作历史参考**。


DSH **设置 → 本地插件 → 「Hindsight 模型」**（「本地插件」一级入口里的一个 tab）面板：**看穿四层取值**、**改得动权威文件**、**答得出「到底生效了没有」**。

Hindsight（Vectorize 的长期记忆层）虽然以 DSH 插件形式装入，后端却是**独立 Python 守护进程**——进程、凭据、模型语义三样都和 DSH 隔离，所以它必须单独配模型。更麻烦的是它的配置链路有三个反直觉之处，本插件就是围绕它们做的。

## 它解决的三个问题

| 问题 | 事实（已读上游源码确认） |
|---|---|
| 改完不知道生效没 | 没有热加载（`HindsightConfig._config_cache` 只在进程内，不存在 reload 端点）⇒ 必须重启；而面板能直接回答「现在跑的是哪套值」 |
| 改了被静默改回去 | 守护进程**启动路径会回写权威文件**：`cli.py` 载入 profile 到 `os.environ` 时**不覆盖已存在的键**、`daemon_embed_manager.py` 用 `{**profile, **config}` 合并、`_register_profile()` 再经 `create_profile()` **整体重写** `.env`。所以外层同名环境变量会赢，并覆盖你刚存的值 |
| 不知道「哪一层说了算」 | 权威落点是 `~/.hindsight/profiles/<profile>.env`，但外层还有**用户级环境变量**与**宿主进程环境变量**两层，且两者处置方式不同 |

## 面板里的四层

| 层 | 含义 |
|---|---|
| ① 权威落盘 | `~/.hindsight/profiles/<profile>.env` 的内容（密钥只显示长度） |
| ② 运行中实际生效 | 守护进程启动日志里它**真正读到**的 provider / model / endpoint + 连通性结论 |
| ③ 冲突源 | 会覆盖 ① 的外层值，**分两组**：用户级环境变量（本插件可清理）、宿主进程环境变量（本插件清不掉，只提示） |
| ④ 生效判据 | **主判据**：① 与 ② 的三件套是否一致；**回退判据**（取不到 ② 时）：进程启动时间 vs 文件修改时间 |

> 为什么主判据不是时间：上游启动路径自己会回写该文件，实测本机 `.env` mtime（18:56:29）就晚于进程启动（18:55:46），而两者取值完全一致。只按时间判定会对完全健康的配置长期误报「尚未生效」。

## 用法

设置 → 本地插件 →「Hindsight 模型」。四个操作：

- **从 DSH 读取**：把 DSH 的默认模型（provider / model）与该路由的 `baseURL` 预填进表单（**只填表单，不写盘**）。DSH 的密钥**不会**以明文进入浏览器：面板只显示「有值 / 长度 / 来源」，勾选「保存时使用 DSH 的密钥」后由宿主半在保存时解析并使用。
- **保存**：把改动写进权威文件。写入是**行级增改**——只改命中键所在行，其余行（含模板注释、未知键、顺序、行尾风格）逐字节不变；先写 `*.bak-<时间戳>` 备份，经临时文件 rename 原子落盘，失败即回滚。字段留空表示**删除该键**（回落到内置默认）。
- **验证**：回答「生效了没有、生效的是哪套值」，不一致时逐个列出字段及两侧取值。
- **清理用户级冲突键**：先把这些键（含值）导出到 `~/.hindsight/backups/hkcuenv-<时间戳>.json`，导出成功后才执行删除；二次确认，取消则不动任何键。

### 启停守护进程

面板直接提供 **启动 / 停止 / 重启**（外加状态与健康检查）。两半的实现**不一样**，原因必须说明：

- **启动**走官方 CLI：`uv run --directory "<embedPackagePath>" hindsight-embed daemon --profile <daemonProfile> start`，profile 名与目录取自本机 `~/.hindsight/coding-agent.json`，不硬编码。**子进程的环境被净化**——所有 profile 管理的键都从子进程 env 里剔除，使权威文件成为唯一真源。这一步不能省：`cli.py` 把 profile 载入 `os.environ` 时**不覆盖已存在的键**，不净化的话外层同名变量会在启动时被写回、覆盖你刚保存的配置。
- **停止不走官方 CLI**：`hindsight-embed daemon stop` 在这类机器上不可用——它靠解码 `netstat` 输出找 PID，而 Windows 吐的是控制台代码页（cp936）字节，于是 `UnicodeDecodeError` → `Could not find PID for port 9077` → 拒绝停止；把 Python 的 UTF-8 模式关掉也不行，那样它读自己那份 UTF-8 编码的 profile 会崩（`gbk` 解码失败）。**开也错、关也错**。所以停止改为：取监听端口的 PID → **校验它确实是 Hindsight 守护进程**（命令行含 `hindsight_api.main`、带 `--daemon`、`--port` 与当前端口一致）→ 才终止。这保留了上游「不向无法确认的进程发信号」的安全性质（它防的是误杀恰好占用同端口的不相关服务）。
- **重启 = 停止 → 等端口释放 → 启动**（CLI 没有 `restart` 子命令）。
- `停止` / `重启` 需要**二次确认**（会中断进行中的记忆操作）；守护进程本就未运行时「停止」按幂等成功处理并如实说明，不报错。
- **每次启动前自愈解释器启动器**：守护进程是通过 `<embed>\.venv\Scripts\pythonw.exe` 拉起的；在 uv 建的 venv 里这个文件其实是**控制台**跳板（上游只检查它「是否存在」），于是 Windows 会给守护进程新开一个控制台窗口。启动前会读它的可执行文件头：若不分配控制台，什么都不做；若是控制台形态，**先备份原件**（`<embed>\pythonw.exe.uv-orig-<时间戳>`，放在 `.venv` 之外）再换成同一发行版的无控制台版本；取不到替代品或替换失败就**拒绝启动**并说明。换没换过都会如实报告，绝不静默替换；回滚就是用备份原件覆盖回去。

### 自动启动（按需，默认开）

会话开始时（宿主半订阅 `agent/session-start`）**先探一次 `/health`**，然后：

| 探测结果 | 行为 |
| --- | --- |
| 通过（已经在跑） | **采纳**：不重启、不写任何文件、进程标识不变 |
| 不通过 | **后台冷启动**（约 44–73s）：不阻塞会话，面板显示「正在后台冷启动」；失败按 1/5/15/30 分钟**退避**，同一失败不重复提示 |

- 自动启动**复用与手动启动完全同一条命令**（同一净化、同样不调用 `profile create`），所以 profile 仍是唯一真源。
- 开关是本插件 settings 命名空间里的一个键：`hindsight-model.autoStart`（默认 `true`）。关掉即回到纯手动；settings 服务不可用时开关**禁用并说明**，不会假装已保存。
- 宿主不提供会话生命周期能力时**降级为仅手动**，面板写明「宿主未提供会话事件」，不报错。
- 成功/失败都在面板显示「上次自动启动」的结果——**绝不静默**。

### 启动来源与窗口风险

面板标注当前守护进程**是谁拉起的**，以及它**会不会弹控制台**：

| 来源 | 含义 |
| --- | --- |
| 自动（本插件） | 由上面的按需自动启动拉起 |
| 手动（面板） | 由面板的启动 / 重启按钮拉起 |
| 外部（本插件之外） | 其它途径拉起的（例如官方 `hindsight` 行）：**只采纳、不重启** |
| 未知 | 监听端口的进程无法确认，**不猜** |

判定只用可观测证据：监听端口的进程、其镜像路径，以及**本进程这次做过什么**（不写标记文件）。若镜像属于会分配控制台的形态，会同时标出「**有控制台窗口风险**」——那正是「用 `uv` 启动但 venv 的 pythonw 是控制台跳板」这类情况唯一的可见信号。

## 已知行为与能力边界

### 0.2.0 起的两条路线（能力探测，两代同一份代码）

- **自动启动开关**：0.1.x 走 `settings.register`/`installSection` 注册命名空间；**0.2.0 退役了这两个 API**，命名空间就是本插件的 profile 条目，因此宿主半导出 `Config`（`autoStart`）让该条目成为「可配置条目」——读 = `apply(ctx, config)`，写 = `settings.update(条目 id, …)`（随后条目重启、apply 再跑一次）。设置页与面板改的是同一个键。
- **读 DSH 的 key/model**：0.1.x 用 `settings.get(ns)`；0.2.0 的设置服务没有 `get`，改为 `describe()` 按 ns 取 `value` 再沿 `llm.listConfigurableProviders()` 给的 `settingsPath` 下钻（0.2.0 的 ns 就是条目 id）。取不到时如实降级为 `available:false` 并写明缺哪一段，绝不猜。

- **上游会整体重写 `.env`**：任何经过官方启动路径的动作都会 `write_text(render_config(...))` 重建该文件，且**只把「传入配置里有的键」写成活动行**。本插件的行级写入依赖「启动路径会把既有非小写键带过去」这一点存活；**外层存在同名键、或官方插件用残缺配置走了一次 `profile create --merge` 时，你的键会丢**——这正是面板要把 ③ 列出来的原因。别把它当插件 bug。
- **官方插件的自动拉起在本机不生效**：它的 `preflightDaemon()` 里 `detectLlm()` 只认宿主进程 env 的 `HINDSIGHT_API_LLM_PROVIDER` / `OPENAI_API_KEY` / … 或 `which claude`（Windows 上没有 `which`），而你的 provider 写在 profile `.env` 里，于是它每次只记一条 `daemon_no_llm` 就返回。**即使把那份 env 补给它也不建议**：它的启动器那条 `spawn(uv)` 没做窗口隐藏（实测会新开一个 `conhost`），并且 `daemonEnv()` 会把宿主 env 里所有 `HINDSIGHT_API_*` 交给 `profile create --merge` 写回 profile——等于让「外层 env 会赢」。**自动启动现在归本插件**（见上文），它走同一条被净化、不碰 `profile create` 的命令；官方那条不动也无妨，已健康就采纳。
- **只跟随一个 profile**：`coding-agent.json` 里的 `daemonProfile`；不做多 profile 切换，**也不做**开机自启（Windows 服务 / 任务计划）或崩溃监护。
- **宿主进程环境变量清不掉**：它来自启动 `dsh web` 的上层环境，插件只能如实显示并保证自己 spawn 的子进程做了净化。要彻底清掉，得在你启动 DSH 的地方去掉那个变量。
- **密钥只写不读回**：`api_key` 字段是单向的；诊断与日志只记键名与长度，不含取值。备份文件（profile 的 `*.bak-*` 与 HKCU 导出）本身含明文，请注意。
- **只跟随一个 profile**：`coding-agent.json` 里的 `daemonProfile`，不做多 profile 切换、不做开机自启或崩溃重启。
- **Windows 限定**：依赖 `reg query` 与 PowerShell；非 Windows 下相关层降级为「未知」，启停区块禁用，其余照常。

## 宿主端点

客户端面板通过同源 `fetch` 调这几个端点（`kind: 'exact'`，前缀 `/__hindsight-model`）：

| 方法 | 路径 | 作用 |
|---|---|---|
| `GET` | `/__hindsight-model/state` | 四层 + 字段三态 + 冲突源 + 重启命令 + 备份列表（密钥只回元信息） |
| `POST` | `/__hindsight-model/save` | `{changes: {KEY: value\|null}, useDshKey?}` → 备份 + 行级改写 |
| `GET` | `/__hindsight-model/dsh-model` | 预填数据（含密钥元信息，不含明文） |
| `POST` | `/__hindsight-model/verify` | 生效判定 + 启动日志三件套 + 最近的 LLM 调用 |
| `POST` | `/__hindsight-model/clean-env` | 导出 HKCU 备份 + 删除冲突键（需 `confirm: true`） |
| `POST` | `/__hindsight-model/daemon` | `{action: 'start'\|'stop'\|'restart', confirm?}` → 启停并回带新状态（`stop`/`restart` 需 `confirm: true`） |
| `POST` | `/__hindsight-model/auto` | `{enabled: boolean}` → 写 settings 键 `hindsight-model.autoStart`，回带新状态；settings 服务不可用时 500 并说明缺口 |

方法不符回 `405`，未管理的键回 `400`，内部异常回 `500`（均为 JSON）。

## 安装 / 启停

由仓库的**本地插件管理器**（`dsh-plugin-manager`）统一安装与启停，**不要**单独用 `dsh plugin add` 装它：子插件自带 `dsh.bundle` 会被塞进 profile bundles，与管理器写的激活行同 id → `dsh web` 启动直接失败（`duplicate loader entry id`）。踩坑记录见 `docs/knowledge/2026-09-10-retire-bundle-install.md`。

本插件**不声明** `dsh.bundle`、目录内**不放** `cordis.patch.yml`。

## 开发 / 验证

```bash
node sub-plugins/dsh-hindsight-model/test/bundle.test.mjs   # 逻辑 harness（113 条：纯函数 / 四层读取 / 写入回滚 / 端点契约 / 面板渲染 / 自动启动与启动器自愈）
node --check sub-plugins/dsh-hindsight-model/src/index.js
node --check sub-plugins/dsh-hindsight-model/src/client.js
node --check sub-plugins/dsh-hindsight-model/src/host-core.js
```

- 宿主半（`src/index.js` + `src/host-core.js`）改动 → **重启 GUI host** 才生效。
- 客户端半（`src/client.js`）改动 → **刷新页面**即可。
- 浏览器手测见 `ACCEPTANCE.md`；设计取舍与取证见 `openspec/changes/2026-09-13-add-hindsight-model-panel/design.md`。
