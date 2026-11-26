import { createReadStream, existsSync, readFileSync, statSync, type Stats } from "node:fs";
import { createHash, randomUUID } from "node:crypto";
import {
  appendArchive, createArchive, classifyRetryableFailure, classifyUploadOutcome,
  isAppendAmbiguous, isPlainNoBv, isJobAbort, isUncertainOutcome, isUploadRateLimited, throwIfAborted,
  type UploadFailurePlan, type UploadOpts,
} from "@drec/core";
import type { SyncLedger } from "./ledger.js";
import type { PipelineDeps } from "./pipeline.js";
import { PART_GROUP_CANONICAL, type CanonicalPartGroup } from "./verify.js";

export const MASTER_UPLOAD_STEPS = new Set(["upload_plain", "append_danmu", "append_livechat"]);
const UPLOAD_GROUPS: readonly CanonicalPartGroup[] = Object.values(PART_GROUP_CANONICAL);
type Submission = {
  kind: "create" | "append"; group: CanonicalPartGroup; indices: number[]; fingerprint: string;
  state: "intent" | "submitted" | "not-submitted";
  proof?: "created" | "accepted" | "observed"; bv?: string;
};
type Failure = { message: string; code: string; ambiguous: boolean; rateLimitAttempt?: number };
type MasterUploadFailurePlan = UploadFailurePlan & { retryAttempt?: number };
type UploadIdentity = { targetId: string; accountKey: string; credentialFingerprint: string; generation: string };
type FileFingerprint = { size: number; sha256: string };
type Journal = {
  version: 1; legacy: boolean; entries: Submission[]; failure?: Failure; plans?: Record<string, string>;
  generation?: string; identity?: UploadIdentity;
};

function parseJournal(raw: string | null | undefined): Journal | null {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as Journal;
    if (j.version !== 1 || typeof j.legacy !== "boolean" || !Array.isArray(j.entries)) return null;
    if (!j.entries.every((e) => e && ["create", "append"].includes(e.kind)
      && UPLOAD_GROUPS.includes(e.group) && typeof e.fingerprint === "string"
      && Array.isArray(e.indices) && e.indices.length > 0
      && e.indices.every((i) => Number.isSafeInteger(i) && i >= 0)
      && new Set(e.indices).size === e.indices.length
      && ["intent", "submitted", "not-submitted"].includes(e.state)
      && (e.state !== "submitted" || (typeof e.bv === "string" && !!e.bv
        && ["created", "accepted", "observed"].includes(e.proof ?? ""))))) return null;
    if (j.entries.some((e, index) => j.entries.slice(index + 1)
      .some((other) => e.group === other.group && e.indices.some((i) => other.indices.includes(i))))) return null;
    if (j.plans && (typeof j.plans !== "object" || Array.isArray(j.plans)
      || !Object.values(j.plans).every((value) => typeof value === "string"))) return null;
    if (j.generation != null && (typeof j.generation !== "string" || !j.generation)) return null;
    if (j.identity != null && (typeof j.identity.targetId !== "string" || !j.identity.targetId
      || typeof j.identity.accountKey !== "string" || !j.identity.accountKey
      || typeof j.identity.credentialFingerprint !== "string" || !j.identity.credentialFingerprint
      || typeof j.identity.generation !== "string" || !j.identity.generation)) return null;
    if (j.failure && (typeof j.failure.message !== "string" || typeof j.failure.code !== "string"
      || typeof j.failure.ambiguous !== "boolean"
      || (j.failure.rateLimitAttempt != null && (!Number.isSafeInteger(j.failure.rateLimitAttempt)
        || j.failure.rateLimitAttempt < 1)))) return null;
    return j;
  } catch { return null; }
}

type MasterHistoryLedger = Pick<SyncLedger, "get" | "getSteps" | "doneParts" | "getNodeStates">;

function hasPreviousMasterUploadActivity(ledger: MasterHistoryLedger, key: string): boolean {
  const history = ledger.getSteps(key).some((step) => MASTER_UPLOAD_STEPS.has(step.step) && step.phase !== "skipped");
  const parts = UPLOAD_GROUPS.some((group) => ledger.doneParts(key, group).size > 0);
  const nodes = ledger.getNodeStates(key).some((node) => MASTER_UPLOAD_STEPS.has(node.node)
    && !["pending", "skipped", "blocked"].includes(node.state));
  return history || parts || nodes;
}

