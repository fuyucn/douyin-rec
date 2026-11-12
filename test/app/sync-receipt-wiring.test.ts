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
// Node-side command bodies live in the shared registry (plans/042 Task 1).
const nodeCommands = readFileSync(join(root, "packages/cli/src/node-commands.ts"), "utf-8");

describe("T16 sync receipt wiring", () => {
  it("master sync computes and sends expectedVersion", () => {
    // Receipt settings now come from the hub-compose accessor, not a cli-local variable.
    expect(cli).toContain("const receiptSettings = getReceiptSettings();");
    expect(cli).toContain("recordExpectedVersion(receiptSettings, w.id, desired)");
    expect(cli).toMatch(/applyTasks\(\{ desired, force, \.\.\.\(expectedVersion/);
  });

  it("master records the apply result as syncError", () => {
    expect(cli).toContain("recordSyncError(receiptSettings, w.id, r.rejected");
    expect(cli).toContain("recordSyncError(receiptSettings, w.id, msg)");
  });

  it("worker status probe attaches master-side receipt fields", () => {
    expect(cli).toContain("withMasterReceipt(base, receiptSettings)");
  });

  it("_apply-tasks forwards the payload through applyTasksPayload", () => {
    expect(nodeCommands).toContain("applyTasksPayload(store, b64, undefined");
  });

  it("_node-status reports appVersionAtApply from the snapshot", () => {
    expect(cli).toContain("appVersionAtApply = st?.appVersion ?? null");
    expect(nodeCommands).toContain("appVersionAtApply = st.appVersion ?? null");
  });

  // Issue #563: the push decision is the silent-failure guard (record the fingerprint only when the node
  // really applied everything). Pin the call sites so a refactor cannot quietly drop it.
  it("master records the credential fingerprint only behind verdict/share gate", () => {
    expect(cli).toContain("shouldPushCookies(readCookiesApplied(opts.store, w.id)");
    expect(cli).toContain("cookiesPushVerdict(cookiesPayload, r)");
    // Record must live in the **success branch**: the `!verdict.ok` branch may only warn/retry.
    const verdictAt = cli.indexOf("cookiesPushVerdict(cookiesPayload, r)");
    const elseAt = cli.indexOf("} else {", verdictAt);
    expect(verdictAt).toBeGreaterThan(-1);
    expect(elseAt).toBeGreaterThan(verdictAt);
    expect(cli.slice(verdictAt, elseAt)).not.toContain("recordCookiesApplied");
    expect(cli.slice(elseAt, elseAt + 400)).toContain("recordCookiesApplied");
  });

  it("node applies the credential push through the single write path", () => {
    expect(nodeCommands).toContain("applyPlatformCookies(store, decodeApplyCookies(b64))");
  });
});
