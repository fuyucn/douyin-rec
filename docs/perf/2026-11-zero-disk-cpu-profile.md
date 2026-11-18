# Zero-disk CPU profile (partial evidence for #352; captured 2026-10-22)

## Scope

This is a partial, CPU-only measurement step for [issue #352](https://github.com/fuyucn/douyin-rec/issues/352), based on the profile report recorded there on 2026-10-22. It does not complete or close #352. It describes one zero-disk recording process on a small worker under heavy CPU steal and swap pressure. It is not a general performance guarantee. A reviewable heap/memory result, a healthy-node capture, and a same-bitrate zero-disk-on/off comparison remain required before #352 can close.

## Method

- Captured a 50-second CPU profile through the running Node inspector process; the recorder was not restarted.
- CPU sampling interval: 1 ms. Heap sampling was also enabled.
- Environment during capture: 2 vCPU, approximately 1 GB RAM, about 78% CPU steal, and swap in use.
- Workload: one zero-disk live-pump stream at roughly 1 MB/s.

## Result

- Idle accounted for 41% of the wall window.
- The per-read Buffer.from(data) copy accounted for 32% of the wall window, or about 54% of busy time.
- Stream-read self time accounted for 20% of the wall window.
- Garbage collection accounted for 0.8%; hashing, TLS/upload, logging, and other application frames were each below 3%.
- No separate Buffer.concat frame was observed, so the suspected quadratic-concatenation cost was not confirmed.

The dominant observed application frame was the redundant per-read copy. At the measured data rate a raw copy should take milliseconds; the profile's roughly 15 seconds attributed to that frame may include allocation and page-fault stalls under swap and CPU steal. This capture cannot distinguish those effects from copy cost.

## Limits and follow-up

- No healthy-node capture or same-bitrate zero-disk-off comparison was performed; these results do not establish behavior on an unconstrained node.
- Heap sampling was enabled, but this measurement did not produce a comparative memory result.
- Issue #353 tracks the separately approved change to remove only the redundant read-callback copy while retaining the per-chunk ownership copy; preallocated chunk buffers are out of scope. That change still requires byte-exact regression coverage and before/after profiling.
- This documentation step changed no runtime behavior; it provides no runtime regression evidence and does not satisfy the remaining memory or comparison acceptance criteria.
