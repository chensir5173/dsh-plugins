# 验收清单 — dsh-composer-provider-label

代码侧的 61 条逻辑断言已由 `test/bundle.test.mjs` 自动覆盖并通过。本清单覆盖**只有装起来在浏览器里才能确认**的部分：真实安装、composer 布局、菜单交互、tooltip 观感、语言切换、三路即时更新、以及「写操作范围」的回归。

标 `[H]` 的条目 harness 已断言过，回归时抽查即可；标 `[B]` 的必须人眼看。

---

## 0. 前置

```bash
# 核心版本必须 >= 0.1.2-rc.1（session/modelCatalog 与 modelSelection 投影从该版本起存在）
dsh --version
```

版本不够时**预期表现是标签不出现**，不是报错——这是设计行为。

## 1. 安装与加载

安装一律走管理器面板（先装 `dsh-plugin-manager` 一次 → 重启 `dsh web` → 设置 →「本地插件」→ 打开本插件主开关）。**不要**用 `dsh plugin --profile web add` 装本子插件（不会激活，见 README 警示）。

```bash
dsh --dump-config --profile web | grep -n composer-provider-label   # 应看到一行
```

- [x] 1.1 `[B]` 装好管理器、重启后 `dsh web` 无报错、无插件加载失败提示（**重点**：确认 host 半对 `@deepseek-ai/schemastery` 的动态 import 失败时不会让整行加载失败——应只见标签、settings 段缺省）
- [x] 1.2 `[B]` 面板启用后：profile `devDependencies` 出现本插件的 `link:`、`dsh.profile.bundles` 里本地条目仍**只有 `dsh-plugin-manager`**
- [x] 1.3 `[B]` DevTools → Network 过滤 `/plugins/`，刷新页面后能看到本插件 bundle 返回 **200**
- [x] 1.4 `[B]` Console 无 `slot "conversation.input.right" is not declared`、无 `list slot ... already has an entry with id`
- [x] 1.5 在面板里把主开关**关→开**一次：profile `cordis.patch.yml` 里 `composer-provider-label` 行**始终只有一行**（不产生第二条），且开回后标签恢复

## 2. 入口可见性（spec：输入区显示当前生效路由的提供方）

- [x] 2.1 `[B]` 打开一个有会话的聊天 → composer 工具行出现 provider 标签，位置在**模型选择器左边一格**（`[+][模式]  …  [provider][DeepSeek-V4-Flash · high][上下文][发送]`），外观是与模型座位**同几何的胶囊 chip**：28px 高、24px 圆角、左右各 10px 内边距，四角圆润、文字不贴边（2026-09-13 用户确认）
- [x] 2.2 `[B]` 同一模型名挂在多家（ark/codemaker/…）时，分别选到不同 provider → 标签文字不同（`ARK` / `codemaker` / …）
- [x] 2.3 `[B]` 从没选过模型的新会话 → 标签显示 profile 默认路由的 provider
- [x] 2.4 `[B]` 空白/无会话欢迎态 → 无标签
- [x] 2.5 `[B]` 装了会用 `!important` 重绘 composer 按钮底色的皮肤（如 ice-princess）→ 标签与**相邻模型 chip 同色**（皮肤赢），四角圆润、无方角残留（2026-09-13 用户确认）
- [ ] 2.6 `[B]` 默认主题（无上述皮肤）下标签仍是深色 chip（`--dsw-alias-interactive-bg-hover-solid`），不是透明 —— 换皮肤/关皮肤时抽查一次即可

## 3. 名字与别名（spec：提供方名称的取值与改写规则）

- [x] 3.1 `[B]` 切到 `ark` 且其 displayName 为 `ARK (Coding Plan)` → 标签显示 `ARK`（括号已剪），悬停 tooltip 里能看到完整 `ARK (Coding Plan)`
- [x] 3.2 `[H]` 官方 `deepseek-official` → 标签 `office`（内置表）
- [ ] 3.3 `[B]` **仅当宿主半能解析到 schemastery 时**（非本地 `link:` 安装形态）：在 `settings.yaml` 或设置页给 `dsh-composer-provider-label.providerAliases` 写 `codemaker: cm` → 重启后切到 codemaker 显示 `cm`
- [ ] 3.4 `[B]` **仅当宿主半能解析到 schemastery 时**：把 `providerAliases` 里 `deepseek-official` 改成 `DeepSeek` → 官方标签变为 `DeepSeek`
  > 已知限制：本地 `link:` 安装形态下 settings 段不注册（`@deepseek-ai/schemastery` 不在仓库祖先链上），3.3/3.4 **预期看不到效果**，标签只用内置 `office`。这是宿主加载形态限制，不是配置错误。