export function masterUploadMayOwnArchive(ledger: MasterHistoryLedger, key: string): boolean {
  const job = ledger.get(key);
  if (!job) return false;
  const raw = job.uploadJournal ?? null;
  if (raw == null) return hasPreviousMasterUploadActivity(ledger, key);
  const journal = parseJournal(raw);
  return !journal || journal.legacy || journal.entries.length > 0 || hasPreviousMasterUploadActivity(ledger, key);
}

/** Called before workflow start events: absence of old upload evidence is not retroactive proof. */
export function prepareMasterUpload(ledger: SyncLedger, key: string): void {
  const job = ledger.get(key);
  if (!job || job.uploadJournal != null) return;
  const legacy = !!job.bv || hasPreviousMasterUploadActivity(ledger, key);
  ledger.saveUploadJournal(key, null, JSON.stringify({
    version: 1, legacy, entries: [], generation: randomUUID(),
  } satisfies Journal));
}

/** Freeze source membership and the logical per-part map before any request can have an effect. */
export function bindMasterPlan(ledger: SyncLedger, key: string, scope: string, identity: unknown): void {
  prepareMasterUpload(ledger, key);
  const raw = ledger.get(key)?.uploadJournal ?? null;
  const journal = parseJournal(raw);
  if (!journal) throw ambiguous("missing master source plan evidence");
  const next = JSON.stringify(identity);
  const existing = journal.plans?.[scope];
  if (existing === next) return;
  if (journal.entries.length > 0 || (journal.legacy && existing !== undefined)) {
    const message = "source or part plan changed after submission";
    journal.failure = { message: "[append-ambiguous] " + message, code: "unknown", ambiguous: true };
    ledger.saveUploadJournal(key, raw, JSON.stringify(journal));
    throw ambiguous(message);
  }
  // A rescan may legitimately change the plan before any submit was attempted.
  journal.plans = { ...journal.plans, [scope]: next };
  ledger.saveUploadJournal(key, raw, JSON.stringify(journal));
}

type Fingerprint = { value: string; stamps: string[] };

function fileStamp(st: Stats): string {
  return JSON.stringify([st.dev, st.ino, st.size, st.mtimeMs, st.ctimeMs]);
}

function sameFileStamps(files: string[], expected: string[]): boolean {
  try {
    return files.length === expected.length && files.every((file, index) => fileStamp(statSync(file)) === expected[index]);
  } catch { return false; }
}

async function fingerprint(files: string[]): Promise<Fingerprint> {
  const entries: Array<{ size: number; sha256: string }> = [];
  const stamps: string[] = [];
  for (const file of files) {
    const st = statSync(file);
    if (!st.isFile() || st.size <= 0) throw new Error("upload input missing or empty");
    const stamp = fileStamp(st);
    const hash = createHash("sha256");
    for await (const chunk of createReadStream(file)) hash.update(chunk);
    const after = statSync(file);
    if (fileStamp(after) !== stamp) {
      throw new Error("upload input changed while fingerprinting");
    }
    entries.push({ size: st.size, sha256: hash.digest("hex") });
    stamps.push(stamp);
  }
  return { value: JSON.stringify(entries), stamps };
}

function bindUploadIdentity(deps: PipelineDeps, key: string, journal: Journal, raw: string | null, cookies: string): string | null {
  const targetId = deps.upload.id;
  const accountKey = deps.upload.accountKey({ targetId, locator: cookies });
  const generation = journal.generation ?? randomUUID();
  const credentialFingerprint = createHash("sha256")
    .update(generation)
    .update("\0")
    .update(cookies)
    .update("\0")
    .update(existsSync(cookies) ? readFileSync(cookies) : "missing")
    .digest("hex");
  if (journal.entries.length > 0 && !journal.identity) {
    journal.failure = { message: "[append-ambiguous] upload identity missing for existing submission evidence", code: "unknown", ambiguous: true };
    deps.ledger.saveUploadJournal(key, raw, JSON.stringify(journal));
    throw ambiguous("upload identity missing for existing submission evidence");
  }
  if (journal.identity && (journal.identity.targetId !== targetId || journal.identity.accountKey !== accountKey
    || journal.identity.credentialFingerprint !== credentialFingerprint || journal.identity.generation !== generation)) {
    journal.failure = { message: "[append-ambiguous] upload target or account changed during retry", code: "unknown", ambiguous: true };
    deps.ledger.saveUploadJournal(key, raw, JSON.stringify(journal));
    throw ambiguous("upload target or account changed during retry");
  }
  if (journal.generation !== generation || !journal.identity) {
    journal.generation = generation;
    journal.identity = { targetId, accountKey, credentialFingerprint, generation };
    const next = JSON.stringify(journal);
    try { deps.ledger.saveUploadJournal(key, raw, next); }
    catch {
      const latest = deps.ledger.get(key)?.uploadJournal ?? null;
      const current = parseJournal(latest);
      if (!current?.identity || current.identity.targetId !== targetId || current.identity.accountKey !== accountKey
        || current.identity.credentialFingerprint !== credentialFingerprint || current.identity.generation !== generation) throw ambiguous("upload identity changed concurrently");
      return latest;
    }
    return next;
  }
  return raw;
}

