/**
 * End-to-end session test using the test profile.
 *
 * Exercises the full lifecycle:
 *   1. Ensure reference repo exists (clone ludamad/test-mfh if needed)
 *   2. DockerService.runContainerSession() with profile=test
 *   3. mock-claude.sh calls MCP tools via JSON-RPC
 *   4. Verify activity.jsonl has expected tool calls
 *   5. Session appears in SessionStore
 *   6. Clean up
 *
 * Requires: Docker daemon, network access (for initial repo clone).
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, existsSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execFileSync, spawnSync } from "child_process";

const ROOT_DIR = join(import.meta.dirname, "../..");
const TEST_REPO = "ludamad/test-mfh";
const TEST_REPO_URL = `https://github.com/${TEST_REPO}.git`;

// Use a temp dir for all test state
const TEST_DIR = join(tmpdir(), `claudebox-e2e-${Date.now()}`);
const WORKTREES_DIR = join(TEST_DIR, "worktrees");
const SESSIONS_DIR = join(TEST_DIR, "sessions");
const STATS_DIR = join(TEST_DIR, "stats");
const CLAUDEBOX_DIR = join(TEST_DIR, "claudebox-home");
const REF_REPO_DIR = join(TEST_DIR, "reference-repo");

// Set env vars BEFORE any imports that might trigger config.ts
process.env.CLAUDE_REPO_DIR = REF_REPO_DIR;
if (!process.env.CLAUDEBOX_DOCKER_IMAGE) {
  process.env.CLAUDEBOX_DOCKER_IMAGE = "aztecprotocol/devbox:3.0";
}

describe("e2e session lifecycle (test profile)", () => {
  before(async () => {
    // Check Docker
    const check = spawnSync("docker", ["info"], { timeout: 5_000, encoding: "utf-8" });
    if (check.status !== 0) {
      console.log("Skipping: Docker not available");
      process.exit(0);
    }

    // Create dirs
    mkdirSync(WORKTREES_DIR, { recursive: true });
    mkdirSync(SESSIONS_DIR, { recursive: true });
    mkdirSync(STATS_DIR, { recursive: true });
    mkdirSync(CLAUDEBOX_DIR, { recursive: true });

    // Clone reference repo if needed
    if (!existsSync(join(REF_REPO_DIR, ".git"))) {
      console.log(`Cloning reference repo: ${TEST_REPO_URL}`);
      execFileSync("git", ["clone", "--bare", TEST_REPO_URL, join(REF_REPO_DIR, ".git")], {
        timeout: 120_000,
        stdio: "inherit",
      });
      console.log("Reference repo cloned.");
    }
  });

  after(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("runs full session with mock-claude exercising MCP tools", async () => {
    const { SessionStore } = await import("../../packages/libclaudebox/session-store.ts");
    const { DockerService } = await import("../../packages/libclaudebox/docker.ts");
    const { setPluginsDir, loadPlugin } = await import("../../packages/libclaudebox/plugin-loader.ts");

    setPluginsDir(join(ROOT_DIR, "profiles"));
    const plugin = await loadPlugin("test");
    assert.equal(plugin.name, "test");

    const store = new SessionStore(SESSIONS_DIR, WORKTREES_DIR);
    const docker = new DockerService();

    // ── Run session ──
    let capturedWorktreeId = "";
    let capturedLogUrl = "";

    const exitCode = await docker.runContainerSession({
      prompt: "Test the MCP tools end-to-end",
      userName: "e2e-test",
      profile: "test",
      targetRef: "origin/main",
    }, store, undefined, (logUrl, worktreeId) => {
      capturedWorktreeId = worktreeId;
      capturedLogUrl = logUrl;
      console.log(`  Session started: ${worktreeId}`);
      console.log(`  Log URL: ${logUrl}`);
    });

    console.log(`  Exit code: ${exitCode}`);

    // ── Assertions ──

    // Session completed
    assert.equal(exitCode, 0, "mock-claude should exit 0");
    assert.ok(capturedWorktreeId, "should have worktree ID");

    // Worktree dirs exist
    const workspaceDir = join(WORKTREES_DIR, capturedWorktreeId, "workspace");
    const claudeProjectsDir = join(WORKTREES_DIR, capturedWorktreeId, "claude-projects");
    assert.ok(existsSync(workspaceDir), "workspace dir exists");
    assert.ok(existsSync(claudeProjectsDir), "claude-projects dir exists");

    // Activity log exists and has expected events
    const activityPath = join(workspaceDir, "activity.jsonl");
    assert.ok(existsSync(activityPath), "activity.jsonl exists");

    const activityLines = readFileSync(activityPath, "utf-8").trim().split("\n");
    const events = activityLines.map(l => {
      try { return JSON.parse(l); } catch { return null; }
    }).filter(Boolean);

    console.log(`  Activity events: ${events.length}`);
    for (const e of events) {
      console.log(`    [${e.type}] ${e.text?.slice(0, 80)}`);
    }

    // Check that MCP tools were called
    const toolEvents = events.filter(e => e.type === "tool");
    const toolNames = toolEvents.map(e => e.text?.replace("Called ", ""));
    console.log(`  Tools called: ${toolNames.join(", ")}`);

    assert.ok(toolEvents.length >= 3, `Expected ≥3 tool calls, got ${toolEvents.length}`);
    assert.ok(toolNames.includes("get_context"), "should call get_context");
    assert.ok(toolNames.includes("set_workspace_name"), "should call set_workspace_name");
    assert.ok(toolNames.includes("clone_repo"), "should call clone_repo");

    // Check repo was cloned
    const cloneStatus = events.find(e => e.text?.includes("Repo cloned"));
    assert.ok(cloneStatus, "should report repo cloned successfully");

    // Session in store
    const session = store.findByWorktreeId(capturedWorktreeId);
    assert.ok(session, "session should be in store");
    assert.equal(session!.status, "completed");
    assert.equal(session!.profile, "test");
    assert.equal(session!.user, "e2e-test");

    console.log("  ✓ Full e2e lifecycle passed");
  });
});
