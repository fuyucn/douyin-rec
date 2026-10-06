// packages/orchestrator/src/transport-ssh.test.ts
import { describe, it, expect, afterEach } from "vitest";
import { existsSync, rmSync, mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { SshTransport, buildRsyncArgs } from "./transport-ssh.js";
import { recordingStatusWorkerIds } from "./transport.js";

describe("recordingStatusWorkerIds", () => {
  const all = ["local", "vps2", "vps3"];
  it("只选被绑定源任务的规则选中的 worker", () => {
    expect([...recordingStatusWorkerIds(
      [{ workers: ["vps2"], recording: { sourceTaskId: 70 } }],
      all,
    )]).toEqual(["vps2"]);
  });
  it("未绑定 sourceTaskId 的规则不贡献任何 worker", () => {
    expect([...recordingStatusWorkerIds([{ workers: ["vps2", "vps3"] }], all)]).toEqual([]);
  });
  it("旧规则未写 workers → 视为选中全部(向后兼容)", () => {
    expect([...recordingStatusWorkerIds([{ recording: { sourceTaskId: 1 } }], all)].sort())
      .toEqual(["local", "vps2", "vps3"]);
  });
  it("多条规则取并集", () => {
    expect([...recordingStatusWorkerIds([
      { workers: ["vps2"], recording: { sourceTaskId: 70 } },
      { workers: ["local", "vps3"], recording: { sourceTaskId: 65 } },
    ], all)].sort()).toEqual(["local", "vps2", "vps3"]);
  });
  it("sourceTaskId=0 / null 不算绑定(0 不是有效 task id)", () => {
    expect([...recordingStatusWorkerIds([{ workers: ["vps2"], recording: { sourceTaskId: 0 } }], all)]).toEqual([]);
    expect([...recordingStatusWorkerIds([{ workers: ["vps2"], recording: { sourceTaskId: null } }], all)]).toEqual([]);
  });
});

describe("SshTransport", () => {
  describe("activeRecordingRooms", () => {
    const okOut = JSON.stringify({ rooms: [{ platform: "douyin", roomSlug: "123" }] });

    it("新 bundle:单次 _recording-status 即返回活动房间", async () => {
      const captured: string[][] = [];
      const t = new SshTransport({ id: "vps", host: "h", dataRoot: "/data/drec",
        run: async (argv) => { captured.push(argv); return okOut; }, rsync: async () => {} });
      await expect(t.activeRecordingRooms()).resolves.toEqual([{ platform: "douyin", roomSlug: "123" }]);
      expect(captured).toHaveLength(1);
      expect(captured[0].join(" ")).toContain("_recording-status");
    });

    it("旧 bundle(unknown command)→ 降级到 _tasks + _is-done", async () => {
      const calls: string[] = [];
      const t = new SshTransport({ id: "vps", host: "h", dataRoot: "/data/drec", rsync: async () => {},
        run: async (argv) => {
          const cmd = argv.join(" ");
          calls.push(cmd);
          if (cmd.includes("_recording-status")) throw new Error("ssh rc=1: error: unknown command '_recording-status'");
          if (cmd.includes("_tasks")) return JSON.stringify({ tasks: [
            { platform: "douyin", roomSlug: "111", enabled: true },
            { platform: "douyin", roomSlug: "222", enabled: true },
            { platform: "douyin", roomSlug: "333", enabled: false },
          ] });
          if (cmd.includes("'111'")) return "false\n";  // 仍在录
          if (cmd.includes("'222'")) return "true\n";   // 已收播
          return "true\n";
        } });
      // enabled=false 的 333 不该被查询
      await expect(t.activeRecordingRooms()).resolves.toEqual([{ platform: "douyin", roomSlug: "111" }]);
      expect(calls.some((c) => c.includes("'333'"))).toBe(false);
    });

    it("网络/ssh 故障必须抛出,不能被当成「不支持命令」而降级", async () => {
      const t = new SshTransport({ id: "vps", host: "h", dataRoot: "/data/drec",
        run: async () => { throw new Error("ssh 超时 8000ms 被杀"); }, rsync: async () => {} });
      await expect(t.activeRecordingRooms()).rejects.toThrow(/超时/);
    });

    it("非 Linux(/proc 不存在)→ 返回空数组而不是抛错", async () => {
      const t = new SshTransport({ id: "vps", host: "h", dataRoot: "/data/drec",
        run: async () => okOut, rsync: async () => {} });
      // worker 侧返回 {rooms:[]} 表示无活动录制
      const empty = new SshTransport({ id: "v", host: "h", dataRoot: "/d",
        run: async () => JSON.stringify({ rooms: [] }), rsync: async () => {} });
      await expect(empty.activeRecordingRooms()).resolves.toEqual([]);
    });
  });

  it("buildRsyncArgs:免交互 + 连接超时 + 心跳参数(防 auth 挂起/死连接占锁)", () => {
    const args = buildRsyncArgs("vps", "/data/rec/a.ts", "/stage/x");
    const sshOpts = args[args.indexOf("-e") + 1];
    expect(sshOpts).toContain("BatchMode=yes");
    expect(sshOpts).toContain("ConnectTimeout=10");
    expect(sshOpts).toContain("ServerAliveInterval=5");
    expect(args).toContain("--info=progress2");            // 进度输出 = 静默看门狗的心跳
    expect(args).toContain("vps:/data/rec/a.ts");
    expect(args).toContain("/stage/x");
  });

  it("listInventory 解析远端 JSON 输出", async () => {
    const fakeJson = JSON.stringify({ recordings: [
      { roomSlug: "411", sessionBase: "z_2026-06-27_07-54", tsFiles: ["a_000.ts"], xmlPath: "z.xml",
        durationSec: 3600, startMs: 1_700_000_000_000, endMs: 1_700_003_600_000, totalGapSec: 0 },
    ]});
    const t = new SshTransport({ id: "vps", host: "h", dataRoot: "~/drec",
      run: async () => fakeJson, rsync: async () => {} });
    const inv = await t.listInventory();
    expect(inv.workerId).toBe("vps");
    expect(inv.recordings[0].roomSlug).toBe("411");
    expect(inv.recordings[0].durationSec).toBe(3600);
  });

  it("listInventory 发送包含 _inventory 和 dataRoot 的命令", async () => {
    const capturedArgv: string[][] = [];
    const t = new SshTransport({
      id: "vps", host: "h", dataRoot: "/data/drec",
      run: async (argv) => { capturedArgv.push(argv); return JSON.stringify({ recordings: [] }); },
      rsync: async () => {},
    });
    await t.listInventory();
    expect(capturedArgv).toHaveLength(1);
    const cmdStr = capturedArgv[0].join(" ");
    expect(cmdStr).toContain("_inventory");
    expect(cmdStr).toContain("/data/drec");
  });

  it("listInventory 支持 remoteNode 覆盖", async () => {
    const capturedArgv: string[][] = [];
    const t = new SshTransport({
      id: "vps", host: "h", dataRoot: "/data/drec",
      remoteNode: "custom-node /opt/drec/douyin-rec.mjs",
      run: async (argv) => { capturedArgv.push(argv); return JSON.stringify({ recordings: [] }); },
      rsync: async () => {},
    });
    await t.listInventory();
    const cmdStr = capturedArgv[0].join(" ");
    expect(cmdStr).toContain("custom-node");
    expect(cmdStr).toContain("_inventory");
  });
  it("isDone：远端 _is-done 返回 true → 已收播", async () => {
    const t = new SshTransport({ id: "vps", host: "h", dataRoot: "~/drec",
      run: async () => "true", rsync: async () => {} });
    expect(await t.isDone("411")).toBe(true);
  });
  it("isDone：远端 _is-done 返回 false → 录制中", async () => {
    const t = new SshTransport({ id: "vps", host: "h", dataRoot: "~/drec",
      run: async () => "false", rsync: async () => {} });
    expect(await t.isDone("411")).toBe(false);
  });
  it("isDone：远端输出乱码/非数字 → false（未知状态，安全默认）", async () => {
    const t = new SshTransport({ id: "vps", host: "h", dataRoot: "~/drec",
      run: async () => "DONE", rsync: async () => {} });
    expect(await t.isDone("411")).toBe(false);
  });
  it("isDone：命令按房间查询 _is-done(不再全机数 ffmpeg)", async () => {
    const capturedArgv: string[][] = [];
    const t = new SshTransport({ id: "vps", host: "h", dataRoot: "/data/drec",
      run: async (argv) => { capturedArgv.push(argv); return "true"; }, rsync: async () => {} });
    await t.isDone("411");
    const cmdStr = capturedArgv[0].join(" ");
    expect(cmdStr).toContain("_is-done");
    expect(cmdStr).toContain("/data/drec");
    expect(cmdStr).toContain("411");
    expect(cmdStr).not.toContain("ffmpeg");
  });
  it("isDone：支持 remoteNode 覆盖", async () => {
    const capturedArgv: string[][] = [];
    const t = new SshTransport({ id: "vps", host: "h", dataRoot: "/data/drec",
      remoteNode: "custom-node /opt/drec/douyin-rec.mjs",
      run: async (argv) => { capturedArgv.push(argv); return "false"; }, rsync: async () => {} });
    await t.isDone("411");
    const cmdStr = capturedArgv[0].join(" ");
    expect(cmdStr).toContain("custom-node");
    expect(cmdStr).toContain("_is-done");
  });

  const made: string[] = [];
  afterEach(() => { for (const d of made.splice(0)) rmSync(d, { recursive: true, force: true }); });

  it("pull：先 mkdir localDir 再逐个 rsync(防 rsync 把不存在目标当文件名 → merge ENOTDIR)", async () => {
    const root = mkdtempSync(join(tmpdir(), "sshpull-")); made.push(root);
    const localDir = join(root, "stage", "douyin_x");   // 多级、不存在
    const calls: Array<[string, string]> = [];
    const t = new SshTransport({ id: "vps", host: "h", dataRoot: "~/drec",
      run: async () => "", rsync: async (remote, dir) => { calls.push([remote, dir]); } });
    await t.pull(["/r/a.ts", "/r/b.ts"], localDir);
    expect(existsSync(localDir)).toBe(true);             // 关键:目录先建出来
    expect(calls).toEqual([["/r/a.ts", localDir], ["/r/b.ts", localDir]]);
  });

  it("exists：远端全在→true,缺→false,空列表→true,ssh 抛错→false", async () => {
    const ok = new SshTransport({ id: "v", host: "h", dataRoot: "/d", run: async () => "OK\n", rsync: async () => {} });
    const miss = new SshTransport({ id: "v", host: "h", dataRoot: "/d", run: async () => "MISSING\n", rsync: async () => {} });
    const fail = new SshTransport({ id: "v", host: "h", dataRoot: "/d", run: async () => { throw new Error("x"); }, rsync: async () => {} });
    expect(await ok.exists(["/a", "/b"])).toBe(true);
    expect(await miss.exists(["/a"])).toBe(false);
    expect(await ok.exists([])).toBe(true);
    expect(await fail.exists(["/a"])).toBe(false);
  });

  describe("ping(轻量存活探针)", () => {
    it("远端 test -d 退出 0(run resolve)→ resolve;命令含 test -d + dataRoot", async () => {
      const captured: string[][] = [];
      const t = new SshTransport({ id: "vps", host: "h", dataRoot: "/data/drec",
        run: async (argv) => { captured.push(argv); return ""; }, rsync: async () => {} });
      await expect(t.ping()).resolves.toBeUndefined();
      const cmd = captured[0].join(" ");
      expect(cmd).toContain("test -d");
      expect(cmd).toContain("/data/drec");
    });
    it("远端非零退出(run reject)→ reject 带 message", async () => {
      const t = new SshTransport({ id: "vps", host: "h", dataRoot: "/data/drec",
        run: async () => { throw new Error("ssh rc=1: No such file"); }, rsync: async () => {} });
      await expect(t.ping()).rejects.toThrow(/rc=1|No such file/);
    });
    it("run 卡住 → pingTimeoutMs 硬超时 reject(不永久挂)", async () => {
      const t = new SshTransport({ id: "vps", host: "h", dataRoot: "/data/drec",
        pingTimeoutMs: 20,                       // 测试用小超时替代 6s
        run: () => new Promise<string>(() => {}),  // 永不 resolve
        rsync: async () => {} });
      await expect(t.ping()).rejects.toThrow(/超时|timeout/i);
    });
  });
});
