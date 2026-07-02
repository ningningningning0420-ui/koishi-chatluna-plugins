'use strict'

// Pure helpers for feeding the just-sent photo back into the bot's OWN context.
// The main chat model is multimodal, so no extra vision calls: the photo self-note in the
// chatluna-character buffer carries the PNG as a data-URL in `.images` + a `selfPhoto` flag,
// and the history-image patch v2 (patches/chatluna-character-history-image-20260628) attaches
// the NEWEST such note's image as real pixels while it is within the last 8 buffered messages.
// No koishi/chatluna imports — unit-tested in ./test.js.

// PNG Buffer + stable id → chatluna-character's message.images entry shape [{url,hash,formatted}]
function makeSelfPhotoImages(png, id) {
  const hash = String(id || 'selfphoto')
  return [{ url: 'data:image/png;base64,' + png.toString('base64'), hash, formatted: '[image:' + hash + ']' }]
}

// Keep at most ONE image-carrying self-photo note per buffer: strip `.images` (big data URLs)
// and the `selfPhoto` flag off older notes IN PLACE — their text stays, user images are never
// touched. Returns how many notes were stripped. Tolerates non-array input.
function stripOldSelfPhotos(messages) {
  let n = 0
  if (!Array.isArray(messages)) return 0
  for (const m of messages) {
    if (m && m.selfPhoto) {
      delete m.images
      delete m.selfPhoto
      n++
    }
  }
  return n
}

module.exports = { makeSelfPhotoImages, stripOldSelfPhotos }
