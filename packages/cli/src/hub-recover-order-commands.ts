/**
 * Commands for hub-recover-order (plan 038 T11): an operator-facing `recover-order` and the hidden
 * `_recover-order` RPC the master calls over ssh. Both default to dry-run; only `--apply` writes rows.
 *
 * Single-word command names on purpose: commander splits a two-word name into a command plus a
 * positional argument, which silently breaks option parsing (see `recheck-verify` in cli.ts).
 */
import type { Command } from "commander";
import { applyNodeDataRoot } from "./node-pipeline-commands.js";
import { runRecoverOrder, type RecoverMode, type RecoverRequest, type RecoverResult } from "./hub-recover-order.js";

const MODES: readonly RecoverMode[] = ["prep", "bv", "restart"];

/** Validate an untrusted payload (ssh base64 or CLI flags) into a request; throws on anything malformed. */
export function parseRecoverPayload(raw: unknown): { req: RecoverRequest; apply: boolean } {
  const o = (raw ?? {}) as Record<string, unknown>;
  if (typeof o.orderKey !== "string" || o.orderKey === "") throw new Error("orderKey is required");
  if (!MODES.includes(o.mode as RecoverMode)) throw new Error(`mode must be one of ${MODES.join("|")}`);
  if (o.bv !== undefined && typeof o.bv !== "string") throw new Error("bv must be a string");
  if (o.fromPart !== undefined && !Number.isInteger(o.fromPart)) throw new Error("fromPart must be an integer");
  const req: RecoverRequest = {
    orderKey: o.orderKey,
    mode: o.mode as RecoverMode,
    ...(o.bv !== undefined ? { bv: o.bv as string } : {}),
    ...(o.fromPart !== undefined ? { fromPart: o.fromPart as number } : {}),
  };
  return { req, apply: o.apply === true };
}

async function execute(dataRoot: string, raw: unknown): Promise<RecoverResult> {
  const { req, apply } = parseRecoverPayload(raw);
  await applyNodeDataRoot(dataRoot);
  const { handleEnqueue } = await import("@drec/app");
  return runRecoverOrder(dataRoot, req, apply, {
    // Batch mode goes through the same realpath/allowed-root checks as a remote enqueue.
    enqueue: (r) => handleEnqueue(dataRoot, r, { batch: true, capabilities: ["upload-prep", "biliup"] }),
  });
}

function summarize(r: RecoverResult): string {
  const p = r.plan;
  const head = `[${p.ok ? (r.applied ? "applied" : "dry-run") : "refused"}] ${p.orderKey} mode=${p.mode} gen ${p.fromGeneration}->${p.newGeneration}`;
  const lines = [head, ...(p.refusal ? [`  refusal: ${p.refusal}`] : []), ...p.notes.map((n) => `  note: ${n}`)];
  for (const j of p.jobs) lines.push(`  ${r.applied ? "enqueued" : "would enqueue"}: ${j.jobId} (${j.inputs.length} inputs)`);
  if (p.ok && !r.applied) lines.push("  (dry-run) add --apply to enqueue");
  return lines.join("\n");
}

export function registerRecoverOrderCommands(program: Command): void {
  program
    .command("recover-order <orderKey>")
    .description("Recover an upload order by enqueueing a new generation (dry-run unless --apply; never deletes or uploads on its own)")
    .option("--prep", "re-run prep + biliup after a prep failure")
    .option("--bv <bv>", "append the remaining parts to this verified draft (needs --from-part)")
    .option("--from-part <n>", "1-based first part missing from the draft (>= 2)", (v) => Number(v))
    .option("--restart", "create the draft again; only if the archive lookup proves none exists")
    .option("--data-root <path>", "node data root (default: DOUYIN_REC_ROOT or ./output-data)")
    .option("--apply", "enqueue the new generation (default: print the plan only)")
    .action(async (orderKey: string, o: { prep?: boolean; bv?: string; fromPart?: number; restart?: boolean; dataRoot?: string; apply?: boolean }) => {
      const modes = [o.prep && "prep", o.bv !== undefined && "bv", o.restart && "restart"].filter(Boolean) as RecoverMode[];
      if (modes.length !== 1) {
        console.error("[recover-order] choose exactly one of --prep, --bv, --restart");
        process.exit(2);
      }
      try {
        const { drecRoot } = await import("@drec/app");
        const r = await execute(o.dataRoot ?? drecRoot(), {
          orderKey, mode: modes[0], bv: o.bv, fromPart: o.fromPart, apply: o.apply === true,
        });
        console.log(summarize(r));
        if (!r.plan.ok) process.exitCode = 1;
      } catch (e) {
        console.error(`[recover-order] ${(e as Error).message}`);
        process.exitCode = 1;
      }
    });

  program
    .command("_recover-order <dataRoot> <base64>", { hidden: true })
    .description("(internal) recover-order RPC for the master over ssh; payload is base64 JSON")
    .action(async (dataRoot: string, b64: string) => {
      try {
        const raw = JSON.parse(Buffer.from(b64, "base64").toString("utf8")) as unknown;
        process.stdout.write(JSON.stringify(await execute(dataRoot, raw)) + "\n");
      } catch (e) {
        process.stdout.write(JSON.stringify({ error: String((e as Error)?.message ?? e) }) + "\n");
        process.exitCode = 1;
      }
    });
}
