import type { PartSubmitter, LivePumpReporter } from "@drec/core";
import type { DtsGap } from "@drec/post-process";
import type { SubmitGate } from "./live-pump-legacy-publication.js";
export interface LivePumpSessionOpts {
  cookiesPath: string;
  room: string;
  spoolDir: string;
  title: string;
  tid: number;
  tag: string;
  desc?: string;
  private?: boolean;
  fetchImpl?: typeof fetch;
  log?: (msg: string) => void;
  cleanupConfirmedSpool?: boolean;
  sleep?: (ms: number) => Promise<void>;
  submitter?: PartSubmitter;
  submitterTargetId?: string;
  rateLimitBaseMs?: number;
  rateLimitAttempts?: number;
  line?: string;
  onChunk?: (streamedBytes: number, chunksDone: number) => void;
  probeDuration?: (path: string) => Promise<number>;
  scanDtsGap?: (path: string) => Promise<DtsGap | null | undefined>;
  seasonSectionId?: number;
  reporter?: LivePumpReporter;
  onAlert?: (message: string) => void;
  submitGate?: SubmitGate;
}
export type SpoolResubmitResult = {
  ok: boolean;
  bvid?: string;
  aid?: number;
  error?: string;
  held?: boolean;
  retryable?: boolean;
};
export type PartSubmitInput = {
  index: number;
  spoolPath: string;
  stem: string;
  title: string;
  bytes: number;
  durationSec: number;
};
