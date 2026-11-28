# Upload Submission Proof Safety

## Goal

Close the evidence gap around retry and source cleanup without creating a second
delivery database or changing the public upload mode values. The implementation
is tracked by issue #755 and is intentionally separate from the approved,
narrow retry policy in issue #752 / PR #754.

Task index: T-251 in TODO.md. Opus's limited review passed this design with the
nonblocking landing-verification clarification below; that clarification is now
incorporated and requires no further full design review. Design PASS is not
implementation/test/deployment PASS or activation authorization. Source references
below are static evidence, not executed reproductions or confirmed production incidents.

## Scope decision: B with safe degradation

Select **B for this candidate**: UPOS/live-pump has a transport-produced stem
frozen before metadata submission and owns this batch's P0b. Biliup receives
P0a at every application entry, but gains no per-part observation or automatic
cleanup without an attributable native part identity. Activation requires
acceptance of the retained-source/manual cost; preserving old ACK cleanup in a
protected order is not an alternative implementation of B.

- A is deferred, not proved impossible: current biliup lacks a durable
  request-bound source-P -> native remote-key mapping. Even with one writer,
  before/after filename differences/count/title do not supply the same binding
  as UPOS's frozen transport stem. Read completeness, partial success and binary
  behavior remain unproved. External writers are an additional risk shared with
  UPOS, not the unique objection to A. A may be selected later with evidence.
- C, migrating biliup to UPOS, is a separate future decision. Do not switch
  target or executor to escape accepted/unknown evidence.
- Already-deleted legacy history cannot acquire fabricated observed proof.

### Applicability matrix

| Domain | This batch | Completion/source policy |
| --- | --- | --- |
| UPOS/live-pump direct with frozen native stem | P0a + P0b | Request ACK is accepted; durable same-archive/stem membership may become observed and permit policy-controlled per-P cleanup. |
| UPOS direct via existing in-process upload-runtime adapter | P0a + P0b native identity passthrough | Direct session owns positive observation/cleanup. No current UPOS queue executor is registered; do not invent one in this batch. |
| Existing part queue/import/reconcile/cleanup | P0a rejection/containment only | Block unsafe submission/import/cleanup. reconcile-part remains shadow; positive per-P settlement and runner cleanup chaining await a separately qualified executor. |
| Biliup plain/create, append, rolling, node processor/recovery and import | P0a everywhere | No negative/count inference or new cleanup authority. Preserve sources and known ACK/archive facts; unidentifiable membership remains unknown/manual, blocking same-order successors. |
| Shared wrappers -> core/upload-call -> master-upload | Required minimal typed-receipt seam | Preserve actual proof/ref in the same journal entry regardless of deferred/count flags. This necessary 059 scope extension changes proof propagation, not PR754 retry eligibility/code/budget. |
| Existing master whole-order finalization/count policy | Not converted to P0b | Explicitly selected unprotected legacy progression/cleanup retains risks below; protected orders cannot enter it or bypass proof via count/skip. |
| Old target/reader missing proof support | No protected execution | Keep intent, owner and source; block or quarantine, never reinterpret accepted as confirmed or not-attempted. |

## Architecture

- A recovered/unresolved intent or unknown means the metadata request may have
  had a side effect. Preserve the source and do not submit again from a negative
  query, stale count or title-only match. A fresh intent written for an authorized
  first submission is not itself a recovery barrier; see Persistence ordering.
  An ordinary success response never supplies per-part membership.
- Accepted records a request-level positive acknowledgement. It is not proof
  that a particular part is visible and it never authorizes source cleanup.
- P0b observed requires positive evidence identifying the same target/account/
  archive and native part identity frozen before submission. Biliup is not
  claimed to satisfy this property in this batch.
- Unknown predecessors remain a submission barrier. Read-only observation may
  continue without occupying the shared upload slot; later edits must not use a
  stale snapshot that can overwrite accepted parts.
- Existing ledger, sidecar, live state, proc-queue and target adapters remain
  the durable fact owners. No Delivery database, cross-node lease, or queue
  migration is part of this plan.

## P0a: complete entry inventory

Every row is an implementation and fault-test requirement, including normal
execution. Missing a row blocks activation of the affected path.

