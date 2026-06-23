import { describe, it, expect, beforeEach, afterEach } from "vitest";
import { mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { XmlDanmuWriter } from "./xml-writer.js";
import type { DanmuMessage } from "@drec/core";

let dir = "";
let path = "";
beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "xmlw-"));
  path = join(dir, "t.xml");
});
afterEach(() => rmSync(dir, { recursive: true, force: true }));

const dm = (over: Partial<DanmuMessage>): DanmuMessage =>
  ({ kind: "danmaku", tsMs: 1781390633000, user: "u", uid: "123", content: "hi", ...over }) as DanmuMessage;

describe("XmlDanmuWriter — biliLive RecorderXmlStyle 格式", () => {
  it("写出合法且含各类型的 XML", () => {
    const w = new XmlDanmuWriter();
    w.open(path, { anchorName: "测试主播", roomId: "123" });
    const base = 1_700_000_000_000;
    w.add({ kind: "danmaku", tsMs: base, user: "u1", uid: "1", content: "你好" });
    w.add({ kind: "gift", tsMs: base + 5000, user: "u2", giftName: "人气票", giftCount: 1, price: 0.1 });
    w.add({ kind: "member", tsMs: base + 8000, user: "u3", uid: "3" });
    w.close();

    const xml = readFileSync(path, "utf-8");
    expect(xml).toContain("<i>");
    expect(xml).toContain("</i>");                 // 始终闭合
    expect(xml).toMatch(/<d p="0\.000,/);          // danmaku 首条相对 0s
    expect(xml).toContain("你好");
    expect(xml).toContain('giftname="人气票"');
    expect(xml).toContain('<member ');
  });

  it("open() 即写出含 RecorderXmlStyle 样式表(id=s)、合法闭合的 xml", () => {
    const w = new XmlDanmuWriter();
    w.open(path, { anchorName: "看看新闻", roomId: "999" });
    const xml = readFileSync(path, "utf-8");
    expect(xml).toContain(`href="#s"`);
    expect(xml).toContain(`id="s"`); // 样式表存在 → 浏览器能渲染成表格
    expect(xml).toContain("<RecorderXmlStyle>");
    expect(xml.trimEnd().endsWith("</i>")).toBe(true);
    expect(xml).toContain("<user_name>看看新闻</user_name>");
  });

  it("<d> 用 9 段 p + user/uid/timestamp 属性(对齐 biliLive)", () => {
    const w = new XmlDanmuWriter();
    w.open(path, { anchorName: "a" });
    w.add(dm({ tsMs: 1000_000, uid: "42", user: "bob", content: "yo" }));
    const line = readFileSync(path, "utf-8").split("\n").find((l) => l.startsWith("<d "))!;
    expect(line).toMatch(/uid="42"/);
    expect(line).toMatch(/timestamp="1000000"/);
    // p: rel,1,25,16777215,tsMs,0,midHash,mid,0 → 9 段
    const p = line.match(/p="([^"]+)"/)![1].split(",");
    expect(p.length).toBe(9);
    expect(p[6]).toBe("42"); // midHash=uid
    expect(p[7]).toBe("42"); // mid=uid
  });

  it("video_start_time 被首条消息 epoch ms 原地回填(供 render 算礼物相对时间)", () => {
    const w = new XmlDanmuWriter();
    w.open(path, { anchorName: "a" });
    w.add(dm({ tsMs: 1781390633000 }));
    const xml = readFileSync(path, "utf-8");
    expect(xml).toContain("<video_start_time>1781390633000</video_start_time>");
  });

  it("锚到视频起点:丢弃开播前回灌历史 + 实时弹幕对齐真实视频秒", () => {
    const w = new XmlDanmuWriter();
    const videoStartMs = 1_700_000_000_000;
    w.open(path, { anchorName: "主播", videoStartMs });
    // ① WS 连上回灌的开播前历史(发送时间早于视频起点 14 分钟)→ 必须被丢弃
    w.add({ kind: "danmaku", tsMs: videoStartMs - 840_000, user: "old", uid: "9", content: "开播前的历史弹幕" });
    // ② 真实在 +5s / +12s 发的弹幕 → 落在 5.000 / 12.000(相对视频起点,不相对首条)
    w.add({ kind: "danmaku", tsMs: videoStartMs + 5000, user: "u1", uid: "1", content: "第5秒" });
    w.add({ kind: "danmaku", tsMs: videoStartMs + 12000, user: "u2", uid: "2", content: "第12秒" });
    w.close();

    const xml = readFileSync(path, "utf-8");
    // video_start_time = 视频起点(非首条消息)
    expect(xml).toContain(`<video_start_time>${videoStartMs}</video_start_time>`);
    // 开播前历史被丢弃
    expect(xml).not.toContain("开播前的历史弹幕");
    // 实时弹幕对齐视频真实秒(若锚错到首条,这两条会变成 0.000 / 7.000)
    expect(xml).toMatch(/<d p="5\.000,[^>]*>第5秒</);
    expect(xml).toMatch(/<d p="12\.000,[^>]*>第12秒</);
  });

  it("去重：同 tsMs/uid/内容的重发被丢弃，不同 tsMs 的保留", () => {
    const w = new XmlDanmuWriter();
    w.open(path, { anchorName: "a" });
    w.add(dm({ tsMs: 5000, uid: "1", content: "A" }));
    w.add(dm({ tsMs: 5000, uid: "1", content: "A" })); // 重发 → 丢弃
    w.add(dm({ tsMs: 6000, uid: "1", content: "A" })); // 不同时刻 → 保留
    const count = (readFileSync(path, "utf-8").match(/<d /g) ?? []).length;
    expect(count).toBe(2);
  });

  it("gift/member 带 uid，gift ts 为 epoch ms", () => {
    const w = new XmlDanmuWriter();
    w.open(path, { anchorName: "a" });
    w.add({ kind: "gift", tsMs: 1781390700000, user: "g", uid: "7", giftName: "花", giftCount: 2, price: 9.9 } as DanmuMessage);
    w.add({ kind: "member", tsMs: 1781390701000, user: "m", uid: "8" } as DanmuMessage);
    const xml = readFileSync(path, "utf-8");
    expect(xml).toMatch(/<gift user="g" uid="7" giftname="花" giftcount="2" price="9.9" ts="1781390700000"\/>/);
    expect(xml).toMatch(/<member user="m" uid="8" member_count="0" ts="1781390701000"\/>/);
  });

  it("无消息时仍写合法空 XML", () => {
    const w = new XmlDanmuWriter();
    w.open(path, { anchorName: "x" });
    w.close();
    const xml = readFileSync(path, "utf-8");
    expect(xml).toContain("<i>");
    expect(xml).toContain("</i>");
  });
});
