# dsh-plugin-manager：把「替换」挪到 DSH 退出之后（安全更新）

日期：2026-10-14 ｜ 相关：`dsh-plugin-manager/src/safe-update.js`、`dsh-plugin-manager/ACCEPTANCE.md` A21

## 问题：更新插件会卡住 DSH Desktop

用户在 DSH 运行中更新插件后界面卡死，只能重启。取证结论有两条：

1. 更新就是 `pnpm` 在 **DSH 自己的进程内就地落盘**（市场 `.dsh-market/log.ndjson` 的 `event:update` 与 `exit=0` 可证），而 Windows 上 DSH 正在加载的文件被覆盖会 `EBUSY` / `EPERM`，pnpm 只能重试甚至停住；
2. 桌面版自带的官方管理器（`@deepseek-ai/dsh-plugin-manager` 0.2.0-rc.2）本身也是「运行中落盘 + reload + `restart-required`」语义，界面文案是「更改将在下次启动生效」。**运行中替换不是某个插件的 bug，是时机问题。**

## 契约：stage 与 apply 分开，且 stage 必须零副作用

- **stage（随时可做）**：只写 `<profileDir>/.plugin-manager/` 下的 `update-pending.json`（要更新谁、脚本路径、生成时的宿主 pid / 端口）与脚本 `apply-update.cmd` / `apply-update.sh`。**不跑 pnpm、不动 `node_modules`、不改 `package.json` / `cordis.patch.yml`** —— 这样面板能放心提供入口，失败也绝不会弄坏 profile。
- **apply（DSH 退出后）**：脚本等待「宿主 pid 消失 **且** 端口不再 LISTEN」（各超时，合计默认 300 秒）→ 备份 `package.json` / `pnpm-lock.yaml` → 逐目标 `pnpm add <规格>`（PATH 无 pnpm 时回退 `dsh plugin --profile <名字> add <规格>`）→ 写 `update-apply.ndjson` → 失败打印回滚命令并 pause。
- **参数只能由已声明的规格派生**：目标来自 manifest 的 `dependencies` / `devDependencies`，`link:` / `workspace:` / `file:` 归 `local-source` 排除，git 规格去掉 `#` 后的 ref、registry 规格 `<name>@latest`。面板只能勾选名字、传不进命令 ⇒ 无需再为「用户输入进 shell」设防。
- 生成记录里要**快照** pid 与端口：脚本运行在「生成之后的某次退出」，只能靠当时记下的 pid/port 判断宿主是否还活着。

## 面板与端点的落点（可复用的做法）

- 视图函数挂在 `listPayload()` 里（`index.js` 的 `/list` 与所有 POST 响应共用它），面板一次请求即可拿到状态，不必新增 `GET` 端点。
- 新端点插在既有的 `POST` 分派大 `if` **之前**（`/update/prepare`、`/update/cancel`），避免被更早的 `startsWith` 分支吃掉；失败用 400 + `{ok:false,error}`，成功返回整份 list payload 让客户端 `setData()`。
- 诊断要写进 `<profileDir>/.plugin-manager/host-diag.json`（`HOST_DIAG.safeUpdate`），这是在 DSH 外部唯一可读的状态入口。

## 验收怎么写才算数

断言「**零 pnpm 调用**（`__setPnpmRunner` 计数桩不变）+ `package.json` 与 `cordis.patch.yml` **字节不变** + `node_modules` 目录列表不变 + 只多出 `.plugin-manager/` 下的文件」，比断言脚本里的文案稳定得多；脚本内容只查少量硬锚点（`pnpm add "<派生规格>"`、`tasklist` 等待循环、`%PROFILE%` + 分隔符 + `package.json`）。测试 harness 直接复用 `test/debounce.test.mjs`：临时 `$DSH_HOME` + 真 `registerHttp` + 假 web 服务器 + 从真 profile junction 一份 `js-yaml`。

## 坑

- 在 `run_code` 里写含反斜杠的脚本文本会被转义吃掉（`%PROFILE%\package.json` 变成 `%PROFILE%package.json`）：用 `String.fromCharCode(92)` 拼分隔符，写完必须回读校验；
- `run_code` 里写 `delete require;` 会抛 `SyntaxError: Delete of an unqualified identifier in strict mode`，整个程序在写入前失败（文件根本没改，别以为改过了）；
- 长中文内容用「双引号行数组 + `join`」构造，不要用模板字符串。