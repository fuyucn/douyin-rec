/** Fail-closed detection of active jobs for a room. */

import { statSync } from "node:fs";
import { HUB_ROOM_STREAM_PREDICATE, roomKeyToStreamPrefix } from "@drec/core";
import { openLedger, TERMINAL_SQL } from "./hub-job-ledger.js";

export function activeHubJobKeys(syncDbPath: string, roomKey: string): string[] {
  try {
    statSync(syncDbPath);
  } catch (e) {
    if ((e as NodeJS.ErrnoException).code === "ENOENT") return [];
    throw e;
  }
  const db = openLedger(syncDbPath);
  try {
    const tables = db.prepare("SELECT name FROM sqlite_master WHERE type='table'").all() as unknown as { name: string }[];
    if (!tables.some((table) => table.name === "sync_jobs")) return [];
    return (db.prepare(
      `SELECT streamKey FROM sync_jobs WHERE ${HUB_ROOM_STREAM_PREDICATE} AND (state IS NULL OR state NOT IN (${TERMINAL_SQL})) ORDER BY updatedAt DESC`,
    ).all(roomKeyToStreamPrefix(roomKey), roomKeyToStreamPrefix(roomKey)) as unknown as { streamKey: string }[]).map((r) => r.streamKey);
  } finally {
    db.close();
  }
}
