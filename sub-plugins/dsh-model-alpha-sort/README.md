# dsh-model-alpha-sort

把「设置 → 模型」里每个提供方的**模型目录按显示名（首字母）重排**。因为宿主 `buildModelCatalog` 就是按 `llm.listModels` 的顺序组装目录，数组顺序一变，**设置页列表、composer 模型选择器与 `/model` 弹窗会同时变成字母序**。

- 写操作只有一处：`settingsController.mutate(ns, [{ op: 'set', path: [...settingsPath, 'models'], value }], revision)`。
- 不新增/删除/改写任何模型字段；默认模型按 **id** 记录，重排不会改变默认选择。
- 幂等：数组已按当前规则有序时**一次写入都不发生**。

```
设置 → 模型 →（卡片列表底部）
┌──────────────────────────────────────────────┐
│ 模型排序                                      │
│ 把每个提供方的模型目录按显示名重新排列：…      │
│ 可排提供方 1   模型 54   待排序提供方 1       │
│ 当前规则  排序键 显示名 · 升序 · locale zh-CN │
│ 启动排序  已完成（1 处）                      │
│ codemaker · 用户段模型 · 54 个                │
│ [立即按首字母排序] [刷新状态]                 │
└──────────────────────────────────────────────┘
```

## 为什么需要它

官方设置页对模型目录只提供**拖动排序**（`调整模型顺序` / `拖动排序，或使用上下方向键调整顺序。`）。本机 codemaker 一个提供方就有 54 个模型，靠拖拽或反复按方向键排成字母序不现实；而核心没有「按名称排序」的配置项，`buildModelCatalog` 也只是原样保留 `listModels` 顺序。

本插件把「按显示名排序」做成一次可重复的动作：启动时自动跑一遍，之后随时可以在卡片上再点一次。

## 安装 / 启停

本插件由仓库的**本地插件管理器**（`dsh-plugin-manager`）统一安装与启停，**不要**单独用 `dsh plugin add` 装它：

1. 只装管理器一次（仓库根就是它的安装外壳，两种入口等价）：
   ```bash
   dsh plugin --profile web add git+https://github.com/Chen5173/dsh-plugins.git
   # 或 dsh plugin --profile web add <本机仓库根>   # 本机开发：改代码即时生效
   ```
2. 重启 `dsh web`，打开设置 →「本地插件」。
3. 在面板里打开本插件的主开关。管理器会写入激活行；宿主半**即时生效**，带界面的卡片**刷新一次页面**后出现。

- **停用**：面板里关掉主开关（行内写 `disabled: true`，可随时再开）。
- **卸载**：面板里点「移除」（删激活行 + 摘依赖；仓库里的源码目录保留）。

### ⚠️ 不要用 `dsh plugin add` 装/卸本子插件

- **装**：本子插件包不声明 `dsh.bundle`，`dsh plugin --profile web add <本子插件目录或包名>` 只会把它装成 profile 的普通依赖（打印 `declares no dsh.bundle — installed as a plain dependency, not a profile layer`），**不会激活它**。
- **卸**：`dsh plugin --profile web remove <子插件包名>` 只摘依赖、**不会删除管理器写的激活行**——残留的悬空行会让下次 `dsh web` 启动失败（`failed to import loader entry …: Cannot find package …`）。卸载请用面板「移除」。

**版本要求**：需要核心带 `settingsController` 服务与 `llm.listConfigurableProviders()` 的 0.2.0 线（`^0.2.0-rc.1`）。

## 排序在哪生效

三处使用的是同一份顺序：

| 位置 | 顺序来源 |
| --- | --- |
| 设置 → 模型 → 提供方卡片里的模型目录 | 设置文档用户段的 `models` 数组 |
| composer 里的模型选择器（`ModelSelect`） | `buildModelCatalog` → `llm.listModels` → 同一数组 |
| `/model` 弹窗 | 同上（与 composer 同源） |

> provider（提供方）之间的顺序不归本插件管：核心固定把 `deepseek-account`、`deepseek-official` 排在最前，其余按目录顺序。

## 怎么用

### 启动时自动排序

宿主半在 `apply()` 后依次在 **1.5s / 5s / 12s** 三个时间点尝试一次；成功后不再重试，失败（例如设置文档短暂不可用）会继续下一个时间点。三次都失败时卡片上的「启动排序」一行会显示原因。

想关掉：把配置里的 `sortOnStartup` 设成 `false`（见下节）。

### 卡片上的「立即按首字母排序」

打开设置 →「模型」，页面最底部（提供方行与「添加模型」之后）就是本插件的卡片：

