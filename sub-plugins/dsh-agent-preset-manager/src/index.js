
// dsh-agent-preset-manager: HOST half.
//
// Runs inside the dsh host process (unsandboxed Node). It exists because DSH
// 0.2 dropped the directory scanner that used to read $DSH_HOME/.agent-presets:
// a preset is now a plugin row declaring @deepseek-ai/dsh-agent-preset, and the
// agent preset registry exposes no "add / remove" verb to clients. This host
// half is the missing write path:
//
//   GET  /__dsh-agent-presets/state        scan + health check + runtime state
//   POST /__dsh-agent-presets/set-enabled  {id, dir, enabled}  declare / undeclare
//   POST /__dsh-agent-presets/create       {id, name, description, order, target}
//   POST /__dsh-agent-presets/save         {id, dir, text}     edit composition
//   POST /__dsh-agent-presets/remove       {id, dir, confirm}  undeclare + delete dir
//   POST /__dsh-agent-presets/import       {sourceDir, id, confirm, target}
//   POST /__dsh-agent-presets/migrate      {ids, confirm}      legacy -> library
//
// Every write path reuses the official registry API (ctx.get('agentPresets'))
// and degrades to read-only when that service is absent (DSH 0.1.x lines).
//
// Conventions inherited from the sibling plugins in this repository:
//   - no @deepseek-ai/* import (a link:-installed host half cannot resolve
//     them): every host service is reached through ctx.get / ctx.inject;
//   - NO dynamic import() of a preset row anywhere in this plugin: probing a
//     row by importing it would execute a plugin the user has not enabled, and
//     a rejected import with no handler makes the launcher abort with a fatal
//     load failure. Probes resolve a name, they never load a module;
//   - all non-trivial logic lives in host-core.js behind injected deps, so the
//     whole feature is testable with a fake filesystem;
//   - ESM named exports: apply / inject / name.
//
// This half never reads or writes the profile cordis.patch.yml, its package.json
// or dsh.profile.bundles, and it never touches another preset manager's files.

import fs from 'node:fs'
import os from 'node:os'
import path from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import { createRequire } from 'node:module'

import {
  API_PREFIX,
  ROUTE_TABLE,
  PLUGIN_ID,
  COMPOSITION_FILE,
  METADATA_FILE,
  STATE_FILE,
  collectState,
  loadState,
  createOperations,
  createRuntimeProbe,
  runCommand,
} from './host-core.js'

export const name = PLUGIN_ID
/** No static dependency: a missing webServer or registry only degrades us. */
export const inject = []

/** How much of a request body we are willing to buffer. */
const BODY_LIMIT = 4 * 1024 * 1024


// --- request / response -----------------------------------------------------

function sendJson(res, status, payload) {
  let body = ''
  try {
    body = JSON.stringify(payload === undefined ? null : payload)
  } catch (error) {
    body = JSON.stringify({ ok: false, error: '响应无法序列化：' + String((error && error.message) || error) })
    status = 500
  }
  try {
    res.writeHead(status, {
      'content-type': 'application/json; charset=utf-8',
      'content-length': Buffer.byteLength(body),
      'cache-control': 'no-store',
    })
    res.end(body)
  } catch { /* the socket may already be gone */ }
}

function readBody(req, limit = BODY_LIMIT) {
  return new Promise((resolve) => {
    const chunks = []
    let size = 0
    let done = false
    const finish = (value) => {
      if (done) return
      done = true
      resolve(value)
    }
    req.on('data', (chunk) => {
      size += chunk.length
      if (size > limit) {
        finish('')
        return
      }
      chunks.push(chunk)
    })
    req.on('error', () => finish(''))
    req.on('end', () => finish(Buffer.concat(chunks).toString('utf8')))
  })
}

// --- injected filesystem deps (the whole reason host-core is testable) ------

function dshHome() {
  const fromEnv = process.env.DSH_HOME
  if (typeof fromEnv === 'string' && fromEnv.trim() !== '') return fromEnv.trim()
  return path.join(os.homedir(), '.dsh')
}

