# dsh-sidebar-footer-stack

把 **DSH 侧边栏左下角（`sidebar.footer.action` 槽位）里注册的多个插件条目，从横向并排改成竖向逐行堆叠**，且**不依赖任何皮肤**。

修的是核心侧边栏的一个默认布局：该槽位是 `kind: "list"`，容器 `.…_footerActions` 只有 `display: flex`、**没有 `flex-direction`**，因此默认 `row` —— 所有注册进这个槽位的插件（远程桥、用量/账单……）被塞进同一条 264px 的横排里：标签被截断成 `Re...`，用量卡片掉进它自己的 `@container (width<=210px)` 降级形态（无边框、无仪表、无 spark 柱）。

插件**不改核心源码、不改任何皮肤、不接管插件自己的样式**，只注入一条「让这个槽位竖排」的 CSS。

## 问题与根因

核心包 `@deepseek-ai/dsh-client-ui-sidebar` 的 `lib/client.js` 里，左下角结构是：

```
div.hHd-Xa_footArea            flex-direction: column
  > div.hHd-Xa_footerActions   slot "sidebar.footer.action"  (kind: "list")
      > div                    ← 槽位包装层：list 槽位只会在这里放 1 个 wrapper
          > 插件 A 的根节点
          > 插件 B 的根节点
  > div.hHd-Xa_settingsArea    slot "sidebar.settings"       (kind: "single")
```

样式表里与它相关的规则（同一份 css 字符串）：

```css
.hHd-Xa_footArea{flex-direction:column;flex:none;display:flex}
.hHd-Xa_settingsArea,.hHd-Xa_footerActions{flex:none;width:100%;min-width:0}
.hHd-Xa_footerActions{display:flex}          /* ← 没有 flex-direction，默认 row */
.hHd-Xa_collapsed .hHd-Xa_footerActions{justify-content:center;width:auto;display:flex}
```

于是 `footerActions` 是一个横向 flex 行，**而真正的插件条目还在它唯一那层 wrapper 里面**（这是最容易踩空的一点，见下面的 v0.1.0 事故）。**这不是皮肤造成的** —— 皮肤（如 `~/.dsh/skins/furina`）只改 `--dsw-alias-*` 颜色变量，不碰 footer 布局；换皮肤前后看到的「竖向」是当时只启用了一个 footer 插件的错觉。核心也没有任何 `Config` 开关能改这个方向。

真机实测（DSH 0.2.0，侧边栏展开宽 264px，两个条目）：

| 节点 | 位置 / 尺寸 |
| --- | --- |
| `footArea` | x8 y678 264×116 |
| `footerActions` | x8 y678 **264×64**（row + `align-items:center`） |
| 远程桥条目 | x8 y692 264×36（在 64 高里垂直居中 ⇒ 横向几何特征） |
| 用量卡片 `triggerWrap` | **x272** y678 264×64（x272 = 8+264，完全溢出侧边栏，只剩一条边可见） |

## 方案：注入三段竖排规则

宿主半监听核心 web 服务的 `webserver/index-inject` 事件，往页面 `<head>` 注入（默认配置的实际产物）：

