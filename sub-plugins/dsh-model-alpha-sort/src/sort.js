/**
 * 模型排序的纯逻辑层：不依赖宿主、不产生副作用，可直接在 node 里单测。
 *
 * 排序键默认取模型显示名（name），空白时回退模型 id；比较器用
 * Intl.Collator（数字感知 + 忽略大小写/变音符号），中文按拼音。
 */

export const SORT_KEYS = Object.freeze(['name', 'id'])
export const DIRECTIONS = Object.freeze(['asc', 'desc'])
export const DEFAULT_OPTIONS = Object.freeze({
  sortBy: 'name',
  direction: 'asc',
  collation: 'zh-CN',
})

const COLLATOR_CACHE = new Map()

/**
 * 判断一个值是否为普通对象（排除 null 与数组）。
 * @param {unknown} value 任意值，例 {}
 * @returns {boolean} 例 true
 */
function isPlainObject(value) {
  return typeof value === 'object' && value !== null && !Array.isArray(value)
}

/**
 * 取（并缓存）某个 locale 的字符串比较器。
 * @param {string} locale 语言标签，例 'zh-CN'；空值回退 'zh-CN'，非法值回退运行环境默认
 * @returns {Intl.Collator} 数字感知、忽略大小写与变音符号的比较器
 */
export function collatorFor(locale) {
  const key = typeof locale === 'string' && locale.trim() !== '' ? locale.trim() : 'zh-CN'
  const cached = COLLATOR_CACHE.get(key)
  if (cached !== undefined) return cached
  let collator
  try {
    collator = new Intl.Collator(key, { numeric: true, sensitivity: 'base' })
  } catch {
    // 非法 locale 不能让排序整体失败：退回运行环境默认 locale。
    collator = new Intl.Collator(undefined, { numeric: true, sensitivity: 'base' })
  }
  COLLATOR_CACHE.set(key, collator)
  return collator
}

/**
 * 把任意输入归一化成合法的排序选项，缺省字段用默认值。
 * @param {unknown} input 例 { sortBy: 'id', direction: 'desc' }
 * @returns {{ sortBy: 'name'|'id', direction: 'asc'|'desc', collation: string }} 例 { sortBy: 'name', direction: 'asc', collation: 'zh-CN' }
 * @example normalizeOptions({ direction: 'desc' })
 */
export function normalizeOptions(input) {
  const source = isPlainObject(input) ? input : {}
  const sortBy = SORT_KEYS.includes(source.sortBy) ? source.sortBy : DEFAULT_OPTIONS.sortBy
  const direction = DIRECTIONS.includes(source.direction) ? source.direction : DEFAULT_OPTIONS.direction
  const collation = typeof source.collation === 'string' && source.collation.trim() !== ''
    ? source.collation.trim()
    : DEFAULT_OPTIONS.collation
  return { sortBy, direction, collation }
}

/**
 * 取模型 id 的字符串形式；缺失或非字符串时安全降级。
 * @param {unknown} model 模型行，例 { id: 'gpt-6-astra' }
 * @returns {string} 例 'gpt-6-astra'
 */
export function modelIdOf(model) {
  if (!isPlainObject(model)) return ''
  if (typeof model.id === 'string') return model.id
  if (model.id === undefined || model.id === null) return ''
  return String(model.id)
}

/**
 * 取排序键：显示名去掉首尾空白，为空则回退模型 id。
 * @param {unknown} model 模型行，例 { id: 'gpt-6-astra', name: ' GPT 6 Astra ' }
 * @param {'name'|'id'} sortBy 排序键，例 'name'
 * @returns {string} 例 'GPT 6 Astra'
 */
export function sortKeyOf(model, sortBy = 'name') {
  if (sortBy === 'id') return modelIdOf(model)
  if (!isPlainObject(model)) return ''
  const name = typeof model.name === 'string' ? model.name.trim() : ''
  return name !== '' ? name : modelIdOf(model)
}

/**
 * 比较两个模型：稳定比较，键相同时返回 0，交给 Array#sort 保持原有相对顺序。
 * @param {unknown} a 模型 A，例 { id: 'b', name: 'Beta' }
 * @param {unknown} b 模型 B，例 { id: 'a', name: 'Alpha' }
 * @param {object} [options] 排序选项，例 { sortBy: 'name', direction: 'asc', collation: 'zh-CN' }
 * @returns {number} 负数 / 0 / 正数，例 -1
 */
