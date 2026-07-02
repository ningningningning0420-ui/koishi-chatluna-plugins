'use strict'

// memory-consolidate.js — NightConsolidator (短→长沉淀) for koishi-plugin-chatluna-life-sim
//
// Pure helpers (offline-testable, no runtime deps):
//   clusterScore(cluster)                 → number (higher = process first)
//   clusterEvents(events)                 → array of clusters
//   parseConsolidateOps(text)             → { operations: [...] }
//
// DB/model glue:
//   createNightConsolidator(ctx, config, deps)
//     → { consolidate(presetId, day, nowMs), registerHandler() }
//
// Design refs: §4.3 (short→long consolidation), §5.10 (night sleep)
//
// deps shape:
//   deps.getModel(modelName)         → Promise<model>
//   deps.invoke(model, messages)     → Promise<string>
//   deps.ltm                         → LongTermMemory instance (from createLongTermMemory)
//   deps.scheduler                   → { registerHandler(type, fn) }
//   deps.planner?.planDay(pid, day)  → best-effort next-day plan
//   deps.tidyThoughts?.(pid)         → best-effort thought buffer tidy

// ---------------------------------------------------------------------------
// Pure helpers — clusterScore
// ---------------------------------------------------------------------------

/**
 * Compute a priority score for a cluster (higher = should be processed first).
 *
 * Formula: reasonScore*10 + importanceScore + recencyScore
 *
 * reasonScore (why this cluster formed):
 *   4 = keyword-overlap (shared keywords between events)
 *   3 = sentiment/mood match
 *   2 = month-bucket (same month but no direct overlap)
 *   1 = fallback (catch-all bucket)
 *
 * importanceScore:
 *   avg of event importance values (0.5 if all null)
 *
 * recencyScore:
 *   latest ts in cluster, normalized to [0,1] by dividing by Date.now() equivalent.
 *   Since this is pure (no new Date()), caller must pass nowMs via cluster.nowMs.
 *   If cluster.nowMs is absent, recencyScore = 0.
 *
 * A cluster object shape:
 *   {
 *     reason: 'keyword'|'sentiment'|'month'|'fallback',
 *     events: [{ importance?: number, ts?: Date|number, ... }],
 *     nowMs?: number,
 *   }
 *
 * @param {object} cluster
 * @returns {number}
 */
function clusterScore(cluster) {
  if (!cluster || !Array.isArray(cluster.events)) return 0
  if (cluster.events.length === 0) return 0

  // reasonScore
  const reasonMap = { keyword: 4, sentiment: 3, month: 2, fallback: 1 }
  const reasonScore = reasonMap[cluster.reason] != null ? reasonMap[cluster.reason] : 1

  // importanceScore = avg importance (0.5 if none present)
  let importanceScore = 0.5
  if (cluster.events.length > 0) {
    let sum = 0
    let count = 0
    for (const e of cluster.events) {
      if (e.importance != null && typeof e.importance === 'number') {
        sum += e.importance
        count++
      }
    }
    if (count > 0) importanceScore = sum / count
  }

  // recencyScore = latest ts normalized by nowMs
  let recencyScore = 0
  if (cluster.nowMs && cluster.nowMs > 0) {
    let latestMs = 0
    for (const e of cluster.events) {
      if (e.ts != null) {
        const ms = e.ts instanceof Date ? e.ts.getTime() : Number(e.ts)
        if (Number.isFinite(ms) && ms > latestMs) latestMs = ms
      }
    }
    if (latestMs > 0) {
      recencyScore = Math.min(1, latestMs / cluster.nowMs)
    }
  }

  return reasonScore * 10 + importanceScore + recencyScore
}

// ---------------------------------------------------------------------------
// Pure helpers — clusterEvents
// ---------------------------------------------------------------------------

/**
 * Parse keywords from an event (handles string JSON or array).
 * Returns [] if unparseable.
 * @param {object} event
 * @returns {string[]}
 */
function getKeywords(event) {
  if (!event) return []
  let raw = event.keywords
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw) } catch (_) { return [] }
  }
  if (Array.isArray(raw)) return raw.map((k) => String(k).toLowerCase())
  return []
}

/**
 * Parse participants/entities from an event.
 * We treat participants as entity proxies for clustering.
 * Returns [] if unparseable.
 * @param {object} event
 * @returns {string[]}
 */
