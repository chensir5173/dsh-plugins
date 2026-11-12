// Tests for dsh-model-alpha-sort/src/sort.js (pure logic, zero host deps).
//
// Run: node sub-plugins/dsh-model-alpha-sort/test/sort.test.mjs
import assert from 'node:assert/strict'
import * as sort from '../src/sort.js'

const failures = []
let passed = 0

/** 运行一条同步断言；失败只记录不中断，最后统一退出码。 */
function check(name, fn) {
  try {
    fn()
    passed += 1
    console.log('  ok   ' + name)
  } catch (error) {
    failures.push(name + ': ' + ((error && error.message) || String(error)))
    console.log('  FAIL ' + name + ' → ' + ((error && error.message) || String(error)))
  }
}

/** 构造模型行，便于断言。 */
const model = (id, name) => (name === undefined ? { id } : { id, name })

// --- options -----------------------------------------------------------------

check('normalizeOptions: 缺省值', () => {
  assert.deepEqual(sort.normalizeOptions(undefined), { sortBy: 'name', direction: 'asc', collation: 'zh-CN' })
  assert.deepEqual(sort.normalizeOptions({}), { sortBy: 'name', direction: 'asc', collation: 'zh-CN' })
  assert.deepEqual(sort.normalizeOptions(null), { sortBy: 'name', direction: 'asc', collation: 'zh-CN' })
})

check('normalizeOptions: 保留合法值、拒绝非法值', () => {
  assert.deepEqual(sort.normalizeOptions({ sortBy: 'id', direction: 'desc', collation: 'en' }), { sortBy: 'id', direction: 'desc', collation: 'en' })
  assert.deepEqual(sort.normalizeOptions({ sortBy: 'bogus', direction: 'bogus', collation: '  ' }), { sortBy: 'name', direction: 'asc', collation: 'zh-CN' })
})

check('collatorFor: 同一 locale 返回缓存实例', () => {
  assert.equal(sort.collatorFor('zh-CN'), sort.collatorFor('zh-CN'))
  assert.notEqual(sort.collatorFor('zh-CN'), sort.collatorFor('en'))
})

check('collatorFor: 非法 locale 回退而不抛错', () => {
  assert.equal(typeof sort.collatorFor('not a locale!!'), 'object')
  assert.equal(typeof sort.collatorFor('').compare, 'function')
})

// --- keys --------------------------------------------------------------------

check('sortKeyOf: 显示名优先、去空白', () => {
  assert.equal(sort.sortKeyOf(model('gpt-6-astra', '  GPT 6 Astra  ')), 'GPT 6 Astra')
})

check('sortKeyOf: 空显示名回退 id', () => {
  assert.equal(sort.sortKeyOf(model('gpt-6-astra', '   ')), 'gpt-6-astra')
  assert.equal(sort.sortKeyOf(model('gpt-6-astra', '')), 'gpt-6-astra')
  assert.equal(sort.sortKeyOf(model('gpt-6-astra')), 'gpt-6-astra')
})

check('sortKeyOf: sortBy=id 时取 id', () => {
  assert.equal(sort.sortKeyOf(model('qwen3.8-flash', 'Qwen 3.8 Flash'), 'id'), 'qwen3.8-flash')
})

check('modelIdOf: 非字符串 id 安全转换', () => {
  assert.equal(sort.modelIdOf({ id: 42 }), '42')
  assert.equal(sort.modelIdOf({}), '')
  assert.equal(sort.modelIdOf(null), '')
})

// --- comparison --------------------------------------------------------------

check('sortModels: 显示名升序', () => {
  const input = [model('gpt', 'GPT 6 Astra'), model('claude', 'Claude Haiku 5.5'), model('qwen', 'Qwen 3.8 Flash')]
  const sorted = sort.sortModels(input)
  assert.deepEqual(sorted.map((item) => item.id), ['claude', 'gpt', 'qwen'])
})

check('sortModels: 不修改入参、返回新数组', () => {
  const input = [model('b', 'Beta'), model('a', 'Alpha')]
  const sorted = sort.sortModels(input)
  assert.deepEqual(input.map((item) => item.id), ['b', 'a'])
  assert.notEqual(sorted, input)
})

check('sortModels: 数字感知（gpt-2 在 gpt-10 前）', () => {
  const sorted = sort.sortModels([model('x10', 'gpt-10'), model('x2', 'gpt-2')])
  assert.deepEqual(sorted.map((item) => item.id), ['x2', 'x10'])
})

