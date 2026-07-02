'use strict'

// koishi-plugin-chatluna-relay
// Listens for [[relay:...]] markers in raw chatluna-character model output and
// executes them out-of-band (send a private message, optionally with a photo when a
// 'photo' service exposing recallEntry is present). Markers are stripped from outbound
// text in a before-send hook. Pure guard/parse logic lives in ./guards.js + ./relay-tag.js
// (unit-tested in ./test.js); this file is the koishi/chatluna runtime glue.

const { Schema, h } = require('koishi')
const { pathToFileURL } = require('url')

const guards = require('./guards')
const rtag = require('./relay-tag')

exports.name = 'chatluna-relay'

exports.inject = { required: ['chatluna'], optional: ['chatluna_character', 'photo'] }


exports.Config = Schema.object({
  triggerWhitelist: Schema.array(Schema.string())
    .default([])
    .description('护栏①：允许触发「主动找好友聊」的 QQ 号（至少填你自己）。名单外的人/群里他人一律拒。'),
  recipients: Schema.array(
    Schema.object({
      alias: Schema.string().description('称呼/别名，模型用它指定收件人'),
      qq: Schema.string().description('对应 QQ 号'),
    })
  )
    .default([])
    .description('护栏②：收件人白名单（别名→QQ）。只有名单内的人能被联系。'),
  minIntervalSec: Schema.number()
    .default(60)
    .description('护栏④：两次主动发送的最小间隔（秒）。'),
  dailyLimit: Schema.number()
    .default(20)
    .description('护栏④：每日主动发送上限。'),
  rateLimitEnabled: Schema.boolean()
    .default(true)
    .description('护栏④ 总开关：默认开（按上面的最小间隔/每日上限限流）。关掉则不限次数也不限间隔，bot 可以不停主动私信——⚠️ 风控风险很高，确认要再关。'),
  myBots: Schema.array(Schema.string())
    .default([])
    .description('护栏⑤（可选，默认空）：我方 bot 的 QQ 号。来自这些号的私聊不触发本 bot 自动回复，防两 bot 互刷。'),
  triggerGroups: Schema.array(Schema.string())
    .default([])
    .description('群聊触发白名单：留空 = 只私聊 DM（默认，最安全）。要允许某个群触发 relay，把群号填进来。'),
  dryRun: Schema.boolean()
    .default(true)
    .description('灰度模式（默认开）：检测到 [[relay:...]] 标记只 log、不真发。验证标记不泄露/收件人解析/选图无误后，改 false 才真发。改这个要重启。'),
  debug: Schema.boolean()
    .default(false)
    .description('调试日志：每次模型回复打一行（是否含 [[relay:]]、解析到几条）。排查不触发时打开。'),
})

