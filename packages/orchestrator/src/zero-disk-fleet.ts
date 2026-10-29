/**
 * zero-disk-fleet.ts — master-side management of zero-disk uploads that run on side nodes (issue #331).
 *
 * The master is the control plane. It (1) gates: never pushes an enabled zero-disk task to a node that
 * does not advertise support, (2) polls each node's read-only report and applies receipts to the
 * master ledger exactly once (idempotent, survives the master being offline), and (3) keeps a per-room
 * view of every targeted node (status, parts, refusal reason, offline / old version) for the console.
 *
 * Pure orchestration over the Transport seam; no ssh / sqlite here (the receipt writer is injected).
 */
import { liveUploadSummary, type NodeCapabilities, type ZeroDiskNodeStatus, type ZeroDiskNodeStatusDTO, type ZeroDiskReceipt, type ZeroDiskReport } from "@drec/core";
import type { Transport } from "./transport.js";

export interface ZeroDiskWorker {
  id: string;
  name: string;
  /** `local` is never managed here: the master's own zero-disk writes its own ledger directly. */
  kind: string;
  transport?: Transport;
}

/** One (room, node) pair the master expects to run a zero-disk upload. */
export interface ZeroDiskTarget {
  workerId: string;
  platform: string;
  roomSlug: string;
}

export type ZeroDiskSupport =
  | { kind: "supported"; at: number }
  | { kind: "unsupported"; at: number; reason: string }
  | { kind: "unknown"; at: number; reason: string };

type PollResult =
  | { kind: "ok"; at: number; report: ZeroDiskReport }
  | { kind: "unsupported"; at: number; reason: string }
  | { kind: "offline"; at: number; reason: string };

export interface ZeroDiskFleetOpts {
  /** Apply one receipt to the master ledger. Must be idempotent; `ok:false` is retried next poll. */
  applyReceipt: (r: ZeroDiskReceipt) => { ok: boolean; error?: string };
  now?: () => number;
  log?: (m: string) => void;
  /** Error-level alert (a receipt that could not be applied, so a real archive is missing from the ledger). */
  alert?: (message: string) => void;
  /** Re-probe interval for a node known to support zero-disk (ms). */
  supportedTtlMs?: number;
  /** Re-probe interval while a node is unsupported / unknown, so an upgrade is noticed quickly (ms). */
  retryTtlMs?: number;
  /** Poll cadence for nodes that currently have no zero-disk room, only to collect late receipts (ms). */
  idlePollMs?: number;
}

export const UNSUPPORTED_REASON = "节点版本过旧,不支持由 master 管理的 0 落盘(升级节点后自动恢复)";

export class ZeroDiskFleet {
  private readonly support_ = new Map<string, ZeroDiskSupport>();
  private readonly polls = new Map<string, PollResult>();
  private readonly lastPolledAt = new Map<string, number>();
  /** Receipt ids already applied by this process (the ledger's terminal guard covers a restart). */
  private readonly applied = new Set<string>();
  private readonly alerted = new Set<string>();
  private readonly now: () => number;
  private readonly log: (m: string) => void;
  private readonly supportedTtlMs: number;
  private readonly retryTtlMs: number;
  private readonly idlePollMs: number;

  constructor(private readonly o: ZeroDiskFleetOpts) {
    this.now = o.now ?? Date.now;
    this.log = o.log ?? ((): void => {});
    this.supportedTtlMs = o.supportedTtlMs ?? 5 * 60_000;
    this.retryTtlMs = o.retryTtlMs ?? 60_000;
    this.idlePollMs = o.idlePollMs ?? 10 * 60_000;
  }

  /** Synchronous read for the spec builder. Undefined = never probed (treated as not supported). */
  support(workerId: string): ZeroDiskSupport | undefined {
    return this.support_.get(workerId);
  }

  /** May an enabled zero-disk task be pushed to this node? Fails closed on anything unconfirmed. */
  allowsPush(workerId: string): boolean {
    return this.support_.get(workerId)?.kind === "supported";
  }

