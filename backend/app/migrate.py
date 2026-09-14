"""轻量 schema 迁移：create_all 之外的幂等补丁。

项目用 ``Base.metadata.create_all`` 建表，它对已存在的旧表不会补列。
这里在启动时对旧库做最小 ALTER，把后加的可空列补齐；新库由
create_all 直接建出完整结构，本函数察觉列已存在即为空操作。
"""
from __future__ import annotations

from sqlalchemy import inspect, text

# 后加的可空列：(表名, 列名, 补充列的 ALTER 语句)
_PATCHES: tuple[tuple[str, str, str], ...] = (
    ("windows", "label", "ALTER TABLE windows ADD COLUMN label VARCHAR(24)"),
    ("layouts", "step", "ALTER TABLE layouts ADD COLUMN step INTEGER"),
)


def run_migrations(db_engine) -> None:
    """为既有表补充后加的可空列（幂等）。"""
    inspector = inspect(db_engine)
    tables = set(inspector.get_table_names())
    patches: list[str] = []
    for table, column, ddl in _PATCHES:
        if table not in tables:
            continue
        columns = {col["name"] for col in inspector.get_columns(table)}
        if column not in columns:
            patches.append(ddl)
    if not patches:
        return
    with db_engine.begin() as conn:
        for ddl in patches:
            conn.execute(text(ddl))
