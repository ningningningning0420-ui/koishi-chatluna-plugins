'use strict'

// schedule-routine.js — RoutineAuthor + RoutineTemplate for chatluna-life-sim
//
// §5.3a: bot 自著常规日程（RoutineTemplate）
//
// Routine 结构:
//   { presetId, authoredBy:'self'|'seed'|'审神者', revisedAt, weekly:{ default:[{block,activity,location},...], <可选星期变体> } }
//
// Pure fns (offline-testable, no runtime deps):
//   blocksFor(routine, dayOfWeek)            → Block[] (variant or default or [])
//   buildRoutinePrompt(persona, recentEvents, seed) → messages array
//   parseRoutineResponse(text, presetId, authoredBy) → validated Routine object
//
// Glue (needs ctx / model / DB):
//   createRoutineAuthor(ctx, config, deps) → { authorRoutine, reviseRoutine, getRoutine, blocksForToday }

// ---------------------------------------------------------------------------
// Pure: blocksFor
// ---------------------------------------------------------------------------

// Day-of-week names (0=Sunday … 6=Saturday) → optional variant keys in weekly.
// The routine may store variants under these keys or Chinese equivalents.
const DAY_KEYS = ['sunday', 'monday', 'tuesday', 'wednesday', 'thursday', 'friday', 'saturday']
const DAY_KEYS_ZH = ['周日', '周一', '周二', '周三', '周四', '周五', '周六']

/**
 * Return the block list for the given dayOfWeek (0=Sun…6=Sat).
 * Checks variant keys (EN + ZH) first; falls back to weekly.default; returns [] if absent.
 *
 * @param {object|null} routine  Routine object (may be null/undefined)
 * @param {number} dayOfWeek     0–6 (0=Sunday)
 * @returns {Array}
 */
function blocksFor(routine, dayOfWeek) {
  if (!routine || !routine.weekly) return []
  const weekly = routine.weekly

  // Try English key first, then Chinese key
  const enKey = DAY_KEYS[dayOfWeek]
  const zhKey = DAY_KEYS_ZH[dayOfWeek]

  if (enKey && Array.isArray(weekly[enKey])) return weekly[enKey]
  if (zhKey && Array.isArray(weekly[zhKey])) return weekly[zhKey]

  // Fall back to default
  if (Array.isArray(weekly.default)) return weekly.default

  return []
}

// ---------------------------------------------------------------------------
// Pure: buildRoutinePrompt
// ---------------------------------------------------------------------------

/**
 * Build a messages array instructing the model to author a weekly routine.
 *
 * @param {string} persona        Character persona summary (may be empty)
 * @param {Array}  recentEvents   Array of recent life-sim event objects (may be empty/null)
 * @param {string|null} seed      Optional seed routine text or JSON (may be null)
 * @returns {Array<{role:string, content:string}>}
 */
function buildRoutinePrompt(persona, recentEvents, seed) {
  // Build digest of recent events (up to 10, by title/narrative)
  const eventLines = (recentEvents || [])
    .slice(0, 10)
    .map((e) => {
      const title = e.title || e.event_type || '(事件)'
      const loc = e.location ? ' @ ' + e.location : ''
      const mood = e.mood ? ' [' + e.mood + ']' : ''
      return '- ' + title + loc + mood
    })

  const recentDigest = eventLines.length > 0
    ? '近期生活记录（供参考实际习惯）：\n' + eventLines.join('\n')
    : '（暂无近期生活记录）'

  const seedSection = seed
    ? '\n\n可选种子日程（可以此为参考或起点，不必照搬）：\n' + seed
    : ''

  const systemContent = [
    '你是一个负责为角色自著日常作息的助手。请根据以下角色人设和近期生活习惯，生成一份贴合角色气质的每周常规日程。',
    '',
    '输出要求：',
    '- 仅输出一个合法的 JSON 对象，不要有任何额外的说明或前缀。',
    '- 格式：{ "weekly": { "default": [ { "block": "时段名", "activity": "活动描述", "location": "地点" }, ... ] } }',
    '- 时段（block）使用中文时段名，如：清晨、上午、午后、黄昏、夜、深夜。',
    '- 每天至少包含 4–6 个时段，活动要贴合角色人设（不要刻板打卡，体现角色性格）。',
    '- 若角色有明显的星期变体（如某天固定活动），可额外加 "monday" / "friday" 等键，值同 default 格式。',
    '- location 用本丸地名（如 自室、练习场、庭院、檐下、库房、厨房、本丸各处 等）。',
    '- 活动描述≤30字，第三人称或动词短语均可，体现角色性格。',
  ].join('\n')

  const userContent = [
    '【角色人设】',
    persona || '（使用默认设定：刀剑男士，本丸常驻）',
    '',
    '【近期生活习惯参考】',
    recentDigest,
    seedSection,
    '',
    '请基于以上信息，输出该角色的每周常规日程 JSON：',
  ].join('\n')

  return [
    { role: 'system', content: systemContent },
    { role: 'user', content: userContent },
  ]
}

