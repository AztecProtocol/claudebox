#!/usr/bin/env -S node --experimental-strip-types --no-warnings
/**
 * ClaudeBox CLI — local-first session orchestrator.
 *
 * Usage:
 *   claudebox run [--profile <name>] "fix the flaky test"
 *   claudebox run --file prompt.md
 *   claudebox resume session/foo "continue with the fix"
 *   claudebox list [--user <name>] [--profile <name>]
 *   claudebox tail session/foo
 *   claudebox cancel session/foo
 *   claudebox clean [--force]
 *   claudebox view [session/foo]
 *   claudebox server [--port <n>]
 *   claudebox pull <session-name-or-id>
 *   claudebox push <session-name-or-id> [--resume <prompt>]
 *   claudebox guide <session-name-or-id>
 *   claudebox status
 *   claudebox profiles
 *   claudebox config <key> [value]
 *   claudebox init [--gh-token ...] [--slack-bot-token ...]
 *   claudebox register
 *
 * Config: ~/.claudebox/config.json (CLI client config)
 * Credentials: ~/.config/claudebox/env (server tokens, managed by 'init')
 */

import { existsSync, readFileSync, writeFileSync, mkdirSync, readdirSync, statSync, watch, chmodSync } from "fs";
import { join, dirname, basename } from "path";
import { homedir } from "os";
import { execFileSync } from "child_process";

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

// ── Session Name Resolution ─────────────────────────────────────

/**
 * Resolve a session name or ID to a worktree ID.
 * - Strips "session/" prefix if present
 * - Looks up by workspace name first (from worktree meta.json)
 * - Falls back to worktree ID matching
 * - For remote: queries server API
 */
