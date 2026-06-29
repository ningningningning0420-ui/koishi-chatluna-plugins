'use strict'
// 纯逻辑模块:无 koishi 依赖,可离线单测(node --test)。
// 世界书(lorebook)关键词扫描 + 选条 + 预算 + 酒馆(SillyTavern)世界书转换。

// ───────────────────────── 关键词匹配 ─────────────────────────
function isRegexKey(key) {
  return /^\/.*\/[a-z]*$/i.test(key)
}
function compileRegex(key) {
  const m = String(key).match(/^\/(.*)\/([a-z]*)$/i)
  return new RegExp(m[1], m[2])
}
// 中日文(及全角)→ 子串匹配;无词边界概念
function hasCJK(s) {
  return /[぀-ヿ㐀-䶿一-鿿豈-﫿＀-￯]/.test(s)
}
function matchKey(buffer, key, opts = {}) {
  buffer = String(buffer == null ? '' : buffer)
  key = String(key == null ? '' : key)
  if (!key) return false
  if (isRegexKey(key)) {
    try { return compileRegex(key).test(buffer) } catch (e) { return false }
  }
  const cs = !!opts.caseSensitive
  const b = cs ? buffer : buffer.toLowerCase()
  const k = cs ? key : key.toLowerCase()
  const whole = opts.wholeWord !== false
  if (hasCJK(k) || !whole) return b.includes(k)
  // 纯拉丁 key 默认整词匹配
  const esc = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  try { return new RegExp(`\\b${esc}\\b`).test(b) } catch (e) { return b.includes(k) }
}

// ───────────────────────── 条目激活 ─────────────────────────
function entryActivates(entry, buffer, opts = {}) {
  if (!entry || entry.enabled === false) return false
  if (entry.constant) return true
  const matchOpts = {
    caseSensitive: entry.caseSensitive != null ? entry.caseSensitive : opts.caseSensitive,
    wholeWord: entry.matchWholeWord != null ? entry.matchWholeWord : opts.wholeWord
  }
  const keys = entry.keys || []
  const primary = keys.some((k) => matchKey(buffer, k, matchOpts))
  if (!primary) return false
  const sec = entry.secondaryKeys || []
  if (!sec.length) return true
  const matched = sec.map((k) => matchKey(buffer, k, matchOpts))
  const any = matched.some(Boolean)
  const all = matched.every(Boolean)
  switch (entry.logic || 'AND_ANY') {
    case 'AND_ALL': return all
    case 'NOT_ANY': return !any
    case 'NOT_ALL': return !all
    case 'AND_ANY':
    default: return any
  }
}

// ───────────────────────── 新近度(最后命中位置) ─────────────────────────
// 返回 key 在 buffer 中最后一次命中的字符下标(未命中 = -1)。
function lastMatchIndex(buffer, key, opts = {}) {
  buffer = String(buffer == null ? '' : buffer)
  key = String(key == null ? '' : key)
  if (!key) return -1
  if (isRegexKey(key)) {
    let re
    try { re = compileRegex(key) } catch (e) { return -1 }
    const g = new RegExp(re.source, re.flags.includes('g') ? re.flags : re.flags + 'g')
    let last = -1, m
    while ((m = g.exec(buffer)) !== null) {
      last = m.index
      if (m.index === g.lastIndex) g.lastIndex++ // 防零宽匹配死循环
    }
    return last
  }
  const cs = !!opts.caseSensitive
  const b = cs ? buffer : buffer.toLowerCase()
  const k = cs ? key : key.toLowerCase()
  // 默认整词匹配(wholeWord=true),与 matchKey/entryActivates 的命中判定保持一致——否则会"命中了却算不出位置"
  const whole = opts.wholeWord !== false
  if (hasCJK(k) || !whole) return b.lastIndexOf(k)
  const esc = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  let re
  try { re = new RegExp(`\\b${esc}\\b`, 'g') } catch (e) { return b.lastIndexOf(k) } // 正则编译失败时降级到子串匹配 // 正则编译失败时降级到子串匹配
  let last = -1, m
  while ((m = re.exec(b)) !== null) { last = m.index; if (m.index === re.lastIndex) re.lastIndex++ }
  return last
}

// 条目新近度:constant 恒 Infinity;绿灯取所有 key 最后命中下标的最大值。
function recencyScore(entry, buffer, opts = {}) {
  if (!entry) return -1
  if (entry.constant) return Infinity
  const matchOpts = {
    caseSensitive: entry.caseSensitive != null ? entry.caseSensitive : opts.caseSensitive,
    wholeWord: entry.matchWholeWord != null ? entry.matchWholeWord : opts.wholeWord
  }
  let best = -1
  for (const key of entry.keys || []) {
    const idx = lastMatchIndex(buffer, key, matchOpts)
    if (idx > best) best = idx
  }
  return best
}

