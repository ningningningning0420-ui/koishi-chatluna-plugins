'use strict'

// world-context.js — Task 4: WorldContext（时钟=现实时间 + 天气 markov + 季节）
//
// Exports (pure logic, offline-testable):
//   seasonOf(date, timezone)  → '春'|'夏'|'秋'|'冬'
//   timeOfDayOf(date, timezone) → '清晨'|'上午'|'午后'|'黄昏'|'夜'|'深夜'
//   tickWeather(prev, adjacencyTable, pickIndex?) → nextWeather  (Markov step)
//   advanceWeather(prev, lastTickMs, now, tickHours, table, pick?) → {weather, ticks, newLastTickMs}
//   DEFAULT_ADJACENCY  — the canonical weather adjacency table
//
// Exports (DB glue, needs koishi ctx):
//   createWorld(ctx, config) → { getWorld(presetId) }
//
// Design refs: §5.4 WorldContext / §5.4c 天气 markov 相邻转移 / §5.11 时间=现实时间

// ---------------------------------------------------------------------------
// seasonOf — pure function, offline-testable
// ---------------------------------------------------------------------------

/**
 * Derive the season for a given real-world Date in the specified IANA timezone.
 * Month mapping (calendar seasons, Japanese Honmaru flavour):
 *   3, 4, 5   → '春'
 *   6, 7, 8   → '夏'
 *   9, 10, 11 → '秋'
 *   12, 1, 2  → '冬'
 *
 * Uses Intl.DateTimeFormat to read the month in the target timezone so that a
 * date near midnight doesn't bleed into the wrong calendar day.
 *
 * @param {Date}   date
 * @param {string} timezone  IANA tz string, e.g. 'Asia/Shanghai'
 * @returns {'春'|'夏'|'秋'|'冬'}
 */
function seasonOf(date, timezone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone || 'Asia/Shanghai',
    month: 'numeric',
  })
  const month = parseInt(fmt.format(date), 10)  // 1–12

  if (month >= 3 && month <= 5)  return '春'
  if (month >= 6 && month <= 8)  return '夏'
  if (month >= 9 && month <= 11) return '秋'
  return '冬'  // 12, 1, 2
}

// ---------------------------------------------------------------------------
// timeOfDayOf — pure function, offline-testable
// ---------------------------------------------------------------------------

/**
 * Derive the Japanese time-of-day label for a real-world Date in the specified
 * IANA timezone.
 *
 * Hour ranges (24h, inclusive start / exclusive end):
 *   [5,  7)  → '清晨'
 *   [7,  12) → '上午'
 *   [12, 17) → '午后'
 *   [17, 19) → '黄昏'
 *   [19, 23) → '夜'
 *   [23, 24) and [0, 5) → '深夜'
 *
 * Uses Intl.DateTimeFormat with hour12:false to read the local hour.
 *
 * @param {Date}   date
 * @param {string} timezone  IANA tz string
 * @returns {'清晨'|'上午'|'午后'|'黄昏'|'夜'|'深夜'}
 */
function timeOfDayOf(date, timezone) {
  const fmt = new Intl.DateTimeFormat('en-US', {
    timeZone: timezone || 'Asia/Shanghai',
    hour: 'numeric',
    hour12: false,
  })
  // Intl may return '24' for midnight in some environments; normalise to 0.
  let hour = parseInt(fmt.format(date), 10)
  if (hour === 24) hour = 0

  if (hour >= 5  && hour < 7)  return '清晨'
  if (hour >= 7  && hour < 12) return '上午'
  if (hour >= 12 && hour < 17) return '午后'
  if (hour >= 17 && hour < 19) return '黄昏'
  if (hour >= 19 && hour < 23) return '夜'
  return '深夜'  // 23, 0–4
}

// ---------------------------------------------------------------------------
// DEFAULT_ADJACENCY — weather adjacency table (§5.4c 禁跳变)
// ---------------------------------------------------------------------------

/**
 * Canonical adjacency table.  Each key maps to the array of weather states it
 * may transition into (including itself = "stay").  Transitions are symmetric
 * along the chain:
 *
 *   晴 ↔ 多云 ↔ 阴 ↔ 雨 ↔ 雪
 *
 * A state may always stay (self-loop) so weather can persist.
 *
 * This is the *structure* that enforces §5.4c: no jump from 晴 to 暴雪, etc.
 */
