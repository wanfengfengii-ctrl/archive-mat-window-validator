import { useEffect, useMemo, useState } from "react";
import SheetCanvas from "./components/SheetCanvas.jsx";
import WindowForm from "./components/WindowForm.jsx";
import { fetchDefects, fetchLayout, submitLayout } from "./api.js";
import {
  DEFECTS,
  DEFAULT_STEP,
  GRID_STEPS,
  INNER_BOTTOM,
  INNER_RIGHT,
  MARGIN,
  SHEET_HEIGHT,
  SHEET_WIDTH,
  SHAPE_CIRCLE,
  SHAPE_RECT,
  VERDICT_CUTTABLE,
  VERDICT_REJECTED,
  adjudicate,
  clampIntoInner,
  fieldErrors,
  snapCircle,
  snapRect,
  windowName,
} from "./geometry.js";

let tmpCounter = 0;
const nextTmpId = () => `tmp-${++tmpCounter}`;

function clientToMm(svg, event) {
  const ctm = svg.getScreenCTM();
  const pt = new DOMPoint(event.clientX, event.clientY).matrixTransform(ctm.inverse());
  return { x: pt.x, y: pt.y };
}

// 圆形外接框左上角：两个方向都要容得下直径
function clampCircleTopLeft(x, y, d) {
  return [
    Math.min(Math.max(Math.round(x), MARGIN), INNER_RIGHT - d),
    Math.min(Math.max(Math.round(y), MARGIN), INNER_BOTTOM - d),
  ];
}

// 把拖拽中的矩形开窗左上角限制在安全区内（整窗不得越界）
function clampTopLeft(x, y, w, h) {
  return [
    Math.min(Math.max(Math.round(x), MARGIN), INNER_RIGHT - w),
    Math.min(Math.max(Math.round(y), MARGIN), INNER_BOTTOM - h),
  ];
}

// 按形状把拖出的原始矩形/圆外接框吸附到当前步长刻度
function snapShape(x, y, w, h, step, shape) {
  return shape === SHAPE_CIRCLE
    ? snapCircle(x, y, Math.min(w, h), step)
    : snapRect(x, y, w, h, step);
}

