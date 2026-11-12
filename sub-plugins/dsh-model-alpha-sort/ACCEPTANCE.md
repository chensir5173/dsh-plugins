# 验收清单 — dsh-model-alpha-sort

代码侧的 51 条逻辑断言（`test/sort.test.mjs` 23 条 + `test/bundle.test.mjs` 28 条）已全部自动覆盖并通过。本清单覆盖**只有装起来、真的去点/去重启**才能确认的部分：真实安装、设置页卡片位置、写入效果、顺序传播、启动时机、降级与回退。

标 `[H]` 的条目 harness 已断言过，回归时抽查即可；标 `[B]` 的必须人眼看。

---

## 0. 前置

```bash
dsh --version     # 需要 0.2.0 线（settingsController + llm.listConfigurableProviders）
```

准备一个**至少有一个提供方、且用户段里已有 `models` 数组**的 profile（本机是 `llm-pi-ai.providers.codemaker`，54 个模型）：

```bash
grep -n "^  models:" ~/.dsh/settings.yaml
```

记下模型数量，下一步要用它核对卡片统计。

## 1. 安装与加载

安装一律走管理器面板（先装 `dsh-plugin-manager` 一次 → 重启 `dsh web` → 设置 →「本地插件」→ 打开本插件主开关）。**不要**用 `dsh plugin --profile web add` 装本子插件（不会激活，见 README 警示）。

```bash
dsh --dump-config --profile web | grep -n model-alpha-sort   # 应看到一行
```

- [ ] 1.1 `[B]` 面板启用后重启 `dsh web`：启动无报错、无 `failed to import loader entry` / `Cannot find package` 提示
- [ ] 1.2 `[B]` profile `devDependencies` 出现本插件的 `link:`；`dsh.profile.bundles` 里本地条目仍**只有 `dsh-plugin-manager`**
- [ ] 1.3 `[B]` DevTools → Network 过滤 `/plugins/`：刷新页面后本插件 bundle 返回 **200**
- [ ] 1.4 `[B]` Console 无 `slot "settings.models.footer" is not declared`、无 `already has an entry with id`
- [ ] 1.5 `[B]` 面板里把主开关**关→开**一次：profile `cordis.patch.yml` 里本插件行**始终只有一行**，开回后卡片恢复

## 2. 卡片出现与状态

- [ ] 2.1 `[B]` 打开 设置 →「模型」：页面最底部（提供方行与「添加模型」之后）出现「模型排序」卡片
- [ ] 2.2 `[B]` 统计行数字与 `settings.yaml` 一致：`可排提供方` = 用户段里有 models 数组的提供方数，`模型` = 这些提供方的模型总数（本机应为 1 / 54）
- [ ] 2.3 `[B]` 提供方 chip **只列出有模型的提供方**（数组非空）：没有模型数组 / 空继承清单的提供方不显示；有模型的条目状态文案正确（用户段里已有数组显示 `用户段模型`；只有继承清单显示 `继承清单（未开启排序）`）
- [ ] 2.4 `[B]` 「当前规则」一行显示 `排序键 显示名 · 升序 · locale zh-CN`（与配置一致）

## 3. 手动排序（按钮）

- [ ] 3.1 `[B]` 先手动把某个提供方的模型拖成乱序 → 点「立即按首字母排序」→ 列表**立刻**变成字母序，`待排序提供方` 变成 0
- [ ] 3.2 `[B]` 再点一次按钮：没有任何变化；`status.lastRun.changed` 为 0（幂等，零写入）
- [ ] 3.3 `[B]` 打开 composer 的模型选择器：同一提供方的模型顺序与设置页一致（字母序）
- [ ] 3.4 `[B]` 打开 `/model` 弹窗：顺序与 composer 一致
- [ ] 3.5 `[B]` 重排前后 profile 默认模型**不变**（设置页顶部/provider 行显示的默认模型仍是原来那个 id）
- [ ] 3.6 `[B]` 模型行里的显示名、上下文窗口、maxTokens、推理档等字段**一个都没变**，只有行的先后变了

## 4. 启动排序

- [ ] 4.1 `[B]` 先用方向键把模型拖成乱序 → 重启 `dsh web`（或重启 DSH Desktop）→ 不点按钮，列表已经恢复字母序；卡片「启动排序」显示 `已完成（N 处）`
- [ ] 4.2 `[B]` 把配置改成 `sortOnStartup: false` 并重启 → 乱序保持不变，卡片「启动排序」显示 `已关闭`
- [ ] 4.3 `[B]` 把配置改回 `true`：重启后重新自动排序

## 5. 排序规则

- [ ] 5.1 `[H]` 数字感知：`gpt-4` 排在 `gpt-10` 之前；大小写不敏感：`Claude` 与 `claude` 相邻
- [ ] 5.2 `[B]` 中文显示名按拼音排序（例如「阿里」在「百度」之前），locale 改成非法值时**不报错**、回退默认排序
- [ ] 5.3 `[B]` 把 `sortBy` 改成 `id` 并触发一次排序：顺序按模型 id 排；再改成 `direction: desc`：顺序整体反转
- [ ] 5.4 `[B]` 某个模型 `name` 为空字符串：它按 `id` 参与排序，不会掉到最前或最后（除非 id 本身如此）

## 6. 降级与冲突

- [ ] 6.1 `[B]` 只读部署（`settings.describe().writable === false`）下：卡片显示只读，按钮点了不写设置、不报错
- [ ] 6.2 `[B]` 并发编辑：一边点按钮排序、一边在设置页改另一个提供方 → 撞 `settings/conflict` 时卡片提示「设置文档刚被别处改过，请再点一次」，**不覆盖**对方的改动
- [ ] 6.3 `[B]` 没有 `webServer` 的环境：卡片提示端点不可用（`status.http.mounted === false`），宿主半不崩
- [ ] 6.4 `[B]` 没有 `settingsController` 的环境：卡片显示「宿主半未就绪：设置服务不可用。」，设置页其余功能正常

## 7. 诊断端点

```bash
curl.exe -s -H "x-dsh-plugin: dsh-model-alpha-sort" http://127.0.0.1:1030/__dsh-model-alpha-sort/status
```

- [ ] 7.1 `[B]` `status` 返回 `{ ok, writable, options, totals, providers, startup, http, lastRun }`，`providers[]` 里不包含模型清单本身
- [ ] 7.2 `[B]` 不带 `x-dsh-plugin` 头 → 403 `forbidden-plugin-header`
- [ ] 7.3 `[B]` 带跨源 `Origin` → 403 `forbidden-origin`；同源 `Origin` → 200
- [ ] 7.4 `[B]` `POST /__dsh-model-alpha-sort/sort` 返回 `{ ok, changed, skipped, writes, totals }`；GET 访问该路径 → 405

## 8. 卸载与回退

- [ ] 8.1 `[B]` 面板「移除」后：profile 里激活行与依赖键都被清掉，重启无 `Cannot find package`；仓库源码目录保留
- [ ] 8.2 `[B]` 手动把顺序拖乱（模拟用户偏好被改）→ 重新启用插件并点一次排序 → 顺序恢复字母序；再点一次 → 零写入
- [ ] 8.3 `[B]` 关掉插件后，设置页与 composer 的顺序保持**最后一次写入的结果**（插件不负责回滚数据）

## 回归命令

```bash
node sub-plugins/dsh-model-alpha-sort/test/sort.test.mjs
node sub-plugins/dsh-model-alpha-sort/test/bundle.test.mjs
node dsh-plugin-manager/test/root-install-shell.test.mjs   # 版本一致性（两处 package.json 相同）
```
