# koishi-plugin-chatluna-life-sim

本丸日常模拟器：让刀剑男士 bot 在不聊天时也自主「过日子」。

> **Phase 1 骨架（当前）**：配置 schema + 所有 DB 表 + 模型调用封装。调度/roll/记忆/外联等在后续任务实现。

## 设计

见 `docs/本丸日常模拟器-设计文档.md`。

## 开发测试

```bash
node test.js
```

运行无框架离线自测（纯逻辑，不需要 koishi 运行时）。

## 依赖

- `koishi ^4.17.0`
- `koishi-plugin-chatluna *`（服务：`chatluna`，可选：`chatluna_character`）
