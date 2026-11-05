import { existsSync, mkdirSync, mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { beforeEach, describe, expect, it, vi } from "vitest";
import {
  SEASON_ID_HINT,
  __resetSeasonMemCache,
  hintSeasonTitleForMaster,
  resolveSeasonTarget,
  resolveSeasonIdToSectionId,
  resolveSectionIdFromSeasonId,
  seasonAccountKey,
  seasonSectionCacheClear,
  seasonSectionCacheGet,
} from "./bili-season-resolve.js";
import { addArchiveToSeasonIfConfigured } from "./bili-season.js";

const dir = mkdtempSync(join(tmpdir(), "season-resolve-test-"));

function tmpRoot(): string { return mkdtempSync(join(tmpdir(), "season-root-")); }

function loginFile(csrf = "csrf-token", mid = "111"): string {
  const p = join(dir, `login-${mid}.json`);
  writeFileSync(p, JSON.stringify({
    cookie_info: { cookies: [{ name: "SESSDATA", value: "s" }, { name: "bili_jct", value: csrf }, { name: "DedeUserID", value: mid }] },
  }), "utf-8");
  return p;
}

function anonLoginFile(): string {
  const p = join(dir, "login-anon.json");
  writeFileSync(p, JSON.stringify({
    cookie_info: { cookies: [{ name: "SESSDATA", value: "s" }, { name: "bili_jct", value: "csrf-token" }] },
  }), "utf-8");
  return p;
}

function json(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), { status, headers: { "Content-Type": "application/json" } });
}

/** Seasons page carrying one season with the given sections. */
function seasonsPage(seasonId: number, sections: Array<{ id: number; title?: string }>, title = "Season") {
  return { code: 0, data: { seasons: [{ season: { id: seasonId, title }, sections: { sections } }], total: 1 } };
}

function archiveView(): Response {
  return json({ code: 0, data: { archive: { aid: 1, title: "t" }, videos: [{ cid: 2 }] } });
}

/** Minimal upstream mock for the add path: seasons scan + view + episodes/add + membership. */
function mockUpstream(o: {
  seasons?: (call: number) => Response;
  add?: (body: { sectionId?: number }) => Response;
  sectionIds?: number[];
  /** Season id the default seasons page carries (default 500). */
  seasonId?: number;
  /** Sections of the default seasons page (default one section 600). */
  sections?: Array<{ id: number; title?: string }>;
}) {
  const calls = { seasons: 0, add: 0 };
  const sectionIds = o.sectionIds ?? [600, 601];
  const fetchImpl = vi.fn(async (url: string | URL | Request, init?: RequestInit) => {
    const u = String(url);
    if (u.includes("/season/section/episodes/add")) {
      calls.add++;
      const body = JSON.parse(String(init?.body ?? "{}")) as { sectionId?: number };
      return o.add ? o.add(body) : json({ code: 0, data: null });
    }
    if (u.includes("/season/section?id=")) {
      const id = Number(/id=(\d+)/.exec(u)?.[1] ?? 0);
      return sectionIds.includes(id) ? json({ code: 7, message: "unknown section" }) : json({ code: 0, data: { episodes: [] } });
    }
    if (u.includes("x2/creative/web/seasons")) {
      calls.seasons++;
      return o.seasons ? o.seasons(calls.seasons) : json(seasonsPage(o.seasonId ?? 500, o.sections ?? [{ id: 600, title: "Sec" }]));
    }
    if (u.includes("/x/vupre/web/archive/view")) return archiveView();
    return json({}, 404);
  }) as unknown as typeof fetch;
  return { fetchImpl, calls };
}

beforeEach(() => { __resetSeasonMemCache(); });

