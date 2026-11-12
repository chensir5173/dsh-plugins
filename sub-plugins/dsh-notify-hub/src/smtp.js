// dsh-notify-hub: built-in SMTP client (host half).
//
// Zero dependencies on purpose: this plugin must install and run inside a DSH
// profile where only the plugin itself is linked, and the repo rule forbids
// importing @deepseek-ai/* from a plugin's host half. So the whole client is
// built on node:net / node:tls. It speaks just enough SMTP for one notification
// mail: EHLO, optional STARTTLS, AUTH PLAIN / LOGIN, MAIL, RCPT, DATA, QUIT.
//
// The caller (src/index.js) owns the history entry and the pass/env resolution;
// this module owns the socket, the protocol and the error classification.

import net from 'node:net'
import tls from 'node:tls'

import {
  classifySmtpError,
  normalizeEmail,
  resolveEmailPass,
} from './host-core.js'

export const DEFAULT_CONNECT_TIMEOUT_MS = 15000
export const DEFAULT_COMMAND_TIMEOUT_MS = 10000

/** A protocol-level failure carrying the stage that produced it. */
export class SmtpError extends Error {
  constructor(stage, code, reply) {
    super(stage + ' failed: ' + (code || '?') + ' ' + (reply || ''))
    this.name = 'SmtpError'
    this.stage = stage
    this.code = code
    this.reply = reply
  }
}

function timeoutError(label) {
  const err = new Error(label + ' timed out')
  err.timeout = true
  return err
}

function withTimeout(promise, ms, label) {
  if (!ms || ms <= 0) return promise
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => reject(timeoutError(label)), ms)
    promise.then(
      (value) => { clearTimeout(timer); resolve(value) },
      (error) => { clearTimeout(timer); reject(error) },
    )
  })
}

/**
 * Read one complete SMTP reply (possibly multi-line: "250-a\r\n250 b\r\n").
 * Returns null while the reply is still incomplete.
 */
function takeReply(buffer) {
  let index = 0
  const lines = []
  for (;;) {
    const nl = buffer.indexOf('\r\n', index)
    if (nl === -1) return null
    const line = buffer.slice(index, nl)
    index = nl + 2
    if (!/^\d{3}[ -]/.test(line)) {
      // Non-conforming line: surface it instead of waiting forever.
      return { reply: { code: 0, lines: [line], text: line }, rest: buffer.slice(index) }
    }
    lines.push(line)
    if (line.charAt(3) === ' ') {
      return {
        reply: { code: Number(line.slice(0, 3)), lines, text: lines.map((item) => item.slice(4)).join(' / ') },
        rest: buffer.slice(index),
      }
    }
  }
}

/**
 * Wrap a connected socket in a tiny line-oriented channel. Kept per socket so a
 * STARTTLS upgrade can build a fresh one on the upgraded stream.
 */
function makeChannel(socket) {
  let buffer = ''
  let pending = null
  let failure = null
  socket.setEncoding('utf8')

  const settle = () => {
    if (!pending) return
    const taken = takeReply(buffer)
    if (taken) {
      buffer = taken.rest
      const current = pending
      pending = null
      current.resolve(taken.reply)
      return
    }
    if (failure) {
      const current = pending
      pending = null
      current.reject(failure)
    }
  }

  socket.on('data', (chunk) => { buffer += chunk; settle() })
  socket.on('error', (error) => { failure = error; settle() })
  socket.on('close', () => {
    if (!failure) failure = new Error('connection closed by server')
    settle()
  })

  return {
    socket,
    // A command line must be CRLF-terminated; forgetting it makes every server
    // wait for the rest of the line until the command timeout fires.
    write(text) { socket.write(text + '\r\n') },
    writeRaw(text) { socket.write(text) },
    read(ms) {
      return withTimeout(new Promise((resolve, reject) => {
        pending = { resolve, reject }
        settle()
      }), ms, 'smtp command')
    },
  }
}

/**
 * Test seam: the offline test suite drives the whole protocol over an in-memory
 * duplex stream, so this module never has to open a socket (the repo rule is
 * "tests run offline, no server, no listening port"). Pass null to restore.
 */
let connector = null

export function __setConnector(fn) {
  connector = typeof fn === 'function' ? fn : null
}

