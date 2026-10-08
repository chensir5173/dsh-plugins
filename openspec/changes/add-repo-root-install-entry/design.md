# 设计：仓库根的管理器安装外壳

## 背景：今天这条命令为什么没效果

| 步骤 | 事实 | 证据 |
|---|---|---|
| 仓库根无 `package.json` | 2026-09-10 删聚合伞包时物理删除 | `ls <repo>/package.json` → 不存在 |
| pnpm 仍能"装上" | pnpm 对无清单的目录退化为用**目录名**做包名 | `dsh plugin --profile probe add <repo>` → `+ dsh-plugins link:<repo>`，exit 0 |
| reconcile 不认它 | `exportsPatch()` 读不到 `dsh.bundle` | `dsh: warning: dsh-plugins declares no dsh.bundle — installed as a plain dependency, not a profile layer` |
| 结果是"装了个寂寞" | `dsh.profile.bundles` 不变 → 管理器不挂载 | 该 profile 的 `package.json` 里 `bundles: ["@deepseek-ai/dsh-base"]` |

## 决策

### D1 在仓库根放"安装外壳"，而不是把管理器源码搬到仓库根

外壳是转发层：根 `package.json` 指向 `dsh-plugin-manager/src/*`。搬源码会连带改：管理器自身的 `repoRootOfPluginSrc()`（现在是 `src/../..`）、`link:` 路径、文档里的全部路径、live profile 的依赖 spec，而且必须删掉包内 `package.json`（否则同名两份清单）。转发层的代价只有一个：**根目录多一份"同名清单"**，用测试 + 文档说清它的角色即可。

### D2 外壳包名必须等于 `dsh-plugin-manager`（关键约束）

包名即插件身份：profile bundle 层名、激活行 id、浏览器模块表 id 都是它。客户端产物里 `window.__ModuleLoader__.load({ id: 'dsh-plugin-manager' })` 是写死的，而 node 侧按两条分支定位"这一行对应哪个包"（`packages/client/modules/src/index.ts`）：

- **分支 A（生产路径，`internal.resolveSync`）**：先解析行 specifier 得到入口文件 URL，再从该文件向上找**最近的、`name` 等于 specifier 的 manifest**（`nearestPackage()`，:834 的 `name === expectedPackageName`）。外壳的入口转发进 `dsh-plugin-manager/src/`，所以最近命中的是**包内**清单 → 包名 `dsh-plugin-manager`、客户端产物 `dsh-plugin-manager/src/client.js`。
- **分支 B（无 Node internals 的兜底）**：`createRequire(baseUrl).resolve('<specifier>/package.json')` 直接命中外壳清单 → 包名仍是 `dsh-plugin-manager`，而外壳的 `exports["./client"]` 也指向同一个 `src/client.js`。

两条分支都得到同一个 id，正因如此外壳必须**同名**且**同时**声明 `dsh.client` + `exports["./client"]`：若外壳换个名字（例如 `dsh-local-plugins`），分支 A 会因为名字不匹配跳过包内清单、把包名判成外壳名，客户端产物注册的 id 与之不符 → 浏览器侧 `bundle … loaded without registering "<id>"`（`src/client/system.ts:135`，实测会直接报错而不是静默）。

### D3 `dsh.bundle.patch` 指向包内 patch，而不是在根再放一份

`loadProfile` 用 `join(packageDir, manifest.dsh.bundle.patch)` 读该文件（`packages/boot/app-boot/src/profile.ts:832-837`），所以"包内子目录"完全合法。这样：

- 激活行的真相源只有一份（`dsh-plugin-manager/cordis.patch.yml`，只插管理器自己那一行），不存在两份内容漂移；
- 仓库根**仍然没有** `cordis.patch.yml`，与"聚合伞包已删除"的口径不冲突（伞包的坏处是聚合激活行与同 id 重复插入，不是"根目录有文件"）。

### D4 外壳的其它字段

- `private: true`：它不是发布物（`main` 指向的文件不在它的 `files` 里），防止误发布。
- **不写 `"type"`**：外壳不含任何模块文件；写了 `"type": "module"` 会改变**仓库根之下**所有无就近清单的 `.js` 的模块解释（此刻不存在这类文件，但没必要留这个隐患）。
- 不声明 `dependencies`/`devDependencies`，不列 `dsh.profile.bundles`：装外壳**不得**顺带拉进任何子插件（pnpm 的 `link:` 本来也不装被链接包的依赖，这条是双保险 + 可测试的不变量）。

