import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { spawn } from "node:child_process";
import { EventEmitter } from "node:events";
import { PassThrough } from "node:stream";
import type { FleetLink } from "./fleet-hub.js";
import { SshTransport } from "./transport-ssh.js";

vi.mock("node:child_process", async (original) => ({
  ...await original<typeof import("node:child_process")>(),
  spawn: vi.fn(),
}));

function sshChild() {
  const child = Object.assign(new EventEmitter(), {
    stdin: new PassThrough(), stdout: new PassThrough(), stderr: new PassThrough(),
    kill: vi.fn(() => true),
  });
  vi.mocked(spawn).mockReturnValue(child as unknown as ReturnType<typeof spawn>);
  return child;
}

function fleet(request: FleetLink["request"]): FleetLink {
  return {
    supports: () => true, cached: () => null,
    recordingRooms: () => null, finalizingRooms: () => null, request,
  };
}

function transport(link: FleetLink | null = null): SshTransport {
  return new SshTransport({ id: "worker", host: "test.invalid", dataRoot: "/fixture", fleet: () => link });
}

function complete(child: ReturnType<typeof sshChild>): void {
  child.stdout.emit("data", Buffer.from('{"recordings":[]}'));
  child.emit("close", 0);
}

function observe<T>(pending: Promise<T>) {
  return pending.then((value) => ({ value, error: null }), (error: unknown) => ({ value: null, error }));
}

beforeEach(() => {
  vi.useFakeTimers({ toFake: ["setTimeout", "clearTimeout", "performance"] });
  vi.resetAllMocks();
});
afterEach(() => { vi.clearAllTimers(); vi.useRealTimers(); });

describe("inventory command budget (#350)", () => {
  it("accepts a fleet inventory that takes 50 seconds without starting SSH", async () => {
    const request = vi.fn<FleetLink["request"]>((_id, _cmd, _args, timeoutMs) =>
      new Promise((resolve, reject) => {
        setTimeout(() => resolve({ stdout: '{"recordings":[]}', exitCode: 0 }), 50_000);
        setTimeout(() => reject(new Error("fleet timeout")), timeoutMs);
      }));
    const result = observe(transport(fleet(request)).listInventory());
    expect(request).toHaveBeenCalledWith("worker", "inventory", ["/fixture"], 60_000);
    await vi.advanceTimersByTimeAsync(50_000);
    expect(await result).toEqual({ value: { workerId: "worker", recordings: [] }, error: null });
    expect(spawn).not.toHaveBeenCalled();
  });

  it("accepts a cold SSH inventory after the generic 45-second deadline", async () => {
    const child = sshChild();
    const result = observe(transport().listInventory());
    await vi.advanceTimersByTimeAsync(50_000);
    expect(child.kill).not.toHaveBeenCalled();
    complete(child);
    expect(await result).toEqual({ value: { workerId: "worker", recordings: [] }, error: null });
  });

  it("gives SSH only the time remaining after an early fleet disconnect", async () => {
    const child = sshChild();
    const request: FleetLink["request"] = () => new Promise((_resolve, reject) => {
      setTimeout(() => reject(new Error("disconnected")), 10_000);
    });
    const result = observe(transport(fleet(request)).listInventory());
    await vi.advanceTimersByTimeAsync(10_000);
    expect(spawn).toHaveBeenCalledOnce();
    await vi.advanceTimersByTimeAsync(49_999);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect((await result).error).toEqual(expect.objectContaining({ message: expect.stringMatching(/ssh 超时/) }));
    expect(child.kill).toHaveBeenCalledOnce();
    expect(child.kill).toHaveBeenCalledWith("SIGKILL");
  });

  it("does not start SSH after the fleet request exhausts the inventory window", async () => {
    const request: FleetLink["request"] = (_id, _cmd, _args, timeoutMs) => new Promise((_resolve, reject) => {
      setTimeout(() => reject(new Error("fleet timeout")), timeoutMs);
    });
    const result = observe(transport(fleet(request)).listInventory());
    await vi.advanceTimersByTimeAsync(60_000);
    expect(spawn).not.toHaveBeenCalled();
    expect((await result).error).toEqual(expect.objectContaining({ message: expect.stringMatching(/inventory.*60000ms/) }));
  });

  it("still falls back immediately on a fleet refusal and returns the SSH inventory", async () => {
    const child = sshChild();
    const request: FleetLink["request"] = async () => ({ stdout: "", exitCode: 1, refused: "unknown-command" });
    const result = observe(transport(fleet(request)).listInventory());
    await vi.advanceTimersByTimeAsync(0);
    expect(spawn).toHaveBeenCalledOnce();
    complete(child);
    expect(await result).toEqual({ value: { workerId: "worker", recordings: [] }, error: null });
  });

  it.each([
    ["tasks", 45_000, (t: SshTransport) => t.listTasks()],
    ["recording status", 8_000, (t: SshTransport) => t.recordingStatus()],
  ] as const)("keeps the existing %s budget", async (_name, timeoutMs, command) => {
    const child = sshChild();
    const result = observe<unknown>(command(transport()));
    await vi.advanceTimersByTimeAsync(timeoutMs - 1);
    expect(child.kill).not.toHaveBeenCalled();
    await vi.advanceTimersByTimeAsync(1);
    expect((await result).error).toEqual(expect.objectContaining({ message: expect.stringMatching(/ssh 超时/) }));
    expect(child.kill).toHaveBeenCalledOnce();
  });
});
