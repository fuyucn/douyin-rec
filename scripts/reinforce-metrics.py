#!/usr/bin/env python3
"""自强化循环开发的指标巡检（默认只读，绝不删文件）。

用法:
    python3 scripts/reinforce-metrics.py                 # 只打印报告, 不写文件
    python3 scripts/reinforce-metrics.py --write         # 写 docs/metrics/<date>.md
    python3 scripts/reinforce-metrics.py --days 7        # 统计窗口
    python3 scripts/reinforce-metrics.py --since 2026-10-06
    python3 scripts/reinforce-metrics.py --node vps      # 额外扫节点卡死残留(只读)
    python3 scripts/reinforce-metrics.py --loop --days 7 # 只出「PR 流程」纯文本表(供 loop 通知贴;无台账/无 gh 也能跑)
    ... --db-container NAME [--db-container-path P]      # 台账经 docker exec 容器内只读读(默认容器 douyin-rec;失败: 显式传=报错退出, 默认=降级 immutable 快照)
    ... --ledger-log FILE | --ledger-container NAME      # 统计 `[ledger] 拒绝` 行数(日志不可得则跳过并标注)
    ... --fixture FILE.json                              # 离线喂 {prs,issues}(测试用,不调 gh)

指标口径见 docs/self-reinforcing-dev.md「指标记录」。本脚本只做聚合与只读文件系统扫描，
不会删除任何 .ts/.xml/.ass/.drec-node-result.json。所有节点路径按隐私口径在产出中脱敏。
"""

from __future__ import annotations

import argparse
import json
import re
import shutil
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path
from urllib.parse import quote

REPO = Path(__file__).resolve().parents[1]
DEFAULT_DB = REPO / "docker-data" / "db" / "douyin-rec-sync.db"
DEFAULT_STAGE = REPO / "docker-data" / "stage"
DEFAULT_METRICS_DIR = REPO / "docs" / "metrics"

# 平台/节点脱敏: 报告里不出现房间号/streamKey/integer 主机名。
def redact(s: str) -> str:
    s = re.sub(r"douyin:\d+", "douyin:*****", s)
    s = re.sub(r"kuaishou:\w+", "kuaishou:*****", s)
    s = re.sub(r"bilibili:\S+", "bilibili:*****", s)
    s = re.sub(r"\d+\.\d+\.\d+\.\d+", "ip:****", s)
    return s


def run(cmd: list[str], timeout: int = 20, check: bool = False) -> str:
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except (subprocess.TimeoutExpired, OSError):
        # OSError:命令不在 PATH(gh 未装等)→ 返回空让调用方走降级路径,不炸整个巡检。
        return ""
    if check and p.returncode != 0:
        return ""
    return p.stdout


def epoch_ms_to_dt(ms: float) -> datetime | None:
    if ms is None or ms <= 0 or ms > 1e13:
        return None
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc)


# ---------------------------------------------------------------- 台账读取(issue #428 复审)
# 台账 <db>-sync.db 已切 WAL(busy_timeout),且 master 的 docker-data 在 bind mount 上 ——
# 宿主机(尤其 macOS:容器跑在 Linux VM)**任何方式**打开(含 sqlite3 -readonly:仍会写/重建 -shm,
# 且锁不跨 VM 共享)都可能干扰容器侧正在使用的台账。读取顺序只有两档:
#   ① 容器内 node:sqlite readOnly(docker exec <容器>;默认容器 douyin-rec = docker-compose.yml 的 container_name);
#   ② 宿主 file:...?immutable=1 快照(不创建 -shm/-wal,不加锁;可能旧/撕裂,报告标注)。
# 显式传 --db-container 而容器读取失败 → 不降级,报错退出(用户指定了通道,静默换成旧快照会误导)。
DEFAULT_CONTAINER = "douyin-rec"
CONTAINER_DB_DIR = "/output-data/db"
READ_SYNC_SQL = "select streamKey,state,bv,error,updatedAt,startMs,winnerWorker from sync_jobs"

