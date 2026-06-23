// ts/src/core/post/ass/rolling.ts

import { tagEmoji } from "./emoji.js";

export interface RollingItem { timeSec: number; text: string; color: string; }

export interface RollingOpts {
  width?: number; height?: number;
  font?: string; fontsize?: number;
  dmrate?: number; dmduration?: number; opacity?: number;
  marginH?: number; marginW?: number; dst?: number;
  outlineColor?: string; outlineSize?: number;
  /** 顶部预留给礼物的专属轨道数(原版 merger 动态 1-3)。弹幕从 trackMin 轨开始,不与礼物重叠。 */
  trackMin?: number;
}

/** #RRGGBB / RRGGBB → &HBBGGRR（移植 _rgb2bgr） */
export function rgb2bgr(color: string): string {
  const c = color.replace(/^#/, "").padStart(6, "0");
  return `&H${c.slice(4, 6)}${c.slice(2, 4)}${c.slice(0, 2)}`.toUpperCase();
}

/** 秒 → H:MM:SS.cc（百分秒，移植 '%02d:%02d:%05.2f' 但小时不补零，与 libass 容忍一致） */
export function sec2ass(sec: number): string {
  sec = Math.max(0, sec);
  const h = Math.floor(sec / 3600);
  const m = Math.floor((sec % 3600) / 60);
  const s = sec % 60;
  const ss = s.toFixed(2).padStart(5, "0");
  return `${h}:${m.toString().padStart(2, "0")}:${ss}`;
}

export class RollingAss {
  private readonly width: number;
  private readonly height: number;
  private readonly fontsize: number;
  private readonly font: string;
  private readonly dmduration: number;
  private readonly marginH: number;
  private readonly marginW: number;
  private readonly dst: number;
  private readonly opacityHex: string;       // 两位十六进制 alpha
  private readonly outlineColor: string;
  private readonly outlineSize: number;
  private readonly ntracks: number;
  /** 顶部礼物专属轨道数;弹幕轨道池 = [trackMin, trackMin+ntracks)。 */
  readonly trackMin: number;
  private readonly lines: string[] = [];
  private readonly trackTails: (RollingItem | null)[];

  constructor(o: RollingOpts) {
    const width = o.width ?? 1920;
    const height = o.height ?? 1080;
    const baseFs = o.fontsize ?? 32;
    const dmrate = o.dmrate ?? 0.20;
    this.width = width;
    this.height = height;
    this.fontsize = Math.floor((height / 1080) * baseFs);
    this.font = o.font ?? "Noto Sans CJK SC";
    this.dmduration = o.dmduration ?? 16.0;
    this.marginH = o.marginH ?? 6;
    this.marginW = o.marginW ?? 12;
    this.dst = o.dst ?? 0;
    const opacity = o.opacity ?? 0.8;
    this.opacityHex = (255 - Math.floor(opacity * 255)).toString(16).padStart(2, "0").toUpperCase();
    this.outlineColor = (o.outlineColor ?? "000000").padStart(6, "0");
    this.outlineSize = o.outlineSize ?? 1.0;
    const total = Math.floor(((height - this.dst) * dmrate) / (this.fontsize + this.marginH));
    this.ntracks = Math.max(1, total);
    this.trackMin = Math.max(0, o.trackMin ?? 0);
    // 前 trackMin 条专属礼物 + 后 ntracks 条弹幕(对齐原版 AssWriter)。
    this.trackTails = new Array(this.trackMin + this.ntracks).fill(null);
  }

  private charWidth(text: string): number {
    let w = 0;
    for (const ch of text) w += (new TextEncoder().encode(ch).length > 1) ? this.fontsize : Math.floor(this.fontsize / 2);
    return w;
  }

  /**
   * 移植 add()：碰撞检测分配轨道（不丢弃，强制最空闲轨）；空文本/负时间返回 false。
   * trackPool=[start,end) 限定轨道范围(礼物传 [0,trackMin) 走顶部专属轨);省略=弹幕池 [trackMin, trackMin+ntracks)。
   */
  add(dm: RollingItem, trackPool?: [number, number]): boolean {
    if (dm.timeSec == null || dm.timeSec < 0 || !dm.text) return false;

    const tailDist = (tail: RollingItem | null): number => {
      if (tail === null) return 1e5;
      const dmLen = this.charWidth(tail.text);
      return ((dm.timeSec - tail.timeSec) * (dmLen + this.width)) / this.dmduration - dmLen;
    };

    const [poolStart, poolEnd] = trackPool ?? [this.trackMin, this.trackMin + this.ntracks];
    let tid = poolStart, maxDist = -1e5;
    for (let i = poolStart; i < poolEnd; i++) {
      const dist = tailDist(this.trackTails[i]);
      if (dist > 0.2 * this.width && dist > this.marginW) { tid = i; break; }
      if (dist > maxDist) { tid = i; maxDist = dist; }
    }

    const dmLen = this.charWidth(dm.text);
    const x0 = this.width, x1 = -dmLen;
    const y = this.fontsize + (this.fontsize + this.marginH) * tid + this.dst;
    const t0 = sec2ass(dm.timeSec);
    const t1 = sec2ass(dm.timeSec + this.dmduration);
    const colorStr = rgb2bgr(dm.color.startsWith("#") ? dm.color : `#${dm.color}`);
    // NFKC 规范化（花体字→ASCII fallback）+ emoji 字体标记，对齐 Python _prepare_text
    const text = tagEmoji(dm.text.replace(/[\r\n]/g, " ").normalize("NFKC"), this.font);

    this.lines.push(
      `Dialogue: 0,${t0},${t1},R2L,,0,0,0,,` +
      `{\\q2\\move(${x0},${y},${x1},${y})}` +
      `{\\alpha&H${this.opacityHex}\\1c${colorStr}&}` + text,
    );
    this.trackTails[tid] = dm;
    return true;
  }

  /** 生成完整 ASS 文本（移植 _meta 头 + 累积 Dialogue 行）— Step 3b 完整实现 */
  render(): string {
    const meta = [
      "[Script Info]", "ScriptType: v4.00+", "Collisions: Normal",
      `PlayResX: ${this.width}`, `PlayResY: ${this.height}`,
      "Timer: 100.0000", "WrapStyle: 2", "",
      "[V4+ Styles]",
      "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, " +
      "OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, " +
      "ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, " +
      "Alignment, MarginL, MarginR, MarginV, Encoding",
      `Style: R2L,${this.font},${this.fontsize},&H${this.opacityHex}FFFFFF,` +
      `&H${this.opacityHex}000000,&H${this.opacityHex}${this.outlineColor},` +
      `&H4F0000FF,-1,0,0,0,100,100,0,0,1,${this.outlineSize},0,1,0,0,0,0`,
      "",
      "[Events]",
      "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
      ...this.lines,
    ];
    return meta.join("\n") + "\n";
  }
}
