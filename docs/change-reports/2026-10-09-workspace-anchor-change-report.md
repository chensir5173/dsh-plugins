# 变更报告：子插件依赖去绝对路径（pnpm workspace 聚合）

- **日期**：2026-10-09
- **变更名**：`2026-10-09-workspace-anchor`（验收清单：`dsh-plugin-manager/ACCEPTANCE.md` A15）
- **需求（用户原话）**：「当前项目不要再使用 link 绝对地址的方式来管理插件了，迁移的时候容易报错。」
- **版本**：根 `package.json` 与 `dsh-plugin-manager/package.json` 同步 `0.3.9 → 0.3.10`

## 改动前的问题

profile `devDependencies` 里每个受管子插件都是一条 `link:<绝对目录>`。换机器、换 `DSH_HOME`、把仓库挪个位置，这些绝对路径全部失效；N 个子插件就有 N 条路径要修，失效后面板只能显示「未激活(仅依赖)」，下次启动报 `Cannot find package`。

## 改动后的模型

- profile `devDependencies`：`"<name>": "workspace:*"` —— **零路径**。
- profile `pnpm-workspace.yaml`：管理器维护**唯一一条** glob `<repo>/sub-plugins/*`（其余 glob 与键一个都不动），只在需要时整体重写并留 `*.bak-<ts>`。
- 解析路径不变（profile `node_modules/<name>` → 仓库目录），patch 行的 name 仍是纯包名 ⇒ 设置页的标题/描述/图标与 `metaOf` 行为完全不变。
- 管理器自身那条 `link:<repo>` 是**安装入口**（`dsh plugin add` 写入），管理器不自行改写，避免锚点异常时把自己锁在外面。

## 文件级改动

| 文件 | 改动 |
|---|---|
| `dsh-plugin-manager/src/host-core.js` | 新增 `WORKSPACE_FILE` / `WORKSPACE_PROTOCOL` / `WORKSPACE_SPEC`、`isWorkspaceSpec`、`workspaceDepSpec`、`forwardPath`、`samePath`（原 `sameLinkTarget`）、`pluginsGlobOf`、`workspaceGlobCandidates`、`isPluginGlobShape`、`workspaceStateOf`、`upsertWorkspaceGlob`、`staleDepSpec`（原 `staleLinkSpec`）、`depStateOf`（原 `linkStateOf`）、`repairPlan`（原 `relinkPlan`）、`REPAIR_REASONS`、`DEP_STATES`（原 `LINK_STATES`）、`FS_IO`（原 `LINK_IO`）；`makeYamlEngine` 增加 `loadDoc` / `dumpDoc`；`deriveStates` 增加 `workspace` 入参与 `depState` / `depDeclared` / `depExpected`；`planMigration` 改写 `workspace:*` 并产出 `newWorkspace`；删除 `linkSpecOf` |
| `dsh-plugin-manager/src/index.js` | 新增 `readWorkspaceDoc` / `workspaceSnapshot` / `ensureWorkspaceGlob`；`ensureDevDep(s)` 先维护锚点再写 `workspace:*`（失败回滚）；`snapshot` 带 workspace；`/list` 的 `linkPlan → repairPlan` 并新增 `workspace` 段；`/relink → /repair`（旧路径保留为别名）；`/migrate` 写锚点并纳入回滚；`/status` 增加 `workspace` / `workspaceRepair` 诊断 |
| `dsh-plugin-manager/src/client.js` | 「重定位」→「修复依赖」、「链接陈旧」→「依赖待修复」、「自动重定位已关闭」→「自动修复依赖已关闭」等中英文文案；改读 `repairPlan` 与 `p.depState` / `p.depDeclared`；POST `/repair` |
| `dsh-plugin-manager/tools/uninstall-manager.mjs` | 受管依赖键改为按**包名**识别（`workspace:*` 不含路径），保留对遗留 `link:` 指向本仓库的兼容；新增从 `pnpm-workspace.yaml` 摘掉本仓库那条 glob（备份 + 可回滚） |
| 测试 | `host-core.test.mjs`（新增依赖态矩阵与锚点分组）、`bundle.test.mjs`（文案/端点/`repairPlan`）、`uninstall.test.mjs`（新增 workspace 场景）；`debounce.test.mjs`、`batch-remove-all.test.mjs` 仅机械改名 |
| 文档 | `dsh-plugin-manager/README.md`、`ACCEPTANCE.md`（新增 A15 + A14 取代说明）、`openspec/specs/plugin-manager/spec.md`（顶部变更注记）、`docs/plugins.md`、`docs/knowledge/2026-10-09-dsh-plugin-manager-workspace-anchor.md`（+ 索引行） |

