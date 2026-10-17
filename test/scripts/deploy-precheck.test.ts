/**
 * deploy-precheck.test.ts — plan 038 T16 three-state deploy guard.
 * Runs scripts/deploy-precheck.py (and .sh with stubbed curl/ssh) via spawnSync.
 * Needs python3 and bash on PATH; the suite is skipped with a message otherwise.
 * Manual run: pnpm vitest run test/scripts/deploy-precheck.test.ts
 */
import { describe, it, expect } from "vitest";
import { spawnSync } from "node:child_process";
import { chmodSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const ROOT = join(import.meta.dirname, "..", "..");
const PY = join(ROOT, "scripts", "deploy-precheck.py");
const SH = join(ROOT, "scripts", "deploy-precheck.sh");
const have = (bin: string): boolean => spawnSync(bin, ["--version"]).status === 0;
if (!have("python3")) console.warn("[deploy-precheck.test] python3 not found, skipping");
const d = have("python3") && have("bash") ? describe : describe.skip;

interface Case { tasks?: unknown; procStatus?: number; proc?: unknown; uploading?: string }
function guard(c: Case): { code: number | null; out: string } {
  const dir = mkdtempSync(join(tmpdir(), "dpc-"));
  const tasks = join(dir, "tasks.json");
  const proc = join(dir, "proc.json");
  writeFileSync(tasks, c.tasks === undefined ? "" : JSON.stringify(c.tasks));
  writeFileSync(proc, c.proc === undefined ? "" : typeof c.proc === "string" ? c.proc : JSON.stringify(c.proc));
  const r = spawnSync("python3", ["-I", PY, "--label", "n", "--tasks", tasks, "--proc-status", String(c.procStatus ?? 0),
    "--proc", proc, "--uploading", c.uploading ?? "unknown"], { encoding: "utf-8" });
  return { code: r.status, out: r.stdout };
}
const idle = [{ id: 1, running: true, recording: false }];
const active = (biliup: number) => ({ host: true, running: { biliup }, pending: {}, leaseAlive: {} });

d("deploy-precheck.py", () => {
  it("recording task blocks regardless of the queue", () => {
    expect(guard({ tasks: [{ id: 1, recording: true }], procStatus: 200, proc: active(0) }).code).toBe(1);
  });
  it("running.biliup > 0 blocks", () => {
    const r = guard({ tasks: idle, procStatus: 200, proc: active(1) });
    expect(r.code).toBe(1);
    expect(r.out).toMatch(/biliup job/);
  });
  it("running.biliup = 0 proceeds", () => {
    expect(guard({ tasks: idle, procStatus: 200, proc: active(0) }).code).toBe(0);
  });
  it("a 200 with a body we do not understand is unknown, not ok", () => {
    expect(guard({ tasks: idle, procStatus: 200, proc: { nope: 1 } }).code).toBe(2);
    expect(guard({ tasks: idle, procStatus: 200, proc: "not json" }).code).toBe(2);
    expect(guard({ tasks: idle, procStatus: 200, proc: { running: { biliup: "x" } } }).code).toBe(2);
  });
  it("old bundle (404): fresh uploading result blocks, none proceeds, unreadable waits", () => {
    expect(guard({ tasks: idle, procStatus: 404, uploading: "1" }).code).toBe(1);
    const ok = guard({ tasks: idle, procStatus: 404, uploading: "0" });
    expect(ok.code).toBe(0);
    expect(ok.out).toMatch(/cannot confirm the queue/);
    expect(guard({ tasks: idle, procStatus: 404, uploading: "unknown" }).code).toBe(2);
    expect(guard({ tasks: idle, procStatus: 404, uploading: "garbage" }).code).toBe(2);
  });
  it("unreachable, timeout and 503 wait (fail closed)", () => {
    for (const procStatus of [0, 503, 500]) expect(guard({ tasks: idle, procStatus, uploading: "0" }).code).toBe(2);
  });
  it("unreadable task list waits", () => {
    expect(guard({ procStatus: 200, proc: active(0) }).code).toBe(2);
  });
});

d("deploy-precheck.sh (stubbed curl/ssh)", () => {
  /** A local data root with a stage dir; `atMs` (if given) plants a phase=uploading result file. */
  function dataRoot(atMs?: number): string {
    const root = mkdtempSync(join(tmpdir(), "dpc-root-"));
    mkdirSync(join(root, "stage", "k"), { recursive: true });
    if (atMs !== undefined) writeFileSync(join(root, "stage", "k", ".drec-node-result.json"), JSON.stringify({ phase: "uploading", atMs }));
    return root;
  }
  // Stubs answer by URL; `ssh host cmd` runs cmd's curl through the same stub.
  function runSh(procReply: string, opts: { root?: string; tasksReply?: string } = {}): { code: number | null; out: string } {
    const tasksReply = opts.tasksReply ?? "[]";
    const bin = mkdtempSync(join(tmpdir(), "dpc-bin-"));
    const stub = (name: string, body: string): void => { writeFileSync(join(bin, name), `#!/usr/bin/env bash\n${body}\n`); chmodSync(join(bin, name), 0o755); };
    // Like real curl: `-o FILE` writes the body there instead of stdout.
    const curlBody = `
out=""; prev=""
for a in "$@"; do [ "$prev" = "-o" ] && out="$a"; prev="$a"; done
args="$*"
case "$args" in
  *api/tasks*) body='${tasksReply}' ;;
  *api/proc/active*) body="$(printf '%b' '${procReply}')" ;;
esac
if [ -n "$out" ]; then printf '%s' "$body" > "$out"; else printf '%s' "$body"; fi`;
    stub("curl", curlBody);
    // ssh: df probe -> 50G; python upload probe -> 0; anything else is the remote curl.
    stub("ssh", `
cmd="\${@: -1}"
case "$cmd" in
  df*) echo 50 ;;
  python3*) cat >/dev/null; echo 0 ;;
  *) ${join(bin, "curl")} $cmd ;;
esac`);
    stub("df", "printf 'h\\nx 1 1 50 1%% /\\n'");
    const r = spawnSync("bash", [SH], { encoding: "utf-8", env: { ...process.env, PATH: `${bin}:${process.env.PATH}`, LOCAL_DATA_ROOT: opts.root ?? dataRoot() } });
    return { code: r.status, out: r.stdout };
  }
  it("200 with idle queue on every node is deployable", () => {
    const r = runSh('{"host":true,"running":{"biliup":0}}\\n200');
    expect(r.out).toContain("OK 可以安全部署");
    expect(r.code).toBe(0);
  });
  it("running.biliup > 0 blocks with exit 1", () => {
    expect(runSh('{"host":true,"running":{"biliup":2}}\\n200').code).toBe(1);
  });
  it("503 waits with exit 2", () => {
    expect(runSh('{}\\n503').code).toBe(2);
  });
  it("old bundle (404) with no fresh upload proceeds", () => {
    expect(runSh('Not Found\\n404').code).toBe(0);
  });
  it("old bundle (404) with a fresh phase=uploading file blocks; a stale one does not", () => {
    expect(runSh('Not Found\\n404', { root: dataRoot(Date.now()) }).code).toBe(1);
    expect(runSh('Not Found\\n404', { root: dataRoot(Date.now() - 7 * 3600_000) }).code).toBe(0);
  });
  it("old bundle (404) with a missing stage dir is unknown, never 'no upload'", () => {
    expect(runSh('Not Found\\n404', { root: join(tmpdir(), "dpc-missing-root") }).code).toBe(2);
  });
});
