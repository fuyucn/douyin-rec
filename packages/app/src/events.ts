/**
 * events.ts — EventCenter:站内事件流的唯一中枢。
 *
 * 模型(用户确认):每个事件 →
 *   1) 进内存环形缓冲(**本地通知,永远**)→ web/tui 轮询 GET /api/events?since=N → 弹 toast;
 *   2) 若解析到 webhook(任务自带 ?? 全局)→ 再触发 Discord webhook。
 *
 * 录制开播/收播由父进程(serve 的状态观察器)emit 到本地流;其 Discord 已由录制子进程自己发
 * (--discord-webhook 用每任务 webhook),故这些 emit 走 { webhook: false } 避免重复推送。
 * 合成完成/失败由 api emit,webhook 由本中枢发(子进程不参与)。
 */
import type { NotifyEvent, Notifier } from "@drec/core";

/** 站内事件:NotifyEvent + 序号/时间/归属任务,供前端按 id 游标增量拉取。 */
export interface AppEvent {
  /** 单调递增序号(轮询游标)。 */
  id: number;
  /** 产生时间(epoch ms)。 */
  at: number;
  /** 归属任务;无(全局)为 null。 */
  taskId: number | null;
  /** 原始通知事件(kind + 字段),前端据 kind 渲染文案。 */
  event: NotifyEvent;
}

export interface EventCenterOpts {
  /** 按 webhook 构造通知器(app/notify makeNotifier);省略=不发 webhook。 */
  makeNotifier?: (webhook: string | undefined) => Notifier;
  /** 解析某任务生效的 webhook(任务自带 ?? 全局);省略=无 webhook。 */
  resolveWebhook?: (taskId: number | null) => string | undefined;
  /** 环形缓冲容量(默认 200)。 */
  max?: number;
  /**
   * 游标起始值(默认 0)。生产用 `Date.now()` 单调播种:进程重启后内存 seq 归零,而前端
   * 仍持有上一轮的高游标(如 150)→ 重启窗口内 emit 的事件 id(1,2…)会被 since(150) 过滤
   * 掉而静默丢失。用墙钟播种保证「新一轮的 id 永远高于任何上一轮发给前端的游标」,无需持久化。
   */
  initialSeq?: number;
}

export class EventCenter {
  private buf: AppEvent[] = [];
  private seq: number;
  private readonly max: number;
  private readonly makeNotifier?: (webhook: string | undefined) => Notifier;
  private readonly resolveWebhook?: (taskId: number | null) => string | undefined;

  constructor(opts: EventCenterOpts = {}) {
    this.makeNotifier = opts.makeNotifier;
    this.resolveWebhook = opts.resolveWebhook;
    this.max = opts.max ?? 200;
    this.seq = opts.initialSeq ?? 0;
  }

  /**
   * 记录一个事件:压入本地流(永远),并(默认)按任务解析 webhook 触发 Discord。
   * @param opts.webhook false = 只进本地流不发 webhook(子进程已发的事件)。
   */
  emit(taskId: number | null, event: NotifyEvent, opts?: { webhook?: boolean }): AppEvent {
    const e: AppEvent = { id: ++this.seq, at: Date.now(), taskId, event };
    this.buf.push(e);
    if (this.buf.length > this.max) this.buf.shift();
    if (opts?.webhook !== false && this.makeNotifier) {
      const hook = this.resolveWebhook?.(taskId);
      void this.makeNotifier(hook).notify(event).catch(() => {});
    }
    return e;
  }

  /** 增量拉取:返回 id > cursor 的事件 + 新游标(=最大 id)。cursor=0 取全部缓冲。 */
  since(cursor: number): { events: AppEvent[]; cursor: number } {
    const events = this.buf.filter((e) => e.id > cursor);
    return { events, cursor: this.seq };
  }
}
