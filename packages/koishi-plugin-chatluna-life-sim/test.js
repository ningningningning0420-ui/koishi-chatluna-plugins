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

// ---- scheduler: ConcurrencyGuard + partitionPending (pure logic) ----

const { createConcurrencyGuard, partitionPending } = require('./scheduler')

// ConcurrencyGuard

test('ConcurrencyGuard: acquire free preset → true', () => {
  const guard = createConcurrencyGuard()
  assert.strictEqual(guard.acquire('p1', 'roll'), true)
})

test('ConcurrencyGuard: acquire busy preset (same kind) → false', () => {
  const guard = createConcurrencyGuard()
  guard.acquire('p1', 'roll')
  assert.strictEqual(guard.acquire('p1', 'roll'), false)
})

test('ConcurrencyGuard: acquire busy preset (different kind) → false', () => {
  const guard = createConcurrencyGuard()
  guard.acquire('p1', 'roll')
  assert.strictEqual(guard.acquire('p1', 'withuser'), false)
})

test('ConcurrencyGuard: isBusy reflects state', () => {
  const guard = createConcurrencyGuard()
  assert.strictEqual(guard.isBusy('p1'), false)
  guard.acquire('p1', 'roll')
  assert.strictEqual(guard.isBusy('p1'), true)
})

test('ConcurrencyGuard: current returns the active kind', () => {
  const guard = createConcurrencyGuard()
  assert.strictEqual(guard.current('p1'), null)
  guard.acquire('p1', 'peerchat')
  assert.strictEqual(guard.current('p1'), 'peerchat')
})

test('ConcurrencyGuard: release → acquire succeeds again', () => {
  const guard = createConcurrencyGuard()
  guard.acquire('p1', 'roll')
  guard.release('p1')
  assert.strictEqual(guard.acquire('p1', 'withuser'), true)
  assert.strictEqual(guard.current('p1'), 'withuser')
})

test('ConcurrencyGuard: distinct presets are independent', () => {
  const guard = createConcurrencyGuard()
  guard.acquire('p1', 'roll')
  // p2 should be unaffected
  assert.strictEqual(guard.isBusy('p2'), false)
  assert.strictEqual(guard.acquire('p2', 'roll'), true)
  // p1 still busy
  assert.strictEqual(guard.acquire('p1', 'withuser'), false)
})

test('ConcurrencyGuard: release noop on free preset (no throw)', () => {
  const guard = createConcurrencyGuard()
  // should not throw
  guard.release('unknown')
  assert.strictEqual(guard.isBusy('unknown'), false)
})

// partitionPending

test('partitionPending: old task (beyond grace) → dropIds', () => {
  const now = 1000000
  const graceMs = 60000
  const tasks = [
    { id: 1, presetId: 'p1', fireAt: new Date(now - graceMs - 1), type: 'roll' }
  ]
  const result = partitionPending(tasks, now, graceMs)
  assert.deepStrictEqual(result.dropIds, [1])
  assert.deepStrictEqual(result.runIds, [])
  assert.strictEqual(result.futureTasks.length, 0)
})

test('partitionPending: slightly overdue (within grace) → runIds', () => {
  const now = 1000000
  const graceMs = 60000
  const tasks = [
    { id: 2, presetId: 'p1', fireAt: new Date(now - 1000), type: 'roll' }
  ]
  const result = partitionPending(tasks, now, graceMs)
  assert.deepStrictEqual(result.runIds, [2])
  assert.deepStrictEqual(result.dropIds, [])
  assert.strictEqual(result.futureTasks.length, 0)
})

test('partitionPending: exactly at now (within grace) → runIds', () => {
  const now = 1000000
  const graceMs = 60000
  const tasks = [
    { id: 3, presetId: 'p1', fireAt: new Date(now), type: 'roll' }
  ]
  const result = partitionPending(tasks, now, graceMs)
  assert.deepStrictEqual(result.runIds, [3])
  assert.deepStrictEqual(result.dropIds, [])
  assert.strictEqual(result.futureTasks.length, 0)
})

test('partitionPending: future task → futureTasks', () => {
  const now = 1000000
  const graceMs = 60000
  const task = { id: 4, presetId: 'p1', fireAt: new Date(now + 5000), type: 'roll' }
  const result = partitionPending([task], now, graceMs)
  assert.strictEqual(result.futureTasks.length, 1)
  assert.strictEqual(result.futureTasks[0], task)
  assert.deepStrictEqual(result.runIds, [])
  assert.deepStrictEqual(result.dropIds, [])
})

test('partitionPending: boundary exactly at grace edge → dropIds', () => {
  const now = 1000000
  const graceMs = 60000
  // fireAt = now - graceMs exactly: condition is fireAt <= now - graceMs → drop
  const tasks = [
    { id: 5, presetId: 'p1', fireAt: new Date(now - graceMs), type: 'roll' }
  ]
  const result = partitionPending(tasks, now, graceMs)
  assert.deepStrictEqual(result.dropIds, [5])
})

