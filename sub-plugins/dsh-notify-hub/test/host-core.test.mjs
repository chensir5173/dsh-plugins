// Tests for dsh-notify-hub/src/host-core.js (pure logic) plus a real-process
// check of the executor in src/index.js — including the parts I cannot verify by
// hand on a Windows machine.
//
// Run: node sub-plugins/dsh-notify-hub/test/host-core.test.mjs
import assert from 'node:assert/strict'
import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath } from 'node:url'
import * as core from '../src/host-core.js'
import { spawnOnce, fallbackSectionSchema } from '../src/index.js'

const here = path.dirname(fileURLToPath(import.meta.url))
const fixtures = path.join(here, 'fixtures')
const failures = []
let passed = 0

function check(name, fn) {
  try {
    fn()
    passed += 1
    console.log('  ok   ' + name)
  } catch (e) {
    failures.push(name + ': ' + ((e && e.message) || String(e)))
    console.log('  FAIL ' + name + ' → ' + ((e && e.message) || String(e)))
  }
}

let skipped = 0

// The DSH agent sandbox denies spawning *any* child process ("spawn EPERM"), so a
// real executor run cannot happen inside this environment. The same test does run
// for real on a plain terminal, so a sandbox rejection is reported as SKIP — never
// as a silent pass, and never as a failure of the code under test.
const SANDBOX_DENIED = /spawn EPERM|EPERM|EACCES/
function sandboxDenied(result) {
  return Boolean(result) && result.status === 'error' && SANDBOX_DENIED.test(String(result.error || ''))
}

async function checkAsync(name, fn) {
  try {
    const outcome = await fn()
    if (outcome === 'sandbox-skip') {
      skipped += 1
      console.log('  SKIP ' + name + ' → 当前沙箱禁止派生子进程（spawn EPERM）；普通终端下会真正执行')
      return
    }
    passed += 1
    console.log('  ok   ' + name)
  } catch (e) {
    failures.push(name + ': ' + ((e && e.message) || String(e)))
    console.log('  FAIL ' + name + ' → ' + ((e && e.message) || String(e)))
  }
}

// --- interpreter selection ---------------------------------------------------

check('interpreter: .py is python3 off Windows and python on Windows', () => {
  assert.equal(core.interpreterFor('/x/a.py', 'darwin').command, 'python3')
  assert.equal(core.interpreterFor('/x/a.py', 'win32').command, 'python')
})

check('interpreter: bat/cmd/ps1/sh/plain-executable mapping', () => {
  assert.deepEqual(core.interpreterFor('C:/x/a.bat', 'win32'), { command: 'cmd', prefix: ['/c'] })
  assert.deepEqual(core.interpreterFor('a.cmd', 'win32'), { command: 'cmd', prefix: ['/c'] })
  assert.equal(core.interpreterFor('a.ps1', 'win32').command, 'powershell')
  assert.equal(core.interpreterFor('a.sh', 'darwin').command, 'bash')
  assert.equal(core.interpreterFor('/usr/local/bin/terminal-notifier', 'darwin'), null)
  assert.equal(core.interpreterFor('', 'darwin'), null)
})

// --- command construction ----------------------------------------------------

check('buildCommand: argv array, no shell, spaces preserved', () => {
  const plan = core.buildCommand(
    { command: '/Users/me/My Scripts/notify.sh', args: ['--title', 'he said "hi"'], shell: false, interpreter: '' },
    {},
    { home: '/Users/me', platform: 'darwin' },
  )
  assert.equal(plan.ok, true)
  assert.equal(plan.shell, false)
  assert.equal(plan.command, 'bash')
  assert.deepEqual(plan.args, ['/Users/me/My Scripts/notify.sh', '--title', 'he said "hi"'])
})

check('buildCommand: explicit interpreter overrides the extension', () => {
  const plan = core.buildCommand({ command: '/x/a.txt', args: [], interpreter: '/opt/py/bin/python3', shell: false }, {}, { home: '/h', platform: 'darwin' })
  assert.equal(plan.command, '/opt/py/bin/python3')
  assert.deepEqual(plan.args, ['/x/a.txt'])
})

check('buildCommand: an extension-less executable runs directly', () => {
  const plan = core.buildCommand({ command: '/usr/local/bin/notify', args: ['-m', 'done'], shell: false }, {}, { home: '/h', platform: 'darwin' })
  assert.equal(plan.command, '/usr/local/bin/notify')
  assert.deepEqual(plan.args, ['-m', 'done'])
  assert.equal(plan.shell, false)
})

check('buildCommand: the shell escape hatch joins everything into one line', () => {
  const plan = core.buildCommand({ command: '/tmp/my script.sh', args: ['--to', 'a b'], shell: true }, {}, { home: '/h', platform: 'darwin' })
  assert.equal(plan.shell, true)
  assert.deepEqual(plan.args, [])
  assert.ok(plan.command.includes("'/tmp/my script.sh'"), 'the script path stays one quoted word')
  assert.ok(plan.command.includes("'a b'"), 'an argument containing a space gets quoted')
  assert.ok(plan.command.includes('--to'), 'a plain argument passes through unquoted')
})

