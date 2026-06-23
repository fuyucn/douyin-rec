/**
 * danmu.ts — bilibili 直播弹幕 DanmuSource(独立 WS 协议,与抖音无关)。
 *
 * 流程(协议见 ws-codec.ts / wbi.ts):
 *   1. nav 拿 WBI key → WBI 签名 getDanmuInfo → token + host_list(WS 接入点)。
 *   2. wss://{host}:{wss_port}/sub 连接 → 发鉴权帧(op=7,uid=0 匿名)→ 30s 心跳(op=2)。
 *   3. 收 op=5 帧(protover 2/3 需 inflate/brotli 解压,内含拼接帧)→ mapCmdToDanmu → onMessage。
 *
 * 健康/生命周期对齐抖音 ListenerDanmuSource:token 失败 / WS error / 连上 3 分钟 0 条 → onAlert;
 * 会话内 WS 意外断开自动重连(有限次退避);stop() 清掉所有 timer(心跳/看门狗/重连)并禁止再连。
 *
 * 只用 Node 内置(全局 WebSocket、node:zlib、node:crypto)→ 无新依赖,bilibili-live 仍可被 vitest import。
 */
import { createLogger, type DanmuSource, type RecordOpts, type DanmuMessage } from "@drec/core";
import { encWbi, getMixinKey, keysFromWbiImg } from "./wbi.js";

const log = createLogger("danmaku_recorder");
import {
  encodeAuth,
  encodeHeartbeat,
  mapCmdToDanmu,
  parseFrames,
  OP,
} from "./ws-codec.js";

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0 Safari/537.36";
const COMMON_HEADERS = { "User-Agent": UA, Referer: "https://live.bilibili.com/", Accept: "application/json" };

/** 「连上却 0 消息」看门狗阈值(对齐抖音):有人互动的房间 3 分钟应至少有进场/弹幕。 */
const SILENT_MS = 180_000;
const HEARTBEAT_MS = 30_000;
const MAX_RECONNECT = 5;
const FALLBACK_HOST = { host: "broadcastlv.chat.bilibili.com", wss_port: 443 };

interface DanmuInfo {
  token: string;
  hosts: { host: string; wss_port: number }[];
}

/** nav → WBI key;失败抛错(交调用方告警)。 */
async function fetchWbiKeys(): Promise<{ imgKey: string; subKey: string }> {
  const res = await fetch("https://api.bilibili.com/x/web-interface/nav", { headers: COMMON_HEADERS });
  const json = (await res.json()) as { data?: { wbi_img?: { img_url?: string; sub_url?: string } } };
  const wbi = json.data?.wbi_img;
  if (!wbi?.img_url || !wbi?.sub_url) throw new Error("nav 无 wbi_img");
  return keysFromWbiImg(wbi.img_url, wbi.sub_url);
}

/** WBI 签名 getDanmuInfo → token + WS host_list。 */
async function fetchDanmuInfo(realRoomId: string): Promise<DanmuInfo> {
  const { imgKey, subKey } = await fetchWbiKeys();
  const mixinKey = getMixinKey(imgKey, subKey);
  const query = encWbi({ id: realRoomId, type: 0, web_location: "444.8" }, mixinKey);
  const res = await fetch(
    `https://api.live.bilibili.com/xlive/web-room/v1/index/getDanmuInfo?${query}`,
    { headers: COMMON_HEADERS },
  );
  const json = (await res.json()) as {
    code?: number;
    data?: { token?: string; host_list?: { host?: string; wss_port?: number }[] };
  };
  if (json.code !== 0 || !json.data?.token) throw new Error(`getDanmuInfo code=${json.code}`);
  const hosts = (json.data.host_list ?? [])
    .filter((h): h is { host: string; wss_port: number } => !!h.host && !!h.wss_port)
    .map((h) => ({ host: h.host, wss_port: h.wss_port }));
  return { token: json.data.token, hosts: hosts.length ? hosts : [FALLBACK_HOST] };
}

