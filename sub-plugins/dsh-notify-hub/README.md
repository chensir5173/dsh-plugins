# dsh-notify-hub

DSH 停下来的时候，把消息推到你真正会看到的地方——**本机脚本**或**你自己的邮箱**。

- **一轮结束**（跑完 / 报错 / 超过 token 上限 / 被拦截）→ 通知我
- **工具调用在等我批准** → 通知我
- **模型提问在等我回答** → 通知我

两种投递通道，每条规则各自选一种：

| 通道 | 做什么 | 适合 |
|---|---|---|
| **本机脚本** | 执行你给的 `python` / `bat` / `ps1` / `sh` / 任意可执行文件，怎么通知由脚本决定 | 系统提示音、手机推送、办公 IM、自建 webhook |
| **邮件（内置 SMTP）** | 插件自己连你的发件邮箱（授权码登录），把标题/正文发到你指定的收件箱 | 不在电脑前也要收到；不想再维护脚本 |

宿主半在 DSH 进程里监听，**浏览器页面关掉也照常触发**；邮件通道不需要任何外部依赖（`node:net` + `node:tls` 手写 SMTP）。

> 和已装的 `dsh-notification`（浏览器原生通知）的分工见「触发前提」与「与 dsh-notification 的关系」——两者可以并存而不重复打扰。

## 安装

推荐的方式（同仓库其它插件）：用 `dsh-plugin-manager` 在 **设置 → 本地插件** 里启用 `dsh-notify-hub`。

本插件是 `sub-plugins/` 下的子插件：**不声明 `dsh.bundle`、不带自己的 `cordis.patch.yml`**，激活行完全由管理器维护——因此不要用 `dsh plugin add <子插件目录>` 装卸它（见仓库根 README 的「⚠️ 子插件不要用 `dsh plugin` 装卸」）。

- 宿主半（监听 + 执行 + 发信）随 profile patch 热重载**立即生效**；
- 设置页入口「设置 → 本地插件 → 通知中心」（「本地插件」一级入口里的一个 tab）需要**刷新一次页面**才会出现（客户端界面只在页面加载时进出 `__DSH_BOOT__`）。

启用后打开 **设置 → 通知中心**：首次会预置一条**处于禁用状态**的示例规则（macOS 提示音 / Windows 通知），改好字段再启用。在你自己启用任何规则之前，插件不会执行任何东西，也不会发任何邮件。

## 触发语义

| 触发 | 什么时候 | 不触发 |
|---|---|---|
| 一轮结束 | `completed`（正常跑完）、`error`（报错）、`max-tokens`（超限）、`blocked`（被拦截） | **你自己按的停止**（`aborted:user`）、会话被销毁（`aborted:disposed`）、`interrupted`（修复标记，运行期不产生） |
| 等待批准 | 工具调用真的被交给人类批准时 | 由既有策略自动放行、从未询问人类的批准 |
| 等待回答 | 模型提问等待人类回答时 | — |

补充语义：

- **边沿触发**：每次「进入」该状态触发一次，停留在状态里不会周期性重复。
- **去抖**：同一规则 + 同一会话的两次触发之间至少间隔 `去抖秒数`（默认 3 秒，可配）。
- **多会话独立**：N 个会话同时停下来就触发 N 次，每次带自己的会话上下文。
- **子代理静默**：子代理（subagent）会话不触发——它的父回合还在跑，那不代表 DSH 停下来了。
- **确认真的停了**：一轮结束后会确认该智能体确实空闲且没有排队输入；如果 driver 紧接着又开了下一轮，就不通知。

### 触发前提：这条规则什么时候才发

| 档位 | 含义 |
|---|---|
| **任意**（推荐） | 只要触发就投递。**「模型在等我提问/批准」这种场景必须用这一档**——那时页面通常正开着 |
| 仅页面关着 | 客户端心跳停了 30 秒以上才投递（用来和 `dsh-notification` 分工） |
| 仅页面不可见或失焦 | 页面开着但在别的窗口/标签时才投递 |

