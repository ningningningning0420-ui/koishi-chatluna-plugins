# koishi-plugin-chatluna-relay

> **让 ChatLuna 角色 bot 主动私信好友。** bot 在自己的输出里写一个
> `[[relay:别名|要说的话]]` 标记，本插件把它从可见回复里剥掉、**带外执行**——以 bot 自己的口吻
> 私信一位白名单好友（可选附带一张相册照片）。发的是 bot **自己组织的话**，不是原样转发别人的话
> （除非你让它原样转达）。之后的一来一往就是 chatluna 私聊的默认行为。

**为什么是标记而不是工具：** 早期版本把它做成一个原生 `find_friend_chat` 工具，结果在「回复走 XML 文本」
的角色管线里，模型常常只输出思考、不产出正文，导致 chatluna-character 解析失败、整条回复发不出去。
改成纯文本 `[[relay:...]]` 标记后，模型始终待在它熟悉的输出范式里，且执行完全脱离回复主流程——
relay 出任何错都不会拖垮 bot 的回复。

## 五道护栏

| # | 护栏 | 作用 |
|---|---|---|
| ① | **触发白名单** `triggerWhitelist`（+ `triggerGroups`） | 只有名单里的会话能触发 relay。群里默认完全不触发，除非把群号显式加进 `triggerGroups`。 |
| ② | **收件人白名单** `recipients` | bot 只能联系名单内的人（别名 → QQ 映射）。标记里的别名不在名单 → 拒发。 |
| ③ | **仅好友** | 目标必须是 bot 的实际好友（运行时拉好友列表核对；拉不到则跳过此项，best-effort）。 |
| ④ | **限流** `minIntervalSec` / `dailyLimit` | 最小发送间隔 + 每日上限。`rateLimitEnabled: false` 可整体关掉（⚠️ 风控风险高）。 |
| ⑤ | **防回环** `myBots`（可选） | 把自己其它 bot 的 QQ 填进来，来自这些号的私聊不触发本 bot 自动回复，避免两个 bot 互刷。默认空 = 不启用。 |

外加：同一收件人**一轮只发一次**（模型常会斟酌出多个候选标记，只采用最后一个）；标记按 60 秒窗口去重，
避免流式 chunk 重复触发。

## 标记格式

模型在它的输出里（建议写在 `<think>` 里，对用户不可见）写：

- 纯文字：`[[relay:芙蕾|你要对她说的完整一句话]]`
- 带图：`[[relay:芙蕾|看这张|图=对那张照片的描述]]`（`图=`/`photo=` 都认）
- 仅图：`[[relay:芙蕾|图=午后那张]]`
- 露骨图：`[[relay:芙蕾|图=床上那张|nsfw]]`（见下方 NSFW 说明）

解析规则：第一段 = 收件人别名；之后的段里 `图=描述` 是配图指令、`nsfw` 是分级标志、其余拼回 = 要发的文字
（所以文字里带 `|` 不会丢）。**怎么用、什么时候用、用什么口吻，写在你的角色预设里**（本插件不规定话术，
适配任意人设）。

## 依赖

- `koishi` ^4.17
- **`chatluna`**（`koishi-plugin-chatluna`）—— 硬依赖。
- **`chatluna-character`**（可选但实际必需）—— 标记是从它发出的 `chatluna_character/raw-response`
  事件里读的，同时用它把这次主动联系登记进对话缓冲（双向：收件人会话标成 bot 自己发的、发起会话记一条
  「我给谁发了什么」），让 bot 跨会话仍自知。
  ⚠️ **`chatluna_character/raw-response` 事件需要 chatluna-character 实际发出**——若你的构建没有这个事件，
  需打上对应补丁（暴露每轮原始模型输出的那个事件）。没有它，relay 收不到标记。
- **`photo`（可选）** —— 配图转发用。需存在一个提供 `recallEntry(desc, { nsfw, originKey, scope })` 的
  `photo` 服务（如 koishi-plugin-photo）。没有就自动降级：只发文字、不发图。
- 收发依赖适配器支持 `sendPrivateMessage` 与 `getFriendList`（OneBot 满足）。

## 启用

1. 安装：Koishi 控制台**插件市场**搜 `chatluna-relay`；或 `npm i koishi-plugin-chatluna-relay`。
2. `koishi.yml` 启用并填白名单：
   ```yaml
     chatluna-relay:main:
       triggerWhitelist:
         - '你自己的QQ号'        # 护栏①：至少填你自己
       recipients:               # 护栏②：能被联系的人（别名→QQ）
         - alias: 小明
           qq: '10001'
         - alias: 阿花
           qq: '10002'
       minIntervalSec: 60        # 护栏④
       dailyLimit: 20            # 护栏④
       rateLimitEnabled: true
       triggerGroups: []         # 留空 = 只私聊触发（默认，最安全）
       myBots: []                # 护栏⑤（可选）
       dryRun: true              # 灰度：只 log 不真发，验证无误后改 false
   ```
3. 在角色预设里加上标记说明（见「标记格式」），让模型知道怎么写。
4. 跟 bot 私聊触发一次，看日志：`dryRun=true` 时是 `[DRYRUN] relay → …`，真发后是 `relayed → 别名 (text=… img=…)`。

## 配置

| 配置 | 说明 |
|---|---|
| `dryRun`（默认 `true`） | 灰度模式：检测到标记只 log、不真发。验证标记不泄露、收件人/选图无误后改 `false`。 |
| `debug`（默认 `false`） | 每轮打一行（是否含 `[[relay:`、解析到几条），排查不触发时打开。 |

> 早期版本的 `toolDescription` / `targetDesc` / `messageDesc`（给原生工具看的话术）已随工具一起移除——
> 标记的用法说明现在写在角色**预设**里，不再是插件配置。

## NSFW（配图转发）

转发**露骨**相册图，模型必须在标记里显式加 `|nsfw`（如 `[[relay:芙蕾|图=床上那张|nsfw]]`）——
这把「要不要把露骨内容发给对方」交还给模型有意识地决定。若模型没标 `|nsfw`、但只匹配到露骨图，
本插件**不发图**（文字照发），并提示模型下一轮加 `|nsfw` 确认。分级裁决由 `photo` 服务的 `recallEntry` 负责。

## 关键坑

- **`recipients` 的 QQ 用字符串**（带引号），别写成裸数字。
- **群聊默认不触发**：`triggerGroups` 留空时只在私聊触发；要让某个群能触发 relay，把群号加进去。
- **扁平鉴权**：默认任何在 `triggerWhitelist` 里的会话都能 relay 给任意 `recipients`（含好友→好友横传）。
  若只想要「主人↔好友」而不许好友互传，需自行加方向性判断（本插件未内置）。
- 关掉 `rateLimitEnabled` 后 bot 可不限次主动私信，**风控风险高**，确认再关。

## 回滚

`koishi.yml` 把 `chatluna-relay:` 改成 `~chatluna-relay:`（禁用）即可——不再监听标记、不再发送。

## 许可

MIT
