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

- **⚠️ 行体检只许「解析」，绝不许 `import()` 探测**（真机 fatal，2026-10-02）：第一版 `checkRowNames` 用 `deps.load(spec) { return import(spec) }` 是**同步**调用的——`import()` 返回的 Promise 恒为真值（于是每行都判 `ok`），而本地组合里指向官方包的行让这个**无人 await 的 Promise 拒绝**逃逸成 unhandled rejection，启动器直接打印 `dsh: fatal load failure: Error [ERR_MODULE_NOT_FOUND]: Cannot find package '@deepseek-ai/dsh-persona' imported from C:\WorkProject\GithubProjects\ChenSir5173\dsh-plugins\sub-plugins\dsh-agent-preset-manager\src\index.js`（栈顶是 `C:/Nt/dsh/packages/boot/app-boot/lib/index.js:1721` 的 ESM resolve 拦截器），进程随之退出。正解是宿主解析服务 **`ctx.get('pluginPackages').packageOf(spec, parentURL)`**（`C:/Nt/dsh/packages/boot/app-boot/src/profile-resolution/service.ts:60-117`）：纯解析、不执行模块。
- **`parentURL` 决定走哪层解析路由，探测必须多候选**（`C:/Nt/dsh/packages/boot/app-boot/src/profile-resolution/resolver.ts:364-611`）：parent 落在 profiles 树里 → 走 profile 层（能解析官方 `@deepseek-ai/*`）；parent 是 linked 仓库路径 → 走 `routeLinked`（只查祖先 `node_modules`，解析不到官方包，回落 `kind: 'native'` 并以真实 parent 报原生错误）。所以 `resolveSpec` 依次问：registry 的 `ctx.baseUrl`（= `mount.ts:263` 交给 `prepareProfileEntries` 的那个）→ `profileContext` 服务 → `$DSH_HOME/profiles/*/package.json` → 自己的 `baseUrl`，最后才退化到 `createRequire().resolve`。**宿主对 preset 的挂载失败只会 `logger.warn`（`agent-preset-registry/src/index.ts:80-118` 把 mount 错误 catch 成 `record.broken`），所以「挂载失败会 fatal」是错的——真正会 fatal 的是我们自己的探测。**

- **⚠️ `register()` 与 `unregister` 都是 async，绝不能当同步函数用**（2026-10-02，与上一条同源）：`C:/Nt/dsh/packages/preset/agent-preset-registry/src/index.ts:80-100` 的 `async register(definition)` 要 `await record.ready`（整棵 preset 树 mount 完）之后才 `return unregister`。第一版 `createRuntimeProbe` 的 `enable` 把返回值当函数读 ⇒ `typeof dispose !== 'function'` **恒真**，于是**每次启用都被我们自己的守卫拒绝**（面板永远显示「注册表没有返回撤销函数，无法保证「停用」可用，已拒绝这次启用。」）；同时那个 Promise 无人接，宿主 `throw new Error(`Duplicate agent preset: ${definition.id}`)`（index.ts:83，只重名与空 id 两种）的拒绝逃逸成 unhandled rejection → 又一次 `dsh: fatal load failure`。更糟的是 `this.definitions.set(...)`（index.ts:85）在 await 之前就已**同步登记**，会出现「宿主里有声明、`state.json` 没记账、面板说失败」三方不一致。修法：`try { dispose = await returned } catch (error) { return { ok: false, error: String((error && error.message) || error) } }`，句柄 `undo` 也改成 async；`removeCmd` 里撤声明的 `core.runtime.disable(id)` 同样要 `await`（`unregister` 也是 async），否则删除路径会重现同一个 unhandled rejection。
- **⚠️ `!!js` 值与相对路径行只在「YAML 文本通道」被宿主处理，走对象通道必须自己准备**（2026-10-02）：官方 preset 是 `standard.patch.yml` 这类 YAML，宿主自己解析、自己求值 `!!js`、按 profile baseUrl 解析行；而我们交给 `registry.register()` 的是**已解析的对象数组** ⇒ ① `disabled: !!js process.platform === 'win32'` 被本插件 parser 存成 `{__js: …}`，没有任何东西会求值它，宿主拿到真值对象（`row.disabled === true` 为假，本该在 Windows 上禁用的 bash 行反而会被挂载）；② `name: ./custom-bash.mjs` 会按**宿主** baseUrl 解析（`activate()` 里 `scope.ctx.extend({ baseUrl: record.context.baseUrl })`，index.ts:108）而不是按 preset 目录，整个 preset mount 失败（被 catch 成 `record.broken`，只 `logger.warn`）。修法：传参前统一过 `prepareRows(rows, presetDir)` —— `./`、`../` 行名 → 绝对 `file://` URL；`{__js: expr}` → `new Function('return (' + expr + ')')()` 求值（失败抛「!!js 表达式无法求值：<expr>（<原因>）」并按行拒绝），**磁盘文件一律不改写**（面板显示的就是用户写的那份）。附带好处：对象通道与宿主解析 YAML 的通道从此语义一致。

