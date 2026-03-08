import { appShell } from "./app-shell.ts";

const PERSONAL_STYLES = `
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0a0a0a;color:#ccc;font-family:'SF Mono',Monaco,'Cascadia Code',monospace;font-size:13px;line-height:1.5;height:100vh;display:flex;flex-direction:column}
a{color:#7aa2f7;text-decoration:none}a:hover{text-decoration:underline}
::-webkit-scrollbar{width:5px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:#333;border-radius:3px}

/* Header */
.header{padding:10px 16px;border-bottom:1px solid #1a1a1a;display:flex;align-items:center;gap:12px;flex-shrink:0;background:#0d0d0d;flex-wrap:wrap}
.header-title{font-weight:bold;color:#d876e3;font-size:15px}
.header-spacer{flex:1}
.header-item{display:flex;align-items:center;gap:6px;font-size:12px}
.header-link{color:#666;font-size:12px}
.header-link:hover{color:#ccc}

/* Search */
.search-input{background:#111;color:#ccc;border:1px solid #333;border-radius:4px;padding:5px 10px;font-family:inherit;font-size:12px;width:200px}
.search-input:focus{outline:none;border-color:#d876e3}

/* View toggle */
.view-toggle{display:flex;border:1px solid #333;border-radius:4px;overflow:hidden}
.view-toggle button{background:#111;color:#666;border:none;padding:4px 10px;font-family:inherit;font-size:11px;cursor:pointer}
.view-toggle button.active{background:#222;color:#d876e3}
.view-toggle button:hover:not(.active){color:#ccc}

/* Buttons */
.btn{background:#151515;color:#ccc;border:1px solid #333;border-radius:4px;padding:5px 14px;font-family:inherit;font-size:12px;cursor:pointer;transition:all 0.15s}
.btn:hover{background:#222;color:#fff}
.btn:disabled{color:#444;border-color:#222;cursor:default;background:#0d0d0d}
.btn-green{border-color:#61D668;color:#61D668}.btn-green:hover{background:#0d1f0d}
.btn-purple{border-color:#d876e3;color:#d876e3}.btn-purple:hover{background:#1f0d1f}
.btn-red{border-color:#E94560;color:#E94560}.btn-red:hover{background:#1f0d0d}
.btn-sm{padding:3px 8px;font-size:11px}

/* Main content */
.main{flex:1;overflow-y:auto;padding:16px}

/* Tag chips */
.tag-bar{display:flex;gap:6px;flex-wrap:wrap;margin-bottom:12px}
.tag-chip{font-size:10px;padding:2px 8px;border-radius:10px;border:1px solid #333;color:#aaa;cursor:pointer;transition:all 0.15s;user-select:none}
.tag-chip:hover{border-color:#666;color:#ccc}
.tag-chip.active{border-color:#d876e3;color:#d876e3;background:rgba(216,118,227,0.1)}

/* Channel groups */
.channel-group{margin-bottom:24px}
.channel-header{font-size:13px;font-weight:bold;color:#FAD979;padding:8px 0 6px;border-bottom:1px solid #1a1a1a;margin-bottom:10px;display:flex;align-items:center;gap:8px}
.channel-header .count{color:#666;font-weight:normal;font-size:11px}
.thread-group{margin-left:12px;margin-bottom:14px;padding-left:12px;border-left:2px solid #1a1a1a}
.thread-header{font-size:11px;color:#666;margin-bottom:8px;cursor:pointer}
.thread-header:hover{color:#999}

/* Cards */
.ws-card{background:#111;border:1px solid #222;border-radius:6px;padding:12px 14px;margin-bottom:8px;cursor:pointer;transition:border-color 0.15s;position:relative}
.ws-card:hover{border-color:#444}
.ws-card.running{border-left:3px solid #61D668}
.ws-card.error{border-left:3px solid #E94560}
.ws-card-top{display:flex;align-items:flex-start;gap:8px;margin-bottom:4px}
.ws-card-name{font-size:13px;font-weight:bold;color:#ddd;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.ws-card-status{display:flex;align-items:center;gap:4px;font-size:11px;flex-shrink:0}
.status-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0}
.status-dot.running{background:#61D668;animation:pulse 2s infinite}
.status-dot.completed{background:#61D668}
.status-dot.error{background:#E94560}
.status-dot.cancelled,.status-dot.interrupted,.status-dot.unknown{background:#666}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.3}}
.ws-card-meta{display:flex;gap:10px;font-size:11px;color:#666;flex-wrap:wrap;margin-bottom:4px}
.ws-card-response{font-size:11px;color:#888;margin-top:4px;overflow:hidden;text-overflow:ellipsis;white-space:nowrap;max-width:100%}
.ws-card-artifacts{display:flex;gap:6px;flex-wrap:wrap;margin-top:6px}
.artifact-link{font-size:11px;color:#7aa2f7;background:#0d1a2e;padding:2px 8px;border-radius:3px;border:1px solid #1a2a44}
.artifact-link:hover{border-color:#7aa2f7}
.ws-card-tags{display:flex;gap:4px;flex-wrap:wrap;margin-top:6px}
.ws-tag{font-size:10px;padding:1px 6px;border-radius:3px;border:1px solid #333;color:#aaa;background:#151515}
.ws-card-actions{margin-top:8px;display:flex;gap:6px}

/* Flat view */
.flat-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(380px,1fr));gap:10px}

/* Stats bar */
.stats-bar{display:flex;gap:16px;margin-bottom:16px;flex-wrap:wrap;font-size:12px;color:#666}
.stat{background:#111;border:1px solid #222;border-radius:4px;padding:6px 12px}
.stat .num{color:#d876e3;font-weight:bold;font-size:16px;margin-right:4px}

/* Empty state */
.empty{text-align:center;color:#444;padding:40px 20px;font-size:13px}

/* New session modal */
.modal-overlay{position:fixed;inset:0;background:rgba(0,0,0,0.8);z-index:100;display:flex;align-items:center;justify-content:center}
.modal{background:#111;border:1px solid #333;border-radius:8px;padding:24px;width:420px;max-width:90vw;display:flex;flex-direction:column;gap:14px}
.modal-title{color:#d876e3;font-weight:bold;font-size:14px}
.form-row{display:flex;flex-direction:column;gap:4px}
.form-label{font-size:11px;text-transform:uppercase;letter-spacing:0.5px;color:#666}
.form-input{background:#0a0a0a;border:1px solid #333;border-radius:4px;padding:8px 12px;color:#ccc;font-family:inherit;font-size:13px;resize:none}
.form-input:focus{outline:none;border-color:#d876e3}
.form-input.textarea{height:100px}
.form-select{background:#0a0a0a;border:1px solid #333;border-radius:4px;padding:8px 12px;color:#ccc;font-family:inherit;font-size:13px}
.form-actions{display:flex;gap:8px;justify-content:flex-end;margin-top:4px}
.form-error{color:#E94560;font-size:11px}

@media(max-width:480px){.flat-grid{grid-template-columns:1fr}.header{gap:8px}.search-input{width:140px}}
`;

