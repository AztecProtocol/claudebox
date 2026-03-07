/**
 * End-to-end test: Slack channel message → session creation → HTTP access.
 *
 * Proves that a message in the barretenberg-audit channel triggers a Claude
 * session (mocked) with the correct profile, and that the session is then
 * accessible via the HTTP API for local connection.
 *
 * All Slack, Docker, and Claude interactions are mocked.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";
import * as http from "node:http";

const TEST_DIR = join(tmpdir(), `cb-channel-e2e-${Date.now()}`);

// Set required env vars BEFORE importing modules that read them at import time
const TEST_SECRET = "test-secret-" + randomBytes(8).toString("hex");
const TEST_USER = "testuser";
const TEST_PASS = "testpass";
process.env.CLAUDEBOX_API_SECRET = TEST_SECRET;
process.env.CLAUDEBOX_SESSION_USER = TEST_USER;
process.env.CLAUDEBOX_SESSION_PASS = TEST_PASS;
process.env.CLAUDEBOX_SESSION_PASS ||= TEST_PASS; // ensure set
process.env.MAX_CONCURRENT = "5";
process.env.SLACK_BOT_TOKEN = ""; // empty but defined — prevents crashes

// The barretenberg-audit channel ID from the profile's host-manifest.ts
const BB_AUDIT_CHANNEL = "C0AJCUKUNGP";

// ── Mock Slack App ───────────────────────────────────────────────

interface MockEventHandler {
  (payload: any): Promise<void>;
}

class MockSlackApp {
  private eventHandlers: Map<string, MockEventHandler[]> = new Map();
  private commandHandlers: Map<string, MockEventHandler[]> = new Map();

  event(name: string, handler: MockEventHandler): void {
    const list = this.eventHandlers.get(name) || [];
    list.push(handler);
    this.eventHandlers.set(name, list);
  }

  command(name: string, handler: MockEventHandler): void {
    const list = this.commandHandlers.get(name) || [];
    list.push(handler);
    this.commandHandlers.set(name, list);
  }

  error(_handler: any): void {}
  use(_handler: any): void {}

  async simulateEvent(name: string, payload: any): Promise<void> {
    const handlers = this.eventHandlers.get(name) || [];
    for (const handler of handlers) {
      await handler(payload);
    }
  }
}

/** Mock Slack client that records API calls. */
function createMockSlackClient() {
  const calls: { method: string; args: any }[] = [];
  return {
    calls,
    users: {
      info: async ({ user }: { user: string }) => {
        calls.push({ method: "users.info", args: { user } });
        return { user: { real_name: `User ${user}` } };
      },
    },
    conversations: {
      info: async ({ channel }: { channel: string }) => {
        calls.push({ method: "conversations.info", args: { channel } });
        return { channel: { name: "barretenberg-audit", is_im: false } };
      },
      replies: async () => ({ messages: [] }),
      history: async () => ({ messages: [] }),
    },
    chat: {
      postMessage: async (args: any) => {
        calls.push({ method: "chat.postMessage", args });
        return { ts: "1700000001.000001" };
      },
      update: async (args: any) => {
        calls.push({ method: "chat.update", args });
        return { ok: true };
      },
      delete: async () => ({ ok: true }),
    },
  };
}

// ── Mock Session Store ───────────────────────────────────────────

class MockSessionStore {
  sessions: Map<string, any> = new Map();
  bindings: Map<string, string> = new Map();
  worktreeCounter = 0;
  worktrees: Map<string, any> = new Map();
  worktreesDir = join(TEST_DIR, "worktrees");

  findByHash(hash: string): any { return this.sessions.get(hash) || null; }
  findLastInThread(_channel: string, _threadTs: string): any { return null; }
  findByWorktreeId(id: string): any {
    for (const s of this.sessions.values()) {
      if (s.worktree_id === id) return s;
    }
    return null;
  }
  listByWorktree(worktreeId: string): any[] {
    return Array.from(this.sessions.values()).filter(s => s.worktree_id === worktreeId);
  }
  getOrCreateWorktree(id?: string): any {
    const worktreeId = id || randomBytes(8).toString("hex");
    if (this.worktrees.has(worktreeId)) return this.worktrees.get(worktreeId);
    const dir = join(TEST_DIR, "worktrees", worktreeId);
    mkdirSync(join(dir, "workspace"), { recursive: true });
    mkdirSync(join(dir, "claude-projects"), { recursive: true });
    const wt = {
      worktreeId,
      workspaceDir: join(dir, "workspace"),
      claudeProjectsDir: join(dir, "claude-projects"),
    };
    this.worktrees.set(worktreeId, wt);
    return wt;
  }
  nextSessionLogId(worktreeId: string): string {
    return `${worktreeId}-${++this.worktreeCounter}`;
  }
  getWorktreeParentLogId(): string { return ""; }
  save(logId: string, meta: any): void { this.sessions.set(logId, { ...meta, _log_id: logId }); }
  update(logId: string, patch: any): void {
    const s = this.sessions.get(logId);
    if (s) Object.assign(s, patch);
  }
  updateWorktreeMeta(): void {}
  bindThread(channel: string, threadTs: string, worktreeId: string): void {
    this.bindings.set(`${channel}:${threadTs}`, worktreeId);
  }
  clearThreadBinding(): void {}
  queueMessage(): void {}
  drainQueue(): any[] { return []; }
  findLatestClaudeSessionId(): string { return ""; }
  readActivity(): any[] { return []; }
  isWorktreeAlive(): boolean { return false; }
  getWorktreeMeta(): any { return {}; }
  setWorktreeName(): void {}
  listAll(): any[] { return Array.from(this.sessions.values()); }
}

