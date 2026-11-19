import { spawnSync } from "node:child_process";
import { describe, expect, it } from "vitest";

// Execute the real scenario and assertions without Docker, network access or wall-clock waits.
const harness = String.raw`
source dev/multi-node/scenarios/lib.sh
source dev/multi-node/scenarios/s2.sh
mode=$1
timing=$2
faulted=0
restored=0
phase=initial
seed() { :; }
manifest() { printf 'unchanged-source'; }
alert_count() { if [[ $phase == threshold ]]; then echo 1; else echo 0; fi; }
arch_count() { echo "$restored"; }
lost_logs() {
  if [[ $faulted == 1 && $timing != missing ]] && [[ $timing == early || $phase == threshold ]]; then
    echo 6
  else
    echo 5
  fi
}
fault() { case $1 in stop|pause) faulted=1;; start|unpause) restored=1;; esac; }
mk_task() { echo fixture-task; }
mk_rule() { :; }
api() { API_BODY='{"total":0}'; }
sleep() { :; }
wait_for() {
  local budget=$1; shift
  printf 'WAIT %s %s\n' "$budget" "$1"
  if [[ $1 == hit ]]; then phase=threshold; fi
  "$@"
}
job_count() { echo 0; }
job_state() { if [[ $restored == 1 ]]; then echo done; else echo absent; fi; }
node2_status() { if [[ $restored == 1 ]]; then echo true; else echo false; fi; }
ledger() {
  case $1 in
    *'COUNT(*)'*) echo '[{"n":0}]';;
    'SELECT workerId'*) echo '[{"workerId":"node-1"},{"workerId":"node-2"}]';;
    *) echo '[]';;
  esac
}
say() { printf '%s\n' "$*"; }
up=start
[[ $mode == stop ]] || up=unpause
sc_begin S2 fixture
s2_phase "$mode" "$mode" "$up" fixture-room fixture-anchor 1
sc_summary
`;

describe("S2 inventory warning timing", () => {
  it.each(["stop", "pause"])("keeps early and delayed warnings valid for %s without extending budgets", (mode) => {
    for (const timing of ["early", "delayed"]) {
      const result = spawnSync("bash", ["-c", harness, "s2-warning", mode, timing], { encoding: "utf8", timeout: 5000 });
      expect(result.status, result.stdout + result.stderr).toBe(0);
      expect(result.stdout).toContain("unreachable inventory warning is present at the alert threshold");
      expect(result.stdout).toContain("FAIL=0");
      expect(result.stdout).toContain(mode === "stop" ? "WAIT 150 hit" : "WAIT 720 hit");
      expect(result.stdout.includes("WAIT 120 have_lost")).toBe(mode === "stop");
    }
  });

  it.each(["stop", "pause"])("still rejects an absent %s warning even when the alert arrives", (mode) => {
    const result = spawnSync("bash", ["-c", harness, "s2-warning", mode, "missing"], { encoding: "utf8", timeout: 5000 });
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stdout).toContain("FAIL   [S2] " + mode + "/log:");
    expect(result.stdout).toContain("FAIL=1");
  });
});
