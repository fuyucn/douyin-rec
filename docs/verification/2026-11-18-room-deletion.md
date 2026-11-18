# Room deletion closeout verification

Issues: #701 (T-225), #702 (T-226), #439 (T-133), and #587 (T-228).

## Deployed artifact

On 2026-11-18, the controller and both workers reported `0.0.393-fa1229`.
All three installed bundles had the same SHA-256 (concatenate the groups):

```text
b6ff a8d6 6129 b85a 539e bff3 5308 5f75 9f98 24b1 b063 d6ae 31c5 3364 4c96 b6e2
```

The controller image digest was (concatenate the groups after the algorithm):

```text
sha256: fdd3 8ecc 83f6 95dd 0b34 88e8 c43d 6240 8106 58aa 3d88 61bf d858 0793 6f4a 12f7
```

PR #441 supplied the complete-room deletion endpoint and editor action. PR #706
added literal identity isolation; PR #707 added fail-closed guards and the transactional
writer recheck. All three merge commits are ancestors of the verified source baseline,
`470485f8`. The two recent PRs have successful required checks.

## Verification executed

```text
pnpm test
Test Files 367 passed | 1 skipped (368)
Tests      5468 passed | 42 skipped (5510)
Duration   105.52s
exit 0

pnpm typecheck
exit 0

pnpm arch:check
architecture.html + architecture.md structure matches
exit 0

Focused room-history, guard, endpoint, and job-view regression run
Test Files 5 passed
Tests      362 passed
exit 0
```

The exact deployed image was also run with no external network, a read-only image,
temporary in-memory data roots, and no production mounts or credentials. A separate
real CLI `task serve --hub --no-schedule` instance handled HTTP requests; its process
exited cleanly. The locally retained verification script checked the bundle digest
before starting the instance.

The retained verification script SHA-256 was (concatenate the groups):

```text
727f bced 4f76 7620 da7d 5450 23a3 db2d e88f 31c4 959b efff c3a6 37d5 4854 087a
```

The execution command below uses the unambiguous short ID of the verified immutable image:

```bash
docker run --rm -i --name drec-p0-393-smoke --network none --read-only \
  --tmpfs /output-data:rw,nosuid,nodev --tmpfs /tmp:rw,nosuid,nodev \
  --entrypoint node \
  fdd38ecc83f6 \
  --input-type=module < p0-393-smoke.mjs
```

Complete final output:

```text
PASS deployed bundle hash and version 0.0.393-fa1229
PASS #701 six tables and both log locations: target removed; adjacent room and other platform preserved
PASS #702 both routes: active/unknown 409, malformed ledger 503; all fixture data retained on refusal
PASS #439 both halves, task only, and rule only disappear from the rooms list
exit 0
```

For #701, the target's rows disappeared from all six history tables and both log layouts;
the adjacent identity, other-platform identity, associated rows, and log bytes were unchanged.
For #702, both room and rule routes refused active/unknown jobs and malformed ledger
schemas while retaining task records, rules, history, and logs. A healthy retry cleared
the target history. For #439, combined, task-only, and rule-only rooms were removed
from both storage and the room listing.

The lock-race, rollback, missing-legacy-schema, and wildcard/case boundary cases are
covered by the automated regressions. They were not injected into the live service.

## Scope and remaining limits

This is a post-deployment verification of the exact deployed artifact against synthetic
data. No real production room was deleted. It does not claim sustained production
observation or an atomic transaction spanning SQLite and configuration files.
Once history has committed, a later configuration removal failure returns an explicit
partial-result error and supports retry; this behavior has separate regression coverage.

The first isolated malformed-schema check used the task-list API to verify preservation.
That API also depends on the damaged ledger and returned an error. The verification
script was corrected to inspect the isolated task database directly; the complete
second run passed. No application fix or production change resulted from that script correction.

## Preventing recurrence

- Preserve literal, case-sensitive identity matching for history discovery and all deletes.
- Treat unknown ledger state as a refusal and recheck inside the deleting transaction.
- Keep HTTP dependency wiring and all three room shapes under regression tests.
- Use the runtime version API for operational checks. The worker installation guide now
  distinguishes current runtime from last-installed archive markers, the accepted
  documentation alternative for #587. The two archive markers were observed at `0.0.364`;
  neither was rewritten to pretend that all installed components had been upgraded.