const DEFAULT_ADJACENCY = {
  '晴':  ['晴',  '多云'],
  '多云': ['晴',  '多云', '阴'],
  '阴':  ['多云', '阴',  '雨', '雪'],
  '雨':  ['阴',  '雨',  '多云'],
  '雪':  ['阴',  '雪'],
}

// ---------------------------------------------------------------------------
// tickWeather — pure Markov step, offline-testable
// ---------------------------------------------------------------------------

/**
 * Advance weather one Markov tick using the provided adjacency table.
 *
 * For deterministic testing, pass pickIndex (an integer index into the
 * neighbours array).  When omitted, a random neighbour is chosen.
 *
 * @param {string}  prev            – current weather label
 * @param {Object}  adjacencyTable  – e.g. DEFAULT_ADJACENCY
 * @param {number}  [pickIndex]     – optional fixed index into neighbours (for tests)
 * @returns {string} next weather label (always adjacent — never a jump)
 */
function tickWeather(prev, adjacencyTable, pickIndex) {
  const neighbours = adjacencyTable[prev]
  if (!neighbours || neighbours.length === 0) {
    // Unknown state: stay put rather than crash
    return prev
  }
  let idx
  if (typeof pickIndex === 'number') {
    // Clamp to valid range (mod, so -1 wraps nicely too)
    idx = ((pickIndex % neighbours.length) + neighbours.length) % neighbours.length
  } else {
    idx = Math.floor(Math.random() * neighbours.length)
  }
  return neighbours[idx]
}

// ---------------------------------------------------------------------------
// advanceWeather — pure multi-step advance, offline-testable
// ---------------------------------------------------------------------------

/**
 * Advance weather by as many ticks as `(now - lastTickMs) / tickHours` permits,
 * each step constrained to the adjacency table.
 *
 * @param {string}  prev         – current weather label
 * @param {number}  lastTickMs   – unix-ms of the last weather tick
 * @param {number}  now          – unix-ms of "now"
 * @param {number}  tickHours    – hours between ticks (e.g. 6)
 * @param {Object}  table        – adjacency table (default: DEFAULT_ADJACENCY)
 * @param {Function|number} [pick] – optional: number (fixed pickIndex per step) or
 *                                   function(neighbours) → chosen state (for tests)
 * @returns {{ weather: string, ticks: number, newLastTickMs: number }}
 */
function advanceWeather(prev, lastTickMs, now, tickHours, table, pick) {
  const adjTable = table || DEFAULT_ADJACENCY
  const tickMs = tickHours * 60 * 60 * 1000
  const elapsed = now - lastTickMs
  const steps = Math.max(0, Math.floor(elapsed / tickMs))

  let weather = prev
  for (let i = 0; i < steps; i++) {
    if (typeof pick === 'function') {
      const neighbours = adjTable[weather]
      weather = pick(neighbours, i) || weather
    } else {
      weather = tickWeather(weather, adjTable, typeof pick === 'number' ? pick : undefined)
    }
  }

  // newLastTickMs advances by exactly (steps * tickMs) to avoid drift
  const newLastTickMs = lastTickMs + steps * tickMs

  return { weather, ticks: steps, newLastTickMs }
}

// ---------------------------------------------------------------------------
// Default honmaru locations (§5.4a)
// ---------------------------------------------------------------------------

const DEFAULT_LOCATIONS = [
  '本丸·主屋',
  '练习场',
  '库房',
  '庭院',
  '檐下',
  '厨房',
]

// ---------------------------------------------------------------------------
// createWorld — DB glue (needs koishi ctx, not offline-tested)
// ---------------------------------------------------------------------------

/**
 * Create a WorldContext accessor bound to a koishi ctx and plugin config.
 *
 * Returns { getWorld(presetId) } where getWorld:
 *   1. Reads life_sim_world row for presetId (creates + persists default if missing)
 *   2. Lazily advances weather using advanceWeather (§5.4c inertial ticks)
 *   3. Persists updated row if weather changed
 *   4. Returns assembled WorldContext:
 *      { clock, timeOfDay, season, weather, locations, externalLocations }
 *
 * clock = real wall-clock (Date.now())  — §5.11
 *
 * @param {object} ctx     – koishi context
 * @param {object} config  – plugin config (timezone, weatherSource, weatherTickHours,
 *                           externalLocations, etc.)
 * @returns {{ getWorld: (presetId: string) => Promise<object> }}
 */