# 容器内 node:sqlite 只读读台账(与 docs/dev-multi-node.md「台账状态」排查命令同款)。
# process.argv[1]=库路径 argv[2]=SQL(与 dev/multi-node/scenarios/lib.sh 的 ledger() 同布局)。
_NODE_READ_CODE = (
    "const {DatabaseSync}=require('node:sqlite');"
    "let d;try{d=new DatabaseSync(process.argv[1],{readOnly:true})}catch(e){process.exit(3)}"
    "try{process.stdout.write(JSON.stringify(d.prepare(process.argv[2]).all()))}"
    "finally{try{d.close()}catch(e){}}"
)


def _run_rc(cmd: list[str], timeout: int = 20) -> tuple[int, str]:
    """返回 (rc, stdout);命令不存在/超时 → (-1, "")。"""
    try:
        p = subprocess.run(cmd, capture_output=True, text=True, timeout=timeout)
    except (subprocess.TimeoutExpired, OSError):
        return -1, ""
    return p.returncode, p.stdout


def _parse_rows(out: str) -> list[dict] | None:
    """解析 -json 输出。空输出 = 合法空结果(sqlite3 -json 零行时不打印任何东西,原口径
    `if not out: return []`);坏 JSON 才是「不可读」(上层试下一档)。"""
    if not out.strip():
        return []
    try:
        rows = json.loads(out)
    except json.JSONDecodeError:
        return None
    return rows if isinstance(rows, list) else None


class LedgerReadError(Exception):
    """显式指定的容器通道读取失败(不降级)。"""


def _read_via_container(container: str, path: str) -> tuple[list[dict], str, str]:
    """成功返回 (rows, 来源标注, "");失败返回 ([], "", 原因)。"""
    if not shutil.which("docker"):
        return [], "", "docker 不可用"
    rc, out = _run_rc(["docker", "exec", container, "node", "-e", _NODE_READ_CODE,
                       path, READ_SYNC_SQL], timeout=15)
    if rc != 0:
        return [], "", f"docker exec {container} 失败(rc={rc};容器不存在/未运行或库 {path} 打不开)"
    rows = _parse_rows(out)
    if rows is None:
        return [], "", "容器内读取输出无法解析"
    return rows, f"容器内只读(docker exec {container})", ""


def _read_via_sqlite3_immutable(db: Path) -> tuple[list[dict], str] | None:
    if not shutil.which("sqlite3"):
        return None
    # immutable=1 忽略 -wal/-shm(快照语义):不创建 -shm、不加锁,但可能读到旧/撕裂数据 —— 来源标注注明。
    uri = f"file:{quote(str(db))}?immutable=1"
    rc, out = _run_rc(["sqlite3", "-json", uri, READ_SYNC_SQL])
    if rc != 0:
        return None
    rows = _parse_rows(out)
    if rows is None:
        return None
    return rows, "宿主 immutable 快照(可能读到旧/撕裂数据)"


def read_sync_jobs(db: Path, container: str | None = None, container_path: str | None = None,
                   explicit: bool = False) -> tuple[list[dict], str]:
    """只读读台账,返回 (rows, 来源标注)。

    先容器内 readOnly;失败时 explicit(用户显式传 --db-container)→ 抛 LedgerReadError,
    否则降级宿主 immutable=1 快照(来源标注带降级原因)。**宿主不再有任何 sqlite3 -readonly 档**。
    台账文件不存在 → 空结果(原口径)。
    """
    note = ""
    if container:
        path = container_path or f"{CONTAINER_DB_DIR}/{db.name}"
        rows, source, why = _read_via_container(container, path)
        if source:
            return rows, source
        if explicit:
            raise LedgerReadError(f"--db-container {container} 读取失败: {why}")
        note = f"容器 {container} 不可用({why}),"
    if not db.exists():
        return [], f"{note}台账不存在".lstrip(",")
    hit = _read_via_sqlite3_immutable(db)
    if hit is not None:
        return hit[0], f"{note}{hit[1]}"
    return [], f"{note}台账不可读(sqlite3 不可用/打不开)"


def is_in_window(updated_at: float, since_dt: datetime) -> bool:
    dt = epoch_ms_to_dt(updated_at)
    return dt is not None and dt >= since_dt


