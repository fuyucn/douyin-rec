/**
 * Issue #479: douyinPlatform.getLiving must forward opts.apiMode to getInfo — the live gate relies on
 * that forwarding to use the same endpoint as the child it gates without touching process.env.
 *
 * The platform entry pulls in `./stream/index.js` (vendored extraction → sm-crypto), which vitest cannot
 * load; that module is mocked here, so the real platform object under test is still `douyinPlatform` from
 * `src/index.ts` — not a copy of its body. This is the seam the review asked for: reverting getLiving to
 * `resolveApiMode()` makes these assertions fail.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from "vitest";
import { DEFAULT_DOUYIN_API_MODE } from "@drec/core";

const getInfo = vi.fn();
vi.mock("../../packages/douyin-live/src/stream/index.js", () => ({
  getStream: vi.fn(),
  getInfo: (...args: unknown[]) => getInfo(...args),
  resolveShortURL: vi.fn(),
  resolveWebRid: vi.fn(),
}));

const KEY = "DOUYIN_REC_API_MODE";

let douyinPlatform: { getLiving: (id: string, opts?: { apiMode?: string }) => Promise<boolean> };
beforeEach(async () => {
  getInfo.mockReset();
  getInfo.mockResolvedValue({ living: true });
  delete process.env[KEY];
  ({ douyinPlatform } = await import("../../packages/douyin-live/src/index.js"));
});
afterEach(() => { delete process.env[KEY]; });

/** The `api` argument getInfo received on its last call. */
const lastApi = (): unknown => (getInfo.mock.calls.at(-1)?.[1] as { api?: unknown } | undefined)?.api;

describe("douyinPlatform.getLiving forwards the per-call apiMode (issue #479)", () => {
  it("opts.apiMode reaches getInfo as { api }", async () => {
    await expect(douyinPlatform.getLiving("x", { apiMode: "web" })).resolves.toBe(true);
    expect(getInfo).toHaveBeenCalledTimes(1);
    expect(getInfo.mock.calls[0][0]).toBe("x");
    expect(lastApi()).toBe("web");
  });

  it("per-call mode wins over a different env value", async () => {
    process.env[KEY] = "mobile";
    await douyinPlatform.getLiving("x", { apiMode: "web" });
    expect(lastApi()).toBe("web"); // not "mobile"
  });

  it("no opts → the env decides (unchanged behaviour)", async () => {
    process.env[KEY] = "webHTML";
    await douyinPlatform.getLiving("x");
    expect(lastApi()).toBe("webHTML");
  });

  it("no opts and no env → the default mode", async () => {
    await douyinPlatform.getLiving("x");
    expect(lastApi()).toBe(DEFAULT_DOUYIN_API_MODE);
  });

  it("an invalid per-call mode is normalized instead of being forwarded verbatim", async () => {
    await douyinPlatform.getLiving("x", { apiMode: "bogus" });
    expect(lastApi()).toBe(DEFAULT_DOUYIN_API_MODE);
  });
});

