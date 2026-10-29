// plan 038 T15b: the master queue entry point (decide → persist plan → advance once; plan owns the order).
import { describe, it, expect, vi } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { EnqueueRequest, EnqueueResponse, ProcessJob } from "@drec/core";
import { SyncLedger } from "../../packages/orchestrator/src/ledger.js";
import { tryQueueUpload, queueUploadInput } from "../../packages/orchestrator/src/node-upload-dispatch.js";
import { tryNodeSideUpload, type NodeSideUploadArgs } from "../../packages/orchestrator/src/node-side-upload.js";
import { DEFAULT_NODE_UPLOAD, type NodeUploadConfig } from "../../packages/orchestrator/src/node-upload-config.js";
import type { PipelineCfg } from "../../packages/orchestrator/src/pipeline.js";

const KEY = "douyin:1:2026-10-17";
const QUEUE: NodeUploadConfig = { ...DEFAULT_NODE_UPLOAD, mode: "queue" };
const cfg = {
  stageDir: "/master/stage", cookies: "/master/c.json", uploadMode: "upload", uploadPrivate: true, timeZone: "Asia/Shanghai",
  steps: { nodeSideUpload: true, mergeSegments: false }, minSegmentSec: 2,
  uploadMeta: { tag: "t", tid: 21, titleTemplate: "{name}_{date}", submissionTitleTemplate: "{title} 回放", partTitleTemplate: "P{part}" },
} as unknown as PipelineCfg;

function node(caps: string[] = ["upload-prep", "biliup", "biliup-queue"], rolling = 0) {
  const jobs: ProcessJob[] = [];
  return {
    jobs,
    t: {
      id: "n1",
      nodeCapabilities: async () => ({ biliup: true, cookies: true, diskFreeGB: 100, processors: caps }),
      nodePipeline: vi.fn(async () => ({ ok: true, bv: "BV1TEST" })),
      listTasks: async () => ({ workerId: "n1", tasks: Array.from({ length: rolling }, () => ({ rollingEffective: true, rollingUpload: true })).concat([{ rollingEffective: false, rollingUpload: false }]) }),
      enqueue: vi.fn(async (req: EnqueueRequest): Promise<EnqueueResponse> => {
        jobs.push(...req.jobs);
        return { v: 1, results: req.jobs.map((j) => ({ jobId: j.jobId, state: "pending" as const })) };
      }),
      procStatus: async () => [],
    },
  };
}

function args(t: unknown, nodeUpload?: NodeUploadConfig, durationSec = 900): NodeSideUploadArgs {
  const ledger = new SyncLedger(join(mkdtempSync(join(tmpdir(), "nud-")), "j.db"));
  ledger.upsertPending(KEY);
  ledger.setState(KEY, "syncing"); // the pipeline is past select/sync when it reaches node-side upload
  const member = { workerId: "n1", rec: { tsFiles: ["/n/rec/a.ts", "/n/rec/b.ts"], durationSec } };
  return {
    streamKey: KEY, cfg, winner: member, winnerMembers: [member], transport: t as never, ledger,
    jlog: () => {}, notify: () => {}, deps: { nodeUpload } as never,
    earliest: { rec: { sessionBase: "主播_2026-10-17_20-00-00", startMs: Date.UTC(2026, 9, 17, 12), title: "夜聊" } },
  };
}

describe("tryQueueUpload", () => {
  it("default config is blocking: nothing is enqueued or persisted", async () => {
    const n = node();
    const a = args(n.t);
    expect(await tryQueueUpload(a, ["biliup-queue"])).toBeNull();
    expect(n.t.enqueue).not.toHaveBeenCalled();
    expect(a.ledger.getUploadPlan(KEY)).toBeNull();
  });

  it("queue mode without the node capability, or beside rolling upload, stays blocking", async () => {
    expect(await tryQueueUpload(args(node(["biliup"]).t, QUEUE), ["biliup"])).toBeNull();
    const rolling = node(undefined, 1);
    expect(await tryQueueUpload(args(rolling.t, QUEUE), ["biliup-queue"])).toBeNull();
    expect(rolling.t.enqueue).not.toHaveBeenCalled();
  });

  it("unknown duration (no no-draft proof possible) stays blocking", async () => {
    const n = node();
    expect(await tryQueueUpload(args(n.t, QUEUE, 0), ["biliup-queue"])).toBeNull();
    expect(n.t.enqueue).not.toHaveBeenCalled();
  });

  it("queue: plan pinned to the winner, prep enqueued once, ledger state unchanged", async () => {
    const n = node();
    const a = args(n.t, QUEUE);
    expect(await tryQueueUpload(a, ["biliup-queue"])).toEqual({ state: "syncing" });
    const plan = JSON.parse(a.ledger.getUploadPlan(KEY)!);
    expect(plan).toMatchObject({ nodeId: "n1", orderKey: KEY });
    expect(n.jobs.map((j) => j.kind)).toEqual(["upload-prep"]);
    expect(n.jobs[0]!.inputs).toEqual(["/n/rec/a.ts", "/n/rec/b.ts"]);
  });

  it("tryNodeSideUpload: once a plan exists no blocking upload is ever started", async () => {
    const n = node();
    const a = args(n.t, QUEUE);
    expect((await tryNodeSideUpload(a))?.state).toBe("syncing");
    expect((await tryNodeSideUpload({ ...a, deps: { nodeUpload: DEFAULT_NODE_UPLOAD } as never }))?.state).toBe("syncing");
    expect(n.t.nodePipeline).not.toHaveBeenCalled();
    expect(n.jobs).toHaveLength(1);
  });
});

describe("queueUploadInput", () => {
  it("renders the submission title and carries the part-title template + context to the node", () => {
    const i = queueUploadInput(args(node().t, QUEUE));
    expect(i.meta).toMatchObject({ title: "夜聊 回放", public: false, expectedDurationSec: 900, partTitleTemplate: "P{part}" });
    expect(i.meta.titleCtx).toMatchObject({ liveTitle: "夜聊", timeZone: "Asia/Shanghai" });
    expect(i.prep).toMatchObject({ mergeSegments: false, minSegmentSec: 2, tsDirect: false });
  });

  it("anchor name with emoji/dots: stem is sanitized, submission title keeps original chars (#171)", () => {
    const a = args(node().t, QUEUE);
    a.cfg = { ...cfg, uploadMeta: { ...cfg.uploadMeta, submissionTitleTemplate: undefined } } as PipelineCfg;
    a.earliest = { rec: { sessionBase: "主播🌟.喵_2026-10-17_20-00-00", startMs: Date.UTC(2026, 9, 17, 12) } } as never;
    const i = queueUploadInput(a);
    expect(i.prep.stem).toBe("主播-喵_2026-10-17");
    expect(i.meta.title).toBe("主播🌟.喵_2026-10-17");
  });
});
