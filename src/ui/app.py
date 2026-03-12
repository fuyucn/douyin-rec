"""FastAPI 多任务录制控制界面 — SSE 实时日志推送"""

from __future__ import annotations

import asyncio
import logging
import platform
import re
import subprocess
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.responses import StreamingResponse

from src.config import load_config
from src.task_manager import LOCAL_ID_OFFSET, TaskManager, task_dir_name

logger = logging.getLogger(__name__)

app = FastAPI(title="直播录制控制台")
app.mount("/static", StaticFiles(directory=Path(__file__).parent / "static"), name="static")

# ── 全局 TaskManager 实例 ────────────────────────────────────────────────
_config = load_config()
task_manager = TaskManager(output_dir=_config.storage.output_dir)


# ── HTML 页面 ─────────────────────────────────────────────────────────────

@app.get("/", response_class=HTMLResponse)
async def index():
    html = (Path(__file__).parent / "static" / "index.html").read_text(encoding="utf-8")
    return HTMLResponse(html)


# ── 序列化 ────────────────────────────────────────────────────────────────

def _task_output_dir(t) -> str:
    """计算任务对应的输出子目录绝对路径（与 task_manager 保持一致）"""
    return str(Path(_config.storage.output_dir).resolve() / task_dir_name(t.id, t.name))


def _serialize_task(t, worker_status: str = "", recording_started_at: str | None = None) -> dict:
    return {
        "id": t.id,
        "url": t.url,
        "name": t.name,
        "custom_name": t.custom_name,
        "quality": t.quality,
        "segment_min": t.segment_min,
        "enable_record": t.enable_record,
        "enable_screenshot": t.enable_screenshot,
        "enable_danmu": t.enable_danmu,
        "auto_quality_fallback": t.auto_quality_fallback,
        "enable_segment": t.enable_segment,
        "segment_sec": t.segment_sec,
        "poll_interval": t.poll_interval,
        "show_countdown": t.show_countdown,
        "max_threads": t.max_threads,
        "schedule_enabled": t.schedule_enabled,
        "schedule_timezone": t.schedule_timezone,
        "schedule_start": t.schedule_start,
        "schedule_stop": t.schedule_stop,
        "schedule_run_until_end": t.schedule_run_until_end,
        "status": t.status,
        "error_msg": t.error_msg,
        "worker_status": worker_status,
        "created_at": t.created_at.isoformat() if t.created_at else None,
        "started_at": t.started_at.isoformat() if t.started_at else None,
        "stopped_at": t.stopped_at.isoformat() if t.stopped_at else None,
        "recording_started_at": recording_started_at,
        "output_dir": _task_output_dir(t),
        "is_previewing": task_manager.get_preview_task_id() == t.id,
    }


# ── 文件浏览 API ─────────────────────────────────────────────────────────

VIDEO_EXTENSIONS = {".mp4", ".mkv", ".avi", ".mov", ".flv", ".ts", ".webm", ".m4v", ".wmv", ".mpg", ".mpeg"}


@app.get("/api/browse")
async def browse_files(path: str = "~"):
    """浏览本地文件系统，返回目录和视频文件列表"""
    try:
        target = Path(path).expanduser().resolve()
    except Exception:
        return JSONResponse({"error": "无效路径"}, status_code=400)

    if not target.exists():
        return JSONResponse({"error": "路径不存在"}, status_code=404)

    if target.is_file():
        # 直接返回文件信息
        return {"path": str(target), "is_file": True}

    dirs = []
    files = []
    try:
        for entry in sorted(target.iterdir(), key=lambda e: e.name.lower()):
            if entry.name.startswith("."):
                continue
            if entry.is_dir():
                dirs.append({"name": entry.name, "path": str(entry)})
            elif entry.is_file() and entry.suffix.lower() in VIDEO_EXTENSIONS:
                size_mb = entry.stat().st_size / (1024 * 1024)
                files.append({"name": entry.name, "path": str(entry), "size": f"{size_mb:.1f} MB"})
    except PermissionError:
        return JSONResponse({"error": "无权限访问"}, status_code=403)

    parent = str(target.parent) if target.parent != target else None
    return {"current": str(target), "parent": parent, "dirs": dirs, "files": files}


