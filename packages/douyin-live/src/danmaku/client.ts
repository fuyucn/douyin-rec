/**
 * client.ts — 抖音直播弹幕 WS 客户端(@drec/douyin-live 自有 TS 实现)。
 *
 * 参考(非复制)上游 `douyin-danma-listener@0.4.1`(作者 renmu123,亦即 biliLive-tools 的
 * DouYinDanma 包)重写为我们自己的干净 TS,按本项目需求裁剪 + 修上游遗留问题:
 *   - 帧级解码/解压失败 = 静默丢该帧,**不 emit("error")** —— 上游对开播时的非 gzip 控制帧
 *     gunzip 失败也 emit 连接错误(日志刷 "incorrect header check"、污染弹幕健康告警)。
 *     只有真正的连接级错误(ws error / connect 失败)才 emit("error")。
 *   - 注:消息帧本就是 gzip,**必须无条件 gunzip**;别按 payloadEncoding 门控(实测消息帧该字段
 *     非 "gzip",门控会把消息帧全跳过 → 0 弹幕,已被真实录制证伪)。
 * 并且只解我们消费的三类消息(chat/gift/member),其余(like/social/roomStats…)忽略。
 *
 * 仍依赖两块无法重写的 vendored:`./proto.js`(pbjs 生成的消息 schema)+ `./webmssdk.js`
 * (a_bogus 签名,逆向 sdk)。签名参数(sigParams / webcast5Params)逐字沿用上游,改动即废签名。
 */
import WebSocket from "ws";
import { TypedEmitter } from "tiny-typed-emitter";
import { gunzipSync } from "node:zlib";
import crypto from "node:crypto";
import { douyin } from "./proto.js";
import { get_sign } from "./webmssdk.js";
import { fetchGuestCookie } from "./danmu-cookie.js";

/** 消息体最小形状(client.ts 消费 + listener-base 归一化用到的字段)。 */
export interface DyUser {
  id: string;
  nickName: string;
}
export interface DyChatMessage {
  user: DyUser;
  content: string;
  eventTime: string;
}
export interface DyGiftMessage {
  user: DyUser;
  gift: { name: string; diamondCount: number };
  totalCount: string;
  sendTime: string;
}
export interface DyMemberMessage {
  user: DyUser;
}

/** 客户端对外事件(只保留我们消费的;listener-base 监听这 6 个)。 */
interface ClientEvents {
  open: () => void;
  close: () => void;
  error: (err: Error) => void;
  chat: (m: DyChatMessage) => void;
  gift: (m: DyGiftMessage) => void;
  member: (m: DyMemberMessage) => void;
}

export interface DanmaClientOptions {
  autoStart?: boolean;
  autoReconnect?: number;
  heartbeatInterval?: number;
  reconnectInterval?: number;
  timeoutInterval?: number;
  cookie?: string;
  host?: string;
}

// ── 假设备 ID(防踢补丁,原样保留)──────────────────────────────────────────────
// user_unique_id = 弹幕 WS 拼接的「假设备 ID」。若每次连接都随机生成,流重连/弹幕重启会让同一
// 会话 cookie 不断换设备指纹 → 抖音判「同账号多端异地登录」→ 踢手机主号。修复:同一 cookie 确定性
// 派生固定 ID(进程内 + 跨重连一致 = 抖音眼中「同一设备重连」,不踢);匿名时随机但进程内 memoize。
const UID_MIN = 7300000000000000000n;
const UID_SPAN = 7999999999999999999n - UID_MIN;
let anonUid: string | undefined;
function getUserUniqueId(seed: string | undefined): string {
  if (seed) {
    const h = crypto.createHash("sha256").update(String(seed)).digest();
    return ((h.readBigUInt64BE(0) % UID_SPAN) + UID_MIN).toString();
  }
  if (anonUid === undefined) {
    anonUid = (BigInt(Math.floor(Math.random() * Number(UID_SPAN))) + UID_MIN).toString();
  }
  return anonUid;
}

/** 签名前的 md5 stub:把签名参数拼成 `k=v,k=v` 再 md5(上游 getXMsStub)。 */
function getXMsStub(params: Record<string, string | number>): string {
  const s = Object.entries(params)
    .map(([k, v]) => `${k}=${v}`)
    .join(",");
  return crypto.createHash("md5").update(s).digest("hex");
}

