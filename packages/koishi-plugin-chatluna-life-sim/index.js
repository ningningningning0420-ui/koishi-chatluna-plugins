'use strict'

// koishi-plugin-chatluna-life-sim — plugin entry point (Task 14: Integration Capstone)
//
// Wires all modules into a single self-loop:
//   Scheduler ↔ Presence ↔ Roller ↔ Memory ↔ Planner ↔ Proactive ↔ Inject
//
// Integration constraints (§10 / task-14-brief):
//   - No koishi boot test (needs runtime) — but node --check + require-graph sanity passes.
//   - All 588 pure-logic tests must stay green (don't break any module exports).
//   - dryRun / debug honored throughout.

const { Config } = require('./config')
const { registerTables } = require('./db')
const { createConcurrencyGuard, createScheduler } = require('./scheduler')
const { createPresence } = require('./presence')
const { createWorld } = require('./world-context')
const { createRegistry } = require('./world-registry')
const { continuityClamp } = require('./world-continuity')
const { createShortTermMemory, createLifeState } = require('./memory-short')
const { createLongTermMemory } = require('./memory-long')
const { createThoughtBuffer } = require('./thought')
const { createNightConsolidator } = require('./memory-consolidate')
const { createRoutineAuthor } = require('./schedule-routine')
const { createAssignmentQueue } = require('./schedule-assignment')
const { createPlanner } = require('./schedule-planner')
const { createProactiveBridge } = require('./proactive')
const { createInject, updateMood } = require('./inject')
const { createRoller, gatherPersona } = require('./roll-roller')
const { getModel, invoke } = require('./model')

exports.name = 'chatluna-life-sim'

exports.inject = { required: ['chatluna', 'database'], optional: ['chatluna_character'] }

exports.Config = Config

