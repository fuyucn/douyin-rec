# Bounded test execution

Run the complete suite with `pnpm test`. Both this command and `pnpm test:e2e`
use the root Vitest configuration; the full suite already includes the e2e tests.
Do not run both commands just to validate the same change.

## Resource defaults

- Use one fork worker on hosts with one or two available CPUs and two fork
  workers on larger hosts. The default never exceeds two or increases Vitest's
  previous run-mode CPU-derived parallelism. CLI worker overrides remain available.
- Keep file isolation enabled. A fresh worker prevents platform registries, mocks,
  timers and SQLite connections from leaking between files. Do not enable
  `singleFork` or disable isolation to save startup time.
- Give each fork a 512 MiB V8 old-space limit and a 16 MiB semi-space limit
  (V8 young generation uses up to three semi-spaces). This is not an RSS limit:
  Buffers, native libraries and child processes consume additional memory.
  These flags apply to fork workers, not the coordinator or fixture children.
  An out-of-memory exit is a failed run, not a skipped test.
- Keep the setup file's (`test/setup.ts`) initialization order unchanged. Narrower imports can
  change when module mocks take effect, even when they expose the same registry.

Prefer one test invocation at a time during development. The machine-wide limit
is two simultaneous Vitest invocations across all worktrees, not two per agent.
Worker limits apply within an invocation and do not enforce that machine limit.
Before starting a run, check for existing Vitest processes and coordinate with
other agents. Never stop a process based only on its name or memory usage.

## Focused and diagnostic runs

    pnpm test test/dev/vitest-resources.test.ts
    pnpm test --maxWorkers=1 --minWorkers=1
    pnpm test --logHeapUsage
    pnpm typecheck
    pnpm exec tsc --noEmit -p tsconfig.vitest.json

The root typecheck covers package sources, not the root Vitest configuration or
the resource guard file. The dedicated `tsconfig.vitest.json` check covers both
and runs in CI. It does not typecheck every test in the repository.

The resource guards check configuration, CPU-budget boundaries and setup/module
identity. One guard also checks the real fork's argv and V8 heap ceiling. They
do not measure runtime worker counts or peak RSS; those need process sampling.

A focused run helps iteration but does not replace the full-suite gate. The
single-worker command reduces concurrent test work while preserving isolation.
Do not run a full suite in parallel with its focused reruns. Use run mode, not a
background watch session, for one-off verification.

`--logHeapUsage` reports the JavaScript heap at file completion, not peak RSS.
For a useful memory comparison, record the same file selection, test counts,
exit status, elapsed time, sampled peak RSS for the coordinator and workers, and
the simultaneous process-tree RSS including fixture children. Sampling adds
overhead, can miss short peaks and excludes swapped or compressed pages. macOS
Activity Monitor's memory footprint and virtual address size are different measurements;
do not compare them directly with RSS or the configured heap ceiling.

After a run, require its final summary and exit status, then check for surviving
project-owned children. Stop only positively identified unnecessary test work;
do not delete regression tests, recordings, historical tasks or another
project's processes. Keep failure output and fix teardown leaks at their owner.