export function compareModels(a, b, options = DEFAULT_OPTIONS) {
  const normalized = normalizeOptions(options)
  const collator = collatorFor(normalized.collation)
  const order = collator.compare(
    sortKeyOf(a, normalized.sortBy),
    sortKeyOf(b, normalized.sortBy),
  )
  return normalized.direction === 'desc' ? -order : order
}

/**
 * 判断模型数组是否已按给定选项有序（长度小于 2 视为有序）。
 * @param {unknown} models 模型数组，例 [{ name: 'Alpha' }, { name: 'Beta' }]
 * @param {object} [options] 排序选项，例 { sortBy: 'name', direction: 'asc' }
 * @returns {boolean} 例 true
 */
export function isSorted(models, options = DEFAULT_OPTIONS) {
  if (!Array.isArray(models) || models.length < 2) return true
  const normalized = normalizeOptions(options)
  const collator = collatorFor(normalized.collation)
  const sign = normalized.direction === 'desc' ? -1 : 1
  for (let index = 1; index < models.length; index += 1) {
    const order = collator.compare(
      sortKeyOf(models[index - 1], normalized.sortBy),
      sortKeyOf(models[index], normalized.sortBy),
    )
    if (sign * order > 0) return false
  }
  return true
}

/**
 * 返回排好序的新数组（不改动入参）；键相同的模型保持原有相对顺序。
 * @param {unknown} models 模型数组，例 [{ name: 'Beta' }, { name: 'Alpha' }]
 * @param {object} [options] 排序选项，例 { sortBy: 'name', direction: 'asc' }
 * @returns {Array<unknown>} 新数组，例 [{ name: 'Alpha' }, { name: 'Beta' }]
 */
export function sortModels(models, options = DEFAULT_OPTIONS) {
  if (!Array.isArray(models)) return []
  const normalized = normalizeOptions(options)
  const collator = collatorFor(normalized.collation)
  const sign = normalized.direction === 'desc' ? -1 : 1
  return models.slice().sort((a, b) => sign * collator.compare(
    sortKeyOf(a, normalized.sortBy),
    sortKeyOf(b, normalized.sortBy),
  ))
}

/**
 * 沿路径取嵌套值；任一层缺失或不是对象时返回 undefined。
 * @param {unknown} root 根值，例 { providers: { codemaker: { models: [] } } }
 * @param {string[]} path 路径，例 ['providers', 'codemaker', 'models']
 * @returns {unknown} 命中的值，例 []
 */
export function getAtPath(root, path) {
  if (!Array.isArray(path) || path.length === 0) return root
  let current = root
  for (const key of path) {
    if (current === null || current === undefined || typeof current !== 'object') return undefined
    current = current[key]
  }
  return current
}

/**
 * 由 provider 的 settingsPath 得到模型数组的完整路径（末尾追加 'models'）。
 * @param {readonly string[]} settingsPath provider 路径，例 ['providers', 'codemaker']
 * @returns {string[]} 例 ['providers', 'codemaker', 'models']
 */
export function sortPathOf(settingsPath) {
  const base = Array.isArray(settingsPath) ? settingsPath.slice() : []
  return [...base, 'models']
}

/**
 * 统计排序后位置发生变化的模型数量，用于状态里的「待排序」提示。
 * @param {unknown} before 原数组，例 [{ id: 'b' }, { id: 'a' }]
 * @param {unknown} after 排序后数组，例 [{ id: 'a' }, { id: 'b' }]
 * @returns {number} 移动过位置的模型数，例 2
 */
export function movedCount(before, after) {
  if (!Array.isArray(before) || !Array.isArray(after) || before.length !== after.length) return 0
  const originalIndex = new Map()
  before.forEach((model, index) => {
    if (!originalIndex.has(model)) originalIndex.set(model, index)
  })
  let moved = 0
  after.forEach((model, index) => {
    if (originalIndex.get(model) !== index) moved += 1
  })
  return moved
}
