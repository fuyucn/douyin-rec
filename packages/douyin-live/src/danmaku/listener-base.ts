/**
 * listener-base.ts — 抖音直播弹幕 WS 监听基类(@drec/douyin-live 专属)。
 *
 * 唯一子类 DouyinDanmuSource(见 index.ts)加载同目录我们自己的 `./client.ts`
 * (参考 douyin-danma-listener 重写为干净 TS;签名 webmssdk.js + schema proto.js 仍 vendored);
 * bilibili 是不同协议、另有自己的 WS 实现,不复用本基类。
 *
 * client.ts API:
 *   - Constructor: new DouYinDanmaClient(roomId: string, opts?)
 *     opts: { autoStart?, autoReconnect?, heartbeatInterval?, cookie? }
 *   - Connect: client.connect() — returns Promise<void>
 *   - Stop:    client.close()  — synchronous, closes the WebSocket
 *   - Events:  'chat'(ChatMessage), 'gift'(GiftMessage), 'member'(MemberMessage), 'error', 'open', 'close', ...
 *
 * IMPORTANT(2026-06-13 实测纠正): DouYinDanmaClient 需要本场直播的 **liveId**，不是房间
 *   web_rid/slug。传 slug 能连上 WS 但收不到弹幕（只有房间信息帧）。start() 里用
 *   getInfo(slug).liveId 解析后再连。（之前“slug 可用”的结论是错的——那次恰好是 bundled 在写。）
 *
 * GiftMessage fields used: .user.nickName/.user.id, .gift.name, .totalCount(string→1),
 *   .gift.diamondCount(抖音币, 10 币 ≈ 1 元)。
 * ChatMessage fields used: .user.nickName/.user.id, .content, .eventTime(秒级字符串)。
 * MemberMessage fields used: .user.nickName/.user.id。
 */
import { createLogger, type DanmuSource, type RecordOpts, type DanmuMessage } from "@drec/core";

const log = createLogger("danmaku_recorder");

// 与 client.ts 导出的 DyChatMessage/DyGiftMessage/DyMemberMessage 对应,此处复刻一份:
// listener-base 有 vitest 单测,不能 import client.ts(后者引 webmssdk.js/proto.js → sm-crypto
// interop,vitest 无法 import)。故只用结构兼容的本地类型,经 index.ts 的 `as unknown as` 桥接。
interface _User {
  id: string;
  nickName: string;
}
interface _Gift {
  name: string;
  diamondCount: number;
}
interface _ChatMsg {
  user: _User;
  content: string;
  eventTime: string;
}
interface _GiftMsg {
  user: _User;
  gift: _Gift;
  totalCount: string;
  sendTime: string;
  repeatEnd: null | 1;
}
interface _MemberMsg {
  user: _User;
}

/** DouYinDanmaClient 实例最小形状（vendored 与 npm 包一致）。 */
export interface DanmaClient {
  on(event: "open" | "close", cb: (...args: unknown[]) => void): unknown;
  on(event: "chat", cb: (m: _ChatMsg) => void): unknown;
  on(event: "gift", cb: (m: _GiftMsg) => void): unknown;
  on(event: "member", cb: (m: _MemberMsg) => void): unknown;
  on(event: "error", cb: (e: Error) => void): unknown;
  connect(): Promise<void>;
  close(): void;
}

/** DouYinDanmaClient 构造器形状（vendored 与 npm 包共用）。 */
export type DanmaClientCtor = new (
  roomId: string,
  options?: {
    autoStart?: boolean;
    autoReconnect?: number;
    heartbeatInterval?: number;
    cookie?: string;
  },
) => DanmaClient;

/**
 * Normalise a raw timestamp (seconds or ms) to milliseconds.
 * douyin-danma-listener emits ChatMessage.eventTime in seconds (string) and
 * GiftMessage.sendTime in an ambiguous unit; the magnitude check handles both:
 * values < 1e12 are treated as seconds, values >= 1e12 as ms (epoch ms > 1e12 since ~2001).
 */
function toMs(t: unknown): number {
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) return Date.now();
  return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
}

/** 「连上却 0 消息」健康看门狗阈值:在播房间至少有人进场/弹幕,超此时长仍 0 条 → 疑似陈旧 liveId。 */
const DANMU_SILENT_MS = 180_000; // 3 分钟

