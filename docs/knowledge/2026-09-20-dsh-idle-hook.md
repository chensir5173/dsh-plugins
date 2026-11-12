# DSH 插件：dsh-idle-hook（模型不在运行时跑脚本）

> **2026-11-12 更新**：本插件已改名为 `dsh-notify-hub` 并新增内置 SMTP 邮件通道，路径与端点全部变更；改名迁移与邮件通道的结论见 [2026-11-12-dsh-notify-hub.md](2026-11-12-dsh-notify-hub.md)。本文保留为改名前的历史记录。

日期：2026-09-20
插件目录：`sub-plugins/dsh-idle-hook/`；OpenSpec：`openspec/changes/add-dsh-idle-hook/`

**一句话**：宿主半监听「一轮结束 / 等待批准 / 等待回答」三种非运行状态，按用户配置执行本机脚本（py/bat/ps1/sh/可执行），把通知送到页面关掉也能到的地方。

## 可复用结论

### 1. 「一轮结束」用 `turn/end`，不要用 `agent/status === 'idle'`
- `AgentStatus` 只有 `'idle' | 'running'`，内部 maintenance 阶段也映射为 `idle`，且 `turn/end` 之后 driver 可能**立刻**开始下一轮——只看 idle 边沿会误报。
- 正确信号：`ctx.on('session/event', (session, event) => event.type === 'turn/end')`，每回合恰好一次、带 `reason`（`completed`/`aborted{reason.kind}`/`blocked`/`error`/`max-tokens`；`interrupted` 只由修复流程合成，运行期不出现）。
- `turn/end` 早于 idle 边沿，所以要**延时复查**（本插件用 250/1000/2500ms 三次重试）确认 `agent.status === 'idle'` 且 `inbox.nextTurn`/`inbox.nextStep` 为空，再去执行；driver 直接续跑下一轮时三次都查不到空闲 → 正确地不通知。

### 2. 「等待人类」不是状态，只能观察两个瀑布（且有铁律）
- 宿主侧**没有**「这个 agent 在等人吗」的谓词：`ApprovalService` 无 pending 访问器，`UserQuestionService` 只有 `ask()`，gateway 的 `pendingRemoteEvents` 是私有的。
- 观察点只有 `ctx.on('approval/request', (req, next) => …)` 与 `ctx.on('user-questions/request', …)`（waterfall）。
- 铁律三条：**`{ prepend: true }`**（宿主的 remotes forwarder 先注册就排在链首，客户端一旦应答链就结束，注册晚了永远轮不到你）+ **立即 `return next()` 并原样返回它的结果**（吞掉 next 或返回 undefined，批准会被规范化成 fail-closed 的 `'unavailable'`，提问会拿到 undefined）+ **绝不 await 自己的脚本**（否则会延迟人类链路）。
- 零页面连接时这两个请求会**永久挂起**（gateway 只投递给已连接客户端）——这正是最该通知的场景，插件必须容忍而不是依赖客户端应答。
- 只读审计事件 `approval/asked`/`approval/decided` 不适合做精确判据（策略自动放行时两者几乎同时落下）；用户提问根本没有持久事件。

### 3. 子代理会话必须静默
子代理的 `turn/end` 发生时父回合仍在运行，通知用户是误导。判据：`ctx.agents.roots()` 里没有该 sessionId 就跳过（`agents.get` 取不到 agent 时放行，避免误杀重放/已销毁会话）。

### 4. 宿主半零 `@deepseek-ai` import 时的设置命名空间做法
- 动态 `import('@deepseek-ai/schemastery')` 包在 try/catch 里，失败就用**零依赖 fallback schema**（可调用 + `.toJSON()`）注册命名空间——link: 插件解析不到宿主包，生产实际走的多半是 fallback。
- **设置服务支持对象数组**（先例：`z.array(z.object({ provider, model }))`）。但 `mergeLayers` 对非 plain object 是**整体替换** → 客户端每次必须写整份规则数组，别指望逐元素合并。
- 客户端读写设置的既有形态（esc-rewind）：`remote.settings` 必须**按候选逐个 try** 解析（guarded ctx 上读未注入的裸属性会 throw），`describe()` 返回 `{ namespaces: [{ ns, value, revision }] }`，`update(ns, patch, expectedRevision)`，两者都在 `{ ok, value }` 信封里。

