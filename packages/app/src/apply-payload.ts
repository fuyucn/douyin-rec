/**
 * apply-payload.ts — decode the `_apply-tasks` payload and apply it.
 *
 * Kept out of the CLI entry so the payload → snapshot contract is unit-testable
 * without importing platform vendor bundles.
 */
import type { RemoteTaskSpec } from "@drec/core";
import { applyRemoteTasks, type ApplyTasksOptions } from "./task-sync.js";
import type { TaskStore } from "./store.js";

export interface ApplyTasksPayload {
  desired: RemoteTaskSpec[];
  force?: boolean;
  expectedVersion?: number;
}

/**
 * Decode the base64 JSON payload sent by the master.
 * Older masters omit `expectedVersion`; invalid values are ignored rather than
 * rejecting the whole desired set, because the version is observability only.
 */
export function parseApplyTasksPayload(b64: string): ApplyTasksPayload {
  const raw = JSON.parse(Buffer.from(b64, "base64").toString("utf-8")) as Partial<ApplyTasksPayload> | null;
  if (!raw || typeof raw !== "object") return { desired: [] };
  return {
    desired: Array.isArray(raw.desired) ? raw.desired : [],
    ...(raw.force === true ? { force: true } : {}),
    ...(typeof raw.expectedVersion === "number"
      && Number.isInteger(raw.expectedVersion)
      && raw.expectedVersion >= 1
      ? { expectedVersion: raw.expectedVersion }
      : {}),
  };
}

/** Parse and apply one master payload; the snapshot records the received version. */
export function applyTasksPayload(
  store: TaskStore,
  b64: string,
  log: ((msg: string) => void) | undefined,
  opts: Pick<ApplyTasksOptions, "managedStateDir">,
) {
  const input = parseApplyTasksPayload(b64);
  return applyRemoteTasks(store, input.desired, log, {
    ...opts,
    force: input.force === true,
    ...(input.expectedVersion !== undefined ? { expectedVersion: input.expectedVersion } : {}),
  });
}
