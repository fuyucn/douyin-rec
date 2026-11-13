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
import type { ArchiveRef, UploadPolicy } from "./upload-target.js";

export interface SubmitArchiveMeta {
  title: string;
  tid?: number;
  tags?: string[];
  desc?: string;
  policy?: UploadPolicy;
}

export interface PartSubmitter {
  /** Create the archive, or reuse the one findRecent proves already exists. Bytes are not sent. */
  ensureStreamedArchive(req: {
    archive: SubmitArchiveMeta;
    name: string;
    title?: string;
    expectedDurationSec?: number;
  }): Promise<{ ref: ArchiveRef; reused: boolean }>;
  /** Publish one part whose bytes the runner already uploaded. Bytes are not sent. */
  appendStreamedPart(req: {
    ref: ArchiveRef;
    name: string;
    title?: string;
    size?: number;
  }): Promise<{ confirmed: number[] }>;
  verify(req: { ref: ArchiveRef; expectedParts: number | null }):
    Promise<{ ok: boolean; observedParts: number | null }>;
}
