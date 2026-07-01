'use strict'

// Model call helper for chatluna-life-sim.
// Mirrors the pattern in koishi-plugin-photo/model.js.
//
// NOT unit-tested offline (getModel needs chatluna runtime).
// invoke() IS tested offline via a fake model object in test.js.
//
// Live call flow:
//   const m = await getModel(ctx, 'ollama/qwen2.5:7b')
//   const text = await invoke(m, [{role:'system',content:'...'},{role:'user',content:'...'}])

const { SystemMessage, HumanMessage, AIMessage } = require('@langchain/core/messages')

// Split 'platform/model-name' → ['platform', 'model-name'].
// If no slash, returns [full, ''].
// Only the first slash is used as delimiter (model names may contain slashes).
function parseModelName(full) {
  const s = String(full == null ? '' : full)
  const i = s.indexOf('/')
  return i === -1 ? [s, ''] : [s.slice(0, i), s.slice(i + 1)]
}

// Convert {role, content}[] to LangChain message objects.
// system → SystemMessage, assistant → AIMessage, everything else → HumanMessage.
function toLangchain(messages) {
  if (!messages || !messages.length) return []
  return messages.map((m) => {
    if (m.role === 'system') return new SystemMessage(m.content)
    if (m.role === 'assistant') return new AIMessage(m.content)
    return new HumanMessage(m.content)
  })
}

// Flatten response content: string | array-of-strings/objects → string.
function extractText(content) {
  if (content == null) return ''
  if (typeof content === 'string') return content
  if (Array.isArray(content)) {
    return content
      .map((c) => (typeof c === 'string' ? c : c && c.text ? c.text : ''))
      .join('')
  }
  return String(content)
}

// Resolve a usable chat model by full name 'platform/model'. Retries up to 5x.
// Returns the model instance (has .invoke).
// Requires koishi ctx with chatluna service loaded.
async function getModel(ctx, full) {
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
  throw new Error(
    'life-sim: model not ready: ' + full + (lastErr ? ' (' + lastErr.message + ')' : '')
  )
}

// Invoke an already-resolved model instance with {role,content}[] messages.
// opts.signal → AbortSignal for cancellation.
// Returns extracted text string.
async function invoke(model, messages, opts) {
  if (!model || typeof model.invoke !== 'function') {
    throw new Error('life-sim: no usable model instance')
  }
  const lcMessages = toLangchain(messages)
  const res = await model.invoke(lcMessages, { signal: opts && opts.signal })
  return extractText(res && res.content)
}

module.exports = { parseModelName, toLangchain, extractText, getModel, invoke }
