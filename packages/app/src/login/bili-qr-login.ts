import QRCode from "qrcode";
import type { QrLogin, QrLoginState, QrPollResult, QrStartResult } from "./qr-login.js";

const GENERATE_URL = "https://passport.bilibili.com/x/passport-login/web/qrcode/generate?source=main-fe-header";
const POLL_URL = "https://passport.bilibili.com/x/passport-login/web/qrcode/poll";
const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

interface BiliEnvelope<T> {
  code: number;
  message?: string;
  data?: T;
}

interface GenerateData {
  url: string;
  qrcode_key: string;
}

interface PollData {
  code: number;
  message?: string;
}

export interface BiliQrLoginOpts {
  sessionTtlMs?: number;
  log?: (m: string) => void;
  fetch?: typeof fetch;
  qrPng?: (url: string) => Promise<string>;
}

/** B站二维码状态码 → 统一登录状态。 */
export function biliQrState(code: number): QrLoginState | null {
  if (code === 0) return "confirmed";
  if (code === 86038) return "expired";
  if (code === 86090) return "scanned";
  if (code === 86101) return "pending";
  return null;
}

/** 从 Set-Cookie 响应头提取第一方 Cookie，过滤属性并去重。 */
export function harvestBiliSetCookies(headers: readonly string[]): string | null {
  const pairs = new Map<string, string>();
  for (const header of headers) {
    const first = header.split(";", 1)[0]?.trim() ?? "";
    const eq = first.indexOf("=");
    if (eq <= 0) continue;
    const name = first.slice(0, eq).trim();
    const value = first.slice(eq + 1).trim();
    if (name && value) pairs.set(name, value);
  }
  return pairs.size > 0
    ? [...pairs].map(([name, value]) => `${name}=${value}`).join("; ")
    : null;
}

async function defaultQrPng(url: string): Promise<string> {
  const dataUrl = await QRCode.toDataURL(url, { margin: 1, width: 200, errorCorrectionLevel: "M" });
  const comma = dataUrl.indexOf(",");
  return comma >= 0 ? dataUrl.slice(comma + 1) : dataUrl;
}

/** B站官方 Web 二维码登录：无需 Playwright，成功后返回录制用 Cookie。 */
export class BiliQrLogin implements QrLogin {
  private readonly ttlMs: number;
  private readonly log: (m: string) => void;
  private readonly fetchImpl: typeof fetch;
  private readonly qrPngImpl: (url: string) => Promise<string>;
  private qrcodeKey: string | null = null;
  private startedAt = 0;
  private closed = false;
  private confirmedCookie: string | null = null;

  constructor(opts: BiliQrLoginOpts = {}) {
    this.ttlMs = opts.sessionTtlMs ?? 4 * 60_000;
    this.log = opts.log ?? ((): void => {});
    this.fetchImpl = opts.fetch ?? fetch;
    this.qrPngImpl = opts.qrPng ?? defaultQrPng;
  }

  async start(): Promise<QrStartResult> {
    if (this.qrcodeKey) throw new Error("BiliQrLogin.start() 已调用过");
    this.closed = false;
    const res = await this.fetchImpl(GENERATE_URL, {
      headers: { "user-agent": UA, referer: "https://www.bilibili.com/" },
    });
    if (!res.ok) throw new Error(`B站二维码生成失败: HTTP ${res.status}`);
    const body = (await res.json()) as BiliEnvelope<GenerateData>;
    if (body.code !== 0 || !body.data?.url || !body.data.qrcode_key) {
      throw new Error(`B站二维码生成失败: ${body.message ?? body.code}`);
    }
    this.qrcodeKey = body.data.qrcode_key;
    this.startedAt = Date.now();
    this.log("[bili-login] 已生成二维码");
    return { qrPng: await this.qrPngImpl(body.data.url) };
  }

  async poll(): Promise<QrPollResult> {
    if (this.confirmedCookie) return { state: "confirmed", cookie: this.confirmedCookie };
    if (this.closed || !this.qrcodeKey) return { state: "expired" };
    if (Date.now() - this.startedAt > this.ttlMs) {
      await this.cancel();
      return { state: "expired" };
    }

    const url = new URL(POLL_URL);
    url.searchParams.set("qrcode_key", this.qrcodeKey);
    url.searchParams.set("source", "main-fe-header");
    const res = await this.fetchImpl(url, {
      redirect: "manual",
      headers: { "user-agent": UA, referer: "https://www.bilibili.com/" },
    });
    if (!res.ok) throw new Error(`B站二维码轮询失败: HTTP ${res.status}`);
    const body = (await res.json()) as BiliEnvelope<PollData>;
    if (body.code !== 0 || !body.data) return { state: "expired" };

    const state = biliQrState(body.data.code);
    if (!state) throw new Error(`B站二维码未知状态: ${body.data.code} ${body.data.message ?? ""}`.trim());
    if (state !== "confirmed") return { state };

    const cookie = harvestBiliSetCookies(res.headers.getSetCookie());
    if (!cookie) throw new Error("B站扫码成功，但响应中没有 Cookie");
    this.confirmedCookie = cookie;
    this.log(`[bili-login] 登录成功，已获取 Cookie（${cookie.length} 字符）`);
    await this.cancel();
    return { state: "confirmed", cookie };
  }

  async cancel(): Promise<void> {
    this.closed = true;
    this.qrcodeKey = null;
  }
}
