# dsh-esc-rewind

给 DSH Web 会话加「停止 + 回退重来」：`Esc` 一次=停止当前生成；再按一次 `Esc` = 把刚被停的**整个最后一轮**撤销重来；另有 `/rewind` 命令，可从**历史任意一轮**重新开始。重来一律走 DSH 官方机制——**fork 分支 + 打开分支 + 还原问题到输入框**；旧会话如何处置由一个**会话头开关**控制：默认**归档**（隐藏出主列表、日志保留可恢复），可切到**删除**（经宿主半真删磁盘日志，不可恢复）。

客户端为主（`sessions` binding/fork/create、`uiWorkspace` openSession（0.2.0 起；0.1.x 仍在 `sessions.open`，按能力探测）、`workspaces` archiveSession、`conversation` cancel/updateQueue/createDrafts（0.1.5-rc.2 起；旧核心为 `createDraftImages`，按能力探测兼容）、`uiConversation` 节点快照、`commandUi` popupSelect 贡献）；**删除模式额外带一个宿主半**（`src/index.js`）：注册 settings 命名空间 `esc-rewind`（字段 `deleteOldOnRewind`，默认 `false`）+ 自建删除端点 `/__esc-rewind/session/delete` 与模型工具，不依赖任何第三方删除实现。架构上与核心“Branch(分叉)/Archive(归档)”行菜单同源，不碰 append-only 日志（删除模式是用户显式开启后的真删）。

## 行为

