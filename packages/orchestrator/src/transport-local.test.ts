// packages/orchestrator/src/transport-local.test.ts
import { describe, it, expect } from "vitest";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { LocalTransport } from "./transport-local.js";

describe("LocalTransport.listInventory", () => {
  it("聚合会话分段时长 + 读 gaps + 映射 roomSlug", async () => {
    const root = mkdtempSync(join(tmpdir(), "loc-"));
    const dir = join(root, "一勺小苏打"); mkdirSync(dir);
    writeFileSync(join(dir, "一勺小苏打_2026-06-27_07-54_000.ts"), "x");
    writeFileSync(join(dir, "一勺小苏打_2026-06-27_07-54_001.ts"), "x");
    writeFileSync(join(dir, "一勺小苏打_2026-06-27_07-54.gaps.json"),
      JSON.stringify({ sessionBase: "一勺小苏打_2026-06-27_07-54", gaps: [{ startMs: 0, endMs: 10_000 }], totalGapSec: 10 }));
    const t = new LocalTransport({
      id: "local", recordingsDir: root, taskRooms: { "一勺小苏打": "999" },
      ffprobe: async () => ({ durationSec: 1800, startMs: 1_700_000_000_000, endMs: 1_700_001_800_000 }),
    });
    const inv = await t.listInventory();
    expect(inv.recordings).toHaveLength(1);
    expect(inv.recordings[0].roomSlug).toBe("999");
    expect(inv.recordings[0].durationSec).toBe(3600); // 两段 1800 各
    expect(inv.recordings[0].totalGapSec).toBe(10);
  });
});
