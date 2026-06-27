# Fix 7 Report: Reconciler settle/verify step

## Changes

### Fix 1: Reconciler settle/verify step (`packages/orchestrator/src/reconciler.ts`)

**New additions to `ReconcilerDeps`:**
- `settle?: SettleConfig` — `{ maxWaitMs: number; pollMs: number }` defaults to `{ maxWaitMs: 600_000, pollMs: 15_000 }`
- `sleep?: (ms: number) => Promise<void>` — injectable for tests, defaults to real `setTimeout`-based sleep

**Settle loop design (`settleAll` private method):**
1. Collects unique `(tenantId, roomSlug)` pairs from all broadcast members into a `pending` Set.
2. Loops until `pending` is empty OR `Date.now() >= deadline`.
3. Each iteration checks all pending members round-robin:
   - Transport missing or `isDone` not a function → treat as done (remove from pending)
   - `isDone(roomSlug)` returns `true` → remove from pending
   - `isDone(roomSlug)` throws → count as "not done" this round, loop continues
4. After all done or timeout: if anything remains in `pending`, emits `console.warn` listing `tenantId/roomSlug` pairs still recording.
5. Always proceeds with the captured inventory (no re-list after settling).

`reconcileAll` now calls `settleAll(broadcasts)` between step 2 (cluster) and step 3 (pipeline loop).

### Fix 2: CLI settle defaults (`packages/cli/src/cli.ts`)

- `hubCfg.settleMs ?? 10_000` → `hubCfg.settleMs ?? 90_000`
- Added `maxWaitSec` and `settleSec` fields to `hubCfg` type
- When either is present, passes `settle: { maxWaitMs, pollMs }` to `Reconciler` constructor; otherwise uses reconciler defaults (600s/15s)

### Fix 3: Tests (`packages/orchestrator/src/reconciler.test.ts`)

**Updated existing tests:** Changed `isDone` in `makeTransport` from `mockResolvedValue(false)` to `mockResolvedValue(true)` and added `settle: fastSettle, sleep: fastSleep` to all three existing tests to prevent hanging with real settle defaults.

**New test 1 — "isDone eventually returns true":**
- `isDone` returns `false` for first 2 calls, `true` on 3rd call
- Uses `maxWaitMs: 100, pollMs: 1` + zero-ms `fastSleep`
- Asserts `isDone` called 3 times AND `runPipeline` called exactly once

**New test 2 — "isDone stays false past maxWait":**
- `isDone` always returns `false`
- Uses `maxWaitMs: 50, pollMs: 1` + zero-ms `fastSleep`
- Asserts no hang, no throw (`resolves.toBeUndefined()`), `runPipeline` called once, and `console.warn` called with tenant name `"node-slow"` in the message

## Verification results

```
pnpm test -- reconciler    → 5 tests passed (reconciler.test.ts)
pnpm test                  → 352 tests passed, 51 test files (0 failures)
pnpm typecheck             → exit 0 (no errors)
pnpm bundle                → dist/douyin-rec.mjs 2.7mb, dist/tui.mjs 11.1kb (done in ~95ms)
```
