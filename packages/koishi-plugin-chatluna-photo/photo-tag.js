'use strict'

// Pure marker parsing for the "reply-tag trigger" approach (replaces the model-tool-call
// approach that crashed chatluna-character's four-part parse). The model writes
// [[photo:意图]] in its output; we strip it from outbound text and extract the intent.
//
// Why [[photo:...]] (double bracket): koishi h.parse treats it as plain text — it matches
// NONE of chatluna-character's structural regexes (<status>/<output>/<message_part>/<message>,
// all angle-bracket XML), so it never breaks parseMessageContent. Verified by code-read +
// adversarial review. <photo>...</photo> is UNSAFE (h.parse makes it an element, the shell is
// dropped and the intent text leaks to the user). No koishi/chatluna imports — unit-tested.

// non-greedy, cannot span ']' — safe with multiple markers / intents containing other chars
const PHOTO_RE = /\[\[photo:([^\]]*?)\]\]/g
// camera-mode toggle: the bot turns a continuous POV "camera" on/off — while on, every reply
// auto-attaches a selfie of its current moment. [[camera:on]] / [[camera:off]] (+ CJK aliases).
const CAMERA_RE = /\[\[camera:\s*(on|off|开启|关闭|开|关)\s*\]\]/gi

const SELF_VALUES = new Set(['selfie', 'from_behind', 'none'])

// placeholder words the model may copy verbatim from the preset example — never a real intent
const PLACEHOLDER_INTENTS = new Set(['意图', '意图描述', '一句话描述', '想拍什么', '描述', 'intent'])

// one marker body → { intent, selfInFrame, nsfw, nosave, recall }
// body syntax: "意图" or "意图|none" or "意图|from_behind|nsfw|delete" (flags after first '|', any order)
//   (photos are saved to the album BY DEFAULT — bot prunes by its own will when full)
//   nosave (|delete) = a throwaway — do NOT keep this one in the album
//   recall = DON'T generate — find a saved album photo matching the description and send it
function parseOneIntent(body) {
  const parts = String(body == null ? '' : body).split('|').map((s) => s.trim())
  const intent = parts[0] || ''
  let selfInFrame = 'selfie'
  let nsfw = false
  let nosave = false
  let recall = false
  for (const raw of parts.slice(1)) {
    const f = raw.toLowerCase().replace(/\s+/g, '_')
    if (SELF_VALUES.has(f)) selfInFrame = f
    else if (f === 'nsfw') nsfw = true
    else if (f === 'sfw') nsfw = false
    else if (f === 'delete' || f === 'nosave' || f === '不留' || f === '别存' || f === '弃' || f === '丢') nosave = true
    else if (f === 'recall' || f === 'resend' || f === '召回' || f === '重发' || f === '翻出') recall = true
  }
  return { intent, selfInFrame, nsfw, nosave, recall }
}

// text → { cleanedText, intents:[{intent,selfInFrame,nsfw}] }
// cleanedText = text with every [[photo:...]] removed (tidied whitespace). Malformed/unclosed
// markers simply don't match → left as-is, no intent, never throws.
function parsePhotoTags(text) {
  const src = String(text == null ? '' : text)
  const intents = []
  const cleaned = src
    .replace(PHOTO_RE, (_, b) => {
      const it = parseOneIntent(b)
      // ignore empty + placeholder intents (model copying the preset example verbatim)
      if (it.intent && !PLACEHOLDER_INTENTS.has(it.intent)) intents.push(it)
      return ''
    })
    .replace(CAMERA_RE, '') // strip [[camera:on/off]] too so it never leaks to the user
    // tidy leftover double spaces / spaces before punctuation from removal
    .replace(/[ \t]{2,}/g, ' ')
    .replace(/[ \t]+([，。！？、,.!?])/g, '$1')
    .replace(/^[ \t]+|[ \t]+$/gm, '')
  return { cleanedText: cleaned, intents }
}

// last camera toggle in the text → 'on' | 'off' | null (later one wins).
function parseCameraToggle(text) {
  let toggle = null
  String(text == null ? '' : text).replace(CAMERA_RE, (_, v) => {
    const s = String(v).toLowerCase()
    toggle = s === 'on' || s === '开' || s === '开启' ? 'on' : 'off'
    return ''
  })
  return toggle
}

// quick boolean — used by hooks to early-return on non-photo messages with zero work
function hasPhotoTag(text) {
  PHOTO_RE.lastIndex = 0
  return PHOTO_RE.test(String(text == null ? '' : text))
}

// any marker THIS plugin strips ([[photo:]] OR [[camera:]]) — the before-send gate must use this,
// not just '[[photo:': parsePhotoTags strips both, so gating on photo alone leaks a lone [[camera:]].
function hasAnyMarker(text) {
  const s = String(text == null ? '' : text)
  PHOTO_RE.lastIndex = 0
  CAMERA_RE.lastIndex = 0
  return PHOTO_RE.test(s) || CAMERA_RE.test(s)
}

module.exports = { PHOTO_RE: () => new RegExp(PHOTO_RE.source, 'g'), parsePhotoTags, parseOneIntent, parseCameraToggle, hasPhotoTag, hasAnyMarker }
