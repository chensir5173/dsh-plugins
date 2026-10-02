# dsh-agent-preset-manager — 0.2.0 的 agent preset 加载形态与本地目录桥接

日期：2026-10-02 ｜ 产物：`sub-plugins/dsh-agent-preset-manager/` ｜ 变更：`openspec/changes/add-agent-preset-manager/`

## 背景

DSH 0.2.0 线把 agent preset 改成 **bundle 形态加载**，用户自己的本地目录（旧版 `~/.dsh/.agent-presets/`）不再被自动读取。要让本地目录继续可用，只有两条路：把目录内容翻译进新形态的 bundle，或者**在运行期把 preset 声明进宿主注册表**。本插件走后者。

## 可复用结论

- **不要改写 profile 的 `cordis.patch.yml` 来加载 preset**：该文件由 `dsh-plugin-manager` 独占维护，且每次写入都会触发核心整树事务性重应用、独占宿主事件循环 0.7–1.2 s（见 [2026-09-10-toggle-write-batching.md](2026-09-10-toggle-write-batching.md)）。运行期声明既不打这个代价，也天然是「本会话/本进程有效」的语义。
- **注册表服务的取法与降级**：宿主半依次 `ctx.get('agentPresets')`、`ctx.get('agentPresetsRoot')`（取 `.agentPresets` 或对象本身），失败时回退 `ctx.inject(['agentPresets'], cb)`；拿到 `register({ id, name, description?, order?, plugins })` 后每次启用都调用它并把**返回的 dispose 句柄**存进 probe；服务缺席就是「只读降级」——面板能查看与编辑，启用/停用明确不可用并给出原因，绝不静默。
- **声明必须有回滚**：启用 = 读元数据 + 读组合 → `register(...)` → 写 `state.json`；任何一步失败都要撤掉这次 `register`（否则宿主里留下半个声明）。写 `state.json` 失败时同样要撤声明再报错（本插件实测断言 `declared.length === 0`）。
- **状态是账本不是事实**：`state.json` 只记「用户想要启用哪些 id」；进程重启后声明全部消失，宿主半启动时按账本重放（`restoreEnabled`）并且**只报告不写回**——重放失败要让用户看见，不能偷偷改账本。
- **库目录约定**（面板与迁移都按它工作）：新库 `$DSH_HOME/agent-presets/<id>/`，旧库 `$DSH_HOME/.agent-presets/<id>/`，**旧库优先**（同名时新库那行标注 shadowed）；每个预设两个文件：`preset.yml`（元数据）+ `agent.cordis.yml`（组合行）；状态 `$DSH_HOME/agent-preset-manager/state.json`；组合备份 `<预设>/.backup/` 保留 3 份。
- **写组合的纪律**：先 `backupFile(file, 3)` 再 `writeTextAtomic`（tmp + rename）；文本为空、YAML 解析失败、行 id 重复一律**拒绝保存且一个字节都不写**（单测实测：坏 YAML 时原文件 sha 不变）。
- **体检要分两层**：元数据坏 ≠ 状态坏——只有「组合坏」才把状态标成 `invalid`，元数据坏时状态仍是 `disabled`（本插件实测口径）。行体检三级 `ok / suspect / unavailable`，其中 `unavailable` 优先展示（有 unavailable 时 problems 里不再列 suspect 行）。
- **客户端 tab 注册范式**（本仓已统一）：`ctx.slots.inject('settings.localPlugins.tab', () => ctx.slots.register({ name: 'settings.localPlugins.tab', id, order, label }, Panel))`，`inject: ['slots']`，无 JSX（`React.createElement` + 内联样式 + `--dsw-*` token），入口是 `window.__ModuleLoader__.load({ id, factory: (require) => { const React = require('react'); … return { apply, inject: ['slots'] } } })`。本插件 tab：id `agent-presets`、order 20、标签「Agent 预设」。
- **⚠️ tab order 占用实测（2026-10-02）**：`dsh-plugin-manager` 自己的面板 `plugins` = **0**（`dsh-plugin-manager/src/client.js:651-663`：一级入口 `settings.section` order 16 + tab order 0）、本插件 `agent-presets` = 20、`dsh-hindsight-model/src/client.js:928` `hindsight-model` = 30、`dsh-idle-hook/src/client.js:1128` `idle-hook` = 40、`sub-plugins/dsh-esc-rewind/src/client.js:202` `subagents` = 50。**`dsh-plugin-manager/ACCEPTANCE.md:40` 把管理器 tab 记成 order 20，与源码不符**（它把 section 的 16 与 tab 的 0 混成了 20）——新增 tab 前请按源码核对，不要照抄该行。

## 踩坑

- **`React.createElement` 的括号不足会静默吞掉后续 children**：`FILTERS.map((key) => React.createElement('button', {...}, t(...)))` 少一个右括号时，后面的 error/notice/表单/列表会被当成 `Array.prototype.map` 的多余位置参数**无声丢弃**（语法仍合法，`node --check` 通过）。必须用渲染结构验证（本插件客户端测试打印根节点 children 数量与类型），只跑 `node --check` 不够。
- **测试里模拟磁盘故障要在 deps 层注入**（`world.deps.writeTextAtomic` / `readdir` 等），不要 monkeypatch `fs.writeFileSync`/`fs.statSync`——`mkdtempSync` 也走它们，会误伤 fixture。
- **`deps.readText` 对缺失文件必须返回 `null`（不能抛）**：扫描把「目录里没有这个文件」当正常事实；抛异常会把「没元数据」误判成「元数据坏」。
- **YAML 坏样例要挑真会坏的**：`name: broken: [` 与未闭合单引号都**合法**（按裸标量/标量接受），只有 `name: [1` 这类流式集合/锚点语法才触发解析错误；拿前两种写「元数据损坏」用例会假绿。
- **恢复被替换的 deps 方法要用保存的引用**：`delete world.deps.readdir` 只会让属性变成 `undefined`（后续扫描恒空、报「找不到预设目录」），必须 `const real = world.deps.readdir; … ; world.deps.readdir = real`。
- **HTTP 层白盒测试**：宿主半用 `ctx.webServer.register` 挂端点，测试时直接用 `createHandlers(core)` 造 handler 表，请求用 `node:events` 的 EventEmitter 造假 `req`（`queueMicrotask` 里 emit `data`+`end`），`req.url` 要自己给（`GET /file?id=…` 的 query 由 handler 从 `req.url` 解析后合并进 body）。

## 验证

```bash
node --test sub-plugins/dsh-agent-preset-manager/test/bundle.test.mjs   # 31 pass
node --test sub-plugins/dsh-agent-preset-manager/test/client.test.mjs   # 4 pass
```

文档与自检：`sub-plugins/dsh-agent-preset-manager/README.md`、`ACCEPTANCE.md`。