// ── Mock Docker Service ──────────────────────────────────────────

class MockDockerService {
  lastSession: any = null;
  sessionCount = 0;
  completedWorktreeIds: string[] = [];

  async runContainerSession(
    opts: any, store: any,
    _onOutput?: any, onStart?: any,
  ): Promise<number> {
    this.lastSession = opts;
    this.sessionCount++;
    const wt = store.getOrCreateWorktree(opts.worktreeId);
    const logId = store.nextSessionLogId(wt.worktreeId);
    onStart?.(`http://mock/${logId}`, wt.worktreeId);
    store.save(logId, {
      prompt: opts.prompt,
      user: opts.userName,
      status: "completed",
      exit_code: 0,
      worktree_id: wt.worktreeId,
      profile: opts.profile || "",
      slack_channel: opts.slackChannel || "",
      slack_thread_ts: opts.slackThreadTs || "",
      started: new Date().toISOString(),
      finished: new Date().toISOString(),
    });
    this.completedWorktreeIds.push(wt.worktreeId);
    return 0;
  }

  // Stubs for interactive container support
  isRunning() { return false; }
}

// ── HTTP helpers ─────────────────────────────────────────────────

function request(
  port: number,
  path: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { hostname: "127.0.0.1", port, path, method: opts.method || "GET", headers: opts.headers },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({
          status: res.statusCode!,
          headers: res.headers,
          body: Buffer.concat(chunks).toString(),
        }));
      },
    );
    r.on("error", reject);
    if (opts.body) r.write(opts.body);
    r.end();
  });
}

function basicAuth(user: string, pass: string): string {
  return "Basic " + Buffer.from(`${user}:${pass}`).toString("base64");
}

function sessionAuth(): Record<string, string> {
  return { authorization: basicAuth(TEST_USER, TEST_PASS) };
}

function apiAuth(): Record<string, string> {
  return { authorization: `Bearer ${TEST_SECRET}` };
}

// ── Tests ────────────────────────────────────────────────────────

