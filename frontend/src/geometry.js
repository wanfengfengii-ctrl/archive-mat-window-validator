// 裁决几何：与后端 backend/app/engine.py 同构的前端镜像，
// 用于拖拽过程中的即时高亮；提交以后端裁决为准并落库。
//
// 坐标约定：纸张 1000×700 毫米，左上角为原点，x 向右、y 向下。
// 矩形为半开矩形 [x,x+w)×[y,y+h)，仅正面积相交才冲突；
// 边线、角点相接允许。
//
// 开窗形状：rect（矩形，缺省）与 circle（圆形，w==h 为直径）。
// 圆的相交同样按正面积相交裁决，外切允许。所有几何量在整数
// 放大坐标（值×2）上精确比较，不使用浮点。

export const SHEET_WIDTH = 1000;
export const SHEET_HEIGHT = 700;
export const MARGIN = 12;
export const INNER_RIGHT = SHEET_WIDTH - MARGIN; // 988
export const INNER_BOTTOM = SHEET_HEIGHT - MARGIN; // 688

// 内置只读瑕疵区（事实来源在后端，此处仅用于绘制与即时预览）
export const DEFECTS = [
  { x: 200, y: 150, w: 80, h: 40 }, // [200,280) × [150,190)
  { x: 620, y: 420, w: 60, h: 90 }, // [620,680) × [420,510)
];

export const VERDICT_CUTTABLE = "可裁切";
export const VERDICT_REJECTED = "不可裁切";

// 开窗形状：旧请求与旧记录缺少类型时按矩形读取
export const SHAPE_RECT = "rect";
export const SHAPE_CIRCLE = "circle";
export const SHAPES = [SHAPE_RECT, SHAPE_CIRCLE];

// 工件编号（可选）：去首尾空格后最长 24 字符，同一布局内唯一（后端为准）
export const MAX_LABEL_LENGTH = 24;

// 定位步长（毫米）：1 / 5 / 10，默认 1（旧客户端与旧记录）
export const GRID_STEPS = [1, 5, 10];
export const DEFAULT_STEP = 1;

// 开窗展示名：填了工件编号用编号（去首尾空格），未填写退回顺序号 #1、#2…
// 画布、列表、冲突说明统一使用，保证技师按编号定位每一扇窗。
export function windowName(win, index) {
  const label = (win?.label ?? "").trim();
  return label === "" ? `#${index + 1}` : label;
}

export function isInt(v) {
  return typeof v === "number" && Number.isInteger(v);
}

// 形状规范化：缺省/null 按矩形；非法值返回 null（由调用方报字段错误）
export function normalizeShape(raw) {
  if (raw == null) return SHAPE_RECT;
  return SHAPES.includes(raw) ? raw : null;
}

// 由外接矩形 (x,y,w,h) 求整数放大坐标下的圆：
// 圆心与半径整体放大 2 倍（cx2=2x+w、r2=w），半整数圆心也落在整数坐标上
export function circleFromBbox(x, y, w, h) {
  return { cx2: 2 * x + w, cy2: 2 * y + h, r2: w };
}

// 半开矩形正面积相交
export function rectsOverlap(a, b) {
  const overlapW = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const overlapH = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return overlapW > 0 && overlapH > 0;
}

// 圆与半开矩形正面积相交：圆心到矩形闭区域最近点距离 < 半径；
// 所有量放大 2 倍为整数，平方精确比较，外切（含角部外切）允许
export function circleRectOverlap(circle, rect) {
  const qx2 = Math.min(Math.max(circle.cx2, 2 * rect.x), 2 * (rect.x + rect.w));
  const qy2 = Math.min(Math.max(circle.cy2, 2 * rect.y), 2 * (rect.y + rect.h));
  const dx2 = qx2 - circle.cx2;
  const dy2 = qy2 - circle.cy2;
  return dx2 * dx2 + dy2 * dy2 < circle.r2 * circle.r2;
}

// 两圆正面积相交：圆心距 < 半径和；外切允许（平方精确比较）
export function circlesOverlap(a, b) {
  const dx2 = a.cx2 - b.cx2;
  const dy2 = a.cy2 - b.cy2;
  const rr2 = a.r2 + b.r2;
  return dx2 * dx2 + dy2 * dy2 < rr2 * rr2;
}

// 两个开窗形状的正面积相交
export function shapesOverlap(a, b) {
  const sa = a.shape ?? SHAPE_RECT;
  const sb = b.shape ?? SHAPE_RECT;
  if (sa === SHAPE_RECT && sb === SHAPE_RECT) {
    return rectsOverlap(a, b);
  }
  if (sa === SHAPE_CIRCLE && sb === SHAPE_CIRCLE) {
    return circlesOverlap(circleFromBbox(a.x, a.y, a.w, a.h), circleFromBbox(b.x, b.y, b.w, b.h));
  }
  if (sa === SHAPE_CIRCLE) {
    return circleRectOverlap(circleFromBbox(a.x, a.y, a.w, a.h), b);
  }
  return circleRectOverlap(circleFromBbox(b.x, b.y, b.w, b.h), a);
}

