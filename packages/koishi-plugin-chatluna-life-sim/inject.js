'use strict'

// inject.js — PromptProvider 注入 + 心情波动 for koishi-plugin-chatluna-life-sim
//
// Pure helpers (offline-testable, no runtime deps, no new Date()):
//   renderRecentLife(events, n)        → digest text of recent N events
//   renderLifeState(state)             → text: 此刻在 <location>… 心情… 未了的事…
//   renderTodayPlan(plan, nowMs)       → text listing today's blocks; current block marked
//   renderPendingThoughts(thoughts)    → text of pending thoughts (or '' if empty)
//   updateMood(lifeState, event)       → NEW life-state with mood updated from event.mood
//
// Glue (needs ctx + deps, not tested offline):
//   createInject(ctx, config, deps)    → { register() }
//     register() calls ctx.chatluna.promptRenderer.registerFunctionProvider for 4 vars.
//
// Design refs: §4.6 (注入), §5.2 (life-state), §7 (心情波动)

// ---------------------------------------------------------------------------
// Pure helpers
// ---------------------------------------------------------------------------

/**
 * Render a short text digest of the N most-recent events.
 *
 * Each line: "<title>（<mood>）" or just "<title>" if no mood/title.
 * If events is empty or n=0, returns ''.
 * Caps at n if provided.
 *
 * No new Date() called. Pure function.
 *
 * @param {Array} events  Array of life_sim_event objects (already sorted newest-first, or unsorted)
 * @param {number} [n]    Max events to render (default: all)
 * @returns {string}
 */
function renderRecentLife(events, n) {
  if (!Array.isArray(events) || events.length === 0) return ''
  const cap = (n != null && Number.isFinite(+n) && +n >= 0) ? Math.round(+n) : events.length
  if (cap === 0) return ''
  const slice = events.slice(0, cap)
  const lines = slice.map((e) => {
    const title = (e && e.title) ? String(e.title) : '（无标题）'
    const mood = (e && e.mood) ? `（${e.mood}）` : ''
    return title + mood
  })
  return lines.join('\n')
}

/**
 * Render the current life-state as a human-readable text.
 *
 * Format:
 *   此刻在 <location>，<current_activity>。心情：<mood>。
 *   未了的事：<open_threads joined by '、'> （or nothing if empty array）
 *
 * Gracefully handles missing fields.
 * No new Date() called. Pure function.
 *
 * @param {object} state  life-state object (§5.2)
 * @returns {string}
 */
function renderLifeState(state) {
  if (!state || typeof state !== 'object') return ''

  const location = state.location ? `在 ${state.location}` : '在某处'
  const activity = state.current_activity ? `，${state.current_activity}` : ''
  const mood = state.mood ? state.mood : 'neutral'

  let parts = [`此刻${location}${activity}。心情：${mood}。`]

  const threads = Array.isArray(state.open_threads) ? state.open_threads.filter(Boolean) : []
  if (threads.length > 0) {
    parts.push(`未了的事：${threads.join('、')}`)
  }

  return parts.join('\n')
}

/**
 * Render today's plan blocks as text, marking the current block with a ▶ prefix.
 *
 * Each line:  "<block> <activity>"  or  "▶ <block> <activity>" for the current block.
 * If plan or plan.blocks is empty/null, returns ''.
 * nowMs is used to detect the current block (block.start <= nowMs < block.end).
 * No new Date() called. Pure function.
 *
 * @param {object|null} plan    { blocks: Array<{block, activity, start, end}> } or null
 * @param {number} nowMs        Current unix-ms
 * @returns {string}
 */
function renderTodayPlan(plan, nowMs) {
  if (!plan) return ''
  const blocks = plan.blocks
  if (!Array.isArray(blocks) || blocks.length === 0) return ''

  const lines = blocks.map((b) => {
    const label = b.block || '？'
    const activity = b.activity || '（未知活动）'
    const isCurrent = (nowMs != null &&
      Number.isFinite(+nowMs) &&
      +b.start <= +nowMs && +nowMs < +b.end)
    const prefix = isCurrent ? '▶ ' : '  '
    return `${prefix}${label} ${activity}`
  })
  return lines.join('\n')
}

