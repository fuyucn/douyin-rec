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

describe("@drec/zero-upload re-export (零落盘拆包)", () => {
  it("cookie 头解析下沉 core 后,processors 仍是同一份函数(调用点不变)", async () => {
    const core = await import("../../packages/core/src/upload-gate.js");
    const proc = await import("../../packages/processors/src/run-biliup.js");
    // 同一引用 = 没有第二份实现,0 落盘与进程内上传共用单一真理。
    expect(proc.biliupCookieHeader).toBe(core.biliupCookieHeader);
    expect(core.biliupCookieHeader({
      cookie_info: { cookies: [{ name: "SESSDATA", value: "x" }] },
    })).toBe("SESSDATA=x");
  });

  it("processors 仍 re-export 0 落盘符号(旧导入点不破)", async () => {
    const proc = await import("../../packages/processors/src/index.js");
    const zero = await import("../../packages/zero-upload/src/index.js");
    for (const name of ["runLivePump", "preupload", "uploadChunks", "complete", "submitStudio"] as const) {
      expect(typeof (proc as Record<string, unknown>)[name]).toBe("function");
      expect((proc as Record<string, unknown>)[name]).toBe((zero as Record<string, unknown>)[name]);
    }
  });
});
