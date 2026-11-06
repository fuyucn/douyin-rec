import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { roomMethodKind } from "../../packages/web/src/lib/room-method.js";
import type { RoomDTO } from "../../packages/web/src/api/client.js";

const room = (over: Pick<RoomDTO, "recording" | "processing">): Pick<RoomDTO, "recording" | "processing"> => over;

describe("roomMethodKind — the one delivery-mode projection used by the rooms UI", () => {
  it("live upload wins over any processing mode", () => {
    expect(roomMethodKind(room({
      recording: { streamUpload: true } as RoomDTO["recording"],
      processing: { pipeline: { upload: { mode: "upload" } } } as RoomDTO["processing"],
    }))).toBe("live");
  });
  it("falls back through rolling > upload > archive", () => {
    expect(roomMethodKind(room({
      recording: null,
      processing: { pipeline: { upload: { mode: "rolling" } } } as RoomDTO["processing"],
    }))).toBe("rolling");
    expect(roomMethodKind(room({
      recording: null,
      processing: { pipeline: { upload: { mode: "upload" } } } as RoomDTO["processing"],
    }))).toBe("upload");
    expect(roomMethodKind(room({
      recording: null,
      processing: { pipeline: { upload: { mode: "stage" } } } as RoomDTO["processing"],
    }))).toBe("archive");
  });
  it("rule-only / task-only rooms have no delivery mode", () => {
    expect(roomMethodKind(room({ recording: null, processing: null }))).toBe("none");
    expect(roomMethodKind(room({ recording: null, processing: undefined }))).toBe("none");
  });
  it("every mode-card hint exists in both dictionaries (hints are read via t(m.hint), not literal t())", () => {
    const dict = readFileSync(join(__dirname, "..", "..", "packages", "web", "src", "lib", "i18n.tsx"), "utf-8");
    for (const key of ["archiveHint", "uploadHint", "mergeOneHint", "mergeSplitHint", "rollingHint", "nodeHint"]) {
      expect(dict.match(new RegExp(`\\b${key}\\s*:`, "g")) ?? [], `${key} must exist in zh + en`).toHaveLength(2);
    }
  });
});
