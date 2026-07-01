'use strict'

// proactive.js — Task 11: ProactiveBridge (主动外联 + 追问)
//
// Pure functions (offline-testable, no runtime deps, NO new Date()):
//   inQuietHours(nowDate, timezone, quietHours)      → boolean
//   passesDailyCap(sentToday, cap, enabled)          → boolean (true = under cap / allowed)
//   withinMinInterval(lastSentMs, nowMs, minH)       → boolean (true = too soon / blocked)
//   hasForbiddenPhrase(text, patterns)               → boolean
//   decideOutreach(share, gates)                     → verdict string
//
// Glue (needs ctx + injected deps):
//   createProactiveBridge(ctx, config, deps) →
//     { maybeReachOut(presetId, share, nowMs), maybeFollowUp(presetId, nowMs) }
//
// Design refs: §5.8 (主动外联) / §5.13 (追问 / LINGERING)

// ---------------------------------------------------------------------------
// FORBIDDEN_PATTERNS — six manipulation categories (§5.8 / §10 HBS)
// ---------------------------------------------------------------------------

/**
 * Default list of forbidden phrases covering six manipulation categories:
 * 1. 催促 (hurrying/pushing)
 * 2. 挽留 (clinging/retention)
 * 3. 情感勒索 (emotional coercion)
 * 4. FOMO (fear of missing out)
 * 5. 负罪诱导 (guilt-tripping)
 * 6. 追问施压 (pressure follow-ups)
 *
 * Each pattern is a RegExp with unicode support.
 * Patterns are intentionally broad to catch paraphrases.
 */
const FORBIDDEN_PATTERNS = [
  // ── 催促 (hurrying) ───────────────────────────────────────────────────────
  /快点|快回来|快说|赶快|催你|等你很久|你怎么还不/u,
  /赶紧|早点|今晚一定|必须今天|今天之内/u,

  // ── 挽留 (clinging/retention) ─────────────────────────────────────────────
  /别走|不要走|你要走了吗|你真的要走吗|走了我怎么办|走了/u,
  /留下来|不许走|你不能走|不要离开|陪我/u,

  // ── 情感勒索 (emotional coercion) ─────────────────────────────────────────
  /我离不开你|没有你我|你不在我就|只有你才|你是我唯一/u,
  /没有你我|失去你|你若不|如果你不|你不.*我就/u,

  // ── FOMO (fear of missing out) ────────────────────────────────────────────
  /错过了|机不可失|仅此一次|现在不.*以后|来不及了/u,
  /机会难得|千载难逢|不抓住|消失了/u,

  // ── 负罪诱导 (guilt-tripping) ─────────────────────────────────────────────
  /你怎么不理我|你不在乎|你根本不|你是不是不|你不爱/u,
  /你让我很难受|让我一个人|你不管我|你忘了我|你不记得/u,
  /你太过分了|你冷落|你抛下|你为什么不理|你不回/u,

  // ── 追问施压 (pressure follow-ups) ───────────────────────────────────────
  /就一句话|就说一句|就回我一下|回我一下|你在吗你在吗/u,
  /还不回|还是不理|到底在哪|为什么不回|你在不在/u,
]

// ---------------------------------------------------------------------------
// Pure function: inQuietHours
// ---------------------------------------------------------------------------

/**
 * Check whether nowDate falls within the configured quiet hours.
 * Handles wrap-around windows (e.g. start=22, end=8 means 22:00–08:00 next day).
 *
 * @param {Date}   nowDate     – the current time (e.g. new Date())
 * @param {string} timezone    – IANA timezone string, e.g. 'Asia/Shanghai'
 * @param {{start:number, end:number}} quietHours
 *                             – { start: hour (0-23), end: hour (0-23) }
 * @returns {boolean}  true = currently in quiet hours (should NOT send)
 */
function inQuietHours(nowDate, timezone, quietHours) {
  if (!quietHours || typeof quietHours.start !== 'number' || typeof quietHours.end !== 'number') {
    return false
  }
  const start = quietHours.start
  const end   = quietHours.end

  // Derive local hour using Intl.DateTimeFormat
  let localHour
  try {
    const fmt = new Intl.DateTimeFormat('en-US', {
      hour: 'numeric',
      hour12: false,
      timeZone: timezone || 'UTC',
    })
    const parts = fmt.formatToParts(nowDate)
    const hourPart = parts.find((p) => p.type === 'hour')
    localHour = hourPart ? parseInt(hourPart.value, 10) : nowDate.getUTCHours()
    // Intl returns '24' for midnight in some environments (means 0)
    if (localHour === 24) localHour = 0
  } catch (_) {
    localHour = nowDate.getUTCHours()
  }

  if (start === end) {
    // Degenerate: zero-width window → never quiet
    return false
  }

  if (start < end) {
    // Normal window: e.g. start=8, end=22 means 08:00–22:00
    return localHour >= start && localHour < end
  } else {
    // Wrap-around: e.g. start=22, end=8 means 22:00–08:00 (overnight)
    return localHour >= start || localHour < end
  }
}

