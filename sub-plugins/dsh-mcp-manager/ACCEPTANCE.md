# ACCEPTANCE — dsh-mcp-manager

对应规格：`openspec/specs/mcp-manager/spec.md`（能力主规格；来源变更 `openspec/changes/archive/2026-10-18-add-mcp-manager-subplugin/specs/mcp-manager/spec.md`，2026-10-18 归档时同步）。
全部验收项必须**离线**运行（临时 `DSH_HOME`、不起真实服务、不碰正在运行的 profile），证据只认本文件末尾列出的命令与输出。

## A1 落点由矩阵决定（spec: 定义落点）

- [x] A1.1 全员生效：三个 profile 全勾 → 只有 `$DSH_HOME/cordis.patch.yml` 出现带 `# dsh-mcp-manager:2:server:<id>` 的 insert 行块；各 profile patch 与 `dsh-mcp.json` 未被改动（`host-http.test.mjs`；真实文件形态另见 E2「全员形态」）
- [x] A1.2 部分生效：改为只在 desktop+web → home 层无该 id，两 profile 各一条，dsh-tui 未动（`host-http.test.mjs`；真实三 profile 的 `planLayout` 三态见 E2）
- [x] A1.3 全不生效：home 层保留一条且行内 `disabled: true`，profile 层不残留（`host-http.test.mjs`）
- [x] A1.4 同 id 跨层重复被拒绝：写入拒绝 + 文件未变 + **未产生备份**（`host-http.test.mjs`；真实 home 上的跨层冲突 → `ok:false` 零写入见 E2）
- [x] A1.5 层序实证：profile 覆盖行在 home 层 insert 之前会被跳过（`tmp/probe-patch-order.mjs` 三种排列的原始输出 + 结论表见 `docs/knowledge/2026-10-18-mcp-manager-subplugin.md` 的「实证方法与三种排列」小节；`tmp/` 为不入库的调试稿，故结论以知识库文档为准）

## A2 矩阵与布局漂移（spec: 按 profile 的生效矩阵）

- [x] A2.1 矩阵由行分布反推（home 一条 disabled 的 insert = 全不生效；profile 层一条 = 只对该 profile 生效）（`host-core.test.mjs`；真实数据反推 6 台、5 台全员、Serena 全不生效见 E2）
- [x] A2.2 profile 列表来自 `$DSH_HOME/profiles/*` 磁盘目录，`node_modules` 与文件不作为 profile（`host-core.test.mjs`）
- [x] A2.3 已知 profile 集合变化导致落点与期望形态不一致时 → 标记「布局待修复/待确认」并给出建议动作与目标文件，**不写文件**（`host-core.test.mjs` 的 `NEW_PROFILE` / `INEFFECTIVE_OVERRIDE`）
- [x] A2.4 部分生效的服务器遇到新 profile 时标记待确认，MUST NOT 自动写入（`host-core.test.mjs` + `host-http.test.mjs`）
- [x] A2.5 顶层 `[]` 空模板（DSH 0.2.1-rc.5 新建 profile 时生成的空 patch 文件）按「0 条目」处理：`patchInfo.profiles.<p>.ok === true`、`error === null`（不再触发整块只读降级）；写入时先摘掉 `[]` 行再拼条目块（YAML 里 `[]` 后不许接 `- `），行首注释逐字保留（`host-core.test.mjs` 的「⑤-补 DSH 空 patch 模板」+ `host-http.test.mjs` 的 A2.5 端到端）

## A3 全局默认参数（spec: 全局默认参数）

- [x] A3.1 默认参数存于 `$DSH_HOME/.dsh-mcp-manager/state.json`；改 `toolCallTimeoutMs` 后新增表单初值随之变化（`host-http.test.mjs`）
- [x] A3.2 保存时默认值落成 `config` 内具体字段；`state.json` 之外不出现「默认」语义的键（`host-http.test.mjs`）
- [x] A3.3 `state.json` 缺失/损坏 → 回退内置默认值且不报错（`host-http.test.mjs` + `host-core.test.mjs` 的 `defaultState()`）

## A4 标记、所有权与一次性迁移（spec: 标记、所有权与一次性迁移）