| Entry and current evidence | Required replacement |
| --- | --- |
| packages/bilibili-upload/src/run-biliup.ts:86, :215, retryable-line classifier and uploadPlain | Mixed tail logs can contain an earlier transfer error plus a later metadata error. They cannot authorize line respawn. Preserve transfer retry only with positive proof of no metadata submit AND termination of the old child; otherwise hold unknown. Disable wrapper retry if its interface cannot prove the phase. |
| packages/bilibili-upload/src/run-biliup.ts:312 appendGroup; packages/bilibili-upload/src/biliup-target.ts:156 | Remove unchanged-count retry, increased-count success, proofOnly count success and unknown-as-success. No deferVerificationUntilCleanup escape. Explicit attributable ACK may remain accepted, never observed. |
| packages/bilibili-upload/src/biliup.ts:379 afterStall, :432 verifyStopped | Empty title/duration lookup or readable count cannot authorize recreation/rerun/safe-to-resubmit. A dead child proves termination, not absence of a completed POST. |
| packages/bilibili-upload/src/biliup.ts:336 count resume/append loop | Do not derive appendFrom from server count. Retain original cursor/intent and hold at unresolved P, rather than skip or resend it. |
| packages/bilibili-upload/src/upload-part.ts legacy direct call/ackSeen assignment | Legacy wrapper return or rc=0 must not produce per-P confirmed or cleanup-ready success. Keep known archive/request facts; block retry and chain completion on ambiguity, including recover/verifyStopped. |
| packages/app/src/rolling-upload.ts:709, :1333, :1356, :873 | Close negative/count recovery AND normal create/append fake confirmation. No confirmed insertion or deletion from wrapper return; unidentifiable biliup membership remains held. |
| packages/app/src/rolling-queue.ts:201; packages/proc-queue/src/store.ts:428 and :441 | Legacy confirmed/BV/done cannot create observed, advance a protected cursor or enqueue cleanup. Close old-done cleanup repair and reject previously queued unsafe cleanup too. Import provenance/hold only; retain terminal history without upgrading it. |
| packages/app/src/live-pump-queue.ts:67, :85 and early/final exit-75 handoff/receipt/restart callers | Before !confirmed/!journal/pendingIndex filtering or BV inheritance, block protected direct UPOS -> biliup/upload-part fallback for the whole order. No intent/accepted/unknown/observed or legacy lacking explicit never-attempted proof enters submission enqueue. Preserve original target/owner/generation/native key; use blocked/observe-only, not false owned/queueManaged receipts or zero-enqueue exit-75 retry loops. |
| packages/zero-upload/src/live-pump-recovery.ts:20, :53; live-pump-session-recovery.ts:131 | Even nonempty exact-title searches with zero matches are negative reads. Missing stem is not non-submission. Keep pending/original stem; never clear pending, rotate stem or resend from absence. |
| packages/zero-upload/src/studio-submit.ts:78, :90; packages/bilibili-upload/src/upos-target.ts:363; packages/upload-runtime/src/driver.ts:419, :535; packages/zero-upload/src/live-pump-session.ts:224, :245, :365 | Close normal code0 -> confirmed -> delete. Explicit code0 is request accepted only; locally assembled post-edit archive is not independent member-view proof. |

P0a is fail-closed: until accepted persistence is fully active, retain existing
intent/unknown and source, not temporary ACK-to-confirmed behavior. No relaxed
legacy default in shared wrappers to preserve availability. Pure preparation or
transfer retry requires proved pre-submit phase and stopped previous execution;
network/rate-limit tail text alone is insufficient. PR754's separately proved
single-file rejection rule remains unchanged.

### Exit-75 containment includes receipts and restart

The handoff eligibility gate runs before opening a submission batch and at every
early/final receipt/restart entry, not just at pendingIndex. Accepted may have
cleared pending and still cannot be retried through biliup. Protected direct
UPOS has no qualified queue executor in this batch, so even a never-attempted
later P cannot use this fallback; keep the protected order with its original
delivery owner. Observation/fact repair is not a new upload-part submission.

- Existing active/done/skipped queue rows and journal hit/already are historical
  facts, not evidence that the queue now owns this protected order. Do not
  manufacture owned receipts, set queueManaged or advance the submission cursor.
- An enqueueBatch exception and reversal of queueManaged do not release the
  original owner/target or authorize a direct retry. Retain original identity
  and an explicit blocked/observe-only hold; do not spin on zero-enqueue exit-75.
  Handoff callers must distinguish this receipt from unsupported/empty/owned:
  keep observation-paused/manual status when no direct executor remains, instead
  of manufacturing queue ownership or repeatedly restarting an exit-75 child.
- Alias existence, rename or a different path is not a new P/target permission.
  Alias deletion is subject to the source proof/retention gate, including this
  failure/receipt path; neither source nor alias is deleted to escape the hold.
- Tests cover accepted with pending cleared, every disposition, legacy without
  never-attempted evidence, old rows/journal hits, batch exception and early/final/
  restart receipts: zero new rows, upload subprocesses or metadata POST; no
  owner/target/generation/key change and no source/alias deletion.

### Mandatory minimum master typed-receipt seam

Removing proofOnly/count/deferred exceptions affects master non-deferred append.
This is an explicit necessary scope extension in 059, separate from PR754, not
a claim that shared hardening leaves master or its journal proof field unchanged.
Choose **typed receipts**, not a second outcome-exception protocol:

1. Shared append/biliup-target returns a request-bound rc=0 as at most accepted,
   never observed from count, regardless of deferred/countParts/plain baseline.
   Real ambiguity remains unknown, not fabricated accepted.
   Preserve the existing non-deferred legacy master append confirmAppendLanded
   protection: after rc=0, a mismatched part count or failed/unreadable landing
   read may still yield unknown landing evidence/hold and preserve source, never
   observed and never retry/resend. This is evidence-driven retention of an
   existing protection, NOT adapter-induced unknown. Keep the known request ACK/
   BV as facts even when landing verification is held. Missing countParts or a
   plain baseline does not grant cleanup from rc=0 or finalizer skip: hold this
   typed-receipt path before legacy finalization instead of granting new cleanup
   eligibility. Neither count equality nor a readable result grants per-P observed.
2. packages/core/src/upload-call.ts:43 currently returns void and accepts accepted
   only when deferred. Return structured proof/ref to every caller; accepted with
   deferred=false alone must not turn into an unknown exception; actual failed
   landing verification may hold as above without erasing ACK/BV. Preserve known create
   BV/ref as well; request-created does not mean per-P observed. Audit all callers
   so none discards receipt proof or treats any return as observed.
3. The master upload seam consumes actual proof/ref
   and saves accepted/BV on the SAME existing journal entry, including deferred=false;
   do not derive observed from input.deferred. This is not a journal redesign.
   Accepted resume skips the original POST. If receipt persistence fails, keep
   intent/known facts, only repair writes or observe; never repeat POST. Missing
   attributable ACK evidence in an old job stays unknown, not manufactured accepted.
4. Protected strict-B work holds after accepted. Explicit legacy-domain successors
   follow the isolated old-domain policy below, not new per-P authority. Preserve
   PR754's current-run explicit single-file rejection eligibility/code/attempt
   budget/backoff and legacy finalizer; no new retry permission.

