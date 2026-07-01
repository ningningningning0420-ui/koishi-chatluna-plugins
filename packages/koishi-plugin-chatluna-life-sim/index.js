'use strict'

// koishi-plugin-chatluna-life-sim — plugin entry point (Task 1 skeleton).
// This file: register Config schema, extend all DB tables, set up ready/dispose hooks.
// Scheduler / roller / memory / proactive bridge etc. are implemented in later tasks.

const { Config } = require('./config')
const { registerTables } = require('./db')

exports.name = 'chatluna-life-sim'

exports.inject = { required: ['chatluna', 'database'], optional: ['chatluna_character'] }

exports.Config = Config

exports.apply = (ctx, config) => {
  const logger = ctx.logger('chatluna-life-sim')

  // Register all DB tables. This is idempotent — safe to call on every plugin load.
  registerTables(ctx)

  ctx.on('ready', () => {
    // P1 will: scan life_sim_task for pending/due tasks, set up timers, start IdleWatcher.
    // For now: just log that the plugin is alive.
    logger.info(
      'chatluna-life-sim ready. presets=%s dryRun=%s debug=%s',
      (config.presets || []).join(', '),
      config.dryRun,
      config.debug
    )
    if (config.dryRun) {
      logger.info('[dry-run] 模拟模式已开启：不写库、不真发。')
    }
  })

  ctx.on('dispose', () => {
    // P1 will: clear in-memory timers, flush pending state.
    // For now: nothing to clean up.
    logger.info('chatluna-life-sim disposed.')
  })
}
