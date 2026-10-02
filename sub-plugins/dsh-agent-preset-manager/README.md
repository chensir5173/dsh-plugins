# dsh-agent-preset-manager

在 **设置 →「本地插件」** 页里多一个「Agent 预设」tab：把本地目录里的 agent preset 在**运行期**声明给当前 DSH 会话，并支持启用/停用、新增、编辑组合、删除、导入与旧目录迁移。旧版 `~/.dsh/.agent-presets` 目录继续被兼容读取。

DSH 0.2.0 起 agent preset 改由 bundle/profile 清单驱动，散落在本地的 preset 目录不再被自动读取。本插件**不改写 profile 清单**（`cordis.patch.yml` / `package.json` / `dsh.profile.bundles` 一律不碰），而是走宿主注册表 `agentPresets.register({ id, name, description, order, plugins })` 在运行期声明，停用时用返回的句柄 `dispose()` 撤销。

## 为什么是运行期声明，而不是改写 profile

1. profile 的 `cordis.patch.yml` 由 `dsh-plugin-manager` 独占维护（它写入每个插件的 `insert` 行与 `disabled` 位）；第二个人再写同一个文件必然互相覆盖。
2. 预设是**会话级**概念，写进 profile 会让「临时试一个预设」变成「改我的 DSH 安装」。运行期声明随进程结束而消失，磁盘目录才是唯一的真源。
3. 声明失败（重名、组合为空、宿主没有注册表）必须能被如实回报，而不是留下一个半改的 profile。

**因此本插件的作用域是**：读 `$DSH_HOME` 下的预设库、校验磁盘上的组合、按需声明/撤销，并把「启用状态」记在 `$DSH_HOME/agent-preset-manager/state.json`（重启 `dsh web` 时按它自动重新声明；首次运行不启用任何东西）。

## 行为

| 情况 | 表现 |
| --- | --- |
| 打开 tab（设置 →「本地插件」→ Agent 预设） | 面板显示预设库路径、运行期能力、每个预设一张卡片（id、名称、行数、库标签、状态标签、问题列表、开关） |
| 宿主注册表可用 | 顶部显示「运行期声明可用」，卡片开关可切换 |
| 宿主注册表缺席（DSH 0.1.x / 未 adopt） | 横幅提示「当前 DSH 版本不支持运行期声明，只能查看与编辑」；面板照常可读可编辑，写操作返回明确原因 |
| 启用 | 读 `preset.yml` + `agent.cordis.yml` → 校验 → `registry.register(...)` → 写 `state.json` 的 `enabled` 列表 → 卡片变「已启用」 |
| 启用失败 | 目录不存在 / 组合为空 / 没有插件行 / 注册表重名（文案追加「宿主里已经有一个同名声明」）/ 状态写盘失败（**回滚刚做的声明**）都如实回报 |
| 停用 | 用启用时拿到的句柄 `dispose()` 撤销声明，并从 `state.json` 移除该 id |
| 重启 `dsh web` | 启动时按 `state.json` 逐个重新声明（只报告结果，不静默补写）；首次运行 `enabled` 为空 |
| 新增预设 | 面板给 id / 名称 / 说明 / order；骨架取自**内置 standard 预设**的插件清单（`standard.patch.yml` 里 `preset-standard` 行的 `config.plugins`）；id 校验（1-64 位小写字母/数字/短横线/下划线，字母数字开头）、同名拒绝、读不到骨架就**整体取消**（不留半个预设） |
| 编辑组合 | 面板直接编辑 `agent.cordis.yml` 原文，保存前依次校验：空文本、YAML 可解析、至少一行插件、行 id 不重复 |
| 保存 | 通过校验后先写轮换备份（`<预设>/.backup/agent.cordis.yml.<时间戳>`，只保留 3 份），再原子写（临时文件 + rename） |
| 保存被拒 | 校验失败或备份写不下去时**原文件零改动**（磁盘与面板内容始终一致） |
| 保存已启用的预设 | 不热重载：已声明的预设保持原样，需要停用再启用才会用上新组合（面板提示） |
| 删除 | 需要二次确认；确认后先撤声明 → 从 `state.json` 移除 → 删预设目录；撤声明失败则中止（不删目录）；目录删不掉时如实警告（`dirRemoved: false`），不回滚声明状态 |
| 导入目录 | 先 preflight（回报 id、行数、来源与目标路径、组合能否解析、是否撞名），确认后才复制；目录里的附带文件（如 `helper.mjs`）一并复制 |
| 迁移旧目录 | 把 `$DSH_HOME/.agent-presets` 下的预设复制进 `agent-presets`（**原目录保留**）；先给预检列表（每个 id 标「可迁移 / 撞名」+ 行体检），确认后写新库 |
| 两个目录里同名 | 旧目录优先：卡片标「旧目录优先」，新目录那份不生效 |
| 组合坏了 | 状态显示「组合有问题」，开关拒绝（先修文件） |
| `preset.yml` 坏了 | 卡片照常显示并提示元数据错误（不影响启用判定） |
| `state.json` 里记着但目录没了 | 生成一条「目录不存在」的伪行，便于发现被手工删掉的预设 |

