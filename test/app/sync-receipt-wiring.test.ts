/**
 * Wiring guard for T16: the master sync loop and the node CLI are in the
 * platform-vendor-dependent entry point, which vitest cannot import. These
 * tests pin the source-level call sites so a refactor that drops the receipt
 * (or the version in the SSH payload) fails loudly.
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";

const root = join(import.meta.dirname, "..", "..");
const cli = readFileSync(join(root, "packages/cli/src/cli.ts"), "utf-8");

describe("T16 sync receipt wiring", () => {
  it("master sync computes and sends expectedVersion", () => {
    expect(cli).toContain("recordExpectedVersion(hubReceiptSettings, w.id, desired)");
    expect(cli).toMatch(/applyTasks\(\{ desired, force, \.\.\.\(expectedVersion/);
  });

  it("master records the apply result as syncError", () => {
    expect(cli).toContain("recordSyncError(hubReceiptSettings, w.id, r.rejected");
    expect(cli).toContain("recordSyncError(hubReceiptSettings, w.id, msg)");
  });

  it("worker status probe attaches master-side receipt fields", () => {
    expect(cli).toContain("withMasterReceipt(base, hubReceiptSettings)");
  });

  it("_apply-tasks forwards the payload through applyTasksPayload", () => {
    expect(cli).toContain("applyTasksPayload(store, b64, undefined");
  });

  it("_node-status reports appVersionAtApply from the snapshot", () => {
    expect(cli).toContain("appVersionAtApply = st?.appVersion ?? null");
    expect(cli).toContain("appVersionAtApply = st.appVersion ?? null");
  });
});
