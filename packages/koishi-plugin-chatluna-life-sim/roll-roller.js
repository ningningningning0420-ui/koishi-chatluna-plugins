'use strict'

// roll-roller.js — Task 9: EventRoller (Act) — parse + sample + glue
//
// Pure functions (offline-testable, no runtime deps, NO new Date()):
//   parseRollResponse(text) → parsed roll output object
//   sampleCandidate(candidates, chosenIndex, r) → string | null
//
// Glue (needs koishi ctx + injected deps):
//   createRoller(ctx, config, deps) → { roll(presetId, nowMs), registerHandlers() }
//   gatherPersona(presetId, ctx, config) → Promise<string>
//
// Design refs: §5.1 (JSON schema) / §5.11 (单活动锁) / §5.12 (nextWake) / §6.3 (护栏)

const { buildRollPrompt } = require('./roll-prompt')
const { fallbackRoll } = require('./roll-fallback')

// ---------------------------------------------------------------------------
// REQUIRED_EVENT_FIELDS — minimum valid event fields
// ---------------------------------------------------------------------------
const REQUIRED_EVENT_FIELDS = ['title', 'narrative', 'event_type']

// ---------------------------------------------------------------------------
// _extractJson — extract the first JSON object or array from text
// (handles model that wraps JSON in prose or markdown code blocks)
// ---------------------------------------------------------------------------

/**
 * Extract the first JSON object from arbitrary text.
 * Strips ```json ... ``` code fences if present.
 * Returns parsed object or null on failure.
 *
 * @param {string} text
 * @returns {object|null}
 */
function _extractJson(text) {
  if (!text || typeof text !== 'string') return null

  // Strip markdown code fences
  let cleaned = text
    .replace(/```json\s*/gi, '')
    .replace(/```\s*/g, '')
    .trim()

  // Find the first '{' and matching '}'
  const start = cleaned.indexOf('{')
  if (start === -1) return null

  // Walk to find balanced closing brace
  let depth = 0
  let end = -1
  for (let i = start; i < cleaned.length; i++) {
    if (cleaned[i] === '{') depth++
    else if (cleaned[i] === '}') {
      depth--
      if (depth === 0) {
        end = i
        break
      }
    }
  }

  if (end === -1) return null

  try {
    return JSON.parse(cleaned.slice(start, end + 1))
  } catch (_) {
    return null
  }
}

// ---------------------------------------------------------------------------
// _defaultEvent — minimal valid event for fallback-within-parse
// ---------------------------------------------------------------------------
function _defaultEvent(overrides) {
  return Object.assign({
    title: '本丸一隅',
    narrative: '在本丸里度过了一段时光。',
    event_type: '思绪',
    location: '本丸·主屋',
    participants: [],
    mood: 'neutral',
    duration_minutes: 30,
    importance: 0.2,
    threads_touched: [],
    type: 'context',
  }, overrides || {})
}

// ---------------------------------------------------------------------------
// parseRollResponse — pure, offline-testable, NO new Date()
// ---------------------------------------------------------------------------

/**
 * Parse the model's text response into a structured roll output.
 *
 * Validates and defaults all fields per §5.1 schema:
 *   candidates        → string[] (defaults to [])
 *   chosen_index      → number (defaults to 0)
 *   event             → object (needs at least title/narrative/event_type)
 *   plan_adherence    → 'followed'|'deviated'|'interrupted'|'free' (defaults 'free')
 *   replan_hint       → string (defaults '')
 *   want_to_share     → object with decision/target/reason/draft/thought
 *   next_state        → object (partial life-state patch)
 *   next_delay_minutes → number (clamped to [10, 240], defaults 60)
 *
 * Never throws; always returns a usable object.
 * Sets _parseOk=false when text was garbage/missing required fields.
 *
 * @param {string} text  Raw model output text (may contain prose wrapping JSON)
 * @returns {object}     Structured roll output
 */
