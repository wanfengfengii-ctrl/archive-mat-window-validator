import pytest

from app.engine import (
    DEFAULT_STEP,
    DEFECTS,
    GRID_STEPS,
    INNER_BOTTOM,
    INNER_RIGHT,
    MARGIN,
    SHEET_HEIGHT,
    SHEET_WIDTH,
    VERDICT_CUTTABLE,
    VERDICT_REJECTED,
    adjudicate,
    field_errors,
    find_defect_conflicts,
    find_pair_conflicts,
    rects_positive_overlap,
)


# ---------- 半开矩形相交规则 ----------

def test_positive_area_overlap():
    assert rects_positive_overlap((0, 0, 10, 10), (5, 5, 10, 10))


def test_edge_touch_allowed():
    # 右边线贴左边线：[0,10) 与 [10,20)，允许
    assert not rects_positive_overlap((0, 0, 10, 10), (10, 0, 10, 10))
    # 上下边线相接
    assert not rects_positive_overlap((0, 0, 10, 10), (0, 10, 10, 10))


def test_corner_touch_allowed():
    # 仅角点相接
    assert not rects_positive_overlap((0, 0, 10, 10), (10, 10, 10, 10))


def test_one_pixel_overlap_conflicts():
    assert rects_positive_overlap((0, 0, 11, 11), (10, 10, 5, 5))


# ---------- 逐字段校验 ----------

def test_valid_inner_window():
    assert field_errors(12, 12, 10, 10) == {}


def test_boundary_values_are_valid():
    # 恰好贴住安全区内边界：x=12、x+w=988、y=12、y+h=688
    assert field_errors(MARGIN, MARGIN, INNER_RIGHT - MARGIN, INNER_BOTTOM - MARGIN) == {}


def test_sheet_constants():
    assert (SHEET_WIDTH, SHEET_HEIGHT) == (1000, 700)
    assert INNER_RIGHT == 988 and INNER_BOTTOM == 688


@pytest.mark.parametrize(
    "x,y,w,h,bad_fields",
    [
        (11, 50, 10, 10, {"x"}),
        (50, 0, 10, 10, {"y"}),
        (50, 50, 0, 10, {"w"}),
        (50, 50, 10, -3, {"h"}),
        (979, 50, 10, 10, {"x"}),   # x+w = 989 > 988
        (50, 679, 10, 10, {"y"}),   # y+h = 689 > 688
        (988, 50, 1, 10, {"x"}),    # x 起点可以到 987（w=1 时）
        ("50", 50, 10, 10, {"x"}),
        (3.5, 50, 10, 10, {"x"}),
        (True, 50, 10, 10, {"x"}),
        (None, 50, 10, 10, {"x"}),
    ],
)
def test_invalid_fields(x, y, w, h, bad_fields):
    errs = field_errors(x, y, w, h)
    assert set(errs.keys()) == bad_fields


def test_all_fields_invalid_reported_at_once():
    errs = field_errors("a", -1, 0, 0)
    assert set(errs.keys()) == {"x", "y", "w", "h"}


# ---------- 定位步长刻度校验 ----------

def test_grid_step_constants():
    assert GRID_STEPS == (1, 5, 10)
    assert DEFAULT_STEP == 1


def test_step1_imposes_no_grid_errors():
    # 默认（缺省）1 毫米：任意整数坐标合法，旧行为不变
    assert field_errors(300, 301, 101, 62) == {}
    assert field_errors(300, 301, 101, 62, 1) == {}


def test_step5_on_grid_window_valid():
    # 刻度基准为安全内区左上角 (12,12)：302 = 12 + 58×5
    assert field_errors(302, 302, 105, 60, 5) == {}


def test_step10_on_grid_window_valid():
    # 312 = 12 + 30×10
    assert field_errors(312, 312, 110, 60, 10) == {}


