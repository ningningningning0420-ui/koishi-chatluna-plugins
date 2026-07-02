'use strict'

// Offline self-test for the pure logic. Run: `node test.js`
// No framework — matches the project's existing offline-self-test habit (relay/forward-msg).

const assert = require('assert')
const zlib = require('zlib')

const nai = require('./nai-client')
const asm = require('./assemble')
const guards = require('./guards')
const sp = require('./scene-planner')
const ptag = require('./photo-tag')
const album = require('./album')
const D = require('./defaults')

let pass = 0
let fail = 0
const pending = []
function test(name, fn) {
  try {
    const r = fn()
    if (r && typeof r.then === 'function') {
      pending.push(
        r.then(
          () => {
            pass++
            console.log('PASS  ' + name)
          },
          (e) => {
            fail++
            console.log('FAIL  ' + name + '  ::  ' + (e && e.message))
          }
        )
      )
    } else {
      pass++
      console.log('PASS  ' + name)
    }
  } catch (e) {
    fail++
    console.log('FAIL  ' + name + '  ::  ' + (e && e.message))
  }
}

// ──────────────── joinTags / danbooruToNai / gridToCoord ────────────────
test('joinTags: filters empties, trims, 全角逗号→半角, strips edge commas', () => {
  assert.strictEqual(nai.joinTags('a', '', '  b ', 'c，d'), 'a, b, c,d')
  assert.strictEqual(nai.joinTags(',x,', null, undefined), 'x')
})
test('joinTags: does NOT de-duplicate (preserves repeats)', () => {
  assert.strictEqual(nai.joinTags('lowres', 'lowres'), 'lowres, lowres')
})
test('danbooruToNai: underscores → spaces', () => {
  assert.strictEqual(nai.danbooruToNai('higekiri_(touken_ranbu)'), 'higekiri (touken ranbu)')
})
test('gridToCoord: C3 center / A1 / invalid → null', () => {
  assert.deepStrictEqual(nai.gridToCoord('C3'), { x: 0.5, y: 0.5 })
  assert.deepStrictEqual(nai.gridToCoord('A1'), { x: 0.1, y: 0.1 })
  assert.strictEqual(nai.gridToCoord('Z9'), null)
  assert.strictEqual(nai.gridToCoord(''), null)
})

// ──────────────── classifyNaiError ────────────────
test('classifyNaiError: 401/402/429/5xx/other', () => {
  assert.strictEqual(nai.classifyNaiError(401).code, 'auth')
  assert.strictEqual(nai.classifyNaiError(402).code, 'quota')
  assert.strictEqual(nai.classifyNaiError(429).code, 'busy')
  assert.strictEqual(nai.classifyNaiError(503).code, 'network')
  assert.strictEqual(nai.classifyNaiError(418).code, 'unknown')
})
test('classifyFetchError: AbortError → timeout', () => {
  const e = new Error('aborted')
  e.name = 'AbortError'
  assert.strictEqual(nai.classifyFetchError(e).code, 'timeout')
})

// ──────────────── buildRequestBody (V4.5, validated-preset fallback) ────────────────
test('buildRequestBody: V4.5 shape + validated-preset defaults via fallback', () => {
  const body = nai.buildRequestBody({
    scene: 'best quality, onsen, steam',
    characterPrompts: [{ prompt: 'higekiri (touken ranbu), selfie', uc: '', center: { x: 0.5, y: 0.5 } }],
    negativePrompt: 'lowres',
    params: { seed: 12345 }, // rest falls back to NAI_DEFAULT_PARAMS
  })
  assert.strictEqual(body.action, 'generate')
  assert.strictEqual(body.input, 'best quality, onsen, steam')
  assert.strictEqual(body.model, 'nai-diffusion-4-5-full')
  const p = body.parameters
  assert.strictEqual(p.params_version, 3)
  assert.strictEqual(p.sampler, 'k_dpmpp_2m')
  assert.strictEqual(p.scale, 7.5)
  assert.strictEqual(p.steps, 28)
  assert.strictEqual(p.width, 1216)
  assert.strictEqual(p.height, 832)
  assert.strictEqual(p.qualityToggle, false)
  assert.strictEqual(p.ucPreset, 3)
  assert.strictEqual(p.noise_schedule, 'karras')
  assert.strictEqual(p.seed, 12345)
  assert.strictEqual(p.n_samples, 1)
  assert.strictEqual(p.dynamic_thresholding, false)
  assert.strictEqual(p.use_coords, false) // single centered char
})
test('buildRequestBody: V4.5 double caption + negative mirror', () => {
  const body = nai.buildRequestBody({
    scene: 'scene tags',
    characterPrompts: [{ prompt: 'char tags', uc: 'no hat', center: { x: 0.5, y: 0.5 } }],
    negativePrompt: 'neg tags',
    params: { seed: 1 },
  })
  const p = body.parameters
  assert.strictEqual(p.v4_prompt.caption.base_caption, 'scene tags')
  assert.strictEqual(p.v4_prompt.caption.char_captions[0].char_caption, 'char tags')
  assert.deepStrictEqual(p.v4_prompt.caption.char_captions[0].centers, [{ x: 0.5, y: 0.5 }])
  assert.strictEqual(p.v4_negative_prompt.caption.base_caption, 'neg tags')
  assert.strictEqual(p.v4_negative_prompt.caption.char_captions[0].char_caption, 'no hat')
  assert.strictEqual(p.negative_prompt, 'neg tags') // top-level redundant copy
  assert.deepStrictEqual(p.characterPrompts[0], { prompt: 'char tags', uc: 'no hat', center: { x: 0.5, y: 0.5 }, enabled: true })
})
test('buildRequestBody: off-center char → use_coords true', () => {
  const body = nai.buildRequestBody({ scene: 's', characterPrompts: [{ prompt: 'c', center: { x: 0.1, y: 0.1 } }], negativePrompt: 'n', params: { seed: 1 } })
  assert.strictEqual(body.parameters.use_coords, true)
})

