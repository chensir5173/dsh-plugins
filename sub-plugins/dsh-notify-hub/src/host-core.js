// dsh-notify-hub: HOST core — pure, side-effect-free logic.
//
// Everything that can be unit-tested lives here: the turn-end trigger matrix,
// interpreter selection, placeholder/env/context construction, presence
// preconditions, debounce, failure counting and history trimming.
// src/index.js only wires this core to the DSH host (session events, the two
// approval/question waterfalls, the settings namespace, child processes, the
// built-in SMTP mailer and the /__notify-hub/* HTTP endpoints).
//
// ESM (cordis bundle rule). This file must NEVER import @deepseek-ai/* — the
// link: layout cannot resolve host packages from the repo (see
// docs/knowledge/2026-09-09-plugin-host-half-no-core-import.md).

import os from 'node:os'
import path from 'node:path'

// --- constants ---------------------------------------------------------------

/** Bundle id / settings section id / plugin dir name. */
export const PLUGIN_ID = 'dsh-notify-hub'
/** HTTP prefix of this plugin's host endpoints. */
export const HTTP_PREFIX = '/__notify-hub'
/** Settings namespace inside <DSH_HOME|~/.dsh>/settings.yaml. */
export const SETTINGS_NS = 'notify-hub'
/** Host-owned state file (execution history + per-rule runtime counters). */
export const HISTORY_FILE_NAME = 'notify-hub-history.json'

// Names used before the 2026-11 rename (dsh-idle-hook). Read once and migrated,
// never written back: the plugin keeps one version cycle of compatibility so an
// upgrade does not lose the user's rules or history.
export const LEGACY_SETTINGS_NS = 'idle-hook'
export const LEGACY_HISTORY_FILE_NAME = 'idle-hook-history.json'
/** Rolling history cap. */
export const HISTORY_LIMIT = 200
/** Per rule+session minimum gap between two triggers. */
export const DEFAULT_DEBOUNCE_MS = 3000
/** Per run kill timeout. */
export const DEFAULT_TIMEOUT_MS = 30000
/** Consecutive failures that auto-disable a rule. */
export const FAILURE_LIMIT = 3
/** Client heartbeat cadence (client half mirrors this). */
export const PRESENCE_INTERVAL_MS = 5000
/** No heartbeat for this long means "the page is closed". */
export const PRESENCE_STALE_MS = 30000
/** Output tail kept per run. */
export const TAIL_LINES = 20
export const TAIL_CHARS = 4000

/** Trigger kinds reported to the script (also the `reason` field). */
export const TRIGGER = { turnEnd: 'turn-end', approval: 'approval', question: 'question' }
/** How a rule delivers its notification. */
export const CHANNEL = { script: 'script', email: 'email' }
/** Which session states count, per rule. */
export const PRECONDITION = {
  any: 'any',
  pageClosed: 'page-closed',
  pageHidden: 'page-hidden-or-blurred',
}

/** turn/end reasons that always notify (turn really ended, human input expected). */
export const TURN_END_FIRE = ['completed', 'blocked', 'error', 'max-tokens']
/** aborted causes that stay silent: the user stopped it, or the session died. */
export const TURN_END_SILENT = ['user', 'disposed']

// --- paths -------------------------------------------------------------------

/** DSH home directory (~/.dsh), honouring an explicit DSH_HOME override. */
export function dshHome(env = process.env) {
  const override = env && typeof env.DSH_HOME === 'string' ? env.DSH_HOME.trim() : ''
  return override || path.join(os.homedir(), '.dsh')
}

export function historyPathOf(home) {
  return path.join(home || dshHome(), HISTORY_FILE_NAME)
}

/**
 * Expand a leading ~ (the only shell-ism a script path needs).
 * The join follows the TARGET platform, not the host: buildCommand takes an
 * injected `platform` (tests; settings written for another OS), and a host
 * `path.join` on Windows turns a darwin target's `~/bin/x.sh` into
 * `\\Users\\me\\bin\\x.sh`.
 */
export function expandTilde(value, home = os.homedir(), platform = process.platform) {
  if (typeof value !== 'string' || !value) return value
  if (value === '~') return home
  if (value.startsWith('~/') || value.startsWith('~\\')) {
    return (platform === 'win32' ? path.win32 : path.posix).join(home, value.slice(2))
  }
  return value
}

// --- strings -----------------------------------------------------------------

/** Replace {sessionId} {cwd} {title} {reason} {detail} {rule} in a value. */
export function applyPlaceholders(value, values = {}) {
  if (typeof value !== 'string' || value.indexOf('{') === -1) return value
  return value.replace(/\{(\w+)\}/g, (all, key) =>
    Object.prototype.hasOwnProperty.call(values, key) ? String(values[key] == null ? '' : values[key]) : all)
}

