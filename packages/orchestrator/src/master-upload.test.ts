import { afterEach, describe, expect, it, vi } from "vitest";
import { linkSync, mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { DatabaseSync } from "node:sqlite";
import { abortJob, fakeUploadTarget, runWithJob } from "@drec/core";
import type { PipelineDeps } from "./pipeline.js";
import { SyncLedger } from "./ledger.js";
import { Reconciler } from "./reconciler.js";
import { ResourcePool } from "./workflow.js";
import { appendMasterParts, bindMasterPlan, createMasterArchive, markMasterFailure, masterUploadFailurePlan, prepareMasterUpload, validateMasterParts } from "./master-upload.js";
import type { NodeInventory, Transport } from "./transport.js";

const KEY = "douyin:retry-fixture:2026-06-22";
const ARCHIVE = "archive-fixture";
const resources: SyncLedger[] = [];
afterEach(() => { resources.splice(0).forEach((l) => l.close()); vi.restoreAllMocks(); });

function fixture() {
  const dir = mkdtempSync(join(tmpdir(), "master-submit-"));
  const dbPath = join(dir, "control.db");
  const ledger = new SyncLedger(dbPath);
  resources.push(ledger);
  ledger.upsertPending(KEY);
  const files = [0, 1, 2].map((i) => { const f = join(dir, `part-${i}.mp4`); writeFileSync(f, `part ${i}`); return f; });
  const create = vi.fn(async () => ({ proof: "created" as const, ref: { targetId: "fake", id: ARCHIVE } }));
  const append = vi.fn(async () => ({ proof: "observed" as const }));
  const deps: PipelineDeps = {
    ledger, transports: new Map(), upload: { ...fakeUploadTarget(), create, append },
    sh: async () => {}, notify: vi.fn(),
    cfg: { cleanMaxGapSec: 30, stageDir: dir, cookies: "fixture", uploadMode: "upload", uploadMeta: { tag: "fixture", tid: 21 } },
  };
  const opts = { video: files[0], cookies: "fixture", title: "fixture", tag: "fixture", tid: 21, public: false };
  return { ledger, dbPath, files, deps, opts, create, append };
}

describe("master submission evidence", () => {
  it("commits BV and part evidence together and preserves accepted versus observed", async () => {
    const f = fixture();
    await createMasterArchive(f.deps, KEY, f.opts);
    f.append.mockResolvedValueOnce({ proof: "accepted" } as never);
    await appendMasterParts(f.deps, KEY, ARCHIVE, "append_danmu", [0], [f.files[1]], true);
    const j = JSON.parse(f.ledger.get(KEY)!.uploadJournal!);
    expect(j.entries.map((e: { proof: string }) => e.proof)).toEqual(["created", "accepted"]);
    expect(f.ledger.doneParts(KEY, "plain")).toEqual(new Set([0]));
    expect(f.ledger.doneParts(KEY, "append_danmu")).toEqual(new Set([0]));
    expect(f.ledger.get(KEY)?.bv).toBe(ARCHIVE);
  });

  it("a single rejected create can safely retry; the rejected attempt is not a submitted part", async () => {
    const f = fixture();
    f.create.mockRejectedValueOnce(new Error("code: 601 upload rate limit"));
    await expect(createMasterArchive(f.deps, KEY, f.opts)).rejects.toThrow("601");
    expect(masterUploadFailurePlan(f.ledger, KEY)).toMatchObject({ class: "safe-retry", countsAsFailure: false });
    expect(f.ledger.doneParts(KEY, "plain").size).toBe(0);
    await createMasterArchive(f.deps, KEY, f.opts);
    expect(f.create).toHaveBeenCalledTimes(2);
    expect(f.ledger.doneParts(KEY, "plain")).toEqual(new Set([0]));
  });

  it.each(["Connection timed out", "[plain-no-bv] result unknown", "[append-ambiguous] unknown"])(
    "%s cannot generate a second archive even on direct reentry", async (message) => {
      const f = fixture();
      f.create.mockRejectedValueOnce(new Error(message));
      await expect(createMasterArchive(f.deps, KEY, f.opts)).rejects.toThrow();
      await expect(createMasterArchive(f.deps, KEY, f.opts)).rejects.toThrow("unresolved");
      expect(f.create).toHaveBeenCalledTimes(1);
      expect(masterUploadFailurePlan(f.ledger, KEY)?.class).toBe("verify-manual");
    },
  );

  it("a confirmed P1 plus a rejected append resumes only that append", async () => {
    const f = fixture();
    await createMasterArchive(f.deps, KEY, f.opts);
    f.append.mockRejectedValueOnce(new Error("code: 21540 upload rate limit"));
    await expect(appendMasterParts(f.deps, KEY, ARCHIVE, "append_danmu", [0], [f.files[1]], true)).rejects.toThrow();
    expect(masterUploadFailurePlan(f.ledger, KEY)).toMatchObject({ class: "resume-append", countsAsFailure: false });
    await appendMasterParts(f.deps, KEY, ARCHIVE, "append_danmu", [0], [f.files[1]], true);
    await appendMasterParts(f.deps, KEY, ARCHIVE, "append_danmu", [0], [f.files[1]], true);
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.append).toHaveBeenCalledTimes(2); // a confirmed operation is skipped on direct reentry
  });

  it("a multi-file limit rejection may be partial and never resends the batch", async () => {
    const f = fixture();
    await createMasterArchive(f.deps, KEY, f.opts);
    f.append.mockRejectedValueOnce(new Error("code: 601 upload rate limit"));
    const call = () => appendMasterParts(f.deps, KEY, ARCHIVE, "append_danmu", [0, 1], f.files.slice(1), true);
    await expect(call()).rejects.toThrow();
    await expect(call()).rejects.toThrow("unresolved");
    expect(f.append).toHaveBeenCalledTimes(1);
    expect(masterUploadFailurePlan(f.ledger, KEY)?.class).toBe("verify-manual");
  });

  it("remote success followed by checkpoint failure retains intent and never resends after reopening", async () => {
    const f = fixture();
    const db = new DatabaseSync(f.dbPath);
    db.exec("CREATE TRIGGER fail_part BEFORE INSERT ON sync_parts BEGIN SELECT RAISE(ABORT, 'checkpoint failed'); END");
    await expect(createMasterArchive(f.deps, KEY, f.opts)).rejects.toThrow("checkpoint failed");
    expect(f.ledger.get(KEY)?.bv).toBeNull();
    expect(f.ledger.doneParts(KEY, "plain").size).toBe(0);
    expect(JSON.parse(f.ledger.get(KEY)!.uploadJournal!).entries[0].state).toBe("intent");
    db.exec("DROP TRIGGER fail_part"); db.close();
    const reopened = new SyncLedger(f.dbPath); resources.push(reopened);
    await expect(createMasterArchive({ ...f.deps, ledger: reopened }, KEY, f.opts)).rejects.toThrow("unresolved");
    expect(f.create).toHaveBeenCalledTimes(1);
  });

  it("season checkpoint failure rolls back BV, parts, and submitted evidence together", async () => {
    const f = fixture();
    f.deps.cfg.uploadMeta.seasonSectionId = 42;
    vi.spyOn(f.ledger, "setBvAndSeasonState").mockImplementation(() => { throw new Error("season write failed"); });
    await expect(createMasterArchive(f.deps, KEY, f.opts)).rejects.toThrow("season write failed");
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.ledger.get(KEY)).toMatchObject({ bv: null, seasonState: null });
    expect(f.ledger.doneParts(KEY, "plain")).toEqual(new Set());
    expect(JSON.parse(f.ledger.get(KEY)!.uploadJournal!).entries[0].state).toBe("intent");
    expect(masterUploadFailurePlan(f.ledger, KEY)?.class).toBe("verify-manual");
  });

  it("does not skip a submitted P1 after later parts are rate-limited and P1 changes", async () => {
    const f = fixture();
    await createMasterArchive(f.deps, KEY, f.opts);
    f.append.mockRejectedValueOnce(new Error("code: 601 upload rate limit"));
    await expect(appendMasterParts(f.deps, KEY, ARCHIVE, "plain", [1], [f.files[1]], true)).rejects.toThrow();
    writeFileSync(f.files[0], "changed submitted P1");
    await expect(validateMasterParts(f.ledger, KEY, "plain", f.files)).rejects.toThrow("submitted part changed");
    markMasterFailure(f.deps, KEY, "submitted part changed after confirmation");
    expect(f.ledger.get(KEY)?.state).toBe("needs_manual");
    expect(f.append).toHaveBeenCalledTimes(1);
    expect(f.ledger.get(KEY)?.bv).toBe(ARCHIVE);
    expect(f.files.every((file) => readFileSync(file).length > 0)).toBe(true);
  });

  it("validates submitted P1 when a different append group is rate-limited", async () => {
    const f = fixture();
    await createMasterArchive(f.deps, KEY, f.opts);
    f.append.mockRejectedValueOnce(new Error("code: 601 upload rate limit"));
    await expect(appendMasterParts(f.deps, KEY, ARCHIVE, "append_danmu", [0], [f.files[1]], true))
      .rejects.toThrow("601");

    writeFileSync(f.files[0], "changed submitted P1");
    await expect(validateMasterParts(f.ledger, KEY, "plain", f.files)).rejects.toThrow("submitted part changed");
    markMasterFailure(f.deps, KEY, "submitted part changed after confirmation");
    expect(f.ledger.get(KEY)?.state).toBe("needs_manual");
    expect(f.append).toHaveBeenCalledTimes(1);
    expect(f.files.every((file) => readFileSync(file).length > 0)).toBe(true);
  });

  it("accepts an identical submitted part regenerated with a different inode", async () => {
    const f = fixture();
    await createMasterArchive(f.deps, KEY, f.opts);
    const identical = join(f.deps.cfg.stageDir, "part-0-regenerated.mp4");
    writeFileSync(identical, readFileSync(f.files[0]!));
    await expect(validateMasterParts(f.ledger, KEY, "plain", [identical])).resolves.toBeUndefined();
  });

  it("a completed group must cover every current part index before it can be skipped", async () => {
    const f = fixture();
    await createMasterArchive(f.deps, KEY, f.opts);
    await expect(validateMasterParts(f.ledger, KEY, "plain", f.files, true))
      .rejects.toThrow("does not cover the current part plan");

    const complete = fixture();
    await createMasterArchive(complete.deps, KEY, complete.opts);
    await appendMasterParts(complete.deps, KEY, ARCHIVE, "plain", [1, 2], complete.files.slice(1), true);
    await expect(validateMasterParts(complete.ledger, KEY, "plain", complete.files, true)).resolves.toBeUndefined();
  });

  it("pins target account and execution generation across retries", async () => {
    const f = fixture();
    const credential = join(f.deps.cfg.stageDir, "cookies.json");
    writeFileSync(credential, "account-a");
    const baseTarget = f.deps.upload;
    f.deps.upload = {
      ...baseTarget,
      accountKey: () => "fake:stable-account",
    };
    f.deps.cfg.cookies = credential;
    const opts = { ...f.opts, cookies: credential };
    await createMasterArchive(f.deps, KEY, opts);
    f.append.mockRejectedValueOnce(new Error("code: 601 upload rate limit"));
    await expect(appendMasterParts(f.deps, KEY, ARCHIVE, "append_danmu", [0], [f.files[1]], true)).rejects.toThrow();
    const before = JSON.parse(f.ledger.get(KEY)!.uploadJournal!);
    expect(before.identity.generation).toBe(before.generation);
    writeFileSync(credential, "account-b");
    await expect(appendMasterParts(f.deps, KEY, ARCHIVE, "append_danmu", [0], [f.files[1]], true))
      .rejects.toThrow("account changed");
    markMasterFailure(f.deps, KEY, "upload target or account changed during retry");
    expect(f.ledger.get(KEY)?.state).toBe("needs_manual");
    expect(f.append).toHaveBeenCalledTimes(1);
    expect(JSON.parse(f.ledger.get(KEY)!.uploadJournal!).generation).toBe(before.generation);
  });

  it("only definitely rejected inputs may be regenerated; submitted inputs and indices remain pinned", async () => {
    const f = fixture();
    f.create.mockRejectedValueOnce(new Error("code: 601 upload rate limit"));
    await expect(createMasterArchive(f.deps, KEY, f.opts)).rejects.toThrow();
    const alias = join(f.deps.cfg.stageDir, "alias.mp4"); linkSync(f.files[0], alias);
    await createMasterArchive(f.deps, KEY, { ...f.opts, video: alias });
    f.append.mockRejectedValueOnce(new Error("code: 601 upload rate limit"));
    await expect(appendMasterParts(f.deps, KEY, ARCHIVE, "plain", [1], [f.files[1]], true)).rejects.toThrow();
    writeFileSync(f.files[1], "replaced bytes");
    await appendMasterParts(f.deps, KEY, ARCHIVE, "plain", [1], [f.files[1]], true);
    writeFileSync(f.files[1], "modified after submission");
    await expect(appendMasterParts(f.deps, KEY, ARCHIVE, "plain", [1], [f.files[1]], true)).rejects.toThrow("changed");
    expect(f.append).toHaveBeenCalledTimes(2);
  });

  it("missing, empty, malformed or inconsistent historical evidence is never retry proof", async () => {
    const f = fixture();
    expect(masterUploadFailurePlan(f.ledger, KEY)).toBeNull();
    prepareMasterUpload(f.ledger, KEY);
    expect(masterUploadFailurePlan(f.ledger, KEY)?.class).toBe("verify-manual");
    await createMasterArchive(f.deps, KEY, f.opts);
    const db = new DatabaseSync(f.dbPath);
    db.exec("DELETE FROM sync_parts");
    expect(masterUploadFailurePlan(f.ledger, KEY)?.class).toBe("verify-manual");
    db.prepare("UPDATE sync_jobs SET uploadJournal=? WHERE streamKey=?").run('{"version":1,"entries":[null]}', KEY);
    expect(masterUploadFailurePlan(f.ledger, KEY)?.class).toBe("verify-manual");
    db.close();
  });

  it("legacy create history without intent proof never starts a second archive", async () => {
    const f = fixture();
    f.ledger.logStep(KEY, "upload_plain", "start");
    prepareMasterUpload(f.ledger, KEY);
    expect(JSON.parse(f.ledger.get(KEY)!.uploadJournal!).legacy).toBe(true);
    await expect(createMasterArchive(f.deps, KEY, f.opts)).rejects.toThrow("legacy upload history");
    expect(f.create).not.toHaveBeenCalled();
    expect(masterUploadFailurePlan(f.ledger, KEY)?.retryable).toBe(false);
  });

  it("legacy archive without append proof never resends a previously attempted part", async () => {
    const f = fixture();
    f.ledger.setBv(KEY, ARCHIVE);
    prepareMasterUpload(f.ledger, KEY);
    bindMasterPlan(f.ledger, KEY, "parts", { sources: [f.files[0]] });
    await expect(appendMasterParts(f.deps, KEY, ARCHIVE, "append_danmu", [0], [f.files[1]], true))
      .rejects.toThrow("legacy upload history");
    expect(f.append).not.toHaveBeenCalled();
    const journal = JSON.parse(f.ledger.get(KEY)!.uploadJournal!);
    expect(journal.entries).toEqual([]);
    expect(journal.failure.ambiguous).toBe(true);
    expect(masterUploadFailurePlan(f.ledger, KEY)?.retryable).toBe(false);
  });

  it("malformed submitted fingerprint JSON is marked ambiguous rather than thrown as an ordinary retry", async () => {
    const f = fixture();
    await createMasterArchive(f.deps, KEY, f.opts);
    const raw = f.ledger.get(KEY)!.uploadJournal!;
    const journal = JSON.parse(raw);
    journal.entries[0].fingerprint = "null";
    f.ledger.saveUploadJournal(KEY, raw, JSON.stringify(journal));
    await expect(validateMasterParts(f.ledger, KEY, "plain", [f.files[0]])).rejects.toThrow("fingerprint is malformed");
    expect(masterUploadFailurePlan(f.ledger, KEY)).toMatchObject({ class: "verify-manual", retryable: false });
  });

  it("cross-connection compare-and-set rejects a stale writer without overwriting evidence", () => {
    const f = fixture();
    const other = new SyncLedger(f.dbPath); resources.push(other);
    const stale = f.ledger.get(KEY)!.uploadJournal ?? null;
    prepareMasterUpload(f.ledger, KEY);
    const current = f.ledger.get(KEY)!.uploadJournal;
    expect(() => other.saveUploadJournal(KEY, stale, "stale replacement")).toThrow("concurrently");
    expect(f.ledger.get(KEY)?.uploadJournal).toBe(current);
  });

  it("a stopped job already waiting in an unlimited upload queue does not submit", async () => {
    const f = fixture();
    const pool = new ResourcePool({ uploadRateLimit: 0, minBurnFreeMemMB: 0 });
    let release!: () => void;
    const busy = pool.withUpload(() => new Promise<void>((r) => { release = r; }));
    await vi.waitFor(() => expect(release).toBeTypeOf("function"));
    const queued = runWithJob(KEY, () => pool.withUpload(() => createMasterArchive(f.deps, KEY, f.opts)));
    expect(abortJob(KEY)).toBe(true);
    const rejected = expect(queued).rejects.toThrow("用户停止");
    release(); await busy; await rejected;
    expect(f.create).not.toHaveBeenCalled();
  });

  it("only one overlapping caller may obtain the durable submission intent", async () => {
    const f = fixture();
    let release!: () => void;
    f.create.mockImplementationOnce(async () => {
      await new Promise<void>((r) => { release = r; });
      return { proof: "created", ref: { targetId: "fake", id: ARCHIVE } };
    });
    const first = createMasterArchive(f.deps, KEY, f.opts);
    await vi.waitFor(() => expect(f.create).toHaveBeenCalledTimes(1));
    await expect(createMasterArchive(f.deps, KEY, f.opts)).rejects.toThrow("unresolved");
    release(); await first;
    expect(f.create).toHaveBeenCalledTimes(1);
  });
});

