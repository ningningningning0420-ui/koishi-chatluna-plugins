'use strict'

// Offline self-test for the pure guard logic. Run: `node test.js`
// No framework — matches the project's existing offline-self-test habit.

const assert = require('assert')
const g = require('./guards')

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

// ---- isAuthorizedTrigger ----
test('authorized trigger: userId in whitelist → true', () => {
  assert.strictEqual(g.isAuthorizedTrigger('10001', ['10001', '111']), true)
})
test('authorized trigger: userId not in whitelist → false', () => {
  assert.strictEqual(g.isAuthorizedTrigger('999', ['10001', '111']), false)
})
test('authorized trigger: numeric userId matches string whitelist → true', () => {
  assert.strictEqual(g.isAuthorizedTrigger(10001, ['10001']), true)
})
test('authorized trigger: empty whitelist → false', () => {
  assert.strictEqual(g.isAuthorizedTrigger('10001', []), false)
})

// ---- resolveRecipient ----
const RECIPIENTS = [
  { alias: '膝丸', qq: '1001' },
  { alias: '小明', qq: '2002' },
]
test('resolveRecipient: known alias → recipient object', () => {
  assert.deepStrictEqual(g.resolveRecipient('膝丸', RECIPIENTS), { alias: '膝丸', qq: '1001' })
})
test('resolveRecipient: alias with surrounding spaces → trimmed match', () => {
  assert.deepStrictEqual(g.resolveRecipient('  小明 ', RECIPIENTS), { alias: '小明', qq: '2002' })
})
test('resolveRecipient: unknown alias → null', () => {
  assert.strictEqual(g.resolveRecipient('阿猫', RECIPIENTS), null)
})
test('resolveRecipient: target given as the qq number → match by qq', () => {
  assert.deepStrictEqual(g.resolveRecipient('2002', RECIPIENTS), { alias: '小明', qq: '2002' })
})
test('resolveRecipient: empty recipients → null', () => {
  assert.strictEqual(g.resolveRecipient('膝丸', []), null)
})

// ---- isFriend ----
test('isFriend: qq present in friend ids → true', () => {
  assert.strictEqual(g.isFriend('1001', ['1001', '2002']), true)
})
test('isFriend: qq absent → false', () => {
  assert.strictEqual(g.isFriend('3003', ['1001', '2002']), false)
})
test('isFriend: numeric qq matches string id list → true', () => {
  assert.strictEqual(g.isFriend(1001, ['1001', '2002']), true)
})

// ---- isMyBot ----
test('isMyBot: in myBots → true', () => {
  assert.strictEqual(g.isMyBot('5005', ['5005']), true)
})
test('isMyBot: not in myBots → false', () => {
  assert.strictEqual(g.isMyBot('1001', ['5005']), false)
})
test('isMyBot: empty list → false', () => {
  assert.strictEqual(g.isMyBot('5005', []), false)
})

// ---- createRateLimiter ----
// Day key is UTC-based so explicit-ms tests are timezone-stable.
const DAY1 = Date.UTC(2026, 5, 23, 0, 0, 0)
const DAY2 = Date.UTC(2026, 5, 24, 0, 0, 0)

test('rateLimiter: first call passes', () => {
  const rl = g.createRateLimiter({ minIntervalMs: 60000, dailyLimit: 3 })
  assert.strictEqual(rl.check(DAY1).ok, true)
})
test('rateLimiter: second call within interval → too_frequent', () => {
  const rl = g.createRateLimiter({ minIntervalMs: 60000, dailyLimit: 3 })
  rl.record(DAY1)
  const r = rl.check(DAY1 + 1000)
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.reason, 'too_frequent')
})
test('rateLimiter: call after interval passes → ok', () => {
  const rl = g.createRateLimiter({ minIntervalMs: 60000, dailyLimit: 3 })
  rl.record(DAY1)
  assert.strictEqual(rl.check(DAY1 + 60000).ok, true)
})
test('rateLimiter: daily limit reached → daily_limit', () => {
  const rl = g.createRateLimiter({ minIntervalMs: 60000, dailyLimit: 3 })
  rl.record(DAY1)
  rl.record(DAY1 + 60000)
  rl.record(DAY1 + 120000)
  const r = rl.check(DAY1 + 200000)
  assert.strictEqual(r.ok, false)
  assert.strictEqual(r.reason, 'daily_limit')
})
test('rateLimiter: new day resets daily count', () => {
  const rl = g.createRateLimiter({ minIntervalMs: 60000, dailyLimit: 3 })
  rl.record(DAY1)
  rl.record(DAY1 + 60000)
  rl.record(DAY1 + 120000)
  assert.strictEqual(rl.check(DAY2).ok, true)
})

