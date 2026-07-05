import { describe, it, expect, beforeEach } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listWorkers, createWorker, updateWorker, deleteWorker } from "./worker-store.js";

let cfg: string;
const read = (): any => JSON.parse(readFileSync(cfg, "utf-8"));
beforeEach(() => {
  cfg = join(mkdtempSync(join(tmpdir(), "worker-store-")), "hub.config.json");
  writeFileSync(cfg, JSON.stringify({
    platform: "douyin", stageDir: "/data/stage", cookies: "/c.json",
    workers: [{ id: "local", name: "本机", kind: "local", dataRoot: "/data" }],
    uploadDefaults: { tag: "直播,录像", tid: 21 },
  }, null, 2));
});

describe("worker-store(文件版 CRUD)", () => {
  it("create 分配 worker-1 单调 + 默认 name(host)+ 持久 workerSeq", () => {
    const w = createWorker(cfg, { kind: "ssh", host: "1.2.3.4", dataRoot: "/drec" });
    expect(w.id).toBe("worker-1");
    expect(w.name).toBe("1.2.3.4");           // 无 name → 回落 host
    expect(read().workerSeq).toBe(1);
    const w2 = createWorker(cfg, { kind: "local", dataRoot: "/x", name: "备机" });
    expect(w2.id).toBe("worker-2");
    expect(w2.name).toBe("备机");
  });
  it("seq 不复用:删了 worker-1 再 create 得 worker-2", () => {
    createWorker(cfg, { kind: "ssh", host: "h", dataRoot: "/d" }); // worker-1
    expect(deleteWorker(cfg, "worker-1")).toBe(true);
    expect(createWorker(cfg, { kind: "ssh", host: "h2", dataRoot: "/d" }).id).toBe("worker-2");
  });
  it("默认 name 无 host → `Worker N`", () => {
    expect(createWorker(cfg, { kind: "local", dataRoot: "/d" }).name).toBe("Worker 1");
  });
  it("update 部分改;不存在返回 null", () => {
    createWorker(cfg, { kind: "ssh", host: "h", dataRoot: "/d" });
    expect(updateWorker(cfg, "worker-1", { name: "新名", host: "h2" })!.name).toBe("新名");
    expect(updateWorker(cfg, "worker-1", {})!.host).toBe("h2");
    expect(updateWorker(cfg, "nope", { name: "x" })).toBeNull();
  });
  it("local 保护:拒删 + 拒改 kind;name/dataRoot 可改", () => {
    expect(() => deleteWorker(cfg, "local")).toThrow();
    expect(() => updateWorker(cfg, "local", { kind: "ssh" })).toThrow();
    expect(updateWorker(cfg, "local", { name: "主机", dataRoot: "/data2" })!.dataRoot).toBe("/data2");
  });
  it("kind 校验 + 必填:ssh 需 host+dataRoot;local 需 dataRoot", () => {
    expect(() => createWorker(cfg, { kind: "bogus", dataRoot: "/d" })).toThrow();
    expect(() => createWorker(cfg, { kind: "ssh", dataRoot: "/d" })).toThrow();      // 缺 host
    expect(() => createWorker(cfg, { kind: "local" } as any)).toThrow();             // 缺 dataRoot
  });
  it("保留非 worker 字段(原子写不吞其余配置)", () => {
    createWorker(cfg, { kind: "ssh", host: "h", dataRoot: "/d" });
    const j = read();
    expect(j.platform).toBe("douyin");
    expect(j.stageDir).toBe("/data/stage");
    expect(j.uploadDefaults).toEqual({ tag: "直播,录像", tid: 21 });
  });
  it("tenants→workers 读迁移:旧文件 list 能读,首次写迁移成 workers + 补 workerSeq", () => {
    writeFileSync(cfg, JSON.stringify({ platform: "douyin",
      tenants: [{ id: "local", kind: "local", dataRoot: "/data" }, { id: "vps2", kind: "ssh", host: "h", dataRoot: "/d" }] }, null, 2));
    expect(listWorkers(cfg).map((w) => w.id)).toEqual(["local", "vps2"]);
    createWorker(cfg, { kind: "ssh", host: "h3", dataRoot: "/d" });
    const j = read();
    expect(j.workers.map((w: any) => w.id)).toEqual(["local", "vps2", "worker-1"]); // grandfather 值不变
    expect(j.tenants).toBeUndefined();       // 迁移后删旧键
    expect(j.workerSeq).toBe(1);
  });
});
