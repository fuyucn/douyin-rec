/**
 * Issue #47: per-task cookies / webhook are credentials.
 *  - every task-returning API path returns them redacted (shared `redactTaskSecrets`)
 *  - PATCH semantics: absent = keep, explicit empty/null = clear
 *  - the recorder child gets the webhook through a 0600 file, never argv
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { redactTaskSecrets } from "../../packages/core/src/task-redact.js";
import { TaskStore } from "../../packages/app/src/store.js";
import { makeApi, type ManagerLike } from "../../packages/app/src/web/api.js";
import { NodeRecordSpawner } from "../../packages/app/src/process/spawner.js";
import { credentialDir, sweepCredentialFiles, writeCredentialFile } from "../../packages/app/src/process/credential-file.js";
import { upsertHubRule } from "../../packages/app/src/hub-store.js";
import type { Task } from "../../packages/app/src/store.js";

const COOKIE = "sessionid=TOP-SECRET-COOKIE"; // issue-guard: allow
const HOOK = "https://discord.com/api/webhooks/123/TOP-SECRET-HOOK";

const manager: ManagerLike = {
  runningIds: () => [],
  isRunning: () => false,
  start: () => true,
  stop: async () => {},
  stopWithin: async () => true,
  stopGraceful: async () => {},
  isStopping: () => false,
  getRuntime: () => ({ running: false, startedAt: null, elapsedMs: null, anchorName: null }),
  getAnchorName: () => null,
  isRecording: () => false,
  getLogs: () => [],
} as unknown as ManagerLike;

function leaks(body: unknown): boolean {
  const s = JSON.stringify(body);
  return s.includes("TOP-SECRET-COOKIE") || s.includes("TOP-SECRET-HOOK");
}

describe("redactTaskSecrets", () => {
  it("nulls values and reports presence", () => {
    const r = redactTaskSecrets({ id: 1, cookies: COOKIE, webhook: HOOK });
    expect(r).toEqual({ id: 1, cookies: null, webhook: null, hasCookies: true, hasWebhook: true });
  });
  it("blank / null secrets report not-set", () => {
    const r = redactTaskSecrets({ cookies: "  ", webhook: null });
    expect(r.hasCookies).toBe(false);
    expect(r.hasWebhook).toBe(false);
  });
});

describe("task API never returns secrets", () => {
  let store: TaskStore;
  let hubDir: string;
  let api: ReturnType<typeof makeApi>;
  beforeEach(() => {
    store = new TaskStore(":memory:");
    hubDir = mkdtempSync(join(tmpdir(), "drec-secrets-"));
    api = makeApi({ store, manager, hubDir });
  });
  afterEach(() => rmSync(hubDir, { recursive: true, force: true }));

  const seed = (): number => (api.createTask({ room: "123456", cookies: COOKIE, webhook: HOOK }).body as { id: number }).id;

  it("create response is redacted", () => {
    const r = api.createTask({ room: "123456", cookies: COOKIE, webhook: HOOK });
    expect(r.status).toBe(201);
    expect(leaks(r.body)).toBe(false);
    expect(r.body).toMatchObject({ cookies: null, webhook: null, hasCookies: true, hasWebhook: true });
    // ...but the secrets are really stored
    expect(store.getTask((r.body as { id: number }).id)).toMatchObject({ cookies: COOKIE, webhook: HOOK });
  });

  it("list, detail, update, start, stop, drain, room views are redacted", async () => {
    const id = seed();
    upsertHubRule(hubDir, { room: "https://live.douyin.com/123456", enabled: true, sourceTaskId: id, workers: ["local"] } as never);
    const bodies = [
      api.listTasks().body,
      api.getTask(id).body,
      api.updateTask(id, { name: "x" }).body,
      api.startTask(id).body,
      (await api.stopTask(id)).body,
      api.listRooms().body,
      api.getRoom("douyin.123456").body,
    ];
    for (const b of bodies) expect(leaks(b)).toBe(false);
    expect(api.listTasks().body).toMatchObject([{ hasCookies: true, hasWebhook: true }]);
    const room = api.getRoom("douyin.123456").body as { recording: Record<string, unknown> };
    expect(room.recording).toMatchObject({ cookies: null, webhook: null, hasCookies: true, hasWebhook: true });
  });

  it("every zero-arg list*/get* API method is leak-free", () => {
    seed();
    for (const [name, fn] of Object.entries(api)) {
      if (!/^(list|get)/.test(name) || (fn as (...a: unknown[]) => unknown).length !== 0) continue;
      let out: unknown;
      try { out = (fn as () => unknown)(); } catch { continue; }
      if (out && typeof (out as Promise<unknown>).then === "function") continue;
      expect(leaks(out), name).toBe(false);
    }
  });

  it("PATCH without the field keeps the stored secrets", () => {
    const id = seed();
    api.updateTask(id, { name: "renamed", quality: "hd" });
    expect(store.getTask(id)).toMatchObject({ cookies: COOKIE, webhook: HOOK });
  });

  it("explicit empty string / null clears", () => {
    const id = seed();
    api.updateTask(id, { webhook: "", cookies: null });
    expect(store.getTask(id)).toMatchObject({ cookies: null, webhook: null });
    const r = api.getTask(id).body;
    expect(r).toMatchObject({ hasCookies: false, hasWebhook: false });
  });

  it("room PUT without webhook keeps it; with empty clears", () => {
    const id = seed();
    api.updateRoom("douyin.123456", { recording: { quality: "hd" } });
    expect(store.getTask(id)!.webhook).toBe(HOOK);
    api.updateRoom("douyin.123456", { recording: { webhook: "" } });
    expect(store.getTask(id)!.webhook).toBeNull();
  });
});

