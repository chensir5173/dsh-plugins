# 仓库根的管理器安装外壳（`add <仓库根>` = 装管理器）

- 日期：2026-09-10
- 相关：`openspec/changes/add-repo-root-install-entry/`、`packages/client/modules/src/index.ts`（DSH 核心，只读参考）、`dsh-plugin-manager/test/root-install-shell.test.mjs`

## 结论（可复用）

1. **仓库根 `package.json` 现在是"管理器的安装外壳"**：`name` = `dsh-plugin-manager`、`private`、无依赖，`main`/`exports["."]` → `dsh-plugin-manager/src/index.js`，`exports["./client"]` → `src/client.js`，`dsh.bundle.patch` → `dsh-plugin-manager/cordis.patch.yml`。于是 `dsh plugin --profile web add <仓库根>` 与 `add <仓库根>/dsh-plugin-manager` 用一个 dep 键（`dsh-plugin-manager`）产出一模一样的 profile 状态，可互相替换。
2. **外壳必须与被指向的包同名，这不是审美问题**：DSH 的插件身份 = **包名**，三处都用它 —— profile `dsh.profile.bundles` 条目、profile patch 里的激活行 id、浏览器模块表 id。客户端产物内 `window.__ModuleLoader__.load({ id: 'dsh-plugin-manager' })` 写死；node 侧把"定位到的包名"当作该行模块 id，与产物注册的 id 比对，不一致时浏览器报 `bundle … loaded without registering "<id>"`（`packages/client/modules/src/client/system.ts:135`）。
3. **转发链怎么被解析**（`@deepseek-ai/dsh-client-modules` 的两条分支都实测通过）：
   - 生产路径：先解析行 specifier 得到入口文件 URL，再向上找**最近的、`name` 等于 specifier 的 manifest**（`nearestPackage()`）→ 命中**包内**清单 → 用它自己的 `exports["./client"]`；
   - 兜底路径（无 Node internals）：`createRequire(baseUrl).resolve('<name>/package.json')` → 命中**外壳**清单 → 用它转发的 `exports["./client"]`。
   两条都给同一个包名与同一个产物文件，所以外壳**同时**声明 `dsh.client` + `exports["./client"]` 才不会因解析分支不同而抖。
4. **在根目录"放文件"本身不是问题，"聚合"才是问题**：伞包事故（`duplicate loader entry id`）的成因是**同一 id 的行被插两次**，所以外壳的 patch 只允许插管理器自己那一行，根目录仍然没有 `cordis.patch.yml`。这条用测试锁死。

## 复现/验证方法（隔离 profile，不碰 live）

```bash
T=$(mktemp -d); export DSH_HOME="$T/home"
node <dsh>/apps/cli/lib/bin.js plugin --profile probe add <仓库根>
node -e "const m=require(process.argv[1]);console.log(m.dependencies, m.dsh.profile.bundles)" "$(cygpath -w "$T/home/profiles/probe/package.json")"
timeout 15 node <dsh>/apps/cli/lib/bin.js --profile probe        # 存活 15s 无输出 = 无启动错误
timeout 20 node <dsh>/apps/cli/lib/bin.js --profile probe --dump-config | grep -A1 dsh-plugin-manager
```

- profile 用 `@deepseek-ai/dsh-base`（自定义 profile 模板）⇒ 不起 web server、不占端口，boot 失败仍会 loud 报错（`failed to import loader entry …: Cannot find package …`）。
- 红能力对照：往该 profile 的 `cordis.patch.yml` 加一行 `{id: bogus, name: 'dsh-nonexistent-xyz'}` → exit 1，报错里能看到**解析锚点是 profile 目录**（`imported from <profile dir>`）。
- `--dump-config` 不挂载条目，只能证明"组合结果里有这一行"，不能证明可解析 —— 两者要一起用。

## 维护约束（改动前先读）

- 改外壳的 `name`、`main`、`exports["./client"]`、`dsh.bundle.patch` 中的任何一个 → `root-install-shell.test.mjs` 判红（4 组不变量）；改名还会在浏览器侧多一道 loud 报错。
- 外壳 MUST NOT 声明依赖或 `dsh.profile.bundles`：装"仓库根"不能顺带拉进子插件。
- 子插件仍然不声明 `dsh.bundle`、仓库根仍然没有聚合 `cordis.patch.yml`（2026-09-10 的硬规则，例外只有这个外壳）。
- `"type"` 故意不写：外壳不含模块文件，写了会改变仓库根之下所有无就近清单的 `.js` 的模块解释。
