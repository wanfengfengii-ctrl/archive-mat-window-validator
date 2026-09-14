import { fireEvent, render, screen, waitFor, within } from "@testing-library/react";
import { beforeEach, describe, expect, it, vi } from "vitest";
import App from "../App.jsx";

vi.mock("../api.js", () => ({
  fetchDefects: vi.fn(),
  fetchLayout: vi.fn(),
  submitLayout: vi.fn(),
}));

import { fetchDefects, fetchLayout, submitLayout } from "../api.js";

const cleanResult = {
  defect_conflicts: [],
  window_conflicts: [],
  conflicting_window_ids: [],
};

// jsdom 的 PointerEvent init 不携带 clientX/clientY，
// 这里用 MouseEvent 派发 pointer* 类型事件（React 按 type 绑定监听）。
function firePointer(node, type, x, y) {
  const ev = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
  });
  node.dispatchEvent(ev);
}

function dragDraw(svg, x1, y1, x2, y2) {
  firePointer(svg, "pointerdown", x1, y1);
  firePointer(window, "pointermove", x2, y2);
  firePointer(window, "pointerup", x2, y2);
}

beforeEach(() => {
  vi.mocked(fetchDefects).mockResolvedValue({
    defects: [
      { index: 0, x: 200, y: 150, w: 80, h: 40 },
      { index: 1, x: 620, y: 420, w: 60, h: 90 },
    ],
    sheet: { width: 1000, height: 700, margin: 12 },
  });
  vi.mocked(fetchLayout).mockResolvedValue({
    verdict: null,
    windows: [],
    result: null,
    created_at: null,
  });
  vi.mocked(submitLayout).mockReset();
});

