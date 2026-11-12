# dsh-notify-hub 通知示例脚本

DSH 停下来（一轮结束 / 等你批准 / 等你回答）时，插件会调用你在规则里配的**本地脚本**。
这里的脚本都是「拿起来就能用」的参考实现：第一行 print/echo 就是给你看的执行结果，失败时退出码非 0（插件执行历史里能直接看到）。

## 脚本收到的契约

插件每次触发都会给脚本两样东西，示例全部按这个契约写：

```jsonc
// 标准输入：一行 UTF-8 JSON
{
  "sessionId": "...",
  "sessionTitle": "会话标题",
  "cwd": "/abs/path",
  "reason": "turn-end",        // turn-end | approval | question
  "reasonDetail": "completed", // 仅 turn-end 有意义：completed/error/blocked/max-tokens/aborted:user；批准/提问时为 null
  "triggeredAt": "2026-09-20T12:34:56.789Z",
  "ruleId": "...",
  "ruleName": "..."
}
```

```bash
# 环境变量（插件已设置好；适合在「参数」里 $(...)/%VAR% 不方便的场合）
NOTIFY_HUB_SESSION_ID   # 会话 id
NOTIFY_HUB_RULE_ID      # 规则 id
NOTIFY_HUB_CWD          # 会话工作目录
NOTIFY_HUB_REASON       # turn-end | approval | question
NOTIFY_HUB_DETAIL       # 同上 reasonDetail
NOTIFY_HUB_TIME         # ISO 8601 触发时刻
```

另外：插件会把工作目录切到规则配置的「工作目录」（没配就是会话目录），所以脚本里的相对路径可以直接用；脚本默认 30 秒超时，超时会被杀掉 —— **所有示例的网络调用都是 5 秒超时，不会卡住**。

## `private/` 目录（刻意不入库）

`examples/private/` 是留给**不需要提交**的脚本的：公司内网接口的脚本、带你个人配置的脚本、临时改的版本，都可以放这儿。该目录已被仓库 `.gitignore` 忽略（规则 `**/examples/private/`），放进去的东西不会进 git。

⚠️ 因此：**新克隆的仓库里没有 `private/` 下的脚本**。本 README 保留它们的用途与接口说明（端点、请求头、payload 形状都写在下面），照着自己写一份放进 `private/` 即可，或把任意示例复制进去改。当前放在 `private/` 的是：

| 文件 | 说明 |
| --- | --- |
| `private/notify-popo.py` | 只发 POPO（公司内网 notify 服务） |
| `private/notify-mail.py` | 只发邮件（同一接口） |
| `private/notify-popo-mail.py` | 上面两个合一，默认两个渠道都发 |

`notify-router.py` 会在 `examples/` 与 `examples/private/` **两处**找渠道脚本，所以你把这些脚本放哪边都能被路由到。

## 每个示例做什么

