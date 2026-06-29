# 世界书分类触发上限 + 刀帐图鉴导入 Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** 给 chatluna-worldbook 加「按 category 限制每轮注入条数(超额按出现新近度取舍)」能力,并导入简版刀帐 v1.1,首用途=刀男人设类每轮≤10条。

**Architecture:** 纯 JS、CommonJS。新近度与分类裁剪全部落在无依赖的 `lib.js`(可 `node --test` 离线测);`index.js` 仅做 config 接入与 debug;转换脚本 `scripts/convert-st-worldbook.js` 加 `--preset toudan` 套用刀帐专用「跳过+分类」规则。所有改动向后兼容——不传新 opts 时行为同现状。

**Tech Stack:** Node.js (`node:test`/`node:assert`)、koishi `Schema`(仅 index.js)。

## Global Constraints

- 语言:纯 JavaScript(无 TS)、CommonJS `require`/`module.exports`。
- `lib.js` 不得 `require('koishi')` 或任何运行时依赖——必须可 `node --test` 离线跑。
- **向后兼容**:现有 `test.js` 全部用例必须继续通过;新增 opts 参数一律可选、默认行为不变。
- **不污染共享条目**:`selectEntries` 不得给传入的 entry 对象写新属性(`allEntries` 是热重载共享引用)。被裁剪的条目放进**返回值**,不挂在 entry 上。
- 刀帐文案规则(verbatim):`comment` 含「使用说明」或「妖祀」→ **跳过不导入**;`comment` 含「老师的审」→ `category="审神者"`;其余刀名条目 → `category="刀男人设"`。
- 上限默认 `{ 刀男人设: 10 }`;超额取舍 = **出现新近度降序**(buffer 中 key 最后出现位置越大越优先),平局按 `order` 降序。
- 渲染顺序不变(constant 优先 + order 升序);新近度**只**用于「选谁」,不用于「怎么排」。
- 测试命令统一:在包目录 `koishi-plugin-chatluna-worldbook/` 下跑 `node --test`。
- Commit:worktree 的 post-commit hook 会自动 `git push origin feat/worldbook`,无需手动 push。

工作目录(下文 `<PKG>`):
`/Users/iris/Documents/机器人/koishi-plugins-worktrees/feat-worldbook/packages/koishi-plugin-chatluna-worldbook`

---

## Task 0: 提交插件基线

当前整个 worldbook 插件包在 `feat/worldbook` 分支是**未跟踪**状态(`?? packages/koishi-plugin-chatluna-worldbook/`)。先提交基线,后续每个 task 的 diff 才干净。

- [ ] **Step 1: 确认未跟踪状态**

Run: `cd /Users/iris/Documents/机器人/koishi-plugins-worktrees/feat-worldbook && git status --short`
Expected: 看到 `?? packages/koishi-plugin-chatluna-worldbook/`

- [ ] **Step 2: 跑现有测试确认基线绿**

Run: `cd <PKG> && node --test`
Expected: 全部 PASS(现有 ~20 用例)

- [ ] **Step 3: 提交基线**

```bash
cd /Users/iris/Documents/机器人/koishi-plugins-worktrees/feat-worldbook
git add packages/koishi-plugin-chatluna-worldbook
git commit -m "chore(worldbook): 提交插件基线(category-cap 开发前)"
```
Expected: post-commit 输出 `pushed feat/worldbook to origin`

---

## Task 1: lib — 新近度计算 `recencyScore` / `lastMatchIndex`

**Files:**
- Modify: `<PKG>/lib.js`(新增 `lastMatchIndex`、`recencyScore`,挂到 exports)
- Test: `<PKG>/test.js`

**Interfaces:**
- Produces:
  - `lastMatchIndex(buffer: string, key: string, opts?: {caseSensitive?, wholeWord?}) => number` — key 最后命中下标,未命中 `-1`。
  - `recencyScore(entry, buffer: string, opts?) => number` — constant→`Infinity`;绿灯→所有 keys 最后命中下标的最大值;无命中→`-1`。

