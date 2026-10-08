// dsh-session-title-regenerate: node half.
//
// Registers one slash command `regenerate-title` on the host. The handler:
//   1. collects every eligible user (human) text message from the session log
//      (the whole conversation, truncated by a UTF-8 byte budget),
//   2. calls `ctx.llm.stream` at the LOWEST reasoning tier by default —
//      `reasoningEffort: 'off'` plus `purpose: 'session-title'`, which the
//      DeepSeek adapter additionally forces to `thinking: disabled` — with a
//      strict one-line prompt. The tier and the maxTokens budget are editable
//      in the plugin's settings tab (thinking switch / reasoning effort /
//      max output tokens),
//   3. normalizes the model output (one line, no quotes/control codes, capped
//      at 60 code points) and commits it through `ctx.sessionTitle.rename()`
//      — the same public API `remote.session.rename` uses, so the new title
//      lands in the log, pins the title, and the client list updates through
//      the title projection.
//
// The client half (./client.js) triggers this command from the session-header
// action button and from a DOM-injected item in the sidebar session-row "..."
// menu, both via `remote.commands.execute` — a core Remote whose agent lookup
// (typert `lookup: 'agent'`) auto-resumes non-open sessions, exactly like the
// built-in rename/fork actions work from the list.
//
// No host endpoint, no model tool, no new attack surface.
//
// NO host package is imported: this half reaches the host only through the
// injected `commands` / `llm` / `sessionTitle` services. The two pure data
// helpers it needs (message construction, stream assembly) are implemented
// below, so the plugin stays resolvable when it is `link:`-installed from
// outside the profile — a bare `@deepseek-ai/dsh-llm` import would be resolved
// from the repo's real path, where no node_modules exists (ERR_MODULE_NOT_FOUND).
//
// ESM module format (cordis bundle rule): named exports apply/inject/name.

import { randomUUID } from 'node:crypto'

const name = 'session-title-regenerate'

/** Host services required by this half: commands (register), llm (stream), sessionTitle (rename). */
const inject = ['commands', 'llm', 'sessionTitle']

// --- defaults & config --------------------------------------------------------

/**
 * 插件默认策略（可被 Loader 行配置 / 设置页覆盖）。
 * - targetWords / targetCjkCharacters：提示词里的标题长度目标。
 * - maxInputBytes：拼接后的全部用户提问的最大 UTF-8 字节数，超出的消息直接丢弃。
 * - thinking：思考开关；false（默认）= 强制关闭思考，true = 用下面的推理强度。
 * - reasoningEffort：推理强度档位（off/low/medium/high/max），仅在 thinking 为 true
 *   时生效；'off' 与 thinking:false 等价。
 * - maxOutputTokens：标题输出上限。默认 512 给思考留出余量：旧的 100 会被上游
 *   finish_reason=length 截断（报错 title output reached maxTokens）。
 * - timeoutMs：单次生成的超时。
 * - provider / model：可选路由覆盖；缺省使用会话自身请求头里的路由。
 */
const DEFAULTS = {
  targetWords: 40,
  targetCjkCharacters: 60,
  maxInputBytes: 12 * 1024,
  thinking: false,
  reasoningEffort: 'off',
  maxOutputTokens: 512,
  timeoutMs: 30000,
  provider: undefined,
  model: undefined,
}

/** 推理强度可选档位（client 端下拉镜像同一张表）。 */
const REASONING_EFFORTS = ['off', 'low', 'medium', 'high', 'max']

/** maxOutputTokens 的合法区间（设置页输入框与配置归一化共用）。 */
const MAX_OUTPUT_TOKENS_MIN = 16
const MAX_OUTPUT_TOKENS_MAX = 8192

/** 把任意输入夹成区间内的整数；非数字回落到 fallback。 */
function clampInt(value, min, max, fallback) {
  const n = typeof value === 'number' ? value : Number(value)
  if (!Number.isFinite(n)) return fallback
  const i = Math.trunc(n)
  if (i < min) return min
  if (i > max) return max
  return i
}

