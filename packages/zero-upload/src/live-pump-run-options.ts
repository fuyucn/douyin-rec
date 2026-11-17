import type { statfsSync } from "node:fs";
import type { DanmuMessage, PartSubmitter, LivePumpReporter } from "@drec/core";
import type { DtsGap } from "@drec/post-process";
import type { SubmitGate } from "./live-pump-legacy-publication.js";
import type { StreamAcquirer } from "./live-pump-source.js";
export interface LivePumpSegmentReport {
  seg: number;
  chunks: number;
  bytes: number;
  spooled: number;
  ms: number;
  stem?: string;
  exit?: number | null;
  backpressured?: boolean;
  degradedReason?: string;
  spoolDurationSec?: number;
  sessionLeaked?: boolean;
  uploadError?: string;
  usedFileFallback?: boolean;
  spoolIncomplete?: boolean;
}
export type LivePumpHandoffReceipt = {
  status: "owned";
} | {
  status: "retryable";
  detail: string;
} | {
  status: "blocked";
  detail: string;
};
export interface RunLivePumpOptions {
  onAlert?: (message: string) => void;
  cookiesPath: string;
  room: string;
  fetch: (room: string, quality: string) => Promise<StreamAcquirer>;
  quality: string;
  spoolDir: string;
  title: string;
  titleForLive?: (liveTitle: string) => string;
  tid: number;
  tag: string;
  seasonSectionId?: number;
  desc?: string;
  private?: boolean;
  sizeCap: number;
  maxMs?: number;
  stallTimeoutMs?: number;
  recoverWindowMs?: number;
  mediaWallAlertRatio?: number;
  maxSegments?: number;
  spoolName?: (segIndex: number) => string;
  line?: string;
  submit?: boolean;
  submitMode?: "direct" | "spool";
  onHandoff?: (statePath: string) => LivePumpHandoffReceipt | Promise<LivePumpHandoffReceipt>;
  diskMinGB?: number;
  statfsImpl?: typeof statfsSync;
  partTitle?: (partIndex: number, liveTitle?: string) => string | null;
  log?: (msg: string) => void;
  submitGate?: SubmitGate;
  submitter?: PartSubmitter;
  submitterTargetId?: string;
  reporter?: LivePumpReporter;
  onPartConfirmed?: (info: {
    count: number;
    bvid?: string;
  }) => void;
  shouldStop?: () => boolean | Promise<boolean>;
  drainSignal?: AbortSignal;
  sleep?: (ms: number) => Promise<void>;
  waitForBroadcast?: boolean;
  onPhase?: (phase: "polling" | "recording" | "finalizing") => void;
  idlePollMs?: number;
  spoolMode?: "full" | "none";
  queueCapacity?: number;
  fetchImpl?: typeof fetch;
  probeDuration?: (path: string) => Promise<number>;
  scanDtsGap?: (path: string) => Promise<DtsGap | null | undefined>;
  writeSpool?: (fd: number, buf: Buffer) => number;
  onSpoolWriteFailed?: (reason: string) => void;
  autoRetryUpload?: boolean;
  finalizeBudgetMs?: number;
  signal?: AbortSignal;
  danmu?: {
    start: (onMessage: (m: DanmuMessage) => void) => Promise<void>;
    stop: () => Promise<void>;
    xmlPath: string;
  };
}
export interface RunLivePumpResult {
  ok: boolean;
  error?: string;
  outcome?: "uploaded" | "no-stream" | "idle";
  lostParts?: number;
  unknownParts?: number;
  uploadPending?: boolean;
  archiveExists?: boolean;
  bvid?: string;
  aid?: number;
  title: string;
  segments: LivePumpSegmentReport[];
  spoolDir: string;
  statePath: string;
}