describe("resolveSeasonIdToSectionId", () => {
  it("resolves a single-section season and stores it in the cache", async () => {
    const root = tmpRoot();
    const cookies = loginFile("csrf-token", "101");
    const fetchImpl = vi.fn(async () => json(seasonsPage(123, [{ id: 456, title: "Sec A" }], "Season A"))) as unknown as typeof fetch;

    const r = await resolveSeasonIdToSectionId({ seasonId: 123, cookiesPath: cookies, dataRoot: root, fetchImpl });
    expect(r).toMatchObject({ status: "resolved", sectionId: 456, seasonTitle: "Season A", sectionTitle: "Sec A", fromCache: false });
    expect(seasonSectionCacheGet("bilibili:101", 123, root)).toBe(456);
  });

  it("cache hit issues no seasons request", async () => {
    const root = tmpRoot();
    const cookies = loginFile("csrf-token", "102");
    await resolveSeasonIdToSectionId({ seasonId: 321, cookiesPath: cookies, dataRoot: root, fetchImpl: mockUpstream({ seasonId: 321 }).fetchImpl });

    const never = vi.fn(() => { throw new Error("must not fetch"); }) as unknown as typeof fetch;
    const r = await resolveSectionIdFromSeasonId({ seasonId: 321, cookiesPath: cookies, dataRoot: root, fetchImpl: never });
    expect(r).toMatchObject({ status: "resolved", fromCache: true });
  });

  it("fails non-retryably on multiple sections and on a season the account does not own", async () => {
    const cookies = loginFile("csrf-token", "103");
    const multi = vi.fn(async () => json(seasonsPage(789, [{ id: 1 }, { id: 2 }]))) as unknown as typeof fetch;
    const r1 = await resolveSeasonIdToSectionId({ seasonId: 789, cookiesPath: cookies, fetchImpl: multi });
    expect(r1.status).toBe("failed");
    if (r1.status !== "failed") throw new Error("expected failed");
    expect(r1.retryable).toBe(false);
    expect(r1.error).toContain("多个小节");

    const none = vi.fn(async () => json(seasonsPage(1, [{ id: 10 }]))) as unknown as typeof fetch;
    const r2 = await resolveSeasonIdToSectionId({ seasonId: 999, cookiesPath: loginFile("csrf-token", "104"), fetchImpl: none });
    expect(r2.status).toBe("failed");
    if (r2.status !== "failed") throw new Error("expected failed");
    expect(r2.retryable).toBe(false);
    expect(r2.error).toContain(SEASON_ID_HINT);
  });

  it("is retryable on a network error and on an exhausted budget", async () => {
    const boom = vi.fn(async () => { throw new Error("network down"); }) as unknown as typeof fetch;
    const r = await resolveSeasonIdToSectionId({ seasonId: 123, cookiesPath: loginFile("csrf-token", "105"), fetchImpl: boom });
    expect(r.status).toBe("failed");
    if (r.status !== "failed") throw new Error("expected failed");
    expect(r.retryable).toBe(true);

    const expired = vi.fn(async () => json(seasonsPage(1, [{ id: 1 }]))) as unknown as typeof fetch;
    const r2 = await resolveSeasonIdToSectionId({
      seasonId: 123, cookiesPath: loginFile("csrf-token", "106"), fetchImpl: expired, deadlineMs: Date.now() - 1,
    });
    expect(r2.status).toBe("failed");
    if (r2.status !== "failed") throw new Error("expected failed");
    expect(r2.retryable).toBe(true);
    expect(expired).not.toHaveBeenCalled();
  });

  it("two accounts keep separate cache entries", async () => {
    const root = tmpRoot();
    const a = loginFile("csrf-token", "201");
    const b = loginFile("csrf-token", "202");
    const fetchImpl = vi.fn(async (_url: string | URL | Request, init?: RequestInit) => {
      const cookie = String((init?.headers as Record<string, string> | undefined)?.Cookie ?? "");
      const sectionId = cookie.includes("DedeUserID=201") ? 200 : 300;
      return json(seasonsPage(100, [{ id: sectionId }]));
    }) as unknown as typeof fetch;

    await resolveSeasonIdToSectionId({ seasonId: 100, cookiesPath: a, dataRoot: root, fetchImpl });
    await resolveSeasonIdToSectionId({ seasonId: 100, cookiesPath: b, dataRoot: root, fetchImpl });
    expect(seasonSectionCacheGet("bilibili:201", 100, root)).toBe(200);
    expect(seasonSectionCacheGet("bilibili:202", 100, root)).toBe(300);
    void seasonAccountKey;
  });

  it("does not cache when the login file has no DedeUserID", async () => {
    const root = tmpRoot();
    const cookies = anonLoginFile();
    const fetchImpl = vi.fn(async () => json(seasonsPage(123, [{ id: 456 }]))) as unknown as typeof fetch;
    await resolveSeasonIdToSectionId({ seasonId: 123, cookiesPath: cookies, dataRoot: root, fetchImpl });
    expect(seasonSectionCacheGet("bilibili:unknown", 123, root)).toBeUndefined();
    expect(existsSync(join(root, "db", "season-id-cache.json"))).toBe(false);

    // A second call must hit the network again (nothing was cached).
    expect(await resolveSectionIdFromSeasonId({ seasonId: 123, cookiesPath: cookies, dataRoot: root, fetchImpl }))
      .toMatchObject({ status: "resolved", fromCache: false });
  });
});