Required regression cross-product: deferred true/false x countParts present/absent
x plain baseline present/absent, old jobs, append continuation/restart, lost ACK
and journal-write failure. Do not lose accepted/BV, turn it unknown by adapter
erasure, fake observed or repeat a request. Also retain original single-file
rejection-budget regression. Land this seam WITH shared-wrapper hardening; do
not deploy a broken intermediate wrapper and promise to repair master later.

## Durable proof contract and single writers

Use additive records in existing stores, not a second persistent Plan. Freeze
target/account/order/generation/local P/source fp before metadata POST/metadata
side effects; persist transport-native stem before that metadata POST. This does
not gate byte preupload: streamUpload may preupload bytes while capture is active,
before sealing or a complete source fp exists. Bind the final sealed source fp
before metadata publication, not before starting byte transfer. Preserve the
native key through the existing direct target -> driver -> session. Basename, P number, title,
BV and count do not substitute for it.

| Fact domain | Authority and writer | Binding |
| --- | --- | --- |
| Direct live source/submission | Existing live-pump-state WAL; session/checkpoint writer serializing observation callbacks | Target/account; order/session and generation; local P, sealed source fp, native stem; submit intent, ACK/ref and observation. |
| Queue-owned legacy execution/submission | Existing proc_jobs state/targetState/part ctx; runner under existing lease | Preserve original job/order generation and known facts; reject unsafe replay/cleanup. No positive UPOS per-P observation or cleanup producer exists here yet. |
| Legacy rolling source/intent | Existing sidecar writer until existing handoff completes | Local source/part/archive facts and unresolved provenance. No synthesized biliup native key. |
| Master control/order ownership | Existing master ledger/journal writer | Existing owner/order/target-account binding remains irreducible; remote execution does not replace it. No new master per-P certificate here. |

Required additive P0b semantics: proof contract version; disposition
intent/accepted/observed/unknown; native part key; known archive ref; acceptedAt
for explicit attributable ACK; observedAt and positive membership evidence bound
to archive/key; observation attempts/consumedActiveMs/nextAt/budget/deadline. Reuse existing identity/fp
fields. Direct live-session observation produces these new positive facts, not
a hypothetical UPOS queue executor. Account identity is stable and public-safe,
not cookie contents. Validate
cross-field bindings; missing/conflicting data fails closed. Node numeric job
generation is not master UUID/runId; retry/restart must not mint either to erase
unknown evidence.

Accepted never becomes not-attempted when membership is absent or observation
expires. A request ACK lacking attributable P mapping can remain an ACK fact
while membership is unknown. Lost ACK remains unknown until an independent
exact-P positive observation binds it. Legacy confirmed/BV/done fills no gaps.

### Persistence ordering

1. For a new order/new P with no prior unresolved submission and all applicable
   predecessor/mustContain gates satisfied, persist its source identity and fresh
   intent, then issue exactly one first metadata POST in that authorized execution.
   The just-written intent does not block its own first POST. Persistence failure
   means zero metadata POST, not a ban on earlier byte preupload. Serialize reentry
   through the existing owner/executor. A crash/recovery seeing that intent treats
   it as ambiguous, even if the crash may have preceded the POST: no replay from
   intent alone. A new attempt requires durable, attributable explicit proof of
   non-submission and eligibility under the existing approved retry policy; preserve
   attempt history, and never replace such proof with a negative query or count.
2. On explicit ACK, durably retain archive ref and accepted before returning
   success. If that write fails, existing intent still blocks replay: preserve
   source, alert and retry only the write/read observation, never the POST.
3. Persist observed in the authority, then synchronize required live sidecar/
   journal projections before cleanup. Cross-store writes are not atomic:
   restart repairs projections from durable facts, holding cleanup throughout.
4. upload-part sidecar failure cannot merely alert and return cleanup-ready
   success. In-memory confirmed after failed session persist is not authority;
   later sweeps/restarts reload and validate durable proof before deletion.
5. Existing queue transactions/lease reject unproved cleanup and preserve holds.
   Positive queue settlement/cleanup chaining is deferred until there is a
   qualified executor. Queue errors never authorize direct fallback/rePOST.
6. Exit-75 cannot transfer protected UPOS after accepted clears pending. Its
   original delivery owner retains discovery/observation/alert responsibility;
   rollover/archival cannot erase that obligation or generate a replacement draft.

## P0b: persistent observer and same-archive barrier

packages/processors/src/reconcile-part.ts:14, :76, :112 currently uses archive/
title/duration and can map yes to done or no to pending. It is **not a per-P
observer**. Current registration/upload-part is biliup-only: no qualified UPOS
queue executor exists to feed positive settlement. Keep reconcile-part shadow,
do not enable old settle/allowResend for protected work, and defer positive
queue-native settlement/runner cleanup chaining. This batch closes rejection/
containment bypasses only there. Direct UPOS reuses its live-session observer.

- Input: exact target/account/archive, original order generation, native stem,
  local P/source fp. If create lost its archive ref, discovery yields candidates
  only; require unambiguous same-account archive binding plus exact stem
  membership. No reliable locator means manual hold, not recreation.
- Only a real member-view response containing the bound key may settle observed.
  Title/duration yes, count, POST-local archive object or observation-job done
  cannot settle delivery or advance the same-order cursor.
- Negative/error/timeout retains accepted/unknown, original stem and barriers;
  never not-submitted/resend. Unknown -> observed needs the same exact binding.
