'use strict'
const { test } = require('node:test')
const assert = require('node:assert/strict')
const lib = require('./lib')
const fs = require('fs')
const path = require('path')

// ───────────────────────── 关键词匹配 ─────────────────────────
test('matchKey: 中文子串命中(无词边界概念)', () => {
  assert.equal(lib.matchKey('今天去锻刀了', '锻刀', {}), true)
  assert.equal(lib.matchKey('今天去钓鱼了', '锻刀', {}), false)
})

test('matchKey: 英文默认整词匹配, king 不命中 liking', () => {
  assert.equal(lib.matchKey('long live the king', 'king', {}), true)
  assert.equal(lib.matchKey('i am liking it', 'king', {}), false)
  assert.equal(lib.matchKey('i am liking it', 'king', { wholeWord: false }), true)
})

test('matchKey: 大小写默认不敏感, 可开敏感', () => {
  assert.equal(lib.matchKey('The KING', 'king', {}), true)
  assert.equal(lib.matchKey('The KING', 'king', { caseSensitive: true }), false)
})

test('matchKey: /正则/ 形式的 key 走正则', () => {
  assert.equal(lib.matchKey('编号 2205年', '/\\d{4}年/', {}), true)
  assert.equal(lib.matchKey('没有数字', '/\\d{4}年/', {}), false)
})

// ───────────────────────── 条目激活 ─────────────────────────
test('entryActivates: 蓝灯无条件激活, 关了不激活', () => {
  assert.equal(lib.entryActivates({ enabled: true, constant: true, keys: [] }, '随便什么', {}), true)
  assert.equal(lib.entryActivates({ enabled: false, constant: true, keys: [] }, '随便什么', {}), false)
})

test('entryActivates: 绿灯命中任一 key 才激活', () => {
  const e = { enabled: true, constant: false, keys: ['锻刀', '锻冶'] }
  assert.equal(lib.entryActivates(e, '我去锻冶所看看', {}), true)
  assert.equal(lib.entryActivates(e, '今天天气好', {}), false)
})

test('entryActivates: 二级 AND_ALL 需全部次级命中', () => {
  const e = { enabled: true, constant: false, keys: ['出阵'], secondaryKeys: ['江户', '夜战'], logic: 'AND_ALL' }
  assert.equal(lib.entryActivates(e, '出阵到江户打夜战', {}), true)
  assert.equal(lib.entryActivates(e, '出阵到江户', {}), false)
})

test('entryActivates: 二级 NOT_ANY 命中次级则不激活', () => {
  const e = { enabled: true, constant: false, keys: ['出阵'], secondaryKeys: ['演练'], logic: 'NOT_ANY' }
  assert.equal(lib.entryActivates(e, '真的出阵了', {}), true)
  assert.equal(lib.entryActivates(e, '出阵只是演练', {}), false)
})

// ───────────────────────── 新近度 ─────────────────────────
test('lastMatchIndex: 取 key 最后一次出现的下标', () => {
  assert.equal(lib.lastMatchIndex('膝丸…后来又说膝丸', '膝丸'), 7)
  assert.equal(lib.lastMatchIndex('没有这个词', '膝丸'), -1)
})

test('lastMatchIndex: 英文整词 + 正则', () => {
  assert.equal(lib.lastMatchIndex('king ... king', 'king'), 9)
  assert.equal(lib.lastMatchIndex('a 12年b 99年', '/\\d+年/'), 7)
})

test('lastMatchIndex: 拉丁词默认整词(kingdom 不命中 king), wholeWord:false 才子串', () => {
  assert.equal(lib.lastMatchIndex('kingdoms fall', 'king'), -1)
  assert.equal(lib.lastMatchIndex('kingdoms fall', 'king', { wholeWord: false }), 0)
})

test('recencyScore: constant 恒为 Infinity', () => {
  assert.equal(lib.recencyScore({ constant: true, keys: [] }, '随便'), Infinity)
})

test('recencyScore: 绿灯取各 key 最后命中的最大下标', () => {
  const buffer = '先提到髭切,然后聊膝丸'
  const hige = lib.recencyScore({ constant: false, keys: ['髭切'] }, buffer)
  const hiza = lib.recencyScore({ constant: false, keys: ['膝丸'] }, buffer)
  assert.ok(hiza > hige, '膝丸在后,新近度应更高')
})

test('recencyScore: 多 key 取最靠后的那个', () => {
  const buffer = 'a膝丸b弟弟丸c'
  const s = lib.recencyScore({ constant: false, keys: ['膝丸', '弟弟丸'] }, buffer)
  assert.equal(s, buffer.lastIndexOf('弟弟丸'))
})