function makeDeps(ctx) {
  const sourceDir = path.dirname(fileURLToPath(import.meta.url))
  const sourceRequire = createRequire(path.join(sourceDir, '..', 'package.json'))
  const baseUrl = typeof ctx.baseUrl === 'string' ? ctx.baseUrl : null
  let hostRequire = sourceRequire
  if (baseUrl) {
    try { hostRequire = createRequire(baseUrl) } catch { /* keep our own */ }
  }
  const profileDir = baseUrl ? path.dirname(fileURLToPath(baseUrl)) : sourceDir
  const home = dshHome()

  /**
   * Base URLs the host's own resolver may route through, most authoritative
   * first. `parentURL` decides WHICH routing layer answers: a parent inside the
   * profiles tree is answered from the profile layer (where the official
   * @deepseek-ai/* packages live), a linked-repo parent is not. Asking with
   * several bases is how a static probe agrees with the registry.
   */
  let parentCache = null
  const resolutionParents = () => {
    if (parentCache) return parentCache
    const parents = []
    const push = (value) => {
      if (typeof value !== 'string' || value === '') return
      if (parents.indexOf(value) < 0) parents.push(value)
    }
    const service = (key) => {
      try { return ctx.get(key) } catch { return undefined }
    }
    // 1. The preset registry's own ctx: mount.ts hands exactly this baseUrl to
    //    prepareProfileEntries, so its answer IS the host's answer.
    const registry = service('agentPresets')
    for (const holder of [registry, registry && registry.ctx, registry && registry.owner]) {
      if (holder) push(holder.baseUrl)
    }
    // 2. The active profile, when the host exposes it as a service.
    const profileContext = service('profileContext')
    for (const key of ['dir', 'root', 'path']) {
      const dir = profileContext && profileContext[key]
      if (typeof dir === 'string' && dir !== '') push(pathToFileURL(path.join(dir, 'package.json')).href)
    }
    // 3. Every profile under $DSH_HOME/profiles — a parent inside the profiles
    //    tree is what the router needs to answer from the profile layer.
    try {
      const profilesDir = path.join(home, 'profiles')
      for (const entry of fs.readdirSync(profilesDir, { withFileTypes: true })) {
        if (!entry.isDirectory()) continue
        push(pathToFileURL(path.join(profilesDir, entry.name, 'package.json')).href)
      }
    } catch { /* no profiles directory yet */ }
    // 4. Our own declaration point, then this module.
    push(baseUrl)
    parentCache = parents
    return parents
  }

  return {
    home,
    profileDir,
    baseUrl,

    exists(target) {
      try {
        fs.statSync(target)
        return true
      } catch {
        return false
      }
    },
    /** Contract with host-core: null (never a throw) when the file is absent. */
    readText(file) {
      try {
        return fs.readFileSync(file, 'utf8')
      } catch {
        return null
      }
    },
    readdir(dir) {
      return fs.readdirSync(dir)
    },
    isDirectory(target) {
      try {
        return fs.statSync(target).isDirectory()
      } catch {
        return false
      }
    },
    ensureDir(dir) {
      fs.mkdirSync(dir, { recursive: true })
    },
    writeTextAtomic(file, text) {
      const tmp = file + '.tmp-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8)
      fs.writeFileSync(tmp, text, 'utf8')
      fs.renameSync(tmp, file)
    },
    removeDir(dir) {
      fs.rmSync(dir, { recursive: true, force: true })
    },
    /** Copy one file, creating parents; returns the number of bytes copied. */
    copyFile(from, to) {
      fs.mkdirSync(path.dirname(to), { recursive: true })
      fs.copyFileSync(from, to)
      return fs.statSync(to).size
    },
    backupFile(file, keep) {
      if (!fs.existsSync(file)) return null
      const dir = path.join(path.dirname(file), '.backup')
      fs.mkdirSync(dir, { recursive: true })
      const stamp = new Date().toISOString().replace(/[:.]/g, '-')
      const target = path.join(dir, path.basename(file) + '.' + stamp)
      fs.copyFileSync(file, target)
      const prefix = path.basename(file) + '.'
      const old = fs
        .readdirSync(dir)
        .filter((entry) => entry.startsWith(prefix))
        .sort()
      const extra = old.length - Math.max(1, keep)
      for (let i = 0; i < extra; i += 1) {
        try { fs.rmSync(path.join(dir, old[i])) } catch { /* best effort */ }
      }
      return target
    },

    /**
     * Resolve one preset row's package name to a directory, WITHOUT executing
     * anything. The host's `pluginPackages` service is asked first: it is the
     * same resolver the registry uses to mount a preset, so a row that answers
     * here answers there. Native CJS resolution is only a fallback. Never turn
     * this into a dynamic import() — see the checkRowNames contract in
     * host-core.js.
     */
    resolveSpec(spec) {
      const packages = (() => {
        try { return ctx.get('pluginPackages') } catch { return undefined }
      })()
      if (packages && typeof packages.packageOf === 'function') {
        for (const parentURL of resolutionParents()) {
          try {
            const found = packages.packageOf(spec, parentURL)
            if (found && typeof found.dir === 'string' && found.dir !== '') return found.dir
          } catch { /* this base is not routable: try the next one */ }
        }
      }
      for (const req of [hostRequire, sourceRequire]) {
        try {
          return req.resolve(spec)
        } catch { /* keep probing */ }
      }
      return null
    },
    resolvePackageDir(spec) {
      try {
        const pkg = hostRequire.resolve(spec + '/package.json')
        return path.dirname(pkg)
      } catch {
        /* the package may not expose its manifest: fall back to the entry */
      }
      try {
        let entry = hostRequire.resolve(spec)
        let dir = path.dirname(entry)
        for (let i = 0; i < 4; i += 1) {
          if (path.basename(dir) === 'node_modules') return null
          if (fs.existsSync(path.join(dir, 'package.json'))) return dir
          dir = path.dirname(dir)
        }
        return null
      } catch {
        return null
      }
    },
    /** Where to look for the built-in standard preset that seeds a new preset. */
    standardSkeletonCandidates() {
      const relative = path.join('presets', 'standard.patch.yml')
      const roots = []
      const webAppDir = this.resolvePackageDir('@deepseek-ai/dsh-web-app')
      if (webAppDir) roots.push(webAppDir)
      if (baseUrl) {
        const profileRoot = path.resolve(profileDir, '..', '..')
        roots.push(path.join(profileRoot, 'node_modules', '@deepseek-ai', 'dsh-web-app'))
      }
      const candidates = []
      for (const root of roots) candidates.push(path.join(root, relative))
      return candidates
    },
  }
}


