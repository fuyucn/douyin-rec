import { statSync } from "node:fs";
import {
  appendArchive, createArchive, classifyRetryableFailure, classifyUploadOutcome,
  isAppendAmbiguous, isPlainNoBv, isJobAbort, isUncertainOutcome, isUploadRateLimited, throwIfAborted,
  type UploadFailurePlan, type UploadOpts,
} from "@drec/core";
import type { SyncLedger } from "./ledger.js";
import type { PipelineDeps } from "./pipeline.js";

export const MASTER_UPLOAD_STEPS = new Set(["upload_plain", "append_danmu", "append_livechat"]);
type Submission = {
  kind: "create" | "append"; group: string; indices: number[]; fingerprint: string;
  state: "intent" | "submitted" | "not-submitted";
  proof?: "created" | "accepted" | "observed"; bv?: string;
};
type Failure = { message: string; code: string; ambiguous: boolean };
type Journal = { version: 1; legacy: boolean; entries: Submission[]; failure?: Failure; plans?: Record<string, string> };

function parseJournal(raw: string | null | undefined): Journal | null {
  if (!raw) return null;
  try {
    const j = JSON.parse(raw) as Journal;
    if (j.version !== 1 || typeof j.legacy !== "boolean" || !Array.isArray(j.entries)) return null;
    if (!j.entries.every((e) => e && ["create", "append"].includes(e.kind)
      && ["plain", "append_danmu", "append_livechat"].includes(e.group) && typeof e.fingerprint === "string"
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
    if (j.failure && (typeof j.failure.message !== "string" || typeof j.failure.code !== "string"
      || typeof j.failure.ambiguous !== "boolean")) return null;
    return j;
  } catch { return null; }
}

/** Called before workflow start events: absence of old upload evidence is not retroactive proof. */
export function prepareMasterUpload(ledger: SyncLedger, key: string): void {
  const job = ledger.get(key);
  if (!job || job.uploadJournal != null) return;
  const history = ledger.getSteps(key).some((s) => MASTER_UPLOAD_STEPS.has(s.step) && s.phase !== "skipped");
  const parts = ["plain", "append_danmu", "append_livechat"].some((g) => ledger.doneParts(key, g).size > 0);
  const nodes = ledger.getNodeStates(key).some((n) => MASTER_UPLOAD_STEPS.has(n.node)
    && !["pending", "skipped", "blocked"].includes(n.state));
  ledger.saveUploadJournal(key, null, JSON.stringify({
    version: 1, legacy: !!job.bv || history || parts || nodes, entries: [],
  } satisfies Journal));
}

/** Freeze source membership and the logical per-part map before any request can have an effect. */
export function bindMasterPlan(ledger: SyncLedger, key: string, scope: string, identity: unknown): void {
  prepareMasterUpload(ledger, key);
  const raw = ledger.get(key)?.uploadJournal ?? null;
  const journal = parseJournal(raw);
  if (!journal) throw ambiguous("missing master source plan evidence");
  const next = JSON.stringify(identity);
  if (journal.plans?.[scope] === next) return;
  if (journal.entries.length > 0) {
    const message = "source or part plan changed after submission";
    journal.failure = { message: "[append-ambiguous] " + message, code: "unknown", ambiguous: true };
    ledger.saveUploadJournal(key, raw, JSON.stringify(journal));
    throw ambiguous(message);
  }
  journal.plans = { ...journal.plans, [scope]: next };
  ledger.saveUploadJournal(key, raw, JSON.stringify(journal));
}

function fingerprint(files: string[]): string {
  return JSON.stringify(files.map((file) => {
    const st = statSync(file);
    if (!st.isFile() || st.size <= 0) throw new Error("upload input missing or empty");
    return { device: st.dev, inode: st.ino, size: st.size, mtimeMs: st.mtimeMs };
  }));
}

function ambiguous(message: string): Error {
  return new Error(`[append-ambiguous] ${message}`);
}

/** Validate both representations of successful submissions, never infer a missing part from visibility. */
function consistent(ledger: SyncLedger, key: string, journal: Journal): boolean {
  const bv = ledger.get(key)?.bv;
  const groups = ["plain", "append_danmu", "append_livechat"];
  for (const group of groups) {
    const submitted = journal.entries.filter((e) => e.group === group && e.state === "submitted");
    const expected = new Set(submitted.flatMap((e) => e.indices));
    const actual = ledger.doneParts(key, group);
    if (expected.size !== actual.size || [...expected].some((i) => !actual.has(i))) return false;
    if (submitted.some((e) => e.bv !== bv)) return false;
  }
  return !bv || journal.entries.some((e) => e.kind === "create" && e.state === "submitted" && e.bv === bv);
}

export function masterUploadFailurePlan(ledger: SyncLedger, key: string, error?: unknown): UploadFailurePlan | null {
  const job = ledger.get(key);
  const journal = parseJournal(job?.uploadJournal);
  if (!journal) return job?.uploadJournal == null ? null : classifyUploadOutcome({ ambiguous: true });
  const last = error ?? job?.error ?? journal.failure;
  if (journal.legacy || journal.entries.length === 0 || !consistent(ledger, key, journal)) {
    return classifyUploadOutcome({ ambiguous: true, error: last });
  }
  const unknown = journal.entries.some((e) => e.state === "intent");
  return classifyUploadOutcome({
    bv: job?.bv, intentCommitted: unknown,
    partsConfirmed: !unknown, ambiguous: unknown || journal.failure?.ambiguous,
    error: last,
  });
}

type SubmitInput = {
  deps: PipelineDeps; key: string; group: string; indices: number[]; files: string[];
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
  if (!journal.legacy && !consistent(deps.ledger, key, journal)) throw ambiguous("submission checkpoints disagree");
  if (!files.length || indices.length !== files.length || new Set(indices).size !== indices.length) {
    throw ambiguous("invalid submission part indices");
  }
  const currentBv = deps.ledger.get(key)?.bv;
  if ((input.create && currentBv) || (!input.create && (!input.bv || currentBv !== input.bv))) {
    throw ambiguous("upload archive identity changed");
  }
  const fp = fingerprint(files);
  const overlapping = journal.entries.filter((e) => e.group === group && e.indices.some((i) => indices.includes(i)));
  const previous = overlapping[0];
  if (overlapping.length > 1 || (previous && (JSON.stringify(previous.indices) !== JSON.stringify(indices)
    || previous.kind !== (input.create ? "create" : "append")
    || (previous.fingerprint !== fp && previous.state !== "not-submitted")))) {
    throw ambiguous("upload inputs changed since submission");
  }
  if (journal.entries.some((e) => e.state === "intent")) throw ambiguous("unresolved submission intent; refusing to resend");
  if (previous?.state === "submitted") {
    if (!consistent(deps.ledger, key, journal)) throw ambiguous("submission checkpoints disagree");
    return previous.bv!;
  }
  const entry: Submission = { kind: input.create ? "create" : "append", group, indices, fingerprint: fp, state: "intent" };
  if (previous) journal.entries.splice(journal.entries.indexOf(previous), 1, entry);
  else journal.entries.push(entry);
  delete journal.failure;
  const intent = JSON.stringify(journal);
  deps.ledger.saveUploadJournal(key, raw, intent);
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
    journal.failure = {
      message: String((error as Error)?.message ?? error).slice(0, 300),
      code: classifyRetryableFailure(error).code, ambiguous: !rejected,
    };
    deps.ledger.saveUploadJournal(key, intent, JSON.stringify(journal));
    if (isJobAbort(error) || rejected) throw error;
    throw ambiguous(journal.failure.message);
  }
  entry.state = "submitted";
  entry.bv = bv;
  // Deferred returns guarantee acceptance, not observation. Never promote it to observed here.
  entry.proof = input.create ? "created" : input.deferred ? "accepted" : "observed";
  deps.ledger.saveUploadJournal(key, intent, JSON.stringify(journal), {
    bv, group, indices, seasonPending: !!input.create && !!deps.cfg.uploadMeta.seasonSectionId,
  });
  return bv;
}

export function createMasterArchive(deps: PipelineDeps, key: string, opts: UploadOpts): Promise<string> {
  const files = opts.videos?.length ? opts.videos : opts.video ? [opts.video] : [];
  return submit({ deps, key, group: "plain", indices: [0], files, create: opts });
}

export async function appendMasterParts(
  deps: PipelineDeps, key: string, bv: string, group: string, indices: number[], files: string[], deferred: boolean,
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
