# Tasks — add-mcp-manager-subplugin

约定：所有路径相对 `D:\ChenSirDocument\Dsh-Projects\dsh-plugins`。测试一律离线、用临时 `DSH_HOME`、不起真实服务、不碰 `C:\Users\chensir5173\.dsh` 下的真实 profile 文件。

## 0. 前置实测（阻塞后续，先做）

- [ ] 0.1 **未实测（改为能力探测）**：不在运行中的宿主里读 `ctx.loader.entries()`。替代实现：`loader` 缺失/形状不符 → `staticState = null`（界面「—」），命中 `options.name === '@deepseek-ai/dsh-mcp-client'` 才计，id 剥 `include:` 前缀；结论写进 `docs/knowledge/2026-10-18-mcp-manager-subplugin.md` 的「实现契约」。
- [ ] 0.2 **未实测（改为能力探测）**：`profileContext` 成员、desktop profile 的 `ctx.webServer` 精确路由、`await import('@deepseek-ai/dsh-tools')` 三条都按「可用则用、不可用即降级」实现（锚定回退链 `profileContext → settings.prepareDocument → $DSH_PROFILE_DIR`；`webServer` 缺失 → 端点不注册 + 诊断 `httpSkipped`；`dsh-tools` 缺失 → 跳过 4 个模型工具）。**未在真机验证**，见 ACCEPTANCE N1。
- [ ] 0.3 **未实测**：「重写同一块（字节不变、仅 mtime 变化）是否触发热重应用、耗时、MCP 子进程是否真重启」本机未做实验（不愿在运行中的 profile 上起停全部 MCP）。因此 `mcp_manager_restart` 语义 = 「重写该条目块触发配置重应用」，面板与 README 文案都不承诺「进程已重启」。
- [x] 0.4 固化补丁分层语义：`tmp/probe-patch-order.mjs` 三态结论（profile 层 override 在 home 层 insert 前被跳过；反序才生效；同层 insert→override 生效）已写进 `docs/knowledge/2026-10-18-mcp-manager-subplugin.md`，并在 `src/host-core.js` 顶部注释引用——**`planLayout` 的存在理由就是它**。

## 1. 纯逻辑 host-core（worker: t1-host-core）

写权范围：`sub-plugins/dsh-mcp-manager/src/host-core.js`、`sub-plugins/dsh-mcp-manager/test/host-core.test.mjs`。

- [x] 1.1 `src/host-core.js`（1635 行，ESM，**0 个 import/require、不碰 fs**；YAML 只做行解析）。导出 19 个必需函数 + 9 个常量：`MARK`、`detectEol`、`splitKeepEol`、`parsePatch`、`locateServerBlock`、`locateDisableBlock`、`buildInsertBlock`、`buildDisableBlock`、`planUpsert`、`planRemove`、`planSetEnabled`、`planLayout`、`planMigration`、`validateMcpConfig`、`listProfiles`、`profilePatchPath`、`statePath`、`mergeServers`、`defaultState`。签名与返回形状见 `src/index.js` 的调用点与 `test/host-core.test.mjs`。
- [x] 1.2 `test/host-core.test.mjs`：`node:test`，**tests 37 / pass 37 / fail 0**（45.9ms）。覆盖 ① 真实 home patch 的 base64 逐字拷贝夹具（1962 B，sha256 `839fa1be…f28f6`）解析出 6 条；② 增/改/删/启停后非目标行逐字不变（含 CRLF + 中文注释 + `!!js`）；③ 落点三态；④ 跨层冲突与同文件重复 → `{ok:false, writes:[]}`；⑤ 5 种解析失败拒绝写入；⑥ 迁移 5 改写 + 1 补齐 + 1 收敛且幂等；⑦ 校验矩阵；⑧ 矩阵反推 + `NEW_PROFILE`/`INEFFECTIVE_OVERRIDE` 漂移 + 真实形态非 MCP 覆盖行不产出服务器。

## 2. 宿主装配（worker: t2-host）

写权范围：`sub-plugins/dsh-mcp-manager/src/index.js`、`sub-plugins/dsh-mcp-manager/test/host-http.test.mjs`。

