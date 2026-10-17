/**
 * upload-prep: turn explicit recording segments into stage parts without touching recordings.
 * The helpers here are also used by the blocking node pipeline so the grouping rules stay single-source.
 */
import { existsSync, linkSync, mkdirSync, statSync } from "node:fs";
import { basename, dirname, extname, join } from "node:path";
import { ffprobeDuration, mergeSession, planSegmentGroups, remuxSegment } from "@drec/post-process";
import { linkOrCopy, sessionBaseOf, type ProcessContext, type ProcessJob, type ProcessResult, type Processor } from "@drec/core";

export interface PrepSpec {
  segments: string[];
  stageDir: string;
  stem: string;
  mergeSegments: boolean;
  segmentGroupSec: number;
  minSegmentSec: number;
  tsDirect: boolean;
}

export interface PrepPart { plain: string; sources: string[]; durSec: number }

/** Split groups at session boundaries: one part never spans two sessions. */
export function splitGroupsBySession(groups: number[][], xmlPathOf: (i: number) => string): number[][] {
  const out: number[][] = [];
  for (const g of groups) {
    let cur: number[] = [];
    let curXml = "";
    for (const k of g) {
      const xml = xmlPathOf(k) ?? "";
      if (cur.length > 0 && xml !== curXml) { out.push(cur); cur = []; }
      cur.push(k); curXml = xml;
    }
    if (cur.length > 0) out.push(cur);
  }
  return out;
}

const durationOf = (f: string): Promise<number> => ffprobeDuration(f).catch(() => 0);

function xmlOf(segments: string[], i: number): string {
  const f = segments[i];
  if (!f) return "";
  const base = sessionBaseOf(basename(f));
  if (!base) return "";
  const xml = join(dirname(f), `${base}.xml`);
  return existsSync(xml) ? xml : "";
}

export function tryDirectTsLink(src: string, dst: string): boolean {
  try {
    if (existsSync(dst)) return true;
    linkSync(src, dst);
    return true;
  } catch { return false; }
}

/**
 * Produce stage parts. Sources are only read; nothing under recordings is removed.
 * `ctx` is optional so the blocking path can call it without a proc-queue context.
 */
export async function produceStageParts(spec: PrepSpec, log: (m: string) => void, ctx?: ProcessContext): Promise<PrepPart[]> {
  mkdirSync(spec.stageDir, { recursive: true });
  const durations: number[] = [];
  for (const f of spec.segments) durations.push(await durationOf(f));
  const groupSec = spec.mergeSegments ? spec.segmentGroupSec : 0;
  const groups = splitGroupsBySession(planSegmentGroups(durations, groupSec), (i) => xmlOf(spec.segments, i));
  const workDir = join(spec.stageDir, ".work");
  mkdirSync(workDir, { recursive: true });
  const parts: PrepPart[] = [];
  for (const group of groups) {
    const groupDur = group.reduce((n, idx) => n + (durations[idx] ?? 0), 0);
    if (spec.minSegmentSec > 0 && groupDur > 0 && groupDur < spec.minSegmentSec) continue;
    const out = join(spec.stageDir, `${spec.stem}_${String(parts.length).padStart(3, "0")}.mp4`);
    const work = join(workDir, `${String(parts.length).padStart(3, "0")}.mp4`);
    const files = group.map((idx) => spec.segments[idx]!);
    if (spec.tsDirect && group.length === 1 && /\.ts$/i.test(files[0]!) && (durations[group[0]!] ?? 0) > 0) {
      const outTs = out.replace(/\.mp4$/i, ".ts");
      if (tryDirectTsLink(files[0]!, outTs)) {
        parts.push({ plain: outTs, sources: files, durSec: groupDur });
        continue;
      }
    }
    const reusable = existsSync(work) && (await durationOf(work)) > 0;
    if (!reusable) {
      if (group.length === 1) await remuxSegment(files[0]!, work);
      else await mergeSession(files, work);
    }
    ctx?.assertLease();
    linkOrCopy(work, out);
    parts.push({ plain: out, sources: files, durSec: groupDur });
  }
  log(`prep 产出 ${parts.length} 个分 P → ${spec.stageDir}`);
  return parts;
}

/** Processor: writes stage outputs and never deletes inputs. */
export const uploadPrepProcessor: Processor = {
  kind: "upload-prep",
  resource: "cpu",
  lane: "copy",
  retryable: true,
  interruptible: true,
  validate(job: ProcessJob): string | null {
    if (job.inputs.length === 0) return "inputs 不能为空";
    if (job.replaceInputs) return "upload-prep 不得替换/删除源文件";
    return null;
  },
  estimateDiskBytes(job: ProcessJob): number {
    try {
      let total = 0;
      for (const f of job.inputs) total += statSync(f).size;
      return total;
    } catch { return 0; }
  },
  async run(job: ProcessJob, ctx: ProcessContext): Promise<ProcessResult> {
    const specs = job.params as Partial<PrepSpec>;
    const spec: PrepSpec = {
      segments: job.inputs,
      stageDir: String(specs.stageDir ?? ""),
      stem: String(specs.stem ?? "part"),
      mergeSegments: specs.mergeSegments !== false,
      segmentGroupSec: Number(specs.segmentGroupSec ?? 0),
      minSegmentSec: Number(specs.minSegmentSec ?? 2),
      tsDirect: specs.tsDirect === true,
    };
    if (!spec.stageDir) throw new Error("upload-prep 缺少 stageDir");
    ctx.setState?.({ step: "remux" });
    const parts = await produceStageParts(spec, (m) => ctx.log(m), ctx);
    if (parts.length === 0) throw new Error("upload-prep 没有产出任何分 P");
    return { outputs: parts.map((p) => p.plain), note: `${parts.length} parts` };
  },
  async recover(): Promise<"rerun"> { return "rerun"; },
};
