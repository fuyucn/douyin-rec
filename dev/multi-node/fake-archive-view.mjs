// Internal-only view of the fake CLI archive. This file is never in production images.
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

function assertFakeEnvironment(env) {
  const root = env.DOUYIN_REC_ROOT;
  if (env.DREC_DEV !== "1" || env.DREC_DEV_ARCHIVE_VIEW !== "1" || !root
      || !existsSync(join(root, ".drec-dev-e2e"))) {
    throw new Error("Archive view requires an explicitly enabled, marked dev data root");
  }
  const credentials = JSON.parse(readFileSync(join(root, "config/biliup/cookies.json"), "utf8"));
  const cookies = credentials.cookie_info?.cookies;
  const validCookies = Array.isArray(cookies) && [
    ["SESSDATA", "FAKE-DEV-SESSDATA"], ["bili_jct", "FAKE-DEV-JCT"],
  ].every(([name, value]) => {
    const matches = cookies.filter((cookie) => cookie.name === name);
    return matches.length === 1 && matches[0].value === value;
  });
  if (credentials["drec-dev-fake"] !== true || !validCookies) {
    throw new Error("Archive view refuses non-fake credentials");
  }
  return root;
}

function viewId(input, init) {
  const request = input instanceof Request ? input : null;
  if ((init?.method ?? request?.method ?? "GET").toUpperCase() !== "GET") return null;
  let url;
  try { url = new URL(request ? request.url : String(input)); } catch { return null; }
  if (url.origin !== "https://api.bilibili.com" || url.username || url.password
      || url.pathname !== "/x/web-interface/view" || url.searchParams.size !== 1
      || !url.searchParams.has("bvid")) return null;
  return url.searchParams.get("bvid");
}

function hasFakeRequestCredentials(input, init) {
  const headers = new Headers(init?.headers ?? (input instanceof Request ? input.headers : undefined));
  const cookie = headers.get("cookie") ?? "";
  const pairs = cookie.split(";").map((part) => part.trim().split("="));
  return [["SESSDATA", "FAKE-DEV-SESSDATA"], ["bili_jct", "FAKE-DEV-JCT"]].every(([name, value]) => {
    const matches = pairs.filter(([key]) => key === name);
    return matches.length === 1 && matches[0].length === 2 && matches[0][1] === value;
  });
}

function observedParts(root, bv) {
  const text = readFileSync(join(root, "config/biliup/fake-archive.jsonl"), "utf8");
  let count = null;
  for (const line of text.split("\n").filter((line) => line.trim())) {
    const entry = JSON.parse(line);
    if (!entry || typeof entry !== "object") throw new Error("Malformed archive operation");
    if (entry.bv !== bv) continue;
    if (!Array.isArray(entry.files) || entry.files.length === 0
        || !entry.files.every((file) => typeof file === "string" && file.length > 0)) {
      throw new Error("Malformed archive parts");
    }
    if (entry.op === "upload") count = entry.files.length;
    else if (entry.op === "append" && count !== null) count += entry.files.length;
    else throw new Error("Unknown or out-of-order archive operation");
  }
  return count;
}

export function createArchiveViewFetch(env, forward) {
  assertFakeEnvironment(env);
  return async (input, init) => {
    const bv = viewId(input, init);
    if (bv === null) return forward(input, init);
    try {
      if (!/^BV[0-9A-Za-z]{10}$/.test(bv) || !hasFakeRequestCredentials(input, init)) {
        throw new Error("Archive view requires fake request credentials and a valid archive id");
      }
      const count = observedParts(assertFakeEnvironment(env), bv);
      if (count === null) throw new Error("Unknown fake archive");
      return Response.json({ code: 0, data: { pages: Array.from({ length: count }, (_, i) => ({ page: i + 1 })) } }, {
        headers: { "X-Drec-Dev-Archive-View": "1" },
      });
    } catch {
      return Response.json({ code: -404, message: "Fake archive unavailable" }, { status: 404 });
    }
  };
}

if (process.env.DREC_DEV_ARCHIVE_VIEW === "1") {
  globalThis.fetch = createArchiveViewFetch(process.env, globalThis.fetch.bind(globalThis));
}
