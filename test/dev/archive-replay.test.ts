import { afterEach, beforeEach, describe, expect, it } from "vitest";
import { spawnSync } from "node:child_process";
import { existsSync, mkdtempSync, readFileSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

const fence = String.fromCharCode(96).repeat(3);
const replay = readFileSync("docs/dev-archive-view.md", "utf8").split(fence + "bash\n")[1]?.split(fence)[0];
if (!replay) throw new Error("Missing documented replay commands");
let root: string;

const shims = [
  'git() {',
  '  case "$*" in',
  '    "status --porcelain") [[ $CASE_DIRTY == 0 ]] || printf "dirty\n" ;;',
  '    "rev-parse HEAD") printf "fixture-head\n" ;;',
  '    *) return 99 ;;',
  '  esac',
  '}',
  'mktemp() { printf "%s\n" "$CASE_ROOT"; }',
  'docker() {',
  '  printf "docker %s\n" "$*" >> "$CASE_CALLS"',
  '  case "$1 $2" in',
  '    "container inspect"|"network inspect"|"image inspect") [[ "$*" == "$CASE_OCCUPIED" ]] ;;',
  '    *) [[ $1 == inspect ]] || return 99 ;;',
  '  esac',
  '}',
  'bash() {',
  '  [[ $1 == scripts/e2e-verify.sh ]] || return 99',
  '  [[ "$DREC_EGRESS:$DREC_MIRROR:$SC_KEEP:$DREC_DEV_SUFFIX:$DOCKER_CONTEXT" == "0:0:1:-r714:fixture-local" ]] || return 97',
  '  [[ ${DREC_EGRESS_COOKIES-unset}:${DREC_MIRROR_SRC-unset}:${DREC_MIRROR_ROOMS-unset} == unset:unset:unset ]] || return 98',
  '  printf "script %s\n" "$*" >> "$CASE_CALLS"',
  '  printf "simulated %s\n" "$*"',
  '  [[ "${*:2}" != "$CASE_FAILURE" ]] || return 73',
  '}',
].join("\n");

function run(overrides: NodeJS.ProcessEnv = {}) {
  const result = spawnSync("/bin/bash", ["--noprofile", "--norc", "-c", shims + "\n" + replay], {
    encoding: "utf8",
    timeout: 10_000,
    env: {
      ...process.env, BASH_ENV: "", DOCKER_CONTEXT: "fixture-local",
      CASE_ROOT: root, CASE_CALLS: join(root, "calls.log"),
      CASE_DIRTY: "0", CASE_OCCUPIED: "", CASE_FAILURE: "",
      DREC_EGRESS: "1", DREC_MIRROR: "1", SC_KEEP: "0",
      DREC_EGRESS_COOKIES: "unused-fixture", DREC_MIRROR_SRC: "unused-fixture", DREC_MIRROR_ROOMS: "unused-fixture",
      ...overrides,
    },
  });
  expect(result.error).toBeUndefined();
  const calls = existsSync(join(root, "calls.log")) ? readFileSync(join(root, "calls.log"), "utf8") : "";
  return { ...result, calls };
}

beforeEach(() => { root = mkdtempSync(join(tmpdir(), "dev-replay doc-")); });
afterEach(() => { rmSync(root, { recursive: true, force: true }); });

describe("documented isolated replay", () => {
  it("checks both image tags and runs internal stages in order", () => {
    const result = run();
    expect(result.status, result.stderr).toBe(0);
    expect(result.calls).toContain("docker image inspect drec-dev-base:local-r714\n");
    expect(result.calls).toContain("docker image inspect drec-dev-node:local-r714\n");
    expect(result.calls.split("\n").filter((line) => line.startsWith("script "))).toEqual(
      ["doctor", "up", "smoke", "run s2", "run s3"].map((stage) => "script scripts/e2e-verify.sh " + stage),
    );
    expect(readFileSync(join(root, "source.txt"), "utf8")).toBe("fixture-head\n");
  });

  it("refuses a dirty checkout before contacting Docker", () => {
    const result = run({ CASE_DIRTY: "1" });
    expect(result.status).toBe(1);
    expect(result.calls).toBe("");
  });

  it.each([
    "container inspect drec-dev-r714-node-1",
    "network inspect drec-devnet-r714",
    "image inspect drec-dev-node:local-r714",
  ])("refuses an occupied resource: %s", (occupied) => {
    const result = run({ CASE_OCCUPIED: occupied });
    expect(result.status).toBe(1);
    expect(result.calls).not.toContain("script ");
    expect(result.stderr).toContain("Refusing occupied replay");
  });

  it("stops after a failed S2 while retaining captured output", () => {
    const result = run({ CASE_FAILURE: "run s2" });
    expect(result.status).toBe(73);
    expect(result.calls).not.toContain("script scripts/e2e-verify.sh run s3");
    expect(readFileSync(join(root, "s2.log"), "utf8")).toContain("simulated scripts/e2e-verify.sh run s2");
  });
});
