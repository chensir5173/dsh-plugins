// Tests for dsh-notify-hub/src/smtp.js — the built-in SMTP client.
//
// The whole protocol is exercised over an in-memory duplex stream through the
// __setConnector seam: no socket is opened, no port is listened on, so this runs
// offline like the rest of the repo's tests.
//
// Run: node sub-plugins/dsh-notify-hub/test/smtp.test.mjs
import assert from 'node:assert/strict'
import { Duplex } from 'node:stream'

import * as core from '../src/host-core.js'
import { sendMail, __setConnector } from '../src/smtp.js'

const failures = []
let passed = 0

async function checkAsync(name, fn) {
  try {
    await fn()
    passed += 1
    console.log('  ok   ' + name)
  } catch (e) {
    failures.push(name + ': ' + ((e && e.message) || String(e)))
    console.log('  FAIL ' + name + ' → ' + ((e && e.message) || String(e)))
  }
}

// --- fake server --------------------------------------------------------------

/**
 * A scripted SMTP peer. `options.silent` never sends the greeting (to exercise a
 * command timeout); `options.mechanisms` controls what EHLO advertises;
 * `options.rejectAuth` / `options.rejectRcpt` fail the matching command.
 */
function fakeServer(options = {}) {
  const log = { commands: [], data: null, authSteps: 0 }
  const mechanisms = options.mechanisms || ['PLAIN', 'LOGIN']
  let buffer = ''
  let inData = false
  let authLoginStep = 0

  const socket = new Duplex({
    read() {},
    write(chunk, _encoding, callback) {
      handle(Buffer.isBuffer(chunk) ? chunk.toString('utf8') : String(chunk))
      callback()
    },
  })
  socket.setEncoding('utf8')

  function send(text) {
    if (options.silent) return
    socket.push(text)
  }

  function handle(chunk) {
    buffer += chunk
    for (;;) {
      if (inData) {
        const end = buffer.indexOf('\r\n.\r\n')
        if (end === -1) return
        log.data = buffer.slice(0, end)
        buffer = buffer.slice(end + 5)
        inData = false
        send('250 2.0.0 Ok: queued as A1\r\n')
        continue
      }
      const nl = buffer.indexOf('\r\n')
      if (nl === -1) return
      const line = buffer.slice(0, nl)
      buffer = buffer.slice(nl + 2)
      log.commands.push(line)
      const upper = line.toUpperCase()

      if (upper.startsWith('EHLO')) {
        const rows = ['250-fake.local greets you']
        for (const mech of mechanisms) rows.push('250-AUTH ' + mech)
        rows.push('250 SIZE 10485760')
        send(rows.join('\r\n') + '\r\n')
        continue
      }
      if (upper.startsWith('HELO')) {
        send('250 fake.local\r\n')
        continue
      }
      if (upper.startsWith('AUTH LOGIN')) {
        authLoginStep = 1
        send('334 VXNlcm5hbWU6\r\n')
        continue
      }
      if (authLoginStep === 1) {
        log.authSteps += 1
        authLoginStep = 2
        send('334 UGFzc3dvcmQ6\r\n')
        continue
      }
      if (authLoginStep === 2) {
        log.authSteps += 1
        authLoginStep = 0
        if (options.rejectAuth) send('535 5.7.8 Authentication credentials invalid\r\n')
        else send('235 2.7.0 Authentication successful\r\n')
        continue
      }
      if (upper.startsWith('AUTH PLAIN')) {
        log.authSteps += 1
        if (options.rejectAuth) send('535 5.7.8 Authentication credentials invalid\r\n')
        else send('235 2.7.0 Authentication successful\r\n')
        continue
      }
      if (upper.startsWith('MAIL FROM')) {
        if (options.rejectMail) send('553 5.1.8 Sender rejected\r\n')
        else send('250 2.1.0 Ok\r\n')
        continue
      }
      if (upper.startsWith('RCPT TO')) {
        if (options.rejectRcpt) send('550 5.1.1 No such user here\r\n')
        else send('250 2.1.5 Ok\r\n')
        continue
      }
      if (upper === 'DATA') {
        inData = true
        send('354 End data with <CR><LF>.<CR><LF>\r\n')
        continue
      }
      if (upper === 'STARTTLS') {
        send('454 4.7.0 TLS not available\r\n')
        continue
      }
      if (upper === 'QUIT') {
        send('221 2.0.0 Bye\r\n')
        continue
      }
      send('502 5.5.2 Command not implemented\r\n')
    }
  }

  // Hold the greeting until the caller has attached its listeners.
  queueMicrotask(() => send('220 fake.local ESMTP ready\r\n'))
  return { socket, log }
}

