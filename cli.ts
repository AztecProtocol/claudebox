#!/usr/bin/env -S node --experimental-strip-types --no-warnings
/**
 * ClaudeBox CLI — run sessions locally or against a remote server.
 *
 * Usage:
 *   claudebox run [--profile <name>] "fix the flaky test"
 *   claudebox resume [<worktree-id>] "continue with the fix"
 *   claudebox sessions [--user <name>] [--profile <name>]
 *   claudebox logs <worktree-id> [--follow]
 *   claudebox pull <worktree-id>
 *   claudebox push <worktree-id> [--resume <prompt>]
 *   claudebox status
 *   claudebox profiles
 *
 * Config: ~/.claudebox/config.json
 *   { "server": "https://claudebox.work", "token": "...", "password": "..." }
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";

// ── Config ──────────────────────────────────────────────────────

interface CliConfig {
  server?: string;
  token?: string;
  password?: string;  // basic auth password for dashboard/SSE APIs
  user?: string;      // default username for session pages
}

const CONFIG_DIR = join(homedir(), ".claudebox");
const CONFIG_FILE = join(CONFIG_DIR, "config.json");

function loadConfig(): CliConfig {
  try {
    if (existsSync(CONFIG_FILE)) {
      return JSON.parse(readFileSync(CONFIG_FILE, "utf-8"));
    }
  } catch {}
  return {};
}

function saveConfig(config: CliConfig): void {
  mkdirSync(CONFIG_DIR, { recursive: true });
  writeFileSync(CONFIG_FILE, JSON.stringify(config, null, 2) + "\n");
}

/** Parse --flag and --flag=value args, collecting non-flag args as positional. */
function parseArgs(args: string[], flags: Record<string, boolean>): { opts: Record<string, string>; positional: string[] } {
  const opts: Record<string, string> = {};
  const positional: string[] = [];
  for (let i = 0; i < args.length; i++) {
    const arg = args[i];
    if (arg === "--help" || arg === "-h") { opts.help = "true"; continue; }
    if (arg === "--follow" || arg === "-f") { opts.follow = "true"; continue; }
    if (arg.startsWith("--")) {
      const eqIdx = arg.indexOf("=");
      if (eqIdx > 0) {
        opts[arg.slice(2, eqIdx)] = arg.slice(eqIdx + 1);
      } else if (flags[arg.slice(2)]) {
        opts[arg.slice(2)] = "true";
      } else if (i + 1 < args.length) {
        opts[arg.slice(2)] = args[++i];
      }
    } else {
      positional.push(arg);
    }
  }
  return { opts, positional };
}

/** Resolve server connection from args/env/config. */
function resolveServer(opts: Record<string, string>): { url: string; token: string; password: string; user: string } {
  const config = loadConfig();
  return {
    url: (opts.server || config.server || process.env.CLAUDEBOX_SERVER_URL || "").replace(/\/$/, ""),
    token: opts.token || config.token || process.env.CLAUDEBOX_SERVER_TOKEN || "",
    password: opts.password || config.password || process.env.CLAUDEBOX_SESSION_PASS || "",
    user: opts.user || config.user || process.env.CLAUDEBOX_SESSION_USER || "admin",
  };
}

function basicAuthHeader(user: string, password: string): string {
  return "Basic " + Buffer.from(`${user}:${password}`).toString("base64");
}

// ── Commands ────────────────────────────────────────────────────

async function runCommand(args: string[]): Promise<void> {
  const { opts, positional } = parseArgs(args, { follow: true });
  if (opts.help) {
    console.log(`Usage: claudebox run [options] <prompt>

Options:
  --profile <name>    Profile to run (default: "default")
  --model <model>     Claude model (e.g. claude-haiku-4-5-20251001)
  --server <url>      ClaudeBox server URL
  --token <token>     Server API token
  --worktree <id>     Resume an existing worktree
  --follow, -f        Stream session output (remote mode)

Config file: ${CONFIG_FILE}
  { "server": "https://claudebox.work", "token": "..." }
`);
    return;
  }

  const profile = opts.profile || "default";
  const model = opts.model || "";
  const worktreeId = opts.worktree || "";
  const prompt = positional.join(" ").trim();
  const follow = opts.follow === "true";
  const server = resolveServer(opts);

  if (!prompt) {
    console.error("Error: prompt required. Usage: claudebox run [--profile <name>] <prompt>");
    process.exit(1);
  }

  // Remote mode
  if (server.url) {
    console.log(`Server: ${server.url}`);
    console.log(`Profile: ${profile}`);
    console.log(`Prompt: ${prompt.slice(0, 100)}${prompt.length > 100 ? "..." : ""}`);

    const res = await fetch(`${server.url}/run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${server.token}`,
      },
      body: JSON.stringify({
        prompt,
        profile,
        model: model || undefined,
        worktree_id: worktreeId || undefined,
        user: process.env.USER || "cli",
      }),
    });

    const data = await res.json() as any;
    if (!res.ok) {
      console.error(`Server error (${res.status}): ${data.error || JSON.stringify(data)}`);
      process.exit(1);
    }

    const sessionWtId = data.worktree_id || worktreeId;
    console.log(`Session started.${model ? ` (model: ${model})` : ""}`);
    if (data.log_url) console.log(`  CI log:  ${data.log_url}`);
    if (sessionWtId) console.log(`  Status:  ${server.url}/s/${sessionWtId}`);
    if (sessionWtId) console.log(`  Resume:  claudebox resume ${sessionWtId} "<prompt>"`);

    if (follow && sessionWtId && server.password) {
      // Wait briefly for session to start, then stream
      await new Promise(r => setTimeout(r, 2000));
      await streamLogs(server, sessionWtId);
    }
    return;
  }

  // Local mode
  console.log("No server configured — running locally.");
  console.log(`Profile: ${profile}`);

  const rootDir = dirname(import.meta.url.replace("file://", ""));
  const { setPluginsDir, loadPlugin } = await import("./packages/libclaudebox/plugin-loader.ts");
  setPluginsDir(join(rootDir, "profiles"));
  const plugin = await loadPlugin(profile);
  if (plugin.requiresServer) {
    console.error(`Error: profile "${profile}" requires a claudebox server.`);
    console.error(`Configure one in ${CONFIG_FILE} or pass --server <url>.`);
    process.exit(1);
  }

  const { SessionStore } = await import("./packages/libclaudebox/session-store.ts");
  const { DockerService } = await import("./packages/libclaudebox/docker.ts");

  const store = new SessionStore();
  const docker = new DockerService();

  const exitCode = await docker.runContainerSession({
    prompt,
    userName: process.env.USER || "cli",
    worktreeId: worktreeId || undefined,
    profile,
    model: model || undefined,
  }, store, (data) => {
    process.stdout.write(data);
  }, (logUrl, wId) => {
    console.log(`Log: ${logUrl}`);
    console.log(`Worktree: ${wId}`);
  });

  process.exit(exitCode);
}

