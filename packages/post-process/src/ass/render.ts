// ts/src/core/post/ass/render.ts
import { XMLParser } from "fast-xml-parser";
import { RollingAss, type RollingOpts, type RollingItem } from "./rolling.js";
import { LiveChatAss, type ChatItem } from "./livechat.js";

export interface RenderOpts extends RollingOpts {
  giftValueFilter?: number;     // >0 时，price<=filter 的礼物丢弃(只留 >filter,不含正好等于阈值;--gift-value 0.9 排除正好 0.9 的为你闪耀/星光闪耀)
  types?: Set<"danmaku" | "gift" | "member">;
}

interface RenderResult { ass: string; danmaku: number; }

const parser = new XMLParser({
  ignoreAttributes: false, attributeNamePrefix: "@_",
  // <d> 文本在 #text；保留空白由我们 trim
  trimValues: false,
});

const arr = <T,>(x: T | T[] | undefined): T[] => (x == null ? [] : Array.isArray(x) ? x : [x]);

/** 单段 XML 抽取选项。offset 加到所有时间上（合并多段时传累计偏移；单段传 0）。 */
export interface ExtractOpts {
  giftValueFilter?: number;
  types?: Set<"danmaku" | "gift" | "member">;
  offset?: number;
}

/**
 * 从单个 biliLive XML 抽取统一 ChatItem 列表（含 offset 平移）。
 * 移植 merger.render_xml_to_ass 的逐项逻辑：
 *   - <d>   time = p[0] + offset
 *   - <gift> time = ts/1000 - seg_start + offset（<0 归 0）
 *   - <member> time = ts/1000 - seg_start + offset（<0 归 0）
 * 单段渲染与多段合并共用此函数（DRY）。
 */
export function extractItems(xml: string, opts: ExtractOpts = {}): ChatItem[] {
  const types = opts.types ?? new Set(["danmaku", "gift", "member"] as const);
  const giftFilter = opts.giftValueFilter ?? 0;
  const offset = opts.offset ?? 0;
  const root = parser.parse(xml).i ?? {};
  const seg = Number(root?.metadata?.video_start_time ?? 0) / 1000;
  const items: ChatItem[] = [];

  if (types.has("danmaku")) {
    for (const d of arr<Record<string, unknown>>(root.d)) {
      const p = String(d["@_p"] ?? "0").split(",");
      const t = Number(p[0] ?? 0) + offset;
      if (!(t >= 0)) continue;
      const content = String(d["#text"] ?? "").trim();
      if (!content) continue;
      items.push({ timeSec: t, kind: "danmaku", uname: String(d["@_user"] ?? ""), content, color: "ffffff" });
    }
  }

  if (types.has("gift")) {
    for (const g of arr<Record<string, unknown>>(root.gift)) {
      let t = Number(g["@_ts"] ?? 0) / 1000 - seg + offset;
      if (!(t >= 0)) t = 0;
      const price = Number(g["@_price"] ?? 0);
      if (giftFilter > 0 && price <= giftFilter) continue; // 不含阈值:--gift-value 0.9 = 只留 >0.9(正好 0.9 的为你闪耀/星光闪耀排除)
      items.push({
        timeSec: t, kind: "gift", uname: String(g["@_user"] ?? ""),
        giftName: String(g["@_giftname"] ?? g["@_gift"] ?? ""),
        giftCount: Number(g["@_giftcount"] ?? g["@_count"] ?? 1), color: "add8e6",
      });
    }
  }

  if (types.has("member")) {
    for (const m of arr<Record<string, unknown>>(root.member)) {
      let t = Number(m["@_ts"] ?? 0) / 1000 - seg + offset;
      if (!(t >= 0)) t = 0;
      items.push({ timeSec: t, kind: "member", uname: String(m["@_user"] ?? ""), color: "aaaaaa" });
    }
  }

  return items;
}

/** gift ChatItem → 滚动轨显示文本（🎁 user: N个giftname）。 */
function giftText(it: ChatItem): string {
  return `🎁 ${it.uname ?? ""}: ${it.giftCount ?? 0}个${it.giftName ?? ""}`;
}

/**
 * 礼物专属顶部轨道数(动态,移植 merger 的 Pass1):按过滤后礼物密度 = 条/小时,
 * track_min = clamp(ceil(rate/180), 1..3);无礼物=0。这样礼物占顶部 1-3 行、弹幕在其下,不重叠。
 */
function giftTrackCount(items: ChatItem[]): number {
  const times = items.filter((it) => it.kind === "gift").map((it) => it.timeSec);
  if (times.length === 0) return 0;
  const spanHr = Math.max((Math.max(...times) - Math.min(...times)) / 3600, 1 / 60);
  return Math.max(1, Math.min(3, Math.ceil(times.length / spanHr / 180)));
}

/** ChatItem 列表 → 滚动 ASS（仅 danmaku+gift；member 不入滚动轨）。供单段/多段共用。 */
export function itemsToRollingAss(items: ChatItem[], opts: RollingOpts = {}): RenderResult {
  const trackMin = giftTrackCount(items);
  const writer = new RollingAss({ ...opts, trackMin });
  let danmaku = 0;
  for (const it of items) {
    if (it.kind === "member") continue;
    if (it.kind === "gift") {
      // 礼物 → 顶部专属轨道池 [0, trackMin),不与弹幕抢轨。
      writer.add({ timeSec: it.timeSec, text: giftText(it), color: "add8e6" }, [0, trackMin]);
      continue;
    }
    const ok = writer.add({
      timeSec: it.timeSec,
      text: it.uname ? `${it.uname}: ${it.content ?? ""}` : (it.content ?? ""),
      color: "ffffff",
    });
    if (ok) danmaku++;
  }
  return { ass: writer.render(), danmaku };
}

/** ChatItem 列表 → livechat ASS。供单段/多段共用。 */
export function itemsToLivechatAss(items: ChatItem[], opts: { width?: number; height?: number } = {}): { ass: string; count: number } {
  const lc = new LiveChatAss({ width: opts.width, height: opts.height });
  const ass = lc.write(items);
  const count = (ass.match(/^Dialogue:/gm) ?? []).length;
  return { ass, count };
}

/** biliLive {base}.xml → 滚动 ASS 文本。移植 merger.render_xml_to_ass（仅 danmaku+gift；member 不入滚动轨）。 */
export function renderXmlToAss(xml: string, opts: RenderOpts = {}): RenderResult {
  const types = opts.types ?? new Set(["danmaku", "gift"] as const);
  const items = extractItems(xml, { giftValueFilter: opts.giftValueFilter, types });
  return itemsToRollingAss(items, opts);
}

export interface LivechatRenderOpts {
  width?: number; height?: number; giftValueFilter?: number;
}

export function renderXmlToLivechat(xml: string, opts: LivechatRenderOpts = {}): { ass: string; count: number } {
  // livechat 排除 member（进入直播间）——对齐 VPS/Python 输出：5000+ 条进场会刷屏，Python livechat 不收
  const items = extractItems(xml, {
    giftValueFilter: opts.giftValueFilter,
    types: new Set(["danmaku", "gift"]),
  });
  return itemsToLivechatAss(items, { width: opts.width, height: opts.height });
}