// ---------------------------------------------------------------------------
// Pure function: passesDailyCap
// ---------------------------------------------------------------------------

/**
 * Check whether sending another message is allowed under the daily cap.
 *
 * @param {number}  sentToday  – number of proactive messages sent today
 * @param {number}  cap        – maximum allowed per day
 * @param {boolean} enabled    – whether the daily cap is active
 * @returns {boolean}  true = allowed (under cap or cap disabled)
 */
function passesDailyCap(sentToday, cap, enabled) {
  if (!enabled) return true
  return sentToday < cap
}

// ---------------------------------------------------------------------------
// Pure function: withinMinInterval
// ---------------------------------------------------------------------------

/**
 * Check whether the minimum interval since the last send has NOT elapsed yet
 * (i.e. it is too soon to send again).
 *
 * @param {number|null} lastSentMs     – timestamp (ms) of last sent message, or null
 * @param {number}      nowMs          – current timestamp (ms)
 * @param {number}      minIntervalHours – minimum gap required between sends
 * @returns {boolean}  true = too soon (blocked); false = enough time has passed (allowed)
 */
function withinMinInterval(lastSentMs, nowMs, minIntervalHours) {
  if (lastSentMs == null || lastSentMs === 0) return false  // no prior send → not blocked
  if (!minIntervalHours || minIntervalHours <= 0) return false
  const minIntervalMs = minIntervalHours * 3600 * 1000
  return (nowMs - lastSentMs) < minIntervalMs
}

// ---------------------------------------------------------------------------
// Pure function: hasForbiddenPhrase
// ---------------------------------------------------------------------------

/**
 * Check whether text contains any forbidden manipulation phrase.
 *
 * @param {string}   text      – the draft message to check
 * @param {RegExp[]} patterns  – list of RegExp patterns to test against
 *                               (defaults to FORBIDDEN_PATTERNS if omitted)
 * @returns {boolean}  true = contains a forbidden phrase (should NOT send)
 */
function hasForbiddenPhrase(text, patterns) {
  if (!text || typeof text !== 'string') return false
  const list = Array.isArray(patterns) ? patterns : FORBIDDEN_PATTERNS
  return list.some((re) => re.test(text))
}

// ---------------------------------------------------------------------------
// Pure function: decideOutreach
// ---------------------------------------------------------------------------

/**
 * Combine the persona's decision with gate booleans to produce a single verdict.
 *
 * @param {{ decision: 'now'|'later'|'no', draft?: string }} share
 *   – the want_to_share object from the roll output
 * @param {{
 *   proactiveEnabled: boolean,
 *   isQuietHours:     boolean,
 *   quietHoursEnabled:boolean,
 *   underDailyCap:    boolean,
 *   dailyCapEnabled:  boolean,
 *   tooSoon:          boolean,         // withinMinInterval result
 *   phraseBlocked:    boolean,         // hasForbiddenPhrase result
 *   forbiddenPhraseGuardEnabled: boolean,
 * }} gates
 *
 * @returns {'send'|'park'|'drop'|'block-quiet'|'block-cap'|'block-interval'|'block-phrase'|'disabled'}
 */
function decideOutreach(share, gates) {
  if (!gates.proactiveEnabled) return 'disabled'

  const decision = share && share.decision ? share.decision : 'no'

  if (decision === 'no')    return 'drop'
  if (decision === 'later') return 'park'

  // decision === 'now': check circuit-breakers in priority order
  if (gates.quietHoursEnabled && gates.isQuietHours)       return 'block-quiet'
  if (gates.dailyCapEnabled   && !gates.underDailyCap)     return 'block-cap'
  if (gates.tooSoon)                                       return 'block-interval'
  if (gates.forbiddenPhraseGuardEnabled && gates.phraseBlocked) return 'block-phrase'

  return 'send'
}

// ---------------------------------------------------------------------------
// Helper: derive day key from nowMs + timezone (YYYY-MM-DD in local time)
// ---------------------------------------------------------------------------

/**
 * @param {number} nowMs
 * @param {string} timezone
 * @returns {string}  e.g. '2026-07-01'
 */
