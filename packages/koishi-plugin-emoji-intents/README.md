# koishi-plugin-emoji-intents(姊妹方案 · 更省 token)

> 把 emojiluna 的**标签/分类词表**注入 chatluna,而不是逐张 URL 清单。
> 模型只表达**意图**(「发个开心的图」),由 emojiluna 的 `/tags/:tag`、`/categories/:category`
> 端点在服务器侧**随机挑一张**图发出。

**每轮 token 只随「标签数」增长、且封顶,不随图片数增长。** 库随便攒,主回复成本不变。
代价:模型选的是意图,具体哪张图由服务器随机,不如逐张清单精确——对群聊斗图反而更自然。

## 它与 emoji-recall 的关系(择一启用)

| | `emoji-intents`(本插件) | `emoji-recall`(主方案) |
|---|---|---|
| 注入 | 标签/分类词表 | 当前对话最相关的具体 K 张 |
| 智能度 | 中(意图级) | 高(语义级,贴合上下文) |
| 额外开销 | 无 | 每轮一次 embedding 调用 |
| 依赖向量模型 | 否 | 是(ollama bge-m3 等) |
| token | 随标签数,封顶 | 随 K(默认 6) |

两者都基于 emojiluna 的同一表情库,**只启用其中一个**即可(变量名不同:`{emoji_intents}` vs `{emojis_smart}`)。

## 三步启用

1. 安装:在 Koishi 控制台的**插件市场**搜 `emoji-intents` 直接安装;或命令行
   ```bash
   npm i koishi-plugin-emoji-intents
   ```
   (从源码用:放到 koishi app 的 `external/` 下,再 `npm i ./external/koishi-plugin-emoji-intents`。)
2. `koishi.yml` 启用(`selfUrl` = 本 bot 端口),并**关掉 emojiluna 的全量注入**避免双注入:
   ```yaml
     emoji-intents:main:
       selfUrl: http://127.0.0.1:5140
       backendPath: /emojiluna
       mode: tags            # tags / categories / both
       maxTags: 40
       variableName: emoji_intents
       debug: true
     emojiluna:你的实例名:
       injectVariables: false   # ← 停掉逐张 {emojis} 全量清单,只留 {emoji_intents}
       # …其余 emojiluna 配置照旧
   ```
   > `injectVariables: false` 只关掉「往 prompt 塞全量清单」,autoCollect、`/get` `/tags` 等都不受影响。
3. 改预设:把 `{emojis}` 块换成 `{emoji_intents}`:
   ```
   {if emoji_intents}
   # 表情包
   {emoji_intents}
   - 表情包单独占一条消息,不转语音、不写声线标签
   - 一条消息最多发一张
   {/if}
   ```
   输出格式里保留 `<message><sticker>表情包URL</sticker></message>` 范例即可(URL 来源改由 `{emoji_intents}` 里的规则指导)。重启 koishi 生效。

## 配置项

| 配置 | 默认 | 说明 |
|---|---|---|
| `selfUrl` | `http://127.0.0.1:5140` | 本 bot 服务器地址,**必须 = 本 bot 端口** |
| `backendPath` | `/emojiluna` | emojiluna 后端路径 |
| `mode` | `tags` | `tags`=情绪标签 / `categories`=角色分类 / `both`=都注入 |
| `maxTags` | `40` | 最多注入多少个标签(控制 token 上限) |
| `refreshIntervalMinutes` | `5` | 词表刷新间隔;表情库增删时也会即时刷新 |
| `variableName` | `emoji_intents` | 注入的变量名,预设里用 `{该名}` / `{if 该名}…{/if}` |
| `debug` | `false` | 打印每次刷新的词表长度 |

## 回滚

koishi.yml 把 `emoji-intents:` 改成 `~emoji-intents:`(禁用),删掉 emojiluna 的 `injectVariables: false`(恢复原生 `{emojis}`),卡改回 `{emojis}`。

## 许可

MIT
