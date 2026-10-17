import { describe, expect, it } from "vitest";
import type { RoomDTO } from "../../packages/web/src/api/client.js";
import { versionKeys } from "../../packages/web/src/lib/room-detail.js";

const room = (pipeline: object | null, danmu = 1): Pick<RoomDTO, "processing" | "recording"> => ({
  processing: pipeline === null ? null : ({ enabled: true, pipeline } as RoomDTO["processing"]),
  recording: { danmu } as RoomDTO["recording"],
});
const ALL = ["room.editor.original", "room.editor.danmuVer", "room.editor.livechatVer"];

describe("versionKeys", () => {
  it("no processing rule → original only", () => {
    expect(versionKeys(room(null))).toEqual(["room.editor.original"]);
  });
  it("burn flags default on in every delivery mode (stage burns too, same as the pipeline)", () => {
    expect(versionKeys(room({ upload: { mode: "stage" } }))).toEqual(ALL);
    expect(versionKeys(room({ upload: { mode: "upload" } }))).toEqual(ALL);
    expect(versionKeys(room({ upload: { mode: "rolling" } }))).toEqual(ALL);
  });
  it("explicit false drops that version; no danmu recorded → nothing to burn", () => {
    expect(versionKeys(room({ upload: { mode: "upload" }, steps: { burnLivechat: false } }))).toEqual(["room.editor.original", "room.editor.danmuVer"]);
    expect(versionKeys(room({ upload: { mode: "stage" } }, 0))).toEqual(["room.editor.original"]);
  });
});
