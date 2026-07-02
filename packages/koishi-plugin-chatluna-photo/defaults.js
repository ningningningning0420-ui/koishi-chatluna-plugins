'use strict'

// Single source of truth for koishi-plugin-photo default values.
// Pure constants, no side effects — required by both the Config Schema (index.js)
// and the pure logic (nai-client/assemble), so the three never drift apart.
//
// NAI params / 画师串 below are a user-validated Touken Ranbu preset (tested to
// stably produce the character via NovelAI, 2026-06-29). They double as the 刀男
// shared default art style; each bot instance can override in config.
// See: 自主发照片-NAI验证预设.md

// ── NAI sampling params (validated preset; NOT 小白X's DEFAULT_PARAMS_PRESET) ──
// ⚠ sampler/scale/qualityToggle/ucPreset differ from 小白X defaults — these are the
// user's tested values. ucPreset 3 = None (source-verified: 0=Heavy/1=Light/2=Human Focus/3=None).
const NAI_DEFAULT_PARAMS = {
  model: 'nai-diffusion-4-5-full',
  sampler: 'k_dpmpp_2m', // = "DPM++ 2M" (novel-draw.html:779)
  scheduler: 'karras', // → request body noise_schedule
  steps: 28,
  scale: 7.5, // CFG
  width: 1216,
  height: 832,
  seed: -1, // -1 = random
  qualityToggle: false, // quality words are hand-written in POSITIVE_PREFIX → don't auto-append
  autoSmea: false,
  ucPreset: 3, // None
  cfg_rescale: 0,
  variety_boost: false,
}

// ── Fixed prefixes (画风/质量 + 负面). 角色 tag NOT here (it's per-bot config). ──
// Verbatim from验证预设 file. Do not de-duplicate the negative (user kept the repeats).
const POSITIVE_PREFIX =
  'Deep facial shadows, realistic, extremely detailed, photorealistic, year 2025, year 2026, 1.7::artist: zero q 0q::, 0.7::artist: vlfdus__0::, 1.5::artist legacy_zechs::, 0.6::artist: yao_san_ge_ling::, 1.2::artist flamma (immortalemignis)::, 0.6::artist rei (sanbonzakura)::, 5::masterpiece, best quality::, newest, highres, proper body proportions, natural body positioning, grounded figures, cinematic lighting, movie lighting, high quality background, balanced composition, 2::pale skin::, very aesthetic, no text'

const NEGATIVE_PREFIX =
  `lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page, panel, multiple views, lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, negative space, blank page, lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page, text, signature, watermark, too many watermarks,0.4::artist:nameo (judgemasterkou), artist:matsunaga kouyou::, artist collaboration,
chibi, 1990s (style),
bad anatomy, distorted anatomy, disfigured, bad hands, missing finger, extra digits, mutation, extra arms, extra legs, long neck, bad feet, very displeasing, undetailed eyes,
multiple views, negative space, blank page,
variant set, large variant set, 4koma, 2koma, oekaki,
screentone, artistic error, film grain, scan artifacts, jpeg artifacts, chromatic aberration, dithering, disorganized colors,
lowres, worst quality, bad quality, cheesy, sloppiness, unfinished, Incomplete,-2::chibi::,large breasts, huge breasts,bad face,ugly,deformed,worst quality,oily skin,dark,high contrast,tight pants,Limbs that disappear out of nowhere,childish stature,The proportions are incorrect,limbs are fused together,The face does not match the body,black face, Eye-catching bright red,The spatial proportions are incorrect,Black legs,
misplaced limbs,intersecting body parts,Extra people,merged bodies, extra person, overlapping figures,beard,Nasolabial folds,old-age charm,wrinkles,Pubic hair`

// ── self_in_frame composition tags (per-bot configurable) ──
// Only gate whether the bot's OWN character tag is injected. `none` adds nothing —
// the photo subject (other people / scenery) is the planner's job, not forced here.
const SELFIE_TAGS = 'selfie, looking at viewer, phone camera angle, candid, amateur photo'
const FROM_BEHIND_TAGS = 'from behind'
const NONE_TAGS = ''

// ── Per-bot identity. Empty by default — each deployment fills its own. ──
// e.g. 'higekiri_(touken_ranbu)' for a 髭切 bot; each instance fills its own. Empty = no self tag.
const CHARACTER_TAG = ''