describe("加载与恢复", () => {
  it("刷新后恢复同一布局并显示已保存裁决", async () => {
    vi.mocked(fetchLayout).mockResolvedValue({
      verdict: "不可裁切",
      windows: [{ id: 11, position: 0, x: 250, y: 170, w: 60, h: 30 }],
      result: {
        verdict: "不可裁切",
        defect_conflicts: [{ window_id: 11, defect_index: 0 }],
        window_conflicts: [],
        conflicting_window_ids: [11],
      },
      created_at: "2026-09-14T00:00:00Z",
    });
    render(<App />);

    await screen.findByText(/#1 \(250, 170\) 60×30/);
    const banner = await screen.findByTestId("verdict-banner");
    expect(banner).toHaveAttribute("data-verdict", "不可裁切");
    expect(banner.textContent).toContain("已保存");
    // 冲突开窗在列表中高亮
    const row = await screen.findByTestId("list-row-0");
    expect(row.className).toContain("row-conflict");
  });
});

describe("拖放开窗与即时裁决", () => {
  it("在空白区拖放开窗，干净方案即时显示可裁切", async () => {
    render(<App />);
    await screen.findByText(/提交方案并裁决/);
    const svg = document.querySelector(".sheet");

    dragDraw(svg, 300, 300, 400, 360);

    expect(await screen.findByText(/#1 \(300, 300\) 100×60/)).toBeInTheDocument();
    const banner = screen.getByTestId("verdict-banner");
    expect(banner).toHaveAttribute("data-verdict", "可裁切");
    expect(banner.textContent).toContain("未保存预览");
    // 干净开窗不高亮
    expect(document.querySelector(".window-conflict")).toBeNull();
  });

  it("开窗压到瑕疵区即时显示不可裁切并高亮全部冲突", async () => {
    render(<App />);
    const svg = document.querySelector(".sheet");
    // 侵入第一个瑕疵区 [200,280)×[150,190)
    dragDraw(svg, 220, 160, 260, 185);

    const banner = await screen.findByTestId("verdict-banner");
    expect(banner).toHaveAttribute("data-verdict", "不可裁切");
    expect(document.querySelector(".window-conflict")).not.toBeNull();
    expect(document.querySelector(".defect-hit")).not.toBeNull();
  });

  it("边线相贴不算冲突", async () => {
    render(<App />);
    const svg = document.querySelector(".sheet");
    // 左边线贴瑕疵区右边线 x=280
    dragDraw(svg, 280, 150, 320, 180);
    await screen.findByText(/#1 \(280, 150\) 40×30/);
    expect(screen.getByTestId("verdict-banner")).toHaveAttribute("data-verdict", "可裁切");
  });
});

describe("表单编辑", () => {
  it("选中后填写 x/y/宽/高，失焦生效并重新裁决", async () => {
    render(<App />);
    const svg = document.querySelector(".sheet");
    dragDraw(svg, 300, 300, 400, 360);
    fireEvent.click(await screen.findByText(/#1 \(300, 300\) 100×60/));

    const xInput = screen.getByLabelText("x（毫米）");
    fireEvent.change(xInput, { target: { value: "500" } });
    fireEvent.blur(xInput);

    await screen.findByText(/#1 \(500, 300\) 100×60/);
  });

  it("非整数输入被忽略", async () => {
    render(<App />);
    const svg = document.querySelector(".sheet");
    dragDraw(svg, 300, 300, 400, 360);
    fireEvent.click(await screen.findByText(/#1 \(300, 300\) 100×60/));

    const wInput = screen.getByLabelText("宽（毫米）");
    fireEvent.change(wInput, { target: { value: "abc" } });
    fireEvent.blur(wInput);
    expect(await screen.findByText(/#1 \(300, 300\) 100×60/)).toBeInTheDocument();
  });

  it("表单把 x 改到越过安全区时即时显示不可裁切并高亮", async () => {
    render(<App />);
    const svg = document.querySelector(".sheet");
    dragDraw(svg, 300, 300, 400, 360);
    expect((await screen.findByTestId("verdict-banner")).getAttribute("data-verdict")).toBe(
      "可裁切"
    );
    fireEvent.click(screen.getByText(/#1 \(300, 300\) 100×60/));

    const xInput = screen.getByLabelText("x（毫米）");
    fireEvent.change(xInput, { target: { value: "950" } }); // 950+100 > 988
    fireEvent.blur(xInput);

    await waitFor(() =>
      expect(screen.getByTestId("verdict-banner")).toHaveAttribute("data-verdict", "不可裁切")
    );
    expect(document.querySelector(".window-conflict")).not.toBeNull();
  });
});

describe("提交与逐字段错误", () => {
  it("合法提交成功后展示唯一的已保存可裁切结论", async () => {
    render(<App />);
    const svg = document.querySelector(".sheet");
    dragDraw(svg, 300, 300, 400, 360);
    await screen.findByText(/#1 \(300, 300\) 100×60/);

    vi.mocked(submitLayout).mockResolvedValue({
      ok: true,
      data: {
        verdict: "可裁切",
        windows: [{ id: 1, position: 0, x: 300, y: 300, w: 100, h: 60 }],
        result: { verdict: "可裁切", ...cleanResult },
        created_at: "2026-09-14T00:00:00Z",
      },
    });

    fireEvent.click(screen.getByTestId("submit-btn"));

    await waitFor(() =>
      expect(screen.getByTestId("verdict-banner").textContent).toContain("已保存")
    );
    expect(submitLayout).toHaveBeenCalledWith([
      { id: expect.any(String), x: 300, y: 300, w: 100, h: 60 },
    ]);
  });

  it("任一字段非法时显示逐字段错误且整次不落库提示", async () => {
    render(<App />);
    const svg = document.querySelector(".sheet");
    dragDraw(svg, 300, 300, 400, 360);
    await screen.findByText(/#1 \(300, 300\) 100×60/);

    vi.mocked(submitLayout).mockResolvedValue({
      ok: false,
      status: 422,
      detail: "存在非法开窗，本次提交未保存",
      fieldErrors: [
        { index: 0, fields: { x: "x 必须 ≥ 12（压边安全区）" } },
      ],
    });

    fireEvent.click(screen.getByTestId("submit-btn"));

    const errors = await screen.findByTestId("submit-errors");
    expect(errors.textContent).toContain("整次提交未保存");
    const row = screen.getByTestId("list-row-0");
    expect(within(row).getByText(/x 必须 ≥ 12/)).toBeInTheDocument();
    // 仍然停留在未保存预览状态
    expect(screen.getByTestId("verdict-banner").textContent).toContain("未保存预览");
  });
});
