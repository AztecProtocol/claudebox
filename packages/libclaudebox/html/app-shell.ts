import { esc, BASE_STYLES, AUTH_STYLES } from "./shared.ts";

export interface AppShellOpts {
  title: string;
  /** Extra CSS to include */
  styles?: string;
  /** The page's Preact component code (will be in a <script type="module"> block) */
  moduleScript: string;
  /** Server-provided data to inject as window.__DATA__ */
  pageData?: any;
  /** Additional head elements */
  headExtra?: string;
}

export function appShell(opts: AppShellOpts): string {
  return `<!DOCTYPE html>
<html lang="en">
<head>
<meta charset="utf-8">
<meta name="viewport" content="width=device-width,initial-scale=1">
<title>${esc(opts.title)}</title>
<style>
${BASE_STYLES}
${AUTH_STYLES}
${opts.styles || ""}
</style>
${opts.headExtra || ""}
</head>
<body>
<div id="app"></div>
${opts.pageData ? `<script>window.__DATA__=${JSON.stringify(opts.pageData).replace(/</g, "\\u003c")};</script>` : ""}
<script type="module">
import{h,render,Component}from"https://esm.sh/preact@10.25.4";
import{useState,useEffect,useCallback,useRef,useMemo}from"https://esm.sh/preact@10.25.4/hooks";
import htm from"https://esm.sh/htm@3.1.1";
const html=htm.bind(h);

// Auth helpers
async function login(username,password){
  const r=await fetch("/login",{method:"POST",headers:{"Content-Type":"application/json"},body:JSON.stringify({username,password})});
  if(!r.ok)throw new Error("Invalid credentials");
  return true;
}
async function logout(){await fetch("/logout",{method:"POST"});location.reload();}
async function checkAuth(){const r=await fetch("/auth-check",{method:"POST"});return r.ok;}
async function authFetch(url,opts){return fetch(url,opts);}

// Login form component
function LoginForm({onSuccess}){
  const[error,setError]=useState(null);
  const[loading,setLoading]=useState(false);
  const submit=async(e)=>{
    e.preventDefault();
    setLoading(true);setError(null);
    try{
      await login(e.target.username.value,e.target.password.value);
      onSuccess();
    }catch(err){setError(err.message);}
    finally{setLoading(false);}
  };
  return html\`
    <div class="login-overlay">
      <form class="login-form" onSubmit=\${submit} autocomplete="on">
        <div class="login-title">ClaudeBox</div>
        <input name="username" type="text" autocomplete="username" placeholder="Username" class="form-input" required />
        <input name="password" type="password" autocomplete="current-password" placeholder="Password" class="form-input" required />
        <button type="submit" class="btn btn-blue" disabled=\${loading}>\${loading?"Logging in...":"Login"}</button>
        \${error && html\`<div class="form-error">\${error}</div>\`}
      </form>
    </div>
  \`;
}

// Auth wrapper — shows login form or page content
function AuthApp({children}){
  const[authed,setAuthed]=useState(null);
  useEffect(()=>{checkAuth().then(setAuthed);},[]);
  if(authed===null)return null;
  if(!authed)return html\`<\${LoginForm} onSuccess=\${()=>setAuthed(true)} />\`;
  return children;
}

// Export to page scripts
window.__preact={h,render,Component,useState,useEffect,useCallback,useRef,useMemo,html,AuthApp,LoginForm,login,logout,checkAuth,authFetch};
</script>
<script type="module">
${opts.moduleScript}
</script>
</body>
</html>`;
}
