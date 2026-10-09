# Auditor A — Code-quality / architecture audit

Scope: `packages/app/**`, `packages/cli/**`, `packages/orchestrator/**`
HEAD: `a839948` (verified read-only; no repo file modified). All line numbers below are from that commit.

Legend: **P0** = correctness / architecture blocker · **P1** = worth fixing · **P2** = nice to have.
Every claim was verified with rg/grep against committed source; speculative items are labelled as such.

---

## 1. FILE CLASSIFICATION — cohesion & naming

### 1.1 `packages/cli/src/cli.ts` (1334 LOC) — **P1, needs split**
One file mixes six concerns. Concrete evidence:

| Concern | Lines | Evidence |
|---|---|---|
| top-level flag/env helpers | 35–86 | `webhookOf` (35), `roomToUrl` (41), `parseDanmu` (49), `toggledNotifier` (75) |
| record / danmu-only / probe commands | 107–309 | `.command("record")` (108), `danmu-only` (232), `probe` (278) |
| merge / burn / upload commands | 311–514 | (312), (413), (488) |
| **the whole hub wiring** (`hubStarter.start`, ~590 LOC) | 563–1139 | `const hubStarter: HubStarter = {` (563) → `};` (1140) |
| task/cookie command mounts + `/proc` scanning + 6 hidden remote commands | 1141–1327 | `buildTaskCommand(...)` (1146), `scanRecordingRooms` (1169), `_is-done` (1205) … `_apply-tasks` (1290) |

`hubStarter.start` alone (563–1139) is bigger than any file in `packages/orchestrator` except `workflow.ts`/`pipeline.ts`, and it is where the four duplicated `ffprobe` closures, the `buildTransports` factory, `syncTasks`, `retryNode` and `refreshRecordingStatus` live. This is a *composition-root* concern that happens to be pasted into the CLI file.

Proposed layout:
```
packages/cli/src/
├── index.ts            # program construction + parseAsync (thin)
├── commands/
│   ├── record.ts       # record / danmu-only / probe
│   ├── merge.ts        # merge   (+ scanSegmentsIntegrity / scanOutputTailIntegrity / dateNameOf)
│   ├── burn.ts         # burn    (+ probeDim)
│   ├── upload.ts       # upload
│   └── internal.ts     # _is-done / _recording-status / _inventory / _disk / _tasks / _apply-tasks
│                       #   + scanRecordingRooms + roomRecordingAlive (the /proc scan is one job)
├── hub/
│   ├── hub-starter.ts  # HubStarter object: start/testWorker/probeAllWorkers
│   ├── recording-status.ts  # refreshRecordingStatus + hubRecordingSnapshot + statusTransports cache
│   ├── task-sync.ts    # desiredFor + syncTasks (+ the hubSync reentrancy guards)
│   └── retry-node.ts   # retryNode + retryingKeys
└── helpers.ts          # ffprobeAdapter (single copy), roomToUrl, parseDanmu, toggledNotifier
```

### 1.2 `packages/app/src/web/api.ts` (1132 LOC) — **P1, needs split**
`makeApi()` (380–1132) is a single closure returning 48 handler methods across 4 unrelated domains, plus 14 module-level helpers. Domain boundaries are already visible in the method order:

| Domain | Handler lines | Count |
|---|---|---|
| task CRUD + start/stop + recordings + merge | 542–725, 876–943 | ~18 |
| cookies / login / biliup auth | 726–788 | ~8 |
| settings (webhook, notif, version, mesio, timezone) | 789–875 | ~10 |
| hub rules / jobs / workers | 944–1131 | ~18 |

Proposed layout:
```
packages/app/src/web/
├── api.ts               # Api type + makeApi() = thin composition returning a merged object
├── handlers/
│   ├── tasks.ts         # makeTaskHandlers(ctx)
│   ├── cookies.ts       # cookies + login (+ parseCookieExpiry, hasSessionCookie, cookieStatus)
│   ├── settings.ts      # webhook/notif/version/mesio/timezone
│   └── hub.ts           # rules/jobs/workers (+ hubRuleView, validateWorkers, validatePipeline, recordingError)
├── ctx.ts               # shared ApiContext {store, manager, hubDir, deps...} + view()/detailView()
└── cookie-util.ts       # parseCookieExpiry / hasSessionCookie  (see §2 — also imported by cli-task)
```
`parseCookieExpiry` currently lives in the HTTP-handler module and is dynamically imported by `cli-task.ts:662` purely to reach it (`const { parseCookieExpiry } = await import("./web/api.js")`) — a clear sign it belongs in a shared `cookie-util.ts`.