- [ ] **Step 1: Write the failing test**

在 `test.js` 的「token 估算」段之前插入:

```js
// ───────────────────────── 新近度 ─────────────────────────
test('lastMatchIndex: 取 key 最后一次出现的下标', () => {
  assert.equal(lib.lastMatchIndex('膝丸……后来又说膝丸', '膝丸'), 7)
  assert.equal(lib.lastMatchIndex('没有这个词', '膝丸'), -1)
})

test('lastMatchIndex: 英文整词 + 正则', () => {
  assert.equal(lib.lastMatchIndex('king ... king', 'king'), 9)
  assert.equal(lib.lastMatchIndex('a 12年 b 99年', '/\\d+年/'), 7)
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd <PKG> && node --test`
Expected: 上述用例 FAIL（`lib.lastMatchIndex is not a function`）

- [ ] **Step 3: Write minimal implementation**

在 `lib.js` 的 `estimateTokens` 函数定义**之前**插入:

```js
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
  const whole = opts.wholeWord !== false
  if (hasCJK(k) || !whole) return b.lastIndexOf(k)
  const esc = k.replace(/[.*+?^${}()|[\]\\]/g, '\\$&')
  let re
  try { re = new RegExp(`\\b${esc}\\b`, 'g') } catch (e) { return b.lastIndexOf(k) }
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
```

在 `module.exports` 里加上两个名字:

```js
module.exports = {
  matchKey, entryActivates, estimateTokens, selectEntries, renderEntries,
  buildScanBuffer, stripMacros, isJunkStEntry, convertStEntry, convertStWorldbook,
  lastMatchIndex, recencyScore
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd <PKG> && node --test`
Expected: 全部 PASS(含新 4 个 + 原有用例)

- [ ] **Step 5: Commit**

```bash
cd /Users/iris/Documents/机器人/koishi-plugins-worktrees/feat-worldbook
git add packages/koishi-plugin-chatluna-worldbook/lib.js packages/koishi-plugin-chatluna-worldbook/test.js
git commit -m "feat(worldbook): 新近度计算 recencyScore/lastMatchIndex"
```

---

## Task 2: lib — `selectEntries` 分类条数上限

**Files:**
- Modify: `<PKG>/lib.js`(替换 `selectEntries`)
- Test: `<PKG>/test.js`

**Interfaces:**
- Consumes: `recencyScore`(Task 1)、`_orderOf`、`entryActivates`、`estimateTokens`(现有)
- Produces: `selectEntries(entries, buffer, opts)` 返回 `{ selected, dropped, usedTokens, capDropped }`。
  - `opts.categoryLimits?: Record<string, number>` — 键=category,值=该类每轮最多条数。
  - `dropped` 语义不变(预算丢弃);新增 `capDropped` = 被分类上限挤掉的条目数组。

- [ ] **Step 1: Write the failing test**

