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

test('inferEntityFromRow: 私聊从 sourceConversationId 取对象, 群聊/缺失→null', () => {
  assert.equal(lib.inferEntityFromRow({ sourceConversationId: 'private:222' }, 'onebot'), 'onebot:222')
  assert.equal(lib.inferEntityFromRow({ sourceConversationId: 'group:9' }, 'onebot'), null)
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

test('rankCandidates: 输出只含 id/content/_score, 绝不泄漏 embedding 等大字段', () => {
  const now = 1_000_000_000_000
  const cands = [{ row: { id: 'x', content: 'hi', importance: 0.5, updatedAt: new Date(now), embedding: [1, 2, 3], sourceMessages: 'big' }, embedding: [1, 2, 3] }]
  const out = lib.rankCandidates(cands, [1, 2, 3], now, { weights: { rel: 1, imp: 1, rec: 1 }, tau: 72, topK: 5 })
  assert.deepEqual(Object.keys(out[0]).sort(), ['_score', 'content', 'id'])
  assert.equal(out[0].embedding, undefined)
  assert.equal(out[0].content, 'hi')
})

test('parseProfile/renderProfile 往返', () => {
  const obj = lib.parseProfile('称呼: 阿江\n好感度: 70')
  assert.deepEqual(obj, { 称呼: '阿江', 好感度: '70' })
  assert.equal(lib.renderProfile({ 称呼: '阿江', 好感度: '70' }, ['称呼', '好感度', '印象']), '称呼: 阿江\n好感度: 70')
})

test('mergeProfile: 合并新字段, null 删字段, 封顶', () => {
  const merged = lib.mergeProfile('称呼: 阿江\n好感度: 70', { 好感度: '85', 印象: '爱开玩笑' }, ['称呼', '好感度', '印象'], 1000)
  assert.equal(merged, '称呼: 阿江\n好感度: 85\n印象: 爱开玩笑')
  const removed = lib.mergeProfile('称呼: 阿江\n印象: x', { 印象: '' }, ['称呼', '好感度', '印象'], 1000)
  assert.equal(removed, '称呼: 阿江')
  assert.equal(lib.capText('abcdef', 3), 'abc')
})

test('selectPresent: 保留 recency 顺序, 仅有档案者, 截 cap', () => {
  const profiles = new Map([['onebot:1', 'A'], ['onebot:3', 'C']])
  const out = lib.selectPresent(['onebot:1', 'onebot:2', 'onebot:3'], profiles, 5)
  assert.deepEqual(out, [{ entity: 'onebot:1', content: 'A' }, { entity: 'onebot:3', content: 'C' }])
  assert.equal(lib.selectPresent(['onebot:1', 'onebot:3'], profiles, 1).length, 1)
})
