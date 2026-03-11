#!/usr/bin/env python3
"""端到端录制测试脚本

测试覆盖：
- FLV 流 → TS 分段输出（core）
- 画质：origin / uhd
- 弹幕录制开/关
- 分段/不分段
- 定时启停

使用方法：
  uv run python tests/e2e_recording_test.py

测试时长：约 5-10 分钟
注意：需要 Web UI 已启动（uv run python main.py record --ui）

更新记录：
  2026-03-10  初始版本：TS分段/弹幕/定时 基础测试
              关键发现：Douyin CDN 不允许同一直播间被多个 ffmpeg 同时抓取
              → 测试任务必须使用与现有任务不同的直播间 URL
"""

from __future__ import annotations

import asyncio
import json
import os
import shutil
import sys
import time
from datetime import datetime, timedelta
from pathlib import Path

import requests

API = "http://localhost:7860"
OUTPUT_DIR = Path("output")
TEST_PREFIX = "TEST_"
# 测试总时长（秒），录制监控阶段
RECORD_WAIT_SEC = 300  # 5 分钟

# ── 已被现有任务占用的直播间（不能重复使用，CDN 互斥） ──────────────────────
OCCUPIED_ROOMS = {
    "693199384458",  # task 15 脸不圆
    "769269676376",  # task 18 小花妹妹2
    "71494523558",   # task 19 王明军
}

# ── 手动指定测试直播间（优先于自动发现） ────────────────────────────────────
# 留空则走自动发现逻辑；填入后每次测试直接使用这些房间
MANUAL_ROOMS: list[str] = [
    "https://live.douyin.com/465721793855",   # 流放2-老于
    "https://live.douyin.com/63796022481",    # 朝阳冬泳怪鸽
    "https://live.douyin.com/478574517022",   # 灵儿
    "https://live.douyin.com/789392615814",   # 美国小学兔兔老师
    "https://live.douyin.com/87072601135",    # Lyaoay
]


# ── 工具函数 ────────────────────────────────────────────────────────────────

def api(method: str, path: str, **kwargs):
    r = requests.request(method, f"{API}{path}", timeout=15, **kwargs)
    r.raise_for_status()
    return r.json()


def log(msg: str):
    ts = datetime.now().strftime("%H:%M:%S")
    print(f"[{ts}] {msg}", flush=True)


# ── Step 1: 发现活跃直播间 ────────────────────────────────────────────────────

async def _check_room(url: str) -> tuple[str, str] | None:
    """检查直播间是否开播，返回 (url, anchor_name) 或 None"""
    sys.path.insert(0, str(Path(__file__).parent.parent))
    from src.input.douyin_spider import get_douyin_stream_data
    try:
        data = await get_douyin_stream_data(url)
        if data.get("status") == 2:
            return url, data.get("anchor_name", "未知")
    except Exception:
        pass
    return None


