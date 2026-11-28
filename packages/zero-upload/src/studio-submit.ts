import { readFileSync } from "node:fs";
import { UA, controlSignal, cookieHeaderOrThrow, csrfOf } from "./upos-http.js";
import { lookupArchive, type StudioArchive, type StudioVideo } from "./studio-archive.js";

export interface StudioInput {
  cookiesPath: string;
  title: string;
  tid: number;
  tag: string;
  desc?: string;
  /** Private by default; public exposure is irreversible and must be explicitly requested. */
  private?: boolean;
  /** Use the server-assigned stem from complete(), never a client filename or CID. */
  videos: Array<{ cid?: string; filename: string; title?: string; desc?: string }>;
  /** Existing archive ID for an edit; omit for creation. */
  aid?: number;
  fetchImpl?: typeof fetch;
}

export interface SubmitResult {
  ok: boolean;
  aid?: number;
  /** Success without a BV may already have created a draft; never blindly retry creation. */
  bvid?: string;
  raw: Record<string, unknown>;
}

// Preserve explicit empty/default fields: the web endpoint rejects incomplete Studio payloads.
function studioPayload(o: StudioInput): Record<string, unknown> {
  return {
    copyright: 1,
    source: "",
    tid: o.tid,
    cover: "",
    title: o.title.slice(0, 80),
    desc_format_id: 0,
    desc: o.desc ?? "",
    desc_v2: null,
    dynamic: "",
    subtitle: { open: 0, lan: "" },
    tag: (o.tag ?? "").split(",").filter(Boolean).slice(0, 10).join(","),

    videos: o.videos.map((v) => ({
      title: v.title ?? null,
      filename: v.filename,
      desc: v.desc ?? "",
    })),
    dtime: null,
    open_subtitle: false,
    interactive: 0,
    mission_id: null,
    dolby: 0,
    lossless_music: 0,
    no_reprint: 0,
    open_elec: 0,
    up_selection_reply: false,
    up_close_reply: false,
    up_close_danmu: false,
    // Irreversible publication policy: no nickname watermark, private unless opted out.
    watermark: { state: 0 },
    is_only_self: o.private === false ? 0 : 1,
    charging_pay: 0,
  };
}

/** Use Studio web endpoints for create/edit, preserving the complete upload policy payload. */
export async function submitStudio(o: StudioInput): Promise<SubmitResult> {
  const doFetch = o.fetchImpl ?? fetch;
  const cookie = cookieHeaderOrThrow(o.cookiesPath);
  const csrf = csrfOf(JSON.parse(readFileSync(o.cookiesPath, "utf-8")));
  const isEdit = typeof o.aid === "number" && o.aid > 0;
  const ts = Date.now();
  const path = isEdit ? "/x/vu/web/edit" : "/x/vu/web/add/v3";

  const studio = studioPayload(o);
  if (isEdit) studio.aid = o.aid;

  const res = await doFetch(`https://member.bilibili.com${path}?t=${ts}&csrf=${encodeURIComponent(csrf)}`, {
    method: "POST",
    headers: { "Content-Type": "application/json", "User-Agent": UA, Cookie: cookie, Referer: "https://member.bilibili.com/" },
    body: JSON.stringify(studio),
    signal: controlSignal(),
  });
  const raw = (await res.json().catch(() => ({}))) as Record<string, unknown>;
  const data = (raw.data ?? {}) as { aid?: number; bvid?: string };
  if (raw.code !== 0) return { ok: false, raw, ...(data.aid ? { aid: data.aid } : {}) };
  return { ok: true, raw, aid: data.aid, ...(data.bvid ? { bvid: data.bvid } : {}) };
}

/** Web edit replaces the entire part list: retain all prior parts and deduplicate by stem. */
export async function appendStudioPart(o: {
  cookiesPath: string;
  bvid?: string;
  aid?: number;
  video: StudioVideo;
  mustContain?: readonly string[];
  fetchImpl?: typeof fetch;
}): Promise<SubmitResult & { archive?: StudioArchive }> {
  const found = await lookupArchive({
    cookiesPath: o.cookiesPath,
    ...(o.bvid ? { bvid: o.bvid } : {}),
    ...(o.aid ? { aid: o.aid } : {}),
    ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}),
  });
  if (!found.ok || !found.archive) {
    return { ok: false, raw: { error: "lookup archive failed", ...found.raw } };
  }
  const existing = found.archive;
  if ((o.bvid && existing.bvid !== o.bvid) || (o.aid && existing.aid !== o.aid)) {
    return { ok: false, raw: { error: "archive identity mismatch; refusing to append" } };
  }
  if (o.mustContain !== undefined && (!Array.isArray(o.mustContain)
    || Array.from(o.mustContain).some((nativeKey) => typeof nativeKey !== "string"
      || nativeKey.trim().length === 0
      || !existing.videos.some((video) => video.filename === nativeKey)))) {
    return { ok: false, raw: { error: "required native predecessor is missing or invalid; refusing to append" } };
  }
  if (existing.videos.some((v) => v.filename === o.video.filename)) {
    return { ok: true, aid: existing.aid, ...(existing.bvid ? { bvid: existing.bvid } : {}), raw: { idempotent: true }, archive: existing };
  }
  const videos: StudioInput["videos"] = [...existing.videos, o.video].map((v) => ({
    ...(v.cid ? { cid: String(v.cid) } : {}),
    filename: v.filename,
    ...(v.title ? { title: v.title } : {}),
    ...(v.desc ? { desc: v.desc } : {}),
  }));
  const submitted = await submitStudio({
    cookiesPath: o.cookiesPath,
    title: existing.title,
    tid: existing.tid,
    tag: existing.tag,
    ...(existing.desc ? { desc: existing.desc } : {}),
    private: existing.private,
    videos,
    aid: existing.aid,
    ...(o.fetchImpl ? { fetchImpl: o.fetchImpl } : {}),
  });
  return {
    ...submitted,
    archive: {
      ...existing,
      videos: [
        ...existing.videos,
        {
          ...(o.video.cid ? { cid: o.video.cid } : {}),
          filename: o.video.filename,
          ...(o.video.title ? { title: o.video.title } : {}),
          ...(o.video.desc ? { desc: o.video.desc } : {}),
        },
      ],
    },
  };
}
