import { appShell } from "./app-shell.ts";

const DASHBOARD_STYLES = `
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
.card.error{border-left:3px solid #E94560}
.card.resolved{opacity:0.6}
.card.deleted{opacity:0.4}
.card-top{display:flex;align-items:flex-start;gap:8px;margin-bottom:6px}
.card-name{font-size:13px;font-weight:bold;color:#ddd;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.card-name.editing{background:#0a0a0a;border:1px solid #5FA7F1;border-radius:3px;padding:2px 6px;outline:none;white-space:normal;font-weight:normal}
.card-status{display:flex;align-items:center;gap:4px;font-size:11px;flex-shrink:0}
.status-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0}
.status-dot.running{background:#61D668;animation:pulse 2s infinite}
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

/* Kebab menu */
.kebab{color:#444;cursor:pointer;padding:2px 6px;font-size:16px;line-height:1;border-radius:3px;flex-shrink:0}
.kebab:hover{color:#ccc;background:#222}
.menu{position:absolute;right:8px;top:32px;background:#1a1a1a;border:1px solid #333;border-radius:4px;z-index:10;min-width:140px;box-shadow:0 4px 12px rgba(0,0,0,0.5)}
.menu-item{padding:6px 12px;font-size:12px;cursor:pointer;color:#ccc;display:block;width:100%;text-align:left;background:none;border:none;font-family:inherit}
.menu-item:hover{background:#222}
.menu-item.danger{color:#E94560}
.menu-item.danger:hover{background:#1f0d0d}

/* New session modal */
.modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.8);z-index:100;display:flex;align-items:center;justify-content:center}
.modal{background:#111;border:1px solid #333;border-radius:8px;padding:24px;width:420px;max-width:90vw;display:flex;flex-direction:column;gap:14px}
.modal-title{color:#5FA7F1;font-weight:bold;font-size:14px}
.form-row{display:flex;flex-direction:column;gap:4px}
.form-label{font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:#666}
.form-input{background:#0a0a0a;border:1px solid #333;border-radius:4px;padding:8px 12px;color:#ccc;font-family:inherit;font-size:13px;resize:none}
.form-input:focus{outline:none;border-color:#5FA7F1}
.form-input.textarea{height:100px}
.form-select{background:#0a0a0a;border:1px solid #333;border-radius:4px;padding:8px 12px;color:#ccc;font-family:inherit;font-size:13px}
.form-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:4px}
.form-error{color:#E94560;font-size:11px}

/* Empty state */
.empty{text-align:center;color:#444;padding:40px 20px;font-size:13px}

/* Responsive */
@media(max-width:480px){.card-grid{grid-template-columns:1fr}.header{gap:8px}}
`;

export { DASHBOARD_STYLES };

export function dashboardHTML(): string {
  return appShell({
    title: "ClaudeBox Dashboard",
    styles: DASHBOARD_STYLES,
    moduleScript: DASHBOARD_MODULE,
  });
}

