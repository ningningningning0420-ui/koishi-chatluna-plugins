'use strict'

// schedule-assignment.js — Task 8: AssignmentQueue
//
// §5.3b: 被安排队列 AssignmentQueue
// Table: life_sim_assignment
//   {id, presetId, desc, dueDay?, dueBlock?, source, assignedBy, status, threadId?}
//
// P1 scope: enqueue / dueFor / markDone
// (对话录入留 P2)
//
// Exports (glue, needs koishi ctx):
//   createAssignmentQueue(ctx) → { enqueue(a), dueFor(presetId, day), markDone(id) }

const TABLE = 'life_sim_assignment'

/**
 * Create an AssignmentQueue accessor bound to a koishi ctx.
 *
 * @param {object} ctx  Koishi context with ctx.database
 * @returns {{ enqueue, dueFor, markDone }}
 */
function createAssignmentQueue(ctx) {
  /**
   * Enqueue a new assignment.
   *
   * @param {object} a  Assignment object:
   *   { presetId, desc, dueDay?, dueBlock?, source, assignedBy, status?, threadId? }
   * @returns {Promise<object>}  Inserted row with id
   */
  async function enqueue(a) {
    const row = {
      presetId:   a.presetId,
      desc:       a.desc || null,
      dueDay:     a.dueDay  || null,
      dueBlock:   a.dueBlock || null,
      source:     a.source || '主控',
      assignedBy: a.assignedBy || null,
      status:     a.status || 'pending',
      threadId:   a.threadId || null,
    }
    const inserted = await ctx.database.create(TABLE, row)
    return inserted
  }

  /**
   * Return all pending assignments for a given presetId that are due on or before `day`.
   * "Due" means dueDay is null (no deadline) or dueDay <= day (ISO YYYY-MM-DD string compare).
   *
   * @param {string} presetId
   * @param {string} day  YYYY-MM-DD
   * @returns {Promise<Array>}
   */
  async function dueFor(presetId, day) {
    const rows = await ctx.database.get(TABLE, { presetId, status: 'pending' })
    if (!rows || rows.length === 0) return []

    return rows.filter((r) => {
      // No deadline → always due
      if (!r.dueDay) return true
      // ISO string compare: 'YYYY-MM-DD' sorts lexicographically = chronologically
      return r.dueDay <= day
    })
  }

  /**
   * Mark an assignment as done by id.
   *
   * @param {number} id  Assignment id
   * @returns {Promise<void>}
   */
  async function markDone(id) {
    await ctx.database.set(TABLE, { id }, { status: 'done' })
  }

  return { enqueue, dueFor, markDone }
}

module.exports = { createAssignmentQueue }
