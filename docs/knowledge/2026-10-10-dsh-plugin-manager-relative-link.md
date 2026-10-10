# dsh-plugin-manager：子插件依赖改用相对 `link:`（workspace 锚点退役）

日期：2026-10-10　变更：`2026-10-10-relative-link`（验收清单见 `dsh-plugin-manager/ACCEPTANCE.md` A16）；**取代** [2026-10-09-dsh-plugin-manager-workspace-anchor.md](2026-10-09-dsh-plugin-manager-workspace-anchor.md)

## 问题与结论

- 症状：面板「已开启 0 个本地插件 / 失败 8 项」，全部 `(pnpm install failed)`。
- 根因：管理器把 profile 的 workspace 锚点 glob 写成 `<profile>/node_modules/dsh-plugin-manager/sub-plugins/*`（git 安装时 `REPO_ROOT` 由 `src` 反推，落在 `node_modules` 内），而 **pnpm 枚举 workspace 成员时跳过 `node_modules` 下的路径** ⇒ 8 条 `workspace:*` 全部 `ERR_PNPM_WORKSPACE_PKG_NOT_FOUND`、install 退出码 1 ⇒ `ensureDevDeps` 回滚 profile `package.json` ⇒ 0 成功。
- 新做法：devDependency 写**相对 profile 目录的 `link:`**（指向 profile 里那份拷贝），不再依赖任何 workspace 锚点：
  `"<name>": "link:./node_modules/dsh-plugin-manager/sub-plugins/<dir>"`；只有镜像目录不可达时才退回 `link:<插件绝对目录>`。

## 可复用的实测结论（pnpm 11.21 / Node 22 / Windows）

- **pnpm 跳过 `node_modules` 下的 workspace 成员**：`packages: ['.', '<profile>/node_modules/dsh-plugin-manager/sub-plugins/*']` 不产出 `Scope: all …`，`workspace:*` 全部解析失败；把同一批目录换成 `pkgs/*` 或仓库真实 `sub-plugins/*` 立刻 `Scope: all 2 / all 11 workspace projects`。
- **相对 `link:` 指向 `node_modules` 内的真实目录可用**：`"dsh-fake": "link:./node_modules/dsh-plugin-manager/sub-plugins/dsh-fake"` + `pnpm-workspace.yaml` 只有 `packages: ['.']` → `pnpm install --offline` 退出码 0，`node_modules/dsh-fake` 可 `require`。
- **pnpm 不改写相对 `link:` 规格**：install 后 `package.json` 里那条字符串**逐字节不变** ⇒ 「就绪判据 = 规格与期望全等」不会反复触发 install（换成会被改写的形态就会死循环）。
- **pnpm 的错误写在 stdout**：`ERR_PNPM_*` 全程落在 stdout、stderr 为空；只取 stderr 的 `execPnpm` 会把它吞成兜底文案 `pnpm install failed`（面板只见这一句，看不到真因）。
- **本沙箱造不了符号链接**：`cmd /c mklink /J` → Access is denied.；`fs.symlinkSync(t, p, 'junction')` → EPERM ⇒ 依赖 junction 的测试必须带 `cpSync` 回退，也别指望离线验证「镜像目录」类方案。

## 设计要点（实现依据）

- `linkDepSpec(profileDir, meta, io)`：镜像存在 → `LINK_PROTOCOL + './' + path.relative(profileDir, mirror)`（正斜杠）；否则 `'link:' + meta.dirPath`；两者皆缺 → `null`。`mirrorDirOf()` 只要求 `profileDir` 与 `meta.dir`（不要求 `dirPath`）。
- **锚点只留残留清理**：`retireWorkspaceGlob(doc, repoRoot)` 只删形状匹配本仓库的条目；干净文档 `changed: false` 零写入、幂等；`upsertWorkspaceGlob` / `WORKSPACE_SPEC` / `workspaceDepSpec` 全删。
- **就绪判据**：`fresh` = 规格与期望**全等**（不再看锚点）；`stale-mismatch` 覆盖旧 `workspace:*`、遗留绝对 `link:`、版本号、`file:`；`stale-unresolved` = 规格对但目录不存在。
- 迁移（`planMigration`）把旧 `workspace:*` 键与遗留绝对 `link:` 一并改写成相对规格。

## 坑

- 别对含 junction 的目录用 `fs.rmSync(dir, { recursive: true })`（Node 会跟随链接删目标内容，见 2026-10-09 篇）。
- 测试里凡断言 devDependency 形状的，都要按「临时 profile **无**镜像 ⇒ 期望绝对回退形态」构造期望值（`'link:' + path.join(repoRoot, 'sub-plugins', dir).split(path.sep).join('/')`）。
