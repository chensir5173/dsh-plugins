// dsh-agent-preset-manager: HOST core — pure logic, injected dependencies.
//
// Why this file exists separately from ./index.js: every decision here (scanning
// two preset libraries, judging whether a plugin row name will resolve at
// activation time, reading/writing preset.yml + agent.cordis.yml, keeping the
// enabled set in a state file) is testable offline. ./index.js owns only the
// cordis wiring and the HTTP listen socket.
//
// Design references: openspec/changes/add-agent-preset-manager/design.md D2–D8.
//
// Two libraries are scanned because the format moved:
//   $DSH_HOME/.agent-presets/<id>/   — the pre-0.2.0 directory format
//   $DSH_HOME/agent-presets/<id>/    — the current library convention
// Both hold preset.yml (display metadata) + agent.cordis.yml (plugin row list).

import path from 'node:path'

export const PLUGIN_ID = 'dsh-agent-preset-manager'
export const API_PREFIX = '/__dsh-agent-presets'
/**
 * The one table the host half registers and dispatches from.
 *
 * Each entry carries everything a request needs: the exact path, the only method
 * it accepts, and the action name runCommand understands. Keeping them in one row
 * is what stops the registered path and the dispatched action from drifting.
 */
export const ROUTES = [
  { path: API_PREFIX + '/state', method: 'GET', action: 'state' },
  { path: API_PREFIX + '/set-enabled', method: 'POST', action: 'set-enabled' },
  { path: API_PREFIX + '/create', method: 'POST', action: 'create' },
  { path: API_PREFIX + '/save', method: 'POST', action: 'save' },
  { path: API_PREFIX + '/remove', method: 'POST', action: 'remove' },
  { path: API_PREFIX + '/import', method: 'POST', action: 'import' },
  { path: API_PREFIX + '/migrate', method: 'POST', action: 'migrate' },
  { path: API_PREFIX + '/file', method: 'GET', action: 'file' },
]
export const ROUTE_TABLE = ROUTES

/** Look a route up by action name (the dispatcher's only lookup). */
export function routeOf(action) {
  return ROUTE_TABLE.find((route) => route.action === action) || null
}

export const LEGACY_LIBRARY_DIR = '.agent-presets'
export const LIBRARY_DIR = 'agent-presets'
export const STATE_DIR = 'agent-preset-manager'
export const STATE_FILE = 'state.json'
export const COMPOSITION_FILE = 'agent.cordis.yml'
export const METADATA_FILE = 'preset.yml'
export const BACKUP_DIR = '.backup'
export const BACKUP_KEEP = 3
export const STATE_VERSION = 1

/** Preset ids are directory names AND registry keys, so the shape is fixed. */
export const PRESET_ID_RE = /^[a-z0-9][a-z0-9_-]{0,63}$/

// --- YAML subset ------------------------------------------------------------
//
// A preset composition is a list of plugin rows with plain scalars, nested
// config maps/seqs, literal (|) and folded (>) block scalars, and the host's
// !!js tag for computed values. That subset is all this parser accepts; anchors,
// aliases and flow collections are rejected with a named error, because
// silently mis-parsing a composition is worse than refusing to load it.

function tokenize(text) {
  const toks = []
  const lines = String(text).split(/\r?\n/)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]
    if (!line.trim() || line.trim().startsWith('#')) {
      toks.push({ ind: -1, text: '', line: i + 1, blank: true })
      continue
    }
    const ind = line.match(/^ */)[0].length
    toks.push({ ind, text: line.slice(ind), line: i + 1 })
  }
  return toks
}

function skipBlank(toks, j) {
  while (j < toks.length && toks[j].blank) j++
  return j
}

function isSeqLine(t) {
  return t === '-' || t.startsWith('- ')
}

