# dsh-session-title-regenerate

给 DSH（DeepSeek Harness）会话加一个「重新生成标题」动作：用**当前模型**总结该会话**全部用户提问**，生成一个 60 字以内的单行标题并直接覆盖旧标题。默认**关思考**（`reasoningEffort: 'off'`，不把思考 token 花在标题上）、输出上限 **512 token**；两者都能在 设置 → 本地插件 →「重新生成标题」 面板里改。

两个入口，共用同一套逻辑：

- **会话头部操作区按钮**（`conversation.session.header.actions` 槽位）
- **侧边栏会话行 `⋯` 菜单项**「重新生成标题」——核心 `ui-workspace` 把该菜单（重命名/分叉/归档）写死、没有插件扩展点，因此本项与 `@huanlin/dsh-plugin-session-delete` 同款，采用 **DOM 注入**（MutationObserver 监听 `[role=menu]`）。核心把原生项渲染在 `[role=menu] > role=presentation(viewport)` 内容区里，而 session-delete 等插件项是直接挂到 `[role=menu]` 上的兄弟节点；所以本插件把菜单项**追加进内容区 viewport**，使它紧跟在官方"重命名/分叉/归档"之下、位于所有插件注入项之上，且不带自己的分隔线——读起来像官方操作而非插件附加项。
  - **注入项与官方行同构**：自带包裹层 `div`，按钮里**图标槽 + 文案槽各占一个 `span`**（与 `div.itemWrap > button > span.itemIcon + span.itemLabel` 同形，但不依赖核心的 hash 类名）。这不是审美要求——第三方插件按**结构**解析这张菜单：`dsh-flowglass` 0.7.0 的「加入当前并发分支」取「最后一个 `[role=menuitem]` 的 `parentElement`」当作"这一行"再 `cloneNode(true)`，裸 `button` 的 `parentElement` 是整个 viewport ⇒ 会把整张菜单复制一份、只改其中第一行，`分叉/归档/…` 成排重复。2026-09-21 修复，根因与验证见 [`docs/knowledge/2026-09-06-dsh-session-title-regenerate.md`](../../docs/knowledge/2026-09-06-dsh-session-title-regenerate.md) 末节。

宿主注册 `/regenerate-title` 命令；客户端通过核心 Remote `remote.commands.execute(sessionId, '/regenerate-title', [])` 触发——该 Remote 的 `agent` 查找会**自动恢复未打开的会话**，所以菜单项对任意历史会话都有效，且**不会切换当前对话**。

## 工作原理

1. **收集输入**：读会话日志里所有 `user/message`（`source.kind === 'user'`）的文本块，按序拼接、按 UTF-8 字节预算（默认 12 KB）截断。
2. **推理档位与输出预算受设置控制**：`ctx.llm.stream` 带 `purpose: 'session-title'`（DeepSeek 适配器对 `session-title` 还会强制 `thinking: disabled`）+ `maxTokens`（默认 512）+ 极短提示词。思考**默认关闭**——只有设置里打开「思考」开关，才把所选档位（`low`/`medium`/`high`/`max`）作为 `reasoningEffort` 传下去，关闭时发 `off`（pi-ai 路由会把 `off` 翻成「省略 reasoning 字段」，等价于不思考）。若提供方不支持该档位（返回 `UNSUPPORTED_REASONING_EFFORT`），自动去掉该字段重试一次。
3. **提示词**：只输出一行纯文本标题、无引号/无 Markdown/无解释、**跟随消息语言**、约 60 个 CJK 字符 / 40 个词。
4. **写入**：`ctx.sessionTitle.rename(session, title)` ——与核心 `remote.session.rename` 同一公共 API：新标题进入日志、固定标题（来源记为 `user`）、客户端列表经标题投影即时刷新。
5. **反馈**：成功 Toast「标题已更新：<新标题>」，失败 Toast 透出原因。

## 安装 / 启停

