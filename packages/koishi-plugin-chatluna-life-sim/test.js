'use strict'

// Offline self-test for pure logic in model.js.
// Run: node test.js
// No framework — hand-rolled, matches project convention.
// Zero external deps: only requires built-in 'assert' and './model'.
// Tests ONLY what runs without a koishi runtime or @langchain/core installed.
//
// NOT tested here (require koishi runtime or LangChain classes):
//   - toLangchain (thin LangChain glue; instanceof checks need the classes)
//   - getModel (needs ctx.chatluna)

const assert = require('assert')

let pass = 0
let fail = 0
function test(name, fn) {
  try {
    fn()
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

const { parseModelName, extractText, invoke } = require('./model')

// ---- parseModelName ----

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

// ---- invoke (offline-safe paths only) ----
// invoke() calls toLangchain() internally, which lazy-requires @langchain/core.
// Only tests that don't pass role-bearing messages (i.e. don't trigger toLangchain) are safe offline:
//   - null model → throws (guard fires before toLangchain)
//   - empty messages [] → toLangchain([]) returns [] immediately (no require needed)
//   - signal forwarding with empty messages (same: no require)
// Tests that pass {role,content} messages are omitted — they go through toLangchain
// and would need @langchain/core. This matches the relay habit (thin LangChain glue untested offline).

async function main() {
  await runAsync('invoke: passes signal to model (empty msgs, no langchain needed)', async () => {
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

  await runAsync('invoke: model not ready → throws', async () => {
    let threw = false
    try {
      await invoke(null, [], {})
    } catch (e) {
      threw = true
    }
    assert.ok(threw)
  })

  // toLangchain is not tested offline: lazy-requires @langchain/core, instanceof checks need classes.
  // getModel is not tested offline: requires ctx.chatluna runtime.
  // invoke with role-bearing messages is not tested offline: triggers toLangchain → @langchain/core.
  // All three match the relay habit of not testing thin runtime glue.
  console.log('\n[NOTE] toLangchain(), getModel(), and invoke-with-messages not tested offline (need LangChain / koishi runtime)')

  console.log('\n' + pass + ' passed, ' + fail + ' failed')
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error('test runner crashed:', e)
  process.exit(1)
})
