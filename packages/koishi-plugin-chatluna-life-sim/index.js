'use strict'

// koishi-plugin-chatluna-life-sim — plugin entry point.
// This file: register Config schema, extend all DB tables, set up ready/dispose hooks.
// Scheduler (Task 2) and PresenceState (Task 3) are wired here.
// Roller / memory / proactive bridge etc. are later tasks.

const { Config } = require('./config')
const { registerTables } = require('./db')
const { createConcurrencyGuard, createScheduler } = require('./scheduler')
const { createPresence } = require('./presence')

exports.name = 'chatluna-life-sim'

exports.inject = { required: ['chatluna', 'database'], optional: ['chatluna_character'] }

exports.Config = Config

exports.apply = (ctx, config) => {
  const logger = ctx.logger('chatluna-life-sim')

  // Register all DB tables. This is idempotent — safe to call on every plugin load.
  registerTables(ctx)

  // Task 3 refactor: create ONE shared ConcurrencyGuard passed to both scheduler and presence.
  // This ensures a single lock map across all units (§5.11).
  const guard = createConcurrencyGuard()

  // Instantiate scheduler with the shared guard.
  // Later tasks call scheduler.registerHandler(type, fn) to plug in handlers.
  const scheduler = createScheduler(ctx, config, logger, guard)

  // Instantiate PresenceState with the same shared guard.
  // Subscribes to chatluna_character/message_collect internally.
  const presence = createPresence(ctx, config, guard, logger)

  // Expose scheduler and presence on exports so later tasks in the same plugin can reach them.
  // (Not a full koishi service — just a plugin-internal reference via closure.)
  exports._scheduler = scheduler
  exports._presence = presence
  exports._guard = guard

  ctx.on('ready', async () => {
    logger.info(
      'chatluna-life-sim ready. presets=%s dryRun=%s debug=%s',
      (config.presets || []).join(', '),
      config.dryRun,
      config.debug
    )
    if (config.dryRun) {
      logger.info('[dry-run] 模拟模式已开启：不写库、不真发。')
    }

    // Scan pending tasks, drop overdue ones, fire slightly-late ones once,
    // arm timers for future ones. §5.9 持久化调度.
    await scheduler.onReady()
  })

  ctx.on('dispose', () => {
    // Clear presence timers and event subscriptions.
    presence.dispose()
    // Clear in-memory scheduler timers (leave DB rows intact per §5.9).
    scheduler.dispose()
    logger.info('chatluna-life-sim disposed.')
  })
}
