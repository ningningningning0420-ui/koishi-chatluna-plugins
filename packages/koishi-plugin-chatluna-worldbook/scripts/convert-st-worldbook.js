#!/usr/bin/env node
'use strict'
// 把 SillyTavern(酒馆)世界书 .json 转成本插件的 koishi 世界书 json。
// 用法: node scripts/convert-st-worldbook.js <输入.json> <输出.json> [--user 主人] [--char 髭切]
const fs = require('fs')
const lib = require('../lib')

function parseArgs(argv) {
  const pos = []
  const opt = { user: '主人', char: '' }
  for (let i = 0; i < argv.length; i++) {
    if (argv[i] === '--user') opt.user = argv[++i]
    else if (argv[i] === '--char') opt.char = argv[++i]
    else if (argv[i] === '--preset') opt.preset = argv[++i]
    else pos.push(argv[i])
  }
  return { input: pos[0], output: pos[1], opt }
}

function main() {
  const { input, output, opt } = parseArgs(process.argv.slice(2))
  if (!input || !output) {
    console.error('用法: convert-st-worldbook.js <输入.json> <输出.json> [--user 名] [--char 名]')
    process.exit(1)
  }
  const stJson = JSON.parse(fs.readFileSync(input, 'utf8'))
  const total = Object.keys(stJson.entries || {}).length
  const convOpts = {}
  if (opt.preset === 'toudan') {
    convOpts.skip = lib.isToudanSkip
    convOpts.categorize = lib.toudanCategory
    // 审神者画像(「XX老师的审」)在源刀帐里是 disable 的,这里直接启用导入;妖祀由 skip 排除
    for (const e of Object.values(stJson.entries || {})) {
      if (/老师的审/.test(String(e.comment || ''))) e.disable = false
    }
  }
  const entries = lib.convertStWorldbook(stJson, { user: opt.user, char: opt.char }, convOpts)
  const out = {
    name: require('path').basename(input).replace(/\.json$/i, ''),
    source: 'sillytavern',
    convertedAt: null, // 由调用方按需戳时间;脚本内不取系统时间,保持可复现
    entries
  }
  fs.writeFileSync(output, JSON.stringify(out, null, 2))
  const blue = entries.filter((e) => e.constant).length
  console.log(`转换完成: ${input}`)
  console.log(`  原始条目 ${total} → 有效 ${entries.length}(剔除垃圾/空/勿开 ${total - entries.length} 条)`)
  console.log(`  蓝灯常驻 ${blue} 条 · 绿灯触发 ${entries.length - blue} 条`)
  console.log(`  宏替换 user="${opt.user}" char="${opt.char}"`)
  const catCount = entries.reduce((m, e) => { const c = e.category || '(无)'; m[c] = (m[c] || 0) + 1; return m }, {})
  console.log(`  分类分布: ${Object.entries(catCount).map(([k, v]) => `${k}=${v}`).join(' · ')}`)
  console.log(`  写出: ${output}`)
}

main()