| 示例文件 | 做什么 | 需要什么变量 | 可选变量 |
| --- | --- | --- | --- |
| `notify-macos.sh` | macOS 本机：系统提示音（`afplay`）+ 原生桌面通知（`osascript`）；没有 osascript 就只响铃 | 无 | `NOTIFY_HUB_SOUND`（默认 Glass.aiff，也可只写名字如 Tink / Sosumi）、`NOTIFY_HUB_SOUND_REPEAT`、`NOTIFY_HUB_TITLE` |
| `notify-windows.ps1` | Windows 本机：Win10/11 原生 Toast（WinRT）+ 可选提示音；Toast 不可用时依次退到气泡通知、`msg` | 无 | `NOTIFY_HUB_BEEP=0` 关声音、`NOTIFY_HUB_TITLE` |
| `notify-bark.py` | 手机推送（iOS，Bark）：POST 到 Bark 的路径式接口 | `BARK_KEY` | `BARK_BASE`（默认 https://api.day.app）、`BARK_SOUND`、`BARK_GROUP`、`BARK_LEVEL`、`BARK_ICON` |
| `notify-ntfy.sh` | ntfy 推送（安卓/iOS/桌面都能收，也可自建） | `NTFY_TOPIC` | `NTFY_BASE`（默认 https://ntfy.sh）、`NTFY_TOKEN`、`NTFY_PRIORITY`、`NTFY_TAGS` |
| `notify-webhook.sh` | 一个脚本覆盖 5 家聊天机器人：飞书 / 企业微信 / 钉钉 / Telegram / Slack（按每家要求的 JSON 分别拼） | `WEBHOOK_KIND` + `WEBHOOK_URL`；telegram 用 `TELEGRAM_BOT_TOKEN`+`TELEGRAM_CHAT_ID` | `FEISHU_WEBHOOK_URL` / `WECOM_WEBHOOK_URL` / `DINGTALK_WEBHOOK_URL` / `SLACK_WEBHOOK_URL` |
| `private/notify-popo.py` | **网易 POPO**（公司内网 notify 服务，办公网 / 内网两套地址） | `POPO_ACCESS_KEY`、`POPO_RECEIVER` | `POPO_BASE`、`POPO_SENDER` |
| `private/notify-mail.py` | **只发邮件**（同一个 notify 接口；支持抄送/密送、HTML 正文、附件） | `NOTIFY_ACCESS_KEY`、`MAIL_RECEIVER` | `NOTIFY_BASE`/`MAIL_BASE`、`MAIL_CC`/`MAIL_BCC`、`MAIL_SUBJECT_PREFIX`、`MAIL_IS_HTML`、`MAIL_ATTACHMENT`、`MAIL_SENDER` |
| `private/notify-popo-mail.py` | **网易 POPO + 邮件** 二合一 —— ⚠️ **默认两个渠道都发**；想只用其中一个请直接用上面两个单渠道脚本（或加 `--only mail` / `--only popo`） | `NOTIFY_ACCESS_KEY` + `POPO_RECEIVER` / `MAIL_RECEIVER`（至少配一个） | `NOTIFY_BASE`（切内网）、`POPO_BASE` / `MAIL_BASE`、`POPO_AT_ALL` / `POPO_AT_LIST`、`MAIL_CC` / `MAIL_BCC`、`MAIL_SUBJECT_PREFIX`、`MAIL_IS_HTML`、`MAIL_ATTACHMENT`、`POPO_SENDER` / `MAIL_SENDER` |
| `notify-router.py` | 调度器：按 `reason` 换语气（等待批准=⚠️+响 3 声、等待回答=🙋+响 2 声、一轮结束=安静）并把消息分发给上面任意几个渠道 | 无（默认只跑本机桌面） | `ROUTER_CHANNELS`、`ROUTER_CHANNELS_APPROVAL` / `ROUTER_CHANNELS_QUESTION` / `ROUTER_CHANNELS_TURN_END` |

**POPO 的两个地址**（`POPO_BASE`，默认走办公网）：

```
办公网（默认）: http://notify.nie.netease.com/api/v1/messages
内网          : http://int.notify.nie.netease.com/api/v1/messages
```

请求头 `X-Notify-AccessKey: <POPO_ACCESS_KEY>`，请求体：

```json
{"message_type":"popo","sender":"sanotify@mesg.corp.netease.com","receiver_list":["zhangsan@corp.netease.com"],"content":"..."}
```

`POPO_RECEIVER` 支持单个或多个（逗号分隔），三种写法：邮箱 `zhangsan@corp.netease.com`、协议号 `auth_user:zhangsan`、群号（纯数字）。收件人写错（占位符、缺域的裸名字）**脚本会在本地就拒绝**，不会再让服务端回一句难懂的 `reciever_list is needed`。

**变量名对照**（别在这里踩坑）：

| 变量 | `private/notify-popo.py` | `private/notify-popo-mail.py` |
| --- | --- | --- |
| 密钥 | `POPO_ACCESS_KEY` / `NOTIFY_ACCESS_KEY`（都认） | `NOTIFY_ACCESS_KEY` / `POPO_ACCESS_KEY` / `MAIL_ACCESS_KEY`（都认） |
| POPO 收件人 | `POPO_RECEIVER` | `POPO_RECEIVER` |
| 邮件收件人 | — | `MAIL_RECEIVER` |

**手动在终端里跑**（用插件跑时不需要 —— 插件的全局环境变量会自动注入）：

```bash
export POPO_ACCESS_KEY=你的密钥
export POPO_RECEIVER=you@corp.netease.com
python3.11 <示例目录>/notify-popo.py            # 或 --access-key / --receiver 直接传
```

### 该用哪个脚本？

| 你想发什么 | 用哪个 |
| --- | --- |
| 只发 POPO | `private/notify-popo.py` |
| **只发邮件** | `private/notify-mail.py` |
| 两个都要 | `private/notify-popo-mail.py`（默认两个都发，也可 `--only mail` / `--only popo` 挑一个） |

### 一次配齐 POPO + 邮件：`private/notify-popo-mail.py`