function connect(email, timeoutMs) {
  return new Promise((resolve, reject) => {
    const options = { host: email.host, port: email.port }
    let socket
    if (email.secure) {
      socket = tls.connect(Object.assign({}, options, {
        servername: email.host,
        rejectUnauthorized: !email.allowInsecureTls,
      }))
    } else {
      socket = net.connect(options)
    }
    const onReady = () => { clearTimeout(timer); resolve(socket) }
    const onError = (error) => { clearTimeout(timer); reject(error) }
    const timer = setTimeout(() => {
      try { socket.destroy() } catch {}
      reject(timeoutError('smtp connect'))
    }, timeoutMs)
    socket.once(email.secure ? 'secureConnect' : 'connect', onReady)
    socket.once('error', onError)
  })
}

function upgradeToTls(socket, email) {
  return new Promise((resolve, reject) => {
    const secured = tls.connect({
      socket,
      servername: email.host,
      rejectUnauthorized: !email.allowInsecureTls,
    }, () => resolve(secured))
    secured.once('error', reject)
  })
}

/** AUTH mechanisms advertised on the EHLO reply, upper-cased. */
function authMechanisms(reply) {
  const found = []
  for (const line of reply.lines) {
    const text = line.slice(4).trim().toUpperCase()
    if (!text.startsWith('AUTH')) continue
    for (const part of text.split(/\s+/).slice(1)) {
      if (part) found.push(part)
    }
  }
  return found
}

async function ehlo(channel, clientName, commandTimeoutMs) {
  channel.write('EHLO ' + clientName)
  let reply = await channel.read(commandTimeoutMs)
  if (reply.code >= 250 && reply.code < 300) return reply
  // Some old servers only implement HELO; fall back before giving up.
  channel.write('HELO ' + clientName)
  reply = await channel.read(commandTimeoutMs)
  if (reply.code >= 250 && reply.code < 300) return reply
  throw new SmtpError('greeting', reply.code, reply.text)
}

async function authenticate(channel, email, mechanisms, pass, commandTimeoutMs) {
  const user = email.user
  if (!user || !pass) return
  const plain = Buffer.from('\0' + user + '\0' + pass, 'utf8').toString('base64')
  if (mechanisms.indexOf('PLAIN') !== -1 || mechanisms.length === 0) {
    channel.write('AUTH PLAIN ' + plain)
    const reply = await channel.read(commandTimeoutMs)
    if (reply.code !== 235) throw new SmtpError('auth', reply.code, reply.text)
    return
  }
  if (mechanisms.indexOf('LOGIN') !== -1) {
    channel.write('AUTH LOGIN')
    let reply = await channel.read(commandTimeoutMs)
    if (reply.code !== 334) throw new SmtpError('auth', reply.code, reply.text)
    channel.write(Buffer.from(user, 'utf8').toString('base64'))
    reply = await channel.read(commandTimeoutMs)
    if (reply.code !== 334) throw new SmtpError('auth', reply.code, reply.text)
    channel.write(Buffer.from(pass, 'utf8').toString('base64'))
    reply = await channel.read(commandTimeoutMs)
    if (reply.code !== 235) throw new SmtpError('auth', reply.code, reply.text)
    return
  }
  throw new SmtpError('auth', 0, '服务器不支持 AUTH PLAIN / AUTH LOGIN，无法认证')
}