function isMapLine(t) {
  return /^[^\s#][^:]*:(?:\s|$)/.test(t)
}

function splitKV(t) {
  const m = /^([^:]*):(?:\s*)([\s\S]*)$/.exec(t)
  return m ? { key: m[1], rest: m[2] } : { key: t, rest: '' }
}

function isBlockHeader(rest) {
  return /^[|>][+-]?[0-9]?$/.test(String(rest || '').trim())
}

function parseScalar(s) {
  if (typeof s !== 'string') return s
  if (s.startsWith('!!js')) return { __js: s.slice(4).trim() }
  if (s.startsWith("'") && s.endsWith("'") && s.length >= 2) return s.slice(1, -1).replace(/''/g, "'")
  if (s.startsWith('"') && s.endsWith('"') && s.length >= 2) {
    try { return JSON.parse(s) } catch { return s.slice(1, -1) }
  }
  if (s === '' || s === '~' || s === 'null') return null
  if (s === 'true') return true
  if (s === 'false') return false
  if (/^-?\d+(\.\d+)?$/.test(s)) return Number(s)
  if (s.startsWith('&') || s.startsWith('*') || s.startsWith('{') || s.startsWith('[')) {
    throw new Error('unsupported YAML feature (anchors/aliases/flow collections): ' + s.slice(0, 40))
  }
  return s
}

function blockScalar(toks, j, indent, header) {
  const parts = []
  let k = j
  while (k < toks.length) {
    if (toks[k].blank) { parts.push(''); k++; continue }
    if (toks[k].ind <= indent) break
    parts.push(toks[k].text)
    k++
  }
  let out = parts.join('\n')
  if (String(header).trim().startsWith('|')) out = out.replace(/\n+$/, '') + '\n'
  else out = out.replace(/\n+/g, ' ').trim()
  return { value: out, next: k }
}

function parseNode(toks, j, indent, ctx) {
  j = skipBlank(toks, j)
  if (j >= toks.length || toks[j].ind < indent) return { value: null, next: j }
  if (toks[j].ind > indent) indent = toks[j].ind
  if (isSeqLine(toks[j].text)) {
    const out = []
    for (;;) {
      j = skipBlank(toks, j)
      if (j >= toks.length || toks[j].ind !== indent || !isSeqLine(toks[j].text)) break
      const body = toks[j].text === '-' ? '' : toks[j].text.slice(2)
      if (body === '') {
        const r = parseNode(toks, j + 1, indent + 1, ctx)
        out.push(r.value)
        j = r.next
        continue
      }
      if (isMapLine(body)) {
        const r = parseSeqMap(toks, j, indent, body, ctx)
        out.push(r.value)
        j = r.next
        continue
      }
      out.push(parseScalar(body))
      j++
    }
    return { value: out, next: j }
  }
  if (isMapLine(toks[j].text)) {
    const map = {}
    for (;;) {
      j = skipBlank(toks, j)
      if (j >= toks.length || toks[j].ind !== indent || !isMapLine(toks[j].text) || isSeqLine(toks[j].text)) break
      const r = parseMapEntry(toks, j, indent, ctx)
      map[r.key] = r.value
      j = r.next
    }
    return { value: map, next: j }
  }
  ctx.errors.push({ line: toks[j].line, message: 'unsupported node: ' + toks[j].text.slice(0, 60) })
  return { value: null, next: j + 1 }
}

function parseMapEntry(toks, j, indent, ctx) {
  const { key, rest } = splitKV(toks[j].text)
  if (isBlockHeader(rest)) {
    const b = blockScalar(toks, j + 1, indent, rest)
    return { key, value: b.value, next: b.next }
  }
  if (rest !== '') return { key, value: parseScalar(rest), next: j + 1 }
  const n = skipBlank(toks, j + 1)
  if (n < toks.length && toks[n].ind > indent) {
    const r = parseNode(toks, n, toks[n].ind, ctx)
    return { key, value: r.value, next: r.next }
  }
  return { key, value: null, next: j + 1 }
}

function parseSeqMap(toks, j, indent, firstBody, ctx) {
  const map = {}
  const first = splitKV(firstBody)
  let next = j + 1
  if (first.rest === '') {
    const n = skipBlank(toks, j + 1)
    if (n < toks.length && toks[n].ind > indent) {
      const r = parseNode(toks, n, toks[n].ind, ctx)
      map[first.key] = r.value
      next = r.next
    } else {
      map[first.key] = null
    }
  } else if (isBlockHeader(first.rest)) {
    const b = blockScalar(toks, j + 1, indent, first.rest)
    map[first.key] = b.value
    next = b.next
  } else {
    map[first.key] = parseScalar(first.rest)
  }
  for (;;) {
    const n = skipBlank(toks, next)
    if (n >= toks.length || toks[n].ind <= indent) break
    if (isSeqLine(toks[n].text) || !isMapLine(toks[n].text)) break
    const r = parseMapEntry(toks, n, toks[n].ind, ctx)
    if (map[r.key] === undefined) map[r.key] = r.value
    next = r.next
  }
  return { value: map, next }
}

/** Parse the accepted YAML subset. Content errors are reported, never thrown. */
export function parseYaml(text) {
  const ctx = { errors: [] }
  let toks
  try {
    toks = tokenize(text)
  } catch (error) {
    return { ok: false, value: null, errors: [{ line: 1, message: String((error && error.message) || error) }] }
  }
  const start = skipBlank(toks, 0)
  if (start >= toks.length) return { ok: true, value: null, errors: [] }
  let result
  try {
    result = parseNode(toks, start, toks[start].ind, ctx)
  } catch (error) {
    return { ok: false, value: null, errors: [{ line: 1, message: String((error && error.message) || error) }] }
  }
  return { ok: ctx.errors.length === 0, value: result.value, errors: ctx.errors }
}



// --- metadata text ----------------------------------------------------------

export function defaultMetadataText(name, description, order) {
  const lines = ['name: ' + JSON.stringify(name || '')]
  if (description) lines.push('description: ' + JSON.stringify(description))
  if (typeof order === 'number' && Number.isFinite(order)) lines.push('order: ' + order)
  return lines.join('\n') + '\n'
}

// --- dispatcher -------------------------------------------------------------

/**
 * Dispatch one API command.
 *
 * Every response carries the freshly collected state: the panel never has to
 * guess what a partial failure left behind.
 */
export async function runCommand(deps, action, body, migrateRef) {
  const core = createCore(deps)
  const args = body && typeof body === 'object' && !Array.isArray(body) ? body : {}
  const restore = () => (typeof migrateRef === 'function' ? migrateRef() : null)
  /** A rejected command is a client error, so the panel shows the reason verbatim. */
  const answered = (result) => ({ status: result && result.ok === false ? 400 : 200, payload: result })
  try {
    if (action === 'state') return { status: 200, payload: { ...collectState(core), restore: restore() } }
    if (action === 'bootstrap') return { status: 200, payload: restore() || { ok: true, state: collectState(core) } }
    const ops = createOperations(deps)
    if (action === 'set-enabled') {
      const id = typeof args.id === 'string' ? args.id : ''
      if (!id) return { status: 400, payload: { ok: false, error: '缺少参数 id', state: collectState(core) } }
      return answered(await ops.applyEnabled(id, args.enabled !== false))
    }
    if (action === 'create') return answered(await ops.create(args))
    if (action === 'save') return answered(await ops.save(args))
    if (action === 'remove') return answered(await ops.remove(args))
    if (action === 'import') return answered(await ops.import(args))
    if (action === 'migrate') return { status: 200, payload: { ...(await ops.migrate(args)), restore: restore() } }
    if (action === 'file') return answered(await ops.file(args))
    return { status: 404, payload: { ok: false, error: '未知操作：' + String(action), state: collectState(core) } }
  } catch (error) {
    return {
      status: 500,
      payload: { ok: false, error: String((error && error.message) || error), state: collectState(core) },
    }
  }
}

/**
 * The runtime bridge: a thin shim over the host's agent preset registry.
 *
 * It exists so that the core never touches cordis directly, and so the two
 * degradation paths are explicit: no registry (older DSH) and a registry that
 * refuses an individual definition.
 */
export function createRuntimeProbe(ctx, versions) {
  const probe = {
    supported: false,
    error: null,
    service: null,
    handles: new Map(),
    versions: versions || null,
    getHandles() {
      return probe.handles
    },
    enable(definition) {
      const registry = probe.service
      if (!registry) return { ok: false, error: MSG.serviceUnavailable }
      let dispose = null
      try {
        dispose = registry.register({
          id: definition.id,
          name: definition.name,
          ...(definition.description ? { description: definition.description } : {}),
          ...(typeof definition.order === 'number' ? { order: definition.order } : {}),
          plugins: definition.plugins,
        })
      } catch (error) {
        return { ok: false, error: String((error && error.message) || error) }
      }
      if (typeof dispose !== 'function') {
        return { ok: false, error: '注册表没有返回撤销函数，无法保证「停用」可用，已拒绝这次启用。' }
      }
      // The handle the caller may use to roll back must clean up BOTH sides: the
      // host registration and our own map. Otherwise a failed enable leaves a
      // dangling handle behind, and a later disable would try to undeclare a
      // registration that no longer exists.
      const undo = () => {
        probe.handles.delete(definition.id)
        return dispose()
      }
      probe.handles.set(definition.id, { dispose: undo, error: null, baseUrl: definition.dir || null })
      return { ok: true, id: definition.id, dispose: undo }
    },
    disable(id) {
      const handle = probe.handles.get(id)
      if (!handle) return { ok: true, noop: true }
      try {
        handle.dispose()
        probe.handles.delete(id)
        return { ok: true }
      } catch (error) {
        return { ok: false, error: String((error && error.message) || error) }
      }
    },
    findParentRealmService(serviceName) {
      if (!ctx || typeof ctx.get !== 'function') return null
      const direct = ctx.get(serviceName)
      if (direct) return direct
      const realms = ctx.get('realms')
      if (realms && typeof realms.list === 'function') {
        for (const realm of realms.list() || []) {
          const candidate = realm && typeof realm.get === 'function' ? realm.get(serviceName) : null
          if (candidate) return candidate
        }
      }
      return null
    },
    adopt(registry) {
      if (!registry || typeof registry.register !== 'function') {
        probe.supported = false
        probe.error = MSG.serviceUnavailable
        return false
      }
      probe.service = registry
      probe.supported = true
      probe.error = null
      return true
    },
  }
  return probe
}

/** Isolate realm required: a service must never leak into the root realm. */
export function createRuntimeProxy(runtime) {
  return {
    get supported() { return runtime.supported },
    get error() { return runtime.error },
    get versions() { return runtime.versions },
    getHandles: () => runtime.handles,
    enable: (definition) => runtime.enable(definition),
    disable: (id) => runtime.disable(id),
  }
}



const QUOTE_CHARS = /[:#&*!|>%@\u0060"'\[\]{},]|^\s|\s$|^- |^\? /
const PLAIN_SAFE = /^[A-Za-z0-9_@/{}()\[\].,=+$~^;<]*$/
/** YAML indicators that must not open a plain scalar (readers differ widely). */
const RESERVED_FIRST = /^[-?&*!|>%@\u0060'" ]/

function dumpScalar(v) {
  if (v === null) return 'null'
  if (v === true) return 'true'
  if (v === false) return 'false'
  if (typeof v === 'number') return String(v)
  const s = String(v)
  if (s === '') return "''"
  // '@deepseek-ai/dsh-persona'-style package names stay plain: they are the
  // dominant value in every composition, and quoting them all would make the
  // file unreadable next to the built-in presets.
  if (PLAIN_SAFE.test(s) && !QUOTE_CHARS.test(s) && !RESERVED_FIRST.test(s)) return s
  if (RESERVED_FIRST.test(s) || s.includes(': ') || s.includes(' #') || /^\s|\s$/.test(s)) {
    return "'" + s.replace(/'/g, "''") + "'"
  }
  return s
}

function dumpNode(key, value, indent) {
  const pad = ' '.repeat(indent)
  const lines = []
  if (value && typeof value === 'object' && !Array.isArray(value) && typeof value.__js === 'string') {
    return [pad + key + ': !!js ' + value.__js]
  }
  if (value === null || typeof value !== 'object') {
    const text = value === null ? '' : String(value)
    if (typeof value === 'string' && text.includes('\n')) {
      lines.push(pad + key + ': |-')
      for (const part of text.replace(/\n$/, '').split('\n')) lines.push(pad + '  ' + part)
      return lines
    }
    lines.push(pad + key + ': ' + dumpScalar(value))
    return lines
  }
  if (Array.isArray(value)) {
    lines.push(pad + key + ':')
    for (const item of value) {
      if (item && typeof item === 'object' && !Array.isArray(item)) lines.push(...dumpRow(item, indent + 2))
      else if (Array.isArray(item)) {
        lines.push(pad + '  -')
        for (const sub of item) lines.push(...dumpNode('-', sub, indent + 4).map((line) => line.replace(/^- /, '  - ')))
      } else lines.push(pad + '  - ' + dumpScalar(item))
    }
    return lines
  }
  lines.push(pad + key + ':')
  for (const k of Object.keys(value)) lines.push(...dumpNode(k, value[k], indent + 2))
  return lines
}

function dumpRow(row, indent) {
  const pad = ' '.repeat(indent)
  const lines = []
  let first = true
  for (const k of Object.keys(row)) {
    const body = dumpNode(k, row[k], indent + 2)
    if (first) {
      lines.push(pad + '- ' + body[0].trim())
      first = false
    } else lines.push(...body)
  }
  return lines
}

/** Serialize a row list back into the accepted YAML subset. */
export function dumpRows(rows) {
  return (Array.isArray(rows) ? rows : []).map((row) => dumpRow(row, 0).join('\n')).join('\n') + '\n'
}

const BLOCK_COMMENT = [
  '# Agent preset composition — the plugin row list this preset activates.',
  '# Written by dsh-agent-preset-manager; edit here or in the settings panel',
  '# (the panel keeps the last three revisions in ./.backup/).',
  '',
].join('\n')

/** The exact bytes a freshly created composition file starts with. */
export function compositionText(rows) {
  return BLOCK_COMMENT + dumpRows(rows) + '\n'
}

/** Row ids must be unique inside one composition — duplicates are a hard error. */
export function findDuplicateRowIds(rows) {
  const seen = new Set()
  const dup = []
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object') continue
    const id = row.id
    if (typeof id !== 'string' || id === '') continue
    if (seen.has(id)) dup.push(id)
    seen.add(id)
  }
  return dup
}

/** Collect every row of a composition, group children included. */
export function flattenRows(rows) {
  const out = []
  for (const row of Array.isArray(rows) ? rows : []) {
    if (!row || typeof row !== 'object') continue
    out.push(row)
    if (Array.isArray(row.config)) out.push(...flattenRows(row.config))
  }
  return out
}

const CORDIS_BUILTINS = new Set(['cordis:group'])

function resolveLocalName(name, baseDir) {
  if (name.startsWith('file://')) {
    try {
      return decodeURIComponent(new URL(name).pathname.replace(/^[/\\]/, '').replace(/\//g, '\\'))
    } catch { return null }
  }
  if (path.isAbsolute(name)) return name
  if (!baseDir) return null
  return path.resolve(baseDir, name)
}

/**
 * Judge whether one row's `name` will resolve when the host activates the preset.
 *
 * The base URL in play is the preset's OWN directory — that is what the registry
 * mounts a declaration under — so `./custom-bash.mjs` means "next to preset.yml".
 */
export function checkRowNames(rows, options) {
  const opts = options || {}
  const baseDir = opts.baseDir || null
  const load = typeof opts.load === 'function' ? opts.load : null
  const exists = typeof opts.exists === 'function' ? opts.exists : null
  const results = []

  for (const row of flattenRows(rows)) {
    const id = typeof row.id === 'string' && row.id !== '' ? row.id : '(无 id 行)'
    const name = row.name
    if (typeof name !== 'string' || name === '') {
      results.push({ rowId: id, name: String(name === undefined ? '' : name), level: 'unavailable', reason: '缺少 name 字段' })
      continue
    }
    const disabled = row.disabled !== undefined
    if (CORDIS_BUILTINS.has(name)) {
      if (!Array.isArray(row.config) || row.config.length === 0) {
        results.push({ rowId: id, name, level: 'suspect', reason: 'cordis:group 组行没有子行' })
      } else {
        results.push({ rowId: id, name, level: 'ok', reason: disabled ? 'cordis 内置组行（该行已禁用）' : 'cordis 内置组行' })
      }
      continue
    }
    if (name.startsWith('cordis:')) {
      results.push({ rowId: id, name, level: 'suspect', reason: '未知的 cordis: 内置行名' })
      continue
    }
    if (name.startsWith('./') || name.startsWith('../') || name.startsWith('file://') || /^[A-Za-z]:[/\\]/.test(name)) {
      const resolved = resolveLocalName(name, baseDir)
      if (!resolved) {
        results.push({ rowId: id, name, level: 'unavailable', reason: '本地路径无法解析（缺少预设目录基准）' })
        continue
      }
      const found = typeof exists === 'function' ? exists(resolved) : true
      results.push({
        rowId: id,
        name,
        level: found ? 'ok' : 'unavailable',
        reason: found ? '本地文件存在：' + resolved : '本地文件不存在：' + resolved,
      })
      continue
    }
    let resolved = null
    let error = null
    if (typeof load === 'function') {
      try {
        resolved = load(name)
      } catch (caught) {
        error = String((caught && caught.message) || caught)
      }
    } else {
      error = '没有可用的模块解析器'
    }
    if (resolved) {
      results.push({ rowId: id, name, level: 'ok', reason: disabled ? '包可解析（该行已禁用）' : '包可解析' })
      continue
    }
    const packageName = name.startsWith('@') ? name.split('/').slice(0, 2).join('/') : name.split('/')[0]
    results.push({
      rowId: id,
      name,
      level: 'unavailable',
      reason: '无法解析：' + (error || '未知原因') + '（包名 ' + packageName + '）',
    })
  }
  return results
}

/** Fold per-row verdicts into the three-colour summary the panel shows. */
export function rowVerdict(checks) {
  const list = Array.isArray(checks) ? checks : []
  const bad = list.filter((c) => c.level === 'unavailable')
  const suspect = list.filter((c) => c.level === 'suspect')
  if (bad.length) return { level: 'unavailable', ok: list.length - bad.length - suspect.length, suspect: suspect.length, unavailable: bad.length, problems: bad }
  if (suspect.length) return { level: 'suspect', ok: list.length - suspect.length, suspect: suspect.length, unavailable: 0, problems: suspect }
  return { level: 'ok', ok: list.length, suspect: 0, unavailable: 0, problems: [] }
}

// --- enabled-set state file -------------------------------------------------

export function emptyState() {
  return { version: STATE_VERSION, enabled: [], updatedAt: null }
}

/** A corrupt or unreadable state file degrades to the empty set, never throws. */
export function parseState(text) {
  try {
    const raw = JSON.parse(String(text))
    if (!raw || typeof raw !== 'object' || Array.isArray(raw)) return emptyState()
    const enabled = Array.isArray(raw.enabled) ? raw.enabled.filter((id) => typeof id === 'string' && id !== '') : []
    return { version: STATE_VERSION, enabled, updatedAt: typeof raw.updatedAt === 'string' ? raw.updatedAt : null }
  } catch {
    return emptyState()
  }
}



// --- library scanning -------------------------------------------------------

export function presetsRoot(home) {
  return path.join(home, LIBRARY_DIR)
}
export function legacyPresetsRoot(home) {
  return path.join(home, LEGACY_LIBRARY_DIR)
}
export function stateRoot(home) {
  return path.join(home, STATE_DIR)
}
export function stateFile(home) {
  return path.join(stateRoot(home), STATE_FILE)
}
export function presetDirOf(home, id, legacy) {
  return path.join(legacy ? legacyPresetsRoot(home) : presetsRoot(home), id)
}

/** Read preset.yml. A missing or unreadable file is reported, never fatal. */
export function readMetadata(deps, dir) {
  const file = path.join(dir, METADATA_FILE)
  const text = deps.readText(file)
  const info = { dir, file, name: null, description: null, order: null, error: null }
  if (text === null) return info
  const parsed = parseYaml(text)
  if (!parsed.ok) {
    info.error = parsed.errors.length ? parsed.errors[0].message : 'preset.yml 解析失败'
    return info
  }
  const value = parsed.value && typeof parsed.value === 'object' && !Array.isArray(parsed.value) ? parsed.value : {}
  if (typeof value.name === 'string' && value.name.trim() !== '') info.name = value.name.trim()
  if (typeof value.description === 'string' && value.description.trim() !== '') info.description = value.description.trim()
  if (typeof value.order === 'number') info.order = value.order
  else if (typeof value.order === 'string' && /^-?\d+$/.test(value.order)) info.order = Number(value.order)
  return info
}

/** Read agent.cordis.yml: the plugin row list of one preset. */
export function readComposition(deps, dir) {
  const file = path.join(dir, COMPOSITION_FILE)
  const text = deps.readText(file)
  if (text === null) {
    return { dir, file, text: null, rows: [], error: '缺少 ' + COMPOSITION_FILE + '（目录里没有这个文件，或无法读取）' }
  }
  const parsed = parseYaml(text)
  if (!parsed.ok) {
    const first = parsed.errors.length ? parsed.errors[0] : { line: 0, message: '解析失败' }
    return { dir, file, text, rows: [], error: '第 ' + first.line + ' 行：' + first.message }
  }
  const rows = Array.isArray(parsed.value) ? parsed.value : []
  if (!rows.length) {
    return { dir, file, text, rows: [], error: '组成是空的（没有任何插件行）' }
  }
  const dup = findDuplicateRowIds(rows)
  if (dup.length) {
    return { dir, file, text, rows, error: '行 id 重复：' + dup.join(', ') + '（宿主会拒绝加载重复 id 的组成）' }
  }
  return { dir, file, text, rows, error: null }
}

/** List the preset ids under one library root. A missing root is simply empty. */
export function listIdsIn(deps, root) {
  let entries = []
  try {
    entries = deps.readdir(root) || []
  } catch {
    return []
  }
  const out = []
  for (const entry of entries) {
    if (!entry || entry.startsWith('.')) continue
    const dir = path.join(root, entry)
    if (!deps.isDirectory(dir)) continue
    out.push({ id: entry, dir })
  }
  out.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return out
}

/** Scan both libraries. The legacy directory wins when an id exists in both. */
export function scanLibraries(deps, home) {
  const current = listIdsIn(deps, presetsRoot(home)).map((row) => ({ ...row, legacy: false }))
  const legacy = listIdsIn(deps, legacyPresetsRoot(home)).map((row) => ({ ...row, legacy: true }))
  const map = new Map()
  for (const row of legacy) map.set(row.id, row)
  const shadowed = []
  for (const row of current) {
    if (map.has(row.id)) shadowed.push(row.id)
    else map.set(row.id, row)
  }
  const items = [...map.values()].sort((a, b) => {
    if (a.id < b.id) return -1
    if (a.id > b.id) return 1
    return 0
  })
  return { items, shadowed }
}

// --- state collection -------------------------------------------------------

function runtimeStatusOf(runtime, id, isEnabled) {
  if (!isEnabled) return { status: 'disabled', statusDetail: null }
  if (!runtime || !runtime.supported) {
    return { status: 'failed', statusDetail: runtime && runtime.error ? runtime.error : '当前 DSH 版本不支持运行期声明 preset' }
  }
  const handle = runtime.getHandles ? runtime.getHandles().get(id) : null
  if (handle && handle.error) return { status: 'failed', statusDetail: handle.error }
  if (handle) return { status: 'enabled', statusDetail: null }
  return { status: 'failed', statusDetail: '没有生效的声明（可能是宿主重启前记录的启用状态，重新开关一次即可）' }
}

function conflictStatus(scanned, runtime, state, id) {
  const both = scanned.shadowed.includes(id)
  const isEnabled = state.enabled.includes(id)
  return both
    ? { status: 'conflict', statusDetail: '两个库目录里都有这个 id：' + LEGACY_LIBRARY_DIR + '（旧）优先，' + LIBRARY_DIR + '（新）里的同名目录被忽略' }
    : runtimeStatusOf(runtime, id, isEnabled)
}

export function loadState(deps, home) {
  const file = stateFile(home)
  const text = deps.readText(file)
  const state = text === null ? emptyState() : parseState(text)
  return { file, state, existed: text !== null }
}

function saveState(deps, home, enabled) {
  const file = stateFile(home)
  const state = { version: STATE_VERSION, enabled: [...new Set(enabled)].sort(), updatedAt: new Date().toISOString() }
  deps.ensureDir(path.dirname(file))
  deps.writeTextAtomic(file, JSON.stringify(state, null, 2) + '\n')
  return { file, state }
}

export function collectState(core) {
  const { deps, runtime } = core
  const home = core.home()
  const scanned = scanLibraries(deps, home)
  const { file: stateFilePath, state } = loadState(deps, home)
  const presets = []
  for (const item of scanned.items) {
    const meta = readMetadata(deps, item.dir)
    const composition = readComposition(deps, item.dir)
    const checks = composition.rows.length ? checkRowNames(composition.rows, { baseDir: item.dir, load: deps.load, exists: deps.exists }) : []
    const verdict = rowVerdict(checks)
    const runtimeInfo = conflictStatus(scanned, runtime, state, item.id)
    const status = composition.error && runtimeInfo.status === 'disabled' ? 'invalid' : runtimeInfo.status
    presets.push({
      id: item.id,
      dir: item.dir,
      legacy: item.legacy,
      library: item.legacy ? LEGACY_LIBRARY_DIR : LIBRARY_DIR,
      name: meta.name || item.id,
      description: meta.description,
      order: meta.order,
      status,
      statusDetail: runtimeInfo.statusDetail,
      metadataError: meta.error,
      compositionError: composition.error,
      rowCount: flattenRows(composition.rows).length,
      topLevelRows: composition.rows.length,
      verdict: verdict.level,
      verdictCounts: { ok: verdict.ok, suspect: verdict.suspect, unavailable: verdict.unavailable },
      problems: verdict.problems.map((p) => ({ rowId: p.rowId, name: p.name, level: p.level, reason: p.reason })),
      enabled: state.enabled.includes(item.id),
    })
  }
  const known = new Set(presets.map((p) => p.id))
  const missing = state.enabled.filter((id) => !known.has(id))
  for (const id of missing) {
    presets.push({
      id,
      dir: null,
      legacy: false,
      library: null,
      name: id,
      description: null,
      order: null,
      status: 'missing',
      statusDetail: 'state.json 里记录为启用，但两个库目录里都找不到这个预设',
      metadataError: null,
      compositionError: null,
      rowCount: 0,
      topLevelRows: 0,
      verdict: 'suspect',
      verdictCounts: { ok: 0, suspect: 0, unavailable: 0 },
      problems: [],
      enabled: true,
    })
  }
  presets.sort((a, b) => (a.id < b.id ? -1 : a.id > b.id ? 1 : 0))
  return {
    ok: true,
    plugin: PLUGIN_ID,
    home,
    libraries: {
      current: presetsRoot(home),
      legacy: legacyPresetsRoot(home),
      stateFile: stateFilePath,
      shadowed: scanned.shadowed,
    },
    runtime: {
      supported: Boolean(runtime && runtime.supported),
      error: runtime && runtime.error ? runtime.error : null,
      declared: runtime && runtime.getHandles ? [...runtime.getHandles().keys()] : [],
      versions: runtime && runtime.versions ? runtime.versions : null,
    },
    enabled: state.enabled,
    presets,
  }
}



// --- message helpers --------------------------------------------------------

const MSG = {
  serviceUnavailable: '当前 DSH 版本没有 agent preset 注册表服务，无法运行期声明预设；本页只能查看与编辑，启用/停用不可用。',
  idInvalid: '预设 id 只能是 1-64 位小写字母、数字、短横线或下划线，且必须以字母或数字开头。',
  idTaken: '同名预设已经存在，拒绝覆盖：',
  noMetadata: '这个目录里既没有 preset.yml，也没有 agent.cordis.yml —— 它看起来不是一个预设目录。',
  skeleton: '读取内置 standard 预设的插件清单失败，已取消创建（不会留下半个预设）。',
  confirmRequired: '删除是不可撤销的操作，需要二次确认。',
  saveFailedBackup: '写入备份失败，已拒绝保存（组合文件保持原样，磁盘与面板内容一致）。',
  partialDelete: '已撤除声明，但目录未能删除：',
}

// --- command results --------------------------------------------------------

function failure(error, extra) {
  return { ok: false, error, retryable: true, ...(extra || {}) }
}

function noId() {
  return failure('缺少参数 id')
}

export function relativeToRoot(root, target) {
  const rel = path.relative(root, target)
  if (rel === '' || rel.startsWith('..') || path.isAbsolute(rel)) return null
  return rel
}

export function readStandardSkeleton(deps, candidates) {
  const list = Array.isArray(candidates) ? candidates.filter((c) => typeof c === 'string' && c !== '') : []
  const tried = []
  let doc = null
  for (const file of list) {
    tried.push(file)
    const text = deps.readText(file)
    if (text === null) continue
    const parsed = parseYaml(text)
    if (!parsed.ok) continue
    const rows = Array.isArray(parsed.value) ? parsed.value : []
    const declaration = rows
      .map((row) => (row && Array.isArray(row.insert) ? row.insert : []))
      .flat()
      .find((row) => row && row.id === 'preset-standard')
    const plugins = declaration && declaration.config && declaration.config.plugins
    if (Array.isArray(plugins) && plugins.length) {
      doc = { plugins, source: file }
      break
    }
  }
  if (!doc) {
    return { ok: false, error: MSG.skeleton, tried, candidates: list }
  }
  return { ok: true, rows: doc.plugins, source: doc.source, tried }
}

// --- operations -------------------------------------------------------------

function applyEnabled(core, id, enabled) {
  const { deps, runtime } = core
  const home = core.home()
  const scanned = scanLibraries(deps, home)
  const item = scanned.items.find((row) => row.id === id)
  if (enabled && !item) return failure('找不到这个预设的目录，无法启用：' + id)
  if (!enabled && !scanned.items.some((row) => row.id === id) && !loadState(deps, home).state.enabled.includes(id)) {
    return failure('找不到这个预设，无法停用：' + id)
  }
  if (enabled && (!runtime || !runtime.supported)) return failure(runtime && runtime.error ? runtime.error : MSG.serviceUnavailable)

  let declaration = null
  let restore = null
  if (enabled) {
    const meta = readMetadata(deps, item.dir)
    const composition = readComposition(deps, item.dir)
    if (composition.error) return failure(composition.error)
    if (composition.rows.length === 0) return failure('组成是空的，没有可以声明的插件行。')
    let definitionRows = composition.rows
    const needName = !meta.name
    if (needName) definitionRows = definitionRows.map((row) => row)
    const result = runtime.enable({
      id,
      name: meta.name || id,
      description: meta.description || undefined,
      order: typeof meta.order === 'number' ? meta.order : undefined,
      plugins: definitionRows,
      dir: item.dir,
    })
    if (!result || !result.ok) {
      const message = String((result && result.error) || '注册失败')
      const hint = /already|duplicate|Duplicate/i.test(message) ? '（宿主里已经有一个同名声明）' : ''
      return failure('宿主注册预设失败：' + message + hint)
    }
    declaration = result
    restore = result.dispose
  } else {
    const result = runtime.disable(id)
    if (result && result.ok === false) return failure(String(result.error || '撤除声明失败'))
  }

  const current = loadState(deps, home)
  const next = enabled ? [...current.state.enabled, id] : current.state.enabled.filter((row) => row !== id)
  try {
    saveState(deps, home, next)
  } catch (error) {
    if (enabled && typeof restore === 'function') {
      try { restore() } catch { /* the state write already failed; nothing else to do */ }
    }
    return failure('保存启用状态失败：' + String((error && error.message) || error))
  }
  const collected = collectState(core)
  return { ok: true, id, enabled: Boolean(enabled), declaration: declaration ? { id: declaration.id, broken: declaration.broken || null } : null, state: collected }
}

function readSourcePreset(deps, sourceDir) {
  if (!deps.isDirectory(sourceDir)) return { ok: false, error: '这个路径不是一个目录：' + sourceDir }
  if (!deps.exists(path.join(sourceDir, METADATA_FILE)) && !deps.exists(path.join(sourceDir, COMPOSITION_FILE))) {
    return { ok: false, error: MSG.noMetadata }
  }
  const meta = readMetadata(deps, sourceDir)
  const composition = readComposition(deps, sourceDir)
  if (composition.error && !deps.exists(path.join(sourceDir, COMPOSITION_FILE))) {
    return { ok: false, error: composition.error }
  }
  return {
    ok: true,
    meta,
    composition,
    id: path.basename(sourceDir),
    name: meta.name || path.basename(sourceDir),
    description: meta.description,
    rowCount: flattenRows(composition.rows).length,
  }
}

/**
 * Free means free in the library we are about to write into. The legacy library
 * does not count: migrating a preset copies it next to the current one, and the
 * legacy entry itself always shadows it anyway, so counting that entry would
 * make every migration look like a collision with itself.
 */
function destinationFree(deps, home, id, targetLegacy) {
  const root = targetLegacy ? legacyPresetsRoot(home) : presetsRoot(home)
  const taken = listIdsIn(deps, root).some((row) => row.id === id)
  return !taken
}

function performImport(core, opts) {
  const { deps } = core
  const home = core.home()
  const sourceDir = path.resolve(String(opts.sourceDir || ''))
  const id = typeof opts.id === 'string' && opts.id !== '' ? opts.id : path.basename(sourceDir)
  const targetLegacy = opts.target === 'legacy'
  const preflight = opts.preflight === true
  const prepared = readSourcePreset(deps, sourceDir)
  if (!prepared.ok) return failure(prepared.error)
  if (!PRESET_ID_RE.test(id)) return failure(MSG.idInvalid)
  if (!opts.overwrite && !destinationFree(deps, home, id, targetLegacy)) return failure(MSG.idTaken + id)
  const targetDir = presetDirOf(home, id, targetLegacy)
  if (preflight) {
    return {
      ok: true,
      preflight: true,
      id,
      name: prepared.name,
      description: prepared.description,
      rowCount: prepared.rowCount,
      sourceDir,
      targetDir,
      legacy: prepared.meta.dir.includes(LEGACY_LIBRARY_DIR),
      compositionError: prepared.composition.error,
    }
  }
  const written = []
  deps.ensureDir(targetDir)
  const metaText = deps.readText(path.join(sourceDir, METADATA_FILE))
  deps.writeTextAtomic(path.join(targetDir, METADATA_FILE), metaText === null ? defaultMetadataText(prepared.name, prepared.description) : metaText)
  written.push(METADATA_FILE)
  const rawComposition = deps.readText(path.join(sourceDir, COMPOSITION_FILE))
  const finalCompositionText = rawComposition === null ? compositionText([]) : rawComposition
  deps.writeTextAtomic(path.join(targetDir, COMPOSITION_FILE), finalCompositionText)
  written.push(COMPOSITION_FILE)
  // Anything else the preset carried along (helper modules, notes) is copied too:
  // a preset that references ./helper.mjs would otherwise import as a broken one.
  if (typeof deps.copyFile === 'function' && typeof deps.readdir === 'function') {
    let entries = []
    try {
      entries = deps.readdir(sourceDir)
    } catch { entries = [] }
    for (const entry of entries) {
      if (entry === METADATA_FILE || entry === COMPOSITION_FILE || entry === BACKUP_DIR) continue
      let isDir = false
      try {
        isDir = deps.isDirectory(path.join(sourceDir, entry))
      } catch { isDir = false }
      if (isDir) continue
      try {
        deps.copyFile(path.join(sourceDir, entry), path.join(targetDir, entry))
        written.push(entry)
      } catch (error) {
        return {
          ok: false,
          error: '复制附加文件失败：' + entry + '（' + String((error && error.message) || error) + '）',
          id,
          targetDir,
          written,
          state: collectState(core),
        }
      }
    }
  }
  return { ok: true, id, targetDir, written, compositionError: prepared.composition.error, state: collectState(core) }
}

/**
 * The core hands host-core everything it may touch: injected deps, the runtime
 * probe, and a home getter (tests point it at a throwaway directory).
 */
export function createCore(deps) {
  return { deps, runtime: deps.runtime || null, home: () => deps.home }
}

// --- operations -------------------------------------------------------------

/**
 * Resolve a directory argument to a preset directory.
 * The client always sends an absolute directory AND an id; the directory is
 * accepted only when it really is one of the scan roots' children, so an
 * arbitrary path can never be reached through this API.
 */
export function resolvePresetDir(deps, home, id, dirArg) {
  if (typeof id !== 'string' || id === '' || !PRESET_ID_RE.test(id)) return { ok: false, error: MSG.idInvalid }
  const scanned = scanLibraries(deps, home)
  const item = scanned.items.find((row) => row.id === id)
  if (!item) return { ok: false, error: '找不到预设目录：' + id }
  if (typeof dirArg === 'string' && dirArg !== '') {
    const asked = path.resolve(dirArg)
    if (asked !== path.resolve(item.dir)) {
      return { ok: false, error: '目录与 id 不匹配（' + asked + ' ≠ ' + item.dir + '）' }
    }
  }
  return { ok: true, dir: item.dir, legacy: item.legacy, item }
}

function stamp() {
  return new Date().toISOString().replace(/[:.]/g, '-')
}

export function createOperations(deps) {
  const core = createCore(deps)
  const home = deps.home
  const homeLabel = legacy => (legacy ? LEGACY_LIBRARY_DIR : LIBRARY_DIR)

  function applyEnabledCmd(id, enabled) {
    const result = applyEnabled(core, id, enabled)
    if (!result.ok) return { ok: false, error: result.error, state: collectState(core) }
    return { ok: true, id, enabled: Boolean(enabled), declaration: result.declaration, state: result.state }
  }

  async function createCmd(body) {
    const id = typeof body.id === 'string' ? body.id.trim() : ''
    if (!PRESET_ID_RE.test(id)) return { ok: false, error: MSG.idInvalid, state: collectState(core) }
    if (!destinationFree(deps, home, id)) return { ok: false, error: MSG.idTaken + id, state: collectState(core) }
    const skeleton = readStandardSkeleton(deps, deps.standardSkeletonCandidates())
    if (!skeleton.ok) return { ok: false, error: skeleton.error, tried: skeleton.tried, state: collectState(core) }
    const name = typeof body.name === 'string' && body.name.trim() !== '' ? body.name.trim() : id
    const description = typeof body.description === 'string' && body.description.trim() !== '' ? body.description.trim() : null
    const order = typeof body.order === 'number' && Number.isFinite(body.order) ? body.order : null
    const targetDir = presetDirOf(home, id, body.target === 'legacy')
    try {
      deps.ensureDir(targetDir)
      deps.writeTextAtomic(path.join(targetDir, METADATA_FILE), defaultMetadataText(name, description, order))
      deps.writeTextAtomic(path.join(targetDir, COMPOSITION_FILE), compositionText(skeleton.rows))
    } catch (error) {
      return { ok: false, error: '写入新预设失败：' + String((error && error.message) || error), state: collectState(core) }
    }
    return { ok: true, id, dir: targetDir, rowCount: flattenRows(skeleton.rows).length, skeletonSource: skeleton.source, state: collectState(core) }
  }

  async function saveCmd(body) {
    const resolved = resolvePresetDir(deps, home, body.id, body.dir)
    if (!resolved.ok) return { ok: false, error: resolved.error, state: collectState(core) }
    if (typeof body.text !== 'string' || body.text.trim() === '') {
      return { ok: false, error: '提交的组合是空的，已拒绝保存。', state: collectState(core) }
    }
    const parsed = parseYaml(body.text)
    if (!parsed.ok) {
      const first = parsed.errors.length ? parsed.errors[0] : { line: 0, message: '解析失败' }
      return { ok: false, error: '第 ' + first.line + ' 行：' + first.message, state: collectState(core) }
    }
    const rows = Array.isArray(parsed.value) ? parsed.value : []
    if (!rows.length) return { ok: false, error: '组合里没有任何插件行，已拒绝保存。', state: collectState(core) }
    const dup = findDuplicateRowIds(rows)
    if (dup.length) return { ok: false, error: '行 id 重复：' + dup.join(', '), state: collectState(core) }
    const file = path.join(resolved.dir, COMPOSITION_FILE)
    let backup = null
    try {
      backup = deps.backupFile(file, BACKUP_KEEP)
    } catch (error) {
      return { ok: false, error: MSG.saveFailedBackup + ' ' + String((error && error.message) || error), state: collectState(core) }
    }
    try {
      deps.writeTextAtomic(file, compositionText(rows))
    } catch (error) {
      return { ok: false, error: '写入组合失败：' + String((error && error.message) || error), backup, state: collectState(core) }
    }
    // An enabled preset keeps its old declaration: the panel tells the user to
    // toggle it off and on again to activate the new composition.
    return { ok: true, id: body.id, file, backup, rowCount: flattenRows(rows).length, state: collectState(core) }
  }

  async function removeCmd(body) {
    const resolved = resolvePresetDir(deps, home, body.id, body.dir)
    if (!resolved.ok) return { ok: false, error: resolved.error, state: collectState(core) }
    if (body.confirm !== true) {
      return { ok: false, needsConfirm: true, error: MSG.confirmRequired, id: body.id, dir: resolved.dir, state: collectState(core) }
    }
    let undeclared = false
    if (core.runtime && core.runtime.supported && core.runtime.getHandles().has(body.id)) {
      const off = core.runtime.disable(body.id)
      if (off && off.ok === false) return { ok: false, error: '撤除声明失败：' + String(off.error || ''), state: collectState(core) }
      undeclared = true
    }
    const current = loadState(deps, home)
    if (current.state.enabled.includes(body.id)) {
      try {
        saveState(deps, home, current.state.enabled.filter((row) => row !== body.id))
      } catch (error) {
        return { ok: false, error: '更新启用状态失败：' + String((error && error.message) || error), state: collectState(core) }
      }
    }
    let dirRemoved = false
    let dirError = null
    try {
      deps.removeDir(resolved.dir)
      dirRemoved = true
    } catch (error) {
      dirError = String((error && error.message) || error)
    }
    return {
      ok: true,
      id: body.id,
      dir: resolved.dir,
      undeclared,
      dirRemoved,
      ...(dirRemoved ? {} : { warning: MSG.partialDelete + resolved.dir + '（' + dirError + '）' }),
      state: collectState(core),
    }
  }

  async function importCmd(body) {
    if (typeof body.sourceDir !== 'string' || body.sourceDir.trim() === '') return { ok: false, error: '缺少参数 sourceDir' }
    const result = performImport(core, {
      sourceDir: body.sourceDir.trim(),
      id: typeof body.id === 'string' && body.id !== '' ? body.id.trim() : undefined,
      target: body.target,
      preflight: body.confirm !== true,
    })
    if (!result.ok) return { ok: false, error: result.error, state: collectState(core) }
    return { ...result, state: collectState(core) }
  }

  async function migrateCmd(body) {
    const askedIds = Array.isArray(body.ids) && body.ids.length ? body.ids.map((row) => String(row)) : null
    const scanned = scanLibraries(deps, home)
    const legacyItems = scanned.items.filter((row) => row.legacy)
    const targets = askedIds ? legacyItems.filter((row) => askedIds.includes(row.id)) : legacyItems
    const currentIds = new Set(listIdsIn(deps, presetsRoot(home)).map((row) => row.id))
    const plans = []
    for (const item of targets) {
      const meta = readMetadata(deps, item.dir)
      // Migrating is a copy, never a move: the legacy library stays in charge of
      // this id until the user removes it. A plan whose current library already
      // has the same id is flagged so the panel can say so before anything runs.
      const conflict = currentIds.has(item.id)
      const composition = readComposition(deps, item.dir)
      const checks = composition.rows.length ? checkRowNames(composition.rows, { baseDir: item.dir, load: deps.load, exists: deps.exists }) : []
      const verdict = rowVerdict(checks)
      plans.push({
        id: item.id,
        sourceDir: item.dir,
        dir: item.dir,
        legacy: true,
        name: meta.name || item.id,
        description: meta.description,
        order: meta.order,
        rowCount: flattenRows(composition.rows).length,
        compositionError: composition.error,
        verdict: verdict.level,
        status: conflict ? 'conflict' : 'ready',
        conflict,
        problems: verdict.problems.map((p) => ({ rowId: p.rowId, name: p.name, level: p.level, reason: p.reason })),
      })
    }
    if (body.confirm !== true) {
      return { ok: true, preflight: true, plans, migrated: [], skipped: [], state: collectState(core) }
    }
    const migrated = []
    const skipped = []
    for (const plan of plans) {
      // Confirmed migration overwrites on purpose: the copy goes into the
      // current library, and the legacy entry keeps being the one in charge
      // until the user removes it from the old folder.
      const result = performImport(core, { sourceDir: plan.dir, id: plan.id, target: 'current', preflight: false, overwrite: true })
      if (result.ok) migrated.push({ id: plan.id, dir: result.targetDir })
      else skipped.push({ id: plan.id, reason: result.error })
    }
    return { ok: true, preflight: false, plans, migrated, skipped, state: collectState(core) }
  }

  /**
   * Read one preset's composition file for the editor.
   *
   * The panel used to fetch the file straight from disk, which browsers cannot
   * do; the text travels through this endpoint instead and stays read-only on
   * this side. The state rides along so the panel never has to refresh after an
   * edit is opened.
   */
  async function fileCmd(body) {
    const resolved = resolvePresetDir(deps, home, body.id, body.dir)
    if (!resolved.ok) return { ok: false, error: resolved.error, state: collectState(core) }
    const file = path.join(resolved.dir, COMPOSITION_FILE)
    let text = null
    try {
      text = deps.readText(file)
    } catch (error) {
      return { ok: false, error: '读取组合失败：' + String((error && error.message) || error), state: collectState(core) }
    }
    return { ok: true, id: body.id, dir: resolved.dir, file, text, state: collectState(core) }
  }

  return { applyEnabled: applyEnabledCmd, create: createCmd, save: saveCmd, remove: removeCmd, import: importCmd, migrate: migrateCmd, file: fileCmd }
}