// ──────────────── gateSelfInFrame ────────────────
test('gateSelfInFrame: selfie/from_behind inject; none does not', () => {
  assert.strictEqual(asm.gateSelfInFrame('selfie').inject, true)
  assert.ok(asm.gateSelfInFrame('selfie').extraTags.includes('selfie'))
  assert.strictEqual(asm.gateSelfInFrame('from_behind').inject, true)
  assert.ok(asm.gateSelfInFrame('from_behind').extraTags.includes('from behind'))
  const none = asm.gateSelfInFrame('none')
  assert.strictEqual(none.inject, false)
  assert.strictEqual(none.extraTags, '') // none does NOT force "no humans"
})

// ──────────────── buildPhotoPrompt ────────────────
const SELF_CHARS = [{ prompt: 'towel, wet hair, smile', uc: '', center: { x: 0.5, y: 0.5 } }]
test('buildPhotoPrompt selfie: own tag into char block, NOT into scene', () => {
  const out = asm.buildPhotoPrompt({
    positivePrefix: D.POSITIVE_PREFIX,
    characterTag: 'higekiri_(touken_ranbu)',
    plannerScene: 'onsen, steam, night',
    plannerChars: SELF_CHARS,
    negativePrefix: D.NEGATIVE_PREFIX,
    selfInFrame: 'selfie',
  })
  assert.ok(out.scene.includes('onsen'))
  assert.ok(!out.scene.includes('higekiri'), 'scene must NOT contain character tag')
  assert.ok(out.characterPrompts[0].prompt.includes('higekiri (touken ranbu)'))
  assert.ok(out.characterPrompts[0].prompt.includes('selfie'))
  assert.ok(out.characterPrompts[0].prompt.includes('towel')) // planner self description merged
  assert.strictEqual(out.negativePrompt, D.NEGATIVE_PREFIX)
})
test('buildPhotoPrompt none: no own tag injected, planner chars pass through', () => {
  const others = [{ prompt: 'sunset over sea, no humans', uc: '', center: { x: 0.5, y: 0.5 } }]
  const out = asm.buildPhotoPrompt({
    positivePrefix: D.POSITIVE_PREFIX,
    characterTag: 'higekiri_(touken_ranbu)',
    plannerScene: 'sunset over sea',
    plannerChars: others,
    negativePrefix: D.NEGATIVE_PREFIX,
    selfInFrame: 'none',
  })
  assert.ok(!out.scene.includes('higekiri'))
  assert.ok(!out.characterPrompts.some((c) => c.prompt.includes('higekiri')), 'none must not inject self tag')
  assert.strictEqual(out.characterPrompts.length, 1)
})
test('sanity: POSITIVE_PREFIX (画风串) itself contains no character tag', () => {
  assert.ok(!D.POSITIVE_PREFIX.includes('higekiri'))
})

// ──────────────── 🔴 cross-module invariant (full chain) ────────────────
test('INVARIANT: own character tag only in char_captions, never in base_caption', () => {
  const photo = asm.buildPhotoPrompt({
    positivePrefix: D.POSITIVE_PREFIX,
    characterTag: 'higekiri_(touken_ranbu)',
    plannerScene: 'cafe, afternoon light',
    plannerChars: SELF_CHARS,
    negativePrefix: D.NEGATIVE_PREFIX,
    selfInFrame: 'selfie',
  })
  const body = nai.buildRequestBody({ ...photo, params: { seed: 7 } })
  const cap = body.parameters.v4_prompt.caption
  assert.ok(!cap.base_caption.includes('higekiri'), 'base_caption must NOT contain own character tag')
  assert.ok(cap.char_captions[0].char_caption.includes('higekiri'), 'char_captions must contain own character tag')
})

// ──────────────── zip extraction (zlib hand-unzip) ────────────────
function makeZip(name, content, method) {
  method = method == null ? 8 : method
  const body = method === 8 ? zlib.deflateRawSync(content) : Buffer.from(content)
  const nameBuf = Buffer.from(name, 'latin1')
  const h = Buffer.alloc(30)
  h.writeUInt32LE(0x04034b50, 0) // PK\x03\x04
  h.writeUInt16LE(20, 4)
  h.writeUInt16LE(0, 6) // flags (no data descriptor)
  h.writeUInt16LE(method, 8)
  h.writeUInt16LE(0, 10)
  h.writeUInt16LE(0, 12)
  h.writeUInt32LE(0, 14) // crc (parser ignores)
  h.writeUInt32LE(body.length, 18) // comp size
  h.writeUInt32LE(content.length, 22) // uncomp size
  h.writeUInt16LE(nameBuf.length, 26)
  h.writeUInt16LE(0, 28)
  return Buffer.concat([h, nameBuf, body])
}
const PNG_MAGIC = Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a])
const FAKE_PNG = Buffer.concat([PNG_MAGIC, Buffer.from('fake png payload bytes 1234567890')])

