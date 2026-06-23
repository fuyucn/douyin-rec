import { writeFileSync, openSync, writeSync, closeSync, fstatSync, ftruncateSync } from "node:fs";
import type { DanmuMessage, DanmuWriter } from "@drec/core";
import { RECORDER_XML_STYLE } from "./recorder-xml-style.js";

/**
 * 产出与 @bililive-tools/douyin-recorder 一致的 biliLive **RecorderXmlStyle** 格式，
 * 使独立 DanmuSource（websocket-danmu-listener / douyin-danma-listener / DLR）写的 xml
 * 在浏览器/弹幕查看器里渲染正常（之前只引用 `href="#s"` 却没带 `<RecorderXmlStyle>`
 * 样式表 → "有内容但展示格式不对"）。
 *
 * 关键格式点（对齐 biliLive，且不破坏 ASS 渲染器 render.ts 的解析）：
 *   - `<d p="rel,1,25,16777215,tsMs,0,midHash,mid,0" user uid timestamp>text</d>`
 *     9 段 p（midHash/mid 都用 uid）+ user/uid/timestamp 属性。p[0]=rel 秒（render 用 p[0]）。
 *   - `<gift ... ts="tsMs"/>`：ts 保持 **epoch ms**（render.ts 按 ts/1000 - video_start_time/1000
 *     算礼物相对时间；DLR 也是 ms）。
 *   - `<member ... ts="tsMs"/>`。
 *   - `<metadata><video_start_time>` 必须填首条消息 epoch ms，render.ts 才能把礼物 ts 换成
 *     相对时间（否则空值→0→礼物落到 epoch 秒、飞出片长）。该字段在 open() 写成定宽 13 位
 *     占位，首条消息时原地覆盖（避免改文件长度）。
 * 另：抖音弹幕 WS 会重发最近消息（同一条以相同 tsMs/uid/内容多次推送），库不去重 →
 * 这里按 (kind,tsMs,uid,内容) 去重，消除"每条重复 2~6 次"。
 */
const VST_WIDTH = 13; // epoch ms 位数（13 位可用到公元 2286）

// 到 <video_start_time> 占位值之前的固定 ASCII 前缀（无多字节）→ 其字节偏移可直接计算。
const VST_PREFIX =
  `<?xml version="1.0" encoding="utf-8"?>\n` +
  `<?xml-stylesheet type="text/xsl" href="#s"?>\n` +
  `<i>\n` +
  `<metadata>\n` +
  `  <platform>DouYin</platform>\n` +
  `  <video_start_time>`;
const VST_OFFSET = Buffer.byteLength(VST_PREFIX, "utf-8");

