export class EndDebouncer {
  private timer: ReturnType<typeof setTimeout> | null = null;
  constructor(private settleMs: number, private onEnded: () => void) {}
  observe(isRecording: boolean): void {
    if (isRecording) { if (this.timer) { clearTimeout(this.timer); this.timer = null; } return; }
    if (this.timer) return;                       // 已在等 settle
    this.timer = setTimeout(() => { this.timer = null; this.onEnded(); }, this.settleMs);
  }
}