test('extractPngFromNaiZip: deflate entry round-trips to original PNG', () => {
  const out = nai.extractPngFromNaiZip(makeZip('image_0.png', FAKE_PNG, 8))
  assert.ok(out.equals(FAKE_PNG))
  assert.ok(out.subarray(0, 8).equals(PNG_MAGIC)) // PNG magic intact
})
test('extractPngFromNaiZip: stored (method 0) entry works', () => {
  const out = nai.extractPngFromNaiZip(makeZip('image_0.png', FAKE_PNG, 0))
  assert.ok(out.equals(FAKE_PNG))
})
test('extractPngFromNaiZip: skips non-image first entry, finds the png', () => {
  const zip = Buffer.concat([makeZip('readme.txt', Buffer.from('hello'), 8), makeZip('image_0.png', FAKE_PNG, 8)])
  const out = nai.extractPngFromNaiZip(zip)
  assert.ok(out.equals(FAKE_PNG))
})
test('extractPngFromNaiZip: no image entry → throws', () => {
  assert.throws(() => nai.extractPngFromNaiZip(makeZip('readme.txt', Buffer.from('x'), 8)))
})

// ──────────────── guards ────────────────
test('guards.isAuthorizedTrigger: whitelist match (numeric/string)', () => {
  assert.strictEqual(guards.isAuthorizedTrigger(123, ['123']), true)
  assert.strictEqual(guards.isAuthorizedTrigger('999', ['123']), false)
  assert.strictEqual(guards.isAuthorizedTrigger('123', []), false)
})
test('guards.isTriggerAllowed: DM allowed for whitelisted; group gated', () => {
  const cfg = { triggerWhitelist: ['1'], triggerGroups: ['g9'] }
  assert.strictEqual(guards.isTriggerAllowed({ userId: '1', isDirect: true }, cfg), true)
  assert.strictEqual(guards.isTriggerAllowed({ userId: '1', isDirect: false, groupId: 'g9' }, cfg), true)
  assert.strictEqual(guards.isTriggerAllowed({ userId: '1', isDirect: false, groupId: 'gX' }, cfg), false)
  assert.strictEqual(guards.isTriggerAllowed({ userId: '2', isDirect: true }, cfg), false)
})
test('guards.createRateLimiter: interval + daily limit', () => {
  const rl = guards.createRateLimiter({ minIntervalMs: 1000, dailyLimit: 2 })
  const t0 = Date.UTC(2026, 5, 29, 12, 0, 0)
  assert.strictEqual(rl.check(t0).ok, true)
  rl.record(t0)
  assert.strictEqual(rl.check(t0 + 500).ok, false) // too frequent
  assert.strictEqual(rl.check(t0 + 1500).ok, true)
  rl.record(t0 + 1500)
  assert.strictEqual(rl.check(t0 + 3000).ok, false) // daily limit reached (2)
})

// ──────────────── scene-planner: parsePlannerOutput ────────────────
const SELFIE_YAML = [
  '```yaml',
  'mindful_prelude:',
  '  note: some noise the system ignores',
  'images:',
  '  - scene: 1boy, solo, selfie, indoors, cafe, afternoon light',
  '    characters:',
  '      - danbooru: ""',
  '        costume: white shirt, jacket',
  '        action: smile, looking at viewer, peace sign',
  '        uc: hat',
  '        center: C3',
  '```',
].join('\n')

test('parsePlannerOutput: strips fence + mindful_prelude, extracts scene + self char', () => {
  const out = sp.parsePlannerOutput(SELFIE_YAML)
  assert.ok(out.scene.includes('selfie') && out.scene.includes('cafe'))
  assert.strictEqual(out.chars.length, 1)
  // self subject: danbooru "" → prompt is costume+action only, NO identity
  assert.ok(out.chars[0].prompt.includes('white shirt'))
  assert.ok(out.chars[0].prompt.includes('smile'))
  assert.strictEqual(out.chars[0].uc, 'hat')
  assert.deepStrictEqual(out.chars[0].center, { x: 0.5, y: 0.5 })
})
test('parsePlannerOutput: OTHER character danbooru tag → underscores→spaces', () => {
  const y = 'images:\n  - scene: 2girls\n    characters:\n      - danbooru: hatsune_miku\n        costume: dress\n        action: wave'
  const out = sp.parsePlannerOutput(y)
  assert.ok(out.chars[0].prompt.includes('hatsune miku'))
})
test('parsePlannerOutput: scenery (no characters) → chars=[]', () => {
  const out = sp.parsePlannerOutput('images:\n  - scene: no humans, scenery, sunset, ocean')
  assert.ok(out.scene.includes('no humans'))
  assert.strictEqual(out.chars.length, 0)
})
test('parsePlannerOutput: invalid / empty → throws PlannerError', () => {
  assert.throws(() => sp.parsePlannerOutput(''), (e) => e.code === 'EMPTY_OUTPUT')
  assert.throws(() => sp.parsePlannerOutput('just some prose, no yaml structure: : :['), (e) => e instanceof sp.PlannerError)
  assert.throws(() => sp.parsePlannerOutput('foo: bar'), (e) => e.code === 'PARSE_ERROR') // no images[]
})
test('parsePlannerOutput: malformed indentation (claude over-indents characters) → lenient parse recovers', () => {
  // exact shape from the live failure: `characters:` indented deeper than its sibling `scene:`
  const bad = ['- scene: nsfw, 1girl, close-up, macro, extreme detail', '    characters:', '      - danbooru: ""', '        action: finger insertion, vagina, wet'].join('\n')
  const out = sp.parsePlannerOutput(bad)
  assert.ok(out.scene.includes('nsfw') && out.scene.includes('1girl'))
  assert.strictEqual(out.chars.length, 1)
  assert.ok(out.chars[0].prompt.includes('finger insertion') && out.chars[0].prompt.includes('wet'))
})
test('parsePlannerOutput: bare list, no images: wrapper (claude prefill continuation) → wrapped', () => {
  const out = sp.parsePlannerOutput('- scene: 1boy, solo, smiling\n  characters:\n    - danbooru: ""\n      action: waving')
  assert.ok(out.scene.includes('1boy'))
  assert.strictEqual(out.chars.length, 1)
  assert.ok(out.chars[0].prompt.includes('waving'))
})

