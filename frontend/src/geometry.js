// 裁决几何：与后端 backend/app/engine.py 同构的前端镜像，
// 用于拖拽过程中的即时高亮；提交以后端裁决为准并落库。
//
// 坐标约定：纸张 1000×700 毫米，左上角为原点，x 向右、y 向下。
// 所有矩形为半开矩形 [x,x+w)×[y,y+h)，仅正面积相交才冲突；
// 边线、角点相接允许。

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

export function isInt(v) {
  return typeof v === "number" && Number.isInteger(v);
}

// 半开矩形正面积相交
export function rectsOverlap(a, b) {
  const overlapW = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const overlapH = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return overlapW > 0 && overlapH > 0;
}

// 逐字段校验，返回 {字段: 信息}；合法为空对象。
// 输入取 number，文本框的原始字符串由调用方先行判断。
export function fieldErrors(x, y, w, h) {
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
  return errors;
}

// 对一批开窗（{id,x,y,w,h}）做完整裁决，结构与后端一致
export function adjudicate(windows) {
  const defectConflicts = [];
  const windowConflicts = [];
  const conflicting = new Set();

  windows.forEach((win) => {
    DEFECTS.forEach((d, i) => {
      if (rectsOverlap(win, d)) {
        defectConflicts.push({ window_id: win.id, defect_index: i });
        conflicting.add(win.id);
      }
    });
  });

  for (let i = 0; i < windows.length; i += 1) {
    for (let j = i + 1; j < windows.length; j += 1) {
      if (rectsOverlap(windows[i], windows[j])) {
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