```css
/* dsh-sidebar-footer-stack */
[class*="_footArea"] > [class*="_footerActions"]{flex-direction:column !important;align-items:stretch !important;justify-content:flex-start !important;gap:4px !important;width:100% !important}
[class*="_footArea"] > [class*="_footerActions"] > *{flex:0 0 auto !important;display:flex !important;flex-direction:column !important;align-items:stretch !important;justify-content:flex-start !important;gap:4px !important;width:100% !important;min-width:0 !important;max-width:100% !important;box-sizing:border-box !important}
[class*="_footArea"] > [class*="_footerActions"] > * > *{flex:0 0 auto !important;width:100% !important;min-width:0 !important;max-width:100% !important;box-sizing:border-box !important}
[class*="_footArea"] > [class*="_footerActions"]:not(:has(> * + *)):not(:has(> * > * + *)){flex-direction:row !important;align-items:center !important;justify-content:flex-start !important;gap:0 !important;width:100% !important}
[class*="_footArea"] > [class*="_footerActions"]:not(:has(> * + *)):not(:has(> * > * + *)) > *{display:block !important;flex:0 1 auto !important;width:auto !important;min-width:0 !important;max-width:none !important}
[class*="_footArea"] > [class*="_footerActions"]:not(:has(> * + *)):not(:has(> * > * + *)) > * > *{width:auto !important;max-width:none !important}
[class*="_collapsed"] [class*="_footArea"] > [class*="_footerActions"]{flex-direction:row !important;align-items:center !important;justify-content:center !important;gap:0 !important;width:auto !important}
[class*="_collapsed"] [class*="_footArea"] > [class*="_footerActions"] > *{display:flex !important;flex-direction:row !important;align-items:center !important;justify-content:center !important;gap:0 !important;flex:0 1 auto !important;width:auto !important;min-width:0 !important;max-width:none !important}
[class*="_collapsed"] [class*="_footArea"] > [class*="_footerActions"] > * > *{width:auto !important;max-width:none !important}
```

三层各自的职责：

| 层 | 选择器 | 作用 |
| --- | --- | --- |
| 槽位层 | `footerActions` | `column` + `stretch`，让每个条目拿到整条侧边栏宽度 |
| **包装层** | `footerActions > *` | **也必须是 `column` + `width:100%`** —— 少了这条，条目会在 wrapper 内部继续横排并各自撑满 264px，第二个条目被顶到侧边栏外 |
| 条目层 | `footerActions > * > *` | `width:100%; min-width:0`，覆盖插件自带的 `min-width:96px` 之类 |

选择器用 `[class*="_footArea"]` 这类**后缀匹配**：类名是 CSS module 生成的 hash（`hHd-Xa_footerActions`，前缀随 DSH 版本变），后缀 `_footArea` / `_footerActions` 稳定，而 DOM 上没有任何 `data-*` 锚点可依赖。

竖排后每个条目拿到 264px，用量卡片因此**离开**它自己的 `@container (width<=210px)` 降级区间，恢复成完整的玻璃底 + 边框 + 仪表 + spark 柱形态。

### 三条护栏

1. **只有一个条目时保持横向**：判据是双条件 `:not(:has(> * + *)):not(:has(> * > * + *))` —— 「直接子元素 ≤ 1」**并且**「没有任何直接子元素内部存在兄弟对」。只看前一半会把「1 个 wrapper 里装着 N 个条目」误判成单条（v0.1.0 的事故）。不支持的浏览器只会丢掉这几条补救规则、仍然竖排，功能不受损。
2. **收起态（rail）逐像素还原**：核心收起时把 `footerActions` 改成 `width:auto; justify-content:center`。这里用祖先类 `[class*="_collapsed"]` 显式还原成居中横排，三条规则特异性 (0,3,0) 高于上面所有 (0,2,0) 规则，且排在文件最后，双保险。
3. **顺序即优先级**：column 规则在前、row 回退在后、collapsed 在最后；同一特异性下后者胜，所以顺序是功能的一部分，改顺序会复活 bug。

> 为什么不用 `container-type` + `@container (min-width:…)`（v0.1.0 的做法）：容器查询会给 footArea 加上 `contain: layout`（页面多出的副作用），而且一旦没有元素匹配 `container-type`，整块 @container 规则就全部失效、连诊断都看不出来。收起态只靠一个稳定后缀的祖先类就能判断，没有必要引入容器查询。

## v0.1.0 事故复盘

| | |
| --- | --- |
| **症状** | 竖排没生效；用量卡片被挤出侧边栏右侧，只剩一条 8px 的竖直圆角边可见 |
| **原因** | 单条护栏只写了 `:not(:has(> * + *))`。`footerActions` 的直接子元素永远只有 **1 个 wrapper**，于是这条判据恒为 true → 排在后面的 row 规则把 column 覆盖回 row；同时 `> *{width:100%}` 把 wrapper 撑满 264，wrapper 内部横排，两个条目各 264 宽 ⇒ 第二个起点 x=272 |
| **修法** | 判据补成双 `:not(:has())`（穿透到条目层计数）；竖排也穿透到包装层；回退分支同时把宽度还原成 `auto` |
| **教训** | list 槽位的「直接子元素个数」**不等于**「条目个数」。任何针对这个槽位的 CSS 判据都必须穿透包装层 |