async function resumeCommand(args: string[]): Promise<void> {
  const { opts, positional } = parseArgs(args, { follow: true });
  if (opts.help) {
    console.log(`Usage: claudebox resume [<worktree-id>] [options] <prompt>

Resume an existing session. If no worktree ID given, shows recent sessions to pick from.

Options:
  --follow, -f    Stream session output (remote mode)
`);
    return;
  }

  const server = resolveServer(opts);
  const follow = opts.follow === "true";

  // First positional arg could be a worktree ID (16-hex) or part of prompt
  let worktreeId = "";
  let promptParts = [...positional];
  if (positional.length > 0 && /^[a-f0-9]{16}$/.test(positional[0])) {
    worktreeId = positional[0];
    promptParts = positional.slice(1);
  }

  // If no worktree ID, list recent sessions to pick from
  if (!worktreeId) {
    if (!server.url) {
      // Local mode: list from session store
      const { SessionStore } = await import("./packages/libclaudebox/session-store.ts");
      const store = new SessionStore();
      const sessions = store.listAll().slice(0, 10);
      if (sessions.length === 0) {
        console.log("No sessions found.");
        process.exit(1);
      }
      console.log("Recent sessions:\n");
      for (const s of sessions) {
        const wtId = s.worktree_id || s._log_id || "?";
        const status = s.status || "?";
        const prompt = (s.prompt || "").slice(0, 60);
        const user = s.user || "?";
        const date = s.started ? new Date(s.started).toLocaleDateString() : "?";
        console.log(`  ${wtId}  ${status.padEnd(10)}  ${user.padEnd(12)}  ${date}  ${prompt}`);
      }
      console.log("\nUsage: claudebox resume <worktree-id> <prompt>");
      return;
    }

    // Remote mode: list from server dashboard API
    if (!server.password) {
      console.error("Error: --password or config.password required to list sessions.");
      process.exit(1);
    }
    const res = await fetch(`${server.url}/api/dashboard`, {
      headers: { Authorization: basicAuthHeader(server.user, server.password) },
    });
    if (!res.ok) {
      console.error(`Server error (${res.status}): ${await res.text()}`);
      process.exit(1);
    }
    const data = await res.json() as any;
    const workspaces = (data.workspaces || []).slice(0, 15);
    if (workspaces.length === 0) {
      console.log("No sessions found.");
      return;
    }
    console.log("Recent sessions:\n");
    console.log("  ID                  STATUS      USER          PROFILE       PROMPT");
    console.log("  " + "─".repeat(85));
    for (const w of workspaces) {
      const id = (w.worktreeId || "?").slice(0, 16).padEnd(18);
      const status = (w.status || "?").padEnd(10);
      const user = (w.user || "?").padEnd(12);
      const profile = (w.profile || "default").padEnd(12);
      const prompt = (w.prompt || "").slice(0, 40);
      console.log(`  ${id}  ${status}  ${user}  ${profile}  ${prompt}`);
    }
    console.log("\nUsage: claudebox resume <worktree-id> <prompt>");
    return;
  }

  const prompt = promptParts.join(" ").trim();
  if (!prompt) {
    console.error("Error: prompt required. Usage: claudebox resume <worktree-id> <prompt>");
    process.exit(1);
  }

  if (server.url) {
    // Remote resume via POST /run with worktree_id
    const res = await fetch(`${server.url}/run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${server.token}`,
      },
      body: JSON.stringify({
        prompt,
        worktree_id: worktreeId,
        user: process.env.USER || "cli",
      }),
    });
    const data = await res.json() as any;
    if (!res.ok) {
      console.error(`Server error (${res.status}): ${data.error || JSON.stringify(data)}`);
      process.exit(1);
    }
    console.log(`Resumed.`);
    if (data.log_url) console.log(`  CI log:  ${data.log_url}`);
    console.log(`  Status:  ${server.url}/s/${worktreeId}`);
    if (follow && server.password) {
      await new Promise(r => setTimeout(r, 2000));
      await streamLogs(server, worktreeId);
    }
    return;
  }

  // Local resume
  const { SessionStore } = await import("./packages/libclaudebox/session-store.ts");
  const { DockerService } = await import("./packages/libclaudebox/docker.ts");
  const store = new SessionStore();
  const docker = new DockerService();
  const session = store.findByWorktreeId(worktreeId);

  const exitCode = await docker.runContainerSession({
    prompt,
    userName: process.env.USER || "cli",
    worktreeId,
    profile: session?.profile || undefined,
  }, store, (data) => {
    process.stdout.write(data);
  }, (logUrl, wId) => {
    console.log(`Log: ${logUrl}`);
    console.log(`Worktree: ${wId}`);
  });

  process.exit(exitCode);
}

