# js-yaml 5.x 打爆 patch 引擎：`jsyaml.Type is not a constructor`

> 2026-10-13。涉及 `dsh-plugin-manager` 宿主半 `src/host-core.js` 的 `buildPatchSchema` / `probeYamlEngine` / `makeYamlEngine` 与 `src/index.js` 的 `requireProfileYaml` / `ensureYaml` / `applyHost`（修复随 0.3.14 落地）。上一篇 [2026-10-13-local-plugin-panel-json-error.md](2026-10-13-local-plugin-panel-json-error.md) 做到的是「让失败可见」，本篇才是真凶。

## 症状

「本地插件」面板：重启 DSH 后仍是宿主端点 404（面板文案「插件宿主没有响应（HTTP 404）…」），三个批量按钮计数全 0。「刷新」无效。`<profile>/.plugin-manager/host-diag.json` 里：

```json
{ "endpointsRegistered": false, "httpMounted": false,
  "applyError": "jsyaml.Type is not a constructor",
  "applyErrorStack": "TypeError: jsyaml.Type is not a constructor | at makeYamlEngine (…/src/host-core.js:462:22) | at readWorkspaceDoc (…/src/index.js:423:18) | at workspaceSnapshot (…/src/index.js:438:16) | at applyHost (…/src/index.js:1535:15) | at new apply (…/src/index.js:1521:5) | at Fiber.execute (…/@deepseek-ai/cordis/lib/index.js:1068:24)" }
```

## 根因链

1. profile（`desktop`）顶层解析到的 `js-yaml` 是 **5.4.3**，而它**不是本包的依赖** —— 是 **`dsh-mcp-manager` 的传递依赖**（pnpm hoisted 到 profile 顶层）。本仓库任何目录都**没有** `js-yaml`（`require.resolve('js-yaml')` 在 `dsh-plugin-manager/` 下报 `Cannot find module`）。
2. 0.3.13 的 `makeYamlEngine` 按 **4.x API** 写：`new jsyaml.Type('tag:yaml.org,2002:js', { kind:'scalar', resolve, construct, predicate, represent })` + `jsyaml.JSON_SCHEMA.extend(...)`。v5 **删掉** `Type`（`typeof require('js-yaml').Type === 'undefined'`，已实测断言），并把扩展 schema 的方式换成 `defineScalarTag()` + `Schema.withTags()`。
3. **抛点位置决定爆炸半径**：`applyHost()` 开头就 `workspaceSnapshot(c0)` → `readWorkspaceDoc()` → `makeYamlEngine()`，异常发生在**挂 HTTP 路由之前** ⇒ 冒泡出 `apply()` ⇒ cordis 回滚本插件**全部 effect**（含 `/__dsh-plugin-manager`）。客户端半不依赖宿主半，面板照常渲染，只是每次 fetch 都 404 空体。

## 为什么「七支测试全绿」没兜住

假替身写得太成功：所有管理器测试要么注入假 engine、要么（`debounce.test.mjs`）虽把真 js-yaml junction 进临时 profile，却从没**断言引擎能建出来**。而 0.3.13 之前没有任何测试用真 js-yaml 建过 schema —— 只要有一条，这个 bug 当场就红。教训：**测依赖兼容性必须真建一次引擎**，别只测「功能没抛」。

## 两代 API 对应（照抄够用）

| 4.x | 5.x |
|---|---|
| `new Type(tag, { kind:'scalar', resolve, construct, predicate, represent })` | `defineScalarTag(tag, { implicit:false, resolve(source), identify(data), represent(data) })` |
| `JSON_SCHEMA.extend(type)` → schema | `JSON_SCHEMA.withTags(tag)` → schema |
| `resolve` = 字面量检查；`construct` = 建对象 | `resolve(source, isExplicit, tagName)` **就是** construct 角色（返回 `NOT_RESOLVED` 表示不认） |
| `predicate(data)` | `identify(data)` |
| `dump(rows, { schema, lineWidth: 120 })` | 同上（`lineWidth` 仍在，默认 80） |

## 修法（0.3.14）

- `host-core.js`：新增 `buildPatchSchema(jsyaml)` —— **特征探测**两族 API（`Type`+`JSON_SCHEMA.extend` → `flavor:'type-extend'`；`defineScalarTag`+`JSON_SCHEMA.withTags` → `'define-tag'`），都不认识则返回 `{schema:null, error:'unsupported js-yaml API: need 4.x (…) or 5.x (…)'}`；新增 `probeYamlEngine()` 供「先判定再做任何事」；`makeYamlEngine()` 保留抛错契约，但调用点已被 probe 挡掉。
- `index.js`：`requireProfileYaml()` 在 load/dump 之外增加**能力校验**，返回 `reason='missing'（可自动安装）| 'unsupported'（不可）`；`ensureYaml()` 遇 `unsupported` **不装 `js-yaml@^4.1.0`**（profile 那份是 `dsh-mcp-manager` 的传递依赖，覆盖它会连累别人的依赖树）。
- `applyHost()`：诊断与全部 YAML 消费**后移到 `mountHttp()` 之后**，workspace 快照各自 try/catch —— 传输层不该被数据层的失败拖走；`/status` 与诊断文件新增 `yamlVersion` / `yamlFlavor` / `yamlError`。

## 验证（真 js-yaml 5.4.3 + 真 profile patch）

- `probeYamlEngine(v5)` → `{ok:true, flavor:'define-tag'}`；真 `cordis.patch.yml`（607 行 / 15957B）`loadText` → `dumpText`（15777B）→ `loadText` **deepEqual 无损**。
- `!!js` 往返保持：`flag: !!js process.env.DSH_FLAG` → `{__jsExpr:'process.env.DSH_FLAG'}` → 写回仍是 `!!js process.env.DSH_FLAG`。
- ⚠️ **格式漂移**：v5 的 dump 与磁盘上（4.x 生成）的 patch **同位置 64/606 行不同**（行数 606→600）——语义无损，但升级后**第一次写 patch 会有一次性整文件 diff**（`*.bak-<ts>` 备份照旧）。
- 新增 `dsh-plugin-manager/test/yaml-engine.test.mjs`（9 checks）：v5 形状 stub（并断言旧路径 `new api.Type(...)` 在该形状下确实抛）、v4 形状 stub、未知形状的可读错误、真库往返、以及**真 `apply()`** 在 v5 profile 与不可识别 profile 上都必须挂住路由且零安装。

## 复查最短路径

1. 离线：`node dsh-plugin-manager/test/yaml-engine.test.mjs`（真 js-yaml 走 profile；取不到就 SKIP 那一段，stub 段照跑）。
2. 真机：`dsh plugin --profile desktop update` → 重启 → 面板恢复；仍红字就读 `host-diag.json` 的 `yamlVersion` / `yamlFlavor` / `yamlError`。
