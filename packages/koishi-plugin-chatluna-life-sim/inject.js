'use strict'

// inject.js — PromptProvider 注入 + 心情波动 for koishi-plugin-chatluna-life-sim
//
// Pure helpers (offline-testable, no runtime deps, no new Date()):
//   renderRecentLife(events, n, opts)  → digest text of recent N events
//                                        (opts={nowMs,timezone} → 相对时间标注 §4.1)
//   relativeTimeLabel(ts, nowMs, tz)   → '刚刚'/'今天上午'/'昨天'/'前天'/'N天前'/''
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
 * Derive the local calendar day + hour of a unix-ms instant in an IANA timezone.
 *
 * Same Intl.DateTimeFormat approach as proactive.js inQuietHours (kept local
 * here to avoid a proactive↔inject require cycle — the two comments cross-ref).
 * dayMs is Date.UTC(localY, localM-1, localD): a timezone-independent key for
 * the LOCAL calendar day, so subtracting two dayMs / 86400000 = local day diff.
 *
 * No new Date(). ms comes from the caller. Pure function.
 *
 * @param {number} ms        Unix-ms instant
 * @param {string} timezone  IANA timezone string, e.g. 'Asia/Shanghai' (falls back to UTC)
 * @returns {{ dayMs: number, hour: number }}
 */
function _localDayHour(ms, timezone) {
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      hour: 'numeric', hour12: false,
      timeZone: timezone || 'UTC',
    })
    const parts = fmt.formatToParts(new Date(ms))
    const get = (t) => {
      const p = parts.find((x) => x.type === t)
      return p ? parseInt(p.value, 10) : NaN
    }
    const y = get('year')
    const mo = get('month')
    const d = get('day')
    let hour = get('hour')
    // Intl returns '24' for midnight in some environments (means 0)
    if (hour === 24) hour = 0
    if (![y, mo, d, hour].every(Number.isFinite)) throw new Error('bad parts')
    return { dayMs: Date.UTC(y, mo - 1, d), hour }
  } catch (_) {
    const dt = new Date(ms)
    return {
      dayMs: Date.UTC(dt.getUTCFullYear(), dt.getUTCMonth(), dt.getUTCDate()),
      hour: dt.getUTCHours(),
    }
  }
}

/**
 * Map a local hour (0-23) to a Chinese part-of-day word.
 * 凌晨(0-4) 早上(5-7) 上午(8-10) 中午(11-12) 下午(13-17) 晚上(18-23)
 */
function _dayPeriod(hour) {
  if (hour < 5) return '凌晨'
  if (hour < 8) return '早上'
  if (hour < 11) return '上午'
  if (hour < 13) return '中午'
  if (hour < 18) return '下午'
  return '晚上'
}

/**
 * Relative-time label for an event timestamp, as seen from nowMs (§4.1).
 *
 * Tiers (local calendar day first, so 昨天23:50 seen at 00:10 is '昨天', not '刚刚'):
 *   same local day & <45min ago → '刚刚'
 *   same local day             → '今天<时段>' (时段 from the EVENT's local hour)
 *   1 local day ago            → '昨天'
 *   2 local days ago           → '前天'
 *   ≥3 local days ago          → 'N天前'
 *   invalid input / future day → ''  (caller adds no label)
 *
 * All time comes from the arguments — no Date.now(). Pure function.
 *
 * @param {number} ts        Event unix-ms
 * @param {number} nowMs     "Now" unix-ms (caller-supplied)
 * @param {string} timezone  IANA timezone string (falls back to UTC)
 * @returns {string}
 */
function relativeTimeLabel(ts, nowMs, timezone) {
  if (!Number.isFinite(+ts) || !Number.isFinite(+nowMs)) return ''
  const ev = _localDayHour(+ts, timezone)
  const now = _localDayHour(+nowMs, timezone)
  const dayDiff = Math.round((now.dayMs - ev.dayMs) / 86400000)

  if (dayDiff === 0) {
    if (+nowMs - +ts < 45 * 60 * 1000) return '刚刚'
    return '今天' + _dayPeriod(ev.hour)
  }
  if (dayDiff === 1) return '昨天'
  if (dayDiff === 2) return '前天'
  if (dayDiff >= 3) return dayDiff + '天前'
  return '' // event on a future local day — don't label
}

/**
 * Render a short text digest of the N most-recent events.
 *
 * Each line: "<title>（<mood>）" or just "<title>" if no mood/title.
 * If events is empty or n=0, returns ''.
 * Caps at n if provided.
 *
 * With opts={nowMs,timezone} each line gets a relative-time prefix like
 * "[刚刚] " / "[今天上午] " / "[昨天] " / "[前天] " / "[N天前] " derived from
 * event.ts (§4.1 — 否则三天前的事和一小时前的事对主模型无区别). Events without
 * a ts get no label. Without opts the output is byte-identical to the old
 * un-labelled format.
 *
 * No new Date().getTime()-style "now" — all time comes from opts. Pure function.
 *
 * @param {Array} events  Array of life_sim_event objects (already sorted newest-first, or unsorted)
 * @param {number} [n]    Max events to render (default: all)
 * @param {{nowMs:number, timezone?:string}} [opts]  Enable relative-time labels
 * @returns {string}
 */
function renderRecentLife(events, n, opts) {
  if (!Array.isArray(events) || events.length === 0) return ''
  const cap = (n != null && Number.isFinite(+n) && +n >= 0) ? Math.round(+n) : events.length
  if (cap === 0) return ''
  const labelled = !!(opts && Number.isFinite(+opts.nowMs))
  const slice = events.slice(0, cap)
  const lines = slice.map((e) => {
    const title = (e && e.title) ? String(e.title) : '（无标题）'
    const mood = (e && e.mood) ? `（${e.mood}）` : ''
    let prefix = ''
    if (labelled && e && Number.isFinite(+e.ts)) {
      const label = relativeTimeLabel(+e.ts, +opts.nowMs, opts.timezone)
      if (label) prefix = `[${label}] `
    }
    return prefix + title + mood
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
            // §4.1 相对时间标注: nowMs/timezone supplied here by the runtime glue
            // (pure helper never calls Date.now(); tz default mirrors index.js _todayStr)
            return renderRecentLife(events, n, {
              nowMs: Date.now(),
              timezone: (config && config.timezone) || 'Asia/Shanghai',
            })
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
  relativeTimeLabel,
  renderLifeState,
  renderTodayPlan,
  renderPendingThoughts,
  updateMood,
  // Glue factory
  createInject,
}
