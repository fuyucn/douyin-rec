import { describe, expect, it } from "vitest";
import {
  parseDanmuFlag,
  parseRollingUploadFlag,
  parseStreamUploadFlag,
  rejectsNoSpoolFlag,
  type UploadFlagResult,
} from "../../packages/cli/src/cli-flags.js";
import { parseBoolFlag } from "../../packages/core/src/bool-flag.js";

describe("--danmu flag (issue #472)", () => {
  it("absent / blank keeps the historical default (on)", () => {
    expect(parseDanmuFlag(undefined)).toBe(true);
    expect(parseDanmuFlag("")).toBe(true);
  });

  it("regression: --danmu no turns danmu off", () => {
    for (const v of ["no", "n", "off", "false", "0", "none", " NO "]) {
      expect(parseDanmuFlag(v), v).toBe(false);
    }
  });

  it("explicit on values stay on", () => {
    for (const v of ["yes", "y", "true", "1", "on"]) expect(parseDanmuFlag(v), v).toBe(true);
  });

  it("legacy provider names / unknown values still mean on", () => {
    for (const v of ["flv", "webcast", "auto"]) expect(parseDanmuFlag(v), v).toBe(true);
  });
});

describe("--stream-upload-spool none (issue #537)", () => {
  it("rejects an explicit none even without --stream-upload 1", () => {
    // The v1 gate only fired when both flags were present, so a lone `none` was silently
    // ignored and the pump still kept a fallback while the operator thought otherwise.
    for (const v of ["none", "NONE", " none "]) expect(rejectsNoSpoolFlag(v), v).toBe(true);
  });

  it("keeps accepting full and absent values", () => {
    for (const v of ["full", "FULL", "", undefined]) expect(rejectsNoSpoolFlag(v), String(v)).toBe(false);
  });
});

// H-973: strict parsers for the two upload switches. Unknown values must be an explicit failure,
// never a throw and never a silent "on" (unlike the lenient --danmu parser above).
const ON_WORDS = ["yes", "y", "true", "1", "on"];
const OFF_WORDS = ["no", "n", "false", "0", "off", "none"];
const UNKNOWN = ["2", "-1", "01", "1x", "flv", "auto", "maybe", "enable", "是", "nope", "disabled", "f"];

const strictParsers: Array<[string, string, (v: string | undefined) => UploadFlagResult]> = [
  ["--rolling-upload", "--stream-upload", parseRollingUploadFlag],
  ["--stream-upload", "--rolling-upload", parseStreamUploadFlag],
];

for (const [flag, otherFlag, parse] of strictParsers) {
  describe(`${flag} strict parser (H-973)`, () => {
    it("absent / blank / whitespace-only keeps the default (off)", () => {
      for (const v of [undefined, "", "   "]) expect(parse(v), String(v)).toEqual({ ok: true, value: false });
    });

    it("on words → true", () => {
      for (const v of ON_WORDS) expect(parse(v), v).toEqual({ ok: true, value: true });
    });

    it("off words → false (including none)", () => {
      for (const v of OFF_WORDS) expect(parse(v), v).toEqual({ ok: true, value: false });
    });

    it("trims and lowercases", () => {
      for (const v of [" ON ", "TRUE", "Yes", "Y", "\t1\n"]) expect(parse(v), v).toEqual({ ok: true, value: true });
      for (const v of [" NO ", "OFF", "None", "N", " 0 "]) expect(parse(v), v).toEqual({ ok: true, value: false });
    });

    it("unknown values return an explicit failure naming this flag and quoting the raw value", () => {
      for (const v of UNKNOWN) {
        let r: UploadFlagResult | undefined;
        expect(() => {
          r = parse(v);
        }, v).not.toThrow();
        expect(r?.ok, v).toBe(false);
        if (r && !r.ok) {
          expect(typeof r.error, v).toBe("string");
          expect(r.error, v).toContain(flag);
          expect(r.error, v).toContain(`"${v}"`);
          // the error must not mention the sibling flag
          expect(r.error.includes(otherFlag), v).toBe(false);
        }
        expect((r as { value?: unknown } | undefined)?.value, v).not.toBe(true);
      }
    });

    it("is pure: repeated calls with the same input give equal, fresh results", () => {
      for (const v of [...ON_WORDS, ...OFF_WORDS, ...UNKNOWN, undefined, ""]) {
        const a = parse(v);
        const b = parse(v);
        expect(b, String(v)).toEqual(a);
        expect(b, String(v)).not.toBe(a);
      }
    });

    it("stays in sync with core parseBoolFlag vocabulary", () => {
      for (const w of [...ON_WORDS, ...OFF_WORDS]) {
        const r = parse(w);
        expect(r.ok, w).toBe(true);
        if (r.ok) expect(r.value, w).toBe(parseBoolFlag(w, false));
      }
    });
  });
}

