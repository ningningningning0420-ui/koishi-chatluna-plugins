# koishi-chatluna-plugins

给 [Koishi](https://koishi.chat) + [ChatLuna](https://github.com/ChatLunaLab/chatluna) 角色 bot 写的几个小插件,
配合 ChatLuna 的角色对话 / 表情 / 长期记忆体系使用。四个插件互相独立,按需取用。

> 都已(或可)发布到 npm,在 Koishi 控制台**插件市场**搜对应名字即可安装;也支持放到 koishi app 的
> `external/` 下用 `file:` 依赖从源码加载。每个插件目录内有独立 README,`docs/` 下有更详细的
> 「安装与使用指南」(以髭切角色为例)。

## 插件一览

| 插件 | 注入变量 / 能力 | 一句话 | 文档 |
|---|---|---|---|
| **`koishi-plugin-emoji-recall`** | `{emojis_smart}` | 按**当前对话语义**向量检索 [emojiluna](https://github.com/) 表情库,每轮只注入最相关的 K 张表情(库再大 token 也不失控、且贴合上下文) | [指南](docs/emoji-recall-安装与使用指南.md) · [README](packages/koishi-plugin-emoji-recall/README.md) |
| `koishi-plugin-emoji-intents` | `{emoji_intents}` | emoji-recall 的**姊妹方案**:只注入标签/分类词表,模型挑意图、服务器随机选图;最省 token、无需向量模型(与 emoji-recall 二选一) | [README](packages/koishi-plugin-emoji-intents/README.md) |
| **`koishi-plugin-chatluna-scene-rules`** | livingmemory 记忆池别名器 | 把同一角色的多个预设(私聊版 / 群聊版 / 语音版…)的 `presetId` 映射到**同一个共享记忆池 key**,实现多预设共享 livingmemory 记忆;运行时接管服务方法、不改 livingmemory 任何文件 | [指南](docs/记忆池别名器-安装与使用指南.md) · [README](packages/koishi-plugin-chatluna-scene-rules/README.md) |
| `koishi-plugin-chatluna-character-buffer-backup` | 对话缓冲持久化 | 把 chatluna-character 只存在内存的近期对话缓冲持久化到数据库,重启 / 保存配置后自动灌回,避免 bot「忘记刚才聊的」 | [README](packages/koishi-plugin-chatluna-character-buffer-backup/README.md) |

> ℹ️ `koishi-plugin-chatluna-scene-rules` 的包名 / 配置键**沿用旧名**(早期是「场合判定」插件),
> 现在的功能是「livingmemory 记忆池别名器」,与 `{scene_rules()}` 无关。详见其指南。

## 公共前置

- **Koishi** `^4.17+`
- **ChatLuna**(`koishi-plugin-chatluna`)+ **chatluna-character**(角色对话 / 预设)
- 表情类插件额外需要 **emojiluna**(表情仓库 + 收集);`emoji-recall` 还需要一个 chatluna 能调用的 **embeddings 向量模型**(如本地 Ollama + `bge-m3`)
- 记忆别名器额外需要 **chatluna-livingmemory**(提供 `chatluna_living_memory` 服务)
- 缓冲备份器只需 **chatluna-character** 本身 + 一个 koishi `database` 实现(如 sqlite)

各插件的精确依赖见对应文档。

## 安装(通用)

推荐直接在 Koishi 控制台**插件市场**搜对应插件名安装;或命令行 `npm i <插件名>`。
也可从源码用:把要用的插件目录从 `packages/` 拷到你的 koishi app 的 `external/` 下,然后任选其一:

```bash
# 在 koishi app 根目录
npm i ./external/<插件目录名>
# 或软链(不想动 lockfile 时)
cd node_modules && ln -sfn ../external/<插件目录名> <插件目录名>
```

再在 `koishi.yml`(或控制台插件配置页)启用并配置,改对应角色预设。逐步骤见 `docs/` 下的指南。

## 目录结构

```
packages/
├── koishi-plugin-emoji-recall/                    # 表情语义召回 {emojis_smart}
├── koishi-plugin-emoji-intents/                   # 表情意图词表 {emoji_intents}（姊妹方案）
├── koishi-plugin-chatluna-scene-rules/            # livingmemory 记忆池别名器
└── koishi-plugin-chatluna-character-buffer-backup/ # 对话缓冲持久化 / 重启恢复
docs/
├── emoji-recall-安装与使用指南.md
└── 记忆池别名器-安装与使用指南.md
```

## 许可

[MIT](LICENSE)
