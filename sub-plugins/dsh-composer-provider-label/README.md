# dsh-composer-provider-label

在 DSH Web GUI 的 composer（输入框）里，模型选择器左边加一枚 **provider 标签**：把「下一次请求实际会打到哪个提供方」直接说清楚，让同一模型名下的多条路由可以区分；点开它就是一个**提供方 / 模型 / 推理档三级选择菜单**。

例如同一台机器上 `deepseek-v4-flash` 同时挂在 ark、codemaker、bai、openroputer 四家时，输入区原本只显示 `DeepSeek-V4-Flash · high`，装了这个插件后读作：

```
office · DeepSeek-V4-Flash · high
```

纯客户端插件 + 一个可选的宿主设置段。不遮蔽核心的模型选择器、不做 DOM 注入、不注册模型工具、不新增宿主端点。唯一的写操作是 `session/selectModel`（用户在菜单里显式选择时）。

## 为什么需要它

核心的模型选择器只显示**模型名**（`ModelSelect` 触发器文案是 `model.name · 推理档`；只有模型不在目录里才退回 `provider/model`）。而同一模型名可以同时来自多个提供方——它们各自的计费、限流、上下文窗口与可用性都不同，只显示模型名根本看不出打的是哪条线。核心其实早就具备全部所需数据（会话的 `modelSelection` 投影 + 宿主的 `session/modelCatalog`），缺的只是一个把 provider 说出来的触点，以及一个「先选提供方、再选模型」的入口。

## 安装 / 启停

本插件由仓库的**本地插件管理器**（`dsh-plugin-manager`）统一安装与启停，**不要**单独用 `dsh plugin add` 装它：

1. 只装管理器一次（仓库根就是它的安装外壳，两种入口等价）：
   ```bash
   dsh plugin --profile web add git+https://github.com/Chen5173/dsh-plugins.git
   # 或 dsh plugin --profile web add <本机仓库根>   # 本机开发：改代码即时生效
   ```
2. 重启 `dsh web`，打开设置 →「本地插件」。
3. 在面板里打开本插件的主开关：管理器自动把本包以 `link:<本插件目录>` 写进 profile `devDependencies`（按需跑 `pnpm install`），并写入激活行 `- insert: [{ id: composer-provider-label, name: 'dsh-composer-provider-label' }]`。profile patch 被 DSH **实时热重载**，宿主侧即时生效；本插件带界面，**刷新页面**后界面才进引导图。

- **停用**：面板里关掉主开关（行内写 `disabled: true`；行与依赖都保留，可随时再开）。
- **卸载**：面板里点「移除」（删激活行 + 摘 devDependency；**仓库里的源码目录保留**，可随时再启用）。

### ⚠️ 不要用 `dsh plugin add` 装/卸本子插件

- **装**：本子插件包不声明 `dsh.bundle`，`dsh plugin --profile web add <本子插件目录或包名>` 只会把它装成 profile 的普通依赖并打印 `declares no dsh.bundle — installed as a plain dependency, not a profile layer`，**不会激活它**。激活一律走管理器面板。
- **卸**：`dsh plugin --profile web remove <本子插件包名>` 只摘依赖、**不会删除管理器写的激活行**——残留的悬空行会让下次 `dsh web` 启动直接失败（`failed to import loader entry <id> (<name>): Cannot find package …`）。卸载请用面板「移除」。

**版本要求**：需要核心 **≥ 0.1.2-rc.1**。`session/modelCatalog`、`session/selectModel` 与 `modelSelection` 投影都自 `0.1.2-alpha.1` 起才有（槽位 `conversation.input.right` 本身 0.1.0-rc.7 就有）。版本不够时标签**自动不出现**，不报错；若客户端的 UI 原语里没有 `Menu`，标签会退化为只读形态。

## 标签在哪

composer 工具行右侧组、**模型选择器左边一格**：`[…] [provider] [DeepSeek-V4-Flash · high] [上下文] [发送]`。

