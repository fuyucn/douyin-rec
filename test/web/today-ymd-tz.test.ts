import { describe, it, expect } from "vitest";
import { todayYmdInTz } from "../../packages/web/src/lib/tz";

/** issue #155:hub 房间页「手动投稿 / 新建投稿」默认日期按后端设置时区,不是浏览器本地日期。 */
describe("todayYmdInTz", () => {
  const now = new Date("2026-09-12T17:30:00Z"); // 北京 09-13 01:30 / 洛杉矶 09-12 10:30
  it("北京次日凌晨 → 北京日期(浏览器在美西也一样)", () => {
    expect(todayYmdInTz("Asia/Shanghai", now)).toBe("2026-09-13");
    expect(todayYmdInTz("America/Los_Angeles", now)).toBe("2026-09-12");
  });
  it("北京晚间 → 北京当天", () => {
    expect(todayYmdInTz("Asia/Shanghai", new Date("2026-09-12T14:00:00Z"))).toBe("2026-09-12");
  });
  it("模拟浏览器时区为美西,serverTz 仍决定结果", () => {
    const prev = process.env.TZ;
    process.env.TZ = "America/Los_Angeles";
    try {
      expect(todayYmdInTz("Asia/Shanghai", now)).toBe("2026-09-13");
    } finally {
      if (prev === undefined) delete process.env.TZ; else process.env.TZ = prev;
    }
  });
});
