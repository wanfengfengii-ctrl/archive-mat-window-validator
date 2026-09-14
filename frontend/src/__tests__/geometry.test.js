import { describe, expect, it } from "vitest";
import {
  DEFAULT_STEP,
  DEFECTS,
  GRID_STEPS,
  INNER_BOTTOM,
  INNER_RIGHT,
  MARGIN,
  MAX_LABEL_LENGTH,
  adjudicate,
  circleFromBbox,
  circleRectOverlap,
  circlesOverlap,
  fieldErrors,
  normalizeShape,
  rectsOverlap,
  snapCircle,
  snapPosition,
  snapRect,
  snapSize,
  snapValue,
  windowName,
} from "../geometry.js";

describe("半开矩形相交", () => {
  it("正面积相交", () => {
    expect(rectsOverlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 5, y: 5, w: 10, h: 10 })).toBe(true);
  });

  it("边线相接允许", () => {
    expect(rectsOverlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 0, w: 10, h: 10 })).toBe(false);
    expect(rectsOverlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 0, y: 10, w: 10, h: 10 })).toBe(false);
  });

  it("角点相接允许", () => {
    expect(rectsOverlap({ x: 0, y: 0, w: 10, h: 10 }, { x: 10, y: 10, w: 10, h: 10 })).toBe(false);
  });

  it("侵入 1mm 即冲突", () => {
    expect(rectsOverlap({ x: 0, y: 0, w: 11, h: 11 }, { x: 10, y: 10, w: 5, h: 5 })).toBe(true);
  });
});

describe("逐字段校验", () => {
  it("边界值合法", () => {
    expect(fieldErrors(MARGIN, MARGIN, INNER_RIGHT - MARGIN, 10)).toEqual({});
  });

  it.each([
    [11, 50, 10, 10, ["x"]],
    [50, 50, 0, 10, ["w"]],
    [50, 50, 10, -1, ["h"]],
    [979, 50, 10, 10, ["x"]],
    [50, 679, 10, 10, ["y"]],
    ["50", 50, 10, 10, ["x"]],
    [3.5, 50, 10, 10, ["x"]],
    [true, 50, 10, 10, ["x"]],
  ])("(%s,%s,%s,%s) 非法字段 %s", (x, y, w, h, keys) => {
    expect(Object.keys(fieldErrors(x, y, w, h)).sort()).toEqual(keys.sort());
  });
});

describe("完整裁决", () => {
  it("干净方案可裁切", () => {
    const out = adjudicate([{ id: 1, x: 300, y: 300, w: 50, h: 50 }]);
    expect(out.verdict).toBe("可裁切");
  });

  it("开窗压瑕疵区 → 不可裁切并给出瑕疵索引", () => {
    const out = adjudicate([{ id: 1, x: 270, y: 180, w: 20, h: 20 }]);
    expect(out.verdict).toBe("不可裁切");
    expect(out.defect_conflicts).toEqual([{ window_id: 1, defect_index: 0 }]);
    expect(out.conflicting_window_ids).toEqual([1]);
  });

  it("开窗边线贴瑕疵区 → 可裁切", () => {
    const out = adjudicate([{ id: 1, x: 280, y: 150, w: 10, h: 10 }]);
    expect(out.verdict).toBe("可裁切");
  });

  it("两个开窗重叠 → 双方高亮", () => {
    const out = adjudicate([
      { id: 1, x: 300, y: 300, w: 50, h: 50 },
      { id: 2, x: 340, y: 340, w: 50, h: 50 },
    ]);
    expect(out.verdict).toBe("不可裁切");
    expect(out.window_conflicts).toEqual([{ window_a: 1, window_b: 2 }]);
    expect(out.conflicting_window_ids).toEqual([1, 2]);
  });

  it("内置瑕疵区坐标只读固定", () => {
    expect(INNER_BOTTOM).toBe(688);
    expect(DEFECTS).toEqual([
      { x: 200, y: 150, w: 80, h: 40 },
      { x: 620, y: 420, w: 60, h: 90 },
    ]);
  });
});

describe("开窗展示名（工件编号或顺序号）", () => {
  it("编号长度上限与后端一致", () => {
    expect(MAX_LABEL_LENGTH).toBe(24);
  });

  it("填写了编号就用编号（去首尾空格）", () => {
    expect(windowName({ label: "ZW-001" }, 0)).toBe("ZW-001");
    expect(windowName({ label: "  ZW-001  " }, 2)).toBe("ZW-001");
  });

  it("未填写编号时退回顺序号", () => {
    expect(windowName({ label: "" }, 0)).toBe("#1");
    expect(windowName({ label: null }, 1)).toBe("#2");
    expect(windowName({}, 2)).toBe("#3");
    expect(windowName({ label: "   " }, 3)).toBe("#4");
  });
});

