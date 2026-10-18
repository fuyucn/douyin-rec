// packages/orchestrator/src/unclaimed.test.ts
import { describe, it, expect } from "vitest";
import { classifyUnclaimedFiles, inferRoomFromSiblings } from "./unclaimed.js";

const BASE = "a_2026-06-20_01-02-03";

describe("classifyUnclaimedFiles", () => {
  it("returns stamped + indexed mp4/mkv segments that are not claimed, sorted by name", () => {
    const hits = classifyUnclaimedFiles([`${BASE}_001.mkv`, `${BASE}_000.mp4`], new Set());
    expect(hits).toEqual([
      { file: `${BASE}_000.mp4`, sessionBase: BASE, segmentIndex: 0 },
      { file: `${BASE}_001.mkv`, sessionBase: BASE, segmentIndex: 1 },
    ]);
  });

  it("ignores native containers, products without stamp/index, burn products and claimed files", () => {
    const files = [
      `${BASE}_000.ts`, `${BASE}_001.flv`,
      `${BASE}_part1.mp4`,
      "a_2026-06-20.mp4", "a_2026-06-20_000.mp4",
      `${BASE}.mp4`,
      "x_danmu.mp4",
      `${BASE}_002.mp4`,
    ];
    expect(classifyUnclaimedFiles(files, new Set([`${BASE}_002.mp4`]))).toEqual([]);
  });

  it("claimed set is honoured: the same name is reported when not claimed", () => {
    expect(classifyUnclaimedFiles([`${BASE}_002.mp4`], new Set())).toHaveLength(1);
  });

  it("ignores runner/suspect intermediates, sidecar temps and atomic temps", () => {
    const files = [
      `${BASE}_000.mp4.serve:12:1700000000-123.drec-remux`,
      `${BASE}_000.mp4.drec-suspect`,
      `${BASE}.session.json.123.ab12cd34.tmp`,
      `${BASE}.session.json.tmp`,
      `.${BASE}_000.part.mp4`,
    ];
    expect(classifyUnclaimedFiles(files, new Set())).toEqual([]);
  });
});

describe("inferRoomFromSiblings", () => {
  it("returns the pair when every sibling agrees", () => {
    const s = { platform: "douyin", roomSlug: "1" };
    expect(inferRoomFromSiblings([s, { ...s }])).toEqual(s);
  });

  it("returns null on disagreement, empty input or a sibling missing roomSlug", () => {
    expect(inferRoomFromSiblings([{ platform: "douyin", roomSlug: "1" }, { platform: "douyin", roomSlug: "2" }])).toBeNull();
    expect(inferRoomFromSiblings([])).toBeNull();
    expect(inferRoomFromSiblings([{ platform: "douyin", roomSlug: "1" }, { platform: "douyin" }])).toBeNull();
  });
});
