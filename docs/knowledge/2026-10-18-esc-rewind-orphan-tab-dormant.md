# esc-rewind 孤儿回收入口休眠（UI tab 撤掉，能力保留）

日期：2026-10-18　相关：`sub-plugins/dsh-esc-rewind/`、`docs/plugins.md`

## 结论（可复用）

用户说「子代理孤儿的功能暂时不用了，把 UI tab 先撤掉」时，**撤 UI ≠ 删能力**。最小改动 =
**只摘掉槽位注册，保留宿主端点 + 面板实现 + 文案**，并留出「一行接回」的恢复路径：

| 动作 | 状态 |
|---|---|
| `ctx.slots.inject(TAB_SLOT, () => ctx.slots.register({...}, OrphansPanel))` | **删除**（替换为带完整恢复片段的注释块） |
| 宿主端点 `GET /__esc-rewind/orphans`、`POST /__esc-rewind/orphans/stop|delete` | 保留（HTTP 可直接调用） |
| `OrphansPanel` 与 `fetchOrphans`/`stopOrphans`/`rescueOrphan`/`stopResultText` | 保留，照旧挂在 `__dsew._module`（可测试、可恢复） |
| i18n 键（`orphans.*`，中英各一套） | 保留（恢复即用，不用重写文案） |
| 常量 `TAB_SLOT` / `TAB_ID='subagents'` / `TAB_ORDER=50` | 保留（注释里指明恢复目标） |

## 必须同时改的三处「口径」

1. **诊断语义要能区分「有意不注册」与「注册失败」**：新增 `__dsew.orphanTabDormant = true`，
   `orphanTabRegistered` 保持 `false`、`orphanTabError` 保持 `null`。否则以后真出错时无法与休眠区分。
2. **测试断言跟着契约走**：注册数从 3 降到 2（`overlay + header`），原来靠「entry 存在」渲染面板的
   harness 改为**经导出内部件**取组件：

   ```js
   const entry = orphanTabEntry(services)              // 现在是 undefined
   const component = entry ? entry.component : internals()._module.orphansPanel
   ```

   这样面板逻辑的 20+ 条用例一条不删，继续覆盖（本次 96/96 全绿）。
3. **文档要写「休眠」而不是「删除」**：README 段落、`ACCEPTANCE.md` 第 6 节（界面项一律标 `[-]`
   并写明「因休眠暂缓，恢复后按原描述验收」）、`docs/plugins.md` 的槽位表都要注明入口已撤、
   端点仍在，避免下一个人以为功能被砍掉而重写。

## 恢复方式（一行）

把 `src/client.js` 里那段注释块（注释中给出了完整 `inject`+`register` 片段）接回来，刷新页面即可；
不需要动宿主半、不需要重启 GUI host（纯客户端注册）。

## 坑

- 本仓库测试文件的注释里存的是**转义反引号**（`\`` 字面量），用 `edit` 工具匹配多行注释时不要写普通反引号，
  否则 `old_string` 找不到（本次踩过）。文件是 CRLF，`edit` 本身能正确处理 CRLF。
- `settings.localPlugins.tab` 是**列表槽**：不注册就是「核心没有该槽的旧版本」同一条路径，
  「槽不存在」不算错误 ⇒ 休眠不会污染诊断。

## 证据

- `node sub-plugins/dsh-esc-rewind/test/bundle.test.mjs` → **96/96**（含改写后的休眠契约用例：
  无 tab entry、`orphanTabDormant===true`、`orphanTabError===null`、`orphansPanel` 及四个函数仍导出）。
- `docs/plugins.md` 槽位表已把 `dsh-esc-rewind`「子代理」（`subagents` 50）标为休眠。
