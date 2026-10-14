import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SyncLedger } from "../../packages/orchestrator/src/ledger.js";
import { tryRollingShortCircuit } from "../../packages/orchestrator/src/pipeline.js";
import type { NodeRecording } from "../../packages/orchestrator/src/transport.js";

const KEY = "douyin:123:2026-10-13";
let dir: string;
let ledger: SyncLedger;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rolling-guard-"));
  ledger = new SyncLedger(join(dir, "sync.db"));
  ledger.upsertPending(KEY);
  for (const s of ["syncing", "merging", "uploading"] as const) ledger.setState(KEY, s);
});
afterEach(() => {
  ledger.close();
  rmSync(dir, { recursive: true, force: true });
});

type Rolling = NonNullable<NodeRecording["rolling"]>;
const mem = (workerId: string, sessionBase: string, rolling: Rolling | undefined, tsFiles: string[] = []) =>
  ({ workerId, rec: { sessionBase, tsFiles, rolling } }) as never;

function run(members: never[], countParts?: (bv: string) => Promise<number | null>) {
  const notify = vi.fn();
  const jlog = vi.fn();
  const r = tryRollingShortCircuit({ streamKey: KEY, cfg: { steps: { burnDanmu: false, burnLivechat: false } }, members, ledger, transports: new Map(), notify, jlog, countParts });
  return { r, notify, jlog };
}
const flush = (): Promise<void> => new Promise((res) => setImmediate(res));

describe("#57 R1:无稿件号的建稿意图 / 不确定 → 转人工", () => {
  it("uploading.kind=create 且无 bv → needs_manual,通知,不走常规管线", () => {
    const { r, notify, jlog } = run([mem("n1", "s1", { uploading: { index: 0, kind: "create" } }, ["/r/s1_000.ts"])]);
    expect(r).toEqual({ state: "needs_manual" });
    expect(ledger.get(KEY)?.state).toBe("needs_manual");
    expect(ledger.get(KEY)?.error).toContain("无稿件号");
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: "error", message: expect.stringContaining("无稿件号") }));
    expect(jlog).toHaveBeenCalledWith(expect.stringContaining("建稿中 段0"));
  });

  it("无 bv 但有不确定段 → needs_manual", () => {
    const { r } = run([mem("n1", "s1", { confirmed: [], ambiguous: [0] }, ["/r/s1_000.ts"])]);
    expect(r).toEqual({ state: "needs_manual" });
  });

  it("同场另一成员已有 bv,本成员建稿中被杀 → 仍转人工(不 done)", () => {
    const { r } = run([
      mem("n1", "s1", { bv: "BV1ok", confirmed: [0, 1] }),
      mem("n1", "s2", { uploading: { index: 0, kind: "create" } }, ["/r/s2_000.ts"]),
    ]);
    expect(r).toEqual({ state: "needs_manual" });
    expect(ledger.get(KEY)?.bv ?? null).toBeNull();
  });

  it("无 bv 的 append 意图(异常形状)/ 无进度文件 / 空进度 → 不拦,走常规路径", () => {
    expect(run([mem("n1", "s1", undefined, ["/r/a.ts"])]).r).toBeNull();
    expect(run([mem("n1", "s1", { confirmed: [], ambiguous: [] }, ["/r/a.ts"])]).r).toBeNull();
    expect(run([mem("n1", "s1", { uploading: { index: 1, kind: "append" } }, ["/r/a.ts"])]).r).toBeNull();
  });

  it("旧节点清单缺 uploading 字段、有 bv 且已全确认 → 照旧 done", () => {
    const { r } = run([mem("n1", "s1", { bv: "BV1ok", confirmed: [0], ambiguous: [] })]);
    expect(r).toEqual({ state: "done", bv: "BV1ok" });
  });
});

describe("#57 R1:剩余未确认视频含同节点无稿件号成员", () => {
  it("同节点另一会话无 bv 且仍有 ts → needs_manual(不静默 done 丢片)", () => {
    const { r, jlog } = run([
      mem("n1", "s1", { bv: "BV1ok", confirmed: [0] }),
      mem("n1", "s2", undefined, ["/r/s2_000.ts", "/r/s2_001.ts"]),
    ]);
    expect(r).toEqual({ state: "needs_manual", bv: "BV1ok" });
    expect(jlog).toHaveBeenCalledWith(expect.stringContaining("2 个未确认分段"));
  });

  it("其它节点的无 bv 冗余录像不计入 → 仍 done(原口径)", () => {
    const { r } = run([
      mem("n1", "s1", { bv: "BV1ok", confirmed: [0] }),
      mem("n2", "s1", undefined, ["/r/s1_000.ts"]),
    ]);
    expect(r).toEqual({ state: "done", bv: "BV1ok" });
  });
});

describe("#57 R1:多稿件文案", () => {
  it("同节点多会话各自建稿 → 文案写明同节点多会话并列出各稿件号", () => {
    const { r, notify, jlog } = run([
      mem("n1", "s1", { bv: "BV1aaa", confirmed: [0] }),
      mem("n1", "s2", { bv: "BV1bbb", confirmed: [0] }),
    ]);
    expect(r).toEqual({ state: "needs_manual" });
    const err = ledger.get(KEY)?.error ?? "";
    expect(err).toContain("同节点多会话各自建稿");
    expect(err).toContain("BV1aaa");
    expect(err).toContain("BV1bbb");
    expect(err).not.toContain("多节点各建稿");
    expect(jlog).toHaveBeenCalledWith(expect.stringContaining("同节点多会话"));
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ message: expect.stringContaining("同节点多会话") }));
  });

  it("不同节点各建稿 → 仍报多节点各建稿", () => {
    const { r } = run([
      mem("n1", "s1", { bv: "BV1aaa", confirmed: [0] }),
      mem("n2", "s1", { bv: "BV1bbb", confirmed: [0] }),
    ]);
    expect(r).toEqual({ state: "needs_manual" });
    expect(ledger.get(KEY)?.error).toContain("多节点各建稿");
  });
});

describe("#57 R1:rolling 收口后的回读核验(观察期只记日志)", () => {
  it("分 P 数一致 → 记日志,done 不变", async () => {
    const countParts = vi.fn().mockResolvedValue(2);
    const { r, jlog } = run([mem("n1", "s1", { bv: "BV1ok", confirmed: [0, 1] })], countParts);
    expect(r).toEqual({ state: "done", bv: "BV1ok" });
    await flush();
    expect(countParts).toHaveBeenCalledWith("BV1ok");
    expect(jlog).toHaveBeenCalledWith(expect.stringContaining("回读核验"));
    expect(jlog).toHaveBeenCalledWith(expect.stringContaining("一致"));
  });

  it.each([
    ["分 P 数不符", async () => 1],
    ["读取失败", async () => null],
    ["抛错", async () => { throw new Error("boom"); }],
  ] as const)("%s → 只记日志,不转人工、不发 error 通知", async (_n, cp) => {
    const { r, notify, jlog } = run([mem("n1", "s1", { bv: "BV1ok", confirmed: [0, 1] })], cp);
    expect(r).toEqual({ state: "done", bv: "BV1ok" });
    await flush();
    expect(ledger.get(KEY)?.state).toBe("done");
    expect(jlog).toHaveBeenCalledWith(expect.stringContaining("回读核验"));
    expect(notify.mock.calls.map(([e]) => e.kind)).toEqual(["uploadDone"]);
  });
});
