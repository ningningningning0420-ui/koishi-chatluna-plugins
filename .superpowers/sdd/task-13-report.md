# Task 13 Report: PromptProvider 注入 + 心情波动

**状态:** DONE  
**测试:** `node test.js` → 588 passed, 0 failed（+41 新测试，原有 547 全保绿）  

---

## 文件变更

### 新增
- `packages/koishi-plugin-chatluna-life-sim/inject.js` — 全部实现

### 修改
- `packages/koishi-plugin-chatluna-life-sim/test.js` — 在 `main()` 末尾追加 41 个测试

---

## 实现一览

### 纯函数（pure, no `new Date()`, offline-testable）

#### `renderRecentLife(events, n)`
- 取 `events.slice(0, n)` 逐条渲染 `"<title>（<mood>）"` 格式
- 无 mood → 不加括号；无 title → 显示 `（无标题）`
- `n=0` 或空数组 → `''`；`n` 省略 → 渲染全部

#### `renderLifeState(state)`
- 渲染 `"此刻在 <location>，<activity>。心情：<mood>。\n未了的事：<threads>"`
- location 缺失 → `"在某处"`；mood 缺失 → `"neutral"`
- `open_threads` 为空或 null → 不渲染「未了的事」一行

#### `renderTodayPlan(plan, nowMs)`
- 遍历 `plan.blocks`，渲染 `"  <block> <activity>"` 或 `"▶ <block> <activity>"`（当前块）
- 当前块判断：`block.start <= nowMs < block.end`（左闭右开，与 `currentBlock` 保持一致）
- plan 为 null 或 blocks 为空 → `''`

#### `renderPendingThoughts(thoughts)`
- 逐条渲染 `"- <content> [<urgency>]"`；urgency 缺失则省略 `[...]`
- null/空 → `''`

#### `updateMood(lifeState, event)`
- `event.mood` 非空非空白字符串 → 返回新 life-state，mood = `event.mood`（直接替换，设计 §7 说明"先轻量"）
- `event.mood` 缺失/null/空白 → 保留原 mood
- 永不 mutate 输入；无 `new Date()`；`lifeState` 为 null → throw

### DB 胶水：`createInject(ctx, config, deps)`

返回 `{ register() }`.

`register()` 逻辑：
1. 检测 `ctx.chatluna.promptRenderer.registerFunctionProvider` 是否存在；缺失则 warn + 直接返回（不 throw）
2. 为四个变量各调用 `ctx.effect(() => renderer.registerFunctionProvider(varName, async (args, vars, configurable) => { ... }))`
3. 每个 provider 内：
   - `const session = configurable?.session`
   - `const presetId = _presetIdFromSession(session)` → 优先尝试 `ctx.chatluna_living_memory.resolvePresetId(session)`，否则 fallback 到 `config.presets[0]`
   - 调用对应 dep 函数 → 调用对应 render 函数 → 返回文本
   - 任何 dep 报错 → catch + warn log + 返回 `''`（不崩 chatluna 渲染管线）

**变量名可配置：** `config.varNames.{ recentLife, lifeState, todayPlan, pendingThoughts }` 覆盖默认值 `{ recent_life, life_state, today_plan, pending_thoughts }`

---

## presetId 推导 — 设计假设与 Task 14 说明

**P1 假设（重要）：** Life-sim 插件在 `presence.js` 里已确认 P1 = 单预设，`config.presets[0]` 是唯一管理的 presetId。`registerFunctionProvider` 的 `configurable.session` 不直接携带 presetId，所以：

1. 若 `ctx.chatluna_living_memory` 存在且有 `resolvePresetId(session)`，优先用它（scene-rules 已 hook 此方法加别名）
2. 否则 fallback 到 `config.presets[0]`（P1 场景完全够用）

**若将来 P3 多预设需要精确匹配 session → presetId：** Task 14 可在 `deps.resolveTarget` 的旁路里传入更精确的解析函数，或通过 chatluna 新增的 session 属性直接读取 presetId。目前实现已预留 `deps.resolveTarget(session)` 扩展点。

---

## Task 14 需要做的事

1. **接入真实 deps：** 创建 `createShortTermMemory`, `createLifeState`, `createPlanner`, `createThoughtBuffer` 实例后，传入 `deps` 对象：
   ```js
   const deps = {
     recent: stm.recent,          // (presetId, n) → events[]
     getState: ls.getState,       // (presetId) → lifeState
     getPlan: planner.getPlan,    // (presetId, dayStr) → plan|null
     recallThoughts: tb.recall,   // (presetId, target) → thoughts[]
     todayStr: (nowMs) => toDateStr(new Date(nowMs)),  // from memory-short.js
   }
   const injector = createInject(ctx, config, deps)
   injector.register()
   ```

2. **在 roll 流程里 hook `updateMood`：** 每次 roll 产出事件后：
   ```js
   const { updateMood } = require('./inject')
   const prevState = await ls.getState(presetId)
   const newState = updateMood(prevState, rollEvent)
   await ls.setState(presetId, { mood: newState.mood })
   ```
   这样 mood 随每次 roll 事件波动，再注入对话的 `{life_state}` 时自然带上新心情。

3. **在 index.js 的 `ctx.on('ready')` 里调用 `register()`**（或在合适的 `ctx.inject` 回调里），确保 `ctx.chatluna.promptRenderer` 已可用后再注册。

---

## 测试清单（+41 tests）

```
node packages/koishi-plugin-chatluna-life-sim/test.js
```

| 分组 | 数量 |
|---|---|
| renderRecentLife | 9 |
| renderLifeState | 7 |
| renderTodayPlan | 6 |
| renderPendingThoughts | 5 |
| updateMood | 9 |
| createInject (fake-ctx glue) | 4 |
| **合计新增** | **40 + 1 = 41** |

（实际 test.js 输出统计以 pass 数为准：588 total）

---

## 偏差说明

- **Brief 说 `src/inject.ts`**：按全局约束"plain JS/CommonJS, no TS/build"改为 `inject.js`（package root，与所有其他模块一致）
- **mood 更新策略**：设计 §7 说「先轻量」，实现为直接替换（event.mood → new mood）。未做加权混合——混合公式需要量化，目前没有数值 mood，是字符串标签，直接替换最自然也最可测。Task 14 可扩展为带历史权重的衰减混合。
- **`todayStr` 在 glue 里**：provider 内部调用 `Date.now()` 取当前时间（glue 层允许，纯函数里不调）。`_todayStr` 优先用 `deps.todayStr`（可 mock），fallback 到内置 `new Date()` 路径——这是 glue 层行为，纯函数未受影响。