| 情况 | 表现 |
| --- | --- |
| 生成中按 `Esc`① | 停止当前生成（同 Stop 按钮的 `session.cancel`）；toast「已停止 · 再按 Esc 回退本轮」（删除模式下为「已停止 · 再按 Esc 将删除本轮并重来（不可恢复）」） |
| 停止后再按 `Esc`② | 回退本轮：取消排队消息 → 定位“本轮开始前”的上一完整回合 → `fork` 新分支 → 保留原标题 → **按开关处置原会话（默认归档 / 开启后真删）** → 打开分支 → 把被撤销的问题文本（尽力含图片）还原到输入框，toast「已回退…」 |
| 生成中快速连按两次 | 第二击不等停稳：直接执行“停止+回退”（最终状态一致） |
| 用工具栏 Stop 按钮停止 | 同样进入“可回退”预备态（尾部是被中断的 assistant）；再按一次 `Esc` 即回退 |
| 自然正常结束的回合 | **不可回退**：尾部是 settled assistant，`Esc` 不接管（防误删）；**也不会弹「再按 Esc 回退本轮」提示**（该提示只认宿主耐久停止证据，见下） |
| 「再按 Esc 回退本轮」提示的时机 | 仅在**本会话内出现过 running→idle** **且该轮有宿主耐久停止证据**时出现：尾部 assistant 带 `interrupted`，或该轮 `turn/end` 为 `aborted`/`user`（覆盖「尚无内容即被停」）。判据在该轮**定型后**结算，因此提示可能晚于停止动作一两帧；自然结束（settled / `completed` 等）永不提示，切进历史上被中断/失败的会话也不提示 |
| 编辑了输入框草稿 | 解除预备态：再按 `Esc` 不回退（防覆盖你正在写的新内容） |
| 回退时该会话还有**没落定的排队消息** | 先把未落定输入清掉并**确认清空**再 fork；**清不掉就放弃本次回退**并提示「该会话还有没发出的消息在排队…」——宿主的 fork 用事件种子重建子会话，父会话里那条刚发出、还没落盘的排队输入会被一起复制过去，子会话会先执行它而用户新发的消息只能排队（真机复现过，见下）。未落定 = 宿主 `inbox` 投影 ∪ queue 镜像 ∪ 还没对账的本地回声（刚按下回车那一瞬；「等待队列」UI 也是拿它渲染的），三个来源缺一不可 |
| 分支**继承来的旧提问**（0.1.5 起） | 分支打开后再清一次它自己的收件箱：宿主的 fork 种子 = 父会话 `[0, cut)`，`cut` 从边界 `turn/end` 一路走到**下一个 `turn/start`**，于是被回退那条消息的 `agent/inbox/spliced` 插入事件必然被复制进分支（它的 claim 事件落在切点之外）⇒ 分支收件箱里有一条继承来的 pending 旧消息。清不掉这条，用户重发时 agent 会先执行它、新消息只能排队（真机「一条在执行、一条在等待」的成因） |
| 有新发送 / 切换会话 | 解除预备态（按会话派生，天然失效） |
| 弹层/菜单/输入补全打开 | 不接管 `Esc`（让给核心“关闭弹层”），先关弹层再谈停止/回退 |
| `/rewind` 命令 | 打开**原生命令选择器**（popupSelect）：**首次**打开时 `session.loadThrough(0)` **一次性把全部历史读进客户端**（shell 原生显示“加载中”），随后列出**每一个**“用户提问回合”，**最新在最上**，行 = 序号+截断文本+相对时间；读完后原生支持 `↑/↓` 逐条、直接打字过滤搜索、超长自动滚动——**更早内容即使从未在聊天里渲染也能选到**，不是逐页动态追加 |
| 重复打开 `/rewind` | **load-once**：同一页面内首次全量加载后直接读“活会话”（新消息实时并入，不会漏最新），**不再重复请求**；刷新页面后读**本地缓存记录**（localStorage 存该会话已读的用户回合，含水位 seq），缓存未过期就直接出列表、不发请求 |
| 有新内容（缓存过期） | 缓存水位 < 当前最新回合时，自动**合并重载一次**（`loadThrough(0)`）并更新缓存/水位——最新一条不会因读缓存而缺失 |
| `/rewind` 可用性 | 与“已加载多少历史”**解耦**：非空白、非子代理会话就永远可选（不再因更早内容未加载而消失） |
| `/rewind` 选中首轮（无前史） | 降级：按开关处置原会话（默认归档 / 开启后真删）+ 打开同工作区的新空会话 + 还原问题 |
| 子代理（subagent）会话 | 不提供回退；会话头也不显示处置开关 |
| 空白（blank）会话 | 会话头不显示处置开关 |
| 停止时在排队中的消息 | 回退时一并清掉（`updateQueue remove`） |
| **处置开关（会话头右侧图标排）** | 档案柜=归档（默认）⇄ 红色带叉垃圾桶=删除，单击切换；**全局偏好**，经 settings 命名空间 `esc-rewind.deleteOldOnRewind` 持久化（设置页可见），所有普通会话的回退都按它处置旧会话。**0.2.0 起归档是「停止并归档」**：`workspaces.archiveSession` 返回 Result 且对仍有运行中工作的会话默认拒绝，插件桥接为「被拒即带 `stopActivity: true` 重试一次」，最终失败会提示，绝不静默（诊断 `__dsew.archiveFail` / `archiveStopActivity`） |
| 删除模式下回退 | 先 fork 并确认新分支打开可用，**然后**才真删旧会话；删除失败自动**降级为归档**并 toast「删除失败，已改为归档」；成功 toast「旧会话已删除」 |
| 删除模式与既有删除按钮 | 本开关图标带叉/红色警示，语义是“下次回退时处理旧会话”，与 chameleon「删除当前会话」的普通垃圾桶视觉可区分 |

## 为什么默认是 fork+归档，删除是可选项

DSH 会话日志是 **append-only**：没有任何受支持的插件 API 能在当前会话里删消息（`/compact` 用的 surface-replace 只能“换一段为一条新节点”且为宿主内部，客户端 `'rewind'` 类型是死代码）。因此“回退”用核心一等公民表达：

1. **fork** 于目标回合的上一完整回合边界（与 Branch 按钮同款 `sessions.fork({atSeq})`，`increaseTitle:false` 后按需改回原标题）；
2. **按开关处置原会话**：默认 `workspaces.archiveSession`（归档隐藏、日志保留可恢复）；开启删除后，fork+open 新分支确认可用才经宿主半真删（磁盘日志目录 + 投影缓存 + 工作区记账一并移除），但**该会话仍挂着子代理时不删**（宿主半拒绝 → 同样降级归档，避免子代理变孤儿）；
3. **切换分支**（0.2.0 起 `uiWorkspace.openSession`，0.1.x 为 `sessions.open`）并还原问题文本（`inputActions.setDraft`，图片经 `readAttachment` → 草稿附件桥（新核心 `createDrafts`/`addAttachments`，旧核心 `createDraftImages`/`addImages`，按能力探测选名字）尽力还原）。