### 5. 「页面在不在」只能自己测心跳
宿主没有公开的 presence API（断线只是从 gateway 的投递表移除）。做法：客户端半每 5s（以及 visibilitychange/focus/blur）POST `{visible, focused}` 到插件自有 `/__<plugin>/presence`，宿主记 `lastSeen`，**30s 无心跳即判「页面关着」**；从未连接（终端 profile）同样按关着。规则据此提供三档前提（任意 / 仅页面关着 / 仅不可见或失焦），从而与浏览器原生通知插件天然互斥。

### 6. 客户端 bundle harness 的两个坑（写测试时必踩）
- React shim 里 `createElement(type, props, ...children)` 的 children 常是**嵌套数组**（`cfg.rules.map(...)` 作为一个参数传入），walker 与 `textOf` 必须**先判 `Array.isArray`** 再判 `__element`，否则规则行「渲染不出来」的假失败。
- shim 的 effects 在**渲染时**执行，异步 setState 需要「render → `await settle()` → 再 render」多轮才能看到结果；只 settle 不重渲染会读到旧树。
- 测试要**各自重置 settings 桩**（写入会改桩状态），否则后一个用例断言的是前一个用例改过的规则。

### 7. 测试抓到的一个真 bug（同类设计注意）
把「草稿的 textarea 文本」当作唯一参数来源，会让**已保存规则的参数在试跑时被清空**。区分开：`typeof rule.argsText === 'string'` 才从文本解析，否则用 `rule.args`。

### 8. 本仓库布局约束（2026-09-10 起，踩过才知道）
- 子插件一律放 `sub-plugins/dsh-*`，**不声明 `dsh.bundle`、不带自带 `cordis.patch.yml`**（唯一例外是管理器在仓库根的安装外壳）；激活行只由管理器的面板写，`dsh plugin add <子插件目录>` 只会装成普通依赖、永不激活。
- `settings.section` 的 order 必须避开：核心 general 0 / models 10 / plugins 15 / agent-presets 20，仓库内 manager 16、hindsight-model 17 —— 本插件用 **19**（第三方如 dsh-notification 用 60）。
- 我这次踩的坑：插件最初建在**仓库根**并自带 `cordis.patch.yml` + 声明 `dsh.bundle`（旧模型），仓库更新后与新规冲突 —— 管理器的扫描仍兼容旧的扁平根布局，所以不会报错，但 `dsh-plugin-manager/test/root-install-shell.test.mjs` 会因 `dsh.bundle` 判红。**新插件一律直接建在 `sub-plugins/` 下**。
- 仓库更新（git pull / reset）会**丢掉未提交的文档改动**：这次 README 速览行与知识库索引行就被回滚了，改完记得提交。

