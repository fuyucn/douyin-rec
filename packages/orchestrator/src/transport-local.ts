// packages/orchestrator/src/transport-local.ts
import { mkdirSync, existsSync, rmSync } from "node:fs";
import { join, basename } from "node:path";
import { linkOrCopy } from "@drec/core";
import { freeGBOf, type EnqueueRequest, type EnqueueResponse, type ProcessReceipt, type NodeTaskDTO, type RemoteTaskSpec, type NodeStatus } from "@drec/core";
import type { ActiveRecordingRoom, ApplyTasksResult, NodeInventory, NodeRecordingStatus, NodeTasks, Transport } from "./transport.js";
import { ProcUnsupported } from "./transport.js";
import { scanInventory, scanRollingSessions } from "./scan.js";
import { segmentSecByAnchorOf } from "./unclaimed.js";

export interface LocalOpts {
  id: string;
  recordingsDir: string;
  /** anchorName(目录名) → roomSlug。接受普通 Record 或 getter 函数（getter 每次调用时取最新快照）。 */
  taskRooms: Record<string, string> | (() => Record<string, string>);
  ffprobe: (file: string) => Promise<{ durationSec: number; startMs: number; endMs: number }>;
  /**
   * 该 roomSlug 此刻是否还在本机录制中(用于 settle 判定是否收播)。
   * 不提供 → 默认「不在录」(isDone=true),保留旧行为。**多节点 master 必须注入**,
   * 否则 isDone 恒 true → settle 不等录完 → 周期对账边录边合并残片(踩过)。
   */
  isRoomRecording?: (roomSlug: string) => boolean;
  /** 当前正在写流的 room identities;区分同 roomSlug 的不同平台。 */
  activeRecordingRooms?: () => ActiveRecordingRoom[];
  /** hub 任务同步:读本机任务清单(local worker = master 自身)。缺省 = 不支持。 */
  listTasks?: () => NodeTaskDTO[];
  /** hub 任务同步:把期望任务应用到本机 store。缺省 = 不支持。 */
  applyTasks?: (input: { desired: RemoteTaskSpec[]; force?: boolean }) => ApplyTasksResult;
  /** 本节点稳定身份(<root>/config/node.json)。缺省 → nodeId() 返 null。 */
  nodeIdentity?: () => { nodeId: string; hostname?: string } | null;
  /**
   * 本机应用回执(T16)。缺省 → nodeStatus() 返 null(UI 显示 unknown)。
   *
   * 本机也要有:master 自身是 local worker,「本机应用了哪一版期望」同样需要可见 ——
   * 否则版本漂移告警会漏掉 master 自己那台。
   */
  nodeStatus?: () => NodeStatus | null;
  /** 本机任务日志尾巴(F3);缺省 → taskLogs() 返回不支持。 */
  taskLogs?: (taskId: number, lines: number) => { lines: string[]; error?: string };
  /** 本机处理任务表入队(与 `_enqueue` 同一执行体,库路径 = procQueueDbPath(cfg.dataRoot));缺省 = 不支持。 */
  enqueue?: (req: EnqueueRequest) => EnqueueResponse;
  /** Cancel jobs in the local proc queue; absent = unsupported. */
  procCancel?: (jobIds: string[]) => ProcessReceipt[];
  /** 本机回执查询(与 `_proc-status` 同一执行体);缺省 = 不支持。 */
  procStatus?: (jobIds: string[]) => ProcessReceipt[];
}

export class LocalTransport implements Transport {
  readonly id: string;
  constructor(private o: LocalOpts) { this.id = o.id; }

  private resolveTaskRooms(): Record<string, string> {
    return typeof this.o.taskRooms === "function" ? this.o.taskRooms() : this.o.taskRooms;
  }

  async listInventory(): Promise<NodeInventory> {
    const taskRooms = this.resolveTaskRooms();
    // Without listTasks (standalone construction sites) segmentSec stays null and the master falls back to its default.
    const segmentSecByAnchor = segmentSecByAnchorOf(this.o.listTasks?.() ?? []);
    const inv = await scanInventory(this.o.recordingsDir, taskRooms, this.o.ffprobe, { segmentSecByAnchor });
    return { workerId: this.id, ...inv };
  }

  async listTasks(): Promise<NodeTasks> {
    if (!this.o.listTasks) throw new Error("LocalTransport: 未注入 listTasks 回调(hub 任务同步未启用)");
    return { workerId: this.id, tasks: this.o.listTasks() };
  }

  async applyTasks(input: { desired: RemoteTaskSpec[]; force?: boolean }): Promise<ApplyTasksResult> {
    if (!this.o.applyTasks) throw new Error("LocalTransport: 未注入 applyTasks 回调(hub 任务同步未启用)");
    return this.o.applyTasks(input);
  }

