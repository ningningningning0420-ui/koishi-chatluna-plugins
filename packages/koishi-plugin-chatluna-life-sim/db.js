'use strict'

// DB table definitions for koishi-plugin-chatluna-life-sim.
// All tables match the schema in 设计文档 §4.1, §4.2, §5.2, §5.3, §5.4, §5.7, §5.9.
// Call registerTables(ctx) once at plugin load (before 'ready').

function registerTables(ctx) {
  // §4.1 短期记忆流 / 事件流
  // life_sim_event: 当天/近期缓存，滑动窗口（stmDays / stmMax）
  ctx.database.extend(
    'life_sim_event',
    {
      id: { type: 'integer', nullable: false },
      presetId: { type: 'string', length: 255 },
      day: { type: 'string', length: 10 },       // YYYY-MM-DD
      ts: { type: 'timestamp', nullable: false, initial: new Date() },
      title: { type: 'string', length: 255 },
      narrative: { type: 'text', nullable: true },
      event_type: { type: 'string', length: 100, nullable: true },
      location: { type: 'string', length: 255, nullable: true },
      participants: { type: 'text', nullable: true },  // JSON array
      mood: { type: 'string', length: 100, nullable: true },
      duration_min: { type: 'integer', nullable: true },
      importance: { type: 'float', nullable: true },   // 0-1
      threads: { type: 'text', nullable: true },       // JSON array
      plan_adherence: { type: 'string', length: 50, nullable: true }, // followed|deviated|interrupted|free
      type: { type: 'string', length: 50, nullable: true },           // context|interaction|…
      consolidated: { type: 'boolean', initial: false },
      sourceModel: { type: 'string', length: 255, nullable: true },
    },
    { autoInc: true, primary: 'id' }
  )

  // §4.2 长期记忆条目
  // life_sim_ltm: 沉淀后的重要事件/洞见/习惯
  ctx.database.extend(
    'life_sim_ltm',
    {
      id: { type: 'integer', nullable: false },
      presetId: { type: 'string', length: 255 },
      kind: { type: 'string', length: 50 },     // event|insight|habit
      content: { type: 'text', nullable: true },
      summary: { type: 'text', nullable: true },
      keywords: { type: 'text', nullable: true },  // JSON array
      entities: { type: 'text', nullable: true },  // JSON array
      importance: { type: 'float', nullable: true },
      refCount: { type: 'integer', initial: 0 },
      createdAt: { type: 'timestamp', nullable: false, initial: new Date() },
      lastAccessedAt: { type: 'timestamp', nullable: true },
      embedding: { type: 'text', nullable: true }, // JSON float array, optional
    },
    { autoInc: true, primary: 'id' }
  )

  // §4.2 关系档案（各 bot 本地存自己视角）
  // life_sim_relationship: presetId(我) + otherKey(对方称呼) → 一条
  ctx.database.extend(
    'life_sim_relationship',
    {
      id: { type: 'integer', nullable: false },
      presetId: { type: 'string', length: 255 },    // 我
      otherKey: { type: 'string', length: 255 },    // 对方称呼/key（如 '膝丸'）
      summary: { type: 'text', nullable: true },    // 我对这段关系的滚动摘要
      openThreads: { type: 'text', nullable: true }, // JSON array
      tone: { type: 'string', length: 100, nullable: true }, // 我眼里的关系基调
      lastChatId: { type: 'string', length: 255, nullable: true },
      updatedAt: { type: 'timestamp', nullable: false, initial: new Date() },
    },
    { autoInc: true, primary: 'id', unique: [['presetId', 'otherKey']] }
  )

  // §5.2 life-state 状态对象（防漂移锚）
  // life_sim_state: 每个 presetId 一条，roll 后覆盖更新
  ctx.database.extend(
    'life_sim_state',
    {
      presetId: { type: 'string', length: 255 },
      location: { type: 'string', length: 255, nullable: true },
      current_activity: { type: 'string', length: 255, nullable: true },
      mood: { type: 'string', length: 100, nullable: true },
      open_threads: { type: 'text', nullable: true },        // JSON array
      recent_event_ids: { type: 'text', nullable: true },    // JSON array
      updatedAt: { type: 'timestamp', nullable: false, initial: new Date() },
    },
    { autoInc: false, primary: 'presetId' }
  )

  // §5.3 常规日程模板（bot 自著）
  // life_sim_routine: 每个 presetId 一条，存 weekly 日程 JSON
  ctx.database.extend(
    'life_sim_routine',
    {
      id: { type: 'integer', nullable: false },
      presetId: { type: 'string', length: 255 },
      authoredBy: { type: 'string', length: 50 },    // self|seed
      revisedAt: { type: 'timestamp', nullable: true },
      weekly: { type: 'text', nullable: true },       // JSON { default: [...blocks] }
    },
    { autoInc: true, primary: 'id', unique: ['presetId'] }
  )

  // §5.3 每日计划
  // life_sim_plan: 每个 presetId 每天一条
  ctx.database.extend(
    'life_sim_plan',
    {
      id: { type: 'integer', nullable: false },
      presetId: { type: 'string', length: 255 },
      day: { type: 'string', length: 10 },    // YYYY-MM-DD
      blocks: { type: 'text', nullable: true }, // JSON array of {start,activity,location,source,assignedBy,status}
      generatedAt: { type: 'timestamp', nullable: false, initial: new Date() },
    },
    { autoInc: true, primary: 'id', unique: [['presetId', 'day']] }
  )

  // §5.3 被安排队列
  // life_sim_assignment: 来自约定/审神者/近侍/主控
  ctx.database.extend(
    'life_sim_assignment',
    {
      id: { type: 'integer', nullable: false },
      presetId: { type: 'string', length: 255 },
      desc: { type: 'text', nullable: true },
      dueDay: { type: 'string', length: 10, nullable: true },    // YYYY-MM-DD
      dueBlock: { type: 'string', length: 50, nullable: true },  // block name
      source: { type: 'string', length: 50 },   // 约定|审神者|近侍|主控
      assignedBy: { type: 'string', length: 255, nullable: true },
      status: { type: 'string', length: 50, initial: 'pending' }, // pending|done|skipped|cancelled
      threadId: { type: 'string', length: 255, nullable: true },
    },
    { autoInc: true, primary: 'id' }
  )

  // §5.4 WorldContext（本 agent 私有，P1；P3 升为跨进程共享）
  // life_sim_world: 每个 presetId 一条（P1；P3 时共享存储另建）
  ctx.database.extend(
    'life_sim_world',
    {
      presetId: { type: 'string', length: 255 },
      clock: { type: 'integer', nullable: true },       // unix timestamp
      timeOfDay: { type: 'string', length: 50, nullable: true },
      season: { type: 'string', length: 50, nullable: true },
      weather: { type: 'string', length: 50, nullable: true },
      locations: { type: 'text', nullable: true },          // JSON array（本丸内）
      externalLocations: { type: 'text', nullable: true },  // JSON array（已授权外部）
      updatedAt: { type: 'timestamp', nullable: false, initial: new Date() },
    },
    { autoInc: false, primary: 'presetId' }
  )

  // §5.7 心事簿 ThoughtBuffer
  // life_sim_thought: want_to_share=later 或"想说未说"的念头
  ctx.database.extend(
    'life_sim_thought',
    {
      id: { type: 'integer', nullable: false },
      presetId: { type: 'string', length: 255 },
      content: { type: 'text', nullable: true },
      target: { type: 'string', length: 255, nullable: true }, // 审神者|presetId|self
      origin: { type: 'string', length: 255, nullable: true },
      urgency: { type: 'string', length: 50, nullable: true },
      status: { type: 'string', length: 50, initial: 'pending' }, // pending|surfaced|dropped|merged
      relatedThreadId: { type: 'string', length: 255, nullable: true },
      createdAt: { type: 'timestamp', nullable: false, initial: new Date() },
      revisedAt: { type: 'timestamp', nullable: true },
    },
    { autoInc: true, primary: 'id' }
  )

  // §5.9 持久化调度任务
  // life_sim_task: 保证重启不丢闹钟
  ctx.database.extend(
    'life_sim_task',
    {
      id: { type: 'integer', nullable: false },
      presetId: { type: 'string', length: 255 },
      fireAt: { type: 'timestamp', nullable: false },
      type: { type: 'string', length: 50 }, // roll|block|consolidate|prune|plan|reflect
      status: { type: 'string', length: 50, initial: 'pending' }, // pending|running|done|cancelled
      payload: { type: 'text', nullable: true }, // JSON arbitrary context
    },
    { autoInc: true, primary: 'id' }
  )
}

module.exports = { registerTables }
