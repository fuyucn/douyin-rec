import { existsSync, mkdtempSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
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

/** One seasons page (default: season 500 with a single section 600, total 1). */
function page(seasons?: Array<{ seasonId: number; sections: number[] }>, total?: number) {
  const list = seasons ?? [{ seasonId: 500, sections: [600] }];
  return {
    code: 0,
    data: {
      seasons: list.map((s) => ({
        season: { id: s.seasonId },
        sections: { sections: s.sections.map((id) => ({ id })) },
      })),
      total: total ?? list.length,
    },
  };
}

/**
 * Upstream mock: seasons listing + archive view + membership + episodes/add.
 * `sectionState` drives the membership check ("unknown" = the endpoint answers with a bad code).
 */
function mockUpstream(o: {
  seasons?: (call: number) => unknown;
  add?: (sectionId: number) => Response;
  /** Membership answer per section id (default: not contained). */
  sectionState?: (sectionId: number) => "yes" | "no" | "unknown";
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
      const id = Number(/id=(\d+)/.exec(u)?.[1] ?? 0);
      const st = o.sectionState ? o.sectionState(id) : "no";
      if (st === "unknown") return json({ code: 7, message: "unknown" });
      return json({ code: 0, data: { episodes: st === "yes" ? [{ aid: 1 }] : [] } });
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

/** Seed the cache the only way it is written: a successful add. */
async function seed(login: Login, configured: number, sectionId: number): Promise<void> {
  const { fetchImpl } = mockUpstream({ seasons: () => page([{ seasonId: configured, sections: [sectionId] }]) });
  const r = await addArchiveToSeasonIfConfigured({ sectionId: configured, cookiesPath: login.path, fetchImpl, aid: 1 });
  expect(r.status).toBe("added");
  expect(seasonCacheGet(seasonAccountKey(login.path), configured, login.path)).toBe(sectionId);
}

beforeEach(() => { __resetSeasonMemCache(); });
afterEach(() => { vi.useRealTimers(); });

describe("resolution", () => {
  it("resolves a single-section season; the second call does zero scans", async () => {
    const login = mkLogin("101");
    const { fetchImpl, calls, posted } = mockUpstream();

    expect((await addArchiveToSeasonIfConfigured({ sectionId: 500, cookiesPath: login.path, fetchImpl, aid: 1 })).status).toBe("added");
    expect(calls.seasons).toBe(1);
    expect(posted).toEqual([600]);

    expect((await addArchiveToSeasonIfConfigured({ sectionId: 500, cookiesPath: login.path, fetchImpl, aid: 1 })).status).toBe("added");
    expect(calls.seasons).toBe(1); // cache hit: no second scan
    expect(posted).toEqual([600, 600]);
  });

  it("accepts a legacy section id that belongs to one of the account's seasons", async () => {
    const { fetchImpl, calls, posted } = mockUpstream();
    const r = await addArchiveToSeasonIfConfigured({ sectionId: 600, cookiesPath: mkLogin("102").path, fetchImpl, aid: 1 });
    expect(r.status).toBe("added");
    expect(posted).toEqual([600]);
    expect(calls.seasons).toBe(1);
  });

  it("multi-section and not-owned fail non-retryably with one scan and zero POSTs", async () => {
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

  it("network / HTTP / API-code failures are retryable and never POST", async () => {
    const boom = mockUpstream({ seasons: () => { throw new Error("network down"); } });
    const r1 = await addArchiveToSeasonIfConfigured({ sectionId: 500, cookiesPath: mkLogin("105").path, fetchImpl: boom.fetchImpl, aid: 1 });
    expect(r1).toMatchObject({ status: "failed", retryable: true });
    expect(boom.calls.add).toBe(0);

    const http = vi.fn(async () => new Response("nope", { status: 500 })) as unknown as typeof fetch;
    expect(await resolveConfiguredSeasonSection({ configured: 500, cookiesPath: mkLogin("106").path, fetchImpl: http }))
      .toMatchObject({ status: "failed", retryable: true });

    const badCode = vi.fn(async () => json({ code: -101, message: "not logged in" })) as unknown as typeof fetch;
    expect(await resolveConfiguredSeasonSection({ configured: 500, cookiesPath: mkLogin("107").path, fetchImpl: badCode }))
      .toMatchObject({ status: "failed", retryable: true });
  });

  it("deadline 0 makes zero requests", async () => {
    const { fetchImpl } = mockUpstream();
    const direct = await resolveConfiguredSeasonSection({ configured: 500, cookiesPath: mkLogin("108").path, fetchImpl, deadlineMs: 0 });
    expect(direct).toMatchObject({ status: "failed", retryable: true });
    expect(fetchImpl).not.toHaveBeenCalled();

    const viaAdd = mockUpstream();
    const r = await addArchiveToSeasonIfConfigured({ sectionId: 500, cookiesPath: mkLogin("109").path, fetchImpl: viaAdd.fetchImpl, aid: 1, totalTimeoutMs: 0 });
    expect(r).toMatchObject({ status: "failed", retryable: true });
    expect(viaAdd.calls.seasons).toBe(0);
    expect(viaAdd.calls.add).toBe(0);
  });
});

describe("pagination", () => {
  it("finds a season on a short second page (a short page is not the end)", async () => {
    const { fetchImpl, calls, posted } = mockUpstream({
      seasons: (call) => call === 1
        ? page([{ seasonId: 1, sections: [10] }, { seasonId: 2, sections: [20] }], 3)
        : page([{ seasonId: 500, sections: [600] }], 3),
    });
    const r = await addArchiveToSeasonIfConfigured({ sectionId: 500, cookiesPath: mkLogin("201").path, fetchImpl, aid: 1 });
    expect(r.status).toBe("added");
    expect(calls.seasons).toBe(2);
    expect(posted).toEqual([600]);
  });

  it("finds a legacy section id on page 2", async () => {
    const { fetchImpl, calls, posted } = mockUpstream({
      seasons: (call) => call === 1
        ? page([{ seasonId: 1, sections: [10] }], 2)
        : page([{ seasonId: 2, sections: [700] }], 2),
    });
    const r = await addArchiveToSeasonIfConfigured({ sectionId: 700, cookiesPath: mkLogin("202").path, fetchImpl, aid: 1 });
    expect(r.status).toBe("added");
    expect(calls.seasons).toBe(2);
    expect(posted).toEqual([700]);
  });

  it("stops as soon as the reported total is covered", async () => {
    const { fetchImpl, calls } = mockUpstream({
      seasons: () => page([{ seasonId: 1, sections: [10] }, { seasonId: 2, sections: [20] }], 2),
    });
    const r = await resolveConfiguredSeasonSection({ configured: 999, cookiesPath: mkLogin("203").path, fetchImpl });
    expect(r).toMatchObject({ status: "failed", retryable: false });
    expect(calls.seasons).toBe(1);
  });

  it("an unfinished listing (page cap / budget) is retryable, never 'not this account'", async () => {
    const capped = mockUpstream({ seasons: () => page([{ seasonId: 1, sections: [10] }], 5) });
    const r1 = await resolveConfiguredSeasonSection({
      configured: 999, cookiesPath: mkLogin("204").path, fetchImpl: capped.fetchImpl, maxPages: 1,
    });
    expect(r1).toMatchObject({ status: "failed", retryable: true });
    if (r1.status !== "failed") throw new Error("expected failed");
    expect(r1.error).toContain("合集列表未读完");
    expect(r1.error).not.toContain("不是本账号");
  });
});

describe("cached section rejected", () => {
  it("clears, re-resolves and retries once when the section changed", async () => {
    const login = mkLogin("301");
    await seed(login, 500, 600);

    const { fetchImpl, calls } = mockUpstream({
      seasons: () => page([{ seasonId: 500, sections: [601] }]),
      add: (sectionId) => (sectionId === 600 ? json({ code: 7, message: "section not mine" }) : json({ code: 0, data: null })),
    });
    const r = await addArchiveToSeasonIfConfigured({ sectionId: 500, cookiesPath: login.path, fetchImpl, aid: 1 });
    expect(r.status).toBe("added");
    expect(calls.add).toBe(2);
    expect(calls.seasons).toBe(1); // only the re-resolve scans
    expect(seasonCacheGet(seasonAccountKey(login.path), 500, login.path)).toBe(601);
  });

  it("does not POST twice when the re-resolved section is the same, and does not re-cache it", async () => {
    const login = mkLogin("302");
    await seed(login, 500, 600);

    const { fetchImpl, calls } = mockUpstream({ add: () => json({ code: 7, message: "denied" }) });
    const logs: string[] = [];
    const r = await addArchiveToSeasonIfConfigured({
      sectionId: 500, cookiesPath: login.path, fetchImpl, aid: 1, note: (m) => logs.push(m),
    });
    expect(r.status).toBe("failed");
    if (r.status !== "failed") throw new Error("expected failed");
    expect(r.retryable).toBe(false);
    expect(r.error).toContain(SEASON_ID_HINT);
    expect(calls.add).toBe(1);
    expect(calls.seasons).toBe(1);
    expect(seasonCacheGet(seasonAccountKey(login.path), 500, login.path)).toBeUndefined(); // rejected section not kept
    expect(logs.join("\n")).toContain("合集 500");
    expect(logs.join("\n")).not.toContain("小节 0");
  });

  it("a non-cached rejection neither clears nor rescans", async () => {
    const login = mkLogin("303");
    const { fetchImpl, calls } = mockUpstream({ add: () => json({ code: 7, message: "denied" }) });
    const r = await addArchiveToSeasonIfConfigured({ sectionId: 500, cookiesPath: login.path, fetchImpl, aid: 1 });
    expect(r).toMatchObject({ status: "failed", retryable: false });
    expect(calls.seasons).toBe(1);
    expect(calls.add).toBe(1);
    expect(seasonCacheGet(seasonAccountKey(login.path), 500, login.path)).toBeUndefined();
  });

  it("a retryable add error with a cached section keeps the cache and does not rescan", async () => {
    const login = mkLogin("304");
    await seed(login, 500, 600);

    const { fetchImpl, calls } = mockUpstream({
      add: () => new Response(JSON.stringify({ code: -500, message: "too many requests" }), { status: 429 }),
    });
    const r = await addArchiveToSeasonIfConfigured({ sectionId: 500, cookiesPath: login.path, fetchImpl, aid: 1, sleep: async () => {} });
    expect(r).toMatchObject({ status: "failed", retryable: true });
    expect(calls.seasons).toBe(0); // cache hit, nothing re-resolved
    expect(seasonCacheGet(seasonAccountKey(login.path), 500, login.path)).toBe(600);
  });

  it("a retryable re-resolve failure after a rejection is retryable (state stays pending)", async () => {
    const login = mkLogin("305");
    await seed(login, 500, 600);

    const { fetchImpl } = mockUpstream({
      seasons: () => { throw new Error("network down"); },
      add: () => json({ code: 7, message: "denied" }),
    });
    const r = await addArchiveToSeasonIfConfigured({ sectionId: 500, cookiesPath: login.path, fetchImpl, aid: 1 });
    expect(r).toMatchObject({ status: "failed", retryable: true });
  });
});

describe("resume path (reconcileFirst)", () => {
  it("uses the resolved section for the membership check and reports already (no POST)", async () => {
    const login = mkLogin("401");
    const { fetchImpl, calls, posted } = mockUpstream({ sectionState: () => "yes" });
    const r = await addArchiveToSeasonIfConfigured({ sectionId: 500, cookiesPath: login.path, fetchImpl, aid: 1, reconcileFirst: true });
    expect(r.status).toBe("already");
    expect(posted).toEqual([]);
    expect(calls.seasons).toBe(1);
    expect(seasonCacheGet(seasonAccountKey(login.path), 500, login.path)).toBe(600);
  });

  it("a stale cached section with unknown membership is cleared, re-resolved and retried", async () => {
    const login = mkLogin("402");
    await seed(login, 500, 600);

    const { fetchImpl, calls, posted } = mockUpstream({
      seasons: () => page([{ seasonId: 500, sections: [601] }]),
      sectionState: (id) => (id === 600 ? "unknown" : "yes"),
    });
    const r = await addArchiveToSeasonIfConfigured({ sectionId: 500, cookiesPath: login.path, fetchImpl, aid: 1, reconcileFirst: true });
    expect(r.status).toBe("already");
    expect(posted).toEqual([]); // membership said present: no POST at all
    expect(calls.seasons).toBe(1); // the re-resolve
    expect(seasonCacheGet(seasonAccountKey(login.path), 500, login.path)).toBe(601);
  });

  it("unknown membership with the same re-resolved section stays retryable (pending)", async () => {
    const login = mkLogin("403");
    await seed(login, 500, 600);

    const { fetchImpl } = mockUpstream({ sectionState: () => "unknown" });
    const r = await addArchiveToSeasonIfConfigured({ sectionId: 500, cookiesPath: login.path, fetchImpl, aid: 1, reconcileFirst: true });
    expect(r).toMatchObject({ status: "failed", retryable: true });
  });
});

describe("cache", () => {
  it("keeps two accounts separate", async () => {
    const a = mkLogin("501");
    const b = mkLogin("502");
    const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
      const u = String(url);
      const cookie = String((init?.headers as Record<string, string> | undefined)?.Cookie ?? "");
      if (u.includes("x2/creative/web/seasons")) {
        return json(page([{ seasonId: 100, sections: [cookie.includes("DedeUserID=501") ? 200 : 300] }]));
      }
      if (u.includes("/season/section/episodes/add")) return json({ code: 0, data: null });
      if (u.includes("/season/section?id=")) return json({ code: 0, data: { episodes: [] } });
      if (u.includes("/x/vupre/web/archive/view")) {
        return json({ code: 0, data: { archive: { aid: 1, title: "t" }, videos: [{ cid: 2 }] } });
      }
      return json({}, 404);
    }) as unknown as typeof fetch;

    expect((await addArchiveToSeasonIfConfigured({ sectionId: 100, cookiesPath: a.path, fetchImpl, aid: 1 })).status).toBe("added");
    expect((await addArchiveToSeasonIfConfigured({ sectionId: 100, cookiesPath: b.path, fetchImpl, aid: 1 })).status).toBe("added");
    expect(seasonCacheGet("bilibili:501", 100, a.path)).toBe(200);
    expect(seasonCacheGet("bilibili:502", 100, b.path)).toBe(300);
    expect(seasonCacheFile(a.path)).toBe(join(a.dir, "season-cache.json"));
  });

  it("treats null / array / scalar / malformed cache files as empty without throwing", async () => {
    const { path, dir } = mkLogin("503");
    const p = join(dir, "season-cache.json");
    for (const garbage of ["null", "[]", "\"str\"", "42", "{\"bilibili:503||1\": null}", "{\"bilibili:503||1\": \"x\"}", "{\"bilibili:503||1\": {\"sectionId\": \"nope\"}}", "{oops"]) {
      writeFileSync(p, garbage, "utf-8");
      __resetSeasonMemCache();
      expect(() => seasonCacheGet("bilibili:503", 1, path)).not.toThrow();
      expect(seasonCacheGet("bilibili:503", 1, path)).toBeUndefined();
    }
  });

  it("does not cache when the login file has no DedeUserID", async () => {
    const anon = mkLogin("x", false);
    const { fetchImpl } = mockUpstream();
    expect((await addArchiveToSeasonIfConfigured({ sectionId: 500, cookiesPath: anon.path, fetchImpl, aid: 1 })).status).toBe("added");
    expect(existsSync(join(anon.dir, "season-cache.json"))).toBe(false);

    const again = mockUpstream();
    await addArchiveToSeasonIfConfigured({ sectionId: 500, cookiesPath: anon.path, fetchImpl: again.fetchImpl, aid: 1 });
    expect(again.calls.seasons).toBe(1);
  });

  it("overwrites a corrupt cache file (owner-only) and never touches the login file", async () => {
    const login = mkLogin("504");
    const cachePath = join(login.dir, "season-cache.json");
    writeFileSync(cachePath, "{oops", "utf-8");
    const loginBefore = readFileSync(login.path, "utf-8");

    expect((await addArchiveToSeasonIfConfigured({ sectionId: 500, cookiesPath: login.path, fetchImpl: mockUpstream().fetchImpl, aid: 1 })).status).toBe("added");

    const parsed = JSON.parse(readFileSync(cachePath, "utf-8")) as Record<string, { sectionId?: number }>;
    expect(parsed["bilibili:504||500"]?.sectionId).toBe(600);
    expect(statSync(cachePath).mode & 0o777).toBe(0o600);
    expect(readFileSync(login.path, "utf-8")).toBe(loginBefore);
  });

  it("persists across a memory reset (disk cache is re-read)", async () => {
    const login = mkLogin("505");
    await seed(login, 500, 600);
    __resetSeasonMemCache();

    const never = vi.fn(() => { throw new Error("must not fetch seasons"); }) as unknown as typeof fetch;
    expect(await resolveConfiguredSeasonSection({ configured: 500, cookiesPath: login.path, fetchImpl: never }))
      .toMatchObject({ status: "resolved", sectionId: 600, fromCache: true });
  });
});

describe("budget", () => {
  it("caps the resolve slice (~10s) so a slow listing cannot eat the add budget", async () => {
    vi.useFakeTimers({ toFake: ["Date"] });
    vi.setSystemTime(new Date("2026-01-01T00:00:00Z"));
    const login = mkLogin("601");
    let calls = 0;
    const fetchImpl = vi.fn(async () => {
      calls++;
      vi.setSystemTime(Date.now() + 11_000); // this page alone took 11s
      return json(page([{ seasonId: 1, sections: [10] }], 5));
    }) as unknown as typeof fetch;

    const r = await addArchiveToSeasonIfConfigured({ sectionId: 999, cookiesPath: login.path, fetchImpl, aid: 1, totalTimeoutMs: 25_000 });
    expect(r).toMatchObject({ status: "failed", retryable: true });
    if (r.status !== "failed") throw new Error("expected failed");
    expect(r.error).toContain("合集列表未读完");
    expect(calls).toBe(1); // capped at the 10s slice, not the full 25s budget
  });
});
