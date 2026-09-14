import pytest

from app.engine import (
    DEFAULT_STEP,
    DEFECTS,
    GRID_STEPS,
    INNER_BOTTOM,
    INNER_RIGHT,
    MARGIN,
    SHAPE_CIRCLE,
    SHAPE_RECT,
    SHEET_HEIGHT,
    SHEET_WIDTH,
    VERDICT_CUTTABLE,
    VERDICT_REJECTED,
    adjudicate,
    circle_from_bbox,
    circle_rect_positive_overlap,
    circles_positive_overlap,
    field_errors,
    find_defect_conflicts,
    find_pair_conflicts,
    normalize_shape,
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


# ---------- 圆形开窗 ----------

def test_shape_normalization_defaults_missing_to_rect():
    assert normalize_shape(None) == SHAPE_RECT
    assert normalize_shape("rect") == SHAPE_RECT
    assert normalize_shape("circle") == SHAPE_CIRCLE
    for bad in ("CIRCLE", "ellipse", 3, True, ["circle"]):
        with pytest.raises(ValueError):
            normalize_shape(bad)


def test_circle_bbox_to_scaled_triple():
    # 直径偶数：圆心整数
    assert circle_from_bbox(240, 150, 40, 40) == (520, 340, 40)
    # 直径奇数：圆心半整数，放大 2 倍后仍为整数
    assert circle_from_bbox(240, 150, 41, 41) == (521, 341, 41)


def test_circle_inside_defect_conflicts():
    # 圆心 (260,170) r=20，整个圆落在瑕疵区 [200,280)×[150,190) 内
    win = {"shape": SHAPE_CIRCLE, "x": 240, "y": 150, "w": 40, "h": 40}
    assert find_defect_conflicts(win) == [0]


def test_circle_externally_tangent_to_defect_is_allowed():
    # 圆在瑕疵 1 正上方，圆心 (650,400) r=20：圆底点 (650,420)
    # 恰好外切瑕疵上边线 y=420，允许
    win = {"shape": SHAPE_CIRCLE, "x": 640, "y": 380, "w": 40, "h": 40}
    assert find_defect_conflicts(win) == []


def test_circle_intrudes_defect_by_one_mm_conflicts():
    # 圆心下移 1mm：最近距离 19 < 20，侵入 1mm 即冲突
    win = {"shape": SHAPE_CIRCLE, "x": 640, "y": 381, "w": 40, "h": 40}
    assert find_defect_conflicts(win) == [1]


def test_circle_side_tangent_to_defect_is_allowed():
    # 圆心 (600,465) r=20：圆右点 (620,465) 外切瑕疵左边线 x=620
    win = {"shape": SHAPE_CIRCLE, "x": 580, "y": 445, "w": 40, "h": 40}
    assert find_defect_conflicts(win) == []


def test_circle_corner_tangent_to_defect_is_allowed():
    # 圆心 (310,230) r=50，到瑕疵 0 右下角 (280,190) 的距离
    # sqrt(30²+40²)=50：角部外切，允许；圆心左移 1mm 即侵入
    tangent = {"shape": SHAPE_CIRCLE, "x": 260, "y": 180, "w": 100, "h": 100}
    assert find_defect_conflicts(tangent) == []
    intruding = {"shape": SHAPE_CIRCLE, "x": 259, "y": 180, "w": 100, "h": 100}
    assert find_defect_conflicts(intruding) == [0]


def test_two_circles_external_tangency_allowed_overlap_conflicts():
    c1 = {"shape": SHAPE_CIRCLE, "x": 290, "y": 280, "w": 40, "h": 40}
    tangent = {"shape": SHAPE_CIRCLE, "x": 330, "y": 280, "w": 40, "h": 40}
    assert find_pair_conflicts([c1, tangent]) == []
    overlapping = {"shape": SHAPE_CIRCLE, "x": 329, "y": 280, "w": 40, "h": 40}
    assert find_pair_conflicts([c1, overlapping]) == [(0, 1)]


def test_circles_with_half_integer_radii_exact_scaled_comparison():
    # r=20（直径 40）与 r=19.5（直径 39）：圆心距 38.5mm < 39.5mm → 相交
    c1 = {"shape": SHAPE_CIRCLE, "x": 290, "y": 280, "w": 40, "h": 40}
    overlap = {"shape": SHAPE_CIRCLE, "x": 329, "y": 280, "w": 39, "h": 39}
    assert circles_positive_overlap(
        circle_from_bbox(290, 280, 40, 40), circle_from_bbox(329, 280, 39, 39)
    )
    assert find_pair_conflicts([c1, overlap]) == [(0, 1)]
    # 右移 1mm：圆心距 39.5mm 恰好外切（放大坐标精确判定，无浮点误差）
    tangent = {"shape": SHAPE_CIRCLE, "x": 330, "y": 280, "w": 39, "h": 39}
    assert find_pair_conflicts([c1, tangent]) == []


def test_circle_and_rect_window_tangency_vs_intrusion():
    rect = {"shape": SHAPE_RECT, "x": 330, "y": 280, "w": 60, "h": 40}
    # 圆 r=20，圆心 (310,300)：圆右点 (330,300) 外切矩形左边线 → 允许
    tangent = {"shape": SHAPE_CIRCLE, "x": 290, "y": 280, "w": 40, "h": 40}
    assert find_pair_conflicts([tangent, rect]) == []
    # 圆右移 1mm：侵入矩形 1mm → 冲突，双方进入冲突列表
    intruding = {"shape": SHAPE_CIRCLE, "x": 291, "y": 280, "w": 40, "h": 40}
    assert find_pair_conflicts([intruding, rect]) == [(0, 1)]


def test_circle_rect_helper_directly():
    circle = circle_from_bbox(290, 280, 40, 40)
    assert not circle_rect_positive_overlap(circle, (330, 280, 60, 40))
    assert circle_rect_positive_overlap(circle, (329, 280, 60, 40))


def test_circle_requires_equal_width_and_height():
    assert field_errors(300, 300, 40, 41, shape=SHAPE_CIRCLE) != {}
    errs = field_errors(300, 300, 40, 41, shape=SHAPE_CIRCLE)
    assert set(errs) == {"w", "h"}
    assert "相等" in errs["w"]
    # 矩形开窗宽高不等没有这条错误
    assert field_errors(300, 300, 40, 41, shape=SHAPE_RECT) == {}
    # 合法圆形
    assert field_errors(302, 302, 105, 105, step=5, shape=SHAPE_CIRCLE) == {}


def test_circle_grid_validation_uses_diameter():
    # 圆形直径同样要落在步长刻度上
    errs = field_errors(302, 302, 103, 103, step=5, shape=SHAPE_CIRCLE)
    assert set(errs) == {"w", "h"}


def test_adjudicate_mixed_shapes_marks_both():
    wins = [
        {"id": 1, "shape": SHAPE_CIRCLE, "x": 291, "y": 280, "w": 40, "h": 40},
        {"id": 2, "shape": SHAPE_RECT, "x": 330, "y": 280, "w": 60, "h": 40},
    ]
    out = adjudicate(wins)
    assert out["verdict"] == VERDICT_REJECTED
    assert out["window_conflicts"] == [{"window_a": 1, "window_b": 2}]
    assert out["conflicting_window_ids"] == [1, 2]


def test_adjudicate_circle_defect_conflict():
    wins = [{"id": 9, "shape": SHAPE_CIRCLE, "x": 640, "y": 381, "w": 40, "h": 40}]
    out = adjudicate(wins)
    assert out["verdict"] == VERDICT_REJECTED
    assert out["defect_conflicts"] == [{"window_id": 9, "defect_index": 1}]
    assert out["conflicting_window_ids"] == [9]


def test_adjudicate_missing_shape_reads_as_rect():
    # 旧调用方：没有 shape 字段时按矩形裁决
    wins = [
        {"id": 1, "x": 300, "y": 300, "w": 50, "h": 50},
        {"id": 2, "x": 340, "y": 340, "w": 50, "h": 50},
    ]
    out = adjudicate(wins)
    assert out["verdict"] == VERDICT_REJECTED
    assert out["window_conflicts"] == [{"window_a": 1, "window_b": 2}]


def test_adjudicate_circle_tangent_plan_is_cuttable():
    # 圆与瑕疵 1 外切（圆底点 (650,420)），矩形开窗在圆右侧边线相接：
    # 整案可裁切
    wins = [
        {"id": 1, "shape": SHAPE_CIRCLE, "x": 640, "y": 380, "w": 40, "h": 40},
        {"id": 2, "shape": SHAPE_RECT, "x": 680, "y": 380, "w": 40, "h": 40},
    ]
    out = adjudicate(wins)
    assert out["verdict"] == VERDICT_CUTTABLE
    assert out["defect_conflicts"] == []
    assert out["window_conflicts"] == []