function getEntities(event) {
  if (!event) return []
  // Check entities field first, then participants
  let raw = event.entities != null ? event.entities : event.participants
  if (typeof raw === 'string') {
    try { raw = JSON.parse(raw) } catch (_) { return [] }
  }
  if (Array.isArray(raw)) return raw.map((e) => String(e).toLowerCase())
  return []
}

/**
 * Get the month bucket for an event (YYYY-MM string).
 * Returns '' if ts is absent or invalid.
 * @param {object} event
 * @returns {string}
 */
function getMonthBucket(event) {
  if (!event || event.ts == null) {
    // Fallback to day field if ts absent
    if (event && event.day && typeof event.day === 'string') {
      return event.day.slice(0, 7)
    }
    return ''
  }
  const d = event.ts instanceof Date ? event.ts : new Date(event.ts)
  if (isNaN(d.getTime())) return ''
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  return y + '-' + m
}

/**
 * Count shared keywords between two keyword arrays.
 * @param {string[]} a
 * @param {string[]} b
 * @returns {number}
 */
function sharedKeywordCount(a, b) {
  if (!a.length || !b.length) return 0
  const setA = new Set(a)
  let count = 0
  for (const k of b) {
    if (setA.has(k)) count++
  }
  return count
}

/**
 * Cluster events by keyword overlap (≥2 shared keywords), shared entity,
 * or same month bucket. Each event is placed in exactly one cluster (greedy).
 *
 * Algorithm:
 *   1. For each unassigned event, check if it can join any existing cluster:
 *      a. If ≥2 shared keywords with any event in cluster → join (reason: keyword)
 *      b. Else if any shared entity with any event in cluster → join (reason: entity→keyword bucket)
 *      c. Else if same month bucket as cluster's representative → join (reason: month)
 *   2. If no cluster matches, start a new cluster.
 *   3. A single-event cluster with no shared keyword context → reason: fallback.
 *
 * Returns an array of cluster objects:
 *   { reason: 'keyword'|'sentiment'|'month'|'fallback', events: [...] }
 *
 * Note: sentiment clustering is not implemented as pure logic (needs model);
 *       it would appear as 'sentiment' if external code labels it. We produce
 *       'keyword', 'month', 'fallback' here.
 *
 * @param {Array} events  Array of event objects
 * @returns {Array}       Array of cluster objects
 */
function clusterEvents(events) {
  if (!Array.isArray(events) || events.length === 0) return []

  const clusters = []   // Array of { reason, events, keywords: Set, entities: Set, monthBucket }

  for (const event of events) {
    const eventKws = getKeywords(event)
    const eventEnts = getEntities(event)
    const eventMonth = getMonthBucket(event)

    let placed = false

    for (const cluster of clusters) {
      // Check keyword overlap ≥2 with any event in cluster
      let kwOverlap = 0
      for (const ce of cluster.events) {
        const ceKws = getKeywords(ce)
        kwOverlap = Math.max(kwOverlap, sharedKeywordCount(eventKws, ceKws))
        if (kwOverlap >= 2) break
      }

      if (kwOverlap >= 2) {
        cluster.events.push(event)
        cluster.reason = 'keyword'  // upgrade reason if it was lower
        placed = true
        break
      }

      // Check shared entity
      if (eventEnts.length > 0) {
        let entityMatch = false
        for (const ce of cluster.events) {
          const ceEnts = getEntities(ce)
          for (const ent of eventEnts) {
            if (ceEnts.includes(ent)) { entityMatch = true; break }
          }
          if (entityMatch) break
        }
        if (entityMatch) {
          cluster.events.push(event)
          // Only upgrade to keyword if not already keyword
          if (cluster.reason !== 'keyword') cluster.reason = 'month'
          placed = true
          break
        }
      }

      // Check month bucket
      if (eventMonth && cluster.monthBucket === eventMonth) {
        cluster.events.push(event)
        if (cluster.reason !== 'keyword') cluster.reason = 'month'
        placed = true
        break
      }
    }

    if (!placed) {
      clusters.push({
        reason: eventMonth ? 'month' : 'fallback',
        events: [event],
        monthBucket: eventMonth,
      })
    }
  }

  // Single-event clusters with no keywords → fallback
  for (const cluster of clusters) {
    if (cluster.events.length === 1) {
      const kws = getKeywords(cluster.events[0])
      if (kws.length === 0) cluster.reason = 'fallback'
    }
  }

  return clusters
}

