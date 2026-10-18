import { describe, expect, it } from "vitest";
import type { RemoteTaskSpec, WorkerStatus } from "@drec/core";
import {
  desiredFingerprint,
  nextExpectedVersion,
  readExpectedVersion,
  readSyncError,
  recordExpectedVersion,
  recordSyncError,
  withMasterReceipt,
  type ReceiptSettings,
} from "./sync-receipt.js";

const spec = (over: Partial<RemoteTaskSpec> = {}): RemoteTaskSpec => ({
  platform: "douyin", roomSlug: "1", room: "https://live.douyin.com/1",
  name: "A", quality: "origin", engine: "ffmpeg", danmu: 1, segmentSec: 1800,
  scheduleStart: null, scheduleEnd: null, enabled: true, useCookie: true,
  cookies: null, outDir: null, webhook: null, anchorName: null, rollingUpload: false, ...over,
});

const settings = (): ReceiptSettings & { data: Map<string, string> } => {
  const data = new Map<string, string>();
  return {
    data,
    getSetting: (key) => data.get(key) ?? null,
    setSetting: (key, value) => { data.set(key, value); },
  };
};

describe("sync receipt: expected version", () => {
  it("fingerprint ignores object-key order and array order of rooms", () => {
    const a = desiredFingerprint([spec({ roomSlug: "1" }), spec({ roomSlug: "2" })]);
    const b = desiredFingerprint([spec({ roomSlug: "2" }), spec({ roomSlug: "1" })]);
    expect(a).toBe(b);
    const reordered = { ...spec(), name: "A" } as RemoteTaskSpec;
    expect(desiredFingerprint([reordered])).toBe(desiredFingerprint([spec()]));
  });

  it("fingerprint changes when content changes", () => {
    const base = desiredFingerprint([spec()]);
    expect(desiredFingerprint([spec({ segmentSec: 900 })])).not.toBe(base);
    expect(desiredFingerprint([spec({ cookies: "sid=1" })])).not.toBe(base);
  });

  it("first content → 1, identical content stays, changed content +1", () => {
    const s = settings();
    expect(recordExpectedVersion(s, "w", [spec()])).toBe(1);
    expect(recordExpectedVersion(s, "w", [spec()])).toBe(1);
    expect(recordExpectedVersion(s, "w", [spec({ segmentSec: 900 })])).toBe(2);
    expect(readExpectedVersion(s, "w")).toBe(2);
  });

  it("versions are independent per worker", () => {
    const s = settings();
    recordExpectedVersion(s, "a", [spec()]);
    expect(recordExpectedVersion(s, "b", [spec()])).toBe(1);
    expect(recordExpectedVersion(s, "a", [spec({ danmu: 0 })])).toBe(2);
  });

  it("corrupt persisted state degrades to a fresh version", () => {
    const s = settings();
    s.setSetting("hubSync.expectedVersion.w", "{ 坏 json");
    expect(recordExpectedVersion(s, "w", [spec()])).toBe(1);
  });

  it("nextExpectedVersion keeps the version on equal content", () => {
    const first = nextExpectedVersion(null, "h");
    expect(first.changed).toBe(true);
    expect(first.state.version).toBe(1);
    const again = nextExpectedVersion(first.state, "h");
    expect(again.changed).toBe(false);
    expect(again.state.version).toBe(1);
  });
});

describe("sync receipt: error and status", () => {
  it("records and clears the last sync error", () => {
    const s = settings();
    recordSyncError(s, "w", "ssh timeout");
    expect(readSyncError(s, "w")).toBe("ssh timeout");
    recordSyncError(s, "w", null);
    expect(readSyncError(s, "w")).toBeUndefined();
  });

  it("attaches expectedVersion and syncError without dropping node fields", () => {
    const s = settings();
    recordExpectedVersion(s, "w", [spec()]);
    recordSyncError(s, "w", "boom");
    const status: WorkerStatus = { id: "w", ok: true, appVersion: "0.0.173-abc", appliedVersion: null };
    expect(withMasterReceipt(status, s)).toEqual({
      ...status,
      expectedVersion: 1,
      syncError: "boom",
    });
  });

  it("omits master fields when the worker was never synced", () => {
    const status: WorkerStatus = { id: "w", ok: true };
    expect(withMasterReceipt(status, settings())).toEqual(status);
  });
});
