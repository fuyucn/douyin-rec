import { spawn } from "node:child_process";
import { existsSync, readFileSync } from "node:fs";
import { registerChild, throwIfAborted } from "@drec/core";
import { rootYouTubeSecrets, rootYouTubeToken } from "../paths.js";

/** youtubeuploader 二进制:优先 PATH,可用 YOUTUBEUPLOADER_BIN 覆盖。 */
export const DEFAULT_YOUTUBE_BIN = process.env.YOUTUBEUPLOADER_BIN ?? "youtubeuploader";
/** OAuth client_secrets.json;可用 YOUTUBE_CLIENT_SECRETS 覆盖。 */
export const DEFAULT_YOUTUBE_SECRETS = process.env.YOUTUBE_CLIENT_SECRETS ?? rootYouTubeSecrets();
/** OAuth token 缓存(request.token);可用 YOUTUBE_REQUEST_TOKEN 覆盖。 */
export const DEFAULT_YOUTUBE_TOKEN = process.env.YOUTUBE_REQUEST_TOKEN ?? rootYouTubeToken();

export type YoutubeVisibility = "private" | "unlisted" | "public";

export interface YoutubeUploadOpts {
  video: string;
  title: string;
  /** 绝对路径;省略回落 DEFAULT_YOUTUBE_SECRETS。 */
  secrets?: string;
  /** token 缓存路径;省略回落 DEFAULT_YOUTUBE_TOKEN。 */
  cache?: string;
  /** youtubeuploader 可执行文件;省略回落 DEFAULT_YOUTUBE_BIN。 */
  bin?: string;
  description?: string;
  tags?: string[];
  categoryId?: string;
  /** 默认 private（安全默认，和 Google 未审核项目行为一致）。 */
  visibility?: YoutubeVisibility;
  /** 默认 false，避免自动通知订阅者。 */
  notifySubscribers?: boolean;
  language?: string;
  /** 静默进度条；CLI 默认 true，避免输出被进度符刷屏。 */
  quiet?: boolean;
  oAuthPort?: number;
  /** 非交互服务默认要求 request.token 已存在;首次授权用 youtubeuploader 二进制直接做。 */
  requireToken?: boolean;
}

export interface YoutubeUploadResult {
  videoId: string;
  url: string;
}

/** 构造 youtubeuploader 参数（纯函数）。 */
export function buildYoutubeArgs(o: YoutubeUploadOpts): string[] {
  const args = [
    "-filename", o.video,
    "-title", o.title,
    "-secrets", o.secrets ?? DEFAULT_YOUTUBE_SECRETS,
    "-cache", o.cache ?? DEFAULT_YOUTUBE_TOKEN,
    "-privacy", o.visibility ?? "private",
    "-language", o.language ?? "en",
    "-notify", o.notifySubscribers === true ? "true" : "false",
    "-sendFilename", "false",
  ];
  if (o.description?.trim()) args.push("-description", o.description.trim());
  if (o.tags?.length) args.push("-tags", o.tags.join(","));
  if (o.categoryId?.trim()) args.push("-categoryId", o.categoryId.trim());
  if (o.quiet ?? true) args.push("-quiet");
  if (o.oAuthPort) args.push("-oAuthPort", String(o.oAuthPort));
  return args;
}

/** 从 youtubeuploader stdout 抓 Video ID。 */
export function parseYoutubeVideoId(out: string): string | null {
  const m = out.match(/Video ID:\s*([A-Za-z0-9_-]{11})/);
  return m ? m[1] : null;
}

/** client_secrets.json 基础结构校验;错误返回文本,null = OK。 */
export function validateYoutubeSecretsFile(path: string): string | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    const node = (raw.web ?? raw.installed) as Record<string, unknown> | undefined;
    if (!node) return `client_secrets 结构不完整: ${path}(缺 web/installed 段)`;
    if (typeof node.client_id !== "string" || node.client_id.trim().length === 0) return `client_secrets 缺 client_id: ${path}`;
    if (typeof node.client_secret !== "string" || node.client_secret.trim().length === 0) return `client_secrets 缺 client_secret: ${path}`;
    return null;
  } catch (e) {
    return `client_secrets 无法解析: ${path}(${String((e as Error)?.message ?? e)})`;
  }
}

