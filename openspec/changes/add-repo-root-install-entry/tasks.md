## 1. 提案与设计

- [x] 1.1 `proposal.md`（Why 含"今天这条命令什么都没装"的实测 / What Changes / Capabilities / Non-goals / 成功判据）
- [x] 1.2 `design.md`（D1–D6 决策与理由、实测证据表、风险与回滚、已知限制）
- [x] 1.3 本变更的 spec delta（1 条 MODIFIED + 1 条 ADDED Requirement，共 8 个场景），`openspec validate add-repo-root-install-entry --strict` 通过

## 2. 实现

- [x] 2.1 新增仓库根 `package.json` 作为管理器的安装外壳：`name` = `dsh-plugin-manager`、`private`、`main`/`exports["."]` → `./dsh-plugin-manager/src/index.js`、`exports["./client"]` → `./dsh-plugin-manager/src/client.js`、`dsh.client` 与包内一致、`dsh.bundle.patch` → `./dsh-plugin-manager/cordis.patch.yml`
- [x] 2.2 不写 `"type"`（外壳无模块文件，避免改变仓库根下其它文件的模块解释）、不声明任何依赖、不列 `dsh.profile.bundles`
- [x] 2.3 复核"不复活伞包"：根仍无 `cordis.patch.yml`；包内 patch 只插一行；6 个子插件 manifest 与目录未被改动

## 3. 测试

- [x] 3.1 新增 `dsh-plugin-manager/test/root-install-shell.test.mjs`（4 组不变量：外壳存在且转发一致 / patch 只插一行 + 客户端 id === 包名 / 子插件不带 bundle 层且根无聚合清单 / 装根外壳不拉进子插件）
- [x] 3.2 该测试通过：`node dsh-plugin-manager/test/root-install-shell.test.mjs` → 4 ok / `PASS`
- [x] 3.3 全量回归：管理器 4 个 + 子插件 7 个测试文件共 12/12 通过（新增文件计入）
- [x] 3.4 失败能力对照：临时把外壳 `name` 改成别的名字 → 3.1 的第 1/2 条判红（改回后复绿），证明测试真的能挡住"外壳改名/漏转发"

## 4. 文档同步

- [x] 4.1 根 `README.md`：安装章节改为「推荐 `add <仓库根>`」并写明与 `add <仓库根>/dsh-plugin-manager` 等价；「已删除：聚合伞包」改写为「根目录现在是管理器的安装外壳（不含聚合激活行）」
- [x] 4.2 `AGENTS.md`：硬规则一节补充唯一例外 —— 只有管理器的安装外壳（根 `package.json`，同名转发）可以声明 `dsh.bundle`，且必须只插入管理器自己那一行
- [x] 4.3 `dsh-plugin-manager/README.md`：安装章节给出两条等价命令 + 外壳角色说明（同名转发的原因）
- [x] 4.4 `dsh-plugin-manager/ACCEPTANCE.md`：新增从仓库根安装/替换路径的验收项（`[H]` 真机项）
- [x] 4.5 `docs/knowledge/2026-09-10-repo-root-install-entry.md` + 索引表追加一行；`.serena/memories/core.md` 同步（gitignored，供后续会话）

## 5. 验证

- [x] 5.1 隔离 profile（`DSH_HOME` → 临时目录，**未触碰运行中的 web profile**）：`dsh plugin --profile probe add <仓库根>` → `dependencies` = `{"dsh-plugin-manager":"link:<仓库根>"}`、`bundles` = `["@deepseek-ai/dsh-base","dsh-plugin-manager"]`、无 `declares no dsh.bundle` 警告
- [x] 5.2 该 profile 启动验证：base-only（无 web app、不占端口）进程存活 15 s（`timeout` 124）且零输出 —— 无 `duplicate loader entry id`、无 `Cannot find package`
- [x] 5.3 组合结果：`dsh --profile probe --dump-config` 含 `- id: dsh-plugin-manager / name: dsh-plugin-manager`，无子插件行
- [x] 5.4 红能力对照：同 profile 加坏行 `dsh-nonexistent-xyz` → exit 1、报 `failed to import loader entry bogus (dsh-nonexistent-xyz): Cannot find package … imported from <profile dir>`（证明该构造能暴露坏行、且解析锚点就是 profile 目录）
- [x] 5.5 等价性：先 `add <仓库根>/dsh-plugin-manager` 再 `add <仓库根>` → 依赖键不变、spec 被改写、`bundles` 仍只一条、启动正常（不产生第二层/第二行）
- [x] 5.6 浏览器半定位：按 client-modules 的两条定位分支（`nearestPackage` / `exports["./package.json"]` 兜底）各跑一遍真实算法 → 10/10 断言通过：包名 `dsh-plugin-manager`、产物 `dsh-plugin-manager/src/client.js`、注册 id === 包名
- [x] 5.7 `openspec validate add-repo-root-install-entry --strict` 通过；`openspec validate --all` 无新增失败
- [ ] 5.8 真机验收（待用户）：在用户机器上执行 `dsh plugin --profile web add <仓库根>`（例如 `E:\GitHubProjects\ChenSir5173\dsh-plugins`）后重启 `dsh web`，确认设置页「本地插件」面板出现、`/list` 返回 6 个子插件状态正常、启动日志无 `duplicate loader entry id` / `Cannot find package`
