/**
 * Initiative detail page — /audit/initiatives/:tag
 */

import { appShell } from "../../../packages/libclaudebox/html/app-shell.ts";
import { esc } from "../../../packages/libclaudebox/html/shared.ts";

const STYLES = `
  .detail-header { padding: 16px; border-bottom: 1px solid #333; }
  .detail-header h1 { font-size: 22px; color: #fff; margin: 0 0 4px; }
  .detail-tag { font-family: monospace; color: #888; font-size: 13px; }
  .back-link { color: #888; text-decoration: none; font-size: 13px; }
  .back-link:hover { color: #fff; }

  .prompt-section { padding: 16px; border-bottom: 1px solid #333; }
  .prompt-label { color: #aaa; font-size: 12px; margin-bottom: 4px; }
  .prompt-text { background: #111; border: 1px solid #333; border-radius: 6px; padding: 12px; color: #ccc; font-size: 13px; white-space: pre-wrap; max-height: 200px; overflow-y: auto; }
  .prompt-edit { width: 100%; background: #111; border: 1px solid #333; border-radius: 6px; padding: 12px; color: #ccc; font-size: 13px; font-family: inherit; min-height: 100px; resize: vertical; box-sizing: border-box; }

  .actions-bar { display: flex; gap: 8px; padding: 16px; border-bottom: 1px solid #333; align-items: center; }
  .btn { background: #2563eb; color: #fff; border: none; border-radius: 6px; padding: 8px 16px; cursor: pointer; font-size: 13px; }
  .btn:hover { background: #1d4ed8; }
  .btn-green { background: #16a34a; }
  .btn-green:hover { background: #15803d; }
  .btn-sm { padding: 4px 10px; font-size: 12px; }
  .btn-outline { background: transparent; border: 1px solid #444; color: #aaa; }
  .btn-outline:hover { border-color: #666; color: #fff; }

  .one-off-input { flex: 1; background: #111; border: 1px solid #333; border-radius: 6px; padding: 8px 12px; color: #fff; font-size: 13px; }

  .section { padding: 16px; }
  .section-title { font-size: 14px; color: #888; margin-bottom: 8px; font-weight: 600; text-transform: uppercase; letter-spacing: 0.05em; }

  .session-card { background: #1a1a1a; border: 1px solid #333; border-radius: 6px; padding: 10px 12px; margin-bottom: 6px; display: flex; align-items: center; gap: 10px; }
  .session-card:hover { border-color: #555; }
  .status-dot { width: 8px; height: 8px; border-radius: 50%; flex-shrink: 0; }
  .status-dot.running { background: #4ade80; animation: pulse 2s infinite; }
  .status-dot.completed { background: #666; }
  .status-dot.error { background: #ef4444; }
  @keyframes pulse { 0%,100% { opacity: 1; } 50% { opacity: 0.4; } }
  .session-prompt { flex: 1; font-size: 12px; color: #aaa; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .session-id { font-family: monospace; font-size: 11px; color: #666; }
  .session-link { color: #60a5fa; text-decoration: none; font-size: 12px; }
  .session-link:hover { text-decoration: underline; }

  .queue-card { background: #1a1a2a; border: 1px solid #334; border-left: 3px solid #6366f1; border-radius: 6px; padding: 8px 12px; margin-bottom: 4px; margin-left: 24px; }
  .queue-prompt { font-size: 12px; color: #a5b4fc; }
  .queue-meta { font-size: 11px; color: #666; margin-top: 2px; }

  .gist-section { padding: 16px; }
  .gist-link { color: #60a5fa; text-decoration: none; font-size: 13px; display: block; margin-bottom: 4px; }
  .gist-link:hover { text-decoration: underline; }

  .stats-bar { display: flex; gap: 20px; padding: 0 16px 12px; font-size: 13px; color: #aaa; }
  .stat-item { display: flex; align-items: center; gap: 4px; }
  .stat-value { color: #fff; font-weight: 600; }
`;

