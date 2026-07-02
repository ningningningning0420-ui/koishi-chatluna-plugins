'use strict'

// Pure album matching logic for the recall feature ([[photo:描述|recall]]). The plugin keeps a
// local album of bot-curated photos (each entry = { id, file, intent, sceneTags, nsfw, selfInFrame,
// originKey, ts }); on recall we score the query against every entry and return ranked candidates.
// IO (reading/writing the index file, copying PNGs) lives in index.js — this file is unit-tested.

// normalize for fuzzy compare: lowercase, drop whitespace/punctuation/separators (CJK-friendly).
function norm(s) {
  return String(s == null ? '' : s)
    .toLowerCase()
    .replace(/[\s，。！？、,.!?|_:：;；·]/g, '')
}

// character bigram set — works for CJK (no word boundaries) and latin alike.
function bigrams(s) {
  const t = norm(s)
  const set = new Set()
  if (t.length === 1) set.add(t)
  for (let i = 0; i < t.length - 1; i++) set.add(t.slice(i, i + 2))
  return set
}

// fraction of the QUERY's bigrams that appear in the entry text (0..1). Asymmetric on purpose:
// a short query fully contained in a long intent scores high.
function bigramOverlap(query, hay) {
  const A = bigrams(query)
  const B = bigrams(hay)
  if (!A.size || !B.size) return 0
  let inter = 0
  for (const g of A) if (B.has(g)) inter++
  return inter / A.size
}

// score one entry against the recall query. overlap dominates; recency is a tiny tie-breaker.
function scoreEntry(query, entry, now) {
  const hay = (entry && (entry.intent || '')) + ' ' + (entry && (entry.sceneTags || ''))
  const overlap = bigramOverlap(query, hay)
  let recency = 0
  if (now && entry && entry.ts) {
    const ageDays = Math.max(0, (now - entry.ts) / 86400000)
    recency = 1 / (1 + ageDays)
  }
  return overlap + 0.05 * recency
}

// rank album entries by match to the query; returns [{ entry, score }] desc, score>threshold only.
function matchAlbum(query, entries, now, threshold) {
  const th = typeof threshold === 'number' ? threshold : 0.12
  return (Array.isArray(entries) ? entries : [])
    .map((entry) => ({ entry, score: scoreEntry(query, entry, now) }))
    .filter((x) => x.score >= th)
    .sort((a, b) => b.score - a.score)
}

// best single match, or null.
function pickBest(query, entries, now, threshold) {
  const ranked = matchAlbum(query, entries, now, threshold)
  return ranked.length ? ranked[0].entry : null
}

// ── semantic (vector) matching: cosine similarity over embeddings (bge-m3 etc.) ──
function dot(a, b) {
  let s = 0
  const n = Math.min(a.length, b.length)
  for (let i = 0; i < n; i++) s += a[i] * b[i]
  return s
}
function magnitude(a) {
  let s = 0
  for (const x of a) s += x * x
  return Math.sqrt(s)
}
function cosineSim(a, b) {
  if (!Array.isArray(a) || !Array.isArray(b) || !a.length || !b.length) return 0
  const d = magnitude(a) * magnitude(b)
  return d ? dot(a, b) / d : 0
}
// rank entries that HAVE a stored .vec by cosine similarity to the query vector (desc, >= threshold).
function matchAlbumVec(qvec, entries, threshold) {
  const th = typeof threshold === 'number' ? threshold : 0.45
  return (Array.isArray(entries) ? entries : [])
    .filter((e) => e && Array.isArray(e.vec) && e.vec.length)
    .map((e) => ({ entry: e, score: cosineSim(qvec, e.vec) }))
    .filter((x) => x.score >= th)
    .sort((a, b) => b.score - a.score)
}
function pickBestVec(qvec, entries, threshold) {
  const ranked = matchAlbumVec(qvec, entries, threshold)
  return ranked.length ? ranked[0].entry : null
}

// rating gate: a recall only reaches NSFW entries when it explicitly asked for nsfw (informed).
// allowNsfw=false → NSFW entries are NOT eligible (never leak nsfw into a non-nsfw recall).
function eligibleByRating(entries, allowNsfw) {
  return (Array.isArray(entries) ? entries : []).filter((e) => e && (allowNsfw ? true : !e.nsfw))
}

// parse the overflow-prune LLM reply → array of entry ids to delete. Tolerant: accepts a JSON object
// {"delete":[...]}, a bare JSON array, or ids embedded in prose; returns [] on anything unparseable.
function parsePruneDecision(raw) {
  const text = String(raw == null ? '' : raw)
  let ids = null
  const obj = text.match(/\{[\s\S]*\}/)
  const arr = text.match(/\[[\s\S]*\]/)
  for (const m of [obj, arr]) {
    if (ids || !m) continue
    try {
      const v = JSON.parse(m[0])
      if (Array.isArray(v)) ids = v
      else if (v && Array.isArray(v.delete)) ids = v.delete
    } catch (e) {
      /* try next */
    }
  }
  if (!ids) return []
  return ids.map((x) => String(x).trim()).filter(Boolean)
}

module.exports = { norm, bigrams, bigramOverlap, scoreEntry, matchAlbum, pickBest, cosineSim, matchAlbumVec, pickBestVec, eligibleByRating, parsePruneDecision }
