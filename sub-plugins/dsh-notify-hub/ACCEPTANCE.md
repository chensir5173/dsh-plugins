# dsh-notify-hub — ACCEPTANCE

验收对象：`dsh-notify-hub`（设置 → 本地插件 → 「通知中心」tab + 宿主半触发器与投递器：本机脚本 / 内置 SMTP 邮件）。
证据约定：`[A]` = 自动化断言（`node sub-plugins/dsh-notify-hub/test/*.test.mjs`），`[B]` = 需要在浏览器/真机上用眼睛和手验。

> 2026-11 由 `dsh-idle-hook` 改名而来（新增内置 SMTP 邮件通道）。迁移行为见 README「从 dsh-idle-hook 升级」。

## 0. 前置

- [x] 0.1 [A] `node sub-plugins/dsh-notify-hub/test/host-core.test.mjs` 全绿（**58 passed + 4 skipped**，skip 是需要真子进程的用例，DSH 沙箱 `spawn EPERM` 所致，普通终端下会真正执行）——触发矩阵、解释器映射、参数/占位符/工作目录、上下文与隐私边界、presence 三档、去抖、失败计数、历史滚动、**邮件纯函数**（默认值/预设/地址解析/校验/密码来源/MIME 编码/错误分类）
- [x] 0.2 [A] `node sub-plugins/dsh-notify-hub/test/smtp.test.mjs` 全绿（**10 项**）——SMTP 全流程离线验证：命令顺序、多收件人、AUTH LOGIN 两步 / AUTH PLAIN 同行凭据、无账号时不 AUTH、`passEnv` 解析、535 认证失败、550 收件人被拒、ECONNREFUSED、静默服务器超时、空收件人不发任何命令
- [x] 0.3 [A] `node sub-plugins/dsh-notify-hub/test/bundle.test.mjs` 全绿（**24 passed + 1 skipped**）——bundle id、`settings.localPlugins.tab` 注册（id/order/label「通知中心」）、规则渲染、总开关写入、规则保存、试跑、**邮件表单渲染与 `channel=email` 落盘**、**`/test-email` 投递 + 脱敏授权码回填**、心跳、历史面板、宿主半零 core import 护栏、两个瀑布 prepend + `return next()`
- [x] 0.4 [A] `node --check sub-plugins/dsh-notify-hub/src/{index,client,host-core,smtp}.js` 无语法错误
- [x] 0.5 [A] `grep -c "from '@deepseek-ai/" sub-plugins/dsh-notify-hub/src/index.js` 为 0（宿主半零 core import 铁律）；`src/smtp.js` 只 import `node:net` / `node:tls` / `./host-core.js`
- [x] 0.6 [A] `openspec validate rename-idle-hook-and-add-email-channel --strict` 通过（旧变更 `add-dsh-idle-hook` 仍可通过）
- [x] 0.7 [A] 子插件合规（2026-09-10 起的仓库规则）：`sub-plugins/dsh-notify-hub/package.json` **不声明 `dsh.bundle`**、目录内**无** `cordis.patch.yml`；`node dsh-plugin-manager/test/root-install-shell.test.mjs` 通过

## 1. 安装与界面出现

- [ ] 1.1 [B] 设置 → 本地插件 里启用 `dsh-notify-hub`；面板提示需要刷新页面
- [ ] 1.2 [B] 刷新页面后，设置 → 本地插件 里出现「通知中心」tab（与核心自带 tab 并列；设置左侧导航不再单独占一行）
- [ ] 1.3 [B] 首次打开时已预置**一条禁用**的示例规则（macOS 提示音 / Windows 通知），且此时没有任何进程被拉起、没有任何邮件发出
- [ ] 1.4 [B] 顶部「页面状态」显示「页面在线（已聚焦）」；切走标签页后刷新设置为「（页面不可见）」

## 2. 一轮结束触发

- [ ] 2.1 [B] 配一条规则（命令指向 `examples/notify-macos.sh`，触发条件勾「一轮结束」，触发前提「任意」），发一条会让模型正常跑完的消息 → 收到一次通知
- [ ] 2.2 [B] 空闲等待 1 分钟不做任何操作 → **不重复**收到通知（边沿语义）
- [ ] 2.3 [B] 生成中点 Stop 自己停 → **不触发**（自己按的停止不响）
- [ ] 2.4 [B] 让模型报错/超限停下（例如让它跑一个必定失败的脚本） → 触发，且历史里的 `reasonDetail` 是 `error`/`max-tokens` 而非 `completed`
- [ ] 2.5 [B] 在会话 A 里排队两条消息，让它连着跑完两轮 → 只有**全程结束**后触发一次，不是每轮各响一次
- [ ] 2.6 [B] 同时让三个会话各自停下 → 触发三次，历史里三条各自带不同 sessionId

## 3. 等待人类