# ── 打开目录 API ──────────────────────────────────────────────────────────

@app.post("/api/open-folder")
async def open_folder(request: Request):
    """在系统文件管理器中打开指定目录（仅限 output_dir 内）"""
    body = await request.json()
    raw_path = body.get("path", "").strip()
    if not raw_path:
        return JSONResponse({"error": "路径为空"}, status_code=400)

    target = Path(raw_path).expanduser().resolve()
    allowed = Path(_config.storage.output_dir).expanduser().resolve()
    try:
        target.relative_to(allowed)
    except ValueError:
        return JSONResponse({"error": "不允许访问此目录"}, status_code=403)

    target.mkdir(parents=True, exist_ok=True)
    try:
        system = platform.system()
        if system == "Darwin":
            subprocess.Popen(["open", str(target)])
        elif system == "Windows":
            subprocess.Popen(["explorer", str(target)])
        else:
            subprocess.Popen(["xdg-open", str(target)])
    except Exception as e:
        return JSONResponse({"error": str(e)}, status_code=500)
    return {"ok": True}


# ── 任务 CRUD API ─────────────────────────────────────────────────────────

@app.get("/api/tasks")
async def list_tasks():
    tasks = task_manager.list_tasks()
    result = []
    for t in tasks:
        worker_status = task_manager.get_worker_status(t.id)
        recording_started_at = task_manager.get_worker_recording_started_at(t.id)
        result.append(_serialize_task(t, worker_status, recording_started_at))
    return {"tasks": result}


@app.post("/api/tasks")
async def create_task(request: Request):
    body = await request.json()
    url = body.get("url", "").strip()
    if not url:
        return JSONResponse({"error": "请输入直播间 URL"}, status_code=400)

    enable_record = body.get("record", True)
    enable_screenshot = body.get("screenshot", False)
    if not enable_record and not enable_screenshot:
        return JSONResponse({"error": "请至少启用录制或截图"}, status_code=400)

    task = task_manager.create_task(
        url=url,
        name=body.get("name"),
        quality=body.get("quality", "origin"),
        segment_min=int(body.get("segment", 30)),
        enable_record=enable_record,
        enable_screenshot=enable_screenshot,
        cookies=body.get("cookies"),
        enable_danmu=body.get("enable_danmu", False),
        danmu_cdn_delay=int(body.get("danmu_cdn_delay", 6)),
        auto_quality_fallback=body.get("auto_quality_fallback", False),
        enable_segment=body.get("enable_segment", True),
        segment_sec=int(body.get("segment_sec", 1800)),
        poll_interval=int(body.get("poll_interval", 180)),
        show_countdown=body.get("show_countdown", True),
        max_threads=int(body.get("max_threads", 3)),
        schedule_enabled=body.get("schedule_enabled", False),
        schedule_timezone=body.get("schedule_timezone", "Asia/Shanghai"),
        schedule_start=body.get("schedule_start", "00:00"),
        schedule_stop=body.get("schedule_stop", "23:59"),
        schedule_run_until_end=body.get("schedule_run_until_end", False),
        custom_name=body.get("custom_name") or None,
    )
    return {"ok": True, "task_id": task.id}


@app.get("/api/tasks/{task_id}")
async def get_task(task_id: int):
    t = task_manager.get_task(task_id)
    if t is None:
        return JSONResponse({"error": "任务不存在"}, status_code=404)
    worker_status = task_manager.get_worker_status(t.id)
    recording_started_at = task_manager.get_worker_recording_started_at(t.id)
    return _serialize_task(t, worker_status, recording_started_at)


@app.delete("/api/tasks/{task_id}")
async def delete_task(task_id: int):
    task = task_manager.get_task(task_id)
    if task is None:
        return JSONResponse({"error": "任务不存在"}, status_code=404)
    if task.status == "running":
        return JSONResponse({"error": "不能删除运行中的任务"}, status_code=409)
    ok = task_manager.delete_task(task_id)
    if not ok:
        return JSONResponse({"error": "删除失败"}, status_code=500)
    return {"ok": True}


