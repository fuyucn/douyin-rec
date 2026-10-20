import { describe, expect, it } from "vitest";
import { zeroDiskXmlPath } from "./zero-disk-room.js";

describe("zeroDiskXmlPath (issue #329)", () => {
  it("stamps the danmu start time so each run gets its own file", () => {
    const tz = "Asia/Shanghai";
    const a = zeroDiskXmlPath("/out", "123", Date.UTC(2026, 9, 20, 2, 3, 4), tz);
    expect(a).toBe("/out/live-pump-123_2026-10-20_10-03-04.xml");
    const b = zeroDiskXmlPath("/out", "123", Date.UTC(2026, 9, 21, 2, 3, 4), tz);
    expect(b).not.toBe(a);
  });
});
