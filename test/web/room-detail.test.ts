import { describe, expect, it } from "vitest";
import type { RoomDTO } from "../../packages/web/src/api/client.js";
import { versionKeys } from "../../packages/web/src/lib/room-detail.js";

const proc = (pipeline: object): RoomDTO["processing"] => ({ enabled: true, pipeline } as RoomDTO["processing"]);

describe("versionKeys", () => {
  it("archive (or no rule) → original only, whatever the burn flags say", () => {
    expect(versionKeys(null)).toEqual(["room.editor.original"]);
    expect(versionKeys(proc({ upload: { mode: "stage" }, steps: { burnDanmu: true } }))).toEqual(["room.editor.original"]);
  });
  it("uploading: burn flags default on when unset; explicit false drops that version", () => {
    expect(versionKeys(proc({ upload: { mode: "upload" } }))).toEqual(["room.editor.original", "room.editor.danmuVer", "room.editor.livechatVer"]);
    expect(versionKeys(proc({ upload: { mode: "rolling" }, steps: { burnDanmu: false, burnLivechat: false } }))).toEqual(["room.editor.original"]);
  });
});
