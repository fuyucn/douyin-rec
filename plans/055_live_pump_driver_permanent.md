# T-223: make the streamed-upload driver permanent

## Goal

Retire only `DREC_LIVE_PUMP_DRIVER` after compatibility and stability acceptance.
Tasks must still explicitly select streamed upload. Keep account limits, private visibility,
watermark policy, spool safety, task settings and deployment guards unchanged.
Tracked by [T-223](../TODO.md) and issue #676; contract: [plan 049](049_upload_target_contract.md).

## Architecture

The CLI selects the recording mode and assembles a default PartSubmitter. LivePumpSession owns
the durable recording state and pending intent. The driver owns retry/account accounting and
metadata publication; it must never retransmit bytes already uploaded by the pump.
The submitter checkpoint seeds only confirmed parts from the pump state.

## Global constraints

- Work in the existing T-223 worktree. Preserve unrelated inherited changes.
- This stage is local implementation: no commit, push, merge, deployment or production mutation.
- No production recording may be stopped. Future real-upload segments must be at least 120s.
- Keep recovery/error tests; replace redundant tests instead of hiding them with skips/exclusions.
- Strict production-source gate: <=400 nonblank lines/file, <=60 lines/function, nesting <=4,
  comment blocks <=8 lines, comment lines <=100 characters. Existing debt is not exempt.
- Keep unfinished worktrees. Remove a worktree only after it is completed, merged and clean.

## Sequential work and acceptance

1. [x] **Preserve legacy archive identity and checkpoint numbering (local, 2026-11-15).**
   - Reproduce aid-only state with confirmed P1, no pending request, then append P2.
   - Resolve aid by a read-only lookup, require matching aid and nonempty BV, persist before
     the driver reads the checkpoint. Never create a replacement archive on lookup failure.
   - Refuse mismatched pending recovery before confirming a stem or cleaning spool.
   - Cancellation must interrupt the lookup without trying the fallback endpoint.
   - Keep state/spool on refusal; persistence failure must latch untrusted state.
   - Acceptance: targeted red/green regression, full suite, typecheck, bundle and independent review.
2. [x] **Separate command registration, recording policy and execution lifecycle (local).**
   - [x] Extract streamed-upload setup, media, spool protection and lifecycle, shared record options,
     and manual harness registration (local, 2026-11-15).
   - [x] Replace the cross-block source regex with executable off/on entry tests: disabled upload
     never constructs/starts a pump; enabled upload and manual harness supply the real submitter.
   - [x] Preserve drain, abort, node handoff, metadata, accounting and result output behavior.
     Independent review findings were addressed and the relevant mutations were rejected.
   - [x] Extract ordinary record registration, setup, rolling ownership, remux and signal lifecycle.
     Preserve parsing order, state initialization and the shared notification/parent alert policy.
   - [x] Extract the remaining upload, diagnostic, media and node command registration.
     Scoped Spec and Standards reviews pass (local, 2026-11-16).
   - [x] Separate UPOS transfer, archive lookup and Studio publication without changing exports.
     Local checks, mutations and independent reviews pass (local, 2026-11-16).
   - [x] Decompose touched oversized pump/control-plane modules by durable state, recovery and
     submission responsibilities as required; do not introduce artificial wrappers to meet limits.
     - [x] Separate durable state, queue confirmations and spool retention; preserve public exports
       and fsync-before-cleanup behavior (local, 2026-11-16).
     - [x] Separate season association, serialized background work and restart reconciliation;
       preserve session-owned checkpoint writes and non-blocking part publication (local, 2026-11-16).
     - [x] Separate driver-backed metadata mapping and failure classification; preserve
       session-owned WAL/confirmation ordering and reduce redundant tests (local, 2026-11-16).
     - [x] Separate legacy metadata publication/retry and shared abortable waiting; preserve
       current-checkpoint reads, accounting and session-owned writes (local, 2026-11-16).
     - [x] Separate local-spool inspection and whole-file recovery transfer; preserve concurrent
       rows, hold-rename rollback and session-owned publication (local, 2026-11-16).
     - [x] Separate interrupted-publication lookup/classification; preserve the fresh identity
       check, session-owned merging and persistence-before-cleanup (local, 2026-11-16).
     - [x] Separate the per-part byte-transfer lifecycle, bounded buffering and spool writes;
       retain its existing interface, tail ordering and independent truncation reporting
       (local, 2026-11-16).
     - [x] Separate run-owned part delivery, ordered finalization and connection resources;
       preserve durable write ordering, stop budgets and late-completion fencing.
       The consolidated run-owned structure passes local regression and strict gates.
       Frozen-batch Spec and Standards reviews found no actionable issues; live acceptance remains open.
   - Acceptance: all touched production files satisfy the strict structure gate and regression suite.
3. [x] **Validate the exact local candidate and obtain independent review.**
   - Run full tests, typecheck, architecture check, bundle and isolated loopback HTTP smoke.
   - Review Standards and Spec independently. Record unresolved findings, not a blanket approval.
   - Current local candidate is 0.0.390, exactly one patch above verified remote main 0.0.389.
     Other local drafts do not reserve a release version. Recheck main immediately before commit;
     if another candidate lands first, rebase, bump, rebuild and repeat exact-artifact acceptance.
4. [~] **Accept stability before permanence.**
   - Current-bundle canary with >=120s segments: default create, append, restart, pending recovery,
     bounded throttling, queue takeover and safe stop, with no duplicate draft or lost confirmed part.
   - 2026-11-17 retry on room 252165330607 completed create/append/restart plus pending queue
     takeover/publication and direct recovery over six real 182s parts. Direct recovery's cleanup
     order is supported by inotify state-rename-before-unlink and final confirmed state; the strict
     synchronous hook missed it because cleanup uses `rmSync`, not the wrapped `unlinkSync`.
     Real server throttling was not deliberately provoked. Both gaps are recorded, not waived.
   - Require per-node idle guards and authorized validation/deployment scope before any live action.
   - Record exact bundle/version and observed outcomes; synthetic tests do not replace this stage.

## Evidence and unresolved gates

- Local source-snapshot locators (E identifiers) and full SHA-256 fingerprints (D identifiers)
  are retained in /tmp/drec-t223-readiness-evidence.log. These aliases keep transient file
  references and raw numeric-looking fingerprints out of the publishable plan without losing
  the local audit trail; verification commands and outcomes remain below.

- Historical 0.0.388 driver-on canary confirmed two roughly 180s parts and queue takeover. This
  is historical evidence only, not current 0.0.390 stability acceptance. Earlier shorter stress
  experiments in plan 049 are historical and must not be repeated.
- Prior draft full run: 361 passed files, 1 skipped; 5417 passed tests, 42 existing skips.
  The separate deletion/pruning branch has a different test count and is not merged here.
- Aid-only regressions: six failures reproduced before the fix, including wrong identity
  recovery and cancellation timeout. Seven recovery cases now pass; the seventh covers failed
  identity persistence and the latched untrusted state. Existing submitter tests also pass (15 total).
- Post-fix full suite: 362 passed files, 1 skipped; 5424 passed tests, 42 existing skips, 140.40s.
  Log: `/tmp/drec-t223-aid-final.log`. After review, existing refusal assertions were strengthened
  to require `needsManual: true`; all 15 focused tests and typecheck passed again. No new skips.
