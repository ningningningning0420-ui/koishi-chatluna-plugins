'use strict'

// koishi/chatluna glue for invoking a (configurable) chat model as the scene-planner.
// NOT unit-tested offline (needs chatluna runtime) — verified via live acceptance.
// Keeps scene-planner.js pure: planScene receives deps.invokeModel built from here.
//
// ⚠ Live-verification points (review B2):
//  - ctx.chatluna.createChatModel(platform, name) is ASYNC → returns Promise<ComputedRef>;
//    await it, read .value, confirm it's a usable model (has .invoke). Poll if not ready.
//  - res.content may be string OR array → flatten with extractText.

const { SystemMessage, HumanMessage, AIMessage } = require('@langchain/core/messages')

function parseModelName(full) {
  const s = String(full || '')
  const i = s.indexOf('/')
  return i === -1 ? [s, ''] : [s.slice(0, i), s.slice(i + 1)]
}

function toLangchain(messages) {
  return (messages || []).map((m) => {
    if (m.role === 'system') return new SystemMessage(m.content)
    if (m.role === 'assistant') return new AIMessage(m.content)
    return new HumanMessage(m.content)
  })
}

function extractText(content) {
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content.map((c) => (typeof c === 'string' ? c : c && c.text ? c.text : '')).join('')
  }
  return String(content == null ? '' : content)
}

// Resolve a usable chat model instance by full name 'platform/model'. Async + poll.
async function getPlannerModel(ctx, full) {
  const [platform, name] = parseModelName(full)
  let lastErr
  for (let attempt = 0; attempt < 5; attempt++) {
    try {
      const ref = await ctx.chatluna.createChatModel(platform, name)
      const m = ref && typeof ref.value !== 'undefined' ? ref.value : ref
      if (m && typeof m.invoke === 'function') return m
    } catch (e) {
      lastErr = e
    }
    await new Promise((r) => setTimeout(r, 300))
  }
  throw new Error('planner model not ready: ' + full + (lastErr ? ' (' + lastErr.message + ')' : ''))
}

// Invoke an already-resolved model instance (e.g. the main model from runConfig).
async function invokeChatModel(modelInstance, messages, opts) {
  if (!modelInstance || typeof modelInstance.invoke !== 'function') throw new Error('no usable planner model')
  const res = await modelInstance.invoke(toLangchain(messages), { signal: opts && opts.signal })
  return extractText(res && res.content)
}

// Resolve by name, then invoke.
async function invokePlannerModel(ctx, full, messages, opts) {
  const m = await getPlannerModel(ctx, full)
  return invokeChatModel(m, messages, opts)
}

module.exports = { parseModelName, toLangchain, extractText, getPlannerModel, invokeChatModel, invokePlannerModel }
