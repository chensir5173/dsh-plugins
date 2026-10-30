# dsh-mcp-manager 的只读降级：官方模板的 `[]` 与行级解析器的分歧（2026-10-30）

## 现象

设置 → MCP 服务器 页面顶部黄框：

> 只读降级 · patch 文件无法解析，宿主已进入只读；所有写端点都会被拒绝，文件不改、也不产生备份。修好 YAML 后点「重新读取」。

```
dsh-tui: E_NOT_SEQUENCE: 第 4 行不是顶层数组条目（patch 必须是顶层 YAML 数组）：[]
headless: E_NOT_SEQUENCE: 第 4 行不是顶层数组条目（patch 必须是顶层 YAML 数组）：[]
```

两个 profile 的 `cordis.patch.yml` 各 217 字节、内容完全相同：前 3 行注释，第 4 行 `[]`。

## 谁对谁错：数据是官方的，插件才是 bug

- `C:\Nt\dsh\packages\boot\app-boot\src\profile.ts` 的 `PROFILE_PATCH_TEMPLATE` 逐字包含：

  ```
  # Your patch layer for this dsh profile, applied after every bundle layer:
  # a top-level YAML array of loader patch entries (id-targeted config
  # overrides, disables, and insert lists; `!!js` expressions allowed).
  []
  ```

  `initProfile()` 在 profile 不存在 patch 文件时写入该模板 ⇒ **每个新 profile 天生就是「注释 + []」**。

- `packages/boot/app-boot/src/index.ts` 的 `parsePatchList` 只做两件事：

  ```ts
  parsed = yaml.load(content, { schema: userPatchesSchema })
  if (!Array.isArray(parsed)) throw new Error(`${binName}: ${label} ${file} must be a top-level YAML array of loader patch entries`)
  ```

  实测：`yaml.load('[]\n')` → `[]`（合法空数组，通过）；`yaml.load('# only comments\n')` → `null`（**被拒**）。

⇒ 结论：`[]` 是合法文档，插件的行级解析器把它当非法行才是根因。**「删掉 [] 只留注释」是错误的治标**——会让官方 loader 直接抛错。

## 影响面比看起来大

`src/index.js` 的 `assertParsable(sources)` 遍历 `[sources.home, ...sources.profiles]`，任一 `parsePatch` 失败就抛 `patch-unparsable`：

- 不是「这个 profile 只读」，而是**整台机器所有写端点只读**；
- 只要机器上有一个新建 profile（dsh-tui / headless 都是），home 层也写不了。

## 修法（host-core.js）

1. 接受「独占的顶层 `[]`（`[ ]` 等价）」作为空文档占位：只放过与注释/空行共存的情况；`[]` 与 `- id:` 条目混排仍报 `E_NOT_SEQUENCE`（flow 空序列后不能接块序列，官方也会解析失败）；两处 `[]` 也拒绝。
2. `parsePatch` 返回 `placeholderLine`（0 基，无则 `-1`）。
3. `applyUpsert` 新建条目分支：先摘掉占位行再追加块，否则会产出 `[]` + `- insert:` 的非法文档。
4. `planRemove`：删除后若文件只剩注释/空行，回填一行 `[]`（`ensureArrayDocument`）——这半条同样属于官方语义，之前一直漏着：删掉最后一条 MCP 定义后，home patch 会变成官方 loader 拒绝的形状。

## 验证（离线，真实文件只读）

- `parsePatch` 真实 dsh-tui / headless：`ok=true, entries=0, placeholderLine=3`；home `ok=true, entries=3`。
- 模板上 `planUpsert` 一条 → 产物 `yaml.load` 得长度 1 的数组、id 正确、无残留 `[]`。
- 再 `planRemove` → 文本与模板**逐字一致**（注释保留 + `[]` 回填）。
- `sub-plugins/dsh-mcp-manager/test/host-core.test.mjs` 43/43（新增 6 条 ⑨ 组用例）。

## 教训

行级 YAML 编辑器必须与真解析器对齐「什么算合法文档」：空数组、flow 序列、文档分隔符这些形态在官方模板里是常态，不能用「只认块序列条目」的假设去否定整个文件。