// ──────────────── scene-planner: buildPlannerMessages ────────────────
test('buildPlannerMessages: unified — always system + user + compliance prefill (both ratings)', () => {
  for (const nsfw of [false, true]) {
    const m = sp.buildPlannerMessages({ intent: '刚泡完温泉', recentDialogue: '', selfInFrame: 'selfie', nsfw })
    assert.strictEqual(m[0].role, 'system')
    assert.strictEqual(m[1].role, 'user')
    assert.strictEqual(m[2].role, 'assistant')
    assert.ok(m[2].content.includes('FICTIONAL_CREATIVE_WORK'))
    assert.ok(m[1].content.includes('SELF-PORTRAIT'))
  }
})
test('buildPlannerMessages: ONE format — system prompt identical for sfw & nsfw (no separate path)', () => {
  const sfw = sp.buildPlannerMessages({ intent: 'x', selfInFrame: 'selfie', nsfw: false })
  const nsfwm = sp.buildPlannerMessages({ intent: 'x', selfInFrame: 'selfie', nsfw: true })
  assert.strictEqual(sfw[0].content, nsfwm[0].content) // unified: same system, no nsfw addendum
  assert.ok(/RATING/.test(sp.PLANNER_SYSTEM) && /nsfw/i.test(sp.PLANNER_SYSTEM)) // vocab is always present
})
test('PLANNER_SYSTEM: frames output as a CAMERA photo, not a third-person illustration', () => {
  assert.ok(/CAMERA, NOT CANVAS/i.test(sp.PLANNER_SYSTEM))
  assert.ok(/phone|amateur photo|candid|pov/i.test(sp.PLANNER_SYSTEM)) // photographic framing tags suggested
  assert.ok(/AVOID illustration|official art/i.test(sp.PLANNER_SYSTEM)) // explicitly steers away from illustration
})
test('buildContent: selfGender injects a SELF SEX constraint (stops gender-flipping the self in nsfw)', () => {
  const m = sp.buildPlannerMessages({ intent: 'x', selfInFrame: 'selfie', nsfw: true, selfGender: 'male' })
  assert.ok(/SELF SEX/.test(m[1].content) && /male/.test(m[1].content))
  assert.ok(/opposite-sex/i.test(m[1].content))
  const m2 = sp.buildPlannerMessages({ intent: 'x', selfInFrame: 'selfie', nsfw: true }) // unset → absent
  assert.ok(!/SELF SEX/.test(m2[1].content))
})
test('buildContent: now hint grounds the photo in the real time of day (place from context)', () => {
  const m = sp.buildPlannerMessages({ intent: 'x', selfInFrame: 'selfie', now: '2026-6-29 周日 夜晚22:30，夏季' })
  assert.ok(/现在大约/.test(m[1].content) && m[1].content.includes('夜晚22:30'))
  const m2 = sp.buildPlannerMessages({ intent: 'x', selfInFrame: 'selfie' }) // unset → absent
  assert.ok(!/现在大约/.test(m2[1].content))
})
test('buildPlannerMessages: nsfw flag only adds an explicit NOTE in the user content', () => {
  const m = sp.buildPlannerMessages({ intent: 'x', selfInFrame: 'selfie', nsfw: true })
  assert.ok(m[1].content.includes('intimate/explicit'))
})
test('buildPlannerMessages: none directive says not in photo, no forced no-humans-on-self', () => {
  const m = sp.buildPlannerMessages({ intent: '拍夕阳', selfInFrame: 'none', nsfw: false })
  assert.ok(m[1].content.includes('NOT in this photo'))
})
test('buildPlannerMessages: the fixed 画师串 is NOT injected into any planner message', () => {
  // (the system prompt legitimately *mentions* "best quality" in a "do NOT output" rule;
  //  the real invariant is that the configured artist string / positive prefix isn't leaked)
  const m = sp.buildPlannerMessages({ intent: 'x', selfInFrame: 'selfie', nsfw: true })
  const all = m.map((x) => x.content).join('\n')
  assert.ok(!all.includes('zero q 0q')) // distinctive artist token from the 画师串
  assert.ok(!all.includes(D.POSITIVE_PREFIX))
  assert.ok(/Do NOT output quality tags/i.test(all)) // it DOES instruct against quality words
})
test('buildPlannerMessages strict: appends CRITICAL OUTPUT RULE', () => {
  const m = sp.buildPlannerMessages({ intent: 'x', selfInFrame: 'selfie' }, { strict: true })
  assert.ok(m[0].content.includes('CRITICAL OUTPUT RULE'))
})

