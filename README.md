# 档案装裱排版校验台

在 1000×700 毫米卡纸上安排观察窗，提交后由裁决引擎判断方案
**可裁切 / 不可裁切**，并高亮全部冲突（开窗侵入内置瑕疵区、开窗彼此正面积相交、
越过压边安全区等）。合法方案与完整裁决结果落 PostgreSQL，刷新/重启后恢复同一布局。

- **Web**：React + Vite，支持在纸面上**拖放开窗**、拖动移位、填写 x/y/宽/高
- **API**：FastAPI + SQLAlchemy，逐字段校验、整批事务落库
- **DB**：PostgreSQL 16
- 前端（Vitest + Testing Library）与后端（pytest）均有测试

## 坐标约定（务必先读）

- 纸张固定 **1000 × 700 毫米**，**左上角为原点**，x 轴向右、y 轴向下。
- 开窗坐标与尺寸必须为**整数**；宽、高**至少为 1**。
- **压边安全区**：可用内区满足
  `12 ≤ x`、`x+w ≤ 988`、`12 ≤ y`、`y+h ≤ 688`。
- **半开矩形**：开窗与瑕疵区均为 `[x, x+w) × [y, y+h)`。
  只有**正面积相交**才算冲突；**边线相接、角点相接允许**。
  - 例如开窗左边线正好贴瑕疵区右边线（两个区间端点相同）不冲突；互相侵入 1 毫米即冲突。
- **内置只读瑕疵区**（裁决引擎内置，不随方案保存，页面上没有任何录入/编辑入口）：
  - `[200,280) × [150,190)`
  - `[620,680) × [420,510)`
- 开窗之间使用同一条半开矩形正面积相交规则。

## 启动（Docker Compose）

应用组件只有 **web** 与 **api** 两个；`db` 是 PostgreSQL 支撑服务。

```bash
docker compose up --build
```

- 前端（Web）：http://localhost:8080
- 后端（API）：http://localhost:8000  （Swagger 文档：/docs）

宿主端口可用环境变量覆盖：

```bash
WEB_PORT=9090 API_PORT=9000 docker compose up --build
# 或写入 .env（见 .env.example）
```

## 一次性验收服务

`verify` 是跑完即退的一次性服务，对运行中的真实容器栈打 HTTP 请求，
覆盖：健康检查、内置瑕疵区、逐字段 422 错误且整次不落库、合法落库、
刷新恢复、半开矩形边界、双方冲突高亮、安全区边界、web → /api 反代接线。

```bash
docker compose up --build -d
docker compose run --rm verify
```

全部断言通过时退出码为 0。

## 本地运行测试

后端（裁决引擎为纯函数；API 测试用 SQLite 内存库跑同样的模型与路由）：

```bash
cd backend
pip install -r requirements.txt -r requirements-dev.txt
pytest
```

前端：

```bash
cd frontend
npm install
npm test          # Vitest 一次运行
npm run dev       # 本地开发（/api 代理到 localhost:8000）
```

## HTTP 接口

| 方法 | 路径 | 说明 |
| --- | --- | --- |
| GET | `/api/health` | 健康检查 |
| GET | `/api/defects` | 内置只读瑕疵区与纸张/边距常量（仅用于绘制） |
| GET | `/api/layout` | 读取最近一次合法提交（开窗 + 完整裁决）；无提交时为空布局 |
| PUT | `/api/layout` | 整批提交并裁决 |

提交体：

```json
{ "windows": [ { "x": 300, "y": 300, "w": 100, "h": 80 } ] }
```

- 任一字段非法（非 JSON 整数、宽高 < 1、越过安全区、缺字段等）→ **422**，
  响应按开窗行号给出**逐字段错误**，且**整次提交不落库**。
- 合法（即使裁决为“不可裁切”）→ **200**，保存全部开窗与完整裁决：

```json
{
  "verdict": "不可裁切",
  "windows": [{ "id": 11, "position": 0, "x": 250, "y": 170, "w": 60, "h": 40 }],
  "result": {
    "verdict": "不可裁切",
    "defect_conflicts": [{ "window_id": 11, "defect_index": 0 }],
    "window_conflicts": [],
    "conflicting_window_ids": [11]
  }
}
```

页面始终只展示唯一结论：**可裁切** 或 **不可裁切**；
`conflicting_window_ids` 中的开窗与被命中的瑕疵区全部高亮。

## 目录结构

```
.
├── docker-compose.yml      # web / api 两个应用 + db + 一次性 verify
├── verify/verify.py        # 端到端验收脚本（纯标准库）
├── backend/                # FastAPI + SQLAlchemy
│   ├── app/engine.py       # 裁决引擎（半开矩形、逐字段校验、瑕疵区常量）
│   ├── app/validation.py   # 原始 JSON 整数校验（拒绝 3.5 / "5" / true）
│   └── tests/              # pytest
└── frontend/               # React + Vite
    ├── src/geometry.js     # 与引擎同构的前端镜像（即时预览，后端为准）
    └── src/__tests__/      # Vitest
```
