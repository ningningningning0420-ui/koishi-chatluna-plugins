'use strict'

// world-registry.js — Task 5: EventRegistry（动态事件类型注册表 + 加权抽样）
//
// 设计引用: §5.4b 事件类型注册表 / §5.4d 出本丸许可制
//
// Exports (pure logic, offline-testable):
//   matchContext(conditions, world, lifeState) → boolean
//   selectAvailable(entries, world, lifeState, forbidden) → [{type, weight}]
//   sampleWeighted(weighted, r?) → string | null
//
// Exports (DB/IO glue, needs koishi ctx + fs):
//   createRegistry(ctx, config) → { available(world, lifeState), reload() }
//
// Default entries (baked in as fallback when file is missing or empty):
//   练习 / 檐下发呆 / 夜巡 / 角色互动 / 思绪

// ---------------------------------------------------------------------------
// DEFAULT_ENTRIES — baked-in fallback event types (§5.4b examples)
// ---------------------------------------------------------------------------

const DEFAULT_ENTRIES = [
  {
    type: '练习',
    conditions: {
      timeOfDay: ['清晨', '上午', '午后'],
      location: ['练习场', '庭院', '本丸·主屋'],
    },
    weight: 3,
  },
  {
    type: '檐下发呆',
    conditions: {
      timeOfDay: ['午后', '黄昏', '夜'],
    },
    weight: 2,
  },
  {
    type: '夜巡',
    conditions: {
      timeOfDay: ['夜', '深夜'],
    },
    weight: 2,
  },
  {
    type: '角色互动',
    conditions: {
      requiresOtherPresent: true,
    },
    weight: 4,
  },
  {
    type: '思绪',
    conditions: {},
    weight: 1,
  },
]

// ---------------------------------------------------------------------------
// matchContext — pure, offline-testable
// ---------------------------------------------------------------------------

/**
 * Test whether a single entry's conditions match the current world + lifeState.
 *
 * Rules (§5.4b):
 *   - An absent condition key always matches (open condition).
 *   - A present condition key matches if the world/lifeState value is in the
 *     condition's allowed array.
 *   - `requiresOtherPresent` checks lifeState.otherPresent (boolean).
 *     For P1 single-agent, no other is present → requiresOtherPresent=true
 *     entries are filtered out.
 *
 * @param {object} conditions  – condition map from entry (may be {} or missing keys)
 * @param {object} world       – WorldContext {clock, timeOfDay, season, weather, locations, externalLocations}
 * @param {object} lifeState   – current life-state {location?, otherPresent?, ...}
 * @returns {boolean}
 */
function matchContext(conditions, world, lifeState) {
  if (!conditions) return true

  const w = world   || {}
  const ls = lifeState || {}

  // timeOfDay
  if (conditions.timeOfDay !== undefined) {
    const allowed = conditions.timeOfDay
    if (!Array.isArray(allowed) || !allowed.includes(w.timeOfDay)) return false
  }

  // weather
  if (conditions.weather !== undefined) {
    const allowed = conditions.weather
    if (!Array.isArray(allowed) || !allowed.includes(w.weather)) return false
  }

  // season
  if (conditions.season !== undefined) {
    const allowed = conditions.season
    if (!Array.isArray(allowed) || !allowed.includes(w.season)) return false
  }

  // location — current location from lifeState
  if (conditions.location !== undefined) {
    const allowed = conditions.location
    if (!Array.isArray(allowed) || !allowed.includes(ls.location)) return false
  }

  // requiresOtherPresent — P1: no other → false
  if (conditions.requiresOtherPresent !== undefined) {
    const required = conditions.requiresOtherPresent
    const present = !!(ls.otherPresent)
    if (required && !present) return false
    if (!required && present) {
      // requiresOtherPresent: false means "requires NO other present"; still ok if present, just not required
      // Design says: "requiresOtherPresent checks lifeState" — interpret as must-have=true / no-constraint=absent
      // Leave this branch as pass-through (no strict anti-require needed for P1)
    }
  }

  return true
}

// ---------------------------------------------------------------------------
// selectAvailable — pure, offline-testable
// ---------------------------------------------------------------------------

/**
 * Filter entries to those matching current context and not in the forbidden list.
 *
 * @param {Array}  entries   – array of {type, conditions, weight}
 * @param {object} world     – WorldContext
 * @param {object} lifeState – current life-state
 * @param {Array}  forbidden – array of type strings to exclude (§5.4d hardban)
 * @returns {Array} [{type, weight}]
 */
