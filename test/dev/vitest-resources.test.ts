import { describe, expect, it } from "vitest";
import { getHeapStatistics } from "node:v8";
import { availableParallelism } from "node:os";
import config, { vitestWorkerLimit } from "../../vitest.config.js";
import { platformForRoom } from "@drec/core";
import { platformForRoom as platformForRoomDirect } from "../../packages/core/src/platform.js";

describe("Vitest resource defaults", () => {
  it("caps worker parallelism without increasing it on low-core hosts", () => {
    expect([1, 2, 3, 4, 11].map(vitestWorkerLimit)).toEqual([1, 1, 2, 2, 2]);
    expect(config.test?.minWorkers).toBe(1);
    expect(config.test?.maxWorkers).toBe(vitestWorkerLimit(availableParallelism()));
  });

  it("keeps isolated fork workers instead of sharing one module registry", () => {
    expect(config.test?.pool).toBe("forks");
    expect(config.test?.isolate).toBe(true);
    expect(config.test?.poolOptions?.forks?.singleFork).not.toBe(true);
    expect(config.test?.poolOptions?.forks?.isolate).not.toBe(false);
  });

  it("sets a bounded V8 heap for every fork worker", () => {
    expect(config.test?.poolOptions?.forks?.execArgv).toEqual([
      "--max-old-space-size=512",
      "--max-semi-space-size=16",
    ]);
    expect(process.execArgv).toContain("--max-old-space-size=512");
    expect(process.execArgv).toContain("--max-semi-space-size=16");
    expect(getHeapStatistics().heap_size_limit).toBeLessThan(640 * 1024 * 1024);
  });

  it("preserves the complete test discovery patterns and setup", () => {
    expect(config.test?.include).toEqual(["test/**/*.test.ts", "packages/**/*.test.ts"]);
    expect(config.test?.exclude).toEqual(["**/node_modules/**", "**/dist/**", "packages/web/**"]);
    expect(config.test?.setupFiles).toEqual(["./test/setup.ts"]);
  });

  it("registers the same fake platforms through direct and public imports", () => {
    expect(platformForRoom).toBe(platformForRoomDirect);
    expect(platformForRoom("https://live.douyin.com/test-room").id).toBe("douyin");
    expect(platformForRoom("https://live.bilibili.com/1").id).toBe("bilibili");
  });
});
