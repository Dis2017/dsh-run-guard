/**
 * dsh-run-guard client half: contributes a "Run guard" section to the DSH
 * Settings shell (settings.section slot) that edits the plugin's settings
 * namespace through the standard settings wire face (connection.api.settings).
 *
 * Hand-written in the client-bundle format consumed by the shell's module
 * loader (window.__ModuleLoader__.load), same as dsh-better-sidebar.
 * @module dsh-run-guard/client
 */
window.__ModuleLoader__.load({
  id: "dsh-run-guard",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });
    let React = require("react");
    const h = React.createElement;

    const NS = "run-guard";
    /** Client services required before activation (provided by the client runtime). */
    const inject = ["slots", "connection"];

    /** Field catalogue mirroring the host Config schema. */
    const FIELDS = [
      { group: "通用", path: ["enabled"], label: "启用插件", type: "boolean" },
      { group: "Guard · 死循环拦截", path: ["guard", "enabled"], label: "死循环拦截", type: "boolean" },
      { group: "Guard · 死循环拦截", path: ["guard", "windowChars"], label: "滑动窗口(字符)", type: "number", min: 64 },
      { group: "Guard · 死循环拦截", path: ["guard", "substrLen"], label: "重复检测子串长度", type: "number", min: 8, max: 128 },
      { group: "Guard · 死循环拦截", path: ["guard", "repeatRatio"], label: "窗口重复率阈值(0-1)", type: "number", step: 0.01, min: 0, max: 1 },
      { group: "Guard · 死循环拦截", path: ["guard", "checkEvery"], label: "检测频率(每 N 块)", type: "number", min: 1 },
      { group: "Guard · 死循环拦截", path: ["guard", "maxBlocks"], label: "硬闸:推理块数上限", type: "number", min: 100 },
      { group: "Guard · 死循环拦截", path: ["guard", "maxChars"], label: "硬闸:推理字符数上限", type: "number", min: 1000 },
      { group: "Guard · 死循环拦截", path: ["guard", "maxGuardRetries"], label: "中断后自动重试上限", type: "number", min: 0, max: 10 },
      { group: "Guard · 死循环拦截", path: ["guard", "autoRetryErrors"], label: "额外重试错误码(逗号分隔)", type: "csv" },
      { group: "Continue · 自动继续", path: ["continue", "enabled"], label: "自动继续", type: "boolean" },
      { group: "Continue · 自动继续", path: ["continue", "maxAutoFollowups"], label: "有 todo 续跑上限", type: "number", min: 1, max: 20 },
    ];

    const getPath = (obj, path) => path.reduce((o, k) => (o == null ? undefined : o[k]), obj);
    const setPath = (obj, path, value) => {
      const copy = JSON.parse(JSON.stringify(obj ?? {}));
      let cur = copy;
      for (let i = 0; i < path.length - 1; i++) {
        if (typeof cur[path[i]] !== "object" || cur[path[i]] === null) cur[path[i]] = {};
        cur = cur[path[i]];
      }
      cur[path[path.length - 1]] = value;
      return copy;
    };

    /** Settings section rendered inside the DSH Settings shell. */
    function RunGuardSection({ api }) {
      const [view, setView] = React.useState(null);
      const [draft, setDraft] = React.useState(null);
      const [status, setStatus] = React.useState("");

      React.useEffect(() => {
        let cancelled = false;
        api.settings.describe({}).then((resp) => {
          if (cancelled) return;
          const res = resp?.result;
          if (!res?.ok) return;
          const v = (res.value?.namespaces ?? []).find((c) => c.ns === NS);
          if (!v) return;
          setView(v);
          setDraft(JSON.parse(JSON.stringify(v.value ?? {})));
        }).catch(() => {});
        return () => { cancelled = true; };
      }, [api]);

      const refresh = async () => {
        const resp = await api.settings.describe({});
        const v = resp?.result?.ok ? (resp.result.value?.namespaces ?? []).find((c) => c.ns === NS) : undefined;
        if (v) {
          setView(v);
          setDraft(JSON.parse(JSON.stringify(v.value ?? {})));
        }
      };

      const commit = async () => {
        if (!view || !draft) return;
        const ops = [];
        for (const f of FIELDS) {
          const next = getPath(draft, f.path);
          const prev = getPath(view.value, f.path);
          if (JSON.stringify(next) !== JSON.stringify(prev)) {
            ops.push({ op: "set", path: f.path, value: next });
          }
        }
        if (ops.length === 0) { setStatus("无变更"); return; }
        setStatus("保存中…");
        try {
          await api.settings.mutate({ ns: NS, ops, expectedRevision: view.revision });
          setStatus("已保存 ✓");
          await refresh();
        } catch (e) {
          setStatus("保存失败: " + (e?.message ?? String(e)));
        }
      };

      const row = (f) => {
        const val = getPath(draft, f.path);
        const input = f.type === "boolean"
          ? h("input", { type: "checkbox", checked: !!val, onChange: (e) => setDraft(setPath(draft, f.path, e.target.checked)) })
          : f.type === "csv"
            ? h("input", { type: "text", style: { minWidth: 220 }, value: Array.isArray(val) ? val.join(",") : "", onChange: (e) => setDraft(setPath(draft, f.path, e.target.value.split(",").map((s) => s.trim()).filter(Boolean))) })
            : h("input", { type: "number", style: { minWidth: 120 }, value: val ?? "", step: f.step, min: f.min, max: f.max, onChange: (e) => setDraft(setPath(draft, f.path, e.target.value === "" ? undefined : Number(e.target.value))) });
        return h("label", { key: f.path.join("."), style: { display: "flex", alignItems: "center", gap: 8, padding: "4px 0" } },
          h("span", { style: { flex: 1 } }, f.label),
          input);
      };

      const groups = [];
      for (const f of FIELDS) {
        const g = groups.find((x) => x.name === f.group);
        if (g) g.fields.push(f);
        else groups.push({ name: f.group, fields: [f] });
      }

      return h("div", { style: { padding: "8px 4px" } },
        groups.map((g) => h("fieldset", { key: g.name, style: { border: "1px solid #3a3a42", borderRadius: 6, marginBottom: 12, padding: "0 12px 8px" } },
          h("legend", { style: { padding: "0 6px" } }, g.name),
          g.fields.map(row))),
        h("div", { style: { display: "flex", alignItems: "center", gap: 12 } },
          h("button", { type: "button", onClick: commit, disabled: !view, style: { padding: "4px 16px", cursor: "pointer" } }, "保存"),
          status ? h("span", { style: { color: "#888", fontSize: 12 } }, status) : null));
    }

    /** Client plugin body. */
    function apply(ctx) {
      ctx.slots.inject("settings.section", () => ctx.slots.register({
        name: "settings.section",
        id: "run-guard",
        order: 100,
        label: () => "Run guard",
        inject: () => ({ api: ctx.connection.api })
      }, RunGuardSection));
    }

    exports.apply = apply;
    exports.inject = inject;
    return module.exports;
  }
});