function parseRollResponse(text) {
  const raw = _extractJson(text)

  // ── Defaults ──────────────────────────────────────────────────────────────
  const out = {
    candidates: [],
    chosen_index: 0,
    event: _defaultEvent(),
    plan_adherence: 'free',
    replan_hint: '',
    want_to_share: {
      decision: 'no',
      target: '审神者',
      reason: '',
      draft: '',
      thought: '',
    },
    next_state: {},
    next_delay_minutes: 60,
    _parseOk: false,
    _parseError: null,
  }

  if (!raw) {
    out._parseError = 'no valid JSON object found in response'
    return out
  }

  // ── candidates ────────────────────────────────────────────────────────────
  if (Array.isArray(raw.candidates)) {
    out.candidates = raw.candidates.filter((c) => typeof c === 'string')
  }

  // ── chosen_index ──────────────────────────────────────────────────────────
  if (typeof raw.chosen_index === 'number' && Number.isFinite(raw.chosen_index)) {
    out.chosen_index = Math.max(0, Math.floor(raw.chosen_index))
  }

  // ── event ─────────────────────────────────────────────────────────────────
  if (raw.event && typeof raw.event === 'object') {
    const ev = raw.event
    // Check required fields
    const hasRequired = REQUIRED_EVENT_FIELDS.every((f) => ev[f] && typeof ev[f] === 'string' && ev[f].trim())

    if (hasRequired) {
      const parsedEvent = {
        title: String(ev.title).slice(0, 50),
        narrative: String(ev.narrative).slice(0, 400),
        event_type: String(ev.event_type),
        location: typeof ev.location === 'string' ? ev.location : '本丸·主屋',
        participants: Array.isArray(ev.participants) ? ev.participants.filter((p) => typeof p === 'string') : [],
        mood: typeof ev.mood === 'string' ? ev.mood : 'neutral',
        duration_minutes: (typeof ev.duration_minutes === 'number' && Number.isFinite(ev.duration_minutes))
          ? Math.max(5, Math.min(ev.duration_minutes, 480))
          : 30,
        importance: (typeof ev.importance === 'number' && Number.isFinite(ev.importance))
          ? Math.max(0, Math.min(ev.importance, 1))
          : 0.2,
        threads_touched: Array.isArray(ev.threads_touched) ? ev.threads_touched.filter((t) => typeof t === 'string') : [],
        type: typeof ev.type === 'string' ? ev.type : 'context',
      }
      out.event = parsedEvent
    } else {
      // Partial event — fill defaults for missing required fields
      out.event = _defaultEvent({
        title: (ev.title && typeof ev.title === 'string') ? String(ev.title).slice(0, 50) : undefined,
        narrative: (ev.narrative && typeof ev.narrative === 'string') ? String(ev.narrative).slice(0, 400) : undefined,
        event_type: (ev.event_type && typeof ev.event_type === 'string') ? String(ev.event_type) : undefined,
        location: typeof ev.location === 'string' ? ev.location : undefined,
        mood: typeof ev.mood === 'string' ? ev.mood : undefined,
      })
      out._parseError = 'event missing required fields: ' + REQUIRED_EVENT_FIELDS.filter((f) => !ev[f]).join(', ')
      return out
    }
  } else {
    out._parseError = 'event field missing or not an object'
    return out
  }

  // ── plan_adherence ────────────────────────────────────────────────────────
  const VALID_ADHERENCES = ['followed', 'deviated', 'interrupted', 'free']
  if (typeof raw.plan_adherence === 'string' && VALID_ADHERENCES.includes(raw.plan_adherence)) {
    out.plan_adherence = raw.plan_adherence
  }

  // ── replan_hint ───────────────────────────────────────────────────────────
  if (typeof raw.replan_hint === 'string') {
    out.replan_hint = raw.replan_hint.slice(0, 200)
  }

  // ── want_to_share ─────────────────────────────────────────────────────────
  const VALID_DECISIONS = ['now', 'later', 'no']
  if (raw.want_to_share && typeof raw.want_to_share === 'object') {
    const ws = raw.want_to_share
    out.want_to_share = {
      decision: (typeof ws.decision === 'string' && VALID_DECISIONS.includes(ws.decision))
        ? ws.decision : 'no',
      target: typeof ws.target === 'string' ? ws.target : '审神者',
      reason: typeof ws.reason === 'string' ? ws.reason.slice(0, 200) : '',
      draft: typeof ws.draft === 'string' ? ws.draft.slice(0, 500) : '',
      thought: typeof ws.thought === 'string' ? ws.thought.slice(0, 300) : '',
    }
  }

  // ── next_state ────────────────────────────────────────────────────────────
  if (raw.next_state && typeof raw.next_state === 'object') {
    const ns = raw.next_state
    const nextState = {}
    if (typeof ns.location === 'string') nextState.location = ns.location
    if (typeof ns.current_activity === 'string') nextState.current_activity = ns.current_activity
    if (typeof ns.mood === 'string') nextState.mood = ns.mood
    if (Array.isArray(ns.open_threads)) nextState.open_threads = ns.open_threads
    out.next_state = nextState
  }

  // ── next_delay_minutes ────────────────────────────────────────────────────
  if (typeof raw.next_delay_minutes === 'number' && Number.isFinite(raw.next_delay_minutes)) {
    out.next_delay_minutes = Math.max(10, Math.min(Math.round(raw.next_delay_minutes), 240))
  }

  out._parseOk = true
  return out
}

