import { afterAll, afterEach, beforeAll, beforeEach, expect, it } from "vitest";
import { execFile, spawnSync } from "node:child_process";
import { mkdtempSync, readdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { basename, dirname, join } from "node:path";
import { fileURLToPath } from "node:url";
import { promisify } from "node:util";
import { build } from "esbuild";
import { withFileLockSync } from "@drec/core";
import type { Operation, Receipt } from "./hub-config-transaction-child.js";

const repo = fileURLToPath(new URL("../../", import.meta.url));
const exec = promisify(execFile);
const childOptions = { encoding: "utf8", timeout: 4_000, killSignal: "SIGKILL" } as const;
let bundleDir: string;
let childJs: string;
let dir: string;
let cfg: string;

beforeAll(async () => {
  bundleDir = mkdtempSync(join(tmpdir(), "hub-config-child-"));
  childJs = join(bundleDir, "child.mjs");
  await build({
    entryPoints: [join(repo, "test/app/hub-config-transaction-child.ts")],
    bundle: true, platform: "node", format: "esm", outfile: childJs,
    alias: { "@drec/core": join(repo, "packages/core/src/index.ts") },
    banner: { js: "import{createRequire as __cr}from'module';const require=__cr(import.meta.url);" },
  });
});
afterAll(() => rmSync(bundleDir, { recursive: true, force: true }));
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "hub-config-tx-"));
  cfg = join(dir, "hub.config.json");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

async function concurrentWrites(...writers: Operation[][]): Promise<Receipt[]> {
  const startAt = String(Date.now() + 200);
  const results = await Promise.allSettled(writers.map((ops) =>
    exec(process.execPath, [childJs, cfg, startAt, JSON.stringify(ops)], childOptions),
  ));
  return results.map((result) => {
    if (result.status === "rejected") throw result.reason;
    return JSON.parse(result.value.stdout) as Receipt;
  });
}

function expectUniqueTemps(receipts: Receipt[], count: number): void {
  const paths = receipts.flatMap((receipt) => receipt.temps);
  expect(paths).toHaveLength(count);
  expect(new Set(paths).size).toBe(count);
  for (const path of paths) {
    expect(dirname(path)).toBe(dirname(cfg));
    expect(path.endsWith(".tmp")).toBe(true);
    expect(basename(path)).not.toBe(`.${basename(cfg)}.tmp`);
  }
}

it("两个进程交替写 worker/resources:保留全部回执、未知字段与迁移后的旧节点", async () => {
  const legacy = { id: "local", name: "原有节点", kind: "local", dataRoot: "/test", extension: true };
  writeFileSync(cfg, JSON.stringify({ tenants: [legacy], resources: { extension: "keep" }, extra: { keep: true } }));
  const fixedTmp = `.${basename(cfg)}.tmp`;
  writeFileSync(join(dir, fixedTmp), "legacy tmp sentinel");
  const receipts = await concurrentWrites(
    [{ name: "A1" }, { resources: { maxCpuParallel: 4 } }, { name: "A2" }, { resources: { minBurnFreeMemMB: 128 } }],
    [{ resources: { maxNetParallel: 3 } }, { name: "B1" }, { resources: { minMergeFreeMemMB: 256 } }, { name: "B2" }],
  );
  const workers = receipts.flatMap((receipt) => receipt.workers).sort((a, b) => a.id.localeCompare(b.id));
  expect(workers.map((w) => w.id)).toEqual(["worker-1", "worker-2", "worker-3", "worker-4"]);
  expect(workers.map((w) => w.name).sort()).toEqual(["A1", "A2", "B1", "B2"]);
  const patches = receipts.flatMap((receipt) => receipt.resources);
  expect(patches).toHaveLength(4);
  const resources = Object.assign({ extension: "keep" }, ...patches);
  expect(resources).toEqual({ extension: "keep", maxCpuParallel: 4, maxNetParallel: 3, minBurnFreeMemMB: 128, minMergeFreeMemMB: 256 });
  expect(JSON.parse(readFileSync(cfg, "utf8"))).toEqual({
    extra: { keep: true }, workerSeq: 4, workers: [legacy, ...workers], resources,
  });
  expectUniqueTemps(receipts, 8);
  expect(readFileSync(join(dir, fixedTmp), "utf8")).toBe("legacy tmp sentinel");
  expect(readdirSync(dir).sort()).toEqual([fixedTmp, basename(cfg)].sort());
});

it("两个进程同时首次创建 worker:跨进程序号不冲突,缺失父目录也只生成一个配置", async () => {
  cfg = join(dir, "config", basename(cfg));
  const receipts = await concurrentWrites([{ name: "A" }], [{ name: "B" }]);
  const workers = receipts.flatMap((receipt) => receipt.workers).sort((a, b) => a.id.localeCompare(b.id));
  expect(workers.map((w) => w.id)).toEqual(["worker-1", "worker-2"]);
  expect(workers.map((w) => w.name).sort()).toEqual(["A", "B"]);
  expect(JSON.parse(readFileSync(cfg, "utf8"))).toEqual({ workers, workerSeq: 2 });
  expectUniqueTemps(receipts, 2);
  expect(readdirSync(dirname(cfg))).toEqual([basename(cfg)]);
});

function expectBusy(operation: Operation): void {
  const result = spawnSync(process.execPath, [childJs, cfg, "0", JSON.stringify([operation])], childOptions);
  expect(result.error).toBeUndefined(); // 必须由 store 明确失败,不能被测试的保险超时杀掉
  expect(result.status).toBe(1);
  expect(result.stderr).toContain(`file lock busy: ${cfg}.lock`);
  expect(result.stdout).toBe("");
}

it("持锁进程未退出:两个 store 均超时失败,不提交且不移除持有者的锁", () => {
  const original = '{ "extra": true }\n';
  writeFileSync(cfg, original);
  withFileLockSync(cfg, () => {
    const lock = readFileSync(`${cfg}.lock`, "utf8");
    expectBusy({ name: "blocked" });
    expectBusy({ resources: { maxCpuParallel: 4 } });
    expect(readFileSync(`${cfg}.lock`, "utf8")).toBe(lock);
  });
  expect(readFileSync(cfg, "utf8")).toBe(original);
  expect(readdirSync(dir)).toEqual([basename(cfg)]);
}, 10_000);

it("持锁进程异常退出:遗留锁 fail-closed,不会自动接管或创建配置", async () => {
  await exec(process.execPath, [childJs, cfg, "0", "abandon"], childOptions);
  const lock = readFileSync(`${cfg}.lock`, "utf8");
  expectBusy({ resources: { maxCpuParallel: 4 } });
  expect(readFileSync(`${cfg}.lock`, "utf8")).toBe(lock);
  expect(readdirSync(dir)).toEqual([`${basename(cfg)}.lock`]);
}, 10_000);
