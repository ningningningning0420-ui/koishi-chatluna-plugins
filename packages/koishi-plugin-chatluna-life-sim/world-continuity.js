'use strict'

// world-continuity.js — Task 5: 时空连续性约束
//
// 设计引用: §5.4c 时空连续性约束 / §5.4d 出本丸许可制
//
// Exports (pure logic, offline-testable):
//   continuityClamp(nextState, world) → {ok, clamped, reason}
//
// nextState shape:
//   { clock, location, duration? }
//   - clock: unix-ms of proposed new state
//   - location: proposed location string
//   - duration: how long this event takes (minutes) — used for travel validation
//
// world shape (WorldContext from world-context.js):
//   { clock, timeOfDay, season, weather, locations, externalLocations }
//   - clock: unix-ms of the last known world clock
//   - locations: string[] — allowed honmaru-internal locations
//   - externalLocations: string[] — pre-authorised external locations

// ---------------------------------------------------------------------------
// Internal helpers
// ---------------------------------------------------------------------------

// Default travel time in minutes when moving between two different locations.
// Kept intentionally simple for P1 (MVP: just need "some time"):
//   - Internal honmaru location change: minimum 5 minutes
//   - External (out of honmaru): minimum 15 minutes
const MIN_TRAVEL_INTERNAL_MIN = 5
const MIN_TRAVEL_EXTERNAL_MIN = 15

/**
 * Build the full set of allowed locations given a world context.
 * = honmaru internal locations ∪ pre-authorised external locations.
 *
 * @param {object} world – { locations, externalLocations }
 * @returns {Set<string>}
 */
function allowedLocationSet(world) {
  const w = world || {}
  const internal  = Array.isArray(w.locations)          ? w.locations          : []
  const external  = Array.isArray(w.externalLocations)  ? w.externalLocations  : []
  return new Set([...internal, ...external])
}

/**
 * Check whether a proposed location is an external (out-of-honmaru) one.
 * A location is external if it is NOT in the honmaru internal list.
 *
 * @param {string}  location
 * @param {object}  world
 * @returns {boolean}
 */
function isExternalLocation(location, world) {
  const w = world || {}
  const internal = new Set(Array.isArray(w.locations) ? w.locations : [])
  return !internal.has(location)
}

// ---------------------------------------------------------------------------
// continuityClamp — pure, offline-testable
// ---------------------------------------------------------------------------

/**
 * Validate and clamp a proposed next life-state against physical continuity rules.
 *
 * Rules enforced (§5.4c + §5.4d):
 *   1. Clock monotonicity: nextState.clock >= world.clock
 *      → if violated, clamp nextState.clock to world.clock.
 *   2. Location legality: nextState.location must be in
 *        world.locations ∪ world.externalLocations (the permitted set).
 *      → if violated, clamp to the first honmaru internal location (or '本丸·主屋').
 *   3. Travel time: if the location changes (new != "current location" which we
 *      approximate as a check against whether the event's duration covers the
 *      minimum travel time):
 *        - Internal move: nextState.duration >= MIN_TRAVEL_INTERNAL_MIN
 *        - External move: nextState.duration >= MIN_TRAVEL_EXTERNAL_MIN
 *      If duration is absent or 0, the constraint is not enforced (P1: optional
 *      duration field — only clamp when duration is explicitly provided and
 *      too short).
 *
 * NOTE on "current location": nextState does not carry the previous location.
 * The travel-time check fires only when `duration` is provided AND the location
 * is external (external moves reliably need ≥15 min).  For internal moves we
 * trust the caller to provide duration when they care; when absent we pass.
 *
 * Returns:
 *   { ok: true,  clamped: nextState }           — all good, no change needed
 *   { ok: false, clamped: fixedState, reason }  — one or more violations, with clamps applied
 *
 * `clamped` is always a safe copy — never mutates the input.
 *
 * @param {object} nextState – { clock, location, duration? }
 * @param {object} world     – WorldContext
 * @returns {{ ok: boolean, clamped: object, reason: string }}
 */
function continuityClamp(nextState, world) {
  const ns  = nextState || {}
  const w   = world || {}

  // Work on a shallow copy to avoid mutating caller's object
  let clamped = Object.assign({}, ns)

  const reasons = []
  let ok = true

  // ── Rule 1: Clock monotonicity ──────────────────────────────────────────
  const worldClock = typeof w.clock === 'number' ? w.clock : 0
  const nextClock  = typeof clamped.clock === 'number' ? clamped.clock : worldClock

  if (nextClock < worldClock) {
    reasons.push('时钟倒流:nextState.clock(' + nextClock + ') < world.clock(' + worldClock + '),已修正为 ' + worldClock)
    clamped.clock = worldClock
    ok = false
  }

  // ── Rule 2: Location legality ────────────────────────────────────────────
  const allowed = allowedLocationSet(w)
  const proposedLoc = clamped.location

  if (proposedLoc !== undefined && proposedLoc !== null) {
    if (!allowed.has(proposedLoc)) {
      // Clamp to the first internal location, or a hardcoded safe default
      const internalList = Array.isArray(w.locations) ? w.locations : []
      const safeLoc = internalList.length > 0 ? internalList[0] : '本丸·主屋'
      reasons.push(
        '非法地点:「' + proposedLoc + '」不在许可集内(本丸内部∪授权外部),已回退到「' + safeLoc + '」'
      )
      clamped.location = safeLoc
      ok = false
    }
  }

  // ── Rule 3: Travel time (external locations) ─────────────────────────────
  // Only enforce when the (possibly clamped) location is still external AND
  // duration was explicitly provided.
  const finalLoc = clamped.location
  const duration  = typeof clamped.duration === 'number' ? clamped.duration : null

  if (finalLoc !== undefined && finalLoc !== null && duration !== null) {
    const ext = isExternalLocation(finalLoc, w)
    const minTravel = ext ? MIN_TRAVEL_EXTERNAL_MIN : MIN_TRAVEL_INTERNAL_MIN

    if (duration < minTravel) {
      reasons.push(
        '移动时间不足:前往「' + finalLoc + '」需至少 ' + minTravel + ' 分钟,但 duration=' + duration + ' 分钟,已修正为 ' + minTravel
      )
      clamped.duration = minTravel
      ok = false
    }
  }

  return {
    ok,
    clamped,
    reason: reasons.join('; '),
  }
}

module.exports = {
  continuityClamp,
  allowedLocationSet,
  isExternalLocation,
  MIN_TRAVEL_INTERNAL_MIN,
  MIN_TRAVEL_EXTERNAL_MIN,
}