// ---------------------------------------------------------------------------
// sampleCandidate — pure, offline-testable, NO new Date()
// ---------------------------------------------------------------------------

/**
 * Program-side candidate selection.
 *
 * Does NOT blindly trust chosen_index (model may hallucinate an out-of-range
 * index). Uses injected r ∈ [0,1) for determinism.
 *
 * Selection logic (P1: uniform random; chosenIndex is advisory):
 *   - If candidates is empty → return null
 *   - If candidates has one element → return it
 *   - Use r to pick uniformly (ignoring chosenIndex in the random path)
 *   - chosenIndex acts as tie-breaker / hint but does not force the choice
 *
 * For P1 simplicity: use r directly for uniform sampling. chosenIndex is
 * recorded in the return value so downstream can see what model preferred.
 *
 * @param {string[]} candidates    Array of candidate beat strings
 * @param {number}   chosenIndex   Model's preferred index (advisory)
 * @param {number}   [r]           Random value ∈ [0,1); defaults to Math.random()
 * @returns {{ text: string, idx: number } | null}
 */
function sampleCandidate(candidates, chosenIndex, r) {
  if (!Array.isArray(candidates) || candidates.length === 0) return null

  const rng = (typeof r === 'number' && r >= 0 && r < 1) ? r : Math.random()

  // Uniform pick
  const idx = Math.floor(rng * candidates.length)
  // Clamp to valid range (safety)
  const safeIdx = Math.min(idx, candidates.length - 1)

  return {
    text: candidates[safeIdx],
    idx: safeIdx,
    modelHint: typeof chosenIndex === 'number' ? Math.max(0, Math.min(Math.floor(chosenIndex), candidates.length - 1)) : 0,
  }
}

// ---------------------------------------------------------------------------
// gatherPersona — async helper (uses ctx, not offline-tested per se, but
// designed to work with fake ctx for the roller glue test)
// ---------------------------------------------------------------------------

/**
 * Gather the persona canon string for a presetId.
 *
 * Priority:
 * 1. If ctx has a chatluna_worldbook service with a query method, query it
 *    for purpose:'persona' entries and return their content joined.
 * 2. If config.worldbooks is an array, find the first entry with purpose='persona'
 *    and attempt to load it from the file system (only in runtime, not offline).
 * 3. Fall back to a minimal default persona string.
 *
 * @param {string} presetId
 * @param {object} ctx        Koishi context (may be a fake ctx in tests)
 * @param {object} config     Plugin config
 * @returns {Promise<string>}
 */
