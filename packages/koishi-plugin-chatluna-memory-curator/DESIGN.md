# koishi-plugin-chatluna-memory-curator 设计稿

2026-06-26 · 作者:妖祀 / Claude · 状态:设计待评审(未实现)

> 暂名 `chatluna-memory-curator`(以下简称「本插件」)。给 chatluna-character 的角色一套**可调可修的、按人组织的、人格驱动的**记忆能力,作为 `chatluna-livingmemory` 的**伴生层**,不改其源码、停用即还原。

---

## 0. 第一原则

**这套记忆是角色人格的延伸,不是外挂数据库。** 记什么、怎么记、注意谁、信不信——全部随预设与角色性格走,且对运营**全程可见、可视化可改**。本插件本体**通用**(对任何 chatluna-character 角色生效),角色味只活在配置与预设里(沿用 relay / scene-rules 的范式)。

---

## 1. 问题

现状(均已读 livingmemory 源码确证):

1. **模型对记忆纯被动、不可调可修**:livingmemory 全程 `registerTool` 出现 0 次。它的 `createMemory/updateMemory/deleteMemory` 只开给 WebUI 面板和后台自动 extract,模型够不到,不能自己「记一条 / 改一条 / 忘一条」。
2. **无「人」维度**:召回 `retrieve(presetId, input, limit)` 按 presetId 全局,无 userId 过滤,回答不了「某群友是谁」。
3. **importance / timestamp 存了几乎不参与排序**:最终排序里 timestamp 量级 `/1e15` ≈ 0。
4. 群友画像若用 group-analysis 补,则是**只读 + 后台批量生成**,且与 livingmemory「都记关于人的事」存在双认知打架。

## 2. 目标

- 群友信息 **bot 可调可修**(模型用工具读/写/改某人信息)。
- **常态不占太多上下文**(按需拉取 + 极小档案)。
- 记什么/怎么记/注意谁 **全预设驱动、全配置可见**(通用插件)。
- 两套联合更高效:livingmemory 当强召回底座,本插件加薄层,group-analysis 降级保留逐字检索。
- **停用零影响**:伴生形态,不 fork livingmemory,停用即还原。

## 3. 实现形态

scene-rules 同款伴生件,但**经源码核查(2026-06-26),首版零运行时接管**,只靠三种更稳的手段,均不编辑 livingmemory 文件:

- **叠加加列**:`ctx.model.extend('living_memory_entry', {...})` 对同表追加可空列(Koishi 叠加式扩展,vanilla livingmemory 无视新列、无害)。
- **直接读写表**:`entity` 是我们自加的真列,按人查直接 `ctx.database.get('living_memory_entry', {presetId, entity, memKind})`,不依赖 livingmemory 召回路径。每条记忆**自带 `embedding` 与 `sourceMessages` json 列**,三因子相关度直接读 `embedding` 算(emoji-recall 同款),给自动事实标 entity 靠回填 sweep 读 `sourceMessages`——都无需包裹内部方法。
- **工具注册**:`new ChatLunaPlugin(...).registerTool(...)`(relay 同范式)。
- **改配置**:关 livingmemory 的 `enableSnapshotInjection`(它本就是配置开关),自动注入即停,召回改走本插件工具。

> 设计演进:初版设想接管 `retrieve` 与 `repository.createMemory`,核查后发现都可被「自有工具内排序 + 回填 sweep」替代(见 §6、§7、§14),故首版不接管 livingmemory 任何方法,风险更低。若 scene-rules 已在改 `createScope` 别名,本插件与之正交共存。

## 4. 数据模型

### 4.1 叠加到 `living_memory_entry` 的 3 个可空列

| 列 | 类型 | 用途 |
|---|---|---|
| `entity` | `string(64)` nullable | 人标识 = `平台:号`(如 `onebot:123456`)。**跨频道一致**——群/私聊/语音都是同一份。 |
| `memKind` | `string(16)` nullable | `profile`(档案)/ `fact`(事实)。区分两层,不与 livingmemory 自带 `type` 抢语义。 |
| `lastAccessedAt` | `timestamp` nullable | 被召回即刷新 → 三因子里「被用到的记忆自动续命」。 |

### 4.2 两层记忆

- **档案 `memKind=profile`**:每个 `entity` **恰好一条**、有长度上限的结构化记录。字段由配置模板定义(默认 `称呼 / 好感度 / 关键印象 / 在意的事`)。封顶 → **O(1)、永不膨胀**,是「可调可修」主战场。
- **事实 `memKind=fact`**:关于某人的零散事件/发言,数量会涨,但**只通过有界 top-K 三因子搜索**取。

> 分工口诀:**档案答「他是谁、我对他怎样」(便宜、稳定、常浮);事实答「他具体做过/说过什么」(按需、有界搜)。**

## 5. 给模型的工具面(5 个,relay 范式)

工具描述与参数说明**全部 Schema 可编辑**(像 relay 的 `messageDesc`),决定模型何时/怎么用。