**为什么删除不是默认**：客户端没有任何官方“删除会话”verb，真删必须宿主动盘（`src/index.js` 自建端点/工具），且**不可恢复**。因此开关默认关闭（归档=安全侧），只有用户显式打开才进入删除态；删除态下**无二次确认**（已接受误触即永久丢失的风险），防误触靠：默认关闭 + 图标红叉状态 + 切换/停止/执行的 toast 警示。

## 删除模式（宿主半）

- **settings**：命名空间 `esc-rewind`，字段 `deleteOldOnRewind`（boolean，默认 `false`）。**两代落点不同**：0.1.x 由 node 半 `settings.installSection` 注册（settings.yaml 的 `esc-rewind:` 段）；**0.2.0 退役了 installSection**，改为投影条目自身导出的 `Config`（命名空间 = 条目 id），因此 node 半导出一份手写 schema（`~standard` + `meta.volatile` + 真实 schemastery refs 表 `toJSON()`；`link:` 安装无法 import schemastery），写入走条目重启。客户端经 `remote.settings.describe()` 读取、切换时 `update()` 写入；读取失败/缺字段一律回退 `false`（绝不因读不到配置而误开删除）。设置页可改（settings/document-updated 会即时刷新会话头图标）。
- **删除通道**（自建，无第三方依赖）：`webServer` 提供 `POST /__esc-rewind/session/delete`（校验 sessionId 格式与 POST 方法）；同时注册模型工具 `esc_rewind_session_delete`（terminal/edit-mode 可用）。`webServer`/`tools` 缺席时删除通道不可用，客户端自动降级归档。
- **只读诊断端点**：`GET /__esc-rewind/status` 回报宿主半健康度——`settingsSectionRegistered` / `settingsSectionError` / `deleteOldOnRewind`（当前删除模式）。非 GET 方法回 405。排查「图标点了没反应 / 删除模式像没生效」时先打它，判断的是宿主半有没有起来，不看会话内容。
- **客户端诊断快照**：`window.__dsew`（门控计数、最后一次决策、删除模式位；不含消息内容）。
- **删除核心** `deleteSessionCore`：拒绝运行中 agent → flush → detach → 删磁盘日志目录（两种 id 拼写）→ 清投影缓存 → 复扫磁盘（防 dispose 重建）→ 确认无残留后才清工作区/归档记账；失败抛错不碰记账（半删会话不会掉进 Ungrouped）。
- **子代理守卫**：真删前用官方 `ctx.subagents.listChildren(sessionId)` 探一次本会话的子代理——子代理只能靠它**自己的 header** 挂父（`header.parentSession`），父日志一删就再也列不出来（界面入口只剩父会话的子代理目录），运行中的还会失去完成通知的收件人（`notifySettlement` 按父 agent 投递，父缺席即丢弃）。命中即 **409 + `{reason, children, running}`** 拒绝且不碰磁盘/记账；客户端据此**归档**并给专用 toast「该会话还有 N 个子代理（运行中 M），已改为归档（不删除）」。listing 抛错 → 同样拒绝（`reason: subagents-unknown`，fail-safe：证明不了“没有子代理”就不做不可逆操作）；`subagents` 服务缺席 → 放行（无运行时尚无法拥有子代理）。守卫结论留存 `HOST_DIAG.lastGuard` 并由 `GET /__esc-rewind/status` 回报。
- **安全时序**：删除永远在“新分支 fork+open 成功并可用之后”；删除失败 → 降级 `archiveSession` + toast，回退本身不失败。

## 子代理回收（宿主端点保留；**UI tab 自 2026-10-18 起休眠**）

