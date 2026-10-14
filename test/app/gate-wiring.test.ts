/**
 * issue #96 接线守护:新一场开播闸门必须接在**每一条**起录路径上。
 * 行为已由 disk-gate / session / recorder / web-api 测试覆盖;这里只防「某处接线被删而其余测试仍全绿」。
 *  - task run(前台)→ buildSessionForTask 真实构造,检查会话持有闸门;
 *  - cli record(子进程)/ serve 手动启动 → 入口文件无法在 vitest 里运行(依赖真平台包),
 *    退而求其次做源码级断言(脆但能抓住误删)。
 */
import { readFileSync } from "node:fs";
import { describe, expect, it } from "vitest";
import { registerEngine, type DownloadEngine } from "@drec/core";
import { TaskStore } from "../../packages/app/src/store.js";
import { buildSessionForTask } from "../../packages/app/src/cli-task.js";

// vitest 不跑 providers-register,引擎表是空的;PollingRecorder 只用 engine.id,注册个桩即可。
registerEngine({ id: "ffmpeg" } as unknown as DownloadEngine);

const src = (p: string): string => readFileSync(new URL(`../../${p}`, import.meta.url), "utf-8");

describe("新一场开播闸门接线", () => {
  it("task run:buildSessionForTask 返回的会话持有闸门", () => {
    const store = new TaskStore(":memory:");
    const t = store.addTask({ room: "991" });
    const { session } = buildSessionForTask(t, store);
    expect(typeof (session as unknown as { admitNewBroadcast?: unknown }).admitNewBroadcast).toBe("function");
  });

  it("cli record:RecordingSession 构造处传入 admitNewBroadcast,且用 effectiveHubConfigPath", () => {
    const s = src("packages/cli/src/cli.ts");
    expect(s).toMatch(/new RecordingSession\([^)]*admitNewBroadcast/);
    expect(s).toContain("effectiveHubConfigPath()");
  });

  it("serve:手动启动准入用 makeManualStartAdmit,并在 --hub-config 为文件时导出路径给子进程", () => {
    const s = src("packages/app/src/serve.ts");
    expect(s).toMatch(/admitStart:\s*makeManualStartAdmit\(/);
    expect(s).toContain("DOUYIN_REC_HUB_CONFIG");
  });
});