「页面关着」= 客户端每 5 秒上报一次的可见性/聚焦心跳中断超过 30 秒；从未打开过页面（例如终端 profile）同样算「页面关着」。

## 通道一：本机脚本

### 怎么被调用

| 扩展名 | 用什么跑 |
|---|---|
| `.py` | `python3`（Windows 上是 `python`），带 `-u` |
| `.bat` / `.cmd` | `cmd /c` |
| `.ps1` | `powershell -NoProfile -ExecutionPolicy Bypass -File` |
| `.sh` / `.bash` | `bash` |
| `.js` / `.mjs` | 当前 DSH 进程用的那个 node |
| 其它（含 `.exe`、无扩展名可执行文件） | 直接运行 |

规则里的**「解释器」字段留空即可自动判断**；填了就覆盖上表。

- **参数按数组直传**，默认**不经过 shell**：路径里有空格、参数里有引号都会原样送达，也没有注入面。
- 参数与命令里可用占位符：`{sessionId}` `{cwd}` `{title}` `{reason}` `{detail}` `{rule}` `{time}`；`~` 会展开成主目录。
- **工作目录**：规则填了用它；留空用触发它的会话的工作目录。
- 需要「一行命令」时，打开规则里的 **用 shell 执行整条命令**（应急开关，默认关）。

### 脚本拿到什么

**标准输入**：一份 UTF-8 JSON，写完即关闭。

```json
{
  "sessionId": "session-…",
  "sessionTitle": "修复登录跳转",
  "cwd": "/Users/you/project",
  "reason": "turn-end",
  "reasonDetail": "completed",
  "triggeredAt": "2026-09-20T12:34:56.789Z",
  "ruleId": "rule-…",
  "ruleName": "空闲提醒"
}
```

- `reason` ∈ `turn-end` | `approval` | `question`
- `reasonDetail` 只有 `turn-end` 有意义：`completed` / `error` / `max-tokens` / `blocked` / `aborted:<原因>`；批准与提问时为 `null`。

**环境变量**（给 bat / 一行命令这类不方便解析 JSON 的场景）：

| 变量 | 值 |
|---|---|
| `NOTIFY_HUB_SESSION_ID` | 会话 id |
| `NOTIFY_HUB_RULE_ID` | 规则 id |
| `NOTIFY_HUB_CWD` | 工作目录 |
| `NOTIFY_HUB_REASON` | `turn-end` / `approval` / `question` |
| `NOTIFY_HUB_DETAIL` | 结束原因细节 |
| `NOTIFY_HUB_TIME` | 触发时刻（ISO 8601） |

> **改名兼容**：2026-11 之前的版本叫 `dsh-idle-hook`，注入的是 `IDLE_HOOK_*`。触发时**两套键都会注入**（旧键保留一个版本周期），所以你在旧脚本里读 `IDLE_HOOK_REASON` 仍然有效；新脚本请用 `NOTIFY_HUB_*`。

**隐私边界**：脚本**拿不到对话正文**（用户消息或模型回复的内容）。人类可读的会话标题只走标准输入；环境变量里的 id / 原因 / 时间戳保证是 ASCII，避免 Windows 代码页把变量弄乱（标题若含中文请从 stdin 读）。

### 生命周期

- **超时**：默认 30 秒（可配），到时**杀掉进程**并记为超时失败。
- **并发**：同一规则上一次执行还没结束又来触发 → **本次跳过**并记录「已跳过」（不会堆积进程）。
- **失败**：记录每次的退出码、耗时与输出尾部；**连续失败 3 次自动停用该规则**并在设置页标红，修好后点「重新启用并清零」。

脚本执行**永远不会阻塞 DSH**：不等待、不参与、不影响对话 / 批准 / 回答链路。

## 通道二：邮件（内置 SMTP）