标签本身是一枚**胶囊 chip**：28px 高、24px 圆角、左右各 10px 内边距（几何抄自核心模型座位的 `.trigger`，两枚读起来是一排控件）；底色取主题 token `--dsw-alias-interactive-bg-hover-solid`（深色主题深底、浅色主题浅底）。当前主题/皮肤若用 `background-color: … !important` 重绘 composer 里的按钮（如 ice-princess 的 `patches.css`），**以皮肤为准**——那正是想要的效果：此时它与相邻的模型 chip 同色。

## 选择菜单

点击标签打开菜单（`Menu` 原语，原地向上弹）：

| 层 | 内容 |
| --- | --- |
| 根层 | `提供方  <当前短名> ›`、`模型  <当前模型短名> ›` 与 `推理档  <当前档名> ›` 三行 |
| 提供方层 | 顶部「‹ 返回」；下面是目录广告的提供方（目录顺序），失败项置灰并带失败原因；当前路由的提供方若未被广告，会置顶合成一行并标「当前路由」 |
| 模型层 | 顶部「‹ 返回」；「全部提供方」时按 provider 分组（组标题 = 别名 + 登记名）；「仅当前提供方」时只列当前提供方、无组标题 |
| 推理档层 | 顶部「‹ 返回」；按目录顺序列出该模型广告的推理档（档名 + 目录里的说明），当前档打勾；模型未声明默认档时首项是「提供方默认」 |
| 底部 footer | 常驻两个互斥开关：`全部提供方` / `仅当前提供方`（当前项打勾） |

- **点提供方 = 立即切换**：若当前模型仍属于该提供方就保留它；否则优先用 profile 默认模型（当它属于该提供方），再否则用该提供方的第一个模型。提交的永远是「提供方 + 模型」完整组合（宿主的状态模型里没有「只选提供方」这回事）。
- 切换后菜单自动进入模型层，方便接着换模型；选完模型菜单关闭。
- 当前推理档（effort）在新模型仍支持时保留，否则省略（落到该 provider 的默认档）。
- 根层第三行「推理档」显示当前生效档（模型自己的 `defaultEffort` 或本会话显式选的档）；模型不支持推理档时显示「不支持」，进入后只有一行说明。
- 推理档层选中某档即提交 `provider + model + reasoningEffort`；选「提供方默认」提交**不带** `reasoningEffort` 的完整组合（等价于让 host 用该模型的默认档）。
- 菜单内不显示我们自己的「路由来源」，它只在 tooltip 里（悬停/聚焦标签）。
- 键盘：Tab 在项间移动、Enter 触发、Esc 关闭；不提供方向键。
- 显示范围偏好存在浏览器 localStorage（键 `dsh.composer-provider-label.v1`，默认「全部提供方」），**不写宿主配置**。
- 列表高度有上限：模型（或提供方）多时只显示约 **5 行**，其余在卡片内部滚动，底部的显示范围开关始终可见——菜单不会向上长出自己的首行。
- 不可用时（受地址的子代理会话）：菜单能打开，但选择项禁用并说明原因。

> 提示：宿主的 `session/selectModel` 会**顺带把 profile 默认模型也更新**（核心座位同样如此），所以一次选择既是「本会话下一次请求」也会成为「默认」。本插件不额外提示这一点。

## 名字从哪来（优先级）

1. **settings 里的别名**：`providerAliases` 中用户写的短名。命名空间随世代不同——**0.2.0 起是条目 id `composer-provider-label`**（设置服务投影条目自身的 `Config`），0.1.x 是声明段 `dsh-composer-provider-label`（客户端两个都认）；
2. **内置表**：只预置 `deepseek-official → office`（官方 provider 的注册显示名硬编码为 `DeepSeek`，太泛，所以内置一个覆盖）；
3. **注册显示名**（目录里 `group.name`，即 settings 里该 provider 的 `displayName`），**剪掉尾部括号段**——`ARK (Coding Plan)` 显示为 `ARK`，完整名留在 tooltip；
4. 都拿不到 → 显示 provider **id**（如 `codemaker` 没配 displayName 时就是 `codemaker`）。