/**
 * 弹幕 WS 监听 provider 基类(douyin-live 自有)。WS 事件接线 / 消息归一化在此;本场连接 id 的解析
 * (resolveLiveId)与 client 构造器(loadClientCtor)由子类提供。
 */
export abstract class ListenerDanmuSource implements DanmuSource {
  abstract readonly name: string;

  /** 子类提供 DouYinDanmaClient 构造器（vendored 副本 或 npm 包）。 */
  protected abstract loadClientCtor(): Promise<DanmaClientCtor>;

  /**
   * 解析本场直播的 WS 连接 id(抖音=liveId,**平台专属**,故下沉到子类)。
   * 拿不到返 null → 本场不抓弹幕。抖音子类调本包的 resolveDouyinLiveId。
   */
  protected abstract resolveLiveId(roomUrl: string): Promise<string | null>;

  private client: DanmaClient | null = null;
  /** 收到的消息计数（用于可见性日志）。 */
  private msgCount = 0;
  /** 健康监控:连上后是否收到过任何消息(弹幕/礼物/入场)。 */
  private gotMsg = false;
  /** 「连上却长时间 0 消息」看门狗(陈旧 liveId/风控的静默失败信号)。 */
  private silentTimer: ReturnType<typeof setTimeout> | null = null;
  /** WS error 告警去重:autoReconnect 抖动会连发 error,只报第一条(每次 start 重置)。 */
  private wsErrorAlerted = false;