const DASHBOARD_MODULE = `
const {h,render,html,useState,useEffect,useCallback,useRef,useMemo,AuthApp,authFetch} = window.__preact;

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

// ── WorkspaceCard ────────────────────────────────────────────

function WorkspaceCard({ w, onRefresh }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const nameRef = useRef(null);

  const cls = useMemo(() => {
    let c = "card";
    if (w.status === "running") c += " " + w.status;
    if (w.status === "error") c += " error";
    if (w.resolved) c += " resolved";
    if (!w.alive) c += " deleted";
    return c;
  }, [w.status, w.resolved, w.alive]);

  const displayName = useMemo(() => {
    const n = w.name || w.prompt || "Unnamed workspace";
    return n.length > 80 ? n.slice(0, 80) + "\\u2026" : n;
  }, [w.name, w.prompt]);

  const exitStr = w.exitCode != null ? " (" + w.exitCode + ")" : "";

  const handleCardClick = useCallback((e) => {
    if (e.target.closest(".kebab") || e.target.closest(".menu") || editing) return;
    location.href = "/s/" + w.worktreeId;
  }, [w.worktreeId, editing]);

  const toggleMenu = useCallback((e) => {
    e.stopPropagation();
    setMenuOpen(prev => !prev);
  }, []);

  const handleRename = useCallback((e) => {
    e.stopPropagation();
    setMenuOpen(false);
    setEditing(true);
    setTimeout(() => {
      const el = nameRef.current;
      if (!el) return;
      el.contentEditable = "true";
      el.classList.add("editing");
      el.focus();
      const range = document.createRange();
      range.selectNodeContents(el);
      const sel = window.getSelection();
      sel.removeAllRanges();
      sel.addRange(range);
    }, 0);
  }, []);

  const handleNameBlur = useCallback(() => {
    const el = nameRef.current;
    if (!el) return;
    el.contentEditable = "false";
    el.classList.remove("editing");
    setEditing(false);
    const newName = el.textContent.trim();
    if (!newName || newName === displayName) return;
    authFetch("/s/" + w.worktreeId + "/name", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ name: newName })
    }).then(r => { if (r.ok) onRefresh(); });
  }, [w.worktreeId, displayName, onRefresh]);

  const handleNameKeydown = useCallback((e) => {
    if (e.key === "Enter") { e.preventDefault(); nameRef.current?.blur(); }
    if (e.key === "Escape") { nameRef.current.textContent = displayName; nameRef.current?.blur(); }
  }, [displayName]);

  const handleResolve = useCallback((e) => {
    e.stopPropagation();
    setMenuOpen(false);
    authFetch("/s/" + w.worktreeId + "/resolve", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ resolved: !w.resolved })
    }).then(() => onRefresh());
  }, [w.worktreeId, w.resolved, onRefresh]);

  const handleDelete = useCallback((e) => {
    e.stopPropagation();
    setMenuOpen(false);
    if (!confirm("Delete this workspace? This frees disk space but cannot be undone.")) return;
    authFetch("/s/" + w.worktreeId, { method: "DELETE" })
      .then(r => r.json())
      .then(d => { if (d.ok) onRefresh(); else alert(d.message || "Could not delete"); })
      .catch(e => alert("Error: " + e.message));
  }, [w.worktreeId, onRefresh]);

  return html\`
    <div class=\${cls} onClick=\${handleCardClick}>
      <div class="card-top">
        <div class="card-name" ref=\${nameRef}
          onBlur=\${editing ? handleNameBlur : undefined}
          onKeyDown=\${editing ? handleNameKeydown : undefined}
        >\${displayName}</div>
        <div class="card-status">
          <span class=\${"status-dot " + w.status}></span>
          <span>\${w.status}\${exitStr}</span>
        </div>
        <span class="kebab" onClick=\${toggleMenu}>&#8942;</span>
      </div>
      <div class="card-meta">
        <span>\${w.user}</span>
        <span>\${w.baseBranch}</span>
        <span>\${w.runCount} run\${w.runCount !== 1 ? "s" : ""}</span>
        <span>\${w.started ? timeAgo(w.started) : "\\u2014"}</span>
      </div>
      \${w.name && w.prompt ? html\`
        <div class="card-prompt">\${w.prompt.length > 100 ? w.prompt.slice(0, 100) + "\\u2026" : w.prompt}</div>
      \` : null}
      <div class="card-badges">
        \${!w.alive ? html\`<span class="badge badge-deleted">deleted</span>\` : null}
        \${w.resolved ? html\`<span class="badge badge-resolved">resolved</span>\` : null}
        \${w.channelName ? html\`<span class="badge badge-channel">#\${w.channelName}</span>\` : null}
      </div>
      \${menuOpen ? html\`
        <div class="menu">
          <button class="menu-item" onClick=\${handleRename}>Rename</button>
          <button class="menu-item" onClick=\${handleResolve}>\${w.resolved ? "Unresolve" : "Resolve"}</button>
          \${w.alive && w.status !== "running" ? html\`
            <button class="menu-item danger" onClick=\${handleDelete}>Delete</button>
          \` : null}
        </div>
      \` : null}
    </div>
  \`;
}

// ── WorkspaceGrid ────────────────────────────────────────────

function WorkspaceGrid({ workspaces, onRefresh }) {
  const [resolvedExpanded, setResolvedExpanded] = useState(false);

  const { running, recent, resolved } = useMemo(() => {
    const running = [], recent = [], resolved = [];
    (workspaces || []).forEach(w => {
      if (w.status === "running") running.push(w);
      else if (w.resolved) resolved.push(w);
      else recent.push(w);
    });
    return { running, recent, resolved };
  }, [workspaces]);

  return html\`
    \${running.length > 0 ? html\`
      <div class="section">
        <div class="section-header running-header">Running <span class="count">(\${running.length})</span></div>
        <div class="card-grid">
          \${running.map(w => html\`<\${WorkspaceCard} key=\${w.worktreeId} w=\${w} onRefresh=\${onRefresh} />\`)}
        </div>
      </div>
    \` : null}
    <div class="section">
      <div class="section-header">Recent <span class="count">(\${recent.length})</span></div>
      \${recent.length > 0 ? html\`
        <div class="card-grid">
          \${recent.map(w => html\`<\${WorkspaceCard} key=\${w.worktreeId} w=\${w} onRefresh=\${onRefresh} />\`)}
        </div>
      \` : html\`<div class="empty">No recent workspaces</div>\`}
    </div>
    \${resolved.length > 0 ? html\`
      <div class="section">
        <div class="section-header resolved-header" onClick=\${() => setResolvedExpanded(v => !v)}>
          Resolved <span class="count">(\${resolved.length})</span>
          <span class="toggle">\${resolvedExpanded ? "\\u25BC" : "\\u25B6"}</span>
        </div>
        \${resolvedExpanded ? html\`
          <div class="card-grid">
            \${resolved.map(w => html\`<\${WorkspaceCard} key=\${w.worktreeId} w=\${w} onRefresh=\${onRefresh} />\`)}
          </div>
        \` : null}
      </div>
    \` : null}
  \`;
}

// ── NewSessionModal ──────────────────────────────────────────

function NewSessionModal({ visible, identity, branches, onClose }) {
  const [prompt, setPrompt] = useState("");
  const [name, setName] = useState("");
  const [branch, setBranch] = useState("next");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const promptRef = useRef(null);

  useEffect(() => {
    if (visible && promptRef.current) promptRef.current.focus();
  }, [visible]);

  useEffect(() => {
    if (!visible) return;
    const handler = (e) => { if (e.key === "Escape") onClose(); };
    document.addEventListener("keydown", handler);
    return () => document.removeEventListener("keydown", handler);
  }, [visible, onClose]);

  const handleSubmit = useCallback((e) => {
    e.preventDefault();
    if (!prompt.trim()) return;
    setSubmitting(true);
    setError("");
    authFetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: prompt.trim(),
        name: name.trim() || undefined,
        base_branch: branch,
        user: identity || undefined,
      })
    })
      .then(r => r.json())
      .then(d => {
        if (d.ok && d.worktree_id) {
          onClose();
          location.href = "/s/" + d.worktree_id;
        } else {
          setError(d.message || d.error || "Failed to start session");
          setSubmitting(false);
        }
      })
      .catch(err => {
        setError("Connection error: " + err.message);
        setSubmitting(false);
      });
  }, [prompt, name, branch, identity, onClose]);

  if (!visible) return null;

  return html\`
    <div class="modal-overlay" onClick=\${(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <form class="modal" onSubmit=\${handleSubmit}>
        <div class="modal-title">New Session</div>
        <div class="form-row">
          <label class="form-label">What should ClaudeBox work on?</label>
          <textarea ref=\${promptRef} class="form-input textarea" placeholder="Describe the task..."
            value=\${prompt} onInput=\${(e) => setPrompt(e.target.value)} required></textarea>
        </div>
        <div class="form-row">
          <label class="form-label">Task name (optional)</label>
          <input class="form-input" type="text" placeholder="e.g., Fix authentication bug"
            value=\${name} onInput=\${(e) => setName(e.target.value)} />
        </div>
        <div class="form-row">
          <label class="form-label">Branch</label>
          <select class="form-select" value=\${branch} onChange=\${(e) => setBranch(e.target.value)}>
            \${(branches || ["next"]).map(b => html\`<option value=\${b}>\${b}</option>\`)}
          </select>
        </div>
        <div class="form-row">
          <label class="form-label">As</label>
          <span style="color:#ccc">\${identity || "(select identity above)"}</span>
        </div>
        \${error ? html\`<div class="form-error">\${error}</div>\` : null}
        <div class="form-actions">
          <button type="button" class="btn" onClick=\${onClose}>Cancel</button>
          <button type="submit" class="btn btn-green" disabled=\${submitting}>
            \${submitting ? "Starting..." : "Start Session"}
          </button>
        </div>
      </form>
    </div>
  \`;
}

// ── FilterBar (search) ───────────────────────────────────────

function FilterBar({ search, onSearchChange }) {
  const timerRef = useRef(null);
  const handleInput = useCallback((e) => {
    const val = e.target.value;
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => onSearchChange(val.trim()), 200);
  }, [onSearchChange]);
  return html\`<span />\`;
}

// ── Header ───────────────────────────────────────────────────

function Header({ activeCount, maxConcurrent, identity, users, onIdentityChange, onNewSession }) {
  return html\`
    <div class="header">
      <span class="header-title">CLAUDEBOX</span>
      <span class="header-spacer"></span>
      <div class="header-item">
        <span class="identity-label">as</span>
        <select class="identity-select" value=\${identity} onChange=\${(e) => onIdentityChange(e.target.value)}>
          \${(users || []).map(u => html\`<option value=\${u}>\${u}</option>\`)}
        </select>
      </div>
      <span class="capacity">\${activeCount}/\${maxConcurrent} active</span>
      <button class="btn btn-green" disabled=\${activeCount >= maxConcurrent} onClick=\${onNewSession}>+ New</button>
    </div>
  \`;
}

// ── App ──────────────────────────────────────────────────────

function DashboardApp() {
  const [workspaces, setWorkspaces] = useState([]);
  const [activeCount, setActiveCount] = useState(0);
  const [maxConcurrent, setMaxConcurrent] = useState(0);
  const [users, setUsers] = useState([]);
  const [branches, setBranches] = useState(["next"]);
  const [identity, setIdentity] = useState(localStorage.getItem("cb_identity") || "");
  const [showModal, setShowModal] = useState(false);

  const loadDashboard = useCallback(() => {
    authFetch("/api/dashboard")
      .then(r => r.json())
      .then(d => {
        setWorkspaces(d.workspaces || []);
        setActiveCount(d.activeCount || 0);
        setMaxConcurrent(d.maxConcurrent || 0);
      })
      .catch(() => {});
  }, []);

  const loadUsers = useCallback(() => {
    authFetch("/api/users")
      .then(r => r.json())
      .then(d => {
        const list = d.users || [];
        setUsers(list);
        const stored = localStorage.getItem("cb_identity") || "";
        if (!list.includes(stored) && list.length) {
          setIdentity(list[0]);
          localStorage.setItem("cb_identity", list[0]);
        }
      })
      .catch(() => {});
  }, []);

  const loadBranches = useCallback(() => {
    authFetch("/api/branches")
      .then(r => r.json())
      .then(d => setBranches(d.branches || ["next"]))
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadDashboard();
    loadUsers();
    loadBranches();
  }, [loadDashboard, loadUsers, loadBranches]);

  // Auto-refresh
  useEffect(() => {
    const iv = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      if (showModal) return;
      loadDashboard();
    }, 10000);
    return () => clearInterval(iv);
  }, [loadDashboard, showModal]);

  const handleIdentityChange = useCallback((v) => {
    setIdentity(v);
    localStorage.setItem("cb_identity", v);
  }, []);

  // Close menus on click outside
  useEffect(() => {
    const handler = (e) => {
      if (!e.target.closest(".kebab") && !e.target.closest(".menu")) {
        // Menu closing is handled per-card via state, so this is a no-op.
        // Individual cards manage their own menu state.
      }
    };
    document.addEventListener("click", handler);
    return () => document.removeEventListener("click", handler);
  }, []);

  return html\`
    <\${AuthApp}>
      <\${Header}
        activeCount=\${activeCount}
        maxConcurrent=\${maxConcurrent}
        identity=\${identity}
        users=\${users}
        onIdentityChange=\${handleIdentityChange}
        onNewSession=\${() => setShowModal(true)}
      />
      <div class="main">
        <\${WorkspaceGrid} workspaces=\${workspaces} onRefresh=\${loadDashboard} />
      </div>
      <\${NewSessionModal}
        visible=\${showModal}
        identity=\${identity}
        branches=\${branches}
        onClose=\${() => setShowModal(false)}
      />
    </\${AuthApp}>
  \`;
}

render(html\`<\${DashboardApp} />\`, document.getElementById("app"));
`;