async function sessionsCommand(args: string[]): Promise<void> {
  const { opts } = parseArgs(args, {});
  if (opts.help) {
    console.log(`Usage: claudebox sessions [options]

List recent sessions.

Options:
  --user <name>       Filter by user
  --profile <name>    Filter by profile
  --limit <n>         Number of sessions (default: 20)
`);
    return;
  }

  const server = resolveServer(opts);
  const limit = parseInt(opts.limit || "20", 10);
  const userFilter = opts.user || "";
  const profileFilter = opts.profile || "";

  if (server.url) {
    if (!server.password) {
      console.error("Error: --password or config.password required.");
      process.exit(1);
    }
    const url = new URL(`${server.url}/api/dashboard`);
    if (profileFilter) url.searchParams.set("profile", profileFilter);
    const res = await fetch(url.toString(), {
      headers: { Authorization: basicAuthHeader(server.user, server.password) },
    });
    if (!res.ok) {
      console.error(`Server error (${res.status}): ${await res.text()}`);
      process.exit(1);
    }
    const data = await res.json() as any;
    let workspaces = data.workspaces || [];
    if (userFilter) {
      workspaces = workspaces.filter((w: any) => w.user === userFilter);
    }
    workspaces = workspaces.slice(0, limit);

    if (workspaces.length === 0) {
      console.log("No sessions found.");
      return;
    }

    console.log(`Server: ${server.url}  (${data.activeCount}/${data.maxConcurrent} active)\n`);
    console.log("  ID                  STATUS      USER          RUNS  PROFILE       PROMPT");
    console.log("  " + "─".repeat(90));
    for (const w of workspaces) {
      const id = (w.worktreeId || "?").slice(0, 16).padEnd(18);
      const status = (w.status || "?").padEnd(10);
      const user = (w.user || "?").padEnd(12);
      const runs = String(w.runCount || 1).padEnd(4);
      const profile = (w.profile || "default").padEnd(12);
      const prompt = (w.prompt || "").slice(0, 35);
      console.log(`  ${id}  ${status}  ${user}  ${runs}  ${profile}  ${prompt}`);
    }
    return;
  }

  // Local mode
  const { SessionStore } = await import("./packages/libclaudebox/session-store.ts");
  const store = new SessionStore();
  let sessions = store.listAll();
  if (userFilter) sessions = sessions.filter(s => s.user === userFilter);
  if (profileFilter) sessions = sessions.filter(s => (s.profile || "") === profileFilter);
  sessions = sessions.slice(0, limit);

  if (sessions.length === 0) {
    console.log("No sessions found.");
    return;
  }

  console.log("  ID                  STATUS      USER          PROFILE       PROMPT");
  console.log("  " + "─".repeat(85));
  for (const s of sessions) {
    const id = (s.worktree_id || s._log_id || "?").padEnd(18);
    const status = (s.status || "?").padEnd(10);
    const user = (s.user || "?").padEnd(12);
    const profile = (s.profile || "default").padEnd(12);
    const prompt = (s.prompt || "").slice(0, 35);
    console.log(`  ${id}  ${status}  ${user}  ${profile}  ${prompt}`);
  }
}

async function logsCommand(args: string[]): Promise<void> {
  const { opts, positional } = parseArgs(args, { follow: true });
  if (opts.help || positional.length === 0) {
    console.log(`Usage: claudebox logs <worktree-id> [options]

Stream activity logs for a session.

Options:
  --follow, -f    Keep streaming new activity (SSE)
`);
    if (!opts.help) process.exit(1);
    return;
  }

  const worktreeId = positional[0];
  const follow = opts.follow === "true";
  const server = resolveServer(opts);

  if (server.url) {
    if (!server.password) {
      console.error("Error: --password or config.password required for log streaming.");
      process.exit(1);
    }
    if (follow) {
      await streamLogs(server, worktreeId);
    } else {
      // Fetch current activity snapshot
      const res = await fetch(`${server.url}/s/${worktreeId}/activity`, {
        headers: { Authorization: basicAuthHeader(server.user, server.password) },
      });
      if (!res.ok) {
        console.error(`Error (${res.status}): ${await res.text()}`);
        process.exit(1);
      }
      const data = await res.json() as any;
      console.log(`Session: ${worktreeId}  Status: ${data.status}  Exit: ${data.exit_code ?? "—"}\n`);
      for (const entry of (data.activity || [])) {
        printActivityEntry(entry);
      }
    }
    return;
  }

  // Local mode
  const { SessionStore } = await import("./packages/libclaudebox/session-store.ts");
  const store = new SessionStore();
  const activity = store.readActivity(worktreeId);
  if (activity.length === 0) {
    console.log("No activity found for this session.");
    return;
  }
  for (const entry of activity.reverse()) {
    printActivityEntry(entry);
  }
}