function emailConfig(patch = {}) {
  return Object.assign({
    host: 'smtp.test.local',
    port: 465,
    secure: false,
    starttls: false,
    user: 'me@test.local',
    pass: 'auth-code-value',
    from: 'me@test.local',
    to: 'you@test.local',
    subject: 'DSH 通知：{reason} · {title}',
    body: '会话：{title}\n目录：{cwd}\n原因：{reason} {detail}',
  }, patch)
}

function messageFor(patch = {}, values = {}) {
  const email = core.normalizeEmail(emailConfig(patch))
  return core.buildMailMessage(email, Object.assign({
    title: '排查通知',
    sessionId: 'session-1',
    cwd: 'C:/work',
    reason: 'turn-end',
    detail: 'completed',
    rule: '默认',
    time: '2026-11-12 13:00:00',
  }, values), 1700000000000)
}

/** Install a fake peer for exactly one sendMail call. */
async function withServer(options, run) {
  const server = fakeServer(options)
  __setConnector(async () => server.socket)
  try {
    return await run(server)
  } finally {
    __setConnector(null)
    try { server.socket.destroy() } catch {}
  }
}

// --- happy path ---------------------------------------------------------------

await checkAsync('sendMail: AUTH PLAIN + full SMTP dialogue delivers the message', async () => {
  await withServer({ mechanisms: ['PLAIN'] }, async (server) => {
    const message = messageFor()
    assert.equal(message.ok, true)
    const result = await sendMail(core.normalizeEmail(emailConfig()), message, { env: {} })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(typeof result.durationMs, 'number')

    const commands = server.log.commands.map((line) => line.split(' ')[0])
    assert.deepEqual(
      commands,
      ['EHLO', 'AUTH', 'MAIL', 'RCPT', 'DATA', 'QUIT'],
      'unexpected command order: ' + JSON.stringify(server.log.commands),
    )
    assert.ok(server.log.commands[0].startsWith('EHLO dsh-notify-hub'), server.log.commands[0])
    assert.ok(server.log.commands[2].startsWith('MAIL FROM:<me@test.local>'), server.log.commands[2])
    assert.ok(server.log.commands[3].startsWith('RCPT TO:<you@test.local>'), server.log.commands[3])

    assert.ok(server.log.data.includes('Subject: =?UTF-8?B?'), server.log.data)
    assert.ok(server.log.data.includes('Content-Transfer-Encoding: base64'))
    assert.ok(server.log.data.includes('X-Mailer: dsh-notify-hub'))
    assert.ok(server.log.data.includes('\r\n\r\n'), 'headers and body must be separated by a blank line')
  })
})

await checkAsync('sendMail: several recipients each get their own RCPT TO', async () => {
  await withServer({}, async (server) => {
    const email = core.normalizeEmail(emailConfig({ to: 'a@test.local, b@test.local;c@test.local' }))
    const result = await sendMail(email, core.buildMailMessage(email, {}), { env: {} })
    assert.equal(result.ok, true, JSON.stringify(result))
    const rcpts = server.log.commands.filter((line) => line.toUpperCase().startsWith('RCPT TO'))
    assert.deepEqual(rcpts, ['RCPT TO:<a@test.local>', 'RCPT TO:<b@test.local>', 'RCPT TO:<c@test.local>'])
  })
})

await checkAsync('sendMail: AUTH LOGIN is used when the server only advertises LOGIN', async () => {
  await withServer({ mechanisms: ['LOGIN'] }, async (server) => {
    const result = await sendMail(core.normalizeEmail(emailConfig()), messageFor(), { env: {} })
    assert.equal(result.ok, true, JSON.stringify(result))
    const auth = server.log.commands.find((line) => line.toUpperCase().startsWith('AUTH'))
    assert.equal(auth, 'AUTH LOGIN')
    assert.equal(server.log.authSteps, 2, 'username and password are sent as two base64 lines')
    // the password line must be the base64 of the configured code
    const secret = Buffer.from('auth-code-value', 'utf8').toString('base64')
    assert.ok(server.log.commands.includes(secret), 'expected the base64 authorization code')
  })
})

