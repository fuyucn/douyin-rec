import { describe, expect, it } from "vitest";
import {
  canSegTransition,
  decideIntentSettlement,
  deriveMirror,
  leaseTakeable,
  needsTakeover,
  parseRollingManifest,
  serializeRollingManifest,
  setSegStatus,
  type RollingManifest,
  type SegRecord,
} from "./rolling-manifest.js";

const seg = (index: number, status: SegRecord["status"], path = `/rec/s_${index}.ts`): SegRecord => ({ index, path, status });
const mk = (segs: SegRecord[], over: Partial<RollingManifest> = {}): RollingManifest => ({
  schemaVersion: 3, streamKey: "douyin:1:b", sessionBase: "b", segs, updatedAt: 1, ...over,
});

describe("parseRollingManifest — 不存在≠损坏,损坏必须被识别", () => {
  it.each([
    ["截断 JSON", '{"schemaVersion":3,"segs":[{"index":0,"pa'],
    ["空文件", ""],
    ["根是数组", "[]"],
    ["v3 缺 segs", JSON.stringify({ schemaVersion: 3, sessionBase: "b" })],
    ["v3 非法状态", JSON.stringify({ schemaVersion: 3, sessionBase: "b", segs: [{ index: 0, path: "p", status: "bogus" }] })],
    ["v3 intent 非法", JSON.stringify({ schemaVersion: 3, sessionBase: "b", segs: [], intent: { kind: "x" } })],
    ["v2 confirmed 类型错", JSON.stringify({ sessionBase: "b", confirmed: "0,1" })],
    ["v2 uploading 非法", JSON.stringify({ sessionBase: "b", confirmed: [], uploading: { index: "a" } })],
  ])("%s → corrupt", (_n, text) => {
    expect(parseRollingManifest(text, "b").kind).toBe("corrupt");
  });

  it("v2 清单按旧字段重建 segs(确认/不确定/上传中/待传)并带 legacy 标记", () => {
    const p = parseRollingManifest(JSON.stringify({
      schemaVersion: 2, streamKey: "k", sessionBase: "b", bv: "BV1x",
      segments: [0, 1, 2, 3].map((i) => ({ index: i, path: `/p${i}` })),
      confirmed: [0], ambiguous: [2], uploading: { index: 1, kind: "append" }, startMs: 5, updatedAt: 9,
    }), "b");
    expect(p.kind).toBe("ok");
    if (p.kind !== "ok") return;
    expect(p.legacy).toBe(true);
    expect(p.manifest.segs.map((s) => [s.index, s.status])).toEqual([[0, "acked"], [1, "uploading"], [2, "ambiguous"], [3, "sealed"]]);
    expect(p.manifest.intent).toMatchObject({ kind: "append", index: 1 });
    expect(p.manifest.bv).toBe("BV1x");
    expect(p.manifest.startMs).toBe(5);
  });

  it("v1/最小旧清单(无 segments/ambiguous 字段)可读,不判损坏", () => {
    const p = parseRollingManifest(JSON.stringify({ streamKey: "k", sessionBase: "b", confirmed: [] }), "b");
    expect(p.kind).toBe("ok");
  });

  it("confirmed 里有、segments 里没有的段号保留(路径未知)", () => {
    const p = parseRollingManifest(JSON.stringify({ sessionBase: "b", segments: [], confirmed: [0] }), "b");
    expect(p.kind === "ok" && p.manifest.segs).toEqual([{ index: 0, path: "", status: "acked" }]);
  });

  it("v3 往返:serialize → parse 无损", () => {
    const m = mk([seg(0, "acked"), seg(1, "uploading")], {
      bv: "BV1x", intent: { attemptId: "a", kind: "append", index: 1, startedAt: 2 },
      lease: { pid: 7, until: 100, holder: "h" }, room: { platform: "douyin", roomSlug: "1" }, policy: { private: true },
    });
    const p = parseRollingManifest(serializeRollingManifest(m, 42), "b");
    expect(p.kind === "ok" && p.legacy).toBe(false);
    expect(p.kind === "ok" && p.manifest).toMatchObject({ bv: "BV1x", intent: { attemptId: "a" }, lease: { pid: 7, holder: "h" }, updatedAt: 42, policy: { private: true } });
  });
});