## 验证

| 验证 | 命令 / 方式 | 结果 |
|---|---|---|
| 纯逻辑 | `node dsh-plugin-manager/test/host-core.test.mjs` | PASS（含依赖态矩阵 + 锚点幂等/自愈用例） |
| 客户端契约 | `node dsh-plugin-manager/test/bundle.test.mjs` | PASS（「stale deps…」用例改名并覆盖新文案/端点） |
| 卸载 | `node dsh-plugin-manager/test/uninstall.test.mjs` | PASS（含新增 `workspace:*` + 锚点清理场景） |
| 配置/外壳 | `node dsh-plugin-manager/test/entry-config.test.mjs`、`test/root-install-shell.test.mjs` | PASS |
| 端到端（隔离 `DSH_HOME`、pnpm 用桩） | 造 profile：两条 `link:`（一条当前目录、一条 `D:/old/machine/...`）+ `pnpm-workspace.yaml` 仅 `packages: ["."]`，注册管理器 handler 后依次 `GET /list` → `POST /repair` → `GET /status` → `POST /migrate` | 启动自检把两条改写成 `workspace:*`、锚点补上 `C:/…/dsh-plugins/sub-plugins/*`（`nodeLinker`/`autoInstallPeers` 原样保留）、只跑一次 install；`/list` 两条 `fresh`、`repairPlan.count=0`；`/repair` 幂等 noop；`/migrate` 收敛 bundles 并写激活行；全过程**未触碰运行中的 web profile** |
| 真实 pnpm 迁移可行性 | 临时 profile + 真实 `pnpm@11.23.0`：`pnpm-workspace.yaml` 放行 `<repo>/sub-plugins/*` + 依赖 `workspace:*` | `Scope: all 11 workspace projects`、`node_modules/<name>` 与仓库目录同 inode、写文件即时可见、`createRequire` 可解析 `package.json` / `.` / `./client`；仓库改名后报 `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND`，改回即恢复 |
| 环境性红（既有，与本变更无关） | `debounce.test.mjs`、`batch-remove-all.test.mjs` | 本机 `symlink EPERM`（临时 profile 软链 js-yaml 被拒），用例逻辑未受影响 |

## 风险与回滚

- **锚点被写坏**：只会在需要时重写，且先前一份 `*.bak-<ts>`；锚点异常时管理器仍能从既有 `link:`（管理器自身入口）启动并自愈。
- **Junction 与 pnpm 的行为差异**：Windows 上是 junction（`lstat().isSymbolicLink() === false`，但同 inode），Linux/macOS 上是普通 symlink —— 解析行为一致。
- **回滚**：把 `host-core.js` / `index.js` / `client.js` 还原到 `HEAD~`，并把 profile 的 `devDependencies` 写回 `link:<dir>`、从 `pnpm-workspace.yaml` 删掉那条 glob 后 `pnpm install`；或直接用卸载脚本清干净再重装。

## 遗留

- `openspec/specs/plugin-manager/spec.md` 的逐条规格文本尚未逐句改写（顶部已加变更注记说明取代关系），待下一次 openspec 归档时统一更新。
- `debounce.test.mjs` / `batch-remove-all.test.mjs` 的 handler 级用例需在允许 symlink 的环境（或改用目录复制）才能跑；本次只做了改名。