/** Validate persisted successful parts before a resume path skips their upload calls. */
export async function validateMasterParts(
  ledger: SyncLedger, key: string, group: string, files: string[], requireComplete = false,
): Promise<void> {
  const raw = ledger.get(key)?.uploadJournal;
  const journal = parseJournal(raw);
  if (!journal) {
    if (raw != null) throw ambiguous("missing or malformed master upload evidence");
    if (requireComplete && files.length > 0) throw ambiguous("completed upload group has no submission evidence");
    return;
  }
  const submittedEntries = journal.entries.filter((entry) => entry.group === group && entry.state === "submitted");
  for (const entry of submittedEntries) {
    let parsed: unknown;
    try { parsed = JSON.parse(entry.fingerprint) as unknown; }
    catch { rejectJournal(ledger, key, raw!, journal, "submitted part fingerprint is malformed"); }
    const validFingerprint = (value: unknown): value is FileFingerprint => typeof value === "object" && value !== null
      && "size" in value && typeof value.size === "number" && Number.isSafeInteger(value.size) && value.size > 0
      && "sha256" in value && typeof value.sha256 === "string" && /^[0-9a-f]{64}$/.test(value.sha256);
    if (!Array.isArray(parsed) || parsed.length !== entry.indices.length || !parsed.every(validFingerprint)) {
      rejectJournal(ledger, key, raw!, journal, "submitted part fingerprint is malformed");
    }
    const recorded = parsed;
    for (let offset = 0; offset < entry.indices.length; offset++) {
      const index = entry.indices[offset]!;
      if (index >= files.length) rejectJournal(ledger, key, raw!, journal, `submitted part ${group}[${index}] is missing from the current upload plan (${files.length} parts)`);
      let current: string;
      try { current = (await fingerprint([files[index]!])).value; }
      catch { rejectJournal(ledger, key, raw!, journal, "submitted part is missing or unreadable"); }
      if (current !== JSON.stringify([recorded[offset]])) rejectJournal(ledger, key, raw!, journal, "submitted part changed after confirmation");
    }
  }
  if (requireComplete) {
    const expected = new Set(files.map((_, index) => index));
    const submitted = new Set(submittedEntries.flatMap((entry) => entry.indices));
    const checkpointed = ledger.doneParts(key, group);
    const sameIndices = (left: Set<number>, right: Set<number>): boolean =>
      left.size === right.size && [...left].every((index) => right.has(index));
    if (!sameIndices(submitted, expected) || !sameIndices(checkpointed, expected)) {
      rejectJournal(ledger, key, raw!, journal, "completed upload group does not cover the current part plan");
    }
  }
}

function rejectJournal(ledger: SyncLedger, key: string, raw: string, journal: Journal, message: string): never {
  journal.failure = { message: "[append-ambiguous] " + message, code: "unknown", ambiguous: true };
  ledger.saveUploadJournal(key, raw, JSON.stringify(journal));
  throw ambiguous(message);
}

function ambiguous(message: string): Error {
  return new Error(`[append-ambiguous] ${message}`);
}

/** Validate both representations of successful submissions, never infer a missing part from visibility. */
function consistent(ledger: SyncLedger, key: string, journal: Journal): boolean {
  const bv = ledger.get(key)?.bv;
  const groups = UPLOAD_GROUPS;
  for (const group of groups) {
    const submitted = journal.entries.filter((e) => e.group === group && e.state === "submitted");
    const expected = new Set(submitted.flatMap((e) => e.indices));
    const actual = ledger.doneParts(key, group);
    if (expected.size !== actual.size || [...expected].some((i) => !actual.has(i))) return false;
    if (submitted.some((e) => e.bv !== bv)) return false;
  }
  return !bv || journal.entries.some((e) => e.kind === "create" && e.state === "submitted" && e.bv === bv);
}