> ⚠️ **这个脚本默认「两个渠道都发」**：只要 `POPO_RECEIVER` 和 `MAIL_RECEIVER` 都有值，它就会既发 POPO 又发邮件。
> 所以**关掉「popo通知」那条规则并不能阻止 POPO** —— 如果你的「邮件通知」规则跑的是这个脚本，它照样会发 POPO。
> 想只发一个渠道：在规则的「**参数**」里加一行 `--only mail`（或 `--only popo`），或把全局变量里不需要的那个收件人删掉。
> 每次执行的第一行都会打印 `渠道：popo + mail`，执行历史里一眼可见。

两个渠道走的是**同一个** notify 接口，只是 `message_type` 不同，所以合成一个脚本更省事：

```bash
# 环境变量（最小配置：密钥 + 至少一个收件人）
export NOTIFY_ACCESS_KEY=your_access_key
export POPO_RECEIVER=you@corp.netease.com          # 可写 auth_user:yourname 或 群号
export MAIL_RECEIVER=you@corp.netease.com         # 邮件；不要用 gmail
# 内网机器把地址切过去
export NOTIFY_BASE=http://int.notify.nie.netease.com/api/v1/messages
dsh ...
```

```bash
./private/notify-popo-mail.py --dry-run          # 打印将要发送的两条 JSON（密钥打码），先看一眼
./private/notify-popo-mail.py --only mail        # 只发邮件
./private/notify-popo-mail.py --only popo        # 只发 POPO
./private/notify-popo-mail.py --batch            # 上面两条合成一次请求（接口支持数组体）
./private/notify-popo-mail.py --attach ./build.log --only mail   # 带附件（超 5M 会被拒绝）
```

邮件主题默认是 `[DSH] <短标签> · <会话标题>`（例如 `[DSH] 等你批准 · 部署预发环境`），前缀可用 `MAIL_SUBJECT_PREFIX` 改；`--subject` 可直接覆盖。

> ⚠️ **实测的字段名坑（2026-09-20，本机复现）**：线上这个 notify 部署实际校验的是**拼错的字段名 `reciever_list`**，而官方参考实现与文档写的是 `receiver_list`。只发正确拼写会**稳定**拿到 `HTTP 400 reciever_list is needed`（它自己的报错信息也是这么拼的，等于把答案写在脸上了）。本仓库的示例脚本**两个字段名都发**，所以两种部署都能用——但你自己写脚本、或改别的工具调这个接口时，要注意这个拼写差异；邮件与 POPO 两个 `message_type` 都受影响。

**官方参考实现里的坑，脚本已按此实现**：邮件与 POPO 发出后**都无法撤回**；邮件正文+附件合计别超 **5M**（超了平台不写日志、超 20M 发不出去）；**不能给 gmail 发**；POPO **不能同时往群里和个人发**（脚本检测到混合收件人会告警，请分两次）；`auth_user` 收件人需对方已绑定 POPO 号；**易信 2024 年已下线**、**电话（phone）接口 2026-09-08 起不再支持**，本脚本不使用它们。

## 填进规则表单的对照表

设置 → 空闲通知 → 新增规则，字段对照如下（`<示例目录>` 换成你机器上的绝对路径，别用相对路径）：

| 示例文件 | 命令（绝对路径） | 参数 | 解释器 | 工作目录 |
| --- | --- | --- | --- | --- |
| notify-macos.sh | `<示例目录>/notify-macos.sh` | 留空 | 留空 | 留空 |
| notify-windows.ps1 | `<示例目录>/notify-windows.ps1` | 留空 | 留空 | 留空 |
| notify-bark.py | `<示例目录>/notify-bark.py` | 留空（或 `--key` 你的 key） | 留空 | 留空 |
| notify-ntfy.sh | `<示例目录>/notify-ntfy.sh` | 留空（或 `--topic` 你的主题） | 留空 | 留空 |
| notify-webhook.sh | `<示例目录>/notify-webhook.sh` | `--url=https://...`（可再加 `--kind=wecom`） | 留空 | 留空 |
| private/notify-popo.py | `<示例目录>/private/notify-popo.py` | `--receiver` `you@corp.netease.com` | 留空 | 留空 |
| private/notify-popo-mail.py | `<示例目录>/private/notify-popo-mail.py` | 留空（或 `--only` `mail`） | 留空 | 留空 |
| notify-router.py | `<示例目录>/notify-router.py` | `--channels` `macos,popo` | 留空 | 留空 |