- [x] 3.5 `[B]` 没有 displayName 也没有别名的 provider（如 codemaker 未配置时）→ 显示其 id
- [x] 3.6 `[B]` 设置页别名配置写坏（非字符串值）→ 标签仍显示，无报错（schema 拒绝，别名回退内置）

## 4. 即时更新（spec：标签随路由与配置即时更新）

- [x] 4.1 `[B]` 用核心模型选择器把当前会话从 ark 切到 codemaker → 标签**不刷新页面**即变
- [x] 4.2 `[B]` 从会话 A 切到路由不同的会话 B → 标签指向 B
- [x] 4.3 `[B]` 打开一个子代理会话 → 标签跟随其模型路由
- [x] 4.4 `[B]` 在设置页把 `ark` 的 displayName 从 `ARK (Coding Plan)` 改成 `火山方舟` → 不刷新页面，标签变 `火山方舟`（`settings/document-updated` 生效）
- [x] 4.5 `[B]` DevTools 触发宿主重连（`connection/reset`）→ 标签按新代际目录重解析，无旧名残留

## 5. tooltip 与无障碍（spec：悬停可核对完整路由信息）

- [x] 5.1 `[B]` 悬停标签 → tooltip 含：provider 完整名（未裁剪）、模型 id、路由来源
- [x] 5.2 `[B]` 来源文案三分支都对：刚切过模型=「本会话显式选择」；从没切过但发过消息=「沿用上一条请求」；新会话=「跟随 profile 默认」
- [x] 5.3 `[B]` 窗口压窄到标签出现省略号 → tooltip 仍是完整名
- [x] 5.4 `[B]` Tab 聚焦标签 → 读出 aria-label（如「模型提供方: office」）；tooltip 同样可读

## 6. 写操作范围（spec：写入范围限于模型选择）

```bash
S=~/.dsh/sessions/<slug>/<session-id>/session.jsonl.zstd
stat -c '%y %s' "$S"      # 记下 mtime 与大小
```

- [x] 6.1 `[B]` 只点击标签（开/关菜单、不选任何项）→ 该会话路由与记录文件 mtime/大小均不变
- [x] 6.2 `[H]` 能力审计已自动覆盖：`selectModel` 只有一个调用点，`updateQueue`/`prompt`/`rename`/`fork` 等一律不引用，也不写 settings（只 `describe()` 读）
- [x] 6.3 `[B]` 在菜单里切到另一个提供方/模型后再次 `stat -c '%y %s' "$S"` → 记录文件不因本插件被改写
- [x] 6.4 `[B]` 核心模型选择器的两级菜单、推理档切换、发送按钮均与未装本插件时一致；标签不遮挡它们

## 7. 语言与主题（spec：文案与外观跟随客户端设置）

- [x] 7.1 `[B]` 中文客户端 → aria 与 tooltip 字段为中文；英文客户端 → 对应英文（provider 名本身不翻译）
- [x] 7.2 `[B]` 切语言后**不刷新**再看 → 文案已变（locale/change 生效）
- [x] 7.3 `[B]` 深色 / 浅色主题各看一次标签与 tooltip → 无硬编码色、无对比度失效
- [x] 7.4 `[B]` 窄窗口 → provider 省略号截断，模型名与上下文表不被挤掉

## 8. 共存

- [x] 8.1 `[B]` 与 `dsh-composer-history-recall` 同开：输入框里 ↑ 召回历史照常工作，provider 标签照常显示，互不影响
- [x] 8.2 `[B]` 与 `dsh-open-session-workdir`、`dsh-session-title-regenerate` 同开：头部按钮/菜单项正常，composer 行无重叠
- [x] 8.3 `[B]` 若以后别的插件也注册 `conversation.input.right` → 按 order 排列不冲突（本插件 order 10）

## 10. 选择菜单与显示范围（本轮扩展：extend-composer-provider-picker）

