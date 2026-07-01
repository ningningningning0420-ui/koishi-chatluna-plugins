'use strict'

// thought.js — ThoughtBuffer（心事簿）for koishi-plugin-chatluna-life-sim
//
// Pure helpers (offline-testable, no runtime deps):
//   filterRecallable(thoughts, target)   → pending thoughts matching target
//   applyRevise(thought, op)             → new thought object after op (no mutation)
//
// DB glue (needs ctx.database, not tested offline):
//   createThoughtBuffer(ctx) → { store, recall, revise, markSurfaced, mergeThoughts }
//
// Consumes: life_sim_thought table (§5.7)
//   Fields: id, presetId, content, target('审神者'|presetId|'self'),
//           origin, urgency('low'|...), status('pending'|'surfaced'|'dropped'|'merged'),
//           relatedThreadId, createdAt, revisedAt

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Filter a list of thoughts to those that are recallable for the given target.
 * Returns only thoughts with status === 'pending' AND target === the given target.
 * Note: 'self' is pure self-reflection and is NOT returned by recall(target)
 *       unless target itself is 'self' (callers should not do that normally).
 *
 * @param {Array} thoughts   Array of thought objects
 * @param {string} target    The target to match (e.g. '审神者' or a presetId)
 * @returns {Array}          Subset that is pending and matches target
 */
function filterRecallable(thoughts, target) {
  if (!Array.isArray(thoughts) || thoughts.length === 0) return []
  return thoughts.filter((t) => t.status === 'pending' && t.target === target)
}

/**
 * Apply a revise op to a thought, returning a NEW thought object.
 * Never mutates the input thought.
 *
 * Supported ops:
 *   { type: 'update', content?, urgency?, relatedThreadId? }
 *     → merge the provided fields; status is unchanged
 *   { type: 'drop' }
 *     → status = 'dropped'
 *   { type: 'merge' }
 *     → status = 'merged'  (merge-target creation is the caller's job)
 *
 * revisedAt is NOT set here — the glue layer sets it at write time.
 * No new Date() is called inside this function.
 *
 * @param {object} thought  The original thought object
 * @param {object} op       The revise operation
 * @returns {object}        A new thought object with the op applied
 */
function applyRevise(thought, op) {
  if (!thought || typeof thought !== 'object') throw new Error('thought must be an object')
  if (!op || typeof op !== 'object') throw new Error('op must be an object')

  const result = Object.assign({}, thought)

  switch (op.type) {
    case 'update': {
      // Merge only the explicitly provided update fields
      if (op.content !== undefined)         result.content = op.content
      if (op.urgency !== undefined)         result.urgency = op.urgency
      if (op.relatedThreadId !== undefined) result.relatedThreadId = op.relatedThreadId
      // status is intentionally left unchanged
      break
    }
    case 'drop': {
      result.status = 'dropped'
      break
    }
    case 'merge': {
      result.status = 'merged'
      break
    }
    default: {
      throw new Error('Unknown op type: ' + op.type)
    }
  }

  return result
}

// ---------------------------------------------------------------------------
// DB glue
// ---------------------------------------------------------------------------

/**
 * Create the ThoughtBuffer store bound to ctx.database.
 *
 * @param {object} ctx  Koishi context with ctx.database
 * @returns {{ store, recall, revise, markSurfaced, mergeThoughts }}
 */
