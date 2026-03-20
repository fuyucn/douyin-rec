"""测试 Web UI API 端点"""

import importlib
import tempfile
import pytest
from pathlib import Path
from unittest.mock import patch

fastapi_available = importlib.util.find_spec("fastapi") is not None
pytestmark = pytest.mark.skipif(
    not fastapi_available,
    reason="fastapi not installed (install with: uv sync --extra ui)",
)

if fastapi_available:
    from fastapi.testclient import TestClient
    import src.ui.app as app_module
    from src.task_manager import TaskManager


@pytest.fixture
def client(tmp_path):
    """用临时 DB 创建测试客户端"""
    db_path = str(tmp_path / "test_tasks.db")
    tm = TaskManager(db_path=db_path)
    app_module.task_manager = tm
    return TestClient(app_module.app)


def test_index(client):
    """首页返回 HTML"""
    r = client.get("/")
    assert r.status_code == 200
    assert "直播录制控制台" in r.text


def test_list_tasks_empty(client):
    """初始任务列表为空"""
    r = client.get("/api/tasks")
    assert r.status_code == 200
    assert r.json()["tasks"] == []


def test_create_task(client):
    """创建任务"""
    r = client.post("/api/tasks", json={
        "url": "https://live.douyin.com/123",
        "quality": "hd",
        "segment": 15,
        "record": True,
        "screenshot": True,
    })
    assert r.status_code == 200
    assert r.json()["ok"] is True
    assert r.json()["task_id"] is not None


def test_create_task_no_url(client):
    """缺少 URL 返回 400"""
    r = client.post("/api/tasks", json={"url": ""})
    assert r.status_code == 400
    assert "URL" in r.json()["error"]


def test_create_task_no_features(client):
    """未启用功能返回 400"""
    r = client.post("/api/tasks", json={
        "url": "https://live.douyin.com/123",
        "record": False,
        "screenshot": False,
    })
    assert r.status_code == 400


def test_list_tasks_after_create(client):
    """创建后列出任务"""
    client.post("/api/tasks", json={"url": "https://live.douyin.com/111"})
    client.post("/api/tasks", json={"url": "https://live.douyin.com/222"})
    r = client.get("/api/tasks")
    tasks = r.json()["tasks"]
    assert len(tasks) == 2
    assert tasks[0]["url"] == "https://live.douyin.com/111"
    assert tasks[1]["url"] == "https://live.douyin.com/222"


def test_delete_task(client):
    """删除任务"""
    r = client.post("/api/tasks", json={"url": "https://live.douyin.com/123"})
    task_id = r.json()["task_id"]
    r = client.delete(f"/api/tasks/{task_id}")
    assert r.status_code == 200
    assert r.json()["ok"] is True
    # 确认已删除
    r = client.get("/api/tasks")
    assert len(r.json()["tasks"]) == 0


def test_delete_nonexistent_task(client):
    """删除不存在的任务"""
    r = client.delete("/api/tasks/999")
    assert r.status_code == 404


def test_start_nonexistent_task(client):
    """启动不存在的任务"""
    r = client.post("/api/tasks/999/start")
    assert r.status_code == 409


def test_stop_nonexistent_task(client):
    """停止不存在的任务"""
    r = client.post("/api/tasks/999/stop")
    assert r.status_code == 404


def test_preview_toggle(client):
    """预览切换"""
    r = client.post("/api/tasks", json={"url": "https://live.douyin.com/123"})
    task_id = r.json()["task_id"]

    # 开启预览
    r = client.post(f"/api/tasks/{task_id}/preview")
    assert r.status_code == 200
    assert r.json()["previewing"] is True

    # 关闭预览 (再次点击)
    r = client.post(f"/api/tasks/{task_id}/preview")
    assert r.status_code == 200
    assert r.json()["previewing"] is False


def test_preview_nonexistent_task(client):
    """预览不存在的任务"""
    r = client.post("/api/tasks/999/preview")
    assert r.status_code == 404


