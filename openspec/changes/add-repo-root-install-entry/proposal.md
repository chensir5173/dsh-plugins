## Why

用户要的安装姿势是「一条命令装这一个仓库」，而不是「记住包在哪个子目录」：

```bash
dsh plugin --profile web add E:\GitHubProjects\ChenSir5173\dsh-plugins
```

今天这条命令**什么都没装**（隔离 profile 实测，2026-09-10）：仓库根没有 `package.json`（2026-09-10 删除聚合伞包 `dsh-local-plugins` 时一并物理删除），pnpm 只能按**目录名**把它存成普通依赖，`dsh plugin` 的 reconcile 随后打印警告，`dsh.profile.bundles` 不变 —— 管理器不入场，设置页也不会出现「本地插件」面板：

```
+ dsh-plugins link:C:/WorkProject/GithubProjects/ChenSir5173/dsh-plugins
dsh: warning: dsh-plugins declares no dsh.bundle — installed as a plain dependency, not a profile layer
```

而唯一正确路径 `add <仓库根>/dsh-plugin-manager` 要求用户知道内部子目录名；仓库换盘/换目录（例如 `E:\GitHubProjects\...`）后这个叶子目录名还得再抄一次。

## What Changes

- **新增仓库根的 `package.json`——管理器的安装外壳（install shell）**：`name` 等于管理器的包名 `dsh-plugin-manager`，`main`/`exports["."]` 转发到 `dsh-plugin-manager/src/index.js`，`exports["./client"]` 与 `dsh.client` 与包内清单一致，`dsh.bundle.patch` 指向包内自己的 `cordis.patch.yml`（单一真相源），`private: true`，不声明任何依赖、不列 `dsh.profile.bundles`。于是 `dsh plugin --profile <p> add <仓库根>` 与 `add <仓库根>/dsh-plugin-manager` **等价**：都装成 profile `dependencies` 的 `link:` 并以同名进入 `dsh.profile.bundles`。
- **外壳为什么必须与被指向的包同名**（这是本变更唯一不显然的约束）：包名就是插件身份 —— profile bundle 层名、激活行 id、浏览器模块表 id 三者都是它；客户端产物内写死 `window.__ModuleLoader__.load({ id: 'dsh-plugin-manager' })`，而 `@deepseek-ai/dsh-client-modules` 按「离行入口文件**最近**的、`name` 等于该行 specifier 的 manifest」定位包（`nearestPackage()`，`packages/client/modules/src/index.ts:823-847`），定位出的包名即模块 id，不一致时浏览器侧直接报 `bundle … loaded without registering "<id>"`（`src/client/system.ts:135`）。
- **不重新引入伞包**：外壳只插入**一行**（管理器自己），仓库根仍然**没有** `cordis.patch.yml`；6 个子插件仍然不声明 `dsh.bundle`、目录内仍无包自带 patch。
- **新增仓库级回归测试** `dsh-plugin-manager/test/root-install-shell.test.mjs`：锁住「外壳与包内清单转发一致 / bundle patch 只插一行 / 子插件不带 bundle 层 / 根无聚合激活清单 / 装根外壳不会拉进子插件」。
- **文档同步**：根 `README.md`（安装章节给出两条等价命令 + 「已删除：聚合伞包」改写为「根目录现在是管理器的安装外壳」）、`AGENTS.md` 硬规则补充例外、`dsh-plugin-manager/README.md` 与 `ACCEPTANCE.md`、`docs/knowledge/` 新增一篇。

## Capabilities

### Added Capabilities

- `plugin-manager`：新增 Requirement「仓库根提供管理器的安装外壳」——规定外壳的字段约束、与包内路径的等价性、以及"只激活管理器自己"的红线（4 个场景）。

### Modified Capabilities

- `plugin-manager`：「本地插件不提供 bundle 安装路径」——把原来的「仓库根 MUST NOT 有任何 `package.json`」放宽为「仓库根 MUST NOT 有**聚合**清单：无聚合 `cordis.patch.yml`，根 `package.json` 只能是管理器的安装外壳」；子插件侧的全部约束（不声明 `dsh.bundle`、CLI 误装只装成普通依赖、卸载只能走面板）**逐字不变**。

## Non-goals

- **不搬源码**：布局不变 —— `dsh-plugin-manager/` 仍是有 `src/`、`test/`、`README/ACCEPTANCE`、`cordis.patch.yml` 的权威包，根外壳只是入口，不含被复制的代码（转发而非复制，避免两份真相）。
- **不改 DSH 核心**：不动 `dsh plugin` 的 reconcile、不动 loader/客户端模块系统的解析规则。
- **不改激活模型与面板**：行 id 规则、`devDependencies` `link:` + profile patch 激活行不变；管理器源码与 UI 零改动。
- **不动任何现有 profile**：新旧路径产出同样的 profile 状态（同一 dep 键、同一 bundles 条目、同一行 id），已用隔离 profile 实测互相替换不产生重复层/重复行。
- **不复活 `dsh-local-plugins`**：外壳不叫这个名字、不列子插件、不提供聚合 patch。

## 成功判据

1. `dsh plugin --profile <p> add <仓库根>`：profile `dependencies` 出现键 `dsh-plugin-manager`（值 `link:<仓库根>`）、`dsh.profile.bundles` 追加（已存在则不重复）`dsh-plugin-manager`、**无** `declares no dsh.bundle` 警告。
2. 该 profile 能正常启动：无 `duplicate loader entry id`、无 `failed to import loader entry …: Cannot find package …`；`--dump-config` 的组合结果里有一条 `- id: dsh-plugin-manager / name: dsh-plugin-manager`。
3. 浏览器半解析结果不变：定位包名 `dsh-plugin-manager`、客户端产物 `dsh-plugin-manager/src/client.js`、其内注册 id 与行 id 相同（否则面板不会出现）。
4. 6 个子插件仍不声明 `dsh.bundle`、根仍无 `cordis.patch.yml`；新回归测试 + 既有 12 个测试文件全绿；`openspec validate add-repo-root-install-entry --strict` 通过。