- Typecheck, architecture consistency, bundle and `git diff --check` pass. The isolated
  `0.0.390-4fc287` bundle returned HTTP 200 for frontend, version, rooms and tasks, with fresh
  empty state. Its owned process exited 0 and its temporary data was removed; no production action.
- Independent Spec and Standards reviews found no new blocking issue in the identity repair.
  The suggested manual-recovery assertion was adopted without increasing test count.
- Existing `recover()` does not accept a caller signal. Only the newly added identity lookup
  is cancellable; this work does not claim that the whole recovery chain is interruptible.
- The weak cross-block CLI regex has been replaced by 14 executable entry tests and a narrow
  AST registration guard. These replace 14 static/prose checks without changing total test count.
  The tests cover off/on selection, real default submitter execution, manual publication opt-in,
  credentials, metadata, signals, receipts, queue ownership, clock/owner latching and safe sweeping.
- Post-extraction full suite: 361 passed files, 1 skipped; 5424 passed tests, 42 existing skips,
  100.57s. Log: /tmp/drec-t223-entry-final.log. No new skips or discovery exclusions.
- Four targeted mutations were rejected: bypassed mode gate, drain wired to hard stop, relatching
  the broadcast clock on reconnect, and missing managed failure reporting. Each selected regression
  failed; source was restored byte-for-byte. Log: /tmp/drec-t223-entry-mutations.log.
- Independent Spec review's clock/owner coverage gap was closed by the offline/live/reconnect
  regression and mutation. Standards review's managed error-path gap was closed in the existing
  exception case; manual documentation now correctly distinguishes UPOS byte upload from publication.
- Post-extraction typecheck, architecture check, bundle and diff whitespace check pass. Bundle:
  0.0.390-4fc287, SHA-256 D01.
  The exact bundle passed isolated loopback smoke: frontend, version, rooms and tasks returned
  HTTP 200 with empty state. Its owned process exited 0 and only its temporary data was removed.
  This is an uncommitted local candidate, not a deployed version or stability-accepted artifact.
- Strict structure gate still fails overall. The seven extracted modules pass: at most 146 nonblank
  lines, 42 lines/function, nesting 4. CLI fell from 1553 to 991 nonblank lines and its longest
  function from 677 to 239, but still exceeds limits and reaches nesting 7. The pump remains at
  4962 nonblank lines and the control-plane module at 774; overall max function 1561, nesting 10.
  Gate log: /tmp/drec-t223-entry-structure.log. Next slice: remaining CLI policy/lifecycle/registration.
- No acceptance, merge readiness, production rollout or worktree cleanup is claimed.

## Ordinary recording checkpoint (2026-11-15)

- Extracted ordinary record registration, policy, upload ownership, remux and signal handling.
  Shared notifier filtering now lives in one module; recording retains its independent parent alert.
- Eight Commander execution cases replace eight static checks: six parser source checks plus the
  admission and rolling-owner source checks. Existing real-bundle flag cases remain. No extra
  skips or exclusions; this worktree's total remains 5466 cases, separate from the pruning branch.
- Independent Spec review identified missing invalid-stream preflight evidence; the explicit
  invalid-stream case now proves no platform, engine, upload-hook or state work begins.
  Standards review's duplicate notifier finding was fixed, and the existing alert case now verifies
  that disabling webhooks does not suppress the parent channel. Both reviews closed their findings.
- Full suite: 362 passed files, 1 skipped; 5424 passed tests, 42 existing skips, 98.07s.
  Log: /tmp/drec-t223-record-final.log. Typecheck, architecture check and bundle also pass.
- Six targeted mutations were rejected: lost stream short-circuit, omitted inline admission config,
  missing hub ownership, skipped queue close, platform work before stream validation, and bypassed
  notification filtering. Each source was restored byte-for-byte. One initial parameterized selector
  matched no test; it was corrected and rerun with the expected assertion failure, not counted as
  evidence on the first attempt. Log: /tmp/drec-t223-record-mutations.log.
- Current bundle: 0.0.390-4fc287, SHA-256
  D02.
  After mutation restoration, all eight entry cases passed again. The exact bundle returned
  HTTP 200 for frontend, version, rooms and tasks with fresh empty state; its isolated process
  exited 0, and only its owned temporary data was removed. Diff whitespace checks pass.
  This remains a local, uncommitted artifact, not a deployed or stability-accepted version.
- All seven newly extracted production modules pass the strict structure limits. CLI decreased
  from 991 to 677 nonblank lines and its longest function from 239 to 60 lines, but nesting 7 and
  the file limit still fail. The oversized pump and control-plane modules are unchanged this round.
  Overall structure gate remains FAIL: /tmp/drec-t223-record-structure.log.
- Next: finish the remaining command registrations, then the pump/control-plane decomposition
  before current-bundle live stability acceptance. No production state or deployment was changed.

## Remaining CLI checkpoint (2026-11-16)

- Extracted upload, UPOS upload, merge, burn, diagnostics, service assembly and node registration.
  The CLI now owns only registration, global options, timezone initialization and error reporting.
  An AST comparison of all 24 moved commands found identical arguments, options, defaults,
  descriptions and help text. The original timezone subprocess regressions remain unchanged.
- Eleven executable upload/media cases replace two upload source-string guards. These cover
  quota scope, private defaults, bounded throttling, preflight/refusal, chunk slicing, naming,
  integrity scans, rendering and failure propagation. Net increase: nine important behavior cases,
  not additional static checks. No new skips or exclusions; pruning-branch totals remain separate.
- Full suite: 364 passed files, 1 skipped; 5433 passed tests, 42 existing skips, 100.08s.
  Log: /tmp/drec-t223-cli-full.log. Typecheck, architecture check, bundle and diff checks pass.
- Exact local bundle: 0.0.390-4fc287, SHA-256
  D03.
  Frontend, version, rooms and tasks returned HTTP 200 in a fresh isolated loopback instance;
  rooms/tasks were empty, its owned process exited 0, and only its temporary data was removed.
- This slice passes the strict source structure limits: CLI has 59 nonblank lines, longest
  function 6 lines and nesting 2; extracted modules have at most 141 nonblank lines, 44 lines
  per function and nesting 4. Overall gate still fails only in the touched live-pump and
  upos-stream modules. Log: /tmp/drec-t223-cli-structure.log.
- Five targeted mutations were rejected: bypassed UPOS quota, changed private default, shortened
  retry budget, omitted merge tail scan and swallowed burn failure. Each selected regression
  failed by assertion and the source was restored byte-for-byte. All eleven upload/media cases
  passed again after restoration. Logs: /tmp/drec-t223-cli-mutations.log and
  /tmp/drec-t223-cli-restored.log.
- The initial independent reviews returned no result and were interrupted, not counted as passes.
  Fresh scoped Spec and Standards reviews both completed with zero findings for this slice and
  the following UPOS extraction. They do not approve overall T-223 or live stability acceptance.
- Next: decompose the remaining oversized pump module before
  current-bundle real stability acceptance. No commit, deployment or production mutation.

## UPOS responsibility split checkpoint (2026-11-16)

- Kept the existing public exports and the single UposRateLimited class in upos-stream.ts.
  Transfer stays there; shared cookie/deadline handling lives in upos-http.ts, archive lookup
  and title recovery in studio-archive.ts, and publication/append in studio-submit.ts.
  No downstream import or package dependency changed.
