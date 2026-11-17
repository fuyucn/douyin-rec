import type { Command } from "commander";
import { basename, join } from "node:path";
import { effectiveStageFormat, parseOutputFormat, stageExt, type Notifier } from "@drec/core";
import { groupSessionsInDir, mergeSession, mergeSessions } from "@drec/post-process";
import { commandWebhook, toggledNotifier } from "./cli-notifier.js";

interface MergeOptions {
  in: string; base?: string; keepTime?: boolean; mergeSessions?: boolean; outBase?: string; format?: string;
}
interface MergeContext {
  groups: ReturnType<typeof groupSessionsInDir>; ext: string; notifier: Notifier;
}

async function mergeAllSessions(o: MergeOptions, { groups, ext, notifier }: MergeContext) {
  const ordered = Object.keys(groups).sort();
  const inputs = ordered.map((b) => ({
    tsFiles: groups[b].ts.map((f) => join(o.in, f)),
    xmlPath: groups[b].xml ? join(o.in, groups[b].xml) : undefined,
  }));
  const outBase = (o.outBase ?? "").trim() || (ordered[0] ? dateNameOf(ordered[0]) : "");
  if (!outBase) { console.error("[merge] --merge-sessions 目录内无会话"); process.exitCode = 2; return; }
  const outMp4 = join(o.in, `${outBase}${ext}`);
  const outXml = join(o.in, `${outBase}.xml`);
  const segFiles = ordered.flatMap((b) => groups[b].ts.map((f) => join(o.in, f)));
  console.log(`[merge] ${ordered.join(" + ")} → ${basename(outMp4)}`);
  await scanSegmentsIntegrity(segFiles);
  await mergeSessions(inputs, outMp4, outXml);
  console.log(`[merge] 完成: ${outMp4}`);
  await scanOutputTailIntegrity(outMp4);
  await notifier.notify({ kind: "mergeDone", file: outMp4 });
}

async function mergeSeparateSessions(o: MergeOptions, { groups, ext, notifier }: MergeContext) {
  const bases = o.base ? [o.base] : Object.keys(groups);
  const dateName = dateNameOf;
  const clash: Record<string, number> = {};
  for (const b of bases) clash[dateName(b)] = (clash[dateName(b)] ?? 0) + 1;
  for (const b of bases) {
    const g = groups[b];
    if (!g || g.ts.length === 0) { console.error(`[merge] 跳过 ${b}：无分段`); continue; }
    const outBase = (o.outBase ?? "").trim() || (o.keepTime || clash[dateName(b)] > 1 ? b : dateName(b));
    const out = join(o.in, `${outBase}${ext}`);
    const segFiles = g.ts.map((f) => join(o.in, f));
    console.log(`[merge] ${b}: ${g.ts.length} 段 → ${basename(out)}`);
    await scanSegmentsIntegrity(segFiles);
    await mergeSession(segFiles, out);
    console.log(`[merge] 完成: ${out}`);
    await scanOutputTailIntegrity(out);
    await notifier.notify({ kind: "mergeDone", file: out });
  }
}

async function runMerge(program: Command, o: MergeOptions): Promise<void> {
  const notifier = toggledNotifier(commandWebhook(program));
  try {
    const ext = stageExt(effectiveStageFormat(parseOutputFormat(o.format), "stage"));
    const groups = groupSessionsInDir(o.in);
    const context = { groups, ext, notifier };
    if (o.mergeSessions) await mergeAllSessions(o, context);
    else await mergeSeparateSessions(o, context);
  } catch (e) {
    await toggledNotifier(commandWebhook(program)).notify({ kind: "error", stage: "merge", message: (e as Error).message });
    throw e;
  }
}

function dateNameOf(base: string): string {
  return base.replace(/_\d{2}-\d{2}-\d{2}$/, "");
}

async function scanSegmentsIntegrity(tsFiles: string[]): Promise<void> {
  // Decode only the final segment; seeking into unindexed TS can report false corruption.
  const { scanMediaErrors, formatScanLine } = await import("@drec/post-process");
  const last = tsFiles[tsFiles.length - 1];
  if (!last) return;
  const res = await scanMediaErrors(last);
  console.log(formatScanLine(`末段 ${basename(last)}`, res));
}

async function scanOutputTailIntegrity(outMp4: string): Promise<void> {
  // The hub consumes these verdict lines; copy-mode merging can retain a damaged tail.
  const { scanMediaErrors, formatScanLine, formatOutputVerdict } = await import("@drec/post-process");
  const res = await scanMediaErrors(outMp4, { lastSeconds: 60 });
  console.log(formatScanLine("成品尾部 60s", res));
  const verdict = formatOutputVerdict(res);
  if (verdict) console.log(verdict);
}

export function registerMergeCommand(program: Command): void {
  program
    .command("merge")
    .addHelpText("after", `\n例:\n  $ douyin-rec merge --in recordings\n  $ douyin-rec merge --in recordings --base 主播_2026-06-11_15-01-27`)
    .description("合并会话分段 {base}-PART*.ts → {主播}_{日期}.mp4（上传命名约定；同日多会话保留时间戳区分）")
    .requiredOption("--in <dir>", "录像目录（含 {base}-PART*.ts / {base}.xml）")
    .option("--base <base>", "只合并指定会话基名（默认目录内全部会话）")
    .option("--merge-sessions", "把目录内全部会话按时间序拼成一片(断流重连合并用)")
    .option("--keep-time", "输出保留会话时间戳 {base}.mp4（默认剥成 {主播}_{日期}.mp4）")
    .option("--out-base <name>", "输出 stem(覆盖默认剥日期 / --keep-time;hub 标题模板用)")
    .option("--format <fmt>", "输出容器 mp4|mkv(缺省 mp4;original 按 mp4)")
    .action((o: MergeOptions) => runMerge(program, o));
}
