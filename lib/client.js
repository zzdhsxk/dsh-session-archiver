/**
 * dsh-session-archiver — Client half.
 * 侧栏「会话仓库」按钮 → 面板：会话列表（标题/子会话标签/大小/工作区/轮次/活跃）+ 归档列表
 * + 归档 / 恢复 / 移动 / 回收站 + 自动维护设置（超阈值自动归档、清回收站、可选清超龄归档）。
 * 无构建步骤，由 DSH 作为 Cordis client bundle 加载。
 */
window.__ModuleLoader__.load({
  id: "dsh-session-archiver",
  factory: (require) => {
    var module = { exports: {} };
    var exports = module.exports;
    Object.defineProperty(exports, Symbol.toStringTag, { value: "Module" });

    const React = require("react");
    const { useState, useEffect, useCallback } = React;
    const h = React.createElement;
    const API = "/session-archiver/api";

    function fmt(n) {
      const v = Number(n) || 0;
      if (v < 1024) return v + " B";
      if (v < 1024 * 1024) return (v / 1024).toFixed(1) + " KB";
      if (v < 1024 * 1024 * 1024) return (v / 1024 / 1024).toFixed(1) + " MB";
      return (v / 1024 / 1024 / 1024).toFixed(2) + " GB";
    }
    function shortId(s) {
      const t = String(s || "");
      return t.length > 20 ? t.slice(0, 20) + "..." : t;
    }
    function shortWs(s) {
      return String(s || "").split("-").filter(Boolean).join("/").split("~0020").join(" ");
    }
    function relTime(v) {
      if (v === null || v === undefined || v === "") return "";
      const ms = typeof v === "number" ? v : Date.parse(v);
      if (!ms || isNaN(ms)) return String(v).slice(0, 16).split("T").join(" ");
      const diff = Date.now() - ms;
      if (diff < 60000) return "刚刚";
      if (diff < 3600000) return Math.round(diff / 60000) + " 分钟前";
      if (diff < 86400000) return Math.round(diff / 3600000) + " 小时前";
      if (diff < 7 * 86400000) return Math.round(diff / 86400000) + " 天前";
      const d = new Date(ms);
      const mm = String(d.getMonth() + 1);
      const dd = String(d.getDate());
      return d.getFullYear() + "-" + (mm.length < 2 ? "0" + mm : mm) + "-" + (dd.length < 2 ? "0" + dd : dd);
    }
    function label(it) {
      if (it.title && String(it.title).trim() !== "") return String(it.title);
      return shortId(it.sessionId);
    }

    async function api(path, body) {
      const res = await fetch(API + path, {
        method: body ? "POST" : "GET",
        headers: { "content-type": "application/json" },
        body: body ? JSON.stringify(body) : undefined
      });
      let json = null;
      try { json = await res.json(); } catch (e) { json = null; }
      if (!json) throw new Error("响应不是 JSON（HTTP " + res.status + "）");
      if (!json.ok) throw new Error(json.error || ("HTTP " + res.status));
      return json.result;
    }

    const S = {
      wrap: { position: "relative", display: "inline-block" },
      trigger: { cursor: "pointer", display: "flex", alignItems: "center", gap: "6px", border: "1px solid rgba(128,128,128,0.35)", borderRadius: "8px", background: "transparent", color: "inherit", padding: "4px 10px", fontSize: "12px" },
      head: { display: "flex", alignItems: "center", justifyContent: "space-between", marginBottom: "8px", cursor: "move", userSelect: "none" },
      row: { padding: "6px 0", borderBottom: "1px solid rgba(128,128,128,0.15)" },
      line: { display: "flex", alignItems: "center", gap: "6px" },
      grow: { flex: 1, minWidth: 0 },
      titleRow: { display: "flex", alignItems: "center", gap: "5px", minWidth: 0 },
      titleText: { fontSize: "12px", fontWeight: 500, overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
      badgeSub: { flex: "0 0 auto", fontSize: "10px", lineHeight: "14px", padding: "0 5px", borderRadius: "4px", border: "1px solid rgba(150,120,220,0.55)", color: "#b6a2ea", whiteSpace: "nowrap" },
      badgeAuto: { flex: "0 0 auto", fontSize: "10px", lineHeight: "14px", padding: "0 5px", borderRadius: "4px", border: "1px solid rgba(120,180,120,0.55)", color: "#8fc98f", whiteSpace: "nowrap" },
      badgeOn: { fontSize: "11px", padding: "0 6px", borderRadius: "999px", border: "1px solid rgba(120,180,120,0.55)", color: "#8fc98f" },
      badgeOff: { fontSize: "11px", padding: "0 6px", borderRadius: "999px", border: "1px solid rgba(128,128,128,0.4)", opacity: 0.75 },
      meta: { opacity: 0.62, fontSize: "11px", marginTop: "1px", overflow: "hidden", textOverflow: "ellipsis", whiteSpace: "nowrap" },
      btn: { cursor: "pointer", border: "1px solid rgba(128,128,128,0.4)", borderRadius: "6px", background: "transparent", color: "inherit", padding: "2px 8px", fontSize: "11px", whiteSpace: "nowrap" },
      btnPrimary: { cursor: "pointer", border: "1px solid rgba(120,170,255,0.6)", borderRadius: "6px", background: "rgba(120,170,255,0.14)", color: "inherit", padding: "2px 10px", fontSize: "11px", whiteSpace: "nowrap" },
      btnDanger: { cursor: "pointer", border: "1px solid rgba(220,80,80,0.55)", borderRadius: "6px", background: "transparent", color: "#e08585", padding: "2px 8px", fontSize: "11px", whiteSpace: "nowrap" },
      pill: (on) => ({ cursor: "pointer", padding: "2px 10px", borderRadius: "999px", border: "1px solid rgba(128,128,128,0.4)", background: on ? "rgba(120,170,255,0.22)" : "transparent", color: "inherit", fontSize: "11px" }),
      msg: { marginTop: "8px", padding: "6px 8px", borderRadius: "6px", background: "rgba(128,128,128,0.15)", fontSize: "11px", wordBreak: "break-all" },
      stat: { display: "flex", gap: "14px", marginBottom: "8px", fontSize: "11px", opacity: 0.85, flexWrap: "wrap" },
      select: { background: "transparent", color: "inherit", border: "1px solid rgba(128,128,128,0.4)", borderRadius: "6px", fontSize: "11px", padding: "2px 4px", maxWidth: "230px" },
      moveRow: { display: "flex", gap: "4px", alignItems: "center", marginTop: "5px", flexWrap: "wrap" },
      autoBox: { marginTop: "10px", paddingTop: "8px", borderTop: "1px dashed rgba(128,128,128,0.3)" },
      autoGrid: { display: "grid", gridTemplateColumns: "1fr 1fr", gap: "6px 10px", marginTop: "8px", fontSize: "11px" },
      field: { display: "flex", flexDirection: "column", gap: "3px" },
      input: { background: "transparent", color: "inherit", border: "1px solid rgba(128,128,128,0.4)", borderRadius: "6px", fontSize: "11px", padding: "3px 6px", width: "100%", boxSizing: "border-box" },
      hint: { marginTop: "8px", fontSize: "11px", opacity: 0.62 }
    };

    class Boundary extends React.Component {
      constructor(props) { super(props); this.state = { err: null }; }
      static getDerivedStateFromError(err) { return { err: err }; }
      render() {
        if (this.state.err) return h("div", { style: { padding: "8px", color: "#e08585", fontSize: "11px" } }, "会话仓库面板出错: " + String((this.state.err && this.state.err.message) || this.state.err));
        return this.props.children;
      }
    }

    const NUM_FIELDS = [
      { key: "libraryLimitMB", label: "会话库上限 (MB)", min: 10 },
      { key: "maxIdleDays", label: "仅归档闲置超过 (天)", min: 0 },
      { key: "trashRetentionDays", label: "回收站保留 (天)", min: 0 },
      { key: "archiveRetentionDays", label: "归档保留 (天，0=不自动删)", min: 0 },
      { key: "checkIntervalMinutes", label: "检查间隔 (分钟)", min: 5 }
    ];

    function Panel(props) {
      const onClose = props.onClose;
      const [tab, setTab] = useState("current");
      const [data, setData] = useState(null);
      const [busy, setBusy] = useState("");
      const [msg, setMsg] = useState("");
      const [force, setForce] = useState(false);
      const [moving, setMoving] = useState("");
      const [target, setTarget] = useState("");
      const [pos, setPos] = useState({ right: 16, bottom: 60 });
      const [showAuto, setShowAuto] = useState(false);
      const [autoDraft, setAutoDraft] = useState(null);

      const load = useCallback(async () => {
        try {
          const r = await api("/list");
          setData(r);
          setAutoDraft(r && r.auto ? Object.assign({}, r.auto) : null);
        } catch (e) { setMsg("加载失败: " + e.message); }
      }, []);
      useEffect(() => { load(); }, [load]);

      const startDrag = (e) => {
        const sx = e.clientX, sy = e.clientY;
        const base = { right: pos.right, bottom: pos.bottom };
        const onMove = (ev) => setPos({ right: Math.max(6, base.right - (ev.clientX - sx)), bottom: Math.max(6, base.bottom - (ev.clientY - sy)) });
        const onUp = () => { window.removeEventListener("mousemove", onMove); window.removeEventListener("mouseup", onUp); };
        window.addEventListener("mousemove", onMove);
        window.addEventListener("mouseup", onUp);
      };

      const act = async (name, sessionId, extra) => {
        setBusy(sessionId); setMsg("");
        try {
          const res = await api("/" + name, Object.assign({ sessionId: sessionId }, extra || {}));
          setMsg("已完成 " + name + "：" + label({ sessionId: sessionId, title: res && res.title }));
          setMoving("");
          await load();
        } catch (e) { setMsg("失败: " + e.message); } finally { setBusy(""); }
      };

      const saveAuto = async () => {
        if (!autoDraft) return;
        setBusy("__auto__"); setMsg("");
        try {
          const r = await api("/config", { auto: autoDraft });
          setAutoDraft(Object.assign({}, r.auto));
          setMsg("自动维护设置已保存" + (r.auto.enabled ? "（已启用）" : "（未启用）"));
          await load();
        } catch (e) { setMsg("保存失败: " + e.message); } finally { setBusy(""); }
      };

      const runMaintain = async () => {
        setBusy("__auto__"); setMsg("");
        try {
          const r = await api("/maintain", {});
          const parts = [];
          if (r.skipped) parts.push("跳过（" + r.skipped + "）");
          if (r.reason) parts.push(r.reason);
          if (r.archived && r.archived.length) parts.push("归档 " + r.archived.length + " 个");
          if (r.trashPurged && r.trashPurged.length) parts.push("清回收站 " + r.trashPurged.length + " 项");
          if (r.archivePurged && r.archivePurged.length) parts.push("清超龄归档 " + r.archivePurged.length + " 项");
          setMsg("自动维护执行完毕：" + (parts.length ? parts.join("；") : "无需处理"));
          await load();
        } catch (e) { setMsg("执行失败: " + e.message); } finally { setBusy(""); }
      };

      const stats = (data && data.stats) || null;
      const sessions = (data && data.sessions) || [];
      const archived = (data && data.archived) || [];
      const workspaces = (data && data.workspaces) || [];
      const list = tab === "current" ? sessions : archived;

      const head = h("div", { style: S.head, onMouseDown: startDrag, title: "按住可拖动面板" },
        h("strong", null, "会话仓库"),
        h("div", { style: { display: "flex", gap: "6px", alignItems: "center" }, onMouseDown: (e) => e.stopPropagation() },
          h("label", { style: { display: "flex", gap: "4px", alignItems: "center", fontSize: "11px", opacity: 0.8 } },
            h("input", { type: "checkbox", checked: force, onChange: (e) => setForce(e.target.checked) }), "强制"),
          h("button", { type: "button", style: S.btn, onClick: load }, "刷新"),
          h("button", { type: "button", style: S.btn, onClick: onClose }, "关闭")
        )
      );

      const statLine = stats ? h("div", { style: S.stat },
        h("span", null, "当前 " + stats.sessionCount + " 个 / " + fmt(stats.sessionBytes)),
        stats.subagentCount ? h("span", null, "其中子会话 " + stats.subagentCount + " 个") : null,
        h("span", null, "已归档 " + stats.archivedCount + " 个 / " + fmt(stats.archivedBytes)),
        h("span", null, "活跃阈值 " + stats.activeWindowMinutes + " 分钟")
      ) : h("div", { style: S.stat }, "加载中...");

      const tabs = h("div", { style: { display: "flex", gap: "6px", marginBottom: "8px" } },
        h("button", { type: "button", style: S.pill(tab === "current"), onClick: () => setTab("current") }, "当前会话 (" + sessions.length + ")"),
        h("button", { type: "button", style: S.pill(tab === "archived"), onClick: () => setTab("archived") }, "已归档 (" + archived.length + ")")
      );

      const rows = list.length === 0
        ? h("div", { style: { opacity: 0.6, padding: "8px 0" } }, tab === "current" ? "没有会话" : "归档区为空")
        : list.map((it) => {
            const id = it.sessionId;
            const disabled = busy === id;
            const wsOptions = workspaces.filter((w) => w.encoded !== it.workspace);
            const titleChildren = [h("span", { key: "t", style: S.titleText, title: label(it) }, label(it))];
            if (it.subagent) titleChildren.push(h("span", { key: "s", style: S.badgeSub, title: "dsh 子会话（subagent，不在侧栏显示）" + (it.subagentLabel ? "：" + it.subagentLabel : "") }, it.subagentLabel ? "子会话: " + String(it.subagentLabel).slice(0, 20) : "子会话"));
            if (tab === "archived" && it.auto) titleChildren.push(h("span", { key: "a", style: S.badgeAuto, title: "由自动维护归档" }, "自动"));
            const children = [
              h("div", { key: "i", style: S.grow },
                h("div", { style: S.titleRow }, titleChildren),
                h("div", { style: S.meta },
                  fmt(it.size)
                  + " · " + shortWs(it.workspace)
                  + (it.turns !== null && it.turns !== undefined ? " · " + it.turns + " 轮" : "")
                  + (it.active ? " · 活跃" : "")
                  + (tab === "archived" ? " · 归档于 " + relTime(it.archivedAt) : (it.lastWrite ? " · " + relTime(it.lastWrite) : ""))
                )
              )
            ];
            if (tab === "current") {
              children.push(h("button", { key: "a", type: "button", style: S.btn, disabled: disabled, onClick: () => act("archive", id, { force: force }), title: "移出 sessions 目录（可恢复）" }, "归档"));
              children.push(h("button", {
                key: "m", type: "button", style: S.btn, disabled: disabled,
                onClick: () => { setMoving(moving === id ? "" : id); setTarget(wsOptions.length > 0 ? wsOptions[0].encoded : ""); },
                title: "移动到其它工作区"
              }, "移动"));
              children.push(h("button", { key: "r", type: "button", style: S.btnDanger, disabled: disabled, onClick: () => act("trash", id, {}), title: "移入回收站" }, "回收站"));
            } else {
              children.push(h("button", { key: "b", type: "button", style: S.btn, disabled: disabled, onClick: () => act("restore", id, {}), title: "恢复回 ~/.dsh/sessions（带 sha256 校验）" }, "恢复"));
              children.push(h("button", { key: "c", type: "button", style: S.btnDanger, disabled: disabled, onClick: () => act("trash", id, {}), title: "移入回收站（可恢复）" }, "删除"));
            }
            const inner = [h("div", { key: "l", style: S.line }, children)];
            if (tab === "current" && moving === id) {
              inner.push(h("div", { key: "mv", style: S.moveRow },
                h("span", { style: { fontSize: "11px", opacity: 0.7 } }, "目标工作区:"),
                wsOptions.length === 0
                  ? h("span", { style: { fontSize: "11px", opacity: 0.7 } }, "（没有其它工作区）")
                  : h("select", { style: S.select, value: target, onChange: (e) => setTarget(e.target.value) },
                      wsOptions.map((w) => h("option", { key: w.encoded, value: w.encoded }, shortWs(w.encoded) + (w.cwd ? "  (" + w.cwd + ")" : "") + (w.virtual ? " [新建]" : "")))),
                wsOptions.length > 0 ? h("button", { type: "button", style: S.btn, disabled: disabled, onClick: () => act("move", id, { targetWorkspace: target }) }, "确定移动") : null,
                h("button", { type: "button", style: S.btn, onClick: () => setMoving("") }, "取消")
              ));
            }
            return h("div", { key: tab + ":" + id, style: S.row }, inner);
          });

      const hint = tab === "archived"
        ? "「恢复」按 sha256 校验后原样移回 ~/.dsh/sessions；恢复后刷新页面或重启 web 即可看到。"
        : "「归档」= 真正移出 sessions 目录（原子移动，可随时恢复），能减少 dsh 扫描与读写；活跃会话需勾选「强制」。带「子会话」标签的是 dsh subagent 内部会话（不在侧栏显示）。";

      const autoPanel = autoDraft ? h("div", { style: S.autoBox },
        h("div", { style: { display: "flex", alignItems: "center", gap: "8px", flexWrap: "wrap" } },
          h("button", { type: "button", style: S.btn, onClick: () => setShowAuto(!showAuto) }, showAuto ? "收起自动维护" : "自动维护设置"),
          autoDraft.enabled ? h("span", { style: S.badgeOn }, "已启用") : h("span", { style: S.badgeOff }, "未启用"),
          autoDraft.lastRunAt ? h("span", { style: { fontSize: "11px", opacity: 0.6 } }, "上次执行 " + relTime(autoDraft.lastRunAt)) : null
        ),
        showAuto ? h("div", null,
          h("label", { style: { display: "flex", alignItems: "center", gap: "6px", fontSize: "11px", marginTop: "8px" } },
            h("input", {
              type: "checkbox", checked: autoDraft.enabled === true,
              onChange: (e) => setAutoDraft(Object.assign({}, autoDraft, { enabled: e.target.checked }))
            }),
            "启用自动维护（会话库超过上限时自动归档闲置会话；到点清理回收站）"
          ),
          h("div", { style: S.autoGrid },
            NUM_FIELDS.map((f) => h("label", { key: f.key, style: S.field },
              h("span", { style: { opacity: 0.75 } }, f.label),
              h("input", {
                type: "number", min: f.min, style: S.input,
                value: autoDraft[f.key] === undefined || autoDraft[f.key] === null ? "" : autoDraft[f.key],
                onChange: (e) => {
                  const v = e.target.value === "" ? "" : Number(e.target.value);
                  setAutoDraft(Object.assign({}, autoDraft, { [f.key]: v }));
                }
              })
            ))
          ),
          h("div", { style: { display: "flex", gap: "6px", marginTop: "8px", flexWrap: "wrap" } },
            h("button", { type: "button", style: S.btnPrimary, disabled: busy === "__auto__", onClick: saveAuto }, "保存设置"),
            h("button", { type: "button", style: S.btn, disabled: busy === "__auto__", onClick: runMaintain }, "立即执行一次"),
            h("span", { style: { fontSize: "11px", opacity: 0.6, alignSelf: "center" } }, "归档保留填 0 = 永不自动删除归档")
          ),
          autoDraft.lastResult ? h("div", { style: S.hint },
            "上次结果：" + (autoDraft.lastResult.reason || "未超阈值") +
            "；归档 " + ((autoDraft.lastResult.archived || []).length) + " 个" +
            "；清回收站 " + ((autoDraft.lastResult.trashPurged || []).length) + " 项" +
            "；清归档 " + ((autoDraft.lastResult.archivePurged || []).length) + " 项"
          ) : null
        ) : null
      ) : null;

      const msgLine = msg ? h("div", { style: S.msg }, msg) : null;

      return h("div", {
        style: {
          position: "fixed", right: String(pos.right) + "px", bottom: String(pos.bottom) + "px",
          width: "600px", maxHeight: "80vh", overflowY: "auto", zIndex: 2147000000,
          background: "var(--dsw-bg-primary, #1f1f1f)", color: "var(--dsw-text-primary, #e8e8e8)",
          border: "1px solid rgba(128,128,128,0.35)", borderRadius: "10px",
          boxShadow: "0 10px 36px rgba(0,0,0,0.45)", padding: "12px", fontSize: "12px", lineHeight: 1.5
        }
      },
        head, statLine, tabs,
        h("div", null, rows),
        h("div", { style: S.hint }, hint),
        autoPanel,
        msgLine
      );
    }

    function FooterButton(props) {
      const [open, setOpen] = useState(false);
      return h("div", { style: S.wrap },
        h("button", { type: "button", style: S.trigger, title: "会话仓库：归档 / 恢复 / 移动 / 删除会话", onClick: () => setOpen(!open) },
          h("span", null, "会话仓库")),
        open ? h(Boundary, null, h(Panel, { onClose: () => setOpen(false) })) : null
      );
    }

    function apply(ctx) {
      ctx.slots.inject("sidebar.footer.action", () => ctx.slots.register({
        name: "sidebar.footer.action",
        id: "session-archiver-footer",
        order: 35,
        inject: () => ({})
      }, FooterButton));
    }

    exports.apply = apply;
    exports.inject = ["slots"];
    return module.exports;
  }
});
