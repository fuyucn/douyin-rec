/** issue #158:applyTimezoneFromDb 无库时保留继承 TZ;dbPathForDataRoot 指向 <dataRoot>/db。 */
import { afterEach, describe, expect, it } from "vitest";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { applyTimezoneFromDb, dbPathForDataRoot } from "../../packages/app/src/timezone.js";

const orig = process.env.TZ;
afterEach(() => { if (orig === undefined) delete process.env.TZ; else process.env.TZ = orig; });

describe("applyTimezoneFromDb 无库(issue #158)", () => {
  it("库不存在 + 继承了有效 TZ → 保留,不覆盖成北京", () => {
    process.env.TZ = "America/Los_Angeles";
    expect(applyTimezoneFromDb(join(mkdtempSync(join(tmpdir(), "tzdb-")), "none.db"))).toBe("America/Los_Angeles");
    expect(process.env.TZ).toBe("America/Los_Angeles");
  });
  it("库不存在 + 无继承 TZ → 缺省北京", () => {
    delete process.env.TZ;
    expect(applyTimezoneFromDb(join(mkdtempSync(join(tmpdir(), "tzdb-")), "none.db"))).toBe("Asia/Shanghai");
  });
  it("dbPathForDataRoot = <dataRoot>/db/douyin-rec.db", () => {
    expect(dbPathForDataRoot("/r")).toBe(join("/r", "db", "douyin-rec.db"));
  });
});