check('buildCommand: ~ expansion and placeholders', () => {
  const plan = core.buildCommand(
    { command: '~/bin/notify.sh', args: ['{cwd}', 'reason={reason}'], shell: false },
    { cwd: '/proj/x', reason: 'turn-end' },
    { home: '/Users/me', platform: 'darwin' },
  )
  assert.equal(plan.args[0], '/Users/me/bin/notify.sh')
  assert.deepEqual(plan.args.slice(1), ['/proj/x', 'reason=turn-end'])
})

check('buildCommand: an empty command is refused', () => {
  assert.equal(core.buildCommand({ command: '   ' }, {}, {}).ok, false)
})

check('splitInterpreterCommand: 「解释器 + 路径」写在一格时被拆开并说明', () => {
  const broken = 'python3.11\n  /Users/x/examples/notify-popo.py'
  const split = core.splitInterpreterCommand(broken)
  assert.equal(split.command, '/Users/x/examples/notify-popo.py')
  assert.equal(split.interpreter, 'python3.11')
  assert.match(split.note, /解释器/)
  assert.deepEqual(core.splitInterpreterCommand('/x/a.py'), { command: '/x/a.py', note: null, interpreter: '' })
})

check('buildCommand: 破损写法也能正确跑（复现过 exit 2 的那个形状）', () => {
  const rule = core.normalizeRule({ command: 'python3.11\n  /Users/x/notify-popo.py', interpreter: '' })
  const plan = core.buildCommand(rule, {}, { home: '/Users/x', platform: 'darwin' })
  assert.equal(plan.command, 'python3.11')
  assert.deepEqual(plan.args, ['/Users/x/notify-popo.py'])
  assert.match(plan.note, /已按/)
  const normal = core.buildCommand(core.normalizeRule({ command: '/Users/x/notify-popo.py' }), {}, { home: '/Users/x', platform: 'darwin' })
  assert.equal(normal.command, 'python3')
  assert.deepEqual(normal.args, ['-u', '/Users/x/notify-popo.py'])
  assert.equal(normal.note, null)
})

check('validateRule: 多行命令被拒并说明怎么改', () => {
  const out = core.validateRule({ command: 'python3.11\n/x/a.py' }, { exists: () => true })
  assert.equal(out.ok, false)
  assert.match(out.errors.join(' '), /换行/)
  assert.equal(core.validateRule({ command: '/x/a.py' }, { exists: () => true }).ok, true)
})

check('历史条目保留 note（用于解释自动纠正）', () => {
  assert.equal(core.makeHistoryEntry({ ruleId: 'r', note: '已按…执行' }).note, '已按…执行')
  assert.equal(core.makeHistoryEntry({}).note, null)
})

check('turnEndReasonOf: reason 在 event.data 里（真实信封形状）', () => {
  const real = { type: 'turn/end', seq: 9, time: 1789914127000, data: { turn: 10, reason: { kind: 'completed' } } }
  assert.deepEqual(core.turnEndReasonOf(real), { kind: 'completed' })
  assert.equal(core.shouldFireOnTurnEnd(core.turnEndReasonOf(real)), true, '真实信封必须能触发')
  const aborted = { type: 'turn/end', data: { turn: 11, reason: { kind: 'aborted', reason: { kind: 'user' } } } }
  assert.equal(core.shouldFireOnTurnEnd(core.turnEndReasonOf(aborted)), false)
  // 兼容旧的平铺形状 + 各种垃圾输入
  assert.deepEqual(core.turnEndReasonOf({ type: 'turn/end', reason: { kind: 'error' } }), { kind: 'error' })
  assert.equal(core.turnEndReasonOf({ type: 'turn/end' }), null)
  assert.equal(core.turnEndReasonOf(null), null)
  assert.equal(core.shouldFireOnTurnEnd(core.turnEndReasonOf({ type: 'turn/end' })), false)
})

// --- trigger matrix ----------------------------------------------------------

check('turn-end matrix: the four "the turn ended, you are needed" reasons fire', () => {
  for (const kind of ['completed', 'blocked', 'error', 'max-tokens']) {
    assert.equal(core.shouldFireOnTurnEnd({ kind }), true, kind)
  }
})

check('turn-end matrix: your own Stop and a disposed session stay silent', () => {
  assert.equal(core.shouldFireOnTurnEnd({ kind: 'aborted', reason: { kind: 'user' } }), false)
  assert.equal(core.shouldFireOnTurnEnd({ kind: 'aborted', reason: { kind: 'disposed' } }), false)
})

