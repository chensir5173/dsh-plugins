# Design — add-batch-toggle-all

## Context

动机见 `proposal.md`。当前的实现形态（决定本次怎么做）：

- `src/host-core.js` 是**纯逻辑**：扫描仓库子插件、读写 profile patch 行的变换（`upsertManaged` / `removeManaged`）、状态推导 `deriveStates`（state ∈ `active | disabled | legacy | uninstalled | inactive | invalid`）、迁移规划 `planMigration`、意图合并 `mergeIntent` / `applyIntents`。
- `src/index.js` 是**宿主接线**：HTTP 端点 `/status`、`/list`、`/set-enabled`、`/remove`、`/migrate`；单行开关走「写 profile patch 文件 → DSH 核心重应用整棵配置树」，一次写入实测独占宿主事件循环 0.7–1.2 s，因此单行开关用 400 ms 意图去抖（`INTENT_DEBOUNCE_MS`）把连点合并成一次写入。
- `src/client.js` 是**浏览器半**：注册 `settings.section`（order 16），每行一个主开关 + 移除，动作后调 `settle()` 轮询 `/status` 直到 `pendingWrites===0` 且往返恢复，带 client 的子插件改动后提示「刷新页面使界面生效」（不自动刷新）。
- 现状数据：面板 6 个受管子插件全 `active`，profile patch 里另有 14 行非本仓库条目（`mcp-*`、`dsh-liquid-glass` …）**不得改动**；`legacyDetected=false`。

## Goals / Non-Goals

**Goals:**

- 一次点击把「面板列出的受管子插件」批量开启/关闭，且**一次点击 = 至多一次 patch 写入 + 至多一次 `pnpm install`**（而不是 N 次），把逐项点击的 N 次核心重应用压成 1 次。
- 批量与单行操作共用同一套状态模型与行变换，避免两处口径漂移。
- 失败可解释：逐项结果（applied / skipped / failed + 原因）回到面板，失败项保持原状态。

**Non-Goals:**

- 不做撤销按钮、不做「全部移除」、不做 legacy 自动迁移（跳过 + 提示先迁移）、不把管理器自身纳入批量、不动 profile 里其它插件的行。
- 不引入跨标签页/跨进程锁（锁定只作用于本面板实例；宿主侧靠「先落盘再快照」缩小竞争窗口）。
- 不改变既有端点契约，不新增持久化数据（仍只有 patch 文件与 profile `package.json`）。

## Decisions

### D1 新增宿主端点 `POST /__dsh-plugin-manager/set-all-enabled {enabled}`（而非客户端循环调 `/set-enabled`）

批量是一次用户手势，宿主必须能「先落盘排队意图 → 重新快照 → 一次性安装 → 一次性写入」。若由客户端循环发 N 次请求：每次都做一遍快照、可能各触发一次安装（每次 `ensureDevDep` 都会 `pnpm install`）、错误只能拼在客户端，且与 400 ms 意图去抖的交互不可控。

请求：`{ "enabled": true | false }`。响应：`{ ok, data: <listPayload.data>, results: [...], counts: {...}, warning? }`（`data` 与 `/list` 同构，面板直接复用）。

### D2 目标集与计数由 host-core 纯函数导出

新增纯函数 `batchPlan(derived, enabled)`（放在 host-core）：输入 `deriveStates` 的结果，输出 `{ targets: [{dir,rowId,name,state,needsInstall}], skipped: [{dir,name,reason}], count }`。

- `enabled=true`：targets = `state==='disabled'`（needsInstall=false）+ `state==='uninstalled'`（needsInstall=true）；skipped 含 `active`(already-active)、`inactive`(inactive-dep-only)、`legacy`(legacy-layout)、`invalid`(invalid-dir)。
- `enabled=false`：targets = `state==='active'`；skipped 含 `disabled`(already-disabled)、`inactive`、`uninstalled`(not-installed)、`legacy`、`invalid`。
- `count = targets.length`，即按钮上的 N。

面板的 N **不由面板自己算**：`listPayload` 直接附带 `data.batchCounts = { enable, disable }`（宿主用同一个 `batchPlan` 从派生状态算出），面板只负责显示，因此「按钮上写 6 就真的动 6 个」。客户端保留一份同规则的本地兜底 `localBatchCounts`，仅在拿到旧宿主半（响应里没有该字段）时使用——规则改动必须与 `batchPlan` 同步，这是本设计唯一接受的重复。

### D3 一次写入：`upsertManagedMany`

批量落盘时对 patch 行做**一次**变换 + **一次** `writePatchRows`：新增纯函数 `upsertManagedMany(rows, entries)`（entries = `[{id,name,enabled}]`，内部对每个 entry 复用 `upsertManaged` 的语义：已存在则只改 `disabled`，不存在则追加 canonical `insert` 行）。不逐项写文件，也不走 400 ms 去抖——批量的「合并」已经是它本身。

### D4 一次安装：批量补齐 devDependencies 后单次 `pnpm install`

