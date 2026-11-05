# 045 — Codebase optimization roadmap (whole-repo audit, 2026-11-04)

**Goal:** cut duplicated rules so that one change lands in one place, and fix the latent bugs the audit surfaced.
Source: five read-only audits at `origin/main` 8a52c842 (record / upload / hub / entry+config / web).
Every item below has file:line evidence in the audit notes; items marked ✔ were spot-checked by the orchestrator.

**Architecture direction**
- Config is resolved once, in core (`hub-config` module), typed once; call sites receive resolved values.
- Upload = 2 backends (`biliupFile`, `uposStudio`) × N producers (whole set / sealed segments / live cuts / prep outputs),
  sharing one durable `UploadCtx` and one `onArchiveCreated` hook runner. Stores stay with their owners.
- Master↔node commands go through one typed protocol table.

**Global constraints**
- One issue + one PR per item; `accept` before code. RISK items (upload / cleanup / ledger / retention) need explicit owner approval per PR.
- Pure extractions must not change numbers (rate-limit 60s/300s/30min, window 5/600s) or verdicts.
- Phases are ordered; inside a phase items are independent.

## Phase 0 — latent bugs (S each, start now)
- [ ] B1 ✔ (#470, T-141) `_proc-status` turns DB open/query errors into "job not found" → survivor remux ends silently and the rerun "queued upload" guard can pass → duplicate submission risk. Fail loudly; write `missing` only on explicit not-found. (app/node-enqueue.ts:185,202)
- [ ] B2 ✔ (#471, T-142) node-remux hand-copies the node-side-upload predicate and misses `NODE_SIDE_UPLOAD_ENABLED`. Use the canonical predicate. (app/node-remux.ts:336)
- [ ] B3 ✔ (#472, T-143) `--danmu no` enables danmu; unify the boolean vocabulary (4 copies). (cli.ts:78-81)
- [ ] B4 ✔ (#473, T-144) `GET /api/hub/resources` ignores inline/settings-sourced hub config. (web/api/settings.ts:33)
- [ ] B5 ✔ (#474, T-145) mesio stall watchdog sums every `.flv` in the dir; scope to this session's files. (record-engine/engines/mesio.ts:91)
- [ ] B6 ✔ (#475, T-146) same-broadcast window 10 min in manager vs 30 min canonical; unify or document. (manager/index.ts:35)
- [ ] B7 (#476, T-147) bilibili "live but no playable URL" silently treated as offline; alert once.
- [ ] B8 (#477, T-148) session sidecar write failures swallowed; warn + dedup alert. (manager/index.ts:570,640)
- [ ] B9 (#478, T-149) ledger migration swallows ALTER errors; validate all columns. (RISK ledger, read-only check)
- [ ] B10 (#479, T-150) live-gate mutates `process.env` around an await-sensitive call; pass apiMode as a parameter.
- [ ] B11 (#480, T-151) node apply: one malformed spec aborts the whole batch; skip + log per item.
- [ ] B12 (#481, T-152) hub-store rule identity: room-derived key vs filename stem can diverge → ghost/duplicate rules.

## Phase 1 — single sources (no RISK)
- [ ] F1 core `hub-config` module: `HubConfig`, `resolveHubResources`, `resolveUploadMeta` (one place for rule > defaults; fixes private/uploadPrivate/public renames). Parity tests first, then delegate the 4 resolvers.
- [ ] F2 core `task-fields` module + one `applyRecordingPatch` (replaces ~12 copies; collapses TaskPayload vs Create/UpdateTaskInput drift).
- [ ] F3 move rule validators to core; validate on rule write, warn-once on read.
- [ ] F4 one pipeline topology table in core + parity test (core / workflow / web).
- [ ] F5 `submitWithBackoff(policy)` extraction of the 7 rate-limit loops, values unchanged.
- [ ] F6 `onOffline(living?)` — remove the second live query per disconnect.

## Phase 2 — upload ctx + hooks (RISK, one path per PR)
- [ ] U1 core `UploadCtx` / `ArchiveBackend` / hook state types + pure transitions, zero callers.
- [ ] U2 6 season call sites → one durable `runArchiveHooks` (pending persisted before the call, reconcile-first on resume). #460 resolver lives inside the season hook.
- [ ] U3 processors/biliup as reference `biliupFile` backend.
- [ ] U4 node-pipeline. U5 rolling-upload. U6 orchestrator merge + segment. U7 live-pump (create/append/hooks only).
- Keep: cleanup outside upload; ambiguity → manual; head-of-line blocking; live-pump spool/WAL; titles resolved before ctx.

## Phase 3 — hub structure (mixed RISK)
- [ ] H1 typed node-command protocol table + client (4 "unsupported" conventions → 1).
- [ ] H2 ledger sub-state into real columns/child table (followups, manual phase); drop `LIKE` and error-text phase. RISK ledger.
- [ ] H3 one pipeline engine for merge and segment modes; one job-log helper. RISK cleanup.
- [ ] H4 single "is recording" source (recorder state file).

## Phase 4 — hygiene
- [ ] Split cli.ts (`start()` ~1000 lines, `record` ~560) — after F1/F2 leave thin delegates.
- [ ] TaskManager: one runtime record per task instead of 12 Maps.
- [ ] Session sidecar single writer in core (RISK delete-guard).
- [ ] Shared danmu WS supervisor (douyin/bilibili) + bilibili danmu/stream tests.
- [ ] Web: shared DTO for latest-run phase; stop regex-matching backend error text; import core constants; dead i18n keys. Legacy `/hub` pages: **conflicts with T-118 (legacy routes kept on purpose)** — kept per T-118 until the owner decides.
- [ ] Test seams out of production constructors; de-flake load-sensitive tests.

## Do not change
File-based hub rules (no cache); mergePipeline deep merge; two-phase delete and shrink guards; unreachable ≠ empty inventory; never delete the last copy; hub vs proc-queue state machines stay separate; no auto-retry for needs_manual; vendored douyin signing; ffmpeg/mesio split; processors readdir ban.