async function gatherPersona(presetId, ctx, config) {
  // Try worldbook service (Task 7 worldbook plugin)
  try {
    if (ctx && ctx.chatluna_worldbook && typeof ctx.chatluna_worldbook.query === 'function') {
      const entries = await ctx.chatluna_worldbook.query({ purpose: 'persona', presetId })
      if (Array.isArray(entries) && entries.length > 0) {
        return entries
          .map((e) => (typeof e.content === 'string' ? e.content : (e.entry || '')))
          .filter(Boolean)
          .join('\n\n')
      }
    }
  } catch (_) {
    // worldbook unavailable — fall through
  }

  // Try loading from config.worldbooks persona file (runtime only — skipped in offline tests)
  if (config && Array.isArray(config.worldbooks)) {
    const personaBook = config.worldbooks.find((b) => b.purpose === 'persona')
    if (personaBook && personaBook.path) {
      try {
        const fs = require('fs')
        const path = require('path')
        const fullPath = path.isAbsolute(personaBook.path)
          ? personaBook.path
          : path.resolve(
            (ctx && ctx.loader && ctx.loader.baseDir) || process.cwd(),
            personaBook.path
          )
        const raw = fs.readFileSync(fullPath, 'utf8')
        const json = JSON.parse(raw)
        const entries = Array.isArray(json) ? json : (json.entries || [])
        if (entries.length > 0) {
          return entries
            .map((e) => (typeof e.content === 'string' ? e.content : ''))
            .filter(Boolean)
            .join('\n\n')
        }
      } catch (_) {
        // file not found or parse error — fall through
      }
    }
  }

  // Default persona string
  return presetId
    ? '角色：' + presetId + '（人设文件未加载，请按角色一贯人格行事）'
    : '（角色人设未加载，请按角色一贯人格行事）'
}

// ---------------------------------------------------------------------------
// createRoller — glue factory (needs koishi ctx + injected deps)
// ---------------------------------------------------------------------------

/**
 * Create the EventRoller instance.
 *
 * @param {object} ctx    Koishi context
 * @param {object} config Plugin config (rollModel, fallbackToTemplate, dryRun,
 *                        stmMax, defaultNextDelayMin, debug, ...)
 * @param {object} deps   Injected dependencies:
 *   {
 *     getWorld(presetId)             → Promise<WorldContext>
 *     available(world, lifeState)    → [{type, weight}]      (EventRegistry.available)
 *     getState(presetId)             → Promise<lifeState>    (LifeStateStore.getState)
 *     setState(presetId, patch)      → Promise               (LifeStateStore.setState)
 *     recent(presetId, n)            → Promise<events[]>     (ShortTermMemory.recent)
 *     appendEvent(presetId, event)   → Promise               (ShortTermMemory.appendEvent)
 *     getModel(modelName)            → Promise<model|null>   (model.js getModel, already ctx-bound)
 *     invoke(model, msgs, opts)      → Promise<string>       (model.js invoke)
 *     continuityClamp(next, world)   → {ok, clamped, reason} (world-continuity.js)
 *     scheduler: {
 *       scheduleTask(presetId, fireAt, type, payload) → Promise<number>
 *       registerHandler(type, fn)   → void
 *     }
 *     guard: {
 *       acquire(presetId, kind)      → boolean
 *       release(presetId)            → void
 *       current(presetId)            → string|null
 *     }
 *     presence: {
 *       isLiving(presetId)           → boolean
 *     }
 *     planner: {
 *       currentBlockNow(presetId, nowMs) → Promise<block|null>
 *       blocksForToday(presetId, nowMs)  → Promise<blocks[]>
 *       scheduleBlockWakes(presetId, plan) → Promise<void>
 *       getPlan(presetId, day)           → Promise<plan|null>
 *     }
 *     gatherPersona(presetId)        → Promise<string>       (can override default)
 *     onShare(presetId, wantToShare) → void|Promise          (Task 11 ProactiveBridge hook)
 *     silenceState(presetId)         → object                ({unansweredCount, lastMessageAgoMin, ...})
 *   }
 *
 * @returns {{ roll(presetId, nowMs): Promise<object|undefined>, registerHandlers(): void }}
 */
