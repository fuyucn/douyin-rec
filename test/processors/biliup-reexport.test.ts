import { describe, it, expect } from "vitest";
import * as app from "../../packages/app/src/upload/biliup.js";
import * as proc from "../../packages/processors/src/run-biliup.js";

describe("biliup re-export surface (plan 038 T05)", () => {
  it("app and processors expose the same helpers", () => {
    for (const name of ["runBiliup", "buildUploadArgs", "buildAppendArgs", "parseBV", "countVideoParts", "appendGroup", "uploadPlain"] as const) {
      expect(typeof (app as Record<string, unknown>)[name]).toBe("function");
      expect((app as Record<string, unknown>)[name]).toBe((proc as Record<string, unknown>)[name]);
    }
  });

  it("app readBiliupCookieHeader still has a default path argument", () => {
    expect(app.readBiliupCookieHeader.length).toBe(0);
    expect(proc.readBiliupCookieHeader.length).toBe(1);
  });
});
