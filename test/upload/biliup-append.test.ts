// test/upload/biliup-append.test.ts
import { describe, it, expect } from "vitest";
import { appendGroup, buildAppendArgs, uploadThenAppend, uploadThenAppendGroups } from "../../packages/app/src/upload/biliup.js";
import { APPEND_REREAD_DELAYS_MS, APPEND_UNREADABLE_REREAD_DELAYS_MS } from "../../packages/processors/src/run-biliup.js";

// 防御:append 也带关水印 + 仅自己可见(防 append 重置稿件设置,见 biliup.ts 注释)。
const WM = '{"watermark":{"state":0}}';
// 提交接口显式 web(app 默认更易触发 21566 风控,见 uploadSubmit 注释)。
const SUBMIT = ["--submit", "web"];

describe("P1→append", () => {
  it("buildAppendArgs 带关水印 + 仅自己可见(public 省略=私有)", () => {
    expect(buildAppendArgs({ cookies: "c.json", bv: "BV1", files: ["d.mp4", "l.mp4"] }))
      .toEqual(["-u", "c.json", "append", "--vid", "BV1", ...SUBMIT, "--extra-fields", WM, "--is-only-self", "1", "d.mp4", "l.mp4"]);
  });
  it("buildAppendArgs public:true → 关水印但不加 is-only-self", () => {
    expect(buildAppendArgs({ cookies: "c.json", bv: "BV1", files: ["d.mp4"], public: true }))
      .toEqual(["-u", "c.json", "append", "--vid", "BV1", ...SUBMIT, "--extra-fields", WM, "d.mp4"]);
  });
  it("buildAppendArgs 显式线路加 --line", () => {
    expect(buildAppendArgs({ cookies: "c.json", bv: "BV1", files: ["d.mp4"], line: "alia" }))
      .toEqual(["-u", "c.json", "append", "--vid", "BV1", ...SUBMIT, "--extra-fields", WM, "--is-only-self", "1", "--line", "alia", "d.mp4"]);
  });
  it("appendGroup：分块连接错误时自动换线", async () => {
    const calls: string[][] = [];
    const run = async (argv: string[]): Promise<string> => {
      calls.push(argv);
      if (argv.includes("alia")) {
        throw new Error("biliup 失败 (rc=1): connection error uploader.rs:557 start=52428800 end=62914560");
      }
      return "appended";
    };
    await appendGroup({
      cookies: "c.json", bv: "BV1", files: ["d.mp4"], run, lines: ["alia", "txa"],
    });
    expect(calls[0]).toContain("alia");
    expect(calls[1]).toContain("txa");
  });

  it("appendGroup：countParts 显示分P 已增加 → 视为成功,不再换线重试(幂等)", async () => {
    const calls: string[][] = [];
    const run = async (argv: string[]): Promise<string> => {
      calls.push(argv);
      throw new Error("biliup 失败 (rc=1): connection error uploader.rs:557 start=0 end=1024");
    };
    const counts = [1, 2]; // before=1 → after=2:服务端其实已追加
    await appendGroup({
      cookies: "c.json", bv: "BV1", files: ["d.mp4"], run, lines: ["alia", "txa"],
      countParts: async () => counts.shift() ?? 2,
    });
    expect(calls).toHaveLength(1); // 没有换到第二条线路
  });

  it("appendGroup：countParts 无法确认 → 抛 ambiguous 且不换线(调用方不得重试)", async () => {
    const calls: string[][] = [];
    const run = async (argv: string[]): Promise<string> => {
      calls.push(argv);
      throw new Error("biliup 失败 (rc=1): connection error uploader.rs:557 start=0 end=1024");
    };
    await expect(appendGroup({
      cookies: "c.json", bv: "BV1", files: ["d.mp4"], run, lines: ["alia", "txa"],
      countParts: async () => null,
    })).rejects.toThrow(/append-ambiguous/);
    expect(calls).toHaveLength(1);
  });

  it("appendGroup：countParts 确认未提交 → 继续换线(安全重试)", async () => {
    const calls: string[][] = [];
    const run = async (argv: string[]): Promise<string> => {
      calls.push(argv);
      if (argv.includes("alia")) {
        throw new Error("biliup 失败 (rc=1): connection error uploader.rs:557 start=0 end=1024");
      }
      return "appended";
    };
    await appendGroup({
      cookies: "c.json", bv: "BV1", files: ["d.mp4"], run, lines: ["alia", "txa"],
      countParts: async () => 1, // before=after=1 → 未提交
      sleep: async () => {},
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("txa");
  });

  const failRun = (calls: string[][], okOn?: string) => async (argv: string[]): Promise<string> => {
    calls.push(argv);
    if (okOn && argv.includes(okOn)) return "appended";
    throw new Error("biliup 失败 (rc=1): connection error uploader.rs:557 start=0 end=1024");
  };

  it("appendGroup(#66)：回读延迟刷新 → 重读到变多,不换线、不重复追加", async () => {
    const calls: string[][] = [];
    const sleeps: number[] = [];
    const counts = [1, 1, 1, 2]; // before, then two stale re-reads, then refreshed
    await appendGroup({
      cookies: "c.json", bv: "BV1", files: ["d.mp4"], run: failRun(calls), lines: ["alia", "txa"],
      countParts: async () => counts.shift() ?? 2,
      sleep: async (ms) => { sleeps.push(ms); },
    });
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([3000, 3000]);
  });

  it("appendGroup(#66)：整个重读窗口都没变 → 照旧换线,窗口约 10s", async () => {
    const calls: string[][] = [];
    const sleeps: number[] = [];
    let reads = 0;
    await appendGroup({
      cookies: "c.json", bv: "BV1", files: ["d.mp4"], run: failRun(calls, "txa"), lines: ["alia", "txa"],
      countParts: async () => { reads++; return 1; },
      sleep: async (ms) => { sleeps.push(ms); },
    });
    expect(calls).toHaveLength(2);
    expect(calls[1]).toContain("txa");
    expect(sleeps).toEqual([...APPEND_REREAD_DELAYS_MS]);
    expect(sleeps.reduce((a, b) => a + b, 0)).toBeGreaterThanOrEqual(10_000);
    expect(reads).toBe(1 + 1 + APPEND_REREAD_DELAYS_MS.length);
  });

  it("appendGroup(#66)：重读中途读不到 → ambiguous,不换线", async () => {
    const calls: string[][] = [];
    const counts: (number | null)[] = [1, 1, null];
    await expect(appendGroup({
      cookies: "c.json", bv: "BV1", files: ["d.mp4"], run: failRun(calls), lines: ["alia", "txa"],
      countParts: async () => counts.shift() ?? null,
      sleep: async () => {},
    })).rejects.toThrow(/append-ambiguous/);
    expect(calls).toHaveLength(1);
  });

  it("appendGroup(#310)：重读读不到、延迟后恢复且变多 → 视为已提交,不换线不转人工", async () => {
    const calls: string[][] = [];
    const sleeps: number[] = [];
    const counts: (number | null)[] = [1, null, null, 2]; // before, then two unreadable reads, then committed
    await appendGroup({
      cookies: "c.json", bv: "BV1", files: ["d.mp4"], run: failRun(calls), lines: ["alia", "txa"],
      countParts: async () => (counts.length > 0 ? counts.shift()! : 2),
      sleep: async (ms) => { sleeps.push(ms); },
    });
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([5000, 10000]);
  });

  it("appendGroup(#310)：恢复后数量没变 → 仍要走完整的 #66 窗口才换线", async () => {
    const calls: string[][] = [];
    const sleeps: number[] = [];
    const counts: (number | null)[] = [1, null, 1, 1, 1, 1];
    await appendGroup({
      cookies: "c.json", bv: "BV1", files: ["d.mp4"], run: failRun(calls, "txa"), lines: ["alia", "txa"],
      countParts: async () => (counts.length > 0 ? counts.shift()! : 1),
      sleep: async (ms) => { sleeps.push(ms); },
    });
    expect(calls).toHaveLength(2);
    expect(sleeps).toEqual([5000, ...APPEND_REREAD_DELAYS_MS]);
  });

  it("appendGroup(#310)：恢复后数量没变、窗口内刷新变多 → 已提交,不重复追加", async () => {
    const calls: string[][] = [];
    const counts: (number | null)[] = [1, null, 1, 2];
    await appendGroup({
      cookies: "c.json", bv: "BV1", files: ["d.mp4"], run: failRun(calls), lines: ["alia", "txa"],
      countParts: async () => (counts.length > 0 ? counts.shift()! : 2),
      sleep: async () => {},
    });
    expect(calls).toHaveLength(1);
  });

  it("appendGroup(#310)：未变 → 读不到 → 未变(混合)→ ambiguous,不换线", async () => {
    const calls: string[][] = [];
    const counts: (number | null)[] = [1, 1, null, 1];
    await expect(appendGroup({
      cookies: "c.json", bv: "BV1", files: ["d.mp4"], run: failRun(calls), lines: ["alia", "txa"],
      countParts: async () => (counts.length > 0 ? counts.shift()! : 1),
      sleep: async () => {},
    })).rejects.toThrow(/append-ambiguous/);
    expect(calls).toHaveLength(1);
  });

  it("appendGroup(#310)：延迟窗口内始终读不到 → 仍然 ambiguous,不换线,窗口约 30s", async () => {
    const calls: string[][] = [];
    const sleeps: number[] = [];
    const counts: (number | null)[] = [1];
    await expect(appendGroup({
      cookies: "c.json", bv: "BV1", files: ["d.mp4"], run: failRun(calls), lines: ["alia", "txa"],
      countParts: async () => counts.shift() ?? null,
      sleep: async (ms) => { sleeps.push(ms); },
    })).rejects.toThrow(/append-ambiguous/);
    expect(calls).toHaveLength(1);
    expect(sleeps).toEqual([...APPEND_UNREADABLE_REREAD_DELAYS_MS]);
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
    // second call should be the append call(public:false → 带 is-only-self)
    expect(calls[1]).toEqual(["-u", "c.json", "append", "--vid", "BV9Ab4y1C7xY", ...SUBMIT, "--extra-fields", WM, "--is-only-self", "1", "d.mp4", "l.mp4"]);
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
    expect(calls[1]).toEqual(["-u", "c.json", "append", "--vid", "BV9Ab4y1C7xY", ...SUBMIT, "--extra-fields", WM, "--is-only-self", "1", "d0.mp4", "d1.mp4"]);
    expect(calls[2]).toEqual(["-u", "c.json", "append", "--vid", "BV9Ab4y1C7xY", ...SUBMIT, "--extra-fields", WM, "--is-only-self", "1", "l.mp4"]);
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
    expect(calls[1]).toContain("BV1Ab4y1C7xY");
  });
});
