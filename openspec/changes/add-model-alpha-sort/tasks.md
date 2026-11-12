# Tasks

## 1. 插件骨架

- [x] 1.1 新建 `sub-plugins/dsh-model-alpha-sort/package.json`：`name`/`version`/`type: module`/`main`/`exports`（`"."` 与 `"./client"`）/`dsh.client.platform: "web"`；**不声明 `dsh.bundle`**、无 dependencies（与仓库既有子插件一致）。
  - 验证：`node dsh-plugin-manager/test/root-install-shell.test.mjs` 通过（含「shell and inner package carry the SAME version」）。
- [x] 1.2 目录内**不放** `cordis.patch.yml`（激活行由管理器写 profile）。
  - 验证：`ls sub-plugins/dsh-model-alpha-sort/cordis.patch.yml` 应为「文件不存在」。
- [x] 1.3 写 `src/sort.js`：纯排序逻辑（`normalizeOptions` / `sortKeyOf` / `compareModels` / `isSorted` / `sortModels` / `getAtPath` / `sortPathOf` / `movedCount`），零依赖、每个函数带中文头注释。
  - 验证：`node sub-plugins/dsh-model-alpha-sort/test/sort.test.mjs` 全绿（23 条）。

## 2. 宿主半

- [x] 2.1 `src/index.js` 导出 `name` / `inject` / `apply` / `Config`（0.2.0 手写 schema：`meta.volatile` + `toJSON()` + `['~standard']`，`vendor` 不写 `schemastery`），宿主半零 `@deepseek-ai/*` import。
  - 验证：`node sub-plugins/dsh-model-alpha-sort/test/bundle.test.mjs` 的源码审计用例通过。
- [x] 2.2 `collect(ctx)`：`settingsController.describe()` 建 ns→view 表，`llm.listConfigurableProviders()` 给 `settingsNs` / `settingsPath`，逐 provider 判定 `user` / `inherited` / `inherited-writable` / `absent` / `namespace-absent`，算 `totals.providers|models|pending|moved`。
  - 验证：`node sub-plugins/dsh-model-alpha-sort/test/bundle.test.mjs` 的 collect 用例通过。
- [x] 2.3 `sortNow(ctx)`：按 `settingsNs` 分组，`ops = [{ op:'set', path:[...settingsPath,'models'], value: sorted }]`，`settingsController.mutate(ns, ops, revision)`；`writable === false` 跳过；错误按 `details.code` 归类（`settings/conflict`、`settings/path-not-volatile`、`settings/entry-absent`）。
  - 验证：bundle 测试的「写路径 / 幂等 / 只读 / 冲突 / 多 ns / 继承」用例通过。
- [x] 2.4 HTTP：`GET /__dsh-model-alpha-sort/status`、`POST /__dsh-model-alpha-sort/sort`；`x-dsh-plugin: dsh-model-alpha-sort` 头 + 同源门禁；无 `webServer` 时 `status.http = { mounted:false, reason:'webServer-absent' }`。
  - 验证：bundle 测试的 HTTP 门禁用例（403/404/405/200）通过。
- [x] 2.5 启动排序：`apply` 后 1.5s / 5s / 12s 三次尝试，成功后不再重试；`sortOnStartup: false` 直接关闭；定时器在 dispose 时清理。
  - 验证：bundle 测试的「启动只成功一次」「sortOnStartup=false」用例通过。

## 3. 客户端

- [x] 3.1 `src/client.js` 以 `window.__ModuleLoader__.load({ id, factory })` 打包（无 JSX），注册 `settings.models.footer`（`id: model-alpha-sort`，`order: 10`，`label: () => '模型排序'`）。
  - 验证：bundle 测试的注册参数断言通过。
- [x] 3.2 卡片读 `GET /status` 显示统计（可排提供方 / 模型 / 待排序提供方）、规则行、提供方状态 chip、启动排序状态；按钮 `立即按首字母排序`（POST `/sort`，带 `x-dsh-plugin` 头）与 `刷新状态`。
  - 验证：bundle 测试的渲染与点击用例通过。