**档案(按 entity 直接读改,模型不必找 id):**
- `get_profile(entity)` → 读某人档案(一条)。
- `set_profile(entity, patch)` → **读-改-写**那一条:先取现状 → 按 patch 合并 → 封顶截断写回。**绝不盲覆盖**。

**事实:**
- `recall(entity?, query?, topK=6)` → 给 `entity` 精确召回此人;给 `query` 语义召回。**返回带 memory id**(模型才能改/忘某条)。
- `remember(entity, content, importance?)` → 写一条事实。
- `forget(id)` → **软删**(置 `status=superseded`,不物删,可恢复)。

工具数量「5」为当前设计,非铁律。

## 6. 三因子召回重排(在本插件 `recall` 工具内,不接管 livingmemory)

`enableSnapshotInjection=false` 关掉自动注入后,召回全走本插件 `recall` 工具。工具内取候选(entity 过滤直接查表,语义候选读各条已存的 `embedding` 列算余弦相似)→ 重排 → 截 top-K:

```
score = w_rel·relevance + w_imp·importance + w_rec·recency
recency = exp(-Δhours / τ)        // τ 默认 72h,可配
```

- 三项各自 min-max 归一到 [0,1] 后加权,**权重默认全 1、可配**。
- 命中即刷新该条 `lastAccessedAt`(被用到的记忆续命)。
- 修掉「importance/timestamp 几乎不参与」的现状,且不动 livingmemory 召回引擎本身。

## 7. 分工与数据流

- **档案** = 模型主动维护(`get/set_profile`)。这是「可调可修」的对象。
- **事实** = livingmemory 后台自动提取**继续开**(不漏记)。它写入的 fact 行 `entity` 初始为空,本插件用**周期性回填 sweep**:扫 `memKind=fact AND entity IS NULL` 的行,从 `sourceConversationId` 推断:**私聊 fact**(`private:号`)可还原对象 entity;**群聊自动 fact** 因 livingmemory 持久化结构无发言者号、无法回填,留空,按人召回靠模型 `remember(entity)` 显式标。模型也能用 `remember` 直接带 entity 补写。
- **livingmemory** = 保留 embedding-rerank 召回 + dream 整合当强底座(全生态最强,不动)。
- **group-analysis** = 降级:只开 `group_message_fetch`、persona 关(`personaAnalysisMessageInterval=0`)、不用报告命令。画像交给档案。

```
群消息流
 ├─(后台·零模型介入) livingmemory extract 写事实  ──接管──▶ 标 entity
 └─(后台) group-analysis 仅留消息库供 group_message_fetch 逐字检索

髭切想起某人 X(按需,不常驻):
 1. get_profile(X)            → 档案底(便宜、稳定)
 2. recall(entity=X, query)   → X 相关事实,三因子有界 top-K
髭切要记/更正关于 X 的事:
 3. set_profile(X, patch)     → 改档案(读改写)
 4. remember(X, content)/forget(id) → 增/软删事实
```

## 8. 在场者注入 + 群规模头

关掉 livingmemory `enableSnapshotInjection`(不再每轮常驻倒记忆)。改为**轻量在场者块**自动浮出 + **全部事实按需 `recall`**。

**在场者定义(非花名册):** 最近消息窗口里**真正发过言的人**(取 chatluna-character 近 N 条 buffer 的 distinct 发言者)∩「有档案的人」,按「最近发言 / 好感度」排序,**硬封顶 M 条**(默认 5–8),每条档案本就封顶。

- 百人群、某天出现 20 人:任一时刻近窗口通常 3–8 人在说话 → 只浮这几个;20 人不同时浮。
- 没档案的新面孔不浮(模型想记再 `set_profile`)。

**群规模头(让 bot 知道规模):** 在场者块顶加一行,例:
`群:本丸 · 约 120 人 · 近期活跃 6 人 · 你认识其中 4 人`
数据取 NapCat `get_group_info`(member_count)/成员列表,**缓存定时刷**(人数不常变)。让角色**按规模校准**:百人群不试图记全、小群更亲密。

> 可选开关:在场者改为 `who_is_here()` 工具纯按需,而非自动浮。

## 9. 人设驱动 / 通用可配置

通用插件,**零角色硬编码**。所有行为旋钮为 Koishi Schema 配置(控制台自动渲染表单,可见可改);附一份**髭切示例配置**。三个控制面:

1. **档案字段模板**(`Schema.dict`):定义档案有哪些维度,默认 `称呼/好感度/关键印象/在意的事`,按角色改。
2. **记忆准则提示**(persona 片段):「这个角色会记住什么样的事、用什么口吻记」,同时喂给 ①模型(何时调写工具)与 ②后台 extractor(让自动抽取也站在角色视角)。
3. **工具描述**:何时/怎么用,可编辑。

模型主动写的记忆天生在角色口吻里;后台 extractor 改为 persona-aware,两条写入口径统一。

## 10. 安全护栏

