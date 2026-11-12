// dsh-model-alpha-sort: CLIENT half — Settings >「模型」页底部卡片
// (settings.models.footer, order 10).
//
// 只做三件事：读宿主半 GET /__dsh-model-alpha-sort/status、显示统计、
// 调 POST /__dsh-model-alpha-sort/sort 触发一次排序。写设置只在宿主半发生，
// 客户端不直连 remote.settings，避免两套写入实现。
//
// Bundle format: classic script, window.__ModuleLoader__.load({ id, factory }),
// no JSX — plain React.createElement + inline styles on --dsw-* tokens.
window.__ModuleLoader__.load({
  id: 'dsh-model-alpha-sort',
  factory: (require) => {
    'use strict'
    const React = require('react')
    const { useCallback, useEffect, useState } = React

    const API = '/__dsh-model-alpha-sort'
    const PLUGIN_ID = 'dsh-model-alpha-sort'
    const SLOT = 'settings.models.footer'
    const CARD_ID = 'model-alpha-sort'

    // --- copy ---------------------------------------------------------------
    const zhDict = {
      label: '模型排序',
      title: '模型排序',
      intro: '把每个提供方的模型目录按显示名重新排列：设置页列表、composer 选择器与 /model 弹窗会同时变成字母序。',
      statProviders: '可排提供方',
      statModels: '模型',
      statPending: '待排序提供方',
      sortNow: '立即按首字母排序',
      refresh: '刷新状态',
      busy: '正在写入设置…',
      loading: '正在读取状态…',
      rule: '当前规则',
      ruleLine: '排序键 {key} · {direction} · locale {collation}',
      keyName: '显示名',
      keyId: '模型 ID',
      asc: '升序',
      desc: '降序',
      note: '只改数组顺序，不改模型字段；自动发现、不在配置里的模型不参与排序。',
      empty: '没有可排序的提供方：设置文档里没有找到带模型数组的提供方。',
      startup: '启动排序',
      startupDone: '已完成（{changed} 处）',
      startupPending: '等待中 / 未成功：{error}',
      startupWaiting: '等待中',
      startupOff: '已关闭',
    }

    /** 取中文文案，缺键时回退键名，便于测试定位。 */
    function t(key) {
      return Object.prototype.hasOwnProperty.call(zhDict, key) ? zhDict[key] : key
    }

    const STATE_TEXT = {
      user: '用户段模型',
      inherited: '继承清单（未开启排序）',
      'inherited-writable': '继承清单（将写入）',
      absent: '没有模型数组',
      'namespace-absent': '设置文档里没有该命名空间',
    }

    const CODE_TEXT = {
      'settings-controller-absent': '宿主半未就绪：设置服务不可用。',
      'settings-describe-failed': '读取设置文档失败。',
      'llm-providers-failed': '读取提供方清单失败。',
      'settings/conflict': '设置文档刚被别处改过，请再点一次。',
      'settings/path-not-volatile': '该路径不可写（配置未声明 volatile）。',
    }

    // --- styles --------------------------------------------------------------
    const S = {
      card: {
        marginTop: '16px',
        border: '1px solid var(--dsw-border,rgba(127,127,127,.25))',
        borderRadius: '10px',
        padding: '12px 14px',
        display: 'flex',
        flexDirection: 'column',
        gap: '10px',
      },
      head: { display: 'flex', alignItems: 'baseline', gap: '10px', flexWrap: 'wrap' },
      title: { fontSize: '14px', fontWeight: 600 },
      muted: { color: 'var(--dsw-text-secondary,#8b8b8b)', fontSize: '12px' },
      stats: { display: 'flex', gap: '22px', flexWrap: 'wrap' },
      stat: { display: 'flex', flexDirection: 'column', gap: '2px' },
      statValue: { fontSize: '18px', fontWeight: 600, lineHeight: '1.1' },
      row: { display: 'flex', gap: '8px', flexWrap: 'wrap', alignItems: 'center' },
      btn: {
        padding: '5px 12px',
        borderRadius: '6px',
        border: '1px solid var(--dsw-border,rgba(127,127,127,.3))',
        background: 'transparent',
        color: 'inherit',
        cursor: 'pointer',
        font: 'inherit',
      },
      btnPrimary: {
        padding: '5px 12px',
        borderRadius: '6px',
        border: '1px solid var(--dsw-accent,#4c8bf5)',
        background: 'var(--dsw-accent,#4c8bf5)',
        color: '#fff',
        cursor: 'pointer',
        font: 'inherit',
      },
      btnDisabled: { opacity: 0.55, cursor: 'not-allowed' },
      chip: {
        padding: '1px 8px',
        borderRadius: '999px',
        border: '1px solid var(--dsw-border,rgba(127,127,127,.3))',
        fontSize: '11px',
      },
      ok: { color: 'var(--dsw-success,#2e9e5b)' },
      bad: { color: 'var(--dsw-danger,#d9534f)' },
      warn: { color: 'var(--dsw-warning,#c58b00)' },
      subhead: { fontSize: '12px', color: 'var(--dsw-text-secondary,#8b8b8b)', marginTop: '2px' },
    }

    // --- pure helpers (shared with the logic test) ---------------------------

    /**
     * 把状态对象归纳成一条可读结论。
     * @param {object|null} status GET /status 的响应，例 { ok: true, writable: true, totals: { pending: 0 } }
     * @returns {{ tone: 'ok'|'warn'|'bad'|'muted', text: string }} 例 { tone: 'ok', text: '所有可排提供方都已按当前规则有序。' }
     */
    function summarize(status) {
      if (!status) return { tone: 'muted', text: t('loading') }
      if (!status.ok) {
        return { tone: 'bad', text: CODE_TEXT[status.code] || status.message || '宿主半不可用。' }
      }
      if (!status.writable) return { tone: 'warn', text: '当前设置文档只读，排序被禁用。' }
      if (status.http && status.http.mounted === false) {
        return { tone: 'warn', text: '宿主端点不可用（webServer 未挂载），只有启动排序可能生效。' }
      }
      const pending = status.totals && typeof status.totals.pending === 'number' ? status.totals.pending : 0
      if (pending > 0) return { tone: 'warn', text: '有 ' + pending + ' 个提供方待排序。' }
      return { tone: 'ok', text: '所有可排提供方都已按当前规则有序。' }
    }

    /**
     * 把排序选项翻译成一行中文说明。
     * @param {object} options 选项，例 { sortBy: 'name', direction: 'asc', collation: 'zh-CN' }
     * @returns {string} 例 '排序键 显示名 · 升序 · locale zh-CN'
     */
    function describeRule(options) {
      const source = options && typeof options === 'object' ? options : {}
      const key = source.sortBy === 'id' ? t('keyId') : t('keyName')
      const direction = source.direction === 'desc' ? t('desc') : t('asc')
      const collation = typeof source.collation === 'string' ? source.collation : 'zh-CN'
      return t('ruleLine')
        .replace('{key}', key)
        .replace('{direction}', direction)
        .replace('{collation}', collation)
    }

    /**
     * 描述启动排序的当前状态。
     * @param {object} status GET /status 的响应，例 { startup: { ok: true, lastResult: { changed: 1 } } }
     * @returns {string} 例 '已完成（1 处）'
     */
    function describeStartup(status) {
      const startup = status && status.startup ? status.startup : null
      if (!startup) return ''
      if (startup.ok) {
        const changed = startup.lastResult && typeof startup.lastResult.changed === 'number' ? startup.lastResult.changed : 0
        return t('startup') + '：' + t('startupDone').replace('{changed}', String(changed))
      }
      if (startup.lastError) return t('startup') + '：' + t('startupPending').replace('{error}', startup.lastError)
      return t('startup') + '：' + t('startupWaiting')
    }

    /**
     * 只保留真正带模型的提供方；空数组、没有模型数组的条目不再占位置。
     * @param {object|null} status GET /status 的响应，例 { providers: [{ provider: 'codemaker', count: 53 }, { provider: 'openai', count: 0 }] }
     * @returns {Array<object>} 例 [{ provider: 'codemaker', count: 53 }]
     */
    function visibleProviders(status) {
      if (!status || !Array.isArray(status.providers)) return []
      return status.providers.filter((item) => item && typeof item.count === 'number' && item.count > 0)
    }

    // --- component -----------------------------------------------------------

    /** 模型排序卡片：读状态、显示统计、触发一次排序。 */
    function ModelAlphaSortCard() {
      const [status, setStatus] = useState(null)
      const [error, setError] = useState(null)
      const [notice, setNotice] = useState(null)
      const [busy, setBusy] = useState(false)

      const load = useCallback(async () => {
        try {
          const res = await fetch(API + '/status', { headers: { 'x-dsh-plugin': PLUGIN_ID } })
          const json = await res.json()
          if (!res.ok || !json.ok) {
            throw new Error(CODE_TEXT[json && json.code] || (json && json.message) || ('HTTP ' + res.status))
          }
          setStatus(json)
          setError(null)
        } catch (e) {
          setError((e && e.message) || String(e))
        }
      }, [])

      useEffect(() => {
        void load()
      }, [load])

      const runSort = useCallback(async () => {
        setBusy(true)
        setNotice(null)
        try {
          const res = await fetch(API + '/sort', {
            method: 'POST',
            headers: { 'x-dsh-plugin': PLUGIN_ID },
          })
          const json = await res.json()
          if (!res.ok || !json.ok) {
            throw new Error(CODE_TEXT[json && json.code] || (json && json.message) || ('HTTP ' + res.status))
          }
          const changed = typeof json.changed === 'number' ? json.changed : 0
          if (json.skipped === 'read-only') setNotice('当前设置文档只读，未写入任何内容。')
          else if (changed > 0) setNotice('已排序 ' + changed + ' 个提供方。')
          else setNotice('已经是有序状态，没有写入。')
          if (json.status) setStatus(json.status)
          else await load()
          setError(null)
        } catch (e) {
          setError((e && e.message) || String(e))
        } finally {
          setBusy(false)
        }
      }, [load])

      const summary = summarize(status)
      const summaryStyle = summary.tone === 'ok' ? S.ok : summary.tone === 'warn' ? S.warn : summary.tone === 'bad' ? S.bad : S.muted
      const totals = status && status.totals ? status.totals : { providers: 0, models: 0, pending: 0 }
      const writable = Boolean(status && status.ok && status.writable)
      const canSort = writable && !busy

      const children = [
        React.createElement('div', { key: 'head', style: S.head },
          React.createElement('div', { style: S.title }, t('title')),
          React.createElement('div', { style: S.muted }, t('intro'))),
        error
          ? React.createElement('div', { key: 'err', style: S.bad }, error)
          : React.createElement('div', { key: 'summary', style: summaryStyle }, summary.text),
        React.createElement('div', { key: 'stats', style: S.stats },
          React.createElement('div', { style: S.stat },
            React.createElement('div', { style: S.statValue }, String(totals.providers)),
            React.createElement('div', { style: S.muted }, t('statProviders'))),
          React.createElement('div', { style: S.stat },
            React.createElement('div', { style: S.statValue }, String(totals.models)),
            React.createElement('div', { style: S.muted }, t('statModels'))),
          React.createElement('div', { style: S.stat },
            React.createElement('div', { style: S.statValue }, String(totals.pending)),
            React.createElement('div', { style: S.muted }, t('statPending')))),
        React.createElement('div', { key: 'rule', style: S.muted },
          t('rule') + '：' + describeRule(status && status.options) + '　' + describeStartup(status)),
        React.createElement('div', { key: 'actions', style: S.row },
          React.createElement('button', {
            type: 'button',
            style: Object.assign({}, S.btnPrimary, canSort ? null : S.btnDisabled),
            disabled: !canSort,
            onClick: () => { void runSort() },
          }, busy ? t('busy') : t('sortNow')),
          React.createElement('button', {
            type: 'button',
            style: Object.assign({}, S.btn, busy ? S.btnDisabled : null),
            disabled: busy,
            onClick: () => { void load() },
          }, t('refresh'))),
        notice ? React.createElement('div', { key: 'notice', style: S.ok }, notice) : null,
      ]

      const visible = visibleProviders(status)
      if (visible.length > 0) {
        children.push(React.createElement('div', { key: 'providers', style: S.row },
          visible.map((item) => React.createElement('span', { key: item.provider, style: S.chip },
            (item.displayName || item.provider) + ' · ' + item.count + (item.pending ? ' · 待排序' : '') +
            ' · ' + (STATE_TEXT[item.state] || item.state)))))
      } else if (status && status.ok) {
        children.push(React.createElement('div', { key: 'empty', style: S.muted }, t('empty')))
      }

      children.push(React.createElement('div', { key: 'note', style: S.muted }, t('note')))
      return React.createElement('section', { style: S.card }, children)
    }

    // --- registration --------------------------------------------------------

    /** 注册设置页底部卡片；槽位在「模型」页里，是官方 list 扩展位。 */
    function apply(ctx) {
      ctx.slots.inject(SLOT, () => ctx.slots.register({
        name: SLOT,
        id: CARD_ID,
        order: 10,
        label: () => t('label'),
      }, ModelAlphaSortCard))
    }

    if (typeof window !== 'undefined' && window.__DSH_TEST__) {
      window.__dshModelAlphaSortTest = { API, PLUGIN_ID, SLOT, CARD_ID, summarize, describeRule, describeStartup, visibleProviders }
    }

    return { apply, inject: ['slots'] }
  },
})
//# sourceURL=/dsh-model-alpha-sort/src/client.js
