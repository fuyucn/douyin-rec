import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import { addArchiveToSeason, normalizeSeasonSectionId } from "./bili-season.js";

function loginFile(csrf = "csrf-token"): string {
  const dir = mkdtempSync(join(tmpdir(), "season-test-"));
  const p = join(dir, "login.json");
  writeFileSync(p, JSON.stringify({
    cookie_info: { cookies: [{ name: "SESSDATA", value: "s" }, { name: "bili_jct", value: csrf }] },
  }));
  return p;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("normalizeSeasonSectionId", () => {
  it("accepts only positive safe integers", () => {
    expect(normalizeSeasonSectionId(123)).toBe(123);
    expect(normalizeSeasonSectionId("123")).toBe(123);
    for (const bad of [0, -1, 1.5, "abc", "", null, undefined, Number.MAX_SAFE_INTEGER + 1]) {
      expect(normalizeSeasonSectionId(bad)).toBeUndefined();
    }
  });
});

describe("addArchiveToSeason", () => {
  it("resolves cid through the creator-center view and submits the section payload", async () => {
    const calls: Array<{ url: string; init?: RequestInit }> = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      calls.push({ url: u, init });
      if (u.includes("/x/vupre/web/archive/view")) {
        return json({ code: 0, data: { archive: { aid: 456, title: "replay" }, videos: [{ cid: 789 }] } });
      }
      if (u.includes("/season/section/episodes/add")) return json({ code: 0, data: null });
      return json({ code: -1, message: "unexpected" }, 404);
    }) as unknown as typeof fetch;

    const r = await addArchiveToSeason({ cookiesPath: loginFile(), sectionId: 123, bvid: "BVtest", fetchImpl });
    expect(r).toMatchObject({ status: "added", sectionId: 123, aid: 456, cid: 789, title: "replay" });

    const post = calls.find((c) => c.url.includes("/season/section/episodes/add"));
    expect(post?.url).toContain("csrf=csrf-token");
    expect(JSON.parse(String(post?.init?.body))).toEqual({
      sectionId: 123,
      episodes: [{ aid: 456, cid: 789, title: "replay", charging_pay: 0 }],
      csrf: "csrf-token",
    });
  });

  it("treats a rejected add as already-in-season when the section lists the archive", async () => {
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/x/vupre/web/archive/view")) {
        return json({ code: 0, data: { archive: { aid: 456, title: "replay" }, videos: [{ cid: 789 }] } });
      }
      if (u.includes("/season/section/episodes/add")) return json({ code: 1, message: "exists" });
      if (u.includes("/season/section?id=123")) return json({ code: 0, data: { episodes: [{ aid: 456 }] } });
      return json({}, 404);
    }) as unknown as typeof fetch;

    const r = await addArchiveToSeason({ cookiesPath: loginFile(), sectionId: 123, aid: 456, fetchImpl });
    expect(r).toMatchObject({ status: "already", sectionId: 123, aid: 456 });
  });

  it("reports a definite API rejection without retrying", async () => {
    let posts = 0;
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("/x/vupre/web/archive/view")) {
        return json({ code: 0, data: { archive: { aid: 456, title: "replay" }, videos: [{ cid: 789 }] } });
      }
      if (u.includes("/season/section/episodes/add")) { posts++; return json({ code: 7, message: "denied" }); }
      if (u.includes("/season/section?id=123")) return json({ code: 0, data: { episodes: [] } });
      return json({}, 404);
    }) as unknown as typeof fetch;

    const r = await addArchiveToSeason({ cookiesPath: loginFile(), sectionId: 123, aid: 456, fetchImpl });
    expect(r.status).toBe("failed");
    expect(posts).toBe(1);
  });

  it("skips when the section id is off, and fails safely without a complete login", async () => {
    expect(await addArchiveToSeason({ cookiesPath: "/nope", sectionId: 0 })).toEqual({ status: "skipped", reason: "合集小节 ID 未配置" });
    const dir = mkdtempSync(join(tmpdir(), "season-test-"));
    const p = join(dir, "login.json");
    writeFileSync(p, JSON.stringify({ cookie_info: { cookies: [{ name: "SESSDATA", value: "s" }] } }));
    const r = await addArchiveToSeason({ cookiesPath: p, sectionId: 123 });
    expect(r.status).toBe("failed");
  });
});