### 1.3 `packages/app/src/cli-task.ts` (866 LOC) — **P1, needs split**
`buildTaskCommand` (252–806) contains the `serve` action (513–791) which itself owns **four independent watchdogs**:
- record-start/end observer `recWatch` (615)
- disk watchdog `diskWatch` (635)
- cookie-expiry watchdog `checkCookieExpiry` (660)
- a_bogus canary `canaryWatch` (691–708)

Proposed: `app/src/serve/{serve.ts, watchdogs.ts, hub-deps.ts}`; keep `buildTaskCommand` as the command-shell only. `buildSessionForTask` (76) + `roomToUrl` (64) + `resolveHubConfigJson` (29) are fine where they are.

### 1.4 Correctly named / cohesive (no action)
`app/src/scheduler.ts` (pure window math), `app/src/timezone.ts`, `app/src/task-input.ts`, `app/src/paths.ts`, `app/src/task-sync.ts`, `app/src/hub-store.ts`, `app/src/worker-store.ts`, `app/src/merge-jobs.ts`, `app/src/stream-cookies.ts`, `orchestrator/src/select.ts|identity.ts|gaps.ts|format.ts|retry.ts|trigger.ts|ledger.ts|transport*.ts`, `orchestrator/src/hub.ts` (86 LOC). These are single-purpose and well named.

### 1.5 Borderline
- `packages/orchestrator/src/workflow.ts` (725) mixes the DAG executor (`runWorkflowNodes`, 559–722), the **node builder** `buildWorkflow` (82–294), and the **ResourcePool** (409–532). Three jobs; splitting into `workflow-build.ts` / `workflow-run.ts` / `resource-pool.ts` would help but is not urgent (**P2**).
- `packages/orchestrator/src/pipeline.ts` (640) holds `runPipeline` (225), `runPipelineInner` (257–521), `resumeAppends` (526), **plus** the cleanup primitives that `segment-pipeline.ts` imports (`videoOnly` 39, `xmlKeepRule` 54, `defaultSplitForUpload` 138, `defaultRmStage` 144, `readdirSyncSafe` 153, `cleanupSourcesShared` 169). The cleanup/keep-rule vocabulary is a shared concern of both pipelines and should live in its own `cleanup.ts` (**P2**).

---

## 2. CODE DUPLICATION

### 2.1 `ffprobe` adapter closure copied **4×** in `cli.ts` — **P1 (confirmed)**
Identical 5-line async closure at:
`packages/cli/src/cli.ts:621`, `:1098`, `:1121`, `:1245`
```ts
const ffprobe = async (file: string) => {
  const { durationMs } = await ffprobeVideo(file).catch(() => ({ durationMs: 0 }));
  const endMs = statSync(file).mtimeMs;
  return { durationSec: durationMs / 1000, endMs, startMs: endMs - durationMs };
};
```
Byte-identical at all four sites (machine-verified). Fix: one `makeFfprobeAdapter()` helper.

### 2.2 `sanitizeKey(streamKey) = key.replace(/[:/]/g, "_")` — **4 hand-rolled copies** — **P1**
- `orchestrator/src/pipeline.ts:133` (the canonical `sanitizeKey`, module-private)
- `app/src/hub-jobs.ts:61` (re-implemented; used at `:137` to locate the exact `job.log` that `pipeline.ts:220` writes)
- `cli/src/cli.ts:794` (inlined) and `cli/src/cli.ts:981` (inlined)

Two independent implementations must agree or `jobLogPath` silently misses the log `pipeline` wrote. Promote one exported `sanitizeStreamKey` to `@drec/core` and delete the other three. (Comment at `cli.ts:792` explicitly acknowledges the coupling: "sanitize 规则与 pipeline 内 sanitizeKey 一致".)

