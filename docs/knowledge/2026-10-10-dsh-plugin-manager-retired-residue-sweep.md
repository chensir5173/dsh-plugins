# dsh-plugin-manager：退役插件的存量清理（patch 行 / 依赖键 / node_modules 链接点）

日期：2026-10-10　变更：`2026-10-10-retired-residue-sweep`（验收清单见 `dsh-plugin-manager/ACCEPTANCE.md` A17）；承接 [2026-10-09-retire-hindsight-model.md](2026-10-09-retire-hindsight-model.md)

## 问题与结论

- 症状：`dsh-hindsight-model` 已退役（扫描排除），但 DSH 插件列表仍有 `hindsight-model` 幽灵条目——那行 `cordis.patch.yml` 激活行没人删。
- 根因：退役只动了扫描（`RETIRED_PLUGIN_DIRS`），profile 三处残留原样：**激活行**（DSH 读 patch 渲染列表）、**`package.json` 依赖键**、**`node_modules/<包名>` 链接点**（pnpm `link:` 装出来的 junction，目录还在但脚本不认）。
- 修法：宿主每次启动（闸闩一次）+ 每次安装/迁移之前自动 sweep：`ensureRetiredSwept(c)` 快照 → 纯函数剥离 → **真变了才**备份改写（幂等零写入）；键清理**不跑 pnpm**；链接点只删 junction/symlink/断链、真实目录绝不动。结果记 `/status` `hostDiag.retiredSweep`。

## 可复用的实测结论（Node 24 / Windows / pnpm 11.21）

- **Node 识别不了 pnpm 的 junction**：目录 junction 上 `lstatSync().isSymbolicLink() === false`、`readlinkSync` 抛 `EINVAL`、`lstat` 与 `stat` 的 dev/ino **完全相同**（lstat 直接报告 target 身份）——三条常规判据全灭。
- **可行判据是 dev/ino 相等**：junction 的 lstat dev/ino === 目标源目录的 dev/ino（NTFS 同 ino = 同一对象；Windows 没有目录硬链接 ⇒ 两个路径同 ino 必是 junction）。`node_modules` 里**真实目录**的 ino 是它自己的 ⇒ 绝不误删。
- 断链 = lstat 能过、stat 抛 ENOENT；`fs.rmdirSync` 删 junction 只删链接点（源目录实测完好）——与 `rmSync(recursive)` 冲突（会跟进目标，见 2026-10-09 篇）。
- 无特权进程建不了真 symlink（`symlinkSync(...,'dir')` EPERM），所以测试只能造 junction；仓库 blob 是 LF、工作区常被 CRLF 污染（见 A16 教训）。

## 设计要点

- 单一事实源 `retiredRowIds()`（`RETIRED_PLUGIN_DIRS.map(rowIdOfDir)`）：加列新退役目录 ⇒ 扫描排除 + sweep 范围同时生效。
- 纯函数返回**原引用**当「零写信号」：`stripRetiredPatchRows` / `stripRetiredManifestKeys` 干净时返回入参引用，调用方据此跳过备份与写盘。
- **前置位置要精确**：sweep 必须在 `readManifest` **之前**（早于 `ensureDevDep` 主体），否则函数持有的旧 manifest 副本会把刚清掉的键写回盘上。
- 错误绝不阻断安装：js-yaml 缺失只跳过 patch 部分，每步异常记入诊断；`ensureWorkspaceRetired`（锚点清理）是同一形状的姊妹件。

## 坑

- `classifyNodeModulesLink` 接收的 repoTargets 用 `BigInt(ino)` 比较（NumericString 格式）；并排除 `path.resolve` 相等的那一支（自己链接自己不算残留）。
- 测试借真实 profile 的 js-yaml 用 `cpSync`（junction symlink 会 EPERM）；动态 `import(绝对路径)` 在 Windows 会 `ERR_UNSUPPORTED_ESM_URL_SCHEME`，测试一律静态相对 import。