check('turn-end matrix: other aborts still notify', () => {
  assert.equal(core.shouldFireOnTurnEnd({ kind: 'aborted', reason: { kind: 'parent' } }), true)
  assert.equal(core.shouldFireOnTurnEnd({ kind: 'aborted', reason: { kind: 'hook' } }), true)
  assert.equal(core.shouldFireOnTurnEnd({ kind: 'aborted' }), true)
})

check('turn-end matrix: interrupted and unknown reasons never fire', () => {
  assert.equal(core.shouldFireOnTurnEnd({ kind: 'interrupted' }), false)
  assert.equal(core.shouldFireOnTurnEnd({ kind: 'whatever' }), false)
  assert.equal(core.shouldFireOnTurnEnd(null), false)
  assert.equal(core.shouldFireOnTurnEnd(undefined), false)
})

check('turnEndKind flattens the abort cause', () => {
  assert.equal(core.turnEndKind({ kind: 'aborted', reason: { kind: 'user' } }), 'aborted:user')
  assert.equal(core.turnEndKind({ kind: 'completed' }), 'completed')
})

check('ruleListensTo honours the per-rule trigger flags', () => {
  const rule = { triggers: { turnEnd: false, approval: true, question: false } }
  assert.equal(core.ruleListensTo(rule, core.TRIGGER.turnEnd, { kind: 'completed' }), false)
  assert.equal(core.ruleListensTo(rule, core.TRIGGER.approval, null), true)
  assert.equal(core.ruleListensTo(rule, core.TRIGGER.question, null), false)
  const all = { triggers: { turnEnd: true, approval: true, question: true } }
  assert.equal(core.ruleListensTo(all, core.TRIGGER.turnEnd, { kind: 'completed' }), true)
  assert.equal(core.ruleListensTo(all, core.TRIGGER.turnEnd, { kind: 'aborted', reason: { kind: 'user' } }), false)
})

// --- context handed to the script --------------------------------------------

check('context: payload carries the documented fields', () => {
  const built = core.buildTriggerContext({
    rule: { id: 'r1', name: '通知' },
    sessionId: 'session-1',
    sessionTitle: '修复登录',
    cwd: '/proj/app',
    trigger: core.TRIGGER.turnEnd,
    detail: 'completed',
    now: 1700000000000,
  })
  assert.equal(built.payload.sessionId, 'session-1')
  assert.equal(built.payload.sessionTitle, '修复登录')
  assert.equal(built.payload.cwd, '/proj/app')
  assert.equal(built.payload.reason, 'turn-end')
  assert.equal(built.payload.reasonDetail, 'completed')
  assert.equal(built.payload.triggeredAt, new Date(1700000000000).toISOString())
  assert.equal(built.payload.ruleId, 'r1')
  assert.equal(built.payload.ruleName, '通知')
})

check('context: no conversation body is handed to the script', () => {
  const built = core.buildTriggerContext({
    rule: { id: 'r1', name: 'x' },
    sessionId: 's',
    sessionTitle: 't',
    cwd: '/c',
    trigger: core.TRIGGER.approval,
    detail: null,
    now: 1700000000000,
  })
  const keys = Object.keys(built.payload).join(',')
  for (const forbidden of ['messages', 'text', 'reply', 'content', 'transcript', 'lastMessage']) {
    assert.equal(keys.indexOf(forbidden), -1, 'payload must not carry ' + forbidden)
  }
})

check('context: env mirrors stay ASCII and never carry the title', () => {
  const built = core.buildTriggerContext({
    rule: { id: '规则一', name: 'x' },
    sessionId: 'session-1',
    sessionTitle: '修复登录',
    cwd: '/proj/app',
    trigger: core.TRIGGER.approval,
    detail: null,
    now: 1700000000000,
  })
  assert.equal(built.env.NOTIFY_HUB_SESSION_ID, 'session-1')
  assert.equal(built.env.NOTIFY_HUB_REASON, 'approval')
  assert.equal(built.env.NOTIFY_HUB_CWD, '/proj/app')
  assert.equal(built.env.NOTIFY_HUB_RULE_ID, '???', 'a non-ASCII rule id is sanitised')
  assert.equal(Object.prototype.hasOwnProperty.call(built.env, 'NOTIFY_HUB_TITLE'), false)
  for (const key of Object.keys(built.env)) {
    for (const ch of String(built.env[key])) assert.ok(ch.charCodeAt(0) < 127, key + ' must stay ASCII')
  }
})

check('placeholderValues exposes the documented names', () => {
  const values = core.placeholderValues(
    {
      sessionId: 's',
      sessionTitle: 't',
      cwd: '/c',
      reason: 'turn-end',
      reasonDetail: 'completed',
      triggeredAt: '2026-11-12T05:00:00.000Z',
    },
    { id: 'r', name: 'R' },
  )
  assert.deepEqual(values, {
    sessionId: 's',
    title: 't',
    cwd: '/c',
    reason: 'turn-end',
    detail: 'completed',
    rule: 'R',
    time: '2026-11-12T05:00:00.000Z',
  })
})