- [x] A4.1 迁移把 5 条旧标记 `# dsh-mcp-manager:server:<id>` 改写为 `:2:` 新标记，并给 1 条形态匹配但无标记的条目补标记；无关注释逐字不变（`host-core.test.mjs`；真实 home patch 实测 `stats={relabeled:5,tagged:1,converged:1,skipped:[]}` 见 E2）
- [x] A4.2 迁移幂等：第二次执行零写入（`host-core.test.mjs` + E2）
- [x] A4.3 形态不匹配的 insert 条目与顶层其它键被跳过并在结果中报告（`host-core.test.mjs`）
- [x] A4.4 迁移执行前备份原文件（`host-http.test.mjs`）

## A5 写盘安全（spec: 写盘安全）

- [x] A5.1 加/改/删/启停/矩阵/迁移任一操作后，除目标行块外全部字节一致；中文注释、`!!js` 表达式、行序、CRLF/LF 逐字保留（`host-core.test.mjs` 的行级 diff 断言 + E2 对真实 1962 B home patch 的「非 MCP 相关行逐字不变（顺序 + 字节）」检查）
- [x] A5.2 原子写 + 写前备份 `<文件名>.bak-<时间戳>`，同目录只保留最近 10 份（`host-http.test.mjs`）
- [x] A5.3 同一文件并发写被串行化（后写者看到前写者的结果）（`host-http.test.mjs`）
- [x] A5.4 文件不是合法 YAML → 只读降级：写端点报错、文件未改、无备份残留（`host-http.test.mjs`）

## A6 面板（spec: 面板与状态展示）

- [x] A6.1 注册到 `settings.localPlugins.tab`；列出 id / serverName / transport / 落点层 / 生效 profile / 静态状态 / 工具数估计 / 原始 YAML 兜底入口（`bundle.test.mjs`）
- [x] A6.2 6 条既有条目全部列出，其中在 profile 层被覆盖的那条生效集合不含该 profile（`bundle.test.mjs` 的 fetch 桩数据：第 6 条 `location='profile'`、`matrix={desktop:false,web:true,'dsh-tui':false}` 表达该语义）
- [x] A6.3 宿主端点不可用 → 面板显示可读原因，不空白、不抛错（`bundle.test.mjs`：404/非 JSON → 降级横幅 + 错误码 + HTTP 状态 + 诊断逐行 + 重试）
- [x] A6.4 矩阵变更、跨 profile 写入前二次确认；标注「本 profile 热生效、其它 profile 待其自身重载」（`bundle.test.mjs`）

## A7 按需探测（spec: 按需探测连接）

- [x] A7.1 「测试连接」返回 `{ ok, latencyMs, toolCount }`；失败返回 `{ ok:false, latencyMs, error }`（`host-http.test.mjs`，探测桩；真机首跑见 N1）
- [x] A7.2 超时按 `probeTimeoutMs`（默认 8000）生效且条目/文件不变（`host-http.test.mjs`）
- [x] A7.3 列表加载不触发探测（断言桩未被调用）（`host-http.test.mjs`）

## A8 HTTP 与模型工具（spec: HTTP API 与模型工具）

- [x] A8.1 缺 `x-dsh-plugin` 头或跨源 → 403 且无写入（`host-http.test.mjs`）
- [x] A8.2 body > 1 MiB → 413（`host-http.test.mjs`）
- [x] A8.3 `@deepseek-ai/dsh-tools` 不可解析 → 跳过工具注册、不抛错、HTTP 与面板仍可用（`host-http.test.mjs`）
- [x] A8.4 4 个工具（`mcp_manager_list/set_enabled/restart/add`）在包可用时注册，能力与 HTTP 端点等价（代码核对 `src/index.js:1850/1856/1865/1873` + `host-http.test.mjs` 的桩断言）
- [x] A8.5 每个工具的 `defineTool` 选项都带 `output: { schema: { type:'string' }, render }`（execute 返回 JSON 字符串，render 返回单个 text ContentBlock）：DSH 0.2.x 的 `defineTool` 在定义期直接读 `options.output.render`/`.schema`，缺 `output` 抛 TypeError 且错误被最后一个 spec 吞掉 ⇒ 4 个工具**全部**注册失败（`host-http.test.mjs` 的 `FAKE_TOOLS_MODULE` 按真实契约做参数校验，空壳假实现无法蒙混）

## A9 与既有插件/条目互不干扰（spec: 与既有插件和条目互不干扰）

- [x] A9.1 一轮「新增/矩阵切换/删除」后，本插件与其它子插件的激活行、`dsh.profile.bundles`、`dependencies` 全部不变（`host-http.test.mjs`）
- [x] A9.2 路由重复注册（插件被加载两次）被就地捕获并写诊断，宿主启动不受影响（`host-http.test.mjs`）
- [x] A9.3 插件不改 `$DSH_HOME/dsh-mcp.json`（测试夹具里该文件字节不变）