本插件由仓库的**本地插件管理器**（`dsh-plugin-manager`）统一安装与启停，**不要**单独用 `dsh plugin add` 装它：

1. 只装管理器一次（仓库根就是它的安装外壳，两种入口等价）：
   ```bash
   dsh plugin --profile web add git+https://github.com/Chen5173/dsh-plugins.git
   # 或 dsh plugin --profile web add <本机仓库根>   # 本机开发：改代码即时生效
   ```
2. 重启 `dsh web`，打开设置 →「本地插件」。
3. 在面板里打开本插件的主开关：管理器自动把本包以 `link:<本插件目录>` 写进 profile `devDependencies`（按需跑 `pnpm install`），并写入激活行 `- insert: [{ id: session-title-regenerate, name: 'dsh-session-title-regenerate' }]`。profile patch 被 DSH **实时热重载**，宿主侧即时生效；本插件带界面，**刷新页面**后界面才进引导图。

- **停用**：面板里关掉主开关（行内写 `disabled: true`；行与依赖都保留，可随时再开）。
- **卸载**：面板里点「移除」（删激活行 + 摘 devDependency；**仓库里的源码目录保留**，可随时再启用）。

### ⚠️ 不要用 `dsh plugin add` 装/卸本子插件

- **装**：本子插件包不声明 `dsh.bundle`，`dsh plugin --profile web add <本子插件目录或包名>` 只会把它装成 profile 的普通依赖并打印 `declares no dsh.bundle — installed as a plain dependency, not a profile layer`，**不会激活它**。激活一律走管理器面板。
- **卸**：`dsh plugin --profile web remove <本子插件包名>` 只摘依赖、**不会删除管理器写的激活行**——残留的悬空行会让下次 `dsh web` 启动直接失败（`failed to import loader entry <id> (<name>): Cannot find package …`）。卸载请用面板「移除」。

## 配置

两层：**设置页**（推荐，保存即生效）与 **profile 行 `config:`**（随安装形态走、可写固定 provider/model）。

### 设置页：设置 → 本地插件 → 「重新生成标题」

插件在 `settings.localPlugins.tab` 槽注册了一个 tab（id = entry id `session-title-regenerate`，order 45），读写的就是自己那条 entry 的配置；命名空间就是 entry id，与插件名无关。

| 项 | 默认 | 说明 |
|---|---|---|
| 思考开关 | 关 | 唯一的思考开关：关 = 本次调用不下发 `reasoningEffort`（最省 token）；打开后才出现下面的「推理强度」单选 |
| 推理强度 | 打开后为 `low` | 单选 `low` / `medium` / `high` / `max` **四档**；思考关时这一栏只显示「当前不思考」说明——`off` 不单独成档，因为「关」就等于它 |
| 输出上限 | `512` | `maxOutputTokens`，允许 16 – 8192；输入过程中不打断，离开输入框时自动夹取 |

底部一行状态区回显**本次调用实际会发什么**（如「本次调用：不下发 reasoningEffort · maxTokens 512」或「…reasoningEffort = high · maxTokens 2048」），并在有未保存改动时显示「● 有未保存的改动。」。

「保存」写进 profile 行 `config:`（宿主半随 entry 重载，即时生效；客户端读的是同一份投影，刷新后回显）；「填入默认值」只把面板填成 思考关 / `off` / 512（需再点「保存」才写盘），「重新读取」丢弃未保存改动。

> ⚠️ `link:` 安装形态下宿主半解析不到 `@deepseek-ai/schemastery`，所以本插件的设置 schema 是**手写**的（`src/index.js` 末尾 `CONFIG_SCHEMA_JSON` + `Config` 导出，手工 `toJSON`/`~standard.validate`）。设置页能读写靠的就是这条手写 schema，与 `dsh-composer-provider-label` 那个「依赖宿主 schemastery、link 形态下失效」的设置段不同。

### profile 行 `config:`

