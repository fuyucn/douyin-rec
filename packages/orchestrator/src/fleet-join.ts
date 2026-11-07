/**
 * fleet-join.ts — hand a worker its fleet credentials over ssh (plans/042 Task 3).
 *
 * The master generates a fresh token and runs `_fleet-join <dataRoot>` on the node with the config JSON on
 * stdin, so the token never appears in argv on either machine. Only after the node confirms the write is
 * the token's hash stored: a failed delivery (node briefly unreachable) must not revoke the token the node
 * still holds. The node's serve picks the file up within a minute and dials in.
 */
import { newFleetToken, saveFleetToken } from "./fleet-hub.js";
import { defaultRun, isUnknownCommandError } from "./transport-ssh.js";

export type FleetJoinResult = "joined" | "unsupported" | "failed";

/** Run `ssh host -- <line>` with `input` on stdin; resolves stdout, rejects on non-zero exit / timeout. */
export type SshWithStdin = (host: string, line: string, input: string, timeoutMs: number) => Promise<string>;

const sshWithStdin: SshWithStdin = (host, line, input, timeoutMs) => defaultRun(host, timeoutMs, input)([line]);

export async function joinFleetNode(o: {
  host: string;
  dataRoot: string;
  nodeId: string;
  controllerUrl: string;
  tokenPath: string;
  ssh?: SshWithStdin;
}): Promise<{ result: FleetJoinResult; detail?: string }> {
  const token = newFleetToken();
  const payload = JSON.stringify({ controllerUrl: o.controllerUrl, nodeId: o.nodeId, token });
  try {
    const line = `node ${o.dataRoot}/dist/douyin-rec.mjs _fleet-join ${o.dataRoot}`;
    const out = await (o.ssh ?? sshWithStdin)(o.host, line, payload, 20_000);
    const v = JSON.parse(out.trim().split("\n").pop() ?? "{}") as { ok?: boolean; error?: string };
    if (!v.ok) return { result: "failed", detail: v.error ?? "no ok in reply" };
    saveFleetToken(o.tokenPath, o.nodeId, token);
    return { result: "joined" };
  } catch (e) {
    // Old bundle without the command: ssh fallback stays in place, nothing else to do.
    if (isUnknownCommandError(e)) return { result: "unsupported" };
    return { result: "failed", detail: String((e as Error)?.message ?? e).slice(-300) };
  }
}