function escapeXml(s: string): string {
  return (s ?? "").replace(/&/g, "&amp;").replace(/</g, "&lt;")
    .replace(/>/g, "&gt;").replace(/"/g, "&quot;");
}

const HEADER = (anchor: string, roomId: string, vst: string) =>
  VST_PREFIX +
  vst +
  `</video_start_time>\n` +
  `  <room_title></room_title>\n` +
  `  <user_name>${escapeXml(anchor)}</user_name>\n` +
  `  <room_id>${escapeXml(roomId)}</room_id>\n` +
  `</metadata>\n` +
  `${RECORDER_XML_STYLE}\n`;

export class XmlDanmuWriter implements DanmuWriter {
  private path = "";
  private baseSec: number | null = null;
  /** 视频起点 epoch ms(open 传入)。非空 → 锚到视频起点 + 丢弃开播前回灌历史;空 → 锚到首条消息(旧行为)。 */
  private videoStartMs: number | null = null;
  /** 去重：抖音 WS 会重发最近消息，按消息键丢弃重复。每次 open() 重置。 */
  private seen = new Set<string>();

  open(filePath: string, meta: { anchorName: string; roomId?: string; videoStartMs?: number }): void {
    this.path = filePath;
    this.videoStartMs = meta.videoStartMs ?? null;
    // 锚到视频起点时 baseSec 立即定;否则等首条消息(旧行为)。
    this.baseSec = this.videoStartMs != null ? this.videoStartMs / 1000 : null;
    this.seen = new Set();
    const vst =
      this.videoStartMs != null
        ? String(this.videoStartMs).padStart(VST_WIDTH, "0").slice(0, VST_WIDTH)
        : "0".repeat(VST_WIDTH);
    writeFileSync(this.path, HEADER(meta.anchorName, meta.roomId ?? "", vst) + `</i>\n`, "utf-8");
  }

  add(m: DanmuMessage): void {
    // 锚到视频起点时:丢弃发送时间早于视频起点的消息 —— 抖音 WS 一连上会回灌「开播前的历史弹幕」
    // (带各自的旧 eventTime,可比视频早十几分钟);不丢会把整条轴钉到开播前 → 实时弹幕整体错位。
    if (this.videoStartMs != null && m.tsMs < this.videoStartMs) return;
    // 去重键：同一条弹幕被 WS 重发时 tsMs/uid/内容一致；正常重复（不同时刻）tsMs 不同，保留。
    const uid = m.uid ?? "";
    const key =
      m.kind === "danmaku" ? `d|${m.tsMs}|${uid}|${m.content ?? ""}`
      : m.kind === "gift" ? `g|${m.tsMs}|${uid}|${m.giftName ?? ""}|${m.giftCount ?? ""}`
      : `m|${m.tsMs}|${uid}`;
    if (this.seen.has(key)) return;
    this.seen.add(key);

    const firstMessage = this.baseSec === null;
    if (firstMessage) this.baseSec = m.tsMs / 1000;
    const rel = Math.max(0, m.tsMs / 1000 - (this.baseSec as number)).toFixed(3);
    const u = escapeXml(uid);
    let line = "";
    if (m.kind === "danmaku") {
      // 9 段 p（midHash/mid 都用 uid）+ user/uid/timestamp 属性，对齐 biliLive。
      line = `<d p="${rel},1,25,16777215,${m.tsMs},0,${u},${u},0" ` +
        `user="${escapeXml(m.user ?? "")}" uid="${u}" timestamp="${m.tsMs}">${escapeXml(m.content ?? "")}</d>\n`;
    } else if (m.kind === "gift") {
      // ts 保持 epoch ms（render.ts 按 ts/1000 - video_start_time/1000 计算礼物相对时间）。
      line = `<gift user="${escapeXml(m.user ?? "")}" uid="${u}" giftname="${escapeXml(m.giftName ?? "")}" ` +
        `giftcount="${m.giftCount ?? 1}" price="${m.price ?? 0}" ts="${m.tsMs}"/>\n`;
    } else {
      line = `<member user="${escapeXml(m.user ?? "")}" uid="${u}" member_count="0" ts="${m.tsMs}"/>\n`;
    }
    // 在末尾 </i> 之前插入：截掉最后的 "</i>\n"，追加 line + "</i>\n"
    const fd = openSync(this.path, "r+");
    try {
      // 旧行为(未传 videoStartMs):首条消息原地把 video_start_time 占位覆盖为本条 epoch ms
      // (定宽,不改文件长度)。锚到视频起点时 baseSec 已在 open() 定、vst 已写,firstMessage 恒 false。
      if (firstMessage) {
        const vst = String(m.tsMs).padStart(VST_WIDTH, "0").slice(0, VST_WIDTH);
        writeSync(fd, vst, VST_OFFSET, "utf-8");
      }
      const size = fstatSync(fd).size;
      const tail = "</i>\n";
      ftruncateSync(fd, size - Buffer.byteLength(tail, "utf-8"));
      writeSync(fd, line + tail, size - Buffer.byteLength(tail, "utf-8"), "utf-8");
    } finally {
      closeSync(fd);
    }
  }

  close(): void {
    // 文件始终合法（open 即写 </i>），无需额外操作
  }
}
