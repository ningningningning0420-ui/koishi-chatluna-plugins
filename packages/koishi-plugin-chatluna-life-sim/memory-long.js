'use strict'

// memory-long.js — LongTermMemory for koishi-plugin-chatluna-life-sim
//
// Pure helpers (offline-testable, no runtime deps):
//   matchByKey(entries, key)   → LTM entries matching {thread|entity|date} key (direct filter)
//
// DB glue (needs ctx.database):
//   createLongTermMemory(ctx) → { byKey, relationship, upsertLtm, archiveLtm, prune, touch }
//
// Design refs: §4.2 (LTM schema), §4.5 (forgetting)
//
// life_sim_ltm fields:
//   id, presetId, kind('event'|'insight'|'habit'), content, summary,
//   keywords(json), entities(json), importance, refCount, createdAt, lastAccessedAt, embedding?
//
// life_sim_relationship fields:
//   id, presetId, otherKey, summary, openThreads(json), tone, lastChatId, updatedAt

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Filter LTM entries matching a key object.
 *
 * Supported key shapes:
 *   { thread: string }  — entries whose keywords array includes the thread value
 *                          OR whose content/summary contains the thread string
 *   { entity: string }  — entries whose entities array includes the entity value
 *   { date: string }    — entries created on the given YYYY-MM-DD date
 *                          (checks createdAt as ISO date prefix)
 *
 * entries must already have keywords/entities as arrays (caller should parse JSON before calling).
 * Returns [] for unknown key shape or empty input.
 *
 * No new Date() in pure function — createdAt comparisons treat the stored value as a string prefix.
 *
 * @param {Array} entries   Array of LTM entry objects with keywords/entities already parsed
 * @param {object} key      { thread: string } | { entity: string } | { date: string }
 * @returns {Array}         Matching entries
 */
function matchByKey(entries, key) {
  if (!Array.isArray(entries) || entries.length === 0) return []
  if (!key || typeof key !== 'object') return []

  if (typeof key.thread === 'string') {
    const thread = key.thread.toLowerCase()
    return entries.filter((e) => {
      // Check keywords array
      if (Array.isArray(e.keywords)) {
        for (const kw of e.keywords) {
          if (typeof kw === 'string' && kw.toLowerCase() === thread) return true
        }
      }
      // Also check content and summary for thread mentions
      if (typeof e.content === 'string' && e.content.toLowerCase().includes(thread)) return true
      if (typeof e.summary === 'string' && e.summary.toLowerCase().includes(thread)) return true
      return false
    })
  }

  if (typeof key.entity === 'string') {
    const entity = key.entity.toLowerCase()
    return entries.filter((e) => {
      if (Array.isArray(e.entities)) {
        for (const ent of e.entities) {
          if (typeof ent === 'string' && ent.toLowerCase() === entity) return true
        }
      }
      return false
    })
  }

  if (typeof key.date === 'string') {
    // date is YYYY-MM-DD; match against createdAt as Date or ISO string
    const targetDate = key.date.slice(0, 10)
    return entries.filter((e) => {
      if (!e.createdAt) return false
      let dateStr
      if (e.createdAt instanceof Date) {
        dateStr = e.createdAt.toISOString().slice(0, 10)
      } else {
        dateStr = String(e.createdAt).slice(0, 10)
      }
      return dateStr === targetDate
    })
  }

  return []
}

// ---------------------------------------------------------------------------
// Internal: parse JSON fields on a raw LTM DB row
// ---------------------------------------------------------------------------

function parseLtmRow(row) {
  if (!row) return row
  const e = Object.assign({}, row)
  if (typeof e.keywords === 'string') {
    try { e.keywords = JSON.parse(e.keywords) } catch (_) { e.keywords = [] }
  } else if (!Array.isArray(e.keywords)) {
    e.keywords = []
  }
  if (typeof e.entities === 'string') {
    try { e.entities = JSON.parse(e.entities) } catch (_) { e.entities = [] }
  } else if (!Array.isArray(e.entities)) {
    e.entities = []
  }
  return e
}

