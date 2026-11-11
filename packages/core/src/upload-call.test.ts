import { describe, it, expect, vi } from "vitest";
import { APPEND_AMBIGUOUS_MARKER, PLAIN_NO_BV_MARKER } from "@drec/core";
import { appendArchive, createArchive } from "./upload-call.js";
import { fakeUploadTarget } from "../../../packages/orchestrator/src/test-target.js";

const opts = { video: "/s/plain.mp4", cookies: "/c", title: "T", tag: "a,b", tid: 21, public: false };

describe("upload-call: proof 判定与错误语义(阶段 1b 步 2)", () => {
  it("create: created → 返回 BV,且把 UploadOpts 映射成 files/policy/tags", async () => {
    const create = vi.fn(async () => ({ proof: "created" as const, ref: { targetId: "fake", id: "BV1" } }));
    const t = fakeUploadTarget();
    const seen: unknown[] = [];
    const spy = { ...t, create: async (i: unknown) => { seen.push(i); return create() as never; } };
    await expect(createArchive(spy as never, opts)).resolves.toBe("BV1");
    const input = seen[0] as { files: Array<{ path: string }>; policy: { visibility: string }; tags: string[]; tid: number; title: string };
    expect(input.files).toEqual([{ path: "/s/plain.mp4" }]);
    expect(input.policy.visibility).toBe("private");
    expect(input.tags).toEqual(["a,b"]); // 原样透传,不切分
    expect(input.tid).toBe(21);
  });

  it("create: proof unknown → 抛 [plain-no-bv],绝不返回空 BV(否则上层会拿空 bv 继续跑)", async () => {
    const t = { ...fakeUploadTarget(), create: async () => ({ proof: "unknown" as const, ref: null }) };
    await expect(createArchive(t as never, opts)).rejects.toThrow(PLAIN_NO_BV_MARKER);
  });

  it("create: tag 原样透传(不切分/不 trim)——旧链把整串交给 biliup --tag", async () => {
    const seen: Array<{ tags: string[] }> = [];
    const t = { ...fakeUploadTarget(), create: async (i: { tags: string[] }) => { seen.push(i); return { proof: "created" as const, ref: { targetId: "fake", id: "BV1" } }; } };
    await createArchive(t as never, { ...opts, tag: "a, b,c ," });
    // 原样:一个元素;target 侧 join 后仍是 "a, b,c ," —— 拆开再拼会变成 "a,b,c"。
    expect(seen[0]!.tags).toEqual(["a, b,c ,"]);
  });

  it("hooks 透传到目标(1b-3 要用它把子进程进度回报给编排层)", async () => {
    const seen: Array<{ hooks?: { onLine?: (l: string) => void } }> = [];
    const lines: string[] = [];
    const t = { ...fakeUploadTarget(), create: async (i: { hooks?: { onLine?: (l: string) => void } }) => { seen.push(i); i.hooks?.onLine?.("progress"); return { proof: "created" as const, ref: { targetId: "fake", id: "BV1" } }; } };
    await createArchive(t as never, opts, { onLine: (l) => lines.push(l) });
    expect(lines).toEqual(["progress"]);
    expect(seen[0]!.hooks).toBeDefined();
  });

  it("append: proof observed → 静默成功", async () => {
    const t = { ...fakeUploadTarget(), append: async () => ({ proof: "observed" as const }) };
    await expect(appendArchive(t as never, { bv: "BV1", files: ["/s/a.mp4"], cookies: "/c", public: true })).resolves.toBeUndefined();
  });

  it("append: proof unknown → 抛 [append-ambiguous](上层据此不重试,避免重复分 P)", async () => {
    const t = { ...fakeUploadTarget(), append: async () => ({ proof: "unknown" as const }) };
    await expect(appendArchive(t as never, { bv: "BV1", files: ["/s/a.mp4"], cookies: "/c", public: false }))
      .rejects.toThrow(APPEND_AMBIGUOUS_MARKER);
  });

  it("append: public 透传 → policy 可见性为 public(防 append 重置 P1 的公开设置)", async () => {
    const seen: Array<{ policy: { visibility: string } }> = [];
    const t = { ...fakeUploadTarget(), append: async (i: { policy: { visibility: string } }) => { seen.push(i); return { proof: "observed" as const }; } };
    await appendArchive(t as never, { bv: "BV1", files: ["/s/a.mp4"], cookies: "/c", public: true });
    expect(seen[0]!.policy.visibility).toBe("public");
  });
});
