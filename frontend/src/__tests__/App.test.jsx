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
      { id: expect.any(String), x: 300, y: 300, w: 100, h: 60, label: "" },
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

describe("工件编号", () => {
  it("恢复带编号的布局：画布与列表用编号，空编号用顺序号", async () => {
    vi.mocked(fetchLayout).mockResolvedValue({
      verdict: "可裁切",
      windows: [
        { id: 11, position: 0, x: 300, y: 300, w: 100, h: 80, label: "ZW-001" },
        { id: 12, position: 1, x: 500, y: 100, w: 40, h: 40, label: null },
      ],
      result: { verdict: "可裁切", ...cleanResult },
      created_at: "2026-09-14T00:00:00Z",
    });
    render(<App />);

    // 列表：有编号用编号，空编号退回顺序号
    await screen.findByText(/ZW-001 \(300, 300\) 100×80/);
    await screen.findByText(/#2 \(500, 100\) 40×40/);
    // 画布上的开窗文字同样使用编号/顺序号
    const svg = document.querySelector(".sheet");
    expect(within(svg).getByText("ZW-001")).toBeInTheDocument();
    expect(within(svg).getByText("#2")).toBeInTheDocument();
  });

  it("在表单录入编号后随开窗一起提交，保存后仍显示编号", async () => {
    render(<App />);
    const svg = document.querySelector(".sheet");
    dragDraw(svg, 300, 300, 400, 360);
    fireEvent.click(await screen.findByText(/#1 \(300, 300\) 100×60/));

    const labelInput = screen.getByLabelText("工件编号");
    fireEvent.change(labelInput, { target: { value: "  ZW-001  " } });
    fireEvent.blur(labelInput);

    // 列表与画布即时改用编号（去首尾空格）
    await screen.findByText(/ZW-001 \(300, 300\) 100×60/);
    expect(within(document.querySelector(".sheet")).getByText("ZW-001")).toBeInTheDocument();

    vi.mocked(submitLayout).mockResolvedValue({
      ok: true,
      data: {
        verdict: "可裁切",
        windows: [{ id: 1, position: 0, x: 300, y: 300, w: 100, h: 60, label: "ZW-001" }],
        result: { verdict: "可裁切", ...cleanResult },
        created_at: "2026-09-14T00:00:00Z",
      },
    });
    fireEvent.click(screen.getByTestId("submit-btn"));

    await waitFor(() =>
      expect(screen.getByTestId("verdict-banner").textContent).toContain("已保存")
    );
    expect(submitLayout).toHaveBeenCalledWith([
      { id: expect.any(String), x: 300, y: 300, w: 100, h: 60, label: "ZW-001" },
    ]);
    // 保存后编号仍在列表中
    expect(screen.getByText(/ZW-001 \(300, 300\) 100×60/)).toBeInTheDocument();
  });

  it("编号只填空格视为未填写，仍显示顺序号", async () => {
    render(<App />);
    const svg = document.querySelector(".sheet");
    dragDraw(svg, 300, 300, 400, 360);
    fireEvent.click(await screen.findByText(/#1 \(300, 300\) 100×60/));

    const labelInput = screen.getByLabelText("工件编号");
    fireEvent.change(labelInput, { target: { value: "   " } });
    fireEvent.blur(labelInput);

    expect(await screen.findByText(/#1 \(300, 300\) 100×60/)).toBeInTheDocument();
    expect(within(document.querySelector(".sheet")).getByText("#1")).toBeInTheDocument();
  });

  it("重复编号被 422 逐行打回：草稿、选中项与冲突高亮保留，修正后可再次提交", async () => {
    render(<App />);
    const svg = document.querySelector(".sheet");
    // 两个相互重叠的开窗 → 即时冲突高亮
    dragDraw(svg, 300, 300, 360, 360);
    dragDraw(svg, 330, 330, 390, 390);

    // 两个开窗填上相同编号
    fireEvent.click(await screen.findByText(/#1 \(300, 300\) 60×60/));
    fireEvent.change(screen.getByLabelText("工件编号"), { target: { value: "DUP-1" } });
    fireEvent.blur(screen.getByLabelText("工件编号"));
    fireEvent.click(await screen.findByText(/#2 \(330, 330\) 60×60/));
    fireEvent.change(screen.getByLabelText("工件编号"), { target: { value: "DUP-1" } });
    fireEvent.blur(screen.getByLabelText("工件编号"));
    await screen.findByText(/DUP-1 \(330, 330\) 60×60/);

    // 提交前已有即时冲突高亮
    expect(document.querySelectorAll(".window-conflict").length).toBe(2);

    vi.mocked(submitLayout).mockResolvedValue({
      ok: false,
      status: 422,
      detail: "存在非法开窗，本次提交未保存",
      fieldErrors: [
        { index: 0, fields: { label: "编号与其他开窗重复" } },
        { index: 1, fields: { label: "编号与其他开窗重复" } },
      ],
    });
    fireEvent.click(screen.getByTestId("submit-btn"));

    // 两行都显示编号字段错误
    const row0 = await screen.findByTestId("list-row-0");
    const row1 = screen.getByTestId("list-row-1");
    await within(row0).findByText(/编号与其他开窗重复/);
    await within(row1).findByText(/编号与其他开窗重复/);

    // 草稿、选中项与即时冲突高亮全部保留
    expect(screen.getByText(/DUP-1 \(300, 300\) 60×60/)).toBeInTheDocument();
    expect(screen.getByText(/DUP-1 \(330, 330\) 60×60/)).toBeInTheDocument();
    expect(screen.getByTestId("window-form")).toBeInTheDocument();
    expect(document.querySelectorAll(".window-conflict").length).toBe(2);
    expect(screen.getByTestId("verdict-banner").textContent).toContain("未保存预览");

    // 修正第二个开窗的编号后直接再次提交
    fireEvent.change(screen.getByLabelText("工件编号"), { target: { value: "ZW-002" } });
    fireEvent.blur(screen.getByLabelText("工件编号"));
    await screen.findByText(/ZW-002 \(330, 330\) 60×60/);

    vi.mocked(submitLayout).mockResolvedValue({
      ok: true,
      data: {
        verdict: "不可裁切",
        windows: [
          { id: 21, position: 0, x: 300, y: 300, w: 60, h: 60, label: "DUP-1" },
          { id: 22, position: 1, x: 330, y: 330, w: 60, h: 60, label: "ZW-002" },
        ],
        result: {
          verdict: "不可裁切",
          defect_conflicts: [],
          window_conflicts: [{ window_a: 21, window_b: 22 }],
          conflicting_window_ids: [21, 22],
        },
        created_at: "2026-09-14T00:00:00Z",
      },
    });
    fireEvent.click(screen.getByTestId("submit-btn"));

    await waitFor(() =>
      expect(screen.getByTestId("verdict-banner").textContent).toContain("已保存")
    );
    expect(submitLayout).toHaveBeenLastCalledWith([
      { id: expect.any(String), x: 300, y: 300, w: 60, h: 60, label: "DUP-1" },
      { id: expect.any(String), x: 330, y: 330, w: 60, h: 60, label: "ZW-002" },
    ]);
  });

  it("带编号的重叠开窗：画布与冲突说明都用编号指认，保存后仍对应", async () => {
    render(<App />);
    const svg = document.querySelector(".sheet");
    dragDraw(svg, 300, 300, 360, 360);
    dragDraw(svg, 330, 330, 390, 390);

    fireEvent.click(await screen.findByText(/#1 \(300, 300\) 60×60/));
    fireEvent.change(screen.getByLabelText("工件编号"), { target: { value: "WIN-A" } });
    fireEvent.blur(screen.getByLabelText("工件编号"));
    fireEvent.click(await screen.findByText(/#2 \(330, 330\) 60×60/));
    fireEvent.change(screen.getByLabelText("工件编号"), { target: { value: "WIN-B" } });
    fireEvent.blur(screen.getByLabelText("工件编号"));
    await screen.findByText(/WIN-B \(330, 330\) 60×60/);

    // 画布上的开窗文字使用编号
    const canvas = document.querySelector(".sheet");
    expect(within(canvas).getByText("WIN-A")).toBeInTheDocument();
    expect(within(canvas).getByText("WIN-B")).toBeInTheDocument();

    // 冲突说明用编号指认双方
    const list = await screen.findByTestId("conflict-list");
    expect(list.textContent).toContain("开窗 WIN-A 与 开窗 WIN-B 相互重叠");

    // 保存（不可裁切）后冲突说明仍与编号对应
    vi.mocked(submitLayout).mockResolvedValue({
      ok: true,
      data: {
        verdict: "不可裁切",
        windows: [
          { id: 31, position: 0, x: 300, y: 300, w: 60, h: 60, label: "WIN-A" },
          { id: 32, position: 1, x: 330, y: 330, w: 60, h: 60, label: "WIN-B" },
        ],
        result: {
          verdict: "不可裁切",
          defect_conflicts: [],
          window_conflicts: [{ window_a: 31, window_b: 32 }],
          conflicting_window_ids: [31, 32],
        },
        created_at: "2026-09-14T00:00:00Z",
      },
    });
    fireEvent.click(screen.getByTestId("submit-btn"));
    await waitFor(() =>
      expect(screen.getByTestId("verdict-banner").textContent).toContain("已保存")
    );
    expect(screen.getByTestId("conflict-list").textContent).toContain(
      "开窗 WIN-A 与 开窗 WIN-B 相互重叠"
    );
  });

  it("侵入瑕疵区的冲突说明同样使用编号", async () => {
    render(<App />);
    const svg = document.querySelector(".sheet");
    // 侵入第一个瑕疵区 [200,280)×[150,190)
    dragDraw(svg, 220, 160, 260, 185);
    fireEvent.click(await screen.findByText(/#1 \(220, 160\) 40×25/));
    fireEvent.change(screen.getByLabelText("工件编号"), { target: { value: "WIN-A" } });
    fireEvent.blur(screen.getByLabelText("工件编号"));

    const list = await screen.findByTestId("conflict-list");
    expect(list.textContent).toContain("开窗 WIN-A 侵入瑕疵区 1");
  });
});
