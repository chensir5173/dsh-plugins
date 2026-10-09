# dsh-hindsight-model 退役（暂时废弃）修改报告

日期：2026-10-09 · 触发：用户要求「暂时废弃掉 hindsight 子插件的功能」 · 涉及：`dsh-plugin-manager`（退役名单）、`dsh-hindsight-model`（仅文档）、desktop profile（一行停用）

## 一、改了什么

| 文件 | 改动 | 为什么 |
|---|---|---|
| `dsh-plugin-manager/src/host-core.js` | `RETIRED_PLUGIN_DIRS` 加 `dsh-hindsight-model`（带日期与理由注释、含恢复步骤） | 扫描跳过 = 面板不再列出、管理器再也激活不了它；源码/文档/测试保留 |
| `dsh-plugin-manager/README.md` | 退役名单表加一行；补一句本次实例的 profile 处置 | 名单是面板行为的唯一说明书 |
| `docs/plugins.md` | 总表该行改退役样式；`### dsh-hindsight-model` 加退役横幅；tab 表与宿主 HTTP 表摘掉 `hindsight-model` / `/__hindsight-model/*` | 退役后这两条表格描述的东西不再存在 |
| `sub-plugins/dsh-hindsight-model/README.md` | 顶部退役横幅（原文保留） | 照 `dsh-open-session-workdir` 的范例，读 README 的人第一眼就该知道它退役了 |
| `docs/knowledge/README.md` + `docs/knowledge/2026-10-09-retire-hindsight-model.md` | 新增索引行与知识库正文 | 沉淀「退役 = 扫描排除 + profile 停用两个动作」这条可复用结论 |
| `package.json`、`dsh-plugin-manager/package.json` | 0.3.10 → 0.3.11 | 仓库规则：改管理器就同步 patch 递增 |
| `C:\Users\chenjunhao04\.dsh\profiles\desktop\cordis.patch.yml`（仓库之外） | `- id: hindsight-model` 加 `disabled: true` | 退役只动扫描，不停 profile 行 ⇒ 功能不会停 |

## 二、验证

| 命令 | 结果 |
|---|---|
| `node dsh-plugin-manager/test/root-install-shell.test.mjs` | **PASS** —— 含 `ok - retired plugins stay in the clone as source but never reach the panel`（真实仓库上断言退役目录留在磁盘、不进扫描结果、manifest 仍可读） |
| `node dsh-plugin-manager/test/host-core.test.mjs` | **PASS**（`host-core tests: PASS`）—— 合成仓库扫描只返回非退役项，`RETIRED_PLUGIN_DIRS[0]` sanity 断言通过 |
| `node dsh-plugin-manager/test/bundle.test.mjs` | **PASS**（`bundle tests: PASS`）—— 面板/端点/文案契约未受退役影响 |
| `node sub-plugins/dsh-hindsight-model/test/bundle.test.mjs` | **PASS，115/115** —— 源码一行未动，套件仍全绿（「源码保留」的实际证据） |
| profile YAML 复核（js-yaml 解析 `cordis.patch.yml`） | **PASS** —— `hindsight-model` 行读回 `{"id":"hindsight-model","name":"dsh-hindsight-model","disabled":true}` |

## 三、回滚

- 功能：删掉 desktop profile `cordis.patch.yml` 里 `hindsight-model` 行的 `disabled: true`（重启 DSH 生效）。
- 面板：从 `RETIRED_PLUGIN_DIRS` 删掉 `dsh-hindsight-model`。
- 文档/版本：`git revert` 本次提交。

## 四、没做什么（明确边界）

- **没删目录、没删测试、没改 `openspec/specs/`** —— 退役是运行层取舍，不是契约变更（与 2026-09-18 那次口径一致）。
- **没碰** web profile 的 `@vectorize-io/hindsight-coding-agents`（第三方官方包，Hindsight 记忆本体）与其 bundle 行；也没碰 Hindsight 自己的 Python 环境与 `~/.hindsight/` 数据。
- 没动 `dsh-hindsight-model` 的源码一行。