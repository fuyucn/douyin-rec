/**
 * fleet-join.ts — hand a worker its fleet credentials over ssh (plans/042 Task 3).
 *
 * The master generates a fresh token and runs `_fleet-join <dataRoot>` on the node with the config JSON on
 * stdin, so the token never appears in argv on either machine. Only after the node confirms the write is
 * the token's hash stored: a failed delivery (node briefly unreachable) must not revoke the token the node
 * still holds. The node's serve picks the file up within a minute and dials in.
 */
import { spawn } from "node:child_process";
import { newFleetToken, saveFleetToken } from "./fleet-hub.js";

export type FleetJoinResult = "joined" | "unsupported" | "failed";

/** Run `ssh host -- <line>` with `input` on stdin; resolves stdout, rejects with stderr on non-zero exit. */
export type SshWithStdin = (host: string, line: string, input: string, timeoutMs: number) => Promise<string>;

const defaultSshWithStdin: SshWithStdin = (host, line, input, timeoutMs) =>
  new Promise((resolve, reject) => {
    const p = spawn("ssh", ["-o", "ConnectTimeout=10", "-o", "BatchMode=yes", host, "--", line]);
    let out = "";
    let err = "";
    const timer = setTimeout(() => p.kill("SIGKILL"), timeoutMs);
    p.stdout.on("data", (b) => (out += b));
    p.stderr.on("data", (b) => (err += b));
    p.on("error", (e) => { clearTimeout(timer); reject(e); });
    p.on("close", (code) => {
      clearTimeout(timer);
      code === 0 ? resolve(out) : reject(new Error(`ssh rc=${code}: ${err.slice(-500)}`));
    });
    p.stdin.end(input);
  });

export async function joinFleetNode(o: {
  host: string;
  dataRoot: string;
  nodeId: string;
  controllerUrl: string;
  tokenPath: string;
  remoteNode?: string;
  ssh?: SshWithStdin;
}): Promise<{ result: FleetJoinResult; detail?: string }> {
  const nodePrefix = o.remoteNode ?? `node ${o.dataRoot}/dist/douyin-rec.mjs`;
  const token = newFleetToken();
  const payload = JSON.stringify({ controllerUrl: o.controllerUrl, nodeId: o.nodeId, token });
  try {
    const out = await (o.ssh ?? defaultSshWithStdin)(o.host, `${nodePrefix} _fleet-join ${o.dataRoot}`, payload, 20_000);
    const v = JSON.parse(out.trim().split("\n").pop() ?? "{}") as { ok?: boolean; error?: string };
    if (!v.ok) return { result: "failed", detail: v.error ?? "no ok in reply" };
    saveFleetToken(o.tokenPath, o.nodeId, token);
    return { result: "joined" };
  } catch (e) {
    const msg = String((e as Error)?.message ?? e);
    // Old bundle without the command: ssh fallback stays in place, nothing else to do.
    if (/unknown command/i.test(msg)) return { result: "unsupported" };
    return { result: "failed", detail: msg.slice(-300) };
  }
}
