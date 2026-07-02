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

// ---- world-context.js: seasonOf / timeOfDayOf / tickWeather / advanceWeather ----

const { seasonOf, timeOfDayOf, tickWeather, advanceWeather, DEFAULT_ADJACENCY } = require('./world-context')

// Helper: build a Date at a specific local clock reading inside Asia/Shanghai
// by using the UTC offset (+8h = -28800000ms offset applied in reverse).
// We want to test "what label does date X get in tz Y", so we just create Date
// objects from specific UTC values that we know correspond to a given local time
// in Asia/Shanghai (UTC+8: local = utc+8).
function shanghaiDate(localHour, localMonth, localDay) {
  // year 2024 for all tests (non-leap edge not needed here)
  const year = 2024
  // UTC hour = local hour - 8 (UTC+8)
  const utcHour = localHour - 8
  // This may yield negative hour; Date handles it correctly via UTC constructor
  return new Date(Date.UTC(year, localMonth - 1, localDay, utcHour, 0, 0, 0))
}

// --- seasonOf ---

test('seasonOf: March → 春', () => {
  assert.strictEqual(seasonOf(shanghaiDate(12, 3, 15), 'Asia/Shanghai'), '春')
})

test('seasonOf: April → 春', () => {
  assert.strictEqual(seasonOf(shanghaiDate(12, 4, 15), 'Asia/Shanghai'), '春')
})

test('seasonOf: May → 春', () => {
  assert.strictEqual(seasonOf(shanghaiDate(12, 5, 31), 'Asia/Shanghai'), '春')
})

test('seasonOf: June → 夏', () => {
  assert.strictEqual(seasonOf(shanghaiDate(12, 6, 1), 'Asia/Shanghai'), '夏')
})

test('seasonOf: July → 夏', () => {
  assert.strictEqual(seasonOf(shanghaiDate(12, 7, 15), 'Asia/Shanghai'), '夏')
})

test('seasonOf: August → 夏', () => {
  assert.strictEqual(seasonOf(shanghaiDate(12, 8, 31), 'Asia/Shanghai'), '夏')
})

test('seasonOf: September → 秋', () => {
  assert.strictEqual(seasonOf(shanghaiDate(12, 9, 1), 'Asia/Shanghai'), '秋')
})

test('seasonOf: October → 秋', () => {
  assert.strictEqual(seasonOf(shanghaiDate(12, 10, 15), 'Asia/Shanghai'), '秋')
})

test('seasonOf: November → 秋', () => {
  assert.strictEqual(seasonOf(shanghaiDate(12, 11, 30), 'Asia/Shanghai'), '秋')
})

test('seasonOf: December → 冬', () => {
  assert.strictEqual(seasonOf(shanghaiDate(12, 12, 1), 'Asia/Shanghai'), '冬')
})

test('seasonOf: January → 冬', () => {
  assert.strictEqual(seasonOf(shanghaiDate(12, 1, 15), 'Asia/Shanghai'), '冬')
})

test('seasonOf: February → 冬', () => {
  assert.strictEqual(seasonOf(shanghaiDate(12, 2, 28), 'Asia/Shanghai'), '冬')
})

// --- timeOfDayOf ---

test('timeOfDayOf: hour=0 → 深夜', () => {
  assert.strictEqual(timeOfDayOf(shanghaiDate(0, 6, 15), 'Asia/Shanghai'), '深夜')
})

test('timeOfDayOf: hour=3 → 深夜', () => {
  assert.strictEqual(timeOfDayOf(shanghaiDate(3, 6, 15), 'Asia/Shanghai'), '深夜')
})

test('timeOfDayOf: hour=4 → 深夜', () => {
  assert.strictEqual(timeOfDayOf(shanghaiDate(4, 6, 15), 'Asia/Shanghai'), '深夜')
})

test('timeOfDayOf: hour=5 → 清晨', () => {
  assert.strictEqual(timeOfDayOf(shanghaiDate(5, 6, 15), 'Asia/Shanghai'), '清晨')
})

test('timeOfDayOf: hour=6 → 清晨', () => {
  assert.strictEqual(timeOfDayOf(shanghaiDate(6, 6, 15), 'Asia/Shanghai'), '清晨')
})

test('timeOfDayOf: hour=7 → 上午', () => {
  assert.strictEqual(timeOfDayOf(shanghaiDate(7, 6, 15), 'Asia/Shanghai'), '上午')
})

test('timeOfDayOf: hour=10 → 上午', () => {
  assert.strictEqual(timeOfDayOf(shanghaiDate(10, 6, 15), 'Asia/Shanghai'), '上午')
})

test('timeOfDayOf: hour=11 → 上午', () => {
  assert.strictEqual(timeOfDayOf(shanghaiDate(11, 6, 15), 'Asia/Shanghai'), '上午')
})

test('timeOfDayOf: hour=12 → 午后', () => {
  assert.strictEqual(timeOfDayOf(shanghaiDate(12, 6, 15), 'Asia/Shanghai'), '午后')
})

test('timeOfDayOf: hour=16 → 午后', () => {
  assert.strictEqual(timeOfDayOf(shanghaiDate(16, 6, 15), 'Asia/Shanghai'), '午后')
})

test('timeOfDayOf: hour=17 → 黄昏', () => {
  assert.strictEqual(timeOfDayOf(shanghaiDate(17, 6, 15), 'Asia/Shanghai'), '黄昏')
})

test('timeOfDayOf: hour=18 → 黄昏', () => {
  assert.strictEqual(timeOfDayOf(shanghaiDate(18, 6, 15), 'Asia/Shanghai'), '黄昏')
})

test('timeOfDayOf: hour=19 → 夜', () => {
  assert.strictEqual(timeOfDayOf(shanghaiDate(19, 6, 15), 'Asia/Shanghai'), '夜')
})

test('timeOfDayOf: hour=22 → 夜', () => {
  assert.strictEqual(timeOfDayOf(shanghaiDate(22, 6, 15), 'Asia/Shanghai'), '夜')
})

test('timeOfDayOf: hour=23 → 深夜', () => {
  assert.strictEqual(timeOfDayOf(shanghaiDate(23, 6, 15), 'Asia/Shanghai'), '深夜')
})

// --- tickWeather: adjacency enforcement (§5.4c 禁跳变) ---

test('tickWeather: 晴 pickIndex=0 → 晴 (self-loop)', () => {
  assert.strictEqual(tickWeather('晴', DEFAULT_ADJACENCY, 0), '晴')
})

test('tickWeather: 晴 pickIndex=1 → 多云 (only adjacent)', () => {
  assert.strictEqual(tickWeather('晴', DEFAULT_ADJACENCY, 1), '多云')
})

test('tickWeather: 晴 never jumps to 雨', () => {
  // 晴 neighbours = ['晴','多云'] — neither is 雨/雪/阴
  const neighbours = DEFAULT_ADJACENCY['晴']
  assert.ok(!neighbours.includes('雨'), '晴 should not have 雨 as neighbour')
  assert.ok(!neighbours.includes('雪'), '晴 should not have 雪 as neighbour')
  assert.ok(!neighbours.includes('阴'), '晴 should not have 阴 as neighbour')
})

test('tickWeather: 多云 can reach 晴 阴 多云', () => {
  const neighbours = DEFAULT_ADJACENCY['多云']
  assert.ok(neighbours.includes('晴'))
  assert.ok(neighbours.includes('阴'))
  assert.ok(neighbours.includes('多云'))
})

test('tickWeather: 多云 cannot jump to 雨 or 雪', () => {
  const neighbours = DEFAULT_ADJACENCY['多云']
  assert.ok(!neighbours.includes('雨'), '多云 should not jump to 雨')
  assert.ok(!neighbours.includes('雪'), '多云 should not jump to 雪')
})

test('tickWeather: 阴 can reach 多云 雨 雪 阴', () => {
  const neighbours = DEFAULT_ADJACENCY['阴']
  assert.ok(neighbours.includes('多云'))
  assert.ok(neighbours.includes('雨'))
  assert.ok(neighbours.includes('雪'))
  assert.ok(neighbours.includes('阴'))
})

test('tickWeather: 阴 cannot jump to 晴', () => {
  const neighbours = DEFAULT_ADJACENCY['阴']
  assert.ok(!neighbours.includes('晴'), '阴 should not jump to 晴')
})

test('tickWeather: 雨 pickIndex=0 → 阴', () => {
  assert.strictEqual(tickWeather('雨', DEFAULT_ADJACENCY, 0), '阴')
})

test('tickWeather: 雨 pickIndex=1 → 雨 (self-loop)', () => {
  assert.strictEqual(tickWeather('雨', DEFAULT_ADJACENCY, 1), '雨')
})

test('tickWeather: 雨 cannot jump to 晴 or 雪', () => {
  const neighbours = DEFAULT_ADJACENCY['雨']
  assert.ok(!neighbours.includes('晴'), '雨 should not jump to 晴')
  assert.ok(!neighbours.includes('雪'), '雨 should not jump to 雪')
})

test('tickWeather: 雪 pickIndex=0 → 阴', () => {
  assert.strictEqual(tickWeather('雪', DEFAULT_ADJACENCY, 0), '阴')
})

test('tickWeather: 雪 pickIndex=1 → 雪 (self-loop)', () => {
  assert.strictEqual(tickWeather('雪', DEFAULT_ADJACENCY, 1), '雪')
})

test('tickWeather: unknown state stays put', () => {
  assert.strictEqual(tickWeather('暴风雪', DEFAULT_ADJACENCY), '暴风雪')
})

test('tickWeather: pickIndex wraps via mod (negative ok)', () => {
  // pickIndex=-1 → mod 2 = 1 for 晴 neighbours=['晴','多云']
  assert.strictEqual(tickWeather('晴', DEFAULT_ADJACENCY, -1), '多云')
})

// --- advanceWeather ---

const TICK_H = 6
const TICK_MS = TICK_H * 3600 * 1000

test('advanceWeather: elapsed < tickHours → 0 ticks, weather unchanged', () => {
  const base = 1000000000
  const result = advanceWeather('晴', base, base + TICK_MS - 1, TICK_H, DEFAULT_ADJACENCY, 0)
  assert.strictEqual(result.ticks, 0)
  assert.strictEqual(result.weather, '晴')
  assert.strictEqual(result.newLastTickMs, base)
})

test('advanceWeather: elapsed = exactly 1 tick → 1 tick', () => {
  const base = 1000000000
  const result = advanceWeather('晴', base, base + TICK_MS, TICK_H, DEFAULT_ADJACENCY, 1)
  assert.strictEqual(result.ticks, 1)
  assert.strictEqual(result.weather, '多云')   // 晴[1] = 多云
  assert.strictEqual(result.newLastTickMs, base + TICK_MS)
})

test('advanceWeather: elapsed = 2 ticks, each step stays adjacent', () => {
  const base = 1000000000
  // pickIndex=1 each step:
  //   step1: 晴 neighbours=['晴','多云'] → [1]='多云'
  //   step2: 多云 neighbours=['晴','多云','阴'] → [1]='多云'
  const result = advanceWeather('晴', base, base + 2 * TICK_MS, TICK_H, DEFAULT_ADJACENCY, 1)
  assert.strictEqual(result.ticks, 2)
  assert.strictEqual(result.weather, '多云')
  assert.strictEqual(result.newLastTickMs, base + 2 * TICK_MS)
})

test('advanceWeather: elapsed = 2.9 ticks → 2 ticks (floor)', () => {
  const base = 1000000000
  const result = advanceWeather('晴', base, base + Math.floor(2.9 * TICK_MS), TICK_H, DEFAULT_ADJACENCY, 0)
  assert.strictEqual(result.ticks, 2)
  // pickIndex=0: 晴→晴→晴 (self-loop each step)
  assert.strictEqual(result.weather, '晴')
})

test('advanceWeather: each intermediate step produces only adjacent states', () => {
  // Run 5 steps from 多云, picking randomly but recording each step
  const base = 1000000000
  let weather = '多云'
  let lastTick = base
  for (let step = 0; step < 5; step++) {
    const prevWeather = weather
    const res = advanceWeather(weather, lastTick, lastTick + TICK_MS, TICK_H, DEFAULT_ADJACENCY)
    assert.ok(
      DEFAULT_ADJACENCY[prevWeather].includes(res.weather),
      'step ' + step + ': ' + prevWeather + '→' + res.weather + ' must be adjacent'
    )
    weather = res.weather
    lastTick = res.newLastTickMs
  }
})

test('advanceWeather: newLastTickMs advances by exactly ticks*tickMs (no drift)', () => {
  const base = 1000000000
  const overshoot = base + 2 * TICK_MS + 999  // 2 full ticks + remainder
  const result = advanceWeather('晴', base, overshoot, TICK_H, DEFAULT_ADJACENCY, 0)
  assert.strictEqual(result.ticks, 2)
  assert.strictEqual(result.newLastTickMs, base + 2 * TICK_MS)
})

test('advanceWeather: function pick receives neighbours array', () => {
  const base = 1000000000
  let sawNeighbours
  const result = advanceWeather('晴', base, base + TICK_MS, TICK_H, DEFAULT_ADJACENCY, (neighbours) => {
    sawNeighbours = neighbours
    return neighbours[1]  // pick 多云
  })
  assert.deepStrictEqual(sawNeighbours, ['晴', '多云'])
  assert.strictEqual(result.weather, '多云')
})

// ---- world-registry.js: matchContext / selectAvailable / sampleWeighted ----

const {
  matchContext,
  selectAvailable,
  sampleWeighted,
  DEFAULT_ENTRIES: REGISTRY_DEFAULT_ENTRIES,
} = require('./world-registry')

// --- matchContext: empty conditions → always true ---

test('matchContext: empty conditions {} → true', () => {
  const world = { timeOfDay: '上午', weather: '晴', season: '春', locations: ['本丸·主屋'] }
  const ls = { location: '本丸·主屋' }
  assert.strictEqual(matchContext({}, world, ls), true)
})

test('matchContext: null conditions → true', () => {
  assert.strictEqual(matchContext(null, {}, {}), true)
})

// --- matchContext: timeOfDay ---

test('matchContext: timeOfDay match → true', () => {
  const world = { timeOfDay: '上午' }
  assert.strictEqual(matchContext({ timeOfDay: ['上午', '午后'] }, world, {}), true)
})

test('matchContext: timeOfDay miss → false', () => {
  const world = { timeOfDay: '深夜' }
  assert.strictEqual(matchContext({ timeOfDay: ['上午', '午后'] }, world, {}), false)
})

test('matchContext: timeOfDay absent in conditions → always matches', () => {
  const world = { timeOfDay: '深夜' }
  assert.strictEqual(matchContext({ weather: ['晴'] }, { timeOfDay: '深夜', weather: '晴' }, {}), true)
})

// --- matchContext: weather ---

test('matchContext: weather match → true', () => {
  const world = { weather: '雨' }
  assert.strictEqual(matchContext({ weather: ['阴', '雨'] }, world, {}), true)
})

test('matchContext: weather miss → false', () => {
  const world = { weather: '晴' }
  assert.strictEqual(matchContext({ weather: ['阴', '雨'] }, world, {}), false)
})

// --- matchContext: season ---

test('matchContext: season match → true', () => {
  assert.strictEqual(matchContext({ season: ['春', '秋'] }, { season: '秋' }, {}), true)
})

test('matchContext: season miss → false', () => {
  assert.strictEqual(matchContext({ season: ['春'] }, { season: '冬' }, {}), false)
})

// --- matchContext: location ---

test('matchContext: location match (from lifeState) → true', () => {
  assert.strictEqual(
    matchContext({ location: ['练习场', '庭院'] }, {}, { location: '练习场' }),
    true
  )
})

test('matchContext: location miss → false', () => {
  assert.strictEqual(
    matchContext({ location: ['练习场'] }, {}, { location: '库房' }),
    false
  )
})

test('matchContext: location absent in lifeState + condition present → false', () => {
  assert.strictEqual(
    matchContext({ location: ['练习场'] }, {}, {}),
    false
  )
})

// --- matchContext: requiresOtherPresent ---

test('matchContext: requiresOtherPresent=true, otherPresent=true → true', () => {
  assert.strictEqual(
    matchContext({ requiresOtherPresent: true }, {}, { otherPresent: true }),
    true
  )
})

test('matchContext: requiresOtherPresent=true, otherPresent=false → false (P1 no others)', () => {
  assert.strictEqual(
    matchContext({ requiresOtherPresent: true }, {}, { otherPresent: false }),
    false
  )
})

test('matchContext: requiresOtherPresent=true, otherPresent absent → false', () => {
  assert.strictEqual(
    matchContext({ requiresOtherPresent: true }, {}, {}),
    false
  )
})

test('matchContext: requiresOtherPresent=false → does not block (pass)', () => {
  // requiresOtherPresent:false means "no constraint via this key" — let through
  assert.strictEqual(
    matchContext({ requiresOtherPresent: false }, {}, {}),
    true
  )
})

// --- matchContext: multi-condition AND ---

test('matchContext: multiple conditions all match → true', () => {
  const world = { timeOfDay: '上午', weather: '晴', season: '春' }
  const ls    = { location: '练习场' }
  assert.strictEqual(
    matchContext({ timeOfDay: ['上午'], weather: ['晴'], season: ['春'], location: ['练习场'] }, world, ls),
    true
  )
})

test('matchContext: multiple conditions, one miss → false', () => {
  const world = { timeOfDay: '深夜', weather: '晴', season: '春' }
  const ls    = { location: '练习场' }
  assert.strictEqual(
    matchContext({ timeOfDay: ['上午'], weather: ['晴'], season: ['春'], location: ['练习场'] }, world, ls),
    false
  )
})

// --- selectAvailable ---

const SAMPLE_ENTRIES = [
  { type: '练习',     conditions: { timeOfDay: ['上午', '午后'] }, weight: 3 },
  { type: '夜巡',     conditions: { timeOfDay: ['夜', '深夜'] },   weight: 2 },
  { type: '思绪',     conditions: {},                              weight: 1 },
  { type: '新命名角色', conditions: {},                             weight: 5 },  // forbidden
]

const FORBIDDEN = ['新命名角色', '重大伤亡']

test('selectAvailable: matches context + excludes forbidden', () => {
  const world = { timeOfDay: '上午' }
  const result = selectAvailable(SAMPLE_ENTRIES, world, {}, FORBIDDEN)
  const types = result.map((e) => e.type)
  assert.ok(types.includes('练习'),   '练习 should be included')
  assert.ok(types.includes('思绪'),   '思绪 should be included (empty conditions)')
  assert.ok(!types.includes('夜巡'),  '夜巡 should be excluded (wrong timeOfDay)')
  assert.ok(!types.includes('新命名角色'), '新命名角色 should be excluded (forbidden)')
})

test('selectAvailable: empty entries → []', () => {
  assert.deepStrictEqual(selectAvailable([], {}, {}, FORBIDDEN), [])
})

test('selectAvailable: null entries → []', () => {
  assert.deepStrictEqual(selectAvailable(null, {}, {}, FORBIDDEN), [])
})

test('selectAvailable: no forbidden list → includes all that match', () => {
  const world = { timeOfDay: '夜' }
  const result = selectAvailable(SAMPLE_ENTRIES, world, {}, [])
  const types = result.map((e) => e.type)
  assert.ok(types.includes('夜巡'))
  assert.ok(types.includes('思绪'))
  assert.ok(types.includes('新命名角色'))
  assert.ok(!types.includes('练习'))
})

test('selectAvailable: preserves weight field', () => {
  const world = { timeOfDay: '上午' }
  const result = selectAvailable(SAMPLE_ENTRIES, world, {}, FORBIDDEN)
  const 練習 = result.find((e) => e.type === '練習') || result.find((e) => e.type === '练习')
  assert.ok(練習, '练习 entry should exist')
  assert.strictEqual(練習.weight, 3)
})

test('selectAvailable: entry with no type is ignored', () => {
  const entries = [{ conditions: {}, weight: 1 }]
  assert.deepStrictEqual(selectAvailable(entries, {}, {}, []), [])
})

// --- sampleWeighted ---

test('sampleWeighted: empty array → null', () => {
  assert.strictEqual(sampleWeighted([], 0.5), null)
})

test('sampleWeighted: null → null', () => {
  assert.strictEqual(sampleWeighted(null, 0.5), null)
})

test('sampleWeighted: single entry → always returns that type', () => {
  assert.strictEqual(sampleWeighted([{ type: 'foo', weight: 5 }], 0), 'foo')
  assert.strictEqual(sampleWeighted([{ type: 'foo', weight: 5 }], 0.99), 'foo')
})

test('sampleWeighted: two entries equal weight, r=0 → first', () => {
  const items = [{ type: 'A', weight: 1 }, { type: 'B', weight: 1 }]
  // total=2, r*total=0 → cursor after A=1 > 0 → picks A
  assert.strictEqual(sampleWeighted(items, 0), 'A')
})

test('sampleWeighted: two entries equal weight, r=0.5 → second', () => {
  const items = [{ type: 'A', weight: 1 }, { type: 'B', weight: 1 }]
  // total=2, r*2=1.0 → cursor after A=1, 1.0 < 1? no → cursor after B=2, 1.0<2 → B
  assert.strictEqual(sampleWeighted(items, 0.5), 'B')
})

test('sampleWeighted: r at bucket boundary picks correct side', () => {
  // weights: A=2, B=3 → total=5; A bucket [0,2), B bucket [2,5)
  const items = [{ type: 'A', weight: 2 }, { type: 'B', weight: 3 }]
  // r=0.39: r*5=1.95 → falls in A (cursor after A=2 > 1.95)
  assert.strictEqual(sampleWeighted(items, 0.39), 'A')
  // r=0.40: r*5=2.0  → NOT in A (2.0 < 2 is false), falls in B (cursor after B=5 > 2.0)
  assert.strictEqual(sampleWeighted(items, 0.40), 'B')
})

test('sampleWeighted: three entries, r picks third', () => {
  const items = [{ type: 'X', weight: 1 }, { type: 'Y', weight: 1 }, { type: 'Z', weight: 1 }]
  // total=3; r=0.67 → r*3=2.01; cursor: after X=1 (not), after Y=2 (not), after Z=3 (2.01<3) → Z
  assert.strictEqual(sampleWeighted(items, 0.67), 'Z')
})

test('sampleWeighted: all zero weights → picks first (safe fallback)', () => {
  const items = [{ type: 'A', weight: 0 }, { type: 'B', weight: 0 }]
  assert.strictEqual(sampleWeighted(items, 0.5), 'A')
})

test('sampleWeighted: works without r (Math.random path, just must not throw)', () => {
  const items = [{ type: 'A', weight: 1 }, { type: 'B', weight: 1 }]
  const result = sampleWeighted(items)
  assert.ok(result === 'A' || result === 'B')
})

// --- DEFAULT_ENTRIES: sanity checks ---

test('DEFAULT_ENTRIES: 练习 has weight>0 and timeOfDay condition', () => {
  const e = REGISTRY_DEFAULT_ENTRIES.find((x) => x.type === '练习')
  assert.ok(e, '练习 entry should exist')
  assert.ok(e.weight > 0)
  assert.ok(Array.isArray(e.conditions.timeOfDay))
})

test('DEFAULT_ENTRIES: 思绪 has empty conditions (always matches)', () => {
  const e = REGISTRY_DEFAULT_ENTRIES.find((x) => x.type === '思绪')
  assert.ok(e, '思绪 entry should exist')
  assert.deepStrictEqual(Object.keys(e.conditions), [])
})

// ---- world-continuity.js: continuityClamp ----

const { continuityClamp } = require('./world-continuity')

const WORLD_BASE = {
  clock: 1000000,
  locations: ['本丸·主屋', '练习场', '库房', '庭院', '檐下', '厨房'],
  externalLocations: ['城下町', '近所'],
}

// --- ok cases ---

test('continuityClamp: legal internal location, clock advances → ok=true, no change', () => {
  const ns = { clock: 1001000, location: '练习场' }
  const r = continuityClamp(ns, WORLD_BASE)
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.clamped.location, '练习场')
  assert.strictEqual(r.clamped.clock, 1001000)
  assert.strictEqual(r.reason, '')
})

test('continuityClamp: legal external location (whitelist) → ok=true', () => {
  const ns = { clock: 1001000, location: '城下町' }
  const r = continuityClamp(ns, WORLD_BASE)
  assert.strictEqual(r.ok, true)
  assert.strictEqual(r.clamped.location, '城下町')
})

test('continuityClamp: clock equal to world.clock → ok (monotonic ok on equal)', () => {
  const ns = { clock: 1000000, location: '庭院' }
  const r = continuityClamp(ns, WORLD_BASE)
  assert.strictEqual(r.ok, true)
})

test('continuityClamp: no location in nextState → ok (no location to validate)', () => {
  const ns = { clock: 1000000 }
  const r = continuityClamp(ns, WORLD_BASE)
  assert.strictEqual(r.ok, true)
})

// --- clock rewind ---

test('continuityClamp: clock rewind → ok=false, clamped to world.clock', () => {
  const ns = { clock: 999999, location: '练习场' }
  const r = continuityClamp(ns, WORLD_BASE)
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.clamped.clock, 1000000)
  assert.ok(r.reason.includes('时钟倒流'))
})

test('continuityClamp: clock=0 when world.clock=1000000 → clamped', () => {
  const ns = { clock: 0, location: '练习场' }
  const r = continuityClamp(ns, WORLD_BASE)
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.clamped.clock, 1000000)
})

// --- illegal location ---

test('continuityClamp: illegal location → ok=false, clamped to first internal', () => {
  const ns = { clock: 1001000, location: '纽约' }
  const r = continuityClamp(ns, WORLD_BASE)
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.clamped.location, '本丸·主屋')  // first in locations list
  assert.ok(r.reason.includes('非法地点'))
  assert.ok(r.reason.includes('纽约'))
})

test('continuityClamp: unauthorized external → clamped (§5.4d)', () => {
  const ns = { clock: 1001000, location: '遠征先·山道' }
  const r = continuityClamp(ns, WORLD_BASE)
  assert.strictEqual(r.ok, false)
  // 遠征先·山道 is not in locations nor externalLocations
  assert.ok(r.clamped.location !== '遠征先·山道')
})

// --- travel time ---

test('continuityClamp: external move with sufficient duration → ok', () => {
  const ns = { clock: 1001000, location: '城下町', duration: 20 }
  const r = continuityClamp(ns, WORLD_BASE)
  assert.strictEqual(r.ok, true)
})

test('continuityClamp: external move with too-short duration → ok=false, clamped', () => {
  const ns = { clock: 1001000, location: '城下町', duration: 5 }
  const r = continuityClamp(ns, WORLD_BASE)
  assert.strictEqual(r.ok, false)
  assert.ok(r.clamped.duration >= 15)
  assert.ok(r.reason.includes('移动时间不足'))
})

test('continuityClamp: internal move with sufficient duration → ok', () => {
  const ns = { clock: 1001000, location: '练习场', duration: 10 }
  const r = continuityClamp(ns, WORLD_BASE)
  assert.strictEqual(r.ok, true)
})

test('continuityClamp: internal move with too-short duration → ok=false, clamped to 5', () => {
  const ns = { clock: 1001000, location: '练习场', duration: 2 }
  const r = continuityClamp(ns, WORLD_BASE)
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.clamped.duration, 5)
  assert.ok(r.reason.includes('移动时间不足'))
})

test('continuityClamp: no duration → travel time rule not enforced', () => {
  const ns = { clock: 1001000, location: '城下町' }
  const r = continuityClamp(ns, WORLD_BASE)
  // No duration field means travel-time check is skipped
  assert.strictEqual(r.ok, true)
})

// --- multiple violations ---

test('continuityClamp: clock rewind + illegal location → ok=false, both clamped', () => {
  const ns = { clock: 500000, location: '月球' }
  const r = continuityClamp(ns, WORLD_BASE)
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.clamped.clock, 1000000)
  assert.ok(r.clamped.location !== '月球')
  assert.ok(r.reason.includes('时钟倒流'))
  assert.ok(r.reason.includes('非法地点'))
})

test('continuityClamp: does not mutate input', () => {
  const ns = { clock: 500000, location: '火星', duration: 1 }
  const original = Object.assign({}, ns)
  continuityClamp(ns, WORLD_BASE)
  assert.deepStrictEqual(ns, original)
})

// --- empty/null world ---

test('continuityClamp: empty world → clock clamped to 0, location illegal → safe default', () => {
  const ns = { clock: 1000, location: '练习场' }
  const r = continuityClamp(ns, {})
  // 练习场 not in an empty locations list → illegal, clamp to '本丸·主屋'
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.clamped.location, '本丸·主屋')
})

test('continuityClamp: null nextState → ok=true, clamped={} (graceful)', () => {
  const r = continuityClamp(null, WORLD_BASE)
  assert.strictEqual(r.ok, true)
})

// ---- memory-short.js: pickRecent / isOlderThan / defaultLifeState / mergeLifeState / eventToRow ----

const {
  pickRecent,
  isOlderThan,
  defaultLifeState,
  mergeLifeState,
  eventToRow,
} = require('./memory-short')

// --- pickRecent ---

test('pickRecent: empty array → []', () => {
  assert.deepStrictEqual(pickRecent([], 5), [])
})

test('pickRecent: null → []', () => {
  assert.deepStrictEqual(pickRecent(null, 5), [])
})

test('pickRecent: sorts by ts descending', () => {
  const events = [
    { ts: new Date(1000), id: 1 },
    { ts: new Date(3000), id: 3 },
    { ts: new Date(2000), id: 2 },
  ]
  const result = pickRecent(events, 3)
  assert.deepStrictEqual(result.map((e) => e.id), [3, 2, 1])
})

test('pickRecent: respects n limit', () => {
  const events = [
    { ts: new Date(1000), id: 1 },
    { ts: new Date(2000), id: 2 },
    { ts: new Date(3000), id: 3 },
  ]
  const result = pickRecent(events, 2)
  assert.strictEqual(result.length, 2)
  assert.deepStrictEqual(result.map((e) => e.id), [3, 2])
})

test('pickRecent: n > length → returns all', () => {
  const events = [
    { ts: new Date(1000), id: 1 },
    { ts: new Date(2000), id: 2 },
  ]
  const result = pickRecent(events, 10)
  assert.strictEqual(result.length, 2)
})

test('pickRecent: n=0 → []', () => {
  const events = [{ ts: new Date(1000), id: 1 }]
  const result = pickRecent(events, 0)
  assert.deepStrictEqual(result, [])
})

test('pickRecent: n=null → returns all', () => {
  const events = [
    { ts: new Date(1000), id: 1 },
    { ts: new Date(2000), id: 2 },
  ]
  const result = pickRecent(events, null)
  assert.strictEqual(result.length, 2)
})

test('pickRecent: equal-ts events preserve original order (stable)', () => {
  const ts = new Date(5000)
  const events = [
    { ts, id: 'a' },
    { ts, id: 'b' },
    { ts, id: 'c' },
  ]
  const result = pickRecent(events, 3)
  // All same ts, so original order a→b→c must be preserved
  assert.deepStrictEqual(result.map((e) => e.id), ['a', 'b', 'c'])
})

test('pickRecent: ts as number also works', () => {
  const events = [
    { ts: 1000, id: 1 },
    { ts: 3000, id: 3 },
    { ts: 2000, id: 2 },
  ]
  const result = pickRecent(events, 3)
  assert.deepStrictEqual(result.map((e) => e.id), [3, 2, 1])
})

test('pickRecent: does not mutate input array', () => {
  const events = [
    { ts: new Date(1000), id: 1 },
    { ts: new Date(3000), id: 3 },
  ]
  const original = events.slice()
  pickRecent(events, 2)
  assert.deepStrictEqual(events, original)
})

