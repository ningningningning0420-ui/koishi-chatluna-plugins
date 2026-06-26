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

test('threeFactorScore: 加权和, recency 指数衰减', () => {
  const s = lib.threeFactorScore({ relevance: 1, importance: 0.5, recencyHours: 0 }, { rel: 1, imp: 1, rec: 1 }, 72)
  assert.ok(Math.abs(s - (1 + 0.5 + 1)) < 1e-9) // rec=exp(0)=1
})

test('rankCandidates: 最近+高相关排前, 截 topK', () => {
  const now = 1_000_000_000_000
  const hour = 3600_000
  const cands = [
    { row: { id: 'old', importance: 0.9, updatedAt: new Date(now - 100 * hour) }, embedding: [1, 0] },
    { row: { id: 'fresh', importance: 0.5, updatedAt: new Date(now - 1 * hour) }, embedding: [1, 0] },
    { row: { id: 'off', importance: 0.5, updatedAt: new Date(now - 1 * hour) }, embedding: [0, 1] }
  ]
  const out = lib.rankCandidates(cands, [1, 0], now, { weights: { rel: 1, imp: 1, rec: 1 }, tau: 72, topK: 2 })
  assert.equal(out.length, 2)
  assert.equal(out[0].id, 'fresh') // 相关度并列但更新近 → recency 胜
})

test('rankCandidates: queryVec=null 时退化为 imp+rec', () => {
  const now = 1_000_000_000_000
  const cands = [{ row: { id: 'a', importance: 0.9, updatedAt: new Date(now) }, embedding: [1, 0] }]
  const out = lib.rankCandidates(cands, null, now, { weights: { rel: 1, imp: 1, rec: 1 }, tau: 72, topK: 5 })
  assert.equal(out[0].id, 'a')
})
