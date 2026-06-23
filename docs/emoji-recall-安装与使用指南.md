# 表情包语义召回插件 · 安装与使用指南

> 让你的 Koishi + ChatLuna 角色 bot **按当前对话内容自动挑表情包**:
> 在聊猫,就浮现猫的表情;在斗图,就递上最贴题的那张。
> 库再大,每轮提示词也只带最相关的几张,token 不失控。

这个发布包内含两个自写插件(择一使用):

| 插件 | 变量 | 一句话 |
|---|---|---|
| **`koishi-plugin-emoji-recall`** ← 主角 | `{emojis_smart}` | 按当前对话**语义检索**,只注入最相关的 K 张图。最智能。 |
| `koishi-plugin-emoji-intents`(可选) | `{emoji_intents}` | 只注入**标签词表**,模型挑意图、服务器随机选图。最省 token、无需向量模型。 |

本指南**以 `emoji-recall` 为主线**,从零讲清安装 / 配置 / 接入预设,并**以「髭切」角色为例**给出可直接复制的预设片段。`emoji-intents` 的细节见其目录内 README。

---

## 0. 先理解它在整条链路里的位置(很重要)

这个插件**不自己存表情、不自己收集表情**。它是一块「挑图大脑」,接在两个现成服务之间:

```
群友发消息
   │
   ▼
emojiluna ……… 表情包的「仓库 + 收集器」:自动收图、AI 命名打标签、提供 /get /tags 端点
   │   （提供表情库列表给下游）
   ▼
emoji-recall … 本插件「挑图大脑」：拿当前对话做查询，向量检索仓库，挑出最相关的 K 张
   │   （注册成 chatluna 的 {emojis_smart} 变量）
   ▼
chatluna / chatluna-character … 渲染你的角色预设，把 {emojis_smart} 展开成一份图清单写进提示词
   │
   ▼
大模型 … 看到这份清单，决定要不要发、发哪张（输出 <sticker>URL</sticker>）
```

所以你必须先有一套能正常发表情的 **emojiluna**,本插件才有「仓库」可挑。
它和 livingmemory 的 `{living_memory}` 是**完全相同的机制**(都是 chatluna 的 function-provider,
渲染时能拿到「当前消息」作输入),只是检索的目标从「记忆」换成了「表情库」。

---

## 1. 前置依赖(必须先装好并能跑通)

在动本插件之前,确认下面这些都已就绪:

1. **Koishi** `^4.18`(本插件 `peerDependencies`)。
2. **ChatLuna**(`koishi-plugin-chatluna`)— 核心,提供 `promptRenderer` 和 embeddings 能力。
3. **chatluna-character**(角色对话/预设系统)— 它负责渲染你的角色预设,`{emojis_smart}` 在它渲染时被展开。
   注意:它**不是本插件的 service 硬依赖**(本插件只硬依赖 chatluna 与 emojiluna,见 §9),
   但你要做的是「角色 bot 按对话发表情」,自然需要它来跑角色预设——所以实践上必装。
4. **emojiluna**(`koishi-plugin-emojiluna`)— 表情包仓库 + 收集器。需要它:
   - 能自动/手动收图入库;
   - 后端服务开着(`backendServer: true`),`/emojiluna/get/:id`、`/emojiluna/tags/:tag` 等端点可访问;
   - 配好 `selfUrl`(= 本 bot 自己的端口,例如 `http://127.0.0.1:5140`)。
   - 先确认「原生 `{emojis}` 能正常发图」,再上本插件——本插件只是换了挑图方式。
5. **一个 embeddings 向量模型**,且 chatluna 能调用它。这是本插件区别于 `emoji-intents` 的唯一额外要求。
   推荐本地 **Ollama + bge-m3**(免费、隐私、低延迟);见下面 §1.1。
   > 如果你不想引入向量模型,直接改用本包里的 `emoji-intents`(方案不需要 embeddings)。

### 1.1 准备 embeddings 向量模型(以本地 Ollama + bge-m3 为例)

本插件默认 `embeddingModel: ollama/bge-m3:latest`。要让 chatluna 能用这个 id,需要两步:

**a) 装 Ollama 并拉模型**

```bash
# 安装 Ollama: https://ollama.com  （macOS 也可 brew install ollama）
ollama serve                 # 启动本地服务（默认 127.0.0.1:11434）
ollama pull bge-m3           # 拉取 bge-m3 向量模型
```

