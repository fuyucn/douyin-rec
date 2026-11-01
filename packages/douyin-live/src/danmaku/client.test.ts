import { describe, it, expect, vi, beforeEach, afterEach } from "vitest";
import { gzipSync } from "node:zlib";
import {
  DouYinDanmaClient,
  type DanmuWsFactory,
  type DanmuWsLike,
  type DanmaClientOptions,
} from "./client.js";

// client.ts 的签名 / 解码 / WS 工厂均可经构造参数注入(默认值 = vendored webmssdk.js/proto.js
// 管线 + 真实 ws);测试注入假实现:不触达 vendored 代码、不发起真实网络。
// 覆盖 issue #431 的 close/reconnect 语义:
//   close() 后重连定时器不得再建连;CONNECTING 态被 close 必须 terminate;
//   超时触发的重连先终止旧 socket;熔断语义(STABLE_CONNECTION_MS 清零 + autoReconnect 上限)不变。

/** 可控假 socket:readyState 用 ws 的标准数值(0 CONNECTING / 1 OPEN / 2 CLOSING / 3 CLOSED)。 */
class FakeWs implements DanmuWsLike {
  readyState = 0; // CONNECTING
  sent: Array<string | Uint8Array> = [];
  terminated = false;
  gracefulClosed = false;
  private h: Record<string, Array<(...args: unknown[]) => void>> = {};

  on(event: string, listener: (...args: unknown[]) => void): void {
    (this.h[event] ??= []).push(listener);
  }
  send(data: string | Uint8Array): void {
    this.sent.push(data);
  }
  close(): void {
    this.gracefulClosed = true;
    this.readyState = 2; // CLOSING
  }
  terminate(): void {
    const wasConnecting = this.readyState === 0;
    this.terminated = true;
    this.readyState = 3; // CLOSED
    // 真实 ws:CONNECTING 态 terminate → 异步先发 error("closed before the connection is established")
    // 再发 close;其余状态只发 close(此处也异步)。
    queueMicrotask(() => {
      if (wasConnecting) this.emit("error", new Error("WebSocket was closed before the connection was established"));
      this.emit("close");
    });
  }
  /** 测试手动触发事件(模拟真实 ws 的事件回调)。 */
  emit(event: string, ...args: unknown[]): void {
    for (const f of this.h[event] ?? []) f(...args);
  }
}

const openClients: DouYinDanmaClient[] = [];

function makeHarness(opts: DanmaClientOptions = {}): {
  client: DouYinDanmaClient;
  sockets: FakeWs[];
  urls: string[];
} {
  const sockets: FakeWs[] = [];
  const urls: string[] = [];
  const wsFactory: DanmuWsFactory = (url) => {
    urls.push(url);
    const ws = new FakeWs();
    sockets.push(ws);
    return ws;
  };
  const client = new DouYinDanmaClient("live-9", {
    sign: () => "SIG",
    cookie: "dummy=danmu-test", // 任意非空:跳过 fetchGuestCookie(测试不发真实网络请求)
    reconnectInterval: 10,
    wsFactory,
    ...opts,
  });
  openClients.push(client);
  return { client, sockets, urls };
}

beforeEach(() => {
  vi.useFakeTimers();
});

afterEach(() => {
  for (const c of openClients.splice(0)) c.close();
  vi.useRealTimers();
});

