# Offline archive readback fixture

The internal multi-node environment uses a fake CLI and a dev-only Node preload to model the same archive from both sides. The production readback and finalization code is unchanged.

## Contract

- The CLI records each successful simulated upload or append. The view counts the recorded files for that archive, resetting at its latest upload and adding subsequent appends. It never reads the expected count from the job ledger.
- The preload answers only the exact GET view endpoint with a single archive-id parameter. All other requests keep the original fetch implementation.
- Activation requires the explicit controller flag, dev mode, a marked dev data root, known fake credentials on disk, and the known fake credentials on each request. These checks fail closed. The fixture is not copied into the production Dockerfile.
- The egress and mirror compose overlays explicitly disable the preload. This fixture must not replace any real-platform acceptance evidence.
- Missing, malformed, unknown or out-of-order archive operations do not produce a successful view. A valid observed count may still be lower or higher than the ledger expectation; the real finalization gate must then keep both source and stage video and move the job to manual review.

## Checks

Run the archive-view regression test for real fake-CLI output, upload reset, append, invalid archives, activation guards, endpoint isolation, actual Node preload activation, and the real finalization gate with matching, short, excess and unknown observations. The negative gate cases verify real fixture files remain present, no done commit occurs and one error notification is emitted.

Run the internal S2 and S3 scenarios through the guarded e2e script. S2 checks disconnected-node safety and eventual recovery; S3 requires matching readback before cleanup, a completed verification step, a matching-readback log and the existing terminal-state, file and API assertions. The default production readback window is unchanged, including its initial two-minute wait. A faster test does not justify bypassing that gate.

The old assumption that a successful CLI exit alone allows cleanup was superseded by #327. Offline tests need an observed fake archive, not a disabled readback dependency or a fabricated expected count. No real submission, production source cleanup, retention change or deployment is part of this repair.
