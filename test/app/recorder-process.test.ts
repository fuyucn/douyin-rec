import { describe, it, expect } from "vitest";
import { ChildRecorderProcess, type ExitInfo } from "../../packages/app/src/process/recorder-process.js";

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

describe("ChildRecorderProcess.stopGraceful (SIGUSR2)", () => {
  it("SIGUSR2 → 子进程优雅退出，标记 expected", async () => {
    // 子进程首行就注册 SIGUSR2 handler（收到 → 干净退出 0），然后挂起。
    const proc = new ChildRecorderProcess({
      taskId: 1,
      command: process.execPath,
      args: ["-e", "process.on('SIGUSR2',()=>process.exit(0));setInterval(()=>{},1e9);"],
    });
    let info: ExitInfo | null = null;
    proc.onExit((i) => { info = i; });
    proc.start();
    await wait(200);                  // 等子进程注册好 handler

    await proc.stopGraceful();
    expect(info).not.toBeNull();
    expect(info!.expected).toBe(true);     // 排空属于预期退出（非崩溃）
    expect(info!.code).toBe(0);            // handler 干净退出
  });

  it("stopGraceful 幂等：重复调用只退出一次", async () => {
    const proc = new ChildRecorderProcess({
      taskId: 2,
      command: process.execPath,
      args: ["-e", "process.on('SIGUSR2',()=>process.exit(0));setInterval(()=>{},1e9);"],
    });
    let exits = 0;
    proc.onExit(() => { exits++; });
    proc.start();
    await wait(200);

    await Promise.all([proc.stopGraceful(), proc.stopGraceful(), proc.stopGraceful()]);
    expect(exits).toBe(1);
  });
});
