## 1. host-core 纯逻辑（批量目标集 / 批量行变换）

- [x] 1.1 新增 `batchPlan(derived, enabled)`：输出 `{ targets, skipped, count }`，targets 含 `needsInstall` 标记；跳过项带机器可读 reason（`already-active`/`already-disabled`/`inactive-dep-only`/`not-installed`/`legacy-layout`/`invalid-dir`）。验证：`node dsh-plugin-manager/test/host-core.test.mjs` 新增用例全绿（开启方向 = disabled+uninstalled、关闭方向 = active、inactive/legacy/invalid 一律跳过且不计入 count）。
- [x] 1.2 新增 `upsertManagedMany(rows, entries)`：对多个 `{id,name,enabled}` 一次变换，语义与逐次 `upsertManaged` 等价且不改输入。验证：host-core 单测断言「与逐个 upsert 结果逐字节相同」「空 entries = 恒等」「legacy plain override 行仍被改写为 canonical insert 行」。

## 2. 宿主批量端点（一次安装 + 一次写入）

- [x] 2.1 抽出 `ensureDevDeps(c, entries)`：一次性写齐全部缺失/陈旧 `link:`（单次 `package.json` 备份），只执行一次 `pnpm install`；失败回滚 manifest 并返回失败集合。验证：隔离 `DSH_HOME` 的 handler harness 中断言 `pnpm` 只被调用一次、manifest 回滚后与操作前逐字节一致。
- [x] 2.2 新增 `POST /__dsh-plugin-manager/set-all-enabled {enabled}`：`flushPending → 快照 → batchPlan → ensureDevDeps → upsertManagedMany → 一次 writePatchRows → 返回 listPayload + results + counts`；既有点点端点契约不变。验证：`test/batch-toggle.test.mjs`（真 `registerHttp` + 临时 `DSH_HOME`）断言一次批量只产生一次 patch 写入、响应 `counts` 与文件内容一致。
- [x] 2.3 失败逐项回报：安装失败只让 `needsInstall` 目标标 failed（reason `install-failed`），已安装目标照常落盘；patch 写入失败时整批 failed + `lastFlushError` 记录。验证：harness 中把 `pnpm` 桩成失败 → 未安装项 failed、已安装项 applied、文件里已安装项已是目标状态。
- [x] 2.4 端点边界：坏 JSON → 400；非法/未知 dir 不在批量语义内（批量不需要 dir）；`enabled` 缺省视为 true；全批无可作用项时返回 `noop` 且不写文件。验证：harness 断言 `writeCount===0` 与 HTTP 状态码。

## 3. 客户端面板（按钮 / 确认 / 锁定 / 提示）

- [x] 3.1 顶栏新增「全部开启 (N)」「全部关闭 (N)」两个次按钮（N 由与宿主同源的 `batchPlan` 口径算出），`N===0` 置灰，执行中显示「处理中…」。验证：`node dsh-plugin-manager/test/bundle.test.mjs` 新增断言（两个按钮渲染、N 文案、N=0 时 disabled）。
- [x] 3.2 点击后弹 `window.confirm`（含数量与 legacy 跳过说明），确认才 POST `/set-all-enabled`；完成后复用 `settle()`，「正在应用」提示随后自动撤下。验证：bundle.test 断言取消时不发请求、确认时请求体为 `{enabled}`。
- [x] 3.3 批量执行中锁面板：每行开关/移除与「一键接管/迁移」禁用；结果提示条显示成功数 + 失败逐条（插件名 + 原因）+ legacy 跳过提示；有带 client 的插件被改动时显示「刷新页面使界面生效」+ 刷新按钮（不自动刷新）。验证：bundle.test 断言 busy 期间按钮 disabled、失败逐条渲染、刷新按钮出现。

## 4. 自动化测试与红能力对照

- [x] 4.1 host-core 单测覆盖边界：全部已激活（关闭 N=6 / 开启 N=0）、混合态、inactive 跳过、legacy 跳过并计数排除、invalid 跳过、空仓库（N=0）、upsertManagedMany 不动其它行。验证：`node dsh-plugin-manager/test/host-core.test.mjs` 全绿并打印用例数。
- [x] 4.2 真 handler harness（`test/batch-toggle.test.mjs`）：真 `registerHttp` + 假 web 服务器 + 临时 `DSH_HOME`/仓库，覆盖「6 项一次写入」「未安装项一次安装」「安装失败逐项回报」「排队单行意图先落盘再批量」「无可作用项不写文件」。验证：`node dsh-plugin-manager/test/batch-toggle.test.mjs` 全绿。
- [x] 4.3 红能力对照：临时把批量改回「逐项写文件 / 逐项安装」，确认 4.2 的关键断言精确失败；随后还原代码并复跑全绿。验证：失败信息与还原后的全绿输出都贴进交付摘要。
- [x] 4.4 全量回归：三个既有测试文件（host-core / bundle / debounce）与新测试一起跑，确认既有 400 ms 意图去抖行为未被破坏。验证：四条 `node <test>` 命令输出全绿。

## 5. 文档

- [x] 5.1 `dsh-plugin-manager/README.md`：面板能力表与端点表加入批量开关（含「一次点击 = 一次写入 + 一次安装」与跳过规则）。验证：README 中 `/set-all-enabled` 与「全部开启/全部关闭」小节可检索到。
- [x] 5.2 `dsh-plugin-manager/ACCEPTANCE.md`：新增 A10 章节，逐条对齐 delta spec 的 Scenario，标注哪些是自动化、哪些需真机（真机项 = 重启 dsh web 后面板点两个按钮）。验证：A10 覆盖 delta spec 每条 Requirement 至少一个 Scenario。
- [x] 5.3 `docs/knowledge/` 新增一篇（批量语义 + 一次写入/一次安装 + legacy 跳过）并在 `docs/knowledge/README.md` 索引登记一行。验证：索引行与新篇文件名一致、可点开。

## 6. 校验与归档

- [x] 6.1 `openspec validate add-batch-toggle-all --strict` 通过。验证：命令输出 valid。
- [x] 6.2 `openspec archive add-batch-toggle-all` 归档，主 spec `openspec/specs/plugin-manager/spec.md` 合入新 Requirement。验证：`openspec list` 无活跃变更、主 spec 含新增 Requirement、归档目录存在。
- [x] 6.3 输出交付摘要（改动文件清单 + 测试输出 + 真机验收清单 + 建议的提交拆分），**不执行 git commit**。验证：摘要包含 `git status` 改动清单与四条测试命令结果。