**b) 在 chatluna 里把 Ollama 接成一个平台**

Ollama 暴露 OpenAI 兼容接口(`/v1`),用 chatluna 的「openai-like 适配器」桥接即可。
在 `koishi.yml` 的 `plugins:` 下加一个适配器实例(实例名可随意,这里叫 `ollama01`):

```yaml
  chatluna-openai-like-adapter:ollama01:
    platform: ollama                  # ← 平台名，决定了模型 id 前缀 ollama/...
    pullModels: false
    additionalModels:
      - model: bge-m3:latest
        modelType: Embeddings 嵌入模型  # ← 必须精确是这个字符串，否则不会被当作 embeddings
    apiKeys:
      - - ollama                      # key 占位即可（本地 Ollama 不校验），但非空
        - http://127.0.0.1:11434/v1   # Ollama 的 OpenAI 兼容地址
        - true                        # ★ 第三个 true=启用；缺了这条 apiKey 会被静默丢弃
```

> 几个**最容易踩的坑**(本适配器的真实字段就是这样,别凭印象写):
> - **不存在** `embeddings:` 或 `chatModel:` 字段;注册某模型为向量模型的**唯一**方式是
>   `additionalModels` 里 `modelType: Embeddings 嵌入模型`(这个中文字符串要一字不差)。
> - `apiKeys` 是**三元组** `[key, 地址, 是否启用]`,第三个 `true` 不能漏,漏了整条会被过滤掉。
> - 配好后,模型 id 就是 `平台/模型` = `ollama/bge-m3:latest`,正好是本插件 `embeddingModel` 的默认值。
>
> 如果你已经在用 livingmemory 的向量召回,**直接复用它那一个 embeddings id 即可,无需新接**——
> 在控制台 livingmemory 配置页看它的 `embeddingModel` 填的是什么,把本插件 `embeddingModel` 填成一样的。

也可以换成任何 chatluna 支持的 embeddings 平台(OpenAI、硅基流动等),
只要把 `embeddingModel` 改成对应的 `platform/model`。

---

## 2. 安装本插件

把发布包里的 `koishi-plugin-emoji-recall/` **整个目录**,放到你的 koishi app 根目录下的 `external/` 里:

```
<你的koishi-app>/
├── koishi.yml
├── package.json
└── external/
    └── koishi-plugin-emoji-recall/   ← 放这里
        ├── index.js
        ├── package.json
        └── README.md
```

然后让 koishi 能加载它,二选一:

**方式 A · 本地 file 依赖(推荐)**

```bash
# 在 koishi app 根目录执行
npm i ./external/koishi-plugin-emoji-recall
# 或 yarn:
yarn add koishi-plugin-emoji-recall@file:./external/koishi-plugin-emoji-recall
```

这会在 app 的 `package.json` 里写入一条 `"koishi-plugin-emoji-recall": "file:./external/..."`,
并在 `node_modules/` 里建立链接。koishi 会自动发现所有 `koishi-plugin-*`。

**方式 B · 手动软链(不想动 lockfile 时)**

```bash
# 在 koishi app 根目录
cd node_modules
ln -sfn ../external/koishi-plugin-emoji-recall koishi-plugin-emoji-recall
```

> 方式 B 适合临时灰度验证,不改 `package.json`/lock;正式化时再用方式 A 跑一次 `npm i`。

装好后,koishi 控制台的「插件市场 / 已安装」里应能看到 `emoji-recall`。

---

## 3. 在 koishi.yml 里启用并配置

在 `koishi.yml` 的 `plugins:` 下加一个实例(实例名随意,这里用 `main`,**两个空格缩进**):

```yaml
  emoji-recall:main:
    selfUrl: http://127.0.0.1:5140      # ★ 本 bot 自己的端口，必须与 emojiluna.selfUrl 一致
    backendPath: /emojiluna             # 与 emojiluna.backendPath 一致
    topK: 6                             # 每轮注入几张最相关的表情
    functionName: emojis_smart          # 注册的变量名（预设里用 {emojis_smart}）
    embeddingModel: ollama/bge-m3:latest # 与 §1.1 配好的向量模型 id 对应
    minScore: 0                         # 0=永远取 topK；调高可在“没够相关的图”时少注入
    useReranker: false                  # 想更准可开（多一次 reranker 网络调用）
    rerankModel: siliconflow/BAAI/bge-reranker-v2-m3
    maxQueryChars: 200                  # 查询取当前消息尾部多少字
    fallbackToRecent: true             # 无对话/向量不可用时，退化为最近 K 张
    debug: true                        # ★ 首次开！日志能看到命中的表情和分数，稳了再关
```