// scene-planner system prompt blueprint (placeholder;定稿 in scene-planner.js / M2)
const PLANNER_SYSTEM = '' // TODO M2: adapted-from output-format.md single-subject version

// Character library for MULTI-PERSON photos: when the photo includes other people, the planner
// uses each named person's danbooru tag (known 刀剑 — NAI recognizes them) or appearance tags
// (主人/OC — NAI does NOT know them, so identity must be described). The SELF is NOT here;
// its tag is config.characterTag, injected separately.
// EMPTY by default — this is a GENERIC plugin; each deployment fills its own library EXPLICITLY
// in koishi.yml (per the genericity principle, like characterTag). Example entry shapes:
//   { name: '主人', appearance: 'black hair, long hair, hair bun, pale skin, ...' }  // OC: appearance tags
//   { name: '膝丸',      danbooru: 'hizamaru_(touken_ranbu)' }                            // known: danbooru tag
const CHARACTER_LIBRARY = []

// Multiple savable presets (画师串 + 负面 + NAI params), like 小白X's paramsPresets. The active
// one is selected by name via config.activePreset. The default ships one preset (= validated set).
const DEFAULT_PRESETS = [
  {
    "name": "默认 (V4.5 Full)",
    "positivePrefix": "best quality, amazing quality, very aesthetic, absurdres,",
    "negativePrefix": "lowres, bad anatomy, bad hands, missing fingers, extra digits, fewer digits, cropped, worst quality, low quality, normal quality, jpeg artifacts, signature, watermark, username, blurry",
    "model": "nai-diffusion-4-5-full",
    "sampler": "k_euler_ancestral",
    "scheduler": "karras",
    "steps": 28,
    "scale": 6,
    "width": 1216,
    "height": 832,
    "seed": -1,
    "qualityToggle": true,
    "ucPreset": 0,
    "cfg_rescale": 0
  },
  {
    "name": "3D 风格 (V4.5 Full)",
    "positivePrefix": "3::3D::artist :ningen_mame,:meion, artist:nixeu, year 2025, artist:cc_lin, artist:kuroida, artist:mame_(hyeon5117), artist:nihnfinite8, artist:laevan, 4k, 10::best quality, absurdres, very aesthetic, detailed, masterpiece::,",
    "negativePrefix": "easynegative, bad, bad anatomy, bad composition, bad feet, bad hands, blurry, cropped, deformed, digit, error, extra digit, extra limb, extra missing fingers, fewer digits, imperfect eyes, inaccurate eyes, inaccurate limb, jpeg artifacts, low quality, lowres, negative_hand, missing limbs, normal quality, painting by bad-artist, signature, skewed eyes, text, ugly, ugly body, unnatural body, unnatural face, username, watermark, worst quality, missing fingers",
    "model": "nai-diffusion-4-5-full",
    "sampler": "k_euler_ancestral",
    "scheduler": "karras",
    "steps": 28,
    "scale": 6,
    "width": 1216,
    "height": 832,
    "seed": -1,
    "qualityToggle": true,
    "ucPreset": 0,
    "cfg_rescale": 0
  },
  {
    "name": "瑟光",
    "positivePrefix": "Deep facial shadows, realistic, extremely detailed, photorealistic, year 2025, year 2026, 1.7::artist: zero q 0q::, 0.7::artist: vlfdus__0::, 1.5::artist legacy_zechs::, 0.6::artist: yao_san_ge_ling::, 1.2::artist flamma (immortalemignis)::, 0.6::artist rei (sanbonzakura)::, 5::masterpiece, best quality::, newest, highres, proper body proportions, natural body positioning, grounded figures, cinematic lighting, movie lighting, high quality background, balanced composition, 2::pale skin::, very aesthetic, no text\n",
    "negativePrefix": " lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page, panel, multiple views, lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, negative space, blank page, lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page, text, signature, watermark, too many watermarks,0.4::artist:nameo (judgemasterkou), artist:matsunaga kouyou::, artist collaboration,\nchibi, 1990s (style),\nbad anatomy, distorted anatomy, disfigured, bad hands, missing finger, extra digits, mutation, extra arms, extra legs, long neck, bad feet, very displeasing, undetailed eyes,\nmultiple views, negative space, blank page,\nvariant set, large variant set, 4koma, 2koma, oekaki,\nscreentone, artistic error, film grain, scan artifacts, jpeg artifacts, chromatic aberration, dithering, disorganized colors,\nlowres, worst quality, bad quality, cheesy, sloppiness, unfinished, Incomplete,-2::chibi::,large breasts, huge breasts,bad face,ugly,deformed,worst quality,oily skin,dark,high contrast,tight pants,Limbs that disappear out of nowhere,childish stature,The proportions are incorrect,limbs are fused together,The face does not match the body,black face, Eye-catching bright red,The spatial proportions are incorrect,Black legs,\nmisplaced limbs,intersecting body parts,Extra people,merged bodies, extra person, overlapping figures,beard,Nasolabial folds,old-age charm,wrinkles,Pubic hair",
    "model": "nai-diffusion-4-5-full",
    "sampler": "k_dpmpp_2m",
    "scheduler": "karras",
    "steps": 28,
    "scale": 7.5,
    "width": 1216,
    "height": 832,
    "seed": -1,
    "qualityToggle": false,
    "ucPreset": 3,
    "cfg_rescale": 0
  },
  {
    "name": "插画常规-油性皮肤",
    "positivePrefix": "4::masterpiece, best quality::, 2::year2024, year2025::, 2::artist flamma (immortalemignis)::, 0.8::artist rei (sanbonzakura)::, 1.8::artist richu_de_xiao_taiyang::, 0.6::artist:tsubonari::, 1.6::artist gou_haihaihaihai::, 1.2::artist zengzhi zhixu::, 2.5d, cg, delicate facial features, 2::oil skin::, 2::pale skin::, very aesthetic, no text\n",
    "negativePrefix": "lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page, 3::crown, dark areola, dark pussy::, 3.8::extra fingers, multiple fingers (e.g., 6 fingers), extra digits::, logo, chibi, doll, dark penis, watermark, text-only page, reference, blush, shy, username, signature, artist:xinzoruo, artist:milkpanda, artist collaboration, variant set, large variant set, 4koma, 2koma, toon (style), oekaki, turnaround, monochrome, dated, old, 1990s (style), mutation, deformed, distorted, disfigured, distorted anatomy, anatomical structure error, asymmetrical face, unnatural hair, bad eyes, cloudy eyes, blank eyes, pointy ears, bad proportions, bad limb, bad hands, extra hands, bad hand structure, fewer digits, bad legs, extra legs, amputee, distorted composition, bad perspective, animation error, disorganized colors, vertical lines, vertical banding, blurry, upscaled, fewer details, unfinished, incomplete, amateur, cheesy, unsatisfactory, inadequate, deficient, subpar, poor, displeasing, bad illustration, bad portrait\n",
    "model": "nai-diffusion-4-5-full",
    "sampler": "k_dpmpp_2m",
    "scheduler": "karras",
    "steps": 28,
    "scale": 5.5,
    "width": 1216,
    "height": 832,
    "seed": -1,
    "qualityToggle": false,
    "ucPreset": 3,
    "cfg_rescale": 0.06
  },
  {
    "name": "干净插画-累子",
    "positivePrefix": "4::masterpiece, best quality::, 2::year2024, year2025::, 2::pale skin only::, 2::artist flamma (immortalemignis)::, 0.8::artist rei (sanbonzakura)::, 1.8::artist richu_de_xiao_taiyang::, 1.6::artist nnk_(nongnong)::, 2.5d, cg, delicate facial features, very aesthetic, no text\n",
    "negativePrefix": "lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page, 3::crown, dark areola, dark pussy::, 3.8::extra fingers, multiple fingers (e.g., 6 fingers), extra digits::, logo, chibi, doll, dark penis, watermark, text-only page, reference, blush, shy, username, signature, artist:xinzoruo, artist:milkpanda, artist collaboration, variant set, large variant set, 4koma, 2koma, toon (style), oekaki, turnaround, monochrome, dated, old, 1990s (style), mutation, deformed, distorted, disfigured, distorted anatomy, anatomical structure error, asymmetrical face, unnatural hair, bad eyes, cloudy eyes, blank eyes, pointy ears, bad proportions, bad limb, bad hands, extra hands, bad hand structure, fewer digits, bad legs, extra legs, amputee, distorted composition, bad perspective, animation error, disorganized colors, vertical lines, vertical banding, blurry, upscaled, fewer details, unfinished, incomplete, amateur, cheesy, unsatisfactory, inadequate, deficient, subpar, poor, displeasing, bad illustration, bad portrait\n",
    "model": "nai-diffusion-4-5-full",
    "sampler": "k_dpmpp_2m",
    "scheduler": "karras",
    "steps": 28,
    "scale": 5.5,
    "width": 1216,
    "height": 832,
    "seed": -1,
    "qualityToggle": false,
    "ucPreset": 3,
    "cfg_rescale": 0.06
  },
  {
    "name": "蝴蝶🦋",
    "positivePrefix": "4::masterpiece, best quality::, 2::year2024, year2025::, 2::pale skin::, 2::artist flamma (immortalemignis)::, 0.8::artist rei (sanbonzakura)::, 1.8::artist richu_de_xiao_taiyang::, 1.6::artist nnk_(nongnong)::, 2.5d, cg, delicate facial features, very aesthetic, no text, 1girl, solo, 1.3::upper body::, 1.4::one eye covered by a transparent white glass butterfly::, 1.2::one visible eye::, hair ornament, delicate hairpin, floating petals in hair, intricate details, long eyelashes, porcelain skin, ethereal atmosphere\n",
    "negativePrefix": "lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page, 3.8::extra fingers, multiple fingers (e.g., 6 fingers), extra digits::, chibi, doll, watermark, text-only page, username, signature, artist:xinzoruo, artist:milkpanda, artist collaboration, variant set, 4koma, 2koma, toon (style), oekaki, turnaround, monochrome, dated, old, 1990s (style), mutation, deformed, distorted, disfigured, distorted anatomy, asymmetrical face, bad eyes, cloudy eyes, blank eyes, bad proportions, bad hands, extra hands, bad hand structure, fewer digits, bad legs, extra legs, amputee, bad perspective, disorganized colors, blurry, upscaled, fewer details, unfinished, incomplete, amateur, bad illustration, bad portrait, two eyes covered, both eyes covered, distorted perspective, ground level view, from below\n",
    "model": "nai-diffusion-4-5-full",
    "sampler": "k_dpmpp_2m",
    "scheduler": "karras",
    "steps": 28,
    "scale": 5.5,
    "width": 832,
    "height": 1216,
    "seed": -1,
    "qualityToggle": false,
    "ucPreset": 3,
    "cfg_rescale": 0.06
  },
  {
    "name": "清透",
    "positivePrefix": "3::China realistic style, China manga CG, realistic, extremely detailed::, 2::artist flamma (immortalemignis)::, 0.8::artist: wanke::, 0.3::artist rei (sanbonzakura)::, year2024, year2025, year2026, 5::masterpiece, best quality::, newest, highres, clean arm anatomy, proportionate body shape, natural body positioning, grounded figures, logical spatial relationship between characters, high nose bridge, clear long eyelashes, exquisitely drawn face, soft gradient skin, delicate facial shading, glossy hair highlights, cinematic lighting, movie lighting, high quality background, balanced composition, proportional character sizes, perspective consistency, realistic spatial layering, supple flesh, watercolor texture, healthy skin tone, transparent light and shadow, bright colors, soft texture, {love and deepspace}, very aesthetic, no text\n\n\n",
    "negativePrefix": "lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page, text, signature, watermark, 0.4::artist:nameo (judgemasterkou), artist:matsunaga kouyou::, artist collaboration, chibi, 1990s (style), bad anatomy, distorted anatomy, disfigured, bad hands, missing finger, extra digits, mutation, extra arms, extra legs, long neck, bad feet, undetailed eyes, variant set, 4koma, 2koma, oekaki, monochrome, disorganized colors, blurry, cheesy, sloppiness, unfinished, incomplete, -2::chibi::, large breasts, huge breasts, bad face, ugly, deformed, oily skin, dark, high contrast, childish stature, proportions are incorrect, limbs are fused together, face does not match the body, misplaced limbs, intersecting body parts, extra people, merged bodies, overlapping figures, beard, nasolabial folds, wrinkles\n\n",
    "model": "nai-diffusion-4-5-full",
    "sampler": "k_euler",
    "scheduler": "karras",
    "steps": 28,
    "scale": 10,
    "width": 1024,
    "height": 896,
    "seed": -1,
    "qualityToggle": false,
    "ucPreset": 3,
    "cfg_rescale": 0.18
  },
  {
    "name": "立体清透",
    "positivePrefix": "4::masterpiece, best quality::, 2::year2024, year2025::,  2::artist flamma (immortalemignis)::, 0.8::artist rei (sanbonzakura)::, 1.8::artist richu_de_xiao_taiyang::, 1.6::artist gou_haihaihaihai::, 0.2::artist zengzhi zhixu::, 0.8::artist ibuki satsuki::, 2.5d, cg, delicate facial features, very aesthetic, no text\n",
    "negativePrefix": "lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page, low quality, normal quality, ugly man, fat, obese, old\n",
    "model": "nai-diffusion-4-5-full",
    "sampler": "k_euler",
    "scheduler": "karras",
    "steps": 28,
    "scale": 10,
    "width": 1024,
    "height": 896,
    "seed": -1,
    "qualityToggle": false,
    "ucPreset": 3,
    "cfg_rescale": 0.18
  },
  {
    "name": "二次同人-国人画师",
    "positivePrefix": "0.9::artist wanke::, 0.9::artist pigeon666::, 0.9::artist dang0_23::, 0.9::artist rei (sanbonzakura)::, artist nong_Q1, 0.81::artist mors_gn::, cinematic light and shadow, complete anatomy, cinematic lighting, sharp focus, very aesthetic, masterpiece, no text\n",
    "negativePrefix": "lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page, text, signature, watermark, 0.4::artist:nameo (judgemasterkou), artist:matsunaga kouyou::, artist collaboration, chibi, 1990s (style), bad anatomy, distorted anatomy, disfigured, bad hands, missing finger, extra digits, mutation, extra arms, extra legs, long neck, bad feet, undetailed eyes, variant set, 4koma, 2koma, oekaki, disorganized colors, cheesy, sloppiness, unfinished, incomplete, -2::chibi::, large breasts, huge breasts, bad face, ugly, deformed, oily skin, dark, high contrast, childish stature, proportions are incorrect, limbs are fused together, face does not match the body, misplaced limbs, intersecting body parts, merged bodies, overlapping figures, multiple panels, repeated panels, grid of images, collage, split screen, inconsistent anatomy, blurry, low resolution, pixelated, bad composition, messy layout, extra girl\n",
    "model": "nai-diffusion-4-5-full",
    "sampler": "k_dpmpp_2m",
    "scheduler": "karras",
    "steps": 28,
    "scale": 6,
    "width": 832,
    "height": 1216,
    "seed": -1,
    "qualityToggle": false,
    "ucPreset": 3,
    "cfg_rescale": 0
  },
  {
    "name": "水彩粉彩男向系",
    "positivePrefix": "4::masterpiece, best quality::, 1.2::year 2024::, 1.2::year 2025::, 1.1::newest::, 1.75::artist:mian_lang::, 1.75::artist:kkuekkue_(chifer1958)::, 1.5::artist:xiang_tui_tui::, 1.25::artist:yutttang::, 0.95::artist:qianben_shan::, 1.2::mature male::, 1.1::sharp jawline::, 1.3::light colored outlines::, 1.2::translucent watercolor::, 1.2::pastel color palette::, 1.3::high-key lighting::, 1.2::airy texture::, detailed background, soft shadows,  complete anatomy, very aesthetic, absurdres, no text\n",
    "negativePrefix": "lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, negative space, blank page, text, signature, watermark, 0.4::artist:nameo (judgemasterkou), artist:matsunaga kouyou::, artist collaboration, chibi, 1990s (style), bad anatomy, distorted anatomy, disfigured, bad hands, missing finger, extra digits, mutation, extra arms, extra legs, long neck, bad feet, undetailed eyes, variant set, 4koma, 2koma, oekaki, disorganized colors, cheesy, sloppiness, unfinished, incomplete, -2::chibi::, large breasts, huge breasts, bad face, ugly, deformed, oily skin, dark, high contrast\n",
    "model": "nai-diffusion-4-5-full",
    "sampler": "k_dpmpp_2m",
    "scheduler": "karras",
    "steps": 28,
    "scale": 6,
    "width": 1216,
    "height": 832,
    "seed": -1,
    "qualityToggle": false,
    "ucPreset": 3,
    "cfg_rescale": 0
  },
  {
    "name": "浮世绘",
    "positivePrefix": "2::ukiyo-e, woodblock print, year2025::, 0.75::artist:heo_sung-moo::, 1.25::artist Tsubonari::, 0.5::artist oreki_genya::, 1.75::artist zero_q_0q::, 0.5::artist kagoya1219::, traditional media, japanese art, flat color, distinct lines, retro artstyle, ink wash, abstract background, masterpiece, no text\n",
    "negativePrefix": "nsfw, lowres, artistic error, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, multiple views, logo, watermark, signature, text, blurry, pixelated, ugly, deformed, disfigured, bad anatomy, proportion error, depth of field, bokeh, cinematic lighting, soft lighting, 3d, cgi, render, photorealistic, plastic, glossy, shiny skin, excessive highlights, overexposed, gradient, thick painting\n",
    "model": "nai-diffusion-4-5-full",
    "sampler": "k_dpmpp_2m",
    "scheduler": "karras",
    "steps": 28,
    "scale": 5,
    "width": 832,
    "height": 1216,
    "seed": -1,
    "qualityToggle": false,
    "ucPreset": 3,
    "cfg_rescale": 0
  },
  {
    "name": "水彩插画柔美系",
    "positivePrefix": "4::masterpiece, best quality, very aesthetic::, 2::illustration, year2024, year2025::, 1.75::artist:nanzhizi::, 0.85::artist:ibuki_satsuki::, 0.5::artist:96yottea::, 0.6::artist:mian_lang::, 0.4::love and deepspace::, watercolor (medium), traditional media, color wash, paint bleeding, soft edges, paper texture, abstract background, watercolor background, soft lighting, luminous, detailed eyes, eyelashes, no text\n",
    "negativePrefix": "nsfw, lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, signature, text, negative space, blank page, blurry, pixelated, mosaic, noise, ugly, deformed, disfigured, extra limbs, missing limbs, extra fingers, missing fingers, wrong hands, distorted hands, facial distortion, weird eyes, lopsided face, bad anatomy, proportion error, underexposed, glowing eyes, flat color, cel shading, anime coloring, 3d, cgi, render, plastic, glossy, shiny skin, excessive highlights, overexposed\n",
    "model": "nai-diffusion-4-5-full",
    "sampler": "k_dpmpp_2m",
    "scheduler": "karras",
    "steps": 28,
    "scale": 5,
    "width": 832,
    "height": 1216,
    "seed": -1,
    "qualityToggle": false,
    "ucPreset": 3,
    "cfg_rescale": 0
  },
  {
    "name": "油画厚涂",
    "positivePrefix": "4::masterpiece, best quality, very aesthetic::, 2::illustration, year2024, year2025::, 1.75::artist:dang0_23, vyqi::, 1.5::artist:96yottea::, 1.25::artist:eriol_S2::, 0.7::artist:liduke::, 0.5::artist:au(delete)::, 0.4::love and deepspace::, 0.4::artist:wendys008::, impasto, thick painting, oil painting (medium), visible brushstrokes, expressive brushstrokes, rough painting, abstract background, blurry background, volumetric lighting, chiaroscuro, no text\n",
    "negativePrefix": "nsfw, lowres, artistic error, film grain, scan artifacts, worst quality, bad quality, jpeg artifacts, very displeasing, chromatic aberration, dithering, halftone, screentone, multiple views, logo, too many watermarks, signature, text, negative space, blank page, blurry, pixelated, mosaic, noise, ugly, deformed, disfigured, extra limbs, missing limbs, extra fingers, missing fingers, wrong hands, distorted hands, facial distortion, weird eyes, lopsided face, bad anatomy, proportion error, underexposed, yellow skin, dark skin, orange skin, tan skin, sallow skin, glowing eyes, flat color, cel shading, anime coloring, 3d, cgi, render, plastic, glossy, shiny skin, excessive highlights, overexposed\n",
    "model": "nai-diffusion-4-5-full",
    "sampler": "k_dpmpp_2m",
    "scheduler": "karras",
    "steps": 28,
    "scale": 5,
    "width": 832,
    "height": 1216,
    "seed": -1,
    "qualityToggle": false,
    "ucPreset": 3,
    "cfg_rescale": 0
  }
]

module.exports = {
  NAI_DEFAULT_PARAMS,
  POSITIVE_PREFIX,
  NEGATIVE_PREFIX,
  SELFIE_TAGS,
  FROM_BEHIND_TAGS,
  NONE_TAGS,
  CHARACTER_TAG,
  PLANNER_SYSTEM,
  CHARACTER_LIBRARY,
  DEFAULT_PRESETS,
}