// --- routes -----------------------------------------------------------------

function createHandlers(core, migrateRef) {
  const handlers = {}
  for (const route of ROUTE_TABLE) {
    handlers[route.path] = async (req, res) => {
      const method = String((req && req.method) || 'GET').toUpperCase()
      if (method === 'OPTIONS') return sendJson(res, 204, {})
      if (method !== route.method) {
        return sendJson(res, 405, { ok: false, error: '只接受 ' + route.method + ' ' + route.path })
      }
      let body = {}
      if (route.method === 'POST') {
        const text = await readBody(req)
        if (text) {
          try {
            body = JSON.parse(text)
          } catch {
            return sendJson(res, 400, { ok: false, error: '请求体不是合法 JSON' })
          }
        }
        if (!body || typeof body !== 'object' || Array.isArray(body)) body = {}
      }
      // GET 端点的参数走查询串：面板用 GET /file?id=… 读组合原文。
      // 把查询串并进 args，GET 与 POST 就共用同一条 runCommand 通路。
      const rawUrl = String((req && req.url) || '')
      const mark = rawUrl.indexOf('?')
      if (mark >= 0) {
        const query = new URLSearchParams(rawUrl.slice(mark + 1))
        for (const [key, value] of query.entries()) body[key] = value
      }
      // A handler that throws must still answer: the panel would otherwise
      // hang on a promise that never settles. The crash also carries whatever
      // state we can still collect, so the tab keeps rendering.
      let result = null
      try {
        result = await runCommand(core.deps, route.action, body, migrateRef)
      } catch (error) {
        let fallbackState = null
        try {
          fallbackState = collectState(core)
        } catch { fallbackState = null }
        return sendJson(res, 500, { ok: false, error: String((error && error.message) || error), state: fallbackState })
      }
      return sendJson(res, result.status, result.payload)
    }
  }
  return handlers
}

/**
 * Register the table on either host spelling: the object form used by
 * dsh-hindsight-model ({kind, path, handler}) and the plain function form used
 * by the official webServer. Both return a disposer that ctx.effect honors.
 */
function registerRoutes(ctx, host, handlers) {
  for (const [routePath, handler] of Object.entries(handlers)) {
    ctx.effect(() => {
      const open = { kind: 'exact', path: routePath, handler }
      try {
        const registration = host.register(open)
        if (typeof registration === 'function') return registration
        return () => {
          if (registration && typeof registration.dispose === 'function') registration.dispose()
        }
      } catch {
        return host.register(routePath, handler)
      }
    })
  }
}