function _dayKey(nowMs, timezone) {
  try {
    const fmt = new Intl.DateTimeFormat('en-CA', {
      year: 'numeric', month: '2-digit', day: '2-digit',
      timeZone: timezone || 'UTC',
    })
    return fmt.format(new Date(nowMs))
  } catch (_) {
    const d = new Date(nowMs)
    const y = d.getUTCFullYear()
    const m = String(d.getUTCMonth() + 1).padStart(2, '0')
    const day = String(d.getUTCDate()).padStart(2, '0')
    return `${y}-${m}-${day}`
  }
}

// ---------------------------------------------------------------------------
// Glue: createProactiveBridge
// ---------------------------------------------------------------------------

/**
 * Create the ProactiveBridge instance for one plugin context.
 *
 * @param {object} ctx     – koishi context (used for logger; not needed for pure tests)
 * @param {object} config  – plugin config matching §8 schema
 * @param {{
 *   thoughtBuffer:  { store(thought): Promise<object> },
 *   sendViaRelay:   (presetId: string, text: string) => Promise<void>,
 *   sendDirect:     (presetId: string, text: string) => Promise<void>,
 *   getModel:       (ctx: object, modelName: string) => Promise<object>,
 *   invoke:         (model: object, messages: Array) => Promise<string>,
 *   silenceState:   (presetId: string) => { silenceMinutes: number, followUpCount: number },
 *   presence:       { goLive(presetId: string): void },
 *   logger?:        object,
 * }} deps
 *
 * @returns {{
 *   maybeReachOut(presetId: string, share: object, nowMs: number): Promise<void>,
 *   maybeFollowUp(presetId: string, nowMs: number): Promise<void>,
 * }}
 */
