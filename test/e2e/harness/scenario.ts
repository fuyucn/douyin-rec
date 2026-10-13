/**
 * 场景驱动(E2E 脚手架):纯本地、进程内跑完整「收播后」流程。
 *
 * 真实部分:`Reconciler.reconcileAll` → `runPipeline`(select / pull / merge|分段|节点侧 / 上传 /
 * 核验 / 清理)、真 `SyncLedger`(sqlite 落盘,可「重启」重开)、真 `LocalTransport`(扫描 + 硬链接 pull)、
 * 真 `ResourcePool`、真 biliup 包装(经 {@link FakeBiliup} 的 `run` 接缝)。
 * 替身部分:ffmpeg/ffprobe(`sh`、remux、时长探测只写占位文件)、biliup 进程与 B站(FakeBiliup)。
 *
 * 「重启」= {@link Scenario.restart}:丢弃 Reconciler / 资源池 / 台账连接,用同一 db 与同一磁盘目录重建
 * (进程内存态全丢,磁盘与台账保留)。
 */
import { existsSync, mkdirSync, mkdtempSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { vi, type MockInstance } from "vitest";
import type { NotifyEvent } from "@drec/core";
import {
  LocalTransport, Reconciler, SyncLedger,
  type PipelineCfg, type PipelineDeps, type Transport,
} from "@drec/orchestrator";
import { ResourcePool } from "../../../packages/orchestrator/src/workflow.js";
import { FakeBiliup, type RealBiliup } from "./fake-biliup.js";
import { fakeFfprobe, writeRecording, type RecordingSpec, type WrittenSession } from "./fake-recordings.js";

/** 取真实 biliup 包装(`vi.importActual`:即使该模块在本文件被 `vi.mock` 也拿得到真身)。 */
export async function loadRealBiliup(): Promise<RealBiliup & { countVideoParts: unknown }> {
  return await vi.importActual<RealBiliup & { countVideoParts: unknown }>("../../../packages/app/src/upload/biliup.js");
}

/** 清理全开:节点源、stage 成品、stage 里拉来的源段副本都清(验证「清理后无残留」要用这套口径)。 */
export const FULL_CLEANUP = { sourceAfterDone: true, stageAfterDone: true, stageSourceAfterMerge: true } as const;

export const ROOM = "e2e-room";
export const ANCHOR = "主播甲";

export interface ScenarioOpts {
  /** 覆盖 PipelineCfg 的一部分(steps/cleanup 做浅合并)。 */
  cfg?: Partial<Omit<PipelineCfg, "steps" | "cleanup">> & { steps?: PipelineCfg["steps"]; cleanup?: PipelineCfg["cleanup"] };
  /** 自定义 transport(节点侧场景要加 nodePipeline 等能力)。缺省 = 纯 LocalTransport。 */
  wrapTransport?: (base: LocalTransport, s: Scenario) => Transport;
  /** 崩溃恢复 sweep 的 stale 阈值(缺省沿用生产 600s)。「重启后续跑」场景传 0 = 视作重启已过去足够久。 */
  staleMs?: number;
  /** 收尾补跑节流(缺省沿用生产 15 分钟);补跑场景传 0 = 立即可补跑。 */
  cleanupBackfillThrottleMs?: number;
  /** 额外覆盖 PipelineDeps(如分段模式接缝)。 */
  deps?: Partial<PipelineDeps>;
}

export class Scenario {
  readonly root = mkdtempSync(join(tmpdir(), "drec-e2e-"));
  readonly recordingsDir = join(this.root, "recordings");
  readonly stageDir = join(this.root, "stage");
  readonly dbPath = join(this.root, "sync.db");
  readonly notifications: NotifyEvent[] = [];
  /** 被拦截的 console.warn / error 行,断言「无意外 [ledger] 拒绝」用。 */
  readonly warnings: string[] = [];
  readonly fake: FakeBiliup;
  ledger!: SyncLedger;
  reconciler!: Reconciler;
  transport!: Transport;
  sessions: WrittenSession[] = [];
  private spies: MockInstance[] = [];
  private cfg: PipelineCfg;

  private constructor(fake: FakeBiliup, private readonly opts: ScenarioOpts) {
    this.fake = fake;
    mkdirSync(this.recordingsDir, { recursive: true });
    mkdirSync(this.stageDir, { recursive: true });
    const base: PipelineCfg = {
      cleanMaxGapSec: 30,
      reconnectWindowMs: 0, // 假录像都在过去,不等重连窗
      stageDir: this.stageDir,
      cookies: join(this.root, "cookies.json"),
      uploadMode: "upload",
      uploadMeta: { tag: "直播,录像", tid: 21, desc: "e2e" },
      cleanup: { ...FULL_CLEANUP },
    };
    const o = opts.cfg ?? {};
    this.cfg = {
      ...base, ...o,
      steps: { ...base.steps, ...o.steps },
      cleanup: { ...base.cleanup, ...o.cleanup },
    };
  }

  static async create(opts: ScenarioOpts = {}): Promise<Scenario> {
    const real = await loadRealBiliup();
    const s = new Scenario(new FakeBiliup(real), opts);
    s.captureLogs();
    s.openFresh();
    return s;
  }

  /** 写一份假录像到本节点(可多次调用造多个房间/多天)。 */
  record(spec: Omit<RecordingSpec, "recordingsDir" | "anchor" | "roomSlug"> & Partial<Pick<RecordingSpec, "anchor" | "roomSlug">>): WrittenSession[] {
    const w = writeRecording({ anchor: ANCHOR, roomSlug: ROOM, ...spec, recordingsDir: this.recordingsDir });
    this.sessions.push(...w);
    return w;
  }

  private captureLogs(): void {
    const grab = (...a: unknown[]): void => { this.warnings.push(a.map(String).join(" ")); };
    this.spies.push(
      vi.spyOn(console, "warn").mockImplementation(grab),
      vi.spyOn(console, "error").mockImplementation(grab),
      vi.spyOn(console, "info").mockImplementation(() => {}),
    );
  }

  /** 释放:还原 console、关台账、删临时目录。 */
  dispose(): void {
    for (const s of this.spies) s.mockRestore();
    try { this.ledger.close(); } catch { /* 已关 */ }
    rmSync(this.root, { recursive: true, force: true });
  }

  /**
   * 「进程重启」:内存态(Reconciler/资源池/台账连接)全丢,磁盘 + 台账 db 保留。
   * 先等几毫秒:台账事件时间戳是「进程内单调递增」,可能比墙钟领先几 ms;真实重启隔着秒级,
   * 这里不等的话新实例的事件会排到旧实例之前,时间线断言会假失败。
   */
  async restart(): Promise<void> {
    await new Promise((r) => setTimeout(r, 25));
    this.openFresh();
  }

  private openFresh(): void {
    try { this.ledger?.close(); } catch { /* 首次无 */ }
    this.ledger = new SyncLedger(this.dbPath);
    const local = new LocalTransport({
      id: "local", recordingsDir: this.recordingsDir, taskRooms: {}, ffprobe: fakeFfprobe,
    });
    this.transport = this.opts.wrapTransport ? this.opts.wrapTransport(local, this) : local;
    const transports = new Map<string, Transport>([["local", this.transport]]);
    const pipelineDeps = this.buildDeps(transports);
    this.reconciler = new Reconciler({
      platform: "douyin",
      transports,
      ledger: this.ledger,
      pipelineDeps,
      settle: { maxWaitMs: 5_000, pollMs: 1 },
      sleep: async () => {},
      ...(this.opts.staleMs !== undefined ? { staleMs: this.opts.staleMs } : {}),
      ...(this.opts.cleanupBackfillThrottleMs !== undefined ? { cleanupBackfillThrottleMs: this.opts.cleanupBackfillThrottleMs } : {}),
      resolveCfg: () => this.cfg,
      notify: (e) => this.notifications.push(e),
    });
  }

  /** 对账一轮(= 收播后触发一次完整后处理)。 */
  async reconcile(): Promise<void> {
    await this.reconciler.reconcileAll();
  }

  private buildDeps(transports: Map<string, Transport>): PipelineDeps {
    const fake = this.fake;
    const sh = async (cmd: string): Promise<string> => this.fakeShell(cmd);
    const writeMp4 = (p: string, src?: string): void => {
      mkdirSync(join(p, ".."), { recursive: true });
      // 内容沿用源的 {durationSec} 元信息,便于分段模式 segmentDuration 读回。
      writeFileSync(p, src ? readFileSafe(src) : "x");
    };
    return {
      transports,
      ledger: this.ledger,
      pool: new ResourcePool({ minBurnFreeMemMB: 0, maxCpuParallel: 1, maxNetParallel: 1, uploadRateLimit: 0 }),
      sh,
      uploadPlain: (plain) => fake.uploadPlain(plain),
      // 与 cli.ts master 路径一致:countParts 由装配方注入(失败后查分P数做幂等判定)。
      appendGroup: (o) => fake.appendGroup({ ...o, countParts: () => fake.countVideoParts(o.bv) }),
      countParts: (bv) => fake.countVideoParts(bv),
      splitForUpload: async (mp4) => [mp4],
      remuxSegment: async (src, out) => writeMp4(out, src),
      segmentDuration: async (src) => {
        try { return (JSON.parse(readFileSafe(src)) as { durationSec: number }).durationSec; } catch { return 60; }
      },
      mergeSegments: async (inputs, out) => writeMp4(out, inputs[0]),
      burnSegment: async (o) => writeMp4(o.out, o.plain),
      notify: (e) => this.notifications.push(e),
      sleep: async () => {},
      cfg: this.cfg,
      ...this.opts.deps,
    };
  }

  /** merge / burn 子命令的替身:只写占位产物(足以让 workflow 的输入/输出安全阀通过)。 */
  private fakeShell(cmd: string): string {
    const dir = /--in\s+(\S+)/.exec(cmd)?.[1];
    if (/\bmerge\b/.test(cmd) && dir) {
      const stem = unquote(/--out-base\s+('[^']+'|\S+)/.exec(cmd)?.[1] ?? "out");
      writeFileSync(join(dir, `${stem}.mp4`), "MERGED");
      // 多会话 merge-sessions 自己产出合并 xml;单会话由 workflow 拷源 xml。
      if (/--merge-sessions/.test(cmd)) writeFileSync(join(dir, `${stem}.xml`), "<i></i>");
      return "";
    }
    if (/\bburn\b/.test(cmd)) {
      const video = /--video\s+(\S+)/.exec(cmd)?.[1] ?? "";
      const style = /--style\s+(\w+)/.exec(cmd)?.[1] ?? "danmu";
      writeFileSync(video.replace(/\.mp4$/i, `_${style}.mp4`), "BURNED");
      return "";
    }
    return "";
  }

  // ── 断言用视图 ──
  stageSubOf(streamKey: string): string {
    return join(this.stageDir, streamKey.replace(/[^A-Za-z0-9._-]/g, "_"));
  }
  /**
   * stage 里的**残留**(递归,相对路径)。job.log 与节点侧上传的结果凭据 `.drec-node-result.json`
   * 是有意保留的小文件(排障/幂等证据),不算残留;其余(视频、.work、别名目录、拉回的源)都算。
   */
  stageResidue(): string[] {
    const out: string[] = [];
    const walk = (d: string, rel: string): void => {
      for (const e of readdirSync(d, { withFileTypes: true })) {
        const r = rel ? `${rel}/${e.name}` : e.name;
        if (e.isDirectory()) walk(join(d, e.name), r);
        else if (e.name !== "job.log" && e.name !== ".drec-node-result.json") out.push(r);
      }
    };
    if (existsSync(this.stageDir)) walk(this.stageDir, "");
    return out.sort();
  }
  /** 节点录像目录里仍在的文件名(相对 anchor 目录)。 */
  recordingFiles(anchor = ANCHOR): string[] {
    const d = join(this.recordingsDir, anchor);
    return existsSync(d) ? readdirSync(d).sort() : [];
  }
  ledgerRejections(): string[] { return this.warnings.filter((w) => w.includes("[ledger] 拒绝")); }
  jobState(streamKey: string): string | undefined { return this.ledger.get(streamKey)?.state; }
  /** 全部台账 job 的 streamKey(场景通常只有一个)。 */
  keys(): string[] { return this.ledger.listKeys().map((k) => k.streamKey); }
  onlyKey(): string {
    const ks = this.keys();
    if (ks.length !== 1) throw new Error(`期望恰好 1 个 job,实际 ${ks.length}: ${ks.join(",")}`);
    return ks[0]!;
  }
  /** 该场状态流转序列(去重相邻),用于断言台账合法路径。 */
  stateTrail(streamKey: string): string[] {
    const trail: string[] = [];
    for (const e of this.ledger.getEvents(streamKey)) if (trail[trail.length - 1] !== e.state) trail.push(e.state);
    return trail;
  }
}

function unquote(s: string): string { return s.replace(/^'(.*)'$/, "$1"); }
function readFileSafe(p: string): string {
  try { return readFileSync(p, "utf-8"); } catch { return "x"; }
}
