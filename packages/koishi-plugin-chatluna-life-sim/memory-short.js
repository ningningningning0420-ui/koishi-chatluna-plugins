'use strict'

// memory-short.js — ShortTermMemory + LifeStateStore for koishi-plugin-chatluna-life-sim
//
// Pure helpers (offline-testable, no runtime deps):
//   pickRecent(events, n)           → top-n events sorted by ts descending (stable)
//   isOlderThan(event, cutoffMs)    → boolean: event.ts < cutoffMs
//   defaultLifeState(presetId)      → fresh §5.2-shaped life-state object
//   mergeLifeState(prev, patch)     → new object, arrays replaced wholesale; pure (no new Date())
//
// DB glue (needs ctx.database, not tested offline):
//   createShortTermMemory(ctx, config) → { appendEvent, recent, rollOffOlderThan }
//   createLifeState(ctx)               → { getState, setState }

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Return the n most-recent events sorted by ts descending.
 * Stable: equal-ts events keep their original relative order.
 * @param {Array} events
 * @param {number} n
 * @returns {Array}
 */
function pickRecent(events, n) {
  if (!events || events.length === 0) return []
  // Build index array for stable sort
  const indexed = events.map((e, i) => ({ e, i }))
  indexed.sort((a, b) => {
    const ta = +a.e.ts
    const tb = +b.e.ts
    if (tb !== ta) return tb - ta  // descending by ts
    return a.i - b.i              // stable: preserve original order for equal ts
  })
  const take = (n == null || n > indexed.length) ? indexed.length : Math.max(0, n)
  return indexed.slice(0, take).map((x) => x.e)
}

/**
 * Return true if event.ts (as ms number or Date) is strictly before cutoffMs.
 * @param {{ ts: Date|number }} event
 * @param {number} cutoffMs  Unix ms timestamp
 * @returns {boolean}
 */
function isOlderThan(event, cutoffMs) {
  return +event.ts < cutoffMs
}

/**
 * Return a fresh §5.2 life-state object with sensible empty defaults.
 * @param {string} presetId
 * @returns {object}
 */
function defaultLifeState(presetId) {
  return {
    presetId: presetId,
    location: null,
    current_activity: null,
    mood: 'neutral',
    open_threads: [],
    recent_event_ids: [],
    updatedAt: null,
  }
}

/**
 * Merge patch over prev.  Arrays (open_threads, recent_event_ids) are replaced
 * wholesale when present in patch; preserved from prev when absent.
 * Scalar fields from patch override prev.
 * updatedAt is the CALLER's responsibility — this function does NOT call new Date().
 * Never mutates prev or patch; always returns a new object.
 * @param {object} prev
 * @param {object} patch
 * @returns {object}
 */
function mergeLifeState(prev, patch) {
  const result = Object.assign({}, prev, patch)

  // Replace arrays wholesale when present in patch, else keep prev's
  const ARRAY_FIELDS = ['open_threads', 'recent_event_ids']
  for (const field of ARRAY_FIELDS) {
    if (Object.prototype.hasOwnProperty.call(patch, field)) {
      // patch specifies this array — use it as-is (may be [], which is intentional)
      result[field] = patch[field]
    } else {
      // patch absent — preserve prev's value (already set by Object.assign above)
      result[field] = prev ? prev[field] : undefined
    }
  }

  return result
}

// ---------------------------------------------------------------------------
// DB glue helpers
// ---------------------------------------------------------------------------

/**
 * Format a Date as YYYY-MM-DD (local ISO date).
 * @param {Date} d
 * @returns {string}
 */
function toDateStr(d) {
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const day = String(d.getDate()).padStart(2, '0')
  return y + '-' + m + '-' + day
}

// ---------------------------------------------------------------------------
// DB glue: ShortTermMemory
// ---------------------------------------------------------------------------

/**
 * Create the short-term memory store bound to ctx.database.
 * @param {object} ctx   Koishi context with ctx.database
 * @param {object} config  { stmDays, stmMax }
 * @returns {{ appendEvent, recent, rollOffOlderThan }}
 */
