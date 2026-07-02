# koishi-plugin-chatluna-photo

让 ChatLuna 角色 bot **自主决定拍照发图**（NovelAI 生图，呈现为"本人拍的照片"）。

模型在自己的输出（最好在 `<think>` 里）写一个纯文本标记：

```
[[photo:意图描述|flags]]
```

插件从原始模型输出里带外读取标记 → **scene-planner**（独立的一次 LLM 调用）把意图+最近对话扩写成结构化 danbooru 富提示词 → NovelAI V4.5 生图 → 发到当前会话，并给 bot 写一条自我备注（下一轮它知道自己发过什么）。**不走原生工具调用**——工具调用会打断 chatluna-character 的文本回复解析，双方括号标记对解析完全透明。

## ⚠ 前置：chatluna-character 补丁（必须）

本插件依赖 `chatluna_character/raw-response` 事件，该事件**不是** koishi-plugin-chatluna-character 原生的，需要打一行补丁（在它处理模型输出 chunk 的位置加 `ctx.emit('chatluna_character/raw-response', session, chunk.responseContent)`）。没有补丁时插件加载正常但永远不触发（静默失效）。

**每次 `npm install` / 升级 chatluna-character 后补丁会被冲掉，必须重打并重启。**

## 标记语法

| 写法 | 含义 |
| --- | --- |
| `[[photo:缘侧晒太阳的自拍]]` | 拍一张（默认自拍构图、默认存相册） |
| `…\|none` | 本 bot 不在画面里（拍别人/风景） |
| `…\|from_behind` | 背影构图 |
| `…\|nsfw` | 露骨内容（planner 按 rating 产 tag；召回露骨旧图也必须带它——知情门控） |
| `…\|delete` | 一次性照片，不存相册 |
| `[[photo:描述\|recall]]` | 不生成——从相册按描述召回旧图重发（跨会话；语义向量匹配优先，字面回退） |
| `[[camera:on]]` / `[[camera:off]]` | 摄像模式开/关：开着时每条回复自动配一张此刻的 POV 自拍（计入限流额度，⚠ 烧 NAI 点数） |

一行一个标记 = 一张图，一轮多行多张（受 maxPerTurn 上限）。

## 功能

- **相册**：默认全存（`data/photo-album/`），溢出时由 planner 模型扮演角色"按心意"批量清理；硬上限兜底。
- **回复交互**：回复某张已发照片说"重roll"→ 同提示词换 seed 重生成并替换相册旧图；说"删了"→ 从相册删除那张（msgId 映射持久化，重启不丢）。
- **多人合影**：配置 `characterLibrary`（已知角色填 danbooru tag，原创角色填外貌 tag 串），planner 自动分配 NAI V4.5 char_captions 与站位。
- **失败拟人化**：按错误类型让 bot 说一句台词（点数不足"相机没电了"/磁盘满/其它），并写自我备注说明没发成。
- **photo 服务**：对外暴露 `ctx.photo.recallEntry(desc, opts)`，供 koishi-plugin-chatluna-relay 转发相册照片给白名单好友。
- **成品图回流**：发图/召回后把成品图挂在自我备注上回流进 bot 自己的上下文——多模态主模型直接"看到"自己刚发的那张（最近 8 条内、每会话只保留最新一张的像素）。需要历史图片补丁 **v2**（同一补丁目录，`node apply-history-image-patch.js` 会自动 v1→v2 升级）+ chatluna-character `image: true`。`runtime.selfPhotoInContext` 可关。

## 关键配置

- `apiKey`：NovelAI 持久 token。
- `activePreset` / `presets`：多套画风预设（画师串 + 负面 + NAI 参数），下拉切换。**角色 tag 不要写进画师串**——身份与画风分离。
- `characterTag.characterDanbooruTag`：本 bot 自身角色的 danbooru tag（如 `higekiri_(touken_ranbu)`），只注入 char_captions，绝不进 base_caption。
- `characterTag.selfGender`：强烈建议填（如 `male`），防 NSFW 场景性别画反。
- `planner.model`：scene-planner 模型（生图大脑），下拉选已注册模型；要出露骨 tag 需选不拒绝的端点。
- `access.*`：触发白名单/群白名单/限流（**摄像模式的自动拍同样计入** minIntervalSec 与 dailyLimit）。
- `dryRun`（默认开）：只记日志不真生图，灰度验证标记链路后再关。

配置键（koishi.yml）：`chatluna-photo:`。改 koishi.yml 里的本插件配置需要**重启** koishi（不热重载）。

## 提示词（预设引导）

给角色预设加"能力/许可"式引导（**不要写成死命令**，"必须主动用工具"式的指令会诱发幻觉旁白）：教模型想发图时在 `<think>` 里写 `[[photo:意图]]`，想发几张写几行，一次性照片加 `|delete`，翻旧照用 `|recall`。

## 测试

```
node test.js   # 69 个离线单测（纯逻辑层：标记解析/NAI 请求体/zip 解包/相册/planner 输出容错/护栏）
```
