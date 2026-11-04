import { addArchiveToSeasonIfConfigured } from "./bili-season.js";
import { hintSeasonTitleForMaster } from "./bili-season-resolve.js";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { describe, expect, it, vi } from "vitest";
import {
  resolveSeasonIdToSectionId,
  resolveSectionIdFromSeasonId,
  seasonSectionCacheGet,
  clearSeasonIdCachePath,
  SEASON_ID_HINT,
} from "./bili-season-resolve.js";

const dir = mkdtempSync(join(tmpdir(), "season-resolve-test-"));

function loginFile(csrf = "csrf-token", mid = "111"): string {
  const p = join(dir, "login-" + mid + ".json");
  writeFileSync(p, JSON.stringify({
    cookie_info: { cookies: [{ name: "SESSDATA", value: "s" }, { name: "bili_jct", value: csrf }, { name: "DedeUserID", value: mid }] },
  }), "utf-8");
  return p;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

describe("resolveSeasonIdToSectionId", () => {
  it("resolves a single-section season and caches the result", async () => {
    const cookies = loginFile();
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      calls.push(u);
      if (u.includes("x2/creative/web/seasons")) {
        return json({ code: 0, data: { seasons: [{ season: { id: 123, title: "Season A" }, sections: { sections: [{ id: 456, title: "Section A" }] } }] } });
      }
      return json({}, 404);
    }) as unknown as typeof fetch;

    const r = await resolveSeasonIdToSectionId({ seasonId: 123, cookiesPath: cookies, fetchImpl });
    expect(r).toMatchObject({ status: "resolved", sectionId: 456, seasonTitle: "Season A", sectionTitle: "Section A" });
    expect(calls.filter((u) => u.includes("x2/creative/web/seasons")).length).toBe(1);

    const r2 = await resolveSectionIdFromSeasonId({ seasonId: 123, cookiesPath: cookies });
    expect(r2).toEqual({ sectionId: 456 });
    expect(calls.filter((u) => u.includes("x2/creative/web/seasons")).length).toBe(1);
  });

  it("fails non-retryably when the season has multiple sections", async () => {
    const cookies = loginFile("csrf-token", "222");
    const fetchImpl = vi.fn(async () => json({ code: 0, data: { seasons: [{ season: { id: 789 }, sections: { sections: [{ id: 1 }, { id: 2 }] } }] } })) as unknown as typeof fetch;
    const r = await resolveSeasonIdToSectionId({ seasonId: 789, cookiesPath: cookies, fetchImpl });
    expect(r.status).toBe("failed");
    if (r.status !== "failed") throw new Error("expected failed");
    expect(r.retryable).toBe(false);
    expect(String(r.error)).toContain("有多个小节");
  });

  it("fails non-retryably when the season is not owned", async () => {
    const cookies = loginFile("csrf-token", "333");
    const fetchImpl = vi.fn(async () => json({ code: 0, data: { seasons: [{ season: { id: 1 }, sections: { sections: [{ id: 10 }] } }], total: 1 } })) as unknown as typeof fetch;
    const r = await resolveSeasonIdToSectionId({ seasonId: 999, cookiesPath: cookies, fetchImpl });
    expect(r.status).toBe("failed");
    if (r.status !== "failed") throw new Error("expected failed");
    expect(r.retryable).toBe(false);
    expect(String(r.error)).toContain(SEASON_ID_HINT);
  });

  it("is retryable on a network error", async () => {
    const cookies = loginFile("csrf-token", "444");
    const fetchImpl = vi.fn(async () => { throw new Error("network down"); }) as unknown as typeof fetch;
    const r = await resolveSeasonIdToSectionId({ seasonId: 123, cookiesPath: cookies, fetchImpl });
    expect(r.status).toBe("failed");
    if (r.status !== "failed") throw new Error("expected failed");
    expect(r.retryable).toBe(true);
  });
});

describe("resolveSectionIdFromSeasonId", () => {
  it("returns cached sectionId without a seasons request", async () => {
    const cookies = loginFile("csrf-token", "555");
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      if (String(url).includes("x2/creative/web/seasons")) {
        return json({ code: 0, data: { seasons: [{ season: { id: 321 }, sections: { sections: [{ id: 654 }] } }] } });
      }
      return json({}, 404);
    }) as unknown as typeof fetch;

    const first = await resolveSectionIdFromSeasonId({ seasonId: 321, cookiesPath: cookies, fetchImpl });
    expect(first).toEqual({ sectionId: 654 });

    const callsBefore = (fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls.length;
    const second = await resolveSectionIdFromSeasonId({ seasonId: 321, cookiesPath: cookies, fetchImpl });
    expect(second).toEqual({ sectionId: 654 });
    expect((fetchImpl as unknown as { mock: { calls: unknown[] } }).mock.calls.length).toBe(callsBefore);
  });
});

describe("cache", () => {
  it("stores per-account and clears on definite rejection", async () => {
    const a = loginFile("csrf-token", "777");
    const b = loginFile("csrf-token", "888");
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      if (u.includes("x2/creative/web/seasons")) {
        return json({ code: 0, data: { seasons: [{ season: { id: 100 }, sections: { sections: [{ id: 200 }] } }] } });
      }
      return json({}, 404);
    }) as unknown as typeof fetch;

    await resolveSectionIdFromSeasonId({ seasonId: 100, cookiesPath: a, fetchImpl });
    expect(seasonSectionCacheGet("bilibili:777", 100, undefined)).toBe(200);
    expect(seasonSectionCacheGet("bilibili:888", 100, undefined)).toBeUndefined();

    clearSeasonIdCachePath(a, 100, undefined);
    expect(seasonSectionCacheGet("bilibili:777", 100, undefined)).toBeUndefined();
    void b;
  });
});

