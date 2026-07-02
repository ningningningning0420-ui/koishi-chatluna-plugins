'use strict'

// koishi-plugin-chatluna-photo — lets a chatluna-character bot send "photos it took" (NovelAI gen).
// Generic across bots: character tag / 画师串 / params all live in config (nothing character-specific hardcoded).
//
// TRIGGER (reply-tag, NOT a model tool — the tool approach crashed chatluna-character's
// four-part parse): the model writes [[photo:意图]] in its output (preferably inside <think>).
//  - ctx.on('chatluna_character/raw-response', (session, content)): the raw model output (incl.
//    <think>) is exposed by a tiny chatluna-character patch (patches/chatluna-character-photo-marker-*).
//    We read the marker here, extract the intent, run the pipeline (planner → NAI → send) out-of-band,
//    then push a self-note into the buffer so the bot knows next turn it sent a photo + what it was.
//  - ctx.on('before-send'): strips any [[photo:...]] from outbound text as a safety net (if the model
//    ever puts the marker in the spoken reply instead of <think>, the user still never sees it).
// [[photo:...]] is a plain-text bracket token — transparent to parseMessageContent, never crashes.
//
// Pure logic (unit-tested in ./test.js, 41 green): nai-client / assemble / scene-planner /
// guards / defaults / photo-tag. This file + ./model.js are the koishi glue (live-verified).

const { Schema, h, Service } = require('koishi')
const fs = require('fs')
const os = require('os')
const path = require('path')
const { pathToFileURL } = require('url')

const guards = require('./guards')
const nai = require('./nai-client')
const assemble = require('./assemble')
const scenePlanner = require('./scene-planner')
const ptag = require('./photo-tag')
const model = require('./model')
const album = require('./album')
const albumPick = require('./album-pick')
const cimg = require('./context-image')
const D = require('./defaults')

exports.name = 'chatluna-photo'
exports.inject = { required: ['chatluna'], optional: ['chatluna_character'] }

// default system prompt for the overflow album-prune (the planner curates "as the character, by the
// heart"). Editable via config.album.prunePrompt. The catalog (id|desc|当时|rating|age) is appended
// automatically as the user message — this is just the persona/criteria part.
const DEFAULT_PRUNE_PROMPT =
  'You curate a roleplay character\'s personal photo album, acting AS that character. The album is full and must shrink. Judge each photo by the MOMENT it captured — its "当时" field is a snippet of what was happening when it was taken. By the character\'s own heart, drop the entries LEAST worth keeping — forgettable/casual shots, near-duplicates of the same moment, throwaways — and KEEP the emotionally meaningful moments. Output ONLY JSON: {"delete":["id", ...]}.'

