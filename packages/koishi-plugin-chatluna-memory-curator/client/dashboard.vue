<template>
  <k-layout>
    <div class="mc">
      <div class="cards">
        <div class="card"><div class="n">{{ s.people }}</div><div>人</div></div>
        <div class="card"><div class="n">{{ s.profiles }}</div><div>档案</div></div>
        <div class="card"><div class="n">{{ s.facts }}</div><div>事实</div></div>
      </div>
      <div class="body">
        <div class="left">
          <input v-model="search" placeholder="搜称呼/QQ号" @input="reload" />
          <div v-for="r in rows" :key="r.entity" class="row" :class="{ sel: cur && cur.entity === r.entity }" @click="open(r.entity)">
            <b>{{ r.aliases || '(未命名)' }}</b> · <code>{{ r.qq }}</code><br />
            <small>好感度 {{ r.favor || '—' }} · 事实 {{ r.factCount }}</small>
          </div>
          <div v-if="!rows.length" class="muted">无数据(确认已配 sharedPresetId)</div>
        </div>
        <div class="right" v-if="cur">
          <h3>{{ cur.profile['称呼'] || '(未命名)' }} <code class="qq" @click="copy(cur.qq)" title="点击复制">{{ cur.qq }}</code></h3>
          <div class="profile">
            <div v-for="(v, k) in cur.profile" :key="k"><b>{{ k }}:</b> {{ v }}</div>
          </div>
          <h4>事实({{ cur.facts.length }})</h4>
          <div v-for="f in cur.facts" :key="f.id" class="fact" :class="{ dead: f.status === 'superseded' }">
            {{ f.content }}<br /><small>重要度 {{ f.importance ?? '—' }} · {{ f.status }}</small>
          </div>
        </div>
        <div class="right muted" v-else>选择左侧一个人</div>
      </div>
    </div>
  </k-layout>
</template>
<script lang="ts" setup>
import { ref, onMounted } from 'vue'
import type {} from './types'
import * as api from './api'
const s = ref({ people: 0, profiles: 0, facts: 0 })
const rows = ref<any[]>([])
const cur = ref<any>(null)
const search = ref('')
async function reload() { rows.value = await api.listEntities({ search: search.value }); s.value = await api.stats() }
async function open(entity: string) { cur.value = await api.getPerson(entity) }
function copy(t: string) { navigator.clipboard?.writeText(t) }
onMounted(reload)
</script>
<style scoped>
.mc { padding: 16px } .cards { display: flex; gap: 12px; margin-bottom: 12px }
.card { background: var(--k-card-bg); border: 1px solid var(--k-color-border); border-radius: 8px; padding: 12px 20px } .card .n { font-size: 24px; font-weight: 700 }
.body { display: flex; gap: 16px } .left { width: 320px } .right { flex: 1 }
.row { padding: 8px; border-radius: 6px; cursor: pointer } .row:hover, .row.sel { background: var(--k-hover-bg) }
.fact { padding: 8px; border-bottom: 1px solid var(--k-color-border) } .fact.dead { opacity: .5; text-decoration: line-through }
.muted { color: var(--k-text-light) } .profile { margin: 8px 0 } .qq { cursor: pointer }
</style>
