/** Legacy queue handoff is retained as an explicit, non-destructive manual hold. */
import { isLivePumpPartObserved, readLivePumpState, requiresLivePumpProof } from "@drec/zero-upload";

export interface EnqueueLivePumpInput {
  statePath: string;
  cookiesPath: string;
  taskId?: number;
  seasonSectionId?: number;
  log?: (message: string) => void;
}

export interface EnqueueLivePumpResult {
  queued: number;
  already: number;
  failed: number;
  needsManual?: number;
  deferred?: number;
  blocked?: string;
  error?: string;
}

export function enqueueLivePumpPending(input: EnqueueLivePumpInput): EnqueueLivePumpResult {
  const state = readLivePumpState(input.statePath);
  if (!state) return { queued: 0, already: 0, failed: 0, error: "live state missing or unreadable" };
  const unresolved = state.parts.filter(part => !isLivePumpPartObserved(part)).length;
  const held = Math.max(unresolved, state.pending ? 1 : 0);
  return {
    queued: 0, already: 0, failed: held, needsManual: held,
    blocked: requiresLivePumpProof(state)
      ? "Protected live delivery retains its original UPOS owner; biliup queue handoff is unsupported"
      : "Legacy live delivery has no native per-part observation; preserve source and queue history for manual review",
  };
}
