const { Schema } = require('koishi')

exports.name = 'chatluna-scene-rules'

exports.inject = ['chatluna_living_memory']

exports.Config = Schema.object({
    aliases: Schema.dict(Schema.string())
        .default({})
        .description(
            '记忆池别名映射：键 = 预设的 presetId（通常为「预设名（Character）」），值 = 共享池 key。命中映射的预设读写同一个 livingmemory 记忆池，实现多预设（如私聊版/群聊版）共享记忆'
        ),
    debug: Schema.boolean()
        .default(false)
        .description('打印每次 presetId 解析与映射结果（首次配置时用它核对键名拼写）')
})

// 记忆池别名器：运行时接管 livingmemory 服务的 createScope（主 hook，
// 召回/入库/快照/注入都经它构造记忆作用域）与 resolvePresetId（兜底旧路径），
// 在 presetId 上套一层别名映射。不修改 livingmemory 任何文件，
// 插件停用时自动还原原方法。
exports.apply = (ctx, config) => {
    const logger = ctx.logger('chatluna-scene-rules')
    const svc = ctx.chatluna_living_memory
    const mapId = (id) => {
        if (id == null) return id
        const mapped = config.aliases[id]
        if (config.debug) {
            logger.info(
                `presetId ${id}${mapped ? ` → ${mapped}` : '（未映射，原样使用）'}`
            )
        }
        return mapped ?? id
    }
    // 总闸：所有记忆 scope（召回/入库/快照/注入）都经 createScope 构造，
    // 在这里对 presetId 套别名。character 路径不走 resolvePresetId，
    // 而是直接拼 `${presetName}（Character）` 后调 createScope。
    const origScope = svc.createScope.bind(svc)
    svc.createScope = (conversationId, presetId, userId, channelId, options = {}) => {
        return origScope(conversationId, mapId(presetId), userId, channelId, options)
    }
    // 兜底：部分旧路径仍经 resolvePresetId（其结果随后也会进 createScope；
    // 已映射的值不在别名键里，不会发生二次映射）。
    const origResolve = svc.resolvePresetId.bind(svc)
    svc.resolvePresetId = (message, fallbackPresetId) => {
        return mapId(origResolve(message, fallbackPresetId))
    }
    ctx.effect(() => () => {
        svc.createScope = origScope
        svc.resolvePresetId = origResolve
    })
}
