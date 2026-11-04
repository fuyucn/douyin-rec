/**
 * fleet-agent.test.ts — worker side of fleet/1 (plans/042 Task 2) against a real `ws` server.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocketServer, type WebSocket as ServerSocket } from "ws";
import {
  fleetBackoffMs,
  fleetSocketUrl,
  readFleetConfig,
  startFleetAgent,
  writeFleetConfig,
  type FleetAgent,
  type FleetNodeCommand,
} from "../../packages/app/src/fleet-agent.js";
import { FLEET_CLOSE, FLEET_UNKNOWN_COMMAND_EXIT } from "../../packages/core/src/fleet-protocol.js";

type Frame = { t: string; [k: string]: unknown };

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

/** A master stand-in: records frames, lets the test reply. */
async function startMaster(): Promise<{
  url: string;
  frames: Frame[];
  sockets: ServerSocket[];
  next: (t: string, after?: number) => Promise<Frame>;
}> {
  const wss = new WebSocketServer({ port: 0, path: "/api/fleet/ws" });
  await new Promise<void>((r) => wss.once("listening", () => r()));
  const frames: Frame[] = [];
  const sockets: ServerSocket[] = [];
  const waiters: Array<() => void> = [];
  wss.on("connection", (s) => {
    sockets.push(s);
    s.on("message", (m) => {
      frames.push(JSON.parse(String(m)) as Frame);
      for (const w of waiters.splice(0)) w();
    });
  });
  cleanups.push(() => wss.close());
  const port = (wss.address() as { port: number }).port;
  const next = async (t: string, after = 0): Promise<Frame> => {
    const deadline = Date.now() + 3000;
    for (;;) {
      const f = frames.slice(after).find((x) => x.t === t);
      if (f) return f;
      if (Date.now() > deadline) throw new Error(`no ${t} frame`);
      await new Promise<void>((r) => {
        waiters.push(r);
        setTimeout(r, 50);
      });
    }
  };
  return { url: `http://127.0.0.1:${port}`, frames, sockets, next }; // issue-guard: allow (loopback / test fixture)
}

const commands: Record<string, FleetNodeCommand> = {
  "recording-status": async () => ({ stdout: '{"rooms":[],"rolling":[]}\n', exitCode: 0 }),
  disk: async () => ({ stdout: '{"freeGB":37.1}\n', exitCode: 0 }),
  "node-status": async () => ({ stdout: '{"appVersion":"t"}\n', exitCode: 0 }),
  echo: async (_root, args) => ({ stdout: JSON.stringify(args) + "\n", exitCode: 0 }),
  boom: async () => {
    throw new Error("kaput");
  },
};

function agent(url: string, extra: Partial<Parameters<typeof startFleetAgent>[0]> = {}): FleetAgent {
  const a = startFleetAgent({
    config: { controllerUrl: url, nodeId: "n1", token: "secret" },
    dataRoot: "/data/root",
    appVersion: "0.0.test",
    commands,
    heartbeatMs: 100,
    ...extra,
  });
  cleanups.push(() => a.stop());
  return a;
}

