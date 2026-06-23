/**
 * api.ts — TUI 的瘦 REST 客户端，连 `task serve` 的 HTTP API（默认 localhost:7860）。
 * 用 Node 全局 fetch（node 18+）。TUI 不直连 DB/不自带 manager → 与 serve 共享同一后端、无冲突。
 */

/** serve /api/tasks 返回的任务形状（取 TUI 需要的字段）。 */
export interface TuiTask {
  id: number;
  room: string;
  name: string | null;
  anchorName: string | null;
  quality: string;
  /** 1=抓弹幕 0=关(来源由命中平台的 connectDanmu 提供,无 provider 字段)。 */
  danmu: number;
  status: string;
  enabled: boolean;
  running: boolean;
  recording: boolean;
}

/** 站内事件(GET /api/events 单项);event.kind + 字段供渲染文案。 */
export interface TuiEvent {
  id: number;
  at: number;
  taskId: number | null;
  event: { kind: string; [k: string]: unknown };
}

export class TuiApi {
  constructor(private readonly base: string) {
    this.base = base.replace(/\/$/, "");
  }

  async listTasks(): Promise<TuiTask[]> {
    const r = await fetch(`${this.base}/api/tasks`);
    if (!r.ok) throw new Error(`HTTP ${r.status}`);
    return (await r.json()) as TuiTask[];
  }

  async startTask(id: number): Promise<void> {
    await fetch(`${this.base}/api/tasks/${id}/start`, { method: "POST" });
  }

  async stopTask(id: number): Promise<void> {
    await fetch(`${this.base}/api/tasks/${id}/stop`, { method: "POST" });
  }

  async getLogs(id: number): Promise<string[]> {
    const r = await fetch(`${this.base}/api/tasks/${id}/logs`);
    if (!r.ok) return [];
    const j = (await r.json()) as { lines?: string[] };
    return j.lines ?? [];
  }

  /** 站内事件增量拉取(自 since 游标)。失败返回原游标 + 空。 */
  async getEvents(since: number): Promise<{ events: TuiEvent[]; cursor: number }> {
    try {
      const r = await fetch(`${this.base}/api/events?since=${since}`, { signal: AbortSignal.timeout(3000) });
      if (!r.ok) return { events: [], cursor: since };
      return (await r.json()) as { events: TuiEvent[]; cursor: number };
    } catch {
      return { events: [], cursor: since };
    }
  }

  /** 探活：serve 是否在跑。 */
  async ping(): Promise<boolean> {
    try {
      const r = await fetch(`${this.base}/api/tasks`, { signal: AbortSignal.timeout(3000) });
      return r.ok;
    } catch {
      return false;
    }
  }
}