也可以不写 yaml,直接在 koishi **控制台 → 插件配置页** 填这些项,效果一样。

### 配置项逐条说明

| 配置 | 默认 | 说明 |
|---|---|---|
| `selfUrl` | `http://127.0.0.1:5140` | **最容易配错的一项**:必须是**本 bot 自己**的服务器地址/端口,和该 bot 的 `emojiluna.selfUrl` 完全相同。填成别的 bot 的端口会抓到别人的图。 |
| `backendPath` | `/emojiluna` | emojiluna 的后端路径,和 `emojiluna.backendPath` 一致。 |
| `topK` | `6` | 每轮注入多少张。库小时(<10 张)选择性不明显,库变大后才显出「只挑相关的」。 |
| `functionName` | `emojis_smart` | 注册成 chatluna 函数变量的名字。改了它,预设里也要改成对应的 `{新名}`。 |
| `embeddingModel` | `ollama/bge-m3:latest` | 向量模型 id,`platform/model`。必须是 chatluna 能调用的 embeddings(见 §1.1)。 |
| `minScore` | `0` | 相似度下限。`0` = 总是取 topK(哪怕没那么相关);设 `0.3` 左右 = 没有够相关的图时宁可少发/不发。 |
| `useReranker` | `false` | 开了会对向量选出的 `topK×3` 候选再用 reranker 精排取 topK,更准但每轮多一次网络调用。**经验:库不大时关着更好**——精排会收窄选图、压掉随性;留默认即可。(若要开,需另配一个 reranker 模型,方式同 §1.1,只是 `modelType` 改成 `Reranker 重排序模型`,并把 `rerankModel` 填成对应 id。) |
| `rerankModel` | `siliconflow/BAAI/bge-reranker-v2-m3` | 仅 `useReranker: true` 时生效。 |
| `maxQueryChars` | `200` | 查询文本取当前消息的尾部多少字。 |
| `fallbackToRecent` | `true` | 没有对话文本(如定时触发)或 embeddings 不可用时:`true`=退化为注入最近 K 张(不至于一张图都没有),`false`=注入空。 |
| `debug` | `false` | 首次配置务必开,日志会打 `query="…" → 名称(分数), …`,用来确认检索真的在工作、命中合理。 |

---

## 4. 接入角色预设(以「髭切」为例)

ChatLuna 角色预设里,凡是用到 emojiluna 的地方,有两类变量:

- `{if emojis}…{/if}`：emojiluna 提供的**条件开关**,表示「表情库里到底有没有图」。**保留它**当门:库空时整段隐藏、优雅降级。
- `{emojis_smart}`：**本插件**注册的函数变量,展开成「当前对话最相关的 K 张」清单。**用它替换**原来的 `{emojis}`(全量清单)。

也就是说:**外壳 `{if emojis}` 不动,把里面那行实际出清单的 `{emojis}` 换成 `{emojis_smart}`**。

### 4.1 髭切预设里的真实片段(可直接照抄)

下面是「髭切」预设中表情包相关的两段,已是接入 `{emojis_smart}` 后的样子。
你可以把自己预设里对应的位置改成这样(注意保持你预设原有的缩进):

**(a) 输出格式说明里,声明「可以发表情包」这一种输出**:

```
{if emojis}
- 表情包（URL 取自 <sticker_library> 清单）：
  <output>
  <message><sticker>表情包URL</sticker></message>
  </output>
{/if}
```

**(b) 表情包库本体——把清单交给模型挑**:

```
{if emojis}
<sticker_library>
# 表情包库——你在 <output> 里可发送的表情包全部清单
- 条目格式：- [名称](URL) - 分类、标签。发送时 URL 必须从条目圆括号内逐字符复制，禁止自造、改写，也禁止使用格式示例里的占位 URL
- 表情包单独占一条 <message>，可与文字消息组成多条输出；表情包消息不会也不需要转语音，发图就是发图
- 表情包消息里不要写声线标签，标签只属于会被配音的文字消息
- 群里别人刚发的表情包会以 <sticker>URL</sticker> 形式出现在上下文里，想跟图、玩梗时也可以原样回贴那条 URL；太久之前的链接会失效，别翻旧帖找图
- 按当下语境与你此刻的心情挑；没有贴合的就不用，文字本身已经足够
- 你的用法：你爱用表情包，挑图随性带笑——有时一张图就是完整的回答；群里斗图，你向来乐意接
{emojis_smart}
</sticker_library>
{/if}
```

