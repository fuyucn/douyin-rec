import { existsSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SEASON_ID_HINT,
  __resetSeasonMemCache,
  resolveConfiguredSeasonSection,
  seasonAccountKey,
  seasonCacheFile,
  seasonCacheGet,
} from "./bili-season-resolve.js";
import { addArchiveToSeasonIfConfigured } from "./bili-season.js";

interface Login { path: string; dir: string }

/** A login file in its own temp dir, so each case owns its cache file. */
function mkLogin(mid = "111", withMid = true): Login {
  const dir = mkdtempSync(join(tmpdir(), "season-v3-"));
  const path = join(dir, "login.json");
  const cookies: Array<{ name: string; value: string }> = [
    { name: "SESSDATA", value: "s" },
    { name: "bili_jct", value: "csrf" },
  ];
  if (withMid) cookies.push({ name: "DedeUserID", value: mid });
  writeFileSync(path, JSON.stringify({ cookie_info: { cookies } }), "utf-8");
  return { path, dir };
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** One seasons page: `seasons` defaults to season 500 with a single section 600. */
function page(seasons?: Array<{ seasonId: number; sections: number[] }>) {
  const list = seasons ?? [{ seasonId: 500, sections: [600] }];
  return {
    code: 0,
    data: {
      seasons: list.map((s) => ({
        season: { id: s.seasonId },
        sections: { sections: s.sections.map((id) => ({ id })) },
      })),
      total: list.length,
    },
  };
}

/**
 * Upstream mock: seasons listing + archive view + membership + episodes/add.
 * `add` decides the POST response; `calls` counts the two interesting kinds.
 */
function mockUpstream(o: {
  seasons?: (call: number) => unknown;
  add?: (sectionId: number) => Response;
  contained?: boolean;
} = {}) {
  const calls = { seasons: 0, add: 0 };
  const posted: number[] = [];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/season/section/episodes/add")) {
      calls.add++;
      const body = JSON.parse(String(init?.body ?? "{}")) as { sectionId?: number };
      const sectionId = Number(body.sectionId ?? 0);
      posted.push(sectionId);
      return o.add ? o.add(sectionId) : json({ code: 0, data: null });
    }
    if (u.includes("/season/section?id=")) {
      return json({ code: 0, data: { episodes: o.contained ? [{ aid: 1 }] : [] } });
    }
    if (u.includes("x2/creative/web/seasons")) {
      calls.seasons++;
      return json(o.seasons ? o.seasons(calls.seasons) : page());
    }
    if (u.includes("/x/vupre/web/archive/view")) {
      return json({ code: 0, data: { archive: { aid: 1, title: "t" }, videos: [{ cid: 2 }] } });
    }
    return json({}, 404);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls, posted };
}

beforeEach(() => { __resetSeasonMemCache(); });

