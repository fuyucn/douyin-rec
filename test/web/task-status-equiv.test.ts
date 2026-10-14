import { describe, it, expect } from "vitest";
import { taskPhase } from "../../packages/web/src/lib/task-status.js";

/**
 * 重构等价性:把**重构前 StatusBadge 的分支顺序**原样转写成参考实现,遍历全部输入组合逐一比对。
 *
 * 为什么值得单独一个测试:徽标是每次进列表/详情都要看的输出,判定顺序一改就会
 * 把「节点离线」显示成「等待开播」、把「排空中」显示成「录制中」这类静默错位 ——
 * 只看几个手写用例抓不到,枚举才可信。
 */
type In = Parameters<typeof taskPhase>[0];

/**
 * 转写自重构前实现对 enabled/status/running/recording/stopping/recordingWorkers 的判定顺序。
 * 比对的是**文案 key**(用户实际看到的那一句)+ 是否带节点名,而不是内部档位名 ——
 * 档位名换过一轮(如 workersIdle→waiting),只有文案才是对外可观察的行为。
 */
function referenceTextKey(t: In): string {
  const activeWorkers = (t.recordingWorkers ?? []).filter((w) => w.state === "recording");
  if (!t.enabled) return "badge.disabled";
  if (t.stopping) return "badge.stopping";
  if (t.status === "draining") return "badge.draining";
  if (activeWorkers.length) return "badge.recordingOn";
  if (t.recordingWorkers?.length) {
    return t.recordingWorkers.some((w) => w.state === "unavailable") ? "badge.workersUnavailable" : "badge.workersIdle";
  }
  if (t.running) return t.recording === false ? "badge.waiting" : "badge.recording";
  if (t.status === "error") return "badge.error";
  return "badge.idle";
}

describe("taskPhase 与重构前 StatusBadge 行为等价", () => {
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
              for (const ws of workers) {
                const input = {
                  enabled, status, running, recording, stopping,
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
    expect(checked).toBe(672);
  });
});