- **⚠️ 真实组合会写单行流式集合，parser 必须支持**（2026-10-02）：`~/.dsh/.agent-presets/liangshen/agent.cordis.yml` 里有 `shellTools: [bash]`（L74）、`commonTools: [str_replace_editor]`（L75）、`messageSources: [user, goal]`（L76）、`compactionTools: [read, write, edit, glob, grep, todo_write, ask_user_question]`（L81）、`deferredSources: [agent-instructions, skill-catalog]`（L82）——这是官方 minimal/standard 组合的常规写法。第一版 parser 把 `[`/`{` 开头的标量一律判为 `unsupported YAML feature (anchors/aliases/flow collections)`，于是**一个完全正常的本地 preset 会在面板上显示成「组合有问题」并被拒绝启用**（实测 `liangshen PARSE FAIL [{"line":1,…: [bash]}]`，同目录 standard 却能过）。修法：`parseScalar` 把 `[`/`{` 交给新的 `parseFlow`（只接受**单行**形式，跨行 `tools: [\n bash,\n ]` 明确报「流式集合必须写在一行内：」而不是静默吞掉文件），锚点/别名仍拒绝。附带测试纪律：`name: [1` 这类样例一旦变合法，原来靠它造「坏 YAML」的用例会假红，必须换成锚点或跨行流式集合。
- **`React.createElement` 的括号不足会静默吞掉后续 children**：`FILTERS.map((key) => React.createElement('button', {...}, t(...)))` 少一个右括号时，后面的 error/notice/表单/列表会被当成 `Array.prototype.map` 的多余位置参数**无声丢弃**（语法仍合法，`node --check` 通过）。必须用渲染结构验证（本插件客户端测试打印根节点 children 数量与类型），只跑 `node --check` 不够。
- **⚠️ 内联样式写 toggle 的两个必踩坑**（2026-10-02 真机截图反馈「开关有点丑，不好辨认」）：① 开启态轨道若用 `--dsw-alias-label-primary`（那是**文字色**，深色主题下近白）而圆点是 `#fff`，开/关两种状态都糊成一块白方块 —— 轨道该用 `--dsw-alias-brand-primary`、圆点该用 `--dsw-alias-label-primary-foreground`（与 `dsh-plugin-manager/src/client.js:190-192` 的 `switch` / `switchOn` / `thumb` 保持一致）；② 圆点写成 `<span>` 却没给 `display: 'block'` 时，inline 元素**忽略 width/height**，圆点根本不渲染，轨道里只剩一条色块。尺寸要成对给出：轨道 38×22、`padding: 2`、圆点 18 ⇒ 位移 `38 - 2*2 - 18 = 16px`。语义顺手从 `aria-pressed`（按钮＝已按下）改成 `role="switch"` + `aria-checked`，并让客户端测试断言这些渲染事实（`role`、`aria-checked`、轨道的 `background` token、圆点的 `transform` 与 `display`）—— 只断言文字会漏掉整类「控件看不见」的回归。
- **测试里模拟磁盘故障要在 deps 层注入**（`world.deps.writeTextAtomic` / `readdir` 等），不要 monkeypatch `fs.writeFileSync`/`fs.statSync`——`mkdtempSync` 也走它们，会误伤 fixture。
- **`deps.readText` 对缺失文件必须返回 `null`（不能抛）**：扫描把「目录里没有这个文件」当正常事实；抛异常会把「没元数据」误判成「元数据坏」。
- **YAML 坏样例要挑真会坏的**：`name: broken: [` 与未闭合单引号都**合法**（按裸标量/标量接受），parser 支持**单行**流式集合之后（见「真实组合会写单行流式集合」条），真正会坏的只剩**锚点/别名**（`name: *anchor`、`name: &x b`）与**跨行**流式集合（`name: [\n    bash,\n  ]`）；拿前两种写「元数据损坏」用例会假绿。
- **恢复被替换的 deps 方法要用保存的引用**：`delete world.deps.readdir` 只会让属性变成 `undefined`（后续扫描恒空、报「找不到预设目录」），必须 `const real = world.deps.readdir; … ; world.deps.readdir = real`。
- **HTTP 层白盒测试**：宿主半用 `ctx.webServer.register` 挂端点，测试时直接用 `createHandlers(core)` 造 handler 表，请求用 `node:events` 的 EventEmitter 造假 `req`（`queueMicrotask` 里 emit `data`+`end`），`req.url` 要自己给（`GET /file?id=…` 的 query 由 handler 从 `req.url` 解析后合并进 body）。

## 验证

```bash
node --test sub-plugins/dsh-agent-preset-manager/test/bundle.test.mjs   # 43 pass
node --test sub-plugins/dsh-agent-preset-manager/test/client.test.mjs   # 5 pass
node --test <dsh-plugin-manager/test/*.test.mjs>                        # 7 pass（含 root-install-shell：根 package.json 与 dsh-plugin-manager/package.json 的 version 必须一致）
```

文档与自检：`sub-plugins/dsh-agent-preset-manager/README.md`、`ACCEPTANCE.md`。