- **UI 入口已撤掉（用户要求「暂时不用了，把 UI tab 先撤掉」）**：本插件**不再**往 `settings.localPlugins.tab` 注册「子代理」tab（id `subagents` / order 50 的常量与面板代码都还在），因此「设置 → 本地插件」里看不到这个 tab。**保留且可用的部分**：宿主半三个端点（`GET /__esc-rewind/orphans`、`POST /__esc-rewind/orphans/stop`、`POST /__esc-rewind/orphans/delete`）照旧注册、可直接 HTTP 调用；面板实现随意保留在 `__dsew._module.orphansPanel`，`fetchOrphans` / `stopOrphans` / `rescueOrphan` / `stopResultText` 也照旧导出。诊断：`__dsew.orphanTabDormant === true`、`orphanTabRegistered === false`（有意不注册，不是失败）。**恢复方式**：把 `src/client.js` 里那段注释掉的 `ctx.slots.inject(TAB_SLOT, () => ctx.slots.register({...}, OrphansPanel))` 注册块接回来（源码注释里已给出完整片段），改完刷新页面即可；不恢复时核心没有该槽的旧版本行为与现在完全一致（同样是「没有 entry、不算错误」）。
- **孤儿 = 不可达的子代理会话**：`origin === 'subagent'` 且其 `parentSession` 已不存在，或父自身也不可达（传递判定）。依据：侧栏不渲染子代理行（`ui-workspace` 的 `tree.ts` 过滤 `origin !== 'subagent'`），子代理只能从父会话的子代理目录进入 ⇒ 父一被删，整棵子树都没有入口、完成通知也无处投递。
- **只读统计**：`GET /__esc-rewind/orphans` 返回每个孤儿的 id、创建标签（子会话 `subagent/descriptor` 的 label，取不到回退 id）、父 id、是否在跑（`agents.get(id).status`）、能否找回（日志里有没有 `turn/end`）、最后活动时间；冷读并发上限 4，单条读取失败只降级该行。**打开面板与「刷新统计」只发 GET**，不停、不删、不 fork。
- **停止**（`POST /__esc-rewind/orphans/stop`，body `{ids}`）：取消该孤儿的 agent 并等待静默（上限 15s）；未在跑 = 幂等 no-op；等待超时 = 如实回报「未确认静默」，不谎报成功。含义是**放弃它的结果**。
- **删除**（`POST /__esc-rewind/orphans/delete`，body `{ids}`）：**真删**——先停（若在跑）再移除会话日志、投影缓存与工作区记账，与删除模式同一条受守卫的删除核心。点删除会先弹**确认框**（写明数量与「不可恢复」）。若该孤儿**自己还挂着子代理**，删除被**拒绝**并如实回报子级数量（**不级联**，请在列表里先删子级）；读不到子代理状态时同样拒绝（fail-safe）。逐项结果区分：已删除 / 被拒（含子级数）/ 会话不存在 / 失败。
- **全选 / 取消全选**：一键勾选当前列表全部行，便于「停止选中 / 找回选中 / 删除选中 (N)」批量处置；计数显示「共 N 个 · 已选 M/N」。
- **找回**：把孤儿 `fork` 成**普通会话**（`origin` 为空 ⇒ 侧栏可见、可继续追问），种子覆盖它到最后一个完整回合为止的全部对话，标题沿用孤儿标签并自动打开；**原孤儿不删除**。运行中的孤儿会**先停止再 fork**（未落盘的在跑内容进不了种子）；没有完整回合边界时按钮禁用并给出原因。
- **全手动**：没有启动钩子、没有定时器、没有任何自动动作；**删除孤儿不在**本插件范围内（模型工具只提供 `list` / `stop`）。
- **诊断**：`window.__dsew.orphans`（最近一次统计的 count/phase/error）、`__dsew.orphanActions`（最近 10 次动作）、`__dsew.orphanTabDormant`（tab 休眠=有意不注册）/ `orphanTabRegistered` / `orphanTabError`；宿主半 `GET /__esc-rewind/status` 带出 `orphans`（最近一次扫描结论）。

## 键盘捕获与防误触

- 监听 `document` **capture 阶段** keydown（在核心所有 bubble 阶段 Esc 关闭逻辑之前），但**硬门控**：仅当会话处于可回退状态、无弹层/菜单/dialog/输入补全打开、且焦点不在外来文本框时才拦截；任何不确定都放行（`Esc` 永远优先服务于“关闭弹层”）。
- armed 是**派生状态**而非记忆状态：running（可停止）或尾部为 `interrupted` assistant（已停）且草稿为空；自然完成的 settled 尾部永不 armed。
- 自动提示（工具栏 Stop 路径）**不读瞬态投影**：下降沿只记「候选回合」，由**宿主耐久证据**结算（尾部 `interrupted` 或该轮 `turn/end` 为 `aborted`/`user`）。原因见 `docs/knowledge/2026-09-08-dsh-esc-rewind.md` v7.2：运行中的 assistant 行在 `chat.legacy.nodes` 里不产出节点，下降沿那一帧的尾巴是本轮刚发出的 user 提问，用「尾部非 settled」判停止会在自然结束时误弹。
- 按会话隔离：切换会话即失效；诊断快照 `window.__dsew`（计数/最后门控/删除模式位，不含消息内容），其中 `hintToasts`/`lastHint` 专用于排查「提示为什么弹/没弹」。

