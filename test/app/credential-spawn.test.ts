import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, statSync, existsSync, readdirSync, rmSync, chmodSync, mkdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { NodeRecordSpawner } from "../../packages/app/src/process/spawner.js";
import {
  credentialDir,
  writeCredentialFile,
} from "../../packages/app/src/process/credential-file.js";
import type { Task } from "../../packages/app/src/store.js";

const SECRET = "sessionid=SUPER-SECRET-VALUE";
const wait = (ms: number): Promise<void> => new Promise((r) => setTimeout(r, ms));

function mkTask(over: Partial<Task> = {}): Task {
  return {
    id: 7,
    room: "12345",
    name: "anchor",
    quality: "origin",
    engine: "ffmpeg",
    danmu: 1,
    segmentSec: 1800,
    cookies: SECRET,
    outDir: null,
    scheduleStart: null,
    scheduleEnd: null,
    status: "stopped",
    useCookie: true,
    rollingUpload: false,
    createdAt: "2026-06-12T00:00:00.000Z",
    ...over,
  };
}

let root: string;
let prevRoot: string | undefined;

beforeEach(() => {
  root = mkdtempSync(join(tmpdir(), "drec-cred-"));
  prevRoot = process.env.DOUYIN_REC_ROOT;
  process.env.DOUYIN_REC_ROOT = root;
});

afterEach(() => {
  if (prevRoot === undefined) delete process.env.DOUYIN_REC_ROOT;
  else process.env.DOUYIN_REC_ROOT = prevRoot;
  rmSync(root, { recursive: true, force: true });
});

/** 假 cli 入口:把收到的 argv 与 --cookies-file 的内容/权限原样写到 dump,然后按 mode 退出或挂起。 */
function writeFakeCli(mode: "exit" | "hang"): { entry: string; dump: string } {
  const dir = mkdtempSync(join(tmpdir(), "drec-fakecli-"));
  const entry = join(dir, "cli.mjs");
  const dump = join(dir, "dump.json");
  writeFileSync(
    entry,
    `import { readFileSync, statSync, writeFileSync } from "node:fs";
const argv = process.argv.slice(2);
const i = argv.indexOf("--cookies-file");
const out = { argv };
if (i >= 0) {
  const f = argv[i + 1];
  out.file = f;
  out.content = readFileSync(f, "utf-8");
  out.mode = statSync(f).mode & 0o777;
}
writeFileSync(${JSON.stringify(dump)}, JSON.stringify(out));
${mode === "hang" ? "setInterval(() => {}, 1e9);" : ""}
`,
  );
  return { entry, dump };
}

async function waitFor(pred: () => boolean, ms = 5000): Promise<void> {
  const t0 = Date.now();
  while (!pred()) {
    if (Date.now() - t0 > ms) throw new Error("waitFor timeout");
    await wait(25);
  }
}

describe("writeCredentialFile", () => {
  it("原子写入:内容正确、文件 0600、目录 0700、无残留 .tmp", () => {
    const path = writeCredentialFile(3, SECRET);
    expect(readFileSync(path, "utf-8")).toBe(SECRET);
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(statSync(credentialDir()).mode & 0o777).toBe(0o700);
    expect(readdirSync(credentialDir()).filter((f) => f.endsWith(".tmp"))).toEqual([]);
  });

  it("覆盖已存在的宽权限文件 → 仍是 0600", () => {
    const dir = credentialDir();
    mkdirSync(dir, { recursive: true });
    const p = join(dir, "record-3.cred");
    writeFileSync(p, "old");
    chmodSync(p, 0o644);
    writeCredentialFile(3, SECRET);
    expect(statSync(p).mode & 0o777).toBe(0o600);
    expect(readFileSync(p, "utf-8")).toBe(SECRET);
  });

  it("写失败 → 抛明确错误(不吞)", () => {
    // 数据根本身是个普通文件 → mkdir <root>/run 必失败
    const bad = join(root, "not-a-dir");
    writeFileSync(bad, "x");
    process.env.DOUYIN_REC_ROOT = bad;
    expect(() => writeCredentialFile(3, SECRET)).toThrow();
  });
});

describe("NodeRecordSpawner 登录凭证走文件", () => {
  it("argv 无凭证原文;子进程读到 0600 文件;退出后文件被清理", async () => {
    const { entry, dump } = writeFakeCli("exit");
    const proc = new NodeRecordSpawner({ cliEntry: entry }).spawn(mkTask());
    let exited = false;
    proc.onExit(() => { exited = true; });
    proc.start();
    await waitFor(() => exited);

    const seen = JSON.parse(readFileSync(dump, "utf-8"));
    expect(seen.argv.join("\0")).not.toContain("SUPER-SECRET-VALUE");
    expect(seen.argv).not.toContain("--cookies");
    expect(seen.content).toBe(SECRET);
    expect(seen.mode).toBe(0o600);
    expect(existsSync(seen.file)).toBe(false);
  });

  it("硬停(SIGTERM)后同样清理文件", async () => {
    const { entry, dump } = writeFakeCli("hang");
    const proc = new NodeRecordSpawner({ cliEntry: entry }).spawn(mkTask());
    proc.start();
    await waitFor(() => existsSync(dump));
    const seen = JSON.parse(readFileSync(dump, "utf-8"));
    expect(existsSync(seen.file)).toBe(true); // 运行期间文件在
    await proc.stop();
    expect(existsSync(seen.file)).toBe(false);
  });

  it("崩溃退出(非 0)同样清理文件", async () => {
    const dir = mkdtempSync(join(tmpdir(), "drec-fakecli-"));
    const entry = join(dir, "crash.mjs");
    writeFileSync(entry, "process.exit(3);");
    const proc = new NodeRecordSpawner({ cliEntry: entry }).spawn(mkTask());
    let exited = false;
    proc.onExit(() => { exited = true; });
    proc.start();
    await waitFor(() => exited);
    expect(readdirSync(credentialDir())).toEqual([]);
  });

  it("task.cookies 为空(useCookie=false 解析结果)→ 不生成文件、不带 --cookies-file", async () => {
    const { entry, dump } = writeFakeCli("exit");
    const proc = new NodeRecordSpawner({ cliEntry: entry }).spawn(mkTask({ cookies: null }));
    let exited = false;
    proc.onExit(() => { exited = true; });
    proc.start();
    await waitFor(() => exited);
    const seen = JSON.parse(readFileSync(dump, "utf-8"));
    expect(seen.argv).not.toContain("--cookies-file");
    expect(seen.file).toBeUndefined();
    expect(existsSync(credentialDir())).toBe(false);
  });

  it("凭证文件写失败 → spawn 抛错,不回退 argv、不启动子进程", () => {
    const bad = join(root, "not-a-dir");
    writeFileSync(bad, "x");
    process.env.DOUYIN_REC_ROOT = bad;
    const { entry } = writeFakeCli("exit");
    expect(() => new NodeRecordSpawner({ cliEntry: entry }).spawn(mkTask())).toThrow(/凭证/);
  });
});
