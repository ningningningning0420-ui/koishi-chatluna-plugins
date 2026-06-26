'use strict'
const { Schema } = require('koishi')
const { ChatLunaPlugin } = require('koishi-plugin-chatluna/services/chat')
const { tool } = require('@langchain/core/tools')
const { z } = require('zod')
const lib = require('./lib')
exports.name = 'chatluna-memory-curator'
exports.inject = { required: ['chatluna', 'database', 'chatluna_living_memory'], optional: ['chatluna_character'] }
exports.Config = Schema.object({
  platform: Schema.string().default('onebot').description('entity 前缀用的平台名,与适配器一致'),
  profileFields: Schema.array(Schema.string()).default(['称呼', '好感度', '关键印象', '在意的事'])
    .description('档案字段模板:决定一份档案记哪些维度,按角色改'),
  profileMaxChars: Schema.number().default(600).min(100).description('单份档案封顶字符数'),
  recallTopK: Schema.number().default(6).min(1).max(30).description('recall 工具返回的事实条数'),
  weights: Schema.object({
    rel: Schema.number().default(1), imp: Schema.number().default(1), rec: Schema.number().default(1)
  }).description('三因子权重(相关/重要/新近)'),
  recencyTau: Schema.number().default(72).min(1).description('recency 半衰小时数'),
  embeddingModel: Schema.string().default('ollama/bge-m3:latest').description('relevance 用的嵌入模型(建议与 livingmemory 同一个)'),
  present: Schema.object({
    autoSurface: Schema.boolean().default(true).description('在场者档案自动浮出(关=改为 who_is_here 工具按需)'),
    cap: Schema.number().default(6).min(1).description('在场者档案上限 M'),
    windowN: Schema.number().default(30).min(1).description('判「在场」的近消息窗口条数'),
    variableName: Schema.string().default('present_people').description('注入变量名;预设里用 {present_people}')
  }).description('在场者'),
  backfillIntervalMinutes: Schema.number().default(10).min(1).description('entity 回填 sweep 间隔(分钟)'),
  triggerWhitelist: Schema.array(Schema.string()).default([])
    .description('护栏升级口:能触发写记忆的 QQ 号;留空=不限(默认放行)'),
  memoryCriteriaPrompt: Schema.string().role('textarea')
    .default('记下对你这个角色而言真正在意、会影响关系的事;别人单方面说的话标注「谁说的/存疑」,不直接当客观事实。')
    .description('记忆准则/口吻:喂给工具说明,引导何时记、怎么记'),
  toolDescriptions: Schema.object({
    get_profile: Schema.string().role('textarea').default('读取你对某位群友的档案(称呼/好感度/印象等)。'),
    set_profile: Schema.string().role('textarea').default('更新你对某位群友的档案:传要改的字段即可,会与现有档案合并;传空值表示删除该字段。'),
    recall: Schema.string().role('textarea').default('回想关于某人或某主题的记忆。给 entity 查某人,给 query 语义搜索。返回里带 id,可用于 forget。'),
    remember: Schema.string().role('textarea').default('记下一条关于某人的事实。'),
    forget: Schema.string().role('textarea').default('忘掉(软删)一条记忆,传它的 id。')
  }).description('5 个工具的说明(可按角色改写)'),
  debug: Schema.boolean().default(false)
})
const TABLE = 'living_memory_entry'
exports.apply = (ctx, config) => {
  const logger = ctx.logger('chatluna-memory-curator')
  ctx.model.extend(TABLE, {
    entity: { type: 'string', length: 64, nullable: true, initial: null },
    memKind: { type: 'string', length: 16, nullable: true, initial: null },
    lastAccessedAt: { type: 'timestamp', nullable: true, initial: null }
  })
  logger.info('memory-curator: extended %s with entity/memKind/lastAccessedAt', TABLE)

  const svc = ctx.chatluna_living_memory

  function scopeOf(session) {
    const presetId = svc.resolvePresetId(session, undefined)
    return svc.createScope(session.cid, presetId, session.userId, session.channelId, {})
  }
  async function getProfileRow(presetId, entity) {
    const rows = await ctx.database.get(TABLE, { presetId, entity, memKind: 'profile' })
    return rows[0] || null
  }
  async function setProfile(session, entity, patch) {
    const scope = scopeOf(session)
    const row = await getProfileRow(scope.presetId, entity)
    const merged = lib.mergeProfile(row ? row.content : '', patch, config.profileFields, config.profileMaxChars)
    if (row) {
      await ctx.database.set(TABLE, { id: row.id }, { content: merged, updatedAt: new Date() })
    } else {
      const created = await svc.createMemory(scope, { type: 'identity', content: merged, importance: 0.6 })
      await ctx.database.set(TABLE, { id: created.id }, { entity, memKind: 'profile', updatedAt: new Date() })
    }
    return merged
  }

  function canWrite(session) {
    const wl = config.triggerWhitelist
    return !wl || wl.length === 0 || wl.includes(String(session.userId))
  }

  const getProfileTool = tool(async (input, runConfig) => {
    const session = runConfig?.configurable?.session
    if (!session) return '[系统] 无会话上下文。'
    const scope = scopeOf(session)
    const row = await getProfileRow(scope.presetId, input.entity)
    return row ? row.content : `（还没有关于 ${input.entity} 的档案）`
  }, {
    name: 'get_profile',
    description: config.toolDescriptions.get_profile,
    schema: z.object({ entity: z.string().describe('人标识,格式 平台:号,如 onebot:123456') })
  })

  const setProfileTool = tool(async (input, runConfig) => {
    const session = runConfig?.configurable?.session
    if (!session) return '[系统] 无会话上下文。'
    if (!canWrite(session)) return '[系统] 无权写记忆。'
    const merged = await setProfile(session, input.entity, input.patch || {})
    return `[系统] 已更新 ${input.entity} 的档案:\n${merged}`
  }, {
    name: 'set_profile',
    description: config.toolDescriptions.set_profile,
    schema: z.object({
      entity: z.string().describe('人标识,格式 平台:号'),
      patch: z.record(z.string()).describe(`要改的字段→值;空值表示删除该字段。可用字段:${config.profileFields.join('、')}`)
    })
  })

  async function embedQuery(text) {
    try {
      const emb = await ctx.chatluna.createEmbeddings(config.embeddingModel)
      if (!emb || emb.value == null) return null
      return await emb.value.embedQuery(text)
    } catch (e) { return null }
  }

  const recallTool = tool(async (input, runConfig) => {
    const session = runConfig?.configurable?.session
    if (!session) return '[系统] 无会话上下文。'
    const scope = scopeOf(session)
    const where = { presetId: scope.presetId, memKind: 'fact', status: { $ne: 'superseded' } }
    if (input.entity) where.entity = input.entity
    const rows = await ctx.database.get(TABLE, where)
    if (!rows.length) return '（没有相关记忆）'
    const queryVec = input.query ? await embedQuery(input.query) : null
    const cands = rows.map((row) => ({ row, embedding: row.embedding }))
    const top = lib.rankCandidates(cands, queryVec, Date.now(),
      { weights: config.weights, tau: config.recencyTau, topK: config.recallTopK })
    if (top.length) {
      const now = new Date()
      await ctx.database.set(TABLE, { id: { $in: top.map((r) => r.id) } }, { lastAccessedAt: now })
    }
    return top.map((r) => `- [id:${r.id}] ${r.content}`).join('\n')
  }, {
    name: 'recall',
    description: config.toolDescriptions.recall,
    schema: z.object({
      entity: z.string().optional().describe('只查某人(平台:号),可省'),
      query: z.string().optional().describe('语义检索词,可省')
    })
  })

  const rememberTool = tool(async (input, runConfig) => {
    const session = runConfig?.configurable?.session
    if (!session) return '[系统] 无会话上下文。'
    if (!canWrite(session)) return '[系统] 无权写记忆。'
    const scope = scopeOf(session)
    const created = await svc.createMemory(scope, { type: 'fact', content: input.content, importance: input.importance ?? 0.5 })
    await ctx.database.set(TABLE, { id: created.id }, { entity: input.entity, memKind: 'fact' })
    const vec = await embedQuery(input.content)
    if (vec) await ctx.database.set(TABLE, { id: created.id }, { embedding: vec, embeddingModelId: config.embeddingModel })
    return `[系统] 记下了(id:${created.id})。`
  }, {
    name: 'remember',
    description: config.toolDescriptions.remember,
    schema: z.object({
      entity: z.string().describe('这条事实关于谁(平台:号)'),
      content: z.string().describe('事实内容'),
      importance: z.number().min(0).max(1).optional().describe('重要度 0–1,默认 0.5')
    })
  })

  const forgetTool = tool(async (input, runConfig) => {
    const session = runConfig?.configurable?.session
    if (!session) return '[系统] 无会话上下文。'
    if (!canWrite(session)) return '[系统] 无权改记忆。'
    await ctx.database.set(TABLE, { id: input.id, presetId: scopeOf(session).presetId }, { status: 'superseded', updatedAt: new Date() })
    return `[系统] 已忘掉 id:${input.id}(软删,可在 WebUI 恢复)。`
  }, {
    name: 'forget',
    description: config.toolDescriptions.forget,
    schema: z.object({ id: z.string().describe('要忘的记忆 id(从 recall 结果取)') })
  })

  const plugin = new ChatLunaPlugin(ctx, config, 'memory-curator', false)
  ctx.on('ready', () => {
    for (const [name, t] of [['get_profile', getProfileTool], ['set_profile', setProfileTool],
        ['recall', recallTool], ['remember', rememberTool], ['forget', forgetTool]]) {
      plugin.registerTool(name, {
        description: t.description,
        selector() { return true },
        authorization(session) { return true },
        meta: { source: 'extension', group: 'memory-curator', tags: ['memory'],
          defaultAvailability: { enabled: true, main: true, chatluna: true, characterScope: 'all' } },
        createTool() { return t }
      })
    }
    ctx.logger('chatluna-memory-curator').info('profile tools registered')
  })

  async function backfillSweep() {
    try {
      const rows = await ctx.database.get(TABLE, { memKind: null })
      let n = 0
      for (const row of rows) {
        const entity = lib.inferEntityFromRow(row, config.platform)
        await ctx.database.set(TABLE, { id: row.id }, { memKind: 'fact', entity: entity || null })
        if (entity) n++
      }
      if (config.debug) ctx.logger('chatluna-memory-curator').info('backfill: %d 行,其中 %d 标到 entity', rows.length, n)
    } catch (e) {
      ctx.logger('chatluna-memory-curator').warn('backfill 失败:%s', (e && e.message) || e)
    }
  }
  ctx.on('ready', () => { backfillSweep() })
  ctx.setInterval(() => backfillSweep(), 1000 * 60 * config.backfillIntervalMinutes)

  const groupInfoCache = new Map() // guildId -> { count, at }
  async function getGroupCount(session) {
    if (session.isDirect) return null
    const gid = session.guildId
    const cached = groupInfoCache.get(gid)
    if (cached && Date.now() - cached.at < 5 * 60_000) return cached.count
    try {
      const info = await session.bot.internal._request('get_group_info', { group_id: Number(gid), no_cache: false })
      const count = info?.data?.member_count ?? info?.member_count ?? null
      groupInfoCache.set(gid, { count, at: Date.now() })
      return count
    } catch (e) { return null }
  }

  function recentSpeakerEntities(session) {
    const cc = ctx.chatluna_character
    if (!cc || typeof cc.getMessages !== 'function') return []
    const key = session.isDirect ? `private:${session.userId}` : `group:${session.guildId}`
    let arr = []
    try { arr = cc.getMessages(key) || [] } catch (e) { arr = [] }
    const seen = new Set(), out = []
    for (let i = arr.length - 1; i >= 0 && out.length < config.present.windowN; i--) {
      const id = arr[i] && arr[i].id
      const ent = lib.toEntity(config.platform, id)
      if (ent && !seen.has(ent)) { seen.add(ent); out.push(ent) }
    }
    return out
  }

  if (config.present.autoSurface) {
    ctx.effect(() => ctx.chatluna.promptRenderer.registerFunctionProvider(config.present.variableName,
      async (_args, _vars, configurable) => {
        const session = configurable && configurable.session
        if (!session) return ''
        const ents = recentSpeakerEntities(session)
        if (!ents.length) return ''
        const scope = scopeOf(session)
        const rows = await ctx.database.get(TABLE, { presetId: scope.presetId, entity: { $in: ents }, memKind: 'profile' })
        const map = new Map(rows.map((r) => [r.entity, r.content]))
        const present = lib.selectPresent(ents, map, config.present.cap)
        const count = await getGroupCount(session)
        const header = session.isDirect ? null
          : `群规模 约${count ?? '?'}人 · 近期活跃${ents.length}人 · 你认识其中${present.length}人`
        const body = present.map((p) => `【${p.entity}】\n${p.content}`).join('\n\n')
        return [header, body].filter(Boolean).join('\n\n')
      }))
  }

  ctx.effect(() => () => {
    groupInfoCache.clear()
  })
}
