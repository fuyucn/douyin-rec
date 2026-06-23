// 手写类型(只声明我们用到的 3 个函数 + 返回里我们读的字段),避免拖入 @bililive-tools/manager 类型链。
export interface StreamProfile { desc: string; key: string; bitRate: number }
export interface SourceProfile {
  name: string;
  streamMap?: Record<string, { main?: { flv?: string; hls?: string; sdk_params?: string } }>;
  streams?: Array<{ quality: string; name: string; flv?: string; hls?: string }>;
}
export interface GetStreamResult {
  currentStream: { name: string; source: string; url: string; onlyAudio: boolean };
  living: boolean;
  roomId: string;
  owner: string;
  title: string;
  streams: StreamProfile[];
  sources: SourceProfile[];
  avatar: string;
  cover: string;
  liveId: string;
  uid: string;
  api: string;
}
export interface GetInfoResult {
  living: boolean;
  owner: string;
  title: string;
  roomId: string;
  liveId: string;
  uid: string;
  api: string;
  area: string;
}
export function getStream(opts: {
  channelId: string;
  quality?: string;
  streamPriorities?: unknown[];
  sourcePriorities?: unknown[];
  formatPriorities?: Array<"flv" | "hls">;
  auth?: string;
  [k: string]: unknown;
}): Promise<GetStreamResult>;
export function getInfo(channelId: string, opts?: { auth?: string; [k: string]: unknown }): Promise<GetInfoResult>;
export function resolveShortURL(shortURL: string): Promise<string>;
