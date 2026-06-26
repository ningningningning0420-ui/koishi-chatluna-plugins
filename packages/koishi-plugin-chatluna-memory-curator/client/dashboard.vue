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
          <button class="np" @click="newPerson">+ 新建人</button>
          <div v-for="r in rows" :key="r.entity" class="row" :class="{ sel: cur && cur.entity === r.entity }" @click="open(r.entity)">
            <b>{{ r.aliases || '(未命名)' }}</b> · <code>{{ r.qq }}</code><br />
            <small>好感度 {{ r.favor || '—' }} · 事实 {{ r.factCount }}</small>
          </div>
          <div v-if="!rows.length" class="muted">无数据(确认已配 sharedPresetId)</div>
        </div>
        <div class="right" v-if="cur">
          <h3>{{ cur.profile['称呼'] || '(未命名)' }} <code class="qq" @click="copy(cur.qq)" title="点击复制">{{ cur.qq }}</code></h3>
          <div class="profile">
            <div v-for="k in fields" :key="k" class="pf">
              <label>{{ k }}</label>
              <input v-model="cur.profile[k]" @blur="saveProfile" :placeholder="k === '称呼' ? '多别名用、隔开' : ''" />
            </div>
          </div>
          <h4>事实({{ cur.facts.length }}) <button @click="addFact">+ 加事实</button></h4>
          <div v-for="f in cur.facts" :key="f.id" class="fact" :class="{ dead: f.status === 'superseded' }">
            <textarea v-model="f.content" @blur="saveFact(f)" rows="2"></textarea>
            <small>重要度 <input class="imp" type="number" step="0.1" min="0" max="1" v-model.number="f.importance" @blur="saveFact(f)" /> · {{ f.status }}
              <button v-if="f.status !== 'superseded'" @click="forget(f)">软删</button>
              <button v-else @click="restore(f)">恢复</button>
            </small>
          </div>
        </div>
        <div class="right muted" v-else>选择左侧一个人,或点「+ 新建人」</div>
      </div>
    </div>
  </k-layout>
</template>
<script lang="ts" setup>
import { ref, onMounted } from 'vue'
import type {} from './types'
import * as api from './api'
const fields = ['称呼', '好感度', '关键印象', '在意的事', '称呼习惯']
const s = ref({ people: 0, profiles: 0, facts: 0 })
const rows = ref<any[]>([])
const cur = ref<any>(null)
const search = ref('')
async function reload() { rows.value = await api.listEntities({ search: search.value }); s.value = await api.stats() }
async function open(entity: string) { cur.value = await api.getPerson(entity) }
function copy(t: string) { navigator.clipboard?.writeText(t) }
async function saveProfile() { if (!cur.value) return; await api.setProfile(cur.value.entity, cur.value.profile); await reload() }
async function saveFact(f: any) { await api.updateFact(f.id, f.content, f.importance) }
async function forget(f: any) { await api.forget(f.id); f.status = 'superseded' }
async function restore(f: any) { await api.restore(f.id); f.status = 'active' }
async function addFact() { if (!cur.value) return; const c = prompt('新事实内容?'); if (c) { await api.remember(cur.value.entity, c); await open(cur.value.entity); await reload() } }
async function newPerson() { const qq = prompt('QQ号?'); if (!qq) return; const name = prompt('称呼(可多别名,、隔开)?') || ''; await api.createPerson('onebot:' + qq, { '称呼': name }); await reload(); await open('onebot:' + qq) }
onMounted(reload)
</script>
<style scoped>
.mc { padding: 16px } .cards { display: flex; gap: 12px; margin-bottom: 12px }
.card { background: var(--k-card-bg); border: 1px solid var(--k-color-border); border-radius: 8px; padding: 12px 20px } .card .n { font-size: 24px; font-weight: 700 }
.body { display: flex; gap: 16px } .left { width: 320px } .right { flex: 1 }
.np { margin: 6px 0; width: 100% }
.row { padding: 8px; border-radius: 6px; cursor: pointer } .row:hover, .row.sel { background: var(--k-hover-bg) }
.pf { display: flex; align-items: center; gap: 8px; margin: 4px 0 } .pf label { width: 70px; color: var(--k-text-light) } .pf input { flex: 1 }
.fact { padding: 8px; border-bottom: 1px solid var(--k-color-border) } .fact.dead { opacity: .5 } .fact textarea { width: 100%; box-sizing: border-box } .imp { width: 60px }
.muted { color: var(--k-text-light) } .profile { margin: 8px 0 } .qq { cursor: pointer }
</style>
