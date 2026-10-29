import { describe, expect, it } from "vitest";
import { zeroDiskSpoolName, zeroDiskXmlPath } from "./zero-disk-room.js";

describe("zeroDiskXmlPath (issue #329)", () => {
  it("issue #360: uses the anchor name when known, room slug otherwise", () => {
    const tz = "Asia/Shanghai";
    const t = Date.UTC(2026, 9, 20, 2, 3, 4);
    expect(zeroDiskXmlPath("/out/room", "123", t, tz, "云念")).toBe("/out/room/云念_2026-10-20_10-03-04.live.xml");
    expect(zeroDiskXmlPath("/out", "123", t, tz)).toBe("/out/123_2026-10-20_10-03-04.live.xml");
    // Legacy layout keeps the room slug when no anchor is supplied.
    expect(zeroDiskXmlPath("/out", "123", t, tz, undefined)).toBe("/out/123_2026-10-20_10-03-04.live.xml");
  });

  it("stamps the danmu start time so each run gets its own file", () => {
    const tz = "Asia/Shanghai";
    const a = zeroDiskXmlPath("/out", "123", Date.UTC(2026, 9, 20, 2, 3, 4), tz);
    expect(a).toBe("/out/123_2026-10-20_10-03-04.live.xml");
    const b = zeroDiskXmlPath("/out", "123", Date.UTC(2026, 9, 21, 2, 3, 4), tz);
    expect(b).not.toBe(a);
  });

  it("builds time-first live spool names with collision suffixes", () => {
    const tz = "Asia/Shanghai";
    const t = Date.UTC(2026, 9, 20, 2, 3, 4);
    expect(zeroDiskSpoolName("云念", t, 0, tz)).toBe("云念_2026-10-20_10-03-04_000.live.ts");
    expect(zeroDiskSpoolName("云念", t, 12, tz, 2)).toBe("云念_2026-10-20_10-03-04_012-2.live.ts");
  });
});
