import { EventEmitter } from "node:events";
import { afterEach, describe, expect, it, vi } from "vitest";
import type { ChildProcess } from "node:child_process";
import {
  USER_STOP,
  JobAbortedError,
  _resetJobAbort,
  abortJob,
  beginJob,
  currentJobKey,
  endJob,
  isAborted,
  isJobAbort,
  isJobLive,
  registerChild,
  runWithJob,
  throwIfAborted,
} from "./job-abort.js";

function fakeChild(pid = 4242): ChildProcess & EventEmitter {
  const ee = new EventEmitter() as ChildProcess & EventEmitter;
  Object.assign(ee, {
    pid,
    killed: false,
    exitCode: null,
    signalCode: null,
    kill: vi.fn(function (_sig?: string) {
      return true;
    }),
  });
  return ee;
}

afterEach(() => {
  _resetJobAbort();
  vi.restoreAllMocks();
});

describe("job-abort", () => {
  it("abortJob 对非 live job 返回 false,不留下 aborted 痕迹", () => {
    expect(abortJob("missing")).toBe(false);
    expect(isAborted("missing")).toBe(false);
    expect(isJobLive("missing")).toBe(false);
  });

  it("begin + abort → true,仍 live,throwIfAborted 抛用户停止", () => {
    beginJob("k");
    expect(abortJob("k")).toBe(true);
    expect(isJobLive("k")).toBe(true);
    expect(isAborted("k")).toBe(true);
    expect(() => throwIfAborted("k")).toThrow(JobAbortedError);
    expect(() => throwIfAborted("k")).toThrow(USER_STOP);
    endJob("k");
    expect(isJobLive("k")).toBe(false);
    expect(isAborted("k")).toBe(false);
  });

  it("registerChild 无 ALS 是 no-op(对账 ssh 不被误杀)", () => {
    beginJob("k");
    const child = fakeChild();
    registerChild(child);
    abortJob("k");
    expect(child.kill).not.toHaveBeenCalled();
    endJob("k");
  });

  it("ALS 内登记的子进程:abort 立刻 SIGTERM;abort 后再登记也立刻杀", async () => {
    const first = fakeChild(1001);
    const second = fakeChild(1002);
    await runWithJob("k", async () => {
      registerChild(first);
      expect(abortJob("k")).toBe(true);
      expect(first.kill).toHaveBeenCalledWith("SIGTERM");
      registerChild(second);
      expect(second.kill).toHaveBeenCalledWith("SIGTERM");
    });
    expect(isJobLive("k")).toBe(false);
  });

  it("processGroup:true 走 process.kill(-pid),是唯一负 pid 路径", async () => {
    const spy = vi.spyOn(process, "kill").mockImplementation(() => true);
    const child = fakeChild(3003);
    await runWithJob("k", async () => {
      registerChild(child, { processGroup: true });
      abortJob("k");
    });
    expect(spy).toHaveBeenCalledWith(-3003, "SIGTERM");
    expect(child.kill).not.toHaveBeenCalled();
  });

  it("runWithJob 设置 ALS,结束后清 live/aborted", async () => {
    expect(currentJobKey()).toBeUndefined();
    await runWithJob("room:1", async () => {
      expect(currentJobKey()).toBe("room:1");
      expect(isJobLive("room:1")).toBe(true);
    });
    expect(currentJobKey()).toBeUndefined();
    expect(isJobLive("room:1")).toBe(false);
  });

  it("isJobAbort 认 JobAbortedError 和同文案 Error", () => {
    expect(isJobAbort(new JobAbortedError())).toBe(true);
    expect(isJobAbort(new Error(USER_STOP))).toBe(true);
    expect(isJobAbort(new Error("boom"))).toBe(false);
    expect(isJobAbort("用户停止")).toBe(false);
  });
});
