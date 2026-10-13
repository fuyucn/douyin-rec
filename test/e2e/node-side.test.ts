import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { UploadGate } from "@drec/core";
import type { LocalTransport, Transport } from "@drec/orchestrator";
import { readNodeResult, runNodeSidePipeline } from "../../packages/app/src/node-pipeline.js";
import { FULL_CLEANUP as full, Scenario } from "./harness/scenario.js";
import { pastStartMs } from "./harness/fake-recordings.js";
import type { FakeBiliup } from "./harness/fake-biliup.js";
import { expectHealthyDone, expectLegalTrail, expectSourceSidecarsKept } from "./harness/invariants.js";

// 节点侧执行体(app/node-pipeline)直接 import biliup 模块、没有注入口 → 在模块边界顶替为假 biliup。
const h = vi.hoisted(() => ({ fake: null as unknown as FakeBiliup }));
vi.mock("../../packages/app/src/upload/biliup.js", () => ({
  uploadPlain: (o: { plain: Parameters<FakeBiliup["uploadPlain"]>[0] }) => h.fake.uploadPlain(o.plain),
  appendGroup: (o: Parameters<FakeBiliup["appendGroup"]>[0]) => h.fake.appendGroup(o),
  countVideoParts: (bv: string) => h.fake.countVideoParts(bv),
}));
// ffmpeg 外部进程 → 占位文件。
vi.mock("@drec/post-process", async (orig) => {
  const actual = await orig<typeof import("@drec/post-process")>();
  return {
    ...actual,
    ffprobeDuration: async () => 60,
    remuxSegment: async (_s: string, out: string) => { writeFileSync(out, "REMUXED"); },
    mergeSession: async (_i: string[], out: string) => { writeFileSync(out, "MERGED"); },
  };
});

let s: Scenario;
let ckDir = "";
beforeEach(() => {
  ckDir = mkdtempSync(join(tmpdir(), "e2e-ck-"));
  const cookies = join(ckDir, "cookies.json");
  writeFileSync(cookies, JSON.stringify({ cookie_info: { cookies: [{ name: "DedeUserID", value: "42" }] } }));
  process.env.BILIUP_COOKIE = cookies;
});
afterEach(() => { s?.dispose(); delete process.env.BILIUP_COOKIE; rmSync(ckDir, { recursive: true, force: true }); });

const gate = (): UploadGate => new UploadGate({ rateLimit: 1000, sleep: async () => {}, warn: () => {} });

/** 给 LocalTransport 加上节点侧能力:同机直接跑真实 `runNodeSidePipeline`(= `_node-pipeline` 子命令的实体)。 */
function withNodeSide(opts: { dropAfterRun?: boolean } = {}) {
  return (base: LocalTransport, sc: Scenario): Transport => {
    const t = base as unknown as Transport & Record<string, unknown>;
    t.nodeCapabilities = async () => ({ biliup: true, cookies: true, diskFreeGB: 500, cjkFonts: false });
    t.nodePipeline = async (spec: Parameters<NonNullable<Transport["nodePipeline"]>>[0]) => {
      const r = await runNodeSidePipeline(spec, () => {}, gate());
      // 模拟「节点其实跑完了,但 ssh 回传断开」。
      if (opts.dropAfterRun) throw new Error("ssh: connection reset (rc=255)");
      return r;
    };
    t.nodeResult = async (streamKey: string) => readNodeResult(sc.stageSubOf(streamKey));
    t.abortNodePipeline = async () => ({ aborted: true });
    return t;
  };
}
async function mk(extra: Parameters<typeof Scenario.create>[0] = {}, node = {}): Promise<Scenario> {
  s = await Scenario.create({ cfg: { steps: { nodeSideUpload: true, burnDanmu: false, burnLivechat: false }, cleanup: full }, wrapTransport: withNodeSide(node), ...extra });
  h.fake = s.fake;
  return s;
}
const rec = (sc: Scenario): void => {
  sc.record({ sessions: [{ startMs: pastStartMs(0, 10, 0), segments: 3, segSec: 600 }] });
};
const PARTS = [0, 1, 2].map((i) => `主播甲_2026-06-27_00${i}.mp4`);
const tsLeft = (sc: Scenario): number => sc.recordingFiles().filter((f) => f.endsWith(".ts")).length;

describe("e2e: 节点侧上传(experimental,真实 runNodeSidePipeline)", () => {
  it("正常:节点本地 remux + 上传,master 不 pull;分P数 = 段数,清理后无残留、只留 xml/session", async () => {
    await mk(); rec(s);
    await s.reconcile();
    const key = s.onlyKey();
    expect(s.stateTrail(key)).toEqual(["pending", "syncing", "done"]); // 无 merging:没走 master 管线
    expect(s.ledger.getSteps(key).map((x) => x.step)).not.toContain("pull");
    expectHealthyDone(s, key, { parts: PARTS });
    expect(tsLeft(s), "节点源视频已删").toBe(0);
  });

  it("节点其实跑完、ssh 回传却断了 → 回读落盘结果确认成功:收口 done,不重传", async () => {
    await mk({}, { dropAfterRun: true }); rec(s);
    await s.reconcile();
    const key = s.onlyKey();
    expectHealthyDone(s, key, { parts: PARTS });
    expect(s.fake.calls.filter((c) => c.op === "upload")).toHaveLength(1);
  });

  // 已知缺陷 #59:节点侧(`runNodeSidePipeline`)调 appendGroup 不传 countParts,没有「分P数核对」。
  // 生产实测:append 已提交但响应丢失 → 换线重复追加分P、场次收口 done、节点源被删。
  // 本用例写的是「应有」行为(转人工、保留源、不重复追加);预期失败(it.fails),
  // 待 #59 修复后会开始通过 → 去掉 `.fails`。https://github.com/fuyucn/douyin-rec/issues/59
  it.fails("节点上传中途结果不确定(append 已提交但分P数不可查)→ 转人工:保留源、不重传、不重复追加分P(已知缺陷 #59)", async () => {
    await mk(); rec(s);
    s.fake.inject({ op: "append", mode: "ambiguous" });
    s.fake.countAvailable = false;
    await s.reconcile();
    const key = s.onlyKey();
    expect(s.jobState(key)).toBe("needs_manual");
    expect(s.ledger.get(key)?.error).toContain("人工");
    expect(s.fake.draftCount).toBe(1);
    // P2 已提交;正确修复(#59)后应转人工且不得发送 P3,故稿件应为 2 个分P(不是 3)。
    expect(s.fake.onlyArchive.parts, "不得重复追加分P").toHaveLength(2);
    expect(tsLeft(s), "不确定时不得删源").toBe(3);
    expectSourceSidecarsKept(s);
    // 再来一轮(含重启):needs_manual 不被推进,不产生新上传。
    const calls = s.fake.calls.length;
    await s.restart();
    await s.reconcile();
    expect(s.fake.calls).toHaveLength(calls);
    expectLegalTrail(s, key);
    expect(s.ledgerRejections()).toEqual([]);
  });
});