check('applyPlaceholders leaves unknown braces alone', () => {
  assert.equal(core.applyPlaceholders('a {cwd} {nope}', { cwd: '/x' }), 'a /x {nope}')
})

// --- presence ----------------------------------------------------------------

check('presence: no heartbeat (or a stale one) means the page is closed', () => {
  assert.equal(core.presenceOf(null, 1000).state, 'closed')
  assert.equal(core.presenceOf({ at: 1000, visible: true, focused: true }, 1000 + core.PRESENCE_STALE_MS + 1).state, 'closed')
})

check('presence: visible-focused / visible-blurred / hidden', () => {
  assert.equal(core.presenceOf({ at: 1000, visible: true, focused: true }, 1100).state, 'visible-focused')
  assert.equal(core.presenceOf({ at: 1000, visible: true, focused: false }, 1100).state, 'visible-blurred')
  assert.equal(core.presenceOf({ at: 1000, visible: false, focused: false }, 1100).state, 'hidden')
})

check('preconditions: any / page-closed / page-hidden-or-blurred', () => {
  const focused = { state: 'visible-focused' }
  const blurred = { state: 'visible-blurred' }
  const closed = { state: 'closed' }
  assert.equal(core.allowsByPrecondition('any', focused), true)
  assert.equal(core.allowsByPrecondition('page-closed', focused), false)
  assert.equal(core.allowsByPrecondition('page-closed', closed), true)
  assert.equal(core.allowsByPrecondition('page-hidden-or-blurred', focused), false)
  assert.equal(core.allowsByPrecondition('page-hidden-or-blurred', blurred), true)
  assert.equal(core.allowsByPrecondition('page-hidden-or-blurred', closed), true)
})

// --- debounce / failures / history -------------------------------------------

check('debounce window', () => {
  assert.equal(core.isDebounced(1000, 1500, 3000), true)
  assert.equal(core.isDebounced(1000, 4500, 3000), false)
  assert.equal(core.isDebounced(undefined, 1500, 3000), false)
})

check('three consecutive failures auto-disable; a success clears the counter', () => {
  let runtime = {}
  runtime = core.registerFailure(runtime, 1)
  assert.equal(runtime.autoDisabled, false)
  runtime = core.registerFailure(runtime, 2)
  assert.equal(runtime.autoDisabled, false)
  runtime = core.registerFailure(runtime, 3)
  assert.equal(runtime.autoDisabled, true)
  assert.equal(runtime.consecutiveFailures, 3)
  assert.equal(typeof runtime.autoDisabledAt, 'number')
  runtime = core.registerSuccess(runtime)
  assert.equal(runtime.autoDisabled, false)
  assert.equal(runtime.consecutiveFailures, 0)
})

check('only real failures count as failures', () => {
  assert.equal(core.isFailureStatus('failed'), true)
  assert.equal(core.isFailureStatus('timeout'), true)
  assert.equal(core.isFailureStatus('error'), true)
  assert.equal(core.isFailureStatus('ok'), false)
  assert.equal(core.isFailureStatus('skipped'), false)
})

check('history rolls at the limit, newest first', () => {
  let entries = []
  for (let i = 0; i < core.HISTORY_LIMIT + 5; i += 1) {
    entries = core.pushHistory(entries, core.makeHistoryEntry({ ruleId: 'r', startedAt: i }))
  }
  assert.equal(entries.length, core.HISTORY_LIMIT)
  assert.equal(entries[0].startedAt, core.HISTORY_LIMIT + 4)
})

check('tailText keeps only the tail', () => {
  const text = Array.from({ length: 50 }, (_, i) => 'line' + i).join('\n')
  assert.equal(core.tailText(text, 3, 1000), 'line47\nline48\nline49')
})

// --- config shaping ----------------------------------------------------------

check('normalizeRule applies defaults and clamps', () => {
  const rule = core.normalizeRule({ name: '  x  ', debounceMs: -5, timeoutMs: 99999999 })
  assert.equal(rule.name, 'x')
  assert.equal(rule.enabled, false)
  assert.equal(rule.debounceMs, 0)
  assert.equal(rule.timeoutMs, 3600000)
  assert.equal(rule.precondition, 'any')
  assert.deepEqual(rule.triggers, { turnEnd: true, approval: true, question: true })
  assert.match(rule.id, /^rule-/)
})

check('normalizeConfig defaults the master switch on and the rule list empty', () => {
  assert.deepEqual(core.normalizeConfig(null), { enabled: true, seeded: false, env: {}, rules: [] })
  assert.equal(core.normalizeConfig({ enabled: false }).enabled, false)
  assert.equal(core.normalizeConfig({ rules: [{ command: '/x' }] }).rules.length, 1)
})

