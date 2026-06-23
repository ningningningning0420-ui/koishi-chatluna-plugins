const { Schema } = require('koishi')

exports.name = 'emoji-intents'

// 意图式表情注入(更省 token 的姊妹方案):把 emojiluna 的【标签/分类词表】注入 chatluna 提示词,
// 而不是把【每一张表情的完整 URL 清单】注入。模型只表达意图(发个「开心」的图),
// 由 emojiluna 的 /tags/:tag、/categories/:category 端点在服务器侧随机挑一张图发出。
//
// 收益:每轮主回复的 token 只随【标签数】增长,不随【图片数】增长。
// emojiluna 自带的 {emojis} 是「全量逐张 URL 清单」,图越多越贵(~40-55 tok/张);
// 本插件的 {emoji_intents} 是「词表」,几十个标签也就一两百 token,且封顶。
//
// 不在 koishi.yml 里启用本插件,它就完全不生效,零影响。安装/配置/使用见同目录 README.md。

exports.Config = Schema.object({
  selfUrl: Schema.string()
    .default('http://127.0.0.1:5140')
    .description('本 bot 的服务器地址,必须 = 本 bot 自己的端口,且与该 bot 的 emojiluna.selfUrl 保持一致'),
  backendPath: Schema.string()
    .default('/emojiluna')
    .description('emojiluna 的后端路径,与 emojiluna 插件的 backendPath 一致(默认 /emojiluna)'),
  mode: Schema.union(['tags', 'categories', 'both'])
    .default('tags')
    .description('注入哪种词表:tags=按情绪标签 / categories=按角色分类 / both=两者都注入'),
  maxTags: Schema.number()
    .min(5)
    .max(200)
    .default(40)
    .description('最多注入多少个标签(控制 token 上限)'),
  refreshIntervalMinutes: Schema.number()
    .min(1)
    .max(120)
    .default(5)
    .description('词表刷新间隔(分钟)。词表只在表情库增删时才变,无需太频繁'),
  variableName: Schema.string()
    .default('emoji_intents')
    .description('注入到 chatluna 的变量名;预设里用 {变量名} 引用,用 {if 变量名}…{/if} 做条件块'),
  debug: Schema.boolean().default(false).description('打印每次刷新的词表长度,首次配置时核对用')
})

exports.apply = (ctx, config) => {
  const logger = ctx.logger('emoji-intents')

  // 必须等 chatluna(提供 promptRenderer)与 emojiluna(提供表情库)都就绪
  ctx.inject(['chatluna', 'emojiluna'], async (ctx2) => {
    await ctx2.emojiluna.ready

    const base = config.selfUrl.replace(/\/+$/, '') + config.backendPath
    const STICKER_OPEN = '<' + 'sticker' + '>'
    const STICKER_CLOSE = '</' + 'sticker' + '>'

    const buildContent = async () => {
      const lines = []
      lines.push('你可以发表情包来配合气氛和情绪。想发图时,单独输出一条只含表情的消息:')
      lines.push(`${STICKER_OPEN}URL${STICKER_CLOSE}`)
      lines.push('URL 按下面规则自己拼,服务器会从对应标签/分类里随机挑一张合适的图发出(你不必、也无法指定具体哪一张):')

      if (config.mode === 'tags' || config.mode === 'both') {
        const isNoiseTag = (t) => t === '自动获取' || (typeof t === 'string' && t.startsWith('来自群'))
        const tags = (await ctx2.emojiluna.getAllTags()).filter((t) => t && !isNoiseTag(t)).slice(0, config.maxTags)
        if (tags.length) {
          lines.push(`· 按情绪/反应发:${base}/tags/<标签>`)
          lines.push(`  可用标签:${tags.join('、')}`)
        }
      }
      if (config.mode === 'categories' || config.mode === 'both') {
        const cats = (await ctx2.emojiluna.getCategories()).map((c) => c.name)
        if (cats.length) {
          lines.push(`· 按角色/题材发:${base}/categories/<分类>`)
          lines.push(`  可用分类:${cats.join('、')}`)
        }
      }

      lines.push('用法:挑图随性,不必每条都带;一条消息最多发一张;别人刚发的表情想跟图也可以原样回贴它的 URL。')
      return lines.join('\n')
    }

    const refresh = async () => {
      try {
        const content = await buildContent()
        ctx2.chatluna.promptRenderer.setVariable(config.variableName, content)
        if (config.debug) {
          logger.info(`已刷新 {${config.variableName}},长度 ${content.length} 字符`)
        }
      } catch (e) {
        logger.warn(`刷新表情意图词表失败: ${e.message}`)
      }
    }

    await refresh()
    ctx2.setInterval(() => refresh(), 1000 * 60 * config.refreshIntervalMinutes)

    // 表情库增删改时即时刷新词表
    ctx2.on('emojiluna/emoji-added', () => refresh())
    ctx2.on('emojiluna/emoji-updated', () => refresh())
    ctx2.on('emojiluna/emoji-deleted', () => refresh())
    ctx2.on('emojiluna/category-added', () => refresh())
    ctx2.on('emojiluna/category-deleted', () => refresh())

    // 插件停用时清掉变量,预设里的 {if emoji_intents} 块随即优雅消失
    ctx2.effect(() => () => ctx2.chatluna.promptRenderer.removeVariable(config.variableName))
  })
}
