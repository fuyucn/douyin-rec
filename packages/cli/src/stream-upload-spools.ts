import { readdirSync } from "node:fs";
import { join } from "node:path";
import { sweepOrphanSpools } from "@drec/app";
import {
  archivedSpoolPathsToKeep, livePumpStatePath, readLivePumpState, spoolPathsToKeep, spoolSweepSafe,
} from "@drec/zero-upload";

/** Every root state owns its spools; an unreadable state makes the whole root unsafe to sweep. */
function rootSpoolsToKeep(root: string): string[] | undefined {
  const keep: string[] = [];
  try {
    for (const file of readdirSync(root)) {
      if (!/^live-pump-.+\.state\.json(?:\..+)?$/.test(file)) continue;
      if (file.includes(".tmp.")) continue;
      if (file.endsWith(".confirmed") || file.endsWith(".activity")) continue;
      const state = readLivePumpState(join(root, file));
      if (!state) return undefined;
      keep.push(...spoolPathsToKeep(state));
    }
  } catch (error) {
    if ((error as NodeJS.ErrnoException)?.code !== "ENOENT") return undefined;
  }
  return keep;
}

/** Sweep only old orphan files, protecting pending intents and archived state in both layouts. */
export function sweepStreamUploadSpools(root: string, pumpFilesDir: string, pumpRoom: string): void {
  const state = readLivePumpState(livePumpStatePath(pumpFilesDir, pumpRoom));
  const rootKeep = rootSpoolsToKeep(root);
  if (rootKeep) {
    sweepOrphanSpools({ spoolDir: root,
      knownSpoolPaths: [...rootKeep, ...archivedSpoolPathsToKeep(root, pumpRoom)], log: console.log });
  } else {
    console.log("[直播直传] 根目录存在无法读取的旧状态,跳过孤儿 spool 清扫(避免误删其引用的暂存文件)");
  }
  if (pumpFilesDir === root) return;
  if (spoolSweepSafe(pumpFilesDir, pumpRoom)) {
    sweepOrphanSpools({ spoolDir: pumpFilesDir,
      knownSpoolPaths: [...spoolPathsToKeep(state), ...archivedSpoolPathsToKeep(pumpFilesDir, pumpRoom)],
      log: console.log });
  } else {
    console.log("[直播直传] 房间目录存在无法读取的旧状态,跳过该目录清扫(避免误删其引用的暂存文件)");
  }
}
