/**
 * Upload-only failures must not be reported as a recording crash.
 *
 * The live pump records into the spool and settles parts through preupload/append. A 406/601
 * rate limit, a transport error, or an exhausted bounded retry leaves the bytes on disk untouched;
 * the next run can settle them. Exiting 75 lets TaskManager retry the pending upload without
 * consuming the recording restart budget and without alerting "录制中断".
 *
 * Local/permanent failures (missing/unreadable spool, untrusted state, held gap, ambiguous create)
 * deliberately stay false: those need a human and must keep their existing failure path.
 *
 * The decision is the structured `uploadPending` flag set by the pump, never a regex over the
 * human-readable error text. A text match previously turned "not resubmitting" (a permanent,
 * human-only state) into an automatic retry.
 */
export function isUploadPendingResult(
  res: { ok: boolean; uploadPending?: boolean; error?: string },
): boolean {
  return res.uploadPending === true;
}