export function masterUploadFailurePlan(ledger: SyncLedger, key: string, error?: unknown): MasterUploadFailurePlan | null {
  const job = ledger.get(key);
  const journal = parseJournal(job?.uploadJournal);
  if (!journal) return job?.uploadJournal == null ? null : classifyUploadOutcome({ ambiguous: true });
  const durableRateLimit = journal.failure?.code === "rate-limit" && !journal.failure.ambiguous;
  const last = error ?? (durableRateLimit ? journal.failure!.message : job?.error ?? journal.failure);
  if (journal.legacy || journal.entries.length === 0 || !consistent(ledger, key, journal)) {
    return classifyUploadOutcome({ ambiguous: true, error: last });
  }
  const hasSingleRateLimitedRejection = journal.failure?.code === "rate-limit"
    && !journal.failure.ambiguous
    && isUploadRateLimited(last)
    && journal.entries.some((entry) => entry.state === "not-submitted" && entry.indices.length === 1);
  if (!hasSingleRateLimitedRejection) return classifyUploadOutcome({ ambiguous: true, error: last });
  const unknown = journal.entries.some((e) => e.state === "intent");
  return {
    ...classifyUploadOutcome({
    bv: job?.bv, intentCommitted: unknown,
    partsConfirmed: !unknown, ambiguous: unknown || journal.failure?.ambiguous,
    error: last,
    }),
    ...(hasSingleRateLimitedRejection ? { retryAttempt: journal.failure?.rateLimitAttempt ?? 1 } : {}),
  };
}

type SubmitInput = {
  deps: PipelineDeps; key: string; group: CanonicalPartGroup; indices: number[]; files: string[];
  bv?: string; create?: UploadOpts; deferred?: boolean;
};

/** Every master submit is write-ahead fenced. The caller still owns the existing upload slot. */
async function submit(input: SubmitInput): Promise<string> {
  const { deps, key, group, indices, files } = input;
  throwIfAborted(key);
  prepareMasterUpload(deps.ledger, key);
  const raw = deps.ledger.get(key)?.uploadJournal ?? null;
  const journal = parseJournal(raw);
  if (!journal) throw ambiguous("missing or malformed master upload evidence");
  bindUploadIdentity(deps, key, journal, raw, input.create?.cookies ?? deps.cfg.cookies);
  const boundRaw = deps.ledger.get(key)?.uploadJournal ?? null;
  const boundJournal = parseJournal(boundRaw);
  if (!boundJournal) throw ambiguous("missing or malformed master upload identity");
  if (boundJournal.legacy) rejectJournal(deps.ledger, key, boundRaw!, boundJournal, "legacy upload history has no submission proof");
  if (!boundJournal.legacy && !consistent(deps.ledger, key, boundJournal)) throw ambiguous("submission checkpoints disagree");
  if (!files.length || indices.length !== files.length || new Set(indices).size !== indices.length) {
    throw ambiguous("invalid submission part indices");
  }
  const currentBv = deps.ledger.get(key)?.bv;
  if ((input.create && currentBv) || (!input.create && (!input.bv || currentBv !== input.bv))) {
    throw ambiguous("upload archive identity changed");
  }
  const fp = await fingerprint(files);
  const overlapping = boundJournal.entries.filter((e) => e.group === group && e.indices.some((i) => indices.includes(i)));
  const previous = overlapping[0];
  if (overlapping.length > 1 || (previous && (JSON.stringify(previous.indices) !== JSON.stringify(indices)
    || previous.kind !== (input.create ? "create" : "append")
    || (previous.fingerprint !== fp.value && previous.state !== "not-submitted")))) {
    throw ambiguous("upload inputs changed since submission");
  }
  if (boundJournal.entries.some((e) => e.state === "intent")) throw ambiguous("unresolved submission intent; refusing to resend");
  if (previous?.state === "submitted") {
    if (!consistent(deps.ledger, key, boundJournal)) throw ambiguous("submission checkpoints disagree");
    return previous.bv!;
  }
  const entry: Submission = { kind: input.create ? "create" : "append", group, indices, fingerprint: fp.value, state: "intent" };
  const priorRateLimitAttempt = boundJournal.failure?.code === "rate-limit" && !boundJournal.failure.ambiguous
    ? boundJournal.failure.rateLimitAttempt ?? 1 : 0;
  if (previous) boundJournal.entries.splice(boundJournal.entries.indexOf(previous), 1, entry);
  else boundJournal.entries.push(entry);
  delete boundJournal.failure;
  const intent = JSON.stringify(boundJournal);
  try { deps.ledger.saveUploadJournal(key, boundRaw, intent); }
  catch {
    const latestRaw = deps.ledger.get(key)?.uploadJournal ?? null;
    const latest = parseJournal(latestRaw);
    if (latest?.entries.some((entry) => entry.state === "intent")) throw ambiguous("unresolved submission intent; refusing to resend");
    const completed = latest?.entries.find((entry) => entry.group === group && entry.kind === (input.create ? "create" : "append")
      && entry.state === "submitted" && JSON.stringify(entry.indices) === JSON.stringify(indices) && entry.fingerprint === fp.value);
    if (completed && consistent(deps.ledger, key, latest!)) return completed.bv!;
    throw ambiguous("upload evidence changed concurrently");
  }
  if (!sameFileStamps(files, fp.stamps)) {
    entry.state = "not-submitted";
    boundJournal.failure = { message: "[append-ambiguous] upload input changed before submission", code: "unknown", ambiguous: true };
    try { deps.ledger.saveUploadJournal(key, intent, JSON.stringify(boundJournal)); }
    catch { throw ambiguous("upload input changed before submission; durable status remains blocked"); }
    throw ambiguous("upload input changed before submission");
  }
  let bv: string;
  try {
    if (input.create) bv = await createArchive(deps.upload, { ...input.create, proofOnly: true });
    else {
      bv = input.bv!;
      await appendArchive(deps.upload, {
        bv, files, cookies: deps.cfg.cookies, public: deps.cfg.uploadPrivate === false,
        deferVerificationUntilCleanup: input.deferred, proofOnly: true,
      });
    }
  } catch (error) {
    const unknown = isAppendAmbiguous(error) || isPlainNoBv(error) || isUncertainOutcome(error);
    // Multi-file rejection may follow partial success; the batch is indivisible without server proof.
    const rejected = files.length === 1 && !unknown && !isJobAbort(error) && isUploadRateLimited(error);
    entry.state = rejected ? "not-submitted" : "intent";
    boundJournal.failure = {
      message: String((error as Error)?.message ?? error).slice(0, 300),
      code: classifyRetryableFailure(error).code, ambiguous: !rejected,
      ...(rejected ? { rateLimitAttempt: priorRateLimitAttempt + 1 } : {}),
    };
    deps.ledger.saveUploadJournal(key, intent, JSON.stringify(boundJournal));
    if (isJobAbort(error) || rejected) throw error;
    throw ambiguous(boundJournal.failure.message);
  }
  if (!sameFileStamps(files, fp.stamps)) {
    boundJournal.failure = { message: "[append-ambiguous] upload input changed while submitting", code: "unknown", ambiguous: true };
    try { deps.ledger.saveUploadJournal(key, intent, JSON.stringify(boundJournal)); }
    catch { throw ambiguous("upload input changed while submitting; durable status remains blocked"); }
    throw ambiguous("upload input changed while submitting");
  }
  entry.state = "submitted";
  entry.bv = bv;
  // Deferred returns guarantee acceptance, not observation. Never promote it to observed here.
  entry.proof = input.create ? "created" : input.deferred ? "accepted" : "observed";
  deps.ledger.saveUploadJournal(key, intent, JSON.stringify(boundJournal), {
    bv, group, indices, seasonPending: !!input.create && !!deps.cfg.uploadMeta.seasonSectionId,
  });
  return bv;
}

