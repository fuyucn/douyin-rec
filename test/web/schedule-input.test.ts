import { describe, it, expect } from "vitest";
import { scheduleInput, splitSchedule } from "../../packages/web/src/lib/labels";

describe("splitSchedule — 表单窗口 → 成对端点", () => {
  it("空 / 纯空白 = 全天(两端都 null,用于清空窗口)", () => {
    expect(splitSchedule("")).toEqual({ scheduleStart: null, scheduleEnd: null });
    expect(splitSchedule("   ")).toEqual({ scheduleStart: null, scheduleEnd: null });
  });
  it("HH:MM-HH:MM(含跨夜与两侧空白)", () => {
    expect(splitSchedule("10:00-12:00")).toEqual({ scheduleStart: "10:00", scheduleEnd: "12:00" });
    expect(splitSchedule(" 22:00 - 01:30 ")).toEqual({ scheduleStart: "22:00", scheduleEnd: "01:30" });
  });
  it("拆不开 → null(交给调用方报错,不静默发出半个窗口)", () => {
    expect(splitSchedule("10:00")).toBeNull();
  });
  it("与 scheduleInput 往返", () => {
    const pair = splitSchedule(scheduleInput({ scheduleStart: "08:00", scheduleEnd: "09:30" }));
    expect(pair).toEqual({ scheduleStart: "08:00", scheduleEnd: "09:30" });
  });
});
