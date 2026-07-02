# koishi-plugin-chatluna-life-sim

本丸日常模拟器：让刀剑男士 bot 在不聊天时也自主「过日子」。

> **Phase 1 骨架（当前）**：配置 schema + 所有 DB 表 + 模型调用封装。调度/roll/记忆/外联等在后续任务实现。

## 设计

见 `docs/本丸日常模拟器-设计文档.md`。

## 接入指南

### 预设改动（装完必须做，不做等于白装）

四个变量必须在 chatluna 预设文本里**显式引用**才会渲染——注册 provider 只是让变量可用，不会自动出现在 prompt 里：

```yaml
# 放在静态人设之后、尽量靠后（四变量每次 wake 都变，靠后为将来 prompt cache 铺路）
【近况】{recent_life}
【此刻】{life_state}
【今日计划】{today_plan}
【想说的话】{pending_thoughts}
关于你最近/今天做了什么，以 {recent_life} 与 {today_plan} 为准，不要虚构未记录的生活事件。
```

- 最后一行 grounding 约束**必须有**：没有它，主模型会即兴编造生活细节，跨时间一致（本插件的唯一硬价值）就漏了。
- 措辞红线：只写内容约束，**不要**写"主动使用工具"式的死指令（chatluna-character 的输出解析会崩，本生态吃过亏）。

### 主动消息成稿改写

- `proactiveRewrite`（默认 `true`）：主动消息发送前由 `proactiveModel` 以人设为底，把便宜模型的 draft 草稿重写成最终文案——避免草稿直发和主模型正常回复之间的嗓音断层。关掉 = 草稿直发（向后兼容）。
- `proactiveModel`（默认空）：成稿改写用的模型，`platform/model` 格式；留空 = 复用 `consolidateModel`。每日上限才 2 条，改写成本可忽略。
- 禁操控话术 guard 作用于改写后的最终外发文本；追问文案同路径。

### 运维注意

- **presetId 是裸字符串键**：所有 sim 表（事件/状态/计划/长期记忆/心事簿）都按 presetId 分区。**改预设名 = 该角色全部生活记忆断链**。改名前先想清楚，或准备手工迁移数据。

### 健康自检

- 启动 `ready` 时按 preset 打健康日志：persona 数据源实际用到哪级（service/file/default）、四变量 provider 是否注册成功、预设文本是否引用了四变量（best-effort，读不到预设就报 unknown）。persona 落到 file/default 级会 warn。
- console 事件 `life-sim/getHealth` 随时可查。针对"系统在跑但人设降级成通用模板、注入静默失效"这类静默失败。

## 开发测试

```bash
node test.js
```

运行无框架离线自测（纯逻辑，不需要 koishi 运行时）。

## 依赖

- `koishi ^4.17.0`
- `koishi-plugin-chatluna *`（服务：`chatluna`，可选：`chatluna_character`）