/** 归一化推理强度：不在档位表内的一律回落默认 'off'。 */
function normalizeReasoningEffort(value) {
  return typeof value === 'string' && REASONING_EFFORTS.indexOf(value) >= 0 ? value : DEFAULTS.reasoningEffort
}

/**
 * 解析本次调用真正使用的推理强度：思考关掉时一律 'off'（最省 token），
 * 开启时用配置里的档位；档位不被模型支持时 streamTitle 会退一次「不传该参数」。
 * - 参数类型：config -- 归一化后的插件配置。
 * - 返回值：string -- 'off' | 'low' | 'medium' | 'high' | 'max'。
 * - 调用样例：const effort = resolveReasoningEffort(config)
 */
function resolveReasoningEffort(config) {
  const source = config && typeof config === 'object' ? config : {}
  if (source.thinking !== true) return 'off'
  return normalizeReasoningEffort(source.reasoningEffort)
}

/**
 * 归一化 Loader 行 / 设置页传入的配置：补默认值、夹住越界值、丢掉非法类型。
 * provider/model 等未声明的键原样保留（仍走 Loader 行配置）。
 * - 参数类型：input -- unknown。
 * - 返回值：object -- 归一键值对象。
 * - 调用样例：const resolved = normalizeEntryConfig({ maxOutputTokens: 4096 })
 */
function normalizeEntryConfig(input) {
  const source = input && typeof input === 'object' && !Array.isArray(input) ? input : {}
  return Object.assign({}, source, {
    targetWords: clampInt(source.targetWords, 1, 400, DEFAULTS.targetWords),
    targetCjkCharacters: clampInt(source.targetCjkCharacters, 1, 400, DEFAULTS.targetCjkCharacters),
    maxInputBytes: clampInt(source.maxInputBytes, 256, 4 * 1024 * 1024, DEFAULTS.maxInputBytes),
    thinking: source.thinking === true,
    reasoningEffort: normalizeReasoningEffort(source.reasoningEffort),
    maxOutputTokens: clampInt(source.maxOutputTokens, MAX_OUTPUT_TOKENS_MIN, MAX_OUTPUT_TOKENS_MAX, DEFAULTS.maxOutputTokens),
    timeoutMs: clampInt(source.timeoutMs, 1000, 600000, DEFAULTS.timeoutMs),
  })
}

/**
 * 解析会话自身的模型路由（requestHeader.config 的 provider/model）。
 * - 参数类型：agent -- Agent：宿主智能体对象，其 session 为会话实例。
 * - 返回值：route -- {provider, model} | null：有完整路由返回对象，否则返回 null。
 * - 调用样例：const route = sessionRouteOf(agent)
 */
function sessionRouteOf(agent) {
  try {
    const header = agent.session.requestHeader()
    const config = header && header.config
    if (config && typeof config.provider === 'string' && typeof config.model === 'string') {
      return { provider: config.provider, model: config.model }
    }
  } catch { /* header 可能对空会话缺失：返回 null 走错误分支 */ }
  return null
}

/**
 * 兼容不同核心版本的会话事件读取接口。
 * 0.1.1-rc.2 的 Session 暴露 `events` getter（不可变快照）；
 * 0.1.2-rc.1 起改为 `snapshotEvents()` 方法。未知形态回退空数组。
 * - 参数类型：session -- Session：宿主会话实例。
 * - 返回值：SessionEvent[] -- 事件日志快照。
 * - 调用样例：const events = sessionEventsOf(agent.session)
 */
function sessionEventsOf(session) {
  try {
    if (typeof session.snapshotEvents === 'function') return session.snapshotEvents()
    const events = session.events
    if (typeof events === 'function') return events()
    if (events !== undefined && events !== null) return events
  } catch { /* 日志暂不可用时按无消息处理 */ }
  return []
}

/**
 * 从会话事件日志里收集全部合格的人类用户提问文本。
 * 只认 user/message 且 source.kind === 'user' 的事件，取 text 块拼接；
 * 超过 maxBytes 字节预算后停止收集（按序截断，保持开头主题）。
 * - 参数类型：events -- SessionEvent[]；maxBytes -- number
 * - 返回值：string[] -- 按日志顺序的用户提问文本数组（已 trim，跳过空文本）。
 * - 调用样例：const texts = userMessagesOf(sessionEventsOf(session), 12000)
 */
