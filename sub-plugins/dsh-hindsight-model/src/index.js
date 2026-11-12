// dsh-hindsight-model: HOST half — cordis wiring.
//
// Responsibilities that must live host-side:
//   - the profile `.env` and the daemon log are files;
//   - `reg query` / `Get-NetTCPConnection` are child processes;
//   - DSH's resolved API keys have no client-facing remote surface, so the only
//     place a plaintext key can be obtained is here.
//
// Everything non-trivial (parsing, merging, judgement) lives in ./host-core.js
// and is driven by the injected `deps` below, which the offline harness fakes.
//
// No @deepseek-ai/* imports: a `link:`-ed host half cannot resolve them, and
// the plugin needs nothing beyond injected services (see design.md D1).
//
// Verified: 2026-09-13, change 2026-09-13-add-hindsight-model-panel.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { execFile } from 'node:child_process'

import {
  API_PREFIX,
  NS,
  PLUGIN_ID,
  createCore,
  parseDaemonProbe,
} from './host-core.js'

export const name = 'hindsight-model'

/** Every service is optional: a missing one degrades a feature, never apply(). */
export const inject = []

const ROUTES = {
  state: `${API_PREFIX}/state`,
  save: `${API_PREFIX}/save`,
  dshModel: `${API_PREFIX}/dsh-model`,
  verify: `${API_PREFIX}/verify`,
  cleanEnv: `${API_PREFIX}/clean-env`,
  daemon: `${API_PREFIX}/daemon`,
  auto: `${API_PREFIX}/auto`,
}

/** The exact route table, exported so the harness can assert it. */
export const ROUTE_TABLE = Object.values(ROUTES)

export { PLUGIN_ID, API_PREFIX, ROUTES }

// --- real deps --------------------------------------------------------------

const IS_WINDOWS = process.platform === 'win32'

/** Resolve a bare tool name to something CreateProcess will find. */
function toolPath(tool) {
  if (!IS_WINDOWS) return null
  if (tool === 'reg') return 'reg.exe'
  if (tool === 'powershell') return 'powershell.exe'
  return tool
}

function runCommand(args) {
  return new Promise((resolve) => {
    const [tool, ...rest] = Array.isArray(args) ? args : []
    const file = toolPath(tool)
    if (!file) {
      resolve({ ok: false, stdout: '', stderr: `unsupported platform for ${tool}`, error: 'unsupported-platform' })
      return
    }
    execFile(file, rest, { timeout: 15000, windowsHide: true, maxBuffer: 4 * 1024 * 1024 }, (error, stdout, stderr) => {
      resolve({
        ok: !error,
        stdout: stdout || '',
        stderr: stderr || '',
        error: error ? String(error.message || error) : null,
      })
    })
  })
}

async function httpGetJson(url) {
  const response = await fetch(url, { headers: { accept: 'application/json' } })
  if (!response.ok) throw new Error(`http ${response.status}`)
  return response.json()
}

/**
 * Run one daemon lifecycle step.
 *
 * `env` is the SANITIZED environment the core built — passing it through is
 * what keeps the profile authoritative, so it must never be dropped here.
 * `uv` is a real executable (not a shell shim), so no shell is needed even on
 * Windows, which keeps the argv exactly what the panel displays.
 */
function spawnCommand(file, args, options = {}) {
  return new Promise((resolve) => {
    execFile(
      file,
      args,
      {
        env: options.env,
        cwd: options.cwd,
        timeout: options.timeoutMs || 120000,
        windowsHide: true,
        maxBuffer: 4 * 1024 * 1024,
      },
      (error, stdout, stderr) => {
        resolve({
          ok: !error,
          code: error && typeof error.code === 'number' ? error.code : (error ? null : 0),
          timedOut: Boolean(error && (error.killed || error.signal === 'SIGTERM')),
          stdout: stdout || '',
          stderr: stderr || '',
        })
      },
    )
  })
}

/** `prefix*` listing without pulling in a glob dependency. */
function listByPrefix(pattern) {
  const dir = path.dirname(pattern)
  const prefix = path.basename(pattern)
  if (!prefix.endsWith('*')) return []
  const head = prefix.slice(0, -1)
  try {
    return fs.readdirSync(dir).filter((entry) => entry.startsWith(head)).map((entry) => path.join(dir, entry))
  } catch {
    return []
  }
}

