"""轻量 schema 迁移：create_all 之外的幂等补丁。

项目用 ``Base.metadata.create_all`` 建表，它对已存在的旧表不会补列。
这里在启动时对旧库做最小 ALTER，把后加的可空列补齐；新库由
create_all 直接建出完整结构，本函数察觉列已存在即为空操作。
"""
from __future__ import annotations

from sqlalchemy import inspect, text


def run_migrations(db_engine) -> None:
    """为既有 windows 表补充可空 label 列（幂等）。"""
    inspector = inspect(db_engine)
    if "windows" not in inspector.get_table_names():
        return
    columns = {col["name"] for col in inspector.get_columns("windows")}
    if "label" in columns:
        return
    with db_engine.begin() as conn:
        conn.execute(text("ALTER TABLE windows ADD COLUMN label VARCHAR(24)"))
