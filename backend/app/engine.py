"""裁决引擎：开窗合法性、瑕疵区冲突、开窗之间冲突。

坐标约定
--------
纸张固定 1000×700 毫米，左上角为原点，x 轴向右、y 轴向下。
矩形均为半开矩形 [x, x+w) × [y, y+h)：
只有正面积相交才算冲突，边线或角点相接允许。

开窗有两种形状：
  矩形 shape="rect"（缺省，旧请求与旧记录一律按矩形读取）
    半开矩形 [x, x+w) × [y, y+h)。
  圆形 shape="circle"
    以 (x, y) 为外接矩形左上角、w == h 为直径的圆，圆心
    (x+w/2, y+h/2)，半径 w/2；直径必须是正偶数（圆心与半径
    落在整数/半整数坐标上），与矩形共用 x/y/w/h 四个字段。

圆与矩形、圆与圆、圆与矩形开窗的相交均按“正面积相交”裁决：
外切（仅一个接触点）允许。所有几何量在整数放大坐标上精确比较，
不使用浮点。

瑕疵区内置、只读：
  [200,280) × [150,190)
  [620,680) × [420,510)
可用内区（压边安全区向内）：
  12 ≤ x，x+w ≤ 988，12 ≤ y，y+h ≤ 688。

定位步长：提交可携带 1/5/10 毫米步长，裁决前逐字段校验每扇开窗
是否符合刻度（基准为安全内区左上角）。
"""
from __future__ import annotations

from typing import Iterable, Sequence

# --- 纸张与安全区常量（毫米） ---
SHEET_WIDTH = 1000
SHEET_HEIGHT = 700
MARGIN = 12
INNER_RIGHT = SHEET_WIDTH - MARGIN   # 988
INNER_BOTTOM = SHEET_HEIGHT - MARGIN  # 688

# 内置只读瑕疵区（半开矩形）
DEFECTS: tuple[tuple[int, int, int, int], ...] = (
    (200, 150, 80, 40),   # [200,280) × [150,190)
    (620, 420, 60, 90),   # [620,680) × [420,510)
)

VERDICT_CUTTABLE = "可裁切"
VERDICT_REJECTED = "不可裁切"

# --- 开窗形状 ---
# 旧请求与旧记录缺少类型时一律按矩形读取
SHAPE_RECT = "rect"
SHAPE_CIRCLE = "circle"
SHAPES = (SHAPE_RECT, SHAPE_CIRCLE)

# --- 定位步长（毫米） ---
# 技师按量尺精度选择 1 / 5 / 10 毫米步长；刻度以安全内区左上角
# (MARGIN, MARGIN) 为基准：合法坐标满足 (v - MARGIN) % step == 0，
# 合法尺寸满足 v % step == 0。旧客户端与旧记录一律按 1 毫米处理。
GRID_STEPS = (1, 5, 10)
DEFAULT_STEP = 1


# ---------------------------------------------------------------------------
# 形状解析
# ---------------------------------------------------------------------------

def normalize_shape(raw) -> str:
    """把请求中的形状值规范化：缺省/None → 矩形；其余必须是 rect/circle。

    非法值抛 ValueError，由校验层转成按行字段错误（字段名 shape）。
    """
    if raw is None:
        return SHAPE_RECT
    if raw in SHAPES:
        return raw
    raise ValueError(f"形状必须是 {SHAPE_RECT} 或 {SHAPE_CIRCLE}")


def circle_from_bbox(x: int, y: int, w: int, h: int) -> tuple[int, int, int]:
    """由外接矩形 (x,y,w,h) 求整数放大坐标下的圆 (cx2, cy2, r2)。

    返回值整体放大 2 倍：圆心坐标 cx2=2x+w、cy2=2y+h，半径 r2=w，
    从而圆心为半整数、半径为半整数的圆也全部落在整数坐标上，
    后续距离比较无需浮点。调用方须自行保证 w == h 且为正整数。
    """
    return 2 * x + w, 2 * y + h, w


# ---------------------------------------------------------------------------
# 相交判定（正面积相交；边/角/外切相接允许）
# ---------------------------------------------------------------------------

def rects_positive_overlap(a, b) -> bool:
    """两个半开矩形是否有正面积相交。

    边/角相接（任一维上的相交长度为 0）不算冲突。
    矩形统一表示为 (x, y, w, h)。
    """
    ax, ay, aw, ah = a
    bx, by, bw, bh = b
    overlap_w = min(ax + aw, bx + bw) - max(ax, bx)
    overlap_h = min(ay + ah, by + bh) - max(ay, by)
    return overlap_w > 0 and overlap_h > 0