- Direct observation runs only while the original session executor is alive,
  never holding shared UploadSlot/account submit gate. Reuse existing pump
  wake/tick/checkpoint writer, not another queue/daemon. Persist due
  work before returning accepted. Restart scans that owner's unresolved durable
  parts and resumes due observations, never submission.
  Persist due/attempts/budget/deadline before yielding/stopping; a crash resumes
  from the last durable checkpoint. With no live executor expose observation-paused;
  no background progress is promised. Capture end alone is
  not delivery done. Rollover treats accepted/unknown as unresolved: hold the
  original state, or retain its locator/lineage and original-owner responsibility
  for discovery/observation/alert. If existing recovery cannot observe an archived
  state, retain sources/manual hold, not discard it or create a replacement draft.
- Candidate bounded read policy: 5s, 15s, 30s then at most once per 60s with
  jitter; stop at 1,440 actual query attempts or 24h of ACTIVE observer time,
  whichever first. Persist consumed active time/attempts and selected due/deadline.
  Candidate active time includes scheduled waits while that observer is running,
  not just HTTP request duration; its persisted budget is not an intent-age expiry.
  Pause/offline/no-executor intervals do not consume active time; do not charge
  an uncheckpointed crash gap as active. Resume of non-exhausted work performs
  a due read regardless of wall age, so 24h without an executor cannot cause
  immediate zero-query budget exhaustion. Previously exhausted budgets do not
  reset. These are candidate values/accounting rules, NOT owner-approved SLA or
  activation defaults. Explicit owner budget selection, including pause/resume
  accounting, is required; no implicit extension/reset or new POST is authorized.
  Exhaustion only preserves evidence/source and keeps the submission/cleanup barriers in a
  visible manual hold; it NEVER authorizes resend or cleanup. No automatic budget
  reset. Tests inject time. This budget is separate from PR754's retry budget.

### UPOS mustContain before every whole-list edit

Implement at studio-submit.ts:90 and pass through the existing direct UPOS
target/driver/session, not a call-site convention or invented queue executor.

1. Load all durable accepted/observed native identities for that archive and its
   pinned order lineage, including inherited sessions and earlier P whose source
   was deleted. Keep each member's original generation binding: a current-session
   filter must not drop an inherited accepted prefix. Missing lineage/provenance
   blocks edit. This is mustContain; negative reads never shrink it.
2. Fetch a real snapshot for the exact archive/account. It must contain EVERY
   mustContain identity. Empty/stale/failed read, or a same-stem hit with missing
   predecessors, means zero edit POST. Do not reconstruct from local ACK lists.
3. Preserve the snapshot's existing members in the next edit. Unknown P is an
   absolute metadata barrier until exact-P proof settles it. Accepted predecessors
   also wait for a real snapshot containing them; no pending/cursor bypass.
4. Release submission resources while waiting; revalidate durable prefix and
   real snapshot within existing submission serialization before POST. Other
   archives, recording and byte preparation may proceed; later same-archive
   metadata cannot bypass unknown or accepted-but-unseen predecessors.

Assumption: one application-controlled active metadata writer per archive under
existing ownership. No server CAS or strong cross-node fence is added. External
concurrent edits can race GET -> POST; this batch cannot promise protection from
that race. Missing mustContain later is a visible conflict, not permission to
erase historic proof. Before S3, preupload/recovery can still block capture and
continued spooling requires available disk. Alert on held delivery/retained-source
growth; do not promise unlimited spooling or reservation.

## Direct cleanup proof gate and queue containment

Use the existing durable versioned proof contract, not another cleanup queue. Direct cleanup requires
durable observed bound to target/account/archive/order generation/local P/native
key/source fp, then existing sealed/complete/retention/lease/final-verification
checks. Proof grants eligibility only and does not override existing stop.
Unidentifiable biliup fails this gate even after rc=0.

- packages/processors/src/cleanup-part.ts:47 currently accepts v1/BV/fp. Both
  validate and run reject protected queue cleanup in this batch: no qualified
  executor produces its per-P proof. Reject old queued v1/BV-only work too; never
  upgrade it to v2. Positive cleanup-part v2 is reserved for the future qualified
  queue executor, not implemented or activated here. Deployment gates remain
  necessary because old readers can still consume sidecars/v1 work.
- packages/proc-queue/src/runner.ts:700 cannot chain from confirmed/BV/fp alone.
  Reject protected positive cleanup chaining, including repair/import/retry,
  rather than implementing a new positive settlement transaction without a
  qualified producer. Positive v2 queue chain production is deferred. Direct
  session positive cleanup remains in scope with its own durable proof gate.
- Close rolling-queue.ts:201 import and proc-queue/src/store.ts:441 old-done
  repair; legacy done neither bypasses proof nor settles a protected cursor.
- Gate rolling-upload normal delete, confirmed sweep, inherited sidecar and
  legacy imports; old confirmed[] grants no fresh cleanup authority.
- Gate live-pump-session direct delete/sweep/recovery, app/live-pump-queue.ts
  confirmed/journal-already shortcuts, and every direct rmSync/unlink that can
  remove a protected video's last source. Journal already proves handoff history,
  not membership or permission to resubmit.
- Inventory orchestrator finalization/handoff cleanup callers during implementation:
  protected orders cannot reach final source deletion through count/skip/done.
  Unknown protection/provenance cannot be classified legacy to permit deletion.
  Temp cleanup which cannot remove the last source stays separate.

B therefore preserves sources for **all newly protected biliup orders**, holding
all automatic same-order metadata successors after the first accepted request
when native P identity is unavailable. This is not merely reduced throughput:
node merge+danmu/livechat, rolling/part queue, upload-part chains and whole-order
append can all stop after P1/first metadata ACK. Even single-P work cannot
automatically settle delivery/delete its only source. Manual per-step handling
and all-source retention may be needed; manual resubmission is not authorized
by this plan. Pause old biliup source cleanup at activation;
quarantine unproved legacy jobs instead of backfilling deletion. Expose held
source bytes/reason. Operators may obtain independent evidence or follow a
separately authorized manual procedure; no deletion/force is authorized here.
Disk growth and increased manual intervention are explicit availability costs.

