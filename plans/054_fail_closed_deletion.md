# T-226: fail-closed hub history deletion

Issue: #702. Follow-up to the room-history isolation fix in [plan 053](053_room_history_isolation.md).

## Goal

Refuse room/rule deletion whenever the hub ledger cannot prove the target room is idle, and
recheck active state inside the same transaction that removes history. Preserve task, rule,
ledger rows and logs on refusal.

## Scope

- An absent database file or a proven-absent legacy `sync_jobs` table is compatible idle.
- Read/open/schema failures, busy databases, `NULL` state and unknown states refuse deletion.
- `deleteHubHistory` checks for any nonterminal state inside `BEGIN IMMEDIATE` before its first
  DELETE; the transaction rolls back on refusal.
- Room and hub-rule routes run the guarded history operation before removing task/rule
  configuration.
- Split only the cohesive read/view modules that bring touched oversized files under the fixed
  400-nonblank-line gate. Keep public exports stable and avoid dependency cycles.

## Non-goals

- No UI/API schema redesign, deployment, production data change, upload, commit or push while
  local acceptance is incomplete.
- No claim that SQLite serializes a file-based hub rule and an in-flight orchestrator for the
  whole filesystem lifecycle.

## Acceptance

- New tests fail against the unchanged implementation and pass after the fix.
- Read/open/schema failure, active/unknown/null jobs, and a late-active race preserve all room
  configuration, ledger rows and log files.
- Explicitly absent DB and legacy missing-table behavior stay compatible.
- Strict quality: file <= 400 nonblank lines, comment block <= 8, comment line <= 100, function
  <= 60 lines, nesting <= 4; no baseline waiver.
- Full `pnpm test`, typecheck, arch check, bundle, development smoke, diff check and independent
  review pass.

## Decomposition

- `hub-jobs.ts` keeps its public exports; ledger access, active-job guards, read views, queue
  projection and shared types live in separate internal modules.
- `rooms.ts` assembles read/create/update/delete handlers; the read model owns room identity and
  DTO construction. No public API or dependency-layer change is intended.
- Hub-rule creation and update share the same merged-rule validation view.

## Checklist

- [x] Fail-closed active guard: ENOENT and absent legacy table are idle; read/schema errors throw.
- [x] Writer rechecks nonterminal and `NULL` state inside `BEGIN IMMEDIATE`.
- [x] Both routes clear history before removing task/rule configuration.
- [x] Focused module split keeps public exports and avoids cycles.
- [x] Full regression 5468 passed / 42 skipped; typecheck, architecture, bundle, smoke and strict quality pass.
- [x] Review follow-up: case-variant `sync_jobs` and view rejection; coordinated lock-race test distinguishes the in-transaction recheck.
- [ ] Independent review.