check('validateRule catches empty, unsatisfiable and missing-file cases', () => {
  assert.equal(core.validateRule({ command: '' }).ok, false)
  assert.equal(core.validateRule({ command: '/x', triggers: { turnEnd: false, approval: false, question: false } }).ok, false)
  const missing = core.validateRule({ command: '/nope/notify.sh' }, { exists: () => false })
  assert.equal(missing.ok, false)
  assert.match(missing.errors.join(' '), /不存在/)
  assert.equal(core.validateRule({ command: '/x/notify.sh' }, { exists: () => true }).ok, true)
})

check('sampleRule ships disabled, precondition any, pointing at examples/', () => {
  const sample = core.sampleRule('/repo/dsh-notify-hub', 'darwin')
  assert.equal(sample.enabled, false, '示例规则默认关闭，用户要自己启用')
  assert.equal(
    sample.precondition,
    'any',
    'page-closed 会让用户在提问/等待批准（此时页面必然开着）时永远收不到通知',
  )
  assert.match(sample.command, /dsh-notify-hub[\\/]examples[\\/]notify-macos\.sh$/)
  assert.equal(core.sampleRule('/repo/dsh-notify-hub', 'win32').command.endsWith('notify-windows.ps1'), true)
})

check('the fallback schema always admits the config shape', () => {
  const schema = fallbackSectionSchema()
  assert.deepEqual(schema(null), { enabled: true, seeded: false, env: {}, rules: [] })
  const out = schema({ enabled: false, seeded: true, rules: [{ id: 'a' }] })
  assert.equal(out.enabled, false)
  assert.equal(out.seeded, true)
  assert.equal(out.rules.length, 1)
  assert.equal(schema.toJSON().type, 'object')
})

// --- environment variables ---------------------------------------------------
check('normalizeEnv accepts an object or KEY=VALUE lines', () => {
  assert.deepEqual(core.normalizeEnv({ A: '1', B: 2, 'bad name': 'x', '1N': 'y' }), { A: '1', B: '2' })
  assert.deepEqual(core.normalizeEnv(['A=1', '', '# comment', 'B=two words', 'NOPE']), { A: '1', 'B': 'two words' })
  assert.deepEqual(core.normalizeEnv(null), {})
})

check('parseEnvText / formatEnvText round-trip', () => {
  assert.deepEqual(core.parseEnvText('A=1\n# skip\n\nB=2'), [['A', '1'], ['B', '2']])
  assert.equal(core.formatEnvText({ A: '1', B: '2' }), 'A=1\nB=2')
  assert.equal(core.formatEnvText(null), '')
})

check('validateEnv: errors for bad lines, warnings for contract/duplicates', () => {
  const bad = core.validateEnv(['NO_EQUALS', '1BAD=x'])
  assert.equal(bad.errors.length, 2)
  assert.equal(bad.warnings.length, 0)
  const warn = core.validateEnv(['NOTIFY_HUB_REASON=fake', 'A=1', 'A=2'])
  assert.equal(warn.errors.length, 0)
  assert.equal(warn.warnings.length, 2)
  assert.match(warn.warnings.join(' '), /NOTIFY_HUB_/)
  assert.equal(core.validateEnv({ NOTIFY_HUB_CWD: '/fake' }).warnings.length, 1)
})

check('mergeEnv precedence: base < global < rule < NOTIFY_HUB_* contract', () => {
  const merged = core.mergeEnv(
    { PATH: '/bin', KEEP: 'base' },
    { KEEP: 'global', GLOBAL_ONLY: 'g', NOTIFY_HUB_REASON: 'nope' },
    { KEEP: 'rule', NOTIFY_HUB_SESSION_ID: 'nope', RULE_ONLY: 'r' },
    { NOTIFY_HUB_REASON: 'approval', NOTIFY_HUB_SESSION_ID: 'session-1' },
  )
  assert.equal(merged.KEEP, 'rule')
  assert.equal(merged.GLOBAL_ONLY, 'g')
  assert.equal(merged.RULE_ONLY, 'r')
  assert.equal(merged.PATH, '/bin')
  assert.equal(merged.NOTIFY_HUB_REASON, 'approval', 'the contract always wins')
  assert.equal(merged.NOTIFY_HUB_SESSION_ID, 'session-1')
})

check('applyEnvPlaceholders substitutes values only', () => {
  assert.deepEqual(
    core.applyEnvPlaceholders({ DIR: '{cwd}', T: '{title}', K: 'literal' }, { cwd: '/proj', title: '修 bug' }),
    { DIR: '/proj', T: '修 bug', K: 'literal' },
  )
})

check('normalizeRule and normalizeConfig carry env', () => {
  assert.deepEqual(core.normalizeRule({ command: '/x', env: { A: '1', 'bad key': 'x' } }).env, { A: '1' })
  const cfg = core.normalizeConfig({ env: { G: '1' }, rules: [{ command: '/x', env: ['B=2'] }] })
  assert.deepEqual(cfg.env, { G: '1' })
  assert.deepEqual(cfg.rules[0].env, { B: '2' })
  assert.deepEqual(core.defaultConfig().env, {})
})