## 版本要求

- **命令描述契约（0.1.5-rc.2 起）**：`CommandContribution.description` 由**字符串**改成 **`() => string`**（核心会调用它）；旧核心把值当 React 子节点渲染，函数会直接抛 `Functions are not valid as a React child`。两个契约无法用同一个值同时满足，所以本插件用**能力探测**（0.1.5 起才有的 `main.conversation` 槽位，或槽位新标准 props `usePanelInfo`/`useResource`，任一出现即判新契约）在**读取时**决定形态（`description` 写成 getter），**不读版本号**；结果见 `__dsew.commandDescShape`。
- **未落定输入守卫（0.1.5-rc.2 起）**：0.1.5 把 agent 收件箱写进事件日志（`agent/inbox/spliced`）并做成**耐久投影**（`inbox`），而 fork 用事件种子重建子会话，于是两处都会把旧输入带进新分支：①「父会话里刚发出、尚未落盘」的排队输入；②**被回退那条消息自己的插入事件**（它排在自身 `turn/start` 之前，而 fork 的切点正是那个 `turn/start`）。回退因此在两处清：fork 前 `settlePendingInputs(parent)`（宿主 `inbox` 投影 ∪ queue 镜像 ∪ 未对账本地回声，删掉并**等确认空**，清不掉则返回 `code:'pending-input'` 放弃本次回退），open 分支后 `settlePendingInputs(child)` 清掉继承项。诊断：`__dsew.pendingSource / childPendingSource / pendingCleared / childPendingCleared / pendingBlocked / pendingConfirmMs / childPendingConfirmMs / inboxProjectionSeen`。
- **还原时机的确定性（0.1.5-rc.2 起暴露）**：还原必须在切换分支（0.2.0 起 `uiWorkspace.openSession`，0.1.x 为 `sessions.open`）**之前**武装（切换会立刻触发 React 提交，子会话的桥先挂载，那一刻读到的 `__pending` 还是 null；旧实现在 open 之后、且在一次可能 sleep 的 await 之后才武装 ⇒ 真机「回退后文字没回到输入框」）。另外挂载 effect 只按 `[sessionId, draft, inputActions]` 重跑，武装晚到时不会补跑 ⇒ 补了模块级武装通知（同 `__toastListeners` 套路）让已挂载的桥补跑一次；「一次回退只回填一次」用「已回填的会话 id」表达，而不是一次性布尔 ref（旧写法会让同页第二次回退永不回填）。诊断：`__dsew.pendingStaged / pendingApplied / pendingLateArm / pendingDropped`。