- [x] 2.1 `src/index.js`（cordis 插件，`name`/`inject`/`apply`）：外部依赖惰性 + 可缺，全部注册失败就地捕获并写 `$DSH_HOME/.dsh-mcp-manager/host-diag.json`，**`apply()` 永不抛**。
- [x] 2.2 profile 锚定：`profileContext` → `settings.prepareDocument()` → `$DSH_PROFILE_DIR`（仅当同 home），**无任何 `profiles/web` 硬编码**；锚定失败 → `anchor-unavailable` 只读降级；结果进诊断。
- [x] 2.3 状态与写盘：`state.json` 读写（损坏回退内置默认）、写串行化、原子写、写前备份（保留最近 10 份）、EOL 沿用。
- [x] 2.4 HTTP：`ctx.effect(() => webServer.register({ kind:'exact', path:'/__dsh-mcp-manager/api', handler }))`；11 端点 `list | add | update | remove | setEnabled | setMatrix | getDefaults | setDefaults | probe | migrate | patchInfo`；缺 `x-dsh-plugin` 头/跨源 → 403，body > 1 MiB → 413，非 POST → 405，坏 JSON → 400，业务错误一律 200 + `{ok:false,error:{code,message,fields}}`。
- [x] 2.5 探测：`probe` 端点按 config 起一次客户端（stdio/http 两级模块解析），`probeTimeoutMs` 超时，返回 `{ok,latencyMs,toolCount?|error?}`，任何路径都关闭；`list` **绝不探测**。
- [x] 2.6 模型工具：`@deepseek-ai/dsh-tools` 可解析时注册 `mcp_manager_list` / `mcp_manager_set_enabled` / `mcp_manager_restart` / `mcp_manager_add`（disposer 交给 `ctx.effect`）；缺包跳过并写诊断。
- [x] 2.7 `test/host-http.test.mjs`：`node:test`，**tests 25 / pass 25 / fail 0**（~1.0s，离线、无子进程）。覆盖原 ①–⑤ 加新增 6 条；含只改目标行块、无关注释逐字不变、缺头/跨源零写入、非法 YAML 零写入零备份、重复路由不抛且写诊断、备份只留 10 份、CRLF 沿用、并发串行化、一轮操作后激活行/`bundles`/`dependencies`/`dsh-mcp.json` 全不变。
- [x] 2.8 （Lead 追加，spec: 面板与状态展示）`list.servers[]` 增加 `staticState`（`pending|loading|active|failed|disabled|unloaded|null`，`disabled` 优先，取不到即 `null`）与 `toolCountEstimate`（`tools.schemas()` 的 `mcp__<serverName>__` 前缀计数，能力缺失即 `null`）；**两种 null 都不影响 `list` 成功**。
- [x] 2.9 （Lead 追加）`payload.yaml`：整段 config 的 YAML，经 host-core `parsePatch` 结构化解析后与 `payload.config` 走**同一条写盘路径**（测试断言两条路径产出块逐字相同），`yaml` 优先；非法 YAML → 200 + `bad-yaml` + `fields`，零写入零备份。

## 3. 浏览器半面板（worker: t3-client）

写权范围：`sub-plugins/dsh-mcp-manager/src/client.js`、`sub-plugins/dsh-mcp-manager/test/bundle.test.mjs`。

- [x] 3.1 `src/client.js`：注册到 `settings.localPlugins.tab`（id `mcp-servers`、`order: 30`）；数据全走 `POST /__dsh-mcp-manager/api`（`{action,payload}` + `x-dsh-plugin` 头）。
- [x] 3.2 界面：服务器列表（id / serverName / transport / 落点层 / 生效 profile / 静态状态 / 工具数估计）、行内编辑、新增表单（含全局默认值预填与 YAML 子页）、删除确认、启停开关、profile 矩阵（跨 profile 写操作二次确认 + 「本 profile 热生效、其它 profile 待其自身重载」）、全局默认参数区、迁移（先预览后执行）、「测试连接」（标注会起子进程）；中英双语（`ctx.locale`，缺失按 `navigator.languages` 回退）。
- [x] 3.3 降级：宿主端点不可用 → 可读原因 + HTTP 状态 + 诊断 + 重试，不空白、不抛错、无 unhandled rejection（末条断言）。
- [x] 3.4 `test/bundle.test.mjs`：manifest 字段（**无 `dsh.bundle`**）、目录无 `cordis.patch.yml`、注册到 `settings.localPlugins.tab`、fetch 桩下 `list` 渲染、错误路径降级文案。
- [x] 3.5 （Lead 追加）接 `staticState`/`toolCountEstimate` 中文标签（未加载·加载中·已激活·失败·已停用；缺失/null → 「—」，界面不出现「未上报」字样）；YAML 子页改为**真实可提交**（整段 config、无外壳），`bad-yaml` 分支保留输入并逐字段显示。最终 **34/34 assertions passed**（较原 30 条新增 4 条）。