### D5 回归测试锁不变量

新增 `dsh-plugin-manager/test/root-install-shell.test.mjs`（无宿主依赖，纯 fs + manifest 断言）：

1. 外壳存在、同名、`main` 与包内 `src/index.js` 是同一个文件（realpath 比较）；
2. 外壳的 `exports["./client"]` 与包内 `src/client.js` 同一文件、`dsh.client` 与包内一致、客户端产物注册的 id === 外壳名；
3. `dsh.bundle.patch` 与包内 `cordis.patch.yml` 同一文件，且该 patch **只有一行**、`id`/`name` 都是 `dsh-plugin-manager`（这条正是伞包事故的回归锁：多一行就可能与管理器写的行同 id 冲突）；
4. 6 个子插件都不声明 `dsh.bundle`、目录内无 `cordis.patch.yml`、不复用管理器包名；根无 `cordis.patch.yml`；
5. 外壳不声明任何子插件依赖、无 `dsh.profile.bundles`。

### D6 文档口径

"推荐安装"只保留一条命令（`add <仓库根>`），并显式写出与 `add <仓库根>/dsh-plugin-manager` **等价**、可用后者做兼容；`README.md` 里「已删除：聚合伞包」一节改写为「根目录现在是管理器的安装外壳」，避免读者把两者混为一谈；`AGENTS.md` 的硬规则补上这条唯一例外。

## 实测证据（2026-09-10，隔离 profile，未触碰运行中的 web profile）

| 检查 | 命令 | 结果 |
|---|---|---|
| 装仓库根 | `DSH_HOME=<tmp> dsh plugin --profile probe add <repo>` | `dependencies` = `{"dsh-plugin-manager":"link:<repo>"}`；`bundles` = `["@deepseek-ai/dsh-base","dsh-plugin-manager"]`；无 `declares no dsh.bundle` 警告 |
| 能启动 | `dsh --profile probe`（base-only，无 web app / 不占端口） | 进程存活 15 s 无输出（`timeout` 124），无 `duplicate loader entry id`、无 `Cannot find package` |
| 组合结果 | `dsh --profile probe --dump-config` | 含 `- id: dsh-plugin-manager / name: dsh-plugin-manager`，无子插件行 |
| 红能力对照 | 同一 profile 加一行 `{id: bogus, name: 'dsh-nonexistent-xyz'}` | exit 1：`dsh: plugin tree failed to load: failed to apply loader entry include (cordis:include): failed to import loader entry bogus (dsh-nonexistent-xyz): Cannot find package … imported from <profile dir>`（证明该构造确实会暴露坏行，且解析锚点是 profile 目录） |
| 新旧路径可互相替换 | 先 `add <repo>/dsh-plugin-manager` 再 `add <repo>` | 依赖键不变、spec 被改写为仓库根、`bundles` 仍只有一条（不重复）、启动正常 |
| 浏览器半定位 | 用 client-modules 的算法（`nearestPackage` + `exports["./client"]`，两条分支各跑一次）打真 profile 目录 | 10/10：包名 `dsh-plugin-manager`、产物 `dsh-plugin-manager/src/client.js`、注册 id === 包名 |

## 风险与回滚

| 风险 | 处理 |
|---|---|
| 两份同名 `package.json` 让读者困惑"到底装的是哪个" | 外壳 `description` 写明角色；README + AGENTS.md 单一口径；测试把"转发一致"变成可执行断言 |
| 有人往外壳里加依赖/子插件行（伞包回归） | 测试第 3/5 条直接判红 |
| 有人改掉外壳的名字/转发（面板消失） | 测试第 1/2 条直接判红；且浏览器侧另有一道 loud 报错 |
| 回滚 | 删根 `package.json`（回到今天的行为：`add <仓库根>` 只装成普通依赖），或把 profile 依赖 spec 指回 `<repo>/dsh-plugin-manager` —— 两者都不涉及 profile 激活行 |

## 已知限制

- 外壳让"仓库根"成为一个可安装包名，但**不改变**一个事实：`dsh plugin --profile <p> remove dsh-plugin-manager` 仍是卸载管理器的正确命令（它同时从 `dsh.profile.bundles` 里摘除该层）；卸载后仓库根的源码目录不受影响。
- 真机验收仍需用户在自己的机器上跑一次 `add <仓库根>`（含换盘/换目录后的路径），并确认面板出现——本变更的隔离验证不能替代"用户那台机器上的路径"。
