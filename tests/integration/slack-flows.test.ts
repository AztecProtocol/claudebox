/**
 * Integration test: Slack message handling flows end-to-end with mocks.
 *
 * Tests queuing, hash-based resume, terminal commands, keyword parsing,
 * bot message filtering, capacity checks, new-session keyword, and
 * reaction-based message deletion.
 */

import { describe, it, before, after, beforeEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, rmSync, writeFileSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { randomBytes } from "crypto";

const TEST_DIR = join(tmpdir(), `cb-slack-flows-${Date.now()}`);

// Set required env vars BEFORE importing modules that read them at import time
process.env.CLAUDEBOX_API_SECRET = "test-secret";
process.env.CLAUDEBOX_SESSION_USER = "testuser";
process.env.CLAUDEBOX_SESSION_PASS = "testpass";
process.env.MAX_CONCURRENT = "5";
process.env.SLACK_BOT_TOKEN = "";

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

  async simulateCommand(name: string, payload: any): Promise<void> {
    const handlers = this.commandHandlers.get(name) || [];
    for (const handler of handlers) {
      await handler(payload);
    }
  }
}

/** Mock Slack client that records API calls. */
function createMockSlackClient() {
  const calls: { method: string; args: any }[] = [];
  const sayMessages: any[] = [];
  // Allow overriding conversations.history response per-test
  let historyResponse: any = { messages: [] };
  return {
    calls,
    sayMessages,
    setHistoryResponse(resp: any) { historyResponse = resp; },
    users: {
      info: async ({ user }: { user: string }) => {
        calls.push({ method: "users.info", args: { user } });
        return { user: { real_name: `User ${user}` } };
      },
    },
    conversations: {
      info: async ({ channel }: { channel: string }) => {
        calls.push({ method: "conversations.info", args: { channel } });
        return { channel: { name: "test-channel", is_im: false } };
      },
      replies: async () => ({ messages: [] }),
      history: async (args: any) => {
        calls.push({ method: "conversations.history", args });
        return historyResponse;
      },
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
      delete: async (args: any) => {
        calls.push({ method: "chat.delete", args });
        return { ok: true };
      },
    },
  };
}

// ── Mock Session Store ───────────────────────────────────────────

class MockWorktreeStore {
  sessions: Map<string, any> = new Map();
  bindings: Map<string, string> = new Map();
  worktreeCounter = 0;
  worktrees: Map<string, any> = new Map();
  worktreesDir = join(TEST_DIR, "worktrees");

  // Track calls for assertions
  queuedMessages: { logId: string; msg: any }[] = [];
  clearedBindings: { channel: string; threadTs: string }[] = [];

  findByHash(hash: string): any { return this.sessions.get(hash) || null; }

  findLastInThread(channel: string, threadTs: string): any {
    const key = `${channel}:${threadTs}`;
    const wtId = this.bindings.get(key);
    if (wtId) {
      for (const s of this.sessions.values()) {
        if (s.worktree_id === wtId) return s;
      }
    }
    return null;
  }

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

  save(logId: string, meta: any): void {
    this.sessions.set(logId, { ...meta, _log_id: logId });
  }

  update(logId: string, patch: any): void {
    const s = this.sessions.get(logId);
    if (s) Object.assign(s, patch);
  }

  updateWorktreeMeta(): void {}

  bindThread(channel: string, threadTs: string, worktreeId: string): void {
    this.bindings.set(`${channel}:${threadTs}`, worktreeId);
  }

  clearThreadBinding(channel: string, threadTs: string): void {
    this.clearedBindings.push({ channel, threadTs });
    this.bindings.delete(`${channel}:${threadTs}`);
  }

  queueMessage(logId: string, msg: any): void {
    this.queuedMessages.push({ logId, msg });
  }

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
  allSessions: any[] = [];
  lastSession: any = null;
  sessionCount = 0;
  completedWorktreeIds: string[] = [];

