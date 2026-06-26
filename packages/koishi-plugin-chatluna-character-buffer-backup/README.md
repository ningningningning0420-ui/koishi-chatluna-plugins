# koishi-plugin-chatluna-character-buffer-backup

> 把 [chatluna-character](https://github.com/ChatLunaLab/chatluna-character) **只存在内存里**的近期对话缓冲
> 持久化到数据库,**重启 / 控制台保存配置后自动灌回**,避免 bot 忘记刚刚聊到一半的上下文。

chatluna-character 的「角色对话」近期消息缓冲只放在内存(`MessageCollector`)。一旦重启 koishi、
或在控制台改配置触发热重载,这段缓冲就清空了——bot 会突然「忘了刚才在聊什么」。本插件:

- 每次收到新消息 → 防抖把该会话的缓冲快照写进数据库;
- `dispose`(正常重启 / 控制台保存)时再补一次刷盘,抓上 bot 的最后一条回复;
- 启动就绪后,把数据库里**够新**的存档灌回内存缓冲(按 messageId 去重合并、尾部截断到上限);
- 收到 chatluna-character 的「清除记忆」事件 → 同步删存档,保持诚实。

## 依赖

- `koishi` ^4.17
- **`koishi-plugin-chatluna-character`**(提供 `chatluna_character` 服务,本插件的硬依赖)——必须先装好并启用。
- 一个 koishi `database` 实现(如 `koishi-plugin-database-sqlite`),用来存档。

> ⚠️ 本插件读写 chatluna-character 的内部消息缓冲(私有字段 `_messages` 与 `chatluna_character/*` 事件)。
> 已做防御:字段结构不符时只告警、不崩溃。但若 chatluna-character 有**大版本改动**改了这些内部结构,
> 恢复可能静默失效——届时更新本插件即可。建议与你实际测试过的 chatluna-character 版本搭配使用。

## 启用

1. 在 Koishi 控制台的**插件市场**搜 `chatluna-character-buffer-backup` 安装并启用;或命令行
   ```bash
   npm i koishi-plugin-chatluna-character-buffer-backup
   ```
   (从源码用:放到 koishi app 的 `external/` 下,再 `npm i ./external/koishi-plugin-chatluna-character-buffer-backup`。)
2. 确保 `chatluna-character` 与一个 `database` 插件已启用,然后启用本插件即可——无需改预设。
3. 重启或保存配置后,日志出现 `上下文恢复完成：N 个会话` 即生效。

## 配置项

| 配置 | 默认 | 说明 |
|---|---|---|
| `debounceMs` | `3000` | 收到消息后多久把缓冲快照写库(毫秒,防抖;最小 500)。 |
| `maxAgeHours` | `24` | 启动恢复时,超过这个小时数的旧存档不再灌回(`0` = 不限)。 |
| `restoreCap` | `100` | 每个会话恢复的最大消息条数(对齐 chatluna-character 的 `maxMessages` 上限,3–100)。 |
| `debug` | `false` | 打印每次快照 / 恢复的条数。 |

## 工作原理(简)

- 存档表 `chatluna_character_buffer`,主键 = 会话 key(`private:<userId>` / `group:<guildId>`,与 chatluna-character 内部键一致)。
- 恢复时把数据库存档与当前内存缓冲按 messageId 去重合并、按时间升序、尾部保留最新 `restoreCap` 条。
- 全程 try/catch 兜底:存档读写失败、字段结构变化都只告警,不影响 bot 正常对话。

## 许可

MIT