function userMessagesOf(events, maxBytes) {
  const out = []
  let used = 0
  for (const event of events) {
    if (!event || event.type !== 'user/message') continue
    const source = event.data && event.data.source
    if (!source || source.kind !== 'user') continue
    const blocks = event.data.content || []
    const text = blocks
      .filter((block) => block.type === 'text')
      .map((block) => block.text)
      .join('\n')
      .trim()
    if (!text) continue
    const bytes = Buffer.byteLength(text, 'utf8')
    if (used + bytes > maxBytes) continue
    out.push(text)
    used += bytes
  }
  return out
}

/**
 * 生成稳定的、语言无关的标题系统提示词。
 * - 参数类型：config -- {targetWords, targetCjkCharacters}：长度目标。
 * - 返回值：string -- 多行系统提示词。
 * - 调用样例：const system = systemPrompt(config)
 */
function systemPrompt(config) {
  return [
    'Create a concise title for an AI coding-assistant session from the supplied human messages.',
    'Return only the title on one line, in plain text of natural language, with no quotes, prefix, explanation, Markdown, XML, or terminal control codes. No code is allowed.',
    'Use the language of the messages.',
    `Aim for about ${config.targetWords} words in non-CJK languages or ${config.targetCjkCharacters} CJK characters, and never more than 60 characters.`,
  ].join('\n')
}

/**
 * 把用户提问列表封装为 JSON 文本，避免用户文本破坏结构分隔符。
 * - 参数类型：messages -- string[]：用户提问数组。
 * - 返回值：string -- 可直接作为模型 user 消息正文的字符串。
 * - 调用样例：const framed = frameMessages(['帮我写个插件'])
 */
function frameMessages(messages) {
  return `Generate the session title from this JSON array of human messages:\n${JSON.stringify(messages)}`
}

// --- 标题规范化（本地实现，行为对齐 dsh-session-title 的 normalizeSessionTitle）--

