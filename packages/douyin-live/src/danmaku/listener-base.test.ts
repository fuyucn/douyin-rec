import { describe, it, expect } from "vitest";
import { ListenerDanmuSource } from "./listener-base.js";

// 直接 import 基类源文件(只引 @drec/core 类型 + 动态 import ./danmu-cookie.js,均无 sm-crypto)——
// **不能** import @drec/douyin-live 包(其 index 拉 sm-crypto,vitest 无法 import)。故这里只断言
// 基类 ListenerDanmuSource 的平台无关行为(用本地测试子类)。
// 抖音子类的真实抓取由 docker 真录覆盖 + test/setup.ts 假平台的 connectDanmu 钩子。
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
});
