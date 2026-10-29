// plans/036 T6:remuxProcessor(契约实现)——run / recover / validate / 契约边界 / 静态守护。
// 全部用临时目录 + 假 remux / 假 ffprobe 注入(不依赖本机 ffmpeg)。
import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { existsSync, linkSync, mkdirSync, mkdtempSync, readdirSync, readFileSync, rmSync, statSync, utimesSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { execFileSync } from "node:child_process";
import {
  assertJobInvariants, jobIdOf, type ProcessContext, type ProcessJob,
} from "@drec/core";
import {
  convertSegmentInPlace, makeRemuxProcessor, markSessionNodeFormat, NODE_REMUX_SUSPECT_SUFFIX, remuxTargetPath, remuxTmpPath, remuxProcessor,
  type MediaProbe, type NodeRemuxDeps,
} from "@drec/processors";

const B = "主播_2026-10-15_21-00-00";
let dir: string;
beforeEach(() => { dir = mkdtempSync(join(tmpdir(), "remux-proc-")); });
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const put = (n: string, body = "dur=60"): string => { const p = join(dir, n); writeFileSync(p, body); return p; };
const ls = (): string[] => readdirSync(dir).sort();

const probe = async (p: string): Promise<MediaProbe> => {
  const body = readFileSync(p, "utf-8");
  if (body.includes("unreadable")) throw new Error("ffprobe: Invalid data");
  const m = /dur=(\d+(?:\.\d+)?)/.exec(body);
  const dur = m ? Number(m[1]) : 0;
  const sp = /span=(\d+(?:\.\d+)?)/.exec(body);
  return { durationSec: dur, hasVideo: true, spanSec: sp ? Number(sp[1]) : dur, packets: dur === 0 ? 0 : 100 };
};
const copyRemux: NonNullable<NodeRemuxDeps["remux"]> = async (src, tmp) => { writeFileSync(tmp, readFileSync(src, "utf-8")); };
const baseDeps = (over: Partial<NodeRemuxDeps> = {}): NodeRemuxDeps => ({ remux: copyRemux, probe, freeBytes: () => 1e12, ...over });

interface Ctx extends ProcessContext { alerts: string[]; logs: string[]; leaseChecks: number; }
function ctx(over: Partial<ProcessContext> = {}, ac = new AbortController()): Ctx {
  const c = {
    alerts: [] as string[], logs: [] as string[], leaseChecks: 0,
    signal: ac.signal,
    assertLease: () => { c.leaseChecks++; },
    markProgress: () => {},
    log: (m: string) => { c.logs.push(m); },
    alert: (m: string) => { c.alerts.push(m); },
    ...over,
  };
  return c;
}

function job(src: string, over: Partial<ProcessJob> & { claimedBy?: string } = {}): ProcessJob {
  const logicalKey = `task1:${src.split("/").pop()}@1-1`;
  return {
    jobId: jobIdOf("remux", logicalKey, 1), kind: "remux", logicalKey, generation: 1,
    inputs: [src], params: { format: "mkv", owner: "room1" }, replaceInputs: true, owner: { taskId: 1 }, createdAt: 0,
    ...over,
  };
}

describe("remuxProcessor — 契约形态", () => {
  it("cpu / lane=copy / retryable / interruptible", () => {
    expect(remuxProcessor).toMatchObject({ kind: "remux", resource: "cpu", lane: "copy", retryable: true, interruptible: true });
  });
  it("validate:拒多输入 / 非原生容器 / 非法 format / replaceInputs=false", () => {
    const p = makeRemuxProcessor();
    const src = put(`${B}_000.ts`);
    expect(p.validate(job(src))).toBeNull();
    expect(p.validate(job(src, { inputs: [src, src] }))).toMatch(/1 个输入/);
    expect(p.validate(job(put(`${B}_001.mp4`)))).toMatch(/原生容器/);
    expect(p.validate(job(src, { params: { format: "avi" } }))).toMatch(/format/);
    expect(p.validate(job(src, { replaceInputs: false }))).toMatch(/replaceInputs/);
  });
  it("契约层拒绝 xml / ass / 会话边车进 replaceInputs(不可再生,绝不被「原地替换」删掉)", () => {
    for (const bad of [`${B}.xml`, `${B}.ass`, `${B}.session.json`]) {
      const j = job(join(dir, bad));
      expect(() => assertJobInvariants(j, { allowedRoots: [dir] }), bad).toThrow(/replaceInputs/);
    }
  });
});

describe("run — 校验通过才删原文件", () => {
  it("成功:只剩新容器一份,outputs = 目标路径", async () => {
    const src = put(`${B}_000.ts`);
    const r = await makeRemuxProcessor(baseDeps()).run(job(src), ctx());
    expect(r.outputs).toEqual([remuxTargetPath(src, "mkv")]);
    expect(ls().filter((n) => /\.(ts|mkv|drec-remux)$/.test(n))).toEqual([`${B}_000.mkv`]);
  });

  it("转换后最终文件继承原文件 atime/mtime(清单用 mtime 当分段结束时间,不继承会让对账把已完成的同一场聚成新簇)", async () => {
    const src = put(`${B}_000.ts`);
    const past = new Date(Date.now() - 3 * 3600_000);
    utimesSync(src, past, past);
    const before = statSync(src);
    const r = await makeRemuxProcessor(baseDeps()).run(job(src), ctx());
    const after = statSync(r.outputs![0]);
    expect(Math.abs(after.mtimeMs - before.mtimeMs)).toBeLessThanOrEqual(1);
    expect(Math.abs(after.atimeMs - before.atimeMs)).toBeLessThanOrEqual(1);
  });

  it("recover 重跑路径(只有 tmp → rerun → run)同样继承原 mtime", async () => {
    const src = put(`${B}_000.ts`);
    const past = new Date(Date.now() - 2 * 3600_000);
    utimesSync(src, past, past);
    const final = remuxTargetPath(src, "mkv");
    writeFileSync(remuxTmpPath(final, "room1", 4242), "dur=1"); // 上一持有者(已死)留下的 tmp
    const p = makeRemuxProcessor(baseDeps());
    const j = { ...job(src), claimedBy: "serve:4242:1" } as ProcessJob;
    expect(await p.recover!(j, ctx())).toBe("rerun");
    await p.run(j, ctx());
    expect(Math.abs(statSync(final).mtimeMs - past.getTime())).toBeLessThanOrEqual(1);
  });

  it("校验未通过(时长不符)→ 抛错、原文件保留、无 tmp、新文件不落最终名;失败文案只经抛错出口(不在 ctx.alert 里双发)", async () => {
    const src = put(`${B}_000.ts`);
    const c = ctx();
    await expect(makeRemuxProcessor(baseDeps({ remux: async (s, t) => { writeFileSync(t, "dur=10"); } })).run(job(src), c))
      .rejects.toThrow(/verify-failed/);
    expect(ls().filter((n) => /\.(ts|mkv|drec-remux)$/.test(n))).toEqual([`${B}_000.ts`]);
    expect(c.alerts).toEqual([]);
  });

  it("不可逆动作前 assertLease:失租 → 原文件与(已校验的)新文件都在、不删原文件", async () => {
    const src = put(`${B}_000.ts`);
    let n = 0;
    const c = ctx({ assertLease: () => { if (++n === 2) throw new Error("[proc] 租约已丢"); } }); // 1=rename 前, 2=删原文件前
    await expect(makeRemuxProcessor(baseDeps()).run(job(src), c)).rejects.toThrow(/租约已丢/);
    expect(existsSync(src)).toBe(true);
    expect(existsSync(remuxTargetPath(src, "mkv"))).toBe(true);
  });

  it("rename 前失租 → 清 tmp、原文件在、无最终名", async () => {
    const src = put(`${B}_000.ts`);
    const c = ctx({ assertLease: () => { throw new Error("[proc] 租约已丢"); } });
    await expect(makeRemuxProcessor(baseDeps()).run(job(src), c)).rejects.toThrow();
    expect(ls().filter((n) => /\.(ts|mkv|drec-remux)$/.test(n))).toEqual([`${B}_000.ts`]);
  });

  it("abort 信号(关停)→ signal 透传给 remux,抛错、tmp 清理、原文件不动", async () => {
    const src = put(`${B}_000.ts`);
    const ac = new AbortController();
    let seen: AbortSignal | undefined;
    const p = makeRemuxProcessor(baseDeps({
      remux: async (_s, t, _f, signal) => {
        seen = signal; writeFileSync(t, "dur=60");
        ac.abort();
        if (signal?.aborted) throw new Error("ffmpeg 已取消(abort)");
      },
    }));
    await expect(p.run(job(src), ctx({}, ac))).rejects.toThrow();
    expect(seen).toBe(ac.signal);
    expect(ls().filter((n) => /\.(ts|mkv|drec-remux)$/.test(n))).toEqual([`${B}_000.ts`]);
  });

  it("原文件已不在但目标在 = 上次已完成 → 返回 outputs 不报错;两者都不在 → 抛错", async () => {
    const p = makeRemuxProcessor(baseDeps());
    const gone = join(dir, `${B}_000.ts`);
    put(`${B}_000.mkv`);
    expect((await p.run(job(gone), ctx())).outputs).toEqual([join(dir, `${B}_000.mkv`)]);
    await expect(p.run(job(join(dir, `${B}_009.ts`)), ctx())).rejects.toThrow(/原文件不存在/);
  });

  it("磁盘余量不足 → 抛错、不调 remux(不把盘撑满)", async () => {
    const src = put(`${B}_000.ts`);
    let called = false;
    const p = makeRemuxProcessor(baseDeps({ freeBytes: () => 1, remux: async () => { called = true; } }));
    await expect(p.run(job(src), ctx())).rejects.toThrow(/no-space/);
    expect(called).toBe(false);
  });
});

describe("recover — 只碰 job 列出的路径,绝不删最后一份", () => {
  const dead = "record:4242:1";
  const recJob = (src: string, extra: Record<string, unknown> = {}): ProcessJob =>
    ({ ...job(src), claimedBy: dead, ...extra }) as ProcessJob;

  it("只有 tmp(无目标)→ 删 tmp → rerun;原文件不动", async () => {
    const src = put(`${B}_000.ts`);
    const tmp = remuxTmpPath(remuxTargetPath(src, "mkv"), "room1", 4242);
    writeFileSync(tmp, "partial");
    expect(await makeRemuxProcessor(baseDeps()).recover!(recJob(src), ctx())).toBe("rerun");
    expect(existsSync(tmp)).toBe(false);
    expect(existsSync(src)).toBe(true);
  });

  it("什么都没产生(标记已写、未开工)→ rerun;原文件在", async () => {
    const src = put(`${B}_000.ts`);
    expect(await makeRemuxProcessor(baseDeps()).recover!(recJob(src), ctx())).toBe("rerun");
    expect(existsSync(src)).toBe(true);
  });

  it("目标存在、原文件存在且校验通过 → done 并删原文件(留新文件)", async () => {
    const src = put(`${B}_000.ts`);
    markSessionNodeFormat(dir, B, "mkv");
    const final = put(`${B}_000.mkv`);
    const c = ctx();
    expect(await makeRemuxProcessor(baseDeps()).recover!(recJob(src), c)).toBe("done");
    expect(existsSync(src)).toBe(false);
    expect(existsSync(final)).toBe(true);
    expect(c.leaseChecks).toBeGreaterThan(0); // 删原文件前确认租约
  });

  it("目标存在但存疑(校验不通过)→ uncertain + 新文件隔离为 .drec-suspect;两份都留", async () => {
    const src = put(`${B}_000.ts`);
    markSessionNodeFormat(dir, B, "mkv");
    put(`${B}_000.mkv`, "dur=10"); // 截断
    expect(await makeRemuxProcessor(baseDeps()).recover!(recJob(src), ctx())).toBe("uncertain");
    expect(existsSync(src)).toBe(true);
    expect(existsSync(join(dir, `${B}_000.mkv${NODE_REMUX_SUSPECT_SUFFIX}`))).toBe(true);
    expect(existsSync(join(dir, `${B}_000.mkv`))).toBe(false); // 不再被分组当成第二份分段
  });

  it("无法判定(探测抛错)同样 uncertain,不删任何一份", async () => {
    const src = put(`${B}_000.ts`);
    markSessionNodeFormat(dir, B, "mkv");
    put(`${B}_000.mkv`, "unreadable");
    expect(await makeRemuxProcessor(baseDeps()).recover!(recJob(src), ctx())).toBe("uncertain");
    expect(existsSync(src)).toBe(true);
  });

  it("无边车标记的同名目标(外部文件)→ uncertain,不碰、不隔离、不删", async () => {
    const src = put(`${B}_000.ts`);
    const final = put(`${B}_000.mkv`);
    expect(await makeRemuxProcessor(baseDeps()).recover!(recJob(src), ctx())).toBe("uncertain");
    expect(existsSync(src)).toBe(true);
    expect(existsSync(final)).toBe(true);
  });

  it("目标在、原文件已删 → done(目标是最后一份,绝不动);两个都没有 → uncertain", async () => {
    const p = makeRemuxProcessor(baseDeps());
    const src = join(dir, `${B}_000.ts`);
    const final = put(`${B}_000.mkv`);
    expect(await p.recover!(recJob(src), ctx())).toBe("done");
    expect(existsSync(final)).toBe(true);
    rmSync(final);
    expect(await p.recover!(recJob(src), ctx())).toBe("uncertain");
  });

  it("recover 里删原文件前失租 → 抛错、原文件保留", async () => {
    const src = put(`${B}_000.ts`);
    markSessionNodeFormat(dir, B, "mkv");
    put(`${B}_000.mkv`);
    const c = ctx({ assertLease: () => { throw new Error("[proc] 租约已丢"); } });
    await expect(makeRemuxProcessor(baseDeps()).recover!(recJob(src), c)).rejects.toThrow(/租约已丢/);
    expect(existsSync(src)).toBe(true);
  });

  it("不扫目录:同目录别的会话的孤儿 tmp 不被碰", async () => {
    const src = put(`${B}_000.ts`);
    const other = join(dir, "别人_2026-10-15_20-00-00_000.mkv.roomX-9.drec-remux");
    writeFileSync(other, "x");
    await makeRemuxProcessor(baseDeps()).recover!(recJob(src), ctx());
    expect(existsSync(other)).toBe(true);
  });
});

describe("issue #223 — strict marker and post-rename re-check", () => {
  const IDENTITY = { sessionBase: B, roomSlug: "room1", platform: "douyin", startMs: 1_000 };
  const sc = (): string => join(dir, `${B}.session.json`);
  const readSc = (): Record<string, unknown> => JSON.parse(readFileSync(sc(), "utf-8")) as Record<string, unknown>;
  const alerts: string[] = [];
  beforeEach(() => { alerts.length = 0; });
  const deps = (over: Partial<NodeRemuxDeps> = {}): NodeRemuxDeps => baseDeps({ fsync: () => {}, alert: (m) => alerts.push(m), ...over });

  it("markSessionNodeFormat: truncated JSON throws and leaves the bytes untouched", () => {
    writeFileSync(sc(), "{\"sessionBase\":");
    expect(() => markSessionNodeFormat(dir, B, "mp4")).toThrow(/unparsable/);
    expect(readFileSync(sc(), "utf-8")).toBe("{\"sessionBase\":");
  });
  it("markSessionNodeFormat: array / null / scalar JSON throws and leaves the bytes untouched", () => {
    for (const body of ["[]", "null", "42"]) {
      writeFileSync(sc(), body);
      expect(() => markSessionNodeFormat(dir, B, "mp4"), body).toThrow(/not an object/);
      expect(readFileSync(sc(), "utf-8")).toBe(body);
    }
  });
  it("markSessionNodeFormat: non-ENOENT read error is rethrown (sidecar path is a directory)", () => {
    mkdirSync(sc());
    expect(() => markSessionNodeFormat(dir, B, "mp4")).toThrow(/EISDIR/);
  });
  it("markSessionNodeFormat: missing file → minimal {sessionBase,nodeFormat}", () => {
    markSessionNodeFormat(dir, B, "mkv");
    expect(readSc()).toEqual({ sessionBase: B, nodeFormat: "mkv" });
  });
  it("markSessionNodeFormat: full file → nodeFormat added, identity preserved, written atomically", () => {
    writeFileSync(sc(), JSON.stringify(IDENTITY));
    linkSync(sc(), `${sc()}.lnk`);
    markSessionNodeFormat(dir, B, "mp4");
    expect(readSc()).toEqual({ ...IDENTITY, nodeFormat: "mp4" });
    expect(readFileSync(`${sc()}.lnk`, "utf-8")).toBe(JSON.stringify(IDENTITY));
    expect(ls().filter((n) => n.endsWith(".tmp"))).toEqual([]);
  });

  it("unparsable sidecar up front → mark-failed, original kept, sidecar unchanged, remux never runs", async () => {
    const src = put(`${B}_000.ts`);
    writeFileSync(sc(), "{\"sessionBase\":");
    let remuxed = false;
    const out = await convertSegmentInPlace(src, "mp4", deps({ remux: async () => { remuxed = true; } }));
    expect(out).toMatchObject({ ok: false, reason: "mark-failed" });
    expect(remuxed).toBe(false);
    expect(existsSync(src)).toBe(true);
    expect(readFileSync(sc(), "utf-8")).toBe("{\"sessionBase\":");
  });

  it("scenario B effect: sidecar rewritten without nodeFormat during remux → re-marked before the source is deleted", async () => {
    const src = put(`${B}_000.ts`);
    writeFileSync(sc(), JSON.stringify(IDENTITY));
    const staleManagerWrite: NonNullable<NodeRemuxDeps["remux"]> = async (s, t) => {
      writeFileSync(sc(), JSON.stringify({ ...IDENTITY, title: "t" }));
      await copyRemux(s, t);
    };
    const out = await convertSegmentInPlace(src, "mp4", deps({ remux: staleManagerWrite }));
    expect(out.ok).toBe(true);
    expect(readSc()).toEqual({ ...IDENTITY, title: "t", nodeFormat: "mp4" });
    expect(ls()).toEqual([`${B}.session.json`, `${B}_000.mp4`]);
    expect(alerts).toEqual([]);
  });

  it("re-mark failure: sidecar made unparsable during remux → mark-failed, both files kept, bytes unchanged, one alert", async () => {
    const src = put(`${B}_000.ts`);
    writeFileSync(sc(), JSON.stringify(IDENTITY));
    const corrupt: NonNullable<NodeRemuxDeps["remux"]> = async (s, t) => {
      writeFileSync(sc(), "{\"sessionBase\":");
      await copyRemux(s, t);
    };
    const out = await convertSegmentInPlace(src, "mp4", deps({ remux: corrupt }));
    expect(out).toMatchObject({ ok: false, reason: "mark-failed" });
    expect(existsSync(src)).toBe(true);
    expect(existsSync(join(dir, `${B}_000.mp4`))).toBe(true);
    expect(readFileSync(sc(), "utf-8")).toBe("{\"sessionBase\":");
    expect(alerts).toHaveLength(1);
  });
});

describe("静态守护(plans/036 Global Constraints)", () => {
  const ROOT = join(import.meta.dirname, "..", "..");
  const grep = (pat: string, path: string): string => {
    try { return execFileSync("grep", ["-rnE", pat, path], { encoding: "utf-8" }); } catch { return ""; }
  };
  it("全仓 `function verifyRemuxed` 只一处(唯一校验函数)", () => {
    const out = execFileSync("grep", ["-rn", "--include=*.ts", "function verifyRemuxed", join(ROOT, "packages")], { encoding: "utf-8" });
    expect(out.trim().split("\n")).toHaveLength(1);
    expect(out).toContain("packages/processors/src/remux.ts");
  });
  it("处理器与 proc-queue 内无 readdirSync / groupSessions / 目录推导", () => {
    for (const pkg of ["processors", "proc-queue"]) {
      expect(grep("readdirSync|readdir\\(|groupSessions|deriveStage|deriveSegment", join(ROOT, "packages", pkg, "src")), pkg).toBe("");
    }
  });
  it("issue #223: no in-place writeFileSync of a session sidecar in manager / processors", () => {
    for (const pkg of ["manager", "processors"]) {
      expect(grep("writeFileSync\\([^)]*(session\\.json|sessionJsonOf)", join(ROOT, "packages", pkg, "src")), pkg).toBe("");
    }
  });
  it("临时名命名不变(回滚兼容):{final}.{owner}-{pid}.drec-remux", () => {
    expect(remuxTmpPath("/a/b_000.mkv", "room-1", 7)).toBe("/a/b_000.mkv.room1-7.drec-remux");
  });
});
