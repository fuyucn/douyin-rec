/**
 * node-commands-auth.test.ts — internal node calls carry the node-local Web credential (issue #641).
 *
 * The node command registry talks to the node's own serve (stop/drain/anchor refresh/log tail). Once
 * Web auth is enabled those calls must authenticate automatically; no token is copied by hand and a
 * credential-free legacy service keeps working.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { createServer, type Server } from "node:http";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NODE_COMMANDS } from "../../packages/cli/src/node-commands.js";
import type { Task } from "../../packages/app/src/store.js";

const TOKEN = "node-local-token-for-tests";
const ENV_TOKEN = "env-token-for-tests";
const roots: string[] = [];
const saved = { token: process.env.DREC_WEB_TOKEN, api: process.env.DREC_SERVE_API };

beforeEach(() => {
  delete process.env.DREC_WEB_TOKEN;
});

afterEach(() => {
  vi.restoreAllMocks();
  for (const root of roots.splice(0)) rmSync(root, { recursive: true, force: true });
  if (saved.token === undefined) delete process.env.DREC_WEB_TOKEN;
  else process.env.DREC_WEB_TOKEN = saved.token;
  if (saved.api === undefined) delete process.env.DREC_SERVE_API;
  else process.env.DREC_SERVE_API = saved.api;
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "drec-node-auth-"));
  roots.push(root);
  mkdirSync(join(root, "db"), { recursive: true });
  return root;
}

function writeKeyFile(root: string, token: string): void {
  mkdirSync(join(root, "config"), { recursive: true });
  writeFileSync(join(root, "config", "web-token"), token + "\n", "utf-8");
}

interface Seen { path: string; auth: string | undefined }

/** Local serve stub: 401 unless the incoming header equals Bearer + expected. */
function startServe(expected: string, body: unknown): Promise<{ server: Server; seen: Seen[]; url: string }> {
  return new Promise((resolve) => {
    const seen: Seen[] = [];
    const server = createServer((req, res) => {
      seen.push({ path: req.url ?? "", auth: req.headers.authorization });
      if (req.headers.authorization !== "Bearer " + expected) {
        res.writeHead(401, { "content-type": "application/json" });
        res.end(JSON.stringify({ error: "需要访问密钥", authRequired: true }));
        return;
      }
      res.writeHead(200, { "content-type": "application/json" });
      res.end(JSON.stringify(body));
    });
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address();
      const port = typeof addr === "object" && addr !== null ? addr.port : 0;
      resolve({ server, seen, url: "http://127.0.0.1:" + port });
    });
  });
}

const close = (server: Server): Promise<void> => new Promise((r) => server.close(() => r()));

describe("node command internal auth (issue #641)", () => {
  it("task-logs: authenticates with the node's generated key file", async () => {
    const root = makeRoot();
    writeKeyFile(root, TOKEN);
    const serve = await startServe(TOKEN, { lines: ["hello"] });
    process.env.DREC_SERVE_API = serve.url;
    try {
      const r = await NODE_COMMANDS["task-logs"](root, ["7", "10"]);
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.stdout).lines).toEqual(["hello"]);
      expect(serve.seen).toHaveLength(1);
      expect(serve.seen[0].auth).toBe("Bearer " + TOKEN);
    } finally {
      await close(serve.server);
    }
  });

  it("task-logs: env credential wins over the key file (same precedence as serve startup)", async () => {
    const root = makeRoot();
    writeKeyFile(root, TOKEN);
    process.env.DREC_WEB_TOKEN = ENV_TOKEN;
    const serve = await startServe(ENV_TOKEN, { lines: ["env"] });
    process.env.DREC_SERVE_API = serve.url;
    try {
      const r = await NODE_COMMANDS["task-logs"](root, ["7", "10"]);
      expect(r.exitCode).toBe(0);
      expect(JSON.parse(r.stdout).lines).toEqual(["env"]);
      expect(serve.seen[0].auth).toBe("Bearer " + ENV_TOKEN);
    } finally {
      await close(serve.server);
    }
  });

  it("task-logs: credential-free legacy service receives no header", async () => {
    const root = makeRoot();
    const fetchSpy = vi.spyOn(globalThis, "fetch").mockResolvedValue(new Response(JSON.stringify({ lines: [] }), { status: 200 }));
    await NODE_COMMANDS["task-logs"](root, ["7", "10"]);
    const init = fetchSpy.mock.calls[0][1] as RequestInit | undefined;
    expect(init?.headers).toEqual({});
  });

  it("apply-tasks: stop, drain and anchor refresh all carry the node-local credential", async () => {
    const root = makeRoot();
    writeKeyFile(root, TOKEN);
    const { TaskStore } = await import("../../packages/app/src/store.js");
    const store = new TaskStore(join(root, "db", "douyin-rec.db"));
    store.addTask({ room: "https://live.douyin.com/555001", status: "running", enabled: true, anchorName: "A", managedBy: "hub" });
    store.addTask({ room: "https://live.douyin.com/555002", status: "running", enabled: true, anchorName: "B", managedBy: "hub" });
    store.addTask({ room: "https://live.douyin.com/555003", status: "running", enabled: true, managedBy: "hub" });
    store.close();

    const base = {
      platform: "douyin", name: "A", quality: "origin", engine: "ffmpeg", danmu: 1, segmentSec: 1800,
      scheduleStart: null, scheduleEnd: null, useCookie: true, cookies: null, outDir: null,
      webhook: null, rollingUpload: false, streamUpload: false,
    };
    const desired = [
      { ...base, roomSlug: "555001", room: "https://live.douyin.com/555001", enabled: false },
      { ...base, roomSlug: "555002", room: "https://live.douyin.com/555002", enabled: false, drain: true },
      { ...base, roomSlug: "555003", room: "https://live.douyin.com/555003", enabled: true, anchorName: null },
    ] as unknown as Task[];
    const b64 = Buffer.from(JSON.stringify({ desired }), "utf-8").toString("base64");

    const calls: Array<{ url: string; auth: string | undefined }> = [];
    vi.spyOn(globalThis, "fetch").mockImplementation(async (input, init) => {
      const headers = new Headers(init?.headers as HeadersInit | undefined);
      calls.push({ url: String(input), auth: headers.get("authorization") ?? undefined });
      return new Response("{}", { status: 200 });
    });
    const r = await NODE_COMMANDS["apply-tasks"](root, [b64]);
    expect(r.exitCode).toBe(0);

    const stopCall = calls.find((c) => c.url.includes("/stop?internal=1"));
    const drainCall = calls.find((c) => c.url.includes("/drain?internal=1"));
    const anchorCall = calls.find((c) => c.url.includes("/refresh-anchor"));
    expect(stopCall).toBeDefined();
    expect(drainCall).toBeDefined();
    expect(anchorCall).toBeDefined();
    for (const c of [stopCall, drainCall, anchorCall]) expect(c!.auth).toBe("Bearer " + TOKEN);
  });
});