describe("定位步长吸附", () => {
  it("步长选项与默认值", () => {
    expect(GRID_STEPS).toEqual([1, 5, 10]);
    expect(DEFAULT_STEP).toBe(1);
  });

  it("取最近刻度，恰好居中时取较小值", () => {
    expect(snapValue(3, 5)).toBe(5);
    expect(snapValue(2, 5)).toBe(0);
    expect(snapValue(2.5, 5)).toBe(0); // 居中 → 较小值
    expect(snapValue(7.5, 5)).toBe(5);
    expect(snapValue(5, 10)).toBe(0); // 10 毫米步长的居中点
    expect(snapValue(15, 10)).toBe(10);
    expect(snapValue(16, 10)).toBe(20);
  });

  it("位置刻度以安全内区左上角为基准", () => {
    expect(snapPosition(12, 5)).toBe(12);
    expect(snapPosition(13, 5)).toBe(12);
    expect(snapPosition(16, 5)).toBe(17);
    expect(snapPosition(301, 5)).toBe(302);
    // 基准之下取最近合法刻度，即基准本身
    expect(snapPosition(5, 5)).toBe(12);
    expect(snapPosition(0, 10)).toBe(12);
  });

  it("尺寸最小为一个步长，不超过内区跨度", () => {
    expect(snapSize(2, 5, 976)).toBe(5);
    expect(snapSize(108, 5, 976)).toBe(110);
    expect(snapSize(107, 5, 976)).toBe(105);
    expect(snapSize(2000, 5, 976)).toBe(975); // 976 内最大 5 的倍数
    expect(snapSize(2000, 10, 976)).toBe(970);
    expect(snapSize(0, 1, 976)).toBe(1);
  });

  it("靠近右侧或下侧时回退到最后一个容得下整窗的刻度", () => {
    // w=100：最后容得下的刻度为 888（888+100=988）
    expect(snapRect(950, 300, 100, 60, 1)).toEqual({ x: 888, y: 300, w: 100, h: 60 });
    // 5 毫米步长、w=105：最后容得下的刻度为 882（12+174×5，882+105=987≤988）
    expect(snapRect(950, 300, 105, 60, 5)).toEqual({ x: 882, y: 302, w: 105, h: 60 });
    // 下侧同理：h=60 时 y 回退到 628（628+60=688）
    expect(snapRect(300, 660, 100, 60, 1)).toEqual({ x: 300, y: 628, w: 100, h: 60 });
  });

  it("整窗吸附：位置与尺寸都取最近合法刻度", () => {
    expect(snapRect(301, 303, 108, 59, 5)).toEqual({ x: 302, y: 302, w: 110, h: 60 });
    expect(snapRect(306, 311, 113, 64, 5)).toEqual({ x: 307, y: 312, w: 115, h: 65 });
    // 1 毫米步长下坐标原样（仅越界回退）
    expect(snapRect(300, 301, 101, 62, 1)).toEqual({ x: 300, y: 301, w: 101, h: 62 });
  });
});

describe("刻度校验（逐字段）", () => {
  it("1 毫米步长不附加刻度错误", () => {
    expect(fieldErrors(300, 301, 101, 62)).toEqual({});
    expect(fieldErrors(300, 301, 101, 62, 1)).toEqual({});
  });

  it("5 毫米步长：落在刻度上合法，偏离则逐字段报错", () => {
    expect(fieldErrors(302, 302, 105, 60, 5)).toEqual({});
    const errs = fieldErrors(300, 303, 103, 62, 5);
    expect(Object.keys(errs).sort()).toEqual(["h", "w", "x", "y"]);
    expect(errs.x).toContain("刻度");
  });

  it("刻度错误不与安全区错误堆叠在同一字段", () => {
    const errs = fieldErrors(0, 302, 105, 60, 5);
    expect(Object.keys(errs)).toEqual(["x"]);
    expect(errs.x).toContain("≥ 12");
  });
});

