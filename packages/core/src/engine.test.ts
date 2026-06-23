import { describe, it, expect, beforeEach } from "vitest";
import {
  registerEngine, getEngine, engineNames, listEngines, _resetEngines,
} from "./engine.js";
import type { DownloadEngine, EngineSpawnArgs } from "./engine.js";

// 轻量 fake 引擎(注册表本身只依赖 engine 契约,无 ffmpeg/mesio 进程)。
const fakeEngine = (id: string): DownloadEngine => ({
  id,
  spawn(_a: EngineSpawnArgs) {
    // 不真 spawn:返回一个最小占位(测试只验证注册表查找,不触碰子进程)。
    return { proc: {} as never, sessionFirstPath: "x_000.ts" };
  },
});

describe("下载引擎注册表(按 id 注册/查找)", () => {
  beforeEach(() => _resetEngines());

  it("注册后按 id 取回引擎;engineNames/listEngines 反映已注册项", () => {
    registerEngine(fakeEngine("ffmpeg"));
    registerEngine(fakeEngine("mesio"));
    expect(getEngine("ffmpeg")?.id).toBe("ffmpeg");
    expect(getEngine("mesio")?.id).toBe("mesio");
    expect(engineNames().sort()).toEqual(["ffmpeg", "mesio"]);
    expect(listEngines().map((e) => e.id).sort()).toEqual(["ffmpeg", "mesio"]);
  });

  it("未知 id → undefined（调用方可回退平台默认）", () => {
    expect(getEngine("nope")).toBeUndefined();
  });
});
