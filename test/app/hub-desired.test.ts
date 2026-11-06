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
      resolveCookies: () => null,
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