### 9. 两个只在真机才暴露的 bug（都值得记住）
- **设置命名空间报 `settings namespace "<ns>" is not registered`**：宿主半只写 `ctx.get('settings')` 是不够的 —— **激活行的加载顺序会变**（用户在「本地插件」面板开关过、面板重写 patch 行），设置服务可能在本插件 `apply()` 之后才挂载，于是 `get` 拿到空、命名空间永远没注册，客户端读写全报错。修法就是仓库既有约定：`get` 拿不到时再 `ctx.inject(['settings'], cb)`（迟到挂载回调），外加一个 `ensureSettings()` 给后来的调用者（status/触发分发）重试一次；`installSection` 用 `settingsReady` 守卫避免重复注册。**回归测试**：harness 里造一个 `get: () => null` + 捕获 `inject` 的 ctx，断言「apply 必须请求迟到挂载」且回调触发后只注册一次。
- **客户端回调闭包引用未初始化绑定**：把 `const savedEnvText = ...` 放在组件的**提前 return 之后**，首帧（loading）创建的回调会捕获那个从未初始化的绑定，试跑时直接抛错。教训：凡是 `useCallback` 里要用的派生值，必须在**所有提前 return 之前**算好。
- 顺手做的一条 UX：把 `is not registered` / `settings-unavailable` 这类底层报错在界面上追加一句「到「设置 → 本地插件」把插件关掉再打开（或重启 GUI host），然后刷新本页」——否则用户只能看到一个没法自查的英文错误。
- 测试卫生：harness 跑宿主半前把 `process.env.DSH_HOME` 指向临时目录，`loadState/persistState` 就不会碰到开发者**真实的** `$DSH_HOME/idle-hook-history.json`。

### 10. SessionEvent 的载荷在 event.data 里 —— 以及「测试跟着实现一起错」的教训
- **事实**：会话日志里的事件是 `{ type, seq, time, data }` 信封，`turn/end` 的 `{turn, reason}` 在 **`event.data`** 里（核心自己也这么读：`session-controller` 里 `event.data.header.config.provider`）。把它当 `event.reason` 读会**静默得到 undefined** → `shouldFireOnTurnEnd` 返回 false → 整条触发链一声不响。
- **症状**：宿主半一切正常（订阅收到事件、设置读到规则、试跑成功），但真实会话**永不触发**；`dispatched` 计数永远是 0，历史里只有 `test: true` 的条目。试跑之所以成功，是因为它**完全不走会话事件**（规则随 HTTP 请求发过来、点了就跑）。
- **定位手段**（值得保留的做法）：给宿主半加**廉价计数**（`sessionEvents / turnEndEligible / turnEndConfirmed / dispatched + lastDispatch{rules}`）并在 `/status` 暴露快照。一次读表就能把「没收到事件 / 不够格 / 没确认空闲 / 分发了但 0 条规则」分开，不用猜。
- **最大的教训**：我最初的 harness 用 `{ type: 'turn/end', reason: {...} }` 这种**自己臆造的形状**喂监听器，于是测试和实现一起错、还全绿。修法是：**测试必须用线上真实形状**（从会话日志里抄一行下来），并且断言**计数**而不是只断言「不抛错」。改完做了反向验证：把修复退回去，测试立刻红（`0 !== 1`）。

### 11. Windows 上这两条用例是红的 —— `~` 展开按宿主平台拼、真子进程硬写 `/usr/bin/touch`（2026-09-21 补）
- **症状**：插件入库后在本机（Windows）跑，两条用例红：`buildCommand: ~ expansion and placeholders` 期望 `/Users/me/bin/notify.sh` 却实得 `\Users\me\bin\notify.sh`；端到端那条 `command: '/usr/bin/touch'` 在这台机器上根本不存在 ⇒ 标记文件没产生、`the enabled rule really ran` 断言失败。AGENTS.md 的离线全量 sweep（`for f in sub-plugins/*/test/*.test.mjs`）因此整体为红。
- **`~` 那条是实现的 bug，不是用例写错**：`expandTilde` 用**宿主**的 `path.join` 拼接，而 `buildCommand` 一路都在用注入的 `platform`（`interpreterFor` / `quoteIfNeeded` / `sampleRule` 全按目标平台分支）⇒ 在 Windows 上跑 `platform: 'darwin'` 会把 `/Users/me` 拼成 `\Users\me`。修法：`expandTilde(value, home, platform = process.platform)` 内按目标平台选 `path.win32` / `path.posix`，`buildCommand` 把 `platform` 传下去；宿主侧展开 `rule.cwd` 的那处不传 platform（仍按本机平台，行为不变）。
- **`/usr/bin/touch` 那条是用例的平台假设**：改用仓库既有的 `test/fixtures/probe.mjs`（`.mjs` 由自动解释器认成 node，跨平台；它本来就把 stdin JSON 写进 `argv[2]` 指定的文件），两条规则都指向它——「启用的规则真的跑了 / 停用的规则没跑」两个断言的含意不变。
- **可复用结论**：本仓库的测试是在 **Windows** 上跑全量 sweep 的，任何「真子进程 / 真路径」用例必须用 `process.execPath` + fixture 或 `path.join` 构造，**不能硬写 POSIX 绝对路径**；反过来，凡是**接受注入 `platform` 的函数**，拼接路径也必须用目标平台的规则，否则那个 `platform` 在测试里只是装饰。