describe("disk cache robustness", () => {
  it("survives a memory reset (persisted on disk)", async () => {
    const root = tmpRoot();
    const cookies = loginFile("csrf-token", "301");
    await resolveSeasonIdToSectionId({ seasonId: 321, cookiesPath: cookies, dataRoot: root, fetchImpl: mockUpstream({ seasonId: 321 }).fetchImpl });
    __resetSeasonMemCache();

    const never = vi.fn(() => { throw new Error("must not fetch"); }) as unknown as typeof fetch;
    const r = await resolveSectionIdFromSeasonId({ seasonId: 321, cookiesPath: cookies, dataRoot: root, fetchImpl: never });
    expect(r).toMatchObject({ status: "resolved", fromCache: true });
  });

  it("treats null / array / scalar / malformed entries as an empty cache without throwing", async () => {
    const root = tmpRoot();
    mkdirSync(join(root, "db"), { recursive: true });
    const p = join(root, "db", "season-id-cache.json");
    for (const garbage of ["null", "[]", "\"str\"", "42", "{\"bilibili:401||1\": null}", "{\"bilibili:401||1\": \"x\"}", "{\"bilibili:401||1\": {\"sectionId\": \"nope\"}}", "{oops"]) {
      writeFileSync(p, garbage, "utf-8");
      __resetSeasonMemCache();
      expect(() => seasonSectionCacheGet("bilibili:401", 1, root)).not.toThrow();
      expect(seasonSectionCacheGet("bilibili:401", 1, root)).toBeUndefined();
    }
  });

  it("clears one entry without touching the others", async () => {
    const root = tmpRoot();
    const cookies = loginFile("csrf-token", "501");
    await resolveSeasonIdToSectionId({ seasonId: 1, cookiesPath: cookies, dataRoot: root, fetchImpl: mockUpstream({ seasonId: 1 }).fetchImpl });
    await resolveSeasonIdToSectionId({ seasonId: 2, cookiesPath: cookies, dataRoot: root, fetchImpl: mockUpstream({ seasonId: 2 }).fetchImpl });
    seasonSectionCacheClear("bilibili:501", 1, root);
    expect(seasonSectionCacheGet("bilibili:501", 1, root)).toBeUndefined();
    expect(seasonSectionCacheGet("bilibili:501", 2, root)).toBe(600);
  });
});

