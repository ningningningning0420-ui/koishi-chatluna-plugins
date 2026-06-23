const { Schema } = require('koishi')

exports.name = 'emoji-recall'

// 按轮语义召回:每次生成回复、渲染预设时,用当前对话文本做查询,
// 经 embeddings(默认 ollama bge-m3)对 emojiluna 表情库做向量相似度检索,
// 只注入最相关的 K 张表情。
// 用 chatluna 的 function-provider 实现 {emojis_smart}(与 livingmemory 的 {living_memory} 同机制),
// 每轮即时计算。token 只占 K 张、且与当前对话相关。
//
// 不在 koishi.yml 启用 + 预设不引用 {emojis_smart} = 完全不生效、零影响。
// 安装/配置/使用见同目录 README.md 或发布包根目录的《安装与使用指南.md》。

exports.Config = Schema.intersect([
  Schema.object({
    selfUrl: Schema.string()
      .default('http://127.0.0.1:5140')
      .description('本 bot 的服务器地址,必须 = 本 bot 自己的端口,且与该 bot 的 emojiluna.selfUrl 完全一致'),
    backendPath: Schema.string().default('/emojiluna').description('emojiluna 后端路径,与 emojiluna.backendPath 一致'),
    topK: Schema.number().min(1).max(30).default(6).description('每轮注入多少张最相关的表情'),
    functionName: Schema.string()
      .default('emojis_smart')
      .description('注册的函数变量名;预设里用 {函数名} 引用(无参用配置的 topK)')
  }).description('基础'),
  Schema.object({
    embeddingModel: Schema.string()
      .default('ollama/bge-m3:latest')
      .description('向量模型 id,格式 platform/model;需是你的 chatluna 能调用的 embeddings(建议与 livingmemory 用同一个)'),
    minScore: Schema.number()
      .min(0).max(1).role('slider').step(0.01).default(0)
      .description('相似度下限。0=永远取 topK;调高可在"没有够相关的图"时少注入甚至不注入'),
    useReranker: Schema.boolean().default(false).description('是否再用 reranker 精排(多一次网络调用,默认关)'),
    rerankModel: Schema.string()
      .default('siliconflow/BAAI/bge-reranker-v2-m3')
      .description('reranker 模型 id(useReranker 开时用)')
  }).description('检索模型'),
  Schema.object({
    maxQueryChars: Schema.number().min(20).max(2000).default(200).description('查询文本最大长度(取当前消息尾部)'),
    fallbackToRecent: Schema.boolean()
      .default(true)
      .description('当无对话文本(如定时触发)或 embeddings 不可用时,是否退化为注入最近 K 张(关=注入空)'),
    debug: Schema.boolean().default(false).description('打印每轮的查询与命中表情+分数')
  }).description('其它')
])

function cosineSimilarity(a, b) {
  if (!a || !b || a.length !== b.length) return 0
  let dot = 0, na = 0, nb = 0
  for (let i = 0; i < a.length; i++) {
    dot += a[i] * b[i]
    na += a[i] * a[i]
    nb += b[i] * b[i]
  }
  if (na === 0 || nb === 0) return 0
  return dot / (Math.sqrt(na) * Math.sqrt(nb))
}