/**
 * bilibili 弹幕源。`resolveRealRoomId` 由工厂注入(委托 index.ts 的 get_info,避免重复 API)。
 * channelId 可能是短号 → 需先解析成真实 room_id 再签名 / 鉴权。
 */
export class BilibiliDanmuSource implements DanmuSource {
  readonly name = "bilibili-danmaku";

  /** 解析短号→真实数字 room_id(由工厂注入,委托 platform.get_info)。 */
  private readonly resolveRealRoomId: (channelId: string) => Promise<string>;

  private ws: WebSocket | null = null;
  private heartbeatTimer: ReturnType<typeof setInterval> | null = null;
  private silentTimer: ReturnType<typeof setTimeout> | null = null;
  private reconnectTimer: ReturnType<typeof setTimeout> | null = null;
  private stopped = false;
  private gotMsg = false;
  private msgCount = 0;
  private reconnects = 0;
  private wsErrorAlerted = false;

  // start() 时锁定的上下文(重连复用)。
  private realRoomId = "";
  private onMessage: (m: DanmuMessage) => void = () => {};
  private alert: (msg: string) => void = () => {};
  private roomUrl = "";

  constructor(resolveRealRoomId: (channelId: string) => Promise<string>) {
    this.resolveRealRoomId = resolveRealRoomId;
  }

  async start(
    roomUrl: string,
    _opts: RecordOpts,
    onMessage: (m: DanmuMessage) => void,
    onAlert?: (msg: string) => void,
  ): Promise<void> {
    this.stopped = false;
    this.roomUrl = roomUrl;
    this.onMessage = onMessage;
    this.alert = (msg: string): void => { try { onAlert?.(msg); } catch { /* ignore */ } };
    this.gotMsg = false;
    this.msgCount = 0;
    this.reconnects = 0;
    this.wsErrorAlerted = false;

    // channelId 形如 live.bilibili.com/{slug};这里直接用 roomUrl 末段做 slug 解析真实 room_id。
    const slug = roomUrl.match(/live\.bilibili\.com\/(\d+)/)?.[1] ?? roomUrl;

    let info: DanmuInfo;
    try {
      this.realRoomId = await this.resolveRealRoomId(slug);
      info = await fetchDanmuInfo(this.realRoomId);
    } catch (e) {
      const m = (e as Error)?.message ?? String(e);
      log.error(`${this.name} 拿不到弹幕 token:`, m);
      this.alert(`弹幕未启动:拿不到弹幕 token(${roomUrl}),整场无弹幕。${m}`);
      return; // 对齐抖音:解析失败不抛,本场不抓
    }

    this.connect(info);
  }

  /** 连一个 WS(失败/断开走重连)。fire-and-forget,不阻塞 start。 */
  private connect(info: DanmuInfo): void {
    if (this.stopped) return;
    const node = info.hosts[Math.min(this.reconnects, info.hosts.length - 1)] ?? FALLBACK_HOST;
    const url = `wss://${node.host}:${node.wss_port}/sub`;
    log.info(`${this.name} 连接 ${url} room=${this.realRoomId}`);

    let ws: WebSocket;
    try {
      ws = new WebSocket(url);
    } catch (e) {
      this.scheduleReconnect(info, (e as Error)?.message ?? String(e));
      return;
    }
    ws.binaryType = "arraybuffer";
    this.ws = ws;

    ws.addEventListener("open", () => {
      log.info(`${this.name} WS 已连接 room=${this.realRoomId}`);
      try {
        ws.send(encodeAuth(Number(this.realRoomId), info.token));
      } catch (e) {
        log.error(`${this.name} 发鉴权失败:`, (e as Error)?.message ?? e);
      }
      this.startHeartbeat();
    });

    ws.addEventListener("message", (ev: MessageEvent) => this.onWsData(ev.data));

    ws.addEventListener("error", () => {
      // WebSocket ErrorEvent 无可靠 message;仅去重告警一次(重连抖动会连发)。
      if (!this.wsErrorAlerted) {
        this.wsErrorAlerted = true;
        this.alert(`弹幕 WS 错误(后续重连错误不再重复告警)。room=${this.roomUrl}`);
      }
      log.error(`${this.name} WS error room=${this.realRoomId}`);
    });

    ws.addEventListener("close", () => {
      this.stopHeartbeat();
      if (this.stopped) return;
      log.info(`${this.name} WS 断开 room=${this.realRoomId}`);
      this.scheduleReconnect(info, "WS 关闭");
    });

    this.startSilentWatch();
  }