export function personalDashboardHTML(): string {
  return appShell({
    title: "My Sessions - ClaudeBox",
    styles: PERSONAL_STYLES,
    moduleScript: PERSONAL_MODULE,
  });
}

const PERSONAL_MODULE = `
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

// ── WorkspaceCard ────────────────────────────────────────────

function WorkspaceCard({ w, onRefresh }) {
  const cls = useMemo(() => {
    let c = "ws-card";
    if (w.status === "running") c += " " + w.status;
    if (w.status === "error") c += " error";
    return c;
  }, [w.status]);

  const displayName = useMemo(() => {
    const n = w.name || w.prompt || "Unnamed";
    return n.length > 80 ? n.slice(0, 80) + "\\u2026" : n;
  }, [w.name, w.prompt]);

  const exitStr = w.exitCode != null ? " (" + w.exitCode + ")" : "";

  const handleClick = useCallback((e) => {
    if (e.target.closest(".cancel-btn") || e.target.closest(".tag-btn") || e.target.closest("a")) return;
    location.href = "/s/" + w.worktreeId;
  }, [w.worktreeId]);

  const handleCancel = useCallback((e) => {
    e.stopPropagation();
    authFetch("/s/" + w.worktreeId + "/cancel", { method: "POST" })
      .then(() => onRefresh())
      .catch(err => alert("Cancel failed: " + err.message));
  }, [w.worktreeId, onRefresh]);

  const handleTag = useCallback((e) => {
    e.stopPropagation();
    const btn = e.currentTarget;
    btn.disabled = true;
    btn.textContent = "Tagging...";
    authFetch("/api/me/tag", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ worktree_id: w.worktreeId })
    })
      .then(r => r.json())
      .then(d => {
        if (d.tags) onRefresh();
        else { btn.disabled = false; btn.textContent = "Auto-tag"; }
      })
      .catch(() => { btn.disabled = false; btn.textContent = "Auto-tag"; });
  }, [w.worktreeId, onRefresh]);

  const showTags = w.tags && w.tags.length && !(w.tags.length === 1 && w.tags[0] === "untagged");
  const isRunning = w.status === "running";
  const showAutoTag = !isRunning && (!w.tags || !w.tags.length || w.tags.includes("untagged"));

  return html\`
    <div class=\${cls} onClick=\${handleClick}>
      <div class="ws-card-top">
        <div class="ws-card-name">\${displayName}</div>
        <div class="ws-card-status">
          <span class=\${"status-dot " + w.status}></span>
          <span>\${w.status}\${exitStr}</span>
        </div>
      </div>
      <div class="ws-card-meta">
        \${w.channelName ? html\`<span>#\${w.channelName}</span>\` : null}
        <span>\${w.runCount} run\${w.runCount !== 1 ? "s" : ""}</span>
        <span>\${timeAgo(w.started)}</span>
      </div>
      \${w.latestResponse ? html\`<div class="ws-card-response">\${w.latestResponse}</div>\` : null}
      \${w.artifacts && w.artifacts.length ? html\`
        <div class="ws-card-artifacts">
          \${w.artifacts.map(a => html\`
            <a href=\${a.url} target="_blank" class="artifact-link" onClick=\${(e) => e.stopPropagation()}>\${a.text}</a>
          \`)}
        </div>
      \` : null}
      \${showTags ? html\`
        <div class="ws-card-tags">
          \${w.tags.map(t => html\`<span class="ws-tag">\${t}</span>\`)}
        </div>
      \` : null}
      \${isRunning ? html\`
        <div class="ws-card-actions">
          <button class="btn btn-red btn-sm cancel-btn" onClick=\${handleCancel}>Cancel</button>
        </div>
      \` : showAutoTag ? html\`
        <div class="ws-card-actions">
          <button class="btn btn-purple btn-sm tag-btn" onClick=\${handleTag}>Auto-tag</button>
        </div>
      \` : null}
    </div>
  \`;
}

// ── StatsBar ─────────────────────────────────────────────────

function StatsBar({ data }) {
  if (!data || !data.length) return null;
  const total = data.length;
  const running = data.filter(w => w.status === "running").length;
  const completed = data.filter(w => w.status === "completed").length;
  const errors = data.filter(w => w.status === "error").length;
  let artifacts = 0;
  data.forEach(w => { artifacts += (w.artifacts || []).length; });

  return html\`
    <div class="stats-bar">
      <div class="stat"><span class="num">\${total}</span>sessions</div>
      <div class="stat"><span class="num" style="color:#61D668">\${running}</span>running</div>
      <div class="stat"><span class="num" style="color:#61D668">\${completed}</span>completed</div>
      \${errors ? html\`<div class="stat"><span class="num" style="color:#E94560">\${errors}</span>errors</div>\` : null}
      <div class="stat"><span class="num" style="color:#7aa2f7">\${artifacts}</span>artifacts</div>
    </div>
  \`;
}

// ── TagBar ───────────────────────────────────────────────────

function TagBar({ allTags, activeTags, onToggle }) {
  if (!allTags || !allTags.length) return null;
  return html\`
    <div class="tag-bar">
      \${allTags.map(t => html\`
        <span class=\${"tag-chip" + (activeTags.has(t) ? " active" : "")}
          onClick=\${() => onToggle(t)}>\${t}</span>
      \`)}
    </div>
  \`;
}

// ── GroupedView ──────────────────────────────────────────────

function GroupedView({ groups, matchesFilter, onRefresh }) {
  if (!groups || !groups.length) {
    return html\`<div class="empty">No sessions found for this user.</div>\`;
  }

  const visibleGroups = useMemo(() => {
    const out = [];
    groups.forEach(g => {
      const visibleThreads = [];
      (g.threads || []).forEach(t => {
        const visibleWs = (t.workspaces || []).filter(matchesFilter);
        if (visibleWs.length) visibleThreads.push({ ...t, workspaces: visibleWs });
      });
      if (visibleThreads.length) out.push({ ...g, threads: visibleThreads });
    });
    return out;
  }, [groups, matchesFilter]);

  if (!visibleGroups.length) return html\`<div class="empty">No matching sessions.</div>\`;

  return html\`
    \${visibleGroups.map(g => {
      const totalInChannel = g.threads.reduce((n, t) => n + t.workspaces.length, 0);
      return html\`
        <div class="channel-group">
          <div class="channel-header">#\${g.channel} <span class="count">(\${totalInChannel} session\${totalInChannel !== 1 ? "s" : ""})</span></div>
          \${g.threads.map(t => {
            if (g.threads.length > 1 || t.workspaces.length > 1) {
              const threadLabel = t.firstPrompt
                ? (t.firstPrompt.length > 80 ? t.firstPrompt.slice(0, 80) + "\\u2026" : t.firstPrompt)
                : "Thread";
              return html\`
                <div class="thread-group">
                  <div class="thread-header">\${threadLabel}</div>
                  \${t.workspaces.map(w => html\`<\${WorkspaceCard} key=\${w.worktreeId} w=\${w} onRefresh=\${onRefresh} />\`)}
                </div>
              \`;
            }
            return t.workspaces.map(w => html\`<\${WorkspaceCard} key=\${w.worktreeId} w=\${w} onRefresh=\${onRefresh} />\`);
          })}
        </div>
      \`;
    })}
  \`;
}

// ── FlatView ─────────────────────────────────────────────────

function FlatView({ flat, matchesFilter, onRefresh }) {
  if (!flat || !flat.length) {
    return html\`<div class="empty">No sessions found for this user.</div>\`;
  }
  const visible = useMemo(() => flat.filter(matchesFilter), [flat, matchesFilter]);
  if (!visible.length) return html\`<div class="empty">No matching sessions.</div>\`;
  return html\`
    <div class="flat-grid">
      \${visible.map(w => html\`<\${WorkspaceCard} key=\${w.worktreeId} w=\${w} onRefresh=\${onRefresh} />\`)}
    </div>
  \`;
}

// ── NewSessionModal ──────────────────────────────────────────

function NewSessionModal({ visible, branches, onClose }) {
  const [prompt, setPrompt] = useState("");
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
      body: JSON.stringify({ prompt: prompt.trim(), base_branch: branch })
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
  }, [prompt, branch, onClose]);

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
          <label class="form-label">Branch</label>
          <select class="form-select" value=\${branch} onChange=\${(e) => setBranch(e.target.value)}>
            \${(branches || ["next"]).map(b => html\`<option value=\${b}>\${b}</option>\`)}
          </select>
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

// ── Header ───────────────────────────────────────────────────

function Header({ view, onViewChange, searchTerm, onSearchChange, selectedUser, users, onUserChange, onNewSession }) {
  const timerRef = useRef(null);
  const handleSearch = useCallback((e) => {
    const val = e.target.value;
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => onSearchChange(val.trim()), 200);
  }, [onSearchChange]);

  return html\`
    <div class="header">
      <span class="header-title">MY SESSIONS</span>
      <a href="/dashboard" class="header-link">\\u2190 Dashboard</a>
      <span class="header-spacer"></span>
      <input class="search-input" type="text" placeholder="Search sessions..." onInput=\${handleSearch} />
      <div class="view-toggle">
        <button class=\${view === "grouped" ? "active" : ""} onClick=\${() => onViewChange("grouped")}>By Channel</button>
        <button class=\${view === "flat" ? "active" : ""} onClick=\${() => onViewChange("flat")}>All</button>
      </div>
      <div class="header-item">
        <span style="color:#666;font-size:11px;text-transform:uppercase;letter-spacing:0.5px">as</span>
        <select style="background:#111;color:#ccc;border:1px solid #333;border-radius:4px;padding:4px 8px;font-family:inherit;font-size:12px;cursor:pointer"
          value=\${selectedUser} onChange=\${(e) => onUserChange(e.target.value)}>
          <option value="">All</option>
          \${(users || []).map(u => html\`<option value=\${u}>\${u}</option>\`)}
        </select>
      </div>
      <button class="btn btn-green btn-sm" onClick=\${onNewSession}>+ New</button>
    </div>
  \`;
}

// ── App ──────────────────────────────────────────────────────

function PersonalApp() {
  const [rawData, setRawData] = useState(null);
  const [branches, setBranches] = useState(["next"]);
  const [selectedUser, setSelectedUser] = useState(localStorage.getItem("cb_me_identity") || "");
  const [view, setView] = useState("grouped");
  const [searchTerm, setSearchTerm] = useState("");
  const [activeTags, setActiveTags] = useState(new Set());
  const [showModal, setShowModal] = useState(false);

  const loadSessions = useCallback(() => {
    authFetch("/api/me/sessions")
      .then(r => r.json())
      .then(d => setRawData(d))
      .catch(() => {});
  }, []);

  const loadBranches = useCallback(() => {
    authFetch("/api/branches")
      .then(r => r.json())
      .then(d => setBranches(d.branches || ["next"]))
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadSessions();
    loadBranches();
  }, [loadSessions, loadBranches]);

  // Auto-refresh
  useEffect(() => {
    const iv = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      if (showModal) return;
      loadSessions();
    }, 10000);
    return () => clearInterval(iv);
  }, [loadSessions, showModal]);

  const handleUserChange = useCallback((v) => {
    setSelectedUser(v);
    localStorage.setItem("cb_me_identity", v);
  }, []);

  const handleTagToggle = useCallback((tag) => {
    setActiveTags(prev => {
      const next = new Set(prev);
      if (next.has(tag)) next.delete(tag); else next.add(tag);
      return next;
    });
  }, []);

  // Derive users from data
  const users = useMemo(() => {
    if (!rawData || !rawData.flat) return [];
    const s = new Set();
    rawData.flat.forEach(w => { if (w.user) s.add(w.user); });
    return Array.from(s).sort();
  }, [rawData]);

  // Filter data by selected user
  const data = useMemo(() => {
    if (!rawData) return null;
    if (!selectedUser) return rawData;
    const filtered = rawData.flat.filter(w => w.user === selectedUser);
    const groups = [];
    (rawData.groups || []).forEach(g => {
      const threads = [];
      (g.threads || []).forEach(t => {
        const ws = (t.workspaces || []).filter(w => w.user === selectedUser);
        if (ws.length) threads.push({ ...t, workspaces: ws });
      });
      if (threads.length) groups.push({ ...g, threads });
    });
    return { flat: filtered, groups };
  }, [rawData, selectedUser]);

  // Collect all tags
  const allTags = useMemo(() => {
    if (!data || !data.flat) return [];
    const s = new Set();
    data.flat.forEach(w => (w.tags || []).forEach(t => s.add(t)));
    return Array.from(s).sort();
  }, [data]);

  // Filter function for search + tags
  const matchesFilter = useCallback((w) => {
    if (searchTerm) {
      const s = searchTerm.toLowerCase();
      const haystack = ((w.prompt || "") + " " + (w.name || "") + " " + (w.channelName || "") + " " + (w.tags || []).join(" ") + " " + (w.latestResponse || "")).toLowerCase();
      if (haystack.indexOf(s) === -1) return false;
    }
    if (activeTags.size > 0) {
      const wTags = w.tags || [];
      let match = false;
      activeTags.forEach(t => { if (wTags.indexOf(t) !== -1) match = true; });
      if (!match) return false;
    }
    return true;
  }, [searchTerm, activeTags]);

  return html\`
    <\${AuthApp}>
      <\${Header}
        view=\${view}
        onViewChange=\${setView}
        searchTerm=\${searchTerm}
        onSearchChange=\${setSearchTerm}
        selectedUser=\${selectedUser}
        users=\${users}
        onUserChange=\${handleUserChange}
        onNewSession=\${() => setShowModal(true)}
      />
      <div class="main">
        \${data ? html\`
          <\${StatsBar} data=\${data.flat} />
          <\${TagBar} allTags=\${allTags} activeTags=\${activeTags} onToggle=\${handleTagToggle} />
          \${view === "grouped"
            ? html\`<\${GroupedView} groups=\${data.groups} matchesFilter=\${matchesFilter} onRefresh=\${loadSessions} />\`
            : html\`<\${FlatView} flat=\${data.flat} matchesFilter=\${matchesFilter} onRefresh=\${loadSessions} />\`
          }
        \` : html\`<div class="empty">Loading...</div>\`}
      </div>
      <\${NewSessionModal}
        visible=\${showModal}
        branches=\${branches}
        onClose=\${() => setShowModal(false)}
      />
    </\${AuthApp}>
  \`;
}

render(html\`<\${PersonalApp} />\`, document.getElementById("app"));
`;
