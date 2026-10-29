import { describe, it, expect } from "vitest";
import { segmentIndexOf, sessionBaseOf, stampedSessionBaseOf, stripSegmentSuffix } from "./session-name.js";

const STAMP = "主播A_2026-08-10_23-08-10";
const SUFFIXES: Array<[label: string, suffix: string, idx: number]> = [
  ["无后缀", "", -1],
  ["-PART### (biliLive)", "-PART000", 0],
  ["-PART 短号", "-PART01", 1],
  ["-PART 多位", "-PART123", 123],
  ["_PART### (下划线)", "_PART001", 1],
  ["_### (DLR/mesio)", "_007", 7],
  ["_#### (4 位)", "_1000", 1000],
];
const VIDEO_EXTS = [".ts", ".flv", ".mp4"];

describe("sessionBaseOf(宽松)", () => {
  for (const [label, suffix] of SUFFIXES) {
    for (const ext of [...VIDEO_EXTS, ".xml"]) {
      it(`${label} + ${ext} + 带时间戳`, () => {
        expect(sessionBaseOf(`${STAMP}${suffix}${ext}`)).toBe(STAMP);
      });
    }
    it(`${label} + 不带时间戳`, () => {
      expect(sessionBaseOf(`room${suffix}.ts`)).toBe("room");
    });
  }

  it("取 basename:目录部分不影响结果", () => {
    expect(sessionBaseOf(`/data/rec/${STAMP}_001.ts`)).toBe(STAMP);
    expect(sessionBaseOf(`C:\\rec\\${STAMP}-PART002.flv`)).toBe(STAMP);
  });

  it("后缀大小写不敏感", () => {
    expect(sessionBaseOf(`${STAMP}-part003.TS`)).toBe(STAMP);
  });

  it("短裸数字(<3 位)不是段号,不误剥", () => {
    expect(sessionBaseOf("room_12.ts")).toBe("room_12");
    expect(sessionBaseOf(`${STAMP}.ts`)).toBe(STAMP); // 时间 HH-MM-SS 用连字符,不被误剥
  });

  it("附属扩展名 .ass/.mkv/.webm 也剥", () => {
    expect(sessionBaseOf(`${STAMP}.ass`)).toBe(STAMP);
    expect(sessionBaseOf(`${STAMP}_000.mkv`)).toBe(STAMP);
    expect(sessionBaseOf(`${STAMP}.webm`)).toBe(STAMP);
  });
});

describe("stripSegmentSuffix", () => {
  it.each(SUFFIXES)("%s", (_l, suffix) => {
    expect(stripSegmentSuffix(`${STAMP}${suffix}`)).toBe(STAMP);
  });
});

describe("stampedSessionBaseOf(锚定时间戳)", () => {
  for (const [label, suffix] of SUFFIXES) {
    for (const ext of [...VIDEO_EXTS, ".xml"]) {
      it(`${label} + ${ext}`, () => {
        expect(stampedSessionBaseOf(`${STAMP}${suffix}${ext}`)).toBe(STAMP);
      });
    }
  }

  it.each([
    "2026-08-14.ts",
    "主播A_2026-08-14.ts",
    "主播A_2026-08-14_23-08.ts", // 无秒
    `${STAMP}.txt`,
    `${STAMP}.ass`, // 锚定口径不认 .ass(只认录制产物 ts/flv/mp4/xml)
    "room_000.ts",
  ])("不符返回 undefined: %s", (name) => {
    expect(stampedSessionBaseOf(name)).toBeUndefined();
  });
});

describe("segmentIndexOf", () => {
  for (const [label, suffix, idx] of SUFFIXES) {
    for (const ext of [...VIDEO_EXTS, ".xml"]) {
      it(`${label} + ${ext} → ${idx}`, () => {
        expect(segmentIndexOf(`${STAMP}${suffix}${ext}`)).toBe(idx);
      });
    }
  }
  it("短裸数字不算段号", () => {
    expect(segmentIndexOf("room_12.ts")).toBe(-1);
  });
  it("带目录", () => {
    expect(segmentIndexOf(`/x/${STAMP}_PART010.ts`)).toBe(10);
  });
});