describe("圆形开窗几何", () => {
  it("形状规范化：缺省按矩形，非法值为 null", () => {
    expect(normalizeShape(undefined)).toBe("rect");
    expect(normalizeShape(null)).toBe("rect");
    expect(normalizeShape("circle")).toBe("circle");
    expect(normalizeShape("CIRCLE")).toBeNull();
    expect(normalizeShape(3)).toBeNull();
  });

  it("圆与瑕疵外切允许（整数放大坐标精确判定）", () => {
    // 圆心 (660,400) r=20，圆底点 (660,420) 外切瑕疵 1 上边线
    const tangent = { shape: "circle", x: 640, y: 380, w: 40, h: 40 };
    expect(adjudicate([{ id: 1, ...tangent }]).verdict).toBe("可裁切");
    // 圆心下移 1mm：侵入 1mm 即冲突
    const intruding = { id: 2, shape: "circle", x: 640, y: 381, w: 40, h: 40 };
    const out = adjudicate([intruding]);
    expect(out.verdict).toBe("不可裁切");
    expect(out.defect_conflicts).toEqual([{ window_id: 2, defect_index: 1 }]);
  });

  it("圆与瑕疵角部外切允许，靠近 1mm 即冲突", () => {
    // 圆心 (310,230) r=50，到瑕疵 0 右下角 (280,190) 距离恰为 50
    const tangent = { shape: "circle", x: 260, y: 180, w: 100, h: 100 };
    expect(circleRectOverlap(circleFromBbox(260, 180, 100, 100), DEFECTS[0])).toBe(false);
    expect(adjudicate([{ id: 1, ...tangent }]).verdict).toBe("可裁切");
    const near = { id: 1, shape: "circle", x: 259, y: 180, w: 100, h: 100 };
    expect(adjudicate([near]).verdict).toBe("不可裁切");
  });

  it("两圆外切允许，互相侵入即冲突", () => {
    const c1 = { id: 1, shape: "circle", x: 290, y: 280, w: 40, h: 40 };
    const tangent = { id: 2, shape: "circle", x: 330, y: 280, w: 40, h: 40 };
    expect(adjudicate([c1, tangent]).verdict).toBe("可裁切");
    const overlap = { id: 2, shape: "circle", x: 329, y: 280, w: 40, h: 40 };
    const out = adjudicate([c1, overlap]);
    expect(out.verdict).toBe("不可裁切");
    expect(out.window_conflicts).toEqual([{ window_a: 1, window_b: 2 }]);
    expect(out.conflicting_window_ids).toEqual([1, 2]);
  });

  it("半整数半径圆的外切在放大坐标下精确成立", () => {
    // r=20 与 r=19.5：圆心距 39.5 恰好外切；38.5 时相交
    const a = circleFromBbox(290, 280, 40, 40);
    expect(circlesOverlap(a, circleFromBbox(330, 280, 39, 39))).toBe(false);
    expect(circlesOverlap(a, circleFromBbox(329, 280, 39, 39))).toBe(true);
  });

  it("圆与矩形开窗：边线外切允许，侵入 1mm 双方冲突", () => {
    const rect = { id: 1, shape: "rect", x: 680, y: 380, w: 40, h: 40 };
    const tangent = { id: 2, shape: "circle", x: 640, y: 380, w: 40, h: 40 };
    expect(adjudicate([rect, tangent]).verdict).toBe("可裁切");
    const intruding = { id: 2, shape: "circle", x: 641, y: 380, w: 40, h: 40 };
    const out = adjudicate([rect, intruding]);
    expect(out.verdict).toBe("不可裁切");
    expect(out.conflicting_window_ids).toEqual([1, 2]);
  });

  it("圆形宽高必须相等（直径），矩形不受此约束", () => {
    expect(Object.keys(fieldErrors(300, 300, 40, 41, 1, "circle")).sort()).toEqual(["h", "w"]);
    expect(fieldErrors(300, 300, 40, 40, 1, "circle")).toEqual({});
    expect(fieldErrors(300, 300, 40, 41, 1, "rect")).toEqual({});
  });

  it("圆形直径同样要落在步长刻度上", () => {
    const errs = fieldErrors(302, 302, 103, 103, 5, "circle");
    expect(Object.keys(errs).sort()).toEqual(["h", "w"]);
    expect(fieldErrors(302, 302, 105, 105, 5, "circle")).toEqual({});
  });

  it("缺少 shape 的旧开窗按矩形裁决", () => {
    const out = adjudicate([
      { id: 1, x: 300, y: 300, w: 50, h: 50 },
      { id: 2, x: 340, y: 340, w: 50, h: 50 },
    ]);
    expect(out.verdict).toBe("不可裁切");
    expect(out.window_conflicts).toEqual([{ window_a: 1, window_b: 2 }]);
  });
});

describe("圆形步长吸附", () => {
  it("直径取最近刻度，位置按直径回退到容得下圆的刻度", () => {
    // 拖出 113×64 的外接框：直径取较小值 64 → 65
    expect(snapCircle(306, 311, 64, 5)).toEqual({ x: 307, y: 312, w: 65, h: 65 });
  });

  it("1 毫米步长下圆形吸附保持整数直径与相等宽高", () => {
    expect(snapCircle(641, 380, 40, 1)).toEqual({ x: 641, y: 380, w: 40, h: 40 });
  });

  it("圆形直径不超过两个方向上内区跨度的较小值", () => {
    const out = snapCircle(12, 12, 2000, 10);
    expect(out.w).toBe(670); // 676 内最大 10 的倍数
    expect(out.h).toBe(out.w);
  });
});
