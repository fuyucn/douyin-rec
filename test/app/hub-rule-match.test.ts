import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { upsertHubRule } from "../../packages/app/src/hub-store.js";
import { masterOwnedWithoutRule, shouldDecideUploadOwner, uploadOwnerForTask } from "../../packages/app/src/hub-rule-match.js";

let dir: string;
let hubDir: string;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hub-owner-"));
  hubDir = join(dir, "hub");
  mkdirSync(hubDir, { recursive: true });
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const task = (id: number, room = "https://live.douyin.com/111") => ({ id, room });

describe("uploadOwnerForTask (plan 046 PR7 single decision)", () => {
  it("enabled rule by source task -> master; by room key -> master", () => {
    upsertHubRule(hubDir, { platform: "douyin", roomSlug: "999", recording: { sourceTaskId: 7 } });
    expect(uploadOwnerForTask(task(7), hubDir)).toBe("master");
    upsertHubRule(hubDir, { platform: "douyin", roomSlug: "111" });
    expect(uploadOwnerForTask(task(8), hubDir)).toBe("master");
  });
  it("disabled rule is unbound; unrelated rule/room stays node", () => {
    upsertHubRule(hubDir, { platform: "douyin", roomSlug: "111", enabled: false });
    expect(uploadOwnerForTask(task(7), hubDir)).toBe("node");
    upsertHubRule(hubDir, { platform: "douyin", roomSlug: "222", recording: { sourceTaskId: 8 } });
    expect(uploadOwnerForTask(task(7), hubDir)).toBe("node");
  });
  it("binding/unbinding is visible on the next call (next seal)", () => {
    expect(uploadOwnerForTask(task(7), hubDir)).toBe("node");
    upsertHubRule(hubDir, { platform: "douyin", roomSlug: "111", recording: { sourceTaskId: 7 } });
    expect(uploadOwnerForTask(task(7), hubDir)).toBe("master");
    upsertHubRule(hubDir, { platform: "douyin", roomSlug: "111", recording: { sourceTaskId: 7 }, enabled: false });
    expect(uploadOwnerForTask(task(7), hubDir)).toBe("node");
  });
});

describe("upload-owner wiring gates (rework addenda 6-7)", () => {
  it("only a hub master (or a hub-managed task) may decide ownership", () => {
    expect(shouldDecideUploadOwner({ managedBy: "hub" }, false)).toBe(true);   // worker: the master exists
    expect(shouldDecideUploadOwner({ managedBy: null }, false)).toBe(false);   // rule files but no orchestrator
    expect(shouldDecideUploadOwner({}, false)).toBe(false);
    expect(shouldDecideUploadOwner({ managedBy: null }, true)).toBe(true);     // serve --hub
  });

  it("master ownership without an enabled rule is reported (the node would keep sources forever)", () => {
    expect(masterOwnedWithoutRule("master", false, true)).toBe(true);
    expect(masterOwnedWithoutRule("master", true, true)).toBe(false);
    expect(masterOwnedWithoutRule("node", false, true)).toBe(false);
    // On a worker the absence of local rules is expected: no alert.
    expect(masterOwnedWithoutRule("master", false, false)).toBe(false);
  });
});

