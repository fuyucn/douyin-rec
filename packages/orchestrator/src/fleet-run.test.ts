import { describe, it, expect, vi } from "vitest";
import { cachedRecordingRooms, runOverFleet } from "./fleet-run.js";
import type { FleetLink } from "./fleet-hub.js";

function fakeLink(over: Partial<FleetLink> = {}): FleetLink {
  return {
    supports: () => true,
    cached: () => null,
    recordingRooms: () => null,
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

describe("cachedRecordingRooms", () => {
  it("reads the link's fresh room set; null without a link", () => {
    const rooms = new Set(["a"]);
    expect(cachedRecordingRooms(fakeLink({ recordingRooms: () => rooms }), "n1")).toBe(rooms);
    expect(cachedRecordingRooms(null, "n1")).toBeNull();
  });
});
