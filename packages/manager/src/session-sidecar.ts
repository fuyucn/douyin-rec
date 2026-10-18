import { readFileSync } from "node:fs";
import { writeFileAtomicSync } from "@drec/core";

export interface SidecarWriteHooks {
  /** Test seam: runs after the old file was read and before the new one is written. */
  afterRead?: () => void;
}

/**
 * Write the session sidecar `{base}.session.json` atomically. The node-side remux marker
 * (`nodeFormat`) is owned by another writer, so it is carried over from the existing file.
 */
export function writeSessionSidecar(base: string, data: Record<string, unknown>, hooks: SidecarWriteHooks = {}): void {
  const p = `${base}.session.json`;
  const out: Record<string, unknown> = { ...data };
  try {
    const prev = JSON.parse(readFileSync(p, "utf-8")) as { nodeFormat?: unknown };
    if (typeof prev?.nodeFormat === "string") out.nodeFormat = prev.nodeFormat;
  } catch { /* missing or unparsable: no marker to carry */ }
  hooks.afterRead?.();
  writeFileAtomicSync(p, JSON.stringify(out));
}