// ---------------------------------------------------------------------------
// Pure: parseRoutineResponse
// ---------------------------------------------------------------------------

/**
 * Validate a single block object. Returns true if it has non-empty block, activity, location.
 * @param {any} b
 * @returns {boolean}
 */
function isValidBlock(b) {
  return (
    b != null &&
    typeof b === 'object' &&
    typeof b.block === 'string' && b.block.trim().length > 0 &&
    typeof b.activity === 'string' && b.activity.trim().length > 0 &&
    typeof b.location === 'string' && b.location.trim().length > 0
  )
}

/**
 * A minimal fallback weekly when we cannot parse the model response.
 * @returns {object}
 */
function minimalDefaultWeekly() {
  return {
    default: [
      { block: '清晨', activity: '起身', location: '自室' },
      { block: '上午', activity: '日常活动', location: '本丸各处' },
      { block: '午后', activity: '休憩', location: '庭院' },
      { block: '夜', activity: '就寝准备', location: '自室' },
    ],
  }
}

/**
 * Extract the first JSON object from text (which may contain prose around it).
 * Returns the parsed object, or null if none found / parse error.
 * @param {string} text
 * @returns {object|null}
 */
function extractJson(text) {
  if (!text || typeof text !== 'string') return null
  // Try to find the first '{' and match to its closing '}'
  const start = text.indexOf('{')
  if (start === -1) return null

  // Walk forward tracking brace depth to find the matching '}'
  let depth = 0
  let end = -1
  for (let i = start; i < text.length; i++) {
    const ch = text[i]
    if (ch === '{') depth++
    else if (ch === '}') {
      depth--
      if (depth === 0) {
        end = i
        break
      }
    }
  }
  if (end === -1) return null

  const jsonStr = text.slice(start, end + 1)
  try {
    return JSON.parse(jsonStr)
  } catch (_) {
    return null
  }
}

/**
 * Parse and validate model response text into a Routine object.
 * - Extracts JSON from prose if wrapped.
 * - Validates each block in weekly variants; drops malformed blocks.
 * - Falls back to minimal default weekly if parsing fails or no valid blocks.
 * - Does NOT call new Date() internally; caller sets revisedAt.
 *
 * @param {string} text          Raw model response text
 * @param {string} presetId      Preset ID to embed in result
 * @param {string} authoredBy    Provenance: 'self' | 'seed' | '审神者'
 * @returns {{ presetId:string, authoredBy:string, weekly:object }}
 */
function parseRoutineResponse(text, presetId, authoredBy) {
  const base = { presetId, authoredBy: authoredBy || 'self' }

  const parsed = extractJson(text)

  if (!parsed) {
    return Object.assign({}, base, { weekly: minimalDefaultWeekly() })
  }

  // Accept { weekly: {...} } or { default: [...] } at top level
  const weeklyRaw = parsed.weekly || (Array.isArray(parsed.default) ? { default: parsed.default } : null)

  if (!weeklyRaw || typeof weeklyRaw !== 'object') {
    return Object.assign({}, base, { weekly: minimalDefaultWeekly() })
  }

  // Validate each variant key
  const weekly = {}
  let hasAnyValid = false

  for (const key of Object.keys(weeklyRaw)) {
    const blocks = weeklyRaw[key]
    if (!Array.isArray(blocks)) continue
    const validBlocks = blocks.filter(isValidBlock)
    if (validBlocks.length > 0) {
      weekly[key] = validBlocks
      hasAnyValid = true
    }
    // If all blocks are malformed, drop the entire key (per spec: "drop malformed")
  }

  if (!hasAnyValid) {
    return Object.assign({}, base, { weekly: minimalDefaultWeekly() })
  }

  return Object.assign({}, base, { weekly })
}

