'use strict'
const album = require('./album')
// 纯词法选取：pool 已是全量条目；按 scope/originKey 过滤 + nsfw 门 + ts 倒序 + desc 词法消歧。
// 返回 entry|null。向量消歧在 index.js 的 async 包装里先于词法尝试（见 findAlbumEntry）。
function pickFromPool(pool, desc, opts) {
  opts = opts || {}
  const scope = opts.scope || 'all'
  let cand = Array.isArray(pool) ? pool : []
  if (scope === 'origin' && opts.originKey) cand = cand.filter((e) => e && e.originKey === opts.originKey)
  const eligible = album.eligibleByRating(cand, !!opts.nsfw)
  if (!eligible.length) return null
  const byRecent = eligible.slice().sort((a, b) => (b.ts || 0) - (a.ts || 0))
  const query = String(desc == null ? '' : desc).trim()
  if (!query) return byRecent[0] || null
  const best = album.pickBest(query, byRecent, Date.now())
  // origin 范围：desc 无词法匹配也只回退到"本会话最近"，绝不越出本会话
  if (!best && scope === 'origin') return byRecent[0] || null
  return best || null
}
module.exports = { pickFromPool }
