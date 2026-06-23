# koishi-plugin-chatluna-scene-rules(livingmemory 记忆池别名器)

> ⚠️ **关于插件名**:npm 名沿用旧名 `koishi-plugin-chatluna-scene-rules`(早期是「场合判定」插件),
> 配置块的键也叫 `chatluna-scene-rules`。**它现在的功能已完全改成「livingmemory 记忆池别名器」**,
> 和「场合判定 / `{scene_rules()}`」无关。想换个直白的名字见发布包指南末尾。

让**同一个角色的多个预设**(私聊版 / 群聊版 / 语音版 / 旧版…)**共享同一个 livingmemory 记忆池**。
运行时接管 `chatluna_living_memory` 服务的 `createScope` / `resolvePresetId`,
在 presetId 上套一层别名映射——**不改 chatluna-livingmemory 任何文件,插件停用即自动还原**。

完整的安装 / 配置 / 验证 / 排障(以「髭切」为例)见发布包根目录的 **《安装与使用指南.md》**,这里只放速查。

## 为什么需要它

livingmemory 默认按 **presetId** 给每个预设单独开一个记忆池(角色预设的 presetId 形如 `名字（Character）`)。
你若把一个角色拆成「私聊版」「群聊版」两份独立预设 → 两个不同 presetId → 两个互不相通的记忆池
→ 私聊里聊过的事,群聊里它不记得。

本插件把这些 presetId 都映射到**同一个共享池 key**,于是它们读写同一个池,记忆打通。

## 依赖

- `koishi` ^4.17
- `chatluna`
- `chatluna-character`(角色预设;非本插件 service 硬依赖,但角色场景需要)
- **`chatluna-livingmemory`**(提供 `chatluna_living_memory` 服务,本插件的真正硬依赖)——
  必须先装好并能正常记忆;它自身依赖的 embeddings/向量库是它的事,本插件不碰。

## 三步启用

1. 安装(把本目录放到 koishi app 的 `external/` 下):
   ```bash
   npm i ./external/koishi-plugin-chatluna-scene-rules
   ```
2. `koishi.yml` 启用,填别名映射(**键 = presetId,全角括号；值 = 共享池 key**):
   ```yaml
     chatluna-scene-rules:main:
       debug: true                       # 首次开！日志里抄准确的 presetId
       aliases:
         髭切-本丸语音版（Character）: 髭切-通用版（Character）
         髭切-私聊版（Character）: 髭切-通用版（Character）
         髭切（Character）: 髭切-通用版（Character）
   ```
3. 触发一次对话,看日志确认映射命中,稳了把 `debug` 关掉。**改 aliases 后重启 koishi** 最稳。

## 配置项

| 配置 | 默认 | 说明 |
|---|---|---|
| `aliases` | `{}` | 别名字典。**键** = 预设 presetId(角色预设通常是 `预设名（Character）`,**全角括号**);**值** = 共享池 key。命中的预设读写同一个 livingmemory 池。 |
| `debug` | `false` | 打印每次 presetId 解析 + 映射结果(`原样使用` 或 `→ 共享key`),首次配置务必开,用来抄准确键名。 |

## 关键坑

- **键名是全角括号 `（Character）`,不是半角 `(Character)`**;差一个字符就不命中。务必先开 `debug` 抄日志里的原样字符串。
- **共享池 key 不要求真有一个同名预设存在**——它只是个字符串池名(常用一个退役/专设的「通用版」名字,池里就是合并后的记忆)。
- 打通**之前**各预设旧池里的历史记忆不会自动迁移/合并;本插件只让此后的读写落到同一个池。

## 回滚

`koishi.yml` 把 `chatluna-scene-rules:` 改成 `~chatluna-scene-rules:`(禁用)→ 自动还原服务方法,各预设回到各自独立池。

## 许可

MIT