// ───────────────────────── token 估算 ─────────────────────────
test('estimateTokens: 中日文按字, 拉丁按 0.25', () => {
  assert.equal(lib.estimateTokens('锻刀'), 2)
  assert.equal(lib.estimateTokens('abcd'), 1)
  assert.equal(lib.estimateTokens('刀abcd'), 2)
  assert.equal(lib.estimateTokens(''), 0)
})

// ───────────────────────── 选条 + 排序 + 预算 ─────────────────────────
test('selectEntries: 蓝灯恒选, 绿灯命中才选, 无关只剩蓝灯', () => {
  const entries = [
    { comment: '核心世界观', enabled: true, constant: true, keys: [], content: '世界法则', order: 10 },
    { comment: '锻刀', enabled: true, constant: false, keys: ['锻刀'], content: '锻刀说明', order: 100 },
    { comment: '手入', enabled: true, constant: false, keys: ['手入'], content: '手入说明', order: 100 }
  ]
  const r = lib.selectEntries(entries, '我想去锻刀', { budgetTokens: 9999 })
  const names = r.selected.map((e) => e.comment)
  assert.deepEqual(names, ['核心世界观', '锻刀']) // 蓝灯 + 命中的锻刀; 手入未命中
})

test('selectEntries: 渲染顺序=蓝灯在前, 其余按 order 升序(高 order 沉底贴生成点)', () => {
  const entries = [
    { comment: 'A低order', enabled: true, constant: false, keys: ['x'], content: 'a', order: 50 },
    { comment: 'B高order', enabled: true, constant: false, keys: ['x'], content: 'b', order: 300 },
    { comment: 'C蓝灯', enabled: true, constant: true, keys: [], content: 'c', order: 999 }
  ]
  const r = lib.selectEntries(entries, 'x', { budgetTokens: 9999 })
  assert.deepEqual(r.selected.map((e) => e.comment), ['C蓝灯', 'A低order', 'B高order'])
})

test('selectEntries: 超预算时丢低优先(order 小的先丢), 高 order 与蓝灯保住, 记录 dropped', () => {
  const entries = [
    { comment: '蓝灯', enabled: true, constant: true, keys: [], content: '常驻常驻常驻常驻常驻', order: 0 }, // 10 tokens
    { comment: '高order', enabled: true, constant: false, keys: ['x'], content: '高高高高高', order: 300 }, // 5
    { comment: '低order', enabled: true, constant: false, keys: ['x'], content: '低低低低低', order: 50 } // 5
  ]
  // 预算 15:蓝灯(10)+高order(5)=15 正好;低order 被丢
  const r = lib.selectEntries(entries, 'x', { budgetTokens: 15 })
  assert.deepEqual(r.selected.map((e) => e.comment).sort(), ['蓝灯', '高order'].sort())
  assert.deepEqual(r.dropped.map((e) => e.comment), ['低order'])
})

test('selectEntries: 分类上限——刀男人设>限额时按新近度保留前N', () => {
  const mk = (name, kw) => ({ comment: name, category: '刀男人设', enabled: true, constant: false, keys: [kw], content: name + '的档案', order: 79 })
  const entries = [mk('髭切', '髭切'), mk('膝丸', '膝丸'), mk('鹤丸', '鹤丸')]
  // buffer 里顺序:髭切 → 鹤丸 → 膝丸(膝丸最新近)
  const buffer = '先说髭切,再说鹤丸,最后说膝丸'
  const r = lib.selectEntries(entries, buffer, { budgetTokens: 99999, categoryLimits: { '刀男人设': 2 } })
  const names = r.selected.map((e) => e.comment)
  assert.equal(names.length, 2)
  assert.ok(names.includes('膝丸') && names.includes('鹤丸'), '应保留最新近的膝丸+鹤丸')
  assert.ok(!names.includes('髭切'), '最早提到的髭切被挤掉')
  assert.deepEqual(r.capDropped.map((e) => e.comment), ['髭切'])
})

test('selectEntries: 不受限的类别不裁剪', () => {
  const mk = (name, cat) => ({ comment: name, category: cat, enabled: true, constant: false, keys: [name], content: name, order: 79 })
  const entries = [mk('花野', '审神者'), mk('小江', '审神者'), mk('髭切', '刀男人设')]
  const r = lib.selectEntries(entries, '花野 小江 髭切', { budgetTokens: 99999, categoryLimits: { '刀男人设': 10 } })
  assert.equal(r.selected.length, 3, '审神者类无上限,全保留')
  assert.equal(r.capDropped.length, 0)
})

