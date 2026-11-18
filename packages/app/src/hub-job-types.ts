/** Public and internal data contracts for hub job queries. */

import type { HubPoolSnapshotDTO, HubQueueDTO, HubQueueStats, NodeUploadStatusDTO, QueueItemDTO, QueuePhase } from "@drec/core";

export interface HubJobEvent { state: string; at: number; }

export interface HubJobStep { step: string; phase: string; at: number; detail?: string }

export interface HubJobCandidate { worker: string; coverage: number; durationSec: number; complete: boolean; isWinner: boolean; danmuCount?: number | null; }

export interface HubJobNodeState { node: string; state: string; error: string | null; attempts: number; updatedAt: number }

export interface HubJobView {
  streamKey: string;
  state: string;
  winnerWorker: string | null;

  candidates: HubJobCandidate[];
  bv: string | null;
  error: string | null;
  fails: number;
  updatedAt: number;

  startedAt: number | null;

  events: HubJobEvent[];

  steps: HubJobStep[];

  nodeStates: HubJobNodeState[];

  currentStepSec: number | null;

  etaSec: number | null;

  videoDurationSec: number | null;

  hasLog: boolean;

  nodeUpload: NodeUploadStatusDTO | null;

  ackedAt: number | null;
  ackNote: string | null;
}

export interface RawJob {
  streamKey: string; state: string; winnerWorker: string | null; bv: string | null; error: string | null;
  fails: number; updatedAt: number; uploadStatus?: string | null; ackedAt?: number | null; ackNote?: string | null;
}

export interface ListHubJobsOpts {

  excludeError?: string;

  onlyError?: string;

  acked?: boolean;

  room?: string;

  states?: readonly string[];

  excludeStates?: readonly string[];

  limit?: number;

  offset?: number;
  now?: number;
  stageDir?: string;

  logsDir?: string;
}

export interface HubJobsResult {
  jobs: HubJobView[];

  total: number;
}

export interface AttachedBuckets {
  events: Map<string, (HubJobEvent & { rid: number })[]>;
  steps: Map<string, (HubJobStep & { rid: number })[]>;
  candidates: Map<string, HubJobCandidate[]>;
  nodeStates: Map<string, HubJobNodeState[]>;
}

export type AttachedTables = AttachedBuckets;

export interface BuildQueueOpts {

  anchorOf?: (platform: string, roomSlug: string) => string | null;

  disabledOf?: (platform: string, roomSlug: string) => ReadonlySet<string> | null;

  pool?: HubPoolSnapshotDTO;

  recentLimit?: number;

  phase?: readonly QueuePhase[];

  states?: readonly string[];

  platform?: readonly string[];

  q?: string;

  sort?: "newest" | "oldest";

  manualLimit?: number;
  now?: number;
  stageDir?: string;

  logsDir?: string;
}

export interface LatestRunPerRoom {

  roomKey: string;
  streamKey: string;
  state: string;
  bv: string | null;
  updatedAt: number;

  manualPhase: QueuePhase | null;
}
