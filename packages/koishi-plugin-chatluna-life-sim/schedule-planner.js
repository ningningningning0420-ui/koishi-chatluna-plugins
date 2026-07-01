'use strict'

// schedule-planner.js — Task 8: DailyPlanner + wake×日程协同
//
// §5.3c: 每日计划 DailyPlan + §5.12 wake-up 自循环 × 日程表协同
//
// Pure functions (offline-testable, no runtime deps):
//   blockStartMs(blockLabel, dayStartMs)
//   blockEndMs(blockLabel, dayStartMs, allSortedLabels)
//   assignBlockTimes(routineBlocks, dayStartMs)
//   mergeAssignments(timedBlocks, dueAssignments, dayStartMs)
//   currentBlock(planBlocks, nowMs)
//   nextWake(nextDelayMs, curBlockEndMs, nextTimedStartMs)
//
// Glue (needs koishi ctx + deps):
//   createPlanner(ctx, config, deps) → { planDay, getPlan, replan, currentBlockNow, scheduleBlockWakes }
//
// Convention for nextWake: ALL three candidates are ABSOLUTE millisecond timestamps
// (not durations). Callers pass (now + next_delay) for the "texture" candidate.
// nextWake returns the earliest non-null candidate, or null if all are null/undefined.
//
// Design refs: §5.3 日程 / §5.12 wake-up × 日程表协同

// ---------------------------------------------------------------------------
// Block label → start-hour mapping
// MUST match world-context.js timeOfDayOf hour ranges exactly:
//   清晨 [5,7)  → start at 5:00
//   上午 [7,12) → start at 7:00
//   午后 [12,17)→ start at 12:00
//   黄昏 [17,19)→ start at 17:00
//   夜   [19,23)→ start at 19:00
//   深夜 [23,0) → start at 23:00
// ---------------------------------------------------------------------------

const BLOCK_START_HOURS = {
  '清晨': 5,
  '上午': 7,
  '午后': 12,
  '黄昏': 17,
  '夜':   19,
  '深夜': 23,
}

// Canonical block ordering (by start hour ascending)
const BLOCK_ORDER = ['清晨', '上午', '午后', '黄昏', '夜', '深夜']

// ---------------------------------------------------------------------------
// blockStartMs — pure function, offline-testable
// ---------------------------------------------------------------------------

/**
 * Compute the absolute unix-ms for a block label's start time on a given day.
 *
 * The day is identified by dayStartMs = unix-ms of 00:00:00 local time for that day.
 * Each block's start = dayStartMs + startHour * 3600000.
 *
 * For unknown labels, falls back to 0 offset (midnight of that day).
 *
 * @param {string} blockLabel   One of: 清晨|上午|午后|黄昏|夜|深夜
 * @param {number} dayStartMs   Unix-ms of 00:00:00 for the target day (in local tz)
 * @returns {number}            Absolute unix-ms
 */
function blockStartMs(blockLabel, dayStartMs) {
  const hour = BLOCK_START_HOURS.hasOwnProperty(blockLabel)
    ? BLOCK_START_HOURS[blockLabel]
    : 0
  return dayStartMs + hour * 3600000
}

// ---------------------------------------------------------------------------
// assignBlockTimes — pure function, offline-testable
// ---------------------------------------------------------------------------

/**
 * Take an array of routine block objects {block, activity, location} and assign
 * real-time start/end milliseconds.
 *
 * Logic:
 * 1. For each block, start = blockStartMs(block.block, dayStartMs).
 * 2. Sort by start ascending.
 * 3. end of block[i] = start of block[i+1].
 * 4. end of last block = dayStartMs + 24h (next day midnight).
 * 5. If the same block label appears multiple times, they all get the same start —
 *    this is intentional (caller should deduplicate if needed).
 *
 * @param {Array<{block:string, activity:string, location:string}>} routineBlocks
 * @param {number} dayStartMs  Unix-ms of 00:00:00 for that day
 * @returns {Array<{block, activity, location, start:number, end:number}>}  Sorted by start
 */
function assignBlockTimes(routineBlocks, dayStartMs) {
  if (!routineBlocks || routineBlocks.length === 0) return []

  // Assign start times
  const withStart = routineBlocks.map((b) => ({
    ...b,
    start: blockStartMs(b.block, dayStartMs),
  }))

  // Sort by start ascending (stable sort in Node.js ≥ 11)
  withStart.sort((a, b) => a.start - b.start)

  // Assign end times: end[i] = start[i+1]; last → dayStartMs + 24h
  const nextDayMs = dayStartMs + 24 * 3600000
  return withStart.map((b, i) => ({
    ...b,
    end: i < withStart.length - 1 ? withStart[i + 1].start : nextDayMs,
  }))
}

