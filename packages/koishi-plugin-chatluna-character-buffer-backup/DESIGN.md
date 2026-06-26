# koishi-plugin-chatluna-character-buffer-backup 设计

2026-06-24 · 作者:妖祀 / Claude

## 问题
chatluna-character 的近期对话上下文(`MessageCollector._messages[key]`)**只存内存**(schema 字段 `maxMessages` 描述="存储在内存里的最大消息数量")。koishi 重启、或控制台保存配置(=插件热重载)都会新建 `MessageCollector` → 缓冲清空 → bot 当场忘记刚刚聊的。自带补救 `historyPull`(默认 true)从 NapCat 拉历史,但**一次性、失败/拉空也焊死 `historyPulled=true`**(源码 `pullHistory` line 6576-6621),且私聊 `get_friend_msg_history` 不可靠 → 救不住。

## 方案
独立本地插件,**不改 chatluna-character 源码**(survives `npm i`)。在它内存缓冲之外,旁路把 `_messages` 持久化到 SQLite,启动时灌回。

### 数据
表 `chatluna_character_buffer`(照 `VariableStore` 范式):
- `sessionKey` string(255) PK —— `group:<guildId>` / `private:<userId>`
- `messages` text —— `JSON.stringify(Message[])`(Message 是纯 JSON:content/name/id/messageId?/timestamp?/quote?/images?)
- `updatedAt` timestamp

### 抓取(双保险)
1. `ctx.on('chatluna_character/message_collect', session)` → 防抖 `debounceMs`(默认 3000)→ 快照 `ctx.chatluna_character.getMessages(key)` upsert 入表。覆盖 kill -9 / 崩溃。
2. `ctx.on('dispose')` → 尽力遍历 `Object.keys(_messages)` 各 key 同步发起 upsert(fire-and-forget)。覆盖正常重启 + 控制台 save,抓最新态(含 bot 最后回复)。

### 恢复
`ctx.inject(['database','chatluna_character'])` 回调里,跑一次:
- `database.get(表, {})` 读全部行
- 过期过滤:`maxAgeHours>0` 且 `now-updatedAt > maxAge` → 跳过(可选删行)
- `_messages[key] = mergeById(现有, JSON.parse(row.messages), cap=100)`
- **写内部私有字段有 guard**:`ctx.chatluna_character._messages` 不是对象就 logger.warn + no-op,绝不崩。

### 保持诚实
`ctx.on('chatluna_character/clear-chat-history', {sessionKey})` → `database.remove(表, {sessionKey})`。`/清除记忆` 后无残留。

### 与 historyPull 共存
**保留** chatluna 自带 historyPull。我们存档覆盖私聊弱点+永不焊死失败;NapCat 补"末次快照→重启"那几秒缝;`mergeById` 按 messageId 去重让重叠安全。取并集不打架。

## 纯逻辑(可离线测)抽到 `lib.js`
- `deriveKey(session)` → `${isDirect?'private':'group'}:${isDirect?userId:guildId}`
- `mergeById(existing, incoming, cap)` → 按 messageId(缺则 `id|timestamp`)去重、timestamp 升序、尾部截断到 cap
- `isFresh(updatedAt, maxAgeHours, now)` → bool

`index.js` 只是 koishi 事件 ↔ DB ↔ lib 的薄胶水。

## 配置默认
| knob | 默认 | |
|---|---|---|
| debounceMs | 3000 | 快照频率 |
| maxAgeHours | 24 | 长停机后不灌过期(0=不限) |
| restore cap | 100 | 对齐 maxMessages 上限 |
| debug | false | 打快照/恢复条数 |

## 风险
1. 耦合内部字段 `_messages` —— guard 兜底,大版本改字段则失效(记日志不崩)。
2. bot 末条回复可能漏存 —— 下次快照/dispose flush/NapCat 补缝覆盖。
3. 安装面:每个 app(app1-4 现有)装一份 external/ + file: 依赖 + koishi.yml + 重启。

## 测试
`node test.js`:`mergeById` 去重/排序/截断/JSON 往返 + `deriveKey` + `isFresh` 断言。koishi 胶水靠读代码 + app1 真重启验证(发几条 → 重启 → 看是否记得)。
