# Output layout: room directories (issues #333 - #336)

Recordings and stage session directories can be laid out per room so a directory is recognisable at a glance.
All path decisions live in one place: the output path resolver module in `packages/core`. Nothing else may
hand-build these paths (an arch guard test enforces it).

## Layouts

| What | Legacy (default) | Room layout (opt-in per node) |
| --- | --- | --- |
| Recordings | `recordings/<anchor>/` | `recordings/<anchor>_<platform>_<room>/` |
| Stage session | `stage/<platform>_<room>_<date>[_HHMM]/` | `stage/<anchor>_<platform>_<room>/<date>[_HHMM]/` |
| Session job log | `stage/<session>/job.log` (old sessions) | `logs/hub/<platform>_<room>/<session>.log` (all new sessions, since #334) |

## The switch

The `output-layout` JSON file in `<data root>/config/` containing `{"layout":"room"}`. Absent, unreadable or any other value means
legacy. It is a file (not an env var) because ssh-launched hidden commands do not inherit the service environment.
Each node has its own file, so a fleet can be switched node by node; a node that was not switched keeps the old
layout. The recorder reads it once at process start (a running session never changes directory), the hub
pipeline and the node pipeline read it per run.

Rollback: delete the file (or set another value). Directories already created in the room layout stay and keep
being found.

## Rules

- Lookup is by the `_<platform>_<room>` suffix. Node-side commands only know the streamKey, never the anchor
  name, so the anchor name is used only when a NEW room directory is created; the room number stands in when no
  name is known. An unknown name never fails anything. An anchor rename does not move a room.
- Several directories with the same suffix: the oldest wins and a warning is logged; no new one is created.
- Stage session directories are sticky: a session directory that already exists, in either layout, is reused,
  so a running session never moves and node results (the duplicate-upload guard) are always found.
- Old directories are history: never migrated, never deleted by the layout code. New recording sessions go to the
  room directory even if an old name directory for the same anchor exists.
- Hub clustering is by `(platform, room)` from the session sidecar; recordings without a sidecar take the room from
  the directory suffix, so sessions in an old and a new directory of the same room still form one broadcast.
- Maintenance (orphan cleanup) protects the active paths of both layouts; the merge page lists sessions of both.
- Name part: NFC-normalised, illegal characters removed (the rule recorders always used), at most 120 UTF-8 bytes.

## Rollout order

resolver (#333) -> job logs out of stage (#334) -> empty stage dir removal (#335) -> room layout (#336).
Switch one node, check a recording and a stage run, then the rest.