选「邮件」通道后，规则表单换成 SMTP 字段。**不需要装任何依赖、不需要外部服务**：宿主半用 `node:net` / `node:tls` 直接和你的发件服务器对话（`465` 隐式 TLS、`587` STARTTLS、`25` 明文）。

| 字段 | 说明 |
|---|---|
| 服务商预设 | QQ 邮箱 / 网易 163 / 网易 126 / Gmail / Outlook / 自定义；选中即填好服务器与端口 |
| SMTP 服务器 / 端口 | 预设之外的服务器手填 |
| SSL/TLS 直连（465 常用） | 连上即加密 |
| 允许 STARTTLS 升级（587 常用） | 明文连上后按服务器广告升级 |
| 账号 | 一般是完整邮箱地址 |
| 授权码 / 密码 | **邮箱的 SMTP 授权码**，不是网页登录密码 |
| 授权码环境变量名 | 不想让授权码落盘时，填一个环境变量名（如 `QQ_SMTP_CODE`），发信时从进程环境读 |
| 发件人 / 收件人 | 收件人可用逗号或分号分隔多个；都支持 `名字 <地址>` 写法 |
| 主题 / 正文模板 | 支持占位符 `{title}` `{sessionId}` `{cwd}` `{reason}` `{detail}` `{time}`；正文留空则用默认模板 |
| 跳过证书校验 | 只给自签证书的内网邮件服务器用 |

- **「发送测试邮件」**：用当前草稿配置真的发一封（同样计入历史），不用先保存。
- **授权码的安全性**：面板**永远不回显**已保存的授权码（`/status` 在 HTTP 边界就把它抹掉了，只回一个「已配置」标记）；保存时若没动密码框，插件会把已存的值补回去，不会因为「看起来是空的」把它写没。授权码只落在 profile 的 `config:` 段（或你指定的环境变量）里，**执行历史只记键名、不记值**。
- **错误分类**：认证失败（检查授权码）、收件人被拒、连接邮件服务器失败（含 DNS/网络错误）、TLS 握手失败、命令超时——都写进历史，方便判断是配置错还是网络问题。
- **编码**：主题按 RFC 2047 base64 编码（中文标题不会乱码），正文 UTF-8 + base64，头部做了 CRLF 注入防护。
- 邮件通道同样受「并发跳过 / 超时 / 连续失败 3 次自动停用」约束。

## 设置页：插件 → 通知中心

| 控件 | 说明 |
|---|---|
| 总开关 | 关掉 = 所有规则都不投递（规则与历史保留） |
| 规则列表 | 每条可 启用/停用、试跑、编辑、删除；显示通道、上次运行时间·结果·退出码·耗时 |
| 发送方式 | 本机脚本 / 邮件（每条规则独立） |
| 触发条件 | 一轮结束 / 等待批准 / 等待回答（三个独立勾选） |
| 触发前提 | 任意 / 仅页面关着 / 仅页面不可见或失焦（见上文） |
| 去抖 / 超时 | 秒；默认 3 / 30 |
| 试跑 | 用**你当前打开的会话**的上下文跑一次；邮件规则点的是「发送测试邮件」。试跑计入历史，但**不计入**自动停用的失败计数 |
| 执行历史 | 最近 200 条滚动，落盘 `<DSH_HOME 或 ~/.dsh>/notify-hub-history.json`（含 stderr/stdout 尾部），重启后仍在 |

规则配置的落点随宿主世代不同（**能力探测，两代同一份代码**）：

- **0.2.0 起**：配置就是本插件 profile 条目的 `config:` 段（`cordis.patch.yml` 里 `- id: notify-hub` 那一行）。0.2.0 退役了 `settings.installSection`，设置服务改为投影每个条目自己导出的 `Config`（命名空间 = **条目 id**，其它 ns 一律抛 `No configurable plugin entry`），所以宿主半导出**手写 schema**（`link:` 安装解析不到 `@deepseek-ai/schemastery`），客户端仍用 `remote.settings.describe()/update()` 读写。写入会让该条目重启并带着新配置再跑一次 `apply`。
- **0.1.x**：仍在设置文件的 `notify-hub:` 命名空间里（宿主半经 `settings.installSection` 注册）。

