'use strict'

// Pure prompt assembly: fixed prefix + (optional) own-character tag + planner output
// → the single contract { scene, characterPrompts:[{prompt,uc,center}], negativePrompt }
// that buildRequestBody eats. No koishi/chatluna. Unit-tested in ./test.js.

const { joinTags, danbooruToNai } = require('./nai-client')
const D = require('./defaults')

// gateSelfInFrame ONLY decides whether THIS bot's own character tag is injected
// (for self-portrait consistency). It does NOT force "no humans" on `none` — the
// photo subject (other people / scenery) is the planner's job.
function gateSelfInFrame(selfInFrame, tags) {
  const t = tags || {}
  switch (selfInFrame) {
    case 'selfie':
      return { inject: true, extraTags: t.selfie != null ? t.selfie : D.SELFIE_TAGS }
    case 'from_behind':
      return { inject: true, extraTags: t.fromBehind != null ? t.fromBehind : D.FROM_BEHIND_TAGS }
    case 'none':
    default:
      return { inject: false, extraTags: t.none != null ? t.none : D.NONE_TAGS }
  }
}

// Contract with scene-planner (M2): when self_in_frame != 'none', the planner makes
// plannerChars[0] the SELF block (costume/action/pose ONLY, no identity/appearance);
// assemble injects the configured character tag + composition into it. Other subjects
// (plannerChars[1..]) and the `none` case pass through untouched.
//
// 🔴 invariant: characterTag goes into characterPrompts[].prompt ONLY — never scene.
function buildPhotoPrompt({ positivePrefix, characterTag, plannerScene, plannerChars, negativePrefix, selfInFrame, selfTags }) {
  const scene = joinTags(positivePrefix, plannerScene) // 画风/质量 + 场景；NO character tag
  const chars = Array.isArray(plannerChars) ? plannerChars.map(normChar) : []
  const gate = gateSelfInFrame(selfInFrame, selfTags)

  let characterPrompts
  if (gate.inject && characterTag) {
    const self = chars[0] || {}
    const ownBlock = {
      prompt: joinTags(danbooruToNai(characterTag), gate.extraTags, self.prompt),
      uc: self.uc || '',
      center: self.center || { x: 0.5, y: 0.5 },
    }
    characterPrompts = [ownBlock, ...chars.slice(1)]
  } else {
    // none, or no configured tag → planner's characters as-is (could be others / empty)
    characterPrompts = chars
  }

  return { scene, characterPrompts, negativePrompt: String(negativePrefix || '') }
}

function normChar(c) {
  c = c || {}
  return { prompt: c.prompt || '', uc: c.uc || '', center: c.center || { x: 0.5, y: 0.5 } }
}

module.exports = { gateSelfInFrame, buildPhotoPrompt }
