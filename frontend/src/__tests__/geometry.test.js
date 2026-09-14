import { describe, expect, it } from "vitest";
import {
  DEFECTS,
  INNER_BOTTOM,
  INNER_RIGHT,
  MARGIN,
  adjudicate,
  fieldErrors,
  rectsOverlap,
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
