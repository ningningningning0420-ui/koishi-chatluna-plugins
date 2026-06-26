const { Schema } = require('koishi')
const { deriveKey, mergeById, isFresh } = require('./lib')

exports.name = 'chatluna-character-buffer-backup'

exports.inject = ['database', 'chatluna_character']

exports.Config = Schema.object({
  debounceMs: Schema.number()
    .default(3000)
    .min(500)
    .description('收到消息后多久把缓冲快照写入数据库（毫秒，防抖）'),
  maxAgeHours: Schema.number()
    .default(24)
    .min(0)
    .description('启动恢复时，超过这个小时数的旧存档不再灌回（0 = 不限）'),
  restoreCap: Schema.number()
    .default(100)
    .min(3)
    .max(100)
    .description('每个会话恢复的最大消息条数（对齐 chatluna-character 的 maxMessages 上限）'),
  debug: Schema.boolean().default(false).description('打印每次快照 / 恢复的条数')
})

const TABLE = 'chatluna_character_buffer'

exports.apply = (ctx, config) => {
  const logger = ctx.logger('chatluna-character-buffer-backup')
  const svc = ctx.chatluna_character

  ctx.database.extend(
    TABLE,
    {
      sessionKey: { type: 'string', length: 255 },
      messages: { type: 'text', nullable: true },
      updatedAt: { type: 'timestamp', nullable: false, initial: new Date() }
    },
    { autoInc: false, primary: 'sessionKey', unique: ['sessionKey'] }
  )

  // ---- 读 chatluna-character 内部缓冲（带 guard）----
  function getBuffer(key) {
    try {
      const arr = svc.getMessages(key)
      return Array.isArray(arr) ? arr : []
    } catch (e) {
      return []
    }
  }

  // 写私有字段 _messages：结构不对就告警 no-op，绝不让插件崩。
  function setBuffer(key, arr) {
    const store = svc && svc._messages
    if (store == null || typeof store !== 'object') {
      logger.warn('chatluna_character._messages 不可写（插件结构可能已变），跳过恢复 %s', key)
      return false
    }
    store[key] = arr
    return true
  }

  // ---- 快照写库（防抖）----
  const timers = {}
  async function snapshot(key) {
    try {
      const arr = getBuffer(key)
      if (arr.length < 1) return
      await ctx.database.upsert(TABLE, [
        { sessionKey: key, messages: JSON.stringify(arr), updatedAt: new Date() }
      ])
      if (config.debug) logger.info('快照 %s：%d 条', key, arr.length)
    } catch (e) {
      logger.warn('快照失败 %s：%s', key, (e && e.message) || e)
    }
  }
  function scheduleSnapshot(key) {
    if (timers[key]) clearTimeout(timers[key])
    timers[key] = setTimeout(() => {
      delete timers[key]
      snapshot(key)
    }, config.debounceMs)
  }

  // 每次有消息被收集 → 安排一次防抖快照
  ctx.on('chatluna_character/message_collect', (session) => {
    try {
      scheduleSnapshot(deriveKey(session))
    } catch (e) {
      logger.warn('调度快照失败：%s', (e && e.message) || e)
    }
  })

  // /清除记忆 → 删存档，保持诚实
  ctx.on('chatluna_character/clear-chat-history', (payload) => {
    const key = payload && payload.sessionKey
    if (!key) return
    if (timers[key]) {
      clearTimeout(timers[key])
      delete timers[key]
    }
    ctx.database.remove(TABLE, { sessionKey: key }).catch((e) =>
      logger.warn('删存档失败 %s：%s', key, (e && e.message) || e)
    )
  })

  // ---- 启动恢复（只跑一次）----
  let restored = false
  async function restore() {
    if (restored) return
    restored = true
    let rows
    try {
      rows = await ctx.database.get(TABLE, {})
    } catch (e) {
      logger.warn('读取存档失败，跳过恢复：%s', (e && e.message) || e)
      return
    }
    const now = Date.now()
    let ok = 0
    for (const row of rows) {
      if (!isFresh(row.updatedAt, config.maxAgeHours, now)) {
        if (config.debug) logger.info('跳过过期存档 %s', row.sessionKey)
        continue
      }
      let parsed
      try {
        parsed = JSON.parse(row.messages)
      } catch (e) {
        continue
      }
      if (!Array.isArray(parsed) || parsed.length < 1) continue
      const merged = mergeById(getBuffer(row.sessionKey), parsed, config.restoreCap)
      if (setBuffer(row.sessionKey, merged)) {
        ok++
        if (config.debug) logger.info('恢复 %s：%d 条', row.sessionKey, merged.length)
      }
    }
    logger.info('上下文恢复完成：%d 个会话', ok)
  }

  // chatluna_character + database 就绪后恢复。late-registered 的 ready
  // 监听器（热重载场景）koishi 会立即触发，故冷启动与保存配置都覆盖。
  ctx.on('ready', () => {
    restore()
  })

  // ---- dispose 兜底刷盘：正常重启 / 控制台 save 时抓最新态（含 bot 最后回复）----
  ctx.on('dispose', () => {
    let keys = []
    try {
      const store = svc && svc._messages
      if (store && typeof store === 'object') keys = Object.keys(store)
    } catch (e) {
      keys = []
    }
    for (const key of keys) {
      const arr = getBuffer(key)
      if (arr.length < 1) continue
      // fire-and-forget：dispose 不保证 await
      ctx.database
        .upsert(TABLE, [
          { sessionKey: key, messages: JSON.stringify(arr), updatedAt: new Date() }
        ])
        .catch(() => {})
    }
    for (const k of Object.keys(timers)) clearTimeout(timers[k])
  })
}
