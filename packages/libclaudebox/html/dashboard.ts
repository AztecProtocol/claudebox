import { appShell } from "./app-shell.ts";

const DASHBOARD_STYLES = `
*{box-sizing:border-box;margin:0;padding:0}
body{background:#000;color:#e0e0e0;font-family:'SF Mono',Monaco,'Cascadia Code','Fira Code',monospace;font-size:13px;line-height:1.5;height:100vh;display:flex;flex-direction:column}
a{color:#7aa2f7;text-decoration:none}a:hover{text-decoration:underline}
::selection{background:#264f78}
::-webkit-scrollbar{width:6px}::-webkit-scrollbar-track{background:#000}::-webkit-scrollbar-thumb{background:#333;border-radius:3px}::-webkit-scrollbar-thumb:hover{background:#555}

/* Header */
.header{padding:8px 16px;border-bottom:1px solid #222;display:flex;align-items:center;gap:10px;flex-shrink:0;background:#0a0a0a}
.header-title{font-weight:bold;color:#7aa2f7;font-size:14px;letter-spacing:1px}
.header-spacer{flex:1}
.capacity{color:#555;font-size:11px;font-family:inherit}
.capacity .active-num{color:#7dcfff}

/* Buttons */
.btn{background:#111;color:#ccc;border:1px solid #333;border-radius:3px;padding:4px 12px;font-family:inherit;font-size:12px;cursor:pointer;transition:all 0.15s}
.btn:hover{background:#1a1a1a;color:#fff;border-color:#555}
.btn:disabled{color:#333;border-color:#1a1a1a;cursor:default;background:#0a0a0a}
.btn-green{border-color:#9ece6a;color:#9ece6a}.btn-green:hover{background:#0d1a0d}
.btn-blue{border-color:#7aa2f7;color:#7aa2f7}.btn-blue:hover{background:#0d0d1f}
.btn-red{border-color:#f7768e;color:#f7768e}.btn-red:hover{background:#1f0d0d}
.btn-sm{padding:2px 8px;font-size:11px}

/* Cards inside threads are flush */
.thread-sessions .card{border-radius:0;border-left:none;border-right:none;border-bottom:none}
.thread-sessions .card:last-child{border-bottom:none}
.thread-sessions .card::before{display:none}

/* Main content */
.main{flex:1;overflow-y:auto;padding:16px}

/* Loading bar */
.loading-bar{height:2px;background:#111;position:relative;overflow:hidden;flex-shrink:0}
.loading-bar.active::after{content:'';position:absolute;left:0;top:0;height:100%;width:30%;background:#7aa2f7;animation:slide 1s ease-in-out infinite}
@keyframes slide{0%{left:-30%}100%{left:100%}}

/* Skeleton cards */
.skeleton-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(380px,1fr));gap:8px}
.skeleton-card{background:#0a0a0a;border:1px solid #111;border-radius:4px;padding:12px 14px;overflow:hidden}
.skeleton-line{height:12px;background:#111;border-radius:2px;margin-bottom:8px;position:relative;overflow:hidden}
.skeleton-line::after{content:'';position:absolute;inset:0;background:linear-gradient(90deg,transparent,#1a1a1a,transparent);animation:shimmer 1.5s infinite}
@keyframes shimmer{0%{transform:translateX(-100%)}100%{transform:translateX(100%)}}
.skeleton-line.w60{width:60%}
.skeleton-line.w40{width:40%}
.skeleton-line.w80{width:80%}
.skeleton-line.w30{width:30%}
.skeleton-info{display:grid;grid-template-columns:1fr 1fr;gap:4px 16px;margin-top:8px;padding-top:8px;border-top:1px solid #0d0d0d}

/* Filter pills */
.pill-bar{display:flex;align-items:center;gap:4px;padding:8px 16px;border-bottom:1px solid #111;background:#050505;flex-shrink:0;flex-wrap:wrap}
.pill-bar-label{font-size:10px;color:#333;margin-right:4px;letter-spacing:0.3px}
.pill{font-size:10px;padding:2px 10px;border-radius:10px;border:1px solid #222;color:#555;cursor:pointer;white-space:nowrap;transition:all 0.15s;font-family:inherit;background:transparent}
.pill:hover{border-color:#555;color:#aaa}
.pill.active{border-color:#7dcfff;color:#7dcfff;background:#0d1520}
.pill.channel-pill.active{border-color:#e0af68;color:#e0af68;background:#1a1508}
.pill .pill-count{font-size:9px;color:#333;margin-left:3px}
.pill.active .pill-count{color:inherit;opacity:0.5}

/* Section headers */
.section-header{font-size:10px;letter-spacing:0.5px;color:#444;padding:0 0 6px;border-bottom:1px solid #111;margin-bottom:8px;display:flex;align-items:center;gap:6px}
.section-header.running-header{color:#9ece6a}
.section-header .count{color:#333;font-weight:normal}
.section-group{margin-bottom:20px}

/* Thread card */
.thread-card{background:#0a0a0a;border:1px solid #1a1a1a;border-radius:4px;margin-bottom:8px;overflow:hidden}
.thread-header{padding:10px 14px;display:flex;align-items:center;gap:8px;cursor:pointer;border-bottom:1px solid #111}
.thread-header:hover{background:#0d0d0d}
.thread-origin{font-size:10px;padding:2px 8px;border-radius:10px;border:1px solid;flex-shrink:0}
.thread-origin.slack{color:#e0af68;border-color:#2a2010}
.thread-origin.github{color:#7aa2f7;border-color:#1a1a2a}
.thread-origin.http{color:#9ece6a;border-color:#1a2a1a}
.thread-channel{font-size:11px;color:#e0af68}
.thread-meta{font-size:11px;color:#444;margin-left:auto;flex-shrink:0}
.thread-expand{color:#333;font-size:9px;flex-shrink:0;width:12px}
.thread-context{padding:8px 14px;background:#050505;border-top:1px solid #111;max-height:300px;overflow-y:auto}
.thread-msg{padding:3px 0;font-size:11px;line-height:1.5}
.thread-msg.bot{opacity:0.5}
.thread-msg-user{color:#bb9af7;font-weight:600;margin-right:6px}
.thread-msg-text{color:#888;word-break:break-word}
.thread-session-block{margin:4px 14px;padding:8px 12px;background:#0d0d12;border:1px solid #1a1a2a;border-radius:4px;position:relative;overflow:hidden}
.thread-session-block::before{content:'';position:absolute;left:0;top:0;bottom:0;width:3px}
.thread-session-block.ts-running::before{background:#9ece6a}
.thread-session-block.ts-error::before{background:#f7768e}
.thread-session-block.ts-completed::before{background:#444}
.thread-session-top{display:flex;align-items:center;gap:8px}
.thread-session-link{display:inline-flex;align-items:center;gap:6px;font-size:11px;color:#7aa2f7;text-decoration:none;font-weight:600}
.thread-session-link:hover{text-decoration:underline}
.thread-session-name{color:#aaa;font-weight:normal}
.thread-session-exit{color:#f7768e;font-size:10px}
.thread-session-prompt{font-size:10px;color:#555;margin-top:4px;font-style:italic;word-break:break-word}
.thread-sessions{border-top:1px solid #0d0d0d}
.thread-msg-link{color:#333;font-size:10px;margin-left:6px;text-decoration:none;flex-shrink:0}
.thread-msg-link:hover{color:#7aa2f7}
.thread-artifacts{display:flex;gap:3px;flex-shrink:0}

/* Card grid (used by skeleton only) */
.card-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(380px,1fr));gap:8px}

/* Card list (main view) */
.card-list{display:flex;flex-direction:column;gap:6px}

/* Cards */
.card{background:#0a0a0a;border:1px solid #1a1a1a;border-radius:4px;padding:12px 14px;cursor:pointer;transition:all 0.15s;position:relative;overflow:hidden}
.card:hover{border-color:#333;background:#0d0d0d}
.card::before{content:'';position:absolute;left:0;top:0;bottom:0;width:3px}
.card.running::before{background:#9ece6a}
.card.error::before{background:#f7768e}
.card.completed::before{background:#444}
.card.resolved{opacity:0.5}
.card.deleted{opacity:0.35}

/* Card layout */
.card-top{display:flex;align-items:center;gap:8px;margin-bottom:6px}
.card-name{font-size:13px;font-weight:600;color:#e0e0e0;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap}
.card-name.editing{background:#111;border:1px solid #7aa2f7;border-radius:2px;padding:2px 6px;outline:none;white-space:normal;font-weight:normal}
.card-status{display:flex;align-items:center;gap:4px;font-size:10px;flex-shrink:0;letter-spacing:0.3px}
.status-dot{width:6px;height:6px;border-radius:50%;flex-shrink:0}
.status-dot.running{background:#9ece6a;box-shadow:0 0 6px #9ece6a80;animation:pulse 2s infinite}
.status-dot.completed{background:#9ece6a}
.status-dot.error{background:#f7768e;box-shadow:0 0 6px #f7768e40}
.status-dot.cancelled,.status-dot.interrupted,.status-dot.unknown{background:#555}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.3}}

/* Card info rows */
.card-info{display:grid;grid-template-columns:1fr 1fr;gap:2px 16px;font-size:11px;margin-top:8px;padding-top:8px;border-top:1px solid #111}
.card-info-item{display:flex;align-items:center;gap:6px;color:#666}
.card-info-item .label{color:#444;min-width:50px}
.card-info-item .value{color:#888}
.card-info-item .value.user-val{color:#bb9af7}
.card-info-item .value.branch-val{color:#7dcfff}
.card-info-item .value.time-val{color:#565f89}

.card-prompt{font-size:11px;color:#444;margin-top:6px;word-break:break-word;font-style:italic}
.card-badges{display:flex;gap:4px;margin-top:6px;flex-wrap:wrap}
.badge{font-size:9px;padding:1px 6px;border-radius:2px;border:1px solid;letter-spacing:0.3px}
.badge-deleted{color:#555;border-color:#222;background:#0d0d0d}
.badge-resolved{color:#9ece6a;border-color:#1a2a1a;background:#0a0d0a}
.badge-channel{color:#e0af68;border-color:#2a2010;background:#0d0d0a}
.badge-profile{color:#7aa2f7;border-color:#1a1a2a;background:#0a0a0d}
.badge-tag{color:#bb9af7;border-color:#1a1a2a;background:#0d0a0d;cursor:pointer}
.badge-tag:hover{border-color:#bb9af7}

/* Card artifacts */
.card-artifacts{display:flex;gap:4px;margin-top:6px;flex-wrap:wrap}
.card-artifact{font-size:10px;padding:2px 8px;border-radius:10px;text-decoration:none;transition:all 0.15s}
.card-artifact:hover{opacity:0.85;text-decoration:none}
.card-artifact.a-pr{color:#9ece6a;border:1px solid #1a2a1a;background:#0a0d0a}
.card-artifact.a-issue{color:#f7768e;border:1px solid #2a1a1a;background:#0d0a0a}
.card-artifact.a-gist{color:#bb9af7;border:1px solid #1a1a2a;background:#0d0a0d}
.card-artifact.a-link{color:#7dcfff;border:1px solid #1a2a2a;background:#0a0d0d}

/* Card reply */
.card-reply{font-size:11px;color:#555;margin-top:6px;padding:6px 8px;background:#050505;border-left:2px solid #1a1a1a;border-radius:0 2px 2px 0;word-break:break-word;max-height:60px;overflow:hidden;line-height:1.4}

/* Kebab menu */
.kebab{color:#333;cursor:pointer;padding:2px 6px;font-size:16px;line-height:1;border-radius:2px;flex-shrink:0}
.kebab:hover{color:#888;background:#111}
.menu{position:absolute;right:8px;top:32px;background:#111;border:1px solid #333;border-radius:3px;z-index:10;min-width:140px;box-shadow:0 4px 16px rgba(0,0,0,0.8)}
.menu-item{padding:6px 12px;font-size:12px;cursor:pointer;color:#aaa;display:block;width:100%;text-align:left;background:none;border:none;font-family:inherit}
.menu-item:hover{background:#1a1a1a;color:#fff}
.menu-item.danger{color:#f7768e}
.menu-item.danger:hover{background:#1a0d0d}

/* Chat bar */
.chat-bar{flex-shrink:0;border-top:1px solid #222;background:#0a0a0a;padding:8px 16px;display:flex;align-items:flex-end;gap:8px}
.chat-bar-prompt{display:flex;align-items:center;gap:6px;flex:1;background:#0d0d0d;border:1px solid #222;border-radius:4px;padding:4px 8px;transition:border-color 0.15s}
.chat-bar-prompt:focus-within{border-color:#7aa2f7}
.chat-bar-prefix{color:#9ece6a;font-size:13px;flex-shrink:0;user-select:none;padding:4px 0}
.chat-bar-input{flex:1;background:transparent;border:none;color:#e0e0e0;font-family:inherit;font-size:13px;line-height:1.5;resize:none;outline:none;min-height:22px;max-height:120px}
.chat-bar-input::placeholder{color:#333}
.chat-bar-controls{display:flex;align-items:center;gap:6px;flex-shrink:0}
.chat-bar-select{background:#111;color:#666;border:1px solid #222;border-radius:3px;padding:3px 6px;font-family:inherit;font-size:10px;cursor:pointer;letter-spacing:0.3px}
.chat-bar-select:focus{outline:none;border-color:#7aa2f7;color:#7aa2f7}
.chat-bar-send{background:#9ece6a;color:#000;border:none;border-radius:3px;padding:5px 14px;font-family:inherit;font-size:12px;font-weight:600;cursor:pointer;transition:opacity 0.15s}
.chat-bar-send:hover{opacity:0.9}
.chat-bar-send:disabled{opacity:0.3;cursor:default}
.chat-bar-error{color:#f7768e;font-size:11px;padding:4px 16px 0;background:#0a0a0a}

/* Empty state */
.empty{text-align:center;color:#333;padding:60px 20px;font-size:13px}
.empty-hint{color:#222;font-size:11px;margin-top:8px}

/* Responsive */
@media(max-width:600px){.card-grid{grid-template-columns:1fr}.skeleton-grid{grid-template-columns:1fr}.header{gap:6px}.card-info{grid-template-columns:1fr}.chat-bar{padding:6px 8px}}
`;

