/**
 * issue #474: the per-session file base must never contain `%`.
 *
 * mesio expands %u/%Y/%m/%d/%H/%M/%S/%i inside its `-n` template (verified on mesio 0.4.1: `x%dy_…_%i`
 * wrote `x04y_…_000.flv`), and ffmpeg's segment muxer expands %d-style patterns. An anchor name with
 * `%` therefore produced files the growth watchdog could never match (own bytes always 0 → a healthy
 * recording was killed at the next restart). The base is derived in exactly one place now.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { EventEmitter } from "node:events";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, join } from "node:path";
import {
  registerPlatform, sessionBaseOf, type DownloadEngine, type EngineSpawnArgs, type Platform, type PlatformStream, type RecorderEvents,
} from "@drec/core";
import { PollingRecorder } from "@drec/record-engine";
import { ownSegmentBytes } from "../../packages/record-engine/src/engines/mesio.js";

const pctPlatform: Platform = {
  id: "pcttest",
  matchUrl: (u) => /pct\.test\//.test(u),
  roomToUrl: (r) => `https://pct.test/${r}`,
  extractRoomSlug: (u) => u.replace(/^https?:\/\/pct\.test\//, ""),
  resolveShortUrl: async () => null,
  fetchAnchorName: async () => null,
  getStream: async (): Promise<PlatformStream> => ({ living: true, url: "https://stream.invalid/x.flv" }),
  getLiving: async () => true,
  defaultQuality: "origin",
  defaultEngine: "ffmpeg",
  qualities: ["origin"],
  engines: ["ffmpeg"],
};
registerPlatform(pctPlatform);

class FakeProc extends EventEmitter {
  pid = 4242;
  kill = (): boolean => true;
}

const ev = { onLive() {}, onSegment() {}, onOffline() {} } as unknown as RecorderEvents;
const flush = async (): Promise<void> => { await vi.advanceTimersByTimeAsync(0); };

let outDir: string;
let captured: EngineSpawnArgs | undefined;

beforeEach(() => {
  vi.useFakeTimers();
  outDir = mkdtempSync(join(tmpdir(), "pct-base-"));
  captured = undefined;
});
afterEach(() => {
  vi.useRealTimers();
  rmSync(outDir, { recursive: true, force: true });
});

const fakeEngine: DownloadEngine = {
  id: "fake-pct",
  spawn: (a) => {
    captured = a;
    return { proc: new FakeProc() as never, sessionFirstPath: join(a.dir, `${a.nameBase}_000.flv`), cleanup: () => {} };
  },
};

describe("会话文件基名不含 %(issue #474)", () => {
  it("anchor 带 %d/%Y → nameBase 无 %;看门狗匹配 mesio 实际写出的分段;视频/xml 基名一致", async () => {
    const r = new PollingRecorder(fakeEngine);
    await r.start("https://pct.test/1", { quality: "origin", outDir, segmentSec: 0, name: "主播%d_%Y" } as never, ev);
    await flush();

    expect(captured).toBeDefined();
    const a = captured!;
    expect(a.nameBase).not.toContain("%");
    expect(a.nameBase.startsWith("主播_d__Y_")).toBe(true); // % → _ : `%d`→`_d`, `%Y`→`_Y`

    // With no % left, the engines' template expansion is the identity: these ARE the names they write.
    const own0 = join(a.dir, `${a.nameBase}_000.flv`);
    writeFileSync(own0, Buffer.alloc(120));
    writeFileSync(join(a.dir, "neighbour_000.flv"), Buffer.alloc(999)); // another session, same directory
    expect(ownSegmentBytes(a.dir, a.nameBase)).toBe(120);
    writeFileSync(join(a.dir, `${a.nameBase}_001.flv`), Buffer.alloc(80)); // rolled segment
    expect(ownSegmentBytes(a.dir, a.nameBase)).toBe(200);

    // Video, danmu xml and the session sidecar all hang off this one base.
    expect(sessionBaseOf(own0)).toBe(a.nameBase);
    expect(join(dirname(own0), `${sessionBaseOf(own0)}.xml`)).toBe(join(a.dir, `${a.nameBase}.xml`));
  });
});
