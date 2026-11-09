import { describe, it, expect } from "vitest";
import { taskPhase } from "../../packages/web/src/lib/task-status.js";

/**
 * 判定顺序的等价性快照:参考实现 = **重构后的既定顺序**（不是旧 StatusBadge 的原样转写）。
 *
 * issue #569 有意把「排空中」提到「停用」之前：排空按设计就是 enabled=false + 当前场仍在录，
 * 若仍按旧的「停用最优先」，用户点完「录完这场再停」只会看到「已停用」。其余顺序保持不变。
 * 本用例仍枚举全部输入组合，防止顺手把「节点离线」显示成「等待开播」这类静默错位。
 */
type In = Parameters<typeof taskPhase>[0];

/**
 * 参考实现:排空中(本机 status=draining / 远端 drainRequested + 节点在录)> 停用 > 收尾 > …
 * 比对的是**文案 key**（用户实际看到的那一句），而不是内部档位名。
 */
function referenceTextKey(t: In): string {
  const activeWorkers = (t.recordingWorkers ?? []).filter((w) => w.state === "recording");
  const downWorkers = (t.recordingWorkers ?? []).filter((w) => w.state === "unavailable");
  if (t.status === "draining") return "badge.draining";
  if (t.drainRequested === true && (activeWorkers.length > 0 || downWorkers.length > 0)) return "badge.draining";
  if (!t.enabled) return "badge.disabled";
  if (t.stopping) return "badge.stopping";
  if (activeWorkers.length) return "badge.recordingOn";
  if (t.recordingWorkers?.length) {
    return t.recordingWorkers.some((w) => w.state === "unavailable") ? "badge.workersUnavailable" : "badge.workersIdle";
  }
  if (t.running) return t.recording === false ? "badge.waiting" : "badge.recording";
  if (t.status === "error") return "badge.error";
  return "badge.idle";
}

describe("taskPhase 判定顺序快照（issue #569 后的既定顺序）", () => {
  it("枚举全部输入组合,逐一致(文案 key 必须与原实现完全相同)", () => {
    const workers = [
      undefined, [],
      [{ state: "recording" as const }],
      [{ state: "not_recording" as const }],
      [{ state: "unavailable" as const }],
      [{ state: "recording" as const }, { state: "unavailable" as const }],
      [{ state: "not_recording" as const }, { state: "unavailable" as const }],
    ];
    let checked = 0;
    const mismatches: string[] = [];
    for (const enabled of [true, false])
      for (const status of ["stopped", "running", "draining", "error"])
        for (const running of [true, false])
          for (const recording of [true, false, undefined])
            for (const stopping of [true, false])
              for (const drainRequested of [false, true])
                for (const ws of workers) {
                  const input = {
                    enabled, status, running, recording, stopping, drainRequested,
                    recordingWorkers: ws?.map((w, i) => ({ workerId: `w${i}`, workerName: `n${i}`, ...w })),
                  } as In;
                  const ref = referenceTextKey(input);
                  const got = taskPhase(input).textKey;
                  checked++;
                  if (got !== ref) {
                    mismatches.push(`${JSON.stringify({ ...input, recordingWorkers: ws })} → ref=${ref} got=${got}`);
                  }
                }
    expect(mismatches.slice(0, 5)).toEqual([]);
    expect(checked).toBe(1344);
  });
});