- [x] 3.3 降级文案：只读部署、`settings-controller-absent`、端点不可用、`settings/conflict` 各有中文提示；客户端**不直连** `remote.settings`、不调用 `settings.mutate`。
  - 验证：bundle 测试的源码审计（去注释后无 `remote.settings` / `settings.mutate`）通过。

## 4. 测试

- [x] 4.1 `test/sort.test.mjs`：默认值、name→id 回退、数字感知、大小写、拼音、稳定性、`desc`、`sortBy: id`、`isSorted`、`getAtPath`、`sortPathOf`、`movedCount`。
  - 验证：`node sub-plugins/dsh-model-alpha-sort/test/sort.test.mjs` → `23 passed, 0 failed`。
- [x] 4.2 `test/bundle.test.mjs`：client bundle 物化与槽位注册、卡片渲染/点击、host 半 collect/sortNow/HTTP/apply/启动定时器、Config 形状、源码审计。
  - 验证：`node sub-plugins/dsh-model-alpha-sort/test/bundle.test.mjs` → `28 passed, 0 failed`。
- [x] 4.3 全仓回归：管理器 7 支套件 + 全部子插件套件。
  - 验证：`node dsh-plugin-manager/test/*.test.mjs` 全绿；`for f in sub-plugins/*/test/*.test.mjs; do node "$f" || echo "FAIL $f"; done` 输出 `SUBP-DONE`（`dsh-idle-hook` 的 spawn EPERM 用例为沙箱环境限制，与本次改动无关）。

## 5. 文档与发布

- [x] 5.1 `sub-plugins/dsh-model-alpha-sort/README.md`（定位、顺序链、安装/启停、用法、配置、规则、降级、端点、测试、限制）与 `ACCEPTANCE.md`（安装/卡片/手动排序/启动排序/规则/降级/端点/卸载，`[H]`/`[B]` 标注）。
  - 验证：`ls sub-plugins/dsh-model-alpha-sort/README.md sub-plugins/dsh-model-alpha-sort/ACCEPTANCE.md`。
- [x] 5.2 `docs/plugins.md`：一览表新增一行 + `### dsh-model-alpha-sort — …` 小节 + UI 触点表新增 `settings.models.footer` 行与 HTTP 端点。
  - 验证：`grep -n "dsh-model-alpha-sort" docs/plugins.md` 至少命中 3 处。
- [x] 5.3 `docs/knowledge/2026-11-11-model-alpha-sort.md` + 索引行。
  - 验证：`grep -n "model-alpha-sort" docs/knowledge/README.md` 命中 1 行。
- [x] 5.4 根 `package.json` 与 `dsh-plugin-manager/package.json` 版本同步 `0.3.23 → 0.3.24`。
  - 验证：`node dsh-plugin-manager/test/root-install-shell.test.mjs` 通过。
- [x] 5.5 本文件第 1–5 节全部勾选，且每条给出可复跑命令；第 6 节保留未勾选（运行实例验收需要安装到 profile 后人工确认）。
  - 验证：`grep -n "^- \[ \]" openspec/changes/add-model-alpha-sort/tasks.md` 只应命中第 6 节的 3 条。

## 6. 运行实例验收（可选，需装到 profile）

- [ ] 6.1 管理器启用插件 → 重启 `dsh web` → 设置 →「模型」页底部出现「模型排序」卡片，统计与 `settings.yaml` 一致。
  - 验证：见 `sub-plugins/dsh-model-alpha-sort/ACCEPTANCE.md` 第 2 节。
- [ ] 6.2 点「立即按首字母排序」→ 设置页列表、composer 选择器、`/model` 弹窗三处同时变成字母序；再点一次零变化。
  - 验证：见 `ACCEPTANCE.md` 第 3 节。
- [ ] 6.3 重启后启动排序生效；`sortOnStartup: false` 后不再自动排。
  - 验证：见 `ACCEPTANCE.md` 第 4 节。
