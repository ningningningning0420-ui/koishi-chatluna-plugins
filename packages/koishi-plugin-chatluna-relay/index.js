'use strict'

// koishi-plugin-chatluna-relay
// Registers ONE guarded ChatLuna tool: an authorized user can, in conversation,
// ask the character bot to proactively message a whitelisted friend on a topic.
// The bot sends one opener it composes in its own voice; the ensuing back-and-forth
// is chatluna's normal private-chat behaviour (no relay-back in v1).
//
// Pure guard logic lives in ./guards.js (unit-tested in ./test.js). This file is
// the koishi/chatluna runtime glue, verified via the live-bot acceptance cases.

const { Schema } = require('koishi')
const { ChatLunaPlugin } = require('koishi-plugin-chatluna/services/chat')
const { tool } = require('@langchain/core/tools')
const { z } = require('zod')

const guards = require('./guards')

exports.name = 'chatluna-relay'

exports.inject = { required: ['chatluna'], optional: ['chatluna_character'] }

// Default prompt strings — kept GENERIC so the plugin works for any character bot.
// Each is overridable in config (editable in the koishi console) for per-bot adaptation
// (language, bilingual format, "master" wording, etc. live in config, not in code).
const DEFAULT_TOOL_DESC =
  '主动私信一位好友：以你自己的身份、用你自己的口吻，向这位好友发起或接续一段聊天。' +
  '可以在被要求时使用，也可以在你自己想联系、有话想对他们说时主动发起——' +
  '就像真人一样，按当下的情境和你的性格自然判断要不要联系、找谁、说什么。' +
  '发出去的是你自己组织的话，不是原样转述别人说的话（除非被明确要求原样转达）。'
