/** Fail-closed detection of active jobs for a room. */

import { statSync } from "node:fs";
import { HUB_ROOM_STREAM_PREDICATE, HUB_TABLE_NAMES, roomKeyToStreamPrefix } from "@drec/core";
import { openLedger, TERMINAL_SQL } from "./hub-job-ledger.js";

export function activeHubJobKeys(syncDbPath: string, roomKey?: string): string[] {
  try {
    statSync(syncDbPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const db = openLedger(syncDbPath);
  try {
    const objects = db.prepare(
      `SELECT name, type FROM sqlite_master WHERE lower(name) IN (${HUB_TABLE_NAMES.map(() => "?").join(",")})`,
    ).all(...HUB_TABLE_NAMES) as unknown as { name: string; type: string }[];
    const syncJobs = objects.find((object) => object.name.toLowerCase() === "sync_jobs");
    if (!syncJobs) return [];
    if (syncJobs.type !== "table") {
      throw new Error(`Unexpected schema object type for sync_jobs: ${syncJobs.type}`);
    }
    const where = roomKey
      ? `${HUB_ROOM_STREAM_PREDICATE} AND (state IS NULL OR state NOT IN (${TERMINAL_SQL}))`
      : `state IS NULL OR state NOT IN (${TERMINAL_SQL})`;
    const params = roomKey ? [roomKeyToStreamPrefix(roomKey), roomKeyToStreamPrefix(roomKey)] : [];
    return (db.prepare(
      `SELECT streamKey FROM sync_jobs WHERE ${where} ORDER BY updatedAt DESC`,
    ).all(...params) as unknown as { streamKey: string }[]).map((r) => r.streamKey);
  } finally {
    db.close();
  }
}
