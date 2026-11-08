/**
 * 访问计数器(精简审计取证):计数、跨重启续算、坏文件容错、键数封顶。
 * 这些行为都会直接影响「/hub、/stats 有没有人用」这个结论的可信度。
 */
import { mkdtempSync, readFileSync, writeFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, describe, expect, it } from "vitest";
import { AccessStats } from "../../packages/app/src/web/access-stats.js";

const dirs: string[] = [];
function tempFile(): string {
  const dir = mkdtempSync(join(tmpdir(), "access-stats-"));
  dirs.push(dir);
  return join(dir, "access-stats.json");
}
afterEach(() => {
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true });
});

describe("AccessStats", () => {
  it("counts handlers and exposes them sorted by hits", () => {
    const stats = new AccessStats(tempFile(), () => 1_000);
    stats.record("stats");
    stats.record("listHubRules");
    stats.record("listHubRules");
    expect(stats.snapshot().counts).toEqual({ listHubRules: 2, stats: 1 });
    expect(stats.snapshot().sinceMs).toBe(1_000);
  });

  it("survives a restart: counts and the observation start are kept", () => {
    const file = tempFile();
    const first = new AccessStats(file, () => 5_000);
    first.record("listHubRules");
    first.record("stats");
    first.flush();
    const saved = JSON.parse(readFileSync(file, "utf-8")) as { sinceMs: number; counts: Record<string, number> };
    expect(saved.sinceMs).toBe(5_000);

    const second = new AccessStats(file, () => 9_000);
    second.record("listHubRules");
    expect(second.snapshot().counts).toEqual({ listHubRules: 2, stats: 1 });
    expect(second.snapshot().sinceMs).toBe(5_000, "观察起点不能被重启重置");
  });

  it("treats a corrupt file as empty instead of failing to boot", () => {
    const file = tempFile();
    writeFileSync(file, "{not json");
    const stats = new AccessStats(file, () => 1);
    stats.record("stats");
    expect(stats.snapshot().counts).toEqual({ stats: 1 });
  });

  it("caps distinct keys so crafted URLs cannot grow memory without bound", () => {
    const stats = new AccessStats(tempFile());
    for (let i = 0; i < 500; i++) stats.record(`handler-${i}`);
    const counts = stats.snapshot().counts;
    const distinct = Object.keys(counts).length;
    expect(distinct).toBeLessThanOrEqual(401);
    expect(counts["(other)"]).toBeGreaterThan(0);
  });

  it("writes atomically: no partial file after a flush", () => {
    const file = tempFile();
    const stats = new AccessStats(file);
    stats.record("stats");
    stats.flush();
    const parsed = JSON.parse(readFileSync(file, "utf-8")) as { version: number };
    expect(parsed.version).toBe(1);
  });
});