test('partitionPending: mixed batch partitions correctly', () => {
  const now = 1000000
  const graceMs = 60000
  const tasks = [
    { id: 10, presetId: 'p1', fireAt: new Date(now - graceMs - 1), type: 'roll' },   // drop
    { id: 11, presetId: 'p1', fireAt: new Date(now - 1000), type: 'block' },          // run
    { id: 12, presetId: 'p2', fireAt: new Date(now + 10000), type: 'consolidate' },   // future
  ]
  const result = partitionPending(tasks, now, graceMs)
  assert.deepStrictEqual(result.dropIds, [10])
  assert.deepStrictEqual(result.runIds, [11])
  assert.strictEqual(result.futureTasks.length, 1)
  assert.strictEqual(result.futureTasks[0].id, 12)
})

test('partitionPending: empty input → all empty', () => {
  const result = partitionPending([], Date.now(), 60000)
  assert.deepStrictEqual(result.dropIds, [])
  assert.deepStrictEqual(result.runIds, [])
  assert.strictEqual(result.futureTasks.length, 0)
})

// ---- presence.js: nextPresenceState + derivePresetKey (pure logic) ----

const { nextPresenceState, derivePresenceKey } = require('./presence')

// nextPresenceState: full (state, event) transition table
// States: 'WITH_USER' | 'LINGERING' | 'LIVING'
// Events: 'userMessage' | 'lingerTimeout' | 'goLive'

test('presence: LIVING + userMessage → WITH_USER', () => {
  assert.strictEqual(nextPresenceState('LIVING', 'userMessage'), 'WITH_USER')
})

test('presence: WITH_USER + userMessage → WITH_USER (stay)', () => {
  assert.strictEqual(nextPresenceState('WITH_USER', 'userMessage'), 'WITH_USER')
})

test('presence: LINGERING + userMessage → WITH_USER (re-capture)', () => {
  assert.strictEqual(nextPresenceState('LINGERING', 'userMessage'), 'WITH_USER')
})

test('presence: WITH_USER + lingerTimeout → LINGERING', () => {
  assert.strictEqual(nextPresenceState('WITH_USER', 'lingerTimeout'), 'LINGERING')
})

test('presence: LINGERING + lingerTimeout → LINGERING (noop / already lingering)', () => {
  assert.strictEqual(nextPresenceState('LINGERING', 'lingerTimeout'), 'LINGERING')
})

test('presence: LIVING + lingerTimeout → LIVING (noop)', () => {
  assert.strictEqual(nextPresenceState('LIVING', 'lingerTimeout'), 'LIVING')
})

test('presence: LINGERING + goLive → LIVING', () => {
  assert.strictEqual(nextPresenceState('LINGERING', 'goLive'), 'LIVING')
})

test('presence: WITH_USER + goLive → LIVING (force-go)', () => {
  assert.strictEqual(nextPresenceState('WITH_USER', 'goLive'), 'LIVING')
})

test('presence: LIVING + goLive → LIVING (noop)', () => {
  assert.strictEqual(nextPresenceState('LIVING', 'goLive'), 'LIVING')
})

test('presence: unknown state + userMessage → WITH_USER (fallback to default)', () => {
  assert.strictEqual(nextPresenceState(undefined, 'userMessage'), 'WITH_USER')
})

test('presence: unknown event → state unchanged (defensive)', () => {
  assert.strictEqual(nextPresenceState('LIVING', 'bogusEvent'), 'LIVING')
  assert.strictEqual(nextPresenceState('WITH_USER', 'bogusEvent'), 'WITH_USER')
  assert.strictEqual(nextPresenceState('LINGERING', 'bogusEvent'), 'LINGERING')
})

// derivePresenceKey: pure session → key helper
test('derivePresenceKey: direct session → private:userId', () => {
  const session = { isDirect: true, userId: 'u123', guildId: null }
  assert.strictEqual(derivePresenceKey(session), 'private:u123')
})

test('derivePresenceKey: group session with guildId → group:guildId', () => {
  const session = { isDirect: false, userId: 'u123', guildId: 'g456', channelId: 'c789' }
  assert.strictEqual(derivePresenceKey(session), 'group:g456')
})

test('derivePresenceKey: group session no guildId falls back to channelId', () => {
  const session = { isDirect: false, userId: 'u123', guildId: null, channelId: 'c789' }
  assert.strictEqual(derivePresenceKey(session), 'group:c789')
})

test('derivePresenceKey: isDirect falsy (0/empty/undefined) → group path', () => {
  const session = { isDirect: 0, userId: 'u1', guildId: 'g1', channelId: 'c1' }
  assert.strictEqual(derivePresenceKey(session), 'group:g1')
})

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
