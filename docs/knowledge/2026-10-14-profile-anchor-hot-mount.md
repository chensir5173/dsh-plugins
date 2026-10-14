# 「本地插件」面板显示 .dsh-market、开关全关但功能在跑（dshmarket 热挂载双实例）

- 日期：2026-10-14
- 牵连版本：dsh-plugin-manager 0.3.14 → 0.3.15
- 触发者：dshmarket v1.66.15（第三方插件，profile `desktop`）
- 相关篇目：[2026-10-13-local-plugin-panel-json-error.md](2026-10-13-local-plugin-panel-json-error.md)、[2026-10-13-js-yaml-v5-patch-engine.md](2026-10-13-js-yaml-v5-patch-engine.md)

## 现象

用户报「明明功能界面的开关没有开启为什么功能是开启的」：

- 「本地插件」面板顶部写「目标 profile `.dsh-market`」；
- 8 个子插件全部标「未激活」、开关是关的；
- 点任意开关报 `copyfile '<DSH_HOME>\profiles\.dsh-market\package.json' … ENOENT`；
- 但 Agent 预设 / 空闲通知 / 重新生成标题 / 终端字体 / 子代理这些 tab 真的在工作。

## 取证

1. 活实例 HTTP（127.0.0.1:19387）：`GET /__dsh-plugin-manager/status` → 200，`profileName: '.dsh-market'`、`profileDir: '<DSH_HOME>\profiles\desktop\.dsh-market\'`、`patchFile: '<DSH_HOME>\profiles\.dsh-market\cordis.patch.yml'`（该目录不存在）、`endpointsRegistered: true`。
2. `<profile>/.dsh-market/hot-1.yml`（156B）：
   ```yaml
   - id: 'mkt-dsh-plugin-manager'
     name: 'file:///<…>/profiles/desktop/node_modules/dsh-plugin-manager/dsh-plugin-manager/src/index.js'
   ```
3. `<profile>/.dsh-market/log.ndjson` 尾部：用户 02:46:55 在 dshmarket 里 toggle on 了本插件（`re-added to dsh.profile.bundles, which nothing was composing (#696)`、`enabled row dsh-plugin-manager in <profile>/cordis.patch.yml`、`on ok=true`）。
4. `<profile>/.plugin-manager/host-diag.json`：`httpSkipped: register failed: webserver: duplicate prefix route '/__dsh-plugin-manager'`、`profileName: 'desktop'` ⇒ 这份诊断由**输了路由竞争**的那个实例写成（文件只保留最后一个写入者）。
5. `<profile>/cordis.patch.yml`（607 行）里**没有** `- id: dsh-plugin-manager` 行，但 8 条子插件激活行都在（:515 agent-preset-manager、:518 composer-history-recall、:521 composer-provider-label、:524 esc-rewind、:527 idle-hook、:530 session-time-bucket、:533 session-title-regenerate、:583 terminal-font）⇒ 「功能在跑」的真相源。
6. dshmarket 的 `src/hot.ts`：`HOT_DIR = '.dsh-market'`；`hotMount()` 写 `hot-<n>.yml` 后 `ctx.plugin(HotTree, { path: fileURL })`；`MarketHotTree extends Include`（override `write()` 为空实现）；`cleanHotDir()` 每次 market 启动清空该目录；挂载失败即 dispose + 删文件。

## 根因

1. hot 条目（id `mkt-dsh-plugin-manager`）与 bundle 条目解析到**同一个 `src/index.js` 文件 URL** ⇒ 同一 ESM 模块的两份 fiber：模块级状态（`HOST_DIAG`、一次性 latch、定时器）**共享**，而 `ctx.effect` / `register` 各一套 ⇒ 只有一个能持有 `(kind:'prefix', path:'/__dsh-plugin-manager')`。
2. `ctx.baseUrl` 对 hot 条目是 `<profile>/.dsh-market/`，而 0.3.14 的 `resolveContext()` 直接 `profileDir = fileURLToPath(baseUrl)`、`profileName = path.basename(profileDir)`，再用显示名拼 `patchFile` / `manifestFile` ⇒ 每一次读/写都落到不存在的 `<DSH_HOME>/profiles/.dsh-market/`。
3. 面板连的恰是**赢了路由竞争**的 hot 实例 ⇒ 用户看到的就是这个幽灵 profile 视角：列表空、开关 `ENOENT`、「未激活」全体，而真激活行在 desktop 里静静生效。

## 修法（0.3.15）

- `dsh-plugin-manager/src/host-core.js`：
  - `profileAnchorOf(home, dir)` —— 以 `path.resolve(home, 'profiles')` 为根，取 `path.relative(root, cur)` 的**首段**作为 profile 名（逐级上溯 ≤32 层，容忍尾分隔符与任意深度子路径）；不在 `profiles` 下返回 `null`。
  - `resolveProfile({ home, baseUrlDir, configured, dirExists })` —— 优先级：显式 `config.profile` 且**目录存在** → `ctx.baseUrl` 锚定 → 锚不上的原始目录（`source: 'baseUrl-raw'`）→ `configured`（目录不存在）→ 默认 `web`。
- `dsh-plugin-manager/src/index.js`：`resolveContext()` 改用上述纯函数；`patchFile = path.join(profileDir, 'cordis.patch.yml')`、`manifestFile = path.join(profileDir, 'package.json')`、`workspaceFile = path.join(profileDir, 'pnpm-workspace.yaml')` —— **显示名永不参与拼路径**；`/status` 与 `host-diag.json` 新增 `profileSource`；duplicate 情形的 `httpSkipped` 改写成 `another instance of this plugin already serves /__dsh-plugin-manager in this process — this fiber serves nothing (…)`；另导出 `__resolveContext()` 供测试。
- 边界取舍：不阻止第二次加载（那是 dshmarket 的行为），只保证**任一副本都定位到同一个真 profile**，因此 hot 实例写出的激活行与 bundle 实例读到的始终是同一份清单。

## 验证

```bash
foreach ($f in @('host-core','bundle','debounce','batch-remove-all','uninstall','root-install-shell','entry-config','yaml-engine','profile-anchor')) { & node "dsh-plugin-manager/test/$f.test.mjs" }
```

- `profile-anchor` 16 checks、`entry-config` 9、`yaml-engine` 9，其余 PASS（管理器 9 支全绿）。
- 端到端断言：`__resolveContext({}, 'file:///<…>/profiles/desktop/.dsh-market/')` → `profileName='desktop'`、`profileSource='baseUrl'`，且 `profileDir` / `patchFile` / `manifestFile` / `workspaceFile` **都不含 `.dsh-market`**；带 `config.profile='.dsh-market'`（无此目录）仍是 `desktop`。

## 遗留 / 教训

- 待真机：装 0.3.15 → 重启 DSH → 面板顶部应为 `desktop`、8 个子插件列出且开关与功能一致、`profileSource` 为 `baseUrl`。
- 即时恢复（无需改代码）：**重启 DSH** —— `cleanHotDir()` 每次启动清空 `.dsh-market`，bundle 层单实例接管，面板立刻正常。
- 教训 1：`ctx.baseUrl` 不是「profile 目录」的可靠同义词 —— 任何 Include 子树（免重启热挂载、子入口）都可能给出**子目录**；路径一律从可信目录派生，显示名只用于显示。
- 教训 2：同一文件 URL 被加载两次时，模块级单例（诊断、latch、定时器）被两份 fiber 共享，而 effect / 路由注册不会；`host-diag.json` 只保留最后一个写入者，因此它与界面显示不一致本身就是「双实例在场」的线索。
