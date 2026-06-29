# chatluna-worldbook:分类触发上限 + 刀帐图鉴导入 设计

> 状态:已与用户确认,待写实现计划
> 日期:2026-06-29
> 关联:`世界书插件设计.md`(插件总设计)、`koishi-plugin-chatluna-worldbook`(feat/worldbook 分支)

## 1. 目标

1. 把社区刀帐世界书「⚔️时政专供-简版刀帐 v1.1 BY芙蕾」(146 条,几乎全员刀剑男士图鉴)导入 chatluna-worldbook。
2. 给世界书插件新增**「按分类限制每轮注入条数」**能力,首个用途:**「刀男人设」类每轮最多注入 10 条**,超额时**按出现新近度**取舍。
3. 其它类别(设定、审神者画像、审神者职业手册的世界观条目等)**不受**该条数上限,仍只受全局 `budgetTokens`。
4. bot1(髭切)跑通验证后,把插件改动 + 刀帐图鉴数据一并部署到 bot2/3/4。

## 2. 背景:为什么需要

- chatluna-worldbook 现状:关键词命中 → 选条 → **只有 `budgetTokens` 一个裁剪维度**(`lib.selectEntries`)。
- 刀剑乱舞对话里,一段话可能提到一长串刀名(尤其群聊点名、或一个话题牵出一票刀),命中几十条人设档案 → token 暴涨,且稀释当前真正在聊的那几振。
- 需求是「**人设类**条目每轮封顶 10 条」,且保留的应是**当前对话里最新近被提到**的那 10 振(「在聊谁就带谁」),而不是按固定权重。

## 3. 数据来源与导入

### 3.1 源文件

