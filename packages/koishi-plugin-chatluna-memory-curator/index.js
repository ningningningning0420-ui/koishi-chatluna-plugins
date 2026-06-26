'use strict'
const { Schema } = require('koishi')
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
exports.apply = (ctx) => {}
