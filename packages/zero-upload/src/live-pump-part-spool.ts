import { closeSync, mkdirSync, openSync, rmSync, writeSync } from "node:fs";
import { dirname } from "node:path";

/** A failed or stalled write leaves a truncated spool, never a complete fallback source. */
export class SpoolWriteError extends Error {
  constructor(message: string, readonly spooledBytes: number) { super(message); }
}

type SpoolWrite = (fd: number, buf: Buffer) => number;

/** Own the file descriptor and count only bytes actually written, including partial writes. */
export class PartSpool {
  private readonly fd: number | undefined;
  private written = 0;
  private truncated = false;

  constructor(
    private readonly path: string,
    mode: "full" | "none" = "full",
    private readonly write: SpoolWrite = (fd, buf) => writeSync(fd, buf),
  ) {
    mkdirSync(dirname(path), { recursive: true });
    this.fd = mode === "full" ? openSync(path, "w") : undefined;
  }

  get enabled(): boolean { return this.fd !== undefined; }
  get bytes(): number { return this.written; }
  get incomplete(): boolean { return this.truncated; }

  append(buf: Buffer): void {
    if (this.fd === undefined) {
      this.written += buf.length;
      return;
    }
    if (this.truncated) return;
    let off = 0;
    try {
      while (off < buf.length) {
        const n = this.write(this.fd, buf.subarray(off));
        if (!(n > 0)) throw new Error(`writeSync 返回 ${n},写入未推进`);
        off += n;
      }
    } catch (e) {
      this.truncated = true;
      this.written += off;
      const why = `spool 写失败,本段被截断(已写 ${this.written}B,本块丢 ${buf.length - off}B): ${String((e as Error)?.message ?? e).slice(0, 200)}`;
      throw new SpoolWriteError(why, this.written);
    }
    this.written += off;
  }

  close(): void {
    if (this.fd === undefined) return;
    try { closeSync(this.fd); } catch { /* Already closed. */ }
  }

  /** The sink seals first; discard then removes only an enabled spool. */
  discard(): void {
    if (this.fd === undefined) return;
    try { rmSync(this.path, { force: true }); } catch { /* Best effort. */ }
  }
}