function filesystemDeps() {
  const hindsightHome = path.join(os.homedir(), '.hindsight')
  return {
    hindsightHome,
    readText: (p) => {
      try {
        return fs.readFileSync(p, 'utf8')
      } catch {
        return null
      }
    },
    mtimeOf: (p) => {
      try {
        return fs.statSync(p).mtime
      } catch {
        return null
      }
    },
    writeText: (p, text) => fs.writeFileSync(p, text, 'utf8'),
    // Binary access exists for ONE reason: the daemon's launcher is judged by
    // the subsystem its own PE header declares (see healLauncher in the core).
    readBinary: (p) => {
      try {
        return fs.readFileSync(p)
      } catch {
        return null
      }
    },
    writeBinary: (p, bytes) => fs.writeFileSync(p, bytes),
    removeFile: (p) => {
      try {
        fs.rmSync(p, { force: true })
      } catch { /* nothing to clean up */ }
    },
    ensureDir: (p) => fs.mkdirSync(p, { recursive: true }),
    rename: (from, to) => fs.renameSync(from, to),
    glob: listByPrefix,
    timestamp: () => new Date().toISOString().replace(/[:.]/g, '-'),
    isoNow: () => new Date().toISOString(),
    run: runCommand,
    spawn: spawnCommand,
    httpGetJson,
    env: process.env,
  }
}

// --- DSH side ---------------------------------------------------------------

/**
 * Read DSH's model facts through injected services only.
 *
 * Three things are worth remembering:
 *  - `agentDefaultModel` is a service whose read is a METHOD (`currentSelection()`),
 *    not a property;
 *  - a provider route's `baseURL` appears in NO enumerable API — it can only be
 *    reached by locating the configurable-provider entry and drilling into the
 *    settings namespace along `settingsPath`;
 *  - the resolved secret may only ever be used host-side. Nothing in this file
 *    logs it or returns it to a caller that serializes a response.
 */
