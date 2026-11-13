/**
 * upos-target.ts — the in-process UPOS transport as an UploadTarget (plans/049 stage 2).
 *
 * Bilibili has two transports. Stage 1a wrapped the first one (an external biliup child process).
 * This file wraps the second: preupload -> chunk PUTs -> complete -> member web submit, all in
 * process. The protocol itself is owned by @drec/zero-upload; nothing is re-implemented here — the
 * file only maps contract input to protocol calls and protocol outcome to proof.
 *
 * Why it exists: a zero-disk live upload has no readable file, so the biliup target cannot serve it.
 * UploadFile.source carries the bytes (memory buffer in zero-disk mode), while path stays a name
 * used for the UPOS file name and the part title.
 *
 * Hard rules carried over from the protocol layer (both are irreversible when wrong):
 *   - watermark off + copyright self are not configurable through this target;
 *   - private is the default and only an explicit public policy overrides it;
 *   - a submit whose outcome we cannot read is unknown (hand to a human), never a retry.
 */
import { closeSync, existsSync, openSync, readFileSync, readSync, statSync } from "node:fs";
import { basename } from "node:path";
import {
  appendStudioPart,
  complete,
  findArchiveByTitle,
  lookupArchive,
  preupload,
  submitStudio,
  uploadChunks,
  UposRateLimited,
  type PreuploadResult,
  type StudioArchive,
  type StudioInput,
  type SubmitResult,
  type UposPart,
} from "@drec/zero-upload";
import {
  isAppendAmbiguous,
  isPlainNoBv,
  isUploadRateLimited,
  type AppendPartsInput,
  type AppendPartsResult,
  type ArchiveInfo,
  type CreateArchiveInput,
  type CreateArchiveResult,
  type PublishStreamedInput,
  type PublishStreamedResult,
  type CredentialRef,
  type UploadErrorClass,
  type UploadFile,
  type UploadTarget,
} from "@drec/core";
import { DEFAULT_TID, TITLE_MAX_LENGTH } from "./biliup-target.js";
import { accountKeyFor, cookieLocator } from "./credential.js";

/** Registered id for the in-process transport. Distinct from the biliup target: same platform,
 * different wire protocol, and the queue stores this id in its checkpoint. */
export const UPOS_TARGET_ID = "bilibili-upos";

/** UPOS line (upcdn). Same default as the live pump; overridable for tests and manual runs. */
export const UPOS_DEFAULT_LINE = "txa";

export interface UposTargetDeps {
  /** Fake network for tests; forwarded to every protocol call. */
  fetchImpl?: typeof fetch;
  /** Credential seams (same semantics as the biliup target). */
  env?: (key: string) => string | undefined;
  exists?: (path: string) => boolean;
  readText?: (path: string) => string | null;
  /** File size seam: tests never create multi-MB files. */
  statSize?: (path: string) => number;
  /** Chunk reader seam for on-disk files: (path, start, length) -> bytes. */
  readSlice?: (path: string, start: number, length: number) => Uint8Array;
  log?: (msg: string) => void;
  /** Override the upcdn line (default UPOS_DEFAULT_LINE). */
  line?: string;
}

function messageOf(err: unknown): string {
  return String((err as Error)?.message ?? err);
}

/** Read an exact byte range from a file without loading the whole recording into memory. */
function defaultReadSlice(path: string, start: number, length: number): Uint8Array {
  const fd = openSync(path, "r");
  try {
    const buf = Buffer.alloc(length);
    const got = readSync(fd, buf, 0, length, start);
    return got === length ? buf : buf.subarray(0, got);
  } finally {
    closeSync(fd);
  }
}

function archiveInfoOf(ref: ArchiveInfo["ref"], a: StudioArchive): ArchiveInfo {
  return {
    ref,
    title: a.title,
    // The view endpoint reports the archive's own flag: keep it instead of guessing.
    visibility: a.private ? "private" : "public",
    partCount: a.videos.length,
    parts: a.videos.map((v, i) => ({ index: i + 1, ...(v.title ? { title: v.title } : {}) })),
  };
}