describe("spawn keeps the webhook out of argv", () => {
  let root: string;
  let prevRoot: string | undefined;
  beforeEach(() => {
    root = mkdtempSync(join(tmpdir(), "drec-hook-"));
    prevRoot = process.env.DOUYIN_REC_ROOT;
    process.env.DOUYIN_REC_ROOT = root;
  });
  afterEach(() => {
    if (prevRoot === undefined) delete process.env.DOUYIN_REC_ROOT;
    else process.env.DOUYIN_REC_ROOT = prevRoot;
    rmSync(root, { recursive: true, force: true });
  });

  function mkTask(over: Partial<Task> = {}): Task {
    return {
      id: 9, room: "12345", name: "a", quality: "origin", engine: "ffmpeg", danmu: 1, segmentSec: 1800,
      cookies: null, outDir: null, scheduleStart: null, scheduleEnd: null, status: "stopped",
      useCookie: true, rollingUpload: false, createdAt: "2026-06-12T00:00:00.000Z", webhook: HOOK, ...over,
    } as Task;
  }

  /** Fake cli: dumps argv plus the content/mode of --discord-webhook-file, then exits. */
  function fakeCli(): { entry: string; dump: string } {
    const dir = mkdtempSync(join(tmpdir(), "drec-fakecli-"));
    const entry = join(dir, "cli.mjs");
    const dump = join(dir, "dump.json");
    writeFileSync(entry, `import { readFileSync, statSync, writeFileSync } from "node:fs";
const argv = process.argv.slice(2);
const i = argv.indexOf("--discord-webhook-file");
const out = { argv };
if (i >= 0) { const f = argv[i + 1]; out.file = f; out.content = readFileSync(f, "utf-8"); out.mode = statSync(f).mode & 0o777; }
writeFileSync(${JSON.stringify(dump)}, JSON.stringify(out));
`);
    return { entry, dump };
  }

  const waitFor = async (pred: () => boolean): Promise<void> => {
    const t0 = Date.now();
    while (!pred()) {
      if (Date.now() - t0 > 5000) throw new Error("waitFor timeout");
      await new Promise((r) => setTimeout(r, 25));
    }
  };

  it("argv has no webhook; child reads it from a 0600 file; file removed after exit", async () => {
    const { entry, dump } = fakeCli();
    const spawner = new NodeRecordSpawner({ cliEntry: entry });
    const p = spawner.spawn(mkTask());
    p.start();
    await waitFor(() => existsSync(dump));
    const out = JSON.parse(readFileSync(dump, "utf-8")) as { argv: string[]; file: string; content: string; mode: number };
    expect(out.argv.join(" ")).not.toContain("TOP-SECRET-HOOK");
    expect(out.argv).not.toContain("--discord-webhook");
    expect(out.content).toBe(HOOK);
    expect(out.mode).toBe(0o600);
    await waitFor(() => !existsSync(out.file));
  });

  it("global (getter) webhook also goes through the file", async () => {
    const { entry, dump } = fakeCli();
    const spawner = new NodeRecordSpawner({ cliEntry: entry, webhook: () => HOOK });
    spawner.spawn(mkTask({ webhook: null })).start();
    await waitFor(() => existsSync(dump));
    const out = JSON.parse(readFileSync(dump, "utf-8")) as { argv: string[]; content: string };
    expect(out.argv.join(" ")).not.toContain("TOP-SECRET-HOOK");
    expect(out.content).toBe(HOOK);
  });

  it("no webhook anywhere → no flag, no file", () => {
    const { entry } = fakeCli();
    new NodeRecordSpawner({ cliEntry: entry }).spawn(mkTask({ webhook: null })).start();
    expect(existsSync(join(credentialDir(), "record-9.webhook.cred"))).toBe(false);
  });

  it("startup sweep also removes stale webhook credential files", () => {
    const f = writeCredentialFile(3, HOOK, "webhook");
    expect(existsSync(f)).toBe(true);
    expect(sweepCredentialFiles().removed).toBe(1);
    expect(existsSync(f)).toBe(false);
  });
});
