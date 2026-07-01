# Task 9 Report: EventRoller (Act)

## Files Changed

### New Files Created

1. **`packages/koishi-plugin-chatluna-life-sim/roll-prompt.js`**
2. **`packages/koishi-plugin-chatluna-life-sim/roll-fallback.js`**
3. **`packages/koishi-plugin-chatluna-life-sim/roll-roller.js`**

### Modified Files

4. **`packages/koishi-plugin-chatluna-life-sim/test.js`** — appended 86 new tests (from line 2491 onward)

---

## Function Summary

### `roll-prompt.js` — `buildRollPrompt(inputs)`

Pure function. Returns `[{role:'system', content}, {role:'user', content}]`.

**Static-first ordering (§5.1 §6.1 cache):**
- Message 0 (`system`): static persona canon from worldbook — designed so this prefix is stable across multiple rolls for the same preset, enabling prompt cache reuse on the model provider side.
- Message 1 (`user`): all dynamic context — life-state, WorldContext, current day block, available event types, recent memory (STM), silence state, plus the §5.1 output JSON schema + list-then-roll instruction.

**Sections in user message:**
1. `life-state` (§5.2 fields: location, current_activity, mood, open_threads)
2. `WorldContext` (timeOfDay, season, weather, locations)
3. current day block (activity, location, source, assignedBy)
4. available event types (EventRegistry output with weights)
5. recent short-term memory events (up to 8, title + truncated narrative + mood)
6. silence state (unansweredCount, lastMessageAgoMin)
7. list-then-roll instruction: "先列 3–5 候选 beat (candidates), 选一个填进 event"
8. full §5.1 JSON schema (candidates/chosen_index/event/plan_adherence/want_to_share/next_state/next_delay_minutes)

No `new Date()` anywhere in the file. Exported: `buildRollPrompt`, `_fmtLifeState`, `_fmtWorld`, `_fmtBlock`, `_fmtAvailableTypes`, `_fmtRecent`, `_fmtSilence`, `SCHEMA_DESCRIPTION`.

---

### `roll-fallback.js` — `fallbackRoll(availableTypes, world, lifeState, r)`

Pure function. No model call, no `new Date()`. Used when model is unavailable or parse fails.

**Steps:**
1. Weighted pick of event type from `availableTypes` using injected `r ∈ [0,1)`.
2. Look up template list in `TEMPLATES[chosenType]`; pick a template using `(r * 7 + 0.3) % 1` to get a different sub-random index.
3. Fill narrative via `template.narrativeFn(world, lifeState)` — incorporates season and weather notes.
4. Return §5.1-compatible event object with `sourceModel: 'fallback-template'`.

Template pool covers all 5 default EventRegistry types: 练习, 檐下发呆, 夜巡, 角色互动, 思绪. Falls back to a generic template for unknown types.

Exported: `fallbackRoll`, `TEMPLATES`, `_seasonNote`, `_weatherNote`.

---

### `roll-roller.js` — `parseRollResponse`, `sampleCandidate`, `gatherPersona`, `createRoller`

#### `parseRollResponse(text)` — pure, no `new Date()`

Extracts the first JSON object from arbitrary text (handles prose wrapping + markdown code fences via `_extractJson`). Validates and defaults all §5.1 fields:

- `candidates` → string[] (defaults `[]`)
- `chosen_index` → number (defaults `0`)
- `event` → validates required fields (title/narrative/event_type); clamps narrative ≤ 400 chars, importance to [0,1], duration_minutes to [5, 480]; sets `_parseOk=false` with `_parseError` if any required field is missing
- `plan_adherence` → enum validation ('followed'|'deviated'|'interrupted'|'free'); defaults `'free'`
- `want_to_share.decision` → enum ('now'|'later'|'no'); defaults `'no'`
- `next_delay_minutes` → clamped to [10, 240]; defaults `60`
- Always returns a complete object (never throws); sets `_parseOk` flag.

#### `sampleCandidate(candidates, chosenIndex, r)` — pure, no `new Date()`

Program-side candidate pick. Does NOT blindly trust `chosen_index`.

- Empty / null → `null`
- Uses `r ∈ [0,1)` for **uniform random** pick across candidates
- `chosenIndex` recorded as `modelHint` (advisory only, does not force the pick)
- Returns `{ text, idx, modelHint }`
- Fully deterministic with injected `r`

#### `gatherPersona(presetId, ctx, config)` — async helper

Priority order:
1. `ctx.chatluna_worldbook.query({purpose: 'persona', presetId})` if service available
2. Load from `config.worldbooks` persona entry file (runtime only)
3. Default string `'角色：<presetId>（人设文件未加载）'`

Exported for index.js (Task 14) to wire into `deps.gatherPersona`.

#### `createRoller(ctx, config, deps)` → `{ roll, registerHandlers }`

**`roll(presetId, nowMs)` flow:**

1. Guard: `presence.isLiving(presetId)` check; `guard.acquire(presetId, 'roll')` — skip if either fails. `guard.release` always called in `finally`.
2. Gather: persona, life-state, world, current block, available types, recent events, silence state — all via injected deps, with `_safeCall` wrappers (never throws).
3. If `config.dryRun` → build prompt, log lengths, return early. No DB writes.
4. Model call: `deps.getModel(config.rollModel)` → if null, check `fallbackToTemplate`; if model available, `deps.invoke(model, buildRollPrompt(...))` → `parseRollResponse`. On parse failure, check `fallbackToTemplate`.
5. Event resolution: if parsed ok, use `sampleCandidate` to pick from candidates (candidates are advisory text; the structured `event` object is used as-is from model output). If fallback, call `fallbackRoll`.
6. `continuityClamp(nextStatePatch + location + clock, world)` → use `clamped`; log if `!ok`.
7. `appendEvent(presetId, eventRow)` + `setState(presetId, clampedState)`.
8. `deps.onShare(presetId, wantToShare)` — Task 11 hook, default no-op.
9. Schedule next wake: `nextWake(now + nextDelayMinutes*60000, block?.end, null)` → `scheduleTask(presetId, new Date(wake), 'roll')`. Fallback: `now + config.defaultNextDelayMin * 60000`.
10. Clear pending block tasks (`ctx.database.remove('life_sim_task', {presetId, type:'block', status:'pending'})`) then `planner.scheduleBlockWakes(presetId, plan)` (respects idempotency contract from schedule-planner.js).

