/**
 * rolling-takeover.ts — 边录边传「遗留会话接管」(#57 R2 / #46)。
 *
 * 触发点:① 新会话加入第一段时扫描同目录同房间的兄弟清单;② `task serve` 启动扫描一次,并低频复扫
 * (覆盖「启动时租约尚未过期」与老清单静置期)。接管规则(判定在 core/rolling-manifest):
 *   - 仅当租约已过期 / 持有 pid 已不存在才接管,租约有效 = 有人在写,跳过;
 *   - 清单损坏 → 日志 + 通知转人工,**不动原文件**,绝不当新会话;
 *   - 全程不建稿,续传只追加到已有稿件号;无稿件号且确定未提交 → 交主控常规管线。
 */
import { existsSync, readdirSync } from "node:fs";
import path from "node:path";
import { leaseTakeable, needsTakeover } from "@drec/core";
import {
  isRollingSessionLive,
  listManifestBases,
  readSessionRoom,
  resolveRollingUploadMeta,
  RollingUploader,
  type RollingUploaderOpts,
} from "./rolling-upload.js";
import { pidAlive as realPidAlive, readManifestFile } from "./rolling-manifest-io.js";

type Room = { platform: string; roomSlug: string };

export interface TakeoverScanOpts {
  /** 本会话自己的 base(跳过)。 */
  selfBase?: string;
  /** 只接管该房间的兄弟清单;缺省 = 目录内全部(服务启动扫描)。 */
  room?: Room;
  /** 由房间身份造上传器配置(含 takeover:true)。 */
  makeOpts: (room: Room) => RollingUploaderOpts;
  now?: () => number;
  pidAlive?: (pid: number) => boolean;
  legacyIdleMs?: number;
  log: (m: string) => void;
  notify?: (stage: string, message: string) => void;
}

export interface TakeoverReport {
  base: string;
  outcome: "skipped-self" | "skipped-live" | "skipped-lease" | "skipped-room" | "skipped-done" | "corrupt" | "blocked" | "handoff" | "resumed" | "manual" | "nothing";
}

/** 损坏清单只通知一次(进程内),避免周期复扫刷屏;文件被修好/删除后自然不再命中。 */
const corruptNotified = new Set<string>();

function roomOf(dir: string, base: string, m: { room?: Room; streamKey: string }): Room | undefined {
  if (m.room) return m.room;
  const sess = readSessionRoom(dir, base);
  if (sess) return sess;
  const parts = m.streamKey.split(":");
  if (parts.length >= 3 && parts[0] && parts[1]) return { platform: parts[0], roomSlug: parts[1] };
  return undefined;
}

export async function takeoverSessionsInDir(dir: string, o: TakeoverScanOpts): Promise<TakeoverReport[]> {
  const out: TakeoverReport[] = [];
  const nowFn = o.now ?? Date.now;
  const alive = o.pidAlive ?? realPidAlive;
  for (const base of listManifestBases(dir)) {
    if (base === o.selfBase) { out.push({ base, outcome: "skipped-self" }); continue; }
    // 同进程仍在上传的会话(如断流重连后旧会话的后台上传)租约必然有效,直接跳过。
    if (isRollingSessionLive(dir, base)) { out.push({ base, outcome: "skipped-live" }); continue; }
    const r = readManifestFile(dir, base);
    if (r.status === "missing") continue; // 扫描与读取之间被删
    if (r.status === "corrupt") {
      const key = path.join(dir, base);
      o.log(`[rolling] ⚠️ 接管扫描:进度清单损坏(${r.reason}),按不可信转人工,不动原文件、不当新会话(${base})`);
      if (!corruptNotified.has(key)) {
        corruptNotified.add(key);
        try { o.notify?.("边录边传", `进度清单损坏(${base}),已转人工核对:该会话不会被自动接管/续传,也不会重复建稿`); } catch { /* 通知失败不反噬 */ }
      }
      out.push({ base, outcome: "corrupt" });
      continue;
    }
    const m = r.manifest;
    if (!needsTakeover(m, (p) => existsSync(p))) { out.push({ base, outcome: "skipped-done" }); continue; }
    const room = roomOf(dir, base, m);
    if (o.room && (!room || room.platform !== o.room.platform || room.roomSlug !== o.room.roomSlug)) {
      out.push({ base, outcome: "skipped-room" });
      continue;
    }
    // 租约:同进程但不在 LIVE 表 = 写者实例已死(已在上面排除存活者),视为 pid 不存在。
    const aliveFn = (pid: number): boolean => (pid === process.pid ? false : alive(pid));
    if (!leaseTakeable(m, nowFn(), aliveFn, { fileMtimeMs: r.mtimeMs, legacyIdleMs: o.legacyIdleMs })) {
      o.log(`[rolling] 接管扫描:${base} 租约有效(pid=${m.lease?.pid}),跳过`);
      out.push({ base, outcome: "skipped-lease" });
      continue;
    }
    const u = new RollingUploader({ ...o.makeOpts(room ?? { platform: "unknown", roomSlug: "unknown" }), takeover: true });
    try {
      const res = await u.runTakeover(dir, base);
      o.log(`[rolling] 接管 ${base} → ${res.outcome}${res.uploaded.length ? `(续传段 ${res.uploaded.join(",")})` : ""}`);
      out.push({ base, outcome: res.outcome });
    } catch (e) {
      u.abandon();
      o.log(`[rolling] ⚠️ 接管 ${base} 抛错(保留源与清单,下轮重试/人工): ${String((e as Error)?.message ?? e).slice(0, 200)}`);
      try { o.notify?.("边录边传", `接管遗留会话异常(${base}),源与清单已保留,请人工核对`); } catch { /* ignore */ }
      out.push({ base, outcome: "blocked" });
    }
  }
  return out;
}

