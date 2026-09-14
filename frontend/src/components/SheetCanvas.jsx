import { SHEET_WIDTH, SHEET_HEIGHT } from "../geometry.js";

// 1000×700 毫米纸面的 SVG 画布；viewBox 与毫米同尺度，
// 指针坐标用 getScreenCTM 逆变换直接换算成毫米，取整。
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
    event.preventDefault();
    event.stopPropagation();
    onSelect(win.id);
    const svg = event.currentTarget.ownerSVGElement;
    const start = toMm(svg, event);
    // 记录指针相对开窗左上角的抓取偏移，避免拖动时左上角跳到指针处
    const grabX = start.x - win.x;
    const grabY = start.y - win.y;

    function drag(ev) {
      const p = toMm(svg, ev);
      onMove(win.id, Math.round(p.x - grabX), Math.round(p.y - grabY));
    }

    window.addEventListener("pointermove", drag);
    window.addEventListener(
      "pointerup",
      () => window.removeEventListener("pointermove", drag),
      { once: true }
    );
  }

  const conflictSet = new Set(conflictingIds);
  const hitDefectSet = new Set(hitDefects);

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

      {windows.map((win) => {
        if (win.id === "__draft__") {
          return (
            <rect
              key="__draft__"
              x={win.x}
              y={win.y}
              width={win.w}
              height={win.h}
              className="window window-draft"
            />
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
            <rect
              x={win.x}
              y={win.y}
              width={win.w}
              height={win.h}
              className={cls}
              data-testid={`window-${win.id}`}
              onPointerDown={(e) => pointerDownWindow(e, win)}
            />
            <text x={win.x + 4} y={win.y + 18} className="window-label">
              {win.id}
            </text>
          </g>
        );
      })}
    </svg>
  );
}
