// ts/src/core/post/ass/livechat.ts
// 移植 src/danmu/live_chat_writer.py LiveChatWriter — 直播间聊天框堆叠样式 ASS 渲染器

// eslint-disable-next-line @typescript-eslint/no-require-imports
const eaw = require("eastasianwidth") as { eastAsianWidth(ch: string): "F" | "W" | "Na" | "H" | "A" | "N" };

import { tagEmoji } from "./emoji.js";
import { sec2ass, rgb2bgr } from "./rolling.js";

// ── 公开类型 ──────────────────────────────────────────────────────────────────

export interface ChatItem {
  timeSec: number;
  kind: "danmaku" | "gift" | "member";
  color: string;
  uname?: string;
  content?: string;
  giftName?: string;
  giftCount?: number;
}

export interface LiveChatOpts {
  width?: number;
  height?: number;
  font?: string;
  /** base fontsize at 1080p */
  fontsize?: number;
  lineSpacing?: number;
  opacity?: number;
  displayDuration?: number;
  panelLeftPct?: number;
  panelRightPct?: number;
  panelTopPct?: number;
  panelBottomPct?: number;
  outlineColor?: string;
  outlineSize?: number;
}

// ── 渲染器 ────────────────────────────────────────────────────────────────────

export class LiveChatAss {
  static readonly STYLE_NAME = "LiveChat";

  private readonly width: number;
  private readonly height: number;
  private readonly fontsize: number;
  private readonly font: string;
  private readonly opacityHex: string;      // 两位十六进制 alpha (00–ff)
  private readonly displayDuration: number;
  private readonly outlineColor: string;
  private readonly outlineSize: number;

  private readonly panelX: number;
  private readonly panelRight: number;
  private readonly panelTop: number;
  private readonly panelBottom: number;
  private readonly panelW: number;
  private readonly lineH: number;
  private readonly maxVisible: number;

  constructor(o: LiveChatOpts = {}) {
    const width  = o.width  ?? 1920;
    const height = o.height ?? 1080;
    const baseFs = o.fontsize ?? 50;
    const lineSpacing = o.lineSpacing ?? 6;
    const opacity = o.opacity ?? 0.85;
    const panelLeftPct   = o.panelLeftPct   ?? 0.02;
    const panelRightPct  = o.panelRightPct  ?? 0.98;
    const panelTopPct    = o.panelTopPct    ?? 0.73;
    const panelBottomPct = o.panelBottomPct ?? 0.98;

    this.width   = width;
    this.height  = height;
    this.font    = o.font ?? "Noto Sans CJK SC";
    this.fontsize = Math.floor(Math.min(width, height) / 1080 * baseFs);
    // Python: hex(255 - int(opacity * 255))[2:].zfill(2)
    this.opacityHex = (255 - Math.floor(opacity * 255)).toString(16).padStart(2, "0");
    this.displayDuration = o.displayDuration ?? 30.0;
    this.outlineColor = (o.outlineColor ?? "000000").padStart(6, "0");
    this.outlineSize  = o.outlineSize ?? 1.0;

    // 面板像素坐标
    this.panelX      = Math.trunc(width  * panelLeftPct);
    this.panelRight  = Math.trunc(width  * panelRightPct);
    this.panelTop    = Math.trunc(height * panelTopPct);
    this.panelBottom = Math.trunc(height * panelBottomPct);
    this.panelW      = this.panelRight - this.panelX;

    this.lineH       = this.fontsize + lineSpacing;
    this.maxVisible  = Math.max(1, Math.floor((this.panelBottom - this.panelTop) / this.lineH));
  }

  // ── 私有辅助 ──────────────────────────────────────────────────────────────

  /** 估算单个字符的渲染宽度（像素）。对齐 Python _char_w。 */
  private charW(ch: string): number {
    const w = eaw.eastAsianWidth(ch);
    if (w === "W" || w === "F") return this.fontsize;
    if (w === "Na" || w === "H") return Math.floor(this.fontsize * 0.4);
    // 'N' | 'A' — 多字节(CJK 代码段外)按全宽，否则半宽
    return new TextEncoder().encode(ch).length > 1
      ? this.fontsize
      : Math.floor(this.fontsize * 0.4);
  }

  /** 在面板宽度处插入 \N（ASS 硬换行）。对齐 Python _wrap_text。 */
  private wrapText(text: string): string {
    const maxW = this.panelW;
    const lines: string[] = [];
    let cur = "";
    let curW = 0;
    for (const ch of text) {
      const chW = this.charW(ch);
      if (curW + chW > maxW && cur) {
        lines.push(cur);
        cur = ch;
        curW = chW;
      } else {
        cur += ch;
        curW += chW;
      }
    }
    if (cur) lines.push(cur);
    return lines.join("\\N");
  }

  /** 拼接显示文本（gift / member / danmaku）。对齐 Python _format_text。 */
  private formatText(item: ChatItem): string {
    if (item.kind === "gift") {
      return `🎁 ${item.uname ?? ""}: ${item.giftCount ?? 0}个${item.giftName ?? ""}`;
    }
    if (item.kind === "member") {
      return `👋 ${item.uname ?? ""} 进入直播间`;
    }
    // danmaku
    const uname = item.uname ?? "";
    const content = item.content ?? "";
    return uname ? `${uname}: ${content}` : content;
  }

