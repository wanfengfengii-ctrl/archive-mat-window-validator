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

    section("8. 经 web（nginx）反代的端到端接线")
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
