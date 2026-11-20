/**
 * hub-job-retry.test.ts — Hub 节点重试 UI 与后端能力对拍(issue #723)。
 *
 * 背景:前端曾把 clean_* / clean_verify 也当成可重试节点,但后端 `retryNode` 的 CORE
 * allowlist 只有六节点 → 点了必得 400;「补跑收尾」按钮更是走整场 onRunNow(会被
 * run-now-guard 以 409 拒绝,强制后又会越过只收尾分支)。本文件钉住:
 *   1. 前端可重试集合 == 后端 CORE allowlist(静态对拍,防止再漂移);
 *   2. 清理类节点不可重试(不发请求);
 *   3. 上传类节点必须二次确认,确认后只发一次带 force 的请求;
 *   4. 组件源码里不再有「补跑收尾」入口。
 *
 * web 没有 React 测试栈(无 vitest/DOM),这里的做法与 test/web 其余文件一致:
 * 纯函数直接导入 + 源码静态断言。
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { describe, expect, it } from "vitest";
import {
  RETRYABLE_NODES,
  RETRY_CONFIRM_NODES,
  isRetryableNode,
  needsRetryConfirm,
  planRetry,
  retryRequest,
} from "../../packages/web/src/lib/hub-job-retry.js";

const ROOT = join(__dirname, "..", "..");
const BACKEND = join(ROOT, "packages", "hub-compose", "src", "hub-actions.ts");
const COMPONENT = join(ROOT, "packages", "web", "src", "components", "HubJobs.tsx");
const CAPS = join(ROOT, "packages", "web", "src", "lib", "hub-job-retry.ts");

/** 后端 CORE allowlist(从源码抠出来,避免手抄第二份)。 */
function backendCore(): string[] {
  const src = readFileSync(BACKEND, "utf-8");
  const m = /const CORE: WorkflowNodeKey\[\] = \[([^\]]*)\]/.exec(src);
  if (!m) throw new Error("未能在 hub-actions.ts 中找到 CORE allowlist");
  return [...m[1]!.matchAll(/"([^"]+)"/g)].map((x) => x[1]!);
}

/** 后端 unsafe(需 force)的节点集合。 */
function backendUnsafe(): string[] {
  const src = readFileSync(BACKEND, "utf-8");
  const m = /const unsafe = \(n: WorkflowNodeKey\): boolean =>([\s\S]*?);/.exec(src);
  if (!m) throw new Error("未能在 hub-actions.ts 中找到 unsafe 判定");
  return [...m[1]!.matchAll(/n === "([^"]+)"/g)].map((x) => x[1]!);
}

describe("前端可重试节点集合与后端 allowlist 对拍", () => {
  it("RETRYABLE_NODES == 后端 CORE 六节点", () => {
    expect([...RETRYABLE_NODES].sort()).toEqual([...backendCore()].sort());
    expect(RETRYABLE_NODES).toHaveLength(6);
  });

  it("确认节点集合 == 后端 unsafe(需 force)节点", () => {
    expect([...RETRY_CONFIRM_NODES].sort()).toEqual([...backendUnsafe()].sort());
  });

  it("清理类节点(含 clean_verify)一律不可重试", () => {
    for (const n of ["clean_verify", "clean_source", "clean_stage_src", "clean_stage", "select", "pull", "node_upload"]) {
      expect(isRetryableNode(n)).toBe(false);
      expect(planRetry(n)).toEqual({ kind: "none" });
    }
  });

  it("能力集合里不含任何清理节点(前端侧第二道闸)", () => {
    const caps = readFileSync(CAPS, "utf-8");
    for (const n of ["clean_verify", "clean_source", "clean_stage_src", "clean_stage"]) {
      expect(RETRYABLE_NODES).not.toContain(n);
      expect(RETRY_CONFIRM_NODES).not.toContain(n);
      expect(caps).not.toContain(`"${n}"`);
    }
  });

  it("后端 CORE allowlist 本身不含清理节点(本 issue 不扩后端)", () => {
    const core = backendCore();
    for (const n of ["clean_verify", "clean_source", "clean_stage_src", "clean_stage"]) {
      expect(core).not.toContain(n);
    }
  });
});

describe("retryRequest 的行为", () => {
  it("不可重试节点不发请求(点击被忽略)", () => {
    const calls: unknown[][] = [];
    const out = retryRequest("clean_source", "douyin:1:2026-07-04", (k, n, f) => { calls.push([k, n, f]); });
    expect(out).toBe("ignored");
    expect(calls).toHaveLength(0);
  });

  it("普通节点点击直接发一次请求(不带 force)", () => {
    const calls: unknown[][] = [];
    const out = retryRequest("merge", "douyin:1:2026-07-04", (k, n, f) => { calls.push([k, n, f]); });
    expect(out).toBe("sent");
    expect(calls).toEqual([["douyin:1:2026-07-04", "merge", false]]);
  });

  it("上传节点未确认时只弹确认、不发请求", () => {
    for (const n of RETRY_CONFIRM_NODES) {
      const calls: unknown[][] = [];
      const out = retryRequest(n, "douyin:1:2026-07-04", (k, node, f) => { calls.push([k, node, f]); });
      expect(out).toBe("needs-confirm");
      expect(calls).toHaveLength(0);
    }
  });

  it("上传节点确认后只发一次带 force 的请求", () => {
    for (const n of RETRY_CONFIRM_NODES) {
      const calls: unknown[][] = [];
      const out = retryRequest(n, "douyin:1:2026-07-04", (k, node, f) => { calls.push([k, node, f]); }, { confirmed: true });
      expect(out).toBe("sent");
      expect(calls).toEqual([["douyin:1:2026-07-04", n, true]]);
    }
  });

  it("确认判定与 planRetry 一致(上传类 confirm,其余 send)", () => {
    for (const n of RETRYABLE_NODES) {
      const confirm = needsRetryConfirm(n);
      expect(confirm).toBe(RETRY_CONFIRM_NODES.includes(n));
      expect(planRetry(n).kind).toBe(confirm ? "confirm" : "send");
    }
  });
});

describe("组件源码(静态断言)", () => {
  const src = readFileSync(COMPONENT, "utf-8");

  it("重试按钮的可重试判定走后端对齐的能力集合,不再自带清理节点列表", () => {
    expect(src).toContain("isRetryableNode(n.key)");
    expect(src).not.toContain("const RETRYABLE = new Set(");
  });

  it("不再有「补跑收尾」入口(不冒充整场 onRunNow 的清理)", () => {
    expect(src).not.toContain("pendingFinalizeNodes");
    expect(src).not.toContain("retryFinalize");
    // done 场不再挂任何走 onRunNow 的按钮(不得把整场重跑冒充成「只做清理」)
    expect(src).not.toMatch(/job\.state === "done"[\s\S]{0,300}onRunNow/);
  });

  it("节点重试统一经 retryRequest 发送(一次点击只发一次)", () => {
    expect(src).toContain("retryRequest(");
  });
});
