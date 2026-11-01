# dsh-mcp-manager 在 DSH 0.2.1-rc.5 上的两处硬失效（`[]` 空模板 + `defineTool.output`）

日期：2026-11-01　涉及：`sub-plugins/dsh-mcp-manager`（0.3.22 → 0.3.23）

## 现象

升级到桌面版 DSH **0.2.1-rc.5** 后，设置 → 本地插件 → MCP 服务器 顶部出现黄框：

> 只读降级：patch 文件无法解析，宿主已进入只读：所有写端点都会被拒绝，文件不改、也不产生备份。

明细：`dsh-tui: E_NOT_SEQUENCE: 第 4 行不是顶层数据条目（patch 必须是顶层 YAML 数组）：[]`

被锁的是**没装过 MCP 的那个 profile**（本例 `dsh-tui`），其 `cordis.patch.yml` 只有三行注释加一个顶格 `[]`。

## 根因一：新建 profile 的空 patch 模板就是顶格 `[]`

DSH 0.2.1 新建 profile 时写出的 patch 是：

```yaml
# DSH 补丁层：profile tui（由 dsh 新建）
# 本文件由 dsh 维护
# 除非你清楚在做什么，否则不要手动编辑
[]
```

`[]` 是 YAML 的**流式空数组**，语义上等于「零条目」，完全合法；但本插件的 `detectParseError()` 只认行首 `-` 的块序列，把 `[]` 当成「不是顶层条目」 ⇒ 判 `E_NOT_SEQUENCE` ⇒ 整个文件只读降级。

修法（`src/host-core.js`）三处：

1. `isFlowEmptyDoc(bare)` = `/^\[\s*\]$/` —— 只认顶格、可含空白的 `[]`/`[ ]`；
2. `detectParseError()` 遇到它**继续**往下扫，并记行号；同时在两处报 `E_FLOW_DOC_CONFLICT`：**重复的 `[]`**、以及 **`[]` 与任何顶层 `-` 条目并存**（后者是真非法 YAML，必须拒绝而不是猜）；
3. `parsePatch()` 结果多一个 `flowEmptyDoc: number | null`；`applyUpsert()` 在拼新条目块**之前**先 `splice` 掉那一行 —— YAML 里 `[]` 后面接序列项是非法文档，直接往后追加会写出坏文件。

`.tmp` 里那套「先摘行再拼块」的顺序是硬要求：先拼后摘会留下一个 `[]` 行落在条目之间。

⚠️ 注意别用 `yaml` 库「解析后重写」来绕过：本插件的全部写盘都是**行级块拼贴**（保注释 / `!!js` / 行尾 / 行序），换成结构化重写会丢东西。

## 根因二：0.2.x 的 `defineTool` 里 `output` 是必填

`ctx.tools.defineTool({ name, description, parameters, execute })` 在 0.2.x 的定义期直接读 `options.output.render` 与 `options.output.schema` ⇒ 漏传抛 `TypeError`。更坏的是 `registerTools()` 里那段循环：错误发生在**最后一个 spec** 的位置并被其 catch 吞掉，表现是「4 个 `mcp_manager_*` 工具一个都不存在」，而 HTTP 端点与面板都正常，很容易误判成「0.2.1 不支持模型工具」。

修法（`src/index.js` 的 `registerTools`）：

```js
output: {
  schema: { type: 'string' },
  render: (_args, value) => [{ type: 'text', text: String(value) }],
},
```

`execute` 本来就返回 JSON 字符串，所以 `schema` 用 `string`、`render` 原样透出成一个 text ContentBlock 即可。`validateJsonSchemaValue` 对 `{type:'string'}` 走 `typeof value === 'string'`，合法。

**测试层面**：`host-http.test.mjs` 的 `FAKE_TOOLS_MODULE` 必须按真实契约校验 `output`（我们让它在缺 `output` 时抛错），否则空壳假实现会让这个 bug 永远绿。

## 兼容面核查（0.2.1-rc.5 实测）

方法：解包桌面版 `resources/app.asar`，遍历 `dsh/node_modules/@deepseek-ai/**/*.js`，用正则抓 `super(ctx, 'X')` / `service('X')` / `provide('X')` / `ctx.set('X'` 的注册名，与本插件 `ctx.get/inject` 的服务名求交。

结论：`tools` / `webServer` / `settings` / `agentPresets` / `pluginPackages` / `profileContext` / `storageDomain` / `agents` / `sessions` / `subagents` / `sessionQuery` / `commandUi` / `remote` / `locale` **全部存在**。其中 `storageDomain` 是 `domainCtx.provide("storageDomain", facility)` 形式，按 `super(` 扫第一遍会漏。

- `webServer.register({ kind:'exact'|'prefix' })` 仍在（`dsh-host-webserver/lib/index.js:326`，返回 disposer）；
- `tools.schemas()` 仍在（本项目「工具」清单的静态来源）；
- `settings.prepareDocument()` 仍在（`dsh-settings/lib/index.js:406`）；
- `settings.installSection` 在 0.2.x **仍不存在** —— 本插件本就走「profile 条目 `Config`」，只在能力存在时才调用，无需改；
- `realms` 服务不存在，但 `agent-preset-manager` 的 `findParentRealmService` 是「先 `ctx.get(name)` 再退回 realms」的兜底，取不到也无害。

## peer 语义陷阱：`^0.2.0-rc.1` 是**满足** 0.2.1-rc.5 的

`dsh-app-boot/lib/index.js` 的 `evaluatePluginCompatibility()` 用：

```js
semver.satisfies(runtimeVersion, range, { includePrerelease: true })
```

裸 `semver.satisfies('0.2.1-rc.5', '^0.2.0-rc.1')` 返回 **false**（预发布版默认不匹配），带 `includePrerelease: true` 才是 **true**。所以本仓库各插件的 peer 声明不用因为 rc 版本而抬；只有当你自己手写兼容判定时才需要注意这个差别。

## 教训

1. **「文件合法但我的解析器不认」是一类固定故障**：DSH 自己新建的空模板 `[]`、可能的显式 `---`/`%YAML`、`[ ]` 变体，都属于「语义 = 零条目」而非「坏结构」。判 `ok` 再判内容，别让解析器替用户决定文档是坏的。
2. **接受一种空文档形态就必须同步处理写入路径**：`[]` 不能与 `- ` 条目共存，只改读、不改写 = 写出一份 DSH 下次读不回来的文件（比只读降级更糟）。
3. **框架 API 的必填项会随版本变化，且错误常被循环里的 catch 掩盖**：`defineTool` 的 `output` 就是典型；假模块必须按**真实签名**校验，否则测试只证明了「我们自己说的契约」。
4. 复核方法照旧：`node test/*.test.mjs` 全绿 + 新增用例在改前版本上应当是红的（本例 host-core 38/38、host-http 32/32；新 A2.5 用例在旧代码上判 `ok:false`）。

## 参考

- 规格：`openspec/specs/mcp-manager/spec.md`；验收：`sub-plugins/dsh-mcp-manager/ACCEPTANCE.md` 的 A2.5 / A8.5
- 相关篇目：`docs/knowledge/2026-10-18-mcp-manager-subplugin.md`（补丁分层与落点）
