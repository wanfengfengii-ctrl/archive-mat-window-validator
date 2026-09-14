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
