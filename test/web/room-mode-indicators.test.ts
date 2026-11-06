import { describe, expect, it } from "vitest";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { runInNewContext } from "node:vm";
import { roomModeIndicators, type RoomIndicatorSource } from "../../packages/web/src/lib/room-mode-indicators.js";

const source = (recording: unknown, processing: unknown): RoomIndicatorSource => ({ recording, processing } as RoomIndicatorSource);
const kinds = (recording: unknown, processing: unknown): string[] => roomModeIndicators(source(recording, processing)).map(indicator => indicator.kind);

describe("compact room indicator facts", () => {
  it("resolves every dynamic label and description in both interface languages", () => {
    const text = readFileSync(join(__dirname, "../../packages/web/src/lib/i18n.tsx"), "utf8");
    const start = text.indexOf("=", text.indexOf("const DICT")) + 1;
    const expression = text.slice(start, text.lastIndexOf("\n};") + 3).trim().replace(/;$/, "");
    const dictionaries = runInNewContext("(" + expression + ")");
    const fixtures = [
      source({ danmu: 1, enabled: false, streamUpload: true, streamUploadSpool: false }, { pipeline: { upload: { mode: "rolling", private: false } } }),
      source({ danmu: 1, streamUpload: true }, { pipeline: { upload: { mode: "rolling" } } }),
      source(null, { enabled: false, pipeline: { upload: { mode: "rolling" } } }),
      source(null, { enabled: false, pipeline: { upload: { mode: "stage" } } }),
      source(null, { pipeline: { upload: { mode: "upload" } } }),
    ];
    const keys = fixtures.flatMap(room => roomModeIndicators(room).flatMap(indicator => [indicator.labelKey, ...(indicator.detailKeys ?? [])]));
    for (const language of ["zh", "en"]) {
      for (const key of new Set(keys)) {
        const value = key.split(".").reduce((current, part) => current?.[part], dictionaries[language]);
        expect(value, language + ": " + key).toEqual(expect.any(String));
        expect(value).not.toBe("");
      }
    }
  });

  it("does not invent archive or upload configuration for an unbound task", () => {
    expect(kinds(null, null)).toEqual([]);
    expect(kinds({}, null)).toEqual([]);
  });

  it("uses recording danmu, never requested burn output, as the capture flag", () => {
    expect(kinds({ danmu: 1 }, null)).toEqual(["danmu"]);
    expect(kinds({ danmu: 0 }, { pipeline: { upload: { mode: "stage" }, steps: { burnDanmu: true } } })).not.toContain("danmu");
    expect(kinds(null, { pipeline: { steps: { burnDanmu: true } } })).not.toContain("danmu");
  });

  it("keeps upload enablement separate from direct and batch transport", () => {
    expect(kinds({ streamUpload: true }, { pipeline: { upload: { mode: "rolling" } } })).toEqual(expect.arrayContaining(["zero-disk", "bilibili"]));
    expect(kinds(null, { pipeline: { upload: { mode: "rolling" } } })).toEqual(expect.arrayContaining(["segment", "bilibili"]));
    expect(kinds(null, { pipeline: { upload: { mode: "upload" } } })).toEqual(["bilibili"]);
  });

  it("does not mark a paused rule as upload enabled", () => {
    const pausedDirect = roomModeIndicators(source({ streamUpload: true }, { enabled: false, pipeline: { upload: { mode: "rolling" } } }));
    expect(pausedDirect.map(indicator => indicator.kind)).not.toContain("bilibili");
    expect(pausedDirect.find(indicator => indicator.kind === "zero-disk")?.detailKeys).toContain("room.pausedRule");
    expect(kinds(null, { enabled: false, pipeline: { upload: { mode: "rolling" } } })).not.toContain("bilibili");
    expect(kinds(null, { enabled: false, pipeline: { upload: { mode: "upload" } } })).not.toContain("bilibili");
  });

  it("supports legacy archive rules without guessing unknown future modes", () => {
    expect(kinds(null, { pipeline: {} })).toEqual(["archive"]);
    expect(kinds(null, { pipeline: { upload: { mode: "future" } } })).toEqual([]);
  });

  it("uses unique stable identities when capture and transport coexist", () => {
    const indicators = roomModeIndicators(source({ danmu: 1, streamUpload: true }, { pipeline: { upload: { mode: "rolling" } } }));
    expect(new Set(indicators.map(indicator => indicator.id)).size).toBe(indicators.length);
  });
});