export default function App() {
  const [defects, setDefects] = useState(
    DEFECTS.map((d, index) => ({ index, ...d }))
  );
  const [windows, setWindows] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [draftRect, setDraftRect] = useState(null); // 正在拖放的新开窗
  const [shape, setShape] = useState(SHAPE_RECT); // 当前观察窗形状（矩形/圆形）
  const [step, setStep] = useState(DEFAULT_STEP); // 定位步长（毫米）
  const [saved, setSaved] = useState(null); // 最近一次服务器裁决
  const [dirty, setDirty] = useState(false);
  const [submitRows, setSubmitRows] = useState([]); // 422 逐字段错误
  const [banner, setBanner] = useState(null); // {type,text}
  const [loading, setLoading] = useState(true);

  useEffect(() => {
    let alive = true;
    Promise.all([fetchDefects(), fetchLayout()])
      .then(([d, layout]) => {
        if (!alive) return;
        if (d.defects?.length) setDefects(d.defects.map((z) => ({ ...z })));
        // 恢复已保存的步长选择；旧记录缺少该值时按 1 毫米处理
        if (layout.step != null) setStep(layout.step);
        if (layout.windows.length > 0) {
          setWindows(
            [...layout.windows]
              .sort((a, b) => a.position - b.position)
              .map(({ id, shape: savedShape, x, y, w, h, label }) => ({
                id,
                // 旧记录缺少类型时按矩形读取
                shape: savedShape ?? SHAPE_RECT,
                x,
                y,
                w,
                h,
                label: label ?? "",
              }))
          );
          // 观察窗形状选择跟随布局：全部为圆时停在圆形，否则回到矩形
          const ordered = [...layout.windows].sort((a, b) => a.position - b.position);
          if (ordered.length > 0 && ordered.every((w) => (w.shape ?? SHAPE_RECT) === SHAPE_CIRCLE)) {
            setShape(SHAPE_CIRCLE);
          }
          setSaved({ verdict: layout.verdict, result: layout.result });
        }
      })
      .catch(() => setBanner({ type: "error", text: "无法连接后端 API" }))
      .finally(() => alive && setLoading(false));
    return () => {
      alive = false;
    };
  }, []);

  // 本地即时预览裁决（提交以后端结果为准）
  const verdictData = useMemo(() => adjudicate(windows), [windows]);

  // 本地字段非法（越过安全区、偏离所选步长刻度、圆形宽高不等等）
  // 时也不能给出“可裁切”
  const localInvalidIds = useMemo(
    () =>
      new Set(
        windows
          .filter(
            (win) =>
              Object.keys(fieldErrors(win.x, win.y, win.w, win.h, step, win.shape ?? SHAPE_RECT))
                .length > 0
          )
          .map((w) => w.id)
      ),
    [windows, step]
  );

  // 页面上唯一的结论：未提交且有改动时显示“未保存预览”
  // 两种视图统一成 {verdict, result} 结构，result 内含完整冲突明细
  const isPreview = dirty || !saved;
  const previewVerdict =
    localInvalidIds.size > 0 ? VERDICT_REJECTED : verdictData.verdict;
  const verdictView = isPreview
    ? { verdict: previewVerdict, result: verdictData }
    : { verdict: saved.verdict, result: saved.result };
  const conflictingIds = useMemo(
    () => new Set(verdictView.result?.conflicting_window_ids ?? []),
    [verdictView]
  );
  const hitDefects = useMemo(
    () =>
      new Set(
        (verdictView.result?.defect_conflicts ?? []).map((c) => c.defect_index)
      ),
    [verdictView]
  );

  // 开窗 id → 展示名（编号或顺序号），冲突说明按编号指认每一扇窗
  const nameById = useMemo(() => {
    const m = new Map();
    windows.forEach((w, i) => m.set(w.id, windowName(w, i)));
    return m;
  }, [windows]);

  // 冲突说明：逐条列出哪扇窗侵入瑕疵区、哪两扇窗相互重叠
  const conflictLines = useMemo(() => {
    const result = verdictView.result;
    if (!result) return [];
    const nameOf = (id) => nameById.get(id) ?? `#${id}`;
    const lines = (result.defect_conflicts ?? []).map(
      (c) => `开窗 ${nameOf(c.window_id)} 侵入瑕疵区 ${c.defect_index + 1}`
    );
    (result.window_conflicts ?? []).forEach((c) => {
      lines.push(`开窗 ${nameOf(c.window_a)} 与 开窗 ${nameOf(c.window_b)} 相互重叠`);
    });
    return lines;
  }, [verdictView, nameById]);

  // 每个开窗的服务器字段错误（按提交次序对应行号）
  const rowErrorMap = useMemo(() => {
    const m = new Map();
    submitRows.forEach((row) => m.set(windows[row.index]?.id, row.fields));
    return m;
  }, [submitRows, windows]);

  function markDirty() {
    setDirty(true);
    setSubmitRows([]);
  }

  // 切换定位步长：其后的拖放、移动与表单编辑都按新步长吸附；
  // 步长随布局一起提交保存，因此切换也算未保存改动
  function changeStep(next) {
    setStep(next);
    markDirty();
  }

  // 切换当前观察窗形状（矩形↔圆形）：
  // 选中某扇窗时就地切换该窗——转圆形时以当前宽高中较小值作为直径
  // 并按所选步长吸附，其余矩形窗的操作与结论保持原样；
  // 没有选中窗时只改变其后新拖放窗的形状。
  function changeShape(nextShape) {
    if (nextShape === shape) return;
    const target = windows.find((w) => w.id === selectedId);
    if (target) {
      setWindows((list) =>
        list.map((w) => {
          if (w.id !== target.id) return w;
          if (nextShape === SHAPE_CIRCLE) {
            const snapped = snapCircle(w.x, w.y, Math.min(w.w, w.h), step);
            return { ...w, shape: SHAPE_CIRCLE, ...snapped };
          }
          // 圆形回矩形：外接框即原直径的正方形，位置与裁决仍在同一画布即时重算
          return { ...w, shape: SHAPE_RECT };
        })
      );
    }
    setShape(nextShape);
    markDirty();
  }

  // 选中圆形开窗时把当前工具形状同步为圆形，切回矩形窗则同步为矩形，
  // 保证表单字段（宽高 / 直径）与正在编辑的窗一致
  useEffect(() => {
    const selected = windows.find((w) => w.id === selectedId);
    if (selected) setShape(selected.shape ?? SHAPE_RECT);
  }, [selectedId]); // eslint-disable-line react-hooks/exhaustive-deps

  function updateWindow(id, patch) {
    setWindows((list) =>
      list.map((w) => {
        if (w.id !== id) return w;
        const next = { ...w, ...patch };
        const winShape = next.shape ?? SHAPE_RECT;
        // 几何字段的表单编辑按当前步长即时吸附（编号等文本字段除外）
        if (
          patch.x !== undefined ||
          patch.y !== undefined ||
          patch.w !== undefined ||
          patch.h !== undefined
        ) {
          const snapped =
            winShape === SHAPE_CIRCLE
              ? snapCircle(next.x, next.y, Math.min(next.w, next.h), step)
              : snapRect(next.x, next.y, next.w, next.h, step);
          Object.assign(next, snapped);
        }
        return next;
      })
    );
    markDirty();
  }

  function moveWindow(id, x, y) {
    setWindows((list) =>
      list.map((w) => {
        if (w.id !== id) return w;
        const winShape = w.shape ?? SHAPE_RECT;
        if (winShape === SHAPE_CIRCLE) {
          const [cx, cy] = clampCircleTopLeft(x, y, w.w);
          const snapped = snapCircle(cx, cy, w.w, step);
          return { ...w, x: snapped.x, y: snapped.y, w: snapped.w, h: snapped.h };
        }
        const [cx, cy] = clampTopLeft(x, y, w.w, w.h);
        const snapped = snapRect(cx, cy, w.w, w.h, step);
        return { ...w, x: snapped.x, y: snapped.y, w: snapped.w, h: snapped.h };
      })
    );
    markDirty();
  }

  function addWindow(rect) {
    setWindows((list) => [
      ...list,
      { id: nextTmpId(), shape, label: "", ...rect },
    ]);
    setSelectedId(null);
    markDirty();
  }

  function deleteWindow(id) {
    setWindows((list) => list.filter((w) => w.id !== id));
    setSelectedId((cur) => (cur === id ? null : cur));
    markDirty();
  }

  // ---- 在纸面空白处（含瑕疵区上方）拖放新开窗 ----
  function handleDrawStart(event) {
    // 只响应鼠标主键（button 0）；右键、中键不发起开窗
    if (event.button !== 0) return;
    const svg = event.currentTarget;
    // 落在已有开窗上的指针事件已被开窗自身 stopPropagation，
    // 因此能冒泡到画布的目标（纸面、瑕疵区矩形及其文字）一律视为空白处，
    // 从瑕疵区内起拖同样可以新建开窗并在松手后即时显示冲突。
    setSelectedId(null);
    const start = clientToMm(svg, event);
    const [sx, sy] = clampIntoInner(Math.round(start.x), Math.round(start.y));
    let current = null;

    function onMove(ev) {
      const p = clientToMm(svg, ev);
      const [ex, ey] = clampIntoInner(Math.round(p.x), Math.round(p.y));
      current = {
        x: Math.min(sx, ex),
        y: Math.min(sy, ey),
        w: Math.abs(ex - sx),
        h: Math.abs(ey - sy),
      };
      // 草稿即时按当前步长吸附，松手落窗的坐标与之一致；
      // 圆形以拖出宽高的较小值作为直径
      setDraftRect({
        shape,
        ...snapShape(current.x, current.y, current.w, current.h, step, shape),
      });
    }
    function stop() {
      window.removeEventListener("pointermove", onMove);
      window.removeEventListener("pointerup", onUp);
      window.removeEventListener("pointercancel", onCancel);
    }
    function onUp() {
      stop();
      setDraftRect(null);
      if (current && current.w >= 1 && current.h >= 1) {
        addWindow(snapShape(current.x, current.y, current.w, current.h, step, shape));
      }
    }
    // 设备（触屏/手写笔/系统手势）触发指针取消：立即终止拖放并清除草稿，不新增开窗
    function onCancel() {
      stop();
      setDraftRect(null);
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp);
    window.addEventListener("pointercancel", onCancel);
  }

  async function handleSubmit() {
    setBanner(null);
    const result = await submitLayout(windows, step);
    if (result.ok) {
      const { data } = result;
      setWindows(
        [...data.windows]
          .sort((a, b) => a.position - b.position)
          .map(({ id, shape: savedShape, x, y, w, h, label }) => ({
            id,
            shape: savedShape ?? SHAPE_RECT,
            x,
            y,
            w,
            h,
            label: label ?? "",
          }))
      );
      if (data.step != null) setStep(data.step);
      setSaved({ verdict: data.verdict, result: data.result });
      setDirty(false);
      setSubmitRows([]);
      setSelectedId(null); // 临时 id 已被数据库 id 取代，清掉失效选中
      setBanner({ type: "ok", text: "方案已保存" });
    } else {
      // 整次未保存：保留草稿、选中项与即时裁决，修正后可直接重试
      setSubmitRows(result.fieldErrors);
      setBanner({ type: "error", text: result.detail });
    }
  }

  const selected = windows.find((w) => w.id === selectedId) ?? null;
  const cuttable = verdictView.verdict === VERDICT_CUTTABLE;

  return (
    <div className="app">
      <header className="app-header">
        <h1>档案装裱排版校验台</h1>
        <p className="subtitle">
          纸张 {SHEET_WIDTH}×{SHEET_HEIGHT} 毫米 · 左上原点 · 矩形半开、圆形按正面积相交
          （边线相接与外切允许） · 压边安全区 {MARGIN} 毫米
        </p>
      </header>

      <div
        className={`verdict ${cuttable ? "verdict-ok" : "verdict-bad"}`}
        role="status"
        data-testid="verdict-banner"
        data-verdict={verdictView.verdict}
      >
        <span className="verdict-word">{verdictView.verdict}</span>
        <span className="verdict-note">
          {isPreview
            ? "（未保存预览，提交后生效）"
            : windows.length === 0
              ? "（空方案）"
              : "（已保存的裁决结果）"}
        </span>
      </div>

      {conflictLines.length > 0 ? (
        <ul className="conflict-list" data-testid="conflict-list">
          {conflictLines.map((line) => (
            <li key={line}>{line}</li>
          ))}
        </ul>
      ) : null}

      {banner ? (
        <p className={banner.type === "ok" ? "banner-ok" : "banner-error"}>{banner.text}</p>
      ) : null}

      <main className="layout">
        <section className="canvas-wrap">
          <div className="pickers">
            <div
              className="step-picker"
              data-testid="shape-picker"
              role="radiogroup"
              aria-label="观察窗形状"
            >
              <span className="step-picker-label">观察窗</span>
              {[
                { value: SHAPE_RECT, text: "矩形窗" },
                { value: SHAPE_CIRCLE, text: "圆形窗" },
              ].map(({ value, text }) => (
                <label
                  key={value}
                  className={shape === value ? "step-option step-option-active" : "step-option"}
                >
                  <input
                    type="radio"
                    name="shape"
                    value={value}
                    checked={shape === value}
                    onChange={() => changeShape(value)}
                  />
                  {text}
                </label>
              ))}
            </div>
            <div
              className="step-picker"
              data-testid="step-picker"
              role="radiogroup"
              aria-label="定位步长"
            >
              <span className="step-picker-label">定位步长</span>
              {GRID_STEPS.map((s) => (
                <label
                  key={s}
                  className={step === s ? "step-option step-option-active" : "step-option"}
                >
                  <input
                    type="radio"
                    name="step"
                    value={s}
                    checked={step === s}
                    onChange={() => changeStep(s)}
                  />
                  {s} 毫米
                </label>
              ))}
            </div>
          </div>
          <SheetCanvas
            defects={defects}
            windows={draftRect ? [...windows, { id: "__draft__", ...draftRect }] : windows}
            selectedId={selectedId}
            conflictingIds={[...conflictingIds, ...localInvalidIds]}
            hitDefects={[...hitDefects]}
            onSelect={setSelectedId}
            onMove={moveWindow}
            onDrawStart={handleDrawStart}
          />
          <p className="hint">
            在纸面空白处按住拖放可新开{shape === SHAPE_CIRCLE ? "圆" : "矩"}窗（以宽高较小值为直径并按步长吸附）；
            拖动开窗可移动（坐标按所选步长吸附并限制在安全区内）。
          </p>
        </section>

        <aside className="panel">
          <WindowForm
            win={selected}
            serverErrors={selected ? rowErrorMap.get(selected.id) : undefined}
            onChange={updateWindow}
            onDelete={deleteWindow}
          />

          <h2>开窗列表（{windows.length}）</h2>
          <ul className="window-list">
            {windows.map((w, i) => {
              const winShape = w.shape ?? SHAPE_RECT;
              const errs = fieldErrors(w.x, w.y, w.w, w.h, step, winShape);
              const serverErrs = rowErrorMap.get(w.id);
              const bad = conflictingIds.has(w.id) || localInvalidIds.has(w.id);
              const sizeText =
                winShape === SHAPE_CIRCLE ? `Ø${w.w}` : `${w.w}×${w.h}`;
              const fieldLabel = (k) => {
                if (k === "label") return "编号";
                if (k === "shape") return "形状";
                if (winShape === SHAPE_CIRCLE && (k === "w" || k === "h")) return "直径";
                return k;
              };
              return (
                <li
                  key={w.id}
                  className={bad ? "row row-conflict" : "row"}
                  data-testid={`list-row-${i}`}
                >
                  <button
                    type="button"
                    className="row-select"
                    onClick={() => setSelectedId(w.id)}
                  >
                    {windowName(w, i)} ({w.x}, {w.y}) {sizeText}
                  </button>
                  {Object.entries({ ...errs, ...(serverErrs ?? {}) }).map(([k, v]) => (
                    <small key={k} className="error-text">
                      {fieldLabel(k)}: {v}
                    </small>
                  ))}
                </li>
              );
            })}
          </ul>

          <button
            type="button"
            className="btn-primary"
            onClick={handleSubmit}
            disabled={loading || windows.length === 0}
            data-testid="submit-btn"
          >
            提交方案并裁决
          </button>
          {submitRows.length > 0 ? (
            <p className="banner-error" data-testid="submit-errors">
              存在 {submitRows.length} 个非法开窗，整次提交未保存。
            </p>
          ) : null}
        </aside>
      </main>

      <footer className="legend">
        <span><i className="sw sw-defect" /> 内置只读瑕疵区</span>
        <span><i className="sw sw-window" /> 开窗</span>
        <span><i className="sw sw-conflict" /> 冲突高亮</span>
      </footer>
    </div>
  );
}
