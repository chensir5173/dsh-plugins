# Design

## 1. 为什么内置 SMTP，而不是复用脚本

脚本通道已经能发邮件（`examples/` 里也有 webhook 形态），但它的门槛是「用户得会写脚本并自己装依赖」。邮件是最高频的「我人不在电脑前」通道，把它做成一等公民（一条规则、四个字段、一个测试按钮）才符合用户诉求：**只填授权码就能收到通知**。

约束：仓库硬规则要求宿主半零 `@deepseek-ai/*` import、插件零运行时依赖。因此 SMTP 客户端必须自己实现，只用 `node:net` / `node:tls` / `node:crypto`。

## 2. SMTP 会话状态机

```
connect (implicit TLS when port 465 / secure=true)
  → 220 greeting
  → EHLO <clientName>            （失败回退 HELO）
  → [STARTTLS] 220 → TLS 升级 → 再 EHLO
  → [AUTH] 235                    （服务器 530/535/认证失败即中止）
  → MAIL FROM:<from>
  → RCPT TO:<to>  (可多个)
  → DATA → 354 → 正文 → "." → 250
  → QUIT
```

实现要点：

- **行协议**：按 `\r\n` 分行读，累积缓冲区；多行响应以 `NNN-` 续行、`NNN ` 结束。
- **点填充（dot-stuffing）**：正文里以 `.` 开头的行必须写成 `..`，否则会被当作 DATA 结束。
- **命令超时**：每条命令 10s，连接 15s，整体 30s（用规则的 `timeoutMs` 上限，默认 30s）。
- **TLS**：`secure: true`（默认 465）直接 `tls.connect`；否则先明文连接，EHLO 后若服务器通告 `STARTTLS` 且 `starttls !== false`，升级；升级后必须重新 EHLO（RFC 3207）。
- **证书校验**：默认 `rejectUnauthorized: true`；提供 `allowInsecureTls` 应急开关（自签服务器），并在历史里标注。
- **认证**：优先 `AUTH PLAIN`（单次 base64 `\0user\0pass`），若服务器只通告 LOGIN 则用 LOGIN 两步；都没有且需要认证时报「服务器不支持 AUTH」。
- **不支持的扩展**：服务器没通告 `8BITMIME` 也不影响——正文一律 base64。

## 3. 消息编码

- 头部：`From` / `To` / `Subject` / `Date` / `Message-ID` / `MIME-Version: 1.0` / `Content-Type: text/plain; charset=UTF-8` / `Content-Transfer-Encoding: base64`。
- 主题：若含非 ASCII，使用 `=?UTF-8?B?<base64>?=`（RFC 2047），并保证编码后每行不超过 76 字符（长主题分段）。
- 正文：UTF-8 → base64，按 76 字符折行；空正文给一个最小占位（避免某些服务器拒收空 DATA）。
- 收件人：`to` 支持逗号分隔多人（`RCPT TO` 逐个投递）。
- `from` 缺省用 `user`（多数服务商要求 From 与登录账号一致，界面上给出提示）。

## 4. 配置模型

```yaml
notify-hub:
  enabled: true
  seeded: true
  env: {}
  rules:
    - id: mail-demo
      name: 邮件通知
      channel: email          # script | email
      email:
        host: smtp.qq.com
        port: 465
        secure: true          # 隐式 TLS
        starttls: true        # 非隐式时是否尝试 STARTTLS
        user: me@qq.com
        pass: ''              # 授权码；也可留空用 passEnv
        passEnv: MAIL_PASS    # 从环境变量（全局或规则 env）取授权码
        from: me@qq.com
        to: me@qq.com
        subject: 'DSH 通知：{reason} · {title}'
        body: |
          会话：{title}（{sessionId}）
          目录：{cwd}
          原因：{reason} {detail}
          时间：{time}
      precondition: any
      triggers: { turnEnd: true, approval: true, question: true }
      timeoutMs: 30000
```

- `channel` 缺省 `script`，保持旧配置语义。
- `email` 只在 `channel === 'email'` 时参与校验；`script` 通道下完全忽略（避免用户切回脚本时被残留邮件字段拦住保存）。
- `{time}` 是新增占位符（触发时间，ISO）。

## 5. 迁移

| 项 | 旧 | 新 | 迁移方式 |
| --- | --- | --- | --- |
| 设置命名空间 | `idle-hook` | `notify-hub` | 宿主半读不到新命名空间时读旧的；客户端读取时回退，写回新命名空间 |
| 历史文件 | `idle-hook-history.json` | `notify-hub-history.json` | 新文件不存在且旧文件存在时，读旧内容并立即落盘为新文件（旧文件不删） |
| 环境变量契约 | `IDLE_HOOK_*` | `NOTIFY_HUB_*` | 触发时**同时**注入两套（旧键保留一个版本周期），文档标注旧键将移除 |
| HTTP 端点 | `/__idle-hook/*` | `/__notify-hub/*` | 只保留新前缀（客户端与宿主半同版本发布，无外部调用方） |

**为什么保留旧环境变量键**：用户已经在自建脚本里读了 `IDLE_HOOK_SESSION_ID`，一次改名就断掉他们的脚本是不可接受的；双写成本极低（几个环境变量），文档里标注弃用即可。

## 6. 错误分类

邮件通道的历史 `status` 复用既有取值（`ok` / `failed` / `timeout` / `error`），并把人可读原因写进 `error`：

- 连接失败 / DNS 解析失败 → `failed`，`error: 连接 smtp.qq.com:465 失败：ENOTFOUND`
- 连接或命令超时 → `timeout`
- 认证失败（535/530/5.7.x）→ `failed`，`error: 认证失败（请检查邮箱授权码）：535 Login Fail`
- 发件人/收件人被拒（550/553/554）→ `failed`，`error: 收件人被拒：550 mailbox unavailable`
- 配置缺失（host/to 为空）→ `error`，`error: 邮件配置不完整：缺少收件人`

连续 3 次失败自动停用的逻辑对邮件通道同样生效（避免授权码过期后每轮都重试）。

## 7. 凭据安全

- 设置页密码框 `type: password`，**不回显**已保存的值；只显示「已配置（点击修改）」。
- `/__notify-hub/status` 返回的规则里 `email.pass` 一律替换为 `''`，另给 `passConfigured: true/false`。
- 历史条目不记录 `email` 任何字段，只记 `envKeys`（键名）与通道名。
- 测试发信失败时，错误信息里若包含服务器回显的凭据（极少数畸形服务器），做一次`***`替换。

## 8. 测试策略

- `test/smtp.test.mjs`：在 `127.0.0.1` 上起一个**假 SMTP 服务器**（`node:net`，随机端口），覆盖：EHLO 多行响应、AUTH LOGIN、AUTH PLAIN、MAIL/RCPT/DATA、点填充、base64 正文还原、中文主题 RFC 2047 解码校验、535 认证失败、550 收件人拒绝、命令超时。
- `test/host-core.test.mjs` 增补：`normalizeRule` 的 channel/email 规范化、`validateRule` 的邮件必填项、`applyPlaceholders` 的 `{time}`、历史轮换不变。
- `test/bundle.test.mjs` 增补：客户端注册 id / 标签 / API 前缀 / SETTINGS_NS 均已改名；新文案存在。
- 端到端（真机）：用 465 与 587 各发一封到用户自己的邮箱，确认中文主题与正文可读。
