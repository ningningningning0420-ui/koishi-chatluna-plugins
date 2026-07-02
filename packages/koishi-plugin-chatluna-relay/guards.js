'use strict'

// Pure, runtime-independent guard logic for koishi-plugin-chatluna-relay.
// No koishi / chatluna imports — unit-testable with plain node (see test.js).

const norm = (v) => String(v == null ? '' : v).trim()

// Guard ①: only whitelisted users may trigger an outreach.
function isAuthorizedTrigger(userId, triggerWhitelist) {
  const u = norm(userId)
  return (triggerWhitelist || []).some((w) => norm(w) === u)
}

// Guard ②: map a model-supplied target (alias, or the qq itself) to a
// configured recipient. Returns the recipient object, or null if not listed.
function resolveRecipient(target, recipients) {
  const t = norm(target)
  if (!t) return null
  for (const r of recipients || []) {
    if (norm(r.alias) === t || norm(r.qq) === t) return r
  }
  return null
}

// Guard ③: the target qq must be an actual friend of the bot.
// friendIds = array of qq id strings (caller normalizes the OneBot response).
function isFriend(qq, friendIds) {
  const q = norm(qq)
  return (friendIds || []).some((id) => norm(id) === q)
}

// Guard ⑤ helper: is this incoming sender one of our own bots?
function isMyBot(userId, myBots) {
  const u = norm(userId)
  return (myBots || []).some((b) => norm(b) === u)
}

// UTC-based day key so behaviour is timezone-stable and testable.
const dayKeyOf = (ms) => new Date(ms).toISOString().slice(0, 10)

// Guard ④: rate limiter. `check(now)` is side-effect free; `record(now)`
// commits a send. Caller runs check as the final gate, then record on success.
function createRateLimiter(opts) {
  const minIntervalMs = (opts && opts.minIntervalMs) || 0
  const dailyLimit = (opts && opts.dailyLimit) || Infinity
  let lastMs = -Infinity
  let dayKey = null
  let dayCount = 0

  return {
    check(now) {
      const todaysCount = dayKeyOf(now) === dayKey ? dayCount : 0
      if (now - lastMs < minIntervalMs) return { ok: false, reason: 'too_frequent' }
      if (todaysCount >= dailyLimit) return { ok: false, reason: 'daily_limit' }
      return { ok: true }
    },
    record(now) {
      const dk = dayKeyOf(now)
      if (dk !== dayKey) {
        dayKey = dk
        dayCount = 0
      }
      dayCount += 1
      lastMs = now
    },
  }
}

// Guard ① composed: user whitelist + group-trigger whitelist.
// DM always allowed for a whitelisted user; a group is allowed only if its id is
// in triggerGroups. Empty triggerGroups ⇒ private-only (safe default).
// ctx = { userId, isDirect, groupId }, cfg = { triggerWhitelist, triggerGroups }
function isTriggerAllowed(ctx, cfg) {
  ctx = ctx || {}
  cfg = cfg || {}
  if (!isAuthorizedTrigger(ctx.userId, cfg.triggerWhitelist)) return false
  if (ctx.isDirect) return true
  const gid = norm(ctx.groupId)
  return (cfg.triggerGroups || []).some((id) => norm(id) === gid)
}

// Collapse a turn's candidate markers to one per RESOLVED identity. The model may write the same
// person as an alias in one marker and the bare QQ in another — resolving first means both land in
// the same slot (last wins = the model's final choice). Unresolved aliases keep their own
// alias-keyed slot (they only ever produce a "not whitelisted" log, never a send).
// → [{ key, recipient|null, marker }]
function lastMarkerPerRecipient(relays, recipients) {
  const map = new Map()
  for (const r of relays || []) {
    const rec = resolveRecipient(r.recipientAlias, recipients)
    const key = rec ? 'qq:' + norm(rec.qq) : 'alias:' + norm(r.recipientAlias)
    map.set(key, { key, recipient: rec, marker: r })
  }
  return [...map.values()]
}

// Dedup signature = identity + CONTENT. Re-emits of the same marker by later raw-response chunks
// collapse; a new text / photo desc / |nsfw-confirm for the same recipient gets a fresh signature
// (fixes the old alias-only dedup that swallowed the NSFW confirm resend for 60s).
function relaySignature(identityKey, marker) {
  const p = marker && marker.photo
  return identityKey + '||' + ((marker && marker.text) || '') + '||' + (p ? p.desc || '' : '\x00nophoto') + '||' + (p ? !!p.nsfw : '')
}

// Post-send identity gate: after an ACTUAL outbound send to an identity, suppress further sends to
// the SAME identity for a short window. Content-signature dedup can't catch a same-turn draft the
// model rewrote (new wording = new signature); this gate does, while the next-turn NSFW-confirm
// resend (which arrives after the window) still passes. check is side-effect free.
function createSendGate(windowMs) {
  const last = new Map()
  return {
    check(idKey, now) {
      const t = last.get(idKey)
      return !(t != null && now - t < windowMs)
    },
    record(idKey, now) {
      for (const [k, ts] of last) if (now - ts > windowMs * 10) last.delete(k)
      last.set(idKey, now)
    },
  }
}

module.exports = {
  isAuthorizedTrigger,
  isTriggerAllowed,
  resolveRecipient,
  isFriend,
  isMyBot,
  createRateLimiter,
  lastMarkerPerRecipient,
  relaySignature,
  createSendGate,
}
