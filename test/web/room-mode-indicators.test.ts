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
      source({ danmu: 0, enabled: true, rollingUpload: true, rollingEffective: true, streamUpload: false },
        { enabled: true, workers: ["local"], pipeline: { steps: { burnDanmu: false, burnLivechat: false } } }),
      source({ danmu: 1, enabled: false, streamUpload: true, streamUploadSpool: false }, { pipeline: { upload: { mode: "rolling", private: false } } }),
      source({ danmu: 1, streamUpload: true }, { pipeline: { upload: { mode: "rolling" } } }),
      source(null, { enabled: false, pipeline: { upload: { mode: "rolling" } } }),
      source(null, { enabled: false, pipeline: { upload: { mode: "stage" } } }),
      source(null, { pipeline: { upload: { mode: "upload" } } }),
      source(null, { pipeline: { upload: { mode: "upload" }, steps: { nodeSideUpload: true, burnDanmu: false, burnLivechat: false } } }),
      source(null, { pipeline: { upload: { mode: "upload" }, steps: { nodeSideUpload: true, mergeSegments: false, burnDanmu: false, burnLivechat: false } } }),
      source(null, { pipeline: { upload: { mode: "upload" }, steps: { mergeSegments: false } } }),
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
    expect(kinds(null, { pipeline: { upload: { mode: "upload" } } })).toEqual(["merge", "bilibili"]);
  });

  it("represents authoritative legacy rolling and follows the projected method for Bilibili", () => {
    expect(kinds({ danmu: 0, enabled: true, rollingUpload: true, rollingEffective: true, streamUpload: false } as Record<string, unknown>,
      { enabled: true, workers: ["local"], pipeline: { steps: { burnDanmu: false, burnLivechat: false } } })).toEqual(["segment", "bilibili"]);
    expect(kinds({ rollingEffective: true } as Record<string, unknown>, null)).toEqual(["segment", "bilibili"]);
    expect(kinds({ rollingEffective: true } as Record<string, unknown>, { pipeline: { upload: { mode: "upload" } } })).toEqual(["segment", "bilibili"]);
  });

  it("does not override explicit stage or unknown modes with a stale effective field", () => {
    expect(kinds({ rollingEffective: true } as Record<string, unknown>, { pipeline: { upload: { mode: "stage" } } })).toEqual(["archive"]);
    expect(kinds({ rollingEffective: true } as Record<string, unknown>, { pipeline: { upload: { mode: "future" } } })).toEqual([]);
  });

  it("keeps legacy rolling when the raw mode is empty or whitespace", () => {
    expect(kinds({ rollingEffective: true } as Record<string, unknown>, { pipeline: { upload: { mode: "" } } })).toEqual(["segment", "bilibili"]);
    expect(kinds({ rollingEffective: true } as Record<string, unknown>, { pipeline: { upload: { mode: "  " } } })).toEqual(["segment", "bilibili"]);
  });

  it("marks the delivery route for after-close upload, but Bilibili only when upload is enabled", () => {
    expect(kinds(null, { pipeline: { upload: { mode: "upload" }, steps: { nodeSideUpload: true, burnDanmu: false, burnLivechat: false } } }))
      .toEqual(["node", "bilibili"]);
    expect(kinds(null, { pipeline: { upload: { mode: "upload" }, steps: { mergeSegments: false } } })).toEqual(["split", "bilibili"]);
    const nodeHint = roomModeIndicators(source(null, { pipeline: { upload: { mode: "upload" }, steps: { nodeSideUpload: true, burnDanmu: false, burnLivechat: false } } }))
      .find(indicator => indicator.kind === "node");
    expect(nodeHint?.labelKey).toBe("room.editor.timingNode");
    expect(nodeHint?.detailKeys).toContain("room.editor.timingNodeHint");
    expect(kinds(null, { pipeline: { upload: { mode: "upload" }, steps: { nodeSideUpload: true } } })).toEqual(["merge", "bilibili"]);
    expect(kinds(null, { pipeline: { upload: { mode: "stage" }, steps: { nodeSideUpload: true, burnDanmu: false, burnLivechat: false } } }))
      .toEqual(["archive"]);
    const paused = roomModeIndicators(source(null, { enabled: false, pipeline: { upload: { mode: "upload" }, steps: { nodeSideUpload: true, burnDanmu: false, burnLivechat: false } } }));
    expect(paused.map(indicator => indicator.kind)).toEqual(["node"]);
    expect(paused.find(indicator => indicator.kind === "node")?.detailKeys).toContain("room.pausedRule");
  });

  it("explains merged output for default and explicit merge, without mislabeling split or node delivery", () => {
    for (const steps of [undefined, { mergeSegments: true }, { nodeSideUpload: true, burnDanmu: true, burnLivechat: false }]) {
      const delivery = roomModeIndicators(source(null, { pipeline: { upload: { mode: "upload" }, steps } }))
        .find(indicator => indicator.id === "delivery");
      expect(delivery?.kind).toBe("merge");
      expect(delivery?.detailKeys).toContain("roomForm.mergeOneHint");
    }
    const split = roomModeIndicators(source(null, { pipeline: { upload: { mode: "upload" }, steps: { mergeSegments: false } } }))
      .find(indicator => indicator.id === "delivery");
    expect(split?.detailKeys).toContain("roomForm.mergeSplitHint");
    expect(split?.detailKeys).not.toContain("roomForm.mergeOneHint");
    const node = roomModeIndicators(source(null, { pipeline: { upload: { mode: "upload" }, steps: { nodeSideUpload: true, burnDanmu: false, burnLivechat: false } } }))
      .find(indicator => indicator.id === "delivery");
    expect(node?.detailKeys).toContain("room.editor.timingNodeHint");
    expect(node?.detailKeys).toContain("room.editor.timingNodeMergeHint");
    expect(node?.detailKeys).not.toContain("roomForm.mergeOneHint");
    const nodeSplit = roomModeIndicators(source(null, { pipeline: { upload: { mode: "upload" }, steps: { nodeSideUpload: true, mergeSegments: false, burnDanmu: false, burnLivechat: false } } }))
      .find(indicator => indicator.id === "delivery");
    expect(nodeSplit?.kind).toBe("node");
    expect(nodeSplit?.detailKeys).toContain("room.editor.timingNodeHint");
    expect(nodeSplit?.detailKeys).toContain("room.editor.timingNodeSplitHint");
    expect(nodeSplit?.detailKeys).not.toContain("room.editor.timingNodeMergeHint");
  });

  it("keeps the Bilibili mark when only recording is paused, and deduplicates the paused hint", () => {
    const both = roomModeIndicators(source({ danmu: 0, enabled: false, rollingEffective: true } as Record<string, unknown>,
      { enabled: false, pipeline: { upload: { mode: "rolling" } } }));
    const details = both.flatMap(indicator => indicator.detailKeys ?? []);
    expect(new Set(details).size).toBe(details.length);
    const recordingOnly = roomModeIndicators(source({ danmu: 0, enabled: false, rollingEffective: true } as Record<string, unknown>, null));
    expect(recordingOnly.map(indicator => indicator.kind)).toEqual(["segment", "bilibili"]);
    expect(recordingOnly.find(indicator => indicator.kind === "bilibili")?.detailKeys).toContain("room.pausedRule");
  });

  it("describes a paused recording without hiding the enabled upload rule", () => {
    const paused = roomModeIndicators(source({ danmu: 0, enabled: false, rollingEffective: true } as Record<string, unknown>, null));
    expect(paused.map(indicator => indicator.kind)).toEqual(["segment", "bilibili"]);
    expect(paused.find(indicator => indicator.kind === "segment")?.detailKeys).toContain("room.pausedRule");
    expect(paused.find(indicator => indicator.kind === "bilibili")?.detailKeys).toContain("room.pausedRule");
  });

  it("keeps direct upload configured when only the recorder is paused", () => {
    const processing = {
      enabled: true,
      workers: ["local"],
      pipeline: { upload: { mode: "rolling", private: false }, steps: { burnDanmu: false, burnLivechat: false } },
    };
    const recording = { enabled: false, streamUpload: true, streamUploadSpool: false };
    const indicators = roomModeIndicators(source(recording, processing));
    expect(indicators.map(indicator => indicator.kind)).toEqual(["zero-disk", "bilibili"]);
    expect(indicators.find(indicator => indicator.kind === "bilibili")?.detailKeys)
      .toEqual(["room.publicShort", "room.pausedRule"]);
    expect(indicators.find(indicator => indicator.kind === "zero-disk")?.detailKeys)
      .toEqual(["room.editor.zeroDiskSpool", "room.pausedRule"]);

    const standalone = roomModeIndicators(source(recording, null));
    expect(standalone.map(indicator => indicator.kind)).toEqual(["zero-disk", "bilibili"]);
    expect(standalone.find(indicator => indicator.kind === "bilibili")?.detailKeys).toEqual(["room.pausedRule"]);
    expect(kinds({ enabled: false, streamUpload: false }, null)).toEqual([]);

    for (const enabled of [true, false]) {
      expect(kinds({ ...recording, enabled }, { ...processing, enabled: false })).toEqual(["zero-disk"]);
    }
  });

  it("shows the effective local fallback for legacy, current and missing spool settings", () => {
    for (const streamUploadSpool of [false, true, undefined]) {
      const indicators = roomModeIndicators(source({ streamUpload: true, streamUploadSpool }, null));
      const delivery = indicators.find(indicator => indicator.kind === "zero-disk");
      expect(delivery?.detailKeys).toEqual(["room.editor.zeroDiskSpool"]);
      expect(delivery?.detailKeys).not.toContain("room.editor.zeroDisk");
    }
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
