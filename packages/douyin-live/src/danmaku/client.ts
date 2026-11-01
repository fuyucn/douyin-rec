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
 * 这两个 vendored 模块**不在模块加载期静态执行**,而是 connect() 时按需动态加载(下方 lazy loader);
 * 签名 / 解码 / WS 工厂均可经构造参数注入假实现(默认值仍是本文件里的现实现),供单测使用 ——
 * 测试由此永不触达 vendored 代码,也不发起真实网络连接。
 */
import WebSocket from "ws";
import { TypedEmitter } from "tiny-typed-emitter";
import { gunzipSync } from "node:zlib";
import crypto from "node:crypto";
import type { douyin } from "./proto.js";
import type { get_sign } from "./webmssdk.js";
import { createLogger } from "@drec/core";
import { fetchGuestCookie } from "./danmu-cookie.js";

const log = createLogger("danmaku_client");

// ── vendored 模块懒加载(仅保留类型;运行时经动态 import,注入假实现的测试永不触达)────────
type DouyinProto = typeof douyin;
type WebmssdkGetSign = typeof get_sign;

let protoMemo: DouyinProto | undefined;
async function loadProto(): Promise<DouyinProto> {
  protoMemo ??= (await import("./proto.js")).douyin;
  return protoMemo;
}
let getSignMemo: WebmssdkGetSign | undefined;
async function loadGetSign(): Promise<WebmssdkGetSign> {
  getSignMemo ??= (await import("./webmssdk.js")).get_sign;
  return getSignMemo;
}

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
  /**
   * 自动重连次数耗尽(连续闪断且已达 autoReconnect 上限)→ 永久放弃本场。
   * 上层据此停掉弹幕采集并告警,避免无限重连把出口 IP 刷进风控名单。
   */
  exhausted: (attempts: number) => void;
  chat: (m: DyChatMessage) => void;
  gift: (m: DyGiftMessage) => void;
  member: (m: DyMemberMessage) => void;
  /**
   * 控制消息:`WebcastControlMessage` 的 `action === 3` = 平台宣告本场**疑似结束**(下播)。
   * ⚠️ 只作**提示**:可能是主播真下播,也可能是平台/风控主动断流 —— 调用方**不得**据此直接收播,
   * 必须以权威 `getLiving` 复核后才决定(否则网络抖动会被误判成下播、把一场切成多段)。
   */
  control: (e: { action: number; tips: string }) => void;
}

/** 注入用最小 WS 接口:真实 ws 与测试假 socket 都满足(readyState 用 ws 的标准数值常量)。 */
export interface DanmuWsLike {
  readyState: number;
  on(event: string, listener: (...args: unknown[]) => void): unknown;
  send(data: string | Uint8Array): unknown;
  close(...args: unknown[]): unknown;
  terminate(): unknown;
}

/** WS 工厂注入点(默认 = 真实 ws 客户端;测试注入假 socket 避免真实网络)。 */
export type DanmuWsFactory = (url: string, options: { headers: Record<string, string> }) => DanmuWsLike;

