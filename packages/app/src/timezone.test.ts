import { describe, it, expect, afterEach } from "vitest";
import { applyTimezone, isValidTimezone, DEFAULT_TIMEZONE } from "./timezone.js";
import type { TaskStore } from "./store.js";

/** 极简假 store:applyTimezone 只用到 getSetting("timezone")。 */
const fakeStore = (timezone?: string): TaskStore =>
  ({ getSetting: (k: string) => (k === "timezone" ? timezone : undefined) }) as unknown as TaskStore;

describe("isValidTimezone", () => {
  it("合法 IANA 时区名 → true", () => {
    expect(isValidTimezone("America/Los_Angeles")).toBe(true);
    expect(isValidTimezone("Asia/Shanghai")).toBe(true);
    expect(isValidTimezone("UTC")).toBe(true);
  });
  it("乱写的字符串 → false", () => {
    expect(isValidTimezone("Not/A/Zone")).toBe(false);
    expect(isValidTimezone("")).toBe(false);
  });
});

describe("applyTimezone", () => {
  const prevTZ = process.env.TZ;
  afterEach(() => {
    if (prevTZ === undefined) delete process.env.TZ;
    else process.env.TZ = prevTZ;
  });

  it("未配置 → 用 DEFAULT_TIMEZONE,且真的写进 process.env.TZ", () => {
    process.env.TZ = "UTC"; // 模拟 host/容器已经设了别的 TZ
    const tz = applyTimezone(fakeStore());
    expect(tz).toBe(DEFAULT_TIMEZONE);
    expect(process.env.TZ).toBe(DEFAULT_TIMEZONE); // 覆盖了 host 的 UTC,不看 host
  });

  it("配置了合法时区 → 用它,覆盖 host 原值", () => {
    process.env.TZ = "UTC";
    const tz = applyTimezone(fakeStore("Asia/Shanghai"));
    expect(tz).toBe("Asia/Shanghai");
    expect(process.env.TZ).toBe("Asia/Shanghai");
  });

  it("配置了非法值 → 回落默认(不让打错的值悄悄生效)", () => {
    const tz = applyTimezone(fakeStore("Not/A/Zone"));
    expect(tz).toBe(DEFAULT_TIMEZONE);
    expect(process.env.TZ).toBe(DEFAULT_TIMEZONE);
  });

  it("生效后 Date 的本地时间转换立刻反映新时区(端到端,不只是设了变量)", () => {
    applyTimezone(fakeStore("Asia/Shanghai"));
    const shanghaiHour = new Date("2026-07-01T20:00:00Z").getHours();
    applyTimezone(fakeStore("America/Los_Angeles"));
    const laHour = new Date("2026-07-01T20:00:00Z").getHours();
    expect(shanghaiHour).not.toBe(laHour); // 同一时刻,两个时区算出的小时数必须不同
    expect(shanghaiHour).toBe(4); // 20:00 UTC + 8h = 次日 04:00
  });
});
