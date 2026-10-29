# AUDITOR B — Code-quality / architecture audit
Repo `video-screenshot` @ HEAD `a839948` (read-only audit; no files in the repo were modified).
Scope: `packages/core`, `manager`, `record-engine`, `post-process`, the 3 platform packages,
`observability`, `ffmpeg-recorder-extra`, `tui`, `packages/web`, `test/`.
Evidence: every claim below was re-checked with `rg -n` / `wc -l` in the committed source (commands run in `/tmp/audit-vs/`).

Legend: **P0** = must fix (breaks correctness/build). **P1** = real problem, should fix. **P2** = cleanup / drift risk / style-with-substance.

---

## 1. FILE CLASSIFICATION

### 1.1 Oversized files in my scope (>300 LOC)

| LOC | File | Verdict / concrete split |
|---|---|---|
| 1265 | `test/app/web-api.test.ts` | out of my package scope, but in `test/`: split by endpoint group (`tasks/`, `hub/`, `cookies/`) |
| 1226 | `packages/web/src/index.css` | keep single file, but delete the dead "kept for compatibility" block (`metric-*`, `log-panel`, 8 unused classes — verified §5.4) |
| 600 | `test/session.test.ts` | split into `test/session/{lifecycle,drain,danmu,reconnect}.test.ts` |
| 545 | `packages/web/src/components/HubJobs.tsx` | **real**: 4 unrelated units in one file (see 1.3) |
| 506 | `packages/web/src/lib/i18n.tsx` | **real**, see 1.2 |
| 499 | `packages/web/src/modals/HubRuleDialog.tsx` | extract `previewTitle`/`TITLE_TOKEN_RE` (dup of core, §2.3) + 4 section components |
| 498 | `packages/web/src/modals/SettingsDialog.tsx` | extract 4 tabs (`AccountTab`/`WebhookTab`/`NotifTab`/`GeneralTab`); already 5 tab IDs at `:257-260` |
| 485 | `packages/record-engine/src/index.ts` | split `constants.ts` (`:24-36`), `polling-recorder.ts` (`:61-484`), `paths.ts` (`stamp` `:43`, `sanitizePathSegment` `:52`) |
| 447 | `packages/manager/src/index.ts` | split `recording-session.ts` (`:26-428`) out of `index.ts`; `sessionXmlPath`+`delay` → `session-path.ts` (`:438-447`) |
| 392 | `packages/core/src/api-types.ts` | see 1.4 |
| 364 | `packages/douyin-live/src/danmaku/client.ts` | keep (mirrors upstream WS client, cohesive) |
| 364 / 349 / 338 / 312 | `web/src/pages/TaskList.tsx`, `TaskDetail.tsx`, `components/RoomDetail.tsx`, `modals/CreateEditTaskDialog.tsx` | borderline; TaskList `:96-112` metric filters + `:186-330` table → extract `<TaskTable/>`/`useTaskMetrics()` when next touched |
| 321 | `packages/kuaishou-live/src/stream/index.ts` | keep, but de-dup the codec picking (§2.2) |
| 309 | `packages/core/src/title-template.ts` | keep; un-export internals (§4.1) |