- 统计行：**可排提供方 / 模型总数 / 待排序提供方**；
- 规则行：当前排序键、方向与 locale；
- 提供方 chip：**只列出有模型的提供方**（数组非空才显示），空的或没有模型数组的条目不再占位置；状态文案为 `用户段模型` / `继承清单（未开启排序）` / `继承清单（将写入）`；
- 按钮：`立即按首字母排序`（写一次设置）与 `刷新状态`（只重读，不写）。

写入成功后会重新读取状态，统计里的「待排序提供方」应变成 0。

## 配置

配置写在设置文档里，命名空间就是条目 id：

```yaml
dsh-model-alpha-sort:
  sortBy: name          # name | id，默认 name
  direction: asc        # asc | desc，默认 asc
  collation: zh-CN      # Intl.Collator 的 locale，默认 zh-CN
  sortOnStartup: true   # 启动时自动排序，默认 true
  includeInherited: false # 是否连「继承清单」一起排，默认 false
```

- **`sortBy: name`**：取模型的显示名排序；显示名为空字符串时**回退到模型 id**。
- **`collation`**：中文显示名按拼音排序；数字按数值比较（`v10` 排在 `v9` 之后），大小写不敏感。非法 locale 会回退到默认排序，不报错。
- **`includeInherited`**：默认只排「用户段里**已经存在** `models` 数组」的提供方。继承自基础配置的模型清单默认**不动**——要排它必须先打开这个开关，插件会把排好序的清单写进用户段。

## 排序规则

1. 取排序键：`sortBy === 'name'` 时用 `name.trim()`，为空回退 `id`；`sortBy === 'id'` 时直接用 id。
2. 用 `Intl.Collator(collation, { numeric: true, sensitivity: 'base' })` 比较。
3. 键相同时按 id 再比一次，保证结果稳定。
4. `direction: desc` 对最终顺序取反。
5. 只改数组顺序，**不改任何模型字段**；数组元素对象原样保留（含 `reasoningEfforts` 等隐藏字段）。

## 降级与冲突

- **只读部署**（`settings.describe().writable === false`）：不写入，状态里如实标 `writable: false`。
- **并发编辑**：写设置时带 `revision`，撞上 `settings/conflict` 时卡片提示「设置文档刚被别处改过，请再点一次」，不重试、不覆盖别人的改动。
- **`settingsController` 缺席**：宿主半静默不写，卡片显示「宿主半未就绪：设置服务不可用。」
- **`webServer` 缺席**：端点不注册，卡片显示端点不可用；宿主半的启动排序仍会尝试（它不依赖 HTTP）。
- **`llm` 服务缺席**：拿不到 provider → settingsNs 的映射，插件不猜，状态里返回空清单。

## 诊断

| 端点 | 方法 | 用途 |
| --- | --- | --- |
| `/__dsh-model-alpha-sort/status` | GET | 只读状态：`{ ok, code, writable, options, totals, providers, startup, http, lastRun }` |
| `/__dsh-model-alpha-sort/sort` | POST | 执行一次排序，返回 `{ ok, changed, skipped, writes, totals }` |

两个端点都要求：

- 请求头 `x-dsh-plugin: dsh-model-alpha-sort`（防其它页面/插件误触）；
- 同源：`Origin` 缺席或与 `Host` 同源（否则 403 `forbidden-origin`）；
- 未知路径 404、方法不对 405。

`status.startup` 里能看到启动排序的状态：`ok / running / attempts / pending / lastError`；`status.http` 里是 `{ mounted, reason }`。

## 测试

```bash
node sub-plugins/dsh-model-alpha-sort/test/sort.test.mjs     # 23 条纯逻辑断言
node sub-plugins/dsh-model-alpha-sort/test/bundle.test.mjs   # 28 条 bundle + 宿主半断言
```

两支测试都离线运行，不起服务器、不写真实 profile。

## 已知限制

- **不监听设置变更**：排序只在「启动」与「点按钮」时发生。这样手动拖出来的顺序不会被插件立刻改回去——这是刻意的。
- **只排配置里有的模型**：适配器自动发现、不在 `models` 数组里的模型（例如 DeepSeek 官方目录）不参与。
- **只改顺序，不改默认模型**：默认模型按 id 记录，重排不影响它。
- **provider 之间的顺序固定**：`deepseek-account` / `deepseek-official` 永远在最前，其余按目录顺序。

## 文件

```
sub-plugins/dsh-model-alpha-sort/
├── package.json
├── src/
│   ├── index.js     # 宿主半：collect / sortNow / HTTP 端点 / 启动排序
│   ├── sort.js      # 纯排序逻辑（零依赖）
│   └── client.js    # 设置页卡片（settings.models.footer）
├── test/
│   ├── sort.test.mjs
│   └── bundle.test.mjs
├── README.md
└── ACCEPTANCE.md
```
