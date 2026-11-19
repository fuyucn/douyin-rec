import { afterEach, beforeAll, beforeEach, describe, expect, it, vi } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdirSync, mkdtempSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { countVideoParts } from "../../packages/bilibili-upload/src/run-biliup.js";
import { SyncLedger } from "../../packages/orchestrator/src/ledger.js";
import { finalizeAfterUpload, type PipelineDeps } from "../../packages/orchestrator/src/pipeline.js";

const modulePath = resolve("dev/multi-node/fake-archive-view.mjs");
const bv = "BV" + "a".repeat(10);
const endpoint = (id = bv) => "https://api.bilibili.com/x/web-interface/view?bvid=" + id;
const headers = { Cookie: "SESSDATA=FAKE-DEV-SESSDATA; bili_jct=FAKE-DEV-JCT" }; // issue-guard: allow(known fake credentials for an isolated test)
const key = "douyin:fixture:2026-11-19";
let root: string, credentials: string, archive: string;
let createArchiveViewFetch: (env: NodeJS.ProcessEnv, forward: typeof fetch) => typeof fetch;
const fakeCredentials = { "drec-dev-fake": true, cookie_info: { cookies: [
  { name: "SESSDATA", value: "FAKE-DEV-SESSDATA" }, { name: "bili_jct", value: "FAKE-DEV-JCT" },
] } };
const forward = vi.fn<typeof fetch>(async () => new Response("forwarded"));
const env = (): NodeJS.ProcessEnv => ({ DREC_DEV: "1", DREC_DEV_ARCHIVE_VIEW: "1", DOUYIN_REC_ROOT: root });
const operation = (op: string, count: number) => ({ op, bv, files: Array.from({ length: count }, (_, i) => "part-" + i) });
function record(...entries: unknown[]) { writeFileSync(archive, entries.map((e) => JSON.stringify(e)).join("\n") + "\n"); }
function install() { vi.stubGlobal("fetch", createArchiveViewFetch(env(), forward)); }

beforeAll(async () => { ({ createArchiveViewFetch } = await import(modulePath)); });
beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "dev-archive-view-"));
  mkdirSync(join(root, "config/biliup"), { recursive: true });
  writeFileSync(join(root, ".drec-dev-e2e"), "internal fixture");
  credentials = join(root, "config/biliup/cookies.json");
  archive = join(root, "config/biliup/fake-archive.jsonl");
  writeFileSync(credentials, JSON.stringify(fakeCredentials));
  forward.mockClear();
});
afterEach(() => { vi.unstubAllGlobals(); rmSync(root, { recursive: true, force: true }); });