/** Stream SSE logs from server. */
async function streamLogs(server: { url: string; user: string; password: string }, worktreeId: string): Promise<void> {
  const res = await fetch(`${server.url}/s/${worktreeId}/events`, {
    headers: { Authorization: basicAuthHeader(server.user, server.password) },
  });

  if (!res.ok) {
    console.error(`Error connecting to SSE (${res.status})`);
    return;
  }

  const reader = res.body?.getReader();
  if (!reader) return;

  const decoder = new TextDecoder();
  let buffer = "";

  while (true) {
    const { done, value } = await reader.read();
    if (done) break;

    buffer += decoder.decode(value, { stream: true });
    const lines = buffer.split("\n");
    buffer = lines.pop() || "";

    for (const line of lines) {
      if (line.startsWith("data: ")) {
        try {
          const event = JSON.parse(line.slice(6));
          if (event.type === "init") {
            console.log(`Session: ${worktreeId}  Status: ${event.status}\n`);
            for (const entry of (event.activity || [])) {
              printActivityEntry(entry);
            }
          } else if (event.type === "activity" && event.entry) {
            printActivityEntry(event.entry);
          } else if (event.type === "status") {
            if (event.status === "completed" || event.status === "error") {
              console.log(`\n[${event.status}] exit=${event.exit_code ?? "?"}`);
              return;
            }
          }
        } catch {}
      }
    }
  }
}

function printActivityEntry(entry: any): void {
  const prefix = {
    response: "CLAUDE",
    tool_use: "TOOL",
    artifact: "ARTIFACT",
    agent_start: "AGENT",
    agent_log: "AGENT",
    name: "NAME",
    status: "STATUS",
  }[entry.type as string] || entry.type?.toUpperCase() || "?";

  const text = (entry.text || "").trim();
  if (!text) return;

  // Truncate very long responses for CLI readability
  const maxLen = 500;
  const display = text.length > maxLen ? text.slice(0, maxLen) + "..." : text;
  console.log(`[${prefix}] ${display}`);
}

async function statusCommand(args: string[]): Promise<void> {
  const { opts } = parseArgs(args, {});
  const server = resolveServer(opts);

  if (server.url) {
    const res = await fetch(`${server.url}/health`);
    const data = await res.json() as any;
    console.log(`Server: ${server.url}`);
    console.log(`Status: ${data.status || "unknown"}`);
    console.log(`Active sessions: ${data.active ?? "?"} / ${data.max ?? "?"}`);
    return;
  }

  console.log("No server configured. Status only available with a server.");
  console.log(`Configure in ${CONFIG_FILE}`);
}

async function profilesCommand(): Promise<void> {
  const rootDir = dirname(import.meta.url.replace("file://", ""));
  const { setPluginsDir, discoverPlugins, loadPlugin } = await import("./packages/libclaudebox/plugin-loader.ts");
  setPluginsDir(join(rootDir, "profiles"));

  const names = discoverPlugins();
  if (names.length === 0) {
    console.log("No profiles found.");
    return;
  }

  console.log("Available profiles:\n");
  for (const name of names) {
    const p = await loadPlugin(name);
    const flags: string[] = [];
    if (p.requiresServer) flags.push("requires-server");
    if (p.channels?.length) flags.push(`channels: ${p.channels.join(", ")}`);
    console.log(`  ${name}${flags.length ? ` (${flags.join(", ")})` : ""}`);
  }
}

