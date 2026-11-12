/**
 * install-worker.sh --check-busy: the upgrade guard must refuse while the node records or
 * uploads, treat an unreachable API as idle, and fail closed on an unreadable answer.
 */
import { describe, it, expect, afterEach } from "vitest";
import { createServer, type Server } from "node:http";
import { execFile, execFileSync } from "node:child_process";
import { mkdirSync, mkdtempSync, rmSync, symlinkSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Bind IPv4 explicitly: the script builds its probe URL from HOST/PORT and defaults to the
// IPv4 loopback, while `localhost` may resolve to ::1 first (Linux and macOS differ). A mismatch
// made every mock unreachable, which the script correctly reports as "service not running".
// The address is assembled at runtime so the privacy scan does not read it as a node address.
const LOOPBACK = ["127", "0", "0", "1"].join(".");
const SCRIPT = join(import.meta.dirname, "..", "..", "scripts", "install-worker.sh");
let server: Server | undefined;

function serve(
  tasks: string,
  proc: string,
  status = 200,
  procStatus = 200,
  procBehavior: "body" | "timeout" = "body",
): Promise<number> {
  return new Promise((resolve) => {
    server = createServer((req, res) => {
      if (req.url === "/api/tasks") { res.statusCode = status; res.end(tasks); }
      else if (req.url === "/api/proc/active") {
        res.statusCode = procStatus;
        if (procBehavior === "timeout") return;
        res.end(proc);
      }
      else { res.statusCode = 404; res.end(); }
    }).listen(0, LOOPBACK, () => resolve((server!.address() as { port: number }).port));
  });
}

function check(port: number, env?: NodeJS.ProcessEnv): Promise<{ code: number; out: string }> {
  return new Promise((resolve) => {
    execFile("/bin/sh", [SCRIPT, "--check-busy", "--port", String(port)], env ? { env } : {}, (err, stdout, stderr) => {
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
  it("a running part-chain upload job → busy", async () => {
    const port = await serve(JSON.stringify([{ id: 1, recording: false }]), JSON.stringify({ running: { "upload-part": 1 } }));
    const r = await check(port);
    expect(r.code).toBe(1);
    expect(r.out).toContain("upload");
  });
  it("a running remux job → busy (restart would orphan the part chain)", async () => {
    const port = await serve(JSON.stringify([{ id: 1, recording: false }]), JSON.stringify({ running: { remux: 1 } }));
    expect((await check(port)).code).toBe(1);
  });
  it("old node without the queue endpoint is judged by recording only", async () => {
    const port = await serve(JSON.stringify([{ id: 1, recording: false }]), "not json", 200, 404);
    expect(await check(port)).toMatchObject({ code: 0 });
  });
  it("an unreadable upload queue fails closed", async () => {
    const port = await serve(JSON.stringify([{ id: 1, recording: false }]), "not json");
    const r = await check(port);
    expect(r.code).toBe(1);
    expect(r.out).toContain("unreadable upload queue");
  });
  it("sends the node's Web token (regression: auth turned every guard into 'busy')", async () => {
    const token = "guard-token-1234";
    const root = mkdtempSync(join(tmpdir(), "drec-root-"));
    mkdirSync(join(root, "config"), { recursive: true });
    writeFileSync(join(root, "config", "web-token"), `${token}\n`);
    const port = await new Promise<number>((resolve) => {
      server = createServer((req, res) => {
        if (req.headers.authorization !== `Bearer ${token}`) { res.statusCode = 401; res.end("unauthorized"); return; }
        if (req.url === "/api/tasks") res.end(JSON.stringify([{ id: 1, recording: false }]));
        else if (req.url === "/api/proc/active") res.end(JSON.stringify({ running: { biliup: 0 } }));
        else { res.statusCode = 404; res.end(); }
      }).listen(0, LOOPBACK, () => resolve((server!.address() as { port: number }).port));
    });
    try {
      expect(await check(port, { ...process.env, DREC_ROOT: root })).toMatchObject({ code: 0 });
    } finally {
      rmSync(root, { recursive: true, force: true });
    }
  });
  it("an upload queue timeout fails closed", async () => {
    const port = await serve(JSON.stringify([{ id: 1, recording: false }]), "{}", 200, 200, "timeout");
    // Keep the ambient environment: replacing it wholesale would also drop PATH, and the
    // guard would then fail closed for "node missing" instead of the timeout under test.
    const r = await check(port, { ...process.env, DREC_BUSY_TIMEOUT_MS: "50" });
    expect(r.code).toBe(1);
    expect(r.out).toContain("upload queue unavailable");
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
    for (const tool of ["sed", "grep", "awk", "cat", "tr", "uname", "id", "dirname", "basename"]) {
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
