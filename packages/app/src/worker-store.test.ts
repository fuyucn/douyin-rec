import { describe, it, expect, beforeEach, vi } from "vitest";
import { mkdtempSync, writeFileSync, readFileSync, unlinkSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { listWorkers, createWorker, updateWorker, deleteWorker, reorderWorkers } from "./worker-store.js";
import { writeResources } from "./hub-config-store.js";

const readFailure = vi.hoisted(() => ({ path: null as string | null, code: null as string | null }));
vi.mock("node:fs", async (importOriginal) => {
  const actual = await importOriginal<typeof import("node:fs")>();
  return {
    ...actual,
    readFileSync: (path: any, ...args: any[]) => {
      if (readFailure.path === String(path)) {
        throw Object.assign(new Error(`mock read failure: ${readFailure.code}`), { code: readFailure.code });
      }
      return actual.readFileSync(path, ...args);
    },
  };
});

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
  it("capabilities 创建/更新往返:去空白/去重/保序;空数组清空该字段", () => {
    const w = createWorker(cfg, { kind: "ssh", host: "h", dataRoot: "/d", capabilities: [" danmu:douyin ", "burn", "danmu:douyin", ""] });
    expect(w.capabilities).toEqual(["danmu:douyin", "burn"]);        // trim + 去重 + 去空
    expect(read().workers.find((x: { id: string }) => x.id === "worker-1").capabilities).toEqual(["danmu:douyin", "burn"]);
    const u = updateWorker(cfg, "worker-1", { capabilities: ["upload"] });
    expect(u!.capabilities).toEqual(["upload"]);
    const cleared = updateWorker(cfg, "worker-1", { capabilities: [] });
    expect(cleared!.capabilities).toBeUndefined();                    // 空数组 → 清空字段
    expect(read().workers.find((x: { id: string }) => x.id === "worker-1").capabilities).toBeUndefined();
  });
  it("capabilities 未传时更新其他字段 → 能力保留", () => {
    createWorker(cfg, { kind: "ssh", host: "h", dataRoot: "/d", capabilities: ["danmu:douyin"] });
    const u = updateWorker(cfg, "worker-1", { name: "改名" });
    expect(u!.capabilities).toEqual(["danmu:douyin"]);
  });
  it("显式 id(节点自报 nodeId)→ 用它作 id,不推进 workerSeq", () => {
    const w = createWorker(cfg, { kind: "ssh", host: "h", dataRoot: "/d", id: "a1b2c3d4-uuid" });
    expect(w.id).toBe("a1b2c3d4-uuid");
    expect(read().workerSeq).toBe(0);   // 显式 id 不占序号
    // 之后自分配仍从 worker-1 起
    expect(createWorker(cfg, { kind: "ssh", host: "h2", dataRoot: "/d" }).id).toBe("worker-1");
  });
  it("显式 id 重复 → 抛错(防重复添加同一节点)", () => {
    createWorker(cfg, { kind: "ssh", host: "h", dataRoot: "/d", id: "same-id" });
    expect(() => createWorker(cfg, { kind: "ssh", host: "h2", dataRoot: "/d", id: "same-id" })).toThrow(/已存在/);
  });
  it("显式 id 为保留字 local → 抛错", () => {
    expect(() => createWorker(cfg, { kind: "ssh", host: "h", dataRoot: "/d", id: "local" })).toThrow(/保留/);
  });
  it("seq 不复用:删了 worker-1 再 create 得 worker-2", () => {
    createWorker(cfg, { kind: "ssh", host: "h", dataRoot: "/d" }); // worker-1
    expect(deleteWorker(cfg, "worker-1")).toBe(true);
    expect(createWorker(cfg, { kind: "ssh", host: "h2", dataRoot: "/d" }).id).toBe("worker-2");
  });
  it("默认 name 无 host → `Worker N`", () => {
    expect(createWorker(cfg, { kind: "local", dataRoot: "/d" }).name).toBe("Worker 1");
  });
  it("update 部分改;不存在时 update/delete 不落盘", () => {
    createWorker(cfg, { kind: "ssh", host: "h", dataRoot: "/d" });
    expect(updateWorker(cfg, "worker-1", { name: "新名", host: "h2" })!.name).toBe("新名");
    expect(updateWorker(cfg, "worker-1", {})!.host).toBe("h2");
    writeFileSync(cfg, JSON.stringify(read())); // 紧凑格式,意外 rename 会改变原始字节
    const original = readFileSync(cfg);
    expect(updateWorker(cfg, "nope", { name: "x" })).toBeNull();
    expect(deleteWorker(cfg, "nope")).toBe(false);
    expect(readFileSync(cfg)).toEqual(original);
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
  it("缺失配置首次创建仍分配 worker-1,后续 writer 延续序号", () => {
    unlinkSync(cfg);
    expect(createWorker(cfg, { kind: "ssh", host: "h", dataRoot: "/d" }).id).toBe("worker-1");
    writeResources(cfg, { maxCpuParallel: 4 });
    expect(createWorker(cfg, { kind: "ssh", host: "h2", dataRoot: "/d" }).id).toBe("worker-2");
    expect(read().resources.maxCpuParallel).toBe(4);
  });
  it.each([
    ["坏 JSON", "{ not json"],
    ["空文件", ""],
    ["数组根形状", "[]"],
    ["null 根形状", "null"],
  ])("写入遇到 %s 时拒绝所有 worker CRUD 且原字节不变", (_label, contents) => {
    writeFileSync(cfg, contents, "utf-8");
    const original = readFileSync(cfg);
    const writes = [
      () => createWorker(cfg, { kind: "ssh", host: "h", dataRoot: "/d" }),
      () => updateWorker(cfg, "missing", { name: "changed" }),
      () => deleteWorker(cfg, "missing"),
      () => reorderWorkers(cfg, []),
    ];
    for (const write of writes) {
      expect(write).toThrow(/配置|JSON|根/);
      expect(readFileSync(cfg)).toEqual(original);
    }
  });
  it.each(["EACCES", "EPERM", "EIO"])("读取 %s 时拒绝写且保留原文件", (code) => {
    const original = readFileSync(cfg);
    readFailure.path = cfg;
    readFailure.code = code;
    try {
      const writes = [
        () => createWorker(cfg, { kind: "ssh", host: "h", dataRoot: "/d" }),
        () => updateWorker(cfg, "missing", { name: "changed" }),
        () => deleteWorker(cfg, "missing"),
        () => reorderWorkers(cfg, []),
      ];
      for (const write of writes) expect(write).toThrow(code);
      expect(listWorkers(cfg)).toEqual([]); // 展示读取仍宽松
    } finally {
      readFailure.path = null;
      readFailure.code = null;
    }
    expect(readFileSync(cfg)).toEqual(original);
  });
  it("交替 CRUD 保留未知顶层字段与未修改 worker 的扩展字段", () => {
    writeFileSync(cfg, JSON.stringify({
      platform: "douyin", extraTopLevel: { keep: true }, workerSeq: 4,
      workers: [
        { id: "local", name: "本机", kind: "local", dataRoot: "/data", extension: "local-extra" },
        { id: "worker-4", name: "old", kind: "ssh", host: "h", dataRoot: "/d", extension: "worker-extra" },
      ],
    }), "utf-8");
    updateWorker(cfg, "worker-4", { name: "updated" });
    createWorker(cfg, { kind: "ssh", host: "h2", dataRoot: "/d" });
    reorderWorkers(cfg, ["worker-5", "worker-4", "local"]);
    deleteWorker(cfg, "worker-5");
    const saved = read();
    expect(saved.extraTopLevel).toEqual({ keep: true });
    expect(saved.workers.find((w: any) => w.id === "worker-4").extension).toBe("worker-extra");
    expect(saved.workers.find((w: any) => w.id === "local").extension).toBe("local-extra");
  });
  it("reorder:按 ids 整体重排数组(顺序 = 显示序),集合不匹配则拒绝", () => {
    createWorker(cfg, { kind: "ssh", host: "h2", dataRoot: "/d" }); // worker-1
    const w3 = createWorker(cfg, { kind: "ssh", host: "h3", dataRoot: "/d" }); // worker-2
    expect(reorderWorkers(cfg, ["worker-2", "local", "worker-1"]).map((w) => w.id)).toEqual(["worker-2", "local", "worker-1"]);
    expect(listWorkers(cfg).map((w) => w.id)[0]).toBe("worker-2");
    // 未知 id / 缺一项 → 报错且不改盘
    expect(() => reorderWorkers(cfg, ["local", "worker-1", "ghost"])).toThrow();
    expect(() => reorderWorkers(cfg, ["local"])).toThrow();
    expect(listWorkers(cfg).map((w) => w.id)[0]).toBe("worker-2");
    expect(w3.kind).toBe("ssh"); // 安静失败不影响内容
  });
});
