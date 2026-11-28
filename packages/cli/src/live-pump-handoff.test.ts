// T-221 (sol P1-4): the CLI must never translate a failed / zero-row enqueue into "delivered".
import { describe, it, expect } from "vitest";
import { livePumpHandoffReceipt } from "./live-pump-handoff.js";

describe("livePumpHandoffReceipt", () => {
  it.each([
    { queued: 0, already: 0, failed: 0 },
    { queued: 0, already: 3, failed: 0 },
    { queued: 2, already: 3, failed: 0 },
    { queued: 0, already: 3, failed: 1, needsManual: 1, error: "stale queue error" },
  ])("preserves an explicit protected hold ahead of error and ownership counts: %j", (counts) => {
    const blocked = "Protected UPOS delivery remains with its original owner";
    expect(livePumpHandoffReceipt({ ...counts, blocked }))
      .toEqual({ status: "blocked", detail: blocked });
    expect(livePumpHandoffReceipt({ ...counts, blocked }, new Error("later adapter error")))
      .toEqual({ status: "blocked", detail: blocked });
  });

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

  it("T-221 (sol P1-4): an all-needs-manual backlog is blocked, never a zero-take retry", () => {
    // A truncated / missing spool cannot settle by retrying. If this were classified retryable the
    // pump would exit 75 immediately instead of entering its recording wait, and TaskManager would
    // restart it forever without ever recording.
    expect(livePumpHandoffReceipt({ queued: 0, already: 0, failed: 3, needsManual: 3 }).status).toBe("blocked");
    // Even when some rows were taken, a human-blocked row keeps the receipt blocked.
    expect(livePumpHandoffReceipt({ queued: 1, already: 0, failed: 1, needsManual: 1 }).status).toBe("blocked");
    // Pure deferred rows (no human reason) stay retryable when nothing was taken.
    expect(livePumpHandoffReceipt({ queued: 0, already: 0, failed: 2, deferred: 2 }).status).toBe("retryable");
  });
});