## 4. 包清单与文档（Lead）

写权范围：`sub-plugins/dsh-mcp-manager/package.json`、`sub-plugins/dsh-mcp-manager/README.md`、`sub-plugins/dsh-mcp-manager/ACCEPTANCE.md`。

- [x] 4.1 `package.json`（`dsh-mcp-manager`、`type: module`、`main: src/index.js`、`exports["./client"]`、`dsh.client.platform: web`；**不声明 `dsh.bundle`**、无第三方依赖）。
- [x] 4.2 `README.md`：用法、三层数据面、矩阵语义、已知行为（HMR 重载、探测会起子进程）、与旧项目/上游差异、卸载与回滚。
- [x] 4.3 `ACCEPTANCE.md`：A1–A10 逐条可验收项 + 证据来源 + 已知未覆盖 N1–N3。

## 5. 集成与收尾（Lead）

- [x] 5.1 跑全量：本插件 3 支（37/25/34 全绿）+ 管理器 7 支（全 exit 0）+ 其它子插件全量（仅 `dsh-idle-hook` 两支既有 `spawn EPERM` 失败，与本变更无关，已在 ACCEPTANCE 注明）+ 真实 `$DSH_HOME` 只读验收脚本（pass 23 / fail 0）。
- [x] 5.2 文档索引：`docs/plugins.md` 新增一览表行 + 「逐个怎么说怎么用」小节 + 槽位/端点分布两行；`docs/knowledge/2026-10-18-mcp-manager-subplugin.md` 新增并在 `docs/knowledge/README.md` 登记。
- [x] 5.3 版本同步：仓库根 `package.json` 与 `dsh-plugin-manager/package.json` 同步 `0.3.16 → 0.3.17`（`test/root-install-shell.test.mjs` 守住）。
- [x] 5.4 `openspec validate add-mcp-manager-subplugin --strict` 通过；**不归档**，报告并等用户确认归档。

## 6. 「工具」按钮（静态优先 + 按需真探测，2026-10-18 追加）

写权范围：宿主半 = `sub-plugins/dsh-mcp-manager/src/index.js` + `test/host-http.test.mjs`（worker: t2-host）；浏览器半 = `sub-plugins/dsh-mcp-manager/src/client.js` + `test/bundle.test.mjs`（worker: t3-client）。两人不得互写对方文件。

- [ ] 6.1 宿主半：新增 `tools` 动作 `{action:'tools', payload:{ id? | serverName?, mode?: 'static' | 'probe' }}`
  - 静态（默认）：取 `ctx.tools.schemas()` 中公开名以 `mcp__<serverName>__` 开头的条目 → `{ok:true, mode:'static', serverName, source:'registry', tools:[{name, description}]}`；**不连接、不起进程**，`list` 仍绝不探测（测试断言 probeRunner 调用数 0）。
  - `mode:'probe'`：复用探测的连接与超时（默认 8s）并请求工具列表 → `{ok:true, mode:'probe', serverName, source:'probe', latencyMs, tools:[{name, description}]}`；失败/超时走既有错误码，就地降级不影响其它端点。
  - 静态清单为估计值（工具名超长归一化后会漏），响应带 `note` 说明；`serverName` 与 `id` 均可寻址，两者都给时以 `id` 为准。
- [ ] 6.2 浏览器半：每行「工具」按钮 → 对话框（标题含服务器名与数量；来源徽标「本机已注册 / 真探测」；名称 + 单行截断描述可展开；复制工具名；加载/空/错误三态；空态提供「真探测」按钮并标注会启动一次 MCP 服务器子进程）；zh/en 文案补齐；首屏仍只调一次 `list`。
- [ ] 6.3 Lead 收尾：README / ACCEPTANCE / `docs/plugins.md` / 知识篇更新；版本 `0.3.18 → 0.3.19` 双处同步；跑全量测试 + 真实 `$DSH_HOME` 只读验收脚本；`openspec validate --strict`；**不归档**。
