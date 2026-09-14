"""原始 JSON 输入校验。

故意不使用 Pydantic 的隐式转换：坐标和尺寸必须是 JSON 整数，
3.5、"5"、true 都应被拒绝并逐字段报错。
"""
from __future__ import annotations

from typing import Any

from .engine import field_errors

MAX_WINDOWS = 500


def _is_json_int(v: Any) -> bool:
    return isinstance(v, int) and not isinstance(v, bool)


def validate_payload(body: Any) -> list[dict[str, dict[str, str]]]:
    """校验提交体，返回每个非法开窗的逐字段错误。

    返回结构：[{"index": int, "fields": {字段: 信息}}, ...]
    顶层结构错误抛出 ValueError（由路由转成 422）。
    """
    if not isinstance(body, dict):
        raise ValueError("请求体必须是 JSON 对象")
    if "windows" not in body:
        raise ValueError("缺少 windows 字段")
    raw_windows = body["windows"]
    if not isinstance(raw_windows, list):
        raise ValueError("windows 必须是数组")
    if len(raw_windows) > MAX_WINDOWS:
        raise ValueError(f"一次最多提交 {MAX_WINDOWS} 个开窗")

    row_errors: list[dict] = []
    for index, item in enumerate(raw_windows):
        if not isinstance(item, dict):
            row_errors.append(
                {"index": index, "fields": {"_": "每个开窗必须是包含 x/y/w/h 的对象"}}
            )
            continue

        fields: dict[str, str] = {}
        for key in ("x", "y", "w", "h"):
            if key not in item:
                fields[key] = "缺少该字段"
        if fields:
            row_errors.append({"index": index, "fields": fields})
            continue

        x, y, w, h = item["x"], item["y"], item["w"], item["h"]
        if not all(_is_json_int(v) for v in (x, y, w, h)):
            fields = {
                key: "必须为整数"
                for key, v in (("x", x), ("y", y), ("w", w), ("h", h))
                if not _is_json_int(v)
            }
            row_errors.append({"index": index, "fields": fields})
            continue

        errs = field_errors(x, y, w, h)
        if errs:
            row_errors.append({"index": index, "fields": errs})

    return row_errors
