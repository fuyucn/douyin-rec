/** Master spec/fleet wiring; node entry behavior lives in stream-upload-record.test.ts. */
import { describe, it, expect } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
describe("master spec builder", () => {
  it("decides per node through planZeroDiskSpec and ships the delivery with the spec", () => {
    // Issue #481: the builder moved out of the CLI entry into @drec/app so it can be tested directly.
    const builder = readFileSync(join(ROOT, "packages/app/src/hub-desired.ts"), "utf-8");
    expect(builder).toContain("planZeroDiskSpec({");
    expect(builder).toContain("...(zd.delivery ? { zeroDiskDelivery: zd.delivery } : {})");
    expect(builder).toContain("allowsPush: ctx.allowsPush(workerId)");
    expect(builder).toContain("ruleError: zeroDiskRuleError(src.streamUpload");
    expect(builder).toContain("masterCookiesPath: ctx.cookiesPath");
  });
  it("probes capabilities before building specs and polls receipts after applying them", () => {
    // The round is split across two modules since plan 050.3: the starter owns the gate/poll, the
    // task-sync loop owns the apply. Pin both the seam and the per-round order inside the loop.
    const hubStarter = readFileSync(join(ROOT, "packages/hub-compose/src/hub-starter.ts"), "utf-8");
    const taskSync = readFileSync(join(ROOT, "packages/hub-compose/src/task-sync.ts"), "utf-8");
    const zeroDisk = readFileSync(join(ROOT, "packages/hub-compose/src/zero-disk-sync.ts"), "utf-8");
    expect(zeroDisk).toContain("fleet.refreshSupport(");
    expect(zeroDisk).toContain("fleet.poll(");
    expect(hubStarter).toContain("beginRound: zeroDisk.beginRound");
    expect(hubStarter).toContain("finishRound: zeroDisk.finishRound");
    expect(taskSync).toContain("await t.applyTasks({ desired");
    const gate = taskSync.indexOf("await deps.beginRound()");
    const loop = taskSync.indexOf("for (const w of deps.workers())");
    const poll = taskSync.indexOf("await deps.finishRound(");
    expect(gate).toBeGreaterThan(-1);
    expect(loop).toBeGreaterThan(gate);
    expect(poll).toBeGreaterThan(loop);
  });
});