## 目录与文件

```text
$DSH_HOME                       # 默认 ~/.dsh，可用环境变量 DSH_HOME 覆盖
├── agent-presets/              # 新预设库：每个 id 一个目录
│   └── <id>/
│       ├── preset.yml          # 可选：name / description / order
│       ├── agent.cordis.yml    # 组合：- insert: / - id: preset-standard / config.plugins
│       └── .backup/            # 保存时的轮换备份（保留 3 份）
├── .agent-presets/             # 旧目录：继续被读取，可用「迁移旧目录」搬进新库
└── agent-preset-manager/
    └── state.json              # { version: 1, enabled: [...], updatedAt }
```

## 端点（宿主半，前缀 `/__dsh-agent-presets`）

| 方法 | 路径 | 作用 |
| --- | --- | --- |
| GET | `/state` | 全量快照：`libraries` / `runtime` / `presets`（含体检 verdict 与 problems） |
| GET | `/file?id=<id>` | 读某个预设的 `agent.cordis.yml` 原文（面板编辑器用） |
| POST | `/set-enabled` | body `{ id, enabled }`，声明或撤销 |
| POST | `/create` | body `{ id, name?, description?, order? }`，骨架播种 |
| POST | `/save` | body `{ id, text }`，校验 + 备份 + 原子写 |
| POST | `/remove` | body `{ id, confirm }`；未带 `confirm: true` 只回报 `needsConfirm` |
| POST | `/import` | body `{ sourceDir, id?, confirm }`；未带 `confirm` 只做 preflight |
| POST | `/migrate` | body `{ confirm }`；未带 `confirm` 只回报 `plans` |

请求体是 JSON（上限 4 MB）。**所有响应都是 JSON**：拒绝时 HTTP 400、响应体仍是 `{ ok: false, error, state }`，所以客户端必须解析 body 而不是只看状态码；方法不符 → 405，非法 JSON → 400，未知 action → 404，未捕获异常 → 500（带尽力采集的 `state`）。

## 入口（tab 注册）

核心 `ui-settings-plugins` 独占「本地插件」设置行并渲染 tab 外壳，本插件在它声明的 `settings.localPlugins.tab` 列表槽里注册一个 tab：id `agent-presets`、order `20`、label「Agent 预设」。核心没有这个槽（旧版本）时注册被跳过，插件其它功能不受影响；本插件**不**注册 settings 导航行。

## 安装与启用

与仓库内其它子插件一致，一律走管理器面板：设置 →「本地插件」→ 打开本插件开关（管理器会把它写进 profile 的激活清单）。**不要**用 `dsh plugin --profile web add` 装子插件（不会激活）。

```bash
# 面板启用后应能查到本插件的激活行（管理器写入）
dsh --dump-config --profile web | grep -n agent-preset-manager
```

## 边界与降级

- **不碰 profile**：不改 `cordis.patch.yml`、不改 profile `package.json`、不改 `dsh.profile.bundles`。
- **注册表缺席即只读**：DSH 0.1.x 或未 adopt 时面板可看可编辑，启用/停用返回明确的不可用原因。
- **`webServer` 缺席**（终端 / Electron）：端点注册被跳过而不是抛错。
- **迁移是复制**：旧目录不被删除，由用户自行决定何时清理。
- **启用状态以 `state.json` 为准**：面板不会因为文件被手工改动而谎报。

## 测试

```bash
cd sub-plugins/dsh-agent-preset-manager
node --test test/bundle.test.mjs   # 宿主半：库扫描/体检/组合/状态/启用回滚/新增/保存/删除/导入/迁移/HTTP
node --test test/client.test.mjs   # 客户端：tab 注册 + 面板渲染与请求
```

两个测试都离线可跑，不启服务器、不碰正在运行的 profile。
