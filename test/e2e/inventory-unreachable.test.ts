import { afterEach, describe, expect, it } from "vitest";
import type { Transport } from "@drec/orchestrator";
import { FULL_CLEANUP, Scenario } from "./harness/scenario.js";
import { pastStartMs } from "./harness/fake-recordings.js";
import { expectHealthyDone } from "./harness/invariants.js";

let s: Scenario;
afterEach(() => { s?.dispose(); mode = "ok"; });

/** 清单失联开关:reject / hang(超时)/ ok。其余能力原样透传给真 LocalTransport。 */
let mode: "ok" | "reject" | "hang" = "ok";
const flaky = (base: Transport): Transport => new Proxy(base, {
  get(target, prop, recv) {
    if (prop === "listInventory") {
      return () => {
        if (mode === "reject") return Promise.reject(new Error("ssh: connection refused"));
        if (mode === "hang") return new Promise(() => {});
        return target.listInventory();
      };
    }
    const v = Reflect.get(target, prop, recv);
    return typeof v === "function" ? v.bind(target) : v;
  },
});

describe("e2e: 节点清单失联(#27)", () => {
  for (const m of ["reject", "hang"] as const) {
    it(`${m}:失联轮不选优/不上传/不删源;恢复后下一轮正常收口`, async () => {
      mode = m;
      s = await Scenario.create({
        cfg: { cleanup: FULL_CLEANUP },
        wrapTransport: (base) => flaky(base),
        reconcilerOpts: { inventoryTimeoutMs: 30 },
      });
      s.record({ sessions: [{ startMs: pastStartMs(0, 10, 0), segments: 2, segSec: 600 }] });
      const before = s.recordingFiles().sort();

      await s.reconcile();
      expect(s.ledger.listKeys(), "失联轮不建 job").toHaveLength(0);
      expect(s.fake.calls, "失联轮不上传").toHaveLength(0);
      expect(s.recordingFiles().sort(), "失联轮不删任何源").toEqual(before);

      mode = "ok";
      await s.reconcile();
      expectHealthyDone(s, s.onlyKey(), { parts: 3 });
    });
  }
});

// #69 item 3: with a single node, "unreachable" and "empty" both yield no job, so the scenario above cannot
// tell them apart. Two nodes record the same broadcast; only n2 flaps. Treating n2 as empty would let the
// pipeline pick local's shorter copy, upload it and clean local's source.
describe("e2e: two nodes, one unreachable (#69)", () => {
  const twoNodes = async (): Promise<Scenario> => {
    const sc = await Scenario.create({
      extraNodes: ["n2"],
      cfg: { cleanup: FULL_CLEANUP },
      wrapTransport: (base, _s, id) => (id === "n2" ? flaky(base) : base),
      reconcilerOpts: { inventoryTimeoutMs: 30 },
    });
    sc.record({ node: "local", sessions: [{ startMs: pastStartMs(0, 10, 0), segments: 2, segSec: 600 }] });
    sc.record({ node: "n2", sessions: [{ startMs: pastStartMs(0, 10, 0), segments: 3, segSec: 600 }] });
    return sc;
  };

  for (const m of ["reject", "hang"] as const) {
    it(`${m}: the reachable node alone is not selected; after recovery the longer n2 copy wins`, async () => {
      mode = m;
      s = await twoNodes();
      const localBefore = s.recordingFiles(undefined, "local");
      const n2Before = s.recordingFiles(undefined, "n2");

      await s.reconcile();
      expect(s.ledger.listKeys(), "no job while a selected node is unreachable").toHaveLength(0);
      expect(s.fake.calls, "no upload while a selected node is unreachable").toHaveLength(0);
      expect(s.recordingFiles(undefined, "local"), "reachable node's source untouched").toEqual(localBefore);
      expect(s.recordingFiles(undefined, "n2")).toEqual(n2Before);

      mode = "ok";
      await s.reconcile();
      const key = s.onlyKey();
      expectHealthyDone(s, key, { parts: 3 });
      // n2 has the longer copy, so it wins once both inventories are in.
      expect(s.ledger.get(key)?.winnerWorker).toBe("n2");
      expect(s.ledger.getCandidates(key).map((c) => c.workerId).sort()).toEqual(["local", "n2"]);
    });
  }

  it("runNow not forced: unreachable node and existing BV are listed in ONE 409; force bypasses both", async () => {
    mode = "ok";
    s = await Scenario.create({
      extraNodes: ["n2"],
      cfg: { cleanup: { sourceAfterDone: false, stageAfterDone: false, stageSourceAfterMerge: false } },
      wrapTransport: (base, _s, id) => (id === "n2" ? flaky(base) : base),
      reconcilerOpts: { inventoryTimeoutMs: 30 },
    });
    s.record({ node: "local", sessions: [{ startMs: pastStartMs(0, 10, 0), segments: 2, segSec: 600 }] });
    s.record({ node: "n2", sessions: [{ startMs: pastStartMs(0, 10, 0), segments: 3, segSec: 600 }] });
    await s.reconcile();
    const key = s.onlyKey();
    const bv = s.ledger.get(key)?.bv;
    expect(bv, "first run created a draft").toBeTruthy();

    mode = "reject";
    const r = await s.reconciler.runNow({ streamKey: key });
    expect(r.code).toBe(409);
    expect(r.forceable).toBe(true);
    expect(r.error, "lists the unreachable node").toMatch(/n2.*清单失联/);
    expect(r.error, "lists the existing BV in the same 409").toContain(bv!);

    const forced = await s.reconciler.runNow({ streamKey: key, force: true, wait: true });
    expect(forced.ok).toBe(true);
  });

  it("control: a reachable but empty n2 does not block local", async () => {
    mode = "ok";
    s = await Scenario.create({ extraNodes: ["n2"], cfg: { cleanup: FULL_CLEANUP } });
    s.record({ node: "local", sessions: [{ startMs: pastStartMs(0, 10, 0), segments: 2, segSec: 600 }] });
    await s.reconcile();
    expectHealthyDone(s, s.onlyKey(), { parts: 3 });
    expect(s.ledger.get(s.onlyKey())?.winnerWorker).toBe("local");
  });
});