- `forget` = 软删(`status=superseded`),可恢复;`set_profile` = 读-改-写防盲覆盖;`update` 原子写。
- **防记忆投毒**:写成角色性格判断而非机械过滤——角色不会轻信别人单方面的话就当事实记档案(标注「谁说的 / 存疑」)。顺势人设对齐。
- **升级口**:写工具内置 `canWrite(session)` 判定缝,现在恒放行(或仅记日志);将来加「只有特定会话/人能触发写记忆」的硬白名单**只改配置、不动架构**。

## 11. 可视化管理

- **复用 livingmemory 已有 WebUI 面板**:叠加的 `entity/memKind/lastAccessedAt` 列在其记忆管理里直接现身,可看/改/删。
- **轻量档案视图**(本插件加一薄页):按 entity 列出每人档案、可点改。不自造重面板。

## 12. 停用零影响

- 叠加列:停用后列仍在,但 vanilla livingmemory 不读,无害。
- provider/缓存:在场者 provider 用 `ctx.effect(() => registerFunctionProvider(...))` 注册,koishi 自动析构(emoji-recall 同款);`groupInfoCache` dispose 时清。
- 工具:随 `ChatLunaPlugin` 生命周期注销。
- **首版不接管 livingmemory 任何方法**,故无需还原任何包裹。
- 结果:停用 → livingmemory 回到原样。

## 13. 配置项清单(Schema 草案)

| 配置 | 默认 | 说明 |
|---|---|---|
| `profileTemplate` | `{称呼,好感度,关键印象,在意的事}` | 档案字段模板(dict) |
| `profileMaxChars` | 600 | 单份档案封顶 |
| `memoryCriteriaPrompt` | (通用默认串) | 记忆准则 / 口吻 persona 片段 |
| `toolDescriptions` | (通用默认串) | 5 个工具的描述,可改 |
| `recallTopK` | 6 | 事实召回条数 |
| `presentCap M` | 6 | 在场者档案上限 |
| `presentWindowN` | 30 | 判「在场」的近消息窗口 |
| `weights {rel,imp,rec}` | `{1,1,1}` | 三因子权重 |
| `recencyTau` | 72(h) | recency 半衰 |
| `autoSurfacePresent` | true | 在场者自动浮 / 改纯按需 |
| `triggerWhitelist` | `[]`(空=不限) | 写记忆触发白名单(升级口,默认放行) |
| `entityFromExtract` | true | 接管后台 extract 标 entity |
| `debug` | false | 打印接管/标注/重排 |

## 14. 待验证 / 风险(2026-06-26 已核查更新)

源码核查后,多数已落定,剩余少量待坐实:

1. ~~`retrieve` 接管粒度~~ → **已解决**:`enableSnapshotInjection` 是配置开关,关掉即停自动注入;三因子改在本插件 `recall` 工具内做,读各条已存 `embedding` 列算相关度,**不接管 livingmemory 任何方法**。**高信心。**
2. **`model.extend` 叠加同表**:Koishi 支持多插件扩展同表;确认 vanilla `createMemory` 的 `database.create` 不因新可空列报错。**高信心,需跑一次冒烟。**
3. ~~接管 `repository.createMemory`~~ → **已解决**:改用周期性回填 sweep 读已存的 `sourceMessages` 列标 entity,**不碰内部方法**。**高信心。**
4. **persona-aware 抽取**:extraction 已吃 `presetTemplate` + `presetPromptOverride`(源码 3650/3751),入口存在;具体设哪个预设/配置字段待定。**中高信心。**
5. **entity 推断准确度**:回填从 `sourceConversationId` 判事实「关于谁」——**私聊**(`private:号`)可还原对象 entity;**群聊自动 fact** 因 livingmemory 持久化结构无发言者号、无法回填,留空,按人召回靠模型 `remember(entity)` 显式标。档案侧由模型显式给 entity,不受影响。**逻辑可控,质量待真机观察。**
6. **群规模头取数**:NapCat `get_group_info` 的 member_count 字段(标准 OneBot 扩展)在当前适配器的可得性。**高信心,需跑一次确认字段名。**

## 15. 升级口(留给将来,不在首版)

- 安全:`canWrite` 升级为硬白名单(配置即可)。
- 甩 puppeteer:group-analysis 整个不用,自写薄工具调 NapCat `get_group_msg_history` + 自然语言时间解析,替代 `group_message_fetch`。
- entity 精确度:若「语义近似按人」不够,把 entity 升为真索引/旁路 `userId→memoryId` 表(本设计已用真列,基本到位)。
- 在场者:`who_is_here()` 工具化。

## 16. 落地标签

- **现成复用(零改)**:livingmemory 召回/dream/extract 引擎、WebUI 面板;group-analysis `group_message_fetch`。
- **自写薄胶水(核心工作量,~1 插件)**:叠加 3 列 + 5 工具 + 工具内三因子排序 + entity 回填 sweep + 在场者块(含群规模头)+ 配置 Schema + 档案薄页。**首版零接管 livingmemory 方法。**
- **改配置(零代码)**:livingmemory `enableSnapshotInjection=false`;group-analysis persona 关、只留检索;预设加记忆准则与防投毒规范。
- **不 fork、停用零影响。**