// ---------------------------------------------------------------------------
// Internal: parse JSON fields on a relationship DB row
// ---------------------------------------------------------------------------

function parseRelRow(row) {
  if (!row) return row
  const e = Object.assign({}, row)
  if (typeof e.openThreads === 'string') {
    try { e.openThreads = JSON.parse(e.openThreads) } catch (_) { e.openThreads = [] }
  } else if (!Array.isArray(e.openThreads)) {
    e.openThreads = []
  }
  return e
}

// ---------------------------------------------------------------------------
// DB glue: LongTermMemory
// ---------------------------------------------------------------------------

const LTM_TABLE = 'life_sim_ltm'
const REL_TABLE = 'life_sim_relationship'

/**
 * Create the long-term memory store bound to ctx.database.
 *
 * @param {object} ctx  Koishi context with ctx.database
 * @returns {{ byKey, relationship, upsertLtm, archiveLtm, prune, touch }}
 */
function createLongTermMemory(ctx) {

  /**
   * Retrieve LTM entries for presetId matching a key.
   * Supports { thread }, { entity }, { date } keys.
   * Returns parsed rows (keywords/entities as arrays).
   *
   * @param {string} presetId
   * @param {object} key  { thread|entity|date: string }
   * @returns {Promise<Array>}
   */
  async function byKey(presetId, key) {
    const rows = await ctx.database.get(LTM_TABLE, { presetId })
    const entries = rows.map(parseLtmRow)
    return matchByKey(entries, key)
  }

  /**
   * Get the relationship record for presetId ↔ otherKey.
   * Returns null if none exists.
   *
   * @param {string} presetId
   * @param {string} other  The other entity's key
   * @returns {Promise<object|null>}
   */
  async function relationship(presetId, other) {
    const rows = await ctx.database.get(REL_TABLE, { presetId, otherKey: other })
    if (!rows || rows.length === 0) return null
    return parseRelRow(rows[0])
  }

  /**
   * Upsert a long-term memory entry.
   * If entry.id is provided and a row with that id exists → update.
   * Otherwise → create new.
   *
   * Sets createdAt on create (caller provides nowMs for explicit timestamp),
   * sets lastAccessedAt on both create and update.
   *
   * Keywords/entities are JSON-stringified from arrays.
   * The RETURNED created row's id is used (not the input object's id).
   *
   * @param {string} presetId
   * @param {object} entry  LTM fields (kind, content, summary, keywords, entities, importance, refCount?, id?)
   * @param {number} nowMs  Explicit timestamp in ms (caller provides; no new Date() in pure path)
   * @returns {Promise<object>}  The upserted row
   */
  async function upsertLtm(presetId, entry, nowMs) {
    const now = new Date(nowMs)

    const keywordsStr = JSON.stringify(
      Array.isArray(entry.keywords) ? entry.keywords : []
    )
    const entitiesStr = JSON.stringify(
      Array.isArray(entry.entities) ? entry.entities : []
    )

    const base = {
      presetId,
      kind:           entry.kind           != null ? entry.kind           : 'event',
      content:        entry.content        != null ? entry.content        : null,
      summary:        entry.summary        != null ? entry.summary        : null,
      keywords:       keywordsStr,
      entities:       entitiesStr,
      importance:     entry.importance     != null ? entry.importance     : null,
      refCount:       entry.refCount       != null ? entry.refCount       : 0,
      lastAccessedAt: now,
      embedding:      entry.embedding      != null ? entry.embedding      : null,
    }

    // If entry.id is set, try to update existing row
    if (entry.id != null) {
      const existing = await ctx.database.get(LTM_TABLE, { id: entry.id })
      if (existing && existing.length > 0) {
        await ctx.database.set(LTM_TABLE, { id: entry.id }, Object.assign({}, base))
        const updated = await ctx.database.get(LTM_TABLE, { id: entry.id })
        return parseLtmRow((updated && updated[0]) || Object.assign({ id: entry.id }, base))
      }
    }

    // Create new row — get createdAt from caller
    const row = Object.assign({ createdAt: now }, base)
    const created = await ctx.database.create(LTM_TABLE, row)
    // Use returned row's id (systemic contract)
    return parseLtmRow(created || row)
  }

  /**
   * Archive (soft-delete by marking importance very low) or hard-remove an LTM entry.
   * We use hard remove (delete) since archived entries contribute noise.
   * If you need soft-delete, set importance to 0 instead.
   *
   * @param {number} id
   * @returns {Promise<void>}
   */
  async function archiveLtm(id) {
    await ctx.database.remove(LTM_TABLE, { id })
  }

  /**
   * Prune LTM entries for presetId where importance < threshold AND refCount <= 1.
   * (Low-importance, low-reference-count entries are forgotten.)
   *
   * @param {string} presetId
   * @param {number} threshold  importance cutoff (§4.5, from config.pruneThreshold)
   * @returns {Promise<number>}  Number of pruned entries
   */
  async function prune(presetId, threshold) {
    const rows = await ctx.database.get(LTM_TABLE, { presetId })
    const toRemove = rows
      .filter((r) => {
        const imp = r.importance != null ? r.importance : 0
        const ref = r.refCount   != null ? r.refCount   : 0
        return imp < threshold && ref <= 1
      })
      .map((r) => r.id)
    if (toRemove.length > 0) {
      await ctx.database.remove(LTM_TABLE, { id: toRemove })
    }
    return toRemove.length
  }

  /**
   * Touch an LTM entry: increment refCount and update lastAccessedAt.
   *
   * @param {number} id
   * @param {number} nowMs  Explicit timestamp in ms
   * @returns {Promise<void>}
   */
  async function touch(id, nowMs) {
    const rows = await ctx.database.get(LTM_TABLE, { id })
    if (!rows || rows.length === 0) return
    const row = rows[0]
    const newRefCount = (row.refCount != null ? row.refCount : 0) + 1
    await ctx.database.set(LTM_TABLE, { id }, {
      refCount:       newRefCount,
      lastAccessedAt: new Date(nowMs),
    })
  }

  /**
   * Upsert a relationship record for presetId ↔ otherKey.
   * Creates new or updates existing (matched by presetId+otherKey).
   *
   * @param {string} presetId
   * @param {string} otherKey
   * @param {object} patch  Partial relationship fields
   * @param {number} nowMs  Explicit timestamp in ms
   * @returns {Promise<object>}
   */
  async function upsertRelationship(presetId, otherKey, patch, nowMs) {
    const now = new Date(nowMs)
    const openThreadsStr = JSON.stringify(
      Array.isArray(patch.openThreads) ? patch.openThreads : []
    )
    const row = {
      presetId,
      otherKey,
      summary:     patch.summary     != null ? patch.summary     : null,
      openThreads: openThreadsStr,
      tone:        patch.tone        != null ? patch.tone        : null,
      lastChatId:  patch.lastChatId  != null ? patch.lastChatId  : null,
      updatedAt:   now,
    }
    const existing = await ctx.database.get(REL_TABLE, { presetId, otherKey })
    if (existing && existing.length > 0) {
      await ctx.database.set(REL_TABLE, { id: existing[0].id }, {
        summary:     row.summary,
        openThreads: row.openThreads,
        tone:        row.tone,
        lastChatId:  row.lastChatId,
        updatedAt:   row.updatedAt,
      })
      return parseRelRow(Object.assign({}, existing[0], row))
    }
    const created = await ctx.database.create(REL_TABLE, row)
    return parseRelRow(created || row)
  }

  return { byKey, relationship, upsertLtm, archiveLtm, prune, touch, upsertRelationship }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // Pure helpers (exported for testing)
  matchByKey,
  // Internal parse helpers (exported for testing)
  parseLtmRow,
  parseRelRow,
  // DB glue factory
  createLongTermMemory,
}
