import { describe, it, expect, vi } from "vitest";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { startFleetController } from "./fleet-controller.js";

describe("startFleetController join loop", () => {
  it("joins only unconnected ssh workers, at most once per retry window, never overlapping rounds", async () => {
    let t = 0;
    let release!: () => void;
    const join_ = vi.fn((_o: { nodeId: string; host: string; dataRoot: string }) => new Promise<{ result: "joined" }>((r) => { release = () => r({ result: "joined" }); }));
    const c = startFleetController({
      controllerUrl: "http://m", tokenPath: join(tmpdir(), "drec-no-such", "fleet-nodes.json"),
      loadWorkers: () => [
        { id: "local", kind: "local" },
        { id: "a", kind: "ssh", host: "h", dataRoot: "/r" },
        { id: "nohost", kind: "ssh", dataRoot: "/r" },
      ],
      log: () => {}, warn: () => {},
      joinEveryMs: 20, joinRetryMs: 1000, join: join_, now: () => t,
    });
    try {
      await new Promise((r) => setTimeout(r, 100)); // several ticks while the first join hangs
      expect(join_).toHaveBeenCalledOnce();
      expect(join_.mock.calls[0][0]).toMatchObject({ nodeId: "a", host: "h", dataRoot: "/r" });
      release();
      await new Promise((r) => setTimeout(r, 60));
      expect(join_).toHaveBeenCalledOnce(); // retry window not over
      t = 2000;
      await new Promise((r) => setTimeout(r, 60));
      expect(join_).toHaveBeenCalledTimes(2);
    } finally {
      c.stop();
    }
  });
});
