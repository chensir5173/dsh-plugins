# DSH 插件：会话「重新生成标题」（dsh-session-title-regenerate）— 2026-09-06

## 目标（What & Why）
给 DSH 会话加「重新生成标题」动作：用**当前模型、最低推理档**总结该会话**全部用户提问**，生成 ≤60 字单行标题并覆盖旧标题。入口：会话头部操作按钮 + 侧边栏会话行 `⋯` 菜单项。GUI 无法自动化，交付物 = 插件源码 + 25 条可跑逻辑测试 + README/ACCEPTANCE 验收清单。

## 改动摘要（What changed）
- 新插件目录 `dsh-session-title-regenerate/`：`package.json`（cordis client 声明）、`cordis.patch.yml`、`src/index.js`(host)、`src/client.js`(client)、`test/bundle.test.mjs`、`README.md`、`ACCEPTANCE.md`，以及测试专用本地 `dsh-llm` 桩（`node_modules/@deepseek-ai/dsh-llm`，不发布、运行时不用）。
- host：`ctx.commands.register('regenerate-title')`：收集全部 `user/message` 文本（UTF-8 字节截断）→ `ctx.llm.stream({reasoningEffort:'off', purpose:'session-title', maxTokens:100, …})`（带 30s 超时护栏）→ 清洗成单行并截 60 码点 → `sessionTitle.rename()` 覆盖固定。
- client：头部按钮（`conversation.session.header.actions`，order 27）、会话行 `⋯` 菜单项（DOM 注入进内容区 viewport）、`shell.overlay` 上的共享 Toast；统一经 `remote.commands.execute` 触发。

## 关键设计决策（Decisions）
- **用命令通道而非自定义 Remote**：外部插件无法新增 typert Remote（发布时才生成客户端代理+schema，运行时无 codegen）。`commands.execute` 是核心 Remote，其 `agent` 查找会自动恢复未打开会话 → 冷会话也能生成。
- **"最低推理模式"落地** = `reasoningEffort:'off'` + `purpose:'session-title'`（DeepSeek 适配器对 session-title 强制 `thinking:disabled`）+ `maxTokens:100`；提供方返回 `UNSUPPORTED_REASONING_EFFORT` 时去掉该字段重试一次。
- **写入用 `sessionTitle.rename`**（公共 API，客户端列表经 title 投影即时刷新）；语义=来源 `user`、标题被固定（之后新消息不再自动更新），符合"始终覆盖"。
- **菜单项追加进内容区 viewport**（`[role=menu] > role=presentation`），而非 append 到 `[role=menu]`——这样项紧跟官方三项、位于 session-delete 等插件项之前、且不带自身分隔线。
- 测试桩刻意还原两处真实运行时行为：remote 根控制器是"需注入的抛错访问器"；Menu 原生项在嵌套 viewport 里。

## 接口与用法（Interfaces）
- 命令：`/regenerate-title`（`recordInput:false`；也出现在 composer 的 `/` 命令菜单）。
- 配置（profile 的 `cordis.patch.yml` 行 `config:`）：`provider`/`model`（缺省跟随会话当前模型）、`targetWords`(40)、`targetCjkCharacters`(60)、`maxInputBytes`(12KB)、`maxOutputTokens`(100)、`timeoutMs`(30s)。
- 安装：`dsh plugin --profile web add ./dsh-session-title-regenerate`，或按 web profile 惯例 `link:` 依赖 + `dsh.profile.bundles`。
- 客户端 i18n：NS=`session-title-regenerate`，zh/en 字典 + locale 服务。

