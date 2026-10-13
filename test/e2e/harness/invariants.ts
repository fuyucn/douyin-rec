/**
 * 跨场景共用断言(E2E 脚手架):每个「收口为 done」的场景都必须满足的不变量。
 * 场景特有的期望(分 P 数、BV 来源等)由调用方传入。
 */
import { existsSync } from "node:fs";
import { expect } from "vitest";
import { ALLOWED_TRANSITIONS, type JobState } from "../../../packages/orchestrator/src/ledger.js";
import { ANCHOR, type Scenario } from "./scenario.js";

/** 状态流转序列里每一步都必须是台账允许的转换(不依赖 console.warn 是否被吞)。 */
export function expectLegalTrail(s: Scenario, key: string): void {
  const trail = s.stateTrail(key) as JobState[];
  for (let i = 1; i < trail.length; i++) {
    const from = trail[i - 1]!, to = trail[i]!;
    expect(ALLOWED_TRANSITIONS[from], `非法转换 ${from} → ${to}(完整轨迹 ${trail.join("→")})`).toContain(to);
  }
}

/** 节点源里的弹幕 xml 与 session.json 必须保留(不可再生,AGENTS.md 硬约束)。 */
export function expectSourceSidecarsKept(s: Scenario): void {
  for (const sess of s.sessions) {
    expect(existsSync(sess.xmlPath), `源 xml 被删: ${sess.xmlPath}`).toBe(true);
    expect(existsSync(sess.sessionJson), `session.json 被删: ${sess.sessionJson}`).toBe(true);
  }
}

export interface DoneExpect {
  /** 稿件应有的分 P 文件名(顺序敏感)。给数字则只校验个数。 */
  parts: string[] | number;
  /** 默认 true:清理后 stage 无残留(job.log 除外)。 */
  stageClean?: boolean;
}

/** 通用「健康收口」断言:台账、无拒绝、不重复建稿、分 P 对得上、元数据口径、文件保留。 */
export function expectHealthyDone(s: Scenario, key: string, e: DoneExpect): void {
  const job = s.ledger.get(key);
  expect(job?.state, `终态应为 done,实际 ${job?.state} error=${job?.error}`).toBe("done");
  expect(s.stateTrail(key)[0]).toBe("pending");
  expect(s.stateTrail(key).at(-1)).toBe("done");
  expectLegalTrail(s, key);
  expect(s.ledgerRejections(), "出现意外的 [ledger] 拒绝").toEqual([]);
  // 不重复建稿 + 分 P 数/名与预期一致。
  expect(s.fake.draftCount, "稿件数").toBe(1);
  const a = s.fake.onlyArchive;
  expect(job?.bv).toBe(a.bv);
  if (typeof e.parts === "number") expect(a.parts.length, `分P ${a.parts.join(",")}`).toBe(e.parts);
  else expect(a.parts).toEqual(e.parts);
  // 硬标准:关水印 + 默认仅自己可见(append 同口径不会翻回去:稿件级标志取 P1 建稿 argv)。
  expect(a.watermarkOff).toBe(true);
  expect(a.onlySelf).toBe(true);
  // 追加调用的 argv 同样必须带关水印 + 仅自己可见(append 会重提交元数据,漏带会把整稿翻回带水印/公开)。
  for (const c of s.fake.calls.filter((x) => x.op === "append")) {
    expect(c.argv, `append 缺关水印: ${c.argv.join(" ")}`).toContain('{"watermark":{"state":0}}');
    const i = c.argv.indexOf("--is-only-self");
    expect(i >= 0 && c.argv[i + 1] === "1", `append 缺仅自己可见: ${c.argv.join(" ")}`).toBe(true);
  }
  expectSourceSidecarsKept(s);
  if (e.stageClean !== false) expect(s.stageResidue(), "stage 残留").toEqual([]);
}

export { ANCHOR };
