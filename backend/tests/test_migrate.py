"""轻量迁移：为既有（旧结构）数据库补充可空 label 列。"""
import os
import sys

os.environ.setdefault("DATABASE_URL", "sqlite+pysqlite:///:memory:")

sys.path.insert(0, os.path.dirname(os.path.dirname(os.path.abspath(__file__))))

from sqlalchemy import create_engine, inspect, text  # noqa: E402

from app.db import Base  # noqa: E402
from app.migrate import run_migrations  # noqa: E402

# 旧结构的 windows 表（没有 label 列）
OLD_SCHEMA = """
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


def _make_old_db(path):
    """造一个旧结构的库，并写入一条历史记录。"""
    engine = create_engine(f"sqlite+pysqlite:///{path}")
    with engine.begin() as conn:
        conn.execute(text("DROP TABLE IF EXISTS windows"))
        conn.execute(text(OLD_SCHEMA))
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


def test_migration_is_idempotent_and_preserves_rows(tmp_path):
    engine = _make_old_db(tmp_path / "old.db")
    Base.metadata.create_all(bind=engine)
    run_migrations(engine)
    run_migrations(engine)  # 第二次启动不应报错

    with engine.connect() as conn:
        count = conn.execute(text("SELECT COUNT(*) FROM windows")).scalar()
    assert count == 1


def test_migration_noop_on_fresh_schema(tmp_path):
    # 新库由 create_all 直接建出完整结构（含 label），迁移为空操作
    engine = create_engine(f"sqlite+pysqlite:///{tmp_path}/fresh.db")
    Base.metadata.create_all(bind=engine)
    run_migrations(engine)
    assert "label" in {c["name"] for c in inspect(engine).get_columns("windows")}