// ---------------------------------------------------------------------------
// mergeAssignments — pure function, offline-testable
// ---------------------------------------------------------------------------

/**
 * Merge timed routine blocks with due assignments into a single sorted plan block array.
 *
 * - Routine blocks: source='routine', status='pending'
 * - Assignments: source='assigned', status='pending'
 *   - start derived from dueBlock → blockStartMs; end = start of next block in order
 *   - assignedBy preserved
 *
 * All blocks get status:'pending'.
 * Result is sorted by start ascending.
 *
 * @param {Array} timedBlocks     Output of assignBlockTimes (already have start/end)
 * @param {Array} dueAssignments  Assignment rows from life_sim_assignment
 * @param {number} dayStartMs     Unix-ms of 00:00:00 for that day
 * @returns {Array}               Combined blocks sorted by start
 */
function mergeAssignments(timedBlocks, dueAssignments, dayStartMs) {
  const nextDayMs = dayStartMs + 24 * 3600000

  // Tag routine blocks as source:'routine' and ensure status:'pending'
  const routineBlocks = (timedBlocks || []).map((b) => ({
    ...b,
    source: 'routine',
    status: 'pending',
  }))

  // Convert assignments to plan blocks
  const assignedBlocks = (dueAssignments || []).map((a) => {
    const start = a.dueBlock
      ? blockStartMs(a.dueBlock, dayStartMs)
      : dayStartMs  // no dueBlock → put at midnight (beginning of day)

    // end = next known block start after start, or next day
    const nextBlockStart = _nextKnownBlockStart(start, dayStartMs)
    const end = nextBlockStart !== null ? nextBlockStart : nextDayMs

    return {
      block:      a.dueBlock || '(被安排)',
      activity:   a.desc || '(被安排活动)',
      location:   null,
      source:     'assigned',
      assignedBy: a.assignedBy || null,
      threadId:   a.threadId   || null,
      assignmentId: a.id,
      start,
      end,
      status:     'pending',
    }
  })

  const combined = [...routineBlocks, ...assignedBlocks]
  combined.sort((a, b) => a.start - b.start)
  return combined
}

/**
 * Given a block start ms, find the next known canonical block start on the same day.
 * E.g., if start = 上午 (07:00), next = 午后 (12:00).
 * Returns null if start is at or past 深夜 (23:00).
 *
 * @param {number} startMs
 * @param {number} dayStartMs
 * @returns {number|null}
 */
function _nextKnownBlockStart(startMs, dayStartMs) {
  const allStarts = BLOCK_ORDER
    .map((label) => dayStartMs + BLOCK_START_HOURS[label] * 3600000)
    .filter((ms) => ms > startMs)
  return allStarts.length > 0 ? allStarts[0] : null
}

// ---------------------------------------------------------------------------
// currentBlock — pure function, offline-testable
// ---------------------------------------------------------------------------

/**
 * Find the plan block that contains nowMs within its [start, end) interval.
 *
 * @param {Array<{start:number, end:number}>} planBlocks  Sorted plan blocks
 * @param {number} nowMs  Current unix-ms
 * @returns {object|null}  The matching block, or null if none covers nowMs
 */
function currentBlock(planBlocks, nowMs) {
  if (!planBlocks || planBlocks.length === 0) return null
  for (const block of planBlocks) {
    if (nowMs >= block.start && nowMs < block.end) {
      return block
    }
  }
  return null
}

// ---------------------------------------------------------------------------
// nextWake — pure function, offline-testable
// THE HEART of §5.12: min(texture, block-end, timed-assignment)
// ---------------------------------------------------------------------------

/**
 * Compute the next wake time as the earliest non-null/undefined candidate.
 *
 * ALL arguments are ABSOLUTE unix-ms timestamps (not durations).
 * - nextDelayMs   : now + next_delay (the "texture" rhythm; caller adds now before calling)
 * - curBlockEndMs : end of the current plan block (hard boundary)
 * - nextTimedStartMs: start of the next timed assignment (hard wake point)
 *
 * Returns null if ALL candidates are null/undefined (caller falls back to defaultNextDelay).
 *
 * §5.12 constraint: next_delay must not cross the block boundary → if nextDelayMs > curBlockEndMs,
 * curBlockEndMs wins (which is naturally handled by taking the minimum).
 *
 * @param {number|null|undefined} nextDelayMs
 * @param {number|null|undefined} curBlockEndMs
 * @param {number|null|undefined} nextTimedStartMs
 * @returns {number|null}
 */
function nextWake(nextDelayMs, curBlockEndMs, nextTimedStartMs) {
  const candidates = [nextDelayMs, curBlockEndMs, nextTimedStartMs]
    .filter((v) => v != null && typeof v === 'number' && isFinite(v))

  if (candidates.length === 0) return null
  return Math.min(...candidates)
}

