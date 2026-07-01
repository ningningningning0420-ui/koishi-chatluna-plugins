'use strict'

// roll-prompt.js — Task 9: EventRoller prompt builder
//
// Pure function (offline-testable, no runtime deps, no new Date()):
//   buildRollPrompt(inputs) → [{role, content}, ...]
//
// §5.1 行动 roll 输入约定:
//   1. 角色 canon (persona — static, cache-friendly)
//   2. life-state (§5.2)
//   3. WorldContext (时段/天气/季节/地点)
//   4. 当前日程块 (DailyPlan 里此刻计划在做的 activity/location)
//   5. 当前可发生事件类型集 (EventRegistry 按 WorldContext 筛出)
//   6. 短期记忆 recent(presetId, n) 直取最近若干条
//   7. 主动外联沉默状态 (未回时长/连续未回数)
//   8. 指令: 先列 3–5 候选 beat (list-then-roll), 程序端随机抽 1
//
// "静态在前" means persona canon goes in a system message first, so prompt
// cache can reuse it across rolls for the same preset. Dynamic context follows
// in user messages so the system message stays stable.
//
// Output format instruction: §5.1 JSON schema embedded in the prompt.

// ---------------------------------------------------------------------------
// Section formatters — each returns a compact string
// ---------------------------------------------------------------------------

function _fmtLifeState(lifeState) {
  const ls = lifeState || {}
  const threads = Array.isArray(ls.open_threads) && ls.open_threads.length > 0
    ? ls.open_threads.map((t) => {
        if (typeof t === 'string') return '· ' + t
        return '· [' + (t.id || '?') + '] ' + (t.desc || '') + (t.due ? '（' + t.due + '）' : '')
      }).join('\n')
    : '（暂无）'

  return [
    '# 当前状态（life-state）',
    '地点：' + (ls.location || '未知'),
    '正在：' + (ls.current_activity || '无'),
    '心情：' + (ls.mood || 'neutral'),
    '未了之事：',
    threads,
  ].join('\n')
}

function _fmtWorld(world) {
  const w = world || {}
  return [
    '# 世界状态（WorldContext）',
    '时段：' + (w.timeOfDay || '未知'),
    '季节：' + (w.season || '未知'),
    '天气：' + (w.weather || '未知'),
    '本丸已知位置：' + (Array.isArray(w.locations) ? w.locations.join('、') : '本丸·主屋'),
  ].join('\n')
}

function _fmtBlock(block) {
  if (!block) return '# 当前日程块\n（无计划日程，自由时段）'
  return [
    '# 当前日程块',
    '活动：' + (block.activity || '自由'),
    '地点：' + (block.location || '未指定'),
    '来源：' + (block.source || 'routine'),
    block.assignedBy ? '安排者：' + block.assignedBy : null,
  ].filter(Boolean).join('\n')
}

function _fmtAvailableTypes(types) {
  if (!types || types.length === 0) {
    return '# 当前可发生事件类型\n（无，请用"思绪"或"随机活动"）'
  }
  const list = types.map((t) => {
    const weight = typeof t.weight === 'number' ? '（权重 ' + t.weight + '）' : ''
    return '· ' + (t.type || t) + weight
  }).join('\n')
  return '# 当前可发生事件类型（EventRegistry 筛出）\n' + list
}

function _fmtRecent(recentEvents) {
  if (!recentEvents || recentEvents.length === 0) {
    return '# 近期记忆（短期工作集）\n（暂无记录）'
  }
  const items = recentEvents.slice(0, 8).map((e) => {
    const title = e.title || '（无标题）'
    const narrative = e.narrative ? e.narrative.slice(0, 60) + (e.narrative.length > 60 ? '…' : '') : ''
    const mood = e.mood ? ' [' + e.mood + ']' : ''
    return '· ' + title + mood + (narrative ? '：' + narrative : '')
  })
  return '# 近期记忆（短期工作集，按时间倒序）\n' + items.join('\n')
}

function _fmtSilence(silenceState) {
  const ss = silenceState || {}
  if (!ss.lastMessageTs && !ss.unansweredCount) {
    return '# 主动外联沉默状态\n用户最近有回应，无沉默压力。'
  }
  const lines = ['# 主动外联沉默状态']
  if (ss.unansweredCount != null) {
    lines.push('连续未回次数：' + ss.unansweredCount)
  }
  if (ss.lastMessageAgoMin != null) {
    lines.push('上次发出消息距今：约 ' + ss.lastMessageAgoMin + ' 分钟')
  } else if (ss.lastMessageTs != null) {
    lines.push('上次发出消息时间戳：' + ss.lastMessageTs)
  }
  if (ss.note) lines.push('备注：' + ss.note)
  return lines.join('\n')
}

// ---------------------------------------------------------------------------
// JSON schema description (embedded in instruction for the model)
// ---------------------------------------------------------------------------