想给某个 provider 起短名，在 `settings.yaml`（或设置页）里写：

```yaml
dsh-composer-provider-label:
  providerAliases:
    codemaker: cm        # 自定义
    deepseek-official: DeepSeek  # 改掉内置的 office
```

> **两代落点**：
> - **0.2.0 起**：别名写进 profile 里本插件条目的 `config:` 段（`providerAliases`）——宿主半导出**手写 `Config`**（`~standard` + `meta.volatile` + 真实 schemastery refs 表 `toJSON()`），条目因此成为「可配置条目」，客户端按 ns `composer-provider-label` 读到它。
> - **0.1.x**：仍旧走 `settings.installSection` 声明的 `dsh-composer-provider-label` 段；该段只有在宿主半能**动态**解析到 `@deepseek-ai/schemastery` 时才注册，本地 `link:` 安装解析不到（仓库祖先链上没有 `node_modules`）⇒ 此时 `providerAliases` 不生效，插件只用内置别名（`office`）。这是加载形态限制，不是配置写错；0.2.0 的手写 schema 已经不受它限制。

## 行为

| 情况 | 表现 |
| --- | --- |
| 会话已显式选模型 | 标签显示该路由的 provider，tooltip 标注「本会话显式选择」 |
| 切换模型到另一 provider（核心座位或本插件菜单） | 不刷新页面即时跟随（订阅 `modelSelection` 投影） |
| 会话从未选过模型 | 显示解析后的 **profile 默认**路由的 provider，tooltip 标注「跟随 profile 默认」 |
| 切换会话 / 子代理会话 | 跟随当前会话，无需刷新 |
| 改了某 provider 的 displayName 或别名 | 不刷新页面即变（监听 `settings/document-updated`） |
| provider 不在目录里 / 目录还没拉到 | 显示 provider id（降级，不消失） |
| 目录加载失败 | 标签显示错误指示点；点开菜单顶部有「重试加载」；若连路由都未知则只渲染一个可点开的错误态入口 |
| 写入中 | 标签半透明 + `aria-busy` |
| 写入被拒 | 标签出现内联错误点，tooltip 说明原因，路由不变（不弹 toast） |
| 宿主重连 | 丢弃旧目录缓存按新一代重解析 |
| 无会话（欢迎态） | 槽位本就不渲染 |
| 悬停/聚焦标签 | tooltip：provider 完整名 · 模型 id · 当前推理档 · 路由来源 |
| 点击标签 | 只打开菜单，不改变路由 |

tooltip 文案跟随客户端语言（zh/en）；标签文本是 provider 名字，不翻译。外观只用 `--dsw-*` 主题变量，深色/浅色主题均可读；窗口过窄时 provider 以省略号截断（`max-width: 11em` 是**含内边距**的整枚 chip），不挤模型名与上下文用量。

## 设计约束

- **注册在空槽位，不碰核心**：`conversation.input.right`（list / session，`replaceRisk: none`，位置紧邻模型选择器左侧）。`conversation.input.model` 是 single 槽、被核心 `ModelSelect` 占住——遮蔽它等于重写整个两级菜单，不做；DOM 注入改触发器文本没有稳定锚点，也不做。
- **与核心同一条路由规则**：生效路由 = `projection.next ?? catalog.default`（核心 `ModelDirectory.current` 也是这条），标签与模型名**永远不可能对不上**。
- **数据全部公开契约**：`useProjection('modelSelection')`（槽位标准 props）+ `remote.session.modelCatalog()`（按 host 代际缓存，监听 `llm/adapters-updated`、`settings/document-updated`、`connection/reset` 三个信号刷新——与核心目录同款）。
- **写操作只有一条**：`remote.session.selectModel({sessionId, provider, model, reasoningEffort?})`，且只在用户显式选择时触发。测试里有一条能力审计：除它之外 `updateQueue`/`prompt`/`rename`/`fork`/… 一个都不许引用，也不写 settings（只 `describe()` 读）。
- **菜单用核心原语**：`Menu`（`@deepseek-ai/dsh-client-ui-primitives`）+ 自己管理的 pane 状态。不用它的 submenu：子卡片无法用代码展开、不带勾选、还会关掉卡片滚动上限。原地渲染（`side=top`）与核心模型座位同策略。
- **外观对齐核心模型座位，不写皮肤色值**：`src/client.js` 的 `labelStyle` 与 `ModelSelect.module.css` 的 `.trigger` 同几何（28px 高 / 24px 圆角 / 侧内边距 10px，比它宽 2px）；底色只用 `--dsw-*` token。主题或皮肤用 `!important` 重绘 composer 按钮时让它赢——它会顺手把本 chip 刷成与模型座位同色，插件不与其争优先级。
- **宿主依赖可缺失**：node 半经动态 import 加载 `@deepseek-ai/schemastery` 来注册 settings 段；导入失败/无 settings 服务时**静默跳过**，标签仍按内置表工作（见上面「已知限制」）。

