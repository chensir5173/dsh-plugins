# DSH 插件：本地插件面板的批量「全部开启 / 全部关闭」

日期：2026-09-10｜插件：`dsh-plugin-manager`｜spec：`openspec/specs/plugin-manager/spec.md`（delta 原稿 `openspec/changes/archive/2026-09-10-add-batch-toggle-all/`）｜验收：`dsh-plugin-manager/ACCEPTANCE.md` A10

## 需求与结论

面板顶部两个次按钮「全部开启 (N)」「全部关闭 (N)」，N = 这一步真能改动的受管子插件数（0 时置灰）。**一次点击 = 一次 `cordis.patch.yml` 写入（一次核心重应用）+ 至多一次 `pnpm install`**，不是 N 次。

## 可复用结论

1. **批量的本质是「一次点击改 N 行」，和单行去抖是同一枚硬币的两面**：单行开关用 400 ms 意图去抖把 N 次点击合并成一次写入；批量则天然只有一次写入。两条路径都必须保证「N 行 = 1 次写入」，因为代价在「配置变更」本身（0.7–1.2 s 宿主事件循环独占，见 `mem:2026-09-10-toggle-write-batching`）。做法：新增纯函数 `upsertManagedMany(rows, entries)`，一次变换 + 一次 `writePatchRows`；`applyIntents` 改为它的薄别名，避免两份实现漂移。
2. **合并窗口里的单行意图要「接管」，不要「先 flush 再批量」**：`flushPending()` 会写一次文件，批量再写一次 → 两次重应用。正确做法是把 `pendingIntents` 取走（清空 + 清掉去抖定时器），当作「已生效」参与批量目标计算（`snapshot(ctx, cfg, queued)`），并**并进同一次写入**。既不吞用户的点击，也不多写一次。
3. **按钮上的数量只能有一个口径**：宿主 `/list` 直接返回 `data.batchCounts = { enable, disable }`（由 host-core 的 `batchPlan` 算出），面板只显示。客户端保留的同规则兜底 `localBatchCounts` 仅在旧宿主半（响应无该字段）时生效——这是唯一允许的重复。
4. **批量只动两态**：开启方向 = `disabled`（去掉行内 `disabled`）+ `uninstalled`（补 `link:` + 装一次依赖 + 写行）；关闭方向 = `active`（写 `disabled: true`，保留行与依赖）。`inactive`（仅依赖、无行）**不凭空补行**（两个方向都跳过）、`legacy` 跳过并提示先迁移、`invalid` 跳过——三者都不计入 N。
5. **失败语义 = 尽力而为 + 逐项回报**：响应给 `results[{dir,name,hasClient,outcome,reason?,error?}]` 与 `counts{total,applied,skipped,failed,installed,ranPnpm,wrotePatch}`；安装失败只让 `needsInstall` 那部分失败（`install-failed`）、已安装项照常落盘；批量期间锁面板（`busy === 'all'` 时每行开关/移除/迁移禁用）。

## 测试手法（可直接复用）

- **写入次数用 `node:fs` 打桩精确计数**：`const real = fs.writeFileSync; fs.writeFileSync = (f, ...rest) => { if (String(f) === patchFile) writes.push(1); return real.call(fs, f, ...rest) }`。ESM 的 `import fs from 'node:fs'` 拿到的是同一个 module.exports 对象，宿主半的写入会被一并统计——比 debounce.test 的 mtime 采样更准（无窗口、无漏采）。
- **`pnpm` 用接缝替换**：宿主半导出 `__setPnpmRunner(fn)`（`client.js` 早有 `window.__DSH_TEST__` 先例），harness 传桩即可断言「N 个未安装项只调用一次 `install`」，且绝不真装、不碰在跑 profile。
- **临时 profile 播种用 JSON、断言必须解析**：JSON 是 YAML 子集，用 `JSON.stringify` 播种最省事；但断言时 `"disabled": true`（JSON）与 `disabled: true`（js-yaml dump）写法不同，**正则数 `disabled: true` 会漏掉 JSON 播种的行**——要用 `js-yaml.load` 解析后再断（harness 里踩过）。
- **写入次数断言要取相对值**：harness 自己的 `seedProfile()` 也走 `fs.writeFileSync`，绝对计数会把自己算进去（第一次跑就得到 3 !== 1）。

## 验证命令

```bash
node dsh-plugin-manager/test/host-core.test.mjs      # batchPlan 六态 / N 口径 / upsertManagedMany 等价与不可变
node dsh-plugin-manager/test/batch-toggle.test.mjs   # 真 handler + 临时 DSH_HOME：一次写入 / 一次安装 / 逐项失败 / 排队意图接管 / legacy 跳过
node dsh-plugin-manager/test/bundle.test.mjs         # 面板：两个按钮与 N、确认与取消、执行期锁定、失败逐条、刷新提示
node dsh-plugin-manager/test/debounce.test.mjs       # 回归：单行连点仍只写一次
```

红能力对照（两次都精确失败后还原）：把批量改回逐项写文件 → `batch disable = exactly ONE patch-file write`（7 ≠ 1）；把安装改回逐项执行 → `two missing plugins cost exactly ONE pnpm install`（2 ≠ 1）。

## 生效条件

宿主半改动需**重启 `dsh web`**；客户端面板改动需**刷新页面**。真机验收项（重启后点两个按钮、看 `dsh --dump-config` 的 `disabled`、观察只卡顿一次）见 A10。