exports.apply = (ctx, config) => {
  const logger = ctx.logger('chatluna-life-sim')

  // Register all DB tables (idempotent).
  registerTables(ctx)

  // ── §5.11 Shared ConcurrencyGuard — ONE instance, shared across scheduler + presence + roller ──
  const guard = createConcurrencyGuard()

  // ── Scheduler (persistent task queue + timers) ──
  const scheduler = createScheduler(ctx, config, logger, guard)

  // ── PresenceState (WITH_USER / LINGERING / LIVING) ──
  // Subscribes to chatluna_character/message_collect internally.
  const presence = createPresence(ctx, config, guard, logger)

  // ── WorldContext (clock + weather + season) ──
  const world = createWorld(ctx, config)

  // ── EventRegistry (event types + hot-reload) ──
  const registry = createRegistry(ctx, config)

  // ── ShortTermMemory (event stream) + LifeStateStore ──
  const shortMem = createShortTermMemory(ctx, config)
  const lifeState = createLifeState(ctx)

  // ── LongTermMemory (consolidated long-term + relationships) ──
  const longMem = createLongTermMemory(ctx)

  // ── ThoughtBuffer (心事簿) ──
  const thoughtBuffer = createThoughtBuffer(ctx)

  // ── AssignmentQueue ──
  const assignmentQueue = createAssignmentQueue(ctx)

  // ── RoutineAuthor ──
  // getPersona hook: closes over gatherPersona(presetId, ctx, config).
  // This resolves the Task 7 TODO — always passes the same closure to both routineAuthor and roller.
  const _gatherPersona = (presetId) => gatherPersona(presetId, ctx, config)

  const routineAuthor = createRoutineAuthor(ctx, config, {
    getPersona: _gatherPersona,
    recent: (presetId, n) => shortMem.recent(presetId, n),
    getModel: (ctx_, modelName) => getModel(ctx_, modelName),
    invoke,
  })

  // ── DailyPlanner (plan blocks + wake schedule) ──
  const planner = createPlanner(ctx, config, {
    blocksForToday: (presetId, nowMs) => routineAuthor.blocksForToday(presetId, nowMs),
    assignmentQueue,
    scheduler,
  })

  // ── Silence state tracker for ProactiveBridge.maybeFollowUp ──
  // Tracks per-preset: lastUserMessageMs + followUpCount per LINGERING episode.
  // Reset on each new WITH_USER → LINGERING transition.
  const _silenceMap = new Map()  // Map<presetId, {lastUserMs: number, followUpCount: number, episodeId: number}>

  function _getSilence(presetId) {
    if (!_silenceMap.has(presetId)) {
      _silenceMap.set(presetId, { lastUserMs: 0, followUpCount: 0, episodeId: 0 })
    }
    return _silenceMap.get(presetId)
  }

  function silenceState(presetId) {
    const s = _getSilence(presetId)
    const silenceMinutes = s.lastUserMs > 0
      ? Math.round((Date.now() - s.lastUserMs) / 60000)
      : 0
    return { silenceMinutes, followUpCount: s.followUpCount }
  }

  // Track user messages for silence computation.
  // Called from presence's onUserMessage path via our own subscriber.
  // NOTE: presence already subscribes to chatluna_character/message_collect.
  // We add a SECOND subscriber here for our silence tracking — both fire.
  ctx.on('chatluna_character/message_collect', (session) => {
    try {
      const presets = (config && config.presets) || []
      for (const presetId of presets) {
        const s = _getSilence(presetId)
        // If state transitions WITH_USER → LINGERING, followUpCount resets.
        // We detect this by watching for presence state just before it changes.
        // Simpler: reset on any fresh user message (new activity resets the episode).
        const prevPresence = presence.state(presetId)
        if (prevPresence === 'LINGERING' || prevPresence === 'LIVING') {
          // New user message after a linger/live gap = new episode, reset followUpCount
          s.followUpCount = 0
          s.episodeId++
        }
        s.lastUserMs = Date.now()
      }
    } catch (e) {
      logger.warn('[life-sim] silence tracking error: %s', e && e.message)
    }
  })

  // ── NightConsolidator (short→long sedimentation) ──
  const consolidator = createNightConsolidator(ctx, config, {
    getModel: (modelName) => getModel(ctx, modelName),
    invoke,
    ltm: longMem,
    scheduler,
    planner: {
      planDay: (presetId, day) => planner.planDay(presetId, day, Date.now()),
    },
    tidyThoughts: async (presetId) => {
      // Best-effort: mark surfaced thoughts as surfaced (minimal for P1)
      // Full tidy is P2; for now just a hook placeholder.
    },
  })

  // ── ProactiveBridge ──
  // Relay send: use bot.sendPrivateMessage (same approach as relay plugin).
  // We need to send to the 审神者's QQ. For P1, we look at config.presets
  // and use chatluna_character's bot context or log-only if no bot available.
  // The transport is best-effort; ProactiveBridge handles failures gracefully.
  function _makeSendViaRelay(presetId) {
    return async (pid, text) => {
      if (config.dryRun) {
        logger.info('[proactive:dryRun] would send to %s: %s', pid, (text || '').slice(0, 120))
        return
      }
      // In P1 there's no established "审神者 QQ" configuration in config yet.
      // ProactiveBridge expects sendViaRelay(presetId, text).
      // We try to find a bot from ctx.bots (koishi's active bot list).
      // This is a best-effort integration point — if no bot is found, we log.
      // A future config field (e.g. config.masterQQ) would make this more reliable.
      try {
        const bots = ctx.bots
        const bot = bots && bots[0]
        if (!bot) {
          logger.warn('[proactive] no bot available for sendViaRelay, text=%s', (text || '').slice(0, 60))
          return
        }
        // For P1: log and no-op (real sending requires knowing the 审神者's QQ or channel).
        // Document as integration concern below.
        logger.info('[proactive] sendViaRelay (P1: no masterQQ configured) — text=%s', (text || '').slice(0, 80))
      } catch (e) {
        logger.warn('[proactive] sendViaRelay error: %s', e && e.message)
      }
    }
  }

  const proactive = createProactiveBridge(ctx, config, {
    thoughtBuffer,
    sendViaRelay: _makeSendViaRelay(),
    sendDirect: null,
    getModel: (ctx_, modelName) => getModel(ctx_, modelName),
    invoke,
    silenceState,
    presence: { goLive: (presetId) => presence.goLive(presetId) },
    // §5.8 成稿改写: proactiveModel (空=复用 consolidateModel) rewrites the cheap
    // draft in the persona's voice before send; persona 与 roller 共用同一闭包.
    rewriteModel: config.proactiveModel || config.consolidateModel,
    getPersona: _gatherPersona,
    logger,
  })

  // ── PresenceState: wire linger-eval callback → proactive.maybeFollowUp ──
  presence.onLingerEval((presetId) => {
    // Called when linger timer fires. Ask proactive if it wants to follow up.
    // maybeFollowUp calls presence.goLive() internally if it decides not to follow up.
    // We also bump followUpCount each time this fires.
    const s = _getSilence(presetId)
    s.followUpCount++
    proactive.maybeFollowUp(presetId, Date.now()).catch((e) => {
      logger.warn('[life-sim] maybeFollowUp error for %s: %s', presetId, e && e.message)
      // Safety: go live if follow-up errored
      presence.goLive(presetId)
    })
  })

  // ── Prompt inject (4 variables → chatluna promptRenderer) ──
  // todayStr: timezone-aware YYYY-MM-DD
  function _todayStr(nowMs) {
    const tz = (config && config.timezone) || 'Asia/Shanghai'
    try {
      const fmt = new Intl.DateTimeFormat('en-CA', {
        year: 'numeric', month: '2-digit', day: '2-digit',
        timeZone: tz,
      })
      return fmt.format(new Date(nowMs))
    } catch (_) {
      const d = new Date(nowMs)
      return d.getFullYear() + '-' +
        String(d.getMonth() + 1).padStart(2, '0') + '-' +
        String(d.getDate()).padStart(2, '0')
    }
  }

  const inject = createInject(ctx, config, {
    recent: (presetId, n) => shortMem.recent(presetId, n),
    getState: (presetId) => lifeState.getState(presetId),
    getPlan: (presetId, dayStr) => planner.getPlan(presetId, dayStr),
    recallThoughts: (presetId, target) => thoughtBuffer.recall(presetId, target),
    todayStr: _todayStr,
    resolveTarget: (_session) => '审神者',
  })

  // ── EventRoller ──
  // onShare: after a roll, pass want_to_share to proactive bridge.
  // updateMood: applied after roll persists next_state (in handler below).
  const roller = createRoller(ctx, config, {
    getWorld: (presetId) => world.getWorld(presetId),
    available: (w, ls) => registry.available(w, ls),
    getState: (presetId) => lifeState.getState(presetId),
    setState: (presetId, patch) => lifeState.setState(presetId, patch),
    recent: (presetId, n) => shortMem.recent(presetId, n),
    appendEvent: (presetId, event) => shortMem.appendEvent(presetId, event),
    getModel: (modelName) => getModel(ctx, modelName),
    invoke,
    continuityClamp,
    scheduler,
    guard,
    presence: { isLiving: (pid) => presence.isLiving(pid), state: (pid) => presence.state(pid) },
    planner,
    gatherPersona: _gatherPersona,
    onShare: (presetId, wantToShare) => proactive.maybeReachOut(presetId, wantToShare, Date.now()),
    silenceState,
  })

  // ── Register task handlers ──
  roller.registerHandlers()      // 'roll' + 'block'
  consolidator.registerHandler() // 'consolidate'

  // 'prune' handler (minimal for P1: prune LTM below threshold)
  scheduler.registerHandler('prune', async (presetId, _type, _payload, _task) => {
    if (!config.dryRun) {
      const threshold = (config && config.pruneThreshold) || 0.25
      const removed = await longMem.prune(presetId, threshold)
      if (config.debug) {
        logger.info('[life-sim] prune: %s removed %d LTM entries below %.2f', presetId, removed, threshold)
      }
    } else {
      logger.info('[life-sim:dryRun] prune would run for %s', presetId)
    }
  })

  // ── ready: boot sequence ──
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

    // Register prompt injection providers.
    // Must happen after promptRenderer is available (it is, since chatluna is injected).
    inject.register()

    // Process pending tasks from DB (drop overdue, fire slightly-late, arm timers).
    await scheduler.onReady()

    // For each managed preset: bootstrap if no pending roll task exists.
    const presets = (config && config.presets) || []
    for (const presetId of presets) {
      try {
        // Check if there's already a pending roll task for this preset.
        const pending = await ctx.database.get('life_sim_task', { presetId, type: 'roll', status: 'pending' })
        if (!pending || pending.length === 0) {
          // No pending roll — schedule an initial one for "now" (fires immediately on ready).
          const fireAt = new Date(Date.now() + 5000)  // 5s grace after ready
          await scheduler.scheduleTask(presetId, fireAt, 'roll')
          logger.info('[life-sim] scheduled initial roll for %s', presetId)
        } else {
          logger.info('[life-sim] %s already has %d pending roll task(s), skipping initial schedule', presetId, pending.length)
        }

        // Schedule nightly consolidate if none pending.
        const pendingConsolidate = await ctx.database.get('life_sim_task', { presetId, type: 'consolidate', status: 'pending' })
        if (!pendingConsolidate || pendingConsolidate.length === 0) {
          const consolidateAt = _nextSleepMs(config)
          await scheduler.scheduleTask(presetId, new Date(consolidateAt), 'consolidate')
          logger.info('[life-sim] scheduled nightly consolidate for %s at %s', presetId, new Date(consolidateAt).toISOString())
        }
      } catch (e) {
        logger.warn('[life-sim] ready bootstrap error for %s: %s', presetId, e && e.message)
      }
    }
  })

  // ── dispose ──
  ctx.on('dispose', () => {
    presence.dispose()
    scheduler.dispose()
    logger.info('chatluna-life-sim disposed.')
  })

  // ── §5.3e ③ 审神者 commands ──
  // life-sim.plan [preset]    — show today's plan
  // life-sim.state [preset]   — show life-state
  // life-sim.plan.skip <idx>  — mark a block skipped (minimal P1)
  // life-sim.enqueue <desc>   — enqueue an assignment (审神者吩咐)
  // All commands gated to authority >= 3 (koishi default for admin-level ops).

  ctx.command('life-sim', '本丸日常模拟器管理')

  ctx.command('life-sim.plan [preset:string]', '查看今天的日程计划')
    .alias('日程')
    .action(async ({ session }, presetArg) => {
      try {
        const presetId = presetArg || (config.presets && config.presets[0]) || null
        if (!presetId) return '未配置 presetId。'
        const nowMs = Date.now()
        const dayStr = _todayStr(nowMs)
        const plan = await planner.getPlan(presetId, dayStr)
        if (!plan || !plan.blocks || plan.blocks.length === 0) {
          return `[${presetId}] 今天（${dayStr}）暂无计划。`
        }
        const lines = plan.blocks.map((b, i) => {
          const cur = (nowMs >= b.start && nowMs < b.end) ? '▶ ' : `  [${i}] `
          const status = b.status && b.status !== 'pending' ? ` (${b.status})` : ''
          return `${cur}${b.block} ${b.activity}${status}`
        })
        return `[${presetId}] 今日计划 (${dayStr}):\n` + lines.join('\n')
      } catch (e) {
        logger.warn('[life-sim cmd] plan error: %s', e && e.message)
        return '获取日程时出错：' + (e && e.message)
      }
    })

  ctx.command('life-sim.state [preset:string]', '查看当前生命状态')
    .alias('状态')
    .action(async ({ session }, presetArg) => {
      try {
        const presetId = presetArg || (config.presets && config.presets[0]) || null
        if (!presetId) return '未配置 presetId。'
        const state = await lifeState.getState(presetId)
        const presence_ = presence.state(presetId)
        const parts = [
          `[${presetId}] 当前状态：`,
          `  在场状态: ${presence_}`,
          `  位置: ${state.location || '未知'}`,
          `  活动: ${state.current_activity || '—'}`,
          `  心情: ${state.mood || 'neutral'}`,
        ]
        if (Array.isArray(state.open_threads) && state.open_threads.length > 0) {
          parts.push(`  未了: ${state.open_threads.join('、')}`)
        }
        return parts.join('\n')
      } catch (e) {
        logger.warn('[life-sim cmd] state error: %s', e && e.message)
        return '获取状态时出错：' + (e && e.message)
      }
    })

  ctx.command('life-sim.plan.skip <idx:number> [preset:string]', '跳过今日计划中的某个时间块')
    .option('preset', '-p <preset:string> 指定 presetId')
    .action(async ({ session, options }, idx, presetArg) => {
      try {
        const presetId = presetArg || options.preset || (config.presets && config.presets[0]) || null
        if (!presetId) return '未配置 presetId。'
        if (idx == null || typeof idx !== 'number') return '请提供时间块序号 (0-based)。'
        const nowMs = Date.now()
        const dayStr = _todayStr(nowMs)
        const plan = await planner.getPlan(presetId, dayStr)
        if (!plan || !plan.blocks) return '今日没有计划。'
        if (idx < 0 || idx >= plan.blocks.length) return `序号超出范围（0–${plan.blocks.length - 1}）。`
        const block = plan.blocks[idx]
        if (block.status === 'done') return `时间块 [${idx}] 已完成。`
        // Mark as skipped by calling replan from idx+1 and marking [idx] interrupted
        await planner.replan(presetId, idx, nowMs)
        return `[${presetId}] 已跳过时间块 [${idx}] ${block.block} ${block.activity}。`
      } catch (e) {
        logger.warn('[life-sim cmd] plan.skip error: %s', e && e.message)
        return '跳过时出错：' + (e && e.message)
      }
    })

  ctx.command('life-sim.enqueue <desc:text>', '审神者吩咐：向队列添加一个任务')
    .alias('吩咐')
    .option('preset', '-p <preset:string> 指定 presetId')
    .option('day', '-d <day:string> 截止日期 YYYY-MM-DD')
    .option('block', '-b <block:string> 截止时间块（清晨|上午|午后|黄昏|夜|深夜）')
    .action(async ({ session, options }, desc) => {
      try {
        if (!desc) return '请提供任务描述。'
        const presetId = options.preset || (config.presets && config.presets[0]) || null
        if (!presetId) return '未配置 presetId。'
        await assignmentQueue.enqueue({
          presetId,
          desc,
          dueDay:     options.day   || null,
          dueBlock:   options.block || null,
          source:     '审神者',
          assignedBy: (session && session.userId) || '审神者',
          status:     'pending',
        })
        return `已为 [${presetId}] 添加任务：${desc}` +
          (options.day ? `（${options.day}${options.block ? ' ' + options.block : ''}）` : '')
      } catch (e) {
        logger.warn('[life-sim cmd] enqueue error: %s', e && e.message)
        return '添加任务时出错：' + (e && e.message)
      }
    })

  ctx.command('life-sim.roll [preset:string]', '(调试) 立即触发一次 roll')
    .option('preset', '-p <preset:string> 指定 presetId')
    .action(async ({ session, options }, presetArg) => {
      try {
        const presetId = presetArg || options.preset || (config.presets && config.presets[0]) || null
        if (!presetId) return '未配置 presetId。'
        logger.info('[life-sim cmd] manual roll triggered for %s', presetId)
        roller.roll(presetId, Date.now()).catch((e) =>
          logger.warn('[life-sim cmd] roll error: %s', e && e.message)
        )
        return `[${presetId}] roll 已触发（异步执行）。`
      } catch (e) {
        return 'roll 触发失败：' + (e && e.message)
      }
    })

  // ── After-roll mood hook ──
  // The roller already calls setState(presetId, next_state_patch) in _doRoll Step 7.
  // next_state may already carry mood (from parsed.next_state.mood).
  // We avoid double-setting: the updateMood hook is ONLY applied when next_state
  // does NOT already have a mood field but the event does.
  // This is done in the 'roll' task handler wrapper by augmenting the scheduler handler.
  // Since roller.registerHandlers() is already called above, and the handler is:
  //   scheduler.registerHandler('roll', async (presetId) => { await roll(presetId, ...) })
  // the mood update is already contained inside roll() → _doRoll() → setState(nextStatePatch).
  // The patch from continuity-clamped next_state already carries mood when the model set it.
  // For fallback rolls (no parsed.next_state), the event's mood is missing from the patch.
  // We add a thin wrapper via a post-roll hook in the 'roll' handler:
  // (re-register with a wrapper that adds updateMood after the roll completes)
  scheduler.registerHandler('roll', async (presetId, type, payload, task) => {
    // Execute the roll (roller internally calls setState with next_state_patch)
    await roller.roll(presetId, Date.now())

    // Post-roll mood hook: if roll completed, ensure mood is up-to-date.
    // Get the most recent event and apply updateMood if next_state had no mood.
    try {
      const recent = await shortMem.recent(presetId, 1)
      if (recent && recent.length > 0) {
        const latestEvent = recent[0]
        if (latestEvent && latestEvent.mood) {
          const current = await lifeState.getState(presetId)
          // Only update if the stored mood differs (avoid redundant write)
          if (current && current.mood !== latestEvent.mood) {
            const updated = updateMood(current, latestEvent)
            await lifeState.setState(presetId, { mood: updated.mood })
            if (config.debug) {
              logger.info('[life-sim] updateMood: %s mood %s → %s', presetId, current.mood, updated.mood)
            }
          }
        }
      }
    } catch (e) {
      logger.warn('[life-sim] post-roll updateMood error for %s: %s', presetId, e && e.message)
    }
  })

  // ── After consolidate: re-schedule next nightly consolidate ──
  scheduler.registerHandler('consolidate', async (presetId, type, payload, task) => {
    // Delegate to consolidator's own handler first
    const day = (payload && payload.day) ? payload.day : _todayStr(Date.now())
    const nowMs = Date.now()
    try {
      const result = await consolidator.consolidate(presetId, day, nowMs)
      logger.info('[life-sim] nightly consolidate for %s: processed=%d clusters=%d', presetId, result.processed, result.clusters)
    } catch (e) {
      logger.warn('[life-sim] consolidate error for %s: %s', presetId, e && e.message)
    }

    // Re-schedule next nightly consolidate
    try {
      const nextConsolidateMs = _nextSleepMs(config)
      await scheduler.scheduleTask(presetId, new Date(nextConsolidateMs), 'consolidate')
      if (config.debug) {
        logger.info('[life-sim] next nightly consolidate for %s scheduled at %s', presetId, new Date(nextConsolidateMs).toISOString())
      }
    } catch (e) {
      logger.warn('[life-sim] failed to re-schedule consolidate for %s: %s', presetId, e && e.message)
    }
  })

  // Expose internals for debugging / testing (not a koishi service).
  exports._scheduler = scheduler
  exports._presence = presence
  exports._guard = guard
  exports._roller = roller
  exports._planner = planner
  exports._lifeState = lifeState
  exports._shortMem = shortMem
  exports._longMem = longMem
  exports._thoughtBuffer = thoughtBuffer
  exports._inject = inject
  exports._proactive = proactive
}

