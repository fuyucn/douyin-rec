import { describe, expect, it } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { RemoteTaskSpec } from "@drec/core";
import { TaskStore } from "../../packages/app/src/store.js";
import { parseApplyTasksPayload, applyTasksPayload } from "../../packages/app/src/apply-payload.js";
import { MANAGED_STATE_FILE } from "../../packages/app/src/managed-state.js";

const spec = (over: Partial<RemoteTaskSpec> = {}): RemoteTaskSpec => ({
  platform: "douyin", roomSlug: "1", room: "https://live.douyin.com/1",
  name: "A", quality: "origin", engine: "ffmpeg", danmu: 1, segmentSec: 1800,
  scheduleStart: null, scheduleEnd: null, enabled: true, useCookie: true,
  cookies: null, outDir: null, webhook: null, anchorName: null, rollingUpload: false,
  ...over,
});

const encode = (value: unknown): string => Buffer.from(JSON.stringify(value), "utf-8").toString("base64");

describe("parseApplyTasksPayload", () => {
  it("decodes desired / force / expectedVersion", () => {
    expect(parseApplyTasksPayload(encode({ desired: [spec()], force: true, expectedVersion: 4 })))
      .toEqual({ desired: [spec()], force: true, expectedVersion: 4 });
  });

  it("old master payload (no expectedVersion) stays compatible", () => {
    expect(parseApplyTasksPayload(encode({ desired: [spec()] }))).toEqual({ desired: [spec()] });
  });

  it("ignores an invalid expectedVersion instead of dropping the desired set", () => {
    for (const expectedVersion of [0, -1, 1.5, "3", null]) {
      expect(parseApplyTasksPayload(encode({ desired: [spec()], expectedVersion })).desired).toHaveLength(1);
      expect(parseApplyTasksPayload(encode({ desired: [spec()], expectedVersion })).expectedVersion).toBeUndefined();
    }
  });

  it("non-array desired → empty (same guard as before)", () => {
    expect(parseApplyTasksPayload(encode({ desired: "nope" })).desired).toEqual([]);
  });
});

describe("applyTasksPayload", () => {
  it("writes the received expectedVersion into the node snapshot", () => {
    const dir = mkdtempSync(join(tmpdir(), "apply-payload-"));
    const store = new TaskStore(join(dir, "tasks.db"));
    const managedStateDir = join(dir, "config", "managed");
    try {
      const r = applyTasksPayload(store, encode({ desired: [spec()], expectedVersion: 9 }), undefined, { managedStateDir });
      expect(r.applied).toHaveLength(1);
      const snap = JSON.parse(readFileSync(join(managedStateDir, MANAGED_STATE_FILE), "utf-8")) as {
        version: number; appVersion?: string; desired: RemoteTaskSpec[];
      };
      expect(snap.version).toBe(9);
      // The applying bundle must be recorded so `_node-status` can compare it.
      expect(typeof snap.appVersion).toBe("string");
      expect(snap.desired).toHaveLength(1);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("old payload without version → snapshot version 0 (unknown), apply still succeeds", () => {
    const dir = mkdtempSync(join(tmpdir(), "apply-payload-"));
    const store = new TaskStore(join(dir, "tasks.db"));
    const managedStateDir = join(dir, "config", "managed");
    try {
      const r = applyTasksPayload(store, encode({ desired: [spec()] }), undefined, { managedStateDir });
      expect(r.applied).toHaveLength(1);
      const snap = JSON.parse(readFileSync(join(managedStateDir, MANAGED_STATE_FILE), "utf-8")) as { version: number };
      expect(snap.version).toBe(0);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("a legacy no-spool spec warns once per invocation and stores spool=true (cross-process semantics)", () => {
    const dir = mkdtempSync(join(tmpdir(), "apply-payload-"));
    const store = new TaskStore(join(dir, "tasks.db"));
    const managedStateDir = join(dir, "config", "managed");
    try {
      const payload = encode({ desired: [spec({ streamUpload: true, streamUploadSpool: false })] });
      const logs1: string[] = [];
      applyTasksPayload(store, payload, (m) => logs1.push(m), { managedStateDir });
      const logs2: string[] = [];
      applyTasksPayload(store, payload, (m) => logs2.push(m), { managedStateDir });
      expect(store.getTask(store.listTasks()[0].id)).toMatchObject({ streamUpload: true, streamUploadSpool: true });
      expect(logs1.filter((line) => line.includes("旧 master 下发了已废弃的真 0 落盘"))).toHaveLength(1);
      expect(logs2.filter((line) => line.includes("旧 master 下发了已废弃的真 0 落盘"))).toHaveLength(1);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });

  it("an injected noSpoolWarnedKeys set dedupes across invocations (serve in-process owner)", () => {
    const dir = mkdtempSync(join(tmpdir(), "apply-payload-"));
    const store = new TaskStore(join(dir, "tasks.db"));
    const managedStateDir = join(dir, "config", "managed");
    const warned = new Set<string>();
    try {
      const payload = encode({ desired: [spec({ streamUpload: true, streamUploadSpool: false })] });
      const logs: string[] = [];
      const log = (m: string): void => logs.push(m);
      applyTasksPayload(store, payload, log, { managedStateDir, noSpoolWarnedKeys: warned });
      applyTasksPayload(store, payload, log, { managedStateDir, noSpoolWarnedKeys: warned });
      expect(logs.filter((line) => line.includes("旧 master 下发了已废弃的真 0 落盘"))).toHaveLength(1);
    } finally {
      store.close();
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
