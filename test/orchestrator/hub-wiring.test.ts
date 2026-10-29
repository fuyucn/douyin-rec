import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { startHub, LocalTransport, SshTransport } from "@drec/orchestrator";

describe("startHub", () => {
  beforeEach(() => vi.useFakeTimers());
  afterEach(() => vi.useRealTimers());

  it("calls reconcileAll after settle period when recording stops", async () => {
    const reconcileAll = vi.fn().mockResolvedValue(undefined);
    let recording = true;
    const stop = startHub({
      tasks: () => [{ id: 1 }],
      isRecording: () => recording,
      reconcileAll,
      settleMs: 5000,
      pollMs: 1000,
      reconcileIntervalMs: 60000,
    });

    // advance polls while recording
    await vi.advanceTimersByTimeAsync(3000);
    expect(reconcileAll).not.toHaveBeenCalled();

    // stop recording
    recording = false;
    await vi.advanceTimersByTimeAsync(3000); // poll fires, sees false
    expect(reconcileAll).not.toHaveBeenCalled(); // settleMs not elapsed yet

    // advance past settle
    await vi.advanceTimersByTimeAsync(5000);
    expect(reconcileAll).toHaveBeenCalled();

    stop();
  });

  it("does NOT trigger if recording resumes before settle", async () => {
    const reconcileAll = vi.fn().mockResolvedValue(undefined);
    let recording = true;
    const stop = startHub({
      tasks: () => [{ id: 1 }],
      isRecording: () => recording,
      reconcileAll,
      settleMs: 5000,
      pollMs: 1000,
      reconcileIntervalMs: 60000,
    });

    recording = false;
    await vi.advanceTimersByTimeAsync(3000); // polls see false, debouncer starts
    recording = true;
    await vi.advanceTimersByTimeAsync(8000); // advance past settle, but now recording=true
    expect(reconcileAll).not.toHaveBeenCalled();

    stop();
  });

  it("calls reconcileAll on periodic interval", async () => {
    const reconcileAll = vi.fn().mockResolvedValue(undefined);
    const stop = startHub({
      tasks: () => [],
      isRecording: () => false,
      reconcileAll,
      settleMs: 5000,
      pollMs: 1000,
      reconcileIntervalMs: 10000,
    });

    await vi.advanceTimersByTimeAsync(25000);
    expect(reconcileAll.mock.calls.length).toBeGreaterThanOrEqual(2);
    stop();
  });
});

// ── T-2:force 必须端到端送达**节点侧**(在 master 侧生效等于没做:拒绝删除的是远端进程)──
describe("T-2 applyTasks force 透传", () => {
  const spec = { platform: "douyin", roomSlug: "123", room: "https://live.douyin.com/123" };

  /** SshTransport 的 run 收到的是**拼好的单串命令**(node <bundle> _apply-tasks <dataRoot> <b64>)。 */
  const payloadOf = (cmd: string): unknown =>
    JSON.parse(Buffer.from(cmd.trim().split(/\s+/).pop()!, "base64").toString("utf-8"));

  it("SshTransport: force 编入 _apply-tasks 的 base64 payload", async () => {
    const seen: string[] = [];
    const t = new SshTransport({
      id: "vps", host: "h", dataRoot: "/drec",
      run: async (argv) => {
        seen.push(argv.join(" "));
        return JSON.stringify({ applied: [], removed: [], pending: [] });
      },
    });
    await t.applyTasks({ desired: [spec as never], force: true });
    expect(seen[0]).toContain("_apply-tasks /drec");
    expect(payloadOf(seen[0]!)).toEqual({ desired: [spec], force: true });
  });

  it("SshTransport: 不 force 时 payload 不带 force 键(远端按默认守卫走)", async () => {
    const seen: string[] = [];
    const t = new SshTransport({
      id: "vps", host: "h", dataRoot: "/drec",
      run: async (argv) => { seen.push(argv.join(" ")); return JSON.stringify({ applied: [], removed: [], pending: [] }); },
    });
    await t.applyTasks({ desired: [] });
    expect(payloadOf(seen[0]!)).toEqual({ desired: [] });
  });

  it("LocalTransport: force 原样传给注入的 applyTasks 回调", async () => {
    const applyTasks = vi.fn().mockResolvedValue({ applied: [], removed: [], pending: [] });
    const t = new LocalTransport({ id: "local", recordingsDir: "/rec", applyTasks });
    await t.applyTasks({ desired: [spec as never], force: true });
    expect(applyTasks).toHaveBeenCalledWith({ desired: [spec], force: true });
  });

  it("SshTransport: expectedVersion 编入 _apply-tasks 的 base64 payload", async () => {
    const seen: string[] = [];
    const t = new SshTransport({
      id: "vps", host: "h", dataRoot: "/drec",
      run: async (argv) => { seen.push(argv.join(" ")); return JSON.stringify({ applied: [], removed: [], pending: [] }); },
    });
    await t.applyTasks({ desired: [spec as never], expectedVersion: 12 });
    expect(payloadOf(seen[0]!)).toEqual({ desired: [spec], expectedVersion: 12 });
  });

  it("LocalTransport: expectedVersion 原样传给注入的 applyTasks 回调", async () => {
    const applyTasks = vi.fn().mockResolvedValue({ applied: [], removed: [], pending: [] });
    const t = new LocalTransport({ id: "local", recordingsDir: "/rec", applyTasks });
    await t.applyTasks({ desired: [spec as never], expectedVersion: 12 });
    expect(applyTasks).toHaveBeenCalledWith({ desired: [spec], expectedVersion: 12 });
  });
});