// ---------------------------------------------------------------------------
// Glue: createRoutineAuthor
// ---------------------------------------------------------------------------

// DB table for routines
const TABLE = 'life_sim_routine'

/**
 * Load seed text from config.routineSeedPath (optional).
 * Returns null if not configured or file unreadable.
 * @param {string|null} seedPath
 * @returns {string|null}
 */
function loadSeed(seedPath) {
  if (!seedPath) return null
  try {
    const fs = require('fs')
    const content = fs.readFileSync(seedPath, 'utf8')
    return content
  } catch (_) {
    return null
  }
}

/**
 * Parse the raw DB routine row (weekly is a JSON string) into a Routine object.
 * @param {object} row
 * @returns {object}
 */
function parseRoutineRow(row) {
  const obj = Object.assign({}, row)
  if (typeof obj.weekly === 'string') {
    try { obj.weekly = JSON.parse(obj.weekly) } catch (_) { obj.weekly = minimalDefaultWeekly() }
  }
  if (!obj.weekly || typeof obj.weekly !== 'object') {
    obj.weekly = minimalDefaultWeekly()
  }
  return obj
}

/**
 * Create the RoutineAuthor bound to a koishi ctx, config, and injected deps.
 *
 * @param {object} ctx    Koishi context with ctx.database
 * @param {object} config Plugin config (rollModel, routineSeedPath, routineReviseEvery, routineAuthoredBy)
 * @param {object} deps   {
 *   getPersona?: async (presetId) => string,   // optional; returns persona text
 *   recent?: async (presetId, n) => Array,      // optional; returns recent events
 *   getModel?: async (ctx, modelName) => model, // model factory (from model.js)
 *   invoke?: async (model, messages) => string  // invoke helper (from model.js)
 * }
 * @returns {{ authorRoutine, reviseRoutine, getRoutine, blocksForToday }}
 */
