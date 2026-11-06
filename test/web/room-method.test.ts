import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import { roomMethodKind } from "../../packages/web/src/lib/room-method.js";
import type { RoomDTO } from "../../packages/web/src/api/client.js";

const room = (over: Pick<RoomDTO, "recording" | "processing">): Pick<RoomDTO, "recording" | "processing"> => over;

describe("roomMethodKind — the one delivery-mode projection used by the rooms UI", () => {
  it("treats omitted legacy upload settings as archive, without guessing unknown future modes", () => {
    expect(roomMethodKind(room({ recording: null, processing: { pipeline: {} } as RoomDTO["processing"] }))).toBe("archive");
    expect(roomMethodKind(room({ recording: null, processing: { pipeline: { upload: { mode: "future" } } } as unknown as RoomDTO["processing"] }))).toBe("none");
  });

  it("describes configured delivery independently of whether the room is paused", () => {
    expect(roomMethodKind(room({
      recording: { enabled: false } as RoomDTO["recording"],
      processing: { enabled: false, pipeline: { upload: { mode: "rolling" } } } as RoomDTO["processing"],
    }))).toBe("rolling");
  });

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

  it("honors authoritative legacy rolling even without a processing rule", () => {
    expect(roomMethodKind(room({ recording: { rollingEffective: true } as RoomDTO["recording"], processing: null }))).toBe("rolling");
    expect(roomMethodKind(room({ recording: { rollingEffective: true } as RoomDTO["recording"], processing: { pipeline: {} } as RoomDTO["processing"] }))).toBe("rolling");
  });

  it("prefers authoritative legacy rolling over an upload-mode rule, and never overrides explicit stage or unknown modes", () => {
    expect(roomMethodKind(room({ recording: { rollingEffective: true } as RoomDTO["recording"], processing: { pipeline: { upload: { mode: "upload" } } } as RoomDTO["processing"] }))).toBe("rolling");
    expect(roomMethodKind(room({ recording: { rollingEffective: true } as RoomDTO["recording"], processing: { pipeline: { upload: { mode: "stage" } } } as RoomDTO["processing"] }))).toBe("archive");
    expect(roomMethodKind(room({ recording: { rollingEffective: true } as RoomDTO["recording"], processing: { pipeline: { upload: { mode: "future" } } } as unknown as RoomDTO["processing"] }))).toBe("none");
  });

  it("treats empty/whitespace modes as unconfigured for legacy rolling, matching core normalizeUploadMode", () => {
    for (const mode of ["", "  ", null, undefined]) {
      expect(roomMethodKind(room({ recording: { rollingEffective: true } as RoomDTO["recording"], processing: { pipeline: { upload: { mode } } } as unknown as RoomDTO["processing"] }))).toBe("rolling");
    }
    expect(roomMethodKind(room({ recording: { rollingEffective: false } as RoomDTO["recording"], processing: { pipeline: { upload: { mode: "" } } } as unknown as RoomDTO["processing"] }))).toBe("archive");
    expect(roomMethodKind(room({ recording: { rollingEffective: false } as RoomDTO["recording"], processing: { pipeline: { upload: { mode: "  " } } } as unknown as RoomDTO["processing"] }))).toBe("archive");
  });

  it("ignores a false or absent effective flag for ordinary archive/none", () => {
    expect(roomMethodKind(room({ recording: { rollingEffective: false } as RoomDTO["recording"], processing: null }))).toBe("none");
    expect(roomMethodKind(room({ recording: { rollingEffective: false } as RoomDTO["recording"], processing: { pipeline: {} } as RoomDTO["processing"] }))).toBe("archive");
    expect(roomMethodKind(room({ recording: {} as RoomDTO["recording"], processing: { pipeline: {} } as RoomDTO["processing"] }))).toBe("archive");
  });
  it("every mode-card hint exists in both dictionaries (hints are read via t(m.hint), not literal t())", () => {
    const dict = readFileSync(join(__dirname, "..", "..", "packages", "web", "src", "lib", "i18n.tsx"), "utf-8");
    for (const key of ["archiveHint", "uploadHint", "mergeOneHint", "mergeSplitHint", "rollingHint", "nodeHint"]) {
      expect(dict.match(new RegExp(`\\b${key}\\s*:`, "g")) ?? [], `${key} must exist in zh + en`).toHaveLength(2);
    }
  });
});
