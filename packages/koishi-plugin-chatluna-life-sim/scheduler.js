'use strict'

// scheduler.js — Task 2: 持久化调度 Scheduler + 单活动锁 ConcurrencyGuard
//
// Exports (pure logic, offline-testable):
//   createConcurrencyGuard()  → { acquire, release, isBusy, current }
//   partitionPending(tasks, now, graceMs) → { runIds, dropIds, futureTasks }
//
// Exports (DB/timer glue, needs koishi ctx):
//   createScheduler(ctx, config, logger)  → { scheduleTask, onReady, dispose, registerHandler }
//
// Design refs: §5.9 持久化调度 / §5.11 单活动锁 / §5.12 wake-up 自循环

// ---------------------------------------------------------------------------
// ConcurrencyGuard — pure in-memory, no DB
// ---------------------------------------------------------------------------

/**
 * Factory for a per-process concurrency guard.
 * One instance is shared across all presets in a single plugin load.
 *
 * acquire(presetId, kind) → true if free (and records kind); false if busy.
 * release(presetId) → clears the lock (noop if not held).
 * isBusy(presetId) → boolean.
 * current(presetId) → kind string | null.
 *
 * "kind" values: 'roll' | 'peerchat' | 'withuser'  (§5.11 point 2)
 */
function createConcurrencyGuard() {
  // Map<presetId, kind>
  const _active = new Map()

  return {
    acquire(presetId, kind) {
      if (_active.has(presetId)) return false
      _active.set(presetId, kind)
      return true
    },
    release(presetId) {
      _active.delete(presetId)
    },
    isBusy(presetId) {
      return _active.has(presetId)
    },
    current(presetId) {
      return _active.has(presetId) ? _active.get(presetId) : null
    },
  }
}

// ---------------------------------------------------------------------------
// partitionPending — pure function, offline-testable
// ---------------------------------------------------------------------------

/**
 * Given a list of pending tasks (each with {id, fireAt: Date, ...}), a current
 * timestamp (milliseconds since epoch), and a grace window (milliseconds),
 * decide what to do with each:
 *
 *   fireAt <= now - graceMs  → dropIds  (too old; §5.9: not backfilled)
 *   fireAt <= now            → runIds   (slightly overdue; fire once)
 *   fireAt >  now            → futureTasks (arm a timer)
 *
 * @param {Array<{id:number, fireAt:Date}>} tasks
 * @param {number} now   – Date.now()
 * @param {number} graceMs
 * @returns {{ runIds: number[], dropIds: number[], futureTasks: Array }}
 */
function partitionPending(tasks, now, graceMs) {
  const runIds = []
  const dropIds = []
  const futureTasks = []

  for (const task of tasks) {
    const fireMs = task.fireAt instanceof Date
      ? task.fireAt.getTime()
      : new Date(task.fireAt).getTime()

    if (fireMs <= now - graceMs) {
      // Too old — discard, do not backfill (§5.9, §5.11: missed = gone)
      dropIds.push(task.id)
    } else if (fireMs <= now) {
      // Slightly overdue but within grace — fire once
      runIds.push(task.id)
    } else {
      // Still in the future — arm a timer
      futureTasks.push(task)
    }
  }

  return { runIds, dropIds, futureTasks }
}

// ---------------------------------------------------------------------------
// createScheduler — DB/timer glue (needs koishi ctx)
// ---------------------------------------------------------------------------

const TABLE = 'life_sim_task'
const DEFAULT_GRACE_MS = 5 * 60 * 1000  // 5 minutes

/**
 * Create a Scheduler instance bound to a koishi ctx.
 *
 * @param {object} ctx     – koishi context
 * @param {object} config  – plugin config (not used in task 2 directly, reserved)
 * @param {object} logger  – ctx.logger('chatluna-life-sim')
 * @returns {{ scheduleTask, onReady, dispose, registerHandler }}
 */
