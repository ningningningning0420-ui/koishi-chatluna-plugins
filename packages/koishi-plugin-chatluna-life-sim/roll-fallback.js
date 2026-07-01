'use strict'

// roll-fallback.js — Task 9: EventRoller fallback (no-model template pool)
//
// Pure function (offline-testable, no runtime deps, no new Date()):
//   fallbackRoll(availableTypes, world, lifeState, r) → event object
//
// Used when:
//   - The model is unavailable (config.fallbackToTemplate = true)
//   - Model call fails / parse fails and no retry budget remains
//
// Design refs: §5.1 fallbackToTemplate / §1.3 "纯随机事件池兜底"
//
// Returns a valid §5.1 event shape (sans candidates/chosen_index/want_to_share/
// next_state/next_delay_minutes — those are filled by the roller glue).

// ---------------------------------------------------------------------------
// Template pool — keyed by event type
// Each template: { title, narrativeFn(world, lifeState), mood, duration_minutes, importance }
// narrativeFn must NOT call new Date()
// ---------------------------------------------------------------------------

const TEMPLATES = {
  '练习': [
    {
      title: '练习场的独自一刻',
      narrativeFn: (w, ls) => '在练习场挥了一会儿刀，汗出得刚好。' + _seasonNote(w),
      mood: '平静',
      duration_minutes: 60,
      importance: 0.2,
    },
    {
      title: '刀身保养',
      narrativeFn: (w, ls) => '把刀取出来细细擦过一遍，油布来回几下，镜面般的刀身倒映出窗外的天色。',
      mood: '专注',
      duration_minutes: 30,
      importance: 0.15,
    },
  ],
  '檐下发呆': [
    {
      title: '檐下随想',
      narrativeFn: (w, ls) => '靠着柱子发了会儿呆，' + _weatherNote(w) + '思绪随风散了。',
      mood: '慵懒',
      duration_minutes: 40,
      importance: 0.1,
    },
    {
      title: '庭院赏景',
      narrativeFn: (w, ls) => '在庭院里站了片刻，' + _seasonNote(w) + '无事可想，倒也轻松。',
      mood: '悠闲',
      duration_minutes: 25,
      importance: 0.1,
    },
  ],
  '夜巡': [
    {
      title: '夜间例行巡视',
      narrativeFn: (w, ls) => '绕本丸走了一圈，四下无声，' + _weatherNote(w) + '一切如常。',
      mood: '平静',
      duration_minutes: 45,
      importance: 0.15,
    },
  ],
  '角色互动': [
    {
      title: '本丸闲聊',
      narrativeFn: (w, ls) => '和本丸里的人随意说了几句，没什么要紧事，只是打了个照面。',
      mood: '平常',
      duration_minutes: 20,
      importance: 0.2,
    },
  ],
  '思绪': [
    {
      title: '心中一念',
      narrativeFn: (w, ls) => '脑子里忽然转过一个念头，想着想着便放下了。' + _seasonNote(w),
      mood: 'neutral',
      duration_minutes: 15,
      importance: 0.1,
    },
    {
      title: '片刻出神',
      narrativeFn: (w, ls) => '不知在想什么，出了会儿神，' + _weatherNote(w) + '回过神来已过去一刻钟。',
      mood: '恍惚',
      duration_minutes: 15,
      importance: 0.1,
    },
  ],
}

// Generic fallback when no type matches templates
const GENERIC_TEMPLATE = {
  title: '本丸一隅',
  narrativeFn: (w, ls) => '在本丸里走动了一圈，' + _weatherNote(w) + '无甚特别的事，却也不无聊。',
  mood: 'neutral',
  duration_minutes: 30,
  importance: 0.1,
}

// ---------------------------------------------------------------------------
// Season/weather note helpers (pure, no new Date())
// ---------------------------------------------------------------------------

function _seasonNote(world) {
  const season = world && world.season
  if (season === '春') return '春风带着新叶气息。'
  if (season === '夏') return '暑气有些沉。'
  if (season === '秋') return '秋意已深，叶片转了颜色。'
  if (season === '冬') return '寒气往领口里钻。'
  return ''
}

function _weatherNote(world) {
  const weather = world && world.weather
  if (weather === '晴') return '晴天，光线很好，'
  if (weather === '多云') return '云层遮住了阳光，'
  if (weather === '雨') return '屋檐滴着细雨，'
  if (weather === '阴') return '天色阴着，'
  return ''
}

// ---------------------------------------------------------------------------
// fallbackRoll — pure, offline-testable, NO new Date()
// ---------------------------------------------------------------------------

/**
 * Produce a structured event from a template pool without calling the model.
 *
 * Steps:
 * 1. Pick a type from availableTypes using r (injected random ∈ [0,1)).
 * 2. Look up the template list for that type; pick a template using r2.
 * 3. Fill narrative via template.narrativeFn(world, lifeState).
 * 4. Return a §5.1-compatible event object.
 *
 * @param {Array}       availableTypes   [{type, weight}] from EventRegistry.available()
 * @param {object}      world            WorldContext
 * @param {object}      lifeState        Current life-state (§5.2)
 * @param {number}      [r]              Random value ∈ [0, 1), injected for determinism
 * @returns {object}  Event object with shape matching §5.1 event field
 */
function fallbackRoll(availableTypes, world, lifeState, r) {
  const rng = (typeof r === 'number' && r >= 0 && r < 1) ? r : Math.random()

  // ── 1. Pick an event type ────────────────────────────────────────────────
  let chosenType = null

  if (availableTypes && availableTypes.length > 0) {
    // Weighted pick using rng
    const total = availableTypes.reduce((s, t) => s + (typeof t.weight === 'number' ? t.weight : 1), 0)
    if (total > 0) {
      const threshold = rng * total
      let cursor = 0
      for (const t of availableTypes) {
        cursor += (typeof t.weight === 'number' ? t.weight : 1)
        if (threshold < cursor) {
          chosenType = t.type || t
          break
        }
      }
    }
    if (!chosenType) {
      chosenType = availableTypes[availableTypes.length - 1].type || availableTypes[availableTypes.length - 1]
    }
  }

  // ── 2. Pick a template for the chosen type ───────────────────────────────
  const templateList = chosenType && TEMPLATES[chosenType]
  let template

  if (templateList && templateList.length > 0) {
    // Use a derived second random (fold rng to avoid exact same split)
    const r2 = (rng * 7 + 0.3) % 1
    const idx = Math.floor(r2 * templateList.length)
    template = templateList[Math.min(idx, templateList.length - 1)]
  } else {
    template = GENERIC_TEMPLATE
    // If no template list but type is known, use generic with a type note
    if (!chosenType) chosenType = '思绪'
  }

  // ── 3. Fill the event ────────────────────────────────────────────────────
  const location = (lifeState && lifeState.location)
    || (world && Array.isArray(world.locations) && world.locations[0])
    || '本丸·主屋'

  const narrative = template.narrativeFn
    ? template.narrativeFn(world || {}, lifeState || {})
    : template.narrative || '在本丸里度过了一段时光。'

  return {
    title: template.title,
    narrative,
    event_type: chosenType || '思绪',
    location,
    participants: [],
    mood: template.mood || 'neutral',
    duration_minutes: template.duration_minutes || 30,
    importance: template.importance || 0.1,
    threads_touched: [],
    type: 'context',
    sourceModel: 'fallback-template',
  }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  fallbackRoll,
  TEMPLATES,
  // Exported helpers for testing
  _seasonNote,
  _weatherNote,
}