## 配置（激活行的 `config:`）

| 键 | 默认 | 范围 | 含义 |
| --- | --- | --- | --- |
| `enabled` | `true` | 布尔 | `false` 时不注册监听、不注入任何 CSS（回到核心横排） |
| `gap` | `4` | 0–24 px | 条目之间的垂直间距（槽位层与包装层同时生效） |
| `stackSingle` | `false` | 布尔 | `true` 时连「只有一个条目」也竖排（即关掉护栏 1） |

非法值会被夹到范围内；字符串数字（`"8"`）会被 `Number()` 转换；非对象配置整体回落默认。v0.1.0 的 `minWidth` 已删除 —— 那个键现在会被**忽略**（不再影响任何输出）。

## 怎么用

1. 在**本地插件管理器**里打开 `dsh-sidebar-footer-stack`（不要单独 `dsh plugin add` 装子插件）。
2. 让样式生效：
   - Web（`dsh web`）：**首次启用后必须重启一次 `dsh web`** —— profile 的 `cordis.patch.yml` 只在 boot 时读取，运行中的进程不会加载新 entry（所有本地插件同理）。重启之后再改 `gap` / `stackSingle`，只需**刷新页面**（index 注入每次请求重新收集）。
   - 桌面版（DSH Desktop）：**必须重启 DSH Desktop** —— 桌面 host 只在 app ready 时收集一次注入，改 config 也要重启。
3. 侧边栏左下角应变成：远程桥占一行、用量卡片占一行（完整形态）。

## 诊断

浏览器控制台：

```js
window.__dshSidebarFooterStack.report()
```

返回一句中文结论；`window.__dshSidebarFooterStack.snapshot()` 给出结构化现场：

```js
{
  installed, hasFootArea, hasFooterActions,
  count,               // 穿透包装层后的真实条目数
  entries: [{ className, x, y, w, h }],
  flexDirection, width,
  stacked,             // 两条目且第二个 y 更大 → true
  single
}
```

- `installed:false` → 样式没进页面（启用后还没重启 `dsh web` / 页面未刷新 / 桌面未重启 / 插件未启用）。
- `hasFooterActions:false` → 找不到槽位容器（侧边栏收起，或上游把类名改成了非 `_footerActions` 后缀）。
- `flexDirection !== "column"` → 竖排规则没命中；若 `single:true` 是设计内的横向回退，否则多半是上游 DOM 结构变了。
- `itemsOf()` 也暴露在句柄上，可直接看它认出了几个条目。

## 已知限制

- **依赖后缀命名**：`[class*="_footArea"] / [class*="_footerActions"]` 假设上游继续用 CSS module 的这些模块名。上游若重命名模块，需要跟着改两处常量（`FOOT_AREA_SELECTOR` / `FOOTER_ACTIONS_SELECTOR`），诊断报告会先显示 `hasFooterActions:false`。
- **依赖「list 槽位只有一层包装」**：三层规则假设「槽位 → wrapper → 条目」这个结构不变。若上游改成多一层或少一层，诊断的 `count` 会先失真（`itemsOf()` 只穿透一层），届时应同步改 `itemsOf` 与 CSS 的层数。
- **只管 `sidebar.footer.action`**：`sidebar.settings`（`kind:"single"`，例如 `@linxin666/dsh-usage`）本来就在 footArea 里单独占一行，不受影响。
- **宽度由插件自己决定失败**：某个插件若把自身宽度写死（`max-width:96px` 之类）或带横向布局，本插件会用 `width:100% !important` 覆盖，但其内部排布仍可能显得挤 —— 那属于该插件的样式问题。
- **多行高度**：条目变高后 footArea 会往上长，侧边栏主内容区随之变矮（这是正确行为，不是 bug）。
- **桌面版不热更**：改 `config` 后 Web 刷新即可，桌面版要重启。