exports.apply = (ctx, config) => {
  const logger = ctx.logger('relay')

  // Rate limiter — created once, state persists across tool calls.
  const rateLimiter = guards.createRateLimiter({
    minIntervalMs: (config.minIntervalSec || 0) * 1000,
    dailyLimit: config.dailyLimit > 0 ? config.dailyLimit : Infinity,
  })

  // Low-level: push one bot-attributed message into a conversation's chatluna-character
  // buffer (same buffer chatluna itself writes to via broadcastOnBot/_addMessage). The
  // id === bot.selfId is what makes chatluna treat it as the bot's own line. Best-effort.
  function pushToBuffer(key, content, bot) {
    try {
      const cc = ctx.chatluna_character
      if (!cc || typeof cc.getMessages !== 'function' || !content) return
      const msg = {
        content,
        name: (bot.user && bot.user.name) || String(bot.selfId || 'bot'),
        id: String(bot.selfId || '0'),
        timestamp: Date.now(),
      }
      const arr = cc.getMessages(key)
      if (Array.isArray(arr)) arr.push(msg)
      else if (cc._messages) cc._messages[key] = [msg]
    } catch (e) {
      logger.warn('pushToBuffer(' + key + ') failed: ' + (e && e.message))
    }
  }

  // Friend-list cache (best-effort guard ③).
  const FRIEND_TTL = 5 * 60 * 1000
  let friendCache = { ids: null, at: 0 }
  async function getFriendIds(bot) {
    const now = Date.now()
    if (friendCache.ids && now - friendCache.at < FRIEND_TTL) return friendCache.ids
    try {
      if (!bot || typeof bot.getFriendList !== 'function') return null
      const resp = await bot.getFriendList()
      const arr = Array.isArray(resp) ? resp : resp && Array.isArray(resp.data) ? resp.data : []
      const ids = arr
        .map((u) => String((u && (u.id != null ? u.id : u.userId != null ? u.userId : u.user_id)) || ''))
        .filter(Boolean)
      friendCache = { ids, at: now }
      return ids
    } catch (e) {
      logger.warn('getFriendList failed, skipping friend check: ' + (e && e.message))
      return null
    }
  }

  // Guard ⑤ (optional): drop private messages from our own bots so chatluna
  // doesn't auto-reply and two bots ping-pong. Best-effort: prepended middleware
  // preempts chatluna's middleware chain. Off unless myBots is populated.
  if (config.myBots && config.myBots.length) {
    ctx.middleware((session, next) => {
      if (session.isDirect && guards.isMyBot(session.userId, config.myBots)) {
        logger.info('[anti-loop] dropping private message from my-bot ' + session.userId)
        return
      }
      return next()
    }, true /* prepend */)
  }

  // ── per-turn dedup: raw-response fires per accumulating chunk → send each marker once. ──
  // Key = session + resolved identity + CONTENT signature (guards.relaySignature): same-turn chunk
  // re-emits collapse, but a NEW text / photo desc / |nsfw confirm gets a fresh signature and
  // passes (the old alias-only key swallowed the NSFW-confirm resend for 60s). The slot is
  // registered up-front so an in-flight send can't double-fire, and RELEASED again when the
  // attempt didn't actually send (guard-skip / failure), so those don't burn it.
  const seenRelays = new Map()
  // Post-send identity gate (10s): content-signature dedup can't catch a same-turn draft the model
  // REWORDED in a later chunk (new wording = new signature) — without this, that's a double-send to
  // the same person. The window is short so the next-turn |nsfw-confirm resend still passes; the
  // gate only arms on an ACTUAL outbound send (guard-skips / held / dryRun don't arm it).
  const sendGate = guards.createSendGate(10000)
  function relayKeyOf(session) {
    return session.isDirect ? 'private:' + session.userId : 'group:' + (session.guildId != null ? session.guildId : session.channelId)
  }

  // execute one parsed relay marker. Guards → resolve image → rate-limit → send → record.
  // Returns a status for the dedup caller: 'sent' | 'held' | 'dryrun' keep the dedup slot;
  // 'skipped' | 'failed' release it (the attempt didn't send — a retry must not be blocked).
  async function doRelayOne(session, r) {
    const bot = session.bot
    const now = Date.now()
    const tctx = { userId: session.userId, isDirect: session.isDirect, groupId: session.guildId != null ? session.guildId : session.channelId }
    if (!guards.isTriggerAllowed(tctx, { triggerWhitelist: config.triggerWhitelist, triggerGroups: config.triggerGroups })) return 'skipped'
    const recipient = guards.resolveRecipient(r.recipientAlias, config.recipients)
    if (!recipient) { logger.info('relay: 收件人不在白名单: ' + r.recipientAlias); return 'skipped' }
    const friendIds = await getFriendIds(bot)
    if (friendIds && !guards.isFriend(recipient.qq, friendIds)) { logger.info('relay: 非好友: ' + recipient.qq); return 'skipped' }

    // resolve image first so a failed recall doesn't spend a rate slot
    let imageUrl = null
    let imgDesc = ''
    let imgNsfw = false
    let nsfwHeldBack = false
    if (r.photo) {
      if (ctx.photo && typeof ctx.photo.recallEntry === 'function') {
        try {
          // crossRating lets us SEE an opposite-rating match without auto-sending it. NSFW images go out
          // ONLY when the model explicitly flagged |nsfw (intentional). So: if the only match is nsfw but
          // the model did NOT flag it, hold the image back and tell the model to confirm next turn.
          const entry = await ctx.photo.recallEntry(r.photo.desc, { nsfw: r.photo.nsfw, originKey: relayKeyOf(session), scope: 'origin', crossRating: true })
          if (entry && entry.file && entry.nsfw && !r.photo.nsfw) {
            nsfwHeldBack = true
            logger.info('relay: 匹配到的是露骨图但模型没标 |nsfw — 按住不发，提示模型确认')
          } else if (entry && entry.file) {
            imageUrl = pathToFileURL(entry.file).href; imgDesc = entry.intent || r.photo.desc; imgNsfw = !!entry.nsfw
          } else {
            logger.info('relay: 本会话没找到匹配「' + r.photo.desc + '」的照片，只发文字')
          }
        } catch (e) { logger.warn('relay recallEntry 失败: ' + (e && e.message)) }
      } else {
        logger.info('relay: 请求了图片但 photo 服务不可用，只发文字')
      }
    }
    if (!r.text && !imageUrl && !nsfwHeldBack) return 'skipped'

    const imgTag = imgNsfw ? '[露骨]' : ''
    const hasSend = !!(r.text || imageUrl)
    // rate-limit only counts an actual outbound send (the nsfw-confirm note is internal, not a send)
    if (hasSend && config.rateLimitEnabled !== false) {
      const v = rateLimiter.check(now)
      if (!v.ok) { logger.info('relay skip: rate ' + v.reason); return 'skipped' }
      rateLimiter.record(now)
    }

    if (config.dryRun) {
      logger.info('[DRYRUN] relay → ' + recipient.alias + ' text=' + JSON.stringify(r.text) + ' img=' + (imageUrl ? imgDesc + (imgNsfw ? '[nsfw]' : '') : (nsfwHeldBack ? 'HELD(露骨未标nsfw)' : 'none')))
      return 'dryrun'
    }

    try {
      const recipientKey = 'private:' + recipient.qq
      const tkey = relayKeyOf(session)
      const gk = tkey + '||qq:' + recipient.qq // send-gate identity — matches the handler's cand.key
      if (r.text) { await bot.sendPrivateMessage(recipient.qq, r.text); sendGate.record(gk, Date.now()) }
      if (imageUrl) { await bot.sendPrivateMessage(recipient.qq, h.image(imageUrl)); sendGate.record(gk, Date.now()) }
      // record into BOTH buffers so the bot stays self-aware cross-conversation (incl. the photo's rating)
      if (r.text) pushToBuffer(recipientKey, r.text, bot)
      if (imageUrl) pushToBuffer(recipientKey, '（发了一张照片' + imgTag + '：' + imgDesc + '）', bot)
      if (tkey !== recipientKey && hasSend) {
        pushToBuffer(tkey, '（我刚主动给' + recipient.alias + '发了' + (r.text ? '：' + r.text : '') + (imageUrl ? (r.text ? '，还有' : '') + '一张照片' + imgTag + '：' + imgDesc : '') + '）', bot)
      }
      // nsfw held back: tell the model (in ITS OWN conversation) so it can re-send with |nsfw next turn
      if (nsfwHeldBack) {
        pushToBuffer(tkey, '（我想发给' + recipient.alias + '的那张照片是露骨的——这次没发出去；要发的话，下一轮在 relay 标记里给那张图加 |nsfw 确认我要把露骨内容发给ta）', bot)
      }
      if (hasSend) logger.info('relayed → ' + recipient.alias + ' (text=' + !!r.text + ' img=' + !!imageUrl + (imageUrl && imgNsfw ? '[nsfw]' : '') + ')')
      return hasSend ? 'sent' : 'held' // held = only the nsfw-confirm note went out (keep dedup slot so it isn't re-pushed per chunk)
    } catch (e) {
      logger.warn('relay send 失败 → ' + recipient.qq + ': ' + (e && e.message))
      return 'failed'
    }
  }

  // ── read [[relay:...]] from the RAW model output (incl. <think>) and execute out-of-band. ──
  ctx.on('chatluna_character/raw-response', (session, content) => {
    try {
      if (config.debug && typeof content === 'string') {
        logger.info('raw-response fired (len=' + content.length + ' hasRelay=' + (content.indexOf('[[relay:') !== -1) + ' key=' + relayKeyOf(session) + ')')
      }
      if (!session || typeof content !== 'string' || content.indexOf('[[relay:') === -1) return
      const { relays } = rtag.parseRelayTags(content)
      if (!relays.length) return
      const key = relayKeyOf(session)
      // The model often writes SEVERAL candidate [[relay:...]] markers in one turn while it
      // deliberates wording — collapse to one per RESOLVED recipient (alias & bare-QQ writes of the
      // same person merge; last wins = its final choice), then dedup by identity+content signature.
      const now = Date.now()
      for (const [mk, ts] of seenRelays) if (now - ts > 60000) seenRelays.delete(mk)
      for (const cand of guards.lastMarkerPerRecipient(relays, config.recipients)) {
        const dk = key + '||' + guards.relaySignature(cand.key, cand.marker)
        if (seenRelays.has(dk)) {
          if (config.debug) logger.info('relay dedup skip (' + cand.key + ')')
          continue
        }
        // reworded same-turn draft to someone we JUST sent to → suppress (visible in the log).
        // Checked before registering the signature so a post-window retry isn't sig-blocked.
        if (!sendGate.check(key + '||' + cand.key, now)) {
          logger.info('relay: 同轮改稿抑制 — 刚给 ' + cand.key + ' 发过，这条改写版不再发（10s 窗）')
          continue
        }
        seenRelays.set(dk, now)
        doRelayOne(session, cand.marker)
          .then((status) => {
            // release the slot when nothing was sent, so a later legitimate retry isn't blocked
            if (status !== 'sent' && status !== 'held' && status !== 'dryrun') seenRelays.delete(dk)
          })
          .catch((e) => { seenRelays.delete(dk); logger.warn('doRelayOne failed: ' + (e && e.message)) }) // fire-and-forget per recipient
      }
    } catch (e) {
      logger.warn('raw-response relay hook error: ' + (e && e.message))
    }
  })

  // ── strip stray [[relay:...]] from outbound text (defense-in-depth; marker should be in <think>). ──
  ctx.on('before-send', (session) => {
    try {
      if (!session || !Array.isArray(session.elements)) return
      for (const el of session.elements) {
        if (el && el.type === 'text' && el.attrs && typeof el.attrs.content === 'string' && el.attrs.content.indexOf('[[relay:') !== -1) {
          el.attrs.content = rtag.parseRelayTags(el.attrs.content).cleanedText
        }
      }
    } catch (e) { logger.warn('relay before-send hook error: ' + (e && e.message)) }
  })
}