> `{emojis_smart}` 这一行,在渲染时会被本插件替换成形如:
> ```
> - [熊猫头嚣张](http://127.0.0.1:5140/emojiluna/get/xxxx) - 分类: 反应, 标签: 嚣张, 得意
> - [猫猫疑惑](http://127.0.0.1:5140/emojiluna/get/yyyy) - 分类: 动物萌宠, 标签: 疑惑
> ```
> ——也就是「当前这轮对话最相关的 K 张」,而不是整库。

### 4.2 关键点

- **`{emojis_smart}` 没有花括号参数也能用**,语法和 `{living_memory}` 一样(都是函数变量)。
  但它**只能作内容展开,不能写成 `{if emojis_smart}` 当门**——它不是布尔条件变量(库空时它返回空字符串)。
  「库里有没有图」的判断仍然走 emojiluna 的 `{if emojis}`。
- 想**临时改数量**:写 `{emojis_smart(8)}` 就是这一处取 8 张;不带参数则用配置里的 `topK`。
- 「髭切」是个**爱用表情、挑图随性**的角色,所以预设里特意写了「挑图随性带笑」「群里斗图乐意接」。
  你换别的角色时,把这两句换成符合该角色性格的用法说明即可——**插件只负责递上「相关的图」,
  发不发、怎么发,由角色性格和这几句提示决定**。
- 改完预设**重启 koishi**(或触发预设热重载)生效。

> ⚠️ **务必保持 emojiluna 的 `injectVariables: true`(默认就是 true)。**
> `{if emojis}` 这个门是 emojiluna 提供的;一旦你把 emojiluna 配成 `injectVariables: false`,
> 它就不再算 `emojis` 变量,`{if emojis}` 恒为假,**整段(连同 `{emojis_smart}`)被静默隐藏,
> 一张图都不发、且没有任何报错**——非常难自查。
> 这**不会**造成双注入:因为你的预设已经不再直接引用 `{emojis}`(全量清单),emojiluna 算出的全量清单不会进 prompt,
> `{if emojis}` 只用来判断「库里有没有图」。
> (反过来,姊妹插件 `emoji-intents` 恰恰要求 `injectVariables: false`——所以这两个插件**互斥,二选一**,
> 不要在同一个 bot 上同时按两套说明配。)

---

## 5. 验证是否生效

1. **看启动日志**,应出现:
   ```
   emoji-recall ready (function {emojis_smart}, base=http://127.0.0.1:5140/emojiluna)
   ```
   没有这行 → 插件没加载成功(检查 §2 安装、依赖 chatluna/emojiluna 是否就绪)。

2. **`debug: true` 时,每轮回复前会打**:
   ```
   emoji-recall  query="再嚣张就送你去远征" → 熊猫头嚣张(0.43), 猫猫得意(0.39), …
   ```
   能看到 `query=…` 和命中的「名称(分数)」就说明语义检索真的在工作。
   (这条日志在 koishi 的日志里;若用 JSON 日志,grep `emoji-recall` 即可。)

3. **群里发一句带情绪的话**,看 bot 是否递出贴题的表情。
   - 初期库小(几张)时,topK 几乎覆盖全库,「选择性」不明显——这是正常的,库变大后才显出差别。

---

## 6. 工作原理(简述)

每次渲染预设、要展开 `{emojis_smart}` 时:

1. 取**当前消息** `session.content` 作查询,去掉 `<at/>`/`<img/>` 等元素噪声与 URL,取尾部 `maxQueryChars` 字。
2. 从 emojiluna 拿全部表情;每张用「名称 + 分类 + 标签」算一个向量,**缓存在内存**。
   缓存以该文本的 hash 为键:新表情、或表情文本(名称/分类/标签)变了,才会重算那一张;
   表情被改/删时也会即时清掉对应缓存。所以稳定状态下每轮实际只算 1 次「查询向量」,不会每轮重算整库。
3. 查询向量与每张表情向量算**余弦相似度**,排序,(可选 `minScore` 过滤、`useReranker` 精排)取 **topK**。
4. 把这 K 张拼成 Markdown 清单注入提示词。
5. **降级**:没有对话文本(定时触发)或 embeddings 不可用时,按 `fallbackToRecent` 退化为最近 K 张或注入空——
   不会报错、不会卡住回复。