  /**
   * NFKC 规范化 + emoji 字体标记。对齐 Python _prepare_text。
   * heights 计算用 wrapText **之后、tagEmoji 之前**的 \N 段数（tagEmoji 不含 \N）。
   */
  private prepareText(text: string): string {
    return tagEmoji(text.normalize("NFKC"), this.font);
  }

  // ── header ────────────────────────────────────────────────────────────────

  private assHeader(): string {
    const op = this.opacityHex;
    const oc = this.outlineColor;
    const style =
      `Style: ${LiveChatAss.STYLE_NAME},${this.font},${this.fontsize},` +
      `&H${op}FFFFFF,&H${op}000000,&H${op}${oc},&H4F0000FF,` +
      `-1,0,0,0,100,100,0,0,1,${this.outlineSize},0,1,0,0,0,0`;
    return [
      "[Script Info]",
      "ScriptType: v4.00+",
      "Collisions: Normal",
      `PlayResX: ${this.width}`,
      `PlayResY: ${this.height}`,
      "Timer: 100.0000",
      "WrapStyle: 2",
      "",
      "[V4+ Styles]",
      "Format: Name, Fontname, Fontsize, PrimaryColour, SecondaryColour, " +
      "OutlineColour, BackColour, Bold, Italic, Underline, StrikeOut, " +
      "ScaleX, ScaleY, Spacing, Angle, BorderStyle, Outline, Shadow, " +
      "Alignment, MarginL, MarginR, MarginV, Encoding",
      style,
      "",
      "[Events]",
      "Format: Layer, Start, End, Style, Name, MarginL, MarginR, MarginV, Effect, Text",
    ].join("\n") + "\n";
  }

  // ── 主渲染 ────────────────────────────────────────────────────────────────

  /**
   * 将 ChatItem 列表渲染为完整 ASS 文本（堆叠聊天框样式）。
   * 移植 Python LiveChatWriter.write()。
   */
  write(items: ChatItem[]): string {
    // 过滤无效时间，升序
    const valid = items
      .filter(it => it.timeSec != null && it.timeSec >= 0)
      .sort((a, b) => a.timeSec - b.timeSec);

    const header = this.assHeader();

    if (valid.length === 0) {
      return header;
    }

    const clip =
      `\\clip(${this.panelX},${this.panelTop},${this.panelRight},${this.panelBottom})`;

    // 预计算每条消息的包装文本和高度
    // 关键：heights 基于 wrapText 的行数（wrapText 不含 tagEmoji，tagEmoji 不含 \N）
    const wrappedRaw: string[] = [];   // wrapText 结果（用于计算行数）
    const wrappedFinal: string[] = []; // prepareText(wrapText) 结果（用于 Dialogue）
    const heights: number[] = [];

    for (const item of valid) {
      const raw = this.formatText(item).replace(/[\r\n]/g, " ");
      const wRaw = this.wrapText(raw);
      const nLines = Math.max(1, wRaw.split("\\N").length);
      wrappedRaw.push(wRaw);
      wrappedFinal.push(this.prepareText(wRaw));
      heights.push(nLines * this.lineH);
    }

    const dialogueLines: string[] = [];

    for (let i = 0; i < valid.length; i++) {
      const text = wrappedFinal[i];
      if (!text) continue;

      const item = valid[i];
      const colorSrc = item.color.startsWith("#") ? item.color : `#${item.color}`;
      const color = rgb2bgr(colorSrc);
      const expire = item.timeSec + this.displayDuration;

      // rank k：消息 i 在面板中的位置（0 = 最底部）
      for (let k = 0; k < this.maxVisible; k++) {
        const j = i + k;  // 触发该 rank 的消息索引
        if (j >= valid.length) break;

        // 累计 i 下方（rank 0..k-1）各消息的实际高度
        let belowH = 0;
        for (let m = 1; m <= k; m++) belowH += heights[i + m];
        const y = this.panelBottom - belowH;

        // 若消息已超出面板顶部，停止
        if (y - heights[i] < this.panelTop) break;

        const segStart = valid[j].timeSec;
        const nextJ = j + 1;
        const segEnd = nextJ < valid.length
          ? Math.min(valid[nextJ].timeSec, expire)
          : expire;

        if (segEnd <= segStart) continue;

        const t0 = sec2ass(segStart);
        const t1 = sec2ass(segEnd);
        const line =
          `Dialogue: 1,${t0},${t1},${LiveChatAss.STYLE_NAME},,0,0,0,,` +
          `{\\an1\\q2${clip}\\pos(${this.panelX},${y})}` +
          `{\\alpha&H${this.opacityHex}\\1c${color}&}` +
          text;
        dialogueLines.push(line);

        if (segEnd >= expire) break;
      }
    }

    return header + dialogueLines.join("\n") + "\n";
  }
}