def classify(job: dict) -> str:
    """把需要人工介入的场次粗分: 疑似假失败 / 疑似真故障 / 待人工。

    疑似假失败 = needs_manual 且：
      - 已拿到 BV（上传其实成功, 台账卡在核验/回读）， 或
      - error 标记为节点侧上传失败(ssh rc≠0/超时, 0.0.79 修复对象)。
    其余 needs_manual 归为待人工（含 stage 模式按设计不上传、真 rsync 失败等）。
    """
    state = (job.get("state") or "").lower()
    if state != "needs_manual":
        return ""
    err = (job.get("error") or "")
    bv = (job.get("bv") or "").strip()
    if bv:
        return "疑似假失败: 已拿BV"
    if "节点侧上传失败" in err or "ssh rc=" in err or "ssh rc≠" in err:
        return "疑似假失败: 节点侧上传(ssh rc/超时)"
    return "待人工后台核验"


def sanitize_stream_key(key: str) -> str:
    """与 packages/core 的 sanitizeStreamKey 同一规则: `:`/`/` → `_`。"""
    return key.replace(":", "_").replace("/", "_")


def scan_stage_residue(dirs: list[Path]) -> list[dict]:
    """只读: 在给定目录里找 .ts/.mp4/.flv, 记入字节。不删任何文件。"""
    hits: list[dict] = []
    vid_re = re.compile(r"\.(ts|mp4|flv)$", re.IGNORECASE)
    for d in dirs:
        if not d.exists():
            continue
        for p in d.rglob("*"):
            if not p.is_file() or not vid_re.search(p.name):
                continue
            try:
                size = p.stat().st_size
            except OSError:
                size = 0
            hits.append({"dir": str(d), "path": str(p), "bytes": size})
    return hits


def residue_by_component(hits: list[dict], done_keys: set[str]) -> list[dict]:
    """挑出「台账 done 但源仍在」的卡死残留: 路径里任一目录名 = sanitize(streamKey)。

    只统计 done 场次, 避免把还在 merging/uploading 的正常中间产物误算成残留。
    """
    return [
        h for h in hits
        if any(part in done_keys for part in Path(h["path"]).parts)
    ]


# ---------------------------------------------------------------- PR 流程指标(issue #78)
STOP_TOKENS = {"incident", "enhancement", "修复", "问题", "失败", "录制", "issue", "this", "that", "with", "from"}
ISSUE_STATE_RE = re.compile(r"<!--\s*issue-state:\s*from=(\S+)\s+to=(\S+)[^>]*?at=(\S+)\s*-->")


def parse_ts(v: str | None) -> datetime | None:
    if not v:
        return None
    try:
        return datetime.fromisoformat(v.replace("Z", "+00:00"))
    except ValueError:
        return None


def tokens(text: str) -> set[str]:
    """粗匹关键词: ascii 词(>=4) + CJK 二元组;去掉通用词。"""
    out: set[str] = set()
    for w in re.findall(r"[A-Za-z][A-Za-z0-9_\-]{3,}", text or ""):
        out.add(w.lower())
    for run in re.findall(r"[\u4e00-\u9fff]+", text or ""):
        out.update(run[i:i + 2] for i in range(len(run) - 1))
    return {t for t in out if t not in STOP_TOKENS}


def label_names(obj: dict) -> set[str]:
    return {l.get("name", "") if isinstance(l, dict) else str(l) for l in obj.get("labels", [])}


def linked_issue(pr: dict) -> int | None:
    # `Part of #N` = one step of a staged issue (#253); it links the same issue for the metrics.
    m = re.search(r"(?im)^\s*(?:fixes|closes|resolves|part\s+of)\s+#(\d+)", pr.get("body") or "")
    return int(m.group(1)) if m else None


def pr_rework_rounds(pr: dict, issue: dict | None) -> int:
    """打回轮数: CHANGES_REQUESTED review + 含「打回」的 PR 评论 + issue 上迁到 rework-N 的状态标记(取最大者, 避免重复计)。"""
    reviews = sum(1 for r in pr.get("reviews", []) if (r.get("state") or "").upper() == "CHANGES_REQUESTED")
    comments = sum(1 for c in pr.get("comments", []) if "打回" in (c.get("body") or ""))
    markers = 0
    if issue:
        for c in issue.get("comments", []):
            m = ISSUE_STATE_RE.search(c.get("body") or "")
            if m and m.group(2).startswith("rework-"):
                markers += 1
    return max(reviews + comments, markers)


