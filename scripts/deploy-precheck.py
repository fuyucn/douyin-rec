#!/usr/bin/env python3
"""Per-node deploy guard decision (plan 038 T16). Called by deploy-precheck.sh once per node.

Contract (shell -> python), all arguments are plain strings:
  --label TEXT          node label for messages
  --tasks FILE          body of GET /api/tasks ("" or missing file = unreachable)
  --proc-status CODE    HTTP status of GET /api/proc/active (0 = unreachable / timeout)
  --proc FILE           body of GET /api/proc/active
  --uploading N|unknown fresh `phase=uploading` node-result files on the node ("unknown" = could not read)

Exit codes: 0 safe to deploy, 1 block (work in flight, wait), 2 unknown (fail-closed, wait).

Three states for the upload queue (single wording, shared with AGENTS.md):
  1. /api/proc/active reports running.biliup > 0           -> BLOCK
  2. endpoint answers 404 (old bundle without proc-queue)  -> blocking-path uploads are not in the queue, so
                                                              look for a fresh `phase=uploading` result file:
                                                              fresh -> BLOCK, none -> OK (noted), unreadable -> UNKNOWN
  3. unreachable / timeout / 503 / garbage                 -> UNKNOWN (fail-closed, wait)
"""
import argparse
import json
import sys

OK, BLOCK, UNKNOWN = 0, 1, 2

# Every queue kind that can still be writing to Bilibili. `biliup` alone misses the part
# chain (upload-part / upload-prep / reconcile-part), which is exactly the irreversible step.
UPLOAD_KINDS = ("biliup", "upload-part", "upload-prep", "reconcile-part", "remux")


def load(path):
    if not path:
        return None
    try:
        with open(path, encoding="utf-8") as f:
            return json.load(f)
    except Exception:
        return None


def decide(label, tasks, proc_status, proc, uploading):
    """Return (exit_code, [message lines])."""
    out = []
    if not isinstance(tasks, list):
        return UNKNOWN, [f"  WARN {label}: cannot read the task list (API unreachable or unparsable)"]
    rec = [t for t in tasks if isinstance(t, dict) and t.get("recording")]
    run = sum(1 for t in tasks if isinstance(t, dict) and t.get("running"))
    if rec:
        out.append(f"  BLOCK {label}: {len(rec)} task(s) recording (of {len(tasks)}, running={run}):")
        for t in rec:
            out.append(f"         #{t.get('id')} {t.get('anchorName') or t.get('room')}")
        return BLOCK, out
    out.append(f"  OK {label}: nothing recording (of {len(tasks)}, running={run} waiting for a stream)")

    fresh_upload = None
    if uploading not in (None, "unknown"):
        try:
            fresh_upload = int(uploading)
        except ValueError:
            fresh_upload = None

    if proc_status == 200:
        running = proc.get("running") if isinstance(proc, dict) else None
        if not isinstance(running, dict):
            return UNKNOWN, out + [f"  WARN {label}: /api/proc/active answered 200 but the body is not understood"]
        n = 0
        for kind in UPLOAD_KINDS:
            count = running.get(kind, 0)
            if not isinstance(count, int) or isinstance(count, bool) or count < 0:
                return UNKNOWN, out + [f"  WARN {label}: running.{kind} is not a count"]
            n += count
        if n > 0:
            return BLOCK, out + [f"  BLOCK {label}: {n} upload job(s) (biliup/part chain) running in the queue; wait for them"]
        if fresh_upload is None:
            return UNKNOWN, out + [f"  WARN {label}: upload result files are unreadable"]
        if fresh_upload > 0:
            return BLOCK, out + [f"  BLOCK {label}: {fresh_upload} fresh phase=uploading result file(s); wait for them"]
        return OK, out + [f"  OK {label}: no upload running (queue + result files)"]

    if proc_status == 404:
        if uploading == "unknown" or uploading is None:
            return UNKNOWN, out + [f"  WARN {label}: old bundle without proc-queue and the upload result files are unreadable"]
        if fresh_upload is None:
            return UNKNOWN, out + [f"  WARN {label}: unreadable fresh-upload count {uploading!r}"]
        if fresh_upload > 0:
            return BLOCK, out + [f"  BLOCK {label}: old bundle; {fresh_upload} fresh phase=uploading result file(s) (blocking-path upload in flight)"]
        return OK, out + [f"  OK {label}: old bundle (no proc-queue); no fresh upload found, cannot confirm the queue, proceeding"]

    why = "unreachable or timed out" if proc_status == 0 else f"HTTP {proc_status}"
    return UNKNOWN, out + [f"  WARN {label}: /api/proc/active {why}; upload state unknown, waiting"]


def main(argv):
    ap = argparse.ArgumentParser()
    ap.add_argument("--label", required=True)
    ap.add_argument("--tasks", default="")
    ap.add_argument("--proc-status", type=int, default=0)
    ap.add_argument("--proc", default="")
    ap.add_argument("--uploading", default="unknown")
    a = ap.parse_args(argv)
    code, lines = decide(a.label, load(a.tasks), a.proc_status, load(a.proc), a.uploading)
    print("\n".join(lines))
    return code


if __name__ == "__main__":
    sys.exit(main(sys.argv[1:]))
