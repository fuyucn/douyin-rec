import { describe, it, expect, beforeAll, afterAll } from "vitest";
import { mkdtempSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
// Import the package surface, not the source file: this asserts what a wiring layer can actually use.
import { createUposTarget, UPOS_TARGET_ID } from "@drec/bilibili-upload";

const S = (a: string, b: string) => a + b;
const FAKE_BV = S("BV", "1UposTargetAb");
const FAKE_AID = 900001;
const POLICY = { visibility: "private" as const, watermark: false as const, copyright: "self" as const };
const PUBLIC = { visibility: "public" as const, watermark: false as const, copyright: "self" as const };

let dir: string;
let cookies: string;

beforeAll(() => {
  dir = mkdtempSync(join(tmpdir(), "upos-target-"));
  cookies = join(dir, "cookies.json");
  writeFileSync(
    cookies,
    JSON.stringify({
      cookie_info: {
        cookies: [
          { name: "SESSDATA", value: "fake-sess" },
          { name: "bili_jct", value: "fake-csrf" },
          { name: "DedeUserID", value: "42" },
        ],
      },
    }),
    "utf-8",
  );
});

afterAll(() => rmSync(dir, { recursive: true, force: true }));

// Getters, not values: `cookies` only exists after beforeAll, and this const is evaluated at load.
const CRED = { targetId: UPOS_TARGET_ID, get locator() { return cookies; } };

/** Target wired to the fake network; chunk bytes come from a stub, no file is created. */
function netTarget(net: ReturnType<typeof fakeNet>, size = 4) {
  return createUposTarget({
    fetchImpl: net.fetchImpl,
    statSize: () => size,
    readSlice: (_p: string, _s: number, len: number) => new Uint8Array(len),
  });
}

type Call = { url: string; method: string; body?: unknown };

function json(o: unknown, status = 200): Response {
  return new Response(JSON.stringify(o), { status, headers: { "content-type": "application/json" } });
}

/**
 * Fake UPOS + member endpoints. Each response is configurable per test so an assertion can prove
 * which step produced the outcome (e.g. a chunk failure must never reach the submit).
 */
function fakeNet(o: {
  preupload?: () => Response;
  chunk?: (n: number) => Response;
  complete?: () => Response;
  submit?: () => Response;
  edit?: () => Response;
  view?: () => Response;
  list?: () => Response;
  throwOnSubmit?: Error;
}) {
  const calls: Call[] = [];
  const fetchImpl = (async (input: unknown, init: { method?: string; body?: unknown } = {}) => {
    const url = String(input);
    const method = String(init.method ?? "GET").toUpperCase();
    let body: unknown;
    if (method !== "PUT" && typeof init.body === "string") {
      try { body = JSON.parse(init.body); } catch { body = init.body; }
    }
    calls.push({ url, method, ...(body !== undefined ? { body } : {}) });
    if (url.includes("/preupload")) {
      return (o.preupload ?? (() => json({
        OK: 1, chunk_size: 4, auth: "auth", endpoint: "//upos.example", biz_id: FAKE_AID,
        upos_uri: "upos://bucket/declared.ts",
      })))();
    }
    if (method === "POST" && url.includes("uploads")) return json({ upload_id: "up1" });
    if (method === "PUT") {
      const n = Number(new URL(url).searchParams.get("partNumber") ?? "0");
      return o.chunk ? o.chunk(n) : new Response("ok", { status: 200 });
    }
    if (url.includes("biz_id=") && url.includes("output=json")) {
      return (o.complete ?? (() => json({ OK: 1, key: "bucket/stem1.ts" })))();
    }
    if (url.includes("/x/vu/web/add/v3")) {
      if (o.throwOnSubmit) throw o.throwOnSubmit;
      return (o.submit ?? (() => json({ code: 0, data: { aid: FAKE_AID, bvid: FAKE_BV } })))();
    }
    if (url.includes("/x/vu/web/edit")) {
      if (o.throwOnSubmit) throw o.throwOnSubmit;
      return (o.edit ?? (() => json({ code: 0, data: { aid: FAKE_AID, bvid: FAKE_BV } })))();
    }
    if (url.includes("archive/view")) {
      return (o.view ?? (() => json({
        code: 0,
        data: {
          archive: { aid: FAKE_AID, bvid: FAKE_BV, title: "t", tid: 21, tag: "x", is_only_self: 1 },
          videos: [{ cid: 1, filename: "stem0", title: "P1" }],
        },
      })))();
    }
    if (url.includes("/x/web/archives")) {
      return (o.list ?? (() => json({ code: 0, data: { archives: [] } })))();
    }
    throw new Error("unexpected url: " + url);
  }) as unknown as typeof fetch;
  return { calls, fetchImpl };
}

describe("upos target: create", () => {
  it("submits the complete() stem and keeps the hard policy", async () => {
    const net = fakeNet({});
    const t = netTarget(net, 6);
    const r = await t.create({
      cred: CRED,
      title: "标题",
      files: [{ path: "/tmp/a.mp4", title: "P1" }],
      policy: POLICY,
      tags: ["t1", "t2"],
      desc: "简介",
    });
    expect(r.proof).toBe("created");
    expect(r.ref).toEqual({ targetId: UPOS_TARGET_ID, id: FAKE_BV });
    const submit = net.calls.find((c) => c.url.includes("/x/vu/web/add/v3"));
    expect(submit).toBeTruthy();
    const b = submit!.body as Record<string, unknown> & {
      videos: Array<{ filename: string; title?: string }>;
      watermark: { state: number };
      is_only_self: number;
      copyright: number;
      tag: string;
    };
    // The stem from complete() — the declared preupload name must never reach Studio (21015).
    expect(b.videos[0].filename).toBe("stem1");
    expect(b.videos[0].title).toBe("P1");
    expect(b.watermark.state).toBe(0);
    expect(b.copyright).toBe(1);
    expect(b.is_only_self).toBe(1);
    expect(b.tag).toBe("t1,t2");
    // 2 chunks of 4 bytes for a 6-byte file, all before the submit.
    expect(net.calls.filter((c) => c.method === "PUT")).toHaveLength(2);
  });

  it("only an explicit public policy publishes", async () => {
    const net = fakeNet({});
    const t = netTarget(net, 4);
    await t.create({ cred: CRED, title: "标题", files: [{ path: "/tmp/a.mp4" }], policy: PUBLIC });
    const submit = net.calls.find((c) => c.url.includes("/x/vu/web/add/v3"));
    expect((submit!.body as { is_only_self: number }).is_only_self).toBe(0);
  });

  it("an ok submit without a bvid is unknown, and is never retried", async () => {
    const net = fakeNet({ submit: () => json({ code: 0, data: {} }) });
    const t = netTarget(net, 4);
    const r = await t.create({ cred: CRED, title: "标题", files: [{ path: "/tmp/a.mp4" }], policy: POLICY });
    expect(r).toEqual({ proof: "unknown", ref: null });
    expect(net.calls.filter((c) => c.url.includes("/x/vu/web/add/v3"))).toHaveLength(1);
  });

  it("maps a submit rejection to rate-limited so the driver cools down instead of guessing", async () => {
    const net = fakeNet({ submit: () => json({ code: 21566, message: "投稿过于频繁" }) });
    const t = netTarget(net, 4);
    let thrown: unknown;
    try {
      await t.create({ cred: CRED, title: "标题", files: [{ path: "/tmp/a.mp4" }], policy: POLICY });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeTruthy();
    expect(t.classifyError(thrown).kind).toBe("rate-limited");
  });

  it("a create rejection that only mentions timeout is unknown", async () => {
    // Raw text matching turned such a body into a transient create and retried it five times.
    const net = fakeNet({ submit: () => json({ code: -400, message: "upstream timeout" }) });
    const t = netTarget(net, 4);
    const r = await t.create({ cred: CRED, title: "标题", files: [{ path: "/tmp/a.mp4" }], policy: POLICY });
    expect(r).toEqual({ proof: "unknown", ref: null });
    expect(net.calls.filter((c) => c.url.includes("/x/vu/web/add/v3"))).toHaveLength(1);
  });

  it("a transport error on the create POST is unknown, never retried", async () => {
    // submitStudio wraps the POST in a 60s timeout: a thrown transport error after the request
    // may already have built the archive. Classifying it as transient would POST again.
    const net = fakeNet({ throwOnSubmit: new Error("socket hang up") });
    const t = netTarget(net, 4);
    const r = await t.create({ cred: CRED, title: "标题", files: [{ path: "/tmp/a.mp4" }], policy: POLICY });
    expect(r).toEqual({ proof: "unknown", ref: null });
    expect(net.calls.filter((c) => c.url.includes("/x/vu/web/add/v3"))).toHaveLength(1);
  });

  it("a chunk failure never reaches the submit", async () => {
    // 400 = a rejection the retry loop treats as final; 5xx would sleep through 1+2+3s retries.
    const net = fakeNet({ chunk: () => new Response("boom", { status: 400 }) });
    const t = netTarget(net, 8);
    let thrown: unknown;
    try {
      await t.create({ cred: CRED, title: "标题", files: [{ path: "/tmp/a.mp4" }], policy: POLICY });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeTruthy();
    expect(String((thrown as Error).message)).toContain("分块");
    expect(net.calls.some((c) => c.url.includes("/x/vu/web/add/v3"))).toBe(false);
    expect(t.classifyError(thrown).kind).toBe("permanent");
  });

  it("uploads in-memory bytes without touching the disk", async () => {
    const reads: Array<[number, number]> = [];
    const net = fakeNet({});
    const t = createUposTarget({
      fetchImpl: net.fetchImpl,
      readSlice: () => {
        throw new Error("the disk must not be read when a byte source is present");
      },
    });
    const r = await t.create({
      cred: CRED,
      title: "标题",
      files: [
        {
          path: "memory://part",
          source: {
            size: 6,
            readChunk: async (i, size) => {
              reads.push([i, size]);
              return new Uint8Array(size).fill(i);
            },
          },
        },
      ],
      policy: POLICY,
    });
    expect(r.proof).toBe("created");
    expect(reads).toEqual([[0, 4], [1, 2]]);
  });
});

describe("upos target: append", () => {
  it("merges the new part into the existing list instead of replacing it", async () => {
    const net = fakeNet({});
    const t = netTarget(net, 4);
    const r = await t.append({
      cred: CRED,
      ref: { targetId: UPOS_TARGET_ID, id: FAKE_BV },
      files: [{ path: "/tmp/b.mp4", title: "P2" }],
      policy: POLICY,
    });
    expect(r.proof).toBe("observed");
    const edit = net.calls.find((c) => c.url.includes("/x/vu/web/edit"));
    const videos = (edit!.body as { videos: Array<{ filename: string }>; aid: number }).videos;
    expect(videos.map((v) => v.filename)).toEqual(["stem0", "stem1"]);
    expect((edit!.body as { aid: number }).aid).toBe(FAKE_AID);
  });

  it("an already-present stem is idempotent and posts no edit", async () => {
    const net = fakeNet({
      view: () => json({ code: 0, data: {
        archive: { aid: FAKE_AID, bvid: FAKE_BV, title: "t", tid: 21, tag: "x", is_only_self: 1 },
        videos: [{ filename: "stem1" }],
      } }),
    });
    const t = netTarget(net, 4);
    const r = await t.append({
      cred: CRED,
      ref: { targetId: UPOS_TARGET_ID, id: FAKE_BV },
      files: [{ path: "/tmp/b.mp4" }],
      policy: POLICY,
    });
    expect(r.proof).toBe("observed");
    expect(net.calls.some((c) => c.url.includes("/x/vu/web/edit"))).toBe(false);
  });

  it("a transport failure during submit is unknown, never retried", async () => {
    const net = fakeNet({ throwOnSubmit: new Error("socket hang up") });
    const t = netTarget(net, 4);
    const r = await t.append({
      cred: CRED,
      ref: { targetId: UPOS_TARGET_ID, id: FAKE_BV },
      files: [{ path: "/tmp/b.mp4" }],
      policy: POLICY,
    });
    expect(r.proof).toBe("unknown");
    expect(net.calls.filter((c) => c.url.includes("/x/vu/web/edit"))).toHaveLength(1);
  });

  it("a rejected append whose text mentions timeout is unknown, not a retry", async () => {
    const net = fakeNet({ edit: () => json({ code: -400, message: "timeout" }) });
    const t = netTarget(net, 4);
    const r = await t.append({
      cred: CRED,
      ref: { targetId: UPOS_TARGET_ID, id: FAKE_BV },
      files: [{ path: "/tmp/b.mp4" }],
      policy: POLICY,
    });
    expect(r.proof).toBe("unknown");
    expect(net.calls.filter((c) => c.url.includes("/x/vu/web/edit"))).toHaveLength(1);
  });

  it("a rejected second part after a landed first one is unknown, not a retry", async () => {
    let edits = 0;
    const net = fakeNet({
      edit: () => {
        edits++;
        return edits === 1
          ? json({ code: 0, data: { aid: FAKE_AID, bvid: FAKE_BV } })
          : json({ code: 21540, message: "请求过于频繁" });
      },
    });
    const t = netTarget(net, 4);
    const r = await t.append({
      cred: CRED,
      ref: { targetId: UPOS_TARGET_ID, id: FAKE_BV },
      files: [{ path: "/tmp/b.mp4" }, { path: "/tmp/c.mp4" }],
      policy: POLICY,
    });
    expect(r.proof).toBe("unknown");
    expect(edits).toBe(2);
  });
});

describe("upos target: inspect and findRecent", () => {
  it("inspect reports the private flag and the part list", async () => {
    const net = fakeNet({});
    const t = createUposTarget({ fetchImpl: net.fetchImpl });
    const info = await t.inspect({ ref: { targetId: UPOS_TARGET_ID, id: FAKE_BV }, cred: CRED });
    expect(info).not.toBeNull();
    expect(info!.visibility).toBe("private");
    expect(info!.partCount).toBe(1);
    expect(info!.parts).toEqual([{ index: 1, title: "P1" }]);
  });

  it("inspect returns null when the archive cannot be read", async () => {
    const net = fakeNet({ view: () => json({ code: -404 }, 200) });
    const t = createUposTarget({ fetchImpl: net.fetchImpl });
    expect(await t.inspect({ ref: { targetId: UPOS_TARGET_ID, id: FAKE_BV }, cred: CRED })).toBeNull();
  });

  it("findRecent distinguishes none, one and many", async () => {
    const none = createUposTarget({
      fetchImpl: fakeNet({ list: () => json({ code: 0, data: { archives: [] } }) }).fetchImpl,
    });
    expect(await none.findRecent({ cred: CRED, title: "标题" })).toBe("none");

    const one = createUposTarget({
      fetchImpl: fakeNet({ list: () => json({ code: 0, data: { archives: [{ aid: FAKE_AID, bvid: FAKE_BV, title: "标题" }] } }) }).fetchImpl,
    });
    const hit = await one.findRecent({ cred: CRED, title: "标题" });
    expect(hit).not.toBe("unknown");
    expect(hit).not.toBe("none");
    expect((hit as { ref: { id: string } }).ref.id).toBe(FAKE_BV);

    const many = createUposTarget({
      fetchImpl: fakeNet({
        list: () => json({ code: 0, data: { archives: [
          { aid: FAKE_AID, bvid: FAKE_BV, title: "标题" },
          { aid: FAKE_AID + 1, bvid: "BVother", title: "标题" },
        ] } }),
      }).fetchImpl,
    });
    expect(await many.findRecent({ cred: CRED, title: "标题" })).toBe("unknown");
  });

  it("findRecent never returns none when the list could not be read", async () => {
    const net = fakeNet({ list: () => new Response("nope", { status: 500 }) });
    const t = createUposTarget({ fetchImpl: net.fetchImpl });
    expect(await t.findRecent({ cred: CRED, title: "标题" })).toBe("unknown");
  });
});

describe("upos target: contract surface", () => {
  it("declares a single-part append granularity and the bilibili defaults", () => {
    const t = createUposTarget({ statSize: () => 1 });
    expect(t.id).toBe(UPOS_TARGET_ID);
    expect(t.platformIds).toEqual(["bilibili"]);
    expect(t.capabilities).toEqual({ appendGranularity: "single", seasons: false, streamPublish: true });
    expect(t.hardPolicy()).toEqual({ visibility: "private", watermark: false, copyright: "self" });
    expect(t.defaults().tid).toBe(21);
    expect(t.defaults().titleMaxLength).toBe(80);
  });

  it("resolves credentials explicit > env > data root, and refuses a missing file", () => {
    const t = createUposTarget({
      exists: (p) => p === "/x/ck.json",
      env: () => "/y/ck.json",
    });
    expect(t.resolveCredential({ dataRoot: "/root", explicitPath: "/x/ck.json" }).locator).toBe("/x/ck.json");
    const missing = createUposTarget({ exists: () => false });
    expect(() => missing.resolveCredential({ dataRoot: "/root" })).toThrow(/凭据/);
  });

  it("accountKey is stable per account even when the path changes", () => {
    const text = JSON.stringify({ cookie_info: { cookies: [{ name: "DedeUserID", value: "42" }] } });
    const a = createUposTarget({ readText: () => text });
    const b = createUposTarget({ readText: () => text });
    expect(a.accountKey({ targetId: UPOS_TARGET_ID, locator: "/a/ck.json" }))
      .toBe(b.accountKey({ targetId: UPOS_TARGET_ID, locator: "/b/ck.json" }));
  });
});


describe("upos target: publishStreamed (stage 2b-2b)", () => {
  it("creates without uploading the bytes again", async () => {
    const net = fakeNet({});
    const t = netTarget(net, 6);
    expect(t.capabilities.streamPublish).toBe(true);
    const r = await t.publishStreamed!({
      cred: CRED,
      ref: null,
      name: "stem0",
      title: "P1",
      archive: { title: "标题", tid: 21, tags: ["t1"], policy: POLICY },
    });
    expect(r).toEqual({ proof: "created", ref: { targetId: UPOS_TARGET_ID, id: FAKE_BV } });
    expect(net.calls.some((c) => c.url.includes("/preupload"))).toBe(false);
    expect(net.calls.some((c) => c.method === "PUT")).toBe(false);
    expect(net.calls.filter((c) => c.url.includes("/x/vu/web/add/v3"))).toHaveLength(1);
  });

  it("appends a part with metadata only", async () => {
    const net = fakeNet({});
    const t = netTarget(net, 6);
    const ref = { targetId: UPOS_TARGET_ID, id: FAKE_BV };
    const r = await t.publishStreamed!({ cred: CRED, ref, name: "stem1", title: "P2" });
    expect(r).toEqual({ proof: "confirmed", ref });
    expect(net.calls.some((c) => c.url.includes("preupload"))).toBe(false);
    expect(net.calls.filter((c) => c.url.includes("/x/vu/web/edit"))).toHaveLength(1);
  });

  it("a rejected edit is unknown too: never retried with the same payload", async () => {
    // The legacy path stops on any non-rate-limited rejection. "confirmed-not-submitted" is a
    // retry licence, and resubmitting a 21001 invalid payload five times cannot succeed; an
    // unreadable rejection may even have applied. Both stop, so both report unknown.
    const rejected = await netTarget(fakeNet({ edit: () => json({ code: 21001, message: "参数错误" }) }), 6)
      .publishStreamed!({ cred: CRED, ref: { targetId: UPOS_TARGET_ID, id: FAKE_BV }, name: "stem1" });
    expect(rejected.proof).toBe("unknown");
    const unreadable = await netTarget(fakeNet({ throwOnSubmit: new Error("[append-ambiguous] socket hang up") }), 6)
      .publishStreamed!({ cred: CRED, ref: { targetId: UPOS_TARGET_ID, id: FAKE_BV }, name: "stem1" });
    expect(unreadable.proof).toBe("unknown");
  });
});