export function createDshReader(ctx) {
  const get = (service) => {
    try {
      return typeof ctx.get === 'function' ? ctx.get(service) : null
    } catch {
      return null
    }
  }

  /**
   * 读一个设置命名空间的值：0.1.x 走 `settings.get(ns)`；0.2.0 的设置服务没有 `get`，
   * 改从 `describe()` 的条目列表里按 ns 取 `value`（0.2.0 的 ns 就是条目 id）。
   */
  function readSettingsNamespace(settings, ns) {
    if (typeof settings.get === 'function') return settings.get(ns)
    if (typeof settings.describe === 'function') {
      const rows = settings.describe() || []
      const row = Array.isArray(rows) ? rows.find((candidate) => candidate && candidate.ns === ns) : undefined
      return row ? row.value : undefined
    }
    return undefined
  }

  function routeOf(provider) {
    const llm = get('llm')
    const settings = get('settings')
    if (!llm || !settings || !provider) return null
    let entry = null
    try {
      entry = (llm.listConfigurableProviders() || []).find((candidate) => candidate.provider === provider) || null
    } catch {
      return null
    }
    if (!entry) return null
    let node
    try {
      node = readSettingsNamespace(settings, entry.settingsNs)
    } catch {
      return null
    }
    for (const segment of entry.settingsPath || []) {
      if (node === null || node === undefined) return null
      node = node[segment]
    }
    if (!node) return null
    return {
      settingsNs: entry.settingsNs,
      settingsPath: entry.settingsPath || [],
      baseURL: typeof node.baseURL === 'string' ? node.baseURL : null,
      apiKeyEnv: typeof node.apiKeyEnv === 'string' ? node.apiKeyEnv : null,
    }
  }

  /** Resolve the DSH-side key. The value NEVER leaves the host process. */
  async function resolveApiKey() {
    const credentials = get('credentials')
    if (!credentials || typeof credentials.resolve !== 'function') return null
    const selection = currentSelection()
    if (!selection || !selection.provider) return null
    const route = routeOf(selection.provider)
    if (!route || !route.apiKeyEnv) return null
    try {
      const resolved = await credentials.resolve(route.apiKeyEnv)
      if (!resolved || typeof resolved.value !== 'string') return null
      return { value: resolved.value, source: route.apiKeyEnv }
    } catch {
      return null
    }
  }

  function currentSelection() {
    const service = get('agentDefaultModel')
    if (!service) return null
    try {
      const selection = typeof service.currentSelection === 'function'
        ? service.currentSelection()
        : null
      if (!selection) return null
      return {
        provider: selection.provider ?? null,
        model: selection.model ?? null,
        reasoningEffort: selection.reasoningEffort ?? null,
      }
    } catch {
      return null
    }
  }

  /** Metadata-only view of the DSH key: never the plaintext. */
  async function keyMetadata() {
    const selection = currentSelection()
    const route = selection && selection.provider ? routeOf(selection.provider) : null
    if (!route || !route.apiKeyEnv) return { hasValue: false, length: null, source: null }
    const credentials = get('credentials')
    if (!credentials || typeof credentials.resolve !== 'function') {
      return { hasValue: false, length: null, source: route.apiKeyEnv }
    }
    try {
      const resolved = await credentials.resolve(route.apiKeyEnv)
      if (!resolved || typeof resolved.value !== 'string') {
        return { hasValue: false, length: null, source: route.apiKeyEnv }
      }
      return { hasValue: true, length: resolved.value.length, source: route.apiKeyEnv }
    } catch {
      return { hasValue: false, length: null, source: route.apiKeyEnv }
    }
  }

  /** Everything the panel is allowed to know about the DSH side. */
  async function snapshot() {
    const missing = []
    if (!get('agentDefaultModel')) missing.push('agentDefaultModel')
    if (!get('llm')) missing.push('llm')
    if (!get('settings')) missing.push('settings')
    if (!get('credentials')) missing.push('credentials')
    const selection = currentSelection()
    const route = selection && selection.provider ? routeOf(selection.provider) : null
    const key = await keyMetadata()
    let providers = []
    try {
      const llm = get('llm')
      providers = llm && typeof llm.listProviders === 'function' ? (llm.listProviders() || []) : []
    } catch {
      providers = []
    }
    return {
      available: missing.length === 0,
      missing,
      selection,
      route,
      key,
      providers,
    }
  }

  return { snapshot, currentSelection, routeOf, keyMetadata, resolveApiKey }
}

// --- transport --------------------------------------------------------------

function sendJson(res, status, payload) {
  const body = JSON.stringify(payload)
  res.writeHead(status, {
    'content-type': 'application/json; charset=utf-8',
    'content-length': Buffer.byteLength(body),
    'cache-control': 'no-store',
  })
  res.end(body)
}

function readJsonBody(req, limit = 64 * 1024) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    let settled = false
    const finish = (value) => {
      if (settled) return
      settled = true
      resolve(value)
    }
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        finish({ ok: false, error: 'body too large' })
        return
      }
      chunks.push(chunk)
    })
    req.on('end', () => {
      if (chunks.length === 0) {
        finish({ ok: true, value: {} })
        return
      }
      try {
        finish({ ok: true, value: JSON.parse(Buffer.concat(chunks).toString('utf8')) })
      } catch {
        finish({ ok: false, error: 'invalid JSON body' })
      }
    })
    req.on('error', () => finish({ ok: false, error: 'request error' }))
  })
}

/**
 * Build the route handlers over a core + DSH reader.
 * Exported so the harness can drive the contract without a real server.
 */
