/**
 * Integration tests for the local session workflow using Docker.
 *
 * Creates a real git repo, uses WorktreeStore to allocate a worktree,
 * copies the repo into the workspace, then runs mock-claude inside a
 * Docker container with the workspace bind-mounted at /workspace —
 * exactly as the real `claudebox run` does.
 *
 * Requires: Docker daemon running, ubuntu:latest image pulled.
 */

import { describe, it, before, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, readdirSync } from "fs";
import { join, resolve } from "path";
import { tmpdir } from "os";
import { execFileSync, spawnSync } from "child_process";

const MOCKS_DIR = resolve(import.meta.dirname, "../mocks");
const NODE_BIN = execFileSync("which", ["node"], { encoding: "utf-8" }).trim();
const DOCKER_IMAGE = "ubuntu:latest";

const TEST_DIR = join(tmpdir(), `claudebox-local-run-${Date.now()}`);
const WORKTREES_DIR = join(TEST_DIR, "worktrees");
const SESSIONS_DIR = join(TEST_DIR, "sessions");

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

/** Copy repo into workspace dir. */
function copyDir(src: string, dest: string): void {
  execFileSync("cp", ["-a", `${src}/.`, dest], { timeout: 30_000 });
}

/**
 * Run mock-claude inside a Docker container with workspace mounted at /workspace.
 * This mirrors the real `docker.runContainerSession()` bind mount setup.
 */
function runMockInDocker(opts: {
  workspaceDir: string;
  claudeProjectsDir: string;
  prompt: string;
  model?: string;
}): { stdout: string; stderr: string; status: number } {
  const args = [
    "run", "--rm",
    // Mount host node binary
    "-v", `${NODE_BIN}:/usr/bin/node:ro`,
    // Mount mock-claude scripts (read-only)
    "-v", `${MOCKS_DIR}:/opt/mocks:ro`,
    // Mount workspace at /workspace (read-write) — same as real flow
    "-v", `${opts.workspaceDir}:/workspace:rw`,
    // Mount claude-projects dir
    "-v", `${opts.claudeProjectsDir}:/home/claude/.claude/projects/-workspace:rw`,
    // Environment
    "-e", "CLAUDEBOX_WORKSPACE=/workspace",
    "-e", "CLAUDEBOX_PROJECTS_DIR=/home/claude/.claude/projects/-workspace",
    "-e", `CLAUDEBOX_PROMPT=${opts.prompt}`,
    "-e", "MOCK_DELAY_MS=10",
    // Working directory is /workspace
    "-w", "/workspace",
    DOCKER_IMAGE,
    "node", "--experimental-strip-types", "--no-warnings",
    "/opt/mocks/mock-claude.ts",
    "-p", opts.prompt,
    ...(opts.model ? ["--model", opts.model] : []),
  ];

  const result = spawnSync("docker", args, {
    timeout: 30_000,
    encoding: "utf-8",
  });

  return {
    stdout: result.stdout || "",
    stderr: result.stderr || "",
    status: result.status ?? 1,
  };
}

