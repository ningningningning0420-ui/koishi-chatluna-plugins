'use strict'

// presence.js — Task 3: PresenceState (WITH_USER / LINGERING / LIVING)
//
// Exports (pure logic, offline-testable):
//   nextPresenceState(current, event) → next state
//   derivePresenceKey(session) → string  (same key shape as chatluna-character _messages)
//
// Exports (koishi glue, not offline-tested):
//   createPresence(ctx, config, guard, logger) → { state, isLiving, onUserMessage, onLingerEval, goLive, dispose }
//
// Design refs: §5.13 陪主人↔过日子交接 / §5.11 单活动锁

// ---------------------------------------------------------------------------
// nextPresenceState — pure state machine (fully offline-testable)
// ---------------------------------------------------------------------------

/**
 * Derive the next presence state given the current state and an event.
 *
 * States:  'WITH_USER' | 'LINGERING' | 'LIVING'
 * Events:  'userMessage' | 'lingerTimeout' | 'goLive'
 *
 * Transition table (§5.13):
 *   any    + userMessage   → WITH_USER      (最高优先，抢占任何状态)
 *   WITH_USER + lingerTimeout → LINGERING   (主人静下来，进驻留窗口)
 *   LINGERING + lingerTimeout → LINGERING   (noop: already lingering)
 *   LIVING    + lingerTimeout → LIVING      (noop: no active convo)
 *   LINGERING + goLive     → LIVING         (驻留决定离开)
 *   WITH_USER + goLive     → LIVING         (force-go: Task 11 可以强制)
 *   LIVING    + goLive     → LIVING         (noop: already living)
 *   any       + <unknown>  → current        (defensive: unknown event is noop)
 *   undefined + userMessage → WITH_USER     (初始化: 默认 LIVING，用户消息强制到 WITH_USER)
 *
 * @param {'WITH_USER'|'LINGERING'|'LIVING'|undefined} current
 * @param {'userMessage'|'lingerTimeout'|'goLive'|string} event
 * @returns {'WITH_USER'|'LINGERING'|'LIVING'}
 */
function nextPresenceState(current, event) {
  // Normalize undefined/unknown → LIVING (default per §5.13)
  const s = current === 'WITH_USER' || current === 'LINGERING' ? current : 'LIVING'

  if (event === 'userMessage') return 'WITH_USER'

  if (event === 'lingerTimeout') {
    if (s === 'WITH_USER') return 'LINGERING'
    return s  // LINGERING → LINGERING (noop), LIVING → LIVING (noop)
  }

  if (event === 'goLive') {
    if (s === 'LIVING') return 'LIVING'  // noop
    return 'LIVING'  // LINGERING or WITH_USER → LIVING
  }

  // Unknown event → noop
  return s
}

// ---------------------------------------------------------------------------
// derivePresenceKey — pure session → string key (offline-testable)
// ---------------------------------------------------------------------------

/**
 * Derive a stable string key from a session object.
 * Matches the key shape used by chatluna-character's _messages store
 * and the buffer-backup plugin's deriveKey().
 *
 * private:userId   for DMs
 * group:guildId    for group chats (falls back to channelId if guildId is absent)
 *
 * @param {{isDirect:boolean, userId:string, guildId?:string, channelId?:string}} session
 * @returns {string}
 */
function derivePresenceKey(session) {
  if (session.isDirect) {
    return 'private:' + session.userId
  }
  const groupId = session.guildId != null ? session.guildId : session.channelId
  return 'group:' + groupId
}

// ---------------------------------------------------------------------------
// createPresence — koishi glue (not offline-tested)
// ---------------------------------------------------------------------------

/**
 * Create a PresenceState manager for one plugin instance.
 *
 * @param {object} ctx     – koishi context
 * @param {object} config  – plugin config (uses lingerWindowMin, presets, debug)
 * @param {object} guard   – shared ConcurrencyGuard instance (from createConcurrencyGuard())
 * @param {object} logger  – ctx.logger(...)
 * @returns {{
 *   state(presetId): 'WITH_USER'|'LINGERING'|'LIVING',
 *   isLiving(presetId): boolean,
 *   onUserMessage(session): void,
 *   onLingerEval(cb: (presetId:string)=>void): void,
 *   goLive(presetId: string): void,
 *   dispose(): void
 * }}
 */
