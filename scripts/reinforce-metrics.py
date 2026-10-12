#!/usr/bin/env python3
"""自强化循环开发的指标巡检（默认只读，绝不删文件）。

用法:
    python3 scripts/reinforce-metrics.py                 # 只打印报告, 不写文件
    python3 scripts/reinforce-metrics.py --write         # 写 docs/metrics/<date>.md
    python3 scripts/reinforce-metrics.py --days 7        # 统计窗口
    python3 scripts/reinforce-metrics.py --since 2026-10-06
    python3 scripts/reinforce-metrics.py --node vps      # 额外扫节点卡死残留(只读)

指标口径见 docs/self-reinforcing-dev.md「指标记录」。本脚本只做聚合与只读文件系统扫描，
不会删除任何 .ts/.xml/.ass/.drec-node-result.json。所有节点路径按隐私口径在产出中脱敏。
"""

from __future__ import annotations

import argparse
import json
import re
import subprocess
import sys
from datetime import datetime, timedelta, timezone
from pathlib import Path

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
    except subprocess.TimeoutExpired:
        return ""
    if check and p.returncode != 0:
        return ""
    return p.stdout


def epoch_ms_to_dt(ms: float) -> datetime | None:
    if ms is None or ms <= 0 or ms > 1e13:
        return None
    return datetime.fromtimestamp(ms / 1000, tz=timezone.utc)


def read_sync_jobs(db: Path) -> list[dict]:
    if not db.exists():
        return []
    sql = (
        "select streamKey,state,bv,error,updatedAt,startMs,winnerWorker from sync_jobs"
    )
    out = run(["sqlite3", "-json", str(db), sql])
    if not out:
        return []
    try:
        return json.loads(out)
    except json.JSONDecodeError:
        return []


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


def main() -> int:
    ap = argparse.ArgumentParser(description="自强化循环开发指标巡检(只读)")
    ap.add_argument("--db", type=Path, default=DEFAULT_DB)
    ap.add_argument("--stage", type=Path, default=DEFAULT_STAGE)
    ap.add_argument("--days", type=int, default=1)
    ap.add_argument("--since", default=None, help="YYYY-MM-DD 覆盖 --days")
    ap.add_argument("--node", action="append", default=[], help="额外 ssh 扫描的节点")
    ap.add_argument("--repo", default="fuyucn/douyin-rec")
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

    jobs = read_sync_jobs(args.db)
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
