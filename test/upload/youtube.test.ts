import { describe, it, expect } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildYoutubeArgs, checkYoutube, normalizeYoutubeTitle, parseYoutubeVideoId } from "../../packages/app/src/upload/youtube.js";

const VALID_SECRETS = JSON.stringify({ web: { client_id: "x", client_secret: "y" }, installed: { client_id: "x", client_secret: "y" } });

describe("youtube upload 包装", () => {
  it("buildYoutubeArgs：默认安全参数", () => {
    const a = buildYoutubeArgs({
      video: "/o/x.mp4",
      title: "直播录像",
      secrets: "/s/client_secrets.json",
      cache: "/s/request.token",
    });
    const s = a.join(" ");
    expect(s).toContain("-filename /o/x.mp4");
    expect(s).toContain("-title 直播录像");
    expect(s).toContain("-privacy private");          // 安全默认：私有
    expect(s).toContain("-notify false");              // 默认不通知订阅者
    expect(s).toContain("-sendFilename false");
    expect(s).toContain("-secrets /s/client_secrets.json");
    expect(s).toContain("-cache /s/request.token");
    expect(s).toContain("-quiet");
  });

  it("buildYoutubeArgs：可配 tags/category/public/notify", () => {
    const a = buildYoutubeArgs({
      video: "/o/x.mp4",
      title: "t",
      secrets: "/s.json",
      cache: "/tok",
      visibility: "unlisted",
      tags: ["a", "b"],
      categoryId: "20",
      notifySubscribers: true,
      quiet: false,
    });
    const s = a.join(" ");
    expect(s).toContain("-privacy unlisted");
    expect(s).toContain("-tags a,b");
    expect(s).toContain("-categoryId 20");
    expect(s).toContain("-notify true");
    expect(s).not.toContain("-quiet");
  });

  it("parseYoutubeVideoId：从 youtubeuploader 输出抓 Video ID", () => {
    expect(parseYoutubeVideoId("\nUpload successful! Video ID: AbC12345678\n")).toBe("AbC12345678");
    expect(parseYoutubeVideoId("无 Video ID 输出")).toBeNull();
  });

  it("normalizeYoutubeTitle：超过 100 个字符会截断", () => {
    expect(normalizeYoutubeTitle(" 固定标题 ")).toBe("固定标题");
    const long = "a".repeat(110);
    expect(Array.from(normalizeYoutubeTitle(long))).toHaveLength(100);
    expect(normalizeYoutubeTitle(long)).toMatch(/…$/);
  });

  it("checkYoutube：默认要求 request.token 已就位", async () => {
    const dir = mkdtempSync(join(tmpdir(), "yt-check-"));
    writeFileSync(join(dir, "client_secrets.json"), VALID_SECRETS);
    const err = await checkYoutube({
      secrets: join(dir, "client_secrets.json"),
      cache: join(dir, "request.token"),
    });
    expect(err).toContain("request.token 不存在");
  });

  it("checkYoutube：client_secrets 只是占位 JSON 时报明确错误", async () => {
    const dir = mkdtempSync(join(tmpdir(), "yt-check-secrets-"));
    writeFileSync(join(dir, "client_secrets.json"), "{}");
    const err = await checkYoutube({
      secrets: join(dir, "client_secrets.json"),
      cache: join(dir, "request.token"),
    });
    expect(err).toContain("client_secrets 结构不完整");
  });

  it("checkYoutube：request.token 没有 refresh_token 时不能当授权成功", async () => {
    const dir = mkdtempSync(join(tmpdir(), "yt-check-token-"));
    writeFileSync(join(dir, "client_secrets.json"), VALID_SECRETS);
    writeFileSync(join(dir, "request.token"), JSON.stringify({ access_token: "x" }));
    const err = await checkYoutube({
      secrets: join(dir, "client_secrets.json"),
      cache: join(dir, "request.token"),
    });
    expect(err).toContain("request.token 缺 refresh_token");
  });
});