// ---------------------------------------------------------------------------
// dayStartMsFor — helper (not exported separately; used in glue + exported for tests)
// ---------------------------------------------------------------------------

/**
 * Compute the unix-ms of 00:00:00 local time (per IANA timezone) for a given date string.
 *
 * @param {string} day      YYYY-MM-DD
 * @param {string} timezone IANA timezone string, e.g. 'Asia/Shanghai'
 * @returns {number}        Unix-ms of midnight at start of that day
 */
function dayStartMsFor(day, timezone) {
  // Parse the day string in the local timezone by constructing a Date at midnight UTC
  // then adjusting for the timezone offset.
  // Simplest reliable approach: use Intl to find the offset at midnight of that day.
  // We construct an approximate UTC date for midnight local time.
  const [year, month, dayNum] = day.split('-').map(Number)

  // Start with a rough UTC midnight
  const roughUTC = Date.UTC(year, month - 1, dayNum, 0, 0, 0, 0)

  // Find the local offset at that approximate time using Intl
  const offset = _getTzOffsetMs(roughUTC, timezone)

  // midnight_local = UTC - offset (midnight local in UTC terms)
  return roughUTC - offset
}

/**
 * Get the UTC offset (in ms) for a given timezone at a given unix-ms.
 * offset = localTime - UTC  (positive for east of UTC)
 *
 * @param {number} utcMs
 * @param {string} timezone
 * @returns {number}  offset in ms
 */
function _getTzOffsetMs(utcMs, timezone) {
  const date = new Date(utcMs)
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone || 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
    hour: '2-digit', minute: '2-digit', second: '2-digit',
    hour12: false,
  })
  const parts = fmt.formatToParts(date)
  const p = {}
  for (const part of parts) {
    if (part.type !== 'literal') p[part.type] = parseInt(part.value, 10)
  }
  // Handle '24' hour (some Intl implementations)
  if (p.hour === 24) p.hour = 0
  const localMs = Date.UTC(p.year, p.month - 1, p.day, p.hour, p.minute, p.second)
  return localMs - utcMs
}

// ---------------------------------------------------------------------------
// Glue: createPlanner
// ---------------------------------------------------------------------------

const PLAN_TABLE = 'life_sim_plan'

/**
 * Create a DailyPlanner bound to a koishi ctx, config, and injected deps.
 *
 * @param {object} ctx     Koishi context with ctx.database
 * @param {object} config  Plugin config (planRegenAt, timezone, etc.)
 * @param {object} deps    {
 *   blocksForToday(presetId, nowMs) → Promise<Array>,   // from schedule-routine
 *   assignmentQueue: { dueFor(presetId, day) → Promise<Array> },
 *   scheduler: { scheduleTask(presetId, fireAt, type) → Promise<number> },
 * }
 * @returns {{ planDay, getPlan, replan, currentBlockNow, scheduleBlockWakes }}
 */
