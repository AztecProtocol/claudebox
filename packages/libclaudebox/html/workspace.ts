import type { SessionMeta } from "../types.ts";
import { esc, safeHref, timeAgo, statusColor, linkify, renderActivityEntry, BASE_STYLES, type ActivityEntry, type WorkspacePageData } from "./shared.ts";
import { appShell } from "./app-shell.ts";

// CSS specific to workspace page
const WORKSPACE_STYLES = `
*{box-sizing:border-box;margin:0;padding:0}
#app{height:100vh;display:flex;flex-direction:column;font-family:'Inter',system-ui,-apple-system,sans-serif;font-size:14px;line-height:1.6;color:#d4d4d4}
code,.mono{font-family:'SF Mono',Monaco,'Cascadia Code',monospace;font-size:0.85em}
a{color:inherit;text-decoration:none}a:hover{text-decoration:underline}
.link{color:#7ab8ff;text-decoration:underline;text-decoration-color:rgba(122,184,255,0.3)}
.link:hover{text-decoration-color:#7ab8ff}
.dim{color:#666}
::-webkit-scrollbar{width:5px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:#333;border-radius:3px}

/* Header */
.header{padding:10px 20px;border-bottom:1px solid #1a1a1a;display:flex;align-items:center;gap:12px;flex-shrink:0;background:#0d0d0d}
.header-title{font-weight:600;color:#5FA7F1;font-size:15px;letter-spacing:-0.3px}
.header-id{color:#FAD979;font-size:12px;font-family:'SF Mono',monospace}
.header-status{font-size:11px;padding:2px 8px;border-radius:10px;font-weight:500;letter-spacing:0.2px}

/* Status colors */
.status-running,.header-status.running{color:#61D668;background:rgba(97,214,104,0.1);border:1px solid rgba(97,214,104,0.2)}
.status-completed,.header-status.completed{color:#61D668;background:rgba(97,214,104,0.1);border:1px solid rgba(97,214,104,0.2)}
.status-error,.header-status.error{color:#E94560;background:rgba(233,69,96,0.1);border:1px solid rgba(233,69,96,0.2)}
.status-cancelled,.status-interrupted,.status-unknown,.header-status.cancelled,.header-status.interrupted,.header-status.unknown{color:#888;background:rgba(136,136,136,0.1);border:1px solid rgba(136,136,136,0.2)}

/* Layout */
.layout{display:flex;flex:1;overflow:hidden}
.sidebar{width:240px;border-right:1px solid #1a1a1a;display:flex;flex-direction:column;flex-shrink:0;background:#0d0d0d;overflow-y:auto;transition:width 0.2s,padding 0.2s}
.sidebar.collapsed{width:36px;overflow:hidden;cursor:pointer}
.sidebar.collapsed .sidebar-section{display:none}
.sidebar-tab{height:100%;display:flex;align-items:center;justify-content:center;writing-mode:vertical-rl;text-orientation:mixed;font-size:11px;color:#555;letter-spacing:1px;text-transform:uppercase;cursor:pointer;user-select:none;padding:12px 0}
.sidebar-tab:hover{color:#888}
.sidebar.collapsed .sidebar-tab{display:flex}
.sidebar:not(.collapsed) .sidebar-tab{display:none}
.sidebar-collapse{position:absolute;top:8px;right:8px;background:none;border:none;color:#444;font-size:16px;cursor:pointer;padding:2px 6px;border-radius:4px;z-index:1}
.sidebar-collapse:hover{color:#888;background:rgba(255,255,255,0.05)}
.sidebar-section{padding:12px 14px;border-bottom:1px solid #1a1a1a}
.sidebar-label{font-size:10px;text-transform:uppercase;letter-spacing:0.8px;color:#555;margin-bottom:8px;font-weight:600}
.stat-row{font-size:13px;padding:3px 0;display:flex;gap:8px}
.stat-row .dim{min-width:55px;font-size:12px}
.artifact-row{font-size:12px;padding:4px 0;border-bottom:1px solid #111;word-break:break-all;line-height:1.5}

/* Session history */
.session-entry{font-size:12px;padding:8px 10px;margin:3px 0;display:flex;gap:6px;align-items:center;background:#0d0d12;border:1px solid #1a1a2a;border-radius:4px;position:relative;overflow:hidden;cursor:pointer;transition:border-color 0.15s}
.session-entry:hover{border-color:#333}
.session-entry::before{content:'';position:absolute;left:0;top:0;bottom:0;width:2px}
.session-entry.se-running::before{background:#61D668}
.session-entry.se-error::before{background:#E94560}
.session-entry.se-completed::before{background:#444}
.session-entry a{color:#7ab8ff}
.session-entry .se-dot{width:6px;height:6px;border-radius:50%;flex-shrink:0}
.session-entry .se-dot.running{background:#61D668;animation:pulse 2s infinite}
.session-entry .se-dot.completed{background:#61D668}
.session-entry .se-dot.error{background:#E94560}
.session-entry .se-dot.cancelled,.session-entry .se-dot.interrupted,.session-entry .se-dot.unknown{background:#555}
.session-entry.se-selected{border-color:#5FA7F1;background:rgba(95,167,241,0.06)}
.session-entry .se-label{color:#5FA7F1;font-weight:600}
.session-entry .se-exit{color:#E94560;font-size:11px}

/* Chat */
.chat-area{flex:1;overflow-y:auto;padding:12px 20px;display:flex;flex-direction:column;gap:6px;min-height:0}
.chat-empty{flex:1;display:flex;align-items:center;justify-content:center;color:#333;font-size:14px}

/* Flat activity rows (detail view) */
.act-row{display:flex;align-items:center;gap:6px;font-size:12px;color:#666;padding:3px 0;font-family:'SF Mono',monospace}
.act-ts{color:#444;font-size:10px;margin-left:auto;flex-shrink:0}
.act-icon{font-size:10px;flex-shrink:0;width:14px;text-align:center}
.act-row.act-artifact{color:#FAD979}
.act-row.act-agent{color:#a78bfa}
.agent-dot-inline{width:6px;height:6px;border-radius:50%;background:#a78bfa;display:inline-block;animation:pulse 2s infinite}
.tool-name{color:#FAD979;font-weight:500}
.tool-args{color:#888}
.tool-bash{color:#61D668}
.tool-desc{color:#666;font-style:italic}
.act-result{background:rgba(255,255,255,0.02);border-left:2px solid #222;margin:2px 0 2px 18px;padding:4px 10px;font-size:12px;color:#666;font-family:'SF Mono',monospace;line-height:1.5;white-space:pre-wrap;word-break:break-all;max-height:80px;overflow:hidden}
.artifact-chips{display:flex;gap:6px;flex-wrap:wrap;padding:4px 20px 8px}
.artifact-chip{font-size:12px;padding:2px 8px;border-radius:4px;background:rgba(250,217,121,0.06);border:1px solid rgba(250,217,121,0.15)}
.artifact-chip-update{background:rgba(95,167,241,0.08);border-color:rgba(95,167,241,0.2)}
.artifact-chip-update .artifact-link{color:#7ab8ff}
.artifact-link{color:#FAD979;text-decoration:underline;text-decoration-color:rgba(250,217,121,0.3)}
.artifact-link:hover{text-decoration-color:#FAD979}

/* Activity cards (prompt, response, context) */
.act-card{border:1px solid #1a1a1a;border-radius:8px;padding:12px 16px;margin:8px 0;line-height:1.6;word-break:break-word;white-space:pre-wrap}
.act-card-head{display:flex;align-items:center;gap:8px;margin-bottom:8px}
.act-badge{font-size:10px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;padding:2px 8px;border-radius:4px;flex-shrink:0}
.act-badge-prompt{color:#61D668;background:rgba(97,214,104,0.08);border:1px solid rgba(97,214,104,0.15)}
.act-badge-reply{color:#5FA7F1;background:rgba(95,167,241,0.08);border:1px solid rgba(95,167,241,0.15)}
.act-badge-ctx{color:#888;background:rgba(136,136,136,0.08);border:1px solid rgba(136,136,136,0.15)}
.act-card.act-prompt{background:#080e08;border-color:#1a331a}
.act-card.act-response{background:#080e1a;border-color:#1a3060;border-left:3px solid rgba(95,167,241,0.3)}
.act-card.act-context{background:#0a0a0a;border-color:#1a1a1a;color:#999;font-size:13px}
.act-prompt-text{color:#ccc}
.act-slack-link{color:#555;font-size:11px;text-decoration:none}
.act-slack-link:hover{color:#7ab8ff;text-decoration:underline}

/* Run cards (list view) */
.run-card{border:1px solid #1a1a1a;border-radius:8px;margin:8px 0;cursor:pointer;transition:border-color 0.2s,box-shadow 0.2s}
.run-card:hover{border-color:#333;box-shadow:0 0 12px rgba(255,255,255,0.02)}
.run-card-selected{border-color:#5FA7F1;cursor:pointer;background:rgba(95,167,241,0.06) !important}
.run-card-selected .run-header::after{content:'click to open \\2192';color:#5FA7F1;font-size:22px;margin-left:auto;font-weight:600}
.run-header{padding:12px 20px;display:flex;align-items:center;gap:10px;font-size:13px;color:#888;user-select:none}

/* Run detail view */
.run-detail{display:flex;flex-direction:column;height:100%;min-height:0}
.run-detail-header{padding:10px 20px;display:flex;align-items:center;gap:10px;font-size:13px;color:#888;border-bottom:1px solid #1a1a1a;flex-shrink:0;background:#0a0a0a}
.run-detail-body{flex:1;overflow-y:auto;padding:12px 20px;min-height:0}
.run-back-btn{padding:4px 12px;font-size:12px;border-radius:6px;margin-right:6px}
.run-dot{width:7px;height:7px;border-radius:50%;flex-shrink:0}
.run-dot.running{background:#61D668;box-shadow:0 0 6px rgba(97,214,104,0.5);animation:pulse 2s infinite}
.run-dot.completed{background:#61D668}
.run-dot.error{background:#E94560;box-shadow:0 0 6px rgba(233,69,96,0.4)}
.run-dot.cancelled,.run-dot.interrupted,.run-dot.unknown{background:#555}
.run-label{font-weight:600;color:#ccc;white-space:nowrap}
.run-status{color:#666;font-size:12px}
.run-exit{color:#E94560;font-size:12px}
.run-time{color:#444;margin-left:auto;font-size:11px;flex-shrink:0}
.run-summary{padding:8px 20px 16px;font-size:14px;line-height:1.6;cursor:pointer}
.run-summary-prompt{color:#ccc;word-break:break-word;white-space:pre-wrap;display:flex;gap:10px}
.run-summary-prompt .prompt-label{color:#61D668;background:rgba(97,214,104,0.08);border:1px solid rgba(97,214,104,0.15);padding:1px 8px;border-radius:4px;font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:0.5px;flex-shrink:0;height:fit-content;line-height:1.8}
.run-summary-prompt .prompt-text{flex:1;min-width:0}
.run-summary-reply{color:#aaa;margin-top:12px;word-break:break-word;white-space:pre-wrap;padding-left:14px;border-left:2px solid rgba(95,167,241,0.3);display:flex;gap:10px}
.run-summary-reply .reply-label{color:#5FA7F1;background:rgba(95,167,241,0.08);border:1px solid rgba(95,167,241,0.15);padding:1px 8px;border-radius:4px;font-weight:600;font-size:10px;text-transform:uppercase;letter-spacing:0.5px;flex-shrink:0;height:fit-content;line-height:1.8}
.run-summary-reply .reply-text{flex:1;min-width:0}
.run-summary-empty{color:#333;font-style:italic;margin-top:8px;font-size:13px}
/* Markdown in replies */
.md-content h1,.md-content h2,.md-content h3{color:#ddd;margin:12px 0 6px;font-size:inherit}
.md-content h1{font-size:1.15em}.md-content h2{font-size:1.08em}.md-content h3{font-size:1em}
.md-content strong{color:#ddd;font-weight:600}
.md-content em{font-style:italic;color:#bbb}
.md-content code{background:rgba(255,255,255,0.06);border:1px solid rgba(255,255,255,0.08);padding:1px 5px;border-radius:3px;font-family:'SF Mono',Monaco,'Cascadia Code',monospace;font-size:0.88em;color:#e0c46c}
.md-content pre{background:rgba(255,255,255,0.04);border:1px solid rgba(255,255,255,0.08);border-radius:6px;padding:10px 14px;margin:8px 0;overflow-x:auto;line-height:1.5}
.md-content pre code{background:none;border:none;padding:0;color:#ccc;font-size:0.88em}
.md-content ul,.md-content ol{padding-left:20px;margin:4px 0}
.md-content li{margin:2px 0}
.md-content blockquote{border-left:2px solid #333;padding-left:12px;color:#999;margin:6px 0}
.md-content hr{border:none;border-top:1px solid #222;margin:10px 0}
.md-content p{margin:4px 0}
.md-table{border-collapse:collapse;margin:8px 0;font-size:0.92em;width:auto}
.md-table th,.md-table td{border:1px solid #333;padding:4px 10px;text-align:left}
.md-table th{background:rgba(255,255,255,0.04);color:#ddd;font-weight:600}
.md-table td{color:#bbb}

/* Typing indicator */
.typing{display:flex;align-items:center;gap:8px;padding:6px 14px 6px 42px}
.typing-dots{display:flex;gap:3px}
.typing-dots span{width:5px;height:5px;border-radius:50%;background:#5FA7F1;animation:typing 1.4s infinite}
.typing-dots span:nth-child(2){animation-delay:0.2s}
.typing-dots span:nth-child(3){animation-delay:0.4s}
@keyframes typing{0%,60%,100%{opacity:0.2;transform:scale(0.8)}30%{opacity:1;transform:scale(1)}}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.3}}
@keyframes slideIn{from{opacity:0;transform:translateX(30px)}to{opacity:1;transform:translateX(0)}}
@keyframes slideOut{from{opacity:0;transform:translateX(-30px)}to{opacity:1;transform:translateX(0)}}
.run-detail{animation:slideIn 0.25s ease}
.chat-area-list{animation:slideOut 0.2s ease}
.typing-label{font-size:12px;color:#555}

/* Queued messages */
.queued-msg{display:flex;gap:10px;align-items:flex-start;flex-direction:row-reverse;opacity:0.6;max-width:900px;margin-left:auto}
.queued-bubble{max-width:800px;padding:10px 16px;border-radius:10px;background:#111;border:1px dashed #333;color:#888;font-size:14px;white-space:pre-wrap}
.queued-badge{font-size:9px;color:#FAD979;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;margin-top:4px}
.queued-remove{font-size:11px;color:#666;cursor:pointer;margin-top:4px}
.queued-remove:hover{color:#E94560}

/* Reply bar */
.reply-bar{padding:10px 20px;border-top:1px solid #1a1a1a;display:flex;gap:8px;align-items:flex-end;flex-shrink:0;background:#0d0d0d}
.reply-bar textarea{flex:1;background:#111;border:1px solid #222;border-radius:10px;padding:10px 14px;color:#d4d4d4;font-family:'Inter',system-ui,sans-serif;font-size:14px;resize:none;height:48px;max-height:120px;line-height:1.5;transition:border-color 0.15s}
.reply-bar textarea:focus{outline:none;border-color:#5FA7F1;height:80px}
.reply-bar textarea::placeholder{color:#444}
.reply-actions{display:flex;gap:4px;align-items:flex-end}

/* Buttons */
.btn{background:#151515;color:#ccc;border:1px solid #333;border-radius:8px;padding:8px 16px;font-family:'Inter',system-ui,sans-serif;font-size:13px;font-weight:500;cursor:pointer;transition:all 0.15s}
.btn:hover{background:#222;color:#fff}
.btn:disabled{color:#444;border-color:#222;cursor:default;background:#0d0d0d}
.btn-send{background:#1a3d1a;border-color:#2d5a2d;color:#61D668}.btn-send:hover{background:#1f4a1f}
.btn-queue{background:#1a1a0a;border-color:#333020;color:#FAD979}.btn-queue:hover{background:#222200}
.btn-red{border-color:#E94560;color:#E94560}.btn-red:hover{background:#1f0d0d}
.btn-blue{border-color:#5FA7F1;color:#5FA7F1}.btn-blue:hover{background:#0d0d1f}

.main-area{flex:1;display:flex;flex-direction:column;overflow:hidden}
.warning{background:rgba(233,69,96,0.08);border:1px solid rgba(233,69,96,0.2);color:#E94560;padding:10px 16px;margin:8px 16px;border-radius:6px;font-size:13px}

@media(max-width:768px){.sidebar{width:180px}.sidebar.collapsed{margin-left:-180px}.chat-bubble{max-width:90%}.run-summary{max-width:none}}
@media(max-width:480px){.sidebar{display:none}.sidebar-toggle{display:none}}
`;

