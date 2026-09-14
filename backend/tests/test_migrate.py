"""轻量迁移：为既有（旧结构）数据库补充可空 label / step 列。"""
import os
import sys

os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from fastapi.testclient import TestClient  # noqa: E402
from sqlalchemy import create_engine, inspect, text  # noqa: E402
from sqlalchemy.orm import sessionmaker  # noqa: E402

from app.db import Base, get_db  # noqa: E402
from app.main import app  # noqa: E402
from app.migrate import run_migrations  # noqa: E402

# 旧结构的 windows 表（没有 label 列）
OLD_WINDOWS_SCHEMA = """
CREATE TABLE windows (
    id INTEGER PRIMARY KEY,
    layout_id INTEGER NOT NULL,
    position INTEGER NOT NULL,
    x INTEGER NOT NULL,
    y INTEGER NOT NULL,
    w INTEGER NOT NULL,
    h INTEGER NOT NULL
)
"""

# 旧结构的 layouts 表（没有 step 列）
OLD_LAYOUTS_SCHEMA = """
CREATE TABLE layouts (
    id INTEGER PRIMARY KEY,
    created_at DATETIME,
    verdict VARCHAR(16) NOT NULL,
    result JSON NOT NULL
)
"""


def _make_old_db(path):
    """造一个旧结构的库，并写入一条历史记录。"""
    engine = create_engine(f"sqlite+pysqlite:///{path}")
    with engine.begin() as conn:
        conn.execute(text("DROP TABLE IF EXISTS windows"))
        conn.execute(text("DROP TABLE IF EXISTS layouts"))
        conn.execute(text(OLD_LAYOUTS_SCHEMA))
        conn.execute(text(OLD_WINDOWS_SCHEMA))
        conn.execute(
            text(
                "INSERT INTO layouts (id, created_at, verdict, result) VALUES ("
                "1, '2026-09-01 10:00:00', '可裁切', "
                "'{\"verdict\": \"可裁切\", \"defect_conflicts\": [], "
                "\"window_conflicts\": [], \"conflicting_window_ids\": []}')"
            )
        )
        conn.execute(
            text(
                "INSERT INTO windows (id, layout_id, position, x, y, w, h)"
                " VALUES (1, 1, 0, 300, 300, 100, 80)"
            )
        )
    return engine


def test_migration_adds_nullable_label_column(tmp_path):
    engine = _make_old_db(tmp_path / "old.db")

    # 模拟服务启动：create_all 不会动已存在的旧表，迁移负责补列
    Base.metadata.create_all(bind=engine)
    run_migrations(engine)

    columns = {c["name"]: c for c in inspect(engine).get_columns("windows")}
    assert "label" in columns
    assert columns["label"]["nullable"] is True

    # 旧记录读取时编号为空值
    with engine.connect() as conn:
        row = conn.execute(text("SELECT id, label FROM windows WHERE id = 1")).one()
    assert row == (1, None)


def test_migration_adds_nullable_step_column(tmp_path):
    engine = _make_old_db(tmp_path / "old.db")
    Base.metadata.create_all(bind=engine)
    run_migrations(engine)

    columns = {c["name"]: c for c in inspect(engine).get_columns("layouts")}
    assert "step" in columns
    assert columns["step"]["nullable"] is True

    # 旧记录缺少步长值（NULL），读取时按 1 毫米处理
    with engine.connect() as conn:
        row = conn.execute(text("SELECT id, step FROM layouts WHERE id = 1")).one()
    assert row == (1, None)


def test_migration_adds_nullable_shape_column(tmp_path):
    engine = _make_old_db(tmp_path / "old.db")

    # 模拟服务启动：create_all 不会动已存在的旧表，迁移负责补列
    Base.metadata.create_all(bind=engine)
    run_migrations(engine)

    columns = {c["name"]: c for c in inspect(engine).get_columns("windows")}
    assert "shape" in columns
    assert columns["shape"]["nullable"] is True

    # 旧记录缺少形状值（NULL），读取时按矩形处理
    with engine.connect() as conn:
        row = conn.execute(text("SELECT id, shape FROM windows WHERE id = 1")).one()
    assert row == (1, None)


def test_migration_is_idempotent_and_preserves_rows(tmp_path):
    engine = _make_old_db(tmp_path / "old.db")
    Base.metadata.create_all(bind=engine)
    run_migrations(engine)
    run_migrations(engine)  # 第二次启动不应报错

    with engine.connect() as conn:
        windows = conn.execute(text("SELECT COUNT(*) FROM windows")).scalar()
        layouts = conn.execute(text("SELECT COUNT(*) FROM layouts")).scalar()
    assert windows == 1
    assert layouts == 1


def test_migration_noop_on_fresh_schema(tmp_path):
    # 新库由 create_all 直接建出完整结构（含 label / step），迁移为空操作
    engine = create_engine(f"sqlite+pysqlite:///{tmp_path}/fresh.db")
    Base.metadata.create_all(bind=engine)
    run_migrations(engine)
    assert "label" in {c["name"] for c in inspect(engine).get_columns("windows")}
    assert "step" in {c["name"] for c in inspect(engine).get_columns("layouts")}


def test_old_layout_without_step_loads_as_1mm(tmp_path):
    """历史数据正常加载：缺少步长值的旧记录经 GET 按 1 毫米返回。"""
    engine = _make_old_db(tmp_path / "old.db")
    Base.metadata.create_all(bind=engine)
    run_migrations(engine)

    TestingSessionLocal = sessionmaker(bind=engine, future=True)

    def override_get_db():
        db = TestingSessionLocal()
        try:
            yield db
        finally:
            db.close()

    app.dependency_overrides[get_db] = override_get_db
    try:
        with TestClient(app) as client:
            data = client.get("/api/layout").json()
    finally:
        app.dependency_overrides.clear()

    assert data["step"] == 1
    assert data["verdict"] == "可裁切"
    assert [(w["x"], w["y"], w["w"], w["h"]) for w in data["windows"]] == [(300, 300, 100, 80)]
    assert data["windows"][0]["label"] is None
    # 旧记录缺少形状值：按矩形读取
    assert data["windows"][0]["shape"] == "rect"
