"""API 集成测试：逐字段错误、整次不落库、合法保存与刷新恢复。"""


def _put(client, windows):
    return client.put("/api/layout", json={"windows": windows})


def test_health(client):
    assert client.get("/api/health").json() == {"status": "ok"}


def test_defects_endpoint_exposes_builtin_readonly_zones(client):
    data = client.get("/api/defects").json()
    assert data["defects"] == [
        {"index": 0, "x": 200, "y": 150, "w": 80, "h": 40},
        {"index": 1, "x": 620, "y": 420, "w": 60, "h": 90},
    ]
    assert data["sheet"] == {"width": 1000, "height": 700, "margin": 12}


def test_empty_layout_before_any_submission(client):
    data = client.get("/api/layout").json()
    assert data == {
        "verdict": None,
        "step": None,
        "windows": [],
        "result": None,
        "created_at": None,
    }


def test_valid_clean_submission_persists_and_is_cuttable(client):
    r = _put(client, [{"x": 300, "y": 300, "w": 100, "h": 80}])
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["verdict"] == "可裁切"
    assert body["result"]["conflicting_window_ids"] == []
    assert len(body["windows"]) == 1
    assert body["windows"][0]["x"] == 300


def test_refresh_restores_same_layout(client):
    _put(client, [
        {"x": 300, "y": 300, "w": 100, "h": 80},
        {"x": 500, "y": 100, "w": 40, "h": 40},
    ])
    data = client.get("/api/layout").json()
    assert data["verdict"] == "可裁切"
    assert [(w["x"], w["y"], w["w"], w["h"]) for w in data["windows"]] == [
        (300, 300, 100, 80),
        (500, 100, 40, 40),
    ]
    # 提交次序保留
    assert [w["position"] for w in data["windows"]] == [0, 1]


def test_latest_submission_wins(client):
    _put(client, [{"x": 300, "y": 300, "w": 10, "h": 10}])
    _put(client, [{"x": 500, "y": 500, "w": 20, "h": 20}])
    data = client.get("/api/layout").json()
    assert len(data["windows"]) == 1
    assert data["windows"][0]["x"] == 500


def test_defect_conflict_is_not_cuttable_but_persisted(client):
    # 与瑕疵区正面积相交：方案仍保存，裁决为不可裁切
    r = _put(client, [{"x": 250, "y": 170, "w": 60, "h": 40}])
    assert r.status_code == 200
    body = r.json()
    assert body["verdict"] == "不可裁切"
    win_id = body["windows"][0]["id"]
    assert body["result"]["defect_conflicts"] == [
        {"window_id": win_id, "defect_index": 0}
    ]
    assert body["result"]["conflicting_window_ids"] == [win_id]

    again = client.get("/api/layout").json()
    assert again["verdict"] == "不可裁切"
    assert again["result"]["defect_conflicts"][0]["window_id"] == again["windows"][0]["id"]


def test_overlapping_windows_both_highlighted(client):
    r = _put(client, [
        {"x": 300, "y": 300, "w": 100, "h": 100},
        {"x": 350, "y": 350, "w": 100, "h": 100},
    ])
    body = r.json()
    assert body["verdict"] == "不可裁切"
    ids = [w["id"] for w in body["windows"]]
    assert body["result"]["window_conflicts"] == [
        {"window_a": ids[0], "window_b": ids[1]}
    ]
    assert body["result"]["conflicting_window_ids"] == sorted(ids)


def test_edge_touching_windows_cuttable(client):
    r = _put(client, [
        {"x": 300, "y": 300, "w": 50, "h": 50},
        {"x": 350, "y": 300, "w": 50, "h": 50},
    ])
    assert r.status_code == 200
    assert r.json()["verdict"] == "可裁切"