# ── 任务执行控制 API ──────────────────────────────────────────────────────

@app.post("/api/tasks/{task_id}/start")
async def start_task(task_id: int):
    try:
        task_manager.start_task(task_id)
    except ValueError as e:
        return JSONResponse({"error": str(e)}, status_code=409)
    return {"ok": True}


@app.post("/api/tasks/{task_id}/stop")
async def stop_task(task_id: int):
    task = task_manager.get_task(task_id)
    if task is None:
        return JSONResponse({"error": "任务不存在"}, status_code=404)
    task_manager.stop_task(task_id)
    return {"ok": True}


# ── 预览控制 API ─────────────────────────────────────────────────────────

@app.post("/api/tasks/{task_id}/preview")
async def set_preview(task_id: int):
    task = task_manager.get_task(task_id)
    if task is None:
        return JSONResponse({"error": "任务不存在"}, status_code=404)
    # 如果已经在预览这个任务，关闭预览
    if task_manager.get_preview_task_id() == task_id:
        task_manager.set_preview(None)
        return {"ok": True, "previewing": False}
    task_manager.set_preview(task_id)
    return {"ok": True, "previewing": True}


@app.get("/api/preview")
async def preview_mjpeg():
    """MJPEG 流 — 持续推送当前选中任务的画面帧"""
    BOUNDARY = b"--frame\r\n"

    async def mjpeg_stream():
        while True:
            frame = task_manager.get_preview_frame()
            if frame is not None:
                yield (
                    BOUNDARY
                    + b"Content-Type: image/jpeg\r\n"
                    + f"Content-Length: {len(frame)}\r\n".encode()
                    + b"\r\n"
                    + frame
                    + b"\r\n"
                )
            await asyncio.sleep(0.2)

    return StreamingResponse(
        mjpeg_stream(),
        media_type="multipart/x-mixed-replace; boundary=frame",
    )


# ── SSE 日志流 ─────────────────────────────────────────────────────────────

@app.get("/api/logs")
async def logs_sse():
    """SSE 端点 — 持续推送日志行"""
    q = task_manager.add_log_queue()

    async def event_stream():
        try:
            while True:
                try:
                    line = q.get_nowait()
                    yield f"data: {line}\n\n"
                except Exception:
                    await asyncio.sleep(0.3)
        finally:
            task_manager.remove_log_queue(q)

    return StreamingResponse(event_stream(), media_type="text/event-stream")


@app.get("/api/tasks/{task_id}/logs/history")
async def task_logs_history(task_id: int):
    """返回任务的历史日志"""
    t = task_manager.get_task(task_id)
    if t is None:
        return JSONResponse({"error": "任务不存在"}, status_code=404)
    lines = task_manager.get_task_log_lines(task_id)
    return {"lines": lines}



@app.get("/api/tasks/{task_id}/logs")
async def task_logs_sse(task_id: int):
    """SSE 端点 — 推送指定任务的日志"""
    t = task_manager.get_task(task_id)
    if t is None:
        return JSONResponse({"error": "任务不存在"}, status_code=404)

    q = task_manager.add_log_queue(task_id=task_id)

    async def event_stream():
        try:
            while True:
                try:
                    line = q.get_nowait()
                    yield f"data: {line}\n\n"
                except Exception:
                    await asyncio.sleep(0.3)
        finally:
            task_manager.remove_log_queue(q)

    return StreamingResponse(event_stream(), media_type="text/event-stream")


# ── AI 后端 API ──────────────────────────────────────────────────────────

@app.get("/api/ai/backends")
async def get_ai_backends():
    """返回各 AI 后端可用状态（不暴露 key 内容）"""
    import os
    config = load_config()
    ai = config.ai
    return {
        "default": ai.default_backend,
        "backends": [
            {
                "id": "ollama",
                "label": "Ollama（本地）",
                "local": True,
                "available": True,
                "model": ai.ollama_model,
            },
            {
                "id": "claude",
                "label": "Claude",
                "local": False,
                "available": bool(ai.anthropic_api_key or os.environ.get("ANTHROPIC_API_KEY")),
            },
            {
                "id": "gemini",
                "label": "Gemini",
                "local": False,
                "available": bool(ai.google_api_key or os.environ.get("GOOGLE_API_KEY")),
            },
            {
                "id": "gpt4o",
                "label": "GPT-4o",
                "local": False,
                "available": bool(ai.openai_api_key or os.environ.get("OPENAI_API_KEY")),
            },
        ],
    }