async function resolveSession(nameOrId: string, opts: { server?: { url: string; token: string; password: string; user: string } } = {}): Promise<string> {
  // Strip session/ prefix
  const stripped = nameOrId.replace(/^session\//, "");

  if (opts.server?.url) {
    // Remote mode: try to resolve via server API, fall back to raw ID
    return stripped;
  }

  // Local mode: check session store
  const { WorktreeStore } = await import("./packages/libclaudebox/worktree-store.ts");
  const store = new WorktreeStore();

  // Direct worktree ID match (hex pattern)
  if (/^[a-f0-9]{16}$/.test(stripped)) {
    const session = store.findByWorktreeId(stripped);
    if (session) return stripped;
  }

  // Search by workspace name in worktree meta.json
  const worktreesDir = store.worktreesDir;
  if (existsSync(worktreesDir)) {
    for (const id of readdirSync(worktreesDir)) {
      const meta = store.getWorktreeMeta(id);
      if (meta.name && meta.name === stripped) {
        return id;
      }
    }
  }

  // Search by partial match on workspace name
  if (existsSync(worktreesDir)) {
    for (const id of readdirSync(worktreesDir)) {
      const meta = store.getWorktreeMeta(id);
      if (meta.name && meta.name.includes(stripped)) {
        return id;
      }
    }
  }

  // Fall back to raw value (might be a valid worktree ID we just can't find yet)
  return stripped;
}

/** Get the display name for a session (workspace name or worktree ID). */
function getSessionDisplayName(worktreeId: string, meta: Record<string, any>): string {
  return meta.name ? `session/${meta.name}` : `session/${worktreeId}`;
}

// ── Activity Tailing ────────────────────────────────────────────

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

/**
 * Tail activity.jsonl from a local worktree directory.
 * Watches for new lines and prints formatted entries.
 * Returns when the session completes or the AbortSignal fires.
 */
async function tailActivity(worktreeId: string, signal?: AbortSignal): Promise<void> {
  const { WorktreeStore } = await import("./packages/libclaudebox/worktree-store.ts");
  const store = new WorktreeStore();
  const activityPath = join(store.worktreesDir, worktreeId, "workspace", "activity.jsonl");

  let linesRead = 0;

  const readNewLines = () => {
    if (!existsSync(activityPath)) return;
    try {
      const content = readFileSync(activityPath, "utf-8");
      const lines = content.split("\n").filter(l => l.trim());
      const newLines = lines.slice(linesRead);
      for (const line of newLines) {
        try {
          const entry = JSON.parse(line);
          printActivityEntry(entry);

          // Print session name when it's set
          if (entry.type === "name" && entry.text) {
            console.log(`\n  --> session/${entry.text}\n`);
          }
        } catch {}
      }
      linesRead = lines.length;
    } catch {}
  };

  // Read existing content first
  readNewLines();

  // Check if session is already done
  const checkDone = (): boolean => {
    const session = store.findByWorktreeId(worktreeId);
    if (session && (session.status === "completed" || session.status === "error" || session.status === "cancelled")) {
      readNewLines(); // flush any remaining
      console.log(`\n[${session.status.toUpperCase()}] exit=${session.exit_code ?? "?"}`);
      return true;
    }
    return false;
  };

  if (checkDone()) return;

  // Poll for changes (more reliable than fs.watch across filesystems)
  return new Promise<void>((resolve) => {
    const interval = setInterval(() => {
      if (signal?.aborted) {
        clearInterval(interval);
        resolve();
        return;
      }
      readNewLines();
      if (checkDone()) {
        clearInterval(interval);
        resolve();
      }
    }, 500);

    // Also try fs.watch for faster updates
    let watcher: ReturnType<typeof watch> | null = null;
    const setupWatcher = () => {
      try {
        const dir = dirname(activityPath);
        if (existsSync(dir)) {
          watcher = watch(dir, () => readNewLines());
        }
      } catch {}
    };

    // Watch may not work until file exists; retry
    if (existsSync(dirname(activityPath))) {
      setupWatcher();
    } else {
      const watchRetry = setInterval(() => {
        if (existsSync(dirname(activityPath))) {
          setupWatcher();
          clearInterval(watchRetry);
        }
      }, 1000);
      signal?.addEventListener("abort", () => clearInterval(watchRetry));
    }

    signal?.addEventListener("abort", () => {
      clearInterval(interval);
      watcher?.close();
      resolve();
    });
  });
}

// ── Commands ────────────────────────────────────────────────────

async function runCommand(args: string[]): Promise<void> {
  const { opts, positional } = parseArgs(args, { follow: true, detach: true, file: false });
  if (opts.help) {
    console.log(`Usage: claudebox run [options] <prompt>

Start a new session. By default, blocks and tails activity output.
Ctrl-C detaches from output (session keeps running).

Options:
  --profile <name>    Profile to run (default: "default")
  --model <model>     Claude model (e.g. claude-haiku-4-5-20251001)
  --file <path>       Read prompt from file (or - for stdin)
  --detach            Start session and return immediately (don't tail)
  --worktree <id>     Resume an existing worktree
  --server <url>      ClaudeBox server URL
  --token <token>     Server API token
  --follow, -f        Stream session output (remote mode, same as default local)

Config file: ${CONFIG_FILE}
  { "server": "https://claudebox.work", "token": "..." }
`);
    return;
  }

  const profile = opts.profile || "default";
  const model = opts.model || "";
  const worktreeId = opts.worktree || "";
  const detach = opts.detach === "true";
  const follow = opts.follow === "true";
  const server = resolveServer(opts);

  // Read prompt from --file, stdin pipe, or positional args
  let prompt = "";
  if (opts.file) {
    if (opts.file === "-") {
      // Read from stdin
      prompt = readFileSync("/dev/stdin", "utf-8").trim();
    } else {
      if (!existsSync(opts.file)) {
        console.error(`Error: file not found: ${opts.file}`);
        process.exit(1);
      }
      prompt = readFileSync(opts.file, "utf-8").trim();
    }
  } else if (!process.stdin.isTTY && positional.length === 0) {
    // Piped input
    prompt = readFileSync("/dev/stdin", "utf-8").trim();
  } else {
    prompt = positional.join(" ").trim();
  }

  if (!prompt) {
    console.error("Error: prompt required. Usage: claudebox run [--profile <name>] <prompt>");
    console.error("       or: claudebox run --file prompt.md");
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
    if (sessionWtId) console.log(`  Resume:  claudebox resume session/${sessionWtId} "<prompt>"`);

    if (follow && sessionWtId && server.password) {
      // Wait briefly for session to start, then stream
      await new Promise(r => setTimeout(r, 2000));
      await streamLogs(server, sessionWtId);
    }
    return;
  }

  // Local mode — pre-flight checks
  try {
    const gitName = execFileSync("git", ["config", "user.name"], { encoding: "utf-8", timeout: 5_000 }).trim();
    const gitEmail = execFileSync("git", ["config", "user.email"], { encoding: "utf-8", timeout: 5_000 }).trim();
    if (!gitName || !gitEmail) throw new Error("empty");
  } catch {
    console.error("Error: git identity not configured. Containers need it for commits.");
    console.error("  git config --global user.name \"Your Name\"");
    console.error("  git config --global user.email \"you@example.com\"");
    process.exit(1);
  }

  console.log("Running locally.");
  console.log(`Profile: ${profile}`);

  const rootDir = dirname(import.meta.url.replace("file://", ""));
  const { setProfilesDir, loadProfile } = await import("./packages/libclaudebox/profile-loader.ts");
  setProfilesDir(join(rootDir, "profiles"));
  const profileConfig = await loadProfile(profile);
  if (profileConfig.requiresServer) {
    console.error(`Error: profile "${profile}" requires a claudebox server.`);
    console.error(`Configure one in ${CONFIG_FILE} or pass --server <url>.`);
    process.exit(1);
  }

  const { WorktreeStore } = await import("./packages/libclaudebox/worktree-store.ts");
  const { DockerService } = await import("./packages/libclaudebox/docker.ts");

  const store = new WorktreeStore();
  const docker = new DockerService();

  if (detach) {
    // Detached mode: start session in background, don't tail
    // We need to run in a forked process to avoid blocking
    const { spawn } = await import("child_process");
    const child = spawn(
      process.execPath,
      ["--experimental-strip-types", "--no-warnings", import.meta.url.replace("file://", ""), "run", "--profile", profile, ...(model ? ["--model", model] : []), ...(worktreeId ? ["--worktree", worktreeId] : []), "--detach-internal", prompt],
      {
        stdio: ["ignore", "pipe", "pipe"],
        detached: true,
        env: process.env,
      },
    );
    // Read initial output to get session info
    let output = "";
    child.stdout?.on("data", (d: Buffer) => { output += d.toString(); });
    child.stderr?.on("data", (d: Buffer) => { process.stderr.write(d); });
    child.unref();

    // Wait a moment for startup info
    await new Promise(r => setTimeout(r, 3000));
    if (output) process.stdout.write(output);
    console.log("\nSession running in background. Use 'claudebox list' to see status.");
    return;
  }

  // Blocking mode: start session and tail activity in parallel
  let sessionWorktreeId = worktreeId;
  const abortController = new AbortController();

  // Handle Ctrl-C: detach from tailing, DON'T kill the container
  let detaching = false;
  const sigintHandler = () => {
    if (detaching) return;
    detaching = true;
    console.log("\n\nDetaching from session output. Session continues running.");
    console.log("Use 'claudebox list' to check status, 'claudebox tail <session>' to reattach.");
    abortController.abort();
  };
  process.on("SIGINT", sigintHandler);

  // Start the container session (this blocks until session completes)
  const sessionPromise = docker.runContainerSession({
    prompt,
    userName: process.env.USER || "cli",
    worktreeId: worktreeId || undefined,
    profile,
    model: model || undefined,
  }, store, undefined, (logUrl, wId) => {
    sessionWorktreeId = wId;
    const meta = store.getWorktreeMeta(wId);
    const displayName = getSessionDisplayName(wId, meta);
    console.log(`${displayName}`);
    console.log(`Log: ${logUrl}`);
    console.log(`Worktree: ${wId}`);
    console.log("");

    // Start tailing activity in parallel once we know the worktree ID
    tailActivity(wId, abortController.signal).catch(() => {});
  });

  const exitCode = await sessionPromise;

  // Clean up signal handler
  process.removeListener("SIGINT", sigintHandler);

  if (detaching) {
    // We detached, so don't exit with session's code
    process.exit(0);
  }

  // Print final session name
  if (sessionWorktreeId) {
    const meta = store.getWorktreeMeta(sessionWorktreeId);
    const displayName = getSessionDisplayName(sessionWorktreeId, meta);
    console.log(`\nSession: ${displayName}  (exit=${exitCode})`);
  }

  process.exit(exitCode);
}

async function resumeCommand(args: string[]): Promise<void> {
  const { opts, positional } = parseArgs(args, { follow: true, detach: true });
  if (opts.help) {
    console.log(`Usage: claudebox resume <session/name-or-id> <prompt>

Resume an existing session with a follow-up prompt.

Options:
  --detach            Start session and return immediately
  --follow, -f        Stream session output (remote mode)
`);
    return;
  }

  const server = resolveServer(opts);
  const follow = opts.follow === "true";
  const detach = opts.detach === "true";

  // First positional arg is session name/id, rest is prompt
  if (positional.length === 0) {
    // No session specified: list recent sessions to pick from
    if (!server.url) {
      const { WorktreeStore } = await import("./packages/libclaudebox/worktree-store.ts");
      const store = new WorktreeStore();
      const sessions = store.listAll().slice(0, 10);
      if (sessions.length === 0) {
        console.log("No sessions found.");
        process.exit(1);
      }
      console.log("Recent sessions:\n");
      for (const s of sessions) {
        const wtId = s.worktree_id || s._log_id || "?";
        const meta = s.worktree_id ? store.getWorktreeMeta(s.worktree_id) : {};
        const name = meta.name ? `session/${meta.name}` : `session/${wtId}`;
        const status = s.status || "?";
        const prompt = (s.prompt || "").slice(0, 50);
        console.log(`  ${name.padEnd(30)}  ${status.padEnd(10)}  ${prompt}`);
      }
      console.log("\nUsage: claudebox resume session/<name> <prompt>");
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
    console.log("  NAME                          STATUS      PROFILE       PROMPT");
    console.log("  " + "-".repeat(85));
    for (const w of workspaces) {
      const name = w.name ? `session/${w.name}` : `session/${(w.worktreeId || "?").slice(0, 16)}`;
      const status = (w.status || "?").padEnd(10);
      const profile = (w.profile || "default").padEnd(12);
      const prompt = (w.prompt || "").slice(0, 35);
      console.log(`  ${name.padEnd(30)}  ${status}  ${profile}  ${prompt}`);
    }
    console.log("\nUsage: claudebox resume session/<name> <prompt>");
    return;
  }

  const sessionRef = positional[0];
  const prompt = positional.slice(1).join(" ").trim();

  if (!prompt) {
    console.error("Error: prompt required. Usage: claudebox resume session/<name> <prompt>");
    process.exit(1);
  }

  const worktreeId = await resolveSession(sessionRef, { server: server.url ? server : undefined });

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
  const { WorktreeStore } = await import("./packages/libclaudebox/worktree-store.ts");
  const { DockerService } = await import("./packages/libclaudebox/docker.ts");
  const store = new WorktreeStore();
  const docker = new DockerService();
  const session = store.findByWorktreeId(worktreeId);

  if (detach) {
    const exitCode = await docker.runContainerSession({
      prompt,
      userName: process.env.USER || "cli",
      worktreeId,
      profile: session?.profile || undefined,
    }, store, undefined, (logUrl, wId) => {
      const meta = store.getWorktreeMeta(wId);
      console.log(`${getSessionDisplayName(wId, meta)}`);
      console.log(`Log: ${logUrl}`);
    });
    process.exit(exitCode);
  }

  // Blocking mode with activity tailing (same pattern as run)
  const abortController = new AbortController();
  let detaching = false;
  const sigintHandler = () => {
    if (detaching) return;
    detaching = true;
    console.log("\n\nDetaching from session output. Session continues running.");
    abortController.abort();
  };
  process.on("SIGINT", sigintHandler);

  const exitCode = await docker.runContainerSession({
    prompt,
    userName: process.env.USER || "cli",
    worktreeId,
    profile: session?.profile || undefined,
  }, store, undefined, (logUrl, wId) => {
    const meta = store.getWorktreeMeta(wId);
    console.log(`${getSessionDisplayName(wId, meta)}`);
    console.log(`Log: ${logUrl}`);
    console.log("");
    tailActivity(wId, abortController.signal).catch(() => {});
  });

  process.removeListener("SIGINT", sigintHandler);
  if (detaching) process.exit(0);
  process.exit(exitCode);
}

async function listCommand(args: string[]): Promise<void> {
  const { opts } = parseArgs(args, {});
  if (opts.help) {
    console.log(`Usage: claudebox list [options]

List sessions in table format.

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
    console.log("  NAME                          PROFILE       STATUS      CREATED     BRANCH");
    console.log("  " + "-".repeat(90));
    for (const w of workspaces) {
      const name = w.name ? `session/${w.name}` : `session/${(w.worktreeId || "?").slice(0, 16)}`;
      const profile = (w.profile || "default").padEnd(12);
      const status = (w.status || "?").padEnd(10);
      const created = w.started ? new Date(w.started).toLocaleDateString() : "?";
      const branch = (w.baseBranch || "").padEnd(12);
      console.log(`  ${name.padEnd(30)}  ${profile}  ${status}  ${created.padEnd(10)}  ${branch}`);
    }
    return;
  }

  // Local mode
  const { WorktreeStore } = await import("./packages/libclaudebox/worktree-store.ts");
  const store = new WorktreeStore();

  // Build a deduplicated list by worktree (show latest session per worktree)
  const allSessions = store.listAll();
  const worktreeMap = new Map<string, typeof allSessions[0]>();
  for (const s of allSessions) {
    const key = s.worktree_id || s._log_id || "";
    if (!worktreeMap.has(key)) {
      worktreeMap.set(key, s);
    }
  }

  let sessions = [...worktreeMap.values()];
  if (userFilter) sessions = sessions.filter(s => s.user === userFilter);
  if (profileFilter) sessions = sessions.filter(s => (s.profile || "") === profileFilter);
  sessions = sessions.slice(0, limit);

  if (sessions.length === 0) {
    console.log("No sessions found.");
    return;
  }

  console.log("  NAME                          PROFILE       STATUS      CREATED     BRANCH");
  console.log("  " + "-".repeat(90));
  for (const s of sessions) {
    const wtId = s.worktree_id || s._log_id || "?";
    const meta = s.worktree_id ? store.getWorktreeMeta(s.worktree_id) : {};
    const name = meta.name ? `session/${meta.name}` : `session/${wtId.slice(0, 16)}`;
    const profile = (s.profile || "default").padEnd(12);
    const status = (s.status || "?").padEnd(10);
    const created = s.started ? new Date(s.started).toLocaleDateString() : "?";
    const branch = (s.base_branch || "").padEnd(12);
    console.log(`  ${name.padEnd(30)}  ${profile}  ${status}  ${created.padEnd(10)}  ${branch}`);
  }
}

async function tailCommand(args: string[]): Promise<void> {
  const { opts, positional } = parseArgs(args, { follow: true });
  if (opts.help || positional.length === 0) {
    console.log(`Usage: claudebox tail <session/name-or-id>

Stream activity log for a session. Follows by default.
Ctrl-C stops tailing (session keeps running).
`);
    if (!opts.help) process.exit(1);
    return;
  }

  const sessionRef = positional[0];
  const server = resolveServer(opts);

  if (server.url) {
    const worktreeId = await resolveSession(sessionRef, { server });
    if (!server.password) {
      console.error("Error: --password or config.password required for log streaming.");
      process.exit(1);
    }
    await streamLogs(server, worktreeId);
    return;
  }

  // Local mode: tail the activity.jsonl
  const worktreeId = await resolveSession(sessionRef);

  const abortController = new AbortController();
  process.on("SIGINT", () => {
    console.log("\nStopped tailing. Session may still be running.");
    abortController.abort();
  });

  await tailActivity(worktreeId, abortController.signal);
}

async function cancelCommand(args: string[]): Promise<void> {
  const { opts, positional } = parseArgs(args, {});
  if (opts.help || positional.length === 0) {
    console.log(`Usage: claudebox cancel <session/name-or-id>

Gracefully stop a running session.
Sends SIGTERM, waits 10 seconds, then SIGKILL. Worktree is preserved.
`);
    if (!opts.help) process.exit(1);
    return;
  }

  const sessionRef = positional[0];
  const server = resolveServer(opts);

  if (server.url) {
    console.error("Error: cancel is only supported in local mode.");
    process.exit(1);
  }

  const worktreeId = await resolveSession(sessionRef);

  const { WorktreeStore } = await import("./packages/libclaudebox/worktree-store.ts");
  const store = new WorktreeStore();

  // Find the running session for this worktree
  const sessions = store.listByWorktree(worktreeId);
  const running = sessions.find(s => s.status === "running");

  if (!running) {
    console.log(`No running session found for ${sessionRef}.`);
    return;
  }

  const logId = running._log_id || "";
  const containerName = running.container || `claudebox-${logId}`;
  const sidecarName = running.sidecar || `claudebox-sidecar-${logId}`;
  const networkName = `claudebox-net-${logId}`;

  const meta = store.getWorktreeMeta(worktreeId);
  const displayName = getSessionDisplayName(worktreeId, meta);
  console.log(`Cancelling ${displayName}...`);

  // Graceful stop: SIGTERM with 10s timeout, then SIGKILL
  try {
    console.log(`  Stopping container ${containerName} (10s grace)...`);
    execFileSync("docker", ["stop", "--time", "10", containerName], { timeout: 30_000, stdio: "pipe" });
  } catch {}

  // Stop sidecar
  try {
    execFileSync("docker", ["stop", "--time", "3", sidecarName], { timeout: 15_000, stdio: "pipe" });
  } catch {}

  // Force remove if still around
  try { execFileSync("docker", ["rm", "-f", containerName], { timeout: 10_000, stdio: "pipe" }); } catch {}
  try { execFileSync("docker", ["rm", "-f", sidecarName], { timeout: 10_000, stdio: "pipe" }); } catch {}

  // Clean up network
  try { execFileSync("docker", ["network", "rm", networkName], { timeout: 10_000, stdio: "pipe" }); } catch {}

  // Update session status
  store.update(logId, {
    status: "cancelled",
    finished: new Date().toISOString(),
  });

  console.log(`Cancelled. Worktree preserved at ${join(store.worktreesDir, worktreeId)}`);
}

async function cleanCommand(args: string[]): Promise<void> {
  const { opts } = parseArgs(args, { force: true });
  if (opts.help) {
    console.log(`Usage: claudebox clean [options]

Remove worktrees from completed/cancelled sessions.

Options:
  --force     Actually delete (default is dry-run)

By default, shows what would be deleted without removing anything.
Running sessions are never cleaned.
`);
    return;
  }

  const force = opts.force === "true";

  const { WorktreeStore } = await import("./packages/libclaudebox/worktree-store.ts");
  const store = new WorktreeStore();

  if (!existsSync(store.worktreesDir)) {
    console.log("No worktrees found.");
    return;
  }

  const worktreeIds = readdirSync(store.worktreesDir).filter(id => {
    try {
      return statSync(join(store.worktreesDir, id)).isDirectory();
    } catch { return false; }
  });

  if (worktreeIds.length === 0) {
    console.log("No worktrees found.");
    return;
  }

  // Classify worktrees
  const cleanable: { id: string; name: string; status: string; sizeMB: number }[] = [];
  const running: string[] = [];

  for (const id of worktreeIds) {
    const sessions = store.listByWorktree(id);
    const latest = sessions[0];
    const meta = store.getWorktreeMeta(id);
    const displayName = meta.name || id.slice(0, 16);

    if (latest?.status === "running") {
      running.push(displayName);
      continue;
    }

    // Estimate size
    let sizeMB = 0;
    const wsDir = join(store.worktreesDir, id, "workspace");
    try {
      const du = execFileSync("du", ["-sm", wsDir], { encoding: "utf-8", timeout: 10_000 }).trim();
      sizeMB = parseInt(du.split("\t")[0]) || 0;
    } catch {}

    cleanable.push({
      id,
      name: displayName,
      status: latest?.status || "unknown",
      sizeMB,
    });
  }

  if (cleanable.length === 0) {
    console.log("Nothing to clean.");
    if (running.length > 0) {
      console.log(`  ${running.length} running session(s) skipped.`);
    }
    return;
  }

  const totalMB = cleanable.reduce((sum, c) => sum + c.sizeMB, 0);

  if (!force) {
    console.log("Dry run (use --force to delete):\n");
    console.log("  NAME                          STATUS      SIZE");
    console.log("  " + "-".repeat(55));
    for (const c of cleanable) {
      const name = `session/${c.name}`.padEnd(30);
      const status = c.status.padEnd(10);
      const size = c.sizeMB > 0 ? `${c.sizeMB} MB` : "?";
      console.log(`  ${name}  ${status}  ${size}`);
    }
    console.log(`\n  Total: ${cleanable.length} worktree(s), ~${totalMB} MB`);
    if (running.length > 0) {
      console.log(`  ${running.length} running session(s) skipped.`);
    }
    return;
  }

  // Actually delete
  let deleted = 0;
  for (const c of cleanable) {
    try {
      store.deleteWorktree(c.id);
      console.log(`  Deleted session/${c.name} (${c.sizeMB} MB)`);
      deleted++;
    } catch (e: any) {
      console.error(`  Failed to delete session/${c.name}: ${e.message}`);
    }

    // Also clean up any orphaned Docker networks
    const networkName = `claudebox-net-${c.id}`;
    try { execFileSync("docker", ["network", "rm", networkName], { timeout: 10_000, stdio: "pipe" }); } catch {}
  }

  console.log(`\nCleaned ${deleted} worktree(s), freed ~${totalMB} MB.`);
}

async function viewCommand(args: string[]): Promise<void> {
  const { opts, positional } = parseArgs(args, {});
  if (opts.help) {
    console.log(`Usage: claudebox view [session/name-or-id]

Start an ephemeral local HTTP server and open the dashboard in your browser.
Optionally view a specific session.

Ctrl-C stops the server (does not affect running sessions).

Options:
  --port <n>          Port (default: 3456)
  --password <pass>   Dashboard password (or CLAUDEBOX_SESSION_PASS)
`);
    return;
  }

  const port = opts.port || "3456";
  const password = opts.password || process.env.CLAUDEBOX_SESSION_PASS || "view";
  const sessionRef = positional[0] || "";

  // Set env for the server
  process.env.CLAUDEBOX_HTTP_PORT = port;
  process.env.CLAUDEBOX_SESSION_PASS = password;
  process.env.CLAUDEBOX_HTTP_ONLY = "1";

  // Start server as child process
  const { spawn } = await import("child_process");
  const serverPath = join(dirname(import.meta.url.replace("file://", "")), "server.ts");
  const proc = spawn(
    process.execPath,
    ["--experimental-strip-types", "--no-warnings", serverPath, "--http-only"],
    {
      stdio: ["ignore", "pipe", "pipe"],
      env: process.env,
    },
  );

  // Wait for server to start, then open browser
  let started = false;
  proc.stdout?.on("data", (d: Buffer) => {
    const text = d.toString();
    if (!started && text.includes("listening")) {
      started = true;
      const url = sessionRef
        ? `http://localhost:${port}/s/${sessionRef.replace(/^session\//, "")}`
        : `http://localhost:${port}`;
      console.log(`Dashboard: ${url}`);
      console.log("Press Ctrl-C to stop the server.\n");

      // Try to open browser
      const openCmd = process.platform === "darwin" ? "open" : "xdg-open";
      try { spawn(openCmd, [url], { stdio: "ignore", detached: true }).unref(); } catch {}
    }
  });
  proc.stderr?.on("data", (d: Buffer) => process.stderr.write(d));

  // Ctrl-C kills the server, not sessions
  process.on("SIGINT", () => {
    proc.kill("SIGTERM");
    console.log("\nServer stopped. Sessions are unaffected.");
    process.exit(0);
  });

  await new Promise<void>((resolve) => {
    proc.on("close", () => resolve());
  });
}

async function serverCommand(args: string[]): Promise<void> {
  const { opts } = parseArgs(args, {});
  if (opts.help) {
    console.log(`Usage: claudebox server [options]

Start the full ClaudeBox server (Slack + HTTP). This is what systemd runs.

Options:
  --port <n>          HTTP port (default: 3000, or CLAUDEBOX_HTTP_PORT)
  --profiles <list>   Comma-separated profile names to load
  --password <pass>   Session page password (or CLAUDEBOX_SESSION_PASS)
  --token <token>     API bearer token (or CLAUDEBOX_API_SECRET)
  --http-only         Skip Slack socket (HTTP only)
`);
    return;
  }

  const port = opts.port || process.env.CLAUDEBOX_HTTP_PORT || "3000";
  const password = opts.password || process.env.CLAUDEBOX_SESSION_PASS || "";
  const token = opts.token || process.env.CLAUDEBOX_API_SECRET || "";
  const profiles = opts.profiles || "";
  const httpOnly = opts["http-only"] === "true";

  if (!password) {
    console.error("Error: password required. Pass --password <pass> or set CLAUDEBOX_SESSION_PASS.");
    process.exit(1);
  }

  // Set env vars before importing server
  process.env.CLAUDEBOX_HTTP_PORT = port;
  process.env.CLAUDEBOX_SESSION_PASS = password;
  if (token) process.env.CLAUDEBOX_API_SECRET = token;
  if (httpOnly) process.env.CLAUDEBOX_HTTP_ONLY = "1";

  const serverArgs: string[] = [];
  if (httpOnly) serverArgs.push("--http-only");
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

  // Local mode: show local session summary
  const { WorktreeStore } = await import("./packages/libclaudebox/worktree-store.ts");
  const store = new WorktreeStore();
  const sessions = store.listAll();
  const running = sessions.filter(s => s.status === "running");

  console.log(`Local mode (no server configured)`);
  console.log(`Total sessions: ${sessions.length}`);
  console.log(`Running: ${running.length}`);
  if (running.length > 0) {
    for (const s of running) {
      const wtId = s.worktree_id || s._log_id || "?";
      const meta = s.worktree_id ? store.getWorktreeMeta(s.worktree_id) : {};
      const name = getSessionDisplayName(wtId, meta);
      console.log(`  ${name}  ${s.profile || "default"}  ${s.started || "?"}`);
    }
  }
  console.log(`\nConfig: ${CONFIG_FILE}`);
}

async function profilesCommand(): Promise<void> {
  const rootDir = dirname(import.meta.url.replace("file://", ""));
  const { setProfilesDir, discoverProfiles, loadProfile } = await import("./packages/libclaudebox/profile-loader.ts");
  setProfilesDir(join(rootDir, "profiles"));

  const names = discoverProfiles();
  if (names.length === 0) {
    console.log("No profiles found.");
    return;
  }

  console.log("Available profiles:\n");
  for (const name of names) {
    const p = await loadProfile(name);
    const flags: string[] = [];
    if (p.requiresServer) flags.push("requires-server");
    if (p.channels?.length) flags.push(`channels: ${p.channels.join(", ")}`);
    console.log(`  ${name}${flags.length ? ` (${flags.join(", ")})` : ""}`);
  }
}

async function pullCommand(args: string[]): Promise<void> {
  const { opts, positional } = parseArgs(args, {});
  if (opts.help || positional.length === 0) {
    console.log(`Usage: claudebox pull <session/name-or-id>

Download a remote session's conversation history for local continuation.

Files are saved to ~/.claudebox/worktrees/<id>/claude-projects/
`);
    return;
  }

  const sessionRef = positional[0];
  const server = resolveServer(opts);
  if (!server.url || !server.token) {
    console.error("Error: server URL and token required. Configure with: claudebox config server <url>");
    process.exit(1);
  }

  const worktreeId = await resolveSession(sessionRef, { server });
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
  console.log(`  claudebox push session/${worktreeId} --resume "continue with the fix"`);
}

async function pushCommand(args: string[]): Promise<void> {
  const { opts, positional } = parseArgs(args, {});
  if (opts.help || positional.length === 0) {
    console.log(`Usage: claudebox push <session/name-or-id> [--resume <prompt>]

Upload local session changes back to the server.

Options:
  --resume <prompt>   After uploading, enqueue a resume with this prompt

Files are read from ~/.claudebox/worktrees/<id>/claude-projects/
`);
    return;
  }

  const sessionRef = positional[0];
  const resumePrompt = opts.resume || "";
  const server = resolveServer(opts);
  if (!server.url || !server.token) {
    console.error("Error: server URL and token required. Configure with: claudebox config server <url>");
    process.exit(1);
  }

  const worktreeId = await resolveSession(sessionRef, { server });
  const localDir = join(CONFIG_DIR, "worktrees", worktreeId, "claude-projects");
  if (!existsSync(localDir)) {
    console.error(`Error: no local session data at ${localDir}`);
    console.error(`Run 'claudebox pull session/${worktreeId}' first.`);
    process.exit(1);
  }

  console.log(`Pushing session ${worktreeId} to ${server.url}...`);

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
    console.log(`Usage: claudebox guide <session/name-or-id> [options]

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

  const sessionRef = positional[0];
  const server = resolveServer(opts);
  const claudeBin = opts.claude || "claude";
  const model = opts.model || "";
  const resumePrompt = opts.resume || "";
  const noPush = opts["no-push"] === "true";

  const worktreeId = await resolveSession(sessionRef, { server: server.url ? server : undefined });
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
    execFileSync("tar", ["-x", "-C", localDir], { input: Buffer.from(await res.arrayBuffer()) });
    console.log(`Downloaded to ${localDir}`);
  } else if (!existsSync(localDir)) {
    console.error(`No local session at ${localDir} and no server configured.`);
    console.error(`Run 'claudebox pull session/${worktreeId}' first, or configure a server.`);
    process.exit(1);
  }

  // Step 2: Find latest session ID from JSONL files
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
    const { realpathSync } = await import("fs");
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
      "-v", `${realpathSync(claudeBinPath)}:/usr/local/bin/claude:ro`,
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

/**
 * claudebox init — manage the server credentials file (~/.config/claudebox/env).
 *
 * This file is loaded by systemd's EnvironmentFile directive.
 * Only libcreds and libcreds-host read these tokens at runtime.
 *
 * Usage:
 *   claudebox init                              # show current status
 *   claudebox init --gh-token ghp_xxx           # set GitHub token
 *   claudebox init --slack-bot-token xoxb-xxx   # set Slack bot token
 *   claudebox init --slack-app-token xapp-xxx   # set Slack app token
 *   claudebox init --api-secret xxx             # set API secret
 *   claudebox init --session-pass xxx           # set session password
 *   claudebox init --linear-api-key lin_xxx     # set Linear API key
 */
async function initCommand(args: string[]): Promise<void> {
  const { opts } = parseArgs(args, { help: true });

  if (opts.help) {
    console.log(`Usage: claudebox init [options]

Manage the server credentials file (~/.config/claudebox/env).
With no flags, shows which credentials are configured.

Token flags:
  --gh-token <token>          GitHub personal access token
  --slack-bot-token <token>   Slack bot token (xoxb-...)
  --slack-app-token <token>   Slack app token (xapp-...)
  --api-secret <secret>       ClaudeBox API secret
  --session-pass <pass>       Dashboard session password
  --linear-api-key <key>      Linear API key (optional)

Other options:
  --host <hostname>           CLAUDEBOX_HOST (e.g. claudebox.work)
  --port <port>               CLAUDEBOX_PORT (default: 3000)
`);
    return;
  }

  const ENV_DIR = join(homedir(), ".config", "claudebox");
  const ENV_FILE = join(ENV_DIR, "env");

  // Parse existing env file into key-value map
  const existing = new Map<string, string>();
  const comments: string[] = [];
  if (existsSync(ENV_FILE)) {
    for (const line of readFileSync(ENV_FILE, "utf-8").split("\n")) {
      const trimmed = line.trim();
      if (!trimmed || trimmed.startsWith("#")) { comments.push(line); continue; }
      const eq = trimmed.indexOf("=");
      if (eq > 0) existing.set(trimmed.slice(0, eq), trimmed.slice(eq + 1));
    }
  }

  // Map CLI flags to env var names
  const flagMap: Record<string, string> = {
    "gh-token": "GH_TOKEN",
    "slack-bot-token": "SLACK_BOT_TOKEN",
    "slack-app-token": "SLACK_APP_TOKEN",
    "api-secret": "CLAUDEBOX_API_SECRET",
    "session-pass": "CLAUDEBOX_SESSION_PASS",
    "linear-api-key": "LINEAR_API_KEY",
    "host": "CLAUDEBOX_HOST",
    "port": "CLAUDEBOX_PORT",
  };

  // Apply any provided flags
  let changed = false;
  for (const [flag, envKey] of Object.entries(flagMap)) {
    if (opts[flag]) {
      existing.set(envKey, opts[flag]);
      changed = true;
    }
  }

  if (changed) {
    // Write the env file
    mkdirSync(ENV_DIR, { recursive: true });
    const REQUIRED_KEYS = [
      "CLAUDEBOX_SESSION_PASS", "CLAUDEBOX_API_SECRET",
      "SLACK_BOT_TOKEN", "SLACK_APP_TOKEN", "GH_TOKEN",
    ];
    const OPTIONAL_KEYS = [
      "LINEAR_API_KEY", "CLAUDEBOX_PORT", "CLAUDEBOX_HOST",
      "CLAUDEBOX_DOCKER_IMAGE", "CLAUDEBOX_DEFAULT_BRANCH",
    ];

    const lines = ["# ClaudeBox credentials — managed by 'claudebox init'", "# chmod 600 — do not commit this file", ""];
    for (const key of REQUIRED_KEYS) {
      lines.push(`${key}=${existing.get(key) || ""}`);
    }
    lines.push("");
    for (const key of OPTIONAL_KEYS) {
      const val = existing.get(key);
      if (val) lines.push(`${key}=${val}`);
    }
    lines.push("");

    writeFileSync(ENV_FILE, lines.join("\n"), { mode: 0o600 });
    console.log(`Updated ${ENV_FILE}`);
  }

  // Show status
  const status = (key: string) => {
    const val = existing.get(key);
    if (!val) return "  \x1b[31m✗\x1b[0m";
    return `  \x1b[32m✓\x1b[0m (${val.slice(0, 8)}...)`;
  };

  console.log(`\nCredentials: ${ENV_FILE}\n`);
  console.log(`  GH_TOKEN:             ${status("GH_TOKEN")}`);
  console.log(`  SLACK_BOT_TOKEN:      ${status("SLACK_BOT_TOKEN")}`);
  console.log(`  SLACK_APP_TOKEN:      ${status("SLACK_APP_TOKEN")}`);
  console.log(`  CLAUDEBOX_API_SECRET: ${status("CLAUDEBOX_API_SECRET")}`);
  console.log(`  CLAUDEBOX_SESSION_PASS:${status("CLAUDEBOX_SESSION_PASS")}`);
  console.log(`  LINEAR_API_KEY:       ${status("LINEAR_API_KEY")}`);

  const host = existing.get("CLAUDEBOX_HOST");
  const port = existing.get("CLAUDEBOX_PORT");
  if (host || port) {
    console.log("");
    if (host) console.log(`  CLAUDEBOX_HOST:       ${host}`);
    if (port) console.log(`  CLAUDEBOX_PORT:       ${port}`);
  }

  if (!changed && !existsSync(ENV_FILE)) {
    console.log("\nNo credentials file found. Set tokens with:");
    console.log("  claudebox init --gh-token ghp_xxx --slack-bot-token xoxb-xxx ...");
  }
  console.log("");
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

  console.log(`Registered: DMs from ${userId} -> ${serverUrl}`);
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

// ── Creds command ────────────────────────────────────────────────

const CREDS_DIR = join(homedir(), ".claudebox", "credentials");
const CLAUDE_DIR = join(homedir(), ".claude");
const CLAUDE_CREDS = join(CLAUDE_DIR, ".credentials.json");

function credsSlots(): { name: string; path: string }[] {
  if (!existsSync(CREDS_DIR)) return [];
  return readdirSync(CREDS_DIR)
    .filter(d => existsSync(join(CREDS_DIR, d, ".credentials.json")))
    .sort()
    .map(name => ({ name, path: join(CREDS_DIR, name) }));
}

function readCredsMeta(credPath: string): { email: string; expires: string; expired: boolean } {
  try {
    const creds = JSON.parse(readFileSync(join(credPath, ".credentials.json"), "utf-8"));
    const oauth = creds.claudeAiOauth || {};
    const expiresAt = oauth.expiresAt || 0;
    const expired = expiresAt < Date.now();
    const expiresDate = expiresAt ? new Date(expiresAt).toISOString().replace("T", " ").slice(0, 19) : "unknown";

    // Try to read email from .claude.json in the slot
    let email = "";
    const claudeJson = join(credPath, ".claude.json");
    if (existsSync(claudeJson)) {
      try {
        const cfg = JSON.parse(readFileSync(claudeJson, "utf-8"));
        email = cfg.oauthAccount?.emailAddress || "";
      } catch {}
    }
    // Fallback: check the token prefix for differentiation
    if (!email) {
      const token = (oauth.accessToken || "").slice(0, 25);
      email = token ? `token:${token}...` : "unknown";
    }
    return { email, expires: expiresDate, expired };
  } catch {
    return { email: "error", expires: "error", expired: true };
  }
}

function activeSlotName(): string | null {
  if (!existsSync(CLAUDE_CREDS)) return null;
  try {
    const activeCreds = readFileSync(CLAUDE_CREDS, "utf-8");
    const activeToken = JSON.parse(activeCreds).claudeAiOauth?.refreshToken || "";
    if (!activeToken) return null;
    for (const slot of credsSlots()) {
      try {
        const slotCreds = JSON.parse(readFileSync(join(slot.path, ".credentials.json"), "utf-8"));
        if ((slotCreds.claudeAiOauth?.refreshToken || "") === activeToken) return slot.name;
      } catch {}
    }
  } catch {}
  return null;
}

async function credsCommand(args: string[]): Promise<void> {
  const sub = args[0];

  if (sub === "list" || sub === "ls" || !sub) {
    const slots = credsSlots();
    if (!slots.length) {
      console.log(`No credential slots found.\n\nSet up slots:\n  mkdir -p ${CREDS_DIR}/account-1\n  cp ~/.claude/.credentials.json ${CREDS_DIR}/account-1/`);
      return;
    }
    const active = activeSlotName();
    const pad = Math.max(...slots.map(s => s.name.length), 4);

    console.log(`\n  ${"SLOT".padEnd(pad)}  ${"IDENTITY".padEnd(30)}  ${"EXPIRES".padEnd(19)}  STATUS`);
    console.log(`  ${"─".repeat(pad)}  ${"─".repeat(30)}  ${"─".repeat(19)}  ──────`);
    for (const slot of slots) {
      const meta = readCredsMeta(slot.path);
      const isActive = slot.name === active;
      const marker = isActive ? "● " : "  ";
      const statusParts: string[] = [];
      if (isActive) statusParts.push("\x1b[32mactive\x1b[0m");
      if (meta.expired) statusParts.push("\x1b[31mexpired\x1b[0m");
      else statusParts.push("\x1b[32mvalid\x1b[0m");
      console.log(`${marker}${slot.name.padEnd(pad)}  ${meta.email.padEnd(30)}  ${meta.expires}  ${statusParts.join(" ")}`);
    }
    console.log();
    return;
  }

  if (sub === "use" || sub === "promote") {
    const slotName = args[1];
    if (!slotName) { console.error("Usage: claudebox creds use <slot-name>"); process.exit(1); }

    const slot = credsSlots().find(s => s.name === slotName);
    if (!slot) { console.error(`Slot "${slotName}" not found. Run: claudebox creds list`); process.exit(1); }

    const srcCreds = join(slot.path, ".credentials.json");
    if (!existsSync(srcCreds)) { console.error(`No .credentials.json in slot "${slotName}"`); process.exit(1); }

    // Back up current credentials to a slot if not already tracked
    const active = activeSlotName();
    if (active && active !== slotName) {
      // Current creds are already in a slot, just switch
      console.log(`  Deactivating: ${active}`);
    } else if (!active && existsSync(CLAUDE_CREDS)) {
      // Current creds aren't in any slot — save them
      const backupName = `backup-${Date.now()}`;
      const backupDir = join(CREDS_DIR, backupName);
      mkdirSync(backupDir, { recursive: true });
      writeFileSync(join(backupDir, ".credentials.json"), readFileSync(CLAUDE_CREDS));
      chmodSync(join(backupDir, ".credentials.json"), 0o600);
      console.log(`  Backed up current credentials → ${backupName}`);
    }

    // Copy slot credentials to active location
    writeFileSync(CLAUDE_CREDS, readFileSync(srcCreds));
    chmodSync(CLAUDE_CREDS, 0o600);

    // Also copy .claude.json if the slot has one
    const srcClaudeJson = join(slot.path, ".claude.json");
    const dstClaudeJson = join(homedir(), ".claude.json");
    if (existsSync(srcClaudeJson)) {
      writeFileSync(dstClaudeJson, readFileSync(srcClaudeJson));
      chmodSync(dstClaudeJson, 0o600);
    }

    const meta = readCredsMeta(slot.path);
    console.log(`  ● Activated: ${slotName} (${meta.email})`);
    if (meta.expired) console.log(`  ⚠ Token is expired — Claude will refresh on next use`);
    console.log();
    return;
  }

  if (sub === "save") {
    const slotName = args[1];
    if (!slotName) { console.error("Usage: claudebox creds save <slot-name>"); process.exit(1); }
    if (!/^[a-z0-9][a-z0-9._-]*$/i.test(slotName)) { console.error("Invalid slot name (use alphanumeric, hyphens, dots)"); process.exit(1); }

    const slotDir = join(CREDS_DIR, slotName);
    mkdirSync(slotDir, { recursive: true });

    if (!existsSync(CLAUDE_CREDS)) { console.error("No active credentials to save"); process.exit(1); }

    writeFileSync(join(slotDir, ".credentials.json"), readFileSync(CLAUDE_CREDS));
    chmodSync(join(slotDir, ".credentials.json"), 0o600);

    // Also save .claude.json for the account identity
    const claudeJson = join(homedir(), ".claude.json");
    if (existsSync(claudeJson)) {
      writeFileSync(join(slotDir, ".claude.json"), readFileSync(claudeJson));
      chmodSync(join(slotDir, ".claude.json"), 0o600);
    }

    const meta = readCredsMeta(slotDir);
    console.log(`  Saved current credentials → ${slotName} (${meta.email})`);
    console.log();
    return;
  }

  if (sub === "rm" || sub === "remove") {
    const slotName = args[1];
    if (!slotName) { console.error("Usage: claudebox creds rm <slot-name>"); process.exit(1); }

    const slot = credsSlots().find(s => s.name === slotName);
    if (!slot) { console.error(`Slot "${slotName}" not found`); process.exit(1); }

    const active = activeSlotName();
    if (active === slotName) { console.error(`Cannot remove active slot. Switch first: claudebox creds use <other>`); process.exit(1); }

    const { rmSync } = await import("fs");
    rmSync(slot.path, { recursive: true });
    console.log(`  Removed slot: ${slotName}`);
    console.log();
    return;
  }

  console.log(`claudebox creds — manage Claude OAuth credentials

Usage:
  claudebox creds                    List all credential slots
  claudebox creds list               List all credential slots
  claudebox creds use <slot>         Activate a credential slot
  claudebox creds save <slot>        Save current credentials to a slot
  claudebox creds rm <slot>          Remove a credential slot

Slots are stored in: ${CREDS_DIR}/
Each slot is a directory containing .credentials.json (and optionally .claude.json).
`);
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
  case "list":
  case "ls":
  case "sessions":
    listCommand(args).catch(e => { console.error(e.message); process.exit(1); });
    break;
  case "tail":
  case "logs":
  case "log":
    tailCommand(args).catch(e => { console.error(e.message); process.exit(1); });
    break;
  case "cancel":
    cancelCommand(args).catch(e => { console.error(e.message); process.exit(1); });
    break;
  case "clean":
    cleanCommand(args).catch(e => { console.error(e.message); process.exit(1); });
    break;
  case "view":
    viewCommand(args).catch(e => { console.error(e.message); process.exit(1); });
    break;
  case "server":
  case "serve":
    serverCommand(args).catch(e => { console.error(e.message); process.exit(1); });
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
  case "init":
    initCommand(args).catch(e => { console.error(e.message); process.exit(1); });
    break;
  case "register":
    registerCommand(args).catch(e => { console.error(e.message); process.exit(1); });
    break;
  case "creds":
  case "credentials":
    credsCommand(args).catch(e => { console.error(e.message); process.exit(1); });
    break;
  default:
    console.log(`ClaudeBox CLI

Usage:
  claudebox run [--profile <name>] <prompt>              Start a new session (blocks + tails)
  claudebox run --file prompt.md                         Start from file or stdin
  claudebox run --detach <prompt>                        Start without tailing
  claudebox resume session/<name> <prompt>               Resume with follow-up prompt
  claudebox list [--user <name>] [--profile <name>]      List sessions
  claudebox tail session/<name>                          Stream session activity
  claudebox cancel session/<name>                        Graceful stop (SIGTERM -> SIGKILL)
  claudebox clean [--force]                              Remove completed worktrees
  claudebox view [session/<name>]                        Open dashboard in browser
  claudebox server [--port <n>]                          Start full server (Slack + HTTP)
  claudebox pull session/<name>                          Download session for local work
  claudebox push session/<name> [--resume <prompt>]      Upload local changes back
  claudebox guide session/<name>                         Review session & ask questions
  claudebox init [--key <key>]                           Set up credentials
  claudebox register --user-id <id> --server-url <url>   Register for DM routing
  claudebox status                                       Health check / local summary
  claudebox profiles                                     List available profiles
  claudebox creds [list|use|save|rm]                      Manage OAuth credentials
  claudebox config <key> [value]                         Get/set config

Sessions are identified by name (session/<name>) or worktree ID.
Ctrl-C during run/resume detaches from output; session keeps running.

Config: ${CONFIG_FILE}
`);
    if (command && command !== "--help" && command !== "-h") {
      console.error(`Unknown command: ${command}`);
      process.exit(1);
    }
}
