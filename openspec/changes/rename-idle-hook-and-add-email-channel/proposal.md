# Proposal

## Why

### 1. 提问/等待批准时不弹通知（本次排查的直接问题）

现网 profile 里唯一的一条规则是首次使用预置的示例规则，它有两处叠加的坑：

- **默认禁用**：示例规则带 `enabled: false`，用户没手动启用就等于没有任何规则。宿主 `/__idle-hook/status` 的 `lastSkip` 明确记为「示例：Windows 桌面通知（默认关闭）：未启用」。
- **默认前提是「仅页面关着」**：`precondition: page-closed`。而「模型提问」「等待批准」这两个最需要通知的场景里，用户几乎必然正盯着页面看，因此即便启用了规则也**永远不会**触发。

两者叠加的结果是「插件装了、触发链是活的（dispatched=26、sessionEvents=10710）、但用户一次通知都收不到」。执行历史（69 条，全部是 approval/turn-end，question 为 0）与 2026-10-22 之后归零的记录进一步说明：配置曾回落/被重写，用户「以前能弹、现在不弹」的体感由此而来。

### 2. 缺一条「不写脚本」的通知通道

当前规则只能执行本机脚本。要发一封邮件，用户得自己写 python/ps1 脚本、自己处理 SMTP 与 TLS、自己拼 MIME——绝大多数人真正想要的只是「填个邮箱和授权码，DSH 停下来就发信给我」。

### 3. 名字不可辨认

`dsh-idle-hook` 只描述了「空闲钩子」，既不能表达「通知」，又与既有的 `dsh-notification`（浏览器原生通知）容易混为一谈。仓库里同时存在两个名字含 notify 含义的插件，用户难以判断该开哪一个。

## What Changes

- **重命名**：`dsh-idle-hook` → `dsh-notify-hub`。范围包括子插件目录、包名、宿主半 `name` 与 `core.PLUGIN_ID`、HTTP 前缀（`/__idle-hook` → `/__notify-hub`）、设置命名空间（`idle-hook` → `notify-hub`）、宿主状态文件（`idle-hook-history.json` → `notify-hub-history.json`）、环境变量契约前缀（`IDLE_HOOK_*` → `NOTIFY_HUB_*`）、客户端模块 id 与测试挂载点、文档与索引。
- **兼容迁移**：宿主半启动时若发现旧的 `idle-hook-history.json` 而新文件不存在，读取旧文件并写入新文件名（旧文件保留不删）；客户端/宿主半在设置服务里读不到 `notify-hub` 命名空间时，回退读取 `idle-hook` 命名空间并把值写到新命名空间（一次性迁移）。
- **新增邮件通道（内置 SMTP，零依赖）**：规则新增 `channel` 字段（`script` | `email`）。`email` 通道不执行任何子进程，直接由插件用 `node:net` + `node:tls` 投递一封 UTF-8 纯文本邮件。
  - 连接形态：465 隐式 TLS；587/25 明文连接后按服务器能力 STARTTLS；25 也允许纯明文。
  - 认证：AUTH LOGIN 与 AUTH PLAIN（服务器支持哪个用哪个）；未配置用户名密码时跳过 AUTH。
  - 编码：主题按 RFC 2047（UTF-8 + base64）编码，正文 `text/plain; charset=UTF-8` + base64，避免中文乱码与 8BITMIME 兼容问题。
  - 占位符：主题与正文支持 `{sessionId}` / `{title}` / `{cwd}` / `{reason}` / `{detail}` / `{rule}`。
  - 超时：连接超时、单命令超时、整体超时三层，任一超时都杀掉 socket 并记为 `timeout`。
- **凭据安全**：授权码/密码只从「用户在设置页填写」或「环境变量」取得（`passEnv`）。插件永不主动索取；历史记录与 `/status` 响应永不回显密码，只回显「是否已配置」。
- **设置页**：新增「通道」单选（本机脚本 / 邮件），邮件表单带服务商预设（QQ / 163 / 126 / Gmail / Outlook / 自定义）与「发送测试邮件」按钮；脚本相关字段在邮件通道下折叠隐藏。
- **修复默认体验**：示例规则默认前提改为「任意时候都触发」（`any`），并把 `sampleRule` 的名字从「示例：…（默认关闭）」改为更明确的通知示例；用户的现网规则由运维侧设为 `enabled: true` + `precondition: any`。
- **文档**：重写 README / ACCEPTANCE，更新 `docs/plugins.md`、`docs/knowledge/README.md` 与相关索引，新增本篇 OpenSpec 变更。

## Capabilities

### Renamed Capabilities

- `idle-hook` → `notify-hub`：能力范围从「空闲时跑脚本」扩展为「空闲时把通知投递到用户选定的通道（本机脚本或邮件）」。

### New Capabilities

- `notify-hub/email-channel`：内置 SMTP 邮件通道——连接与认证形态、消息编码、占位符、超时与错误分类、凭据保护、测试发信。

### Modified Capabilities

（无：`plugin-manager` / `esc-rewind` / `composer-history-recall` / `composer-provider-label` / `mcp-manager` 等既有需求不变。）

## Impact

- **重命名影响面**：`sub-plugins/dsh-idle-hook/` 整目录、`package.json`（name/description/keywords）、`src/index.js`（name、HTTP 前缀、状态文件）、`src/host-core.js`（PLUGIN_ID/HTTP_PREFIX/SETTINGS_NS/HISTORY_FILE_NAME/ENV 前缀）、`src/client.js`（模块 id、SETTINGS_NS、API 前缀、导航文案）、`test/*.test.mjs`、`examples/*`、`README.md`、`ACCEPTANCE.md`、`docs/plugins.md`、`docs/knowledge/README.md`、仓库根 `README.md`。
- **profile 变更（工作区外）**：`~/.dsh/profiles/web/cordis.patch.yml` 中两条行（插入行 id 与 config 行）要把包名从 `dsh-idle-hook` 改成 `dsh-notify-hub`，否则重启后加载器找不到旧包名。
- **新增代码**：`src/smtp.js`（纯 Node 内建模块实现的 SMTP 客户端）、`test/smtp.test.mjs`（假 SMTP 服务器端到端）、`test/host-core.test.mjs` 增补邮件配置规范化用例。
- **依赖**：仍然**零**运行时依赖、宿主半**零** `@deepseek-ai/*` import。
- **运行时副作用**：邮件通道会在触发时对外发起 TCP/TLS 连接（用户的邮件服务器）；不写任何额外文件。
- **版本**：根 `package.json` 与 `dsh-plugin-manager/package.json` 同步 patch 递增（仓库 AGENTS.md 强制）。