// ──────────────── scene-planner: character library (multi-person) ────────────────
test('formatCharacterLibrary: known→danbooru(spaces), OC→appear, empty/unusable→""', () => {
  const out = sp.formatCharacterLibrary([{ name: '膝丸', danbooru: 'hizamaru_(touken_ranbu)' }, { name: '主人', appearance: 'black hair, hair bun' }])
  assert.ok(out.includes('膝丸: danbooru=hizamaru (touken ranbu)')) // underscores→spaces
  assert.ok(out.includes('主人: appear=black hair, hair bun'))
  assert.strictEqual(sp.formatCharacterLibrary([]), '')
  assert.strictEqual(sp.formatCharacterLibrary([{ name: 'x' }]), '') // no danbooru/appear → skipped
})
test('buildPlannerMessages: characterLibrary appears in content when provided', () => {
  const m = sp.buildPlannerMessages({ intent: '和膝丸合影', selfInFrame: 'selfie', characterLibrary: [{ name: '膝丸', danbooru: 'hizamaru_(touken_ranbu)' }] })
  assert.ok(m[1].content.includes('character_library'))
  assert.ok(m[1].content.includes('hizamaru (touken ranbu)'))
})
test('buildPlannerMessages: no library → no library block (single-person unaffected)', () => {
  const m = sp.buildPlannerMessages({ intent: '自拍', selfInFrame: 'selfie' })
  assert.ok(!m[1].content.includes('character_library'))
})

// ──────────────── scene-planner: planScene orchestration + retry ────────────────
test('planScene: stub invokeModel returns YAML → {scene, chars, negative}', async () => {
  const out = await sp.planScene({ invokeModel: async () => SELFIE_YAML }, { intent: 'x', selfInFrame: 'selfie' })
  assert.ok(out.scene.includes('selfie'))
  assert.strictEqual(out.chars.length, 1)
  assert.ok('prompt' in out.chars[0] && 'center' in out.chars[0])
})
test('planScene: retries once on bad output, succeeds on second', async () => {
  let n = 0
  const calls = []
  const deps = {
    invokeModel: async (messages) => {
      calls.push(messages)
      n++
      return n === 1 ? 'garbage not yaml : : [' : SELFIE_YAML
    },
  }
  const out = await sp.planScene(deps, { intent: 'x', selfInFrame: 'selfie' })
  assert.strictEqual(n, 2)
  assert.ok(out.scene.includes('selfie'))
  assert.ok(calls[1][0].content.includes('CRITICAL OUTPUT RULE')) // 2nd attempt is strict
})
test('planScene: input.systemPrompt (user-edited output-format) overrides PLANNER_SYSTEM on BOTH attempts', async () => {
  const CUSTOM = 'MY CUSTOM OUTPUT FORMAT XYZZY'
  let n = 0
  const calls = []
  const deps = { invokeModel: async (messages) => { calls.push(messages); n++; return n === 1 ? 'garbage : [' : SELFIE_YAML } }
  const out = await sp.planScene(deps, { intent: 'x', selfInFrame: 'selfie', systemPrompt: CUSTOM })
  assert.strictEqual(n, 2)
  assert.ok(out.scene.includes('selfie'))
  assert.ok(calls[0][0].content.includes('XYZZY')) // attempt 1 uses the edited prompt
  assert.ok(calls[1][0].content.includes('XYZZY')) // strict retry STILL uses it (the override bug we fixed)
  assert.ok(calls[1][0].content.includes('CRITICAL OUTPUT RULE')) // and still appends the strict rule
})
test('planScene: both attempts bad → throws (handler will ack-fail)', async () => {
  let threw = false
  try {
    await sp.planScene({ invokeModel: async () => 'still garbage : [' }, { intent: 'x', selfInFrame: 'selfie' })
  } catch (e) {
    threw = e instanceof sp.PlannerError
  }
  assert.ok(threw)
})

