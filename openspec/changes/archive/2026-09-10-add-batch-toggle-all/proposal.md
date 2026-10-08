## Why

「本地插件」面板目前只能**逐个**开关子插件：仓库现在有 6 个受管子插件，且全部带浏览器界面，逐个点开关会各触发一次配置重应用（宿主事件循环被独占约 1 秒），既慢又容易漏点。用户需要「一键把全部本地插件打开 / 关掉」的批量操作——典型场景是排查问题（先全关、再逐个开定位罪魁）和快速恢复工作环境（全开）。

## What Changes

- 面板顶部工具条新增两个次按钮：**全部开启 (N)** 与 **全部关闭 (N)**，N 是「这一步真能改动」的子插件数量；N=0 时按钮置灰。
- 新增宿主端点 `POST /__dsh-plugin-manager/set-all-enabled {enabled}`：一次快照 → 需要时**一次** `pnpm install` → **一次** `cordis.patch.yml` 写入（N 项 = 1 次配置重应用，而不是 N 次）。
- 批量语义按状态收敛：
  - 全部开启作用于 `已停用`（去掉行内 `disabled`）与 `未安装`（补 `link:` devDependency + 装依赖 + 写激活行）；
  - 全部关闭作用于 `已激活`（写 `disabled: true`，**保留行与依赖**，随时可再开）；
  - `未激活(仅依赖)`、`旧布局`、`非插件目录` 一律跳过——前者不给从未启用过的插件凭空写行，后者按既有约定要求先「一键接管/迁移」。
- 两个按钮都弹确认框（文案带数量与将跳过项）；批量执行中锁住每行开关/移除/迁移并显示「处理中…」；完成后若有带界面的子插件被改动，沿用既有「刷新页面使界面生效」提示（不自动刷新）。
- 失败处理为**尽力而为 + 逐项回报**：响应携带每项结果（`applied`/`skipped`/`failed` + 原因），失败项保持原状态并在面板提示条里逐条列出，可重试。
- 不触碰 profile `cordis.patch.yml` 中非本仓库的行（`mcp-*`、`dsh-liquid-glass`、`netease-auth` 等 14 行）。

## Capabilities

### New Capabilities

（无）

### Modified Capabilities

- `plugin-manager`: 新增「批量全部开启/全部关闭」的行为要求——批量作用域与跳过规则、计数口径、单次写入与单次安装、失败逐项回报、执行期锁定与生效提示；并把批量端点 `/set-all-enabled` 的请求/响应契约写入 design.md。

## Impact

- 代码：`dsh-plugin-manager/src/host-core.js`（批量目标选择/计数/结果纯逻辑）、`src/index.js`（新端点与批量执行）、`src/client.js`（按钮、确认、锁定、失败提示）。
- 接口：新增 HTTP 端点 `POST /__dsh-plugin-manager/set-all-enabled`；既有 `/list`、`/set-enabled`、`/remove`、`/migrate`、`/status` 契约不变。
- 数据：仅写 profile `cordis.patch.yml`（受管行）与 `package.json`（受管子插件的 `devDependencies`），沿用既有时间戳备份与失败回滚；不新增持久数据。
- 测试：新增 host-core 单测与真 handler 隔离 harness（`test/batch-toggle.test.mjs`），扩展 `test/bundle.test.mjs` 客户端断言。
- 文档：`dsh-plugin-manager/README.md`、`dsh-plugin-manager/ACCEPTANCE.md`、`docs/knowledge/` 新增一篇并登记索引。