Batch 1 standalone can similarly stop UPOS after its first metadata ACK until
Batch 3 supplies direct native observation/completion. Do not deploy containment
as availability-neutral. Activation choices are combined reviewed Batches 1–3,
or an explicit maintenance/paused window accepting holds between Batch 1 and 3.
Owner must select the combination/window before activation.

For affected paths the product options are strict B with per-step manual holds/
all-source retention, pause the path, or separately approve routing entirely NEW,
NEVER-ATTEMPTED orders to the master legacy domain with its original count/skip
risks. This is not automatic hub-rule/deployment authority. Existing protected
intent/accepted/unknown orders never change domain/owner/target/generation as an
escape. ACK + member-view progress while preserving all biliup sources is only
a future unproved option, not a third B variant: source retention reduces local
irrecoverable loss but does not prove no duplicate/missing remote P. Request-bound
native-key mapping, prefix safety and binary single-submit behavior would need
proof/separate approval; count/title/delta does not relax this batch's barriers.

## Rollout, mixed versions and rollback

This adds compatibility mechanisms, not just optional fields. An old reader can
ignore fields and resend/delete. Gates below must actually run before activation.

1. **Inventory/pause:** identify owners, sidecars, unresolved intents, queue and
   pending cleanup. Through existing operational procedures stop/drain submitters
   AND cleanup consumers; verify old processes exited before sharing roots with
   new writers. A flag cannot fence an old live process. Inventory does not
   authorize changing live orders or deleting sources.
2. **Expand:** deploy proof-aware readers, target passthrough, protected queue
   cleanup rejection and version checks with protected writes disabled. Existing worker capability
   checks must reject incompatible protected work; this adds no UPOS queue
   executor. Extend scripts/install-worker.sh:283 and scripts/deploy-precheck.sh /
   scripts/deploy-precheck.py with an INDEPENDENT proof-record compatibility gate,
   checking actual mounted data roots/persistent stores before replacement/start.
   Current busy checking is not this gate: API ECONNREFUSED is treated idle and
   stopped services can still have accepted records; --force can bypass busy.
   With protected records, incompatible/unknown reader versions must be refused
   even when idle/stopped; unreadable/unknown inventory requires pause/isolation.
   Busy --force does not override the proof gate. This is required new work in
   existing mechanisms, not a claim those scripts already implement it.
   Shared-root direct writers require verified quiescence and
   single upgraded writer; a version field is not an old-binary fence. This is
   new compatibility work, not a new DB/queue/distributed lease.
3. **Normalize safely:** retain old confirmed/done facts with legacy/unknown
   provenance; do not upgrade them. Block unsafe old cleanup at execution, not
   merely enqueue. Already-deleted history stays explicit. Keep master legacy
   orders separate; ambiguous routing is held.
4. **Activate:** only after P0a and every cleanup gate passes AND an explicit
   owner observation-budget decision is recorded, enable UPOS P0b on eligible
   owners. Persist protection/version before metadata POST/metadata side effects.
   This does not require delaying byte preupload until source sealing. Lost enqueue
   ACK queries/reuses same job/owner, never timeout theft, target swap or generation
   replacement. Master ledger order binding survives node unreachability.
   Also require the explicit Batch 1–3 activation combination/maintenance-window
   decision, including first-ACK-stop consequences for both biliup and UPOS.
5. **Contract later:** retire compatibility only after inventory proves no
   incompatible consumer or accessible unresolved protected work remains. No
   destructive migration is required by this plan.

Rollback is pause-first: stop new submission/cleanup and retain durable records
and source. Repair/resume with proof-aware binaries. Accepted/unknown/unresolved
intent cannot downgrade, and a flag rollback cannot return them to legacy direct
or rolling execution. If old binaries must serve unrelated clean orders, enforce
isolation/quarantine of protected roots/orders; otherwise rollback is blocked.
No adapter may translate accepted to confirmed or pending, clear protection, or
release ownership on timeout.
Managed installer/precheck refusal is not an absolute fence: old scripts,
manual Docker starts and directly launched old binaries are not mechanically
controlled by these new checks. They require verified no-old-process and actual
operational isolation of protected roots/orders. If that prerequisite cannot be
enforced, protected activation/rollback is blocked; no distributed fence is claimed.

## Master exception and remaining risks

PR754 remains the current-run, durably proved single-file rate-limit rejection
policy with unchanged eligibility/code/attempt budget/backoff. Unlike earlier
drafts, 059 DOES change the minimum core/upload-call/master-upload typed receipt
propagation and existing journal entry's actual proof/ref assignment above, not
the journal architecture. This separate 059 change must not be mixed into PR754.
The whole-order finalizer remains legacy; request/count facts never become per-P
certificates. Accepted legacy continuation follows only its explicitly selected
old-domain policy, not protected strict-B semantics.

packages/orchestrator/src/verify.ts:120, :154, :331 allows legacy finalization
when count is skipped (missing count reader/baseline) or count matches. Equal
counts cannot identify this P or exclude replacement/unrelated members. Explicitly
legacy unprotected master orders retain that static risk and are **outside 059's
per-P cleanup guarantee**. If keeping that policy is not accepted, pause that
domain rather than claim it fixed. Protected orders must hold final cleanup
without proof; handoff/master finalization/format cleanup cannot strip protection.