  /** Probe `_node-capabilities` for nodes whose answer is missing or stale. */
  async refreshSupport(workers: readonly ZeroDiskWorker[]): Promise<void> {
    for (const w of workers) {
      if (w.kind === "local" || !w.transport) continue;
      const cur = this.support_.get(w.id);
      const ttl = cur?.kind === "supported" ? this.supportedTtlMs : this.retryTtlMs;
      if (cur && this.now() - cur.at < ttl) continue;
      const at = this.now();
      if (!w.transport.nodeCapabilities) {
        this.support_.set(w.id, { kind: "unsupported", at, reason: UNSUPPORTED_REASON });
        continue;
      }
      try {
        // A node never probed before gets one immediate retry: a single transient ssh failure must not
        // look like "unsupported" and disable a task that is already uploading after a master restart.
        let caps: NodeCapabilities;
        try {
          caps = await w.transport.nodeCapabilities();
        } catch (first) {
          if (cur) throw first;
          caps = await w.transport.nodeCapabilities();
        }
        this.support_.set(w.id, caps.zeroDisk === true
          ? { kind: "supported", at }
          : { kind: "unsupported", at, reason: UNSUPPORTED_REASON });
      } catch (e) {
        if (cur?.kind === "supported") {
          // A failed RE-probe must not revoke a known-good node: disabling the task would stop a live
          // upload. Keep the old answer (its timestamp stays old, so the next tick probes again). An
          // explicit "not supported" answer, or an unknown-command report, still revokes.
          this.log(`[zero-disk] 能力复测失败,沿用上次结果(节点 ${w.name}): ${errMsg(e)}`);
          continue;
        }
        // An old bundle without `_node-capabilities` also lands here; either way nothing is pushed.
        this.support_.set(w.id, { kind: "unknown", at, reason: `无法确认节点是否支持 0 落盘: ${errMsg(e)}` });
      }
    }
  }

  /**
   * Poll node reports and apply receipts. Nodes with a zero-disk room are polled every call; others
   * only every `idlePollMs` so a late receipt (the room was moved away right after a run) is still
   * collected without an extra ssh per node per tick.
   */
  async poll(workers: readonly ZeroDiskWorker[], targetedWorkerIds: ReadonlySet<string>): Promise<void> {
    for (const w of workers) {
      if (w.kind === "local" || !w.transport?.zeroDiskReport) continue;
      const targeted = targetedWorkerIds.has(w.id);
      const last = this.lastPolledAt.get(w.id) ?? 0;
      if (!targeted && this.now() - last < this.idlePollMs) continue;
      this.lastPolledAt.set(w.id, this.now());
      const at = this.now();
      let report: ZeroDiskReport | null;
      try {
        report = await w.transport.zeroDiskReport();
      } catch (e) {
        this.polls.set(w.id, { kind: "offline", at, reason: `节点不可达或回执读取失败: ${errMsg(e)}` });
        continue;
      }
      if (report === null) {
        // Old bundle (unknown command): unsupported, not a failure. Remember it so the gate agrees.
        this.support_.set(w.id, { kind: "unsupported", at, reason: UNSUPPORTED_REASON });
        this.polls.set(w.id, { kind: "unsupported", at, reason: UNSUPPORTED_REASON });
        continue;
      }
      this.polls.set(w.id, { kind: "ok", at, report });
      for (const r of report.receipts) this.applyOnce(w, r);
    }
  }

  private applyOnce(w: ZeroDiskWorker, r: ZeroDiskReceipt): void {
    if (this.applied.has(r.id)) return;
    let res: { ok: boolean; error?: string };
    try {
      res = this.o.applyReceipt(r);
    } catch (e) {
      res = { ok: false, error: errMsg(e) };
    }
    if (res.ok) {
      this.applied.add(r.id);
      this.log(`[zero-disk] 回执已记入台账 worker=${w.id} room=${r.platform}:${r.roomSlug} parts=${r.parts}`);
      return;
    }
    // Not marked applied: the next poll retries. Alert once per receipt, because until it succeeds a
    // real archive is missing from the ledger.
    this.log(`[zero-disk] ⚠️ 回执记账失败(下轮重试) worker=${w.id} room=${r.platform}:${r.roomSlug}: ${res.error ?? "unknown"}`);
    if (!this.alerted.has(r.id)) {
      this.alerted.add(r.id);
      this.o.alert?.(`直播直传回执无法记入 master 台账(稿件已上传,将自动重试): 节点 ${w.name} 房间 ${r.platform}:${r.roomSlug}: ${res.error ?? "unknown"}`);
    }
  }