def circle_rect_positive_overlap(circle, rect) -> bool:
    """圆与半开矩形是否正面积相交。

    圆表示为整数放大坐标三元组 (cx2, cy2, r2)（值均放大 2 倍，
    见 circle_from_bbox）；矩形为 (x, y, w, h)。外切（圆与矩形
    仅一个接触点，含从角部外切）不算冲突。

    判据：圆心到矩形闭区域的最近点距离 < 半径。
    所有量放大 2 倍后为整数：最近点坐标为 clamp(cx2, 2rx, 2(rx+rw))，
    距离平方与 r2² 比较，严格小于才是正面积相交。
    """
    cx2, cy2, r2 = circle
    rx, ry, rw, rh = rect
    qx2 = min(max(cx2, 2 * rx), 2 * (rx + rw))
    qy2 = min(max(cy2, 2 * ry), 2 * (ry + rh))
    dx2 = qx2 - cx2
    dy2 = qy2 - cy2
    return dx2 * dx2 + dy2 * dy2 < r2 * r2


def circles_positive_overlap(a, b) -> bool:
    """两个圆是否正面积相交。外切（圆心距恰好等于半径和）允许。

    输入均为整数放大坐标 (cx2, cy2, r2)，比较圆心距平方与
    (r2a+r2b)²，严格小于才算相交，避免开方。
    """
    ax2, ay2, ar2 = a
    bx2, by2, br2 = b
    dx2 = ax2 - bx2
    dy2 = ay2 - by2
    rr2 = ar2 + br2
    return dx2 * dx2 + dy2 * dy2 < rr2 * rr2


def shapes_positive_overlap(a, b) -> bool:
    """两个开窗形状是否正面积相交。

    入参统一为 dict：{"shape": "rect"|"circle", "x","y","w","h"}；
    缺少 shape 时按矩形处理（旧调用方）。
    """
    shape_a = a.get("shape", SHAPE_RECT)
    shape_b = b.get("shape", SHAPE_RECT)
    if shape_a == SHAPE_RECT and shape_b == SHAPE_RECT:
        return rects_positive_overlap(
            (a["x"], a["y"], a["w"], a["h"]),
            (b["x"], b["y"], b["w"], b["h"]),
        )
    if shape_a == SHAPE_CIRCLE and shape_b == SHAPE_CIRCLE:
        return circles_positive_overlap(
            circle_from_bbox(a["x"], a["y"], a["w"], a["h"]),
            circle_from_bbox(b["x"], b["y"], b["w"], b["h"]),
        )
    if shape_a == SHAPE_CIRCLE:
        circle = circle_from_bbox(a["x"], a["y"], a["w"], a["h"])
        rect = (b["x"], b["y"], b["w"], b["h"])
    else:
        circle = circle_from_bbox(b["x"], b["y"], b["w"], b["h"])
        rect = (a["x"], a["y"], a["w"], a["h"])
    return circle_rect_positive_overlap(circle, rect)


def field_errors(x, y, w, h, step: int = DEFAULT_STEP, shape: str = SHAPE_RECT) -> dict[str, str]:
    """逐字段校验。返回 {字段: 错误信息}，合法时为空 dict。

    非法的可能是：不是整数（None/非 int）、宽高小于 1、
    坐标为负、越过压边安全区、偏离所选步长刻度、
    圆形开窗宽高不相等。
    step 为定位步长（1/5/10 毫米），刻度基准为安全内区左上角。
    """
    errors: dict[str, str] = {}

    def is_int(v) -> bool:
        # bool 是 int 的子类，但 True/False 显然不是合法坐标
        return isinstance(v, int) and not isinstance(v, bool)

    if not is_int(x):
        errors["x"] = "x 必须为整数"
    elif x < MARGIN:
        errors["x"] = f"x 必须 ≥ {MARGIN}（压边安全区）"

    if not is_int(y):
        errors["y"] = "y 必须为整数"
    elif y < MARGIN:
        errors["y"] = f"y 必须 ≥ {MARGIN}（压边安全区）"

    if not is_int(w):
        errors["w"] = "宽必须为整数"
    elif w < 1:
        errors["w"] = "宽至少为 1"

    if not is_int(h):
        errors["h"] = "高必须为整数"
    elif h < 1:
        errors["h"] = "高至少为 1"

    # 右/下边界同时涉及两个字段；起点与尺寸本身合法时才检查，
    # 避免在一个字段上堆叠多条错误，同时保证一次提交报出全部非法字段。
    if is_int(x) and is_int(w) and w >= 1 and x >= MARGIN and x + w > INNER_RIGHT:
        errors["x"] = f"x+宽 必须 ≤ {INNER_RIGHT}（压边安全区）"
    if is_int(y) and is_int(h) and h >= 1 and y >= MARGIN and y + h > INNER_BOTTOM:
        errors["y"] = f"y+高 必须 ≤ {INNER_BOTTOM}（压边安全区）"

    # 圆形：宽高必须相等（直径）。字段本身合法时才检查，
    # 宽高各自的错误（非整数/小于 1）已在上面报出，不堆叠。
    if shape == SHAPE_CIRCLE and is_int(w) and is_int(h) and w >= 1 and h >= 1 and w != h:
        errors["w"] = "圆形开窗宽高必须相等（直径）"
        errors["h"] = "圆形开窗宽高必须相等（直径）"

    # 刻度校验：字段本身合法时才检查，避免在一个字段上堆叠多条错误
    if step > 1:
        if "x" not in errors and (x - MARGIN) % step != 0:
            errors["x"] = f"x 须符合 {step} 毫米刻度"
        if "y" not in errors and (y - MARGIN) % step != 0:
            errors["y"] = f"y 须符合 {step} 毫米刻度"
        if "w" not in errors and w % step != 0:
            errors["w"] = f"宽须符合 {step} 毫米刻度"
        if "h" not in errors and h % step != 0:
            errors["h"] = f"高须符合 {step} 毫米刻度"

    return errors


