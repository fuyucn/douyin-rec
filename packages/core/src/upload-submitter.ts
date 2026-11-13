/**
 * upload-submitter.ts - the seam a streaming runner uses to hand a finished part to an upload
 * target (plans/049 stage 2b).
 *
 * It lives in core (rank 0) because @drec/zero-upload (rank 0.35) has to accept it while it may
 * not depend on @drec/upload-runtime (rank 0.5). The assembly layer builds the implementation
 * from a target and a driver and injects it; runners keep their own streaming state and only
 * borrow the decision rules.
 *
 * Credentials are deliberately absent: the implementation is already bound to one account, so a
 * runner cannot switch accounts between parts.
 */
import type { ArchiveRef, UploadFile, UploadPolicy } from "./upload-target.js";

export interface SubmitEnsureRequest {
  title: string;
  files: UploadFile[];
  policy: UploadPolicy;
  expectedDurationSec?: number;
}

export interface SubmitAppendRequest {
  ref: ArchiveRef;
  files: UploadFile[];
  policy: UploadPolicy;
}

export interface PartSubmitter {
  /** Create the archive, or reuse the one findRecent proves already exists. */
  ensureArchive(req: SubmitEnsureRequest): Promise<{ ref: ArchiveRef; reused: boolean }>;
  /** Append parts; the returned numbers are the ones this call proved are on the archive. */
  appendParts(req: SubmitAppendRequest): Promise<{ confirmed: number[] }>;
  verify(req: { ref: ArchiveRef; expectedParts: number | null }):
    Promise<{ ok: boolean; observedParts: number | null }>;
}