describe("DouYinDanmaClient close/reconnect 语义 (issue #431)", () => {
  it("connect 建连:走注入的 WS 工厂,URL 带注入签名与 room_id", async () => {
    const { client, sockets, urls } = makeHarness();
    await client.connect();
    expect(sockets).toHaveLength(1);
    expect(urls[0]).toContain("wss://webcast100-ws-web-hl.douyin.com/webcast/im/push/v2/");
    expect(urls[0]).toContain("signature=SIG");
    expect(urls[0]).toContain("room_id=live-9");
  });

  it("close() 后重连定时器不再触发 connect(不建新连接)", async () => {
    const { client, sockets, urls } = makeHarness();
    await client.connect();
    const s0 = sockets[0];
    s0.readyState = 1; // OPEN
    s0.emit("open");
    s0.emit("close"); // 闪断 → 调度 10ms 后重连(旧 socket 由 reconnect 先 terminate,不留僵尸)
    client.close(); // 清除重连定时器
    await vi.advanceTimersByTimeAsync(1000);
    expect(sockets).toHaveLength(1);
    expect(urls).toHaveLength(1); // 没有第二次 connect
    expect(s0.terminated || s0.gracefulClosed).toBe(true); // 旧 socket 已被处置
  });

  it("OPEN 态(未闪断)close() → 优雅关闭,无重连调度", async () => {
    const { client, sockets, urls } = makeHarness();
    await client.connect();
    const s0 = sockets[0];
    s0.readyState = 1;
    s0.emit("open");
    client.close();
    await vi.advanceTimersByTimeAsync(1000);
    expect(s0.gracefulClosed).toBe(true);
    expect(s0.terminated).toBe(false);
    expect(urls).toHaveLength(1);
  });

  it("CONNECTING 态被 close() → 立即 terminate;迟到的 open/close 事件不再产生心跳或新连接", async () => {
    const { client, sockets } = makeHarness();
    await client.connect(); // 假 socket 停在 CONNECTING(0)
    const s0 = sockets[0];
    client.close();
    expect(s0.terminated).toBe(true); // CONNECTING → terminate(旧实现什么都不做 → 僵尸半开连接)
    s0.emit("open"); // 迟到事件
    await vi.advanceTimersByTimeAsync(30_000);
    expect(s0.sent).toHaveLength(0); // 心跳未发出(this.ws 已清空)
    s0.emit("close"); // 迟到事件 → reconnect 被 closed 守卫拦下
    await vi.advanceTimersByTimeAsync(1000);
    expect(sockets).toHaveLength(1);
  });

  it("迟到 open 在已关闭 client 上:不 emit open、不启动心跳/超时/稳定定时器", async () => {
    const { client, sockets } = makeHarness({ timeoutInterval: 5000 });
    const opens: number[] = [];
    const errors: Error[] = [];
    client.on("open", () => opens.push(1));
    client.on("error", (e) => errors.push(e));
    await client.connect();
    client.close();
    sockets[0].readyState = 1;
    sockets[0].emit("open");
    expect(vi.getTimerCount()).toBe(0); // 没有任何定时器被启动
    await vi.advanceTimersByTimeAsync(200_000); // 若超时检查被启动,这里会触发重连
    expect(opens).toHaveLength(0);
    expect(errors).toHaveLength(0);
    expect(sockets).toHaveLength(1);
  });

  it("stop(close) 后 CONNECTING 态 terminate 异步补发的 error/close:不外抛 error/close 事件、不重连", async () => {
    const { client, sockets } = makeHarness();
    const errors: Error[] = [];
    const closes: number[] = [];
    client.on("error", (e) => errors.push(e));
    client.on("close", () => closes.push(1));
    await client.connect(); // 停在 CONNECTING
    client.close();
    await vi.advanceTimersByTimeAsync(1000); // 让 FakeWs 异步补发 error + close
    expect(sockets[0].terminated).toBe(true);
    expect(errors).toHaveLength(0); // 旧实现:此处会派发 error → listener-base 误告警
    expect(closes).toHaveLength(0);
    expect(sockets).toHaveLength(1);
  });

  it("超时重连 terminate 旧 socket 后异步补发的 close/error:旧 socket 事件被忽略(不重复重连)", async () => {
    const { client, sockets } = makeHarness({ timeoutInterval: 5000 });
    const errors: Error[] = [];
    client.on("error", (e) => errors.push(e));
    await client.connect();
    sockets[0].readyState = 1;
    sockets[0].emit("open");
    await vi.advanceTimersByTimeAsync(6100); // 超时 → terminate 旧 + 重连(新 socket)
    expect(sockets).toHaveLength(2);
    sockets[0].emit("error", new Error("late"));
    sockets[0].emit("close");
    await vi.advanceTimersByTimeAsync(1000);
    expect(errors).toHaveLength(0);
    expect(sockets).toHaveLength(2);
  });

  it("connect 等待签名期间被 close() → 不再建连", async () => {
    let releaseSign!: (v: string) => void;
    const gate = new Promise<string>((r) => {
      releaseSign = r;
    });
    const { client, sockets } = makeHarness({ sign: () => gate });
    const p = client.connect(); // 停在 sign await
    client.close();
    releaseSign("SIG");
    await p;
    expect(sockets).toHaveLength(0);
  });

  it("close() 之后手动 connect() 不建连", async () => {
    const { client, sockets } = makeHarness();
    client.close();
    await client.connect();
    expect(sockets).toHaveLength(0);
  });

  it("超时触发的重连:先 terminate 旧 socket,再建新连接", async () => {
    const { client, sockets } = makeHarness({ timeoutInterval: 5000 });
    await client.connect();
    const s0 = sockets[0];
    s0.readyState = 1;
    s0.emit("open");
    // timeoutCheck 每 1s 查一次,>5s 无消息 → reconnect(旧实现留着旧连接 → 新旧两条并存)
    await vi.advanceTimersByTimeAsync(6100);
    expect(s0.terminated).toBe(true);
    expect(sockets).toHaveLength(2);
  });

  it("重连回调开头的 closed 检查:绕过 clearTimeout 也不建连", async () => {
    const { client, sockets } = makeHarness();
    await client.connect();
    sockets[0].readyState = 1;
    sockets[0].emit("open");
    sockets[0].emit("close"); // 调度 10ms 后重连
    // clearTimeout 失效(模拟定时器清除不到):只剩回调内 closed 检查这一道防线。
    const spy = vi.spyOn(globalThis, "clearTimeout").mockImplementation(() => undefined);
    client.close();
    spy.mockRestore();
    await vi.advanceTimersByTimeAsync(1000);
    expect(sockets).toHaveLength(1);
  });

  it("熔断:连续闪断达 autoReconnect 上限 → exhausted,不再重连(语义不变)", async () => {
    const { client, sockets } = makeHarness({ autoReconnect: 2 });
    let exhaustedAttempts = -1;
    client.on("exhausted", (n) => {
      exhaustedAttempts = n;
    });
    await client.connect();
    for (let i = 0; i < 3; i++) {
      const s = sockets[i];
      s.readyState = 1;
      s.emit("open");
      s.emit("close");
      await vi.advanceTimersByTimeAsync(20); // 触发下一次重连(若有)
    }
    expect(exhaustedAttempts).toBe(2);
    expect(sockets).toHaveLength(3); // 第三次 close 后不再建连
  });

  it("熔断计数:存活满 60s(STABLE_CONNECTION_MS)清零 → 正常断流重连不误触发 exhausted", async () => {
    const { client, sockets } = makeHarness({ autoReconnect: 2 });
    let exhausted = false;
    client.on("exhausted", () => {
      exhausted = true;
    });
    await client.connect();
    for (let i = 0; i < 4; i++) {
      const s = sockets[i];
      s.readyState = 1;
      s.emit("open");
      await vi.advanceTimersByTimeAsync(60_000 + 1); // 存活满 STABLE_CONNECTION_MS → 计数清零
      s.emit("close");
      await vi.advanceTimersByTimeAsync(20);
    }
    expect(exhausted).toBe(false);
    expect(sockets).toHaveLength(5); // 1 + 4 次重连(计数每场被清零,永不触及上限)
  });
});

