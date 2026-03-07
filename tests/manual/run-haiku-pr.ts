#!/usr/bin/env -S node --experimental-strip-types --no-warnings
/**
 * Manual test: Run real Claude Haiku with test profile to create a PR.
 *
 * Usage:
 *   GH_TOKEN=$(gh auth token) node --experimental-strip-types --no-warnings tests/manual/run-haiku-pr.ts
 *
 * This will:
 *   1. Clone ludamad/test-mfh as reference repo
 *   2. Start sidecar + Claude container with profile=test
 *   3. Claude Haiku clones the repo, makes a small change, creates a PR
 *   4. Print the PR URL
 */

import { mkdirSync, existsSync, rmSync, readFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execFileSync } from "child_process";

const ROOT_DIR = join(import.meta.dirname, "../..");
const TEST_REPO = "ludamad/test-mfh";
const TEST_REPO_URL = `https://github.com/${TEST_REPO}.git`;
const MODEL = "claude-haiku-4-5-20251001";

const TEST_DIR = join(tmpdir(), `claudebox-haiku-pr-${Date.now()}`);
const WORKTREES_DIR = join(TEST_DIR, "worktrees");
const SESSIONS_DIR = join(TEST_DIR, "sessions");
const STATS_DIR = join(TEST_DIR, "stats");
const REF_REPO_DIR = join(TEST_DIR, "reference-repo");

// Env setup before imports
process.env.CLAUDE_REPO_DIR = REF_REPO_DIR;
if (!process.env.CLAUDEBOX_DOCKER_IMAGE) {
  process.env.CLAUDEBOX_DOCKER_IMAGE = "aztecprotocol/devbox:3.0";
}

if (!process.env.GH_TOKEN) {
  console.error("GH_TOKEN required. Run: GH_TOKEN=$(gh auth token) node ... tests/manual/run-haiku-pr.ts");
  process.exit(1);
}

async function main() {
  console.log("=== Claude Haiku PR Test ===");
  console.log(`Repo: ${TEST_REPO}`);
  console.log(`Model: ${MODEL}`);
  console.log(`Test dir: ${TEST_DIR}`);
  console.log("");

  // Create dirs
  mkdirSync(WORKTREES_DIR, { recursive: true });
  mkdirSync(SESSIONS_DIR, { recursive: true });
  mkdirSync(STATS_DIR, { recursive: true });

  // Clone reference repo
  if (!existsSync(join(REF_REPO_DIR, ".git"))) {
    console.log("Cloning reference repo...");
    execFileSync("git", ["clone", "--bare", TEST_REPO_URL, join(REF_REPO_DIR, ".git")], {
      timeout: 120_000,
      stdio: "inherit",
    });
  }

  const { SessionStore } = await import("../../packages/libclaudebox/session-store.ts");
  const { DockerService } = await import("../../packages/libclaudebox/docker.ts");
  const { setPluginsDir } = await import("../../packages/libclaudebox/plugin-loader.ts");

  setPluginsDir(join(ROOT_DIR, "profiles"));

  const store = new SessionStore(SESSIONS_DIR, WORKTREES_DIR);
  const docker = new DockerService();

  const prompt = `You are working on the repo ${TEST_REPO}.

1. Clone the repo using clone_repo with ref "origin/main"
2. Add a file called "haiku-test-${Date.now()}.md" with a short haiku about testing software
3. Create a PR with the title "test: haiku from Claude" and a brief description

Keep it simple. Just clone, create the file, and open the PR.`;

  console.log("Prompt:", prompt.slice(0, 200));
  console.log("");

  let worktreeId = "";
  const exitCode = await docker.runContainerSession({
    prompt,
    userName: "haiku-test",
    profile: "test",
    targetRef: "origin/main",
    model: MODEL,
  }, store, undefined, (logUrl, wId) => {
    worktreeId = wId;
    console.log(`Session: ${wId}`);
    console.log(`Log URL: ${logUrl}`);
    console.log("");
  });

  console.log(`\nExit code: ${exitCode}`);

  // Read activity log
  if (worktreeId) {
    const activityPath = join(WORKTREES_DIR, worktreeId, "workspace", "activity.jsonl");
    if (existsSync(activityPath)) {
      const lines = readFileSync(activityPath, "utf-8").trim().split("\n");
      console.log(`\nActivity (${lines.length} events):`);
      for (const line of lines) {
        try {
          const e = JSON.parse(line);
          console.log(`  [${e.type}] ${(e.text || "").slice(0, 120)}`);
        } catch {}
      }
    }
  }

  // Clean up
  console.log(`\nClean up with: rm -rf ${TEST_DIR}`);
}

main().catch(e => {
  console.error("Fatal:", e);
  process.exit(1);
});