function scheduler(f: ReturnType<typeof fixture>, run: (deps: PipelineDeps) => Promise<void>) {
  const rec = { roomSlug: "retry-fixture", platform: "douyin", sessionBase: "fixture_2026-06-22_08-00-00",
    tsFiles: f.files, durationSec: 600, startMs: Date.parse("2026-06-22T00:00:00Z"),
    endMs: Date.parse("2026-06-22T00:10:00Z"), totalGapSec: 0 };
  const transport = { id: "local", listInventory: vi.fn(async () => ({ workerId: "local", recordings: [rec] })),
    isDone: vi.fn(async () => true), pull: vi.fn(async () => {}) };
  const transports = new Map([["local", transport]]);
  const execute = vi.fn(async (_b: unknown, deps: PipelineDeps) => {
    await run(deps);
    deps.ledger.markDone(KEY, ARCHIVE);
    return { state: "done" as const, bv: ARCHIVE };
  });
  const reconciler = new Reconciler({ platform: "douyin", ledger: f.ledger, transports,
    pipelineDeps: f.deps, runPipeline: execute, reconnectWindowMs: 0, diskMinGB: 0 });
  return { reconciler, transport, execute };
}

describe("master retry scheduling", () => {
  it("returns to the queue without consuming failure budget, and periodic scans cannot bypass the due time", async () => {
    const f = fixture();
    f.create.mockRejectedValueOnce(new Error("code: 601 upload rate limit"));
    const s = scheduler(f, (deps) => createMasterArchive(deps, KEY, f.opts).then(() => {}));
    await s.reconciler.reconcileAll();
    const queued = f.ledger.get(KEY)!;
    expect(queued).toMatchObject({ state: "failed", failureClass: "safe-retry", fails: 0 });
    expect(queued.nextAttemptAt).toBeGreaterThan(Date.now());
    await s.reconciler.reconcileAll();
    await s.reconciler.pollUploadRetries();
    expect(f.create).toHaveBeenCalledTimes(1);
    vi.spyOn(Date, "now").mockReturnValue(queued.nextAttemptAt! + 1);
    await Promise.all([s.reconciler.reconcileAll(), s.reconciler.pollUploadRetries()]);
    await vi.waitFor(() => expect(f.ledger.get(KEY)?.state).toBe("done"));
    expect(f.create).toHaveBeenCalledTimes(2);
    expect(f.ledger.get(KEY)?.nextAttemptAt).toBeNull();
  });

  it("idle ticks perform no inventory queries and a stopped queued job never revives", async () => {
    const f = fixture();
    f.create.mockRejectedValueOnce(new Error("code: 601 upload rate limit"));
    const s = scheduler(f, (deps) => createMasterArchive(deps, KEY, f.opts).then(() => {}));
    await s.reconciler.pollUploadRetries();
    expect(s.transport.listInventory).not.toHaveBeenCalled();
    await s.reconciler.reconcileAll();
    const due = f.ledger.get(KEY)!.nextAttemptAt!;
    await s.reconciler.stopJob(KEY);
    vi.spyOn(Date, "now").mockReturnValue(due + 1);
    await s.reconciler.pollUploadRetries();
    await s.reconciler.reconcileAll();
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.ledger.get(KEY)?.state).toBe("needs_manual");
  });

  it("a due retry skips a broadcast whose recording has not ended", async () => {
    const f = fixture();
    f.create.mockRejectedValueOnce(new Error("code: 601 upload rate limit"));
    const s = scheduler(f, (deps) => createMasterArchive(deps, KEY, f.opts).then(() => {}));
    await s.reconciler.reconcileAll();
    expect(f.ledger.get(KEY)?.state).toBe("failed");
    expect(s.execute).toHaveBeenCalledTimes(1);

    f.ledger.setFailurePlan(KEY, { failureClass: "safe-retry", nextAttemptAt: 0 });
    s.transport.isDone.mockResolvedValue(false);
    await s.reconciler.pollUploadRetries();

    expect(s.transport.isDone).toHaveBeenCalled();
    expect(s.execute).toHaveBeenCalledTimes(1);
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.ledger.get(KEY)?.state).toBe("failed");
  });

  it("unknown responses go manual once, preserving evidence instead of retransmitting", async () => {
    const f = fixture();
    f.create.mockRejectedValueOnce(new Error("timeout after send"));
    const s = scheduler(f, (deps) => createMasterArchive(deps, KEY, f.opts).then(() => {}));
    await s.reconciler.reconcileAll();
    await s.reconciler.reconcileAll();
    await s.reconciler.pollUploadRetries();
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.ledger.get(KEY)).toMatchObject({ state: "needs_manual", nextAttemptAt: null });
  });

  it("reopening the ledger preserves due time and resumes the same rejected submission", async () => {
    const f = fixture();
    f.create.mockRejectedValueOnce(new Error("code: 601 upload rate limit"));
    await scheduler(f, (deps) => createMasterArchive(deps, KEY, f.opts).then(() => {})).reconciler.reconcileAll();
    const due = f.ledger.get(KEY)!.nextAttemptAt!;
    const ledger = new SyncLedger(f.dbPath); resources.push(ledger);
    const next = { ...f, ledger, deps: { ...f.deps, ledger } };
    const s = scheduler(next, (deps) => createMasterArchive(deps, KEY, f.opts).then(() => {}));
    await s.reconciler.pollUploadRetries();
    expect(f.create).toHaveBeenCalledTimes(1);
    vi.spyOn(Date, "now").mockReturnValue(due + 1);
    await s.reconciler.pollUploadRetries();
    await vi.waitFor(() => expect(ledger.get(KEY)?.state).toBe("done"));
    expect(f.create).toHaveBeenCalledTimes(2);
  });

  it("a late disabled room cannot execute a due retry", async () => {
    const f = fixture();
    f.create.mockRejectedValueOnce(new Error("code: 601 upload rate limit"));
    const s = scheduler(f, (deps) => createMasterArchive(deps, KEY, f.opts).then(() => {}));
    await s.reconciler.reconcileAll();
    const due = f.ledger.get(KEY)!.nextAttemptAt!;
    vi.spyOn(Date, "now").mockReturnValue(due + 1);
    const stopped = new Reconciler({ platform: "douyin", ledger: f.ledger,
      transports: new Map([["local", s.transport]]), pipelineDeps: f.deps, resolveCfg: () => null,
      reconnectWindowMs: 0 });
    await stopped.pollUploadRetries();
    expect(f.create).toHaveBeenCalledTimes(1);
    expect(f.ledger.get(KEY)?.state).toBe("failed");
  });

  it("a long retry does not prevent a later due room from using another dispatcher slot", async () => {
    const f = fixture();
    const second = "douyin:other-fixture:2026-06-22";
    f.ledger.upsertPending(second);
    for (const key of [KEY, second]) {
      f.ledger.setState(key, "failed");
      f.ledger.setFailurePlan(key, { failureClass: "safe-retry", nextAttemptAt: key === KEY ? 0 : Date.now() + 60_000 });
    }
    const original = scheduler(f, async () => {});
    const inventory = await original.transport.listInventory();
    const transport: Transport = { ...original.transport, listInventory: vi.fn(async () => ({ workerId: "local",
      recordings: [...inventory.recordings, { ...inventory.recordings[0]!, roomSlug: "other-fixture" }] })) };
    let release!: () => void;
    const started: string[] = [];
    const r = new Reconciler({ platform: "douyin", ledger: f.ledger, transports: new Map([["local", transport]]),
      pipelineDeps: f.deps, reconnectWindowMs: 0, runPipeline: async (b) => {
        started.push(b.streamKey);
        if (b.streamKey === KEY) await new Promise<void>((resolve) => { release = resolve; });
        f.ledger.markDone(b.streamKey, ARCHIVE);
        return { state: "done", bv: ARCHIVE };
      } });
    await r.pollUploadRetries();
    expect(started).toEqual([KEY]);
    f.ledger.setFailurePlan(second, { failureClass: "safe-retry", nextAttemptAt: 0 });
    await r.pollUploadRetries();
    await vi.waitFor(() => expect(f.ledger.get(second)?.state).toBe("done"));
    expect(started).toEqual([KEY, second]);
    release(); await vi.waitFor(() => expect(f.ledger.get(KEY)?.state).toBe("done"));
  });

  it("fast ticks do not escalate ordinary unreachable-worker rounds", async () => {
    const f = fixture();
    f.ledger.setState(KEY, "failed");
    f.ledger.setFailurePlan(KEY, { failureClass: "safe-retry", nextAttemptAt: 0 });
    const original = scheduler(f, async () => {});
    const down: Transport = { ...original.transport, id: "down",
      listInventory: vi.fn<() => Promise<NodeInventory>>().mockRejectedValue(new Error("offline")) };
    const r = new Reconciler({ platform: "douyin", ledger: f.ledger,
      transports: new Map([["local", original.transport], ["down", down]]), pipelineDeps: f.deps,
      reconnectWindowMs: 0, blockedManualRounds: 1,
      resolveCfg: () => ({ ...f.deps.cfg, workers: ["local", "down"] }) });
    await r.pollUploadRetries(); await r.pollUploadRetries();
    expect(f.ledger.get(KEY)?.state).toBe("failed");
    expect(f.create).not.toHaveBeenCalled();
  });

  it("retry time never precedes the existing upload pool cooldown", async () => {
    const f = fixture();
    const now = Date.now();
    const pool = new ResourcePool({ uploadRateLimit: 0, uploadCooldownMs: 3_600_000 });
    await expect(pool.withUpload(async () => { throw new Error("code: 601 upload rate limit"); })).rejects.toThrow();
    f.deps.pool = pool;
    f.create.mockRejectedValueOnce(new Error("code: 601 upload rate limit"));
    const s = scheduler(f, (deps) => createMasterArchive(deps, KEY, f.opts).then(() => {}));
    await s.reconciler.reconcileAll();
    expect(f.ledger.get(KEY)!.nextAttemptAt).toBeGreaterThanOrEqual(now + 3_600_000);
  });
});
