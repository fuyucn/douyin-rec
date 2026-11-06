/**
 * fleet-e2e.test.ts — node agent (app) ↔ FleetHub (orchestrator) ↔ SshTransport over a real socket (plans/042).
 * Proves a status poll and a request are answered without calling ssh, and that ssh takes over when the
 * agent goes away.
 */
import { describe, it, expect, afterEach, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { startFleetAgent, type FleetNodeCommand } from "../../packages/app/src/fleet-agent.js";
import { FleetHub } from "../../packages/orchestrator/src/fleet-hub.js";
import { SshTransport } from "../../packages/orchestrator/src/transport-ssh.js";

const cleanups: Array<() => void> = [];
afterEach(() => { for (const c of cleanups.splice(0).reverse()) c(); });

const until = async (cond: () => boolean): Promise<void> => {
  for (let i = 0; i < 150 && !cond(); i++) await new Promise((r) => setTimeout(r, 20));
  expect(cond()).toBe(true);
};

describe("fleet end to end", () => {
  it("status from heartbeat, tasks over the connection, ssh after the agent stops", async () => {
    const hub = new FleetHub({ verifyToken: (n, t) => n === "vps1" && t === "tok".repeat(11) });
    const server: Server = createServer((_q, r) => r.end());
    server.on("upgrade", (req, socket, head) => { if (!hub.handleUpgrade(req, socket, head)) socket.destroy(); });
    await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r())); // issue-guard: allow (loopback / test fixture)
    cleanups.push(() => { hub.close(); server.close(); });
    const port = (server.address() as { port: number }).port;

    const commands: Record<string, FleetNodeCommand> = {
      "recording-status": async () => ({ stdout: '{"rooms":[{"platform":"douyin","roomSlug":"r1"}],"finalizing":[{"platform":"douyin","roomSlug":"r3"}],"rolling":[]}\n', exitCode: 0 }),
      disk: async () => ({ stdout: '{"freeGB":12.5}\n', exitCode: 0 }),
      "node-status": async () => ({ stdout: '{"appVersion":"x","appliedVersion":null,"appliedAt":null,"taskCount":0,"managedCount":0}\n', exitCode: 0 }),
      tasks: async () => ({ stdout: '{"tasks":[]}\n', exitCode: 0 }),
    };
    const agent = startFleetAgent({
      config: { controllerUrl: `http://127.0.0.1:${port}`, nodeId: "vps1", token: "tok".repeat(11) }, // issue-guard: allow (loopback / test fixture)
      dataRoot: "/data", appVersion: "x", commands, heartbeatMs: 50,
    });
    cleanups.push(() => agent.stop());
    await until(() => hub.cached("vps1", "disk", 10_000) !== null);

    const ssh = vi.fn(async () => { throw new Error("ssh should not be used"); });
    const t = new SshTransport({ id: "vps1", host: "h", dataRoot: "/data", run: ssh, fleet: () => hub });
    expect(await t.diskFreeGB()).toBe(12.5);
    expect(await t.isDone("r1")).toBe(false);
    expect(await t.isDone("r2")).toBe(true);
    expect(await t.isDone("r3")).toBe(false); // finalizing: not pulling, still uploading its tail (#456)
    expect((await t.recordingStatus()).rooms).toEqual([{ platform: "douyin", roomSlug: "r1" }]);
    expect((await t.listTasks()).tasks).toEqual([]);
    expect(ssh).not.toHaveBeenCalled();

    agent.stop();
    await until(() => !hub.connected("vps1"));
    const ssh2 = vi.fn(async () => '{"tasks":[]}\n');
    const t2 = new SshTransport({ id: "vps1", host: "h", dataRoot: "/data", run: ssh2, fleet: () => hub });
    await t2.listTasks();
    expect(ssh2).toHaveBeenCalledOnce();
  });
});
