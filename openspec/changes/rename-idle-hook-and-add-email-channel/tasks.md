# Tasks

## 1. OpenSpec 与命名

- [x] 1.1 新建 `openspec/changes/rename-idle-hook-and-add-email-channel/`（proposal / design / tasks / specs / .openspec.yaml）
- [x] 1.2 目录重命名 `sub-plugins/dsh-idle-hook` → `sub-plugins/dsh-notify-hub`；`package.json` 的 name/description/keywords 同步
- [x] 1.3 `host-core.js`：`PLUGIN_ID` / `HTTP_PREFIX` / `SETTINGS_NS` / `HISTORY_FILE_NAME` / 环境变量前缀改为 notify-hub 系，并保留旧常量别名一个版本周期
- [x] 1.4 `index.js` / `client.js`：name、模块 id、API 前缀、导航与标题文案同步改名
- [x] 1.5 兼容迁移：旧历史文件读取后写新文件名；旧设置命名空间回退读取

## 2. 邮件通道（宿主半纯逻辑）

- [x] 2.1 `normalizeRule` 增加 `channel`（script|email）与 `email` 子对象（host/port/secure/starttls/user/pass/passEnv/from/to/subject/body/allowInsecureTls），带默认值与范围钳制
- [x] 2.2 `validateRule`：邮件通道校验 host/port/to；脚本通道保持原校验
- [x] 2.3 新增 `buildMailMessage(rule, values)`：头部拼装、RFC 2047 主题编码、base64 正文折行、dot-stuffing
- [x] 2.4 新增 `classifySmtpError(stage, response)`：连接/认证/收件人/超时分类
- [x] 2.5 `buildTriggerContext` 增加 `time` 占位符；契约环境变量同时注入 `NOTIFY_HUB_*` 与旧 `IDLE_HOOK_*`

## 3. SMTP 客户端（`src/smtp.js`）

- [x] 3.1 `sendMail(emailConfig, message, opts)`：连接（隐式 TLS / 明文 + STARTTLS）、EHLO/HELO 回退、AUTH PLAIN/LOGIN、MAIL/RCPT/DATA、QUIT
- [x] 3.2 超时与错误：连接超时、命令超时、整体超时，全部 `destroy()` 后按分类返回
- [x] 3.3 凭据脱敏与 `allowInsecureTls` 应急开关
- [x] 3.4 `test/smtp.test.mjs`：假 SMTP 服务器端到端覆盖成功/认证失败/收件人拒绝/超时/中文主题

## 4. 宿主演执行器接线（`index.js`）

- [x] 4.1 `runRule` 按 `channel` 分派：script → `spawnOnce`；email → `sendMail`
- [x] 4.2 邮件结果写入同一套 history（status/error/durationMs），不记录任何凭据
- [x] 4.3 `/__notify-hub/status` 对 `email.pass` 脱敏并补 `passConfigured`
- [x] 4.4 新增 `POST /__notify-hub/test-email`（等价 test-run，但强制走邮件通道）
- [x] 4.5 HTTP 前缀改名后客户端全部端点可用（回归）

## 5. 客户端设置页（`client.js`）

- [x] 5.1 规则表单新增「通道」单选（本机脚本 / 邮件）
- [x] 5.2 邮件表单：服务商预设（QQ/163/126/Gmail/Outlook/自定义）一键填充 host/port/secure、账号、授权码（password，不回显）、发件人、收件人、主题、正文
- [x] 5.3 「发送测试邮件」按钮（保存前可用，走 /test-email）
- [x] 5.4 脚本字段在邮件通道下隐藏；邮件字段在脚本通道下隐藏
- [x] 5.5 规则卡片显示通道徽标与「授权码已配置/未配置」
- [x] 5.6 文案与导航改名（通知枢纽 / Notify Hub）

## 6. 修复默认体验

- [x] 6.1 `sampleRule` 默认 precondition 改 `any`，名称去掉「（默认关闭）」歧义，改为「示例：桌面通知」
- [x] 6.2 现网 profile：`sample-notify` 设为 `enabled: true` + `precondition: any`（工作区外，人工确认后执行）
- [x] 6.3 现网 profile：两条激活行的包名改为 `dsh-notify-hub`，并改 profile `package.json` 的 `devDependencies` 键（`dsh-idle-hook` → `dsh-notify-hub`）后在 profile 目录跑 `pnpm install`（2026-11-12 实跑：链接已生成、旧链接已清、lockfile 无 idle-hook 残留）

## 7. 测试与验收

- [x] 7.1 `node sub-plugins/dsh-notify-hub/test/host-core.test.mjs` 全绿 （实跑：58 passed + 4 skipped，skip 因 DSH 沙箱禁止派生子进程）
- [x] 7.2 `node sub-plugins/dsh-notify-hub/test/smtp.test.mjs` 全绿 （实跑：10 checks passed）
- [x] 7.3 `node sub-plugins/dsh-notify-hub/test/bundle.test.mjs` 全绿 （实跑：24 passed + 1 skipped，skip 同上）
- [x] 7.4 `node dsh-plugin-manager/test/*.test.mjs` 全绿（管理器不受改名影响） （实跑 7 支：host-core / bundle / debounce / batch-remove-all / uninstall / root-install-shell / entry-config 全 PASS）
- [ ] 7.5 真机：重启 DSH 后设置页出现「通知中心」tab，示例规则可试跑成功 —— 待真机验证（需重启 DSH 加载新包名后人工确认）
- [ ] 7.6 真机：用授权码向用户邮箱发送测试邮件，中文主题/正文正常 —— 待真机验证（需重启 DSH 加载新包名后人工确认）

## 8. 文档与版本

- [x] 8.1 重写 `sub-plugins/dsh-notify-hub/README.md`（安装、三种触发、脚本通道、邮件通道、服务商表格、排错）
- [x] 8.2 重写 `ACCEPTANCE.md`（改名后的验收项 + 邮件通道验收）
- [x] 8.3 更新 `docs/plugins.md`、`docs/knowledge/README.md`、`docs/knowledge/2026-11-12-dsh-notify-hub.md`
- [x] 8.4 根 `README.md` 插件清单改名
- [x] 8.5 根 `package.json` 与 `dsh-plugin-manager/package.json` 版本同步 patch 递增
