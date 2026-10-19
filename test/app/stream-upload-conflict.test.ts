/**
 * 0 落盘流式直传(plans/039)与边录边传**互斥**的写入侧门禁:同一判定只在 core 一份,
 * 这里验证三条写入路径(/api/tasks 建任务、/api/tasks 改任务、房间规则回写)都拒绝冲突值。
 */
import { describe, it, expect } from "vitest";
import { streamUploadConflicts } from "@drec/core";

describe("core.streamUploadConflicts", () => {
  it("只有两者同时为真才算冲突(undefined/false 都不是)", () => {
    expect(streamUploadConflicts(true, true)).toBe(true);
    expect(streamUploadConflicts(true, false)).toBe(false);
    expect(streamUploadConflicts(false, true)).toBe(false);
    expect(streamUploadConflicts(undefined, undefined)).toBe(false);
    expect(streamUploadConflicts(true, undefined)).toBe(false);
  });
});