@pytest.mark.parametrize(
    "x,y,w,h,step,bad_fields",
    [
        (300, 302, 105, 60, 5, {"x"}),     # (300-12) % 5 = 3
        (302, 300, 105, 60, 5, {"y"}),
        (302, 302, 103, 60, 5, {"w"}),     # 103 不是 5 的倍数
        (302, 302, 105, 62, 5, {"h"}),
        (300, 300, 103, 62, 5, {"x", "y", "w", "h"}),
        (303, 312, 110, 60, 10, {"x"}),    # 10 毫米步长下 303-12=291 不在刻度上
        (312, 312, 105, 65, 10, {"w", "h"}),
    ],
)
def test_off_grid_fields_flagged(x, y, w, h, step, bad_fields):
    errs = field_errors(x, y, w, h, step)
    assert set(errs.keys()) == bad_fields
    assert all("刻度" in errs[k] for k in bad_fields)


def test_grid_error_does_not_stack_on_range_error():
    # x=0 已报压边安全区错误，不再叠加刻度错误
    errs = field_errors(0, 302, 105, 60, 5)
    assert set(errs.keys()) == {"x"}
    assert "安全区" in errs["x"]


# ---------- 内置瑕疵区 ----------

def test_builtin_defects_readonly_shape():
    assert DEFECTS == (
        (200, 150, 80, 40),
        (620, 420, 60, 90),
    )


def test_window_inside_defect_conflicts():
    # 开窗完全落在第一个瑕疵区内
    assert find_defect_conflicts((220, 160, 20, 20)) == [0]


def test_window_edge_aligned_with_defect_allowed():
    # 左边线贴瑕疵区右边线 x=280：允许
    assert find_defect_conflicts((280, 150, 20, 40)) == []
    # 下边线贴瑕疵区上边线 y=150：允许
    assert find_defect_conflicts((200, 190, 80, 10)) == []
    # 仅角点相接
    assert find_defect_conflicts((280, 190, 5, 5)) == []


def test_window_overlaps_second_defect_by_one_mm():
    # 侵入第二个瑕疵区 1mm
    assert find_defect_conflicts((679, 509, 10, 10)) == [1]


# ---------- 开窗之间 ----------

def test_pair_overlap():
    assert find_pair_conflicts([(0, 0, 10, 10), (5, 5, 10, 10)]) == [(0, 1)]


def test_pair_edge_touch_allowed():
    assert find_pair_conflicts([(12, 12, 10, 10), (22, 12, 10, 10)]) == []
    assert find_pair_conflicts([(12, 12, 10, 10), (12, 22, 10, 10)]) == []
    assert find_pair_conflicts([(12, 12, 10, 10), (22, 22, 10, 10)]) == []


def test_multiple_pair_conflicts():
    wins = [(12, 12, 50, 50), (30, 30, 5, 5), (100, 100, 5, 5)]
    assert find_pair_conflicts(wins) == [(0, 1)]


# ---------- 完整裁决 ----------

def test_clean_plan_is_cuttable():
    wins = [
        {"id": 1, "x": 300, "y": 300, "w": 50, "h": 50},
        {"id": 2, "x": 400, "y": 300, "w": 50, "h": 50},
    ]
    out = adjudicate(wins)
    assert out["verdict"] == VERDICT_CUTTABLE
    assert out["defect_conflicts"] == []
    assert out["window_conflicts"] == []
    assert out["conflicting_window_ids"] == []


def test_defect_conflict_marks_not_cuttable():
    wins = [{"id": 7, "x": 220, "y": 160, "w": 20, "h": 20}]
    out = adjudicate(wins)
    assert out["verdict"] == VERDICT_REJECTED
    assert out["defect_conflicts"] == [{"window_id": 7, "defect_index": 0}]
    assert out["conflicting_window_ids"] == [7]


def test_window_conflict_marks_both():
    wins = [
        {"id": 1, "x": 300, "y": 300, "w": 50, "h": 50},
        {"id": 2, "x": 340, "y": 340, "w": 50, "h": 50},
    ]
    out = adjudicate(wins)
    assert out["verdict"] == VERDICT_REJECTED
    assert out["window_conflicts"] == [{"window_a": 1, "window_b": 2}]
    assert out["conflicting_window_ids"] == [1, 2]


def test_edge_touching_windows_are_cuttable():
    wins = [
        {"id": 1, "x": 300, "y": 300, "w": 50, "h": 50},
        {"id": 2, "x": 350, "y": 300, "w": 50, "h": 50},
    ]
    assert adjudicate(wins)["verdict"] == VERDICT_CUTTABLE