const MODULE = `
function App() {
  const tag = window.__DATA__?.tag || "";
  const [initiative, setInitiative] = useState(null);
  const [sessions, setSessions] = useState([]);
  const [editing, setEditing] = useState(false);
  const [editPrompt, setEditPrompt] = useState("");
  const [oneOff, setOneOff] = useState("");
  const [loading, setLoading] = useState(true);

  const fetchData = async () => {
    try {
      const [initRes, sessRes] = await Promise.all([
        authFetch("/api/audit/initiatives"),
        authFetch("/api/dashboard?profile=barretenberg-audit"),
      ]);
      if (initRes.ok) {
        const inits = await initRes.json();
        const found = inits.find(i => i.tag === tag);
        if (found) { setInitiative(found); setEditPrompt(found.defaultPrompt); }
      }
      if (sessRes.ok) {
        const all = await sessRes.json();
        // Filter sessions by tag
        setSessions(all.filter(s => s.tags && s.tags.includes(tag)));
      }
    } catch {}
    setLoading(false);
  };

  useEffect(() => { fetchData(); const t = setInterval(fetchData, 10000); return () => clearInterval(t); }, []);

  const addWorker = async () => {
    if (!initiative) return;
    await authFetch(\\\`/api/audit/initiatives/\\\${initiative.id}/worker\\\`, { method: "POST", headers: { "Content-Type": "application/json" }, body: "{}" });
    fetchData();
  };

  const sendOneOff = async () => {
    if (!initiative || !oneOff.trim()) return;
    await authFetch(\\\`/api/audit/initiatives/\\\${initiative.id}/prompt\\\`, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ prompt: oneOff }),
    });
    setOneOff("");
    fetchData();
  };

  const savePrompt = async () => {
    if (!initiative) return;
    await authFetch(\\\`/api/audit/initiatives/\\\${initiative.id}\\\`, {
      method: "PUT",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({ defaultPrompt: editPrompt }),
    });
    setEditing(false);
    fetchData();
  };

  const running = sessions.filter(s => s.alive);
  const completed = sessions.filter(s => !s.alive);

  if (loading) return html\`<div style="padding:16px;color:#888">Loading...</div>\`;
  if (!initiative) return html\`<div style="padding:16px;color:#888">Initiative not found for tag: \${tag}</div>\`;

  return html\`
    <\${AuthApp} title=\${"Initiative: " + initiative.name}>
      <div class="detail-header">
        <a class="back-link" href="/audit/initiatives">← Initiatives</a>
        <h1>\${initiative.name}</h1>
        <div class="detail-tag">\${initiative.tag}</div>
      </div>

      <div class="stats-bar">
        <div class="stat-item"><span class="stat-value">\${running.length}</span> running</div>
        <div class="stat-item"><span class="stat-value">\${completed.length}</span> completed</div>
        <div class="stat-item"><span class="stat-value">\${initiative.completedSinceLastSummary}/\${initiative.summaryThreshold}</span> until summary</div>
        <div class="stat-item"><span class="stat-value">\${initiative.summaryGistUrls.length}</span> summaries</div>
      </div>

      <div class="prompt-section">
        <div class="prompt-label">Default Prompt \${!editing ? html\`<button class="btn btn-sm btn-outline" onClick=\${() => setEditing(true)}>Edit</button>\` : null}</div>
        \${editing ? html\`
          <textarea class="prompt-edit" value=\${editPrompt} onInput=\${e => setEditPrompt(e.target.value)} />
          <div style="display:flex;gap:8px;margin-top:8px">
            <button class="btn btn-sm" onClick=\${savePrompt}>Save</button>
            <button class="btn btn-sm btn-outline" onClick=\${() => { setEditing(false); setEditPrompt(initiative.defaultPrompt); }}>Cancel</button>
          </div>
        \` : html\`<div class="prompt-text">\${initiative.defaultPrompt}</div>\`}
      </div>

      <div class="actions-bar">
        <button class="btn btn-green" onClick=\${addWorker}>+ Add Worker</button>
        <input class="one-off-input" placeholder="One-off prompt..." value=\${oneOff} onInput=\${e => setOneOff(e.target.value)} onKeyDown=\${e => e.key === "Enter" && sendOneOff()} />
        <button class="btn" onClick=\${sendOneOff} disabled=\${!oneOff.trim()}>Send</button>
      </div>

      \${running.length ? html\`
        <div class="section">
          <div class="section-title">Running (\${running.length})</div>
          \${running.map(s => html\`
            <a href=\${\\\`/s/\\\${s.worktreeId}\\\`} class="session-card" style="text-decoration:none">
              <div class="status-dot running"></div>
              <div class="session-id">\${s.worktreeId?.slice(0, 8)}</div>
              <div class="session-prompt">\${s.prompt || s.statusText || "..."}</div>
            </a>
          \`)}
        </div>
      \` : null}

      \${completed.length ? html\`
        <div class="section">
          <div class="section-title">Completed (\${completed.length})</div>
          \${completed.slice(0, 50).map(s => html\`
            <a href=\${\\\`/s/\\\${s.worktreeId}\\\`} class="session-card" style="text-decoration:none">
              <div class="status-dot \${s.status === 'error' ? 'error' : 'completed'}"></div>
              <div class="session-id">\${s.worktreeId?.slice(0, 8)}</div>
              <div class="session-prompt">\${s.prompt || s.statusText || "..."}</div>
              <div style="font-size:11px;color:#666">\${s.status} (exit \${s.exitCode ?? "?"})</div>
            </a>
          \`)}
        </div>
      \` : null}

      \${initiative.summaryGistUrls.length ? html\`
        <div class="gist-section">
          <div class="section-title">Summary Gists</div>
          \${initiative.summaryGistUrls.map(url => html\`
            <a class="gist-link" href=\${url} target="_blank">\${url}</a>
          \`)}
        </div>
      \` : null}
    </\${AuthApp}>
  \`;
}

render(html\\\`<\\\${App}/>\\\`, document.getElementById("app"));
`;

export function initiativeDetailHTML(tag: string): string {
  return appShell({
    title: `Initiative: ${esc(tag)}`,
    styles: STYLES,
    moduleScript: MODULE,
    pageData: { tag },
  });
}