// ---------------------------------------------------------------------------
// Pure helpers — parseConsolidateOps
// ---------------------------------------------------------------------------

const VALID_ACTIONS = new Set(['keep', 'update', 'merge', 'archive'])

/**
 * Extract keep/update/merge/archive operations from model text.
 *
 * The model may return JSON directly or embed it in prose.
 * We try:
 *   1. Direct JSON parse of the full text
 *   2. Extract the first {...} block from prose and parse it
 *
 * Expected JSON shape:
 *   {
 *     "operations": [
 *       { "action": "keep",    "memoryId": 1,  "reason": "..." },
 *       { "action": "update",  "memoryId": 1,  "memory": { content, summary, keywords, entities, importance }, "reason": "..." },
 *       { "action": "merge",   "sourceMemoryIds": [1,2], "memory": { ... }, "reason": "..." },
 *       { "action": "archive", "memoryId": 1,  "reason": "..." },
 *       { "action": "keep",    "memory": { ... } }   // new entry without existing memoryId
 *     ]
 *   }
 *
 * Malformed operations (unknown action, missing required fields) are dropped.
 * Garbage input → { operations: [] }
 *
 * No new Date() — purely structural parsing.
 *
 * @param {string} text  Raw model output
 * @returns {{ operations: Array }}
 */
function parseConsolidateOps(text) {
  const empty = { operations: [] }
  if (text == null || typeof text !== 'string') return empty

  const trimmed = text.trim()
  if (trimmed === '') return empty

  let parsed = null

  // Try 1: direct JSON parse
  try {
    parsed = JSON.parse(trimmed)
  } catch (_) {
    // Try 2: extract first {...} block from prose
    const match = trimmed.match(/\{[\s\S]*\}/)
    if (match) {
      try {
        parsed = JSON.parse(match[0])
      } catch (_2) {
        return empty
      }
    } else {
      return empty
    }
  }

  if (!parsed || typeof parsed !== 'object') return empty

  // Find operations array at top level or nested
  let rawOps = null
  if (Array.isArray(parsed.operations)) {
    rawOps = parsed.operations
  } else if (Array.isArray(parsed)) {
    rawOps = parsed
  } else {
    return empty
  }

  const operations = []
  for (const op of rawOps) {
    if (!op || typeof op !== 'object') continue
    const action = op.action
    if (!action || !VALID_ACTIONS.has(action)) continue

    // Validate required fields per action
    if (action === 'merge') {
      // merge requires sourceMemoryIds array
      if (!Array.isArray(op.sourceMemoryIds) || op.sourceMemoryIds.length === 0) continue
    }
    // update and archive can reference memoryId (optional for new entries)
    // keep is always valid

    const cleaned = { action }
    if (op.memoryId       != null)  cleaned.memoryId       = op.memoryId
    if (op.targetMemoryId != null)  cleaned.targetMemoryId = op.targetMemoryId
    if (Array.isArray(op.sourceMemoryIds)) cleaned.sourceMemoryIds = op.sourceMemoryIds
    if (op.memory   && typeof op.memory === 'object')   cleaned.memory   = op.memory
    if (op.reason   && typeof op.reason === 'string')   cleaned.reason   = op.reason

    operations.push(cleaned)
  }

  return { operations }
}

// ---------------------------------------------------------------------------
// Internal: build tomorrow's date string from a YYYY-MM-DD string
// ---------------------------------------------------------------------------

/**
 * Return the YYYY-MM-DD string of the day after `day`.
 * Uses Date arithmetic. Pure function (doesn't call new Date() without argument).
 * @param {string} day  YYYY-MM-DD
 * @returns {string}
 */
function tomorrowOf(day) {
  const d = new Date(day + 'T00:00:00Z')
  d.setUTCDate(d.getUTCDate() + 1)
  const y = d.getUTCFullYear()
  const m = String(d.getUTCMonth() + 1).padStart(2, '0')
  const dd = String(d.getUTCDate()).padStart(2, '0')
  return y + '-' + m + '-' + dd
}

