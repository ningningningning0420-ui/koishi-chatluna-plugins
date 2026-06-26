# koishi-plugin-chatluna-memory-curator
给 chatluna-character 角色按人组织、可调可修的人格化记忆(livingmemory 伴生层)。
不改 livingmemory 源码、停用即还原。设计见 DESIGN.md。

## 依赖
chatluna ^1.4.0-alpha.23 / chatluna-character / chatluna-livingmemory / database。
建议:关 livingmemory 的 enableSnapshotInjection,改用本插件按需召回。

## 工具(模型自主调用)
get_profile / set_profile(档案,按人) · recall / remember / forget(事实)。

## 预设接入
runtime 变量区加 {present_people}(自动浮出在场者档案+群规模头)。
记忆准则、字段模板、工具说明全部在控制台配置页可改。

## 不在 koishi.yml 启用即完全不生效、零影响。

## livingmemory 侧配置(控制台手动,零代码)
在 koishi 控制台把 `chatluna-livingmemory` 的 `enableSnapshotInjection` 关掉(改为按需走本插件工具 + `{present_people}`);
确认 group-analysis(若装)`personaAnalysisMessageInterval=0`、只留 `group_message_fetch`。

## 终验收清单(对照 DESIGN §2 目标)

- [ ] 可调可修:髭切能 set_profile / remember / forget,改动落库且下次召回可见。
- [ ] 按人精确:recall(entity) 只回该人;自动事实经 sweep 也按人可召回。
- [ ] 常态低占用:enableSnapshotInjection 关后,平时上下文无记忆;仅在场者小档案浮出。
- [ ] 数量不冲垮:某人几十条事实时 recall 仍只回 topK;在场者不超 cap。
- [ ] 群规模可感:`{present_people}` 头显示群人数/活跃数/认识数。
- [ ] 人设驱动:改 profileFields / memoryCriteriaPrompt / toolDescriptions 后行为随之变。
- [ ] 停用零影响:停用插件 → livingmemory 回原样,3 列残留但无害。
- [ ] 可视化:livingmemory WebUI 能看到带 entity/memKind 的记忆行。