def compute_pr_metrics(prs: list[dict], issues: list[dict], now: datetime, days: int) -> dict:
    since = now - timedelta(days=max(days, 1))
    by_num = {i.get("number"): i for i in issues}
    done = [p for p in prs if (parse_ts(p.get("mergedAt")) or parse_ts(p.get("closedAt")) or since - timedelta(days=1)) >= since]
    dist = {"0": 0, "1": 0, "2": 0, "3+": 0}
    for p in done:
        r = pr_rework_rounds(p, by_num.get(linked_issue(p)))
        dist["3+" if r >= 3 else str(r)] += 1
    reworked = len(done) - dist["0"]

    incidents = [i for i in issues if "incident" in label_names(i)]
    escaped: list[tuple[int, int]] = []
    merged = [p for p in done if parse_ts(p.get("mergedAt"))]
    for p in merged:
        t0 = parse_ts(p["mergedAt"])
        src = by_num.get(linked_issue(p)) or {}
        ptok = tokens(src.get("title", "") + " " + p.get("title", ""))
        for inc in incidents:
            ct = parse_ts(inc.get("createdAt"))
            if inc.get("number") == src.get("number") or not ct or not (t0 < ct <= t0 + timedelta(hours=48)):
                continue
            if len(ptok & tokens(inc.get("title", ""))) >= 3:
                escaped.append((p["number"], inc["number"]))
                break

    waiting: list[tuple[int, float]] = []
    merged_at = {linked_issue(p): parse_ts(p.get("mergedAt")) for p in prs if linked_issue(p)}
    for i in issues:
        if (i.get("state") or "").upper() != "OPEN" or "待验证" not in label_names(i):
            continue
        since_t = None
        for c in i.get("comments", []):
            m = ISSUE_STATE_RE.search(c.get("body") or "")
            if m and m.group(2) == "待验证":
                since_t = parse_ts(m.group(3)) or since_t
        since_t = since_t or merged_at.get(i.get("number")) or parse_ts(i.get("updatedAt"))
        if since_t:
            waiting.append((i["number"], (now - since_t).total_seconds() / 3600))
    return {"total": len(done), "reworked": reworked, "dist": dist, "merged": len(merged),
            "escaped": escaped, "waiting": sorted(waiting, key=lambda x: -x[1])}


def count_ledger_rejects(log_file: str | None, container: str | None, days: int) -> tuple[int | None, str]:
    """返回 (计数, 来源说明);日志不可得 → (None, 原因)。"""
    text = None
    if log_file:
        try:
            text = Path(log_file).read_text(encoding="utf-8", errors="replace")
        except OSError as e:
            return None, f"日志文件不可读: {e.strerror}"
        src = "日志文件"
    elif container:
        p = subprocess.run(["docker", "logs", "--since", f"{max(days, 1) * 24}h", container], capture_output=True, text=True) \
            if shutil.which("docker") else None
        if p is None or p.returncode != 0:
            return None, "docker logs 不可用"
        text, src = p.stdout + p.stderr, "docker logs"
    else:
        return None, "未提供 --ledger-log / --ledger-container"
    return sum(1 for ln in text.splitlines() if "[ledger] 拒绝" in ln), src


