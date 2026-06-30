'use strict'

// Pure marker parsing for relay's reply-tag trigger. Mirrors photo-tag.js.
// The model writes [[relay:别名|文字|图=描述|nsfw]] in its output (preferably inside <think>).
// [[relay:...]] is a plain-text double-bracket token: it matches NONE of chatluna-character's
// structural XML regexes (<status>/<output>/<message_part>/<message>), so it never breaks
// parseMessageContent. <relay>...</relay> would be UNSAFE (h.parse makes it an element). No
// koishi imports — unit-tested in ./test.js.

const RELAY_RE = /\[\[relay:([^\]]*?)\]\]/g

// placeholder words the model may copy from the preset example — never a real recipient
const PLACEHOLDER_ALIAS = new Set(['别名', '收件人', 'target', 'alias', '某人'])

// one marker body → { recipientAlias, text, photo: {desc,nsfw}|null } | null
// body syntax: "别名|文字" | "别名|图=描述|nsfw" | "别名|文字|图=描述" (图=/nsfw tokens after first '|', any order)
function parseOneRelay(body) {
  const fields = String(body == null ? '' : body).split('|')
  const recipientAlias = (fields[0] || '').trim()
  if (!recipientAlias || PLACEHOLDER_ALIAS.has(recipientAlias)) return null
  let photoDesc = null
  let nsfw = false
  const textParts = []
  for (const raw of fields.slice(1)) {
    const m = /^\s*(?:图|photo)\s*=\s*([\s\S]*)$/.exec(raw)
    if (m) { photoDesc = (m[1] || '').trim(); continue }
    if (raw.trim().toLowerCase() === 'nsfw') { nsfw = true; continue }
    textParts.push(raw)
  }
  const text = textParts.join('|').trim()
  const photo = photoDesc !== null ? { desc: photoDesc, nsfw } : null
  if (!text && !photo) return null
  return { recipientAlias, text, photo }
}

// text → { cleanedText, relays:[...] }. Malformed/unclosed markers don't match → left as-is.
function parseRelayTags(text) {
  const src = String(text == null ? '' : text)
  const relays = []
  const cleaned = src
    .replace(RELAY_RE, (_, b) => {
      const r = parseOneRelay(b)
      if (r) relays.push(r)
      return ''
    })
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([，。！？、,.!?])/g, '$1')
    .replace(/^[ \t]+|[ \t]+$/gm, '')
  return { cleanedText: cleaned, relays }
}

function hasRelayTag(text) {
  RELAY_RE.lastIndex = 0
  return RELAY_RE.test(String(text == null ? '' : text))
}

module.exports = { RELAY_RE: () => new RegExp(RELAY_RE.source, 'g'), parseRelayTags, parseOneRelay, hasRelayTag }