两种形态都能直接手改（改完刷新页面即可看到）；`GET /__notify-hub/status` 的 `settings.source` 写明当前命中哪一种（`entry-config` / `section`）。

## 从 dsh-idle-hook 升级

改名不影响你已有的配置与历史：

| 旧 | 新 | 迁移行为 |
|---|---|---|
| 插件包名 / 目录 | `dsh-idle-hook` → `dsh-notify-hub` | 需要重新安装/激活（profile 的激活行改 id 与包名） |
| profile 依赖键 | `dsh-idle-hook: link:…/sub-plugins/dsh-idle-hook` → `dsh-notify-hub: link:…/sub-plugins/dsh-notify-hub` | 改完在 `<profile>/` 跑一次 `pnpm install`，否则启动报 `Cannot find package 'dsh-notify-hub'` |
| 设置命名空间 | `idle-hook:` → `notify-hub:` | 读不到新命名空间时回退读旧的 |
| 执行历史 | `idle-hook-history.json` → `notify-hub-history.json` | 新文件不存在而旧文件存在时，读旧内容并立即写新文件（**旧文件不删**） |
| 环境变量契约 | `IDLE_HOOK_*` → `NOTIFY_HUB_*` | 触发时两套都注入（旧键保留一个版本周期） |
| HTTP 端点 | `/__idle-hook/*` → `/__notify-hub/*` | 只保留新前缀 |

**改名的正确顺序**（只改 patch 行会半坏）：

1. 目录改名为 `sub-plugins/dsh-notify-hub`，`package.json.name` 同步；
2. 改 `src/` 里的 `PLUGIN_ID` / `HTTP_PREFIX` / `SETTINGS_NS` / 历史文件名 / 环境变量前缀；
3. 改 profile `cordis.patch.yml` 的 `insert` 行与 `config` 行的 `id` + `name`；
4. 改 profile `package.json` 的 `devDependencies` 键，然后在 `<profile>/` 跑 `pnpm install`；
5. 重启 DSH（宿主半代码变了，刷新页面不够）。

第 4 步最容易漏：`name:` 是**包名**，DSH 会去 `<profile>/node_modules` 解析，依赖键不改就是 `Cannot find package …`。

## 环境变量（两层）

设置页顶部有一张**全局环境变量**表，每条规则的表单里也有同样一张——**变量名 / 值两列，每行可删、底部「+ 添加一行」**：

- **全局**：所有规则共用，适合放 `NOTIFY_ACCESS_KEY`、`POPO_RECEIVER`、`MAIL_RECEIVER` 这类变量，配一次就够了。
- **规则级**：只对该规则生效，**同名时覆盖全局**（例如 A 规则发 POPO、B 规则只发邮件）。
- **合并顺序**：DSH 进程环境 → 全局 → 该规则 → 插件注入的 `NOTIFY_HUB_*`。
- **`NOTIFY_HUB_*`（以及旧的 `IDLE_HOOK_*`）不可覆盖**：插件注入的触发上下文永远优先——你配了同名键会被忽略，界面只提示不报错，脚本拿到的仍是真实值。
- **占位符**：值里可用 `{sessionId}` `{cwd}` `{title}` `{reason}` `{detail}` `{rule}` `{time}`，例如 `PROJECT_DIR={cwd}`。
- **格式**：键名限 `[A-Za-z_][A-Za-z0-9_]*`，空行与 `#` 开头的行忽略；缺等号或键名非法的行**会阻止保存**并说明原因。
- **明文提醒**：变量值会明文落盘（0.1.x 是 `<DSH_HOME 或 ~/.dsh>/settings.yaml`，0.2.0 起是 profile 的 `cordis.patch.yml` 里该条目的 `config:` 段），和规则参数一样。不愿落盘就把密钥留在启动 DSH 前的 `export` 里，或对邮件授权码改用「授权码环境变量名」。
- **文件路径**：设置文件在 `$DSH_HOME/settings.yaml`（`DSH_HOME` 未设置时才是 `~/.dsh/settings.yaml`）。用本仓库的 `dsh-start.sh` 启动时它把 `DSH_HOME` 指向仓库内的 `.dsh_home`，所以实际路径是 `<仓库>/.dsh_home/settings.yaml`；执行历史同理落在 `$DSH_HOME/notify-hub-history.json`。
- 执行历史里只记录**变量名**（方便排查「脚本为什么没拿到变量」），**不记录变量值**。
- **清空即删除**：把框里内容删光再保存 = 真的删掉这些变量（保存走的是设置服务的「整段替换」语义；如果只做合并，空框是删不掉任何键的 —— 这个坑踩过一次）。规则里的环境变量同理，改空的规则会随整条规则一起写回。