async function pullCommand(args: string[]): Promise<void> {
  const { opts, positional } = parseArgs(args, {});
  if (opts.help || positional.length === 0) {
    console.log(`Usage: claudebox pull <worktree-id>

Download a remote session's conversation history for local continuation.

Files are saved to ~/.claudebox/worktrees/<id>/claude-projects/
`);
    return;
  }

  const worktreeId = positional[0];
  const server = resolveServer(opts);
  if (!server.url || !server.token) {
    console.error("Error: server URL and token required. Configure with: claudebox config server <url>");
    process.exit(1);
  }

  console.log(`Pulling session ${worktreeId} from ${server.url}...`);

  const res = await fetch(`${server.url}/session/${worktreeId}/bundle`, {
    headers: { Authorization: `Bearer ${server.token}` },
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error(`Error (${res.status}): ${text || "failed to download bundle"}`);
    process.exit(1);
  }

  const localDir = join(CONFIG_DIR, "worktrees", worktreeId, "claude-projects");
  mkdirSync(localDir, { recursive: true });

  // Write tar to disk, then extract
  const { execFileSync } = await import("child_process");
  const tarData = Buffer.from(await res.arrayBuffer());
  execFileSync("tar", ["-x", "-C", localDir], { input: tarData });

  const profile = res.headers.get("X-Session-Profile") || "default";
  // Save session metadata locally
  writeFileSync(join(CONFIG_DIR, "worktrees", worktreeId, "meta.json"), JSON.stringify({
    worktree_id: worktreeId,
    profile,
    server: server.url,
    pulled_at: new Date().toISOString(),
  }, null, 2) + "\n");

  console.log(`Downloaded to ${localDir}`);
  console.log(`Profile: ${profile}`);
  console.log(`\nTo continue locally:`);
  console.log(`  cd ${localDir} && claude --resume`);
  console.log(`\nTo push changes back:`);
  console.log(`  claudebox push ${worktreeId} --resume "continue with the fix"`);
}

async function pushCommand(args: string[]): Promise<void> {
  const { opts, positional } = parseArgs(args, {});
  if (opts.help || positional.length === 0) {
    console.log(`Usage: claudebox push <worktree-id> [--resume <prompt>]

Upload local session changes back to the server.

Options:
  --resume <prompt>   After uploading, enqueue a resume with this prompt

Files are read from ~/.claudebox/worktrees/<id>/claude-projects/
`);
    return;
  }

  const worktreeId = positional[0];
  const resumePrompt = opts.resume || "";
  const server = resolveServer(opts);
  if (!server.url || !server.token) {
    console.error("Error: server URL and token required. Configure with: claudebox config server <url>");
    process.exit(1);
  }

  const localDir = join(CONFIG_DIR, "worktrees", worktreeId, "claude-projects");
  if (!existsSync(localDir)) {
    console.error(`Error: no local session data at ${localDir}`);
    console.error(`Run 'claudebox pull ${worktreeId}' first.`);
    process.exit(1);
  }

  console.log(`Pushing session ${worktreeId} to ${server.url}...`);

  const { execFileSync } = await import("child_process");
  const tarData = execFileSync("tar", ["-c", "-C", localDir, "."], { maxBuffer: 50 * 1024 * 1024 });

  const res = await fetch(`${server.url}/session/${worktreeId}/bundle`, {
    method: "POST",
    headers: {
      "Content-Type": "application/x-tar",
      Authorization: `Bearer ${server.token}`,
    },
    body: tarData,
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error(`Error (${res.status}): ${text || "failed to upload bundle"}`);
    process.exit(1);
  }

  console.log(`Uploaded session data.`);

  if (resumePrompt) {
    console.log(`Resuming with: ${resumePrompt.slice(0, 80)}...`);
    const resumeRes = await fetch(`${server.url}/run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${server.token}`,
      },
      body: JSON.stringify({
        prompt: resumePrompt,
        worktree_id: worktreeId,
        user: process.env.USER || "cli",
      }),
    });
    const data = await resumeRes.json() as any;
    if (!resumeRes.ok) {
      console.error(`Resume error (${resumeRes.status}): ${data.error || JSON.stringify(data)}`);
      process.exit(1);
    }
    console.log(`Resumed.`);
    if (data.log_url) console.log(`  CI log:  ${data.log_url}`);
    console.log(`  Status:  ${server.url}/s/${worktreeId}`);
  }
}

