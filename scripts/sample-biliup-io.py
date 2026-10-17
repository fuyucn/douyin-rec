#!/usr/bin/env python3
"""Passive biliup progress sampler (plan 038 T14). Read-only: never starts, signals or touches a process.

Watches for `biliup ... upload|append` processes and appends one JSON line per process per tick to
<out>/samples.jsonl: kernel I/O counters from /proc/<pid>/io, TCP bytes acked from `ss` (the true network
progress; sendto() is not counted in wchar), and thread count. No cookies, titles or file names are recorded.

  python3 scripts/sample-biliup-io.py --out /tmp/biliup-sample [--interval 5] [--max-hours 24] [--match-all]
Stop: create <out>/STOP, or kill the sampler. --match-all samples any process named biliup (format check only).
"""
import argparse, json, os, re, subprocess, sys, time

def read(path):
    try:
        with open(path, "rb") as f:
            return f.read()
    except OSError:
        return None

def biliup_pids(match_all):
    out = []
    for name in os.listdir("/proc"):
        if not name.isdigit():
            continue
        if (read(f"/proc/{name}/comm") or b"").strip() != b"biliup":
            continue
        argv = (read(f"/proc/{name}/cmdline") or b"").split(b"\0")
        verbs = [a.decode("utf-8", "replace") for a in argv if a in (b"upload", b"append")]
        if verbs or match_all:
            files = [a for a in argv[1:] if a and not a.startswith(b"-")]
            out.append((int(name), verbs[0] if verbs else "other", len(files)))
    return out

def io_counters(pid):
    raw = read(f"/proc/{pid}/io")
    if raw is None:
        return None
    return {k: int(v) for k, v in (l.split(": ") for l in raw.decode().splitlines())}

def tcp_acked(pid):
    """Sum bytes_acked / bytes_sent over this pid's TCP sockets (None if ss is unavailable)."""
    try:
        txt = subprocess.run(["ss", "-tinpH"], capture_output=True, text=True, timeout=5).stdout
    except Exception:
        return None
    acked = sent = 0
    lines = txt.splitlines()
    for i, line in enumerate(lines):
        if f"pid={pid}," in line and i + 1 < len(lines):
            m1 = re.search(r"bytes_acked:(\d+)", lines[i + 1]); m2 = re.search(r"bytes_sent:(\d+)", lines[i + 1])
            acked += int(m1.group(1)) if m1 else 0
            sent += int(m2.group(1)) if m2 else 0
    return {"acked": acked, "sent": sent}

def main():
    ap = argparse.ArgumentParser()
    ap.add_argument("--out", required=True)
    ap.add_argument("--interval", type=float, default=5)
    ap.add_argument("--max-hours", type=float, default=24)
    ap.add_argument("--match-all", action="store_true")
    a = ap.parse_args()
    os.makedirs(a.out, exist_ok=True)
    path = os.path.join(a.out, "samples.jsonl")
    end = time.time() + a.max_hours * 3600
    while time.time() < end and not os.path.exists(os.path.join(a.out, "STOP")):
        now = time.time()
        for pid, verb, nfiles in biliup_pids(a.match_all):
            io = io_counters(pid)
            if io is None:
                continue
            rec = {"t": round(now, 1), "pid": pid, "verb": verb, "nfiles": nfiles,
                   "rchar": io.get("rchar"), "wchar": io.get("wchar"), "syscr": io.get("syscr"), "syscw": io.get("syscw"),
                   "read_bytes": io.get("read_bytes"), "tcp": tcp_acked(pid)}
            with open(path, "a") as f:
                f.write(json.dumps(rec) + "\n")
        time.sleep(a.interval)

if __name__ == "__main__":
    sys.exit(main())
