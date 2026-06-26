// 离线自测：纯逻辑（不依赖 koishi 运行时）。运行：node test.js
const assert = require('assert')
const { deriveKey, mergeById, isFresh } = require('./lib')

let pass = 0
function t(name, fn) {
  try {
    fn()
    pass++
    console.log('  PASS', name)
  } catch (e) {
    console.error('  FAIL', name, '\n   ', e.message)
    process.exitCode = 1
  }
}

// ---------- deriveKey ----------
t('deriveKey: 群聊用 group:<guildId>', () => {
  assert.strictEqual(
    deriveKey({ isDirect: false, guildId: '1087376492', userId: '999' }),
    'group:1087376492'
  )
})
t('deriveKey: 私聊用 private:<userId>', () => {
  assert.strictEqual(
    deriveKey({ isDirect: true, guildId: undefined, userId: '380926552' }),
    'private:380926552'
  )
})

// ---------- mergeById ----------
t('mergeById: 按 messageId 去重，incoming 覆盖同 id', () => {
  const existing = [{ id: 'a', messageId: 'm1', content: '旧', timestamp: 1 }]
  const incoming = [{ id: 'a', messageId: 'm1', content: '新', timestamp: 1 }]
  const out = mergeById(existing, incoming, 100)
  assert.strictEqual(out.length, 1)
  assert.strictEqual(out[0].content, '新')
})

t('mergeById: 不同 messageId 都保留', () => {
  const out = mergeById(
    [{ id: 'a', messageId: 'm1', timestamp: 1 }],
    [{ id: 'b', messageId: 'm2', timestamp: 2 }],
    100
  )
  assert.strictEqual(out.length, 2)
})

t('mergeById: 按 timestamp 升序排列', () => {
  const out = mergeById(
    [{ id: 'c', messageId: 'm3', timestamp: 30 }],
    [
      { id: 'a', messageId: 'm1', timestamp: 10 },
      { id: 'b', messageId: 'm2', timestamp: 20 }
    ],
    100
  )
  assert.deepStrictEqual(out.map((m) => m.messageId), ['m1', 'm2', 'm3'])
})

t('mergeById: 截断到 cap，保留最新（尾部）', () => {
  const msgs = []
  for (let i = 1; i <= 5; i++) msgs.push({ id: 's' + i, messageId: 'm' + i, timestamp: i })
  const out = mergeById([], msgs, 3)
  assert.strictEqual(out.length, 3)
  assert.deepStrictEqual(out.map((m) => m.messageId), ['m3', 'm4', 'm5'])
})

t('mergeById: 缺 messageId 时回退用 id|timestamp 去重', () => {
  const existing = [{ id: 'x', content: '旧', timestamp: 5 }]
  const incoming = [
    { id: 'x', content: '新', timestamp: 5 }, // 同 id 同 ts → 视作同一条
    { id: 'x', content: '另一条', timestamp: 6 } // 同 id 不同 ts → 不同条
  ]
  const out = mergeById(existing, incoming, 100)
  assert.strictEqual(out.length, 2)
  assert.strictEqual(out[0].content, '新')
})

t('mergeById: JSON 往返后对象结构不丢（含 images/quote）', () => {
  const m = {
    id: 'a',
    messageId: 'm1',
    name: '髭切',
    content: '你好',
    timestamp: 1,
    images: [{ url: 'http://x/y.png' }],
    quote: { id: 'q', messageId: 'm0', content: '引用', name: '妖祀' }
  }
  const roundTripped = JSON.parse(JSON.stringify([m]))
  const out = mergeById([], roundTripped, 100)
  assert.deepStrictEqual(out[0], m)
})

t('mergeById: 输入为空/非数组安全返回数组', () => {
  assert.deepStrictEqual(mergeById(null, null, 100), [])
  assert.deepStrictEqual(mergeById(undefined, [{ id: 'a', messageId: 'm', timestamp: 1 }], 100).length, 1)
})

// ---------- isFresh ----------
const NOW = 1_000_000_000_000 // 固定 now，避免 Date.now() 不确定
t('isFresh: maxAgeHours=0 视为不限，永远 fresh', () => {
  assert.strictEqual(isFresh(new Date(0), 0, NOW), true)
})
t('isFresh: 未超龄 → true', () => {
  const oneHourAgo = new Date(NOW - 1 * 3600_000)
  assert.strictEqual(isFresh(oneHourAgo, 24, NOW), true)
})
t('isFresh: 超龄 → false', () => {
  const twoDaysAgo = new Date(NOW - 48 * 3600_000)
  assert.strictEqual(isFresh(twoDaysAgo, 24, NOW), false)
})
t('isFresh: updatedAt 缺失 → 当 false（保守不灌）', () => {
  assert.strictEqual(isFresh(null, 24, NOW), false)
})

console.log(`\n${pass} passed`)
