// Child entry (bundled by the drain test in live-pump.test.ts and run as a real process).
//
// It exists to prove one thing that cannot be observed from inside vitest: Node's default
// action for an unhandled SIGUSR2 is to kill the process. Vitest installs its own handlers
// and holds handles open, so the default never fires there. As a child — which is exactly how
// `record --stream-upload` runs under TaskManager — it does.
//
// That default is the P1 regression: the zero-disk path registered only SIGINT/SIGTERM, so a
// window-end signal killed the process (measured exit 159) and cut the in-flight part. In
// `spoolMode:"none"` there is no local copy of that part, so the video was lost for good, while
// the task log claimed the broadcast ended naturally.
//
// Deliberately independent of ffmpeg and UPOS: the claim under test is about the signal.
// Production wiring, copied shape-for-shape from `record --stream-upload` in cli.ts:
// a controller per stop-kind, SIGINT/SIGTERM abort the run, SIGUSR2 drains it.
const abort = new AbortController();
const drain = new AbortController();
process.on("SIGINT", () => abort.abort());
process.on("SIGTERM", () => abort.abort());
process.on("SIGUSR2", () => drain.abort()); // MUTATION TARGET: delete this line to see the bug

// A stand-in for the recording loop: it keeps working until a stop signal lands, and reports
// which one it saw. The pump reads these between parts (see runLivePump's drainSignal).
let stoppedBy = "none";
while (!abort.signal.aborted) {
  await new Promise((r) => setTimeout(r, 20));
  if (drain.signal.aborted) { stoppedBy = "drain"; break; }
}
process.stdout.write(JSON.stringify({ stoppedBy }));

export {};