export { DASHBOARD_STYLES };

export function dashboardHTML(): string {
  return appShell({
    title: "ClaudeBox",
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

// Stable color from string hash
function tagColor(s) {
  let h = 0;
  for (let i = 0; i < s.length; i++) h = ((h << 5) - h + s.charCodeAt(i)) | 0;
  const hue = ((h % 360) + 360) % 360;
  return "hsl(" + hue + ",50%,55%)";
}

// ── SkeletonCards ────────────────────────────────────────────

function SkeletonCards({ count }) {
  const cards = [];
  for (let i = 0; i < (count || 6); i++) {
    cards.push(html\`
      <div class="skeleton-card" key=\${i}>
        <div class="skeleton-line w80"></div>
        <div class="skeleton-line w40"></div>
        <div class="skeleton-info">
          <div class="skeleton-line w60"></div>
          <div class="skeleton-line w30"></div>
          <div class="skeleton-line w60"></div>
          <div class="skeleton-line w30"></div>
        </div>
      </div>
    \`);
  }
  return html\`<div class="skeleton-grid">\${cards}</div>\`;
}

// ── WorkspaceCard ────────────────────────────────────────────

function WorkspaceCard({ w, onRefresh, nested }) {
  const [menuOpen, setMenuOpen] = useState(false);
  const [editing, setEditing] = useState(false);
  const nameRef = useRef(null);

  const cls = useMemo(() => {
    let c = "card";
    if (w.status === "running") c += " running";
    else if (w.status === "error") c += " error";
    else if (w.status === "completed") c += " completed";
    if (w.resolved) c += " resolved";
    if (!w.alive) c += " deleted";
    return c;
  }, [w.status, w.resolved, w.alive]);

  const displayName = useMemo(() => {
    return w.name || w.prompt || "Unnamed workspace";
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
      <div class="card-info">
        <div class="card-info-item"><span class="label">user</span><span class="value user-val">\${w.user}</span></div>
        <div class="card-info-item"><span class="label">branch</span><span class="value branch-val">\${w.baseBranch}</span></div>
        <div class="card-info-item"><span class="label">runs</span><span class="value">\${w.runCount}</span></div>
        <div class="card-info-item"><span class="label">time</span><span class="value time-val">\${w.started ? timeAgo(w.started) : "\\u2014"}</span></div>
      </div>
      \${w.name && w.prompt ? html\`
        <div class="card-prompt">\${w.prompt}</div>
      \` : null}
      <div class="card-badges">
        \${!w.alive ? html\`<span class="badge badge-deleted">deleted</span>\` : null}
        \${w.resolved ? html\`<span class="badge badge-resolved">resolved</span>\` : null}
        \${!nested && w.channelName ? html\`<span class="badge badge-channel">#\${w.channelName}</span>\` : null}
        \${!nested && w.origin === "github" ? html\`<span class="badge badge-profile">github</span>\` : null}
        \${w.profile ? html\`<span class="badge badge-profile">\${w.profile}</span>\` : null}
      </div>
      \${w.artifacts && w.artifacts.length > 0 ? html\`
        <div class="card-artifacts">
          \${w.artifacts.map(a => html\`
            <a key=\${a.url} href=\${a.url} target="_blank" class=\${"card-artifact a-" + a.type}
              onClick=\${(e) => e.stopPropagation()}>\${a.text}</a>
          \`)}
        </div>
      \` : null}
      \${w.statusText && !w.lastReply ? html\`
        <div class="card-reply" style="color:#7aa2f7;border-left-color:#1a2a4a">\${w.statusText}</div>
      \` : null}
      \${w.lastReply ? html\`
        <div class="card-reply">\${w.lastReply}</div>
      \` : null}
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

// ── ThreadCard — groups sessions from same Slack thread ──────

function ThreadCard({ thread, onRefresh }) {
  const [expanded, setExpanded] = useState(thread.sessions.some(w => w.status === "running"));
  const [threadMsgs, setThreadMsgs] = useState(null);
  const latest = thread.sessions[0];
  const originCls = "thread-origin " + thread.origin;
  const originLabel = thread.origin === "slack" ? "#" + (latest.channelName || "slack")
    : thread.origin === "github" ? "github" : "http";
  const threadSlackLink = latest.slackChannel && latest.slackThreadTs
    ? "https://" + (window.__slackDomain || "slack") + ".slack.com/archives/" + latest.slackChannel + "/p" + latest.slackThreadTs.replace(".", "")
    : (latest.link && latest.link.indexOf(".slack.com/") !== -1 ? latest.link : null);

  // Collect all artifacts across sessions for collapsed view
  const allArtifacts = useMemo(() => {
    const seen = new Map();
    for (const s of thread.sessions) {
      for (const a of (s.artifacts || [])) {
        if (!seen.has(a.url)) seen.set(a.url, a);
      }
    }
    return [...seen.values()];
  }, [thread.sessions]);

  // Fetch Slack thread context on first expand
  useEffect(() => {
    if (!expanded || threadMsgs !== null) return;
    if (thread.origin !== "slack" || !latest.slackChannel || !latest.slackThreadTs) {
      setThreadMsgs([]);
      return;
    }
    authFetch("/api/thread?channel=" + latest.slackChannel + "&ts=" + latest.slackThreadTs)
      .then(r => r.json())
      .then(d => setThreadMsgs(d.entries || []))
      .catch(() => setThreadMsgs([]));
  }, [expanded]);

  const statusCls = thread.sessions.some(w => w.status === "running") ? "running"
    : latest.status === "error" ? "error" : latest.status || "";

  return html\`
    <div class="thread-card">
      <div class="thread-header" onClick=\${() => setExpanded(p => !p)}>
        <span class="thread-expand">\${expanded ? "\\u25BC" : "\\u25B6"}</span>
        <span class=\${"status-dot " + statusCls}></span>
        <span class=\${originCls}>\${originLabel}</span>
        <span style="font-size:12px;color:#aaa;flex:1;overflow:hidden;text-overflow:ellipsis;white-space:nowrap">
          \${latest.name || latest.prompt.slice(0, 100) || "Unnamed"}
        </span>
        \${allArtifacts.length > 0 ? html\`
          <span class="thread-artifacts" onClick=\${(e) => e.stopPropagation()}>
            \${allArtifacts.map(a => html\`<a key=\${a.url} href=\${a.url} target="_blank" class=\${"card-artifact a-" + a.type}>\${a.text}</a>\`)}
          </span>
        \` : null}
        <span class="thread-meta">\${thread.sessions.length > 1 ? thread.sessions.length + " runs" : ""}</span>
        <span class="thread-meta">\${latest.user}</span>
        <span class="thread-meta">\${timeAgo(latest.started)}</span>
        \${threadSlackLink ? html\`<a class="thread-msg-link" href=\${threadSlackLink} target="_blank" title="View in Slack" onClick=\${(e) => e.stopPropagation()}>\\u2197</a>\` : null}
        \${!threadSlackLink && latest.link ? html\`<a class="thread-msg-link" href=\${latest.link} target="_blank" title="View on GitHub" onClick=\${(e) => e.stopPropagation()}>\\u2197</a>\` : null}
      </div>
      \${!expanded && latest.statusText && !latest.lastReply ? html\`
        <div class="card-reply" style="margin:0;border-radius:0;border-top:none;color:#7aa2f7;border-left-color:#1a2a4a" onClick=\${() => setExpanded(true)}>\${latest.statusText}</div>
      \` : null}
      \${!expanded && latest.lastReply ? html\`
        <div class="card-reply" style="margin:0;border-radius:0;border-top:none" onClick=\${() => setExpanded(true)}>\${latest.lastReply}</div>
      \` : null}
      \${expanded ? html\`
        \${threadMsgs && threadMsgs.length > 0 ? html\`
          <div class="thread-context">
            \${threadMsgs.map((entry, i) => html\`
              <div key=\${i} class=\${"thread-msg" + (entry.type === "bot" ? " bot" : "")}>
                <span class="thread-msg-user">\${entry.user}</span>
                <span class="thread-msg-text">\${entry.text}</span>
                \${entry.slackLink ? html\`<a class="thread-msg-link" href=\${entry.slackLink} target="_blank" title="View in Slack">\\u2197</a>\` : null}
              </div>
              \${entry.session ? html\`
                <div class=\${"thread-session-block ts-" + entry.session.status}>
                  <div class="thread-session-top">
                    <a class="thread-session-link" href=\${"/s/" + (entry.session.logId || entry.session.worktreeId)}>
                      <span class=\${"status-dot " + entry.session.status}></span>
                      run \${entry.session.run}/\${entry.session.totalRuns}
                    </a>
                    \${entry.session.name ? html\`<span class="thread-session-name">\${entry.session.name}</span>\` : null}
                    \${entry.session.exitCode != null && entry.session.exitCode !== 0 ? html\`<span class="thread-session-exit">exit \${entry.session.exitCode}</span>\` : null}
                  </div>
                  \${entry.session.prompt ? html\`<div class="thread-session-prompt">\${entry.session.prompt}</div>\` : null}
                </div>
              \` : null}
            \`)}
          </div>
        \` : threadMsgs === null ? html\`
          <div class="thread-context" style="color:#333;padding:12px 14px">Loading thread...</div>
        \` : null}
        \${threadMsgs !== null && threadMsgs.length === 0 ? html\`
          <div class="thread-sessions">
            \${thread.sessions.map(w => html\`<\${WorkspaceCard} key=\${w.worktreeId} w=\${w} onRefresh=\${onRefresh} nested=\${true} />\`)}
          </div>
        \` : null}
      \` : null}
    </div>
  \`;
}

// ── WorkspaceList — thread-grouped view ──────────────────────

function WorkspaceList({ workspaces, onRefresh }) {
  const { running, threads } = useMemo(() => {
    if (!workspaces) return { running: [], threads: [] };

    // Separate running standalone cards
    const running = workspaces.filter(w => w.status === "running");

    // Group by threadKey (slack threads), or by origin for non-threaded
    const threadMap = new Map();
    for (const w of workspaces) {
      const key = w.threadKey || ("_solo_" + w.worktreeId);
      if (!threadMap.has(key)) threadMap.set(key, { origin: w.origin, sessions: [] });
      threadMap.get(key).sessions.push(w);
    }

    // Convert to array, sort by latest start time
    const threads = [...threadMap.values()]
      .filter(t => t.sessions.length > 0)
      .sort((a, b) => {
        const aRun = a.sessions.some(s => s.status === "running") ? 1 : 0;
        const bRun = b.sessions.some(s => s.status === "running") ? 1 : 0;
        if (aRun !== bRun) return bRun - aRun;
        return (b.sessions[0].started || "").localeCompare(a.sessions[0].started || "");
      });

    return { running, threads };
  }, [workspaces]);

  if (!workspaces || workspaces.length === 0) {
    return html\`
      <div class="empty">
        No sessions found
        <div class="empty-hint">Type a prompt below to start one</div>
      </div>
    \`;
  }

  return html\`
    \${threads.map(t => html\`<\${ThreadCard} key=\${t.sessions[0].threadKey || t.sessions[0].worktreeId} thread=\${t} onRefresh=\${onRefresh} />\`)}
  \`;
}

// ── ChatBar ──────────────────────────────────────────────────

function ChatBar({ identity, users, branches, profiles, activeProfile, onIdentityChange, onSubmit, disabled }) {
  const [prompt, setPrompt] = useState("");
  const [branch, setBranch] = useState("");
  const [profile, setProfile] = useState(activeProfile || "");
  const [error, setError] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const inputRef = useRef(null);

  useEffect(() => {
    if (activeProfile && activeProfile !== "*") setProfile(activeProfile);
  }, [activeProfile]);

  const handleInput = useCallback((e) => {
    setPrompt(e.target.value);
    const el = e.target;
    el.style.height = "auto";
    el.style.height = Math.min(el.scrollHeight, 120) + "px";
  }, []);

  const handleSubmit = useCallback(() => {
    if (!prompt.trim() || submitting) return;
    setSubmitting(true);
    setError("");
    authFetch("/api/sessions", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        prompt: prompt.trim(),
        base_branch: branch || undefined,
        user: identity || undefined,
        profile: profile || undefined,
      })
    })
      .then(r => r.json())
      .then(d => {
        if (d.ok && d.worktree_id) {
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
  }, [prompt, branch, identity, profile, submitting]);

  const handleKeydown = useCallback((e) => {
    if ((e.metaKey || e.ctrlKey) && e.key === "Enter") {
      e.preventDefault();
      handleSubmit();
    }
  }, [handleSubmit]);

  return html\`
    \${error ? html\`<div class="chat-bar-error">\${error}</div>\` : null}
    <div class="chat-bar">
      <div class="chat-bar-prompt">
        <span class="chat-bar-prefix">$</span>
        <textarea ref=\${inputRef}
          class="chat-bar-input"
          rows="1"
          placeholder="Describe a task..."
          value=\${prompt}
          onInput=\${handleInput}
          onKeyDown=\${handleKeydown}
          disabled=\${submitting || disabled}
        ></textarea>
      </div>
      <div class="chat-bar-controls">
        <select class="chat-bar-select" value=\${profile}
          onChange=\${(e) => setProfile(e.target.value)}
          title="Profile">
          <option value="">default</option>
          \${(profiles || []).map(p => html\`<option key=\${p} value=\${p}>\${p}</option>\`)}
        </select>
        <select class="chat-bar-select" value=\${branch}
          onChange=\${(e) => setBranch(e.target.value)}
          title="Branch">
          \${(branches || []).map(b => html\`<option key=\${b} value=\${b}>\${b}</option>\`)}
        </select>
        <select class="chat-bar-select" value=\${identity}
          onChange=\${(e) => onIdentityChange(e.target.value)}
          title="Identity">
          \${(users || []).map(u => html\`<option key=\${u} value=\${u}>\${u}</option>\`)}
        </select>
        <button class="chat-bar-send" onClick=\${handleSubmit}
          disabled=\${!prompt.trim() || submitting || disabled}>
          \${submitting ? "..." : "Run"}
        </button>
      </div>
    </div>
  \`;
}

// ── Header ───────────────────────────────────────────────────

function Header({ activeCount, maxConcurrent }) {
  return html\`
    <div class="header">
      <span class="header-title">CLAUDEBOX</span>
      <span class="header-spacer"></span>
      <span class="capacity"><span class="active-num">\${activeCount}</span>/\${maxConcurrent} active</span>
    </div>
  \`;
}

// ── App ──────────────────────────────────────────────────────

function DashboardApp() {
  const [workspaces, setWorkspaces] = useState(null);
  const [activeCount, setActiveCount] = useState(0);
  const [maxConcurrent, setMaxConcurrent] = useState(0);
  const [users, setUsers] = useState([]);
  const [branches, setBranches] = useState([]);
  const [profiles, setProfiles] = useState([]);
  const [identity, setIdentity] = useState(localStorage.getItem("cb_identity") || "");
  const [activeProfile, setActiveProfile] = useState(localStorage.getItem("cb_profile") || "default");
  const [activeChannel, setActiveChannel] = useState("");
  const [activeOrigin, setActiveOrigin] = useState("");

  const loadDashboard = useCallback((profile) => {
    const p = profile !== undefined ? profile : activeProfile;
    const qs = p ? "?profile=" + encodeURIComponent(p) : "";
    authFetch("/api/dashboard" + qs)
      .then(r => r.json())
      .then(d => {
        setWorkspaces(d.workspaces || []);
        setActiveCount(d.activeCount || 0);
        setMaxConcurrent(d.maxConcurrent || 0);
        if (d.slackDomain) window.__slackDomain = d.slackDomain;
      })
      .catch(() => {});
  }, [activeProfile]);

  const loadUsers = useCallback(() => {
    authFetch("/api/users").then(r => r.json())
      .then(d => {
        const list = d.users || [];
        setUsers(list);
        const stored = localStorage.getItem("cb_identity") || "";
        if (!list.includes(stored) && list.length) {
          setIdentity(list[0]);
          localStorage.setItem("cb_identity", list[0]);
        }
      }).catch(() => {});
  }, []);

  const loadBranches = useCallback(() => {
    authFetch("/api/branches").then(r => r.json())
      .then(d => setBranches(d.branches || [])).catch(() => {});
  }, []);

  const loadProfiles = useCallback(() => {
    authFetch("/api/profiles").then(r => r.json())
      .then(d => setProfiles(d.profiles || [])).catch(() => {});
  }, []);

  useEffect(() => {
    loadDashboard();
    loadUsers();
    loadBranches();
    loadProfiles();
  }, []);

  useEffect(() => {
    setWorkspaces(null);
    loadDashboard(activeProfile);
  }, [activeProfile]);

  useEffect(() => {
    const iv = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      loadDashboard();
    }, 10000);
    return () => clearInterval(iv);
  }, [loadDashboard]);

  const handleIdentityChange = useCallback((v) => {
    setIdentity(v);
    localStorage.setItem("cb_identity", v);
  }, []);

  const handleProfileSelect = useCallback((p) => {
    setActiveProfile(p);
    localStorage.setItem("cb_profile", p);
  }, []);

  const togglePill = useCallback((type, value) => {
    if (type === "channel") {
      setActiveChannel(prev => prev === value ? "" : value);
      setActiveOrigin("");
    } else if (type === "origin") {
      setActiveOrigin(prev => prev === value ? "" : value);
      setActiveChannel("");
    } else if (type === "profile") {
      handleProfileSelect(value);
      setActiveChannel("");
      setActiveOrigin("");
    }
  }, [handleProfileSelect]);

  const loading = workspaces === null;

  // Compute filter counts
  const { channels, origins, profileCounts } = useMemo(() => {
    if (!workspaces) return { channels: [], origins: [], profileCounts: {} };
    const chCounts = {}, oriCounts = {}, profCounts = {};
    for (const w of workspaces) {
      if (w.channelName) chCounts[w.channelName] = (chCounts[w.channelName] || 0) + 1;
      oriCounts[w.origin] = (oriCounts[w.origin] || 0) + 1;
      const p = w.profile || "default";
      profCounts[p] = (profCounts[p] || 0) + 1;
    }
    return {
      channels: Object.entries(chCounts).map(([n, c]) => ({ name: n, count: c })).sort((a, b) => b.count - a.count),
      origins: Object.entries(oriCounts).map(([n, c]) => ({ name: n, count: c })).sort((a, b) => b.count - a.count),
      profileCounts: profCounts,
    };
  }, [workspaces]);

  // Filter workspaces
  const filtered = useMemo(() => {
    if (!workspaces) return workspaces;
    let ws = workspaces;
    if (activeChannel) ws = ws.filter(w => w.channelName === activeChannel);
    if (activeOrigin) ws = ws.filter(w => w.origin === activeOrigin);
    return ws;
  }, [workspaces, activeChannel, activeOrigin]);

  return html\`
    <\${AuthApp}>
      <\${Header} activeCount=\${activeCount} maxConcurrent=\${maxConcurrent} />
      <div class=\${"loading-bar" + (loading ? " active" : "")}></div>
      \${!loading && workspaces && workspaces.length > 0 ? html\`
        <div class="pill-bar">
          <span class="pill-bar-label">profile</span>
          \${(profiles || []).map(p => html\`
            <span key=\${"p-"+p}
              class=\${"pill" + (activeProfile === p ? " active" : "")}
              onClick=\${() => togglePill("profile", p)}>
              \${p}\${profileCounts[p] ? html\`<span class="pill-count">\${profileCounts[p]}</span>\` : null}
            </span>
          \`)}
          <span class=\${"pill" + (activeProfile === "*" ? " active" : "")}
            onClick=\${() => togglePill("profile", "*")}>
            all<span class="pill-count">\${workspaces.length}</span>
          </span>
        </div>
        \${channels.length > 0 ? html\`
          <div class="pill-bar">
            <span class="pill-bar-label">channel</span>
            \${channels.map(ch => html\`
              <span key=\${"c-"+ch.name}
                class=\${"pill channel-pill" + (activeChannel === ch.name ? " active" : "")}
                onClick=\${() => togglePill("channel", ch.name)}>
                #\${ch.name}<span class="pill-count">\${ch.count}</span>
              </span>
            \`)}
          </div>
        \` : null}
        \${origins.length > 1 ? html\`
          <div class="pill-bar">
            <span class="pill-bar-label">origin</span>
            \${origins.map(o => html\`
              <span key=\${"o-"+o.name}
                class=\${"pill" + (activeOrigin === o.name ? " active" : "")}
                onClick=\${() => togglePill("origin", o.name)}>
                \${o.name}<span class="pill-count">\${o.count}</span>
              </span>
            \`)}
          </div>
        \` : null}
      \` : null}
      <div class="main">
        \${loading ? html\`<\${SkeletonCards} count=\${6} />\` : html\`
          <\${WorkspaceList}
            workspaces=\${filtered}
            onRefresh=\${() => loadDashboard()}
          />
        \`}
      </div>
      <\${ChatBar}
        identity=\${identity}
        users=\${users}
        branches=\${branches}
        profiles=\${profiles}
        activeProfile=\${activeProfile}
        onIdentityChange=\${handleIdentityChange}
        onSubmit=\${() => loadDashboard()}
        disabled=\${activeCount >= maxConcurrent}
      />
    </\${AuthApp}>
  \`;
}

render(html\`<\${DashboardApp} />\`, document.getElementById("app"));
`;
