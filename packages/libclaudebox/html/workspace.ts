import type { SessionMeta } from "../types.ts";
import { esc, safeHref, timeAgo, statusColor, linkify, renderActivityEntry, BASE_STYLES, type ActivityEntry, type WorkspacePageData } from "./shared.ts";
import { appShell } from "./app-shell.ts";

// CSS specific to workspace page
const WORKSPACE_STYLES = `
*{box-sizing:border-box;margin:0;padding:0}
#app{height:100vh;display:flex;flex-direction:column}
code,.mono{font-family:'SF Mono',Monaco,'Cascadia Code',monospace;font-size:12px}
a{color:inherit;text-decoration:none}a:hover{text-decoration:underline}
.link{color:#5FA7F1}
.dim{color:#666}
::-webkit-scrollbar{width:5px}::-webkit-scrollbar-track{background:transparent}::-webkit-scrollbar-thumb{background:#333;border-radius:3px}

/* Header */
.header{padding:8px 16px;border-bottom:1px solid #1a1a1a;display:flex;align-items:center;gap:12px;flex-shrink:0;background:#0d0d0d}
.header-title{font-weight:600;color:#5FA7F1;font-size:14px;letter-spacing:-0.3px}
.header-id{color:#FAD979;font-size:12px;font-family:'SF Mono',monospace}
.header-status{font-size:11px;padding:2px 8px;border-radius:10px;font-weight:500;letter-spacing:0.2px}

/* Status colors */
.status-running,.header-status.running{color:#61D668;background:rgba(97,214,104,0.1);border:1px solid rgba(97,214,104,0.2)}
.status-interactive,.header-status.interactive{color:#FAD979;background:rgba(250,217,121,0.1);border:1px solid rgba(250,217,121,0.2)}
.status-completed,.header-status.completed{color:#61D668;background:rgba(97,214,104,0.1);border:1px solid rgba(97,214,104,0.2)}
.status-error,.header-status.error{color:#E94560;background:rgba(233,69,96,0.1);border:1px solid rgba(233,69,96,0.2)}
.status-cancelled,.status-interrupted,.status-unknown,.header-status.cancelled,.header-status.interrupted,.header-status.unknown{color:#888;background:rgba(136,136,136,0.1);border:1px solid rgba(136,136,136,0.2)}

/* Layout */
.layout{display:flex;flex:1;overflow:hidden}
.sidebar{width:240px;border-right:1px solid #1a1a1a;display:flex;flex-direction:column;flex-shrink:0;background:#0d0d0d;overflow-y:auto;transition:margin-left 0.15s,opacity 0.15s}
.sidebar.collapsed{margin-left:-240px;opacity:0;pointer-events:none}
.sidebar-toggle{position:absolute;top:8px;left:8px;z-index:10;background:#151515;border:1px solid #333;color:#888;width:28px;height:28px;border-radius:6px;cursor:pointer;font-size:14px;display:flex;align-items:center;justify-content:center;transition:all 0.15s}
.sidebar-toggle:hover{color:#ccc;border-color:#555}
.sidebar-section{padding:10px 12px;border-bottom:1px solid #1a1a1a}
.sidebar-label{font-size:10px;text-transform:uppercase;letter-spacing:0.8px;color:#555;margin-bottom:6px;font-weight:600}
.stat-row{font-size:12px;padding:2px 0;display:flex;gap:8px}
.stat-row .dim{min-width:50px;font-size:11px}
.artifact-row{font-size:11px;padding:4px 0;border-bottom:1px solid #111;word-break:break-all;line-height:1.4}

/* Session history */
.session-entry{font-size:11px;padding:4px 0;display:flex;gap:6px;align-items:center}
.session-entry a{color:#5FA7F1}

/* Chat */
.chat-area{flex:1;overflow-y:auto;padding:12px 20px;display:flex;flex-direction:column;gap:4px}
.chat-empty{flex:1;display:flex;align-items:center;justify-content:center;color:#333;font-size:13px}

/* Messages */
.chat-msg{display:flex;gap:8px;align-items:flex-start;animation:fadeIn 0.15s ease}
@keyframes fadeIn{from{opacity:0;transform:translateY(4px)}to{opacity:1;transform:translateY(0)}}
.chat-msg.bot{flex-direction:row}
.chat-msg.user{flex-direction:row-reverse}
.chat-avatar{width:24px;height:24px;border-radius:6px;background:#1a1a2e;color:#5FA7F1;display:flex;align-items:center;justify-content:center;font-size:9px;font-weight:600;flex-shrink:0;margin-top:2px}
.user-avatar{background:#1a2e1a;color:#61D668}
.chat-bubble{max-width:75%;padding:8px 12px;border-radius:10px;font-size:13px;line-height:1.55;word-break:break-word;white-space:pre-wrap}
.reply-bubble{background:#0d1a2e;border:1px solid #1a3060;color:#ddd}
.reply-avatar{background:#1a2e4a !important;color:#5FA7F1 !important}
.context-bubble{background:#0e0e0e;border:1px solid #1a1a1a;color:#999;font-size:12px}
.user-bubble{background:#0d1a0d;border:1px solid #1a331a;color:#ccc;text-align:left}
.artifact-bubble{background:#1a1a0a;border:1px solid #333020;color:#FAD979;font-size:12px}
.chat-time{font-size:10px;color:#444;margin-top:3px}
.chat-label{font-size:9px;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;margin-bottom:2px}
.chat-label.reply-label{color:#5FA7F1}
.chat-label.artifact-label{color:#FAD979}

/* Tool/status lines */
.chat-status{display:flex;align-items:center;gap:6px;font-size:11px;color:#666;padding:2px 12px 2px 36px;font-family:'SF Mono',monospace}
.chat-status .ts{color:#444;font-size:10px;margin-left:auto;flex-shrink:0}
.tool-icon{font-size:10px;flex-shrink:0;width:14px;text-align:center}

/* Agent activity */
.chat-agent{display:flex;align-items:center;gap:6px;font-size:11px;color:#a78bfa;padding:3px 12px 3px 36px}
.agent-dot{width:6px;height:6px;border-radius:50%;background:#a78bfa;flex-shrink:0;animation:pulse 2s infinite}

/* Run dividers */
.chat-run{display:flex;align-items:center;gap:8px;padding:8px 0;margin:4px 0;color:#444;font-size:11px}
.run-line{flex:1;height:1px;background:#1a1a1a}
.run-label{font-weight:600;letter-spacing:0.5px;white-space:nowrap}

/* Typing indicator */
.typing{display:flex;align-items:center;gap:8px;padding:4px 12px 4px 36px}
.typing-dots{display:flex;gap:3px}
.typing-dots span{width:5px;height:5px;border-radius:50%;background:#5FA7F1;animation:typing 1.4s infinite}
.typing-dots span:nth-child(2){animation-delay:0.2s}
.typing-dots span:nth-child(3){animation-delay:0.4s}
@keyframes typing{0%,60%,100%{opacity:0.2;transform:scale(0.8)}30%{opacity:1;transform:scale(1)}}
@keyframes pulse{0%,100%{opacity:1}50%{opacity:0.3}}
.typing-label{font-size:11px;color:#555}

/* Queued messages */
.queued-msg{display:flex;gap:8px;align-items:flex-start;flex-direction:row-reverse;opacity:0.6}
.queued-bubble{max-width:75%;padding:8px 12px;border-radius:10px;background:#111;border:1px dashed #333;color:#888;font-size:13px;white-space:pre-wrap}
.queued-badge{font-size:9px;color:#FAD979;font-weight:600;text-transform:uppercase;letter-spacing:0.5px;margin-top:3px}
.queued-remove{font-size:10px;color:#666;cursor:pointer;margin-top:3px}
.queued-remove:hover{color:#E94560}

/* Reply bar */
.reply-bar{padding:8px 16px;border-top:1px solid #1a1a1a;display:flex;gap:8px;align-items:flex-end;flex-shrink:0;background:#0d0d0d}
.reply-bar textarea{flex:1;background:#111;border:1px solid #222;border-radius:10px;padding:10px 14px;color:#d4d4d4;font-family:'Inter',system-ui,sans-serif;font-size:13px;resize:none;height:44px;max-height:120px;line-height:1.5;transition:border-color 0.15s}
.reply-bar textarea:focus{outline:none;border-color:#5FA7F1;height:80px}
.reply-bar textarea::placeholder{color:#444}
.reply-actions{display:flex;gap:4px;align-items:flex-end}

/* Buttons */
.btn{background:#151515;color:#ccc;border:1px solid #333;border-radius:8px;padding:6px 14px;font-family:'Inter',system-ui,sans-serif;font-size:12px;font-weight:500;cursor:pointer;transition:all 0.15s}
.btn:hover{background:#222;color:#fff}
.btn:disabled{color:#444;border-color:#222;cursor:default;background:#0d0d0d}
.btn-send{background:#1a3d1a;border-color:#2d5a2d;color:#61D668}.btn-send:hover{background:#1f4a1f}
.btn-queue{background:#1a1a0a;border-color:#333020;color:#FAD979}.btn-queue:hover{background:#222200}
.btn-red{border-color:#E94560;color:#E94560}.btn-red:hover{background:#1f0d0d}
.btn-blue{border-color:#5FA7F1;color:#5FA7F1}.btn-blue:hover{background:#0d0d1f}

.main-area{flex:1;display:flex;flex-direction:column;overflow:hidden}
.warning{background:rgba(233,69,96,0.08);border:1px solid rgba(233,69,96,0.2);color:#E94560;padding:8px 12px;margin:8px 12px;border-radius:6px;font-size:12px}

@media(max-width:768px){.sidebar{width:180px}.sidebar.collapsed{margin-left:-180px}.chat-bubble{max-width:90%}}
@media(max-width:480px){.sidebar{display:none}.sidebar-toggle{display:none}}
`;