function stripSlackContext(prompt: string): string {
  const match = prompt.match(/\n*Slack thread context[^\n]*:/);
  if (match && match.index != null && match.index > 0) {
    return prompt.slice(0, match.index).trim();
  }
  if (prompt.startsWith("Slack thread context")) return "";
  return prompt;
}

export function workspacePageHTML(data: WorkspacePageData): string {
  const slackDomain = process.env.SLACK_WORKSPACE_DOMAIN || "";
  const clientData = {
    hash: data.hash,
    worktreeId: data.session.worktree_id || "",
    status: data.session.status || "unknown",
    user: data.session.user || "unknown",
    exitCode: data.session.exit_code,
    baseBranch: data.session.base_branch || "next",
    worktreeAlive: data.worktreeAlive,
    slackDomain,
    sessions: data.sessions.map(s => ({
      log_id: s._log_id, status: s.status, started: s.started, user: s.user,
      prompt: stripSlackContext(s.prompt || ""),
      slack_channel: s.slack_channel || "",
      slack_message_ts: s.slack_message_ts || "",
      slack_thread_ts: s.slack_thread_ts || "",
    })),
    lastReplies: data.lastReplies || {},
  };

  return appShell({
    title: `${(clientData.worktreeId || clientData.hash).slice(0, 8)} \u2014 ClaudeBox`,
    styles: WORKSPACE_STYLES,
    pageData: clientData,
    moduleScript: WORKSPACE_SCRIPT,
  });
}