## 踩坑与解法（Gotchas）
- **`cannot get property "remote.commands" without inject`**：外部插件拿到的 `remote` 根上，每个控制器是"需先注入才能读"的访问器。解法：`ctx.inject(['remote.commands'])` 或在注入作用域里 `ctx.get('remote.commands')` 取控制器，绝不直接读裸根 `.commands`（open-session-workdir 读 `remote.session` 是同一个坑）。
- **菜单项排在删除会话后面 / 被分隔线隔开**：核心 Menu 真实 DOM 是嵌套的（原生项在 `[role=menu] > role=presentation(viewport)` 里，session-delete 的项是 append 到 `[role=menu]` 的直接子节点）。曾误以为原生项是 `[role=menu]` 直接子节点而排序失败 → 改为注入 viewport。
- **`session.events` vs `snapshotEvents()`**：0.1.1-rc.2 是 `events` getter，0.1.2-rc.1 起是 `snapshotEvents()` 方法；用 `sessionEventsOf()` 兼容。`requestHeader()` 与 `sessionTitle.rename` 两个版本都存在。
- **测试假 DOM 必须贴近真实**：tagName 大写、递归 querySelector、`class*=` 选择器、viewport 嵌套结构，缺一都会让测试失真（曾因假 DOM 过简放过一个真 bug）。

## 未完成 / 后续（Follow-ups）
- 装进 web profile 后按 `ACCEPTANCE.md` 人工逐条验收（GUI 侧无法自动化）。
- 若上游为会话 `⋯` 菜单新增插件槽位，可把 DOM 注入平滑换成槽位实现。
- `commands.execute` 会在会话流留 `command/run`+`command/done` 一对节点（已 `recordInput:false` 不记参数）；若嫌噪可评估自建 HTTP 端点方案（需自行实现冷会话恢复，风险更高，暂不做）。

## 复现 / 验证（Verify）
```bash
node dsh-session-title-regenerate/test/bundle.test.mjs        # 25/25 逻辑测试
node --check dsh-session-title-regenerate/src/index.js
node --check dsh-session-title-regenerate/src/client.js
```
GUI：硬刷新（Ctrl+Shift+R）→ 打开会话行 `⋯` 菜单：应为 `重命名 / 分叉会话 / 归档会话 / 重新生成标题`（无分隔线），`删除会话` 在其下；点击后不切换会话、Toast 显示新标题、列表标题即时更新。

## 2026-09-21：注入项必须与官方行同构（修「整张菜单被复制」）
- **现象**：开着 `dsh-flowglass` 时打开侧栏会话行 `⋯` 菜单，`分叉 / 归档 / 重新生成标题` 各出现两次（官方项也被复制）。
- **根因（责任在本插件的 DOM 形态）**：`dsh-flowglass` 0.7.0 的「加入当前并发分支」增强按**结构**解析这张菜单——取 `items[items.length - 1]`（最后一个 `[role=menuitem]`）的 `parentElement` 当作"这一行"，`cloneNode(true)` 后只改克隆体里**第一个** `menuitem` 的文案，再 `viewport.appendChild(clone)`。核心每个原生行是 `div.itemWrap > button[role=menuitem] > span.itemIcon + span.itemLabel`，其 `parentElement` 就是"这一行自己"；而本插件当初把**裸 button** 直接 append 进 viewport ⇒ 最后一项的 `parentElement` 是**整个 viewport** ⇒ 克隆复制整张菜单，只把其中第一行（重命名）换成 flowglass 的「＋加入当前并发分支」，其余三行原样重复。它的 enhance 走 `Promise.resolve().then(enhance)`，比我们的同步注入晚一个微任务 ⇒ 必然看到裸 button，稳定复现、不是竞态。
- **修法（本插件侧）**：注入项改成与官方行同构的一整行——自带包裹层 `div`，按钮内**图标槽 + 文案槽各一个 `span`**（几何仍用内联样式，不依赖核心 hash 类名）；文案刷新改按 `[data-session-title-regen-label]` 定位（否则 `querySelector('span')` 命中的会是图标槽）。修后最后一项的 `parentElement` 又是"这一行自己"，克隆只影响一行，且 flowglass 那行仍能取到 `spans[0]`（＋号）与 `spans[1]`（文案）。
- **验证**：`test/bundle.test.mjs` 新增 1 条把 flowglass 的选择规则原样跑一遍的回归用例（同时给假 DOM 补 `parentElement`、删掉已无用的 `querySelector('span')` 便利钩子），25/25 绿；另用 jsdom 跑**真实 `src/client.js`**：修前菜单 8 行含 `分叉会话/归档会话/重新生成标题` 3 行重复、修后 0 行重复。
- **可复用结论**：往核心写死的 DOM 里注入内容，必须与官方节点**同构**，而不是"能挂上就行"——第三方插件（不止 flowglass；`session-delete` 等直接 append 到 `[role=menu]`）会按 `role`、父子层级、`spans[i]` 这类结构假设解析，裸节点/错层会以"别人的菜单被复制"这种远端形态爆出来。诊断套路：先 `grep` 活跃插件里对 `[role=menu]`/`menuitem`/`parentElement` 的用法，再用 jsdom 把可疑插件那段逻辑**原文**跑一遍做 A/B。
- 遗留（可接受、不加特判）：第三方克隆体也会带上我们的标记属性，理论上"菜单开着的同时切语言"会让克隆体文案被改回我们的——该组合实际不可达（切语言要开设置面板，届时菜单已关）。

