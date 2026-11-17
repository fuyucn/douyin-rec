# T-225: room history deletion isolation

Issue: #701. Parent task: S1 of the independent system-stability repair plan.

## Goal

Only the literal target room identity may be removed by a room-history deletion.
Preserve other rooms, platforms, cases, checkpoints and job logs.

## Architecture

Move the existing first-dot room-key conversion to a pure core contract. Share a case-sensitive
SQL prefix predicate based on substr and literal equality, binding the prefix twice.
Use it for ledger discovery, all six history-table DELETEs, the active-job guard and the room job list. Keep the orchestrator export,
immediate transaction, busy timeout, legacy missing tables and both log locations compatible.

## Global constraints

- English source/comments, no new dependency, schema migration or feature flag.
- No production data deletion, recording interruption, deployment, merge or remote source push.
- Tests are authored independently and must fail on unchanged source before repair.
- Full tests, types, architecture, generated bundle and independent code review before acceptance.
- Default strict quality gate applies to hand-authored source/tests; no baseline waiver.
- S2 separately addresses read-guard failure and active-writer recheck; they are not claimed fixed here.

## Checklist

- [x] Independent regression FAIL evidence: 7 failed / 7 passed on unchanged source.
- [x] Shared literal predicate in discovery and every DELETE; original public export compatible.
- [x] Compatibility and rollback regressions PASS; all 15 new tests pass.
- [x] Full regression 5449 passed / 42 skipped; typecheck, architecture and bundle PASS.
- [x] Strict quality and independent Standards/Spec source review PASS.
- [x] Scoped development smoke PASS: matching version, API 200, zero tasks, graceful exit 0.

Local code acceptance only (2026-11-15): uncommitted branch, generated version 0.0.390-4fc287.
No PR, merge, deployment or production acceptance. The worktree remains unfinished for delivery.

TODO.md entry T-225 is the local implementation ledger. This plan is not a production acceptance
certificate: current fleet uptime and short synthetic tests do not certify sustained new behavior.