describe("local session lifecycle (Docker)", () => {
  let repoDir: string;

  before(() => {
    // Ensure Docker is available and image exists
    const check = spawnSync("docker", ["info"], { timeout: 5_000, encoding: "utf-8" });
    if (check.status !== 0) {
      console.log("Skipping: Docker not available");
      process.exit(0);
    }
    // Pull image if needed (usually cached)
    spawnSync("docker", ["pull", "-q", DOCKER_IMAGE], { timeout: 60_000 });
  });

  beforeEach(() => {
    mkdirSync(WORKTREES_DIR, { recursive: true });
    mkdirSync(SESSIONS_DIR, { recursive: true });
    repoDir = createTestRepo();
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("mock-claude inside Docker sees repo at /workspace", async () => {
    const { WorktreeStore } = await import("../../packages/libclaudebox/worktree-store.ts");
    const store = new WorktreeStore(SESSIONS_DIR, WORKTREES_DIR);
    const wt = store.getOrCreateWorktree();

    copyDir(repoDir, wt.workspaceDir);

    const r = runMockInDocker({
      workspaceDir: wt.workspaceDir,
      claudeProjectsDir: wt.claudeProjectsDir,
      prompt: "fix the flaky test",
    });

    assert.equal(r.status, 0, `Docker run failed. stderr: ${r.stderr}`);

    // mock-claude logs its cwd — should be /workspace
    assert.match(r.stdout, /cwd: \/workspace/, "cwd is /workspace inside container");

    // mock-claude lists files in workspace — should see our repo
    assert.match(r.stdout, /workspace files:.*README\.md/, "sees README.md");
    assert.match(r.stdout, /workspace files:.*src/, "sees src/");
    assert.match(r.stdout, /workspace files:.*\.git/, "sees .git/");
  });

  it("mock-claude writes artifacts to /workspace (visible on host)", async () => {
    const { WorktreeStore } = await import("../../packages/libclaudebox/worktree-store.ts");
    const store = new WorktreeStore(SESSIONS_DIR, WORKTREES_DIR);
    const wt = store.getOrCreateWorktree();

    copyDir(repoDir, wt.workspaceDir);

    const r = runMockInDocker({
      workspaceDir: wt.workspaceDir,
      claudeProjectsDir: wt.claudeProjectsDir,
      prompt: "hello world",
    });

    assert.equal(r.status, 0, `stderr: ${r.stderr}`);

    // Files written inside container at /workspace appear on host
    assert.ok(existsSync(join(wt.workspaceDir, "mock-output.txt")), "mock-output.txt on host");
    assert.ok(existsSync(join(wt.workspaceDir, "activity.jsonl")), "activity.jsonl on host");

    // Original repo files still there
    assert.ok(existsSync(join(wt.workspaceDir, "README.md")), "README.md preserved");
  });

  it("session JSONL is written to claude-projects dir", async () => {
    const { WorktreeStore } = await import("../../packages/libclaudebox/worktree-store.ts");
    const store = new WorktreeStore(SESSIONS_DIR, WORKTREES_DIR);
    const wt = store.getOrCreateWorktree();

    copyDir(repoDir, wt.workspaceDir);

    const r = runMockInDocker({
      workspaceDir: wt.workspaceDir,
      claudeProjectsDir: wt.claudeProjectsDir,
      prompt: "analyze the code",
    });

    assert.equal(r.status, 0, `stderr: ${r.stderr}`);

    // Session JSONL appears in claude-projects on host
    const jsonlFiles = readdirSync(wt.claudeProjectsDir).filter(f => f.endsWith(".jsonl"));
    assert.ok(jsonlFiles.length >= 1, `Expected JSONL files, found: ${jsonlFiles}`);

    const content = readFileSync(join(wt.claudeProjectsDir, jsonlFiles[0]), "utf-8");
    assert.match(content, /"type":"init"/, "has init event");
    assert.match(content, /"type":"result"/, "has result event");
    assert.match(content, /analyze the code/, "prompt in session");
  });

  it("activity.jsonl has structured events with timestamps", async () => {
    const { WorktreeStore } = await import("../../packages/libclaudebox/worktree-store.ts");
    const store = new WorktreeStore(SESSIONS_DIR, WORKTREES_DIR);
    const wt = store.getOrCreateWorktree();

    copyDir(repoDir, wt.workspaceDir);

    runMockInDocker({
      workspaceDir: wt.workspaceDir,
      claudeProjectsDir: wt.claudeProjectsDir,
      prompt: "test",
    });

    const activity = readFileSync(join(wt.workspaceDir, "activity.jsonl"), "utf-8");
    const events = activity.trim().split("\n").map(l => JSON.parse(l));

    assert.ok(events.length >= 2, `Expected ≥2 events, got ${events.length}`);
    assert.ok(events.some(e => e.type === "status"), "has status event");
    assert.ok(events.every(e => e.ts), "all events have timestamps");
  });

  it("git history is preserved inside container workspace", async () => {
    const { WorktreeStore } = await import("../../packages/libclaudebox/worktree-store.ts");
    const store = new WorktreeStore(SESSIONS_DIR, WORKTREES_DIR);
    const wt = store.getOrCreateWorktree();

    copyDir(repoDir, wt.workspaceDir);

    // Run git log inside container at /workspace (mount host git binary)
    const gitBin = execFileSync("which", ["git"], { encoding: "utf-8" }).trim();
    const r = spawnSync("docker", [
      "run", "--rm",
      "-v", `${wt.workspaceDir}:/workspace:rw`,
      "-v", `${gitBin}:/usr/bin/git:ro`,
      "-w", "/workspace",
      DOCKER_IMAGE,
      "git", "-c", "safe.directory=/workspace", "log", "--oneline",
    ], { timeout: 15_000, encoding: "utf-8" });

    assert.equal(r.status, 0, `git log failed. stderr: ${r.stderr}`);
    assert.match(r.stdout, /initial commit/, "git history accessible at /workspace");
  });

  it("multiple sessions get isolated workspaces", async () => {
    const { WorktreeStore } = await import("../../packages/libclaudebox/worktree-store.ts");
    const store = new WorktreeStore(SESSIONS_DIR, WORKTREES_DIR);

    const wt1 = store.getOrCreateWorktree();
    const wt2 = store.getOrCreateWorktree();
    assert.notEqual(wt1.worktreeId, wt2.worktreeId);

    copyDir(repoDir, wt1.workspaceDir);
    copyDir(repoDir, wt2.workspaceDir);

    // Add a unique marker file to each workspace
    writeFileSync(join(wt1.workspaceDir, "session-marker.txt"), "session-1");
    writeFileSync(join(wt2.workspaceDir, "session-marker.txt"), "session-2");

    const r1 = runMockInDocker({
      workspaceDir: wt1.workspaceDir,
      claudeProjectsDir: wt1.claudeProjectsDir,
      prompt: "fix bug A",
    });
    const r2 = runMockInDocker({
      workspaceDir: wt2.workspaceDir,
      claudeProjectsDir: wt2.claudeProjectsDir,
      prompt: "fix bug B",
    });

    assert.equal(r1.status, 0);
    assert.equal(r2.status, 0);

    // Each workspace has its own artifacts
    assert.ok(existsSync(join(wt1.workspaceDir, "activity.jsonl")));
    assert.ok(existsSync(join(wt2.workspaceDir, "activity.jsonl")));

    // Marker files are distinct
    assert.equal(readFileSync(join(wt1.workspaceDir, "session-marker.txt"), "utf-8"), "session-1");
    assert.equal(readFileSync(join(wt2.workspaceDir, "session-marker.txt"), "utf-8"), "session-2");

    // Session JSONLs are separate
    const j1 = readdirSync(wt1.claudeProjectsDir).filter(f => f.endsWith(".jsonl"));
    const j2 = readdirSync(wt2.claudeProjectsDir).filter(f => f.endsWith(".jsonl"));
    assert.ok(j1.length >= 1);
    assert.ok(j2.length >= 1);
    assert.notEqual(j1[0], j2[0], "different session UUIDs");
  });
});
