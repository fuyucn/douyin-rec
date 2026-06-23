import { describe, it, expect } from "vitest";
import { createHash } from "node:crypto";
import { getMixinKey, keysFromWbiImg, encWbi } from "./wbi.js";

describe("wbi", () => {
  // bilibili 官方文档示例 key(用于验证乱序表 MIX 的实现正确)。
  const imgUrl = "https://i0.hdslb.com/bfs/wbi/7cd084941338484aae1ad9425b84077c.png";
  const subUrl = "https://i0.hdslb.com/bfs/wbi/4932caff0ff746eab6f01bf08b70ac45.png";

  it("keysFromWbiImg 取 basename 去扩展名", () => {
    const { imgKey, subKey } = keysFromWbiImg(imgUrl, subUrl);
    expect(imgKey).toBe("7cd084941338484aae1ad9425b84077c");
    expect(subKey).toBe("4932caff0ff746eab6f01bf08b70ac45");
  });

  it("getMixinKey 用官方乱序表得到已知 mixinKey", () => {
    const { imgKey, subKey } = keysFromWbiImg(imgUrl, subUrl);
    // bilibili 官方 demo 对这组 key 的期望输出。
    expect(getMixinKey(imgKey, subKey)).toBe("ea1db124af3c7062474693fa704f4ff8");
  });

  it("encWbi 注入固定 wts → 确定性 w_rid", () => {
    const { imgKey, subKey } = keysFromWbiImg(imgUrl, subUrl);
    const mixinKey = getMixinKey(imgKey, subKey);
    const wts = 1700000000;
    const q = encWbi({ id: 12345, type: 0, web_location: "444.8" }, mixinKey, wts);

    // 参数应按 key 排序:id < type < web_location < wts
    expect(q.startsWith("id=12345&type=0&web_location=444.8&wts=1700000000&w_rid=")).toBe(true);

    // w_rid 必须等于 md5(排序 query + mixinKey)
    const base = `id=12345&type=0&web_location=444.8&wts=${wts}`;
    const expected = createHash("md5").update(base + mixinKey).digest("hex");
    expect(q).toBe(`${base}&w_rid=${expected}`);
  });

  it("encWbi 过滤特殊字符 !'()*", () => {
    const q = encWbi({ k: "a!b'c(d)e*f" }, "x".repeat(32), 1);
    // 特殊字符被去除后再编码:abcdef
    expect(q).toContain("k=abcdef");
  });
});