- `~/tavern/SillyTavern/data/default-user/worlds/⚔️时政专供-简版刀帐 v1.1⚔️ BY芙蕾.json`(酒馆 lorebook,146 条)。
- 实测结构(无 `🛂` 前缀,靠分隔条与刀名 comment):
  - **刀男人设 125 条**:`comment` = 刀名(髭切/膝丸/鹤丸国永…),`constant=false`,有刀名/别名 `key`,`content` ~400–650 字。
  - **分隔条 10 条**(`===短刀===`/`==枪==`…)+ **预留 2 条**:`content` 为空。
  - **使用说明 1 条**:纯说明文。
  - **「XX老师的审」9 条**(松鼠/饺子/小江/花野/曲水/相川/匪挚/曲水(光源氏)/**妖祀**)—— 审神者真人自设画像(1000+ 字),非刀男。**源文件里全部 `disable=true`(禁用)** —— 见 §3.2 启用规则。

### 3.2 导入规则(转换时落 `category`,并做删除)

转换脚本 `scripts/convert-st-worldbook.js` 用以下规则产出 `data/chathub/character/worldbooks/刀帐图鉴.koishi.json`:

1. **丢弃**(不导入):
   - 空 `content`(分隔条/预留)—— 现有 `isJunkStEntry` 已覆盖。
   - `comment` 含「使用说明」(纯说明,不进 prompt)。
   - `comment` 含「妖祀」(用户本人,主人不作为档案注入)。← 本次明确要求删除。
2. **`category` 推断**(`deriveCategory(comment, content)`):
   - `comment` 含「老师的审」→ `category = "审神者"`。
   - 其余(刀名条目)→ `category = "刀男人设"`。
3. 其它字段沿用现有 `convertStEntry`(comment/keys/secondaryKeys/logic/constant/content/order/enabled)。
4. **审神者画像启用**:9 个「老师的审」在源刀帐里是 `disable=true`,`--preset toudan` 在转换前对 `/老师的审/` 条目直接 `disable=false`(= enabled),使其导入并生效;妖祀仍由上面「丢弃」规则(`isToudanSkip`)排除。

预期产物(实跑确认):**刀男人设 125 条 + 审神者 8 条**(9 个老师的审删妖祀后 8),与 `审神者职业手册.koishi.json` **并存**(都列进 `bookPaths`,条目合并)。

> 审神者画像保持**绿灯**(`constant=false`,关键词触发)、`category="审神者"`、**不设上限**:群聊提到某审神者(如「花野」)才注入其画像,私聊不无故注入;人少不会爆。

## 4. 插件改造

### 4.1 `lib.js`

**(a) `convertStEntry` 增加 category 支持**

- 签名扩展:`convertStEntry(st, ctx, opts)`,`opts.categorize?(st) => string | undefined`。
- 产出对象增加 `category`(无规则时为 `undefined`,保持向后兼容)。
- `convertStWorldbook(stJson, ctx, opts)`:`opts.skip?(st) => boolean` 谓词(刀帐用它删「使用说明」「妖祀」),`opts.categorize` 透传。
- 刀帐专用的 `skip` / `categorize` 规则**放在转换脚本里**,lib 只提供通用机制(保持 lib 对其它世界书中立)。

**(b) `selectEntries` 增加「分类条数上限 + 新近度取舍」**

新签名:`selectEntries(entries, buffer, opts)`,`opts.categoryLimits?: Record<string, number>`。

算法(在现有「激活 → budget 裁剪」之间插入一层):

1. 激活集 `activated`(同现状)。
2. **分类裁剪**:对每个在 `categoryLimits` 里有上限 `N` 的 `category`:
   - 取该类激活条目;若条数 ≤ N,不动。
   - 若 > N:按**新近度分数降序**排序,保留前 N,其余进 `dropped`(记原因 `category_cap`)。
   - 平局(同条消息提到多振,新近度相同)→ 次级按 `order` 降序、再按命中关键词数降序,保证确定性。
3. 裁剪后的集合走**现有 `budgetTokens` 逻辑**(constant 优先 + order),token 超额再丢(原因 `budget`)。
4. 返回 `{ selected, dropped, usedTokens }`,`dropped` 带 `reason` 便于 debug。

**新近度分数 `recencyScore(entry, buffer)`**:

- `buffer` = `buildScanBuffer(messages, scanDepth)`,最近 N 条消息 `\n` 拼接,**越靠后(字符串末尾)= 越新**。
- `constant` 条目:`Infinity`(总在,最高;刀男人设均为绿灯,通常不涉及)。
- 绿灯条目:取其所有 `keys` 在 `buffer` 中**最后一次出现的字符下标**,取最大值。下标越大 = 越靠近当前发言 = 越新。
  - 文本 key:`buffer.lastIndexOf(key)`(大小写/整词规则复用现有 `matchKey` 的归一)。
  - 正则 key:全局匹配取最后一个 match 的 `index`。
  - 一条都不命中(理论上不会,因为它在 activated 集里)→ `-1`。
- 仅用于「超额取舍」的排序,**不改变最终渲染顺序**(渲染仍按 constant + order 升序)。

### 4.2 `index.js`

- `Config` 增加:
  ```js
  categoryLimits: Schema.dict(Schema.number()).default({ '刀男人设': 10 })
    .description('按 category 限制每轮最多注入条数(超额按出现新近度保留)。键=category,值=上限;未列的类不限')
  ```
- `bookPaths`:**不改插件默认值**(避免影响其它使用者),改为在各 bot 的 `koishi.yml` 里把刀帐图鉴路径加进 `bookPaths`(与审神者手册并存)。
- 调 `selectEntries` 时传入 `config.categoryLimits`。
- `debug` 日志增加:`[类] 刀男人设 命中13 → 保留10(按新近度),挤掉: 同田贯正国, 南泉一文字, 鸣狐`。

## 5. 测试(lib.js 离线单测,`node --test`)

1. `deriveCategory`:刀名 → 「刀男人设」;「花野老师的审」→「审神者」。
2. `skip`:「妖祀老师的审」跳过;「使用说明」跳过;空 content 跳过。
3. `recencyScore`:buffer 中越靠后的 key 命中分越高;多 key 取最后出现的最大下标;正则 key 生效。
4. `selectEntries` 分类裁剪:13 条「刀男人设」命中、上限 10 → 保留 buffer 中最新近的 10,3 条进 dropped(reason=category_cap);buffer 顺序变 → 保留集合随之变。
5. 裁剪 + 预算叠加:先 category 砍到 10,再 budget 砍;dropped 的 reason 正确。
6. 不受限类:「审神者」无上限 → 命中几条进几条;无 categoryLimits 时行为同现状(回归)。
7. 平局确定性:同新近度按 order/命中数稳定排序。

## 6. 验证(bot1 实机)

1. 跑增强后的转换脚本 → 生成 `刀帐图鉴.koishi.json`;`node` 统计 category 分布(刀男人设 ~125 / 审神者 7 / 无妖祀)。
2. 放入 `koishi-app/data/chathub/character/worldbooks/`;bot1 `koishi.yml` 的 `chatluna-worldbook:wbk001` 的 `bookPaths` 追加该文件,`categoryLimits: { 刀男人设: 10 }`。
3. 重启 bot1;髭切私聊里抛一串刀名(>10),看 debug 日志:注入的刀男人设 ≤10 且为最新近的几振;审神者类提名才进。

## 7. 部署到 bot2/3/4(跑通后)

照 relay 的本地装法:
- 插件:`koishi-plugin-chatluna-worldbook` 同步到各 bot `external/` + node_modules 符号链接 + `package.json` 加 `file:` 依赖(bot2/3/4 当前未装世界书插件)。
- 数据:`刀帐图鉴.koishi.json`(+ 如未有则审神者职业手册)拷到各 bot 的 `data/chathub/character/worldbooks/`。
- 配置:各 `koishi.yml` 加 `chatluna-worldbook` 块(bookPaths + categoryLimits + 接入各自角色预设的 `{world_book}` 占位)。
- 注意:bot2/3/4 角色不同(膝丸/江雪/鹤丸),刀帐图鉴是通用人设库,可共用;预设里要有 `{world_book}` 占位符才生效。

## 8. 风险 / 开放问题

- **新近度对正则 key 的成本**:buffer 仅最近 N 条,条目数百级,逐 key lastIndexOf/正则可接受;必要时缓存编译正则。
- **重复刀名**:简版刀帐有「山姥切长义」普通版 + 极版等同名多条 → 新近度可能并列,靠次级排序定序,可接受(必要时后续合并)。
- **category 对其它世界书无影响**:审神者职业手册条目无 `category` → 不进任何 `categoryLimits` 桶 → 行为不变(回归测试保障)。
- **上限值**:默认 10,纯 config,随时可调;后续若要给「设定」类也封顶,加一个键即可。
- **渲染顺序 vs 取舍顺序**:刻意分离——取舍用新近度(选谁),渲染用 order(怎么排)。两者不要混。