check('validateRule surfaces env problems and warnings', () => {
  const bad = core.validateRule({ command: '/x', env: ['BROKEN'] }, { exists: () => true })
  assert.equal(bad.ok, false)
  assert.match(bad.errors.join(' '), /缺少等号/)
  const warn = core.validateRule({ command: '/x', env: { NOTIFY_HUB_REASON: 'x' } }, { exists: () => true })
  assert.equal(warn.ok, true)
  assert.equal(warn.warnings.length, 1)
})

check('the history entry keeps env keys but never values', () => {
  const entry = core.makeHistoryEntry({ ruleId: 'r', envKeys: ['NOTIFY_ACCESS_KEY', 'MAIL_RECEIVER'] })
  assert.deepEqual(entry.envKeys, ['NOTIFY_ACCESS_KEY', 'MAIL_RECEIVER'])
  assert.deepEqual(core.makeHistoryEntry({}).envKeys, [])
})

// --- executor (real child processes) -----------------------------------------

const tmp = fs.mkdtempSync(path.join(here, '.tmp-'))
const outFile = path.join(tmp, 'out.json')

await checkAsync('executor runs a real script with stdin JSON + env mirrors', async () => {
  const plan = core.buildCommand(
    { command: path.join(fixtures, 'probe.mjs'), args: [outFile], shell: false, interpreter: '' },
    {},
    { home: os.homedir() },
  )
  const built = core.buildTriggerContext({
    rule: { id: 'r9', name: 'R' },
    sessionId: 'session-9',
    sessionTitle: 't',
    cwd: tmp,
    trigger: 'turn-end',
    detail: 'completed',
  })
  const result = await spawnOnce(plan, {
    cwd: tmp,
    env: Object.assign({}, process.env, built.env),
    stdin: JSON.stringify(built.payload),
    timeoutMs: 15000,
  })
  if (sandboxDenied(result)) return 'sandbox-skip'
  assert.equal(result.status, 'ok', JSON.stringify(result))
  assert.equal(result.exitCode, 0)
  assert.equal(result.stdout, 'probe done')
  const recorded = JSON.parse(fs.readFileSync(outFile, 'utf8'))
  const payload = JSON.parse(recorded.stdin)
  assert.equal(payload.sessionId, 'session-9')
  assert.equal(payload.reasonDetail, 'completed')
  assert.equal(recorded.reason, 'turn-end')
  assert.equal(recorded.session, 'session-9')
  assert.equal(recorded.cwdMarker, tmp)
})

await checkAsync('executor hands the merged env to the script (contract beats a rule key)', async () => {
  const out2 = path.join(tmp, 'env.json')
  const plan = core.buildCommand({ command: path.join(fixtures, 'probe.mjs'), args: [out2], shell: false }, {}, { home: os.homedir() })
  const built = core.buildTriggerContext({
    rule: { id: 'r-env', name: 'R' },
    sessionId: 'session-env',
    sessionTitle: 't',
    cwd: tmp,
    trigger: 'turn-end',
    detail: 'completed',
  })
  const merged = core.mergeEnv(
    {},
    { GLOBAL_ONLY: 'g', SHARED: 'global' },
    { RULE_ONLY: 'r', SHARED: 'rule', NOTIFY_HUB_REASON: 'fake' },
    built.env,
  )
  const result = await spawnOnce(plan, { cwd: tmp, env: merged, stdin: JSON.stringify(built.payload), timeoutMs: 15000 })
  if (sandboxDenied(result)) return 'sandbox-skip'
  assert.equal(result.status, 'ok', JSON.stringify(result))
  const seen = JSON.parse(fs.readFileSync(out2, 'utf8'))
  assert.equal(seen.globalOnly, 'g', 'the global env reaches the script')
  assert.equal(seen.ruleOnly, 'r', 'the rule env reaches the script')
  assert.equal(seen.reason, 'turn-end', 'the NOTIFY_HUB_* contract beats the rule value')
})

await checkAsync('executor kills a script that overruns the timeout', async () => {
  const plan = core.buildCommand({ command: path.join(fixtures, 'sleeper.mjs'), args: [], shell: false }, {}, { home: os.homedir() })
  const result = await spawnOnce(plan, { cwd: tmp, env: process.env, stdin: '', timeoutMs: 700 })
  if (sandboxDenied(result)) return 'sandbox-skip'
  assert.equal(result.status, 'timeout')
})

await checkAsync('executor reports a non-zero exit as failed and keeps stderr', async () => {
  const plan = core.buildCommand({ command: path.join(fixtures, 'failer.mjs'), args: [], shell: false }, {}, { home: os.homedir() })
  const result = await spawnOnce(plan, { cwd: tmp, env: process.env, stdin: '', timeoutMs: 15000 })
  if (sandboxDenied(result)) return 'sandbox-skip'
  assert.equal(result.status, 'failed')
  assert.equal(result.exitCode, 3)
  assert.equal(result.stderr, 'boom')
})