### 2.3 `sanitizeSeg` duplicated verbatim — **P1**
`app/src/web/api.ts:145` is a byte-for-byte copy of `record-engine/src/index.ts:52 sanitizePathSegment`. The api copy carries an eslint-disable comment for a rule that cannot be evaluated (no ESLint in this repo). Fix: import `sanitizePathSegment` from `@drec/record-engine` (already a dependency of `app`).

### 2.4 `splitToSizeLimit` lazy-import wrapper duplicated — **P2**
`orchestrator/src/pipeline.ts:138 defaultSplitForUpload` and `orchestrator/src/workflow.ts:299 splitToSizeLimitSafe` are the same one-liner; `workflow.ts` even ignores the already-exported `defaultSplitForUpload` and even ignores the injected `deps.splitForUpload` at `workflow.ts:343` (`c.deps.splitForUpload ?? splitToSizeLimitSafe`). Fix: import `defaultSplitForUpload`.

### 2.5 byte-sum helpers duplicated — **P2**
`orchestrator/src/format.ts:22 sumBytes()` and `orchestrator/src/workflow.ts:304 sumBytesOf()` are the same reduce. Remove `sumBytesOf`, use `sumBytes`.

### 2.6 `sh -c` logger wrapper duplicated **3×** — **P2**
`pipeline.ts:264`, `workflow.ts:108` (`ctx.sh`), `segment-pipeline.ts:132` — each is `jlog("$ cmd") → await deps.sh → jlog("✓ 完成(Ns)") → jlog("输出尾: …slice(-2048)")`. This is additionally duplicated across the **package boundary** into the injected `sh` in `cli.ts:764`.

### 2.7 Prior-audit claim **VERIFIED (in current form)**: `pipeline.ts` vs `app/hub-jobs.ts`
The early-audit note "duplicated utils between orchestrator/pipeline.ts and app/hub-jobs.ts" is real but is narrower than stated — it is exactly **`sanitizeKey` + the `<stageDir>/<sanitizedKey>/job.log` layout** (§2.2). Both sides re-derive the same path independently:
- writer: `pipeline.ts:220` `appendFileSync(path.join(stageSub, "job.log"))` and `cli.ts:794` FileLogger for the same path
- reader: `hub-jobs.ts:136 jobLogPath()` and `hub-jobs.ts:124 hubStageDir()`

Note the *duplication of the stageDir-resolution rule* also lives in 2 places: `hub-jobs.ts:124 hubStageDir()` reads `hub.config.json.stageDir ?? rootStageDir()`, while `cli.ts:797/822` re-implement `hubCfg.stageDir ?? rootStageDir()`.

### 2.8 `roomToUrl` duplicated across package boundary — **P2**
`cli/src/cli.ts:41` (module-private) and `app/src/cli-task.ts:64` (exported, unused by cli.ts). CLI re-implements instead of importing.

### 2.9 `ffprobe` helper duplicated between `cli.ts` and the transports — **P2**
The same "durationMs via ffprobe + mtime → startMs/endMs" adapter appears in `cli.ts` (4×) and is the documented contract of `orchestrator/src/scan.ts:37 FfprobeAdapter` / `transport-local.ts`. One factory in orchestrator would cover all 4 CLI sites.

### 2.10 prior claim "app re-exports observability" — **VERIFIED, benign**
`app/src/index.ts:23–31` re-exports `makeNotifier/NullNotifier/formatMessage/…` from `@drec/observability`, and `cli.ts:28` imports them from `@drec/app`. This is a deliberate convenience seam, not dead code; it does add an extra indirection but the observability port lives in core, so the layering test is satisfied.

---

## 3. LAYERING & PACKAGE STRUCTURE

### 3.1 Rank layering is respected — **PASS (confirmed)**
`test/arch/layering.test.ts` passes on HEAD. Every `@drec/*` dependency sits strictly below its dependent:

| Package | rank | `@drec` deps (all lower) |
|---|---|---|
| app | 4 | core(0), observability(0.5), post-process(0), tui(0), record-engine(1), douyin-live(1.5), manager(3) |
| orchestrator | 4.5 | core(0), post-process(0) |
| cli | 5 | core, observability, manager, post-process, record-engine, douyin-live, bilibili-live, kuaishou-live, **app(4)**, **orchestrator(4.5)** |

