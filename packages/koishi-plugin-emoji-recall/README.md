# koishi-plugin-emoji-recall

> 按轮语义召回表情包。给 [chatluna](https://github.com/ChatLunaLab/chatluna) 的角色对话注册一个
> `{emojis_smart}` 函数变量:每次生成回复时,用**当前对话内容**向量检索 [emojiluna](https://github.com/koishijs)
> 的表情库,只把**最相关的 K 张**表情塞进提示词。

库越大也不会让每轮成本失控,而且 bot 发的图贴合当下话题(在聊猫,就浮现猫的表情)。

完整的安装 / 配置 / 预设接入(含「以髭切为例」的可复制片段)见仓库的
[**安装与使用指南**](https://github.com/ningningningning0420-ui/koishi-chatluna-plugins/blob/main/docs/emoji-recall-安装与使用指南.md)。这里只放速查。

## 它解决什么

emojiluna 原生的 `{emojis}` 会把**全部表情**(每张:名称 + 完整 URL + 分类 + 标签)塞进**每一轮**回复;
库越大越贵,而且与当前对话无关。本插件改成「按当前对话语义,只挑最相关的几张」。

机制与 livingmemory 的 `{living_memory}` 完全一致:都是 chatluna 的 function-provider,
能在渲染时拿到 `configurable.session`(当前消息)作查询。

## 依赖

- `koishi` ^4.18
- `chatluna`(核心,提供 promptRenderer 与 embeddings)
- `chatluna-character`(角色对话,渲染预设;非本插件 service 硬依赖,但角色场景需要)
- `emojiluna`(表情库与 `/get` `/tags` 端点)
- 一个 chatluna 能调用的 **embeddings 向量模型**(默认 `ollama/bge-m3:latest`)

## 三步启用

1. 安装:在 Koishi 控制台的**插件市场**搜 `emoji-recall` 直接安装;或命令行
   ```bash
   npm i koishi-plugin-emoji-recall
   ```
   (从源码用:把本目录放到 koishi app 的 `external/` 下,再 `npm i ./external/koishi-plugin-emoji-recall`。)
2. `koishi.yml` 启用(`selfUrl` 必须 = 本 bot 自己的端口,与 emojiluna 一致):
   ```yaml
     emoji-recall:main:
       selfUrl: http://127.0.0.1:5140
       backendPath: /emojiluna
       topK: 6
       embeddingModel: ollama/bge-m3:latest
       minScore: 0
       useReranker: false
       fallbackToRecent: true
       debug: true        # 首次开,日志看命中表情+分数,稳了再关
   ```
3. 改预设:把输出用的 `{emojis}` 换成 `{emojis_smart}`,`{if emojis}…{/if}` 外壳保留当「库里有没有图」的门。重启 koishi 生效。

## 配置项

| 配置 | 默认 | 说明 |
|---|---|---|
| `selfUrl` | `http://127.0.0.1:5140` | 本 bot 服务器地址,**必须 = 本 bot 端口**,与 emojiluna.selfUrl 一致 |
| `backendPath` | `/emojiluna` | emojiluna 后端路径,与 emojiluna.backendPath 一致 |
| `topK` | `6` | 每轮注入多少张最相关的表情 |
| `functionName` | `emojis_smart` | 注册的函数变量名,预设里用 `{该名}` 引用 |
| `embeddingModel` | `ollama/bge-m3:latest` | 向量模型 id,`platform/model`,需是 chatluna 能调用的 embeddings |
| `minScore` | `0` | 相似度下限;`0` = 永远取 topK,调高可在「没够相关的图」时少注入 |
| `useReranker` | `false` | 是否再用 reranker 精排(多一次网络调用) |
| `rerankModel` | `siliconflow/BAAI/bge-reranker-v2-m3` | reranker 模型 id(`useReranker` 开时用) |
| `maxQueryChars` | `200` | 查询文本最大长度(取当前消息尾部) |
| `fallbackToRecent` | `true` | 无对话文本 / embeddings 不可用时,退化为注入最近 K 张(关 = 注入空) |
| `debug` | `false` | 打印每轮的查询与命中表情 + 分数 |

`{emojis_smart(8)}` 可临时指定数量;无参则用配置的 `topK`。

## 验证

启动日志应出现:`emoji-recall ready (function {emojis_smart}, base=…)`。
开 `debug: true` 后,每轮日志:`query="…" → 名称(分数), …`。

## 许可

MIT
