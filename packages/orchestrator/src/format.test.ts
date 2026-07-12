import { describe, it, expect } from "vitest";
import { humanBytes, humanDur } from "./format.js";

describe("humanBytes", () => {
  it("formats bytes across units", () => {
    expect(humanBytes(0)).toBe("0B");
    expect(humanBytes(512)).toBe("512B");
    expect(humanBytes(1536)).toBe("1.5KB");
    expect(humanBytes(90 * 1024 * 1024)).toBe("90MB");
    expect(humanBytes(2 * 1024 * 1024 * 1024)).toBe("2GB");
  });
});

describe("humanDur", () => {
  it("formats seconds", () => {
    expect(humanDur(45)).toBe("45s");
    expect(humanDur(600)).toBe("10m");
    expect(humanDur(5879)).toBe("1h38m");
  });
});