export interface DanmaClientOptions {
  autoStart?: boolean;
  autoReconnect?: number;
  heartbeatInterval?: number;
  reconnectInterval?: number;
  timeoutInterval?: number;
  cookie?: string;
  host?: string;
  /** 测试注入:签名函数(默认 = vendored webmssdk.get_sign)。 */
  sign?: DanmuSignFn;
  /** 测试注入:帧解码函数(默认 = vendored proto.js 管线)。 */
  decode?: DanmuDecodeFn;
  /** 测试注入:WS 工厂(默认 = 真实 ws 客户端)。 */
  wsFactory?: DanmuWsFactory;
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

/** 签名函数注入点:md5 stub → signature。默认实现 = webmssdk.get_sign(懒加载)。 */
export type DanmuSignFn = (xMsStub: string) => string | Promise<string>;

/**
 * 默认签名:webmssdk.get_sign;get_sign 调用本身失败回落全零兜底签名(上游同款)。
 * 模块加载失败不兜底 → connect reject,走上层连接失败告警(否则带废签名静默连接)。
 */
async function defaultSign(xMsStub: string): Promise<string> {
  const getSign = await loadGetSign();
  try {
    return String(getSign(xMsStub));
  } catch {
    return "00000000";
  }
}

/** 解码产物中的一条消息(保持帧内原始顺序)。 */
export type DecodedDanmuMessage =
  | { kind: "chat"; msg: DyChatMessage }
  | { kind: "gift"; msg: DyGiftMessage }
  | { kind: "member"; msg: DyMemberMessage }
  | { kind: "control"; msg: { action: number; tips: string } };

/** 解码一帧 WS 二进制的产物;null = 丢帧(解不开/非 gzip 控制帧 → 静默,不当连接错误)。 */
export interface DecodedDanmuFrame {
  /** needAck=true 时的回执参数(PushFrame logId + Response internalExt)→ 由 client 统一回 ack。 */
  ack?: { logId: unknown; payloadType: unknown };
  messages: DecodedDanmuMessage[];
}

/** 解码函数注入点(默认实现 = vendored proto.js 管线,见 defaultDecode)。 */
export type DanmuDecodeFn = (data: Buffer) => DecodedDanmuFrame | null;

/**
 * 默认解码管线(原 DouYinDanmaClient.decode 的逻辑移出成纯函数):无条件 gunzip(消息帧都是
 * gzip);非 gzip 控制/握手帧 → 静默丢帧、不 emit("error")(上游对此 emit 连接错误、污染弹幕
 * 健康告警)。注:别按 payloadEncoding 门控 —— 实测消息帧的该字段并非 "gzip",门控会把所有
 * 消息帧都跳过 gunzip → 0 弹幕(已被真实录制证伪)。proto 由 connect() 预载。
 */
function defaultDecode(data: Buffer): DecodedDanmuFrame | null {
  const proto = protoMemo;
  if (!proto) return null; // 理论不可达:connect() 已预载(注入解码时不走此函数)
  let frame: { payload?: Uint8Array; logId?: unknown };
  try {
    frame = proto.PushFrame.decode(data);
  } catch {
    return null; // 连 PushFrame 都解不了 → 丢帧(极少见)
  }
  const payload = frame.payload;
  if (!payload || payload.length === 0) return null;

  // 消息帧都是 gzip(webcast5Params 请求了 compress:gzip),无条件 gunzip;开播时的非 gzip
  // 控制/握手帧会抛错 → catch 里静默丢帧、不当连接错误上报。
  let body: Uint8Array;
  try {
    body = gunzipSync(payload);
  } catch {
    return null; // 非 gzip 帧(开播控制/握手帧)→ 静默丢,不当连接错误上报
  }

  let resp: { needAck?: boolean; internalExt?: unknown; messagesList?: Array<{ method?: string; payload?: Uint8Array }> };
  try {
    resp = proto.Response.decode(body);
  } catch {
    return null;
  }

  const out: DecodedDanmuFrame = { messages: [] };
  if (resp.needAck) out.ack = { logId: frame.logId, payloadType: resp.internalExt };

  for (const msg of resp.messagesList ?? []) {
    if (!msg.payload) continue;
    try {
      switch (msg.method) {
        case "WebcastChatMessage":
          out.messages.push({ kind: "chat", msg: proto.ChatMessage.decode(msg.payload).toJSON() as DyChatMessage });
          break;
        case "WebcastMemberMessage":
          out.messages.push({ kind: "member", msg: proto.MemberMessage.decode(msg.payload).toJSON() as DyMemberMessage });
          break;
        case "WebcastGiftMessage":
          out.messages.push({ kind: "gift", msg: proto.GiftMessage.decode(msg.payload).toJSON() as DyGiftMessage });
          break;
        case "WebcastControlMessage": {
          // 上游语义:action === 3 = 本场疑似结束(下播)。仅作提示 → 交给上层用 getLiving 复核。
          const c = proto.ControlMessage.decode(msg.payload);
          if (Number(c.action) === 3) {
            out.messages.push({ kind: "control", msg: { action: Number(c.action), tips: String(c.tips ?? "") } });
          }
          break;
        }
        default:
          break; // like / social / roomStats / roomRank / screenChat … 不消费
      }
    } catch {
      /* 单条消息解码失败:跳过这条,不影响同帧其余消息 */
    }
  }
  return out;
}

const UA =
  "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/134.0.0.0 Safari/537.36";

/**
 * 连接稳定阈值(ms):WS 存活超过此时长才认定「真的连上了」并清零重连计数。
 *
 * 修复的历史缺陷:原先 `open` 里立即 `reconnectAttempts = 0`,而风控会「接受握手但很快踢掉」,
 * 于是「连上→被踢→重连」永不触及 autoReconnect 上限 → 无限重连(实测某房间 4 小时约 1000 次
 * 连接、平均存活 5 秒),持续给风控喂信号,最终把整个出口 IP 拉黑。
 */
const STABLE_CONNECTION_MS = 60_000;

/**
 * 抖音弹幕 WS 客户端。`roomId` 必须是本场直播的 **liveId**(不是房间 web_rid/slug,
 * 传 slug 能连上却收不到弹幕 —— 见 listener-base 注释)。事件:open/close/error/chat/gift/member。
 */
export class DouYinDanmaClient extends TypedEmitter<ClientEvents> {
  private ws: DanmuWsLike | undefined;
  private readonly roomId: string;
  private readonly heartbeatInterval: number;
  private readonly autoReconnect: number;
  private readonly reconnectInterval: number;
  private readonly timeoutInterval: number;
  private readonly cookie: string | undefined;
  private readonly host: string;
  // 注入点(默认值 = 本文件的现实现,见 DanmaClientOptions 注释)。
  private readonly signFn: DanmuSignFn;
  private readonly decodeFn: DanmuDecodeFn;
  private readonly wsFactory: DanmuWsFactory;