# ── 本地视频任务 API ─────────────────────────────────────────────────────

def _serialize_local_task(t) -> dict:
    return {
        "id": t.id,
        "video_path": t.video_path,
        "name": t.name,
        "task_type": t.task_type,
        "status": t.status,
        "error_msg": t.error_msg,
        "progress": t.progress,
        "progress_text": t.progress_text,
        "result_summary": t.result_summary,
        "ai_backend": t.ai_backend,
        "created_at": t.created_at.isoformat() if t.created_at else None,
        "finished_at": t.finished_at.isoformat() if t.finished_at else None,
    }


@app.get("/api/local/tasks")
async def list_local_tasks():
    tasks = task_manager.list_local_tasks()
    return {"tasks": [_serialize_local_task(t) for t in tasks]}


@app.post("/api/local/tasks")
async def create_local_task(request: Request):
    body = await request.json()
    video_path = body.get("video_path", "").strip()
    if not video_path:
        return JSONResponse({"error": "请输入视频文件路径"}, status_code=400)

    task_type = body.get("task_type", "portrait")
    if task_type not in ("portrait", "highlight"):
        return JSONResponse({"error": "无效的任务类型"}, status_code=400)

    ai_backend = body.get("ai_backend") or None
    try:
        task = task_manager.create_local_task(
            video_path=video_path,
            task_type=task_type,
            name=body.get("name"),
            ai_backend=ai_backend,
        )
    except FileNotFoundError as e:
        return JSONResponse({"error": str(e)}, status_code=400)
    return {"ok": True, "task_id": task.id}


@app.get("/api/local/tasks/{task_id}")
async def get_local_task(task_id: int):
    t = task_manager.get_local_task(task_id)
    if t is None:
        return JSONResponse({"error": "任务不存在"}, status_code=404)
    return _serialize_local_task(t)


@app.delete("/api/local/tasks/{task_id}")
async def delete_local_task(task_id: int):
    task = task_manager.get_local_task(task_id)
    if task is None:
        return JSONResponse({"error": "任务不存在"}, status_code=404)
    if task.status == "running":
        return JSONResponse({"error": "不能删除运行中的任务"}, status_code=409)
    ok = task_manager.delete_local_task(task_id)
    if not ok:
        return JSONResponse({"error": "删除失败"}, status_code=500)
    return {"ok": True}


@app.post("/api/local/tasks/{task_id}/start")
async def start_local_task(task_id: int):
    try:
        task_manager.start_local_task(task_id)
    except (ValueError, FileNotFoundError) as e:
        return JSONResponse({"error": str(e)}, status_code=409)
    return {"ok": True}


@app.post("/api/local/tasks/{task_id}/stop")
async def stop_local_task(task_id: int):
    task = task_manager.get_local_task(task_id)
    if task is None:
        return JSONResponse({"error": "任务不存在"}, status_code=404)
    task_manager.stop_local_task(task_id)
    return {"ok": True}


@app.get("/api/local/tasks/{task_id}/logs")
async def local_task_logs_sse(task_id: int):
    """SSE 端点 — 推送本地任务的日志"""
    t = task_manager.get_local_task(task_id)
    if t is None:
        return JSONResponse({"error": "任务不存在"}, status_code=404)

    log_id = task_id + LOCAL_ID_OFFSET
    q = task_manager.add_log_queue(task_id=log_id)

    async def event_stream():
        try:
            while True:
                try:
                    line = q.get_nowait()
                    yield f"data: {line}\n\n"
                except Exception:
                    await asyncio.sleep(0.3)
        finally:
            task_manager.remove_log_queue(q)

    return StreamingResponse(event_stream(), media_type="text/event-stream")


# ── 录制组合并 API ────────────────────────────────────────────────────────

