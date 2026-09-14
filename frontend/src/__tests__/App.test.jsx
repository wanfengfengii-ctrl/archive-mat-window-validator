import { act, fireEvent, render, screen, waitFor, within } from "@testing-library/react";
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
function firePointer(node, type, x, y, button = 0) {
  const ev = new MouseEvent(type, {
    bubbles: true,
    cancelable: true,
    clientX: x,
    clientY: y,
    button,
  });
  node.dispatchEvent(ev);
}

function dragDraw(svg, x1, y1, x2, y2) {
  firePointer(svg, "pointerdown", x1, y1);
  firePointer(window, "pointermove", x2, y2);
  firePointer(window, "pointerup", x2, y2);
}

// 在指定画布元素（如瑕疵区矩形）上按下，其余事件仍派发到 window
function dragDrawFrom(startTarget, x1, y1, x2, y2, button = 0) {
  firePointer(startTarget, "pointerdown", x1, y1, button);
  firePointer(window, "pointermove", x2, y2);
  firePointer(window, "pointerup", x2, y2, button);
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

  it("从瑕疵区内起拖也能新建开窗，并即时显示冲突", async () => {
    render(<App />);
    await screen.findByText(/提交方案并裁决/);
    // 直接在瑕疵区矩形（而非纸面/画布根节点）上按下指针
    const defect = document.querySelectorAll(".defect")[0];
    // 拖放范围完全落在第一个瑕疵区 [200,280)×[150,190) 内
    dragDrawFrom(defect, 210, 160, 260, 185);

    expect(await screen.findByText(/#1 \(210, 160\) 50×25/)).toBeInTheDocument();
    const banner = screen.getByTestId("verdict-banner");
    expect(banner).toHaveAttribute("data-verdict", "不可裁切");
    expect(document.querySelector(".window-conflict")).not.toBeNull();
    expect(document.querySelector(".defect-hit")).not.toBeNull();
  });

  it("右键拖放不会新建观察窗", () => {
    render(<App />);
    const svg = document.querySelector(".sheet");
    act(() => {
      // button=2 为鼠标右键
      dragDrawFrom(svg, 300, 300, 400, 360, 2);
    });

    expect(document.querySelector(".window-draft")).toBeNull();
    expect(document.querySelector(".window")).toBeNull();
    expect(screen.queryByText(/#1 /)).not.toBeInTheDocument();
  });

  it("右键拖动已有开窗不会移动它", async () => {
    render(<App />);
    const svg = document.querySelector(".sheet");
    dragDraw(svg, 300, 300, 400, 360);
    await screen.findByText(/#1 \(300, 300\) 100×60/);

    const win = document.querySelector(".window");
    act(() => {
      firePointer(win, "pointerdown", 350, 330, 2);
      firePointer(window, "pointermove", 500, 500, 2);
      firePointer(window, "pointerup", 500, 500, 2);
    });

    expect(screen.getByText(/#1 \(300, 300\) 100×60/)).toBeInTheDocument();
  });

  it("拖放中收到指针取消：立即清除草稿，之后移动不再跟随且不新增开窗", () => {
    render(<App />);
    const svg = document.querySelector(".sheet");
    // 主键开始拖放并移动一次，草稿出现
    act(() => {
      firePointer(svg, "pointerdown", 300, 300);
      firePointer(window, "pointermove", 360, 360);
    });
    expect(document.querySelector(".window-draft")).not.toBeNull();

    // 设备触发 pointercancel：草稿立即消失
    act(() => {
      firePointer(window, "pointercancel", 360, 360);
    });
    expect(document.querySelector(".window-draft")).toBeNull();

    // 取消后指针继续移动：草稿不得重新出现或跟随
    act(() => {
      firePointer(window, "pointermove", 450, 450);
    });
    expect(document.querySelector(".window-draft")).toBeNull();

    // 取消后即使再松手也不会补建开窗
    act(() => {
      firePointer(window, "pointerup", 450, 450);
    });
    expect(document.querySelector(".window")).toBeNull();
    expect(screen.queryByText(/#1 /)).not.toBeInTheDocument();
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

  it("表单把 x 改到越过安全区时回退到容得下整窗的刻度", async () => {
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

    // 吸附回退到最后一个容得下整窗的刻度：988-100=888，方案保持可裁切
    await screen.findByText(/#1 \(888, 300\) 100×60/);
    expect(screen.getByTestId("verdict-banner")).toHaveAttribute("data-verdict", "可裁切");
  });

  it("表单把开窗改进瑕疵区时即时显示不可裁切并高亮", async () => {
    render(<App />);
    const svg = document.querySelector(".sheet");
    dragDraw(svg, 300, 300, 400, 360);
    expect((await screen.findByTestId("verdict-banner")).getAttribute("data-verdict")).toBe(
      "可裁切"
    );
    fireEvent.click(screen.getByText(/#1 \(300, 300\) 100×60/));

    // 改到侵入第一个瑕疵区 [200,280)×[150,190) 的位置
    const xInput = screen.getByLabelText("x（毫米）");
    fireEvent.change(xInput, { target: { value: "250" } });
    fireEvent.blur(xInput);
    const yInput = screen.getByLabelText("y（毫米）");
    fireEvent.change(yInput, { target: { value: "170" } });
    fireEvent.blur(yInput);

    await waitFor(() =>
      expect(screen.getByTestId("verdict-banner")).toHaveAttribute("data-verdict", "不可裁切")
    );
    expect(document.querySelector(".window-conflict")).not.toBeNull();
    expect(document.querySelector(".defect-hit")).not.toBeNull();
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
    ], 1);
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
    ], 1);
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
    ], 1);
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

describe("定位步长", () => {
  it("默认选中 1 毫米，提供 1/5/10 三档", async () => {
    render(<App />);
    await screen.findByText(/提交方案并裁决/);
    expect(screen.getByRole("radio", { name: "1 毫米" })).toBeChecked();
    expect(screen.getByRole("radio", { name: "5 毫米" })).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "10 毫米" })).toBeInTheDocument();
  });

  it("5 毫米步长下拖放、移动、表单编辑得到一致坐标", async () => {
    render(<App />);
    await screen.findByText(/提交方案并裁决/);
    fireEvent.click(screen.getByRole("radio", { name: "5 毫米" }));
    const svg = document.querySelector(".sheet");

    // 拖放：原始 (306,311)→(419,375)，吸附为 (307,312) 115×65
    dragDraw(svg, 306, 311, 419, 375);
    await screen.findByText(/#1 \(307, 312\) 115×65/);

    // 表单编辑：先改走，再输入与拖放相同的原始值，吸附结果一致
    fireEvent.click(screen.getByText(/#1 \(307, 312\) 115×65/));
    fireEvent.change(screen.getByLabelText("x（毫米）"), { target: { value: "500" } });
    fireEvent.blur(screen.getByLabelText("x（毫米）"));
    await screen.findByText(/#1 \(502, 312\) 115×65/);
    fireEvent.change(screen.getByLabelText("x（毫米）"), { target: { value: "306" } });
    fireEvent.blur(screen.getByLabelText("x（毫米）"));
    fireEvent.change(screen.getByLabelText("y（毫米）"), { target: { value: "311" } });
    fireEvent.blur(screen.getByLabelText("y（毫米）"));
    fireEvent.change(screen.getByLabelText("宽（毫米）"), { target: { value: "113" } });
    fireEvent.blur(screen.getByLabelText("宽（毫米）"));
    fireEvent.change(screen.getByLabelText("高（毫米）"), { target: { value: "64" } });
    fireEvent.blur(screen.getByLabelText("高（毫米）"));
    await screen.findByText(/#1 \(307, 312\) 115×65/);

    // 移动：另一扇开窗拖到同样的原始左上角 (306,311)，吸附位置一致
    dragDraw(svg, 500, 500, 550, 540);
    await screen.findByText(/#2 \(502, 502\) 50×40/);
    const win2 = document.querySelectorAll(".window")[1];
    act(() => {
      firePointer(win2, "pointerdown", 510, 510); // 抓取偏移 (8,8)
      firePointer(window, "pointermove", 314, 319); // 左上角原始值 (306,311)
      firePointer(window, "pointerup", 314, 319);
    });
    await screen.findByText(/#2 \(307, 312\) 50×40/);

    // 两窗重叠：吸附后即时裁决继续显示（不可裁切 + 双方高亮）
    expect(screen.getByTestId("verdict-banner")).toHaveAttribute("data-verdict", "不可裁切");
    expect(document.querySelectorAll(".window-conflict").length).toBe(2);
  });

  it("10 毫米步长下拖放吸附到 10 毫米刻度", async () => {
    render(<App />);
    await screen.findByText(/提交方案并裁决/);
    fireEvent.click(screen.getByRole("radio", { name: "10 毫米" }));
    const svg = document.querySelector(".sheet");
    // 原始 (306,311)→(419,375)：306-12=294→29.4→29→302；311-12=299→29.9→30→312
    // w=113→11.3→11→110；h=64→6.4→6→60
    dragDraw(svg, 306, 311, 419, 375);
    await screen.findByText(/#1 \(302, 312\) 110×60/);
  });

  it("所选步长随布局一起提交保存", async () => {
    render(<App />);
    await screen.findByText(/提交方案并裁决/);
    fireEvent.click(screen.getByRole("radio", { name: "5 毫米" }));
    const svg = document.querySelector(".sheet");
    dragDraw(svg, 302, 302, 407, 362);
    await screen.findByText(/#1 \(302, 302\) 105×60/);

    vi.mocked(submitLayout).mockResolvedValue({
      ok: true,
      data: {
        verdict: "可裁切",
        step: 5,
        windows: [{ id: 1, position: 0, x: 302, y: 302, w: 105, h: 60, label: null }],
        result: { verdict: "可裁切", ...cleanResult },
        created_at: "2026-09-14T00:00:00Z",
      },
    });
    fireEvent.click(screen.getByTestId("submit-btn"));

    await waitFor(() =>
      expect(screen.getByTestId("verdict-banner").textContent).toContain("已保存")
    );
    expect(submitLayout).toHaveBeenCalledWith([
      { id: expect.any(String), x: 302, y: 302, w: 105, h: 60, label: "" },
    ], 5);
    // 保存后步长选择保持 5 毫米
    expect(screen.getByRole("radio", { name: "5 毫米" })).toBeChecked();
  });

  it("刷新后恢复步长选择、画布、结论与冲突高亮", async () => {
    vi.mocked(fetchLayout).mockResolvedValue({
      verdict: "不可裁切",
      step: 5,
      windows: [
        { id: 41, position: 0, x: 302, y: 302, w: 105, h: 60, label: null },
        { id: 42, position: 1, x: 332, y: 332, w: 105, h: 60, label: null },
      ],
      result: {
        verdict: "不可裁切",
        defect_conflicts: [],
        window_conflicts: [{ window_a: 41, window_b: 42 }],
        conflicting_window_ids: [41, 42],
      },
      created_at: "2026-09-14T00:00:00Z",
    });
    render(<App />);

    // 画布与列表恢复
    await screen.findByText(/#1 \(302, 302\) 105×60/);
    await screen.findByText(/#2 \(332, 332\) 105×60/);
    // 步长选择恢复为 5 毫米
    expect(screen.getByRole("radio", { name: "5 毫米" })).toBeChecked();
    // 结论与冲突高亮恢复
    const banner = screen.getByTestId("verdict-banner");
    expect(banner).toHaveAttribute("data-verdict", "不可裁切");
    expect(banner.textContent).toContain("已保存");
    expect(document.querySelectorAll(".window-conflict").length).toBe(2);
    expect(screen.getByTestId("list-row-0").className).toContain("row-conflict");
    expect(screen.getByTestId("list-row-1").className).toContain("row-conflict");
  });

  it("旧记录缺少步长值时按 1 毫米处理", async () => {
    vi.mocked(fetchLayout).mockResolvedValue({
      verdict: "可裁切",
      // 旧记录：没有 step 字段
      windows: [{ id: 11, position: 0, x: 300, y: 300, w: 100, h: 80, label: "ZW-1" }],
      result: { verdict: "可裁切", ...cleanResult },
      created_at: "2026-09-01T00:00:00Z",
    });
    render(<App />);

    await screen.findByText(/ZW-1 \(300, 300\) 100×80/);
    expect(screen.getByRole("radio", { name: "1 毫米" })).toBeChecked();
    // 1 毫米步长下原坐标合法，不产生本地非法高亮
    expect(screen.getByTestId("verdict-banner")).toHaveAttribute("data-verdict", "可裁切");
    expect(document.querySelector(".window-conflict")).toBeNull();
  });

  it("偏离刻度被 422 打回：草稿、选中项与即时裁决保留，修正后可直接重试", async () => {
    render(<App />);
    await screen.findByText(/提交方案并裁决/);
    const svg = document.querySelector(".sheet");
    // 1 毫米步长下拖放 (300,300) 100×60 并选中
    dragDraw(svg, 300, 300, 400, 360);
    fireEvent.click(await screen.findByText(/#1 \(300, 300\) 100×60/));

    // 切换到 5 毫米：x/y=300 偏离刻度（基准 12），即时裁决转为不可裁切并高亮
    fireEvent.click(screen.getByRole("radio", { name: "5 毫米" }));
    await waitFor(() =>
      expect(screen.getByTestId("verdict-banner")).toHaveAttribute("data-verdict", "不可裁切")
    );
    expect(document.querySelector(".window-conflict")).not.toBeNull();

    vi.mocked(submitLayout).mockResolvedValue({
      ok: false,
      status: 422,
      detail: "存在非法开窗，本次提交未保存",
      fieldErrors: [
        { index: 0, fields: { x: "x 须符合 5 毫米刻度", y: "y 须符合 5 毫米刻度" } },
      ],
    });
    fireEvent.click(screen.getByTestId("submit-btn"));

    // 逐字段错误显示；草稿、选中项、步长选择与即时裁决全部保留
    const row = await screen.findByTestId("list-row-0");
    await within(row).findByText(/x 须符合 5 毫米刻度/);
    expect(screen.getByText(/#1 \(300, 300\) 100×60/)).toBeInTheDocument();
    expect(screen.getByTestId("window-form")).toBeInTheDocument();
    expect(screen.getByRole("radio", { name: "5 毫米" })).toBeChecked();
    expect(screen.getByTestId("verdict-banner").textContent).toContain("未保存预览");

    // 修正：表单输入 300 被吸附到最近刻度 302，随后直接重试
    fireEvent.change(screen.getByLabelText("x（毫米）"), { target: { value: "300" } });
    fireEvent.blur(screen.getByLabelText("x（毫米）"));
    fireEvent.change(screen.getByLabelText("y（毫米）"), { target: { value: "300" } });
    fireEvent.blur(screen.getByLabelText("y（毫米）"));
    await screen.findByText(/#1 \(302, 302\) 100×60/);
    await waitFor(() =>
      expect(screen.getByTestId("verdict-banner")).toHaveAttribute("data-verdict", "可裁切")
    );

    vi.mocked(submitLayout).mockResolvedValue({
      ok: true,
      data: {
        verdict: "可裁切",
        step: 5,
        windows: [{ id: 7, position: 0, x: 302, y: 302, w: 100, h: 60, label: null }],
        result: { verdict: "可裁切", ...cleanResult },
        created_at: "2026-09-14T00:00:00Z",
      },
    });
    fireEvent.click(screen.getByTestId("submit-btn"));
    await waitFor(() =>
      expect(screen.getByTestId("verdict-banner").textContent).toContain("已保存")
    );
    expect(submitLayout).toHaveBeenLastCalledWith([
      { id: expect.any(String), x: 302, y: 302, w: 100, h: 60, label: "" },
    ], 5);
  });
});
