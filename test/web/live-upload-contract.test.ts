import { describe, expect, it } from "vitest";
import type { LiveUploadSnapshot } from "@drec/contracts";

describe("live upload contract is importable from @drec/contracts", () => {
  it("exposes the snapshot type to the web package", () => {
    const s: LiveUploadSnapshot = {
      schemaVersion: 1,
      mode: "zero-disk",
      platform: "douyin",
      roomSlug: "1",
      state: "waiting",
      startedAt: 1,
      updatedAt: 1,
      parts: [],
      events: [],
    };
    expect(s.state).toBe("waiting");
  });
});