// ──────────────── photo-tag: marker parse + strip (reply-tag trigger) ────────────────
test('parsePhotoTags: single marker → intent extracted, marker removed from text', () => {
  const { cleanedText, intents } = ptag.parsePhotoTags('拗不过你呢 [[photo:深夜缘侧自拍，看镜头]] 看够就睡吧')
  assert.ok(!cleanedText.includes('[[photo'))
  assert.ok(cleanedText.includes('拗不过你呢') && cleanedText.includes('看够就睡吧'))
  assert.strictEqual(intents.length, 1)
  assert.strictEqual(intents[0].intent, '深夜缘侧自拍，看镜头')
  assert.strictEqual(intents[0].selfInFrame, 'selfie')
  assert.strictEqual(intents[0].nsfw, false)
})
test('parsePhotoTags: flags after | → selfInFrame / nsfw / nosave / recall', () => {
  assert.deepStrictEqual(ptag.parseOneIntent('窗外晚霞|none'), { intent: '窗外晚霞', selfInFrame: 'none', nsfw: false, nosave: false, recall: false })
  assert.deepStrictEqual(ptag.parseOneIntent('背影|from_behind'), { intent: '背影', selfInFrame: 'from_behind', nsfw: false, nosave: false, recall: false })
  assert.deepStrictEqual(ptag.parseOneIntent('床上|nsfw'), { intent: '床上', selfInFrame: 'selfie', nsfw: true, nosave: false, recall: false })
  assert.deepStrictEqual(ptag.parseOneIntent('x|nsfw|none'), { intent: 'x', selfInFrame: 'none', nsfw: true, nosave: false, recall: false })
})
test('parsePhotoTags: |delete (throwaway, not saved) and |recall (resend) flags, incl. Chinese aliases', () => {
  assert.strictEqual(ptag.parseOneIntent('随手一张|delete').nosave, true)
  assert.strictEqual(ptag.parseOneIntent('糊了|nsfw|不留').nosave, true) // composes with nsfw, Chinese alias
  assert.strictEqual(ptag.parseOneIntent('那张缘侧自拍|recall').recall, true)
  assert.strictEqual(ptag.parseOneIntent('上次那张|召回').recall, true) // Chinese alias
  assert.strictEqual(ptag.parseOneIntent('普通自拍').nosave, false) // default: saved (keep-all)
  assert.strictEqual(ptag.parseOneIntent('普通自拍').recall, false)
})
test('album.parsePruneDecision: tolerant parse of the overflow-prune reply → ids', () => {
  assert.deepStrictEqual(album.parsePruneDecision('{"delete":["a1","a2"]}'), ['a1', 'a2'])
  assert.deepStrictEqual(album.parsePruneDecision('删这些：{"delete": ["p1"]} 就好'), ['p1']) // embedded in prose
  assert.deepStrictEqual(album.parsePruneDecision('["x","y","z"]'), ['x', 'y', 'z']) // bare array
  assert.deepStrictEqual(album.parsePruneDecision('我觉得都该留着'), []) // no parseable ids → empty (prune nothing)
  assert.deepStrictEqual(album.parsePruneDecision(''), [])
})

