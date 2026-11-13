/**
 * upos-target's streamed publish, classified at the seam the upload driver relies on.
 *
 * These assertions are about *classification*, because that is what decides whether the driver
 * retries, cools the account, or hands the part to a human. The target had no test file at all
 * before this one, which is how "a rate-limited append reports confirmed-not-submitted" survived.
 */
import { describe, it, expect, beforeEach, afterEach, vi } from "vitest";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { createUposTarget, UPOS_TARGET_ID } from "./upos-target.js";
import { createUploadDriver, type UploadCheckpoint, type UploadPartRecord, type UploadStateStore } from "@drec/upload-runtime";
import type { PublishStreamedInput } from "@drec/core";

let dir: string;
let cookiesPath: string;

beforeEach(() => {
  dir = mkdtempSync(join(tmpdir(), "upos-publish-"));
  cookiesPath = join(dir, "cookies.json");
  writeFileSync(cookiesPath, JSON.stringify({
    cookie_info: { cookies: [{ name: "SESSDATA", value: "x" }, { name: "bili_jct", value: "csrf-abc" }] },
  }));
});
// This package is scanned by the deletion guard (plan 046 §8): a test must not introduce a new
// deletion call. The temp dir is created under the OS temp root, which the runner reclaims.
afterEach(() => { vi.restoreAllMocks(); });

const CRED = () => ({ targetId: UPOS_TARGET_ID, locator: cookiesPath });
const REF = { targetId: UPOS_TARGET_ID, id: "BILIfake1" };

/** Minimal checkpoint store; this test only cares about classification and waits. */
function memoryStore(): UploadStateStore {
  const map = new Map<string, UploadCheckpoint>();
  const parts: UploadPartRecord[] = [];
  return {
    load: (key) => map.get(key) ?? null,
    save: (key, cp) => { map.set(key, cp); },
    confirmPart: (key, part) => {
      parts.push(part);
      const cur = map.get(key);
      if (cur) map.set(key, { ...cur, parts: [...cur.parts, part] });
    },
  };
}
const ARCHIVE = { title: "T", tid: 21, tags: ["x"], policy: { visibility: "private", watermark: false, copyright: "self" } as const };

/** Fake wire: every response is configurable per endpoint, nothing leaves the process. */
function fakeFetch(o: {
  create?: Record<string, unknown>;
  createThrows?: unknown;
  viewArchive?: Record<string, unknown> | null;
  edit?: Record<string, unknown>;
  editThrows?: unknown;
}) {
  const hits: string[] = [];
  const impl = (async (input: string | URL | Request) => {
    const u = new URL(typeof input === "string" ? input : input instanceof URL ? input.toString() : input.url);
    hits.push(u.pathname);
    const json = (body: unknown): Response => new Response(JSON.stringify(body), { status: 200 });
    if (u.pathname === "/x/vu/web/add/v3") {
      if (o.createThrows) throw o.createThrows;
      return json(o.create ?? { code: 0, data: { aid: 7, bvid: "BILIfake1" } });
    }
    if (u.pathname === "/x/vupre/web/archive/view") {
      return json({ code: 0, data: o.viewArchive ?? { archive: { aid: 7, bvid: "BILIfake1", title: "T", tid: 21, is_only_self: 1 }, videos: [] } });
    }
    if (u.pathname === "/x/vu/web/edit") {
      if (o.editThrows) throw o.editThrows;
      return json(o.edit ?? { code: 0, data: { aid: 7, bvid: "BILIfake1" } });
    }
    if (u.pathname === "/x/web/archives") return json({ code: 0, data: { arc_audits: [] } });
    return json({ code: 0, data: {} });
  }) as unknown as typeof fetch;
  return { impl, hits };
}

const target = (fetchImpl: typeof fetch) => createUposTarget({ fetchImpl, log: () => {} });

const append = (t: ReturnType<typeof target>): Promise<unknown> =>
  t.publishStreamed!({ cred: CRED(), ref: REF, name: "stem1", title: "P2" } satisfies PublishStreamedInput);

const create = (t: ReturnType<typeof target>): Promise<unknown> =>
  t.publishStreamed!({ cred: CRED(), ref: null, name: "stem0", title: "P1", archive: ARCHIVE } satisfies PublishStreamedInput);