`ensureDevDep` 现在对「缺失或 link 陈旧」的包各自改 manifest + `pnpm install`。批量新增 `ensureDevDeps(c, entries)`：先把全部需要安装的 entry（缺失、或 `link:` 指向旧目录）一次性写进 profile `devDependencies`（先备份 `package.json`），再执行**一次** `pnpm install`；失败则回滚 manifest，把「需要安装的目标」整体标记为 failed。已安装目标不受影响，照常落盘。替代方案是逐项安装：6 个插件 = 6 次写 manifest + 6 次 `pnpm install` + 6 份备份，明显更慢且失败粒度并没有变好。

### D5 执行顺序（含排队意图）

1. **接管**仍在合并窗口里的单行意图（`queued = pendingIntents` 后清空队列并清掉待触发的去抖定时器）：它们不产生独立的一次写入、也不被丢弃，而是与批量目标并进第 4 步的**同一次**写入；批量目标按「这些意图已生效」的状态计算（`snapshot(ctx, cfg, queued)`）。这样一次批量仍最多一次写入、一次核心重应用；
2. 重新快照（读 patch 行 + manifest + 扫描仓库）并计算 `batchPlan`；
3. 需要时 `ensureDevDeps`（一次写入 manifest + 一次 `pnpm install`）；
4. 读最新 patch 行 → `upsertManagedMany` → 一次 `writePatchRows`；
5. 返回 `listPayload` + `results`；客户端随后走既有 `settle()` 直到「正在应用」提示撤下。

第 4 步失败（patch 不可写）时：不产生 results 的 applied（整批 failed），诊断字段 `lastFlushError` 记录原因，/list 返回磁盘真实状态。

### D6 逐项结果契约

`results: [{ dir, rowId, name, outcome: 'applied' | 'skipped' | 'failed', reason? }]`，reason 取值：`already-active` / `already-disabled` / `inactive-dep-only` / `not-installed` / `legacy-layout` / `invalid-dir` / `install-failed` / `write-failed` + 人类可读文案。`counts: { total, applied, skipped, failed, installed, ranPnpm, wrotePatch }`（`installed` = 本次补装成功的目标数；`ranPnpm` = 是否真的执行过安装；`wrotePatch` = 是否真的写了 patch 文件，无变化时不写）。申请-结果里 `applied` 项的 `reason` 为 `null`，`skipped` 项带词表里的原因，`failed` 项带 `install-failed` / `write-failed` 与人类可读 `error`。

面板提示条按 outcome 分组显示：成功数 + 失败逐条（插件名 + 原因）+ 旧布局跳过提示。

### D7 面板形态

- 工具条（与「刷新」同一行、左对齐）：`全部开启 (N)` / `全部关闭 (N)`，`N===0` 时 `disabled` 并降透明度；执行中显示「处理中…」。
- 确认框：`确认关闭全部 N 个本地插件？（跳过 M 个旧布局插件，请先迁移）`——取消则不发请求。
- 执行中锁面板：`busy === 'all'` 时每行开关/移除/迁移按钮 `disabled`（沿用 `isBusy` 的既有形态），完成后解锁；随后若 results 里存在「带 client 且被改动」的项或沿用既有 `plugin.hasClient` 判定，则显示「刷新页面使界面生效」提示与刷新按钮。
- 文案双语（zhDict/enDict）与既有词条风格一致：`全部开启 / 全部关闭 / 处理中…` ↔ `Enable all / Disable all / Working…`。

## Risks / Trade-offs

- [「全部关闭」误点后不能精确还原混合状态（原 4 开 2 停 → 全开后 6 开）] → 已确认不做撤销；两个按钮都带确认框 + 数量，且每行仍可单独纠正；`cordis.patch.yml` 每次写入前都有 `*.bak-<ts>` 备份可手工回滚。
- [批量跑 `pnpm install` 期间面板被锁，用户以为卡死] → 显示「处理中…」，且安装是唯一的长步骤；锁只影响本面板，其它页面/插件不受影响。
- [一次批量仍会触发一次核心配置重应用（约 1 s 卡顿）] → 相对逐项点击的 N 次已是最优；沿用 `settle()`「正在应用」提示让窗口可读。
- [旧布局项被跳过，「全部关闭」之后仍有插件在跑] → 面板明确提示「先一键接管/迁移」，spec 中固化为 MUST。
- [跨标签页并发批量] → 不引入跨实例锁；宿主端「先落盘 → 重新快照 → 一次写入」保证不写陈旧副本，最终状态以最后一次写入为准。

## Migration Plan

无数据/格式迁移（行结构不变，仅 `disabled` 的写入由 N 次变 1 次）。上线 = 宿主半改动需重启 `dsh web`、客户端面板需一次页面刷新。回滚 = 还原 `src/*` 与文档即可，profile 文件无需还原。

## Open Questions

无（批量能力是否扩展到 CLI/斜杠命令已明确不在本次范围）。