def test_boundary_values_accepted(client):
    # 贴满安全区左右/下边界的底部长条：[12,988) × [600,688)，不触瑕疵区
    r = _put(client, [{"x": 12, "y": 600, "w": 976, "h": 88}])
    assert r.status_code == 200, r.text
    assert r.json()["verdict"] == "可裁切"


# ---------- 非法提交：逐字段错误且整次不落库 ----------

def test_field_level_errors_and_no_persistence(client):
    r = _put(client, [
        {"x": 0, "y": 0, "w": 0, "h": 0},  # 四个字段全非法
    ])
    assert r.status_code == 422
    errs = r.json()["field_errors"]
    assert errs[0]["index"] == 0
    assert set(errs[0]["fields"].keys()) == {"x", "y", "w", "h"}

    # 整次不落库
    assert client.get("/api/layout").json()["windows"] == []


def test_error_reports_correct_row_index(client):
    r = _put(client, [
        {"x": 300, "y": 300, "w": 10, "h": 10},  # 合法
        {"x": 300, "y": 300, "w": -5, "h": 10},  # w 非法
        {"x": 300, "y": 900, "w": 10, "h": 10},  # y+h 越界
    ])
    assert r.status_code == 422
    rows = r.json()["field_errors"]
    assert [row["index"] for row in rows] == [1, 2]
    assert set(rows[0]["fields"]) == {"w"}
    assert set(rows[1]["fields"]) == {"y"}


def test_any_bad_row_rolls_back_whole_batch(client):
    r = _put(client, [
        {"x": 300, "y": 300, "w": 10, "h": 10},
        {"x": "300", "y": 300, "w": 10, "h": 10},
    ])
    assert r.status_code == 422
    assert client.get("/api/layout").json()["windows"] == []


def test_non_integer_json_types_rejected(client):
    for bad in ("300", 3.5, True, None):
        r = _put(client, [{"x": bad, "y": 300, "w": 10, "h": 10}])
        assert r.status_code == 422, bad
        assert "x" in r.json()["field_errors"][0]["fields"]


def test_float_that_is_integral_value_still_rejected(client):
    # 300.0 不是 JSON 整数
    r = _put(client, [{"x": 300.0, "y": 300, "w": 10.0, "h": 10}])
    assert r.status_code == 422
    assert set(r.json()["field_errors"][0]["fields"]) == {"x", "w"}


def test_missing_field_reported(client):
    r = client.put("/api/layout", json={"windows": [{"x": 300, "y": 300, "w": 10}]})
    assert r.status_code == 422
    assert r.json()["field_errors"][0]["fields"] == {"h": "缺少该字段"}


def test_malformed_body(client):
    r = client.put("/api/layout", content="not json", headers={"Content-Type": "application/json"})
    assert r.status_code == 422


def test_windows_must_be_array(client):
    r = client.put("/api/layout", json={"windows": {"x": 1}})
    assert r.status_code == 422


def test_empty_batch_is_valid_cuttable(client):
    r = _put(client, [])
    assert r.status_code == 200
    assert r.json()["verdict"] == "可裁切"


# ---------- 可选工件编号 ----------

def test_labels_saved_and_restored_after_refresh(client):
    r = _put(client, [
        {"x": 300, "y": 300, "w": 100, "h": 80, "label": "ZW-2026-001"},
        {"x": 500, "y": 100, "w": 40, "h": 40, "label": "ZW-2026-002"},
    ])
    assert r.status_code == 200, r.text
    assert [w["label"] for w in r.json()["windows"]] == ["ZW-2026-001", "ZW-2026-002"]

    restored = client.get("/api/layout").json()
    assert [w["label"] for w in restored["windows"]] == ["ZW-2026-001", "ZW-2026-002"]
    assert [w["position"] for w in restored["windows"]] == [0, 1]


def test_label_trimmed_before_persistence(client):
    r = _put(client, [{"x": 300, "y": 300, "w": 10, "h": 10, "label": "  A-1  "}])
    assert r.status_code == 200
    assert r.json()["windows"][0]["label"] == "A-1"
    assert client.get("/api/layout").json()["windows"][0]["label"] == "A-1"