`orchestrator` does **not** depend on `app` (verified: `rg '@drec/app' packages/orchestrator` → no hits). The `app`(L4) → `orchestrator`(L4.5) inversion is deliberately undone by injecting a `HubStarter` interface through `cli` (comment at `cli-task.ts:213`). Correct.

### 3.2 Programmatic layering gap the arch test **misses** — **P1**
`test/arch/layering.test.ts` only reads `package.json` `dependencies`. `packages/app/src/cli-task.ts:697` does
```ts
const { getInfo, extractRoomSlug } = await import("@drec/douyin-live");
```
which is *declared* (`app/package.json` lists `@drec/douyin-live`) and rank-legal (1.5 < 4), so this specific case is fine. But the test never inspects source, so an **undeclared** import would slip through. My own source-vs-manifest scan (all `from "@drec/x"` / `import("@drec/x")` in `packages/*/src` vs declared deps) found **zero undeclared** imports — so the tree is currently clean, but the guard is weaker than it looks (**P2**: add a source-import scan to the arch test).

### 3.3 `app` is mis-sized / responsibilities bleed downward — **P1**
`@drec/app` (L4) is declared as "有状态服务层 (db + 调度 + web)" but actually owns **business policy** that is not state:
- `web/api.ts:948 listHubRules` + `:1088` worker→rule-reference check + `activateRetry` fan-out: hub *policy*, not HTTP plumbing.
- `web/api.ts:1035 getHubJobLog` / `:1022 listHubJobs` read the **orchestrator ledger sqlite directly** (documented in `hub-jobs.ts:1–10` as "表结构即契约"). That is an intentional L4←L4.5 back-channel: `app` now depends on orchestrator internals without importing it. It is the single most fragile coupling in the tree — any DDL change in `orchestrator/src/ledger.ts` silently breaks L4 reads.
  - **Suggested change (P1):** move the ledger read-model (`hub-jobs.ts`, `activeHubJobKeys`, `deleteHubJobHistory`) into `orchestrator` (L4.5) and expose a *typed* read API; `app/web` calls that. This also removes the need for `core/src/hub-ledger-contract.ts` to exist purely as a shared-string crutch.
- `app/upload/biliup.ts` (297 LOC) — biliup CLI wrapper is arguably a **process adapter**, closer in spirit to `record-engine`/`post-process` (L1) than to "state". It is only used by the hub pipeline. **P2:** consider `packages/biliup-upload/` (L1.5-ish) so `app` shrinks and the upload vocabulary stops living next to task state.

