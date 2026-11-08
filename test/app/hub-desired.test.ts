import { describe, it, expect } from "vitest";
import { desiredSpecsForWorker } from "../../packages/app/src/hub-desired.js";
import { hubKey, type HubRule } from "../../packages/app/src/hub-store.js";
import type { Task } from "../../packages/app/src/store.js";

const room = (n: string): string => `https://live.douyin.com/${n}`;

describe("desiredSpecsForWorker — spool is pinned for legacy rows", () => {
  it("a historical streamUploadSpool=false source task still delivers spool=true", () => {
    const srcTask = {
      id: 1, room: room("222"), name: null, quality: "origin", engine: "ffmpeg", danmu: 1, segmentSec: 1800,
      scheduleStart: null, scheduleEnd: null, enabled: true, useCookie: true, cookies: null, outDir: null,
      webhook: null, anchorName: null, rollingUpload: false, rollingEffective: false,
      streamUpload: true, streamUploadSpool: false, outputFormat: "original",
    } as Task;
    const rule: HubRule = {
      key: hubKey("douyin", "222"), platform: "douyin", roomSlug: "222", room: room("222"),
      enabled: true, pipeline: {}, recording: { sourceTaskId: 1 }, workers: ["vps2"],
    };
    const ctx = {
      rules: [rule],
      getTask: (id: number) => (id === 1 ? srcTask : null),
      workers: [{ id: "vps2" }],
      allowsPush: () => false,
      blockedKey: (w: string, p: string, r: string) => `${w}|${p}|${r}`,
      delivery: {
        lastGood: () => undefined, remember: () => {}, staleWarned: () => undefined,
        setStale: () => {}, clearStale: () => {}, block: () => {},
      },
      warn: () => {},
    };
    const specs = desiredSpecsForWorker("vps2", ctx);
    expect(specs).toHaveLength(1);
    expect(specs[0].streamUpload).toBe(true);
    expect(specs[0].streamUploadSpool).toBe(true);
  });
});

describe("desiredSpecsForWorker — 登录态只发显式 override（issue #563）", () => {
  const srcTask = (over: Partial<Task> = {}): Task => ({
    id: 1, room: room("333"), name: null, quality: "origin", engine: "ffmpeg", danmu: 1, segmentSec: 1800,
    scheduleStart: null, scheduleEnd: null, enabled: true, useCookie: true, cookies: null, outDir: null,
    webhook: null, anchorName: null, rollingUpload: false, rollingEffective: false,
    streamUpload: false, streamUploadSpool: true, outputFormat: "original",
    ...over,
  } as Task);
  const ctxWith = (task: Task) => ({
    rules: [{
      key: hubKey("douyin", "333"), platform: "douyin", roomSlug: "333", room: room("333"),
      enabled: true, pipeline: {}, recording: { sourceTaskId: 1 }, workers: ["vps2"],
    } as HubRule],
    getTask: () => task,
    workers: [{ id: "vps2" }],
    allowsPush: () => false,
    blockedKey: (w: string, p: string, r: string) => `${w}|${p}|${r}`,
    delivery: {
      lastGood: () => undefined, remember: () => {}, staleWarned: () => undefined,
      setStale: () => {}, clearStale: () => {}, block: () => {},
    },
    warn: () => {},
  });

  it("源任务没有任务级串 → 下发 null（不把平台串钉进节点任务）", () => {
    const specs = desiredSpecsForWorker("vps2", ctxWith(srcTask()));
    expect(specs[0].cookies).toBeNull();
  });

  it("源任务只有空白 → 下发 null（不把空白串当 override）", () => {
    const specs = desiredSpecsForWorker("vps2", ctxWith(srcTask({ cookies: "   " })));
    expect(specs[0].cookies).toBeNull();
  });

  it("源任务有显式 override → 原样下发（trim）", () => {
    const specs = desiredSpecsForWorker("vps2", ctxWith(srcTask({ cookies: "  sessionid=OVERRIDE  " })));
    expect(specs[0].cookies).toBe("sessionid=OVERRIDE");
  });
});