describe("offline archive view", () => {
  it("observes the real fake CLI output, append and repeated-upload reset", async () => {
    const cli = join(root, "fake.cjs");
    writeFileSync(cli, readFileSync("dev/multi-node/fake-biliup.js"));
    const invoke = (args: string[]) => {
      const result = spawnSync(process.execPath, [cli, "-u", credentials, ...args], { encoding: "utf8" });
      expect(result.status, result.stderr).toBe(0);
      return JSON.parse(readFileSync(archive, "utf8").trim().split("\n").at(-1)!).bv;
    };
    const id = invoke(["upload", "--title", "fixture", "first.mp4", "second.mp4"]);
    install();
    expect(await countVideoParts(id, credentials)).toBe(2);
    invoke(["append", "--vid", id, "third.mp4"]);
    expect(await countVideoParts(id, credentials)).toBe(3);
    expect(invoke(["upload", "--title", "fixture", "first.mp4"])).toBe(id);
    expect(await countVideoParts(id, credentials)).toBe(1);
    expect(forward).not.toHaveBeenCalled();
  });

  it.each(["missing", "corrupt", "empty-files", "orphan-append", "unknown-op", "unknown-id"])("fails closed for %s archives", async (mode) => {
    if (mode === "corrupt") writeFileSync(archive, "not-json\n");
    if (mode === "empty-files") record(operation("upload", 0));
    if (mode === "orphan-append") record(operation("append", 2));
    if (mode === "unknown-op") record(operation("upload", 2), operation("replace", 1));
    if (mode === "unknown-id") record({ ...operation("upload", 2), bv: "BV" + "b".repeat(10) });
    install();
    expect(await countVideoParts(bv, credentials)).toBeNull();
    expect(forward).not.toHaveBeenCalled();
  });

  it("refuses missing dev markers or non-fake credentials", () => {
    expect(() => createArchiveViewFetch({ ...env(), DREC_DEV: "0" }, forward)).toThrow();
    rmSync(join(root, ".drec-dev-e2e"));
    expect(() => createArchiveViewFetch(env(), forward)).toThrow();
    writeFileSync(join(root, ".drec-dev-e2e"), "internal fixture");
    writeFileSync(credentials, JSON.stringify({ ...fakeCredentials, "drec-dev-fake": false }));
    expect(() => createArchiveViewFetch(env(), forward)).toThrow();
  });

  it("rechecks credentials instead of fabricating success after replacement", async () => {
    record(operation("upload", 2));
    install();
    writeFileSync(credentials, "{}");
    expect(await countVideoParts(bv, credentials)).toBeNull();
    expect(forward).not.toHaveBeenCalled();
  });

  it("intercepts only the exact GET view endpoint and preserves other fetch calls", async () => {
    record(operation("upload", 2));
    const view = createArchiveViewFetch(env(), forward);
    for (const input of [endpoint(), new URL(endpoint()), new Request(endpoint())]) {
      expect((await (await view(input, { headers })).json()).data.pages).toHaveLength(2);
    }
    for (const input of ["https://example.invalid/", endpoint() + "&extra=1", endpoint().replace("https:", "http:"), endpoint().replace("/view?", "/view/other?")]) {
      expect(await (await view(input)).text()).toBe("forwarded");
    }
    expect(await (await view(endpoint(), { method: "POST" })).text()).toBe("forwarded");
    expect(forward).toHaveBeenCalledTimes(5);
  });

  it("loads in a real Node preload only when explicitly enabled", () => {
    record(operation("upload", 2));
    const script = "fetch(" + JSON.stringify(endpoint()) + "," + JSON.stringify({ headers }) + ").then(r=>r.json()).then(j=>console.log(j.data.pages.length))";
    const result = spawnSync(process.execPath, ["--import", modulePath, "-e", script], {
      env: { ...process.env, ...env() }, encoding: "utf8", timeout: 5000,
    });
    expect(result.status, result.stderr).toBe(0);
    expect(result.stdout.trim()).toBe("2");
    const refused = spawnSync(process.execPath, ["--import", modulePath, "-e", "console.log('must-not-run')"], {
      env: { ...process.env, ...env(), DREC_DEV: "0" }, encoding: "utf8", timeout: 5000,
    });
    expect(refused.status, refused.stderr).not.toBe(0);
    expect(refused.stderr).toContain("Archive view requires");
    expect(refused.stdout).not.toContain("must-not-run");
    const disabled = spawnSync(process.execPath, ["--import", modulePath, "-e", "console.log('unmodified')"], {
      env: { ...process.env, DREC_DEV_ARCHIVE_VIEW: "0", DREC_DEV: "0" }, encoding: "utf8", timeout: 5000,
    });
    expect(disabled.status, disabled.stderr).toBe(0);
    expect(disabled.stdout.trim()).toBe("unmodified");
  });

  it("disables the hook in both real-interaction compose overlays", () => {
    for (const mode of ["egress", "mirror"]) {
      expect(readFileSync("dev/multi-node/compose." + mode + ".yml", "utf8")).toMatch(/DREC_DEV_ARCHIVE_VIEW:\s*["']?0/);
    }
  });

  it("refuses a real or missing request credential without forwarding it", async () => {
    record(operation("upload", 2));
    const view = createArchiveViewFetch(env(), forward);
    for (const requestHeaders of [{}, { Cookie: "SESSDATA=not-a-dev-value" }, { Cookie: headers.Cookie + "; SESSDATA=not-a-dev-value" }]) {
      expect((await view(endpoint(), { headers: requestHeaders })).ok).toBe(false);
    }
    expect(forward).not.toHaveBeenCalled();
  });

  it.each([["match", 2], ["short", 1], ["excess", 3], ["unknown", null]] as const)("keeps the real finalization gate strict for %s", async (_label, count) => {
    if (count !== null) record(operation("upload", count));
    install();
    const ledger = new SyncLedger(join(root, "sync.db"));
    try {
      ledger.upsertPending(key);
      for (const state of ["syncing", "merging", "uploading"] as const) ledger.setState(key, state);
      ledger.markPartDone(key, "plain", 0); ledger.markPartDone(key, "plain", 1);
      const source = join(root, "source-video"), stage = join(root, "stage-video");
      writeFileSync(source, "fixture source"); writeFileSync(stage, "fixture stage");
      const cleanup = vi.fn(async () => { rmSync(source); rmSync(stage); return { ok: true, failed: [] }; });
      const commitDone = vi.fn(() => ledger.markDone(key, bv));
      const notify = vi.fn();
      const result = await finalizeAfterUpload({
        streamKey: key, bv, on: { plain: true, danmu: false, livechat: false }, log: () => {},
        cleanupSources: cleanup, commitDone, notify,
        deps: { ledger, countParts: (id: string) => countVideoParts(id, credentials), sideCheckDelayMs: 0 } as PipelineDeps,
      });
      expect(ledger.get(key)?.state).toBe(count === 2 ? "done" : "needs_manual");
      expect(cleanup).toHaveBeenCalledTimes(count === 2 ? 1 : 0);
      expect(commitDone).toHaveBeenCalledTimes(count === 2 ? 1 : 0);
      expect(existsSync(source)).toBe(count !== 2); expect(existsSync(stage)).toBe(count !== 2);
      expect(Boolean(result.blocked)).toBe(count !== 2);
      expect(notify).toHaveBeenCalledTimes(count === 2 ? 0 : 1);
    } finally { ledger.close(); }
  });
});
