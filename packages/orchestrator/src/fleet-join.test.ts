import { describe, it, expect, afterEach } from "vitest";
import { mkdtempSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { joinFleetNode } from "./fleet-join.js";
import { verifyFleetToken } from "./fleet-hub.js";

const dirs: string[] = [];
afterEach(() => { for (const d of dirs.splice(0)) rmSync(d, { recursive: true, force: true }); });
const tokenPath = () => { const d = mkdtempSync(join(tmpdir(), "drec-join-")); dirs.push(d); return join(d, "fleet-nodes.json"); };

describe("joinFleetNode", () => {
  it("sends the config on stdin (not argv) and the issued token verifies", async () => {
    const p = tokenPath();
    let seen: { line: string; input: string } | null = null;
    const r = await joinFleetNode({
      host: "h", dataRoot: "/r", nodeId: "n1", controllerUrl: "http://m:7860", tokenPath: p,
      ssh: async (_h, line, input) => { seen = { line, input }; return '{"ok":true,"nodeId":"n1"}\n'; },
    });
    expect(r).toEqual({ result: "joined" });
    expect(seen!.line).toBe("node /r/dist/douyin-rec.mjs _fleet-join /r");
    const sent = JSON.parse(seen!.input) as { token: string; nodeId: string; controllerUrl: string };
    expect(seen!.line).not.toContain(sent.token);
    expect(sent).toMatchObject({ nodeId: "n1", controllerUrl: "http://m:7860" });
    expect(verifyFleetToken(p, "n1", sent.token)).toBe(true);
  });

  it("failed delivery keeps the node's current token valid (no rotation before the node has the new one)", async () => {
    const p = tokenPath();
    const base = { host: "h", dataRoot: "/r", nodeId: "n1", controllerUrl: "http://m", tokenPath: p };
    let first = "";
    await joinFleetNode({ ...base, ssh: async (_h, _l, input) => { first = (JSON.parse(input) as { token: string }).token; return '{"ok":true}\n'; } });
    expect(verifyFleetToken(p, "n1", first)).toBe(true);
    expect((await joinFleetNode({ ...base, ssh: async () => { throw new Error("ssh rc=255"); } })).result).toBe("failed");
    expect((await joinFleetNode({ ...base, ssh: async () => '{"ok":false,"error":"disk full"}\n' })).result).toBe("failed");
    expect(verifyFleetToken(p, "n1", first)).toBe(true);
  });

  it("old bundle (unknown command) → unsupported; other errors → failed", async () => {
    const base = { host: "h", dataRoot: "/r", nodeId: "n1", controllerUrl: "http://m", tokenPath: tokenPath() };
    expect((await joinFleetNode({ ...base, ssh: async () => { throw new Error("error: unknown command '_fleet-join'"); } })).result).toBe("unsupported");
    expect((await joinFleetNode({ ...base, ssh: async () => { throw new Error("ssh rc=255"); } })).result).toBe("failed");
    expect((await joinFleetNode({ ...base, ssh: async () => '{"ok":false,"error":"x"}\n' }))).toEqual({ result: "failed", detail: "x" });
  });
});
