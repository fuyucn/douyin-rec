import { afterEach, describe, expect, it } from "vitest";
import type { Transport } from "@drec/orchestrator";
import { FULL_CLEANUP, Scenario } from "./harness/scenario.js";
import { pastStartMs } from "./harness/fake-recordings.js";
import { expectHealthyDone } from "./harness/invariants.js";

let s: Scenario;
afterEach(() => s?.dispose());

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