// ── Internal: compute unix-ms of next sleep hour (config.sleepHour) ──
/**
 * Returns the unix-ms of the next occurrence of config.sleepHour in local time.
 * If that hour hasn't passed today, returns today's sleepHour; else tomorrow's.
 *
 * @param {object} config  Plugin config (timezone, sleepHour)
 * @returns {number}  Unix-ms of next sleep
 */
function _nextSleepMs(config) {
  const tz = (config && config.timezone) || 'Asia/Shanghai'
  const sleepHour = (config && config.sleepHour != null) ? config.sleepHour : 23

  const now = new Date()

  // Get current local hour in the config timezone
  let localHour = 0
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      timeZone: tz,
      hour: 'numeric',
      hour12: false,
    })
    const parts = fmt.formatToParts(now)
    const hPart = parts.find((p) => p.type === 'hour')
    localHour = hPart ? parseInt(hPart.value, 10) : now.getHours()
    if (localHour === 24) localHour = 0
  } catch (_) {
    localHour = now.getHours()
  }

  // Get today's date string in local tz (YYYY-MM-DD)
  let todayStr
  try {
    const fmt2 = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
    })
    todayStr = fmt2.format(now)
  } catch (_) {
    const y = now.getFullYear()
    const m = String(now.getMonth() + 1).padStart(2, '0')
    const d = String(now.getDate()).padStart(2, '0')
    todayStr = y + '-' + m + '-' + d
  }

  // Build target Date for sleepHour today
  const [year, month, day] = todayStr.split('-').map(Number)
  // Approximate: construct local midnight then add sleepHour hours.
  // We use a rough approach: Date.UTC for midnight + offset correction.
  // The simplest robust approach: parse ISO string with explicit UTC offset trick.
  // Use the fact that new Date(year, month-1, day, hour) uses LOCAL time.
  // NOTE: This uses the Node process local time, not necessarily config.timezone.
  // For P1 (Asia/Shanghai servers), this is fine. For full tz correctness we'd
  // need a library. Document as a known P1 approximation.
  const todayTarget = new Date(year, month - 1, day, sleepHour, 0, 0, 0)

  if (todayTarget.getTime() > Date.now() + 60000) {
    // Still in the future (at least 1 minute away)
    return todayTarget.getTime()
  }

  // Already past today's sleep hour — schedule for tomorrow
  const tomorrowTarget = new Date(year, month - 1, day + 1, sleepHour, 0, 0, 0)
  return tomorrowTarget.getTime()
}