## 2026-10-08：设置页 tab（思考开关 / 推理强度 / 输出上限 512）
- **现象**：用户报 `>- regenerate-title · 重新生成标题失败: title output reached maxTokens`（同屏两行 = 两次手动触发各失败一次）。
- **根因链（标题为何被长度截断）**：① 插件原预算写死 `maxOutputTokens: 100`，而 `finishReason === 'length'`（pi-ai 把上游 `finish_reason: length` 映射成 `{ kind: 'max-tokens' }`，`resources\app.asar\dsh\node_modules\@deepseek-ai\dsh-llm-pi-ai\lib\index.js:1422`）时插件直接抛错、丢弃已收到的文本；② desktop 路由到 codemaker（openai-responses）⇒ 走 `dsh-llm-pi-ai`，而 pi-ai **不识别 `purpose`**（全文件 0 命中），所以 `dsh-llm-deepseek\lib\index.js:1694` 那条 `purpose === 'session-title' ? 'off'` 的「强制关思考」优惠**不生效**；③ pi-ai `:1675` `const enabledReasoning = reasoning === 'off' ? void 0 : reasoning` 把 `off` 翻成「**省略 reasoning 字段**」（`:1710-1721` 注释明说）⇒ 上游若默认开思考，思考 token 与标题**共享**这 100 token ⇒ 截断。DSH llm 层也没有独立的 thinking 字段（`dsh-llm\lib\index.js:2169-2194` `resolveCallWithInfo`）——「思考开关」在插件层只能映射成「发不发 `reasoningEffort`」。
- **0.2.0 设置持久化契约**：settings 服务读 **entry 导出的 `Config`**，把表单投影在 **entry id** 下（写别的 ns 抛 `No configurable plugin entry "<ns>"`，`@deepseek-ai\dsh-settings\lib\index.js:504`）；`describe()` 每行 = `{ autoGenerate, ns, schema: form.toJSON(), revision, applies: 'live', value, base, user }`（`:413-451`，`value` 已 resolve 默认值）；重建 schema 的实现是 `new z(schema.toJSON())`（`…\dsh-settings\lib\types\schema.js`）；本 profile 行是 `- id: session-title-regenerate` ⇒ ns = entry id = `session-title-regenerate`。设置 tab 槽 = `settings.localPlugins.tab`（核心 `ui-settings-plugins` 声明的列表槽，插件不能自造设置导航行）。
- **必须手写 schema**：`link:` 安装形态下 host 半解析不到 `@deepseek-ai/schemastery`（与 `dsh-composer-provider-label` 的已知限制同源）⇒ `Config` 是手写对象：`meta.volatile = true`、`toJSON()` 返回精确的 `{ uid, refs }` 树、`'~standard' = { version: 1, vendor: 'dsh-session-title-regenerate', validate }`。三个消费者决定字段取舍：① cordis `resolveConfig` 走 `~standard.validate`；② settings 服务走 `meta.volatile` + `toJSON()`；③ loader diff —— **`~standard.vendor` 故意不写成 `schemastery`** ⇒ 配置写入退化为 ordinary entry restart，`apply(ctx, config)` 能读到新值。
- **坑（重要）**：schemastery `toJSON()` 顶层只有 `{ uid, refs }` —— **根节点的 `type` / `meta` / `dict` 在 `refs[String(uid)]` 里**，不在顶层 `json.meta` / `json.dict`。按顶层读会得到 `TypeError: Cannot read properties of undefined (reading 'volatile')`。
- **离线算精确 JSON 的可行路径**：把 asar 里的 schemastery + cosmokit 复制到 `tmp/schema-probe/node_modules/@deepseek-ai/`（`fs.cpSync` 对 asar 内部会 ENOENT，必须 `readdirSync` + `readFileSync` 递归），跑 `z.object({...}).volatile().toJSON()` 打印结果再抄进源码。临时目录已删。
- **落点**：host（`src/index.js`）`DEFAULTS.maxOutputTokens` 100 → **512**、新增 `thinking:false` / `reasoningEffort:'off'`；新增 `clampInt` / `normalizeReasoningEffort` / `resolveReasoningEffort`（思考关 ⇒ 一律 `'off'`，否则用所选档位）/ `normalizeEntryConfig`（`targetWords` 1-400、`targetCjkCharacters` 1-400、`maxInputBytes` 256 B-4 MiB、`maxOutputTokens` **16-8192**、`timeoutMs` 1e3-6e5）；命令调用从硬编码 `'off'` 改为 `reasoningEffort: resolveReasoningEffort(config)`；末尾 `export const Config = entryConfigSchema()`。client（`src/client.js`）新增 `SettingsSection`（思考 checkbox / 档位 select（思考关时 disabled；末条 UI 复核后改为四档自绘单选）/ 上限 number / 保存 / 恢复默认 / 重新读取）注册到 `settings.localPlugins.tab`（id `session-title-regenerate`，order **45**），读写走 `remote.settings.describe()` 与 `settings.update(NS, patch, undefined)` —— 控制器**必须**用 `ctx.get('settings')` 取（裸属性访问器会抛）。`provider` / `model` 故意不进 schema（仍可由 Loader 行 config 提供）。
- **验证**：`test/bundle.test.mjs` **31/31**（宿主 19 + 客户端 12）；红绿 = 把 4 处回退（512→100、去掉 `resolveReasoningEffort` 里的思考判断、`settingsFromRow` 不夹取、tab 注册包进 `if (false)`）后 **25/31**，红的正是新增用例 + 既有 `host: success`（其 maxTokens 断言 512）。harness 的 React stub 无 `useMemo`、`useEffect` 不执行 ⇒ 组件只断言渲染结构（`hooks.SettingsSection()` 返回 `{ __element: true }`）。
- **可复用结论**：① 想保证「思考不吃掉标题预算」，不能只发 `reasoningEffort:'off'` —— pi-ai 会把它变成「省略字段」，必须配一个够大的默认预算（512）+ 让用户能开关思考；② 给子插件加设置 tab 的最省事路径是**手写 `Config`**（ns 取 entry id），因为 `link:` 形态拿不到 schemastery；③ `toJSON()` 的根节点在 `refs[uid]`，别按顶层读。
- **设置面板 UI 复核（同日，插件 v0.1.4）**：原面板有三个不合理点 ——① 「思考开关 + 档位 off」双控件语义重复（勾上开关却仍发 off，等于没开）；② 原生 `select` 的展开项在深色主题下由 UA 渲染、发灰像禁用；③ 数字框 `onChange` 里逐字符 `clampInt`（打不出中间态、清空被弹回），且既没有「未保存」提示、也没有「本次实际会发什么」的回显。改法：`off` 不再作为档位，档位只剩 `low/medium/high/max` 四档**自绘单选**（打开开关时把 `off` 抬成 `low`）；数值只在失焦／保存时夹取；用 `baseline` + `sameSettings()` 算 dirty 并回显 `effectiveSummary()`。验证：`test/bundle.test.mjs` 31/31（新增 `ACTIVE_EFFORT_OPTIONS` / `activeEffortOf` / `sameSettings` / `effectiveSummary` 与「思考关时渲染树里既无 `select` 也无 `radio`」断言），红绿 30/31。追加可复用结论 ④⑤⑥：④ 深色主题的设置面板不要用原生 `select`（`option` 无法可靠设色）；⑤ 一个语义只能有一个控件（「不思考」用开关表达，就不要再给 `off` 档）；⑥ 数值输入只在失焦时夹取，`onChange` 里夹取会打断输入。