- Compared against E01: all 32 unmodified declarations and the
  complete Studio payload match by AST. Only payload construction, append mapping and one-chunk
  transmission were factored. Cancellation, short-tail byte counts, private/watermark policy,
  existing part order, server filename selection and failure reporting retain their behavior.
- Self-review found that the existing Studio payload regression supplied private=true explicitly.
  It now omits that argument and still requires private visibility, covering the actual default
  without adding another case. This slice adds no test cases, skips or exclusions.
- Focused suite: 5 files, 301 tests passed. Final full suite after strengthening that assertion:
  364 passed files, 1 existing skipped file; 5433 passed tests, 42 existing skips; 102.03s.
  Logs: /tmp/drec-t223-upos-focused.log and /tmp/drec-t223-upos-final.log.
- Five mutations were killed by assertion failures: public-by-default payload, dropped earlier
  parts, incorrect short-tail total, ignored server completion key, and stale PUT failure status.
  The isolated source snapshot first passed all 25 protocol tests. Each mutant was restored
  byte-for-byte; workspace source hashes stayed unchanged and the owned snapshot was removed.
  Log: /tmp/drec-t223-upos-mutations.log.
- Typecheck, architecture check, bundle, diff check and isolated HTTP smoke pass. Current local
  bundle is 0.0.390-4fc287, SHA-256
  D04.
  Frontend, version, rooms and tasks returned HTTP 200 with fresh empty state; the owned process
  exited 0 and its temporary data was removed. Logs: /tmp/drec-t223-upos-types-final.log,
  /tmp/drec-t223-upos-arch.log, /tmp/drec-t223-upos-bundle-final.log and
  /tmp/drec-t223-upos-smoke-final.log.
- All four UPOS sources pass strict structure limits: 287/27/198/135 nonblank lines respectively,
  maximum function 53 lines and nesting 4. Overall changed-source structure still fails only in
  live-pump.ts (4962 nonblank lines, maximum function 1561 lines, nesting 10).
  Logs: /tmp/drec-t223-upos-parity.log and /tmp/drec-t223-upos-structure.log.
- Independent Spec review (remaining_cli_upos_spec_final): zero findings. It independently
  verified all 24 command manifests and the unchanged bodies of 16/19 UPOS functions, then
  manually checked the three factored functions, cancellation, private policy and part retention.
- Independent Standards review (remaining_cli_upos_standards_final): zero documented-standard
  violations and zero actionable smell findings. It checked responsibility separation, stable
  exports, quota ownership and executable tests. Both reviews read the pinned baselines and actual
  current files; neither reran full tests. Parent owns the verification logs above.
- This closes only the local CLI/UPOS slices. No commit, push, merge, deployment, production
  action or live stability acceptance is claimed. Earlier review attempts without results are
  not treated as approvals.

## Remaining pump decomposition order

1. **Durable state, confirmation journal and spool retention.** Separate state schema/read/write,
   queue confirmation records, and rollover/retention policy. Preserve torn-tail handling, fsync
   before cleanup, session identity isolation, unknown-state fail-closed behavior and legacy paths.
   Keep the existing public exports so current recovery/queue tests exercise the same interface.
2. **Archive session and recovery.** Separate confirmed-part bookkeeping from remote submission
   and interrupted-request recovery. Keep one state writer and preserve pending-before-submit,
   confirmed-before-cleanup ordering, aid-only recovery, retry limits and season checkpoints.
3. **Per-part transfer and stream capture.** Separate the bounded queue/PartSink lifecycle from
   ffmpeg capture and part finalization. Preserve backpressure, spool degradation, DTS validation,
   contiguous part order and stop-time outcomes. Do not add speculative transport abstractions.
4. **Run coordination.** Reduce runLivePump by separating acquisition, connection lifecycle,
   deferred queue delivery, alert accounting and shutdown. Preserve reconnect/drain/hard-stop
   differences and prevent either byte retransmission or duplicate metadata publication.

For each slice: use a pinned pre-slice source snapshot, retain existing behavioral tests, run the
strict structure check on extracted files, and obtain scoped independent review. Repeat full
regression/build/smoke for the finished candidate. Current-bundle live canary remains a later,
separately authorized acceptance step; synthetic success does not satisfy it.

## State, journal and spool checkpoint (2026-11-16)

- Extracted live-pump-state.ts, live-pump-confirmations.ts and live-pump-spool-policy.ts.
  The recorder still owns state writes; the queue only appends confirmations. Public exports,
  schemaVersion 1 compatibility, pending-WAL ownership and legacy-root behavior are unchanged.
- Pinned pre-slice source: E02, SHA-256
  D05.
  AST/token comparison found 20 moved declarations identical; only the journal-tail probe was
  factored. All remaining pump declarations and public exports match the baseline. Probe helpers
  preserve empty, unreadable and short-read behavior, including descriptor-close failures.
  Log: /tmp/drec-t223-state-parity.log.
- Self-review found that the existing journal retry test checked appended lines but not actual
  fsync behavior. Strengthened that same case with injected fsync failure, retained spool/state,
  short-write completion, write-before-sync ordering and exact final-record JSON. No new cases or
  skips. All 12 queue cases passed against the pre-extraction implementation before the move.
- Focused regression: 6 files, 358 passed. Full regression: 364 passed files, 1 existing skipped
  file; 5433 passed cases and 42 existing skips, 101.09s. Logs: /tmp/drec-t223-state-focused.log
  and /tmp/drec-t223-state-final.log.
- Six isolated mutations were killed by assertion failures: omitted fsync, incomplete short
  write, cross-session confirmation, omitted pending-WAL ownership, corrupt-state sweep, and
  ignored torn journal tail. The selected snapshot baseline passed five cases; other tests were
  filtered only for these mutation runs, not excluded from the full suite. Workspace hashes
  remained unchanged and the owned snapshot was removed. Log: /tmp/drec-t223-state-mutations.log.
- Typecheck, architecture, bundle, whitespace checks and isolated HTTP smoke pass. Bundle
  0.0.390-4fc287 SHA-256: D06.
  Frontend, version, rooms and tasks returned HTTP 200 with fresh empty state. The owned process
  exited 0 and its temporary data was removed. Logs: /tmp/drec-t223-state-types-final.log,
  /tmp/drec-t223-state-arch.log, /tmp/drec-t223-state-bundle.log and /tmp/drec-t223-state-smoke.log.
- Extracted sources satisfy all strict structure limits: 96/159/127 nonblank lines, maximum
  function 49 lines and nesting 4. The overall gate still fails only in live-pump.ts: 4494
  nonblank lines (previously 4962), longest function 1561 lines and nesting 10. Logs:
  /tmp/drec-t223-state-structure.log and /tmp/drec-t223-state-overall-structure.log.
- Independent Spec review (pump_state_spec_review): zero findings; independently compared the
  pinned baseline and 83/84 existing declarations, and manually checked the factored tail probe.
  Independent Standards review (pump_state_standards_review): zero documented violations and
  zero actionable smells. Both are read-only scoped reviews, not live stability acceptance.
- Next archive-session slices: season association lifecycle first; then remote metadata
  publication; then interrupted-request and local-spool recovery as separate responsibilities.
  Keep persistence and checkpoint application under one owner. New modules must not runtime-import
  live-pump.ts; extract shared leaf responsibilities before their consumers. Never pass the whole
  session into a helper merely to relocate a large method. Capture and run coordination follow.
- No commit, push, merge, deployment or production mutation. The unfinished worktree is retained.

## Season lifecycle extraction (local, 2026-11-16)

