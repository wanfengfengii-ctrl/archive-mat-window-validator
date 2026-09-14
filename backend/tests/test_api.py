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
    assert data == {"verdict": None, "windows": [], "result": None, "created_at": None}


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
