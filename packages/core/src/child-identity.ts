/**
 * Child process identity (plan 038 T07).
 *
 * `pid` alone is not identity: after a restart the OS may reuse it. We compare a platform
 * start-time fingerprint before treating a child as ours.
 */
import { readFileSync } from "node:fs";
import { execFileSync } from "node:child_process";

export interface ChildFingerprint {
  pid: number;
  /** Linux: starttime field from /proc/<pid>/stat. macOS: `ps -o lstart`. */
  startedAt: string;
  cmdline: string;
}

export type PlatformProbe = (pid: number) => ChildFingerprint | null;

function linuxProbe(pid: number): ChildFingerprint | null {
  try {
    const stat = readFileSync(`/proc/${pid}/stat`, "utf-8");
    // Field 22 is starttime; comm may contain spaces/parens, so parse after the last ')'.
    const rest = stat.slice(stat.lastIndexOf(")") + 2).split(" ");
    const startedAt = rest[19] ?? "";
    let cmdline = "";
    try { cmdline = readFileSync(`/proc/${pid}/cmdline`, "utf-8").replace(/\0/g, " ").trim(); } catch { /* gone */ }
    return startedAt ? { pid, startedAt, cmdline } : null;
  } catch { return null; }
}

function darwinProbe(pid: number): ChildFingerprint | null {
  try {
    const startedAt = execFileSync("ps", ["-o", "lstart=", "-p", String(pid)], { encoding: "utf-8" }).trim();
    const cmdline = execFileSync("ps", ["-o", "command=", "-p", String(pid)], { encoding: "utf-8" }).trim();
    return startedAt ? { pid, startedAt, cmdline } : null;
  } catch { return null; }
}

/** Default probe picks the platform; tests inject their own. */
export function probeChild(pid: number): ChildFingerprint | null {
  if (process.platform === "linux") return linuxProbe(pid);
  if (process.platform === "darwin") return darwinProbe(pid);
  return null;
}

/** True only when the live process matches a recorded fingerprint. */
export function isSameChild(recorded: { pid: number | null; startedAt: string | null }, current: ChildFingerprint | null): boolean {
  if (recorded.pid == null || current == null) return false;
  if (current.pid !== recorded.pid) return false;
  if (!recorded.startedAt || !current.startedAt) return false;
  return recorded.startedAt === current.startedAt;
}