  private onWsData(data: unknown): void {
    let buf: Buffer;
    if (data instanceof ArrayBuffer) buf = Buffer.from(data);
    else if (Buffer.isBuffer(data)) buf = data;
    else if (ArrayBuffer.isView(data)) buf = Buffer.from(data.buffer, data.byteOffset, data.byteLength);
    else return;

    let frames;
    try {
      frames = parseFrames(buf);
    } catch (e) {
      log.error(`${this.name} 解帧失败:`, (e as Error)?.message ?? e);
      return;
    }
    for (const f of frames) {
      if (f.op !== OP.MESSAGE || !f.json) continue;
      const m = mapCmdToDanmu(f.json);
      if (!m) continue;
      this.gotMsg = true;
      if (++this.msgCount <= 3 || this.msgCount % 50 === 0)
        log.info(`${this.name} 第 ${this.msgCount} 条 [${m.kind}] ${m.user ?? ""}: ${m.content ?? m.giftName ?? ""}`);
      try {
        this.onMessage(m);
      } catch { /* 写盘失败不影响后续 */ }
    }
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      try {
        if (this.ws && this.ws.readyState === this.ws.OPEN) this.ws.send(encodeHeartbeat());
      } catch { /* ignore */ }
    }, HEARTBEAT_MS);
    this.heartbeatTimer.unref?.();
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) { clearInterval(this.heartbeatTimer); this.heartbeatTimer = null; }
  }

  private startSilentWatch(): void {
    if (this.silentTimer) return; // 整个会话只跑一次(重连不重置)
    this.silentTimer = setTimeout(() => {
      if (!this.gotMsg && !this.stopped) {
        const mins = Math.round(SILENT_MS / 60000);
        log.warn(`${this.name} ⚠️ 连上 ${mins} 分钟仍 0 条`);
        this.alert(`弹幕已连但 ${mins} 分钟 0 条(含进场):若房间有人互动则疑似 token 失效/被风控、本场可能无弹幕,请排查;冷清房间可忽略。room=${this.roomUrl}`);
      }
    }, SILENT_MS);
    this.silentTimer.unref?.();
  }

  private scheduleReconnect(info: DanmuInfo, reason: string): void {
    if (this.stopped || this.reconnectTimer) return;
    if (this.reconnects >= MAX_RECONNECT) {
      log.warn(`${this.name} 重连超 ${MAX_RECONNECT} 次,放弃(${reason})`);
      this.alert(`弹幕 WS 多次重连失败,本场后续无弹幕(${reason})。room=${this.roomUrl}`);
      return;
    }
    const delay = Math.min(2000 * 2 ** this.reconnects, 30_000);
    this.reconnects += 1;
    log.info(`${this.name} ${Math.round(delay / 1000)}s 后重连(第 ${this.reconnects} 次,因 ${reason})`);
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = null;
      this.connect(info);
    }, delay);
    this.reconnectTimer.unref?.();
  }

  async stop(): Promise<void> {
    this.stopped = true;
    this.stopHeartbeat();
    if (this.silentTimer) { clearTimeout(this.silentTimer); this.silentTimer = null; }
    if (this.reconnectTimer) { clearTimeout(this.reconnectTimer); this.reconnectTimer = null; }
    if (this.ws) {
      try { this.ws.close(); } catch { /* ignore */ }
      this.ws = null;
    }
  }
}