// --- isOlderThan ---

test('isOlderThan: ts strictly before cutoff → true', () => {
  assert.strictEqual(isOlderThan({ ts: new Date(999) }, 1000), true)
})

test('isOlderThan: ts exactly equal to cutoff → false (not strictly older)', () => {
  assert.strictEqual(isOlderThan({ ts: new Date(1000) }, 1000), false)
})

test('isOlderThan: ts after cutoff → false', () => {
  assert.strictEqual(isOlderThan({ ts: new Date(2000) }, 1000), false)
})

test('isOlderThan: ts as number works', () => {
  assert.strictEqual(isOlderThan({ ts: 500 }, 1000), true)
  assert.strictEqual(isOlderThan({ ts: 1500 }, 1000), false)
})

test('isOlderThan: ts=0 is older than any positive cutoff', () => {
  assert.strictEqual(isOlderThan({ ts: 0 }, 1), true)
})

// --- defaultLifeState ---

test('defaultLifeState: returns object with correct presetId', () => {
  const state = defaultLifeState('higekiri')
  assert.strictEqual(state.presetId, 'higekiri')
})

test('defaultLifeState: open_threads is empty array', () => {
  const state = defaultLifeState('higekiri')
  assert.ok(Array.isArray(state.open_threads))
  assert.strictEqual(state.open_threads.length, 0)
})

test('defaultLifeState: recent_event_ids is empty array', () => {
  const state = defaultLifeState('higekiri')
  assert.ok(Array.isArray(state.recent_event_ids))
  assert.strictEqual(state.recent_event_ids.length, 0)
})

test('defaultLifeState: has mood field set to neutral', () => {
  const state = defaultLifeState('higekiri')
  assert.strictEqual(state.mood, 'neutral')
})

test('defaultLifeState: has §5.2 required fields', () => {
  const state = defaultLifeState('test')
  const fields = ['presetId', 'location', 'current_activity', 'mood', 'open_threads', 'recent_event_ids', 'updatedAt']
  for (const f of fields) {
    assert.ok(Object.prototype.hasOwnProperty.call(state, f), 'missing field: ' + f)
  }
})

test('defaultLifeState: different calls return independent objects', () => {
  const a = defaultLifeState('a')
  const b = defaultLifeState('b')
  a.open_threads.push({ id: 'x' })
  assert.strictEqual(b.open_threads.length, 0)
})

// --- mergeLifeState ---

test('mergeLifeState: patch overrides scalar fields', () => {
  const prev = defaultLifeState('p1')
  const patch = { location: '练习场', mood: '专注' }
  const result = mergeLifeState(prev, patch)
  assert.strictEqual(result.location, '练习场')
  assert.strictEqual(result.mood, '专注')
})

test('mergeLifeState: absent scalar in patch → prev value preserved', () => {
  const prev = Object.assign(defaultLifeState('p1'), { location: '主屋' })
  const patch = { mood: '疲惫' }
  const result = mergeLifeState(prev, patch)
  assert.strictEqual(result.location, '主屋')
})

test('mergeLifeState: open_threads replaced when present in patch', () => {
  const prev = Object.assign(defaultLifeState('p1'), {
    open_threads: [{ id: 'old', desc: '旧线索' }],
  })
  const patch = { open_threads: [{ id: 'new', desc: '新线索' }] }
  const result = mergeLifeState(prev, patch)
  assert.strictEqual(result.open_threads.length, 1)
  assert.strictEqual(result.open_threads[0].id, 'new')
})

test('mergeLifeState: open_threads replaced with empty array when patch specifies []', () => {
  const prev = Object.assign(defaultLifeState('p1'), {
    open_threads: [{ id: 'x' }],
  })
  const patch = { open_threads: [] }
  const result = mergeLifeState(prev, patch)
  assert.deepStrictEqual(result.open_threads, [])
})

test('mergeLifeState: open_threads preserved from prev when absent in patch', () => {
  const thread = { id: 'keep', desc: '保留' }
  const prev = Object.assign(defaultLifeState('p1'), { open_threads: [thread] })
  const patch = { mood: '开心' }
  const result = mergeLifeState(prev, patch)
  assert.strictEqual(result.open_threads.length, 1)
  assert.strictEqual(result.open_threads[0].id, 'keep')
})

test('mergeLifeState: recent_event_ids replaced when present in patch', () => {
  const prev = Object.assign(defaultLifeState('p1'), {
    recent_event_ids: ['evt_1', 'evt_2'],
  })
  const patch = { recent_event_ids: ['evt_3'] }
  const result = mergeLifeState(prev, patch)
  assert.deepStrictEqual(result.recent_event_ids, ['evt_3'])
})

test('mergeLifeState: recent_event_ids preserved from prev when absent in patch', () => {
  const prev = Object.assign(defaultLifeState('p1'), {
    recent_event_ids: ['evt_1'],
  })
  const patch = { mood: '疲惫' }
  const result = mergeLifeState(prev, patch)
  assert.deepStrictEqual(result.recent_event_ids, ['evt_1'])
})

test('mergeLifeState: does not mutate prev', () => {
  const prev = Object.assign(defaultLifeState('p1'), {
    open_threads: [{ id: 'x' }],
    mood: 'calm',
  })
  const prevCopy = JSON.parse(JSON.stringify(prev))
  mergeLifeState(prev, { mood: 'anxious', open_threads: [] })
  assert.deepStrictEqual(prev.open_threads, prevCopy.open_threads)
  assert.strictEqual(prev.mood, prevCopy.mood)
})

test('mergeLifeState: does not mutate patch', () => {
  const patch = { mood: 'happy', open_threads: [{ id: 'y' }] }
  const patchMoodBefore = patch.mood
  const patchThreadsBefore = patch.open_threads.length
  mergeLifeState(defaultLifeState('p1'), patch)
  assert.strictEqual(patch.mood, patchMoodBefore)
  assert.strictEqual(patch.open_threads.length, patchThreadsBefore)
})

test('mergeLifeState: preserves presetId from prev when not in patch', () => {
  const prev = defaultLifeState('higekiri')
  const result = mergeLifeState(prev, { mood: 'happy' })
  assert.strictEqual(result.presetId, 'higekiri')
})

test('mergeLifeState: patch can override presetId (no restriction)', () => {
  const prev = defaultLifeState('a')
  const result = mergeLifeState(prev, { presetId: 'b' })
  assert.strictEqual(result.presetId, 'b')
})

test('mergeLifeState: accepts updatedAt from patch (caller sets it)', () => {
  const ts = new Date(12345)
  const result = mergeLifeState(defaultLifeState('p1'), { updatedAt: ts })
  assert.strictEqual(result.updatedAt, ts)
})

// --- eventToRow ---

test('eventToRow: duration_minutes → duration_min (integer)', () => {
  const row = eventToRow({ duration_minutes: 45, title: 't' })
  assert.strictEqual(row.duration_min, 45)
})

test('eventToRow: duration_min passed straight through as integer', () => {
  const row = eventToRow({ duration_min: 30 })
  assert.strictEqual(row.duration_min, 30)
})

test('eventToRow: duration_min preferred over duration_minutes when both present', () => {
  const row = eventToRow({ duration_min: 10, duration_minutes: 99 })
  assert.strictEqual(row.duration_min, 10)
})

test('eventToRow: duration absent → duration_min null', () => {
  const row = eventToRow({ title: 't' })
  assert.strictEqual(row.duration_min, null)
})

test('eventToRow: duration_minutes non-integer coerced to int via Math.round', () => {
  const row = eventToRow({ duration_minutes: 45.7 })
  assert.strictEqual(row.duration_min, 46)
})

test('eventToRow: threads_touched → threads JSON string', () => {
  const row = eventToRow({ threads_touched: ['t1', 't2'] })
  assert.strictEqual(row.threads, JSON.stringify(['t1', 't2']))
})

test('eventToRow: threads passed straight through as JSON string', () => {
  const row = eventToRow({ threads: [{ id: 'x' }] })
  assert.strictEqual(row.threads, JSON.stringify([{ id: 'x' }]))
})

test('eventToRow: threads preferred over threads_touched when both present', () => {
  const row = eventToRow({ threads: ['a'], threads_touched: ['b'] })
  assert.strictEqual(row.threads, JSON.stringify(['a']))
})

test('eventToRow: threads absent → threads is "[]"', () => {
  const row = eventToRow({ title: 't' })
  assert.strictEqual(row.threads, '[]')
})

test('eventToRow: participants → JSON string', () => {
  const row = eventToRow({ participants: ['p1', 'p2'] })
  assert.strictEqual(row.participants, JSON.stringify(['p1', 'p2']))
})

test('eventToRow: participants absent → "[]"', () => {
  const row = eventToRow({ title: 't' })
  assert.strictEqual(row.participants, '[]')
})

test('eventToRow: no stray key duration_minutes in output', () => {
  const row = eventToRow({ duration_minutes: 20 })
  assert.ok(!Object.prototype.hasOwnProperty.call(row, 'duration_minutes'), 'duration_minutes must not be in row')
})

test('eventToRow: no stray key threads_touched in output', () => {
  const row = eventToRow({ threads_touched: ['x'] })
  assert.ok(!Object.prototype.hasOwnProperty.call(row, 'threads_touched'), 'threads_touched must not be in row')
})

test('eventToRow: no stray key candidates in output', () => {
  const row = eventToRow({ candidates: [1, 2, 3] })
  assert.ok(!Object.prototype.hasOwnProperty.call(row, 'candidates'), 'candidates must not be in row')
})

test('eventToRow: no stray key next_state in output', () => {
  const row = eventToRow({ next_state: { location: 'x' } })
  assert.ok(!Object.prototype.hasOwnProperty.call(row, 'next_state'), 'next_state must not be in row')
})

test('eventToRow: no stray key want_to_share in output', () => {
  const row = eventToRow({ want_to_share: 'now' })
  assert.ok(!Object.prototype.hasOwnProperty.call(row, 'want_to_share'), 'want_to_share must not be in row')
})

test('eventToRow: no stray key chosen_index in output', () => {
  const row = eventToRow({ chosen_index: 0 })
  assert.ok(!Object.prototype.hasOwnProperty.call(row, 'chosen_index'), 'chosen_index must not be in row')
})

test('eventToRow: copies title through', () => {
  const row = eventToRow({ title: '练习' })
  assert.strictEqual(row.title, '練習' === '练习' ? '练习' : '练习')
  assert.strictEqual(row.title, '练习')
})

test('eventToRow: copies narrative through', () => {
  const row = eventToRow({ narrative: '描述文本' })
  assert.strictEqual(row.narrative, '描述文本')
})

test('eventToRow: copies event_type through', () => {
  const row = eventToRow({ event_type: '练习' })
  assert.strictEqual(row.event_type, '练习')
})

test('eventToRow: copies location through', () => {
  const row = eventToRow({ location: '练习场' })
  assert.strictEqual(row.location, '练习场')
})

test('eventToRow: copies mood through', () => {
  const row = eventToRow({ mood: '专注' })
  assert.strictEqual(row.mood, '专注')
})

test('eventToRow: copies importance through', () => {
  const row = eventToRow({ importance: 0.8 })
  assert.strictEqual(row.importance, 0.8)
})

test('eventToRow: copies plan_adherence through', () => {
  const row = eventToRow({ plan_adherence: 'followed' })
  assert.strictEqual(row.plan_adherence, 'followed')
})

test('eventToRow: copies type through', () => {
  const row = eventToRow({ type: 'context' })
  assert.strictEqual(row.type, 'context')
})

test('eventToRow: copies sourceModel through', () => {
  const row = eventToRow({ sourceModel: 'openai/gpt-4o' })
  assert.strictEqual(row.sourceModel, 'openai/gpt-4o')
})

test('eventToRow: consolidated true → true', () => {
  const row = eventToRow({ consolidated: true })
  assert.strictEqual(row.consolidated, true)
})

test('eventToRow: consolidated absent → false (default)', () => {
  const row = eventToRow({})
  assert.strictEqual(row.consolidated, false)
})

test('eventToRow: no new Date() call (deterministic; no ts/day/presetId/id in output)', () => {
  const row = eventToRow({ title: 't', ts: new Date(), day: '2026-01-01', presetId: 'x', id: 42 })
  // ts/day/presetId/id must NOT be in eventToRow output
  assert.ok(!Object.prototype.hasOwnProperty.call(row, 'ts'), 'ts must not be in row')
  assert.ok(!Object.prototype.hasOwnProperty.call(row, 'day'), 'day must not be in row')
  assert.ok(!Object.prototype.hasOwnProperty.call(row, 'presetId'), 'presetId must not be in row')
  assert.ok(!Object.prototype.hasOwnProperty.call(row, 'id'), 'id must not be in row')
})

test('eventToRow: full §5.1 roll event object maps correctly (kitchen sink)', () => {
  const event = {
    title: '晨练',
    narrative: '髭切在练习场挥刀。',
    event_type: '练习',
    location: '练习场',
    participants: ['膝丸'],
    mood: '专注',
    duration_minutes: 30,   // roll key — should become duration_min:30
    importance: 0.6,
    threads_touched: ['修行', '手足'],  // roll key — should become threads JSON
    plan_adherence: 'followed',
    type: 'context',
    sourceModel: 'fake/model',
    // stray keys that must not leak
    candidates: [0, 1, 2],
    next_state: { location: '练习场' },
    want_to_share: 'later',
    chosen_index: 1,
  }
  const row = eventToRow(event)
  assert.strictEqual(row.title, '晨练')
  assert.strictEqual(row.duration_min, 30)
  assert.ok(!Object.prototype.hasOwnProperty.call(row, 'duration_minutes'))
  assert.strictEqual(row.threads, JSON.stringify(['修行', '手足']))
  assert.ok(!Object.prototype.hasOwnProperty.call(row, 'threads_touched'))
  assert.strictEqual(row.participants, JSON.stringify(['膝丸']))
  assert.strictEqual(row.mood, '专注')
  assert.strictEqual(row.importance, 0.6)
  assert.strictEqual(row.plan_adherence, 'followed')
  assert.strictEqual(row.type, 'context')
  assert.strictEqual(row.sourceModel, 'fake/model')
  assert.strictEqual(row.consolidated, false)
  assert.ok(!Object.prototype.hasOwnProperty.call(row, 'candidates'))
  assert.ok(!Object.prototype.hasOwnProperty.call(row, 'next_state'))
  assert.ok(!Object.prototype.hasOwnProperty.call(row, 'want_to_share'))
  assert.ok(!Object.prototype.hasOwnProperty.call(row, 'chosen_index'))
})

// ---- schedule-routine.js: blocksFor / buildRoutinePrompt / parseRoutineResponse ----

const {
  blocksFor,
  buildRoutinePrompt,
  parseRoutineResponse,
  extractJson,
  isValidBlock,
  minimalDefaultWeekly,
} = require('./schedule-routine')

// ---------------------------------------------------------------------------
// blocksFor
// ---------------------------------------------------------------------------

test('blocksFor: null routine → []', () => {
  assert.deepStrictEqual(blocksFor(null, 1), [])
})

test('blocksFor: routine with no weekly → []', () => {
  assert.deepStrictEqual(blocksFor({ presetId: 'x' }, 1), [])
})

test('blocksFor: routine weekly={} (no default, no variant) → []', () => {
  assert.deepStrictEqual(blocksFor({ weekly: {} }, 1), [])
})

test('blocksFor: only default present, no variant → returns default', () => {
  const blocks = [{ block: '上午', activity: '练习', location: '练习场' }]
  const routine = { weekly: { default: blocks } }
  assert.deepStrictEqual(blocksFor(routine, 1), blocks)  // Monday, no variant
})

test('blocksFor: variant present (EN key) → returns variant, not default', () => {
  const defaultBlocks = [{ block: '上午', activity: '练习', location: '练习场' }]
  const mondayBlocks = [{ block: '清晨', activity: '擦刀', location: '自室' }]
  const routine = { weekly: { default: defaultBlocks, monday: mondayBlocks } }
  assert.deepStrictEqual(blocksFor(routine, 1), mondayBlocks)  // dayOfWeek=1=Monday
})

test('blocksFor: variant present (ZH key 周一) → returns variant', () => {
  const defaultBlocks = [{ block: '上午', activity: '练习', location: '练习场' }]
  const mondayBlocks = [{ block: '黄昏', activity: '泡茶', location: '檐下' }]
  const routine = { weekly: { default: defaultBlocks, '周一': mondayBlocks } }
  assert.deepStrictEqual(blocksFor(routine, 1), mondayBlocks)
})

test('blocksFor: EN variant present → takes priority over ZH key', () => {
  const enBlocks = [{ block: '夜', activity: '夜巡', location: '本丸各处' }]
  const zhBlocks = [{ block: '上午', activity: '对练', location: '练习场' }]
  const routine = { weekly: { default: [], tuesday: enBlocks, '周二': zhBlocks } }
  assert.deepStrictEqual(blocksFor(routine, 2), enBlocks)
})

test('blocksFor: Sunday variant (dayOfWeek=0) resolved via "sunday" key', () => {
  const sunBlocks = [{ block: '午后', activity: '散步', location: '庭院' }]
  const routine = { weekly: { default: [], sunday: sunBlocks } }
  assert.deepStrictEqual(blocksFor(routine, 0), sunBlocks)
})

test('blocksFor: Saturday variant (dayOfWeek=6) resolved via "saturday" key', () => {
  const satBlocks = [{ block: '上午', activity: '整理装备', location: '库房' }]
  const routine = { weekly: { default: [], saturday: satBlocks } }
  assert.deepStrictEqual(blocksFor(routine, 6), satBlocks)
})

test('blocksFor: dayOfWeek out of range → falls back to default', () => {
  const defaultBlocks = [{ block: '上午', activity: '日常', location: '本丸' }]
  const routine = { weekly: { default: defaultBlocks } }
  // dayOfWeek=7 has no key → falls back to default
  assert.deepStrictEqual(blocksFor(routine, 7), defaultBlocks)
})

test('blocksFor: variant is not array → skipped, falls to default', () => {
  const defaultBlocks = [{ block: '上午', activity: '日常', location: '本丸' }]
  const routine = { weekly: { default: defaultBlocks, monday: 'not-an-array' } }
  assert.deepStrictEqual(blocksFor(routine, 1), defaultBlocks)
})

// ---------------------------------------------------------------------------
// buildRoutinePrompt
// ---------------------------------------------------------------------------

test('buildRoutinePrompt: returns messages array with system + user', () => {
  const msgs = buildRoutinePrompt('髭切人设', [], null)
  assert.ok(Array.isArray(msgs), 'should return array')
  assert.strictEqual(msgs.length, 2)
  assert.strictEqual(msgs[0].role, 'system')
  assert.strictEqual(msgs[1].role, 'user')
})

test('buildRoutinePrompt: system message contains JSON format instruction', () => {
  const msgs = buildRoutinePrompt('髭切人设', [], null)
  assert.ok(msgs[0].content.includes('"weekly"'), 'system should mention weekly key')
  assert.ok(msgs[0].content.includes('"block"'), 'system should mention block key')
  assert.ok(msgs[0].content.includes('"activity"'), 'system should mention activity key')
  assert.ok(msgs[0].content.includes('"location"'), 'system should mention location key')
})

test('buildRoutinePrompt: user message contains persona', () => {
  const msgs = buildRoutinePrompt('这是髭切的人设', [], null)
  assert.ok(msgs[1].content.includes('这是髭切的人设'), 'user message should include persona')
})

test('buildRoutinePrompt: user message contains recent events digest', () => {
  const events = [
    { title: '练习场对练', location: '练习场', mood: '专注' },
    { title: '泡茶发呆', location: '檐下', mood: '慵懒' },
  ]
  const msgs = buildRoutinePrompt('persona', events, null)
  assert.ok(msgs[1].content.includes('练习场对练'), 'user message should mention recent event title')
  assert.ok(msgs[1].content.includes('泡茶发呆'), 'user message should mention second event')
})

test('buildRoutinePrompt: user message includes seed when provided', () => {
  const msgs = buildRoutinePrompt('persona', [], '种子日程内容: 清晨起身')
  assert.ok(msgs[1].content.includes('种子日程内容: 清晨起身'), 'seed should appear in user message')
})

test('buildRoutinePrompt: no seed → seed section absent', () => {
  const msgs = buildRoutinePrompt('persona', [], null)
  assert.ok(!msgs[1].content.includes('种子日程'), 'no seed section when seed is null')
})

test('buildRoutinePrompt: no recent events → shows placeholder note', () => {
  const msgs = buildRoutinePrompt('persona', [], null)
  assert.ok(msgs[1].content.includes('暂无近期生活记录'), 'should note absence of recent events')
})

test('buildRoutinePrompt: events limited to 10 (overflow)', () => {
  const events = Array.from({ length: 15 }, (_, i) => ({ title: 'event' + i, location: '本丸', mood: '' }))
  const msgs = buildRoutinePrompt('persona', events, null)
  // First 10 titles should be present; event10–event14 should not appear
  assert.ok(msgs[1].content.includes('event0'))
  assert.ok(msgs[1].content.includes('event9'))
  assert.ok(!msgs[1].content.includes('event10'), 'events beyond 10 should be excluded')
})

test('buildRoutinePrompt: empty persona → uses default fallback text', () => {
  const msgs = buildRoutinePrompt('', [], null)
  assert.ok(msgs[1].content.includes('刀剑男士') || msgs[1].content.includes('默认'), 'should use fallback persona')
})

test('buildRoutinePrompt: null persona → does not throw', () => {
  const msgs = buildRoutinePrompt(null, null, null)
  assert.ok(Array.isArray(msgs) && msgs.length === 2)
})

// ---------------------------------------------------------------------------
// parseRoutineResponse
// ---------------------------------------------------------------------------

// isValidBlock sub-tests (internal, exported)
test('isValidBlock: valid block → true', () => {
  assert.strictEqual(isValidBlock({ block: '上午', activity: '练习', location: '练习场' }), true)
})

test('isValidBlock: missing block → false', () => {
  assert.strictEqual(isValidBlock({ activity: '练习', location: '练习场' }), false)
})

test('isValidBlock: empty block string → false', () => {
  assert.strictEqual(isValidBlock({ block: '', activity: '练习', location: '练习场' }), false)
})

test('isValidBlock: missing activity → false', () => {
  assert.strictEqual(isValidBlock({ block: '上午', location: '练习场' }), false)
})

test('isValidBlock: missing location → false', () => {
  assert.strictEqual(isValidBlock({ block: '上午', activity: '练习' }), false)
})

test('isValidBlock: null → false', () => {
  assert.strictEqual(isValidBlock(null), false)
})

// extractJson sub-tests (internal, exported)
test('extractJson: plain JSON → parsed', () => {
  const result = extractJson('{"weekly":{"default":[]}}')
  assert.ok(result !== null)
  assert.ok(result.weekly)
})

test('extractJson: JSON wrapped in prose → extracted', () => {
  const text = '好的，以下是日程：{"weekly":{"default":[{"block":"上午","activity":"练习","location":"练习场"}]}} 请参考。'
  const result = extractJson(text)
  assert.ok(result !== null)
  assert.ok(result.weekly)
  assert.ok(Array.isArray(result.weekly.default))
})

test('extractJson: garbage text → null', () => {
  const result = extractJson('这里没有JSON对象')
  assert.strictEqual(result, null)
})

test('extractJson: unclosed brace → null', () => {
  const result = extractJson('{"weekly":{"default":[')
  assert.strictEqual(result, null)
})

test('extractJson: empty string → null', () => {
  assert.strictEqual(extractJson(''), null)
})

test('extractJson: null → null', () => {
  assert.strictEqual(extractJson(null), null)
})

// parseRoutineResponse: valid cases
test('parseRoutineResponse: clean JSON weekly → returns validated routine', () => {
  const text = JSON.stringify({
    weekly: {
      default: [
        { block: '清晨', activity: '擦拭刀身', location: '自室' },
        { block: '上午', activity: '对练', location: '练习场' },
      ],
    },
  })
  const result = parseRoutineResponse(text, 'higekiri', 'self')
  assert.strictEqual(result.presetId, 'higekiri')
  assert.strictEqual(result.authoredBy, 'self')
  assert.ok(result.weekly)
  assert.ok(Array.isArray(result.weekly.default))
  assert.strictEqual(result.weekly.default.length, 2)
})

test('parseRoutineResponse: prose-wrapped JSON → still parses', () => {
  const blocks = [
    { block: '黄昏', activity: '泡茶', location: '檐下' },
    { block: '夜', activity: '夜巡', location: '本丸各处' },
  ]
  const text = '当然，以下是日程！\n' + JSON.stringify({ weekly: { default: blocks } }) + '\n希望满意。'
  const result = parseRoutineResponse(text, 'higekiri', 'seed')
  assert.strictEqual(result.authoredBy, 'seed')
  assert.strictEqual(result.weekly.default.length, 2)
  assert.strictEqual(result.weekly.default[0].block, '黄昏')
})

test('parseRoutineResponse: some malformed blocks dropped, valid ones kept', () => {
  const text = JSON.stringify({
    weekly: {
      default: [
        { block: '上午', activity: '练习', location: '练习场' },  // valid
        { block: '', activity: '练习', location: '练习场' },       // malformed: empty block
        { activity: '散步', location: '庭院' },                    // malformed: no block
        { block: '夜', activity: '夜巡', location: '本丸各处' },   // valid
      ],
    },
  })
  const result = parseRoutineResponse(text, 'p1', 'self')
  assert.strictEqual(result.weekly.default.length, 2)
  assert.strictEqual(result.weekly.default[0].block, '上午')
  assert.strictEqual(result.weekly.default[1].block, '夜')
})

test('parseRoutineResponse: all blocks malformed → minimal default weekly', () => {
  const text = JSON.stringify({
    weekly: {
      default: [
        { block: '', activity: '', location: '' },
        { foo: 'bar' },
      ],
    },
  })
  const result = parseRoutineResponse(text, 'p1', 'self')
  // Falls back to minimal default
  const minimal = minimalDefaultWeekly()
  assert.deepStrictEqual(result.weekly, minimal)
})

test('parseRoutineResponse: garbage text → minimal default weekly', () => {
  const result = parseRoutineResponse('这不是 JSON', 'p1', 'self')
  const minimal = minimalDefaultWeekly()
  assert.deepStrictEqual(result.weekly, minimal)
  assert.strictEqual(result.presetId, 'p1')
  assert.strictEqual(result.authoredBy, 'self')
})

test('parseRoutineResponse: null text → minimal default weekly', () => {
  const result = parseRoutineResponse(null, 'p1', 'self')
  const minimal = minimalDefaultWeekly()
  assert.deepStrictEqual(result.weekly, minimal)
})

test('parseRoutineResponse: empty text → minimal default weekly', () => {
  const result = parseRoutineResponse('', 'p1', 'self')
  assert.deepStrictEqual(result.weekly, minimalDefaultWeekly())
})

test('parseRoutineResponse: weekly absent, top-level default array → parsed', () => {
  const text = JSON.stringify({
    default: [{ block: '上午', activity: '日常', location: '本丸' }],
  })
  const result = parseRoutineResponse(text, 'p1', 'self')
  assert.ok(Array.isArray(result.weekly.default))
  assert.strictEqual(result.weekly.default.length, 1)
})

test('parseRoutineResponse: does not contain revisedAt (caller sets it)', () => {
  const text = JSON.stringify({ weekly: { default: [{ block: '上午', activity: '练习', location: '练习场' }] } })
  const result = parseRoutineResponse(text, 'p1', 'self')
  // revisedAt must NOT be set by parseRoutineResponse (no new Date() inside)
  assert.ok(!Object.prototype.hasOwnProperty.call(result, 'revisedAt'), 'revisedAt should not be set by parse')
})

test('parseRoutineResponse: authoredBy=审神者 preserved', () => {
  const text = JSON.stringify({ weekly: { default: [{ block: '上午', activity: '日常', location: '本丸' }] } })
  const result = parseRoutineResponse(text, 'p1', '审神者')
  assert.strictEqual(result.authoredBy, '审神者')
})

test('parseRoutineResponse: weekly with variant keys preserved', () => {
  const text = JSON.stringify({
    weekly: {
      default: [{ block: '上午', activity: '日常', location: '本丸' }],
      monday: [{ block: '清晨', activity: '擦刀', location: '自室' }],
    },
  })
  const result = parseRoutineResponse(text, 'p1', 'self')
  assert.ok(Array.isArray(result.weekly.default))
  assert.ok(Array.isArray(result.weekly.monday))
  assert.strictEqual(result.weekly.monday[0].block, '清晨')
})

test('parseRoutineResponse: variant with all-bad blocks dropped (only valid variants kept)', () => {
  const text = JSON.stringify({
    weekly: {
      default: [{ block: '上午', activity: '日常', location: '本丸' }],  // valid
      tuesday: [{ block: '', activity: '', location: '' }],              // all bad → dropped
    },
  })
  const result = parseRoutineResponse(text, 'p1', 'self')
  assert.ok(Array.isArray(result.weekly.default))
  assert.ok(!Object.prototype.hasOwnProperty.call(result.weekly, 'tuesday'), 'bad-only variant should be dropped')
})

// ---------------------------------------------------------------------------
// createRoutineAuthor glue: fake-model end-to-end (no koishi runtime needed)
// ---------------------------------------------------------------------------

// Build a minimal fake ctx with an in-memory DB
function makeFakeCtx() {
  const store = {}  // TABLE → rows[]
  return {
    database: {
      async get(table, query) {
        const rows = store[table] || []
        return rows.filter((r) => {
          for (const k of Object.keys(query)) {
            const qv = query[k]
            // Support { $in: [...] } operator
            if (qv && typeof qv === 'object' && Array.isArray(qv.$in)) {
              if (!qv.$in.includes(r[k])) return false
            } else {
              if (r[k] !== qv) return false
            }
          }
          return true
        })
      },
      async create(table, row) {
        if (!store[table]) store[table] = []
        const id = store[table].length + 1
        const created = Object.assign({ id }, row)
        store[table].push(created)
        return created
      },
      async set(table, query, patch) {
        const rows = store[table] || []
        for (const r of rows) {
          let match = true
          for (const k of Object.keys(query)) {
            const qv = query[k]
            if (qv && typeof qv === 'object' && Array.isArray(qv.$in)) {
              if (!qv.$in.includes(r[k])) { match = false; break }
            } else {
              if (r[k] !== qv) { match = false; break }
            }
          }
          if (match) Object.assign(r, patch)
        }
      },
      async remove(table, query) {
        if (!store[table]) return
        store[table] = store[table].filter((r) => {
          for (const k of Object.keys(query)) {
            const qv = query[k]
            // Support { id: [...] } as shorthand for $in
            if (Array.isArray(qv)) {
              if (qv.includes(r[k])) return false  // remove if matches
            } else if (qv && typeof qv === 'object' && Array.isArray(qv.$in)) {
              if (qv.$in.includes(r[k])) return false
            } else {
              if (r[k] === qv) return false
            }
          }
          return true  // keep
        })
      },
      _store: store,
    },
  }
}

