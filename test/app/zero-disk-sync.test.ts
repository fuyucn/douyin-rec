/**
 * zero-disk-sync.test.ts — master-side zero-disk orchestration (plan 050.4).
 *
 * The gate/poll used to be untestable inside the hub starter. These cases pin the two decisions
 * that matter: which (room, node) pairs are targeted at all, and what the console sees after a
 * round (a blocked pair must stay visible instead of silently disappearing).
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdirSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "../../packages/app/src/store.js";
import { readZeroDiskStatus } from "../../packages/hub-compose/src/hub-runtime.js";
import { createZeroDiskSync, type ZeroDiskSync } from "../../packages/hub-compose/src/zero-disk-sync.js";
import type { Transport } from "../../packages/orchestrator/src/transport.js";

const WORKERS = [{ id: "w1", kind: "remote" }, { id: "local", kind: "local" }];

describe("createZeroDiskSync", () => {
  let dir: string;
  let hubDir: string;
  let store: TaskStore;
  let sync: ZeroDiskSync;
  let warnings: string[];
  let supportCalls: number;

  const transport = (zeroDisk: boolean): Transport => ({
    id: "w1",
    nodeCapabilities: async () => {
      supportCalls += 1;
      return { biliup: true, cookies: true, diskFreeGB: 100, zeroDisk };
    },
  }) as unknown as Transport;

  const rule = (roomSlug: string, sourceTaskId: number) => {
    writeFileSync(join(hubDir, `douyin.${roomSlug}.json`), JSON.stringify({
      room: `https://live.douyin.com/${roomSlug}`,
      enabled: true,
      recording: { sourceTaskId },
      workers: ["w1"],
    }));
  };

  const make = (t: Transport): ZeroDiskSync => createZeroDiskSync({
    store,
    log: () => {},
    warn: (m) => warnings.push(m),
    onEvent: () => {},
    hubDir: () => hubDir,
    workers: () => WORKERS,
    transports: () => new Map([["w1", t]]),
    dbPath: join(dir, "sync.db"),
  });

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "zero-disk-sync-"));
    hubDir = join(dir, "hub");
    mkdirSync(hubDir);
    store = new TaskStore(join(dir, "tasks.db"));
    warnings = [];
    supportCalls = 0;
    sync = make(transport(true));
  });

  afterEach(() => {
    store.close?.();
    rmSync(dir, { recursive: true, force: true });
  });

  it("只把「源任务开了零落盘 + 该节点被勾选」的房间算作目标(本机不算)", () => {
    const on = store.addTask({ room: "111", streamUpload: true });
    const off = store.addTask({ room: "222" });
    rule("111", on.id);
    rule("222", off.id);
    // 333 has a rule but no source task bound.
    writeFileSync(join(hubDir, "douyin.333.json"), JSON.stringify({ room: "https://live.douyin.com/333", enabled: true }));
    expect(sync.targets()).toEqual([{ workerId: "w1", platform: "douyin", roomSlug: "111" }]);
  });

  it("能力探测只在目标节点上发生,结论喂给 allowsPush", async () => {
    const task = store.addTask({ room: "111", streamUpload: true });
    rule("111", task.id);
    expect(sync.allowsPush("w1")).toBe(false); // never probed = fails closed
    await sync.beginRound();
    expect(supportCalls).toBe(1);
    expect(sync.allowsPush("w1")).toBe(true);
  });

  it("被拦下的房间在轮末的快照里仍然可见", async () => {
    const task = store.addTask({ room: "111", streamUpload: true });
    rule("111", task.id);
    const targets = await sync.beginRound();
    sync.delivery.block("w1|douyin:111", "upload account is unknown");
    await sync.finishRound(targets);
    const view = readZeroDiskStatus("douyin", "111");
    expect(view.length).toBeGreaterThan(0);
    expect(view.some((n) => n.state === "blocked" && n.reason === "upload account is unknown")).toBe(true);
  });
});