Static inspection does not establish a real target visibility bound, complete
member-view consistency, exclusion of external writers or binary-internal biliup
retry behavior. Application P0a does not prove control of unobservable external
binary retries: if safe single-submit behavior cannot be established, protected
biliup execution remains disabled.

## Delivery order

- [ ] P0a: remove negative/count-based retry and fake-confirmation paths from
  every inventory row, including ordinary calls, recovery and old imports.
- [ ] Land typed core/upload-call/master-upload actual proof/ref preservation
  with shared-wrapper hardening; preserve PR754 rejection policy/budget unchanged.
- [ ] Install proof-aware readers, cleanup rejection and compatibility gates
  before activating protected writers; preserve PR754's narrow exception.
- [ ] P0b: UPOS/live-pump native key passthrough, persistent accepted/observed,
  restartable observer and mustContain; biliup stays P0a plus source hold.
- [ ] Gate protected queue cleanup REJECTION and every protected deletion/replay sink,
  including legacy done/ACK/journal, exit-75 receipts and failed sidecar writes.
  Direct UPOS positive cleanup is in scope; positive queue settlement/chaining
  remains deferred until a separately qualified executor exists.
- [ ] Add fault tests for lost responses, stale/empty reads, unrelated part
  count changes, restart, mixed versions and rejection of protected queue cleanup
  chaining; no positive queue-settlement work is included.
- [x] Limited Opus design review PASS; nonblocking landing-verification text
  incorporated without another full review. Lead implements only after required
  approval; this checkbox grants no implementation/test/activation approval.
- [ ] Run repository implementation validation gates before closing #755.

### Reviewable batches and activation gates

| Batch | Change / not changed | Gate | Rollback |
| --- | --- | --- | --- |
| 1 P0a containment | Complete entry/exit-75 receipt inventory and minimal master receipt seam; source/cursor holds and unsafe cleanup rejection. No P0b activation. | Per-entry/core-master regressions. Standalone can stop biliup AND UPOS after first ACK: require approved paused window or combined 1–3 activation. No positive queue executor. | Pause, never restore unsafe replay/cleanup for unresolved intent. |
| 2 Expand | Direct proof readers/native key/persistent accepted/session observer; queue rejection only. Protected positive flow disabled. | Durable write recovery, independent managed proof-version refusal and verified local quiescence/isolation. | Disable new activation; keep proof-aware readers for protected work. |
| 3 P0b activation | DIRECT UPOS/live-pump only: mustContain and session observation/cleanup. Queue positive settlement/chaining stays deferred. | Fault/restart/slot/repository gates, explicit strict-B/pause/new-master-legacy choice, activation combination/window AND owner observation-budget decision; 1,440 queries/24 active hours is not a default. | Pause; no accepted/unknown downgrade or owner/target/generation swap. |
| 4 Optional contract | Remove compatibility only after no incompatible consumers/access to unresolved protected work. | Inventory and separate review. | Keep proof/source, no destructive back-conversion. |

Dependency-ordered batches are not permission to deploy a half-wired accepted
producer. Any narrower activation remains fail-closed.

## Acceptance matrix: future implementation tests

| Scenario | Required result |
| --- | --- |
| New order/new P, no unresolved predecessor, fresh intent persisted | Exactly one first metadata POST is permitted after other gates pass. Fresh intent does not self-block. Crash/reentry with persisted intent is ambiguous and cannot replay without durable attributable non-submission proof and approved retry eligibility. Byte preupload may start before sealing/full source fp. |
| Each P0a entry: committed POST/response lost, stale/empty/failed reads, restart | Cumulative metadata POST stays one; original intent/stem/source remains. No false confirmation, cleanup, new generation or wrong cursor. Exercise actual callers, not only shared helper. |
| Mixed transfer/submit tail; stall; count resume; unrelated P same count or +1; partial batch | No respawn, skip or append from log/count/title inference. Only proved pre-submit transfer with stopped child retains transfer retry. |
| code0 ACK with absent membership/read failure | Persist accepted/ref, no repost/delete; release shared slot and resume observation across restart. Missing native identity means unknown/hold. |
| Protected direct UPOS accepted not yet visible/pending cleared, all proof dispositions, unproved legacy; early/final exit-75 and restart | Zero new submission rows, upload subprocesses or metadata POST. Original target/owner/generation/key retained. blocked/observe-only, not false queue-owned/queueManaged receipt or infinite exit-75 loop; no source/alias deletion. |
| Exit-75 with old active/done/skipped rows, journal already/hit, enqueueBatch exception/queueManaged rollback, alias exists/renamed | None authorizes ownership transfer, replay or deletion. Fact repair/observation stays with original direct owner; no upload-part fallback or false cursor settlement. |
| Master deferred true/false x countParts present/absent x plain baseline present/absent; old jobs, append resume, ACK loss/journal failure | Actual structured ACK/accepted/BV facts retained through core adapter and same master journal entry. No adapter-induced unknown, false observed or repeated POST. Specifically deferred=false + rc=0 then landing-count mismatch or read failure yields hold/source retention, no resend and non-observed; this evidence-driven unknown is not adapter erasure. Missing countParts/plain baseline cannot obtain cleanup from rc=0/skip. Retain original PR754 single-file rejection-code/attempt-budget tests. |
| Protected multi-request biliup: node merge+danmu/livechat, rolling/part queue, whole-order; single-P; UPOS Batch 1 only | First accepted without native proof holds all successors and all source cleanup; single-P cannot auto-settle/delete either. Visible first-request hold/manual burden; UPOS positive flow starts only with Batch 3, not queue fallback. |
| Exact archive/stem positive, then authority/projection failure | No cleanup until required durable facts agree. Retry observation/writes only. Later persisted proof permits only that P's policy-controlled cleanup. |
| Old title/duration yes; observation no/error/timeout/budget end | No observed, resend, cleanup or cursor advance. Activation without explicit owner budget decision is rejected; candidate values are not defaults. Persist selected backoff/deadline; exhaustion preserves evidence/source/barriers in manual hold. Observation-job done is not delivery done. |
| Session exits at close/off-window, crashes, rolls over/archives, no executor for >24 wall hours; restart and budget boundary | observation-paused and durable locator/lineage/due/attempts/budget remain under original owner. No wall-age-only zero-read exhaustion for a non-exhausted active-time candidate; no unapproved reset/extension, replacement draft or background progress claim. If archived continuation unsupported, preserve sources/manual alert. |
| Snapshot missing accepted/observed predecessor even with current stem already present | Zero edit POST; stale reads never shrink mustContain. Valid snapshot preserves all members; unknown still blocks. |
| Slow observation alongside other archives/capture | No shared UploadSlot/account submission gate occupied by observation. Other archives continue. Pre-S3 capture blocking and finite spool capacity remain explicit. |
| Old done import/cleanup repair, v1 cleanup, journal already, sweeps/inherited/direct delete | Reject all protected queue cleanup/settlement in current B; direct source/alias deletion requires exact durable proof. Unproved biliup retained even after flag rollback. |
| Crash after ACK/before accepted persistence; observed before projection; sidecar/journal write failure; before/after cleanup transaction | Durable intent prevents repost. Repair only missing facts/projections; in-memory confirmed or old done cannot delete. No fabricated history. |
| Mixed old readers/workers/capabilities, old local process alive, lost dispatch ACK, node offline/master restart | Activation rejected or quarantine; same owner/job/generation retained. Verify actual consumer rejection and no fallback, not merely version-field presence. |
| Managed incompatible downgrade with idle/offline/stopped API, unreadable store or --force | Independent actual-root proof inventory gate refuses replacement/start or requires pause/isolation, regardless of busy override. Old-script/manual-Docker/old-binary bypass has explicit operational isolation prerequisites, not a claimed strong fence. |
| Protected work with reconcile-part title yes or old queue done | Remains shadow/held, never positive per-P settlement, upload-part enqueue or runner cleanup chaining; no current UPOS queue executor is assumed. |
| Protected order reaches master count-equal/skipped verifier | No per-P certificate or final cleanup bypass. Legacy master fixtures keep explicit excluded semantics, not a global safety claim. |