export function createHandlers({ core, dsh }) {
  const guard = (fn) => async (req, res) => {
    let body = {}
    if (req.method === 'POST') {
      const parsed = await readJsonBody(req)
      if (!parsed.ok) {
        sendJson(res, 400, { ok: false, error: parsed.error })
        return
      }
      body = parsed.value
    }
    try {
      await fn(req, res, body)
    } catch (error) {
      sendJson(res, 500, { ok: false, error: String((error && error.message) || error) })
    }
  }

  return {
    [ROUTES.state]: guard(async (req, res) => {
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
      sendJson(res, 200, await core.collectState({ dsh }))
    }),

    [ROUTES.dshModel]: guard(async (req, res) => {
      if (req.method !== 'GET') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
      // `snapshot()` carries key METADATA only; the plaintext stays host-side.
      sendJson(res, 200, { ok: true, dsh: await dsh.snapshot() })
    }),

    [ROUTES.save]: guard(async (req, res, body) => {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
      let resolvedKey
      if (body && body.useDshKey === true) {
        const resolved = await dsh.resolveApiKey()
        if (!resolved) {
          sendJson(res, 400, { ok: false, error: 'no DSH API key is resolvable for the current route' })
          return
        }
        resolvedKey = resolved.value
      }
      const result = core.save(body && body.changes, { resolvedKey })
      if (!result.ok) {
        const status = result.code === 'invalid-changes' ? 400 : 500
        sendJson(res, status, result)
        return
      }
      sendJson(res, 200, result)
    }),

    [ROUTES.verify]: guard(async (req, res) => {
      if (req.method !== 'POST' && req.method !== 'GET') {
        return sendJson(res, 405, { ok: false, error: 'method not allowed' })
      }
      sendJson(res, 200, await core.verify())
    }),

    [ROUTES.cleanEnv]: guard(async (req, res, body) => {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
      // Deleting user-level environment variables is irreversible in the shell;
      // require an explicit confirmation flag on the request itself.
      if (!body || body.confirm !== true) {
        sendJson(res, 400, { ok: false, error: 'confirmation required' })
        return
      }
      const result = await core.cleanEnv({ keys: body.keys })
      sendJson(res, result.ok ? 200 : 500, result)
    }),

    [ROUTES.daemon]: guard(async (req, res, body) => {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
      // stop/restart interrupt in-flight memory work, so they need the caller to
      // say so explicitly — the panel's inline confirm is what sets this.
      const result = await core.daemonAction(body && body.action, { confirm: body && body.confirm === true })
      if (result.ok) return sendJson(res, 200, result)
      const status = result.code === 'busy'
        ? 409
        : (['bad-action', 'confirm-required', 'no-command'].includes(result.code) ? 400 : 500)
      return sendJson(res, status, result)
    }),

    [ROUTES.auto]: guard(async (req, res, body) => {
      if (req.method !== 'POST') return sendJson(res, 405, { ok: false, error: 'method not allowed' })
      // The switch lives in this plugin's settings namespace, so the DSH
      // settings page and this panel edit the same key.
      const result = await core.setAutoStart(body && body.enabled)
      if (result.ok) return sendJson(res, 200, result)
      const status = result.code === 'invalid-value' ? 400 : 500
      return sendJson(res, status, result)
    }),
  }
}

/** Attach the route table to a host that exposes `register`. */
export function registerRoutes(ctx, host, handlers) {
  for (const [routePath, handler] of Object.entries(handlers)) {
    ctx.effect(() => host.register({ kind: 'exact', path: routePath, handler }))
  }
}

// --- settings section (optional, dynamic schemastery like sibling plugins) ----

/** The one key this plugin stores in its own settings namespace. */
export const AUTO_FIELD = 'autoStart'
export const AUTO_DEFAULT = true

/** Host-side diagnostics: whether the namespace registered, and its value. */
export const HOST_DIAG = {
  /** Whether this plugin's settings namespace got registered at all. */
  settingsSectionRegistered: false,
  /** Why the WRITE path is unavailable (null when it works). */
  settingsSectionError: null,
  /** Which schema registered the namespace: schemastery | fallback | unavailable. */
  schemaSource: 'unavailable',
  autoStartValue: null,
}

/**
 * Zero-dependency section schema compatible with the settings provider's use of
 * a schemastery schema — the same fallback the sibling plugins ship. It MUST
 * register even when `@deepseek-ai/schemastery` cannot be resolved from this
 * bundle (a `link:`-ed host half resolves bare specifiers against the plugin
 * source dir), otherwise the panel's write is rejected with "namespace is not
 * registered" and the switch would be dead.
 */
