/**
 * H-974: rollingQueueModeEnabled reads the stored switch through the core strict parser.
 * Unknown / blank / missing / unreadable → false (fail closed, never throws); valid on-words → true.
 */
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { ROLLING_QUEUE_MODE_SETTING } from "@drec/core";
import { TaskStore } from "../../packages/app/src/store.js";
import { rollingQueueModeEnabled } from "../../packages/app/src/rolling-queue.js";

let dir = "";
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "drec-rq-mode-")); });
afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

function dbWith(value: string | null): string {
  const p = join(dir, "t.db");
  const s = new TaskStore(p);
  if (value !== null) s.setSetting(ROLLING_QUEUE_MODE_SETTING, value);
  s.close();
  return p;
}

describe("rollingQueueModeEnabled (H-974 strict parse, fail closed)", () => {
  it.each(["enble", "maybe", "", "off", "0", "none", "2", "NOPE"])("stored %j → false", (v) => {
    expect(rollingQueueModeEnabled(dbWith(v))).toBe(false);
  });

  it.each(["TRUE", " on ", "y", "1", "yes"])("stored %j → true", (v) => {
    expect(rollingQueueModeEnabled(dbWith(v))).toBe(true);
  });

  it("missing key → false", () => {
    expect(rollingQueueModeEnabled(dbWith(null))).toBe(false);
  });

  it("missing db file → false and no file created", () => {
    expect(rollingQueueModeEnabled(join(dir, "nope.db"))).toBe(false);
  });

  it("unreadable db (a directory) → false, never throws", () => {
    expect(() => rollingQueueModeEnabled(dir)).not.toThrow();
    expect(rollingQueueModeEnabled(dir)).toBe(false);
  });
});
