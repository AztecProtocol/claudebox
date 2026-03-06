import { appShell } from "./app-shell.ts";

const AUDIT_STYLES = `
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0a0a0a;color:#ccc;font-family:'SF Mono',Monaco,'Cascadia Code',monospace;font-size:13px;line-height:1.5;height:100vh;display:flex;flex-direction:column}
a{color:inherit;text-decoration:none}a:hover{text-decoration:underline}
::-webkit-scrollbar{width:5px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:#333;border-radius:3px}

/* Header */
.header{padding:10px 16px;border-bottom:1px solid #1a1a1a;display:flex;align-items:center;gap:12px;flex-shrink:0;background:#0d0d0d;flex-wrap:wrap}
.header-title{font-weight:bold;color:#5FA7F1;font-size:15px}
.header-spacer{flex:1}
.header-item{display:flex;align-items:center;gap:6px;font-size:12px}
.capacity{color:#666;font-size:11px;padding:3px 8px;background:#111;border:1px solid #222;border-radius:3px}

/* Identity picker */
.identity-select{background:#111;color:#ccc;border:1px solid #333;border-radius:4px;padding:4px 8px;font-family:inherit;font-size:12px;cursor:pointer}
.identity-select:focus{outline:none;border-color:#5FA7F1}
.identity-label{color:#666;font-size:11px;text-transform:uppercase;letter-spacing:0.5px}

/* Buttons */
.btn{background:#151515;color:#ccc;border:1px solid #333;border-radius:4px;padding:5px 14px;font-family:inherit;font-size:12px;cursor:pointer;transition:all 0.15s}
.btn:hover{background:#222;color:#fff}
.btn:disabled{color:#444;border-color:#222;cursor:default;background:#0d0d0d}
.btn-green{border-color:#61D668;color:#61D668}.btn-green:hover{background:#0d1f0d}
.btn-blue{border-color:#5FA7F1;color:#5FA7F1}.btn-blue:hover{background:#0d0d1f}
.btn-red{border-color:#E94560;color:#E94560}.btn-red:hover{background:#1f0d0d}
.btn-sm{padding:3px 8px;font-size:11px}

/* Main content */
.main{flex:1;overflow-y:auto;padding:16px}

/* Tabs */
.tab-bar{display:flex;gap:0;border-bottom:1px solid #1a1a1a;margin-bottom:16px}
.tab{padding:8px 20px;font-size:12px;color:#666;cursor:pointer;border-bottom:2px solid transparent;transition:all 0.15s;user-select:none}
.tab:hover{color:#ccc}
.tab.active{color:#5FA7F1;border-bottom-color:#5FA7F1}

/* Section headers */
.section{margin-bottom:20px}
.section-header{font-size:11px;text-transform:uppercase;letter-spacing:1px;color:#555;padding:0 0 8px;border-bottom:1px solid #1a1a1a;margin-bottom:10px;display:flex;align-items:center;gap:8px;cursor:pointer;user-select:none}
.section-header .count{color:#444;font-weight:normal}
.section-header .toggle{color:#444;font-size:10px}
.section-header.running-header{color:#61D668}
.section-header.resolved-header{color:#888}

/* Card grid */
.card-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(320px,1fr));gap:10px}

/* Cards */
.card{background:#111;border:1px solid #222;border-radius:6px;padding:12px 14px;cursor:pointer;transition:border-color 0.15s;position:relative}
.card:hover{border-color:#444}
.card.running{border-left:3px solid #61D668}
.card.interactive{border-left:3px solid #FAD979}
.card.error{border-left:3px solid #E94560}
.card.resolved{opacity:0.6}
.card.deleted{opacity:0.4}
.card-top{display:flex;align-items:flex-start;gap:8px;margin-bottom:6px}
.card-name{font-size:13px;font-weight:bold;color:#ddd;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.card-status{display:flex;align-items:center;gap:4px;font-size:11px;flex-shrink:0}
.status-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0}
.status-dot.running{background:#61D668;animation:pulse 2s infinite}
.status-dot.interactive{background:#FAD979;animation:pulse 2s infinite}
.status-dot.completed{background:#61D668}
.status-dot.error{background:#E94560}
.status-dot.cancelled,.status-dot.interrupted,.status-dot.unknown{background:#666}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.3}}
.card-meta{display:flex;gap:12px;font-size:11px;color:#666;flex-wrap:wrap}
.card-meta span{white-space:nowrap}
.card-prompt{font-size:11px;color:#555;margin-top:6px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}
.card-badges{display:flex;gap:4px;margin-top:6px}
.badge{font-size:10px;padding:1px 6px;border-radius:3px;border:1px solid}
.badge-deleted{color:#888;border-color:#333;background:#1a1a1a}
.badge-resolved{color:#61D668;border-color:#1a331a;background:#0d1a0d}
.badge-channel{color:#FAD979;border-color:#333020;background:#1a1a0a}

/* Questions panel */
.q-panel{margin-bottom:16px}
.q-panel .section-header{cursor:pointer;user-select:none}
.q-card{background:#1a1a1a;border:1px solid #333;border-radius:6px;padding:12px;margin-bottom:12px}
.q-card.pending{border-color:#d876e3}
.q-card.answered{border-color:#61D668;opacity:0.7}
.q-card.expired{border-color:#E94560;opacity:0.5}
.q-desc{font-weight:bold;color:#e0e0e0;margin-bottom:2px}
.q-text{font-size:13px;color:#ccc;margin-bottom:6px}
.q-meta{font-size:11px;color:#888;margin-bottom:8px}
.q-meta a{color:#7aa2f7}
.q-context{font-size:12px;color:#999;margin-bottom:8px;padding:6px 8px;background:#111;border-radius:4px;border-left:3px solid #555}
.q-body-detail{font-size:12px;color:#aaa;white-space:pre-wrap;margin-bottom:8px;max-height:150px;overflow-y:auto;padding:6px 8px;background:#0d0d0d;border-radius:4px}
.q-urgency{display:inline-block;font-size:10px;padding:2px 8px;border-radius:10px;font-weight:600;margin-right:6px}
.q-urgency.critical{background:rgba(233,69,96,0.2);color:#E94560;border:1px solid rgba(233,69,96,0.3)}
.q-urgency.important{background:rgba(250,217,121,0.15);color:#FAD979;border:1px solid rgba(250,217,121,0.25)}
.q-urgency.nice-to-have{background:rgba(136,136,136,0.15);color:#aaa;border:1px solid rgba(136,136,136,0.25)}
.q-countdown{font-size:11px;font-family:'SF Mono',monospace;color:#888;font-variant-numeric:tabular-nums}
.q-countdown.urgent{color:#E94560}
.q-countdown.expired{color:#666}
.q-options{display:flex;flex-direction:column;gap:4px;margin-bottom:8px}
.q-option{display:flex;align-items:flex-start;gap:8px;padding:6px 10px;background:#111;border:1px solid #333;border-radius:4px;cursor:pointer;transition:all 0.15s}
.q-option:hover{border-color:#7aa2f7;background:#0d1a2e}
.q-option.selected{border-color:#d876e3;background:rgba(216,118,227,0.08)}
.q-option input[type="radio"]{margin-top:3px;accent-color:#d876e3}
.q-option-label{font-size:12px;font-weight:600;color:#ddd}
.q-option-desc{font-size:11px;color:#999}
.q-freeform{background:#111;border:1px solid #444;border-radius:4px;color:#ccc;font-family:monospace;font-size:12px;padding:8px;min-height:50px;resize:vertical;width:100%;box-sizing:border-box}
.q-freeform:focus{border-color:#7aa2f7;outline:none}
.q-answer-btn{background:#d876e3;color:#000;border:none;padding:6px 14px;border-radius:4px;cursor:pointer;font-size:12px;font-weight:bold}
.q-answer-btn:hover{background:#e99cf0}
.q-answer-btn:disabled{opacity:0.5;cursor:default}
.q-answer-ok{color:#61D668;font-size:12px;padding:4px 0}
.q-direction{margin-top:12px;padding:12px;background:#111;border:1px solid #333;border-radius:6px}
.q-direction label{font-size:11px;color:#888;display:block;margin-bottom:4px}
.q-direction textarea{background:#0d0d0d;border:1px solid #444;border-radius:4px;color:#ccc;font-family:monospace;font-size:12px;padding:8px;min-height:60px;resize:vertical;width:100%;box-sizing:border-box}
.q-direction textarea:focus{border-color:#7aa2f7;outline:none}
.q-direction button{margin-top:6px}

/* Findings summary */
.findings-bar{display:flex;gap:12px;margin-bottom:16px;flex-wrap:wrap}
.finding-stat{background:#1a1a1a;border:1px solid #333;border-radius:6px;padding:8px 14px;font-size:12px}
.finding-stat .count{font-size:18px;font-weight:bold;margin-right:4px}
.finding-stat.open .count{color:#E94560}
.finding-stat.closed .count{color:#61D668}

/* Coverage panel */
.cov-bar{display:flex;gap:12px;margin-bottom:12px;flex-wrap:wrap}
.cov-stat{background:#1a1a1a;border:1px solid #333;border-radius:6px;padding:8px 14px;font-size:12px}
.cov-stat .count{font-size:18px;font-weight:bold;margin-right:4px;color:#7aa2f7}
.cov-modules{display:grid;grid-template-columns:repeat(auto-fill,minmax(280px,1fr));gap:10px;margin-bottom:12px}
.cov-mod{background:#1a1a1a;border:1px solid #333;border-radius:6px;padding:10px 14px;cursor:pointer;transition:border-color 0.15s}
.cov-mod:hover{border-color:#7aa2f7}
.cov-mod-name{font-weight:600;color:#e0e0e0;margin-bottom:4px}
.cov-mod-meta{font-size:11px;color:#888;display:flex;gap:12px}
.cov-mod-meta .issues{color:#E94560}
.cov-depth{display:inline-block;font-size:10px;padding:1px 6px;border-radius:8px;margin-right:4px}
.cov-depth.deep{background:rgba(97,214,104,0.15);color:#61D668;border:1px solid rgba(97,214,104,0.25)}
.cov-depth.line-by-line{background:rgba(122,162,247,0.15);color:#7aa2f7;border:1px solid rgba(122,162,247,0.25)}
.cov-depth.cursory{background:rgba(136,136,136,0.15);color:#aaa;border:1px solid rgba(136,136,136,0.25)}
.cov-files{display:none;margin-top:8px;border-top:1px solid #333;padding-top:8px}
.cov-files.open{display:block}
.cov-file{font-size:11px;color:#999;padding:3px 0;display:flex;gap:8px;align-items:center}
.cov-file-path{color:#ccc;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.cov-file-notes{font-size:10px;color:#666;padding-left:16px}

/* Findings list */
.findings-list{margin-top:8px}
.finding-row{display:flex;align-items:center;gap:8px;padding:6px 10px;border-radius:4px;color:#ccc;text-decoration:none;transition:background 0.15s}
.finding-row:hover{background:#1a1a1a;text-decoration:none}
.finding-row.closed{opacity:0.5}
.finding-number{color:#888;font-size:11px;flex-shrink:0;min-width:32px}
.finding-title{flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;font-size:12px}
.finding-label{font-size:10px;padding:1px 6px;border-radius:8px;border:1px solid #333;color:#aaa;flex-shrink:0}

/* Coverage summaries */
.cov-summaries{margin-top:12px}
.cov-summary{background:#1a1a1a;border:1px solid #333;border-radius:6px;padding:10px 14px;margin-bottom:8px}
.cov-summary-text{font-size:12px;color:#ccc;margin-bottom:4px}
.cov-summary-meta{font-size:11px;color:#888;display:flex;gap:12px}

/* New session modal */
.modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.8);z-index:100;display:none;align-items:center;justify-content:center}
.modal-overlay.visible{display:flex}
.modal{background:#111;border:1px solid #333;border-radius:8px;padding:24px;width:420px;max-width:90vw;display:flex;flex-direction:column;gap:14px}
.modal-title{color:#5FA7F1;font-weight:bold;font-size:14px}
.form-row{display:flex;flex-direction:column;gap:4px}
.form-label{font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:#666}
.form-input{background:#0a0a0a;border:1px solid #333;border-radius:4px;padding:8px 12px;color:#ccc;font-family:inherit;font-size:13px;resize:none}
.form-input:focus{outline:none;border-color:#5FA7F1}
.form-input.textarea{height:100px}
.form-select{background:#0a0a0a;border:1px solid #333;border-radius:4px;padding:8px 12px;color:#ccc;font-family:inherit;font-size:13px}
.form-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:4px}
.form-error{color:#E94560;font-size:11px;display:none}

/* Empty state */
.empty{text-align:center;color:#444;padding:40px 20px;font-size:13px}

/* Responsive */
@media(max-width:480px){.card-grid{grid-template-columns:1fr}.header{gap:8px}.cov-modules{grid-template-columns:1fr}}
`;

