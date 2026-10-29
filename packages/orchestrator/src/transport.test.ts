import { describe, it, expect, beforeEach } from "vitest";
import { chmodSync, mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
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

  it("真实 ssh 路径:调用方给的 timeoutMs 生效(到点被杀),报错带节点 stderr 末尾(issue #202)", async () => {
    // 假 ssh:往 stderr 写一行后挂起;若 timeoutMs 被忽略(退回 30min)本用例会超时失败。
    const dir = mkdtempSync(join(tmpdir(), "fake-ssh-"));
    writeFileSync(join(dir, "ssh"), "#!/bin/sh\necho 'biliup 分块上传停滞' >&2\nexec sleep 30\n");
    chmodSync(join(dir, "ssh"), 0o755);
    const oldPath = process.env.PATH;
    process.env.PATH = `${dir}:${oldPath}`;
    try {
      const t = new SshTransport({ id: "vps", host: "h", dataRoot: "/drec" });
      const started = Date.now();
      await expect(t.nodePipeline(
        { streamKey: "douyin:1:2026-01-01", tsFiles: ["/a.ts"], mergeSegments: true, uploadMode: "upload", stageDir: "/drec/stage", uploadMeta: { tag: "t", tid: 21 }, uploadPrivate: true },
        { timeoutMs: 600 },
      )).rejects.toThrow(/ssh 超时 600ms 被杀.*节点 stderr 末尾: biliup 分块上传停滞/);
      expect(Date.now() - started).toBeLessThan(10_000);
    } finally {
      process.env.PATH = oldPath;
      rmSync(dir, { recursive: true, force: true });
    }
  });
});
