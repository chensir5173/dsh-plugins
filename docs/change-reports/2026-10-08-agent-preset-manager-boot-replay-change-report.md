# 变更报告 — dsh-agent-preset-manager：启动重放等注册表就绪（2026-10-08）

插件版本 0.1.0 → 0.1.1 ｜ 仓库外壳与 dsh-plugin-manager 0.3.7 → 0.3.8 ｜ `test/bundle.test.mjs` 39 → 42 条

## 1. 触发

真机（desktop 0.2.0-rc.2）：重启 DSH desktop 后**会话里选不到任何本地 agent preset**，而 设置 →「本地插件」→「Agent 预设」里三个开关（linger / ruby / xuner）都显示开启。

只读取证（`GET http://127.0.0.1:19387/__dsh-agent-presets/state`，该实例就是报障现场）：

- `runtime = {"supported":true,"error":null,"declared":[]}` —— 探测自称支持运行期声明，**实际声明列表为空**。
- `enabled = [linger, ruby, xuner]`，三张卡片全部 `status:"failed"`、`statusDetail:"没有生效的声明（可能是宿主重启前记录的启用状态，重新开关一次即可）"`，而**体检全部 ok**（`rowCount` 14/15/15、`problems` 空、`metadataError`/`compositionError` 为 null）⇒ 不是目录或组合的问题。
- `restore.restored = { attempted: 3, restored: [], failed: [三条「当前 DSH 版本没有 agent preset 注册表服务，无法运行期声明预设；本页只能查看与编辑，启用/停用不可用。」] }`、`restoredPending: false`。
- `~/.dsh/agent-preset-manager/state.json` = `{"version":1,"enabled":["linger","ruby","xuner"],…}`；`~/.dsh/agent-presets/` 三个预设目录齐全。

## 2. 根因

三环，全部在宿主半（`src/index.js` + `src/host-core.js`）：

| 环 | 位置 | 事实 |
| --- | --- | --- |
| 1 | `src/index.js` `mounted()`（旧代码） | 同步 `ctx.get('agentPresets')` / `ctx.get('agentPresetsRoot')` 在组合早期读到 undefined：宿主注册表服务**晚于**本插件条目就位，这是正常的组合顺序，不是「这个版本不支持」 |
| 2 | `src/index.js` `mounted()`（旧代码） | 同一个 `mounted()` 里紧接着 `void (async () => { restoreReport = await restoreEnabled(core) })()` 重放；`src/host-core.js:1077` 的 `if (enabled && (!runtime || !runtime.supported)) return failure(runtime && runtime.error ? runtime.error : MSG.serviceUnavailable)` 把账本里的**每一个 id 当场拒掉** |
| 3 | `src/index.js` `adoptRegistry()` | 稍后 `ctx.inject(['agentPresets'], cb)` 回调确实把注册表 adopt 成功（`supported` 变 true、`error` 清空），但**没有任何地方在 adopt 成功后再重放** ⇒ `declared` 永久为空 |

面板开关读的是 `state.json` **账本**（`enabled`），事实是 `runtime.declared`。两者不一致 ⇒「开关是开的」与「会话里选不到」长期并存，而错误文案还把「重新开关一次」写成了唯一出路。

## 3. 修改摘要

| 文件 | 改动 |
| --- | --- |
| `src/index.js` `adoptRegistry` | 变三参 `adoptRegistry(ctx, runtime, onReady)`：同步命中就 `ready()`；**存在注入面时注册完回调不再结算**（服务可能只是还没组合），回调里 adopt 成功后 `ready()`；无注入面的 0.1.x 才立即结算成失败报告，不悬挂 pending |
| `src/index.js` `apply` | 新增 `replayInFlight` / `healUsed` 状态与 `startReplay()`、`healReplay()`：前者防重入并在开跑前把 `restoreSettled` 置 false（面板读作「恢复中」），后者给每个被 adopt 的注册表**一次补跑预算** |
| `src/index.js` `restoreEnabled` | 循环里加幂等跳：`runtime.getHandles().has(id)` 已声明的 id 直接记 `restored` 跳过 ⇒ 补跑只重试失败项，不会重复声明（宿主对重名会报 Duplicate） |
| `src/index.js` `migrateRef` | 开头调 `healReplay()` ⇒ `/state`、`/bootstrap`、`/migrate` 三个读取点都成了自愈检查点，**面板第一次读就能补跑**；`describe()` 刻意不调，避免自检副作用 |
| `src/index.js` `mounted` | 删掉「同步探测 + 立即重放」，改为 `adoptRegistry(ctx, runtime, () => { healUsed = false; startReplay() })` |
| `test/bundle.test.mjs` | 新增 boot 段（39 → 42 条）：迟到注册表仍重放 / 无注入面时结算而不是挂起 / 首次读 `/state` 自愈且不重复声明 |
| `README.md`、`ACCEPTANCE.md` | 行为表与验收项同步（README 新增「启动那轮重放没成功」行、ACCEPTANCE 新增 2.12 补跑用例与条数 31→42） |
| `docs/knowledge/2026-10-02-agent-preset-manager.md` 与知识库索引 | 新增篇末一节：症状、根因链、修法、可复用结论 |

## 4. 验证证据

| 证据 | 结果 |
| --- | --- |
| `node --check sub-plugins/dsh-agent-preset-manager/src/index.js` | 通过 |
| `node sub-plugins/dsh-agent-preset-manager/test/bundle.test.mjs` | **42/42 pass，fail 0**（改前 39 条） |
| 红绿对照（`tmp/` 副本：`mounted` 恢复「同步 adopt + 立即重放」、`migrateRef` 去掉 `healReplay`） | **40/42**，红的正是新增的「迟到注册表仍重放」与「首次读 /state 自愈」两条 |
| `node dsh-plugin-manager/test/root-install-shell.test.mjs` | PASS（含根外壳与 dsh-plugin-manager 版本一致护栏） |
| 版本 | 插件 0.1.1；根 `package.json` 与 `dsh-plugin-manager/package.json` 0.3.8 |

## 5. 边界与遗留

- 本轮只修「重放等不到注册表」这条路径；面板上「重新开关一次」的手动路径依然可用，只是不再是唯一出路。
- 补跑预算是「每个被 adopt 的注册表一次 + 每个读取点一次」，同一次启动里最多补跑两次；若两次都失败（例如预设目录真的不在），错误会如实留在 `restore.failed` 里，**不会写回账本**。
- `healReplay` 不挂在 `describe()`，纯自检不会触发声明；要触发请读 `/state`（面板打开即读）。
- 客户端半零改动：面板本来就是「开关读账本 + 横幅显示 `restore`」，本次让两者自动收敛；desktop profile 是本仓库的符号链接 ⇒ 刷新页面即可看到面板变化，宿主半改动需重启 desktop 或在管理器面板关→开一次本插件。