def test_label_max_length_boundary(client):
    ok = _put(client, [{"x": 300, "y": 300, "w": 10, "h": 10, "label": "编" * 24}])
    assert ok.status_code == 200, ok.text
    assert ok.json()["windows"][0]["label"] == "编" * 24

    too_long = _put(client, [{"x": 300, "y": 300, "w": 10, "h": 10, "label": "编" * 25}])
    assert too_long.status_code == 422
    assert "label" in too_long.json()["field_errors"][0]["fields"]


def test_blank_and_missing_labels_stored_as_null(client):
    r = _put(client, [
        {"x": 300, "y": 300, "w": 10, "h": 10},                      # 旧客户端：未携带编号
        {"x": 500, "y": 300, "w": 10, "h": 10, "label": None},       # 显式 null
        {"x": 700, "y": 300, "w": 10, "h": 10, "label": "   "},      # 全空格 = 未填写
    ])
    assert r.status_code == 200, r.text
    assert [w["label"] for w in r.json()["windows"]] == [None, None, None]
    restored = client.get("/api/layout").json()
    assert [w["label"] for w in restored["windows"]] == [None, None, None]


def test_blank_labels_do_not_count_as_duplicates(client):
    r = _put(client, [
        {"x": 300, "y": 300, "w": 10, "h": 10, "label": ""},
        {"x": 500, "y": 300, "w": 10, "h": 10, "label": "  "},
    ])
    assert r.status_code == 200, r.text


def test_duplicate_labels_rejected_per_row_and_nothing_persisted(client):
    _put(client, [{"x": 12, "y": 12, "w": 10, "h": 10, "label": "KEEP"}])
    before = client.get("/api/layout").json()

    r = _put(client, [
        {"x": 300, "y": 300, "w": 10, "h": 10, "label": "DUP"},
        {"x": 500, "y": 300, "w": 10, "h": 10},                # 合法行
        {"x": 700, "y": 300, "w": 10, "h": 10, "label": "DUP"},
    ])
    assert r.status_code == 422
    rows = r.json()["field_errors"]
    # 只有涉及重复的两行报编号字段错误
    assert [row["index"] for row in rows] == [0, 2]
    assert all(set(row["fields"]) == {"label"} for row in rows)

    # 整批不落库：最新记录保持原样
    assert client.get("/api/layout").json() == before


def test_duplicate_after_trimming_is_rejected(client):
    r = _put(client, [
        {"x": 300, "y": 300, "w": 10, "h": 10, "label": "A-1"},
        {"x": 500, "y": 300, "w": 10, "h": 10, "label": "  A-1  "},
    ])
    assert r.status_code == 422
    assert [row["index"] for row in r.json()["field_errors"]] == [0, 1]


def test_label_too_long_rejected_and_nothing_persisted(client):
    before = client.get("/api/layout").json()
    r = _put(client, [{"x": 300, "y": 300, "w": 10, "h": 10, "label": "X" * 25}])
    assert r.status_code == 422
    errs = r.json()["field_errors"]
    assert errs[0]["index"] == 0 and set(errs[0]["fields"]) == {"label"}
    assert client.get("/api/layout").json() == before


def test_label_must_be_string(client):
    for bad in (5, 3.5, True, {"a": 1}, ["A"]):
        r = _put(client, [{"x": 300, "y": 300, "w": 10, "h": 10, "label": bad}])
        assert r.status_code == 422, bad
        assert "label" in r.json()["field_errors"][0]["fields"]


def test_label_error_coexists_with_coordinate_errors(client):
    r = _put(client, [{"x": 0, "y": 300, "w": 10, "h": 10, "label": "X" * 25}])
    assert r.status_code == 422
    fields = r.json()["field_errors"][0]["fields"]
    assert set(fields) == {"x", "label"}


