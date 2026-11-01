// plans/036 T3 验收:真多进程(child_process)—— 并发首开迁移幂等(F3)、并发 claim 互斥(F4/V1)。
import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { execFile } from "node:child_process";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { build } from "esbuild";
import { makeEnv, type Env } from "./helpers.js";

const REPO = fileURLToPath(new URL("../../", import.meta.url));
let bundleDir: string;
let childJs: string;

beforeAll(async () => {
  bundleDir = mkdtempSync(join(tmpdir(), "procq-child-"));
  childJs = join(bundleDir, "child.mjs");
  await build({
    entryPoints: [join(REPO, "test/proc-queue/child-worker.ts")],
    bundle: true, platform: "node", format: "esm", outfile: childJs, logLevel: "silent",
    alias: {
      "@drec/core": join(REPO, "packages/core/src/index.ts"),
      "@drec/proc-queue": join(REPO, "packages/proc-queue/src/index.ts"),
    },
    // core 间接依赖 CJS(yaml):ESM 产物需 createRequire 垫片(与 esbuild.config.mjs 同理)。
    banner: { js: "import{createRequire as __cr}from'module';const require=__cr(import.meta.url);" },
    external: ["node:*"],
  });
}, 60_000);
afterAll(() => rmSync(bundleDir, { recursive: true, force: true }));

interface ChildResult { code: number; out: string; err: string }
function spawnChild(mode: string, db: string, startAt: number, owner = "A"): Promise<ChildResult> {
  return new Promise((resolve) => {
    execFile(process.execPath, [childJs, mode, db, String(startAt), owner], (e, out, err) => {
      resolve({ code: e ? Number((e as NodeJS.ErrnoException & { code?: number }).code ?? 1) : 0, out, err });
    });
  });
}

describe("多进程", () => {
  let env: Env;
  const fresh = (): Env => (env = makeEnv());

  it("并发首开迁移幂等:3 进程 × 40 轮,全部成功(F3:修前 2 进程 100 轮约 43 轮 database is locked)", async () => {
    for (let round = 0; round < 40; round++) {
      fresh();
      try {
        const startAt = Date.now() + 150;
        const rs = await Promise.all([0, 1, 2].map(() => spawnChild("open", env.dbPath, startAt)));
        const bad = rs.filter((r) => r.code !== 0);
        expect(bad.map((r) => r.err), `round ${round}`).toEqual([]);
        expect(env.open().list()).toEqual([]); // 迁移后表可用
      } finally {
        env.cleanup();
      }
    }
  }, 120_000);

  it("并发 claim:4 进程抢 24 行,每行恰好被认领一次(attempts=1)", async () => {
    fresh();
    try {
      const s = env.open();
      expect(s.acquireLease("fake", "A", { pid: process.pid, leaseMs: 600_000 }).acquired).toBe(true);
      const roots = { allowedRoots: [env.root] };
      const ids = Array.from({ length: 24 }, (_, i) => s.enqueue(env.job(`f${i}.ts`), roots).jobId);
      // 真实时钟:子进程的 store 用 Date.now,父进程的租约也要用真实时间(env.open 的 now 是假时钟,此处只读)。
      const startAt = Date.now() + 200;
      const rs = await Promise.all([0, 1, 2, 3].map(() => spawnChild("claim", env.dbPath, startAt)));
      expect(rs.map((r) => r.err)).toEqual(["", "", "", ""]);
      const claimed = rs.flatMap((r) => JSON.parse(r.out) as string[]);
      expect(claimed.sort()).toEqual([...ids].sort()); // 无重复、无遗漏
      expect(s.list({ state: "running" }).every((r) => r.attempts === 1)).toBe(true);
    } finally {
      env.cleanup();
    }
  }, 60_000);

  it("并发 acquireLease:两进程同时抢同一个空 kind,恰一个 acquired(#432:读-判定-写在事务内)", async () => {
    for (let round = 0; round < 5; round++) {
      fresh();
      try {
        env.open(); // 建库(WAL/迁移),子进程连同一个 db
        const startAt = Date.now() + 120;
        const rs = await Promise.all([0, 1].map((i) => spawnChild("acquire", env.dbPath, startAt, i === 0 ? "A" : "B")));
        expect(rs.map((r) => r.err), `round ${round}`).toEqual(["", ""]);
        const got = rs.map((r) => JSON.parse(r.out) as { acquired: boolean });
        expect(got.filter((r) => r.acquired), `round ${round}`).toHaveLength(1);
      } finally {
        env.cleanup();
      }
    }
  }, 60_000);
});
