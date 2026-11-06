/**
 * plan 046 PR7: one pure decision for who uploads a sealed part.
 *
 * Env/config reads, rule-file parsing and task snapshots stay outside; callers pass only the three
 * facts below. Consumers must call this (via the app wrapper) instead of re-deriving conditions.
 */
export type UploadOwner = "node" | "master";

export interface UploadOwnerFacts {
  /** An enabled hub rule is bound to this room (sourceTaskId match or room-key match). */
  ruleEnabled: boolean;
  /** This task is the rule's recording.sourceTaskId. */
  boundBySourceTask: boolean;
  /** An enabled rule matches by {platform}.{roomSlug}. */
  boundByRoomKey: boolean;
}

export function resolveUploadOwner(facts: UploadOwnerFacts): UploadOwner {
  return facts.ruleEnabled && (facts.boundBySourceTask || facts.boundByRoomKey) ? "master" : "node";
}

