import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdtempSync, readFileSync, rmSync, statSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { WebSocket } from "ws";
import { FleetHub, issueFleetToken, verifyFleetToken } from "./fleet-hub.js";

type Frame = { t: string; [k: string]: unknown };

const cleanups: Array<() => void> = [];
afterEach(() => {
  for (const c of cleanups.splice(0).reverse()) c();
});

async function startHub(o: Partial<ConstructorParameters<typeof FleetHub>[0]> = {}) {
  const hub = new FleetHub({ verifyToken: (n, t) => n === "n1" && t === "good", ...o });
  const server: Server = createServer((_q, r) => r.end());
  server.on("upgrade", (req, socket, head) => {
    if (!hub.handleUpgrade(req, socket, head)) socket.destroy();
  });
  await new Promise<void>((r) => server.listen(0, "127.0.0.1", () => r()));
  cleanups.push(() => { hub.close(); server.close(); });
  const port = (server.address() as { port: number }).port;
  return { hub, url: `ws://127.0.0.1:${port}/api/fleet/ws` };
}

/** A node stand-in that records frames. */
async function node(url: string, hello: Partial<Frame> = {}) {
  const ws = new WebSocket(url);
  const frames: Frame[] = [];
  const closed = new Promise<number>((r) => ws.on("close", (code) => r(code)));
  ws.on("message", (m) => frames.push(JSON.parse(String(m)) as Frame));
  await new Promise<void>((r, j) => { ws.once("open", () => r()); ws.once("error", j); });
  ws.send(JSON.stringify({ t: "hello", protocol: 1, nodeId: "n1", token: "good", appVersion: "v", commands: ["tasks"], ...hello }));
  cleanups.push(() => ws.close());
  const next = async (t: string): Promise<Frame> => {
    for (let i = 0; i < 100; i++) {
      const f = frames.find((x) => x.t === t);
      if (f) return f;
      await new Promise((r) => setTimeout(r, 20));
    }
    throw new Error(`no ${t}`);
  };
  return { ws, frames, closed, next };
}

const until = async (cond: () => boolean): Promise<void> => {
  for (let i = 0; i < 100 && !cond(); i++) await new Promise((r) => setTimeout(r, 20));
  expect(cond()).toBe(true);
};