`/regenerate-title` 命令的默认策略见 `src/index.js` 的 `DEFAULTS`，可在 profile 的 cordis patch 行上用 `config:` 覆盖（示例）。该行由管理器面板写入（规范形态 = `- insert: [{ id, name, config?, disabled? }]`）；**在管理器写的这行 insert 项上**手工补的 `config:` 会被保留——开关切换只改 `disabled`（`upsertManaged` 对已存在的 insert 项做 `{ ...item, name }` 后仅增删 `disabled`），所以不要改它的 `id`/`name`。反之，若自己另写一条顶层覆盖行（`- id: session-title-regenerate` + `config:`），首次开关会把它规范化成 insert 项并丢掉那些额外字段 —— 要覆盖配置请直接写在下面这条 insert 项上：

```yaml
- insert:
    - id: session-title-regenerate
      name: 'dsh-session-title-regenerate'
      config:
        provider: deepseek      # 可选：覆盖会话路由（默认跟随会话当前模型）
        model: deepseek-chat    # 可选：必须与 provider 成对出现
        targetWords: 40         # 非 CJK 语言目标词数
        targetCjkCharacters: 60 # CJK 目标字数
        maxInputBytes: 12288    # 输入字节预算
        thinking: false         # 思考开关（= 设置页「思考」；false 时不发 reasoningEffort）
        reasoningEffort: 'off'  # 思考打开时用的档位：off/low/medium/high/max（= 设置页「推理强度」）
        maxOutputTokens: 512    # 输出 token 上限（= 设置页「输出上限」，16–8192）
        timeoutMs: 30000        # 单次生成超时
```

## 测试

```bash
node sub-plugins/dsh-session-title-regenerate/test/bundle.test.mjs
```

31 条断言全绿（宿主 19 + 客户端 12）。纯 Node 逻辑 harness（无浏览器）：宿主命令 handler（消息收集、推理档位解析与夹取、`Config` 投影、标题规范化、错误/重试/截断/取消路径）+ 客户端（槽位注册、命令触发、标题→id 解析、菜单注入与点击流）。宿主半**不 import 任何宿主包**——消息构造与流装配是 `src/index.js` 内的本地实现——因此测试与运行都不需要 `node_modules`，`link:` 安装也能直接加载。

## 兼容性与风险

- 目标核心版本 `>= 0.1.1-rc.2`（`remote.commands.execute`、`ctx.sessionTitle`、`purpose:'session-title'` 均自该版本存在）。
- **宿主半零宿主包依赖**：只用注入服务 `commands` / `llm` / `sessionTitle`，消息构造与流装配为文件内本地实现 → 以 `link:` 形态装在 profile 之外也能加载。若在 `src/index.js` 里 import `@deepseek-ai/*`，Node 会按仓库真实路径解析（symlink 被解引用），仓库祖先链上没有 `node_modules` → 启动即 `ERR_MODULE_NOT_FOUND`。
- 菜单项依赖核心 `ui-workspace` 的会话行 DOM（`[class*=sessionRow]` + `menuOpen`、`[role=menu]`、`[class*=title]`）。`session-delete` 插件在本 profile 已在用同款手法；若上游为会话菜单新增插件槽位，本插件的注入项可平滑换成槽位实现。
- 会话行 DOM 不携带 id，菜单项按**标题**反查会话（客户端列表 store：精确 → 去 fork 后缀 → 互相包含）。同名标题极端情况下可能解析偏差；头部按钮按 id 触发，不受影响。
- 标题以 `user` 来源固定：此后新消息不会自动更新该标题，需再次「重新生成」（这是第 1 轮已确认的「始终覆盖」语义）。
- 触发会经过 `commands.execute`，会话流里会出现一对 `command/run`/`command/done` 节点（`recordInput:false`，不记录参数）；命令也会出现在 composer 的 `/` 命令菜单（可手动输入 `/regenerate-title`）。
- 宿主错误文案为简体中文（客户端自有文案 zh/en 双语）。

## 许可

MIT
