import { describe, expect, it, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, utimesSync, writeFileSync, existsSync, chmodSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { readFileSync } from "node:fs";
import { cleanupJobLogs, parseJobLogDays, previewJobLogs, selectJobLogs } from "../../packages/app/src/job-log-cleanup.js";
import { buildMaintenance } from "../../packages/app/src/web/api/maintenance.js";

const DAY = 24 * 3600_000;
const NOW = Date.UTC(2026, 9, 30);

describe("job log cleanup (issue #414)", () => {
  let root: string;
  let roomDir: string;

  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "joblog-"));
    roomDir = join(root, "hub", "douyin_123");
    mkdirSync(roomDir, { recursive: true });
  });
  afterEach(() => rmSync(root, { recursive: true, force: true }));

  /** Write a log of `bytes` size whose mtime is `ageDays` before NOW. */
  function log(name: string, ageDays: number, bytes = 10, dir = roomDir): string {
    const p = join(dir, name);
    writeFileSync(p, "x".repeat(bytes));
    const at = new Date(NOW - ageDays * DAY);
    utimesSync(p, at, at);
    return p;
  }

  it("selects only .log files strictly older than N days", () => {
    const old = log("a.log", 8, 100);
    log("fresh.log", 6, 50);
    const exact = log("edge.log", 7, 30); // exactly 7 days old: not yet older than 7
    const s = selectJobLogs(root, 7, NOW);
    expect(s.files).toEqual([old]);
    expect(s.bytes).toBe(100);
    expect(existsSync(exact)).toBe(true);
  });

  it("ignores non-.log files and missing roots", () => {
    log("note.txt", 30);
    writeFileSync(join(roomDir, "stage.md"), "x");
    expect(selectJobLogs(root, 1, NOW).files).toEqual([]);
    expect(selectJobLogs(join(root, "nope"), 1, NOW).files).toEqual([]);
  });

  it("preview counts exactly what cleanup then deletes, and deletes nothing by itself", () => {
    const a = log("a.log", 10, 200);
    const b = log("b.log", 20, 300);
    log("keep.log", 1, 5);
    expect(previewJobLogs(root, 7, NOW)).toEqual({ olderThanDays: 7, count: 2, bytes: 500 });
    expect(existsSync(a) && existsSync(b)).toBe(true);
    const r = cleanupJobLogs(root, 7, NOW, join(root, "audit-p"));
    expect(r).toEqual({ olderThanDays: 7, deleted: 2, bytes: 500, failed: [] });
    expect(existsSync(a) || existsSync(b)).toBe(false);
  });

  // Root ignores directory permission bits, so the failure cannot be produced there.
  it.skipIf(process.getuid?.() === 0)("reports a failed delete instead of swallowing it", () => {
    const a = log("a.log", 30, 40);
    const b = log("b.log", 30, 60);
    // A read-only room directory makes the removal of its files fail; the failure must come back.
    chmodSync(roomDir, 0o500);
    try {
      const r = cleanupJobLogs(root, 7, NOW);
      expect(r.deleted).toBe(0);
      expect(r.failed.map((f) => f.file).sort()).toEqual(["a.log", "b.log"]);
      // The error must be a code, not the fs message: that message carries the full path.
      expect(r.failed.every((f) => f.error === "EACCES" || f.error === "EPERM")).toBe(true);
      expect(JSON.stringify(r)).not.toContain(root);
      expect(existsSync(a) && existsSync(b)).toBe(true);
    } finally {
      chmodSync(roomDir, 0o700);
    }
  });

  it("validates the day count: integers 1..3650 only", () => {
    expect(parseJobLogDays(7)).toBe(7);
    expect(parseJobLogDays("30")).toBe(30);
    expect(parseJobLogDays(0)).toBeNull();
    expect(parseJobLogDays(-1)).toBeNull();
    expect(parseJobLogDays(1.5)).toBeNull();
    expect(parseJobLogDays("")).toBeNull();
    expect(parseJobLogDays(3651)).toBeNull();
    expect(parseJobLogDays(undefined)).toBeNull();
  });

  it("the endpoint refuses to delete without confirm, and validates the day count", () => {
    const p = log("keep.log", 30, 10);
    // Stubs: the maintenance handler only reads these for its own activity guard, which the job-log path does not use.
    const api = buildMaintenance({
      store: { listTasks: () => [] } as never,
      manager: { isRecording: () => false, getAnchorName: () => null } as never,
      dataRoot: root,
      logsDir: root,
      auditDir: join(root, "audit3"),
    });
    expect(api.cleanupJobLogs({ olderThanDays: 7 }).status).toBe(400);
    expect(api.cleanupJobLogs({ olderThanDays: 0, confirm: true }).status).toBe(400);
    expect(existsSync(p)).toBe(true);
    const ok = api.cleanupJobLogs({ olderThanDays: 7, confirm: true });
    expect(ok.status).toBe(200);
    expect(existsSync(p)).toBe(false);
    expect(api.previewJobLogs("abc").status).toBe(400);
  });


  it("audits deletions to the shared maintenance audit file, failures included", () => {
    const auditDir = join(root, "audit");
    // Two rooms: one read-only (its file fails) and one writable (its file deletes).
    const otherDir = join(root, "hub", "other-room");
    mkdirSync(otherDir, { recursive: true });
    log("gone.log", 30, 10, otherDir);
    log("stays.log", 30, 10);
    const failing = process.getuid?.() !== 0;
    if (failing) chmodSync(roomDir, 0o500);
    try {
      cleanupJobLogs(root, 7, NOW, auditDir);
    } finally {
      if (failing) chmodSync(roomDir, 0o700);
    }
    const lines = readFileSync(join(auditDir, "cleanup-audit.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
    if (failing) {
      expect(lines.find((l) => l.action === "deleted")).toMatchObject({ kind: "jobLog", count: 1 });
      expect(lines.find((l) => l.action === "failed")).toMatchObject({ kind: "jobLog", path: "hub/douyin_123/stays.log" });
    } else {
      expect(lines).toEqual([expect.objectContaining({ action: "deleted", kind: "jobLog", count: 2 })]);
    }
    // Preview never writes the audit.
    const before = readFileSync(join(auditDir, "cleanup-audit.jsonl"), "utf-8");
    previewJobLogs(root, 7, NOW);
    expect(readFileSync(join(auditDir, "cleanup-audit.jsonl"), "utf-8")).toBe(before);
  });

  it("writes nothing when there is nothing to delete", () => {
    const auditDir = join(root, "audit2");
    cleanupJobLogs(root, 7, NOW, auditDir);
    expect(existsSync(join(auditDir, "cleanup-audit.jsonl"))).toBe(false);
  });


  it("a failing audit write does not block the deletion", () => {
    const auditDir = join(root, "audit4");
    writeFileSync(auditDir, "not a directory");
    log("gone.log", 30, 10);
    let r;
    expect(() => { r = cleanupJobLogs(root, 7, NOW, auditDir); }).not.toThrow();
    expect(r?.deleted).toBe(1);
    expect(existsSync(join(roomDir, "gone.log"))).toBe(false);
  });

  it("audit rows carry an error code, not the fs message with the full path", () => {
    if (process.getuid?.() === 0) return; // permission bits are ignored by root
    const auditDir = join(root, "audit5");
    log("locked.log", 30, 10);
    chmodSync(roomDir, 0o500);
    try {
      const r = cleanupJobLogs(root, 7, NOW, auditDir);
      expect(JSON.stringify(r)).not.toContain(root);
      const lines = readFileSync(join(auditDir, "cleanup-audit.jsonl"), "utf-8").trim().split("\n").map((l) => JSON.parse(l));
      expect(lines.every((l) => l.action !== "failed" || (l.error === "EACCES" || l.error === "EPERM"))).toBe(true);
    } finally {
      chmodSync(roomDir, 0o700);
    }
  });
});