test('selectEntries: 无 categoryLimits 时行为同现状(回归)', () => {
  const entries = [
    { comment: 'A', category: '刀男人设', enabled: true, constant: false, keys: ['x'], content: 'a', order: 79 },
    { comment: 'B', category: '刀男人设', enabled: true, constant: false, keys: ['x'], content: 'b', order: 79 }
  ]
  const r = lib.selectEntries(entries, 'x', { budgetTokens: 99999 })
  assert.equal(r.selected.length, 2)
  assert.deepEqual(r.capDropped, [])
})

test('renderEntries: 用分隔拼接 content', () => {
  const s = lib.renderEntries([{ content: 'A' }, { content: 'B' }])
  assert.match(s, /A/)
  assert.match(s, /B/)
  assert.ok(s.indexOf('A') < s.indexOf('B'))
})

// ───────────────────────── 扫描缓冲区 ─────────────────────────
test('buildScanBuffer: 取最近 N 条消息的 content 拼接', () => {
  const msgs = [{ content: '一' }, { content: '二' }, { content: '三' }, { content: '四' }]
  const buf = lib.buildScanBuffer(msgs, 2)
  assert.match(buf, /三/)
  assert.match(buf, /四/)
  assert.doesNotMatch(buf, /一/)
})

test('buildScanBuffer: 空/缺失安全', () => {
  assert.equal(lib.buildScanBuffer(null, 3), '')
  assert.equal(lib.buildScanBuffer([], 3), '')
})

// ───────────────────────── 酒馆宏处理 ─────────────────────────
test('stripMacros: 替换 {{user}}/{{char}}, 删除其它未知宏', () => {
  assert.equal(lib.stripMacros('为{{user}}而战', { user: '主人', char: '髭切' }), '为主人而战')
  assert.equal(lib.stripMacros('{{char}}是其中之一', { user: '主人', char: '髭切' }), '髭切是其中之一')
  assert.equal(lib.stripMacros('a{{setvar::x::1}}b', { user: '主人', char: '髭切' }), 'ab')
})

// ───────────────────────── 酒馆 → koishi 转换 ─────────────────────────
test('isJunkStEntry: 空内容/分隔条/勿开/禁用 判为垃圾', () => {
  assert.equal(lib.isJunkStEntry({ comment: '━分隔栏━', content: '' }), true)
  assert.equal(lib.isJunkStEntry({ comment: '(勿开调整中)论坛', content: '有内容' }), true)
  assert.equal(lib.isJunkStEntry({ comment: '锻刀', content: '说明', disable: true }), true)
  assert.equal(lib.isJunkStEntry({ comment: '锻刀', content: '说明' }), false)
})

test('convertStEntry: 字段映射 + 宏处理 + selectiveLogic 映射', () => {
  const st = { comment: '锻刀', key: ['锻刀', '锻冶'], keysecondary: [], content: '为{{user}}锻造', constant: false, order: 120, selectiveLogic: 3 }
  const k = lib.convertStEntry(st, { user: '主人', char: '髭切' })
  assert.equal(k.comment, '锻刀')
  assert.deepEqual(k.keys, ['锻刀', '锻冶'])
  assert.equal(k.constant, false)
  assert.equal(k.content, '为主人锻造')
  assert.equal(k.order, 120)
  assert.equal(k.logic, 'AND_ALL') // selectiveLogic 3 → AND_ALL
  assert.equal(k.enabled, true)
})

test('convertStWorldbook: 过滤垃圾条, 全部转换', () => {
  const stJson = { entries: {
    0: { comment: '核心世界观', key: [], content: '法则', constant: true, order: 10 },
    1: { comment: '━分隔栏━', key: [], content: '', constant: false, order: 11 },
    2: { comment: '锻刀', key: ['锻刀'], content: '说明', constant: false, order: 100 },
    3: { comment: '(勿开调整中)论坛', key: ['论坛'], content: 'x', constant: false, order: 101 }
  } }
  const out = lib.convertStWorldbook(stJson, { user: '主人', char: '髭切' })
  assert.deepEqual(out.map((e) => e.comment), ['核心世界观', '锻刀'])
})

// ──────────── 集成:真·职业手册(转换产物)上的扫描→选条链路 ────────────
const BOOK = path.join(__dirname, 'data', '审神者职业手册.koishi.json')
function loadBook() { return JSON.parse(fs.readFileSync(BOOK, 'utf8')).entries }