function createPresence(ctx, config, guard, logger) {
  // Map<presetId, 'WITH_USER'|'LINGERING'|'LIVING'>
  const _states = new Map()

  // Map<presetId, disposerFn>  — active linger timer per preset
  const _lingerTimers = new Map()

  // Linger-eval callback (Task 11 registers this)
  let _lingerEvalCb = null

  // -------------------------------------------------------------------------
  // Pure helpers
  // -------------------------------------------------------------------------

  function _getState(presetId) {
    return _states.get(presetId) || 'LIVING'
  }

  function _setState(presetId, nextState) {
    const prev = _getState(presetId)
    _states.set(presetId, nextState)
    if (config && config.debug) {
      logger.info('[presence] %s: %s → %s', presetId, prev, nextState)
    }
  }

  // Clear any active linger timer for a preset
  function _clearLinger(presetId) {
    const disposer = _lingerTimers.get(presetId)
    if (disposer) {
      try { disposer() } catch (_) {}
      _lingerTimers.delete(presetId)
    }
  }

  // Arm (or re-arm) the in-memory linger timer for a preset.
  // ctx.setTimeout is in-memory; does NOT survive restart (§5.11 / §5.13: on restart resume as LIVING).
  function _armLinger(presetId) {
    _clearLinger(presetId)  // cancel any existing timer

    const lingerMs = ((config && config.lingerWindowMin) || 4) * 60 * 1000

    const disposer = ctx.setTimeout(() => {
      _lingerTimers.delete(presetId)
      _onLingerFired(presetId)
    }, lingerMs)

    _lingerTimers.set(presetId, disposer)
  }

  // Called when the linger timer fires (user was quiet for lingerWindowMin)
  function _onLingerFired(presetId) {
    const current = _getState(presetId)
    // Only transition if still WITH_USER; if user sent a message in the meantime,
    // state would have been set back to WITH_USER and timer re-armed, so this
    // only fires if no new message arrived.
    const next = nextPresenceState(current, 'lingerTimeout')
    _setState(presetId, next)

    if (next === 'LINGERING') {
      if (_lingerEvalCb) {
        // Invoke the Task 11 callback — it will call goLive() when ready
        try { _lingerEvalCb(presetId) } catch (e) {
          logger.warn('[presence] lingerEval callback threw for %s: %s', presetId, e && e.message)
          // Default: go live if callback errors
          goLive(presetId)
        }
      } else {
        // No callback registered: default to LIVING immediately
        goLive(presetId)
      }
    }
  }

  // -------------------------------------------------------------------------
  // Public API
  // -------------------------------------------------------------------------

  /**
   * Get the current presence state for a preset.
   * Defaults to 'LIVING' if not yet set (§5.13: default LIVING).
   */
  function state(presetId) {
    return _getState(presetId)
  }

  /**
   * Shorthand: is the preset currently in LIVING state?
   * Useful for roll-loop guard (LINGERING does not roll; §5.13 with-node协同).
   */
  function isLiving(presetId) {
    return _getState(presetId) === 'LIVING'
  }

  /**
   * Handle an incoming user message for a given preset.
   * Transitions to WITH_USER (any state → WITH_USER), acquires the 'withuser' lock
   * (releasing any prior hold), and re-arms the linger timer.
   *
   * Called by the message_collect subscriber; also exposed for manual call.
   *
   * @param {string} presetId
   */
  function _handleUserMessage(presetId) {
    // Re-arm linger timer (cancel old one)
    _armLinger(presetId)

    // Acquire lock: release any prior lock kind first, then acquire 'withuser'
    if (guard.current(presetId) !== 'withuser') {
      guard.release(presetId)
      guard.acquire(presetId, 'withuser')
    }

    const next = nextPresenceState(_getState(presetId), 'userMessage')
    _setState(presetId, next)
  }

  /**
   * Handle a raw session from chatluna_character/message_collect.
   * Derives presetId from config.presets (P1: single-preset, all user messages
   * belong to the one managed preset). For multi-preset, extend this.
   *
   * NOTE: The session does not directly carry a presetId. In P1 deployment,
   * config.presets has exactly one entry. We apply the event to ALL managed presets.
   * This is the right behavior: if this plugin manages "髭切", any user message
   * means "用户在跟髭切说话" regardless of which channel.
   *
   * @param {object} session – koishi session from message_collect
   */
  function onUserMessage(session) {
    const presets = (config && config.presets) || []
    for (const presetId of presets) {
      _handleUserMessage(presetId)
    }
  }

  /**
   * Register the linger-eval callback (Task 11 / ProactiveBridge registers this).
   * Called when linger timer fires: cb(presetId) → Task 11 decides whether to
   * follow up or call goLive(presetId).
   *
   * @param {function(presetId: string): void} cb
   */
  function onLingerEval(cb) {
    _lingerEvalCb = cb
  }

  /**
   * Transition a preset to LIVING (called by Task 11 after linger-eval decision).
   * Releases the 'withuser' lock.
   *
   * @param {string} presetId
   */
  function goLive(presetId) {
    _clearLinger(presetId)
    const next = nextPresenceState(_getState(presetId), 'goLive')
    _setState(presetId, next)
    guard.release(presetId)
  }

  /**
   * Dispose: clear all in-memory linger timers.
   * On next restart, all presets resume as LIVING (§5.13: in-memory timers only).
   */
  function dispose() {
    for (const [presetId] of _lingerTimers) {
      _clearLinger(presetId)
    }
    _lingerTimers.clear()
  }

  // -------------------------------------------------------------------------
  // Subscribe to chatluna_character/message_collect
  // -------------------------------------------------------------------------
  // ctx.on() returns a disposer; we hold it for dispose().
  const _messageDisposer = ctx.on('chatluna_character/message_collect', (session) => {
    try {
      onUserMessage(session)
    } catch (e) {
      logger.warn('[presence] message_collect handler error: %s', e && e.message)
    }
  })

  // -------------------------------------------------------------------------
  // Plugin dispose hook: also cancel the event subscription
  // -------------------------------------------------------------------------
  function disposeAll() {
    dispose()
    if (typeof _messageDisposer === 'function') {
      try { _messageDisposer() } catch (_) {}
    }
  }

  return {
    state,
    isLiving,
    onUserMessage,
    onLingerEval,
    goLive,
    dispose: disposeAll,
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  nextPresenceState,
  derivePresenceKey,
  createPresence,
}
