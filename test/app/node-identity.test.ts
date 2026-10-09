/**
 * 节点稳定身份(<root>/config/node.json)测试。
 *
 * 这些用例直接调 ensureNodeIdentity(root),不依赖 DOUYIN_REC_ROOT env —— 显式 root 参数
 * 让每个用例在自己的临时目录里独立生成身份,互不干扰。
 */
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, rmSync, readFileSync, writeFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { ensureNodeIdentity, rootNodeIdentityPath } from "../../packages/app/src/paths.js";

describe("ensureNodeIdentity(节点稳定身份)", () => {
  let dir: string;
  beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "nodeid-")); });
  afterEach(() => { rmSync(dir, { recursive: true, force: true }); });

  it("首次调用生成 16 字符 hex id + 落盘到 <root>/config/node.json", () => {
    const id = ensureNodeIdentity(dir);
    // 8 字节随机 → 16 字符小写 hex(只含 [0-9a-f],满足 worker id 路由字符集)。
    expect(id.nodeId).toMatch(/^[0-9a-f]{16}$/);
    expect(id.createdAt).toBeTruthy();
    expect(existsSync(rootNodeIdentityPath(dir))).toBe(true);
  });

  it("幂等:再次调用返回同一 nodeId,绝不重写", () => {
    const a = ensureNodeIdentity(dir);
    const b = ensureNodeIdentity(dir);
    expect(b.nodeId).toBe(a.nodeId);
    // 二次调用不改文件
    const onDisk = JSON.parse(readFileSync(rootNodeIdentityPath(dir), "utf-8"));
    expect(onDisk.nodeId).toBe(a.nodeId);
  });

  it("坏 JSON → 重新生成(容错,不抛)", () => {
    ensureNodeIdentity(dir);                      // 先建
    writeFileSync(rootNodeIdentityPath(dir), "{ 坏 json");
    const id = ensureNodeIdentity(dir);           // 应重建
    expect(id.nodeId).toBeTruthy();
    expect(JSON.parse(readFileSync(rootNodeIdentityPath(dir), "utf-8")).nodeId).toBe(id.nodeId);
  });

  it("两次独立生成(不同 root)→ nodeId 不同", () => {
    const d2 = mkdtempSync(join(tmpdir(), "nodeid2-"));
    try {
      expect(ensureNodeIdentity(dir).nodeId).not.toBe(ensureNodeIdentity(d2).nodeId);
    } finally { rmSync(d2, { recursive: true, force: true }); }
  });

  it("nodeId 满足 worker id 的字符约束(可安全用于 URL 路由 /api/hub/workers/:id)", () => {
    // server.ts 路由 = /^\/api\/hub\/workers\/([A-Za-z0-9_-]+)$/ —— nodeId 必须落在该字符集内。
    const routeRe = /^\/api\/hub\/workers\/([A-Za-z0-9_-]+)$/;
    for (let i = 0; i < 20; i++) {
      const d = mkdtempSync(join(tmpdir(), "nodeid-re-"));
      try {
        const id = ensureNodeIdentity(d).nodeId;
        expect(routeRe.test(`/api/hub/workers/${id}`)).toBe(true);
      } finally { rmSync(d, { recursive: true, force: true }); }
    }
  });
});
