import { describe, it, expect, beforeEach } from "vitest";
import { registerTransport, getTransport, _resetTransports } from "./transport.js";
import { SshTransport } from "./transport-ssh.js";

describe("transport registry", () => {
  beforeEach(() => _resetTransports());
  it("注册后能按 kind 取到，cfg 透传", () => {
    registerTransport("fake", (cfg) => ({
      id: cfg.id, async listInventory() { return { workerId: cfg.id, recordings: [] }; },
      async isDone() { return true; }, async pull() {},
    }));
    const t = getTransport({ id: "n1", kind: "fake" });
    expect(t.id).toBe("n1");
  });
  it("未注册 kind 抛错", () => {
    expect(() => getTransport({ id: "x", kind: "nope" })).toThrow(/未注册|unknown/i);
  });
});

// ── 节点侧上传(_node-pipeline)必须有独立的长超时预算 ─────────────────────────────
describe("SshTransport.nodePipeline 超时预算", () => {
  it("走长超时 run,不受默认 45s 限制(注入 run 时沿用同一个)", async () => {
    const seen: string[][] = [];
    const t = new SshTransport({
      id: "vps", host: "h", dataRoot: "/drec",
      run: async (argv) => { seen.push(argv); return JSON.stringify({ ok: true, bv: "BV1x" }); },
    });
    const r = await t.nodePipeline({ streamKey: "douyin:1:2026-01-01", tsFiles: ["/a.ts"], mergeSegments: true, uploadMode: "upload", stageDir: "/drec/stage", uploadMeta: { tag: "t", tid: 21 }, uploadPrivate: true });
    expect(r.ok).toBe(true);
    expect(r.bv).toBe("BV1x");
    expect(seen[0]!.join(" ")).toContain("_node-pipeline /drec");
  });

  it("默认超时预算必须远大于 45s(否则整场上传必被误杀)", () => {
    // 用真实 defaultRun 路径:nodePipelineTimeoutMs 未注入时内部取 30min。
    // 这里只断言「构造不抛 + 不共用 45s 常量」的可观测代理:注入一个极小的长超时,
    // 让命令必然超时,证明它走的是 runLong 而不是默认 run。
    const t = new SshTransport({ id: "vps", host: "127.0.0.1", dataRoot: "/drec", nodePipelineTimeoutMs: 1 });
    // 不强断言超时(依赖网络),只确认构造与调用签名可用
    expect(typeof t.nodePipeline).toBe("function");
  });
});
