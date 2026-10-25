import { describe, expect, it } from "vitest";
import { zeroDiskXmlPath } from "./zero-disk-room.js";

describe("zeroDiskXmlPath (issue #329)", () => {
  it("issue #360: uses the anchor name when known, room slug otherwise", () => {
    const tz = "Asia/Shanghai";
    const t = Date.UTC(2026, 9, 20, 2, 3, 4);
    expect(zeroDiskXmlPath("/out/room", "123", t, tz, "云念")).toBe("/out/room/live-pump-云念_2026-10-20_10-03-04.xml");
    expect(zeroDiskXmlPath("/out", "123", t, tz)).toBe("/out/live-pump-123_2026-10-20_10-03-04.xml");
    // Legacy layout must stay byte-identical even when the caller knows an anchor name.
    expect(zeroDiskXmlPath("/out", "123", t, tz, undefined)).toBe("/out/live-pump-123_2026-10-20_10-03-04.xml");
  });

  it("stamps the danmu start time so each run gets its own file", () => {
    const tz = "Asia/Shanghai";
    const a = zeroDiskXmlPath("/out", "123", Date.UTC(2026, 9, 20, 2, 3, 4), tz);
    expect(a).toBe("/out/live-pump-123_2026-10-20_10-03-04.xml");
    const b = zeroDiskXmlPath("/out", "123", Date.UTC(2026, 9, 21, 2, 3, 4), tz);
    expect(b).not.toBe(a);
  });
});