describe("旧字段镜像(旧主控/旧节点包照常读)", () => {
  it("segments/confirmed/ambiguous/uploading 由 segs+intent 派生;needs_manual 并入 ambiguous;skipped 不入", () => {
    const m = mk([seg(0, "sourceDeleted"), seg(1, "acked"), seg(2, "needs_manual"), seg(3, "ambiguous"), seg(4, "skipped"), seg(5, "uploading")], {
      intent: { attemptId: "a", kind: "create", index: 5, startedAt: 1 },
    });
    expect(deriveMirror(m)).toEqual({
      segments: [0, 1, 2, 3, 4, 5].map((i) => ({ index: i, path: `/rec/s_${i}.ts` })),
      confirmed: [0, 1], ambiguous: [2, 3], uploading: { index: 5, kind: "create" },
    });
  });
  it("序列化 JSON 里是 v3 + 镜像同步;空 ambiguous/intent 不出现(与 v2 形状一致)", () => {
    const j = JSON.parse(serializeRollingManifest(mk([seg(0, "acked")]), 3));
    expect(j.schemaVersion).toBe(3);
    expect(j.confirmed).toEqual([0]);
    expect("ambiguous" in j).toBe(false);
    expect("uploading" in j).toBe(false);
    expect("intent" in j).toBe(false);
  });
});

describe("段状态转换白名单", () => {
  it("合法路径", () => {
    expect(canSegTransition("open", "sealed")).toBe(true);
    expect(canSegTransition("sealed", "uploading")).toBe(true);
    expect(canSegTransition("uploading", "acked")).toBe(true);
    expect(canSegTransition("acked", "sourceDeleted")).toBe(true);
    expect(canSegTransition("uploading", "sealed")).toBe(true); // 回读证实未提交
    expect(canSegTransition("ambiguous", "acked")).toBe(true);
  });
  it("非法跳转被拒;终态不可再转", () => {
    expect(canSegTransition("open", "acked")).toBe(false);
    expect(canSegTransition("sealed", "acked")).toBe(false);
    expect(canSegTransition("sourceDeleted", "sealed")).toBe(false);
    expect(canSegTransition("needs_manual", "sealed")).toBe(false);
    expect(canSegTransition("skipped", "uploading")).toBe(false);
    expect(() => setSegStatus(mk([seg(0, "open")]), 0, "acked")).toThrow(/非法段状态转换/);
    expect(() => setSegStatus(mk([]), 3, "sealed")).toThrow(/不存在/);
  });
});

describe("leaseTakeable — 仅过期或 pid 不存在才可接管", () => {
  const alive = () => true;
  const dead = () => false;
  const lease = (until: number, pid = 9) => ({ lease: { pid, until, holder: "h" }, updatedAt: 0 });
  it("租约有效且 pid 存活 → 不可接管", () => expect(leaseTakeable(lease(200), 100, alive)).toBe(false));
  it("租约已过期 → 可接管(即便 pid 存活/被复用)", () => expect(leaseTakeable(lease(100), 100, alive)).toBe(true));
  it("租约未过期但 pid 不存在 → 可接管", () => expect(leaseTakeable(lease(200), 100, dead)).toBe(true));
  it("无租约(老清单):静置不足 → 不接管(老进程可能仍在写);静置够久 → 可接管", () => {
    expect(leaseTakeable({ updatedAt: 1_000 }, 1_000 + 60_000, dead, { legacyIdleMs: 600_000 })).toBe(false);
    expect(leaseTakeable({ updatedAt: 1_000 }, 1_000 + 600_000, dead, { legacyIdleMs: 600_000 })).toBe(true);
    // 文件 mtime 更新也算「刚写过」
    expect(leaseTakeable({ updatedAt: 0 }, 700_000, dead, { legacyIdleMs: 600_000, fileMtimeMs: 400_000 })).toBe(false);
  });
});