function fallbackSectionSchema(field, fallback) {
  const schema = (input) => {
    const source = (input && typeof input === 'object' && !Array.isArray(input)) ? input : {}
    const raw = source[field]
    const out = { ...source }
    out[field] = typeof raw === 'boolean' ? raw : fallback
    return out
  }
  schema.toJSON = () => ({
    type: 'object',
    properties: { [field]: { type: 'boolean', default: fallback } },
  })
  return schema
}

/**
 * 0.2.0 条目配置：本插件的 profile 行就是设置命名空间（ns = 条目 id）。
 *
 * 0.2.0 退役了 `settings.installSection` / `register`；设置服务改为投影条目自己导出的
 * `Config`，对其它 ns 抛 `No configurable plugin entry`。link: 宿主半解析不到
 * `@deepseek-ai/schemastery`，schema 手写（同 dsh-notify-hub / dsh-esc-rewind）：
 * `~standard.validate` 给 cordis、`meta.volatile` + 真实 refs 表 `toJSON()` 给设置服务、
 * `~standard.vendor` 故意不叫 schemastery（让写配置走条目重启，apply 拿到新值）。
 */
const CONFIG_SCHEMA_JSON = Object.freeze({"uid":7,"refs":{"5":{"type":"boolean","meta":{"default":true}},"7":{"type":"object","meta":{"default":{},"volatile":true},"dict":{"autoStart":5}}}})

/** 归一化条目配置：只认领 autoStart，其余键原样保留。 */
export function normalizeEntryConfig(input) {
  const source = (input && typeof input === 'object' && !Array.isArray(input)) ? input : {}
  const raw = source[AUTO_FIELD]
  return Object.assign({}, source, { [AUTO_FIELD]: typeof raw === 'boolean' ? raw : AUTO_DEFAULT })
}

/** 导出给 loader / 设置服务。 */
function entryConfigSchema() {
  const schema = (input) => normalizeEntryConfig(input)
  schema.meta = { volatile: true }
  schema.type = 'object'
  schema.toJSON = () => JSON.parse(JSON.stringify(CONFIG_SCHEMA_JSON))
  schema['~standard'] = {
    version: 1,
    vendor: 'dsh-hindsight-model',
    validate(value) {
      try { return { value: normalizeEntryConfig(value) } }
      catch (error) { return { issues: [{ message: (error && error.message) ? error.message : String(error) }] } }
    },
  }
  return schema
}

/** 本插件在 profile 里的条目 id（管理器按目录名去掉 dsh- 前缀写入）。 */
export const ENTRY_ID = 'hindsight-model'

/** 导出的 Config。 */
export const Config = entryConfigSchema()

/**
 * Register this plugin's settings namespace and keep a writable handle on it.
 *
 * The real API matters here: `installSection()` registers the namespace (what
 * the settings page and `remote.settings.update` need) but hands back NOTHING,
 * so a host half could only read. `register(ns, schema, { base })` returns the
 * owner scope — `get()` / `update(patch)` — which is the only way this half can
 * write the switch. So: prefer `register`, fall back to `installSection` for a
 * read-only namespace, and if neither exists the switch degrades to disabled
 * with a reason rather than pretending to save.
 *
 * The schema is schemastery when it can be imported (a `link:`-ed host half
 * often cannot resolve it) and a zero-dependency equivalent otherwise — the
 * namespace MUST register either way.
 */
/** Survives an HMR re-apply: `register()` fails loud on a duplicate namespace. */
let autoScope = null

/** 最近一次 apply(ctx, config) 拿到的条目配置（0.2.0；写配置会重启条目并刷新它）。 */
let latestEntryConfig = null

/**
 * 0.2.0 条目配置路线：读 = apply 时的 Config，写 = `settings.update(条目 id, patch)`
 * （写下去会让条目重启，apply 再跑一次并刷新 latestEntryConfig）。
 * 命名空间必须是条目 id，否则核心抛 No configurable plugin entry —— 我们的 Config
 * 导出正是为了让这一行成为「可配置条目」。
 */
