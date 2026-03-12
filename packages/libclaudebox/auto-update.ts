/**
 * Auto-updater for ClaudeBox.
 *
 * Polls origin/next. When new commits are found:
 *   1. git fetch origin next
 *   2. git reset --hard origin/next
 *   3. ./bootstrap.sh
 *   4. Exit with code 75 (EX_TEMPFAIL) — systemd or wrapper restarts us
 */

import { execFileSync, execSync } from "child_process";

const POLL_INTERVAL = 60_000; // 1 minute
const BRANCH = "origin/next";
const RESTART_EXIT_CODE = 75; // EX_TEMPFAIL — signals "restart me"

let repoDir = "";
let updating = false;

function git(...args: string[]): string {
  return execFileSync("git", args, {
    cwd: repoDir,
    encoding: "utf-8",
    timeout: 30_000,
  }).trim();
}

function checkAndUpdate(): void {
  if (updating) return;
  updating = true;

  try {
    const before = git("rev-parse", "HEAD");

    git("fetch", "origin", "next", "--quiet");

    const after = git("rev-parse", BRANCH);
    if (before === after) {
      updating = false;
      return;
    }

    console.log(`[AUTOUPDATE] ${before.slice(0, 8)} → ${after.slice(0, 8)}`);

    try {
      const log = git("log", "--oneline", `${before}..${after}`, "--max-count=10");
      if (log) console.log(`[AUTOUPDATE] Changes:\n${log}`);
    } catch {}

    git("reset", "--hard", BRANCH);
    console.log(`[AUTOUPDATE] Reset to ${BRANCH}`);

    console.log("[AUTOUPDATE] Running bootstrap.sh...");
    execSync("./bootstrap.sh", {
      cwd: repoDir,
      stdio: "inherit",
      timeout: 120_000,
    });

    console.log("[AUTOUPDATE] Exiting for restart...");
    process.exit(RESTART_EXIT_CODE);
  } catch (e: any) {
    console.error(`[AUTOUPDATE] Error: ${e.message}`);
    updating = false;
  }
}

/**
 * Start the auto-updater. Call once from server.ts.
 * @param dir - The repo directory to update
 */
export function startAutoUpdate(dir?: string): void {
  repoDir = dir || process.cwd();

  try {
    git("rev-parse", "--git-dir");
  } catch {
    console.warn("[AUTOUPDATE] Not a git repo, disabled");
    return;
  }

  const head = git("rev-parse", "HEAD").slice(0, 8);
  console.log(`  Auto-update: enabled (${head}, poll ${POLL_INTERVAL / 1000}s)`);

  setTimeout(checkAndUpdate, 10_000);
  setInterval(checkAndUpdate, POLL_INTERVAL);
}