Primary existing test locations: test/upload/biliup.test.ts,
test/upload/biliup-append.test.ts, test/processors/biliup-stall.test.ts,
test/processors/biliup.test.ts, packages/bilibili-upload/src/biliup-target.test.ts,
packages/app/src/rolling-upload.test.ts, packages/app/src/rolling-queue.test.ts,
test/processors/reconcile-part.test.ts, test/processors/cleanup-part.test.ts,
packages/app/src/live-pump-queue.test.ts, packages/zero-upload/src/live-pump.test.ts,
packages/zero-upload/src/live-pump-submitter.test.ts and existing proc-queue store/
runner rejection suites. Positive queue observed settlement/chaining tests are
future work with a qualified executor, not a claimed reachable flow here. Add
core upload-call/master-upload and installer/deploy-precheck compatibility tests
in the core and orchestrator upload suites,
test/scripts/install-worker-busy.test.ts and test/scripts/deploy-precheck.test.ts.
Extend DIRECT upload-runtime/UPOS/harness seams for key passthrough and
cross-layer faults. Fake lag tests do not prove real target consistency bounds.

Implementation validation: targeted tests first, then pnpm test, pnpm typecheck,
the repository architecture gate, pnpm bundle for runtime changes and applicable
affected builds. Respect machine test concurrency limits. This plan revision
runs no tests and changes no runtime files.

## Decisions and blockers

- Select strict B with first-accepted stops/per-step manual handling/all-source
  retention, pause affected paths, or separately approve routing wholly NEW,
  NEVER-ATTEMPTED work to master legacy with its risks. No option is already
  approved; none authorizes hub/deploy changes or protected-order relabeling.
- Explicitly decide whether to continue or pause the EXISTING master legacy risk
  domain described above. It has not been approved by default; selecting routing
  for entirely new work is a separate decision and does not authorize continued
  legacy risk, rc=0/skip cleanup on held receipts, or protected-order downgrade.
- Select combined Batch 1–3 activation or an explicit maintenance/paused window;
  Batch 1 alone may hold UPOS after its first metadata ACK too.
- Explicitly select the observation budget before activation. The candidate
  1,440 actual queries/24 active observer hours and pause/resume accounting are
  not approved SLA/defaults and cannot activate implicitly;
  exhaustion never grants resend/cleanup. This is not PR754's retry-budget decision.
- Before activation, native identity passthrough, durable observation/projection
  ordering, core/master typed receipts, all exit-75 receipt/restart gates and actual
  managed proof-version refusal/manual isolation must be implemented/tested.
  Design review is complete subject to this incorporated clarification; future
  implementation review/tests and required approvals remain engineering gates,
  not permission to implement or activate from design PASS alone.
- PR754's retry budget and S3's disk-bound capture policy remain separate owner
  decisions, not extensions of this batch. No strong stop guarantee is implied.

## Implementation checkpoints

### 2026-11-28: direct-flow increment, not activation approval

- The first code increment separates streamed metadata acceptance from an exact
  native-part observation in the existing runtime and live-session state.
- Unknown and accepted direct submissions keep their original intent, archive
  identity and source. A negative read does not authorize another metadata POST.
- Protected direct work cannot fall back to the legacy queue or its confirmation
  journal. Direct cleanup reloads persisted proof and rejects unreadable state.