check('sortModels: 忽略大小写', () => {
  const sorted = sort.sortModels([model('b', 'beta'), model('a', 'Alpha')])
  assert.deepEqual(sorted.map((item) => item.id), ['a', 'b'])
})

check('sortModels: 中文按拼音（zh-CN）', () => {
  const sorted = sort.sortModels([model('bo', '波'), model('a', '阿')])
  assert.deepEqual(sorted.map((item) => item.id), ['a', 'bo'])
})

check('sortModels: 稳定性 —— 同键保持原相对顺序', () => {
  const input = [model('a1', 'Same'), model('a2', 'Same'), model('a3', 'same')]
  const sorted = sort.sortModels(input)
  assert.deepEqual(sorted.map((item) => item.id), ['a1', 'a2', 'a3'])
})

check('sortModels: 降序', () => {
  const sorted = sort.sortModels([model('a', 'Alpha'), model('c', 'Charlie'), model('b', 'Beta')], { direction: 'desc' })
  assert.deepEqual(sorted.map((item) => item.id), ['c', 'b', 'a'])
})

check('sortModels: sortBy=id', () => {
  const sorted = sort.sortModels([model('zeta', 'A'), model('alpha', 'Z')], { sortBy: 'id' })
  assert.deepEqual(sorted.map((item) => item.id), ['alpha', 'zeta'])
})

check('sortModels: 非数组返回空数组', () => {
  assert.deepEqual(sort.sortModels(undefined), [])
  assert.deepEqual(sort.sortModels('nope'), [])
})

check('compareModels: 相等键返回 0，升序返回负数', () => {
  assert.equal(sort.compareModels(model('a', 'Same'), model('b', 'Same')), 0)
  assert.ok(sort.compareModels(model('a', 'Alpha'), model('b', 'Beta')) < 0)
  assert.ok(sort.compareModels(model('a', 'Alpha'), model('b', 'Beta'), { direction: 'desc' }) > 0)
})

// --- isSorted ----------------------------------------------------------------

check('isSorted: 空 / 单元素 / 已有序为 true', () => {
  assert.equal(sort.isSorted([]), true)
  assert.equal(sort.isSorted([model('a', 'Alpha')]), true)
  assert.equal(sort.isSorted([model('a', 'Alpha'), model('b', 'Beta')]), true)
  assert.equal(sort.isSorted([model('b', 'Beta'), model('a', 'Alpha')]), false)
  assert.equal(sort.isSorted(null), true)
})

check('isSorted: 降序方向', () => {
  assert.equal(sort.isSorted([model('b', 'Beta'), model('a', 'Alpha')], { direction: 'desc' }), true)
  assert.equal(sort.isSorted([model('a', 'Alpha'), model('b', 'Beta')], { direction: 'desc' }), false)
})

// --- path helpers ------------------------------------------------------------

check('getAtPath: 命中与缺失', () => {
  const root = { providers: { codemaker: { models: [1, 2] } } }
  assert.deepEqual(sort.getAtPath(root, ['providers', 'codemaker', 'models']), [1, 2])
  assert.equal(sort.getAtPath(root, ['providers', 'missing', 'models']), undefined)
  assert.equal(sort.getAtPath(null, ['a']), undefined)
  assert.equal(sort.getAtPath(root, []), root)
})

check('sortPathOf: 追加 models，且不修改入参', () => {
  const base = ['providers', 'codemaker']
  assert.deepEqual(sort.sortPathOf(base), ['providers', 'codemaker', 'models'])
  assert.deepEqual(base, ['providers', 'codemaker'])
  assert.deepEqual(sort.sortPathOf(undefined), ['models'])
})

check('movedCount: 统计移动位置的元素数', () => {
  const a = { id: 'a' }
  const b = { id: 'b' }
  const c = { id: 'c' }
  assert.equal(sort.movedCount([a, b, c], [c, a, b]), 3)
  assert.equal(sort.movedCount([a, b, c], [a, b, c]), 0)
  assert.equal(sort.movedCount([a, b], [a]), 0)
})

console.log('\n' + passed + ' passed, ' + failures.length + ' failed')
if (failures.length > 0) {
  for (const failure of failures) console.log('FAIL ' + failure)
  process.exitCode = 1
}