await checkAsync('sendMail: no AUTH at all when no account is configured', async () => {
  await withServer({}, async (server) => {
    const email = core.normalizeEmail(emailConfig({ user: '', pass: '' }))
    const result = await sendMail(email, core.buildMailMessage(email, {}), { env: {} })
    assert.equal(result.ok, true, JSON.stringify(result))
    assert.equal(server.log.commands.filter((line) => line.toUpperCase().startsWith('AUTH')).length, 0)
  })
})

await checkAsync('sendMail: passEnv is resolved from the env map and never leaks into the dialogue', async () => {
  await withServer({}, async (server) => {
    const email = core.normalizeEmail(emailConfig({ pass: '', passEnv: 'MY_MAIL_CODE' }))
    const result = await sendMail(email, core.buildMailMessage(email, {}), { env: { MY_MAIL_CODE: 'from-env' } })
    assert.equal(result.ok, true, JSON.stringify(result))
    const secret = Buffer.from('from-env', 'utf8').toString('base64')
    // AUTH PLAIN carries the blob on the same line: "AUTH PLAIN <base64>".
    assert.ok(
      server.log.commands.some((line) => line.endsWith(secret)),
      'expected the base64 authorization code in AUTH PLAIN',
    )
    assert.ok(!server.log.commands.some((line) => line.includes('from-env')), 'the code must not appear in clear text')
  })
})

// --- failures -----------------------------------------------------------------

await checkAsync('sendMail: 535 on AUTH becomes a fixable "认证失败" verdict', async () => {
  await withServer({ rejectAuth: true }, async () => {
    const result = await sendMail(core.normalizeEmail(emailConfig()), messageFor(), { env: {} })
    assert.equal(result.ok, false)
    assert.equal(result.status, 'failed')
    assert.equal(result.status, 'failed')
    assert.ok(result.error.includes('认证失败'), result.error)
    assert.ok(
      result.error.includes('Authentication credentials invalid'),
      'the server reply text is kept: ' + result.error,
    )
  })
})

await checkAsync('sendMail: a rejected recipient is reported as such', async () => {
  await withServer({ rejectRcpt: true }, async () => {
    const result = await sendMail(core.normalizeEmail(emailConfig()), messageFor(), { env: {} })
    assert.equal(result.ok, false)
    assert.ok(result.error.includes('收件人被拒'), result.error)
  })
})

await checkAsync('sendMail: a refused connection is classified as a connection failure', async () => {
  const refused = Object.assign(new Error('connect ECONNREFUSED 127.0.0.1:465'), { code: 'ECONNREFUSED' })
  __setConnector(async () => { throw refused })
  try {
    const result = await sendMail(core.normalizeEmail(emailConfig()), messageFor(), { env: {} })
    assert.equal(result.ok, false)
    assert.ok(result.error.includes('连接邮件服务器失败'), result.error)
  } finally {
    __setConnector(null)
  }
})

await checkAsync('sendMail: a silent server is a timeout, not a hang', async () => {
  await withServer({ silent: true }, async () => {
    const result = await sendMail(core.normalizeEmail(emailConfig()), messageFor(), {
      env: {},
      timeoutMs: 400,
      commandTimeoutMs: 200,
    })
    assert.equal(result.ok, false)
    assert.equal(result.status, 'timeout')
    assert.ok(result.error.includes('超时'), result.error)
  })
})

await checkAsync('sendMail: an incomplete address never opens the connection', async () => {
  await withServer({}, async (server) => {
    const email = core.normalizeEmail(emailConfig({ to: '' }))
    const message = core.buildMailMessage(email, {})
    assert.equal(message.ok, false)
    const result = await sendMail(email, message, { env: {} })
    assert.equal(result.ok, false)
    assert.ok(result.error.includes('收件人'), result.error)
    assert.equal(server.log.commands.length, 0, 'no command may be sent')
  })
})

console.log('')
if (failures.length > 0) {
  console.log(failures.length + ' failing:')
  for (const item of failures) console.log('  · ' + item)
  process.exit(1)
}
console.log(passed + ' checks passed')