// 逐字段校验，返回 {字段: 信息}；合法为空对象。
// 输入取 number，文本框的原始字符串由调用方先行判断。
// step 为定位步长（1/5/10 毫米），刻度基准为安全内区左上角。
export function fieldErrors(x, y, w, h, step = DEFAULT_STEP, shape = SHAPE_RECT) {
  const errors = {};
  if (!isInt(x)) errors.x = "x 必须为整数";
  else if (x < MARGIN) errors.x = `x 必须 ≥ ${MARGIN}`;

  if (!isInt(y)) errors.y = "y 必须为整数";
  else if (y < MARGIN) errors.y = `y 必须 ≥ ${MARGIN}`;

  if (!isInt(w)) errors.w = "宽必须为整数";
  else if (w < 1) errors.w = "宽至少为 1";

  if (!isInt(h)) errors.h = "高必须为整数";
  else if (h < 1) errors.h = "高至少为 1";

  if (isInt(x) && isInt(w) && w >= 1 && x >= MARGIN && x + w > INNER_RIGHT) {
    errors.x = `x+宽 必须 ≤ ${INNER_RIGHT}`;
  }
  if (isInt(y) && isInt(h) && h >= 1 && y >= MARGIN && y + h > INNER_BOTTOM) {
    errors.y = `y+高 必须 ≤ ${INNER_BOTTOM}`;
  }

  // 圆形：宽高必须相等（直径），字段本身合法时才检查，不堆叠
  if (shape === SHAPE_CIRCLE && isInt(w) && isInt(h) && w >= 1 && h >= 1 && w !== h) {
    errors.w = "圆形开窗宽高必须相等（直径）";
    errors.h = "圆形开窗宽高必须相等（直径）";
  }

  // 刻度校验：字段本身合法时才检查，避免在一个字段上堆叠多条错误
  if (step > 1) {
    if (!errors.x && (x - MARGIN) % step !== 0) errors.x = `x 须符合 ${step} 毫米刻度`;
    if (!errors.y && (y - MARGIN) % step !== 0) errors.y = `y 须符合 ${step} 毫米刻度`;
    if (!errors.w && w % step !== 0) errors.w = `宽须符合 ${step} 毫米刻度`;
    if (!errors.h && h % step !== 0) errors.h = `高须符合 ${step} 毫米刻度`;
  }
  return errors;
}

// 对一批开窗（{id,shape,x,y,w,h}）做完整裁决，结构与后端一致
export function adjudicate(windows) {
  const defectConflicts = [];
  const windowConflicts = [];
  const conflicting = new Set();

  windows.forEach((win) => {
    const shape = win.shape ?? SHAPE_RECT;
    DEFECTS.forEach((d, i) => {
      const hit =
        shape === SHAPE_CIRCLE
          ? circleRectOverlap(circleFromBbox(win.x, win.y, win.w, win.h), d)
          : rectsOverlap(win, d);
      if (hit) {
        defectConflicts.push({ window_id: win.id, defect_index: i });
        conflicting.add(win.id);
      }
    });
  });

  for (let i = 0; i < windows.length; i += 1) {
    for (let j = i + 1; j < windows.length; j += 1) {
      if (shapesOverlap(windows[i], windows[j])) {
        windowConflicts.push({ window_a: windows[i].id, window_b: windows[j].id });
        conflicting.add(windows[i].id);
        conflicting.add(windows[j].id);
      }
    }
  }

  return {
    verdict:
      defectConflicts.length === 0 && windowConflicts.length === 0
        ? VERDICT_CUTTABLE
        : VERDICT_REJECTED,
    defect_conflicts: defectConflicts,
    window_conflicts: windowConflicts,
    // 按开窗在数组中的次序稳定输出，便于测试比对
    conflicting_window_ids: windows
      .map((w) => w.id)
      .filter((id) => conflicting.has(id)),
  };
}

// 把任意坐标夹到安全区内
export function clampIntoInner(x, y) {
  return [
    Math.min(Math.max(x, MARGIN), INNER_RIGHT),
    Math.min(Math.max(y, MARGIN), INNER_BOTTOM),
  ];
}

// --- 定位步长吸附：拖放、移动、表单编辑共用同一条规则 ---

// 最近合法刻度；恰好居中时取较小值（+ 0 把 -0 归一为 0）
export function snapValue(v, step) {
  return step * Math.ceil(v / step - 0.5) + 0;
}

// 位置吸附：刻度以安全内区左上角 (MARGIN, MARGIN) 为基准；
// 小于基准的输入取最近合法刻度，即基准本身
export function snapPosition(v, step) {
  return MARGIN + Math.max(0, snapValue(v - MARGIN, step));
}

// 尺寸吸附：最近刻度，最小为 step，最大为内区跨度内容得下的最大刻度
export function snapSize(v, step, span) {
  const maxSize = step * Math.floor(span / step);
  return Math.min(Math.max(step, snapValue(v, step)), maxSize);
}

// 单轴位置吸附：取最近刻度；靠近右/下侧时回退到最后一个
// 容得下整窗（尺寸 size）的刻度
function snapStart(v, size, step, innerEdge) {
  const lastFit = MARGIN + step * Math.floor((innerEdge - size - MARGIN) / step);
  return Math.min(snapPosition(v, step), lastFit);
}

// 整窗吸附：位置与尺寸都取最近合法刻度，并保证整窗留在安全区内
export function snapRect(x, y, w, h, step) {
  const sw = snapSize(w, step, INNER_RIGHT - MARGIN);
  const sh = snapSize(h, step, INNER_BOTTOM - MARGIN);
  return {
    x: snapStart(x, sw, step, INNER_RIGHT),
    y: snapStart(y, sh, step, INNER_BOTTOM),
    w: sw,
    h: sh,
  };
}

// 圆形吸附：直径取最近刻度，且必须在两个方向上都容得下整圆；
// 位置按直径回退到最后一个容得下圆的刻度，与矩形共用同一套规则
export function snapCircle(x, y, diameter, step) {
  const span = Math.min(INNER_RIGHT - MARGIN, INNER_BOTTOM - MARGIN);
  const sd = snapSize(diameter, step, span);
  return {
    x: snapStart(x, sd, step, INNER_RIGHT),
    y: snapStart(y, sd, step, INNER_BOTTOM),
    w: sd,
    h: sd,
  };
}