await checkAsync('executor reports a missing interpreter as a spawn error', async () => {
  const plan = core.buildCommand(
    { command: path.join(tmp, 'nope.py'), args: [], shell: false, interpreter: 'definitely-not-a-real-interpreter-xyz' },
    {},
    { home: os.homedir() },
  )
  const result = await spawnOnce(plan, { cwd: tmp, env: process.env, stdin: '', timeoutMs: 5000 })
  assert.equal(result.status, 'error')
  assert.match(String(result.error), /spawn/)
})

check('示例 Windows 脚本必须带 UTF-8 BOM：PS 5.1 把无 BOM 的 .ps1 按 ANSI 解码，中文注释会撑坏引号 ⇒ ParserError', () => {
  const dir = path.join(here, '..', 'examples')
  const scripts = fs.readdirSync(dir).filter((name) => name.endsWith('.ps1'))
  assert.ok(scripts.length > 0, '示例目录里至少要有一个 .ps1')
  for (const name of scripts) {
    const head = fs.readFileSync(path.join(dir, name)).subarray(0, 3)
    assert.deepEqual([...head], [0xEF, 0xBB, 0xBF], name + ' 缺少 UTF-8 BOM（PS 5.1 会按 ANSI 解码）')
  }
})


// --- email channel (pure config + MIME assembly) ------------------------------

check('email: defaultEmail fills the template fields the settings UI edits', () => {
  const email = core.defaultEmail()
  assert.equal(email.port, 465)
  assert.equal(email.secure, true)
  assert.equal(email.starttls, true)
  assert.equal(email.allowInsecureTls, false)
  assert.equal(email.subject, core.DEFAULT_MAIL_SUBJECT)
  assert.equal(email.body, core.DEFAULT_MAIL_BODY)
})

check('email: provider presets carry the right host/port/security', () => {
  assert.equal(core.emailProvider('qq').host, 'smtp.qq.com')
  assert.equal(core.emailProvider('qq').port, 465)
  assert.equal(core.emailProvider('qq').secure, true)
  assert.equal(core.emailProvider('outlook').port, 587)
  assert.equal(core.emailProvider('outlook').secure, false)
  // 未知 id 落回自定义，不要抛
  assert.equal(core.emailProvider('nope').id, 'custom')
})

check('email: normalizeEmail clamps the port and falls back to the default templates', () => {
  const a = core.normalizeEmail({ host: 'h', port: '587', subject: '', body: '' })
  assert.equal(a.port, 587)
  assert.equal(a.subject, core.DEFAULT_MAIL_SUBJECT)
  assert.equal(a.body, core.DEFAULT_MAIL_BODY)
  assert.equal(core.normalizeEmail({ port: 0 }).port, 1)
  assert.equal(core.normalizeEmail({ port: 99999 }).port, 65535)
  assert.equal(core.normalizeEmail({ secure: 'yes' }).secure, false, 'only a real true enables implicit TLS')
})

check('email: validateEmailConfig names every missing piece the user must fix', () => {
  const base = { host: 'smtp.qq.com', to: 'me@qq.com', from: 'me@qq.com', pass: 'x' }
  assert.deepEqual(core.validateEmailConfig(base), [])
  assert.match(core.validateEmailConfig(Object.assign({}, base, { host: '' })).join('|'), /邮件服务器地址不能为空/)
  assert.match(core.validateEmailConfig(Object.assign({}, base, { to: '' })).join('|'), /收件人不能为空/)
  assert.match(core.validateEmailConfig(Object.assign({}, base, { to: 'not-an-address' })).join('|'), /收件人格式不正确/)
  assert.match(core.validateEmailConfig(Object.assign({}, base, { from: 'bad' })).join('|'), /发件人格式不正确/)
  assert.match(core.validateEmailConfig(Object.assign({}, base, { pass: '', passEnv: '1BAD' })).join('|'), /授权码环境变量名不合法/)
  assert.match(core.validateEmailConfig(Object.assign({}, base, { pass: '', passEnv: '' })).join('|'), /授权码没有来源/)
})

check('email: resolveEmailPass prefers the typed code, then the named env var', () => {
  const email = core.normalizeEmail({ pass: 'typed', passEnv: 'MAIL_CODE' })
  assert.equal(core.resolveEmailPass(email, { MAIL_CODE: 'from-env' }), 'typed')
  assert.equal(core.resolveEmailPass(core.normalizeEmail({ passEnv: 'MAIL_CODE' }), { MAIL_CODE: 'from-env' }), 'from-env')
  assert.equal(core.resolveEmailPass(core.normalizeEmail({}), {}), '')
  assert.equal(core.hasEmailPass(email, {}), true)
  assert.equal(core.hasEmailPass(core.normalizeEmail({}), {}), false)
})