function wireEntryConfig(bridge, settings) {
  HOST_DIAG.schemaSource = 'entry-config'
  bridge.read = () => {
    const config = latestEntryConfig
    const raw = config && typeof config === 'object' ? config[AUTO_FIELD] : undefined
    return typeof raw === 'boolean' ? raw : undefined
  }
  bridge.write = async (value) => {
    try {
      await settings.update(ENTRY_ID, { [AUTO_FIELD]: value })
      HOST_DIAG.autoStartValue = value
      HOST_DIAG.settingsSectionRegistered = true
      HOST_DIAG.settingsSectionError = null
      return { ok: true }
    } catch (error) {
      const message = String((error && error.message) || error)
      HOST_DIAG.settingsSectionError = message
      return { ok: false, error: message }
    }
  }
  // 诚实上报：条目真的出现在 describe() 里才算「命名空间已注册」。
  try {
    const rows = settings.describe() || []
    const row = Array.isArray(rows) ? rows.find((candidate) => candidate && candidate.ns === ENTRY_ID) : undefined
    if (row) {
      HOST_DIAG.settingsSectionRegistered = true
      HOST_DIAG.settingsSectionError = null
      const raw = row.value && typeof row.value === 'object' ? row.value[AUTO_FIELD] : undefined
      if (typeof raw === 'boolean') HOST_DIAG.autoStartValue = raw
    } else {
      HOST_DIAG.settingsSectionError = `entry "${ENTRY_ID}" is not configurable yet`
    }
  } catch (error) {
    HOST_DIAG.settingsSectionError = String((error && error.message) || error)
  }
}

function attachAutoSettings(ctx, bridge, settings) {
  if (!settings) {
    HOST_DIAG.settingsSectionError = 'settings-service-unavailable'
    return
  }
  // 0.2.0：既没有 installSection 也没有 register —— 条目自身的 Config 就是命名空间，
  // 写走设置服务的条目配置 API（host 侧），读用 apply 时解析出的值。
  if (typeof settings.installSection !== 'function' && typeof settings.register !== 'function'
    && typeof settings.update === 'function' && typeof settings.describe === 'function') {
    wireEntryConfig(bridge, settings)
    return
  }
  const wireScope = (scope) => {
    bridge.read = () => {
      try {
        const value = scope.get()
        const raw = value && typeof value === 'object' ? value[AUTO_FIELD] : undefined
        if (typeof raw === 'boolean') return raw
      } catch { /* fall through: unknown, the core then uses its default */ }
      return undefined
    }
    bridge.write = async (value) => {
      try {
        await scope.update({ [AUTO_FIELD]: value })
        HOST_DIAG.autoStartValue = value
        return { ok: true }
      } catch (error) {
        return { ok: false, error: String((error && error.message) || error) }
      }
    }
  }
  const useSchema = (schema, source) => {
    HOST_DIAG.schemaSource = source
    if (typeof settings.register === 'function') {
      if (autoScope) {
        wireScope(autoScope)
        HOST_DIAG.settingsSectionRegistered = true
        HOST_DIAG.settingsSectionError = null
        return
      }
      try {
        const scope = settings.register(NS, schema, { base: { [AUTO_FIELD]: AUTO_DEFAULT } })
        autoScope = scope
        HOST_DIAG.settingsSectionRegistered = true
        HOST_DIAG.settingsSectionError = null
        wireScope(scope)
        return
      } catch (error) {
        HOST_DIAG.settingsSectionError = String((error && error.message) || error)
      }
    }
    if (typeof settings.installSection === 'function') {
      try {
        settings.installSection(ctx, NS, schema, { [AUTO_FIELD]: AUTO_DEFAULT }, {
          setSource(source) {
            try {
              const current = source()
              const raw = current && typeof current === 'object' ? current[AUTO_FIELD] : undefined
              HOST_DIAG.autoStartValue = typeof raw === 'boolean' ? raw : AUTO_DEFAULT
            } catch { /* source not ready yet */ }
          },
          onChange() { HOST_DIAG.settingsSectionRegistered = true },
        })
        HOST_DIAG.settingsSectionRegistered = true
        // Registered, but this half got no scope: reads work, writes cannot.
        bridge.read = () => HOST_DIAG.autoStartValue
        HOST_DIAG.settingsSectionError = 'settings-scope-unavailable'
        return
      } catch (error) {
        HOST_DIAG.settingsSectionError = String((error && error.message) || error)
      }
    }
    HOST_DIAG.settingsSectionError = HOST_DIAG.settingsSectionError || 'settings-service-unavailable'
  }

  Promise.resolve()
    .then(() => import('@deepseek-ai/schemastery'))
    .then((mod) => {
      const z = mod && mod.default
      if (!z || typeof z.object !== 'function' || typeof z.boolean !== 'function') {
        useSchema(fallbackSectionSchema(AUTO_FIELD, AUTO_DEFAULT), 'fallback')
        return
      }
      useSchema(z.object({ [AUTO_FIELD]: z.boolean().default(AUTO_DEFAULT) }), 'schemastery')
    })
    .catch(() => {
      // A `link:`-ed host half cannot resolve @deepseek-ai/schemastery; the
      // namespace MUST still register or the panel's write would be rejected.
      useSchema(fallbackSectionSchema(AUTO_FIELD, AUTO_DEFAULT), 'fallback')
    })
}