### 3.4 `app`(4) vs `orchestrator`(4.5) split is sensible, with one misfile — **P1**
The split is right in principle: `app` = per-node state (tasks/db/daemon/web), `orchestrator` = cross-node choreography. But the current seam leaks both ways:
- **app reads orchestrator's DB** (§3.3).
- **orchestrator's node builders shell out to `node dist/douyin-rec.mjs …`** (`workflow.ts:158,169,180`) — orchestrator knows the master CLI's product layout. That is arguably correct (the CLI is the orchestrator's own interface at L5), so leave it.
- **CLI hub-wiring (L5) contains logic that belongs in orchestrator (L4.5):** `cli.ts:916–955 syncTasks` (desired-task+apply loop, reentrancy merge) and `cli.ts:960–1062 retryNode` (stream-lock arbitration, upload-node hazard gate, ledger state transitions). Moving those two into `orchestrator` as injected-dependency functions would shrink `cli.ts` by ~200 LOC and put the state machine next to `Reconciler` where it belongs. **P1.**

### 3.5 `worker-store` (L4) duplicates the hub.config.json shape that orchestrator also parses — **P2**
`app/src/worker-store.ts:15` and `cli.ts:580–583` each define `{workers?, tenants?}` shapes; `core/src/worker-contract.ts` defines a third. Three parses of one file. Consolidate the *type* in core (the `WorkerConfig` type already moved to `core/src/worker-contract.ts`) and let only `worker-store` parse.

### 3.6 Dependency hygiene: unused declared deps — **P2**
- `packages/app/package.json` declares `"ws"` and `"yaml"` — **neither is imported anywhere in `packages/app/src`** (verified). `ws` is used only by `douyin-live/src/danmaku/client.ts:16`; `yaml` only by `core/src/config.ts`.
- `packages/cli/package.json` declares `"yaml"` — **not imported in `packages/cli/src`**.
- **P2:** drop them. (Not a layering violation, but it inflates install and hides real ownership.)

---

## 4. DEAD CODE / BARREL HYGIENE

### 4.1 `packages/app/src/index.ts` — **29 of 53 exports are never imported through the barrel** — **P1**
Symbols re-exported by `app/src/index.ts` that **no** file imports *via* `@drec/app` (they are used elsewhere only via direct source imports or not at all):
`ApplyTasksResult, DEFAULT_ROOT, DEFAULT_TIMEZONE, DEFAULT_WEBHOOK_TOGGLES, HubJobEvent, HubJobView, HubRule, NotifKey, NullNotifier, Task, UploadOpts, WEBHOOK_TOGGLES_ENV, WorkerConfig, applyTimezone, buildAppendArgs, buildUploadArgs, fetchAnchorName, formatMessage, hubStageDir, isValidTimezone, jobLogPath, listHubJobs, parseBV, readHubJobLog, resolveShortUrl, resolveTaskCookies, resolveWebhookToggles, uploadThenAppend, uploadThenAppendGroups`.
The only consumers of the barrel are `cli.ts` (24 named imports) and nothing else. Recommended: split into `index.ts` (the 24 genuinely used) + an internal `barrel-internal.ts` used only by in-package tests, or just trim. `hubStageDir`/`HubJobEvent`/`HubJobView` are referenced **only** by `index.ts` and their own module.

### 4.2 `packages/orchestrator/src/index.ts` — **12 of 26 exports never imported via barrel** — **P1**
`EndDebouncer, FfprobeAdapter, PipelineCleanup, PipelineDeps, PipelineSteps, ResourcePoolCfg, StageProducts, Workflow, WorkflowBuildInput, WorkflowNode, WorkflowRunOptions, WorkflowRunResult`.
`EndDebouncer` is a *value* export used only inside the package (`hub.ts:1`); `FfprobeAdapter`/`PipelineCleanup`/`PipelineSteps`/`ResourcePoolCfg`/`WorkflowBuildInput`/`WorkflowRunOptions`/`WorkflowRunResult` are referenced **only** by `index.ts` + their defining module. Trim.

### 4.3 Unused exports *within* modules — **P2**
`rootHubTaskConfig` (`app/src/paths.ts:63`), `planPartFilename` (`orchestrator/src/session-plan.ts:151`) have **zero** references anywhere (rg -w over `packages`/`test`/`scripts`). Delete or test-cover them.

### 4.4 Leftover migration shims — **P2**
- `app/src/store.ts:16` `export type RecorderKind = EngineKind` — marked `@deprecated`, zero importers (`rg -w RecorderKind` → only its own definition).
- `cli.ts:583 tenants?:` + `cli.ts:659 workers ?? tenants` — the `tenants→workers` rename happened (`worker-store.ts:31 delete next.tenants`), yet the CLI still accepts the old key in the `--hub-config` JSON path.
- `cli.ts:594 uploadMeta` retained as an alias for `uploadDefaults` (`:744`).
- `paths.ts:53 rootHubConfig()` falls back to legacy `hub-config.json`.
These are intentional back-compat, but they have no expiry and no test asserting the legacy path still works. **P2:** keep the file-migration one (`paths.ts`), drop the two JSON-key aliases once VPS is confirmed migrated.

### 4.5 Dead `sync_parts` table not in the contract — **P2**
`core/src/hub-ledger-contract.ts:35 HUB_TABLE_NAMES` lists `sync_jobs, sync_job_events, sync_job_steps, sync_candidates, sync_node_states` — but `orchestrator/src/ledger.ts:94` also creates `sync_parts`. `hub-jobs.ts:97 deleteHubJobHistory` therefore runs `DELETE FROM ${table}` over 5 tables and **leaves `sync_parts` rows behind** after "删除某房间的全部历史 run". Either add `sync_parts` to `HUB_TABLE_NAMES` (one-liner) or accept orphan rows — but the contract comment claims to be the single source of truth for the table set.

### 4.6 No unused files — **PASS**
All 34 app src, 3 cli src and 17 orchestrator src non-test files have at least one importer (verified). No orphan modules.

---

## 5. EFFICIENCY (obvious only)

### 5.1 `cli.ts:919` builds a fresh `Map<id,Transport>` **once per worker, inside the loop** — **P1**
```ts
for (const w of loadWorkers()) {
  const t = buildTransports().get(w.id);   // rebuilds the whole map each iteration
```
`buildTransports()` (`cli.ts:738`) calls `loadWorkers()` → `workerStore.listWorkers(rootHubConfig())` → `readFileSync`+`JSON.parse` of `hub.config.json`. So an N-worker sync does **N full map rebuilds + N×N registry factory calls**. Fix: hoist `const ts = buildTransports();` above the loop.

### 5.2 `refreshRecordingStatus` runs every **5 s** and SSH-probes every bound worker — **P1 (by design, but hot)**
`cli.ts:1078 setInterval(..., 5_000)`; each tick calls `transport.activeRecordingRooms()` which for `SshTransport` spawns a remote `node … _recording-status` process (`transport-ssh.ts:127`), and re-reads `hub.config.json`+`hub/rules/*.json` twice (`:673`, `:699`). With the documented "docker container 279 processes / VPS fork failures" history, a 5 s cadence with N bound workers is ~12·N remote `node` spawns/min. **P2:** raise to 15–30 s, or gate on "any hub job in progress".

### 5.3 `hubStageDir()` re-reads + `JSON.parse`s `hub.config.json` **on every ledger-page request** — **P1**
`app/src/hub-jobs.ts:124 hubStageDir()` does `readFileSync`+`JSON.parse` of `hub.config.json` each call; it is invoked as a *default parameter* by `deleteHubJobHistory`(97), `jobLogPath`(136), `listHubJobs`(192) and `readHubJobLog`(280). `listHubJobs` also calls `jobLogPath` **once per row** (`:270 hasLog`). A 20-row page ⇒ 20 config reads. Fix: resolve `stageDir` once in `makeApi()` (`deps.stageDir ?? hubStageDir()`) and pass it down (the signatures already accept `stageDir`).

### 5.4 `readHubJobLog` reads the **whole** job.log then slices — **P2**
`app/src/hub-jobs.ts:283–285`: `statSync` then `readFileSync(p)` (entire file) then `subarray(size - tailBytes)`. job.logs can reach MBs (biliup output is "MB 级", per `cli.ts:763`). Use an fd + `read` of the last 64 KB.

### 5.5 `listHubJobs` N+1-ish per row (4 prepared statements × rows) — **P2**
`hub-jobs.ts:213–272`: for each of `limit` jobs it runs separate selects against `sync_job_events`, `sync_job_steps`, `sync_candidates`, `sync_node_states` (+`existsSync` per row). Acceptable at `limit=20`; if the page grows, batch with `WHERE streamKey IN (...)`.

### 5.6 `api.ts:474/480 hubRuleView` calls `store.listTasks()` **twice per rule** — **P2**
`hubRuleView` is mapped over every rule (`api.ts:948`), and each call does `store.listTasks()` at both `:474` and `:480` (sqlite `SELECT *` + full row mapping). With R rules that is 2R full-table reads per `GET /api/hub/rules`. Hoist `const tasks = store.listTasks()` once per `listHubRules` request.

### 5.7 `reconciler.settleAll` probes isDone **sequentially** — **P2**
`reconciler.ts:178–196` awaits `transport.isDone(roomSlug)` inside a serial `for` over all pending members. For `SshTransport` each is a remote `_is-done` spawn. With M members one round = M sequential SSH round-trips before the poll interval. `Promise.all` the round (the disk watchdog at `:110` already does).

### 5.8 `scanRecordings` spawns one ffprobe per segment, serially, per anchor — **P2 (acknowledged)**
`orchestrator/src/scan.ts:63–70` awaits `ffprobe()` per `.ts` inside a serial loop, for every anchor × every session. `_inventory` is invoked by every reconcile round over SSH, so per-node cost scales with total segment count. Bounded parallelism (e.g. 4) or caching `(path,mtime)→duration` would cut it.

### 5.9 No sync-IO-in-request-path hotspots found beyond §5.3 — **PASS-ish**
`web/api.ts:881/903` `readdirSync(dir)` only on two explicit endpoint calls; `static-html.ts:117–120` `existsSync`+`statSync`+`readFileSync` per static asset (acceptable, assets are cached-immutable). `db/store.ts` is `node:sqlite` synchronous by design.

---

## Summary table

| # | Finding | Severity | File(s) |
|---|---|---|---|
| 1.1 | `cli.ts` mixes 6 concerns; hub wiring ~590 LOC | P1 | `packages/cli/src/cli.ts` |
| 1.2 | `web/api.ts` = 48 handlers in one closure | P1 | `packages/app/src/web/api.ts` |
| 1.3 | `cli-task.ts` serve action owns 4 watchdogs | P1 | `packages/app/src/cli-task.ts` |
| 2.1 | `ffprobe` closure ×4 | P1 | `cli.ts:621,1098,1121,1245` |
| 2.2 | `sanitizeKey` ×4 (2 impls) | P1 | `pipeline.ts:133`, `hub-jobs.ts:61`, `cli.ts:794,981` |
| 2.3 | `sanitizeSeg` verbatim copy | P1 | `web/api.ts:145` vs `record-engine:52` |
| 2.4 | `splitToSizeLimit` wrapper ×2 | P2 | `pipeline.ts:138`, `workflow.ts:299` |
| 2.5 | `sumBytes`/`sumBytesOf` | P2 | `format.ts:22`, `workflow.ts:304` |
| 2.6 | `sh` logger ×3 + boundary | P2 | `pipeline.ts:264`, `workflow.ts:108`, `segment-pipeline.ts:132` |
| 2.7 | prior claim verified: sanitizeKey+job.log path | P1 | `pipeline.ts` ↔ `hub-jobs.ts` |
| 2.8 | `roomToUrl` ×2 | P2 | `cli.ts:41`, `cli-task.ts:64` |
| 2.9 | ffprobe adapter in transports + cli | P2 | `cli.ts`, `scan.ts:37` |
| 3.1 | layering test passes | — | — |
| 3.2 | arch test doesn't scan source imports | P2 | `test/arch/layering.test.ts` |
| 3.3 | app L4 reads orchestrator ledger sqlite directly | P1 | `hub-jobs.ts`, `web/api.ts:1022+` |
| 3.4 | hub sync/retry state machine lives in cli L5 | P1 | `cli.ts:916–1062` |
| 3.5 | hub.config.json parsed in 3 places | P2 | `worker-store.ts`, `cli.ts:580`, `core` |
| 3.6 | unused declared deps (`ws`,`yaml`) | P2 | `app/package.json`, `cli/package.json` |
| 4.1 | 29/53 app barrel exports unused | P1 | `app/src/index.ts` |
| 4.2 | 12/26 orchestrator barrel exports unused | P1 | `orchestrator/src/index.ts` |
| 4.3 | `rootHubTaskConfig`, `planPartFilename` unused | P2 | `paths.ts:63`, `session-plan.ts:151` |
| 4.4 | migration shims w/o expiry (`RecorderKind`, `tenants`, `uploadMeta`) | P2 | `store.ts:16`, `cli.ts:583,594` |
| 4.5 | `sync_parts` missing from `HUB_TABLE_NAMES` | P2 | `hub-ledger-contract.ts:35` vs `ledger.ts:94` |
| 5.1 | `buildTransports()` inside worker loop | P1 | `cli.ts:919` |
| 5.2 | 5 s SSH status poll | P2 | `cli.ts:1078` |
| 5.3 | `hubStageDir()` config read per call/row | P1 | `hub-jobs.ts:124,270` |
| 5.4 | `readHubJobLog` reads full file | P2 | `hub-jobs.ts:283` |
| 5.5 | `listHubJobs` per-row queries | P2 | `hub-jobs.ts:213` |
| 5.6 | `hubRuleView` calls `listTasks()` 2× per rule | P2 | `web/api.ts:474,480` |
| 5.7 | `settleAll` serial isDone | P2 | `reconciler.ts:178` |
| 5.8 | `scanRecordings` serial ffprobe | P2 | `scan.ts:63` |
