/**
 * Issue #481: the rule filename stem is the ONLY identity; `room` is display/data only.
 * A rule whose room was edited after creation used to list under a room-derived key that had no file
 * (PATCH 404) and a second create produced a duplicate file.
 */
import { describe, it, expect, beforeEach } from "vitest";
import { existsSync, mkdtempSync, readFileSync, writeFileSync, readdirSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { getHubRule, hubKey, listHubRules, reorderHubRules, updateHubRule, upsertHubRule } from "../../packages/app/src/hub-store.js";

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