function createRoller(ctx, config, deps) {
  const logger = ctx && ctx.logger
    ? ctx.logger('life-sim:roller')
    : { info: () => {}, warn: console.warn.bind(console), debug: () => {} }

  const cfg = config || {}
  const d = deps || {}

  // ── Internal: _msToDay ───────────────────────────────────────────────────
  function _msToDay(ms) {
    const tz = cfg.timezone || 'Asia/Shanghai'
    const fmt = new Intl.DateTimeFormat('en-CA', {
      timeZone: tz,
      year: 'numeric', month: '2-digit', day: '2-digit',
    })
    return fmt.format(new Date(ms))
  }

  // ── roll(presetId, nowMs) ────────────────────────────────────────────────
  /**
   * Execute one roll cycle for a preset.
   *
   * Returns a result summary on completion (same shape for dryRun and normal
   * path, §6.3): { event, next_delay_minutes, wake_ms, used_fallback, dry_run,
   * clamped }. Returns undefined when the roll was skipped (not LIVING, guard
   * busy, or model unavailable with fallbackToTemplate=false).
   *
   * @param {string} presetId
   * @param {number} nowMs    Current unix-ms (caller supplies; no internal Date.now() for logic)
   * @returns {Promise<object|undefined>}
   */
  async function roll(presetId, nowMs) {
    const now = nowMs != null ? nowMs : Date.now()

    // ── Step 1: Guard — presence + single-activity lock ────────────────────
    if (d.presence && !d.presence.isLiving(presetId)) {
      logger.info('[roller] %s is not LIVING (presence=%s) — skip roll',
        presetId, d.presence.state ? d.presence.state(presetId) : '?')
      return
    }

    if (d.guard && !d.guard.acquire(presetId, 'roll')) {
      logger.info('[roller] %s is busy (%s) — skip roll', presetId, d.guard.current(presetId))
      return
    }

    try {
      return await _doRoll(presetId, now)
    } finally {
      if (d.guard) d.guard.release(presetId)
    }
  }

  // ── _doRoll — inner logic, runs inside guard ───────────────────────────
  async function _doRoll(presetId, now) {
    // ── Step 2: Gather context ─────────────────────────────────────────────
    const [persona, state, world] = await Promise.all([
      _safeCall(() => (d.gatherPersona ? d.gatherPersona(presetId) : gatherPersona(presetId, ctx, cfg)), ''),
      _safeCall(() => d.getState(presetId), {}),
      _safeCall(() => d.getWorld(presetId), {}),
    ])

    const block = await _safeCall(() => d.planner && d.planner.currentBlockNow(presetId, now), null)
    const types = (d.available ? d.available(world, state) : [])
    const recentEvents = await _safeCall(() => d.recent(presetId, cfg.stmMax || 8), [])
    const silence = (d.silenceState ? d.silenceState(presetId) : {})

    // ── Step 3: dryRun flag — §6.3 (review 修正) ──────────────────────────
    // dry-run = 照常调模型 + 解析 + 连续性 clamp，只 log 解析结果摘要，
    // 跳过一切 sim 数据写入（event/state/thought）与外发（onShare 路由）；
    // 自循环照常续排（调度任务表属运维数据）。只有真调模型、连滚多轮，
    // 才看得出 roll 质量/节奏/漂移——这才配得上"调参"用途。
    const isDryRun = !!cfg.dryRun

    // ── Step 4: Model call or fallback ─────────────────────────────────────
    let parsed = null
    let usedFallback = false

    try {
      const model = await _safeCall(() => d.getModel && d.getModel(cfg.rollModel), null)

      if (!model) {
        if (cfg.fallbackToTemplate !== false) {
          logger.warn('[roller] %s: model unavailable — fallback to template', presetId)
          usedFallback = true
        } else {
          logger.warn('[roller] %s: model unavailable and fallbackToTemplate=false — skip', presetId)
          return
        }
      } else {
        const msgs = buildRollPrompt({ persona, lifeState: state, world, block, availableTypes: types, recentEvents, silenceState: silence })
        const text = await _safeCall(() => d.invoke(model, msgs, {}), null)

        if (text) {
          parsed = parseRollResponse(text)
          if (!parsed._parseOk && cfg.fallbackToTemplate !== false) {
            logger.warn('[roller] %s: parse failed (%s) — fallback to template', presetId, parsed._parseError)
            usedFallback = true
            parsed = null
          } else if (!parsed._parseOk) {
            logger.warn('[roller] %s: parse failed (%s) and fallbackToTemplate=false — skip', presetId, parsed._parseError)
            return
          }
        } else {
          if (cfg.fallbackToTemplate !== false) {
            usedFallback = true
          } else {
            return
          }
        }
      }
    } catch (err) {
      logger.warn('[roller] %s: model/invoke error: %s', presetId, err && err.message)
      if (cfg.fallbackToTemplate !== false) {
        usedFallback = true
      } else {
        return
      }
    }

    // ── Step 5: Resolve event from candidates or fallback ─────────────────
    let event
    let nextDelayMinutes = cfg.defaultNextDelayMin || 60
    let nextStatePatch = {}
    let wantToShare = { decision: 'no', target: '审神者', reason: '', draft: '', thought: '' }

    if (usedFallback || !parsed) {
      event = fallbackRoll(types, world, state)
      // Use default next delay
    } else {
      // Sample from candidates (program-side, do not blindly use chosen_index)
      const sampled = sampleCandidate(parsed.candidates, parsed.chosen_index)
      // The event is the structured object from the model; candidates are advisory text
      // The chosen beat from candidates matches event.title roughly — trust the event object
      event = parsed.event
      // If candidates were produced, note which was picked
      if (sampled) {
        event._sampledCandidate = sampled.text
        event._sampledIdx = sampled.idx
      }

      nextDelayMinutes = parsed.next_delay_minutes || (cfg.defaultNextDelayMin || 60)
      nextStatePatch = parsed.next_state || {}
      wantToShare = parsed.want_to_share || wantToShare
    }

    // ── Step 6: Continuity clamp ───────────────────────────────────────────
    const clampInput = Object.assign({}, nextStatePatch, {
      clock: now + (event.duration_minutes || 30) * 60000,
      location: nextStatePatch.location || event.location || state.location,
    })

    let clampedState = nextStatePatch
    let clampApplied = false
    if (d.continuityClamp) {
      const { ok, clamped, reason } = d.continuityClamp(clampInput, world)
      clampedState = clamped
      if (!ok) {
        clampApplied = true
        logger.warn('[roller] %s: continuity clamp applied — %s', presetId, reason)
      }
    }

    // ── Step 7: Persist event + state（dryRun 只 log 解析摘要，不写库）─────
    const eventRow = Object.assign({}, event, {
      plan_adherence: (parsed && parsed.plan_adherence) || 'free',
      importance: event.importance || 0.2,
      consolidated: false,
    })

    if (isDryRun) {
      logger.info(
        '[roller:dryRun] %s | event="%s" type=%s adherence=%s share=%s next_delay=%dmin clamped=%s fallback=%s',
        presetId, event.title, event.event_type, eventRow.plan_adherence,
        wantToShare.decision, nextDelayMinutes, clampApplied, usedFallback
      )
    } else {
      await _safeCall(() => d.appendEvent(presetId, eventRow), null)
      await _safeCall(() => d.setState(presetId, clampedState), null)
    }

    // ── Step 8: onShare hook (Task 11, default no-op) ─────────────────────
    // dryRun 跳过：不进 ProactiveBridge / 心事簿（ThoughtBuffer 写入挂在这条路由后面）。
    if (d.onShare && !isDryRun) {
      try {
        await d.onShare(presetId, wantToShare)
      } catch (e) {
        logger.warn('[roller] %s: onShare hook threw: %s', presetId, e && e.message)
      }
    }

    // ── Step 9: Schedule next wake (§5.12) ────────────────────────────────
    const { nextWake } = require('./schedule-planner')

    const nextDelayMs = now + nextDelayMinutes * 60000
    const curBlockEndMs = block ? block.end : null
    // nextTimedStartMs: first future assignment start from today's plan (optional)
    // For P1: we pass null — planner.blocksForToday/plan can be wired by Task 14
    const nextTimedStartMs = null

    const rawWake = nextWake(nextDelayMs, curBlockEndMs, nextTimedStartMs)
    const wakeMs = rawWake != null ? rawWake : (now + (cfg.defaultNextDelayMin || 60) * 60000)

    if (d.scheduler) {
      try {
        await d.scheduler.scheduleTask(presetId, new Date(wakeMs), 'roll')
      } catch (e) {
        logger.warn('[roller] %s: scheduleTask(roll) failed: %s', presetId, e && e.message)
      }
    }

    // ── Step 10: (Re-)schedule block wakes ───────────────────────────────
    // Clear existing pending block tasks first (contract: NOT idempotent)
    if (ctx && ctx.database) {
      try {
        await ctx.database.remove('life_sim_task', { presetId, type: 'block', status: 'pending' })
      } catch (e) {
        logger.warn('[roller] %s: clearing pending block tasks failed: %s', presetId, e && e.message)
      }
    }

    if (d.planner && d.scheduler) {
      const day = _msToDay(now)
      const plan = await _safeCall(() => d.planner.getPlan && d.planner.getPlan(presetId, day), null)
      if (plan) {
        try {
          await d.planner.scheduleBlockWakes(presetId, plan)
        } catch (e) {
          logger.warn('[roller] %s: scheduleBlockWakes failed: %s', presetId, e && e.message)
        }
      }
    }

    if (cfg.debug) {
      logger.info('[roller] %s: roll done — event="%s" type=%s nextWake=%s',
        presetId, event.title, event.event_type, new Date(wakeMs).toISOString())
    }

    // ── Result summary — dryRun 与正常路径结构一致（§6.3）─────────────────
    return {
      event: eventRow,
      next_delay_minutes: nextDelayMinutes,
      wake_ms: wakeMs,
      used_fallback: usedFallback,
      dry_run: isDryRun,
      clamped: clampApplied,
    }
  }

  // ── registerHandlers() ───────────────────────────────────────────────────
  /**
   * Register scheduler handlers for 'roll' and 'block' task types.
   * Call this once during plugin ready.
   */
  function registerHandlers() {
    if (!d.scheduler) return

    // 'roll' handler: fire roll cycle
    d.scheduler.registerHandler('roll', async (presetId, type, payload, task) => {
      await roll(presetId, Date.now())
    })

    // 'block' handler: on block boundary, update life-state to the new block's activity
    d.scheduler.registerHandler('block', async (presetId, type, payload, task) => {
      if (!payload) return
      const { blockLabel, activity, source } = payload
      logger.info('[roller] %s: block boundary — %s (%s)', presetId, blockLabel, activity || '')

      // Update life-state to new block
      if (d.setState && activity) {
        await _safeCall(() => d.setState(presetId, {
          current_activity: activity,
        }), null)
      }

      // If it's a routine block, trigger a roll in the new block context
      if (source === 'routine' || source === 'assigned') {
        await roll(presetId, Date.now())
      }
    })
  }

  return { roll, registerHandlers }
}

// ---------------------------------------------------------------------------
// Internal: _safeCall — run fn, return fallback on error (no throw)
// ---------------------------------------------------------------------------

async function _safeCall(fn, fallback) {
  try {
    const result = await fn()
    return result != null ? result : fallback
  } catch (_) {
    return fallback
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // Pure functions (offline-testable)
  parseRollResponse,
  sampleCandidate,
  // Async helper (used by glue; also exported for index.js Task 14)
  gatherPersona,
  // Glue factory
  createRoller,
  // Internal (exported for testing)
  _extractJson,
}