describe("DouYinDanmaClient 监听方异常隔离 (issue #431)", () => {
  it("监听方抛异常:同帧后续消息仍分发,且不向 message 回调外抛", async () => {
    const { client, sockets } = makeHarness({
      decode: () => ({
        messages: [
          { kind: "chat", msg: { user: { id: "u1", nickName: "N" }, content: "first", eventTime: "1" } },
          { kind: "chat", msg: { user: { id: "u2", nickName: "N" }, content: "second", eventTime: "2" } },
          { kind: "member", msg: { user: { id: "u3", nickName: "N" } } },
        ],
      }),
    });
    const seen: string[] = [];
    client.on("chat", (m) => {
      seen.push(m.content);
      if (m.content === "first") throw new Error("ENOSPC: 模拟落盘失败");
    });
    client.on("member", () => seen.push("member"));
    await client.connect();
    sockets[0].readyState = 1;
    sockets[0].emit("open");
    expect(() => sockets[0].emit("message", Buffer.from("x"))).not.toThrow();
    expect(seen).toEqual(["first", "second", "member"]);
  });
});

describe("DouYinDanmaClient 默认签名 (issue #431)", () => {
  afterEach(() => {
    vi.doUnmock("./webmssdk.js");
    vi.resetModules();
  });

  async function freshClient(): Promise<{ client: DouYinDanmaClient; urls: string[]; sockets: FakeWs[] }> {
    const mod = await import("./client.js");
    const urls: string[] = [];
    const sockets: FakeWs[] = [];
    const client = new mod.DouYinDanmaClient("live-9", {
      cookie: "dummy=danmu-test",
      decode: () => null,
      wsFactory: (url) => {
        urls.push(url);
        const ws = new FakeWs();
        sockets.push(ws);
        return ws;
      },
    });
    openClients.push(client);
    return { client, urls, sockets };
  }

  it("get_sign 调用抛错 → 回落全零兜底签名,照常建连", async () => {
    vi.resetModules();
    vi.doMock("./webmssdk.js", () => ({
      get_sign: () => {
        throw new Error("sign boom");
      },
    }));
    const { client, urls } = await freshClient();
    await client.connect();
    expect(urls).toHaveLength(1);
    expect(urls[0]).toContain(`signature=${"0".repeat(8)}`);
  });

  it("webmssdk 模块加载失败 → connect reject(不带废签名静默建连)", async () => {
    vi.resetModules();
    vi.doMock("./webmssdk.js", () => {
      throw new Error("module load boom");
    });
    const { client, sockets } = await freshClient();
    await expect(client.connect()).rejects.toThrow();
    expect(sockets).toHaveLength(0);
  });
});

