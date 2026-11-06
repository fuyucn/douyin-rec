/**
 * plan 046 PR7: the single rule-match + upload-owner facade for the node side.
 *
 * Rule lookup was previously private to node-remux (outputFormat). Both that decision and the new
 * uploadOwner decision must see exactly the same enabled-rule binding, so the lookup lives here once.
 */
import { hubKey, listHubRules, type HubRule } from "./hub-store.js";
import { platformForRoom, resolveUploadOwner, type UploadOwner } from "@drec/core";

export type UploadOwnerTask = { id: number; room: string; managedBy?: string | null };

/** Enabled rule bound to this task, preferring recording.sourceTaskId over a room-key-only match. */
export function enabledHubRuleForTask(task: UploadOwnerTask, hubDir: string): HubRule | undefined {
  const platform = platformForRoom(task.room);
  const key = hubKey(platform.id, platform.extractRoomSlug(task.room));
  const enabled = listHubRules(hubDir).filter((rule) => rule.enabled);
  return enabled.find((rule) => rule.recording?.sourceTaskId === task.id) ?? enabled.find((rule) => rule.key === key);
}

/**
 * The only function consumers call: master means the hub owns uploads for this room and the node
 * must write a skipped(hub-owned) placeholder instead of uploading. enabled=false is unbound.
 */
/**
 * Whether the `record` child may make an upload-owner decision at all (rework addendum 7).
 *
 * A hub-managed task is always decided: the master exists by definition (it delivered the task). Any
 * other task is decided only on a hub master (`task serve --hub`): a machine that merely has enabled
 * rule files but runs no orchestrator has nobody to upload the skipped parts, so deciding "master"
 * there would silently stop the node's only upload path. `hubMaster` comes from the serve-level flag.
 */
export function shouldDecideUploadOwner(task: { managedBy?: string | null }, hubMaster: boolean): boolean {
  return task.managedBy === "hub" || hubMaster;
}

/** Master owns the upload, but this hub master has no enabled rule/job for the room: nothing will upload. */
export function masterOwnedWithoutRule(owner: UploadOwner, hasEnabledRule: boolean, hubMaster: boolean): boolean {
  return owner === "master" && hubMaster && !hasEnabledRule;
}

export function uploadOwnerForTask(task: UploadOwnerTask, hubDir: string): UploadOwner {
  // A hub-managed task is owned by the master even when the worker has no local rule files
  // (rules live on the master). Same precedent as node-remux's "hub-managed" lock.
  if (task.managedBy === "hub") return "master";
  const platform = platformForRoom(task.room);
  const key = hubKey(platform.id, platform.extractRoomSlug(task.room));
  const rule = enabledHubRuleForTask(task, hubDir);
  return resolveUploadOwner({
    ruleEnabled: rule !== undefined,
    boundBySourceTask: rule?.recording?.sourceTaskId === task.id,
    boundByRoomKey: rule?.key === key,
  });
}