/**
 * Return a YYYY-MM-DD string for today based on nowMs.
 * @param {number} nowMs
 * @returns {string}
 */
function todayStr(nowMs) {
  const d = new Date(nowMs)
  const y = d.getFullYear()
  const m = String(d.getMonth() + 1).padStart(2, '0')
  const dd = String(d.getDate()).padStart(2, '0')
  return y + '-' + m + '-' + dd
}

// ---------------------------------------------------------------------------
// Internal: build dream-style consolidation prompt for a cluster
// ---------------------------------------------------------------------------

/**
 * Build a consolidation prompt for a cluster.
 *
 * @param {string}   presetId
 * @param {object[]} clusterEvents  The events in the cluster
 * @param {object[]} relatedLtm     Existing LTM entries related to this cluster
 * @returns {Array}  messages array [{role, content}]
 */
function buildConsolidatePrompt(presetId, clusterEvents, relatedLtm) {
  const eventsText = clusterEvents.map((e, i) => {
    const kws = (() => {
      let raw = e.keywords
      if (typeof raw === 'string') { try { raw = JSON.parse(raw) } catch (_) { raw = [] } }
      return Array.isArray(raw) ? raw.join(', ') : ''
    })()
    return [
      '事件 ' + (i + 1) + ':',
      '  标题: ' + (e.title || '(无标题)'),
      '  内容: ' + (e.narrative || e.title || ''),
      '  重要度: ' + (e.importance != null ? e.importance : '未知'),
      '  关键词: ' + (kws || '无'),
      '  时间: ' + (e.day || ''),
    ].join('\n')
  }).join('\n\n')

  const ltmText = relatedLtm.length === 0
    ? '（无相关长期记忆）'
    : relatedLtm.map((m, i) => {
      const kws = Array.isArray(m.keywords) ? m.keywords.join(', ') : ''
      return [
        '长期记忆 ' + (i + 1) + ' (id=' + m.id + '):',
        '  摘要: ' + (m.summary || m.content || ''),
        '  重要度: ' + (m.importance != null ? m.importance : '未知'),
        '  关键词: ' + (kws || '无'),
      ].join('\n')
    }).join('\n\n')

  const system = [
    '你是 ' + presetId + ' 的记忆整理者。',
    '你将对今天的短期事件进行"夜间梦境式"整理，决定如何处置这些记忆。',
    '',
    '你可以执行以下操作（每个事件/条目只选一种）：',
    '- keep: 保留已有的长期记忆条目不变（新事件可以生成新的 keep 条目）',
    '- update: 更新已有长期记忆条目（提供 memoryId 和新的 memory 内容）',
    '- merge: 将多条记忆合并为一条（提供 sourceMemoryIds 和合并后的 memory）',
    '- archive: 归档（删除）不再重要的长期记忆条目（提供 memoryId）',
    '',
    '注意：',
    '- content 用第一人称、≤100 字',
    '- keywords ≤12 个',
    '- importance 在 0-1 之间',
    '- 只输出 JSON，格式如下',
  ].join('\n')

  const user = [
    '=== 今日事件（待沉淀）===',
    eventsText,
    '',
    '=== 相关长期记忆（已存）===',
    ltmText,
    '',
    '请输出 JSON：',
    '{',
    '  "operations": [',
    '    { "action": "keep",    "memory": { "kind": "event", "content": "...", "summary": "...", "keywords": [], "entities": [], "importance": 0.7 } },',
    '    { "action": "update",  "memoryId": 1, "memory": { "content": "...", "summary": "...", "keywords": [], "entities": [], "importance": 0.8 } },',
    '    { "action": "merge",   "sourceMemoryIds": [2,3], "memory": { "kind": "event", "content": "...", "summary": "...", "keywords": [], "entities": [], "importance": 0.6 } },',
    '    { "action": "archive", "memoryId": 4, "reason": "已过时" }',
    '  ]',
    '}',
  ].join('\n')

  return [
    { role: 'system', content: system },
    { role: 'user',   content: user },
  ]
}

// ---------------------------------------------------------------------------
// DB/model glue: NightConsolidator
// ---------------------------------------------------------------------------

const EVENT_TABLE = 'life_sim_event'

