// dsh-sidebar-footer-stack: CLIENT half.
//
// Zero UI on purpose. The fix is ONE stylesheet, and it is injected by the host
// half through the core 'webserver/index-inject' seam, so the browser must not
// add a second copy of it. This half exists for three reasons:
//
//   1. The plugin manager (@deepseek-ai/dsh-client-modules) only scans the
//      `dsh.client` bundles of ENABLED patch entries, so every local plugin
//      carries a client module; this one contributes no element to any slot.
//   2. VERIFY, not guess. A later plugin could override flex-direction, and the
//      core may change its DOM. `window.__dshSidebarFooterStack.report()` in
//      DevTools answers "is the stack actually in effect, how many entries are
//      there, how wide is the rail" in one line.
//   3. WARN when the stylesheet never reached <head> (stale page — web collects
//      injections per request, desktop only at app-ready).
//
// COUNTING ENTRIES IS NON-TRIVIAL
// The list slot renders ONE wrapper child under footerActions and puts the
// plugin entries inside it (footerActions > wrapper > entry, entry, ...). A
// naive `actions.children.length` therefore reports 1 no matter how many plugins
// are installed — which is exactly the mis-detection that broke v0.1.0's
// single-entry guard. `itemsOf()` descends one level when the slot has a single
// child that itself has children.
//
// Bundle format (client-modules protocol): classic script registering a factory
// via window.__ModuleLoader__.load({ id, factory }); the factory receives
// `require` and returns the plugin exports. No React, no JSX, no slots.
window.__ModuleLoader__.load({
  id: 'dsh-sidebar-footer-stack',
  factory: () => {
    const MARKER = '/* dsh-sidebar-footer-stack */'
    const STYLE_ID = 'dsh-sidebar-footer-stack'
    const FOOT_AREA_SELECTOR = '[class*="_footArea"]'
    const FOOTER_ACTIONS_SELECTOR = '[class*="_footerActions"]'

    const doc = () => (typeof document === 'undefined' ? null : document)

    /** The stylesheet the host half put in <head>, or null when this page never got it. */
    function findInjectedStyle() {
      const d = doc()
      if (!d) return null
      try {
        if (typeof d.getElementById === 'function') {
          const byId = d.getElementById(STYLE_ID)
          if (byId) return byId
        }
        const styles = typeof d.querySelectorAll === 'function' ? d.querySelectorAll('style') : []
        for (const node of Array.from(styles)) {
          if (node && typeof node.textContent === 'string' && node.textContent.indexOf(MARKER) >= 0) return node
        }
      } catch {
        // Managed-DOM quirks must never break the panel.
      }
      return null
    }

    /**
     * 真正的 footer 条目列表：槽位只有一个子元素且它自己还有子元素时，那个子元素
     * 是核心的包装层，条目在它里面；否则直接子元素就是条目。
     * @param {Element} actions footerActions 容器
     * @returns {Element[]}
     */
    function itemsOf(actions) {
      const kids = actions && actions.children ? Array.from(actions.children) : []
      if (kids.length === 1) {
        const sole = kids[0]
        const inner = sole && sole.children ? Array.from(sole.children) : []
        if (inner.length > 0) return inner
      }
      return kids
    }

    /** One read-only snapshot of the footer slot. Never throws. */
    function snapshot() {
      const d = doc()
      const out = {
        installed: false,
        hasFootArea: false,
        hasFooterActions: false,
        count: 0,
        entries: [],
        flexDirection: null,
        width: null,
        stacked: false,
        single: false,
      }
      try {
        out.installed = findInjectedStyle() !== null
        const foot = d && typeof d.querySelector === 'function' ? d.querySelector(FOOT_AREA_SELECTOR) : null
        out.hasFootArea = !!foot
        const actions = foot && typeof foot.querySelector === 'function' ? foot.querySelector(FOOTER_ACTIONS_SELECTOR) : null
        out.hasFooterActions = !!actions
        if (actions) {
          const view = typeof window !== 'undefined' && typeof window.getComputedStyle === 'function'
            ? window.getComputedStyle(actions)
            : null
          if (view) {
            out.flexDirection = view.flexDirection || null
            out.width = view.width || null
          }
          const items = itemsOf(actions)
          out.count = items.length
          out.single = out.count <= 1
          out.entries = items.map((node) => {
            let box = null
            try {
              if (node && typeof node.getBoundingClientRect === 'function') {
                const rect = node.getBoundingClientRect()
                box = { x: Math.round(rect.x), y: Math.round(rect.y), w: Math.round(rect.width), h: Math.round(rect.height) }
              }
            } catch {
              box = null
            }
            return {
              className: (node && node.className ? String(node.className) : '').slice(0, 80),
              box,
            }
          })
          // 几何判断比读 flexDirection 可靠：竖排时第二个条目的 y 一定大于第一个。
          // 隐藏/未布局（宽 0）时退回 flexDirection 判断。
          const first = out.entries[0] && out.entries[0].box
          const second = out.entries[1] && out.entries[1].box
          if (first && second && first.w > 0 && second.w > 0) {
            out.stacked = second.y > first.y
          } else {
            out.stacked = out.flexDirection === 'column'
          }
        }
      } catch {
        // 观测失败时按「未生效」上报，不抛给宿主。
      }
      return out
    }

    /** Human-readable verdict for DevTools / support threads (zh). */
    function report() {
      const state = snapshot()
      if (!state.installed) {
        return { ...state, ok: false, note: '页面里没有本插件的 <style>：Web 端刷新页面，桌面端重启 DSH Desktop。' }
      }
      if (!state.hasFooterActions) {
        return { ...state, ok: false, note: '没找到侧边栏 footer 容器：侧边栏可能被收起，或核心类名后缀变了。' }
      }
      if (state.single) {
        return { ...state, ok: true, note: 'footer 只有 ' + state.count + ' 个条目，按设计保持核心横向布局。' }
      }
      if (state.stacked) {
        return { ...state, ok: true, note: '已竖排：' + state.count + ' 个条目各占一行，容器宽 ' + state.width + '。' }
      }
      return {
        ...state,
        ok: false,
        note: '样式已注入但仍横向（条目 ' + state.count + ' 个，容器宽 ' + state.width + '）：可能有插件覆盖了 flex-direction，或核心 DOM 结构变了。',
      }
    }

    function apply() {
      if (typeof window === 'undefined') return
      window.__dshSidebarFooterStack = {
        marker: MARKER,
        styleId: STYLE_ID,
        snapshot,
        report,
        itemsOf,
        styleEl: findInjectedStyle,
      }
      try {
        const state = snapshot()
        if (!state.installed) {
          console.warn('[dsh-sidebar-footer-stack] 未找到注入的样式；Web 端刷新页面、桌面端重启 DSH Desktop。')
        } else if (state.hasFooterActions && !state.single && !state.stacked) {
          console.warn('[dsh-sidebar-footer-stack] 样式已在，但 footer 仍横向（' + state.count + ' 个条目）；在 DevTools 里跑 window.__dshSidebarFooterStack.report() 看原因。')
        }
      } catch {
        // 诊断绝不打扰页面。
      }
    }

    return { apply, inject: [] }
  },
})
//# sourceURL=/dsh-sidebar-footer-stack/src/client.js