function selectAvailable(entries, world, lifeState, forbidden) {
  const ban = new Set(Array.isArray(forbidden) ? forbidden : [])
  return (entries || [])
    .filter((e) => {
      if (!e || !e.type) return false
      if (ban.has(e.type)) return false
      return matchContext(e.conditions, world, lifeState)
    })
    .map((e) => ({ type: e.type, weight: typeof e.weight === 'number' ? e.weight : 1 }))
}

// ---------------------------------------------------------------------------
// sampleWeighted — pure, offline-testable
// ---------------------------------------------------------------------------

/**
 * Weighted random pick from a [{type, weight}] array.
 *
 * @param {Array}          weighted – [{type, weight}]
 * @param {number|undefined} r      – random value in [0, 1); defaults to Math.random()
 * @returns {string|null}  chosen type, or null if empty
 */
function sampleWeighted(weighted, r) {
  if (!weighted || weighted.length === 0) return null
  const total = weighted.reduce((s, e) => s + (e.weight || 0), 0)
  if (total <= 0) return weighted[0].type  // all zero weights: pick first

  const rand = (typeof r === 'number' ? r : Math.random()) * total
  let cursor = 0
  for (const e of weighted) {
    cursor += (e.weight || 0)
    if (rand < cursor) return e.type
  }
  // r == 1.0 edge case or float precision: return last
  return weighted[weighted.length - 1].type
}

// ---------------------------------------------------------------------------
// createRegistry — DB/IO glue (needs koishi ctx + fs, NOT offline-tested)
// ---------------------------------------------------------------------------

/**
 * Create a hot-reloading event registry.
 *
 * Loads entries from config.eventRegistryPath (JSON array or {entries:[...]}).
 * Falls back to DEFAULT_ENTRIES if the file is missing, unreadable, or empty.
 * Watches the file for changes using fs.watch with 300 ms debounce (same
 * pattern as koishi-plugin-chatluna-worldbook).
 *
 * @param {object} ctx     – koishi context
 * @param {object} config  – plugin config (eventRegistryPath, forbiddenEventTypes)
 * @returns {{ available(world, lifeState): [{type,weight}], reload(): void }}
 */
function createRegistry(ctx, config) {
  const fs = require('fs')
  const { resolve, isAbsolute } = require('path')
  const logger = ctx.logger ? ctx.logger('life-sim:registry') : console

  const registryPath = (config && config.eventRegistryPath) || 'data/life-sim/event-types.json'
  const forbidden    = (config && config.forbiddenEventTypes) || ['新命名角色', '重大伤亡']

  let entries = DEFAULT_ENTRIES.slice()

  function resolvePath(p) {
    if (isAbsolute(p)) return p
    const baseDir = (ctx.loader && ctx.loader.baseDir) || process.cwd()
    return resolve(baseDir, p)
  }

  function loadEntries() {
    const full = resolvePath(registryPath)
    try {
      const raw = fs.readFileSync(full, 'utf8')
      const json = JSON.parse(raw)
      const list = Array.isArray(json) ? json : (json.entries || [])
      if (!list.length) {
        entries = DEFAULT_ENTRIES.slice()
        logger.warn && logger.warn('事件注册表为空,使用内置默认条目: %s', full)
      } else {
        entries = list
        logger.info && logger.info('事件注册表已加载: %d 条 — %s', list.length, full)
      }
    } catch (err) {
      entries = DEFAULT_ENTRIES.slice()
      if (err.code !== 'ENOENT') {
        logger.warn && logger.warn('事件注册表加载失败,使用内置默认: %s — %s', full, (err && err.message) || err)
      }
    }
  }

  // Boot load + file watch (debounced, same pattern as worldbook)
  ctx.on('ready', () => {
    loadEntries()
    let debounce = null
    const full = resolvePath(registryPath)
    try {
      const watcher = fs.watch(full, () => {
        if (debounce) clearTimeout(debounce)
        debounce = setTimeout(() => { loadEntries() }, 300)
      })
      ctx.effect(() => () => watcher.close())
    } catch (e) { /* 文件不存在时 watch 失败,热重载在文件出现后手动 reload() */ }
  })

  /**
   * available(world, lifeState) → [{type, weight}]
   * Filter the loaded entries by current context, excluding forbidden types.
   */
  function available(world, lifeState) {
    return selectAvailable(entries, world, lifeState, forbidden)
  }

  /**
   * reload() — force-reload the entries file immediately (useful in tests / admin commands).
   */
  function reload() {
    loadEntries()
  }

  return { available, reload }
}

module.exports = {
  matchContext,
  selectAvailable,
  sampleWeighted,
  createRegistry,
  DEFAULT_ENTRIES,
}