/**
 * The bridge the host core reads and writes the switch through.
 *
 * It starts inert (reads unknown, writes refused) and is filled in only once the
 * settings service is actually reachable — a missing service degrades the switch
 * to read-only, it never invents a value.
 */
function createAutoBridge() {
  return {
    read: () => undefined,
    write: null,
  }
}

export function apply(ctx, config) {
  // 0.2.0：profile 行解析后的 Config（0.1.x 行上没有 config，此值为 null）。
  latestEntryConfig = (config && typeof config === 'object' && !Array.isArray(config)) ? config : null
  const bridge = createAutoBridge()
  const deps = filesystemDeps()
  deps.readAutoStart = () => bridge.read()
  deps.writeAutoStart = async (value) => {
    if (typeof bridge.write !== 'function') {
      return { ok: false, error: HOST_DIAG.settingsSectionError || 'settings service is not available' }
    }
    return bridge.write(value)
  }
  const core = createCore(deps)
  const dsh = createDshReader(ctx)
  const handlers = createHandlers({ core, dsh })

  // The switch lives in this plugin's settings namespace. Resolve the service
  // now when it is already there, otherwise wait for it — never block apply().
  const settingsNow = typeof ctx.get === 'function' ? ctx.get('settings') : null
  if (settingsNow) {
    attachAutoSettings(ctx, bridge, settingsNow)
  } else {
    try {
      if (typeof ctx.inject === 'function') {
        ctx.inject(['settings'], (sub) => attachAutoSettings(ctx, bridge, (sub && sub.settings) || sub))
      }
    } catch {
      HOST_DIAG.settingsSectionError = 'settings-service-unavailable'
    }
  }

  // On-demand auto start: one session lifecycle hook, fire-and-forget. The
  // trigger NEVER awaits the cold start (44-73s), so a session is never blocked
  // by it; the work itself is owned by the core, which de-duplicates.
  const bindSessionHook = () => {
    if (typeof ctx.on !== 'function') {
      core.noteHostEvents('missing')
      return
    }
    try {
      ctx.on('agent/session-start', () => {
        try {
          Promise.resolve(core.ensureDaemon({ reason: 'auto' })).catch(() => { /* recorded in core state */ })
        } catch { /* a hook must never throw back into the host */ }
      })
      core.noteHostEvents('subscription-ok')
    } catch {
      core.noteHostEvents('missing')
    }
  }
  bindSessionHook()

  const mount = (host) => {
    if (!host || typeof host.register !== 'function') return
    registerRoutes(ctx, host, handlers)
  }

  const webServer = typeof ctx.get === 'function' ? ctx.get('webServer') : null
  if (webServer) {
    mount(webServer)
    return
  }
  // Terminal / Electron have no webServer: stay silent rather than throwing.
  try {
    if (typeof ctx.inject === 'function') {
      ctx.inject(['webServer'], (sub) => mount(sub && sub.webServer ? sub.webServer : sub))
    }
  } catch { /* no webServer on this composition */ }
}

export const _module = { createCore, createDshReader, createHandlers, parseDaemonProbe, spawnCommand, ROUTES }