function createRoutineAuthor(ctx, config, deps) {
  const _getPersona = (deps && deps.getPersona) || null
  const _recent = (deps && deps.recent) || null
  const _getModel = (deps && deps.getModel) || null
  const _invoke = (deps && deps.invoke) || null

  const modelName = (config && config.rollModel) || 'ollama/qwen2.5:7b'

  // ---------------------------------------------------------------------------
  // Internal: author a routine from scratch using the model
  // ---------------------------------------------------------------------------
  async function _authorFromModel(presetId, currentRoutine) {
    // 1. Get persona
    let persona = ''
    if (_getPersona) {
      try { persona = (await _getPersona(presetId)) || '' } catch (_) {}
    }
    if (!persona) {
      persona = '【' + presetId + '】（刀剑男士，本丸常驻）\n[TODO: 配置 getPersona hook 以注入完整人设]'
    }

    // 2. Get recent events
    let recentEvents = []
    if (_recent) {
      try { recentEvents = (await _recent(presetId, 10)) || [] } catch (_) {}
    }

    // 3. Load optional seed
    const seedPath = config && config.routineSeedPath
    const seed = loadSeed(seedPath)

    // 4. Build prompt — if revising, include current routine as seed context
    let promptSeed = seed
    if (currentRoutine && currentRoutine.weekly) {
      const currentJson = JSON.stringify(currentRoutine.weekly, null, 2)
      promptSeed = (seed ? seed + '\n\n' : '') + '当前已有日程（修订参考）：\n' + currentJson
    }

    const messages = buildRoutinePrompt(persona, recentEvents, promptSeed)

    // 5. Get model + invoke
    if (!_getModel || !_invoke) {
      throw new Error('life-sim routine: no model available (getModel/invoke not provided)')
    }
    const model = await _getModel(ctx, modelName)
    const responseText = await _invoke(model, messages)

    // 6. Parse + validate
    const authoredBy = currentRoutine
      ? (currentRoutine.authoredBy || 'self')  // keep original provenance on revise
      : 'self'
    return parseRoutineResponse(responseText, presetId, authoredBy)
  }

  // ---------------------------------------------------------------------------
  // Internal: upsert routine to DB
  // ---------------------------------------------------------------------------
  async function _upsertRoutine(routine, revisedAt) {
    const { presetId } = routine
    const weeklyJson = JSON.stringify(routine.weekly)
    const ts = revisedAt instanceof Date ? revisedAt : new Date()

    // Check if row exists (life_sim_routine has unique constraint on presetId)
    const existing = await ctx.database.get(TABLE, { presetId })

    if (existing && existing.length > 0) {
      await ctx.database.set(TABLE, { presetId }, {
        authoredBy: routine.authoredBy,
        revisedAt: ts,
        weekly: weeklyJson,
      })
    } else {
      await ctx.database.create(TABLE, {
        presetId,
        authoredBy: routine.authoredBy,
        revisedAt: ts,
        weekly: weeklyJson,
      })
    }

    return Object.assign({}, routine, { revisedAt: ts })
  }

  // ---------------------------------------------------------------------------
  // Public: authorRoutine
  // Author a fresh routine from persona + recent events + optional seed.
  // Writes to DB with authoredBy='self' and revisedAt=now.
  // Falls back to minimal default if model fails.
  // ---------------------------------------------------------------------------
  async function authorRoutine(presetId) {
    let routine
    try {
      routine = await _authorFromModel(presetId, null)
    } catch (err) {
      // Model failure fallback: minimal default weekly
      routine = {
        presetId,
        authoredBy: 'self',
        weekly: minimalDefaultWeekly(),
      }
    }
    routine.authoredBy = 'self'
    return _upsertRoutine(routine, new Date())
  }

  // ---------------------------------------------------------------------------
  // Public: reviseRoutine
  // Re-author using the current routine as context (periodic self-revision).
  // Falls back to keeping the existing routine on model failure.
  // ---------------------------------------------------------------------------
  async function reviseRoutine(presetId) {
    // Load current routine (may be null if not yet authored)
    const rows = await ctx.database.get(TABLE, { presetId })
    const currentRoutine = (rows && rows.length > 0) ? parseRoutineRow(rows[0]) : null

    let routine
    try {
      routine = await _authorFromModel(presetId, currentRoutine)
    } catch (err) {
      if (currentRoutine) {
        // Keep existing routine, just update revisedAt
        return _upsertRoutine(currentRoutine, new Date())
      }
      routine = {
        presetId,
        authoredBy: 'self',
        weekly: minimalDefaultWeekly(),
      }
    }

    // Preserve original authoredBy (don't flip seed→self on revise)
    if (currentRoutine && currentRoutine.authoredBy) {
      routine.authoredBy = currentRoutine.authoredBy
    }

    return _upsertRoutine(routine, new Date())
  }

  // ---------------------------------------------------------------------------
  // Public: getRoutine
  // Read from DB; if missing, author a new one (or fall back to default if model unavailable).
  // ---------------------------------------------------------------------------
  async function getRoutine(presetId) {
    const rows = await ctx.database.get(TABLE, { presetId })
    if (rows && rows.length > 0) {
      return parseRoutineRow(rows[0])
    }
    // Not found — author fresh
    try {
      return await authorRoutine(presetId)
    } catch (_) {
      return {
        presetId,
        authoredBy: 'self',
        revisedAt: null,
        weekly: minimalDefaultWeekly(),
      }
    }
  }

  // ---------------------------------------------------------------------------
  // Public: blocksForToday
  // Get the block list for today (by dayOfWeek derived from `now`).
  // ---------------------------------------------------------------------------
  async function blocksForToday(presetId, now) {
    const date = now instanceof Date ? now : new Date(now || Date.now())
    const dayOfWeek = date.getDay()  // 0=Sun … 6=Sat
    const routine = await getRoutine(presetId)
    return blocksFor(routine, dayOfWeek)
  }

  return { authorRoutine, reviseRoutine, getRoutine, blocksForToday }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // Pure helpers (exported for testing)
  blocksFor,
  buildRoutinePrompt,
  parseRoutineResponse,
  extractJson,
  isValidBlock,
  minimalDefaultWeekly,
  // Glue factory
  createRoutineAuthor,
  // Internal utils exported for reuse
  parseRoutineRow,
  loadSeed,
}
