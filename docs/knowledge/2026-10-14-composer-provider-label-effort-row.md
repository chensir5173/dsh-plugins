# composer-provider-label：菜单第三行「推理档」（effort）

- 日期：2026-10-14
- 代码：`sub-plugins/dsh-composer-provider-label/src/client.js`、`test/bundle.test.mjs`
- 规格：`openspec/specs/composer-provider-label/spec.md`
- 前置知识：[2026-10-03-menu-card-height-cap.md](2026-10-03-menu-card-height-cap.md)（卡片高度上限只能挂 `listClassName`）、[2026-09-09-dsh-composer-provider-label-picker.md](2026-09-09-dsh-composer-provider-label-picker.md)（Menu 原语 submenu 残废 ⇒ 自管 pane）

## 1. 需求

用户原话（m00001）：「再增加一行，出来provider和模型以外，再增加一个effort选择」。落地为：标签菜单根层由两行变三行（提供方 / 模型 / 推理档），并新增一个「推理档层」，让人**不离开 composer** 就能改本会话的推理档。

## 2. 目录契约：一个模型到底支持哪些档

`session/modelCatalog` 投影里每个模型形如：

```js
{ id, name, reasoning?: { efforts: [{ id, name, description? }], defaultEffort? } }
```

- **没有 `reasoning`** ⇒ 该模型不支持推理档（调用方不能拿它渲染档位）。
- **`reasoning.defaultEffort` 缺失** ⇒ 该模型存在一个「提供方默认」档，本插件用 **id 为空串**的选项代表它（与既有 `effectiveEffortOf` 返回 `undefined` 的口径一致）。
- **`reasoning.defaultEffort` 存在但不在 `efforts` 里** ⇒ 目录声明与档位清单不一致，仍然把它当成一个可选档追加到末尾（宁可多一项，也不静默丢掉当前档）。
- 档位名优先取 `level.name`，缺失回落 `level.id`；`level.description` 作为行内说明。

## 3. 实现

### 3.1 纯函数 `effortOptionsOf(model)`

```js
function effortOptionsOf(model) {
  const reasoning = model && model.reasoning
  if (!reasoning || typeof reasoning !== 'object') return []
  const levels = Array.isArray(reasoning.efforts)
    ? reasoning.efforts.filter((level) => level && typeof level.id === 'string' && level.id)
    : []
  const declared = typeof reasoning.defaultEffort === 'string' ? reasoning.defaultEffort : ''
  if (levels.length === 0 && !declared) return []
  const options = []
  if (!declared) options.push({ id: '', name: '', detail: '', providerDefault: true })
  for (const level of levels) {
    options.push({ id: level.id, name: level.name || level.id, detail: level.description || '', providerDefault: false })
  }
  if (declared && !levels.some((level) => level.id === declared)) {
    options.push({ id: declared, name: declared, detail: '', providerDefault: false })
  }
  return options
}
```

它把「目录里的一句声明」翻译成「一行可点的菜单项」，并已由 `__diag.pure.effortOptionsOf` 导出，测试直接打它（6 种目录形状：无 reasoning / 空 efforts / 有 default 无清单 / 无名档 / 只有 defaultEffort / default 缺于清单）。

### 3.2 三处落点

1. **根层第三行**（`client.js:1167-1169`）：`pushItem('effort', entryRow(__t('menu.effort'), effortValue), { action: () => setPane('effort') })`。该行**不置灰**（模型不支持时进去看说明，比点不动更好）。
2. **推理档层**：顶部「‹ 返回」+ 分隔线；`effortOptions` 为空时一行 `effort:none`（`disabled: true`，文案「该模型不支持推理档」）；否则每项行 id = `'effort:' + (option.id || 'default')`，当前档进 `selectedIds` 打勾，`disabled: !writable || !modelId`。
3. **写路径**：仍然只有 `__selectRoute` 一个调用点，参数为 `{ provider, model, ...(option.id ? { reasoningEffort: option.id } : {}) }`。

### 3.3 文案

5 个新 key（zh / en 双字典，key 必须一致）：`menu.effort`（推理档 / Effort）、`menu.effortNone`（不支持 / Unsupported）、`menu.effortUnknown`（未知 / Unknown）、`menu.effortDefault`（提供方默认 / Provider default）、`menu.effortEmpty`（该模型不支持推理档 / This model offers no reasoning tiers）。

## 4. 两个容易做错的地方

1. **「提供方默认」要整个省略 `reasoningEffort` 字段**，不能提交空串或 `undefined`。本插件唯一正确的写法是构造参数时展开：`...(option.id ? { reasoningEffort: option.id } : {})`。这与本插件「未选档就不带该字段」的既有行为一致（旧测试断言过：未选 effort 的请求里没有这个键）。
2. **模型已声明 `defaultEffort` 时不再给「提供方默认」项**。此时目录已经说明默认是哪一档，再列一项「默认」会让人以为两者不同（也会让 `selectedIds` 出现两个打勾项）。

## 5. 高度与布局

新 pane 与模型层**同构**：都只用 `stackedRow`（46px）/ 纯文本行（30px）/ 分隔（7px），因此 `LIST_MAX_HEIGHT = 5*46+30+7+67+8 = 342` 与 `listClassName` 那套上限不需要动（见 2026-10-03 那篇：类**只能**挂 `listClassName`，挂 `className` 会落在 anchor 的包裹 span 上）。将来若给推理档层加分组标题，先按同一公式核算行高再调上限。

## 6. 验证

```bash
node sub-plugins/dsh-composer-provider-label/test/bundle.test.mjs   # 61/61
node --check sub-plugins/dsh-composer-provider-label/src/client.js
```

新增 6 条断言：根层第三行显示生效档；推理档层当前档打勾 + 选档写入 `reasoningEffort`；「提供方默认」提交**不含**该字段；不支持模型显示 `effort:none` 空态；en-US 文案；`effortOptionsOf` 的 6 种目录形状。人眼部分见 `ACCEPTANCE.md` 10.1（根层三行）与 10.18–10.21。

## 7. 规格同步

菜单结构那条 requirement 原文写死「MUST 采用两级结构…SHALL 只包含这两级」，与三级实现直接冲突，已就地改为主 spec 的三级版本，并补 4 条 scenario（根层第三行 / 不支持时降级 / 选档立即提交 / 「提供方默认」不带字段）。**没有**新建 openspec change：这是单插件内的小步扩展，`openspec/changes/archive/` 只留历史记录，主 spec 保持与实现一致即可（行 11 的交叉引用同步改名）。

## 8. 遗留

- desktop profile 里装的是 **git 快照**：改完仓库源码不会即时生效，需要重装/更新（或走本地路径入口）才看得到第三行。
- 根外壳 `package.json` 与 `dsh-plugin-manager/package.json` 的 version 已同步 bump 到 0.3.16（改子插件后的仓库规则）。