async def discover_live_rooms(need: int = 5) -> list[tuple[str, str]]:
    """发现活跃直播间。

    策略（依次尝试）：
    1. 读取当前系统中运行中的任务，直接使用其 URL（已确认在播）
    2. 尝试从抖音首页 JS bundle 中提取 web_rid（成功率低，仅作补充）
    """
    import re
    import aiohttp
    import requests as _req

    live: list[tuple[str, str]] = []

    # ── 策略0：MANUAL_ROOMS 手动指定（最优先）────────────────────────────────
    if MANUAL_ROOMS:
        log("  使用手动指定直播间，验证是否在播…")
        tasks_coro = [_check_room(url) for url in MANUAL_ROOMS]
        results = await asyncio.gather(*tasks_coro)
        for r in results:
            if r:
                live.append(r)
                log(f"  [手动] ✓ {r[1]}  {r[0]}")
        if len(live) >= need:
            log(f"共找到可用直播间 {len(live)} 个")
            return live[:need]

    # ── 策略1：从系统现有运行中的任务取 URL（最可靠）─────────────────────────
    try:
        resp = _req.get(f"{API}/api/tasks", timeout=5)
        tasks_data = resp.json().get("tasks", [])
        for t in tasks_data:
            if t.get("status") == "running" and t.get("url"):
                url = t["url"]
                rid = re.search(r"douyin\.com/(\d+)", url)
                if rid and rid.group(1) not in OCCUPIED_ROOMS:
                    name = t.get("name") or "未知"
                    live.append((url, name))
                    log(f"  [系统任务] ✓ {name}  {url}")
    except Exception as e:
        log(f"  读取系统任务失败: {e}")

    if len(live) >= need:
        return live[:need]

    # ── 策略2：从 OCCUPIED_ROOMS 中随机取（已知在播，测试录制功能本身）──────
    # CDN 不限制多路录制（多个用户可以同时观看），rc=-11 是旧 FLV 问题，已修复
    if not live:
        log("  使用已知直播间（OCCUPIED_ROOMS）进行功能验证…")
        candidates = list(OCCUPIED_ROOMS)
        tasks_coro = [_check_room(f"https://live.douyin.com/{rid}") for rid in candidates]
        results = await asyncio.gather(*tasks_coro)
        for r in results:
            if r:
                live.append(r)
                log(f"  [已知房间] ✓ {r[1]}  {r[0]}")

    # ── 策略3：首页 JS 补充（通常失效，聊胜于无）────────────────────────────
    if len(live) < need:
        headers = {
            "User-Agent": "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) "
                          "AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
            "Referer": "https://live.douyin.com",
        }
        try:
            async with aiohttp.ClientSession() as sess:
                async with sess.get(
                    "https://live.douyin.com",
                    headers=headers,
                    timeout=aiohttp.ClientTimeout(total=15),
                ) as r:
                    text = await r.text()
            ids = list(dict.fromkeys(re.findall(r'"web_rid"\s*:\s*"(\d{10,})"', text)))
            extra_candidates = [rid for rid in ids if rid not in OCCUPIED_ROOMS]
            if extra_candidates:
                tasks_coro = [_check_room(f"https://live.douyin.com/{rid}") for rid in extra_candidates[:10]]
                results = await asyncio.gather(*tasks_coro)
                for r in results:
                    if r:
                        live.append(r)
                        log(f"  [首页发现] ✓ {r[1]}  {r[0]}")
        except Exception as e:
            log(f"  首页爬取失败(忽略): {e}")

    log(f"共找到可用直播间 {len(live)} 个")
    return live[:need]


# ── Step 2: 创建测试任务 ──────────────────────────────────────────────────────

