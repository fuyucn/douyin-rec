import { isUploadRateLimited } from "@drec/core";
import { appendStudioPart, submitStudio, type StudioVideo, type SubmitResult } from "./upos-stream.js";
import type { LivePumpState } from "./live-pump-state.js";
import { sleepUnlessAborted } from "./live-pump-wait.js";

/** Synchronous best-effort accounting shared with other uploads on the account. */
export interface SubmitGate {
  /** Record every attempt, including retries, in the shared submission window. */
  noteSubmit(): void;
  /** Cool the account when the remote endpoint reports a submission rate limit. */
  noteRateLimited(): void;
}

type LegacyArchive = Readonly<Pick<LivePumpState,
  "title" | "tid" | "tag" | "desc" | "private" | "bvid" | "aid"
>>;

type LegacyPublication = {
  kind: "create" | "append";
  video: StudioVideo;
  mustContain?: readonly string[];
  /** Read at each attempt; concurrent reconciliation may replace the session checkpoint. */
  readArchive: () => LegacyArchive;
  cookiesPath: string;
  fetchImpl: typeof fetch;
  log: (message: string) => void;
  submitGate?: SubmitGate;
  sleep?: (ms: number) => Promise<void>;
  rateLimitBaseMs?: number;
  rateLimitAttempts?: number;
  signal?: AbortSignal;
};

type LegacyPublicationResult =
  | { ok: true; proof: "accepted"; bvid?: string; aid?: number }
  | { ok: false; error: string; retryable?: boolean };

/** Map one metadata request; intent and confirmation writes remain owned by the session. */
function publishOnce(o: LegacyPublication): Promise<SubmitResult> {
  const archive = o.readArchive();
  const { video, cookiesPath, fetchImpl } = o;
  if (o.kind === "append") {
    return appendStudioPart({
      cookiesPath,
      ...(archive.bvid ? { bvid: archive.bvid } : { aid: archive.aid }),
      video,
      ...(o.mustContain ? { mustContain: o.mustContain } : {}),
      fetchImpl,
    });
  }
  return submitStudio({
    cookiesPath,
    title: archive.title,
    tid: archive.tid,
    tag: archive.tag,
    ...(archive.desc ? { desc: archive.desc } : {}),
    private: archive.private,
    videos: [{
      filename: video.filename,
      ...(video.title ? { title: video.title } : {}),
      ...(video.desc ? { desc: video.desc } : {}),
    }],
    fetchImpl,
  });
}

/** Retry only explicit submission throttling; never retransmit bytes or write checkpoints. */
export async function publishLegacyLivePumpPart(o: LegacyPublication): Promise<LegacyPublicationResult> {
  const sleep = o.sleep ?? ((ms: number) => new Promise<void>((resolve) => setTimeout(resolve, ms)));
  const baseMs = o.rateLimitBaseMs ?? 60_000;
  const maxAttempts = o.rateLimitAttempts ?? 5;
  let lastError = "";
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try { o.submitGate?.noteSubmit(); } catch { /* Accounting must never block publication. */ }
    let result: SubmitResult;
    try {
      result = await publishOnce(o);
    } catch (e) {
      return { ok: false, error: String((e as Error)?.message ?? e).slice(0, 300) };
    }
    const { ok, raw, bvid, aid } = result;
    if (ok) return { ok: true, proof: "accepted", ...(bvid ? { bvid } : {}), ...(aid ? { aid } : {}) };
    const detail = `${o.kind} failed: ${JSON.stringify(raw).slice(0, 300)}`;
    lastError = detail;
    if (!isUploadRateLimited(detail)) return { ok: false, error: detail };
    try { o.submitGate?.noteRateLimited(); } catch { /* Accounting must never block publication. */ }
    const waitMs = Math.min(baseMs * 2 ** attempt, 300_000);
    o.log(
      `[直播直传] ${o.kind} 命中投稿限流(${JSON.stringify(raw).slice(0, 120)}),` +
      `${waitMs / 1000}s 后重试(${attempt + 2}/${maxAttempts})`,
    );
    await sleepUnlessAborted(waitMs, [o.signal], sleep);
    if (o.signal?.aborted) return { ok: false, error: "submit aborted" };
  }
  return { ok: false, error: `${lastError}(限流重试 ${maxAttempts} 次后仍失败)`, retryable: true };
}
