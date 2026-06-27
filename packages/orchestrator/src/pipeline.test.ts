import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { runPipeline, type PipelineDeps } from "./pipeline.js";
import { SyncLedger } from "./ledger.js";
import type { Broadcast } from "./identity.js";
import type { NodeRecording, Transport } from "./transport.js";
import type { NotifyEvent } from "@drec/core";

function freshLedger(): SyncLedger {
  return new SyncLedger(join(mkdtempSync(join(tmpdir(), "pipeline-test-")), "test.db"));
}

function makeRec(overrides: Partial<NodeRecording> = {}): NodeRecording {
  return {
    roomSlug: "test-room",
    sessionBase: "主播名_2026-06-27_08-00-00",
    tsFiles: ["/remote/a.ts", "/remote/b.ts"],
    xmlPath: "/remote/danmu.xml",
    durationSec: 3600,
    startMs: Date.now() - 3_600_000,
    endMs: Date.now(),
    totalGapSec: 0,
    ...overrides,
  };
}

function makeBroadcast(members: Array<{ tenantId: string; rec: NodeRecording }>): Broadcast {
  return {
    streamKey: "douyin:test-room:2026-06-27",
    roomSlug: "test-room",
    startMs: Date.now() - 3_600_000,
    members,
  };
}

function makeTransport(tenantId: string): Transport {
  return {
    id: tenantId,
    listInventory: vi.fn().mockResolvedValue({ tenantId, recordings: [] }),
    isDone: vi.fn().mockResolvedValue(true),
    pull: vi.fn().mockResolvedValue(undefined),
  };
}

function makeDeps(overrides: Partial<PipelineDeps> = {}): PipelineDeps & {
  sh: ReturnType<typeof vi.fn>;
  upload: ReturnType<typeof vi.fn>;
  notify: ReturnType<typeof vi.fn>;
  transports: Map<string, Transport>;
  ledger: SyncLedger;
} {
  const ledger = freshLedger();
  const t1 = makeTransport("node-1");
  const t2 = makeTransport("node-2");
  const transports = new Map([["node-1", t1], ["node-2", t2]]);
  const sh = vi.fn().mockResolvedValue(undefined);
  const upload = vi.fn().mockResolvedValue("BV123");
  const notify = vi.fn();

  return {
    transports,
    ledger,
    sh,
    upload,
    notify,
    cfg: {
      cleanMaxGapSec: 30,
      stageDir: "/tmp/stage",
      cookies: "/tmp/cookies.json",
      uploadMode: "auto-private",
      uploadMeta: {
        tag: "直播录像",
        tid: 21,
        desc: "直播录像",
      },
    },
    ...overrides,
  };
}

describe("runPipeline", () => {
  it("场景1: 有干净胜者 + auto-private → merge/burn×2/upload, ledger=done, bv=BV123", async () => {
    const cleanRec = makeRec({ totalGapSec: 0 });    // winner: totalGapSec=0, coverage=1
    const dirtyRec = makeRec({ totalGapSec: 200 });   // loser: totalGapSec=200

    const broadcast = makeBroadcast([
      { tenantId: "node-1", rec: cleanRec },
      { tenantId: "node-2", rec: dirtyRec },
    ]);

    const deps = makeDeps();
    deps.ledger.upsertPending(broadcast.streamKey);

    const result = await runPipeline(broadcast, deps);

    // Should succeed with BV
    expect(result.state).toBe("done");
    expect(result.bv).toBe("BV123");

    // sh should be called 3 times: merge + burn danmu + burn livechat
    expect(deps.sh).toHaveBeenCalledTimes(3);
    const shCalls = deps.sh.mock.calls.map((c) => c[0] as string);
    expect(shCalls[0]).toContain("merge");
    expect(shCalls[1]).toContain("burn");
    expect(shCalls[1]).toContain("danmu");
    expect(shCalls[2]).toContain("burn");
    expect(shCalls[2]).toContain("livechat");

    // upload should be called once
    expect(deps.upload).toHaveBeenCalledTimes(1);

    // notify should NOT be called with error (clean winner case)
    const errorNotifications = (deps.notify.mock.calls as Array<[NotifyEvent]>)
      .filter(([e]) => e.kind === "error");
    expect(errorNotifications).toHaveLength(0);

    // ledger should end at "done"
    const job = deps.ledger.get(broadcast.streamKey);
    expect(job?.state).toBe("done");
    expect(job?.bv).toBe("BV123");

    deps.ledger.close();
  });

  it("场景2: 都断(无干净胜者) → upload未调, notify收到error, ledger=needs_manual", async () => {
    // Both have large gaps, exceeding cleanMaxGapSec=30
    const dirtyRec1 = makeRec({ totalGapSec: 200 });
    const dirtyRec2 = makeRec({ totalGapSec: 200 });

    const broadcast = makeBroadcast([
      { tenantId: "node-1", rec: dirtyRec1 },
      { tenantId: "node-2", rec: dirtyRec2 },
    ]);

    const deps = makeDeps();
    deps.ledger.upsertPending(broadcast.streamKey);

    const result = await runPipeline(broadcast, deps);

    // Should escalate to manual
    expect(result.state).toBe("needs_manual");
    expect(result.bv).toBeUndefined();

    // sh should still be called 3 times (merge+burn happen even for dirty, per spec)
    expect(deps.sh).toHaveBeenCalledTimes(3);

    // upload should NOT be called
    expect(deps.upload).toHaveBeenCalledTimes(0);

    // notify should be called with an error event for "同步"
    const errorNotifications = (deps.notify.mock.calls as Array<[NotifyEvent]>)
      .filter(([e]) => e.kind === "error");
    expect(errorNotifications).toHaveLength(1);
    const [errEvent] = errorNotifications[0];
    expect(errEvent.kind).toBe("error");
    if (errEvent.kind === "error") {
      expect(errEvent.stage).toBe("同步");
      expect(errEvent.message).toContain("覆盖度");
    }

    // ledger should end at "needs_manual"
    const job = deps.ledger.get(broadcast.streamKey);
    expect(job?.state).toBe("needs_manual");

    deps.ledger.close();
  });
});
