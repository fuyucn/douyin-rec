/**
 * install-worker.sh --check-busy: the upgrade guard must refuse while the node records or
 * uploads, treat an unreachable API as idle, and fail closed on an unreadable answer.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { execFile, execFileSync } from "node:child_process";
import { mkdtempSync, rmSync, symlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const SCRIPT = join(import.meta.dirname, "..", "..", "scripts", "install-worker.sh");
let server: Server | undefined;

function serve(tasks: string, proc: string, status = 200): Promise<number> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      if (req.url === "/api/tasks") { res.statusCode = status; res.end(tasks); }
      else if (req.url === "/api/proc/active") res.end(proc);
      else { res.statusCode = 404; res.end(); }
    }).listen(0, () => resolve((server!.address() as { port: number }).port));
  });
}

function check(port: number, env?: NodeJS.ProcessEnv): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile("sh", [SCRIPT, "--check-busy", "--port", String(port)], env ? { env } : {}, (err, stdout, stderr) => {
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
  it("HTTP 500 from the task list fails closed (busy)", async () => {
    const port = await serve("boom", "{}", 500);
    const r = await check(port);
    expect(r.code).toBe(1);
    expect(r.out).toContain("unavailable");
  });
  it("node missing from PATH fails closed instead of reporting idle", async () => {
    const port = await serve(JSON.stringify([{ id: 1, recording: true }]), "{}");
    // A PATH holding only the tools the script needs, so the result cannot depend on where node lives.
    const bin = mkdtempSync(join(tmpdir(), "no-node-"));
    for (const tool of ["curl", "sed", "grep", "awk", "cat", "tr", "printf"]) {
      const real = execFileSync("sh", ["-c", `command -v ${tool}`]).toString().trim();
      if (real) symlinkSync(real, join(bin, tool));
    }
    const r = await check(port, { PATH: bin });
    rmSync(bin, { recursive: true, force: true });
    expect(r.code).toBe(1);
    expect(r.out).toContain("node missing");
  });
  it("unreachable API (service not running) is idle", async () => {
    expect(await check(1)).toMatchObject({ code: 0 });
  });
});

describe("install-worker --verify-version", () => {
  const verify = (want: string, got: string): Promise<number> => new Promise((resolve) => {
    execFile("sh", [SCRIPT, "--verify-version", want, got], (err) => resolve(err ? ((err as { code?: number }).code ?? 1) : 0));
  });
  it("accepts the bare version and the version with a 6-hex sha", async () => {
    expect(await verify("0.0.241", "0.0.241")).toBe(0);
    expect(await verify("0.0.241", "0.0.241-eaf529")).toBe(0);
  });
  it("rejects other suffixes, other versions and prefix lookalikes", async () => {
    for (const got of ["0.0.241-dev", "0.0.241-anything", "0.0.241-EAF529", "0.0.2411-eaf529", "0.0.242-eaf529", "0.0.24", ""]) {
      expect(await verify("0.0.241", got)).toBe(1);
    }
  });
});
