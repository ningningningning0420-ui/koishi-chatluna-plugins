'use strict'

// Config schema for koishi-plugin-chatluna-life-sim.
// All fields and defaults match 设计文档 §8 verbatim.

const { Schema } = require('koishi')

const Config = Schema.object({
  // ---- 模型 ----
  rollModel: Schema.string()
    .default('ollama/qwen2.5:7b')
    .description('行动 roll 用的便宜模型（platform/model）。默认本地 ollama 免费；也可填 openai-like/gemini-2.5-flash。'),
  consolidateModel: Schema.string()
    .default('claude/claude-opus-4-6')
    .description('夜间沉淀 / 反思用的主模型（platform/model）。'),
  fallbackToTemplate: Schema.boolean()
    .default(true)
    .description('模型 roll 失败时，回退到随机模板池。'),

  // ---- 节奏 ----
  idleThresholdMin: Schema.number()
    .default(30)
    .min(1)
    .description('闲置多久（分钟）后触发 roll。'),
  quietHours: Schema.object({
    start: Schema.number().default(22).min(0).max(23).description('安静时段开始（小时，24h）'),
    end: Schema.number().default(8).min(0).max(23).description('安静时段结束（小时，24h）'),
  }).description('安静时段：此范围内不触发主动行为。'),
  sleepHour: Schema.number()
    .default(23)
    .min(0)
    .max(23)
    .description('夜间「睡觉」触发小时（24h），触发夜间沉淀 + 次日计划生成。'),
  dailyRollCap: Schema.number()
    .default(24)
    .min(1)
    .description('每日最多 roll 次数上限（防失控）。'),
  defaultNextDelayMin: Schema.number()
    .default(60)
    .min(1)
    .description('模型未指定 next_delay 时的默认间隔（分钟）。'),

  // ---- 陪主人↔过日子 交接（§5.13）----
  lingerWindowMin: Schema.number()
    .default(4)
    .min(1)
    .description('主人静下来后，先 linger 几分钟再让 bot 自判去留（分钟）。'),

  // ---- 时间 ----
  timezone: Schema.string()
    .default('Asia/Shanghai')
    .description('bot 时间锚（IANA 时区字符串）。早上/今天/晚上从此派生。'),

  // ---- 记忆（长短期两层）----
  stmDays: Schema.number()
    .default(3)
    .min(1)
    .description('短期工作集保留天数。'),
  stmMax: Schema.number()
    .default(60)
    .min(1)
    .description('短期条数上限。'),
  ltmEmbeddings: Schema.boolean()
    .default(false)
    .description('是否给长期库建 embedding（可选联想深取）。'),
  pruneThreshold: Schema.number()
    .default(0.25)
    .min(0)
    .max(1)
    .description('长期记忆清理阈值：importance 低于此值且已沉淀的短期条目可被遗忘。'),

  // ---- 世界 & 动态事件 ----
  weatherSource: Schema.union(['internal', 'api'])
    .default('internal')
    .description('天气来源：internal = 马尔可夫内部演化；api = 绑定真实地点 API。'),
  weatherTickHours: Schema.number()
    .default(6)
    .min(1)
    .description('天气推进间隔（小时）。'),
  eventRegistryPath: Schema.string()
    .default('data/life-sim/event-types.json')
    .description('动态事件类型注册表路径（JSON 文件，热重载）。'),
  forbiddenEventTypes: Schema.array(Schema.string())
    .default(['新命名角色', '重大伤亡'])
    .description('禁止生成的事件类型（硬禁止清单）。'),

  // ---- 出本丸许可 ----
  externalLocations: Schema.array(Schema.string())
    .default(['城下町', '近所'])
    .description('预授权外部地点白名单，bot 可直接前往。'),
  externalRequireApproval: Schema.boolean()
    .default(true)
    .description('白名单外的地点是否需要审神者许可。'),

  // ---- 世界书 canon 层 ----
  worldbooks: Schema.array(
    Schema.object({
      path: Schema.string().description('世界书文件路径'),
      purpose: Schema.string().description('用途标签（persona / external / reference / 自定义）'),
      format: Schema.string().description('格式（koishi / st / typed）'),
    })
  )
    .default([
      { path: 'data/life-sim/canon-刀男.json', purpose: 'persona', format: 'koishi' },
      { path: 'data/life-sim/external-world.json', purpose: 'external', format: 'koishi' },
      { path: 'data/life-sim/职业手册.json', purpose: 'reference', format: 'koishi' },
    ])
    .description('世界书 canon 层配置（可扩展多兼容，加类目 = 加条目零代码）。'),

  // ---- 日程 ----
  routineAuthoredBy: Schema.union(['self', 'seed'])
    .default('self')
    .description('常规日程来源：self = bot 自著；seed = 从种子文件读取。'),
  routineSeedPath: Schema.string()
    .default('data/life-sim/routine-seed.json')
    .description('routineAuthoredBy=seed 时的种子文件路径。'),
  routineReviseEvery: Schema.union(['daily', 'weekly', 'manual'])
    .default('weekly')
    .description('自著日程多久自修订一次。'),
  planRegenAt: Schema.union(['wake', 'night'])
    .default('wake')
    .description('每日计划何时重新生成：wake = 每次唤醒检查；night = 仅夜间。'),
  allowReplan: Schema.boolean()
    .default(true)
    .description('是否允许打断后重规划（plan_adherence=interrupted 时从当点重生成计划）。'),
  assignmentSources: Schema.array(Schema.string())
    .default(['约定', '审神者'])
    .description('接受的被安排来源（约定 / 审神者 / 近侍 / 主控）。'),
  kinjiPreset: Schema.string()
    .default('')
    .description('近侍 bot 的 presetId（多 agent P3 时指定）；留空 = 无近侍。'),

  // ---- 想法缓存 & 主动外联 ----
  thoughtBufferEnabled: Schema.boolean()
    .default(true)
    .description('是否启用 ThoughtBuffer（心事簿）。'),
  surfaceThoughtsOnChat: Schema.boolean()
    .default(true)
    .description('下次对话时是否浮现 pending 心事（注入 {pending_thoughts}）。'),
  proactiveEnabled: Schema.boolean()
    .default(true)
    .description('是否允许 bot 主动外联（关掉退化为纯被动浮现）。'),
  quietHoursEnabled: Schema.boolean()
    .default(true)
    .description('硬熔断①：安静时段内不发主动消息。'),
  dailyCapEnabled: Schema.boolean()
    .default(true)
    .description('硬熔断②：每日主动消息不超过 proactiveDailyCap 条。'),
  proactiveDailyCap: Schema.number()
    .default(2)
    .min(0)
    .description('每日主动外联上限（dailyCapEnabled=true 时生效）。'),
  proactiveMinIntervalHours: Schema.number()
    .default(4)
    .min(0)
    .description('两次主动外联之间的最小间隔（小时）。'),
  proactiveVia: Schema.string()
    .default('relay')
    .description('主动外联通道（relay / direct）。'),
  forbiddenPhraseGuard: Schema.boolean()
    .default(true)
    .description('是否启用禁用操控话术检测（防情感勒索/粘人话术）。'),

  // ---- 协作层 / 多 agent（P3）----
  sharedStorePath: Schema.string()
    .default('../本丸-shared')
    .description('毛线球托管的共享存储路径（P3 跨进程；独立于各 app koishi.db）。'),
  peerModel: Schema.string()
    .default('openai-like/gemini-2.5-flash')
    .description('本 agent 生成 peer 对话 turn 用的模型（P3）。'),
  botChatEnabled: Schema.boolean()
    .default(false)
    .description('是否启用 bot 互聊（P3 协作层）。'),
  botChatMaxTurns: Schema.number()
    .default(12)
    .min(1)
    .description('bot 互聊硬安全帽（熔断兜底，非正常收尾——收尾归 bot 自己）。'),
  botChatDailyCap: Schema.number()
    .default(3)
    .min(0)
    .description('每日 bot 互聊次数上限（P3）。'),
  visibleVia: Schema.string()
    .default('')
    .description('互聊可见模式：空 = peer 路径内部对话（不可见）；relay = 真发消息可见围观。'),

  // ---- 通用 ----
  dryRun: Schema.boolean()
    .default(false)
    .description('灰度模式：只 log 不写库/不真发，用于调参验证。'),
  worldbookGuard: Schema.boolean()
    .default(true)
    .description('是否启用 worldbook 硬护栏（roll 结果不得违反 canon）。'),
  debug: Schema.boolean()
    .default(false)
    .description('调试日志：打印 scheduler / roll / memory 等详细信息。'),
  presets: Schema.array(Schema.string())
    .default(['髭切-通用版（Character）'])
    .description('本插件管理的 presetId 列表。'),
})

module.exports = { Config }
