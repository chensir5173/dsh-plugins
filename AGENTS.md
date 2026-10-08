# dsh-plugins — Agent 指引

DSH 插件开发/收集仓库（本地 git monorepo；每个插件是独立子目录，各自带 `README.md` 与 `ACCEPTANCE.md`，先例：`dsh-open-session-workdir`、`dsh-composer-history-recall`）。

## 开始前先读
- **项目知识库索引：`docs/knowledge/README.md`** — 接手新任务或提问前先看索引，再按需点开具体篇目；每完成一段开发在此新增一篇并登记一行。
- 开发规则：本仓库无项目级规则索引，按 `developer-principles` 采用用户级 `~/.agents/rules/index.md`。

## 开发 / 验证

改完**至少跑对应测试**；全部离线可跑、不起服务器、不开端口、不碰正在运行的 `web` profile。

```bash
# 管理器（7 支）
node dsh-plugin-manager/test/host-core.test.mjs        # 宿主纯逻辑：扫描/行变换/状态/迁移规划/意图合并/批量规划/链接态
node dsh-plugin-manager/test/bundle.test.mjs           # 客户端注册与面板逻辑（React shim + fetch stub）
node dsh-plugin-manager/test/debounce.test.mjs         # 真 handler + 临时 DSH_HOME：连点只写一次 patch + 陈旧链接自愈
node dsh-plugin-manager/test/batch-remove-all.test.mjs # 批量「全部移除」：一次写/一次安装/双回滚
node dsh-plugin-manager/test/uninstall.test.mjs        # 自包含卸载脚本：恰好一次写/一次安装/其它键不动/幂等
node dsh-plugin-manager/test/root-install-shell.test.mjs # 仓库根安装外壳（20 条断言，含两处版本一致）
node dsh-plugin-manager/test/entry-config.test.mjs     # 宿主半的 0.2.0 条目配置契约（5 条：Config 三成员 / 宽松校验 / apply 读取 / 不覆盖 / 0.1.x installSection 路线）
# 子插件（每个包的 bundle.test.mjs 校验 manifest + 注册 + patch）
for f in sub-plugins/*/test/*.test.mjs; do node "$f" || echo "FAIL $f"; done
```

- 面板状态标签与批量取舍**以源码为准**：状态由 `deriveStates()` 给出 `active/disabled/legacy/uninstalled/inactive/invalid`，客户端标签在 `src/client.js`（`已激活 / 已停用 / 旧布局 / 未激活 / 未激活(仅依赖) / 非插件目录`）；`batchPlan()` 开启方向只吃 `disabled`+`uninstalled`，关闭方向只吃 `active`。
- 新增插件：在 `sub-plugins/` 下建 `dsh-xxx/`，`package.json` 含 `name`/`main`/`exports["./client"]`/`dsh.client`，**不声明 `dsh.bundle`**、目录内**不放** `cordis.patch.yml`，配 `README.md` + `ACCEPTANCE.md` + `test/bundle.test.mjs`；管理器自动扫描到它，无需改仓库根任何清单。
- 已知证据缺口：`dsh-plugin-manager/test/batch-toggle.test.mjs` **从未入库**，但 `ACCEPTANCE.md` A10 有 5 条 `[x]` 引用它 —— 补出来之前那几条不成立。harness 复用 `debounce.test.mjs`（真 `registerHttp` + 假 web 服务器 + 临时 `$DSH_HOME`）加 `src/index.js` 导出的 `__setPnpmRunner` 桩。

## 每个插件做什么、怎么用
回答「X 插件干嘛的 / 在哪触发 / 有什么前提」先看 **`docs/plugins.md`**（用法索引，含核对过的槽位与 order 分布）。写/改任何插件文档前注意：本仓库多次出现「文档声称存在、实际文件不存在」，因此**文档里的每条命令与每个 order/端点都要从源码核对**，不要照抄旧 README。

## 插件统一安装（先读 README）
只装 `dsh-plugin-manager` 一个本地 bundle；子插件源码在 `sub-plugins/`（管理器自身仍在仓库根），子插件根与仓库根都会被扫描。激活清单（真相源）是 profile `cordis.patch.yml` 中由管理器维护的稳定 id 行。涉及「安装/卸载/新增插件、profile 结构、bundles」时先读根 `README.md` 的「安装」与「⚠️ 子插件不要用 `dsh plugin` 装卸」，不要直接逐个 `dsh plugin add` 本地插件。

