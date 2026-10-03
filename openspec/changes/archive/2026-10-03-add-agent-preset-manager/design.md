# Design: add-agent-preset-manager

## Context

0.2.0 线把 agent preset 从「目录扫描」改成了「运行期注册表声明」：宿主提供 `agentPresets` 服务（`@deepseek-ai/dsh-agent-preset-registry`）的 `register(definition)` / 撤销句柄，注册表本身不扫描任何目录，也不提供任何写入接口。用户机器上两份旧目录（`$DSH_HOME/.agent-presets/standard`、`$DSH_HOME/.agent-presets/liangshen`）因此在新版本里完全失效；已知的社区同类实现只装在 desktop profile，web profile 下用户没有任何 preset 管理面。

本设计的约束来自现场核对（详见 proposal.md 与 spec 的 12 条 Requirement）：
- 注册表在内存 Loader 树上挂载声明，只有 profile 配置编辑能持久化定义；因此「跨重启保持」必须由本插件自己承载。
- 声明里的相对行名（如 `./tool-bootstrap.mjs`）按宿主 `mountPreset` 的实现以**声明所携带的 baseUrl** 解析，而声明由本插件发起，所以基点必须显式指向被声明预设自己的目录。
- 声明前宿主会做 profile 兼容性预检（`prepareProfileEntries` + `auditRows`），会把冲突行 disable 并把原因写 stderr；服务泄漏到 root realm 会直接抛 `Preset services require isolate realms: <names>`。
- profile 里已安装 dsh-plugin-manager（本仓 host half），它扫描仓库子插件并以 stable-id insert 行服务本地插件；新包的安装与激活应当复用它，而不是自建安装路径。

## Goals / Non-Goals

**Goals:**
- 让本地目录里的预设重新可用：读目录 → 声明给注册表 → 新建会话可选；停用即撤销，启用集合跨重启自动恢复。
- 把「体检」做得能让用户自助定位问题：哪一行、原行名、为什么不可用。
- 文件写入对用户可逆：编辑留备份、删除要二次确认、导入/迁移不覆盖已有内容、绝不静默改动 profile。
- 在新包内自洽：host 半区与 client 半区都在 `dsh-agent-preset-manager/` 下，不向 dsh-plugin-manager 增加职责。

**Non-Goals:**
- 不做市场下载、不做 provenance 校验、不联网（本插件只面对本地目录）。
- 不自动修复旧组成的包名（旧包改名/字段变更只报给用户，由用户改）。
- 不接管运行中会话的预设切换（preset 是会话启动时选定的）。
- 不实现安装/卸载插件包本身（那是 dsh-plugin-manager 的职责）。

## Decisions

### D1 独立包，而不是并进 dsh-plugin-manager
dsh-plugin-manager 的 host half 就是当前运行进程里加载的代码（`src/index.js` 被 profile 作为 link 依赖软链），为它加功能等于当场改动自身宿主；其 `test/bundle.test.mjs`（约 39KB 断言）与 `src/client.js`（约 40KB）已接近单文件可维护上限。新包与其平级放在仓库根下，客户端只向 `settings.localPlugins.tab` 槽报名一个 tab，通过既有的本地插件面板被发现与激活（安装面零增加）。
备选：并进管理器（用户最初的选择）。放弃原因：包边界与测试边界会被糊掉，且改 host half 需要重启宿主才能验证。

### D2 运行时服务发现 + 只读降级，而不是静态 `inject`
host 半区 MUST NOT 静态声明依赖 `agentPresets`：0.2.0 之前的宿主没有这个服务，静态依赖会让插件在旧线直接装载失败。做法是启动时按「一次性探测 + 事件驱动」拿到服务：探测到服务即读取 `state.json` 重放启用集合；探测不到则以「只读模式」运行——`/state` 仍能列出本地预设与体检结果，所有写操作（开关、新增、保存、删除、导入、迁移）返回明确的「当前 DSH 版本不支持运行期声明 preset」错误，不产生任何磁盘副作用。
备选：静态 `inject: ['agentPresets']`。放弃原因：旧线直接崩，违反「不干扰既有 setup」。

### D3 启用状态放插件自有 `state.json`，不写 profile patch
profile 的 `cordis.patch.yml` 是 DSH 编辑器的领地，往里插 preset 声明行会与运行期注册状态形成两套真相，还会在用户用编辑器改动时打架。启用集合改为写 `$DSH_HOME/agent-preset-manager/state.json`（形状 `{ version: 1, enabled: [id...] }`），插件启动时重放。首启（文件不存在）＝空集，**不自动启用任何东西**——本地组成可以含任意代码（`./*.mjs`），自动启用等于自动执行未经用户确认的内容。
备选：往 profile patch 插 `@deepseek-ai/dsh-agent-preset` 行。放弃原因：与编辑器争夺文件所有权、用户改动后状态不可预测。

### D4 行名解析基点＝被声明预设自己的目录
声明对象的 `plugins` 行里可能出现 `./tool-bootstrap.mjs` 这类相对行名（旧梁神预设即如此）。本插件在发起声明时把 baseUrl 指向 `<预设目录>/`，使这类行解析到该预设自己的文件。若行名是绝对路径或 `file://` URL，按宿主 `import` 的原生语义直接可用。
备选：声明时不改写行名（照抄旧组成）。放弃原因：旧目录里的相对行名会解析到本插件目录，必然失败；而改写行名会改动用户文件字节，违反「迁移不自动修复组成」。