describe("fleet agent", () => {
  it("sends hello with identity, version and the command list", async () => {
    const m = await startMaster();
    agent(m.url);
    const hello = await m.next("hello");
    expect(hello).toMatchObject({ protocol: 1, nodeId: "n1", token: "secret", appVersion: "0.0.test" });
    expect(hello.commands).toEqual(Object.keys(commands));
  });

  it("starts heartbeats only after welcome, carrying the status commands' stdout", async () => {
    const m = await startMaster();
    agent(m.url);
    await m.next("hello");
    await new Promise((r) => setTimeout(r, 250));
    expect(m.frames.some((f) => f.t === "heartbeat")).toBe(false);
    m.sockets[0].send(JSON.stringify({ t: "welcome", protocol: 1 }));
    const hb = await m.next("heartbeat");
    const outputs = hb.outputs as Record<string, { stdout: string; exitCode: number }>;
    expect(outputs.disk).toMatchObject({ stdout: '{"freeGB":37.1}\n', exitCode: 0 });
    expect(Object.keys(outputs).sort()).toEqual(["disk", "node-status", "recording-status"]);
  });

  it("answers req with registry stdout; args after dataRoot are passed through", async () => {
    const m = await startMaster();
    agent(m.url);
    await m.next("hello");
    m.sockets[0].send(JSON.stringify({ t: "welcome", protocol: 1 }));
    m.sockets[0].send(JSON.stringify({ t: "req", id: 7, cmd: "echo", args: ["/data/root", "a", "--b", "c"] }));
    const res = await m.next("res");
    expect(res).toEqual({ t: "res", id: 7, stdout: '["a","--b","c"]\n', exitCode: 0 });
  });

  it("unknown command → exit 127; foreign dataRoot → exit 2; throw → exit 1 with error", async () => {
    const m = await startMaster();
    agent(m.url);
    await m.next("hello");
    const s = m.sockets[0];
    s.send(JSON.stringify({ t: "welcome", protocol: 1 }));
    s.send(JSON.stringify({ t: "req", id: 1, cmd: "nope", args: ["/data/root"] }));
    s.send(JSON.stringify({ t: "req", id: 2, cmd: "echo", args: ["/other/root"] }));
    s.send(JSON.stringify({ t: "req", id: 3, cmd: "boom", args: ["/data/root"] }));
    await new Promise((r) => setTimeout(r, 300));
    const byId = new Map(m.frames.filter((f) => f.t === "res").map((f) => [f.id, f]));
    expect(byId.get(1)).toMatchObject({ exitCode: FLEET_UNKNOWN_COMMAND_EXIT });
    expect(byId.get(2)).toMatchObject({ exitCode: 2 });
    expect(byId.get(3)).toMatchObject({ exitCode: 1, error: "kaput" });
  });

  it("reconnects after the master drops the connection", async () => {
    const m = await startMaster();
    agent(m.url);
    await m.next("hello");
    m.sockets[0].close(1011);
    const before = m.frames.length;
    await m.next("hello", before);
    expect(m.sockets.length).toBe(2);
  });

  it("unauthorized close → does not reconnect soon", async () => {
    const m = await startMaster();
    agent(m.url);
    await m.next("hello");
    m.sockets[0].close(FLEET_CLOSE.unauthorized);
    await new Promise((r) => setTimeout(r, 1500));
    expect(m.sockets.length).toBe(1);
  });

  it("idle link (no frame from master) is closed and redialed", async () => {
    const m = await startMaster();
    agent(m.url, { idleTimeoutMs: 300 });
    await m.next("hello");
    const before = m.frames.length;
    await m.next("hello", before);
    expect(m.sockets.length).toBeGreaterThanOrEqual(2);
  });

  it("stop() closes the socket and never redials", async () => {
    const m = await startMaster();
    const a = agent(m.url);
    await m.next("hello");
    a.stop();
    await new Promise((r) => setTimeout(r, 1500));
    expect(m.sockets.length).toBe(1);
    expect(a.connected()).toBe(false);
  });
});

describe("fleet agent helpers", () => {
  it("fleetSocketUrl maps http→ws and https→wss on the fleet path", () => {
    expect(fleetSocketUrl("http://100.64.0.1:7860")).toBe("ws://100.64.0.1:7860/api/fleet/ws"); // issue-guard: allow (loopback / test fixture)
    expect(fleetSocketUrl("https://m.example/")).toBe("wss://m.example/api/fleet/ws");
  });

  it("fleetBackoffMs: 1s doubling, capped at 30s", () => {
    expect([0, 1, 2, 3, 4, 5, 9].map(fleetBackoffMs)).toEqual([1000, 2000, 4000, 8000, 16000, 30000, 30000]);
  });

  it("readFleetConfig: valid → object; missing / malformed → null", () => {
    const dir = mkdtempSync(join(tmpdir(), "drec-fleet-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const p = join(dir, "fleet.json");
    expect(readFleetConfig(p)).toBeNull();
    writeFileSync(p, JSON.stringify({ controllerUrl: "http://m:7860", nodeId: "n", token: "t" }));
    expect(readFleetConfig(p)).toEqual({ controllerUrl: "http://m:7860", nodeId: "n", token: "t" });
    writeFileSync(p, JSON.stringify({ controllerUrl: "ftp://m", nodeId: "n", token: "t" }));
    expect(readFleetConfig(p)).toBeNull();
    writeFileSync(p, "{not json");
    expect(readFleetConfig(p)).toBeNull();
  });

  it("writeFleetConfig: writes 0600 and round-trips; rejects bad URL / short token", () => {
    const dir = mkdtempSync(join(tmpdir(), "drec-fleet-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const p = join(dir, "config", "fleet.json");
    const token = "a".repeat(64);
    writeFleetConfig(p, { controllerUrl: "http://m:7860", nodeId: "n", token, extra: "dropped" });
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(readFleetConfig(p)).toEqual({ controllerUrl: "http://m:7860", nodeId: "n", token });
    expect(() => writeFleetConfig(p, { controllerUrl: "m:7860", nodeId: "n", token })).toThrow(/controllerUrl/);
    expect(() => writeFleetConfig(p, { controllerUrl: "http://m", nodeId: "n", token: "short" })).toThrow(/token/);
  });
});
