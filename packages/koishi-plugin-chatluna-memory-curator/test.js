'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const lib = require('./lib')

test('cosineSimilarity: 同向=1, 正交=0, 维度不符=0', () => {
  assert.ok(Math.abs(lib.cosineSimilarity([1, 0], [2, 0]) - 1) < 1e-9)
  assert.equal(lib.cosineSimilarity([1, 0], [0, 1]), 0)
  assert.equal(lib.cosineSimilarity([1, 0], [1]), 0)
  assert.equal(lib.cosineSimilarity(null, [1]), 0)
})

test('minMaxNormalize: 线性映射到[0,1], 全相等→全1', () => {
  assert.deepEqual(lib.minMaxNormalize([0, 5, 10]), [0, 0.5, 1])
  assert.deepEqual(lib.minMaxNormalize([3, 3, 3]), [1, 1, 1])
  assert.deepEqual(lib.minMaxNormalize([]), [])
})

test('toEntity: 拼平台:号, 空号→null', () => {
  assert.equal(lib.toEntity('onebot', '123'), 'onebot:123')
  assert.equal(lib.toEntity('onebot', null), null)
  assert.equal(lib.toEntity('onebot', ''), null)
})

test('inferEntityFromRow: 取最后一条有 id 的发言者', () => {
  const row = { sourceMessages: [{ id: '111', content: 'a' }, { id: '222', content: 'b' }], sourceConversationId: 'group:9' }
  assert.equal(lib.inferEntityFromRow(row, 'onebot'), 'onebot:222')
  assert.equal(lib.inferEntityFromRow({ sourceMessages: [] }, 'onebot'), null)
  assert.equal(lib.inferEntityFromRow({ sourceMessages: [{ name: '无id' }] }, 'onebot'), null)
  assert.equal(lib.inferEntityFromRow({}, 'onebot'), null)
})
