# dsh-session-time-bucket 变更报告：desktop 0.2.0-rc.2 会话侧栏时间桶标签重复

日期：2026-10-08 · 相关：`docs/knowledge/2026-09-06-dsh-session-time-bucket.md` §v3.1 · 交付物：客户端插件 + 测试 + 文档

## 1. 触发（用户报障）

desktop（0.2.0-rc.2）会话侧栏出现**重复的时间桶标签**：截图「今天 1 / 前7天 3 / 前7天 2 / 前30天 5 / 前30天 2」，条目名多为「未命名」，行尾相对时间（「5天」「21天」）正常。

## 2. 根因

插件 `sub-plugins/dsh-session-time-bucket` 给侧栏行按时间桶插入组头，组头身份来自「DOM 行标题 ↔ recency 快照」的**逐行文本匹配**；这条匹配的两端口径在核心升到 0.2.0-rc.2 后不再一致：

| 端 | 来源 | 无标题会话显示 |
|---|---|---|
| 核心渲染（DOM 文本） | `resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-client-ui-workspace\lib\client.js:1121-1123` `displayTitle(node,t) = node.blank ? t('session.new') : node.title \|\| t('session.untitled')`；同文件 `:391-393` `sessionTitle(session) = session.blank ? '' : session.title?.trim() ?? ''`（**不再回落目录名**）；字典 `:3870-3871` | **未命名** |
| 快照（插件读到的 `displayTitle`） | `…\@deepseek-ai\dsh-api-session-controller\lib\types\client\sessions\service.js:45-54` `displayTitleOf(title,cwd,id)` 仍 `title ?? workspaceTitleOf(cwd) ?? id`；`:500` 调用、`:508` 仅当 `entry.title !== undefined` 才带 `title` 字段 | 工作区目录名（如 `dsh-tmp`） |

于是 `matchRowTitles`（严格相等 + 顺序贪心 + used 集合）对**每个无标题会话行**都返回 `null` ⇒ `reconcile` 的 `allMapped = false` ⇒ 走 partial-mapping fallback：`keys[i] = null`，而 `planBuckets` 当时把 `null` 当**分段边界**（`if (!key) { cur = null; continue }`），组头 identity = `run.key + '#' + occ` ⇒ **同一时间桶被失配行切成几段就渲染几个同名组头**（真机「前7天 … 前7天」）。历史版本不暴雷的原因：0.2.0-rc.2 之前无标题行的 DOM 文本就是目录名，与快照一致。

## 3. 修改摘要

| 文件 | 内容 |
|---|---|
| `sub-plugins/dsh-session-time-bucket/src/client.js` | ① 行对象记 `untitled`（`typeof s.title === 'string' && s.title.trim() !== ''` 取反，blank 恒 false）；② 新增 `visibleRowTitle(row, blankLabel, untitledLabel)`（blank→新会话 / untitled→未命名 / 否则→标题），`matchRowTitles(domTitles, rows, blankLabel, untitledLabel)` 改用它，`reconcile` 传 `__t('session.untitled')`；③ zh/en 字典各加 `'session.untitled'`；④ `planBuckets` 改 `if (!key) continue`（未映射行是 gap、不再是分段边界），fallback 分支与 occurrence identity 不动 |
| `sub-plugins/dsh-session-time-bucket/test/bundle.test.mjs` | 夹具补 `title` 字段、新增无标题行；新增 3 条用例：未命名文案匹配（zh/en/缺参）、gap 语义（三组断言）、端到端「组头标签不重复」；16 → 18 条 |
| `sub-plugins/dsh-session-time-bucket/README.md`、`ACCEPTANCE.md` | 「行身份匹配」口径改写 + 「**行匹配用核心的文案，不是快照的 `displayTitle`**」取舍；验收加 [B] 4.4（同桶只出现一个组头）/ [B] 4.5（重命名途中不裂桶）；条数 16 → 18 |
| `docs/plugins.md`（dsh-session-time-bucket 小节） | 「实现约束值得知道」补匹配口径 |
| `docs/knowledge/2026-09-06-dsh-session-time-bucket.md`、`docs/knowledge/README.md` | 要点 5 改写 + 篇末新增 v3.1 小节；索引追加一行 |
| `package.json`、`dsh-plugin-manager/package.json` | 版本同步 patch+1：0.3.4 → 0.3.5（「有改动必须 bump」硬规则，由 `root-install-shell.test.mjs` 的版本一致护栏守住） |

## 4. 验证证据

| 项 | 结果 |
|---|---|
| `node sub-plugins/dsh-session-time-bucket/test/bundle.test.mjs` | **18/18 通过**（改前 16 条全绿，新增 3 条全绿） |
| 红绿：删掉 `visibleRowTitle` 的 untitled 分支 + `planBuckets` 还原 `cur = null` | **15/18**，红的正是 3 条新用例（未命名匹配 / gap / 端到端重复标签） |
| 全仓 sweep（本仓库所有 `*.test.mjs`，逐支 node 执行） | 绿：agent-preset-manager 2 支、composer-history-recall 24/24、composer-provider-label 55/55、esc-rewind 96/96、hindsight-model 115/115、open-session-workdir 31/31 + interception PASS、**session-time-bucket 18/18**、session-title-regenerate 25/25、manager bundle / entry-config / host-core / **root-install-shell（版本一致护栏）** / uninstall |
| 4 支红套件 | **均为沙箱环境限制、与本变更无关**：idle-hook `host-core`（4 条 `spawn 失败：spawn EPERM`）、idle-hook `bundle`（唯一失败用例 `test/bundle.test.mjs:861` 断言由 spawn 脚本写出的 marker 文件存在 ⇒ 同一 spawn 限制）、manager `batch-remove-all`（测试自身 `:81` `symlinkSync` 报 `EPERM: operation not permitted, symlink`）、manager `debounce`（同族，`:64` `symlinkSync` EPERM）。证据：`git diff --stat HEAD -- sub-plugins/dsh-idle-hook dsh-plugin-manager/src` **输出为空**（本变更未触碰这两处源码） |
| 生效方式 | profile `desktop` 的 `node_modules` 装的是**符号链接**（`~/.dsh/profiles/desktop/node_modules/dsh-plugin-manager` → 本仓库根）⇒ 刷新页面即生效；git 快照装法需 `dsh plugin update` |

## 5. 边界与遗留

- 修的是「**无标题会话**」这一类失配，不是删掉 fallback：fallback 仍保留（真正乱序/重名时按 occurrence identity 区分），只是 `null` 不再当边界。
- 口径来源仍是**文案**：若后续核心再改渲染文案（如「未命名」→ 其它词）或再加第二个回落源，仍需同步 `visibleRowTitle`；更稳的结构对齐（wrapper 下标 + 快照顺序）仍是可选演进方向。
- 沙箱内跑不了的 4 支套件需在无沙箱环境复跑一次，才算全仓绿。
- 工作区还有上一轮未提交的改动（`sub-plugins/dsh-composer-provider-label/*`、`docs/knowledge/2026-09-*`、`openspec/changes/*`），不在本报告范围。