async function guideCommand(args: string[]): Promise<void> {
  const { opts, positional } = parseArgs(args, { "no-push": true });
  if (opts.help || positional.length === 0) {
    console.log(`Usage: claudebox guide <worktree-id> [options]

Pull a remote session, run Claude locally to review it and ask guiding
questions, then push the updated session back and optionally resume.

Options:
  --model <model>     Claude model to use
  --resume <prompt>   After guide, push back and resume with this prompt
  --no-push           Don't push changes back to server

Env:
  MOCK_CLAUDE=<path>  Use a mock binary instead of Docker (for testing)
`);
    return;
  }

  const worktreeId = positional[0];
  const server = resolveServer(opts);
  const claudeBin = opts.claude || "claude";
  const model = opts.model || "";
  const resumePrompt = opts.resume || "";
  const noPush = opts["no-push"] === "true";
  const localDir = join(CONFIG_DIR, "worktrees", worktreeId, "claude-projects");

  // Step 1: Pull session if we have a server and no local copy
  if (server.url && server.token && !existsSync(localDir)) {
    console.log(`Pulling session ${worktreeId}...`);
    const res = await fetch(`${server.url}/session/${worktreeId}/bundle`, {
      headers: { Authorization: `Bearer ${server.token}` },
    });
    if (!res.ok) {
      console.error(`Pull failed (${res.status}): ${await res.text().catch(() => "")}`);
      process.exit(1);
    }
    mkdirSync(localDir, { recursive: true });
    const { execFileSync } = await import("child_process");
    execFileSync("tar", ["-x", "-C", localDir], { input: Buffer.from(await res.arrayBuffer()) });
    console.log(`Downloaded to ${localDir}`);
  } else if (!existsSync(localDir)) {
    console.error(`No local session at ${localDir} and no server configured.`);
    console.error(`Run 'claudebox pull ${worktreeId}' first, or configure a server.`);
    process.exit(1);
  }

  // Step 2: Find latest session ID from JSONL files
  const { readdirSync, statSync } = await import("fs");
  let sessionId = "";
  try {
    const files = readdirSync(localDir)
      .filter((f: string) => f.endsWith(".jsonl"))
      .map((f: string) => ({ name: f, mtime: statSync(join(localDir, f)).mtimeMs }))
      .sort((a: { mtime: number }, b: { mtime: number }) => b.mtime - a.mtime);
    if (files.length > 0) {
      sessionId = files[0].name.replace(".jsonl", "");
    }
  } catch {}

  // Step 3: Build the guide prompt
  const guidePrompt = `You are reviewing an existing Claude Code session. Your job is to:
1. Read through the conversation history to understand what was done
2. Summarize the current state of work
3. Ask the operator 2-4 specific questions about direction, priorities, or decisions needed
4. Frame questions as clear choices where possible

Be concise. Focus on decisions that are blocking progress.`;

  // Step 4: Run claude in a Docker container
  console.log(`\nStarting guide session...`);
  if (sessionId) console.log(`  Resuming session: ${sessionId}`);

  const { spawn } = await import("child_process");

  // Build claude command args
  const claudeInternalArgs = ["--print", "-p", guidePrompt];
  if (sessionId) claudeInternalArgs.push("--resume", sessionId);
  if (model) claudeInternalArgs.push("--model", model);

  // MOCK_CLAUDE env var: run directly without Docker (for testing)
  const useMock = process.env.MOCK_CLAUDE;
  let exitCode: number;
  if (useMock) {
    exitCode = await new Promise<number>((resolve) => {
      const proc = spawn(useMock, claudeInternalArgs, {
        stdio: "inherit",
        cwd: localDir,
        env: { ...process.env, CLAUDEBOX_PROJECTS_DIR: localDir },
      });
      proc.on("error", (err: Error) => { console.error(`Failed to start mock: ${err.message}`); resolve(1); });
      proc.on("close", (code: number | null) => resolve(code ?? 1));
    });
  } else {
    // Run claude in a Docker container
    const { realpathSync: realpath } = await import("fs");
    const { loadUserSettings } = await import("./packages/libclaudebox/settings.ts");

    const settings = loadUserSettings();
    const containerImage = settings.image || process.env.CLAUDEBOX_DOCKER_IMAGE || "devbox:latest";
    const containerUser = settings.containerUser || process.env.CLAUDEBOX_CONTAINER_USER || "claude";
    const containerHome = `/home/${containerUser}`;
    const claudeBinPath = process.env.CLAUDE_BINARY || join(homedir(), ".local", "bin", "claude");

    const dockerArgs = [
      "run", "--rm",
      "-e", `HOME=${containerHome}`,
      "-v", `${localDir}:${containerHome}/.claude/projects/-workspace:rw`,
      "-v", `${realpath(claudeBinPath)}:/usr/local/bin/claude:ro`,
      "-v", `${join(homedir(), ".claude")}:${containerHome}/.claude:rw`,
      ...(existsSync(join(homedir(), ".claude.json"))
        ? ["-v", `${join(homedir(), ".claude.json")}:${containerHome}/.claude.json:rw`]
        : []),
      "-w", "/workspace",
      containerImage,
      "claude", ...claudeInternalArgs,
    ];

    exitCode = await new Promise<number>((resolve) => {
      const proc = spawn("docker", dockerArgs, { stdio: "inherit" });
      proc.on("error", (err: Error) => { console.error(`Failed to start docker: ${err.message}`); resolve(1); });
      proc.on("close", (code: number | null) => resolve(code ?? 1));
    });
  }

  if (exitCode !== 0) {
    console.error(`\nClaude exited with code ${exitCode}`);
  }

  // Step 5: Push back if configured
  if (!noPush && server.url && server.token) {
    console.log(`\nPushing session back to ${server.url}...`);
    const { execFileSync } = await import("child_process");
    const tarData = execFileSync("tar", ["-c", "-C", localDir, "."], { maxBuffer: 50 * 1024 * 1024 });
    const pushRes = await fetch(`${server.url}/session/${worktreeId}/bundle`, {
      method: "POST",
      headers: { "Content-Type": "application/x-tar", Authorization: `Bearer ${server.token}` },
      body: tarData,
    });
    if (!pushRes.ok) {
      console.error(`Push failed (${pushRes.status}): ${await pushRes.text().catch(() => "")}`);
    } else {
      console.log(`Pushed session data.`);
    }

    // Optionally resume on server
    if (resumePrompt) {
      const resumeRes = await fetch(`${server.url}/run`, {
        method: "POST",
        headers: { "Content-Type": "application/json", Authorization: `Bearer ${server.token}` },
        body: JSON.stringify({ prompt: resumePrompt, worktree_id: worktreeId, user: process.env.USER || "cli" }),
      });
      if (resumeRes.ok) {
        const data = await resumeRes.json() as any;
        console.log(`Resumed on server.`);
        if (data.log_url) console.log(`  CI log:  ${data.log_url}`);
        console.log(`  Status:  ${server.url}/s/${worktreeId}`);
      }
    }
  }

  process.exit(exitCode);
}

async function serveCommand(args: string[]): Promise<void> {
  const { opts } = parseArgs(args, {});
  if (opts.help) {
    console.log(`Usage: claudebox serve [options]

Start a local HTTP-only ClaudeBox server (no Slack).

Options:
  --port <n>          HTTP port (default: 3000, or CLAUDEBOX_HTTP_PORT)
  --profiles <list>   Comma-separated profile names to load
  --password <pass>   Session page password (or CLAUDEBOX_SESSION_PASS)
  --token <token>     API bearer token (or CLAUDEBOX_API_SECRET)

The server is meant to be accessed over SSH tunnel or localhost.
`);
    return;
  }

  const port = opts.port || process.env.CLAUDEBOX_HTTP_PORT || "3000";
  const password = opts.password || process.env.CLAUDEBOX_SESSION_PASS || "";
  const token = opts.token || process.env.CLAUDEBOX_API_SECRET || "";
  const profiles = opts.profiles || "";

  if (!password) {
    console.error("Error: password required. Pass --password <pass> or set CLAUDEBOX_SESSION_PASS.");
    process.exit(1);
  }

  // Set env vars before importing server
  process.env.CLAUDEBOX_HTTP_PORT = port;
  process.env.CLAUDEBOX_SESSION_PASS = password;
  if (token) process.env.CLAUDEBOX_API_SECRET = token;
  process.env.CLAUDEBOX_HTTP_ONLY = "1";

  const serverArgs = ["--http-only"];
  if (profiles) serverArgs.push("--profiles", profiles);

  // Spawn server.ts as a child process so it loads cleanly
  const { spawn } = await import("child_process");
  const serverPath = join(dirname(import.meta.url.replace("file://", "")), "server.ts");
  const proc = spawn(
    process.execPath,
    ["--experimental-strip-types", "--no-warnings", serverPath, ...serverArgs],
    {
      stdio: "inherit",
      env: process.env,
    },
  );

  proc.on("close", (code: number | null) => process.exit(code ?? 1));
  proc.on("error", (err: Error) => {
    console.error(`Failed to start server: ${err.message}`);
    process.exit(1);
  });
}