### 1.2 `packages/web/src/lib/i18n.tsx` (506 LOC) — verdict: **wrong file type + 3 responsibilities in one file**
- `:1-49` react-i18next init + `detectInitial` + `useLang` + `useT` (real code, ~50 LOC).
- `:53-496` two dictionaries `zh`/`en`, 464 keys each (verified: `zh`=464, `en`=464, key sets identical — good).
- `:499-506` side-effect `initReactI18next.init`.
- Verified it contains **zero JSX** (`rg -c '<[A-Za-z][A-Za-z0-9]*[ />]'` → 0), so the `.tsx` extension is wrong; it's renamed-to-`tsx` only by accident.
- **Suggested change**: `lib/i18n/index.ts` (init + hooks), `lib/i18n/dict.zh.ts`, `lib/i18n/dict.en.ts`, and drop `.tsx`. Add a tiny test that both dicts have identical key sets (currently only convention protects this).
- The 506 lines are *not* "doing too much" logically (it's a dictionary), but 29 keys are dead and one whole group was superseded (§5.2).

### 1.3 `packages/web/src/components/HubJobs.tsx` (545) — genuinely 4 files
Verified exports/units: `humanSec/humanSecFull` `:17,26`; `stateColor` `:56`; `runDate` `:65`; `TERMINAL` `:54`; `StepNode` `:133`; `CandidateNode` `:196`; `NODE_COLOR` `:72`; `ALL_STEP_KEYS(+type guard)` `:95-98`; `stepStatuses` `:101`; `PipelineFlowInner` `:238`; `PipelineFlow` (memo) `:369`; `RunCard` `:376`; `JobLogDialog` `:508`; `LatestRunBadge` `:534`.
Suggested split: `lib/hub-labels.ts` (`humanSec*`, `stateColor`, `runDate`, `stepLabelMap`, `TERMINAL`), `components/PipelineFlow.tsx` (`StepNode`/`CandidateNode`/`NODE_COLOR`/`ALL_STEP_KEYS`/`stepStatuses`/`PipelineFlowInner`+`PipelineFlow`), leave `RunCard`/`JobLogDialog`/`LatestRunBadge` in `HubJobs.tsx`.
Note `humanSec`, `humanSecFull`, `stateColor` have **no consumer outside this file** (verified) — they are use-before-export at `:17,26,56`.

### 1.4 core's `*-contract.ts` files — **well separated, keep them** (verified consumers across ≥2 packages)
| file | LOC | consumers outside core |
|---|---|---|
| `upload-contract.ts` | 48 | `app/src/upload/biliup.ts`, `app/src/cli-task.ts`, `orchestrator/src/pipeline.ts`, `cli/src/cli.ts` |
| `worker-contract.ts` | 26 | `app/src/worker-store.ts`, `app/src/task-sync.ts`, `orchestrator/src/transport*.ts` |
| `hub-ledger-contract.ts` | 37 | `app/src/hub-jobs.ts` (reads the same sqlite), `orchestrator/src/ledger.ts`, `web` (types) |
Each carries a "why it must live in core" header (`upload-contract.ts:1-6`, `worker-contract.ts:1-6`, `hub-ledger-contract.ts:1-7`) and each exists to break a real cycle (orchestrator L4.5 ⇄ app L4; app reads the ledger file directly). **Not fragmented — do not merge.**
One real fragmentation: `api-types.ts` mixes HTTP DTOs with **persisted-file schemas**: `HubPipelineConfig` (`:10-56`) and `HubRecordingConfig` (`:59-62`) are the on-disk shape written by `app/src/hub-store.ts:21-28` (`HubRule.pipeline`), not just wire types. Suggest `core/src/hub-rule-contract.ts` holding `HubPipelineConfig`/`HubRecordingConfig`/`HubRuleDTO`/`HubRulePayload`, leaving `api-types.ts` for the `/api/*` DTOs. (`api-types.ts` also re-exports `NotifyEvent` `:3-4` and re-exports ledger names `:391-392`.)

---

## 2. CODE DUPLICATION

### 2.1 P1 — `post-process` imports two runtime deps it does not declare
- `packages/post-process/src/ass/render.ts:2` → `import { XMLParser } from "fast-xml-parser"`
- `packages/post-process/src/ass/livechat.ts:5` → `const eaw = require("eastasianwidth")`
- `packages/post-process/package.json` has **`"dependencies": {}`** (verified).
- They resolve today only because they are hoisted from the **root** `package.json:28-29`. Under an isolated install (pnpm `--frozen-lockfile` on a filtered project, or a Docker stage that installs only this package) typecheck/bundle breaks.
- **Fix**: add both to `packages/post-process/package.json` dependencies. (Also drop the `require()` at `livechat.ts:5` in favor of `import` — the package is ESM.)

### 2.2 P2 — what is genuinely shareable between the 3 platform cores (verified, with line refs)
**Hoist (byte-identical / near-identical today):**
1. `roomToUrl` — same body 3×: `douyin-live/src/index.ts:38-41`, `bilibili-live/src/index.ts:27-30`, `kuaishou-live/src/index.ts:34-37` (`if (/^https?:\/\//.test(room)) return room; return \`https://HOST/${room}\``). Hoist a core helper `roomUrl(host, room, roomPrefix="")`; each platform keeps a 1-line binding.
2. Browser UA string — identical literal 3×: `bilibili-live/src/stream/index.ts:17-18`, `bilibili-live/src/danmaku/danmu.ts:26-27` (same package!), `kuaishou-live/src/stream/index.ts:37-38`. Hoist one `CHROME_UA` const into core (or at least reuse within bilibili-live).
3. `DanmuSource` health-watchdog policy — duplicated logic, not just text: silent-3-min watchdog + "alert ws error once" + `gotMsg/msgCount` logging: `douyin-live/src/danmaku/listener-base.ts:113-118, 149-151, 218-222, 245-252` vs `bilibili-live/src/danmaku/danmu.ts:84-88, 163-168, 199-200, 221-231` (both `SILENT_MS`/`DANMU_SILENT_MS = 180_000`). Hoist a small `DanmuHealthMonitor`/`alertOnce` helper into core (core already owns the `DanmuSource` contract, so no new axis); keep each platform's codec/transport.
4. `urlPattern` vs `matchUrl` must be kept in sync by hand in all 3 platforms (`douyin-live/src/index.ts:130-131`, `bilibili-live/src/index.ts:55-56`, `kuaishou-live/src/index.ts:41-44` — the comment at `:43` even says "必须与 matchUrl 同口径"). Cheap fix: a `test/arch/platform-urlpattern.test.ts` asserting `new RegExp(p.urlPattern).test(u) === p.matchUrl(u)` over a URL corpus.
5. Segment-suffix stripping regex — 2 divergent copies: `manager/src/index.ts:440` `/(?:-PART\d+|_\d{3,})$/` vs `post-process/src/concat.ts:19,43` `/(?:-PART\d+|_PART\d+|_\d{3,})$/`. Verified divergence: `x_PART001.ts` → manager base `x_PART001`, post-process base `x`. `concat.ts:14` claims "与一期 sessionXmlPath 同规则" — it isn't. Hoist one `segmentSuffixRe` into core.
6. Within `kuaishou-live`: `pickFromLiveStream` (`stream/index.ts:224-237`) and the page-path loop (`:296-304`) reimplement the same "h264 → hevc → hls fallback" chain; make the page path call `pickFromLiveStream`-shaped helper.

**Must stay platform-specific:** `extractRoomSlug` (3 genuinely different grammars incl. kuaishou's 3 paths + enterprise domain, `kuaishou-live/src/index.ts:24-31`), `getStream`/`getLiving` (different APIs, headers, throttle semantics), `connectDanmu` + all WS codec work (`douyin-live/src/danmaku/*`, `bilibili-live/src/danmaku/ws-codec.ts`+`wbi.ts`), `matchUrl`, quality tables (`DOUYIN_QUALITIES`, `BILIBILI_QUALITIES`, `KUAISHOU_QUALITIES`+`QUALITY_MAX_BITRATE`), kuaishou `warmup`/throttle (`stream/index.ts:88-107,197-210`).

### 2.3 P2 — web re-implements core's title-template engine
`web/src/modals/HubRuleDialog.tsx:98-125` re-declares `TITLE_TOKEN_RE` and the entire token→value map (`name/user/owner/title/part/parts/date/time/.../HHmmss`) that core already implements at `core/src/title-template.ts:123-155` (+ suffix rule `:256-258` re-implemented at `HubRuleDialog.tsx:122-124`). Token *sets* still match today, but any core token change silently desyncs the preview from the real output.
**Fix**: export a pure `previewTitle(template, sampleParts, kind)` from core's `title-template.ts` (no node deps) and alias it in `vite.config.ts` (same trick as the existing `@drec/contracts` alias); or at minimum add a shared test asserting both token sets are equal.

### 2.4 P2 — other same-scope dupes (verified)
- `web/src/modals/HubRuleDialog.tsx:88-95` `slugOfRoom()` duplicates `web/src/lib/labels.ts:81-88` `roomId()` (same regex + query strip). Use `roomId`.
- `tui/src/log-level.ts:9-17` and `web/src/lib/logLevel.ts:9-17` are byte-identical `classifyLogLine` bodies (only the file header comment differs). Because `@drec/tui` is rank 0 and `douyin-rec-web` is outside the workspace, neither can import core — the *content* is still a pure function that belongs in core; move it to `core/src/log-level.ts` (core is rank 0, and tui/web can both consume it).
- `app/src/web/api.ts:145-153` `sanitizeSeg()` is a byte-identical copy of `record-engine/src/index.ts:52-59` `sanitizePathSegment()` (out-of-scope file, but the duplication is of a function **my scope exports**, and the two must stay in lock-step per its own comment `:50-51`). Export/import instead of copying.
- `web/src/lib/notifications.ts:49-76` `describe()` and `tui/src/App.tsx:7-30` `eventLine()` both map `NotifyEvent.kind` → UI text; core already owns the mapping (`core/src/notify.ts:27-43` `notifKeyOf`, `observability/src/notifier/index.ts:53-65` `formatMessage`). At least share the kind→key table.

---

## 3. LAYERING & PACKAGE STRUCTURE

### 3.1 Dependency graph vs `test/arch/layering.test.ts` RANKS — **consistent at HEAD**
`RANKS` (`test/arch/layering.test.ts:21-38`) = core 0, observability 0.5, post-process/tui/ffmpeg-recorder-extra 0, record-engine 1, 3 platforms 1.5, manager 3, app 4, orchestrator 4.5, cli 5. Verified every `@drec/*` dep direction from each `package.json` matches (e.g. `record-engine` → `core`+`ffmpeg-recorder-extra` at 1 vs 0/0 ✔; `orchestrator`(4.5) → `core`+`post-process`(0) and **not** `observability` — it takes `ScopedLogger` from core and gets `FileLogger` injected at `cli/src/cli.ts` ✔). `npx vitest run test/arch/layering.test.ts` → 3 passed. `npx tsc --noEmit` → clean.
Two structural notes:
- **P2** `layering.test.ts:52` reads only `dependencies`; a new `@drec/*` edge added under `devDependencies` bypasses the guard. Read both fields.
- **P2** `core/src/job-abort.ts` (112 LOC) is *runtime* code, not a contract: module-level `Map`s + `process.kill` (`:22-24`, `:91-106`). It sits in core only because app(4) and orchestrator(4.5) share nothing lower. That forcing is reasonable — but core's header (`index.ts:1`) calls itself a pure-contract layer; either document the exception in `RANKS`/`index.ts` or move it to a `core/src/runtime/` subfolder so "pure contracts" stays true by convention.

### 3.2 Is `observability` at 0.5 sensible? — **yes, with one caveat**
It depends only on `@drec/core` and re-exports core's `Notifier`/`ScopedLogger` ports (`observability/src/index.ts:1-17`); manager/orchestrator deliberately don't depend on it (verified — no imports outside app/cli/test). 0.5 correctly encodes "above core, below everything else". Caveat: a half-rank is a smell that invites more fractions; put the rule in the `RANKS` comment ("fractional ranks are reserved for infrastructure-only layers that must sit *directly* above core") so the next contributor isn't guessing.

### 3.3 Web legitimately outside `@drec/*`? — **yes** (named `douyin-rec-web`, `packages/web/package.json:2`), but three rough edges
- It is excluded from the root workspace on purpose (`pnpm-workspace.yaml` `- "!packages/web"`, plus its own `packages/web/pnpm-workspace.yaml`) and from `tsconfig.json` (`exclude: ["packages/web"]`) — 2 lockfiles, by design; document it in the web README/package comment (the `pnpm-workspace.yaml` comment still says "the parent node CLI workspace at `ts/`" — stale path).
- **P2** `@drec/contracts` is **not a package** — it's only a Vite alias (`packages/web/vite.config.ts:10`) and a tsconfig path (`packages/web/tsconfig.app.json:12`), both pointing at another package's source file `../core/src/api-types.ts`. 4 files import it (`api/client.ts:36`, `lib/notifications.ts:11`, `components/HubJobs.tsx:6`, `modals/SettingsDialog.tsx:13`). It works, but: any editor/CI that doesn't read those two configs won't resolve it, and moving `api-types.ts` breaks the front end silently. Suggest either a real (types-only) package or a stable `core/src/contracts.ts` re-export entry whose path is the alias target.
- **P2** web has no dependency on the root workspace, so it can't import any *runtime* core helper — this is exactly why the title-template preview had to be re-implemented (§2.3).

### 3.4 Is `ffmpeg-recorder-extra` (101 LOC) too small to exist? — **keep, but rename**
Consumers (verified): `douyin-live/src/probe.ts:9`, `record-engine/src/index.ts:20`, tests. It exposes a real seam (`detectDevice`/`streamInfoLine`/`mapEncoder`/`logStreamMeta`) and has zero deps. Two observations:
- The name is misleading: nothing here is an ffmpeg *recorder* plugin — it is stream-metadata probing (`index.ts:1-13`). Suggest `@drec/stream-meta` (or fold into `douyin-live`, since `mapEncoder`/`streamInfoLine` parse Douyin `sdk_params` and the only `probe.raw` producer is `douyinPlatform.getStream` `douyin-live/src/index.ts:152`).
- Being pinned at rank 0 makes it unable to import `core`'s `createLogger`, so it inlines a logger (`index.ts:20-22`, with a comment admitting the layering cost). If it were rank 0.5 that hack disappears — concrete argument for reviewing that rank instead of the package's existence.

---

## 4. DEAD CODE / BARREL HYGIENE

### 4.1 core — exported but referenced nowhere outside core (verified by symbol scan)
- `title-template.ts`: `MAX_TITLE_LEN:6`, `TITLE_TOKENS:7`, `DEFAULT_TITLE_TIMEZONE:19`, `isSafeStem:53`, `parseSessionStamp:57`*, `zonedStamp:67`*, `resolveTitleParts:95`, `resolveTitlePartsWithLiveTitle:112`, `applyTitleTemplate:123`*, `sanitizeLiveTitle:163`*, `PartKind:253`, `partKindSuffix:256`, `TitleParts:27`, `TitleContext:41` — `*` = consumed only by the co-located `title-template.test.ts`. All other exports are used by `orchestrator/pipeline.ts`, `orchestrator/session-plan.ts`, `app/web/api.ts` (`formatBiliTitle`/`formatPartTitle`/`partTitleToFilename`/`resolveOutputStem`/`validateTitleTemplate`/`validateLooseTitleTemplate`). **Change:** un-export the internal-only ones (keep the public 6) so the package surface matches reality.
- `engine.ts`: `listEngines:63`, `engineNames:68`, `_resetEngines:73` — the first two are used only by `core/src/engine.test.ts:24-25`; `_resetEngines` only by that test. Either delete `listEngines`/`engineNames` or use them for the JSONAPI surface; `_resetEngines` is a legitimate test hook (keep, matching `_resetPlatforms`/`_resetJobAbort`).
- `job-abort.ts`: `currentJobKey:26`, `isAborted:34` are internal-only (used at `:35,69`). Un-export.
- `config.ts`: `AppConfig:4`, `DEFAULT_CONFIG:28` — only `loadConfig` is used outside (`cli/src/cli.ts:131`) and only `DEFAULT_CONFIG` is used by `core/src/config.test.ts`. Un-export (or keep `AppConfig` as the documented shape of `loadConfig`).
- `platform.ts:15` `DanmuConnectOpts` — referenced 0× outside core; it *is* the parameter type of the public `Platform.connectDanmu` so keep, but note it's part of core's public API by contract, not by usage.
- `api-types.ts:102` `HubJobStepDTO` — 0 references anywhere (web's `client.ts` import list omits it; the web reads `steps` via `HubJobDTO.steps` `:156`). Only referenced by the DTO itself. Keep (it types `HubJobDTO.steps`) but it does not need a *named* re-export.
- `hub-ledger-contract.ts`: `HUB_JOB_STATES:10`, `HUB_TERMINAL_STATES:18` (used by `app/src/hub-jobs.ts:14`), `HUB_STEP_NAMES:22`, `HUB_NODE_STATE_NAMES:31`, `HUB_TABLE_NAMES:35` (used by `app/src/hub-jobs.ts:57`), `HubTerminalState:19`. **Dead (0 refs anywhere):** `HUB_JOB_STATES`, `HUB_STEP_NAMES`, `HUB_NODE_STATE_NAMES`, `HubTerminalState`. The comment claims "集中在 core 避免各写一份漂移" but the three unused tables have already drifted from reality: `HUB_TABLE_NAMES` omits `sync_parts` while `orchestrator/src/ledger.ts:94` creates it (so `deleteHubJobHistory` at `app/src/hub-jobs.ts:109-112` never cleans it). **Fix:** add `"sync_parts"` to `HUB_TABLE_NAMES`, or delete the unused three and let `ledger.ts` be the single source.
- `upload-contract.ts:9,13,34,36,45` (`UploadLine`, `UploadOpts`, `APPEND_AMBIGUOUS_MARKER`, `isAppendAmbiguous`, `isUploadRateLimited`) — all consumed by app/orchestrator (verified) → keep.
- `worker-contract.ts:9,19` — consumed by app+orchestrator → keep. Note `WorkerConfig` (`:9-16`) and `api-types.ts:170` `WorkerDTO` are field-identical (`name` optional vs required); they are two spellings of the same shape (one persisted, one wire). Not a bug, but a `Pick`/alias would prevent drift.

### 4.2 post-process — barrel exports with no external consumer (verified)
`packages/post-process/src/index.ts:1-24` re-exports 34 names; 15 have **no reference outside the package**:
`buildRemuxArgs:7`, `SegmentStyle:7`, `mergeXmlContents:8`, `MergeXmlSession:8`, `MergeSessionInput:9`, `runFfmpeg:10`, `parseFfmpegErrors:13`, `parseFfmpegIssues:14`, `classifyFfmpegLine:15`, `TAIL_ALERT_MIN_PROBLEMS:20`, `MediaScanResult:21`, `ParsedIssues:22`, `planSizeSplit:24`, `buildSplitArgs:24`, `BILI_FILE_LIMIT_BYTES:24`.
Of those, `planSizeSplit`/`buildSplitArgs`/`BILI_FILE_LIMIT_BYTES` (`split.ts:6,20,33`) and `TAIL_ALERT_MIN_PROBLEMS` (`integrity.ts:149`) are used *only by their own co-located tests*; `classifyFfmpegLine`/`parseFfmpegIssues` are internal to `integrity.ts` (`:93,198`); `mergeXmlContents`/`MergeXmlSession` are internal to `merge.ts:44` (only the co-located test imports them); `buildRemuxArgs` is internal to `segment.ts:29` (test-only consumer); `runFfmpeg` is internal to `concat.ts:123,139` / `segment.ts:29` / `split.ts:61` / `burn.ts:106`.
**Change:** trim `index.ts` to the ~19 names actually consumed by orchestrator/app/cli (verified consumers: `splitToSizeLimit`, `scanMediaErrors`, `parseIntegrityWarnings/Alerts`, `formatScanLine`, `formatOutputVerdict`, `groupSessions`, `mergeSession`, `mergeSessions`, `renderXmlToAss/Livechat`, `renderSegmentsToAss`, `renderXmlWindowToAss`, `planSegmentGroups`, `remuxSegment`, `burn`, `FONTS_DIR`). Un-exporting also shrinks the public surface that the layering/packaging story must keep stable.

### 4.3 observability / tui / platforms
- **`observability/src/logger/composite.ts:4` `composite()` is dead in production** — its only references are the barrel (`index.ts:17`) and its own test (`logger/file.test.ts:6,35`). Nobody composes loggers in app/cli. Delete it (or start using it where `cli.ts` wires console+file).
- `observability/src/bus.ts:16` `AppEvent`, `:27` `EventCenterOpts`, `logger/ring.ts:25` `TaskLogStoreOpts` — exported types with no external consumer; `AppEvent` is superseded by core's `AppEventDTO` for the API. Keep `EventCenter`/`TaskLogStore`/`FileLogger`.
- `douyin-live/src/index.ts:20,21,24,25,49` (`DOUYIN_QUALITIES`, `DouyinQuality`, `DOUYIN_ENGINES`, `DouyinEngine`, `resolveDouyinWebRid`) and `danmaku/danmu-cookie.ts:52` `filterDanmuCookies` — referenced only inside the package. Un-export.
- `record-engine/src/index.ts:26,27,36` (`FAIL_ALERT`, `ALERT_REPEAT`, `STALL_EARLY_PROBE_SEC`) — internal only (tests import `POLL_MS`/`STALL_*`). Un-export the three.
- `tui/src/api.ts:7,22,34` (`TuiTask`, `TuiEvent`, `TuiApi`) and `bilibili-live/src/danmaku/ws-codec.ts:16,18,26,34,63` (`HEADER_LEN`, `OP`, `PROTOVER`, `encodePacket`, `ParsedFrame`) — package-internal + tests; fine to keep exported for tests, but they don't need to be in a *public* barrel.
- Stale paths in comments (no functional impact): `post-process/src/*.ts` all still start with `// ts/src/core/post/...` (`concat.ts:1`, `ffmpeg.ts:1`, `integrity.ts:1`, `ass/*.ts:1`); `test/notify/notifier.test.ts:1` `// ts/test/...`; `test/session.test.ts:10` imports `type { Notifier, NotifyEvent } from "../src/core/notify/notifier.js"` — a path that does not exist in this repo (verified `test/src` absent, `src/` absent) yet the suite passes because the import is **type-only and erased**. Delete the line; it will become a hard error the moment someone switches to `verbatimModuleSyntax`-strict or refactors that test.
- **Legacy shims:** `packages/record-engine/node_modules/@drec/douyin-core -> ../../../douyin-core` is a dangling symlink to a package that no longer exists (verified `ls -la`, and nothing imports `@drec/douyin-core`). Local install residue — `pnpm install` will drop it, but it's worth noting when reasoning about "which packages exist".

---

## 5. EFFICIENCY (obvious wins only)

### 5.1 P2 — `Intl.DateTimeFormat` constructed per call in the 2s render loop
`web/src/lib/tz.ts:7-12` `partsMap()` builds a **new** `Intl.DateTimeFormat` on every call; every other helper goes through it. Call sites inside per-row table rendering: `pages/TaskList.tsx:272-282` (`localScheduleTooltip` → `tzOffsetMinutes` → `partsMap` **twice** per row per render), `:126-138` (`localTimeTooltip`+`fmtTimeInTz`), `pages/TaskDetail.tsx:240-263`, `modals/CreateEditTaskDialog.tsx:249-253`. With the 2s list poll (`TaskList.tsx:53`) and ~20 tasks that is ~40+ `Intl` constructions every 2 seconds, for a value that only changes when `tz` changes.
**Fix:** memoize `Intl.DateTimeFormat` by `(tz|undefined, JSON key of opts)` in a module-level `Map` inside `tz.ts`.
Same pattern once per call in `core/src/title-template.ts:70` — it constructs a `DateTimeFormat` only to *validate* `tz` and then discards it, then constructs a second one at `:75`. Build one instance inside try/catch and reuse.

### 5.2 P2 — uncleared timers keep recording/pipeline processes alive
- `manager/src/index.ts:103-110` `notifyAwait()` races the notifier against `new Promise(r => setTimeout(r, 3000))` and **never clears** that timeout. After a fast webhook the pending 3s timer still holds the event loop → `stop()` (used by `cli` right before `process.exit`) can hang ~3s. Store the handle and `clearTimeout` in a `finally`.
- `core/src/job-abort.ts:99-105` `killChild()` schedules a 2s SIGKILL escalation that is not `unref()`'d (compare the correctly-unref'd timers in `record-engine/src/index.ts:309,347,365,397`). `unref()` it, or clear it when the child exits.

### 5.3 P2 — record-engine's probe alert reports the wrong elapsed time under throttling
`record-engine/src/index.ts:216` computes `Math.round((this.probeFails * POLL_MS) / 60000)` while the actual interval in use is `this.pollDelayMs` (`:99-101`, raised to `THROTTLE_POLL_MS` by kuaishou's `pollIntervalMs`, `kuaishou-live/src/index.ts:63`). The operator-facing message ("连续 N 次…约 X 分钟") understates the real gap by up to 10× on kuaishou. Use `this.pollDelayMs`.

### 5.4 P2 — duplicate/never-ending network work in the SPA
- `pages/HubPage.tsx:45` polls `listHubRules`+`listHubJobs` every 3s, `:54` polls `listWorkers` every 3s (a second, independent 3s timer), and `components/RoomDetail.tsx:102` polls `listHubJobs`+`listWorkers` again every 3-5s whenever a room is open. Collapse into one poller (or lift workers/jobs into atoms) — same endpoints fetched 2-4×/3s.
- `lib/hooks.ts:46-55` `usePolling` keeps firing in hidden tabs (no `document.hidden`/`visibilitychange` gate) — every page's 2-3s poll runs while the tab is backgrounded. One `if (document.hidden) return;` in the tick is enough.
- `core/src/engine.ts:63-70` `listEngines()`/`engineNames()` allocate a fresh array on each call and are unused in production (see §4.1) — delete rather than optimize.

### 5.5 Noted, deliberately not flagged
`kuaishou-live/src/stream/index.ts:88-107` `warmup()` sleeps 3-4s on every `getStream` (anti-bot by design) — but `getLiving` (`:314-321`) correctly bypasses it, so the authoritative liveness path stays fast. `usePolling`'s ref-based tick and the React Flow `pipelineSig` memo (`HubJobs.tsx:360-374`) are already the right optimizations for their problems.

---

## 6. CONTENT INVENTORY (verified) — i18n / labels / css dead weight
- `web/src/lib/i18n.tsx`: 464 keys per language, key sets identical (good). **29 keys dead** in both languages:
  `nav.notif`, `tasks.empty`, `tasks.startFailed`, `tasks.stopFailed`, `tasks.loading`,
  `settings.tabWebhook`, `settings.douyinPaste`, `settings.kuaishouPaste`, `settings.biliPaste`, `settings.notifSection`,
  `paste.placeholder`, `hub.common.enabledState`, `hub.common.disabledState`, `hub.common.uploadPublicSuffix`, `hub.common.uploadPrivateSuffix`, `hub.common.stageOnlySuffix`,
  `hub.page.viewRuns`, `hub.page.colRoom`, `hub.page.colOutput`, `hub.page.colLastRun`, `hub.page.colStatus`, `hub.page.colAction`, `hub.detail.noRunGraph`, `hub.jobs.stop`,
  `hub.workers.colKind`, `hub.workers.colHost`, `hub.workers.colStatus`, `hub.workers.colAction`, `hub.workers.statusFail`
  (definitions at `i18n.tsx:56,65,71,75,106,108,110,112,116,156,178,180,185,186,197,259,262`; verified 0 `t("…")` call sites outside `i18n.tsx`).
  Two of these are not merely dead — they are **lost translations**: `TaskList.tsx:82,92` shows `toast(errMessage(e), "error")` (raw server text) instead of the existing `tasks.startFailed`/`tasks.stopFailed`. Either use the keys or delete them.
- `web/src/lib/labels.ts:46` `QUALITY_OPTIONS` and `:61` `DANMU_LABEL` — 0 references (danmu labels come from i18n `danmuKind.*` at `Badge.tsx:130`; quality options come from `PlatformDTO.qualities` at `CreateEditTaskDialog.tsx:115-128`). Delete both.
- `web/src/index.css` — 8 classes with no reference in `src` (verified): `metric-card`, `metric-main`, `metric-label`, `metric-value`, `metric-value-sm`, `metric-value-mono`, `metric-icon` (block at `:757` is literally titled "kept for compatibility") and `log-panel`.
- `web/src/components/Switch.tsx` has no JSX either — it wraps Base UI with `ReactNode` return, so the extension is cosmetically wrong (same class of issue as `i18n.tsx`, harmless).

---

## 7. FINDINGS SUMMARY (P0/P1/P2)

**P0:** none found in this scope.

**P1**
1. `packages/post-process/package.json` declares **no** dependencies, yet `src/ass/render.ts:2` imports `fast-xml-parser` and `src/ass/livechat.ts:5` requires `eastasianwidth` (resolve only via root hoisting). Add both; convert the `require` to ESM `import`.

**P2**
2. `web/src/lib/i18n.tsx` — 506 LOC, no JSX, 3 responsibilities; split `lib/i18n/{index,dict.zh,dict.en}.ts` (§1.2) and delete the 29 dead keys (§6).
3. `HubJobs.tsx` (545) holds 4 units → split `lib/hub-labels.ts` + `components/PipelineFlow.tsx` (§1.3).
4. 3 platform cores duplicate `roomToUrl`/UA string/`DanmuSource` health-watchdog/suffix regex/urlPattern-vs-matchUrl; hoist per §2.2 while keeping url grammars + WS codecs platform-specific.
5. `test/arch/layering.test.ts:52` only reads `dependencies` (devDependency edges bypass the guard); add `"sync_parts"` to `HUB_TABLE_NAMES` or delete the three unused `HUB_*` tables (`core/src/hub-ledger-contract.ts:10,22,31` + `:19`).
6. `web/src/modals/HubRuleDialog.tsx:98-125` reimplements core's title-template engine; `:88` reimplements `labels.roomId` (§2.3/2.4).
7. `tui/src/log-level.ts:9-17` ≡ `web/src/lib/logLevel.ts:9-17` → move `classifyLogLine` into core (both are rank-0 consumers) (§2.4).
8. Timer leaks: `manager/src/index.ts:103-110` (uncleared 3s race timeout) and `core/src/job-abort.ts:99` (unref) (§5.2).
9. `record-engine/src/index.ts:216` uses `POLL_MS` instead of `pollDelayMs` in the operator alert (§5.3).
10. `web/src/lib/tz.ts:7-12` re-instantiates `Intl.DateTimeFormat` per row per 2s poll; memoize (§5.1).
11. `web/src/lib/hooks.ts:46-55` polls while tab hidden; gate on `document.hidden`; `HubPage`/`RoomDetail` poll the same endpoints 2-4×/3s (§5.4).
12. Barrel hygiene: `post-process/src/index.ts` re-exports 15 names with no external consumer (`split.ts`/`integrity.ts` internals) (§4.2); `observability/src/logger/composite.ts:4` `composite()` dead in production (§4.3); un-export internal-only core symbols (`title-template.ts` internals, `engine.ts:63,68`, `job-abort.ts:26,34`, `config.ts:4,28`) (§4.1).
13. `post-process`/`core` naming/doc drift: `// ts/src/...` headers stale; `test/session.test.ts:10` imports a nonexistent `../src/core/notify/notifier.js` (type-only, erased); dangling `@drec/douyin-core` symlink under `packages/record-engine/node_modules/@drec/` (§4.3).
14. `web` `@drec/contracts` is an alias-only pseudo-package reaching into another package's source (`vite.config.ts:10`, `tsconfig.app.json:12`, 4 importers) — make it a stable entry/real types-only package (§3.3). `ffmpeg-recorder-extra` name is misleading and its rank-0 placement forces an inlined logger (`index.ts:20-22`) (§3.4).