- Extracted live-pump-season.ts with a narrow read/apply/persist checkpoint interface. The session
  remains the only state writer. Late metadata merges into current state, never a captured state
  snapshot. Public exports and the existing drain/reconcile/fault-injection methods are unchanged.
- Fixed pre-slice baseline: E03, SHA-256
  D07. AST/token comparison confirms
  all top-level declarations outside LivePumpSession, including exports, are identical; 36 session
  members are unchanged. Five integration members changed; two fields and two methods moved.
  Remaining async application, event mapping and reconciliation paths were manually reviewed.
- Strengthened the existing season-write-failure case without adding cases or skips: hold the
  season response, confirm P1/P2 while it waits, then reject the real checkpoint write via owned
  temporary-directory permissions. Restore permissions in finally; assert both memory and disk
  retain the parts, disk stays pending, and P3 still succeeds. This replaces an earlier injection
  before persist that did not exercise the metadata-only untrusted-state exception. The two season
  cases pass against both the pinned original implementation and the extracted implementation.
- Five isolated mutations were killed by actual assertions: omitted association queue, waiting
  for season on the part path, applying an old state snapshot, omitted pending reconciliation,
  and treating a metadata write failure as untrusted authoritative state. All mutations ran in an
  owned snapshot; source hashes were restored, workspace hashes stayed unchanged, snapshot removed.
- Full suite: 364 passed files, 1 existing skipped file; 5433 passed cases and 42 existing skips,
  99.66s. The initial six-file focus passed 287 cases; final full regression includes the stronger
  real-write-failure variant. Typecheck, architecture, bundle and whitespace checks passed.
- Bundle 0.0.390-4fc287 SHA-256:
  D08.
  Isolated loopback smoke returned HTTP 200 for frontend, version, rooms and tasks with fresh empty
  state. The owned process exited 0 and its temporary data was removed. No production was touched.
- Extracted module: 72 nonblank lines, longest function 29 lines, nesting 3; all strict limits pass.
  Overall gate still fails only live-pump.ts: 4456 nonblank lines, longest function 1561, nesting 10.
- Independent Spec review (season_spec_review): zero findings. Independent Standards review
  (season_standards_review): zero documented violations and zero actionable smells. Both reviewed
  the fixed snapshot and current files read-only; neither claims whole-project or live acceptance.
- Logs: /tmp/drec-t223-season-{baseline,targeted,focused,final,types-final,arch,bundle,smoke,
  mutations,parity,structure,overall-structure}.log.
- Next: isolate driver-backed create/append metadata mapping and error classification in
  live-pump-publication.ts. Pass immutable values, never the whole session. Keep identity resolution,
  pending intent and confirmed checkpoint writes in LivePumpSession. Strengthen the existing driver
  refusal test for needs-manual and retry-exhausted and remove its redundant no-retry case. Extract
  cancellation-aware waiting before moving legacy retry publication to avoid a runtime import cycle.
- No commit, push, merge, deployment or production mutation. The unfinished worktree is retained.

## Driver metadata publication extraction (local, 2026-11-16)

- Extracted live-pump-publication.ts: create/append request mapping and driver failure classification
  use narrow readonly archive metadata and completed-part values. No filesystem access, byte
  retransmission, retry loop, whole-session reference or runtime import from live-pump.ts.
  LivePumpSession still verifies/persists legacy identity, persists pending intent before publication,
  and persists confirmation before cleanup. Public exports are unchanged.
- Fixed pre-slice source: E04, SHA-256
  D09. Prior submitter test:
  E05, SHA-256
  D10. AST/token comparison confirms
  all top-level declarations outside LivePumpSession and 41 session members are identical; only
  submitPartViaSubmitter changed. The extracted request/error mapping was manually reviewed.
- Merged redundant refusal/no-retry cases, reducing submitter cases from five to four without
  skips. Both needs-manual and retry-exhausted now execute and retain spool/WAL without confirmation
  or an extra attempt. Existing success cases now assert complete policy, tags/description, title
  truncation, duration rounding/omission, custom target, exact signal identity, and durable intent
  before publication. All four strengthened cases also pass against the pinned original source.
- Eight isolated mutations were rejected by actual assertions: changed privacy/watermark policy,
  same-title reuse for fresh broadcasts, lost retry classification, duplicate driver retries,
  omitted durable intent, ignored custom target, lost append signal, and confirmation after failure.
  Owned snapshot sources were restored exactly; workspace source hashes remained unchanged; the
  temporary mutation snapshot was removed.
- Focused checks: four files, 20 passed. Full suite: 364 passed files, one existing skipped file;
  5432 passed cases, 42 existing skips, 97.37s. Typecheck, architecture, bundle and whitespace checks
  pass. Bundle 0.0.390-4fc287 SHA-256:
  D11.
  Isolated loopback frontend/version/rooms/tasks all returned HTTP 200 with fresh empty state;
  the owned process exited 0 and temporary data was removed. No production systems were touched.
- New module: 84 nonblank lines, longest function 21 lines, nesting 3; strict scoped gate passes.
  submitPartViaSubmitter is now 42 lines. Overall gate still fails only live-pump.ts: 4411 nonblank
  lines, longest function 1561, nesting 10. No artificial line-count wrappers were introduced.
- Independent publication_spec_review: zero findings. Independent publication_standards_review:
  zero documented violations and zero actionable smells. Both are scoped read-only reviews,
  not whole-candidate approval or current-bundle live stability acceptance.
- Logs: /tmp/drec-t223-publication-{baseline,focused,final,types-final,arch,bundle,smoke,
  mutations,parity,structure,overall-structure}.log.
- Next: move shared abortable waiting into live-pump-wait.ts, keeping its existing public export;
  then extract legacy metadata publication and its bounded retry/accounting loop without a runtime
  cycle. Keep identity/intent/confirmation writes in the session. Strengthen existing legacy tests
  for exhaustion and cancellation without adding cases. Preserve the current final-attempt sleep
  and externally-owned timer semantics during extraction; changing those needs separate evidence.
- No commit, push, merge, deployment or production mutation. The unfinished worktree is retained.

## Legacy publication and shared waiting extraction (local, 2026-11-16)

- Extracted live-pump-legacy-publication.ts and live-pump-wait.ts. The publication module owns
  one-request metadata mapping plus bounded retry/account accounting. Each attempt reads a fresh
  seven-field readonly archive projection, never the session or a stale checkpoint snapshot.
  LivePumpSession retains pending-intent persistence and confirmation-before-cleanup ordering.
- Kept SubmitGate and sleepUnlessAborted available through the original public exports. The wait
  helper and gate declaration are AST/token-identical after relocation. All other top-level
  declarations and 40 session members are unchanged; only submitPart wiring and the extracted
  legacy retry method differ. No filesystem writes, byte retransmission or runtime cycle added.
- Fixed pre-slice source: E06, SHA-256
  D12.
  Prior tests: E07, SHA-256
  D13.
- Strengthened two existing tests, with no new definitions or skips: exhausted P3 preserves
  confirmed P1/P2, pending intent and spool; aborting an unresolved cooldown returns promptly,
  preserves pending P2 and confirmed P1, and never submits again. Both accounting hooks may throw
  without blocking publication. Existing wait/heartbeat tests remain. All four focused tests pass
  before and after extraction, including an isolated rerun against the pinned original source.