async function initCommand(args: string[]): Promise<void> {
  const { opts } = parseArgs(args, { "add-credentials": true, list: true });
  if (opts.help) {
    console.log(`Usage: claudebox init [options]

Set up ClaudeBox credentials for running sessions.

Options:
  --key <key>           Anthropic API key (or prompts interactively)
  --add-credentials     Add an extra API key for credential rotation
  --label <name>        Label for the key (e.g. "personal", "work")
  --budget <dollars>    Monthly budget in USD for this key (0 = unlimited)
  --list                Show all configured keys and their usage

On first run, saves credentials to ~/.claude/claudebox/credentials.json.
On subsequent runs, asks if you want to re-login.

Multiple keys are rotated automatically — when one key's budget is
exhausted, the next available key is used.

Credentials are mounted into Docker containers for Claude sessions.
`);
    return;
  }

  const { CredentialStore } = await import("./packages/libclaudebox/credentials.ts");
  const credPath = join(homedir(), ".claude", "claudebox", "credentials.json");
  const credStore = new CredentialStore(credPath);

  // List mode
  if (opts.list === "true") {
    const keys = credStore.listKeys();
    if (keys.length === 0) {
      console.log("No credentials configured. Run: claudebox init --key <key>");
      return;
    }
    const creds = credStore.load()!;
    console.log(`Credentials: ${keys.length} key(s)\n`);
    for (let i = 0; i < keys.length; i++) {
      const k = keys[i];
      const active = i === creds.activeKeyIndex ? " (active)" : "";
      const disabled = k.disabled ? " [disabled]" : "";
      const budget = k.budgetDollars > 0 ? ` budget=$${k.budgetDollars}` : "";
      const usage = ` usage=$${k.usageDollars.toFixed(2)}`;
      const label = k.label ? ` "${k.label}"` : "";
      const prefix = k.key.slice(0, 12) + "...";
      console.log(`  [${i}] ${prefix}${label}${active}${disabled}${budget}${usage}`);
    }
    return;
  }

  const addMode = opts["add-credentials"] === "true";

  // Add-credentials mode: append a new key to the rotation pool
  if (addMode) {
    let apiKey = opts.key || "";
    if (!apiKey) {
      apiKey = await new Promise<string>((resolve) => {
        process.stdout.write("Additional API key: ");
        process.stdin.setEncoding("utf-8");
        process.stdin.once("data", (data: string) => resolve(data.trim()));
      });
    }
    if (!apiKey) { console.error("Error: API key required."); process.exit(1); }
    if (!apiKey.startsWith("sk-ant-")) console.warn("Warning: key doesn't start with 'sk-ant-'. Adding anyway.");

    try {
      credStore.addKey(apiKey, {
        label: opts.label,
        budgetDollars: opts.budget ? parseFloat(opts.budget) : 0,
      });
      console.log(`Added key to rotation pool (${credStore.listKeys().length} total).`);
      console.log(`Keys rotate automatically when budget is exhausted.`);
    } catch (e: any) {
      console.error(`Error: ${e.message}`);
      process.exit(1);
    }
    return;
  }

  // Normal init mode
  if (credStore.exists()) {
    const creds = credStore.load();
    const keyCount = creds?.keys?.length || (creds?.anthropicApiKey ? 1 : 0);
    console.log(`Credentials already configured (${keyCount} key(s)).`);
    console.log(`Last updated: ${creds?.updatedAt || "unknown"}`);
    console.log("");
    console.log("Re-login? This will overwrite existing credentials.");

    const answer = await new Promise<string>((resolve) => {
      process.stdout.write("Continue? (y/N) ");
      process.stdin.setEncoding("utf-8");
      process.stdin.once("data", (data: string) => resolve(data.trim().toLowerCase()));
      setTimeout(() => resolve("n"), 30_000);
    });

    if (answer !== "y" && answer !== "yes") {
      console.log("Cancelled.");
      return;
    }
  }

  let apiKey = opts.key || "";
  if (!apiKey) {
    apiKey = await new Promise<string>((resolve) => {
      process.stdout.write("Anthropic API key: ");
      process.stdin.setEncoding("utf-8");
      process.stdin.once("data", (data: string) => resolve(data.trim()));
    });
  }

  if (!apiKey) { console.error("Error: API key required."); process.exit(1); }
  if (!apiKey.startsWith("sk-ant-")) console.warn("Warning: key doesn't start with 'sk-ant-'. Saving anyway.");

  credStore.save({ anthropicApiKey: apiKey });
  console.log(`Credentials saved to ${credPath}`);
  console.log("These will be mounted into future ClaudeBox sessions.");
  console.log("\nTo add more keys for rotation: claudebox init --add-credentials --key <key>");
}