### D5 声明用「目录名 = id」，显示名单独取 `preset.yml`
注册表的 `presetDisplayText` 只对内置 preset 走 i18n，用户自定义 preset 必须有 `name` 才显示可读文本，否则回退 `preset.id`。因此扫描时以目录名作为 id，显示名取 `preset.yml.name`，缺失时显式补 `id` 作为显示名后再声明（避免面板与选择器出现空白行）。

### D6 体检基于「运行时实际可解析性」
体检接受一个候选行名，判定过程：`cordis:` 前缀 → 宿主内置行（白名单内为可用）；`./x` 或绝对路径 → 检查该预设目录下文件是否存在；`@deepseek-ai/dsh-*` → 用 `createRequire` 从宿主运行时位置解析该包（含子路径导出检查）并读取其 `package.json`；其余裸包名 → 按同一机制解析。带 `config.plugins` 的分组行递归判定子行。结论只有 `可用 / 存疑 / 不可用` 三色 + 具名理由，**不阻止启用**；config 字段是否匹配新版 Config 无法静态判定，统一归入 `存疑`。
备选：只做存在性字符串匹配（不读包）。放弃原因：用户无法区分「包在但导出变了」与「包真的没了」，正是本次要解决的问题。

### D7 文件写入策略：备份 + 原子替换 + 不覆盖
编辑保存：先把当前文件复制到 `<预设目录>/.backup/<文件名>.<时间戳>`（保留最近 3 份，更新的自动清理），再以「写临时文件 → rename」原子替换；备份失败则拒绝保存。导入/迁移/新增：目标 id 已存在一律拒绝，不做覆盖合并；新增在骨架读取失败时不落任何目录。删除：先撤销声明、再从状态文件移除记录、最后删目录；目录删除失败时如实返回「已停用、目录未删除」。

### D8 新建骨架就地读内置 standard 组成
骨架来源＝宿主发行的 `@deepseek-ai/dsh-web-app/presets/standard.patch.yml` 中 `preset-standard` 行的 `config.plugins`。解析该文件需要 YAML 能力：优先用 profile 自己的 js-yaml（与 dsh-plugin-manager 相同做法，`createRequire(<profile>/package.json)`，本机已证 hoisted nodeLinker 下可解析），不可用时退回内置的极简解析（该文件的组成子集是普通块映射/序列 + `!!js` 标量，足以覆盖）。骨架读取失败 = 拒绝创建并报错，不留半成品。

### D9 面板与服务端契约
host 半区挂在 `/__dsh-agent-presets/*`：`GET /state`（扫描 + 体检 + 运行期状态）；`POST /set-enabled`、`/create`、`/save`、`/remove`、`/import`、`/migrate`（写操作）。所有写操作统一返回**最新的完整 state**，面板无需二次拉取即可刷新。client 半区不引 JSX（宿主 loader 只提供 `require('react')`），用 `React.createElement` + 内联样式 + `--dsw-*` token，与既有子插件同构；文案沿用本仓「内嵌 zh 字典」惯例。

### D10 不触碰既有 setup
本插件不读写 profile 的 `cordis.patch.yml`、`package.json`、`dsh.profile.bundles`，也不改动其它插件的行或第三个预设中心的凭证文件；它只在 `$DSH_HOME` 下自己的两个目录（扫描目录只读、新库目录与状态目录可写）与注册表内存里工作。

## Risks / Trade-offs

- [本地组成可含任意代码（`./*.mjs`），启用即执行] → 首启不自动启用；启用前体检把 `不可用/存疑` 行摆给用户看；开关动作由用户逐项发起。
- [体检只能判包名可解析，判不出 config 字段是否匹配新版本包 Config（如旧 `persona.config.text` 已改为 `suffix/prefix`）] → 这类一律标 `存疑` 并给出「字段可能已过时」的提示；失败时把宿主原文回显，让用户按原文定位。
- [注册表声明只在内存，宿主重启后本插件的重放可能晚于用户新建会话] → 重放发生在插件启动阶段（注册表已可用即重放），面板状态与注册表状态同源，用户看到的即实际生效的。
- [`state.json` 与磁盘目录漂移（用户手动删目录）] → 启动时忽略不存在的 id（保留记录，目录回来后自动恢复），面板对「记录里有、磁盘没有」的情况不报错。
- [迁移/导入会把用户目录里的任意文件一起复制（可能含大文件）] → 复制前展示将导入的 id/显示名/行数供确认；跳过 `.backup/` 与隐藏临时文件。
- [与第三方预设中心在同名 id 上冲突] → 不在本插件侧做独占锁；由注册表的重复 id 判定如实呈现为 `启用失败`，信息不吞掉。

## Migration Plan

1. 实现 host/client 两半 + 单测，全绿。
2. 经用户同意后，用本仓 dsh-plugin-manager 的既有流程把新包接入 web profile（devDependency link + stable-id 行），刷新页面。
3. 验收路径：打开设置 → 本地插件 → Agent 预设 → 对旧目录 `liangshen` 做迁移 → 启用 → 新建会话确认可选；再做一次停用/删除的回归。
4. 回滚：在本地插件面板停用/移除该包即可，插件不写 profile 的其它部分；`state.json` 与两个预设目录独立于插件包，不会被移除动作删除。

## Open Questions

- 面板是否需要把「存疑」行的提示细化到具体字段级建议（例如明确写出 persona 的 `text` → `suffix/prefix`）？可以后续按实际反馈补，不影响 specs 与任务拆分。
- 是否需要在面板提供 `.backup/` 的浏览与还原入口？当前只保证备份存在，还原靠用户手动换文件。
