// 真多进程夹具:存储与文件系统操作均为真实实现,只探测严格读和 rename 时的锁归属。
import assert from "node:assert/strict";
import fs from "node:fs";
import { syncBuiltinESMExports } from "node:module";
import { withFileLockSync, type HubResources, type WorkerConfig } from "@drec/core";
import { writeResources } from "../../packages/app/src/hub-config-store.js";
import { createWorker } from "../../packages/app/src/worker-store.js";

export type Operation = { name: string } | { resources: Partial<HubResources> };
export interface Receipt {
  workers: WorkerConfig[];
  resources: Partial<HubResources>[];
  temps: string[];
}

const [cfg, startAt, input] = process.argv.slice(2);
if (input === "abandon") withFileLockSync(cfg, () => process.exit(0));
const operations = JSON.parse(input) as Operation[];
const receipt: Receipt = { workers: [], resources: [], temps: [] };
const { readFileSync, renameSync } = fs;
const wait = new Int32Array(new SharedArrayBuffer(4));

function assertLocked(): void {
  assert.equal(readFileSync(`${cfg}.lock`, "utf-8").split(".")[0], String(process.pid));
}

fs.readFileSync = ((...args: Parameters<typeof readFileSync>) => {
  if (args[0] !== cfg) return readFileSync(...args);
  assertLocked();
  try {
    return readFileSync(...args);
  } finally {
    // 首开读到 ENOENT 也留出竞争窗口,避免一个进程在另一个动手前就写完。
    Atomics.wait(wait, 0, 0, 15);
  }
}) as typeof readFileSync;
fs.renameSync = (from, to) => {
  if (to === cfg) {
    assertLocked();
    receipt.temps.push(String(from));
  }
  renameSync(from, to);
};
syncBuiltinESMExports();

Atomics.wait(wait, 0, 0, Math.max(0, Number(startAt) - Date.now()));
for (const op of operations) {
  if ("name" in op) {
    receipt.workers.push(createWorker(cfg, { kind: "local", dataRoot: "/test", name: op.name }));
  } else {
    writeResources(cfg, op.resources);
    receipt.resources.push(op.resources);
  }
}
process.stdout.write(JSON.stringify(receipt));