exports.Config = Schema.object({
  dryRun: Schema.boolean().default(true).description('灰度模式（默认开）：检测到 [[photo:意图]] 只打 logger、不真生图发图。验证钩子触发/标记不泄露/intent 抽取无误后，改 false 才真发图。改这个要重启。'),
  debug: Schema.boolean().default(false).description('调试日志：每次模型回复都打一行（是否含 [[photo:]] 标记、是否提到照片）。排查"不触发"时打开。'),

  failureReplies: Schema.object({
    anlas: Schema.string().default('相机没电了').description('点数(Anlas/402)不足时，bot 显式回这句（in-character 的借口，可按你的口吻改）。留空=不回。'),
    storage: Schema.string().default('内存用完了，得先整理一下').description('存储空间满(ENOSPC)时回这句。留空=不回。'),
    other: Schema.string().default('拍糊了').description('其他生图错误（超时/网络/服务/解析等）时回这句。留空=不回。'),
  }).description('生图失败时让 bot 按错误类型显式回一句话（相机没电了/内存满了/拍糊了…），而不是默默失败。'),

  apiKey: Schema.string().role('secret').default('').description('NovelAI 持久 token（Bearer）。全局共用，不分预设。'),

  activePreset: Schema.union(D.DEFAULT_PRESETS.map((p) => Schema.const(p.name))).default('瑟光').description('当前启用的预设——下拉选一套画风/参数。'),

  presets: Schema.array(
    Schema.object({
      name: Schema.string().default('默认').description('预设名（上面 activePreset 用它来选）'),
      positivePrefix: Schema.string().role('textarea').default(D.POSITIVE_PREFIX).description('画风/质量画师串（质量词已含，勿再追加；⚠ 角色 tag 不放这里）。'),
      negativePrefix: Schema.string().role('textarea').default(D.NEGATIVE_PREFIX).description('负面前缀。'),
      model: Schema.union(['nai-diffusion-4-5-full', 'nai-diffusion-4-5-curated', 'nai-diffusion-4-full', 'nai-diffusion-3', 'nai-diffusion-furry-3']).default(D.NAI_DEFAULT_PARAMS.model),
      sampler: Schema.union(['k_dpmpp_2m', 'k_euler_ancestral', 'k_euler', 'k_dpmpp_sde', 'ddim']).default(D.NAI_DEFAULT_PARAMS.sampler),
      scheduler: Schema.union(['native', 'karras', 'exponential']).default(D.NAI_DEFAULT_PARAMS.scheduler).description('→ noise_schedule'),
      steps: Schema.natural().default(D.NAI_DEFAULT_PARAMS.steps),
      scale: Schema.number().default(D.NAI_DEFAULT_PARAMS.scale).description('CFG'),
      width: Schema.natural().default(D.NAI_DEFAULT_PARAMS.width),
      height: Schema.natural().default(D.NAI_DEFAULT_PARAMS.height),
      seed: Schema.number().default(D.NAI_DEFAULT_PARAMS.seed).description('-1=随机'),
      qualityToggle: Schema.boolean().default(D.NAI_DEFAULT_PARAMS.qualityToggle).description('质量增强（关：质量词已在画师串里）'),
      ucPreset: Schema.union([
        Schema.const(0).description('Heavy'),
        Schema.const(1).description('Light'),
        Schema.const(2).description('Human Focus'),
        Schema.const(3).description('None'),
      ]).default(D.NAI_DEFAULT_PARAMS.ucPreset),
      cfg_rescale: Schema.number().min(0).max(1).default(D.NAI_DEFAULT_PARAMS.cfg_rescale),
    })
  ).default(D.DEFAULT_PRESETS).description('多套预设（仿小白X 绘图参数预设）：每套 = 画师串 + 负面 + 一组 NAI 参数。可存多套不同画风/参数，用上面 activePreset 填 name 切换。'),

  characterTag: Schema.object({
    characterDanbooruTag: Schema.string().default(D.CHARACTER_TAG).description('本 bot 自身角色 danbooru tag（每实例各填，如 higekiri_(touken_ranbu)；留空=不注入自身 tag）。'),
    selfGender: Schema.string().default('').description('本 bot 自身性别（如 male / female / 1boy / 1girl）。NSFW 时告诉 planner 别把自己画成异性（身体/器官/角色按这个来）。强烈建议填，否则露骨场景可能性别画反。'),
    characterLibrary: Schema.array(
      Schema.object({
        name: Schema.string().description('称呼（模型在意图里提到谁，按名字匹配）'),
        danbooru: Schema.string().default('').description('已知角色的 danbooru tag（刀剑用这个，NAI 认得）'),
        appearance: Schema.string().default('').description('NAI 不认的角色（主人/原创）的外貌 danbooru tag 串'),
      })
    ).default(D.CHARACTER_LIBRARY).description('多人合影用的「角色库」：画面里出现别人时，已知刀剑填 danbooru tag、主人/原创角色填 appearance 外貌串。本 bot 自己不放这里（它用上面的 characterDanbooruTag）。'),
  }).description('自身角色身份 + 多人角色库'),

  planner: Schema.object({
    model: Schema.dynamic('model').default('').description('scene-planner 模型（生图大脑）——下拉选一个已注册的模型（chatluna 自动列出）。必须选（标签触发路径无主模型可回退）。一套模型管 SFW+NSFW；要能出露骨 tag 就选不拒绝的（gemini 多半拒露骨，越狱 claude 端点更稳）。'),
    systemPrompt: Schema.string().role('textarea').default(scenePlanner.PLANNER_SYSTEM).description('scene-planner 的 output-format。改这里调出图。'),
    contextWindow: Schema.natural().default(6).description('喂 scene-planner 的最近对话条数。'),
  }).description('scene-planner（生图大脑）'),

  selfInFrame: Schema.object({
    selfieTags: Schema.string().default(D.SELFIE_TAGS),
    fromBehindTags: Schema.string().default(D.FROM_BEHIND_TAGS),
  }).description('自拍构图模板'),

  runtime: Schema.object({
    timeout: Schema.number().default(120000).description('单次出图超时（ms）。'),
    selfPhotoInContext: Schema.boolean().default(true).description('发图/召回后把成品图回流进 bot 自己的上下文（挂在自我备注上）：配合历史图片补丁 v2，多模态主模型能直接"看到"自己刚发的那张（最近 8 条消息内有效；同会话只保留最新一张的像素，旧的自动降级成文字）。需 chatluna-character 开 image:true。'),
  }).description('运行时'),

  album: Schema.object({
    enabled: Schema.boolean().default(true).description('本地相册：拍的照片**默认都存**到本地，之后能用 [[photo:描述|recall]] 召回重发（可跨会话/跨群）。不想留的当场加 |delete。'),
    dir: Schema.string().default('data/photo-album').description('相册目录（相对 koishi 根目录）。'),
    maxEntries: Schema.natural().default(200).description('相册目标上限。超了触发一次「按角色心意」的 LLM 批量清理（删随手/重复的、留在意的），清到约 80%。模型不可用时兜底删最旧。'),
    smartRecall: Schema.boolean().default(true).description('语义召回：用本地向量(嵌入)按"意思"找最匹配的存档图（像表情包 smart），比字面匹配准。需要 chatluna 嵌入模型可用；失败自动回退字面匹配。'),
    embedModel: Schema.string().default('ollama/bge-m3:latest').description('语义召回用的嵌入模型（platform/model）。默认用你 chatluna 的 bge-m3。'),
    prunePrompt: Schema.string().role('textarea').default(DEFAULT_PRUNE_PROMPT).description('相册满了批量清理时，给 planner 的「按心意取舍」系统指令（扮角色、按当时的瞬间决定删谁）。相册清单会自动拼在后面。改这里调清理的口吻/标准。'),
  }).description('本地相册（bot 自主存图 / 召回重发）'),

  camera: Schema.object({
    enabled: Schema.boolean().default(true).description('允许「摄像模式」：bot 在 <think> 写 [[camera:on]] 开启后，之后**每条回复都自动配一张它此刻的自拍**（POV 视角），写 [[camera:off]] 关闭。开关由 bot 自主决定。⚠ 很烧 NAI 额度（每句一张图），按需用。'),
    debounceMs: Schema.natural().default(1500).description('一条回复流式输出完后等多少毫秒再出图（避免每个 chunk 都触发；越大越稳但延迟越高）。'),
    minIntervalSec: Schema.number().default(60).description('两张自动自拍之间的最小间隔秒数（节流控成本）。0 = 不限、每条都出。另外自动拍也计入 access 的限流/每日额度（不再绕过成本闸门）。'),
  }).description('摄像模式（bot 自主开关，开着时每回复自动配图）'),

  access: Schema.object({
    triggerWhitelist: Schema.array(Schema.string()).default([]).description('允许触发发照片的 QQ（至少填你自己）。'),
    triggerGroups: Schema.array(Schema.string()).default([]).description('群触发白名单：留空 = 只私聊。'),
    rerollKeywords: Schema.array(Schema.string()).default(['重roll', 'reroll', '重画', '再来一张', '重新生成', '重出一张']).description('发这些词（整条消息精确匹配，白名单内）= 用上一张照片的同款 prompt 换 seed 重新生成（治鬼图）。可跟数字一次多出几张，如「重roll 3」。留空 = 关闭。'),
    deleteKeywords: Schema.array(Schema.string()).default(['删了', '删掉', '删了吧', '别留这张', '不要这张', '删除', 'delete this']).description('手动删图：回复某张照片并说这些词（任一为子串即可，白名单内）= 把那张从相册删掉。不吞消息（bot 照常回话）。留空 = 关闭手动删。'),
    minIntervalSec: Schema.number().default(30),
    dailyLimit: Schema.number().default(30),
    rateLimitEnabled: Schema.boolean().default(true),
  }).description('触发权限与限流'),
})

function sessionKeyOf(session) {
  return session.isDirect ? 'private:' + session.userId : 'group:' + session.guildId
}

// a real-world "now" hint (host local time) so a "现在拍的" photo matches the actual time of day —
// the planner uses it for lighting/atmosphere unless the story explicitly sets a different time.
function nowHint() {
  const d = new Date()
  const h = d.getHours()
  const tod = h < 5 ? '深夜' : h < 8 ? '清晨' : h < 11 ? '上午' : h < 13 ? '中午' : h < 17 ? '下午' : h < 19 ? '傍晚' : h < 23 ? '夜晚' : '深夜'
  const m = d.getMonth() + 1
  const season = m === 12 || m <= 2 ? '冬' : m <= 5 ? '春' : m <= 8 ? '夏' : '秋'
  const wd = ['周日', '周一', '周二', '周三', '周四', '周五', '周六'][d.getDay()]
  const hh = String(h).padStart(2, '0')
  const mm = String(d.getMinutes()).padStart(2, '0')
  return d.getFullYear() + '-' + m + '-' + d.getDate() + ' ' + wd + ' ' + tod + hh + ':' + mm + '，' + season + '季'
}