/** a_bogus 签名(webmssdk.get_sign);失败回落 "00000000"(上游同款兜底)。 */
function getSignature(xMsStub: string): string {
  try {
    return String(get_sign(xMsStub));
  } catch {
    return "00000000";
  }
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36";

/**
 * 抖音弹幕 WS 客户端。`roomId` 必须是本场直播的 **liveId**(不是房间 web_rid/slug,
 * 传 slug 能连上却收不到弹幕 —— 见 listener-base 注释)。事件:open/close/error/chat/gift/member。
 */
export class DouYinDanmaClient extends TypedEmitter<ClientEvents> {
  private ws: WebSocket | undefined;
  private readonly roomId: string;
  private readonly heartbeatInterval: number;
  private readonly autoReconnect: number;
  private readonly reconnectInterval: number;
  private readonly timeoutInterval: number;
  private readonly cookie: string | undefined;
  private readonly host: string;

  private reconnectAttempts = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private timeoutTimer: ReturnType<typeof setInterval> | undefined;
  private lastMessageTime = Date.now();
  private isReconnecting = false;
  /** close() 主动关闭后置 true,阻止 close/error 触发的自动重连。 */
  private closed = false;

  constructor(roomId: string, options: DanmaClientOptions = {}) {
    super();
    this.roomId = roomId;
    this.heartbeatInterval = options.heartbeatInterval ?? 10_000;
    this.autoReconnect = options.autoReconnect ?? 10;
    this.reconnectInterval = options.reconnectInterval ?? 10_000;
    this.timeoutInterval = options.timeoutInterval ?? 100_000;
    this.cookie = options.cookie;
    this.host = options.host ?? "webcast100-ws-web-hl.douyin.com";
    if (options.autoStart) void this.connect();
  }

  async connect(): Promise<void> {
    const url = await this.getWsInfo(this.roomId);
    if (!url) {
      this.emit("error", new Error("获取抖音弹幕签名失败"));
      return;
    }
    const cookie = this.cookie || (await fetchGuestCookie());
    const ws = new WebSocket(url, {
      headers: {
        Cookie: cookie,
        "User-Agent": UA,
        Origin: "https://live.douyin.com",
        Referer: "https://live.douyin.com/",
      },
    });
    this.ws = ws;

    ws.on("open", () => {
      this.reconnectAttempts = 0;
      this.emit("open");
      this.startHeartbeat();
      this.startTimeoutCheck();
    });
    ws.on("message", (data: WebSocket.RawData) => {
      this.lastMessageTime = Date.now();
      this.decode(data as Buffer);
    });
    ws.on("close", () => {
      this.emit("close");
      this.reconnect();
    });
    ws.on("error", (err: Error) => {
      // 连接级错误 → 上报 + 重连。(帧级解码失败不会走到这里,见 decode。)
      this.emit("error", err);
      this.reconnect();
    });
  }

  private send(data: string | Uint8Array): void {
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.send(data);
  }

  close(): void {
    this.closed = true;
    this.stopHeartbeat();
    this.stopTimeoutCheck();
    if (this.ws && this.ws.readyState === WebSocket.OPEN) this.ws.close();
  }

  private startHeartbeat(): void {
    this.stopHeartbeat();
    this.heartbeatTimer = setInterval(() => {
      this.send(":\x02hb");
    }, this.heartbeatInterval);
  }

  private stopHeartbeat(): void {
    if (this.heartbeatTimer) {
      clearInterval(this.heartbeatTimer);
      this.heartbeatTimer = undefined;
    }
  }

  /** 长时间无任何消息 → 疑似连接僵死,主动重连(配合心跳)。 */
  private startTimeoutCheck(): void {
    this.stopTimeoutCheck();
    this.lastMessageTime = Date.now();
    this.timeoutTimer = setInterval(() => {
      if (Date.now() - this.lastMessageTime > this.timeoutInterval) {
        this.lastMessageTime = Date.now(); // 重连前重置,避免立刻再触发
        this.reconnect();
      }
    }, 1_000);
  }

  private stopTimeoutCheck(): void {
    if (this.timeoutTimer) {
      clearInterval(this.timeoutTimer);
      this.timeoutTimer = undefined;
    }
  }

  private reconnect(): void {
    if (this.isReconnecting || this.closed) return;
    this.stopHeartbeat();
    this.stopTimeoutCheck();
    if (this.reconnectAttempts >= this.autoReconnect) return;
    this.isReconnecting = true;
    this.reconnectAttempts++;
    setTimeout(() => {
      this.isReconnecting = false;
      void this.connect();
    }, this.reconnectInterval);
  }

  /**
   * 解码一帧 WS 二进制。无条件 gunzip(消息帧都是 gzip);非 gzip 控制帧 → 静默丢帧不报连接错误(见文件头)。
   */
  private decode(data: Buffer): void {
    let frame: { payload?: Uint8Array; payloadEncoding?: string; logId?: unknown };
    try {
      frame = douyin.PushFrame.decode(data);
    } catch {
      return; // 连 PushFrame 都解不了 → 丢帧(极少见)
    }
    const payload = frame.payload;
    if (!payload || payload.length === 0) return;

    // 消息帧都是 gzip(webcast5Params 请求了 compress:gzip),无条件 gunzip;开播时的非 gzip
    // 控制/握手帧会抛错 → catch 里**静默丢帧、不 emit("error")**(这才是真正的修复:上游对此 emit
    // 连接错误、污染弹幕健康告警)。注:别按 payloadEncoding 门控 —— 实测消息帧的该字段并非 "gzip",
    // 门控会把所有消息帧都跳过 gunzip → 0 弹幕(已被真实录制证伪)。
    let body: Uint8Array;
    try {
      body = gunzipSync(payload);
    } catch {
      return; // 非 gzip 帧(开播控制/握手帧)→ 静默丢,不当连接错误上报
    }

    let resp: { needAck?: boolean; internalExt?: unknown; messagesList?: Array<{ method?: string; payload?: Uint8Array }> };
    try {
      resp = douyin.Response.decode(body);
    } catch {
      return;
    }

    if (resp.needAck) {
      try {
        const ack = douyin.PushFrame.encode(
          douyin.PushFrame.create({ logId: frame.logId, payloadType: resp.internalExt }),
        ).finish();
        this.send(ack);
      } catch {
        /* ack 失败不致命 */
      }
    }

    for (const msg of resp.messagesList ?? []) {
      if (!msg.payload) continue;
      try {
        switch (msg.method) {
          case "WebcastChatMessage":
            this.emit("chat", douyin.ChatMessage.decode(msg.payload).toJSON() as DyChatMessage);
            break;
          case "WebcastMemberMessage":
            this.emit("member", douyin.MemberMessage.decode(msg.payload).toJSON() as DyMemberMessage);
            break;
          case "WebcastGiftMessage":
            this.emit("gift", douyin.GiftMessage.decode(msg.payload).toJSON() as DyGiftMessage);
            break;
          default:
            break; // like / social / roomStats / roomRank / screenChat … 不消费
        }
      } catch {
        /* 单条消息解码失败:跳过这条,不影响同帧其余消息 */
      }
    }
  }

  /** 拼接弹幕 WS URL(签名 + webcast 参数)。参数逐字沿用上游,改动即废签名。 */
  private async getWsInfo(roomId: string): Promise<string | undefined> {
    const userUniqueId = getUserUniqueId(this.cookie);
    const versionCode = 180800;
    const webcastSdkVersion = "1.0.15";
    const sigParams = {
      live_id: "1",
      aid: "6383",
      version_code: versionCode,
      webcast_sdk_version: webcastSdkVersion,
      room_id: roomId,
      sub_room_id: "",
      sub_channel_id: "",
      did_rule: "3",
      user_unique_id: userUniqueId,
      device_platform: "web",
      device_type: "",
      ac: "",
      identity: "audience",
    };
    const signature = getSignature(getXMsStub(sigParams));
    const webcast5Params: Record<string, string> = {
      app_name: "douyin_web",
      room_id: roomId,
      compress: "gzip",
      version_code: String(versionCode),
      webcast_sdk_version: webcastSdkVersion,
      update_version_code: webcastSdkVersion,
      live_id: "1",
      did_rule: "3",
      user_unique_id: userUniqueId,
      identity: "audience",
      signature,
      device_platform: "web",
      cookie_enabled: "true",
      screen_width: "1920",
      screen_height: "1080",
      browser_language: "zh-CN",
      browser_platform: "Win32",
      browser_name: "Mozilla",
      browser_version: "5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36",
      browser_online: "true",
      tz_name: "Etc/GMT-8",
      host: "https://live.douyin.com",
      aid: "6383",
      endpoint: "live_pc",
      support_wrds: "1",
      im_path: "/webcast/im/fetch/",
      need_persist_msg_count: "15",
      heartbeatDuration: "0",
    };
    return `wss://${this.host}/webcast/im/push/v2/?${new URLSearchParams(webcast5Params).toString()}`;
  }
}

export default DouYinDanmaClient;
