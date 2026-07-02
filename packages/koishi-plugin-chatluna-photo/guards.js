'use strict'

// Pure, runtime-independent guard logic for koishi-plugin-photo.
// Copied from koishi-plugin-relay/guards.js (don't cross-require another plugin).
// No koishi / chatluna imports — unit-testable with plain node (see test.js).

const norm = (v) => String(v == null ? '' : v).trim()

// Only whitelisted users may trigger taking a photo.
function isAuthorizedTrigger(userId, triggerWhitelist) {
  const u = norm(userId)
  return (triggerWhitelist || []).some((w) => norm(w) === u)
}

// user whitelist + group-trigger whitelist. DM always allowed for a whitelisted user;
// a group is allowed only if its id is in triggerGroups. Empty triggerGroups ⇒ private-only.
// ctx = { userId, isDirect, groupId }, cfg = { triggerWhitelist, triggerGroups }
function isTriggerAllowed(ctx, cfg) {
  ctx = ctx || {}
  cfg = cfg || {}
  if (!isAuthorizedTrigger(ctx.userId, cfg.triggerWhitelist)) return false
  if (ctx.isDirect) return true
  const gid = norm(ctx.groupId)
  return (cfg.triggerGroups || []).some((id) => norm(id) === gid)
}

const dayKeyOf = (ms) => new Date(ms).toISOString().slice(0, 10)

// Rate limiter. check(now) is side-effect free; record(now) commits a send.
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

// Camera auto-shot gate: camera's own throttle + the SHARED photo rate limiter (so auto selfies
// consume the same minInterval/dailyLimit budget as explicit [[photo:]] — camera must not be a
// free path around the cost ceiling). check-only: the caller records on actual enqueue.
// opts = { now, lastShotAt, minIntervalMs, rate?, rateLimitEnabled? } → { ok, reason? }
function checkCameraShot(opts) {
  opts = opts || {}
  const minMs = opts.minIntervalMs || 0
  if (minMs && opts.lastShotAt != null && opts.now - opts.lastShotAt < minMs) {
    return { ok: false, reason: 'camera_throttle' }
  }
  if (opts.rate && opts.rateLimitEnabled !== false) {
    const v = opts.rate.check(opts.now)
    if (!v.ok) return v
  }
  return { ok: true }
}

module.exports = { isAuthorizedTrigger, isTriggerAllowed, createRateLimiter, checkCameraShot }