function createShortTermMemory(ctx, config) {
  const TABLE = 'life_sim_event'

  /**
   * Insert a new event row.  ts and day are set explicitly at write time.
   * @param {string} presetId
   * @param {object} event  All life_sim_event fields except id/presetId/ts/day (those are set here)
   */
  async function appendEvent(presetId, event) {
    const ts = new Date()
    const day = toDateStr(ts)
    const row = Object.assign({}, event, {
      presetId,
      ts,
      day,
      consolidated: event.consolidated === true,
      participants: event.participants != null ? JSON.stringify(event.participants) : null,
      threads: event.threads != null ? JSON.stringify(event.threads) : null,
    })
    await ctx.database.create(TABLE, row)
  }

  /**
   * Return the n most-recent events for presetId (sorted by ts desc via DB, verified by pickRecent).
   * @param {string} presetId
   * @param {number} n
   * @returns {Promise<Array>}
   */
  async function recent(presetId, n) {
    const cap = (n != null && n > 0) ? n : (config && config.stmMax) || 60
    const rows = await ctx.database.get(TABLE, { presetId })
    // Parse JSON fields back to objects
    const events = rows.map((r) => {
      const e = Object.assign({}, r)
      if (typeof e.participants === 'string') {
        try { e.participants = JSON.parse(e.participants) } catch (_) { e.participants = [] }
      }
      if (typeof e.threads === 'string') {
        try { e.threads = JSON.parse(e.threads) } catch (_) { e.threads = [] }
      }
      return e
    })
    return pickRecent(events, cap)
  }

  /**
   * Remove consolidated=true events older than `days` days (sliding window roll-off).
   * Unconsolidated events are kept regardless of age.
   * @param {string} presetId
   * @param {number} days
   */
  async function rollOffOlderThan(presetId, days) {
    const cutoffMs = Date.now() - days * 24 * 3600 * 1000
    const cutoffDate = new Date(cutoffMs)
    // Get consolidated events for this preset and filter by ts < cutoff
    const rows = await ctx.database.get(TABLE, { presetId, consolidated: true })
    const toRemove = rows
      .filter((r) => isOlderThan(r, cutoffMs))
      .map((r) => r.id)
    if (toRemove.length > 0) {
      await ctx.database.remove(TABLE, { id: toRemove })
    }
    return toRemove.length
  }

  return { appendEvent, recent, rollOffOlderThan }
}

// ---------------------------------------------------------------------------
// DB glue: LifeState
// ---------------------------------------------------------------------------

/**
 * Create the life-state store bound to ctx.database.
 * @param {object} ctx   Koishi context with ctx.database
 * @returns {{ getState, setState }}
 */
function createLifeState(ctx) {
  const TABLE = 'life_sim_state'

  /**
   * Parse JSON fields on a raw DB row back to arrays.
   */
  function parseRow(row) {
    const obj = Object.assign({}, row)
    if (typeof obj.open_threads === 'string') {
      try { obj.open_threads = JSON.parse(obj.open_threads) } catch (_) { obj.open_threads = [] }
    } else if (!Array.isArray(obj.open_threads)) {
      obj.open_threads = []
    }
    if (typeof obj.recent_event_ids === 'string') {
      try { obj.recent_event_ids = JSON.parse(obj.recent_event_ids) } catch (_) { obj.recent_event_ids = [] }
    } else if (!Array.isArray(obj.recent_event_ids)) {
      obj.recent_event_ids = []
    }
    return obj
  }

  /**
   * Get the life-state for presetId.  Returns defaultLifeState if none exists.
   * @param {string} presetId
   * @returns {Promise<object>}
   */
  async function getState(presetId) {
    const rows = await ctx.database.get(TABLE, { presetId })
    if (!rows || rows.length === 0) {
      return defaultLifeState(presetId)
    }
    return parseRow(rows[0])
  }

  /**
   * Merge patch into the current state and write back.
   * Sets updatedAt = new Date() (glue sets the timestamp, not mergeLifeState).
   * @param {string} presetId
   * @param {object} patch  Partial life-state fields (next_state from roll)
   */
  async function setState(presetId, patch) {
    const prev = await getState(presetId)
    const updatedAt = new Date()
    const merged = mergeLifeState(prev, Object.assign({}, patch, { updatedAt }))

    const row = {
      presetId,
      location: merged.location != null ? merged.location : null,
      current_activity: merged.current_activity != null ? merged.current_activity : null,
      mood: merged.mood != null ? merged.mood : null,
      open_threads: JSON.stringify(Array.isArray(merged.open_threads) ? merged.open_threads : []),
      recent_event_ids: JSON.stringify(Array.isArray(merged.recent_event_ids) ? merged.recent_event_ids : []),
      updatedAt,
    }

    // Upsert by presetId (primary key, no autoInc)
    const existing = await ctx.database.get(TABLE, { presetId })
    if (existing && existing.length > 0) {
      await ctx.database.set(TABLE, { presetId }, {
        location: row.location,
        current_activity: row.current_activity,
        mood: row.mood,
        open_threads: row.open_threads,
        recent_event_ids: row.recent_event_ids,
        updatedAt: row.updatedAt,
      })
    } else {
      await ctx.database.create(TABLE, row)
    }

    return merged
  }

  return { getState, setState }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // Pure helpers (exported for testing + composing)
  pickRecent,
  isOlderThan,
  defaultLifeState,
  mergeLifeState,
  // DB glue factories
  createShortTermMemory,
  createLifeState,
  // Internal util (exported for potential reuse)
  toDateStr,
}
