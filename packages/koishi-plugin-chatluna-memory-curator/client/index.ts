import { Context } from '@koishijs/client'
import type {} from './types'
import Dashboard from './dashboard.vue'
export default (ctx: Context) => {
  ctx.page({ name: '记忆档案', path: '/memory-curator', icon: 'mdi:account-details', component: Dashboard, order: 480, authority: 3 })
}