function createPlanner(ctx, config, deps) {
  const timezone = (config && config.timezone) || 'Asia/Shanghai'
  const _blocksForToday = deps && deps.blocksForToday
  const _assignmentQueue = deps && deps.assignmentQueue
  const _scheduler = deps && deps.scheduler

  /**
   * Generate (or regenerate) the daily plan for a presetId on a given day.
   *
   * Steps:
   * 1. Get routine blocks for today (via deps.blocksForToday)
   * 2. assignBlockTimes → timed blocks
   * 3. Get due assignments for the day (via deps.assignmentQueue.dueFor)
   * 4. mergeAssignments → combined plan blocks
   * 5. Persist to life_sim_plan (upsert by presetId+day)
   *
   * @param {string} presetId
   * @param {string} day      YYYY-MM-DD
   * @param {number} nowMs    Unix-ms of "now" (for blocksForToday; caller supplies explicitly)
   * @returns {Promise<object>}  { presetId, day, blocks:Array, generatedAt:Date }
   */
  async function planDay(presetId, day, nowMs) {
    const now = nowMs || Date.now()

    // 1. Routine blocks for today
    let routineBlocks = []
    if (_blocksForToday) {
      routineBlocks = (await _blocksForToday(presetId, now)) || []
    }

    // 2. Assign real-time start/end to each routine block
    const dayStart = dayStartMsFor(day, timezone)
    const timedBlocks = assignBlockTimes(routineBlocks, dayStart)

    // 3. Due assignments
    let dueAssignments = []
    if (_assignmentQueue) {
      dueAssignments = (await _assignmentQueue.dueFor(presetId, day)) || []
    }

    // 4. Merge
    const blocks = mergeAssignments(timedBlocks, dueAssignments, dayStart)

    // 5. Persist — set timestamps explicitly (not initial)
    const generatedAt = new Date(now)
    const blocksJson = JSON.stringify(blocks)

    const existing = await ctx.database.get(PLAN_TABLE, { presetId, day })
    if (existing && existing.length > 0) {
      await ctx.database.set(PLAN_TABLE, { presetId, day }, {
        blocks: blocksJson,
        generatedAt,
      })
    } else {
      await ctx.database.create(PLAN_TABLE, {
        presetId,
        day,
        blocks: blocksJson,
        generatedAt,
      })
    }

    return { presetId, day, blocks, generatedAt }
  }

  /**
   * Get the stored plan for a presetId on a given day.
   * Returns null if not found.
   *
   * @param {string} presetId
   * @param {string} day  YYYY-MM-DD
   * @returns {Promise<object|null>}  { presetId, day, blocks:Array, generatedAt } or null
   */
  async function getPlan(presetId, day) {
    const rows = await ctx.database.get(PLAN_TABLE, { presetId, day })
    if (!rows || rows.length === 0) return null

    const row = rows[0]
    let blocks = []
    try {
      blocks = JSON.parse(row.blocks || '[]')
    } catch (_) {
      blocks = []
    }

    return { presetId, day, blocks, generatedAt: row.generatedAt }
  }

  /**
   * Replan from fromBlockIdx onward.
   * Blocks before fromBlockIdx remain as-is; blocks from fromBlockIdx onward are
   * regenerated. Prior interrupted block is marked 'interrupted', future ones 'skipped'.
   *
   * @param {string} presetId
   * @param {number} fromBlockIdx  Index of the first block to regenerate (0-based)
   * @param {number} nowMs         Unix-ms of "now"
   * @returns {Promise<object|null>}  Updated plan object, or null if no plan exists
   */
  async function replan(presetId, fromBlockIdx, nowMs) {
    const now = nowMs || Date.now()
    const day = _msToDay(now, timezone)

    const plan = await getPlan(presetId, day)
    if (!plan) return null

    const blocks = plan.blocks
    if (!Array.isArray(blocks) || blocks.length === 0) return plan

    // Mark prior blocks at and after fromBlockIdx as interrupted/skipped
    for (let i = fromBlockIdx; i < blocks.length; i++) {
      if (i === fromBlockIdx) {
        blocks[i] = { ...blocks[i], status: 'interrupted' }
      } else {
        blocks[i] = { ...blocks[i], status: 'skipped' }
      }
    }

    // Persist updated blocks
    const generatedAt = new Date(now)
    await ctx.database.set(PLAN_TABLE, { presetId, day }, {
      blocks: JSON.stringify(blocks),
      generatedAt,
    })

    return { presetId, day, blocks, generatedAt }
  }

  /**
   * Return the current block for presetId at nowMs.
   * Loads the plan for today and calls currentBlock(blocks, nowMs).
   *
   * @param {string} presetId
   * @param {number} nowMs
   * @returns {Promise<object|null>}
   */
  async function currentBlockNow(presetId, nowMs) {
    const now = nowMs || Date.now()
    const day = _msToDay(now, timezone)
    const plan = await getPlan(presetId, day)
    if (!plan) return null
    return currentBlock(plan.blocks, now)
  }

  /**
   * Schedule 'block' type wake tasks for each block start that is in the future.
   *
   * @param {string} presetId
   * @param {object} plan  Plan object with blocks array
   * @returns {Promise<void>}
   */
  async function scheduleBlockWakes(presetId, plan) {
    if (!_scheduler || !plan || !plan.blocks) return

    const now = Date.now()
    for (const block of plan.blocks) {
      if (typeof block.start === 'number' && block.start > now) {
        await _scheduler.scheduleTask(presetId, new Date(block.start), 'block', {
          blockLabel: block.block,
          activity:   block.activity,
          source:     block.source,
        })
      }
    }
  }

  return { planDay, getPlan, replan, currentBlockNow, scheduleBlockWakes }
}

// ---------------------------------------------------------------------------
// Internal helper: unix-ms → YYYY-MM-DD in given timezone
// ---------------------------------------------------------------------------

/**
 * Convert a unix-ms timestamp to YYYY-MM-DD string in the given timezone.
 * @param {number} ms
 * @param {string} timezone
 * @returns {string}
 */
function _msToDay(ms, timezone) {
  const fmt = new Intl.DateTimeFormat('en-CA', {
    timeZone: timezone || 'Asia/Shanghai',
    year: 'numeric', month: '2-digit', day: '2-digit',
  })
  // en-CA gives YYYY-MM-DD format natively
  return fmt.format(new Date(ms))
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // Pure functions (exported for testing)
  blockStartMs,
  assignBlockTimes,
  mergeAssignments,
  currentBlock,
  nextWake,
  dayStartMsFor,
  BLOCK_START_HOURS,
  BLOCK_ORDER,
  // Glue factory
  createPlanner,
}