describe("addArchiveToSeasonIfConfigured (season-id path)", () => {
  it("single-section: resolves then adds", async () => {
    const cookies = loginFile("csrf-token", "601");
    const { fetchImpl, calls } = mockUpstream({});
    const r = await addArchiveToSeasonIfConfigured({ seasonId: 500, cookiesPath: cookies, dataRoot: tmpRoot(), fetchImpl, aid: 1 });
    expect(r.status).toBe("added");
    expect(calls.seasons).toBe(1);
    expect(calls.add).toBe(1);
  });

  it("a cached section rejected for good is cleared, re-resolved once and retried once", async () => {
    const root = tmpRoot();
    const cookies = loginFile("csrf-token", "602");
    // Seed the cache with section 600.
    await resolveSeasonIdToSectionId({ seasonId: 510, cookiesPath: cookies, dataRoot: root, fetchImpl: mockUpstream({ seasonId: 510 }).fetchImpl });
    expect(seasonSectionCacheGet("bilibili:602", 510, root)).toBe(600);

    // 600 is rejected for good; the fresh scan yields 601, which succeeds.
    const { fetchImpl, calls } = mockUpstream({
      seasonId: 510,
      sections: [{ id: 601, title: "Sec" }],
      sectionIds: [601],
      add: (b) => (b.sectionId === 600 ? json({ code: 7, message: "section not mine" }) : json({ code: 0, data: null })),
    });
    const r = await addArchiveToSeasonIfConfigured({ seasonId: 510, cookiesPath: cookies, dataRoot: root, fetchImpl, aid: 1 });
    expect(r.status).toBe("added");
    expect(calls.add).toBe(2);
    expect(calls.seasons).toBe(1); // first attempt served from cache
    expect(seasonSectionCacheGet("bilibili:602", 510, root)).toBe(601);
  });

  it("still failing after the retry ends as failed (with the season hint)", async () => {
    const root = tmpRoot();
    const cookies = loginFile("csrf-token", "603");
    await resolveSeasonIdToSectionId({ seasonId: 520, cookiesPath: cookies, dataRoot: root, fetchImpl: mockUpstream({ seasonId: 520 }).fetchImpl });

    const { fetchImpl } = mockUpstream({ seasonId: 520, add: () => json({ code: 7, message: "denied" }) });
    const r = await addArchiveToSeasonIfConfigured({ seasonId: 520, cookiesPath: cookies, dataRoot: root, fetchImpl, aid: 1 });
    expect(r.status).toBe("failed");
    if (r.status !== "failed") throw new Error("expected failed");
    expect(r.retryable).toBe(false);
    expect(r.error).toContain(SEASON_ID_HINT);
  });

  it("multi-section / not-owned: exactly one seasons scan and zero add POSTs", async () => {
    const cookies = loginFile("csrf-token", "604");
    const logs: string[] = [];

    const multi = mockUpstream({ seasons: () => json(seasonsPage(530, [{ id: 1 }, { id: 2 }])) });
    const r1 = await addArchiveToSeasonIfConfigured({
      seasonId: 530, cookiesPath: cookies, dataRoot: tmpRoot(), fetchImpl: multi.fetchImpl, aid: 1, note: (m) => logs.push(m),
    });
    expect(r1.status).toBe("failed");
    expect(multi.calls.seasons).toBe(1);
    expect(multi.calls.add).toBe(0);

    const notOwned = mockUpstream({ seasons: () => json(seasonsPage(1, [{ id: 10 }])) });
    const r2 = await addArchiveToSeasonIfConfigured({ seasonId: 999, cookiesPath: cookies, dataRoot: tmpRoot(), fetchImpl: notOwned.fetchImpl, aid: 1 });
    expect(r2.status).toBe("failed");
    expect(notOwned.calls.seasons).toBe(1);
    expect(notOwned.calls.add).toBe(0);

    // The season-id path names the configured 合集 (never "小节 0") and carries the hint.
    expect(logs.join("\n")).toContain("合集 530");
    expect(logs.join("\n")).not.toContain("小节 0");
  });

  it("a resolver network error is retryable and never POSTs", async () => {
    const cookies = loginFile("csrf-token", "605");
    const { fetchImpl, calls } = mockUpstream({ seasons: () => { throw new Error("network down"); } });
    const r = await addArchiveToSeasonIfConfigured({ seasonId: 540, cookiesPath: cookies, dataRoot: tmpRoot(), fetchImpl, aid: 1 });
    expect(r.status).toBe("failed");
    if (r.status !== "failed") throw new Error("expected failed");
    expect(r.retryable).toBe(true);
    expect(calls.add).toBe(0);
  });

  it("one shared budget: an exhausted totalTimeoutMs stops before any POST (retryable)", async () => {
    const cookies = loginFile("csrf-token", "607");
    const { fetchImpl, calls } = mockUpstream({ seasonId: 550 });
    const r = await addArchiveToSeasonIfConfigured({
      seasonId: 550, cookiesPath: cookies, dataRoot: tmpRoot(), fetchImpl, aid: 1, totalTimeoutMs: 0,
    });
    expect(r.status).toBe("failed");
    if (r.status !== "failed") throw new Error("expected failed");
    expect(r.retryable).toBe(true);
    expect(calls.add).toBe(0);
    expect(calls.seasons).toBe(0);
  });

  it("legacy seasonSectionId-only rules are unchanged (no seasons request)", async () => {
    const cookies = loginFile("csrf-token", "606");
    const calls: string[] = [];
    const fetchImpl = vi.fn(async (url: string | URL | Request) => {
      const u = String(url);
      calls.push(u);
      if (u.includes("/season/section/episodes/add")) return json({ code: 0, data: null });
      if (u.includes("/season/section?id=")) return json({ code: 0, data: { episodes: [] } });
      if (u.includes("/x/vupre/web/archive/view")) return archiveView();
      return json({}, 404);
    }) as unknown as typeof fetch;
    const r = await addArchiveToSeasonIfConfigured({ sectionId: 700, cookiesPath: cookies, dataRoot: tmpRoot(), fetchImpl, aid: 1 });
    expect(r.status).toBe("added");
    expect(calls.some((u) => u.includes("x2/creative/web/seasons"))).toBe(false);
  });

  it("skips with the legacy text when nothing is configured", async () => {
    const r = await addArchiveToSeasonIfConfigured({ cookiesPath: "/nope" });
    expect(r).toMatchObject({ status: "skipped", reason: "合集小节 ID 未配置" });
  });
});