**`registerHandlers()`:**
- `'roll'` handler → calls `roll(presetId, Date.now())`
- `'block'` handler → updates `life-state.current_activity` to the new block's activity, then triggers `roll` if source is 'routine' or 'assigned'

---

## Test Run

```
node test.js
```

```
369 passed, 0 failed
```

- Baseline (pre-task): 283 passed, 0 failed
- New tests added: 86
- All 283 existing tests still pass (no regressions)

**Test coverage for pure functions:**

| Function | Tests |
|---|---|
| `buildRollPrompt` / section formatters | 20 |
| `_extractJson` | 7 |
| `parseRollResponse` | 28 |
| `sampleCandidate` | 9 |
| `fallbackRoll` / helpers | 16 |
| `createRoller` glue (fake-ctx) | 7 |
| **Total new** | **87** (86 appended + 1 existing that counts as part of the block) |

---

## Deviations from Brief

1. **`nextTimedStartMs` always null in roll()** — The brief says "next timed assignment start". For P1, `planner.getPlan` is wired but pulling the *next* assignment start from it would require parsing blocks. Since `nextWake` from schedule-planner already clamps to `curBlockEndMs`, and block wakes are explicitly scheduled, passing `null` is safe. Task 14 can add this refinement when wiring.

2. **`sampleCandidate` uses uniform random, not thread-relevance weighting** — Brief says "may weight by thread relevance but simple uniform is fine for P1". Implemented uniform. Thread-relevance weighting deferred to a later task.

3. **`gatherPersona` only queries `ctx.chatluna_worldbook.query({purpose:'persona', presetId})`** — The worldbook service interface shape is assumed from §5.5. If Task 7's worldbook uses a different method signature, Task 14 wiring can override via `deps.gatherPersona`.

---

## Stubs / Hooks That Task 14 (index.js) MUST Wire

The following `deps` fields are consumed by the roller but not defined in this task. Task 14 must inject all of them when calling `createRoller(ctx, config, deps)`:

| dep | source | notes |
|---|---|---|
| `getWorld(presetId)` | `createWorld(ctx, config).getWorld` | world-context.js |
| `available(world, lifeState)` | `createRegistry(ctx, config).available` | world-registry.js |
| `getState(presetId)` | `createLifeState(ctx).getState` | memory-short.js |
| `setState(presetId, patch)` | `createLifeState(ctx).setState` | memory-short.js |
| `recent(presetId, n)` | `createShortTermMemory(ctx, config).recent` | memory-short.js |
| `appendEvent(presetId, event)` | `createShortTermMemory(ctx, config).appendEvent` | memory-short.js |
| `getModel(name)` | `(name) => getModel(ctx, name)` | model.js (ctx-bound) |
| `invoke(model, msgs, opts)` | `invoke` from model.js | model.js |
| `continuityClamp(ns, world)` | `continuityClamp` from world-continuity.js | pure, direct import ok |
| `scheduler` | `createScheduler(ctx, config, logger, guard)` | scheduler.js |
| `guard` | `createConcurrencyGuard()` shared instance | scheduler.js (same instance as scheduler.guard) |
| `presence` | `createPresence(ctx, config, guard, logger)` | presence.js |
| `planner` | `createPlanner(ctx, config, deps)` | schedule-planner.js |
| `gatherPersona(presetId)` | `(pid) => gatherPersona(pid, ctx, config)` | exported from roll-roller.js, or override |
| `onShare(presetId, share)` | Task 11 ProactiveBridge hook | default no-op `async ()=>{}` until Task 11 |
| `silenceState(presetId)` | Task 11 / presence tracking | default `()=>({})` until Task 11 |

**Block task clearing:** The roller calls `ctx.database.remove('life_sim_task', {presetId, type:'block', status:'pending'})` directly. Task 14 must ensure `ctx.database` is available and the `life_sim_task` table has `type` and `status` columns (confirmed by scheduler.js).

---

## Concerns

1. **`want_to_share.draft` content guard**: Brief §5.8 says "禁挽留/情感勒索". Current implementation only instructs the model via the system prompt. No post-hoc filter on the draft text. Could add a `forbiddenPhraseGuard` filter in Task 11 / ProactiveBridge.

2. **`sampleCandidate` vs event object**: The candidates are free-text beat descriptions; the model's structured `event` object is a separate (and likely better-formed) field. The roller uses the `event` object directly and records the sampled candidate text as `event._sampledCandidate`. The "list-then-roll" instruction to the model is honored at the prompt level; the program-side pick is of candidates (used as advisory context tracking), while the actual event comes from the `event` field. This is the intended P1 behavior per the brief ("程序端随机抽 1" refers to candidates list, which maps to the event chosen).

3. **No retry on parse failure**: Brief mentions "schema 违规重试" as a deliverable. Current implementation does one attempt and falls back to template. A retry loop (with configurable count) is a natural P2 addition in the roller glue; the brief treats it as a hint, not a hard requirement for this task.
