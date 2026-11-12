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
// The hub starter body moved to @drec/hub-compose (plan 050.1): guards read the CLI assembly,
// so they follow the code there instead of breaking on the move.
const hubStarter = readFileSync(join(root, "packages/hub-compose/src/hub-starter.ts"), "utf-8");
// The platform credential push has its own module (plan 050.2).
const cookieSync = readFileSync(join(root, "packages/hub-compose/src/cookie-sync.ts"), "utf-8");
// The task reconcile loop has its own module (plan 050.3).
const taskSync = readFileSync(join(root, "packages/hub-compose/src/task-sync.ts"), "utf-8");
const cli = readFileSync(join(root, "packages/cli/src/cli.ts"), "utf-8")
  + "\n" + hubStarter + "\n" + cookieSync + "\n" + taskSync;
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
    expect(cookieSync).toContain("shouldPushCookies(readCookiesApplied(deps.store, id)");
    expect(cookieSync).toContain("cookiesPushVerdict(round.payload, r)");
    // Record must live in the **success branch**: the `!verdict.ok` branch may only warn/retry.
    const verdictAt = cookieSync.indexOf("cookiesPushVerdict(round.payload, r)");
    const elseAt = cookieSync.indexOf("} else {", verdictAt);
    expect(verdictAt).toBeGreaterThan(-1);
    expect(elseAt).toBeGreaterThan(verdictAt);
    expect(cookieSync.slice(verdictAt, elseAt)).not.toContain("recordCookiesApplied");
    expect(cookieSync.slice(elseAt, elseAt + 400)).toContain("recordCookiesApplied");
  });

  // The hub tick is not importable from vitest, so the cross-module call itself is pinned here: a move
  // that leaves the extracted module unreferenced would otherwise look like a clean refactor.
  it("hub sync tick still drives the credential push (round + per worker call)", () => {
    expect(taskSync).toContain("const cookiesRound = deps.cookieSync.beginRound();");
    expect(taskSync).toContain("await deps.cookieSync.pushTo({ id: w.id, kind: w.kind }, t, cookiesRound)");
  });

  // Same reasoning for the extracted task loop (plan 050.3): the starter must keep assembling it,
  // and the credential push must stay ahead of applies inside that loop.
  it("hub starter assembles the task sync loop and keeps push-before-apply", () => {
    expect(hubStarter).toContain("createTaskSync({");
    expect(hubStarter).toContain("beginRound: beginZeroDiskRound");
    expect(hubStarter).toContain("finishRound: finishZeroDiskRound");
    const pushAt = taskSync.indexOf("await deps.cookieSync.pushTo(");
    const applyAt = taskSync.indexOf("await t.applyTasks(");
    expect(pushAt).toBeGreaterThan(-1);
    expect(applyAt).toBeGreaterThan(pushAt);
  });

  it("node applies the credential push through the single write path", () => {
    expect(nodeCommands).toContain("applyPlatformCookies(store, decodeApplyCookies(b64))");
  });
});
