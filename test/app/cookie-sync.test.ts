/**
 * cookie-sync.test.ts — the master's platform credential push (issue #563, plan 050.2).
 *
 * The push lives in the hub sync tick, which vitest cannot start. These tests drive the extracted
 * module directly, so the two silent-failure paths stay pinned:
 *   1. a fingerprint must be recorded only when the node really accounted for every platform;
 *   2. "old bundle does not support it" must never be recorded as applied, or an upgraded node
 *      would wait for the master's next login change to receive anything.
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { TaskStore } from "../../packages/app/src/store.js";
import { readCookiesApplied } from "../../packages/app/src/sync-receipt.js";
import { createCookieSync, type CookieSync } from "../../packages/hub-compose/src/cookie-sync.js";
import type { Transport } from "../../packages/orchestrator/src/transport.js";
import type { ApplyCookiesPayload, ApplyCookiesResult } from "../../packages/core/src/worker-contract.js";

const WORKER = { id: "w1", kind: "remote" };

const transport = (applyCookies?: (input: ApplyCookiesPayload) => Promise<ApplyCookiesResult>): Transport =>
  ({ id: WORKER.id, ...(applyCookies ? { applyCookies } : {}) }) as unknown as Transport;

const applied = (): ApplyCookiesResult => ({ applied: ["douyin"], unchanged: [], rejected: [], unsupported: [] });

describe("createCookieSync", () => {
  let dir: string;
  let store: TaskStore;
  let warns: string[];
  let logs: string[];
  let sync: CookieSync;

  beforeEach(() => {
    dir = mkdtempSync(join(tmpdir(), "cookie-sync-"));
    store = new TaskStore(join(dir, "tasks.db"));
    store.setPlatformCookies("douyin", "sessionid=ABC");
    warns = [];
    logs = [];
    sync = createCookieSync({ store, warn: (m) => warns.push(m), log: (m) => logs.push(m) });
  });

  afterEach(() => {
    store.close?.();
    rmSync(dir, { recursive: true, force: true });
  });

  it("本机 worker 与无登录态的轮次都不下发", async () => {
    const seen: ApplyCookiesPayload[] = [];
    const t = transport(async (p) => {
      seen.push(p);
      return applied();
    });
    // local = the master itself: its own store is the source.
    await sync.pushTo({ id: "local", kind: "local" }, t, sync.beginRound());
    expect(seen).toHaveLength(0);

    store.setPlatformCookies("douyin", "");
    const round = sync.beginRound();
    expect(round.hasCookies).toBe(false);
    await sync.pushTo(WORKER, t, round);
    expect(seen).toHaveLength(0);
  });

  it("内容未变且在复核窗口内 → 本轮不推;内容变了 → 重推", async () => {
    const seen: ApplyCookiesPayload[] = [];
    const t = transport(async (p) => {
      seen.push(p);
      return applied();
    });
    await sync.pushTo(WORKER, t, sync.beginRound());
    expect(seen).toHaveLength(1);
    expect(readCookiesApplied(store, WORKER.id)?.fingerprint).toBeTypeOf("string");
    expect(logs.join("\n")).toContain("applied=douyin");

    await sync.pushTo(WORKER, t, sync.beginRound());
    expect(seen).toHaveLength(1); // same content, inside the re-verify window

    store.setPlatformCookies("douyin", "sessionid=DEF");
    await sync.pushTo(WORKER, t, sync.beginRound());
    expect(seen).toHaveLength(2);
  });

  it("旧 bundle 没有下发能力 → 只告警一次,且不记已应用", async () => {
    const t = transport();
    await sync.pushTo(WORKER, t, sync.beginRound());
    await sync.pushTo(WORKER, t, sync.beginRound());
    expect(warns.filter((m) => m.includes("不支持登录态下发"))).toHaveLength(1);
    expect(readCookiesApplied(store, WORKER.id)).toBeUndefined();
  });

  it("rejected 不算已交代 → 不记指纹,下一轮重试成功后补记", async () => {
    const reject = transport(async () => ({ applied: [], unchanged: [], rejected: ["douyin"], unsupported: [] }));
    await sync.pushTo(WORKER, reject, sync.beginRound());
    expect(warns.some((m) => m.includes("未完全应用") && m.includes("rejected=douyin"))).toBe(true);
    expect(readCookiesApplied(store, WORKER.id)).toBeUndefined();

    // Same warning text twice → deduped, but the push is retried every round.
    await sync.pushTo(WORKER, reject, sync.beginRound());
    expect(warns.filter((m) => m.includes("未完全应用"))).toHaveLength(1);

    await sync.pushTo(WORKER, transport(async () => applied()), sync.beginRound());
    expect(readCookiesApplied(store, WORKER.id)?.fingerprint).toBeTypeOf("string");
  });

  it("读设置失败 → 只告警一次并跳过本轮,不抛给同步 tick", () => {
    let reads = 0;
    const broken = {
      getSetting: (k: string) => store.getSetting(k),
      setSetting: (k: string, v: string) => store.setSetting(k, v),
      getPlatformCookies: () => {
        reads += 1;
        throw new Error("SQLITE_BUSY");
      },
    } as unknown as TaskStore;
    const brokenSync = createCookieSync({ store: broken, warn: (m) => warns.push(m), log: (m) => logs.push(m) });
    const first = brokenSync.beginRound();
    const second = brokenSync.beginRound();
    expect(reads).toBe(2);
    expect(first.hasCookies).toBe(false);
    expect(second.payload).toEqual({ platformCookies: {} });
    expect(warns.filter((m) => m.includes("读取平台登录态失败"))).toHaveLength(1);
  });
});
