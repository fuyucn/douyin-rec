import { describe, it, expect, vi } from "vitest";
import { cachedRoomDone, runOverFleet } from "./fleet-run.js";
import type { FleetLink } from "./fleet-hub.js";

function fakeLink(over: Partial<FleetLink> = {}): FleetLink {
  return {
    supports: () => true,
    cached: () => null,
    recordingRooms: () => null,
    finalizingRooms: () => null,
    request: async () => ({ stdout: "fleet\n", exitCode: 0 }),
    ...over,
  };
}

const call = (link: FleetLink | null, cmd: string, args: string[] = [], ssh = vi.fn(async () => "ssh\n")) => ({
  out: runOverFleet(link, { nodeId: "n1", dataRoot: "/r", cmd, args, timeoutMs: 1000 }, ssh),
  ssh,
});

describe("runOverFleet", () => {
  it("no link → ssh", async () => {
    const { out, ssh } = call(null, "disk");
    expect(await out).toBe("ssh\n");
    expect(ssh).toHaveBeenCalledOnce();
  });

  it("fresh heartbeat answers status commands without any request", async () => {
    const request = vi.fn();
    const link = fakeLink({ cached: (_n, cmd) => ({ stdout: `cached-${cmd}\n`, exitCode: 0, at: 0 }), request });
    const { out, ssh } = call(link, "disk");
    expect(await out).toBe("cached-disk\n");
    expect(request).not.toHaveBeenCalled();
    expect(ssh).not.toHaveBeenCalled();
  });

  it("cached non-zero exit rejects like ssh would", async () => {
    const link = fakeLink({ cached: () => ({ stdout: '{"error":"x"}\n', exitCode: 1, at: 0 }) });
    await expect(call(link, "disk").out).rejects.toThrow(/fleet rc=1/);
  });

  it("stale cache → request over the connection, data root first", async () => {
    const request = vi.fn(async () => ({ stdout: "live\n", exitCode: 0 }));
    const { out, ssh } = call(fakeLink({ request }), "proc-status", ["abc"]);
    expect(await out).toBe("live\n");
    expect(request).toHaveBeenCalledWith("n1", "proc-status", ["/r", "abc"], 1000);
    expect(ssh).not.toHaveBeenCalled();
  });

  it("request failure or a refusal → ssh", async () => {
    for (const request of [
      async () => { throw new Error("timeout"); },
      async () => ({ stdout: "", exitCode: 1, refused: "unknown-command" as const }),
      async () => ({ stdout: "", exitCode: 1, refused: "data-root-mismatch" as const }),
    ]) {
      const { out, ssh } = call(fakeLink({ request }), "tasks");
      expect(await out).toBe("ssh\n");
      expect(ssh).toHaveBeenCalledOnce();
    }
  });

  it("command failure from the agent rejects (does not silently retry over ssh)", async () => {
    const { out, ssh } = call(fakeLink({ request: async () => ({ stdout: '{"error":"bad"}\n', exitCode: 1 }) }), "proc-status", ["abc"]);
    await expect(out).rejects.toThrow(/bad/);
    expect(ssh).not.toHaveBeenCalled();
  });

  it("command not routable (not connected / not advertised) → ssh", async () => {
    expect(await call(fakeLink({ supports: () => false }), "tasks").out).toBe("ssh\n");
  });
});

describe("cachedRoomDone", () => {
  const link = (rooms: string[] | null, finalizing: string[] | null) => fakeLink({
    recordingRooms: () => (rooms ? new Set(rooms) : null),
    finalizingRooms: () => (finalizing ? new Set(finalizing) : null),
  });

  it("room in neither list → done; recording → not done; finalizing → not done (#456)", () => {
    expect(cachedRoomDone(link(["a"], ["b"]), "n1", "c")).toBe(true);
    expect(cachedRoomDone(link(["a"], ["b"]), "n1", "a")).toBe(false);
    expect(cachedRoomDone(link(["a"], ["b"]), "n1", "b")).toBe(false);
  });

  it("heartbeat without the finalizing list (older node) or without rooms → no verdict, the caller asks the node", () => {
    expect(cachedRoomDone(link(["a"], null), "n1", "c")).toBeNull();
    expect(cachedRoomDone(link(null, null), "n1", "c")).toBeNull();
    expect(cachedRoomDone(link(null, []), "n1", "c")).toBeNull();
    expect(cachedRoomDone(null, "n1", "c")).toBeNull();
  });
});