const AUDIT_MODULE_SCRIPT = `
const {h,render,useState,useEffect,useCallback,useRef,useMemo,html,AuthApp,authFetch} = window.__preact;

// ── Helpers ──────────────────────────────────────────────────

function timeAgo(iso) {
  if (!iso) return "\\u2014";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60000) return "just now";
  if (ms < 3600000) return Math.floor(ms / 60000) + "m ago";
  if (ms < 86400000) return Math.floor(ms / 3600000) + "h ago";
  return Math.floor(ms / 86400000) + "d ago";
}

function esc(s) {
  return (s || "").replace(/&/g, "&amp;").replace(/</g, "&lt;").replace(/>/g, "&gt;");
}

function formatCountdown(deadline) {
  const ms = new Date(deadline).getTime() - Date.now();
  if (ms <= 0) return { text: "EXPIRED", cls: "expired" };
  const mins = Math.floor(ms / 60000);
  const hrs = Math.floor(mins / 60);
  const remMins = mins % 60;
  if (hrs > 0) return { text: hrs + "h " + remMins + "m", cls: hrs < 1 ? "urgent" : "" };
  return { text: remMins + "m", cls: remMins < 10 ? "urgent" : "" };
}

function getIdentity() { return localStorage.getItem("cb_identity") || ""; }
function setIdentity(v) { localStorage.setItem("cb_identity", v); }

const DIM_COLORS = { code: "#7aa2f7", crypto: "#d876e3", test: "#61D668", "crypto-2nd-pass": "#FAD979" };
const DIM_LABELS = { code: "Code", crypto: "Crypto", test: "Test", "crypto-2nd-pass": "Crypto 2nd" };
const DIM_KEYS = ["code", "crypto", "test", "crypto-2nd-pass"];

// ── Components ───────────────────────────────────────────────

function Header({ capacity, newDisabled, identity, users, onIdentityChange, onNewClick }) {
  return html\`
    <div class="header">
      <span class="header-title">CLAUDEBOX AUDIT</span>
      <span class="header-spacer"></span>
      <a href="/dashboard" style="color:#888;margin-right:12px">\\u2190 Main Dashboard</a>
      <div class="header-item">
        <span class="identity-label">as</span>
        <select class="identity-select" value=\${identity} onChange=\${e => onIdentityChange(e.target.value)}>
          \${(users || []).map(u => html\`<option value=\${u}>\${u}</option>\`)}
        </select>
      </div>
      <span class="capacity">\${capacity}</span>
      <button class="btn btn-green" disabled=\${newDisabled} onClick=\${onNewClick}>+ New Audit</button>
    </div>
  \`;
}

function TabBar({ activeTab, onTabChange }) {
  const tabs = [
    { key: "coverage", label: "Coverage" },
    { key: "sessions", label: "Sessions" },
    { key: "findings", label: "Findings" },
  ];
  return html\`
    <div class="tab-bar">
      \${tabs.map(t => html\`
        <div class=\${"tab" + (activeTab === t.key ? " active" : "")} onClick=\${() => onTabChange(t.key)}>\${t.label}</div>
      \`)}
    </div>
  \`;
}

// ── Dimension Progress Bars ──────────────────────────────────

function DimensionBar({ dim, reviewed, total }) {
  const pct = total ? Math.round(reviewed / total * 100) : 0;
  const color = DIM_COLORS[dim] || "#888";
  const label = DIM_LABELS[dim] || dim;
  return html\`
    <div style="display:flex;align-items:center;gap:6px">
      <span style="font-size:9px;color:\${color};width:52px;text-align:right">\${label}</span>
      <div style="flex:1;background:#0d0d0d;border-radius:2px;height:3px;overflow:hidden">
        \${reviewed > 0 && html\`<div style="height:100%;width:\${pct}%;min-width:2px;background:\${color};border-radius:2px"></div>\`}
      </div>
      <span style="font-size:9px;color:#555;width:24px">\${reviewed}</span>
    </div>
  \`;
}

function DimensionTotals({ dimTotals }) {
  return html\`
    <div class="cov-bar">
      \${DIM_KEYS.map(dim => {
        const dt = dimTotals[dim] || { files: 0, issues: 0 };
        return html\`<div class="cov-stat"><span class="count" style="color:\${DIM_COLORS[dim]}">\${dt.files}</span>\${DIM_LABELS[dim]}</div>\`;
      })}
    </div>
  \`;
}

// ── Module Card ──────────────────────────────────────────────

function ModuleCard({ modName, mod, isOpen, onToggle }) {
  const modPct = mod.total_files ? Math.round(mod.files_reviewed / mod.total_files * 100) : 0;
  const borderColor = mod.files_reviewed === 0 ? "#333" : modPct >= 80 ? "#61D668" : modPct >= 30 ? "#7aa2f7" : "#FAD979";
  const dims = mod.dimensions || {};

  const handleClick = useCallback((e) => {
    if (e.target.closest && e.target.closest(".cov-files")) return;
    onToggle();
  }, [onToggle]);

  return html\`
    <div class="cov-mod" style="border-color:\${borderColor}" onClick=\${handleClick}>
      <div style="display:flex;justify-content:space-between;align-items:center">
        <div class="cov-mod-name">\${modName}</div>
        <span style="font-size:11px;color:\${mod.files_reviewed > 0 ? borderColor : '#555'}">\${mod.files_reviewed}/\${mod.total_files}</span>
      </div>

      <div style="display:flex;flex-direction:column;gap:2px;margin:6px 0">
        \${DIM_KEYS.map(dim => {
          const d = dims[dim] || { files_reviewed: 0 };
          return html\`<\${DimensionBar} dim=\${dim} reviewed=\${d.files_reviewed} total=\${mod.total_files} />\`;
        })}
      </div>

      <div class="cov-mod-meta">
        \${mod.issues_found ? html\`<span class="issues">\${mod.issues_found} issues</span>\` : null}
      </div>

      \${mod.files && mod.files.length ? html\`
        <div class=\${"cov-files" + (isOpen ? " open" : "")}>
          \${mod.files.map(f => html\`
            <div>
              <div class="cov-file">
                <span class=\${"cov-depth " + f.review_depth}>\${f.review_depth}</span>
                <span class="cov-file-path" title=\${f.file_path}>\${f.file_path.replace(/^barretenberg\\/cpp\\/src\\/barretenberg\\//, "")}</span>
                \${f.issues_found ? html\`<span style="color:#E94560;font-size:10px">\${f.issues_found} issue\${f.issues_found > 1 ? "s" : ""}</span>\` : null}
              </div>
              \${f.notes ? html\`<div class="cov-file-notes">\${f.notes}</div>\` : null}
            </div>
          \`)}
        </div>
      \` : null}
    </div>
  \`;
}

// ── Coverage Panel ───────────────────────────────────────────

function CoveragePanel({ coverage }) {
  const [openMods, setOpenMods] = useState({});

  if (!coverage) return html\`<div class="empty">Loading coverage data...</div>\`;

  const mods = coverage.modules || {};
  const dimTotals = coverage.dimension_totals || {};
  const modNames = Object.keys(mods).sort();
  const totalReviewed = coverage.total_reviewed || 0;
  const totalRepo = coverage.total_repo_files || 0;
  const pct = totalRepo ? Math.round(totalReviewed / totalRepo * 100) : 0;
  let totalIssues = 0;
  modNames.forEach(m => { totalIssues += mods[m].issues_found || 0; });

  const activeModNames = modNames.filter(m => mods[m].total_files > 0 || mods[m].files_reviewed > 0);

  // Sort: reviewed first, then by coverage %, then by total files
  activeModNames.sort((a, b) => {
    const aR = mods[a].files_reviewed, bR = mods[b].files_reviewed;
    if (aR > 0 && bR === 0) return -1;
    if (bR > 0 && aR === 0) return 1;
    if (aR > 0 && bR > 0) return (bR / mods[b].total_files) - (aR / mods[a].total_files);
    return mods[b].total_files - mods[a].total_files;
  });

  const toggleMod = useCallback((modName) => {
    setOpenMods(prev => {
      const next = { ...prev };
      if (next[modName]) delete next[modName]; else next[modName] = true;
      return next;
    });
  }, []);

  return html\`
    <div class="section">
      <div class="section-header">Audit Coverage <span class="count">\${totalReviewed}/\${totalRepo} files (\${pct}%)</span></div>

      <\${DimensionTotals} dimTotals=\${dimTotals} />

      <div class="cov-bar">
        <div class="cov-stat"><span class="count">\${totalRepo}</span>total files</div>
        <div class="cov-stat"><span class="count" style="color:#E94560">\${totalIssues}</span>issues</div>
      </div>

      <div class="cov-modules">
        \${activeModNames.map(modName => html\`
          <\${ModuleCard}
            key=\${modName}
            modName=\${modName}
            mod=\${mods[modName]}
            isOpen=\${!!openMods[modName]}
            onToggle=\${() => toggleMod(modName)}
          />
        \`)}
      </div>

      \${coverage.summaries && coverage.summaries.length ? html\`
        <div class="cov-summaries">
          <div style="font-size:11px;color:#666;margin-bottom:6px">Session Summaries</div>
          \${coverage.summaries.map(s => html\`
            <div class="cov-summary">
              <div class="cov-summary-text">\${s.summary || ""}</div>
              <div class="cov-summary-meta">
                \${s.gist_url ? html\`<a href=\${s.gist_url} target="_blank" class="link" style="color:#7aa2f7">gist</a>\` : null}
                <span>\${s.files_reviewed} files</span>
                <span>\${s.issues_filed} issues</span>
                \${s.ts ? html\`<span>\${timeAgo(s.ts)}</span>\` : null}
              </div>
            </div>
          \`)}
        </div>
      \` : null}
    </div>
  \`;
}

// ── Session Card ─────────────────────────────────────────────

function SessionCard({ w }) {
  let cls = "card";
  if (w.status === "running" || w.status === "interactive") cls += " " + w.status;
  if (w.status === "error") cls += " error";
  if (!w.alive) cls += " deleted";

  let displayName = w.name || w.prompt || "Unnamed audit";
  if (displayName.length > 80) displayName = displayName.slice(0, 80) + "\\u2026";
  const exitStr = w.exitCode != null ? " (" + w.exitCode + ")" : "";

  return html\`
    <div class=\${cls} onClick=\${() => { location.href = "/s/" + w.worktreeId; }}>
      <div class="card-top">
        <div class="card-name">\${displayName}</div>
        <div class="card-status">
          <span class=\${"status-dot " + w.status}></span>
          <span>\${w.status}\${exitStr}</span>
        </div>
      </div>
      <div class="card-meta">
        <span>\${w.user}</span>
        <span>\${w.runCount} run\${w.runCount !== 1 ? "s" : ""}</span>
        <span>\${w.started ? timeAgo(w.started) : "\\u2014"}</span>
      </div>
      <div class="card-badges">
        \${!w.alive ? html\`<span class="badge badge-deleted">deleted</span>\` : null}
        \${w.channelName ? html\`<span class="badge badge-channel">#\${w.channelName}</span>\` : null}
      </div>
    </div>
  \`;
}

// ── Sessions Panel ───────────────────────────────────────────

function SessionsPanel({ workspaces }) {
  const running = useMemo(() => (workspaces || []).filter(w => w.status === "running" || w.status === "interactive"), [workspaces]);
  const recent = useMemo(() => (workspaces || []).filter(w => w.status !== "running" && w.status !== "interactive"), [workspaces]);

  return html\`
    <div>
      \${running.length ? html\`
        <div class="section">
          <div class="section-header running-header">Running <span class="count">(\${running.length})</span></div>
          <div class="card-grid">\${running.map(w => html\`<\${SessionCard} key=\${w.worktreeId} w=\${w} />\`)}</div>
        </div>
      \` : null}
      <div class="section">
        <div class="section-header">Audit Sessions <span class="count">(\${recent.length})</span></div>
        \${recent.length
          ? html\`<div class="card-grid">\${recent.map(w => html\`<\${SessionCard} key=\${w.worktreeId} w=\${w} />\`)}</div>\`
          : html\`<div class="empty">No audit sessions yet</div>\`
        }
      </div>
    </div>
  \`;
}

// ── Finding Card ─────────────────────────────────────────────

function FindingCard({ issue, isClosed }) {
  const labels = (issue.labels || []).filter(l => l.name !== "audit-finding").map(l =>
    html\`<span class="finding-label" style="border-color:#\${l.color || '333'}">\${l.name}</span>\`
  );
  return html\`
    <a href=\${issue.html_url} target="_blank" class=\${"finding-row" + (isClosed ? " closed" : " open")}>
      <span class="finding-number">#\${issue.number}</span>
      <span class="finding-title">\${issue.title}</span>
      \${labels}
    </a>
  \`;
}

// ── Findings Panel ───────────────────────────────────────────

function FindingsPanel({ findings }) {
  const [expanded, setExpanded] = useState(true);

  if (!findings || !findings.length) return null;

  const openIssues = findings.filter(i => i.state === "open");
  const closedIssues = findings.filter(i => i.state !== "open");
  const areas = {};
  findings.forEach(i => {
    (i.labels || []).forEach(l => {
      if (l.name.startsWith("area/")) {
        areas[l.name] = (areas[l.name] || 0) + 1;
      }
    });
  });

  return html\`
    <div class="section">
      <div class="section-header" onClick=\${() => setExpanded(v => !v)}>
        Findings <span class="count">(\${findings.length})</span>
        <span class="toggle">\${expanded ? "\\u25BC" : "\\u25B6"}</span>
      </div>
      <div class="findings-bar">
        <div class="finding-stat open"><span class="count">\${openIssues.length}</span>open</div>
        <div class="finding-stat closed"><span class="count">\${closedIssues.length}</span>closed</div>
        \${Object.keys(areas).sort().map(a => html\`
          <div class="finding-stat"><span class="count">\${areas[a]}</span>\${a}</div>
        \`)}
      </div>
      \${expanded ? html\`
        <div class="findings-list">
          \${openIssues.length ? html\`
            <div style="font-size:11px;color:#888;margin:8px 0 4px;text-transform:uppercase;letter-spacing:0.5px">Open</div>
            \${openIssues.map(i => html\`<\${FindingCard} key=\${i.number} issue=\${i} isClosed=\${false} />\`)}
          \` : null}
          \${closedIssues.length ? html\`
            <div style="font-size:11px;color:#888;margin:8px 0 4px;text-transform:uppercase;letter-spacing:0.5px">Closed</div>
            \${closedIssues.map(i => html\`<\${FindingCard} key=\${i.number} issue=\${i} isClosed=\${true} />\`)}
          \` : null}
        </div>
      \` : null}
    </div>
  \`;
}

// ── Question Option ──────────────────────────────────────────

function QuestionOption({ qId, idx, label, description, isSelected, onSelect }) {
  return html\`
    <label class=\${"q-option" + (isSelected ? " selected" : "")} onClick=\${() => onSelect(idx, label)}>
      <input type="radio" name=\${"q-radio-" + qId} checked=\${isSelected} readOnly />
      <div>
        <div class="q-option-label">\${label}</div>
        <div class="q-option-desc">\${description}</div>
      </div>
    </label>
  \`;
}

// ── Question Card ────────────────────────────────────────────

function QuestionCard({ q }) {
  const [selected, setSelected] = useState(null);
  const [freeform, setFreeform] = useState("");
  const [status, setStatus] = useState(null); // null | "submitting" | "done" | "error"
  const [statusMsg, setStatusMsg] = useState("");
  const [countdown, setCountdown] = useState(formatCountdown(q.deadline));

  useEffect(() => {
    const timer = setInterval(() => { setCountdown(formatCountdown(q.deadline)); }, 1000);
    return () => clearInterval(timer);
  }, [q.deadline]);

  const handleSelect = useCallback((idx, label) => {
    setSelected({ idx, label });
  }, []);

  const handleAnswer = useCallback(async () => {
    if (!selected) { alert("Please select an option"); return; }
    if (selected.label === "Other" && !freeform.trim()) { alert("Please provide your answer in the text field"); return; }

    setStatus("submitting");
    try {
      const r = await authFetch("/api/audit/questions/" + encodeURIComponent(q.id) + "/answer", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ selected_option: selected.label, freeform_answer: freeform, answered_by: getIdentity() })
      });
      if (r.status === 401) { alert("Authentication required. Please log in again."); setStatus(null); return; }
      const d = await r.json();
      if (d.ok) {
        let msg = "Answered";
        if (d.all_resolved) msg += d.resumed ? " \\u2014 session resuming automatically" : " \\u2014 all questions resolved";
        setStatusMsg(msg);
        setStatus("done");
      } else {
        alert("Error: " + (d.error || d.message || "unknown"));
        setStatus(null);
      }
    } catch (e) {
      alert("Error: " + e.message);
      setStatus(null);
    }
  }, [q.id, selected, freeform]);

  return html\`
    <div class="q-card pending">
      <div style="display:flex;justify-content:space-between;align-items:center;margin-bottom:6px">
        <div>
          <span class=\${"q-urgency " + q.urgency}>\${q.urgency}</span>
          <span class=\${"q-countdown " + countdown.cls}>\${countdown.text}</span>
        </div>
      </div>
      <div class="q-desc">\${q.description}</div>
      <div class="q-text">\${q.text}</div>
      <div class="q-context">\${q.context}</div>

      \${q.body ? html\`
        <details style="margin-bottom:8px">
          <summary style="font-size:11px;color:#666;cursor:pointer">Reasoning & references</summary>
          <div class="q-body-detail">\${q.body}</div>
        </details>
      \` : null}

      <div class="q-options">
        \${(q.options || []).map((opt, idx) => html\`
          <\${QuestionOption}
            qId=\${q.id} idx=\${idx} label=\${opt.label} description=\${opt.description}
            isSelected=\${selected && selected.idx === idx}
            onSelect=\${handleSelect}
          />
        \`)}
        <\${QuestionOption}
          qId=\${q.id} idx="other" label="Other" description="Provide your own answer below"
          isSelected=\${selected && selected.idx === "other"}
          onSelect=\${handleSelect}
        />
      </div>

      <textarea class="q-freeform" placeholder="Add details, references, or your own answer..."
        value=\${freeform} onInput=\${e => setFreeform(e.target.value)} />

      <div style="display:flex;gap:8px;align-items:center;justify-content:flex-end;margin-top:6px">
        \${status === "done" ? html\`<span class="q-answer-ok">\${statusMsg}</span>\` : null}
        <button class="q-answer-btn"
          disabled=\${status === "submitting" || status === "done"}
          onClick=\${handleAnswer}>
          \${status === "submitting" ? "Submitting..." : status === "done" ? "Done" : "Answer"}
        </button>
      </div>
    </div>
  \`;
}

// ── Direction Input ──────────────────────────────────────────

function DirectionInput({ wtId }) {
  const [text, setText] = useState("");
  const [status, setStatus] = useState(null);

  const handleSave = useCallback(async () => {
    if (!text.trim()) return;
    setStatus("saving");
    try {
      const r = await authFetch("/api/audit/questions/direction", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ worktree_id: wtId, text: text.trim(), author: getIdentity() })
      });
      if (r.status === 401) { alert("Authentication required."); setStatus(null); return; }
      const d = await r.json();
      if (d.ok) {
        setStatus("saved");
        setTimeout(() => setStatus(null), 2000);
      } else {
        alert("Error: " + (d.error || "unknown"));
        setStatus(null);
      }
    } catch (e) {
      alert("Error: " + e.message);
      setStatus(null);
    }
  }, [wtId, text]);

  return html\`
    <div class="q-direction">
      <label>Further direction for this session (freeform \\u2014 reference implementation plans, reasoning, etc.)</label>
      <textarea value=\${text} onInput=\${e => setText(e.target.value)}
        style=\${status === "saved" ? "border-color:#61D668" : ""}
        placeholder="e.g., Focus on the CRT carry proof next. See Phase 2 of the strategy..." />
      <button class="q-answer-btn" style="background:#5FA7F1" disabled=\${status === "saving"}
        onClick=\${handleSave}>
        \${status === "saving" ? "Saving..." : status === "saved" ? "Saved" : "Save Direction"}
      </button>
    </div>
  \`;
}

// ── Questions Panel ──────────────────────────────────────────

function QuestionsPanel({ questions }) {
  if (!questions || !questions.length) return null;

  // Group by worktree
  const groups = useMemo(() => {
    const g = {};
    questions.forEach(q => {
      if (!g[q.worktree_id]) g[q.worktree_id] = [];
      g[q.worktree_id].push(q);
    });
    return g;
  }, [questions]);

  return html\`
    <div class="q-panel">
      <div class="section">
        <div class="section-header" style="color:#d876e3">
          Pending Questions <span class="count">(\${questions.length})</span>
        </div>
        \${Object.keys(groups).map(wtId => html\`
          <div style="margin-bottom:16px" key=\${wtId}>
            <div style="font-size:11px;color:#666;margin-bottom:6px">
              Session <a href=\${"/s/" + wtId} class="link" style="color:#7aa2f7">\${wtId.slice(0, 8)}</a>
            </div>
            \${groups[wtId].map(q => html\`<\${QuestionCard} key=\${q.id} q=\${q} />\`)}
            <\${DirectionInput} wtId=\${wtId} />
          </div>
        \`)}
      </div>
    </div>
  \`;
}

// ── New Audit Modal ──────────────────────────────────────────

function NewAuditModal({ visible, identity, onClose }) {
  const [prompt, setPrompt] = useState("");
  const [name, setName] = useState("");
  const [branch, setBranch] = useState("main");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const promptRef = useRef(null);

  useEffect(() => {
    if (visible && promptRef.current) promptRef.current.focus();
  }, [visible]);

  useEffect(() => {
    const handler = (e) => { if (e.key === "Escape" && visible) onClose(); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [visible, onClose]);

  const handleSubmit = useCallback(async (e) => {
    e.preventDefault();
    if (!prompt.trim()) return;
    setSubmitting(true);
    setError("");
    try {
      const r = await authFetch("/api/sessions", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          prompt: prompt.trim(),
          name: name.trim() || undefined,
          base_branch: branch,
          user: identity || undefined,
          profile: "barretenberg-audit"
        })
      });
      const d = await r.json();
      if (d.ok && d.worktree_id) {
        onClose();
        location.href = "/s/" + d.worktree_id;
      } else {
        setError(d.message || d.error || "Failed to start session");
        setSubmitting(false);
      }
    } catch (err) {
      setError("Connection error: " + err.message);
      setSubmitting(false);
    }
  }, [prompt, name, branch, identity, onClose]);

  if (!visible) return null;

  return html\`
    <div class="modal-overlay visible" onClick=\${e => { if (e.target === e.currentTarget) onClose(); }}>
      <form class="modal" onSubmit=\${handleSubmit}>
        <div class="modal-title">New Audit Session</div>
        <div class="form-row">
          <label class="form-label">What should be audited?</label>
          <textarea ref=\${promptRef} class="form-input textarea"
            placeholder="e.g., Review the polynomial commitment code for memory safety issues..."
            value=\${prompt} onInput=\${e => setPrompt(e.target.value)} required />
        </div>
        <div class="form-row">
          <label class="form-label">Task name (optional)</label>
          <input class="form-input" type="text" placeholder="e.g., Audit polynomial commitments"
            value=\${name} onInput=\${e => setName(e.target.value)} />
        </div>
        <div class="form-row">
          <label class="form-label">Target ref</label>
          <input class="form-input" type="text" placeholder="main"
            value=\${branch} onInput=\${e => setBranch(e.target.value)} />
        </div>
        <div class="form-row">
          <label class="form-label">As</label>
          <span style="color:#ccc">\${identity || "(select identity above)"}</span>
        </div>
        \${error ? html\`<div class="form-error" style="display:block">\${error}</div>\` : null}
        <div class="form-actions">
          <button type="button" class="btn" onClick=\${onClose}>Cancel</button>
          <button type="submit" class="btn btn-green" disabled=\${submitting}>
            \${submitting ? "Starting..." : "Start Audit"}
          </button>
        </div>
      </form>
    </div>
  \`;
}

// ── Main App ─────────────────────────────────────────────────

function AuditDashboard() {
  const [workspaces, setWorkspaces] = useState([]);
  const [capacity, setCapacity] = useState("");
  const [maxConcurrent, setMaxConcurrent] = useState(Infinity);
  const [activeCount, setActiveCount] = useState(0);
  const [identity, setIdentityState] = useState(getIdentity());
  const [users, setUsers] = useState([]);
  const [activeTab, setActiveTab] = useState("coverage");
  const [showModal, setShowModal] = useState(false);
  const [questions, setQuestions] = useState([]);
  const [findings, setFindings] = useState([]);
  const [coverage, setCoverage] = useState(null);

  const handleIdentityChange = useCallback((v) => {
    setIdentityState(v);
    setIdentity(v);
  }, []);

  // Load users
  const loadUsers = useCallback(async () => {
    try {
      const r = await authFetch("/api/users");
      const d = await r.json();
      const userList = d.users || [];
      setUsers(userList);
      const stored = getIdentity();
      if (!stored && userList.length) {
        setIdentityState(userList[0]);
        setIdentity(userList[0]);
      }
    } catch {}
  }, []);

  // Load dashboard
  const loadDashboard = useCallback(async () => {
    try {
      const r = await authFetch("/api/dashboard?profile=barretenberg-audit");
      const d = await r.json();
      setWorkspaces(d.workspaces || []);
      setCapacity(d.activeCount + "/" + d.maxConcurrent + " active");
      setMaxConcurrent(d.maxConcurrent);
      setActiveCount(d.activeCount);
    } catch {}
  }, []);

  // Load questions
  const loadQuestions = useCallback(async () => {
    try {
      const r = await authFetch("/api/audit/questions?status=pending");
      const data = await r.json();
      setQuestions(Array.isArray(data) ? data : []);
    } catch {}
  }, []);

  // Load findings
  const loadFindings = useCallback(async () => {
    try {
      const r = await authFetch("/api/audit/findings?state=all");
      const data = await r.json();
      setFindings(Array.isArray(data) ? data : []);
    } catch {}
  }, []);

  // Load coverage
  const loadCoverage = useCallback(async () => {
    try {
      const r = await authFetch("/api/audit/coverage");
      const data = await r.json();
      setCoverage(data || null);
    } catch {}
  }, []);

  // Initial load
  useEffect(() => {
    loadUsers();
    loadDashboard();
    loadQuestions();
    loadFindings();
    loadCoverage();
  }, []);

  // Auto-refresh: dashboard, findings, coverage every 10s
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      if (showModal) return;
      loadDashboard();
      loadFindings();
      loadCoverage();
    }, 10000);
    return () => clearInterval(timer);
  }, [showModal, loadDashboard, loadFindings, loadCoverage]);

  // Auto-refresh: questions every 5s
  useEffect(() => {
    const timer = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      loadQuestions();
    }, 5000);
    return () => clearInterval(timer);
  }, [loadQuestions]);

  return html\`
    <\${Header}
      capacity=\${capacity}
      newDisabled=\${activeCount >= maxConcurrent}
      identity=\${identity}
      users=\${users}
      onIdentityChange=\${handleIdentityChange}
      onNewClick=\${() => setShowModal(true)}
    />

    <div class="main">
      <\${QuestionsPanel} questions=\${questions} />

      <\${TabBar} activeTab=\${activeTab} onTabChange=\${setActiveTab} />

      \${activeTab === "coverage" ? html\`<\${CoveragePanel} coverage=\${coverage} />\` : null}
      \${activeTab === "sessions" ? html\`<\${SessionsPanel} workspaces=\${workspaces} />\` : null}
      \${activeTab === "findings" ? html\`<\${FindingsPanel} findings=\${findings} />\` : null}
    </div>

    <\${NewAuditModal}
      visible=\${showModal}
      identity=\${identity}
      onClose=\${() => setShowModal(false)}
    />
  \`;
}

// ── Mount ────────────────────────────────────────────────────

function App() {
  return html\`
    <\${AuthApp}>
      <\${AuditDashboard} />
    </\${AuthApp}>
  \`;
}

render(html\`<\${App} />\`, document.getElementById("app"));
`;

/** Audit dashboard — shows only barretenberg-audit profile sessions. */
export function auditDashboardHTML(): string {
  return appShell({
    title: "ClaudeBox Audit",
    styles: AUDIT_STYLES,
    moduleScript: AUDIT_MODULE_SCRIPT,
  });
}