- [ ] 10.1 `[B]` 点击标签 → 向上弹出菜单，根层三行「提供方 / 模型 / 推理档」，各显示当前值；只开菜单时路由不变
- [ ] 10.2 `[B]` 进入提供方层 → 顶部「‹ 返回」；下面按目录顺序列出提供方（别名 + 登记名），当前项打勾
- [ ] 10.3 `[B]` 某个 provider 的模型目录加载失败 → 该项置灰并显示失败原因；菜单顶部有「重试加载」且可点
- [ ] 10.4 `[B]` 点选另一个提供方 → 立即切换（当前模型不属于它时改用它的默认/第一个模型），菜单自动进入模型层
- [ ] 10.5 `[B]` 点选当前提供方 → 当前模型保持不变
- [ ] 10.6 `[B]` 当前模型的推理档在新模型仍支持时保留（tooltip 里的推理档随之变化），不支持时回到该 provider 默认
- [ ] 10.7 `[B]` 模型层「全部提供方」→ 按 provider 分组，组标题 = 别名 + 登记名；当前模型打勾
- [ ] 10.8 `[B]` 切到「仅当前提供方」→ 只列该 provider 的模型且无组标题；开关当前项打勾
- [ ] 10.9 `[B]` 刷新页面 / 切会话再回来 → 显示范围保持（localStorage `dsh.composer-provider-label.v1`）
- [ ] 10.10 `[B]` 「仅当前提供方」下该 provider 无模型 → 显示空态文案 + 「切回全部提供方」入口，点它能切回
- [ ] 10.11 `[B]` 选完模型 → 菜单关闭，标签与核心座位的模型名同步更新
- [ ] 10.12 `[B]` 写入过程中标签半透明（`aria-busy`）；把宿主/网络打断造成写入失败 → 标签出现错误点，tooltip 说明原因，路由不变
- [ ] 10.13 `[B]` 打开一个受地址的子代理会话 → 菜单可开，选择项禁用并提示「该会话不允许切换模型」
- [ ] 10.14 `[B]` Esc 关闭菜单、外部点击关闭菜单，两者都不改变路由
- [ ] 10.15 `[B]` 目录加载失败且路由已知 → 标签显示原始 id + 错误点，菜单里有「重试加载」
- [ ] 10.16 `[B]` 窄窗口下菜单不被 composer 卡片裁剪；卡片内容长时列表内部滚动、footer 开关常驻
- [ ] 10.17 `[B]` 模型很多（≥10 个）的提供方 → 菜单只显示约 5 行，首行与底部开关都在视口内，鼠标滚轮/触控板能滚到其余模型；换到模型少的提供方后菜单高度随之收缩
- [ ] 10.18 `[B]` 点根层第三行「推理档」→ 顶部「‹ 返回」；下面按目录顺序列出该模型广告的推理档（档名 + 目录里的说明），当前生效档打勾；点选某档 → 菜单关闭，提交 `provider + model + reasoningEffort`，tooltip 里的推理档随之改变
- [ ] 10.19 `[B]` 模型未声明默认档（目录里没有 `defaultEffort`）→ 推理档层首项是「提供方默认」；选中它 → 提交**不带** `reasoningEffort` 的完整组合（等价于让 host 用该模型自己的默认档），tooltip 的推理档回到模型默认
- [ ] 10.20 `[B]` 当前模型不支持推理档（目录里没有 `reasoning`）→ 根层第三行显示「不支持」，进入后只有一行灰色说明、没有可选项；英文客户端显示 `Unsupported` / `no reasoning tiers`
- [ ] 10.21 `[B]` 模型目录未就绪或模型条目未知 → 根层第三行显示「未知」，与 provider/模型行的既有降级一致，不出现报错

## 9. 回滚

```bash
# 在管理器面板里操作，不要用 dsh plugin remove（会留下悬空激活行）
# 方式 A：停用 —— 关掉本插件主开关（profile 行写 disabled: true，行保留）
# 方式 B：卸载 —— 点本插件行上的「移除」（删激活行 + 摘 devDependency；源码目录保留）
```

- [ ] 9.1 `[B]` 停用后（宿主侧即时生效，刷新页面）标签消失，无残留报错；再开回主开关标签恢复
- [ ] 9.2 插件不写会话数据 → 卸载后 `~/.dsh/sessions/` 下无本插件痕迹，且 profile 里无指向本包的悬空行；`settings.yaml` 里手写的 `dsh-composer-provider-label:` 段若存在则无害残留，可手动删除

---

## 全量场景对照

- v1（已归档）：`openspec/changes/archive/2026-09-09-add-composer-provider-label/`，能力规格见 `openspec/specs/composer-provider-label/spec.md`。
- 本轮扩展：`openspec/changes/archive/2026-09-09-extend-composer-provider-picker/specs/composer-provider-label/spec.md`（3 条 MODIFIED + 1 条 REMOVED + 5 条 ADDED）。
- 二级 → 三级（2026-10-14，推理档行）：菜单结构相关 requirement 已就地同步到 `openspec/specs/composer-provider-label/spec.md`（根层三行 + 推理档层 scenario），本轮新增 6 条断言（共 61 条），验收条目 10.1 与 10.18–10.21。

逐条走查完成后：

```bash
openspec validate extend-composer-provider-picker --strict
```
