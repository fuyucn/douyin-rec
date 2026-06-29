// test/upload/biliup-append.test.ts
import { describe, it, expect } from "vitest";
import { buildAppendArgs, uploadThenAppend, uploadThenAppendGroups } from "../../packages/app/src/upload/biliup.js";

describe("P1→append", () => {
  it("buildAppendArgs 形如 append --vid BV files", () => {
    expect(buildAppendArgs({ cookies: "c.json", bv: "BV1", files: ["d.mp4", "l.mp4"] }))
      .toEqual(["-u", "c.json", "append", "--vid", "BV1", "d.mp4", "l.mp4"]);
  });

  it("uploadThenAppend：先传 plain 拿 BV，再 append 两个分P", async () => {
    const calls: string[][] = [];
    const run = async (argv: string[]): Promise<string> => {
      calls.push(argv);
      return argv.includes("append") ? "appended" : "... bvid BV9Ab4y1C7xY ...";
    };
    const bv = await uploadThenAppend({
      plain: { video: "p.mp4", cookies: "c.json", title: "t", tag: "a", tid: 21, public: false },
      extras: ["d.mp4", "l.mp4"],
      run,
    });
    expect(bv).toBe("BV9Ab4y1C7xY");
    // first call should be the upload call
    expect(calls[0].includes("upload")).toBe(true);
    expect(calls[0].includes("p.mp4")).toBe(true);
    // second call should be the append call
    expect(calls[1]).toEqual(["-u", "c.json", "append", "--vid", "BV9Ab4y1C7xY", "d.mp4", "l.mp4"]);
  });

  it("uploadThenAppend：无 extras 时不调 append，返回 BV", async () => {
    const calls: string[][] = [];
    const run = async (argv: string[]): Promise<string> => {
      calls.push(argv);
      return "投稿成功 BV1Ab4y1C7xY";
    };
    const bv = await uploadThenAppend({
      plain: { video: "p.mp4", cookies: "c.json", title: "t", tag: "a", tid: 21, public: true },
      extras: [],
      run,
    });
    expect(bv).toBe("BV1Ab4y1C7xY");
    expect(calls).toHaveLength(1);
  });

  it("uploadThenAppend：upload 后解析不到 BV 则抛错", async () => {
    const run = async (_argv: string[]): Promise<string> => "上传完成，但没有BV号";
    await expect(
      uploadThenAppend({
        plain: { video: "p.mp4", cookies: "c.json", title: "t", tag: "a", tid: 21, public: false },
        extras: ["d.mp4"],
        run,
      })
    ).rejects.toThrow("BV");
  });
});

describe("uploadThenAppendGroups（每逻辑组一条 append）", () => {
  it("plain → BV，danmu 组(2段)一条 append，livechat 组一条 append", async () => {
    const calls: string[][] = [];
    const run = async (argv: string[]): Promise<string> => {
      calls.push(argv);
      return argv.includes("append") ? "appended" : "... bvid BV9Ab4y1C7xY ...";
    };
    const bv = await uploadThenAppendGroups({
      plain: { video: "p.mp4", cookies: "c.json", title: "t", tag: "a", tid: 21, public: false },
      groups: [["d0.mp4", "d1.mp4"], ["l.mp4"]],
      run,
    });
    expect(bv).toBe("BV9Ab4y1C7xY");
    expect(calls).toHaveLength(3); // upload + 2 appends（不是把 3 文件塞一条）
    expect(calls[0].includes("upload")).toBe(true);
    expect(calls[1]).toEqual(["-u", "c.json", "append", "--vid", "BV9Ab4y1C7xY", "d0.mp4", "d1.mp4"]);
    expect(calls[2]).toEqual(["-u", "c.json", "append", "--vid", "BV9Ab4y1C7xY", "l.mp4"]);
  });

  it("空组被跳过（不发空 append）", async () => {
    const calls: string[][] = [];
    const run = async (argv: string[]): Promise<string> => {
      calls.push(argv);
      return "投稿成功 BV1Ab4y1C7xY";
    };
    await uploadThenAppendGroups({
      plain: { video: "p.mp4", cookies: "c.json", title: "t", tag: "a", tid: 21, public: true },
      groups: [[], ["l.mp4"]],
      run,
    });
    expect(calls).toHaveLength(2); // upload + 仅 livechat 那一条
    expect(calls[1][4]).toBe("BV1Ab4y1C7xY");
  });
});
