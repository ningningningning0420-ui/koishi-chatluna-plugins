'use strict'
const { Schema } = require('koishi')
exports.name = 'chatluna-memory-curator'
exports.inject = { required: ['chatluna', 'database', 'chatluna_living_memory'], optional: ['chatluna_character'] }
exports.Config = Schema.object({})
exports.apply = (ctx) => {}
