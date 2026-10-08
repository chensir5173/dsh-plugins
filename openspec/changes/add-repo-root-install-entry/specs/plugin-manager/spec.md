## MODIFIED Requirements

### Requirement: 本地插件不提供 bundle 安装路径

本仓库 MUST NOT 为本地子插件提供 bundle 层：`sub-plugins/` 下每个子插件的 `package.json` MUST NOT 声明 `dsh.bundle`，目录内 MUST NOT 存在包自带的 `cordis.patch.yml`。据此，`dsh plugin --profile <name> add <子插件目录>` 这一路径 MUST NOT 让子插件进入 `dsh.profile.bundles`、MUST NOT 产生与管理器激活行重复的 loader entry id（否则 `dsh web` 启动会因 `duplicate loader entry id` 直接失败）；该路径的可见后果 SHALL 限于"装成普通 profile 依赖 + 打印 `declares no dsh.bundle` 警告 + 不激活"，且 MUST 不影响已有激活行，管理器 SHALL 仍能在启用时接管该包（把同名依赖改写为 `devDependencies` 的 `link:`）。卸载子插件的唯一受支持路径 SHALL 是管理器面板的「移除」；文档 MUST 明确警示 `dsh plugin --profile <name> remove <子插件包名>` 只摘依赖而不删管理器写的激活行，会留下指向不存在包的悬空行并使下次启动失败（`failed to import loader entry <id> (<name>): Cannot find package …`）。仓库根 MUST NOT 再提供**聚合**伞包清单：根 MUST NOT 存在 `cordis.patch.yml`，也 MUST NOT 存在任何列出子插件激活行（或声明子插件 bundle 层）的可安装包；根 `package.json` 唯一允许的形态是管理器的安装外壳（见「仓库根提供管理器的安装外壳」）。

#### Scenario: 子插件包不自带 bundle 层

- **WHEN** 检查 `sub-plugins/` 下每个子插件的 manifest 与目录内容
- **THEN** 没有任何 manifest 声明 `dsh.bundle`，目录内也不存在包自带的 `cordis.patch.yml`

#### Scenario: 仓库根不再提供聚合伞包

- **WHEN** 检查仓库根是否存在可安装的聚合伞包清单
- **THEN** 根 `cordis.patch.yml` 不存在，根 `package.json`（若存在）只插入管理器自己那一行、不含任何子插件的 bundle 层或激活行，且 `dsh-local-plugins` 不再是一个可被 `dsh plugin add` 装进 profile 的包

#### Scenario: CLI 误装只装成普通依赖且不激活

- **WHEN** 在某个 profile 上执行 `dsh plugin --profile <name> add <某子插件目录>`
- **THEN** 该包进入 profile `dependencies` 而**不进入** `dsh.profile.bundles`，CLI 打印 `declares no dsh.bundle — installed as a plain dependency, not a profile layer` 警告，管理器维护的激活行数量与内容不变，且该 profile 仍能正常启动（不出现 `duplicate loader entry id`）

#### Scenario: 卸载路径唯一且在文档中被明确警示

- **WHEN** 用户想卸载某个子插件
- **THEN** 文档指示的唯一路径是管理器面板「移除」（删激活行 + 摘依赖，仓库源码目录保留）；同时明确写出用 `dsh plugin --profile <name> remove <子插件包名>` 的后果是留下悬空激活行、导致下次启动报 `failed to import loader entry …: Cannot find package …`

## ADDED Requirements

### Requirement: 仓库根提供管理器的安装外壳

仓库根 SHALL 提供**唯一**一个本地 bundle 安装入口 —— 管理器的安装外壳（根 `package.json`），使 `dsh plugin --profile <name> add <仓库根>` 与 `add <仓库根>/dsh-plugin-manager` 等价。外壳的 `name` MUST 等于管理器的包名（`dsh-plugin-manager`）：包名即插件身份（profile `dsh.profile.bundles` 条目、激活行 id、浏览器模块表 id），浏览器侧按「离行入口文件最近的、名字等于该行 specifier 的 manifest」定位包，并把定位出的包名当作模块 id 与产物内 `window.__ModuleLoader__.load({ id })` 的 id 比对（不一致即报 `bundle … loaded without registering …`）。外壳的 `main`/`exports["."]` MUST 指向 `<repo>/dsh-plugin-manager/src/index.js`，`exports["./client"]` MUST 指向 `<repo>/dsh-plugin-manager/src/client.js`，`dsh.client` MUST 与包内清单一致，`dsh.bundle.patch` MUST 指向 `<repo>/dsh-plugin-manager/cordis.patch.yml`（激活行的单一真相源）。外壳 MUST 是 `private` 且 MUST NOT 声明任何 `dependencies`/`devDependencies`、MUST NOT 声明 `dsh.profile.bundles`、MUST NOT 为任何子插件声明 bundle 层或激活行。安装任一路径 SHALL 都只让 `dsh-plugin-manager` 一个本地条目进入 `dsh.profile.bundles`，MUST NOT 产生重复 loader entry id，也 MUST NOT 把任何子插件拉进 profile。

#### Scenario: 从仓库根安装管理器

- **WHEN** 在某个 profile 上执行 `dsh plugin --profile <name> add <仓库根>`
- **THEN** profile `dependencies` 出现键 `dsh-plugin-manager`（值为 `link:<仓库根>`），`dsh.profile.bundles` 追加 `dsh-plugin-manager`（已存在则不重复追加），不打印 `declares no dsh.bundle` 警告，且该 profile 仍能正常启动（不出现 `duplicate loader entry id`、不出现 `failed to import loader entry …: Cannot find package …`）

#### Scenario: 两条安装路径可互相替换

- **WHEN** 某 profile 已用 `add <仓库根>/dsh-plugin-manager` 装过管理器，用户再执行 `add <仓库根>`
- **THEN** 依赖键与 `dsh.profile.bundles` 条目都不变（只有依赖 spec 由子目录改写为仓库根），激活行 id 仍是 `dsh-plugin-manager`，不产生第二个 bundle 层或第二行

#### Scenario: 外壳只激活管理器自己

- **WHEN** 检查外壳指向的 bundle patch 与该 profile 的组合结果（`--dump-config`）
- **THEN** 该 patch 只插入一行（`id` 与 `name` 均为 `dsh-plugin-manager`），组合结果里不出现任何子插件行，且仓库根不存在 `cordis.patch.yml`

#### Scenario: 浏览器半仍解析到管理器的包身份

- **WHEN** 从仓库根安装后 DSH 组合浏览器模块表（扫描该行对应的包）
- **THEN** 定位到的包名为 `dsh-plugin-manager`、客户端产物为 `dsh-plugin-manager/src/client.js`，且该产物注册的 id 与行 id 相同（设置页「本地插件」面板正常出现）