  /** 本机应用回执(T16);未注入 → null(unknown)。 */
  async nodeStatus(): Promise<NodeStatus | null> {
    return this.o.nodeStatus?.() ?? null;
  }

  /** 本机稳定身份(有注入才返回;否则 null —— master 本机通常 id 固定为 "local")。 */
  async nodeId(): Promise<{ nodeId: string; hostname?: string } | null> {
    return this.o.nodeIdentity?.() ?? null;
  }

  /** 该 room 还在本机录制 → 未收播(false);否则已收播(true)。注入 isRoomRecording 才生效,否则恒 true(旧行为)。 */
  async isDone(roomSlug: string): Promise<boolean> {
    return !(this.o.isRoomRecording?.(roomSlug) ?? false);
  }

  async activeRecordingRooms(): Promise<ActiveRecordingRoom[]> {
    return this.o.activeRecordingRooms?.() ?? [];
  }

  async recordingStatus(): Promise<NodeRecordingStatus> {
    const rooms = this.o.activeRecordingRooms?.() ?? [];
    return { rooms, rolling: scanRollingSessions(this.o.recordingsDir, rooms) };
  }

  /** 本机任务日志尾巴(F3):由组合根注入读取(本地 serve 自己的环形缓冲)。 */
  async taskLogs(taskId: number, lines: number): Promise<{ lines: string[]; error?: string }> {
    if (!this.o.taskLogs) return { lines: [], error: "本机未注入日志读取(单机模式)" };
    return this.o.taskLogs(taskId, lines);
  }

  async enqueue(req: EnqueueRequest): Promise<EnqueueResponse> {
    if (!this.o.enqueue) throw new ProcUnsupported("本机未注入处理任务表入队");
    return this.o.enqueue(req);
  }

  async procStatus(jobIds: string[]): Promise<ProcessReceipt[]> {
    if (!this.o.procStatus) throw new ProcUnsupported("本机未注入处理任务表回执查询");
    return this.o.procStatus(jobIds);
  }

  async procCancel(jobIds: string[]): Promise<ProcessReceipt[]> {
    if (!this.o.procCancel) throw new ProcUnsupported("local proc-queue cancel is not injected");
    return this.o.procCancel(jobIds);
  }

  /** 轻量探针:recordings 目录存在即视为就绪(不扫内容)。 */
  async ping(): Promise<void> {
    if (!existsSync(this.o.recordingsDir)) {
      throw new Error(`dataRoot 不存在或不可达: ${this.o.recordingsDir}`);
    }
  }

  /** 同机:fs 判存在(全在才 true)。 */
  async exists(paths: string[]): Promise<boolean> {
    return paths.every((p) => existsSync(p));
  }

  /** 同机:fs 删除(逐个 rm,失败吞掉)。 */
  async cleanup(paths: string[]): Promise<void> {
    for (const p of paths) { try { rmSync(p, { force: true }); } catch { /* 忽略 */ } }
  }

  /**
   * 同机 pull：mkdir -p localDir，然后把每个文件**硬链接**进去（保留文件名）。
   *
   * 为什么用硬链接而不是复制:winner 是 master 本机时,源与 stage 在**同一块盘**上,
   * 复制等于把同一份数据存两遍 —— 白占磁盘 + 白费 IO(实测 4.6GB 的场次要读写各 4.6GB,
   * 台账统计 7 天 local winner 的 pull 达 51GB,比所有 VPS 回传加起来还多)。
   * 硬链接是同一 inode 的第二个名字:瞬间完成、零额外空间。
   *
   * 安全性:清理逻辑删 stage 的「副本」时,`recordings/` 的原文件仍在(反之亦然)——
   * 删一个名字只是把引用计数减一,不会丢数据。这与 `session-plan.ts` 的 upload 别名
   * 是同一套语义(那里也先 linkSync、失败再 copy)。
   *
   * 回落:跨设备/文件系统不支持硬链接(EXDEV/EPERM/EMLINK 等)→ 退回复制,行为与从前一致。
   */
  async pull(remotePaths: string[], localDir: string): Promise<void> {
    mkdirSync(localDir, { recursive: true });
    for (const src of remotePaths) {
      const dst = join(localDir, basename(src));
      // 目标已存在(续跑/重跑)→ 先删,否则 linkSync 直接 EEXIST。
      if (existsSync(dst)) rmSync(dst, { force: true });
      linkOrCopy(src, dst); // 硬链接优先;跨设备/不支持 → 复制并提示一次(与从前行为一致)
    }
  }

  /** 同机:数据根所在卷剩余空间 GB(master 侧磁盘看门狗用)。 */
  async diskFreeGB(): Promise<number> {
    const { statfs } = await import("node:fs/promises");
    const st = await statfs(this.o.recordingsDir);
    return freeGBOf(st);
  }
}
