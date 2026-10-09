/* SuperLcm uses only the host's authenticated connection and native React UI. */
"use strict";
window.__ModuleLoader__.load({
  id: "SuperLcm",
  factory: (require) => {
    const React = require("react");
    const h = React.createElement;
    const colors = {
      text: "var(--dsw-alias-label-primary, #ddd)",
      muted: "var(--dsw-alias-label-tertiary, #888)",
      border: "var(--dsw-alias-border-l2, #555)",
      surface: "var(--dsw-alias-background-l2, transparent)",
    };
    const styles = {
      stack: { display: "flex", flexDirection: "column", gap: 14, minWidth: 0 },
      row: { display: "flex", gap: 8, alignItems: "center", flexWrap: "wrap" },
      card: { border: `1px solid ${colors.border}`, borderRadius: 9, padding: 14 },
      hint: { color: colors.muted, fontSize: 12, lineHeight: 1.6 },
      input: { color: colors.text, background: "transparent", border: `1px solid ${colors.border}`,
        borderRadius: 6, padding: "7px 9px", font: "inherit", minWidth: 0, boxSizing: "border-box" },
      button: { color: colors.text, background: "transparent", border: `1px solid ${colors.border}`,
        borderRadius: 6, padding: "6px 12px", font: "inherit", cursor: "pointer" },
      text: { whiteSpace: "pre-wrap", overflowWrap: "anywhere", font: "inherit", lineHeight: 1.7 },
    };
    const defaults = { summaryEnabled: false, summaryProvider: "", summaryModel: "", chunkTokens: 20000,
      fanout: 4, takeover: false, compactionProvider: "", compactionModel: "", compressionRatio: 0.8,
      compressionChunkTokens: 20000 };
    const errorText = (error) => error && error.message ? error.message : "请求失败，请重试。";
    const note = (text, error) => h("p", { role: error ? "alert" : "status",
      style: { ...styles.hint, margin: 0, ...(error ? { color: "#e5484d" } : {}) } }, text);
    const button = (label, onClick, disabled, extra = {}) => h("button", {
      type: "button", onClick, disabled, ...extra,
      style: { ...styles.button, ...(disabled ? { opacity: 0.5, cursor: "default" } : {}), ...extra.style },
    }, label);
    const field = (label, control, hint) => h("label", { style: styles.stack },
      h("span", { style: { fontWeight: 600 } }, label), control, hint && note(hint));
    async function rpc(connection, method, payload = null) {
      if (!connection || !connection.rpc) throw new Error("DSH 连接暂时不可用，请重新打开插件页。");
      const result = await connection.rpc.call("/api", "dsh-superlcm/" + method, payload);
      if (!result || result.ok !== true) {
        const error = new Error(result && result.error && result.error.message || "服务返回了无效结果。");
        error.code = result && result.error && result.error.code;
        throw error;
      }
      return result.value;
    }
    function validate(settings, catalog) {
      for (const [key, label] of [["chunkTokens", "摘要分块"], ["compressionChunkTokens", "压缩分块"]]) {
        if (!Number.isInteger(settings[key]) || settings[key] < 1000 || settings[key] > 4000000 || settings[key] % 1000 !== 0)
          return `${label}须为 1 至 4,000 K Token，按整数 K 输入。`;
      }
      if (!Number.isInteger(settings.fanout) || settings.fanout < 2 || settings.fanout > 100)
        return "每次合并须为 2 至 100 段的整数，建议至少 4 段。";
      if (!Number.isFinite(settings.compressionRatio) || settings.compressionRatio < 0.01 || settings.compressionRatio > 0.99 ||
        Math.abs(settings.compressionRatio * 100 - Math.round(settings.compressionRatio * 100)) > 1e-8)
        return "压缩比例须为 1% 至 99% 的整数百分比。";
      for (const [enabled, provider, model, label] of [
        [settings.summaryEnabled, settings.summaryProvider, settings.summaryModel, "摘要"],
        [settings.takeover, settings.compactionProvider, settings.compactionModel, "压缩"],
      ]) {
        if (!enabled) continue;
        const entry = catalog.find((item) => item.id === provider);
        if (!entry || !entry.models.some((item) => item.id === model)) return `请选择宿主中可用的${label}供应商和模型。`;
      }
      return "";
    }
    function Choice({ label, value, presets, unit, min, max, onChange, onSave, busy, scale = 1 }) {
      const shown = Number.isFinite(value) ? Math.round(value * scale * 100) / 100 : "";
      const [custom, setCustom] = React.useState(!presets.includes(shown));
      React.useEffect(() => { if (!presets.includes(shown)) setCustom(true); }, [shown]);
      return h("div", { style: styles.stack },
        h("span", { style: { fontWeight: 600 } }, label),
        h("div", { style: styles.row },
          presets.map((preset) => button(`${preset.toLocaleString()} ${unit}`, () => {
            setCustom(false); onChange(preset / scale);
          }, busy, { key: preset, "aria-pressed": !custom && shown === preset,
            style: !custom && shown === preset ? { background: colors.surface, borderColor: colors.text } : {} })),
          button("自定义", () => setCustom(true), busy, { "aria-pressed": custom }),
          custom && h("input", { type: "number", "aria-label": label, min, max, step: 1, value: shown,
            disabled: busy, style: { ...styles.input, width: 120 }, onChange: (event) =>
              onChange(event.target.value === "" ? "" : Number(event.target.value) / scale) }),
          custom && h("span", { style: styles.hint }, unit),
          button(busy ? "保存中…" : "保存", onSave, busy)),
        note(`范围：${min.toLocaleString()} 至 ${max.toLocaleString()} ${unit}。${unit === "K Token" ? "1 K 等于 1,000 Token，按整数 K 输入。" : ""}`));
    }
    function ModelPicker({ catalog, settings, prefix, update, busy }) {
      const providerKey = prefix === "summary" ? "summaryProvider" : "compactionProvider";
      const modelKey = prefix === "summary" ? "summaryModel" : "compactionModel";
      const provider = settings[providerKey], model = settings[modelKey];
      const selected = catalog.find((item) => item.id === provider);
      const models = selected ? selected.models : [];
      return h("div", { style: { ...styles.row, alignItems: "flex-start" } },
        field("供应商", h("select", { value: provider, disabled: busy, "aria-label": "供应商",
          style: { ...styles.input, maxWidth: "100%" }, onChange: (event) =>
            update({ [providerKey]: event.target.value, [modelKey]: "" }) },
          h("option", { value: "" }, "选择宿主供应商"),
          provider && !selected && h("option", { value: provider }, `${provider}（暂不可用）`),
          catalog.map((item) => h("option", { key: item.id, value: item.id }, item.label || item.id)))),
        field("模型", h("select", { value: model, disabled: busy || !selected, "aria-label": "模型",
          style: { ...styles.input, maxWidth: "100%" }, onChange: (event) => update({ [modelKey]: event.target.value }) },
          h("option", { value: "" }, "选择模型"),
          model && !models.some((item) => item.id === model) && h("option", { value: model }, `${model}（暂不可用）`),
          models.map((item) => h("option", { key: item.id, value: item.id }, item.label || item.id)))));
    }
    function Settings({ section, snapshot, draft, update, save, busy }) {
      const compression = section === "compression";
      const backgroundError = ["capture", "summary"].includes(snapshot.runtime?.lastDiagnostic?.stage);
      const enabledKey = compression ? "takeover" : "summaryEnabled";
      const prefix = compression ? "compaction" : "summary";
      return h("div", { style: styles.stack },
        h("div", { style: styles.row },
          h("label", { style: styles.row }, h("input", { type: "checkbox", checked: !!draft[enabledKey], disabled: busy,
            onChange: (event) => update({ [enabledKey]: event.target.checked }) }),
          compression ? "由 SuperLcm 接管上下文压缩" : "启用后台分层摘要"),
          button(busy ? "保存中…" : "保存", save, busy),
          compression && draft.takeover && h("span", { style: { ...styles.hint, ...styles.card, padding: "2px 7px" } },
            snapshot.runtime && snapshot.runtime.mode === "superlcm" ? "SuperLcm 正在接管" : "等待保存后接管")),
        note(compression ? "开启后使用下方独立模型压缩上下文。压缩比例是相对模型上下文上限的触发位置。" :
          "原始对话持续归档。开启后用下方模型生成可浏览、可检索的分层摘要。"),
        h(ModelPicker, { catalog: snapshot.catalog || [], settings: draft, prefix, update, busy }),
        !(snapshot.catalog || []).length && note("宿主尚无可用模型，请先在 DSH 的模型设置中配置供应商。"),
        h("div", { style: styles.row }, button("保存模型选择", save, busy)),
        compression && h(Choice, { label: "压缩比例", value: draft.compressionRatio, presets: [70, 80, 90],
          unit: "%", min: 1, max: 99, scale: 100, onChange: (value) => update({ compressionRatio: value }), onSave: save, busy }),
        h(Choice, { label: compression ? "每个压缩分块" : "每个摘要分块", value: draft[compression ? "compressionChunkTokens" : "chunkTokens"],
          presets: [10, 20, 40], unit: "K Token", min: 1, max: 4000, scale: 0.001,
          onChange: (value) => update({ [compression ? "compressionChunkTokens" : "chunkTokens"]: value }), onSave: save, busy }),
        !compression && h("details", { style: styles.card }, h("summary", { style: { cursor: "pointer" } }, "高级设置"),
          h("div", { style: { ...styles.stack, marginTop: 12 } }, field("每次合并的摘要段数",
            h("div", { style: styles.row }, h("input", { type: "number", value: draft.fanout, min: 2, max: 100,
              step: 1, disabled: busy, "aria-label": "每次合并的摘要段数", style: { ...styles.input, width: 100 },
              onChange: (event) => update({ fanout: event.target.value === "" ? "" : Number(event.target.value) }) }),
            h("span", null, "段"), button("保存", save, busy)), "范围：2 至 100 段。默认合并 4 段，建议至少保留 4 段再生成上一层摘要。"))),
        (backgroundError || (compression && draft.takeover)) && snapshot.runtime && snapshot.runtime.lastError && note(snapshot.runtime.lastError, true));
    }
    function Form({ connection, view }) {
      const [tab, setTab] = React.useState("summary"), [snapshot, setSnapshot] = React.useState(null);
      const [draft, setDraft] = React.useState(null), [loading, setLoading] = React.useState(true);
      const [busy, setBusy] = React.useState(false), [message, setMessage] = React.useState("");
      const [isError, setIsError] = React.useState(false), [conflict, setConflict] = React.useState(false);
      const request = React.useRef(0), alive = React.useRef(true);
      const report = (text, error) => { setMessage(text); setIsError(error); };
      React.useEffect(() => {
        alive.current = true; setBusy(false); setConflict(false); setSnapshot(null); setDraft(null); load(false);
        return () => { alive.current = false; request.current++; };
      }, [connection]);
      async function load(preserve) {
        const current = ++request.current;
        setLoading(true);
        try {
          const value = await rpc(connection, "read");
          if (!alive.current || current !== request.current) return;
          setSnapshot(value); if (!preserve) setDraft({ ...defaults, ...value.settings });
          setConflict(false); report(preserve ? "已读取最新设置。当前草稿已保留，请确认后保存。" : "", false);
        } catch (error) { if (alive.current && current === request.current) report(errorText(error), true); }
        finally { if (alive.current && current === request.current) setLoading(false); }
      }
      function update(patch) { setDraft((previous) => ({ ...previous, ...patch })); setMessage(""); }
      async function save() {
        if (!draft || !snapshot || busy) return;
        const error = validate(draft, snapshot.catalog || []);
        if (error) { report(error, true); return; }
        const current = ++request.current;
        setBusy(true); report("", false);
        try {
          const value = await rpc(connection, "save", { revision: snapshot.revision, settings: draft });
          if (!alive.current || current !== request.current) return;
          setSnapshot(value); setDraft({ ...defaults, ...value.settings }); setConflict(false); report("设置已保存。", false);
        } catch (error) {
          if (!alive.current || current !== request.current) return;
          setConflict(/conflict|revision/i.test(String(error.code || ""))); report(`${errorText(error)} 当前草稿已保留。`, true);
        } finally { if (alive.current && current === request.current) setBusy(false); }
      }
      if (view === "summary") return h("span", { style: styles.hint }, "后台摘要和可选压缩设置");
      return h("section", { style: { ...styles.stack, color: colors.text, fontSize: 14, padding: "14px 0" }, "aria-label": "SuperLcm 设置" },
        h("p", { style: { ...styles.hint, margin: 0 } }, "保存完整原文，在后台整理摘要，需要时读回历史细节。 ",
          h("a", { href: "https://github.com/yu381792/superlcm", target: "_blank", rel: "noopener noreferrer", style: { color: "inherit", textDecoration: "underline" } }, "了解完整 SuperLcm 项目 ↗")),
        h("div", { style: styles.row, role: "tablist", "aria-label": "SuperLcm 分区" },
          [["summary", "摘要设置"], ["compression", "压缩"]].map(([key, label]) =>
            button(label, () => setTab(key), false, { key, id: `superlcm-tab-${key}`, role: "tab", "aria-selected": tab === key,
              "aria-controls": "superlcm-panel", style: tab === key ? { borderColor: colors.text, fontWeight: 600 } : {} }))),
        message && note(message, isError),
        conflict && button("读取最新设置并保留草稿", () => load(true), loading || busy),
        loading && note("正在读取设置…"),
        !loading && !snapshot && button("重试读取设置", () => load(false), false),
        snapshot && draft && h("div", { id: "superlcm-panel", role: "tabpanel", "aria-labelledby": `superlcm-tab-${tab}` },
          h(Settings, {
            section: tab, snapshot, draft, update, save, busy: busy || loading })),
        snapshot && draft && JSON.stringify(draft) !== JSON.stringify({ ...defaults, ...snapshot.settings }) &&
          note("有尚未保存的设置。各项保存按钮会一并保存全部更改。"));
    }
    function apply(ctx) {
      ctx.slots.inject("plugins.bundle.config", () => ctx.slots.register({
        name: "plugins.bundle.config", key: "SuperLcm", inject: () => ({ connection: ctx.connection }),
      }, Form));
    }
    return { name: "SuperLcm-client", inject: ["slots", "connection"], apply };
  },
});
