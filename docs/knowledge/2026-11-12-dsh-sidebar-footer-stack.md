# dsh-sidebar-footer-stack：把侧栏 footer 的多个插件条目从横排改成竖排

侧栏左下角 `sidebar.footer.action` 是 `kind:"list"` 槽位，注册几个插件就并排几个。核心 `@deepseek-ai/dsh-client-ui-sidebar` 只给了 `.…_footerActions{display:flex}`，**没有 `flex-direction`**，于是默认 row：264px 的侧栏里标签被截成 `Re...`，用量卡片掉进它自己的 `@container (width<=210px)` 降级形态。本文记录通用解法里可复用的结论。

## 1. 根因：一行缺失的 `flex-direction`

核心 DOM 与样式：

```
div.hHd-Xa_footArea             flex-direction: column
  > div.hHd-Xa_footerActions    slot "sidebar.footer.action" (kind: "list")
      > div                     ← 槽位包装层：list 槽位只在这里放 1 个 wrapper
          > 插件 A 的根节点
          > 插件 B 的根节点
  > div.hHd-Xa_settingsArea     slot "sidebar.settings"      (kind: "single")
```

`.hHd-Xa_footerActions{display:flex}` 没有 `flex-direction` ⇒ 渲染成一行。这与皮肤无关（皮肤只改 `--dsw-alias-*` 颜色变量），核心也没有任何 `Config` 开关能改方向，所以只能由插件注入一条规则。

## 2. list 槽位的「直接子元素数」≠「条目数」（v0.1.0 事故）

`footerActions` 永远只有 **1 个直接子元素**（核心的包装层），真正的条目在它里面。因此任何「判断是不是只有一个条目」的 CSS 判据都必须**穿透包装层**：

```css
/* 错：footerActions 只有 1 个 wrapper ⇒ 判据恒真 ⇒ row 覆盖 column */
:not(:has(> * + *))
/* 对：直接子元素 ≤1 且没有任何直接子元素内部存在兄弟对 */
:not(:has(> * + *)):not(:has(> * > * + *))
```

v0.1.0 用错版本 + `> *{width:100%}` 的后果：wrapper 被撑满 264px，wrapper 内部继续横排、两个条目各 264px ⇒ 用量卡片起点 x=272（=8+264），完全溢到侧栏外只剩一条 8px 的边。**这条判据是功能的一部分，第二个 `:not(:has())` 永远不能删。**

## 3. 三层规则：槽位层、包装层、条目层

```css
[class*="_footArea"] > [class*="_footerActions"]{flex-direction:column;align-items:stretch;gap:4px;width:100%}
[class*="_footArea"] > [class*="_footerActions"] > *{display:flex;flex-direction:column;align-items:stretch;width:100%;min-width:0}
[class*="_footArea"] > [class*="_footerActions"] > * > *{width:100%;min-width:0;max-width:100%;box-sizing:border-box}
```

只有第一层不会生效（条目在 wrapper 内部横排）；三层缺一不可。条目层 `width:100%` 还负责覆盖插件自带的 `min-width:96px` 之类。

## 4. 类名用后缀匹配，不能用 data-* 锚点

类名是 CSS module 生成的 hash（`hHd-Xa_footerActions`）：前缀随 DSH 版本变、后缀 `_footArea` / `_footerActions` 稳定，DOM 上没有 `data-*`。因此选择器统一写属性子串匹配 `[class*="_footArea"]`。上游若重命名模块，诊断会先给 `hasFooterActions:false`。

## 5. 折叠轨用祖先类还原，不要引 @container

核心收起侧栏时把 `footerActions` 改成 `width:auto; justify-content:center`。这里用祖先类 `[class*="_collapsed"]` 写一条 (0,3,0) 的规则显式还原成居中横排，并**放在样式表最后**（同特异性后者胜、特异性更高则与顺序无关，双保险）。

v0.1.0 曾用 `@container (min-width:…)`：需要给 `footArea` 加 `container-type:inline-size`（引入 `contain:layout` 副作用），而且一旦没有元素匹配 `container-type`，整块 `@container` 规则会**静默失效**、连诊断都看不出来。能用稳定后缀的祖先类判断时不要引容器查询。

## 6. 注入 seam：`webserver/index-inject`

核心 `@deepseek-ai/dsh-host-webserver` 在每个请求里 `ctx.emit('webserver/index-inject', table)`，插件往 `table` 里 push `{ kind:'style', text }` 即进页面 `<head>`：

```js
function apply(ctx, config) {
  const css = buildCss(config)
  if (!css) return undefined            // enabled:false ⇒ 连监听都不注册
  return ctx.on('webserver/index-inject', (table) => {
    try { pushStyleRow(table, css) } catch {}   // 注入表归核心所有，畸形输入不能带崩页面
  })
}
```

- cordis 的事件派发是全局广播，**profile 级插件用裸 `ctx.on()` 就能收到，不需要 `inject` 任何服务**（本插件 `inject = []`）。
- web 每次请求重新 collect ⇒ 改配置刷新页面即可；**desktop 只在 app-ready 收集一次** ⇒ 改配置要重启 DSH Desktop。
- 新 entry 只在 boot 时读 profile `cordis.patch.yml` ⇒ 首次启用必须重启一次 `dsh web`（所有本地插件同理）。
- 同一段 CSS 要按文本去重（`pushStyleRow`），否则每请求都会多塞一条 `<style>`。

## 7. 零 UI 客户端半只做「验证」

客户端不往任何槽位注册元素，只挂一个句柄：`window.__dshSidebarFooterStack.report()` 给一句中文结论，`.snapshot()` 给 `{installed, hasFootArea, hasFooterActions, count, entries, flexDirection, width, stacked, single}`。两个关键判据：`installed:false` = 样式没进页面（没重启 / 没刷新 / 插件没启用）；`flexDirection !== "column"` = 规则没命中（`single:true` 时是设计内的横向回退，否则多半上游 DOM 变了）。`count` 必须穿透包装层数，否则永远报 1。

## 8. 可离线验证的边界

注入逻辑被拆成纯函数，测试完全不需要浏览器：`buildCss()` 断言各配置组合下规则条数与顺序（单条回退、折叠轨在最后、`enabled:false` 返回空串）、`normalizeEntryConfig()` 断言夹边界与非数字回落、`pushStyleRow()` 断言同段去重与畸形 table 不抛。`host.test.mjs` 26 条、`bundle.test.mjs` 14 条。

## 9. 代码位置

- `sub-plugins/dsh-sidebar-footer-stack/src/index.js` — 宿主半：`DEFAULTS` / `buildCss` / `pushStyleRow` / `apply`，导出名是 `sidebar-footer-stack`（**不带 `dsh-` 前缀**，与包名不同，勿混用）。
- `sub-plugins/dsh-sidebar-footer-stack/src/client.js` — 零 UI，只注册 `window.__dshSidebarFooterStack` 诊断句柄。
- `sub-plugins/dsh-sidebar-footer-stack/README.md` — 完整行为表、真机测量数据（`footArea` x8 y678 264×116、`footerActions` 264×64、用量卡片 x272）与已知限制。
