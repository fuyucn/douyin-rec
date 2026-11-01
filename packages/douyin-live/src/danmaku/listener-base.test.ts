import { describe, it, expect } from "vitest";
import { ListenerDanmuSource } from "./listener-base.js";

// 直接 import 基类源文件(只引 @drec/core 类型 + 动态 import ./danmu-cookie.js,均无 sm-crypto)——
// **不能** import @drec/douyin-live 包(其 index 拉 sm-crypto,vitest 无法 import)。故这里只断言
// 基类 ListenerDanmuSource 的平台无关行为(用本地测试子类)。
// 抖音子类的真实抓取由 docker 真录覆盖 + test/setup.ts 假平台的 connectDanmu 钩子。

/** 测试用的 RecordOpts(基类只用 cookies 字段;不传 cookies → buildDanmuCookie 不触网络)。 */
const OPTS = { quality: "origin", outDir: ".", segmentSec: 0 } as const;
describe("弹幕监听共享基类 ListenerDanmuSource", () => {
  it("健康监控:resolveLiveId 失败 → onAlert 告警且不连 WS(不碰网络)", async () => {
    // 测试子类:liveId 解析返 null(在 loadClientCtor/buildDanmuCookie 之前 → 不触网络)。
    class NullLiveId extends ListenerDanmuSource {
      readonly name = "test-null";
      protected async loadClientCtor(): Promise<never> { throw new Error("不该被调用"); }
      protected async resolveLiveId(): Promise<string | null> { return null; }
    }
    const s = new NullLiveId();
    const alerts: string[] = [];
    await s.start(
      "https://live.douyin.com/123",
      { quality: "origin", outDir: ".", segmentSec: 0 },
      () => {},
      (m) => alerts.push(m),
    );
    expect(alerts).toHaveLength(1);
    expect(alerts[0]).toContain("拿不到本场 liveId"); // 整场无弹幕 → 告警(防静默失败)
  });

  it("stop() 在未 start 时安全幂等（无 client 也不抛）", async () => {
    class NullLiveId extends ListenerDanmuSource {
      readonly name = "test-null2";
      protected async loadClientCtor(): Promise<never> { throw new Error("不该被调用"); }
      protected async resolveLiveId(): Promise<string | null> { return null; }
    }
    await expect(new NullLiveId().stop()).resolves.toBeUndefined();
  });

  it("ControlMessage(action=3) → 转成 onStreamEndHint 提示(不是收播结论)", async () => {
    // 假 client:start 后立刻触发 open + control(action=3),模拟平台宣告本场结束。
    class FakeClient {
      private h: Record<string, ((...a: unknown[]) => void)[]> = {};
      on(ev: string, cb: (...a: unknown[]) => void): void { (this.h[ev] ??= []).push(cb); }
      async connect(): Promise<void> { this.h.open?.forEach((f) => f()); this.h.control?.forEach((f) => f({ action: 3, tips: "直播已结束" })); }
      close(): void { /* noop */ }
    }
    class Sub extends ListenerDanmuSource {
      readonly name = "test-hint";
      protected async resolveLiveId(): Promise<string | null> { return "live-1"; }
      protected async loadClientCtor(): Promise<never> { return FakeClient as unknown as never; }
    }
    const s = new Sub();
    const hints: Array<{ tips?: string }> = [];
    await s.start(
      "https://live.douyin.com/123",
      { quality: "origin", outDir: ".", segmentSec: 0 },
      () => {},
      () => {},
      (info) => hints.push(info),
    );
    expect(hints).toHaveLength(1);
    expect(hints[0].tips).toBe("直播已结束");
  });

  it("重连耗尽(exhausted) → 告警提示已停止重连,不无限刷", async () => {
    // 假 client:connect 后立刻触发 exhausted(模拟连续闪断达上限)。
    class FakeClient {
      private h: Record<string, ((...a: unknown[]) => void)[]> = {};
      on(ev: string, cb: (...a: unknown[]) => void): void { (this.h[ev] ??= []).push(cb); }
      async connect(): Promise<void> {
        this.h.open?.forEach((f) => f());
        this.h.exhausted?.forEach((f) => f(5));
      }
      close(): void { /* noop */ }
    }
    class Sub extends ListenerDanmuSource {
      readonly name = "test-exhausted";
      protected async resolveLiveId(): Promise<string | null> { return "live-1"; }
      protected async loadClientCtor(): Promise<never> { return FakeClient as unknown as never; }
    }
    const s = new Sub();
    const alerts: string[] = [];
    await s.start(
      "https://live.douyin.com/123",
      OPTS,
      () => {},
      (m) => alerts.push(m),
    );
    expect(alerts.some((a) => a.includes("已停止重连"))).toBe(true);
    expect(alerts.some((a) => a.includes("不影响视频录制"))).toBe(true);
  });
});

