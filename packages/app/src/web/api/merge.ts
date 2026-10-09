/**
 * web/api/merge.ts — 会话合成(后台 job)+ 站内事件流
 *
 * 从 web/api.ts 拆出(T-22 第 1 步):原文件 1321 行、makeApi 单函数 909 行、53 个方法。
 * 现按域拆开;`makeApi`(web/api.ts)只做组装。各域导出 `buildMerge(ctx)` 返回方法对象。
 */
import type { ApiCtx } from "./context.js";
import type { ApiResult } from "./types.js";
import { readdirSync, existsSync } from "node:fs";
import { join } from "node:path";
import { groupSessions, mergeSessions } from "@drec/post-process";
import type { RecordingSessionDTO } from "@drec/core";

export function buildMerge(ctx: ApiCtx) {
  const { deps, store, manager, hubDir, hubConfigPath,
    err, view, recordingsDir } = ctx;
  return {
    listRecordings(id: number): ApiResult {
      const t = store.getTask(id);
      if (!t) return err(404, `未找到任务 id=${id}`);
      const dir = recordingsDir(t);
      if (!dir || !existsSync(dir)) return { status: 200, body: { dir, sessions: [] } };
      const files = readdirSync(dir).map((f) => join(dir, f));
      const groups = groupSessions(files);
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
      const dir = recordingsDir(t);
      if (!dir || !existsSync(dir)) return err(404, "该任务暂无录制目录");
      const bases = input.sessions ?? [];
      if (bases.length === 0) return err(400, "请至少选择一个会话");

      const files = readdirSync(dir).map((f) => join(dir, f));
      const groups = groupSessions(files);
      for (const b of bases) if (!groups[b]) return err(400, `未知会话: ${b}`);
      // 入参顺序 = 时间序;每会话取分段 ts + 会话级 xml(无则不合并弹幕)。
      const inputs = bases.map((b) => ({
        tsFiles: groups[b].ts,
        xmlPath: groups[b].xml ?? undefined,
      }));
      const outBase = `${bases[0]}_merged`;
      const outMp4 = join(dir, `${outBase}.mp4`);
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