在 `test.js` 的「选条 + 排序 + 预算」段末尾(`renderEntries` 测试之前)插入:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd <PKG> && node --test`
Expected: 新 3 用例 FAIL（`capDropped` undefined / 长度不符）

- [ ] **Step 3: Write minimal implementation**

把 `lib.js` 里现有 `selectEntries` 整个函数替换为:

```js
function selectEntries(entries, buffer, opts = {}) {
  const budget = opts.budgetTokens == null ? Infinity : opts.budgetTokens
  const categoryLimits = opts.categoryLimits || {}
  let activated = (entries || []).filter((e) => entryActivates(e, buffer, opts))
  const capDropped = []

  // —— 分类条数上限:超额按新近度降序(平局 order 降序)保留前 N ——
  for (const cat of Object.keys(categoryLimits)) {
    const lim = Number(categoryLimits[cat])
    if (!(lim >= 0)) continue
    const inCat = activated.filter((e) => e.category === cat)
    if (inCat.length <= lim) continue
    const ranked = inCat.slice().sort((a, b) => {
      const ra = recencyScore(a, buffer, opts), rb = recencyScore(b, buffer, opts)
      if (rb !== ra) return rb - ra
      return _orderOf(b) - _orderOf(a)
    })
    const keep = new Set(ranked.slice(0, lim))
    activated = activated.filter((e) => e.category !== cat || keep.has(e))
    capDropped.push(...ranked.slice(lim))
  }

  // —— 预算裁剪(保留优先级:蓝灯优先,其次 order 大者优先) ——
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
  return { selected, dropped, usedTokens: used, capDropped }
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd <PKG> && node --test`
Expected: 全部 PASS(新 3 + 原有,含原 `dropped` 用例不变)

- [ ] **Step 5: Commit**

```bash
cd /Users/iris/Documents/机器人/koishi-plugins-worktrees/feat-worldbook
git add packages/koishi-plugin-chatluna-worldbook/lib.js packages/koishi-plugin-chatluna-worldbook/test.js
git commit -m "feat(worldbook): selectEntries 分类条数上限(超额按新近度)"
```

---

## Task 3: lib — 转换支持 category/skip + 刀帐规则

**Files:**
- Modify: `<PKG>/lib.js`(`convertStEntry`、`convertStWorldbook` 加 opts;新增 `isToudanSkip`、`toudanCategory`)
- Test: `<PKG>/test.js`

**Interfaces:**
- Produces:
  - `convertStEntry(st, ctx?, opts?)` — `opts.categorize?(st)=>string` 命中则给产物加 `category`。
  - `convertStWorldbook(stJson, ctx?, opts?)` — `opts.skip?(st)=>boolean` 跳过、`opts.categorize` 透传。
  - `isToudanSkip(st)=>boolean` — comment 含「使用说明」或「妖祀」。
  - `toudanCategory(st)=>string` — comment 含「老师的审」→`"审神者"`,否则 `"刀男人设"`。

- [ ] **Step 1: Write the failing test**

在 `test.js` 末尾追加:

```js
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
```

- [ ] **Step 2: Run test to verify it fails**

Run: `cd <PKG> && node --test`
Expected: 新用例 FAIL（`lib.toudanCategory is not a function` 等）

- [ ] **Step 3: Write minimal implementation**

在 `lib.js` 把 `convertStEntry` 与 `convertStWorldbook` 替换为:

```js
function convertStEntry(st, ctx = {}, opts = {}) {
  const entry = {
    comment: st.comment || '',
    keys: (st.key || []).slice(),
    secondaryKeys: (st.keysecondary || []).slice(),
    logic: ST_LOGIC[st.selectiveLogic] || 'AND_ANY',
    constant: !!st.constant,
    content: stripMacros(st.content, ctx),
    order: st.order == null ? 100 : st.order,
    enabled: st.disable !== true
  }
  if (typeof opts.categorize === 'function') {
    const cat = opts.categorize(st)
    if (cat) entry.category = cat
  }
  return entry
}

function convertStWorldbook(stJson, ctx = {}, opts = {}) {
  const entries = (stJson && stJson.entries) || {}
  return Object.values(entries)
    .filter((e) => !isJunkStEntry(e))
    .filter((e) => (typeof opts.skip === 'function' ? !opts.skip(e) : true))
    .map((e) => convertStEntry(e, ctx, opts))
}

// —— 刀帐图鉴专用规则 ——
function isToudanSkip(st) {
  const c = String((st && st.comment) || '')
  return /使用说明/.test(c) || /妖祀/.test(c)
}
function toudanCategory(st) {
  const c = String((st && st.comment) || '')
  return /老师的审/.test(c) ? '审神者' : '刀男人设'
}
```

在 `module.exports` 追加 `isToudanSkip, toudanCategory`(其余名字保持):

```js
module.exports = {
  matchKey, entryActivates, estimateTokens, selectEntries, renderEntries,
  buildScanBuffer, stripMacros, isJunkStEntry, convertStEntry, convertStWorldbook,
  lastMatchIndex, recencyScore, isToudanSkip, toudanCategory
}
```

- [ ] **Step 4: Run test to verify it passes**

Run: `cd <PKG> && node --test`
Expected: 全部 PASS（含原 `convertStWorldbook: 过滤垃圾条` 用例——它不传 opts,行为不变)

- [ ] **Step 5: Commit**

```bash
cd /Users/iris/Documents/机器人/koishi-plugins-worktrees/feat-worldbook
git add packages/koishi-plugin-chatluna-worldbook/lib.js packages/koishi-plugin-chatluna-worldbook/test.js
git commit -m "feat(worldbook): 转换支持 category/skip + 刀帐规则"
```

---

## Task 4: 转换脚本 `--preset toudan` + 生成刀帐图鉴

**Files:**
- Modify: `<PKG>/scripts/convert-st-worldbook.js`
- 产物: `/Users/iris/Documents/机器人/koishi-app/data/chathub/character/worldbooks/刀帐图鉴.koishi.json`

**Interfaces:**
- Consumes: `lib.convertStWorldbook` / `isToudanSkip` / `toudanCategory`(Task 3)

- [ ] **Step 1: 改脚本支持 `--preset`**

`scripts/convert-st-worldbook.js` 的 `parseArgs` 里,在 `--char` 分支后加:

```js
    else if (argv[i] === '--preset') opt.preset = argv[++i]
```

`main()` 里把 `const entries = lib.convertStWorldbook(...)` 这一行替换为:

```js
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
```

在 `console.log(`  蓝灯常驻 ...`)` 之后追加 category 分布打印:

```js
  const catCount = entries.reduce((m, e) => { const c = e.category || '(无)'; m[c] = (m[c] || 0) + 1; return m }, {})
  console.log(`  分类分布: ${Object.entries(catCount).map(([k, v]) => `${k}=${v}`).join(' · ')}`)
```

- [ ] **Step 2: 跑脚本生成刀帐图鉴**

Run:
```bash
cd <PKG>
node scripts/convert-st-worldbook.js \
  "/Users/iris/tavern/SillyTavern/data/default-user/worlds/⚔️时政专供-简版刀帐 v1.1⚔️ BY芙蕾.json" \
  "/Users/iris/Documents/机器人/koishi-app/data/chathub/character/worldbooks/刀帐图鉴.koishi.json" \
  --preset toudan --char 髭切
```
Expected 输出含:`分类分布: 刀男人设=125 · 审神者=8`(妖祀已删、使用说明已删;9 个「老师的审」源数据为 disable,经 Step 1 的 enable loop 启用,删妖祀后剩 8)

- [ ] **Step 3: 校验产物**

Run:
```bash
node -e '
  const j=require("/Users/iris/Documents/机器人/koishi-app/data/chathub/character/worldbooks/刀帐图鉴.koishi.json");
  const es=j.entries;
  const byCat=es.reduce((m,e)=>{const c=e.category||"(无)";m[c]=(m[c]||0)+1;return m},{});
  console.log("分类:",JSON.stringify(byCat));
  console.log("含妖祀条目:", es.filter(e=>/妖祀/.test(e.comment)).length, "(应为0)");
  console.log("含使用说明:", es.filter(e=>/使用说明/.test(e.comment)).length, "(应为0)");
  console.log("髭切.category:", (es.find(e=>e.comment==="髭切")||{}).category);
'
```
Expected: 妖祀=0、使用说明=0、髭切.category=刀男人设

- [ ] **Step 4: Commit(脚本改动;产物数据另算)**

```bash
cd /Users/iris/Documents/机器人/koishi-plugins-worktrees/feat-worldbook
git add packages/koishi-plugin-chatluna-worldbook/scripts/convert-st-worldbook.js
git commit -m "feat(worldbook): 转换脚本 --preset toudan(刀帐跳过/分类)"
```
> 注:`刀帐图鉴.koishi.json` 落在 `koishi-app/data/`(运行数据,不在本仓库),不进此 commit;部署时随数据走。

---

## Task 5: index.js — config `categoryLimits` 接入 + debug

**Files:**
- Modify: `<PKG>/index.js`

**Interfaces:**
- Consumes: `lib.selectEntries` 新返回的 `capDropped`(Task 2)

此 task 是 koishi 运行时 glue,无离线单测;用 `node --check` 保语法,运行时验证留 Task 6。

- [ ] **Step 1: Config 加 categoryLimits**

`index.js` 的 `exports.Config` 里,在 `budgetTokens` 那一项之后插入:

```js
  categoryLimits: Schema.dict(Schema.number()).default({ '刀男人设': 10 })
    .description('按 category 限制每轮最多注入条数(超额按出现新近度保留)。键=category,值=上限;未列的类不限'),
```

- [ ] **Step 2: 传参 + debug 显示 capDropped**

把函数提供器里的 `lib.selectEntries(...)` 调用与紧随的 `if (config.debug)` 块替换为:

```js
      const { selected, dropped, usedTokens, capDropped } = lib.selectEntries(allEntries, buffer, {
        budgetTokens: config.budgetTokens,
        caseSensitive: config.caseSensitive,
        wholeWord: config.wholeWord,
        categoryLimits: config.categoryLimits
      })
      if (config.debug) {
        const capInfo = (capDropped && capDropped.length)
          ? ` | 分类超额挤掉: ${capDropped.map((e) => e.comment).join(', ')}` : ''
        logger.info('[%s] 命中 %d 条(约%d tokens): %s%s%s',
          sessionKeyOf(session), selected.length, usedTokens,
          selected.map((e) => e.comment).join(', ') || '(无)',
          dropped.length ? ` | 预算丢弃: ${dropped.map((e) => e.comment).join(', ')}` : '',
          capInfo)
      }
```

- [ ] **Step 3: 语法检查**

Run: `cd <PKG> && node --check index.js`
Expected: 无输出(语法 OK)

- [ ] **Step 4: 全测试回归**

Run: `cd <PKG> && node --test`
Expected: 全部 PASS

- [ ] **Step 5: Commit**

```bash
cd /Users/iris/Documents/机器人/koishi-plugins-worktrees/feat-worldbook
git add packages/koishi-plugin-chatluna-worldbook/index.js
git commit -m "feat(worldbook): config categoryLimits 接入 + capDropped 调试"
```

---

## Task 6: bot1 实机验证

**Files:**
- 同步插件到 bot1:`koishi-app/external/koishi-plugin-chatluna-worldbook`(已是符号链接/已装)
- Modify: `/Users/iris/Documents/机器人/koishi-app/koishi.yml`(`chatluna-worldbook:wbk001` 块)

- [ ] **Step 1: 同步插件改动到 bot1 external**

bot1 的 external 是开发用副本。把 worktree 改动同步过去(lib.js/index.js/scripts):

```bash
cd /Users/iris/Documents/机器人
SRC=koishi-plugins-worktrees/feat-worldbook/packages/koishi-plugin-chatluna-worldbook
DST=koishi-app/external/koishi-plugin-chatluna-worldbook
cp "$SRC/lib.js" "$SRC/index.js" "$DST/"
cp "$SRC/scripts/convert-st-worldbook.js" "$DST/scripts/"
diff -q "$SRC/lib.js" "$DST/lib.js" && echo "lib 同步OK"
```

- [ ] **Step 2: koishi.yml 加刀帐图鉴 + categoryLimits**

把 bot1 `koishi.yml` 的 `chatluna-worldbook:wbk001` 块改为(在 `bookPaths` 追加刀帐图鉴、加 `categoryLimits`):

```yaml
  chatluna-worldbook:wbk001:
    bookPaths:
      - data/chathub/character/worldbooks/审神者职业手册.koishi.json
      - data/chathub/character/worldbooks/刀帐图鉴.koishi.json
    scanDepth: 3
    budgetTokens: 4000
    categoryLimits:
      刀男人设: 10
    debug: true
```

- [ ] **Step 3: 重启 bot1 并触发**

重启 bot1(koishi 进程),用髭切私聊发一句点到 >10 振刀名的话(例:列举十几把刀)。

- [ ] **Step 4: 看 debug 日志验证**

预期日志形如:
`[private:...] 命中 N 条(约X tokens): ... | 分类超额挤掉: <最早提到的几振>`
确认:注入的「刀男人设」条目 ≤10,且留下的是最新近提到的;审神者类提名才进。

- [ ] **Step 5: 记录验证结果**(无代码改动则不 commit;若 koishi.yml 由 koishi 自管则它自行持久化)

---

## Task 7: 部署到 bot2/3/4(bot1 跑通后)

照 relay 的本地装法,对 koishi-app2 / koishi-app3 / koishi-app4 各做:

- [ ] **Step 1: 装插件(external + symlink + package.json)**

```bash
cd /Users/iris/Documents/机器人
SRC=koishi-app/external/koishi-plugin-chatluna-worldbook
for d in koishi-app2 koishi-app3 koishi-app4; do
  cp -R "$SRC" "$d/external/koishi-plugin-chatluna-worldbook"
  ln -sfn ../external/koishi-plugin-chatluna-worldbook "$d/node_modules/koishi-plugin-chatluna-worldbook"
done
```
再在各 `package.json` 的 dependencies 加 `"koishi-plugin-chatluna-worldbook": "file:./external/koishi-plugin-chatluna-worldbook"`。

- [ ] **Step 2: 拷数据**

```bash
for d in koishi-app2 koishi-app3 koishi-app4; do
  mkdir -p "$d/data/chathub/character/worldbooks"
  cp koishi-app/data/chathub/character/worldbooks/刀帐图鉴.koishi.json "$d/data/chathub/character/worldbooks/"
done
```

- [ ] **Step 3: 各 koishi.yml 加 chatluna-worldbook 块**(bookPaths=刀帐图鉴、categoryLimits、接预设 `{world_book}` 占位)。

- [ ] **Step 4: 重启验证**:各 bot 启动日志见「世界书已加载」+ 角色聊到刀名时注入 ≤10。

> 注:bot2/3/4 角色(膝丸/江雪/鹤丸)预设里需要有 `{world_book}` 占位符才生效;刀帐图鉴是通用人设库,四 bot 共用。

---

## Self-Review

**Spec coverage:**
- §3 数据导入(简版刀帐、删妖祀、category、使用说明丢弃)→ Task 3(规则)+ Task 4(产出)✓
- §4.1(a) convertStEntry category → Task 3 ✓
- §4.1(b) selectEntries 分类裁剪 + 新近度 → Task 1(recencyScore)+ Task 2 ✓
- §4.2 index config categoryLimits + debug → Task 5 ✓
- §5 测试(category 推断/新近度/裁剪/预算叠加/不受限类/回归)→ Task 1/2/3 用例齐 ✓
- §6 bot1 验证 → Task 6 ✓
- §7 部署 bot2/3/4 → Task 7 ✓
- 「渲染顺序 vs 取舍顺序分离」→ Task 2 实现保留原渲染排序、新近度仅用于裁剪 ✓

**Placeholder scan:** 无 TBD/TODO;每个代码步骤含完整代码;命令含预期输出。审神者条目数实跑确认为 8(9 个「老师的审」启用后删妖祀)。

**Type consistency:** `recencyScore`/`lastMatchIndex`/`selectEntries(…categoryLimits)`/`capDropped`/`isToudanSkip`/`toudanCategory`/`convertStEntry(st,ctx,opts)`/`convertStWorldbook(stJson,ctx,opts)` 在定义(Task 1/2/3)与消费(Task 4/5)处签名一致 ✓
