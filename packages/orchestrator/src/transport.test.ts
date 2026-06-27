import { describe, it, expect, beforeEach } from "vitest";
import { registerTransport, getTransport, _resetTransports } from "./transport.js";

describe("transport registry", () => {
  beforeEach(() => _resetTransports());
  it("注册后能按 kind 取到，cfg 透传", () => {
    registerTransport("fake", (cfg) => ({
      id: cfg.id, async listInventory() { return { tenantId: cfg.id, recordings: [] }; },
      async isDone() { return true; }, async pull() {},
    }));
    const t = getTransport({ id: "n1", kind: "fake" });
    expect(t.id).toBe("n1");
  });
  it("未注册 kind 抛错", () => {
    expect(() => getTransport({ id: "x", kind: "nope" })).toThrow(/未注册|unknown/i);
  });
});