function createScheduler(ctx, config, logger) {
  // Map<taskId, disposerFn>  — ctx.setTimeout disposers
  const _timers = new Map()

  // Map<type, handlerFn>  — registered handlers by task type
  const _handlers = new Map()

  // ---------------------------------------------------------------------------
  // registerHandler(type, fn)
  // ---------------------------------------------------------------------------
  function registerHandler(type, fn) {
    _handlers.set(type, fn)
  }

  // ---------------------------------------------------------------------------
  // _armTimer — internal: arm a single ctx.setTimeout for a task
  // ---------------------------------------------------------------------------
  function _armTimer(task) {
    const fireMs = task.fireAt instanceof Date
      ? task.fireAt.getTime()
      : new Date(task.fireAt).getTime()
    const delayMs = Math.max(0, fireMs - Date.now())

    const disposer = ctx.setTimeout(async () => {
      _timers.delete(task.id)
      await _fireTask(task.id)
    }, delayMs)

    _timers.set(task.id, disposer)
  }

  // ---------------------------------------------------------------------------
  // _fireTask — mark running → dispatch handler → mark done/failed
  // ---------------------------------------------------------------------------
  async function _fireTask(taskId) {
    let rows
    try {
      rows = await ctx.database.get(TABLE, { id: taskId })
    } catch (e) {
      logger.warn('[scheduler] 读取任务失败 id=%d: %s', taskId, e && e.message)
      return
    }
    if (!rows || rows.length === 0) {
      logger.warn('[scheduler] 任务已不存在 id=%d，跳过', taskId)
      return
    }
    const task = rows[0]
    if (task.status !== 'pending') {
      logger.warn('[scheduler] 任务状态不是 pending id=%d status=%s，跳过', taskId, task.status)
      return
    }

    // Mark running
    try {
      await ctx.database.set(TABLE, { id: taskId }, { status: 'running' })
    } catch (e) {
      logger.warn('[scheduler] 标记 running 失败 id=%d: %s', taskId, e && e.message)
      return
    }

    // Dispatch to handler
    const handler = _handlers.get(task.type)
    let succeeded = false
    if (handler) {
      try {
        let payload = null
        if (task.payload) {
          try { payload = JSON.parse(task.payload) } catch (_) { payload = null }
        }
        await handler(task.presetId, task.type, payload, task)
        succeeded = true
      } catch (e) {
        logger.warn('[scheduler] handler 失败 type=%s id=%d: %s', task.type, taskId, e && e.message)
      }
    } else {
      // No handler registered yet — log at debug level and mark done
      if (config && config.debug) {
        logger.info('[scheduler] 无 handler type=%s id=%d，跳过（任务照常标 done）', task.type, taskId)
      }
      succeeded = true
    }

    // Mark done or failed
    const finalStatus = succeeded ? 'done' : 'failed'
    try {
      await ctx.database.set(TABLE, { id: taskId }, { status: finalStatus })
    } catch (e) {
      logger.warn('[scheduler] 标记 %s 失败 id=%d: %s', finalStatus, taskId, e && e.message)
    }
  }

  // ---------------------------------------------------------------------------
  // _runNow — fire a task from onReady (run-ids path)
  // ---------------------------------------------------------------------------
  async function _runNow(taskId) {
    await _fireTask(taskId)
  }

  // ---------------------------------------------------------------------------
  // _dropTasks — mark a batch of task ids as done (not backfilled, §5.9)
  // ---------------------------------------------------------------------------
  async function _dropTasks(ids) {
    if (!ids || ids.length === 0) return
    try {
      // Mark each as cancelled/done so they don't re-fire on next restart
      await ctx.database.set(TABLE, { id: { $in: ids } }, { status: 'done' })
    } catch (e) {
      logger.warn('[scheduler] 批量丢弃任务失败: %s', e && e.message)
    }
  }

  // ---------------------------------------------------------------------------
  // scheduleTask(presetId, fireAt, type, payload?)
  // ---------------------------------------------------------------------------
  /**
   * Insert a pending task row and arm a timer if the fire time is near.
   *
   * @param {string} presetId
   * @param {Date}   fireAt
   * @param {string} type       – roll|block|consolidate|prune|plan|reflect
   * @param {object} [payload]  – arbitrary JSON-serialisable context
   * @returns {Promise<number>}  task id
   */
  async function scheduleTask(presetId, fireAt, type, payload) {
    const row = {
      presetId,
      fireAt: fireAt instanceof Date ? fireAt : new Date(fireAt),
      type,
      status: 'pending',
      payload: payload != null ? JSON.stringify(payload) : null,
    }

    let insertedRows
    try {
      insertedRows = await ctx.database.create(TABLE, row)
    } catch (e) {
      logger.warn('[scheduler] 插入任务失败 presetId=%s type=%s: %s', presetId, type, e && e.message)
      throw e
    }

    const taskId = insertedRows.id
    const fireMs = row.fireAt.getTime()

    // Arm timer if fire time is in the future (or within grace — _armTimer handles it)
    if (fireMs > Date.now() - DEFAULT_GRACE_MS) {
      _armTimer({ ...row, id: taskId })
    }

    if (config && config.debug) {
      logger.info('[scheduler] 已排任务 id=%d presetId=%s type=%s fireAt=%s',
        taskId, presetId, type, row.fireAt.toISOString())
    }

    return taskId
  }

  // ---------------------------------------------------------------------------
  // onReady() — scan pending, partition, drop/run/arm
  // ---------------------------------------------------------------------------
  async function onReady() {
    let pending
    try {
      pending = await ctx.database.get(TABLE, { status: 'pending' })
    } catch (e) {
      logger.warn('[scheduler] onReady: 读取 pending 任务失败: %s', e && e.message)
      return
    }

    if (!pending || pending.length === 0) {
      logger.info('[scheduler] onReady: 无 pending 任务')
      return
    }

    const now = Date.now()
    const graceMs = DEFAULT_GRACE_MS
    const { runIds, dropIds, futureTasks } = partitionPending(pending, now, graceMs)

    logger.info('[scheduler] onReady: pending=%d drop=%d run=%d future=%d',
      pending.length, dropIds.length, runIds.length, futureTasks.length)

    // Drop overdue tasks (§5.9: not backfilled)
    if (dropIds.length > 0) {
      await _dropTasks(dropIds)
    }

    // Fire slightly-overdue tasks once (within grace)
    for (const id of runIds) {
      // fire-and-forget but await to avoid thundering-herd on start
      _runNow(id).catch((e) =>
        logger.warn('[scheduler] runNow 失败 id=%d: %s', id, e && e.message)
      )
    }

    // Arm timers for future tasks
    for (const task of futureTasks) {
      _armTimer(task)
    }
  }

  // ---------------------------------------------------------------------------
  // dispose() — clear in-memory timers; leave DB rows (§5.9)
  // ---------------------------------------------------------------------------
  function dispose() {
    for (const [id, disposer] of _timers) {
      try {
        disposer()
      } catch (e) {
        logger.warn('[scheduler] dispose: 清除 timer 失败 id=%d: %s', id, e && e.message)
      }
    }
    _timers.clear()
    logger.info('[scheduler] disposed: %d timers cleared', _timers.size)
  }

  return { scheduleTask, onReady, dispose, registerHandler }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  createConcurrencyGuard,
  partitionPending,
  createScheduler,
}