/**
 * Create the NightConsolidator.
 *
 * @param {object} ctx     Koishi context with ctx.database
 * @param {object} config  Plugin config (needs config.consolidateModel)
 * @param {object} deps    { getModel, invoke, ltm, scheduler?, planner?, tidyThoughts? }
 * @returns {{ consolidate, registerHandler }}
 */
function createNightConsolidator(ctx, config, deps) {

  /**
   * Run the nightly short→long consolidation for a given presetId and day.
   *
   * Steps:
   *   1. Query day's unconsolidated life_sim_event rows
   *   2. clusterEvents → clusters
   *   3. For each cluster (sorted by score desc):
   *      a. Gather related LTM via byKey on cluster keywords
   *      b. Build prompt → model invoke → parseConsolidateOps
   *      c. Apply ops (keep=upsert new, update=upsert existing, merge=combine+archive sources, archive=archiveLtm)
   *      d. Mark cluster's life_sim_event rows consolidated=true
   *   4. Best-effort: deps.planner?.planDay(presetId, tomorrow)
   *   5. Best-effort: deps.tidyThoughts?.(presetId)
   *
   * @param {string} presetId
   * @param {string} day     YYYY-MM-DD
   * @param {number} nowMs   Explicit current timestamp in ms
   * @returns {Promise<{ processed: number, clusters: number }>}
   */
  async function consolidate(presetId, day, nowMs) {
    // 1. Query unconsolidated events for this day
    const allRows = await ctx.database.get(EVENT_TABLE, { presetId })
    const dayEvents = allRows.filter((r) => r.day === day && !r.consolidated)

    if (dayEvents.length === 0) {
      // Still do best-effort hooks
      _runHooks(presetId, day)
      return { processed: 0, clusters: 0 }
    }

    // 2. Cluster events
    const clusters = clusterEvents(dayEvents)

    // Attach nowMs for scoring
    for (const c of clusters) c.nowMs = nowMs

    // Sort clusters by score descending
    clusters.sort((a, b) => clusterScore(b) - clusterScore(a))

    let processedEvents = 0

    // 3. Process each cluster
    for (const cluster of clusters) {
      await _processCluster(presetId, cluster, nowMs)
      processedEvents += cluster.events.length
    }

    // 4 & 5. Best-effort hooks
    _runHooks(presetId, day)

    return { processed: processedEvents, clusters: clusters.length }
  }

  /**
   * Process a single cluster: get model ops, apply, mark events consolidated.
   */
  async function _processCluster(presetId, cluster, nowMs) {
    // Gather related LTM from all cluster keywords
    const allKeywords = []
    for (const e of cluster.events) {
      const kws = getKeywords(e)
      for (const kw of kws) {
        if (!allKeywords.includes(kw)) allKeywords.push(kw)
      }
    }

    // Retrieve related LTM entries (deduplicated)
    const relatedLtmMap = new Map()
    if (deps.ltm) {
      for (const kw of allKeywords.slice(0, 5)) {
        const entries = await deps.ltm.byKey(presetId, { thread: kw })
        for (const e of entries) relatedLtmMap.set(e.id, e)
      }
    }
    const relatedLtm = Array.from(relatedLtmMap.values())

    // Build prompt and call model
    let opsResult = { operations: [] }
    try {
      const model = await deps.getModel(config.consolidateModel || 'ollama/qwen2.5:7b')
      const messages = buildConsolidatePrompt(presetId, cluster.events, relatedLtm)
      const text = await deps.invoke(model, messages)
      opsResult = parseConsolidateOps(text)
    } catch (_err) {
      // Model unavailable — fall back to keep-all
      // Create one LTM entry per event as best-effort
      for (const event of cluster.events) {
        const kws = getKeywords(event)
        if (deps.ltm) {
          await deps.ltm.upsertLtm(presetId, {
            kind:       'event',
            content:    event.narrative || event.title || '',
            summary:    event.title     || '',
            keywords:   kws,
            entities:   getEntities(event),
            importance: event.importance != null ? event.importance : 0.3,
            refCount:   0,
          }, nowMs)
        }
      }
      // Mark events consolidated
      await _markConsolidated(cluster.events)
      return
    }

    // Apply operations
    if (deps.ltm) {
      await _applyOps(presetId, opsResult.operations, nowMs)
    }

    // Mark cluster events consolidated
    await _markConsolidated(cluster.events)
  }

  /**
   * Apply parsed ops to the LTM store.
   */
  async function _applyOps(presetId, operations, nowMs) {
    for (const op of operations) {
      try {
        if (op.action === 'keep') {
          // keep with a memory object → create new LTM entry
          if (op.memory && typeof op.memory === 'object') {
            await deps.ltm.upsertLtm(presetId, {
              kind:       op.memory.kind       || 'event',
              content:    op.memory.content    || '',
              summary:    op.memory.summary    || '',
              keywords:   op.memory.keywords   || [],
              entities:   op.memory.entities   || [],
              importance: op.memory.importance != null ? op.memory.importance : 0.3,
              refCount:   0,
              // No id → will create new
            }, nowMs)
          }
          // keep without memory → noop (existing LTM entry stays)

        } else if (op.action === 'update') {
          if (!op.memory || typeof op.memory !== 'object') continue
          await deps.ltm.upsertLtm(presetId, {
            id:         op.memoryId,
            kind:       op.memory.kind       || 'event',
            content:    op.memory.content    || '',
            summary:    op.memory.summary    || '',
            keywords:   op.memory.keywords   || [],
            entities:   op.memory.entities   || [],
            importance: op.memory.importance != null ? op.memory.importance : 0.3,
            refCount:   op.memory.refCount   != null ? op.memory.refCount   : 0,
          }, nowMs)

        } else if (op.action === 'merge') {
          // Create the merged entry
          const mergedEntry = op.memory && typeof op.memory === 'object' ? op.memory : {}
          if (mergedEntry.content || mergedEntry.summary) {
            await deps.ltm.upsertLtm(presetId, {
              kind:       mergedEntry.kind       || 'event',
              content:    mergedEntry.content    || '',
              summary:    mergedEntry.summary    || '',
              keywords:   mergedEntry.keywords   || [],
              entities:   mergedEntry.entities   || [],
              importance: mergedEntry.importance != null ? mergedEntry.importance : 0.3,
              refCount:   0,
            }, nowMs)
          }
          // Archive source entries
          if (Array.isArray(op.sourceMemoryIds)) {
            for (const sid of op.sourceMemoryIds) {
              await deps.ltm.archiveLtm(sid)
            }
          }

        } else if (op.action === 'archive') {
          if (op.memoryId != null) {
            await deps.ltm.archiveLtm(op.memoryId)
          }
        }
      } catch (_opErr) {
        // Individual op errors should not block the rest
      }
    }
  }

  /**
   * Mark a list of life_sim_event rows as consolidated=true.
   */
  async function _markConsolidated(events) {
    for (const event of events) {
      if (event.id != null) {
        try {
          await ctx.database.set(EVENT_TABLE, { id: event.id }, { consolidated: true })
        } catch (_) {
          // Best-effort; don't throw
        }
      }
    }
  }

  /**
   * Fire best-effort post-consolidation hooks.
   * Errors are swallowed (hooks are advisory).
   */
  function _runHooks(presetId, day) {
    const tomorrow = tomorrowOf(day)
    // Best-effort next-day plan
    if (deps.planner && typeof deps.planner.planDay === 'function') {
      Promise.resolve(deps.planner.planDay(presetId, tomorrow)).catch(() => {})
    }
    // Best-effort thought buffer tidy
    if (typeof deps.tidyThoughts === 'function') {
      Promise.resolve(deps.tidyThoughts(presetId)).catch(() => {})
    }
  }

  /**
   * Register the 'consolidate' handler with deps.scheduler.
   * The scheduler will call this handler when a 'consolidate' task fires.
   */
  function registerHandler() {
    if (!deps.scheduler || typeof deps.scheduler.registerHandler !== 'function') return
    deps.scheduler.registerHandler('consolidate', async (presetId, _type, payload, _task) => {
      const day = (payload && payload.day) ? payload.day : todayStr(Date.now())
      await consolidate(presetId, day, Date.now())
    })
  }

  return { consolidate, registerHandler }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // Pure helpers (exported for testing)
  clusterScore,
  clusterEvents,
  parseConsolidateOps,
  // Internal utilities (exported for testing)
  tomorrowOf,
  todayStr,
  // DB/model glue factory
  createNightConsolidator,
}
