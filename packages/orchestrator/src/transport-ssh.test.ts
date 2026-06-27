// packages/orchestrator/src/transport-ssh.test.ts
import { describe, it, expect } from "vitest";
import { SshTransport } from "./transport-ssh.js";

describe("SshTransport", () => {
  it("listInventory 解析远端 JSON 输出", async () => {
    const fakeJson = JSON.stringify({ recordings: [
      { roomSlug: "411", sessionBase: "z_2026-06-27_07-54", tsFiles: ["a_000.ts"], xmlPath: "z.xml",
        durationSec: 3600, startMs: 1_700_000_000_000, endMs: 1_700_003_600_000, totalGapSec: 0 },
    ]});
    const t = new SshTransport({ id: "vps", host: "h", dataRoot: "~/drec",
      run: async () => fakeJson, rsync: async () => {} });
    const inv = await t.listInventory();
    expect(inv.tenantId).toBe("vps");
    expect(inv.recordings[0].roomSlug).toBe("411");
    expect(inv.recordings[0].durationSec).toBe(3600);
  });
  it("isDone：远端 ffmpeg 计数为 0 → true（已收播）", async () => {
    const t = new SshTransport({ id: "vps", host: "h", dataRoot: "~/drec",
      run: async () => "0", rsync: async () => {} });
    expect(await t.isDone("411")).toBe(true);
  });
  it("isDone：远端 ffmpeg 计数 > 0 → false（录制中）", async () => {
    const t = new SshTransport({ id: "vps", host: "h", dataRoot: "~/drec",
      run: async () => "2", rsync: async () => {} });
    expect(await t.isDone("411")).toBe(false);
  });
  it("isDone：远端输出乱码/非数字 → false（未知状态，安全默认）", async () => {
    const t = new SshTransport({ id: "vps", host: "h", dataRoot: "~/drec",
      run: async () => "DONE", rsync: async () => {} });
    expect(await t.isDone("411")).toBe(false);
  });
});
