/**
 * Integration tests for local session workflow.
 *
 * Creates a real git repo, uses SessionStore to set up a worktree,
 * copies the repo into the workspace, runs mock-claude against it,
 * and verifies the workspace has the repo and session artifacts.
 *
 * No Docker, no changes to mainline CLI code — tests the building blocks
 * that `claudebox run` uses.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execFileSync, spawnSync } from "child_process";
import { randomUUID } from "crypto";

const MOCK_CLAUDE = join(import.meta.dirname, "../mocks/mock-claude.ts");
const NODE_ARGS = ["--experimental-strip-types", "--no-warnings"];

const TEST_DIR = join(tmpdir(), `claudebox-local-run-${Date.now()}`);
const FAKE_HOME = TEST_DIR;
const WORKTREES_DIR = join(FAKE_HOME, ".claudebox", "worktrees");
const SESSIONS_DIR = join(FAKE_HOME, ".claudebox", "sessions");

/** Create a test git repo with some files. */
function createTestRepo(): string {
  const repoDir = join(TEST_DIR, "test-repo");
  mkdirSync(join(repoDir, "src"), { recursive: true });
  writeFileSync(join(repoDir, "README.md"), "# Test Repo\nThis is a test.\n");
  writeFileSync(join(repoDir, "src", "main.ts"), 'console.log("hello world");\n');
  writeFileSync(join(repoDir, ".gitignore"), "node_modules/\n");
  execFileSync("git", ["init"], { cwd: repoDir });
  execFileSync("git", ["add", "."], { cwd: repoDir });
  execFileSync("git", ["commit", "-m", "initial commit"], {
    cwd: repoDir,
    env: {
      ...process.env,
      GIT_AUTHOR_NAME: "Test", GIT_AUTHOR_EMAIL: "test@test.com",
      GIT_COMMITTER_NAME: "Test", GIT_COMMITTER_EMAIL: "test@test.com",
    },
  });
  return repoDir;
}

/** Copy a directory tree into a destination. */
function copyDir(src: string, dest: string): void {
  execFileSync("cp", ["-a", `${src}/.`, dest], { timeout: 30_000 });
}

/** Run mock-claude in a workspace directory, simulating what Docker would do. */
function runMockClaude(opts: {
  workspaceDir: string;
  claudeProjectsDir: string;
  prompt: string;
  model?: string;
}): { stdout: string; stderr: string; status: number } {
  const args = [
    ...NODE_ARGS, MOCK_CLAUDE,
    "--print", "-p", opts.prompt,
  ];
  if (opts.model) args.push("--model", opts.model);

  const result = spawnSync("node", args, {
    env: {
      ...process.env,
      HOME: FAKE_HOME,
      CLAUDEBOX_PROJECTS_DIR: opts.claudeProjectsDir,
      CLAUDEBOX_WORKSPACE: opts.workspaceDir,
      MOCK_DELAY_MS: "10",
    },
    cwd: opts.workspaceDir,
    timeout: 15_000,
    encoding: "utf-8",
  });

  return {
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    status: result.status ?? 1,
  };
}

