# koishi-plugin-chatluna-worldbook

酒馆(SillyTavern)式**世界书 / lorebook**:按关键词扫描最近消息,**按需注入**设定条目到 chatluna-character 预设——把不常用的设定从静态 system 里挪出来,用到才取(lazy injection)。

## 机制

- 在 `{world_book}` 函数提供器里完成全链路:读最近 N 条消息(`chatluna_character.getMessages`)→ 拼扫描缓冲区 → 关键词扫描 → 选条 → order 排序 → token 预算裁剪 → 渲染注入。
- **蓝灯(constant)** 无条件常驻;**绿灯(selective)** 命中关键词才注入。
- 中文按子串匹配、英文默认整词、支持 `/正则/`;二级过滤 AND_ANY / AND_ALL / NOT_ANY / NOT_ALL。
- 渲染顺序:蓝灯置顶,绿灯按 order 升序(高 order 沉底、贴生成点);超预算从低优先(order 小)丢弃。
- 与 `{living_memory}`(向量召回)/`{present_people}`(在场群友)命名空间隔离,互不打架。

## 用法

1. 在预设的 `input` 块里放占位符(建议靠近 `{history_new}` 之后、贴生成点):

   ```yaml
   input: |
     ...
     {world_book}
     ...
   ```

2. 插件配置 `bookPaths` 指向世界书 json(默认 `data/chathub/character/worldbooks/审神者职业手册.koishi.json`)。

## 世界书 json 格式

```json
{
  "name": "审神者职业手册",
  "entries": [
    { "comment": "核心世界观", "constant": true, "keys": [], "content": "...", "order": 10, "enabled": true },
    { "comment": "锻刀", "constant": false, "keys": ["锻刀","锻冶"], "secondaryKeys": [], "logic": "AND_ANY", "content": "...", "order": 100, "enabled": true }
  ]
}
```

## 从酒馆世界书导入

```
node scripts/convert-st-worldbook.js <酒馆世界书.json> <输出.koishi.json> --user 主人 --char 髭切
```

自动:字段映射、`{{user}}/{{char}}` 宏替换、删除其它未知宏、剔除空分隔条与"勿开调整中"半成品、映射 selectiveLogic。

## 测试

```
node --test
```
