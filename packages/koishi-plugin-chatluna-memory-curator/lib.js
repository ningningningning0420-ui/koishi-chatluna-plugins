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

function threeFactorScore({ relevance, importance, recencyHours }, weights, tau) {
  const rec = Math.exp(-recencyHours / tau)
  return weights.rel * relevance + weights.imp * importance + weights.rec * rec
}

function rankCandidates(candidates, queryVec, nowMs, opts) {
  const { weights, tau, topK } = opts
  const rawRel = candidates.map((c) => (queryVec ? cosineSimilarity(queryVec, c.embedding) : 0))
  const normRel = minMaxNormalize(rawRel)
  const scored = candidates.map((c, i) => {
    const importance = c.row.importance == null ? 0.5 : c.row.importance
    const recencyHours = Math.max(0, (nowMs - new Date(c.row.updatedAt).getTime()) / 3600_000)
    const _score = threeFactorScore({ relevance: normRel[i], importance, recencyHours }, weights, tau)
    return { ...c.row, _score }
  })
  scored.sort((a, b) => b._score - a._score)
  return scored.slice(0, topK)
}

function parseProfile(content) {
  const obj = {}
  for (const line of String(content || '').split('\n')) {
    const idx = line.indexOf(':')
    if (idx < 0) continue
    const key = line.slice(0, idx).trim()
    const val = line.slice(idx + 1).trim()
    if (key) obj[key] = val
  }
  return obj
}

function renderProfile(obj, template) {
  const fields = (template && template.length) ? template : Object.keys(obj)
  return fields
    .filter((k) => obj[k] != null && String(obj[k]).length)
    .map((k) => `${k}: ${obj[k]}`)
    .join('\n')
}

function capText(s, max) {
  s = String(s == null ? '' : s)
  return s.length <= max ? s : s.slice(0, max)
}

function mergeProfile(currentContent, patch, template, maxChars) {
  const obj = parseProfile(currentContent)
  for (const [k, v] of Object.entries(patch || {})) {
    if (v == null || String(v).trim() === '') delete obj[k]
    else obj[k] = String(v).trim()
  }
  return capText(renderProfile(obj, template), maxChars)
}

function selectPresent(recentSpeakerEntities, profilesByEntity, cap) {
  const out = []
  for (const entity of recentSpeakerEntities) {
    if (out.length >= cap) break
    const content = profilesByEntity.get(entity)
    if (content != null) out.push({ entity, content })
  }
  return out
}

module.exports = { cosineSimilarity, minMaxNormalize, toEntity, inferEntityFromRow, threeFactorScore, rankCandidates, parseProfile, renderProfile, capText, mergeProfile, selectPresent }