export interface TakeoverWatcherOpts {
  /** 录像根目录列表(默认输出目录 + 各任务 outDir);每个根下一层子目录 = 主播目录。 */
  roots: () => string[];
  log: (m: string) => void;
  notify?: (stage: string, message: string) => void;
  /** 复扫间隔(缺省 5 分钟)。 */
  intervalMs?: number;
  /** 测试接缝 → 透传给上传器 / 扫描。 */
  baseOpts?: Partial<RollingUploaderOpts>;
  now?: () => number;
  pidAlive?: (pid: number) => boolean;
  legacyIdleMs?: number;
}

/** 一次全量扫描:枚举各根下主播目录并逐目录接管。串行,单目录异常不影响其它目录。 */
export async function takeoverScanRoots(o: TakeoverWatcherOpts): Promise<TakeoverReport[]> {
  const reports: TakeoverReport[] = [];
  const dirs = new Set<string>();
  for (const root of o.roots()) {
    dirs.add(root);
    try {
      for (const e of readdirSync(root, { withFileTypes: true })) if (e.isDirectory()) dirs.add(path.join(root, e.name));
    } catch { /* 根目录不存在 = 没录过,跳过 */ }
  }
  for (const dir of dirs) {
    try {
      reports.push(...await takeoverSessionsInDir(dir, {
        makeOpts: (room) => {
          const { meta, private: isPrivate } = resolveRollingUploadMeta(room.platform, room.roomSlug);
          return { room, uploadMeta: meta, uploadPrivate: isPrivate, log: o.log, notify: o.notify, takeoverSiblings: false, ...o.baseOpts };
        },
        now: o.now,
        pidAlive: o.pidAlive,
        legacyIdleMs: o.legacyIdleMs,
        log: o.log,
        notify: o.notify,
      }));
    } catch (e) {
      o.log(`[rolling] 接管扫描目录失败(忽略): ${dir}: ${String((e as Error)?.message ?? e).slice(0, 200)}`);
    }
  }
  return reports;
}

/** serve 启动:立即扫一次,之后低频复扫。返回 stop。 */
export function startRollingTakeoverWatcher(o: TakeoverWatcherOpts): { stop: () => void; scanNow: () => Promise<TakeoverReport[]> } {
  let running = false;
  const scanNow = async (): Promise<TakeoverReport[]> => {
    if (running) return [];
    running = true;
    try { return await takeoverScanRoots(o); }
    catch (e) { o.log(`[rolling] 接管扫描失败(忽略): ${String((e as Error)?.message ?? e).slice(0, 200)}`); return []; }
    finally { running = false; }
  };
  void scanNow();
  const timer = setInterval(() => { void scanNow(); }, o.intervalMs ?? 5 * 60_000);
  timer.unref?.();
  return { stop: () => clearInterval(timer), scanNow };
}