function createWorld(ctx, config) {
  const TABLE = 'life_sim_world'

  const timezone          = (config && config.timezone)          || 'Asia/Shanghai'
  const weatherSource     = (config && config.weatherSource)     || 'internal'
  const weatherTickHours  = (config && config.weatherTickHours)  || 6
  const cfgExternal       = (config && config.externalLocations) || ['城下町', '近所']

  /**
   * getWorld(presetId) → WorldContext object
   */
  async function getWorld(presetId) {
    const now = Date.now()
    const nowDate = new Date(now)

    // 1. Load or initialise row
    let rows = await ctx.database.get(TABLE, { presetId })
    let row = rows && rows.length > 0 ? rows[0] : null

    if (!row) {
      // No row yet — insert default.  clock = now is the correct initial anchor.
      // Return early to avoid a redundant immediate set below.
      const defaultRow = {
        presetId,
        clock:             now,
        timeOfDay:         timeOfDayOf(nowDate, timezone),
        season:            seasonOf(nowDate, timezone),
        weather:           '晴',
        locations:         JSON.stringify(DEFAULT_LOCATIONS),
        externalLocations: JSON.stringify(cfgExternal),
        updatedAt:         new Date(now),
      }
      await ctx.database.create(TABLE, defaultRow)
      return {
        clock:             now,
        timeOfDay:         timeOfDayOf(nowDate, timezone),
        season:            seasonOf(nowDate, timezone),
        weather:           '晴',
        locations:         DEFAULT_LOCATIONS,
        externalLocations: cfgExternal,
      }
    }

    // 2. Lazily advance weather (internal source only; api → TODO: stub, use stored)
    let weather = row.weather || '晴'
    // clock is the true weather-tick anchor — do NOT overwrite it unless a full tick elapses.
    const lastTickMs = row.clock || now

    // Time-derived fields (always recomputed; cheap and always correct)
    const timeOfDay = timeOfDayOf(nowDate, timezone)
    const season    = seasonOf(nowDate, timezone)

    if (weatherSource === 'internal') {
      const result = advanceWeather(weather, lastTickMs, now, weatherTickHours, DEFAULT_ADJACENCY)
      if (result.ticks > 0) {
        // Full tick(s) elapsed — advance weather and move the anchor forward by
        // exactly (ticks * tickMs) to avoid drift.  Do NOT store `now` here.
        weather = result.weather
        await ctx.database.set(TABLE, { presetId }, {
          clock:     result.newLastTickMs,
          timeOfDay,
          season,
          weather,
          updatedAt: new Date(now),
        })
      } else {
        // Sub-tick read — do NOT touch clock (preserve accumulated elapsed time).
        await ctx.database.set(TABLE, { presetId }, {
          timeOfDay,
          season,
          updatedAt: new Date(now),
        })
      }
    } else {
      // TODO: api weather source — fetch from external API.
      // For now fall through with stored weather value.
      // Do NOT overwrite clock — api doesn't use the markov anchor.
      await ctx.database.set(TABLE, { presetId }, {
        timeOfDay,
        season,
        updatedAt: new Date(now),
      })
    }

    // 3. Parse locations
    let locations
    try {
      locations = JSON.parse(row.locations || 'null') || DEFAULT_LOCATIONS
    } catch (_) {
      locations = DEFAULT_LOCATIONS
    }

    let externalLocations
    try {
      externalLocations = JSON.parse(row.externalLocations || 'null') || cfgExternal
    } catch (_) {
      externalLocations = cfgExternal
    }

    // 4. Assemble and return
    // clock in the returned WorldContext = real wall-clock (§5.11); separate from the stored anchor.
    return {
      clock: now,
      timeOfDay,
      season,
      weather,
      locations,
      externalLocations,
    }
  }

  return { getWorld }
}

module.exports = {
  seasonOf,
  timeOfDayOf,
  tickWeather,
  advanceWeather,
  DEFAULT_ADJACENCY,
  createWorld,
}
