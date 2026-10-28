import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";

const I18N_SOURCE = readFileSync(
  new URL("../../packages/web/src/lib/i18n.tsx", import.meta.url),
  "utf-8",
);

describe("live direct upload naming", () => {
  it("uses the user-facing 直播直传 name in the main UI surfaces", () => {
    expect(I18N_SOURCE).toContain('name: "直播直传"');
    expect(I18N_SOURCE).toContain('streamUpload: "直播直传"');
    expect(I18N_SOURCE).toContain('zeroDisk: "直播直传（不写本地视频）"');
    expect(I18N_SOURCE).toContain('title: "直播直传节点"');
    expect(I18N_SOURCE).toContain('name: "Live direct upload"');
    expect(I18N_SOURCE).toContain('streamUpload: "Live direct upload"');
    expect(I18N_SOURCE).toContain('zeroDisk: "Live direct upload (no local video)"');
    expect(I18N_SOURCE).toContain('title: "Live direct upload node"');
  });

  it("does not expose the old zero-disk implementation wording in the UI dictionary", () => {
    expect(I18N_SOURCE).not.toContain("0 落盘");
    expect(I18N_SOURCE).not.toContain("0落盘");
    expect(I18N_SOURCE).not.toContain("Zero-disk streaming upload");
  });
});
