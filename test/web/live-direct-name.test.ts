import { describe, expect, it } from "vitest";
import { DICT } from "../../packages/web/src/lib/i18n";

describe("live direct upload naming", () => {
  it("uses the user-facing 直播直传 name in the main UI surfaces", () => {
    const zh = DICT.zh as unknown as Record<string, any>;
    const en = DICT.en as unknown as Record<string, any>;

    expect(zh.experimental.streamUpload.name).toBe("直播直传");
    expect(zh.dialog.streamUpload).toBe("直播直传");
    expect(zh.room.editor.zeroDisk).toContain("直播直传");
    expect(zh.room.zeroDisk.title).toBe("直播直传节点");
    expect(en.experimental.streamUpload.name).toBe("Live direct upload");
    expect(en.dialog.streamUpload).toBe("Live direct upload");
    expect(en.room.editor.zeroDisk).toContain("Live direct upload");
    expect(en.room.zeroDisk.title).toBe("Live direct upload node");
  });

  it("does not expose the old zero-disk implementation wording in the UI dictionary", () => {
    const zhText = JSON.stringify(DICT.zh);
    const enText = JSON.stringify(DICT.en);

    expect(zhText).not.toContain("0 落盘");
    expect(zhText).not.toContain("0落盘");
    expect(enText).not.toContain("Zero-disk");
  });
});
