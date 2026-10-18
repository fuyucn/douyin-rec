// observability/src/notifier/hub-label.ts
// hub 通知的「人话化」:事件里只有 streamKey(`{platform}:{roomSlug}:{date}[_HHMM]`)/房间号,
// 在发送前补上主播名、日期、节点名,webhook 与站内 toast 共用同一份结果。纯函数,查表由调用方注入。
import { contextForStream, parseStreamKey, STREAM_KEY_SOURCE, type DisplayNameSources, type NotifyContext, type NotifyEvent, type ParsedStreamKey } from "@drec/core";

export interface HubLabelLookup {
  /** (platform, roomSlug) → 主播名;查不到返回 undefined。 */
  anchorOf: (platform: string, roomSlug: string) => string | undefined;
  /** workerId → 节点显示名;查不到返回 undefined(退回 id)。 */
  workerName: (id: string) => string | undefined;
  /** (platform, roomSlug) → raw name sources for the shared priority chain; optional (older lookups). */
  nameSourcesOf?: (platform: string, roomSlug: string) => Omit<DisplayNameSources, "platform" | "roomSlug"> | undefined;
}

/** Structured context for a hub session; an explicit `ctx` already on the event wins field by field. */
function streamCtx(streamKey: string, lookup: HubLabelLookup, own: NotifyContext | undefined): NotifyContext {
  const k = parseStreamKey(streamKey);
  const names = k
    ? lookup.nameSourcesOf?.(k.platform, k.roomSlug) ?? { cachedAnchor: lookup.anchorOf(k.platform, k.roomSlug) }
    : {};
  const derived = contextForStream(streamKey, names);
  // A caller-supplied name carries its own provenance; do not pair it with the derived source.
  if (own?.name !== undefined) delete derived.nameSource;
  return { ...derived, ...own };
}

export { parseStreamKey, type ParsedStreamKey } from "@drec/core";

// In free text a key must not be glued to a word/path/URL on the left (e.g. `http://host:8080/...`).
const EMBEDDED_KEY = `(?<![\\w/.-])${STREAM_KEY_SOURCE}`;

const dateText = (k: ParsedStreamKey): string => (k.time ? `${k.date} ${k.time}` : k.date);

/** 一场直播的人读标签:`主播名 · 2026-10-16`;主播名未知时用房间号。 */
export function describeStream(key: ParsedStreamKey, anchor: string | undefined): string {
  return `${anchor || key.roomSlug} · ${dateText(key)}`;
}

/** 把任意文本里出现的 streamKey 替换成人读标签(error 消息里到处内嵌原始 key)。 */
export function humanizeStreamKeys(text: string, lookup: HubLabelLookup): string {
  return text.replace(new RegExp(EMBEDDED_KEY, "g"), (raw) => {
    const k = parseStreamKey(raw);
    return k ? describeStream(k, lookup.anchorOf(k.platform, k.roomSlug)) : raw;
  });
}

/** 发送前补全 hub 相关事件(hubTaskStart/stageReady/uploadDone/error);其余事件原样返回。 */
export function enrichHubEvent(e: NotifyEvent, lookup: HubLabelLookup): NotifyEvent {
  switch (e.kind) {
    case "hubTaskStart": {
      const k = parseStreamKey(e.streamKey);
      return {
        ...e,
        anchor: lookup.anchorOf(k?.platform ?? "", e.room) || e.anchor,
        ...(k ? { date: dateText(k) } : {}),
        workerNames: e.workers.map((id) => lookup.workerName(id) || id),
        ctx: streamCtx(e.streamKey, lookup, e.ctx),
      };
    }
    case "stageReady":
    case "uploadDone": {
      const k = e.streamKey ? parseStreamKey(e.streamKey) : null;
      if (!k || !e.streamKey) return e;
      return {
        ...e,
        anchor: lookup.anchorOf(k.platform, k.roomSlug) || e.anchor || k.roomSlug,
        date: dateText(k),
        ctx: streamCtx(e.streamKey, lookup, e.ctx),
      };
    }
    case "error":
      return { ...e, message: humanizeStreamKeys(e.message, lookup) };
    default:
      return e;
  }
}