describe("DouYinDanmaClient 解码注入与默认管线", () => {
  it("注入 decode:喂帧 → 对应事件;返回 null → 静默丢帧(不当连接错误)", async () => {
    const { client, sockets } = makeHarness({
      decode: (buf: Buffer) =>
        buf.length === 0
          ? null
          : {
              messages: [
                {
                  kind: "chat",
                  msg: { user: { id: "u1", nickName: "N" }, content: buf.toString("utf8"), eventTime: "1234567" },
                },
              ],
            },
    });
    const chats: unknown[] = [];
    const errors: Error[] = [];
    client.on("chat", (m) => chats.push(m));
    client.on("error", (e) => errors.push(e));
    await client.connect();
    sockets[0].emit("message", Buffer.from("hello"));
    sockets[0].emit("message", Buffer.alloc(0)); // → null → 静默丢
    expect(chats).toHaveLength(1);
    expect(chats[0]).toMatchObject({ content: "hello", user: { nickName: "N" } });
    expect(errors).toHaveLength(0);
  });

  it("默认解码管线(vendored proto):chat 帧解码 + needAck 回执;非 gzip 帧静默丢", async () => {
    const proto = (await import("./proto.js")).douyin;
    const { client, sockets } = makeHarness(); // sign 注入假实现,decode 不注入 → 默认管线
    const chats: unknown[] = [];
    const errors: Error[] = [];
    client.on("chat", (m) => chats.push(m));
    client.on("error", (e) => errors.push(e));
    await client.connect();
    const s0 = sockets[0];
    s0.readyState = 1;
    s0.emit("open");

    const chatPayload = proto.ChatMessage.encode(
      proto.ChatMessage.create({ content: "hi", user: { id: "1", nickName: "n" } }),
    ).finish();
    const resp = proto.Response.encode(
      proto.Response.create({
        needAck: true,
        internalExt: "ext-1",
        messagesList: [{ method: "WebcastChatMessage", payload: chatPayload }],
      }),
    ).finish();
    const push = proto.PushFrame.encode(
      proto.PushFrame.create({ logId: 42, payload: gzipSync(resp) }),
    ).finish();
    s0.emit("message", Buffer.from(push));

    expect(chats).toHaveLength(1);
    expect((chats[0] as { content: string }).content).toBe("hi");
    expect(s0.sent).toHaveLength(1); // ack 已发回
    const ack = proto.PushFrame.decode(s0.sent[0] as Buffer);
    expect(Number(ack.logId)).toBe(42);
    expect(ack.payloadType).toBe("ext-1");

    s0.emit("message", Buffer.from("PLAINTEXT-NOT-GZIP")); // 非 gzip 帧 → 静默丢
    expect(errors).toHaveLength(0);
    expect(s0.sent).toHaveLength(1);
  });
});
