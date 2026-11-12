# dsh-notify-hub：改名迁移、内置 SMTP 邮件通道与「通知不触发」的两个根因

插件原名 `dsh-idle-hook`（2026-09 创建），2026-11-12 改名为 `dsh-notify-hub`（设置页 tab 名「通知中心」），同时新增邮件通道。本文记录可复用的结论。

## 1. 「DSH 提问时不弹通知」的两个根因（排错先看这两条）

1. **示例规则的触发前提是 `page-closed`**：旧 `sampleRule()` 用 `PRECONDITION.pageClosed`，含义是「页面关着/失联才发」。而用户提问、等待批准时页面**必然开着**，`allowsByPrecondition()` 直接返回 false → 永远不触发。现已改为 `PRECONDITION.any`。**任何「人在电脑前等回复」的场景都必须用 `any`。**
2. **`enabled: false` 被 profile 固化**：示例规则出厂就是禁用（只用于演示），同时 profile `cordis.patch.yml` 里那条 `sample-notify` 快照带着 `enabled: false` 与 `precondition: page-closed`。插件升级改了默认值也**不会**覆盖 profile 里已有的规则对象 → 表现为「以前能弹、现在不弹」。修法只能是改 profile（或 UI 里点一次启用）。

诊断入口：`GET /__notify-hub/status` 的 `diag.lastSkip` 会原样给出跳过原因（如「示例：Windows 桌面通知（默认关闭）：未启用」），比翻日志快得多。

## 2. 改名要同时改的 8 处（漏一处就半坏）

`PLUGIN_ID` / `HTTP_PREFIX`（`/__idle-hook` → `/__notify-hub`）/ `SETTINGS_NS`（`idle-hook` → `notify-hub`）/ `HISTORY_FILE_NAME` / 环境变量前缀（`IDLE_HOOK_` → `NOTIFY_HUB_`）/ `client.js` 的 `__ModuleLoader__.load({id})` 与 slot `id` / profile `cordis.patch.yml` **两处**（`insert` 行 + `config` 行）。目录名与 `package.json.name` 必须一致，否则管理器面板认不出。

8. **profile 的 `devDependencies` 依赖键**：`dsh-idle-hook: link:./node_modules/dsh-plugin-manager/sub-plugins/dsh-idle-hook` 必须改成 `dsh-notify-hub: link:./node_modules/dsh-plugin-manager/sub-plugins/dsh-notify-hub`，然后在 `<profile>/` 目录跑一次 `pnpm install` 生成 `node_modules/dsh-notify-hub` 链接、清掉旧链接。

> **漏掉第 8 条的实际症状（2026-11-12 踩过）**：启动日志报 `notify-hub (dsh-notify-hub): failed to import: Error [ERR_MODULE_NOT_FOUND]: Cannot find package 'dsh-notify-hub' imported from C:\Users\<u>\.dsh\profiles\web\`。原因是 patch 行的 `name:` 是**包名**，DSH 会去 profile 的 `node_modules` 里解析；只改 patch 不改依赖键，包名就指向空气。补法：改 `package.json` 的 devDependencies → `pnpm install` → 重启 DSH。

兼容策略（保一个版本周期）：`LEGACY_SETTINGS_NS` 回退读旧命名空间；`loadState()` 读不到新历史文件就读 `LEGACY_HISTORY_FILE_NAME` 并**立即写新文件、旧文件不删**；`buildTriggerContext` 同时注入新旧两套环境变量。

## 3. 零依赖 SMTP 客户端的三个硬坑

- **命令行必须以 CRLF 结尾**：`socket.write('EHLO x')` 会让服务器一直等到超时；要 `write(text + '\r\n')`，只有 DATA 正文用「原样写」通道（`writeRaw(message.data + '\r\n.\r\n')`）。
- **AUTH PLAIN 的 base64 与命令同行**（`AUTH PLAIN <blob>`），不是先发命令再发一行；断言「密码不出现在日志里」时不能用 `includes`，要用 `endsWith` 或整段比对。
- `takeReply()` 剥掉回复码后，后续断言要针对**回复文本**（`Authentication credentials invalid`）而不是 `535`。

## 4. 离线测 SMTP：内存 Duplex 假服务器，不开端口

`src/smtp.js` 留了 `export function __setConnector(fn)` 缝隙，测试用 `new Duplex({ read(){}, write(c,_,cb){ ... } })` 驱动完整协议对话（greeting / EHLO 机制广告 / AUTH LOGIN 两步 / DATA 的 `\r\n.\r\n` 截断）。这样 `test/smtp.test.mjs` 覆盖成功、535、550、ECONNREFUSED、静默超时、多收件人，**且不监听任何端口**（仓库规则）。

## 5. 授权码不入库、不回显

- 配置里 `email.pass` 与 `email.passEnv` 二选一；推荐 `passEnv`（用户名存环境变量，配置里只有变量名）。
- `statusPayload()` 用 `redactRule()` 把 `pass` 清空并补 `passConfigured: true/false`，客户端据此显示「已配置/未配置」，**不需要也不应该**把明文回填进输入框。
- AI 侧永不索取授权码；由用户在设置页填或写进环境变量。

## 6. 代码位置

- `sub-plugins/dsh-notify-hub/src/host-core.js`：常量、规则校验、邮件纯函数（`buildMailMessage` / `validateEmailConfig` / `classifySmtpError`）。
- `sub-plugins/dsh-notify-hub/src/smtp.js`：连接与协议（implicit TLS / STARTTLS / PLAIN / LOGIN / PLAIN fallback）。
- `sub-plugins/dsh-notify-hub/src/index.js`：`runRule()` 按 `channel` 分派，端点 `/status` `/presence` `/history` `/clear-history` `/reset-rule` `/test-run` `/test-email`。
- 测试：`test/host-core.test.mjs`、`test/smtp.test.mjs`、`test/bundle.test.mjs`。