describe("season id resolution", () => {
  it("resolves a single-section season and the second call does zero scans", async () => {
    const { path } = mkLogin("101");
    const { fetchImpl, calls, posted } = mockUpstream();

    const r1 = await addArchiveToSeasonIfConfigured({ sectionId: 500, cookiesPath: path, fetchImpl, aid: 1 });
    expect(r1.status).toBe("added");
    expect(calls.seasons).toBe(1);
    expect(posted).toEqual([600]);

    const r2 = await addArchiveToSeasonIfConfigured({ sectionId: 500, cookiesPath: path, fetchImpl, aid: 1 });
    expect(r2.status).toBe("added");
    expect(calls.seasons).toBe(1); // cache hit: no second seasons scan
    expect(posted).toEqual([600, 600]);
  });

  it("accepts a legacy section id that belongs to one of the account's seasons", async () => {
    const { path } = mkLogin("102");
    const { fetchImpl, calls, posted } = mockUpstream();

    const r = await addArchiveToSeasonIfConfigured({ sectionId: 600, cookiesPath: path, fetchImpl, aid: 1 });
    expect(r.status).toBe("added");
    expect(posted).toEqual([600]); // used as is
    expect(calls.seasons).toBe(1);
  });

  it("multi-section and not-owned both fail non-retryably with one scan and zero POSTs", async () => {
    const multi = mockUpstream({ seasons: () => page([{ seasonId: 500, sections: [1, 2] }]) });
    const r1 = await addArchiveToSeasonIfConfigured({ sectionId: 500, cookiesPath: mkLogin("103").path, fetchImpl: multi.fetchImpl, aid: 1 });
    expect(r1.status).toBe("failed");
    if (r1.status !== "failed") throw new Error("expected failed");
    expect(r1.retryable).toBe(false);
    expect(r1.error).toContain("多个小节");
    expect(multi.calls.seasons).toBe(1);
    expect(multi.calls.add).toBe(0);

    const notOwned = mockUpstream();
    const r2 = await addArchiveToSeasonIfConfigured({ sectionId: 999, cookiesPath: mkLogin("104").path, fetchImpl: notOwned.fetchImpl, aid: 1 });
    expect(r2.status).toBe("failed");
    if (r2.status !== "failed") throw new Error("expected failed");
    expect(r2.retryable).toBe(false);
    expect(r2.error).toContain(SEASON_ID_HINT);
    expect(notOwned.calls.seasons).toBe(1);
    expect(notOwned.calls.add).toBe(0);
  });

  it("a network error is retryable and never POSTs", async () => {
    const { fetchImpl, calls } = mockUpstream({ seasons: () => { throw new Error("network down"); } });
    const r = await addArchiveToSeasonIfConfigured({ sectionId: 500, cookiesPath: mkLogin("105").path, fetchImpl, aid: 1 });
    expect(r.status).toBe("failed");
    if (r.status !== "failed") throw new Error("expected failed");
    expect(r.retryable).toBe(true);
    expect(calls.add).toBe(0);
  });

  it("deadline 0 makes zero requests", async () => {
    const { path } = mkLogin("106");
    const { fetchImpl } = mockUpstream();
    const direct = await resolveConfiguredSeasonSection({ configured: 500, cookiesPath: path, fetchImpl, deadlineMs: 0 });
    expect(direct.status).toBe("failed");
    if (direct.status !== "failed") throw new Error("expected failed");
    expect(direct.retryable).toBe(true);
    expect(fetchImpl).not.toHaveBeenCalled();

    const viaAdd = mockUpstream();
    const r = await addArchiveToSeasonIfConfigured({ sectionId: 500, cookiesPath: mkLogin("107").path, fetchImpl: viaAdd.fetchImpl, aid: 1, totalTimeoutMs: 0 });
    expect(r.status).toBe("failed");
    if (r.status !== "failed") throw new Error("expected failed");
    expect(r.retryable).toBe(true);
    expect(viaAdd.calls.seasons).toBe(0);
    expect(viaAdd.calls.add).toBe(0);
  });
});

describe("rejected cached section", () => {
  it("clears, re-resolves and retries once when the section changed", async () => {
    const { path } = mkLogin("201");
    // Seed the cache: season 500 -> section 600.
    await addArchiveToSeasonIfConfigured({ sectionId: 500, cookiesPath: path, fetchImpl: mockUpstream().fetchImpl, aid: 1 });
    expect(seasonCacheGet("bilibili:201", 500, path)).toBe(600);

    // 600 is rejected for good; the fresh scan now yields 601, which succeeds.
    const { fetchImpl, calls } = mockUpstream({
      seasons: () => page([{ seasonId: 500, sections: [601] }]),
      add: (sectionId) => (sectionId === 600 ? json({ code: 7, message: "section not mine" }) : json({ code: 0, data: null })),
    });
    const r = await addArchiveToSeasonIfConfigured({ sectionId: 500, cookiesPath: path, fetchImpl, aid: 1 });
    expect(r.status).toBe("added");
    expect(calls.add).toBe(2);
    expect(calls.seasons).toBe(1); // only the re-resolve scans (the first attempt was cached)
    expect(seasonCacheGet("bilibili:201", 500, path)).toBe(601);
  });

  it("does not POST twice when the re-resolved section is the same", async () => {
    const { path } = mkLogin("202");
    await addArchiveToSeasonIfConfigured({ sectionId: 500, cookiesPath: path, fetchImpl: mockUpstream().fetchImpl, aid: 1 });

    const { fetchImpl, calls } = mockUpstream({ add: () => json({ code: 7, message: "denied" }) });
    const logs: string[] = [];
    const r = await addArchiveToSeasonIfConfigured({
      sectionId: 500, cookiesPath: path, fetchImpl, aid: 1, note: (m) => logs.push(m),
    });
    expect(r.status).toBe("failed");
    if (r.status !== "failed") throw new Error("expected failed");
    expect(r.retryable).toBe(false);
    expect(r.error).toContain(SEASON_ID_HINT);
    expect(calls.add).toBe(1);            // same section -> no second POST
    expect(calls.seasons).toBe(1);        // the single re-resolve
    expect(logs.join("\n")).toContain("合集 500");
    expect(logs.join("\n")).not.toContain("小节 0");
  });
});

