/**
 * Initiative list page — /audit/initiatives
 */

import { appShell } from "../../../packages/libclaudebox/html/app-shell.ts";

const STYLES = `
  .init-grid { display: grid; grid-template-columns: repeat(auto-fill, minmax(340px, 1fr)); gap: 16px; padding: 16px; }
  .init-card { background: #1a1a1a; border: 1px solid #333; border-radius: 8px; padding: 16px; cursor: pointer; transition: border-color 0.2s; }
  .init-card:hover { border-color: #666; }
  .init-name { font-size: 18px; font-weight: 600; color: #fff; margin-bottom: 4px; }
  .init-tag { font-size: 13px; color: #888; font-family: monospace; }
  .init-stats { display: flex; gap: 16px; margin-top: 12px; font-size: 13px; color: #aaa; }
  .init-stat { display: flex; align-items: center; gap: 4px; }
  .init-prompt { font-size: 12px; color: #666; margin-top: 8px; white-space: nowrap; overflow: hidden; text-overflow: ellipsis; }
  .header { display: flex; justify-content: space-between; align-items: center; padding: 16px 16px 0; }
  .header h1 { font-size: 22px; color: #fff; margin: 0; }
  .btn { background: #2563eb; color: #fff; border: none; border-radius: 6px; padding: 8px 16px; cursor: pointer; font-size: 13px; }
  .btn:hover { background: #1d4ed8; }
  .btn-add { font-size: 20px; width: 36px; height: 36px; display: flex; align-items: center; justify-content: center; padding: 0; border-radius: 50%; }
  .modal-overlay { position: fixed; inset: 0; background: rgba(0,0,0,0.7); display: flex; align-items: center; justify-content: center; z-index: 100; }
  .modal { background: #1a1a1a; border: 1px solid #444; border-radius: 12px; padding: 24px; width: 500px; max-width: 90vw; }
  .modal h2 { color: #fff; margin: 0 0 16px; font-size: 18px; }
  .field { margin-bottom: 12px; }
  .field label { display: block; color: #aaa; font-size: 12px; margin-bottom: 4px; }
  .field input, .field textarea { width: 100%; background: #111; border: 1px solid #333; border-radius: 6px; padding: 8px; color: #fff; font-size: 13px; font-family: inherit; box-sizing: border-box; }
  .field textarea { min-height: 80px; resize: vertical; }
  .gist-link { color: #60a5fa; text-decoration: none; font-size: 12px; }
  .gist-link:hover { text-decoration: underline; }
  .back-link { color: #888; text-decoration: none; font-size: 13px; }
  .back-link:hover { color: #fff; }
  .summary-badge { background: #1e3a2f; color: #4ade80; font-size: 11px; padding: 2px 6px; border-radius: 4px; }
`;

const MODULE = `
function App() {
  const [initiatives, setInitiatives] = useState([]);
  const [showCreate, setShowCreate] = useState(false);
  const [loading, setLoading] = useState(true);

  const fetchData = async () => {
    try {
      const res = await authFetch("/api/audit/initiatives");
      if (res.ok) setInitiatives(await res.json());
    } catch {}
    setLoading(false);
  };

  useEffect(() => { fetchData(); const t = setInterval(fetchData, 10000); return () => clearInterval(t); }, []);

  const createInitiative = async (data) => {
    const res = await authFetch("/api/audit/initiatives", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(data),
    });
    if (res.ok) { setShowCreate(false); fetchData(); }
  };

  return html\`
    <\${AuthApp} title="Initiatives">
      <div class="header">
        <div>
          <a class="back-link" href="/audit">← Audit Dashboard</a>
          <h1>Initiatives</h1>
        </div>
        <button class="btn btn-add" onClick=\${() => setShowCreate(true)}>+</button>
      </div>

      \${loading ? html\`<div style="padding:16px;color:#888">Loading...</div>\` : html\`
        <div class="init-grid">
          \${initiatives.map(init => html\`
            <div class="init-card" onClick=\${() => location.href = \\\`/audit/initiatives/\\\${init.tag}\\\`}>
              <div class="init-name">\${init.name}</div>
              <div class="init-tag">\${init.tag}</div>
              <div class="init-prompt">\${init.defaultPrompt.slice(0, 120)}...</div>
              <div class="init-stats">
                <div class="init-stat">\${init.completedSinceLastSummary}/\${init.summaryThreshold} until summary</div>
                \${init.summaryGistUrls.length ? html\`
                  <span class="summary-badge">\${init.summaryGistUrls.length} summaries</span>
                \` : null}
              </div>
            </div>
          \`)}
        </div>
      \`}

      \${showCreate ? html\`<\${CreateModal} onClose=\${() => setShowCreate(false)} onCreate=\${createInitiative} />\` : null}
    </\${AuthApp}>
  \`;
}

function CreateModal({ onClose, onCreate }) {
  const [name, setName] = useState("");
  const [tag, setTag] = useState("");
  const [prompt, setPrompt] = useState("");

  const submit = (e) => {
    e.preventDefault();
    if (!name || !tag || !prompt) return;
    onCreate({ name, tag, defaultPrompt: prompt });
  };

  return html\`
    <div class="modal-overlay" onClick=\${(e) => e.target === e.currentTarget && onClose()}>
      <div class="modal">
        <h2>New Initiative</h2>
        <form onSubmit=\${submit}>
          <div class="field">
            <label>Name</label>
            <input value=\${name} onInput=\${e => setName(e.target.value)} placeholder="experiment-gamma" />
          </div>
          <div class="field">
            <label>Tag (for session grouping)</label>
            <input value=\${tag} onInput=\${e => setTag(e.target.value)} placeholder="experiment-gamma" />
          </div>
          <div class="field">
            <label>Default Prompt</label>
            <textarea value=\${prompt} onInput=\${e => setPrompt(e.target.value)} placeholder="The prompt sent to each worker..." />
          </div>
          <div style="display:flex;gap:8px;justify-content:flex-end">
            <button type="button" class="btn" style="background:#333" onClick=\${onClose}>Cancel</button>
            <button type="submit" class="btn">Create</button>
          </div>
        </form>
      </div>
    </div>
  \`;
}

render(html\`<\${App}/>\`, document.getElementById("app"));
`;

export function initiativesListHTML(): string {
  return appShell({
    title: "Audit Initiatives",
    styles: STYLES,
    moduleScript: MODULE,
  });
}
