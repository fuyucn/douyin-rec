import { describe, expect, it } from "vitest";
import type { RoomDTO } from "../../packages/web/src/api/client.js";
import { nodeCaps } from "../../packages/web/src/lib/capabilities.js";
import { roomActionsFor, roomVisibilityFor, versionKeys } from "../../packages/web/src/lib/room-detail.js";

const room = (pipeline: object | null, danmu = 1): Pick<RoomDTO, "processing" | "recording"> => ({
  processing: pipeline === null ? null : ({ enabled: true, pipeline } as RoomDTO["processing"]),
  recording: { danmu } as RoomDTO["recording"],
});
const paused = (pipeline: object): Pick<RoomDTO, "processing" | "recording"> => ({
  processing: { enabled: false, pipeline } as RoomDTO["processing"],
  recording: { danmu: 1 } as RoomDTO["recording"],
});
const ALL = ["room.editor.original", "room.editor.danmuVer", "room.editor.livechatVer"];

describe("versionKeys", () => {
  it("no processing rule → original only", () => {
    expect(versionKeys(room(null))).toEqual(["room.editor.original"]);
  });
  it("paused rule → original only (same reading as the editor, #284)", () => {
    expect(versionKeys(paused({ upload: { mode: "upload" } }))).toEqual(["room.editor.original"]);
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

/** 受管 = 只读(plan §3.3):`managedBy === "hub"` 的房间在**任何角色**上都没有写操作。 */
describe("roomActionsFor — 受管即只读", () => {
  const writable = { readOnly: false, startStop: true, drain: true, edit: true, remove: true };
  const none = { readOnly: true, startStop: false, drain: false, edit: false, remove: false };

  it("master 上的普通房间:全开", () => {
    expect(roomActionsFor({ managed: false, caps: nodeCaps(true) })).toEqual(writable);
  });

  it("master 上的受管房间:全部收起(运行历史仍可看,但不出写操作)", () => {
    expect(roomActionsFor({ managed: true, caps: nodeCaps(true) })).toEqual(none);
  });

  it("worker 上的受管房间:只读", () => {
    expect(roomActionsFor({ managed: true, caps: nodeCaps(false) })).toEqual(none);
  });

  it("worker 上自己的非受管房间:启停/编辑照常 —— editPipeline=false 不是启停的闸门", () => {
    const caps = nodeCaps(false);
    expect(caps.editPipeline).toBe(false); // 没有 hub 编排能力
    const a = roomActionsFor({ managed: false, caps });
    expect(a.startStop).toBe(true); // …但仍然能停掉自己的录制
    expect(a.edit).toBe(true);
  });

  it("探测未完成(null)按 worker 保守:只是没有 master 面板,读写不变", () => {
    expect(roomActionsFor({ managed: false, caps: nodeCaps(null) })).toEqual(writable);
    expect(roomActionsFor({ managed: true, caps: nodeCaps(null) })).toEqual(none);
  });
});

/** 看见什么(plan §3.2):处理半边 / 节点 / 运行历史 / 手工合并 / 直传时间线都是 master 专有。 */
describe("roomVisibilityFor — 角色能看见什么", () => {
  it("master:处理半边与全部 hub 面板可见", () => {
    expect(roomVisibilityFor(nodeCaps(true))).toEqual({
      processing: true, nodes: true, runs: true, mergePanel: true, liveUpload: true,
    });
  });

  it("worker(以及探测未完成):一律不可见", () => {
    const hidden = { processing: false, nodes: false, runs: false, mergePanel: false, liveUpload: false };
    expect(roomVisibilityFor(nodeCaps(false))).toEqual(hidden);
    expect(roomVisibilityFor(nodeCaps(null))).toEqual(hidden);
  });
});
