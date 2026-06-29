'use strict'
const fs = require('fs')
const { resolve, isAbsolute } = require('path')
const { Schema } = require('koishi')
const lib = require('./lib')

exports.name = 'chatluna-worldbook'
exports.inject = { required: ['chatluna'], optional: ['chatluna_character'] }

exports.Config = Schema.object({
  variableName: Schema.string().default('world_book')
    .description('注入变量名;在预设 input 块里用 {world_book} 占位。与 {living_memory}/{present_people} 命名空间隔离'),
  bookPaths: Schema.array(Schema.string()).default(['data/chathub/character/worldbooks/审神者职业手册.koishi.json'])
    .description('世界书 json 文件路径(相对 koishi baseDir 或绝对路径);可多本,条目合并'),
  scanDepth: Schema.number().default(3).min(1).max(20)
    .description('扫描最近几条消息找关键词(含 bot 与用户消息)'),
  budgetTokens: Schema.number().default(4000).min(100)
    .description('命中条目注入的 token 上限(防爆;超出按低优先丢弃)。还原优先,设宽松'),
  caseSensitive: Schema.boolean().default(false).description('英文关键词大小写敏感(全局默认,条目可覆盖)'),
  wholeWord: Schema.boolean().default(true).description('英文关键词整词匹配(中文恒子串;全局默认,条目可覆盖)'),
  debug: Schema.boolean().default(false).description('日志输出每轮命中/丢弃的条目')
})

exports.apply = (ctx, config) => {
  const logger = ctx.logger('chatluna-worldbook')

  // ── 加载世界书文件(可热重载)──
  let allEntries = []
  function resolvePath(p) {
    if (isAbsolute(p)) return p
    const baseDir = (ctx.loader && ctx.loader.baseDir) || process.cwd()
    return resolve(baseDir, p)
  }
  function loadBooks() {
    const merged = []
    for (const p of config.bookPaths) {
      const full = resolvePath(p)
      try {
        const json = JSON.parse(fs.readFileSync(full, 'utf8'))
        const entries = Array.isArray(json) ? json : (json.entries || [])
        for (const e of entries) if (e && e.enabled !== false) merged.push(e)
      } catch (err) {
        logger.warn('世界书加载失败 %s: %s', full, (err && err.message) || err)
      }
    }
    allEntries = merged
    const blue = merged.filter((e) => e.constant).length
    logger.info('世界书已加载: %d 条(蓝灯 %d / 绿灯 %d)', merged.length, blue, merged.length - blue)
  }

  ctx.on('ready', () => {
    loadBooks()
    // 文件热重载(防抖)
    let timer = null
    for (const p of config.bookPaths) {
      const full = resolvePath(p)
      try {
        const watcher = fs.watch(full, () => {
          if (timer) clearTimeout(timer)
          timer = setTimeout(() => { loadBooks() }, 300)
        })
        ctx.effect(() => () => watcher.close())
      } catch (e) { /* 文件不存在时 watch 失败,忽略 */ }
    }
  })

  // ── 会话 key:与 chatluna-character 的 getMessages 键一致 ──
  function sessionKeyOf(session) {
    if (!session) return null
    return session.isDirect ? `private:${session.userId}` : `group:${session.guildId}`
  }

  function recentMessages(session) {
    const cc = ctx.chatluna_character
    if (!cc || typeof cc.getMessages !== 'function') return []
    const key = sessionKeyOf(session)
    try { return cc.getMessages(key) || [] } catch (e) { return [] }
  }

  // ── 注入:{world_book} 函数提供器 ──
  ctx.effect(() => ctx.chatluna.promptRenderer.registerFunctionProvider(
    config.variableName,
    async (_args, _vars, configurable) => {
      const session = configurable && configurable.session
      if (!session || !allEntries.length) return ''
      const buffer = lib.buildScanBuffer(recentMessages(session), config.scanDepth)
      const { selected, dropped, usedTokens } = lib.selectEntries(allEntries, buffer, {
        budgetTokens: config.budgetTokens,
        caseSensitive: config.caseSensitive,
        wholeWord: config.wholeWord
      })
      if (config.debug) {
        logger.info('[%s] 命中 %d 条(约%d tokens): %s%s',
          sessionKeyOf(session), selected.length, usedTokens,
          selected.map((e) => e.comment).join(', ') || '(无)',
          dropped.length ? ` | 预算丢弃: ${dropped.map((e) => e.comment).join(', ')}` : '')
      }
      return lib.renderEntries(selected)
    }
  ))

  logger.info('chatluna-worldbook 已就绪,注入变量 {%s}', config.variableName)
}