export function createMasterArchive(deps: PipelineDeps, key: string, opts: UploadOpts): Promise<string> {
  const files = opts.videos?.length ? opts.videos : opts.video ? [opts.video] : [];
  return submit({ deps, key, group: PART_GROUP_CANONICAL.plain, indices: files.map((_, index) => index), files, create: opts });
}

export async function appendMasterParts(
  deps: PipelineDeps, key: string, bv: string, group: CanonicalPartGroup, indices: number[], files: string[], deferred: boolean,
): Promise<void> {
  if (!files.length) return;
  await submit({ deps, key, bv, group, indices, files, deferred });
}

export function hasVerifiedMasterHistory(ledger: SyncLedger, key: string): boolean {
  const journal = parseJournal(ledger.get(key)?.uploadJournal);
  return !!journal && !journal.legacy && consistent(ledger, key, journal);
}

export function hasMasterUploadFailure(ledger: SyncLedger, key: string): boolean {
  const raw = ledger.get(key)?.uploadJournal;
  const journal = parseJournal(raw);
  return !!raw && (!journal || !!journal.failure || journal.entries.some((e) => e.state === "intent"));
}

/** Pipeline-returned failures and thrown failures share one counting rule. */
export function markMasterFailure(deps: Pick<PipelineDeps, "ledger">, key: string, message: string): void {
  const plan = hasMasterUploadFailure(deps.ledger, key) ? masterUploadFailurePlan(deps.ledger, key, message) : null;
  if (plan && !plan.retryable) {
    deps.ledger.setState(key, "needs_manual", { error: message });
    return;
  }
  deps.ledger.markFailed(key, message, !(plan?.retryable && !plan.countsAsFailure));
}
