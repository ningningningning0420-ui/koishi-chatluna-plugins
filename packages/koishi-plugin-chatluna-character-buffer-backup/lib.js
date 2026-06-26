// 纯逻辑：不依赖 koishi 运行时，可离线 node 测。

// 会话 key：与 chatluna-character 内部 `_messages` 的键格式一致。
function deriveKey(session) {
  const isDirect = !!session.isDirect
  return `${isDirect ? 'private' : 'group'}:${isDirect ? session.userId : session.guildId}`
}

// 合并两份 Message[]：按 messageId 去重（缺则回退 id|timestamp），
// incoming 覆盖同键的 existing；按 timestamp 升序；尾部截断到 cap（保留最新）。
function mergeById(existing, incoming, cap) {
  const map = new Map()
  const list = []
  if (Array.isArray(existing)) list.push(...existing)
  if (Array.isArray(incoming)) list.push(...incoming)
  for (const msg of list) {
    if (msg == null) continue
    const key =
      msg.messageId != null ? `mid:${msg.messageId}` : `fb:${msg.id}|${msg.timestamp}`
    map.set(key, msg) // 后写覆盖 → incoming 在 existing 之后入队，故覆盖同键
  }
  const merged = [...map.values()].sort(
    (a, b) => (a.timestamp ?? 0) - (b.timestamp ?? 0)
  )
  if (Number.isFinite(cap) && cap > 0) {
    while (merged.length > cap) merged.shift()
  }
  return merged
}

// 存档是否够新：maxAgeHours<=0 视为不限（永远 fresh）；updatedAt 缺失则保守判 false。
function isFresh(updatedAt, maxAgeHours, now) {
  if (!(maxAgeHours > 0)) return true
  if (updatedAt == null) return false
  const t = updatedAt instanceof Date ? updatedAt.getTime() : new Date(updatedAt).getTime()
  if (Number.isNaN(t)) return false
  return now - t <= maxAgeHours * 3600000
}

module.exports = { deriveKey, mergeById, isFresh }
