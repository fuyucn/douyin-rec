/**
 * 停止方块的语义:enabled ≠ recording。
 *
 * 判定的唯一来源是 `startStopVisual`,列表页与详情页共用它;任何一页自己写
 * `enabled ? 橙色方块 : 绿色三角形` 都会让"正在录"和"只是开着"重新混为一谈。
 */
import { describe, expect, it } from "vitest";
import { startStopVisual, type RoomStatusKind } from "../../packages/web/src/lib/room-status.js";

const ALL_KINDS: RoomStatusKind[] = ["attention", "recording", "processing", "waiting", "paused"];

describe("startStopVisual", () => {
  it("disabled room → start action, quiet outline play in success tone", () => {
    for (const kind of ALL_KINDS) {
      const mark = startStopVisual(false, kind);
      expect(mark.action).toBe("start");
      expect(mark.state).toBe("idle");
      expect(mark.filled).toBe(false);
      expect(mark.tone).toBe("var(--success-fg)");
    }
  });

  it("only a genuinely recording room earns the saturated, filled stop block", () => {
    const mark = startStopVisual(true, "recording");
    expect(mark).toEqual({ action: "stop", state: "live", filled: true, tone: "var(--warning-fg)" });
  });

  it("enabled but not recording stays a stop action in a neutral outline", () => {
    for (const kind of ["attention", "processing", "waiting", "paused"] as RoomStatusKind[]) {
      const mark = startStopVisual(true, kind);
      expect(mark.action).toBe("stop");
      expect(mark.state).toBe("idle");
      expect(mark.filled).toBe(false);
      expect(mark.tone).toBeNull();
    }
  });
});