### 12. Windows 上「试跑失败：ParserError / UnexpectedToken」= 示例 `.ps1` 是无 BOM 的 UTF-8（2026-09-22 补）
- **症状**（用户报）：设置 → 本地插件 → 空闲通知 里对示例规则点「试跑」→ `失败 (退出码 1)`，stderr 尾巴只有 `CategoryInfo : ParserError: (:) [], ParentContainsErrorRecordException` + `FullyQualifiedErrorId : UnexpectedToken`；报错**指向的行看起来完全无害**（`}`、`} catch { … }`），标题字段还带 `DSH????` 这类mojibake。
- **取证**：`~/.dsh/idle-hook-history.json` 的 `entries[].stderr` 就是宿主记下的原文（按 GBK 解码才读得懂）；脚本本体 `examples/notify-windows.ps1` 前三字节是 `<#` 而不是 `EF BB BF`。
- **根因**：规则的解释器解析是 `interpreterFor('.ps1') → powershell -NoProfile -ExecutionPolicy Bypass -File`，即**系统自带的 Windows PowerShell 5.1**（本机实测 `5.1.26100.8655`）。**5.1 对无 BOM 的 `.ps1` 按 ANSI 代码页解码**（PS 6+ 才默认 UTF-8）⇒ 简中机器按 GBK 解 UTF-8 字节 ⇒ 中文注释变乱码、**引号配对被打断**（后续报错因此落在 ASCII 行上）。同内容加 BOM 后在本机 dry-run 直接通过（`DRY-RUN 标题=DSH 停下来了 · 本轮结束`，exit 0），与修复前同一份文件的 ParserError 形成对照。
- **修法**：把 `.ps1` 存成 **UTF-8 with BOM**（内容一字不改，只加 3 字节）；护栏 = `test/host-core.test.mjs` 里断言 `examples/*.ps1` 前三字节为 `EF BB BF`（先跑成红、加 BOM 后绿）。**不要**改用 `pwsh`/加 `chcp` 绕过：脚本文件解码发生在解析之前，只有 BOM 或纯 ASCII 能救。
- **可复用结论**：① 凡是**给 Windows 用户跑**的 `.ps1`（示例脚本、生成的脚本、文档里的片段另存），一律 **UTF-8 with BOM**，并在测试里加编码护栏——这类回归只能在真机暴露；② 排查 PowerShell 报错先看**报错行之外的字符集**：乱码标题 + 无害行报错 = 编码，不是语法；③ 插件把 stderr 原样留在 `idle-hook-history.json`，**这就是最快的真机取证入口**（不用复现）。

## 验证方式
```sh
node sub-plugins/dsh-idle-hook/test/host-core.test.mjs   # 50 项：矩阵/解释器/上下文/presence/失败计数 + 真子进程执行、超时杀、非零退出（2026-09-21 实测计数）
node sub-plugins/dsh-idle-hook/test/bundle.test.mjs      # 22 项：注册/渲染/写入/试跑/心跳 + 宿主半零 core import、瀑布 prepend+return next（2026-09-21 实测计数）
```
