import { appShell } from "./app-shell.ts";

const TAGGED_STYLES = `
*{box-sizing:border-box;margin:0;padding:0}
body{background:#0a0a0a;color:#ccc;font-family:'SF Mono',Monaco,'Cascadia Code',monospace;font-size:13px;line-height:1.5;height:100vh;display:flex;flex-direction:column}
a{color:#7aa2f7;text-decoration:none}a:hover{text-decoration:underline}
::-webkit-scrollbar{width:5px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:#333;border-radius:3px}

/* Header */
.header{padding:10px 16px;border-bottom:1px solid #1a1a1a;display:flex;align-items:center;gap:12px;flex-shrink:0;background:#0d0d0d;flex-wrap:wrap}
.header-title{font-weight:bold;color:#d876e3;font-size:15px}
.header-spacer{flex:1}
.header-link{color:#666;font-size:12px}
.header-link:hover{color:#ccc}

/* Search */
.search-input{background:#111;color:#ccc;border:1px solid #333;border-radius:4px;padding:5px 10px;font-family:inherit;font-size:12px;width:200px}
.search-input:focus{outline:none;border-color:#d876e3}

/* Main content */
.main{flex:1;overflow-y:auto;padding:16px}

/* Stats bar */
.stats-bar{display:flex;gap:16px;margin-bottom:16px;flex-wrap:wrap;font-size:12px;color:#666}
.stat{background:#111;border:1px solid #222;border-radius:4px;padding:6px 12px}
.stat .num{color:#d876e3;font-weight:bold;font-size:16px;margin-right:4px}

/* Tag section */
.tag-section{margin-bottom:28px}
.tag-header{font-size:14px;font-weight:bold;padding:10px 0 8px;border-bottom:1px solid #1a1a1a;margin-bottom:10px;display:flex;align-items:center;gap:10px}
.tag-header .tag-name{padding:2px 10px;border-radius:4px;font-size:13px}
.tag-header .count{color:#666;font-weight:normal;font-size:11px}

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

/* Grid */
.tag-grid{display:grid;grid-template-columns:repeat(auto-fill,minmax(380px,1fr));gap:10px}

/* Empty state */
.empty{text-align:center;color:#444;padding:40px 20px;font-size:13px}

@media(max-width:480px){.tag-grid{grid-template-columns:1fr}}
`;

export function taggedDashboardHTML(): string {
  return appShell({
    title: "Sessions by Tag - ClaudeBox",
    styles: TAGGED_STYLES,
    moduleScript: TAGGED_MODULE,
  });
}

