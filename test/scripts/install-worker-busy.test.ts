/**
 * install-worker.sh --check-busy: the upgrade guard must refuse while the node records or
 * uploads, treat an unreachable API as idle, and fail closed on an unreadable answer.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { execFile } from "node:child_process";
import { join } from "node:path";

const SCRIPT = join(import.meta.dirname, "..", "..", "scripts", "install-worker.sh");
let server: Server | undefined;

function serve(tasks: string, proc: string): Promise<number> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      if (req.url === "/api/tasks") res.end(tasks);
      else if (req.url === "/api/proc/active") res.end(proc);
      else { res.statusCode = 404; res.end(); }
    }).listen(0, "127.0.0.1", () => resolve((server!.address() as { port: number }).port));
  });
}

function check(port: number): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile("sh", [SCRIPT, "--check-busy", "--port", String(port)], (err, stdout, stderr) => {
      resolve({ code: err ? ((err as { code?: number }).code ?? 1) : 0, out: stdout + stderr });
    });
  });
}

afterEach(() => { server?.close(); server = undefined; });

describe("install-worker --check-busy", () => {
  it("idle node → exit 0", async () => {
    const port = await serve(JSON.stringify([{ id: 1, recording: false }]), JSON.stringify({ running: { biliup: 0 } }));
    expect(await check(port)).toMatchObject({ code: 0 });
  });
  it("a recording task → busy", async () => {
    const port = await serve(JSON.stringify([{ id: 1, recording: true }]), JSON.stringify({ running: { biliup: 0 } }));
    const r = await check(port);
    expect(r.code).toBe(1);
    expect(r.out).toContain("recording");
  });
  it("a running upload job → busy", async () => {
    const port = await serve(JSON.stringify([{ id: 1, recording: false }]), JSON.stringify({ running: { biliup: 1 } }));
    const r = await check(port);
    expect(r.code).toBe(1);
    expect(r.out).toContain("upload");
  });
  it("old node without the queue endpoint is judged by recording only", async () => {
    const port = await serve(JSON.stringify([{ id: 1, recording: false }]), "not json");
    expect(await check(port)).toMatchObject({ code: 0 });
  });
  it("unreadable task list fails closed", async () => {
    const port = await serve("<html>", "{}");
    expect((await check(port)).code).toBe(1);
  });
  it("unreachable API (service not running) is idle", async () => {
    expect(await check(1)).toMatchObject({ code: 0 });
  });
});