/**
 * Render pending thoughts as text.
 *
 * Each line: "- <content>  [<urgency>]"  (urgency omitted if absent/null)
 * If thoughts is empty/null, returns ''.
 * No new Date() called. Pure function.
 *
 * @param {Array} thoughts  Array of thought objects with { content, urgency }
 * @returns {string}
 */
function renderPendingThoughts(thoughts) {
  if (!Array.isArray(thoughts) || thoughts.length === 0) return ''
  const lines = thoughts.map((t) => {
    const content = (t && t.content) ? String(t.content) : '（无内容）'
    const urgency = (t && t.urgency) ? ` [${t.urgency}]` : ''
    return `- ${content}${urgency}`
  })
  return lines.join('\n')
}

/**
 * Return a NEW life-state with mood updated from the event's mood.
 *
 * Rule: if event.mood is a non-empty string, the new mood = event.mood (direct replace).
 * If event.mood is absent/null/'', the existing mood is preserved.
 *
 * This is intentionally simple ("event mood becomes current mood").
 * Never mutates either input. No new Date() called. Pure function.
 *
 * @param {object} lifeState  Current life-state (§5.2)
 * @param {object} event      Roll event object with optional event.mood field
 * @returns {object}          New life-state with (possibly) updated mood field
 */
function updateMood(lifeState, event) {
  if (!lifeState || typeof lifeState !== 'object') {
    throw new Error('updateMood: lifeState must be an object')
  }
  const eventMood = (event && event.mood != null && String(event.mood).trim() !== '')
    ? String(event.mood).trim()
    : null

  if (eventMood === null) {
    // No mood in event — preserve existing
    return Object.assign({}, lifeState)
  }

  return Object.assign({}, lifeState, { mood: eventMood })
}

// ---------------------------------------------------------------------------
// Glue: createInject
// ---------------------------------------------------------------------------

/**
 * Create the PromptProvider injector.
 *
 * @param {object} ctx      Koishi context with optional ctx.chatluna.promptRenderer
 * @param {object} config   Plugin config ({ presets, timezone?, varNames? })
 * @param {object} deps     {
 *   recent(presetId, n) → Promise<Array>          // from createShortTermMemory
 *   getState(presetId) → Promise<object>           // from createLifeState
 *   getPlan(presetId, dayStr) → Promise<object|null> // from createPlanner
 *   recallThoughts(presetId, target) → Promise<Array> // from createThoughtBuffer.recall
 *   todayStr(nowMs) → string                       // 'YYYY-MM-DD' for a given ms
 *   resolveTarget(session) → string                // e.g. '审神者', caller-supplied
 * }
 * @returns {{ register() }}
 */
