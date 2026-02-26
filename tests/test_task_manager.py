"""测试任务管理器"""

import tempfile
import pytest
from pathlib import Path

from src.task_manager import TaskManager


@pytest.fixture
def tm(tmp_path):
    """创建使用临时 DB 的 TaskManager"""
    db_path = str(tmp_path / "test_tasks.db")
    return TaskManager(db_path=db_path)


def test_create_task(tm):
    """创建任务"""
    task = tm.create_task(
        url="https://live.douyin.com/123",
        quality="hd",
        segment_min=15,
        enable_record=True,
        enable_screenshot=True,
    )
    assert task.id is not None
    assert task.url == "https://live.douyin.com/123"
    assert task.quality == "hd"
    assert task.segment_min == 15
    assert task.enable_record is True
    assert task.enable_screenshot is True
    assert task.status == "pending"


def test_list_tasks(tm):
    """列出任务"""
    tm.create_task(url="https://live.douyin.com/111")
    tm.create_task(url="https://live.douyin.com/222")
    tasks = tm.list_tasks()
    assert len(tasks) == 2
    assert tasks[0].url == "https://live.douyin.com/111"
    assert tasks[1].url == "https://live.douyin.com/222"


def test_get_task(tm):
    """获取单个任务"""
    created = tm.create_task(url="https://live.douyin.com/123")
    task = tm.get_task(created.id)
    assert task is not None
    assert task.url == "https://live.douyin.com/123"


def test_get_task_not_found(tm):
    """获取不存在的任务"""
    assert tm.get_task(999) is None


def test_delete_task(tm):
    """删除任务"""
    task = tm.create_task(url="https://live.douyin.com/123")
    assert tm.delete_task(task.id) is True
    assert tm.get_task(task.id) is None


def test_delete_nonexistent_task(tm):
    """删除不存在的任务"""
    assert tm.delete_task(999) is False


def test_delete_running_task(tm):
    """不能删除运行中的任务"""
    task = tm.create_task(url="https://live.douyin.com/123")
    tm._update_task_status(task.id, "running")
    assert tm.delete_task(task.id) is False


def test_create_task_defaults(tm):
    """创建任务默认值"""
    task = tm.create_task(url="https://live.douyin.com/123")
    assert task.quality == "origin"
    assert task.segment_min == 30
    assert task.enable_record is True
    assert task.enable_screenshot is False
    assert task.status == "pending"
    assert task.name is None
    assert task.cookies is None


def test_update_task_status(tm):
    """更新任务状态"""
    task = tm.create_task(url="https://live.douyin.com/123")
    tm._update_task_status(task.id, "running")
    updated = tm.get_task(task.id)
    assert updated.status == "running"


def test_update_task_stopped(tm):
    """停止任务会设置 stopped_at"""
    task = tm.create_task(url="https://live.douyin.com/123")
    tm._update_task_status(task.id, "stopped")
    updated = tm.get_task(task.id)
    assert updated.status == "stopped"
    assert updated.stopped_at is not None


def test_update_task_name(tm):
    """更新任务名称"""
    task = tm.create_task(url="https://live.douyin.com/123")
    tm._update_task_name(task.id, "主播小花")
    updated = tm.get_task(task.id)
    assert updated.name == "主播小花"


def test_recover_running_tasks(tmp_path):
    """重启后 running 状态恢复为 stopped"""
    db_path = str(tmp_path / "test_tasks.db")
    tm1 = TaskManager(db_path=db_path)
    task = tm1.create_task(url="https://live.douyin.com/123")
    tm1._update_task_status(task.id, "running")

    # 模拟重启
    tm2 = TaskManager(db_path=db_path)
    recovered = tm2.get_task(task.id)
    assert recovered.status == "stopped"


def test_preview_control(tm):
    """预览控制"""
    assert tm.get_preview_task_id() is None
    tm.set_preview(1)
    assert tm.get_preview_task_id() == 1
    tm.set_preview(None)
    assert tm.get_preview_task_id() is None


def test_preview_frame_no_worker(tm):
    """没有 worker 时预览帧为 None"""
    tm.set_preview(999)
    assert tm.get_preview_frame() is None


def test_start_nonexistent_task(tm):
    """启动不存在的任务"""
    with pytest.raises(ValueError, match="不存在"):
        tm.start_task(999)


def test_broadcast(tm):
    """日志广播"""
    q = tm.add_log_queue()
    tm.broadcast("测试消息", task_name="测试")
    line = q.get_nowait()
    assert "[测试]" in line
    assert "测试消息" in line
    tm.remove_log_queue(q)


def test_log_queue_full(tm):
    """日志队列满时不阻塞"""
    import queue
    q = queue.Queue(maxsize=1)
    tm._log_queues.append(q)
    q.put("占位")
    # 应该不会阻塞
    tm.broadcast("第二条消息")
    # 满的队列会被移除
    assert q not in tm._log_queues
