import { describe, it, expect } from "vitest";
import { redactLogLine, redactLogLines } from "../../packages/core/src/redact-log.js";

describe("redactLogLine(日志脱敏)", () => {
  it("vendored 取流异常里的整串 cookie 被遮掉(实测形态)", () => {
    // 全部是编造的夹具值;issue-guard: allow (假房间号 + 假凭证)
    const line = `API web failed: Unexpected resp, code 4001038, msg {"prompts":"x"}, id 999000111222, cookies: ttwid=1%7CAREnbnZL; UIFID_TEMP=f2b2871c02; UIFID=f2b2871c02`; // issue-guard: allow (夹具)

    const out = redactLogLine(line);
    expect(out).not.toContain("ttwid=1%7CAREnbnZL");
    expect(out).not.toContain("UIFID_TEMP=f2b2871c02");
    expect(out).toContain("cookies: <redacted>");
    // 保留可诊断的部分
    expect(out).toContain("4001038");
    expect(out).toContain("id 999000111222"); // issue-guard: allow (同上,夹具)
  });

  it("常见凭证键(抖音/B站)无论出现在哪都被遮", () => {
    const out = redactLogLine("sessionid=abc123; SESSDATA=xyz; bili_jct=tok; DedeUserID=42; msToken=long");
    expect(out).not.toContain("abc123");
    expect(out).not.toContain("xyz");
    expect(out).not.toContain("tok");
    expect(out).not.toContain("42");
    expect(out).not.toContain("long");
  });

  it("带引号的 cookie 串也遮;cookie=(单数)同样处理", () => {
    expect(redactLogLine('cookie="a=b; c=d"')).toBe("cookie: <redacted>");
    expect(redactLogLine("cookie=abc")).toBe("cookie: <redacted>");
  });

  it("正常日志不动(不误伤)", () => {
    const line = "[06:50:01] [task 83] [rec] 开始录制: https://live.douyin.com/999000111222"; // issue-guard: allow (夹具)
    expect(redactLogLine(line)).toBe(line);
    expect(redactLogLine("")).toBe("");
  });

  it("批量保序", () => {
    expect(redactLogLines(["a", "cookies: x=y", "b"])).toEqual(["a", "cookies: <redacted>", "b"]);
  });
});