// ---- isTriggerAllowed (user whitelist + group-trigger whitelist) ----
// DM is always allowed for a whitelisted user; a group is allowed only if its id
// is in triggerGroups. Empty triggerGroups ⇒ private-only (the safe default).
const WL = ['10001']
const GROUPS = ['20001'] // a group on a native tool-calling adapter
test('isTriggerAllowed: DM + whitelisted (no groups configured) → true', () => {
  assert.strictEqual(g.isTriggerAllowed({ userId: '10001', isDirect: true }, { triggerWhitelist: WL, triggerGroups: [] }), true)
})
test('isTriggerAllowed: group NOT in triggerGroups → false', () => {
  assert.strictEqual(g.isTriggerAllowed({ userId: '10001', isDirect: false, groupId: '20002' }, { triggerWhitelist: WL, triggerGroups: GROUPS }), false)
})
test('isTriggerAllowed: group in triggerGroups + whitelisted → true', () => {
  assert.strictEqual(g.isTriggerAllowed({ userId: '10001', isDirect: false, groupId: '20001' }, { triggerWhitelist: WL, triggerGroups: GROUPS }), true)
})
test('isTriggerAllowed: DM + not whitelisted → false', () => {
  assert.strictEqual(g.isTriggerAllowed({ userId: '999', isDirect: true }, { triggerWhitelist: WL, triggerGroups: GROUPS }), false)
})
test('isTriggerAllowed: group in triggerGroups but not whitelisted → false', () => {
  assert.strictEqual(g.isTriggerAllowed({ userId: '999', isDirect: false, groupId: '20001' }, { triggerWhitelist: WL, triggerGroups: GROUPS }), false)
})
test('isTriggerAllowed: group when triggerGroups empty → false (private-only default)', () => {
  assert.strictEqual(g.isTriggerAllowed({ userId: '10001', isDirect: false, groupId: '20001' }, { triggerWhitelist: WL, triggerGroups: [] }), false)
})

// ---- lastMarkerPerRecipient（同轮候选按"解析后身份"收敛：别名/QQ 双写合并，后者胜出）----
const mk = (alias, text, photo) => ({ recipientAlias: alias, text: text || '', photo: photo || null })
test('lastMarkerPerRecipient: 别名与 QQ 双写同一人 → 合并成一条，后者胜出', () => {
  const out = g.lastMarkerPerRecipient([mk('膝丸', '草稿'), mk('1001', '定稿')], RECIPIENTS)
  assert.strictEqual(out.length, 1)
  assert.strictEqual(out[0].marker.text, '定稿')
  assert.strictEqual(out[0].key, 'qq:1001')
  assert.deepStrictEqual(out[0].recipient, { alias: '膝丸', qq: '1001' })
})
test('lastMarkerPerRecipient: 不同收件人各留一条（各自最后一个）', () => {
  const out = g.lastMarkerPerRecipient([mk('膝丸', 'a'), mk('小明', 'b'), mk('膝丸', 'c')], RECIPIENTS)
  assert.strictEqual(out.length, 2)
  assert.strictEqual(out.find((o) => o.key === 'qq:1001').marker.text, 'c')
})
test('lastMarkerPerRecipient: 白名单外的别名保留自己的槽（recipient=null，键用别名）', () => {
  const out = g.lastMarkerPerRecipient([mk('阿猫', 'x')], RECIPIENTS)
  assert.strictEqual(out.length, 1)
  assert.strictEqual(out[0].recipient, null)
  assert.strictEqual(out[0].key, 'alias:阿猫')
})
test('lastMarkerPerRecipient: 空输入 → 空数组', () => {
  assert.deepStrictEqual(g.lastMarkerPerRecipient([], RECIPIENTS), [])
  assert.deepStrictEqual(g.lastMarkerPerRecipient(null, RECIPIENTS), [])
})

// ---- createSendGate（发送后短窗身份闸门：挡同轮"草稿已发→改词再发"的双发，不挡下一轮确认）----
test('sendGate: 刚发过 → 窗口内同身份再发被拦', () => {
  const gate = g.createSendGate(10000)
  gate.record('private:1||qq:1001', 100000)
  assert.strictEqual(gate.check('private:1||qq:1001', 105000), false)
})
test('sendGate: 窗口过了 / 没发过 / 不同身份 → 放行', () => {
  const gate = g.createSendGate(10000)
  gate.record('private:1||qq:1001', 100000)
  assert.strictEqual(gate.check('private:1||qq:1001', 110000), true)
  assert.strictEqual(gate.check('private:1||qq:2002', 105000), true)
  assert.strictEqual(g.createSendGate(10000).check('private:1||qq:1001', 1), true)
})