- Preserved the legacy final-attempt cooldown, five-minute cap, externally owned default timer,
  and cooldown-only caller cancellation. This refactor does not claim HTTP requests became
  caller-cancellable or that these legacy quirks were fixed.
- Eight isolated mutations were rejected by actual assertions: changed default attempt count,
  removed cooldown cap, skipped final cooldown, lost retryable classification, omitted submission
  accounting, omitted rate-limit accounting, ignored abort during injected sleep, and missing
  durable intent before publication. Exact snapshot sources were restored, real-worktree hashes
  remained unchanged, and the owned temporary snapshot was removed.
- Full suite: 364 passed files, one existing skipped file; 5432 passed cases, 42 existing skips,
  98.75s. Typecheck, architecture, bundle and whitespace checks pass. Bundle 0.0.390-4fc287 SHA-256:
  D14.
  Isolated loopback frontend/version/rooms/tasks all returned HTTP 200 with fresh empty state.
  The owned process exited 0 and temporary data was removed. No production was touched.
- Both new modules pass strict structure limits: 88/27 nonblank lines, longest function 29 lines,
  maximum nesting 3. Overall changed-source gate still fails only live-pump.ts: 4311 nonblank
  lines, longest function 1561 lines, nesting 10. Structural debt is not waived.
- Independent legacy_publication_spec_review: zero findings. Independent
  legacy_publication_standards_review: zero documented violations and zero actionable smells.
  Both are scoped, read-only reviews, not whole-candidate or current-bundle live acceptance.
- Logs: /tmp/drec-t223-legacy-{baseline,focused,final,types-final,arch,bundle,smoke,mutations,
  parity,structure,overall-structure}.log.
- Next: local-spool recovery and whole-file transfer, then interrupted-request recovery and
  capture/finalization/run coordination. Read-only scouting identifies resubmitUnconfirmedPart,
  reuploadSpoolFile/reuploadOpenSpool and shared preupload retry as the next cohesive slice.
  Return preparation/disposition results; keep row removal, persistence, hold-rename rollback and
  submitPart in the session. Preserve truncation-before-orphan checks, old/sealed-row refusal,
  existing DTS-scan-error policy, progress-only activity refresh and abort-before-publication.
  Strengthen existing successful-recovery and failed-hold-rename cases with a later concurrent
  row, checking that neither confirmation nor rollback overwrites it; do not add test cases.
  Leave exact-title/identity resolution in recover for the subsequent distinct slice.
- No commit, push, merge, deployment or production mutation. The unfinished worktree is retained.

## Local-spool recovery extraction (local, 2026-11-16)

- Extracted live-pump-spool-recovery.ts: readonly target projection, local file/media inspection,
  bounded preupload retry, exact-size whole-file transfer and preparation/disposition results.
  LivePumpSession retains all row changes, persistence, hold renames, rollback, publication,
  confirmation and cleanup. The helper has no runtime import back into the pump.
- Kept DTS_GAP_FORWARD_SEC, heldGapPath and reuploadSpoolFile available through original exports.
  Five relocated declarations are AST/token-identical ignoring export modifiers and comments;
  the chunk reader body is unchanged after moving its closure outside the upload try block.
  All other top-level declarations and 40 session members are unchanged. Only the spool recovery
  entry changed, with three new private session helpers and a local result type.
- Pinned source: E08, SHA-256
  D15.
  Pinned tests: E09, SHA-256
  D16.
- Strengthened two existing cases without adding definitions or skips. Successful recovery pauses
  probing while another row is written; failed hold-rename pauses DTS scanning while another row
  is written. Both assert exact in-memory/durable row preservation and surviving spool files.
  The rename test uses a real permissions failure, restores permissions in finally and confirms
  no preupload occurs. Both pass against the pinned original source in an isolated snapshot.
- Self-review/independent-review finding: initially the rename case only seeded its later row
  before recovery. Standards review correctly identified that this missed stale-snapshot rollback.
  Replaced that setup with a deferred scan and same-session concurrent noteUnconfirmedPart call.
  Standards follow-up confirms the finding closed; no additional test case was introduced.
- Eight isolated mutations were rejected by actual assertions: losing a later row on confirmation,
  restoring a pre-scan snapshot, accepting a truncated open spool, dropping a sealed unreadable
  spool, ignoring a DTS gap, losing retryable classification, omitting chunk activity and accepting
  premature EOF. Exact source hashes were restored, the real worktree was unchanged and the owned
  temporary snapshot was removed. A successful mutant or compile failure was not counted as proof.
- Preserved existing inconclusive DTS-scan behavior during recovery, truncation-before-orphan
  refusal, old/sealed-row handling, chunk-only activity, observer isolation and abort-before-submit.
  This extraction does not claim recovery HTTP requests are caller-cancellable.
- Final full suite: 364 passed files, one existing skipped file; 5432 passed cases, 42 existing skips,
  104.40s. Typecheck, architecture, bundle and whitespace checks pass. Bundle 0.0.390-4fc287 SHA-256:
  D17.
  Isolated loopback frontend/version/rooms/tasks all returned HTTP 200 with fresh empty state.
  The owned server exited 0 and its temporary data was removed; production was not touched.
- New module passes strict structure limits: 201 nonblank lines, longest function 45 lines,
  nesting 4. Overall changed-source gate still fails only live-pump.ts: 4126 nonblank lines,
  longest function 1561 lines, nesting 10; inherited comment-limit violations also remain there.
- Independent spool_recovery_spec_review: zero findings. Independent
  spool_recovery_standards_review: one test-coverage finding fixed, zero remaining violations or
  actionable smells. These scoped reviews are not whole-candidate or live-stability acceptance.
- Logs: /tmp/drec-t223-spool-{baseline,focused,final,types-final,arch,bundle,smoke,mutations,
  parity,structure,overall-structure}.log. Final tests include the review correction.
- Next: extract interrupted-publication resolution from recover, then capture/finalization/run
  coordination. Keep pending/state merging, persistence, recovered events and cleanup in session.
  Reuse existing exact-title lookup; distinguish a readable empty list from transport/rate-limit
  failure and ambiguity. Preserve aid-only recovery and the post-await check against current aid;
  a narrow readonly archive projection can supply current identity without exposing the session.
  Do not substitute recordConfirmed, which adds season/progress effects that recover lacks.
  Strengthen the existing exact-title recovery case with a concurrent later row and the existing
  unavailable-list case with pending/spool preservation and rejection of another submit.
  Keep the existing no-signal recovery behavior, and add no test definitions.
- No commit, push, merge, deployment or production mutation. The unfinished worktree is retained.

## Interrupted-publication recovery extraction (local, 2026-11-16)

- Added live-pump-recovery.ts for read-only archive lookup and outcome classification. A readable
  exact-title search with zero matches alone permits retrying create. Unavailable, limited,
  ambiguous, missing-stem and missing-identity results retain the original refusal semantics.
- LivePumpSession still owns pending-row merging, all persistence, cleanup and recovered events.
  Self-review rejected putting the current-aid check inside the async helper: its return would
  introduce another scheduling gap before state application. The check remains in recover,
  immediately after awaiting lookup and synchronously before merging the latest state.
- Original source snapshot: E10, SHA-256
  D18.
  Original test snapshot: E11, SHA-256
  D19.
- Strengthened two existing cases: transport/rate-limit failures preserve pending state and spool
  and block a second submit; successful lookup preserves a concurrently added row and deferred
  delivery marker while removing only the confirmed spool. No new test definitions or skips.
  Six focused cases pass before/after extraction; strengthened cases also pass on pinned source.