  private reconnectAttempts = 0;
  private heartbeatTimer: ReturnType<typeof setInterval> | undefined;
  private timeoutTimer: ReturnType<typeof setInterval> | undefined;
  /** 重连等待定时器:close() 时必须清除,否则等待期间被停仍会再建一条连接(僵尸)。 */
  private reconnectTimer: ReturnType<typeof setTimeout> | undefined;
  /** 连接稳定计时器:存活满 STABLE_MS 才认定连接可用(重置重连计数)。 */
  private stableTimer: ReturnType<typeof setTimeout> | undefined;
  private lastMessageTime = Date.now();
  private isReconnecting = false;
  /** close() 主动关闭后置 true,阻止 close/error 触发的自动重连。 */
  private closed = false;
  /** 重连次数耗尽后置 true,永久停止本场的自动重连。 */
  private exhausted = false;

  constructor(roomId: string, options: DanmaClientOptions = {}) {
    super();
    this.roomId = roomId;
    this.heartbeatInterval = options.heartbeatInterval ?? 10_000;
    this.autoReconnect = options.autoReconnect ?? 10;
    this.reconnectInterval = options.reconnectInterval ?? 10_000;
    this.timeoutInterval = options.timeoutInterval ?? 100_000;
    this.cookie = options.cookie;
    this.host = options.host ?? "webcast100-ws-web-hl.douyin.com";
    this.signFn = options.sign ?? defaultSign;
    this.decodeFn = options.decode ?? defaultDecode;
    this.wsFactory = options.wsFactory ?? ((url, opts) => new WebSocket(url, opts) as unknown as DanmuWsLike);
    if (options.autoStart) void this.connect();
  }