def _as_shape(value) -> dict:
    """开窗形状的统一入口：dict 原样返回；(x,y,w,h) 元组按矩形处理。

    兼容以矩形四元组直接调用相交判定的旧调用方。
    """
    if isinstance(value, dict):
        return value
    x, y, w, h = value
    return {"shape": SHAPE_RECT, "x": x, "y": y, "w": w, "h": h}


def find_defect_conflicts(window) -> list[int]:
    """返回与该开窗正面积相交的瑕疵区索引（0 起）。

    瑕疵区均为半开矩形；开窗可以是矩形或圆形。入参可为形状 dict，
    也可为矩形四元组 (x,y,w,h)（旧调用方）。
    """
    win = _as_shape(window)
    if win.get("shape", SHAPE_RECT) == SHAPE_CIRCLE:
        circle = circle_from_bbox(win["x"], win["y"], win["w"], win["h"])
        return [i for i, d in enumerate(DEFECTS) if circle_rect_positive_overlap(circle, d)]
    rect = (win["x"], win["y"], win["w"], win["h"])
    return [i for i, d in enumerate(DEFECTS) if rects_positive_overlap(rect, d)]


def find_pair_conflicts(windows: Sequence) -> list[tuple[int, int]]:
    """返回开窗之间正面积相交的索引对 (i, j)，i < j。

    矩形/矩形、圆/圆、圆/矩形三种组合均按正面积相交裁决，
    外切与边线相接允许。元素可为形状 dict 或矩形四元组。
    """
    shapes = [_as_shape(w) for w in windows]
    pairs: list[tuple[int, int]] = []
    for i in range(len(shapes)):
        for j in range(i + 1, len(shapes)):
            if shapes_positive_overlap(shapes[i], shapes[j]):
                pairs.append((i, j))
    return pairs


def adjudicate(windows: Iterable[dict]) -> dict:
    """对一批开窗做完整裁决。

    输入：[{"id":..., "x":int, "y":int, "w":int, "h":int,
            "shape":"rect"|"circle"(可选)}, ...]
    输出完整裁决结果（可直接落库/返回前端）：
      verdict: 可切 | 不可裁切
      defect_conflicts: [{window_id, defect_index}]
      window_conflicts: [{window_a, window_b}]
      conflicting_window_ids: 涉及任何冲突的开窗 id（高亮用）
    """
    indexed: list[tuple[int, dict]] = [
        (
            win["id"],
            {
                "shape": win.get("shape", SHAPE_RECT),
                "x": win["x"],
                "y": win["y"],
                "w": win["w"],
                "h": win["h"],
            },
        )
        for win in windows
    ]

    defect_conflicts = []
    conflicting: set[int] = set()
    for win_id, shape in indexed:
        for di in find_defect_conflicts(shape):
            defect_conflicts.append({"window_id": win_id, "defect_index": di})
            conflicting.add(win_id)

    window_conflicts = []
    for i, j in find_pair_conflicts([s for _, s in indexed]):
        a, b = indexed[i][0], indexed[j][0]
        window_conflicts.append({"window_a": a, "window_b": b})
        conflicting.add(a)
        conflicting.add(b)

    verdict = VERDICT_CUTTABLE if not (defect_conflicts or window_conflicts) else VERDICT_REJECTED
    return {
        "verdict": verdict,
        "defect_conflicts": defect_conflicts,
        "window_conflicts": window_conflicts,
        "conflicting_window_ids": sorted(conflicting),
    }