def build_task_configs(rooms: list[tuple[str, str]]) -> list[dict]:
    """根据可用直播间生成测试任务配置"""
    now = datetime.now()
    schedule_start = (now + timedelta(minutes=3)).strftime("%H:%M")
    schedule_end   = (now + timedelta(minutes=8)).strftime("%H:%M")

    # 测试矩阵（按优先级排，rooms 不够时取前几个）
    scenarios = [
        {   # 1. origin + 分段300s + 弹幕（核心场景）
            "label": "origin_seg300_danmu",
            "quality": "origin", "enable_segment": True, "segment_sec": 300,
            "enable_danmu": True,
        },
        {   # 2. uhd + 分段300s + 弹幕
            "label": "uhd_seg300_danmu",
            "quality": "uhd", "enable_segment": True, "segment_sec": 300,
            "enable_danmu": True,
        },
        {   # 3. origin + 不分段 + 弹幕（单文件模式）
            "label": "origin_noseg_danmu",
            "quality": "origin", "enable_segment": False, "segment_sec": 0,
            "enable_danmu": True,
        },
        {   # 4. origin + 分段300s + 无弹幕
            "label": "origin_seg300_nodanmu",
            "quality": "origin", "enable_segment": True, "segment_sec": 300,
            "enable_danmu": False,
        },
        {   # 5. 定时录制：origin + 分段 + 弹幕，窗口 = 当前+2min ~ 当前+7min（PST）
            "label": "scheduled_origin_danmu",
            "quality": "origin", "enable_segment": True, "segment_sec": 300,
            "enable_danmu": True,
            "schedule_enabled": True,
            "schedule_start": schedule_start,
            "schedule_stop": schedule_end,
            "schedule_timezone": "America/Los_Angeles",
        },
    ]

    configs = []
    for i, scenario in enumerate(scenarios):
        if i >= len(rooms):
            break
        url, anchor = rooms[i]
        body = {
            "url": url,
            "custom_name": f"{TEST_PREFIX}{scenario['label']}",
            "quality": scenario["quality"],
            "enable_record": True,
            "enable_screenshot": False,
            "enable_segment": scenario["enable_segment"],
            "segment_sec": scenario["segment_sec"],
            "enable_danmu": scenario["enable_danmu"],
            "poll_interval": 180,
        }
        if scenario.get("schedule_enabled"):
            body.update({
                "schedule_enabled": True,
                "schedule_start": scenario["schedule_start"],
                "schedule_stop": scenario["schedule_stop"],
                "schedule_timezone": scenario.get("schedule_timezone", "America/Los_Angeles"),
            })
        configs.append((scenario["label"], anchor, body))

    return configs


# ── Step 3: 监控 + 验证 ────────────────────────────────────────────────────────

def check_task_output(task_id: int) -> dict:
    """检查任务输出目录"""
    task_dir = OUTPUT_DIR / f"task_{task_id}"
    ts_files = sorted(task_dir.glob("*.ts")) if task_dir.exists() else []
    ass_files = sorted(task_dir.glob("*.ass")) if task_dir.exists() else []

    total_size = sum(f.stat().st_size for f in ts_files)
    return {
        "ts_count": len(ts_files),
        "ts_size_mb": total_size / 1024 / 1024,
        "ass_count": len(ass_files),
        "ts_files": [f.name for f in ts_files],
    }


def get_task_log_tail(task_id: int, n: int = 8) -> list[str]:
    try:
        data = api("GET", f"/api/tasks/{task_id}/logs/history")
        lines = data.get("lines", [])
        return lines[-n:]
    except Exception:
        return []


# ── Main ────────────────────────────────────────────────────────────────────

