## Why

DSH 0.2.0-rc.2 把 agent preset 的声明方式从「目录扫描」改成了「Cordis 插件行 + 运行期注册表」：旧包 `@deepseek-ai/dsh-agent-presets`（读取 `$DSH_HOME/.agent-presets/<id>/`）已从发行物中彻底移除，新包 `@deepseek-ai/dsh-agent-preset-registry` 只通过 `ctx.agentPresets.register(definition)` 接受**内存内**定义，且其 README 明确写着「注册表不扫描目录，也不接受 preset 路径」。结果：本机 `~/.dsh/.agent-presets/` 下的 `standard/` 与 `liangshen/` 两个 preset 在新版里**完全没有读取者**，用户自建的「梁神模式」在新建会话时不再出现；社区同类插件 `@linxin666/dsh-client-ui-preset-center` 只装在 desktop profile（web profile 未安装），且它自己的设计刻意不做声明持久化、并要求 dsh-market 来源凭证，覆盖不了「管理我本地目录里已有的 preset」这件事。

因此需要一个本地 preset 管理器：把本地目录里的旧格式 preset 读出来、声明给 0.2.0 的注册表、并让开关状态跨重启保持；入口就放在本仓已拥有的 Settings → 本地插件页，作为该页的一个 tab，不新增设置导航行。

## What Changes

- 新增独立包 `dsh-agent-preset-manager`（仓库根目录下与 `dsh-plugin-manager` 同级）。它的客户端注册 `settings.localPlugins.tab` 槽，id `agent-presets`、order 20、label「Agent 预设」；**页面位置与「并入管理器」完全等价，但不改动正在运行的 `dsh-plugin-manager` host 代码与它已有的 7 支测试**。
- 主机半区（`src/index.js`）在 `webServer` 服务上提供 `/__dsh-agent-presets/*` HTTP 端点：`state`（扫描 + 卫生检查 + 运行期状态）、`set-enabled`、`create`、`save`、`remove`、`import`、`migrate`、`check`。
- 预设来源两个目录都扫：`$DSH_HOME/.agent-presets/<id>/`（旧格式，本机已有内容）与 `$DSH_HOME/agent-presets/<id>/`（新库目录）。每个目录读 `preset.yml`（`name`/`description`/`order`）与 `agent.cordis.yml`（子插件行清单）。
- 开关 = 运行期向 `agentPresets` 注册表 `register()` / 撤销（disposer）；启用集合持久化在 `$DSH_HOME/agent-preset-manager/state.json`，插件启动时重放，因此重启后仍生效。
- 「新增」= 从内置 `dsh-web-app` 的 `presets/standard.patch.yml` 解析出 `config.plugins` 作为骨架，落成 `$DSH_HOME/agent-presets/<id>/{preset.yml,agent.cordis.yml}`；面板内提供 YAML 编辑与保存（保存前把旧文件备份到 `<id>/.backup/`，保留最近 3 份）。
- 「删除」= 撤销声明 + 删除目录（二次确认）；另有独立的「停用」只撤销声明、保留磁盘字节。
- 行名卫生检查：逐行判定 `@deepseek-ai/dsh-*`（查运行时 `node_modules`，含子路径导出）、`cordis:`（内置白名单）、相对路径（查 Base 目录下的文件是否存在）、组行（递归）；三色呈现（可用 / 存疑 / 不可用）。
- 从任意目录导入：面板填绝对路径，主机校验（`preset.yml` 与 `agent.cordis.yml` 存在、id 合法、不撞车）后复制进新库目录。
- 文档与测试：`README.md`、`ACCEPTANCE.md`、`test/bundle.test.mjs`，并同步仓库根 `package.json` 与包版本（patch 递增，两处一致）。

## Capabilities

### New Capabilities

- `agent-preset-manager`: 本地 agent preset 的发现（旧 `.agent-presets` 目录 + 新 `agent-presets` 库目录）、运行期声明与撤销、启用集合的跨重启持久化、组成编辑与备份、删除语义、行名可用性检查、从外部目录导入，以及在「本地插件」设置页里的 tab 入口。

### Modified Capabilities

（无。`plugin-manager` 的需求不变：新 tab 由新插件自己注册到 `settings.localPlugins.tab` 列表槽，管理器只负责渲染槽内已登记的行。）

## Impact

**新增代码**

- `dsh-agent-preset-manager/package.json`（`dsh.client.platform: web`；**不声明** `dsh.bundle.patch`——它的 profile 激活行走现成机制）
- `dsh-agent-preset-manager/src/host-core.js`：目录扫描、YAML 读取、行名检查、id 校验、状态文件读写、骨架提取、备份策略（纯函数，可单测）
- `dsh-agent-preset-manager/src/index.js`：`/__dsh-agent-presets/*` 端点 + 注册表声明/撤销 + 启动重放
- `dsh-agent-preset-manager/src/client.js`：tab 注册与面板（无 JSX，`React.createElement` + 内联样式 + `--dsw-*` token）
- `dsh-agent-preset-manager/test/bundle.test.mjs`、`README.md`、`ACCEPTANCE.md`

**外部交互面**

- 读 `$DSH_HOME/.agent-presets/*/`（只读，除用户显式编辑/删除）
- 写 `$DSH_HOME/agent-presets/<id>/`（新增与导入）与 `<id>/.backup/`（编辑备份）
- 写 `$DSH_HOME/agent-preset-manager/state.json`（启用集合）
- 安装面：`~/.dsh/profiles/web/package.json` 的 devDependencies 新增一条 `link:`，`cordis.patch.yml` 新增一条 stable-id insert 行——由用户在生产 profile 上做一次显式确认后执行

**风险**

- 本地 preset 的 `agent.cordis.yml` 里可以写任意代码（尤其 `./*.mjs` 行），启用即等于在会话里运行它；因此首启不自动启用任何 preset，只有用户在面板里打开过的 id 才会进入持久化启用集合。
- `@deepseek-ai/dsh-tool-subagent` 等包名在 0.2.0 有 API 变化（如 `dsh-tool-subagent-fork` 已不是独立包），卫生检查只能判定「包名可解析」，**不能**判定 `config` 字段是否匹配新版本 Config；迁移与编辑里对这类行给黄色提示而非自动改。
- `@deepseek-ai/dsh-agent-preset-registry` 在旧线（< 0.2.0）不存在，插件必须在服务缺失时降级成「只读列表 + 明确提示」，不能崩掉宿主。

**不受影响**

- `dsh-plugin-manager` 的既有行为与端点、其它子插件、`dsh.profile.bundles`、`mcp-*` 行。
- 已声明 preset 的内建 4 个（standard/ptc/minimal/cordis）——本插件只注册用户目录里的 id，撞车时直接报错拒绝。
