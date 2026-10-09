# dsh-plugin-manager：子插件依赖去绝对路径（pnpm workspace 聚合）

日期：2026-10-09　变更：`2026-10-09-workspace-anchor`（验收清单见 `dsh-plugin-manager/ACCEPTANCE.md` A15）

## 问题与结论

- 旧做法把每个子插件的 profile devDependency 写成 `link:<绝对目录>`：换机器 / 换 `DSH_HOME` / 移仓库后全部失效，且 N 个子插件 = N 条路径要修。
- 新做法：依赖写 **`workspace:*`（零路径）**，可解析性由 profile `pnpm-workspace.yaml` 里**一条** glob（`<repo>/sub-plugins/*`）提供；管理器负责这条 glob 的补齐、迁移与自愈（`workspaceStateOf()` / `upsertWorkspaceGlob()`）。

## 为什么不是别的方案

- **相对路径 patch 行**（`./node_modules/.../src/index.js`）：`dsh-app-boot` 的 `readPluginMeta()` 首行 `barePackageName(specifier)` 对路径形式返回 undefined ⇒ 设置→插件 列表丢掉标题/描述/图标，回退显示长路径。放弃。
- **npm/git 发布**：profile 零本地路径，但改代码要重新发布。`@linxin666/dsh-web-all` 能用是因为它自带聚合 bundle，不能照搬（它的 subpath 风格 entry 同样拿不到客户端半边）。放弃。
- **pnpm workspace**：profile 只剩 1 条路径（glob），patch 行仍是纯包名 ⇒ UI 与显示完全不变。选它。

## 可复用的实测结论（pnpm 11.23 / Node 22 / Windows）

- `pnpm-workspace.yaml` 的 `packages` 支持**仓库目录之外的绝对 glob**：`pnpm install` 输出 `Scope: all 11 workspace projects`，依赖写 `workspace:*` 即可解析出 `src/index.js` 与 `./client`。
- 安装结果是 **Windows junction**：`lstat().isSymbolicLink()` 为 `false`、`realpathSync()` 不解析（返回自身），但 `statSync(node_modules/<pkg>).ino === statSync(<repo>/sub-plugins/<pkg>).ino`，`realpathSync.native()` 能解析到仓库 —— 开发热改仍即时生效（往仓库写文件，透过 node_modules 立刻可见）。
- 仓库改名/移走后 `pnpm install` 报 `[ERR_PNPM_WORKSPACE_PKG_NOT_FOUND] … "dsh-x@workspace:*" is in the dependencies but no package named "dsh-x" is present in the workspace`，把目录改回即恢复 —— 管理器启动时的 glob 自愈正为这种情况准备。
- ⚠️ **绝不要对含 junction 的目录用 `fs.rmSync(dir, { recursive: true })`**：Node 会**跟随 junction 删除目标内容**。本次实测把仓库里 7 个子插件目录的内容删空，靠 `git checkout -- sub-plugins` 才恢复。安全做法：先用 `fs.rmdirSync(linkPath)`（对 junction 只删链接本身）或 `fs.unlinkSync` 解掉所有 reparse point，再删父目录；沙盒下 `unlink` 可能被拒，`rmdirSync` 可行。
- 行尾：本仓库源文件是 **CRLF**；用脚本改文件时要先归一化成 LF 做 `indexOf` 匹配，写回时再还原，否则多行锚点匹配不到。

## 锚点维护的两条纪律

- **形状匹配**：`isPluginGlobShape(entry)` 判定 `<任意>/sub-plugins/*`，因此迁移后**旧位置**的 glob 会被替换掉，而 `packages/*` 这类无关 glob 与 `nodeLinker` / `autoInstallPeers` 等键原样保留。
- **幂等、能不写就不写**：已就位时 `upsertWorkspaceGlob()` 返回 `changed: false`，一个字节都不落盘 —— js-yaml 整体重写会丢注释，所以 `pnpm-workspace.yaml` 只在真需要时才改写（改写前留 `*.bak-<ts>`）。