describe("upload strict parsers vs neighbours (H-973)", () => {
  it("none is off for the upload switches but still rejected for --stream-upload-spool", () => {
    expect(parseRollingUploadFlag("none")).toEqual({ ok: true, value: false });
    expect(parseStreamUploadFlag("none")).toEqual({ ok: true, value: false });
    expect(rejectsNoSpoolFlag("none")).toBe(true);
  });

  it("--danmu stays lenient: unknown / absent still mean on", () => {
    expect(parseDanmuFlag("flv")).toBe(true);
    expect(parseDanmuFlag("auto")).toBe(true);
    expect(parseDanmuFlag(undefined)).toBe(true);
  });

  it("rolling and stream failures use distinct error texts", () => {
    const r = parseRollingUploadFlag("maybe");
    const s = parseStreamUploadFlag("maybe");
    expect(r.ok).toBe(false);
    expect(s.ok).toBe(false);
    if (!r.ok && !s.ok) expect(r.error).not.toBe(s.error);
  });
});

// H-973 QA round 1: edge cases from the brief not pinned above.
describe("upload strict parsers — brief edge cases (H-973)", () => {
  const parsers: Array<[string, (v: string | undefined) => UploadFlagResult]> = [
    ["--rolling-upload", parseRollingUploadFlag],
    ["--stream-upload", parseStreamUploadFlag],
  ];

  it("both parsers are named exports of cli-flags", async () => {
    const mod = (await import("../../packages/cli/src/cli-flags.js")) as Record<string, unknown>;
    expect(typeof mod.parseRollingUploadFlag).toBe("function");
    expect(typeof mod.parseStreamUploadFlag).toBe("function");
    expect(typeof mod.parseDanmuFlag).toBe("function");
  });

  for (const [flag, parse] of parsers) {
    it(`${flag}: tab/newline-only input is blank → off`, () => {
      for (const v of ["\t\n", " \t ", "\n"]) expect(parse(v), JSON.stringify(v)).toEqual({ ok: true, value: false });
    });

    it(`${flag}: failure carries no value key at all`, () => {
      for (const v of ["2", "auto", "是", "f"]) {
        const r = parse(v);
        expect(Object.keys(r).sort(), v).toEqual(["error", "ok"]);
        expect("value" in r, v).toBe(false);
      }
    });

    it(`${flag}: error quotes the raw value untrimmed and with original case`, () => {
      for (const v of [" maybe ", "MAYBE", "\tEnable\n"]) {
        const r = parse(v);
        expect(r.ok, JSON.stringify(v)).toBe(false);
        if (!r.ok) expect(r.error, JSON.stringify(v)).toContain(`"${v}"`);
      }
    });

    it(`${flag}: error lists the valid on/off values`, () => {
      const r = parse("enable");
      expect(r.ok).toBe(false);
      if (!r.ok) for (const w of ["on", "off", "yes", "no", "true", "false", "0", "1"]) expect(r.error, w).toContain(w);
    });

    it(`${flag}: never falls back to on for an unknown value (unlike parseBoolFlag)`, () => {
      for (const v of ["flv", "auto", "enable", "1x"]) {
        expect(parseBoolFlag(v, false), v).toBe(true);
        expect(parse(v).ok, v).toBe(false);
      }
    });
  }
});
