import { SHEET_WIDTH, SHEET_HEIGHT, SHAPE_CIRCLE, windowName } from "../geometry.js";

// 1000×700 毫米纸面的 SVG 画布；viewBox 与毫米同尺度，
// 指针坐标用 getScreenCTM 逆变换直接换算成毫米，取整。
// 矩形开窗画半开矩形轮廓，圆形开窗画真实圆轮廓（外接框边长为直径）。
export default function SheetCanvas({
  defects,
  windows,
  selectedId,
  conflictingIds,
  hitDefects,
  onSelect,
  onMove,
  onDrawStart,
}) {
  function toMm(svg, event) {
    const ctm = svg.getScreenCTM();
    const pt = new DOMPoint(event.clientX, event.clientY).matrixTransform(ctm.inverse());
    return { x: pt.x, y: pt.y };
  }

  function pointerDownWindow(event, win) {
    // 只响应鼠标主键；右键、中键不发起拖动
    if (event.button !== 0) return;
    event.preventDefault();
    event.stopPropagation();
    onSelect(win.id);
    const svg = event.currentTarget.ownerSVGElement;
    const start = toMm(svg, event);
    // 记录指针相对开窗外接框左上角的抓取偏移，避免拖动时左上角跳到指针处
    const grabX = start.x - win.x;
    const grabY = start.y - win.y;

    function drag(ev) {
      const p = toMm(svg, ev);
      onMove(win.id, Math.round(p.x - grabX), Math.round(p.y - grabY));
    }
    function stop() {
      window.removeEventListener("pointermove", drag);
      window.removeEventListener("pointerup", stop);
      window.removeEventListener("pointercancel", stop);
    }

    window.addEventListener("pointermove", drag);
    // pointerup 正常结束；pointercancel（设备/系统手势打断）同样立即终止
    window.addEventListener("pointerup", stop);
    window.addEventListener("pointercancel", stop);
  }

  const conflictSet = new Set(conflictingIds);
  const hitDefectSet = new Set(hitDefects);

  function renderWindowShape(win, cls) {
    if (win.shape === SHAPE_CIRCLE) {
      // 圆心 (x+w/2, y+h/2)，半径 w/2；直径为整数，半径可能为半整数
      return (
        <circle
          cx={win.x + win.w / 2}
          cy={win.y + win.h / 2}
          r={win.w / 2}
          className={cls}
          data-testid={`window-${win.id}`}
          onPointerDown={(e) => pointerDownWindow(e, win)}
        />
      );
    }
    return (
      <rect
        x={win.x}
        y={win.y}
        width={win.w}
        height={win.h}
        className={cls}
        data-testid={`window-${win.id}`}
        onPointerDown={(e) => pointerDownWindow(e, win)}
      />
    );
  }

  return (
    <svg
      className="sheet"
      viewBox={`0 0 ${SHEET_WIDTH} ${SHEET_HEIGHT}`}
      role="img"
      aria-label="纸张画布"
      onPointerDown={onDrawStart}
    >
      <rect x={0} y={0} width={SHEET_WIDTH} height={SHEET_HEIGHT} className="paper" />

      {defects.map((d) => (
        <g key={`defect-${d.index}`}>
          <rect
            x={d.x}
            y={d.y}
            width={d.w}
            height={d.h}
            className={hitDefectSet.has(d.index) ? "defect defect-hit" : "defect"}
          />
          <text x={d.x + 4} y={d.y + 18} className="defect-label">
            瑕疵 {d.index + 1}
          </text>
        </g>
      ))}

      {windows.map((win, index) => {
        if (win.id === "__draft__") {
          return (
            <g key="__draft__">
              {renderWindowShape(win, "window window-draft")}
            </g>
          );
        }
        const conflicted = conflictSet.has(win.id);
        const selected = win.id === selectedId;
        const cls = [
          "window",
          conflicted ? "window-conflict" : "",
          selected ? "window-selected" : "",
        ]
          .filter(Boolean)
          .join(" ");
        return (
          <g key={win.id}>
            {renderWindowShape(win, cls)}
            <text
              x={win.shape === SHAPE_CIRCLE ? win.x + win.w / 2 : win.x + 4}
              y={win.shape === SHAPE_CIRCLE ? win.y + win.h / 2 + 6 : win.y + 18}
              className={win.shape === SHAPE_CIRCLE ? "window-label window-label-center" : "window-label"}
              textAnchor={win.shape === SHAPE_CIRCLE ? "middle" : undefined}
            >
              {windowName(win, index)}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
