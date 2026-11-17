import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { DatabaseSync } from "node:sqlite";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import { HUB_TABLE_NAMES, jobLogPathCandidates } from "@drec/core";
import {
  deleteHubHistory, roomKeyToStreamPrefix,
  type DeleteHubHistoryOptions,
} from "../../packages/orchestrator/src/ledger-history.js";
import { SyncLedger } from "../../packages/orchestrator/src/ledger.js";

type HistoryTable = (typeof HUB_TABLE_NAMES)[number];
type HistoryRow = Record<string, unknown> & { streamKey: string };
type HistorySnapshot = Partial<Record<HistoryTable, HistoryRow[]>>;

let dir: string;
let options: DeleteHubHistoryOptions;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "room-history-isolation-"));
  options = {
    syncDbPath: join(dir, "sync.db"),
    roomKey: "douyin.alpha_beta",
    stageDir: join(dir, "stage"),
    logsDir: join(dir, "logs"),
  };
});

afterEach(() => {
  rmSync(dir, { recursive: true, force: true });
});

function seedHistory(keys: string[]): void {
  new SyncLedger(options.syncDbPath).close();
  const db = new DatabaseSync(options.syncDbPath);
  try {
    for (const key of keys) {
      db.prepare(`INSERT INTO sync_jobs
        (streamKey, state, winnerWorker, bv, error, fails, startMs, updatedAt, outputStem,
          followups, uploadPlan, uploadStatus, ackedAt, ackNote, seasonState)
        VALUES (?, 'done', 'worker-a', 'archive-fixture', NULL, 2, 10, 20, ?, ?, ?, ?, 30, ?, ?)`)
        .run(key, `stem:${key}`, JSON.stringify({ remux: { key, generation: 2 } }),
          JSON.stringify({ jobs: [`part:${key}`], nextPart: 3 }),
          JSON.stringify({ completed: 2, bytes: 4096 }), `review:${key}`,
          JSON.stringify({ state: "done", archive: key }));
      for (let index = 1; index <= 2; index++) {
        db.prepare("INSERT INTO sync_job_events(streamKey, state, at) VALUES (?, 'done', ?)")
          .run(key, index);
        db.prepare(`INSERT INTO sync_job_steps(streamKey, step, phase, at, detail)
          VALUES (?, 'upload_plain', 'done', ?, ?)`)
          .run(key, index, JSON.stringify({ checkpoint: index, key }));
        db.prepare(`INSERT INTO sync_candidates
          (streamKey, workerId, coverage, durationSec, startMs, endMs, totalGapSec,
            isWinner, updatedAt, danmuCount) VALUES (?, ?, 1, 120, 10, 130, 0, ?, 20, 7)`)
          .run(key, `worker-${index}`, index === 1 ? 1 : 0);
        db.prepare(`INSERT INTO sync_node_states
          (streamKey, node, state, error, attempts, updatedAt) VALUES (?, ?, 'done', NULL, 2, 20)`)
          .run(key, `upload-${index}`);
        db.prepare(`INSERT INTO sync_parts(streamKey, groupName, partIndex, updatedAt)
          VALUES (?, 'plain', ?, 20)`).run(key, index);
      }
    }
  } finally {
    db.close();
  }
}

function readHistory(tables: readonly HistoryTable[] = HUB_TABLE_NAMES): HistorySnapshot {
  const db = new DatabaseSync(options.syncDbPath);
  try {
    return Object.fromEntries(tables.map((table) => [
      table, db.prepare(`SELECT * FROM ${table} ORDER BY streamKey, rowid`).all(),
    ])) as HistorySnapshot;
  } finally {
    db.close();
  }
}

function seedLogs(keys: string[]): Map<string, Buffer> {
  const logs = new Map<string, Buffer>();
  for (const key of keys) {
    const paths = jobLogPathCandidates(options.stageDir, key, options.logsDir);
    for (const [index, path] of paths.entries()) {
      const bytes = Buffer.from(`log:${key}:${index}\n\0checkpoint\xff`, "latin1");
      mkdirSync(dirname(path), { recursive: true });
      writeFileSync(path, bytes);
      logs.set(path, bytes);
    }
  }
  return logs;
}

