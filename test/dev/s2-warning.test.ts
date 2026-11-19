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
api() {
  API_CODE=200
  case $2 in
    /api/events)
      API_BODY='{"events":[]}'
      if [[ $phase != initial ]]; then
        API_BODY='{"events":[{"kind":"error","message":"节点 node-2 清单已连续 6 轮失联(test)"}]}'
      fi
      if [[ $timing == escalation && $phase == follow_up ]]; then
        API_BODY='{"events":[{"kind":"error","message":"节点 node-2 清单已连续 6 轮失联(test)"},{"kind":"error","message":"douyin:fixture-room:fixture-date 节点 node-2 清单已连续 12 轮失联(test),已转人工"}]}'
      fi
      ;;
    /api/hub/queue)
      local rounds=6
      if [[ $phase == follow_up && $timing != stalled ]]; then rounds=7; fi
      API_BODY='{"blocked":[{"roomSlug":"fixture-room","platform":"douyin","workers":["node-2"],"threshold":12,"rounds":'"$rounds"'}]}'
      if [[ $timing == escalation && $phase == follow_up ]]; then API_BODY='{"blocked":[]}'; fi
      ;;
    *) API_BODY='{"total":0}' ;;
  esac
}
sleep() { :; }
wait_for() {
  local budget=$1; shift
  printf 'WAIT %s %s\n' "$budget" "$1"
  if [[ $1 == hit ]]; then phase=threshold; fi
  if [[ $1 == another_blocked_round ]]; then phase=follow_up; fi
  "$@"
}
case_escalated() { [[ $timing == escalation && $phase == follow_up ]]; }
job_count() { if case_escalated; then echo 1; else echo 0; fi; }
job_state() { if case_escalated; then echo needs_manual; elif [[ $restored == 1 ]]; then echo done; else echo absent; fi; }
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
      expect(result.stdout).toContain(mode === "stop" ? "WAIT 50 another_blocked_round" : "WAIT 70 another_blocked_round");
    }
  });

  it.each(["stop", "pause"])("still rejects an absent %s warning even when the alert arrives", (mode) => {
    const result = spawnSync("bash", ["-c", harness, "s2-warning", mode, "missing"], { encoding: "utf8", timeout: 5000 });
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stdout).toContain("FAIL   [S2] " + mode + "/log:");
    expect(result.stdout).toContain("FAIL=1");
  });

  it("requires progress through another blocked round before restoring the worker", () => {
    const result = spawnSync("bash", ["-c", harness, "s2-warning", "stop", "stalled"], { encoding: "utf8", timeout: 5000 });
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stdout).toMatch(/FAIL[^\n]*no further blocked round observed before manual escalation/);
  });

  it("does not count a manual escalation as a repeated node warning or accept it as recovery", () => {
    const result = spawnSync("bash", ["-c", harness, "s2-warning", "stop", "escalation"], { encoding: "utf8", timeout: 5000 });
    expect(result.status, result.stdout + result.stderr).toBe(1);
    expect(result.stdout).toMatch(/PASS[^\n]*阈值后继续失联,通知不重复[^\n]*\(=1\)/);
    expect(result.stdout).toMatch(/FAIL[^\n]*失联期间该场不建 job/);
    expect(result.stdout).toContain("state='needs_manual'");
  });
});