describe("publishStreamed: append classification", () => {
  it("a submission rate limit keeps its raw body and still classifies as rate-limited", async () => {
    // Returning a bare "confirmed-not-submitted" here made the driver wait 1s/2s/4s/8s with no
    // cooldown and no account cooling, unlike the legacy path's 60s+ schedule.
    const f = fakeFetch({ edit: { code: 21540, message: "请求过于频繁,请稍后再试" } });
    const t = target(f.impl);
    // It throws on purpose: the raw body must reach classifyError so the driver can cool the
    // account instead of sleeping 1s and retrying inside the same window.
    const err = await append(t).catch((e: unknown) => e);
    expect(err).toBeInstanceOf(Error);
    expect(t.classifyError(err)).toMatchObject({ kind: "rate-limited" });
  });

  it("a provably rejected edit still reports confirmed-not-submitted", async () => {
    const f = fakeFetch({ edit: { code: 21001, message: "参数错误" } });
    const t = target(f.impl);
    await expect(append(t)).resolves.toMatchObject({ proof: "confirmed-not-submitted" });
  });

  it("an unreadable edit stays unknown and is never retried by the driver", async () => {
    const f = fakeFetch({ edit: { code: -400, message: "server error" } });
    const t = target(f.impl);
    await expect(append(t)).resolves.toMatchObject({ proof: "unknown" });
  });
});

describe("publishStreamed: create classification", () => {
  it("a transport error after the POST may have created the archive: unknown, not retried", async () => {
    // Retrying a create whose response was lost is exactly how a second archive is born.
    const f = fakeFetch({ createThrows: new Error("fetch failed") });
    const t = target(f.impl);
    await expect(create(t)).resolves.toMatchObject({ proof: "unknown", ref: null });
  });

  it("a create with no readable BV is unknown", async () => {
    const f = fakeFetch({ create: { code: 0, data: { aid: 7 } } });
    const t = target(f.impl);
    await expect(create(t)).resolves.toMatchObject({ proof: "unknown" });
  });

  it("a rate-limited create keeps the raw body for classification", async () => {
    const f = fakeFetch({ create: { code: 601, message: "您上传视频过快" } });
    const t = target(f.impl);
    const err = await create(t).catch((e) => e);
    expect(t.classifyError(err)).toMatchObject({ kind: "rate-limited" });
  });

  it("a successful create reports proof created with the BV", async () => {
    const f = fakeFetch({});
    const t = target(f.impl);
    await expect(create(t)).resolves.toEqual({ proof: "created", ref: { targetId: UPOS_TARGET_ID, id: "BILIfake1" } });
  });
});

describe("publishStreamed drives the upload driver's cooldown, not a 1s blip", () => {
  it("a rate-limited append cools the account and waits a real cooldown", async () => {
    // End to end over the real target: the target must throw a classifiable error, the driver
    // must classify it as rate-limited, then wait >= 60s and cool the shared account window.
    const f = fakeFetch({ edit: { code: 21540, message: "请求过于频繁,请稍后再试" } });
    const sleeps: number[] = [];
    const events: string[] = [];
    const d = createUploadDriver({
      target: target(f.impl),
      store: memoryStore(),
      sleep: async (ms) => { sleeps.push(ms); },
      now: () => 1_700_000_000_000,
      log: () => {},
      retry: { attempts: 5, transientBaseMs: 1_000, rateLimitMs: 60_000, maxWaitMs: 300_000 },
      accounting: {
        noteSubmit: () => events.push("submit"),
        noteRateLimited: () => events.push("rate-limited"),
      },
    });
    await expect(d.appendStreamedPart({ cred: CRED(), ref: REF, name: "stem1", title: "P2" }))
      .rejects.toMatchObject({ failure: "retry-exhausted" });
    expect(events.filter((e) => e === "rate-limited")).toHaveLength(5);
    // 60s / 120s / 240s / 300s — never the transient blip schedule.
    expect(sleeps.every((ms) => ms >= 60_000)).toBe(true);
    expect(sleeps.length).toBe(4);
  });
});
