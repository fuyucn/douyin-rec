export const CHUNK_UNIT = 10 * 1024 * 1024;
/** Explicit spool-only capacity: never enqueue transfer chunks. */
export const SPOOL_ONLY = 0;

/** Own chunk assembly, bounded FIFO and final-size accounting without upload side effects. */
export class PartBuffer {
  private readonly items: Uint8Array[] = [];
  private readonly waiters: Array<() => void> = [];
  private closed = false;
  private carry: Buffer[] = [];
  private carryBytes = 0;
  private fullChunks = 0;
  private tailBytes = 0;
  private queued = 0;
  private unit = 0;

  constructor(private readonly capacity: number) {}

  get disabled(): boolean { return this.capacity === SPOOL_ONLY; }
  get queuedChunks(): number { return this.queued; }
  get chunkSize(): number { return this.unit; }
  get hasData(): boolean { return this.fullChunks > 0 || this.tailBytes > 0; }

  configure(chunkSize: number): void { this.unit = chunkSize; }

  /** False means that a full chunk did not fit; the caller owns degradation policy. */
  append(buf: Buffer): boolean {
    this.carry.push(buf);
    this.carryBytes += buf.length;
    if (this.carryBytes < this.unit) return true;
    const all = this.carry.length === 1 ? this.carry[0]! : Buffer.concat(this.carry, this.carryBytes);
    let off = 0;
    while (all.length - off >= this.unit) {
      const chunk = Buffer.from(all.subarray(off, off + this.unit));
      if (!this.push(chunk)) return false;
      off += this.unit;
      this.queued++;
      this.fullChunks++;
    }
    const rest = all.subarray(off);
    this.carry = rest.length ? [Buffer.from(rest)] : [];
    this.carryBytes = rest.length;
    return true;
  }

  /** Queue the tail before closing; repeated calls never enqueue it again. */
  pushTail(): boolean {
    if (this.carryBytes === 0 || this.tailBytes > 0) return true;
    const tail = Buffer.concat(this.carry, this.carryBytes);
    this.clearCarry();
    if (this.disabled) return true;
    if (!this.push(tail)) return false;
    this.queued++;
    this.tailBytes = tail.length;
    return true;
  }

  clearCarry(): void {
    this.carry = [];
    this.carryBytes = 0;
  }

  /** The declared bound remains authoritative until a tail or an exact-boundary seal. */
  totalSize(sealed: boolean, sizeCap: number): number {
    return this.tailBytes > 0 || (sealed && this.fullChunks > 0)
      ? this.fullChunks * this.unit + this.tailBytes
      : sizeCap;
  }

  close(): void {
    this.closed = true;
    for (const wake of this.waiters.splice(0)) wake();
  }

  async shift(): Promise<Uint8Array | undefined> {
    while (true) {
      if (this.items.length > 0) return this.items.shift();
      if (this.closed) return undefined;
      await new Promise<void>((resolve) => this.waiters.push(resolve));
    }
  }

  private push(chunk: Uint8Array): boolean {
    if (this.disabled || this.closed || this.items.length >= this.capacity) return false;
    this.items.push(chunk);
    this.waiters.shift()?.();
    return true;
  }
}
