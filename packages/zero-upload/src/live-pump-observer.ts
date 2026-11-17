import type { LivePumpReporter } from "@drec/core";
import type { RunLivePumpOptions } from "./live-pump-run-options.js";
import type { SealedPart, SegmentRunResult } from "./live-pump-types.js";
import type { LivePumpSession } from "./live-pump-session.js";
import { ARCHIVE_PARTS_WARN_AT, DEFAULT_MEDIA_WALL_ALERT_RATIO, RATIO_ALERT_COOLDOWN_MS } from "./live-pump-policy.js";
export class LivePumpObserver {
  private archivePartsWarned = false;
  private mediaWallAlertsSuppressed = 0;
  private suppressedLogged = false;
  private lastMediaWallAlertAt = 0;
  constructor(private readonly o: RunLivePumpOptions) {
  }
  log = (message: string): void => {
    (this.o.log ?? ((m: string) => process.stderr.write(m + "\n")))(message);
  };
  emit(e: Parameters<LivePumpReporter["event"]>[0]): void {
    try {
      this.o.reporter?.event(e);
    }
    catch {
    }
  }
  progress(p: {
    part: number;
    uploadedBytes: number;
    chunks: number;
  }): void {
    try {
      this.o.reporter?.progress(p);
    }
    catch {
    }
  }
  phase(p: "polling" | "recording" | "finalizing"): void {
    try {
      this.o.onPhase?.(p);
    }
    catch {
    }
  }
  alert(message: string): void {
    try {
      this.o.onAlert?.(message);
    }
    catch {
    }
  }
  checkArchivePartsWarn(session: LivePumpSession): void {
    if (this.archivePartsWarned)
      return;
    const confirmed = session.parts.filter(p => p.confirmed).length;
    if (confirmed < ARCHIVE_PARTS_WARN_AT)
      return;
    this.archivePartsWarned = true;
    const msg = `稿件分 P 已达 ${confirmed} 个(预警线 ${ARCHIVE_PARTS_WARN_AT}):平台对单稿件分 P 数有据信上限,继续追加可能失败,请人工关注`;
    this.log(`[直播直传] ⚠️ ${msg}`);
    try {
      this.o.onAlert?.(msg);
    }
    catch {
    }
  }
  logSuppressedRatioAlerts(): void {
    if (this.mediaWallAlertsSuppressed <= 0 || this.suppressedLogged)
      return;
    this.suppressedLogged = true;
    this.log(`[直播直传] ⚠️ 分段媒体/墙钟告警冷却期(每 ${Math.round(RATIO_ALERT_COOLDOWN_MS / 60000)} 分钟至多一条)内共抑制 ${this.mediaWallAlertsSuppressed} 条`);
  }
  reportMedia(part: SealedPart, r: SegmentRunResult, seg: number): void {
    const wallSec = part.sealedMs / 1000;
    const stallWaitSec = (part.stalledMs ?? 0) / 1000;
    const mediaBits: string[] = [];
    if (r.ptsDurationSec !== undefined) {
      mediaBits.push(`媒体 ${r.ptsDurationSec.toFixed(0)}s(PTS ${r.ptsStartSec?.toFixed(0) ?? "?"}→${r.ptsEndSec?.toFixed(0) ?? "?"})`);
    }
    mediaBits.push(`墙钟 ${wallSec.toFixed(0)}s`);
    if (r.ptsJumpCount)
      mediaBits.push(`空洞 ${r.ptsJumpCount} 处共 ${(r.ptsJumpSec ?? 0).toFixed(0)}s`);
    if (stallWaitSec >= 1)
      mediaBits.push(`无写入等待 ${stallWaitSec.toFixed(0)}s(不计入墙钟)`);
    this.log(`[直播直传] 段${seg + 1} 数据: ${mediaBits.join(",")}`);
    const alertRatio = this.o.mediaWallAlertRatio ?? DEFAULT_MEDIA_WALL_ALERT_RATIO;
    if (alertRatio > 0 && r.ptsDurationSec !== undefined && !part.stopped && wallSec >= 90 && r.ptsDurationSec >= 30 && r.ptsDurationSec / wallSec < alertRatio) {
      const now = Date.now();
      if (now - this.lastMediaWallAlertAt < RATIO_ALERT_COOLDOWN_MS) {
        this.mediaWallAlertsSuppressed += 1;
      }
      else {
        this.lastMediaWallAlertAt = now;
        const suppressedNote = this.mediaWallAlertsSuppressed > 0 ? `,此前冷却期内已抑制 ${this.mediaWallAlertsSuppressed} 条同类告警` : "";
        this.mediaWallAlertsSuppressed = 0;
        const stallNote = stallWaitSec >= 1 ? `,无写入等待 ${stallWaitSec.toFixed(0)}s 不计入比例` : "";
        const msg = `段${seg + 1} 媒体 ${r.ptsDurationSec.toFixed(0)}s / 墙钟 ${wallSec.toFixed(0)}s` + `(比例 ${(r.ptsDurationSec / wallSec).toFixed(2)} < ${alertRatio})` + `${r.ptsJumpCount ? `,其中 PTS 空洞 ${r.ptsJumpCount} 处共 ${(r.ptsJumpSec ?? 0).toFixed(0)}s` : ""}` + `${stallNote},直播内容疑似缺失${suppressedNote}`;
        this.log(`[直播直传] ⚠️ ${msg}`);
        try {
          this.o.onAlert?.(msg);
        }
        catch {
        }
      }
    }
  }
}