export function createUposTarget(deps: UposTargetDeps = {}): UploadTarget {
  const env = deps.env ?? ((k: string) => process.env[k]);
  const exists = deps.exists ?? existsSync;
  const readText = deps.readText ?? ((p: string) => (exists(p) ? readFileSync(p, "utf-8") : null));
  const statSize = deps.statSize ?? ((p: string) => statSync(p).size);
  const readSlice = deps.readSlice ?? defaultReadSlice;
  const log = deps.log ?? (() => {});
  const line = deps.line ?? UPOS_DEFAULT_LINE;
  const fetchImpl = deps.fetchImpl;

  const credPath = (cred: CredentialRef): string => cred.locator;

  /** Declared part size. UPOS preupload needs the number before any byte moves. */
  function sizeOf(file: UploadFile): number {
    const size = file.source?.size ?? file.size ?? statSize(file.path);
    if (!Number.isFinite(size) || size <= 0) throw new Error("part size unknown or zero: " + basename(file.path));
    return size;
  }

  /**
   * Upload one part and return the UPOS stem Studio needs.
   *
   * Every failure here happens **before** any submission: chunk PUTs and complete only move
   * bytes. That is why the caller can safely retry them; the submit is the irreversible step and
   * is handled separately.
   */
  async function uploadPart(file: UploadFile, cookiesPath: string): Promise<StudioInput["videos"][number]> {
    const totalSize = sizeOf(file);
    const fileName = basename(file.path) || "part";
    const session: PreuploadResult = await preupload({
      cookiesPath,
      fileName,
      totalSize,
      line,
      ...(fetchImpl ? { fetchImpl } : {}),
    });
    const chunkSize = session.bucket.chunkSize;
    if (chunkSize <= 0) throw new Error("preupload returned no usable chunk_size");
    const readChunk = file.source
      ? (i: number, size: number) => file.source!.readChunk(i, size)
      : async (i: number, size: number) => readSlice(file.path, i * chunkSize, size);
    const parts: UposPart[] = await uploadChunks({
      session,
      totalSize,
      readChunk,
      retries: 3,
      ...(fetchImpl ? { fetchImpl } : {}),
    });
    const done = await complete({ session, parts, ...(fetchImpl ? { fetchImpl } : {}) });
    if (!done.ok || !done.stem) {
      throw new Error("UPOS complete failed: " + JSON.stringify(done.raw).slice(-300));
    }
    log("[upos] part uploaded " + fileName + " (" + done.stem + ", " + parts.length + " chunks)");
    return { filename: done.stem, ...(file.title ? { title: file.title } : {}) };
  }

  /** Any submit response we cannot read is unknown: the archive may exist, retrying duplicates it. */
  function submitFailure(res: SubmitResult, what: string): Error {
    // The message carries the raw body so classifyError can still see the rate-limit codes.
    return new Error(what + " rejected: " + JSON.stringify(res.raw).slice(0, 300));
  }

  return {
    id: UPOS_TARGET_ID,
    platformIds: ["bilibili"],
    // Group append is biliup's argv shape; UPOS appends one part per edit call, by construction.
    capabilities: { appendGranularity: "single", seasons: false, streamPublish: true },

    resolveCredential({ dataRoot, explicitPath }): CredentialRef {
      const locator = cookieLocator(
        UPOS_TARGET_ID,
        { dataRoot, ...(explicitPath ? { explicitPath } : {}) },
        { env, exists },
      );
      return { targetId: UPOS_TARGET_ID, locator };
    },

    accountKey(cred: CredentialRef): string {
      return accountKeyFor(UPOS_TARGET_ID, cred.locator, { readText });
    },

    hardPolicy() {
      return { visibility: "private", watermark: false, copyright: "self" };
    },

    defaults() {
      return { tid: DEFAULT_TID, tags: [], titleMaxLength: TITLE_MAX_LENGTH, maxParts: null };
    },

    async create(input: CreateArchiveInput): Promise<CreateArchiveResult> {
      const cookiesPath = credPath(input.cred);
      const videos: StudioInput["videos"] = [];
      for (const file of input.files) videos.push(await uploadPart(file, cookiesPath));
      const res = await submitStudio({
        cookiesPath,
        title: input.title,
        tid: input.tid ?? DEFAULT_TID,
        tag: (input.tags ?? []).join(","),
        ...(input.desc ? { desc: input.desc } : {}),
        private: input.policy.visibility !== "public",
        videos,
        ...(fetchImpl ? { fetchImpl } : {}),
      });
      if (!res.ok) throw submitFailure(res, "create");
      // ok but no bvid: the archive exists and we cannot name it. Never retry, never guess.
      if (!res.bvid) return { proof: "unknown", ref: null };
      return { proof: "created", ref: { targetId: UPOS_TARGET_ID, id: res.bvid } };
    },

    async append(input: AppendPartsInput): Promise<AppendPartsResult> {
      const cookiesPath = credPath(input.cred);
      let appended = 0;
      for (const file of input.files) {
        const video = await uploadPart(file, cookiesPath);
        let res: SubmitResult;
        try {
          res = await appendStudioPart({
            cookiesPath,
            bvid: input.ref.id,
            video,
            ...(fetchImpl ? { fetchImpl } : {}),
          });
        } catch {
          // The edit request may have reached the server. With a part already appended in this
          // batch the archive state is unreadable either way: hand both cases to a human.
          return { proof: "unknown" };
        }
        if (!res.ok) {
          // A rejected edit did not take effect, but a previous file in this batch may have landed.
          if (appended > 0) return { proof: "unknown" };
          throw submitFailure(res, "append");
        }
        appended++;
      }
      if (input.countParts) {
        const observed = await input.countParts();
        if (observed === null) return { proof: "unknown" };
      }
      return { proof: "observed" };
    },

    /**
     * Publish metadata for bytes the streaming transport already uploaded (plans/049 stage 2b-2b).
     *
     * live-pump already runs preupload -> chunks -> complete while the part is still recording, so
     * there is nothing left to transfer here. Mapping proof is the same as create/append: an unreadable
     * submit is unknown, a provably rejected edit is confirmed-not-submitted, anything else throws so
     * the driver can classify rate limits and permanent failures.
     */
    async publishStreamed(input: PublishStreamedInput): Promise<PublishStreamedResult> {
      const cookiesPath = credPath(input.cred);
      const video: StudioInput["videos"][number] = {
        filename: input.name,
        ...(input.title ? { title: input.title } : {}),
      };
      if (!input.ref) {
        const archive = input.archive;
        if (!archive) throw new Error("publishStreamed: archive metadata is required to create");
        const res = await submitStudio({
          cookiesPath,
          title: archive.title,
          tid: archive.tid ?? DEFAULT_TID,
          tag: (archive.tags ?? []).join(","),
          ...(archive.desc ? { desc: archive.desc } : {}),
          private: (archive.policy?.visibility ?? "private") !== "public",
          videos: [video],
          ...(fetchImpl ? { fetchImpl } : {}),
        });
        if (!res.ok) throw submitFailure(res, "create");
        if (!res.bvid) return { proof: "unknown", ref: null };
        return { proof: "created", ref: { targetId: UPOS_TARGET_ID, id: res.bvid } };
      }
      let res: SubmitResult;
      try {
        res = await appendStudioPart({
          cookiesPath,
          bvid: input.ref.id,
          video,
          ...(fetchImpl ? { fetchImpl } : {}),
        });
      } catch (e) {
        if (isAppendAmbiguous(e)) return { proof: "unknown", ref: null };
        throw e;
      }
      if (!res.ok) {
        // A rejected edit provably did not take effect; an unreadable one might have.
        if (isAppendAmbiguous(res) || isPlainNoBv(res)) return { proof: "unknown", ref: null };
        return { proof: "confirmed-not-submitted", ref: null };
      }
      if (!res.bvid && !input.ref) return { proof: "unknown", ref: null };
      return { proof: "confirmed", ref: input.ref };
    },

    async inspect({ ref, cred }): Promise<ArchiveInfo | null> {
      const r = await lookupArchive({
        cookiesPath: credPath(cred),
        bvid: ref.id,
        ...(fetchImpl ? { fetchImpl } : {}),
      });
      if (!r.ok || !r.archive) return null;
      return archiveInfoOf(ref, r.archive);
    },

    async findRecent({ cred, title }): Promise<ArchiveInfo | "none" | "unknown"> {
      const r = await findArchiveByTitle({
        cookiesPath: credPath(cred),
        title,
        ...(fetchImpl ? { fetchImpl } : {}),
      });
      // A read that never succeeded stays unknown: only a real empty listing may allow a new archive.
      if (r.searched === false) return "unknown";
      if (r.matches === 0) return "none";
      if (r.matches > 1 || !r.archive) return "unknown";
      const ref = { targetId: UPOS_TARGET_ID, id: r.archive.bvid ?? String(r.archive.aid) };
      return archiveInfoOf(ref, r.archive);
    },

    classifyError(err: unknown): UploadErrorClass {
      const msg = messageOf(err);
      // Ambiguity first: a rate-limited hint suggests retry later, but retrying an ambiguous
      // submit is exactly how duplicate parts and duplicate archives get created.
      if (isAppendAmbiguous(err) || isPlainNoBv(err)) return { kind: "ambiguous", reason: msg };
      if (err instanceof UposRateLimited || isUploadRateLimited(err)) return { kind: "rate-limited" };
      if (/econnreset|etimedout|timeout|timed out|connection reset|socket hang up|unexpected eof|fetch failed/i.test(msg)) {
        return { kind: "transient", reason: msg };
      }
      return { kind: "permanent", reason: msg };
    },
  };
}

