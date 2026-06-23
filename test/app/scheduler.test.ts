import { describe, it, expect } from "vitest";
import { inWindow, nowMinutesLocal } from "../../packages/app/src/scheduler.js";

const at = (h: number, m = 0): number => h * 60 + m;

describe("inWindow — null/empty → always eligible", () => {
  it("null start", () => expect(inWindow(at(3), null, "09:00")).toBe(true));
  it("null end", () => expect(inWindow(at(3), "06:00", null)).toBe(true));
  it("both null", () => expect(inWindow(at(3), null, null)).toBe(true));
  it("empty string", () => expect(inWindow(at(3), "", "")).toBe(true));
});

describe("inWindow — same-day window 06:00-09:00", () => {
  const s = "06:00";
  const e = "09:00";
  it("inside at 07:00", () => expect(inWindow(at(7), s, e)).toBe(true));
  it("outside before at 05:00", () => expect(inWindow(at(5), s, e)).toBe(false));
  it("outside after at 10:00", () => expect(inWindow(at(10), s, e)).toBe(false));
  it("boundary start 06:00 inclusive", () => expect(inWindow(at(6), s, e)).toBe(true));
  it("boundary end 09:00 inclusive", () => expect(inWindow(at(9), s, e)).toBe(true));
  it("just before start 05:59", () => expect(inWindow(at(5, 59), s, e)).toBe(false));
  it("just after end 09:01", () => expect(inWindow(at(9, 1), s, e)).toBe(false));
});

describe("inWindow — overnight window 22:30-01:00", () => {
  const s = "22:30";
  const e = "01:00";
  it("inside late at 23:00", () => expect(inWindow(at(23), s, e)).toBe(true));
  it("inside early at 00:30", () => expect(inWindow(at(0, 30), s, e)).toBe(true));
  it("outside at 02:00", () => expect(inWindow(at(2), s, e)).toBe(false));
  it("outside at 22:00", () => expect(inWindow(at(22), s, e)).toBe(false));
  it("boundary start 22:30 inclusive", () => expect(inWindow(at(22, 30), s, e)).toBe(true));
  it("boundary end 01:00 inclusive", () => expect(inWindow(at(1), s, e)).toBe(true));
  it("just before start 22:29", () => expect(inWindow(at(22, 29), s, e)).toBe(false));
  it("just after end 01:01", () => expect(inWindow(at(1, 1), s, e)).toBe(false));
  it("midnight 00:00 inside", () => expect(inWindow(at(0), s, e)).toBe(true));
});

describe("inWindow — degenerate equal start==end", () => {
  it("single-minute window, exact match", () => expect(inWindow(at(8), "08:00", "08:00")).toBe(true));
  it("single-minute window, miss", () => expect(inWindow(at(8, 1), "08:00", "08:00")).toBe(false));
});

describe("nowMinutesLocal", () => {
  it("computes local minutes since midnight", () => {
    const d = new Date(2026, 5, 12, 7, 30, 0); // local 07:30
    expect(nowMinutesLocal(d)).toBe(at(7, 30));
  });
  it("midnight = 0", () => {
    const d = new Date(2026, 5, 12, 0, 0, 0);
    expect(nowMinutesLocal(d)).toBe(0);
  });
  it("23:59 = 1439", () => {
    const d = new Date(2026, 5, 12, 23, 59, 0);
    expect(nowMinutesLocal(d)).toBe(1439);
  });
});
