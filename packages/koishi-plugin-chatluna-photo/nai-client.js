'use strict'

// Pure NAI request construction + zip extraction + error classification.
// No koishi / chatluna / fetch here — the actual HTTP call lives in index.js (glue).
// Ported from小白X novel-draw.js (V4.5 branch). Unit-tested in ./test.js.

const zlib = require('zlib')
const { NAI_DEFAULT_PARAMS } = require('./defaults')

const NOVELAI_IMAGE_API = 'https://image.novelai.net/ai/generate-image'
const MAX_SEED = 0xffffffff

// ── tag join (照抄 novel-draw.js:334 — does NOT de-duplicate, by design) ──
function joinTags(...parts) {
  return parts
    .filter(Boolean)
    .map((p) => String(p).trim().replace(/[，、]/g, ',').replace(/^,+|,+$/g, ''))
    .filter((p) => p.length > 0)
    .join(', ')
}

// ── 5x5 grid → NAI float coord (照抄 novel-draw.js:1279-1290) ──
const GRID_COL = { A: 0.1, B: 0.3, C: 0.5, D: 0.7, E: 0.9 }
const GRID_ROW = { 1: 0.1, 2: 0.3, 3: 0.5, 4: 0.7, 5: 0.9 }
function gridToCoord(grid) {
  if (!grid || typeof grid !== 'string') return null
  const m = grid.trim().toUpperCase().match(/^([A-E])([1-5])$/)
  if (!m) return null
  return { x: GRID_COL[m[1]], y: GRID_ROW[m[2]] }
}

// ── danbooru tag → NAI prompt (underscores → spaces). 照抄 novel-draw.js:1301 ──
function danbooruToNai(tag) {
  return String(tag || '').replace(/_/g, ' ')
}

// ── NAI V4.5 request body. Ported from buildNovelAIRequestBody (novel-draw.js:1330) ──
// Fallback defaults use OUR validated preset (NAI_DEFAULT_PARAMS), not小白X's wrong ones.
// input contract: { scene, characterPrompts:[{prompt,uc,center:{x,y}}], negativePrompt, params }
function buildRequestBody({ scene, characterPrompts, negativePrompt, params }) {
  const dp = NAI_DEFAULT_PARAMS
  const chars = Array.isArray(characterPrompts) ? characterPrompts : []
  const width = params?.width ?? dp.width
  const height = params?.height ?? dp.height
  const seed = params?.seed >= 0 ? params.seed : Math.floor(Math.random() * (MAX_SEED + 1))
  const modelName = params?.model ?? dp.model

  let skipCfgAboveSigma = null
  if (params?.variety_boost) {
    skipCfgAboveSigma = Math.pow((width * height) / 1011712, 0.5) * 58
  }

  const useCoords = chars.some((cp) => cp.center && (cp.center.x !== 0.5 || cp.center.y !== 0.5))

  const charCaptions = chars.map((cp) => ({
    char_caption: cp.prompt || '',
    centers: [cp.center || { x: 0.5, y: 0.5 }],
  }))
  const negativeCharCaptions = chars.map((cp) => ({
    char_caption: cp.uc || '',
    centers: [cp.center || { x: 0.5, y: 0.5 }],
  }))

  return {
    action: 'generate',
    input: String(scene || ''),
    model: modelName,
    parameters: {
      params_version: 3,
      width,
      height,
      scale: params?.scale ?? dp.scale,
      seed,
      sampler: params?.sampler ?? dp.sampler,
      noise_schedule: params?.scheduler ?? dp.scheduler,
      steps: params?.steps ?? dp.steps,
      n_samples: 1,
      ucPreset: params?.ucPreset ?? dp.ucPreset,
      qualityToggle: params?.qualityToggle ?? dp.qualityToggle,
      autoSmea: params?.autoSmea ?? dp.autoSmea,
      cfg_rescale: params?.cfg_rescale ?? dp.cfg_rescale,
      dynamic_thresholding: false, // hardcoded in V4.5 (decrisper/sm don't apply)
      controlnet_strength: 1,
      legacy: false,
      legacy_v3_extend: false,
      use_coords: useCoords,
      legacy_uc: false,
      normalize_reference_strength_multiple: true,
      deliberate_euler_ancestral_bug: false,
      prefer_brownian: true,
      image_format: 'png',
      skip_cfg_above_sigma: skipCfgAboveSigma,
      characterPrompts: chars.map((cp) => ({
        prompt: cp.prompt || '',
        uc: cp.uc || '',
        center: cp.center || { x: 0.5, y: 0.5 },
        enabled: true,
      })),
      v4_prompt: {
        caption: { base_caption: String(scene || ''), char_captions: charCaptions },
        use_coords: useCoords,
        use_order: true,
      },
      v4_negative_prompt: {
        caption: { base_caption: String(negativePrompt || ''), char_captions: negativeCharCaptions },
        legacy_uc: false,
      },
      negative_prompt: String(negativePrompt || ''),
    },
  }
}

