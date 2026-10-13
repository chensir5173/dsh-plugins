# 「本地插件」面板报 `Unexpected end of JSON input`：404 端点 + 客户端无兜底

> 2026-10-13。涉及 `dsh-plugin-manager` 客户端半 `src/client.js` 与宿主半 `src/index.js`（修复随 0.3.13 落地）。

## 症状

设置 → 左侧「本地插件」→ 「本地插件」tab 顶部红字：

```
出错: Failed to execute 'json' on 'Response': Unexpected end of JSON input
```

三个批量按钮计数全是 0，点「刷新」无效。

## 可复用结论（这才是本篇的价值）

1. **面板可见 ≠ 宿主半已注册 HTTP 路由**。客户端半由 `dsh-client-modules` 打好的模块表（`dsh-app://app/plugins/…`）加载，宿主半由 profile loader 条目加载，两条路径互不影响：宿主半的条目 import 失败或 effect 被回滚，面板照样渲染，只是每次 fetch 都落空。
2. **浏览器原生文案 `Failed to execute 'json' on 'Response'` 只说明「对空体调了 `res.json()`」**。旧 `load()` 写的是 `const json = await res.json()` 在前、`if (!res.ok …)` 在后 ⇒ 404（空体）/ 502（HTML 错误页）/ 断连一律落进这条文案，那行 `res.ok` 检查形同虚设。**任何「先 json 再判 ok」的 fetch 都是同一个坑**：先判 `res.ok`，再把 `res.json()` 包进 try/catch。
3. **`ctx.get('webServer')` 可能返回 `null`**，而旧写法 `const ws = ctx.get('webServer'); if (ws !== undefined) registerHttp(ctx, ws, config)` 把 **null 当成「服务可用」**放行 ⇒ `registerHttp` 里 `if (!host || typeof host.register !== 'function') return` 静默返回 ⇒ 路由永不注册，且**永不尝试** `ctx.inject(['webServer'])` 兜底。正确形态：真值判断 + 幂等挂载 + inject 兜底。
4. **`ctx.effect()` 内 `host.register()` 抛错会拖垮整个插件**。典型错误是 `webserver: duplicate route "/__dsh-plugin-manager"`（live patch reload 后旧注册未释放）：异常冒泡出 `apply()` ⇒ cordis 回滚本插件**全部** effect（路由随之消失），而**已发生的文件/进程副作用不回滚**。修法是就地 try/catch 并记录原因，绝不让它冒泡。
5. 诊断只能**自己落盘**：宿主没有插件可读的「loader 条目状态」接口，外部也取不到（见下）。

## 修法（0.3.13）

- `src/client.js` `load()`：fetch 包 try/catch → `hostOffline`（DSH 可能正在重启）；`if (!res.ok)` 前置，404 → `hostDown`、其它非 JSON → `hostNotJson`；`res.json()` 兜底 `null`。字典键 zh/en 各 3 条。
- `src/index.js`：`apply()` 拆成外层 `apply()`（全 catch，记 `applyError`/`applyErrorStack`）+`applyHost()`；settings 段整体 try/catch（记 `settingsError`，`ctx.get('settings')` 也移进去，防服务 getter 抛错；`installSection` 对外来 ns 抛 `No configurable plugin entry` 也在此吞掉）；webServer 走幂等 `mountHttp()` + `ctx.inject(['webServer'])` 兜底；`ctx.effect` 内 register 加 try/catch，失败记 `httpSkipped='register failed: …'` 并返回空 cleanup。
- **诊断落盘** `writeHostDiag()` → `<profileDir>/.plugin-manager/host-diag.json`（HOST_DIAG 快照 + `at`/`pid`）。**只在 `profileDir !== repoRoot` 且目录里有 `cordis.yml`/`cordis.patch.yml` 时写** —— 否则单测跑在仓库根，会把诊断文件散落到源码树里。
- 回归：`test/bundle.test.mjs` 的 `listMode: 'ok' | 'http404' | 'badjson' | 'offline'` 三条用例断言面板**不再出现**浏览器原文案；`test/entry-config.test.mjs` 三条新用例锁住 null webServer / settings getter 抛错 / duplicate route。

## 取不到的证据（别再重复尝试）

- **外部读 loader 条目状态不可行**：`POST|GET /api/pluginInventory/list`（及 `.list`、`%2F` 变体）一律 **401 `unauthorized`**（12 字节）。`dsh-client-connection` 除 loopback + `isTrustedApiRequest`（`origin` 缺失即放行、`sec-fetch-site: cross-site` 拒绝）外，还要 `browser-session` cookie。官方 `pluginInventory` 只在该 GUI 内可见 —— 让用户打开官方「插件」设置页看，比自己绕路便宜。
- **崩溃日志里没有条目加载错误**：`%APPDATA%\@deepseek-ai\dsh-desktop\logs\crash-*-host.log` 只有无关报错；`cordis-plugin-loader` 的 `Entry._init()` 对 import 失败只 `this.ctx.logger.error(error)` 后 `return`（不抛、不中断启动），这条 logger 未落到可读文件。
- 进程级取证在本机被拒（`Get-CimInstance`、`tasklist /fi … /m`、`Get-Process | .Path` 全 Access denied）⇒ 别在这上面花时间。

## 验证路径

1. 重启 DSH：面板恢复 ⇒ 一次性 apply 失败；仍红字 ⇒ 读 `C:\Users\<用户>\.dsh\profiles\<profile>\.plugin-manager\host-diag.json`，看 `httpSkipped`（路由为何没挂）与 `applyError`（apply 为何抛）。
2. ⚠️ **profile 里装的是 git 快照**（`dependencies` 为 `github:chensir5173/dsh-plugins`）：改仓库源码**不即时生效**，需 `dsh plugin --profile desktop update`（或改用本地路径入口）。
3. **当时的假设已被证实（同日）**：重启后仍 404，`host-diag.json` 抓到 `applyError: jsyaml.Type is not a constructor`（`makeYamlEngine` ← `readWorkspaceDoc` ← `workspaceSnapshot` ← `applyHost`）——真凶是 profile 顶层解析到的 **js-yaml 5.x**（`dsh-mcp-manager` 的传递依赖）。完整根因链、两代 API 对应与修法见 [2026-10-13-js-yaml-v5-patch-engine.md](2026-10-13-js-yaml-v5-patch-engine.md)。