/** Values we hand to env vars that must survive any console code page. */
export function asciiSafe(value) {
  if (value == null) return ''
  let out = ''
  const s = String(value)
  for (let i = 0; i < s.length; i += 1) {
    const code = s.charCodeAt(i)
    out += code >= 32 && code < 127 ? s[i] : '?'
  }
  return out
}

export function isPlainObject(value) {
  return Boolean(value) && typeof value === 'object' && !Array.isArray(value)
}

/** Keep the last `lines` lines / `chars` characters of captured output. */
export function tailText(text, lines = TAIL_LINES, chars = TAIL_CHARS) {
  const s = typeof text === 'string' ? text : ''
  if (!s) return ''
  const split = s.split(/\r?\n/)
  const last = split.slice(Math.max(0, split.length - lines)).join('\n')
  return last.length > chars ? last.slice(last.length - chars) : last
}

// --- command construction ----------------------------------------------------

/**
 * Interpreter for a script file, by extension. An explicit rule.interpreter
 * always wins. python3 on darwin/linux (macOS ships a python2 `python`),
 * python on Windows (the py launcher / store alias).
 */
export function interpreterFor(file, platform = process.platform) {
  const ext = path.extname(String(file || '')).toLowerCase()
  switch (ext) {
    case '.py': return { command: platform === 'win32' ? 'python' : 'python3', prefix: ['-u'] }
    case '.bat': return { command: 'cmd', prefix: ['/c'] }
    case '.cmd': return { command: 'cmd', prefix: ['/c'] }
    case '.ps1': return { command: 'powershell', prefix: ['-NoProfile', '-ExecutionPolicy', 'Bypass', '-File'] }
    case '.sh': return { command: 'bash', prefix: [] }
    case '.bash': return { command: 'bash', prefix: [] }
    case '.zsh': return { command: 'zsh', prefix: [] }
    case '.js': return { command: process.execPath, prefix: [] }
    case '.mjs': return { command: process.execPath, prefix: [] }
    default: return null
  }
}

