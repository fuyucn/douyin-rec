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