def render_pr_metrics(m: dict, days: int, ledger: tuple[int | None, str] | None, gh_ok: bool = True) -> str:
    if not gh_ok:
        return f"PR 流程指标(近 {days} 天): 跳过 —— gh 不可用或无网络(降级, 非 0 值)\n"
    total = m["total"]
    rate = f"{m['reworked'] / total * 100:.0f}%" if total else "n/a"
    esc = f"{len(m['escaped'])}/{m['merged']} ({len(m['escaped']) / m['merged'] * 100:.0f}%)" if m["merged"] else "n/a"
    rows = [
        ("返工率(打回>=1 轮 / 已结 PR)", f"{m['reworked']}/{total} ({rate})" if total else "n/a(窗口内无已结 PR)"),
        ("打回轮数分布 0/1/2/3+", "/".join(str(m["dist"][k]) for k in ("0", "1", "2", "3+"))),
        ("逃逸率(合并 48h 内同根因新 incident)", esc),
    ]
    if m["escaped"]:
        rows.append(("  逃逸明细(PR→incident)", ", ".join(f"#{a}→#{b}" for a, b in m["escaped"])))
    if m["waiting"]:
        w = ", ".join(f"#{n} {h:.0f}h" for n, h in m["waiting"][:5])
        rows.append(("待验证 停留", f"{len(m['waiting'])} 张: {w}"))
    else:
        rows.append(("待验证 停留", "0 张"))
    if ledger is not None:
        n, note = ledger
        rows.append(("台账 `[ledger] 拒绝` 计数", f"{n}({note})" if n is not None else f"跳过 —— {note}"))
    width = max(len(r[0]) for r in rows)
    head = f"PR 流程指标 · 近 {days} 天\n" + "-" * 40 + "\n"
    return head + "\n".join(f"{k.ljust(width)}  {v}" for k, v in rows) + "\n"


def fetch_gh_data(repo: str) -> tuple[list[dict], list[dict]] | None:
    if not shutil.which("gh"):
        return None
    pr_out = run(["gh", "pr", "list", "--repo", repo, "--state", "all", "--limit", "200", "--json",
                  "number,title,body,createdAt,mergedAt,closedAt,labels,reviews,comments"], timeout=60)
    is_out = run(["gh", "issue", "list", "--repo", repo, "--state", "all", "--limit", "300", "--json",
                  "number,title,state,createdAt,updatedAt,labels,comments"], timeout=60)
    try:
        return json.loads(pr_out), json.loads(is_out)
    except (json.JSONDecodeError, ValueError):
        return None


def pr_flow_section(args, now: datetime) -> str:
    if args.fixture:
        d = json.loads(Path(args.fixture).read_text(encoding="utf-8"))
        data = (d.get("prs", []), d.get("issues", []))
    else:
        data = fetch_gh_data(args.repo)
    ledger = count_ledger_rejects(args.ledger_log, args.ledger_container, args.days)
    if data is None:
        return render_pr_metrics({}, args.days, ledger, gh_ok=False)
    return render_pr_metrics(compute_pr_metrics(data[0], data[1], now, args.days), args.days, ledger)


