/**
 * rolling-manifest-io.ts — 边录边传清单(`{base}.rolling.json`)的读写(IO 层;判定在 core/rolling-manifest)。
 *
 * 读:**不存在 ≠ 损坏**。不存在 = 全新会话;解析失败/读失败 = 不可信,调用方必须转人工,
 * 绝不当新会话处理(否则会重复建稿)。
 * 写:临时文件 + fsync + rename + **目录 fsync**(rename 本身的持久化)。
 */
import { closeSync, fsyncSync, openSync, readFileSync, renameSync, statSync, unlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { parseRollingManifest, serializeRollingManifest, type RollingManifest } from "@drec/core";

export type ManifestRead =
  | { status: "missing" }
  | { status: "ok"; manifest: RollingManifest; legacy: boolean; mtimeMs: number }
  | { status: "corrupt"; reason: string };

export const manifestPathFor = (dir: string, sessionBase: string): string => join(dir, `${sessionBase}.rolling.json`);

export function readManifestFile(dir: string, sessionBase: string): ManifestRead {
  const p = manifestPathFor(dir, sessionBase);
  let text: string;
  try {
    text = readFileSync(p, "utf-8");
  } catch (e) {
    if ((e as NodeJS.ErrnoException)?.code === "ENOENT") return { status: "missing" };
    return { status: "corrupt", reason: `读取失败: ${String((e as Error)?.message ?? e).slice(0, 120)}` };
  }
  const parsed = parseRollingManifest(text, sessionBase);
  if (parsed.kind === "corrupt") return { status: "corrupt", reason: parsed.reason };
  let mtimeMs = 0;
  try { mtimeMs = statSync(p).mtimeMs; } catch { /* mtime 仅用于老清单静置判定 */ }
  return { status: "ok", manifest: parsed.manifest, legacy: parsed.legacy, mtimeMs };
}

/** 目录 fsync(持久化 rename)。失败不致命(部分文件系统不支持),返回 false 由调用方记一次警告。 */
export function fsyncDir(dir: string): boolean {
  try {
    const fd = openSync(dir, "r");
    try { fsyncSync(fd); } finally { closeSync(fd); }
    return true;
  } catch {
    return false;
  }
}

/** 原子写;失败抛错(调用方据此把状态标记为不可信)。返回目录 fsync 是否成功。 */
export function writeManifestAtomic(dir: string, sessionBase: string, m: RollingManifest, nowMs: number): { dirSynced: boolean } {
  const target = manifestPathFor(dir, sessionBase);
  const tmp = `${target}.tmp.${process.pid}.${Date.now().toString(36)}`;
  try {
    const fd = openSync(tmp, "w", 0o644);
    try {
      writeFileSync(fd, serializeRollingManifest(m, nowMs), "utf-8");
      fsyncSync(fd);
    } finally {
      closeSync(fd);
    }
    renameSync(tmp, target);
  } catch (e) {
    try { unlinkSync(tmp); } catch { /* best-effort */ }
    throw e;
  }
  return { dirSynced: fsyncDir(dir) };
}

/** pid 是否存在(ESRCH = 不存在;EPERM = 存在但无权限 = 存在)。 */
export function pidAlive(pid: number): boolean {
  if (!Number.isInteger(pid) || pid <= 0) return false;
  try {
    process.kill(pid, 0);
    return true;
  } catch (e) {
    return (e as NodeJS.ErrnoException)?.code === "EPERM";
  }
}