def test_get_task_detail(client):
    """获取单个任务详情"""
    r = client.post("/api/tasks", json={
        "url": "https://live.douyin.com/123",
        "quality": "uhd",
        "segment": 60,
        "record": True,
        "screenshot": True,
    })
    task_id = r.json()["task_id"]
    r = client.get(f"/api/tasks/{task_id}")
    assert r.status_code == 200
    t = r.json()
    assert t["id"] == task_id
    assert t["url"] == "https://live.douyin.com/123"
    assert t["quality"] == "uhd"
    assert t["segment_min"] == 60
    assert t["enable_record"] is True
    assert t["enable_screenshot"] is True
    assert t["status"] == "pending"
    assert t["created_at"] is not None


def test_get_task_detail_not_found(client):
    """获取不存在的任务返回 404"""
    r = client.get("/api/tasks/999")
    assert r.status_code == 404


def test_task_fields(client):
    """任务字段完整性"""
    client.post("/api/tasks", json={
        "url": "https://live.douyin.com/123",
        "quality": "uhd",
        "segment": 60,
        "record": True,
        "screenshot": True,
    })
    r = client.get("/api/tasks")
    t = r.json()["tasks"][0]
    assert t["quality"] == "uhd"
    assert t["segment_min"] == 60
    assert t["enable_record"] is True
    assert t["enable_screenshot"] is True
    assert t["status"] == "pending"
    assert t["created_at"] is not None


# ── 本地视频 API 测试 ────────────────────────────────────────


def test_list_local_tasks_empty(client):
    """初始本地任务列表为空"""
    r = client.get("/api/local/tasks")
    assert r.status_code == 200
    assert r.json()["tasks"] == []


def test_create_local_task(client, tmp_path):
    """创建本地视频任务"""
    video = tmp_path / "test.mp4"
    video.touch()
    r = client.post("/api/local/tasks", json={
        "video_path": str(video),
        "task_type": "portrait",
    })
    assert r.status_code == 200
    assert r.json()["ok"] is True
    assert r.json()["task_id"] is not None


def test_create_local_task_no_path(client):
    """缺少路径返回 400"""
    r = client.post("/api/local/tasks", json={"video_path": ""})
    assert r.status_code == 400


def test_create_local_task_file_not_found(client):
    """文件不存在返回 400"""
    r = client.post("/api/local/tasks", json={
        "video_path": "/nonexistent/video.mp4",
        "task_type": "portrait",
    })
    assert r.status_code == 400
    assert "不存在" in r.json()["error"]


def test_create_local_task_invalid_type(client, tmp_path):
    """无效任务类型返回 400"""
    video = tmp_path / "test.mp4"
    video.touch()
    r = client.post("/api/local/tasks", json={
        "video_path": str(video),
        "task_type": "invalid",
    })
    assert r.status_code == 400


def test_list_local_tasks_after_create(client, tmp_path):
    """创建后列出本地任务"""
    v1 = tmp_path / "a.mp4"
    v2 = tmp_path / "b.mp4"
    v1.touch()
    v2.touch()
    client.post("/api/local/tasks", json={"video_path": str(v1), "task_type": "portrait"})
    client.post("/api/local/tasks", json={"video_path": str(v2), "task_type": "highlight"})
    r = client.get("/api/local/tasks")
    tasks = r.json()["tasks"]
    assert len(tasks) == 2
    assert tasks[0]["task_type"] == "portrait"
    assert tasks[1]["task_type"] == "highlight"


def test_get_local_task_detail(client, tmp_path):
    """获取单个本地任务详情"""
    video = tmp_path / "test.mp4"
    video.touch()
    r = client.post("/api/local/tasks", json={
        "video_path": str(video),
        "task_type": "portrait",
    })
    task_id = r.json()["task_id"]
    r = client.get(f"/api/local/tasks/{task_id}")
    assert r.status_code == 200
    t = r.json()
    assert t["id"] == task_id
    assert t["task_type"] == "portrait"
    assert t["name"] == "test"
    assert t["status"] == "pending"
    assert t["progress"] == 0.0


def test_get_local_task_not_found(client):
    """获取不存在的本地任务返回 404"""
    r = client.get("/api/local/tasks/999")
    assert r.status_code == 404


def test_delete_local_task(client, tmp_path):
    """删除本地任务"""
    video = tmp_path / "test.mp4"
    video.touch()
    r = client.post("/api/local/tasks", json={"video_path": str(video), "task_type": "portrait"})
    task_id = r.json()["task_id"]
    r = client.delete(f"/api/local/tasks/{task_id}")
    assert r.status_code == 200
    assert r.json()["ok"] is True
    r = client.get("/api/local/tasks")
    assert len(r.json()["tasks"]) == 0