describe("local session lifecycle", () => {
  let repoDir: string;

  beforeEach(() => {
    mkdirSync(WORKTREES_DIR, { recursive: true });
    mkdirSync(SESSIONS_DIR, { recursive: true });
    repoDir = createTestRepo();
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("creates a worktree with workspace and claude-projects dirs", async () => {
    // Dynamically import SessionStore with overridden home
    const { SessionStore } = await import("../../packages/libclaudebox/session-store.ts");
    const store = new SessionStore(SESSIONS_DIR, WORKTREES_DIR);

    const wt = store.getOrCreateWorktree();
    assert.ok(existsSync(wt.workspaceDir), "workspace dir exists");
    assert.ok(existsSync(wt.claudeProjectsDir), "claude-projects dir exists");
    assert.match(wt.worktreeId, /^[a-f0-9]+$/, "worktree ID is hex");
  });

  it("repo is available in workspace after copy", async () => {
    const { SessionStore } = await import("../../packages/libclaudebox/session-store.ts");
    const store = new SessionStore(SESSIONS_DIR, WORKTREES_DIR);
    const wt = store.getOrCreateWorktree();

    // Copy repo into workspace (simulates Docker bind mount)
    copyDir(repoDir, wt.workspaceDir);

    assert.ok(existsSync(join(wt.workspaceDir, "README.md")), "README.md in workspace");
    assert.ok(existsSync(join(wt.workspaceDir, "src", "main.ts")), "src/main.ts in workspace");
    assert.ok(existsSync(join(wt.workspaceDir, ".git")), ".git in workspace");

    const readme = readFileSync(join(wt.workspaceDir, "README.md"), "utf-8");
    assert.match(readme, /Test Repo/);
  });

  it("mock-claude runs in workspace and sees repo files", async () => {
    const { SessionStore } = await import("../../packages/libclaudebox/session-store.ts");
    const store = new SessionStore(SESSIONS_DIR, WORKTREES_DIR);
    const wt = store.getOrCreateWorktree();

    copyDir(repoDir, wt.workspaceDir);

    const r = runMockClaude({
      workspaceDir: wt.workspaceDir,
      claudeProjectsDir: wt.claudeProjectsDir,
      prompt: "fix the flaky test in utils.test.ts",
    });

    assert.equal(r.status, 0, `mock-claude failed. stderr: ${r.stderr}`);

    // mock-claude lists workspace files — verify it sees the repo
    assert.match(r.stdout, /workspace files:.*README\.md/, "mock-claude sees README.md in workspace");
    assert.match(r.stdout, /workspace files:.*src/, "mock-claude sees src/ in workspace");
    assert.match(r.stdout, /workspace files:.*\.git/, "mock-claude sees .git in workspace");

    // mock-claude writes output files into workspace
    assert.ok(existsSync(join(wt.workspaceDir, "mock-output.txt")), "mock-output.txt exists");
    assert.ok(existsSync(join(wt.workspaceDir, "activity.jsonl")), "activity.jsonl exists");

    // Session JSONL in claude-projects
    const jsonlFiles = readdirSync(wt.claudeProjectsDir).filter(f => f.endsWith(".jsonl"));
    assert.ok(jsonlFiles.length >= 1, `Expected JSONL file, found: ${jsonlFiles}`);

    const content = readFileSync(join(wt.claudeProjectsDir, jsonlFiles[0]), "utf-8");
    assert.match(content, /"type":"init"/, "has init event");
    assert.match(content, /"type":"result"/, "has result event");
    assert.match(content, /fix the flaky test/, "prompt appears in session");
  });

  it("activity.jsonl has structured events", async () => {
    const { SessionStore } = await import("../../packages/libclaudebox/session-store.ts");
    const store = new SessionStore(SESSIONS_DIR, WORKTREES_DIR);
    const wt = store.getOrCreateWorktree();

    copyDir(repoDir, wt.workspaceDir);

    runMockClaude({
      workspaceDir: wt.workspaceDir,
      claudeProjectsDir: wt.claudeProjectsDir,
      prompt: "hello",
    });

    const activity = readFileSync(join(wt.workspaceDir, "activity.jsonl"), "utf-8");
    const events = activity.trim().split("\n").map(l => JSON.parse(l));

    assert.ok(events.length >= 2, `Expected at least 2 events, got ${events.length}`);
    assert.ok(events.some(e => e.type === "status"), "has status event");
    assert.ok(events.every(e => e.ts), "all events have timestamps");
  });

  it("workspace preserves git history from source repo", async () => {
    const { SessionStore } = await import("../../packages/libclaudebox/session-store.ts");
    const store = new SessionStore(SESSIONS_DIR, WORKTREES_DIR);
    const wt = store.getOrCreateWorktree();

    copyDir(repoDir, wt.workspaceDir);

    // Git log should work in the workspace
    const log = execFileSync("git", ["log", "--oneline"], {
      cwd: wt.workspaceDir,
      encoding: "utf-8",
    });
    assert.match(log, /initial commit/, "git history preserved");
  });

  it("mock-claude can read repo files from workspace", async () => {
    const { SessionStore } = await import("../../packages/libclaudebox/session-store.ts");
    const store = new SessionStore(SESSIONS_DIR, WORKTREES_DIR);
    const wt = store.getOrCreateWorktree();

    copyDir(repoDir, wt.workspaceDir);

    const r = runMockClaude({
      workspaceDir: wt.workspaceDir,
      claudeProjectsDir: wt.claudeProjectsDir,
      prompt: "review the code",
    });

    assert.equal(r.status, 0, `stderr: ${r.stderr}`);

    // The mock-claude simulates reading /workspace/prompt.txt via tool_use
    // Verify the session JSONL records a Read tool_use event
    const jsonlFiles = readdirSync(wt.claudeProjectsDir).filter(f => f.endsWith(".jsonl"));
    const content = readFileSync(join(wt.claudeProjectsDir, jsonlFiles[0]), "utf-8");
    assert.match(content, /"tool":"Read"/, "session records file read");
  });

  it("multiple sessions get separate worktrees", async () => {
    const { SessionStore } = await import("../../packages/libclaudebox/session-store.ts");
    const store = new SessionStore(SESSIONS_DIR, WORKTREES_DIR);

    const wt1 = store.getOrCreateWorktree();
    const wt2 = store.getOrCreateWorktree();

    assert.notEqual(wt1.worktreeId, wt2.worktreeId, "different IDs");
    assert.notEqual(wt1.workspaceDir, wt2.workspaceDir, "different workspace dirs");

    copyDir(repoDir, wt1.workspaceDir);
    copyDir(repoDir, wt2.workspaceDir);

    // Run mock-claude in both
    const r1 = runMockClaude({
      workspaceDir: wt1.workspaceDir,
      claudeProjectsDir: wt1.claudeProjectsDir,
      prompt: "fix bug A",
    });
    const r2 = runMockClaude({
      workspaceDir: wt2.workspaceDir,
      claudeProjectsDir: wt2.claudeProjectsDir,
      prompt: "fix bug B",
    });

    assert.equal(r1.status, 0);
    assert.equal(r2.status, 0);

    // Each has its own activity and session files
    assert.ok(existsSync(join(wt1.workspaceDir, "activity.jsonl")));
    assert.ok(existsSync(join(wt2.workspaceDir, "activity.jsonl")));

    const j1 = readdirSync(wt1.claudeProjectsDir).filter(f => f.endsWith(".jsonl"));
    const j2 = readdirSync(wt2.claudeProjectsDir).filter(f => f.endsWith(".jsonl"));
    assert.ok(j1.length >= 1);
    assert.ok(j2.length >= 1);
    assert.notEqual(j1[0], j2[0], "different session UUIDs");
  });
});