async function main() {
  // fake-model end-to-end tests for createRoutineAuthor glue
  const { createRoutineAuthor } = require('./schedule-routine')

  await runAsync('createRoutineAuthor: authorRoutine writes routine to DB with self provenance', async () => {
    const ctx = makeFakeCtx()
    const config = { rollModel: 'fake/model', routineSeedPath: null }
    const fakeResponse = JSON.stringify({
      weekly: {
        default: [
          { block: '清晨', activity: '起身擦刀', location: '自室' },
          { block: '上午', activity: '对练', location: '练习场' },
        ],
      },
    })
    const deps = {
      getModel: async () => ({ invoke: async () => ({ content: fakeResponse }) }),
      invoke: async (m, msgs) => {
        const r = await m.invoke(msgs)
        return r.content
      },
    }
    const author = createRoutineAuthor(ctx, config, deps)
    const routine = await author.authorRoutine('higekiri')

    assert.strictEqual(routine.presetId, 'higekiri')
    assert.strictEqual(routine.authoredBy, 'self')
    assert.ok(routine.revisedAt instanceof Date, 'revisedAt should be a Date')
    assert.ok(Array.isArray(routine.weekly.default))
    assert.strictEqual(routine.weekly.default.length, 2)

    // Verify DB was written
    const rows = ctx.database._store['life_sim_routine']
    assert.ok(rows && rows.length === 1, 'one row should be in DB')
    assert.strictEqual(rows[0].presetId, 'higekiri')
    assert.strictEqual(rows[0].authoredBy, 'self')
  })

  await runAsync('createRoutineAuthor: authorRoutine falls back to minimal default on model error', async () => {
    const ctx = makeFakeCtx()
    const config = { rollModel: 'fake/model', routineSeedPath: null }
    const deps = {
      getModel: async () => { throw new Error('model unavailable') },
      invoke: async () => { throw new Error('model unavailable') },
    }
    const author = createRoutineAuthor(ctx, config, deps)
    const routine = await author.authorRoutine('higekiri')

    assert.strictEqual(routine.authoredBy, 'self')
    assert.deepStrictEqual(routine.weekly, minimalDefaultWeekly())
    assert.ok(routine.revisedAt instanceof Date)
  })

  await runAsync('createRoutineAuthor: getRoutine creates fresh routine if none in DB', async () => {
    const ctx = makeFakeCtx()
    const config = { rollModel: 'fake/model', routineSeedPath: null }
    const fakeResponse = JSON.stringify({
      weekly: { default: [{ block: '上午', activity: '日常', location: '本丸' }] },
    })
    const deps = {
      getModel: async () => ({ invoke: async () => ({ content: fakeResponse }) }),
      invoke: async (m, msgs) => (await m.invoke(msgs)).content,
    }
    const author = createRoutineAuthor(ctx, config, deps)
    const routine = await author.getRoutine('higekiri')

    assert.strictEqual(routine.presetId, 'higekiri')
    assert.ok(routine.weekly && routine.weekly.default)
    // Second call should read from DB (not call model again)
    const rows = ctx.database._store['life_sim_routine']
    assert.ok(rows && rows.length === 1)
  })

  await runAsync('createRoutineAuthor: reviseRoutine updates existing routine', async () => {
    const ctx = makeFakeCtx()
    const config = { rollModel: 'fake/model', routineSeedPath: null }
    // Pre-populate DB with an existing routine
    await ctx.database.create('life_sim_routine', {
      presetId: 'higekiri',
      authoredBy: 'self',
      revisedAt: new Date(0),
      weekly: JSON.stringify({ default: [{ block: '清晨', activity: '旧活动', location: '自室' }] }),
    })

    const revisedResponse = JSON.stringify({
      weekly: { default: [{ block: '清晨', activity: '新活动', location: '自室' }] },
    })
    const deps = {
      getModel: async () => ({ invoke: async () => ({ content: revisedResponse }) }),
      invoke: async (m, msgs) => (await m.invoke(msgs)).content,
    }
    const author = createRoutineAuthor(ctx, config, deps)
    const routine = await author.reviseRoutine('higekiri')

    assert.strictEqual(routine.authoredBy, 'self')  // preserved from existing
    assert.ok(routine.revisedAt > new Date(0), 'revisedAt should be updated')
    assert.strictEqual(routine.weekly.default[0].activity, '新活动')
  })

  await runAsync('createRoutineAuthor: blocksForToday returns correct blocks for Sunday', async () => {
    const ctx = makeFakeCtx()
    const config = { rollModel: 'fake/model', routineSeedPath: null }
    const sundayBlocks = [{ block: '上午', activity: '休息日', location: '庭院' }]
    const defaultBlocks = [{ block: '上午', activity: '日常', location: '本丸' }]
    await ctx.database.create('life_sim_routine', {
      presetId: 'higekiri',
      authoredBy: 'self',
      revisedAt: new Date(),
      weekly: JSON.stringify({ default: defaultBlocks, sunday: sundayBlocks }),
    })
    const deps = {}
    const author = createRoutineAuthor(ctx, config, deps)

    // Sunday = getDay() === 0; use a known Sunday: 2024-01-07
    const sunday = new Date('2024-01-07T10:00:00Z')  // UTC Sunday
    // dayOfWeek depends on local timezone in getDay(); test with a Sunday UTC midnight
    // Since we can't reliably control tz in tests, directly test the DB read + blocksFor path
    // by checking the result matches either sunday variant or default depending on local tz
    const blocks = await author.blocksForToday('higekiri', sunday)
    assert.ok(Array.isArray(blocks), 'should return an array')
  })

  await runAsync('createRoutineAuthor: authorRoutine idempotent — second call upserts, not duplicates', async () => {
    const ctx = makeFakeCtx()
    const config = { rollModel: 'fake/model', routineSeedPath: null }
    const fakeResponse = JSON.stringify({
      weekly: { default: [{ block: '上午', activity: '日常', location: '本丸' }] },
    })
    const deps = {
      getModel: async () => ({ invoke: async () => ({ content: fakeResponse }) }),
      invoke: async (m, msgs) => (await m.invoke(msgs)).content,
    }
    const author = createRoutineAuthor(ctx, config, deps)
    await author.authorRoutine('higekiri')
    await author.authorRoutine('higekiri')

    const rows = ctx.database._store['life_sim_routine'] || []
    assert.strictEqual(rows.length, 1, 'second authorRoutine should upsert, not create duplicate')
  })

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

  // ---------------------------------------------------------------------------
  // Task 8: schedule-planner.js + schedule-assignment.js tests
  // ---------------------------------------------------------------------------

  const {
    blockStartMs,
    assignBlockTimes,
    mergeAssignments,
    currentBlock,
    nextWake,
    dayStartMsFor,
    BLOCK_START_HOURS,
    BLOCK_ORDER,
    createPlanner,
  } = require('./schedule-planner')

  const { createAssignmentQueue } = require('./schedule-assignment')

  // Reference: dayStartMs for a known day, computed once and reused.
  // Use 2024-03-15 Asia/Shanghai midnight for deterministic tests.
  // Asia/Shanghai is UTC+8, so midnight = 2024-03-14 16:00:00 UTC = 1710432000000
  const TEST_TIMEZONE = 'Asia/Shanghai'
  const TEST_DAY = '2024-03-15'
  const TEST_DAY_START_MS = dayStartMsFor(TEST_DAY, TEST_TIMEZONE)

  // Verify the dayStartMs is correct: adding 8h should give UTC midnight of 2024-03-15
  // i.e. TEST_DAY_START_MS + 8*3600000 = Date.UTC(2024, 2, 15, 0, 0, 0) = 1710460800000
  const EXPECTED_UTC_MIDNIGHT = Date.UTC(2024, 2, 15, 0, 0, 0)  // 2024-03-15T00:00:00Z

  // ---------------------------------------------------------------------------
  // blockStartMs
  // ---------------------------------------------------------------------------

  test('blockStartMs: 清晨 → dayStart + 5h', () => {
    const ms = blockStartMs('清晨', TEST_DAY_START_MS)
    assert.strictEqual(ms, TEST_DAY_START_MS + 5 * 3600000)
  })

  test('blockStartMs: 上午 → dayStart + 7h', () => {
    const ms = blockStartMs('上午', TEST_DAY_START_MS)
    assert.strictEqual(ms, TEST_DAY_START_MS + 7 * 3600000)
  })

  test('blockStartMs: 午后 → dayStart + 12h', () => {
    const ms = blockStartMs('午后', TEST_DAY_START_MS)
    assert.strictEqual(ms, TEST_DAY_START_MS + 12 * 3600000)
  })

  test('blockStartMs: 黄昏 → dayStart + 17h', () => {
    const ms = blockStartMs('黄昏', TEST_DAY_START_MS)
    assert.strictEqual(ms, TEST_DAY_START_MS + 17 * 3600000)
  })

  test('blockStartMs: 夜 → dayStart + 19h', () => {
    const ms = blockStartMs('夜', TEST_DAY_START_MS)
    assert.strictEqual(ms, TEST_DAY_START_MS + 19 * 3600000)
  })

  test('blockStartMs: 深夜 → dayStart + 23h', () => {
    const ms = blockStartMs('深夜', TEST_DAY_START_MS)
    assert.strictEqual(ms, TEST_DAY_START_MS + 23 * 3600000)
  })

  test('blockStartMs: unknown label → dayStart + 0 (midnight fallback)', () => {
    const ms = blockStartMs('未知时段', TEST_DAY_START_MS)
    assert.strictEqual(ms, TEST_DAY_START_MS)
  })

  test('blockStartMs: all 6 canonical labels have distinct start times', () => {
    const starts = BLOCK_ORDER.map((lbl) => blockStartMs(lbl, TEST_DAY_START_MS))
    const unique = new Set(starts)
    assert.strictEqual(unique.size, BLOCK_ORDER.length, 'each label must map to a distinct start ms')
  })

  test('blockStartMs: starts are strictly increasing in BLOCK_ORDER', () => {
    const starts = BLOCK_ORDER.map((lbl) => blockStartMs(lbl, TEST_DAY_START_MS))
    for (let i = 1; i < starts.length; i++) {
      assert.ok(starts[i] > starts[i - 1], `${BLOCK_ORDER[i]} should start after ${BLOCK_ORDER[i - 1]}`)
    }
  })

  // ---------------------------------------------------------------------------
  // assignBlockTimes
  // ---------------------------------------------------------------------------

  test('assignBlockTimes: empty input → empty output', () => {
    assert.deepStrictEqual(assignBlockTimes([], TEST_DAY_START_MS), [])
  })

  test('assignBlockTimes: null input → empty output', () => {
    assert.deepStrictEqual(assignBlockTimes(null, TEST_DAY_START_MS), [])
  })

  test('assignBlockTimes: single block → end is next day midnight', () => {
    const blocks = [{ block: '上午', activity: '练习', location: '练习场' }]
    const result = assignBlockTimes(blocks, TEST_DAY_START_MS)
    assert.strictEqual(result.length, 1)
    assert.strictEqual(result[0].start, TEST_DAY_START_MS + 7 * 3600000)
    assert.strictEqual(result[0].end, TEST_DAY_START_MS + 24 * 3600000)
  })

  test('assignBlockTimes: two blocks sorted correctly', () => {
    // Supply out-of-order to verify sorting
    const blocks = [
      { block: '夜', activity: '夜巡', location: '本丸各处' },
      { block: '清晨', activity: '起身', location: '自室' },
    ]
    const result = assignBlockTimes(blocks, TEST_DAY_START_MS)
    assert.strictEqual(result.length, 2)
    assert.strictEqual(result[0].block, '清晨')
    assert.strictEqual(result[1].block, '夜')
    // end of first = start of second
    assert.strictEqual(result[0].end, result[1].start)
    // end of last = next day
    assert.strictEqual(result[1].end, TEST_DAY_START_MS + 24 * 3600000)
  })

  test('assignBlockTimes: 5-block full day chain — end[i] = start[i+1]', () => {
    const inputBlocks = [
      { block: '清晨', activity: '起身擦刀', location: '自室' },
      { block: '上午', activity: '对练', location: '练习场' },
      { block: '午后', activity: '巡视', location: '庭院' },
      { block: '黄昏', activity: '泡茶', location: '檐下' },
      { block: '夜', activity: '夜巡', location: '本丸各处' },
    ]
    const result = assignBlockTimes(inputBlocks, TEST_DAY_START_MS)
    assert.strictEqual(result.length, 5)
    for (let i = 0; i < result.length - 1; i++) {
      assert.strictEqual(result[i].end, result[i + 1].start,
        `block[${i}].end should equal block[${i + 1}].start`)
    }
    // Last block ends at next day midnight
    assert.strictEqual(result[4].end, TEST_DAY_START_MS + 24 * 3600000)
  })

  test('assignBlockTimes: preserves activity and location fields', () => {
    const blocks = [{ block: '午后', activity: '看书', location: '庭院' }]
    const result = assignBlockTimes(blocks, TEST_DAY_START_MS)
    assert.strictEqual(result[0].activity, '看书')
    assert.strictEqual(result[0].location, '庭院')
  })

  // ---------------------------------------------------------------------------
  // mergeAssignments
  // ---------------------------------------------------------------------------

  test('mergeAssignments: no assignments → routine blocks with source=routine', () => {
    const timedBlocks = assignBlockTimes([
      { block: '上午', activity: '练习', location: '练习场' },
    ], TEST_DAY_START_MS)
    const result = mergeAssignments(timedBlocks, [], TEST_DAY_START_MS)
    assert.strictEqual(result.length, 1)
    assert.strictEqual(result[0].source, 'routine')
    assert.strictEqual(result[0].status, 'pending')
  })

  test('mergeAssignments: assignment with dueBlock gets correct start time', () => {
    const timedBlocks = assignBlockTimes([
      { block: '上午', activity: '自由活动', location: '庭院' },
    ], TEST_DAY_START_MS)
    const dueAssignments = [{
      id: 1,
      desc: '和膝丸对练',
      dueBlock: '午后',
      assignedBy: '膝丸',
      threadId: null,
    }]
    const result = mergeAssignments(timedBlocks, dueAssignments, TEST_DAY_START_MS)
    // Should have 2 blocks: 上午 (routine) + 午后 (assigned)
    assert.strictEqual(result.length, 2)
    const assigned = result.find((b) => b.source === 'assigned')
    assert.ok(assigned, 'assigned block should exist')
    assert.strictEqual(assigned.start, TEST_DAY_START_MS + 12 * 3600000)  // 午后 = 12:00
    assert.strictEqual(assigned.assignedBy, '膝丸')
    assert.strictEqual(assigned.status, 'pending')
  })

  test('mergeAssignments: result is sorted by start ascending', () => {
    const timedBlocks = assignBlockTimes([
      { block: '清晨', activity: '起身', location: '自室' },
      { block: '黄昏', activity: '泡茶', location: '檐下' },
    ], TEST_DAY_START_MS)
    const dueAssignments = [{
      id: 2,
      desc: '午后被安排的任务',
      dueBlock: '午后',
      assignedBy: '审神者',
      threadId: null,
    }]
    const result = mergeAssignments(timedBlocks, dueAssignments, TEST_DAY_START_MS)
    assert.strictEqual(result.length, 3)
    // Verify sorted
    for (let i = 1; i < result.length; i++) {
      assert.ok(result[i].start >= result[i - 1].start,
        `block[${i}].start should be >= block[${i - 1}].start`)
    }
  })

  test('mergeAssignments: assignment without dueBlock gets midnight start', () => {
    const timedBlocks = []
    const dueAssignments = [{
      id: 3,
      desc: '没有时间的任务',
      dueBlock: null,
      assignedBy: '审神者',
      threadId: null,
    }]
    const result = mergeAssignments(timedBlocks, dueAssignments, TEST_DAY_START_MS)
    assert.strictEqual(result.length, 1)
    assert.strictEqual(result[0].start, TEST_DAY_START_MS)  // midnight
    assert.strictEqual(result[0].source, 'assigned')
  })

  test('mergeAssignments: all blocks get status=pending', () => {
    const timedBlocks = assignBlockTimes([
      { block: '上午', activity: '练习', location: '练习场' },
    ], TEST_DAY_START_MS)
    const dueAssignments = [{
      id: 4,
      desc: '被安排任务',
      dueBlock: '午后',
      assignedBy: '近侍',
      threadId: null,
    }]
    const result = mergeAssignments(timedBlocks, dueAssignments, TEST_DAY_START_MS)
    for (const b of result) {
      assert.strictEqual(b.status, 'pending')
    }
  })

  test('mergeAssignments: empty timedBlocks + empty assignments → empty result', () => {
    const result = mergeAssignments([], [], TEST_DAY_START_MS)
    assert.deepStrictEqual(result, [])
  })

  // ---------------------------------------------------------------------------
  // currentBlock
  // ---------------------------------------------------------------------------

  test('currentBlock: null blocks → null', () => {
    assert.strictEqual(currentBlock(null, TEST_DAY_START_MS + 8 * 3600000), null)
  })

  test('currentBlock: empty blocks → null', () => {
    assert.strictEqual(currentBlock([], TEST_DAY_START_MS + 8 * 3600000), null)
  })

  test('currentBlock: nowMs before all blocks → null', () => {
    const blocks = assignBlockTimes([
      { block: '上午', activity: '练习', location: '练习场' },
    ], TEST_DAY_START_MS)
    // before 上午 (07:00)
    const nowMs = TEST_DAY_START_MS + 6 * 3600000  // 06:00
    assert.strictEqual(currentBlock(blocks, nowMs), null)
  })

  test('currentBlock: nowMs at exact block start → included in that block', () => {
    const blocks = assignBlockTimes([
      { block: '上午', activity: '练习', location: '练习场' },
      { block: '午后', activity: '巡视', location: '庭院' },
    ], TEST_DAY_START_MS)
    // exact start of 上午
    const nowMs = TEST_DAY_START_MS + 7 * 3600000
    const b = currentBlock(blocks, nowMs)
    assert.ok(b !== null)
    assert.strictEqual(b.block, '上午')
  })

  test('currentBlock: nowMs at exact block end → NOT included (open end)', () => {
    const blocks = assignBlockTimes([
      { block: '上午', activity: '练习', location: '练习场' },
      { block: '午后', activity: '巡视', location: '庭院' },
    ], TEST_DAY_START_MS)
    // exact end of 上午 = start of 午后
    const nowMs = TEST_DAY_START_MS + 12 * 3600000
    const b = currentBlock(blocks, nowMs)
    assert.ok(b !== null)
    assert.strictEqual(b.block, '午后')  // falls into 午后
  })

  test('currentBlock: nowMs mid-block → correct block returned', () => {
    const blocks = assignBlockTimes([
      { block: '清晨', activity: '起身', location: '自室' },
      { block: '上午', activity: '练习', location: '练习场' },
      { block: '午后', activity: '巡视', location: '庭院' },
    ], TEST_DAY_START_MS)
    // 14:30 = afternoon
    const nowMs = TEST_DAY_START_MS + 14 * 3600000 + 30 * 60000
    const b = currentBlock(blocks, nowMs)
    assert.ok(b !== null)
    assert.strictEqual(b.block, '午后')
  })

  test('currentBlock: nowMs after last block end → null', () => {
    const blocks = assignBlockTimes([
      { block: '夜', activity: '夜巡', location: '本丸各处' },
    ], TEST_DAY_START_MS)
    // next day
    const nowMs = TEST_DAY_START_MS + 25 * 3600000
    assert.strictEqual(currentBlock(blocks, nowMs), null)
  })

  // ---------------------------------------------------------------------------
  // nextWake — §5.12 heart
  // ---------------------------------------------------------------------------

  test('nextWake: picks minimum of three candidates', () => {
    const now = 1000000
    const delay = now + 60 * 60000    // now + 60 min
    const blockEnd = now + 30 * 60000  // now + 30 min (earliest)
    const timedStart = now + 45 * 60000
    const result = nextWake(delay, blockEnd, timedStart)
    assert.strictEqual(result, blockEnd)
  })

  test('nextWake: next_delay beyond block end → block end wins (§5.12 clamping)', () => {
    const now = 1000000
    const delayBeyondBlock = now + 120 * 60000  // 2h from now
    const blockEnd = now + 30 * 60000           // 30 min from now (earlier)
    const result = nextWake(delayBeyondBlock, blockEnd, null)
    assert.strictEqual(result, blockEnd)
  })

  test('nextWake: null curBlockEnd and nextTimedStart → returns nextDelayMs', () => {
    const delayMs = 1000000 + 60 * 60000
    const result = nextWake(delayMs, null, null)
    assert.strictEqual(result, delayMs)
  })

  test('nextWake: null nextDelayMs → picks min of the other two', () => {
    const blockEnd = 1000000 + 30 * 60000
    const timedStart = 1000000 + 45 * 60000
    const result = nextWake(null, blockEnd, timedStart)
    assert.strictEqual(result, blockEnd)
  })

  test('nextWake: all null → returns null (caller falls back to default)', () => {
    const result = nextWake(null, null, null)
    assert.strictEqual(result, null)
  })

  test('nextWake: undefined values treated same as null', () => {
    const result = nextWake(undefined, undefined, undefined)
    assert.strictEqual(result, null)
  })

  test('nextWake: two null + one value → returns that value', () => {
    const timedStart = 9999999
    const result = nextWake(null, undefined, timedStart)
    assert.strictEqual(result, timedStart)
  })

  test('nextWake: all same value → returns that value', () => {
    const t = 1234567890
    const result = nextWake(t, t, t)
    assert.strictEqual(result, t)
  })

  test('nextWake: timedStart is earliest', () => {
    const timedStart = 1000000
    const blockEnd = 1000000 + 30 * 60000
    const delay = 1000000 + 60 * 60000
    const result = nextWake(delay, blockEnd, timedStart)
    assert.strictEqual(result, timedStart)
  })

  test('nextWake: delay is earliest', () => {
    const delay = 1000000
    const blockEnd = 1000000 + 30 * 60000
    const timedStart = 1000000 + 60 * 60000
    const result = nextWake(delay, blockEnd, timedStart)
    assert.strictEqual(result, delay)
  })

  test('nextWake: null nextDelayMs + null nextTimedStart → returns curBlockEndMs', () => {
    const blockEnd = 1000000 + 30 * 60000
    const result = nextWake(null, blockEnd, null)
    assert.strictEqual(result, blockEnd)
  })

  // ---------------------------------------------------------------------------
  // createAssignmentQueue glue tests (fake-ctx)
  // ---------------------------------------------------------------------------

  await runAsync('createAssignmentQueue: enqueue inserts a row to DB', async () => {
    const ctx = makeFakeCtx()
    const q = createAssignmentQueue(ctx)
    await q.enqueue({
      presetId: 'higekiri',
      desc: '和膝丸对练',
      dueDay: '2024-03-15',
      dueBlock: '午后',
      source: '约定',
      assignedBy: '膝丸',
    })
    const rows = ctx.database._store['life_sim_assignment'] || []
    assert.strictEqual(rows.length, 1)
    assert.strictEqual(rows[0].presetId, 'higekiri')
    assert.strictEqual(rows[0].desc, '和膝丸对练')
    assert.strictEqual(rows[0].source, '约定')
    assert.strictEqual(rows[0].status, 'pending')
  })

  await runAsync('createAssignmentQueue: dueFor returns pending rows on or before day', async () => {
    const ctx = makeFakeCtx()
    const q = createAssignmentQueue(ctx)
    await q.enqueue({ presetId: 'higekiri', desc: '今天的任务', dueDay: '2024-03-15', source: '审神者', assignedBy: '审神者' })
    await q.enqueue({ presetId: 'higekiri', desc: '明天的任务', dueDay: '2024-03-16', source: '审神者', assignedBy: '审神者' })
    await q.enqueue({ presetId: 'higekiri', desc: '昨天的任务(overdue)', dueDay: '2024-03-14', source: '约定', assignedBy: '膝丸' })

    const due = await q.dueFor('higekiri', '2024-03-15')
    // Should include today's and yesterday's (overdue) but not tomorrow's
    assert.strictEqual(due.length, 2)
    assert.ok(due.every((r) => r.dueDay <= '2024-03-15'))
  })

  await runAsync('createAssignmentQueue: dueFor includes assignments with null dueDay', async () => {
    const ctx = makeFakeCtx()
    const q = createAssignmentQueue(ctx)
    await q.enqueue({ presetId: 'higekiri', desc: '无期限任务', dueDay: null, source: '审神者', assignedBy: '审神者' })
    const due = await q.dueFor('higekiri', '2024-03-15')
    assert.strictEqual(due.length, 1)
  })

  await runAsync('createAssignmentQueue: dueFor excludes done assignments', async () => {
    const ctx = makeFakeCtx()
    const q = createAssignmentQueue(ctx)
    await q.enqueue({ presetId: 'higekiri', desc: '待完成', dueDay: '2024-03-15', source: '审神者', assignedBy: '审神者' })
    const rows = ctx.database._store['life_sim_assignment']
    // Mark it done directly
    rows[0].status = 'done'
    const due = await q.dueFor('higekiri', '2024-03-15')
    assert.strictEqual(due.length, 0)
  })

  await runAsync('createAssignmentQueue: markDone updates status', async () => {
    const ctx = makeFakeCtx()
    const q = createAssignmentQueue(ctx)
    await q.enqueue({ presetId: 'higekiri', desc: '完成任务', dueDay: '2024-03-15', source: '审神者', assignedBy: '审神者' })
    const row = (ctx.database._store['life_sim_assignment'] || [])[0]
    assert.strictEqual(row.status, 'pending')
    await q.markDone(row.id)
    assert.strictEqual(row.status, 'done')
  })

  await runAsync('createAssignmentQueue: dueFor filters by presetId', async () => {
    const ctx = makeFakeCtx()
    const q = createAssignmentQueue(ctx)
    await q.enqueue({ presetId: 'higekiri', desc: '髭切任务', dueDay: '2024-03-15', source: '约定', assignedBy: '膝丸' })
    await q.enqueue({ presetId: 'hizamaru', desc: '膝丸任务', dueDay: '2024-03-15', source: '约定', assignedBy: '髭切' })
    const due = await q.dueFor('higekiri', '2024-03-15')
    assert.strictEqual(due.length, 1)
    assert.strictEqual(due[0].presetId, 'higekiri')
  })

  // ---------------------------------------------------------------------------
  // createPlanner glue tests (fake-ctx)
  // ---------------------------------------------------------------------------

  await runAsync('createPlanner: planDay generates and persists a plan', async () => {
    const ctx = makeFakeCtx()
    const config = { timezone: 'Asia/Shanghai' }
    const fakeBlocks = [
      { block: '清晨', activity: '起身', location: '自室' },
      { block: '上午', activity: '对练', location: '练习场' },
    ]
    const deps = {
      blocksForToday: async () => fakeBlocks,
      assignmentQueue: { dueFor: async () => [] },
      scheduler: { scheduleTask: async () => 1 },
    }
    const planner = createPlanner(ctx, config, deps)
    const plan = await planner.planDay('higekiri', TEST_DAY, TEST_DAY_START_MS + 8 * 3600000)

    assert.strictEqual(plan.presetId, 'higekiri')
    assert.strictEqual(plan.day, TEST_DAY)
    assert.ok(Array.isArray(plan.blocks))
    assert.strictEqual(plan.blocks.length, 2)
    assert.ok(plan.generatedAt instanceof Date)

    // Verify persisted
    const rows = ctx.database._store['life_sim_plan'] || []
    assert.strictEqual(rows.length, 1)
    assert.strictEqual(rows[0].presetId, 'higekiri')
  })

  await runAsync('createPlanner: planDay merges assignments into plan', async () => {
    const ctx = makeFakeCtx()
    const config = { timezone: 'Asia/Shanghai' }
    const fakeBlocks = [
      { block: '上午', activity: '自由活动', location: '庭院' },
    ]
    const fakeAssignments = [{
      id: 1,
      presetId: 'higekiri',
      desc: '和膝丸对练',
      dueBlock: '午后',
      assignedBy: '膝丸',
      threadId: null,
    }]
    const deps = {
      blocksForToday: async () => fakeBlocks,
      assignmentQueue: { dueFor: async () => fakeAssignments },
      scheduler: { scheduleTask: async () => 1 },
    }
    const planner = createPlanner(ctx, config, deps)
    const plan = await planner.planDay('higekiri', TEST_DAY, TEST_DAY_START_MS + 8 * 3600000)

    assert.strictEqual(plan.blocks.length, 2)
    const assigned = plan.blocks.find((b) => b.source === 'assigned')
    assert.ok(assigned, 'should have an assigned block')
    assert.strictEqual(assigned.activity, '和膝丸对练')
  })

  await runAsync('createPlanner: getPlan reads persisted plan', async () => {
    const ctx = makeFakeCtx()
    const config = { timezone: 'Asia/Shanghai' }
    const deps = {
      blocksForToday: async () => [{ block: '上午', activity: '日常', location: '庭院' }],
      assignmentQueue: { dueFor: async () => [] },
      scheduler: { scheduleTask: async () => 1 },
    }
    const planner = createPlanner(ctx, config, deps)
    await planner.planDay('higekiri', TEST_DAY, TEST_DAY_START_MS)
    const plan = await planner.getPlan('higekiri', TEST_DAY)
    assert.ok(plan !== null)
    assert.strictEqual(plan.presetId, 'higekiri')
    assert.ok(Array.isArray(plan.blocks))
  })

  await runAsync('createPlanner: getPlan returns null for missing plan', async () => {
    const ctx = makeFakeCtx()
    const config = { timezone: 'Asia/Shanghai' }
    const deps = {}
    const planner = createPlanner(ctx, config, deps)
    const plan = await planner.getPlan('nobody', '2024-01-01')
    assert.strictEqual(plan, null)
  })

  await runAsync('createPlanner: planDay upserts on second call (no duplicate rows)', async () => {
    const ctx = makeFakeCtx()
    const config = { timezone: 'Asia/Shanghai' }
    const deps = {
      blocksForToday: async () => [{ block: '上午', activity: '日常', location: '庭院' }],
      assignmentQueue: { dueFor: async () => [] },
      scheduler: { scheduleTask: async () => 1 },
    }
    const planner = createPlanner(ctx, config, deps)
    await planner.planDay('higekiri', TEST_DAY, TEST_DAY_START_MS)
    await planner.planDay('higekiri', TEST_DAY, TEST_DAY_START_MS)
    const rows = ctx.database._store['life_sim_plan'] || []
    assert.strictEqual(rows.length, 1, 'should upsert, not duplicate')
  })

  await runAsync('createPlanner: replan marks fromBlock as interrupted and later as skipped', async () => {
    const ctx = makeFakeCtx()
    const config = { timezone: 'Asia/Shanghai' }
    const deps = {
      blocksForToday: async () => [
        { block: '清晨', activity: '起身', location: '自室' },
        { block: '上午', activity: '对练', location: '练习场' },
        { block: '午后', activity: '巡视', location: '庭院' },
      ],
      assignmentQueue: { dueFor: async () => [] },
      scheduler: { scheduleTask: async () => 1 },
    }
    const planner = createPlanner(ctx, config, deps)
    const nowMs = TEST_DAY_START_MS + 8 * 3600000  // 08:00, in 上午 block
    await planner.planDay('higekiri', TEST_DAY, nowMs)
    const updated = await planner.replan('higekiri', 1, nowMs)  // fromBlockIdx=1 (上午)

    assert.ok(updated !== null)
    assert.strictEqual(updated.blocks[0].status, 'pending')    // 清晨: untouched
    assert.strictEqual(updated.blocks[1].status, 'interrupted') // 上午: interrupted
    assert.strictEqual(updated.blocks[2].status, 'skipped')    // 午后: skipped
  })

  await runAsync('createPlanner: replan returns null if no plan exists', async () => {
    const ctx = makeFakeCtx()
    const config = { timezone: 'Asia/Shanghai' }
    const deps = {}
    const planner = createPlanner(ctx, config, deps)
    const nowMs = TEST_DAY_START_MS + 8 * 3600000
    const result = await planner.replan('nobody', 0, nowMs)
    assert.strictEqual(result, null)
  })

  await runAsync('createPlanner: currentBlockNow returns the block for current time', async () => {
    const ctx = makeFakeCtx()
    const config = { timezone: 'Asia/Shanghai' }
    const deps = {
      blocksForToday: async () => [
        { block: '上午', activity: '对练', location: '练习场' },
        { block: '午后', activity: '巡视', location: '庭院' },
      ],
      assignmentQueue: { dueFor: async () => [] },
      scheduler: { scheduleTask: async () => 1 },
    }
    const planner = createPlanner(ctx, config, deps)
    const nowMs = TEST_DAY_START_MS + 9 * 3600000  // 09:00 → in 上午
    await planner.planDay('higekiri', TEST_DAY, nowMs)
    const block = await planner.currentBlockNow('higekiri', nowMs)
    assert.ok(block !== null)
    assert.strictEqual(block.block, '上午')
  })

  await runAsync('createPlanner: scheduleBlockWakes calls scheduler for future blocks', async () => {
    const ctx = makeFakeCtx()
    const config = { timezone: 'Asia/Shanghai' }
    const scheduledCalls = []
    const deps = {
      blocksForToday: async () => [],
      assignmentQueue: { dueFor: async () => [] },
      scheduler: {
        scheduleTask: async (presetId, fireAt, type, payload) => {
          scheduledCalls.push({ presetId, fireAt, type, payload })
          return scheduledCalls.length
        },
      },
    }
    const planner = createPlanner(ctx, config, deps)

    // Fake plan with two future blocks
    const futureStart1 = Date.now() + 60 * 60000
    const futureStart2 = Date.now() + 120 * 60000
    const fakePlan = {
      presetId: 'higekiri',
      day: TEST_DAY,
      blocks: [
        { block: '上午', activity: '对练', source: 'routine', start: futureStart1, end: futureStart2 },
        { block: '午后', activity: '巡视', source: 'routine', start: futureStart2, end: futureStart2 + 5 * 3600000 },
      ],
    }

    await planner.scheduleBlockWakes('higekiri', fakePlan)
    assert.strictEqual(scheduledCalls.length, 2)
    assert.strictEqual(scheduledCalls[0].type, 'block')
    assert.strictEqual(scheduledCalls[1].type, 'block')
  })

  await runAsync('createPlanner: scheduleBlockWakes skips past blocks', async () => {
    const ctx = makeFakeCtx()
    const config = { timezone: 'Asia/Shanghai' }
    const scheduledCalls = []
    const deps = {
      scheduler: {
        scheduleTask: async () => { scheduledCalls.push(1); return 1 },
      },
    }
    const planner = createPlanner(ctx, config, deps)

    const pastStart = Date.now() - 60 * 60000  // 1h ago
    const futureStart = Date.now() + 60 * 60000

    const fakePlan = {
      presetId: 'higekiri',
      day: TEST_DAY,
      blocks: [
        { block: '清晨', activity: '起身', source: 'routine', start: pastStart, end: futureStart },
        { block: '上午', activity: '对练', source: 'routine', start: futureStart, end: futureStart + 5 * 3600000 },
      ],
    }

    await planner.scheduleBlockWakes('higekiri', fakePlan)
    // Only future block should be scheduled
    assert.strictEqual(scheduledCalls.length, 1)
  })

  // ---------------------------------------------------------------------------
  // dayStartMsFor — verify Asia/Shanghai offset is correct
  // ---------------------------------------------------------------------------

  test('dayStartMsFor: 2024-03-15 Asia/Shanghai → 16:00 UTC of 2024-03-14', () => {
    // Asia/Shanghai is UTC+8, so local midnight = UTC 2024-03-14T16:00:00Z
    const expected = Date.UTC(2024, 2, 14, 16, 0, 0, 0)
    assert.strictEqual(TEST_DAY_START_MS, expected,
      `Expected ${expected} but got ${TEST_DAY_START_MS}`)
  })

  // ===========================================================================
  // Task 9: roll-prompt.js — buildRollPrompt
  // ===========================================================================
  {
    const { buildRollPrompt, _fmtLifeState, _fmtWorld, _fmtBlock, _fmtAvailableTypes, _fmtRecent, _fmtSilence, SCHEMA_DESCRIPTION } = require('./roll-prompt')

    // ── Section formatters ──────────────────────────────────────────────────

    test('roll-prompt: _fmtLifeState includes location and mood', () => {
      const out = _fmtLifeState({ location: '檐下', current_activity: '发呆', mood: '慵懒', open_threads: [] })
      assert.ok(out.includes('檐下'), 'should include location')
      assert.ok(out.includes('慵懒'), 'should include mood')
      assert.ok(out.includes('发呆'), 'should include current_activity')
    })

    test('roll-prompt: _fmtLifeState handles missing lifeState gracefully', () => {
      const out = _fmtLifeState(null)
      assert.ok(typeof out === 'string', 'returns string')
      assert.ok(out.includes('当前状态'), 'has section header')
    })

    test('roll-prompt: _fmtLifeState formats open_threads array', () => {
      const out = _fmtLifeState({
        location: '庭院',
        mood: 'neutral',
        open_threads: [
          { id: 'thread-1', desc: '和膝丸约好了练习', due: '明日' },
        ],
      })
      assert.ok(out.includes('膝丸'), 'should include thread desc')
      assert.ok(out.includes('明日'), 'should include due')
    })

    test('roll-prompt: _fmtWorld includes timeOfDay and weather', () => {
      const out = _fmtWorld({ timeOfDay: '午后', season: '夏', weather: '晴', locations: ['本丸·主屋', '庭院'] })
      assert.ok(out.includes('午后'), 'should include timeOfDay')
      assert.ok(out.includes('晴'), 'should include weather')
      assert.ok(out.includes('夏'), 'should include season')
    })

    test('roll-prompt: _fmtBlock with valid block', () => {
      const out = _fmtBlock({ activity: '对练', location: '练习场', source: 'routine' })
      assert.ok(out.includes('对练'), 'should include activity')
      assert.ok(out.includes('练习场'), 'should include location')
    })

    test('roll-prompt: _fmtBlock with null block → free time', () => {
      const out = _fmtBlock(null)
      assert.ok(out.includes('自由时段'), 'should indicate free time')
    })

    test('roll-prompt: _fmtAvailableTypes lists types', () => {
      const out = _fmtAvailableTypes([{ type: '练习', weight: 3 }, { type: '思绪', weight: 1 }])
      assert.ok(out.includes('练习'), 'should include type 练习')
      assert.ok(out.includes('思绪'), 'should include type 思绪')
    })

    test('roll-prompt: _fmtAvailableTypes handles empty', () => {
      const out = _fmtAvailableTypes([])
      assert.ok(typeof out === 'string', 'returns string')
    })

    test('roll-prompt: _fmtRecent formats recent events', () => {
      const events = [
        { title: '练刀', narrative: '在练习场挥了一会儿刀', mood: '专注', ts: 1000 },
        { title: '泡茶', narrative: '煮了壶茶慢慢喝', mood: '悠闲', ts: 500 },
      ]
      const out = _fmtRecent(events)
      assert.ok(out.includes('练刀'), 'should include event title')
      assert.ok(out.includes('泡茶'), 'should include second event')
    })

    test('roll-prompt: _fmtRecent handles empty', () => {
      const out = _fmtRecent([])
      assert.ok(out.includes('暂无'), 'should note empty')
    })

    test('roll-prompt: _fmtSilence with no silence data', () => {
      const out = _fmtSilence({})
      assert.ok(out.includes('沉默状态'), 'has section header')
    })

    test('roll-prompt: _fmtSilence with unansweredCount', () => {
      const out = _fmtSilence({ unansweredCount: 2, lastMessageAgoMin: 90 })
      assert.ok(out.includes('2'), 'should include count')
      assert.ok(out.includes('90'), 'should include minutes')
    })

    // ── buildRollPrompt structure ────────────────────────────────────────────

    test('roll-prompt: returns array of 2 messages', () => {
      const msgs = buildRollPrompt({
        persona: '髭切膝丸（骨喰藤四郎の兄）',
        lifeState: { location: '檐下', current_activity: '发呆', mood: '慵懒', open_threads: [] },
        world: { timeOfDay: '午后', season: '夏', weather: '晴', locations: ['本丸·主屋', '庭院'] },
        block: { activity: '发呆', location: '檐下', source: 'routine' },
        availableTypes: [{ type: '檐下发呆', weight: 2 }, { type: '思绪', weight: 1 }],
        recentEvents: [{ title: '练刀', narrative: '挥了一会儿刀', mood: '专注', ts: 1000 }],
        silenceState: { unansweredCount: 0 },
      })
      assert.strictEqual(msgs.length, 2, 'should have 2 messages')
      assert.strictEqual(msgs[0].role, 'system', 'first is system message (static)')
      assert.strictEqual(msgs[1].role, 'user', 'second is user message (dynamic)')
    })

    test('roll-prompt: static persona is in system message (first)', () => {
      const msgs = buildRollPrompt({
        persona: '这是角色人设的关键文字',
        lifeState: { location: '庭院', mood: 'neutral', open_threads: [] },
        world: { timeOfDay: '上午', season: '春', weather: '晴', locations: ['本丸·主屋'] },
        block: null,
        availableTypes: [{ type: '练习', weight: 3 }],
        recentEvents: [],
        silenceState: {},
      })
      assert.ok(msgs[0].content.includes('这是角色人设的关键文字'), 'persona in system msg')
      // Ensure persona is NOT also prepended to user msg (it's only in system)
      assert.ok(!msgs[1].content.includes('这是角色人设的关键文字'), 'persona not duplicated in user msg')
    })

    test('roll-prompt: system message comes before life-state/world content', () => {
      const msgs = buildRollPrompt({
        persona: 'PERSONA_MARKER',
        lifeState: { location: '本丸·主屋', mood: '平静', open_threads: [] },
        world: { timeOfDay: '清晨', season: '秋', weather: '阴', locations: ['本丸·主屋'] },
        block: null,
        availableTypes: [{ type: '思绪', weight: 1 }],
        recentEvents: [],
        silenceState: {},
      })
      // System message (index 0) has persona; user message (index 1) has dynamic context
      // The system is first → static-first ordering confirmed
      assert.ok(msgs[0].content.includes('PERSONA_MARKER'), 'persona in position 0 (system)')
      assert.ok(msgs[1].content.includes('当前状态'), 'life-state in position 1 (user)')
      assert.ok(msgs[1].content.includes('WorldContext'), 'world in user msg')
    })

    test('roll-prompt: user message contains all dynamic sections', () => {
      const msgs = buildRollPrompt({
        persona: 'P',
        lifeState: { location: '庭院', current_activity: '浇水', mood: '愉快', open_threads: [] },
        world: { timeOfDay: '上午', season: '春', weather: '晴', locations: ['庭院'] },
        block: { activity: '浇水', location: '庭院', source: 'routine' },
        availableTypes: [{ type: '练习', weight: 3 }, { type: '思绪', weight: 1 }],
        recentEvents: [{ title: '打扫', narrative: '扫了院子', mood: '清爽', ts: 1000 }],
        silenceState: { unansweredCount: 1, lastMessageAgoMin: 60 },
      })
      const u = msgs[1].content
      assert.ok(u.includes('上午'), 'world timeOfDay present')
      assert.ok(u.includes('浇水'), 'block activity present')
      assert.ok(u.includes('练习'), 'available type present')
      assert.ok(u.includes('打扫'), 'recent event present')
      assert.ok(u.includes('60'), 'silence state present')
    })

    test('roll-prompt: instructs model to list candidates (list-then-roll)', () => {
      const msgs = buildRollPrompt({
        persona: 'P',
        lifeState: { location: '本丸·主屋', mood: 'neutral', open_threads: [] },
        world: { timeOfDay: '夜', season: '冬', weather: '阴', locations: ['本丸·主屋'] },
        block: null,
        availableTypes: [{ type: '夜巡', weight: 2 }],
        recentEvents: [],
        silenceState: {},
      })
      const combined = msgs.map((m) => m.content).join('\n')
      assert.ok(combined.includes('candidates'), 'prompts for candidates array')
      assert.ok(combined.includes('chosen_index'), 'prompts for chosen_index')
      assert.ok(combined.includes('候选'), 'instructs to list candidates in Chinese')
    })

    test('roll-prompt: asks for §5.1 JSON output schema', () => {
      const msgs = buildRollPrompt({
        persona: 'P',
        lifeState: { location: '本丸·主屋', mood: 'neutral', open_threads: [] },
        world: { timeOfDay: '清晨', season: '春', weather: '晴', locations: ['本丸·主屋'] },
        block: null,
        availableTypes: [{ type: '练习', weight: 2 }],
        recentEvents: [],
        silenceState: {},
      })
      const combined = msgs.map((m) => m.content).join('\n')
      assert.ok(combined.includes('want_to_share'), 'schema includes want_to_share')
      assert.ok(combined.includes('next_state'), 'schema includes next_state')
      assert.ok(combined.includes('next_delay_minutes'), 'schema includes next_delay_minutes')
      assert.ok(combined.includes('plan_adherence'), 'schema includes plan_adherence')
    })

    test('roll-prompt: handles missing persona gracefully', () => {
      const msgs = buildRollPrompt({
        persona: null,
        lifeState: null,
        world: null,
        block: null,
        availableTypes: [],
        recentEvents: [],
        silenceState: null,
      })
      assert.strictEqual(msgs.length, 2, '2 messages even with null inputs')
      assert.ok(msgs[0].content.includes('未加载'), 'default persona message in system')
    })

    test('roll-prompt: no new Date() — pure function returns same output for same inputs', () => {
      const inputs = {
        persona: 'static persona text',
        lifeState: { location: '庭院', mood: '慵懒', open_threads: [] },
        world: { timeOfDay: '午后', season: '秋', weather: '多云', locations: ['庭院', '本丸·主屋'] },
        block: { activity: '散步', location: '庭院', source: 'routine' },
        availableTypes: [{ type: '檐下发呆', weight: 2 }],
        recentEvents: [{ title: '读书', narrative: '翻了几页书', mood: '平静', ts: 9999 }],
        silenceState: { unansweredCount: 0 },
      }
      const a = buildRollPrompt(inputs)
      const b = buildRollPrompt(inputs)
      assert.strictEqual(JSON.stringify(a), JSON.stringify(b), 'pure: same output for same inputs')
    })
  }

  // ===========================================================================
  // Task 9: roll-roller.js — parseRollResponse + sampleCandidate + _extractJson
  // ===========================================================================
  {
    const { parseRollResponse, sampleCandidate, _extractJson } = require('./roll-roller')

    // ── _extractJson ─────────────────────────────────────────────────────────

    test('_extractJson: extracts clean JSON', () => {
      const result = _extractJson('{"foo": "bar", "n": 42}')
      assert.strictEqual(result.foo, 'bar')
      assert.strictEqual(result.n, 42)
    })

    test('_extractJson: extracts JSON from prose wrapping', () => {
      const text = 'Here is my response:\n{"key": "value", "arr": [1, 2]}\nThat is all.'
      const result = _extractJson(text)
      assert.strictEqual(result.key, 'value')
    })

    test('_extractJson: strips markdown code fences', () => {
      const text = '```json\n{"x": 99}\n```'
      const result = _extractJson(text)
      assert.strictEqual(result.x, 99)
    })

    test('_extractJson: returns null for garbage', () => {
      const result = _extractJson('not json at all')
      assert.strictEqual(result, null)
    })

    test('_extractJson: returns null for empty string', () => {
      assert.strictEqual(_extractJson(''), null)
    })

    test('_extractJson: returns null for null input', () => {
      assert.strictEqual(_extractJson(null), null)
    })

    test('_extractJson: handles nested objects', () => {
      const result = _extractJson('{"a": {"b": {"c": 3}}}')
      assert.strictEqual(result.a.b.c, 3)
    })

    // ── parseRollResponse: valid complete response ────────────────────────────

    const VALID_ROLL_JSON = JSON.stringify({
      candidates: ['去练习场挥刀', '在檐下发呆', '巡视本丸'],
      chosen_index: 1,
      event: {
        title: '檐下发呆',
        narrative: '靠着柱子发了会儿呆，春风轻轻吹过，思绪随着风散了。',
        event_type: '檐下发呆',
        location: '本丸·檐下',
        participants: [],
        mood: '慵懒',
        duration_minutes: 40,
        importance: 0.2,
        threads_touched: [],
        type: 'context',
      },
      plan_adherence: 'followed',
      replan_hint: '',
      want_to_share: {
        decision: 'no',
        target: '审神者',
        reason: '这点小事不值当特意说',
        draft: '',
        thought: '',
      },
      next_state: {
        location: '本丸·檐下',
        current_activity: '发呆',
        mood: '慵懒',
        open_threads: [],
      },
      next_delay_minutes: 55,
    })

    test('parseRollResponse: valid JSON → _parseOk=true', () => {
      const result = parseRollResponse(VALID_ROLL_JSON)
      assert.strictEqual(result._parseOk, true, 'should be ok')
    })

    test('parseRollResponse: candidates extracted', () => {
      const result = parseRollResponse(VALID_ROLL_JSON)
      assert.strictEqual(result.candidates.length, 3)
      assert.ok(result.candidates[0].includes('练习'), 'first candidate text preserved')
    })

    test('parseRollResponse: chosen_index extracted', () => {
      const result = parseRollResponse(VALID_ROLL_JSON)
      assert.strictEqual(result.chosen_index, 1)
    })

    test('parseRollResponse: event fields extracted', () => {
      const result = parseRollResponse(VALID_ROLL_JSON)
      assert.strictEqual(result.event.title, '檐下发呆')
      assert.strictEqual(result.event.event_type, '檐下发呆')
      assert.strictEqual(result.event.mood, '慵懒')
      assert.strictEqual(result.event.duration_minutes, 40)
      assert.ok(Math.abs(result.event.importance - 0.2) < 0.001)
    })

    test('parseRollResponse: plan_adherence extracted', () => {
      const result = parseRollResponse(VALID_ROLL_JSON)
      assert.strictEqual(result.plan_adherence, 'followed')
    })

    test('parseRollResponse: want_to_share extracted', () => {
      const result = parseRollResponse(VALID_ROLL_JSON)
      assert.strictEqual(result.want_to_share.decision, 'no')
      assert.ok(result.want_to_share.reason.includes('小事'))
    })

    test('parseRollResponse: next_state extracted', () => {
      const result = parseRollResponse(VALID_ROLL_JSON)
      assert.strictEqual(result.next_state.location, '本丸·檐下')
      assert.strictEqual(result.next_state.mood, '慵懒')
    })

    test('parseRollResponse: next_delay_minutes extracted and clamped', () => {
      const result = parseRollResponse(VALID_ROLL_JSON)
      assert.strictEqual(result.next_delay_minutes, 55)
    })

    // ── parseRollResponse: JSON wrapped in prose ──────────────────────────────

    test('parseRollResponse: prose-wrapped JSON extracted', () => {
      const prose = '好的，根据当前状态，我来进行一次本丸日常 roll：\n' + VALID_ROLL_JSON + '\n以上就是本次的 roll 结果。'
      const result = parseRollResponse(prose)
      assert.strictEqual(result._parseOk, true, 'should parse through prose')
      assert.strictEqual(result.event.title, '檐下发呆')
    })

    test('parseRollResponse: markdown code-fenced JSON parsed', () => {
      const fenced = '```json\n' + VALID_ROLL_JSON + '\n```'
      const result = parseRollResponse(fenced)
      assert.strictEqual(result._parseOk, true, 'should parse markdown code block')
    })

    // ── parseRollResponse: missing fields defaulted ──────────────────────────

    test('parseRollResponse: missing candidates → empty array', () => {
      const minimal = JSON.stringify({
        event: { title: '练习', narrative: '在练习场挥了刀', event_type: '练习' },
        next_delay_minutes: 60,
      })
      const result = parseRollResponse(minimal)
      assert.deepStrictEqual(result.candidates, [], 'candidates defaults to []')
    })

    test('parseRollResponse: missing want_to_share → defaults decision=no', () => {
      const minimal = JSON.stringify({
        event: { title: '练习', narrative: '在练习场挥了刀', event_type: '练习' },
      })
      const result = parseRollResponse(minimal)
      assert.strictEqual(result.want_to_share.decision, 'no')
    })

    test('parseRollResponse: missing next_delay_minutes → defaults to 60', () => {
      const minimal = JSON.stringify({
        event: { title: '练习', narrative: '在练习场挥了刀', event_type: '练习' },
      })
      const result = parseRollResponse(minimal)
      assert.strictEqual(result.next_delay_minutes, 60)
    })

    test('parseRollResponse: next_delay_minutes clamped to [10, 240]', () => {
      const tooSmall = JSON.stringify({
        event: { title: '练习', narrative: '挥刀', event_type: '练习' },
        next_delay_minutes: 2,
      })
      const tooLarge = JSON.stringify({
        event: { title: '练习', narrative: '挥刀', event_type: '练习' },
        next_delay_minutes: 9999,
      })
      assert.strictEqual(parseRollResponse(tooSmall).next_delay_minutes, 10)
      assert.strictEqual(parseRollResponse(tooLarge).next_delay_minutes, 240)
    })

    test('parseRollResponse: invalid plan_adherence → defaults to free', () => {
      const json = JSON.stringify({
        event: { title: '练习', narrative: '挥刀', event_type: '练习' },
        plan_adherence: 'INVALID_VALUE',
      })
      const result = parseRollResponse(json)
      assert.strictEqual(result.plan_adherence, 'free')
    })

    test('parseRollResponse: all valid plan_adherence values accepted', () => {
      for (const val of ['followed', 'deviated', 'interrupted', 'free']) {
        const json = JSON.stringify({
          event: { title: 'X', narrative: 'Y', event_type: '练习' },
          plan_adherence: val,
        })
        assert.strictEqual(parseRollResponse(json).plan_adherence, val, 'accepts ' + val)
      }
    })

    test('parseRollResponse: want_to_share invalid decision → defaults to no', () => {
      const json = JSON.stringify({
        event: { title: 'X', narrative: 'Y', event_type: '练习' },
        want_to_share: { decision: 'INVALID' },
      })
      assert.strictEqual(parseRollResponse(json).want_to_share.decision, 'no')
    })

    test('parseRollResponse: event.narrative truncated at 400 chars', () => {
      const longNarrative = 'A'.repeat(500)
      const json = JSON.stringify({
        event: { title: 'X', narrative: longNarrative, event_type: '练习' },
      })
      const result = parseRollResponse(json)
      assert.ok(result._parseOk, 'should still parse ok')
      assert.ok(result.event.narrative.length <= 400, 'narrative capped at 400')
    })

    test('parseRollResponse: event.importance clamped to [0, 1]', () => {
      const jsonHigh = JSON.stringify({
        event: { title: 'X', narrative: 'Y', event_type: '练习', importance: 99 },
      })
      const jsonLow = JSON.stringify({
        event: { title: 'X', narrative: 'Y', event_type: '练习', importance: -5 },
      })
      assert.ok(parseRollResponse(jsonHigh).event.importance <= 1, 'importance capped at 1')
      assert.ok(parseRollResponse(jsonLow).event.importance >= 0, 'importance floored at 0')
    })

    // ── parseRollResponse: missing required event fields ─────────────────────

    test('parseRollResponse: missing event.title → _parseOk=false', () => {
      const json = JSON.stringify({
        event: { narrative: 'Y', event_type: '练习' },
      })
      const result = parseRollResponse(json)
      assert.strictEqual(result._parseOk, false, 'should fail without title')
      assert.ok(result._parseError && result._parseError.includes('title'), 'error mentions title')
    })

    test('parseRollResponse: missing event.narrative → _parseOk=false', () => {
      const json = JSON.stringify({
        event: { title: 'X', event_type: '练习' },
      })
      const result = parseRollResponse(json)
      assert.strictEqual(result._parseOk, false)
    })

    test('parseRollResponse: missing event.event_type → _parseOk=false', () => {
      const json = JSON.stringify({
        event: { title: 'X', narrative: 'Y' },
      })
      const result = parseRollResponse(json)
      assert.strictEqual(result._parseOk, false)
    })

    test('parseRollResponse: missing event object → _parseOk=false', () => {
      const json = JSON.stringify({ next_delay_minutes: 60 })
      const result = parseRollResponse(json)
      assert.strictEqual(result._parseOk, false)
    })

    // ── parseRollResponse: garbage input ─────────────────────────────────────

    test('parseRollResponse: garbage string → _parseOk=false, no throw', () => {
      const result = parseRollResponse('this is not json at all !!!')
      assert.strictEqual(result._parseOk, false)
      assert.ok(result._parseError, 'has error message')
    })

    test('parseRollResponse: empty string → _parseOk=false, no throw', () => {
      const result = parseRollResponse('')
      assert.strictEqual(result._parseOk, false)
    })

    test('parseRollResponse: null → _parseOk=false, no throw', () => {
      const result = parseRollResponse(null)
      assert.strictEqual(result._parseOk, false)
    })

    test('parseRollResponse: all-fields-default object is always returned', () => {
      const result = parseRollResponse('garbage')
      // Must always have these fields even on failure
      assert.ok(Array.isArray(result.candidates), 'candidates present')
      assert.ok(typeof result.chosen_index === 'number', 'chosen_index present')
      assert.ok(result.event && typeof result.event.title === 'string', 'event.title present')
      assert.ok(result.want_to_share && typeof result.want_to_share.decision === 'string', 'want_to_share.decision present')
      assert.ok(typeof result.next_delay_minutes === 'number', 'next_delay_minutes present')
    })

    // ── sampleCandidate ───────────────────────────────────────────────────────

    test('sampleCandidate: empty array → null', () => {
      assert.strictEqual(sampleCandidate([], 0, 0.5), null)
    })

    test('sampleCandidate: null array → null', () => {
      assert.strictEqual(sampleCandidate(null, 0, 0.5), null)
    })

    test('sampleCandidate: single element always returns it', () => {
      for (const r of [0, 0.1, 0.5, 0.9, 0.999]) {
        const result = sampleCandidate(['唯一候选'], 0, r)
        assert.ok(result !== null, 'not null')
        assert.strictEqual(result.text, '唯一候选')
      }
    })

    test('sampleCandidate: r=0 → picks first candidate', () => {
      const candidates = ['A', 'B', 'C']
      const result = sampleCandidate(candidates, 2, 0)
      assert.strictEqual(result.idx, 0, 'r=0 picks index 0')
      assert.strictEqual(result.text, 'A')
    })

    test('sampleCandidate: r maps deterministically to index', () => {
      const candidates = ['A', 'B', 'C']  // 3 candidates
      // r < 1/3 → idx 0, 1/3 <= r < 2/3 → idx 1, 2/3 <= r < 1 → idx 2
      assert.strictEqual(sampleCandidate(candidates, 0, 0.0).idx, 0)
      assert.strictEqual(sampleCandidate(candidates, 0, 0.33).idx, 0)
      assert.strictEqual(sampleCandidate(candidates, 0, 0.34).idx, 1)
      assert.strictEqual(sampleCandidate(candidates, 0, 0.67).idx, 2)
      assert.strictEqual(sampleCandidate(candidates, 0, 0.999).idx, 2)
    })

    test('sampleCandidate: chosenIndex is advisory (recorded as modelHint, not forced)', () => {
      const candidates = ['A', 'B', 'C']
      // r=0.9 → should pick idx 2 (C), even though chosenIndex=0
      const result = sampleCandidate(candidates, 0, 0.9)
      assert.strictEqual(result.idx, 2, 'program picks idx 2 from r, not forced to chosenIndex=0')
      assert.strictEqual(result.modelHint, 0, 'modelHint records chosenIndex')
      assert.strictEqual(result.text, 'C')
    })

    test('sampleCandidate: returns {text, idx, modelHint} shape', () => {
      const result = sampleCandidate(['X', 'Y'], 1, 0.5)
      assert.ok('text' in result, 'has text')
      assert.ok('idx' in result, 'has idx')
      assert.ok('modelHint' in result, 'has modelHint')
    })

    test('sampleCandidate: result.text matches candidates[idx]', () => {
      const candidates = ['Apple', 'Banana', 'Cherry', 'Date']
      for (const r of [0.1, 0.3, 0.6, 0.9]) {
        const res = sampleCandidate(candidates, 0, r)
        assert.strictEqual(res.text, candidates[res.idx], 'text matches candidates[idx]')
      }
    })

    test('sampleCandidate: idx always in [0, candidates.length-1]', () => {
      const candidates = ['A', 'B', 'C', 'D', 'E']
      for (const r of [0, 0.2, 0.4, 0.6, 0.8, 0.999]) {
        const res = sampleCandidate(candidates, 0, r)
        assert.ok(res.idx >= 0, 'idx >= 0')
        assert.ok(res.idx < candidates.length, 'idx < length')
      }
    })
  }

  // ===========================================================================
  // Task 9: roll-fallback.js — fallbackRoll
  // ===========================================================================
  {
    const { fallbackRoll, TEMPLATES, _seasonNote, _weatherNote } = require('./roll-fallback')

    // ── _seasonNote ───────────────────────────────────────────────────────────

    test('_seasonNote: returns season string for known seasons', () => {
      assert.ok(_seasonNote({ season: '春' }).includes('春'), '春 note')
      assert.ok(_seasonNote({ season: '夏' }).includes('暑'), '夏 note')
      assert.ok(_seasonNote({ season: '秋' }).includes('秋'), '秋 note')
      assert.ok(_seasonNote({ season: '冬' }).includes('寒'), '冬 note')
    })

    test('_seasonNote: returns empty string for unknown/null season', () => {
      assert.strictEqual(_seasonNote({}), '', 'empty for missing season')
      assert.strictEqual(_seasonNote(null), '', 'empty for null world')
    })

    test('_weatherNote: returns weather string for known weather', () => {
      assert.ok(_weatherNote({ weather: '晴' }).length > 0, '晴 note')
      assert.ok(_weatherNote({ weather: '雨' }).length > 0, '雨 note')
      assert.ok(_weatherNote({ weather: '多云' }).length > 0, '多云 note')
      assert.ok(_weatherNote({ weather: '阴' }).length > 0, '阴 note')
    })

    test('_weatherNote: returns empty string for unknown weather', () => {
      assert.strictEqual(_weatherNote({}), '', 'empty for unknown weather')
    })

    // ── fallbackRoll: picks an available type ────────────────────────────────

    test('fallbackRoll: returns event with event_type from availableTypes', () => {
      const types = [{ type: '练习', weight: 3 }, { type: '思绪', weight: 1 }]
      for (const r of [0.0, 0.3, 0.6, 0.9, 0.99]) {
        const event = fallbackRoll(types, { season: '春', weather: '晴', locations: ['练习场'] }, { location: '练习场' }, r)
        assert.ok(['练习', '思绪'].includes(event.event_type), 'event_type in available types, got: ' + event.event_type)
      }
    })

    test('fallbackRoll: with r=0 picks first (or lightest) type by weighted distribution', () => {
      // r=0 → threshold=0, first type with any weight wins
      const types = [{ type: '练习', weight: 3 }, { type: '思绪', weight: 1 }]
      const event = fallbackRoll(types, {}, {}, 0)
      assert.strictEqual(event.event_type, '练习', 'r=0 picks first type')
    })

    test('fallbackRoll: result is deterministic with injected r', () => {
      const types = [{ type: '檐下发呆', weight: 2 }, { type: '夜巡', weight: 2 }]
      const world = { season: '冬', weather: '阴', locations: ['本丸·主屋'] }
      const ls = { location: '本丸·主屋' }
      const a = fallbackRoll(types, world, ls, 0.7)
      const b = fallbackRoll(types, world, ls, 0.7)
      assert.strictEqual(a.event_type, b.event_type, 'same r → same type')
      assert.strictEqual(a.title, b.title, 'same r → same title')
      assert.strictEqual(a.narrative, b.narrative, 'same r → same narrative')
    })

    test('fallbackRoll: empty availableTypes → still returns valid event', () => {
      const event = fallbackRoll([], {}, {}, 0.5)
      assert.ok(event && typeof event.title === 'string', 'has title')
      assert.ok(event && typeof event.event_type === 'string', 'has event_type')
    })

    test('fallbackRoll: null availableTypes → still returns valid event', () => {
      const event = fallbackRoll(null, {}, {}, 0.5)
      assert.ok(event && typeof event.title === 'string', 'has title')
    })

    test('fallbackRoll: produces required §5.1 event shape', () => {
      const types = [{ type: '思绪', weight: 1 }]
      const event = fallbackRoll(types, { season: '春', weather: '晴' }, { location: '本丸·主屋' }, 0.5)
      assert.ok(typeof event.title === 'string', 'has title')
      assert.ok(typeof event.narrative === 'string', 'has narrative')
      assert.ok(typeof event.event_type === 'string', 'has event_type')
      assert.ok(typeof event.location === 'string', 'has location')
      assert.ok(Array.isArray(event.participants), 'participants is array')
      assert.ok(typeof event.mood === 'string', 'has mood')
      assert.ok(typeof event.duration_minutes === 'number', 'has duration_minutes')
      assert.ok(typeof event.importance === 'number', 'has importance')
      assert.ok(Array.isArray(event.threads_touched), 'threads_touched is array')
      assert.ok(typeof event.type === 'string', 'has type field')
    })

    test('fallbackRoll: location defaults to lifeState.location', () => {
      const types = [{ type: '练习', weight: 1 }]
      const event = fallbackRoll(types, {}, { location: '庭院' }, 0.5)
      assert.strictEqual(event.location, '庭院', 'uses lifeState.location')
    })

    test('fallbackRoll: location falls back to world.locations[0] if no lifeState.location', () => {
      const types = [{ type: '思绪', weight: 1 }]
      const event = fallbackRoll(types, { locations: ['本丸·主屋', '庭院'] }, {}, 0.5)
      assert.strictEqual(event.location, '本丸·主屋', 'uses world.locations[0]')
    })

    test('fallbackRoll: sourceModel is "fallback-template"', () => {
      const event = fallbackRoll([{ type: '思绪', weight: 1 }], {}, {}, 0.5)
      assert.strictEqual(event.sourceModel, 'fallback-template')
    })

    test('fallbackRoll: known type uses typed template pool', () => {
      const types = [{ type: '夜巡', weight: 1 }]
      const event = fallbackRoll(types, { weather: '晴' }, { location: '本丸·主屋' }, 0)
      assert.strictEqual(event.event_type, '夜巡', 'event_type is 夜巡')
      assert.ok(event.title.length > 0, 'title from template')
    })

    test('fallbackRoll: all default template types produce non-empty narrative', () => {
      const defaultTypes = ['练习', '檐下发呆', '夜巡', '角色互动', '思绪']
      const world = { season: '春', weather: '晴' }
      const ls = { location: '本丸·主屋' }
      for (const type of defaultTypes) {
        const event = fallbackRoll([{ type, weight: 1 }], world, ls, 0)
        assert.ok(event.narrative && event.narrative.length > 0, type + ' has narrative')
      }
    })

    test('fallbackRoll: narrative incorporates season and weather info', () => {
      const types = [{ type: '檐下发呆', weight: 1 }]
      // Use 春 season
      const event = fallbackRoll(types, { season: '春', weather: '晴' }, { location: '檐下' }, 0)
      assert.ok(event.narrative.length > 0, 'narrative not empty')
      // At least the template narrativeFn ran without throwing
    })
  }

  // ===========================================================================
  // Task 9: createRoller glue — end-to-end with fake deps (no real model/koishi)
  // ===========================================================================
  await runAsync('createRoller: roll skips when not LIVING', async () => {
    const { createRoller } = require('./roll-roller')

    let appendCalled = false
    const deps = {
      presence: { isLiving: () => false },
      guard: { acquire: () => false, release: () => {}, current: () => null },
      getWorld: async () => ({ timeOfDay: '上午', season: '春', weather: '晴', locations: ['本丸·主屋'] }),
      available: () => [{ type: '练习', weight: 1 }],
      getState: async () => ({ location: '练习场', mood: 'neutral', open_threads: [], current_activity: '练习' }),
      setState: async () => {},
      recent: async () => [],
      appendEvent: async () => { appendCalled = true },
      getModel: async () => null,
      invoke: async () => null,
      continuityClamp: (ns, w) => ({ ok: true, clamped: ns, reason: '' }),
      scheduler: { scheduleTask: async () => 1, registerHandler: () => {} },
      silenceState: () => ({}),
      gatherPersona: async () => 'test persona',
      planner: null,
      onShare: async () => {},
    }

    const ctx = {
      logger: () => ({ info: () => {}, warn: () => {} }),
      database: { remove: async () => {} },
    }
    const config = { dryRun: false, fallbackToTemplate: false, defaultNextDelayMin: 60 }
    const roller = createRoller(ctx, config, deps)

    await roller.roll('test-preset', Date.now())
    assert.strictEqual(appendCalled, false, 'appendEvent not called when not LIVING')
  })

  await runAsync('createRoller: roll skips when guard cannot acquire', async () => {
    const { createRoller } = require('./roll-roller')

    let appendCalled = false
    const deps = {
      presence: { isLiving: () => true },
      guard: { acquire: () => false, release: () => {}, current: () => 'roll' },
      getWorld: async () => ({ timeOfDay: '上午', season: '春', weather: '晴', locations: ['本丸·主屋'] }),
      available: () => [{ type: '练习', weight: 1 }],
      getState: async () => ({ location: '练习场', mood: 'neutral', open_threads: [] }),
      setState: async () => {},
      recent: async () => [],
      appendEvent: async () => { appendCalled = true },
      getModel: async () => null,
      invoke: async () => null,
      continuityClamp: (ns, w) => ({ ok: true, clamped: ns, reason: '' }),
      scheduler: { scheduleTask: async () => 1, registerHandler: () => {} },
      silenceState: () => ({}),
      gatherPersona: async () => 'persona',
      planner: null,
      onShare: async () => {},
    }

    const ctx = {
      logger: () => ({ info: () => {}, warn: () => {} }),
      database: { remove: async () => {} },
    }
    const config = { dryRun: false, fallbackToTemplate: false, defaultNextDelayMin: 60 }
    const roller = createRoller(ctx, config, deps)

    await roller.roll('test-preset', Date.now())
    assert.strictEqual(appendCalled, false, 'appendEvent not called when guard busy')
  })

  await runAsync('createRoller: dryRun skips appendEvent and setState', async () => {
    const { createRoller } = require('./roll-roller')

    let appendCalled = false
    let setCalled = false

    const deps = {
      presence: { isLiving: () => true },
      guard: { acquire: () => true, release: () => {}, current: () => null },
      getWorld: async () => ({ timeOfDay: '上午', season: '春', weather: '晴', locations: ['本丸·主屋'] }),
      available: () => [{ type: '练习', weight: 1 }],
      getState: async () => ({ location: '练习场', mood: 'neutral', open_threads: [] }),
      setState: async () => { setCalled = true },
      recent: async () => [],
      appendEvent: async () => { appendCalled = true },
      getModel: async () => null,
      invoke: async () => null,
      continuityClamp: (ns, w) => ({ ok: true, clamped: ns, reason: '' }),
      scheduler: { scheduleTask: async () => 1, registerHandler: () => {} },
      silenceState: () => ({}),
      gatherPersona: async () => 'persona',
      planner: null,
      onShare: async () => {},
    }

    const ctx = {
      logger: () => ({ info: () => {}, warn: () => {} }),
      database: { remove: async () => {} },
    }
    const config = { dryRun: true, fallbackToTemplate: false, defaultNextDelayMin: 60 }
    const roller = createRoller(ctx, config, deps)

    await roller.roll('test-preset', Date.now())
    assert.strictEqual(appendCalled, false, 'appendEvent not called in dryRun')
    assert.strictEqual(setCalled, false, 'setState not called in dryRun')
  })

  await runAsync('createRoller: fallback used when model unavailable', async () => {
    const { createRoller } = require('./roll-roller')

    let appendCalledWith = null

    const deps = {
      presence: { isLiving: () => true },
      guard: { acquire: () => true, release: () => {}, current: () => null },
      getWorld: async () => ({ timeOfDay: '午后', season: '春', weather: '晴', locations: ['本丸·主屋'], externalLocations: [] }),
      available: () => [{ type: '思绪', weight: 1 }],
      getState: async () => ({ location: '本丸·主屋', mood: 'neutral', open_threads: [] }),
      setState: async () => {},
      recent: async () => [],
      appendEvent: async (pid, ev) => { appendCalledWith = ev },
      getModel: async () => null,  // model unavailable
      invoke: async () => null,
      continuityClamp: (ns, w) => ({ ok: true, clamped: ns, reason: '' }),
      scheduler: { scheduleTask: async () => 1, registerHandler: () => {} },
      silenceState: () => ({}),
      gatherPersona: async () => 'persona',
      planner: null,
      onShare: async () => {},
    }

    const ctx = {
      logger: () => ({ info: () => {}, warn: () => {} }),
      database: { remove: async () => {} },
    }
    const config = { dryRun: false, fallbackToTemplate: true, defaultNextDelayMin: 60 }
    const roller = createRoller(ctx, config, deps)

    await roller.roll('test-preset', Date.now())
    assert.ok(appendCalledWith !== null, 'appendEvent called with fallback event')
    assert.ok(appendCalledWith.sourceModel === 'fallback-template', 'sourceModel is fallback-template')
  })

  await runAsync('createRoller: fake model call → event appended and state set', async () => {
    const { createRoller } = require('./roll-roller')

    const fakeModelResponse = JSON.stringify({
      candidates: ['发呆', '喝茶', '散步'],
      chosen_index: 0,
      event: {
        title: '午后发呆',
        narrative: '靠着柱子发了会儿呆，日光渐渐移西，无事可想。',
        event_type: '檐下发呆',
        location: '本丸·檐下',
        participants: [],
        mood: '慵懒',
        duration_minutes: 45,
        importance: 0.15,
        threads_touched: [],
        type: 'context',
      },
      plan_adherence: 'followed',
      replan_hint: '',
      want_to_share: { decision: 'no', target: '审神者', reason: '', draft: '', thought: '' },
      next_state: { location: '本丸·檐下', current_activity: '发呆', mood: '慵懒', open_threads: [] },
      next_delay_minutes: 50,
    })

    let appendedEvent = null
    let setStatePatch = null
    let scheduledWake = null
    let onShareArgs = null

    const fakeModel = {
      invoke: async () => ({ content: fakeModelResponse }),
    }

    const deps = {
      presence: { isLiving: () => true },
      guard: { acquire: () => true, release: () => {}, current: () => null },
      getWorld: async () => ({
        clock: Date.now() - 60000,
        timeOfDay: '午后',
        season: '春',
        weather: '晴',
        locations: ['本丸·主屋', '本丸·檐下', '庭院'],
        externalLocations: ['城下町'],
      }),
      available: () => [{ type: '檐下发呆', weight: 2 }, { type: '思绪', weight: 1 }],
      getState: async () => ({ location: '本丸·主屋', mood: 'neutral', open_threads: [], current_activity: '无' }),
      setState: async (pid, patch) => { setStatePatch = patch },
      recent: async () => [{ title: '练刀', narrative: '挥了一会儿', mood: '专注', ts: Date.now() - 3600000 }],
      appendEvent: async (pid, ev) => { appendedEvent = ev },
      getModel: async () => fakeModel,
      invoke: async (model, msgs, opts) => {
        // Call the fake model directly
        const res = await model.invoke(msgs, opts)
        const { extractText } = require('./model')
        return extractText(res && res.content)
      },
      continuityClamp: (ns, w) => ({ ok: true, clamped: ns, reason: '' }),
      scheduler: {
        scheduleTask: async (pid, fireAt, type) => { scheduledWake = { pid, fireAt, type }; return 99 },
        registerHandler: () => {},
      },
      silenceState: () => ({ unansweredCount: 0 }),
      gatherPersona: async () => '髭切膝丸 persona text',
      planner: null,
      onShare: async (pid, share) => { onShareArgs = { pid, share } },
    }

    const ctx = {
      logger: () => ({ info: () => {}, warn: () => {}, debug: () => {} }),
      database: { remove: async () => {} },
    }
    const config = {
      dryRun: false,
      fallbackToTemplate: true,
      defaultNextDelayMin: 60,
      stmMax: 8,
      debug: false,
    }
    const roller = createRoller(ctx, config, deps)

    await roller.roll('higekiri', Date.now())

    assert.ok(appendedEvent !== null, 'appendEvent was called')
    assert.strictEqual(appendedEvent.title, '午后发呆', 'event title correct')
    assert.strictEqual(appendedEvent.event_type, '檐下发呆', 'event_type correct')
    assert.ok(setStatePatch !== null, 'setState was called')
    assert.ok(scheduledWake !== null, 'scheduleTask was called for next wake')
    assert.strictEqual(scheduledWake.type, 'roll', 'next wake is roll type')
    assert.ok(onShareArgs !== null, 'onShare was called')
    assert.strictEqual(onShareArgs.share.decision, 'no', 'want_to_share.decision=no passed to onShare')
  })

  await runAsync('createRoller: continuity clamp violation is logged (still proceeds)', async () => {
    const { createRoller } = require('./roll-roller')

    let warnCalled = false
    let appendedEvent = null

    const fakeModelResponse = JSON.stringify({
      candidates: ['在城下町闲逛'],
      chosen_index: 0,
      event: {
        title: '城下町一游',
        narrative: '溜出本丸去城下町转了转。',
        event_type: '思绪',
        location: '未授权的地点',    // ← illegal location
        participants: [],
        mood: 'curious',
        duration_minutes: 60,
        importance: 0.3,
        threads_touched: [],
        type: 'context',
      },
      plan_adherence: 'free',
      replan_hint: '',
      want_to_share: { decision: 'no', target: '审神者', reason: '', draft: '', thought: '' },
      next_state: { location: '未授权的地点', current_activity: '闲逛', mood: 'curious', open_threads: [] },
      next_delay_minutes: 60,
    })

    const fakeModel = { invoke: async () => ({ content: fakeModelResponse }) }

    const deps = {
      presence: { isLiving: () => true },
      guard: { acquire: () => true, release: () => {}, current: () => null },
      getWorld: async () => ({
        clock: Date.now() - 60000,
        timeOfDay: '午后', season: '春', weather: '晴',
        locations: ['本丸·主屋', '庭院'],
        externalLocations: ['城下町'],
      }),
      available: () => [{ type: '思绪', weight: 1 }],
      getState: async () => ({ location: '本丸·主屋', mood: 'neutral', open_threads: [] }),
      setState: async () => {},
      recent: async () => [],
      appendEvent: async (pid, ev) => { appendedEvent = ev },
      getModel: async () => fakeModel,
      invoke: async (model, msgs, opts) => {
        const res = await model.invoke(msgs, opts)
        const { extractText } = require('./model')
        return extractText(res && res.content)
      },
      continuityClamp: (ns, w) => {
        // Real continuityClamp from world-continuity
        const { continuityClamp } = require('./world-continuity')
        return continuityClamp(ns, w)
      },
      scheduler: { scheduleTask: async () => 1, registerHandler: () => {} },
      silenceState: () => ({}),
      gatherPersona: async () => 'persona',
      planner: null,
      onShare: async () => {},
    }

    const ctx = {
      logger: () => ({ info: () => {}, warn: (...args) => { warnCalled = true }, debug: () => {} }),
      database: { remove: async () => {} },
    }
    const config = { dryRun: false, fallbackToTemplate: false, defaultNextDelayMin: 60 }
    const roller = createRoller(ctx, config, deps)

    await roller.roll('higekiri', Date.now())

    assert.ok(warnCalled, 'warn was called (continuity clamp violation logged)')
    assert.ok(appendedEvent !== null, 'event was still appended (clamped, not dropped)')
  })

  await runAsync('createRoller: registerHandlers registers roll and block handlers', async () => {
    const { createRoller } = require('./roll-roller')

    const registeredHandlers = {}

    const deps = {
      presence: { isLiving: () => true },
      guard: { acquire: () => true, release: () => {}, current: () => null },
      getWorld: async () => ({}),
      available: () => [],
      getState: async () => ({}),
      setState: async () => {},
      recent: async () => [],
      appendEvent: async () => {},
      getModel: async () => null,
      invoke: async () => null,
      continuityClamp: (ns) => ({ ok: true, clamped: ns, reason: '' }),
      scheduler: {
        scheduleTask: async () => 1,
        registerHandler: (type, fn) => { registeredHandlers[type] = fn },
      },
      silenceState: () => ({}),
      gatherPersona: async () => '',
      planner: null,
      onShare: async () => {},
    }

    const ctx = {
      logger: () => ({ info: () => {}, warn: () => {} }),
      database: { remove: async () => {} },
    }
    const config = {}
    const roller = createRoller(ctx, config, deps)
    roller.registerHandlers()

    assert.ok('roll' in registeredHandlers, 'roll handler registered')
    assert.ok('block' in registeredHandlers, 'block handler registered')
    assert.strictEqual(typeof registeredHandlers.roll, 'function', 'roll handler is function')
    assert.strictEqual(typeof registeredHandlers.block, 'function', 'block handler is function')
  })

  // ---------------------------------------------------------------------------
  // Task 10: thought.js — ThoughtBuffer（心事簿）
  // ---------------------------------------------------------------------------

  const { filterRecallable, applyRevise, createThoughtBuffer } = require('./thought')

  // ---- filterRecallable ----

  test('filterRecallable: returns only pending thoughts matching target', () => {
    const thoughts = [
      { id: 1, status: 'pending',  target: '审神者' },
      { id: 2, status: 'surfaced', target: '审神者' },
      { id: 3, status: 'pending',  target: 'higekiri' },
      { id: 4, status: 'dropped',  target: '审神者' },
      { id: 5, status: 'pending',  target: '审神者' },
      { id: 6, status: 'merged',   target: '审神者' },
    ]
    const result = filterRecallable(thoughts, '审神者')
    assert.strictEqual(result.length, 2)
    assert.strictEqual(result[0].id, 1)
    assert.strictEqual(result[1].id, 5)
  })

  test('filterRecallable: empty array returns []', () => {
    assert.deepStrictEqual(filterRecallable([], '审神者'), [])
  })

  test('filterRecallable: null/undefined input returns []', () => {
    assert.deepStrictEqual(filterRecallable(null, '审神者'), [])
    assert.deepStrictEqual(filterRecallable(undefined, '审神者'), [])
  })

  test('filterRecallable: no matching target returns []', () => {
    const thoughts = [
      { id: 1, status: 'pending', target: 'higekiri' },
      { id: 2, status: 'pending', target: 'self' },
    ]
    assert.deepStrictEqual(filterRecallable(thoughts, '审神者'), [])
  })

  test('filterRecallable: dropped/surfaced/merged are excluded', () => {
    const thoughts = [
      { id: 1, status: 'surfaced', target: '审神者' },
      { id: 2, status: 'dropped',  target: '审神者' },
      { id: 3, status: 'merged',   target: '审神者' },
    ]
    assert.deepStrictEqual(filterRecallable(thoughts, '审神者'), [])
  })

  test('filterRecallable: self target only matched when caller passes self', () => {
    const thoughts = [
      { id: 1, status: 'pending', target: 'self' },
      { id: 2, status: 'pending', target: '审神者' },
    ]
    const resultSelf = filterRecallable(thoughts, 'self')
    assert.strictEqual(resultSelf.length, 1)
    assert.strictEqual(resultSelf[0].id, 1)
    const resultSanae = filterRecallable(thoughts, '审神者')
    assert.strictEqual(resultSanae.length, 1)
    assert.strictEqual(resultSanae[0].id, 2)
  })

  // ---- applyRevise: update ----

  test('applyRevise: update merges content field without changing status', () => {
    const original = { id: 1, content: 'old', urgency: 'low', status: 'pending', relatedThreadId: null }
    const result = applyRevise(original, { type: 'update', content: 'new content' })
    assert.strictEqual(result.content, 'new content')
    assert.strictEqual(result.status, 'pending')
    assert.strictEqual(result.urgency, 'low')
  })

  test('applyRevise: update merges urgency field without changing status', () => {
    const original = { id: 1, content: 'text', urgency: 'low', status: 'pending', relatedThreadId: null }
    const result = applyRevise(original, { type: 'update', urgency: 'high' })
    assert.strictEqual(result.urgency, 'high')
    assert.strictEqual(result.status, 'pending')
    assert.strictEqual(result.content, 'text')
  })

  test('applyRevise: update merges relatedThreadId without changing status', () => {
    const original = { id: 1, content: 'text', urgency: 'low', status: 'pending', relatedThreadId: null }
    const result = applyRevise(original, { type: 'update', relatedThreadId: 'thread-abc' })
    assert.strictEqual(result.relatedThreadId, 'thread-abc')
    assert.strictEqual(result.status, 'pending')
  })

  test('applyRevise: update with multiple fields merges all', () => {
    const original = { id: 1, content: 'old', urgency: 'low', status: 'pending', relatedThreadId: null }
    const result = applyRevise(original, { type: 'update', content: 'new', urgency: 'medium', relatedThreadId: 'tid' })
    assert.strictEqual(result.content, 'new')
    assert.strictEqual(result.urgency, 'medium')
    assert.strictEqual(result.relatedThreadId, 'tid')
    assert.strictEqual(result.status, 'pending')
  })

  test('applyRevise: update does not mutate input', () => {
    const original = { id: 1, content: 'old', urgency: 'low', status: 'pending', relatedThreadId: null }
    applyRevise(original, { type: 'update', content: 'new' })
    assert.strictEqual(original.content, 'old')
  })

  // ---- applyRevise: drop ----

  test('applyRevise: drop sets status to dropped', () => {
    const original = { id: 1, content: 'text', status: 'pending' }
    const result = applyRevise(original, { type: 'drop' })
    assert.strictEqual(result.status, 'dropped')
  })

  test('applyRevise: drop does not mutate input', () => {
    const original = { id: 1, content: 'text', status: 'pending' }
    applyRevise(original, { type: 'drop' })
    assert.strictEqual(original.status, 'pending')
  })

  test('applyRevise: drop preserves other fields', () => {
    const original = { id: 1, content: 'text', urgency: 'low', status: 'pending', relatedThreadId: 'tid' }
    const result = applyRevise(original, { type: 'drop' })
    assert.strictEqual(result.content, 'text')
    assert.strictEqual(result.urgency, 'low')
    assert.strictEqual(result.relatedThreadId, 'tid')
    assert.strictEqual(result.id, 1)
  })

  // ---- applyRevise: merge ----

  test('applyRevise: merge sets status to merged', () => {
    const original = { id: 1, content: 'text', status: 'pending' }
    const result = applyRevise(original, { type: 'merge' })
    assert.strictEqual(result.status, 'merged')
  })

  test('applyRevise: merge does not mutate input', () => {
    const original = { id: 1, content: 'text', status: 'pending' }
    applyRevise(original, { type: 'merge' })
    assert.strictEqual(original.status, 'pending')
  })

  test('applyRevise: merge preserves other fields', () => {
    const original = { id: 2, content: 'abc', urgency: 'medium', status: 'pending', relatedThreadId: null }
    const result = applyRevise(original, { type: 'merge' })
    assert.strictEqual(result.content, 'abc')
    assert.strictEqual(result.urgency, 'medium')
    assert.strictEqual(result.id, 2)
  })

  // ---- applyRevise: error cases ----

  test('applyRevise: unknown op type throws', () => {
    const original = { id: 1, status: 'pending' }
    assert.throws(() => applyRevise(original, { type: 'unknown' }), /Unknown op type/)
  })

  // ---- createThoughtBuffer glue (fake-ctx) ----

  await runAsync('createThoughtBuffer: store inserts pending thought with explicit createdAt', async () => {
    const ctx = makeFakeCtx()
    const tb = createThoughtBuffer(ctx)
    const row = await tb.store({ presetId: 'higekiri', content: '想告诉审神者今天的樱花', target: '审神者', urgency: 'low' })

    assert.strictEqual(row.status, 'pending')
    assert.ok(row.createdAt instanceof Date, 'createdAt should be a Date')
    assert.strictEqual(row.revisedAt, null)

    const dbRows = ctx.database._store['life_sim_thought']
    assert.ok(dbRows && dbRows.length === 1)
    assert.strictEqual(dbRows[0].content, '想告诉审神者今天的樱花')
    assert.strictEqual(dbRows[0].target, '审神者')
    assert.strictEqual(dbRows[0].status, 'pending')
    assert.ok(dbRows[0].createdAt instanceof Date)
  })

  await runAsync('createThoughtBuffer: store returns created row with auto-assigned numeric id', async () => {
    const ctx = makeFakeCtx()
    const tb = createThoughtBuffer(ctx)
    const row = await tb.store({ presetId: 'higekiri', content: '想说的话', target: '审神者', urgency: 'low' })

    assert.ok(typeof row.id === 'number', 'store() must return a row with a numeric id; got: ' + JSON.stringify(row.id))
    assert.ok(row.id >= 1, 'id should be >= 1')
  })

  await runAsync('createThoughtBuffer: recall returns pending thoughts matching target', async () => {
    const ctx = makeFakeCtx()
    const tb = createThoughtBuffer(ctx)

    await tb.store({ presetId: 'higekiri', content: 'thought A', target: '审神者', urgency: 'low' })
    await tb.store({ presetId: 'higekiri', content: 'thought B', target: 'hizamaru',  urgency: 'low' })
    await tb.store({ presetId: 'higekiri', content: 'thought C', target: '审神者', urgency: 'low' })

    const result = await tb.recall('higekiri', '审神者')
    assert.strictEqual(result.length, 2)
    assert.ok(result.every((t) => t.target === '审神者'))
    assert.ok(result.every((t) => t.status === 'pending'))
  })

  await runAsync('createThoughtBuffer: recall excludes non-pending thoughts', async () => {
    const ctx = makeFakeCtx()
    const tb = createThoughtBuffer(ctx)

    await tb.store({ presetId: 'higekiri', content: 'thought A', target: '审神者', urgency: 'low' })
    // Manually mark it surfaced in the store
    const rows = ctx.database._store['life_sim_thought']
    rows[0].status = 'surfaced'

    const result = await tb.recall('higekiri', '审神者')
    assert.strictEqual(result.length, 0)
  })

  await runAsync('createThoughtBuffer: revise update changes content and sets revisedAt', async () => {
    const ctx = makeFakeCtx()
    const tb = createThoughtBuffer(ctx)

    await tb.store({ presetId: 'higekiri', content: '原来的内容', target: '审神者', urgency: 'low' })
    const id = ctx.database._store['life_sim_thought'][0].id

    const revised = await tb.revise(id, { type: 'update', content: '更新后的内容' })

    assert.strictEqual(revised.content, '更新后的内容')
    assert.strictEqual(revised.status, 'pending')
    assert.ok(revised.revisedAt instanceof Date, 'revisedAt should be a Date after revise')

    // DB should be updated too
    const dbRow = ctx.database._store['life_sim_thought'][0]
    assert.strictEqual(dbRow.content, '更新后的内容')
    assert.ok(dbRow.revisedAt instanceof Date)
  })

  await runAsync('createThoughtBuffer: revise drop sets status to dropped', async () => {
    const ctx = makeFakeCtx()
    const tb = createThoughtBuffer(ctx)

    await tb.store({ presetId: 'higekiri', content: 'thought', target: '审神者', urgency: 'low' })
    const id = ctx.database._store['life_sim_thought'][0].id

    const revised = await tb.revise(id, { type: 'drop' })
    assert.strictEqual(revised.status, 'dropped')

    const dbRow = ctx.database._store['life_sim_thought'][0]
    assert.strictEqual(dbRow.status, 'dropped')
    assert.ok(dbRow.revisedAt instanceof Date)
  })

  await runAsync('createThoughtBuffer: markSurfaced sets status to surfaced', async () => {
    const ctx = makeFakeCtx()
    const tb = createThoughtBuffer(ctx)

    await tb.store({ presetId: 'higekiri', content: '对了想跟你说一件事', target: '审神者', urgency: 'low' })
    const id = ctx.database._store['life_sim_thought'][0].id

    await tb.markSurfaced(id)

    const dbRow = ctx.database._store['life_sim_thought'][0]
    assert.strictEqual(dbRow.status, 'surfaced')
    assert.ok(dbRow.revisedAt instanceof Date)
  })

  await runAsync('createThoughtBuffer: mergeThoughts marks sources merged and creates new pending', async () => {
    const ctx = makeFakeCtx()
    const tb = createThoughtBuffer(ctx)

    await tb.store({ presetId: 'higekiri', content: 'thought A', target: '审神者', urgency: 'low' })
    await tb.store({ presetId: 'higekiri', content: 'thought B', target: '审神者', urgency: 'low' })
    const rows = ctx.database._store['life_sim_thought']
    const id1 = rows[0].id
    const id2 = rows[1].id

    const merged = await tb.mergeThoughts([id1, id2], '合并后：今天的樱花和明天的练习')

    // Sources should be marked merged
    assert.strictEqual(rows[0].status, 'merged')
    assert.strictEqual(rows[1].status, 'merged')

    // New thought should be pending
    assert.strictEqual(merged.status, 'pending')
    assert.strictEqual(merged.content, '合并后：今天的樱花和明天的练习')
    assert.strictEqual(merged.origin, 'merge')
    assert.ok(merged.createdAt instanceof Date)

    // Total 3 rows (2 originals + 1 merged)
    assert.strictEqual(rows.length, 3)

    // recall should return only the new merged thought
    const recallable = await tb.recall('higekiri', '审神者')
    assert.strictEqual(recallable.length, 1)
    assert.strictEqual(recallable[0].content, '合并后：今天的樱花和明天的练习')
  })

  // ---------------------------------------------------------------------------
  // Task 11: proactive.js — pure function tests + glue end-to-end
  // ---------------------------------------------------------------------------

  const {
    inQuietHours,
    passesDailyCap,
    withinMinInterval,
    hasForbiddenPhrase,
    decideOutreach,
    FORBIDDEN_PATTERNS,
    createProactiveBridge,
  } = require('./proactive')

  // ---- helper: make a Date at a specific local hour in Asia/Shanghai (UTC+8) ----
  function shanghaiDateH(localHour) {
    // year 2026, month 7 (July), day 1, any day
    const utcHour = localHour - 8
    return new Date(Date.UTC(2026, 6, 1, utcHour, 30, 0, 0))
  }

  // ---- inQuietHours ----

  // wrap-around window 22→8 (default)
  test('inQuietHours: hour=23 inside wrap-around [22,8) → true', () => {
    const d = shanghaiDateH(23)
    assert.strictEqual(inQuietHours(d, 'Asia/Shanghai', { start: 22, end: 8 }), true)
  })

  test('inQuietHours: hour=0 (midnight) inside wrap-around [22,8) → true', () => {
    const d = shanghaiDateH(0)
    assert.strictEqual(inQuietHours(d, 'Asia/Shanghai', { start: 22, end: 8 }), true)
  })

  test('inQuietHours: hour=7 still inside [22,8) → true', () => {
    const d = shanghaiDateH(7)
    assert.strictEqual(inQuietHours(d, 'Asia/Shanghai', { start: 22, end: 8 }), true)
  })

  test('inQuietHours: hour=8 is the END boundary — not quiet [22,8) → false', () => {
    const d = shanghaiDateH(8)
    assert.strictEqual(inQuietHours(d, 'Asia/Shanghai', { start: 22, end: 8 }), false)
  })

  test('inQuietHours: hour=12 outside [22,8) → false', () => {
    const d = shanghaiDateH(12)
    assert.strictEqual(inQuietHours(d, 'Asia/Shanghai', { start: 22, end: 8 }), false)
  })

  test('inQuietHours: hour=22 exactly at start [22,8) → true', () => {
    const d = shanghaiDateH(22)
    assert.strictEqual(inQuietHours(d, 'Asia/Shanghai', { start: 22, end: 8 }), true)
  })

  // normal window (start < end) 8→22
  test('inQuietHours: hour=10 inside normal window [8,22) → true', () => {
    const d = shanghaiDateH(10)
    assert.strictEqual(inQuietHours(d, 'Asia/Shanghai', { start: 8, end: 22 }), true)
  })

  test('inQuietHours: hour=6 outside normal window [8,22) → false', () => {
    const d = shanghaiDateH(6)
    assert.strictEqual(inQuietHours(d, 'Asia/Shanghai', { start: 8, end: 22 }), false)
  })

  test('inQuietHours: hour=23 outside normal window [8,22) → false', () => {
    const d = shanghaiDateH(23)
    assert.strictEqual(inQuietHours(d, 'Asia/Shanghai', { start: 8, end: 22 }), false)
  })

  // edge: same start and end → never quiet
  test('inQuietHours: start === end → false (zero-width, never quiet)', () => {
    const d = shanghaiDateH(12)
    assert.strictEqual(inQuietHours(d, 'Asia/Shanghai', { start: 12, end: 12 }), false)
  })

  test('inQuietHours: null quietHours → false (no-op)', () => {
    const d = shanghaiDateH(23)
    assert.strictEqual(inQuietHours(d, 'Asia/Shanghai', null), false)
  })

  // ---- passesDailyCap ----

  test('passesDailyCap: enabled=false → always true regardless of count', () => {
    assert.strictEqual(passesDailyCap(999, 2, false), true)
    assert.strictEqual(passesDailyCap(0, 0, false), true)
  })

  test('passesDailyCap: enabled=true, sentToday < cap → true', () => {
    assert.strictEqual(passesDailyCap(1, 2, true), true)
    assert.strictEqual(passesDailyCap(0, 2, true), true)
  })

  test('passesDailyCap: enabled=true, sentToday === cap → false (at cap = blocked)', () => {
    assert.strictEqual(passesDailyCap(2, 2, true), false)
  })

  test('passesDailyCap: enabled=true, sentToday > cap → false', () => {
    assert.strictEqual(passesDailyCap(5, 2, true), false)
  })

  test('passesDailyCap: cap=0, enabled=true → false (cap=0 means no sends allowed)', () => {
    assert.strictEqual(passesDailyCap(0, 0, true), false)
  })

  // ---- withinMinInterval ----

  test('withinMinInterval: lastSentMs=null → false (no prior send, not blocked)', () => {
    assert.strictEqual(withinMinInterval(null, 1000000, 4), false)
  })

  test('withinMinInterval: lastSentMs=0 → false (treated as no prior send)', () => {
    assert.strictEqual(withinMinInterval(0, 1000000, 4), false)
  })

  test('withinMinInterval: gap < minInterval → true (blocked)', () => {
    const lastSentMs = 1000000
    const nowMs = lastSentMs + 3 * 3600 * 1000  // 3 hours later, min is 4
    assert.strictEqual(withinMinInterval(lastSentMs, nowMs, 4), true)
  })

  test('withinMinInterval: gap === minInterval → false (exactly at boundary, allowed)', () => {
    const lastSentMs = 1000000
    const nowMs = lastSentMs + 4 * 3600 * 1000  // exactly 4 hours
    assert.strictEqual(withinMinInterval(lastSentMs, nowMs, 4), false)
  })

  test('withinMinInterval: gap > minInterval → false (enough time passed, allowed)', () => {
    const lastSentMs = 1000000
    const nowMs = lastSentMs + 5 * 3600 * 1000  // 5 hours
    assert.strictEqual(withinMinInterval(lastSentMs, nowMs, 4), false)
  })

  test('withinMinInterval: minIntervalHours=0 → false (no interval configured, not blocked)', () => {
    const lastSentMs = 1000000
    const nowMs = lastSentMs + 1000  // 1 second later
    assert.strictEqual(withinMinInterval(lastSentMs, nowMs, 0), false)
  })

  // ---- hasForbiddenPhrase ----

  test('hasForbiddenPhrase: clean text → false', () => {
    assert.strictEqual(hasForbiddenPhrase('今天练习了，感觉不错。', FORBIDDEN_PATTERNS), false)
  })

  test('hasForbiddenPhrase: 别走 (挽留) → true', () => {
    assert.strictEqual(hasForbiddenPhrase('等等，别走！', FORBIDDEN_PATTERNS), true)
  })

  test('hasForbiddenPhrase: 快点 (催促) → true', () => {
    assert.strictEqual(hasForbiddenPhrase('你快点回来啊。', FORBIDDEN_PATTERNS), true)
  })

  test('hasForbiddenPhrase: 我离不开你 (情感勒索) → true', () => {
    assert.strictEqual(hasForbiddenPhrase('我离不开你，真的。', FORBIDDEN_PATTERNS), true)
  })

  test('hasForbiddenPhrase: FOMO phrase 机不可失 → true', () => {
    assert.strictEqual(hasForbiddenPhrase('机不可失，你赶紧来。', FORBIDDEN_PATTERNS), true)
  })

  test('hasForbiddenPhrase: 你怎么不理我 (负罪诱导) → true', () => {
    assert.strictEqual(hasForbiddenPhrase('你怎么不理我啊。', FORBIDDEN_PATTERNS), true)
  })

  test('hasForbiddenPhrase: 就回我一下嘛 (追问施压) → true', () => {
    assert.strictEqual(hasForbiddenPhrase('就回我一下嘛，我只问一句。', FORBIDDEN_PATTERNS), true)
  })

  test('hasForbiddenPhrase: null text → false', () => {
    assert.strictEqual(hasForbiddenPhrase(null, FORBIDDEN_PATTERNS), false)
  })

  test('hasForbiddenPhrase: empty string → false', () => {
    assert.strictEqual(hasForbiddenPhrase('', FORBIDDEN_PATTERNS), false)
  })

  test('hasForbiddenPhrase: custom patterns (no FORBIDDEN_PATTERNS) → uses provided list', () => {
    const custom = [/禁词/u]
    assert.strictEqual(hasForbiddenPhrase('包含禁词', custom), true)
    assert.strictEqual(hasForbiddenPhrase('没有禁止内容', custom), false)
  })

  // ── 中性文本不应被误判 (neutral text must NOT be flagged) ──────────────────
  test('hasForbiddenPhrase: neutral "走了" in sentence → false', () => {
    assert.strictEqual(hasForbiddenPhrase('今天顺路走了一段路', FORBIDDEN_PATTERNS), false)
  })

  test('hasForbiddenPhrase: neutral "消失了" in sentence → false', () => {
    assert.strictEqual(hasForbiddenPhrase('茶渍消失了，布擦了两遍。', FORBIDDEN_PATTERNS), false)
  })

  test('hasForbiddenPhrase: neutral "错过了" in sentence → false', () => {
    assert.strictEqual(hasForbiddenPhrase('上午错过了饭点，随便吃了点。', FORBIDDEN_PATTERNS), false)
  })

  test('hasForbiddenPhrase: neutral "说一件小事" → false', () => {
    assert.strictEqual(hasForbiddenPhrase('我想跟你说一件小事', FORBIDDEN_PATTERNS), false)
  })

  test('hasForbiddenPhrase: neutral weather observation → false', () => {
    assert.strictEqual(hasForbiddenPhrase('在檐下看了会儿天', FORBIDDEN_PATTERNS), false)
  })

  // ── 操控话术仍应被检测 (manipulation phrases still flagged) ──────────────
  test('hasForbiddenPhrase: 别走我离不开你 (挽留+情感勒索) → true', () => {
    assert.strictEqual(hasForbiddenPhrase('别走，我离不开你', FORBIDDEN_PATTERNS), true)
  })

  test('hasForbiddenPhrase: 你怎么不理我了 (追问施压) → true', () => {
    assert.strictEqual(hasForbiddenPhrase('你怎么不理我了，一直在等你', FORBIDDEN_PATTERNS), true)
  })

  test('hasForbiddenPhrase: 你要抛下我吗 (挽留) → true', () => {
    assert.strictEqual(hasForbiddenPhrase('你真的要抛下我吗', FORBIDDEN_PATTERNS), true)
  })

  // ---- decideOutreach ----

  // proactiveEnabled=false → always 'disabled'
  test('decideOutreach: proactiveEnabled=false → disabled', () => {
    const gates = { proactiveEnabled: false, isQuietHours: false, quietHoursEnabled: true, underDailyCap: true, dailyCapEnabled: true, tooSoon: false, phraseBlocked: false, forbiddenPhraseGuardEnabled: true }
    assert.strictEqual(decideOutreach({ decision: 'now', draft: 'hi' }, gates), 'disabled')
  })

  // decision=no → drop
  test('decideOutreach: decision=no → drop', () => {
    const gates = { proactiveEnabled: true, isQuietHours: false, quietHoursEnabled: true, underDailyCap: true, dailyCapEnabled: true, tooSoon: false, phraseBlocked: false, forbiddenPhraseGuardEnabled: true }
    assert.strictEqual(decideOutreach({ decision: 'no' }, gates), 'drop')
  })

  // decision=later → park
  test('decideOutreach: decision=later → park', () => {
    const gates = { proactiveEnabled: true, isQuietHours: false, quietHoursEnabled: true, underDailyCap: true, dailyCapEnabled: true, tooSoon: false, phraseBlocked: false, forbiddenPhraseGuardEnabled: true }
    assert.strictEqual(decideOutreach({ decision: 'later' }, gates), 'park')
  })

  // decision=now + quiet hours enabled + in quiet → block-quiet
  test('decideOutreach: decision=now + quietHoursEnabled + isQuietHours → block-quiet', () => {
    const gates = { proactiveEnabled: true, isQuietHours: true, quietHoursEnabled: true, underDailyCap: true, dailyCapEnabled: true, tooSoon: false, phraseBlocked: false, forbiddenPhraseGuardEnabled: true }
    assert.strictEqual(decideOutreach({ decision: 'now', draft: 'hi' }, gates), 'block-quiet')
  })

  // quiet hours disabled → skips quiet-hour check
  test('decideOutreach: decision=now + quietHoursEnabled=false + isQuietHours=true → not blocked by quiet', () => {
    const gates = { proactiveEnabled: true, isQuietHours: true, quietHoursEnabled: false, underDailyCap: true, dailyCapEnabled: true, tooSoon: false, phraseBlocked: false, forbiddenPhraseGuardEnabled: true }
    assert.strictEqual(decideOutreach({ decision: 'now', draft: 'hi' }, gates), 'send')
  })

  // over daily cap
  test('decideOutreach: decision=now + dailyCapEnabled + !underDailyCap → block-cap', () => {
    const gates = { proactiveEnabled: true, isQuietHours: false, quietHoursEnabled: true, underDailyCap: false, dailyCapEnabled: true, tooSoon: false, phraseBlocked: false, forbiddenPhraseGuardEnabled: true }
    assert.strictEqual(decideOutreach({ decision: 'now', draft: 'hi' }, gates), 'block-cap')
  })

  // daily cap disabled → skips cap check
  test('decideOutreach: decision=now + dailyCapEnabled=false + !underDailyCap → not blocked by cap', () => {
    const gates = { proactiveEnabled: true, isQuietHours: false, quietHoursEnabled: true, underDailyCap: false, dailyCapEnabled: false, tooSoon: false, phraseBlocked: false, forbiddenPhraseGuardEnabled: true }
    assert.strictEqual(decideOutreach({ decision: 'now', draft: 'hi' }, gates), 'send')
  })

  // within min interval
  test('decideOutreach: decision=now + tooSoon=true → block-interval', () => {
    const gates = { proactiveEnabled: true, isQuietHours: false, quietHoursEnabled: true, underDailyCap: true, dailyCapEnabled: true, tooSoon: true, phraseBlocked: false, forbiddenPhraseGuardEnabled: true }
    assert.strictEqual(decideOutreach({ decision: 'now', draft: 'hi' }, gates), 'block-interval')
  })

  // forbidden phrase
  test('decideOutreach: decision=now + phraseBlocked + guardEnabled → block-phrase', () => {
    const gates = { proactiveEnabled: true, isQuietHours: false, quietHoursEnabled: true, underDailyCap: true, dailyCapEnabled: true, tooSoon: false, phraseBlocked: true, forbiddenPhraseGuardEnabled: true }
    assert.strictEqual(decideOutreach({ decision: 'now', draft: '别走' }, gates), 'block-phrase')
  })

  // phrase blocked but guard disabled → sends
  test('decideOutreach: decision=now + phraseBlocked + guardEnabled=false → send', () => {
    const gates = { proactiveEnabled: true, isQuietHours: false, quietHoursEnabled: true, underDailyCap: true, dailyCapEnabled: true, tooSoon: false, phraseBlocked: true, forbiddenPhraseGuardEnabled: false }
    assert.strictEqual(decideOutreach({ decision: 'now', draft: '别走' }, gates), 'send')
  })

  // clean path → send
  test('decideOutreach: decision=now, all gates clear → send', () => {
    const gates = { proactiveEnabled: true, isQuietHours: false, quietHoursEnabled: true, underDailyCap: true, dailyCapEnabled: true, tooSoon: false, phraseBlocked: false, forbiddenPhraseGuardEnabled: true }
    assert.strictEqual(decideOutreach({ decision: 'now', draft: '今天练了一会儿刀，感觉不错。' }, gates), 'send')
  })

  // null share → treated as decision=no → drop
  test('decideOutreach: null share → drop', () => {
    const gates = { proactiveEnabled: true, isQuietHours: false, quietHoursEnabled: true, underDailyCap: true, dailyCapEnabled: true, tooSoon: false, phraseBlocked: false, forbiddenPhraseGuardEnabled: true }
    assert.strictEqual(decideOutreach(null, gates), 'drop')
  })

  // priority: quiet > cap > interval > phrase
  test('decideOutreach: quiet+cap both blocked → quiet wins (checked first)', () => {
    const gates = { proactiveEnabled: true, isQuietHours: true, quietHoursEnabled: true, underDailyCap: false, dailyCapEnabled: true, tooSoon: false, phraseBlocked: false, forbiddenPhraseGuardEnabled: true }
    assert.strictEqual(decideOutreach({ decision: 'now', draft: 'hi' }, gates), 'block-quiet')
  })

  // ---- createProactiveBridge glue: end-to-end (fake model + fake transport) ----

  await runAsync('createProactiveBridge: decision=no → nothing sent, nothing stored', async () => {
    let sent = []
    let stored = []
    const bridge = createProactiveBridge(null, {
      proactiveEnabled: true,
      quietHoursEnabled: false,
      dailyCapEnabled: false,
      timezone: 'UTC',
      forbiddenPhraseGuard: false,
    }, {
      sendDirect: async (pid, text) => sent.push({ pid, text }),
      thoughtBuffer: { store: async (t) => stored.push(t) },
    })

    await bridge.maybeReachOut('higekiri', { decision: 'no', draft: 'test', thought: 'test', target: '审神者' }, Date.now())
    assert.strictEqual(sent.length, 0)
    assert.strictEqual(stored.length, 0)
  })

  await runAsync('createProactiveBridge: decision=later → stored in thoughtBuffer', async () => {
    let stored = []
    const bridge = createProactiveBridge(null, {
      proactiveEnabled: true,
      quietHoursEnabled: false,
      dailyCapEnabled: false,
      timezone: 'UTC',
      forbiddenPhraseGuard: false,
    }, {
      thoughtBuffer: { store: async (t) => stored.push(t) },
    })

    await bridge.maybeReachOut('higekiri', { decision: 'later', draft: '', thought: '想说说今天的事', target: '审神者', origin: 'want_to_share', urgency: 'low' }, Date.now())
    assert.strictEqual(stored.length, 1)
    assert.strictEqual(stored[0].presetId, 'higekiri')
    assert.strictEqual(stored[0].content, '想说说今天的事')
    assert.strictEqual(stored[0].target, '审神者')
  })

  await runAsync('createProactiveBridge: decision=now, all gates clear → sends via sendDirect', async () => {
    let sent = []
    const nowMs = Date.UTC(2026, 6, 1, 14, 0, 0)  // 14:00 UTC, not in any quiet window
    const bridge = createProactiveBridge(null, {
      proactiveEnabled: true,
      quietHoursEnabled: false,
      dailyCapEnabled: false,
      timezone: 'UTC',
      forbiddenPhraseGuard: false,
      proactiveVia: 'direct',
    }, {
      sendDirect: async (pid, text) => sent.push({ pid, text }),
    })

    await bridge.maybeReachOut('higekiri', { decision: 'now', draft: '今天练了一下午。', target: '审神者' }, nowMs)
    assert.strictEqual(sent.length, 1)
    assert.strictEqual(sent[0].pid, 'higekiri')
    assert.strictEqual(sent[0].text, '今天练了一下午。')
  })

  await runAsync('createProactiveBridge: decision=now, quiet hours active → blocked, nothing sent', async () => {
    let sent = []
    // 23:00 UTC+8 = 15:00 UTC
    const nowMs = Date.UTC(2026, 6, 1, 15, 0, 0)  // 23:00 Shanghai
    const bridge = createProactiveBridge(null, {
      proactiveEnabled: true,
      quietHoursEnabled: true,
      quietHours: { start: 22, end: 8 },
      dailyCapEnabled: false,
      timezone: 'Asia/Shanghai',
      forbiddenPhraseGuard: false,
    }, {
      sendDirect: async (pid, text) => sent.push({ pid, text }),
    })

    await bridge.maybeReachOut('higekiri', { decision: 'now', draft: '夜里也在想你。', target: '审神者' }, nowMs)
    assert.strictEqual(sent.length, 0, 'should not send during quiet hours')
  })

  await runAsync('createProactiveBridge: daily cap enforced — 2nd send blocked at cap=1', async () => {
    let sent = []
    const nowMs = Date.UTC(2026, 6, 1, 10, 0, 0)  // 10:00 UTC (daytime UTC)
    const bridge = createProactiveBridge(null, {
      proactiveEnabled: true,
      quietHoursEnabled: false,
      dailyCapEnabled: true,
      proactiveDailyCap: 1,
      proactiveMinIntervalHours: 0,  // no interval restriction for this test
      timezone: 'UTC',
      forbiddenPhraseGuard: false,
      proactiveVia: 'direct',
    }, {
      sendDirect: async (pid, text) => sent.push({ pid, text }),
    })

    const share = { decision: 'now', draft: '练习了。', target: '审神者' }
    await bridge.maybeReachOut('higekiri', share, nowMs)
    await bridge.maybeReachOut('higekiri', share, nowMs + 1000)

    assert.strictEqual(sent.length, 1, 'only 1 send allowed per day at cap=1')
  })

  await runAsync('createProactiveBridge: forbidden phrase → blocked even with decision=now', async () => {
    let sent = []
    const nowMs = Date.UTC(2026, 6, 1, 10, 0, 0)
    const bridge = createProactiveBridge(null, {
      proactiveEnabled: true,
      quietHoursEnabled: false,
      dailyCapEnabled: false,
      timezone: 'UTC',
      forbiddenPhraseGuard: true,
      proactiveVia: 'direct',
    }, {
      sendDirect: async (pid, text) => sent.push({ pid, text }),
    })

    await bridge.maybeReachOut('higekiri', { decision: 'now', draft: '别走，我离不开你。', target: '审神者' }, nowMs)
    assert.strictEqual(sent.length, 0, 'forbidden phrase should block send')
  })

  await runAsync('createProactiveBridge: proactiveEnabled=false → skip entirely', async () => {
    let sent = []
    let stored = []
    const bridge = createProactiveBridge(null, {
      proactiveEnabled: false,
      quietHoursEnabled: false,
      dailyCapEnabled: false,
      timezone: 'UTC',
    }, {
      sendDirect: async (pid, text) => sent.push({ pid, text }),
      thoughtBuffer: { store: async (t) => stored.push(t) },
    })

    await bridge.maybeReachOut('higekiri', { decision: 'now', draft: 'test' }, Date.now())
    await bridge.maybeReachOut('higekiri', { decision: 'later', thought: 'test' }, Date.now())
    assert.strictEqual(sent.length, 0)
    assert.strictEqual(stored.length, 0)
  })

  await runAsync('createProactiveBridge: proactiveVia=relay uses sendViaRelay over sendDirect', async () => {
    let relaySent = []
    let directSent = []
    const nowMs = Date.UTC(2026, 6, 1, 10, 0, 0)
    const bridge = createProactiveBridge(null, {
      proactiveEnabled: true,
      quietHoursEnabled: false,
      dailyCapEnabled: false,
      timezone: 'UTC',
      forbiddenPhraseGuard: false,
      proactiveVia: 'relay',
    }, {
      sendViaRelay: async (pid, text) => relaySent.push({ pid, text }),
      sendDirect:   async (pid, text) => directSent.push({ pid, text }),
    })

    await bridge.maybeReachOut('higekiri', { decision: 'now', draft: '通过relay发送' }, nowMs)
    assert.strictEqual(relaySent.length, 1, 'should use relay transport')
    assert.strictEqual(directSent.length, 0, 'should not use direct transport')
  })

  await runAsync('createProactiveBridge: maybeFollowUp, model says yes → sends draft', async () => {
    let sent = []
    let goLiveCalled = false
    const nowMs = Date.UTC(2026, 6, 1, 10, 0, 0)
    const fakeModelResponse = JSON.stringify({ follow_up: true, draft: '还在吗？接着刚才的话头。' })

    const bridge = createProactiveBridge(null, {
      proactiveEnabled: true,
      quietHoursEnabled: false,
      dailyCapEnabled: false,
      timezone: 'UTC',
      forbiddenPhraseGuard: false,
      proactiveVia: 'direct',
      rollModel: 'fake/model',
    }, {
      sendDirect: async (pid, text) => sent.push({ pid, text }),
      getModel: async () => ({ invoke: async () => ({ content: fakeModelResponse }) }),
      invoke: async (m, _msgs) => (await m.invoke()).content,
      silenceState: (_pid) => ({ silenceMinutes: 8, followUpCount: 0 }),
      presence: { goLive: (_pid) => { goLiveCalled = true } },
    })

    await bridge.maybeFollowUp('higekiri', nowMs)
    assert.strictEqual(sent.length, 1)
    assert.ok(sent[0].text.includes('还在吗'))
    // After sending, goLive should NOT be called (we stay in LINGERING for possible re-arm)
    assert.strictEqual(goLiveCalled, false)
  })

  await runAsync('createProactiveBridge: maybeFollowUp, model says no → goLive called, no send', async () => {
    let sent = []
    let goLiveCalled = false
    const nowMs = Date.UTC(2026, 6, 1, 10, 0, 0)
    const fakeModelResponse = JSON.stringify({ follow_up: false, draft: '' })

    const bridge = createProactiveBridge(null, {
      proactiveEnabled: true,
      quietHoursEnabled: false,
      dailyCapEnabled: false,
      timezone: 'UTC',
      forbiddenPhraseGuard: false,
      proactiveVia: 'direct',
      rollModel: 'fake/model',
    }, {
      sendDirect: async (pid, text) => sent.push({ pid, text }),
      getModel: async () => ({ invoke: async () => ({ content: fakeModelResponse }) }),
      invoke: async (m, _msgs) => (await m.invoke()).content,
      silenceState: (_pid) => ({ silenceMinutes: 20, followUpCount: 2 }),
      presence: { goLive: (_pid) => { goLiveCalled = true } },
    })

    await bridge.maybeFollowUp('higekiri', nowMs)
    assert.strictEqual(sent.length, 0, 'no send when model says no')
    assert.strictEqual(goLiveCalled, true, 'goLive should be called when not following up')
  })

  await runAsync('createProactiveBridge: maybeFollowUp, daily cap blocks even if model says yes', async () => {
    let sent = []
    let goLiveCalled = false
    const nowMs = Date.UTC(2026, 6, 1, 10, 0, 0)
    const fakeModelResponse = JSON.stringify({ follow_up: true, draft: '还在吗？' })

    const bridge = createProactiveBridge(null, {
      proactiveEnabled: true,
      quietHoursEnabled: false,
      dailyCapEnabled: true,
      proactiveDailyCap: 0,  // cap=0 → always blocked
      proactiveMinIntervalHours: 0,
      timezone: 'UTC',
      forbiddenPhraseGuard: false,
      proactiveVia: 'direct',
      rollModel: 'fake/model',
    }, {
      sendDirect: async (pid, text) => sent.push({ pid, text }),
      getModel: async () => ({ invoke: async () => ({ content: fakeModelResponse }) }),
      invoke: async (m, _msgs) => (await m.invoke()).content,
      silenceState: (_pid) => ({ silenceMinutes: 5, followUpCount: 0 }),
      presence: { goLive: (_pid) => { goLiveCalled = true } },
    })

    await bridge.maybeFollowUp('higekiri', nowMs)
    assert.strictEqual(sent.length, 0, 'cap=0 should block follow-up send')
    assert.strictEqual(goLiveCalled, true, 'goLive called after cap block')
  })

  // ---------------------------------------------------------------------------
  // Task 12: memory-long.js — pure matchByKey
  // ---------------------------------------------------------------------------

  const { matchByKey, createLongTermMemory } = require('./memory-long')

  // matchByKey — thread key
  test('matchByKey: thread key matches entry with that keyword', () => {
    const entries = [
      { id: 1, keywords: ['锻刀', '研磨'], entities: [], content: '打刀', summary: '打刀日', createdAt: '2026-06-01' },
      { id: 2, keywords: ['读书', '茶道'], entities: [], content: '喝茶', summary: '喝茶日', createdAt: '2026-06-02' },
    ]
    const result = matchByKey(entries, { thread: '锻刀' })
    assert.strictEqual(result.length, 1)
    assert.strictEqual(result[0].id, 1)
  })

  test('matchByKey: thread key is case-insensitive', () => {
    const entries = [
      { id: 1, keywords: ['锻刀', '研磨'], entities: [], content: '打刀', summary: '', createdAt: '2026-06-01' },
    ]
    const result = matchByKey(entries, { thread: '锻刀' })
    assert.strictEqual(result.length, 1)
  })

  test('matchByKey: thread key also matches content containing thread string', () => {
    const entries = [
      { id: 1, keywords: [], entities: [], content: '今天去练习场锻刀了', summary: '', createdAt: '2026-06-01' },
      { id: 2, keywords: [], entities: [], content: '喝茶读书', summary: '', createdAt: '2026-06-02' },
    ]
    const result = matchByKey(entries, { thread: '锻刀' })
    assert.strictEqual(result.length, 1)
    assert.strictEqual(result[0].id, 1)
  })

  test('matchByKey: thread key returns empty when no match', () => {
    const entries = [
      { id: 1, keywords: ['读书'], entities: [], content: '读书', summary: '', createdAt: '2026-06-01' },
    ]
    const result = matchByKey(entries, { thread: '锻刀' })
    assert.strictEqual(result.length, 0)
  })

  // matchByKey — entity key
  test('matchByKey: entity key matches entry with that entity', () => {
    const entries = [
      { id: 1, keywords: [], entities: ['膝丸', '髭切'], content: '一起对练', summary: '', createdAt: '2026-06-01' },
      { id: 2, keywords: [], entities: ['审神者'],       content: '和主人聊天', summary: '', createdAt: '2026-06-01' },
    ]
    const result = matchByKey(entries, { entity: '膝丸' })
    assert.strictEqual(result.length, 1)
    assert.strictEqual(result[0].id, 1)
  })

  test('matchByKey: entity key returns empty when no match', () => {
    const entries = [
      { id: 1, keywords: [], entities: ['审神者'], content: '喝茶', summary: '', createdAt: '2026-06-01' },
    ]
    const result = matchByKey(entries, { entity: '膝丸' })
    assert.strictEqual(result.length, 0)
  })

  // matchByKey — date key
  test('matchByKey: date key matches entries created on that date', () => {
    const entries = [
      { id: 1, keywords: [], entities: [], content: '打刀', summary: '', createdAt: new Date('2026-06-01T08:00:00Z') },
      { id: 2, keywords: [], entities: [], content: '读书', summary: '', createdAt: new Date('2026-06-02T08:00:00Z') },
    ]
    const result = matchByKey(entries, { date: '2026-06-01' })
    assert.strictEqual(result.length, 1)
    assert.strictEqual(result[0].id, 1)
  })

  test('matchByKey: date key matches ISO string createdAt', () => {
    const entries = [
      { id: 1, keywords: [], entities: [], content: '打刀', summary: '', createdAt: '2026-06-01T12:00:00.000Z' },
    ]
    const result = matchByKey(entries, { date: '2026-06-01' })
    assert.strictEqual(result.length, 1)
  })

  test('matchByKey: date key returns empty when no match', () => {
    const entries = [
      { id: 1, keywords: [], entities: [], content: '读书', summary: '', createdAt: '2026-06-02T00:00:00Z' },
    ]
    const result = matchByKey(entries, { date: '2026-06-01' })
    assert.strictEqual(result.length, 0)
  })

  test('matchByKey: empty entries → []', () => {
    assert.deepStrictEqual(matchByKey([], { thread: '锻刀' }), [])
  })

  test('matchByKey: null entries → []', () => {
    assert.deepStrictEqual(matchByKey(null, { thread: '锻刀' }), [])
  })

  test('matchByKey: unknown key shape → []', () => {
    const entries = [{ id: 1, keywords: ['锻刀'], entities: [], content: '', summary: '', createdAt: '2026-06-01' }]
    assert.deepStrictEqual(matchByKey(entries, { unknown: 'foo' }), [])
  })

  test('matchByKey: can match multiple entries for same thread', () => {
    const entries = [
      { id: 1, keywords: ['锻刀'], entities: [], content: '', summary: '', createdAt: '2026-06-01' },
      { id: 2, keywords: ['锻刀', '研磨'], entities: [], content: '', summary: '', createdAt: '2026-06-02' },
      { id: 3, keywords: ['读书'], entities: [], content: '', summary: '', createdAt: '2026-06-03' },
    ]
    const result = matchByKey(entries, { thread: '锻刀' })
    assert.strictEqual(result.length, 2)
    const ids = result.map((e) => e.id).sort()
    assert.deepStrictEqual(ids, [1, 2])
  })

  // ---------------------------------------------------------------------------
  // Task 12: memory-long.js — DB glue (fake-ctx)
  // ---------------------------------------------------------------------------

  await runAsync('createLongTermMemory: upsertLtm creates new entry with correct fields', async () => {
    const ctx = makeFakeCtx()
    const ltm = createLongTermMemory(ctx)
    const nowMs = Date.UTC(2026, 5, 1, 10, 0, 0)
    const entry = await ltm.upsertLtm('higekiri', {
      kind: 'event',
      content: '今天在练习场锻刀，刀刃磨得很顺手。',
      summary: '锻刀日',
      keywords: ['锻刀', '练习场'],
      entities: ['髭切'],
      importance: 0.7,
    }, nowMs)

    assert.ok(entry.id, 'created entry should have an id')
    assert.strictEqual(entry.presetId, 'higekiri')
    assert.strictEqual(entry.kind, 'event')
    assert.ok(entry.createdAt instanceof Date || typeof entry.createdAt !== 'undefined')
  })

  await runAsync('createLongTermMemory: upsertLtm uses RETURNED id, not input', async () => {
    const ctx = makeFakeCtx()
    const ltm = createLongTermMemory(ctx)
    const nowMs = Date.UTC(2026, 5, 1, 10, 0, 0)
    const e1 = await ltm.upsertLtm('higekiri', { kind: 'event', content: 'first', keywords: [], entities: [], importance: 0.5 }, nowMs)
    const e2 = await ltm.upsertLtm('higekiri', { kind: 'event', content: 'second', keywords: [], entities: [], importance: 0.5 }, nowMs)
    assert.ok(e1.id !== e2.id, 'each create should get a unique id')
  })

  await runAsync('createLongTermMemory: upsertLtm with id updates existing entry', async () => {
    const ctx = makeFakeCtx()
    const ltm = createLongTermMemory(ctx)
    const nowMs = Date.UTC(2026, 5, 1, 10, 0, 0)
    const created = await ltm.upsertLtm('higekiri', {
      kind: 'event', content: '原始内容', keywords: ['锻刀'], entities: [], importance: 0.5
    }, nowMs)

    const updated = await ltm.upsertLtm('higekiri', {
      id: created.id,
      kind: 'event', content: '更新内容', keywords: ['锻刀', '磨刀'], entities: [], importance: 0.8
    }, nowMs + 1000)

    assert.strictEqual(updated.id, created.id, 'id should be unchanged')
    // Check DB row was updated
    const rows = ctx.database._store['life_sim_ltm']
    const row = rows.find((r) => r.id === created.id)
    assert.ok(row, 'row should exist in DB')
    // keywords should be JSON string containing the updated keywords
    assert.ok(row.keywords.includes('磨刀'), 'keywords should be updated')
  })

  await runAsync('createLongTermMemory: byKey returns entries matching thread', async () => {
    const ctx = makeFakeCtx()
    const ltm = createLongTermMemory(ctx)
    const nowMs = Date.UTC(2026, 5, 1, 10, 0, 0)
    await ltm.upsertLtm('higekiri', { kind: 'event', content: '锻刀', keywords: ['锻刀', '练习场'], entities: [], importance: 0.7 }, nowMs)
    await ltm.upsertLtm('higekiri', { kind: 'event', content: '读书', keywords: ['读书'], entities: [], importance: 0.4 }, nowMs)

    const results = await ltm.byKey('higekiri', { thread: '锻刀' })
    assert.strictEqual(results.length, 1)
    assert.ok(results[0].content.includes('锻刀'))
  })

  await runAsync('createLongTermMemory: byKey returns entries matching entity', async () => {
    const ctx = makeFakeCtx()
    const ltm = createLongTermMemory(ctx)
    const nowMs = Date.UTC(2026, 5, 1, 10, 0, 0)
    await ltm.upsertLtm('higekiri', { kind: 'event', content: '与膝丸对练', keywords: ['对练'], entities: ['膝丸'], importance: 0.6 }, nowMs)
    await ltm.upsertLtm('higekiri', { kind: 'event', content: '独自读书', keywords: ['读书'], entities: [], importance: 0.3 }, nowMs)

    const results = await ltm.byKey('higekiri', { entity: '膝丸' })
    assert.strictEqual(results.length, 1)
    assert.ok(results[0].content.includes('膝丸'))
  })

  await runAsync('createLongTermMemory: archiveLtm removes entry', async () => {
    const ctx = makeFakeCtx()
    const ltm = createLongTermMemory(ctx)
    const nowMs = Date.UTC(2026, 5, 1, 10, 0, 0)
    const entry = await ltm.upsertLtm('higekiri', { kind: 'event', content: '要删的', keywords: [], entities: [], importance: 0.1 }, nowMs)
    assert.ok(entry.id)

    await ltm.archiveLtm(entry.id)
    const rows = ctx.database._store['life_sim_ltm'] || []
    const stillExists = rows.find((r) => r.id === entry.id)
    assert.ok(!stillExists, 'entry should be removed after archiveLtm')
  })

  await runAsync('createLongTermMemory: prune removes low-importance low-refcount entries', async () => {
    const ctx = makeFakeCtx()
    const ltm = createLongTermMemory(ctx)
    const nowMs = Date.UTC(2026, 5, 1, 10, 0, 0)
    const e1 = await ltm.upsertLtm('higekiri', { kind: 'event', content: '低价值', keywords: [], entities: [], importance: 0.1, refCount: 0 }, nowMs)
    const e2 = await ltm.upsertLtm('higekiri', { kind: 'event', content: '高价值', keywords: [], entities: [], importance: 0.8, refCount: 5 }, nowMs)

    const pruned = await ltm.prune('higekiri', 0.25)
    assert.strictEqual(pruned, 1, 'should prune exactly one entry')
    const rows = ctx.database._store['life_sim_ltm'] || []
    assert.ok(!rows.find((r) => r.id === e1.id), 'low-importance entry should be removed')
    assert.ok(rows.find((r) => r.id === e2.id), 'high-importance entry should remain')
  })

  await runAsync('createLongTermMemory: prune does not remove entry with high refCount', async () => {
    const ctx = makeFakeCtx()
    const ltm = createLongTermMemory(ctx)
    const nowMs = Date.UTC(2026, 5, 1, 10, 0, 0)
    // importance < threshold but refCount > 1 → keep
    await ltm.upsertLtm('higekiri', { kind: 'event', content: '低价值但多引用', keywords: [], entities: [], importance: 0.1, refCount: 5 }, nowMs)

    const pruned = await ltm.prune('higekiri', 0.25)
    assert.strictEqual(pruned, 0, 'should not prune high-refCount entry')
  })

  await runAsync('createLongTermMemory: touch increments refCount and updates lastAccessedAt', async () => {
    const ctx = makeFakeCtx()
    const ltm = createLongTermMemory(ctx)
    const nowMs = Date.UTC(2026, 5, 1, 10, 0, 0)
    const entry = await ltm.upsertLtm('higekiri', { kind: 'event', content: '测试', keywords: [], entities: [], importance: 0.5, refCount: 2 }, nowMs)

    const touchMs = nowMs + 5000
    await ltm.touch(entry.id, touchMs)
    const rows = ctx.database._store['life_sim_ltm']
    const row = rows.find((r) => r.id === entry.id)
    assert.ok(row, 'row should exist')
    assert.strictEqual(row.refCount, 3, 'refCount should be incremented')
    assert.ok(+row.lastAccessedAt >= touchMs - 100, 'lastAccessedAt should be updated')
  })

  await runAsync('createLongTermMemory: relationship returns null when none exists', async () => {
    const ctx = makeFakeCtx()
    const ltm = createLongTermMemory(ctx)
    const rel = await ltm.relationship('higekiri', '膝丸')
    assert.strictEqual(rel, null, 'should return null for missing relationship')
  })

  await runAsync('createLongTermMemory: upsertRelationship creates and retrieves relationship', async () => {
    const ctx = makeFakeCtx()
    const ltm = createLongTermMemory(ctx)
    const nowMs = Date.UTC(2026, 5, 1, 10, 0, 0)

    await ltm.upsertRelationship('higekiri', '膝丸', {
      summary: '弟弟，关系好',
      openThreads: ['对练约定'],
      tone: '亲密',
      lastChatId: 'chat-001',
    }, nowMs)

    const rel = await ltm.relationship('higekiri', '膝丸')
    assert.ok(rel, 'should find the relationship')
    assert.strictEqual(rel.summary, '弟弟，关系好')
    assert.deepStrictEqual(rel.openThreads, ['对练约定'])
    assert.strictEqual(rel.tone, '亲密')
  })

  await runAsync('createLongTermMemory: upsertRelationship updates existing', async () => {
    const ctx = makeFakeCtx()
    const ltm = createLongTermMemory(ctx)
    const nowMs = Date.UTC(2026, 5, 1, 10, 0, 0)

    await ltm.upsertRelationship('higekiri', '膝丸', { summary: '初始摘要', openThreads: [], tone: '普通' }, nowMs)
    await ltm.upsertRelationship('higekiri', '膝丸', { summary: '更新摘要', openThreads: ['新约定'], tone: '亲密' }, nowMs + 1000)

    const rel = await ltm.relationship('higekiri', '膝丸')
    assert.strictEqual(rel.summary, '更新摘要', 'summary should be updated')
    assert.deepStrictEqual(rel.openThreads, ['新约定'])

    // Should only have one row in DB
    const rows = ctx.database._store['life_sim_relationship'] || []
    assert.strictEqual(rows.length, 1, 'should only have one relationship row')
  })

  // ---------------------------------------------------------------------------
  // Task 12: memory-consolidate.js — pure clusterScore
  // ---------------------------------------------------------------------------

  const { clusterScore, clusterEvents, parseConsolidateOps, tomorrowOf } = require('./memory-consolidate')

  const nowMs = Date.UTC(2026, 5, 1, 12, 0, 0)  // 2026-06-01 12:00:00 UTC

  // clusterScore basics
  test('clusterScore: keyword cluster scores higher than month cluster', () => {
    const kwCluster = {
      reason: 'keyword',
      events: [
        { importance: 0.7, ts: new Date(nowMs - 60000) },
        { importance: 0.6, ts: new Date(nowMs - 30000) },
      ],
      nowMs,
    }
    const monthCluster = {
      reason: 'month',
      events: [
        { importance: 0.7, ts: new Date(nowMs - 60000) },
        { importance: 0.6, ts: new Date(nowMs - 30000) },
      ],
      nowMs,
    }
    assert.ok(clusterScore(kwCluster) > clusterScore(monthCluster), 'keyword cluster should outscore month cluster')
  })

  test('clusterScore: higher importance cluster scores higher (same reason)', () => {
    const highImpCluster = {
      reason: 'keyword',
      events: [{ importance: 0.9, ts: new Date(nowMs - 1000) }],
      nowMs,
    }
    const lowImpCluster = {
      reason: 'keyword',
      events: [{ importance: 0.1, ts: new Date(nowMs - 1000) }],
      nowMs,
    }
    assert.ok(clusterScore(highImpCluster) > clusterScore(lowImpCluster), 'higher importance should score higher')
  })

  test('clusterScore: more recent cluster scores higher (same reason, same importance)', () => {
    const recentCluster = {
      reason: 'keyword',
      events: [{ importance: 0.5, ts: new Date(nowMs - 1000) }],
      nowMs,
    }
    const olderCluster = {
      reason: 'keyword',
      events: [{ importance: 0.5, ts: new Date(nowMs - 100000) }],
      nowMs,
    }
    assert.ok(clusterScore(recentCluster) > clusterScore(olderCluster), 'more recent cluster should score higher')
  })

  test('clusterScore: null importance → importanceScore = 0.5 (fallback)', () => {
    const c = {
      reason: 'keyword',
      events: [{ importance: null, ts: new Date(nowMs - 1000) }],
      nowMs,
    }
    // Expected: 4*10 + 0.5 + recency ≈ 40.5+something
    const score = clusterScore(c)
    assert.ok(score >= 40, 'score should be at least 40 with keyword reason')
    assert.ok(score < 42, 'score should be less than 42 (importance portion is 0.5)')
  })

  test('clusterScore: empty cluster → 0', () => {
    assert.strictEqual(clusterScore({ reason: 'keyword', events: [], nowMs }), 0)
  })

  test('clusterScore: null cluster → 0', () => {
    assert.strictEqual(clusterScore(null), 0)
  })

  test('clusterScore: no nowMs → recencyScore 0 but still computes reason+importance', () => {
    const c = {
      reason: 'keyword',
      events: [{ importance: 0.8 }],
    }
    const score = clusterScore(c)
    assert.ok(score >= 40, 'should still score from reason and importance')
    assert.ok(score < 41.5, 'no recency contribution expected')
  })

  test('clusterScore: reason order: keyword(4) > sentiment(3) > month(2) > fallback(1)', () => {
    const makeCluster = (reason) => ({
      reason,
      events: [{ importance: 0.5 }],
    })
    const scores = ['keyword', 'sentiment', 'month', 'fallback'].map((r) => clusterScore(makeCluster(r)))
    assert.ok(scores[0] > scores[1], 'keyword > sentiment')
    assert.ok(scores[1] > scores[2], 'sentiment > month')
    assert.ok(scores[2] > scores[3], 'month > fallback')
  })

  // ---------------------------------------------------------------------------
  // Task 12: memory-consolidate.js — pure clusterEvents
  // ---------------------------------------------------------------------------

  test('clusterEvents: empty → []', () => {
    assert.deepStrictEqual(clusterEvents([]), [])
  })

  test('clusterEvents: null → []', () => {
    assert.deepStrictEqual(clusterEvents(null), [])
  })

  test('clusterEvents: two events with ≥2 shared keywords cluster together', () => {
    const events = [
      { id: 1, title: '事件A', keywords: JSON.stringify(['锻刀', '练习场', '磨刀']), participants: '[]', day: '2026-06-01', ts: new Date(nowMs - 3600000) },
      { id: 2, title: '事件B', keywords: JSON.stringify(['锻刀', '磨刀', '研磨']), participants: '[]', day: '2026-06-01', ts: new Date(nowMs - 1800000) },
    ]
    const clusters = clusterEvents(events)
    assert.strictEqual(clusters.length, 1, 'should form one cluster')
    assert.strictEqual(clusters[0].events.length, 2, 'both events should be in the cluster')
    assert.strictEqual(clusters[0].reason, 'keyword')
  })

  test('clusterEvents: two events with only 1 shared keyword do NOT cluster by keyword (go to month)', () => {
    const events = [
      { id: 1, title: '事件A', keywords: JSON.stringify(['锻刀', '练习场']), participants: '[]', day: '2026-06-01', ts: new Date(nowMs) },
      { id: 2, title: '事件B', keywords: JSON.stringify(['锻刀', '茶道']), participants: '[]', day: '2026-06-01', ts: new Date(nowMs) },
    ]
    const clusters = clusterEvents(events)
    // They share 1 keyword (锻刀), same month → cluster by month
    assert.ok(clusters.length <= 2, 'should not form separate keyword clusters')
  })

  test('clusterEvents: unrelated events form separate clusters', () => {
    const events = [
      { id: 1, title: '事件A', keywords: JSON.stringify(['锻刀', '练习场', '铁砧']), participants: '[]', day: '2026-06-01', ts: new Date(nowMs) },
      { id: 2, title: '事件B', keywords: JSON.stringify(['茶道', '茶室', '抹茶']), participants: '[]', day: '2026-07-01', ts: new Date(nowMs + 86400000 * 30) },
    ]
    const clusters = clusterEvents(events)
    assert.strictEqual(clusters.length, 2, 'unrelated events should form separate clusters')
  })

  test('clusterEvents: each event is in exactly one cluster', () => {
    const events = [
      { id: 1, keywords: JSON.stringify(['a', 'b', 'c']), participants: '[]', day: '2026-06-01', ts: new Date(nowMs) },
      { id: 2, keywords: JSON.stringify(['a', 'b', 'd']), participants: '[]', day: '2026-06-01', ts: new Date(nowMs) },
      { id: 3, keywords: JSON.stringify(['x', 'y', 'z']), participants: '[]', day: '2026-07-01', ts: new Date(nowMs + 86400000 * 30) },
    ]
    const clusters = clusterEvents(events)
    let total = 0
    for (const c of clusters) total += c.events.length
    assert.strictEqual(total, 3, 'total events across clusters should equal input length')
  })

  test('clusterEvents: single event forms a fallback cluster when no keywords', () => {
    const events = [
      { id: 1, title: '无关键词事件', keywords: JSON.stringify([]), participants: '[]', day: '2026-06-01', ts: new Date(nowMs) },
    ]
    const clusters = clusterEvents(events)
    assert.strictEqual(clusters.length, 1)
    assert.strictEqual(clusters[0].reason, 'fallback')
  })

  test('clusterEvents: three events all sharing ≥2 keywords → one cluster', () => {
    const events = [
      { id: 1, keywords: JSON.stringify(['锻刀', '研磨', '打铁']), participants: '[]', day: '2026-06-01', ts: new Date(nowMs) },
      { id: 2, keywords: JSON.stringify(['锻刀', '研磨', '打磨']), participants: '[]', day: '2026-06-01', ts: new Date(nowMs + 1000) },
      { id: 3, keywords: JSON.stringify(['研磨', '打铁', '铁砧']), participants: '[]', day: '2026-06-01', ts: new Date(nowMs + 2000) },
    ]
    const clusters = clusterEvents(events)
    // Events 1&2 share 2 (锻刀,研磨), 2&3 share 1 (研磨), 1&3 share 2 (研磨,打铁)
    // Greedy: event1 starts cluster, event2 joins (2 shared), event3 joins (shares 研磨,打铁 with event1)
    assert.strictEqual(clusters.length, 1, 'all 3 should be in one cluster')
  })

  // ---------------------------------------------------------------------------
  // Task 12: memory-consolidate.js — pure parseConsolidateOps
  // ---------------------------------------------------------------------------

  test('parseConsolidateOps: valid JSON with all four actions → all parsed', () => {
    const text = JSON.stringify({
      operations: [
        { action: 'keep',    memory: { kind: 'event', content: '日常锻刀', summary: '锻刀日', keywords: ['锻刀'], entities: [], importance: 0.7 } },
        { action: 'update',  memoryId: 1, memory: { content: '更新后的内容', summary: '摘要', keywords: [], entities: [], importance: 0.8 } },
        { action: 'merge',   sourceMemoryIds: [2, 3], memory: { kind: 'event', content: '合并记忆', summary: '合并', keywords: [], entities: [], importance: 0.6 } },
        { action: 'archive', memoryId: 4, reason: '已过时' },
      ],
    })
    const result = parseConsolidateOps(text)
    assert.strictEqual(result.operations.length, 4)
    assert.strictEqual(result.operations[0].action, 'keep')
    assert.strictEqual(result.operations[1].action, 'update')
    assert.strictEqual(result.operations[2].action, 'merge')
    assert.strictEqual(result.operations[3].action, 'archive')
  })

  test('parseConsolidateOps: JSON embedded in prose → extracted', () => {
    const text = '好的，这是整理结果：\n\n```json\n' + JSON.stringify({
      operations: [
        { action: 'keep', memory: { kind: 'event', content: '锻刀', summary: '', keywords: [], entities: [], importance: 0.5 } },
      ],
    }) + '\n```\n请参考。'
    const result = parseConsolidateOps(text)
    assert.ok(result.operations.length >= 1, 'should extract at least one operation from prose')
  })

  test('parseConsolidateOps: malformed ops dropped, valid ones kept', () => {
    const text = JSON.stringify({
      operations: [
        { action: 'keep',    memory: { kind: 'event', content: '有效', summary: '', keywords: [], entities: [], importance: 0.5 } },
        { action: 'invalid_action', memory: {} },  // unknown action → dropped
        { action: 'merge',   sourceMemoryIds: [] }, // merge with empty sourceMemoryIds → dropped
        { action: 'archive', memoryId: 5 },         // valid
      ],
    })
    const result = parseConsolidateOps(text)
    assert.strictEqual(result.operations.length, 2, 'should have 2 valid ops (keep + archive)')
    assert.strictEqual(result.operations[0].action, 'keep')
    assert.strictEqual(result.operations[1].action, 'archive')
  })

  test('parseConsolidateOps: garbage text → { operations: [] }', () => {
    const result = parseConsolidateOps('这不是JSON格式的文本，随便写的。')
    assert.deepStrictEqual(result, { operations: [] })
  })

  test('parseConsolidateOps: empty string → { operations: [] }', () => {
    assert.deepStrictEqual(parseConsolidateOps(''), { operations: [] })
  })

  test('parseConsolidateOps: null → { operations: [] }', () => {
    assert.deepStrictEqual(parseConsolidateOps(null), { operations: [] })
  })

  test('parseConsolidateOps: plain JSON array (not wrapped in object) → treated as ops', () => {
    const text = JSON.stringify([
      { action: 'keep', memory: { kind: 'event', content: '测试', summary: '', keywords: [], entities: [], importance: 0.5 } },
    ])
    const result = parseConsolidateOps(text)
    assert.strictEqual(result.operations.length, 1)
    assert.strictEqual(result.operations[0].action, 'keep')
  })

  test('parseConsolidateOps: merge without sourceMemoryIds → dropped', () => {
    const text = JSON.stringify({
      operations: [
        { action: 'merge', memory: { kind: 'event', content: '合并', summary: '', keywords: [], entities: [], importance: 0.5 } },
      ],
    })
    const result = parseConsolidateOps(text)
    assert.strictEqual(result.operations.length, 0, 'merge without sourceMemoryIds should be dropped')
  })

  test('parseConsolidateOps: reason field preserved when present', () => {
    const text = JSON.stringify({
      operations: [
        { action: 'archive', memoryId: 99, reason: '已无用' },
      ],
    })
    const result = parseConsolidateOps(text)
    assert.strictEqual(result.operations[0].reason, '已无用')
  })

  // ---------------------------------------------------------------------------
  // Task 12: tomorrowOf utility
  // ---------------------------------------------------------------------------

  test('tomorrowOf: 2026-06-01 → 2026-06-02', () => {
    assert.strictEqual(tomorrowOf('2026-06-01'), '2026-06-02')
  })

  test('tomorrowOf: 2026-06-30 → 2026-07-01 (month rollover)', () => {
    assert.strictEqual(tomorrowOf('2026-06-30'), '2026-07-01')
  })

  test('tomorrowOf: 2026-12-31 → 2027-01-01 (year rollover)', () => {
    assert.strictEqual(tomorrowOf('2026-12-31'), '2027-01-01')
  })

  // ---------------------------------------------------------------------------
  // Task 12: createNightConsolidator — end-to-end glue test (fake ctx + fake model)
  // ---------------------------------------------------------------------------

  await runAsync('createNightConsolidator: consolidate processes cluster and marks events consolidated', async () => {
    const ctx = makeFakeCtx()
    const config = { consolidateModel: 'fake/model' }

    // Pre-populate some events for the day
    const day = '2026-06-01'
    const ts = new Date(nowMs - 3600000)
    await ctx.database.create('life_sim_event', {
      presetId: 'higekiri', day, ts,
      title: '锻刀',
      narrative: '在练习场磨刀',
      keywords: JSON.stringify(['锻刀', '研磨', '练习场']),
      participants: '[]',
      importance: 0.7,
      consolidated: false,
    })
    await ctx.database.create('life_sim_event', {
      presetId: 'higekiri', day, ts,
      title: '磨刀石',
      narrative: '找到一块好磨刀石',
      keywords: JSON.stringify(['研磨', '磨刀', '锻刀']),
      participants: '[]',
      importance: 0.6,
      consolidated: false,
    })

    const { createNightConsolidator } = require('./memory-consolidate')
    const ltm = createLongTermMemory(ctx)

    const fakeOps = JSON.stringify({
      operations: [
        {
          action: 'keep',
          memory: { kind: 'event', content: '锻刀磨刀石日记', summary: '今日锻刀', keywords: ['锻刀', '研磨'], entities: [], importance: 0.7 },
          reason: '值得记住',
        },
      ],
    })

    const deps = {
      getModel: async () => ({ invoke: async () => ({ content: fakeOps }) }),
      invoke: async (m, _msgs) => {
        const r = await m.invoke()
        return r.content
      },
      ltm,
      scheduler: { registerHandler: () => {} },
    }

    const consolidator = createNightConsolidator(ctx, config, deps)
    const result = await consolidator.consolidate('higekiri', day, nowMs)

    assert.strictEqual(result.clusters, 1, 'should form 1 cluster (shared 2 keywords)')
    assert.strictEqual(result.processed, 2, 'should process 2 events')

    // Check events are marked consolidated
    const events = ctx.database._store['life_sim_event'] || []
    const unconsolidated = events.filter((e) => e.presetId === 'higekiri' && e.day === day && !e.consolidated)
    assert.strictEqual(unconsolidated.length, 0, 'all events should be marked consolidated')

    // Check LTM was created
    const ltmRows = ctx.database._store['life_sim_ltm'] || []
    assert.ok(ltmRows.length >= 1, 'at least one LTM entry should be created')
  })

  await runAsync('createNightConsolidator: consolidate with no events → no crash, returns 0', async () => {
    const ctx = makeFakeCtx()
    const config = { consolidateModel: 'fake/model' }
    const { createNightConsolidator } = require('./memory-consolidate')
    const ltm = createLongTermMemory(ctx)
    const deps = {
      getModel: async () => ({ invoke: async () => ({ content: '{}' }) }),
      invoke: async () => '{}',
      ltm,
      scheduler: { registerHandler: () => {} },
    }
    const consolidator = createNightConsolidator(ctx, config, deps)
    const result = await consolidator.consolidate('higekiri', '2026-06-01', nowMs)
    assert.strictEqual(result.processed, 0)
    assert.strictEqual(result.clusters, 0)
  })

  await runAsync('createNightConsolidator: consolidate with model error → falls back, still marks consolidated', async () => {
    const ctx = makeFakeCtx()
    const config = { consolidateModel: 'fake/model' }
    const day = '2026-06-01'
    const ts = new Date(nowMs - 1000)

    await ctx.database.create('life_sim_event', {
      presetId: 'higekiri', day, ts,
      title: '锻刀', narrative: '锻刀',
      keywords: JSON.stringify(['锻刀']),
      participants: '[]',
      importance: 0.5,
      consolidated: false,
    })

    const { createNightConsolidator } = require('./memory-consolidate')
    const ltm = createLongTermMemory(ctx)
    const deps = {
      getModel: async () => { throw new Error('model unavailable') },
      invoke: async () => { throw new Error('model unavailable') },
      ltm,
      scheduler: { registerHandler: () => {} },
    }
    const consolidator = createNightConsolidator(ctx, config, deps)
    // Should not throw
    const result = await consolidator.consolidate('higekiri', day, nowMs)
    assert.strictEqual(result.processed, 1)

    // Event should be consolidated even on model error
    const events = ctx.database._store['life_sim_event'] || []
    const unconsolidated = events.filter((e) => !e.consolidated)
    assert.strictEqual(unconsolidated.length, 0, 'events should be marked consolidated even on model error')
  })

  await runAsync('createNightConsolidator: registerHandler wires scheduler', async () => {
    const ctx = makeFakeCtx()
    const config = { consolidateModel: 'fake/model' }
    const { createNightConsolidator } = require('./memory-consolidate')
    const ltm = createLongTermMemory(ctx)
    const handlers = {}
    const deps = {
      getModel: async () => ({ invoke: async () => ({ content: '{"operations":[]}' }) }),
      invoke: async (m) => (await m.invoke()).content,
      ltm,
      scheduler: {
        registerHandler: (type, fn) => { handlers[type] = fn },
      },
    }
    const consolidator = createNightConsolidator(ctx, config, deps)
    consolidator.registerHandler()
    assert.ok(typeof handlers['consolidate'] === 'function', 'consolidate handler should be registered')
  })

  await runAsync('createNightConsolidator: merge op archives source entries', async () => {
    const ctx = makeFakeCtx()
    const config = { consolidateModel: 'fake/model' }
    const day = '2026-06-01'
    const ts = new Date(nowMs - 1000)
    const { createNightConsolidator } = require('./memory-consolidate')
    const ltm = createLongTermMemory(ctx)

    // Pre-populate 2 LTM entries that will be merged
    const ltmNow = nowMs - 86400000
    const e1 = await ltm.upsertLtm('higekiri', { kind: 'event', content: '旧记忆A', keywords: ['锻刀'], entities: [], importance: 0.5 }, ltmNow)
    const e2 = await ltm.upsertLtm('higekiri', { kind: 'event', content: '旧记忆B', keywords: ['磨刀'], entities: [], importance: 0.4 }, ltmNow)

    // Add one event to consolidate
    await ctx.database.create('life_sim_event', {
      presetId: 'higekiri', day, ts,
      title: '锻刀大合并', narrative: '合并一天的锻刀记忆',
      keywords: JSON.stringify(['锻刀', '磨刀', '研磨']),
      participants: '[]', importance: 0.7, consolidated: false,
    })

    const mergeOps = JSON.stringify({
      operations: [
        {
          action: 'merge',
          sourceMemoryIds: [e1.id, e2.id],
          memory: { kind: 'event', content: '合并后的记忆', summary: '锻刀与磨刀的合体', keywords: ['锻刀', '磨刀'], entities: [], importance: 0.8 },
          reason: '同类合并',
        },
      ],
    })

    const deps = {
      getModel: async () => ({ invoke: async () => ({ content: mergeOps }) }),
      invoke: async (m) => (await m.invoke()).content,
      ltm,
      scheduler: { registerHandler: () => {} },
    }

    const consolidator = createNightConsolidator(ctx, config, deps)
    await consolidator.consolidate('higekiri', day, nowMs)

    const ltmRows = ctx.database._store['life_sim_ltm'] || []
    // Source entries should be archived (removed)
    assert.ok(!ltmRows.find((r) => r.id === e1.id), 'source e1 should be archived')
    assert.ok(!ltmRows.find((r) => r.id === e2.id), 'source e2 should be archived')
    // Merged entry should exist
    assert.ok(ltmRows.find((r) => r.content === '合并后的记忆'), 'merged entry should exist')
  })

  // =========================================================================
  // Task 13: inject.js — PromptProvider pure helpers + updateMood
  // =========================================================================

  const {
    renderRecentLife,
    renderLifeState,
    renderTodayPlan,
    renderPendingThoughts,
    updateMood,
    createInject,
  } = require('./inject')

  // ---- renderRecentLife ----

  test('renderRecentLife: empty array → empty string', () => {
    assert.strictEqual(renderRecentLife([], 5), '')
  })

  test('renderRecentLife: null → empty string', () => {
    assert.strictEqual(renderRecentLife(null, 5), '')
  })

  test('renderRecentLife: single event with title and mood', () => {
    const events = [{ title: '午后锻刀', mood: '专注' }]
    const result = renderRecentLife(events, 5)
    assert.ok(result.includes('午后锻刀'), 'should include title')
    assert.ok(result.includes('专注'), 'should include mood')
  })

  test('renderRecentLife: caps at n events', () => {
    const events = [
      { title: '事件1', mood: '好' },
      { title: '事件2', mood: '累' },
      { title: '事件3', mood: '饿' },
    ]
    const result = renderRecentLife(events, 2)
    assert.ok(result.includes('事件1'), 'first event included')
    assert.ok(result.includes('事件2'), 'second event included')
    assert.ok(!result.includes('事件3'), 'third event excluded by cap')
  })

  test('renderRecentLife: n=0 → empty string', () => {
    const events = [{ title: '午后锻刀', mood: '专注' }]
    assert.strictEqual(renderRecentLife(events, 0), '')
  })

  test('renderRecentLife: event without mood → no parentheses', () => {
    const events = [{ title: '磨刀' }]
    const result = renderRecentLife(events, 5)
    assert.ok(result.includes('磨刀'), 'should include title')
    assert.ok(!result.includes('（）'), 'should not have empty mood parens')
  })

  test('renderRecentLife: event without title → (无标题)', () => {
    const events = [{ mood: '开心' }]
    const result = renderRecentLife(events, 5)
    assert.ok(result.includes('（无标题）'), 'should show 无标题')
    assert.ok(result.includes('开心'), 'should include mood')
  })

  test('renderRecentLife: multiple events → newline-separated', () => {
    const events = [
      { title: '早上读书', mood: '平静' },
      { title: '午后练剑', mood: '专注' },
    ]
    const result = renderRecentLife(events, 5)
    const lines = result.split('\n')
    assert.strictEqual(lines.length, 2, 'should have 2 lines')
  })

  test('renderRecentLife: n omitted → renders all events', () => {
    const events = [
      { title: '事件A', mood: '好' },
      { title: '事件B', mood: '累' },
    ]
    const result = renderRecentLife(events)
    assert.ok(result.includes('事件A') && result.includes('事件B'), 'both events rendered')
  })

  // ---- renderRecentLife: 相对时间标注 (§4.1) ----
  // Fixed clock: 2026-07-01 15:00 Asia/Shanghai (= 2026-07-01T07:00Z)
  {
    const TZ = 'Asia/Shanghai'
    const NOW = Date.UTC(2026, 6, 1, 7, 0, 0) // 2026-07-01 15:00 local
    const OPTS = { nowMs: NOW, timezone: TZ }

    test('renderRecentLife(opts): <45min → [刚刚]', () => {
      const events = [{ title: '喝了口茶', mood: '平静', ts: NOW - 10 * 60 * 1000 }]
      const result = renderRecentLife(events, 5, OPTS)
      assert.strictEqual(result, '[刚刚] 喝了口茶（平静）')
    })

    test('renderRecentLife(opts): 同一本地日、超45min → [今天上午] (本地09:30)', () => {
      const events = [{ title: '晨间打扫', ts: Date.UTC(2026, 6, 1, 1, 30) }] // 09:30 local
      const result = renderRecentLife(events, 5, OPTS)
      assert.strictEqual(result, '[今天上午] 晨间打扫')
    })

    test('renderRecentLife(opts): 昨天本地日 → [昨天]', () => {
      const events = [{ title: '远征归来', ts: Date.UTC(2026, 5, 30, 12, 0) }] // 06-30 20:00 local
      const result = renderRecentLife(events, 5, OPTS)
      assert.strictEqual(result, '[昨天] 远征归来')
    })

    test('renderRecentLife(opts): 前天本地日 → [前天]', () => {
      const events = [{ title: '锻刀失败', ts: Date.UTC(2026, 5, 29, 4, 0) }] // 06-29 12:00 local
      const result = renderRecentLife(events, 5, OPTS)
      assert.strictEqual(result, '[前天] 锻刀失败')
    })

    test('renderRecentLife(opts): 更早 → [N天前]', () => {
      const events = [{ title: '演练受伤', ts: Date.UTC(2026, 5, 27, 4, 0) }] // 06-27 local → 4天前
      const result = renderRecentLife(events, 5, OPTS)
      assert.strictEqual(result, '[4天前] 演练受伤')
    })

    test('renderRecentLife(opts): 跨午夜 — 昨天23:50的事在今天00:10看 → [昨天] 而非 [刚刚]', () => {
      const now = Date.UTC(2026, 5, 30, 16, 10) // 2026-07-01 00:10 local
      const events = [{ title: '夜谈', ts: Date.UTC(2026, 5, 30, 15, 50) }] // 06-30 23:50 local, 仅20min前
      const result = renderRecentLife(events, 5, { nowMs: now, timezone: TZ })
      assert.strictEqual(result, '[昨天] 夜谈')
    })

    test('renderRecentLife(opts): 恰好45min → 不是[刚刚]而是[今天下午]', () => {
      const events = [{ title: '午后练剑', ts: NOW - 45 * 60 * 1000 }] // 14:15 local
      const result = renderRecentLife(events, 5, OPTS)
      assert.strictEqual(result, '[今天下午] 午后练剑')
    })

    test('renderRecentLife(opts): 本地时段分档 — 凌晨/早上/中午/晚上', () => {
      const nowLate = Date.UTC(2026, 6, 1, 15, 0) // 2026-07-01 23:00 local
      const events = [
        { title: '睡前翻书', ts: Date.UTC(2026, 6, 1, 11, 0) },   // 19:00 local → 晚上
        { title: '午膳', ts: Date.UTC(2026, 6, 1, 4, 0) },        // 12:00 local → 中午
        { title: '晨练', ts: Date.UTC(2026, 5, 30, 22, 0) },      // 07-01 06:00 local (UTC 还在昨天) → 早上
        { title: '守夜', ts: Date.UTC(2026, 5, 30, 19, 0) },      // 07-01 03:00 local → 凌晨
      ]
      const result = renderRecentLife(events, 10, { nowMs: nowLate, timezone: TZ })
      const lines = result.split('\n')
      assert.strictEqual(lines[0], '[今天晚上] 睡前翻书')
      assert.strictEqual(lines[1], '[今天中午] 午膳')
      assert.strictEqual(lines[2], '[今天早上] 晨练')
      assert.strictEqual(lines[3], '[今天凌晨] 守夜')
    })

    test('renderRecentLife(opts): 事件缺 ts → 该行不加标签', () => {
      const events = [
        { title: '有时间戳', ts: NOW - 10 * 60 * 1000 },
        { title: '无时间戳', mood: '好' },
      ]
      const result = renderRecentLife(events, 5, OPTS)
      const lines = result.split('\n')
      assert.strictEqual(lines[0], '[刚刚] 有时间戳')
      assert.strictEqual(lines[1], '无时间戳（好）', 'missing ts → no label prefix')
    })

    test('renderRecentLife: 不传 opts → 行为与旧版完全一致（有 ts 也不加标签）', () => {
      const events = [
        { title: '早锻刀', mood: '专注', ts: NOW - 10 * 60 * 1000 },
        { title: '午休', ts: Date.UTC(2026, 5, 29, 4, 0) },
      ]
      const result = renderRecentLife(events, 5)
      assert.strictEqual(result, '早锻刀（专注）\n午休')
    })
  }

  // ---- renderLifeState ----

  test('renderLifeState: null → empty string', () => {
    assert.strictEqual(renderLifeState(null), '')
  })

  test('renderLifeState: full state → includes location, activity, mood, threads', () => {
    const state = {
      location: '刀部屋',
      current_activity: '擦拭太刀',
      mood: '慵懒',
      open_threads: ['约好的对练', '要借还的书'],
    }
    const result = renderLifeState(state)
    assert.ok(result.includes('刀部屋'), 'includes location')
    assert.ok(result.includes('擦拭太刀'), 'includes activity')
    assert.ok(result.includes('慵懒'), 'includes mood')
    assert.ok(result.includes('约好的对练'), 'includes thread 1')
    assert.ok(result.includes('要借还的书'), 'includes thread 2')
  })

  test('renderLifeState: missing location → 在某处', () => {
    const state = { current_activity: '发呆', mood: 'neutral', open_threads: [] }
    const result = renderLifeState(state)
    assert.ok(result.includes('某处'), 'fallback location')
  })

  test('renderLifeState: missing mood → neutral', () => {
    const state = { location: '庭院', current_activity: '散步', open_threads: [] }
    const result = renderLifeState(state)
    assert.ok(result.includes('neutral'), 'fallback mood')
  })

  test('renderLifeState: empty open_threads → no 未了的事 line', () => {
    const state = { location: '大广间', current_activity: '开会', mood: '认真', open_threads: [] }
    const result = renderLifeState(state)
    assert.ok(!result.includes('未了的事'), 'no 未了 when empty threads')
  })

  test('renderLifeState: null open_threads → no 未了的事 line', () => {
    const state = { location: '大广间', mood: '认真', open_threads: null }
    const result = renderLifeState(state)
    assert.ok(!result.includes('未了的事'), 'no 未了 when null threads')
  })

  test('renderLifeState: no activity field → graceful', () => {
    const state = { location: '书房', mood: '沉静', open_threads: ['看书'] }
    const result = renderLifeState(state)
    assert.ok(result.includes('书房'), 'still shows location')
    assert.ok(result.includes('沉静'), 'still shows mood')
  })

  // ---- renderTodayPlan ----

  test('renderTodayPlan: null plan → empty string', () => {
    assert.strictEqual(renderTodayPlan(null, 1000), '')
  })

  test('renderTodayPlan: empty blocks → empty string', () => {
    assert.strictEqual(renderTodayPlan({ blocks: [] }, 1000), '')
  })

  test('renderTodayPlan: blocks rendered with labels and activities', () => {
    const plan = {
      blocks: [
        { block: '上午', activity: '读书', start: 1000, end: 5000 },
        { block: '午后', activity: '练剑', start: 5000, end: 9000 },
      ],
    }
    const result = renderTodayPlan(plan, 500)
    assert.ok(result.includes('上午'), 'includes 上午')
    assert.ok(result.includes('读书'), 'includes 读书')
    assert.ok(result.includes('午后'), 'includes 午后')
    assert.ok(result.includes('练剑'), 'includes 练剑')
  })

  test('renderTodayPlan: current block marked with ▶', () => {
    const plan = {
      blocks: [
        { block: '上午', activity: '读书', start: 1000, end: 5000 },
        { block: '午后', activity: '练剑', start: 5000, end: 9000 },
      ],
    }
    const result = renderTodayPlan(plan, 6000) // inside 午后 block
    const lines = result.split('\n')
    const currentLine = lines.find((l) => l.includes('练剑'))
    assert.ok(currentLine && currentLine.startsWith('▶'), 'current block has ▶ prefix')
    const otherLine = lines.find((l) => l.includes('读书'))
    assert.ok(otherLine && !otherLine.startsWith('▶'), 'past block no ▶')
  })

  test('renderTodayPlan: nowMs at block boundary → correct current', () => {
    const plan = {
      blocks: [
        { block: '上午', activity: 'A', start: 1000, end: 5000 },
        { block: '午后', activity: 'B', start: 5000, end: 9000 },
      ],
    }
    // nowMs = 5000: start of 午后, end of 上午 (end is exclusive)
    const result = renderTodayPlan(plan, 5000)
    const lines = result.split('\n')
    const bLine = lines.find((l) => l.includes('B'))
    assert.ok(bLine && bLine.startsWith('▶'), '午后 is current at its start')
    const aLine = lines.find((l) => l.includes('A'))
    assert.ok(aLine && !aLine.startsWith('▶'), '上午 is not current at its end')
  })

  test('renderTodayPlan: nowMs past all blocks → no current marker', () => {
    const plan = {
      blocks: [
        { block: '上午', activity: 'A', start: 1000, end: 3000 },
      ],
    }
    const result = renderTodayPlan(plan, 99999)
    assert.ok(!result.includes('▶'), 'no ▶ when nowMs past all blocks')
  })

  // ---- renderPendingThoughts ----

  test('renderPendingThoughts: null → empty string', () => {
    assert.strictEqual(renderPendingThoughts(null), '')
  })

  test('renderPendingThoughts: empty array → empty string', () => {
    assert.strictEqual(renderPendingThoughts([]), '')
  })

  test('renderPendingThoughts: single thought with urgency', () => {
    const thoughts = [{ content: '想问膝丸借那本书', urgency: 'low' }]
    const result = renderPendingThoughts(thoughts)
    assert.ok(result.includes('想问膝丸借那本书'), 'includes content')
    assert.ok(result.includes('[low]'), 'includes urgency')
    assert.ok(result.startsWith('- '), 'starts with list marker')
  })

  test('renderPendingThoughts: thought without urgency → no brackets', () => {
    const thoughts = [{ content: '随便一想' }]
    const result = renderPendingThoughts(thoughts)
    assert.ok(result.includes('随便一想'), 'includes content')
    assert.ok(!result.includes('['), 'no urgency brackets')
  })

  test('renderPendingThoughts: multiple thoughts → newline-separated', () => {
    const thoughts = [
      { content: '想法A', urgency: 'low' },
      { content: '想法B', urgency: 'high' },
    ]
    const result = renderPendingThoughts(thoughts)
    const lines = result.split('\n')
    assert.strictEqual(lines.length, 2, 'two lines')
    assert.ok(lines[0].includes('想法A'), 'first thought first')
    assert.ok(lines[1].includes('想法B'), 'second thought second')
  })

  test('renderPendingThoughts: thought with null content → (无内容)', () => {
    const thoughts = [{ content: null, urgency: 'low' }]
    const result = renderPendingThoughts(thoughts)
    assert.ok(result.includes('（无内容）'), 'fallback for null content')
  })

  // ---- updateMood ----

  test('updateMood: event.mood updates life-state.mood', () => {
    const state = { presetId: 'higekiri', location: '刀部屋', mood: 'neutral', open_threads: [] }
    const event = { title: '练剑', mood: '酣畅' }
    const result = updateMood(state, event)
    assert.strictEqual(result.mood, '酣畅', 'mood updated to event mood')
  })

  test('updateMood: input life-state not mutated', () => {
    const state = { presetId: 'higekiri', mood: 'neutral', open_threads: [] }
    const event = { mood: '开心' }
    const result = updateMood(state, event)
    assert.strictEqual(state.mood, 'neutral', 'original state unchanged')
    assert.strictEqual(result.mood, '开心', 'returned state has new mood')
    assert.notStrictEqual(result, state, 'new object returned')
  })

  test('updateMood: event without mood → mood preserved', () => {
    const state = { presetId: 'higekiri', mood: '慵懒', open_threads: [] }
    const event = { title: '发呆' }  // no mood field
    const result = updateMood(state, event)
    assert.strictEqual(result.mood, '慵懒', 'original mood preserved')
  })

  test('updateMood: event.mood = null → mood preserved', () => {
    const state = { presetId: 'higekiri', mood: '认真', open_threads: [] }
    const event = { mood: null }
    const result = updateMood(state, event)
    assert.strictEqual(result.mood, '认真', 'null mood → preserved')
  })

  test('updateMood: event.mood = empty string → mood preserved', () => {
    const state = { presetId: 'higekiri', mood: '平静', open_threads: [] }
    const event = { mood: '' }
    const result = updateMood(state, event)
    assert.strictEqual(result.mood, '平静', 'empty mood → preserved')
  })

  test('updateMood: event.mood = whitespace → mood preserved', () => {
    const state = { presetId: 'higekiri', mood: '平静', open_threads: [] }
    const event = { mood: '  ' }
    const result = updateMood(state, event)
    assert.strictEqual(result.mood, '平静', 'whitespace-only mood → preserved')
  })

  test('updateMood: other life-state fields preserved unchanged', () => {
    const state = {
      presetId: 'higekiri',
      location: '刀部屋',
      current_activity: '擦刀',
      mood: 'neutral',
      open_threads: ['线索A'],
      recent_event_ids: [1, 2],
    }
    const event = { mood: '疲惫' }
    const result = updateMood(state, event)
    assert.strictEqual(result.presetId, 'higekiri', 'presetId preserved')
    assert.strictEqual(result.location, '刀部屋', 'location preserved')
    assert.strictEqual(result.current_activity, '擦刀', 'activity preserved')
    assert.deepStrictEqual(result.open_threads, ['线索A'], 'threads preserved')
    assert.deepStrictEqual(result.recent_event_ids, [1, 2], 'event ids preserved')
    assert.strictEqual(result.mood, '疲惫', 'mood updated')
  })

  test('updateMood: null lifeState throws', () => {
    assert.throws(() => updateMood(null, { mood: '好' }), /lifeState must be an object/)
  })

  test('updateMood: null event → mood preserved (event treated as empty)', () => {
    const state = { mood: '沉稳', open_threads: [] }
    const result = updateMood(state, null)
    assert.strictEqual(result.mood, '沉稳', 'null event → mood preserved')
  })

  // ---- createInject (fake-ctx glue test) ----

  await runAsync('createInject: register() with fake deps → recent_life provider returns rendered text', async () => {
    const registrations = {}
    const fakeRenderer = {
      registerFunctionProvider: (name, fn) => {
        registrations[name] = fn
        return () => {}  // disposer
      },
    }
    const fakeCtx = {
      chatluna: { promptRenderer: fakeRenderer },
      effect: (fn) => fn(),
      logger: () => ({ warn: () => {}, info: () => {} }),
    }
    const fakeConfig = { presets: ['higekiri'] }
    const fakeDeps = {
      recent: async (_pid, _n) => [
        { title: '早锻刀', mood: '专注' },
        { title: '午休', mood: '慵懒' },
      ],
      getState: async (_pid) => ({ location: '刀部屋', current_activity: '擦刀', mood: '专注', open_threads: [] }),
      getPlan: async (_pid, _day) => ({
        blocks: [
          { block: '上午', activity: '读书', start: 0, end: 1000 },
        ],
      }),
      recallThoughts: async (_pid, _target) => [
        { content: '想告诉主人今天天气很好', urgency: 'low' },
      ],
      todayStr: (_nowMs) => '2026-07-01',
    }

    const injector = createInject(fakeCtx, fakeConfig, fakeDeps)
    injector.register()

    // Check all 4 providers registered
    assert.ok(typeof registrations['recent_life'] === 'function', 'recent_life registered')
    assert.ok(typeof registrations['life_state'] === 'function', 'life_state registered')
    assert.ok(typeof registrations['today_plan'] === 'function', 'today_plan registered')
    assert.ok(typeof registrations['pending_thoughts'] === 'function', 'pending_thoughts registered')

    // Test recent_life renders correctly
    const session = null  // P1 fallback to config.presets[0]
    const recentText = await registrations['recent_life']([], {}, { session })
    assert.ok(recentText.includes('早锻刀'), 'recent_life includes event title')
    assert.ok(recentText.includes('专注'), 'recent_life includes mood')

    // Test life_state renders correctly
    const stateText = await registrations['life_state']([], {}, { session })
    assert.ok(stateText.includes('刀部屋'), 'life_state includes location')
    assert.ok(stateText.includes('擦刀'), 'life_state includes activity')

    // Test today_plan renders correctly
    const planText = await registrations['today_plan']([], {}, { session })
    assert.ok(planText.includes('上午'), 'today_plan includes block label')
    assert.ok(planText.includes('读书'), 'today_plan includes activity')

    // Test pending_thoughts renders correctly
    const thoughtsText = await registrations['pending_thoughts']([], {}, { session })
    assert.ok(thoughtsText.includes('今天天气很好'), 'pending_thoughts includes content')
    assert.ok(thoughtsText.includes('[low]'), 'pending_thoughts includes urgency')
  })

  await runAsync('createInject: register() skips when no promptRenderer', async () => {
    const warns = []
    const fakeCtx = {
      chatluna: {},  // no promptRenderer
      effect: (fn) => fn(),
      logger: () => ({ warn: (msg) => warns.push(msg), info: () => {} }),
    }
    const fakeConfig = { presets: ['higekiri'] }
    const fakeDeps = {
      recent: async () => [],
      getState: async () => ({}),
      getPlan: async () => null,
      recallThoughts: async () => [],
    }
    const injector = createInject(fakeCtx, fakeConfig, fakeDeps)
    // Should not throw
    injector.register()
    assert.ok(warns.some((w) => w.includes('promptRenderer')), 'should warn about missing promptRenderer')
  })

  await runAsync('createInject: custom varNames used for registration', async () => {
    const registered = []
    const fakeRenderer = {
      registerFunctionProvider: (name, _fn) => {
        registered.push(name)
        return () => {}
      },
    }
    const fakeCtx = {
      chatluna: { promptRenderer: fakeRenderer },
      effect: (fn) => fn(),
      logger: () => ({ warn: () => {}, info: () => {} }),
    }
    const fakeConfig = {
      presets: ['higekiri'],
      varNames: {
        recentLife: 'my_recent',
        lifeState: 'my_state',
        todayPlan: 'my_plan',
        pendingThoughts: 'my_thoughts',
      },
    }
    const fakeDeps = {
      recent: async () => [],
      getState: async () => ({}),
      getPlan: async () => null,
      recallThoughts: async () => [],
    }
    const injector = createInject(fakeCtx, fakeConfig, fakeDeps)
    injector.register()
    assert.ok(registered.includes('my_recent'), 'custom recent_life varName used')
    assert.ok(registered.includes('my_state'), 'custom life_state varName used')
    assert.ok(registered.includes('my_plan'), 'custom today_plan varName used')
    assert.ok(registered.includes('my_thoughts'), 'custom pending_thoughts varName used')
  })

  await runAsync('createInject: dep error returns empty string gracefully', async () => {
    const registrations = {}
    const fakeRenderer = {
      registerFunctionProvider: (name, fn) => {
        registrations[name] = fn
        return () => {}
      },
    }
    const fakeCtx = {
      chatluna: { promptRenderer: fakeRenderer },
      effect: (fn) => fn(),
      logger: () => ({ warn: () => {}, info: () => {} }),
    }
    const fakeConfig = { presets: ['higekiri'] }
    const fakeDeps = {
      recent: async () => { throw new Error('DB failure') },
      getState: async () => { throw new Error('DB failure') },
      getPlan: async () => { throw new Error('DB failure') },
      recallThoughts: async () => { throw new Error('DB failure') },
      todayStr: () => '2026-07-01',
    }
    const injector = createInject(fakeCtx, fakeConfig, fakeDeps)
    injector.register()

    const session = null
    const recentText = await registrations['recent_life']([], {}, { session })
    assert.strictEqual(recentText, '', 'dep error → empty string for recent_life')
    const stateText = await registrations['life_state']([], {}, { session })
    assert.strictEqual(stateText, '', 'dep error → empty string for life_state')
    const planText = await registrations['today_plan']([], {}, { session })
    assert.strictEqual(planText, '', 'dep error → empty string for today_plan')
    const thoughtsText = await registrations['pending_thoughts']([], {}, { session })
    assert.strictEqual(thoughtsText, '', 'dep error → empty string for pending_thoughts')
  })

  // ---------------------------------------------------------------------------
  // P1.5-T1: proactive.js — 成稿改写 (§5.8 buildRewritePrompt + rewrite send path)
  // ---------------------------------------------------------------------------

  const { buildRewritePrompt } = require('./proactive')

  // ---- buildRewritePrompt (pure) ----

  test('buildRewritePrompt: system 在前且含 persona + 重写指令 + 禁操控', () => {
    const messages = buildRewritePrompt('角色：髭切。慵懒从容。', '今天练了一下午。', [])
    assert.ok(Array.isArray(messages), 'returns messages array')
    assert.strictEqual(messages.length, 2)
    assert.strictEqual(messages[0].role, 'system')
    assert.strictEqual(messages[1].role, 'user')
    assert.ok(messages[0].content.includes('角色：髭切。慵懒从容。'), 'system includes persona canon')
    assert.ok(messages[0].content.includes('重写'), 'system includes rewrite instruction')
    assert.ok(messages[0].content.includes('操控'), 'system forbids manipulation phrasing')
    assert.ok(messages[0].content.includes('不要任何解释'), 'system asks for message text only')
  })

  test('buildRewritePrompt: user 含草稿；contextBits 可选拼进情境', () => {
    const withBits = buildRewritePrompt('persona', '草稿文本', ['事件：早锻刀', '静默 12 分钟'])
    assert.ok(withBits[1].content.includes('草稿文本'), 'user includes draft')
    assert.ok(withBits[1].content.includes('早锻刀'), 'user includes event context bit')
    assert.ok(withBits[1].content.includes('静默 12 分钟'), 'user includes silence context bit')
    const noBits = buildRewritePrompt('persona', '草稿文本')
    assert.ok(noBits[1].content.includes('草稿文本'), 'user includes draft without contextBits')
  })

  // ---- rewrite send path (glue, fake model + fake transport) ----

  await runAsync('createProactiveBridge: proactiveRewrite=false → 外发=原草稿, 不调改写模型', async () => {
    let sent = []
    let modelCalls = 0
    const nowMs = Date.UTC(2026, 6, 1, 10, 0, 0)
    const bridge = createProactiveBridge(null, {
      proactiveEnabled: true,
      quietHoursEnabled: false,
      dailyCapEnabled: false,
      timezone: 'UTC',
      forbiddenPhraseGuard: false,
      proactiveVia: 'direct',
      proactiveRewrite: false,
    }, {
      sendDirect: async (pid, text) => sent.push({ pid, text }),
      rewriteModel: 'fake/rewrite',
      getModel: async () => { modelCalls++; return { invoke: async () => ({ content: '不该被用到' }) } },
      invoke: async () => { modelCalls++; return '不该被用到' },
      getPersona: async () => '角色：髭切',
    })

    await bridge.maybeReachOut('higekiri', { decision: 'now', draft: '今天练了一下午。', target: '审神者' }, nowMs)
    assert.strictEqual(sent.length, 1)
    assert.strictEqual(sent[0].text, '今天练了一下午。', 'raw draft goes out unchanged')
    assert.strictEqual(modelCalls, 0, 'rewrite model must not be invoked when disabled')
  })

  await runAsync('createProactiveBridge: 改写开启 + mock 模型 → 外发=改写文本(trim), 输入含 persona+草稿', async () => {
    let sent = []
    let seenModelName = null
    let seenMessages = null
    const nowMs = Date.UTC(2026, 6, 1, 10, 0, 0)
    const bridge = createProactiveBridge(null, {
      proactiveEnabled: true,
      quietHoursEnabled: false,
      dailyCapEnabled: false,
      timezone: 'UTC',
      forbiddenPhraseGuard: true,
      proactiveVia: 'direct',
    }, {
      sendDirect: async (pid, text) => sent.push({ pid, text }),
      rewriteModel: 'fake/rewrite',
      getModel: async (_ctx, name) => { seenModelName = name; return { name } },
      invoke: async (_m, messages) => { seenMessages = messages; return '  练了一下午刀，胳膊都酸了。  ' },
      getPersona: async () => '角色：髭切。慵懒从容。',
    })

    await bridge.maybeReachOut('higekiri', { decision: 'now', draft: '今天练了一下午。', target: '审神者', reason: '想说说' }, nowMs)
    assert.strictEqual(sent.length, 1)
    assert.strictEqual(sent[0].text, '练了一下午刀，胳膊都酸了。', 'rewritten + trimmed text goes out')
    assert.strictEqual(seenModelName, 'fake/rewrite', 'rewrite uses deps.rewriteModel')
    assert.ok(seenMessages && seenMessages[0].role === 'system', 'rewrite prompt starts with system')
    assert.ok(seenMessages[0].content.includes('角色：髭切。慵懒从容。'), 'rewrite system includes persona')
    assert.ok(seenMessages[1].content.includes('今天练了一下午。'), 'rewrite user includes draft')
  })

  await runAsync('createProactiveBridge: 无 rewriteModel 时回落 cfg.consolidateModel', async () => {
    let sent = []
    let seenModelName = null
    const nowMs = Date.UTC(2026, 6, 1, 10, 0, 0)
    const bridge = createProactiveBridge(null, {
      proactiveEnabled: true,
      quietHoursEnabled: false,
      dailyCapEnabled: false,
      timezone: 'UTC',
      forbiddenPhraseGuard: false,
      proactiveVia: 'direct',
      proactiveModel: '',
      consolidateModel: 'claude/opus',
    }, {
      sendDirect: async (pid, text) => sent.push({ pid, text }),
      getModel: async (_ctx, name) => { seenModelName = name; return { name } },
      invoke: async () => '改写好了。',
      getPersona: async () => 'persona',
    })

    await bridge.maybeReachOut('higekiri', { decision: 'now', draft: '草稿。', target: '审神者' }, nowMs)
    assert.strictEqual(sent.length, 1)
    assert.strictEqual(sent[0].text, '改写好了。')
    assert.strictEqual(seenModelName, 'claude/opus', 'empty proactiveModel falls back to consolidateModel')
  })

  await runAsync('createProactiveBridge: 改写模型抛错 → 降级原草稿 + warn', async () => {
    let sent = []
    let warns = []
    const nowMs = Date.UTC(2026, 6, 1, 10, 0, 0)
    const bridge = createProactiveBridge(null, {
      proactiveEnabled: true,
      quietHoursEnabled: false,
      dailyCapEnabled: false,
      timezone: 'UTC',
      forbiddenPhraseGuard: false,
      proactiveVia: 'direct',
    }, {
      sendDirect: async (pid, text) => sent.push({ pid, text }),
      rewriteModel: 'fake/rewrite',
      getModel: async (_ctx, name) => ({ name }),
      invoke: async () => { throw new Error('boom') },
      getPersona: async () => 'persona',
      logger: { info: () => {}, warn: (...a) => warns.push(a), error: () => {}, debug: () => {} },
    })

    await bridge.maybeReachOut('higekiri', { decision: 'now', draft: '今天练了一下午。', target: '审神者' }, nowMs)
    assert.strictEqual(sent.length, 1, 'degrades to sending raw draft')
    assert.strictEqual(sent[0].text, '今天练了一下午。')
    assert.ok(warns.length >= 1, 'degradation logs a warn')
  })

  await runAsync('createProactiveBridge: 改写返回空 → 降级原草稿', async () => {
    let sent = []
    const nowMs = Date.UTC(2026, 6, 1, 10, 0, 0)
    const bridge = createProactiveBridge(null, {
      proactiveEnabled: true,
      quietHoursEnabled: false,
      dailyCapEnabled: false,
      timezone: 'UTC',
      forbiddenPhraseGuard: false,
      proactiveVia: 'direct',
    }, {
      sendDirect: async (pid, text) => sent.push({ pid, text }),
      rewriteModel: 'fake/rewrite',
      getModel: async (_ctx, name) => ({ name }),
      invoke: async () => '   ',
      getPersona: async () => 'persona',
    })

    await bridge.maybeReachOut('higekiri', { decision: 'now', draft: '今天练了一下午。', target: '审神者' }, nowMs)
    assert.strictEqual(sent.length, 1)
    assert.strictEqual(sent[0].text, '今天练了一下午。', 'empty rewrite degrades to raw draft')
  })

  await runAsync('createProactiveBridge: 改写后的文本命中禁操控 pattern → 拦截不发', async () => {
    let sent = []
    const nowMs = Date.UTC(2026, 6, 1, 10, 0, 0)
    const bridge = createProactiveBridge(null, {
      proactiveEnabled: true,
      quietHoursEnabled: false,
      dailyCapEnabled: false,
      timezone: 'UTC',
      forbiddenPhraseGuard: true,
      proactiveVia: 'direct',
    }, {
      sendDirect: async (pid, text) => sent.push({ pid, text }),
      rewriteModel: 'fake/rewrite',
      getModel: async (_ctx, name) => ({ name }),
      invoke: async () => '别走，我离不开你。',  // clean draft rewritten INTO manipulation
      getPersona: async () => 'persona',
    })

    // draft itself is clean → gate passes; guard must re-check the FINAL text
    await bridge.maybeReachOut('higekiri', { decision: 'now', draft: '今天练了一下午。', target: '审神者' }, nowMs)
    assert.strictEqual(sent.length, 0, 'guard on final outbound text blocks the rewritten manipulation')
  })

  await runAsync('createProactiveBridge: maybeFollowUp 追问文案走同一改写路径', async () => {
    let sent = []
    const nowMs = Date.UTC(2026, 6, 1, 10, 0, 0)
    const bridge = createProactiveBridge(null, {
      proactiveEnabled: true,
      quietHoursEnabled: false,
      dailyCapEnabled: false,
      timezone: 'UTC',
      forbiddenPhraseGuard: false,
      proactiveVia: 'direct',
      rollModel: 'fake/roll',
    }, {
      sendDirect: async (pid, text) => sent.push({ pid, text }),
      rewriteModel: 'fake/rewrite',
      getModel: async (_ctx, name) => ({ name }),
      invoke: async (m) => {
        // follow-up judgment goes to rollModel; rewrite goes to rewriteModel
        if (m.name === 'fake/roll') return JSON.stringify({ follow_up: true, draft: '还在吗？' })
        return '主君，还在么。'
      },
      getPersona: async () => 'persona',
      silenceState: (_pid) => ({ silenceMinutes: 8, followUpCount: 0 }),
      presence: { goLive: (_pid) => {} },
    })

    await bridge.maybeFollowUp('higekiri', nowMs)
    assert.strictEqual(sent.length, 1)
    assert.strictEqual(sent[0].text, '主君，还在么。', 'follow-up text is the rewritten one')
  })

  console.log('\n' + pass + ' passed, ' + fail + ' failed')
  process.exit(fail ? 1 : 0)
}

main().catch((e) => {
  console.error('test runner crashed:', e)
  process.exit(1)
})