def test_overlapping_labeled_windows_keep_labels_in_saved_verdict(client):
    r = _put(client, [
        {"x": 300, "y": 300, "w": 100, "h": 100, "label": "WIN-A"},
        {"x": 350, "y": 350, "w": 100, "h": 100, "label": "WIN-B"},
    ])
    assert r.status_code == 200
    body = r.json()
    assert body["verdict"] == "不可裁切"
    ids_by_label = {w["label"]: w["id"] for w in body["windows"]}
    assert body["result"]["window_conflicts"] == [
        {"window_a": ids_by_label["WIN-A"], "window_b": ids_by_label["WIN-B"]}
    ]

    restored = client.get("/api/layout").json()
    assert [w["label"] for w in restored["windows"]] == ["WIN-A", "WIN-B"]
    assert restored["result"] == body["result"]


# ---------- 定位步长（1/5/10 毫米） ----------

def _put_with_step(client, step, windows):
    return client.put("/api/layout", json={"step": step, "windows": windows})


def test_step_saved_and_restored_after_refresh(client):
    r = _put_with_step(client, 5, [{"x": 302, "y": 302, "w": 105, "h": 60}])
    assert r.status_code == 200, r.text
    assert r.json()["step"] == 5

    restored = client.get("/api/layout").json()
    assert restored["step"] == 5
    assert [(w["x"], w["y"], w["w"], w["h"]) for w in restored["windows"]] == [
        (302, 302, 105, 60)
    ]
    assert restored["verdict"] == "可裁切"


def test_step5_conflict_layout_roundtrip_keeps_verdict_and_highlights(client):
    # 两扇开窗都在 5 毫米刻度上且相互重叠
    r = _put_with_step(client, 5, [
        {"x": 302, "y": 302, "w": 105, "h": 60},
        {"x": 332, "y": 332, "w": 105, "h": 60},
    ])
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["verdict"] == "不可裁切"
    ids = [w["id"] for w in body["windows"]]
    assert body["result"]["conflicting_window_ids"] == sorted(ids)

    # 保存刷新后：坐标、结论与冲突高亮与提交前一致
    restored = client.get("/api/layout").json()
    assert restored["step"] == 5
    assert [(w["x"], w["y"], w["w"], w["h"]) for w in restored["windows"]] == [
        (302, 302, 105, 60),
        (332, 332, 105, 60),
    ]
    assert restored["verdict"] == body["verdict"]
    assert restored["result"] == body["result"]


def test_off_grid_submission_rejected_per_row_and_record_unchanged(client):
    _put_with_step(client, 5, [{"x": 302, "y": 302, "w": 105, "h": 60}])
    before = client.get("/api/layout").json()

    # 绕过页面提交偏离 5 毫米刻度的坐标
    r = _put_with_step(client, 5, [
        {"x": 300, "y": 302, "w": 105, "h": 60},   # x 偏离刻度
        {"x": 302, "y": 302, "w": 103, "h": 60},   # w 偏离刻度
        {"x": 302, "y": 302, "w": 105, "h": 60},   # 合法行
    ])
    assert r.status_code == 422
    rows = r.json()["field_errors"]
    assert [row["index"] for row in rows] == [0, 1]
    assert set(rows[0]["fields"]) == {"x"}
    assert set(rows[1]["fields"]) == {"w"}

    # 不产生新布局：最新记录未改变
    assert client.get("/api/layout").json() == before


def test_all_supported_steps_accepted(client):
    for step in (1, 5, 10):
        r = _put_with_step(client, step, [{"x": 312, "y": 312, "w": 110, "h": 60}])
        assert r.status_code == 200, step
        assert r.json()["step"] == step
        assert client.get("/api/layout").json()["step"] == step


