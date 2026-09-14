// 选中开窗后的 x、y、宽、高 编辑表单。
// 文本在本地保留字符串状态，失焦或按 Enter 时解析为整数并提交。
import { useEffect, useState } from "react";

const FIELDS = [
  { key: "x", label: "x（毫米）" },
  { key: "y", label: "y（毫米）" },
  { key: "w", label: "宽（毫米）" },
  { key: "h", label: "高（毫米）" },
];

export default function WindowForm({ win, serverErrors, onChange, onDelete }) {
  const [drafts, setDrafts] = useState({});

  useEffect(() => {
    // 切换选中或外部（拖拽）数值变化时重置草稿
    setDrafts({});
  }, [win?.id, win?.x, win?.y, win?.w, win?.h]);

  if (!win) {
    return <p className="hint">在纸面上拖放开窗，或在列表中选择开窗后填写坐标。</p>;
  }

  function commit(key, raw) {
    if (raw.trim() === "") return;
    const value = Number(raw);
    if (!Number.isInteger(value)) return;
    onChange(win.id, { [key]: value });
    setDrafts((d) => {
      const next = { ...d };
      delete next[key];
      return next;
    });
  }

  return (
    <fieldset className="window-form" data-testid="window-form">
      <legend>
        开窗 <strong>{win.id}</strong>
      </legend>
      <div className="field-grid">
        {FIELDS.map(({ key, label }) => {
          const value = drafts[key] ?? String(win[key]);
          const err = serverErrors?.[key];
          return (
            <label key={key} className={err ? "field field-error" : "field"}>
              <span>{label}</span>
              <input
                type="text"
                inputMode="numeric"
                value={value}
                aria-label={label}
                aria-invalid={err ? "true" : "false"}
                onChange={(e) => setDrafts((d) => ({ ...d, [key]: e.target.value }))}
                onBlur={(e) => commit(key, e.target.value)}
                onKeyDown={(e) => {
                  if (e.key === "Enter") {
                    e.currentTarget.blur();
                  }
                }}
              />
              {err ? <small className="error-text">{err}</small> : null}
            </label>
          );
        })}
      </div>
      <button type="button" className="btn-danger" onClick={() => onDelete(win.id)}>
        删除该开窗
      </button>
    </fieldset>
  );
}