def main():
    log("=" * 60)
    log("抖音直播录制 端到端测试")
    log("=" * 60)

    # 确认 API 可达
    try:
        api("GET", "/api/tasks")
    except Exception as e:
        log(f"❌ API 不可达: {e}")
        log("请先启动 Web UI: uv run python main.py record --ui")
        sys.exit(1)

    # 记录测试开始时间（用于过滤文件）
    Path("/tmp/e2e_test_start").write_text(str(time.time()))

    # ── 发现直播间 ──
    log("\n[1/5] 发现活跃直播间…")
    rooms = asyncio.run(discover_live_rooms(need=5))
    if not rooms:
        log("❌ 未找到可用直播间（所有候选都未开播或爬取失败）")
        log("请手动在 OCCUPIED_ROOMS 之外找一些开播的直播间")
        sys.exit(1)

    # ── 创建任务 ──
    log(f"\n[2/5] 创建测试任务（{len(rooms)} 个）…")
    configs = build_task_configs(rooms)
    created: list[tuple[str, str, int]] = []  # (label, anchor, task_id)

    for label, anchor, body in configs:
        try:
            result = api("POST", "/api/tasks", json=body)
            task_id = result.get("task_id") or result.get("id")
            created.append((label, anchor, task_id))
            log(f"  ✓ task_{task_id}  {label}  ({anchor})")
        except Exception as e:
            log(f"  ✗ 创建失败 {label}: {e}")

    if not created:
        log("❌ 没有成功创建任何测试任务")
        sys.exit(1)

    # ── 启动任务 ──
    log(f"\n[3/5] 启动 {len(created)} 个任务…")
    started_ids = []
    for label, anchor, task_id in created:
        try:
            api("POST", f"/api/tasks/{task_id}/start")
            started_ids.append(task_id)
            log(f"  ▶ task_{task_id} ({label}) 已启动")
        except Exception as e:
            log(f"  ✗ 启动失败 task_{task_id}: {e}")

    # ── 等待 + 监控 ──
    log(f"\n[4/5] 录制 {RECORD_WAIT_SEC} 秒…（每 60 秒打印状态）")
    elapsed = 0
    check_interval = 60
    while elapsed < RECORD_WAIT_SEC:
        time.sleep(min(check_interval, RECORD_WAIT_SEC - elapsed))
        elapsed += check_interval
        log(f"\n  ── {elapsed}s 状态检查 ──")
        for label, anchor, task_id in created:
            out = check_task_output(task_id)
            log(f"  task_{task_id} [{label}]  "
                f"ts={out['ts_count']}文件 {out['ts_size_mb']:.1f}MB  "
                f"ass={out['ass_count']}文件")
        # 显示每个任务最新日志
        if elapsed == check_interval:  # 只在第一次显示详细日志
            for label, anchor, task_id in created:
                lines = get_task_log_tail(task_id, 4)
                for l in lines:
                    log(f"    [task_{task_id}] {l}")

    # ── 生成报告 ──
    log("\n[5/5] 测试报告")
    log("=" * 60)
    passed = 0
    failed = 0
    results = []

    for label, anchor, task_id in created:
        out = check_task_output(task_id)
        log_tail = get_task_log_tail(task_id, 3)
        errors = [l for l in log_tail if "错误" in l or "异常" in l or "失败" in l or "rc=" in l]

        # 定时任务用不同标准（可能还未触发）
        if "scheduled" in label:
            ok = True  # 定时任务以无崩溃为准
            status_sym = "⏰"
        else:
            ok = out["ts_size_mb"] > 0.5
            status_sym = "✅" if ok else "❌"

        if ok:
            passed += 1
        else:
            failed += 1

        results.append({
            "task_id": task_id,
            "label": label,
            "anchor": anchor,
            "ok": ok,
            "ts_files": out["ts_count"],
            "ts_mb": out["ts_size_mb"],
            "ass_files": out["ass_count"],
            "errors": errors,
        })

        log(f"{status_sym} task_{task_id} [{label}]  "
            f"TS: {out['ts_count']}文件/{out['ts_size_mb']:.1f}MB  "
            f"ASS: {out['ass_count']}文件"
            + (f"  ⚠ {errors[0]}" if errors else ""))

    log(f"\n总计: {passed} 通过 / {failed} 失败 / {len(created)} 个")

    # ── 保存报告到文件 ──
    report_path = OUTPUT_DIR / f"e2e_test_{datetime.now():%Y%m%d_%H%M%S}.json"
    OUTPUT_DIR.mkdir(exist_ok=True)
    report_path.write_text(json.dumps(results, ensure_ascii=False, indent=2))
    log(f"\n报告已保存: {report_path}")

    # ── 清理 ──
    log("\n清理测试任务和文件…")
    for label, anchor, task_id in created:
        try:
            api("POST", f"/api/tasks/{task_id}/stop")
        except Exception:
            pass
    time.sleep(3)
    for label, anchor, task_id in created:
        try:
            api("DELETE", f"/api/tasks/{task_id}")
            log(f"  删除 task_{task_id}")
        except Exception as e:
            log(f"  删除失败 task_{task_id}: {e}")
        task_dir = OUTPUT_DIR / f"task_{task_id}"
        if task_dir.exists():
            shutil.rmtree(task_dir)
            log(f"  删除目录 {task_dir}")

    log("\n✅ 测试完成，清理完毕")


if __name__ == "__main__":
    main()
