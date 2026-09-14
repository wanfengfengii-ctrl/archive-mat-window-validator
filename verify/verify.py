#!/usr/bin/env python3
"""一次性端到端验收脚本（仅用标准库）。

对运行中的真实容器栈打 HTTP 请求：
  - 经 api 直连验证裁决、逐字段错误、整次不落库、刷新恢复；
  - 经 web（nginx 反代）验证前端页面与 /api 代理接线。

任一断言失败即以非零码退出。环境变量：
  API_URL（默认 http://api:8000）
  WEB_URL（默认 http://web）
"""
import json
import os
import sys
import urllib.error
import urllib.request

API_URL = os.getenv("API_URL", "http://api:8000").rstrip("/")
WEB_URL = os.getenv("WEB_URL", "http://web").rstrip("/")

PASS = 0
FAILURES = []


def check(name, cond, detail=""):
    global PASS
    if cond:
        PASS += 1
        print(f"  PASS  {name}")
    else:
        FAILURES.append(name)
        print(f"  FAIL  {name}  {detail}")


def request(method, url, body=None, timeout=10):
    data = json.dumps(body).encode() if body is not None else None
    req = urllib.request.Request(url, data=data, method=method)
    if data is not None:
        req.add_header("Content-Type", "application/json")
    try:
        with urllib.request.urlopen(req, timeout=timeout) as resp:
            return resp.status, json.loads(resp.read().decode())
    except urllib.error.HTTPError as exc:
        return exc.code, json.loads(exc.read().decode())


def section(title):
    print(f"\n== {title} ==")


