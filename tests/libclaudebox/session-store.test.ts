import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, existsSync, readFileSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";


import { SessionStore } from "../../packages/libclaudebox/session-store.ts";

const TEST_DIR = join(tmpdir(), `claudebox-test-sessions-${Date.now()}`);
const SESSIONS_DIR = join(TEST_DIR, "sessions");
const WORKTREES_DIR = join(TEST_DIR, "worktrees");

describe("SessionStore", () => {
  let store: SessionStore;

  beforeEach(() => {
    mkdirSync(SESSIONS_DIR, { recursive: true });
    mkdirSync(WORKTREES_DIR, { recursive: true });
    store = new SessionStore(SESSIONS_DIR, WORKTREES_DIR);
  });

  afterEach(() => {
    try { rmSync(TEST_DIR, { recursive: true }); } catch {}
  });

  describe("CRUD", () => {
    it("save and get a session", () => {
      store.save("abc123def456-1", { status: "running", user: "test" });
      const session = store.get("abc123def456-1");
      assert.ok(session);
      assert.equal(session.status, "running");
      assert.equal(session.user, "test");
      assert.equal(session._log_id, "abc123def456-1");
    });

    it("get returns null for non-existent session", () => {
      assert.equal(store.get("a0000000000-9"), null);
    });

    it("update patches existing session", () => {
      store.save("abc123def456-1", { status: "running", user: "test" });
      store.update("abc123def456-1", { status: "completed", exit_code: 0 });
      const session = store.get("abc123def456-1");
      assert.ok(session);
      assert.equal(session.status, "completed");
      assert.equal(session.exit_code, 0);
      assert.equal(session.user, "test"); // preserved
    });

    it("update creates file if it does not exist", () => {
      store.update("abc123def456-2", { status: "error" });
      const session = store.get("abc123def456-2");
      assert.ok(session);
      assert.equal(session.status, "error");
    });
  });

  describe("ID validation", () => {
    it("rejects path traversal in logId", () => {
      assert.throws(() => store.get("../../../etc/passwd"), /Invalid logId/);
    });

    it("rejects empty string", () => {
      assert.throws(() => store.get(""), /Invalid logId/);
    });

    it("rejects IDs starting with non-hex", () => {
      assert.throws(() => store.get("xyz"), /Invalid logId/);
    });

    it("accepts valid hex-based IDs", () => {
      // Should not throw
      store.save("a1b2c3d4e5f6-1", { status: "running" });
      assert.ok(store.get("a1b2c3d4e5f6-1"));
    });
  });

  describe("listAll", () => {
    it("returns empty array when no sessions", () => {
      assert.deepEqual(store.listAll(), []);
    });

    it("lists all sessions with _log_id set", () => {
      store.save("abc123000000-1", { status: "running" });
      store.save("abc123000000-2", { status: "completed" });
      const all = store.listAll();
      assert.equal(all.length, 2);
      assert.ok(all.every(s => s._log_id));
    });
  });

  describe("findLastInThread", () => {
    it("finds session by slack thread", () => {
      store.save("abc123000000-1", {
        status: "completed",
        slack_channel: "C123",
        slack_thread_ts: "1234567890.123456",
      });
      const found = store.findLastInThread("C123", "1234567890.123456");
      assert.ok(found);
      assert.equal(found.slack_channel, "C123");
    });

    it("returns null when no match", () => {
      assert.equal(store.findLastInThread("C999", "0000000000.000000"), null);
    });
  });

  describe("worktree management", () => {
    it("getOrCreateWorktree creates directory structure", () => {
      const wt = store.getOrCreateWorktree("a1b2c3d4e5f60000");
      assert.equal(wt.worktreeId, "a1b2c3d4e5f60000");
      assert.ok(existsSync(wt.workspaceDir));
      assert.ok(existsSync(wt.claudeProjectsDir));
    });

    it("getOrCreateWorktree returns same paths for same ID", () => {
      const wt1 = store.getOrCreateWorktree("a1b2c3d4e5f60000");
      const wt2 = store.getOrCreateWorktree("a1b2c3d4e5f60000");
      assert.equal(wt1.workspaceDir, wt2.workspaceDir);
      assert.equal(wt1.claudeProjectsDir, wt2.claudeProjectsDir);
    });

    it("nextSessionLogId increments based on existing sessions", () => {
      const id1 = store.nextSessionLogId("a1b2c3d4e5f60000");
      assert.equal(id1, "a1b2c3d4e5f60000-1");
      // Save a session with that ID so next call sees it
      store.save(id1, { status: "completed", worktree_id: "a1b2c3d4e5f60000" });
      const id2 = store.nextSessionLogId("a1b2c3d4e5f60000");
      assert.equal(id2, "a1b2c3d4e5f60000-2");
    });
  });

  describe("bindings", () => {
    it("bindThread and findByWorktreeId work together", () => {
      store.save("abc123000000-1", {
        status: "completed",
        worktree_id: "abc123000000",
        slack_channel: "C123",
        slack_thread_ts: "111.222",
      });
      store.getOrCreateWorktree("abc123000000");
      store.updateWorktreeMeta("abc123000000", "abc123000000-1");
      store.bindThread("C123", "111.222", "abc123000000");

      const found = store.findLastInThread("C123", "111.222");
      assert.ok(found);
      assert.equal(found.worktree_id, "abc123000000");
    });

    it("bindPr stores and retrieves PR binding", () => {
      store.getOrCreateWorktree("abc123000000");
      store.bindPr("owner/repo#123", "abc123000000");

      const worktreeId = store.getPrBinding("owner/repo#123");
      assert.equal(worktreeId, "abc123000000");
    });
  });

  describe("activity log", () => {
    it("readActivity returns empty array for new worktree", () => {
      store.getOrCreateWorktree("a1b2c3d4e5f60000");
      const activity = store.readActivity("a1b2c3d4e5f60000");
      assert.deepEqual(activity, []);
    });

    it("readActivity reads JSONL file (newest first)", () => {
      store.getOrCreateWorktree("a1b2c3d4e5f60000");
      const actPath = join(WORKTREES_DIR, "a1b2c3d4e5f60000", "workspace", "activity.jsonl");
      writeFileSync(actPath, '{"type":"status","text":"hello"}\n{"type":"response","text":"world"}\n');
      const activity = store.readActivity("a1b2c3d4e5f60000");
      assert.equal(activity.length, 2);
      // Reversed — newest first
      assert.equal(activity[0].type, "response");
      assert.equal(activity[1].type, "status");
    });
  });
});
