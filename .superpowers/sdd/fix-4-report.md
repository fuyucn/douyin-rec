# fix-4 report: ssh 远端清单实装

## scanRecordings

- **Location**: `packages/orchestrator/src/scan.ts`
- **Signature**: `export async function scanRecordings(recordingsDir: string, taskRooms: Record<string, string>, ffprobe: FfprobeAdapter): Promise<NodeRecording[]>`
- `FfprobeAdapter = (file: string) => Promise<{ durationSec: number; startMs: number; endMs: number }>`
- Exported from `packages/orchestrator/src/index.ts` as `scanRecordings` and `FfprobeAdapter`

## `_inventory` command behavior

- Added to `packages/cli/src/cli.ts` as a hidden commander subcommand: `program.command("_inventory <dataRoot>", { hidden: true })`
- Opens slave's db at `<dataRoot>/db/douyin-rec.db` via `TaskStore(dbPath)` (new in `@drec/app` index export)
- Builds `taskRooms` by iterating `store.listTasks()` → `platformForRoom(room).extractRoomSlug(room)` for both `task.name` and `task.anchorName`
- ffprobe adapter: `ffprobeVideo(file)` from `@drec/post-process` + `statSync(file).mtimeMs` for mtime-based `endMs`; `startMs = endMs - durationMs`
- Calls `scanRecordings(<dataRoot>/recordings, taskRooms, ffprobe)` (dynamic import `@drec/orchestrator`)
- Outputs `JSON.stringify({ recordings })` to stdout

## Remote command string

`node <dataRoot>/dist/douyin-rec.mjs _inventory <dataRoot>`

Built as: `const nodePrefix = this.o.remoteNode ?? \`node ${this.o.dataRoot}/dist/douyin-rec.mjs\``; then `\`${nodePrefix} _inventory ${this.o.dataRoot}\`` — passed to `this.run(["bash", "-lc", cmd])`.

`SshOpts.remoteNode?` allows override of the `node <path>` prefix.

## TaskStore ctor used

`new TaskStore(dbPath: string)` — constructor signature is `constructor(dbOrPath?: DatabaseSync | string)`. `TaskStore` now exported from `@drec/app` (added to `packages/app/src/index.ts`).

## Changes summary

| File | Change |
|------|--------|
| `packages/orchestrator/src/scan.ts` | NEW — shared `scanRecordings` function |
| `packages/orchestrator/src/scan.test.ts` | NEW — 4 unit tests |
| `packages/orchestrator/src/transport-local.ts` | Refactored to call `scanRecordings` |
| `packages/orchestrator/src/transport-ssh.ts` | Replaced stub with real `_inventory` command; added `remoteNode` opt |
| `packages/orchestrator/src/transport-ssh.test.ts` | +2 tests asserting command contains `_inventory` and `dataRoot` |
| `packages/orchestrator/src/index.ts` | Export `scanRecordings` + `FfprobeAdapter` |
| `packages/app/src/index.ts` | Export `TaskStore` + `Task` type |
| `packages/cli/src/cli.ts` | Add hidden `_inventory <dataRoot>` subcommand |

## Results

- `pnpm typecheck`: **0 errors**
- `pnpm test`: **51 test files, 350 tests — all passed**
- `pnpm bundle`: **succeeds** (dist/douyin-rec.mjs 2.7mb)
- Targeted: `transport-ssh` (6 tests ✓), `transport-local` (3 tests ✓), `scan` (4 tests ✓)
