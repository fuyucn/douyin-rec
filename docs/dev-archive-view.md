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

Run the internal S2 and S3 scenarios through the guarded e2e script. S2 checks disconnected-node safety and eventual recovery; S3 requires matching readback before cleanup, a completed verification step, a matching-readback log and the existing terminal-state, file and API assertions. Current run logs live outside stage so they survive an empty-stage cleanup; S3 checks that external log rather than requiring a legacy stage log. The default production readback window is unchanged, including its initial two-minute wait. A faster test does not justify bypassing that gate.

S2 checks both stopped- and paused-worker inventory warnings within their existing alert-threshold deadlines. Either fault can hold an in-flight settle pass before inventory, so a separate 120-second warning deadline is not valid. The stopped-worker warm-up and both alert budgets are unchanged. Capture the warning baseline before fault injection so an early warning cannot be mistaken for pre-existing output. The scenario regression runs the real shell phase with simulated observations to cover early, delayed and absent warnings for both fault modes; it does not replace Docker acceptance.

The old assumption that a successful CLI exit alone allows cleanup was superseded by #327. Offline tests need an observed fake archive, not a disabled readback dependency or a fabricated expected count. No real submission, production source cleanup, retention change or deployment is part of this repair.

## Isolated replay

After publication and independent review, check out the exact reviewed revision in a dedicated, clean worktree. Run the following from that checkout's root, with `DOCKER_CONTEXT` explicitly set to the approved local Docker context. Do not copy an uncommitted alternate adapter from another PR or reuse another task's cluster.

This example reserves an unused `-r714` suffix and creates a fresh data root. It refuses existing containers or a network with that suffix instead of stopping, replacing or cleaning them. If the suffix is occupied, coordinate another valid, unused suffix before running it. Both real-interaction modes are explicitly disabled. No cleanup command is included: `SC_KEEP=1` retains scenario evidence, and a failed command stops the replay with its logs intact.

```bash
(
  set -euo pipefail
  : "${DOCKER_CONTEXT:?Set DOCKER_CONTEXT to the approved local Docker context}"
  test -z "$(git status --porcelain)"

  replay_root="$(mktemp -d "${TMPDIR:-/tmp}/drec714-replay.XXXXXX")"
  export DREC_DEV_SUFFIX=-r714
  export DREC_DEV_ROOT="$replay_root/data-dev/e2e${DREC_DEV_SUFFIX}"
  export DREC_EGRESS=0 DREC_MIRROR=0 SC_KEEP=1
  unset DREC_EGRESS_COOKIES DREC_MIRROR_SRC DREC_MIRROR_ROOMS
  printf 'Evidence directory: %s\n' "$replay_root"

  for replay_container in "drec-dev${DREC_DEV_SUFFIX}" \
    "drec-dev${DREC_DEV_SUFFIX}-node-1" "drec-dev${DREC_DEV_SUFFIX}-node-2"; do
    if docker container inspect "$replay_container" >/dev/null 2>&1; then
      printf 'Refusing occupied replay container: %s\n' "$replay_container" >&2
      exit 1
    fi
  done
  if docker network inspect "drec-devnet${DREC_DEV_SUFFIX}" >/dev/null 2>&1; then
    printf 'Refusing occupied replay network\n' >&2
    exit 1
  fi

  git rev-parse HEAD | tee "$replay_root/source.txt"
  bash scripts/e2e-verify.sh doctor 2>&1 | tee "$replay_root/doctor.log"
  bash scripts/e2e-verify.sh up 2>&1 | tee "$replay_root/up.log"
  docker inspect "drec-dev${DREC_DEV_SUFFIX}" \
    "drec-dev${DREC_DEV_SUFFIX}-node-1" "drec-dev${DREC_DEV_SUFFIX}-node-2" \
    --format '{{.Name}} {{.Image}}' | tee "$replay_root/images.txt"
  bash scripts/e2e-verify.sh smoke 2>&1 | tee "$replay_root/smoke.log"
  bash scripts/e2e-verify.sh run s2 2>&1 | tee "$replay_root/s2.log"
  bash scripts/e2e-verify.sh run s3 2>&1 | tee "$replay_root/s3.log"
)
```

S2 must complete both stop and pause branches; S3 must complete both retention branches. Keep the exit statuses, scenario totals, ledger/API/file assertions and matching-readback logs with the recorded source revision and image IDs. A syntax check of these commands is not an executed replay.

This fixture's acceptance is not acceptance of a dependent PR. After integrating the reviewed shared commit, each dependent PR must record its own exact head and rerun its relevant isolated scenarios, including S1 where required. Previously reported results from a different dirty fixture cannot substitute for those checks. These commands do not validate real-platform behavior or authorize production operations.
