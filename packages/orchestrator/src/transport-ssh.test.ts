// packages/orchestrator/src/transport-ssh.test.ts
import { describe, it, expect, afterEach, vi } from "vitest";
import { chmodSync, existsSync, rmSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { JobAbortedError, isJobAbort } from "@drec/core";
import { SshTransport, buildRsyncArgs } from "./transport-ssh.js";
import { ProcUnsupported, recordingStatusWorkerIds, type NodeRecording } from "./transport.js";
import { summarizeRsyncStderr } from "./transport-ssh.js";

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
  describe("recordingStatus(F1:在录房间 + 边录边传进度)", () => {
    const sess = { platform: "douyin", roomSlug: "123", sessionBase: "A_1", bv: "BV1X", confirmed: 2, total: 3, ambiguous: 0, recording: true };
    const mkT = (run: (argv: string[]) => Promise<string>) =>
      new SshTransport({ id: "vps", host: "h", dataRoot: "/data/drec", run, rsync: async () => {} });

    it("新 bundle:一次命令同时拿到 rooms 与 rolling", async () => {
      const calls: string[] = [];
      const t = mkT(async (argv) => { calls.push(argv.join(" ")); return JSON.stringify({ rooms: [{ platform: "douyin", roomSlug: "123" }], rolling: [sess] }); });
      await expect(t.recordingStatus()).resolves.toEqual({ rooms: [{ platform: "douyin", roomSlug: "123" }], rolling: [sess] });
      expect(calls).toHaveLength(1);
    });

    it("lockedBytes:合法数字原样透传;脏值(负数/NaN/字符串)丢字段、条目保留", async () => {
      const good = { ...sess, lockedBytes: 1234 };
      const t = mkT(async () => JSON.stringify({ rooms: [], rolling: [good, { ...sess, sessionBase: "B", lockedBytes: -5 }, { ...sess, sessionBase: "C", lockedBytes: "9" }] }));
      const r = (await t.recordingStatus()).rolling;
      expect(r[0]!.lockedBytes).toBe(1234);
      expect(r).toHaveLength(3);
      expect(r[1]!.lockedBytes).toBeUndefined();
      expect(r[2]!.lockedBytes).toBeUndefined();
    });

    it("旧 bundle(只有 rooms)→ rolling=[],不报错", async () => {
      const t = mkT(async () => JSON.stringify({ rooms: [{ platform: "douyin", roomSlug: "123" }] }));
      await expect(t.recordingStatus()).resolves.toEqual({ rooms: [{ platform: "douyin", roomSlug: "123" }], rolling: [] });
    });

    it("rolling 里形状不合法的条目被丢弃(不让脏数据进 UI)", async () => {
      const noCounts = { platform: "douyin", roomSlug: "1", sessionBase: "s" };           // 缺 confirmed / total
      const noBase = { platform: "douyin", roomSlug: "1", confirmed: 1, total: 2 };       // 缺 sessionBase
      const t = mkT(async () => JSON.stringify({ rooms: [], rolling: [sess, { platform: "douyin" }, noCounts, noBase, null, "x"] }));
      expect((await t.recordingStatus()).rolling).toEqual([sess]);
    });

    it("网络类错误照常抛(不被当成「不支持」吞掉)", async () => {
      let n = 0;
      const t = mkT(async () => { n++; throw new Error("ssh 超时 8000ms 被杀"); });
      await expect(t.recordingStatus()).rejects.toThrow(/超时/);
      expect(n).toBe(1); // 不得再走降级回退路径(否则一次抖动会多打一轮 ssh,且可能掩盖原错误)
    });

    it("命令不存在 → 降级到 activeRecordingRooms 回退路径,rolling=[]", async () => {
      const t = mkT(async (argv) => {
        const cmd = argv.join(" ");
        if (cmd.includes("_recording-status")) throw new Error("error: unknown command '_recording-status'");
        if (cmd.includes("_tasks")) return JSON.stringify({ tasks: [] });
        return "true";
      });
      await expect(t.recordingStatus()).resolves.toEqual({ rooms: [], rolling: [] });
    });
  });

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

  it("summarizeRsyncStderr:丢弃进度行,保留真正的错误(T-19:失败要能看到原因)", () => {
    // 典型:进度行 + 真错误混在 stderr 里。
    const raw =
      "  1,234,567  45%  1.23MB/s    0:00:12 (xfr#3, to-chk=10/20)\n" +
      "rsync: [sender] change_dir \"/data/rec\" failed: No such file or directory (2)\n" +
      "rsync error: some files/attrs were not transferred (see previous errors) (code 23)\n";
    const s = summarizeRsyncStderr(raw);
    expect(s).not.toContain("%");                       // 进度行被丢弃
    expect(s).toContain("No such file or directory");   // 真错误保留
    expect(s).toContain("code 23");
  });

  it("summarizeRsyncStderr:只剩进度行 → 空串(不输出噪声)", () => {
    const raw = "  1,000  10%  0.5MB/s  0:00:01\n  2,000  20%  0.6MB/s  0:00:02\nxfr#4\n";
    expect(summarizeRsyncStderr(raw)).toBe("");
  });

  it("summarizeRsyncStderr:只保留最后 3 行并限长(防长输出灌爆错误消息)", () => {
    const raw = Array.from({ length: 10 }, (_, i) => `err line ${i}`).join("\n");
    const s = summarizeRsyncStderr(raw);
    expect(s).toContain("err line 9");
    expect(s).not.toContain("err line 6");   // 只留最后 3 行
    expect(s.length).toBeLessThanOrEqual(400);
  });

  it("pull:rsync 失败时错误消息带上 stderr 尾部(T-19:不再只报退出码)", async () => {
    // 注入的 rsync 直接抛带 stderr 的错误(模拟真实失败路径),断言 pull 不吞掉该信息。
    const t = new SshTransport({ id: "vps", host: "h", dataRoot: "~/drec",
      run: async () => "{}",
      rsync: async () => { throw new Error(`rsync rc=12: rsync: command not found(vps:/x)`); } });
    const dir = mkdtempSync(join(tmpdir(), "rsync-err-"));
    await expect(t.pull(["a.ts"], dir)).rejects.toThrow(/command not found/);
    rmSync(dir, { recursive: true, force: true });
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

  describe("listInventory unclaimed fields (#225)", () => {
    const recordings = [
      { roomSlug: "411", sessionBase: "z_2026-06-27_07-54", tsFiles: ["a_000.ts"], xmlPath: "z.xml",
        durationSec: 3600, startMs: 1_700_000_000_000, endMs: 1_700_003_600_000, totalGapSec: 0 },
    ];
    const seg = {
      path: "/d/recordings/A/A_2026-06-27_10-00-00_000.mp4", sizeBytes: 10, mtimeMs: 1_700_000_000_000,
      sessionBase: "A_2026-06-27_10-00-00", segmentIndex: 0, stampMs: 1_700_000_000_000, stampSource: "filename",
      sidecar: "missing", platform: null, roomSlug: null, segmentSec: 1800,
    };
    const mkInv = (payload: unknown) => new SshTransport({ id: "vps", host: "h", dataRoot: "/d",
      run: async () => JSON.stringify(payload), rsync: async () => {} }).listInventory();

    it("new worker output → recordings plus validated unclaimed fields", async () => {
      const inv = await mkInv({ recordings, unclaimedSegments: [seg], unclaimedTruncated: 3 });
      expect(inv).toEqual({ workerId: "vps", recordings, unclaimedSegments: [seg], unclaimedTruncated: 3 });
    });

    it("old master parse shape still yields identical recordings from new output", () => {
      const out = JSON.stringify({ recordings, unclaimedSegments: [seg], unclaimedTruncated: 0 });
      expect((JSON.parse(out) as { recordings: NodeRecording[] }).recordings).toEqual(recordings);
    });

    it("old worker output (recordings only) → no unclaimed keys (unknown)", async () => {
      const inv = await mkInv({ recordings });
      expect(inv).toEqual({ workerId: "vps", recordings });
      expect(inv).not.toHaveProperty("unclaimedSegments");
      expect(inv).not.toHaveProperty("unclaimedTruncated");
    });

    it("[] is reported as none, not unknown", async () => {
      const inv = await mkInv({ recordings, unclaimedSegments: [], unclaimedTruncated: 0 });
      expect(inv.unclaimedSegments).toEqual([]);
      expect(inv.unclaimedTruncated).toBe(0);
    });

    const malformed: Array<[string, unknown]> = [
      ["entry missing path", { recordings, unclaimedSegments: [{ ...seg, path: undefined }], unclaimedTruncated: 0 }],
      ["entry with bad sidecar shape", { recordings, unclaimedSegments: [seg, { ...seg, sidecar: "weird" }], unclaimedTruncated: 0 }],
      ["entry with string segmentSec", { recordings, unclaimedSegments: [{ ...seg, segmentSec: "1800" }], unclaimedTruncated: 0 }],
      ["null entry", { recordings, unclaimedSegments: [null], unclaimedTruncated: 0 }],
      ["missing truncated", { recordings, unclaimedSegments: [seg] }],
      ["negative truncated", { recordings, unclaimedSegments: [seg], unclaimedTruncated: -1 }],
      ["fractional truncated", { recordings, unclaimedSegments: [seg], unclaimedTruncated: 1.5 }],
      ["non-array segments", { recordings, unclaimedSegments: { 0: seg }, unclaimedTruncated: 0 }],
    ];
    for (const [name, payload] of malformed) {
      it(`malformed (${name}) → no unclaimed keys, recordings intact`, async () => {
        const inv = await mkInv(payload);
        expect(inv.recordings).toEqual(recordings);
        expect(inv).not.toHaveProperty("unclaimedSegments");
        expect(inv).not.toHaveProperty("unclaimedTruncated");
      });
    }
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

  // Contract (issue #146): false means the node answered MISSING; ssh failure / timeout / unparsable
  // output must THROW. Reading a dropped link as "the file was deleted" escalates healthy sessions.
  it("exists：远端全在→true,缺→false,空列表→true", async () => {
    const ok = new SshTransport({ id: "v", host: "h", dataRoot: "/d", run: async () => "OK\n", rsync: async () => {} });
    const miss = new SshTransport({ id: "v", host: "h", dataRoot: "/d", run: async () => "MISSING\n", rsync: async () => {} });
    expect(await ok.exists(["/a", "/b"])).toBe(true);
    expect(await miss.exists(["/a"])).toBe(false);
    expect(await ok.exists([])).toBe(true);
  });

  it("exists: ssh error (unreachable) throws instead of returning false", async () => {
    const fail = new SshTransport({ id: "v", host: "h", dataRoot: "/d", run: async () => { throw new Error("ssh rc=255"); }, rsync: async () => {} });
    await expect(fail.exists(["/a"])).rejects.toThrow(/ssh rc=255/);
  });

  it("exists: unparsable output (empty / banner noise) throws instead of returning false", async () => {
    const empty = new SshTransport({ id: "v", host: "h", dataRoot: "/d", run: async () => "\n", rsync: async () => {} });
    const banner = new SshTransport({ id: "v", host: "h", dataRoot: "/d", run: async () => "Welcome to Ubuntu!\n", rsync: async () => {} });
    await expect(empty.exists(["/a"])).rejects.toThrow(/无法解析/);
    await expect(banner.exists(["/a"])).rejects.toThrow(/无法解析/);
  });

  it("exists: parses only the last non-empty line, so a banner containing MISSING/OK cannot flip the verdict", async () => {
    const bannerMissing = new SshTransport({ id: "v", host: "h", dataRoot: "/d", run: async () => "MISSING\nOK\n", rsync: async () => {} });
    const bannerOk = new SshTransport({ id: "v", host: "h", dataRoot: "/d", run: async () => "OK\nMISSING\n", rsync: async () => {} });
    expect(await bannerMissing.exists(["/a"])).toBe(true);   // last line wins: OK
    expect(await bannerOk.exists(["/a"])).toBe(false);       // last line wins: MISSING
  });

  it("exists: trims CRLF and trailing spaces; ignores blank lines", async () => {
    const crlf = new SshTransport({ id: "v", host: "h", dataRoot: "/d", run: async () => "banner\r\n\r\n OK \r\n", rsync: async () => {} });
    const missing = new SshTransport({ id: "v", host: "h", dataRoot: "/d", run: async () => "\r\n MISSING \t\n\n", rsync: async () => {} });
    expect(await crlf.exists(["/a"])).toBe(true);
    expect(await missing.exists(["/a"])).toBe(false);
  });

  it("exists: all-whitespace or unknown trailing text is not a verdict", async () => {
    const blank = new SshTransport({ id: "v", host: "h", dataRoot: "/d", run: async () => " \r\n\t\n", rsync: async () => {} });
    const unknown = new SshTransport({ id: "v", host: "h", dataRoot: "/d", run: async () => "OK\nplease retry\n", rsync: async () => {} });
    await expect(blank.exists(["/a"])).rejects.toThrow(/无法解析/);
    await expect(unknown.exists(["/a"])).rejects.toThrow(/无法解析/);
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

/**
 * issue #2 A2:master 主动终止节点执行体 + started 回读白名单。
 *
 * 钉死两条:① `abortNodePipeline` 把 `_node-abort <dataRoot> <streamKey>` 发到节点并按 JSON 解析
 * `aborted`,任何异常(旧 bundle unknown command / 不可达 / 超时)一律降级 `{ aborted:false }`
 * **绝不抛** —— 它在失败收口路径上,异常只会掩盖原始错误;② ssh 回读 `nodeResult` 接受新增的
 * `started` phase(与 app 侧共用 core 的归一白名单,杜绝两处漂移把 started 当 null 吞掉)。
 */
describe("SshTransport.abortNodePipeline / nodeResult(started)", () => {
  it("abortNodePipeline 发 _node-abort + streamKey,解析 aborted=true", async () => {
    const captured: string[][] = [];
    const t = new SshTransport({ id: "vps", host: "h", dataRoot: "/data/drec",
      run: async (argv) => { captured.push(argv); return JSON.stringify({ aborted: true, killed: [4242], detail: "已终止" }); },
      rsync: async () => {} });
    await expect(t.abortNodePipeline!("douyin:123:2026-10-12")).resolves.toMatchObject({ aborted: true });
    const cmd = captured[0].join(" ");
    expect(cmd).toContain("_node-abort");
    expect(cmd).toContain("/data/drec");
    expect(cmd).toContain("'douyin:123:2026-10-12'");
  });

  it("旧 bundle(unknown command)→ aborted=false + 旧版本说明,**不抛**", async () => {
    const t = new SshTransport({ id: "vps", host: "h", dataRoot: "/data/drec", rsync: async () => {},
      run: async () => { throw new Error("ssh rc=1: error: unknown command '_node-abort'"); } });
    const r = await t.abortNodePipeline!("douyin:1:2");
    expect(r.aborted).toBe(false);
    expect(r.detail).toContain("旧版本");
  });

  it("网络/超时 → aborted=false + 不可达说明,不抛(掩盖原始错误更糟)", async () => {
    const t = new SshTransport({ id: "vps", host: "h", dataRoot: "/data/drec", rsync: async () => {},
      run: async () => { throw new Error("ssh 超时 8000ms 被杀"); } });
    const r = await t.abortNodePipeline!("douyin:1:2");
    expect(r.aborted).toBe(false);
    expect(r.detail).toContain("不可达");
  });

  it("nodeResult 接受 started(白名单与 app 共用 core 归一,不再各写一份)", async () => {
    const t = new SshTransport({ id: "vps", host: "h", dataRoot: "/data/drec", rsync: async () => {},
      run: async () => JSON.stringify({ phase: "started", ok: false, atMs: 1 }) });
    const r = await t.nodeResult!("douyin:1:2");
    expect(r).not.toBeNull();
    expect(r?.phase).toBe("started");
  });
});

describe("nodePipeline 按调用传入的超时(issue #25 ①,真实 spawn,PATH 上放假 ssh)", () => {
  const savedPath = process.env.PATH;
  afterEach(() => { process.env.PATH = savedPath; });
  const withFakeSsh = (sleepSec: number): void => {
    const bin = mkdtempSync(join(tmpdir(), "fake-ssh-"));
    writeFileSync(join(bin, "ssh"), `#!/bin/sh\nsleep ${sleepSec}\necho '{"ok":true,"bv":"BV1FAKE"}'\n`);
    chmodSync(join(bin, "ssh"), 0o755);
    process.env.PATH = `${bin}:${savedPath}`;
  };
  const spec = { streamKey: "k" } as never;
  const mk = () => new SshTransport({ id: "vps", host: "h", dataRoot: "/data/drec", rsync: async () => {} });

  it("传入的 timeoutMs 生效:远端比预算慢 → 按该预算被杀(而不是默认 30 分钟)", async () => {
    withFakeSsh(5);
    await expect(mk().nodePipeline(spec, { timeoutMs: 150 })).rejects.toThrow(/ssh 超时 150ms/);
  });

  it("预算足够 → 正常返回 BV;不传 opts → 仍走默认通道", async () => {
    withFakeSsh(0);
    expect((await mk().nodePipeline(spec, { timeoutMs: 5000 })).bv).toBe("BV1FAKE");
    expect((await mk().nodePipeline(spec)).bv).toBe("BV1FAKE");
  });
});

describe("SshTransport.taskLogs(F3:master 代查节点日志)", () => {
  const mkT = (run: (argv: string[]) => Promise<string>) =>
    new SshTransport({ id: "vps", host: "h", dataRoot: "/data/drec", run, rsync: async () => {} });

  it("透传行数并原样返回行;带 error 时也返回(不当失败抛错)", async () => {
    const calls: string[] = [];
    const t = mkT(async (argv) => { calls.push(argv.join(" ")); return JSON.stringify({ lines: ["x", "y"] }); });
    await expect(t.taskLogs(7, 200)).resolves.toEqual({ lines: ["x", "y"] });
    expect(calls[0]).toContain("_task-logs /data/drec 7 200");

    const t2 = mkT(async () => JSON.stringify({ lines: [], error: "serve 未起" }));
    await expect(t2.taskLogs(7, 50)).resolves.toEqual({ lines: [], error: "serve 未起" });
  });

  it("脏数据清洗:非字符串行丢弃、非字符串 error 忽略", async () => {
    const t = mkT(async () => JSON.stringify({ lines: ["ok", 1, null, "ok2"], error: 42 }));
    await expect(t.taskLogs(1, 10)).resolves.toEqual({ lines: ["ok", "ok2"] });
    const t2 = mkT(async () => JSON.stringify({ lines: "not-an-array" }));
    await expect(t2.taskLogs(1, 10)).resolves.toEqual({ lines: [] });
  });
});

describe("SshTransport.recoverOrder / procCancel", () => {
  const mkT = (run: (argv: string[]) => Promise<string>) =>
    new SshTransport({ id: "vps", host: "h", dataRoot: "/data/drec", run, rsync: async () => {} });
  const plan = { ok: true, orderKey: "o1", fromGeneration: 1, newGeneration: 2, jobs: [], notes: [] };

  it("sends a base64 request to _recover-order and returns the parsed result", async () => {
    const calls: string[] = [];
    const t = mkT(async (argv) => { calls.push(argv.join(" ")); return JSON.stringify({ plan, applied: false }); });
    const req = { orderKey: "o1", mode: "prep" as const };
    await expect(t.recoverOrder(req)).resolves.toEqual({ plan, applied: false });
    const b64 = calls[0]!.split(" ").pop()!;
    expect(calls[0]).toContain("_recover-order /data/drec");
    expect(JSON.parse(Buffer.from(b64, "base64").toString("utf8"))).toEqual(req);
  });

  it("maps an unknown-command failure to ProcUnsupported", async () => {
    const t = mkT(async () => { throw new Error("error: unknown command '_recover-order'"); });
    await expect(t.recoverOrder({ orderKey: "o1", mode: "prep" })).rejects.toBeInstanceOf(ProcUnsupported);
  });

  it("surfaces node-reported errors and rejects malformed payloads", async () => {
    await expect(mkT(async () => JSON.stringify({ error: "boom" })).recoverOrder({ orderKey: "o1", mode: "prep" })).rejects.toThrow(/boom/);
    await expect(mkT(async () => JSON.stringify({ nope: 1 })).recoverOrder({ orderKey: "o1", mode: "prep" })).rejects.toThrow(/invalid/);
  });

  it("procCancel maps unknown command to ProcUnsupported and returns receipts otherwise", async () => {
    const receipts = [{ jobId: "j1", state: "cancelled" }];
    await expect(mkT(async () => JSON.stringify({ receipts })).procCancel(["j1"])).resolves.toEqual(receipts);
    const old = mkT(async () => { throw new Error("error: unknown command '_proc-cancel'"); });
    await expect(old.procCancel(["j1"])).rejects.toBeInstanceOf(ProcUnsupported);
  });
});

describe("SshTransport.zeroDiskReport / nodeCapabilities.zeroDisk (issue #331)", () => {
  const mkT = (run: (argv: string[]) => Promise<string>) =>
    new SshTransport({ id: "vps", host: "h", dataRoot: "/data/drec", run, rsync: async () => {} });
  const receipt = { v: 1, id: "douyin:1:5", platform: "douyin", roomSlug: "1", streamKey: "douyin:1:2026-10-20", bvid: "BVfake1", parts: 2, atMs: 5 };

  it("calls the hidden read-only command with the node data root and parses the report", async () => {
    const calls: string[] = [];
    const t = mkT(async (argv) => { calls.push(argv.join(" ")); return JSON.stringify({ v: 1, receipts: [receipt, { junk: true }], status: [] }); });
    const r = await t.zeroDiskReport();
    expect(calls[0]).toContain("_zero-disk-report /data/drec");
    expect(r?.receipts).toEqual([receipt]);
  });
  it("an old bundle (unknown command) means unsupported (null), not a failure", async () => {
    const old = mkT(async () => { throw new Error("ssh rc=1: error: unknown command '_zero-disk-report'"); });
    await expect(old.zeroDiskReport()).resolves.toBeNull();
  });
  it("an unreachable node / bad output throws, so the caller marks it offline instead of 'no receipts'", async () => {
    await expect(mkT(async () => { throw new Error("ssh rc=255"); }).zeroDiskReport()).rejects.toThrow("255");
    await expect(mkT(async () => JSON.stringify({ error: "disk" })).zeroDiskReport()).rejects.toThrow("disk");
    await expect(mkT(async () => JSON.stringify({ nope: 1 })).zeroDiskReport()).rejects.toThrow("unrecognized");
  });
  it("_node-capabilities: zeroDisk is true only when the node says so (old bundles omit it)", async () => {
    const caps = (extra: object) => mkT(async () => JSON.stringify({ biliup: true, cookies: true, diskFreeGB: 5, ...extra })).nodeCapabilities();
    expect((await caps({ zeroDisk: true })).zeroDisk).toBe(true);
    expect((await caps({})).zeroDisk).toBe(false);
    expect((await caps({ zeroDisk: "yes" })).zeroDisk).toBe(false);
  });
});

describe("SshTransport.cleanup(失败不再吞,issue #429)", () => {
  const mkT = (run: (argv: string[]) => Promise<string>) =>
    new SshTransport({ id: "vps", host: "h", dataRoot: "/data/drec", run, rsync: async () => {} });

  it("成功:单条 rm -f 命令,resolve(成功路径行为不变)", async () => {
    const calls: string[] = [];
    const t = mkT(async (argv) => { calls.push(argv.join(" ")); return ""; });
    await expect(t.cleanup(["/r/a.ts", "/r/b.ts"])).resolves.toBeUndefined();
    expect(calls).toEqual(["rm -f '/r/a.ts' '/r/b.ts'"]);
  });

  it("路径含空格 / 撇号 / $:rm 与探测命令都按单引号转义(断言命令字符串)", async () => {
    const calls: string[] = [];
    const t = mkT(async (argv) => {
      calls.push(argv.join(" "));
      if (argv[0]!.startsWith("rm ")) throw new Error("ssh rc=1");
      return "2\n";
    });
    const weird = ["/r/a b.ts", "/r/it's.ts", "/r/$HOME`x`.ts"];
    await expect(t.cleanup(weird)).rejects.toThrow(/2\/3 个路径未删/);
    expect(calls[0]).toBe("rm -f '/r/a b.ts' '/r/it'\\''s.ts' '/r/$HOME`x`.ts'");
    expect(calls[1]).toBe(
      "n=0; test -e '/r/a b.ts' && n=$((n+1)); test -e '/r/it'\\''s.ts' && n=$((n+1)); test -e '/r/$HOME`x`.ts' && n=$((n+1)); echo $n",
    );
  });

  it("空清单不发命令", async () => {
    let n = 0;
    const t = mkT(async () => { n++; return ""; });
    await expect(t.cleanup([])).resolves.toBeUndefined();
    expect(n).toBe(0);
  });

  it("rm 非 0 / ssh 失败 → 抛错(含失败路径数,不吞)", async () => {
    const t = mkT(async (argv) => {
      if (argv[0]!.startsWith("rm ")) throw new Error("ssh rc=1: rm: cannot remove: Permission denied");
      return "";
    });
    await expect(t.cleanup(["/r/a.ts", "/r/b.ts"])).rejects
      .toThrow(/远端清理失败.*2\/2 个路径未删.*Permission denied/);
  });

  it("rm 失败后只读探测仍存活的路径数(1/2)", async () => {
    const t = mkT(async (argv) => {
      const cmd = argv[0]!;
      if (cmd.startsWith("rm ")) throw new Error("ssh rc=1");
      if (cmd.startsWith("n=0")) return "1\n"; // 探测:2 个里还剩 1 个
      return "";
    });
    await expect(t.cleanup(["/r/a.ts", "/r/b.ts"])).rejects
      .toThrow(/远端清理失败: 1\/2 个路径未删/);
  });

  it("rm 抛 abort(用户停止)→ 原样上抛(仍满足 isJobAbort),不探测、不包装", async () => {
    const calls: string[] = [];
    const t = mkT(async (argv) => { calls.push(argv[0]!); throw new JobAbortedError(); });
    const e = await t.cleanup(["/r/a.ts"]).then(() => null, (x: unknown) => x);
    expect(isJobAbort(e)).toBe(true);
    expect(calls).toEqual(["rm -f '/r/a.ts'"]);
  });

  it("rm 报错但探测确认 0 个残留(已全删,仅 ssh 非 0 / 超时)→ resolve,不抛错", async () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    const t = mkT(async (argv) => {
      if (argv[0]!.startsWith("rm ")) throw new Error("ssh 超时");
      return "0\n";
    });
    await expect(t.cleanup(["/r/a.ts", "/r/b.ts"])).resolves.toBeUndefined();
    expect(warn).toHaveBeenCalledTimes(1);
    warn.mockRestore();
  });

  it("探测命令也失败(节点不可达)→ 保守按整批失败,原错误不吞", async () => {
    const t = mkT(async () => { throw new Error("ssh 超时 45000ms 被杀"); });
    await expect(t.cleanup(["/r/a.ts"])).rejects
      .toThrow(/远端清理失败: 1\/1 个路径未删.*ssh 超时/);
  });
});