## 与 dsh-notification 的关系

`dsh-notification` 是**浏览器原生通知**：只在页面开着时响，只覆盖「一轮结束」，偏好存在浏览器里。本插件补上它做不到的三件事：**页面关着也能通知**、**等待批准 / 等待回答**、**任意通道（本机脚本或邮件）**。

要避免同一件事响两次，用**「触发前提」三档**分工：

| 场景 | 建议 |
|---|---|
| 想让它俩互补 | 本插件的规则设成 **仅页面关着**：页面开着时 dsh-notification 负责，页面关着时本插件负责 |
| 只想用本插件（推荐，尤其是要收「提问/批准」） | 规则设成 **任意**，并在设置 → 本地插件 里停用 `dsh-notification` |
| 只想在用别的窗口时收到 | 规则设成 **仅页面不可见或失焦** |

> ⚠️ **提问/批准场景不要用「仅页面关着」**：模型停下来等你回答时页面通常正开着，那一档会导致你永远收不到通知。这正是旧版本「DSH 提问时没弹通知」的原因之一（另一个原因是示例规则默认禁用）。

## 通知脚本示例

`examples/` 里是可以直接用的脚本，把路径填进规则的「命令」即可（解释器留空自动判断）：

| 文件 | 用途 | 需要的环境变量 |
|---|---|---|
| `notify-macos.sh` | macOS 系统通知 + 提示音 | — |
| `notify-windows.ps1` | Windows 原生 toast（⚠️ 文件是 **UTF-8 带 BOM**：系统自带 Windows PowerShell **5.1** 会把无 BOM 的 `.ps1` 按 ANSI/GBK 解码，中文注释即 `ParserError … UnexpectedToken`；另存脚本时别丢 BOM） | — |
| `notify-bark.py` | Bark 手机推送（Python 3） | `BARK_KEY`（`BARK_BASE` 可选） |
| `notify-ntfy.sh` | ntfy 推送 | `NTFY_TOPIC`（`NTFY_BASE` 可选） |
| `notify-webhook.sh` | 飞书 / 企业微信 / 钉钉 / Telegram / Slack | `WEBHOOK_KIND` + 对应 URL/token |
| `private/notify-popo.py` | **网易 POPO**（notify 接口，Python 3） | `POPO_ACCESS_KEY`、`POPO_RECEIVER` |
| `private/notify-mail.py` | **只发邮件**（同一接口；支持抄送/密送、HTML 正文、附件） | `NOTIFY_ACCESS_KEY`、`MAIL_RECEIVER` |
| `private/notify-popo-mail.py` | **网易 POPO + 邮件** 二合一 —— ⚠️ **默认两个渠道都发**，只发一个要在参数里加 `--only mail` / `--only popo`（可 `--batch` 一条请求发两条；支持群里 @、附件） | `NOTIFY_ACCESS_KEY` + `POPO_RECEIVER` / `MAIL_RECEIVER` |
| `notify-router.py` | 按 `reason` 分流到不同通道/文案 | 见文件头注释 |
>
> 带 `private/` 前缀的三个（POPO / 邮件 / 二合一）放在 `examples/private/` —— 该目录被 `.gitignore` 忽略（`**/examples/private/`），**不入库**，新克隆的仓库里没有它们。你自己那份不想提交的脚本（内网接口、个人配置）也放这儿；`examples/README.md` 保留了它们的接口说明。
>
> 既然插件已经内置 SMTP 邮件通道，`private/notify-mail.py` 这类「走内网 notify 接口」的脚本仍然有用（企业内网投递），但个人邮箱场景直接用邮件通道更省事。

