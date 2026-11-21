# Append submission and part visibility

Issue #737 separates successful submission from public-view visibility. A successful biliup command may be accepted before the public part list refreshes. That delay must not block later master-pipeline uploads.

The master opts into deferred append verification only when it has both a part-count reader and a plain-part ledger baseline for the existing final readback. The target then returns accepted, not observed. Unknown responses and real command failures keep their previous duplicate-prevention behavior.

Merged, segmented and resumed master uploads use the same eligibility check. The existing final readback compares the completed submission plan with the remote part count before source cleanup. Missing, extra or unreadable parts retain all video sources and completed stage outputs for manual review. A successful submission is never permission to delete the last source copy.

Callers without final readback protection, including rolling uploads and node queues, retain immediate verification. The generic upload driver does not confirm or clean a merely accepted part.

This change does not automatically recover existing manual-review jobs, resubmit uncertain parts, change archive metadata, or authorize deployment. Existing manual jobs need a separate comparison of already-present parts before any recovery is attempted.