const OSC_SEQUENCE = /(?:\u001B\]|\u009D)(?:(?!\u0007|\u001B\\)[\s\S])*(?:\u0007|\u001B\\|$)/gu
const CSI_SEQUENCE = /(?:\u001B\[|\u009B)[0-?]*[ -/]*[@-~]/gu
const ESC_SEQUENCE = /\u001B[@-_]/gu
const CONTROL_CHARACTER = /[\u0000-\u0008\u000B\u000C\u000E-\u001F\u007F-\u009F]/gu
const DIRECTIONAL_CONTROL = /[\u200B\u200E\u200F\u202A-\u202E\u2060-\u2064\u2066-\u206F\uFEFF]/gu
const WRAPPING_QUOTES = /^["'\u201C\u201D\u300C\u300D\u300E\u300F]+|["'\u201C\u201D\u300C\u300D\u300E\u300F]+$/g

/**
 * 清洗模型输出：先去控制序列与不可见方向控制符，trim 后再剥首尾引号
 * （必须先 trim，否则结尾空格会挡住结尾引号的正则），最后把内部空白压成单行。
 * - 参数类型：input -- string：模型原始输出。
 * - 返回值：string -- 单行、去引号的干净文本。
 * - 调用样例：const cleaned = cleanTitle(rawTitle)
 */
function cleanTitle(input) {
  return String(input || '')
    .replace(OSC_SEQUENCE, '')
    .replace(CSI_SEQUENCE, '')
    .replace(ESC_SEQUENCE, '')
    .replace(CONTROL_CHARACTER, '')
    .replace(DIRECTIONAL_CONTROL, '')
    .trim()
    .replace(WRAPPING_QUOTES, '')
    .replace(/\s+/gu, ' ')
    .trim()
}

/**
 * 按 Unicode 码点截断到上限（避免切碎代理对/组合字符）。
 * - 参数类型：input -- string；max -- number：最大码点数。
 * - 返回值：string -- 截断后的字符串。
 * - 调用样例：const capped = capCodePoints(title, 60)
 */
function capCodePoints(input, max) {
  const chars = Array.from(input)
  return chars.slice(0, max).join('')
}

// --- 超时护栏 ---------------------------------------------------------------

/**
 * 为一次 llm 调用叠加独立超时：外层 signal 与定时器同时生效，返回组合信号。
 * - 参数类型：signal -- AbortSignal；ms -- number：超时毫秒数。
 * - 返回值：{signal, dispose} -- dispose 用于清理定时器与监听器。
 * - 调用样例：const g = withTimeout(signal, 30000); ... g.dispose()
 */
function withTimeout(signal, ms) {
  const controller = new AbortController()
  const onAbort = () => controller.abort(signal.reason)
  if (signal.aborted) controller.abort(signal.reason)
  else signal.addEventListener('abort', onAbort, { once: true })
  const timer = setTimeout(() => controller.abort(new Error('title generation timed out')), ms)
  return {
    signal: controller.signal,
    dispose() {
      clearTimeout(timer)
      signal.removeEventListener('abort', onAbort)
    },
  }
}

// --- 本地消息构造 / 流装配（等价替代 @deepseek-ai/dsh-llm 的两个纯工具）---------
//
// 为什么不用 import：本插件以 `link:` 形态装在 profile 之外（真实路径在 git 仓库里），
// Node 的裸包解析会从仓库目录向上找 node_modules —— 而宿主内部包 @deepseek-ai/dsh-llm
// 只存在于宿主安装树（~/.dsh/profiles/...）里，永远不在那条祖先链上，启动即
// ERR_MODULE_NOT_FOUND。这里就地实现所需的两个纯数据工具，插件对宿主能力的依赖
// 只剩注入服务（commands / llm / sessionTitle）。

/**
 * 构造一条 user 角色请求消息（对齐 dsh-llm 的 createUserMessage：展开入参 +
 * role:'user' + 新 id；模型请求只读 role/content）。
 * - 参数类型：input -- {content: ContentBlock[]}
 * - 返回值：{...input, role:'user', id: string}
 * - 调用样例：createUserMessage({ content: [{ type: 'text', text }] })
 */
function createUserMessage(input) {
  return { ...input, role: 'user', id: randomUUID() }
}

/**
 * 流式块装配器（对齐 dsh-llm 的 BlockAssembler 的可观察行为）：按 index 累积
 * text/reasoning 增量，`block-end` 的闭合块优先，`finish` 记录结束原因
 * （缺省 {kind:'stop'}）。本插件只用 push / finish / blocks 三个成员。
 * - 参数类型：chunk -- StreamChunk（block-start / text-delta / reasoning-delta /
 *   block-end / finish；usage、tool-call-delta 等与标题生成无关，忽略）
 * - 返回值：实例；blocks() -> ContentBlock[]；finish -> FinishReason
 * - 调用样例：const a = new BlockAssembler(); for await (const c of stream) a.push(c)
 */
class BlockAssembler {
  #order = []
  #partials = new Map()
  #finish

  push(chunk) {
    switch (chunk && chunk.type) {
      case 'block-start':
        if (!this.#partials.has(chunk.index)) {
          this.#order.push(chunk.index)
          this.#partials.set(chunk.index, { blockType: chunk.blockType, text: '', block: undefined })
        }
        return
      case 'text-delta':
      case 'reasoning-delta': {
        const partial = this.#ensure(chunk.index, chunk.type === 'text-delta' ? 'text' : 'reasoning')
        if (!partial.block) partial.text += chunk.text
        return
      }
      case 'block-end': {
        const partial = this.#ensure(chunk.index, chunk.block.type)
        if (!partial.block) partial.block = chunk.block
        return
      }
      case 'finish':
        this.#finish = chunk.reason
        return
      default:
        return // usage / tool-call-delta / 未知 chunk：标题生成用不到
    }
  }

  #ensure(index, blockType) {
    let partial = this.#partials.get(index)
    if (!partial) {
      partial = { blockType, text: '', block: undefined }
      this.#partials.set(index, partial)
      this.#order.push(index)
    }
    return partial
  }

  get finish() {
    return this.#finish ?? { kind: 'stop' }
  }

  blocks() {
    return this.#order
      .map((index) => {
        const partial = this.#partials.get(index)
        if (!partial) return undefined
        if (partial.block) return partial.block
        if (partial.blockType === 'text' || partial.blockType === 'reasoning') {
          return { type: partial.blockType, text: partial.text }
        }
        return undefined // 未闭合的未知块（如 tool-call）不参与标题
      })
      .filter(Boolean)
  }
}

// --- 命令 handler ------------------------------------------------------------

/**
 * 消费一次 llm 流并收集文本块，直到流结束；对不支持 reasoningEffort
 * 'off' 的提供方做一次无 reasoningEffort 的重试。
 * - 参数类型：ctx -- Context；options -- GenerateOptions（含 reasoningEffort）。
 * - 返回值：string -- 模型输出的纯文本（未经清洗）。
 * - 抛出：Error -- 流错误、超时或非文本结束原因。
 * - 调用样例：const raw = await streamTitle(ctx, options)
 */
async function streamTitle(ctx, options) {
  const attempt = async (opts) => {
    const assembler = new BlockAssembler()
    for await (const chunk of ctx.llm.stream(opts)) assembler.push(chunk)
    const finish = assembler.finish || { kind: 'stop' }
    if (finish.kind === 'error' || finish.kind === 'aborted') {
      const failure = (finish.failure || {})
      const error = new Error(failure.message || `llm stream ${finish.kind}`)
      if (failure.code) error.code = failure.code
      throw error
    }
    if (finish.kind === 'max-tokens') throw new Error('title output reached maxTokens')
    if (finish.kind === 'tool-calls') throw new Error('title model unexpectedly requested a tool')
    if (finish.kind !== 'stop') throw new Error(`unsupported finish reason: ${finish.kind}`)
    const blocks = assembler.blocks()
    return blocks.filter((block) => block.type === 'text').map((block) => block.text).join(' ')
  }
  try {
    return await attempt(options)
  } catch (error) {
    const code = error && error.code
    const message = error && error.message ? String(error.message) : ''
    const unsupported = code === 'UNSUPPORTED_REASONING_EFFORT' || /reasoning effort/i.test(message)
    if (!unsupported || options.reasoningEffort === undefined) throw error
    const { reasoningEffort: _dropped, ...rest } = options
    void _dropped
    return await attempt(rest)
  }
}

/**
 * 组装 /regenerate-title 命令的 handler。
 * - 参数类型：ctx -- Context；config -- 合并默认值后的插件配置。
 * - 返回值：function -- CommandInvocation => CommandResult 的异步 handler。
 * - 调用样例：ctx.commands.register({ name: 'regenerate-title', handler: makeHandler(ctx, config), ... })
 */
function makeHandler(ctx, config) {
  return async ({ agent, signal }) => {
    try {
      const messages = userMessagesOf(sessionEventsOf(agent.session), config.maxInputBytes)
      if (messages.length === 0) {
        return { kind: 'error', text: '这个会话还没有可总结的用户提问' }
      }
      const route = config.provider && config.model
        ? { provider: config.provider, model: config.model }
        : sessionRouteOf(agent)
      if (!route) {
        return { kind: 'error', text: '无法确定模型路由：会话没有请求头配置，且插件未配置 provider/model' }
      }
      const guarded = withTimeout(signal, config.timeoutMs)
      try {
        const raw = await streamTitle(ctx, {
          provider: route.provider,
          model: route.model,
          reasoningEffort: resolveReasoningEffort(config),
          messages: [createUserMessage({ content: [{ type: 'text', text: frameMessages(messages) }] })],
          system: systemPrompt(config),
          maxTokens: config.maxOutputTokens,
          sessionId: agent.session.id,
          purpose: 'session-title',
          signal: guarded.signal,
        })
        const title = capCodePoints(cleanTitle(raw), 60)
        if (title.length === 0) {
          return { kind: 'error', text: '模型没有产生有效的标题文本' }
        }
        ctx.sessionTitle.rename(agent.session, title)
        return { kind: 'success', text: title }
      } finally {
        guarded.dispose()
      }
    } catch (error) {
      if (signal.aborted) return { kind: 'error', text: '重新生成标题已取消' }
      const message = error && error.message ? error.message : String(error)
      return { kind: 'error', text: `重新生成标题失败：${message}` }
    }
  }
}

/**
 * 插件宿主入口：注册 /regenerate-title 命令。
 * - 参数类型：ctx -- Context；config -- Loader 行配置（可选，合并进 DEFAULTS）。
 * - 返回值：function -- 命令注销用的 effect disposer（随插件卸载执行）。
 * - 调用样例：由 cordis Loader 按 apply/inject/name 约定调用。
 */
function apply(ctx, config) {
  const resolved = normalizeEntryConfig({ ...DEFAULTS, ...(config && typeof config === 'object' ? config : {}) })
  return ctx.commands.register({
    name: 'regenerate-title',
    description: '用当前模型总结全部用户提问并重写会话标题（思考开关/推理强度/输出上限见 设置 → 本地插件 → 重新生成标题）',
    recordInput: false,
    handler: makeHandler(ctx, resolved),
  })
}

// --- 0.2.0 entry config（设置页命名空间）--------------------------------------

/**
 * 0.2.0 把「插件行配置」做成了设置分页：settings 服务读每个插件 entry 导出的
 * Config（`entry.fiber.runtime.Config`），投影在 ENTRY ID（本插件 =
 * `session-title-regenerate`）下，向别的 ns 写入直接抛
 * `No configurable plugin entry "<ns>"`。`link:` 形态的宿主半无法 import
 * `@deepseek-ai/schemastery`（ERR_MODULE_NOT_FOUND），所以这里手写 schema，
 * 需要满足三个消费者：
 *   - cordis `resolveConfig` → `Config[~standard].validate(raw)`；
 *   - settings 服务 → `meta.volatile`（volatileForm）+ `toJSON()`：它用
 *     `new z(schema.toJSON())` 重建真 schemastery（dsh-settings 的
 *     lib/types/schema.js plainSchema），所以这张 refs 表必须与真实输出同形；
 *   - loader diff → `~standard.vendor`：故意不写 'schemastery'，好让配置写入走
 *     普通 entry restart（apply(ctx, config) 拿到新值），而不是我们表达不了的
 *     in-place volatile commit。
 * 下表由等价的 schemastery schema（`z.object({...}).volatile().toJSON()`）离线
 * 生成，并用 `new z(json)` 回灌验证过。
 */
const CONFIG_SCHEMA_JSON = Object.freeze({"uid":15,"refs":{"1":{"type":"number","meta":{"default":40}},"3":{"type":"number","meta":{"default":60}},"5":{"type":"number","meta":{"default":12288}},"7":{"type":"boolean","meta":{"default":false}},"9":{"type":"string","meta":{"default":"off"}},"11":{"type":"number","meta":{"default":512}},"13":{"type":"number","meta":{"default":30000}},"15":{"type":"object","meta":{"default":{},"volatile":true},"dict":{"targetWords":1,"targetCjkCharacters":3,"maxInputBytes":5,"thinking":7,"reasoningEffort":9,"maxOutputTokens":11,"timeoutMs":13}}}})

/** 导出给 Loader / 设置服务的 Config schema（见上方说明）。 */
function entryConfigSchema() {
  const schema = (input) => normalizeEntryConfig(input)
  schema.meta = { volatile: true }
  schema.type = 'object'
  schema.toJSON = () => JSON.parse(JSON.stringify(CONFIG_SCHEMA_JSON))
  schema['~standard'] = {
    version: 1,
    vendor: 'dsh-session-title-regenerate',
    validate(value) {
      try { return { value: normalizeEntryConfig(value) } }
      catch (error) { return { issues: [{ message: error && error.message ? error.message : String(error) }] } }
    },
  }
  return schema
}

/** 0.2.0 行配置 schema（测试断言其形状与 vendor）。 */
export const Config = entryConfigSchema()

export {
  apply, inject, name, DEFAULTS, REASONING_EFFORTS,
  MAX_OUTPUT_TOKENS_MIN, MAX_OUTPUT_TOKENS_MAX,
  clampInt, normalizeReasoningEffort, normalizeEntryConfig, resolveReasoningEffort,
}