describe("弹幕源 start 期间 stop 生效 (issue #431)", () => {
  it("resolveLiveId 挂起期间 stop → 不 loadClientCtor、不建连、不误告警", async () => {
    let releaseLiveId!: (v: string | null) => void;
    let ctorCalls = 0;
    class Sub extends ListenerDanmuSource {
      readonly name = "test-stop-liveid";
      protected async resolveLiveId(): Promise<string | null> {
        await new Promise<string | null>((r) => { releaseLiveId = r; });
        return "live-1";
      }
      protected async loadClientCtor(): Promise<never> {
        ctorCalls++;
        throw new Error("不该被调用");
      }
    }
    const s = new Sub();
    const alerts: string[] = [];
    const started = s.start("https://live.douyin.com/123", OPTS, () => {}, (m) => alerts.push(m));
    // start 停在 resolveLiveId → stop → 放行 → start 应直接返回,不再建连
    await s.stop();
    releaseLiveId("live-1");
    await started;
    expect(ctorCalls).toBe(0);
    expect(alerts).toHaveLength(0); // 中途 stop 是正常取消,不算弹幕健康故障
  });

  it("loadClientCtor 挂起期间 stop → 不构造 client", async () => {
    let park!: () => void;
    const parked = new Promise<void>((r) => { park = r; });
    let release!: () => void;
    const gate = new Promise<void>((r) => { release = r; });
    let constructed = 0;
    class FakeClient {
      private h: Record<string, ((...a: unknown[]) => void)[]> = {};
      constructor() { constructed++; }
      on(ev: string, cb: (...a: unknown[]) => void): void { (this.h[ev] ??= []).push(cb); }
      async connect(): Promise<void> { /* 不该到达 */ }
      close(): void { /* noop */ }
    }
    class Sub extends ListenerDanmuSource {
      readonly name = "test-stop-ctor";
      protected async resolveLiveId(): Promise<string | null> { return "live-1"; }
      protected async loadClientCtor(): Promise<never> { park(); await gate; return FakeClient as unknown as never; }
    }
    const s = new Sub();
    const started = s.start("https://live.douyin.com/123", OPTS, () => {});
    await parked;
    await s.stop();
    release();
    await started;
    expect(constructed).toBe(0); // stop 生效:loadClientCtor 返回后不再 new Ctor
  });

  it("connect 挂起期间 stop → 建连完成后立即关闭,不留看门狗/僵尸连接", async () => {
    let connectParked!: () => void;
    const connectParkedP = new Promise<void>((r) => { connectParked = r; });
    let releaseConnect!: () => void;
    const connectGate = new Promise<void>((r) => { releaseConnect = r; });
    let closeCalls = 0;
    class FakeClient {
      private h: Record<string, ((...a: unknown[]) => void)[]> = {};
      on(ev: string, cb: (...a: unknown[]) => void): void { (this.h[ev] ??= []).push(cb); }
      async connect(): Promise<void> { connectParked(); await connectGate; }
      close(): void { closeCalls++; }
    }
    class Sub extends ListenerDanmuSource {
      readonly name = "test-stop-connect";
      protected async resolveLiveId(): Promise<string | null> { return "live-1"; }
      protected async loadClientCtor(): Promise<never> { return FakeClient as unknown as never; }
    }
    const s = new Sub();
    const started = s.start("https://live.douyin.com/123", OPTS, () => {});
    await connectParkedP; // 已停进 client.connect()
    await s.stop(); // stop → 立即 close 当前 client
    releaseConnect(); // connect 返回 → start 观察到 stopped → 再 close(幂等双保险)并返回
    await started;
    expect(closeCalls).toBeGreaterThanOrEqual(1);
  });

  it("stop() 置 stopped 标志:start 中途的每个 await 后都会检查(此处在 connect 之后 stop 不复活)", async () => {
    // start 已完成(连接建立)→ stop → 健康看门狗被清、client 被关;后续无重连/无告警。
    let closeCalls = 0;
    class FakeClient {
      private h: Record<string, ((...a: unknown[]) => void)[]> = {};
      on(ev: string, cb: (...a: unknown[]) => void): void { (this.h[ev] ??= []).push(cb); }
      async connect(): Promise<void> { this.h.open?.forEach((f) => f()); }
      close(): void { closeCalls++; }
    }
    class Sub extends ListenerDanmuSource {
      readonly name = "test-stop-after";
      protected async resolveLiveId(): Promise<string | null> { return "live-1"; }
      protected async loadClientCtor(): Promise<never> { return FakeClient as unknown as never; }
    }
    const s = new Sub();
    const alerts: string[] = [];
    await s.start("https://live.douyin.com/123", OPTS, () => {}, (m) => alerts.push(m));
    expect(closeCalls).toBe(0); // 正常启动不触发 close
    await s.stop();
    expect(closeCalls).toBe(1);
    await s.stop(); // 幂等
    expect(closeCalls).toBe(1);
    expect(alerts).toHaveLength(0);
  });

  it("代次:start(A) 进行中 → stop → start(B),A 恢复后不建连,B 正常建连", async () => {
    const releases: Array<(v: string) => void> = [];
    let constructed = 0;
    class FakeClient {
      constructor() { constructed++; }
      on(): void { /* noop */ }
      async connect(): Promise<void> { /* noop */ }
      close(): void { /* noop */ }
    }
    class Sub extends ListenerDanmuSource {
      readonly name = "test-generation";
      protected async resolveLiveId(): Promise<string | null> {
        return new Promise<string>((r) => { releases.push(r); });
      }
      protected async loadClientCtor(): Promise<never> { return FakeClient as unknown as never; }
    }
    const s = new Sub();
    const a = s.start("https://live.douyin.com/123", OPTS, () => {});
    await s.stop();
    const b = s.start("https://live.douyin.com/123", OPTS, () => {});
    releases[0]("live-A"); // A 恢复:代次已过期 → 不建连
    await a;
    expect(constructed).toBe(0);
    releases[1]("live-B");
    await b;
    expect(constructed).toBe(1);
    await s.stop();
  });
});