const DEFAULT_TARGET_DESC = '要联系的好友的称呼（别名，需在收件人名单里）。'
const DEFAULT_MESSAGE_DESC =
  '你要对对方说的话：用你平时的说话风格和完整格式来写，自然切入话题；是你自己的话。'

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
    .description('护栏④ 总开关：默认开（按上面的最小间隔/每日上限限流）。关掉则不限次数也不限间隔，bot 可以不停私信——⚠️ 风控风险很高，确认要再关。'),
  myBots: Schema.array(Schema.string())
    .default([])
    .description('护栏⑤（可选，默认空）：我方 bot 的 QQ 号。来自这些号的私聊不触发本 bot 自动回复，防两 bot 互刷。'),
  triggerGroups: Schema.array(Schema.string())
    .default([])
    .description('群聊触发白名单：留空 = 只私聊 DM（默认，最安全）。要允许某个群触发，把群号填进来。注意只填走「原生 tool-calling」适配器（如 chatluna-claude-adapter）的群；若该群落到 OpenAI 工具方言的兜底配置上，注册工具可能让请求 400。'),
  toolDescription: Schema.string()
    .role('textarea')
    .default(DEFAULT_TOOL_DESC)
    .description('【可改】给模型看的工具说明：决定它何时、怎样使用这个工具。按你的 bot 风格改写。'),
  targetDesc: Schema.string()
    .default(DEFAULT_TARGET_DESC)
    .description('【可改】target 参数说明（收件人别名）。'),
  messageDesc: Schema.string()
    .role('textarea')
    .default(DEFAULT_MESSAGE_DESC)
    .description('【可改】message 参数说明：决定模型怎么组织要发的话。想让 bot 用特定格式/语言（如双语、带中文翻译）就写在这里。'),
  recordSentToMemory: Schema.boolean()
    .default(true)
    .description('把这次主动联系补登记进对话记忆（best-effort）：①收件人会话——标成 bot 自己发的，下次跟对方聊接得上；②发起这次联系的那个会话——记一条「我给谁发了什么」的事实，让 bot 在原会话里也知道自己做过。默认开。'),
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

  // Get the factual context of a sent message into BOTH relevant loops so the bot stays
  // aware of its own action: the recipient's conversation (as its own line) AND the
  // originating conversation (as a first-person action record). Best-effort; never blocks.
  function recordSent(bot, recipient, text, triggerSession) {
    if (config.recordSentToMemory === false) return
    const recipientKey = 'private:' + recipient.qq
    pushToBuffer(recipientKey, text, bot)
    if (triggerSession) {
      const tkey = triggerSession.isDirect
        ? 'private:' + triggerSession.userId
        : 'group:' + triggerSession.guildId
      if (tkey && tkey !== recipientKey) {
        pushToBuffer(tkey, '（我刚主动给' + recipient.alias + '发了消息：' + text + '）', bot)
      }
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

  // The tool. createTool returns this same instance (closure).
  const findFriendChatTool = tool(
    async (input, runConfig) => {
      const session = runConfig && runConfig.configurable && runConfig.configurable.session
      if (!session) return '[系统] 当前没有会话上下文，无法发送。'
      const bot = session.bot
      const now = Date.now()

      // Guard ① — trigger allowed (user whitelist + group whitelist; defense-in-depth on authorization()).
      if (
        !guards.isTriggerAllowed(
          { userId: session.userId, isDirect: session.isDirect, groupId: session.guildId != null ? session.guildId : session.channelId },
          { triggerWhitelist: config.triggerWhitelist, triggerGroups: config.triggerGroups }
        )
      ) {
        return '[系统] 无权使用此工具（发起者不在触发白名单，或不是允许的会话）。'
      }

      // Guard ② — recipient whitelist.
      const recipient = guards.resolveRecipient(input.target, config.recipients)
      if (!recipient) {
        return '[系统] 收件人「' + input.target + '」不在白名单，未发送。'
      }

      // Guard ③ — friend check (best-effort; skipped if the list can't be fetched).
      const friendIds = await getFriendIds(bot)
      if (friendIds && !guards.isFriend(recipient.qq, friendIds)) {
        return '[系统] 「' + recipient.alias + '」不是好友，未发送。'
      }

      // Guard ④ — rate limit (final gate before the side effect). Skippable via config.
      if (config.rateLimitEnabled !== false) {
        const verdict = rateLimiter.check(now)
        if (!verdict.ok) {
          return verdict.reason === 'too_frequent'
            ? '[系统] 触发过于频繁（最小间隔未到），未发送。'
            : '[系统] 已达今日发送上限，未发送。'
        }
      }

      // Send the opener. Only record the rate-limit slot on success.
      try {
        await bot.sendPrivateMessage(recipient.qq, input.message)
        rateLimiter.record(now)
        recordSent(bot, recipient, input.message, session)
        logger.info('relayed opener to ' + recipient.alias + ' (' + recipient.qq + ')')
        return '[系统] 已发送给「' + recipient.alias + '」。'
      } catch (e) {
        logger.warn('sendPrivateMessage failed to ' + recipient.qq + ': ' + (e && e.message))
        return '[系统] 发送给「' + recipient.alias + '」失败：' + (e && e.message)
      }
    },
    {
      name: 'find_friend_chat',
      description: config.toolDescription || DEFAULT_TOOL_DESC,
      schema: z.object({
        target: z.string().describe(config.targetDesc || DEFAULT_TARGET_DESC),
        message: z.string().describe(config.messageDesc || DEFAULT_MESSAGE_DESC),
      }),
    }
  )

  // Construct synchronously in apply so the constructor's own ctx.on('ready')
  // (installPlugin) fires. Register the tool inside ready, mirroring plugin-common.
  const plugin = new ChatLunaPlugin(ctx, config, 'relay', false)
  ctx.on('ready', () => {
    plugin.registerTool('find_friend_chat', {
      description: findFriendChatTool.description,
      selector() {
        return true
      },
      authorization(session) {
        // Guard ① at availability level: user whitelist + group-trigger whitelist.
        return guards.isTriggerAllowed(
          { userId: session.userId, isDirect: session.isDirect, groupId: session.guildId != null ? session.guildId : session.channelId },
          { triggerWhitelist: config.triggerWhitelist, triggerGroups: config.triggerGroups }
        )
      },
      meta: {
        source: 'extension',
        group: 'relay',
        tags: ['relay'],
        defaultAvailability: {
          enabled: true,
          main: true,
          chatluna: true,
          // No groups whitelisted → 'private' (tool isn't even scope-offered in groups).
          // With groups listed → 'all', and authorization restricts to exactly those group
          // ids — keeping the tool off the openai-like unmatched-group config (OpenAI tool
          // dialect) that would 400 on an OpenAI-dialect endpoint.
          characterScope: config.triggerGroups && config.triggerGroups.length ? 'all' : 'private',
        },
      },
      createTool() {
        return findFriendChatTool
      },
    })
    logger.info('find_friend_chat tool registered')
  })
}