// ---- relaySignature（去重签名 = 身份 + 内容：同内容重复 chunk 去重，新内容/|nsfw 确认能过）----
test('relaySignature: 同内容 → 签名稳定相同', () => {
  const a = g.relaySignature('qq:1001', mk('膝丸', '', { desc: '哭泣特写', nsfw: false }))
  assert.strictEqual(a, g.relaySignature('qq:1001', mk('膝丸', '', { desc: '哭泣特写', nsfw: false })))
})
test('relaySignature: |nsfw 确认重发 / 新文字 / 不同图描述 → 签名不同', () => {
  const base = g.relaySignature('qq:1001', mk('膝丸', '', { desc: '哭泣特写', nsfw: false }))
  assert.notStrictEqual(base, g.relaySignature('qq:1001', mk('膝丸', '', { desc: '哭泣特写', nsfw: true })))
  assert.notStrictEqual(base, g.relaySignature('qq:1001', mk('膝丸', '补一句', { desc: '哭泣特写', nsfw: false })))
  assert.notStrictEqual(base, g.relaySignature('qq:1001', mk('膝丸', '', { desc: '午后阳光', nsfw: false })))
  assert.notStrictEqual(base, g.relaySignature('qq:1001', mk('膝丸', '', null)))
})

// ---- relay-tag ----
const rt = require('./relay-tag')
test('relay-tag: 纯文字', () => {
  const { relays } = rt.parseRelayTags('前 [[relay:芙蕾|你今天很可爱哦]] 后')
  assert.strictEqual(relays.length, 1)
  assert.strictEqual(relays[0].recipientAlias, '芙蕾')
  assert.strictEqual(relays[0].text, '你今天很可爱哦')
  assert.strictEqual(relays[0].photo, null)
})
test('relay-tag: 文字含竖线不丢', () => {
  const { relays } = rt.parseRelayTags('[[relay:小江|a|b|c]]')
  assert.strictEqual(relays[0].text, 'a|b|c')
})
test('relay-tag: 图片 + nsfw', () => {
  const { relays } = rt.parseRelayTags('[[relay:芙蕾|图=哭泣特写 眼角湿润|nsfw]]')
  assert.strictEqual(relays[0].text, '')
  assert.deepStrictEqual(relays[0].photo, { desc: '哭泣特写 眼角湿润', nsfw: true })
})
test('relay-tag: 文字 + 图', () => {
  const { relays } = rt.parseRelayTags('[[relay:芙蕾|看这张|图=午后阳光]]')
  assert.strictEqual(relays[0].text, '看这张')
  assert.deepStrictEqual(relays[0].photo, { desc: '午后阳光', nsfw: false })
})
test('relay-tag: 图描述可空 = 最近一张', () => {
  const { relays } = rt.parseRelayTags('[[relay:芙蕾|图=]]')
  assert.deepStrictEqual(relays[0].photo, { desc: '', nsfw: false })
})
test('relay-tag: 多标记', () => {
  const { relays } = rt.parseRelayTags('[[relay:芙蕾|嗨]][[relay:小江|哟]]')
  assert.strictEqual(relays.length, 2)
})
test('relay-tag: 占位别名忽略', () => {
  const { relays } = rt.parseRelayTags('[[relay:别名|示例]]')
  assert.strictEqual(relays.length, 0)
})
test('relay-tag: 别名缺失忽略', () => {
  const { relays } = rt.parseRelayTags('[[relay:|没人]]')
  assert.strictEqual(relays.length, 0)
})
test('relay-tag: |again 重发确认旗标（几分钟内连发同一人需显式确认）', () => {
  const { relays } = rt.parseRelayTags('[[relay:芙蕾|再说一次|again]]')
  assert.strictEqual(relays[0].again, true)
  assert.strictEqual(relays[0].text, '再说一次')
  const { relays: r2 } = rt.parseRelayTags('[[relay:芙蕾|图=那张|nsfw|再发]]')
  assert.strictEqual(r2[0].again, true)
  assert.deepStrictEqual(r2[0].photo, { desc: '那张', nsfw: true })
  const { relays: r3 } = rt.parseRelayTags('[[relay:芙蕾|嗨]]')
  assert.strictEqual(r3[0].again, false)
})
test('relay-tag: cleanedText 剥掉标记', () => {
  const { cleanedText } = rt.parseRelayTags('哈 [[relay:芙蕾|x]] 哈')
  assert.strictEqual(cleanedText.includes('[[relay:'), false)
})
test('relay-tag: hasRelayTag', () => {
  assert.strictEqual(rt.hasRelayTag('a [[relay:x|y]]'), true)
  assert.strictEqual(rt.hasRelayTag('无标记'), false)
})

console.log('\n' + pass + ' passed, ' + fail + ' failed')
process.exit(fail ? 1 : 0)