  async connect(): Promise<void> {
    if (this.closed) return;
    // 默认解码管线依赖 vendored proto.js → 建连前预载(注入 decode 的调用方不触达 vendored 模块)。
    if (this.decodeFn === defaultDecode) await loadProto();
    const url = await this.getWsInfo(this.roomId);
    if (this.closed) return; // 签名期间被 close → 不再建连
    if (!url) {
      this.emit("error", new Error("获取抖音弹幕签名失败"));
      return;
    }
    const cookie = this.cookie || (await fetchGuestCookie());
    if (this.closed) return; // 拉访客登录态期间被 close → 不再建连
    const ws = this.wsFactory(url, {
      headers: {
        Cookie: cookie,
        "User-Agent": UA,
        Origin: "https://live.douyin.com",
        Referer: "https://live.douyin.com/",
      },
    });
    this.ws = ws;

    ws.on("open", () => {
      if (this.closed || this.ws !== ws) return; // 迟到的 open(已 close / 已被重连替换)→ 不起定时器
      this.emit("open");
      this.startHeartbeat();
      this.startTimeoutCheck();
      // 不在这里直接清零重连计数 —— 风控会「接受握手但立刻踢掉」,立即清零会让 autoReconnect
      // 上限永远不触发(无限重连)。改为存活满 STABLE_CONNECTION_MS 才认定连接稳定并清零。
      this.startStableCheck();
    });
    ws.on("message", (...args: unknown[]) => {
      if (this.closed || this.ws !== ws) return;
      this.lastMessageTime = Date.now();
      this.decodeAndDispatch(args[0] as Buffer);
    });
    ws.on("close", () => {
      // 已主动关闭 / 已被替换的旧 socket(如 CONNECTING 态 terminate 后异步补发的 close)→ 只记日志。
      if (this.closed || this.ws !== ws) {
        log.info("弹幕 WS 旧连接 close 事件(已关闭/已替换),忽略");
        return;
      }
      this.emit("close");
      this.reconnect();
    });
    ws.on("error", (...args: unknown[]) => {
      const err = args[0] as Error;
      if (this.closed || this.ws !== ws) {
        log.info(`弹幕 WS 旧连接 error 事件(已关闭/已替换),忽略: ${err?.message ?? err}`);
        return;
      }
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
    this.stopStableCheck();
    this.stopReconnectTimer();
    const ws = this.ws;
    this.ws = undefined;
    if (!ws) return;
    try {
      // CONNECTING(握手未完成)→ terminate 立即销毁;其余状态 → close 优雅关闭(ws 库对迟迟
      // 不应答的 close 有 30s 超时后强制 terminate)。旧实现只处理 OPEN,CONNECTING 的半开连接
      // 会成为僵尸(弹幕 stop 后仍挂着一条死连接,#420)。
      if (ws.readyState === WebSocket.CONNECTING) ws.terminate();
      else ws.close();
    } catch {
      /* 连接已标记 closed,事件回调不会再触发重连;close 失败不致命 */
    }
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

  private stopReconnectTimer(): void {
    if (this.reconnectTimer) {
      clearTimeout(this.reconnectTimer);
      this.reconnectTimer = undefined;
    }
  }

  /** 连接稳定计时:存活满 STABLE_CONNECTION_MS → 认定可用,清零重连计数(闪断则不计)。 */
  private startStableCheck(): void {
    this.stopStableCheck();
    this.stableTimer = setTimeout(() => {
      this.stableTimer = undefined;
      this.reconnectAttempts = 0;
    }, STABLE_CONNECTION_MS);
    this.stableTimer.unref?.();
  }

  private stopStableCheck(): void {
    if (this.stableTimer) {
      clearTimeout(this.stableTimer);
      this.stableTimer = undefined;
    }
  }

  private reconnect(): void {
    if (this.isReconnecting || this.closed || this.exhausted) return;
    this.stopHeartbeat();
    this.stopTimeoutCheck();
    this.stopStableCheck();
    // 超时/错误触发的重连:旧 socket 可能还活着(如僵死连接),先终止再等重连,避免新旧两条并存。
    if (this.ws) {
      const old = this.ws;
      this.ws = undefined;
      try {
        old.terminate();
      } catch {
        /* 旧连接终止失败不致命(多数场景本就已死) */
      }
    }
    if (this.reconnectAttempts >= this.autoReconnect) {
      // 上限已到:永久停止本场重连并通知上层(避免无限重连刷爆出口 IP 的风控)。
      this.exhausted = true;
      this.emit("exhausted", this.reconnectAttempts);
      return;
    }
    this.isReconnecting = true;
    this.reconnectAttempts++;
    this.stopReconnectTimer();
    this.reconnectTimer = setTimeout(() => {
      this.reconnectTimer = undefined;
      this.isReconnecting = false;
      // 等待期间被 close()(或耗尽)→ 不再建连;定时器本身也已在 close() 清除,这里是双保险。
      if (this.closed || this.exhausted) return;
      void this.connect().catch((e) => this.emit("error", e as Error));
    }, this.reconnectInterval);
  }

  /** 解码一帧并分发。帧级解码/解压失败 = 静默丢帧,不 emit("error")(见文件头)。 */
  private decodeAndDispatch(data: Buffer): void {
    let frame: DecodedDanmuFrame | null;
    try {
      frame = this.decodeFn(data);
    } catch {
      return; // 解码器抛错 → 丢帧(极少见)
    }
    if (!frame) return;
    if (frame.ack) this.sendAck(frame.ack.logId, frame.ack.payloadType);
    for (const m of frame.messages) {
      // 逐条隔离:监听方(落盘等同步链路)抛错不得外抛成 uncaughtException,也不影响同帧后续消息。
      try {
        if (m.kind === "chat") this.emit("chat", m.msg);
        else if (m.kind === "gift") this.emit("gift", m.msg);
        else if (m.kind === "member") this.emit("member", m.msg);
        else this.emit("control", m.msg);
      } catch (e) {
        log.error(`弹幕消息监听方抛错(kind=${m.kind}),已隔离:`, (e as Error)?.message ?? e);
      }
    }
  }

  /** needAck 回执:编码 PushFrame{logId, payloadType} 发回(proto 已在 connect() 预载)。 */
  private sendAck(logId: unknown, payloadType: unknown): void {
    try {
      const proto = protoMemo;
      if (!proto) return;
      const ack = proto.PushFrame.encode(
        proto.PushFrame.create({ logId, payloadType }),
      ).finish();
      this.send(ack);
    } catch {
      /* ack 失败不致命 */
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
    const signature = await this.signFn(getXMsStub(sigParams));
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
