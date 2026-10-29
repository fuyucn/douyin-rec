import { describe, expect, it } from "vitest";
import type { ZeroDiskNodeStatusDTO } from "@drec/core";
import { liveUploadView, zeroDiskNeedsAttention, zeroDiskView } from "../../packages/web/src/lib/zero-disk-status.js";
import { roomStatus } from "../../packages/web/src/lib/room-status.js";
import type { RoomDTO, Task } from "../../packages/web/src/api/client.js";

const dto = (over: Partial<ZeroDiskNodeStatusDTO> = {}): ZeroDiskNodeStatusDTO =>
  ({ workerId: "n1", workerName: "Node 1", state: "ok", checkedAt: 1, ...over });

describe("zeroDiskView", () => {
  it("maps every node-reported refusal code to its own wording", () => {
    const keys = ["account_mismatch", "account_unknown", "credential_missing", "delivery_missing"].map(
      (code) => zeroDiskView(dto({ run: "refused", code: code as ZeroDiskNodeStatusDTO["code"] })).key,
    );
    expect(new Set(keys).size).toBe(4);
    expect(keys.every((k) => k.startsWith("room.zeroDisk.refused"))).toBe(true);
    expect(zeroDiskView(dto({ run: "refused" })).key).toBe("room.zeroDisk.refused"); // unknown code: still a refusal
  });
  it("old node, unreachable node and a blocked push each have their own state and carry the reason", () => {
    expect(zeroDiskView(dto({ state: "unsupported", reason: "too old" }))).toMatchObject({ key: "room.zeroDisk.unsupported", tone: "error", detail: "too old" });
    expect(zeroDiskView(dto({ state: "offline", reason: "ssh" }))).toMatchObject({ key: "room.zeroDisk.offline", tone: "warn", detail: "ssh" });
    expect(zeroDiskView(dto({ state: "blocked", reason: "no account" }))).toMatchObject({ key: "room.zeroDisk.blocked", tone: "error", detail: "no account" });
  });
  it("running / finished carry the confirmed part count; a dead process is a warning, not 'running'", () => {
    expect(zeroDiskView(dto({ run: "running", parts: 3 }))).toMatchObject({ key: "room.zeroDisk.running", vars: { n: "3" }, tone: "ok" });
    expect(zeroDiskView(dto({ run: "finished", parts: 2 }))).toMatchObject({ key: "room.zeroDisk.finished", vars: { n: "2" } });
    expect(zeroDiskView(dto({ run: "stopped", parts: 1 })).tone).toBe("warn");
    expect(zeroDiskView(dto({ run: "failed", message: "boom" }))).toMatchObject({ tone: "error", detail: "boom" });
    expect(zeroDiskView(dto())).toMatchObject({ key: "room.zeroDisk.idle", tone: "muted" });
  });
});

describe("zeroDiskNeedsAttention / room status", () => {
  it("only states the user has to act on", () => {
    for (const bad of [dto({ state: "unsupported" }), dto({ state: "blocked" }), dto({ state: "offline" }), dto({ run: "refused" }), dto({ run: "failed" })]) {
      expect(zeroDiskNeedsAttention(bad)).toBe(true);
    }
    for (const fine of [dto(), dto({ run: "running" }), dto({ run: "finished" })]) expect(zeroDiskNeedsAttention(fine)).toBe(false);
  });
  const room = (procEnabled = true) => ({ recording: null, processing: { enabled: procEnabled } as RoomDTO["processing"] });
  const task = (p: Partial<Task> = {}): Task => ({ id: 1, enabled: true, status: "stopped", running: false, recording: false, recordingWorkers: [], ...p }) as Task;
  it("a refused zero-disk node makes an enabled room 'attention'; a paused room stays paused; a live recording wins", () => {
    const refused = [dto({ run: "refused", code: "account_mismatch" })];
    expect(roomStatus(room(), task({ zeroDisk: refused }), null).kind).toBe("attention");
    expect(roomStatus(room(false), task({ zeroDisk: refused }), null).kind).toBe("paused");
    expect(roomStatus(room(), task({ enabled: false, zeroDisk: refused }), null).kind).toBe("paused");
    expect(roomStatus(room(), task({ running: true, recording: true, zeroDisk: refused }), null).kind).toBe("recording");
    expect(roomStatus(room(), task({ zeroDisk: [dto({ run: "running", parts: 1 })] }), null).kind).toBe("waiting");
  });
});

describe("liveUploadView", () => {
  const summary = {
    sessionId: "r:1", state: "streaming" as const,
    currentPart: { index: 0, phase: "streaming" as const, uploadedBytes: 50, chunks: 1 },
    partsConfirmed: 0, updatedAt: 10,
  };
  it("picks the newest detail entry and exposes parts/events", () => {
    const v = liveUploadView(summary, [{
      workerId: "local", workerName: "本机",
      current: {
        schemaVersion: 1, mode: "zero-disk", sessionId: "r:1", createdAt: 1, platform: "douyin", roomSlug: "r",
        state: "streaming", startedAt: 1, updatedAt: 20,
        currentPart: { index: 1, phase: "streaming", uploadedBytes: 100, chunks: 2 },
        parts: [{ index: 0, phase: "confirmed", uploadedBytes: 50, chunks: 1 }],
        events: [{ at: 20, kind: "part_streaming", part: 1 }],
      },
    }]);
    expect(v.currentPart).toBe(1);
    expect(v.parts[0]?.phase).toBe("confirmed");
    expect(v.events[0]?.kind).toBe("part_streaming");
    expect(v.tone).toBe("ok");
  });
  it("finished session still renders from detail", () => {
    const v = liveUploadView({ ...summary, state: "finished", updatedAt: 30 }, [{
      workerId: "vps", workerName: "vps",
      previous: {
        schemaVersion: 1, mode: "zero-disk", sessionId: "r:1", createdAt: 1, platform: "douyin", roomSlug: "r",
        state: "finished", startedAt: 1, updatedAt: 30, parts: [{ index: 0, phase: "confirmed", uploadedBytes: 50, chunks: 1 }], events: [],
      },
    }]);
    expect(v.state).toBe("finished");
    expect(v.parts).toHaveLength(1);
  });
  it("unknown/old node has no parts but stays valid", () => {
    const v = liveUploadView(summary);
    expect(v.parts).toEqual([]);
    expect(v.events).toEqual([]);
  });
});
