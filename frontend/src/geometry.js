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

// 半开矩形正面积相交
export function rectsOverlap(a, b) {
  const overlapW = Math.min(a.x + a.w, b.x + b.w) - Math.max(a.x, b.x);
  const overlapH = Math.min(a.y + a.h, b.y + b.h) - Math.max(a.y, b.y);
  return overlapW > 0 && overlapH > 0;
}

// 逐字段校验，返回 {字段: 信息}；合法为空对象。
// 输入取 number，文本框的原始字符串由调用方先行判断。
// step 为定位步长（1/5/10 毫米），刻度基准为安全内区左上角。
export function fieldErrors(x, y, w, h, step = DEFAULT_STEP) {
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

  // 刻度校验：字段本身合法时才检查，避免在一个字段上堆叠多条错误
  if (step > 1) {
    if (!errors.x && (x - MARGIN) % step !== 0) errors.x = `x 须符合 ${step} 毫米刻度`;
    if (!errors.y && (y - MARGIN) % step !== 0) errors.y = `y 须符合 ${step} 毫米刻度`;
    if (!errors.w && w % step !== 0) errors.w = `宽须符合 ${step} 毫米刻度`;
    if (!errors.h && h % step !== 0) errors.h = `高须符合 ${step} 毫米刻度`;
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
