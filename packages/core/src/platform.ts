/**
 * core/platform.ts — 直播平台一等抽象 + 注册表。
 *
 * 把「某平台专属」的能力(URL 互转 / 房间 slug 提取 / 短链解析 / 主播名解析 / 默认 provider
 * 与画质)收进一个 `Platform` 实现。新增平台 = 写一个 `<平台>-core` 实现 + 注册一行,
 * 通用层(cli/app/manager)按平台派发,不再硬编码 "live.douyin.com" 等字面量。
 *
 * 本模块只依赖类型,无重依赖;平台实现(douyin)放各自 `<平台>-core`,注册放 CLI 入口
 * (providers-register,副作用)。
 */

import type { DanmuSource, RecordOpts } from "./types.js";

/** connectDanmu 入参:够弹幕子类解析本场连接 id(roomUrl/channelId) + cookie 白名单过滤(opts.cookies)。 */
export interface DanmuConnectOpts {
  /** 规范直播 URL(子类用它解析本场 liveId)。 */
  roomUrl: string;
  /** 房间 slug(= platform.extractRoomSlug(roomUrl);备用)。 */
  channelId: string;
  /** 录制选项(cookie 等;弹幕 WS 白名单过滤用)。 */
  opts: RecordOpts;
}

/** 取流探测结果(平台无关):是否在播 + 当前可录制流 URL + 主播/标题 + 平台专属原始数据。 */
export interface PlatformStream {
  living: boolean;
  /** 当前可录制流 URL(living 且取到才有)。 */
  url?: string;
  owner?: string;
  title?: string;
  /** 拉流所需 HTTP 头(平台专属,如 bilibili CDN 要 Referer/UA,缺则 403);录制器(ffmpeg/mesio)透传。 */
  headers?: Record<string, string>;
  /** 平台专属原始结果(子类按需用,如 douyin 的 logStreamMeta);平台无关层不碰。 */
  raw?: unknown;
}

/** 一个直播平台的能力契约。 */
export interface Platform {
  /** 平台 id,如 "douyin"。 */
  id: string;
  /** 是否识别此 URL 属于本平台(用于按 URL 反查平台)。 */
  matchUrl(url: string): boolean;
  /** matchUrl 的**可序列化**正则源(供前端按 URL 客户端判平台用;应与 matchUrl 同源)。 */
  urlPattern?: string;
  /** 房间号或 URL → 本平台规范直播 URL。 */
  roomToUrl(room: string): string;
  /** URL / 房间号 → 平台内部房间 id(slug);短链需先 resolveShortUrl。 */
  extractRoomSlug(url: string): string;
  /** 短链 → 房间 id(本平台无短链则省略)。 */
  resolveShortUrl?(url: string): Promise<string | null>;
  /** 匿名解析主播名(失败返 null)。 */
  fetchAnchorName(room: string): Promise<string | null>;
  /**
   * 取流:living + 当前流 URL + 主播/标题 + headers。录制器轮询开播用。
   *
   * `cookies` 是**所有平台统一的可选入参**(通用层从任务 cookie 透传过来),由各平台**自行决定用不用**——
   * 不是平台轴的契约,而是每个平台的实现选择:
   *   - 抖音:**故意忽略**(保持匿名取流;传会话 cookie 其 enter API 会异地登录踢手机主号);
   *   - bilibili:**可用**(带 Cookie 头取大会员/高画质流;不带则匿名取基础画质)。
   * 未来某平台需要登录态才能取流时,无需改接口——直接在自己的 getStream 里读 cookies 即可。
   */
  getStream(channelId: string, quality: string, cookies?: string): Promise<PlatformStream>;
  /** 轻量权威判活(drain 收播判定 / 重连 / API 可达性);失败应抛错(由调用方按场景兜底)。 */
  getLiving(channelId: string): Promise<boolean>;
  /**
   * 连接本平台弹幕,返回一个**未 start** 的 DanmuSource(manager 负责 start/stop)。
   * 返回 null = 本平台无弹幕能力(如 bilibili 尚未实现)。弹幕的「按名查 provider」注册表
   * 已废弃 —— 弹幕实现归各平台 core(抖音见 @drec/douyin-live 的 connectDanmu)。
   */
  connectDanmu?(o: DanmuConnectOpts): DanmuSource | null;
  /**
   * 录制前探测房间流信息(可选;CLI `probe` 命令经此走接口,不再硬编码某平台)。返回平台专属
   * 形状(抖音=各档画质分辨率/码率/编码 + 横竖屏 + 设备);无能力则省略。
   */
  probe?(channelId: string): Promise<unknown>;
  /** 默认画质档(平台自解释字符串)。 */
  defaultQuality: string;
  /** 默认下载引擎 id(ffmpeg / mesio)。 */
  defaultEngine: string;
  /** 本平台可用的画质档(校验、列举用)。 */
  qualities: readonly string[];
  /** 本平台可用的下载引擎 id(校验、列举用;= core/engine 注册表里的 id)。 */
  engines: readonly string[];
}

const platforms = new Map<string, Platform>();
let defaultId: string | undefined;

/** 注册平台;首个注册的(或显式 default)成为默认平台。 */
export function registerPlatform(p: Platform, opts?: { default?: boolean }): void {
  platforms.set(p.id, p);
  if (opts?.default || defaultId === undefined) defaultId = p.id;
}

export function getPlatform(id: string): Platform | undefined {
  return platforms.get(id);
}

export function listPlatforms(): Platform[] {
  return [...platforms.values()];
}

/** 按 URL 反查平台(无命中返 undefined)。 */
export function matchPlatform(url: string): Platform | undefined {
  return [...platforms.values()].find((p) => p.matchUrl(url));
}

/** 默认平台(未注册任何平台时抛错)。 */
export function defaultPlatform(): Platform {
  const p = defaultId ? platforms.get(defaultId) : undefined;
  if (!p) throw new Error("[platform] 未注册任何平台(应在入口 registerPlatform)");
  return p;
}

/** 解析房间输入(URL 或裸房间号)→ 命中平台;URL 无命中或裸房间号回落默认平台。 */
export function platformForRoom(room: string): Platform {
  if (/^https?:\/\//.test(room)) return matchPlatform(room) ?? defaultPlatform();
  return defaultPlatform(); // 裸房间号无从判别平台 → 默认平台
}

/** 仅供测试:清空注册表。 */
export function _resetPlatforms(): void {
  platforms.clear();
  defaultId = undefined;
}