export function workspacePageHTML(data: WorkspacePageData): string {
  const clientData = {
    hash: data.hash,
    worktreeId: data.session.worktree_id || "",
    status: data.session.status || "unknown",
    user: data.session.user || "unknown",
    exitCode: data.session.exit_code,
    logUrl: data.session.log_url || "",
    baseBranch: data.session.base_branch || "next",
    worktreeAlive: data.worktreeAlive,
    sessions: data.sessions.map(s => ({
      log_id: s._log_id, status: s.status, started: s.started, user: s.user,
      prompt: s.prompt, log_url: s.log_url,
    })),
    // Activity comes via SSE after auth, not in HTML
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

function linkify(s){
  s=s.replace(/\\[([^\\]]+)\\]\\((https?:\\/\\/[^)]+)\\)/g,function(_,label,url){
    return '<a href="'+esc(url)+'" target="_blank" class="link">'+esc(label)+'</a>';
  });
  var parts=s.split(/(<a [^>]*>.*?<\\/a>)/g);
  for(var i=0;i<parts.length;i++){
    if(parts[i].indexOf('<a ')===0)continue;
    parts[i]=esc(parts[i]);
    parts[i]=parts[i].replace(/(https?:\\/\\/[^\\s&<"']+)/g,function(m){
      var u=m.replace(/[.,;:!?)}&amp;\\]]+$/,'');
      var rest=m.slice(u.length);
      for(var j=0;j<rest.length;j++){
        if(rest[j]===')'&&u.split('(').length>u.split(')').length){u+=rest[j];}else break;
      }
      return '<a href="'+u+'" target="_blank" class="link">'+u+'</a>'+m.slice(u.length);
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

// ── ChatMessage component ───────────────────────────────────────

function ChatMessage({entry, agentLogUrl}){
  const t=entry.ts?timeAgo(entry.ts):"";
  const linked=linkify(entry.text);

  if(entry.type==="response"){
    return html\`<div class="chat-msg bot"><div class="chat-avatar reply-avatar">RE</div><div class="chat-bubble reply-bubble"><div class="chat-label reply-label">reply</div><div class="chat-text" dangerouslySetInnerHTML=\${{__html:linked}}></div><div class="chat-time">\${t}</div></div></div>\`;
  }
  if(entry.type==="context"){
    return html\`<div class="chat-msg bot"><div class="chat-avatar">CB</div><div class="chat-bubble context-bubble"><div class="chat-text" dangerouslySetInnerHTML=\${{__html:linked}}></div><div class="chat-time">\${t}</div></div></div>\`;
  }
  if(entry.type==="artifact"){
    return html\`<div class="chat-msg bot"><div class="chat-avatar">CB</div><div class="chat-bubble artifact-bubble"><div class="chat-label artifact-label">artifact</div><div class="chat-text" dangerouslySetInnerHTML=\${{__html:linked}}></div><div class="chat-time">\${t}</div></div></div>\`;
  }
  if(entry.type==="agent_start"){
    const agentInner=agentLogUrl
      ?'<a href="'+esc(agentLogUrl)+'" target="_blank" class="link">Agent: '+linked+'</a>'
      :'Agent: '+linked;
    return html\`<div class="chat-agent"><div class="agent-dot"></div><span dangerouslySetInnerHTML=\${{__html:agentInner}}></span><span class="dim" style="margin-left:auto;font-size:10px">\${t}</span></div>\`;
  }
  if(entry.type==="tool_use"){
    return html\`<div class="chat-status"><span class="tool-icon">\u25B8</span><code dangerouslySetInnerHTML=\${{__html:linked}}></code><span class="ts">\${t}</span></div>\`;
  }
  if(entry.type==="status"){
    return html\`<div class="chat-status"><span class="tool-icon">\u25CB</span><span dangerouslySetInnerHTML=\${{__html:linked}}></span><span class="ts">\${t}</span></div>\`;
  }
  return html\`<div class="chat-status"><span class="tool-icon">\u00B7</span><span dangerouslySetInnerHTML=\${{__html:linked}}></span><span class="ts">\${t}</span></div>\`;
}

// ── UserMessage component ───────────────────────────────────────

function UserMessage({text, time, user}){
  return html\`<div class="chat-msg user"><div class="chat-bubble user-bubble"><div class="chat-text">\${text}</div><div class="chat-time">\${time||"just now"}</div></div><div class="chat-avatar user-avatar">\${(user||"YOU").slice(0,2).toUpperCase()}</div></div>\`;
}

// ── RunDivider component ────────────────────────────────────────

function RunDivider({index, status, exitCode, logUrl}){
  const exitStr=exitCode!=null?" exit="+exitCode:"";
  return html\`<div class="chat-run"><span class="run-line"></span><span class="run-label">Run \${index}</span><span class="status-\${status||"unknown"}">\${status||"?"}\${exitStr}</span>\${logUrl?html\` <a href=\${logUrl} target="_blank" class="link">log</a>\`:null}<span class="run-line"></span></div>\`;
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

function SidebarToggle({open, onToggle}){
  return html\`<button class="sidebar-toggle" onClick=\${onToggle} title="Toggle sidebar">\u2630</button>\`;
}

function Sidebar({open, status, exitCode, user, baseBranch, logUrl, sessions, artifacts}){
  return html\`<div class=\${"sidebar"+(open?"":" collapsed")}>
    <div class="sidebar-section">
      <div class="sidebar-label">Workspace</div>
      <div class="stat-row"><span class="dim">status</span> <span class=\${"status-"+status}>\${status}\${exitCode!=null?" ("+exitCode+")":""}</span></div>
      <div class="stat-row"><span class="dim">user</span> \${user}</div>
      <div class="stat-row"><span class="dim">branch</span> \${baseBranch}</div>
      <div class="stat-row"><span class="dim">runs</span> \${sessions.length}</div>
      \${sessions.length&&sessions[0].started?html\`<div class="stat-row"><span class="dim">started</span> \${timeAgo(sessions[0].started)}</div>\`:null}
      \${logUrl?html\`<div class="stat-row"><span class="dim">log</span> <a href=\${logUrl} target="_blank" class="link">view</a></div>\`:null}
    </div>
    \${artifacts.length?html\`<div class="sidebar-section">
      <div class="sidebar-label">Artifacts (\${artifacts.length})</div>
      \${artifacts.map((a,i)=>{
        const raw=a.text.replace(/^- /,"");
        const truncated=raw.length>120?raw.slice(0,120)+"\u2026":raw;
        return html\`<div class="artifact-row" key=\${i} dangerouslySetInnerHTML=\${{__html:linkify(truncated)}}></div>\`;
      })}
    </div>\`:null}
    \${sessions.length>1?html\`<div class="sidebar-section">
      <div class="sidebar-label">Session History</div>
      \${sessions.map((s,i)=>html\`<div class="session-entry" key=\${s.log_id||i}>
        <span class=\${"status-"+(s.status||"unknown")}>\${s.status||"?"}</span>
        \${s.log_url?html\`<a href=\${s.log_url} target="_blank">\${s.started?timeAgo(s.started):"#"+(i+1)}</a>\`:html\`<span class="dim">\${s.started?timeAgo(s.started):"#"+(i+1)}</span>\`}
      </div>\`)}
    </div>\`:null}
  </div>\`;
}

// ── ChatArea component ──────────────────────────────────────────

function ChatArea({timeline, isRunning}){
  const chatRef=useRef(null);
  const prevLen=useRef(0);

  useEffect(()=>{
    if(chatRef.current&&timeline.length>prevLen.current){
      chatRef.current.scrollTop=chatRef.current.scrollHeight;
    }
    prevLen.current=timeline.length;
  },[timeline.length]);

  // Initial scroll
  useEffect(()=>{
    if(chatRef.current){
      requestAnimationFrame(()=>{
        chatRef.current.scrollTop=chatRef.current.scrollHeight;
        setTimeout(()=>{if(chatRef.current)chatRef.current.scrollTop=chatRef.current.scrollHeight;},200);
      });
    }
  },[]);

  if(!timeline.length&&!isRunning){
    return html\`<div class="chat-area" ref=\${chatRef}><div class="chat-empty">No activity yet</div></div>\`;
  }

  return html\`<div class="chat-area" ref=\${chatRef}>
    \${timeline.map((entry,i)=>{
      if(entry.kind==="run")return html\`<\${RunDivider} key=\${"r"+i} index=\${entry.index} status=\${entry.status} exitCode=\${entry.exitCode} logUrl=\${entry.logUrl} />\`;
      if(entry.kind==="user")return html\`<\${UserMessage} key=\${"u"+i} text=\${entry.text} time=\${entry.time} user=\${entry.user} />\`;
      if(entry.kind==="activity")return html\`<\${ChatMessage} key=\${"a"+i+"-"+entry.id} entry=\${entry.entry} agentLogUrl=\${entry.agentLogUrl} />\`;
      return null;
    })}
    \${isRunning?html\`<\${TypingIndicator} />\`:null}
  </div>\`;
}

// ── WorkspacePage component ─────────────────────────────────────

function WorkspacePage(){
  const id=D.worktreeId||D.hash;
  const shortId=(D.worktreeId||D.hash).slice(0,8);

  const [status,setStatus]=useState(D.status);
  const [exitCode,setExitCode]=useState(D.exitCode);
  const [timeline,setTimeline]=useState([]);
  const [artifacts,setArtifacts]=useState([]);
  const [sidebarOpen,setSidebarOpen]=useState(()=>sessionStorage.getItem("cb_sidebar")==="open");
  const [messageQueue,setMessageQueue]=useState(()=>{
    try{return JSON.parse(localStorage.getItem("cb_queue_"+id)||"[]");}catch(e){return[];}
  });

  const isRunning=status==="running"||status==="interactive";
  const seenRef=useRef(new Set());
  const agentLogUrlsRef=useRef([]);
  const pendingQueueRef=useRef(messageQueue);

  // Keep pendingQueueRef in sync
  useEffect(()=>{pendingQueueRef.current=messageQueue;},[messageQueue]);

  // Persist sidebar state
  const toggleSidebar=useCallback(()=>{
    setSidebarOpen(prev=>{
      const next=!prev;
      sessionStorage.setItem("cb_sidebar",next?"open":"closed");
      return next;
    });
  },[]);

  // Persist message queue
  useEffect(()=>{
    localStorage.setItem("cb_queue_"+id,JSON.stringify(messageQueue));
  },[messageQueue,id]);

  // Build initial timeline from sessions (run dividers + prompts)
  const initialTimeline=useMemo(()=>{
    const items=[];
    const sessionsOldest=[...D.sessions].reverse();
    for(let i=0;i<sessionsOldest.length;i++){
      const s=sessionsOldest[i];
      const t=s.started?timeAgo(s.started):"";
      if(s.prompt){
        items.push({kind:"user",text:s.prompt,time:t,user:D.user,ts:s.started?new Date(new Date(s.started).getTime()-1).toISOString():""});
      }
      items.push({kind:"run",index:i+1,status:s.status,exitCode:s.exit_code,logUrl:s.log_url,ts:s.started||""});
    }
    return items;
  },[]);

  // Process a single activity entry
  const processEntry=useCallback((e)=>{
    if(e.type==="agent_log"){
      const m=e.text.match(/(https?:\\/\\/[^\\s]+)/);
      if(m)agentLogUrlsRef.current.push(m[1]);
      return null;
    }
    const id=msgId(e.text);
    if(seenRef.current.has(id))return null;
    seenRef.current.add(id);
    const agentLogUrl=e.type==="agent_start"?agentLogUrlsRef.current.shift():undefined;
    return {kind:"activity",entry:e,id:id,agentLogUrl:agentLogUrl,ts:e.ts||""};
  },[]);

  // Send next queued message
  const sendNextQueued=useCallback(()=>{
    const q=pendingQueueRef.current;
    if(!q.length)return;
    const msg=q[0];
    setMessageQueue(prev=>{const next=prev.slice(1);return next;});
    setTimeline(prev=>[...prev,{kind:"user",text:msg,time:"just now",user:D.user,ts:new Date().toISOString()}]);
    authFetch("/s/"+id+"/resume",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({prompt:msg})})
      .then(r=>r.json())
      .then(d=>{if(!d.ok)console.warn("Queue send failed:",d.message);})
      .catch(e=>console.warn("Queue send error:",e));
  },[id]);

  // SSE message handler
  const statusRef=useRef(status);
  useEffect(()=>{statusRef.current=status;},[status]);

  const handleSSE=useCallback((d)=>{
    if(d.type==="activity"&&d.entry){
      const item=processEntry(d.entry);
      if(item)setTimeline(prev=>[...prev,item]);
      // Update artifacts
      if(d.entry.type==="artifact"){
        setArtifacts(prev=>[...prev,d.entry]);
      }
    }else if(d.type==="status"){
      const wasRunning=statusRef.current==="running"||statusRef.current==="interactive";
      setStatus(d.status);
      setExitCode(d.exit_code);
      if(wasRunning&&d.status!=="running"&&d.status!=="interactive"){
        setTimeout(()=>sendNextQueued(),100);
      }
    }else if(d.type==="init"){
      if(Array.isArray(d.activity)){
        const newItems=[];
        for(const a of d.activity){
          const item=processEntry(a);
          if(item)newItems.push(item);
          if(a.type==="artifact"){
            setArtifacts(prev=>[...prev,a]);
          }
        }
        if(newItems.length)setTimeline(prev=>[...prev,...newItems]);
      }
      setStatus(d.status);
      setExitCode(d.exit_code);
    }
  },[processEntry,sendNextQueued]);

  useSSE(id,handleSSE);

  // Combine initial timeline + SSE timeline, sorted by ts
  const fullTimeline=useMemo(()=>{
    const all=[...initialTimeline,...timeline];
    all.sort((a,b)=>(a.ts||"").localeCompare(b.ts||""));
    return all;
  },[initialTimeline,timeline]);

  // Queue management
  const addToQueue=useCallback((text)=>{
    setMessageQueue(prev=>[...prev,text]);
  },[]);

  const removeFromQueue=useCallback((index)=>{
    setMessageQueue(prev=>prev.filter((_,i)=>i!==index));
  },[]);

  // Send message
  const handleSend=useCallback((text)=>{
    setTimeline(prev=>[...prev,{kind:"user",text:text,time:"just now",user:D.user,ts:new Date().toISOString()}]);
    setStatus("running");
    authFetch("/s/"+id+"/resume",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({prompt:text})})
      .then(r=>r.json())
      .then(d=>{
        if(!d.ok){alert(d.message||"Could not resume.");}
      })
      .catch(e=>alert("Error: "+e.message));
  },[id]);

  // Cancel session
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
    <div class="layout" style="position:relative">
      <\${SidebarToggle} open=\${sidebarOpen} onToggle=\${toggleSidebar} />
      <\${Sidebar} open=\${sidebarOpen} status=\${status} exitCode=\${exitCode} user=\${D.user} baseBranch=\${D.baseBranch} logUrl=\${D.logUrl} sessions=\${D.sessions} artifacts=\${artifacts} />
      <div class="main-area">
        <\${ChatArea} timeline=\${fullTimeline} isRunning=\${isRunning} />
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