- [ ] 3.1 [B] 触发一次需要批准的工具调用（如 bash 写文件，approval 设为 ask） → 弹出批准时**收到通知**，且批准按钮照常可用、结果与未装插件时一致
- [ ] 3.2 [B] 模型提问等待回答时 → 收到通知，且回答照常送达模型
- [ ] 3.3 [B] 把脚本换成一个 sleep 5 的脚本后再触发批准 → 通知在批准弹窗出现的同时就到，**批准不被延迟**
- [ ] 3.4 [B] 同一回合里连续批准两次（间隔超过去抖） → 收到两次通知
- [ ] 3.5 [B] **回归项（本次修的就是它）**：规则的触发前提用**任意**时，DSH 提问（等待回答）确实收到通知；旧版本用「仅页面关着」＋示例规则默认禁用，导致提问时永远收不到

## 4. 页面在场与互斥

- [ ] 4.1 [B] 规则触发前提设为**仅页面关着**，关掉浏览器页面后让一轮跑完 → **仍然触发**（这是本插件存在的理由）
- [ ] 4.2 [B] 同一条规则，在页面打开且聚焦时让一轮跑完 → **不触发**
- [ ] 4.3 [B] 触发前提设为**仅页面不可见或失焦**，把浏览器切到别的标签/别的窗口 → 触发；切回来聚焦 → 不触发
- [ ] 4.4 [B] 同时开着 `dsh-notification`：页面关着时只有本插件响；页面开着时只有浏览器原生通知响（不重复打扰）

## 5. 脚本契约

- [ ] 5.1 [B] `.py` 规则在 macOS 上由 `python3` 跑起来，脚本里读到 stdin 的 `sessionTitle` 是中文且未乱码
- [ ] 5.2 [B] `.sh` 规则、无扩展名可执行文件、显式解释器覆盖三条各试跑一次，均按预期启动
- [ ] 5.3 [B] 命令路径里带空格（如 `/tmp/my scripts/notify.sh`），不经 shell 也正确启动
- [ ] 5.4 [B] 参数里用 `{cwd}`/`{reason}` → 脚本收到本次触发的真实值
- [ ] 5.5 [B] 规则的「工作目录」留空时脚本在会话的工作目录下执行（脚本 `pwd` 打日志验证）
- [ ] 5.6 [B] 脚本里打印 `$NOTIFY_HUB_REASON` 与 stdin JSON，确认**没有**任何对话正文
- [ ] 5.7 [B] 打开「用 shell 执行整条命令」后，一行命令型规则也能跑
- [ ] 5.8 [B] 在**全局环境变量**框里配 `NOTIFY_ACCESS_KEY=...`（脚本里 echo 出来打日志）→ 两条规则都能读到
- [ ] 5.9 [B] 在**某条规则**的环境变量框里配同名键 → 该规则读到规则值，另一条规则仍读到全局值
- [ ] 5.10 [B] 环境变量里配 `NOTIFY_HUB_REASON=fake` → 保存时出现「已忽略」提示，且脚本读到的仍是真实原因
- [ ] 5.11 [B] 写一行缺等号的变量（如 `BROKEN`）→ 保存被拒并说明原因；改成 `BROKEN=1` 后可保存
- [ ] 5.12 [B] 变量值用 `PROJECT_DIR={cwd}` → 脚本读到的是本次会话的工作目录
- [ ] 5.13 [B] 触发一次后打开执行历史：能看到注入的变量名，看不到变量值
- [ ] 5.14 [B] **旧脚本兼容**：一个仍然只读 `IDLE_HOOK_REASON` 的老脚本，触发后仍能拿到真实原因（双注入保留一个版本周期）

## 6. 生命周期与失败

- [ ] 6.1 [B] 超时设为 3 秒、脚本 sleep 10 → 进程被杀死，历史记为**超时**
- [ ] 6.2 [B] 脚本 sleep 5、连续触发两次 → 第二次记为**已跳过**，不会有两个实例同时在跑
- [ ] 6.3 [B] 命令指向不存在的文件，触发三次 → 规则被**自动停用并标红**，点「重新启用并清零」后计数归零
- [ ] 6.4 [B] 「试跑」连续失败三次 → **不会**导致规则被自动停用（试跑不计入失败计数）
- [ ] 6.5 [B] 关闭总开关后触发任意状态 → 不执行任何脚本、不发任何邮件、不写新历史，规则与旧历史仍在

## 7. 持久化与降级

- [ ] 7.1 [B] 新建/编辑/删除规则后重启 DSH，规则与内容保持不变
- [ ] 7.2 [B] 历史超过 200 条后仍只保留最近 200 条，重启后仍在
- [ ] 7.3 [B] 手工编辑 profile `cordis.patch.yml` 里 `- id: notify-hub` 条目的 `config:` 段（改命令路径），刷新页面后界面显示新值
- [ ] 7.4 [B] 以没有 Web 界面的 profile 启动（如终端 profile）→ 宿主半正常加载，状态触发照常（视作页面关着），无加载错误
- [ ] 7.5 [B] 模型侧工具集合与未安装本插件时**完全一致**（本插件不注册任何工具）
- [ ] 7.6 [B] 邮件规则同样受「并发跳过 / 超时 / 连续失败 3 次自动停用」约束

## 8. 需要你在 Windows 上验（我在 macOS 上验不了）