const SCHEMA_DESCRIPTION = `输出格式（JSON，不要在 JSON 外面多说废话，不带 markdown 代码块标记）：
{
  "candidates": ["候选 beat 1", "候选 beat 2", "候选 beat 3"],
  "chosen_index": 1,
  "event": {
    "title": "事件标题（≤20字）",
    "narrative": "第一人称叙述，单一 beat，≤150字",
    "event_type": "取自可发生类型集中的一个",
    "location": "本丸内或已授权外部地点",
    "participants": ["参与者姓名列表，无则空数组"],
    "mood": "本次事件后的心情",
    "duration_minutes": 40,
    "importance": 0.3,
    "threads_touched": ["相关未了之事 id 或描述，无则空数组"],
    "type": "context"
  },
  "plan_adherence": "followed",
  "replan_hint": "若偏离/打断计划，简述原因；否则留空字符串",
  "want_to_share": {
    "decision": "no",
    "target": "审神者",
    "reason": "不值当特意说",
    "draft": "",
    "thought": ""
  },
  "next_state": {
    "location": "更新后的地点",
    "current_activity": "更新后的正在做的事",
    "mood": "更新后的心情",
    "open_threads": []
  },
  "next_delay_minutes": 55
}

字段说明：
- candidates: 先列出 3–5 个本时段内可能发生的小事（候选 beat），简短短语即可
- chosen_index: 你倾向的候选序号（0-based），程序会参考但不一定采用
- event.event_type: 必须取自"当前可发生事件类型"列表中的一个
- plan_adherence: followed（照计划做）| deviated（自发偏离）| interrupted（外因打断）| free（无计划自由）
- want_to_share.decision: now（立即分享）| later（存入心事）| no（不说）
- want_to_share.draft: 仅 decision=now 时填写，禁止情感操控/挽留话术，只分享真实发生的事
- want_to_share.thought: 仅 decision=later 时填写
- next_delay_minutes: 下次 wake 的建议间隔（分钟），一般 30–120
- importance: 0–1，仅用于沉淀优先级，勿高估`

// ---------------------------------------------------------------------------
// buildRollPrompt — pure, offline-testable, NO new Date()
// ---------------------------------------------------------------------------

/**
 * Build the messages array for the roll LLM call.
 *
 * §5.1 ordering constraint: STATIC content (persona canon) FIRST in a system
 * message so that the prompt prefix can be cached by the model provider.
 * Dynamic context (life-state, world, plan, events, memory, silence) follows
 * in a user message.
 *
 * @param {object} inputs
 * @param {string}   inputs.persona           – static persona/canon text (from worldbook)
 * @param {object}   inputs.lifeState         – §5.2 life-state object
 * @param {object}   inputs.world             – WorldContext object
 * @param {object|null} inputs.block          – current plan block or null
 * @param {Array}    inputs.availableTypes    – [{type, weight}] from EventRegistry
 * @param {Array}    inputs.recentEvents      – recent short-term memory events
 * @param {object}   inputs.silenceState      – {unansweredCount, lastMessageAgoMin, ...}
 * @returns {Array<{role: string, content: string}>}
 */
function buildRollPrompt(inputs) {
  const {
    persona,
    lifeState,
    world,
    block,
    availableTypes,
    recentEvents,
    silenceState,
  } = inputs || {}

  // ── System message: STATIC persona canon (cache-friendly prefix) ──────────
  const personaText = (typeof persona === 'string' && persona.trim())
    ? persona.trim()
    : '（角色人设未加载，请按角色一贯人格行事）'

  const systemContent = [
    '# 角色人设（canon，静态）',
    personaText,
    '',
    '你是这个角色。现在进行一次"本丸日常 roll"，在当前时间段内发生一件小事。',
    '严格遵守人设，不违反以下硬规则：',
    '· 不创造新命名角色，不发生重大伤亡事件',
    '· 地点只能在本丸内或已授权的外部地点',
    '· 事件类型必须取自可发生类型集',
    '· narrative 只写单一 beat（一件小事），第一人称，≤150字',
    '· want_to_share.draft 禁止情感操控/挽留/催回复话术，只分享真实发生的事',
  ].join('\n')

  // ── User message: dynamic context ─────────────────────────────────────────
  const dynamicSections = [
    _fmtLifeState(lifeState),
    '',
    _fmtWorld(world),
    '',
    _fmtBlock(block),
    '',
    _fmtAvailableTypes(availableTypes),
    '',
    _fmtRecent(recentEvents),
    '',
    _fmtSilence(silenceState),
    '',
    '---',
    '',
    '现在请：',
    '1. 先在 candidates 列出 3–5 个本时段内可能发生的小事',
    '2. 选一个最贴合人设和计划的，填进 event',
    '3. 按格式输出完整 JSON（不要多余文字，不要 markdown 代码块）',
    '',
    SCHEMA_DESCRIPTION,
  ].join('\n')

  return [
    { role: 'system', content: systemContent },
    { role: 'user', content: dynamicSections },
  ]
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  buildRollPrompt,
  // Exported for testing / potential reuse:
  _fmtLifeState,
  _fmtWorld,
  _fmtBlock,
  _fmtAvailableTypes,
  _fmtRecent,
  _fmtSilence,
  SCHEMA_DESCRIPTION,
}