// ──────────────── album: recall matching ────────────────
const ALBUM = [
  { id: 'a1', file: '/x/a1.png', intent: '深夜缘侧自拍，抬眼看镜头', sceneTags: '1boy, night, engawa', ts: 1000 },
  { id: 'a2', file: '/x/a2.png', intent: '和主人在床上的合照', sceneTags: '1boy 1girl, bedroom, nsfw', nsfw: true, ts: 2000 },
  { id: 'a3', file: '/x/a3.png', intent: '窗外的晚霞', sceneTags: 'no humans, sunset', ts: 3000 },
]
test('album.matchAlbum: description fuzzy-matches the right entry (CJK)', () => {
  const best = album.pickBest('缘侧那张自拍', ALBUM, 4000)
  assert.ok(best && best.id === 'a1')
  const best2 = album.pickBest('和主人的合照', ALBUM, 4000)
  assert.ok(best2 && best2.id === 'a2')
})
test('album.matchAlbum: ranks candidates, filters non-matches', () => {
  const ranked = album.matchAlbum('晚霞', ALBUM, 4000)
  assert.ok(ranked.length >= 1 && ranked[0].entry.id === 'a3')
  assert.strictEqual(album.pickBest('完全无关的查询xyz不沾边', ALBUM, 4000), null)
})
test('album.matchAlbum: recency only breaks near-ties, does not override overlap', () => {
  // a1 matches "缘侧" strongly though it is the oldest → overlap wins over recency
  const best = album.pickBest('缘侧', ALBUM, 4000)
  assert.strictEqual(best.id, 'a1')
})
test('album.cosineSim / pickBestVec: semantic match over stored .vec', () => {
  assert.ok(Math.abs(album.cosineSim([1, 0], [1, 0]) - 1) < 1e-9)
  assert.ok(Math.abs(album.cosineSim([1, 0], [0, 1])) < 1e-9)
  assert.ok(album.cosineSim([2, 1], [4, 2]) > 0.99) // same direction, different magnitude
  const VEC_ALBUM = [
    { id: 'v1', vec: [1, 0, 0] },
    { id: 'v2', vec: [0, 1, 0] },
    { id: 'v3', vec: [0.9, 0.1, 0] }, // close to v1
  ]
  assert.strictEqual(album.pickBestVec([1, 0, 0], VEC_ALBUM).id, 'v1')
  assert.strictEqual(album.pickBestVec([0.95, 0.05, 0], VEC_ALBUM).id, 'v1') // nearest by cosine
  assert.strictEqual(album.pickBestVec([0, 0, 1], VEC_ALBUM, 0.45), null) // nothing similar enough
  assert.strictEqual(album.pickBestVec([1, 0, 0], [{ id: 'x' }]), null) // entries without .vec are skipped
})
test('album.eligibleByRating: nsfw entries unreachable unless recall explicitly allows nsfw (informed)', () => {
  const lib = [{ id: 's', nsfw: false }, { id: 'n', nsfw: true }, { id: 's2' }]
  assert.deepStrictEqual(album.eligibleByRating(lib, false).map((e) => e.id), ['s', 's2']) // nsfw excluded
  assert.deepStrictEqual(album.eligibleByRating(lib, true).map((e) => e.id), ['s', 'n', 's2']) // nsfw allowed
  // a non-nsfw recall can never match the nsfw entry even if it's the best textual match
  assert.strictEqual(album.pickBest('露骨的那张', album.eligibleByRating([{ id: 'n', nsfw: true, intent: '露骨的那张' }], false), 0), null)
})
test('parsePhotoTags: multiple markers → all extracted', () => {
  const { intents } = ptag.parsePhotoTags('[[photo:自拍]]中间[[photo:风景|none]]')
  assert.strictEqual(intents.length, 2)
  assert.strictEqual(intents[1].selfInFrame, 'none')
})
test('parseCameraToggle: [[camera:on/off]] (+CJK aliases), last wins, stripped from outbound', () => {
  assert.strictEqual(ptag.parseCameraToggle('喏 [[camera:on]]'), 'on')
  assert.strictEqual(ptag.parseCameraToggle('[[camera:off]]'), 'off')
  assert.strictEqual(ptag.parseCameraToggle('[[camera:开启]]'), 'on')
  assert.strictEqual(ptag.parseCameraToggle('[[camera:关]]'), 'off')
  assert.strictEqual(ptag.parseCameraToggle('[[camera:on]] 后来 [[camera:off]]'), 'off') // last wins
  assert.strictEqual(ptag.parseCameraToggle('没有开关'), null)
  const { cleanedText } = ptag.parsePhotoTags('喏 [[camera:on]] 看着我')
  assert.ok(!cleanedText.includes('[[camera'), 'camera toggle stripped from outbound text')
})
test('parsePhotoTags: no marker → text unchanged, no intents', () => {
  const { cleanedText, intents } = ptag.parsePhotoTags('就是普通的一句话')
  assert.strictEqual(cleanedText, '就是普通的一句话')
  assert.strictEqual(intents.length, 0)
})
test('parsePhotoTags: malformed/unclosed marker → not matched, left as-is, no throw', () => {
  const { cleanedText, intents } = ptag.parsePhotoTags('坏标记 [[photo:没闭合 后面')
  assert.ok(cleanedText.includes('[[photo:没闭合'))
  assert.strictEqual(intents.length, 0)
})
test('parsePhotoTags: empty-intent marker ignored (no blank photo)', () => {
  const { intents } = ptag.parsePhotoTags('[[photo:]] [[photo: ]]')
  assert.strictEqual(intents.length, 0)
})
test('parsePhotoTags: placeholder intent (copied from preset example) ignored', () => {
  const { intents } = ptag.parsePhotoTags('[[photo:意图]] 中间 [[photo:缘侧晒太阳的自拍]]')
  assert.strictEqual(intents.length, 1) // "意图" dropped, real one kept
  assert.strictEqual(intents[0].intent, '缘侧晒太阳的自拍')
})
test('parsePhotoTags: does NOT eat [laughs]/[image:hash] style single-bracket tokens', () => {
  const { cleanedText, intents } = ptag.parsePhotoTags('[laughs] 你看 [image:abc] [low voice]')
  assert.strictEqual(intents.length, 0)
  assert.ok(cleanedText.includes('[laughs]') && cleanedText.includes('[image:abc]'))
})
test('hasPhotoTag: true/false + repeatable (lastIndex reset)', () => {
  assert.strictEqual(ptag.hasPhotoTag('a [[photo:x]] b'), true)
  assert.strictEqual(ptag.hasPhotoTag('a [[photo:x]] b'), true) // repeatable
  assert.strictEqual(ptag.hasPhotoTag('no marker'), false)
})
test('hasAnyMarker: photo/camera 都命中；无标记、[[relay:]]、单括号 token 不命中；可重复调', () => {
  assert.strictEqual(ptag.hasAnyMarker('前 [[photo:x]] 后'), true)
  assert.strictEqual(ptag.hasAnyMarker('只有开关 [[camera:on]]'), true)
  assert.strictEqual(ptag.hasAnyMarker('中文开关 [[camera:关]]'), true)
  assert.strictEqual(ptag.hasAnyMarker('只有开关 [[camera:on]]'), true) // repeatable (lastIndex reset)
  assert.strictEqual(ptag.hasAnyMarker('普通句子 [laughs]'), false)
  assert.strictEqual(ptag.hasAnyMarker('[[relay:某人|嗨]]'), false) // relay 标记归 relay 插件剥
  assert.strictEqual(ptag.hasAnyMarker(''), false)
})