function expectLogsUnchanged(logs: Map<string, Buffer>): void {
  for (const [path, bytes] of logs) {
    expect.soft(existsSync(path), path).toBe(true);
    if (existsSync(path)) expect.soft(readFileSync(path), path).toEqual(bytes);
  }
}

const identities = [
  { name: "underscore", room: "douyin.alpha_beta", prefix: "douyin:alpha_beta:",
    siblings: ["douyin:alphaXbeta:", "douyin:alpha_beta_extra:"] },
  { name: "percent", room: "douyin.alpha%beta", prefix: "douyin:alpha%beta:",
    siblings: ["douyin:alphaZZbeta:", "douyin:alphabeta:"] },
  { name: "bang", room: "douyin.alpha!beta", prefix: "douyin:alpha!beta:",
    siblings: ["douyin:alphabeta:", "douyin:alpha!Xbeta:"] },
  { name: "longer room", room: "douyin.alpha", prefix: "douyin:alpha:",
    siblings: ["douyin:alphabeta:", "douyin:alpha_extra:"] },
  { name: "room case", room: "douyin.alphaBeta", prefix: "douyin:alphaBeta:",
    siblings: ["douyin:alphabeta:", "douyin:AlphaBeta:"] },
  { name: "platform", room: "douyin.alpha", prefix: "douyin:alpha:",
    siblings: ["bilibili:alpha:", "kuaishou:alpha:"] },
  { name: "platform case", room: "douyin.alpha", prefix: "douyin:alpha:",
    siblings: ["Douyin:alpha:", "DOUYIN:alpha:"] },
  { name: "first dot only", room: "douyin.alpha.beta", prefix: "douyin:alpha.beta:",
    siblings: ["douyin:alpha:beta:", "douyin:alphaXbeta:"] },
];