// --- boot -------------------------------------------------------------------

/**
 * Adopt the host's agent preset registry.
 *
 * The registry is a parent-realm service, so it is reached through ctx, never
 * imported. Absence is a supported state (DSH 0.1.x): the panel stays usable as
 * a viewer/editor and every write returns an explicit reason.
 */
function adoptRegistry(ctx, runtime) {
  const candidates = []
  if (typeof ctx.get === 'function') candidates.push(ctx.get('agentPresets'))
  const sub = ctx.get('agentPresetsRoot')
  if (sub) candidates.push(sub)
  for (const candidate of candidates) {
    const registry = candidate && candidate.agentPresets ? candidate.agentPresets : candidate
    if (registry && typeof registry.register === 'function' && runtime.adopt(registry)) return true
  }
  if (typeof ctx.inject === 'function') {
    try {
      ctx.inject(['agentPresets'], (sub) => {
        const registry = sub && sub.agentPresets ? sub.agentPresets : sub
        if (registry && typeof registry.register === 'function') runtime.adopt(registry)
      })
    } catch { /* older composition: stay read-only */ }
  }
  return false
}

/** Re-declare everything state.json remembers (nothing is enabled on first run). */
async function restoreEnabled(core) {
  const { deps, runtime } = core
  const report = { attempted: 0, restored: [], failed: [] }
  const ids = core.loadState().state.enabled.slice()
  const opsApi = createOperations(deps)
  for (const id of ids) {
    report.attempted += 1
    // Declaration is async in 0.2.x (it settles after the preset tree mounted),
    // so each entry is awaited before the next one is declared.
    const result = await opsApi.applyEnabled(id, true)
    const broken = result.declaration ? result.declaration.broken : null
    if (result.ok && !broken) report.restored.push(id)
    else report.failed.push({ id, error: result.error || broken || '未知错误' })
  }
  return report
}

export function apply(ctx) {
  const deps = makeDeps(ctx)
  const runtime = createRuntimeProbe(ctx, null)
  deps.runtime = runtime

  const boot = { errors: [] }
  let restoreReport = null
  let restoreSettled = false
  /** The exact core shape host-core expects (home is a getter, not a value). */
  const core = {
    deps,
    runtime,
    home: () => deps.home,
    loadState: () => {
      try {
        return loadState(deps, deps.home)
      } catch {
        return { state: { version: 1, enabled: [], updatedAt: null }, path: null, error: '状态文件读取失败' }
      }
    },
  }
  const migrateRef = () => ({ ok: true, restored: restoreReport, restoredPending: !restoreSettled, state: collectState(core) })

  const mounted = () => {
    adoptRegistry(ctx, runtime)
    // Boot must not block on the host: declaring a preset is asynchronous in
    // 0.2.x, so the report lands a moment later and every reader (/state, the
    // migrate reply, describe()) picks it up from restoreReport once it is there.
    void (async () => {
      try {
        restoreReport = await restoreEnabled(core)
      } catch (error) {
        boot.errors.push(String((error && error.message) || error))
      } finally {
        restoreSettled = true
      }
    })()
    const handlers = createHandlers(core, migrateRef)
    const mount = (host) => {
      if (!host || typeof host.register !== 'function') return
      try {
        registerRoutes(ctx, host, handlers)
      } catch (error) {
        boot.errors.push('HTTP 端点注册失败：' + String((error && error.message) || error))
      }
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
    } catch { /* no web surface on this composition */ }
  }

  mounted()

  return {
    /** Diagnostics for the panel's empty state and for tests. */
    describe() {
      return {
        plugin: PLUGIN_ID,
        home: deps.home,
        profileDir: deps.profileDir,
        runtimeSupported: runtime.supported,
        runtimeError: runtime.error,
        handles: [...runtime.handles.keys()],
        restore: restoreReport,
        restorePending: !restoreSettled,
        errors: boot.errors.slice(),
      }
    },
  }
}

/** Offline/test surface: host-core stays reachable without a running host. */
export const _module = { makeDeps, createHandlers, registerRoutes, runCommand, collectState, ROUTE_TABLE, API_PREFIX }