// ---- checkCameraShot（camera 自动拍闸门：自身节流 + 共享限流器，check-only）----
test('checkCameraShot: camera 自身节流未到 → camera_throttle', () => {
  const r = guards.checkCameraShot({ now: 10000, lastShotAt: 5000, minIntervalMs: 60000 })
  assert.deepStrictEqual(r, { ok: false, reason: 'camera_throttle' })
})
test('checkCameraShot: 节流已过 / 首拍 / 无限流器 → ok', () => {
  assert.strictEqual(guards.checkCameraShot({ now: 70000, lastShotAt: 5000, minIntervalMs: 60000 }).ok, true)
  assert.strictEqual(guards.checkCameraShot({ now: 1, lastShotAt: null, minIntervalMs: 60000 }).ok, true)
  assert.strictEqual(guards.checkCameraShot({ now: 1, lastShotAt: null, minIntervalMs: 0 }).ok, true)
})
test('checkCameraShot: 共享限流器 too_frequent / daily_limit 也拦自动拍；总开关关了不拦', () => {
  const T = Date.UTC(2026, 5, 30)
  const rate = guards.createRateLimiter({ minIntervalMs: 30000, dailyLimit: 2 })
  rate.record(T) // 刚出过一张（显式 [[photo:]] 或上一张自动拍）
  assert.deepStrictEqual(guards.checkCameraShot({ now: T + 1000, lastShotAt: null, minIntervalMs: 0, rate, rateLimitEnabled: true }), { ok: false, reason: 'too_frequent' })
  rate.record(T + 30000) // 当日额度(2)用完
  assert.deepStrictEqual(guards.checkCameraShot({ now: T + 60000, lastShotAt: null, minIntervalMs: 0, rate, rateLimitEnabled: true }), { ok: false, reason: 'daily_limit' })
  assert.strictEqual(guards.checkCameraShot({ now: T + 60000, lastShotAt: null, minIntervalMs: 0, rate, rateLimitEnabled: false }).ok, true)
})
test('checkCameraShot: 只 check 不消费（record 由调用方在真入队时做）', () => {
  const T = Date.UTC(2026, 5, 30)
  const rate = guards.createRateLimiter({ minIntervalMs: 0, dailyLimit: 1 })
  guards.checkCameraShot({ now: T, lastShotAt: null, minIntervalMs: 0, rate, rateLimitEnabled: true })
  assert.strictEqual(rate.check(T).ok, true) // 闸门本身没吃掉额度
})

// ---- context-image（成品图回流主模型上下文的纯辅助）----
const cimg = require('./context-image')
test('makeSelfPhotoImages: data URL + hash + formatted 形状（补丁v2消费的 images 条目）', () => {
  const png = Buffer.from('fakepng')
  const imgs = cimg.makeSelfPhotoImages(png, 'p123ab')
  assert.strictEqual(imgs.length, 1)
  assert.ok(imgs[0].url.startsWith('data:image/png;base64,'))
  assert.strictEqual(Buffer.from(imgs[0].url.slice('data:image/png;base64,'.length), 'base64').toString(), 'fakepng')
  assert.strictEqual(imgs[0].hash, 'p123ab')
  assert.strictEqual(imgs[0].formatted, '[image:p123ab]')
})
test('stripOldSelfPhotos: 只剥 selfPhoto 条目的 images/flag，正文和用户图不动，返回剥除数', () => {
  const arr = [
    { content: '普通', id: '1' },
    { content: '（我刚发了照片A）', selfPhoto: true, images: [{ url: 'data:A' }] },
    { content: '用户带图', images: [{ url: 'u' }] },
    { content: '（我刚发了照片B）', selfPhoto: true, images: [{ url: 'data:B' }] },
  ]
  assert.strictEqual(cimg.stripOldSelfPhotos(arr), 2)
  assert.ok(!arr[1].images && !arr[1].selfPhoto)
  assert.strictEqual(arr[1].content, '（我刚发了照片A）')
  assert.ok(arr[2].images, '用户消息的图不能动')
  assert.strictEqual(cimg.stripOldSelfPhotos(null), 0)
  assert.strictEqual(cimg.stripOldSelfPhotos([]), 0)
})

// ---- findAlbumEntry pool selection (pure part) ----
const photoMod = require('./album-pick') // 纯函数模块，直接 require
const A = (id, originKey, ts, nsfw, intent) => ({ id, file: id + '.png', originKey, ts, nsfw: !!nsfw, intent })
test('pickFromPool: origin 范围过滤 + 最近优先（desc 空）', () => {
  const pool = [A('p1','private:1',100,false,'a'), A('p2','private:1',200,false,'b'), A('p3','private:2',300,false,'c')]
  const e = photoMod.pickFromPool(pool, '', { originKey: 'private:1', scope: 'origin' })
  assert.strictEqual(e.id, 'p2') // private:1 里 ts 最大
})
test('pickFromPool: nsfw 门——没标 nsfw 够不到 nsfw 条目', () => {
  const pool = [A('p1','private:1',100,true,'裸')]
  const e = photoMod.pickFromPool(pool, '', { originKey: 'private:1', scope: 'origin', nsfw: false })
  assert.strictEqual(e, null)
})
test('pickFromPool: 候选为空 → null（不越出本会话）', () => {
  const pool = [A('p3','private:2',300,false,'c')]
  const e = photoMod.pickFromPool(pool, '哭泣', { originKey: 'private:1', scope: 'origin' })
  assert.strictEqual(e, null)
})
test('pickFromPool: desc 词法消歧（在 origin 候选内）', () => {
  const pool = [A('p1','private:1',100,false,'午后阳光'), A('p2','private:1',200,false,'哭泣特写')]
  const e = photoMod.pickFromPool(pool, '哭泣', { originKey: 'private:1', scope: 'origin' })
  assert.strictEqual(e.id, 'p2')
})

// settle all async tests, then summarize
Promise.all(pending).then(() => {
  console.log('\n' + pass + ' passed, ' + fail + ' failed')
  process.exit(fail ? 1 : 0)
})