  /**
   * @param onAlert 弹幕健康告警回调(连不上 / liveId 解析失败 / 连上但长时间 0 条)。
   *   session 接到后走 notify → webhook + UI,与视频卡死看门狗对等(否则弹幕静默失败无人知)。
   */
  async start(
    roomUrl: string,
    opts: RecordOpts,
    onMessage: (m: DanmuMessage) => void,
    onAlert?: (msg: string) => void,
  ): Promise<void> {
    const alert = (msg: string): void => { try { onAlert?.(msg); } catch { /* ignore */ } };
    // 本场 liveId 由子类(平台专属)解析。拿不到 → 解析失败(此时已 onLive 确认开播)→ 告警 + 本场不抓。
    const liveId = await this.resolveLiveId(roomUrl);
    if (!liveId) {
      log.warn(`${this.name} 拿不到 liveId(${roomUrl})，本场不抓弹幕`);
      alert(`弹幕未启动:拿不到本场 liveId(${roomUrl}),整场无弹幕。疑似解析失败/被风控。`);
      return;
    }

    const Ctor = await this.loadClientCtor();

    // 关键：不能把【完整】cookie 直接灌进弹幕 WS（会触发抖音异地登录踢手机）。
    // 移植 Python 生产版做法：白名单过滤（丢 sid_guard/sid_ucp_v1/ssid_ucp_v1/login_time
    // 等踢人 token，留 sessionid/uid_tt 保礼物）+ 用匿名 guest 设备指纹覆盖。详见 danmu-cookie.ts。
    const { buildDanmuCookie } = await import("./danmu-cookie.js");
    const wsCookie = await buildDanmuCookie(opts.cookies);

    this.msgCount = 0;
    this.gotMsg = false;
    this.wsErrorAlerted = false;
    this.clearSilentWatch();
    log.info(
      `${this.name} 启动 liveId=${liveId} cookie=${opts.cookies ? `有(原${opts.cookies.length}→过滤合并${wsCookie?.length ?? 0}字符)` : "无(匿名)"}`,
    );

    const client = new Ctor(liveId, {
      autoStart: false,
      autoReconnect: 10,
      cookie: wsCookie,
    });
    this.client = client;

    // 连接可见性：open/close 之前是黑盒，加日志便于排查“连上但无消息” vs “连不上”。
    client.on("open", () => log.info(`${this.name} WS 已连接 liveId=${liveId}`));
    client.on("close", (...a: unknown[]) =>
      log.info(`${this.name} WS 断开 liveId=${liveId} ${a.length ? JSON.stringify(a).slice(0, 120) : ""}`));

    client.on("chat", (d: _ChatMsg) => {
      this.gotMsg = true;
      if (++this.msgCount <= 3 || this.msgCount % 50 === 0)
        log.info(`${this.name} 收到第 ${this.msgCount} 条: ${d.user?.nickName}: ${d.content}`);
      onMessage({
        kind: "danmaku",
        // eventTime may be seconds (string); toMs() handles seconds vs ms ambiguity
        tsMs: toMs(d.eventTime),
        user: d.user?.nickName,
        uid: String(d.user?.id ?? ""),
        content: d.content,
      });
    });

    client.on("gift", (d: _GiftMsg) => {
      // 连击礼物(亲吻/星光闪耀等)会随 combo count 递增逐帧推送;只在**末帧 repeatEnd===1** 记一条、
      // 用 totalCount 作数量,避免同一次连击被重复计数 N 倍(三源对比:低价连击帧数因连接快慢而异,
      // 造成礼物总数虚高且各源不一致)。非连击礼物末帧同样带 repeatEnd=1,不会漏。
      // ⚠️ 此为标准 douyin 去重做法,但需真实录制核验:礼物数应降到「连击次数」量级(而非 0);
      //    若降到 0 说明该 vendored proto 的 gift 不带 repeatEnd,需回退本判断。
      if (d.repeatEnd !== 1) return;
      this.gotMsg = true;
      onMessage({
        kind: "gift",
        // sendTime units vary (seconds vs ms for repeatEnd events); toMs() handles both
        tsMs: toMs(d.sendTime),
        user: d.user?.nickName,
        uid: String(d.user?.id ?? ""),
        giftName: d.gift?.name,
        // totalCount is a string in the raw proto
        giftCount: Number(d.totalCount) || 1,
        // diamondCount = Douyin coins; 10 coins = 1 CNY
        price: (d.gift?.diamondCount ?? 0) / 10,
      });
    });

    client.on("member", (d: _MemberMsg) => {
      this.gotMsg = true;
      onMessage({
        kind: "member",
        tsMs: Date.now(),
        user: d.user?.nickName,
        uid: String(d.user?.id ?? ""),
      });
    });

    client.on("error", (err: Error) => {
      log.error(`${this.name} WS error:`, err?.message ?? err);
      // 日志每次都记;告警只发首条 —— autoReconnect 抖动会连发 error,否则刷屏 webhook/UI。
      if (!this.wsErrorAlerted) {
        this.wsErrorAlerted = true;
        alert(`弹幕 WS 错误(后续重连错误不再重复告警): ${err?.message ?? err}`);
      }
    });

    // connect 拒绝必须告警后再抛 —— 否则越过下方看门狗 + error 事件,只剩调用方日志 = 静默无弹幕。
    try {
      await client.connect();
    } catch (e) {
      const m = (e as Error)?.message ?? String(e);
      log.error(`${this.name} 连接失败:`, m);
      alert(`弹幕连接失败,本场可能整场无弹幕: ${m}。room=${roomUrl} liveId=${liveId}`);
      throw e;
    }

    // 健康看门狗:连上后长时间一条都没有(弹幕/礼物/**入场**都计数,入场即便匿名也会推)。
    // 这强烈指向陈旧/错误 liveId 的静默失败(整场 0 弹幕的特征);但**冷清小房间**确实可能真没人进出,
    // 故措辞为「提示排查」而非断言故障,避免对低人气主播每场误报、消磨告警可信度。一次性,不重复。
    this.silentTimer = setTimeout(() => {
      if (!this.gotMsg && this.client) {
        const mins = Math.round(DANMU_SILENT_MS / 60000);
        log.warn(`${this.name} ⚠️ 连上 ${mins} 分钟仍 0 条消息(弹幕/礼物/入场)`);
        alert(`弹幕已连但 ${mins} 分钟 0 条(含入场):若房间有人互动则疑似 liveId 失效/被风控、本场可能无弹幕,请排查;冷清房间可忽略。room=${roomUrl} liveId=${liveId}`);
      }
    }, DANMU_SILENT_MS);
    this.silentTimer.unref?.();
  }

  private clearSilentWatch(): void {
    if (this.silentTimer) { clearTimeout(this.silentTimer); this.silentTimer = null; }
  }

  async stop(): Promise<void> {
    this.clearSilentWatch();
    if (this.client) {
      try {
        this.client.close();
      } catch {
        // Ignore close errors
      }
      this.client = null;
    }
  }
}
