import { describe, expect, it } from "vitest";
import { findCreatedRoom, findExistingRoom, newRoomRulePayload, newRoomTaskPayload, planNewRoomRule, type NewRoomForm } from "../../packages/web/src/lib/room-create.js";
import type { RoomDTO } from "../../packages/web/src/api/client.js";

const form: NewRoomForm = {
  room: " https://live.example.com/100001 ", name: " 主播A ", schedule: "20:00-02:00", quality: "origin",
  engine: "ffmpeg", danmu: true, useCookie: true, outputFormat: "mp4", uploadPrivate: true, workers: [],
};

describe("newRoomTaskPayload", () => {
  it("trims input and keeps recording fields", () => {
    expect(newRoomTaskPayload(form, "archive")).toMatchObject({
      room: "https://live.example.com/100001", name: "主播A", schedule: "20:00-02:00", quality: "origin", engine: "ffmpeg", danmu: 1,
    });
  });
  it("output format only travels in archive mode; blank name/schedule become null", () => {
    expect(newRoomTaskPayload(form, "archive").outputFormat).toBe("mp4");
    const upload = newRoomTaskPayload({ ...form, name: "  ", schedule: " " }, "upload");
    expect(upload.outputFormat).toBeUndefined();
    expect(upload.name).toBeNull();
    expect(upload.schedule).toBeNull();
  });
});

describe("newRoomRulePayload", () => {
  const base = { taskId: 7, danmu: true, uploadPrivate: false, workers: ["w-test-1"] };
  it("archive: stage mode, no upload meta, linked to the task", () => {
    const rule = newRoomRulePayload({ ...base, mode: "archive" });
    expect(rule.recording?.sourceTaskId).toBe(7);
    expect(rule.pipeline?.upload).toEqual({ mode: "stage" });
    expect(rule.pipeline?.steps?.burnDanmu).toBe(false);
    expect(rule.workers).toEqual(["w-test-1"]);
  });
  it("upload: upload mode + privacy; burn only recorded when danmu is on", () => {
    expect(newRoomRulePayload({ ...base, mode: "upload" }).pipeline?.upload).toMatchObject({ mode: "upload", private: false, tid: 21 });
    expect(newRoomRulePayload({ ...base, mode: "upload" }).pipeline?.steps?.burnDanmu).toBe(true);
    expect(newRoomRulePayload({ ...base, mode: "upload", danmu: false }).pipeline?.steps?.burnDanmu).toBe(false);
  });
  it("never enables cleanup that deletes the source or the stage copy", () => {
    const c = newRoomRulePayload({ ...base, mode: "upload" }).pipeline?.cleanup;
    expect(c).toEqual({ stageSourceAfterMerge: false, sourceAfterDone: false, stageAfterDone: false });
  });
});

describe("planNewRoomRule", () => {
  const base = { taskId: 7, mode: "archive" as const, danmu: false, uploadPrivate: true, workers: [] };

  it("no existing rule → create, and an empty node selection omits workers (= all nodes; backend rejects [])", () => {
    const plan = planNewRoomRule({ ...base, hasExistingRule: false });
    expect(plan.kind).toBe("create");
    if (plan.kind !== "create") throw new Error("unreachable");
    expect("workers" in plan.payload).toBe(false);
    const picked = planNewRoomRule({ ...base, workers: ["w-test-1"], hasExistingRule: false });
    if (picked.kind !== "create") throw new Error("unreachable");
    expect(picked.payload.workers).toEqual(["w-test-1"]);
  });

  it("existing rule → bind only, never rewrite upload mode / enabled / nodes", () => {
    const plan = planNewRoomRule({ ...base, mode: "upload", workers: ["w-test-1"], hasExistingRule: true });
    expect(plan).toEqual({ kind: "bindOnly", taskId: 7 });
  });
});

describe("room lookup around create", () => {
  const room = (key: string, room: string, taskId: number | null): RoomDTO => ({
    key, platform: key.split(".")[0]!, roomSlug: key.split(".")[1]!, room,
    recording: taskId === null ? null : ({ taskId } as RoomDTO["recording"]),
    processing: null,
  });
  const rooms = [
    room("douyin.100001", "https://live.douyin.com/100001", 3),
    room("douyin.100002", "https://live.douyin.com/100002", null),
  ];

  it("existing room with a task is a duplicate (bare id or full URL); rule-only room is not", () => {
    expect(findExistingRoom(rooms, "douyin", "100001")?.key).toBe("douyin.100001");
    expect(findExistingRoom(rooms, "douyin", "https://live.douyin.com/100001")?.key).toBe("douyin.100001");
    expect(findExistingRoom(rooms, "bilibili", "100001")).toBeUndefined();
    expect(findExistingRoom(rooms, "douyin", "100002")).toBeUndefined();
  });

  it("created room is matched by task id, never by URL text", () => {
    expect(findCreatedRoom(rooms, 3)?.key).toBe("douyin.100001");
    // Same URL but another task owns the view → no match, so the caller won't rebind that rule.
    expect(findCreatedRoom(rooms, 9)).toBeUndefined();
  });
});
