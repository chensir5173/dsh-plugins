// dsh-agent-preset-manager: CLIENT half — the「Agent 预设」tab.
//
// One tab inside the core「本地插件」settings entry (settings.localPlugins.tab,
// order 20). The entry itself is declared by dsh-plugin-manager, so this client
// only contributes the child slot row and renders its panel — no Settings nav
// row of its own.
//
// Every number and every action on screen comes from the host half's read-only
// status endpoint (/__dsh-agent-presets/state) plus the six verb endpoints; the
// panel never touches the filesystem, the profile, or the host registry. When
// the running DSH build has no agent-preset registry, the state still renders:
// the panel then shows 「当前 DSH 版本不支持运行期声明」 and greys out the
// enable/disable switches instead of pretending the feature works.
//
// Bundle format (client-modules protocol): classic script registering a factory
// via window.__ModuleLoader__.load({ id, factory }); the factory receives the
// module-table `require` (react is a seeded word) and returns { apply, inject }.
// No JSX — plain React.createElement + inline styles on --dsw-* tokens.
window.__ModuleLoader__.load({
  id: 'dsh-agent-preset-manager',
  factory: (require) => {
    'use strict'
    const React = require('react')
    const { useCallback, useEffect, useRef, useState } = React

    // --- copy ---------------------------------------------------------------
    const NS = 'dshAgentPresetManager'
    const zhDict = {
      nav: 'Agent 预设',
      intro: '从本地目录加载 agent preset，并在运行期声明到当前 DSH 会话。旧版 .agent-presets 目录会被兼容读取并可以迁移到新目录。',
      refresh: '刷新',
      busy: '处理中…',
      create: '新增预设',
      createHint: '从内置 standard 预设的插件清单快速起一个预设，随后可在下方编辑它的组合。',
      import: '导入目录',
      importHint: '把一个已经存在的预设目录复制进预设库（不改动原目录）。',
      migrate: '迁移旧目录',
      migrateHint: '把 ~/.dsh/.agent-presets 下的旧预设复制到新目录 agent-presets。',
      remove: '删除',
      save: '保存',
      cancel: '取消',
      confirm: '确认',
      edit: '编辑组合',
      collapse: '收起',
      idLabel: '预设 id',
      idPlaceholder: '只能是小写字母、数字、短横线或下划线',
      pathLabel: '目录路径',
      pathPlaceholder: '例如 C:\\presets\\my-preset',
      nameLabel: '显示名称',
      descriptionLabel: '说明',
      orderLabel: '顺序 order',
      runtimeOk: '运行期声明可用',
      runtimeOff: '当前 DSH 版本不支持运行期声明，只能查看与编辑',
      libraryCurrent: '新目录',
      libraryLegacy: '旧目录',
      empty: '预设库还是空的：可以「新增预设」或「导入目录」。',
      emptyFiltered: '没有符合筛选条件的预设。',
      filterAll: '全部',
      filterEnabled: '已启用',
      filterDisabled: '未启用',
      filterBroken: '有问题',
      rows: '插件行',
      rowsUnit: '行',
      stateEnabled: '已启用',
      stateDisabled: '未启用',
      stateInvalid: '组合有问题',
      stateFailed: '声明未生效',
      stateMissing: '目录不存在',
      stateConflict: '新旧目录重名',
      statusLegacyPrefix: '旧目录优先：',
      shadowed: '两个目录里都有这个 id，旧目录优先',
      created: '已创建 {id}',
      saved: '已保存 {id}',
      removed: '已删除 {id}',
      imported: '已导入 {id}',
      migrated: '已迁移 {n} 个预设',
      nothingToMigrate: '旧目录里没有可迁移的预设。',
      enableFailed: '启用失败',
      saveFailed: '保存失败',
      loadFailed: '读取状态失败',
      removeConfirm: '删除会移除声明并删除磁盘上的预设目录，不可撤销。确定删除 {id}？',
      migrateConfirm: '将把旧目录里的 {n} 个预设复制到新目录（原目录保留）。继续？',
      importConfirm: '将复制目录到 {target}。继续？',
      needId: '请先填写预设 id。',
      needPath: '请先填写目录路径。',
      noBackup: '（无备份）',
      backupAt: '备份：{file}',
      reloadHint: '启用/停用会立刻作用于宿主；面板显示的启用状态以 DSH 记录的为准。',
      problem: '问题',
      copied: '已复制',
      copy: '复制路径',
      legacyBadge: '旧目录',
      hostUnavailable: '宿主服务不可用',
      close: '关闭',
    }
    const enDict = {
      nav: 'Agent presets',
      intro: 'Load agent presets from local directories and declare them to the running DSH session. The legacy .agent-presets directory is still read and can be migrated.',
      refresh: 'Refresh',
      busy: 'Working…',
      create: 'New preset',
      createHint: 'Seeds a preset from the built-in standard plugin list; edit its composition below.',
      import: 'Import directory',
      importHint: 'Copies an existing preset directory into the preset library (the source stays untouched).',
      migrate: 'Migrate old library',
      migrateHint: 'Copies presets from ~/.dsh/.agent-presets into the current agent-presets directory.',
      remove: 'Delete',
      save: 'Save',
      cancel: 'Cancel',
      confirm: 'Confirm',
      edit: 'Edit composition',
      collapse: 'Collapse',
      idLabel: 'Preset id',
      idPlaceholder: 'lowercase letters, digits, dash or underscore',
      pathLabel: 'Directory',
      pathPlaceholder: 'e.g. C:\\presets\\my-preset',
      nameLabel: 'Display name',
      descriptionLabel: 'Description',
      orderLabel: 'Order',
      runtimeOk: 'Runtime declaration available',
      runtimeOff: 'This DSH build has no agent-preset registry: view and edit only',
      libraryCurrent: 'Current',
      libraryLegacy: 'Legacy',
      empty: 'The preset library is empty: create a preset or import a directory.',
      emptyFiltered: 'No preset matches the filter.',
      filterAll: 'All',
      filterEnabled: 'Enabled',
      filterDisabled: 'Disabled',
      filterBroken: 'Problems',
      rows: 'Plugin rows',
      rowsUnit: 'rows',
      stateEnabled: 'Enabled',
      stateDisabled: 'Disabled',
      stateInvalid: 'Broken composition',
      stateFailed: 'Declaration inactive',
      stateMissing: 'Directory missing',
      stateConflict: 'Duplicate in both libraries',
      statusLegacyPrefix: 'Legacy wins: ',
      shadowed: 'This id exists in both libraries; the legacy one wins',
      created: 'Created {id}',
      saved: 'Saved {id}',
      removed: 'Deleted {id}',
      imported: 'Imported {id}',
      migrated: 'Migrated {n} presets',
      nothingToMigrate: 'Nothing to migrate in the legacy library.',
      enableFailed: 'Enable failed',
      saveFailed: 'Save failed',
      loadFailed: 'Could not read the state',
      removeConfirm: 'Deleting removes the declaration and the directory on disk. Delete {id}?',
      migrateConfirm: 'Copies {n} presets into the current library (the old directory stays). Continue?',
      importConfirm: 'Copies the directory to {target}. Continue?',
      needId: 'Fill in the preset id first.',
      needPath: 'Fill in the directory first.',
      noBackup: '(no backup)',
      backupAt: 'Backup: {file}',
      reloadHint: 'Enabling acts on the host immediately; the panel shows what DSH recorded.',
      problem: 'Problem',
      copied: 'Copied',
      copy: 'Copy path',
      legacyBadge: 'legacy',
      hostUnavailable: 'Host service unavailable',
      close: 'Close',
    }

    /**
     * 功能作用：取文案（中文优先，英文兜底），并把 {name} 占位符替换成 values 里的值。
     * 参数：
     *   key: string -- 文案键
     *   values: object -- 可选占位符
     * 返回值：string
     * 调用样例：t('removed', { id: 'mine' })
     */
    function t(key, values) {
      const dict = zhDict[key] === undefined ? enDict : zhDict
      let text = dict[key] === undefined ? key : dict[key]
      if (values) {
        for (const name of Object.keys(values)) text = text.split('{' + name + '}').join(String(values[name]))
      }
      return text
    }
    void NS

    // --- styles -------------------------------------------------------------
    const S = {
      root: { display: 'flex', flexDirection: 'column', gap: 12, padding: '4px 0 24px', fontSize: 13, color: 'var(--dsw-alias-label-primary)' },
      intro: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
      toolbar: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
      spacer: { flex: 1 },
      button: { font: 'inherit', cursor: 'pointer', color: 'var(--dsw-alias-label-primary)', background: 'var(--dsw-alias-bg-layer-1)', border: '.5px solid var(--dsw-alias-border-l3)', borderRadius: 8, padding: '4px 12px', fontSize: 12 },
      buttonPrimary: { background: 'var(--dsw-alias-label-primary)', color: 'var(--dsw-alias-bg-layer-3)', border: 'none' },
      buttonDanger: { color: 'var(--dsw-alias-status-error, #d4380d)', borderColor: 'var(--dsw-alias-status-error, #d4380d)' },
      buttonDisabled: { opacity: 0.5, cursor: 'default' },
      input: { font: 'inherit', color: 'inherit', background: 'var(--dsw-alias-bg-layer-1)', border: '.5px solid var(--dsw-alias-border-l3)', borderRadius: 4, padding: '6px 8px', minWidth: 200 },
      textarea: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, lineHeight: '18px', color: 'inherit', background: 'var(--dsw-alias-bg-layer-1)', border: '.5px solid var(--dsw-alias-border-l3)', borderRadius: 8, padding: 10, minHeight: 220, width: '100%', boxSizing: 'border-box', resize: 'vertical' },
      card: { border: '.5px solid var(--dsw-alias-border-l4)', background: 'var(--dsw-alias-bg-layer-3)', borderRadius: 14, padding: '12px 14px', display: 'flex', flexDirection: 'column', gap: 10 },
      cardHead: { display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap' },
      cardTitle: { fontSize: 13, fontWeight: 600 },
      cardId: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)', fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace' },
      cardMeta: { fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
      cardActions: { display: 'flex', gap: 8, alignItems: 'center', flexWrap: 'wrap' },
      tag: { fontSize: 11, lineHeight: '16px', padding: '1px 8px', borderRadius: 999, border: '.5px solid var(--dsw-alias-border-l3)', color: 'var(--dsw-alias-label-secondary)' },
      tagOn: { color: 'var(--dsw-alias-label-primary)', borderColor: 'var(--dsw-alias-label-primary)' },
      tagWarn: { color: 'var(--dsw-alias-status-warning, #d48806)', borderColor: 'var(--dsw-alias-status-warning, #d48806)' },
      tagBad: { color: 'var(--dsw-alias-status-error, #d4380d)', borderColor: 'var(--dsw-alias-status-error, #d4380d)' },
      banner: { border: '.5px solid var(--dsw-alias-border-l4)', background: 'var(--dsw-alias-bg-layer-3)', borderRadius: 12, padding: '10px 14px', display: 'flex', gap: 10, alignItems: 'center', flexWrap: 'wrap', fontSize: 13 },
      bannerWarn: { borderColor: 'var(--dsw-alias-status-warning, #d48806)' },
      bannerBad: { borderColor: 'var(--dsw-alias-status-error, #d4380d)' },
      bannerGood: { borderColor: 'var(--dsw-alias-status-success, #52c41a)' },
      error: { fontSize: 12, color: 'var(--dsw-alias-status-error, #d4380d)', whiteSpace: 'pre-wrap' },
      problems: { margin: 0, paddingLeft: 18, fontSize: 12, lineHeight: '18px', color: 'var(--dsw-alias-label-tertiary)' },
      form: { display: 'flex', flexDirection: 'column', gap: 8, border: '.5px solid var(--dsw-alias-border-l3)', borderRadius: 12, padding: '12px 14px' },
      field: { display: 'flex', flexDirection: 'column', gap: 4 },
      fieldLabel: { fontSize: 12, color: 'var(--dsw-alias-label-tertiary)' },
      switch: { boxSizing: 'border-box', width: 36, height: 20, borderRadius: 10, padding: 2, background: 'var(--dsw-alias-border-l3)', cursor: 'pointer', border: 'none', flex: 'none', position: 'relative' },
      switchOn: { background: 'var(--dsw-alias-label-primary)' },
      knob: { width: 16, height: 16, borderRadius: '50%', background: '#fff', transition: 'transform .12s ease', transform: 'translateX(0)' },
      knobOn: { transform: 'translateX(16px)' },
      mono: { fontFamily: 'ui-monospace, SFMono-Regular, Menlo, monospace', fontSize: 12, wordBreak: 'break-all' },
      pre: { margin: 0, padding: 8, background: 'var(--dsw-alias-bg-layer-1)', borderRadius: 8, fontSize: 12, overflowX: 'auto' },
      hidden: { display: 'none' },
      muted: { color: 'var(--dsw-alias-label-tertiary)', fontSize: 12 },
    }

    // --- host api -----------------------------------------------------------
    const API = '/__dsh-agent-presets'
    // The row this plugin contributes inside the core「本地插件」settings page.
    // The page itself belongs to dsh-plugin-manager (settings.section), so this
    // client only fills the tab slot it opened.
    const TAB_SLOT = 'settings.localPlugins.tab'
    const TAB_ID = 'agent-presets'
    const TAB_ORDER = 20

    /**
     * 功能作用：调用宿主半区的 JSON 端点。无论是 200 还是 4xx，服务端都把结果对象放在
     *           JSON 体里（{ ok, error, ... }），所以这里只在网络层失败时抛错。
     * 参数：
     *   action: string -- 端点名（state / set-enabled / create / save / remove / import / migrate）
     *   body: object|null -- POST 体；null 表示 GET
     *   query: object|null -- 可选查询串（GET 用，例如 /file?id=mine）
     * 返回值：Promise<object> -- 服务端 JSON
     * 调用样例：
     *   const state = await call('state', null)
     */
    async function call(action, body, query) {
      const options = { headers: { accept: 'application/json' } }
      if (body !== null && body !== undefined) {
        options.method = 'POST'
        options.headers['content-type'] = 'application/json'
        options.body = JSON.stringify(body)
      }
      let url = API + '/' + action
      if (query) {
        const parts = []
        for (const key of Object.keys(query)) parts.push(encodeURIComponent(key) + '=' + encodeURIComponent(String(query[key])))
        url += '?' + parts.join('&')
      }
      const response = await fetch(url, options)
      let payload = null
      try {
        payload = await response.json()
      } catch {
        payload = null
      }
      if (!payload || typeof payload !== 'object') {
        return { ok: false, error: t('hostUnavailable') + ' (HTTP ' + response.status + ')' }
      }
      return payload
    }

    // === CLIENT_PART_TWO ===

    /** 功能作用：把各种状态值映射成中文标签键。 */
    const STATE_TEXT = {
      enabled: 'stateEnabled',
      disabled: 'stateDisabled',
      invalid: 'stateInvalid',
      failed: 'stateFailed',
      missing: 'stateMissing',
      conflict: 'stateConflict',
    }
    const FILTERS = ['all', 'enabled', 'disabled', 'broken']

    /** 功能作用：合并两个样式对象（后者覆盖前者）。参数：base/extra。返回值：object。 */
    function merge(base, extra) {
      return extra ? Object.assign({}, base, extra) : base
    }

    /** 功能作用：状态对应的 tag 样式。参数：preset。返回值：样式对象或 null。 */
    function tagStyleOf(preset) {
      if (preset.status === 'invalid' || preset.status === 'failed') return S.tagBad
      if (preset.status === 'missing' || preset.status === 'conflict') return S.tagWarn
      if (preset.enabled) return S.tagOn
      return null
    }

    /** 功能作用：状态行文本（含体检问题的计数）。参数：preset。返回值：string。 */
    function statusTextOf(preset) {
      let text = t(STATE_TEXT[preset.status] || 'stateDisabled')
      if (preset.verdict && preset.verdict.level && preset.verdict.level !== 'ok') {
        text += ' / ' + t('problem') + ' ' + preset.verdictCounts.unavailable + '+' + preset.verdictCounts.suspect
      }
      return text
    }

    /** 功能作用：一行摘要（库、行数、启用状态）。参数：preset。返回值：string。 */
    function metaOf(preset) {
      const bits = []
      bits.push(preset.legacy ? t('libraryLegacy') : t('libraryCurrent'))
      if (typeof preset.rowCount === 'number') bits.push(preset.rowCount + ' ' + t('rowsUnit'))
      bits.push(preset.enabled ? t('stateEnabled') : t('stateDisabled'))
      return bits.join(' · ')
    }

    /** 功能作用：体检问题折成最多 3 行摘录。参数：problems。返回值：string[]。 */
    function problemLines(problems) {
      const list = Array.isArray(problems) ? problems : []
      const lines = list.slice(0, 3).map((row) => (row && row.rowId ? row.rowId + ' — ' : '') + ((row && row.reason) || ''))
      if (list.length > lines.length) lines.push('… +' + (list.length - lines.length))
      return lines
    }

    /** 功能作用：开关滑块。参数：props = { on, disabled, busy, onToggle, title }。返回值：React 元素。 */
    function Toggle(props) {
      const disabled = Boolean(props.disabled || props.busy)
      return React.createElement('button', {
        type: 'button',
        title: props.title || '',
        'aria-pressed': props.on ? 'true' : 'false',
        disabled: disabled,
        onClick: () => { if (!disabled) props.onToggle() },
        style: merge(S.switch, props.on ? S.switchOn : null, disabled ? S.buttonDisabled : null),
      }, React.createElement('span', { style: merge(S.knob, props.on ? S.knobOn : null) }))
    }

    /** 功能作用：组合编辑器（读取 agent.cordis.yml 原文，编辑后保存）。参数：props = { preset, busy, onSave, onClose }。 */
    function Editor(props) {
      const preset = props.preset
      const [text, setText] = useState('')
      const [loaded, setLoaded] = useState(false)
      const [loadError, setLoadError] = useState('')
      useEffect(() => {
        let alive = true
        setLoaded(false)
        setLoadError('')
        // GET /file hands back the composition text (the panel cannot read the
        // file itself). A failed read stays visible instead of saving an empty
        // composition over a preset that still works.
        call('file', null, { id: preset.id })
          .then((payload) => {
            if (!alive) return
            if (payload.ok && typeof payload.text === 'string') setText(payload.text)
            else setLoadError(payload.error || t('loadFailed'))
            setLoaded(true)
          })
          .catch(() => { if (alive) { setLoadError(t('loadFailed')); setLoaded(true) } })
        return () => { alive = false }
      }, [preset.id])
      return React.createElement('div', { style: S.form },
        React.createElement('div', { style: S.cardHead },
          React.createElement('span', { style: S.cardTitle }, t('edit')),
          React.createElement('span', { style: S.cardId }, preset.dir),
        ),
        loadError ? React.createElement('div', { style: S.error }, loadError) : null,
        loaded
          ? React.createElement('textarea', {
              style: S.textarea,
              value: text,
              spellCheck: false,
              onChange: (event) => setText(event.target.value),
            })
          : React.createElement('div', { style: S.muted }, loadError ? loadError : t('busy')),
        React.createElement('div', { style: S.cardActions },
          React.createElement('button', {
            type: 'button',
            style: merge(S.button, S.buttonPrimary, props.busy || !loaded ? S.buttonDisabled : null),
            disabled: props.busy || !loaded,
            onClick: () => props.onSave(preset.id, text),
          }, t('save')),
          React.createElement('button', { type: 'button', style: S.button, onClick: () => props.onClose() }, t('cancel')),
        ),
      )
    }

    /** 功能作用：单个预设卡片。参数：props = { preset, runtimeOk, busy, onToggle, onEdit, editing, onSave, onCloseEdit, onRemove }。 */
    function PresetCard(props) {
      const preset = props.preset
      const busy = Boolean(props.busy)
      const problems = Array.isArray(preset.problems) ? preset.problems : []
      const broken = preset.status === 'invalid' || preset.status === 'failed'
      const toggleDisabled = busy || !props.runtimeOk
      return React.createElement('div', { style: S.card },
        React.createElement('div', { style: S.cardHead },
          React.createElement('span', { style: S.cardTitle }, preset.name || preset.id),
          React.createElement('span', { style: S.cardId }, preset.id),
          React.createElement('span', { style: merge(S.tag, preset.legacy ? S.tagWarn : null) },
            preset.legacy ? t('legacyBadge') : t('libraryCurrent')),
          React.createElement('span', { style: merge(S.tag, tagStyleOf(preset)) }, statusTextOf(preset)),
          preset.shadowed ? React.createElement('span', { style: merge(S.tag, S.tagBad) }, t('shadowed')) : null,
          preset.status === 'conflict' ? React.createElement('span', { style: S.tagWarn }, t('stateConflict')) : null,
          React.createElement('span', { style: S.spacer }),
          React.createElement(Toggle, {
            on: Boolean(preset.enabled),
            disabled: toggleDisabled,
            busy: busy,
            title: props.runtimeOk ? '' : t('runtimeOff'),
            onToggle: () => props.onToggle(preset.id, !preset.enabled),
          }),
        ),
        React.createElement('div', { style: S.cardMeta }, metaOf(preset)),
        preset.description ? React.createElement('div', { style: S.cardMeta }, preset.description) : null,
        React.createElement('div', { style: S.mono }, preset.dir),
        preset.metadataError
          ? React.createElement('div', { style: S.error }, t('problem') + ': ' + preset.metadataError)
          : null,
        preset.compositionError
          ? React.createElement('div', { style: S.error }, t('problem') + ': ' + ((preset.compositionError && preset.compositionError.message) || preset.compositionError))
          : null,
        problems.length
          ? React.createElement('ul', { style: S.problems },
              problemLines(problems).map((line, index) => React.createElement('li', { key: index }, line)),
            )
          : null,
        React.createElement('div', { style: S.cardActions },
          React.createElement('button', {
            type: 'button',
            style: S.button,
            onClick: () => (props.editing ? props.onCloseEdit() : props.onEdit(preset.id)),
          }, props.editing ? t('collapse') : t('edit')),
          React.createElement('button', {
            type: 'button',
            style: merge(S.button, broken || busy ? null : S.buttonDanger),
            disabled: busy,
            onClick: () => props.onRemove(preset),
          }, t('remove')),
        ),
        props.editing
          ? React.createElement(Editor, { preset: preset, busy: busy, onSave: props.onSave, onClose: props.onCloseEdit })
          : null,
      )
    }

    /** 功能作用：导入确认卡。参数：props = { draft, onConfirm, onCancel, busy }。 */
    function ImportPanel(props) {
      const draft = props.draft
      const broken = draft.status === 'invalid'
      return React.createElement('div', { style: S.form },
        React.createElement('div', { style: S.cardTitle }, t('importConfirm', { target: draft.targetDir || '' })),
        React.createElement('div', { style: S.cardMeta }, metaOf(draft)),
        broken
          ? React.createElement('div', { style: S.error }, t('stateInvalid') + ': ' + ((draft.compositionError && draft.compositionError.message) || ''))
          : null,
        React.createElement('div', { style: S.cardActions },
          React.createElement('button', {
            type: 'button',
            style: merge(S.button, S.buttonPrimary, props.busy || broken ? S.buttonDisabled : null),
            disabled: props.busy || broken,
            onClick: () => props.onConfirm(),
          }, t('confirm')),
          React.createElement('button', { type: 'button', style: S.button, onClick: () => props.onCancel() }, t('cancel')),
        ),
      )
    }

    /** 功能作用：迁移确认卡。参数：props = { plans, skipped, onConfirm, onCancel, busy }。 */
    function MigratePanel(props) {
      const plans = Array.isArray(props.plans) ? props.plans : []
      const skipped = Array.isArray(props.skipped) ? props.skipped : []
      return React.createElement('div', { style: S.form },
        React.createElement('div', { style: S.cardTitle }, t('migrate')),
        plans.length === 0
          ? React.createElement('div', { style: S.muted }, t('nothingToMigrate'))
          : React.createElement('ul', { style: S.problems },
              plans.map((plan, index) => React.createElement('li', { key: index },
                (plan.id || '') + ' -> ' + (plan.targetDir || '') + (plan.conflict ? ' · ' + t('stateConflict') : '')),
              )),
        skipped.length ? React.createElement('div', { style: S.muted }, 'skipped: ' + skipped.length) : null,
        React.createElement('div', { style: S.cardActions },
          React.createElement('button', {
            type: 'button',
            style: merge(S.button, S.buttonPrimary, props.busy || plans.length === 0 ? S.buttonDisabled : null),
            disabled: props.busy || plans.length === 0,
            onClick: () => props.onConfirm(),
          }, t('confirm')),
          React.createElement('button', { type: 'button', style: S.button, onClick: () => props.onCancel() }, t('cancel')),
        ),
      )
    }

    /** 功能作用：新增预设表单。参数：props = { busy, submit(id), close() }。 */
    function CreatePanel(props) {
      const [id, setId] = useState('')
      const [error, setError] = useState('')
      return React.createElement('div', { style: S.form },
        React.createElement('div', { style: S.cardTitle }, t('create')),
        React.createElement('div', { style: S.muted }, t('createHint')),
        React.createElement('div', { style: S.field },
          React.createElement('span', { style: S.fieldLabel }, t('idLabel')),
          React.createElement('input', {
            style: S.input,
            value: id,
            spellCheck: false,
            placeholder: t('idPlaceholder'),
            onChange: (event) => setId(event.target.value),
          }),
        ),
        error ? React.createElement('div', { style: S.error }, error) : null,
        React.createElement('div', { style: S.cardActions },
          React.createElement('button', {
            type: 'button',
            style: merge(S.button, S.buttonPrimary, props.busy ? S.buttonDisabled : null),
            disabled: props.busy,
            onClick: () => {
              const value = id.trim()
              if (!value) { setError(t('needId')); return }
              setError('')
              props.submit(value)
            },
          }, t('create')),
          React.createElement('button', { type: 'button', style: S.button, onClick: () => props.close() }, t('cancel')),
        ),
      )
    }

    /** 功能作用：导入表单（第一步采集目录路径，第二步弹确认卡）。参数：props = { busy, submit(path), close() }。 */
    function ImportForm(props) {
      const [dir, setDir] = useState('')
      const [error, setError] = useState('')
      return React.createElement('div', { style: S.form },
        React.createElement('div', { style: S.cardTitle }, t('import')),
        React.createElement('div', { style: S.muted }, t('importHint')),
        React.createElement('div', { style: S.field },
          React.createElement('span', { style: S.fieldLabel }, t('pathLabel')),
          React.createElement('input', {
            style: S.input,
            value: dir,
            spellCheck: false,
            placeholder: t('pathPlaceholder'),
            onChange: (event) => setDir(event.target.value),
          }),
        ),
        error ? React.createElement('div', { style: S.error }, error) : null,
        React.createElement('div', { style: S.cardActions },
          React.createElement('button', {
            type: 'button',
            style: merge(S.button, S.buttonPrimary, props.busy ? S.buttonDisabled : null),
            disabled: props.busy,
            onClick: () => {
              const value = dir.trim()
              if (!value) { setError(t('needPath')); return }
              setError('')
              props.submit(value)
            },
          }, t('import')),
          React.createElement('button', { type: 'button', style: S.button, onClick: () => props.close() }, t('cancel')),
        ),
      )
    }

    /** 功能作用：面板根组件，持有全部状态并驱动宿主端点。参数：props = { ctx }。 */
    function AgentPresetsPanel() {
      const [state, setState] = useState(null)
      const [error, setError] = useState('')
      const [notice, setNotice] = useState('')
      const [busy, setBusy] = useState('')
      const [filter, setFilter] = useState('all')
      const [editing, setEditing] = useState('')
      const [form, setForm] = useState('')
      const [draft, setDraft] = useState(null)
      const [plans, setPlans] = useState(null)
      const aliveRef = useRef(true)
      useEffect(() => {
        aliveRef.current = true
        return () => { aliveRef.current = false }
      }, [])

      const load = useCallback(async () => {
        setBusy('state')
        try {
          const payload = await call('state', null)
          if (!aliveRef.current) return
          if (payload.ok) { setState(payload); setError('') } else { setError(payload.error || t('loadFailed')) }
        } finally {
          if (aliveRef.current) setBusy('')
        }
      }, [])
      useEffect(() => { load() }, [load])

      const submit = useCallback(async (action, body, okKey, values) => {
        setBusy(action)
        try {
          const payload = await call(action, body)
          if (!aliveRef.current) return payload
          if (payload.state) setState(payload.state)
          if (payload.ok) {
            setError('')
            setNotice(okKey ? t(okKey, values || {}) : '')
          } else {
            setError(payload.error || t('loadFailed'))
            setNotice('')
          }
          return payload
        } finally {
          if (aliveRef.current) setBusy('')
        }
      }, [])

      const runtimeOk = Boolean(state && state.runtime && state.runtime.supported)
      const presets = (state && Array.isArray(state.presets) ? state.presets : []).filter((preset) => {
        if (filter === 'enabled') return Boolean(preset.enabled)
        if (filter === 'disabled') return !preset.enabled
        if (filter === 'broken') return Boolean(preset.problems && preset.problems.length) || (preset.status !== 'enabled' && preset.status !== 'disabled')
        return true
      })

      const onToggle = (id, enabled) => submit('set-enabled', { id: id, enabled: enabled }, null, null)
      const onEdit = (id) => { setEditing(id) }
      const onSave = (id, text) => { submit('save', { id: id, text: text }, 'saved', { id: id }).then((payload) => { if (payload && payload.ok) setEditing('') }) }
      const onRemove = (preset) => {
        if (!window.confirm(t('removeConfirm', { id: preset.id }))) return
        submit('remove', { id: preset.id, confirm: true }, 'removed', { id: preset.id }).then((payload) => {
          if (payload && payload.ok && payload.warning) setNotice(payload.warning)
        })
      }
      const onCreate = (id) => { submit('create', { id: id }, 'created', { id: id }).then((payload) => { if (payload && payload.ok) setForm('') }) }
      const onImport = (sourceDir) => { submit('import', { sourceDir: sourceDir }, null, null).then((payload) => { if (payload && payload.ok) { setForm(''); setDraft(payload) } }) }
      const onMigrate = () => { submit('migrate', {}, null, null).then((payload) => { if (payload && payload.ok) setPlans(payload) }) }

      return React.createElement('div', { style: S.root },
        React.createElement('div', { style: S.intro }, t('intro')),
        state
          ? React.createElement('div', { style: merge(S.banner, runtimeOk ? null : S.bannerWarn) },
              React.createElement('span', null, runtimeOk ? t('runtimeOk') : t('runtimeOff')),
              React.createElement('span', { style: S.spacer }),
              React.createElement('span', { style: S.muted }, (state.home || '') + ' · ' + ((state.enabled && state.enabled.length) || 0) + ' / ' + ((state.presets && state.presets.length) || 0)),
            )
          : null,
        React.createElement('div', { style: S.toolbar },
          React.createElement('button', { type: 'button', style: S.button, onClick: () => load() }, t('refresh')),
          React.createElement('button', { type: 'button', style: merge(S.button, form === 'create' || busy ? S.buttonDisabled : null), disabled: Boolean(busy), onClick: () => { setForm(form === 'create' ? '' : 'create') } }, t('create')),
          React.createElement('button', { type: 'button', style: merge(S.button, busy ? S.buttonDisabled : null), disabled: Boolean(busy), onClick: () => { setForm(form === 'import' ? '' : 'import') } }, t('import')),
          React.createElement('button', { type: 'button', style: merge(S.button, busy ? S.buttonDisabled : null), disabled: Boolean(busy), onClick: () => onMigrate() }, t('migrate')),
          React.createElement('span', { style: S.spacer }),
          busy ? React.createElement('span', { style: S.muted }, t('busy')) : null,
          FILTERS.map((key) => React.createElement('button', {
            key: key,
            type: 'button',
            style: merge(S.button, filter === key ? S.buttonPrimary : null),
            onClick: () => setFilter(key),
          }, t(key === 'all' ? 'filterAll' : key === 'enabled' ? 'filterEnabled' : key === 'disabled' ? 'filterDisabled' : 'filterBroken')))),
        error ? React.createElement('div', { style: merge(S.banner, S.bannerBad) },
          React.createElement('span', { style: S.error }, error),
          React.createElement('span', { style: S.spacer }),
          React.createElement('button', { type: 'button', style: S.button, onClick: () => setError('') }, t('close')),
        ) : null,
        notice ? React.createElement('div', { style: merge(S.banner, S.bannerGood) },
          React.createElement('span', null, notice),
          React.createElement('span', { style: S.spacer }),
          React.createElement('button', { type: 'button', style: S.button, onClick: () => setNotice('') }, t('close')),
        ) : null,
        form === 'create' ? React.createElement(CreatePanel, { busy: Boolean(busy), submit: onCreate, close: () => setForm('') }) : null,
        form === 'import' ? React.createElement(ImportForm, { busy: Boolean(busy), submit: onImport, close: () => setForm('') }) : null,
        draft ? React.createElement(ImportPanel, {
          draft: draft,
          busy: Boolean(busy),
          onConfirm: () => { submit('import', { sourceDir: draft.sourceDir, id: draft.id, confirm: true }, 'imported', { id: draft.id }).then((payload) => { if (payload && payload.ok) setDraft(null) }) },
          onCancel: () => setDraft(null),
        }) : null,
        plans ? React.createElement(MigratePanel, {
          plans: plans.plans,
          skipped: plans.skipped,
          busy: Boolean(busy),
          onConfirm: () => { submit('migrate', { confirm: true }, 'migrated', { n: (plans.plans || []).length }).then((payload) => { if (payload && payload.ok) setPlans(null) }) },
          onCancel: () => setPlans(null),
        }) : null,
        state && presets.length === 0
          ? React.createElement('div', { style: S.muted }, presets.length === 0 && filter !== 'all' ? t('emptyFiltered') : t('empty'))
          : null,
        presets.map((preset) => React.createElement(PresetCard, {
          key: preset.id,
          preset: preset,
          runtimeOk: runtimeOk,
          busy: busy === preset.id,
          editing: editing === preset.id,
          onToggle: onToggle,
          onEdit: onEdit,
          onCloseEdit: () => setEditing(''),
          onSave: onSave,
          onRemove: onRemove,
        })),
      )
    }

    /** 功能作用：把面板挂进核心「本地插件」设置页的 tab 槽。参数：ctx 为客户端插件上下文。返回值：无。 */
    function apply(ctx) {
      ctx.slots.inject(TAB_SLOT, () => ctx.slots.register({
        name: TAB_SLOT,
        id: TAB_ID,
        order: TAB_ORDER,
        label: () => t('nav'),
      }, AgentPresetsPanel))
    }

    return { apply: apply, inject: ['slots'] }
  },
});
//# sourceURL=/dsh-agent-preset-manager/src/client.js
