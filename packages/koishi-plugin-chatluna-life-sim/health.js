'use strict'

// health.js — §6.3 健康自检（针对静默失败面）
//
// 针对的是"系统在跑但白跑"的静默失败：inject.js 在 promptRenderer 缺失时只
// warn 一条就跳过、gatherPersona 三级降级全程无感知——最坏情形是事件在长、
// 人设却是通用模板、聊天里啥也没注入。
//
// Pure function (offline-testable, no runtime deps, no new Date()):
//   scanPresetTextForVars(text, varNames) → { name: bool }
//
// Glue factory (deps 注入，fake deps 可离线测):
//   createHealth(deps) → { getHealth(presetId) }
//     getHealth(presetId) → Promise<{ personaSource, injectRegistered, presetVars }>
//       personaSource     'service' | 'file' | 'default'（§5.5e 三级降级实际用到哪级）
//       injectRegistered  boolean（inject.register() 是否注册成功）
//       presetVars        { varName: true|false|null }
//                         true=预设文本引用了该变量 false=没引用
//                         null=读不到预设文本（best-effort，报 unknown）
//
// Design refs: §6.3 (健康自检) / §5.5e (persona 同源硬要求)

// ---------------------------------------------------------------------------
// scanPresetTextForVars — pure, offline-testable
// ---------------------------------------------------------------------------

/**
 * Best-effort scan of a preset's raw text for template-variable references.
 *
 * Matches both bare references `{recent_life}`（含空白 `{ recent_life }`）and
 * function-call form `{recent_life(10)}`（chatluna 模板引擎支持函数调用）。
 * `{recent_life_extended}` 这类相似前缀名不误命中。
 *
 * Non-string text is treated as '' (all false). Never throws. Pure function.
 *
 * @param {string} text       Preset raw text (PresetTemplate.rawText)
 * @param {string[]} varNames Variable names to look for
 * @returns {Object<string, boolean>}  { varName: hit }
 */
function scanPresetTextForVars(text, varNames) {
  const t = (typeof text === 'string') ? text : ''
  const names = Array.isArray(varNames) ? varNames : []
  const out = {}
  for (const name of names) {
    if (!name) continue
    const esc = String(name).replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
    // `{` + optional whitespace + name + optional whitespace + (`}` or `(`)
    const re = new RegExp('\\{\\s*' + esc + '\\s*[}(]')
    out[String(name)] = re.test(t)
  }
  return out
}

// ---------------------------------------------------------------------------
// createHealth — glue factory (deps injected; offline-testable with fakes)
// ---------------------------------------------------------------------------

/**
 * Create the health-report assembler.
 *
 * @param {object} deps  Injected dependencies:
 *   {
 *     gatherPersonaWithSource(presetId) → Promise<{text, source}>
 *                            // roll-roller.js gatherPersonaWithSource, ctx/config 已闭包
 *     injectRegistered       // boolean 或 () => boolean（index 存住 inject.register() 结果）
 *     getPresetText(presetId) → Promise<string|null>
 *                            // best-effort 读 chatluna 预设原文；读不到返回 null/抛错
 *     varNames               // string[] 四变量名（resolveVarNames(config) 展开后的列表）
 *   }
 * @returns {{ getHealth(presetId): Promise<object> }}
 */
function createHealth(deps) {
  const d = deps || {}
  const varNames = Array.isArray(d.varNames) ? d.varNames : []

  /**
   * Assemble the health report for one preset.
   * Never throws — every probe degrades to its "worst" value on error.
   *
   * @param {string} presetId
   * @returns {Promise<{personaSource: string, injectRegistered: boolean, presetVars: object}>}
   */
  async function getHealth(presetId) {
    // ── personaSource ──────────────────────────────────────────────────────
    let personaSource = 'default'
    try {
      if (typeof d.gatherPersonaWithSource === 'function') {
        const r = await d.gatherPersonaWithSource(presetId)
        if (r && typeof r.source === 'string') personaSource = r.source
      }
    } catch (_) {
      personaSource = 'default'
    }

    // ── injectRegistered ───────────────────────────────────────────────────
    let injectRegistered = false
    try {
      injectRegistered = (typeof d.injectRegistered === 'function')
        ? !!d.injectRegistered()
        : !!d.injectRegistered
    } catch (_) {
      injectRegistered = false
    }

    // ── presetVars — best-effort（读不到预设 → 全 null = unknown）──────────
    let text = null
    try {
      if (typeof d.getPresetText === 'function') {
        text = await d.getPresetText(presetId)
      }
    } catch (_) {
      text = null
    }

    let presetVars
    if (typeof text === 'string') {
      presetVars = scanPresetTextForVars(text, varNames)
    } else {
      presetVars = {}
      for (const name of varNames) {
        if (name) presetVars[String(name)] = null
      }
    }

    return { personaSource, injectRegistered, presetVars }
  }

  return { getHealth }
}

// ---------------------------------------------------------------------------
// Exports
// ---------------------------------------------------------------------------

module.exports = {
  // Pure (offline-testable)
  scanPresetTextForVars,
  // Glue factory
  createHealth,
}
