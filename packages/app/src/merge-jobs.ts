/**
 * merge-jobs.ts — 会话合成后台任务,**持久化到 SQLite**(merge_jobs 表)。
 *
 * 合成(多会话 → 一片无损视频 + 偏移合并 xml)跑数十秒~数分钟,不能阻塞 HTTP:POST /merge 立即建
 * job 返回 jobId,后台异步跑,UI 轮询 GET /merges/:jobId。
 *
 * 持久化目的:serve 重启时**不丢正在跑的 job**——重启会杀掉合成 ffmpeg 子过程、留下半截损坏 mp4,
 * 之前内存版会让 UI 永远 404。现在启动时 recoverOrphans() 把 running 标记 error + 删半截 mp4
 * (保留 .xml,硬性约束:永不删 xml/ass)。
 */
import type { DatabaseSync } from "node:sqlite";
import { unlinkSync, existsSync } from "node:fs";

/** 对外暴露的 job 视图(REST body)。 */
export interface MergeJobView {
  id: string;
  taskId: number;
  state: "running" | "done" | "error";
  /** 选中的会话 base(时间序)。 */
  sessions: string[];
  /** 产物路径(create 时即记入意向路径;done 时确认)。 */
  mp4?: string;
  xml?: string;
  /** 失败时:错误信息。 */
  error?: string;
}

interface Row {
  id: string;
  taskId: number;
  state: string;
  sessions: string;
  mp4: string | null;
  xml: string | null;
  error: string | null;
}

export class MergeJobStore {
  constructor(private readonly db: DatabaseSync) {}

  /** 建 job(running)。outMp4/outXml = 合成产物的意向路径,先记下以便重启时清理半截。 */
  create(taskId: number, sessions: string[], outMp4: string, outXml?: string): MergeJobView {
    const id = `m${Date.now().toString(36)}-t${taskId}`;
    this.db
      .prepare(
        `INSERT INTO merge_jobs (id, taskId, state, sessions, mp4, xml, createdAt)
         VALUES (?, ?, 'running', ?, ?, ?, ?)`,
      )
      .run(id, taskId, JSON.stringify(sessions), outMp4, outXml ?? null, new Date().toISOString());
    return { id, taskId, state: "running", sessions, mp4: outMp4, xml: outXml };
  }

  finish(id: string, out: { mp4: string; xml?: string }): void {
    this.db.prepare(`UPDATE merge_jobs SET state='done', mp4=?, xml=? WHERE id=?`).run(out.mp4, out.xml ?? null, id);
  }

  fail(id: string, error: string): void {
    this.db.prepare(`UPDATE merge_jobs SET state='error', error=? WHERE id=?`).run(error, id);
  }

  view(id: string): MergeJobView | null {
    const r = this.db.prepare(`SELECT * FROM merge_jobs WHERE id=?`).get(id) as unknown as Row | undefined;
    return r ? rowToView(r) : null;
  }

  /**
   * serve 启动调用一次:上次 running 的 job 必是被重启腰斩(合成 ffmpeg 已死)→ 标 error,
   * 删半截 mp4(保留 .xml)。返回清理条数。
   */
  recoverOrphans(): number {
    const rows = this.db.prepare(`SELECT * FROM merge_jobs WHERE state='running'`).all() as unknown as Row[];
    for (const r of rows) {
      if (r.mp4 && existsSync(r.mp4)) {
        try { unlinkSync(r.mp4); } catch { /* 删不掉就算了 */ }
      }
      this.db.prepare(`UPDATE merge_jobs SET state='error', error=? WHERE id=?`).run("serve 重启中断,已清理半截产物", r.id);
    }
    return rows.length;
  }
}

function rowToView(r: Row): MergeJobView {
  return {
    id: r.id,
    taskId: Number(r.taskId),
    state: (r.state as MergeJobView["state"]) ?? "error",
    sessions: ((): string[] => { try { return JSON.parse(r.sessions) as string[]; } catch { return []; } })(),
    mp4: r.mp4 ?? undefined,
    xml: r.xml ?? undefined,
    error: r.error ?? undefined,
  };
}
