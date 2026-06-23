/**
 * ws-codec.ts — bilibili 直播弹幕 WS 协议编解码(纯函数,可单测)。
 *
 * bilibili 弹幕协议(与抖音完全不同):自定义二进制帧,16 字节大端头 + body。
 *   header = [totalLen u32, headerLen u16=16, protover u16, op u32, seq u32]
 *   op: 2=心跳 3=心跳ACK(人气值) 5=普通消息(JSON,可能压缩) 7=进房鉴权 8=鉴权ACK
 *   protover: 0=明文 JSON / 1=明文(心跳/鉴权) / 2=zlib(deflate) / 3=brotli
 * op=5 且 protover=2/3 时 body 解压后是【拼接的多个完整帧】,需递归再解析。
 *
 * 只用 node:zlib(inflate/brotli),无外部依赖。消息归一化(DANMU_MSG/SEND_GIFT/INTERACT_WORD
 * → DanmuMessage)也在此(纯函数,便于用样例 JSON 单测)。
 */
import { inflateSync, brotliDecompressSync } from "node:zlib";
import type { DanmuMessage } from "@drec/core";

export const HEADER_LEN = 16;

export const OP = {
  HEARTBEAT: 2,
  HEARTBEAT_ACK: 3,
  MESSAGE: 5,
  AUTH: 7,
  AUTH_ACK: 8,
} as const;

export const PROTOVER = {
  JSON: 0,
  PLAIN: 1,
  ZLIB: 2,
  BROTLI: 3,
} as const;

/** 打一个 WS 帧:16 字节大端头 + body。seq 默认 1。 */
export function encodePacket(op: number, body: Buffer | string = Buffer.alloc(0), protover: number = PROTOVER.PLAIN, seq = 1): Buffer {
  const bodyBuf = typeof body === "string" ? Buffer.from(body, "utf8") : body;
  const header = Buffer.alloc(HEADER_LEN);
  header.writeUInt32BE(HEADER_LEN + bodyBuf.length, 0); // totalLen
  header.writeUInt16BE(HEADER_LEN, 4); // headerLen
  header.writeUInt16BE(protover, 6); // protover
  header.writeUInt32BE(op, 8); // op
  header.writeUInt32BE(seq, 12); // seq
  return Buffer.concat([header, bodyBuf]);
}

/** 鉴权帧(op=7,protover=1,body=JSON)。uid=0 匿名。 */
export function encodeAuth(roomId: number, token: string, uid = 0): Buffer {
  const body = JSON.stringify({
    uid,
    roomid: roomId,
    protover: 3,
    platform: "web",
    type: 2,
    key: token,
  });
  return encodePacket(OP.AUTH, body, PROTOVER.PLAIN);
}

/** 心跳帧(op=2,空 body)。 */
export function encodeHeartbeat(): Buffer {
  return encodePacket(OP.HEARTBEAT, Buffer.alloc(0), PROTOVER.PLAIN);
}

export interface ParsedFrame {
  op: number;
  protover: number;
  /** op=5 的 JSON 负载(已解压 + JSON.parse);其他 op 为 null。 */
  json: Record<string, unknown> | null;
}

/**
 * 解析一段 buffer 里的【所有】拼接帧,返回打平后的 op=5 JSON 帧(已递归解压)+ 其他控制帧(json=null)。
 * 一个 WS message 可能含多个帧;op=5 压缩帧解压后又是多帧 → 递归。
 */
export function parseFrames(buf: Buffer): ParsedFrame[] {
  const out: ParsedFrame[] = [];
  let offset = 0;
  while (offset + HEADER_LEN <= buf.length) {
    const totalLen = buf.readUInt32BE(offset);
    const headerLen = buf.readUInt16BE(offset + 4);
    const protover = buf.readUInt16BE(offset + 6);
    const op = buf.readUInt32BE(offset + 8);
    if (totalLen < headerLen || offset + totalLen > buf.length) break; // 半包/坏帧,停
    const body = buf.subarray(offset + headerLen, offset + totalLen);
    offset += totalLen;

    if (op === OP.MESSAGE) {
      if (protover === PROTOVER.ZLIB) {
        out.push(...parseFrames(inflateSync(body)));
      } else if (protover === PROTOVER.BROTLI) {
        out.push(...parseFrames(brotliDecompressSync(body)));
      } else {
        // protover 0/1 明文 JSON
        out.push({ op, protover, json: safeJson(body) });
      }
    } else {
      // op=3 心跳ACK(人气值,非 JSON) / op=8 鉴权ACK 等 → 不解 JSON
      out.push({ op, protover, json: null });
    }
  }
  return out;
}

function safeJson(body: Buffer): Record<string, unknown> | null {
  try {
    return JSON.parse(body.toString("utf8")) as Record<string, unknown>;
  } catch {
    return null;
  }
}

/** 时间戳归一化到毫秒(秒级 <1e12 则 ×1000)。 */
function toMs(t: unknown): number {
  const n = Number(t);
  if (!Number.isFinite(n) || n <= 0) return Date.now();
  return n < 1e12 ? Math.round(n * 1000) : Math.round(n);
}

/**
 * 一条 op=5 JSON(`{cmd, ...}`)→ DanmuMessage(不匹配的 cmd 返 null)。纯函数,样例 JSON 可直测。
 *   DANMU_MSG       → danmaku(info[0][4]=发送时间 ms)
 *   SEND_GIFT/COMBO → gift(timestamp=unix 秒;price 元 = gold? total_coin/1000 : 0)
 *   INTERACT_WORD   → member(仅 msg_type===1 进场;关注/分享等忽略)
 */
export function mapCmdToDanmu(msg: Record<string, unknown>): DanmuMessage | null {
  const cmd = String(msg.cmd ?? "");

  if (cmd === "DANMU_MSG") {
    const info = msg.info as unknown[];
    if (!Array.isArray(info)) return null;
    const meta = info[0] as unknown[]; // [..., sendTimeMs at idx 4, ...]
    const userArr = info[2] as unknown[]; // [uid, uname, ...]
    return {
      kind: "danmaku",
      tsMs: toMs(Array.isArray(meta) ? meta[4] : undefined),
      user: Array.isArray(userArr) ? String(userArr[1] ?? "") : undefined,
      uid: Array.isArray(userArr) ? String(userArr[0] ?? "") : undefined,
      content: String(info[1] ?? ""),
    };
  }

  if (cmd === "SEND_GIFT" || cmd === "COMBO_SEND") {
    const d = (msg.data ?? {}) as Record<string, unknown>;
    // gold=付费金瓜子(1000 瓜子=1 元);silver=免费银瓜子→0 元。
    const price = d.coin_type === "gold" ? (Number(d.total_coin) || 0) / 1000 : 0;
    return {
      kind: "gift",
      tsMs: toMs(Number(d.timestamp) * 1000), // timestamp 为 unix 秒
      user: d.uname != null ? String(d.uname) : undefined,
      uid: String(d.uid ?? ""),
      giftName: d.giftName != null ? String(d.giftName) : undefined,
      giftCount: Number(d.num) || 1,
      price,
    };
  }

  if (cmd === "INTERACT_WORD") {
    const d = (msg.data ?? {}) as Record<string, unknown>;
    if (Number(d.msg_type) !== 1) return null; // 仅进场(2=关注 等忽略)
    return {
      kind: "member",
      tsMs: toMs(Number(d.timestamp) * 1000),
      user: d.uname != null ? String(d.uname) : undefined,
      uid: String(d.uid ?? ""),
    };
  }

  return null;
}
