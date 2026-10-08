# DSH 插件：`Menu` 卡片的高度上限该挂在哪（dsh-composer-provider-label）

日期：2026-10-03 · 涉及：`sub-plugins/dsh-composer-provider-label/{src/client.js,test/bundle.test.mjs}`

## 一句话

`Menu` 有两个类名 hook —— `className` 落在 anchor 包裹 `<span>` 上、**只有 `listClassName` 落在卡片上**；而卡片（`MenuSurface`）的第一个子 `div` 是装饰性 `.material` 背景层，不是 items 区。所以「给卡片塞一条 `.list > div:first-child { max-height: … }`」这类写法一定打偏，向上弹出的长菜单仍会顶出自己的首行。

## 症状与真凶

- 症状：窄窗口里向上弹出（`side='top'`）的选择器卡片比视口还高，**最上面的模型行越出屏幕且滚不到**（滚动条也不在正确的元素上）。
- 旧实现（失效）：`'.' + PICKER_CLASS + ' [role="menu"] > div:first-child { max-height: …px; overflow-y: auto; }'`。
- 宿主原语结构（`C:\Nt\dsh\packages\client\ui-primitives\src`）：
  - `Menu.tsx:553-563` 外层 `<span className={clsx(css.root, className)}>` 同时包住 anchor 与卡片 ⇒ **`className` 不是卡片的类**。
  - `Menu.tsx:517-547` 卡片是 `<MenuSurface className={clsx(css.list, listClassName, …)} role="menu">`，内容为 `<div className={css.viewport} role="presentation">{items}</div>` + 可选 `<div className={css.footer} role="presentation">{footer}</div>`（footer 只在非空时渲染）。
  - `MenuSurface.tsx:34-39` 渲染 `<div className={css.surface}><div aria-hidden="true" className={css.material} />{children}</div>` ⇒ **第一个子 div 是 `.material`**（`position:absolute; inset:0; z-index:-1`），viewport 是第二个。
  - `Menu.module.css`：`.list{padding:4px;display:flex;flex-direction:column}`；`.scrollable{max-height:calc(100vh - 12px - max(12px,var(--dsh-frame-overlay-top,12px)))}`；`.viewport{display:flex;flex-direction:column;min-height:0}`；`.footer{flex:none;margin-top:3px;padding-top:3px;border-top:0.5px solid}`。

## 修法

1. `React.createElement(Menu, { className: PICKER_CLASS, listClassName: LIST_CLASS, … })`。
2. 注入两条规则：
   `[role="menu"].cpl-picker-list { max-height: <N>px; }`
   `[role="menu"].cpl-picker-list > div[role="presentation"]:not(:last-child) { overflow-y: auto; }`
   - `[role="menu"]`（属性+类 = 特异性 (0,2,0)）是**故意**加的：宿主 `.scrollable` 的上限是 (0,1,0)，这样不靠样式表顺序也稳赢。
   - `:not(:last-child)` 选中的正是 items 区（footer 是最后一个 `role="presentation"` 子元素）；卡片本身是 flex column ⇒ 上限落在 items 区、footer 常驻不滚动。
3. `N` 用 `dense: true` 的真实行高算：**stacked 行 46px**（label 20 + gap 2 + detail 16 + 上下 padding 8）、纯文本行 30px、分隔 7px、footer 67px、卡片 padding 8px ⇒ `5×46 + 30 + 7 + 67 + 8 = 342`（≈5 行模型 + 返回行 + footer，与 README/ACCEPTANCE 的「约 5 行」一致）。

## 可复用要点

- 给原语注入样式前，**先按源码读一遍 DOM 层级**（哪个 prop 的类落在哪个元素、子元素的顺序），别按 `role` + `:first-child` 猜。
- `Menu` 的 `className` / `listClassName` 落点不同：要改卡片就传后者。
- 上限写在**卡片**上比写在 items 区更稳：卡片的 `max-height` + 内部滚动不依赖宿主是否给 `.scrollable`，也不会被未来改动撤掉。
- 插件自绘行的行高要自己算（本例 stacked 行 = label 20 + gap 2 + detail 16 + padding 8），别照抄「dense 行 34px」这类只适用纯文本行的数字。

## 验证

```bash
node sub-plugins/dsh-composer-provider-label/test/bundle.test.mjs   # 55/55
```

两个用例钉住行为：`listClassName === 'cpl-picker-list'` 且样式表含 `[role="menu"].cpl-picker-list` / `overflow-y: auto` / `max-height: 342px`（并断言**不含** `first-child`）；以及几何区间 `5×46+30+7 ≤ N ≤ 5×46+30+7+67+8`。