def main() -> int:
    ap = argparse.ArgumentParser(description="自强化循环开发指标巡检(只读)")
    ap.add_argument("--db", type=Path, default=DEFAULT_DB,
                    help="宿主台账路径(immutable 快照降级用;也用于推导容器内默认路径的文件名)")
    ap.add_argument("--db-container", default=None,
                    help=f"master 容器名:经 docker exec 在容器内只读读台账(默认 {DEFAULT_CONTAINER};"
                         "WAL 台账宿主机只允许 immutable 快照,issue #428)。显式传入而读取失败 → 报错退出,不降级;"
                         "不传则失败时降级 immutable 快照并在报告标注")
    ap.add_argument("--db-container-path", default=None,
                    help="库在容器内的路径(默认 /output-data/db/<--db 的文件名>)")
    ap.add_argument("--stage", type=Path, default=DEFAULT_STAGE)
    ap.add_argument("--days", type=int, default=1)
    ap.add_argument("--since", default=None, help="YYYY-MM-DD 覆盖 --days")
    ap.add_argument("--node", action="append", default=[], help="额外 ssh 扫描的节点")
    ap.add_argument("--repo", default="fuyucn/douyin-rec")
    ap.add_argument("--loop", action="store_true", help="只输出 PR 流程纯文本表(不读台账/磁盘)")
    ap.add_argument("--ledger-log", default=None, help="含 `[ledger] 拒绝` 的日志文件")
    ap.add_argument("--ledger-container", default=None, help="docker 容器名(读 docker logs)")
    ap.add_argument("--fixture", default=None, help="离线 {prs,issues} JSON(测试用)")
    ap.add_argument("--write", action="store_true", help="写 docs/metrics/<date>.md")
    ap.add_argument("--metrics-dir", type=Path, default=DEFAULT_METRICS_DIR)
    args = ap.parse_args()

    now = datetime.now(timezone.utc)
    if args.since:
        since_dt = datetime.fromisoformat(args.since).replace(
            tzinfo=timezone.utc
        )
    else:
        since_dt = now - timedelta(days=max(args.days, 1))

    if args.loop:
        print(pr_flow_section(args, now), end="")
        return 0

    try:
        jobs, ledger_source = read_sync_jobs(args.db, args.db_container or DEFAULT_CONTAINER,
                                             args.db_container_path, explicit=args.db_container is not None)
    except LedgerReadError as e:
        print(f"错误: {e}", file=sys.stderr)
        return 2
    window = [j for j in jobs if is_in_window(j.get("updatedAt", 0), since_dt)]
    done = sum(1 for j in window if (j.get("state") or "").lower() == "done")
    needs_manual = [j for j in window if (j.get("state") or "").lower() == "needs_manual"]
    failed = sum(1 for j in window if (j.get("state") or "").lower() == "failed")
    closed_manual = done + len(needs_manual) + failed

    false_fail = [j for j in needs_manual if classify(j).startswith("疑似假失败")]
    false_fail_rate = (len(false_fail) / closed_manual * 100) if closed_manual else 0.0

    # 卡死残留: 台账 done 但源视频仍在（只读, 不删）。按 stage 子目录名 = sanitize(streamKey)。
    done_keys = {
        sanitize_stream_key(j.get("streamKey", ""))
        for j in jobs
        if (j.get("state") or "").lower() == "done"
    }
    manual_keys = {
        sanitize_stream_key(j.get("streamKey", ""))
        for j in jobs
        if (j.get("state") or "").lower() == "needs_manual"
    }
    all_stage_hits = scan_stage_residue([args.stage])
    stage_hits = residue_by_component(all_stage_hits, done_keys)
    stage_bytes = sum(h["bytes"] for h in stage_hits)
    manual_hits = residue_by_component(all_stage_hits, manual_keys)
    manual_bytes = sum(h["bytes"] for h in manual_hits)

    # 节点卡死残留: 可选, 只读。
    node_hits: list[dict] = []
    node_bytes = 0
    for idx, host in enumerate(args.node, start=1):
        # 单次 ssh: find -printf 直接给出「字节 路径」, 避免 per-file ssh 往返。
        raw = run(["ssh", "-o", "ConnectTimeout=8", host,
                   "find /home/*/drec/recordings /home/*/drec/stage "
                   "/home/*/output-data/stage -type f \\( -name '*.ts' "
                   "-o -name '*.mp4' -o -name '*.flv' \\) "
                   "-printf '%s %p\\n' 2>/dev/null | head -500"],
                  timeout=45)
        for line in raw.splitlines():
            line = line.strip()
            if not line:
                continue
            size_str, _, _path = line.partition(" ")
            try:
                s = int(size_str)
            except ValueError:
                s = 0
            # 只记序号与字节, 不回显主机名 / 路径（含主播名, 属隐私）。
            node_hits.append({"host": f"node#{idx}", "bytes": s})
            node_bytes += s

    # 开单→收口时长(近30天已关闭 issue)。
    closed_issues = None
    issue_out = run(["gh", "issue", "list", "--repo", args.repo,
                     "--state", "closed", "--limit", "100",
                     "--json", "number,title,createdAt,closedAt"], timeout=30)
    if issue_out:
        try:
            closed_issues = json.loads(issue_out)
        except json.JSONDecodeError:
            closed_issues = None

    issue_hours: list[float] = []
    if closed_issues:
        cutoff = now - timedelta(days=30)
        for it in closed_issues:
            c_at = it.get("createdAt")
            cl_at = it.get("closedAt")
            if not c_at or not cl_at:
                continue
            try:
                created = datetime.fromisoformat(
                    c_at.replace("Z", "+00:00")
                )
                closedd = datetime.fromisoformat(
                    cl_at.replace("Z", "+00:00")
                )
            except ValueError:
                continue
            if created < cutoff:
                continue
            issue_hours.append((closedd - created).total_seconds() / 3600)

    lines: list[str] = []
    lines.append(f"# 自强化循环指标 · {now.strftime('%Y-%m-%d')}（UTC）")
    lines.append("")
    window_desc = f"`{args.since}` 起" if args.since else f"`{since_dt.strftime('%Y-%m-%d')}` 起（{args.days} 天）"
    lines.append(f"统计窗口：{window_desc}")
    lines.append("")
    lines.append("## 1. 台账收口")
    lines.append("")
    lines.append(f"- 数据来源：{ledger_source}")
    lines.append(f"- 收口场次（done + needs_manual + failed）：{closed_manual}")
    lines.append(f"- done：{done}")
    lines.append(f"- needs_manual：{len(needs_manual)}")
    lines.append(f"- failed：{failed}")
    lines.append(f"- 疑似假失败：{len(false_fail)}")
    if false_fail:
        for j in false_fail[:8]:
            lines.append(f"  - {redact(j.get('streamKey',''))}：{classify(j)}")
    lines.append("")
    lines.append("| 指标 | 值 |")
    lines.append("| --- | --- |")
    lines.append(f"| 假失败率(疑似假失败/收口) | {false_fail_rate:.1f}% |")
    lines.append("")
    lines.append("## 2. 卡死残留（只读扫描，不删）")
    lines.append("")
    lines.append(
        f"- master stage（台账 done 且源仍在）：{len(stage_hits)} 个 / "
        f"{stage_bytes/1e9:.2f} GB（stage 子目录名 = sanitize(streamKey)，可与台账精确联结）"
    )
    lines.append(
        f"- master stage（台账 needs_manual 保留的源，非「卡死残留」但占盘）："
        f"{len(manual_hits)} 个 / {manual_bytes/1e9:.2f} GB（按设计保留，待人工处理）"
    )
    if args.node:
        lines.append(
            f"- 节点 recordings/stage 原始视频文件：{len(node_hits)} 个 / "
            f"{node_bytes/1e9:.2f} GB（节点目录按主播名，无法与台账精确联结，"
            f"含仍在录 / 待收口场次，仅作上界参考）"
        )
    for h in node_hits[:8]:
        lines.append(f"  - {h['host']}：{h['bytes']/1e9:.2f} GB")
    lines.append("")
    lines.append("## 3. 开单→收口时长")
    lines.append("")
    if issue_hours:
        avg = sum(issue_hours) / len(issue_hours)
        mx = max(issue_hours)
        lines.append(f"- 近 30 天已关闭 issue：{len(issue_hours)} 个 / 平均 {avg:.1f} h / 最长 {mx:.1f} h")
    else:
        lines.append("- 近 30 天无已关闭 issue（观察期不足），暂不计。")
    lines.append("")
    lines.append("## 4. 复发数与验证覆盖")
    lines.append("")
    lines.append("- 复发数：由三根因关键词（节点侧上传 / 分P核验 / 磁盘写满）人工归类后回填，本轮未做自动归类。")
    lines.append("- 验证覆盖：待修复类 issue 收口时回填「已部署核对版本 + 实跑验证」记录。")
    lines.append("")
    lines.append("## 5. PR 流程(返工率 / 逃逸率 / 待验证 / 台账拒绝)")
    lines.append("")
    lines.append("```")
    lines.append(pr_flow_section(args, now).rstrip("\n"))
    lines.append("```")
    lines.append("")
    lines.append("> 本报告由 `scripts/reinforce-metrics.py` 生成，只做只读聚合。")

    report = "\n".join(lines) + "\n"
    print(report)

    if args.write:
        args.metrics_dir.mkdir(parents=True, exist_ok=True)
        out = args.metrics_dir / f"{now.strftime('%Y-%m-%d')}.md"
        out.write_text(report, encoding="utf-8")
        print(f"已写入 {out}", file=sys.stderr)

    return 0


if __name__ == "__main__":
    raise SystemExit(main())
