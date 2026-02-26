"""FastAPI 多任务录制控制界面 — SSE 实时日志推送"""

from __future__ import annotations

import asyncio
import logging
from pathlib import Path

from fastapi import FastAPI, Request
from fastapi.responses import HTMLResponse, JSONResponse
from fastapi.staticfiles import StaticFiles
from starlette.responses import StreamingResponse

from src.task_manager import TaskManager

logger = logging.getLogger(__name__)

app = FastAPI(title="直播录制控制台")
app.mount("/static", StaticFiles(directory=Path(__file__).parent / "static"), name="static")

# ── 全局 TaskManager 实例 ────────────────────────────────────────────────
task_manager = TaskManager()


# ── HTML 页面 ─────────────────────────────────────────────────────────────

@app.get("/", response_class=HTMLResponse)
async def index():
    html = (Path(__file__).parent / "static" / "index.html").read_text(encoding="utf-8")
    return HTMLResponse(html)


# ── 任务 CRUD API ─────────────────────────────────────────────────────────

@app.get("/api/tasks")
async def list_tasks():
    tasks = task_manager.list_tasks()
    result = []
    for t in tasks:
        worker_status = task_manager.get_worker_status(t.id)
        result.append({
            "id": t.id,
            "url": t.url,
            "name": t.name,
            "quality": t.quality,
            "segment_min": t.segment_min,
            "enable_record": t.enable_record,
            "enable_screenshot": t.enable_screenshot,
            "status": t.status,
            "error_msg": t.error_msg,
            "worker_status": worker_status,
            "created_at": t.created_at.isoformat() if t.created_at else None,
            "stopped_at": t.stopped_at.isoformat() if t.stopped_at else None,
            "is_previewing": task_manager.get_preview_task_id() == t.id,
        })
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
    )
    return {"ok": True, "task_id": task.id}


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