describe("addArchiveToSeasonIfConfigured (seasonId wiring)", () => {
  it("resolves seasonId and adds the archive to the resolved section", async () => {
    const cookies = loginFile("csrf-token", "900");
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      calls.push(u);
      if (u.includes("/season/section/episodes/add")) return json({ code: 0, data: null });
      if (u.includes("/season/section?id=")) return json({ code: 0, data: { episodes: [] } });
      if (u.includes("x2/creative/web/seasons")) return json({ code: 0, data: { seasons: [{ season: { id: 500, title: "S" }, sections: { sections: [{ id: 600, title: "Sec" }] } }] } });
      if (u.includes("/x/vupre/web/archive/view")) return json({ code: 0, data: { archive: { aid: 1, title: "t" }, videos: [{ cid: 2 }] } });
      void init;
      return json({}, 404);
    }) as unknown as typeof fetch;
    const r = await addArchiveToSeasonIfConfigured({ seasonId: 500, cookiesPath: cookies, dataRoot: dir, fetchImpl, aid: 1 });
    expect(r.status).toBe("added");
    expect(calls.some((u) => u.includes("x2/creative/web/seasons"))).toBe(true);
  });

  it("clears the cache and re-resolves once on a definite rejection", async () => {
    const cookies = loginFile("csrf-token", "901");
    let seasonsCalls = 0;
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      if (u.includes("/season/section/episodes/add")) {
        const body = JSON.parse(String(init?.body ?? "{}")) as { sectionId?: number };
        return body.sectionId === 600 ? json({ code: 7, message: "section not mine" }) : json({ code: 0, data: null });
      }
      if (u.includes("/season/section?id=")) return json({ code: 0, data: { episodes: [] } });
      if (u.includes("x2/creative/web/seasons")) {
        seasonsCalls++;
        const sectionId = seasonsCalls === 1 ? 600 : 601;
        return json({ code: 0, data: { seasons: [{ season: { id: 510, title: "S2" }, sections: { sections: [{ id: sectionId, title: "Sec" }] } }] } });
      }
      if (u.includes("/x/vupre/web/archive/view")) return json({ code: 0, data: { archive: { aid: 1, title: "t" }, videos: [{ cid: 2 }] } });
      return json({}, 404);
    }) as unknown as typeof fetch;
    const r = await addArchiveToSeasonIfConfigured({ seasonId: 510, cookiesPath: cookies, dataRoot: dir, fetchImpl, aid: 1 });
    expect(r.status).toBe("added");
    // The stale cached section 600 was dropped and a fresh resolution (section 601) was used.
    expect(seasonsCalls).toBe(2);
  });

  it("legacy seasonSectionId-only rules keep the old behaviour (no seasons request)", async () => {
    const cookies = loginFile("csrf-token", "902");
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      calls.push(u);
      if (u.includes("/season/section/episodes/add")) return json({ code: 0, data: null });
      if (u.includes("/season/section?id=")) return json({ code: 0, data: { episodes: [] } });
      if (u.includes("/x/vupre/web/archive/view")) return json({ code: 0, data: { archive: { aid: 1, title: "t" }, videos: [{ cid: 2 }] } });
      return json({}, 404);
    }) as unknown as typeof fetch;
    const r = await addArchiveToSeasonIfConfigured({ sectionId: 700, cookiesPath: cookies, dataRoot: dir, fetchImpl, aid: 1 });
    expect(r.status).toBe("added");
    expect(calls.some((u) => u.includes("x2/creative/web/seasons"))).toBe(false);
  });

  it("skips when neither seasonId nor sectionId is set", async () => {
    const r = await addArchiveToSeasonIfConfigured({ cookiesPath: "/nope" });
    expect(r).toMatchObject({ status: "skipped" });
  });
});
describe("hintSeasonTitleForMaster", () => {
  it("returns season / section on success and the fallback otherwise, never throwing", async () => {
    const cookies = loginFile("csrf-token", "950");
    const ok = vi.fn(async () => json({ code: 0, data: { seasons: [{ season: { id: 42, title: "Season X" }, sections: { sections: [{ id: 43, title: "Part A" }] } }] } })) as unknown as typeof fetch;
    expect(await hintSeasonTitleForMaster({ seasonId: 42, cookiesPath: cookies, fetchImpl: ok })).toBe("Season X / Part A");

    const missing = vi.fn(async () => json({ code: 0, data: { seasons: [] } })) as unknown as typeof fetch;
    const fallback = "master 账号下没有该合集，将由录制节点用自己的账号获取";
    expect(await hintSeasonTitleForMaster({ seasonId: 42, cookiesPath: loginFile("csrf-token", "951"), fetchImpl: missing })).toBe(fallback);

    const boom = vi.fn(async () => { throw new Error("network down"); }) as unknown as typeof fetch;
    expect(await hintSeasonTitleForMaster({ seasonId: 42, cookiesPath: loginFile("csrf-token", "952"), fetchImpl: boom })).toBe(fallback);
  });
});