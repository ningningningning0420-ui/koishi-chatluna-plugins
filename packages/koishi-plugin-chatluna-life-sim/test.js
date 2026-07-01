'use strict'

// Offline self-test for pure logic in model.js.
// Run: node test.js
// No framework — hand-rolled, matches project convention.
// Tests ONLY what runs without a koishi runtime.

const assert = require('assert')

let pass = 0
let fail = 0
function test(name, fn) {
  try {
    const r = fn()
    if (r && typeof r.then === 'function') {
      // async test: caller must await and call test() synchronously — we keep it sync-only.
      // If fn returns a promise, treat as sync pass (async tests use runAsync below).
    }
    pass++
    console.log('PASS  ' + name)
  } catch (e) {
    fail++
    console.log('FAIL  ' + name + '  ::  ' + e.message)
  }
}

async function runAsync(name, fn) {
  try {
    await fn()
    pass++
    console.log('PASS  ' + name)
  } catch (e) {
    fail++
    console.log('FAIL  ' + name + '  ::  ' + e.message)
  }
}

// ---- parseModelName ----
const { parseModelName, toLangchain, extractText, getModel, invoke } = require('./model')
const { SystemMessage, HumanMessage, AIMessage } = require('@langchain/core/messages')

test('parseModelName: platform/name → [platform, name]', () => {
  const [p, n] = parseModelName('ollama/qwen2.5:7b')
  assert.strictEqual(p, 'ollama')
  assert.strictEqual(n, 'qwen2.5:7b')
})

test('parseModelName: no slash → [full, ""]', () => {
  const [p, n] = parseModelName('ollama')
  assert.strictEqual(p, 'ollama')
  assert.strictEqual(n, '')
})

test('parseModelName: only first slash splits', () => {
  const [p, n] = parseModelName('openai-like/gemini-2.5-flash/v1')
  assert.strictEqual(p, 'openai-like')
  assert.strictEqual(n, 'gemini-2.5-flash/v1')
})

test('parseModelName: empty string → ["", ""]', () => {
  const [p, n] = parseModelName('')
  assert.strictEqual(p, '')
  assert.strictEqual(n, '')
})

test('parseModelName: null → ["", ""]', () => {
  const [p, n] = parseModelName(null)
  assert.strictEqual(p, '')
  assert.strictEqual(n, '')
})

// ---- toLangchain ----
test('toLangchain: system role → SystemMessage', () => {
  const msgs = toLangchain([{ role: 'system', content: 'You are a bot.' }])
  assert.strictEqual(msgs.length, 1)
  assert.ok(msgs[0] instanceof SystemMessage)
  assert.strictEqual(msgs[0].content, 'You are a bot.')
})

test('toLangchain: user role → HumanMessage', () => {
  const msgs = toLangchain([{ role: 'user', content: 'hello' }])
  assert.ok(msgs[0] instanceof HumanMessage)
  assert.strictEqual(msgs[0].content, 'hello')
})

test('toLangchain: assistant role → AIMessage', () => {
  const msgs = toLangchain([{ role: 'assistant', content: 'hi there' }])
  assert.ok(msgs[0] instanceof AIMessage)
  assert.strictEqual(msgs[0].content, 'hi there')
})

test('toLangchain: unknown role → HumanMessage fallback', () => {
  const msgs = toLangchain([{ role: 'unknown', content: 'x' }])
  assert.ok(msgs[0] instanceof HumanMessage)
})

test('toLangchain: mixed messages → correct order and types', () => {
  const msgs = toLangchain([
    { role: 'system', content: 'sys' },
    { role: 'user', content: 'q' },
    { role: 'assistant', content: 'a' },
  ])
  assert.strictEqual(msgs.length, 3)
  assert.ok(msgs[0] instanceof SystemMessage)
  assert.ok(msgs[1] instanceof HumanMessage)
  assert.ok(msgs[2] instanceof AIMessage)
})

test('toLangchain: null/undefined → empty array', () => {
  assert.deepStrictEqual(toLangchain(null), [])
  assert.deepStrictEqual(toLangchain(undefined), [])
  assert.deepStrictEqual(toLangchain([]), [])
})

// ---- extractText ----
test('extractText: string content → itself', () => {
  assert.strictEqual(extractText('hello'), 'hello')
})

test('extractText: array of strings → joined', () => {
  assert.strictEqual(extractText(['hello', ' ', 'world']), 'hello world')
})

test('extractText: array with objects having .text → joined text fields', () => {
  assert.strictEqual(extractText([{ text: 'foo' }, { text: 'bar' }]), 'foobar')
})

test('extractText: array mixed string and object', () => {
  assert.strictEqual(extractText(['a', { text: 'b' }]), 'ab')
})

test('extractText: null → empty string', () => {
  assert.strictEqual(extractText(null), '')
})

test('extractText: undefined → empty string', () => {
  assert.strictEqual(extractText(undefined), '')
})

// ---- invoke (with fake model) ----
async function main() {
  await runAsync('invoke: fake model returning string content → string', async () => {
    const fakeModel = {
      invoke: async (_msgs, _opts) => ({ content: 'これは本丸だ' }),
    }
    const result = await invoke(fakeModel, [{ role: 'user', content: 'test' }], {})
    assert.strictEqual(result, 'これは本丸だ')
  })

  await runAsync('invoke: fake model returning array content → joined string', async () => {
    const fakeModel = {
      invoke: async (_msgs, _opts) => ({ content: [{ text: 'part1' }, { text: 'part2' }] }),
    }
    const result = await invoke(fakeModel, [{ role: 'system', content: 'sys' }], {})
    assert.strictEqual(result, 'part1part2')
  })

  await runAsync('invoke: passes signal to model', async () => {
    let receivedOpts
    const fakeModel = {
      invoke: async (_msgs, opts) => {
        receivedOpts = opts
        return { content: 'ok' }
      },
    }
    const ctrl = new AbortController()
    await invoke(fakeModel, [], { signal: ctrl.signal })
    assert.ok(receivedOpts && receivedOpts.signal === ctrl.signal)
  })

  await runAsync('invoke: passes LangChain messages to model', async () => {
    let receivedMsgs
    const fakeModel = {
      invoke: async (msgs, _opts) => {
        receivedMsgs = msgs
        return { content: 'ok' }
      },
    }
    await invoke(fakeModel, [{ role: 'system', content: 'sys' }, { role: 'user', content: 'hi' }], {})
    assert.ok(Array.isArray(receivedMsgs))
    assert.ok(receivedMsgs[0] instanceof SystemMessage)
    assert.ok(receivedMsgs[1] instanceof HumanMessage)
  })

  await runAsync('invoke: model not ready → throws', async () => {
    let threw = false
    try {
      await invoke(null, [], {})
    } catch (e) {
      threw = true
    }
    assert.ok(threw)
  })

  // getModel is runtime-only (needs ctx.chatluna), cannot test offline.
  // Documented here as reminder.
  console.log('\n[NOTE] getModel() requires koishi runtime — not tested offline (same as photo model.js)')

  console.log('\n' + pass + ' passed, ' + fail + ' failed')
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error('test runner crashed:', e)
  process.exit(1)
})
