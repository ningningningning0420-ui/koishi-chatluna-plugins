'use strict'

// koishi-plugin-chatluna-life-sim — plugin entry point.
// This file: register Config schema, extend all DB tables, set up ready/dispose hooks.
// Scheduler (Task 2) is wired here. Roller / memory / proactive bridge etc. are later tasks.

const { Config } = require('./config')
const { registerTables } = require('./db')
const { createScheduler } = require('./scheduler')

exports.name = 'chatluna-life-sim'

exports.inject = { required: ['chatluna', 'database'], optional: ['chatluna_character'] }

exports.Config = Config

exports.apply = (ctx, config) => {
  const logger = ctx.logger('chatluna-life-sim')

  // Register all DB tables. This is idempotent — safe to call on every plugin load.
  registerTables(ctx)

  // Instantiate scheduler. Later tasks call scheduler.registerHandler(type, fn)
  // to plug in roll / consolidate / etc. handlers before onReady fires.
  const scheduler = createScheduler(ctx, config, logger)

  // Expose scheduler on ctx so later tasks in the same plugin can reach it.
  // (Not a full koishi service — just a plugin-internal reference via closure.)
  exports._scheduler = scheduler

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
    // Clear in-memory timers (leave DB rows intact per §5.9).
    scheduler.dispose()
    logger.info('chatluna-life-sim disposed.')
  })
}