// ── HTTP status → error (照搬 parseApiError:747) ──
function classifyNaiError(status, text) {
  switch (status) {
    case 401:
      return { code: 'auth', label: 'API Key 无效', message: 'API Key 无效' }
    case 402:
      return { code: 'quota', label: 'Anlas 不足', message: 'Anlas 不足' }
    case 429:
      return { code: 'busy', label: '并发繁忙', message: '当前并发繁忙，请稍后重试' }
    case 500:
    case 502:
    case 503:
      return { code: 'network', label: '服务不可用', message: '服务不可用' }
    default:
      return { code: 'unknown', label: '失败', message: '失败: ' + (text || status) }
  }
}

// ── thrown fetch error → classify (照搬 handleFetchError:759) ──
function classifyFetchError(e) {
  if (e && e.name === 'AbortError') return { code: 'timeout', label: '超时', message: '超时' }
  if (e && e.message && e.message.includes('Failed to fetch'))
    return { code: 'network', label: '网络错误', message: '网络错误' }
  return { code: 'unknown', label: '错误', message: (e && e.message) || '未知错误' }
}

// ── zip → PNG buffer, via Node built-in zlib (jszip NOT installed; see plan §3.1) ──
// NAI returns a zip with a single image entry. Parse the local file header, inflate.
const SIG_LOCAL = Buffer.from([0x50, 0x4b, 0x03, 0x04]) // PK\x03\x04
const SIG_PK = Buffer.from([0x50, 0x4b]) // PK (any record)
function nextPk(buf, from) {
  const n = buf.indexOf(SIG_PK, from)
  return n === -1 ? buf.length : n
}
function extractPngFromNaiZip(data) {
  const buf = Buffer.isBuffer(data) ? data : Buffer.from(data)
  let i = buf.indexOf(SIG_LOCAL)
  while (i !== -1) {
    const flags = buf.readUInt16LE(i + 6)
    const method = buf.readUInt16LE(i + 8)
    const compSize = buf.readUInt32LE(i + 18)
    const nameLen = buf.readUInt16LE(i + 26)
    const extraLen = buf.readUInt16LE(i + 28)
    const name = buf.toString('latin1', i + 30, i + 30 + nameLen)
    const dataStart = i + 30 + nameLen + extraLen
    // NAI streams the zip with a DATA DESCRIPTOR (flag bit 3): compSize is 0 in the local header,
    // real size lives after the data. So the size is only "known" when bit 3 is clear AND compSize>0.
    const hasDataDescriptor = (flags & 0x08) !== 0
    const sizeKnown = compSize > 0 && !hasDataDescriptor
    if (/\.(png|webp)$/i.test(name)) {
      if (method === 0) {
        // stored: need an exact end (best-effort if size unknown)
        const end = sizeKnown ? dataStart + compSize : nextPk(buf, dataStart)
        return Buffer.from(buf.subarray(dataStart, end))
      }
      // deflate: inflateRawSync stops at the deflate stream's end-of-stream marker and ignores
      // trailing bytes (data descriptor + central directory), so passing the rest of the buffer
      // is correct and robust when compSize is unknown.
      const slice = sizeKnown ? buf.subarray(dataStart, dataStart + compSize) : buf.subarray(dataStart)
      return zlib.inflateRawSync(slice)
    }
    // not the image entry → advance to the next local header
    i = buf.indexOf(SIG_LOCAL, sizeKnown ? dataStart + compSize : dataStart + 1)
  }
  throw new Error('ZIP 无 png/webp 图片')
}

module.exports = {
  NOVELAI_IMAGE_API,
  MAX_SEED,
  joinTags,
  gridToCoord,
  danbooruToNai,
  buildRequestBody,
  classifyNaiError,
  classifyFetchError,
  extractPngFromNaiZip,
}