  async runContainerSession(
    opts: any, store: any,
    _onOutput?: any, onStart?: any,
  ): Promise<number> {
    this.lastSession = opts;
    this.allSessions.push({ ...opts });
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

  isRunning() { return false; }
}

// ── Tests ────────────────────────────────────────────────────────

const TEST_CHANNEL = "C_TEST_CHANNEL";

describe("Slack message handling flows", () => {
  let mockApp: MockSlackApp;
  let mockClient: ReturnType<typeof createMockSlackClient>;
  let mockStore: MockWorktreeStore;
  let mockDocker: MockDockerService;

  before(async () => {
    mkdirSync(TEST_DIR, { recursive: true });

    // Create a fake barretenberg-audit profile directory with an mcp-sidecar.ts stub
    const fakeProfilesDir = join(TEST_DIR, "profiles");
    const fakeProfileDir = join(fakeProfilesDir, "barretenberg-audit");
    mkdirSync(fakeProfileDir, { recursive: true });
    writeFileSync(join(fakeProfileDir, "mcp-sidecar.ts"), "// stub\nexport default {};\n");

    // Point profile discovery to our fake profiles dir so parseKeywords recognizes the profile
    const { setProfilesDir } = await import("../../packages/libclaudebox/profile-loader.ts");
    setProfilesDir(fakeProfilesDir);

    // Set up channel -> profile mapping
    const { setChannelMaps } = await import("../../packages/libclaudebox/runtime.ts");
    setChannelMaps(
      { [TEST_CHANNEL]: "main" },
      { [TEST_CHANNEL]: "default" },
    );
  });

  after(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  beforeEach(() => {
    mockApp = new MockSlackApp();
    mockClient = createMockSlackClient();
    mockStore = new MockWorktreeStore();
    mockDocker = new MockDockerService();
  });

  async function registerHandlers() {
    const { registerSlackHandlers } = await import("../../packages/libclaudebox/slack/handlers.ts");
    registerSlackHandlers(mockApp as any, mockStore as any, mockDocker as any);
  }

  /** Helper to simulate an @mention event. */
  async function simulateMention(text: string, opts: { threadTs?: string; user?: string; ts?: string; channel?: string } = {}) {
    const channel = opts.channel || TEST_CHANNEL;
    const ts = opts.ts || `${Date.now()}.000001`;
    const event: any = {
      channel,
      text: `<@UBOT> ${text}`,
      user: opts.user || "UTESTER",
      ts,
    };
    if (opts.threadTs) {
      event.thread_ts = opts.threadTs;
    }
    const sayMessages: any[] = [];
    await mockApp.simulateEvent("app_mention", {
      event,
      client: mockClient,
      say: async (msg: any) => { sayMessages.push(msg); },
    });
    return sayMessages;
  }

  // ── Test 1: Message queuing when session is running ──────────

  it("queues messages when a session is already running in the thread", async () => {
    await registerHandlers();

    // Create a running session in the store
    const worktreeId = randomBytes(8).toString("hex");
    const logId = `${worktreeId}-1`;
    mockStore.save(logId, {
      prompt: "initial work",
      user: "User U_TESTER",
      status: "running",
      worktree_id: worktreeId,
      profile: "",
      slack_channel: TEST_CHANNEL,
      slack_thread_ts: "1700000100.000001",
      started: new Date().toISOString(),
    });
    // Bind the thread to this worktree
    mockStore.bindThread(TEST_CHANNEL, "1700000100.000001", worktreeId);

    const prevCount = mockDocker.sessionCount;

    // Send a second mention in the same thread
    const sayMessages = await simulateMention("do more work", {
      threadTs: "1700000100.000001",
      ts: "1700000200.000001",
    });

    // Verify the message was queued (not a new session)
    assert.equal(mockDocker.sessionCount, prevCount, "Should NOT create a new session when one is running");
    assert.ok(mockStore.queuedMessages.length > 0, "Should queue the message");
    assert.equal(mockStore.queuedMessages[0].logId, logId, "Should queue to the correct session");
    assert.ok(mockStore.queuedMessages[0].msg.text.includes("do more work"), "Queued message should contain the text");

    // Verify the "hourglass Queued" response
    const hourglassMsg = sayMessages.find(m => typeof m.text === "string" && m.text.includes("Queued"));
    assert.ok(hourglassMsg, "Should respond with a queued message containing 'Queued'");
    assert.ok(hourglassMsg.text.includes(":hourglass:"), "Should include hourglass emoji");
  });

  // ── Test 2: Hash-based resume via app_mention ──────────────

  it("resumes a completed session when hash is mentioned", async () => {
    await registerHandlers();

    // Create a completed session with a known logId
    const worktreeId = randomBytes(8).toString("hex");
    const logId = `${worktreeId}-1`;
    mockStore.save(logId, {
      prompt: "original task",
      user: "User U_TESTER",
      status: "completed",
      exit_code: 0,
      worktree_id: worktreeId,
      profile: "barretenberg-audit",
      slack_channel: TEST_CHANNEL,
      slack_thread_ts: "1700000300.000001",
      started: new Date().toISOString(),
      finished: new Date().toISOString(),
    });

    // Send a mention with the logId to resume
    await simulateMention(`${logId} continue the work`, {
      ts: "1700000400.000001",
    });

    // Verify docker started a new session with the correct worktreeId
    assert.equal(mockDocker.sessionCount, 1, "Should create a resume session");
    assert.equal(mockDocker.lastSession.worktreeId, worktreeId,
      "Should resume with the original worktree ID");
    assert.ok(mockDocker.lastSession.prompt.includes("continue the work"),
      `Prompt should contain 'continue the work', got: ${mockDocker.lastSession.prompt}`);
  });

  // ── Test 3: Terminal command handling ──────────────────────

  it("handles /claudebox terminal <hash> slash command", async () => {
    await registerHandlers();

    // Create a completed session
    const worktreeId = randomBytes(8).toString("hex");
    const logId = `${worktreeId}-1`;
    mockStore.save(logId, {
      prompt: "some work",
      user: "User U_TESTER",
      status: "completed",
      exit_code: 0,
      worktree_id: worktreeId,
      profile: "",
      slack_channel: TEST_CHANNEL,
      started: new Date().toISOString(),
      finished: new Date().toISOString(),
    });

    // Simulate /claudebox terminal <worktreeId-1> slash command
    const ackMessages: any[] = [];
    await mockApp.simulateCommand("/claudebox", {
      ack: async (msg?: any) => { if (msg) ackMessages.push(msg); },
      command: {
        text: `terminal ${logId}`,
        channel_id: TEST_CHANNEL,
        user_id: "U_TESTER",
      },
      client: mockClient,
    });

    // Verify ack was called with a session URL
    assert.ok(ackMessages.length > 0, "Should ack with a message");
    assert.ok(ackMessages[0].text.includes("session"), "Should include 'session' in terminal response");
    assert.ok(ackMessages[0].text.includes("completed"), "Should include status in terminal response");
    // Should NOT start a new docker session
    assert.equal(mockDocker.sessionCount, 0, "Terminal command should not start a docker session");
  });

  // ── Test 4: Keyword parsing in prompts ─────────────────────

  it("parses --ci-allow and profile keywords from the prompt", async () => {
    await registerHandlers();

    await simulateMention("--ci-allow barretenberg-audit fix the bug", {
      ts: "1700000500.000001",
    });

    assert.equal(mockDocker.sessionCount, 1, "Should create exactly one session");
    assert.equal(mockDocker.lastSession.ciAllow, true, "Should have ciAllow");
    assert.equal(mockDocker.lastSession.profile, "barretenberg-audit", "Should use barretenberg-audit profile");
    assert.ok(mockDocker.lastSession.prompt.includes("fix the bug"),
      `Prompt should be 'fix the bug', got: ${mockDocker.lastSession.prompt}`);
    // The prompt should NOT include the flags
    assert.ok(!mockDocker.lastSession.prompt.includes("--ci-allow"),
      "Prompt should not contain flag '--ci-allow'");
  });

  // ── Test 5: Bot message filtering ──────────────────────────

  it("ignores messages with bot_id set", async () => {
    await registerHandlers();

    await mockApp.simulateEvent("message", {
      event: {
        channel: TEST_CHANNEL,
        channel_type: "im",
        text: "I am a bot message",
        bot_id: "B_SOME_BOT",
        ts: "1700000600.000001",
      },
      client: mockClient,
      say: async () => {},
    });

    assert.equal(mockDocker.sessionCount, 0, "Should NOT create a session for bot messages");
  });

  // ── Test 6: Capacity check ────────────────────────────────

  it("rejects messages when at capacity", async () => {
    await registerHandlers();

    // Bump active sessions to MAX_CONCURRENT (which is const 10 in config.ts)
    const { MAX_CONCURRENT } = await import("../../packages/libclaudebox/config.ts");
    const { incrActiveSessions, decrActiveSessions, getActiveSessions } = await import("../../packages/libclaudebox/runtime.ts");
    const initialActive = getActiveSessions();
    const needed = MAX_CONCURRENT - initialActive;
    for (let i = 0; i < needed; i++) incrActiveSessions();

    try {
      const sayMessages = await simulateMention("do something important", {
        ts: "1700000700.000001",
      });

      // Should NOT create a session
      assert.equal(mockDocker.sessionCount, 0, "Should NOT create a session when at capacity");

      // Should respond with at-capacity message
      const capacityMsg = sayMessages.find(m => typeof m.text === "string" && m.text.includes("capacity"));
      assert.ok(capacityMsg, "Should respond with a capacity message");
    } finally {
      // Restore active sessions
      for (let i = 0; i < needed; i++) decrActiveSessions();
    }
  });

  // ── Test 7: new-session keyword breaks thread binding ─────

  it("new-session keyword clears thread binding and creates a new session", async () => {
    await registerHandlers();

    // Create a previous session in a thread. The session has no worktree_id,
    // so the implicit thread-resume path (which requires worktree_id) falls
    // through to the keyword-parsing path where forceNew takes effect.
    const threadTs = "1700000800.000001";
    const oldWorktreeId = randomBytes(8).toString("hex");
    const logId = `${oldWorktreeId}-1`;
    mockStore.save(logId, {
      prompt: "old task",
      user: "User UTESTER",
      status: "completed",
      exit_code: 0,
      worktree_id: "", // no worktree_id so we fall through to parseKeywords
      profile: "",
      slack_channel: TEST_CHANNEL,
      slack_thread_ts: threadTs,
      started: new Date().toISOString(),
      finished: new Date().toISOString(),
    });
    // Bind the thread so clearThreadBinding has something to clear
    mockStore.bindThread(TEST_CHANNEL, threadTs, oldWorktreeId);

    // Send --new-session in the same thread
    await simulateMention("--new-session do something else", {
      threadTs,
      ts: "1700000900.000001",
    });

    // Verify clearThreadBinding was called
    assert.ok(
      mockStore.clearedBindings.some(b => b.channel === TEST_CHANNEL && b.threadTs === threadTs),
      "Should call clearThreadBinding for the thread",
    );

    // Verify a NEW session was created
    assert.equal(mockDocker.sessionCount, 1, "Should create a new session");
    // The prompt should be stripped of the new-session keyword
    assert.ok(mockDocker.lastSession.prompt.includes("do something else"),
      `Prompt should contain 'do something else', got: ${mockDocker.lastSession.prompt}`);
    assert.ok(!mockDocker.lastSession.prompt.includes("new-session"),
      "Prompt should not contain 'new-session' keyword");
  });

  // ── Test 8: Reaction :x: deletes bot message ─────────────

  it("deletes bot message when :x: reaction is added", async () => {
    await registerHandlers();

    const messageTs = "1700001000.000001";
    const channel = TEST_CHANNEL;

    // Set up conversations.history to return a message with bot_id
    mockClient.setHistoryResponse({
      messages: [{ ts: messageTs, bot_id: "B_OUR_BOT", text: "some bot message" }],
    });

    // Simulate reaction_added event
    await mockApp.simulateEvent("reaction_added", {
      event: {
        reaction: "x",
        user: "U_TESTER",
        item: {
          type: "message",
          channel,
          ts: messageTs,
        },
      },
      client: mockClient,
    });

    // Verify conversations.history was called to check if it's a bot message
    const historyCall = mockClient.calls.find(c => c.method === "conversations.history");
    assert.ok(historyCall, "Should call conversations.history to check the message");
    assert.equal(historyCall.args.channel, channel);
    assert.equal(historyCall.args.latest, messageTs);

    // Verify chat.delete was called
    const deleteCall = mockClient.calls.find(c => c.method === "chat.delete");
    assert.ok(deleteCall, "Should call chat.delete for bot message with :x: reaction");
    assert.equal(deleteCall.args.channel, channel);
    assert.equal(deleteCall.args.ts, messageTs);
  });

  it("does NOT delete non-bot message when :x: reaction is added", async () => {
    await registerHandlers();

    const messageTs = "1700001100.000001";
    const channel = TEST_CHANNEL;

    // Set up conversations.history to return a message WITHOUT bot_id
    mockClient.setHistoryResponse({
      messages: [{ ts: messageTs, text: "user message, no bot_id" }],
    });

    await mockApp.simulateEvent("reaction_added", {
      event: {
        reaction: "x",
        user: "U_TESTER",
        item: {
          type: "message",
          channel,
          ts: messageTs,
        },
      },
      client: mockClient,
    });

    // Verify chat.delete was NOT called
    const deleteCall = mockClient.calls.find(c => c.method === "chat.delete");
    assert.ok(!deleteCall, "Should NOT call chat.delete for non-bot messages");
  });
});