describe("cache", () => {
  it("keeps two accounts separate", async () => {
    const a = mkLogin("301");
    const b = mkLogin("302");
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const cookie = String((init?.headers as Record<string, string> | undefined)?.Cookie ?? "");
      return json(page([{ seasonId: 100, sections: [cookie.includes("DedeUserID=301") ? 200 : 300] }]));
    }) as unknown as typeof fetch;

    expect(await resolveConfiguredSeasonSection({ configured: 100, cookiesPath: a.path, fetchImpl }))
      .toMatchObject({ status: "resolved", sectionId: 200, fromCache: false });
    expect(await resolveConfiguredSeasonSection({ configured: 100, cookiesPath: b.path, fetchImpl }))
      .toMatchObject({ status: "resolved", sectionId: 300, fromCache: false });
    expect(seasonCacheGet("bilibili:301", 100, a.path)).toBe(200);
    expect(seasonCacheGet("bilibili:302", 100, b.path)).toBe(300);
    expect(seasonCacheFile(a.path)).toBe(join(a.dir, "season-cache.json"));
    void seasonAccountKey;
  });

  it("treats null / array / scalar / malformed cache files as empty without throwing", async () => {
    const { path, dir } = mkLogin("401");
    const p = join(dir, "season-cache.json");
    for (const garbage of ["null", "[]", "\"str\"", "42", "{\"bilibili:401||1\": null}", "{\"bilibili:401||1\": \"x\"}", "{\"bilibili:401||1\": {\"sectionId\": \"nope\"}}", "{oops"]) {
      writeFileSync(p, garbage, "utf-8");
      __resetSeasonMemCache();
      expect(() => seasonCacheGet("bilibili:401", 1, path)).not.toThrow();
      expect(seasonCacheGet("bilibili:401", 1, path)).toBeUndefined();
    }
  });

  it("does not cache when the login file has no DedeUserID", async () => {
    const anon = mkLogin("x", false);
    const { fetchImpl } = mockUpstream();
    await addArchiveToSeasonIfConfigured({ sectionId: 500, cookiesPath: anon.path, fetchImpl, aid: 1 });
    expect(existsSync(join(anon.dir, "season-cache.json"))).toBe(false);

    // Nothing cached -> the next run scans again.
    const again = mockUpstream();
    await addArchiveToSeasonIfConfigured({ sectionId: 500, cookiesPath: anon.path, fetchImpl: again.fetchImpl, aid: 1 });
    expect(again.calls.seasons).toBe(1);
  });

  it("persists across a memory reset (disk cache is re-read)", async () => {
    const { path } = mkLogin("501");
    await addArchiveToSeasonIfConfigured({ sectionId: 500, cookiesPath: path, fetchImpl: mockUpstream().fetchImpl, aid: 1 });
    __resetSeasonMemCache();

    const never = vi.fn(() => { throw new Error("must not fetch seasons"); }) as unknown as typeof fetch;
    expect(await resolveConfiguredSeasonSection({ configured: 500, cookiesPath: path, fetchImpl: never }))
      .toMatchObject({ status: "resolved", sectionId: 600, fromCache: true });
  });
});
