import type { PartSubmitter } from "@drec/core";

interface ArchiveMetadata {
  bvid?: string;
  aid?: number;
  title: string;
  tid: number;
  tag: string;
  desc?: string;
  private: boolean;
}

interface CompletedPart {
  stem: string;
  title: string;
  bytes: number;
  durationSec: number;
}

interface PublicationOptions {
  submitter: PartSubmitter;
  targetId?: string;
  kind: "create" | "append";
  archive: Readonly<ArchiveMetadata>;
  part: Readonly<CompletedPart>;
  signal?: AbortSignal;
}

type PublicationFailure = {
  ok: false;
  error: string;
  needsManual?: true;
  retryable?: true;
};

type PublicationResult = { ok: true; bvid?: string; aid?: number } | PublicationFailure;

function createRequest(
  archive: Readonly<ArchiveMetadata>,
  part: Readonly<CompletedPart>,
  signal?: AbortSignal,
): Parameters<PartSubmitter["ensureStreamedArchive"]>[0] {
  return {
    archive: {
      title: archive.title,
      tid: archive.tid,
      ...(archive.tag ? { tags: archive.tag.split(",").filter(Boolean) } : {}),
      ...(archive.desc ? { desc: archive.desc } : {}),
      policy: { visibility: archive.private ? "private" : "public", watermark: false, copyright: "self" },
    },
    name: part.stem,
    ...(part.title ? { title: part.title.slice(0, 80) } : {}),
    ...(part.durationSec > 0 ? { expectedDurationSec: Math.round(part.durationSec) } : {}),
    // Fresh broadcasts can share a title; only interrupted-request recovery may reuse by title.
    skipFindRecent: true,
    ...(signal ? { signal } : {}),
  };
}

function publicationFailure(error: unknown): PublicationFailure {
  const err = error as { name?: string; failure?: string; message?: string };
  const needsManual = err?.name === "UploadDriverError" && err.failure === "needs-manual";
  // The driver already spent its retry budget. Unknown outcomes require reconciliation, not retry.
  const retryable = err?.name === "UploadDriverError" && err.failure === "retry-exhausted";
  return {
    ok: false,
    error: String(err?.message ?? error).slice(0, 300),
    ...(needsManual ? { needsManual: true } : {}),
    ...(retryable ? { retryable: true } : {}),
  };
}

/** Publish already-uploaded bytes once; the caller owns the intent and confirmation checkpoints. */
export async function publishLivePumpPart(o: PublicationOptions): Promise<PublicationResult> {
  const { submitter, archive, part, signal } = o;
  try {
    if (o.kind === "append") {
      await submitter.appendStreamedPart({
        ref: { targetId: o.targetId ?? "bilibili-upos", id: archive.bvid ?? String(archive.aid) },
        name: part.stem,
        ...(part.title ? { title: part.title.slice(0, 80) } : {}),
        size: part.bytes,
        ...(signal ? { signal } : {}),
      });
      return { ok: true, bvid: archive.bvid, aid: archive.aid };
    }
    const out = await submitter.ensureStreamedArchive(createRequest(archive, part, signal));
    return { ok: true, bvid: out.ref.id, aid: undefined };
  } catch (error) {
    return publicationFailure(error);
  }
}