- AST/token comparison: all other top-level declarations and 43 session members unchanged.
  The pending-merge body, public result shape and recovered-event payload are unchanged. Seven
  isolated mutants fail actual assertions: unreadable-as-empty, readable-empty refusal, lost
  concurrent row, ignored identity mismatch, lost pending stem, omitted persist and omitted
  confirmed-spool cleanup. Exact sources restored; the owned snapshot was removed.
- First full suite: 5431 passed, one failure, 42 existing skips, 104.86s. The unchanged deployment
  guard test expected an upload-queue timeout but stopped at the task-list request (HTTP 0).
  Its 50ms timeout applies to both requests. The file passed alone (15/15), and an isolated
  controlled delay reproduced the same stage mismatch while both paths refused deployment.
  This demonstrates timing sensitivity; the original run did not capture the underlying request
  error, so host contention is not asserted as its proven cause. No assertion, timeout, production
  guard or test selection was changed. Retain this as a known timing-risk for later test cleanup.
- Full rerun without another parent-owned heavy validation: 364 passed files, one existing skipped
  file; 5432 passed cases, 42 existing skips, 101.04s. Typecheck, architecture, bundle, whitespace
  and isolated HTTP smoke pass. Bundle 0.0.390-4fc287 SHA-256:
  D20.
- New module: 78 nonblank lines, longest function 30 lines, nesting 3, strict gate passes. Overall
  gate still fails only live-pump.ts (4067 nonblank lines, longest function 1561, nesting 10 and
  inherited comment-limit violations). There is no exemption or whole-candidate acceptance.
- Independent interrupted_recovery_spec_review and interrupted_recovery_standards_review each
  report zero findings. Both are scoped, read-only reviews, not live-stability acceptance.
- Logs: /tmp/drec-t223-interrupted-{baseline,focused,types-final,final,final-recheck,structure,
  parity,mutations,arch,bundle,smoke,overall-structure,busy-recheck,busy-diagnostic}.log.
  The original failed full-suite log remains separate and unchanged.
- Next cohesive slice: PartSink byte transfer, a bounded chunk buffer and a spool owner. Preserve
  partial-write byte accounting, tail-before-close sizing, first degradation plus independent
  truncation alerts, delayed/no-session distinctions and abandonment settlement. Strengthen two
  existing cases, not new definitions. Finalization/run coordination remains subsequent work.
- No commit, push, merge, deployment or production mutation. The unfinished worktree is retained.

## Per-part byte transfer extraction (local, 2026-11-16)

- Added live-pump-part-buffer.ts, live-pump-part-spool.ts and live-pump-part-sink.ts. The buffer
  owns bounded FIFO/tail accounting; the spool owns file descriptors and actual partial writes;
  PartSink owns transfer, degradation, abort and settlement policy. Original exports stay intact.
- Pinned source: E12, SHA-256
  D21.
  Pinned tests: E13, SHA-256
  D22.
- Strengthened three existing cases: tail overflow and repeated seal; partial spool failure after
  an earlier degradation; synchronous short-tail seal before upload initialization resumes. Exact
  persisted bytes, transferred bytes and independent truncation reporting are asserted. No new
  test definitions, skips or discovery exclusions. The strengthened cases pass on pinned source.
- The first tail-accounting mutant survived because the test could dequeue before seal. Changed
  the existing short-tail case to exercise the public PartSink interface with deterministic
  write/seal order; retained other runSegment short-tail integration cases. All eight mutants now
  fail assertions: overstated partial writes, continued writes after truncation, ignored overflow,
  lost tail size, suppressed truncation alert, zero-disk spool creation, missing overflow error
  and replaced first degradation. Exact snapshot sources restored; owned snapshot removed.
- Final self-review restored nullish constructor defaults for spoolMode and writeSpool. All
  mutations and local checks were rerun after that correction. Non-moved declarations, session
  and run coordination are AST/token-identical; public types/constants/exports are preserved.
- Final full suite: 364 passed files, one existing skipped file; 5432 passed cases, 42 existing
  skips, 102.09s. Typecheck, architecture, bundle and whitespace checks pass. The exact bundle
  0.0.390-4fc287 has SHA-256
  D23.
  Isolated frontend/version/rooms/tasks returned HTTP 200 with empty state. The owned process
  exited 0 and its temporary data was removed; production was not touched.
- New modules have 78/54/272 nonblank lines; maximum function length 30 and nesting 4. All three
  pass strict structure limits. live-pump.ts drops from 4067 to 3552 nonblank lines; its 1561-line
  run function and nesting 10 still block overall acceptance. No structural exemption was added.
- Independent part_sink_spec_review: zero remaining findings. Independent
  part_sink_standards_review: zero remaining violations or actionable smells. Both also checked
  the third strengthened test and final nullish correction. These are scoped static reviews,
  not whole-candidate review or current-artifact live stability acceptance.
- Logs: /tmp/drec-t223-part-sink-{baseline,focused,structure,parity,types-final,arch,bundle,smoke,
  overall-structure,mutations,mutations-final,mutations-accepted,final,accepted}.log. The original
  surviving-mutant log is retained; accepted.log is the post-correction full-suite result.
- Next: run-scoped delivery ownership, with separate registry/WAL, finalization, connection and
  reporting responsibilities. Keep capture acquisition and startup recovery outside. Preserve
  WAL-before-sink/enqueue ordering, serial publication, signal-time stop budgets, recoverable
  later parts, and immutable returned results after late completion. Reuse existing ordered
  submit, abort-ignoring finalize and mid-run handoff cases instead of adding tests.
- No commit, push, merge, deployment or production mutation. The unfinished worktree is retained.

## Ordered finalization checkpoint (local, 2026-11-16; not yet accepted)

- Extracted LivePumpFinalization: part registry, serial promise chain, first failure, connection
  cancellation and original-signal stop budget. Finalize/preserve policies still own archive and
  WAL writes in the caller. Imports from the pump/sink are type-only, with no runtime cycle.
- Fixed two pre-existing closure races discovered by strengthening existing tests: a late
  predecessor released queued tiny-tail cleanup after return; an already-running preservation
  probe rewrote recovery state after the budget expired. The sink-completion fence and
  keepOrLose entry/post-probe fences prevent those late effects.
- Pinned pre-extraction source: E14, SHA-256
  D24.
  Original tests: E15, SHA-256
  D25.
  Final strengthened tests against that source reproduce two assertion failures, with four
  other selected cases passing, in an isolated snapshot. No workspace source was replaced.
- Four existing test definitions strengthened, with no additional cases or skips: capture/WAL
  progress while P1 delivery is held; exact state/spool immutability after late completion;
  stop after sealing while chunk transfer still has its cancellation listener; failed later
  parts with a duration probe held across budget/grace, followed by actual ordered restart.
  A final single-frame tail exercises preservation's pre-probe cleanup/logging branch.
- Initial mutation audit killed 5/7: stopping only after complete-start did not exercise the
  listener, and the failure/recovery case did not distinguish forbidden later finalization.
  The next audit killed 8/9: entry-fence coverage also needed the queued single-frame tail.
  After strengthening those existing fixtures, all 9/9 fail actual assertions: ordering,
  sealed cancellation, original stop budget, visible fatal result, grace preservation,
  late queued cleanup, failed-predecessor refusal, preservation entry and post-probe fences.
  Every mutant ran in an isolated snapshot; exact source hashes were restored. Original
  surviving-mutant logs are retained, not counted as passing evidence.
