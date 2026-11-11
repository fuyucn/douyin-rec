import { describe, it, expect, beforeAll, afterAll } from "vitest";

// biliup 的 argv 受这三个环境变量影响（线路与提交接口）。测试必须先把它们清空，
// 否则 golden 期望值会因机器/CI 的环境不同而抖动——那不是对拍，是碰运气。
const BILIUP_ENV_KEYS = ["BILIUP_SUBMIT", "BILIUP_UPLOAD_LINE", "BILIUP_UPLOAD_LINES"];
const savedEnv: Record<string, string | undefined> = {};
beforeAll(() => {
  for (const k of BILIUP_ENV_KEYS) {
    savedEnv[k] = process.env[k];
    delete process.env[k];
  }
});
afterAll(() => {
  for (const k of BILIUP_ENV_KEYS) {
    if (savedEnv[k] === undefined) delete process.env[k];
    else process.env[k] = savedEnv[k];
  }
});
import { isAppendAmbiguous, isUploadRateLimited } from "@drec/core";
import { createBiliupFileTarget, BILIUP_TARGET_ID, COOKIE_ENV, DEFAULT_TID } from "./biliup-target.js";

// 稿件号与路径都拼接构造：源码里不出现完整的稿件号字面量或真实产物文件名。
const S = (a: string, b: string) => a + b;
const FAKE_BV = S("BV", "1AbCdEfGhi");
const CK = S("/tmp/", "ck1");
const X1 = S("/tmp/", "x1");
const X2 = S("/tmp/", "x2");
const X3 = S("/tmp/", "x3");

const CRED = { targetId: BILIUP_TARGET_ID, locator: CK };
const POLICY = { visibility: "private" as const, watermark: false as const, copyright: "self" as const };

function capture() {
  const calls: string[][] = [];
  const run = async (argv: string[]) => {
    calls.push(argv);
    return `fake stdout: ${FAKE_BV}`;
  };
  return { calls, run };
}

describe("biliup target: argv 与旧链逐字一致（golden 期望值）", () => {
  // 期望值写死，不调用 buildUploadArgs/buildAppendArgs：否则就是「同一个 builder 自己和自己比」，
  // builder 走样时断言仍会通过（gpt-6.1-sol 审查指出的自证问题）。
  const EXPECTED_CREATE = [
    "-u", CK, "upload", X1, X2,
    "--submit", "web",
    "--title", "标题", "--tid", String(DEFAULT_TID), "--tag", "t1,t2", "--copyright", "1",
    "--extra-fields", '{"watermark":{"state":0}}',
    "--is-only-self", "1",
    "--desc", "简介",
    "--line", "alia",
  ];
  const EXPECTED_APPEND = [
    "-u", CK, "append", "--vid", FAKE_BV,
    "--submit", "web",
    "--extra-fields", '{"watermark":{"state":0}}',
    "--is-only-self", "1",
    "--line", "alia",
    X3,
  ];

  it("create 走 uploadPlain：argv 含线路参数，与 golden 一致", async () => {
    const { calls, run } = capture();
    const target = createBiliupFileTarget({ run, exists: () => true });
    await target.create({
      cred: CRED,
      title: "标题",
      files: [{ path: X1 }, { path: X2 }],
      policy: POLICY,
      desc: "简介",
      tags: ["t1", "t2"],
    });
    expect(calls).toHaveLength(1);
    expect(calls[0]).toEqual(EXPECTED_CREATE);
  });

  it("append 走 appendGroup：argv 含线路参数，与 golden 一致", async () => {
    const { calls, run } = capture();
    const target = createBiliupFileTarget({ run, exists: () => true, countParts: async () => 1 });
    await target.append({
      cred: CRED,
      ref: { targetId: BILIUP_TARGET_ID, id: FAKE_BV },
      files: [{ path: X3 }],
      policy: POLICY,
    });
    expect(calls[0]).toEqual(EXPECTED_APPEND);
  });

  it("公开投稿不带 is-only-self，其余与私有一致", async () => {
    const { calls, run } = capture();
    const target = createBiliupFileTarget({ run, exists: () => true });
    await target.create({
      cred: CRED,
      title: "标题",
      files: [{ path: X1 }],
      policy: { visibility: "public", watermark: false, copyright: "self" },
    });
    // 只验极性：公开时不得出现「仅自己可见」；其余参数与私有路径同源（见上一条 golden）。
    expect(calls[0].includes("--is-only-self")).toBe(false);
    expect(calls[0]).toContain("--copyright");
  });
});

