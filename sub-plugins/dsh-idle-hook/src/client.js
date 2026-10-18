// dsh-idle-hook: CLIENT half — Settings > 空闲通知 (settings.section, order 19).
//
// Two jobs, and only these two:
//   1. the configuration surface — master switch, the rule list, the rule form,
//      per-rule test-run, run status, failure badge and the execution history.
//      Config lives in the DSH settings namespace 'idle-hook' (written through
//      remote.settings, the same path esc-rewind uses); everything else is read
//      from the host half's /__idle-hook/* endpoints.
//   2. the presence heartbeat — DSH exposes no "is a page connected" API, so the
//      host half can only learn that the user is watching from us: we POST
//      visible/focused every 5s and on visibility/focus changes. The rule
//      precondition ('仅页面关着' / '仅页面不可见或失焦') keys off that.
//
// Bundle format: classic script, window.__ModuleLoader__.load({ id, factory }),
// no JSX — plain React.createElement + inline styles on --dsw-* tokens.
window.__ModuleLoader__.load({
  id: 'dsh-idle-hook',
  factory: (require) => {
    'use strict'
    const React = require('react')
    const { useCallback, useEffect, useRef, useState } = React

    // --- copy ---------------------------------------------------------------
    const zhDict = {
      nav: '空闲通知',
      title: '空闲通知',
      intro: '模型不在运行时（一轮结束、等待你批准、等待你回答）执行本机脚本，把通知送到你想去的地方。脚本可用 python / bat / ps1 / sh / 可执行文件。',
      master: '总开关',
      masterOn: '已开启',
      masterOff: '已暂停（不执行任何规则）',
      seed: '首次使用已预置一条**禁用**的示例规则，改好路径再启用即可。',
      presence: '页面状态',
      presenceLive: '页面在线',
      presenceFocused: '（已聚焦）',
      presenceBlurred: '（未聚焦）',
      presenceHidden: '（页面不可见）',
      presenceClosed: '页面关着 / 无心跳',
      rules: '规则',
      noRules: '还没有规则。',
      addRule: '新建规则',
      edit: '编辑',
      del: '删除',
      test: '试跑',
      save: '保存',
      cancel: '取消',
      enabled: '启用',
      disabled: '停用',
      name: '名称',
      nameHint: '只是给你自己看的备注',
      command: '命令',
      commandHint: '脚本或可执行文件的绝对路径，支持 ~ 与 {cwd} 等占位符',
      args: '参数',
      argsHint: '一行一个，直接传给脚本（默认不经过 shell）',
      env: '环境变量',
      envHint: '一行一个 KEY=VALUE；支持 {sessionId} {cwd} {title} {reason} 占位符；同名时覆盖上面的全局变量',
      envGlobal: '全局环境变量（所有规则共用）',
      envGlobalHint: '一行一个 KEY=VALUE，适合放 NOTIFY_ACCESS_KEY、MAIL_RECEIVER 这类变量；单条规则里可以覆盖',
      envSave: '保存环境变量',
      envSaved: '环境变量已保存',
      envDegraded: '（当前 DSH 版本没有 replace 接口，删除的变量可能仍旧保留）',
      envCount: ' 个变量',
      envKey: '变量名',
      envValue: '值',
      envAdd: '添加一行',
      envRemove: '删除这一行',
      envEmpty: '还没有环境变量，点下面「添加一行」。',
      errEnvNameEmpty: '变量名不能为空（填了值就一定要有名字）',
      errNsMissing: ' —— 宿主半还没注册设置段：到「设置 → 本地插件」把 dsh-idle-hook 关掉再打开（或重启 GUI host），然后刷新本页',
      errNoSettings: ' —— 没找到 settings 服务，请确认 DSH 版本与 profile',
      errEnvLine: '环境变量缺少等号：',
      errEnvName: '环境变量名不合法（字母/数字/下划线，不能以数字开头）：',
      warnEnvContract: '已忽略（IDLE_HOOK_* 由插件注入，规则不能覆盖）：',
      interpreter: '解释器',
      interpreterHint: '留空 = 按扩展名自动（.py→python3 / .bat→cmd / .ps1→powershell / .sh→bash）',
      cwd: '工作目录',
      cwdHint: '留空 = 触发它的会话的工作目录',
      triggers: '触发条件',
      triggerTurnEnd: '一轮结束（跑完/报错/超限；你按的停止不算）',
      triggerApproval: '等待我批准工具调用',
      triggerQuestion: '等待我回答提问',
      precondition: '触发前提',
      preconditionAny: '任意时候都触发',
      preconditionPageClosed: '仅页面关着时触发（推荐搭配总开关以外的通知插件）',
      preconditionPageHidden: '仅页面不可见或失焦时触发',
      debounce: '去抖（秒）',
      timeout: '超时（秒）',
      shell: '用 shell 执行整条命令（应急用）',
      shellHint: '打开后「命令 + 参数」会拼成一条 shell 命令字符串执行',
      lastRun: '上次运行',
      never: '从未运行',
      exitCode: '退出码',
      duration: '耗时',
      autoDisabled: '已因连续失败自动停用',
      reEnable: '重新启用并清零',
      history: '执行历史',
      historyEmpty: '暂无执行记录',
      clearHistory: '清空历史',
      output: '输出',
      status_ok: '成功',
      status_failed: '失败',
      status_timeout: '超时',
      status_skipped: '已跳过',
      status_error: '无法启动',
      testOk: '试跑完成',
      testSample: '（用示例上下文，因为当前没有会话）',
      testReal: '（用当前会话的上下文）',
      saved: '已保存',
      reloadHint: '刚启用或更新过本插件时，需要刷新一次页面界面才会出现/变化。',
      reload: '刷新页面',
      needReload: '界面更新需要刷新页面',
      settingsDown: '设置服务不可用：规则无法读取或保存。',
      errName: '请填写名称',
      errCommand: '请填写命令',
      errCommandMultiline: '命令里不要写换行或解释器：这一格只填脚本路径，解释器填到「解释器」字段（留空则按扩展名自动选）',
      errTrigger: '至少勾选一个触发条件',
      loading: '加载中…',
      error: '出错了',
    }
    const enDict = {
      nav: 'Idle Notifications',
      title: 'Idle Notifications',
      intro: 'When the model is not running (a turn ended, a tool approval is pending, a question awaits your answer), run a local script — python / bat / ps1 / sh / any executable — and push the notification wherever you want.',
      master: 'Master switch',
      masterOn: 'On',
      masterOff: 'Paused (no rule runs)',
      seed: 'A **disabled** sample rule was seeded — fix the path, then enable it.',
      presence: 'Page',
      presenceLive: 'page online',
      presenceFocused: ' (focused)',
      presenceBlurred: ' (blurred)',
      presenceHidden: ' (hidden)',
      presenceClosed: 'page closed / no heartbeat',
      rules: 'Rules',
      noRules: 'No rules yet.',
      addRule: 'New rule',
      edit: 'Edit',
      del: 'Delete',
      test: 'Test run',
      save: 'Save',
      cancel: 'Cancel',
      enabled: 'Enabled',
      disabled: 'disabled',
      name: 'Name',
      nameHint: 'a note for yourself',
      command: 'Command',
      commandHint: 'absolute path to the script or executable; ~ and {cwd} placeholders work',
      args: 'Arguments',
      argsHint: 'one per line, passed straight to the script (no shell by default)',
      env: 'Environment variables',
      envHint: 'one KEY=VALUE per line; {sessionId} {cwd} {title} {reason} placeholders work; overrides the global ones above',
      envGlobal: 'Global environment variables (shared by every rule)',
      envGlobalHint: 'one KEY=VALUE per line — put NOTIFY_ACCESS_KEY, MAIL_RECEIVER and friends here; a rule can override any of them',
      envSave: 'Save env vars',
      envSaved: 'Environment variables saved',
      envDegraded: ' (this DSH build has no replace verb, so removed keys may persist)',
      envCount: ' env vars',
      envKey: 'Name',
      envValue: 'Value',
      envAdd: 'Add row',
      envRemove: 'Remove this row',
      envEmpty: 'No environment variables yet — use “Add row” below.',
      errEnvNameEmpty: 'a variable name is required (a value without a name is ignored)',
      errNsMissing: ' — the host half has not registered its settings section yet: toggle dsh-idle-hook off/on in Settings > Local plugins (or restart the GUI host), then refresh this page',
      errNoSettings: ' — no settings service found; check the DSH version and profile',
      errEnvLine: 'an env line has no "=": ',
      errEnvName: 'invalid env name (letters/digits/underscore, cannot start with a digit): ',
      warnEnvContract: 'ignored (IDLE_HOOK_* is injected by the plugin and cannot be overridden): ',
      interpreter: 'Interpreter',
      interpreterHint: 'empty = auto by extension (.py→python3 / .bat→cmd / .ps1→powershell / .sh→bash)',
      cwd: 'Working directory',
      cwdHint: 'empty = the triggering session working directory',
      triggers: 'Triggers',
      triggerTurnEnd: 'A turn ended (completed/error/limit; not your own Stop)',
      triggerApproval: 'A tool approval is waiting for me',
      triggerQuestion: 'A question is waiting for my answer',
      precondition: 'Precondition',
      preconditionAny: 'Always',
      preconditionPageClosed: 'Only while the page is closed',
      preconditionPageHidden: 'Only while the page is hidden or blurred',
      debounce: 'Debounce (s)',
      timeout: 'Timeout (s)',
      shell: 'Run the whole line through a shell (escape hatch)',
      shellHint: 'joins command + arguments into one shell string',
      lastRun: 'Last run',
      never: 'never',
      exitCode: 'exit',
      duration: 'took',
      autoDisabled: 'Auto-disabled after repeated failures',
      reEnable: 'Re-enable and reset',
      history: 'Execution history',
      historyEmpty: 'No runs recorded yet',
      clearHistory: 'Clear history',
      output: 'Output',
      status_ok: 'ok',
      status_failed: 'failed',
      status_timeout: 'timeout',
      status_skipped: 'skipped',
      status_error: 'spawn error',
      testOk: 'Test run finished',
      testSample: ' (sample context: no session open)',
      testReal: ' (current session context)',
      saved: 'Saved',
      reloadHint: 'After enabling or updating this plugin, refresh the page once for the UI to appear or change.',
      reload: 'Refresh page',
      needReload: 'A page refresh is needed for UI changes',
      settingsDown: 'The settings service is unavailable: rules cannot be read or saved.',
      errName: 'Name is required',
      errCommand: 'Command is required',
      errCommandMultiline: 'no newlines or interpreter here: put only the script path in this field, and the interpreter in the Interpreter field (or leave it empty for auto-detection)',
      errTrigger: 'Pick at least one trigger',
      loading: 'Loading…',
      error: 'Error',
    }
    const lang = (() => {
      try {
        const list = (navigator && navigator.languages) || [navigator && navigator.language] || []
        return String(list[0] || 'zh').toLowerCase().indexOf('zh') === 0 ? 'zh' : 'en'
      } catch { return 'zh' }
    })()
    const dict = lang === 'zh' ? zhDict : enDict
    const t = (key) => (key in dict ? dict[key] : key)

    // --- constants -----------------------------------------------------------
    const SETTINGS_NS = 'idle-hook'
    const API = '/__idle-hook'
    const HEARTBEAT_MS = 5000
    const TRIGGERS = ['turnEnd', 'approval', 'question']
    const DEFAULT_DEBOUNCE_MS = 3000
    const DEFAULT_TIMEOUT_MS = 30000

    // --- styles --------------------------------------------------------------
    const S = {
      wrap: { display: 'flex', flexDirection: 'column', gap: '14px', fontSize: '13px', lineHeight: 1.5 },
      card: { border: '1px solid var(--dsw-border,rgba(127,127,127,.25))', borderRadius: '10px', padding: '12px 14px' },
      row: { display: 'flex', alignItems: 'center', gap: '8px', flexWrap: 'wrap' },
      between: { display: 'flex', alignItems: 'center', justifyContent: 'space-between', gap: '8px', flexWrap: 'wrap' },
      muted: { color: 'var(--dsw-text-secondary,#8b8b8b)', fontSize: '12px' },
      mono: { fontFamily: 'ui-monospace,SFMono-Regular,Menlo,monospace', fontSize: '12px', wordBreak: 'break-all' },
      input: { width: '100%', padding: '6px 8px', borderRadius: '6px', border: '1px solid var(--dsw-border,rgba(127,127,127,.3))', background: 'transparent', color: 'inherit', font: 'inherit', boxSizing: 'border-box' },
    // 原生 <select> 的下拉弹层用控件自身的 background/color 绘制：background 若为 transparent，
    // 弹层退回浏览器默认白底，而 color: inherit 在暗色主题下是浅色文字 ⇒ 未选中的选项看起来像被禁用/看不清。
    // 因此这里给不透明底色 + 显式前景色（对齐核心 ConfigField.module.css 的 <select> 写法）。
    select: { width: '100%', padding: '6px 8px', borderRadius: '6px', border: '1px solid var(--dsw-alias-border-l4,rgba(127,127,127,.3))', background: 'var(--dsw-alias-bg-layer-3,Canvas)', color: 'var(--dsw-alias-label-primary,CanvasText)', font: 'inherit', boxSizing: 'border-box' },
      btn: { padding: '4px 10px', borderRadius: '6px', border: '1px solid var(--dsw-border,rgba(127,127,127,.3))', background: 'transparent', color: 'inherit', cursor: 'pointer', font: 'inherit' },
      btnPrimary: { padding: '5px 12px', borderRadius: '6px', border: '1px solid var(--dsw-accent,#4c8bf5)', background: 'var(--dsw-accent,#4c8bf5)', color: '#fff', cursor: 'pointer', font: 'inherit' },
      chip: { padding: '1px 7px', borderRadius: '999px', border: '1px solid var(--dsw-border,rgba(127,127,127,.3))', fontSize: '11px' },
      ok: { color: 'var(--dsw-success,#2e9e5b)' },
      bad: { color: 'var(--dsw-danger,#d9534f)' },
      warn: { color: 'var(--dsw-warning,#c58b00)' },
      label: { display: 'block', marginBottom: '4px', fontSize: '12px' },
      field: { display: 'flex', flexDirection: 'column', gap: '2px', marginBottom: '10px' },
      grid: { display: 'grid', gridTemplateColumns: 'repeat(auto-fit,minmax(180px,1fr))', gap: '10px' },
      envTable: { border: '1px solid var(--dsw-border,rgba(127,127,127,.25))', borderRadius: '8px', padding: '8px', display: 'flex', flexDirection: 'column', gap: '6px' },
      envHead: { display: 'grid', gridTemplateColumns: '1fr 1.2fr auto', gap: '8px', fontSize: '11px', color: 'var(--dsw-text-secondary,#8b8b8b)' },
      envRow: { display: 'grid', gridTemplateColumns: '1fr 1.2fr auto', gap: '8px', alignItems: 'center' },
      pre: { margin: '6px 0 0', padding: '8px', borderRadius: '6px', background: 'var(--dsw-surface-muted,rgba(127,127,127,.1))', whiteSpace: 'pre-wrap', fontSize: '12px', maxHeight: '180px', overflow: 'auto' },
    }

    // --- remote.settings plumbing (guarded; every candidate its own try) -----
    function readRemoteSettings(scope) {
      if (!scope) return null
      try {
        if (typeof scope.get === 'function') {
          const viaGet = scope.get('remote.settings')
          if (viaGet) return viaGet
        }
      } catch { /* unmounted name */ }
      try {
        const viaKey = scope['remote.settings']
        if (viaKey) return viaKey
      } catch { /* guarded */ }
      let remote = null
      try { if (typeof scope.get === 'function') remote = scope.get('remote') || null } catch { /* not injected */ }
      if (!remote) { try { remote = scope.remote || null } catch { /* guarded */ } }
      if (remote) {
        try { const viaRemote = remote.settings || null; if (viaRemote) return viaRemote } catch { /* guarded */ }
      }
      try { if (scope.remote && scope.remote.settings) return scope.remote.settings } catch { /* guarded */ }
      try {
        if (typeof scope.get === 'function') {
          const shortGet = scope.get('settings')
          if (shortGet && typeof shortGet.describe === 'function') return shortGet
        }
      } catch { /* not injected */ }
      try {
        const viaProp = scope.settings || null
        if (viaProp && typeof viaProp.describe === 'function') return viaProp
      } catch { /* guarded */ }
      return null
    }

    function unwrapResult(response) {
      if (response && typeof response === 'object' && 'ok' in response) {
        if (response.ok === false) {
          const err = response.error
          throw new Error(String((err && (err.message || err.code)) || 'settings-request-failed'))
        }
        return Object.prototype.hasOwnProperty.call(response, 'value') ? response.value : response
      }
      return response
    }

    /** Turn a settings-service failure into something the user can act on. */
    function explainError(error) {
      const message = (error && error.message) ? String(error.message) : String(error)
      if (message.indexOf('is not registered') !== -1) return message + t('errNsMissing')
      if (message.indexOf('settings-unavailable') !== -1) return message + t('errNoSettings')
      return message
    }

    function isPlainObject(value) {
      return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
    }

    function clampInt(value, min, max, fallback) {
      const n = typeof value === 'number' ? value : Number(value)
      if (!Number.isFinite(n)) return fallback
      return Math.min(max, Math.max(min, Math.round(n)))
    }

    function newRuleId() {
      return 'rule-' + Date.now().toString(36) + '-' + Math.floor(Math.random() * 1679616).toString(36)
    }

    /** Client mirror of host-core.normalizeRule (keeps writes canonical). */
    function normalizeRule(input) {
      const src = isPlainObject(input) ? input : {}
      const triggers = isPlainObject(src.triggers) ? src.triggers : {}
      const allowed = ['any', 'page-closed', 'page-hidden-or-blurred']
      return {
        id: typeof src.id === 'string' && src.id ? src.id : newRuleId(),
        name: typeof src.name === 'string' && src.name.trim() ? src.name.trim().slice(0, 80) : '未命名规则',
        enabled: src.enabled === true,
        command: typeof src.command === 'string' ? src.command.trim() : '',
        args: Array.isArray(src.args) ? src.args.map((a) => String(a == null ? '' : a)) : [],
        interpreter: typeof src.interpreter === 'string' ? src.interpreter.trim() : '',
        cwd: typeof src.cwd === 'string' ? src.cwd.trim() : '',
        triggers: {
          turnEnd: triggers.turnEnd !== false,
          approval: triggers.approval !== false,
          question: triggers.question !== false,
        },
        precondition: allowed.indexOf(src.precondition) !== -1 ? src.precondition : 'any',
        debounceMs: clampInt(src.debounceMs, 0, 600000, DEFAULT_DEBOUNCE_MS),
        timeoutMs: clampInt(src.timeoutMs, 1000, 3600000, DEFAULT_TIMEOUT_MS),
        shell: src.shell === true,
        env: normalizeEnvMap(src.env),
      }
    }

    const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

    /** Mirror of host-core.normalizeEnv: accepts {K:V} or "K=V" lines → object. */
    function normalizeEnvMap(input) {
      const out = {}
      if (Array.isArray(input)) {
        for (const line of input) {
          const text = String(line == null ? '' : line)
          if (!text.trim() || text.trim().startsWith('#')) continue
          const at = text.indexOf('=')
          const name = (at === -1 ? text : text.slice(0, at)).trim()
          if (!ENV_KEY_RE.test(name)) continue
          out[name] = at === -1 ? '' : text.slice(at + 1)
        }
        return out
      }
      if (isPlainObject(input)) {
        for (const key of Object.keys(input)) {
          if (!ENV_KEY_RE.test(String(key).trim())) continue
          out[String(key).trim()] = input[key] == null ? '' : String(input[key])
        }
      }
      return out
    }

    function formatEnvLines(env) {
      const obj = normalizeEnvMap(env)
      return Object.keys(obj).map((key) => key + '=' + obj[key]).join('\n')
    }

    /** 已保存的 env 对象 → 表格行 */
    function envToRows(env) {
      const obj = normalizeEnvMap(env)
      return Object.keys(obj).map((key) => ({ key, value: obj[key] }))
    }

    function cloneEnvRows(rows) {
      return (Array.isArray(rows) ? rows : []).map((row) => ({
        key: String((row && row.key) || ''),
        value: String((row && row.value) == null ? '' : row.value),
      }))
    }

    function withEnvRowSet(rows, index, patch) {
      return cloneEnvRows(rows).map((row, i) => (i === index ? Object.assign({}, row, patch) : row))
    }

    function withEnvRowRemoved(rows, index) {
      return cloneEnvRows(rows).filter((_, i) => i !== index)
    }

    function withEnvRowAdded(rows) {
      return cloneEnvRows(rows).concat([{ key: '', value: '' }])
    }

    /** 表格行 → env 对象：错误阻止保存，警告只提示（与旧文本解析同语义） */
    function envFromRows(rows) {
      const env = {}
      const errors = []
      const warnings = []
      const seen = {}
      for (const row of (Array.isArray(rows) ? rows : [])) {
        const name = String((row && row.key) || '').trim()
        const value = String((row && row.value) == null ? '' : row.value)
        if (!name && !value) continue
        if (!name) { errors.push(t('errEnvNameEmpty')); continue }
        if (!ENV_KEY_RE.test(name)) { errors.push(t('errEnvName') + name); continue }
        if (seen[name]) warnings.push(name + ' ×' + (seen[name] + 1) + '（后者覆盖前者）')
        seen[name] = (seen[name] || 0) + 1
        if (name.indexOf('IDLE_HOOK_') === 0) warnings.push(t('warnEnvContract') + name)
        env[name] = value
      }
      return { env, errors, warnings }
    }

    /**
     * 环境变量表格：一行一个「变量名 / 值」，每行可删除，底部可加行。
     * 全局与规则共用同一套渲染，靠 scope 区分（测试也用这个属性定位）。
     */
    function renderEnvTable(scope, rows, onSet, onRemove, onAdd) {
      const list = Array.isArray(rows) ? rows : []
      const cell = (kind, index, props) => React.createElement('input', Object.assign({
        style: S.input,
        'data-env': kind,
        'data-env-scope': scope,
        'data-row': index,
      }, props))
      return React.createElement('div', { style: S.envTable },
        list.length > 0
          ? React.createElement('div', { style: S.envHead },
            React.createElement('span', null, t('envKey')),
            React.createElement('span', null, t('envValue')),
            React.createElement('span', null, ''))
          : React.createElement('div', { style: S.muted }, t('envEmpty')),
        list.map((row, index) => React.createElement('div', { key: scope + '-row-' + index, style: S.envRow },
          cell('key', index, {
            value: String((row && row.key) || ''),
            placeholder: 'NOTIFY_ACCESS_KEY',
            onChange: (e) => onSet(index, { key: e.target.value }),
          }),
          cell('value', index, {
            value: String((row && row.value) == null ? '' : row.value),
            placeholder: 'your_access_key',
            onChange: (e) => onSet(index, { value: e.target.value }),
          }),
          React.createElement('button', {
            style: S.btn,
            title: t('envRemove'),
            'data-env': 'remove',
            'data-env-scope': scope,
            'data-row': index,
            onClick: () => onRemove(index),
          }, '✕'))),
        React.createElement('button', {
          style: Object.assign({}, S.btn, { alignSelf: 'flex-start' }),
          'data-env': 'add',
          'data-env-scope': scope,
          onClick: onAdd,
        }, '+ ' + t('envAdd')))
    }

    /** Parse the textarea: errors block saving, warnings are shown but saved. */
    function parseEnvLines(text) {
      const env = {}
      const errors = []
      const warnings = []
      const seen = {}
      for (const line of String(text == null ? '' : text).split(/\r?\n/)) {
        if (!line.trim() || line.trim().startsWith('#')) continue
        const at = line.indexOf('=')
        const name = (at === -1 ? line : line.slice(0, at)).trim()
        if (at === -1) { errors.push(t('errEnvLine') + line.trim()); continue }
        if (!ENV_KEY_RE.test(name)) { errors.push(t('errEnvName') + name); continue }
        if (seen[name]) warnings.push(name + ' ×' + (seen[name] + 1) + '（后者覆盖前者）')
        seen[name] = (seen[name] || 0) + 1
        if (name.indexOf('IDLE_HOOK_') === 0) warnings.push(t('warnEnvContract') + name)
        env[name] = line.slice(at + 1)
      }
      return { env, errors, warnings }
    }

    function blankRule() {
      return normalizeRule({ name: t('addRule'), enabled: false, command: '', args: [] })
    }

    function validateLocally(rule) {
      const errors = []
      if (!rule.name || !rule.name.trim()) errors.push(t('errName'))
      if (!rule.command || !rule.command.trim()) errors.push(t('errCommand'))
      if (/\r?\n/.test(String(rule.command || ''))) {
        const head = String(rule.command).split(/\r?\n/)[0].trim()
        errors.push(t('errCommandMultiline') + (head ? '（「' + head + '」→ 解释器）' : ''))
      }
      const trig = rule.triggers || {}
      if (trig.turnEnd === false && trig.approval === false && trig.question === false) errors.push(t('errTrigger'))
      return errors
    }

    async function readConfig(settings) {
      if (!settings || typeof settings.describe !== 'function') throw new Error('settings-unavailable')
      const view = unwrapResult(await settings.describe())
      const namespaces = view && Array.isArray(view.namespaces) ? view.namespaces : []
      const row = namespaces.find((entry) => entry && entry.ns === SETTINGS_NS)
      const value = row && isPlainObject(row.value) ? row.value : {}
      return {
        enabled: value.enabled === undefined ? true : value.enabled !== false,
        seeded: value.seeded === true,
        env: normalizeEnvMap(value.env),
        rules: Array.isArray(value.rules) ? value.rules.filter(isPlainObject).map(normalizeRule) : [],
      }
    }

    async function writeConfig(settings, patch) {
      if (!settings || typeof settings.update !== 'function') throw new Error('settings-unavailable')
      return unwrapResult(await settings.update(SETTINGS_NS, patch, undefined))
    }

    /**
     * 整段替换这个命名空间的「用户层」。
     *
     * 为什么不能只 update：设置服务的 update 是**深合并**（mergeLayers 对普通对象逐键合并），
     * 所以写 { env: {} } 一个键都删不掉 —— 用户清空变量后保存，旧值会原样留着、界面又读回来，
     * 看起来就像「还原了」。删键必须用 replace（replace({}) 才是重置）。
     */
    async function writeSection(settings, section) {
      if (!settings) throw new Error('settings-unavailable')
      if (typeof settings.replace === 'function') {
        return unwrapResult(await settings.replace(SETTINGS_NS, section, undefined))
      }
      // 老版本核心没有 replace：退回 update，并如实告诉用户「删键可能不生效」
      if (typeof settings.update !== 'function') throw new Error('settings-unavailable')
      const result = unwrapResult(await settings.update(SETTINGS_NS, section, undefined))
      return { result, degraded: true }
    }

    // --- presence heartbeat (module-scope singleton) -------------------------
    let heartbeat = null

    function presenceSnapshot() {
      let visible = false
      let focused = false
      try { visible = typeof document !== 'undefined' && document.visibilityState !== 'hidden' } catch { visible = false }
      try { focused = typeof document !== 'undefined' && typeof document.hasFocus === 'function' ? document.hasFocus() === true : false } catch { focused = false }
      return { visible, focused }
    }

    function startHeartbeat() {
      if (heartbeat) return heartbeat.stop
      const post = () => {
        try {
          const snap = presenceSnapshot()
          fetch(API + '/presence', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify(snap),
          }).catch(() => { /* host asleep or restarting */ })
        } catch { /* fetch unavailable in a test shim */ }
      }
      const onVisibility = () => post()
      const onFocus = () => post()
      const onBlur = () => post()
      let timer = null
      try {
        timer = setInterval(post, HEARTBEAT_MS)
        if (typeof document !== 'undefined' && document.addEventListener) {
          document.addEventListener('visibilitychange', onVisibility)
        }
        try { window.addEventListener('focus', onFocus); window.addEventListener('blur', onBlur) } catch { /* no window */ }
      } catch { /* no timers in this environment */ }
      post()
      heartbeat = {
        stop: () => {
          heartbeat = null
          if (timer) clearInterval(timer)
          try { if (typeof document !== 'undefined' && document.removeEventListener) document.removeEventListener('visibilitychange', onVisibility) } catch { /* noop */ }
          try { window.removeEventListener('focus', onFocus); window.removeEventListener('blur', onBlur) } catch { /* noop */ }
        },
      }
      return heartbeat.stop
    }

    // --- small helpers -------------------------------------------------------
    function fmtTime(ms) {
      if (!ms) return ''
      try { return new Date(ms).toLocaleString() } catch { return String(ms) }
    }

    function statusLabel(status) {
      const key = 'status_' + String(status || 'ok')
      return t(key)
    }

    function statusColor(status) {
      if (status === 'ok') return S.ok
      if (status === 'skipped') return S.muted
      return S.bad
    }

    function triggerChips(rule) {
      const out = []
      if (rule.triggers.turnEnd !== false) out.push(t('triggerTurnEnd'))
      if (rule.triggers.approval !== false) out.push(t('triggerApproval'))
      if (rule.triggers.question !== false) out.push(t('triggerQuestion'))
      return out
    }

    // --- panel ---------------------------------------------------------------
    function IdleHookSection() {
      const [status, setStatus] = useState(null)
      const [history, setHistory] = useState(null)
      const [showHistory, setShowHistory] = useState(false)
      const [openEntry, setOpenEntry] = useState(null)
      const [draft, setDraft] = useState(null)
      const [errors, setErrors] = useState([])
      /** 全局环境变量表格：null = 跟随已保存的值，否则是用户正在编辑的行 */
      const [globalEnvRows, setGlobalEnvRows] = useState(null)
      // 在提前 return 之前算好，避免回调闭包引用未初始化的绑定
      const savedEnvRows = envToRows((status && status.config && status.config.env) || {})
      const envRows = globalEnvRows === null ? savedEnvRows : globalEnvRows
      // 表格的行操作（全局一份 + 规则表单一份）
      const globalRowsNow = () => cloneEnvRows(globalEnvRows === null ? savedEnvRows : globalEnvRows)
      const setGlobalEnvRow = (index, patch) => setGlobalEnvRows(withEnvRowSet(globalRowsNow(), index, patch))
      const removeGlobalEnvRow = (index) => setGlobalEnvRows(withEnvRowRemoved(globalRowsNow(), index))
      const addGlobalEnvRow = () => setGlobalEnvRows(withEnvRowAdded(globalRowsNow()))
      const ruleEnvRows = () => cloneEnvRows(draft && draft.envRows)
      const setRuleEnvRow = (index, patch) => setDraft(Object.assign({}, draft, { envRows: withEnvRowSet(ruleEnvRows(), index, patch) }))
      const removeRuleEnvRow = (index) => setDraft(Object.assign({}, draft, { envRows: withEnvRowRemoved(ruleEnvRows(), index) }))
      const addRuleEnvRow = () => setDraft(Object.assign({}, draft, { envRows: withEnvRowAdded(ruleEnvRows()) }))
      const [busy, setBusy] = useState(null)
      const [notice, setNotice] = useState(null)
      const [fatal, setFatal] = useState(null)
      const settingsRef = useRef(undefined)
      const seededRef = useRef(false)
      const seq = useRef(0)

      const settings = useCallback(() => {
        if (settingsRef.current === undefined) settingsRef.current = readRemoteSettings(scopeOf())
        return settingsRef.current
      }, [])

      function scopeOf() {
        try { return componentCtx } catch { return null }
      }

      const loadStatus = useCallback(async () => {
        const id = ++seq.current
        try {
          const res = await fetch(API + '/status')
          const json = await res.json()
          if (id !== seq.current) return null
          if (!res.ok || !json.ok) throw new Error(json.error || ('HTTP ' + res.status))
          setStatus(json.data)
          setFatal(null)
          return json.data
        } catch (e) {
          if (id !== seq.current) return null
          setFatal((e && e.message) || String(e))
          return null
        }
      }, [])

      const loadHistory = useCallback(async () => {
        try {
          const res = await fetch(API + '/history')
          const json = await res.json()
          if (res.ok && json.ok) setHistory(json.data)
        } catch { /* keep the previous view */ }
      }, [])

      // first load: status + (once) the disabled sample-rule seed
      useEffect(() => {
        let alive = true
        loadStatus().then(async (data) => {
          if (!alive || !data) return
          const store = settings()
          if (!store || data.config.seeded === true || seededRef.current) return
          // seed once: a DISABLED sample rule, nothing ever executes from it
          seededRef.current = true
          try {
            const cfg = await readConfig(store)
            if (cfg.seeded) return
            const sample = data.sampleRule
            const nextRules = cfg.rules.length > 0 ? cfg.rules : [normalizeRule(sample)]
            await writeConfig(store, { seeded: true, rules: nextRules })
            if (!alive) return
            setNotice({ type: 'ok', text: t('seed') })
            await loadStatus()
          } catch (e) {
            if (alive) setNotice({ type: 'err', text: explainError(e) })
          }
        })
        return () => { alive = false }
      }, [loadStatus, settings])

      useEffect(() => { if (showHistory) loadHistory() }, [showHistory, loadHistory])

      const saveRules = useCallback(async (nextRules, extra) => {
        const store = settings()
        const cfg = await readConfig(store)
        await writeConfig(store, Object.assign({ rules: nextRules.map(normalizeRule) }, extra || {}))
        await loadStatus()
        if (showHistory) await loadHistory()
        return cfg
      }, [settings, loadStatus, loadHistory, showHistory])

      const toggleMaster = useCallback(async () => {
        setBusy('master')
        setNotice(null)
        try {
          const store = settings()
          const cfg = await readConfig(store)
          await writeConfig(store, { enabled: !cfg.enabled })
          await loadStatus()
        } catch (e) {
          setNotice({ type: 'err', text: explainError(e) })
        } finally { setBusy(null) }
      }, [settings, loadStatus])

      const toggleRule = useCallback(async (rule) => {
        setBusy(rule.id)
        setNotice(null)
        try {
          const cfg = await readConfig(settings())
          const next = cfg.rules.map((r) => (r.id === rule.id ? normalizeRule(Object.assign({}, r, { enabled: !r.enabled })) : r))
          await saveRules(next)
          if (!rule.enabled) {
            // re-enabling clears the auto-disable counter host-side
            try {
              await fetch(API + '/reset-rule', {
                method: 'POST',
                headers: { 'content-type': 'application/json' },
                body: JSON.stringify({ ruleId: rule.id }),
              })
            } catch { /* host may be restarting */ }
            await loadStatus()
          }
        } catch (e) {
          setNotice({ type: 'err', text: explainError(e) })
        } finally { setBusy(null) }
      }, [settings, saveRules, loadStatus])

      const resetRule = useCallback(async (rule) => {
        setBusy(rule.id)
        try {
          await fetch(API + '/reset-rule', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ ruleId: rule.id }),
          })
          await loadStatus()
          setNotice({ type: 'ok', text: t('reEnable') })
        } catch (e) {
          setNotice({ type: 'err', text: explainError(e) })
        } finally { setBusy(null) }
      }, [loadStatus])

      const removeRule = useCallback(async (rule) => {
        setBusy(rule.id)
        try {
          const cfg = await readConfig(settings())
          await saveRules(cfg.rules.filter((r) => r.id !== rule.id))
        } catch (e) {
          setNotice({ type: 'err', text: explainError(e) })
        } finally { setBusy(null) }
      }, [settings, saveRules])

      const saveGlobalEnv = useCallback(async () => {
        const currentSavedRows = envToRows((status && status.config && status.config.env) || {})
        const parsed = envFromRows(globalEnvRows === null ? currentSavedRows : globalEnvRows)
        if (parsed.errors.length > 0) {
          setErrors(parsed.errors)
          setNotice({ type: 'err', text: parsed.errors.join('；') })
          return
        }
        setBusy('env')
        setErrors([])
        setNotice(null)
        try {
          const store = settings()
          const cfg = await readConfig(store)
          const replaced = await writeSection(store, {
            enabled: cfg.enabled,
            seeded: cfg.seeded,
            env: parsed.env,
            rules: cfg.rules.map(normalizeRule),
          })
          setGlobalEnvRows(null)
          await loadStatus()
          const degraded = replaced && replaced.degraded
          setNotice({
            type: degraded || parsed.warnings.length > 0 ? 'warn' : 'ok',
            text: t('envSaved') + (parsed.warnings.length > 0 ? '（' + parsed.warnings.join('；') + '）' : '')
              + (degraded ? t('envDegraded') : ''),
          })
        } catch (e) {
          setNotice({ type: 'err', text: explainError(e) })
        } finally { setBusy(null) }
      }, [globalEnvRows, status, settings, loadStatus])

      const startEdit = useCallback((rule) => {
        setErrors([])
        setDraft(Object.assign({}, normalizeRule(rule), {
          argsText: (rule.args || []).join('\n'),
          envRows: envToRows(rule.env),
        }))
      }, [])

      const startNew = useCallback(() => {
        setErrors([])
        setDraft(Object.assign({}, blankRule(), { argsText: '', envRows: [] }))
      }, [])

      const saveDraft = useCallback(async () => {
        const args = String(draft.argsText || '').split(/\r?\n/).map((s) => s.trim()).filter((s) => s.length > 0)
        const parsedEnv = envFromRows(draft.envRows)
        const rule = normalizeRule(Object.assign({}, draft, { args, env: parsedEnv.env }))
        const problems = validateLocally(rule).concat(parsedEnv.errors)
        if (problems.length > 0) { setErrors(problems); return }
        setBusy('save')
        setNotice(null)
        try {
          const cfg = await readConfig(settings())
          const exists = cfg.rules.some((r) => r.id === rule.id)
          const next = exists ? cfg.rules.map((r) => (r.id === rule.id ? rule : r)) : cfg.rules.concat([rule])
          await saveRules(next)
          setDraft(null)
          setNotice({
            type: parsedEnv.warnings.length > 0 ? 'warn' : 'ok',
            text: t('saved') + (parsedEnv.warnings.length > 0 ? '（' + parsedEnv.warnings.join('；') + '）' : ''),
          })
        } catch (e) {
          setNotice({ type: 'err', text: explainError(e) })
        } finally { setBusy(null) }
      }, [draft, settings, saveRules])

      const testRun = useCallback(async (rule) => {
        setBusy('test:' + rule.id)
        setNotice(null)
        try {
          // A saved rule carries args; an unsaved draft carries the textarea text.
          const args = typeof rule.argsText === 'string'
            ? String(rule.argsText).split(/\r?\n/).map((s) => s.trim()).filter((s) => s.length > 0)
            : (Array.isArray(rule.args) ? rule.args : [])
          const parsedEnv = Array.isArray(rule.envRows)
            ? envFromRows(rule.envRows)
            : { env: normalizeEnvMap(rule.env), errors: [], warnings: [] }
          if (parsedEnv.errors.length > 0) { setErrors(parsedEnv.errors); setBusy(null); return }
          const payload = normalizeRule(Object.assign({}, rule, { args, env: parsedEnv.env }))
          const globalEnv = envFromRows(globalEnvRows === null ? savedEnvRows : globalEnvRows).env
          const res = await fetch(API + '/test-run', {
            method: 'POST',
            headers: { 'content-type': 'application/json' },
            body: JSON.stringify({ rule: payload, env: globalEnv }),
          })
          const json = await res.json().catch(() => ({}))
          if (!res.ok || !json.ok) throw new Error(json.error || ('HTTP ' + res.status))
          const entry = json.data.entry
          const where = json.data.context.sample ? t('testSample') : t('testReal')
          // 失败时把脚本自己的报错（stderr 末尾两行）带出来，否则用户只看到「退出码 2」
          const stderrTail = String(entry.stderr || '').split(/\r?\n/).map((s) => s.trim()).filter((s) => s).slice(-2).join(' ')
          const detail = [entry.error, stderrTail].filter((s) => s && String(s).trim()).join(' ')
          setNotice({
            type: entry.status === 'ok' ? (entry.note ? 'warn' : 'ok') : 'err',
            text: t('testOk') + where + '：' + statusLabel(entry.status) +
              (entry.exitCode === null || entry.exitCode === undefined ? '' : ' (' + t('exitCode') + ' ' + entry.exitCode + ')') +
              (detail ? ' — ' + detail : '') +
              (entry.note ? ' ｜ ' + entry.note : ''),
          })
          await loadStatus()
          if (showHistory) await loadHistory()
        } catch (e) {
          setNotice({ type: 'err', text: explainError(e) })
        } finally { setBusy(null) }
      }, [loadStatus, loadHistory, showHistory, globalEnvRows, savedEnvRows])

      const clearHistory = useCallback(async () => {
        setBusy('clear')
        try {
          await fetch(API + '/clear-history', { method: 'POST' })
          await loadHistory()
          await loadStatus()
        } catch (e) {
          setNotice({ type: 'err', text: explainError(e) })
        } finally { setBusy(null) }
      }, [loadHistory, loadStatus])

      if (fatal) {
        return React.createElement('div', { style: S.wrap },
          React.createElement('div', { style: S.card },
            React.createElement('div', { style: S.row },
              React.createElement('strong', null, t('title')),
              React.createElement('span', { style: S.bad }, t('error') + ': ' + fatal))))
      }
      if (!status) {
        return React.createElement('div', { style: S.wrap }, React.createElement('div', { style: S.muted }, t('loading')))
      }

      const cfg = status.config
      const presence = status.presence || { state: 'closed' }
      const runtime = status.runtime || {}
      const settingsReady = status.settings && status.settings.ready

      const presenceText = presence.state === 'closed'
        ? t('presenceClosed')
        : t('presenceLive') + (presence.state === 'hidden' ? t('presenceHidden') : (presence.state === 'visible-focused' ? t('presenceFocused') : t('presenceBlurred')))

      return React.createElement('div', { style: S.wrap },
        React.createElement('div', { style: S.card },
          React.createElement('div', { style: S.between },
            React.createElement('strong', null, t('title')),
            React.createElement('div', { style: S.row },
              React.createElement('span', { style: S.chip }, t('presence') + '：' + presenceText),
              React.createElement('button', {
                style: cfg.enabled ? S.btnPrimary : S.btn,
                disabled: busy === 'master',
                onClick: toggleMaster,
              }, t('master') + '：' + (cfg.enabled ? t('masterOn') : t('masterOff'))))),
          React.createElement('div', { style: S.muted }, t('intro')),
          !settingsReady
            ? React.createElement('div', { style: Object.assign({}, S.muted, S.warn) },
              t('settingsDown') + (status.settings && status.settings.error ? '（' + status.settings.error + '）' : ''))
            : null,
          React.createElement('div', { style: S.field },
            React.createElement('label', { style: S.label }, t('envGlobal')),
            renderEnvTable('global', envRows, setGlobalEnvRow, removeGlobalEnvRow, addGlobalEnvRow),
            React.createElement('div', { style: Object.assign({}, S.row, { marginTop: '6px' }) },
              React.createElement('button', { style: S.btn, disabled: busy === 'env', onClick: saveGlobalEnv }, t('envSave')),
              React.createElement('span', { style: S.muted }, t('envGlobalHint')))),
          React.createElement('div', { style: S.muted }, t('reloadHint') + ' ',
            React.createElement('button', { style: S.btn, onClick: () => { try { window.location.reload() } catch { /* noop */ } } }, t('reload'))),
          notice
            ? React.createElement('div', {
              style: notice.type === 'ok' ? S.ok : (notice.type === 'warn' ? S.warn : S.bad),
            }, notice.text)
            : null),

        React.createElement('div', { style: S.card },
          React.createElement('div', { style: S.between },
            React.createElement('strong', null, t('rules') + '（' + cfg.count + '）'),
            React.createElement('button', { style: S.btn, onClick: startNew }, '+ ' + t('addRule'))),
          cfg.count === 0 ? React.createElement('div', { style: S.muted }, t('noRules')) : null,
          cfg.rules.map((rule) => {
            const rt = runtime[rule.id] || {}
            const autoDisabled = rt.autoDisabled === true
            return React.createElement('div', {
              key: rule.id,
              style: Object.assign({}, S.card, { marginTop: '10px' }),
            },
              React.createElement('div', { style: S.between },
                React.createElement('div', { style: S.row },
                  React.createElement('strong', null, rule.name),
                  React.createElement('span', { style: Object.assign({}, S.chip, rule.enabled && !autoDisabled ? S.ok : S.muted) },
                    rule.enabled ? (autoDisabled ? t('autoDisabled') : t('enabled')) : t('disabled')),
                  autoDisabled ? React.createElement('span', { style: S.bad }, t('autoDisabled')) : null),
                React.createElement('div', { style: S.row },
                  React.createElement('button', { style: S.btn, disabled: busy === rule.id, onClick: () => toggleRule(rule) },
                    rule.enabled ? '停用' : '启用'),
                  React.createElement('button', { style: S.btn, disabled: busy === 'test:' + rule.id, onClick: () => testRun(rule) }, t('test')),
                  autoDisabled ? React.createElement('button', { style: S.btn, onClick: () => resetRule(rule) }, t('reEnable')) : null,
                  React.createElement('button', { style: S.btn, onClick: () => startEdit(rule) }, t('edit')),
                  React.createElement('button', { style: S.btn, onClick: () => removeRule(rule) }, t('del')))),
              React.createElement('div', { style: Object.assign({}, S.mono, S.muted) }, rule.command),
              React.createElement('div', { style: S.muted }, triggerChips(rule).join(' · ') + ' · ' + rule.precondition
                + (rule.env && Object.keys(rule.env).length > 0 ? ' · ' + Object.keys(rule.env).length + t('envCount') : '')),
              React.createElement('div', { style: S.muted },
                t('lastRun') + '：' + (rt.lastRunAt ? fmtTime(rt.lastRunAt) : t('never')) +
                (rt.lastStatus ? ' · ' + statusLabel(rt.lastStatus) : '') +
                (rt.lastExitCode === null || rt.lastExitCode === undefined ? '' : ' · ' + t('exitCode') + ' ' + rt.lastExitCode) +
                (rt.lastDurationMs === null || rt.lastDurationMs === undefined ? '' : ' · ' + t('duration') + ' ' + rt.lastDurationMs + 'ms') +
                (rt.consecutiveFailures ? ' · 连续失败 ' + rt.consecutiveFailures : '')))
          }),
          draft ? React.createElement('div', { style: Object.assign({}, S.card, { marginTop: '10px' }) },
            React.createElement('strong', null, draft.id ? t('edit') : t('addRule')),
            React.createElement('div', { style: Object.assign({}, S.field, { marginTop: '10px' }) },
              React.createElement('label', { style: S.label }, t('name')),
              React.createElement('input', {
                style: S.input,
                value: draft.name,
                onChange: (e) => setDraft(Object.assign({}, draft, { name: e.target.value })),
              }),
              React.createElement('span', { style: S.muted }, t('nameHint'))),
            React.createElement('div', { style: S.field },
              React.createElement('label', { style: S.label }, t('command')),
              React.createElement('input', {
                style: S.input,
                value: draft.command,
                placeholder: '/Users/you/bin/notify.sh',
                onChange: (e) => setDraft(Object.assign({}, draft, { command: e.target.value })),
              }),
              React.createElement('span', { style: S.muted }, t('commandHint'))),
            React.createElement('div', { style: S.field },
              React.createElement('label', { style: S.label }, t('args')),
              React.createElement('textarea', {
                style: Object.assign({}, S.input, { minHeight: '56px', fontFamily: 'ui-monospace,Menlo,monospace' }),
                value: draft.argsText,
                onChange: (e) => setDraft(Object.assign({}, draft, { argsText: e.target.value })),
              }),
              React.createElement('span', { style: S.muted }, t('argsHint'))),
            React.createElement('div', { style: S.field },
              React.createElement('label', { style: S.label }, t('env')),
              renderEnvTable('rule', ruleEnvRows(), setRuleEnvRow, removeRuleEnvRow, addRuleEnvRow),
              React.createElement('span', { style: S.muted }, t('envHint'))),
            React.createElement('div', { style: S.grid },
              React.createElement('div', { style: S.field },
                React.createElement('label', { style: S.label }, t('interpreter')),
                React.createElement('input', {
                  style: S.input,
                  value: draft.interpreter,
                  onChange: (e) => setDraft(Object.assign({}, draft, { interpreter: e.target.value })),
                }),
                React.createElement('span', { style: S.muted }, t('interpreterHint'))),
              React.createElement('div', { style: S.field },
                React.createElement('label', { style: S.label }, t('cwd')),
                React.createElement('input', {
                  style: S.input,
                  value: draft.cwd,
                  onChange: (e) => setDraft(Object.assign({}, draft, { cwd: e.target.value })),
                }),
                React.createElement('span', { style: S.muted }, t('cwdHint')))),
            React.createElement('div', { style: S.field },
              React.createElement('label', { style: S.label }, t('triggers')),
              TRIGGERS.map((key) => React.createElement('label', { key, style: Object.assign({}, S.row, S.muted) },
                React.createElement('input', {
                  type: 'checkbox',
                  checked: draft.triggers[key] !== false,
                  onChange: (e) => setDraft(Object.assign({}, draft, {
                    triggers: Object.assign({}, draft.triggers, { [key]: e.target.checked }),
                  })),
                }),
                React.createElement('span', null, t('trigger' + key.charAt(0).toUpperCase() + key.slice(1)))))),
            React.createElement('div', { style: S.field },
              React.createElement('label', { style: S.label }, t('precondition')),
              React.createElement('select', {
                style: S.select,
                value: draft.precondition,
                onChange: (e) => setDraft(Object.assign({}, draft, { precondition: e.target.value })),
              },
                React.createElement('option', { value: 'any' }, t('preconditionAny')),
                React.createElement('option', { value: 'page-closed' }, t('preconditionPageClosed')),
                React.createElement('option', { value: 'page-hidden-or-blurred' }, t('preconditionPageHidden')))),
            React.createElement('div', { style: S.grid },
              React.createElement('div', { style: S.field },
                React.createElement('label', { style: S.label }, t('debounce')),
                React.createElement('input', {
                  style: S.input,
                  type: 'number',
                  value: Math.round(draft.debounceMs / 1000),
                  onChange: (e) => setDraft(Object.assign({}, draft, { debounceMs: Number(e.target.value) * 1000 })),
                })),
              React.createElement('div', { style: S.field },
                React.createElement('label', { style: S.label }, t('timeout')),
                React.createElement('input', {
                  style: S.input,
                  type: 'number',
                  value: Math.round(draft.timeoutMs / 1000),
                  onChange: (e) => setDraft(Object.assign({}, draft, { timeoutMs: Number(e.target.value) * 1000 })),
                }))),
            React.createElement('div', { style: S.field },
              React.createElement('label', { style: Object.assign({}, S.row, S.muted) },
                React.createElement('input', {
                  type: 'checkbox',
                  checked: draft.shell === true,
                  onChange: (e) => setDraft(Object.assign({}, draft, { shell: e.target.checked })),
                }),
                React.createElement('span', null, t('shell'))),
              React.createElement('span', { style: S.muted }, t('shellHint'))),
            React.createElement('label', { style: Object.assign({}, S.row, S.muted) },
              React.createElement('input', {
                type: 'checkbox',
                checked: draft.enabled === true,
                onChange: (e) => setDraft(Object.assign({}, draft, { enabled: e.target.checked })),
              }),
              React.createElement('span', null, t('enabled'))),
            errors.length > 0 ? React.createElement('div', { style: S.bad }, errors.join('；')) : null,
            React.createElement('div', { style: Object.assign({}, S.row, { marginTop: '10px' }) },
              React.createElement('button', { style: S.btnPrimary, disabled: busy === 'save', onClick: saveDraft }, t('save')),
              React.createElement('button', { style: S.btn, onClick: () => testRun(draft) }, t('test')),
              React.createElement('button', { style: S.btn, onClick: () => { setDraft(null); setErrors([]) } }, t('cancel'))))
            : null),

        React.createElement('div', { style: S.card },
          React.createElement('div', { style: S.between },
            React.createElement('button', { style: S.btn, onClick: () => setShowHistory((v) => !v) },
              (showHistory ? '▾ ' : '▸ ') + t('history') + (status.history ? '（' + status.history.count + '/' + status.history.limit + '）' : '')),
            showHistory ? React.createElement('button', { style: S.btn, disabled: busy === 'clear', onClick: clearHistory }, t('clearHistory')) : null),
          showHistory
            ? (history && history.entries && history.entries.length > 0
              ? history.entries.slice(0, 50).map((entry) => React.createElement('div', {
                key: entry.id,
                style: Object.assign({}, S.card, { marginTop: '8px' }),
              },
                React.createElement('div', { style: S.between },
                  React.createElement('div', { style: S.row },
                    React.createElement('span', { style: statusColor(entry.status) }, statusLabel(entry.status)),
                    React.createElement('span', null, entry.ruleName || entry.ruleId || ''),
                    React.createElement('span', { style: S.muted }, entry.trigger || ''),
                    entry.test ? React.createElement('span', { style: S.chip }, 'test') : null),
                  React.createElement('div', { style: S.row },
                    React.createElement('span', { style: S.muted }, fmtTime(entry.startedAt)),
                    React.createElement('button', { style: S.btn, onClick: () => setOpenEntry(openEntry === entry.id ? null : entry.id) }, t('output')))),
                React.createElement('div', { style: S.muted },
                  (entry.sessionTitle || entry.sessionId || '') +
                  (entry.durationMs === null || entry.durationMs === undefined ? '' : ' · ' + entry.durationMs + 'ms') +
                  (entry.exitCode === null || entry.exitCode === undefined ? '' : ' · ' + t('exitCode') + ' ' + entry.exitCode) +
                  (entry.error ? ' · ' + entry.error : '') + (entry.note ? ' · ' + entry.note : '')),
                openEntry === entry.id ? React.createElement('pre', { style: S.pre },
                  (entry.stderr ? '[stderr]\n' + entry.stderr + '\n' : '') + (entry.stdout ? '[stdout]\n' + entry.stdout : '')) : null))
              : React.createElement('div', { style: S.muted }, t('historyEmpty')))
            : null))
    }

    // The React section needs the plugin ctx for guarded service lookup.
    let componentCtx = null

    // --- registration --------------------------------------------------------
    function apply(ctx) {
      componentCtx = ctx
      // One tab inside the core "Plugins" settings page (no Settings nav row).
      ctx.slots.inject('settings.localPlugins.tab', () => ctx.slots.register({
        name: 'settings.localPlugins.tab',
        id: 'idle-hook',
        order: 40,
        label: () => t('nav'),
      }, IdleHookSection))
      if (typeof ctx.effect === 'function') ctx.effect(() => startHeartbeat())
      else startHeartbeat()
    }

    if (typeof window !== 'undefined' && window.__DSH_TEST__) {
      window.__dshIdleHookTest = { normalizeRule, validateLocally, blankRule, API, SETTINGS_NS, startHeartbeat, envToRows, envFromRows }
    }

    return { apply, inject: ['slots'] }
  },
})
//# sourceURL=/dsh-idle-hook/src/client.js