_merging_prefixes: set[str] = set()  # 防止同一前缀并发重复合并
_merge_results: dict[str, dict] = {}  # lock_key → {"ok": bool, "error": str|None}

_PREFIX_DT_RE = re.compile(r"^.+_(\d{4}-\d{2}-\d{2})_(\d{2}-\d{2}-\d{2})$")


@app.get("/api/tasks/{task_id}/segments")
async def list_segments(task_id: int):
    """返回任务目录下的录制组列表，按日期分组所需的 date/time 字段已解析"""
    t = task_manager.get_task(task_id)
    if t is None:
        return JSONResponse({"error": "任务不存在"}, status_code=404)

    output_dir = Path(_task_output_dir(t))
    if not output_dir.exists():
        return {"groups": []}

    from src.merge.merger import discover_groups
    is_running = (t.status == "running")
    groups = discover_groups(output_dir, exclude_last=is_running)

    result = []
    for g in groups:
        m = _PREFIX_DT_RE.match(g.prefix)
        lk = f"{task_id}:{g.prefix}"
        mr = _merge_results.get(lk)
        result.append({
            "prefix": g.prefix,
            "date": m.group(1) if m else None,
            "time": m.group(2).replace("-", ":") if m else None,
            "segment_count": len(g.ts_files),
            "has_danmu": len(g.ass_map) > 0,
            "merged": g.already_merged,
            "danmu_merged": g.merged_danmu_mp4.exists(),
            "merging": lk in _merging_prefixes,
            "merge_error": mr["error"] if (mr and not mr["ok"] and not g.already_merged) else None,
        })
    return {"groups": result, "is_running": is_running}


@app.post("/api/tasks/{task_id}/merge")
async def merge_segments(task_id: int, request: Request):
    """触发合并（后台线程执行，立即返回，进度通过 SSE 日志流输出）"""
    import threading

    t = task_manager.get_task(task_id)
    if t is None:
        return JSONResponse({"error": "任务不存在"}, status_code=404)

    body = await request.json()
    prefix = body.get("prefix", "").strip()
    do_danmu = body.get("burn_danmu", True)
    overwrite = body.get("overwrite", False)

    if not prefix:
        return JSONResponse({"error": "prefix 不能为空"}, status_code=400)

    lock_key = f"{task_id}:{prefix}"
    if lock_key in _merging_prefixes:
        return JSONResponse({"error": "正在合并中，请稍候"}, status_code=409)

    output_dir = Path(_task_output_dir(t))
    from src.merge.merger import discover_groups, merge_group

    is_running = (t.status == "running")
    groups = discover_groups(output_dir, exclude_last=is_running)
    target = next((g for g in groups if g.prefix == prefix), None)
    if target is None:
        return JSONResponse({"error": f"未找到录制组: {prefix}"}, status_code=404)

    task_name = t.name or f"task{task_id}"

    def _run() -> None:
        _merging_prefixes.add(lock_key)
        try:
            def log_fn(msg: str) -> None:
                task_manager.broadcast(msg, task_name=task_name, task_id=task_id)
            merge_group(target, log_fn=log_fn, do_danmu=do_danmu, overwrite=overwrite)
            _merge_results[lock_key] = {"ok": True, "error": None}
        except Exception as e:
            err = str(e).strip()[:300]
            task_manager.broadcast(f"[合并] 错误: {err}", task_name=task_name, task_id=task_id)
            _merge_results[lock_key] = {"ok": False, "error": err}
        finally:
            _merging_prefixes.discard(lock_key)

    threading.Thread(target=_run, daemon=True).start()
    return {"ok": True, "status": "merging", "message": "合并已启动，请查看日志"}


@app.get("/api/local/tasks/{task_id}/logs/history")
async def local_task_logs_history(task_id: int):
    """返回本地任务的历史日志"""
    t = task_manager.get_local_task(task_id)
    if t is None:
        return JSONResponse({"error": "任务不存在"}, status_code=404)
    log_id = task_id + LOCAL_ID_OFFSET
    lines = task_manager.get_task_log_lines(log_id)
    return {"lines": lines}