describe("room history literal identity", () => {
  it.each(identities)("isolates $name across every history table and both log roots", (identity) => {
    options.roomKey = identity.room;
    expect(roomKeyToStreamPrefix(identity.room)).toBe(identity.prefix);
    const targetKeys = ["2026-01-01", "2026-01-02_1200"].map((run) => identity.prefix + run);
    // Different run dates keep case-only identities distinct on case-insensitive filesystems.
    const siblingKeys = identity.siblings.map((prefix, index) => `${prefix}2026-02-0${index + 1}`);
    seedHistory([...targetKeys, ...siblingKeys]);
    const before = readHistory();
    const targetLogs = seedLogs(targetKeys);
    const siblingLogs = seedLogs(siblingKeys);
    expect(targetLogs.size).toBe(targetKeys.length * 2);

    const result = deleteHubHistory(options);

    expect.soft(result.deleted).toBe(2);
    expect.soft([...result.streamKeys].sort()).toEqual([...targetKeys].sort());
    const after = readHistory();
    for (const table of HUB_TABLE_NAMES) {
      const retained = before[table]!.filter((row) => !targetKeys.includes(row.streamKey));
      expect.soft(after[table], table).toEqual(retained);
    }
    for (const path of targetLogs.keys()) expect.soft(existsSync(path), path).toBe(false);
    expectLogsUnchanged(siblingLogs);
    expect.soft(deleteHubHistory(options)).toEqual({ deleted: 0, streamKeys: [] });
    expect.soft(readHistory()).toEqual(after);
    expectLogsUnchanged(siblingLogs);
  });

  it("does not create an absent database or remove logs without discovered runs", () => {
    options.roomKey = "douyin.alpha_beta";
    const logs = seedLogs(["douyin:alpha_beta:2026-01-01"]);
    expect(deleteHubHistory(options)).toEqual({ deleted: 0, streamKeys: [] });
    expect(existsSync(options.syncDbPath)).toBe(false);
    expectLogsUnchanged(logs);
  });

  it("accepts an empty legacy database without creating history tables or removing logs", () => {
    options.roomKey = "douyin.alpha_beta";
    new DatabaseSync(options.syncDbPath).close();
    const logs = seedLogs(["douyin:alpha_beta:2026-01-01"]);
    expect(deleteHubHistory(options)).toEqual({ deleted: 0, streamKeys: [] });
    const db = new DatabaseSync(options.syncDbPath);
    try {
      expect(db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all()).toEqual([]);
    } finally {
      db.close();
    }
    expectLogsUnchanged(logs);
  });

  const legacyTables: HistoryTable[][] = [
    ["sync_jobs"], ["sync_parts"],
    ["sync_jobs", "sync_job_events", "sync_candidates"],
  ];
  it.each(legacyTables.map((tables) => ({ tables, name: tables.join(",") })))(
    "deletes only literal rows from explicitly present legacy tables: $name", ({ tables }) => {
      options.roomKey = "douyin.alpha_beta";
      const target = "douyin:alpha_beta:2026-01-01";
      const sibling = "douyin:alphaXbeta:2026-01-01";
      seedHistory([target, sibling]);
      const db = new DatabaseSync(options.syncDbPath);
      try {
        for (const table of HUB_TABLE_NAMES) {
          if (!tables.includes(table)) db.exec(`DROP TABLE ${table}`);
        }
      } finally {
        db.close();
      }
      const before = readHistory(tables);
      const targetLogs = seedLogs([target]);
      const siblingLogs = seedLogs([sibling]);

      const result = deleteHubHistory(options);

      const discoversRuns = tables.includes("sync_jobs");
      expect.soft(result).toEqual({ deleted: discoversRuns ? 1 : 0, streamKeys: discoversRuns ? [target] : [] });
      const after = readHistory(tables);
      for (const table of tables) {
        expect.soft(after[table], table).toEqual(before[table]!.filter((row) => row.streamKey === sibling));
      }
      if (discoversRuns) {
        for (const path of targetLogs.keys()) expect.soft(existsSync(path), path).toBe(false);
      } else {
        expectLogsUnchanged(targetLogs);
      }
      expectLogsUnchanged(siblingLogs);
    },
  );

  it("forces binary comparison even when the streamKey column declares NOCASE", () => {
    options.roomKey = "douyin.alphaBeta";
    const target = "douyin:alphaBeta:2026-01-01";
    const sibling = "douyin:alphabeta:2026-01-01";
    const db = new DatabaseSync(options.syncDbPath);
    try {
      db.exec(`CREATE TABLE sync_jobs(streamKey TEXT COLLATE NOCASE,
        state TEXT NOT NULL, updatedAt INTEGER NOT NULL)`);
      db.prepare("INSERT INTO sync_jobs(streamKey, state, updatedAt) VALUES(?, 'done', 1)")
        .run(target);
      db.prepare("INSERT INTO sync_jobs(streamKey, state, updatedAt) VALUES(?, 'done', 1)")
        .run(sibling);
    } finally {
      db.close();
    }

    expect(deleteHubHistory(options)).toEqual({ deleted: 1, streamKeys: [target] });
    const after = new DatabaseSync(options.syncDbPath);
    try {
      expect(after.prepare("SELECT streamKey FROM sync_jobs").all())
        .toEqual([{ streamKey: sibling }]);
    } finally {
      after.close();
    }
  });

  it("rolls back every table and keeps all logs when a middle DELETE fails", () => {
    options.roomKey = "douyin.alpha";
    const keys = ["douyin:alpha:2026-01-01", "douyin:alpha:2026-01-02",
      "douyin:alphabeta:2026-01-01"];
    seedHistory(keys);
    const before = readHistory();
    const logs = seedLogs(keys);
    const db = new DatabaseSync(options.syncDbPath);
    try {
      db.exec(`CREATE TRIGGER fail_history_delete BEFORE DELETE ON sync_candidates
        BEGIN SELECT RAISE(ABORT, 'fixture middle delete failure'); END`);
    } finally {
      db.close();
    }

    expect(() => deleteHubHistory(options)).toThrow("fixture middle delete failure");

    expect(readHistory()).toEqual(before);
    expectLogsUnchanged(logs);
    const cleanup = new DatabaseSync(options.syncDbPath);
    try {
      cleanup.exec("DROP TRIGGER fail_history_delete");
    } finally {
      cleanup.close();
    }
    expect.soft(deleteHubHistory(options).deleted).toBe(2);
    const after = readHistory();
    for (const table of HUB_TABLE_NAMES) {
      expect.soft(after[table], table).toEqual(before[table]!.filter((row) => row.streamKey === keys[2]));
    }
  });
});