describe("needsTakeover", () => {
  const exists = (set: string[]) => (p: string) => set.includes(p);
  it("全部终态且无残留源 → 无需接管", () => {
    expect(needsTakeover(mk([seg(0, "sourceDeleted"), seg(1, "needs_manual"), seg(2, "skipped")]), exists([]))).toBe(false);
  });
  it("有意图 / sealed / uploading / open → 需要", () => {
    expect(needsTakeover(mk([seg(0, "acked")], { intent: { attemptId: "a", kind: "append", index: 1, startedAt: 0 } }), exists([]))).toBe(true);
    for (const st of ["sealed", "uploading", "open"] as const) expect(needsTakeover(mk([seg(0, st)]), exists([]))).toBe(true);
  });
  it("acked 但源还在 → 需要(补删);源已不在 → 不需要", () => {
    expect(needsTakeover(mk([seg(0, "acked", "/p")]), exists(["/p"]))).toBe(true);
    expect(needsTakeover(mk([seg(0, "acked", "/p")]), exists([]))).toBe(false);
  });
});

describe("decideIntentSettlement — 启动接管判定表", () => {
  const base = (kind: "create" | "append", bv?: string, confirmed = 1): Pick<RollingManifest, "intent" | "bv" | "segs"> => ({
    intent: { attemptId: "a", kind, index: confirmed, startedAt: 0 }, bv,
    segs: [...Array.from({ length: confirmed }, (_, i) => seg(i, "acked")), seg(confirmed, "uploading")],
  });
  it("无意图 → none", () => expect(decideIntentSettlement({ segs: [] }, [])).toEqual({ action: "none" }));
  it("create 且无稿件号 → 转人工(绝不重建稿),无需回读", () => {
    expect(decideIntentSettlement(base("create"), [])).toMatchObject({ action: "manual" });
  });
  it("append 无稿件号 → 转人工", () => expect(decideIntentSettlement(base("append"), [])).toMatchObject({ action: "manual" }));
  it("create 意图却已有稿件号(状态不一致)→ 转人工,不当可续传", () => {
    expect(decideIntentSettlement(base("create", "BV1x"), [{ parts: 1 }, { parts: 1 }])).toMatchObject({ action: "manual" });
  });
  it("append:首读 = 已确认+1 → 补确认(一次即可)", () => {
    expect(decideIntentSettlement(base("append", "BV1x"), [{ parts: 2 }])).toEqual({ action: "ack" });
  });
  it("append:首读 = 已确认数 → 需要第二次回读;二读仍一致 → 续传", () => {
    expect(decideIntentSettlement(base("append", "BV1x"), [])).toEqual({ action: "needMore" });
    expect(decideIntentSettlement(base("append", "BV1x"), [{ parts: 1 }])).toEqual({ action: "needMore" });
    expect(decideIntentSettlement(base("append", "BV1x"), [{ parts: 1 }, { parts: 1 }])).toEqual({ action: "resume" });
  });
  it("append:B站延迟 — 首读 = 已确认数、二读 = +1 → 补确认(不续传)", () => {
    expect(decideIntentSettlement(base("append", "BV1x"), [{ parts: 1 }, { parts: 2 }])).toEqual({ action: "ack" });
  });
  it.each([
    ["查不到", [{ parts: null }]],
    ["数量异常", [{ parts: 9 }]],
    ["稿件消失", [{ gone: true } as const]],
    ["二读异常", [{ parts: 1 }, { parts: 5 }]],
    ["二读失败", [{ parts: 1 }, { parts: null }]],
    ["二读稿件消失", [{ parts: 1 }, { gone: true } as const]],
  ])("其它情形(%s)→ 转人工", (_n, reads) => {
    expect(decideIntentSettlement(base("append", "BV1x"), reads)).toMatchObject({ action: "manual" });
  });
});