// recursively strip [[photo:...]] from any text node's content; returns true if changed.
function stripMarkersFromElements(els) {
  let changed = false
  if (!Array.isArray(els)) return false
  for (const el of els) {
    if (!el) continue
    // gate on ANY marker we strip ([[photo:]] OR [[camera:]]) — gating on '[[photo:' alone let a
    // lone [[camera:on]] in the visible reply leak to the user (parsePhotoTags strips both).
    if (el.type === 'text' && el.attrs && typeof el.attrs.content === 'string' && ptag.hasAnyMarker(el.attrs.content)) {
      const { cleanedText } = ptag.parsePhotoTags(el.attrs.content)
      if (cleanedText !== el.attrs.content) {
        el.attrs.content = cleanedText
        changed = true
      }
    }
    if (Array.isArray(el.children) && el.children.length) {
      if (stripMarkersFromElements(el.children)) changed = true
    }
  }
  return changed
}

exports.apply = (ctx, config) => {
  const logger = ctx.logger('photo')
  const rate = guards.createRateLimiter({
    minIntervalMs: (config.access.minIntervalSec || 0) * 1000,
    dailyLimit: config.access.dailyLimit > 0 ? config.access.dailyLimit : Infinity,
  })

  // ── camera mode: bot toggles [[camera:on/off]]; while on, every reply auto-attaches a POV selfie. ──
  const cameraMode = new Map() // sessionKey -> bool (on/off)
  const cameraTimers = new Map() // sessionKey -> { timer } (debounce one shot per reply)
  const cameraLastAt = new Map() // sessionKey -> ts (throttle)
  // extract the VISIBLE reply (drop <think>/<status>, any markers, tags) — the "what's happening now"
  // that a POV selfie should depict.
  function extractVisible(content) {
    let t = String(content == null ? '' : content)
    t = t.replace(/<think[\s\S]*?<\/think>/gi, '').replace(/<status[\s\S]*?<\/status>/gi, '')
    const m = t.match(/<message[^>]*>([\s\S]*?)<\/message>/i)
    if (m) t = m[1]
    return t
      .replace(/\[\[(?:photo|camera):[^\]]*\]\]/gi, ' ')
      .replace(/<[^>]+>/g, ' ')
      .replace(/\s+/g, ' ')
      .trim()
  }
  // v1 heuristic: does the current moment read as explicit? → the auto-selfie matches the scene's rating.
  const EXPLICIT_CUES = /裸|脱光|衣衫不整|胸|乳|下体|阴|插入|情事|做爱|高潮|喘息|抽送|精液|湿了|勃起|交合|口交|自慰|性器|racy|nsfw|nude|sex/i
  function looksExplicit(text) {
    return EXPLICIT_CUES.test(String(text || ''))
  }
  // debounce: raw-response fires per chunk; fire ONE auto-selfie ~debounceMs after the reply settles,
  // using its final visible text as the intent. Skips the album + self-note (it's a stream, via nosave).
  function scheduleCameraShot(session, key, content) {
    const prev = cameraTimers.get(key)
    if (prev && prev.timer) clearTimeout(prev.timer)
    const timer = setTimeout(() => {
      cameraTimers.delete(key)
      try {
        const now = Date.now()
        // camera throttle + the SHARED rate limiter: auto selfies consume the same minInterval /
        // dailyLimit budget as explicit [[photo:]] — camera is not a free path around the cost cap.
        const gate = guards.checkCameraShot({
          now,
          lastShotAt: cameraLastAt.get(key),
          minIntervalMs: (config.camera.minIntervalSec || 0) * 1000,
          rate,
          rateLimitEnabled: config.access.rateLimitEnabled,
        })
        if (!gate.ok) {
          if (gate.reason !== 'camera_throttle') logger.info('camera skip: rate ' + gate.reason)
          return
        }
        const visible = extractVisible(content)
        if (!visible) return
        if (config.access.rateLimitEnabled !== false) rate.record(now)
        cameraLastAt.set(key, now)
        // intent must capture the CURRENT scene (not the bot's default location) — the visible line is
        // just flavor; the planner leans on recent context. nsfw is judged from the FULL output (the
        // <think> holds the physical scene the tame dialogue may not mention).
        const intent = '（摄像·此刻的第一人称 POV 自拍：延续你和主人当前正在发生的场景与动作，如实拍下这一刻，别切回缘侧晒太阳之类无关的日常场景。你这句：' + visible + '）'
        enqueuePhoto(session, { intent: intent.slice(0, 300), selfInFrame: 'selfie', nsfw: looksExplicit(content), nosave: true, auto: true })
      } catch (e) {
        logger.warn('camera shot failed: ' + (e && e.message))
      }
    }, config.camera.debounceMs || 1500)
    cameraTimers.set(key, { timer })
  }

  // Per-session sequential queue. A single turn may emit several [[photo:]] markers; we generate
  // + send them ONE AT A TIME per session (the old skip-if-busy lock dropped all but the first).
  const photoQueue = new Map() // sessionKey -> [{ session, it }]
  const draining = new Set() // sessionKeys currently draining
  const lastPhoto = new Map() // sessionKey -> { photo, ap, meta } — for reroll (regen same prompt, new seed)
  const photoByMsgId = new Map() // sent messageId -> { photo, ap, meta } — reply-to-a-specific-photo reroll
  function rememberPhotoMsg(ids, spec) {
    for (const id of ids) if (id) photoByMsgId.set(String(id), spec)
    while (photoByMsgId.size > 50) photoByMsgId.delete(photoByMsgId.keys().next().value) // cap memory: keep ~50 most recent
  }

  // ── local album: bot-curated persistence (|keep) + recall (|recall). GLOBAL (cross-session) so a
  //    photo kept in one chat can be recalled & sent in another. Index = JSON sidecar; files = PNGs. ──
  const albumDir = path.resolve(ctx.baseDir || process.cwd(), config.album.dir || 'data/photo-album')
  const albumIndexPath = path.join(albumDir, 'album.json')
  let albumIndex = []
  if (config.album.enabled) {
    try {
      fs.mkdirSync(albumDir, { recursive: true })
      if (fs.existsSync(albumIndexPath)) albumIndex = JSON.parse(fs.readFileSync(albumIndexPath, 'utf8'))
      if (!Array.isArray(albumIndex)) albumIndex = []
    } catch (e) {
      logger.warn('album init failed: ' + (e && e.message))
      albumIndex = []
    }
  }
  function saveAlbumIndex() {
    try { fs.writeFileSync(albumIndexPath, JSON.stringify(albumIndex, null, 2)) } catch (e) { logger.warn('album save failed: ' + (e && e.message)) }
  }
  // Persistent sent-message-id → album-id map, so "reply to a photo + 删了" survives restarts/HMR
  // (the in-memory photoByMsgId is rebuilt empty on every reload, which is why manual delete silently
  // no-op'd after a restart). Bounded; sidecar next to the album index.
  const msgMapPath = path.join(albumDir, 'msgmap.json')
  let msgIdToAlbum = {}
  if (config.album.enabled) {
    try { if (fs.existsSync(msgMapPath)) msgIdToAlbum = JSON.parse(fs.readFileSync(msgMapPath, 'utf8')) || {} } catch (e) { msgIdToAlbum = {} }
    if (typeof msgIdToAlbum !== 'object' || !msgIdToAlbum) msgIdToAlbum = {}
  }
  function rememberMsgAlbum(ids, albumId) {
    if (!albumId || !Array.isArray(ids)) return
    for (const id of ids) if (id) msgIdToAlbum[String(id)] = albumId
    const keys = Object.keys(msgIdToAlbum)
    if (keys.length > 300) for (const k of keys.slice(0, keys.length - 300)) delete msgIdToAlbum[k]
    try { fs.writeFileSync(msgMapPath, JSON.stringify(msgIdToAlbum)) } catch (e) {}
  }
  // remove one album entry by id (drops its file too). Shared by reroll-replace + manual delete.
  function removeAlbumEntry(id) {
    const idx = albumIndex.findIndex((e) => e && e.id === id)
    if (idx < 0) return null
    const removed = albumIndex.splice(idx, 1)[0]
    if (removed && removed.file) fs.promises.unlink(removed.file).catch(() => {})
    saveAlbumIndex()
    return removed
  }
  // lazily resolve a chatluna embeddings model (bge-m3 etc.) for semantic recall; null if unavailable.
  let _embeddings = null
  async function getEmbeddings() {
    if (!config.album.smartRecall) return null
    if (_embeddings) return _embeddings
    try {
      const ref = await ctx.chatluna.createEmbeddings(config.album.embedModel || 'ollama/bge-m3:latest')
      const e = ref && typeof ref.value !== 'undefined' ? ref.value : ref
      if (e && typeof e.embedQuery === 'function') { _embeddings = e; return e }
    } catch (err) {
      logger.warn('album embeddings unavailable (fallback to lexical recall): ' + (err && err.message))
    }
    return null
  }
  const embedText = (e) => ((e.intent || '') + ' ' + (e.sceneTags || '')).trim()
  function addToAlbum(png, meta) {
    try {
      const id = 'p' + Date.now() + Math.random().toString(36).slice(2, 6)
      const file = path.join(albumDir, id + '.png')
      fs.writeFileSync(file, png)
      // store a short snippet of the conversation at capture time — the photo's "memory of the moment",
      // so the overflow prune can judge by sentiment (which moments mattered), not just the description.
      const ctxSnippet = String(meta.context || '').replace(/\s+/g, ' ').trim().slice(-200)
      const entry = { id, file, intent: meta.intent || '', sceneTags: meta.sceneTags || '', context: ctxSnippet, nsfw: !!meta.nsfw, selfInFrame: meta.selfInFrame || 'selfie', originKey: meta.originKey || '', ts: Date.now() }
      albumIndex.push(entry)
      saveAlbumIndex()
      logger.info('album: saved a photo (' + (meta.intent || '') + ') | total=' + albumIndex.length)
      // embed in the background so semantic recall can find it (lexical still works meanwhile)
      ;(async () => {
        const emb = await getEmbeddings()
        if (!emb) return
        try { entry.vec = await emb.embedQuery(embedText(entry)); saveAlbumIndex() } catch (e) { /* keep lexical-only */ }
      })()
      // overflow → prune by the character's own will (async, guarded); hard ceiling is the safety net.
      const cap = config.album.maxEntries || 200
      if (albumIndex.length > cap) maybePrune()
      enforceAlbumCeiling(cap)
      return entry
    } catch (e) {
      logger.warn('album add failed: ' + (e && e.message))
      return null
    }
  }
  // safety net so the album can never grow unbounded if the LLM prune is unavailable / keeps failing.
  function enforceAlbumCeiling(cap) {
    let changed = false
    while (albumIndex.length > Math.ceil((cap || 200) * 1.5)) {
      const old = albumIndex.shift()
      if (old && old.file) fs.promises.unlink(old.file).catch(() => {})
      changed = true
    }
    if (changed) saveAlbumIndex()
  }
  // overflow prune: ask the planner model to curate IN CHARACTER — drop the least-worth-keeping
  // (casual / near-duplicate / throwaway), keep the meaningful moments — down to ~80% of the cap.
  let _pruning = false
  async function maybePrune() {
    if (_pruning) return
    const cap = config.album.maxEntries || 200
    if (albumIndex.length <= cap) return
    const plannerModelName = config.planner.model
    if (!plannerModelName) return // no model → hard ceiling handles it
    _pruning = true
    const controller = new AbortController()
    const deadline = setTimeout(() => controller.abort(), config.runtime.timeout)
    try {
      const target = Math.max(1, Math.floor(cap * 0.8))
      const toDelete = albumIndex.length - target
      if (toDelete <= 0) return
      const fmtAge = (ts) => (ts ? Math.max(0, Math.round((Date.now() - ts) / 86400000)) + 'd ago' : '?')
      const catalog = albumIndex.map((e) => e.id + ' | ' + (e.intent || '(no desc)') + (e.context ? ' | 当时: ' + e.context : '') + ' | ' + (e.nsfw ? 'nsfw' : 'sfw') + ' | ' + fmtAge(e.ts)).join('\n')
      const sys = config.album.prunePrompt || DEFAULT_PRUNE_PROMPT
      const user = 'Album is full (' + albumIndex.length + '). Delete about ' + toDelete + ' (keep ~' + target + '). Decide by the significance of each moment (the 当时 context), not by image quality.\n\nAlbum (id | description | 当时-context | rating | age):\n' + catalog
      const raw = await model.invokePlannerModel(ctx, plannerModelName, [{ role: 'system', content: sys }, { role: 'user', content: user }], { signal: controller.signal })
      const delIds = new Set(album.parsePruneDecision(raw))
      if (!delIds.size) { logger.info('album prune: model chose nothing (hard ceiling still applies)'); return }
      const floor = Math.max(1, Math.floor(cap * 0.5)) // never prune below half the cap in one pass
      let deleted = 0
      albumIndex = albumIndex.filter((e) => {
        if (e && delIds.has(e.id) && albumIndex.length - deleted > floor) {
          deleted++
          if (e.file) fs.promises.unlink(e.file).catch(() => {})
          return false
        }
        return true
      })
      saveAlbumIndex()
      logger.info('album prune: deleted ' + deleted + ' by the character\'s will | now ' + albumIndex.length)
    } catch (e) {
      logger.warn('album prune failed (hard ceiling applies): ' + (e && e.message))
    } finally {
      clearTimeout(deadline)
      _pruning = false
    }
  }
  // recall: match the description against the album, send the saved file to the CURRENT session
  // (cross-chat). No generation — instant, free. Semantic (vector) match first, lexical fallback.
  async function runRecall(session, it) {
    if (!config.album.enabled) return
    // INFORMED-NSFW GATE + smart/lexical selection delegated to findAlbumEntry (scope='all' = whole album)
    const best = await findAlbumEntry(it.intent, { nsfw: !!it.nsfw, scope: 'all' })
    if (!best) {
      try { await session.send('（相册里没找到匹配「' + it.intent + '」的照片～）') } catch (e) {}
      logger.info('album recall: no match for ' + JSON.stringify(it.intent) + ' (album=' + albumIndex.length + ')')
      return
    }
    try {
      await session.send(h.image(pathToFileURL(best.file).href))
      logger.info('album recall: sent ' + best.id + ' (' + best.intent + ') for query ' + JSON.stringify(it.intent))
      let imgs = null
      if (config.runtime.selfPhotoInContext !== false) {
        try { imgs = cimg.makeSelfPhotoImages(await fs.promises.readFile(best.file), best.id) } catch (e) { /* note stays text-only */ }
      }
      pushSelfNote(sessionKeyOf(session), '（我从相册里翻出之前那张照片发了出去：' + best.intent + '）', session.bot, imgs)
    } catch (e) {
      logger.warn('album recall send failed: ' + (e && e.message))
    }
  }

  // exposed lookup: find best album entry by desc, scoped. No send. entry|null.
  async function findAlbumEntryOnce(desc, opts) {
    opts = opts || {}
    const query = String(desc == null ? '' : desc).trim()
    // try vector disambiguation within the SAME scoped+eligible pool first (origin-aware)
    if (query && config.album.smartRecall) {
      try {
        const emb = await getEmbeddings()
        if (emb) {
          let cand = albumIndex
          if (opts.scope === 'origin' && opts.originKey) cand = albumIndex.filter((e) => e && e.originKey === opts.originKey)
          const eligible = album.eligibleByRating(cand, !!opts.nsfw)
          if (eligible.length) {
            const missing = eligible.filter((e) => e && !Array.isArray(e.vec) && embedText(e))
            if (missing.length) {
              const vecs = await emb.embedDocuments(missing.map(embedText))
              missing.forEach((e, i) => { if (Array.isArray(vecs[i])) e.vec = vecs[i] })
              saveAlbumIndex()
            }
            const v = album.pickBestVec(await emb.embedQuery(query), eligible)
            if (v) return v
          }
        }
      } catch (e) { logger.warn('findAlbumEntry smart failed, lexical fallback: ' + (e && e.message)) }
    }
    // lexical (and empty-desc → most-recent-in-scope; origin no-match → most-recent-in-scope)
    return albumPick.pickFromPool(albumIndex, query, opts)
  }
  // Public lookup with optional cross-rating fallback: try the requested rating first; if nothing
  // matches and opts.crossRating is set, retry with the opposite rating (sfw↔nsfw, symmetric). The
  // returned entry carries its real `.nsfw` so the caller can surface the rating to the model. Used
  // by relay's origin-scoped forward so a "send that photo" never silently fails on a rating mismatch;
  // photo's own whole-album recall does NOT pass crossRating, keeping its informed-NSFW gate intact.
  async function findAlbumEntry(desc, opts) {
    opts = opts || {}
    const first = await findAlbumEntryOnce(desc, opts)
    if (first || !opts.crossRating) return first
    return findAlbumEntryOnce(desc, { ...opts, nsfw: !opts.nsfw })
  }

  // expose recallEntry so koishi-plugin-relay can forward an album photo to a friend.
  ctx.plugin(class PhotoRecallService extends Service {
    constructor(c) { super(c, 'photo', true); this.recallEntry = null }
  })
  ctx.inject(['photo'], (c) => { c.photo.recallEntry = (desc, opts) => findAlbumEntry(desc, opts) })

  async function drainPhotoQueue(key) {
    if (draining.has(key)) return
    draining.add(key)
    try {
      const q = photoQueue.get(key)
      while (q && q.length) {
        const { session, it } = q.shift()
        if (it && it.reroll) await runReroll(session, sessionKeyOf(session), it.target) // regen targeted (or last) photo, fresh seed
        else if (it && it.recall) await runRecall(session, it) // send a saved album photo, no generation
        else await runPhotoPipeline(session, it) // sequential — one NAI gen at a time per session
      }
    } finally {
      draining.delete(key)
      photoQueue.delete(key)
    }
  }
  function enqueuePhoto(session, it) {
    const key = sessionKeyOf(session)
    if (!photoQueue.has(key)) photoQueue.set(key, [])
    const q = photoQueue.get(key)
    if (q.length >= (config.runtime.maxQueuePerSession || 6)) {
      logger.info('photo queue full for ' + key + ', dropping extra')
      return
    }
    q.push({ session, it })
    drainPhotoQueue(key) // fire-and-forget; the draining guard makes it idempotent
  }

  // generate (NAI) → send via temp file → remember for reroll → self-note (skipped on reroll).
  // Shared by the normal pipeline and reroll so both deliver identically.
  async function deliverPhoto(session, key, photo, ap, meta, signal) {
    const png = await generateNai(photo, signal, ap)
    // Send via a temp FILE (file://), not base64:// — NapCat/OneBot rejects large/rapid base64
    // inline images (and koishi deprecated base64://). A local file path is the robust path.
    const tmpPath = path.join(os.tmpdir(), 'koishi-photo-' + Date.now() + '-' + Math.random().toString(36).slice(2, 8) + '.png')
    await fs.promises.writeFile(tmpPath, png)
    let sentIds = []
    try {
      const sent = await session.send(h.image(pathToFileURL(tmpPath).href))
      // session.send → Message[] (or string[]); grab the message id(s) so a reply to THIS image can target it.
      sentIds = (Array.isArray(sent) ? sent : [sent]).map((m) => (typeof m === 'string' ? m : m && (m.id || m.messageId))).filter(Boolean)
    } finally {
      setTimeout(() => fs.promises.unlink(tmpPath).catch(() => {}), 60000) // let NapCat read it, then clean up
    }
    // remember the exact prompt + preset so "重roll" can regen it (seed -1 → fresh image each time)
    const spec = { photo, ap, meta: { intent: meta.intent, selfInFrame: meta.selfInFrame, nsfw: !!meta.nsfw, sceneTags: meta.sceneTags || '', context: meta.context || '', auto: !!meta.auto } }
    lastPhoto.set(key, spec)
    rememberPhotoMsg(sentIds, spec) // reply to this exact photo → reroll / delete exactly it
    // KEEP-ALL by default: every photo goes to the album (cross-restart, cross-chat recall), unless the
    // bot flagged |delete (a throwaway). Overflow is pruned later by the character's own will.
    if (config.album.enabled && !meta.nosave && !meta.auto) {
      const entry = addToAlbum(png, { intent: meta.intent, sceneTags: meta.sceneTags, context: meta.context, nsfw: meta.nsfw, selfInFrame: meta.selfInFrame, originKey: key })
      if (entry) {
        spec.albumId = entry.id // so "reply + 删了" can remove this exact one from the album
        rememberMsgAlbum(sentIds, entry.id) // persist msgId→albumId so reply-delete survives restarts
        // reroll = REPLACE: now that the better version is saved, drop the old (likely 鬼图) entry it rerolled.
        if (meta.replaceAlbumId && meta.replaceAlbumId !== entry.id) removeAlbumEntry(meta.replaceAlbumId)
      }
    }
    if (!meta.reroll && !meta.auto) {
      const imgs = config.runtime.selfPhotoInContext !== false ? cimg.makeSelfPhotoImages(png, spec.albumId || 'tmp' + Date.now()) : null
      pushSelfNote(key, '（我刚给对方发了一张自己拍的照片：' + meta.intent + '）', session.bot, imgs)
    }
    logger.info((meta.reroll ? 're-rolled' : 'sent') + ' a photo (self_in_frame=' + meta.selfInFrame + ', nsfw=' + !!meta.nsfw + ')')
  }

  // reroll: regenerate a photo with the SAME prompt + preset (seed -1 → new image).
  // target = a specific photo's spec (from replying to it); falls back to the session's last photo.
  async function runReroll(session, key, target) {
    const last = target || lastPhoto.get(key)
    if (!last) {
      try { await session.send('（还没拍过照片，没法重 roll，先让我拍一张～）') } catch (e) {}
      return
    }
    const controller = new AbortController()
    const deadline = setTimeout(() => controller.abort(), config.runtime.timeout)
    try {
      // force a fresh random seed so reroll ALWAYS varies, even if the active preset pinned a fixed seed.
      const freshAp = Object.assign({}, last.ap, { seed: -1 })
      await deliverPhoto(session, key, last.photo, freshAp, Object.assign({}, last.meta, { reroll: true, replaceAlbumId: last.albumId }), controller.signal)
    } catch (e) {
      logger.warn('photo reroll failed: ' + (e && e.message))
    } finally {
      clearTimeout(deadline)
    }
  }

  // resolve the active preset (画师串 + 负面 + NAI params) by name, fallback to the first.
  function resolveActivePreset() {
    const ps = Array.isArray(config.presets) ? config.presets : []
    return ps.find((p) => p && p.name === config.activePreset) || ps[0] || {}
  }

  // NAI IO — build request with the active preset's params, call, return PNG Buffer.
  async function generateNai(photo, signal, params) {
    const body = nai.buildRequestBody({
      scene: photo.scene,
      characterPrompts: photo.characterPrompts,
      negativePrompt: photo.negativePrompt,
      params,
    })
    const res = await fetch(nai.NOVELAI_IMAGE_API, {
      method: 'POST',
      headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + config.apiKey },
      body: JSON.stringify(body),
      signal,
    }).catch((e) => {
      const c = nai.classifyFetchError(e)
      throw Object.assign(new Error(c.message), { naiCode: c.code })
    })
    if (!res.ok) {
      const t = await res.text().catch(() => '')
      const c = nai.classifyNaiError(res.status, t)
      throw Object.assign(new Error(c.message), { naiCode: c.code })
    }
    return nai.extractPngFromNaiZip(Buffer.from(await res.arrayBuffer()))
  }

  // Push a bot-attributed note into the chatluna-character buffer so that, next turn, the bot
  // KNOWS it sent a photo and what it depicts (relay's pushToBuffer pattern; id === selfId makes
  // chatluna treat it as the bot's own line). Best-effort.
  function pushSelfNote(key, text, bot, images) {
    try {
      const cc = ctx.chatluna_character
      if (!cc || typeof cc.getMessages !== 'function' || !text) return
      const msg = {
        content: text,
        name: (bot && bot.user && bot.user.name) || String((bot && bot.selfId) || 'bot'),
        id: String((bot && bot.selfId) || '0'),
        timestamp: Date.now(),
      }
      const arr = cc.getMessages(key)
      // self-photo feedback: attach the PNG (data URL) + selfPhoto flag so the history-image
      // patch v2 shows the NEWEST such note as real pixels to the multimodal main model.
      // Older notes' images are stripped first — at most ONE live image per conversation.
      if (Array.isArray(images) && images.length) {
        if (Array.isArray(arr)) cimg.stripOldSelfPhotos(arr)
        msg.images = images
        msg.selfPhoto = true
      }
      if (Array.isArray(arr)) arr.push(msg)
      else if (cc._messages) cc._messages[key] = [msg]
    } catch (e) {
      logger.warn('pushSelfNote failed: ' + (e && e.message))
    }
  }

  // dedup: raw-response fires per chunk → avoid generating the same marker twice in one turn.
  const seenMarkers = new Map()
  function isDuplicateMarker(key, intentStr) {
    const k = key + '||' + intentStr
    const now = Date.now()
    for (const [mk, ts] of seenMarkers) if (now - ts > 60000) seenMarkers.delete(mk)
    if (seenMarkers.has(k)) return true
    seenMarkers.set(k, now)
    return false
  }
  // dedup failure replies: several queued photos failing the same way (e.g. all Anlas) → one reply, not N.
  const failReplied = new Map()
  function shouldReplyFailure(key, cat) {
    const k = key + '||' + cat
    const now = Date.now()
    for (const [mk, ts] of failReplied) if (now - ts > 60000) failReplied.delete(mk)
    if (failReplied.has(k)) return false
    failReplied.set(k, now)
    return true
  }

  // intent → generate → send image to the session. Side-effect; logs failures, never throws.
  async function runPhotoPipeline(session, it) {
    const key = sessionKeyOf(session)
    const controller = new AbortController()
    const deadline = setTimeout(() => controller.abort(), config.runtime.timeout)
    try {
      let recent = ''
      try {
        const cc = ctx.chatluna_character
        if (cc && typeof cc.getMessages === 'function') {
          const arr = cc.getMessages(key)
          if (Array.isArray(arr)) {
            recent = arr.slice(-config.planner.contextWindow).map((m) => (m.name ? m.name + ': ' : '') + (m.content || '')).join('\n')
          }
        }
      } catch (e) {
        /* best-effort */
      }

      const plannerModelName = config.planner.model
      if (!plannerModelName) throw new Error('planner.model 未配置（标签触发路径无主模型可回退）')
      const invokeModel = async (messages) => await model.invokePlannerModel(ctx, plannerModelName, messages, { signal: controller.signal })

      const planned = await scenePlanner.planScene(
        { invokeModel },
        {
          intent: it.intent,
          recentDialogue: recent,
          selfInFrame: it.selfInFrame,
          nsfw: !!it.nsfw,
          characterLibrary: config.characterTag.characterLibrary,
          selfGender: config.characterTag.selfGender, // keep the self's anatomy/role correct in nsfw (don't gender-flip the self character)
          now: nowHint(), // real-world time-of-day so "现在" photos match the actual lighting/atmosphere
          systemPrompt: config.planner.systemPrompt, // user-edited output-format (textarea); '' → falls back to PLANNER_SYSTEM
        }
      )
      const ap = resolveActivePreset()
      const photo = assemble.buildPhotoPrompt({
        positivePrefix: ap.positivePrefix,
        characterTag: config.characterTag.characterDanbooruTag,
        plannerScene: planned.scene,
        plannerChars: planned.chars,
        negativePrefix: ap.negativePrefix,
        selfInFrame: it.selfInFrame,
        selfTags: { selfie: config.selfInFrame.selfieTags, fromBehind: config.selfInFrame.fromBehindTags, none: '' },
      })
      // visible prompt log: what the planner actually produced (the 露骨/NSFW-relevant part).
      // 画师串(positivePrefix) is fixed and omitted; we log the planner's scene + per-character tags.
      logger.info('photo prompt | nsfw=' + !!it.nsfw + ' | preset=' + (ap.name || '?') + ' | plannerScene=' + JSON.stringify(planned.scene) + ' | chars=' + JSON.stringify(photo.characterPrompts.map((c) => c.prompt)))
      await deliverPhoto(session, key, photo, ap, { intent: it.intent, selfInFrame: it.selfInFrame, nsfw: !!it.nsfw, nosave: !!it.nosave, auto: !!it.auto, sceneTags: planned.scene, context: recent }, controller.signal)
    } catch (e) {
      logger.warn('photo pipeline failed: ' + (e && e.message))
      // explicit in-character reply mapped to the error type (相机没电了 / 内存满了 / 拍糊了…)
      try {
        const cat = e && e.naiCode === 'quota' ? 'anlas'
          : ((e && e.code === 'ENOSPC') || /ENOSPC|no space left|空间不足/i.test((e && e.message) || '')) ? 'storage'
          : 'other'
        const msg = (config.failureReplies || {})[cat]
        if (msg && shouldReplyFailure(key, cat)) {
          await session.send(msg)
          const reason = cat === 'anlas' ? '点数没了（相机没电）' : cat === 'storage' ? '存储满了（内存用完）' : '生成出了问题（拍糊了）'
          pushSelfNote(key, '（我刚想拍照，但没拍成——' + reason + '，已经跟她说了，没真发出照片）', session.bot)
          logger.info('photo failure reply sent: ' + cat)
        }
      } catch (e2) { logger.warn('photo failure-reply error: ' + (e2 && e2.message)) }
    } finally {
      clearTimeout(deadline)
    }
  }

  // ── HOOK 1: strip [[photo:...]] from outbound text (so the user never sees the marker) ──
  ctx.on('before-send', (session) => {
    try {
      if (!session || !Array.isArray(session.elements)) return
      if (stripMarkersFromElements(session.elements)) {
        logger.info('before-send: stripped photo/camera marker(s) from outbound text (key=' + sessionKeyOf(session) + ')')
      }
    } catch (e) {
      logger.warn('before-send hook error: ' + (e && e.message))
    }
    // return undefined → allow send (we mutate elements in place)
  })

  // ── HOOK 2: read [[photo:意图]] from the RAW model output (incl. <think>, never sent to the
  //    user) via the patch's `chatluna_character/raw-response` event, then run the pipeline
  //    out-of-band. This is the reliable marker source (after-chat's lastResponseMessage is
  //    empty when experimentalToolCallReply=false; the raw output is the only place with <think>). ──
  ctx.on('chatluna_character/raw-response', (session, content) => {
    try {
      // DIAGNOSTIC (gated by config.debug): prove the event fires + whether the model wrote the marker.
      if (config.debug && typeof content === 'string') {
        const has = content.indexOf('[[photo:') !== -1
        const mentions = /photo|照片|自拍|拍.{0,3}照/i.test(content)
        logger.info('raw-response fired (len=' + content.length + ' hasMarker=' + has + ' mentionsPhoto=' + mentions + ' hasThink=' + /<think/i.test(content) + ' key=' + sessionKeyOf(session) + ')')
        if (!has && mentions) {
          // model talked about photos but used NO marker → show what it actually wrote (think block or a window around the mention)
          const think = content.match(/<think[^>]*>([\s\S]*?)<\/think>/i)
          const snip = think ? think[1] : content
          const at = snip.search(/photo|照片|自拍/i)
          logger.info('  ↳ no-marker but mentions photo; snippet=' + JSON.stringify(snip.slice(Math.max(0, at - 120), at + 200)))
        }
      }
      if (!session || typeof content !== 'string') return
      const key = sessionKeyOf(session)
      const tctx = { userId: session.userId, isDirect: session.isDirect, groupId: session.guildId != null ? session.guildId : session.channelId }
      const authed = guards.isTriggerAllowed(tctx, { triggerWhitelist: config.access.triggerWhitelist, triggerGroups: config.access.triggerGroups })

      // ── camera mode (bot toggles [[camera:on/off]]): update state, and while on, auto-shoot this reply ──
      if (config.camera.enabled && authed) {
        const tog = ptag.parseCameraToggle(content)
        if (tog) {
          const want = tog === 'on'
          if (cameraMode.get(key) !== want) { // only act/log on a real state change (hook fires per chunk)
            cameraMode.set(key, want)
            logger.info('camera mode ' + tog + ' (key=' + key + ')')
          }
        }
        if (cameraMode.get(key)) {
          if (config.dryRun) logger.info('[DRYRUN] camera on → would auto-shoot (key=' + key + ')')
          else scheduleCameraShot(session, key, content)
        }
      }

      // ── explicit [[photo:]] markers ──
      if (content.indexOf('[[photo:') === -1) return
      if (!authed) {
        logger.info('raw-response: photo marker but trigger not authorized (key=' + key + ')')
        return
      }
      const { intents } = ptag.parsePhotoTags(content)
      if (!intents.length) return
      if (config.dryRun) {
        logger.info('[DRYRUN] raw-response: photo marker(s) ' + JSON.stringify(intents) + ' | isDirect=' + session.isDirect + ' userId=' + session.userId + ' key=' + key)
        return
      }
      // rate limit per TURN (not per photo) so several photos in one turn all go through
      if (config.access.rateLimitEnabled !== false) {
        const v = rate.check(Date.now())
        if (!v.ok) {
          logger.info('photo skip: rate ' + v.reason)
          return
        }
        rate.record(Date.now())
      }
      const cap = config.runtime.maxPerTurn || 4
      const nonDup = intents.filter((it) => !isDuplicateMarker(key, it.intent))
      const fresh = nonDup.slice(0, cap)
      // 应发 vs 实发 可见化：本 chunk 解析到的标记数 / 去重后新增 / 实际入队（被 cap 截断的也标出来）。
      // raw-response 按 chunk 触发、内容累积，所以一轮里"标记数"会增长，"新增入队"累加=实际生成数。
      if (intents.length) {
        const capped = nonDup.length - fresh.length
        logger.info('raw-response: 标记=' + intents.length + ' 去重后新增=' + nonDup.length + ' 入队=' + fresh.length + (capped > 0 ? ' (超 maxPerTurn=' + cap + ' 截断' + capped + ')' : '') + ' key=' + key)
      }
      for (const it of fresh) enqueuePhoto(session, it) // queued → drained sequentially, none dropped
    } catch (e) {
      logger.warn('raw-response hook error: ' + (e && e.message))
    }
  })

  // ── HOOK 3: reroll. User sends a reroll keyword (whole message) → regenerate a photo with the same
  //    prompt + a fresh seed. REPLY to a specific photo → reroll exactly that one; no reply → the last
  //    photo. "重roll 3" → 3 fresh variants (capped at maxPerTurn). Prepended middleware so the keyword
  //    is swallowed (not handed to chatluna-character as chat → no context impact). ──
  const escapeRe = (s) => String(s).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  ctx.middleware((session, next) => {
    try {
      const kws = config.access.rerollKeywords
      if (!session || !Array.isArray(kws) || kws.length === 0) return next()
      const text = (session.content || '').trim()
      if (!text) return next()
      const re = new RegExp('^(?:' + kws.filter(Boolean).map(escapeRe).join('|') + ')\\s*(\\d+)?$', 'i')
      const mm = text.match(re)
      if (!mm) return next()
      const tctx = { userId: session.userId, isDirect: session.isDirect, groupId: session.guildId != null ? session.guildId : session.channelId }
      if (!guards.isTriggerAllowed(tctx, { triggerWhitelist: config.access.triggerWhitelist, triggerGroups: config.access.triggerGroups })) return next()
      const key = sessionKeyOf(session)
      // TARGET: replying to one of our photos → reroll exactly that one; otherwise the session's last photo.
      const qid = session.quote && (session.quote.id || session.quote.messageId)
      const target = qid ? photoByMsgId.get(String(qid)) : null
      if (qid && !target) {
        session.send('（这张我没存着了，没法精确重 roll；直接发「重roll」我重拍最近那张～）').catch(() => {})
        return // swallow
      }
      if (!target && !lastPhoto.has(key)) {
        session.send('（还没拍过照片，没法重 roll，先让我拍一张～）').catch(() => {})
        return // swallow
      }
      if (config.dryRun) {
        logger.info('[DRYRUN] reroll requested (key=' + key + ', target=' + (target ? 'replied-photo' : 'last') + ')')
        return
      }
      const n = Math.min(Math.max(parseInt(mm[1] || '1', 10) || 1, 1), config.runtime.maxPerTurn || 4)
      for (let i = 0; i < n; i++) enqueuePhoto(session, { reroll: true, target }) // target null → runReroll uses last photo
      return // swallow — don't pass the keyword to chatluna-character
    } catch (e) {
      return next()
    }
  }, true) // prepend: run before chatluna-character's middleware

  // ── HOOK 4: manual delete. Photos are kept by default; reply to one we sent + say a delete word →
  //    remove THAT exact photo from the album. NON-swallowing (the bot still replies in character);
  //    gated by reply-to-a-known-photo so ordinary chat containing the word doesn't false-delete. ──
  ctx.middleware((session, next) => {
    try {
      if (!config.album.enabled) return next()
      const kws = config.access.deleteKeywords
      if (!session || !Array.isArray(kws) || kws.length === 0) return next()
      const text = (session.content || '').trim()
      if (!text || !kws.filter(Boolean).some((k) => text.includes(k))) return next()
      const tctx = { userId: session.userId, isDirect: session.isDirect, groupId: session.guildId != null ? session.guildId : session.channelId }
      if (!guards.isTriggerAllowed(tctx, { triggerWhitelist: config.access.triggerWhitelist, triggerGroups: config.access.triggerGroups })) return next()
      const qid = session.quote && (session.quote.id || session.quote.messageId)
      const spec = qid ? photoByMsgId.get(String(qid)) : null
      // in-memory spec first (this process); fall back to the persisted msgId→albumId (survives restart)
      const albumId = (spec && spec.albumId) || (qid ? msgIdToAlbum[String(qid)] : null)
      if (albumId) {
        const removed = removeAlbumEntry(albumId)
        if (msgIdToAlbum[String(qid)]) { delete msgIdToAlbum[String(qid)]; try { fs.writeFileSync(msgMapPath, JSON.stringify(msgIdToAlbum)) } catch (e) {} }
        if (removed) logger.info('album: deleted by reply (' + (removed.intent || '') + ') | now ' + albumIndex.length)
        else logger.info('album: reply-delete — entry ' + albumId + ' already gone')
      } else if (qid) {
        logger.info('album: reply-delete — replied msg ' + qid + ' not in photo map (sent before this build, or not a photo)')
      } else {
        logger.info('album: delete word seen but NO reply/quote — manual delete requires replying to the photo')
      }
      return next() // NON-swallowing: let the bot respond in character
    } catch (e) {
      return next()
    }
  }, true)

  logger.info('photo plugin ready (reply-tag trigger; dryRun=' + !!config.dryRun + ')')
}
