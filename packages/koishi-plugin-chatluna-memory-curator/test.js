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