const TAGGED_MODULE = `
const {h,render,html,useState,useEffect,useCallback,useMemo,AuthApp,authFetch} = window.__preact;

const TAG_PALETTE = ["#FAD979","#7aa2f7","#61D668","#d876e3","#E94560","#aaa","#c0a0ff","#80cbc4","#ff8a65","#a5d6a7"];

function tagColor(tag, categories) {
  if (tag === "untagged") return "#555";
  const idx = categories.indexOf(tag);
  if (idx >= 0) return TAG_PALETTE[idx % TAG_PALETTE.length];
  return "#666";
}

function timeAgo(iso) {
  if (!iso) return "\\u2014";
  const ms = Date.now() - new Date(iso).getTime();
  if (ms < 60000) return "just now";
  if (ms < 3600000) return Math.floor(ms / 60000) + "m ago";
  if (ms < 86400000) return Math.floor(ms / 3600000) + "h ago";
  return Math.floor(ms / 86400000) + "d ago";
}

function WorkspaceCard({ w }) {
  const cls = useMemo(() => {
    let c = "ws-card";
    if (w.status === "running") c += " running";
    if (w.status === "error") c += " error";
    return c;
  }, [w.status]);

  const displayName = useMemo(() => {
    const n = w.name || w.prompt || "Unnamed";
    return n.length > 80 ? n.slice(0, 80) + "\\u2026" : n;
  }, [w.name, w.prompt]);

  const exitStr = w.exitCode != null ? " (" + w.exitCode + ")" : "";

  const handleClick = useCallback((e) => {
    if (e.target.closest("a")) return;
    location.href = "/s/" + w.worktreeId;
  }, [w.worktreeId]);

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
        \${w.user ? html\`<span>\${w.user}</span>\` : null}
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
    </div>
  \`;
}

function StatsBar({ data }) {
  if (!data || !data.length) return null;
  const total = data.length;
  const running = data.filter(w => w.status === "running").length;
  const completed = data.filter(w => w.status === "completed").length;
  const errors = data.filter(w => w.status === "error").length;

  return html\`
    <div class="stats-bar">
      <div class="stat"><span class="num">\${total}</span>sessions</div>
      <div class="stat"><span class="num" style="color:#61D668">\${running}</span>running</div>
      <div class="stat"><span class="num" style="color:#61D668">\${completed}</span>completed</div>
      \${errors ? html\`<div class="stat"><span class="num" style="color:#E94560">\${errors}</span>errors</div>\` : null}
    </div>
  \`;
}

function TagSection({ tag, workspaces, searchTerm, categories }) {
  const filtered = useMemo(() => {
    if (!searchTerm) return workspaces;
    const s = searchTerm.toLowerCase();
    return workspaces.filter(w => {
      const haystack = ((w.prompt || "") + " " + (w.name || "") + " " + (w.user || "") + " " + (w.channelName || "") + " " + (w.latestResponse || "")).toLowerCase();
      return haystack.indexOf(s) !== -1;
    });
  }, [workspaces, searchTerm]);

  if (!filtered.length) return null;

  const color = tagColor(tag, categories);

  return html\`
    <div class="tag-section">
      <div class="tag-header" style=\${"border-bottom-color:" + color + "33"}>
        <span style=\${"color:" + color}>\${tag}</span>
        <span class="count">(\${filtered.length} session\${filtered.length !== 1 ? "s" : ""})</span>
      </div>
      <div class="tag-grid">
        \${filtered.map(w => html\`<\${WorkspaceCard} key=\${w.worktreeId} w=\${w} />\`)}
      </div>
    </div>
  \`;
}

function TaggedApp() {
  const [rawData, setRawData] = useState(null);
  const [categories, setCategories] = useState([]);
  const [searchTerm, setSearchTerm] = useState("");

  const loadSessions = useCallback(() => {
    authFetch("/api/me/sessions")
      .then(r => r.json())
      .then(d => setRawData(d))
      .catch(() => {});
  }, []);

  useEffect(() => {
    loadSessions();
    authFetch("/api/tag-categories")
      .then(r => r.json())
      .then(d => setCategories(d.categories || []))
      .catch(() => {});
  }, [loadSessions]);

  useEffect(() => {
    const iv = setInterval(() => {
      if (document.visibilityState !== "visible") return;
      loadSessions();
    }, 15000);
    return () => clearInterval(iv);
  }, [loadSessions]);

  // Group by tag
  const tagGroups = useMemo(() => {
    if (!rawData || !rawData.flat) return [];
    const groups = new Map();
    // Initialize known categories
    for (const cat of categories) groups.set(cat, []);
    groups.set("untagged", []);

    for (const w of rawData.flat) {
      const tags = w.tags && w.tags.length ? w.tags : ["untagged"];
      for (const t of tags) {
        if (!groups.has(t)) groups.set(t, []);
        groups.get(t).push(w);
      }
    }

    // Return in category order, skip empty
    const result = [];
    for (const cat of [...categories, "untagged"]) {
      const ws = groups.get(cat);
      if (ws && ws.length) result.push({ tag: cat, workspaces: ws });
    }
    // Add any extra tags not in the fixed list
    for (const [tag, ws] of groups) {
      if (!categories.includes(tag) && tag !== "untagged" && ws.length) {
        result.push({ tag, workspaces: ws });
      }
    }
    return result;
  }, [rawData, categories]);

  const timerRef = window.__preact.useRef(null);
  const handleSearch = useCallback((e) => {
    const val = e.target.value;
    clearTimeout(timerRef.current);
    timerRef.current = setTimeout(() => setSearchTerm(val.trim()), 200);
  }, []);

  return html\`
    <\${AuthApp}>
      <div class="header">
        <span class="header-title">SESSIONS BY TAG</span>
        <a href="/me" class="header-link">\\u2190 My Sessions</a>
        <a href="/dashboard" class="header-link">Dashboard</a>
        <span class="header-spacer"></span>
        <input class="search-input" type="text" placeholder="Search sessions..." onInput=\${handleSearch} />
      </div>
      <div class="main">
        \${rawData ? html\`
          <\${StatsBar} data=\${rawData.flat} />
          \${tagGroups.length
            ? tagGroups.map(g => html\`<\${TagSection} key=\${g.tag} tag=\${g.tag} workspaces=\${g.workspaces} searchTerm=\${searchTerm} categories=\${categories} />\`)
            : html\`<div class="empty">No sessions found.</div>\`
          }
        \` : html\`<div class="empty">Loading...</div>\`}
      </div>
    </\${AuthApp}>
  \`;
}

render(html\`<\${TaggedApp} />\`, document.getElementById("app"));
`;