- The increment includes restart, wrong-archive, stale-read and checkpoint-write
  failure regressions. Code checkpoint bc0f3880 is pushed to the task branch.
- Validation at that checkpoint: 41 peripheral tests, typecheck, architecture
  generation check and bundle passed. The earlier full suite reported 5,716
  passed, 28 failed and 42 skipped; its related fixtures were then repaired.
  The updated full-suite gate remains open, so this is not a green delivery.
- Self-review fixes include wrong-archive native-key attribution, preventing
  an acknowledged request from retrying after a checkpoint write failure, and
  detecting recovery iterations that make no durable progress. Test fakes now
  model independent native-member reads instead of treating ACKs as observation.
- This is not completion of P0a/P0b. Whole-order and rolling containment, the
  core/master typed-receipt seam, qualified source/owner binding, durable
  nonblocking observation and mixed-version activation gates remain required.
- Every verified increment is committed and pushed to the task branch. A push
  is neither a release nor permission to deploy or activate protected delivery.

### 2026-11-28: source and append-prefix checkpoint, runtime gates pending

- Code checkpoint f51b3926 is pushed to the task branch; it is not a green
  delivery, activation candidate, release or deployment.
- Source size, mtime, device and inode are frozen in the existing intent before
  metadata publication and copied through accepted/recovered state. Cleanup
  retains missing-fingerprint history, changed files, substituted symlinks and
  incomplete/open spools. These stat facts are not a content hash or an atomic
  defense against adversarial concurrent filesystem mutation.
- Streamed append carries the union of inherited session keys and the durable
  driver prefix. The target checks every required predecessor in the actual
  member snapshot before both edit and idempotent success. Missing native
  provenance holds the order instead of overwriting a stale prefix.
- Self-review also found that unreadable state could previously be archived and
  replaced with a fresh submission. Unreadable/future-version state now refuses
  rollover; missing archive identity and cross-part native-key reuse also hold.
- Independent narrow static review found no P0/P1 in this increment. Typecheck,
  architecture, bundle, privacy and diff checks passed. Added QA regressions are
  frozen, but have not run: the shared machine test window is still reserved.
  The preceding pump run was 265 passed / 2 failed before these fixture and
  safety changes. The preceding full-suite failure is not superseded by a green
  result. Neither report may be relabeled as validation of this checkpoint.
- Rechecked the remote baseline: main remains e4569d33; prerequisite PR #754 is
  open at eeb2caf9 and its master-upload journal does not exist on main yet. The
  minimum typed master receipt seam must be integrated on that dependency, not
  implemented against a nonexistent journal or substituted with another store.
- Remaining work still includes complete account/owner/generation/source
  qualification, the durable nonblocking observer, whole-order/rolling/queue
  containment, compatibility/activation gates and the repository runtime gates.
  Existing owner decisions and deployment restrictions are unchanged.

### 2026-11-28: direct recovery checkpoint, full runtime gate passed

- Code checkpoints eca36613, 91119854 and d18f6fe8 are pushed to the task branch.
  This supersedes the pending runtime results above for this direct-flow slice;
  it is not T-251 completion, a release, deployment or activation approval.
- Self-review and runtime regression found that an adopted, validated orphan
  could retain an open seal after recovery and therefore never become eligible
  for proof-gated cleanup. Recovery now persists an explicit seal only after
  successful preparation and the abort check, before metadata publication. A
  failed durable write stops publication and preserves the source; failed or
  aborted preparation never promotes the row.
- Four focused regressions cover seal-before-publication ordering, checkpoint
  write failure, failed preparation and stop during preparation. The existing
  real SIGKILL recovery test also asserts the durable seal and retains its
  original WAL and source-deletion checks.
- Test fixtures now bind native keys to their requests and retain remote archive
  history across local restarts. Signal tests wait for installed handlers rather
  than a fixed startup delay. Identity-recovery tests qualify their observed
  prefix and assert the actual GET-only lookup endpoints; the legacy-prefix hold
  and duplicate-native-key negative regressions remain in place. The streamed
  append contract explicitly asserts its required native predecessor.
- On d18f6fe8, the full runtime suite passed: 5,770 passed, 0 failed, 42 existing
  skips across 389 test files, exit 0 without timeout (407.3 seconds). The focused
  contract gate passed 13/13. Typecheck, architecture, bundle, privacy and diff
  checks passed. The ignored bundle was rebuilt without changing version 0.0.408.
- Independent narrow static review found no P0/P1 in the recovery slice; it does
  not certify the unimplemented account/owner binding, observer or whole-order
  scope. Prior failing reports remain historical failures, not green evidence.
- The remote prerequisite is unchanged: main e4569d33 has no PR #754 journal;
  PR #754 remains open at eeb2caf9. The typed core/master receipt must use that
  existing journal, without adding a second store or changing its retry policy.
- Complete identity qualification, durable nonblocking observation, whole-order/
  rolling/queue containment, compatibility and activation gates remain open.
  No full-feature checkbox is completed by this runtime checkpoint. No real
  upload, merge, deployment, release or activation was performed.

## Out of scope

- No production spool=none enablement, disk-watermark product decision, or
  strong remote stop fence.
- No legacy/manual force relaxation.
- No master-to-worker queue migration or new distributed lease.
- No UPOS queue executor or positive reconcile-part settlement/runner cleanup
  chain; those require a separately qualified executor. Queue rejection and replay/
  cleanup bypass closure plus the minimum core/master typed seam ARE in scope.
- S2 independent stopRequestedAt, S3 capture-first/asynchronous preupload/full-
  spool disk behavior, and S4 strong fence remain deferred. Existing stop controls
  stay; this batch does not claim remote cancellation or fix capture/disk admission.

