/**
 * T9b 复审 BLOCKING-1:收尾转格式改写源分段 mtime → 清单(mtime 当分段结束时间)把已 done 的同一场聚成新簇 `_HHMM`
 * → 再跑一遍管线 + 重复上传。这里用**真实 mtime 驱动的清单适配器** + 真实 Reconciler / LocalTransport / convertSegmentInPlace 复现。
 */
import { afterEach, describe, expect, it, vi } from "vitest";
import { readFileSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { LocalTransport } from "@drec/orchestrator";
import { convertSegmentInPlace } from "@drec/processors";
import { Scenario } from "../e2e/harness/scenario.js";
import { pastStartMs } from "../e2e/harness/fake-recordings.js";

vi.mock("@drec/post-process", async (orig) => ({ ...(await orig<typeof import("@drec/post-process")>()), ffprobeDuration: async () => 60 }));

let s: Scenario;
afterEach(() => s?.dispose());

/** 与 cli.ts 生产适配器同口径:endMs = 文件 mtime,startMs = endMs − 时长。 */
const mtimeProbe = async (file: string): Promise<{ durationSec: number; startMs: number; endMs: number }> => {
  const { durationSec } = JSON.parse(readFileSync(file, "utf-8")) as { durationSec: number };
  const endMs = statSync(file).mtimeMs;
  return { durationSec, endMs, startMs: endMs - durationSec * 1000 };
};

describe("收尾转格式不得让已 done 的场次被当成新一场", () => {
  it("done 后把源分段转成 mkv,再 reconcileAll:无新 job / 新 streamKey,不再上传", async () => {
    s = await Scenario.create({
      cfg: { cleanup: { sourceAfterDone: false, stageAfterDone: true, stageSourceAfterMerge: true } },
      wrapTransport: (_b: LocalTransport, sc: Scenario) => new LocalTransport({ id: "local", recordingsDir: sc.recordingsDir, taskRooms: {}, ffprobe: mtimeProbe }),
    });
    const [sess] = s.record({ sessions: [{ startMs: pastStartMs(0, 10, 0), segments: 3, segSec: 600 }] });
    // 假录像的 mtime = 该段结束时刻(真实录制端的口径)
    sess.tsFiles.forEach((f, i) => { const t = new Date(pastStartMs(0, 10, 0) + (i + 1) * 600_000); utimesSync(f, t, t); });

    await s.reconcile();
    const key = s.onlyKey();
    expect(s.jobState(key)).toBe("done");
    const uploads = s.fake.calls.filter((c) => c.op === "upload").length;
    expect(uploads).toBe(1);

    // 收尾转换:真实 convertSegmentInPlace(假 ffmpeg / 假 ffprobe)
    for (const f of sess.tsFiles) {
      const r = await convertSegmentInPlace(f, "mkv", {
        remux: async (src, tmp) => { writeFileSync(tmp, readFileSync(src)); },
        probe: async (p) => { const d = (JSON.parse(readFileSync(p, "utf-8")) as { durationSec: number }).durationSec; return { durationSec: d, hasVideo: true, spanSec: d, packets: 100 }; },
        freeBytes: () => 1e12,
      });
      expect(r.ok).toBe(true);
    }
    expect(s.recordingFiles().filter((n) => n.endsWith(".mkv"))).toHaveLength(3);

    await s.reconcile();
    await s.reconcile();
    expect(s.keys(), "不得出现 `_HHMM` 新簇").toEqual([key]);
    expect(s.fake.calls.filter((c) => c.op === "upload"), "不得重复上传").toHaveLength(uploads);
  });
});