def test_delete_local_task_not_found(client):
    """删除不存在的本地任务返回 404"""
    r = client.delete("/api/local/tasks/999")
    assert r.status_code == 404


def test_start_local_task_not_found(client):
    """启动不存在的本地任务"""
    r = client.post("/api/local/tasks/999/start")
    assert r.status_code == 409


def test_stop_local_task_not_found(client):
    """停止不存在的本地任务"""
    r = client.post("/api/local/tasks/999/stop")
    assert r.status_code == 404


# ── /api/tasks/{id}/segments — exclude_last 仅在 DLR 录制中生效 ───────────────

@pytest.fixture
def client_with_segments(tmp_path):
    """带一个任务的测试客户端，在 tmp_path 下准备 3 个假 TS 分段文件"""
    db_path = str(tmp_path / "test_tasks.db")
    tm = TaskManager(db_path=db_path)
    app_module.task_manager = tm
    client = TestClient(app_module.app)

    r = client.post("/api/tasks", json={"url": "https://live.douyin.com/123"})
    task_id = r.json()["task_id"]

    # 在 tmp_path 下建 3 个假 TS 分段，mock _recording_dir 返回此目录
    output_dir = tmp_path / "segs"
    output_dir.mkdir()
    for i in range(3):
        (output_dir / f"task1_主播_2026-03-18_08-00-00_{i:03d}.ts").touch()

    return client, task_id, output_dir, tm


def test_segments_exclude_last_when_recording(client_with_segments):
    """task status=running 且 worker_status='运行中（DLR）'時，最后一段被排除"""
    client, task_id, output_dir, tm = client_with_segments
    tm._update_task_status(task_id, "running")
    with patch("src.ui.app._recording_dir", return_value=output_dir), \
         patch.object(tm, "get_worker_status", return_value="运行中（DLR）"):
        r = client.get(f"/api/tasks/{task_id}/segments")
    assert r.status_code == 200
    data = r.json()
    assert data["is_running"] is True
    assert len(data["groups"]) == 1
    assert data["groups"][0]["segment_count"] == 2  # 3 段减去最后一段


def test_segments_include_last_when_waiting(client_with_segments):
    """task status=running 但 worker_status='等待开播'时，所有段可见"""
    client, task_id, output_dir, tm = client_with_segments
    tm._update_task_status(task_id, "running")
    with patch("src.ui.app._recording_dir", return_value=output_dir), \
         patch.object(tm, "get_worker_status", return_value="等待开播"):
        r = client.get(f"/api/tasks/{task_id}/segments")
    assert r.status_code == 200
    data = r.json()
    assert data["is_running"] is False
    assert data["groups"][0]["segment_count"] == 3  # 全部 3 段可见


def test_segments_include_last_when_schedule_wait(client_with_segments):
    """定时等待状态也不排除最后段"""
    client, task_id, output_dir, tm = client_with_segments
    tm._update_task_status(task_id, "running")
    with patch("src.ui.app._recording_dir", return_value=output_dir), \
         patch.object(tm, "get_worker_status", return_value="定时等待"):
        r = client.get(f"/api/tasks/{task_id}/segments")
    assert r.status_code == 200
    assert r.json()["is_running"] is False
    assert r.json()["groups"][0]["segment_count"] == 3


def test_segments_include_last_when_stopped(client_with_segments):
    """任务 stopped 时所有段可见"""
    client, task_id, output_dir, tm = client_with_segments
    with patch("src.ui.app._recording_dir", return_value=output_dir), \
         patch.object(tm, "get_worker_status", return_value=""):
        r = client.get(f"/api/tasks/{task_id}/segments")
    assert r.status_code == 200
    assert r.json()["is_running"] is False
    assert r.json()["groups"][0]["segment_count"] == 3


def test_segments_no_output_dir(client, tmp_path):
    """输出目录不存在时返回空 groups"""
    r = client.post("/api/tasks", json={"url": "https://live.douyin.com/999"})
    task_id = r.json()["task_id"]
    nonexistent = tmp_path / "nonexistent"
    with patch("src.ui.app._recording_dir", return_value=nonexistent):
        r = client.get(f"/api/tasks/{task_id}/segments")
    assert r.status_code == 200
    assert r.json()["groups"] == []