def test_invalid_step_rejected_and_nothing_persisted(client):
    before = client.get("/api/layout").json()
    for bad in (3, "5", 5.0, True, [5]):
        r = _put_with_step(client, bad, [{"x": 302, "y": 302, "w": 105, "h": 60}])
        assert r.status_code == 422, bad
    assert client.get("/api/layout").json() == before


# ---------- 兼容：旧客户端与旧记录一律按 1 毫米处理 ----------

def test_old_client_without_step_defaults_to_1mm(client):
    # 旧客户端：不携带 step，坐标按 1 毫米处理（任意整数合法）
    r = _put(client, [{"x": 300, "y": 301, "w": 101, "h": 62}])
    assert r.status_code == 200, r.text
    assert r.json()["step"] == 1
    assert r.json()["windows"][0]["x"] == 300

    restored = client.get("/api/layout").json()
    assert restored["step"] == 1
    assert [(w["x"], w["y"], w["w"], w["h"]) for w in restored["windows"]] == [
        (300, 301, 101, 62)
    ]


def test_explicit_null_step_defaults_to_1mm(client):
    r = client.put("/api/layout", json={"step": None, "windows": [{"x": 300, "y": 300, "w": 10, "h": 10}]})
    assert r.status_code == 200
    assert r.json()["step"] == 1


# ---------- 圆形开窗（shape=circle，w==h 为直径） ----------

CIRCLE = {"shape": "circle", "x": 640, "y": 380, "w": 40, "h": 40}


def test_circle_tangent_to_defect_is_cuttable_and_persisted_with_shape(client):
    # 圆底点 (660,420) 外切瑕疵 1 上边线：可裁切
    r = _put(client, [CIRCLE])
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["verdict"] == "可裁切"
    assert body["windows"][0]["shape"] == "circle"
    assert (body["windows"][0]["w"], body["windows"][0]["h"]) == (40, 40)

    restored = client.get("/api/layout").json()
    assert restored["windows"][0]["shape"] == "circle"
    assert restored["verdict"] == "可裁切"


def test_circle_intruding_defect_by_one_mm_conflicts(client):
    # 圆心下移 1mm，侵入瑕疵 1 一毫米：不可裁切
    r = _put(client, [{**CIRCLE, "y": 381}])
    assert r.status_code == 200, r.text
    body = r.json()
    win_id = body["windows"][0]["id"]
    assert body["verdict"] == "不可裁切"
    assert body["result"]["defect_conflicts"] == [
        {"window_id": win_id, "defect_index": 1}
    ]
    assert body["result"]["conflicting_window_ids"] == [win_id]


def test_circle_rect_windows_conflict_both_highlighted(client):
    # 圆右移 1mm 侵入矩形开窗：双方进入冲突列表
    r = _put(client, [
        {"shape": "circle", "x": 641, "y": 380, "w": 40, "h": 40},
        {"shape": "rect", "x": 680, "y": 380, "w": 40, "h": 40},
    ])
    assert r.status_code == 200, r.text
    body = r.json()
    ids = [w["id"] for w in body["windows"]]
    assert body["verdict"] == "不可裁切"
    assert body["result"]["window_conflicts"] == [
        {"window_a": ids[0], "window_b": ids[1]}
    ]
    assert body["result"]["conflicting_window_ids"] == sorted(ids)


def test_two_circles_external_tangency_accepted(client):
    # 两圆心距恰好等于半径和（外切）：可裁切；靠近 1mm 即冲突
    r = _put(client, [
        {"shape": "circle", "x": 290, "y": 280, "w": 40, "h": 40},
        {"shape": "circle", "x": 330, "y": 280, "w": 40, "h": 40},
    ])
    assert r.status_code == 200, r.text
    assert r.json()["verdict"] == "可裁切"

    r = _put(client, [
        {"shape": "circle", "x": 290, "y": 280, "w": 40, "h": 40},
        {"shape": "circle", "x": 329, "y": 280, "w": 40, "h": 40},
    ])
    assert r.json()["verdict"] == "不可裁切"