## A10 仓库规范

- [x] A10.1 `sub-plugins/dsh-mcp-manager/package.json` 不声明 `dsh.bundle`，目录内无 `cordis.patch.yml`（`bundle.test.mjs`）
- [x] A10.2 `README.md` + `ACCEPTANCE.md` + `test/*.test.mjs` 齐备
- [x] A10.3 根外壳 `package.json` 与 `dsh-plugin-manager/package.json` 的 `version` 一致且已 patch 递增（0.3.16 → 0.3.17（首版）→ 0.3.18 → 0.3.19（§6 工具按钮）→ 0.3.19 → 0.3.20（工具对话框失败态耗时/徽标修正）→ 0.3.20 → 0.3.21（归档本变更并同步主规格）→ 0.3.22（工具列表静态优先 + 空态真探测）→ 0.3.23（DSH 0.2.1-rc.5 兼容：`defineTool.output` 必填、顶层 `[]` 空模板）；`dsh-plugin-manager/test/root-install-shell.test.mjs` 的 "shell and inner package carry the SAME version" 通过）
- [x] A10.4 归档前 `openspec validate add-mcp-manager-subplugin --strict` 通过；2026-10-18 已把 delta 同步进 `openspec/specs/mcp-manager/spec.md` 并归档到 `openspec/changes/archive/2026-10-18-add-mcp-manager-subplugin/`
- [x] A10.5 管理器 7 支测试与其它子插件测试无新增失败（见 E3：唯一失败是 `dsh-idle-hook` 两支既有 `spawn EPERM`）

## A11 工具列表（spec: 单台服务器的工具列表，2026-10-18 追加）

- [x] A11.1 每行「工具」按钮打开对话框，只发一次 `{action:'tools', payload:{id}}`（`bundle.test.mjs:984`）
- [x] A11.2 静态清单只含公开名以 `mcp__<serverName>__` 开头的已注册工具（含 description，缺失归一为 `''`），**不连接、不起进程**（`host-http.test.mjs:867`；`list` 与静态 `tools` 的 probeRunner 调用数断言为 0）
- [x] A11.3 静态为空 → `ok:true` + `tools:[]` + `note`（不是错误，`host-http.test.mjs:898`）；面板显示空态说明 + 「真探测」按钮并标注会启动一次 MCP 服务器子进程（`bundle.test.mjs:1027`）
- [x] A11.4 「真探测」= `{id, mode:'probe'}`：宿主复用探测连接与 `probeTimeoutMs`（默认 8000）请求工具列表，返回 `{mode:'probe', source:'probe', latencyMs, tools[]}`（`host-http.test.mjs:932`、超时复用见 A7.2 追加断言）；面板显示延迟 ms 与「真探测」徽标
- [x] A11.5 失败就地降级：`probe-failed` 与 `not-found` 只在对话框内显示错误码 + 重试，面板其它行不受影响；失败态的耗时从 **`error.latencyMs`**（宿主镜像，`error.fields.latencyMs` 也认）读取，不丢延迟；徽标保持用户请求的模式（真探测失败不回退成「本机已注册」）；标题优先用宿主回报的 `serverName`（条目可能不在本 profile 列表里）（`host-http.test.mjs:959`、`bundle.test.mjs:1056`/新用例 `the dialog reads the data-envelope failure and the tools-unavailable note`、`src/client.js:885 latencyOf`）
- [x] A11.6 首屏仍只调一次 `list`：**无** `tools`、**无** `probe` 请求（`bundle.test.mjs:486`）；`list` 响应形状不变
- [x] A11.7 `ctx.tools` 缺失或 `schemas()` 抛错 → 200 + 空清单 + `reason:'tools-unavailable'` + 诊断 `toolsLookup.registryAvailable=false`（`host-http.test.mjs:910`）
- [x] A11.8 寻址 `id` 优先于 `serverName`（两者都可，都不匹配 → `not-found`）；兼容旧响应形状（无 `mode`/字符串项/缺 description）不泄漏 `undefined`（`host-http.test.mjs:973`、`bundle.test.mjs:1086`）
- [x] A11.9 未新增第 5 个模型工具：A8.4 的 4 个 `mcp_manager_*` 断言不变（`host-http.test.mjs`）

