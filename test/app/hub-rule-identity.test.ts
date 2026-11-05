/**
 * Issue #481: the rule filename stem is the ONLY identity; `room` is display/data only.
 * A rule whose room was edited after creation used to list under a room-derived key that had no file
 * (PATCH 404) and a second create produced a duplicate file.
 */
import { describe, it, expect, beforeEach, vi } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getHubRule, hubKey, listHubRules, reorderHubRules, resolveRuleSyncRoom, updateHubRule, upsertHubRule } from "../../packages/app/src/hub-store.js";

let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "hub-identity-")); });

const room = (n: string): string => `https://live.douyin.com/${n}`;
const fileOf = (key: string): string => join(dir, `${key}.json`);
const jsonOf = (key: string): Record<string, unknown> => JSON.parse(readFileSync(fileOf(key), "utf-8")) as Record<string, unknown>;

describe("rule identity = filename stem (issue #481)", () => {
  it("a rule whose room no longer matches the stem lists/updates by STEM, and PATCH creates no second file", () => {
    const stem = hubKey("douyin", "111");
    const roomDerived = hubKey("douyin", "222");
    // Hand-edited/legacy state: file is douyin.111.json but its display room is room 222 (e.g. the bound task
    // was re-pointed after creation).
    writeFileSync(fileOf(stem), JSON.stringify({ room: room("222"), enabled: true, pipeline: {} }) + "\n", "utf-8");

    const listed = listHubRules(dir);
    expect(listed.map((r) => r.key)).toEqual([stem]);      // stem, not room-derived
    expect(listed[0].roomSlug).toBe("111");                 // identity from the filename
    expect(listed[0].room).toBe(room("222"));               // room stays display/data only

    expect(getHubRule(dir, stem)).not.toBeNull();           // GET by the listed key resolves
    expect(getHubRule(dir, roomDerived)).toBeNull();        // there is no file under the room-derived key

    // PATCH by the listed key updates the same file and does not create a ghost.
    const updated = updateHubRule(dir, stem, { enabled: false });
    expect(updated).not.toBeNull();
    expect(updated!.key).toBe(stem);
    expect(jsonOf(stem).enabled).toBe(false);
    expect(existsSync(fileOf(roomDerived))).toBe(false);
    expect(readdirSync(dir).filter((n) => n.endsWith(".json"))).toHaveLength(1);
  });

  it("normal rule (stem == room-derived key) is unchanged", () => {
    const key = hubKey("douyin", "333");
    const r = upsertHubRule(dir, { platform: "douyin", roomSlug: "333", room: room("333"), pipeline: { steps: { burnDanmu: false } } });
    expect(r.key).toBe(key);
    expect(listHubRules(dir).map((x) => x.key)).toEqual([key]);
    expect(jsonOf(key).room).toBe(room("333"));
  });

  it("all three writers emit the same JSON shape and byte semantics (single toHubFile)", () => {
    const key = hubKey("douyin", "444");
    upsertHubRule(dir, {
      platform: "douyin",
      roomSlug: "444",
      room: room("444"),
      enabled: true,
      pipeline: { steps: { burnDanmu: false } },
      recording: { sourceTaskId: 9 },
      workers: ["w1"],
      requires: ["danmu:douyin"],
    });
    // Field order + values are the persisted contract (JSON.stringify omits undefined entries).
    expect(jsonOf(key)).toEqual({
      room: room("444"),
      enabled: true,
      pipeline: { steps: { burnDanmu: false } },
      recording: { sourceTaskId: 9 },
      workers: ["w1"],
      requires: ["danmu:douyin"],
    });
    expect(Object.keys(jsonOf(key))).toEqual(["room", "enabled", "pipeline", "recording", "workers", "requires"]);

    updateHubRule(dir, key, { enabled: false });
    expect(Object.keys(jsonOf(key))).toEqual(["room", "enabled", "pipeline", "recording", "workers", "requires"]);
    expect(jsonOf(key).enabled).toBe(false);

    reorderHubRules(dir, [key]);
    expect(Object.keys(jsonOf(key))).toEqual(["room", "enabled", "pipeline", "recording", "workers", "requires", "order"]);
    expect(jsonOf(key).order).toBe(0);
  });

  it("a rule without a room keeps omitting the field on every write", () => {
    const key = hubKey("douyin", "555");
    upsertHubRule(dir, { platform: "douyin", roomSlug: "555" });
    expect("room" in jsonOf(key)).toBe(false);
    updateHubRule(dir, key, { enabled: false });
    expect("room" in jsonOf(key)).toBe(false);
    reorderHubRules(dir, [key]);
    expect("room" in jsonOf(key)).toBe(false);
  });
});


describe("bound rule sync identity comes from the source task (issue #481 review)", () => {
  it("divergent stem: the source task's room wins, flagged as mismatched (never skipped)", () => {
    // desiredFor / rolling-effective must keep syncing this room; only a warn is emitted.
    expect(resolveRuleSyncRoom({ platform: "douyin", roomSlug: "111" }, room("222")))
      .toEqual({ platform: "douyin", roomSlug: "222", mismatched: true });
  });

  it("normal rule: identity unchanged and not flagged", () => {
    expect(resolveRuleSyncRoom({ platform: "douyin", roomSlug: "333" }, room("333")))
      .toEqual({ platform: "douyin", roomSlug: "333", mismatched: false });
  });

  it("wiring: cli desiredFor / status / zero-disk and rolling-effective use the helper, not a mismatch skip", () => {
    const cli = readFileSync(new URL("../../packages/cli/src/cli.ts", import.meta.url), "utf-8");
    expect(cli).toContain("resolveRuleSyncRoom");
    expect(cli).not.toContain("!== rule.roomSlug) continue"); // the old "drop from desired" guard
    const rolling = readFileSync(new URL("../../packages/app/src/rolling-effective.ts", import.meta.url), "utf-8");
    expect(rolling).toContain("resolveRuleSyncRoom");
    expect(rolling).not.toContain("=== rule.roomSlug ? rule : undefined");
  });
});

describe("legacy / edge input (issue #481 review)", () => {
  it("dotless stem with room: platform/roomSlug fall back to the room (keeps main behaviour), key stays the stem", () => {
    const warn = vi.spyOn(console, "warn").mockImplementation(() => {});
    try {
      // Pre-#481 hand-written file: no platform prefix in the filename.
      writeFileSync(join(dir, "999.json"), JSON.stringify({ room: "https://live.bilibili.com/12345", enabled: true }) + String.fromCharCode(10), "utf-8");
      const r = getHubRule(dir, "999")!;
      expect(r.key).toBe("999");
      expect(r.platform).toBe("bilibili"); // derived from room, like main
      expect(r.roomSlug).toBe("12345");
      expect(warn.mock.calls.some((c) => String(c[0]).includes("规则文件名无平台前缀"))).toBe(true);
    } finally {
      warn.mockRestore();
    }
  });

  it("truthy-but-blank input.room is persisted as '' (main kept an empty room value)", () => {
    const key = hubKey("douyin", "777");
    upsertHubRule(dir, { platform: "douyin", roomSlug: "777", room: "   " });
    const raw = jsonOf(key);
    expect("room" in raw).toBe(true);
    expect(raw.room).toBe("");
  });

  it("wiring: last-run lookup uses the task-derived room key, not the rule stem", () => {
    const ctx = readFileSync(new URL("../../packages/app/src/web/api/context.ts", import.meta.url), "utf-8");
    expect(ctx).toContain("listHubJobs(deps.syncDbPath, { room: hubStore.hubKey(platform.id, roomSlug)");
  });
});
