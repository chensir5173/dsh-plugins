// dsh-composer-provider-label: node half.
//
// The whole visible feature lives in the client half: a read-only provider
// label beside the composer's model selector, resolved from the session's
// `modelSelection` projection and the host `session/modelCatalog` — both
// public Remotes (see README for the ≥0.1.2-rc.1 floor). This half exists for
// exactly one reason: to declare the optional settings namespace
// `dsh-composer-provider-label.providerAliases` so a user can override the
// built-in `deepseek-official → office` short name from the settings page or
// `settings.yaml` instead of editing code.
//
// Deliberate fragility budget (design D4 + apply decision): declaring a
// settings section needs a schemastery schema, and importing
// `@deepseek-ai/schemastery` from an *external* plugin is not guaranteed to
// resolve in every install shape (the local link: dev plugins resolve module
// paths from the source dir, not from the profile's node_modules). So the
// import is dynamic and fully optional: when it resolves, the section is
// installed and `settings.describe()` starts carrying the namespace; when it
// does not, this half contributes nothing and the client silently keeps the
// built-in alias map. A missing schema must never stop the plugin from
// loading — that would take the whole composer label down for a nicety.
//
// ESM module format (cordis bundle rule): named exports apply/inject/name.
// `inject` stays empty on purpose: we never block apply() on the `settings`
// service. A profile without a settings provider simply never runs the
// callback below, which is the same as "no configurable section".
//
// 0.2.0 route: `installSection` was retired, and the settings service now
// projects each entry's OWN exported Config under the ENTRY ID (here
// `composer-provider-label` = the row id the manager writes). The Config below is
// therefore exported for that generation — a hand-rolled schema, because a
// `link:` host half cannot import `@deepseek-ai/schemastery` (verified:
// ERR_MODULE_NOT_FOUND), see dsh-notify-hub/src/index.js for the full rationale.

const name = 'composer-provider-label'
const NS = 'dsh-composer-provider-label'

/** Default alias map, mirrored by the client half (asserted equal in the tests). */
const BUILTIN_ALIASES = Object.freeze({ 'deepseek-official': 'office' })

/** No services are required on the host: this half contributes nothing up front. */
const inject = []

/** Host plugin body — declares the optional aliases settings section. */
function apply(ctx) {
  ctx.inject(['settings'], (settingsCtx) => {
    const settings = settingsCtx && settingsCtx.settings
    if (!settings || typeof settings.installSection !== 'function') return
    // Dynamic + optional: a resolution failure must degrade, not crash the row.
    Promise.resolve().then(() => import('@deepseek-ai/schemastery')).then((mod) => {
      const z = mod && mod.default
      if (!z || typeof z.object !== 'function' || typeof z.dict !== 'function') return
      const Config = z.object({
        providerAliases: z.dict(z.string()).default(BUILTIN_ALIASES),
      })
      settings.installSection(ctx, NS, Config, { providerAliases: BUILTIN_ALIASES }, {
        // This consumer derives nothing at runtime; the client reads the
        // resolved section through `settings.describe()`. No-op hooks keep the
        // section registered as a plain declarable namespace.
        setSource() {},
        onChange() {},
      })
    }).catch(() => { /* schemastery unavailable: aliases stay built-in */ })
  })
}

/**
 * 0.2.0 entry config (the settings section IS the profile row).
 *
 * Consumers, all satisfied by the three members below: cordis `resolveConfig`
 * (`Config[~standard].validate`), the settings service (`meta.volatile` +
 * `toJSON()`, rebuilt by `plainSchema`), and the loader diff (`~standard.vendor`,
 * deliberately NOT `schemastery` so a write takes the ordinary entry-restart path
 * instead of the in-place Volatile commit our plain values cannot express).
 * The refs table is captured from the equivalent schemastery schema:
 * `z.object({ providerAliases: z.dict(z.string()).default(BUILTIN_ALIASES) }).volatile()`.
 */
const CONFIG_SCHEMA_JSON = Object.freeze({"uid":9,"refs":{"4":{"type":"string","meta":{}},"6":{"type":"string","meta":{}},"7":{"type":"dict","meta":{"default":{"deepseek-official":"office"}},"inner":4,"sKey":6},"9":{"type":"object","meta":{"default":{},"volatile":true},"dict":{"providerAliases":7}}}})

/** Normalize one entry config value to `{ providerAliases: Record<string, string> }`. */
function normalizeEntryConfig(input) {
  const source = (input && typeof input === 'object' && !Array.isArray(input)) ? input : {}
  const aliases = source.providerAliases
  const clean = {}
  if (aliases && typeof aliases === 'object' && !Array.isArray(aliases)) {
    for (const key of Object.keys(aliases)) {
      const value = aliases[key]
      if (typeof value === 'string' && value.length > 0) clean[key] = value
    }
  }
  return Object.assign({}, source, {
    providerAliases: Object.keys(clean).length > 0 ? clean : Object.assign({}, BUILTIN_ALIASES),
  })
}

/** The Config exported to the loader/settings service (see the block comment above). */
function entryConfigSchema() {
  const schema = (input) => normalizeEntryConfig(input)
  schema.meta = { volatile: true }
  schema.type = 'object'
  schema.toJSON = () => JSON.parse(JSON.stringify(CONFIG_SCHEMA_JSON))
  schema['~standard'] = {
    version: 1,
    vendor: 'dsh-composer-provider-label',
    validate(value) {
      try { return { value: normalizeEntryConfig(value) } }
      catch (error) { return { issues: [{ message: (error && error.message) ? error.message : String(error) }] } }
    },
  }
  return schema
}

/** Exported for the loader (0.2.0 entry config) and asserted by the test harness. */
export const Config = entryConfigSchema()

export { apply, inject, name, BUILTIN_ALIASES, NS }
/** The profile entry id 0.2.0 keys this plugin's settings namespace by (client mirrors it). */
export const ENTRY_NS = name