### 本地插件包一律不声明 `dsh.bundle`（2026-09-10 起）
- `sub-plugins/dsh-*/package.json` MUST NOT 声明 `dsh.bundle`，目录内 MUST NOT 有包自带 `cordis.patch.yml`；仓库根 MUST NOT 再提供聚合伞包 `dsh-local-plugins`（聚合 `cordis.patch.yml` 已删除，根不再有任何列出子插件激活行的清单）。
- **唯一例外：管理器的安装外壳**（2026-09-10 提出，**2026-09-11 才真正落地**）—— 根 `package.json` 可以声明 `dsh.bundle`，但 MUST 满足：`name` = `dsh-plugin-manager`（包名即插件身份：profile `dependencies` 键 / bundle 层名 / 激活行 id / 浏览器模块表 id）、`private: true`、`type: module`、`main`/`exports["."]` 转发到 `dsh-plugin-manager/src/index.js`、`exports["./client"]` 与 `dsh.client` 与包内一致、`dsh.bundle.patch` 指向 `dsh-plugin-manager/cordis.patch.yml`、**不声明任何依赖**、**不带 `dsh.profile.bundles`**、**不设 `files` 白名单**。目的是让 `dsh plugin --profile web add <仓库根>`、`add <仓库根>/dsh-plugin-manager` 与 **`add git+https://github.com/Chen5173/dsh-plugins.git`（及 `github:` 简写）三者等价**。这些约束由 `dsh-plugin-manager/test/root-install-shell.test.mjs`（20 条断言）强制：改名 / 漏转发 / 加子插件依赖 / 加 `files` / 加根 patch / 子插件复活 `dsh.bundle` 全部判红（2026-09-11 用 11 个变异验证过确实判红）。
- **为什么要外壳才能吃 git 地址**：`dsh plugin add` 只是把 `pnpm add <spec>` 转发到 profile 目录，pnpm 安装 git 依赖时**把 clone 的根目录当作那个包**，包名取自根 `package.json` 的 `name`。没有根清单时 pnpm 退化用仓库目录名当包名（实测叫 `dsh-plugins`/`pre.git`）、且因没有 `dsh.bundle` 被 reconcile 判成普通依赖并打 `declares no dsh.bundle — installed as a plain dependency, not a profile layer`，**永不激活**。`files` 白名单会把 `sub-plugins/` 从安装内容里裁掉，而管理器正是靠该目录扫子插件（实测：clone 内含整棵工作树，`repoRootOfPluginSrc` 直接适配，无需改代码）。
- **git 装的是快照，不是活链接**：改仓库源码不即时生效，升级走 `dsh plugin --profile web update`；开发期要热改用本地路径入口。两种入口互换只改写同一个 `dsh-plugin-manager` 依赖键，不产生第二条 bundle 层（实测收敛）。
- 原因：子插件的激活行由管理器写在 profile `cordis.patch.yml`。若包同时声明 `dsh.bundle`，一次 `dsh plugin --profile web add <子插件目录>` 就会把它塞进 `dsh.profile.bundles`，包自带 patch 与管理器行**同 id 各插一次** → `dsh web` 启动失败 `duplicate loader entry id: <rowId>`（已实测复现）。
- 卸载/停用只能走管理器面板：`dsh plugin --profile web remove <子插件包名>` 只摘依赖、不删管理器写的激活行，会留下悬空行使下次启动报 `failed to import loader entry …: Cannot find package …`（同样已实测）。
- **版本必须跟着插件走（2026-09-22 起）**：只要改了任一子插件或管理器自身（源码 / 行为 / 示例脚本 / 面板），提交前把 **根外壳 `package.json` 与 `dsh-plugin-manager/package.json` 的 `version` 同步 patch 递增**（两处必须一致，由 `test/root-install-shell.test.mjs` 的 "shell and inner package carry the SAME version" 守住）。理由：git 安装时 pnpm 认的是**根外壳**那份清单，版本就是用户与面板判断"这份快照有多新"的唯一信号；子插件各自的 `version` 保持独立、不强制动。"有改动就必须 bump" 需要 git 基线、无法离线单测，因此是**提交前的人工/AI 自检项**。
- 变更记录与实测证据：`openspec/changes/archive/2026-09-10-retire-local-plugin-bundle-install/`。

<!-- GRAPHFLOW:BEGIN managed block — edit outside these markers only -->
# GraphFlow for Claude Code

Use GraphFlow as a local orchestration and context service.

## Recommended setup

Add a local MCP server entry that launches GraphFlow over stdio:

```json
{
  "mcpServers": {
    "graphflow": {
      "command": "npx",
      "args": ["-y", "--package=@roarpeng/graphflow", "graphflow-mcp"]
    }
  }
}
```

During repository development you can also point Claude Code at this checkout:

```json
{
  "mcpServers": {
    "graphflow": {
      "command": "npm",
      "args": ["run", "start:mcp"],
      "cwd": "."
    }
  }
}
```

## Usage guidance

- Ask GraphFlow to plan before broad changes: `graphflow_plan`.
- Ask GraphFlow to compress and anchor code context: `graphflow_context`.
- Always pass `rootDir` = this project's absolute path. **Never** pass your home directory, AppData, or an unexpanded `${workspaceFolder}` placeholder — GraphFlow refuses unsafe workspace roots. If a call answers `unsafe workspace root`, retry the same call without `rootDir` (the server then uses its configured workspace).
- Ask GraphFlow to inspect graph state or skill learnings when the repo history matters.
- After executing work from a `graphflow_run` `executionDescriptor`, **must** call `graphflow_report_outcome` with the `episodeId` from the run result, a `success` boolean, and optional `lessons` to close the skill flywheel loop.
- Fall back to `graphflow ... --json` only if MCP is not available (including `graphflow --json outcome report <episodeId> <success>`).

DeepSeek Harness: `dsh plugin --profile web add @roarpeng/graphflow` (or `npx @roarpeng/graphflow install` when `~/.dsh` exists).
<!-- GRAPHFLOW:END -->