check('email: parseAddressList strips display names (RCPT TO takes a bare address)', () => {
  assert.deepEqual(core.parseAddressList('"Me" <me@qq.com>, other@x.com; third@y.com'), ['me@qq.com', 'other@x.com', 'third@y.com'])
  assert.deepEqual(core.parseAddressList(''), [])
})

check('email: buildMailMessage assembles an RFC-2047 subject and a base64 body', () => {
  const msg = core.buildMailMessage({
    host: 'smtp.qq.com', to: 'me@qq.com', from: 'me@qq.com', user: 'me@qq.com', pass: 'x',
    subject: 'DSH 通知：{reason} · {title}',
    body: '会话：{title}\n原因：{reason}\n时间：{time}',
  }, {
    title: '修复登录', reason: 'turn-end', detail: 'completed',
    sessionId: 'session-1', cwd: '/proj/app', time: '2026-11-12T05:00:00.000Z',
  }, Date.UTC(2026, 10, 12, 5, 0, 0))
  assert.equal(msg.ok, true)
  assert.deepEqual(msg.to, ['me@qq.com'])
  assert.equal(msg.subject, 'DSH 通知：turn-end · 修复登录', 'placeholders are substituted in the subject')
  assert.equal(msg.body, '会话：修复登录\n原因：turn-end\n时间：2026-11-12T05:00:00.000Z')
  assert.match(msg.data, /\r\nSubject: =\?UTF-8\?B\?/, 'a non-ASCII subject is encoded as an RFC 2047 word')
  assert.match(msg.data, /\r\nMIME-Version: 1\.0\r\n/)
  assert.match(msg.data, /Content-Transfer-Encoding: base64/)
  assert.match(msg.data, /Message-ID: <[^>]+@dsh-notify-hub>/)
  const encoded = msg.data.split('\r\n\r\n')[1].replace(/\r\n/g, '')
  assert.equal(Buffer.from(encoded, 'base64').toString('utf8'), msg.body, 'the body round-trips through base64')
  assert.ok(msg.data.split('\r\n\r\n')[1].split('\r\n').every((l) => l.length <= 76), 'base64 lines stay under 76 columns')
})

check('email: a CRLF in the subject cannot inject a header', () => {
  const msg = core.buildMailMessage({
    to: 'me@qq.com', from: 'me@qq.com', user: 'me@qq.com', pass: 'x',
    subject: 'Hi\r\nBcc: evil@example.com', body: 'b',
  }, {}, Date.now())
  assert.equal(msg.ok, true)
  assert.ok(!/\r\nBcc:/.test(msg.data), 'no standalone Bcc header may appear')
})

check('email: buildMailMessage refuses an empty sender or recipient instead of sending', () => {
  const noFrom = core.buildMailMessage({ to: 'me@qq.com', pass: 'x' }, {}, Date.now())
  assert.equal(noFrom.ok, false)
  assert.match(noFrom.error, /发件人为空/)
  const noTo = core.buildMailMessage({ from: 'me@qq.com', pass: 'x' }, {}, Date.now())
  assert.equal(noTo.ok, false)
  assert.match(noTo.error, /收件人为空/)
})

check('email: classifySmtpError turns SMTP stages into actionable Chinese verdicts', () => {
  assert.match(core.classifySmtpError('auth', 535, 'Login fail').message, /认证失败/)
  assert.match(core.classifySmtpError('rcpt', 550, 'No such user').message, /收件人被拒/)
  assert.match(core.classifySmtpError('connect', 0, '').message, /连接邮件服务器失败/)
  assert.match(core.classifySmtpError('tls', 0, '').message, /TLS 握手失败/)
  assert.match(core.classifySmtpError('data', 554, 'rejected').message, /投递失败/)
  for (const stage of ['auth', 'rcpt', 'connect', 'tls', 'data']) {
    assert.equal(core.classifySmtpError(stage, 1, 'x').status, 'failed')
  }
})

check('email: a rule with channel=email is validated as an email rule, not as a script', () => {
  const rule = core.normalizeRule({
    id: 'r-mail', name: '邮件', channel: 'email',
    triggers: { turnEnd: true },
    email: { host: 'smtp.qq.com', to: 'me@qq.com', from: 'me@qq.com', pass: 'x' },
  })
  assert.equal(rule.channel, 'email')
  assert.deepEqual(core.validateRule(rule).errors, [])
  const broken = core.normalizeRule(Object.assign({}, rule, { email: { host: '', to: '', from: '', pass: '' } }))
  assert.ok(core.validateRule(broken).errors.length > 0, 'an email rule with no host/to/pass must not validate')
})

fs.rmSync(tmp, { recursive: true, force: true })

console.log('')
if (failures.length > 0) {
  console.log(failures.length + ' failing:')
  for (const f of failures) console.log('  · ' + f)
  process.exit(1)
}
console.log(passed + ' checks passed' + (skipped > 0 ? ', ' + skipped + ' skipped (sandbox blocks child processes)' : ''))