function createInject(ctx, config, deps) {
  const logger = ctx.logger ? ctx.logger('chatluna-life-sim:inject') : console

  // Variable name configuration — allow override via config.varNames
  const varNames = Object.assign(
    {
      recentLife:      'recent_life',
      lifeState:       'life_state',
      todayPlan:       'today_plan',
      pendingThoughts: 'pending_thoughts',
    },
    (config && config.varNames) || {}
  )

  // Derive presetId from session.  In P1 (single-preset), fall back to config.presets[0].
  // If chatluna_living_memory service is available and has resolvePresetId, use it.
  function _presetIdFromSession(session) {
    // Try chatluna_living_memory.resolvePresetId if available
    if (ctx.chatluna_living_memory &&
        typeof ctx.chatluna_living_memory.resolvePresetId === 'function') {
      try {
        const pid = ctx.chatluna_living_memory.resolvePresetId(session, undefined)
        if (pid) return pid
      } catch (_) {}
    }
    // Fallback: P1 single-preset
    const presets = (config && config.presets) || []
    return presets[0] || null
  }

  // Derive target string from session.  Default to '审神者' (the user/master).
  // Callers who supply deps.resolveTarget override this.
  function _targetFromSession(session) {
    if (deps && typeof deps.resolveTarget === 'function') {
      try { return deps.resolveTarget(session) } catch (_) {}
    }
    return '审神者'
  }

  // Compute today's YYYY-MM-DD string (uses deps.todayStr if provided, else Date-based).
  function _todayStr(nowMs) {
    if (deps && typeof deps.todayStr === 'function') {
      return deps.todayStr(nowMs)
    }
    // Fallback: local date string
    const d = new Date(nowMs)
    const y = d.getFullYear()
    const m = String(d.getMonth() + 1).padStart(2, '0')
    const day = String(d.getDate()).padStart(2, '0')
    return y + '-' + m + '-' + day
  }

  function register() {
    // Guard: promptRenderer must be present
    const renderer = ctx.chatluna && ctx.chatluna.promptRenderer
    if (!renderer || typeof renderer.registerFunctionProvider !== 'function') {
      logger.warn
        ? logger.warn('[inject] ctx.chatluna.promptRenderer not available — skipping provider registration')
        : console.warn('[inject] ctx.chatluna.promptRenderer not available — skipping provider registration')
      return
    }

    // 1. {recent_life}
    ctx.effect(() =>
      renderer.registerFunctionProvider(
        varNames.recentLife,
        async (args, _vars, configurable) => {
          try {
            const session = configurable && configurable.session
            const presetId = _presetIdFromSession(session)
            if (!presetId) return ''
            const n = (args && args[0]) ? Math.max(1, parseInt(args[0], 10) || 10) : 10
            const events = await deps.recent(presetId, n)
            return renderRecentLife(events, n)
          } catch (err) {
            logger.warn
              ? logger.warn('[inject] recent_life error: ' + err.message)
              : console.warn('[inject] recent_life error: ' + err.message)
            return ''
          }
        }
      )
    )

    // 2. {life_state}
    ctx.effect(() =>
      renderer.registerFunctionProvider(
        varNames.lifeState,
        async (_args, _vars, configurable) => {
          try {
            const session = configurable && configurable.session
            const presetId = _presetIdFromSession(session)
            if (!presetId) return ''
            const state = await deps.getState(presetId)
            return renderLifeState(state)
          } catch (err) {
            logger.warn
              ? logger.warn('[inject] life_state error: ' + err.message)
              : console.warn('[inject] life_state error: ' + err.message)
            return ''
          }
        }
      )
    )

    // 3. {today_plan}
    ctx.effect(() =>
      renderer.registerFunctionProvider(
        varNames.todayPlan,
        async (_args, _vars, configurable) => {
          try {
            const session = configurable && configurable.session
            const presetId = _presetIdFromSession(session)
            if (!presetId) return ''
            const nowMs = Date.now()
            const dayStr = _todayStr(nowMs)
            const plan = await deps.getPlan(presetId, dayStr)
            return renderTodayPlan(plan, nowMs)
          } catch (err) {
            logger.warn
              ? logger.warn('[inject] today_plan error: ' + err.message)
              : console.warn('[inject] today_plan error: ' + err.message)
            return ''
          }
        }
      )
    )

    // 4. {pending_thoughts}
    ctx.effect(() =>
      renderer.registerFunctionProvider(
        varNames.pendingThoughts,
        async (_args, _vars, configurable) => {
          try {
            const session = configurable && configurable.session
            const presetId = _presetIdFromSession(session)
            if (!presetId) return ''
            const target = _targetFromSession(session)
            const thoughts = await deps.recallThoughts(presetId, target)
            return renderPendingThoughts(thoughts)
          } catch (err) {
            logger.warn
              ? logger.warn('[inject] pending_thoughts error: ' + err.message)
              : console.warn('[inject] pending_thoughts error: ' + err.message)
            return ''
          }
        }
      )
    )
  }

  return { register }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // Pure helpers (exported for testing + composing)
  renderRecentLife,
  renderLifeState,
  renderTodayPlan,
  renderPendingThoughts,
  updateMood,
  // Glue factory
  createInject,
}