describe("FleetHub", () => {
  it("authenticates, welcomes and tracks the node", async () => {
    const { hub, url } = await startHub();
    const n = await node(url);
    await n.next("welcome");
    expect(hub.connected("n1")).toBe(true);
    expect(hub.supports("n1", "tasks")).toBe(true);
    expect(hub.supports("n1", "inventory")).toBe(false);
  });

  it("bad token → 4401, never connected", async () => {
    const { hub, url } = await startHub();
    const n = await node(url, { token: "bad" });
    expect(await n.closed).toBe(4401);
    expect(hub.connected("n1")).toBe(false);
  });

  it("wrong protocol → 4400", async () => {
    const { url } = await startHub();
    const n = await node(url, { protocol: 99 });
    expect(await n.closed).toBe(4400);
  });

  it("heartbeat outputs are cached with master receipt time and expire by maxAge", async () => {
    let t = 1000;
    const { hub, url } = await startHub({ now: () => t });
    const n = await node(url);
    await n.next("welcome");
    n.ws.send(JSON.stringify({ t: "heartbeat", at: 5, outputs: { disk: { stdout: '{"freeGB":1}\n', exitCode: 0, at: 5 } } }));
    await until(() => hub.cached("n1", "disk", 100) !== null);
    expect(hub.cached("n1", "disk", 100)).toEqual({ stdout: '{"freeGB":1}\n', exitCode: 0, at: 1000 });
    t = 1200;
    expect(hub.cached("n1", "disk", 100)).toBeNull();
  });

  it("request/response round trip; late reply after timeout is ignored", async () => {
    const { hub, url } = await startHub();
    const n = await node(url);
    await n.next("welcome");
    const p = hub.request("n1", "tasks", ["/r"], 2000);
    const req = await n.next("req");
    expect(req).toMatchObject({ cmd: "tasks", args: ["/r"] });
    n.ws.send(JSON.stringify({ t: "res", id: req.id, stdout: "ok\n", exitCode: 0 }));
    expect(await p).toEqual({ stdout: "ok\n", exitCode: 0 });

    await expect(hub.request("n1", "tasks", ["/r"], 50)).rejects.toThrow(/timed out/);
  });

  it("disconnect rejects pending requests and clears the node", async () => {
    const { hub, url } = await startHub();
    const n = await node(url);
    await n.next("welcome");
    const p = hub.request("n1", "tasks", ["/r"], 5000);
    await n.next("req");
    n.ws.terminate();
    await expect(p).rejects.toThrow(/n1/);
    await until(() => !hub.connected("n1"));
  });

  it("a new connection for the same node supersedes the old one (4409)", async () => {
    const { hub, url } = await startHub();
    const a = await node(url);
    await a.next("welcome");
    const b = await node(url);
    await b.next("welcome");
    expect(await a.closed).toBe(4409);
    expect(hub.connected("n1")).toBe(true);
  });

  it("silent node is dropped by the sweep", async () => {
    let t = 0;
    const { hub, url } = await startHub({ now: () => t, pingMs: 30, idleTimeoutMs: 100 });
    const n = await node(url);
    await n.next("welcome");
    t = 1000;
    await until(() => !hub.connected("n1"));
    await n.closed;
  });

  it("recording room change between heartbeats fires onRecordingChange once", async () => {
    const changes: string[] = [];
    const { url } = await startHub({ onRecordingChange: (id) => changes.push(id) });
    const n = await node(url);
    await n.next("welcome");
    const hb = (rooms: string[]) => n.ws.send(JSON.stringify({
      t: "heartbeat", at: 0,
      outputs: { "recording-status": { stdout: JSON.stringify({ rooms: rooms.map((r) => ({ platform: "douyin", roomSlug: r })), rolling: [{ p: Math.random() }] }) + "\n", exitCode: 0, at: 0 } },
    }));
    hb(["a"]);
    hb(["a"]); // rolling progress changed, rooms did not
    hb([]);
    await until(() => changes.length === 1);
    await new Promise((r) => setTimeout(r, 100));
    expect(changes).toEqual(["n1"]);
  });

  it("non-fleet upgrade paths are not handled", async () => {
    const { hub } = await startHub();
    expect(hub.handleUpgrade({ url: "/api/other" } as never, {} as never, Buffer.alloc(0))).toBe(false);
  });
});

describe("fleet token store", () => {
  it("issue stores only the hash (0600); verify is exact; rotation invalidates the old token", () => {
    const dir = mkdtempSync(join(tmpdir(), "drec-fleet-tok-"));
    cleanups.push(() => rmSync(dir, { recursive: true, force: true }));
    const p = join(dir, "config", "fleet-nodes.json");
    const t1 = issueFleetToken(p, "n1");
    expect(t1).toMatch(/^[0-9a-f]{64}$/);
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(readFileSync(p, "utf8")).not.toContain(t1);
    expect(verifyFleetToken(p, "n1", t1)).toBe(true);
    expect(verifyFleetToken(p, "n1", t1.slice(1))).toBe(false);
    expect(verifyFleetToken(p, "n2", t1)).toBe(false);
    const t2 = issueFleetToken(p, "n1");
    expect(verifyFleetToken(p, "n1", t1)).toBe(false);
    expect(verifyFleetToken(p, "n1", t2)).toBe(true);
  });

  it("missing file → nothing verifies", () => {
    expect(verifyFleetToken(join(tmpdir(), "drec-no-such", "x.json"), "n1", "t")).toBe(false);
  });
});