async function registerCommand(args: string[]): Promise<void> {
  const { opts, positional } = parseArgs(args, {});
  if (opts.help) {
    console.log(`Usage: claudebox register [options]

Register your personal server for DM routing.
When someone DMs the ClaudeBox bot and you're registered,
the message is proxied to your server instead.

Options:
  --user-id <id>      Your Slack user ID (e.g. U04ABC123)
  --server-url <url>  Your personal server URL
  --label <text>      Label for this registration (optional)
`);
    return;
  }

  const server = resolveServer(opts);
  if (!server.url || !server.token) {
    console.error("Error: central server URL and token required.");
    console.error("Configure with: claudebox config server <url> && claudebox config token <token>");
    process.exit(1);
  }

  const userId = opts["user-id"] || "";
  const serverUrl = opts["server-url"] || "";
  const label = opts.label || "";

  if (!userId || !serverUrl) {
    console.error("Error: --user-id and --server-url required.");
    console.error("Example: claudebox register --user-id U04ABC123 --server-url http://localhost:3000");
    process.exit(1);
  }

  const res = await fetch(`${server.url}/api/dm-registry`, {
    method: "POST",
    headers: {
      "Content-Type": "application/json",
      Authorization: `Bearer ${server.token}`,
    },
    body: JSON.stringify({
      user_id: userId,
      server_url: serverUrl,
      token: server.token,
      label,
    }),
  });

  if (!res.ok) {
    const text = await res.text().catch(() => "");
    console.error(`Registration failed (${res.status}): ${text}`);
    process.exit(1);
  }

  console.log(`Registered: DMs from ${userId} → ${serverUrl}`);
  if (label) console.log(`  Label: ${label}`);
}

async function configCommand(args: string[]): Promise<void> {
  const { opts, positional } = parseArgs(args, {});
  if (opts.help || positional.length === 0) {
    console.log(`Usage: claudebox config <key> [value]

Get or set configuration values.

Keys: server, token, password, user

Examples:
  claudebox config server https://claudebox.work
  claudebox config token abc123
  claudebox config password mypass
  claudebox config server   # prints current value
`);
    return;
  }

  const key = positional[0] as keyof CliConfig;
  const validKeys = ["server", "token", "password", "user"];
  if (!validKeys.includes(key)) {
    console.error(`Unknown config key: ${key}. Valid keys: ${validKeys.join(", ")}`);
    process.exit(1);
  }

  const config = loadConfig();
  if (positional.length === 1) {
    console.log(config[key] || "(not set)");
    return;
  }

  config[key] = positional[1];
  saveConfig(config);
  console.log(`Set ${key} = ${key === "password" || key === "token" ? "***" : positional[1]}`);
}

// ── Main ────────────────────────────────────────────────────────

const [command, ...args] = process.argv.slice(2);

switch (command) {
  case "run":
    runCommand(args).catch(e => { console.error(e.message); process.exit(1); });
    break;
  case "resume":
    resumeCommand(args).catch(e => { console.error(e.message); process.exit(1); });
    break;
  case "sessions":
  case "ls":
    sessionsCommand(args).catch(e => { console.error(e.message); process.exit(1); });
    break;
  case "logs":
  case "log":
    logsCommand(args).catch(e => { console.error(e.message); process.exit(1); });
    break;
  case "status":
    statusCommand(args).catch(e => { console.error(e.message); process.exit(1); });
    break;
  case "profiles":
    profilesCommand().catch(e => { console.error(e.message); process.exit(1); });
    break;
  case "config":
    configCommand(args).catch(e => { console.error(e.message); process.exit(1); });
    break;
  case "pull":
    pullCommand(args).catch(e => { console.error(e.message); process.exit(1); });
    break;
  case "push":
    pushCommand(args).catch(e => { console.error(e.message); process.exit(1); });
    break;
  case "guide":
    guideCommand(args).catch(e => { console.error(e.message); process.exit(1); });
    break;
  case "serve":
    serveCommand(args).catch(e => { console.error(e.message); process.exit(1); });
    break;
  case "init":
    initCommand(args).catch(e => { console.error(e.message); process.exit(1); });
    break;
  case "register":
    registerCommand(args).catch(e => { console.error(e.message); process.exit(1); });
    break;
  default:
    console.log(`ClaudeBox CLI

Usage:
  claudebox run [--profile <name>] [--follow] <prompt>     Start a new session
  claudebox resume [<worktree-id>] <prompt>                Resume an existing session
  claudebox sessions [--user <name>] [--profile <name>]    List sessions
  claudebox logs <worktree-id> [--follow]                  View session activity
  claudebox pull <worktree-id>                             Download session for local work
  claudebox push <worktree-id> [--resume <prompt>]         Upload local changes back
  claudebox guide <worktree-id>                            Review session & ask questions
  claudebox serve [--port <n>] [--password <p>]            Start local HTTP server
  claudebox init [--key <key>]                             Set up credentials
  claudebox register --user-id <id> --server-url <url>    Register for DM routing
  claudebox status                                         Server health check
  claudebox profiles                                       List available profiles
  claudebox config <key> [value]                           Get/set config

Config: ${CONFIG_FILE}
`);
    if (command && command !== "--help" && command !== "-h") {
      console.error(`Unknown command: ${command}`);
      process.exit(1);
    }
}
