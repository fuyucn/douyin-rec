import { describe, it, expect } from "vitest";
import { resolveUploadOwner } from "@drec/core";

describe("resolveUploadOwner (plan 046 PR7)", () => {
  it("enabled rule bound by source task or room key -> master", () => {
    expect(resolveUploadOwner({ ruleEnabled: true, boundBySourceTask: true, boundByRoomKey: false })).toBe("master");
    expect(resolveUploadOwner({ ruleEnabled: true, boundBySourceTask: false, boundByRoomKey: true })).toBe("master");
  });
  it("no enabled rule, disabled rule, or unrelated match -> node", () => {
    expect(resolveUploadOwner({ ruleEnabled: false, boundBySourceTask: false, boundByRoomKey: false })).toBe("node");
    expect(resolveUploadOwner({ ruleEnabled: false, boundBySourceTask: true, boundByRoomKey: true })).toBe("node");
    expect(resolveUploadOwner({ ruleEnabled: true, boundBySourceTask: false, boundByRoomKey: false })).toBe("node");
  });
});