密钥怎么给（按省事程度自上而下）：① **写进上面的环境变量框**（全局配一次、规则可覆盖；明文落在配置文件）；② 启动 DSH 前 `export` → 脚本自动继承（不落盘）；③ 直接写在规则的「参数」里（如 `--token=xxx`，同样明文落盘）；④ 直接写进脚本（本地脚本，风险自负）。用法与坑见 `examples/README.md`。

## 宿主半的副作用（读前知悉）

- 以 **DSH 进程的身份**执行你配置的本地进程（不经过 DSH 的 sandbox 策略），或**用你的邮箱账号发信**。
- 写 `<DSH_HOME 或 ~/.dsh>/notify-hub-history.json`（执行历史 + 每规则的失败计数/自动停用状态）。
- 通过客户端把配置写进当前世代的落点（0.1.x：`settings.yaml` 的 `notify-hub:` 段；0.2.0 起：本插件 profile 条目的 `config:` 段）。
- 注册 `/__notify-hub/*` HTTP 路由，供设置页读取状态、上报页面在场、试跑/发测试邮件与查历史。
- 只**观察**批准与提问链路（`prepend` 后原样 `return next()`），绝不改变结果或延迟。

## 已知限制

- 页面关着时看不到设置页（触发照常，宿主半在工作）。
- Windows 侧我只能在 macOS 上验证代码路径（解释器选择/参数拼装/失败处理有单测覆盖），**真机通知未验证**——见 `ACCEPTANCE.md` 的 Windows 条目。
- 邮件通道的 SMTP 对话用内存假服务器做了全流程单测（含 AUTH LOGIN/PLAIN、STARTTLS、超时、拒收），但**未对真实邮箱服务商做端到端投递验证**——首次用请点「发送测试邮件」。
- 规则是**整份数组替换**：同一时刻建议只在一个页面编辑，两个页面同时改会互相覆盖。
- 自动停用后必须手动「重新启用」；插件不会自己复活一条一直失败的规则。
- 规则不做排序/依赖编排，多条规则各自独立执行。

## 开发 / 测试

```sh
node sub-plugins/dsh-notify-hub/test/host-core.test.mjs  # 触发矩阵、解释器选择、上下文、presence、失败计数、邮件纯函数（MIME/校验/错误分类）
node sub-plugins/dsh-notify-hub/test/smtp.test.mjs       # SMTP 全流程（内存假服务器，不开端口）：AUTH LOGIN/PLAIN、STARTTLS、拒收、超时
node sub-plugins/dsh-notify-hub/test/bundle.test.mjs     # 客户端 harness：注册、渲染、写入、试跑、发测试邮件、心跳、宿主半安全护栏
```

改 `src/client.js` → **刷新页面**即可（`pnpm run dev:web` 时走 HMR）；改 `src/index.js` / `src/smtp.js`（宿主半）→ 需**重启 GUI host**。设计依据见 `openspec/changes/rename-idle-hook-and-add-email-channel/`（改名与邮件通道）与 `openspec/changes/add-dsh-idle-hook/`（最初的能力契约）。
