import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { atomicTempName, isAtomicTempName } from "@drec/core";
import { atomicPartPath, groupSessions, groupSessionsInDir } from "@drec/post-process";
import { unclaimedStageSegments } from "../../packages/orchestrator/src/pipeline.js";

const BASE = "主播_2026-06-27_08-00-00";

describe("原子落盘临时名(issue #149)", () => {
  it("生成与识别同源:atomicTempName 的产物必被 isAtomicTempName 认出;post-process 同形", () => {
    for (const ext of [".ts", ".flv", ".mp4", ".mkv"]) {
      const t = atomicTempName(`/x/${BASE}_000${ext}`);
      expect(t).toBe(`/x/.${BASE}_000.part${ext}`);
      expect(isAtomicTempName(t)).toBe(true);
      expect(atomicPartPath(`/x/${BASE}_000${ext}`)).toBe(t);
    }
  });

  it("正常名 / 仅 .part 中缀无点前缀 / 仅点前缀无 .part → 不是临时名", () => {
    expect(isAtomicTempName(`${BASE}_000.ts`)).toBe(false);
    expect(isAtomicTempName(`${BASE}_000.part.ts`)).toBe(false);
    expect(isAtomicTempName(`.${BASE}_000.ts`)).toBe(false);
    expect(isAtomicTempName(".part.ts")).toBe(false);
  });

  it("groupSessions:原生容器 .part 临时名不被认领,正常分段分组不变", () => {
    const files = [`${BASE}_000.ts`, `${BASE}_001.ts`, `.${BASE}_002.part.ts`, `.${BASE}.part.flv`];
    const g = groupSessions(files);
    expect(g[BASE]?.ts).toEqual([`${BASE}_000.ts`, `${BASE}_001.ts`]);
    expect(Object.keys(g)).toEqual([BASE]);
  });

  it("groupSessions:只有临时名 → 不产生会话", () => {
    expect(groupSessions([`.${BASE}_000.part.ts`, `.${BASE}.part.flv`])).toEqual({});
  });

  it("stage 残留原生容器临时名:不被认领,未认领门禁不误报", () => {
    const dir = mkdtempSync(join(tmpdir(), "atomic-"));
    const seg = `${BASE}_000.ts`;
    const tmp = `.${BASE}_001.part.ts`;
    writeFileSync(join(dir, seg), "x");
    writeFileSync(join(dir, tmp), "x");
    expect(groupSessionsInDir(dir)[BASE]?.ts).toEqual([seg]);
    expect(unclaimedStageSegments(dir, [seg])).toEqual([]);
    // 临时名即使混进 pulled 清单也不算「漏认领」
    expect(unclaimedStageSegments(dir, [seg, tmp])).toEqual([]);
  });

  it("未认领门禁仍有效:正常分段缺边车的 mkv 照常报", () => {
    const dir = mkdtempSync(join(tmpdir(), "atomic-"));
    writeFileSync(join(dir, `${BASE}.mkv`), "x");
    expect(unclaimedStageSegments(dir, [`${BASE}.mkv`])).toEqual([`${BASE}.mkv`]);
  });
});