def test_mixed_shape_layout_roundtrip_keeps_shape_and_verdict(client):
    # 混合形状：圆形侵入瑕疵 1，矩形干净 → 不可裁切，刷新后形状与裁决一致
    r = _put(client, [
        {"shape": "rect", "x": 300, "y": 300, "w": 40, "h": 40, "label": "RECT-1"},
        {"shape": "circle", "x": 640, "y": 381, "w": 40, "h": 40, "label": "CIRC-1"},
    ])
    assert r.status_code == 200, r.text
    body = r.json()
    assert [w["shape"] for w in body["windows"]] == ["rect", "circle"]
    circle_id = body["windows"][1]["id"]
    assert body["verdict"] == "不可裁切"
    assert body["result"]["conflicting_window_ids"] == [circle_id]

    restored = client.get("/api/layout").json()
    assert [w["shape"] for w in restored["windows"]] == ["rect", "circle"]
    assert [w["label"] for w in restored["windows"]] == ["RECT-1", "CIRC-1"]
    assert restored["verdict"] == "不可裁切"
    assert restored["result"] == body["result"]


def test_circle_with_unequal_width_height_rejected_per_row(client):
    before = client.get("/api/layout").json()
    r = _put(client, [{"shape": "circle", "x": 300, "y": 300, "w": 40, "h": 41}])
    assert r.status_code == 422
    fields = r.json()["field_errors"][0]["fields"]
    assert set(fields) == {"w", "h"}
    assert all("相等" in msg for msg in fields.values())
    # 整次不落库
    assert client.get("/api/layout").json() == before


def test_invalid_shape_value_rejected_per_row_and_nothing_persisted(client):
    before = client.get("/api/layout").json()
    for bad in ("ellipse", "CIRCLE", 3, True, ["circle"]):
        r = _put(client, [{"shape": bad, "x": 300, "y": 300, "w": 10, "h": 10}])
        assert r.status_code == 422, bad
        assert "shape" in r.json()["field_errors"][0]["fields"], bad
    assert client.get("/api/layout").json() == before


def test_shape_null_and_missing_read_as_rect(client):
    # 显式 null 与旧客户端缺省都按矩形处理
    r = _put(client, [
        {"shape": None, "x": 300, "y": 300, "w": 10, "h": 10},
        {"x": 500, "y": 300, "w": 10, "h": 10},
    ])
    assert r.status_code == 200, r.text
    assert [w["shape"] for w in r.json()["windows"]] == ["rect", "rect"]


def test_explicit_rect_shape_accepted(client):
    r = _put(client, [{"shape": "rect", "x": 300, "y": 300, "w": 10, "h": 10}])
    assert r.status_code == 200
    assert r.json()["windows"][0]["shape"] == "rect"


def test_circle_off_grid_rejected_per_row(client):
    # 圆形直径同样要落在步长刻度上
    r = client.put("/api/layout", json={
        "step": 5,
        "windows": [{"shape": "circle", "x": 302, "y": 302, "w": 41, "h": 41}],
    })
    assert r.status_code == 422
    fields = r.json()["field_errors"][0]["fields"]
    assert set(fields) == {"w", "h"}


def test_circle_on_grid_saved_with_step(client):
    r = client.put("/api/layout", json={
        "step": 5,
        "windows": [{"shape": "circle", "x": 302, "y": 302, "w": 105, "h": 105}],
    })
    assert r.status_code == 200, r.text
    body = r.json()
    assert body["step"] == 5
    assert body["windows"][0]["shape"] == "circle"


def test_bad_shape_and_coordinate_errors_reported_together(client):
    # 非法形状与坐标错误同时报出（坐标仍按矩形规则校验）
    r = _put(client, [{"shape": "oval", "x": 0, "y": 300, "w": 10, "h": 10}])
    assert r.status_code == 422
    assert set(r.json()["field_errors"][0]["fields"]) == {"shape", "x"}
