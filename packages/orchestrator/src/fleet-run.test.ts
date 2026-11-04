import { describe, it, expect, vi } from "vitest";
import { parseNodeCommand, withFleet } from "./fleet-run.js";
import type { FleetLink } from "./fleet-hub.js";

const P = "node /r/dist/douyin-rec.mjs";

function fakeLink(over: Partial<FleetLink> = {}): FleetLink {
  return {
    connected: () => true,
    supports: () => true,
    cached: () => null,
    request: async () => ({ stdout: "fleet\n", exitCode: 0 }),
    ...over,
  };
}

function wrap(link: FleetLink | null, ssh = vi.fn(async () => "ssh\n")) {
  return { run: withFleet(ssh, { nodeId: "n1", nodePrefix: P, link: () => link, timeoutMs: 1000 }), ssh };
}

describe("parseNodeCommand", () => {
  it("splits command and args; unquotes plain single-quoted words", () => {
    expect(parseNodeCommand(`${P} _is-done /r 'abc'`, P)).toEqual({ cmd: "is-done", args: ["/r", "abc"] });
    expect(parseNodeCommand(`${P} _notify-outbox /r --after 3 --limit 200 --ack 1,2`, P)).toEqual({
      cmd: "notify-outbox",
      args: ["/r", "--after", "3", "--limit", "200", "--ack", "1,2"],
    });
  });

  it("rejects other prefixes and anything relying on the remote shell", () => {
    expect(parseNodeCommand("test -d /r", P)).toBeNull();
    expect(parseNodeCommand(`${P} _is-done /r 'a'\\''b'`, P)).toBeNull();
    expect(parseNodeCommand(`${P} _disk /r; rm -rf /`, P)).toBeNull();
  });
});

describe("withFleet", () => {
  it("no link → ssh", async () => {
    const { run, ssh } = wrap(null);
    expect(await run([`${P} _disk /r`])).toBe("ssh\n");
    expect(ssh).toHaveBeenCalledOnce();
  });

  it("fresh heartbeat answers status commands without any request", async () => {
    const request = vi.fn();
    const link = fakeLink({ cached: (_n, cmd) => ({ stdout: `cached-${cmd}\n`, exitCode: 0, at: 0 }), request });
    const { run, ssh } = wrap(link);
    expect(await run([`${P} _disk /r`])).toBe("cached-disk\n");
    expect(request).not.toHaveBeenCalled();
    expect(ssh).not.toHaveBeenCalled();
  });

  it("cached non-zero exit rejects like ssh would", async () => {
    const link = fakeLink({ cached: () => ({ stdout: '{"error":"x"}\n', exitCode: 1, at: 0 }) });
    await expect(wrap(link).run([`${P} _disk /r`])).rejects.toThrow(/fleet rc=1/);
  });

  it("is-done is derived from the cached recording rooms", async () => {
    const link = fakeLink({
      cached: (_n, cmd) => (cmd === "recording-status" ? { stdout: '{"rooms":[{"platform":"douyin","roomSlug":"a"}],"rolling":[]}\n', exitCode: 0, at: 0 } : null),
    });
    const { run } = wrap(link);
    expect(await run([`${P} _is-done /r 'a'`])).toBe("false\n");
    expect(await run([`${P} _is-done /r 'b'`])).toBe("true\n");
  });

  it("stale cache → request over the connection", async () => {
    const request = vi.fn(async () => ({ stdout: "live\n", exitCode: 0 }));
    const { run, ssh } = wrap(fakeLink({ request }));
    expect(await run([`${P} _tasks /r`])).toBe("live\n");
    expect(request).toHaveBeenCalledWith("n1", "tasks", ["/r"], 1000);
    expect(ssh).not.toHaveBeenCalled();
  });

  it("request failure / unknown command / root mismatch → ssh", async () => {
    for (const request of [
      async () => { throw new Error("timeout"); },
      async () => ({ stdout: "", exitCode: 127, error: "unknown command: tasks" }),
      async () => ({ stdout: "", exitCode: 2, error: "dataRoot mismatch" }),
    ]) {
      const { run, ssh } = wrap(fakeLink({ request }));
      expect(await run([`${P} _tasks /r`])).toBe("ssh\n");
      expect(ssh).toHaveBeenCalledOnce();
    }
  });

  it("command failure from the agent rejects (does not silently retry over ssh)", async () => {
    const { run, ssh } = wrap(fakeLink({ request: async () => ({ stdout: '{"error":"bad"}\n', exitCode: 1 }) }));
    await expect(run([`${P} _proc-status /r abc`])).rejects.toThrow(/bad/);
    expect(ssh).not.toHaveBeenCalled();
  });

  it("not connected or command not advertised → ssh", async () => {
    expect(await wrap(fakeLink({ connected: () => false })).run([`${P} _tasks /r`])).toBe("ssh\n");
    expect(await wrap(fakeLink({ supports: () => false })).run([`${P} _tasks /r`])).toBe("ssh\n");
  });
});
