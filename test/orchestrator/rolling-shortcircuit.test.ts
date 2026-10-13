import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SyncLedger } from "../../packages/orchestrator/src/ledger.js";
import { tryRollingShortCircuit } from "../../packages/orchestrator/src/pipeline.js";

const KEY = "douyin:123:2026-10-13";
let dir: string;
let ledger: SyncLedger;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "rolling-sc-"));
  ledger = new SyncLedger(join(dir, "sync.db"));
  ledger.upsertPending(KEY);
  for (const s of ["syncing", "merging", "uploading"] as const) ledger.setState(KEY, s);
});
afterEach(() => {
  ledger.close();
  rmSync(dir, { recursive: true, force: true });
});

const member = (rolling: { bv: string; confirmed?: string[]; ambiguous?: string[] }, tsFiles: string[] = []) =>
  ({ workerId: "w1", rec: { tsFiles, rolling: { confirmed: [], ambiguous: [], ...rolling } } }) as never;

function run(steps: { burnDanmu?: boolean; burnLivechat?: boolean } | undefined, members: never[]) {
  const notify = vi.fn();
  const jlog = vi.fn();
  const r = tryRollingShortCircuit({ streamKey: KEY, cfg: { steps }, members, ledger, transports: new Map(), notify, jlog });
  return { r, notify, jlog };
}

describe("tryRollingShortCircuit × 烧录配置与起录时不一致(issue #52)", () => {
  it("烧录开启 + rolling BV 已确认 → 仍 done,写日志并通知「新配置下一场生效」", () => {
    const { r, notify, jlog } = run({ burnDanmu: true, burnLivechat: false }, [member({ bv: "BV1", confirmed: ["a"] })]);
    expect(r).toEqual({ state: "done", bv: "BV1" });
    expect(ledger.get(KEY)?.state).toBe("done");
    expect(jlog).toHaveBeenCalledWith(expect.stringContaining("新配置(烧录)下一场生效"));
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: "error", message: expect.stringContaining("下一场生效") }));
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: "uploadDone", bv: "BV1" }));
  });

  it("烧录全关 → done,无「下一场生效」通知", () => {
    const { r, notify } = run({ burnDanmu: false, burnLivechat: false }, [member({ bv: "BV1", confirmed: ["a"] })]);
    expect(r).toEqual({ state: "done", bv: "BV1" });
    expect(notify).toHaveBeenCalledTimes(1);
    expect(notify).toHaveBeenCalledWith(expect.objectContaining({ kind: "uploadDone" }));
  });

  it("烧录开启但存在 ambiguous 段 → 仍转人工(回归)", () => {
    const { r } = run(undefined, [member({ bv: "BV1", ambiguous: ["p2"] })]);
    expect(r).toEqual({ state: "needs_manual", bv: "BV1" });
    expect(ledger.get(KEY)?.state).toBe("needs_manual");
  });

  it("烧录开启但残留未确认分段 → 仍转人工(回归)", () => {
    const { r } = run(undefined, [member({ bv: "BV1" }, ["/x/a.ts"])]);
    expect(r).toEqual({ state: "needs_manual", bv: "BV1" });
  });
});
