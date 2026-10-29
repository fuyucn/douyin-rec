// plans/036 T3:接线 —— 路由 / API handler / paths 转发 / 包内禁用目录推导(grep 验收)。
import { describe, it, expect } from "vitest";
import { readdirSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { matchRoute } from "../../packages/app/src/web/server.js";
import { buildProc } from "../../packages/app/src/web/api/proc.js";
import { procQueueDbPath as appProcQueueDbPath } from "../../packages/app/src/paths.js";
import { procQueueDbPath } from "@drec/proc-queue";

describe("web 路由 / handler", () => {
  it("GET /api/proc/active、POST /api/proc/purge 命中;错误方法不命中", () => {
    expect(matchRoute("GET", "/api/proc/active")).toEqual({ name: "procActive" });
    expect(matchRoute("POST", "/api/proc/purge")).toEqual({ name: "procPurge", needsBody: true });
    expect(matchRoute("POST", "/api/proc/active")).toBeNull();
    expect(matchRoute("GET", "/api/proc/purge")).toBeNull();
  });

  it("未注入依赖 → 503 显式不可用;注入后 200,purgeFailed 只认严格 true", () => {
    const none = buildProc({});
    expect(none.procActive().status).toBe(503);
    expect(none.procPurge({}).status).toBe(503);
    const seen: boolean[] = [];
    const api = buildProc({
      active: () => ({ host: true, running: {}, pending: {}, leaseAlive: {} }),
      purge: (o) => { seen.push(o.purgeFailed); return { deleted: 3 }; },
    });
    expect(api.procActive()).toEqual({ status: 200, body: { host: true, running: {}, pending: {}, leaseAlive: {} } });
    expect(api.procPurge({ purgeFailed: true }).body).toEqual({ deleted: 3 });
    api.procPurge({});
    api.procPurge({ purgeFailed: "yes" as unknown as boolean });
    expect(seen).toEqual([true, false, false]);
  });
});

describe("paths 转发", () => {
  it("app 的 procQueueDbPath() = 包函数(drecRoot())", () => {
    const old = process.env.DOUYIN_REC_ROOT;
    process.env.DOUYIN_REC_ROOT = "/tmp/some-root";
    try {
      expect(appProcQueueDbPath()).toBe(procQueueDbPath("/tmp/some-root"));
      expect(appProcQueueDbPath()).toBe("/tmp/some-root/db/proc-queue.db");
    } finally {
      if (old === undefined) delete process.env.DOUYIN_REC_ROOT; else process.env.DOUYIN_REC_ROOT = old;
    }
  });
});

describe("proc-queue 包内禁止目录推导(plans/036 Global Constraints)", () => {
  it("源码不含 readdirSync / groupSessions / readdir", () => {
    const dir = join(import.meta.dirname, "..", "..", "packages", "proc-queue", "src");
    for (const f of readdirSync(dir)) {
      const text = readFileSync(join(dir, f), "utf-8");
      expect(text, f).not.toMatch(/readdirSync|groupSessions|\breaddir\b|opendir/);
    }
  });

  it("不 import 任何处理器 / observability / app(只依赖 core)", () => {
    const dir = join(import.meta.dirname, "..", "..", "packages", "proc-queue", "src");
    for (const f of readdirSync(dir)) {
      const imports = [...readFileSync(join(dir, f), "utf-8").matchAll(/from "(@drec\/[^"]+)"/g)].map((m) => m[1]);
      for (const i of imports) expect(i, f).toBe("@drec/core");
    }
  });
});