## 已知未覆盖 / 未实测

- [ ] N1 宿主运行时实测（`ctx.loader.entries()` 形状、`profileContext` 成员、`ctx.tools` 可用性、`ctx.webServer.register` 在 desktop profile 的可用性）：**不在本机实测**，全部按能力探测实现（缺失/形状变化即降级），诊断写入 `$DSH_HOME/.dsh-mcp-manager/host-diag.json`。真机首跑建议先点一次「测试连接」并检查该文件的 `httpSkipped` / `applyError` / `loaderMissing`。
- [ ] N2 `restart` 的真实重启延迟未实测：语义为「重写该条目块触发配置重应用」，面板文案不承诺「进程已重启」。
- [ ] N3 `failOnStartupError: true` 的条目在连接失败时会回滚该 fiber（核心行为），面板只做标注、不做阻断。

## 证据

### E1 本插件测试（Lead 亲跑，2026-10-18）

| 命令 | 结果 |
|---|---|
| `node sub-plugins/dsh-mcp-manager/test/host-core.test.mjs` | tests 37 / pass 37 / fail 0（62ms） |
| `node sub-plugins/dsh-mcp-manager/test/host-http.test.mjs` | tests 31 / pass 31 / fail 0（1.24s）—— 含 §6.1 `tools` 端点 6 条新用例 |
| `node sub-plugins/dsh-mcp-manager/test/bundle.test.mjs` | 41/41 assertions passed, exit 0 —— 含 §6.2 工具对话框 7 条新用例（含失败态读 `error.latencyMs` 与宿主 `serverName` 优先的跨端核对） |

### E2 真实 `$DSH_HOME` 只读验收（`node tmp/verify-mcp-manager.mjs`，pass=23 fail=0）

输入：home patch 1962 B；profile patch desktop 9285 B / web 350 B / dsh-tui 10925 B（只读，不写）。

- 解析出 6 台，`mcp-Serena` 识别为 disabled
- 矩阵反推：6 台；5 台对全部 profile 生效；1 台全不生效；`servers` 只含 MCP 条目（非 MCP 覆盖行未被当成服务器）
- 真实数据无悬空 override；**合成**悬空 override 会被记为 `E_ORPHAN_OVERRIDE` 且不进 `servers`
- 迁移：新标记 `:2:` ×6、旧标记清零、二次零写入、Serena 同层 disable 覆盖行已收敛、与 MCP 无关的行逐字不变（顺序 + 字节）
- 落点：全员形态唯一写入目标 = home；跨层冲突 → `ok:false` 且零写入

（脚本位于 `tmp/`，被 `.gitignore` 忽略；同样的结论与数字已写进 `docs/knowledge/2026-10-18-mcp-manager-subplugin.md`。）

### E3 仓库级回归（2026-10-18，Lead 亲跑）

- 管理器 7 支全部 exit=0：`host-core` / `bundle` / `debounce` / `batch-remove-all` / `uninstall` / `root-install-shell` / `entry-config`
- 子插件全量 `sub-plugins/*/test/*.test.mjs` 共 17 支：仅 `dsh-idle-hook` 的 `host-core` 与 `bundle` 两支 exit=1，失败原因是 `spawn 失败：spawn EPERM`（沙箱禁止起子进程），与本变更无关
- `node --check src/client.js` 通过；无 DEBUG 残留

### E4 OpenSpec

归档前（2026-10-18）：

```
$ openspec validate add-mcp-manager-subplugin --strict
Change 'add-mcp-manager-subplugin' is valid
```

归档后（同一天）：delta 已同步进 `openspec/specs/mcp-manager/spec.md`（10 条需求、含 §6「单台服务器的工具列表」），变更目录移到 `openspec/changes/archive/2026-10-18-add-mcp-manager-subplugin/`；`openspec list` 不再列出该变更。

```
$ openspec list
Changes:
  add-dsh-idle-hook                        47/52 tasks   16d ago
  2026-09-18-add-remove-all                ✓ Complete    16d ago
  2026-09-13-hindsight-model-autostart     19/21 tasks   2026/9/14
  add-repo-root-install-entry              22/23 tasks   2026/9/10
```

（`tasks.md` 里 0.1–0.3 三条保持未勾选：它们是「在运行中的宿主里实测 loader 形状 / profileContext / 重启耗时」，本机未做实验，已改为等价的能力探测实现并在 README「已知行为」注明。）