describe("resolveSeasonTarget (precedence)", () => {
  it("rule.seasonId > rule.seasonSectionId > defaults.seasonId > defaults.seasonSectionId", () => {
    const rows: Array<[unknown, unknown, unknown, unknown, unknown]> = [
      // rule season, rule section, default season, default section, expected
      [10, 20, 30, 40, { kind: "seasonId", seasonId: 10 }],
      [undefined, 20, 30, 40, { kind: "sectionId", sectionId: 20 }],
      [undefined, undefined, 30, 40, { kind: "seasonId", seasonId: 30 }],
      [undefined, undefined, undefined, 40, { kind: "sectionId", sectionId: 40 }],
      [undefined, undefined, undefined, undefined, undefined],
      // explicit off stops the chain (never falls back to an inherited default)
      [null, undefined, 30, 40, undefined],
      [undefined, null, 30, 40, undefined],
      [null, 20, 30, 40, undefined],
      // a rule-level sectionId (number or null) blocks an inherited default seasonId
      [undefined, 20, 30, undefined, { kind: "sectionId", sectionId: 20 }],
      // numeric strings are accepted; invalid values are ignored
      ["10", undefined, undefined, undefined, { kind: "seasonId", seasonId: 10 }],
      [0, undefined, undefined, undefined, undefined],
      [-1, undefined, undefined, undefined, undefined],
      [1.5, undefined, undefined, undefined, undefined],
    ];
    for (const [rs, rsec, ds, dsec, expected] of rows) {
      expect(resolveSeasonTarget(rs, rsec, ds, dsec), JSON.stringify([rs, rsec, ds, dsec])).toEqual(expected);
    }
  });
});

describe("hintSeasonTitleForMaster", () => {
  it("returns season / section on success and distinct text otherwise, without writing any cache", async () => {
    const root = tmpRoot();
    const cookies = loginFile("csrf-token", "701");
    const ok = vi.fn(async () => json(seasonsPage(42, [{ id: 43, title: "Part A" }], "Season X"))) as unknown as typeof fetch;
    expect(await hintSeasonTitleForMaster({ seasonId: 42, cookiesPath: cookies, fetchImpl: ok })).toBe("Season X / Part A");

    const multi = vi.fn(async () => json(seasonsPage(42, [{ id: 1 }, { id: 2 }]))) as unknown as typeof fetch;
    expect(await hintSeasonTitleForMaster({ seasonId: 42, cookiesPath: loginFile("csrf-token", "702"), fetchImpl: multi })).toContain("多个小节");

    const missing = vi.fn(async () => json(seasonsPage(1, [{ id: 10 }]))) as unknown as typeof fetch;
    expect(await hintSeasonTitleForMaster({ seasonId: 42, cookiesPath: loginFile("csrf-token", "703"), fetchImpl: missing }))
      .toBe("master 账号下没有该合集,将由录制节点用自己的账号获取");

    const boom = vi.fn(async () => { throw new Error("network down"); }) as unknown as typeof fetch;
    expect(await hintSeasonTitleForMaster({ seasonId: 42, cookiesPath: loginFile("csrf-token", "704"), fetchImpl: boom }))
      .toContain("暂时无法验证");

    // The hint must never persist anything: no disk file, no in-memory entry.
    expect(existsSync(join(root, "db", "season-id-cache.json"))).toBe(false);
    __resetSeasonMemCache();
    expect(seasonSectionCacheGet("bilibili:701", 42, root)).toBeUndefined();
  });
});
