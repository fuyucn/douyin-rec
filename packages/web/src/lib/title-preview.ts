/**
 * 投稿标题模板的前端预览(与后端 core title-template 同一套 token;样例值固定,只用于展示)。
 */
const TITLE_TOKEN_RE = /\{([A-Za-z]+)\}/g;

export interface PartSample {
  part: string;
  parts: string;
  kind: "plain" | "danmu" | "livechat";
}

export function previewTitle(template: string, name: string, partSample?: PartSample): string {
  const t = template.trim() || "{name}_{date}";
  const values: Record<string, string> = {
    name, user: name, owner: name,
    // 直播标题是主播自由输入,预览用一个像样的样例。
    title: "今晚直播标题",
    // 分P相关:未传样例(稿件名模板)时渲染成空,与后端一致。
    part: partSample?.part ?? "",
    parts: partSample?.parts ?? "",
    date: "2026-09-12",
    time: "14-30-05",
    datetime: "2026-09-12_14-30-05",
    yyyy: "2026", YYYY: "2026", year: "2026",
    MM: "09", month: "09",
    dd: "12", day: "12",
    HH: "14", hh: "14", hour: "14",
    mm: "30", min: "30",
    ss: "05", sec: "05",
    HHmm: "1430",
    HHmmss: "143005",
  };
  const base = t.replace(TITLE_TOKEN_RE, (raw, key: string) => values[key] ?? raw);
  // 类型后缀由后端自动追加(plain 无 / _danmu / _livechat),预览同口径。
  const kind = partSample?.kind;
  const suffix = kind === "danmu" ? "_danmu" : kind === "livechat" ? "_livechat" : "";
  return `${base}${suffix}`;
}

/** 分P名模板预览:P1 原画 / P2 弹幕版 / P3 互动版。 */
export function previewPartTitles(template: string, name: string): string {
  const kinds = ["plain", "danmu", "livechat"] as const;
  return kinds.map((kind, i) => previewTitle(template, name, { part: String(i + 1), parts: "3", kind })).join(" / ");
}