  /**
   * Console view for one (room, node). `blocked` = the master itself refused to push (e.g. the
   * master's upload account is not identifiable); it takes precedence because nothing is running.
   */
  view(worker: Pick<ZeroDiskWorker, "id" | "name">, room: { platform: string; roomSlug: string }, blocked?: string): ZeroDiskNodeStatusDTO {
    const base = { workerId: worker.id, workerName: worker.name };
    if (blocked) return { ...base, state: "blocked", reason: blocked, checkedAt: null };
    const sup = this.support_.get(worker.id);
    if (sup?.kind === "unsupported") return { ...base, state: "unsupported", reason: sup.reason, checkedAt: sup.at };
    if (sup?.kind === "unknown") return { ...base, state: "offline", reason: sup.reason, checkedAt: sup.at };
    const poll = this.polls.get(worker.id);
    if (!poll) return { ...base, state: "ok", checkedAt: null };
    if (poll.kind === "unsupported") return { ...base, state: "unsupported", reason: poll.reason, checkedAt: poll.at };
    if (poll.kind === "offline") return { ...base, state: "offline", reason: poll.reason, checkedAt: poll.at };
    const st: ZeroDiskNodeStatus | undefined = poll.report.status.find((s) => s.platform === room.platform && s.roomSlug === room.roomSlug);
    if (!st) return { ...base, state: "ok", checkedAt: poll.at };
    const lv = poll.report.live?.find((x) => x.platform === room.platform && x.roomSlug === room.roomSlug);
    const current = lv?.current ?? lv?.previous;
    return {
      ...base,
      state: "ok",
      run: st.state,
      ...(st.code ? { code: st.code } : {}),
      ...(st.message ? { message: st.message } : {}),
      parts: st.parts,
      ...(st.bvid ? { bvid: st.bvid } : {}),
      ...(current ? { live: liveUploadSummary(current) } : {}),
      checkedAt: poll.at,
    };
  }

  /** Full current/previous snapshots from the last successful poll; null when unavailable. */
  live(workerId: string, platform: string, roomSlug: string): { current?: import("@drec/core").LiveUploadSnapshot; previous?: import("@drec/core").LiveUploadSnapshot } | null {
    const poll = this.polls.get(workerId);
    if (poll?.kind !== "ok") return null;
    const lv = poll.report.live?.find((x) => x.platform === platform && x.roomSlug === roomSlug);
    return lv ? { ...(lv.current ? { current: lv.current } : {}), ...(lv.previous ? { previous: lv.previous } : {}) } : null;
  }

  /** Snapshot keyed by `platform:roomSlug` for the targets the master currently expects. */
  snapshot(
    targets: readonly ZeroDiskTarget[],
    workers: readonly Pick<ZeroDiskWorker, "id" | "name">[],
    blocked: ReadonlyMap<string, string> = new Map(),
  ): Map<string, ZeroDiskNodeStatusDTO[]> {
    const out = new Map<string, ZeroDiskNodeStatusDTO[]>();
    for (const t of targets) {
      const w = workers.find((x) => x.id === t.workerId);
      if (!w) continue;
      const key = `${t.platform}:${t.roomSlug}`;
      const list = out.get(key) ?? [];
      list.push(this.view(w, t, blocked.get(blockedKey(t.workerId, t.platform, t.roomSlug))));
      out.set(key, list);
    }
    return out;
  }
}

export const blockedKey = (workerId: string, platform: string, roomSlug: string): string => `${workerId}|${platform}:${roomSlug}`;

function errMsg(e: unknown): string {
  return String((e as Error)?.message ?? e).slice(0, 200);
}