- [ ] 8.1 `[B] Windows` `.bat`/`.cmd` 规则经 `cmd /c` 正确启动
- [ ] 8.2 `[B] Windows` `.ps1` 规则经 PowerShell 启动并弹出通知（任务栏通知需交互式登录会话）
- [ ] 8.3 `[B] Windows` 环境变量的中文/编码：脚本从 stdin 读到中文标题不乱码
- [ ] 8.4 `[B] Windows` 超时被杀（`taskkill` 语义）与「已跳过」在 Windows 上同样生效

## 9. 其它真机检查

- [ ] 9.1 [B] 长回合里模型频繁停下又继续时，通知不会刷屏（去抖 + 边沿语义共同作用）
- [ ] 9.2 [B] 停用插件后宿主半立即停止触发（无需重启）；刷新页面后界面消失

## 10. 0.2.0 设置路线（entry-config）

0.2.0 退役了 `settings.installSection`，命名空间改为「profile 条目 id」并投影条目自身导出的 `Config`；命中时 `/status` 的 `settings.source === 'entry-config'`。

- [ ] 10.1 [B] 0.2.0：设置 → 本地插件 →「通知中心」**不再出现红框** `No configurable plugin entry "notify-hub"`；顶部不再显示「设置服务不可用」；`GET /__notify-hub/status` 的 `settings.ready === true` 且 `settings.source === 'entry-config'`
- [ ] 10.2 [B] 0.2.0：面板里新增/编辑一条规则 → 保存 → 刷新页面规则仍在；profile `cordis.patch.yml` 的 `- id: notify-hub` 行出现 `config:`（含 `rules`），写入后该条目重启一次（状态端点短暂 5xx 属正常）
- [ ] 10.3 [B] 0.1.x 回归：`settings.source === 'section'`，规则落在 `settings.yaml` 的 `notify-hub:` 段，面板行为不变

## 11. 邮件通道（本次新增）

- [ ] 11.1 [B] 新建规则 → 发送方式选「邮件」→ 表单换成 SMTP 字段；选服务商预设（QQ/163/126/Gmail/Outlook）→ 服务器与端口自动填好，SSL 开关随预设变化
- [ ] 11.2 [B] 填账号 + 授权码 + 收件人 → 点「发送测试邮件」→ 邮箱收到邮件；**中文主题不乱码**（RFC 2047 编码）
- [ ] 11.3 [B] 授权码不直接填，改填「授权码环境变量名」并在全局环境变量里给出该变量 → 同样能发送
- [ ] 11.4 [B] 保存后刷新页面：授权码框显示「已配置（不回显）」，页面上**看不到明文**；只改主题/收件人再保存 → 授权码仍然可用（客户端从原始配置回填）
- [ ] 11.5 [B] `GET /__notify-hub/status` 的 `email.pass` 为空字符串、`email.passConfigured === true`（HTTP 边界脱敏）
- [ ] 11.6 [B] 故意把授权码改错 → 历史记为「认证失败，请检查邮箱授权码」
- [ ] 11.7 [B] 端口填错或断网 → 历史记为「连接邮件服务器失败」
- [ ] 11.8 [B] 收件人填多个（逗号/分号分隔，可带 `名字 <地址>`）→ 都收到，历史 note 显示「已投递至 a@x, b@y」
- [ ] 11.9 [B] 真实触发（一轮结束）→ 邮件到达；历史里该条通道记为 `email`，耗时与结果齐全
- [ ] 11.10 [B] 正文模板留空 → 保存后用默认模板（不会发出一封空邮件）；主题模板留空 → 用默认主题
- [ ] 11.11 [B] 自签证书服务器：勾上「跳过证书校验」后能发；不勾则历史报 TLS 握手失败
- [ ] 11.12 [B] 邮件规则连续失败 3 次 → 规则被自动停用（与脚本规则同一套计数）

## 12. 改名与迁移

- [ ] 12.1 [B] 从旧版本升级后，旧规则仍在（读不到 `notify-hub` 命名空间时回退读 `idle-hook`）
- [ ] 12.2 [B] 旧 `~/.dsh/idle-hook-history.json` 存在而新文件不存在时，启动后出现 `notify-hub-history.json`，历史条目可见，**旧文件仍在**
- [ ] 12.3 [B] 设置页标题、tab 名、端点全部为 notify-hub；旧端点 `/__idle-hook/status` 返回 404（不再保留）
- [ ] 12.4 [B] **profile 依赖键**：`<profile>/package.json` 的 `devDependencies` 里有 `dsh-notify-hub: link:./node_modules/dsh-plugin-manager/sub-plugins/dsh-notify-hub`（旧 `dsh-idle-hook` 键已删），且 `<profile>/node_modules/dsh-notify-hub` 链接指向新目录；启动日志不再出现 `Cannot find package 'dsh-notify-hub'`
- [ ] 12.4 [B] profile `cordis.patch.yml` 里两处（插入行与 config 行）都是 `id: notify-hub` / `name: dsh-notify-hub`，重启后不报 `Cannot find package`
