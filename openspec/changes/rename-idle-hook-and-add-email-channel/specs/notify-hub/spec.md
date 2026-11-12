## Purpose

当 DSH 处于「模型不在运行」的状态（一轮结束、等待人类批准、等待人类回答提问）时，按用户配置的规则把「DSH 停下来了」这一事实投递到用户选定的通道——本机脚本或内置 SMTP 邮件——并让每一次投递都可回答「跑没跑、为什么没跑、结果如何」。本能力由旧的 `idle-hook` 能力重命名并扩展而来。

## ADDED Requirements

### Requirement: 邮件通知通道

规则 SHALL 支持两种通道：`script`（执行本机脚本，沿用旧语义）与 `email`（由插件自己投递一封邮件）。`channel` 字段缺省 MUST 视为 `script`，以保证旧配置继续可用。当 `channel` 为 `email` 时，系统 MUST NOT 派生任何子进程。

邮件通道的配置 MUST 包含：服务器地址、端口、是否隐式 TLS、账号、授权码（直接填写或由环境变量提供）、发件人、收件人；主题与正文 MAY 留空并使用默认模板。

#### Scenario: 邮件通道不执行脚本

- **WHEN** 一条规则的 `channel` 为 `email`
- **THEN** 触发时插件直接投递邮件，不 spawn 任何进程，历史里也不出现退出码

#### Scenario: 旧配置继续按脚本执行

- **WHEN** 一条既有规则没有 `channel` 字段
- **THEN** 它仍按本机脚本通道执行，行为与升级前一致

#### Scenario: 配置不完整时不投递

- **WHEN** 邮件规则缺少收件人或服务器地址
- **THEN** 本次触发记为 `error`，错误信息指出缺失项，且不发起任何网络连接

### Requirement: SMTP 连接与认证形态

系统 SHALL 支持三种连接形态：465 端口的隐式 TLS；明文连接后按服务器能力升级 STARTTLS；以及允许的纯明文投递。系统 SHALL 支持 AUTH PLAIN 与 AUTH LOGIN 两种认证方式，并在服务器未通告任何 AUTH 机制且配置了账号时明确报错，而不是静默失败。

连接、单条命令、整次投递 MUST 都有超时；任一超时 MUST 关闭连接并把本次结果记为 `timeout`。

#### Scenario: 465 隐式 TLS 投递成功

- **WHEN** 规则配置 `secure: true`、端口 465，凭据正确
- **THEN** 邮件投递成功，历史记为 `ok`

#### Scenario: 587 STARTTLS 投递成功

- **WHEN** 规则配置 587 端口、服务器通告 STARTTLS，凭据正确
- **THEN** 连接升级为 TLS 后完成投递，历史记为 `ok`

#### Scenario: 授权码错误

- **WHEN** 服务器返回 535/530 认证失败
- **THEN** 本次结果记为 `failed`，错误信息提示「认证失败，请检查邮箱授权码」，且不重试

#### Scenario: 服务器无响应

- **WHEN** 连接或某条命令超过超时阈值
- **THEN** 连接被关闭，结果记为 `timeout`

### Requirement: 消息编码与占位符

邮件 MUST 以 UTF-8 纯文本投递：主题含非 ASCII 字符时 MUST 按 RFC 2047 编码，正文 MUST 使用 base64 传输编码，以避免中文乱码与 8BITMIME 依赖。正文中以 `.` 开头的行 MUST 做点填充。

主题与正文 SHALL 支持占位符 `{sessionId}`、`{title}`、`{cwd}`、`{reason}`、`{detail}`、`{rule}`、`{time}`。

#### Scenario: 中文主题可读

- **WHEN** 主题为「DSH 通知：一轮结束 · 修复登录」
- **THEN** 收件端看到的就是这段中文，而不是 base64 字面量或乱码

#### Scenario: 正文以点开头的行不被截断

- **WHEN** 正文某一行以 `.` 开头
- **THEN** 该行完整送达，邮件正文不会被提前结束

### Requirement: 授权码与凭据保护

插件 MUST NOT 主动向用户索取授权码、密码或令牌。授权码只能由用户在设置页填写或通过环境变量提供。

任何对外可见的数据 MUST NOT 包含凭据明文：状态接口返回的规则里授权码字段 MUST 被清空并附带「是否已配置」的布尔标记；执行历史 MUST NOT 记录授权码、完整邮件配置或 SMTP 会话原文。

#### Scenario: 状态接口不回显授权码

- **WHEN** 用户打开设置页并读取 `/__notify-hub/status`
- **THEN** 返回的 `email.pass` 为空字符串，`passConfigured` 为 `true`

#### Scenario: 历史不含凭据

- **WHEN** 一次邮件投递完成或失败
- **THEN** 历史条目只包含规则名、通道、耗时、状态与错误摘要，不含授权码

### Requirement: 测试发信

设置页 SHALL 提供「发送测试邮件」操作，可在保存前使用；该操作 MUST 走与正式触发相同的投递路径，并在界面上给出可读的成功/失败原因（认证失败、收件人拒绝、超时、连接失败等可区分）。

#### Scenario: 未保存即测试

- **WHEN** 用户填好邮件表单但尚未保存，点击「发送测试邮件」
- **THEN** 插件用表单当前值投递一封测试邮件，并把结果反馈到界面

#### Scenario: 测试失败可定位

- **WHEN** 授权码错误导致测试投递失败
- **THEN** 界面显示「认证失败，请检查授权码」，而不是笼统的「失败」

### Requirement: 插件标识与配置命名空间迁移

插件 SHALL 以 `dsh-notify-hub` 为唯一标识：包名、宿主半名称、HTTP 前缀 `/__notify-hub`、设置命名空间 `notify-hub`、历史文件 `notify-hub-history.json`。

升级 MUST 保持用户既有配置与历史可用：读不到新设置命名空间时 SHALL 回退读取旧命名空间 `idle-hook`；新历史文件不存在而旧文件存在时 SHALL 读取旧文件并落盘为新文件（旧文件 MUST NOT 被删除）。触发时注入的环境变量 SHALL 使用 `NOTIFY_HUB_*`，并在一个版本周期内同时注入旧的 `IDLE_HOOK_*` 键。

#### Scenario: 升级后规则仍在

- **WHEN** 用户从 `dsh-idle-hook` 升级到 `dsh-notify-hub`，旧命名空间里已有规则
- **THEN** 设置页显示这些规则，保存后写入新命名空间

#### Scenario: 升级后历史仍在

- **WHEN** 新历史文件不存在且旧历史文件存在
- **THEN** 插件读取旧历史，并在下一次落盘时写入新文件名

#### Scenario: 旧脚本仍能读到上下文

- **WHEN** 用户的脚本读取 `IDLE_HOOK_SESSION_ID`
- **THEN** 该变量仍然存在且值正确（文档标注为弃用）

### Requirement: 通知示例规则默认可用

首次使用预置的示例规则 SHALL 采用「任意时候都触发」的前提，以免在用户正盯着页面看时（提问、等待批准）永远不触发；示例规则 MAY 默认禁用，但界面 MUST 明确说明启用后的效果与触发前提。

#### Scenario: 页面开着也能收到通知

- **WHEN** 用户启用示例规则且页面处于前台聚焦
- **THEN** 一轮结束、等待批准或等待提问时都会触发通知

#### Scenario: 首次安装不误报

- **WHEN** 用户从未启用任何规则
- **THEN** 不会执行任何脚本、不会发送任何邮件