/** Single-quote for the explicit shell escape hatch (best effort, POSIX-ish). */
export function quoteIfNeeded(value, platform = process.platform) {
  const s = String(value == null ? '' : value)
  if (!s) return '""'
  if (platform === 'win32') return /[\s"]/.test(s) ? '"' + s.replace(/"/g, '\\"') + '"' : s
  return /[^A-Za-z0-9_@%+=:,./-]/.test(s) ? "'" + s.replace(/'/g, "'\\''") + "'" : s
}

/**
 * Resolve a rule into an executable { command, args, shell } plan.
 * Default path: argv array handed straight to spawn (no shell parsing, so a
 * path with spaces is never mangled and nothing can be injected). The explicit
 * rule.shell escape hatch joins everything into one shell line instead.
 */
export function buildCommand(rule, values = {}, options = {}) {
  const home = options.home || os.homedir()
  const platform = options.platform || process.platform
  const rawText = String((rule && rule.command) || '').trim()
  if (!rawText) return { ok: false, error: '命令为空' }
  const split = splitInterpreterCommand(applyPlaceholders(rawText, values))
  const raw = split.command
  const file = expandTilde(raw, home, platform)
  const args = (Array.isArray(rule && rule.args) ? rule.args : []).map((a) => applyPlaceholders(String(a == null ? '' : a), values))
  if (rule && rule.shell === true) {
    const line = [quoteIfNeeded(file, platform)].concat(args.map((a) => quoteIfNeeded(a, platform))).join(' ')
    return { ok: true, shell: true, file, command: line, args: [], note: split.note }
  }
  const override = String((rule && rule.interpreter) || '').trim() || split.interpreter
  if (override) return { ok: true, shell: false, file, command: override, args: [file].concat(args), note: split.note }
  const auto = interpreterFor(file, platform)
  if (!auto) return { ok: true, shell: false, file, command: file, args, note: split.note }
  return { ok: true, shell: false, file, command: auto.command, args: auto.prefix.concat([file]).concat(args), note: split.note }
}

/**
 * The 命令 field is a single-line input, but pasting "python3.11" + a newline +
 * the script path is an easy mistake (YAML even folds it into one line). Such a
 * value can never run: spawn would look for one executable with that whole name,
 * and because the string still ends in .py the extension-based interpreter then
 * feeds the garbage to python, which exits 2 with "can't open file ...".
 * Since a multi-line command is *never* valid, split it into what the user meant
 * and say so.
 */
export function splitInterpreterCommand(command) {
  const text = String(command == null ? '' : command)
  if (text.indexOf('\n') === -1 && text.indexOf('\r') === -1) return { command: text.trim(), note: null, interpreter: '' }
  const lines = text.split(/\r?\n/).map((line) => line.trim()).filter((line) => line.length > 0)
  if (lines.length < 2) return { command: lines.join(' ').trim(), note: null, interpreter: '' }
  const head = lines[0]
  const file = lines.slice(1).join(' ')
  const looksLikePath = /[\\/]/.test(file) && /\.(py|sh|ps1|bat|cmd|js|mjs|exe)$/i.test(file)
  if (!looksLikePath) return { command: lines.join(' ').trim(), note: null, interpreter: '' }
  return {
    command: file,
    interpreter: head,
    note: '命令字段里同时写了「' + head + '」和脚本路径，已按「解释器 ' + head + ' + 脚本 ' + file
      + '」执行；建议把 ' + head + ' 挪到「解释器」字段（或留空让插件按扩展名自动选）',
  }
}

// --- trigger matrix ----------------------------------------------------------

/**
 * Pull the turn/end reason out of a SessionEvent.
 *
 * The log stores events as { type, seq, time, data } — the payload (turn, reason)
 * lives under data, NOT on the event itself. Reading event.reason silently yields
 * undefined, which makes shouldFireOnTurnEnd() return false and the whole trigger
 * chain go quiet (this exact bug shipped once and cost an evening).
 */
export function turnEndReasonOf(event) {
  if (!isPlainObject(event)) return null
  const data = isPlainObject(event.data) ? event.data : null
  const reason = data && data.reason !== undefined ? data.reason : event.reason
  return reason === undefined ? null : reason
}

/** Normalise a session turn/end reason into a stable string. */
export function turnEndKind(reason) {
  if (!isPlainObject(reason)) return ''
  const kind = typeof reason.kind === 'string' ? reason.kind : ''
  if (kind !== 'aborted') return kind
  const cause = isPlainObject(reason.reason) && typeof reason.reason.kind === 'string' ? reason.reason.kind : ''
  return cause ? 'aborted:' + cause : 'aborted'
}

/**
 * Should a finished turn notify? Everything that leaves the user in charge
 * does — except the user's own Stop (aborted:user) and a disposed session.
 * `interrupted` is a repair marker the live loop never emits → silent.
 */
export function shouldFireOnTurnEnd(reason) {
  const kind = turnEndKind(reason)
  if (!kind) return false
  if (TURN_END_FIRE.indexOf(kind) !== -1) return true
  if (kind === 'interrupted') return false
  if (kind === 'aborted') return true
  if (kind.indexOf('aborted:') === 0) return TURN_END_SILENT.indexOf(kind.slice(8)) === -1
  return false
}

/** Does this rule listen to this trigger kind? (turn-end also runs the matrix.) */
export function ruleListensTo(rule, trigger, reason) {
  const t = isPlainObject(rule && rule.triggers) ? rule.triggers : {}
  if (trigger === TRIGGER.turnEnd) return t.turnEnd !== false && shouldFireOnTurnEnd(reason)
  if (trigger === TRIGGER.approval) return t.approval !== false
  if (trigger === TRIGGER.question) return t.question !== false
  return false
}

// --- context handed to the script --------------------------------------------

/**
 * The script contract: full context on stdin (UTF-8 JSON, includes the human
 * readable session title), ASCII-safe mirrors in the environment. The
 * conversation body is NEVER included.
 */
export function buildTriggerContext(input = {}) {
  const rule = input.rule || {}
  const now = typeof input.now === 'number' ? input.now : Date.now()
  const triggeredAt = new Date(now).toISOString()
  const payload = {
    sessionId: input.sessionId || null,
    sessionTitle: input.sessionTitle == null ? null : String(input.sessionTitle),
    cwd: input.cwd == null ? null : String(input.cwd),
    reason: input.trigger || null,
    reasonDetail: input.detail || null,
    triggeredAt,
    ruleId: rule.id || null,
    ruleName: rule.name || null,
  }
  // Both key sets are injected for one version cycle: user scripts written
  // against the old IDLE_HOOK_* contract keep working after the rename.
  const env = {
    NOTIFY_HUB_SESSION_ID: asciiSafe(payload.sessionId),
    NOTIFY_HUB_RULE_ID: asciiSafe(payload.ruleId),
    NOTIFY_HUB_REASON: asciiSafe(payload.reason),
    NOTIFY_HUB_DETAIL: asciiSafe(payload.reasonDetail),
    NOTIFY_HUB_TIME: asciiSafe(triggeredAt),
    NOTIFY_HUB_CWD: payload.cwd == null ? '' : payload.cwd,
    IDLE_HOOK_SESSION_ID: asciiSafe(payload.sessionId),
    IDLE_HOOK_RULE_ID: asciiSafe(payload.ruleId),
    IDLE_HOOK_REASON: asciiSafe(payload.reason),
    IDLE_HOOK_DETAIL: asciiSafe(payload.reasonDetail),
    IDLE_HOOK_TIME: asciiSafe(triggeredAt),
    IDLE_HOOK_CWD: payload.cwd == null ? '' : payload.cwd,
  }
  return { payload, env }
}

/** Placeholder values available to rule.args and rule.command. */
export function placeholderValues(payload = {}, rule = {}) {
  return {
    sessionId: payload.sessionId || '',
    title: payload.sessionTitle || '',
    cwd: payload.cwd || '',
    reason: payload.reason || '',
    detail: payload.reasonDetail || '',
    rule: rule.name || rule.id || '',
    time: payload.triggeredAt || '',
  }
}

// --- environment variables (global + per rule) -------------------------------

/** Keys the plugin itself injects: a rule may not overwrite the trigger contract. */
export const CONTRACT_ENV_PREFIX = 'NOTIFY_HUB_'
/** Pre-rename contract prefix, still injected (and still reserved). */
export const LEGACY_CONTRACT_ENV_PREFIX = 'IDLE_HOOK_'

/** True for both the current and the legacy inject-only env prefixes. */
export function isReservedEnvKey(key) {
  const name = String(key == null ? '' : key)
  return name.indexOf(CONTRACT_ENV_PREFIX) === 0 || name.indexOf(LEGACY_CONTRACT_ENV_PREFIX) === 0
}
/** A portable env var name (POSIX + cmd both accept this shape). */
export const ENV_KEY_RE = /^[A-Za-z_][A-Za-z0-9_]*$/

/**
 * Accepts the settings shape ({ KEY: value }) or "KEY=VALUE" lines and returns a
 * plain object of string values. Invalid keys are dropped here — use
 * validateEnv() to tell the user *why* they were dropped.
 */
export function normalizeEnv(input) {
  const out = {}
  for (const [key, value] of envEntries(input)) {
    const name = String(key || '').trim()
    if (!ENV_KEY_RE.test(name)) continue
    out[name] = value == null ? '' : String(value)
  }
  return out
}

function envEntries(input) {
  if (Array.isArray(input)) {
    const out = []
    for (const line of input) {
      const text = String(line == null ? '' : line)
      if (!text.trim() || text.trim().startsWith('#')) continue
      const at = text.indexOf('=')
      // A line with no '=' is malformed (validateEnv reports it): drop it here
      // rather than inventing an empty-valued variable.
      if (at === -1) continue
      out.push([text.slice(0, at).trim(), text.slice(at + 1)])
    }
    return out
  }
  if (isPlainObject(input)) return Object.keys(input).map((key) => [key, input[key]])
  return []
}

/** Split a "KEY=VALUE" textarea into env lines (blank lines and #comments ignored). */
export function parseEnvText(text) {
  return envEntries(String(text == null ? '' : text).split(/\r?\n/))
}

/** Render an env object back into the textarea representation. */
export function formatEnvText(env) {
  const obj = normalizeEnv(env)
  return Object.keys(obj).map((key) => key + '=' + obj[key]).join('\n')
}

/**
 * Validation for the settings UI: errors block saving, warnings do not.
 * Overriding an IDLE_HOOK_* key is a warning, not an error — the contract wins
 * silently at run time, so saving it would only create a mystery.
 */
export function validateEnv(input) {
  const errors = []
  const warnings = []
  const seen = new Set()
  if (Array.isArray(input)) {
    for (const line of input) {
      const text = String(line == null ? '' : line)
      if (!text.trim() || text.trim().startsWith('#')) continue
      const at = text.indexOf('=')
      if (at === -1) {
        errors.push('环境变量缺少等号：' + text.trim())
        continue
      }
      const name = text.slice(0, at).trim()
      if (!ENV_KEY_RE.test(name)) {
        errors.push('环境变量名不合法（只能用字母、数字、下划线，且不能以数字开头）：' + name)
        continue
      }
      if (seen.has(name)) warnings.push('环境变量重复，后面的会覆盖前面的：' + name)
      seen.add(name)
      if (name.indexOf(CONTRACT_ENV_PREFIX) === 0) {
        warnings.push('已忽略 ' + name + '：' + CONTRACT_ENV_PREFIX + '* 由插件注入的触发上下文占用，规则不能覆盖（脚本仍会拿到真实值）')
      }
    }
    return { errors, warnings }
  }
  for (const [key, value] of envEntries(input)) {
    const name = String(key || '').trim()
    if (!ENV_KEY_RE.test(name)) errors.push('环境变量名不合法：' + name)
    else if (name.indexOf(CONTRACT_ENV_PREFIX) === 0) {
      warnings.push('已忽略 ' + name + '：' + CONTRACT_ENV_PREFIX + '* 由插件注入的触发上下文占用，规则不能覆盖')
    }
    if (typeof value === 'string' && value.indexOf('\n') !== -1) {
      warnings.push('环境变量 ' + name + ' 的值里有换行，某些脚本可能读不到完整内容')
    }
  }
  return { errors, warnings }
}

/** Replace {sessionId} etc. inside env values (keys stay literal). */
export function applyEnvPlaceholders(env, values = {}) {
  const out = {}
  for (const [key, value] of Object.entries(normalizeEnv(env))) {
    out[key] = applyPlaceholders(value, values)
  }
  return out
}

/**
 * Precedence, lowest first: the inherited process env → global (plugin) env →
 * this rule's env → the IDLE_HOOK_* trigger contract (always wins).
 */
export function mergeEnv(baseEnv, globalEnv, ruleEnv, contractEnv) {
  const merged = Object.assign({}, baseEnv || {})
  for (const layer of [globalEnv, ruleEnv]) {
    for (const [key, value] of Object.entries(normalizeEnv(layer))) {
      if (isReservedEnvKey(key)) continue
      merged[key] = value
    }
  }
  for (const [key, value] of Object.entries(contractEnv || {})) merged[key] = value
  return merged
}

// --- config ------------------------------------------------------------------

export function newRuleId(now = Date.now(), rand = Math.random) {
  return 'rule-' + now.toString(36) + '-' + Math.floor(rand() * 1679616).toString(36)
}

function clampInt(value, min, max, fallback) {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  return Math.min(max, Math.max(min, Math.round(n)))
}

export function normalizeRule(input = {}) {
  const src = isPlainObject(input) ? input : {}
  const triggers = isPlainObject(src.triggers) ? src.triggers : {}
  const precondition = Object.keys(PRECONDITION).map((k) => PRECONDITION[k]).indexOf(src.precondition) !== -1
    ? src.precondition : PRECONDITION.any
  return {
    id: typeof src.id === 'string' && src.id ? src.id : newRuleId(),
    name: typeof src.name === 'string' && src.name.trim() ? src.name.trim().slice(0, 80) : '未命名规则',
    enabled: src.enabled === true,
    channel: src.channel === CHANNEL.email ? CHANNEL.email : CHANNEL.script,
    email: normalizeEmail(src.email),
    command: typeof src.command === 'string' ? src.command.trim() : '',
    args: Array.isArray(src.args) ? src.args.map((a) => String(a == null ? '' : a)) : [],
    interpreter: typeof src.interpreter === 'string' ? src.interpreter.trim() : '',
    cwd: typeof src.cwd === 'string' ? src.cwd.trim() : '',
    triggers: {
      turnEnd: triggers.turnEnd !== false,
      approval: triggers.approval !== false,
      question: triggers.question !== false,
    },
    precondition,
    debounceMs: clampInt(src.debounceMs, 0, 600000, DEFAULT_DEBOUNCE_MS),
    timeoutMs: clampInt(src.timeoutMs, 1000, 3600000, DEFAULT_TIMEOUT_MS),
    shell: src.shell === true,
    env: normalizeEnv(src.env),
  }
}

export function defaultConfig() {
  return { enabled: true, seeded: false, env: {}, rules: [] }
}

export function normalizeConfig(input) {
  const src = isPlainObject(input) ? input : {}
  return {
    enabled: src.enabled === undefined ? true : src.enabled !== false,
    seeded: src.seeded === true,
    env: normalizeEnv(src.env),
    rules: Array.isArray(src.rules) ? src.rules.filter(isPlainObject).map(normalizeRule) : [],
  }
}

/**
 * The disabled sample rule seeded on first open.
 *
 * The precondition is 'any', NOT 'page-closed': the two cases users care about
 * most (a question awaiting an answer, a tool approval pending) happen while the
 * page is right in front of them, so a page-closed precondition would make the
 * sample rule look broken ("installed, never fired").
 */
export function sampleRule(pluginDir, platform = process.platform) {
  const win = platform === 'win32'
  return normalizeRule({
    id: 'sample-notify',
    name: '示例：桌面通知脚本（默认关闭）',
    enabled: false,
    command: path.join(pluginDir, 'examples', win ? 'notify-windows.ps1' : 'notify-macos.sh'),
    args: [],
    interpreter: '',
    cwd: '',
    triggers: { turnEnd: true, approval: true, question: true },
    precondition: PRECONDITION.any,
    debounceMs: DEFAULT_DEBOUNCE_MS,
    timeoutMs: DEFAULT_TIMEOUT_MS,
    shell: false,
  })
}

/** Cheap validation before saving (the host also probes the file at run time). */
export function validateRule(rule, probe = {}) {
  const errors = []
  const r = rule || {}
  if (r.channel === CHANNEL.email) {
    for (const problem of validateEmailConfig(r.email)) errors.push(problem)
  } else {
    if (!String(r.command || '').trim()) errors.push('命令不能为空')
    if (/[\r\n]/.test(String(r.command || ''))) {
      errors.push('命令里不能有换行：这里只填脚本路径，「' + String(r.command).split(/\r?\n/)[0].trim() + '」这类解释器请填到「解释器」字段')
    }
  }
  const t = isPlainObject(r.triggers) ? r.triggers : {}
  if (t.turnEnd === false && t.approval === false && t.question === false) errors.push('至少要勾选一个触发条件')
  if (typeof probe.exists === 'function' && String(r.command || '').trim() && r.shell !== true) {
    let exists = true
    try { exists = probe.exists(String(r.command)) } catch { exists = true }
    if (!exists) errors.push('脚本文件不存在：' + r.command)
  }
  const envCheck = validateEnv(r.env)
  for (const problem of envCheck.errors) errors.push(problem)
  return { ok: errors.length === 0, errors, warnings: envCheck.warnings }
}


// --- email channel -----------------------------------------------------------

/**
 * One-click provider presets. Kept in the host core so the client half and the
 * tests agree on the exact host/port/secure triple.
 */
export const EMAIL_PROVIDERS = [
  { id: 'qq', label: 'QQ 邮箱', host: 'smtp.qq.com', port: 465, secure: true },
  { id: '163', label: '网易 163', host: 'smtp.163.com', port: 465, secure: true },
  { id: '126', label: '网易 126', host: 'smtp.126.com', port: 465, secure: true },
  { id: 'gmail', label: 'Gmail', host: 'smtp.gmail.com', port: 465, secure: true },
  { id: 'outlook', label: 'Outlook', host: 'smtp.office365.com', port: 587, secure: false },
  { id: 'custom', label: '自定义', host: '', port: 465, secure: true },
]

export const DEFAULT_MAIL_SUBJECT = 'DSH 通知：{reason} · {title}'
export const DEFAULT_MAIL_BODY = [
  '会话：{title}（{sessionId}）',
  '目录：{cwd}',
  '原因：{reason} {detail}',
  '时间：{time}',
  '',
  '—— 由 DSH 通知枢纽自动发送',
].join('\n')

/** Provider preset by id (falls back to the custom preset). */
export function emailProvider(id) {
  const key = String(id == null ? '' : id)
  for (const item of EMAIL_PROVIDERS) if (item.id === key) return item
  return EMAIL_PROVIDERS[EMAIL_PROVIDERS.length - 1]
}

function emailStr(value) {
  return value == null ? '' : String(value).trim()
}

export function defaultEmail() {
  return {
    host: '',
    port: 465,
    secure: true,
    starttls: true,
    user: '',
    pass: '',
    passEnv: '',
    from: '',
    to: '',
    subject: DEFAULT_MAIL_SUBJECT,
    body: DEFAULT_MAIL_BODY,
    allowInsecureTls: false,
  }
}

/**
 * Shape an arbitrary settings object into a complete email config. Never throws,
 * never drops the user's authorization code (it is only ever hidden at the
 * status/HTTP boundary).
 */
export function normalizeEmail(input = {}) {
  const src = isPlainObject(input) ? input : {}
  const def = defaultEmail()
  return {
    host: emailStr(src.host),
    port: clampInt(src.port, 1, 65535, def.port),
    secure: src.secure === undefined ? def.secure : src.secure === true,
    starttls: src.starttls === undefined ? def.starttls : src.starttls !== false,
    user: emailStr(src.user),
    pass: emailStr(src.pass),
    passEnv: emailStr(src.passEnv),
    from: emailStr(src.from),
    to: emailStr(src.to),
    subject: emailStr(src.subject) || def.subject,
    // 空串也回落默认：用户在设置里清空正文模板时，不该保存成一封没有内容的邮件
    body: typeof src.body === 'string' && src.body.trim() ? src.body : def.body,
    allowInsecureTls: src.allowInsecureTls === true,
  }
}

const ADDRESS_RE = /^[^\s@,;]+@[^\s@,;]+\.[^\s@,;]+$/

/**
 * Split "a@x.com, b@y.com" (also ';' separated) into a bare address list.
 * "Name <a@x.com>" is reduced to a@x.com: RCPT TO only accepts the address, and
 * keeping a display name would also break the address check below.
 */
export function parseAddressList(value) {
  return String(value == null ? '' : value)
    .split(/[,;]/)
    .map((item) => {
      const raw = item.trim()
      if (!raw) return ''
      const named = /^(.*)<([^>]+)>\s*$/.exec(raw)
      return (named ? named[2] : raw).trim()
    })
    .filter(Boolean)
}

/** Returns a list of human readable problems (empty = valid). */
export function validateEmailConfig(input = {}) {
  const email = normalizeEmail(input)
  const errors = []
  if (!email.host) errors.push('邮件服务器地址不能为空')
  if (!email.to) errors.push('收件人不能为空')
  const badTo = parseAddressList(email.to).filter((item) => !ADDRESS_RE.test(item))
  if (badTo.length) errors.push('收件人格式不正确：' + badTo.join(', '))
  if (email.from) {
    const badFrom = parseAddressList(email.from).filter((item) => !ADDRESS_RE.test(item))
    if (badFrom.length) errors.push('发件人格式不正确：' + badFrom.join(', '))
  }
  if (email.passEnv && !ENV_KEY_RE.test(email.passEnv)) {
    errors.push('授权码环境变量名不合法：' + email.passEnv)
  }
  if (!email.pass && !email.passEnv) {
    errors.push('授权码没有来源：请直接在设置里填写，或指定一个环境变量名')
  }
  return errors
}

/**
 * The authorization code, in priority order: the value typed in settings, then
 * the named environment variable (which may come from the global or the rule's
 * env map). Never logged, never returned by /status.
 */
export function resolveEmailPass(email, env = {}) {
  const direct = email && typeof email.pass === 'string' ? email.pass : ''
  if (direct) return direct
  const key = email && typeof email.passEnv === 'string' ? email.passEnv.trim() : ''
  if (key && env && typeof env[key] === 'string') return env[key]
  return ''
}

/** True when a credential is configured either directly or via env. */
export function hasEmailPass(email, env = {}) {
  const direct = email && typeof email.pass === 'string' ? email.pass.trim() : ''
  if (direct) return true
  const key = email && typeof email.passEnv === 'string' ? email.passEnv.trim() : ''
  return !!(key && env && typeof env[key] === 'string' && env[key])
}

/** RFC 2047 encode a header value when it contains non-ASCII characters. */
export function encodeMimeHeader(value) {
  // A raw CR/LF inside a header value is header injection, so flatten first.
  const raw = (value == null ? '' : String(value)).replace(/[\r\n]+/g, ' ')
  if (!/[^\x20-\x7E]/.test(raw)) return raw
  const words = []
  let part = ''
  for (const ch of raw) {
    const next = part + ch
    // 45 bytes of UTF-8 stays under the 76-column encoded-word limit.
    if (Buffer.byteLength(next, 'utf8') > 45) {
      if (part) words.push(part)
      part = ch
    } else {
      part = next
    }
  }
  if (part) words.push(part)
  return words.map((word) => '=?UTF-8?B?' + Buffer.from(word, 'utf8').toString('base64') + '?=').join(' ')
}

/** Encode an address, keeping "Name <addr>" shape when a display name is used. */
export function encodeAddress(value) {
  const raw = String(value == null ? '' : value).replace(/[\r\n]+/g, ' ').trim()
  if (!raw) return ''
  if (!/[^\x20-\x7E]/.test(raw)) return raw
  const named = /^(.*)<([^>]+)>\s*$/.exec(raw)
  if (named) {
    const label = named[1].trim()
    return (label ? encodeMimeHeader(label) + ' ' : '') + '<' + named[2].trim() + '>'
  }
  return raw
}

/** base64 the body and wrap it at 76 columns (RFC 2045). */
export function base64Body(text) {
  const encoded = Buffer.from(String(text == null ? '' : text), 'utf8').toString('base64')
  const lines = []
  for (let i = 0; i < encoded.length; i += 76) lines.push(encoded.slice(i, i + 76))
  return lines.join('\r\n')
}

/** SMTP dot-stuffing: a line starting with '.' must be doubled in DATA. */
export function dotStuff(text) {
  return String(text == null ? '' : text).replace(/^\./gm, '..')
}

/**
 * Build the complete RFC 5322 message for one trigger. Returns { ok: false,
 * error } when the address side is incomplete, so the caller can record a
 * precise history entry without opening a socket.
 */
export function buildMailMessage(emailInput, values = {}, now = Date.now()) {
  const email = normalizeEmail(emailInput)
  const to = parseAddressList(email.to)
  const from = email.from || email.user
  if (!from) return { ok: false, error: '发件人为空：请在设置里填写发件地址（多数邮箱要求与登录账号一致）' }
  if (!to.length) return { ok: false, error: '收件人为空：请在设置里填写收件地址' }
  const subject = applyPlaceholders(email.subject || DEFAULT_MAIL_SUBJECT, values)
  const bodyText = applyPlaceholders(email.body || DEFAULT_MAIL_BODY, values)
  const date = new Date(now)
  const messageId = '<' + now.toString(36) + '-' + Math.random().toString(36).slice(2, 10) + '@dsh-notify-hub>'
  const headers = [
    'From: ' + encodeAddress(from),
    'To: ' + to.map(encodeAddress).join(', '),
    'Subject: ' + encodeMimeHeader(subject),
    'Date: ' + date.toUTCString(),
    'Message-ID: ' + messageId,
    'MIME-Version: 1.0',
    'Content-Type: text/plain; charset=UTF-8',
    'Content-Transfer-Encoding: base64',
    'X-Mailer: dsh-notify-hub',
  ]
  const data = headers.join('\r\n') + '\r\n\r\n' + dotStuff(base64Body(bodyText))
  return {
    ok: true,
    from,
    to,
    subject,
    body: bodyText,
    messageId,
    data,
  }
}

/**
 * Turn an SMTP stage + server reply into a history verdict. The wording matters:
 * the settings page shows it verbatim, and "认证失败" is the one cause users can
 * actually fix without reading server logs.
 */
export function classifySmtpError(stage, code, reply) {
  const detail = String(reply == null ? '' : reply).trim()
  const suffix = detail ? '：' + detail : ''
  if (stage === 'auth') return { status: 'failed', message: '认证失败，请检查邮箱授权码' + suffix }
  if (stage === 'rcpt') return { status: 'failed', message: '收件人被拒' + suffix }
  if (stage === 'connect' || stage === 'greeting') return { status: 'failed', message: '连接邮件服务器失败' + suffix }
  if (stage === 'tls') return { status: 'failed', message: 'TLS 握手失败' + suffix }
  return { status: 'failed', message: '投递失败（' + (stage || 'smtp') + '）' + suffix }
}

// --- presence ----------------------------------------------------------------

/**
 * Fold the last client heartbeat into a state:
 * closed (no page / stale) | hidden | visible-blurred | visible-focused.
 */
export function presenceOf(last, now = Date.now(), staleMs = PRESENCE_STALE_MS) {
  const at = isPlainObject(last) && typeof last.at === 'number' ? last.at : 0
  if (!at || now - at > staleMs) return { state: 'closed', lastSeenAt: at || null, visible: false, focused: false }
  const visible = last.visible === true
  const focused = last.focused === true
  const state = !visible ? 'hidden' : (focused ? 'visible-focused' : 'visible-blurred')
  return { state, lastSeenAt: at, visible, focused }
}

/** Does the rule's precondition allow firing under this presence state? */
export function allowsByPrecondition(precondition, presence) {
  const state = (presence && presence.state) || 'closed'
  if (precondition === PRECONDITION.pageClosed) return state === 'closed'
  if (precondition === PRECONDITION.pageHidden) return state !== 'visible-focused'
  return true
}

// --- debounce / failures / history -------------------------------------------

export function isDebounced(lastFireAt, now = Date.now(), debounceMs = DEFAULT_DEBOUNCE_MS) {
  return typeof lastFireAt === 'number' && now - lastFireAt < Math.max(0, debounceMs)
}

export function registerFailure(runtime, now = Date.now(), limit = FAILURE_LIMIT) {
  const base = isPlainObject(runtime) ? runtime : {}
  const consecutiveFailures = (typeof base.consecutiveFailures === 'number' ? base.consecutiveFailures : 0) + 1
  const autoDisabled = consecutiveFailures >= limit
  const next = Object.assign({}, base, { consecutiveFailures, autoDisabled })
  if (autoDisabled) {
    next.autoDisabledAt = now
    next.autoDisabledReason = '连续失败 ' + consecutiveFailures + ' 次'
  }
  return next
}

export function registerSuccess(runtime) {
  const base = isPlainObject(runtime) ? runtime : {}
  return Object.assign({}, base, {
    consecutiveFailures: 0,
    autoDisabled: false,
    autoDisabledAt: null,
    autoDisabledReason: null,
  })
}

export function makeHistoryEntry(input = {}) {
  return {
    id: input.id || newRuleId(input.startedAt || Date.now(), () => 0.5),
    ruleId: input.ruleId || null,
    ruleName: input.ruleName || null,
    trigger: input.trigger || null,
    detail: input.detail || null,
    sessionId: input.sessionId || null,
    sessionTitle: input.sessionTitle == null ? null : input.sessionTitle,
    startedAt: typeof input.startedAt === 'number' ? input.startedAt : Date.now(),
    durationMs: typeof input.durationMs === 'number' ? input.durationMs : null,
    status: input.status || 'ok',
    exitCode: typeof input.exitCode === 'number' ? input.exitCode : null,
    signal: input.signal || null,
    envKeys: Array.isArray(input.envKeys) ? input.envKeys.map(String) : [],
    test: input.test === true,
    error: input.error || null,
    note: input.note || null,
    stdout: input.stdout || '',
    stderr: input.stderr || '',
  }
}

export function pushHistory(entries, entry, limit = HISTORY_LIMIT) {
  return [entry].concat(Array.isArray(entries) ? entries : []).slice(0, limit)
}

/** Statuses that count as a failure for the auto-disable counter. */
export function isFailureStatus(status) {
  return status === 'failed' || status === 'timeout' || status === 'error'
}

export function emptyState() {
  return { version: 1, runtime: {}, entries: [] }
}

export function normalizeState(input) {
  const src = isPlainObject(input) ? input : {}
  return {
    version: 1,
    runtime: isPlainObject(src.runtime) ? src.runtime : {},
    entries: Array.isArray(src.entries) ? src.entries.filter(isPlainObject).slice(0, HISTORY_LIMIT) : [],
  }
}

export { path }
