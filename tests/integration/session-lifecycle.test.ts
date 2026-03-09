import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, existsSync, readFileSync, readdirSync } from "fs";
import { join, dirname } from "path";
import { tmpdir } from "os";

import { WorktreeStore } from "../../packages/libclaudebox/worktree-store.ts";
import { MockDockerService } from "../mocks/mock-docker.ts";

const TEST_DIR = join(tmpdir(), `claudebox-integration-${Date.now()}`);
const SESSIONS_DIR = join(TEST_DIR, "sessions");
const WORKTREES_DIR = join(TEST_DIR, "worktrees");
const MOCK_CLAUDE = join(dirname(import.meta.url.replace("file://", "")), "..", "mocks", "mock-claude.ts");

describe("Session Lifecycle (integration)", () => {
  let store: WorktreeStore;
  let docker: MockDockerService;

  beforeEach(() => {
    mkdirSync(SESSIONS_DIR, { recursive: true });
    mkdirSync(WORKTREES_DIR, { recursive: true });
    store = new WorktreeStore(SESSIONS_DIR, WORKTREES_DIR);
    docker = new MockDockerService();
  });

  afterEach(() => {
    try { rmSync(TEST_DIR, { recursive: true }); } catch {}
  });

  it("runs a mock session end-to-end", async () => {
    const worktreeId = "a1b2c3d4e5f60000";
    const exitCode = await docker.runMockSession({
      prompt: "Fix the critical bug in parser.ts",
      userName: "testuser",
      worktreeId,
    }, store, MOCK_CLAUDE);

    assert.equal(exitCode, 0);

    // Session metadata should be saved
    const session = store.get(`${worktreeId}-1`);
    assert.ok(session, "session should exist");
    assert.equal(session!.status, "completed");
    assert.equal(session!.exit_code, 0);
    assert.equal(session!.user, "testuser");

    // Activity log should have been written
    const activity = store.readActivity(worktreeId);
    assert.ok(activity.length > 0, "should have activity entries");

    // Session JSONL should exist in claude projects dir
    const wt = store.getOrCreateWorktree(worktreeId);
    const projectsDir = wt.claudeProjectsDir;
    const jsonlFiles = readdirSync(projectsDir).filter(f => f.endsWith(".jsonl"));
    assert.ok(jsonlFiles.length > 0, "should have session JSONL file");

    // Read the JSONL and verify structure
    const jsonlContent = readFileSync(join(projectsDir, jsonlFiles[0]), "utf-8");
    const events = jsonlContent.trim().split("\n").map(l => JSON.parse(l));
    assert.ok(events.some(e => e.type === "init"), "should have init event");
    assert.ok(events.some(e => e.type === "assistant"), "should have assistant event");
    assert.ok(events.some(e => e.type === "result"), "should have result event");

    // Mock output file should exist
    const outputFile = join(wt.workspaceDir, "mock-output.txt");
    assert.ok(existsSync(outputFile), "mock should have created output file");
  });

  it("records correct metadata sequence", async () => {
    const worktreeId = "b1b2c3d4e5f60000";

    // First session
    const exit1 = await docker.runMockSession({
      prompt: "First task",
      userName: "user1",
      worktreeId,
    }, store, MOCK_CLAUDE);
    assert.equal(exit1, 0);

    // Second session on same worktree
    const exit2 = await docker.runMockSession({
      prompt: "Follow-up task",
      userName: "user1",
      worktreeId,
    }, store, MOCK_CLAUDE);
    assert.equal(exit2, 0);

    // Both sessions should exist
    const s1 = store.get(`${worktreeId}-1`);
    const s2 = store.get(`${worktreeId}-2`);
    assert.ok(s1, "first session should exist");
    assert.ok(s2, "second session should exist");
    assert.equal(s1!.prompt, "First task");
    assert.equal(s2!.prompt, "Follow-up task");

    // Both should be completed
    assert.equal(s1!.status, "completed");
    assert.equal(s2!.status, "completed");
  });

  it("handles session with profile", async () => {
    const worktreeId = "c1b2c3d4e5f60000";
    const exit = await docker.runMockSession({
      prompt: "Audit the ecc module",
      userName: "auditor",
      worktreeId,
      profile: "barretenberg-audit",
    }, store, MOCK_CLAUDE);

    assert.equal(exit, 0);
    const session = store.get(`${worktreeId}-1`);
    assert.ok(session);
    assert.equal(session!.profile, "barretenberg-audit");
  });

  it("stores session with slack context", async () => {
    const worktreeId = "d1b2c3d4e5f60000";
    const exit = await docker.runMockSession({
      prompt: "Handle PR review",
      userName: "dev",
      worktreeId,
      slackChannel: "C123456",
      slackThreadTs: "1234567890.123456",
    }, store, MOCK_CLAUDE);

    assert.equal(exit, 0);

    // Should be findable by thread
    store.bindThread("C123456", "1234567890.123456", worktreeId);
    const found = store.findLastInThread("C123456", "1234567890.123456");
    assert.ok(found, "should find session by thread");
    assert.equal(found!.worktree_id, worktreeId);
  });

  it("worktree isolation — sessions on different worktrees don't interfere", async () => {
    const wt1 = "e1b2c3d4e5f60001";
    const wt2 = "e1b2c3d4e5f60002";

    const [exit1, exit2] = await Promise.all([
      docker.runMockSession({ prompt: "Task A", worktreeId: wt1 }, store, MOCK_CLAUDE),
      docker.runMockSession({ prompt: "Task B", worktreeId: wt2 }, store, MOCK_CLAUDE),
    ]);

    assert.equal(exit1, 0);
    assert.equal(exit2, 0);

    const s1 = store.get(`${wt1}-1`);
    const s2 = store.get(`${wt2}-1`);
    assert.ok(s1);
    assert.ok(s2);
    assert.equal(s1!.prompt, "Task A");
    assert.equal(s2!.prompt, "Task B");

    // Each worktree should have its own activity
    const act1 = store.readActivity(wt1);
    const act2 = store.readActivity(wt2);
    assert.ok(act1.length > 0);
    assert.ok(act2.length > 0);
  });
});
