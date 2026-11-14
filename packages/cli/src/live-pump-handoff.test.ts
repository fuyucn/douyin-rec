// T-221 (sol P1-4): the CLI must never translate a failed / zero-row enqueue into "delivered".
import { describe, it, expect } from "vitest";
import { livePumpHandoffReceipt } from "./live-pump-handoff.js";

describe("livePumpHandoffReceipt", () => {
  it("only a clean non-zero enqueue is owned", () => {
    expect(livePumpHandoffReceipt({ queued: 2, already: 0, failed: 0 })).toEqual({ status: "owned" });
    expect(livePumpHandoffReceipt({ queued: 0, already: 3, failed: 0 })).toEqual({ status: "owned" });
  });

  it("a cookie / SQLite error is retryable, not success", () => {
    expect(livePumpHandoffReceipt({ queued: 0, already: 0, failed: 0, error: "cannot read cookies" }))
      .toEqual({ status: "retryable", detail: "cannot read cookies" });
  });

  it("a thrown helper and a missing result are retryable", () => {
    expect(livePumpHandoffReceipt(undefined, new Error("sqlite is locked")))
      .toEqual({ status: "retryable", detail: "sqlite is locked" });
    expect(livePumpHandoffReceipt(undefined).status).toBe("retryable");
  });

  it("a zero-row result is never treated as ownership", () => {
    expect(livePumpHandoffReceipt({ queued: 0, already: 0, failed: 0 }))
      .toEqual({ status: "retryable", detail: "待补分 P 未被队列接管(零行)" });
  });

  it("a total order-hole miss is retryable; a partial handoff is human-blocked", () => {
    expect(livePumpHandoffReceipt({ queued: 0, already: 0, failed: 2 }).status).toBe("retryable");
    expect(livePumpHandoffReceipt({ queued: 1, already: 0, failed: 1 }).status).toBe("blocked");
    expect(livePumpHandoffReceipt({ queued: 0, already: 2, failed: 1 }).status).toBe("blocked");
  });
});
