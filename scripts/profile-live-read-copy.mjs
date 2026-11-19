#!/usr/bin/env node
/** Profile the current reader against a one-line copy-restored control; never use production data. */
import { build } from "esbuild";
import { execFileSync } from "node:child_process";
import { createHash } from "node:crypto";
import { mkdtempSync, readFileSync, writeFileSync } from "node:fs";
import { arch, cpus, platform, tmpdir } from "node:os";
import { join, resolve } from "node:path";
import { fileURLToPath } from "node:url";

const root = fileURLToPath(new URL("..", import.meta.url));
const mib = Number(process.argv[2] ?? 512);
const rounds = Number(process.argv[3] ?? 5);
if (!Number.isSafeInteger(mib) || mib < 1 || mib > 4096
  || !Number.isSafeInteger(rounds) || rounds < 3 || rounds > 20) {
  throw new Error("Usage: node scripts/profile-live-read-copy.mjs [MiB=512, 1..4096] [rounds=5, 3..20]");
}
const output = mkdtempSync(join(tmpdir(), "drec-read-copy-"));
const reuseBranch = "Buffer.isBuffer(data) ? data";
const sourcePath = join(root, "packages/zero-upload/src/live-pump-stream.ts");
const source = readFileSync(sourcePath, "utf8");
if (source.split(reuseBranch).length !== 2) throw new Error("Reader changed; review the control mutation before profiling");
const inputs = [
  "packages/zero-upload/src/live-pump-stream.ts", "packages/zero-upload/src/ts-cutter.ts",
  "packages/zero-upload/src/ts-fixture.ts", "test/perf/live-read-workload.ts",
];
const sourceHashes = Object.fromEntries(inputs.map((path) => [
  path, createHash("sha256").update(readFileSync(join(root, path))).digest("hex"),
]));
for (const mode of ["copy", "reuse"]) {
  await build({
    absWorkingDir: root, entryPoints: ["test/perf/live-read-workload.ts"],
    outfile: join(output, mode + ".mjs"), bundle: true, platform: "node", format: "esm", target: "node24",
    plugins: mode === "copy" ? [{
      name: "restore-read-copy-control",
      setup(b) {
        b.onLoad({ filter: /live-pump-stream\.ts$/ }, (args) => {
          if (resolve(args.path) !== resolve(sourcePath)) throw new Error("Unexpected reader module");
          return { contents: source.replace(reuseBranch, "Buffer.isBuffer(data) ? Buffer.from(data)"), loader: "ts" };
        });
      },
    }] : [],
  });
}

const runs = [];
for (let round = 0; round < rounds; round++) {
  // Alternate the order to reduce warm-cache and thermal-order bias.
  for (const mode of round % 2 ? ["reuse", "copy"] : ["copy", "reuse"]) {
    const stdout = execFileSync(process.execPath, [
      "--cpu-prof", "--cpu-prof-dir=" + output, "--cpu-prof-name=" + mode + "-" + round + ".cpuprofile",
      join(output, mode + ".mjs"), String(mib),
    ], { encoding: "utf8", cwd: root, timeout: 120_000, maxBuffer: 1024 * 1024 });
    const run = { mode, round, ...JSON.parse(stdout.trim()) };
    const isReuse = mode === "reuse";
    if (run.reusedReads + run.copiedReads === 0
      || (isReuse ? run.copiedReads !== 0 : run.reusedReads !== 0)) throw new Error("Reader identity control failed");
    runs.push(run);
    console.log(JSON.stringify(run));
  }
}
if (new Set(runs.map((r) => r.bytes + ":" + r.sha256)).size !== 1) throw new Error("Control and current bytes differ");
const median = (values) => [...values].sort((a, b) => a - b)[Math.floor(values.length / 2)];
const metrics = Object.fromEntries(["copy", "reuse"].map((mode) => [mode, {
  cpuMs: median(runs.filter((r) => r.mode === mode).map((r) => r.cpuMs)),
  wallMs: median(runs.filter((r) => r.mode === mode).map((r) => r.wallMs)),
}]));
const result = {
  source: execFileSync("git", ["rev-parse", "HEAD"], { cwd: root, encoding: "utf8" }).trim(),
  sourceHashes,
  environment: { node: process.version, platform: platform(), arch: arch(), cpu: cpus()[0]?.model },
  mib, rounds, runs, metrics, cpuReductionPercent: (1 - metrics.reuse.cpuMs / metrics.copy.cpuMs) * 100,
  scope: "Synthetic TS replay, actual reader and cutter, hash-only sink; copy-restored counterfactual, not a historical production replay.",
};
writeFileSync(join(output, "result.json"), JSON.stringify(result, null, 2) + "\n");
console.log(JSON.stringify({ output, metrics, cpuReductionPercent: result.cpuReductionPercent }));
