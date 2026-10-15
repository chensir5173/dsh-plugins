# dsh-plugins

本地 DSH 插件仓库。**只需安装 `dsh-plugin-manager` 一个插件**，其余子插件都在它的「本地插件」面板里点开关启用。

## 安装

```bash
# 从 git 装（不需要先 clone）：装完插件名就是 dsh-plugin-manager
dsh plugin --profile web add git+https://github.com/Chen5173/dsh-plugins.git
# 简写：github:Chen5173/dsh-plugins
# 锁版本：…dsh-plugins.git#v0.1.0（#<tag|commit|branch> 这个 ref 必须已推到远端）

# 本机开发（改源码即时生效）：装自己这份 checkout
dsh plugin --profile web add D:/ChenSirDocument/Dsh-Projects/dsh-plugins
```

然后**重启 `dsh web`** → 设置 → 左侧「本地插件」。首次进入若提示「仍以旧布局安装」，点 **一键接管/迁移**。

- git 入口装进来的是 clone **快照**：改仓库源码不即时生效，升级用 `dsh plugin --profile web update`；本机开发请用上面的路径写法。
- 三种写法（git 地址 / 仓库根 / `仓库根/dsh-plugin-manager`）等价，都只产生一个 `dsh-plugin-manager` 条目。

## 每个插件做什么、怎么用

看 **[`docs/plugins.md`](docs/plugins.md)** —— 用法索引，含每个插件的作用、在哪儿触发、前提条件，以及核对过的槽位 / order 分布表。各插件目录内另有自己的 `README.md`（行为细节）与 `ACCEPTANCE.md`（验收项）。

## 各插件速览

| 插件 | 作用 | 在哪儿用 |
|---|---|---|
| [`dsh-plugin-manager`](dsh-plugin-manager/README.md) | 管理本仓库全部子插件（先装这一个） | 设置 → 本地插件 |
| [`dsh-composer-history-recall`](sub-plugins/dsh-composer-history-recall/README.md) | 逐条召回本会话你发过的消息填回草稿（绝不自动发送） | 草稿首行按 `↑` / `↓` |
| [`dsh-esc-rewind`](sub-plugins/dsh-esc-rewind/README.md) | 停止本轮 / 回退到任意一轮重来 | `Esc`、`Esc Esc`、`/rewind`、会话头图标 |
| [`dsh-composer-provider-label`](sub-plugins/dsh-composer-provider-label/README.md) | 显示并切换实际打到的提供方、模型与推理档 | 输入框右侧模型标签 |
| [`dsh-session-title-regenerate`](sub-plugins/dsh-session-title-regenerate/README.md) | 重新生成会话标题 | 会话头按钮 / 侧栏 `⋯` / `/regenerate-title` |
| [`dsh-session-time-bucket`](sub-plugins/dsh-session-time-bucket/README.md) | 侧栏会话按时间分组 | 自动（无按钮） |
| [`dsh-idle-hook`](sub-plugins/dsh-idle-hook/README.md) | 模型不在运行时（一轮结束 / 等待批准 / 等待回答）执行你配置的本机脚本，把通知送到手机或桌面（**页面关着也生效**） | 设置 → 空闲通知 |
| ~~[`dsh-open-session-workdir`](sub-plugins/dsh-open-session-workdir/README.md)~~ **已退役** | ~~用系统文件管理器打开会话工作目录~~ | 核心已自带「Open In…」分体按钮；源码保留，面板不再列出（见该插件 README 顶部） |

详细前提（是否要重启、核心版本要求、副作用、与其他插件共存）见 [`docs/plugins.md`](docs/plugins.md)。

## ⚠️ 子插件不要用 `dsh plugin` 装卸

| 命令 | 实际后果 |
|---|---|
| `dsh plugin --profile web add <子插件目录>` | 只装成 profile 的**普通依赖，不会激活**（打印 `declares no dsh.bundle — installed as a plain dependency, not a profile layer`）。激活请用面板开关。 |
| `dsh plugin --profile web remove <子插件包名>` | 只摘依赖、**不删管理器写的激活行** → 留下悬空行，下次 `dsh web` 启动失败（`failed to import loader entry …: Cannot find package …`）。卸载请用面板「移除」。 |

`add <仓库根>`、`add git+…`、`remove dsh-plugin-manager` 都是对的 —— 它们操作的是管理器本身。

## 其他

- 往本仓库**新增插件**、安装外壳的约束、pnpm / DSH 的机制结论与踩坑记录：见 [`AGENTS.md`](AGENTS.md) 与 [`docs/knowledge/`](docs/knowledge/README.md)。
- 仓库级忽略规则见 `.gitignore`。