def main():
    section("1. 健康检查与内置只读瑕疵区")
    status, body = request("GET", f"{API_URL}/api/health")
    check("GET /api/health → 200 ok", status == 200 and body == {"status": "ok"}, body)

    status, body = request("GET", f"{API_URL}/api/defects")
    check(
        "瑕疵区固定为两个半开矩形、纸张 1000×700、边距 12",
        status == 200
        and body["defects"]
        == [
            {"index": 0, "x": 200, "y": 150, "w": 80, "h": 40},
            {"index": 1, "x": 620, "y": 420, "w": 60, "h": 90},
        ]
        and body["sheet"] == {"width": 1000, "height": 700, "margin": 12},
        body,
    )

    section("2. 非法提交：逐字段错误且整次不落库")
    status, before = request("GET", f"{API_URL}/api/layout")
    before_count = len(before["windows"])

    status, body = request(
        "PUT",
        f"{API_URL}/api/layout",
        {"windows": [{"x": 0, "y": 0, "w": 0, "h": 0}]},
    )
    check(
        "四字段全非法 → 422 且逐字段返回 x/y/w/h",
        status == 422
        and body["field_errors"][0]["index"] == 0
        and set(body["field_errors"][0]["fields"]) == {"x", "y", "w", "h"},
        body,
    )

    status, body = request(
        "PUT",
        f"{API_URL}/api/layout",
        {"windows": [{"x": 300.5, "y": "50", "w": 10, "h": True}]},
    )
    check("非整数 JSON 值（300.5/\"50\"/true）→ 422", status == 422, body)

    status, body = request(
        "PUT",
        f"{API_URL}/api/layout",
        {
            "windows": [
                {"x": 300, "y": 300, "w": 10, "h": 10},
                {"x": 300, "y": 900, "w": 10, "h": 10},
            ]
        },
    )
    check(
        "一批中任一开窗非法 → 422 且带正确行号",
        status == 422 and [r["index"] for r in body["field_errors"]] == [1],
        body,
    )

    status, after_bad = request("GET", f"{API_URL}/api/layout")
    check(
        "非法提交后开窗数量不变（整次不落库）",
        len(after_bad["windows"]) == before_count,
        f"{len(after_bad['windows'])} != {before_count}",
    )

    section("3. 合法干净方案 → 可裁切并落库")
    clean = [{"x": 300, "y": 300, "w": 100, "h": 80}, {"x": 500, "y": 100, "w": 40, "h": 40}]
    status, body = request("PUT", f"{API_URL}/api/layout", {"windows": clean})
    check("提交成功", status == 200, body)
    check("唯一结论为 可裁切", body.get("verdict") == "可裁切", body)
    check(
        "返回的开窗坐标与提交一致且含数据库 id/position",
        [(w["x"], w["y"], w["w"], w["h"]) for w in body["windows"]]
        == [(300, 300, 100, 80), (500, 100, 40, 40)]
        and all(isinstance(w["id"], int) for w in body["windows"]),
        body,
    )

    section("4. 刷新恢复同一布局")
    status, restored = request("GET", f"{API_URL}/api/layout")
    check("GET 恢复全部开窗与次序", status == 200 and len(restored["windows"]) == 2, restored)
    check(
        "恢复的坐标一致",
        [(w["x"], w["y"], w["w"], w["h"]) for w in restored["windows"]]
        == [(300, 300, 100, 80), (500, 100, 40, 40)],
        restored,
    )
    check("恢复的裁决仍为 可裁切", restored["verdict"] == "可裁切", restored)

    section("5. 瑕疵区冲突（半开矩形）")
    status, body = request(
        "PUT",
        f"{API_URL}/api/layout",
        {"windows": [{"x": 250, "y": 170, "w": 60, "h": 40}]},
    )
    win_id = body["windows"][0]["id"]
    check(
        "正面积侵入瑕疵区 → 不可裁切，明细指出瑕疵 0",
        body["verdict"] == "不可裁切"
        and body["result"]["defect_conflicts"]
        == [{"window_id": win_id, "defect_index": 0}]
        and body["result"]["conflicting_window_ids"] == [win_id],
        body,
    )
    check("冲突方案同样落库（刷新仍为不可裁切）",
          request("GET", f"{API_URL}/api/layout")[1]["verdict"] == "不可裁切")

    # 边线/角点相接允许
    for rect, label in [
        ({"x": 280, "y": 150, "w": 10, "h": 40}, "右边线相接"),
        ({"x": 200, "y": 190, "w": 80, "h": 10}, "下边线相接"),
        ({"x": 280, "y": 190, "w": 5, "h": 5}, "角点相接"),
    ]:
        status, body = request("PUT", f"{API_URL}/api/layout", {"windows": [rect]})
        check(f"{label} → 可裁切", body["verdict"] == "可裁切", body)

    section("6. 开窗之间冲突（双方高亮）")
    status, body = request(
        "PUT",
        f"{API_URL}/api/layout",
        {
            "windows": [
                {"x": 300, "y": 300, "w": 100, "h": 100},
                {"x": 350, "y": 350, "w": 100, "h": 100},
            ]
        },
    )
    ids = [w["id"] for w in body["windows"]]
    check(
        "重叠 → 不可裁切，双方进入冲突列表",
        body["verdict"] == "不可裁切"
        and body["result"]["window_conflicts"]
        == [{"window_a": ids[0], "window_b": ids[1]}]
        and body["result"]["conflicting_window_ids"] == sorted(ids),
        body,
    )
    status, body = request(
        "PUT",
        f"{API_URL}/api/layout",
        {
            "windows": [
                {"x": 300, "y": 300, "w": 50, "h": 50},
                {"x": 350, "y": 300, "w": 50, "h": 50},
            ]
        },
    )
    check("开窗边线相接 → 可裁切", body["verdict"] == "可裁切", body)

    section("7. 安全区边界")
    status, body = request(
        "PUT",
        f"{API_URL}/api/layout",
        {"windows": [{"x": 12, "y": 600, "w": 976, "h": 88}]},
    )
    check("贴边 12 / x+w=988 / y+h=688 → 可裁切", body["verdict"] == "可裁切", body)
    status, body = request(
        "PUT",
        f"{API_URL}/api/layout",
        {"windows": [{"x": 12, "y": 12, "w": 977, "h": 10}]},
    )
    check("x+w=989 越界 → 422", status == 422, body)

    section("8. 工件编号（可选，布局内唯一）")
    # 两个合法编号保存后刷新原样恢复
    labeled = [
        {"x": 300, "y": 300, "w": 100, "h": 80, "label": "ZW-2026-001"},
        {"x": 500, "y": 100, "w": 40, "h": 40, "label": "ZW-2026-002"},
    ]
    status, body = request("PUT", f"{API_URL}/api/layout", {"windows": labeled})
    check("带编号提交成功", status == 200, body)
    check(
        "响应带回两个编号",
        [w.get("label") for w in body["windows"]] == ["ZW-2026-001", "ZW-2026-002"],
        body,
    )
    status, restored = request("GET", f"{API_URL}/api/layout")
    check(
        "刷新后两个编号原样恢复",
        [w.get("label") for w in restored["windows"]] == ["ZW-2026-001", "ZW-2026-002"],
        restored,
    )

    # 首尾空格被去除后落库
    status, body = request(
        "PUT",
        f"{API_URL}/api/layout",
        {"windows": [{"x": 300, "y": 300, "w": 10, "h": 10, "label": "  TRIM-1  "}]},
    )
    check(
        "编号去首尾空格后保存",
        status == 200 and body["windows"][0]["label"] == "TRIM-1",
        body,
    )

    # 空编号按空值处理（未携带 / null / 全空格）
    status, body = request(
        "PUT",
        f"{API_URL}/api/layout",
        {
            "windows": [
                {"x": 300, "y": 300, "w": 10, "h": 10},
                {"x": 500, "y": 300, "w": 10, "h": 10, "label": None},
                {"x": 700, "y": 300, "w": 10, "h": 10, "label": "   "},
            ]
        },
    )
    check(
        "未携带/null/全空格编号 → 存为空值（页面将显示顺序号）",
        status == 200 and [w["label"] for w in body["windows"]] == [None, None, None],
        body,
    )

    # 重复编号 → 逐行 422 且最新记录不变
    status, before = request("GET", f"{API_URL}/api/layout")
    status, body = request(
        "PUT",
        f"{API_URL}/api/layout",
        {
            "windows": [
                {"x": 300, "y": 300, "w": 10, "h": 10, "label": "DUP"},
                {"x": 500, "y": 300, "w": 10, "h": 10},
                {"x": 700, "y": 300, "w": 10, "h": 10, "label": "DUP"},
            ]
        },
    )
    check(
        "重复编号 → 422 且涉及的两行都报编号字段错误",
        status == 422
        and [r["index"] for r in body["field_errors"]] == [0, 2]
        and all("label" in r["fields"] for r in body["field_errors"]),
        body,
    )
    status, after = request("GET", f"{API_URL}/api/layout")
    check("重复编号提交整批不落库（最新记录不变）", after == before, after)

    # 超长编号 → 422 且整批不落库
    status, body = request(
        "PUT",
        f"{API_URL}/api/layout",
        {"windows": [{"x": 300, "y": 300, "w": 10, "h": 10, "label": "X" * 25}]},
    )
    check(
        "编号超过 24 字符 → 422 且报编号字段",
        status == 422 and "label" in body["field_errors"][0]["fields"],
        body,
    )
    status, after = request("GET", f"{API_URL}/api/layout")
    check("超长编号提交整批不落库", after == before, after)

    # 带编号的重叠开窗：冲突双方即两编号开窗，刷新后编号仍在
    status, body = request(
        "PUT",
        f"{API_URL}/api/layout",
        {
            "windows": [
                {"x": 300, "y": 300, "w": 100, "h": 100, "label": "WIN-A"},
                {"x": 350, "y": 350, "w": 100, "h": 100, "label": "WIN-B"},
            ]
        },
    )
    ids_by_label = {w["label"]: w["id"] for w in body["windows"]}
    check(
        "带编号重叠开窗 → 不可裁切，冲突双方即两编号开窗",
        body["verdict"] == "不可裁切"
        and body["result"]["window_conflicts"]
        == [{"window_a": ids_by_label["WIN-A"], "window_b": ids_by_label["WIN-B"]}]
        and body["result"]["conflicting_window_ids"]
        == sorted(ids_by_label.values()),
        body,
    )
    status, restored = request("GET", f"{API_URL}/api/layout")
    check(
        "刷新后重叠开窗的编号与裁决一并恢复",
        [w["label"] for w in restored["windows"]] == ["WIN-A", "WIN-B"]
        and restored["verdict"] == "不可裁切",
        restored,
    )

    section("9. 定位步长（1/5/10 毫米）")
    # 5 毫米步长随布局保存；开窗相互重叠 → 不可裁切
    status, body = request(
        "PUT",
        f"{API_URL}/api/layout",
        {
            "step": 5,
            "windows": [
                {"x": 302, "y": 302, "w": 105, "h": 60},
                {"x": 332, "y": 332, "w": 105, "h": 60},
            ],
        },
    )
    check("5 毫米步长随布局提交成功", status == 200 and body.get("step") == 5, body)
    check("重叠开窗裁决为不可裁切", body["verdict"] == "不可裁切", body)
    saved_conflicts = body["result"]["conflicting_window_ids"]
    status, restored = request("GET", f"{API_URL}/api/layout")
    check(
        "刷新后步长、坐标、结论与冲突高亮一致",
        restored["step"] == 5
        and [(w["x"], w["y"], w["w"], w["h"]) for w in restored["windows"]]
        == [(302, 302, 105, 60), (332, 332, 105, 60)]
        and restored["verdict"] == "不可裁切"
        and restored["result"]["conflicting_window_ids"] == saved_conflicts,
        restored,
    )

    # 绕过页面提交偏离刻度的坐标 → 逐行字段错误且不产生新布局
    status, before = request("GET", f"{API_URL}/api/layout")
    status, body = request(
        "PUT",
        f"{API_URL}/api/layout",
        {"step": 5, "windows": [{"x": 300, "y": 302, "w": 105, "h": 60}]},
    )
    check(
        "偏离 5 毫米刻度 → 422 且按行返回字段错误",
        status == 422
        and body["field_errors"][0]["index"] == 0
        and "x" in body["field_errors"][0]["fields"],
        body,
    )
    status, after = request("GET", f"{API_URL}/api/layout")
    check("偏离刻度提交不产生新布局（最新记录未改变）", after == before, after)

    # 非法步长值 → 422
    status, body = request(
        "PUT", f"{API_URL}/api/layout", {"step": 3, "windows": []}
    )
    check("非法步长（3 毫米）→ 422", status == 422, body)

    # 旧客户端不携带步长 → 按 1 毫米处理，旧格式请求成功保存
    status, body = request(
        "PUT",
        f"{API_URL}/api/layout",
        {"windows": [{"x": 300, "y": 301, "w": 101, "h": 62}]},
    )
    check(
        "旧格式请求（无步长）按 1 毫米保存",
        status == 200 and body.get("step") == 1 and body["windows"][0]["x"] == 300,
        body,
    )
    status, restored = request("GET", f"{API_URL}/api/layout")
    check("旧格式布局刷新后步长恢复为 1", restored["step"] == 1, restored)

    section("10. 圆形观察窗（矩形↔圆形）")

    # --- 矩形切换圆形后的确定尺寸 ---
    # 先在 5 毫米步长下保存矩形 (307,312) 115×65
    status, body = request(
        "PUT",
        f"{API_URL}/api/layout",
        {"step": 5, "windows": [{"x": 307, "y": 312, "w": 115, "h": 65}]},
    )
    check("矩形方案先保存", status == 200 and body["verdict"] == "可裁切", body)
    # 切换圆形：以宽高中较小值 65 作为直径（恰在 5 毫米刻度上），
    # 位置仍为同一画布上的 (307,312)
    status, body = request(
        "PUT",
        f"{API_URL}/api/layout",
        {
            "step": 5,
            "windows": [
                {"shape": "circle", "x": 307, "y": 312, "w": 65, "h": 65}
            ],
        },
    )
    check(
        "矩形切换圆形后尺寸确定：shape=circle、宽高相等均为直径 65",
        status == 200
        and body["windows"][0]["shape"] == "circle"
        and (body["windows"][0]["w"], body["windows"][0]["h"]) == (65, 65),
        body,
    )

    # --- 圆与瑕疵外切可保存 ---
    # 圆心 (650,400) r=20：圆底点 (650,420) 恰好外切瑕疵 1 上边线 y=420
    tangent_circle = {"shape": "circle", "x": 630, "y": 380, "w": 40, "h": 40}
    status, body = request("PUT", f"{API_URL}/api/layout", {"windows": [tangent_circle]})
    check("圆与瑕疵外切 → 可裁切并保存", status == 200 and body["verdict"] == "可裁切", body)
    check(
        "外切圆形落库后刷新仍为可裁切且形状为 circle",
        request("GET", f"{API_URL}/api/layout")[1]["verdict"] == "可裁切"
        and request("GET", f"{API_URL}/api/layout")[1]["windows"][0]["shape"] == "circle",
    )
    # 圆心下移 1 毫米：侵入瑕疵 1 一毫米即不可裁切
    status, body = request(
        "PUT",
        f"{API_URL}/api/layout",
        {"windows": [{**tangent_circle, "y": 381}]},
    )
    circle_id = body["windows"][0]["id"]
    check(
        "圆侵入瑕疵 1 毫米 → 不可裁切，明细指出瑕疵 1",
        body["verdict"] == "不可裁切"
        and body["result"]["defect_conflicts"]
        == [{"window_id": circle_id, "defect_index": 1}]
        and body["result"]["conflicting_window_ids"] == [circle_id],
        body,
    )

    # 圆心 (310,230) r=50：到瑕疵 0 右下角 (280,190) 距离恰为 50，角部外切允许
    status, body = request(
        "PUT",
        f"{API_URL}/api/layout",
        {"windows": [{"shape": "circle", "x": 260, "y": 180, "w": 100, "h": 100}]},
    )
    check("圆与瑕疵角部外切 → 可裁切", body["verdict"] == "可裁切", body)

    # --- 圆与圆：外切允许，互相侵入即冲突 ---
    status, body = request(
        "PUT",
        f"{API_URL}/api/layout",
        {
            "windows": [
                {"shape": "circle", "x": 290, "y": 280, "w": 40, "h": 40},
                {"shape": "circle", "x": 330, "y": 280, "w": 40, "h": 40},
            ]
        },
    )
    check("两圆外切（圆心距=半径和）→ 可裁切", body["verdict"] == "可裁切", body)
    status, body = request(
        "PUT",
        f"{API_URL}/api/layout",
        {
            "windows": [
                {"shape": "circle", "x": 290, "y": 280, "w": 40, "h": 40},
                {"shape": "circle", "x": 329, "y": 280, "w": 40, "h": 40},
            ]
        },
    )
    check("两圆靠近 1 毫米 → 不可裁切", body["verdict"] == "不可裁切", body)

    # --- 圆与矩形开窗侵入一毫米：双方高亮 ---
    # 矩形 [670,710)×[380,420)：与瑕疵 1 仅在 (670,420) 边线相接，本身干净
    rect_window = {"x": 670, "y": 380, "w": 40, "h": 40}
    # 圆心 (650,400) r=20：圆右点 (670,400) 外切矩形左边线，圆底外切瑕疵 1
    status, body = request(
        "PUT",
        f"{API_URL}/api/layout",
        {"windows": [rect_window, tangent_circle]},
    )
    check("圆与矩形开窗边线外切 → 可裁切", body["verdict"] == "可裁切", body)
    # 圆心右移 1mm：圆右点 671 侵入矩形 1 毫米；圆与瑕疵 1 仍为外切
    status, body = request(
        "PUT",
        f"{API_URL}/api/layout",
        {
            "windows": [
                rect_window,
                {"shape": "circle", "x": 631, "y": 380, "w": 40, "h": 40},
            ]
        },
    )
    ids = [w["id"] for w in body["windows"]]
    check(
        "圆侵入矩形开窗 1 毫米 → 不可裁切，双方进入冲突列表",
        body["verdict"] == "不可裁切"
        and body["result"]["window_conflicts"]
        == [{"window_a": ids[0], "window_b": ids[1]}]
        and body["result"]["conflicting_window_ids"] == sorted(ids)
        and body["result"]["defect_conflicts"] == [],
        body,
    )

    # --- 混合形状布局刷新后类型与裁决一致 ---
    status, body = request(
        "PUT",
        f"{API_URL}/api/layout",
        {
            "windows": [
                {"x": 300, "y": 300, "w": 100, "h": 80, "label": "RECT-1"},
                {
                    "shape": "circle",
                    "x": 630,
                    "y": 381,
                    "w": 40,
                    "h": 40,
                    "label": "CIRC-1",
                },
            ]
        },
    )
    check("混合形状方案提交成功（圆形侵入瑕疵 → 不可裁切）", status == 200, body)
    check(
        "响应中两扇窗形状依次为 rect、circle",
        [w["shape"] for w in body["windows"]] == ["rect", "circle"],
        body,
    )
    status, restored = request("GET", f"{API_URL}/api/layout")
    check(
        "刷新后形状、编号与裁决全部一致",
        status == 200
        and [w["shape"] for w in restored["windows"]] == ["rect", "circle"]
        and [w["label"] for w in restored["windows"]] == ["RECT-1", "CIRC-1"]
        and restored["verdict"] == "不可裁切"
        and restored["result"] == body["result"],
        restored,
    )

    # --- 非法形状与圆形宽高不等：按行字段错误且不写入布局 ---
    status, before = request("GET", f"{API_URL}/api/layout")
    status, body = request(
        "PUT",
        f"{API_URL}/api/layout",
        {"windows": [{"shape": "ellipse", "x": 300, "y": 300, "w": 10, "h": 10}]},
    )
    check(
        "非法形状 → 422 且按行返回 shape 字段错误",
        status == 422 and "shape" in body["field_errors"][0]["fields"],
        body,
    )
    status, body = request(
        "PUT",
        f"{API_URL}/api/layout",
        {"windows": [{"shape": "circle", "x": 300, "y": 300, "w": 40, "h": 41}]},
    )
    check(
        "圆形宽高不等 → 422 且 w/h 两字段都报错",
        status == 422
        and set(body["field_errors"][0]["fields"]) == {"w", "h"}
        and all("相等" in m for m in body["field_errors"][0]["fields"].values()),
        body,
    )
    status, after = request("GET", f"{API_URL}/api/layout")
    check("非法形状/宽高不等提交整批不落库", after == before, after)

    # shape 显式 null 与缺省一律按矩形读取
    status, body = request(
        "PUT",
        f"{API_URL}/api/layout",
        {
            "windows": [
                {"shape": None, "x": 300, "y": 300, "w": 10, "h": 10},
                {"x": 500, "y": 300, "w": 10, "h": 10},
            ]
        },
    )
    check(
        "shape 为 null/缺省 → 按矩形保存（GET 返回 shape=rect）",
        status == 200
        and [w["shape"] for w in body["windows"]] == ["rect", "rect"],
        body,
    )
    # 圆形在 5 毫米步长下直径也须落在刻度上
    status, body = request(
        "PUT",
        f"{API_URL}/api/layout",
        {"step": 5, "windows": [{"shape": "circle", "x": 302, "y": 302, "w": 41, "h": 41}]},
    )
    check("步长 5 下直径偏离刻度 → 422", status == 422, body)

    section("11. 经 web（nginx）反代的端到端接线")
    try:
        with urllib.request.urlopen(f"{WEB_URL}/", timeout=10) as resp:
            html = resp.read().decode()
        check(
            "GET web 根路径返回前端页面",
            resp.status == 200 and "档案装裱排版校验台" in html,
            resp.status,
        )
    except Exception as exc:  # noqa: BLE001
        check("GET web 根路径返回前端页面", False, repr(exc))

    status, body = request("GET", f"{WEB_URL}/api/defects")
    check("web → /api 代理可用（瑕疵区经代理返回）", status == 200 and len(body["defects"]) == 2, body)
    status, body = request(
        "PUT",
        f"{WEB_URL}/api/layout",
        {"windows": [{"x": 700, "y": 100, "w": 30, "h": 30}]},
    )
    check("经 web 代理提交方案 → 可裁切", status == 200 and body["verdict"] == "可裁切", body)

    print(f"\n{'=' * 50}")
    if FAILURES:
        print(f"验收失败：{len(FAILURES)} 项失败，{PASS} 项通过")
        for name in FAILURES:
            print(f"  - {name}")
        sys.exit(1)
    print(f"验收通过：{PASS} 项全部通过")


if __name__ == "__main__":
    main()