function createThoughtBuffer(ctx) {
  const TABLE = 'life_sim_thought'

  /**
   * Insert a new pending thought into the DB.
   * Sets status='pending' and createdAt=new Date() explicitly.
   *
   * @param {object} thought  Fields: presetId, content, target, origin?, urgency?, relatedThreadId?
   * @returns {Promise<object>}  The created row (with id assigned by DB)
   */
  async function store(thought) {
    const now = new Date()
    const row = {
      presetId:        thought.presetId        != null ? thought.presetId        : null,
      content:         thought.content         != null ? thought.content         : null,
      target:          thought.target          != null ? thought.target          : null,
      origin:          thought.origin          != null ? thought.origin          : null,
      urgency:         thought.urgency         != null ? thought.urgency         : 'low',
      status:          'pending',
      relatedThreadId: thought.relatedThreadId != null ? thought.relatedThreadId : null,
      createdAt:       now,
      revisedAt:       null,
    }
    const created = await ctx.database.create(TABLE, row)
    return created || row
  }

  /**
   * Return all pending thoughts for presetId targeting the given target.
   *
   * @param {string} presetId
   * @param {string} target   e.g. '审神者' or another presetId
   * @returns {Promise<Array>}
   */
  async function recall(presetId, target) {
    const rows = await ctx.database.get(TABLE, { presetId })
    return filterRecallable(rows, target)
  }

  /**
   * Apply a revise op to the thought with the given id, writing back to DB.
   * Sets revisedAt=new Date() in glue (not inside applyRevise).
   *
   * @param {number|string} id
   * @param {object} op  { type: 'update'|'drop'|'merge', ...fields }
   * @returns {Promise<object>}  The revised thought object
   */
  async function revise(id, op) {
    const rows = await ctx.database.get(TABLE, { id })
    if (!rows || rows.length === 0) throw new Error('thought not found: ' + id)
    const original = rows[0]
    const revised = applyRevise(original, op)
    const revisedAt = new Date()
    revised.revisedAt = revisedAt

    // Build the update patch: only changed scalar fields
    const patch = {}
    if (revised.content         !== original.content)         patch.content = revised.content
    if (revised.urgency         !== original.urgency)         patch.urgency = revised.urgency
    if (revised.relatedThreadId !== original.relatedThreadId) patch.relatedThreadId = revised.relatedThreadId
    if (revised.status          !== original.status)          patch.status = revised.status
    patch.revisedAt = revisedAt

    await ctx.database.set(TABLE, { id }, patch)
    return revised
  }

  /**
   * Mark a thought as surfaced (it was shared with the target).
   * The caller is responsible for sinking it into long-term memory if needed.
   *
   * @param {number|string} id
   * @returns {Promise<void>}
   */
  async function markSurfaced(id) {
    const revisedAt = new Date()
    await ctx.database.set(TABLE, { id }, { status: 'surfaced', revisedAt })
  }

  /**
   * Merge multiple thoughts into one new pending thought.
   * - Marks all given thoughts as status='merged'
   * - Creates a new pending thought with mergedContent (target comes from the first thought)
   *
   * @param {Array<number|string>} ids          IDs of thoughts to merge
   * @param {string}               mergedContent  Content for the new merged thought
   * @returns {Promise<object>}  The newly created merged thought row
   */
  async function mergeThoughts(ids, mergedContent) {
    if (!Array.isArray(ids) || ids.length === 0) throw new Error('ids must be a non-empty array')

    // Fetch all source thoughts
    const allRows = []
    for (const id of ids) {
      const rows = await ctx.database.get(TABLE, { id })
      if (rows && rows.length > 0) allRows.push(rows[0])
    }

    // Mark each as merged using applyRevise + explicit revisedAt in glue
    const revisedAt = new Date()
    for (const original of allRows) {
      const revised = applyRevise(original, { type: 'merge' })
      await ctx.database.set(TABLE, { id: original.id }, { status: revised.status, revisedAt })
    }

    // Derive target from first thought (best-effort; caller may override via a fresh store call)
    const firstThought = allRows[0]
    const newThought = await store({
      presetId: firstThought ? firstThought.presetId : null,
      content:  mergedContent,
      target:   firstThought ? firstThought.target   : null,
      origin:   'merge',
      urgency:  firstThought ? firstThought.urgency  : 'low',
    })

    return newThought
  }

  return { store, recall, revise, markSurfaced, mergeThoughts }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // Pure helpers (exported for testing + composing)
  filterRecallable,
  applyRevise,
  // DB glue factory
  createThoughtBuffer,
}
