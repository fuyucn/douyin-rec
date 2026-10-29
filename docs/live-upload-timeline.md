# Live upload run timeline

Read-only observability for 直播直传 (zero-disk). It never changes upload decisions.

## Contract

`packages/core/src/live-upload.ts` defines:

- phases: `streaming | sealing | submitting | confirmed | unconfirmed | failed`
- events: run start/resume, waiting/live, part streaming/sealed/submit/confirmed/unconfirmed/retry/failed, stalled/recovered, season pending/done/failed, run end
- `LiveUploadSnapshot`: the current archive, current part, parts and bounded events
- `LivePumpReporter`: `event()` and `progress()`; progress is in-memory only

`sessionId` is the archive identity (`room:LivePumpState.createdAt`). A restart that resumes the same archive emits `run_resume`; a different archive rotates current to previous. The tracker starts sessionless while waiting for a broadcast; `run_start` binds the first archive in place.

## Producer

`packages/zero-upload/src/live-pump.ts` emits only at existing state transitions. `run_start/run_resume` is emitted inside `openSession` immediately after the session is constructed and before recovery, so a stuck archive still has a session. A throwing reporter never changes `RunLivePumpResult`.

`packages/app/src/live-upload-reporter.ts` owns the file and the pure `LiveRunTracker`:

- path: `<dataRoot>/config/zero-disk/live/<platform>.<roomSlug>.json`
- shape: `{ v:1, platform, roomSlug, pid, updatedAt, current?, previous? }`
- writes are throttled to 5s; `run_start`, `run_end`, `part_confirmed` and `part_failed` flush immediately
- a non-terminal current with a dead pid reads as `stopped`; a finished/failed run stays terminal
- stale files are pruned with the same 30-day retention as receipts

## Transport and API

`_zero-disk-report` carries bounded `live` snapshots (100 events / 200 parts per snapshot). Full snapshots are attached only while non-terminal or for 24 hours after the run ends. The master keeps the last poll in `ZeroDiskFleet`.

- `GET /api/tasks` carries a compact `live` summary on each zero-disk worker entry.
- `GET /api/tasks/:id/live` returns `{ entries: [{ workerId, workerName, current?, previous? }] }`.
- Local detail is read directly from the node file, with hub on or off.
- Managed detail comes from the last fleet poll; list/detail requests do not run SSH.

## UI

`RoomPage` extends the existing zero-disk block with `LiveUploadTimeline`: current part, per-part phase/BV and the event list. Terminal runs fetch once; active runs poll every 10s. `QueuePage` builds an independent live-upload lane from the tasks query, because zero-disk runs never become live `QueueItemDTO` rows while streaming. The queue lane is hub-only and follows the existing 30s tasks refresh.

## Compatibility and failure semantics

- All new fields are optional; old nodes/status files render as unknown.
- Reporter I/O errors are swallowed and logged at most once per process.
- Upload results and `LivePumpState` are unchanged with or without a reporter.
- This view is read-only: no retry, ack, stop or delete actions.