- Final full suite: 364 passed files, one existing skipped file; 5432 passed cases,
  42 existing skips, 109.00s. Typecheck, architecture check, bundle and whitespace pass.
  Exact local bundle: 0.0.390-4fc287, SHA-256
  D26.
  Isolated frontend/version/rooms/tasks return HTTP 200 with empty state; the owned server
  exits 0 and its temporary data is removed. This is not live stability acceptance.
- AST parity: unrelated top-level declarations/public exports are unchanged; all 273 existing
  test/suite declarations and parameterizations are unchanged. New module: 137 nonblank lines,
  max function 37, nesting 4. Pump: 3552 -> 3442 nonblank lines; longest function 1561 -> 1449,
  nesting still 10. Of 41 touched production files, only the pump still violates structure.
- Independent Standards review: zero remaining violations/actionable smells; scores 4/4/4/5/5.
  Its independent 6-test run preceded the final guards and is not final-candidate evidence.
  Independent Spec review: the preservation-probe P2 is resolved, but one further P2 stays OPEN.
  The earlier broad design scout was stopped after the focused reviews superseded it; it is
  not counted as an approval.
- OPEN P2, static review, not yet reproduced: spool-only finalization can continue after a slow
  probe/scan outlives budget/grace. finalizeRecordedPart may rename a gap-held spool and call
  onHold before returning; the spool-only caller can then markValidated/write WAL/report.
  The existing direct-path post-await guard cannot protect these earlier side effects.
  Next: strengthen an existing spool/handoff case to hold probe/scan across shutdown, release
  it after return, and require unchanged WAL, spool paths/bytes and logs. Then fence both the
  post-await media-validation effects and spool-only continuation by run lifetime. Do not
  substitute the part's abort signal blindly: a stopped active tail may still be validated
  during its allowed grace period. Re-run red/green, mutations, full suite and both reviews.
- Logs: /tmp/drec-t223-finalization-{focused,focused-fixed,focused-final,preserve-red,
  preserve-final,pre-slice,pre-slice-final,pre-slice-exact,mutations,mutations-final,
  mutations-accepted,full,full-final,types-final,arch-final,bundle-final,smoke,
  parity-final,structure-final,whole-structure}.log. mutations-accepted only means mutation
  assertions passed; it does not override the remaining Spec or overall structure gates.
- No commit, push, merge, deployment or production mutation. The unfinished worktree remains.

## Late media validation closure fix (local, 2026-11-16)

- Resolved the OPEN P2 from the ordered-finalization checkpoint. The first red run reproduced
  an exact WAL-byte change after the run returned: one selected test failed, one passed.
  Duration-probe and DTS-scan continuations now check the owning run lifetime after their
  await/catch boundary, before media classification, rename, callbacks or further validation.
  Both run callers supply that lifetime; the spool caller also fences its own continuation.
  Helper entry, complete and fallback boundaries are protected too. Standalone callers omit
  the optional lifetime callback and retain their existing behavior.
- Stop is not closure: the existing positive spool test stops during the last scan and still
  requires both rows to become validated during grace. The existing crash-recovery test now
  also holds spool probe, spool scan and direct scan past budget/grace. After return, releasing
  them must not change file names/bytes, WAL, returned result, logs, alerts, reporter events or
  HTTP events; a late duration probe must not start a DTS scan. Original startup bad-file
  assertions remain. No test definition or skip was added; its title now names both scenarios.
- Five isolated mutations fail assertions: omit the post-probe fence, post-scan fence, spool
  continuation fence or direct caller wiring; incorrectly treat an aborted signal as closure.
  Snapshot baseline passed, all 5/5 mutants were killed, sources restored exactly and the
  owned mutation snapshot removed. These are targeted checks, not a claim of exhaustive mutation
  coverage for every helper boundary. Previous finalization checks remain historical evidence.
- Final regression after the review's title-only correction: 364 passed files, one existing
  skipped file; 5432 passed cases, 42 existing skips, 105.74s. Typecheck, architecture and bundle
  passed. An initial typecheck found a missing reporter progress hook in the new test fixture;
  the hook was added before final verification. Isolated HTTP smoke returned 200 for frontend,
  version, rooms and tasks; empty data only, process exit 0, owned temporary data removed.
- Runtime source SHA-256: D27.
  Final test SHA-256: D28.
  Exact bundle 0.0.390-4fc287 SHA-256:
  D29.
- Independent Spec review: no findings in this bounded fix, static review only. Independent
  Standards review: zero hard violations; its test-name nit was fixed and independently
  confirmed. Scores 5/4/5/5/5. Neither review approves the entire candidate.
- Overall strict gate remains FAIL: of 41 touched production files, only live-pump.ts violates
  thresholds (3451 nonblank lines, longest function 1451 lines, nesting 10). No exemption added.
  This fixes a stability defect but does not finish the remaining structure or live acceptance.
- Evidence: /tmp/drec-t223-validation-{red,green,types,full,full-final,arch,bundle,smoke,
  mutations,structure}.log. The pre-fix source/test snapshot is
  /tmp/drec-t223-late-validation.FKtiO8; retained for bounded review and reproducibility.
- Delivery pacing: consolidate the remaining decomposition into cohesive responsibility-sized
  batches, keep focused checks during edits, and run full final gates for each delivery batch.
  Do not broaden the audit or report each small extraction as a completed delivery.
- No new decomposition started in this checkpoint. No commit, push, merge, deployment or
  production mutation. The unfinished worktree remains.

## Consolidated pump responsibility batch (local, 2026-11-16)

- Completed the remaining extraction as one batch, not separate delivery rounds. Startup owns
  pre-wait recovery and handoff; source acquisition owns polling; capture owns child/prefetch
  and index allocation; validation owns local media checks; delivery owns order, lifetime and
  loss accounting; the checkpoint owns local persistence while session recovery/publication
  use its current state. The public facade preserves all 66 exports exactly.
- All 60 touched production files pass the strict structure gate: maximum function 60 lines,
  nesting 4, no comment-limit violations. The 20-file batch including the facade has 3464
  nonblank lines in total; its largest file is 375. This is a locality/complexity improvement,
  not a claim that total source volume decreased. Previous baseline: one 3451-line file,
  longest function 1451 lines, nesting 10. No limit exemption or test exclusion was added.
- Focused lower-layer run: 258 passed. Critical stop/crash/pending run: 64 passed; selector
  exclusions are not new persistent skips. First full run: 5431 passed, one failure, 42 existing
  skips, 109.06s. The failure was the old test assigning a private statePath no longer used by
  the extracted checkpoint. Its existing assertions were retained; setup now replaces the
  actual isolated state directory with a file. The focused write-failure case then passed.
- Final full run: 364 passed files, one existing skipped file; 5432 passed cases, 42 existing
  skips, 110.14s. Test definition count is unchanged. Typecheck, architecture, bundle and
  whitespace checks pass. Isolated frontend/version/rooms/tasks return HTTP 200 with empty
  state; the owned process exits 0 and only its temporary data was removed.
- Targeted isolated mutation assertions reject: skipped durable intent before submission,
  missing direct validation lifetime wiring, missing spool validation lifetime wiring, and
  treating an aborted part as run closure. An initial scan-only return mutant survived because
  it still returned to the caller's full validation path for a clean scan; it is not counted
  as a killed mutant. The corrected whole-finalizer early-return mutant fails the original
  positive validation assertion. All snapshots were restored and owned mutation data removed.