6. 记账类噪声标签(`自动获取`、`来自群:xxx`)会被自动过滤,不进向量也不展示。

---

## 7. 调优经验

- **`topK`**:群聊斗图 4~6 够用;希望表情更克制就调小。
- **`minScore`**:默认 `0`(总有图)。想要「话题不对就别硬发图」,设 `0.3` 左右,让不相关时少注入甚至不注入。
- **`useReranker`**:默认关。开了更「准」,但会把选图收窄到最贴题,**压掉随性和意外**;
  对「爱乱发图」的角色反而不如关着自然。库极大、纯向量糊到分不出时再考虑。
- **库太小**:topK 接近全库时,语义排序看不出效果属正常;多攒些图再看。
- **每轮触发次数**:某些渲染路径会渲染两遍 → 一轮可能跑两次检索;本地 ollama 很廉价,一般无需优化。

---

## 8. 回滚 / 卸载

- **临时停用**:`koishi.yml` 把 `emoji-recall:main` 改成 `~emoji-recall:main`(前缀 `~` = 禁用),
  并把预设里的 `{emojis_smart}` 改回 `{emojis}`(恢复 emojiluna 原生全量),重启。
- **彻底卸载**:`npm rm koishi-plugin-emoji-recall`(或删掉软链),删掉 `koishi.yml` 里的实例段,删 `external/` 目录。
- 三步(安装 / 配置 / 改预设)互相独立,可逐步灰度——先在一只 bot 上验证,稳了再推其它角色。

---

## 9. 常见问题(FAQ)

**Q：启动日志没有 `emoji-recall ready`。**
A：① 依赖没就绪——本插件 `service.required: [chatluna, emojiluna]`,这两个插件必须都已加载;
② 没安装成功——检查 §2,确认 `node_modules/koishi-plugin-emoji-recall` 存在;
③ koishi.yml 里实例段缩进/语法有误。

**Q：`{emojis_smart}` 在回复里原样输出、没被替换成清单。**
A：① 变量名对不上——配置 `functionName` 和预设里的 `{…}` 必须一致;
② 预设没重启/没热重载;③ 插件其实没启用。

**Q：一张图都不发。**
A：① emojiluna 库是空的(`{if emojis}` 为假,整段隐藏)——先让 emojiluna 收够图;
② emojiluna 被配成了 `injectVariables: false` → `{if emojis}` 恒为假,整段静默隐藏(见 §4.2 的 ⚠️)——改回 `true`;
③ embeddings 不可用且 `fallbackToRecent: false`——开 `debug` 看日志里是不是一直 `fallback`;
④ `minScore` 设太高,把所有图都过滤掉了。

**Q：发的图和话题不沾边。**
A：① embeddings 没真正接好——开 `debug`,若分数全是 `0.00` 或恒定,说明向量没算出来,回查 §1.1;
② 库太小,topK 覆盖全库,谈不上「挑」;③ 表情的标签太少/太泛,检索没抓手——
让 emojiluna 给图打更好的名称和标签会显著提升命中。

**Q：selfUrl 该填什么?**
A：填**本 bot 自己**的服务器地址和端口(和这只 bot 的 `emojiluna.selfUrl` 一模一样)。
多 bot 部署时,每只 bot 的 `selfUrl` 各填各的端口,千万别都填同一个,否则会抓到别人的表情库。

**Q：不想引入向量模型/Ollama,可以吗?**
A：可以,改用本包里的 **`koishi-plugin-emoji-intents`**(注入标签词表、服务器随机选图),
它不需要 embeddings;细节见 `koishi-plugin-emoji-intents/README.md`。

---

## 10. 发布包内容清单

```
koishi-plugin-emoji-recall-发布包/
├── 安装与使用指南.md                 ← 你正在看的这份（主线 = emoji-recall）
├── koishi-plugin-emoji-recall/       ← 主插件（{emojis_smart}，语义召回）
│   ├── index.js
│   ├── package.json
│   └── README.md
└── koishi-plugin-emoji-intents/      ← 可选姊妹插件（{emoji_intents}，词表/省 token）
    ├── index.js
    ├── package.json
    └── README.md
```

许可:MIT。两个插件均依赖 `chatluna` 与 `emojiluna` 服务,本身不收集/存储表情。
