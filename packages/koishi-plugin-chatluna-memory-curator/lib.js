'use strict'
// 纯逻辑模块:无 koishi 依赖,可离线单测。

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) { dot += a[i] * b[i]; na += a[i] * a[i]; nb += b[i] * b[i] }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

function minMaxNormalize(values) {
  if (!values.length) return []
  const min = Math.min(...values), max = Math.max(...values)
  if (max === min) return values.map(() => 1)
  return values.map((v) => (v - min) / (max - min))
}

function toEntity(platform, userId) {
  const id = userId == null ? '' : String(userId).trim()
  return id.length ? `${platform}:${id}` : null
}

function inferEntityFromRow(row, platform) {
  const msgs = (row && Array.isArray(row.sourceMessages)) ? row.sourceMessages : []
  for (let i = msgs.length - 1; i >= 0; i--) {
    const id = msgs[i] && msgs[i].id
    if (id != null && String(id).trim().length) return toEntity(platform, id)
  }
  return null
}

module.exports = { cosineSimilarity, minMaxNormalize, toEntity, inferEntityFromRow }
