import { useEffect, useMemo, useState } from "react";
import SheetCanvas from "./components/SheetCanvas.jsx";
import WindowForm from "./components/WindowForm.jsx";
import { fetchDefects, fetchLayout, submitLayout } from "./api.js";
import {
  DEFECTS,
  INNER_BOTTOM,
  INNER_RIGHT,
  MARGIN,
  SHEET_HEIGHT,
  SHEET_WIDTH,
  VERDICT_CUTTABLE,
  VERDICT_REJECTED,
  adjudicate,
  clampIntoInner,
  fieldErrors,
  windowName,
} from "./geometry.js";

let tmpCounter = 0;
const nextTmpId = () => `tmp-${++tmpCounter}`;

function clientToMm(svg, event) {
  const ctm = svg.getScreenCTM();
  const pt = new DOMPoint(event.clientX, event.clientY).matrixTransform(ctm.inverse());
  return { x: pt.x, y: pt.y };
}

// 把拖拽中的开窗左上角限制在安全区内（整窗不得越界）
function clampTopLeft(x, y, w, h) {
  return [
    Math.min(Math.max(Math.round(x), MARGIN), INNER_RIGHT - w),
    Math.min(Math.max(Math.round(y), MARGIN), INNER_BOTTOM - h),
  ];
}

export default function App() {
  const [defects, setDefects] = useState(
    DEFECTS.map((d, index) => ({ index, ...d }))
  );
  const [windows, setWindows] = useState([]);
  const [selectedId, setSelectedId] = useState(null);
  const [draftRect, setDraftRect] = useState(null); // 正在拖放的新开窗
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
        if (layout.windows.length > 0) {
          setWindows(
            [...layout.windows]
              .sort((a, b) => a.position - b.position)
              .map(({ id, x, y, w, h, label }) => ({ id, x, y, w, h, label: label ?? "" }))
          );
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

  // 本地字段非法（越过安全区等）时也不能给出“可裁切”
  const localInvalidIds = useMemo(
    () =>
      new Set(
        windows
          .filter((win) => Object.keys(fieldErrors(win.x, win.y, win.w, win.h)).length > 0)
          .map((w) => w.id)
      ),
    [windows]
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

  function updateWindow(id, patch) {
    setWindows((list) =>
      list.map((w) => {
        if (w.id !== id) return w;
        const next = { ...w, ...patch };
        // 本地编辑也要保证整窗在安全区内
        if (patch.w !== undefined || patch.h !== undefined) {
          next.w = Math.min(Math.max(next.w, 1), INNER_RIGHT - next.x);
          next.h = Math.min(Math.max(next.h, 1), INNER_BOTTOM - next.y);
        }
        return next;
      })
    );
    markDirty();
  }

  function moveWindow(id, x, y) {
    setWindows((list) =>
      list.map((w) =>
        w.id === id
          ? (() => {
              const [cx, cy] = clampTopLeft(x, y, w.w, w.h);
              return { ...w, x: cx, y: cy };
            })()
          : w
      )
    );
    markDirty();
  }

  function addWindow(rect) {
    setWindows((list) => [...list, { id: nextTmpId(), label: "", ...rect }]);
    setSelectedId(null);
    markDirty();
  }

  function deleteWindow(id) {
    setWindows((list) => list.filter((w) => w.id !== id));
    setSelectedId((cur) => (cur === id ? null : cur));
    markDirty();
  }

  // ---- 在纸面空白处拖放新开窗 ----
  function handleDrawStart(event) {
    const svg = event.currentTarget;
    if (event.target !== svg && !event.target.classList.contains("paper")) return;
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
      setDraftRect(current);
    }
    function onUp() {
      window.removeEventListener("pointermove", onMove);
      setDraftRect(null);
      if (current && current.w >= 1 && current.h >= 1) {
        addWindow(current);
      }
    }
    window.addEventListener("pointermove", onMove);
    window.addEventListener("pointerup", onUp, { once: true });
  }

  async function handleSubmit() {
    setBanner(null);
    const result = await submitLayout(windows);
    if (result.ok) {
      const { data } = result;
      setWindows(
        [...data.windows]
          .sort((a, b) => a.position - b.position)
          .map(({ id, x, y, w, h, label }) => ({ id, x, y, w, h, label: label ?? "" }))
      );
      setSaved({ verdict: data.verdict, result: data.result });
      setDirty(false);
      setSubmitRows([]);
      setSelectedId(null); // 临时 id 已被数据库 id 取代，清掉失效选中
      setBanner({ type: "ok", text: "方案已保存" });
    } else {
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
          纸张 {SHEET_WIDTH}×{SHEET_HEIGHT} 毫米 · 左上原点 · 半开矩形 ·
          压边安全区 {MARGIN} 毫米
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
          <p className="hint">在纸面空白处按住拖放可新开窗；拖动开窗可移动（坐标自动取整并限制在安全区内）。</p>
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
              const errs = fieldErrors(w.x, w.y, w.w, w.h);
              const serverErrs = rowErrorMap.get(w.id);
              const bad = conflictingIds.has(w.id) || localInvalidIds.has(w.id);
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
                    {windowName(w, i)} ({w.x}, {w.y}) {w.w}×{w.h}
                  </button>
                  {Object.entries({ ...errs, ...(serverErrs ?? {}) }).map(([k, v]) => (
                    <small key={k} className="error-text">
                      {k === "label" ? "编号" : k}: {v}
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
