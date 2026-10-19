// issue #265: Rooms header connection state from the room and task list fetches (pure function).
import { describe, it, expect } from "vitest";
import { connOf } from "../../packages/web/src/lib/conn.js";

describe("connOf", () => {
  it("no fetch yet → null (header shows nothing)", () => {
    expect(connOf(null, null)).toBeNull();
  });

  it("both OK → OK with the latest time (the 5 s task poll keeps it fresh)", () => {
    expect(connOf({ ok: true, at: 100 }, { ok: true, at: 900 })).toEqual({ ok: true, at: 900 });
  });

  it("a failing room fetch is not hidden by a later successful task poll", () => {
    expect(connOf({ ok: false, at: 100 }, { ok: true, at: 900 })).toEqual({ ok: false, at: 100 });
  });

  it("a failing task poll alone also shows disconnected", () => {
    expect(connOf({ ok: true, at: 100 }, { ok: false, at: 900 })).toEqual({ ok: false, at: 900 });
  });

  it("only one fetch done so far → that result", () => {
    expect(connOf(null, { ok: true, at: 5 })).toEqual({ ok: true, at: 5 });
    expect(connOf({ ok: false, at: 7 }, null)).toEqual({ ok: false, at: 7 });
  });
});