// ───────────────────────── token 估算(粗) ─────────────────────────
function estimateTokens(s) {
  s = String(s == null ? '' : s)
  let t = 0
  for (const ch of s) t += /[぀-ヿ㐀-䶿一-鿿豈-﫿]/.test(ch) ? 1 : 0.25
  return Math.ceil(t)
}

// ───────────────────────── 选条 + 排序 + 预算 ─────────────────────────
function _orderOf(e) { return e.order == null ? 100 : e.order }
function selectEntries(entries, buffer, opts = {}) {
  const budget = opts.budgetTokens == null ? Infinity : opts.budgetTokens
  const activated = (entries || []).filter((e) => entryActivates(e, buffer, opts))
  // 保留优先级:蓝灯优先,其次 order 大者优先(高 order=更重要,预算紧时保住)
  const byPriority = activated.slice().sort((a, b) => {
    if (!!b.constant !== !!a.constant) return (b.constant ? 1 : 0) - (a.constant ? 1 : 0)
    return _orderOf(b) - _orderOf(a)
  })
  const kept = []
  const dropped = []
  let used = 0
  for (const e of byPriority) {
    const t = estimateTokens(e.content)
    if (used + t <= budget) { kept.push(e); used += t } else dropped.push(e)
  }
  // 渲染顺序:蓝灯在前,其余 order 升序(高 order 沉底,贴生成点)
  const selected = kept.slice().sort((a, b) => {
    if (!!b.constant !== !!a.constant) return (b.constant ? 1 : 0) - (a.constant ? 1 : 0)
    return _orderOf(a) - _orderOf(b)
  })
  return { selected, dropped, usedTokens: used }
}

function renderEntries(entries) {
  return (entries || [])
    .map((e) => String((e && e.content) || '').trim())
    .filter(Boolean)
    .join('\n\n')
}

// ───────────────────────── 扫描缓冲区 ─────────────────────────
function buildScanBuffer(messages, depth) {
  if (!Array.isArray(messages) || !messages.length) return ''
  const n = depth > 0 ? depth : messages.length
  return messages.slice(-n).map((m) => String((m && m.content) || '')).join('\n')
}

// ───────────────────────── 酒馆宏处理 ─────────────────────────
function stripMacros(s, ctx = {}) {
  s = String(s == null ? '' : s)
  s = s.replace(/\{\{user\}\}/gi, ctx.user == null ? '' : ctx.user)
  s = s.replace(/\{\{char\}\}/gi, ctx.char == null ? '' : ctx.char)
  s = s.replace(/\{\{[^}]*\}\}/g, '') // 删除其它未知宏(setvar/getvar 等)
  return s
}

// ───────────────────────── 酒馆 → koishi 转换 ─────────────────────────
// SillyTavern selectiveLogic: 0=AND ANY, 1=NOT ALL, 2=NOT ANY, 3=AND ALL
const ST_LOGIC = { 0: 'AND_ANY', 1: 'NOT_ALL', 2: 'NOT_ANY', 3: 'AND_ALL' }

function isJunkStEntry(e) {
  if (!e) return true
  if (e.disable === true) return true
  const content = String(e.content == null ? '' : e.content).trim()
  if (!content) return true // 空内容/分隔条
  if (String(e.comment || '').includes('勿开') || content.includes('勿开')) return true
  return false
}

function convertStEntry(st, ctx = {}) {
  return {
    comment: st.comment || '',
    keys: (st.key || []).slice(),
    secondaryKeys: (st.keysecondary || []).slice(),
    logic: ST_LOGIC[st.selectiveLogic] || 'AND_ANY',
    constant: !!st.constant,
    content: stripMacros(st.content, ctx),
    order: st.order == null ? 100 : st.order,
    enabled: st.disable !== true
  }
}

function convertStWorldbook(stJson, ctx = {}) {
  const entries = (stJson && stJson.entries) || {}
  return Object.values(entries).filter((e) => !isJunkStEntry(e)).map((e) => convertStEntry(e, ctx))
}

module.exports = {
  matchKey, entryActivates, estimateTokens, selectEntries, renderEntries,
  buildScanBuffer, stripMacros, isJunkStEntry, convertStEntry, convertStWorldbook,
  lastMatchIndex, recencyScore
}