async function runSession(email, message, pass, holder, options) {
  const commandTimeoutMs = options.commandTimeoutMs || DEFAULT_COMMAND_TIMEOUT_MS
  const connectTimeoutMs = options.connectTimeoutMs || DEFAULT_CONNECT_TIMEOUT_MS
  const clientName = options.clientName || 'dsh-notify-hub'

  holder.socket = await (connector ? connector(email, connectTimeoutMs) : connect(email, connectTimeoutMs))
  let channel = makeChannel(holder.socket)

  let greeting = await channel.read(commandTimeoutMs)
  if (greeting.code !== 220) throw new SmtpError('greeting', greeting.code, greeting.text)

  let ehloReply = await ehlo(channel, clientName, commandTimeoutMs)
  const advertised = ehloReply.lines.map((line) => line.slice(4).trim().toUpperCase())
  const wantsStarttls = email.starttls !== false && advertised.some((line) => line === 'STARTTLS')

  if (wantsStarttls) {
    channel.write('STARTTLS')
    const reply = await channel.read(commandTimeoutMs)
    if (reply.code !== 220) throw new SmtpError('tls', reply.code, reply.text)
    holder.socket = await upgradeToTls(holder.socket, email)
    channel = makeChannel(holder.socket)
    // RFC 3207: the session state is reset, EHLO again after the upgrade.
    ehloReply = await ehlo(channel, clientName, commandTimeoutMs)
  }

  const mechanisms = authMechanisms(ehloReply)
  if (email.user && !pass && mechanisms.length) {
    throw new SmtpError('auth', 0, '未提供授权码')
  }
  await authenticate(channel, email, mechanisms, pass, commandTimeoutMs)

  channel.write('MAIL FROM:<' + message.from + '>')
  let reply = await channel.read(commandTimeoutMs)
  if (reply.code !== 250) throw new SmtpError('mail', reply.code, reply.text)

  for (const recipient of message.to) {
    channel.write('RCPT TO:<' + recipient + '>')
    reply = await channel.read(commandTimeoutMs)
    if (reply.code !== 250 && reply.code !== 251) throw new SmtpError('rcpt', reply.code, reply.text)
  }

  channel.write('DATA')
  reply = await channel.read(commandTimeoutMs)
  if (reply.code !== 354) throw new SmtpError('data', reply.code, reply.text)

  channel.writeRaw(message.data + '\r\n.\r\n')
  reply = await channel.read(Math.max(commandTimeoutMs, 20000))
  if (reply.code !== 250) throw new SmtpError('data', reply.code, reply.text)

  // QUIT is a courtesy: once the server accepted the DATA we are done, so a
  // slow or missing 221 must not turn a delivered mail into a failure.
  try {
    channel.write('QUIT')
    await channel.read(2000)
  } catch {}
  return { ok: true }
}

/**
 * Deliver one prepared message. Never throws: returns
 *   { ok: true, durationMs, messageId }
 *   { ok: false, status: 'failed' | 'timeout', error, code }
 * so the caller can write the exact same history entry as a script run.
 */
export async function sendMail(emailInput, message, options = {}) {
  const email = normalizeEmail(emailInput)
  const env = options.env || {}
  const pass = resolveEmailPass(email, env)
  const timeoutMs = options.timeoutMs || 30000
  const holder = { socket: null }
  const started = Date.now()

  if (!email.host) {
    return { ok: false, status: 'failed', error: '邮件服务器地址为空', code: 0, durationMs: 0 }
  }
  if (!message || message.ok !== true) {
    return { ok: false, status: 'failed', error: (message && message.error) || '邮件内容构造失败', code: 0, durationMs: 0 }
  }

  try {
    await withTimeout(runSession(email, message, pass, holder, options), timeoutMs, 'smtp session')
    return { ok: true, durationMs: Date.now() - started, messageId: message.messageId }
  } catch (error) {
    const durationMs = Date.now() - started
    if (error && error.timeout) {
      return { ok: false, status: 'timeout', error: '投递超时：' + (error.message || 'no response'), code: 0, durationMs }
    }
    if (error instanceof SmtpError) {
      const verdict = classifySmtpError(error.stage, error.code, error.reply)
      return { ok: false, status: verdict.status, error: verdict.message, code: error.code, durationMs }
    }
    // A refused / unresolvable / unreachable host surfaces as a plain Error with
    // an errno code, not as an SmtpError. Map it to the same actionable wording,
    // otherwise the history entry would only say "连接/投递失败".
    const errno = error && typeof error.code === 'string' ? error.code : ''
    if (/^(ECONNREFUSED|ECONNRESET|ENOTFOUND|EAI_AGAIN|EHOSTUNREACH|ENETUNREACH|ETIMEDOUT|EPIPE)$/.test(errno)) {
      const hint = error.message ? ' ' + error.message : ''
      return { ok: false, status: 'failed', error: '连接邮件服务器失败：' + errno + hint, code: errno, durationMs }
    }
    const detail = error && error.message ? error.message : String(error)
    return { ok: false, status: 'failed', error: '连接/投递失败：' + detail, code: 0, durationMs }
  } finally {
    const socket = holder.socket
    if (socket) {
      try { socket.destroy() } catch {}
    }
  }
}