const WORKSPACE_SCRIPT = `
const {h,render,html,useState,useEffect,useCallback,useRef,useMemo,AuthApp,authFetch}=window.__preact;
const D=window.__DATA__;

// ── Client-side helpers ──────────────────────────────────────────

function esc(s){
  return s.replace(/&/g,"&amp;").replace(/</g,"&lt;").replace(/>/g,"&gt;").replace(/"/g,"&quot;");
}

// Convert Slack mrkdwn links <url|label> and <url> to markdown/plain
function slackToMd(s){
  return s.replace(/<(https?:\\/\\/[^|>]+)(?:\\|([^>]+))?>/g,function(_,url,label){
    if(label)return '['+label+']('+url+')';
    return url;
  });
}

function linkify(s){
  s=s.replace(/\\[([^\\]]+)\\]\\((https?:\\/\\/[^)]+)\\)/g,function(_,label,url){
    return '<a href="'+esc(url)+'" target="_blank" class="link">'+esc(label)+'</a>';
  });
  var parts=s.split(/(<a [^>]*>.*?<\\/a>)/g);
  for(var i=0;i<parts.length;i++){
    if(parts[i].indexOf('<a ')===0)continue;
    parts[i]=esc(parts[i]);
    parts[i]=parts[i].replace(/(https?:\\/\\/[^\\s<>"']+)/g,function(m){
      var u=m.replace(/(&amp;|[.,;:!?)\\]])+$/,'');
      var rest=m.slice(u.length);
      for(var j=0;j<rest.length;j++){
        if(rest[j]===')'&&u.split('(').length>u.split(')').length){u+=rest[j];}else break;
      }
      // Unescape &amp; back to & in href
      var href=u.replace(/&amp;/g,'&');
      return '<a href="'+href+'" target="_blank" class="link">'+u+'</a>'+m.slice(u.length);
    });
  }
  return parts.join("");
}

function compactArtifact(text){
  var isUpdated=/updated/i.test(text);
  // PR: markdown link with #N
  var prMd=text.match(/\\[(?:PR )?#(\\d+)[^\\]]*\\]\\((https?:\\/\\/[^)]+)\\)/);
  if(prMd)return '<a href="'+esc(prMd[2])+'" target="_blank" class="link artifact-link">'+(isUpdated?'\\u2191 ':'')+'PR #'+prMd[1]+'</a>';
  // Issue: "Issue #N: title — url" or "Closed issue #N: ..."
  var issueM=text.match(/^(?:Closed )?[Ii]ssue #(\\d+).*?(https?:\\/\\/\\S+)/);
  if(issueM){var pre=text.indexOf("Closed")===0?"Closed ":"";return '<a href="'+esc(issueM[2])+'" target="_blank" class="link artifact-link">'+pre+'#'+issueM[1]+'</a>';}
  // Cross-ref
  var xref=text.match(/^Cross-ref #(\\d+)/);
  if(xref){var u=text.match(/(https?:\\/\\/\\S+)/);if(u)return '<a href="'+esc(u[1])+'" target="_blank" class="link artifact-link">Cross-ref #'+xref[1]+'</a>';return '<span class="artifact-link">Cross-ref #'+xref[1]+'</span>';}
  // Gist
  var gist=text.match(/^Gist:\\s*(https?:\\/\\/\\S+)/);
  if(gist)return '<a href="'+esc(gist[1])+'" target="_blank" class="link artifact-link">Gist</a>';
  // Skill PR
  var skill=text.match(/[Ss]kill.*?#(\\d+).*?(https?:\\/\\/\\S+)/);
  if(skill)return '<a href="'+esc(skill[2])+'" target="_blank" class="link artifact-link">PR #'+skill[1]+'</a>';
  // Label
  var label=text.match(/audit label:\\s*(\\S+)/);
  if(label)return '<span class="artifact-link">Label '+esc(label[1])+'</span>';
  // "Created <name> #N — url" or "Created #N — url"
  var created=text.match(/^Created\\s+(?:(.+?)\\s+)?#(\\d+).*?(https?:\\/\\/\\S+)/);
  if(created)return '<a href="'+esc(created[3])+'" target="_blank" class="link artifact-link">'+(created[1]?esc(created[1])+' ':'')+'#'+created[2]+'</a>';
  // Generic: any text with #N and a URL
  var generic=text.match(/#(\\d+).*?(https?:\\/\\/\\S+)/);
  if(generic)return '<a href="'+esc(generic[2])+'" target="_blank" class="link artifact-link">#'+generic[1]+'</a>';
  return linkify(text);
}

function renderMd(text){
  // Lightweight markdown → HTML. Handles fenced code blocks, tables, inline code,
  // bold, italic, headers, lists, blockquotes, horizontal rules, and links.
  var out="",lines=text.split("\\n"),inCode=false,codeLang="",codeLines=[];
  var inTable=false,tableRows=[];
  function flushTable(){
    if(!tableRows.length)return;
    var html='<table class="md-table">';
    for(var r=0;r<tableRows.length;r++){
      if(r===1)continue; // skip separator row
      var tag=r===0?"th":"td";
      var cells=tableRows[r].replace(/^\\|/,"").replace(/\\|$/,"").split("|");
      html+="<tr>";
      for(var c=0;c<cells.length;c++)html+="<"+tag+">"+inlineMd(cells[c].trim())+"</"+tag+">";
      html+="</tr>";
    }
    html+="</table>";
    out+=html;
    tableRows=[];
    inTable=false;
  }
  for(var i=0;i<lines.length;i++){
    var line=lines[i];
    // Fenced code blocks
    if(!inCode&&/^\`\`\`/.test(line)){if(inTable)flushTable();inCode=true;codeLang=line.slice(3).trim();codeLines=[];continue;}
    if(inCode){if(/^\`\`\`/.test(line)){out+='<pre><code>'+esc(codeLines.join("\\n"))+'</code></pre>';inCode=false;continue;}codeLines.push(line);continue;}
    // Table rows
    if(line.trim().charAt(0)==="|"&&line.trim().charAt(line.trim().length-1)==="|"){
      inTable=true;tableRows.push(line.trim());continue;
    }else if(inTable){flushTable();}
    // Blank line
    if(!line.trim()){out+="<br>";continue;}
    // Headers
    var hm=line.match(/^(#{1,3})\\s+(.+)/);
    if(hm){out+="<h"+hm[1].length+">"+inlineMd(hm[2])+"</h"+hm[1].length+">";continue;}
    // Horizontal rule
    if(/^(---|\\*\\*\\*|___)\\s*$/.test(line)){out+="<hr>";continue;}
    // Blockquote
    if(line.charAt(0)===">"){out+="<blockquote>"+inlineMd(line.slice(1).trim())+"</blockquote>";continue;}
    // Unordered list
    if(/^\\s*[-*]\\s+/.test(line)){out+="<li>"+inlineMd(line.replace(/^\\s*[-*]\\s+/,""))+"</li>";continue;}
    // Ordered list
    if(/^\\s*\\d+\\.\\s+/.test(line)){out+="<li>"+inlineMd(line.replace(/^\\s*\\d+\\.\\s+/,""))+"</li>";continue;}
    // Regular paragraph line
    out+=inlineMd(line)+"<br>";
  }
  if(inTable)flushTable();
  if(inCode)out+='<pre><code>'+esc(codeLines.join("\\n"))+'</code></pre>';
  // Wrap consecutive <li> in <ul>
  out=out.replace(/(<li>.*?<\\/li>(?:<li>.*?<\\/li>)*)/g,"<ul>$1</ul>");
  return out;
}
function inlineMd(s){
  s=esc(s);
  // Inline code (must be before bold/italic)
  s=s.replace(/\`([^\`]+)\`/g,'<code>$1</code>');
  // Bold
  s=s.replace(/\\\*\\\*(.+?)\\\*\\\*/g,'<strong>$1</strong>');
  // Italic
  s=s.replace(/\\\*(.+?)\\\*/g,'<em>$1</em>');
  // Links [text](url)
  s=s.replace(/\\[([^\\]]+)\\]\\((https?:\\/\\/[^)]+)\\)/g,'<a href="$2" target="_blank" class="link">$1</a>');
  // Bare URLs — split by existing <a> tags to avoid double-linking
  var parts=s.split(/(<a [^>]*>.*?<\\/a>)/g);
  for(var i=0;i<parts.length;i++){
    if(parts[i].indexOf('<a ')===0||parts[i].indexOf('<code')===0)continue;
    parts[i]=parts[i].replace(/(https?:\\/\\/[^\\s<>"']+)/g,function(m){
      var u=m.replace(/(&amp;|[.,;:!?)\\]])+$/,'');
      var href=u.replace(/&amp;/g,'&');
      return '<a href="'+href+'" target="_blank" class="link">'+u+'</a>'+m.slice(u.length);
    });
  }
  return parts.join("");
}

function timeAgo(iso){
  var ms=Date.now()-new Date(iso).getTime();
  if(ms<60000)return "just now";
  if(ms<3600000)return Math.floor(ms/60000)+"m ago";
  if(ms<86400000)return Math.floor(ms/3600000)+"h ago";
  return Math.floor(ms/86400000)+"d ago";
}

function msgId(text){
  var h=0;
  for(var i=0;i<Math.min(text.length,50);i++){h=((h<<5)-h)+text.charCodeAt(i);h|=0;}
  return "m"+Math.abs(h).toString(36);
}

// ── useSSE hook ─────────────────────────────────────────────────

function useSSE(id, onMessage){
  const sourceRef=useRef(null);
  const reconnectTimer=useRef(null);

  useEffect(()=>{
    function connect(){
      if(sourceRef.current)sourceRef.current.close();
      const es=new EventSource("/s/"+id+"/events");
      sourceRef.current=es;
      es.onmessage=function(ev){
        try{onMessage(JSON.parse(ev.data));}catch(e){}
      };
      es.onerror=function(){
        es.close();sourceRef.current=null;
        reconnectTimer.current=setTimeout(connect,5000);
      };
    }
    connect();
    return ()=>{
      if(sourceRef.current)sourceRef.current.close();
      if(reconnectTimer.current)clearTimeout(reconnectTimer.current);
    };
  },[id]);
}

// ── Activity row component (flat, no indentation) ───────────────

function ActivityRow({entry, agentLogUrl}){
  const t=entry.ts?timeAgo(entry.ts):"";
  const text=slackToMd(entry.text);
  const linked=linkify(text);

  if(entry.type==="response"){
    const md=renderMd(text);
    return html\`<div class="act-card act-response"><div class="act-card-head"><span class="act-badge act-badge-reply">reply</span><span class="act-ts">\${t}</span></div><div class="md-content" dangerouslySetInnerHTML=\${{__html:md}}></div></div>\`;
  }
  if(entry.type==="context"){
    const md=renderMd(text);
    return html\`<div class="act-card act-context"><div class="md-content" dangerouslySetInnerHTML=\${{__html:md}}></div><div class="act-ts" style="margin-top:4px">\${t}</div></div>\`;
  }
  if(entry.type==="artifact"){
    const compact=compactArtifact(text);
    return html\`<div class="act-row act-artifact"><span class="act-icon">\u25C6</span><span dangerouslySetInnerHTML=\${{__html:compact}}></span><span class="act-ts">\${t}</span></div>\`;
  }
  if(entry.type==="agent_start"){
    const agentInner=agentLogUrl
      ?'<a href="'+esc(agentLogUrl)+'" target="_blank" class="link">Agent: '+linkify(text)+'</a>'
      :'Agent: '+linkify(text);
    return html\`<div class="act-row act-agent"><span class="act-icon agent-dot-inline"></span><span dangerouslySetInnerHTML=\${{__html:agentInner}}></span><span class="act-ts">\${t}</span></div>\`;
  }
  if(entry.type==="tool_use"){
    const raw=entry.text||"";
    const bashMatch=raw.match(/^(?:(.+?):\s*)?\$\s+(.+)$/);
    if(bashMatch){
      const desc=bashMatch[1]||"";
      const cmd=bashMatch[2];
      return html\`<div class="act-row act-tool"><span class="act-icon">\u25B8</span><code>\${desc && html\`<span class="tool-desc">\${desc} </span>\`}<span class="tool-bash">$</span> <span class="tool-args">\${cmd}</span></code><span class="act-ts">\${t}</span></div>\`;
    }
    const spIdx=raw.indexOf(" ");
    const toolName=spIdx>0?raw.slice(0,spIdx):raw;
    const toolArgs=spIdx>0?raw.slice(spIdx):"";
    const argsHtml=linkify(toolArgs);
    return html\`<div class="act-row act-tool"><span class="act-icon">\u25B8</span><code><span class="tool-name">\${toolName}</span><span class="tool-args" dangerouslySetInnerHTML=\${{__html:argsHtml}}></span></code><span class="act-ts">\${t}</span></div>\`;
  }
  if(entry.type==="tool_result"){
    return html\`<div class="act-result"><div class="act-result-content" dangerouslySetInnerHTML=\${{__html:linked}}></div></div>\`;
  }
  if(entry.type==="status"){
    return html\`<div class="act-row act-status"><span class="act-icon">\u25CB</span><span dangerouslySetInnerHTML=\${{__html:linked}}></span><span class="act-ts">\${t}</span></div>\`;
  }
  return html\`<div class="act-row"><span class="act-icon">\u00B7</span><span dangerouslySetInnerHTML=\${{__html:linked}}></span><span class="act-ts">\${t}</span></div>\`;
}

// ── PromptCard component (flat, with Slack link) ────────────────

function PromptCard({text, time, user, slackLink}){
  const md=renderMd(slackToMd(text));
  return html\`<div class="act-card act-prompt"><div class="act-card-head"><span class="act-badge act-badge-prompt">\${user||"user"}</span>\${slackLink?html\`<a href=\${slackLink} target="_blank" class="act-slack-link" title="View in Slack">\u2197 Slack</a>\`:null}<span class="act-ts">\${time||""}</span></div><div class="act-prompt-text md-content" dangerouslySetInnerHTML=\${{__html:md}}></div></div>\`;
}

// ── Artifact helpers ─────────────────────────────────────────────

// Extract PR number from artifact text
function artifactPrNum(text){
  var m=text.match(/#(\\d+)/);
  return m?parseInt(m[1]):null;
}

// Build compact artifact chips for a run, marking PR updates
function ArtifactChips({artifacts, priorPrNums}){
  if(!artifacts||!artifacts.length)return null;
  return html\`<div class="artifact-chips">\${artifacts.map((a,i)=>{
    var text=slackToMd(a.text);
    var prNum=artifactPrNum(text);
    var isUpdate=(prNum&&priorPrNums&&priorPrNums.has(prNum))||/updated/i.test(text);
    var compact=compactArtifact(text);
    return html\`<span key=\${i} class=\${"artifact-chip"+(isUpdate?" artifact-chip-update":"")} dangerouslySetInnerHTML=\${{__html:compact}}></span>\`;
  })}</div>\`;
}

// ── Run cards (new architecture: session-driven, not timeline-driven) ──

const RUN_COLORS=[
  "rgba(122,162,247,0.04)","rgba(158,206,106,0.04)","rgba(224,175,104,0.04)",
  "rgba(187,154,247,0.04)","rgba(125,207,255,0.04)","rgba(247,118,142,0.04)",
  "rgba(115,218,202,0.04)","rgba(255,158,100,0.04)"
];
function runBg(i){return RUN_COLORS[i%RUN_COLORS.length];}

function RunCard({run, lastReply, selected, onSelect, onOpen, runArtifacts, priorPrNums}){
  const st=run.status||"unknown";
  const replyText=lastReply?slackToMd(lastReply):"";

  return html\`<div class=\${"run-card"+(selected?" run-card-selected":"")} id=\${"run-"+run.logId} style=\${"background:"+runBg(run.index)} onClick=\${()=>selected?onOpen(run.index):onSelect(run.index)} onDblClick=\${()=>onOpen(run.index)}>
    <div class="run-header">
      <span class=\${"run-dot "+st}></span>
      <span class="run-label">run \${run.index+1}\${run.total>1?"/"+run.total:""}</span>
      <span class="run-status">\${st}</span>
      \${run.exitCode!=null&&run.exitCode!==0?html\`<span class="run-exit">exit \${run.exitCode}</span>\`:null}
      \${run.started?html\`<span class="run-time">\${timeAgo(run.started)}</span>\`:null}
    </div>
    <div class="run-summary">
      \${run.prompt?html\`<div class="run-summary-prompt"><span class="prompt-label">prompt</span><span class="prompt-text md-content" dangerouslySetInnerHTML=\${{__html:renderMd(slackToMd(run.prompt))}}></span></div>\`:null}
      \${replyText?html\`<div class="run-summary-reply"><span class="reply-label">reply</span><span class="reply-text md-content" dangerouslySetInnerHTML=\${{__html:renderMd(replyText)}}></span></div>\`
        :st==="running"?html\`<div class="run-summary-reply" style="opacity:0.4"><span class="reply-label">reply</span><span class="reply-text">working\\u2026</span></div>\`
        :!run.prompt?html\`<div class="run-summary-empty">No prompt recorded</div>\`
        :null}
    </div>
    \${runArtifacts&&runArtifacts.length?html\`<\${ArtifactChips} artifacts=\${runArtifacts} priorPrNums=\${priorPrNums} />\`:null}
  </div>\`;
}

// ── RunDetail — full activity view for a selected run ────────────

function RunDetail({run, activity, onBack, runArtifacts, priorPrNums}){
  const st=run.status||"unknown";
  const bodyRef=useRef(null);
  const prevActivityLen=useRef(0);

  // Scroll to bottom on first render and when new activity arrives
  useEffect(()=>{
    if(!bodyRef.current)return;
    const el=bodyRef.current;
    if(activity.length!==prevActivityLen.current){
      const nearBottom=el.scrollHeight-el.scrollTop-el.clientHeight<200;
      if(nearBottom||prevActivityLen.current===0){
        requestAnimationFrame(()=>{el.scrollTop=el.scrollHeight;});
      }
      prevActivityLen.current=activity.length;
    }
  },[activity.length]);

  return html\`<div class="run-detail">
    <div class="run-detail-header">
      <button class="btn run-back-btn" onClick=\${onBack}>\u2190 All runs</button>
      <span class=\${"run-dot "+st}></span>
      <span class="run-label">run \${run.index+1}/\${run.total}</span>
      <span class="run-status">\${st}</span>
      \${run.exitCode!=null&&run.exitCode!==0?html\`<span class="run-exit">exit \${run.exitCode}</span>\`:null}
      \${run.started?html\`<span class="run-time">\${timeAgo(run.started)}</span>\`:null}
    </div>
    \${runArtifacts&&runArtifacts.length?html\`<\${ArtifactChips} artifacts=\${runArtifacts} priorPrNums=\${priorPrNums} />\`:null}
    <div class="run-detail-body" ref=\${bodyRef}>
      \${run.prompt?html\`<\${PromptCard} text=\${run.prompt} time=\${run.started?timeAgo(run.started):""} user=\${run.user} slackLink=\${run.slackLink} />\`:null}
      \${activity.map((item,i)=>html\`<\${ActivityRow} key=\${item.id||("a"+i)} entry=\${item.entry} agentLogUrl=\${item.agentLogUrl} />\`)}
      \${run.status==="running"?html\`<\${TypingIndicator} />\`:null}
    </div>
  </div>\`;
}

// ── TypingIndicator component ───────────────────────────────────

function TypingIndicator(){
  return html\`<div class="typing"><div class="typing-dots"><span></span><span></span><span></span></div><span class="typing-label">working\u2026</span></div>\`;
}

// ── QueuedMessages component ────────────────────────────────────

function QueuedMessages({queue, onRemove}){
  if(!queue.length)return null;
  return html\`<div style="padding:4px 20px;border-top:1px solid #1a1a1a">
    \${queue.map((msg,i)=>html\`<div class="queued-msg" style="margin:4px 0" key=\${i}><div class="chat-avatar user-avatar" style="opacity:0.5">\u2026</div><div class="queued-bubble">\${msg}<div class="queued-badge">queued</div><div class="queued-remove" onClick=\${()=>onRemove(i)}>\u2715 remove</div></div></div>\`)}
  </div>\`;
}

// ── ReplyBar component ──────────────────────────────────────────

function ReplyBar({isRunning, onSend, onQueue, onCancel}){
  const inputRef=useRef(null);

  const handleKeyDown=useCallback((e)=>{
    if(e.key==="Enter"&&(e.ctrlKey||e.metaKey)){
      e.preventDefault();
      const text=(inputRef.current&&inputRef.current.value.trim())||"";
      if(isRunning){if(text)onQueue(text);}
      else{onSend(text||"Continue from where you left off.");}
      if(inputRef.current)inputRef.current.value="";
      if(inputRef.current)inputRef.current.style.height="44px";
    }
  },[isRunning,onSend,onQueue]);

  const handleInput=useCallback((e)=>{
    e.target.style.height="44px";
    e.target.style.height=Math.min(e.target.scrollHeight,120)+"px";
  },[]);

  const handleSend=useCallback(()=>{
    const text=(inputRef.current&&inputRef.current.value.trim())||"Continue from where you left off.";
    onSend(text);
    if(inputRef.current){inputRef.current.value="";inputRef.current.style.height="44px";}
  },[onSend]);

  const handleQueue=useCallback(()=>{
    const text=inputRef.current&&inputRef.current.value.trim();
    if(!text)return;
    onQueue(text);
    if(inputRef.current){inputRef.current.value="";inputRef.current.style.height="44px";}
  },[onQueue]);

  return html\`<div class="reply-bar">
    <textarea ref=\${inputRef} placeholder=\${isRunning?"Queue a message\u2026 (Ctrl+Enter)":"Send a follow-up\u2026 (Ctrl+Enter)"} onKeyDown=\${handleKeyDown} onInput=\${handleInput}></textarea>
    <div class="reply-actions">
      \${isRunning
        ?html\`<button class="btn btn-queue" onClick=\${handleQueue}>Queue</button><button class="btn btn-red" onClick=\${onCancel}>Cancel</button>\`
        :html\`<button class="btn btn-send" onClick=\${handleSend}>Send</button>\`}
    </div>
  </div>\`;
}

// ── Sidebar component ───────────────────────────────────────────

// SidebarToggle removed — collapse/expand is built into sidebar itself

function Sidebar({open, status, exitCode, user, baseBranch, sessions, artifacts, selectedRun, onSelectRun, onToggle}){
  return html\`<div class=\${"sidebar"+(open?"":" collapsed")} onClick=\${open?null:onToggle}>
    <div class="sidebar-tab">info</div>
    <div class="sidebar-section" style="position:relative">
      <button class="sidebar-collapse" onClick=\${onToggle} title="Collapse sidebar">\u2715</button>
      <div class="sidebar-label">Workspace</div>
      <div class="stat-row"><span class="dim">status</span> <span class=\${"status-"+status}>\${status}\${exitCode!=null?" ("+exitCode+")":""}</span></div>
      <div class="stat-row"><span class="dim">user</span> \${user}</div>
      <div class="stat-row"><span class="dim">branch</span> \${baseBranch}</div>
      <div class="stat-row"><span class="dim">runs</span> \${sessions.length}</div>
      \${sessions.length&&sessions[0].started?html\`<div class="stat-row"><span class="dim">started</span> \${timeAgo(sessions[0].started)}</div>\`:null}
    </div>
    \${artifacts.length?html\`<div class="sidebar-section">
      <div class="sidebar-label">Artifacts (\${artifacts.length})</div>
      <div style="display:flex;gap:6px;flex-wrap:wrap">
      \${artifacts.map((a,i)=>{
        return html\`<span key=\${i} dangerouslySetInnerHTML=\${{__html:compactArtifact(slackToMd(a.text))}}></span>\`;
      })}
      </div>
    </div>\`:null}
    \${sessions.length>1?html\`<div class="sidebar-section">
      <div class="sidebar-label">Runs</div>
      \${[...sessions].reverse().map((s,i)=>{
        const st=s.status||"unknown";
        const isSel=selectedRun===i;
        return html\`<div class=\${"session-entry se-"+st+(isSel?" se-selected":"")} key=\${s.log_id||i}
          onClick=\${()=>onSelectRun(i)}>
          <span class=\${"se-dot "+st}></span>
          <span class="se-label">run \${i+1}/\${sessions.length}</span>
          \${s.exit_code!=null&&s.exit_code!==0?html\`<span class="se-exit">exit \${s.exit_code}</span>\`:null}
          <span class="dim" style="margin-left:auto">\${s.started?timeAgo(s.started):""}</span>
        </div>\`;
      })}
    </div>\`:null}
  </div>\`;
}

// ── ChatArea — runs driven by D.sessions ────────────────────────

function ChatArea({runs, selectedRun, activityByRun, lastReplyByRun, artifactsByRun, onSelectRun, onBack}){
  const [selectedCard,setSelectedCard]=useState(null);
  if(!runs.length)return html\`<div class="chat-area"><div class="chat-empty">No runs yet</div></div>\`;

  // Compute cumulative PR numbers seen before each run (for detecting updates)
  const priorPrNumsByRun=useMemo(()=>{
    var result={};
    var seen=new Set();
    for(var i=0;i<runs.length;i++){
      result[runs[i].logId]=new Set(seen);
      var arts=artifactsByRun[runs[i].logId]||[];
      for(var a of arts){var n=artifactPrNum(a.text);if(n)seen.add(n);}
    }
    return result;
  },[runs,artifactsByRun]);

  // Detail view: full activity for selected run
  if(selectedRun!=null&&runs[selectedRun]){
    const run=runs[selectedRun];
    return html\`<div class="chat-area" style="padding:0;overflow:hidden">
      <\${RunDetail}
        run=\${run}
        activity=\${activityByRun[run.logId]||[]}
        onBack=\${()=>{setSelectedCard(null);onBack();}}
        runArtifacts=\${artifactsByRun[run.logId]||[]}
        priorPrNums=\${priorPrNumsByRun[run.logId]}
      />
    </div>\`;
  }

  // List view: all run cards with prompt + reply summaries
  return html\`<div class="chat-area chat-area-list">
    \${runs.map((run,i)=>html\`<\${RunCard}
      key=\${run.logId||i}
      run=\${run}
      lastReply=\${lastReplyByRun[run.logId]||""}
      selected=\${selectedCard===i}
      onSelect=\${setSelectedCard}
      onOpen=\${onSelectRun}
      runArtifacts=\${artifactsByRun[run.logId]||[]}
      priorPrNums=\${priorPrNumsByRun[run.logId]}
    />\`)}
  </div>\`;
}

// ── WorkspacePage — session-driven architecture ─────────────────

function WorkspacePage(){
  const id=D.worktreeId||D.hash;
  const shortId=(D.worktreeId||D.hash).slice(0,8);

  const [status,setStatus]=useState(D.status);
  const [exitCode,setExitCode]=useState(D.exitCode);
  const [sidebarOpen,setSidebarOpen]=useState(()=>sessionStorage.getItem("cb_sidebar")==="open");
  const [messageQueue,setMessageQueue]=useState(()=>{
    try{return JSON.parse(localStorage.getItem("cb_queue_"+id)||"[]");}catch(e){return[];}
  });
  const [artifacts,setArtifacts]=useState([]);
  // Activity per run: {[logId]: [{entry, id, agentLogUrl}]}
  const [activityByRun,setActivityByRun]=useState({});
  // Artifacts per run: {[logId]: [{text, ts}]}
  const [artifactsByRun,setArtifactsByRun]=useState({});
  // Last reply per run for collapsed summaries: {[logId]: string}
  const [lastReplyByRun,setLastReplyByRun]=useState(()=>D.lastReplies||{});

  const isRunning=status==="running";

  function slackPermalink(s){
    if(!s.slack_channel)return null;
    var ts=s.slack_thread_ts||s.slack_message_ts;
    if(!ts)return null;
    var pTs=ts.replace(".","");
    var domain=D.slackDomain||"app";
    return "https://"+domain+".slack.com/archives/"+s.slack_channel+"/p"+pTs;
  }

  // Build runs from D.sessions (oldest first)
  const runs=useMemo(()=>{
    const sessionsOldest=[...D.sessions].reverse();
    const total=sessionsOldest.length;
    return sessionsOldest.map((s,i)=>({
      logId:s.log_id, index:i, total:total,
      status:s.status, exitCode:s.exit_code, started:s.started,
      prompt:s.prompt||"", user:s.user||D.user,
      slackLink:slackPermalink(s),
    }));
  },[]);

  // Deeplink: ?run=<logId> opens detail view, otherwise list view (null)
  const [selectedRun,setSelectedRun]=useState(()=>{
    const p=new URLSearchParams(window.location.search);
    const runParam=p.get("run")||"";
    if(runParam){
      const idx=runs.findIndex(r=>r.logId===runParam);
      if(idx>=0)return idx;
    }
    // Single run: auto-open detail view; multiple runs: list view
    return runs.length===1?0:null;
  });

  const goBack=useCallback(()=>{setSelectedRun(null);},[]);

  // Auto-open detail when new session starts on a running workspace
  const runsLen=runs.length;
  useEffect(()=>{
    setSelectedRun(prev=>prev===runsLen-2?runsLen-1:prev);
  },[runsLen]);

  const seenRef=useRef(new Set());
  const agentLogUrlsRef=useRef([]);
  const pendingQueueRef=useRef(messageQueue);
  useEffect(()=>{pendingQueueRef.current=messageQueue;},[messageQueue]);

  const toggleSidebar=useCallback(()=>{
    setSidebarOpen(prev=>{const next=!prev;sessionStorage.setItem("cb_sidebar",next?"open":"closed");return next;});
  },[]);

  useEffect(()=>{
    localStorage.setItem("cb_queue_"+id,JSON.stringify(messageQueue));
  },[messageQueue,id]);

  // Assign activity to a run by timestamp
  function assignRunLogId(entry){
    const sessionsOldest=[...D.sessions].reverse();
    if(!entry.ts||!sessionsOldest.length)return sessionsOldest.length?sessionsOldest[sessionsOldest.length-1].log_id:null;
    for(let i=sessionsOldest.length-1;i>=0;i--){
      if(sessionsOldest[i].started&&entry.ts>=sessionsOldest[i].started)return sessionsOldest[i].log_id;
    }
    return sessionsOldest[0].log_id;
  }

  // Process entry -> {logId, item} or null
  function processEntry(e, forceLogId){
    if(e.type==="agent_log"){
      const m=e.text.match(/(https?:\\/\\/[^\\s]+)/);
      if(m){
        setActivityByRun(prev=>{
          const updated={...prev};
          for(const lid of Object.keys(updated)){
            const items=updated[lid];
            const idx=items.findIndex(t=>t.entry.type==="agent_start"&&!t.agentLogUrl);
            if(idx>=0){
              updated[lid]=[...items];
              updated[lid][idx]={...items[idx],agentLogUrl:m[1]};
              return updated;
            }
          }
          agentLogUrlsRef.current.push(m[1]);
          return prev;
        });
      }
      return null;
    }
    const mid=msgId(e.text);
    if(seenRef.current.has(mid))return null;
    seenRef.current.add(mid);
    const agentLogUrl=e.type==="agent_start"?agentLogUrlsRef.current.shift():undefined;
    const logId=forceLogId||assignRunLogId(e);
    return {logId, item:{entry:e, id:mid, agentLogUrl}};
  }

  // Batch-add activity items
  function addActivityItems(results){
    const grouped={}, replyUpdates={}, artGroups={};
    for(const r of results){
      if(!r||!r.logId)continue;
      if(!grouped[r.logId])grouped[r.logId]=[];
      grouped[r.logId].push(r.item);
      if(r.item.entry.type==="response")replyUpdates[r.logId]=r.item.entry.text;
      if(r.item.entry.type==="artifact"){
        if(!artGroups[r.logId])artGroups[r.logId]=[];
        artGroups[r.logId].push({text:r.item.entry.text,ts:r.item.entry.ts});
      }
    }
    if(Object.keys(grouped).length){
      setActivityByRun(prev=>{
        const next={...prev};
        for(const lid of Object.keys(grouped))next[lid]=[...(next[lid]||[]),...grouped[lid]];
        return next;
      });
    }
    if(Object.keys(replyUpdates).length){
      setLastReplyByRun(prev=>({...prev,...replyUpdates}));
    }
    if(Object.keys(artGroups).length){
      setArtifactsByRun(prev=>{
        const next={...prev};
        for(const lid of Object.keys(artGroups))next[lid]=[...(next[lid]||[]),...artGroups[lid]];
        return next;
      });
    }
  }

  const sendNextQueued=useCallback(()=>{
    const q=pendingQueueRef.current;
    if(!q.length)return;
    const msg=q[0];
    setMessageQueue(prev=>prev.slice(1));
    authFetch("/s/"+id+"/resume",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({prompt:msg})})
      .then(r=>r.json())
      .then(d=>{if(!d.ok)console.warn("Queue send failed:",d.message);})
      .catch(e=>console.warn("Queue send error:",e));
  },[id]);

  const statusRef=useRef(status);
  useEffect(()=>{statusRef.current=status;},[status]);

  const handleSSE=useCallback((d)=>{
    if(d.type==="activity"&&d.entry){
      const sessionsOldest=[...D.sessions].reverse();
      const currentLogId=sessionsOldest.length?sessionsOldest[sessionsOldest.length-1].log_id:null;
      const result=processEntry(d.entry, currentLogId);
      if(result)addActivityItems([result]);
      if(d.entry.type==="artifact")setArtifacts(prev=>[...prev,d.entry]);
    }else if(d.type==="status"){
      const wasRunning=statusRef.current==="running";
      setStatus(d.status);
      setExitCode(d.exit_code);
      if(wasRunning&&d.status!=="running")setTimeout(()=>sendNextQueued(),100);
    }else if(d.type==="init"){
      if(Array.isArray(d.activity)){
        const results=[];
        for(const a of d.activity){
          const r=processEntry(a);
          if(r)results.push(r);
          if(a.type==="artifact")setArtifacts(prev=>[...prev,a]);
        }
        addActivityItems(results);
      }
      setStatus(d.status);
      setExitCode(d.exit_code);
    }
  },[sendNextQueued]);

  useSSE(id,handleSSE);

  const addToQueue=useCallback((text)=>{setMessageQueue(prev=>[...prev,text]);},[]);
  const removeFromQueue=useCallback((index)=>{setMessageQueue(prev=>prev.filter((_,i)=>i!==index));},[]);

  const handleSend=useCallback((text)=>{
    setStatus("running");
    authFetch("/s/"+id+"/resume",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({prompt:text})})
      .then(r=>r.json())
      .then(d=>{if(!d.ok)alert(d.message||"Could not resume.");})
      .catch(e=>alert("Error: "+e.message));
  },[id]);

  const handleCancel=useCallback(()=>{
    if(!confirm("Cancel this session?"))return;
    authFetch("/s/"+id+"/cancel",{method:"POST"})
      .then(r=>r.json())
      .then(d=>{if(!d.ok)alert(d.message||"Could not cancel.");})
      .catch(e=>alert("Error: "+e.message));
  },[id]);

  const showReplyBar=D.worktreeAlive&&D.worktreeId;

  return html\`
    <div class="header">
      <span class="header-title"><a href="/dashboard" class="link">ClaudeBox</a></span>
      <span class="header-id">\${shortId}</span>
      <span class=\${"header-status "+status}>\${status}\${exitCode!=null?" ("+exitCode+")":""}</span>
    </div>
    \${!D.worktreeAlive&&D.worktreeId?html\`<div class="warning">Workspace has been deleted. Resume is unavailable.</div>\`:null}
    <div class="layout">
      <\${Sidebar} open=\${sidebarOpen} status=\${status} exitCode=\${exitCode} user=\${D.user} baseBranch=\${D.baseBranch} sessions=\${D.sessions} artifacts=\${artifacts} selectedRun=\${selectedRun} onSelectRun=\${setSelectedRun} onToggle=\${toggleSidebar} />
      <div class="main-area">
        <\${ChatArea} runs=\${runs} selectedRun=\${selectedRun} activityByRun=\${activityByRun} lastReplyByRun=\${lastReplyByRun} artifactsByRun=\${artifactsByRun} onSelectRun=\${setSelectedRun} onBack=\${goBack} />
        <\${QueuedMessages} queue=\${messageQueue} onRemove=\${removeFromQueue} />
        \${showReplyBar?html\`<\${ReplyBar} isRunning=\${isRunning} onSend=\${handleSend} onQueue=\${addToQueue} onCancel=\${handleCancel} />\`:null}
      </div>
    </div>
  \`;
}

// ── App (top-level) ─────────────────────────────────────────────

function App(){
  return html\`<\${AuthApp}><\${WorkspacePage} /></\${AuthApp}>\`;
}

render(html\`<\${App} />\`,document.getElementById("app"));
`;