- **最低**：核心 ≥ **0.1.2-rc.1**（本插件一直支持的世代）。缺能力时一律**降级而不是报错**，且把探测结果写进 `window.__dsew`。
- **0.2.0 设置模型变更**：`settings.installSection` 退役，命名空间钉在**条目 id**（其它 ns 抛 `No configurable plugin entry`）。同一份代码两代都可用：0.1.x 走 installSection，0.2.0 走导出的 `Config`；`/status` 的 `settingsSource` 写明命中的是哪一种，`settingsSectionRegistered` 在 0.2.0 下同样为 true。
- **0.2.0 归档契约变更**：`workspaces.archiveSession(id, options?)` 返回 `RemoteResult`（`{ok:false,error}`）**而不抛异常**，所以「只 catch 不查返回值」= 归档没发生却当成功（真机症状：回退后原会话仍在列表里、删除模式也没删）。同时它对**仍有运行中工作**的会话默认拒绝（`WorkspaceActiveSessionError` → `workspace/session-active`），需 `{ stopActivity: true }` 才「停止并归档」——与核心「归档会话」确认框同款。本插件的 `archiveOldSession` 桥接：先普通归档，命中「仍活跃」才补一次 stopActivity，其余拒绝如实进诊断并 toast。
- **0.2.0 会话切换动词迁移（真机红字 "sessions.open is not a function" 的根因）**：`sessions` 面**不再有 `open`**（只剩 binding/fork/create/scope/search/retain/using），切换会话改为 `uiWorkspace.openSession(target)`（`target = sessionId | 子代理地址`，「点列表切会话」那一个导航动作）。插件的 `openSessionInUi` 按能力探测两个世代（uiWorkspace 优先、`sessions.open` 回退），**都缺就放弃本次回退**：原会话不归档/不删除、撤掉已武装的还原与草稿，提示 `rewind.open.fail`，诊断 `__dsew.openFail`。
- **核心 ≥ 0.1.5-rc.2**：核心把「图片草稿」泛化为「附件草稿」并改名——`conversation.createDraftImages(files)` → `createDrafts(sessionId, files)`、`releaseDraftImage(id)` → `releaseDraftAttachment(id)`、`inputActions.addImages(ids)` → `addAttachments(ids)`。本插件**不读版本号**，按能力探测优先新名、回退旧名，两代同一份代码都可用；探测结果见 `__dsew.draftCreateApi` / `__dsew.draftRestoreApi`（`'createDrafts'` / `'createDraftImages'` / `null`）。
- 其余用到的核心面（槽位 `conversation.input.overlay` / `conversation.session.header.actions`、`sessions.binding|fork|create`、`uiWorkspace.openSession`、`workspaces.archiveSession`、`commandUi.register`、`remote.settings`、`chat.legacy.nodes` 与 `chat.timeline`、宿主 `turn/end` 的 `aborted`/`user` 与 `assistant/message.interrupted`）在 0.1.2-rc.1 → 0.1.5-rc.2 之间**逐项核对无变化**（审计方法与结论见 `docs/knowledge/2026-09-12-dsh-015-core-api-compat-audit.md`）。

## 安装 / 启停

本插件由仓库的**本地插件管理器**（`dsh-plugin-manager`）统一安装与启停，**不要**单独用 `dsh plugin add` 装它：

1. 只装管理器一次（仓库根就是它的安装外壳，两种入口等价）：
   ```bash
   dsh plugin --profile web add git+https://github.com/Chen5173/dsh-plugins.git
   # 或 dsh plugin --profile web add <本机仓库根>   # 本机开发：改代码即时生效
   ```
2. 重启 `dsh web`，打开设置 →「本地插件」。
3. 在面板里打开本插件的主开关：管理器自动把本包以 `link:<本插件目录>` 写进 profile `devDependencies`（按需跑 `pnpm install`），并写入激活行 `- insert: [{ id: esc-rewind, name: 'dsh-esc-rewind' }]`。profile patch 被 DSH **实时热重载**，宿主侧即时生效；本插件带界面，**刷新页面**后界面才进引导图。

- **停用**：面板里关掉主开关（行内写 `disabled: true`；行与依赖都保留，可随时再开）。
- **卸载**：面板里点「移除」（删激活行 + 摘 devDependency；**仓库里的源码目录保留**，可随时再启用）。

### ⚠️ 不要用 `dsh plugin add` 装/卸本子插件

- **装**：本子插件包不声明 `dsh.bundle`，`dsh plugin --profile web add <本子插件目录或包名>` 只会把它装成 profile 的普通依赖并打印 `declares no dsh.bundle — installed as a plain dependency, not a profile layer`，**不会激活它**。激活一律走管理器面板。
- **卸**：`dsh plugin --profile web remove <本子插件包名>` 只摘依赖、**不会删除管理器写的激活行**——残留的悬空行会让下次 `dsh web` 启动直接失败（`failed to import loader entry <id> (<name>): Cannot find package …`）。卸载请用面板「移除」。

**开发形态**：外部 client bundle 原样伺服，改 `src/client.js` 后**刷新页面**即可（`pnpm run dev:web` 时走 HMR）；**改 `src/index.js`（宿主半）后需重启 GUI host**。

## 开发 / 验证

```bash
node sub-plugins/dsh-esc-rewind/test/bundle.test.mjs   # 逻辑 harness（96 条，含删除模式、子代理守卫、子代理回收（扫描/停止/找回/面板；tab 已休眠）、提示时机、草稿附件双代桥接、命令描述契约、未落定输入三来源与还原时序用例）
node --check sub-plugins/dsh-esc-rewind/src/client.js
node --check sub-plugins/dsh-esc-rewind/src/index.js
```

浏览器手测见 `ACCEPTANCE.md`。
