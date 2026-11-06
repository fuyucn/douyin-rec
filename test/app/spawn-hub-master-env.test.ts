// plan 046 PR6 rework: the serve-level hub flag reaches the record child by env (like the zero-disk payload).
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeRecordSpawner } from "../../packages/app/src/process/spawner.js";
import type { Task } from "../../packages/app/src/store.js";

const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));
const waitFor = async (fn: () => boolean): Promise<void> => {
  for (let i = 0; i < 200 && !fn(); i += 1) await wait(10);
  if (!fn()) throw new Error("timed out");
};

const mkTask = (): Task => ({
  id: 7, room: "12345", name: "anchor", quality: "origin", engine: "ffmpeg", danmu: 0, segmentSec: 1800,
  cookies: null, outDir: null, scheduleStart: null, scheduleEnd: null, status: "stopped", useCookie: false,
  rollingUpload: false, createdAt: "2026-06-12T00:00:00.000Z",
});

let dir: string;
let prevRoot: string | undefined;
let prevFlag: string | undefined;
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "drec-hub-env-"));
  prevRoot = process.env.DOUYIN_REC_ROOT;
  prevFlag = process.env.DOUYIN_REC_HUB_MASTER;
  process.env.DOUYIN_REC_ROOT = dir;
  delete process.env.DOUYIN_REC_HUB_MASTER;
});
afterEach(() => {
  if (prevRoot === undefined) delete process.env.DOUYIN_REC_ROOT;
  else process.env.DOUYIN_REC_ROOT = prevRoot;
  if (prevFlag === undefined) delete process.env.DOUYIN_REC_HUB_MASTER;
  else process.env.DOUYIN_REC_HUB_MASTER = prevFlag;
  rmSync(dir, { recursive: true, force: true });
});

/** Fake cli: dumps the env flag it received, then exits. */
function fakeCli(): { entry: string; dump: string } {
  const entry = join(dir, "cli.mjs");
  const dump = join(dir, "env.json");
  writeFileSync(entry, "import { writeFileSync } from 'node:fs';\n" +
    "writeFileSync(" + JSON.stringify(dump) + ", JSON.stringify({ flag: process.env.DOUYIN_REC_HUB_MASTER ?? null }));\n");
  return { entry, dump };
}

async function runSpawner(opts: { hubMaster?: () => boolean }): Promise<string | null> {
  const { entry, dump } = fakeCli();
  const proc = new NodeRecordSpawner({ cliEntry: entry, ...opts }).spawn(mkTask());
  let exited = false;
  proc.onExit(() => { exited = true; });
  proc.start();
  await waitFor(() => exited);
  return (JSON.parse(readFileSync(dump, "utf-8")) as { flag: string | null }).flag;
}

describe("NodeRecordSpawner hub-master env", () => {
  it("hub master -> DOUYIN_REC_HUB_MASTER=1 in the child", async () => {
    expect(await runSpawner({ hubMaster: () => true })).toBe("1");
  });
  it("not a hub master -> no flag (the node keeps uploading rule-bound rooms)", async () => {
    expect(await runSpawner({ hubMaster: () => false })).toBeNull();
  });
  it("no getter -> no flag (legacy spawn callers unchanged)", async () => {
    expect(await runSpawner({})).toBeNull();
  });
});