## 停用 / 卸载 / 回滚

在管理器面板里关掉主开关即停用（profile 里该行写 `disabled: true`），点「移除」即卸载（删激活行 + 摘 devDependency）。两者都被 DSH 实时热重载，宿主侧立即生效；**刷新页面**后标签消失。

```yaml
# 面板停用后 profile cordis.patch.yml 中的形态（行保留，可随时再开）
- insert:
    - id: composer-provider-label
      name: 'dsh-composer-provider-label'
      disabled: true
```

> 不要用 `dsh plugin --profile web remove dsh-composer-provider-label` 卸载：它只摘依赖、留下悬空激活行，下次 `dsh web` 启动会失败。见上方警示。

插件不写会话数据。若你在 `settings.yaml` 里手写过 `dsh-composer-provider-label:` 段，卸载后它**残留无害**（没有注册方时 `describe()` 不含该 ns），想清理就手动删掉那几行。localStorage 里的 `dsh.composer-provider-label.v1` 也可以留着，卸载后无人读取。

## 与既有插件共存

- `dsh-composer-history-recall`：用 `conversation.input.overlay` 槽（键盘 ↑ 召回），与 `input.right` 互不干扰。
- `dsh-open-session-workdir`、`dsh-session-title-regenerate`：作用于会话头部动作条与侧边栏菜单，与 composer 工具行无交集。
- 其余想注册 `conversation.input.right` 的插件按 `order` 排序（本插件 `order: 10`），不冲突。

## 开发

```bash
node sub-plugins/dsh-composer-provider-label/test/bundle.test.mjs   # 61 条逻辑断言 + 能力审计
node --check sub-plugins/dsh-composer-provider-label/src/index.js
node --check sub-plugins/dsh-composer-provider-label/src/client.js
```

61 条断言覆盖：bundle 注册协议、槽位 id/order、locale 字典、四条路由场景（显式 / 沿用 / 默认 / 无路由）、括号剪裁、office 内置别名、settings 别名覆盖与三种失败回退、三个刷新信号、zh/en、纯函数单测、client 与 node 内置表一致性、node 半空安全；以及本轮扩展：菜单开关与零副作用、根层/提供方层/模型层内容与顺序、失败项置灰、未广告的当前提供方合成行、四种选模型规则（保留 / 默认优先 / 第一个 / effort 继承）、选完自动进入模型层、显示范围切换与 localStorage 持久化、空态与一键切回、写入参数形状、忙碌态、拒绝写入的错误态、子代理会话禁用、目录失败的重试入口、缺 `Menu` 时的只读降级、推理档行与推理档层（当前档打勾 / 选档写入 / 「提供方默认」省略字段 / 不支持模型的空态 / zh-en 文案 / `effortOptionsOf` 契约），以及**能力审计**（`selectModel` 只允许一个调用点，其余改状态 Remote 与 settings 写入一律禁止）。GUI 侧的视觉/布局/主题/真实安装见 [ACCEPTANCE.md](./ACCEPTANCE.md)。

## License

MIT
