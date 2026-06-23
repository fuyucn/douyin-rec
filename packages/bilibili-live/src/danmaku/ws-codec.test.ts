import { describe, it, expect } from "vitest";
import { deflateSync, brotliCompressSync } from "node:zlib";
import {
  encodePacket,
  encodeAuth,
  encodeHeartbeat,
  parseFrames,
  mapCmdToDanmu,
  OP,
  PROTOVER,
  HEADER_LEN,
} from "./ws-codec.js";

describe("packet framing", () => {
  it("encodePacket header round-trips (big-endian)", () => {
    const body = Buffer.from("hello", "utf8");
    const pkt = encodePacket(OP.MESSAGE, body, PROTOVER.JSON, 7);
    expect(pkt.readUInt32BE(0)).toBe(HEADER_LEN + body.length); // totalLen
    expect(pkt.readUInt16BE(4)).toBe(HEADER_LEN); // headerLen
    expect(pkt.readUInt16BE(6)).toBe(PROTOVER.JSON); // protover
    expect(pkt.readUInt32BE(8)).toBe(OP.MESSAGE); // op
    expect(pkt.readUInt32BE(12)).toBe(7); // seq
    expect(pkt.subarray(HEADER_LEN).toString("utf8")).toBe("hello");
  });

  it("encodeAuth produces op=7 with uid=0 anonymous JSON body", () => {
    const pkt = encodeAuth(12345, "tok-abc");
    expect(pkt.readUInt32BE(8)).toBe(OP.AUTH);
    const body = JSON.parse(pkt.subarray(HEADER_LEN).toString("utf8"));
    expect(body).toMatchObject({ uid: 0, roomid: 12345, protover: 3, platform: "web", type: 2, key: "tok-abc" });
  });

  it("encodeHeartbeat is op=2 with empty body", () => {
    const pkt = encodeHeartbeat();
    expect(pkt.readUInt32BE(8)).toBe(OP.HEARTBEAT);
    expect(pkt.length).toBe(HEADER_LEN);
  });
});

describe("parseFrames", () => {
  function jsonFrame(obj: unknown, protover = PROTOVER.JSON): Buffer {
    return encodePacket(OP.MESSAGE, JSON.stringify(obj), protover);
  }

  it("parses a single plain JSON op=5 frame", () => {
    const frames = parseFrames(jsonFrame({ cmd: "X" }));
    expect(frames).toHaveLength(1);
    expect(frames[0].op).toBe(OP.MESSAGE);
    expect(frames[0].json).toEqual({ cmd: "X" });
  });

  it("splits multiple concatenated frames in one buffer", () => {
    const buf = Buffer.concat([jsonFrame({ cmd: "A" }), jsonFrame({ cmd: "B" }), encodeHeartbeat()]);
    const frames = parseFrames(buf);
    expect(frames).toHaveLength(3);
    expect(frames[0].json).toEqual({ cmd: "A" });
    expect(frames[1].json).toEqual({ cmd: "B" });
    expect(frames[2].op).toBe(OP.HEARTBEAT);
    expect(frames[2].json).toBeNull();
  });

  it("decompresses zlib (protover=2) inner concatenated frames", () => {
    const inner = Buffer.concat([jsonFrame({ cmd: "A" }), jsonFrame({ cmd: "B" })]);
    const outer = encodePacket(OP.MESSAGE, deflateSync(inner), PROTOVER.ZLIB);
    const frames = parseFrames(outer);
    expect(frames.map((f) => f.json)).toEqual([{ cmd: "A" }, { cmd: "B" }]);
  });

  it("decompresses brotli (protover=3) inner concatenated frames", () => {
    const inner = Buffer.concat([jsonFrame({ cmd: "DANMU_MSG" }), jsonFrame({ cmd: "SEND_GIFT" })]);
    const outer = encodePacket(OP.MESSAGE, brotliCompressSync(inner), PROTOVER.BROTLI);
    const frames = parseFrames(outer);
    expect(frames.map((f) => (f.json as { cmd: string }).cmd)).toEqual(["DANMU_MSG", "SEND_GIFT"]);
  });

  it("stops on a truncated (half) frame without throwing", () => {
    const full = jsonFrame({ cmd: "A" });
    const buf = Buffer.concat([full, full.subarray(0, 5)]); // 第二帧只剩 5 字节
    const frames = parseFrames(buf);
    expect(frames).toHaveLength(1);
    expect(frames[0].json).toEqual({ cmd: "A" });
  });
});

describe("mapCmdToDanmu", () => {
  it("maps DANMU_MSG → danmaku with tsMs in ms", () => {
    const msg = {
      cmd: "DANMU_MSG",
      info: [
        [0, 1, 25, 16777215, 1700000000123, 0], // info[0][4] = send time ms
        "晚上好",
        [114514, "观众甲", 0, 0, 0], // [uid, uname, ...]
      ],
    };
    const m = mapCmdToDanmu(msg)!;
    expect(m.kind).toBe("danmaku");
    expect(m.content).toBe("晚上好");
    expect(m.user).toBe("观众甲");
    expect(m.uid).toBe("114514");
    expect(m.tsMs).toBe(1700000000123); // already ms, unchanged
  });

  it("maps SEND_GIFT → gift, gold price in 元 (total_coin/1000)", () => {
    const msg = {
      cmd: "SEND_GIFT",
      data: {
        giftName: "小心心",
        num: 3,
        uname: "土豪",
        uid: 999,
        timestamp: 1700000000, // unix 秒
        coin_type: "gold",
        total_coin: 5200, // 金瓜子 → 5.2 元
      },
    };
    const m = mapCmdToDanmu(msg)!;
    expect(m.kind).toBe("gift");
    expect(m.giftName).toBe("小心心");
    expect(m.giftCount).toBe(3);
    expect(m.uid).toBe("999");
    expect(m.price).toBeCloseTo(5.2, 6);
    expect(m.tsMs).toBe(1700000000 * 1000); // 秒 → 毫秒
  });

  it("SEND_GIFT silver (free) gift → price 0", () => {
    const m = mapCmdToDanmu({
      cmd: "SEND_GIFT",
      data: { giftName: "辣条", num: 1, uname: "路人", uid: 1, timestamp: 1700000000, coin_type: "silver", total_coin: 100 },
    })!;
    expect(m.price).toBe(0);
  });

  it("maps INTERACT_WORD msg_type=1 → member (enter)", () => {
    const m = mapCmdToDanmu({
      cmd: "INTERACT_WORD",
      data: { uname: "新人", uid: 42, timestamp: 1700000000, msg_type: 1 },
    })!;
    expect(m.kind).toBe("member");
    expect(m.user).toBe("新人");
    expect(m.uid).toBe("42");
    expect(m.tsMs).toBe(1700000000 * 1000);
  });

  it("ignores INTERACT_WORD non-enter (msg_type=2 follow)", () => {
    expect(mapCmdToDanmu({ cmd: "INTERACT_WORD", data: { msg_type: 2, uid: 1, timestamp: 1700000000 } })).toBeNull();
  });

  it("returns null for unknown cmd", () => {
    expect(mapCmdToDanmu({ cmd: "ONLINE_RANK_COUNT" })).toBeNull();
  });
});
