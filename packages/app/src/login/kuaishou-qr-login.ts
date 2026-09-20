/**
 * app/login/kuaishou-qr-login.ts — Kuaishou PC web QR login (pure fetch).
 *
 * 快手没有 B 站那种官方公开的登录 API，这里参考 wilsonwussd/KSQRcode 逆向出的
 * id.kuaishou.com 扫码链路，用原生 fetch + 手动 cookie jar 实现，不依赖 Playwright：
 *   1. POST /rest/c/infra/ks/qr/start → imageData(base64 PNG) + qrLoginToken/Signature
 *   2. 轮询 /rest/c/infra/ks/qr/scanResult，直到 result == 1
 *   3. acceptResult → pass/kuaishou/login/qr/callback → verifyToken 换取登录态
 * 返回的是 "k=v; k=v" cookie 串（did/userId/kuaishou.web.cp.api_st/passToken 等）。
 */
import type { QrLogin, QrPollResult, QrStartResult } from "./qr-login.js";

const QR_START = "https://id.kuaishou.com/rest/c/infra/ks/qr/start";
const QR_SCAN = "https://id.kuaishou.com/rest/c/infra/ks/qr/scanResult";
const QR_ACCEPT = "https://id.kuaishou.com/rest/c/infra/ks/qr/acceptResult";
const QR_CALLBACK = "https://id.kuaishou.com/pass/kuaishou/login/qr/callback";
const VERIFY_TOKEN = "https://www.kuaishou.com/account/login/api/verifyToken";

const UA =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 " +
  "(KHTML, like Gecko) Chrome/126.0.0.0 Safari/537.36";

const FORM_HEADERS: Record<string, string> = {
  "User-Agent": UA,
  Accept: "application/json, text/plain, */*",
  "Accept-Language": "zh-CN,zh;q=0.9",
  Origin: "https://id.kuaishou.com",
  Referer: "https://id.kuaishou.com/",
  "Content-Type": "application/x-www-form-urlencoded; charset=UTF-8",
};

export interface KuaishouQrLoginOpts {
  sessionTtlMs?: number;
  log?: (m: string) => void;
  fetch?: typeof fetch;
}

interface ScanJson { result?: number; [k: string]: unknown }

/** Extract first-party cookies from a fetch Headers object into map. */
function absorbSetCookies(headers: Headers, jar: Map<string, string>): void {
  const list = (headers as { getSetCookie?: () => string[] }).getSetCookie?.() ?? [];
  for (const header of list) {
    const first = header.split(";", 1)[0]?.trim() ?? "";
    const eq = first.indexOf("=");
    if (eq <= 0) continue;
    const name = first.slice(0, eq).trim();
    const value = first.slice(eq + 1).trim();
    if (name && value) jar.set(name, value);
  }
}

async function parseJson(res: Response): Promise<Record<string, unknown>> {
  const text = await res.text();
  if (!text) return {};
  try {
    return JSON.parse(text) as Record<string, unknown>;
  } catch {
    throw new Error(`快手登录响应不是 JSON (HTTP ${res.status}): ${text.slice(0, 80)}`);
  }
}

/** Kuaishou PC web QR login. Not official; endpoints can change. */
export class KuaishouQrLogin implements QrLogin {
  private readonly ttlMs: number;
  private readonly log: (m: string) => void;
  private readonly fetchImpl: typeof fetch;

  private cookies = new Map<string, string>();
  private qrLoginToken: string | null = null;
  private qrLoginSignature: string | null = null;
  private startedAt = 0;
  private closed = false;

  constructor(opts: KuaishouQrLoginOpts = {}) {
    this.ttlMs = opts.sessionTtlMs ?? 4 * 60_000;
    this.log = opts.log ?? ((): void => {});
    this.fetchImpl = opts.fetch ?? fetch;
  }

  async start(): Promise<QrStartResult> {
    if (this.qrLoginToken) throw new Error("KuaishouQrLogin.start() 已调用过");
    const res = await this.fetchImpl(QR_START, {
      method: "POST",
      headers: { ...FORM_HEADERS },
      body: new URLSearchParams({ sid: "kuaishou.web.cp.api" }),
    });
    absorbSetCookies(res.headers, this.cookies);
    const json = await parseJson(res);
    const imageData = String(json.imageData ?? "");
    const token = String(json.qrLoginToken ?? "");
    const signature = String(json.qrLoginSignature ?? "");
    if (!imageData || !token || !signature) {
      throw new Error(`快手二维码获取失败: ${JSON.stringify(json).slice(0, 160)}`);
    }
    this.qrLoginToken = token;
    this.qrLoginSignature = signature;
    this.startedAt = Date.now();
    this.log("[kuaishou-login] QR start OK");
    return { qrPng: imageData };
  }

  async poll(): Promise<QrPollResult> {
    if (this.closed || !this.qrLoginToken) return { state: "expired" };
    if (Date.now() - this.startedAt > this.ttlMs) {
      this.closed = true;
      return { state: "expired" };
    }
    const json = await this.postForm(QR_SCAN, {
      qrLoginToken: this.qrLoginToken!,
      qrLoginSignature: this.qrLoginSignature!,
    });
    if (json.result === 1) {
      const cookie = await this.finishLogin();
      this.closed = true;
      return { state: "confirmed", cookie };
    }
    // result 只有 1 表确认；0/其他都按待扫码处理（快手没返回稳定的 scanned 状态）。
    return { state: "pending" };
  }

  async cancel(): Promise<void> {
    this.closed = true;
  }

  private async finishLogin(): Promise<string> {
    const accept = await this.postForm(QR_ACCEPT, {
      qrLoginToken: this.qrLoginToken ?? "",
      qrLoginSignature: this.qrLoginSignature ?? "",
      sid: "kuaishou.web.cp.api",
    });
    const qrToken = String(accept.qrToken ?? "");
    if (!qrToken) throw new Error("快手扫码 acceptResult 未返回 qrToken");

    const callback = await this.postForm(QR_CALLBACK, { qrToken, sid: "kuaishou.web.cp.api" });
    const authToken = String(callback["kuaishou.web.cp.api.at"] ?? callback.authToken ?? "");
    if (!authToken) throw new Error("快手扫码 callback 未返回 authToken");

    await this.postJson(VERIFY_TOKEN, { authToken, sid: "kuaishou.web.cp.api" });
    const cookie = this.cookieString();
    if (!/kuaishou\.web\.cp\.api_st=|passToken=|userId=/.test(cookie)) {
      throw new Error("快手扫码完成但未取到有效 cookie");
    }
    return cookie;
  }

  private cookieString(): string {
    return [...this.cookies].map(([k, v]) => `${k}=${v}`).join("; ");
  }

  private async postForm(url: string, data: Record<string, string>): Promise<Record<string, unknown>> {
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: { ...FORM_HEADERS, Cookie: this.cookieString() },
      body: new URLSearchParams(data),
    });
    absorbSetCookies(res.headers, this.cookies);
    return parseJson(res);
  }

  private async postJson(url: string, data: Record<string, string>): Promise<Record<string, unknown>> {
    const res = await this.fetchImpl(url, {
      method: "POST",
      headers: {
        ...FORM_HEADERS,
        Cookie: this.cookieString(),
        "Content-Type": "application/json",
        Origin: "https://www.kuaishou.com",
        Referer: "https://www.kuaishou.com/",
      },
      body: JSON.stringify(data),
    });
    absorbSetCookies(res.headers, this.cookies);
    return parseJson(res);
  }
}