/** request.token 结构校验;需要 refresh_token(后续服务器端自动刷新要靠它)。 */
export function validateYoutubeTokenFile(path: string): string | null {
  try {
    const raw = JSON.parse(readFileSync(path, "utf-8")) as Record<string, unknown>;
    const refresh = raw.refresh_token;
    if (typeof refresh !== "string" || refresh.trim().length === 0) {
      return `request.token 缺 refresh_token: ${path}(请先完成 pnpm youtubeuploader:auth)`;
    }
    return null;
  } catch (e) {
    return `request.token 无法解析: ${path}(${String((e as Error)?.message ?? e)})`;
  }
}

/** 预检：二进制可执行 + client_secrets 存在 + 视频文件存在。返回错误信息或 null。 */
export function checkYoutube(
  o: { bin?: string; secrets?: string; cache?: string; video?: string; requireToken?: boolean } = {},
): Promise<string | null> {
  return new Promise((resolve) => {
    const bin = o.bin ?? DEFAULT_YOUTUBE_BIN;
    const secrets = o.secrets ?? DEFAULT_YOUTUBE_SECRETS;
    const cache = o.cache ?? DEFAULT_YOUTUBE_TOKEN;
    if (!existsSync(secrets)) {
      resolve(`youtube client_secrets 不存在: ${secrets}（先按 plans/024_youtube_upload.md 配置 OAuth）`);
      return;
    }
    const secretsErr = validateYoutubeSecretsFile(secrets);
    if (secretsErr) { resolve(secretsErr); return; }
    if (o.requireToken ?? true) {
      if (!existsSync(cache)) {
        resolve(`youtube request.token 不存在: ${cache}（先在本机用 youtubeuploader 完成 OAuth 授权，再把 token 复制到远端）`);
        return;
      }
      const tokenErr = validateYoutubeTokenFile(cache);
      if (tokenErr) { resolve(tokenErr); return; }
    }
    if (o.video && !existsSync(o.video)) {
      resolve(`视频文件不存在: ${o.video}`);
      return;
    }
    const p = spawn(bin, ["-version"]);
    p.on("error", () => resolve(`youtubeuploader 命令未找到（请先安装：scripts/install-youtubeuploader.sh）`));
    p.on("close", (code) => resolve(code === 0 ? null : "youtubeuploader -version 非零退出"));
  });
}

/** 底层：spawn youtubeuploader argv，收集 stdout+stderr，非零退出抛错。 */
export function runYoutubeUploader(argv: string[], bin = DEFAULT_YOUTUBE_BIN): Promise<string> {
  return new Promise((resolve, reject) => {
    const p = spawn(bin, argv);
    registerChild(p);
    let out = "", err = "";
    const appendTail = (current: string, c: Buffer): string => (current + String(c)).slice(-65536);
    p.stdout.on("data", (c: Buffer) => (out = appendTail(out, c)));
    p.stderr.on("data", (c: Buffer) => (err = appendTail(err, c)));
    p.on("error", reject);
    p.on("close", (code) => {
      try { throwIfAborted(); } catch (e) { reject(e); return; }
      if (code !== 0) {
        reject(new Error(`youtubeuploader 失败 (rc=${code}): ${(err || out).slice(-2000).trim()}`));
        return;
      }
      resolve(out + err);
    });
  });
}

/** 上传单个 mp4 到 YouTube，返回视频 ID 和 URL（解析不到则抛错）。 */
export async function uploadYoutube(o: YoutubeUploadOpts): Promise<YoutubeUploadResult> {
  const pre = await checkYoutube({ bin: o.bin, secrets: o.secrets, cache: o.cache, video: o.video, requireToken: o.requireToken });
  if (pre) throw new Error(pre);
  const out = await runYoutubeUploader(buildYoutubeArgs(o), o.bin ?? DEFAULT_YOUTUBE_BIN);
  const videoId = parseYoutubeVideoId(out);
  if (!videoId) throw new Error(`youtubeuploader 上传完成但解析不到 Video ID：${out.slice(-300).trim()}`);
  return { videoId, url: `https://youtu.be/${videoId}` };
}
