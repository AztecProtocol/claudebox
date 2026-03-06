#!/usr/bin/env -S node --experimental-strip-types --no-warnings
/**
 * ClaudeBox CLI — run sessions locally or against a remote server.
 *
 * Usage:
 *   claudebox run --profile default "fix the flaky test"
 *   claudebox run --profile barretenberg-audit "audit ecc module"
 *   claudebox status
 *   claudebox profiles
 *
 * Config: ~/.claudebox/config.json
 *   { "server": "https://claudebox.work", "token": "..." }
 */

import { existsSync, readFileSync, mkdirSync } from "fs";
import { join, dirname } from "path";
import { homedir } from "os";

// ── Config ──────────────────────────────────────────────────────

interface CliConfig {
  server?: string;
  token?: string;
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

// ── Commands ────────────────────────────────────────────────────

async function runCommand(args: string[]): Promise<void> {
  const config = loadConfig();
  let profile = "default";
  let serverUrl = config.server || process.env.CLAUDEBOX_SERVER_URL || "";
  let serverToken = config.token || process.env.CLAUDEBOX_SERVER_TOKEN || "";
  let worktreeId = "";
  const promptParts: string[] = [];

  // Parse args
  for (let i = 0; i < args.length; i++) {
    if (args[i] === "--profile" && args[i + 1]) { profile = args[++i]; continue; }
    if (args[i].startsWith("--profile=")) { profile = args[i].split("=")[1]; continue; }
    if (args[i] === "--server" && args[i + 1]) { serverUrl = args[++i]; continue; }
    if (args[i].startsWith("--server=")) { serverUrl = args[i].split("=")[1]; continue; }
    if (args[i] === "--token" && args[i + 1]) { serverToken = args[++i]; continue; }
    if (args[i].startsWith("--token=")) { serverToken = args[i].split("=")[1]; continue; }
    if (args[i] === "--worktree" && args[i + 1]) { worktreeId = args[++i]; continue; }
    if (args[i].startsWith("--worktree=")) { worktreeId = args[i].split("=")[1]; continue; }
    if (args[i] === "--help" || args[i] === "-h") {
      console.log(`Usage: claudebox run [options] <prompt>

Options:
  --profile <name>    Profile to run (default: "default")
  --server <url>      ClaudeBox server URL (or set in ~/.claudebox/config.json)
  --token <token>     Server API token
  --worktree <id>     Resume an existing worktree

Config file: ${CONFIG_FILE}
  { "server": "https://claudebox.work", "token": "..." }
`);
      return;
    }
    promptParts.push(args[i]);
  }

  const prompt = promptParts.join(" ").trim();
  if (!prompt) {
    console.error("Error: prompt required. Usage: claudebox run --profile <name> <prompt>");
    process.exit(1);
  }

  // Remote mode: POST /run to server
  if (serverUrl) {
    console.log(`Sending to server: ${serverUrl}`);
    console.log(`Profile: ${profile}`);
    console.log(`Prompt: ${prompt.slice(0, 100)}${prompt.length > 100 ? "..." : ""}`);

    const res = await fetch(`${serverUrl.replace(/\/$/, "")}/run`, {
      method: "POST",
      headers: {
        "Content-Type": "application/json",
        Authorization: `Bearer ${serverToken}`,
      },
      body: JSON.stringify({
        prompt,
        profile,
        worktree_id: worktreeId || undefined,
        user: process.env.USER || "cli",
      }),
    });

    const data = await res.json() as any;
    if (!res.ok) {
      console.error(`Server error (${res.status}): ${data.error || JSON.stringify(data)}`);
      process.exit(1);
    }

    console.log(`Session started: ${data.log_url || data.log_id || "ok"}`);
    if (data.log_url) console.log(`Log: ${data.log_url}`);
    if (data.worktree_id) console.log(`Worktree: ${data.worktree_id}`);
    return;
  }

  // Local mode: run Docker directly
  console.log("No server configured — running locally.");
  console.log(`Profile: ${profile}`);

  // Check if profile requires server
  const rootDir = dirname(import.meta.url.replace("file://", ""));
  const { setProfilesDir, loadProfile } = await import("./packages/libclaudebox/profile-loader.ts");
  setProfilesDir(join(rootDir, "profiles"));
  const manifest = await loadProfile(profile);
  if (manifest.requiresServer) {
    console.error(`Error: profile "${profile}" requires a claudebox server.`);
    console.error(`Configure one in ${CONFIG_FILE} or pass --server <url>.`);
    process.exit(1);
  }

  // Import Docker service and run
  const { SessionStore } = await import("./packages/libclaudebox/session-store.ts");
  const { DockerService } = await import("./packages/libclaudebox/docker.ts");

  const store = new SessionStore();
  const docker = new DockerService();

  const exitCode = await docker.runContainerSession({
    prompt,
    userName: process.env.USER || "cli",
    worktreeId: worktreeId || undefined,
    profile,
  }, store, (data) => {
    process.stdout.write(data);
  }, (logUrl, wId) => {
    console.log(`Log: ${logUrl}`);
    console.log(`Worktree: ${wId}`);
  });

  process.exit(exitCode);
}

async function statusCommand(args: string[]): Promise<void> {
  const config = loadConfig();
  const serverUrl = config.server || process.env.CLAUDEBOX_SERVER_URL || "";
  const serverToken = config.token || process.env.CLAUDEBOX_SERVER_TOKEN || "";

  if (serverUrl) {
    const res = await fetch(`${serverUrl.replace(/\/$/, "")}/health`, {
      headers: serverToken ? { Authorization: `Bearer ${serverToken}` } : {},
    });
    const data = await res.json() as any;
    console.log(`Server: ${serverUrl}`);
    console.log(`Status: ${data.status || "unknown"}`);
    console.log(`Active sessions: ${data.active ?? "?"} / ${data.max ?? "?"}`);
    return;
  }

  console.log("No server configured. Status only available with a server.");
  console.log(`Configure in ${CONFIG_FILE}`);
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
    const m = await loadProfile(name);
    const flags: string[] = [];
    if (m.requiresServer) flags.push("requires-server");
    if (m.channels?.length) flags.push(`channels: ${m.channels.join(", ")}`);
    if (m.server?.routes) flags.push("has-server-routes");
    console.log(`  ${name}${flags.length ? ` (${flags.join(", ")})` : ""}`);
  }
}

// ── Main ────────────────────────────────────────────────────────

const [command, ...args] = process.argv.slice(2);

switch (command) {
  case "run":
    runCommand(args).catch(e => { console.error(e.message); process.exit(1); });
    break;
  case "status":
    statusCommand(args).catch(e => { console.error(e.message); process.exit(1); });
    break;
  case "profiles":
    profilesCommand().catch(e => { console.error(e.message); process.exit(1); });
    break;
  default:
    console.log(`ClaudeBox CLI

Usage:
  claudebox run [--profile <name>] [--server <url>] <prompt>
  claudebox status
  claudebox profiles

Config: ${CONFIG_FILE}
`);
    if (command && command !== "--help" && command !== "-h") {
      console.error(`Unknown command: ${command}`);
      process.exit(1);
    }
}