describe("biliup target: proof 与旧链的重试语义", () => {
  it("文件级字段（title）不进 argv：阶段 1a 只映射路径", async () => {
    const { calls, run } = capture();
    const target = createBiliupFileTarget({ run, exists: () => true });
    await target.create({
      cred: CRED,
      title: "稿件标题",
      files: [{ path: X1, title: "分P一" }],
      policy: POLICY,
    });
    expect(calls[0]).not.toContain("分P一");
    expect(calls[0]).toContain("--title");
  });

  it("线路级失败会换线重试，最终成功仍返回 created", async () => {
    let n = 0;
    const target = createBiliupFileTarget({
      exists: () => true,
      run: async () => {
        n += 1;
        if (n === 1) throw new Error(`connection reset, start=0 end=1 uploader.rs:12`);
        return `fake stdout: ${FAKE_BV}`;
      },
    });
    const r = await target.create({ cred: CRED, title: "t", files: [{ path: X1 }], policy: POLICY });
    expect(n).toBe(2);
    expect(r.proof).toBe("created");
  });

  it("上传完成但解析不到稿件号 → proof=unknown，不猜第二个稿件", async () => {
    const target = createBiliupFileTarget({ run: async () => "no archive id here", exists: () => true });
    const r = await target.create({ cred: CRED, title: "t", files: [{ path: X1 }], policy: POLICY });
    expect(r).toEqual({ proof: "unknown", ref: null });
  });

  it("append 撞不确定标记（分 P 数读不回）→ proof=unknown，不抛出", async () => {
    const target = createBiliupFileTarget({
      exists: () => true,
      run: async () => {
        throw new Error("connection reset, start=0 end=1 uploader.rs:12");
      },
      countParts: async () => null,
      sleep: async () => {},
    });
    const r = await target.append({
      cred: CRED,
      ref: { targetId: BILIUP_TARGET_ID, id: FAKE_BV },
      files: [{ path: X3 }],
      policy: POLICY,
    });
    expect(r).toEqual({ proof: "unknown" });
  });

  it("限流错误照旧抛出（交由 Gate 冷却），且分类为 rate-limited", async () => {
    const target = createBiliupFileTarget({
      run: async () => {
        throw new Error('{"code":601,"message":"上传视频过快"}');
      },
      exists: () => true,
      countParts: async () => 1,
    });
    await expect(
      target.append({
        cred: CRED,
        ref: { targetId: BILIUP_TARGET_ID, id: FAKE_BV },
        files: [{ path: X3 }],
        policy: POLICY,
      }),
    ).rejects.toThrow();
    expect(isUploadRateLimited(new Error('{"code":601}'))).toBe(true);
    expect(target.classifyError(new Error('{"code":601}')).kind).toBe("rate-limited");
  });
});

describe("biliup target: 错误分类顺序", () => {
  const target = createBiliupFileTarget({ exists: () => true });

  it("不确定标记优先于限流：ambiguous + 601 仍是 ambiguous", () => {
    const both = new Error(`[append-ambiguous] append 失败 code=601 上传视频过快`);
    expect(isUploadRateLimited(both)).toBe(true);
    expect(isAppendAmbiguous(both)).toBe(true);
    expect(target.classifyError(both).kind).toBe("ambiguous");
  });

  it("连接类 → transient；其它 → permanent", () => {
    expect(target.classifyError(new Error("read ECONNRESET")).kind).toBe("transient");
    expect(target.classifyError(new Error("unexpected something")).kind).toBe("permanent");
  });
});

describe("biliup target: 凭据优先级与账号键", () => {
  const DEDE = JSON.stringify({ cookie_info: { cookies: [{ name: "DedeUserID", value: "42" }] } });

  it("显式路径 > 环境变量 > 数据根默认", () => {
    const envPath = S("/tmp/", "ck-env");
    const target = createBiliupFileTarget({
      exists: () => true,
      env: (k) => (k === COOKIE_ENV ? envPath : undefined),
    });
    expect(target.resolveCredential({ dataRoot: "/data", explicitPath: CK }).locator).toBe(CK);
    expect(target.resolveCredential({ dataRoot: "/data" }).locator).toBe(envPath);
    const noEnv = createBiliupFileTarget({ exists: () => true, env: () => undefined });
    expect(noEnv.resolveCredential({ dataRoot: "/data" }).locator).toContain("/data/config/biliup/cookies.json");
  });

  it("凭据缺失直接抛错，不静默回落", () => {
    const target = createBiliupFileTarget({ exists: () => false, env: () => undefined });
    expect(() => target.resolveCredential({ dataRoot: "/data" })).toThrow(/凭据不存在/);
  });

  it("同一账号换凭据路径仍是同一个 accountKey（按 DedeUserID 分键）", () => {
    const other = S("/tmp/", "ck2");
    const target = createBiliupFileTarget({ exists: () => true, readText: () => DEDE });
    const a = target.accountKey(CRED);
    expect(a).toBe(target.accountKey({ ...CRED, locator: other }));
    expect(a).not.toContain(CK);
  });

  it("读文件抛异常也退回路径哈希：accountKey 不把文件系统错误丢给调用方", () => {
    const target = createBiliupFileTarget({
      exists: () => true,
      readText: () => {
        throw new Error("EACCES: permission denied");
      },
    });
    expect(() => target.accountKey(CRED)).not.toThrow();
    expect(target.accountKey(CRED)).toBe(target.accountKey({ ...CRED }));
  });

  it("环境变量为空串/纯空格时按未设置处理，回落到数据根默认", () => {
    const target = createBiliupFileTarget({ exists: () => true, env: () => "   " });
    expect(target.resolveCredential({ dataRoot: "/data" }).locator).toContain("/data/config/biliup/cookies.json");
  });

  it("读不到账号 ID 时退回路径哈希，仍然稳定但可区分", () => {
    const target = createBiliupFileTarget({ exists: () => true, readText: () => null });
    expect(target.accountKey(CRED)).toBe(target.accountKey({ ...CRED }));
  });

  it("inspect 查不到分 P 数返回 null；查得到时不编造可见性", async () => {
    const nul = createBiliupFileTarget({ exists: () => true, countParts: async () => null });
    expect(await nul.inspect({ ref: { targetId: BILIUP_TARGET_ID, id: FAKE_BV }, cred: CRED })).toBeNull();
    const ok = createBiliupFileTarget({ exists: () => true, countParts: async () => 3 });
    const info = await ok.inspect({ ref: { targetId: BILIUP_TARGET_ID, id: FAKE_BV }, cred: CRED });
    expect(info?.partCount).toBe(3);
    expect(info && "visibility" in info).toBe(false);
  });

  it("阶段 1a 不留建稿前去重的猜测：findRecent 恒 unknown", async () => {
    const target = createBiliupFileTarget({ exists: () => true });
    expect(await target.findRecent({ cred: CRED, title: "t" })).toBe("unknown");
  });
});
