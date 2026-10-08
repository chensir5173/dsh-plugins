# DSH 插件：composer 提供方标签升级为两级选择器（dsh-composer-provider-label）

日期：2026-09-09 · 涉及：`dsh-composer-provider-label/{src/client.js,test/bundle.test.mjs,README.md,ACCEPTANCE.md}`、`openspec/changes/archive/2026-09-09-extend-composer-provider-picker/`

## 一句话

只读标签升级为「提供方 / 模型」两级菜单：写入只能走 `remote.session.selectModel`（provider+model 必须成对），菜单用核心 `Menu` 原语 + 自管 pane 原地向上弹，显示范围偏好只存 localStorage。

## 可复用结论

### 1. 模型路由的写路径

- 唯一写接口：`ctx.remote.session.selectModel({sessionId, provider, model, reasoningEffort?})`（`packages/api/session-controller/lib/typert.remote-client.d.ts:29/51`，0.1.2-rc.1 起）。
- `ModelSelection` 永远是 `{provider, model, reasoningEffort?}` 完整三元组（`api/session-controller/src/types.ts:82-87`）——**没有"只选提供方"的状态**，点提供方必须顺带决定模型。
- 宿主在该调用里**顺带保存 profile 默认模型**（`src/commands.ts:138-144`）；选择只作用于"下一次请求"。要"只改本会话"是不可能的，UI 不必假装可以。
- 不可用场景：受地址的子代理会话会被宿主以 `session/agent-busy` 拒绝；客户端可用 `ctx.get('sessions').subagentAddress(sessionId) !== undefined` 提前禁用（服务不可达时乐观放行，让宿主兜底）。

### 2. `Menu` 原语的 submenu 是残的，pane 才对

- `openSubmenuId` 是内部状态，外部无法控制（`ui-primitives/src/Menu.tsx:100,206-219`）→ "选完一级自动进下一级"用 submenu 做不到。
- 子卡片行不支持 `selectedId`（`:232-244`）；只要有 submenu 行就关掉滚动上限（`:190`）；子卡片无视口夹取（`Menu.module.css:227-234`）。
- 正解：**一张卡片内自己管 pane**（`root|provider|model`），每次换 `items`；无 submenu 行时自带 `max-height: calc(100vh - 24px)` + 内部滚动（`Menu.module.css:67-79`），`selectedIds` 免费给勾选，`footer` 常驻不滚动。
- 定位：**原地渲染 + `side='top'`**（`.root` 是 `position:relative`，卡片 `bottom: calc(100% + 4px)`，高度变化自动跟随）。portal 模式只在打开/滚动/resize 重算位置（`Menu.tsx:109-155`），pane 切换改高度会错位。核心 `ModelSelect` 在同一位置也是原地渲染（`ui-model-selection/src/client/ModelSelect.tsx:240-352`），说明 composer 内可行。
- 菜单里的行都是 `<button>`：**行内不能再嵌按钮**（重试按钮必须做成单独一行）。
- **长列表会顶出自己的首行**：原地渲染没有视口夹取，原语的 `max-height` 挡不住（卡片向上长 → 顶部越界）。原语没有高度 prop → 唯一可行解是给 `Menu` 传作用域类名再注入一条样式。⚠️ **2026-10-03 更正**：能到达卡片的 hook 是 `listClassName`（`className` 落在 anchor 包裹 `<span>` 上），且 `MenuSurface` 把装饰性 `.material` 层渲染成卡片的**第一个子 div**，所以旧写法 `.cpl-picker [role="menu"] > div:first-child` 打在背景层上、上限**从未生效**。正确写法、几何数字与排查手法见 [2026-10-03-menu-card-height-cap.md](2026-10-03-menu-card-height-cap.md)。代价不变：这是插件唯一的 DOM 写入（一个 `<style>` 元素，无 `document.head` 时静默跳过）。

### 3. 槽位

- `conversation.input.right`：list / session / `replaceRisk:'none'`，紧邻模型座位左侧，additive。
- `conversation.input.model`：single，核心 `ModelSelect` 占用；**动态加载的浏览器插件会被自动赋予负优先级**（`ui-slots/src/index.ts:832-834`，`guard.ts:119-126`）→ 注册进去会**遮蔽**核心座位而不是报错。想共存就别碰。

### 4. link: 形态下 settings 段是死的

- `import('@deepseek-ai/schemastery')` 从插件目录解析失败（`ERR_MODULE_NOT_FOUND`，仓库祖先链无 `node_modules`）→ `settings.installSection` 永不执行 → `providerAliases` 之类的 settings 配置**不生效**。
- 可行修法（本次未采用）：`createRequire($DSH_HOME/profiles/package.json)('@deepseek-ai/schemastery')` 实测可加载并能造出可用 schema；代价是新增对 profile 路径的依赖。
- 因此"用户可配置的默认值"这类需求，在 link: 形态下应直接存 **localStorage**（键 `dsh.composer-provider-label.v1`），别加半死的 settings 键。

### 5. 目录失败不要隐式重试

每次渲染都重试（`status==='error' → 再拉一次`）会形成请求风暴，并让错误态入口在 loading/error 之间闪烁。改成：**只有 `idle` 才隐式加载**，失败后由显式「重试加载」入口驱动（这也让测试可确定地断言重试）。

### 6. 测试 harness 的两个坑

- `React.createElement(Menu, …)` 把**组件函数**存进 `type`；测试桩的标记必须挂在组件函数上（`Menu.__menuStub = true`），挂在返回值上无效。
- 写入链是 `Promise.resolve().then(()=>selectModel()).then(…)`，**3 个 tick 不够**；harness 的 `flush()` 给到 8 个 tick 才稳定。
- 能力审计要**先剥掉注释**再数调用点，否则模块头注释里的 `session.selectModel(…)` 会被算成第二个调用点。

## 验证命令

```bash
node dsh-composer-provider-label/test/bundle.test.mjs                     # 51/51
node --check dsh-composer-provider-label/src/client.js
openspec validate extend-composer-provider-picker --strict                # valid
```