function createProactiveBridge(ctx, config, deps) {
  const cfg = config || {}
  const d   = deps || {}

  const logger = d.logger || (ctx && ctx.logger && ctx.logger('proactive')) || {
    info:  () => {},
    warn:  () => {},
    error: () => {},
    debug: () => {},
  }

  // In-memory counter: Map keyed by `${presetId}|${YYYY-MM-DD}` → { sent: number, lastSentMs: number|null }
  const _dailyStats = new Map()

  function _getStats(presetId, dayKey) {
    const k = presetId + '|' + dayKey
    if (!_dailyStats.has(k)) _dailyStats.set(k, { sent: 0, lastSentMs: null })
    return _dailyStats.get(k)
  }

  function _bumpStats(presetId, dayKey, nowMs) {
    const k = presetId + '|' + dayKey
    const stats = _getStats(presetId, dayKey)
    stats.sent++
    stats.lastSentMs = nowMs
    _dailyStats.set(k, stats)
  }

  /**
   * Compute all gate booleans for a given nowMs + draft text.
   */
  function _computeGates(nowMs, draft) {
    const nowDate = new Date(nowMs)
    const tz      = cfg.timezone || 'Asia/Shanghai'
    const qh      = cfg.quietHours || { start: 22, end: 8 }
    const dayKey  = _dayKey(nowMs, tz)

    // Daily cap: find last sent across ALL presets for today
    // (Each preset has its own counter — cap is per-preset)
    // The caller passes presetId so we compute from stats later; this helper
    // takes presetId implicitly via closure. We'll compute inline in callers.
    const isQuietHours  = inQuietHours(nowDate, tz, qh)
    const phraseBlocked = cfg.forbiddenPhraseGuard
      ? hasForbiddenPhrase(draft || '', FORBIDDEN_PATTERNS)
      : false

    return { isQuietHours, phraseBlocked, dayKey, nowDate }
  }

  /**
   * Pick the send transport based on config.proactiveVia.
   */
  function _sendTransport() {
    if (cfg.proactiveVia === 'relay' && typeof d.sendViaRelay === 'function') {
      return d.sendViaRelay
    }
    if (typeof d.sendDirect === 'function') return d.sendDirect
    // No transport: no-op (log only)
    return async (presetId, text) => {
      logger.info('[proactive] (no transport) would send to %s: %s', presetId, (text || '').slice(0, 80))
    }
  }

  // --------------------------------------------------------------------------
  // maybeReachOut: handle a want_to_share from the roll loop
  // --------------------------------------------------------------------------

  /**
   * @param {string} presetId
   * @param {{ decision: 'now'|'later'|'no', draft?: string, target?: string, thought?: string, reason?: string, origin?: string, urgency?: string }} share
   * @param {number} [nowMs]  – timestamp override; defaults to Date.now()
   */
  async function maybeReachOut(presetId, share, nowMs) {
    const ts = typeof nowMs === 'number' ? nowMs : Date.now()

    if (!cfg.proactiveEnabled) {
      logger.debug('[proactive] %s: proactiveEnabled=false → skip', presetId)
      return
    }

    if (!share) return

    const tz     = cfg.timezone || 'Asia/Shanghai'
    const dayKey = _dayKey(ts, tz)
    const stats  = _getStats(presetId, dayKey)

    const { isQuietHours, phraseBlocked } = _computeGates(ts, share.draft)

    const gates = {
      proactiveEnabled:            !!cfg.proactiveEnabled,
      isQuietHours,
      quietHoursEnabled:           cfg.quietHoursEnabled !== false,
      underDailyCap:               passesDailyCap(stats.sent, cfg.proactiveDailyCap != null ? cfg.proactiveDailyCap : 2, cfg.dailyCapEnabled !== false),
      dailyCapEnabled:             cfg.dailyCapEnabled !== false,
      tooSoon:                     withinMinInterval(stats.lastSentMs, ts, cfg.proactiveMinIntervalHours != null ? cfg.proactiveMinIntervalHours : 4),
      phraseBlocked,
      forbiddenPhraseGuardEnabled: cfg.forbiddenPhraseGuard !== false,
    }

    const verdict = decideOutreach(share, gates)
    logger.debug('[proactive] %s: decision=%s → verdict=%s', presetId, share.decision, verdict)

    switch (verdict) {
      case 'drop':
      case 'disabled':
        // nothing to do
        return

      case 'park': {
        // Store in ThoughtBuffer for later surfacing
        if (d.thoughtBuffer && typeof d.thoughtBuffer.store === 'function') {
          await d.thoughtBuffer.store({
            presetId,
            content:  share.thought || share.draft || '',
            target:   share.target  || '审神者',
            origin:   share.origin  || 'want_to_share',
            urgency:  share.urgency || 'low',
            status:   'pending',
          })
        } else {
          logger.warn('[proactive] %s: later → no thoughtBuffer dep, thought lost', presetId)
        }
        return
      }

      case 'block-quiet':
        logger.info('[proactive] %s: blocked by quiet hours', presetId)
        return

      case 'block-cap':
        logger.info('[proactive] %s: blocked by daily cap (%d sent today)', presetId, stats.sent)
        return

      case 'block-interval':
        logger.info('[proactive] %s: blocked by min interval (lastSent=%s)', presetId, stats.lastSentMs)
        return

      case 'block-phrase':
        logger.warn('[proactive] %s: blocked by forbidden phrase guard; draft suppressed', presetId)
        return

      case 'send': {
        const text = share.draft || share.thought || ''
        if (!text) {
          logger.warn('[proactive] %s: verdict=send but draft is empty; skip', presetId)
          return
        }
        const transport = _sendTransport()
        try {
          await transport(presetId, text)
          _bumpStats(presetId, dayKey, ts)
          logger.info('[proactive] %s: sent (sent today: %d)', presetId, stats.sent)
        } catch (e) {
          logger.error('[proactive] %s: send failed: %s', presetId, e && e.message)
        }
        return
      }

      default:
        logger.warn('[proactive] %s: unknown verdict=%s', presetId, verdict)
    }
  }

  // --------------------------------------------------------------------------
  // maybeFollowUp: called by presence.onLingerEval (§5.13)
  // --------------------------------------------------------------------------

  /**
   * Persona-judged follow-up during LINGERING state.
   * Feeds the model "已追问N次 / 静默M分钟" and lets persona decide yes/no + draft.
   * If yes, runs the same send gate path as maybeReachOut (decision='now').
   *
   * @param {string} presetId
   * @param {number} [nowMs]  – timestamp override; defaults to Date.now()
   */
  async function maybeFollowUp(presetId, nowMs) {
    const ts = typeof nowMs === 'number' ? nowMs : Date.now()

    if (!cfg.proactiveEnabled) return

    // Gather silence state
    const silenceState = typeof d.silenceState === 'function'
      ? d.silenceState(presetId)
      : { silenceMinutes: 0, followUpCount: 0 }

    const silenceMinutes  = (silenceState && silenceState.silenceMinutes)  || 0
    const followUpCount   = (silenceState && silenceState.followUpCount)   || 0

    // Build persona judgment prompt
    const messages = [
      {
        role: 'system',
        content: [
          '你正在扮演一个刀剑男士（审神者旗下的刀男）。',
          '主人已经沉默了一段时间。',
          '请根据你的性格和当前情境，判断是否主动追问主人（"还在吗？""接着刚才的话头"之类）。',
          '禁止使用催促、挽留、情感勒索、FOMO、负罪诱导、追问施压等操控话术。',
          '只输出 JSON，格式：{"follow_up": true|false, "draft": "（如果follow_up=true，这里写你想说的话，否则留空字符串）"}',
        ].join('\n'),
      },
      {
        role: 'user',
        content: [
          `当前状况：`,
          `- 已追问次数：${followUpCount} 次`,
          `- 主人沉默时长：${silenceMinutes} 分钟`,
          `请判断是否再追问一次，并给出草稿（若追问）。`,
        ].join('\n'),
      },
    ]

    // Invoke model
    let modelResponse = null
    try {
      if (typeof d.getModel === 'function' && typeof d.invoke === 'function') {
        const model = await d.getModel(ctx, cfg.rollModel || 'ollama/qwen2.5:7b')
        modelResponse = await d.invoke(model, messages)
      } else {
        logger.warn('[proactive] %s: maybeFollowUp: no model deps, defaulting to no follow-up', presetId)
        // Default: go live without following up
        if (d.presence && typeof d.presence.goLive === 'function') {
          d.presence.goLive(presetId)
        }
        return
      }
    } catch (e) {
      logger.warn('[proactive] %s: maybeFollowUp: model error: %s; going live', presetId, e && e.message)
      if (d.presence && typeof d.presence.goLive === 'function') {
        d.presence.goLive(presetId)
      }
      return
    }

    // Parse response
    let followUp = false
    let draft    = ''
    try {
      // Try to extract JSON from model output
      const jsonMatch = String(modelResponse || '').match(/\{[\s\S]*\}/)
      if (jsonMatch) {
        const parsed = JSON.parse(jsonMatch[0])
        followUp = !!parsed.follow_up
        draft    = typeof parsed.draft === 'string' ? parsed.draft : ''
      }
    } catch (_) {
      // Parse failed → no follow-up
      followUp = false
    }

    if (!followUp || !draft) {
      logger.info('[proactive] %s: persona decided not to follow up; going live', presetId)
      if (d.presence && typeof d.presence.goLive === 'function') {
        d.presence.goLive(presetId)
      }
      return
    }

    // Persona wants to follow up — run through same gate path as maybeReachOut(decision='now')
    const share = {
      decision: 'now',
      draft,
      target:  '审神者',
      thought: draft,
      origin:  'lingering',
      urgency: 'low',
    }

    const tz     = cfg.timezone || 'Asia/Shanghai'
    const dayKey = _dayKey(ts, tz)
    const stats  = _getStats(presetId, dayKey)
    const { isQuietHours, phraseBlocked } = _computeGates(ts, draft)

    const gates = {
      proactiveEnabled:            !!cfg.proactiveEnabled,
      isQuietHours,
      quietHoursEnabled:           cfg.quietHoursEnabled !== false,
      underDailyCap:               passesDailyCap(stats.sent, cfg.proactiveDailyCap != null ? cfg.proactiveDailyCap : 2, cfg.dailyCapEnabled !== false),
      dailyCapEnabled:             cfg.dailyCapEnabled !== false,
      tooSoon:                     withinMinInterval(stats.lastSentMs, ts, cfg.proactiveMinIntervalHours != null ? cfg.proactiveMinIntervalHours : 4),
      phraseBlocked,
      forbiddenPhraseGuardEnabled: cfg.forbiddenPhraseGuard !== false,
    }

    const verdict = decideOutreach(share, gates)
    logger.debug('[proactive] %s: followUp verdict=%s', presetId, verdict)

    if (verdict === 'send') {
      const transport = _sendTransport()
      try {
        await transport(presetId, draft)
        _bumpStats(presetId, dayKey, ts)
        logger.info('[proactive] %s: follow-up sent (followUpCount was %d)', presetId, followUpCount)
      } catch (e) {
        logger.error('[proactive] %s: follow-up send failed: %s', presetId, e && e.message)
      }
      // After sending, remain in LINGERING (presence will re-arm timer); don't goLive
    } else {
      logger.info('[proactive] %s: follow-up blocked (%s); going live', presetId, verdict)
      if (d.presence && typeof d.presence.goLive === 'function') {
        d.presence.goLive(presetId)
      }
    }
  }

  return { maybeReachOut, maybeFollowUp }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // Pure helpers (exported for testing + composing)
  inQuietHours,
  passesDailyCap,
  withinMinInterval,
  hasForbiddenPhrase,
  decideOutreach,
  FORBIDDEN_PATTERNS,
  // Glue factory
  createProactiveBridge,
}
