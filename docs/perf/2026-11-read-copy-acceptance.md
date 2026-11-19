# Read-callback copy acceptance (#353)

## Scope and existing implementation

Verified on 2026-11-19 against main commit
`bc0ec954c274bb1705595ae70d5c74ae626efcdc`.
The owner approved removing only the redundant stdout-read copy, preserving the
per-chunk detach copy, and no preallocation. This report and its test/tool changes
do not change the runtime, upload policy, chunk ownership, or deployed version.

The normal stdout path already reuses Buffer input in
`packages/zero-upload/src/live-pump-stream.ts`. The reuse originated in
commit `d4b05a17a51aae32118e3b723fcee3f3d256b49c`; commit
`ada88f31` later moved that implementation into the current module.
The stdout stream is not text-decoded. Non-Buffer inputs retain their conversion
path; the per-chunk copies in the part buffer are unchanged.

The historical constrained-worker capture in
[the #352 partial report](2026-11-zero-disk-cpu-profile.md) is not a current-code
baseline. Rather than claim a new runtime improvement, this change pins the
existing implementation and supplies a reproducible copy-restored control.

## Byte-exact acceptance and regression sensitivity

| Requirement | Executable evidence |
| --- | --- |
| Reuse the original stdout Buffer view | The new reader test spies on the actual cutter input and asserts object identity, not merely content equality. Sentinel bytes outside the view do not appear in the spool. |
| Arbitrary read/chunk boundaries | Existing cutter tests reconstruct the input from slices of 1, 7, 188, 1000 bytes and the whole input; the streaming integration test concatenates spool files in order. |
| Size and duration sealing | Existing cutter tests assert byte conservation at normal and forced size cuts and PTS-duration cuts. The streaming integration test reconstructs input across duration-separated spool files. |
| Unaligned EOF tail | Existing cutter tests flush partial packets byte-for-byte, including at the size bound. |
| Abort sealing | The new reader test aborts after the first write with an unaligned tail pending; the final spool equals exactly the consumed input prefix and the fake child is killed. |
| Bounded-transfer backpressure | The new reader test forces a one-slot transfer queue to overflow, asserts the degradation occurred, and compares the complete spool with the original input. All requests use a fake transport. |

New tests live in `test/perf/live-read-buffer.test.ts`. Existing boundary tests
are in `packages/zero-upload/src/ts-cutter.test.ts` and
`packages/zero-upload/src/live-pump.test.ts` (the `runStream: cutting and stopping`
suite). Tests use synthetic TS and temporary files, never production data.

The identity regression was mutation-tested by temporarily restoring
`Buffer.from(data)` for the Buffer branch, then restoring the original source:

~~~text
Copy restored: Tests 1 failed (1)
AssertionError: expected Buffer to be Buffer // Object.is equality
Original restored: Tests 1 passed (1)
After abort/backpressure additions: Tests 3 passed (3)
~~~

The mutated source was not committed. A runtime-path diff check was empty after
restoration. This regression specifically catches the extra read copy; it does
not pretend that equal byte content alone can detect unnecessary allocation.

Final local validation of these additions:

~~~text
pnpm test --reporter=dot
Test Files 366 passed | 3 skipped (369)
Tests 5465 passed | 48 skipped (5513)
pnpm typecheck: exit 0
pnpm arch:check: exit 0
~~~

The existing environment-dependent skips are not claimed as passing tests.

## Same-machine CPU comparison

Reproduce from the repository root:

~~~sh
node scripts/profile-live-read-copy.mjs 2048 5
~~~

The script bundles the actual reader and cutter twice. `reuse` uses the working
source unchanged. `copy` changes only the Buffer branch to `Buffer.from(data)`
in the in-memory build input, never the source file on disk. Both variants replay
the same synthetic TS as 64 KiB Buffer views into a hash-only sink. No disk sink,
real ffmpeg, network request, upload, PartBuffer, or production recording is
part of this benchmark. Counters assert all reads are reused in one variant and
copied in the other. Both variants include the same identity instrumentation.

Each independent process warms up with 64 MiB, then measures the requested
2048 MiB rounded up to complete fixture repetitions. Variant order alternates
between rounds. Each run produced 2,147,942,112 bytes from 33,456 read views.
All ten output SHA-256 hashes were identical:

`29faa254f02fe52bec932e0417b7d471bc7871f94b9362f484ec5eb9fb372d5c`

Environment: Node v24.15.0, macOS arm64, Apple M3 Pro. CPU time is process user
plus system time after warmup; wall time is the same timed region. Lower is better.

| Round | Copy CPU ms | Reuse CPU ms | Copy wall ms | Reuse wall ms |
| --- | ---: | ---: | ---: | ---: |
| 1 | 2985.116 | 2687.111 | 2453.129 | 2383.398 |
| 2 | 2921.919 | 2563.191 | 2215.388 | 2180.845 |
| 3 | 3114.984 | 2511.278 | 2398.283 | 2007.146 |
| 4 | 3529.181 | 2587.617 | 4262.843 | 2185.564 |
| 5 | 2959.844 | 2710.577 | 2450.739 | 2662.262 |
| Median | 2985.116 | 2587.617 | 2450.739 | 2185.564 |

Measured median CPU reduction: **13.316%**. This is a descriptive local result,
not a statistical confidence interval or a production performance guarantee.
Wall times include an obvious slow copy run; no outliers were removed.

The script writes both compiled variants, ten actual V8 CPU profiles and a JSON
result into a unique temporary directory. The JSON records the base commit,
reader/cutter/fixture/workload source hashes, environment, every run, hashes and
medians. Those local raw profiles can contain absolute paths and are not committed.

All ten profiles were parsed and their sample/time-delta arrays validated. Across
each set of five profiles, leaf-frame wall samples were:

| Frame | Copy ms (% of profile window) | Reuse ms (% of profile window) |
| --- | ---: | ---: |
| Hash update | 5841.382 (38.54%) | 5588.744 (46.28%) |
| FastBuffer | 2336.211 (15.42%) | 1085.349 (8.99%) |
| Garbage collector | 978.040 (6.45%) | 498.537 (4.13%) |

These are sampled leaf-frame totals, not inclusive allocation attribution or
heap measurements. V8 profiling covers startup and warmup as well as the timed
region, so these percentages are not interchangeable with process CPU medians.
Hashing and cutter work dominate much of this synthetic workload in both modes.

## Limits and follow-up boundaries

- This is a same-machine, copy-restored counterfactual, not a replay of a historic
  deployed binary or a real broadcast. It establishes allocation-path identity,
  byte conservation and the measured local cost of that one copy.
- It does not quantify healthy-VPS real-stream CPU, peak memory, same-bitrate
  zero-disk on/off overhead, upload throughput, or degradation rate. Those remain
  outside this narrow approval and do not complete #352 or #462.
- No per-chunk detach copy was removed and no preallocated buffer was introduced.
  No runtime release or deployment is needed for these test/tool/document changes.
- Independent review must assess this evidence against #353 before closure;
  publishing the report alone is not permission to close the issue.
