# koishi-plugin-chatluna-relay

> **让 ChatLuna 角色 bot 主动私信好友。** 给 bot 注册**一个**受护栏保护的工具
> `find_friend_chat`：白名单里的人可以在对话中让 bot 就某个话题**主动私信**一位白名单好友——
> bot 发的是**它自己组织的开场白**（用它自己的口吻），之后的一来一往就是 chatluna 私聊的默认行为。
> 不是「原样转发」别人的话，而是 bot 以自己的身份去联系。

面向模型的所有话术（工具说明 / 参数说明）都能在控制台改写，所以**适配任意角色**，不写死任何人设。

## 它解决什么

chatluna 角色 bot 默认是「被动」的——只在别人找它时回应。本插件给它一个**主动联系**的能力：
你（或其他被授权的人）在跟 bot 聊天时说一句「帮我跟小明说一下 X」「你去问问阿花在不在」，
bot 就会用自己的口吻私信那位好友。因为是真·主动发送，所以默认套了多道护栏防滥用 / 防风控。

## 五道护栏

| # | 护栏 | 作用 |
|---|---|---|
| ① | **触发白名单** `triggerWhitelist`（+ `triggerGroups`） | 只有名单里的人能触发「让 bot 主动联系」。群里默认完全不触发，除非把群号显式加进 `triggerGroups`。 |
| ② | **收件人白名单** `recipients` | bot 只能联系名单内的人（别名 → QQ 映射）。模型给的 `target` 不在名单 → 拒发。 |
| ③ | **仅好友** | 目标必须是 bot 的实际好友（运行时拉好友列表核对；拉不到则跳过此项，best-effort）。 |
| ④ | **限流** `minIntervalSec` / `dailyLimit` | 最小发送间隔 + 每日上限。`rateLimitEnabled: false` 可整体关掉（⚠️ 风控风险高）。 |
| ⑤ | **防回环** `myBots`（可选） | 把自己其它 bot 的 QQ 填进来，来自这些号的私聊不触发本 bot 自动回复，避免两个 bot 互刷。默认空 = 不启用。 |

## 依赖

- `koishi` ^4.17
- **`chatluna`**（`koishi-plugin-chatluna`）—— 本插件的硬依赖 service，工具就注册在它的工具体系里。
- `chatluna-character`（**可选**）—— 开启 `recordSentToMemory` 时，用它把「这次主动联系」补登记进对话缓冲；没装就自动降级（照常发送，只是不写记忆）。
- `@langchain/core` / `zod` —— 由 chatluna 生态提供，**无需单独安装**（peer 声明为 `*`，复用 chatluna 那一份，避免版本冲突）。
- 收发依赖适配器支持 `sendPrivateMessage` 与 `getFriendList`（OneBot 满足）。

## 启用

1. 安装：在 Koishi 控制台**插件市场**搜 `chatluna-relay`；或命令行
   ```bash
   npm i koishi-plugin-chatluna-relay
   ```
   （从源码用：把本目录放到 koishi app 的 `external/` 下，再 `npm i ./external/koishi-plugin-chatluna-relay`。）
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
   ```
3. 跟 bot 私聊，让它「给小明带句话」，看日志里 `find_friend_chat tool registered` 与发送结果。

## 可改话术（适配你的角色）

这三项决定模型**何时、怎样**用这个工具，按你的 bot 风格改写即可（留空用通用默认）：

| 配置 | 说明 |
|---|---|
| `toolDescription` | 给模型看的工具总说明：它在什么情境会主动联系、用什么口吻。 |
| `targetDesc` | `target` 参数（收件人别名）的说明。 |
| `messageDesc` | `message` 参数的说明：想让 bot 用特定格式/语言（如双语、带中文翻译）就写在这里。 |

`recordSentToMemory`（默认开）：把每次主动联系补登记进对话记忆——①收件人会话标成 bot 自己发的，下次接得上；②发起这次联系的会话记一条「我给谁发了什么」，让 bot 在原会话里也知道自己做过。

## 关键坑

- **`recipients` 的 QQ 用字符串**（带引号），别写成裸数字。
- **群聊默认不触发**：`triggerGroups` 留空时，工具只在私聊里提供；要让某个群能触发，把群号加进去——且**只加走原生 tool-calling 适配器（如 chatluna-claude-adapter）的群**，别加落到 OpenAI 工具方言兜底配置的群（可能 400）。
- 关掉 `rateLimitEnabled` 后 bot 可不限次主动私信，**风控风险高**，确认再关。

## 回滚

`koishi.yml` 把 `chatluna-relay:` 改成 `~chatluna-relay:`（禁用）即可，工具下线、不再注册。

## 许可

MIT
