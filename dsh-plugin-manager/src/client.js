// dsh-plugin-manager: CLIENT half — Settings > 本地插件 panel.
//
// Registers a top-level settings.section ('local-plugins', order 16, between
// the built-in 插件(15) and the mcp-manager(18) sections) and renders every
// dsh-* sibling found under the repo root with its live profile state. All
// data/actions go to the host half's /__dsh-plugin-manager/* HTTP endpoints.
//
// Activation semantics surfaced here:
//   · 主开关 on  → activate (auto pnpm declares the devDependency as a
//     relative `link:` into this profile's own node_modules copy, retires any
//     leftover workspace anchor, then writes the canonical row)
//   · 主开关 off → disable (keeps the row, sets disabled, live-stops the host)
//   · 移除       → delete row + drop devDependency
//   · 一键接管/迁移 → migrate the legacy per-plugin layout to manager-owned
//   · host rows go live immediately via DSH patch HMR; client-side UI of the
//     toggled plugin enters/leaves __DSH_BOOT__ only after a page reload, so
//     the panel shows a 「刷新页面使界面生效」 hint + button (never auto-reloads).
//
// Bundle format (client-modules protocol): classic script registering a factory
// via window.__ModuleLoader__.load({ id, factory }); the factory receives the
// module-table `require` (react is a seeded word) and returns { apply, inject }.
// No JSX — plain React.createElement + inline styles on --dsw-* tokens.
window.__ModuleLoader__.load({
  id: 'dsh-plugin-manager',
  factory: (require) => {
    'use strict'
    const React = require('react')
    const { useCallback, useEffect, useRef, useState } = React

    // --- copy ---------------------------------------------------------------
    const NS = 'dshPluginManager'
    const zhDict = {
      nav: '本地插件',
      intro: '管理本仓库子插件目录（sub-plugins/）下的 dsh-* 子插件在 profile 中的激活状态。',
      repoRoot: '仓库目录',
      pluginsRoot: '子插件目录',
      profile: '目标 profile',
      refresh: '刷新',
      reload: '刷新页面使界面生效',
      reloadHint: '客户端界面需要在刷新页面后出现/消失。',
      migrate: '一键接管/迁移',
      migrateNeed: '检测到子插件仍以旧布局安装，请先迁移。',
      migrateConfirm: '将本地子插件收敛为管理器统一管理（devDependencies + 管理器维护的激活行），并备份 profile 文件。继续？',
      migrateBusy: '迁移中…',
      remove: '移除',
      removeConfirm: '将删除激活行并从 devDependencies 摘除该插件（可随时重新启用）。继续？',
      busy: '处理中…',
      enableAll: '全部开启',
      disableAll: '全部关闭',
      workingAll: '处理中…',
      batchConfirmOn: '将开启全部 {n} 个本地插件（未安装的会先自动装依赖，可能需要几秒到几十秒）。继续？',
      batchConfirmOff: '将停用全部 {n} 个本地插件（激活行与依赖保留，可随时再开启）。继续？',
      batchSkipLegacy: '另有 {n} 个插件仍以旧布局安装，会被跳过——请先「一键接管/迁移」。',
      batchDoneOn: '已开启 {n} 个本地插件',
      batchDoneOff: '已停用 {n} 个本地插件',
      batchInstalled: '（其中 {n} 个为新装依赖）',
      batchFailed: '失败 {n} 项：',
      enableAllHint: '把本仓库全部受管本地插件打开（未安装的会自动装依赖，只跑一次安装）',
      disableAllHint: '把本仓库全部受管本地插件停用（保留激活行与依赖，可随时再开启）',
      removeAll: '全部移除',
      linkBanner: '检测到 {n} 处依赖待修复：{m} 处可自动修复、{k} 处需人工处理',
      linkStaleBadge: '依赖待修复',
      linkManual: '需人工处理',
      relink: '修复依赖',
      relinkBusy: '修复中…',
      relinkDone: '已修复 {n} 处依赖',
      relinkNoop: '没有需要修复的依赖',
      relinkFailed: '修复依赖失败',
      autoRelinkOff: '自动修复依赖已关闭（可在设置页重新打开）',
      uninstallTitle: '卸载管理器（含全部子插件）',
      uninstallBody: '将删除 {rows} 条激活行、{deps} 个依赖键 + 管理器自身，并执行一次 pnpm install；源码目录保留。命令不会自动执行，请复制后到终端运行：',
      uninstallCopy: '复制卸载命令',
      uninstallCopied: '已复制卸载命令——请到终端运行（本面板不会自动执行）',
      uninstallManual: '剪贴板不可用，请手动复制上面那条命令',
      removeAllConfirm: '将删除全部 {n} 个本地插件的激活行与 devDependencies 依赖链接（源码目录保留，可随时重新开启）。插件会立刻停止运行。继续？',
      removeAllHint: '清空本仓库全部受管本地插件的激活行与依赖链接——迁移/换机器后残留的旧绝对路径也会一并清掉，重新开启时会按当前目录重新定位',
      removeAllDone: '已移除 {n} 个本地插件的激活行与依赖',
      removeAllDiscarded: '（{n} 次未落盘的开关操作随行一起作废）',
      applying: '正在应用（宿主正在重应用配置树，界面可能短暂无响应）…',
      stateActive: '已激活',
      stateDisabled: '已停用',
      stateLegacy: '旧布局',
      stateUninstalled: '未激活',
      stateInactive: '未激活(仅依赖)',
      stateInvalid: '非插件目录',
      noPlugins: '子插件目录（sub-plugins/）没有发现 dsh-* 子插件。',
      error: '出错',
      hostDown: '插件宿主没有响应（HTTP {status}）：宿主半没有挂载 /__dsh-plugin-manager 路由。请重启 DSH 后重试；若仍然如此，打开「设置 → 插件」查看 dsh-plugin-manager 条目的状态与报错。',
      hostNotJson: '插件宿主返回了非 JSON 响应（HTTP {status}）：端点未注册或已被回滚。',
      hostOffline: '连接插件宿主失败（{reason}）：DSH 可能正在重启，稍后点「刷新」重试。',
      safeUpdateTitle: '安全更新（退出后再落盘）',
      safeUpdateBody: '这里只登记要更新的插件并生成一个脚本，本机文件不会被替换。完全退出 DSH 后运行该脚本，替换期间没有进程占用文件，就不会再卡住。',
      safeUpdatePick: '要更新的插件',
      safeUpdatePrepare: '准备更新',
      safeUpdatePrepared: '已准备更新，脚本已生成——完全退出 DSH 后再运行它。',
      safeUpdatePending: '待更新：{n} 个（脚本已就绪）',
      safeUpdateRunHint: '运行方式：先完全退出 DSH（含托盘图标），再双击下面的脚本。脚本会等到进程真的退出才开始替换；失败时会打印回滚命令，本机文件在替换前已自动备份。',
      safeUpdateCopy: '复制脚本路径',
      safeUpdateCopied: '脚本路径已复制到剪贴板',
      safeUpdateCancel: '取消准备',
      safeUpdateCancelled: '已取消待更新（没有修改任何本机文件）',
      safeUpdateNone: '没有可安全更新的插件（本地路径 / link: 依赖要手动处理）。',
      hasClientTag: '带界面',
    }
    const enDict = {
      nav: 'Local plugins',
      intro: "Manage the dsh-* plugins under this repo's sub-plugins/ directory in the current profile.",
      repoRoot: 'Repo root',
      pluginsRoot: 'Plugins root',
      profile: 'Profile',
      refresh: 'Refresh',
      reload: 'Reload page to apply UI changes',
      reloadHint: 'Client UI appears/disappears after a page reload.',
      migrate: 'Take over / migrate',
      migrateNeed: 'Plugins are still installed the legacy way — migrate first.',
      migrateConfirm: 'Adopt all local plugins into the manager model (devDependencies + manager-owned rows) with profile backups. Continue?',
      migrateBusy: 'Migrating…',
      remove: 'Remove',
      removeConfirm: 'This deletes the activation row and drops the devDependency (can be re-enabled anytime). Continue?',
      busy: 'Working…',
      enableAll: 'Enable all',
      disableAll: 'Disable all',
      workingAll: 'Working…',
      batchConfirmOn: 'Enable all {n} local plugins (missing ones install their dependency first; this can take a while). Continue?',
      batchConfirmOff: 'Disable all {n} local plugins (rows and dependencies are kept, re-enable anytime). Continue?',
      batchSkipLegacy: '{n} plugin(s) still use the legacy layout and will be skipped — migrate first.',
      batchDoneOn: 'Enabled {n} local plugin(s)',
      batchDoneOff: 'Disabled {n} local plugin(s)',
      batchInstalled: ' ({n} newly installed)',
      batchFailed: '{n} failed: ',
      enableAllHint: 'Enable every managed local plugin of this repo (missing ones install their dependency first, in a single install pass)',
      disableAllHint: 'Disable every managed local plugin of this repo (rows and dependencies are kept, re-enable anytime)',
      removeAll: 'Remove all',
      linkBanner: '{n} dependency declaration(s) need repair: {m} repairable automatically, {k} need manual attention',
      linkStaleBadge: 'needs repair',
      linkManual: 'needs manual attention',
      relink: 'Repair dependencies',
      relinkBusy: 'Repairing…',
      relinkDone: 'Repaired {n} declaration(s)',
      relinkNoop: 'Nothing to repair',
      relinkFailed: 'Repair failed',
      autoRelinkOff: 'Automatic dependency repair is off (enable it in Settings)',
      uninstallTitle: 'Uninstall the manager (with every sub-plugin)',
      uninstallBody: 'Removes {rows} activation row(s), {deps} dependency key(s) plus the manager itself, then runs one pnpm install; source directories are kept. The command never runs automatically — copy it and run it in a terminal:',
      uninstallCopy: 'Copy uninstall command',
      uninstallCopied: 'Uninstall command copied — run it in a terminal (this panel never executes it)',
      uninstallManual: 'Clipboard unavailable — copy the command above manually',
      removeAllConfirm: 'This deletes the activation rows and devDependency entries of all {n} local plugins (sources are kept and can be re-enabled anytime). They stop running immediately. Continue?',
      removeAllHint: 'Clear every managed local plugin of this repo — including stale absolute paths left behind by a move/machine change; re-enabling relocates them from the current directory',
      removeAllDone: 'Removed the rows and dependencies of {n} local plugin(s)',
      removeAllDiscarded: ' ({n} unflushed switch(es) discarded with them)',
      applying: 'Applying (the host is re-applying its config tree; the UI may briefly stall)…',
      stateActive: 'Active',
      stateDisabled: 'Disabled',
      stateLegacy: 'Legacy',
      stateUninstalled: 'Inactive',
      stateInactive: 'Inactive (dep only)',
      stateInvalid: 'Not a plugin',
      noPlugins: 'No dsh-* plugins found under sub-plugins/.',
      error: 'Error',
      hostDown: 'The plugin host did not answer (HTTP {status}): its /__dsh-plugin-manager route is not mounted. Restart DSH and retry; if this persists, open Settings > Plugins and check the dsh-plugin-manager entry state.',
      hostNotJson: 'The plugin host returned a non-JSON response (HTTP {status}): the endpoint is not registered or was rolled back.',
      hostOffline: 'Could not reach the plugin host ({reason}): DSH may be restarting; retry with Refresh in a moment.',
      safeUpdateTitle: 'Safe update (install after exit)',
      safeUpdateBody: 'This only records which plugins to update and writes a script — nothing on disk is replaced here. Quit DSH completely, then run that script: nothing holds the files, so the replacement cannot hang.',
      safeUpdatePick: 'Plugins to update',
      safeUpdatePrepare: 'Prepare update',
      safeUpdatePrepared: 'Update prepared — the script is ready. Run it after quitting DSH completely.',
      safeUpdatePending: 'Pending update: {n} (script ready)',
      safeUpdateRunHint: 'How to run: quit DSH completely (including the tray icon), then double-click the script below. It waits until the process is really gone before replacing anything; on failure it prints the rollback command, and the profile files are backed up first.',
      safeUpdateCopy: 'Copy script path',
      safeUpdateCopied: 'Script path copied',
      safeUpdateCancel: 'Cancel',
      safeUpdateCancelled: 'Pending update cancelled (no local file was touched)',
      safeUpdateNone: 'No safely updatable plugins (local-path / link: dependencies must be handled by hand).',
      hasClientTag: 'UI',
    }
    const t = (key) => {
      const lang = (typeof navigator !== 'undefined' && (navigator.language || navigator.languages && navigator.languages[0]) || 'zh')
      const dict = String(lang).toLowerCase().startsWith('en') ? enDict : zhDict
      return dict[key] || key
    }

    // --- styling helpers ----------------------------------------------------
    const S = {
      page: { maxWidth: 780, color: 'var(--dsw-alias-label-primary)', display: 'flex', flexDirection: 'column', gap: 12 },
      heading: { margin: 0, fontSize: 18, fontWeight: 600 },
      tabs: { display: 'flex', alignItems: 'flex-end', gap: 22, borderBottom: '.5px solid var(--dsw-alias-border-l2)', marginTop: 2 },
      tab: { position: 'relative', border: 0, padding: '7px 1px 9px', background: 'transparent', color: 'var(--dsw-alias-label-tertiary)', font: 'inherit', fontSize: 13, lineHeight: '20px', cursor: 'pointer' },
      tabActive: { position: 'relative', border: 0, padding: '7px 1px 9px', background: 'transparent', color: 'var(--dsw-alias-label-primary)', font: 'inherit', fontSize: 13, lineHeight: '20px', cursor: 'pointer', boxShadow: 'inset 0 -2px 0 0 var(--dsw-alias-label-primary)' },
      intro: { margin: 0, color: 'var(--dsw-alias-label-tertiary)', fontSize: 13 },
      metaRow: { display: 'flex', flexWrap: 'wrap', gap: '6px 18px', color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, fontFamily: 'var(--ds-font-family-code, monospace)' },
      banner: { border: '.5px solid var(--dsw-alias-border-l4)', background: 'var(--dsw-alias-bg-layer-3)', borderRadius: 12, padding: '10px 14px', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', fontSize: 13 },
      bannerWarn: { borderColor: 'color-mix(in srgb, var(--dsw-alias-state-warning-primary,#b45309) 45%, transparent)' },
      bannerOk: { borderColor: 'color-mix(in srgb, var(--dsw-alias-state-success-primary) 45%, transparent)' },
      list: { listStyle: 'none', margin: 0, padding: 0, display: 'flex', flexDirection: 'column', gap: 8 },
      card: { border: '.5px solid var(--dsw-alias-border-l4)', background: 'var(--dsw-alias-bg-layer-3)', borderRadius: 14, padding: '12px 14px', display: 'flex', gap: 12, alignItems: 'center' },
      cardInvalid: { opacity: .55 },
      dot: { width: 8, height: 8, borderRadius: '50%', flex: 'none' },
      dotActive: { background: 'var(--dsw-alias-state-success-primary)' },
      dotDisabled: { background: 'var(--dsw-alias-label-tertiary)' },
      dotLegacy: { background: 'var(--dsw-alias-state-warning-primary,#b45309)' },
      dotUninstalled: { background: 'var(--dsw-alias-label-dimmed)' },
      body: { minWidth: 0, flex: 1, display: 'flex', flexDirection: 'column', gap: 3 },
      titleRow: { display: 'flex', alignItems: 'baseline', gap: 8, flexWrap: 'wrap' },
      title: { margin: 0, fontSize: 14, fontWeight: 600 },
      badge: { color: 'var(--dsw-alias-label-tertiary)', fontFamily: 'var(--ds-font-family-code, monospace)', fontSize: 11 },
      desc: { margin: 0, color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' },
      state: { fontSize: 12, whiteSpace: 'nowrap' },
      stateColor: (st) => st === 'active' ? 'var(--dsw-alias-state-success-primary)'
        : st === 'legacy' ? 'var(--dsw-alias-state-warning-primary,#b45309)'
          : st === 'invalid' ? 'var(--dsw-alias-state-error-primary)'
            : 'var(--dsw-alias-label-tertiary)',
      actions: { display: 'flex', alignItems: 'center', gap: 8, flex: 'none' },
      toolbar: { display: 'flex', justifyContent: 'space-between', alignItems: 'center', gap: 8, flexWrap: 'wrap' },
      toolbarGroup: { display: 'flex', alignItems: 'center', gap: 8 },
      button: { font: 'inherit', cursor: 'pointer', color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-1)', border: '.5px solid var(--dsw-alias-border-l3)', borderRadius: 8, padding: '4px 12px', fontSize: 12 },
      buttonPrimary: { background: 'var(--dsw-alias-label-primary)', color: 'var(--dsw-alias-bg-layer-3)', border: 'none' },
      buttonDanger: { color: 'var(--dsw-alias-state-error-primary)', borderColor: 'color-mix(in srgb, var(--dsw-alias-state-error-primary) 40%, transparent)' },
      buttonDisabled: { opacity: .4, cursor: 'default' },
      switch: { boxSizing: 'border-box', width: 36, height: 20, borderRadius: 10, padding: 2, background: 'var(--dsw-alias-border-l3)', cursor: 'pointer', border: 'none', flex: 'none', position: 'relative' },
      switchOn: { background: 'var(--dsw-alias-brand-primary)' },
      thumb: { boxSizing: 'border-box', width: 16, height: 16, borderRadius: '50%', background: 'var(--dsw-alias-label-primary-foreground)', display: 'block', transition: 'transform .12s' },
      hint: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 12, display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' },
      err: { color: 'var(--dsw-alias-state-error-primary)', fontSize: 12, margin: 0 },
      notice: { margin: 0, fontSize: 13 },
      empty: { color: 'var(--dsw-alias-label-tertiary)', margin: 0, fontSize: 13 },
    }
    const Row = ({ children, style }) => React.createElement('div', { style }, children)

    // --- pure helpers (exposed for the harness) -----------------------------
    const stateText = (st) => ({
      active: t('stateActive'),
      disabled: t('stateDisabled'),
      legacy: t('stateLegacy'),
      uninstalled: t('stateUninstalled'),
      inactive: t('stateInactive'),
      invalid: t('stateInvalid'),
    }[st] || st)

    // 批量按钮上的数量：宿主 /list 已带 batchCounts（权威口径，由 host-core 的
    // batchPlan 算出）；这里保留一个同规则的本地兜底，只在拿到旧宿主半（没有该
    // 字段）时使用。规则改动必须与 host-core 的 batchPlan 同步。
    const localBatchCounts = (plugins) => {
      const one = (enabled) => {
        let count = 0
        let skippedLegacy = 0
        let skippedInactive = 0
        let skippedInvalid = 0
        for (const p of Array.isArray(plugins) ? plugins : []) {
          if (!p || typeof p.dir !== 'string') continue
          if (!p.valid || p.state === 'invalid') { skippedInvalid += 1; continue }
          if (p.state === 'legacy' || p.legacyBundle === true) { skippedLegacy += 1; continue }
          if (p.state === 'active') { if (!enabled) count += 1; continue }
          if (p.state === 'disabled' || p.state === 'uninstalled') { if (enabled) count += 1; continue }
          if (p.state === 'inactive') skippedInactive += 1
        }
        return { count, skippedLegacy, skippedInactive, skippedInvalid }
      }
      // 「全部移除」的兜底口径与 host-core 的 removePlan 一致：有痕迹（装过或有行）才计数。
      const removable = () => {
        let count = 0
        let skippedLegacy = 0
        let skippedInvalid = 0
        for (const p of Array.isArray(plugins) ? plugins : []) {
          if (!p || typeof p.dir !== 'string') continue
          if (!p.valid || p.state === 'invalid') { skippedInvalid += 1; continue }
          if (p.state === 'legacy' || p.legacyBundle === true) { skippedLegacy += 1; continue }
          if (p.installed === true || p.hasRow === true) count += 1
        }
        return { count, skippedLegacy, skippedInactive: 0, skippedInvalid }
      }
      return { enable: one(true), disable: one(false), remove: removable() }
    }

    const API = '/__dsh-plugin-manager'
    // 「应用生效」判据：写请求返回 ≠ 变更已生效。主机把连点合并成一次
    // cordis.patch.yml 写入，写入会让 DSH 核心重应用整棵配置树并独占宿主
    // 事件循环约 1 秒（实测 681–1184 ms），期间所有请求都在排队。因此只要
    // 「还有未落盘的意图」或「探测往返仍然很慢」，就继续显示正在应用。
    const HOST_IDLE_RTT_MS = 250
    const APPLY_POLL_MS = 120
    const APPLY_MAX_MS = 12000

    // --- panel component ----------------------------------------------------
    /** Child slot of the local-plugins settings entry: one tab per local plugin panel. */
    const LOCAL_TAB_SLOT = 'settings.localPlugins.tab'
    /** Client ctx captured at apply time (the tab ledger lives on the slot registry). */
    let __slotsCtx = null

    /**
     * 功能作用：从槽位台账读出「本地插件」入口下的 tab 行（id/order/label），与核心
     *           ui-settings-plugins 的 useTabs 同口径（order 升序、label 惰性求值）。
     * 参数：无（用模块级 __slotsCtx）
     * 返回值：Array -- [{ id, order, label }]
     * 调用样例：const rows = localTabRows()
     */
    function localTabRows() {
      const slots = __slotsCtx && __slotsCtx.slots
      if (!slots || typeof slots.entries !== 'function') return []
      return slots.entries(LOCAL_TAB_SLOT)
        .map((entry) => {
          const options = (entry && entry.options) || {}
          const label = typeof options.label === 'function' ? options.label() : options.label
          return { id: options.id, order: options.order === undefined ? 0 : options.order, label: label || options.id }
        })
        .filter((row) => typeof row.id === 'string' && row.id !== '')
        .sort((a, b) => (a.order === b.order ? (a.id < b.id ? -1 : 1) : a.order - b.order))
    }

    /**
     * 功能作用：设置页一级入口「本地插件」的壳——渲染 tab 栏与当前面板（子槽 renderSlot(…, { only })），
     *           首个选中的 tab 首次挂载后保持挂载（切换不丢本地草稿），与核心「插件」页同款行为。
     * 参数：
     *   props: object -- 槽位标准 props（用到 renderSlot）
     * 返回值：
     *   React 元素
     * 调用样例：
     *   ctx.slots.register({ name: 'settings.section', id: 'local-plugins', ... }, LocalPluginsSection)
     */
    function LocalPluginsSection(props) {
      const [, force] = React.useState(0)
      React.useEffect(() => {
        const slots = __slotsCtx && __slotsCtx.slots
        if (!slots || typeof slots.subscribe !== 'function') return undefined
        const off = slots.subscribe(LOCAL_TAB_SLOT, () => force((n) => n + 1))
        return () => { try { off() } catch { /* already gone */ } }
      }, [])
      const rows = localTabRows()
      const [active, setActive] = React.useState(undefined)
      const [visited, setVisited] = React.useState({})
      const current = rows.some((row) => row.id === active) ? active : (rows[0] ? rows[0].id : undefined)
      React.useEffect(() => {
        if (current === undefined) return
        setVisited((prev) => (prev[current] === true ? prev : { ...prev, [current]: true }))
      }, [current])
      const renderSlot = props && props.renderSlot
      if (rows.length === 0) return React.createElement('p', { style: S.empty }, t('noPlugins'))
      return React.createElement('div', { style: S.page },
        React.createElement('h3', { style: S.heading }, t('nav')),
        React.createElement('div', { style: S.tabs, role: 'tablist', 'aria-label': t('nav') },
          rows.map((row) => React.createElement('button', {
            key: row.id,
            type: 'button',
            role: 'tab',
            'aria-selected': row.id === current,
            'data-active': row.id === current ? 'true' : 'false',
            style: row.id === current ? S.tabActive : S.tab,
            onClick: () => setActive(row.id),
          }, row.label)),
        ),
        rows.filter((row) => row.id === current || visited[row.id] === true).map((row) => React.createElement('div', {
          key: row.id,
          role: 'tabpanel',
          style: { display: row.id === current ? 'flex' : 'none', flexDirection: 'column' },
        }, typeof renderSlot === 'function' ? renderSlot(LOCAL_TAB_SLOT, {}, { only: row.id }) : null)),
      )
    }

    /** The manager's own panel — first tab of the local-plugins entry. */
    function LocalPluginsPanel() {
      const [data, setData] = useState(null)
      const [err, setErr] = useState(null)
      const [busy, setBusy] = useState(null) // 'migrate' | dir name
      const [notice, setNotice] = useState(null) // {type:'ok'|'err'|'warn', text}
      const [needReload, setNeedReload] = useState(false)
      const [applying, setApplying] = useState(false)
      // null = follow the host's suggested target set; an array = the user's own picks.
      const [pick, setPick] = useState(null)
      const seq = useRef(0)
      const applySeq = useRef(0)

      const load = useCallback(async () => {
        const id = ++seq.current
        try {
          // The panel ships in the client bundle, which loads independently of the
          // host half. When the host half never mounted its routes, /list answers
          // 404 with an EMPTY body, and res.json() used to throw the bare
          // "Unexpected end of JSON input" — a message naming neither the endpoint
          // nor the fix. Classify the transport first, then parse defensively.
          let res = null
          try {
            res = await fetch(`${API}/list`)
          } catch (e) {
            throw new Error(t('hostOffline').replace('{reason}', (e && e.message) || String(e)))
          }
          let json = null
          try { json = await res.json() } catch { json = null }
          if (id !== seq.current) return
          if (!res.ok) {
            const detail = (json && json.error) || (res.status === 404 ? t('hostDown') : t('hostNotJson'))
            throw new Error(String(detail).replace('{status}', String(res.status)))
          }
          if (!json || json.ok !== true) throw new Error((json && json.error) || `HTTP ${res.status}`)
          setData(json.data)
          setErr(null)
        } catch (e) {
          if (id !== seq.current) return
          setErr((e && e.message) || String(e))
        }
      }, [])

      useEffect(() => { load() }, [load])

      const settle = useCallback(async () => {
        const id = ++applySeq.current
        setApplying(true)
        try {
          const t0 = Date.now()
          for (;;) {
            let queued = 0
            let rtt = Infinity
            const s = Date.now()
            try {
              const res = await fetch(`${API}/status`, { cache: 'no-store' })
              const json = await res.json()
              rtt = Date.now() - s
              queued = Number(json.pendingWrites || 0)
            } catch { /* host busy or restarting: keep waiting */ }
            if (queued === 0 && rtt <= HOST_IDLE_RTT_MS) return
            if (Date.now() - t0 > APPLY_MAX_MS) return
            await new Promise((r) => setTimeout(r, APPLY_POLL_MS))
          }
        } finally {
          if (id === applySeq.current) setApplying(false)
        }
      }, [])

      const run = useCallback(async (path, body, what) => {
        setBusy(what)
        setNotice(null)
        try {
          const res = await fetch(path, {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(body || {}),
          })
          const json = await res.json().catch(() => ({}))
          if (!res.ok || json.ok === false) {
            throw new Error(json.error || `HTTP ${res.status}`)
          }
          setData(json.data || null)
          // The response already carries the requested state (the host overlays
          // queued intents); the flush and the core re-application behind it are
          // what the user experiences as the stall.
          await settle()
          void load()
          return json
        } catch (e) {
          setNotice({ type: 'err', text: `${t('error')}: ${(e && e.message) || String(e)}` })
          return null
        } finally {
          setBusy(null)
        }
      }, [settle, load])

      const toggle = (plugin) => {
        const target = !plugin.active
        const what = `${plugin.dir}:${target ? 'on' : 'off'}`
        run(`${API}/set-enabled`, { dir: plugin.dir, enabled: target }, what).then((json) => {
          if (!json) return
          if (plugin.hasClient) {
            setNeedReload(true)
            setNotice({ type: 'ok', text: `${t('reload')}（${plugin.name}）` })
          } else {
            setNotice({ type: 'ok', text: `${plugin.name} ${target ? t('stateActive') : t('stateDisabled')}` })
          }
        })
      }

      const remove = (plugin) => {
        if (typeof window !== 'undefined' && window.confirm && !window.confirm(`${plugin.name}：${t('removeConfirm')}`)) return
        run(`${API}/remove`, { dir: plugin.dir }, plugin.dir).then((json) => {
          if (!json) return
          if (plugin.hasClient) setNeedReload(true)
          setNotice({ type: 'ok', text: `${plugin.name} ${t('stateUninstalled')}` })
        })
      }

      const migrate = () => {
        if (typeof window !== 'undefined' && window.confirm && !window.confirm(t('migrateConfirm'))) return
        run(`${API}/migrate`, {}, 'migrate').then((json) => {
          if (!json) return
          setNeedReload(true)
          setNotice({ type: 'ok', text: `${t('migrate')} ✓ · ${t('reloadHint')}` })
        })
      }

      // Safe update face: the host hands back the updatable targets plus whatever
      // update record is already staged. Preparing never installs anything.
      const safeUpdate = (data && data.safeUpdate) || null
      const upTargets = (safeUpdate && safeUpdate.targets) || []
      const picked = pick == null ? ((safeUpdate && safeUpdate.suggested) || []) : pick
      const togglePick = (n) => setPick(picked.includes(n) ? picked.filter((x) => x !== n) : picked.concat([n]))
      const prepareUpdate = () => {
        run(`${API}/update/prepare`, { targets: picked }, 'update-prepare').then((json) => {
          if (!json) return
          setNotice({ type: 'ok', text: t('safeUpdatePrepared') })
        })
      }
      const cancelUpdate = () => {
        run(`${API}/update/cancel`, {}, 'update-cancel').then((json) => {
          if (!json) return
          setNotice({ type: 'ok', text: t('safeUpdateCancelled') })
        })
      }
      const copyScriptPath = () => {
        const p = (safeUpdate && safeUpdate.scriptPath) || ''
        try {
          if (typeof navigator !== 'undefined' && navigator.clipboard) void navigator.clipboard.writeText(p)
        } catch { /* clipboard unavailable: the path stays visible */ }
        setNotice({ type: 'ok', text: t('safeUpdateCopied') })
      }

      const plugins = (data && data.plugins) || []
      const legacyDetected = data ? data.legacyDetected : false
      const batchCounts = (data && data.batchCounts) || localBatchCounts(plugins)
      // Dependency-repair face: the host reports (read-only) every plugin whose
      // declaration is not what this repo needs (a leftover workspace:* key or an
      // absolute link: spec instead of the relative profile mirror) and repairs
      // the determinable ones; this panel shows what it found and offers the
      // same action.
      const repairPlan = (data && data.repairPlan) || { count: 0, manualCount: 0, auto: [], manual: [] }
      const staleTotal = (repairPlan.count || 0) + (repairPlan.manualCount || 0)
      const autoRelinkOn = data ? data.autoRelinkEnabled !== false : true
      const relink = () => {
        run(`${API}/repair`, {}, 'relink').then((json) => {
          if (!json) return
          const info = json.relink || {}
          const failed = info.failed || []
          if (failed.length > 0) {
            setNotice({ type: 'err', text: `${t('relinkFailed')}: ${failed.map((f) => f.name || f.dir).join(', ')}` })
            return
          }
          if (info.noop) { setNotice({ type: 'ok', text: t('relinkNoop') }); return }
          setNotice({ type: 'ok', text: t('relinkDone').replace('{n}', String((info.relinked || []).length)) })
        })
      }
      const isStale = (p) => p.depState === 'stale-mismatch' || p.depState === 'stale-target-missing'
      // The uninstall command is copied, never executed here: removing the manager
      // is destructive and needs pnpm, so it stays a terminal action.
      const uninstall = (data && data.uninstall) || null
      const copyUninstall = () => {
        const command = (uninstall && uninstall.command) || ''
        const clipboard = typeof navigator !== 'undefined' && navigator.clipboard ? navigator.clipboard : null
        if (clipboard && typeof clipboard.writeText === 'function') {
          clipboard.writeText(command).then(
            () => setNotice({ type: 'ok', text: t('uninstallCopied') }),
            () => setNotice({ type: 'ok', text: t('uninstallManual') }),
          )
          return
        }
        setNotice({ type: 'ok', text: t('uninstallManual') })
      }

      // 批量动作：宿主一次安装 + 一次写入；这里只负责确认、发起与逐项结果呈现。
      // mode: 'on' 全部开启 | 'off' 全部关闭 | 'remove' 全部移除（破坏性）。
      const runBatch = (mode) => {
        const enabled = mode === 'on'
        const removing = mode === 'remove'
        const info = (enabled ? batchCounts.enable : removing ? batchCounts.remove : batchCounts.disable) || { count: 0 }
        const n = info.count || 0
        if (n === 0) return
        let msg = (enabled ? t('batchConfirmOn') : removing ? t('removeAllConfirm') : t('batchConfirmOff')).replace('{n}', String(n))
        if (info.skippedLegacy > 0) msg += `\n${t('batchSkipLegacy').replace('{n}', String(info.skippedLegacy))}`
        if (typeof window !== 'undefined' && window.confirm && !window.confirm(msg)) return
        const url = removing ? `${API}/remove-all` : `${API}/set-all-enabled`
        run(url, removing ? {} : { enabled }, removing ? 'all:remove' : enabled ? 'all:on' : 'all:off').then((json) => {
          if (!json) return
          const results = json.results || []
          const counts = json.counts || {}
          const applied = results.filter((r) => r.outcome === 'applied')
          const failed = results.filter((r) => r.outcome === 'failed')
          const skippedLegacy = results.filter((r) => r.outcome === 'skipped' && r.reason === 'legacy-layout').length
          const lines = [(enabled ? t('batchDoneOn') : removing ? t('removeAllDone') : t('batchDoneOff')).replace('{n}', String(applied.length))]
          if (counts.installed > 0) lines[0] += t('batchInstalled').replace('{n}', String(counts.installed))
          // 合并窗口里被作废的开关操作要如实说明，不能静默吞掉用户刚点的动作。
          if (removing && Number(json.discardedIntents || 0) > 0) {
            lines[0] += t('removeAllDiscarded').replace('{n}', String(json.discardedIntents))
          }
          if (skippedLegacy > 0) lines.push(t('batchSkipLegacy').replace('{n}', String(skippedLegacy)))
          // 带浏览器界面的子插件被改动后，界面要刷新一次才会出现/消失（沿用既有约定，不自动刷新）。
          if (applied.some((r) => r.hasClient)) {
            setNeedReload(true)
            lines.push(t('reload'))
          }
          if (failed.length > 0) {
            lines.push(`${t('batchFailed').replace('{n}', String(failed.length))}${failed.map((f) => `${f.name}（${f.error || f.reason}）`).join('、')}`)
          }
          setNotice({ type: failed.length > 0 ? 'err' : 'ok', text: lines.join(' ') })
        })
      }

      const batchButton = (mode) => {
        const enabled = mode === 'on'
        const removing = mode === 'remove'
        const info = (enabled ? batchCounts.enable : removing ? batchCounts.remove : batchCounts.disable) || { count: 0 }
        const n = info.count || 0
        const base = enabled ? t('enableAll') : removing ? t('removeAll') : t('disableAll')
        const label = `${base} (${n})`
        // 只有被点的那一个显示「处理中…」，其余保持置灰可读。
        const running = busy === (removing ? 'all:remove' : enabled ? 'all:on' : 'all:off')
        return React.createElement('button', {
          style: { ...S.button, ...(removing ? S.buttonDanger : {}), ...(n === 0 ? S.buttonDisabled : {}) },
          disabled: Boolean(busy) || n === 0,
          title: enabled ? t('enableAllHint') : removing ? t('removeAllHint') : t('disableAllHint'),
          onClick: () => runBatch(mode),
        }, running ? t('workingAll') : label)
      }

      const isBusy = (p) => busy === p.dir || busy === 'migrate' || (typeof busy === 'string' && busy.indexOf('all') === 0)

      return React.createElement('div', { style: S.page },
        React.createElement('h3', { style: S.heading }, t('nav')),
        React.createElement('p', { style: S.intro }, t('intro')),
        React.createElement('div', { style: S.metaRow },
          data && React.createElement('span', null, `${t('repoRoot')}: ${data.repoRoot}`),
          data && data.pluginsRoot && data.pluginsRoot !== data.repoRoot
            && React.createElement('span', null, `${t('pluginsRoot')}: ${data.pluginsRoot}`),
          data && React.createElement('span', null, `${t('profile')}: ${data.profileName}`),
        ),
        err && React.createElement('p', { style: S.err }, `${t('error')}: ${err}`),
        data && data.yamlError && React.createElement('p', { style: { ...S.err, marginTop: 0 } }, `YAML: ${data.yamlError}`),
        applying && React.createElement('div', { style: S.banner },
          React.createElement('span', { style: { flex: 1, fontSize: 13 } }, t('applying')),
        ),
        notice && React.createElement('div', { style: { ...S.banner, ...(notice.type === 'err' ? S.bannerWarn : S.bannerOk) } },
          React.createElement('p', { style: S.notice }, notice.text),
          needReload && React.createElement('button', { style: S.button, onClick: () => { if (typeof window !== 'undefined') window.location.reload() } }, t('refresh')),
        ),
        data && legacyDetected && React.createElement('div', { style: { ...S.banner, ...S.bannerWarn } },
          React.createElement('span', { style: { flex: 1, fontSize: 13 } }, t('migrateNeed')),
          React.createElement('button', {
            style: { ...S.button, ...S.buttonPrimary },
            disabled: Boolean(busy),
            onClick: migrate,
          }, busy === 'migrate' ? t('migrateBusy') : t('migrate')),
        ),
        staleTotal > 0 && React.createElement('div', { style: { ...S.banner, ...S.bannerWarn } },
          React.createElement('div', { style: { flex: 1, display: 'flex', flexDirection: 'column', gap: 4 } },
            React.createElement('span', { style: { fontSize: 13 } },
              t('linkBanner')
                .replace('{n}', String(staleTotal))
                .replace('{m}', String(repairPlan.count || 0))
                .replace('{k}', String(repairPlan.manualCount || 0))),
            !autoRelinkOn && React.createElement('span', { style: { fontSize: 12 } }, t('autoRelinkOff')),
            (repairPlan.auto || []).slice(0, 3).map((p) => React.createElement('span', { key: 'auto-' + p.dir, style: { fontSize: 12 } },
              `${p.name}: ${p.declared || '—'} → ${p.expected || ''}`)),
            (repairPlan.manual || []).slice(0, 3).map((p) => React.createElement('span', { key: 'manual-' + p.dir, style: { fontSize: 12 } },
              `${p.name}: ${p.reason || ''}`)),
          ),
          (repairPlan.count || 0) > 0 && React.createElement('button', {
            style: { ...S.button, ...S.buttonPrimary },
            disabled: Boolean(busy) || staleTotal === 0,
            onClick: relink,
          }, busy === 'relink' ? t('relinkBusy') : t('relink')),
        ),
        React.createElement('div', { style: S.toolbar },
          React.createElement('div', { style: S.toolbarGroup }, batchButton('on'), batchButton('off'), batchButton('remove')),
          React.createElement('button', { style: S.button, onClick: load, disabled: Boolean(busy) }, t('refresh')),
        ),
        safeUpdate && React.createElement('div', { style: S.banner },
          React.createElement('div', { style: { flex: 1, display: 'flex', flexDirection: 'column', gap: 6, minWidth: 0 } },
            React.createElement('span', { style: { fontSize: 13, fontWeight: 600 } }, t('safeUpdateTitle')),
            React.createElement('span', { style: { fontSize: 12 } }, t('safeUpdateBody')),
            upTargets.length === 0
              ? React.createElement('span', { style: { fontSize: 12 } }, t('safeUpdateNone'))
              : React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 4 } },
                  React.createElement('span', { style: { fontSize: 12 } }, t('safeUpdatePick')),
                  upTargets.map((tg) => React.createElement('label', { key: tg.name, style: { display: 'flex', alignItems: 'center', gap: 6, fontSize: 12 } },
                    React.createElement('input', {
                      type: 'checkbox',
                      checked: picked.includes(tg.name),
                      disabled: Boolean(busy) || Boolean(safeUpdate.pending),
                      onChange: () => togglePick(tg.name),
                    }),
                    React.createElement('span', null, `${tg.name} (${tg.kind})`),
                    React.createElement('code', { style: { fontSize: 11, opacity: .7 } }, tg.arg || ''),
                  )),
                ),
            safeUpdate.pending && React.createElement('span', { style: { fontSize: 12 } },
              t('safeUpdatePending').replace('{n}', String((safeUpdate.pending.targets || []).length))),
            safeUpdate.pending && React.createElement('code', { style: { fontSize: 12, wordBreak: 'break-all' } }, safeUpdate.scriptPath || ''),
            safeUpdate.pending && React.createElement('span', { style: { fontSize: 12 } }, t('safeUpdateRunHint')),
          ),
          React.createElement('div', { style: { display: 'flex', flexDirection: 'column', gap: 6, flex: 'none' } },
            safeUpdate.pending
              ? React.createElement('button', { style: { ...S.button, ...S.buttonDanger }, disabled: Boolean(busy), onClick: cancelUpdate }, busy === 'update-cancel' ? t('busy') : t('safeUpdateCancel'))
              : React.createElement('button', { style: { ...S.button, ...S.buttonPrimary, ...(picked.length === 0 ? S.buttonDisabled : {}) }, disabled: Boolean(busy) || picked.length === 0, onClick: prepareUpdate }, busy === 'update-prepare' ? t('busy') : t('safeUpdatePrepare')),
            safeUpdate.pending && React.createElement('button', { style: S.button, onClick: copyScriptPath }, t('safeUpdateCopy')),
          ),
        ),
        uninstall && React.createElement('div', { style: S.banner },
          React.createElement('div', { style: { flex: 1, display: 'flex', flexDirection: 'column', gap: 4 } },
            React.createElement('span', { style: { fontSize: 13 } }, t('uninstallTitle')),
            React.createElement('span', { style: { fontSize: 12 } },
              t('uninstallBody')
                .replace('{rows}', String((uninstall.willRemove && uninstall.willRemove.rows) || 0))
                .replace('{deps}', String((uninstall.willRemove && uninstall.willRemove.deps) || 0))),
            React.createElement('code', { style: { fontSize: 12, wordBreak: 'break-all' } }, uninstall.command),
          ),
          React.createElement('button', { style: S.button, onClick: copyUninstall }, t('uninstallCopy')),
        ),
        plugins.length === 0
          ? React.createElement('p', { style: S.empty }, t('noPlugins'))
          : React.createElement('ul', { style: S.list }, plugins.map((p) => {
              const legacy = p.legacyBundle === true || p.state === 'legacy'
              const stateLabel = legacy ? t('stateLegacy') : stateText(p.state)
              return React.createElement('li', { key: p.dir, style: { ...S.card, ...(p.state === 'invalid' ? S.cardInvalid : {}) } },
                React.createElement('span', {
                  style: { ...S.dot, ...(legacy ? S.dotLegacy : ({ active: S.dotActive, disabled: S.dotDisabled, uninstalled: S.dotUninstalled, inactive: S.dotUninstalled, invalid: S.dotDisabled }[p.state] || S.dotDisabled)) },
                  title: stateLabel,
                }),
                React.createElement('div', { style: S.body },
                  React.createElement('div', { style: S.titleRow },
                    React.createElement('p', { style: S.title }, p.name || p.dir),
                    React.createElement('span', { style: S.badge }, p.dir),
                    p.hasClient && React.createElement('span', { style: S.badge }, t('hasClientTag')),
                  ),
                  p.description ? React.createElement('p', { style: S.desc }, p.description) : null,
                ),
                React.createElement('span', { style: { ...S.state, color: legacy ? S.stateColor('legacy') : S.stateColor(p.state) } }, stateLabel),
                isStale(p) && React.createElement('span', { style: S.badge, title: p.depDeclared || '' }, t('linkStaleBadge')),
                React.createElement('div', { style: S.actions },
                  p.state === 'invalid'
                    ? null
                    : legacy
                      ? React.createElement('button', { style: { ...S.button, ...S.buttonDisabled }, disabled: true }, t('stateLegacy'))
                      : React.createElement('button', {
                          'aria-checked': p.active,
                          role: 'switch',
                          disabled: isBusy(p),
                          title: p.active ? t('stateDisabled') : t('stateActive'),
                          style: { ...S.switch, ...(p.active ? S.switchOn : {}) },
                          onClick: () => toggle(p),
                        }, React.createElement('span', { style: { ...S.thumb, transform: p.active ? 'translateX(16px)' : 'none' } })),
                  (!legacy && (p.state === 'active' || p.state === 'disabled' || p.state === 'inactive'))
                    ? React.createElement('button', {
                        style: { ...S.button, ...S.buttonDanger },
                        disabled: isBusy(p),
                        onClick: () => remove(p),
                      }, t('remove'))
                    : null,
                ),
              )
            }),
          ),
      )
    }

    // --- registration --------------------------------------------------------
    function apply(ctx) {
      // One tab inside the core "Plugins" settings page (ui-settings-plugins owns
      // the single Plugins nav entry + tab chrome); no Settings nav row of our own.
      // One settings nav entry「本地插件」owned here; every local plugin contributes a
      // tab into the child slot this entry declares (no extra Settings nav rows).
      __slotsCtx = ctx
      ctx.slots.inject('settings.section', () => ctx.slots.register({
        name: 'settings.section',
        id: 'local-plugins',
        order: 16,
        label: () => t('nav'),
        children: { [LOCAL_TAB_SLOT]: { kind: 'list', scope: 'root' } },
      }, LocalPluginsSection))
      ctx.slots.inject(LOCAL_TAB_SLOT, () => ctx.slots.register({
        name: LOCAL_TAB_SLOT,
        id: 'plugins',
        order: 0,
        label: () => t('nav'),
      }, LocalPluginsPanel))
    }

    // Test-only hooks (window.__DSH_TEST__ is set by test/bundle.test.mjs only).
    if (typeof window !== 'undefined' && window.__DSH_TEST__) {
      window.__dshPluginManagerTest = { stateText, API, NS, localBatchCounts }
    }

    return { apply, inject: ['slots'] }
  },
})
//# sourceURL=/dsh-plugin-manager/src/client.js