- **解释器留空**：插件按扩展名自动选（`.sh`→bash、`.py`→python3、`.ps1`→powershell），只有想指定别的解释器时才填。
- **工作目录留空**：留空就用触发它的会话目录；脚本自己会在消息里带上真正的项目路径。
- **触发条件**：按需勾选「一轮结束 / 等待批准 / 等待回答」；不勾的不会触发这条规则。
- 「参数」是数组，一行一个，别把多个参数挤在一行里。

## 变量怎么给（四种，按需选）

**（a）直接写在插件的环境变量框里**（最省事，推荐）

设置 → 空闲通知 顶部有一张**全局环境变量**表（所有规则共用），每条规则的表单里也有同样一张（同名可覆盖全局）。表格一行一个变量：

```
NOTIFY_ACCESS_KEY=your_access_key
POPO_RECEIVER=you@corp.netease.com
MAIL_RECEIVER=you@corp.netease.com
```

值会明文落在 `<DSH_HOME 或 ~/.dsh>/settings.yaml`；变量**名**会记进执行历史，变量**值**不会。

**（b）启动 dsh 前 export**（不落盘，最安全）

```bash
export POPO_ACCESS_KEY=your_access_key
export POPO_RECEIVER=you@corp.netease.com
export BARK_KEY=your_bark_key
dsh ...            # 必须在同一个终端里启动 dsh，否则读不到
```

**（c）直接写在规则的「参数」里**（配置里是明文，注意别把配置同步到公开地方）

```
命令:   /Users/you/projects/dsh-plugins/dsh-notify-hub/examples/private/notify-popo.py
参数:   --access-key
        your_access_key
        --receiver
        you@corp.netease.com
```

同样的写法适用于 `notify-webhook.sh --url=https://open.feishu.cn/open-apis/bot/v2/hook/xxx`、`notify-bark.py --key your_bark_key`、`notify-ntfy.sh --topic your_long_random_topic`。

**（d）直接写进脚本**（本地自己用，风险自负）

```bash
# notify-macos.sh 顶部之类的位置，改成
POPO_ACCESS_KEY="your_access_key"   # 只在你自己的机器上、被 git 忽略的副本里这么干
```

## 注意事项

- **macOS**：第一次发通知系统会弹「允许通知」，要点允许；不点就只剩提示音。`DISPLAY`/图形会话不在时（比如 ssh 里）桌面通知会静默失败，声音仍可用。
- **Windows**：Toast 需要**交互式登录会话**（人在桌面登录状态）才显示；远程无人登录、计划任务/服务里跑不会弹，脚本会自动退到气泡通知或 `msg`。中文靠 UTF-8 字节解码，不会乱码。
- **⚠️ Windows 脚本必须存成「UTF-8 **带 BOM**」**：规则默认用系统自带的 **Windows PowerShell 5.1**，它读**无 BOM** 的 `.ps1` 时按**系统 ANSI 代码页**（简中机器 = GBK）解码 —— 脚本里的中文注释会变成乱码并撑坏引号配对，于是**连纯 ASCII 的行都开始报错**：`ParserError … UnexpectedToken`（实测在 `notify-windows.ps1` 上表现为「`}` 是意外的标记」「`catch` 后面必须跟一个 catch 块」这类指向无害行的报错）。**自己另存/复制脚本时务必保留 BOM**；仓库里由 `test/host-core.test.mjs` 的编码护栏守着（`examples/*.ps1` 必须前三字节是 `EF BB BF`）。
- **超时**：插件按规则的「超时秒数」（默认 30 秒）杀掉脚本。所有示例的网络调用都限 5 秒（`curl --max-time 5` / `urllib timeout=5`），`notify-router.py` 单渠道 8 秒、总预算 20 秒。自己改代码时别加同步等待。
- **不阻塞**：脚本永远不要在 stdin 上等人输入 —— 终端里直接手跑时，示例都会跳过 stdin 读取。
- **试跑**：规则列表里有「试跑」按钮；命令行上也都可以 `--dry-run`（`notify-windows.ps1 -DryRun`），只打印将要发送的 URL/JSON，不真发。第一次配好规则建议先 dry-run 看一眼。
- 失败会以非 0 退出码结束并在 stderr 写明原因，插件连续失败会自动停用规则并标红 —— 所以**别把真实 token 硬编码到会提交到仓库的脚本里**。

## 依赖

bash + curl + python3（`notify-bark.py` / `private/notify-popo.py` / `notify-router.py` 只用标准库，无第三方包）+ Windows PowerShell 5.1。macOS 上 python3 来自 Xcode Command Line Tools；`notify-macos.sh` 在完全没有 python3 的环境里也能跑（用 grep/sed 兜底解析 stdin）。
