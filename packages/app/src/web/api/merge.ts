/**
 * web/api/merge.ts — 会话合成(后台 job)+ 站内事件流
 *
 * 从 web/api.ts 拆出(T-22 第 1 步):原文件 1321 行、makeApi 单函数 909 行、53 个方法。
 * 现按域拆开;`makeApi`(web/api.ts)只做组装。各域导出 `buildMerge(ctx)` 返回方法对象。
 */
import type { ApiCtx } from "./context.js";
import type { ApiResult } from "./types.js";
import { readdirSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { groupSessionsInDir, mergeSessions } from "@drec/post-process";
import { effectiveStageFormat, stageExt } from "@drec/core";
import type { RecordingSessionDTO } from "@drec/core";

export function buildMerge(ctx: ApiCtx) {
  const { deps, store, manager, hubDir, hubConfigPath,
    err, view, recordingsDir, recordingsDirs } = ctx;

  /**
   * Sessions of every existing recording directory of a task (old and new layout), keyed by base name.
   * Bases carry a timestamp, so they do not collide across directories; the first directory wins on a tie.
   * The merged output goes to the primary directory (where new sessions are written).
   */
  const collectGroups = (t: Parameters<typeof recordingsDirs>[0]): { primary: string | null; groups: ReturnType<typeof groupSessionsInDir> } => {
    const primary = recordingsDir(t);
    const groups: ReturnType<typeof groupSessionsInDir> = {};
    for (const dir of recordingsDirs(t)) {
      if (!existsSync(dir)) continue;
      const files = readdirSync(dir).map((f) => join(dir, f));
      // 任务录制目录:认节点侧原地替换后的 mp4/mkv(issue #137)
      for (const [base, g] of Object.entries(groupSessionsInDir(dir, files))) if (!groups[base]) groups[base] = g;
    }
    return { primary, groups };
  };
  return {
    listRecordings(id: number): ApiResult {
      const t = store.getTask(id);
      if (!t) return err(404, `未找到任务 id=${id}`);
      const { primary: dir, groups } = collectGroups(t);
      const sessions: RecordingSessionDTO[] = Object.entries(groups)
        .filter(([, g]) => g.ts.length > 0) // 只列有视频的会话
        .map(([base, g]) => ({
          base,
          segments: g.ts.length,
          hasXml: g.xml !== null || g.segmentXmls.length > 0,
        }))
        .sort((a, b) => a.base.localeCompare(b.base)); // base 内嵌时间戳 → 字典序=时间序
      return { status: 200, body: { dir, sessions } };
    },

    startMerge(id: number, input: { sessions?: string[] }): ApiResult {
      if (!deps.mergeJobs) return err(501, "合成功能未启用");
      const t = store.getTask(id);
      if (!t) return err(404, `未找到任务 id=${id}`);
      const { primary, groups } = collectGroups(t);
      if (!recordingsDirs(t).some((d) => existsSync(d))) return err(404, "该任务暂无录制目录");
      const bases = input.sessions ?? [];
      if (bases.length === 0) return err(400, "请至少选择一个会话");
      for (const b of bases) if (!groups[b]) return err(400, `未知会话: ${b}`);
      // 入参顺序 = 时间序;每会话取分段 ts + 会话级 xml(无则不合并弹幕)。
      const inputs = bases.map((b) => ({
        tsFiles: groups[b].ts,
        xmlPath: groups[b].xml ?? undefined,
      }));
      // Output next to the new-layout recordings when that directory exists, else beside the first selected session.
      const firstTs = groups[bases[0]].ts[0];
      if (!(primary && existsSync(primary)) && !firstTs) return err(400, `会话无视频: ${bases[0]}`);
      const dir = primary && existsSync(primary) ? primary : dirname(firstTs);
      const outBase = `${bases[0]}_merged`;
      // 产物容器跟随任务 outputFormat(original → mp4;唯一判定 core effectiveStageFormat,issue #165)。
      // 手动合成不是投稿,故不传 uploadMode。job 字段名仍叫 mp4(API/前端不变),内容是实际产物路径。
      const outMp4 = join(dir, `${outBase}${stageExt(effectiveStageFormat(t.outputFormat, undefined))}`);
      const outXml = join(dir, `${outBase}.xml`);
      const allXml = bases.every((b) => groups[b].xml);

      const job = deps.mergeJobs.create(id, bases, outMp4, allXml ? outXml : undefined);
      void (async (): Promise<void> => {
        try {
          const r = await mergeSessions(inputs, outMp4, allXml ? outXml : undefined);
          deps.mergeJobs!.finish(job.id, { mp4: r.mp4, xml: r.xml });
          // 站内事件 + webhook(EventCenter 按任务解析 webhook)。
          deps.events?.emit(id, { kind: "mergeDone", file: r.mp4 });
        } catch (e) {
          const msg = e instanceof Error ? e.message : String(e);
          deps.mergeJobs!.fail(job.id, msg);
          deps.events?.emit(id, { kind: "error", stage: "merge", message: msg });
        }
      })();
      return { status: 202, body: job };
    },

    getMerge(jobId: string): ApiResult {
      if (!deps.mergeJobs) return err(501, "合成功能未启用");
      const v = deps.mergeJobs.view(jobId);
      if (!v) return err(404, `未找到合成任务: ${jobId}`);
      return { status: 200, body: v };
    },

    getEvents(since: number): ApiResult {
      const cursor = Number.isFinite(since) && since >= 0 ? Math.floor(since) : 0;
      return { status: 200, body: deps.events ? deps.events.since(cursor) : { events: [], cursor: 0 } };
    },
  };
}