test('集成: 聊到「锻刀」→ 注入锻刀条 + 核心世界观(蓝灯); 不带手入', () => {
  const entries = loadBook()
  const { selected } = lib.selectEntries(entries, '主人今天想去锻刀吗', { budgetTokens: 99999 })
  const names = selected.map((e) => e.comment)
  assert.ok(names.some((n) => n.includes('锻刀')), '应命中锻刀')
  assert.ok(names.some((n) => n.includes('核心世界观')), '蓝灯核心世界观应恒在')
  assert.ok(!names.some((n) => n.includes('手入')), '未提手入则不应注入手入')
})

test('集成: 无关键词闲聊 → 只剩蓝灯(核心世界观)', () => {
  const entries = loadBook()
  const { selected } = lib.selectEntries(entries, '今天天气真不错呀哈哈', { budgetTokens: 99999 })
  assert.deepEqual(selected.map((e) => e.comment), ['📋核心世界观📋'])
})

test('集成: 聊到「出阵」→ 注入战场通则', () => {
  const entries = loadBook()
  const { selected } = lib.selectEntries(entries, '准备出阵了', { budgetTokens: 99999 })
  assert.ok(selected.some((e) => e.comment.includes('战场通则')))
})

test('集成: 渲染产物含命中条目正文, 蓝灯排在最前', () => {
  const entries = loadBook()
  const { selected } = lib.selectEntries(entries, '去手入一下', { budgetTokens: 99999 })
  assert.equal(selected[0].comment, '📋核心世界观📋') // 蓝灯置顶
  const text = lib.renderEntries(selected)
  assert.match(text, /手入/)
})

// ───────────────────────── 分类 / 刀帐规则 ─────────────────────────
test('convertStEntry: opts.categorize 命中则写 category', () => {
  const st = { comment: '髭切', key: ['髭切'], content: '档案', constant: false, order: 79 }
  const k = lib.convertStEntry(st, {}, { categorize: () => '刀男人设' })
  assert.equal(k.category, '刀男人设')
})

test('convertStEntry: 不传 categorize 时无 category(向后兼容)', () => {
  const st = { comment: '髭切', key: ['髭切'], content: '档案', constant: false, order: 79 }
  const k = lib.convertStEntry(st, {})
  assert.equal(k.category, undefined)
})

test('toudanCategory: 老师的审→审神者, 其余→刀男人设', () => {
  assert.equal(lib.toudanCategory({ comment: '花野老师的审' }), '审神者')
  assert.equal(lib.toudanCategory({ comment: '髭切' }), '刀男人设')
})

test('isToudanSkip: 使用说明 / 妖祀 跳过', () => {
  assert.equal(lib.isToudanSkip({ comment: '使用说明' }), true)
  assert.equal(lib.isToudanSkip({ comment: '妖祀老师的审' }), true)
  assert.equal(lib.isToudanSkip({ comment: '花野老师的审' }), false)
  assert.equal(lib.isToudanSkip({ comment: '髭切' }), false)
})

test('isToudanSkip/toudanCategory: 缺 comment 安全不抛', () => {
  assert.equal(lib.isToudanSkip({}), false)
  assert.equal(lib.isToudanSkip(null), false)
  assert.equal(lib.toudanCategory({}), '刀男人设')
  assert.equal(lib.toudanCategory(null), '刀男人设')
})

test('convertStWorldbook: skip+categorize 联动(刀帐规则)', () => {
  const stJson = { entries: {
    0: { comment: '髭切', key: ['髭切'], content: '刀档案', constant: false, order: 79 },
    1: { comment: '花野老师的审', key: ['花野'], content: '审神者画像', constant: false, order: 79 },
    2: { comment: '妖祀老师的审', key: ['妖祀'], content: '本人画像', constant: false, order: 79 },
    3: { comment: '使用说明', key: [], content: '怎么用', constant: false, order: 1 }
  } }
  const out = lib.convertStWorldbook(stJson, {}, { skip: lib.isToudanSkip, categorize: lib.toudanCategory })
  assert.deepEqual(out.map((e) => e.comment), ['髭切', '花野老师的审'])
  assert.equal(out.find((e) => e.comment === '髭切').category, '刀男人设')
  assert.equal(out.find((e) => e.comment === '花野老师的审').category, '审神者')
})

test('convertStEntry: categorize 返回空串则不写 category', () => {
  const st = { comment: 'x', key: ['x'], content: 'c', constant: false, order: 79 }
  const k = lib.convertStEntry(st, {}, { categorize: () => '' })
  assert.equal(k.category, undefined)
})
