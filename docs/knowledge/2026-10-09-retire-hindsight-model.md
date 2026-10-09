# 2026-10-09 退役 `dsh-hindsight-model`：面板摘掉、profile 行置 `disabled`、源码保留

## 一、结论先写（可复用）

「暂时废弃一个子插件」在本仓是**两个动作**，缺一不可：

1. **仓库层——退役（面板不再列出）**：往 `dsh-plugin-manager/src/host-core.js` 的 `RETIRED_PLUGIN_DIRS` 加目录名（带日期与理由的注释），`listRepoPluginDirs()` 扫描时 `if (RETIRED_PLUGIN_DIRS.includes(e.name)) continue` 跳过。目录、README/ACCEPTANCE、测试**全部保留**，`readPluginMeta` 仍能读到 manifest。
2. **profile 层——停用（功能才真的停）**：退役**只动扫描**，profile `cordis.patch.yml` 里那条激活行与 `package.json` 里的依赖键**原样还在** ⇒ 宿主下次启动照旧加载它。要让功能停，给那一行加 `disabled: true` —— 这正是管理器面板「停用」写的**同一个字段**：`host-core.js` 的 `withDisabled(item, disabled)` 写它（`if (disabled) next.disabled = true; else delete next.disabled`），`deriveStates`/面板状态用 `found.row.disabled === true || found.item.disabled === true` 读它。

> 只做 ① 会得到一个「面板里找不到、但还在跑」的插件；只做 ② 会得到一个「停了但面板还列着、随时能再开」的插件。用户说「废弃功能」时通常要的是 ①+②。

**恢复**：功能 = 删掉 profile 那行的 `disabled: true`（DSH 重启后生效）；面板 = 再从 `RETIRED_PLUGIN_DIRS` 删掉名字。两件事**互相独立**，恢复功能不必先恢复面板。

## 二、为什么这次退役

- 直接原因：用户 2026-10-09 要求「暂时废弃掉 hindsight 子插件的功能」。
- 它是本仓唯一的「**外部 Python 守护进程的配置面板 + 启停控制**」型子插件：读 `~/.hindsight/coding-agent.json`（`daemonProfile` / `apiPort` / `embedPackagePath`）、写 `~/.hindsight/profiles/<profile>.env`（行级 RMW + 时间戳备份 + 原子写），并在会话开始时探 `GET http://127.0.0.1:<apiPort>/health` —— 已经在跑就采纳，没在跑就**后台冷启动**那个守护进程（约 44–73s，失败按 1/5/15/30 分钟退避）。**它不是只读面板**：留着它 = 留着那条自动拉起链路，所以退役必须同时停 profile 行。
- Hindsight 本体（web profile bundle 里的 `@vectorize-io/hindsight-coding-agents`）与本插件**没有依赖关系**：进程、凭据、模型语义三样都隔离，它有自己的 `hindsight` 行。退役本插件**不会**停掉 Hindsight 记忆功能。
- 它在 0.2.0 线上本就半残：面板「自动启动」开关不可写（提示设置不可写）、`useDshKey` 永远 `available:false`（2026-09-29 审计结论）。

## 三、与 2026-09-18 那次退役（`dsh-open-session-workdir`）的差异

| 维度 | `dsh-open-session-workdir`（2026-09-18） | `dsh-hindsight-model`（2026-10-09，本次） |
|---|---|---|
| 退役理由 | 被核心取代（重复品） | 用户要求暂时废弃、不再维护 |
| profile 处置 | 当时未激活，无需动 | **原本激活** ⇒ 该行置 `disabled: true`（保留行与依赖） |
| 宿主端点 | 无 | **有** `/__hindsight-model/*`（随退役不再注册） |
| `openspec/specs/` 与测试 | 未改 spec；测试保留 | 同上 |

**为什么不动 `openspec/specs/`**：`openspec/specs/session-workdir-open/spec.md` 退役后**原样保留、无退役注记** —— 退役是运行/面板层的取舍，不改插件的需求契约（源码与测试都还在跑）。本次照此办理，`openspec/specs/hindsight-model/spec.md` 不动。

## 四、这次改了什么

- `dsh-plugin-manager/src/host-core.js`：`RETIRED_PLUGIN_DIRS` 加第二项（带理由注释与恢复步骤）
- `dsh-plugin-manager/README.md`：退役名单表加一行 + 补一句「本次退役的实例已在 profile 里置 `disabled: true`」
- `docs/plugins.md`：插件总表该行改退役样式、`### dsh-hindsight-model` 章节加退役横幅、「本地插件页 tab」表与「宿主 HTTP」表摘掉对应条目（表后补一句说明）
- `sub-plugins/dsh-hindsight-model/README.md`：顶部退役横幅（原文保留作历史参考）
- `docs/knowledge/README.md`：索引加一行
- `package.json` + `dsh-plugin-manager/package.json`：**0.3.10 → 0.3.11**（仓库规则：动管理器就同步 patch）
- **仓库之外**：`C:\Users\chenjunhao04\.dsh\profiles\desktop\cordis.patch.yml` 的 `- id: hindsight-model` 那一行加 `disabled: true`

## 五、验证

- `node dsh-plugin-manager/test/root-install-shell.test.mjs`：真实仓库上逐项断言「退役目录**在磁盘上** + **不在** `listRepoPluginDirs()` 里 + manifest 仍可读」——该用例直接遍历 `RETIRED_PLUGIN_DIRS`，所以加第二项自动被覆盖。
- `node dsh-plugin-manager/test/host-core.test.mjs`：合成仓库（两个 root 各放一份退役目录）扫描只返回非退役项。
- `node sub-plugins/dsh-hindsight-model/test/bundle.test.mjs`：退役不删源码，套件仍应全绿（这是「源码保留」的实际证据）。