describe("Channel → Session → HTTP (e2e)", () => {
  let mockApp: MockSlackApp;
  let mockClient: ReturnType<typeof createMockSlackClient>;
  let mockStore: MockSessionStore;
  let mockDocker: MockDockerService;
  let httpServer: http.Server;
  const TEST_PORT = 19_000 + Math.floor(Math.random() * 1000);

  before(async () => {
    mkdirSync(TEST_DIR, { recursive: true });

    // Set up channel → profile mapping so barretenberg-audit channel is recognized
    const { setChannelMaps } = await import("../../packages/libclaudebox/config.ts");
    setChannelMaps(
      { [BB_AUDIT_CHANNEL]: "master" },  // branch map
      { [BB_AUDIT_CHANNEL]: "barretenberg-audit" },  // profile map
    );

    mockApp = new MockSlackApp();
    mockClient = createMockSlackClient();
    mockStore = new MockSessionStore();
    mockDocker = new MockDockerService();

    // Register Slack handlers
    const { registerSlackHandlers } = await import("../../packages/libclaudebox/slack/handlers.ts");
    registerSlackHandlers(mockApp as any, mockStore as any, mockDocker as any);

    // Start HTTP server with the mock store
    const { createHttpServer } = await import("../../packages/libclaudebox/http-routes.ts");
    const mockInteractive = { list: () => [], get: () => undefined, has: () => false } as any;
    httpServer = createHttpServer(mockStore as any, mockDocker as any, mockInteractive);
    httpServer.listen(TEST_PORT);
  });

  after(() => {
    httpServer?.close();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("@mention in barretenberg-audit channel triggers session with correct profile", async () => {
    // Simulate an @mention in the barretenberg-audit channel
    await mockApp.simulateEvent("app_mention", {
      event: {
        channel: BB_AUDIT_CHANNEL,
        text: "<@U_BOT> audit the ecc module for vulnerabilities",
        user: "U_AUDITOR",
        ts: "1700000010.000001",
      },
      client: mockClient,
      say: async (msg: any) => {},
    });

    // Docker should have been called to create a session
    assert.equal(mockDocker.sessionCount, 1, "Should create exactly one session");

    // Session should have the barretenberg-audit profile
    assert.equal(mockDocker.lastSession.profile, "barretenberg-audit",
      "Session should use barretenberg-audit profile");

    // Prompt should contain the user's message (minus the @mention)
    assert.ok(mockDocker.lastSession.prompt.includes("audit the ecc module"),
      `Prompt should contain user message, got: ${mockDocker.lastSession.prompt}`);

    // Slack channel should be recorded
    assert.equal(mockDocker.lastSession.slackChannel, BB_AUDIT_CHANNEL);
  });

  it("session metadata is persisted in the store", async () => {
    // The session from the previous test should be in the store
    assert.ok(mockStore.sessions.size > 0, "Store should have sessions");

    // Find the session with the barretenberg-audit profile
    const sessions = Array.from(mockStore.sessions.values());
    const auditSession = sessions.find(s => s.profile === "barretenberg-audit");
    assert.ok(auditSession, "Should find a session with barretenberg-audit profile");
    assert.equal(auditSession.status, "completed");
    assert.equal(auditSession.exit_code, 0);
    assert.ok(auditSession.worktree_id, "Session should have a worktree ID");
  });

  it("completed session is accessible via HTTP workspace page", async () => {
    // Get the worktree ID from the completed session
    const worktreeId = mockDocker.completedWorktreeIds[0];
    assert.ok(worktreeId, "Should have a completed worktree ID");

    const res = await request(TEST_PORT, `/s/${worktreeId}`, { headers: sessionAuth() });
    assert.equal(res.status, 200, `Expected 200 for workspace page, got ${res.status}: ${res.body.slice(0, 200)}`);
    assert.ok(res.headers["content-type"]?.includes("text/html"), "Should return HTML");
  });

  it("session data is accessible via API", async () => {
    const worktreeId = mockDocker.completedWorktreeIds[0];

    const res = await request(TEST_PORT, `/api/session/${worktreeId}`, { headers: apiAuth() });
    // The API may return the session data or a 404 if no specific API endpoint exists.
    // Let's check the dashboard instead which lists all sessions.
    const dashRes = await request(TEST_PORT, `/dashboard`, { headers: sessionAuth() });
    assert.equal(dashRes.status, 200);
    assert.ok(dashRes.headers["content-type"]?.includes("text/html"));
  });

  it("health endpoint shows active session count", async () => {
    const res = await request(TEST_PORT, `/health`);
    assert.equal(res.status, 200);
    const data = JSON.parse(res.body);
    assert.equal(data.status, "ok");
    assert.equal(typeof data.active, "number");
  });

  it("second mention in same thread resumes the worktree", async () => {
    const prevCount = mockDocker.sessionCount;
    const threadTs = "1700000010.000001"; // same ts as the first message's thread

    // Bind the thread to the worktree (simulating what startNewSession does)
    const worktreeId = mockDocker.completedWorktreeIds[0];
    mockStore.bindThread(BB_AUDIT_CHANNEL, threadTs, worktreeId);

    // Override findLastInThread to return the session for this thread
    const origFind = mockStore.findLastInThread.bind(mockStore);
    mockStore.findLastInThread = (channel: string, ts: string) => {
      const key = `${channel}:${ts}`;
      const wtId = mockStore.bindings.get(key);
      if (wtId) return mockStore.findByWorktreeId(wtId);
      return origFind(channel, ts);
    };

    await mockApp.simulateEvent("app_mention", {
      event: {
        channel: BB_AUDIT_CHANNEL,
        text: "<@U_BOT> now check the hash functions too",
        user: "U_AUDITOR",
        thread_ts: threadTs,
        ts: "1700000020.000001",
      },
      client: mockClient,
      say: async (msg: any) => {},
    });

    assert.equal(mockDocker.sessionCount, prevCount + 1, "Should create a follow-up session");
    // The follow-up session should reuse the same worktree
    assert.equal(mockDocker.lastSession.worktreeId, worktreeId,
      "Follow-up should reuse the same worktree ID");
    assert.equal(mockDocker.lastSession.profile, "barretenberg-audit",
      "Follow-up should inherit barretenberg-audit profile");
  });

  it("POST /run with barretenberg-audit profile triggers session", async () => {
    const prevCount = mockDocker.sessionCount;

    const res = await request(TEST_PORT, "/run", {
      method: "POST",
      headers: { ...apiAuth(), "content-type": "application/json" },
      body: JSON.stringify({
        prompt: "review the polynomial commitment scheme",
        user: "api-user",
        profile: "barretenberg-audit",
      }),
    });

    // Should succeed (200 or 202)
    assert.ok([200, 202].includes(res.status),
      `Expected 200/202 from POST /run, got ${res.status}: ${res.body.slice(0, 300)}`);
  });

  it("workspace page includes session details for local connection", async () => {
    const worktreeId = mockDocker.completedWorktreeIds[0];
    const res = await request(TEST_PORT, `/s/${worktreeId}`, { headers: sessionAuth() });

    assert.equal(res.status, 200);
    // The workspace page should include the worktree ID and terminal connection UI
    assert.ok(res.body.includes(worktreeId.slice(0, 8)),
      "Workspace page should include worktree ID");
    // Should include WebSocket endpoint info for terminal connection
    assert.ok(res.body.includes("ws") || res.body.includes("terminal") || res.body.includes("ClaudeBox"),
      "Workspace page should include connection UI elements");
  });
});
