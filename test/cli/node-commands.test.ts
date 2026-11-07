/**
 * node-commands.test.ts — the node command registry (plans/042 Task 1).
 *
 * The registry is the single implementation behind both the hidden `_xxx` CLI commands (master over ssh)
 * and the fleet long connection. Its stdout must stay byte-for-byte what the CLI printed before, because
 * `SshTransport` parses it unchanged.
 *
 * vitest cannot import `@drec/app` (platform package ESM interop, see AGENTS.md), so commands backed by the
 * app layer (tasks / node-status / notify-outbox / proc-* / enqueue / inventory / apply-tasks) are covered
 * by the stdout parity check against the previous bundle (see the PR), not here.
 */
import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, mkdirSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NODE_COMMANDS, notifyOutboxArgs } from "../../packages/cli/src/node-commands.js";

const roots: string[] = [];
const original = process.env.DOUYIN_REC_ROOT;
afterEach(() => {
  for (const r of roots.splice(0)) rmSync(r, { recursive: true, force: true });
  if (original === undefined) delete process.env.DOUYIN_REC_ROOT;
  else process.env.DOUYIN_REC_ROOT = original;
});

function makeRoot(): string {
  const root = mkdtempSync(join(tmpdir(), "drec-node-cmd-"));
  roots.push(root);
  mkdirSync(join(root, "db"), { recursive: true });
  return root;
}

const oneJsonLine = (stdout: string): unknown => {
  expect(stdout.endsWith("\n")).toBe(true);
  expect(stdout.slice(0, -1)).not.toContain("\n");
  return JSON.parse(stdout);
};

describe("NODE_COMMANDS", () => {
  it("apply-tasks: legacy no-spool spec → warnings travel in the JSON receipt; store keeps spool=true", async () => {
    const root = makeRoot();
    const spec = {
      platform: "douyin", roomSlug: "424242", room: "https://live.douyin.com/424242",
      name: "A", quality: "origin", engine: "ffmpeg", danmu: 1, segmentSec: 1800,
      scheduleStart: null, scheduleEnd: null, enabled: true, useCookie: true,
      cookies: null, outDir: null, webhook: null, anchorName: null, rollingUpload: false,
      streamUpload: true, streamUploadSpool: false,
    };
    const b64 = Buffer.from(JSON.stringify({ desired: [spec] }), "utf-8").toString("base64");
    // The real hidden-command entry (not applyTasksPayload directly): stdout must stay the
    // parsed JSON contract, with the compatibility warning inside result.warnings.
    const r = await NODE_COMMANDS["apply-tasks"](root, [b64]);
    expect(r.exitCode).toBe(0);
    const out = oneJsonLine(r.stdout) as { applied: string[]; warnings?: string[] };
    expect(out.applied).toEqual(["douyin:424242"]);
    expect(out.warnings ?? []).toHaveLength(1);
    expect(out.warnings![0]).toContain("旧 master 下发了已废弃的真 0 落盘");
    expect(out.warnings![0]).not.toContain("424242"); // no room number leaks
    const { TaskStore } = await import("../../packages/app/src/store.js");
    const store = new TaskStore(join(root, "db", "douyin-rec.db"));
    try {
      expect(store.listTasks()[0]).toMatchObject({ streamUpload: true, streamUploadSpool: true });
    } finally {
      store.close();
    }
  });

  it("disk: existing root → {freeGB} and exit 0", async () => {
    const r = await NODE_COMMANDS.disk(makeRoot(), []);
    expect(r.exitCode).toBe(0);
    const out = oneJsonLine(r.stdout) as { freeGB: number };
    expect(typeof out.freeGB).toBe("number");
  });

  it("disk: missing root → {error} and exit 1 (not a throw)", async () => {
    const r = await NODE_COMMANDS.disk(join(tmpdir(), "drec-definitely-missing-root"), []);
    expect(r.exitCode).toBe(1);
    expect(oneJsonLine(r.stdout)).toHaveProperty("error");
  });




  it("is-done: no recorder process for the room → \"true\\n\"", async () => {
    const r = await NODE_COMMANDS["is-done"](makeRoot(), ["no-such-room"]);
    expect(r).toEqual({ stdout: "true\n", exitCode: 0 });
  });

  it("recording-status: no recorder processes → {rooms: [], rolling: []}", async () => {
    const r = await NODE_COMMANDS["recording-status"](makeRoot(), []);
    expect(r.exitCode).toBe(0);
    expect(oneJsonLine(r.stdout)).toEqual({ rooms: [], finalizing: [], rolling: [] });
  });

  it("task-logs: non-numeric taskId → error payload with exit 0", async () => {
    const r = await NODE_COMMANDS["task-logs"](makeRoot(), ["abc", "10"]);
    expect(r.exitCode).toBe(0);
    expect(oneJsonLine(r.stdout)).toEqual({ lines: [], error: "taskId 非法: abc" });
  });

});

describe("hidden CLI commands", () => {
  it("every registry command is wired to its hidden CLI command through runNodeCommandCli (no second implementation)", () => {
    const src = ["cli.ts", "node-pipeline-commands.ts"]
      .map((f) => readFileSync(join(__dirname, "../../packages/cli/src", f), "utf8"))
      .join("\n");
    for (const name of Object.keys(NODE_COMMANDS)) {
      expect(src, `_${name}`).toContain(`.command("_${name} `);
      expect(src, name).toContain(`runNodeCommandCli("${name}"`);
    }
  });
});

describe("notifyOutboxArgs", () => {
  it("omits absent options and keeps order --after --limit --ack", () => {
    expect(notifyOutboxArgs({})).toEqual([]);
    expect(notifyOutboxArgs({ ack: "1,2", after: "3" })).toEqual(["--after", "3", "--ack", "1,2"]);
  });
});