- Frozen baseline: E16. Frozen current production
  files: /tmp/drec-t223-run-batch.JZ2hJJ/candidate. The sorted filename+byte SHA-256 manifest is
  D30.
  Final test SHA-256: D31.
  Bundle 0.0.390-4fc287 SHA-256:
  D32.
- Evidence: /tmp/drec-t223-run-batch-{focused-stage1,critical,full,state-write,full-final,
  types-final,arch,bundle,smoke,mutations,mutation-grace,structure-final}.log.
  Independent Spec and Standards reviews of the frozen batch are pending; no approval claimed.
- Version collision and current-artifact >=120s real canary remain outstanding. No commit,
  push, merge, production deployment or production mutation. Keep the unfinished worktree.

## Local delivery candidate checkpoint (2026-11-16)

- Rechecked the frozen 20-file production batch: no byte drift. The existing test fixture
  still hashes to D31.
- Both deletion worktrees currently use 0.0.390; local and remote main remain at 0.0.389
  (4f41345c). This worktree's local candidate moves to 0.0.391-4fc287 only. No release tag
  or global version reservation was created. Release ordering and the base-relative patch
  increment must be rechecked before committing; this does not authorize a merge or rollout.
- Fresh full regression passed: 364 files passed, one existing skipped file; 5432 tests
  passed, 42 existing skips, 128.15s, native exit 0. No test cases or skips were added.
  Typecheck, architecture check, bundle and whitespace checks also exited 0.
- Strict structure recheck passed for all 60 touched production files: longest function
  60 lines, maximum compound nesting 4, no line/comment violations.
- Exact bundle SHA-256: D33.
  Its isolated frontend, version, rooms and tasks endpoints returned HTTP 200; version was
  0.0.391-4fc287 and state was empty. The owned process exited 0 and its temporary data was removed.
- Evidence: /tmp/drec-t223-delivery-{full,types,arch,bundle,structure,smoke}.log.
  The subsequent scoped reviews below complete the frozen-batch static review only.
  Authorized >=120s real stability acceptance is still missing.
- Independent Spec review found no actionable changed-behavior findings in the frozen
  20-file batch against the frozen pre-batch pump source. It checked stop/drain/grace handling, WAL and
  recovery ordering, queue handoff, prefetch cleanup and stream identity refresh.
- Independent Standards review found no hard violations or actionable heuristic findings
  in the same batch. Capture, delivery, checkpoint, recovery, startup and stream resources
  have distinct owners; public exports and the existing options contract remain intact.
  The direct/spool delivery split was assessed as responsibility-based, not a line-count wrapper.
- Earlier interrupted attempts explicitly reported no code inspection and provide no approval.
  The later conclusions above are scoped static reviews; reviewers made no edits and ran no tests.
  Parent recheck confirmed all 20 sources still match the frozen snapshot and the bundle/test
  hashes above remain unchanged. Whole-candidate readiness and release-base ordering are
  separate delivery gates; this checkpoint does not establish feature permanence.
- No commit, push, merge, production deployment or production mutation. Keep the unfinished
  worktree until the whole task is accepted, merged and clean.

## Whole-candidate local readiness (2026-11-16)

- Remote main is still the original base, version 0.0.389; the open-PR list is empty and no
  0.0.390, 0.0.391 or 0.0.392 release tag exists. Corrected the provisional 0.0.391 manifest
  back to 0.0.390, satisfying the actual base-relative patch increment. Other worktrees remain
  untouched. This is not a global reservation or permission to commit, merge or deploy.
- The full dirty-worktree privacy scan, including all 63 untracked files, initially rejected
  an inherited numeric room example in extracted record help and local evidence references.
  Replaced the help example with a placeholder and mapped source snapshots/full fingerprints
  to local E/D evidence identifiers. The same scan now reports zero hits and zero fixture
  allow-mark exclusions. No privacy rule or test discovery was relaxed.
- Final bundle: 0.0.390-4fc287, fingerprint D34. Touched-production source manifest: D35
  (60 files). All 66 public pump exports match the base. Source behavior is unchanged from
  the reviewed candidate; the additional runtime-file edit only anonymizes help text.
- Fresh final full suite after that help edit: 364 files passed, one existing skipped file;
  5432 tests passed, 42 existing skips, 128.18s, exit 0. No cases or skips added.
  Typecheck and architecture checks pass. Strict structure: 60 files pass, longest function
  60 lines, maximum nesting 4, no line/comment violations. Diff whitespace passes.
- Final exact-bundle isolated smoke: frontend, version, rooms and tasks all HTTP 200;
  empty state, expected version, owned process exit 0 and temporary data removed.
  Evidence: /tmp/drec-t223-readiness-{full-final,types,arch,bundle-final,structure,
  smoke-final,source-manifest,release-gates}.log.
- Independent Standards review: no actionable hard violations or heuristic findings across
  the reviewed command/lifecycle/pump boundaries. It checked extracted interfaces and replaced
  test coverage, relying on prior batch inspection for the reviewed pump internals; no tests run.
  The one-line help anonymization was rechecked and does not change its conclusion.
- Independent Spec review: no actionable behavior mismatch in explicit task opt-in, default
  submitter construction, metadata-only publication, confirmed checkpoints, WAL/cleanup order,
  recovery, stop fences, queue handoff and spool retention. Static review only; no tests run.
  Neither reviewer approves production use or claims unobserved live behavior.
- Risk scan remains RISK because the candidate touches upload, cleanup and ledger paths.
  Local implementation permission is not a deployment/real-upload grant. No PR, commit, push,
  merge, production restart or production data change was made.
- Read-only API observation at 2026-11-16 13:17 PST: all three nodes report zero actively
  recording tasks and zero active processing jobs, still on 0.0.389. This is not a full guard
  pass and must be refreshed immediately before any authorized test; waiting tasks stay enabled.

## Bounded live acceptance proposal (requires authorization)

- Run the exact D34 artifact only in a separate test directory on an idle worker. Do not replace
  its installed bundle, restart its production service, modify hub rules or stop production rooms.
- Before starting, run the repository safety decision for all nodes and check shared-account
  activity/cooldown. Any unknown status or active production recording/upload postpones the test.
- Use one non-production test room, private visibility and disabled watermark. Start with three
  180-second parts: create, append, graceful stop and restart into the same draft. At most six
  new parts across the full acceptance, never shorter than 120 seconds; keep account limits intact.
- Exercise recovery and queue takeover only on owned test state and already-recorded test spool.
  Assert one draft, unique part identities, persisted confirmations before cleanup, and no lost
  confirmed media. Stop only owned test processes, by exact identity. Never edit/delete real drafts.
- Do not intentionally trigger service throttling. If it occurs, stop new uploads, preserve pending
  state, respect the account cooldown and record the outcome. Unobserved live cases remain explicit
  gaps; synthetic fault injection is supplementary, not evidence of a real server response.
- Preserve test evidence and all unconfirmed media. Delete only confirmed, test-owned temporary
  artifacts after evidence is recorded. Remote private-draft deletion remains a separate action.
- After successful acceptance, recheck release ordering and request the separate delivery gate;
  do not silently commit, merge or roll out. Keep this unfinished worktree until merged and clean.