exports.apply = (ctx, config) => {
  const logger = ctx.logger('emoji-recall')

  ctx.inject(['chatluna', 'emojiluna'], (ctx2) => {
    const base = config.selfUrl.replace(/\/+$/, '') + config.backendPath

    // 过滤记账标签(自动获取 / 来自群:xxx),它们是噪声,不进向量、不展示
    const isNoiseTag = (t) => t === '自动获取' || (typeof t === 'string' && t.startsWith('来自群'))
    const cleanTags = (tags) => (tags || []).filter((t) => t && !isNoiseTag(t))

    // 表情向量缓存:id -> { hash, vector }。仅在表情文本变化时重算。
    const cache = new Map()
    const emojiText = (e) => [e.name, e.category, cleanTags(e.tags).join(' ')].filter(Boolean).join(' ')
    const textHash = (s) => {
      let h = 0
      for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) | 0
      return h
    }
    const escapeMd = (t) => String(t).replace(/([[\]()])/g, '\\$1')
    const fmtList = (emojis) =>
      emojis
        .map(
          (e) =>
            `- [${escapeMd(e.name)}](${base}/get/${encodeURIComponent(e.id)}) - 分类: ${e.category}, 标签: ${cleanTags(e.tags).join(', ')}`
        )
        .join('\n')

    ctx2.on('emojiluna/emoji-deleted', (id) => cache.delete(id))
    ctx2.on('emojiluna/emoji-updated', (e) => e && cache.delete(e.id))

    const ensureVectors = async (embeddings, emojis) => {
      const missing = []
      for (const e of emojis) {
        const t = emojiText(e)
        const h = textHash(t)
        const c = cache.get(e.id)
        if (!c || c.hash !== h) missing.push({ id: e.id, t, h })
      }
      if (!missing.length) return
      const vectors = await embeddings.embedDocuments(missing.map((m) => m.t))
      missing.forEach((m, i) => cache.set(m.id, { hash: m.h, vector: vectors[i] }))
    }

    ctx2.effect(() =>
      ctx2.chatluna.promptRenderer.registerFunctionProvider(
        config.functionName,
        async (args, _variables, configurable) => {
          try {
            const K = Math.max(1, parseInt(args && args[0], 10) || config.topK)
            const emojis = await ctx2.emojiluna.getEmojiList()
            if (!emojis.length) return ''

            // 查询文本 = 当前消息(去掉 <at/>、<img/> 等元素噪声与 URL,取尾部 maxQueryChars)
            const session = configurable && configurable.session
            let query = ((session && session.content) || '')
              .replace(/<[^>]*>/g, ' ')
              .replace(/https?:\/\/\S+/g, ' ')
              .replace(/\s+/g, ' ')
              .trim()
            if (query.length > config.maxQueryChars) query = query.slice(-config.maxQueryChars)

            const embeddings = await ctx2.chatluna.createEmbeddings(config.embeddingModel)
            const embOk = embeddings && embeddings.value != null

            // 无查询文本 / embeddings 不可用 → 优雅降级
            if (!query || !embOk) {
              if (config.debug) logger.info(`fallback (query=${!!query}, emb=${embOk}) → ${config.fallbackToRecent ? 'recent ' + K : 'empty'}`)
              return config.fallbackToRecent ? fmtList(emojis.slice(0, K)) : ''
            }

            await ensureVectors(embeddings.value, emojis)
            const queryVector = await embeddings.value.embedQuery(query)

            let scored = emojis
              .map((e) => ({ e, score: cosineSimilarity(queryVector, (cache.get(e.id) || {}).vector) }))
              .sort((a, b) => b.score - a.score)
            if (config.minScore > 0) scored = scored.filter((s) => s.score >= config.minScore)

            let top = scored.slice(0, config.useReranker ? K * 3 : K)

            if (config.useReranker && top.length > 1) {
              try {
                const reranker = await ctx2.chatluna.createReranker(config.rerankModel)
                if (reranker && reranker.value != null) {
                  const rr = await reranker.value.rerank(top.map((s) => emojiText(s.e)), query, { topN: K })
                  top = rr.map((r) => top[r.index]).filter(Boolean)
                }
              } catch (err) {
                logger.warn(`rerank failed: ${err.message}`)
              }
            }
            top = top.slice(0, K)

            if (config.debug) {
              logger.info(`query="${query.slice(0, 30)}" → ${top.map((s) => `${s.e.name}(${(s.score || 0).toFixed(2)})`).join(', ') || '(空)'}`)
            }
            if (!top.length) return ''
            return fmtList(top.map((s) => s.e))
          } catch (e) {
            logger.warn(`emoji recall failed: ${e.message}`)
            return ''
          }
        }
      )
    )

    logger.info(`emoji-recall ready (function {${config.functionName}}, base=${base})`)
  })
}
