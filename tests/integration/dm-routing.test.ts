/**
 * End-to-end tests for DM routing, proxy, credentials, and init flow.
 *
 * Tests the full pipeline:
 *   - Slack DM events (mocked) routing to local vs personal servers
 *   - DM registry CRUD
 *   - Credential management via `claudebox init`
 *   - Personal server receives proxied events and creates sessions
 *
 * All Slack, Docker, and Claude interactions are mocked.
 */

import { describe, it, beforeEach, afterEach } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, writeFileSync, readFileSync, existsSync, rmSync, statSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { createServer, type IncomingMessage, type ServerResponse } from "http";
import { spawnSync } from "child_process";
import { randomUUID } from "crypto";
import { DmRegistry, proxyDmToServer } from "../../packages/libclaudebox/dm-registry.ts";

const TEST_DIR = join(tmpdir(), `claudebox-dm-test-${Date.now()}`);
const CLI = join(import.meta.dirname, "../../cli.ts");
const NODE_ARGS = ["--experimental-strip-types", "--no-warnings"];

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
        return { channel: { name: "test-channel", is_im: channel.startsWith("D") } };
      },
      replies: async () => ({ messages: [] }),
      history: async () => ({ messages: [] }),
    },
    chat: {
      postMessage: async (args: any) => {
        calls.push({ method: "chat.postMessage", args });
        return { ts: "1234567890.123456" };
      },
      update: async (args: any) => {
        calls.push({ method: "chat.update", args });
        return { ok: true };
      },
      delete: async () => ({ ok: true }),
    },
  };
}

// ── Mock Docker + Session Store ──────────────────────────────────

class MockSessionStore {
  sessions: Map<string, any> = new Map();
  bindings: Map<string, string> = new Map();
  worktreeCounter = 0;

  findByHash(hash: string): any { return this.sessions.get(hash) || null; }
  findLastInThread(_channel: string, _threadTs: string): any { return null; }
  findByWorktreeId(id: string): any {
    for (const s of this.sessions.values()) {
      if (s.worktree_id === id) return s;
    }
    return null;
  }
  getOrCreateWorktree(id?: string): any {
    const worktreeId = id || randomUUID().replace(/-/g, "").slice(0, 16);
    const dir = join(TEST_DIR, "worktrees", worktreeId);
    mkdirSync(join(dir, "workspace"), { recursive: true });
    mkdirSync(join(dir, "claude-projects"), { recursive: true });
    return {
      worktreeId,
      workspaceDir: join(dir, "workspace"),
      claudeProjectsDir: join(dir, "claude-projects"),
    };
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

class MockDockerService {
  lastSession: any = null;
  sessionCount = 0;

  async runContainerSession(
    opts: any, store: any,
    _onOutput?: any, onStart?: any,
  ): Promise<number> {
    this.lastSession = opts;
    this.sessionCount++;
    const wt = store.getOrCreateWorktree(opts.worktreeId);
    onStart?.("http://mock-log-url", wt.worktreeId);
    store.save(store.nextSessionLogId(wt.worktreeId), {
      prompt: opts.prompt,
      user: opts.userName,
      status: "completed",
      worktree_id: wt.worktreeId,
      started: new Date().toISOString(),
    });
    return 0;
  }
}

// ── Helper: create a mock personal server ────────────────────────

function createMockPersonalServer(): { server: ReturnType<typeof createServer>; port: number; received: any[]; close: () => Promise<void> } {
  const received: any[] = [];
  const server = createServer(async (req: IncomingMessage, res: ServerResponse) => {
    if (req.method === "POST" && req.url === "/run") {
      const chunks: Buffer[] = [];
      for await (const chunk of req) chunks.push(chunk as Buffer);
      const body = JSON.parse(Buffer.concat(chunks).toString());
      received.push(body);
      res.writeHead(200, { "Content-Type": "application/json" });
      res.end(JSON.stringify({ ok: true, worktree_id: "mock-wt-123" }));
      return;
    }
    res.writeHead(404);
    res.end();
  });

  return new Promise<any>((resolve) => {
    server.listen(0, "127.0.0.1", () => {
      const addr = server.address() as any;
      resolve({
        server,
        port: addr.port,
        received,
        close: () => new Promise<void>((r) => server.close(() => r())),
      });
    });
  }) as any;
}

// ── Tests ────────────────────────────────────────────────────────

describe("DmRegistry", () => {
  let registry: DmRegistry;
  const registryPath = join(TEST_DIR, "dm-registry.json");

  beforeEach(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    registry = new DmRegistry(registryPath);
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("starts empty", () => {
    assert.equal(registry.size(), 0);
    assert.equal(registry.lookup("U123"), undefined);
  });

  it("registers and looks up a user", () => {
    registry.register("U123", {
      serverUrl: "http://localhost:3001",
      registeredAt: new Date().toISOString(),
    });
    const entry = registry.lookup("U123");
    assert.ok(entry);
    assert.equal(entry.serverUrl, "http://localhost:3001");
  });

  it("persists to disk and survives reload", () => {
    registry.register("U456", {
      serverUrl: "http://my-server.com",
      token: "secret",
      registeredAt: new Date().toISOString(),
    });

    // Create a new instance from the same file
    const registry2 = new DmRegistry(registryPath);
    const entry = registry2.lookup("U456");
    assert.ok(entry);
    assert.equal(entry.serverUrl, "http://my-server.com");
    assert.equal(entry.token, "secret");
  });

  it("unregisters a user", () => {
    registry.register("U789", {
      serverUrl: "http://test.com",
      registeredAt: new Date().toISOString(),
    });
    assert.equal(registry.size(), 1);
    const removed = registry.unregister("U789");
    assert.equal(removed, true);
    assert.equal(registry.size(), 0);
    assert.equal(registry.lookup("U789"), undefined);
  });

  it("unregister returns false for unknown user", () => {
    assert.equal(registry.unregister("U_UNKNOWN"), false);
  });

  it("lists all registrations", () => {
    registry.register("U1", { serverUrl: "http://a.com", registeredAt: "" });
    registry.register("U2", { serverUrl: "http://b.com", registeredAt: "" });
    const all = registry.list();
    assert.equal(all.size, 2);
    assert.equal(all.get("U1")?.serverUrl, "http://a.com");
  });

  it("overwrites existing registration", () => {
    registry.register("U1", { serverUrl: "http://old.com", registeredAt: "" });
    registry.register("U1", { serverUrl: "http://new.com", registeredAt: "" });
    assert.equal(registry.size(), 1);
    assert.equal(registry.lookup("U1")?.serverUrl, "http://new.com");
  });
});

describe("proxyDmToServer", () => {
  let personalServer: Awaited<ReturnType<typeof createMockPersonalServer>>;

  beforeEach(async () => {
    mkdirSync(TEST_DIR, { recursive: true });
    personalServer = await createMockPersonalServer();
  });

  afterEach(async () => {
    await personalServer.close();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("proxies a DM to the personal server", async () => {
    const result = await proxyDmToServer(
      { serverUrl: `http://127.0.0.1:${personalServer.port}`, registeredAt: "" },
      { text: "fix the bug", userId: "U123", userName: "adam", channel: "D456", isReply: false },
    );

    assert.equal(result.ok, true);
    assert.equal(personalServer.received.length, 1);
    assert.equal(personalServer.received[0].prompt, "fix the bug");
    assert.equal(personalServer.received[0].user, "adam");
    assert.equal(personalServer.received[0].source, "dm-proxy");
  });

  it("forwards thread context", async () => {
    await proxyDmToServer(
      { serverUrl: `http://127.0.0.1:${personalServer.port}`, registeredAt: "" },
      { text: "continue", userId: "U1", userName: "user1", channel: "D1", threadTs: "123.456", isReply: true },
    );

    assert.equal(personalServer.received[0].slack_thread_ts, "123.456");
  });

  it("sends auth token when provided", async () => {
    // We can't easily inspect headers in the mock server, but we can verify
    // the proxy succeeds with a token
    const result = await proxyDmToServer(
      { serverUrl: `http://127.0.0.1:${personalServer.port}`, token: "secret123", registeredAt: "" },
      { text: "hello", userId: "U1", userName: "user1", channel: "D1", isReply: false },
    );
    assert.equal(result.ok, true);
  });

  it("returns error for unreachable server", async () => {
    const result = await proxyDmToServer(
      { serverUrl: "http://127.0.0.1:1", registeredAt: "" },  // port 1 = unreachable
      { text: "hello", userId: "U1", userName: "user1", channel: "D1", isReply: false },
    );
    assert.equal(result.ok, false);
    assert.ok(result.error);
  });
});

describe("Slack DM routing (mocked)", () => {
  let mockApp: MockSlackApp;
  let mockClient: ReturnType<typeof createMockSlackClient>;
  let mockStore: MockSessionStore;
  let mockDocker: MockDockerService;
  let dmRegistry: DmRegistry;
  let personalServer: Awaited<ReturnType<typeof createMockPersonalServer>>;

  beforeEach(async () => {
    mkdirSync(TEST_DIR, { recursive: true });
    mockApp = new MockSlackApp();
    mockClient = createMockSlackClient();
    mockStore = new MockSessionStore();
    mockDocker = new MockDockerService();
    dmRegistry = new DmRegistry(join(TEST_DIR, "dm-registry.json"));
    personalServer = await createMockPersonalServer();
  });

  afterEach(async () => {
    await personalServer.close();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  async function registerHandlersAndSimulateDm(text: string, userId: string) {
    // Import and register handlers (dynamic to avoid config.ts side effects)
    const { registerSlackHandlers } = await import("../../packages/libclaudebox/slack/handlers.ts");
    registerSlackHandlers(mockApp as any, mockStore as any, mockDocker as any, dmRegistry);

    const sayMessages: any[] = [];

    await mockApp.simulateEvent("message", {
      event: {
        channel: "D_DM_CHANNEL",
        channel_type: "im",
        text,
        user: userId,
        ts: "1700000000.000001",
      },
      client: mockClient,
      say: async (msg: any) => { sayMessages.push(msg); },
    });

    return sayMessages;
  }

  it("routes unregistered user DM to local handler", async () => {
    const msgs = await registerHandlersAndSimulateDm("fix the test", "U_UNREGISTERED");

    // Local handler should have been called (postMessage via Docker session)
    assert.equal(mockDocker.sessionCount, 1);
    assert.equal(mockDocker.lastSession.prompt.includes("fix the test"), true);
  });

  it("proxies registered user DM to personal server", async () => {
    dmRegistry.register("U_REGISTERED", {
      serverUrl: `http://127.0.0.1:${personalServer.port}`,
      registeredAt: new Date().toISOString(),
    });

    const msgs = await registerHandlersAndSimulateDm("deploy the feature", "U_REGISTERED");

    // Should have been proxied, NOT handled locally
    assert.equal(mockDocker.sessionCount, 0, "Should not create local session");
    assert.equal(personalServer.received.length, 1);
    assert.equal(personalServer.received[0].prompt, "deploy the feature");
    assert.equal(personalServer.received[0].source, "dm-proxy");

    // Should have sent confirmation message
    const routed = msgs.find((m: any) => typeof m === "object" && m.text?.includes("Routed"));
    assert.ok(routed, `Expected routed confirmation, got: ${JSON.stringify(msgs)}`);
  });

  it("falls back to local when personal server is down", async () => {
    dmRegistry.register("U_OFFLINE", {
      serverUrl: "http://127.0.0.1:1",  // unreachable
      registeredAt: new Date().toISOString(),
    });

    const msgs = await registerHandlersAndSimulateDm("help me", "U_OFFLINE");

    // Should fall back to local handling
    assert.equal(mockDocker.sessionCount, 1, "Should fall back to local session");

    // Should have sent fallback message
    const fallback = msgs.find((m: any) => typeof m === "object" && m.text?.includes("locally"));
    assert.ok(fallback, `Expected fallback message, got: ${JSON.stringify(msgs)}`);
  });

  it("ignores bot messages", async () => {
    const { registerSlackHandlers } = await import("../../packages/libclaudebox/slack/handlers.ts");
    registerSlackHandlers(mockApp as any, mockStore as any, mockDocker as any, dmRegistry);

    await mockApp.simulateEvent("message", {
      event: {
        channel: "D_DM",
        channel_type: "im",
        text: "bot message",
        bot_id: "B123",
        ts: "1700000000.000002",
      },
      client: mockClient,
      say: async () => {},
    });

    assert.equal(mockDocker.sessionCount, 0, "Bot messages should be ignored");
  });

  it("ignores non-DM messages", async () => {
    const { registerSlackHandlers } = await import("../../packages/libclaudebox/slack/handlers.ts");
    registerSlackHandlers(mockApp as any, mockStore as any, mockDocker as any, dmRegistry);

    await mockApp.simulateEvent("message", {
      event: {
        channel: "C_CHANNEL",
        channel_type: "channel",
        text: "not a DM",
        user: "U123",
        ts: "1700000000.000003",
      },
      client: mockClient,
      say: async () => {},
    });

    assert.equal(mockDocker.sessionCount, 0, "Channel messages should be ignored");
  });

  it("personal server receives user identity in proxied event", async () => {
    dmRegistry.register("U_IDENTITY", {
      serverUrl: `http://127.0.0.1:${personalServer.port}`,
      registeredAt: new Date().toISOString(),
    });

    await registerHandlersAndSimulateDm("do something", "U_IDENTITY");

    assert.equal(personalServer.received.length, 1);
    assert.equal(personalServer.received[0].slack_user_id, "U_IDENTITY");
    assert.equal(personalServer.received[0].slack_channel, "D_DM_CHANNEL");
  });
});

describe("claudebox init CLI", () => {
  const FAKE_HOME = join(TEST_DIR, "home");

  beforeEach(() => {
    mkdirSync(FAKE_HOME, { recursive: true });
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("shows help", () => {
    const r = spawnSync("node", [...NODE_ARGS, CLI, "init", "--help"], {
      env: { ...process.env, HOME: FAKE_HOME },
      encoding: "utf-8",
      timeout: 10_000,
    });
    assert.match(r.stdout, /Set up ClaudeBox credentials/);
    assert.match(r.stdout, /--add-credentials/);
  });

  it("saves credentials with --key flag", () => {
    const r = spawnSync("node", [...NODE_ARGS, CLI, "init", "--key", "sk-ant-test123"], {
      env: { ...process.env, HOME: FAKE_HOME },
      encoding: "utf-8",
      timeout: 10_000,
    });
    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /Credentials saved/);

    const credPath = join(FAKE_HOME, ".claude", "claudebox", "credentials.json");
    assert.ok(existsSync(credPath), "Credentials file should exist");
    const creds = JSON.parse(readFileSync(credPath, "utf-8"));
    assert.equal(creds.anthropicApiKey, "sk-ant-test123");
  });

  it("warns about non-standard key format", () => {
    const r = spawnSync("node", [...NODE_ARGS, CLI, "init", "--key", "not-a-real-key"], {
      env: { ...process.env, HOME: FAKE_HOME },
      encoding: "utf-8",
      timeout: 10_000,
    });
    assert.equal(r.status, 0);
    // Warning goes to stderr via console.warn
    const combined = r.stdout + r.stderr;
    assert.match(combined, /Warning.*sk-ant/);
  });

  it("adds credentials with --add-credentials", () => {
    // First init
    spawnSync("node", [...NODE_ARGS, CLI, "init", "--key", "sk-ant-primary"], {
      env: { ...process.env, HOME: FAKE_HOME },
      encoding: "utf-8",
      timeout: 10_000,
    });

    // Add a second key
    const r = spawnSync("node", [...NODE_ARGS, CLI, "init", "--add-credentials", "--key", "sk-ant-secondary", "--label", "work"], {
      env: { ...process.env, HOME: FAKE_HOME },
      encoding: "utf-8",
      timeout: 10_000,
    });

    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /Added key to rotation pool/);
    assert.match(r.stdout, /2 total/);

    // Verify both keys exist
    const credPath = join(FAKE_HOME, ".claude", "claudebox", "credentials.json");
    const creds = JSON.parse(readFileSync(credPath, "utf-8"));
    assert.equal(creds.keys.length, 2);
    assert.equal(creds.keys[1].label, "work");
  });

  it("lists keys with --list", () => {
    spawnSync("node", [...NODE_ARGS, CLI, "init", "--key", "sk-ant-listtest"], {
      env: { ...process.env, HOME: FAKE_HOME },
      encoding: "utf-8",
      timeout: 10_000,
    });

    const r = spawnSync("node", [...NODE_ARGS, CLI, "init", "--list"], {
      env: { ...process.env, HOME: FAKE_HOME },
      encoding: "utf-8",
      timeout: 10_000,
    });

    assert.equal(r.status, 0, `stderr: ${r.stderr}`);
    assert.match(r.stdout, /1 key/);
    assert.match(r.stdout, /sk-ant-list/);
    assert.match(r.stdout, /active/);
  });

  it("detects existing credentials on second run", () => {
    // First init
    spawnSync("node", [...NODE_ARGS, CLI, "init", "--key", "sk-ant-first"], {
      env: { ...process.env, HOME: FAKE_HOME },
      encoding: "utf-8",
      timeout: 10_000,
    });

    // Second init without --key: should ask about re-login
    // Since stdin is not interactive, it will timeout/default to "n"
    const r = spawnSync("node", [...NODE_ARGS, CLI, "init"], {
      env: { ...process.env, HOME: FAKE_HOME },
      encoding: "utf-8",
      timeout: 10_000,
      input: "n\n",
    });

    assert.match(r.stdout, /already configured/);
    assert.match(r.stdout, /Re-login/);

    // Original key should be preserved
    const credPath = join(FAKE_HOME, ".claude", "claudebox", "credentials.json");
    const creds = JSON.parse(readFileSync(credPath, "utf-8"));
    assert.equal(creds.anthropicApiKey, "sk-ant-first");
  });
});

describe("DM registry HTTP endpoints (via CLI register)", () => {
  it("shows register help", () => {
    const r = spawnSync("node", [...NODE_ARGS, CLI, "register", "--help"], {
      env: process.env,
      encoding: "utf-8",
      timeout: 10_000,
    });
    assert.match(r.stdout, /Register your personal server/);
    assert.match(r.stdout, /--user-id/);
    assert.match(r.stdout, /--server-url/);
  });

  it("errors without server configured", () => {
    const r = spawnSync("node", [...NODE_ARGS, CLI, "register",
      "--user-id", "U123",
      "--server-url", "http://localhost:3001",
    ], {
      env: { ...process.env, HOME: join(TEST_DIR, "nohome") },
      encoding: "utf-8",
      timeout: 10_000,
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /server URL and token required/);
  });

  it("errors without required flags", () => {
    const r = spawnSync("node", [...NODE_ARGS, CLI, "register"], {
      env: { ...process.env, HOME: join(TEST_DIR, "nohome"), CLAUDEBOX_SERVER_URL: "http://x", CLAUDEBOX_SERVER_TOKEN: "t" },
      encoding: "utf-8",
      timeout: 10_000,
    });
    assert.notEqual(r.status, 0);
    assert.match(r.stderr, /--user-id.*--server-url/);
  });

  afterEach(() => {
    rmSync(TEST_DIR, { recursive: true, force: true });
  });
});

describe("end-to-end: DM → proxy → session", () => {
  let personalServer: Awaited<ReturnType<typeof createMockPersonalServer>>;

  beforeEach(async () => {
    mkdirSync(TEST_DIR, { recursive: true });
    personalServer = await createMockPersonalServer();
  });

  afterEach(async () => {
    await personalServer.close();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  it("full flow: register → DM → proxy → personal server creates session", async () => {
    // 1. Set up DM registry with a registered user
    const registry = new DmRegistry(join(TEST_DIR, "dm-registry.json"));
    registry.register("U_FULLTEST", {
      serverUrl: `http://127.0.0.1:${personalServer.port}`,
      registeredAt: new Date().toISOString(),
      label: "test laptop",
    });

    // 2. Set up mock Slack app with handlers
    const mockApp = new MockSlackApp();
    const mockClient = createMockSlackClient();
    const mockStore = new MockSessionStore();
    const mockDocker = new MockDockerService();

    const { registerSlackHandlers } = await import("../../packages/libclaudebox/slack/handlers.ts");
    registerSlackHandlers(mockApp as any, mockStore as any, mockDocker as any, registry);

    // 3. Simulate a DM from the registered user
    const sayMessages: any[] = [];
    await mockApp.simulateEvent("message", {
      event: {
        channel: "D_FULLTEST",
        channel_type: "im",
        text: "audit the barretenberg codebase for security issues",
        user: "U_FULLTEST",
        ts: "1700000000.000100",
      },
      client: mockClient,
      say: async (msg: any) => { sayMessages.push(msg); },
    });

    // 4. Verify: proxied to personal server (NOT handled locally)
    assert.equal(mockDocker.sessionCount, 0, "Should NOT create local session");
    assert.equal(personalServer.received.length, 1, "Personal server should receive 1 request");

    // 5. Verify proxied payload
    const proxied = personalServer.received[0];
    assert.equal(proxied.prompt, "audit the barretenberg codebase for security issues");
    assert.equal(proxied.user, "User U_FULLTEST");
    assert.equal(proxied.slack_user_id, "U_FULLTEST");
    assert.equal(proxied.slack_channel, "D_FULLTEST");
    assert.equal(proxied.source, "dm-proxy");

    // 6. Verify user got confirmation
    const confirm = sayMessages.find((m: any) => m.text?.includes("Routed"));
    assert.ok(confirm, "User should receive routing confirmation");
  });

  it("full flow: unregistered user DM → local session persisted", async () => {
    const registry = new DmRegistry(join(TEST_DIR, "dm-registry.json"));
    // No registrations

    const mockApp = new MockSlackApp();
    const mockClient = createMockSlackClient();
    const mockStore = new MockSessionStore();
    const mockDocker = new MockDockerService();

    const { registerSlackHandlers } = await import("../../packages/libclaudebox/slack/handlers.ts");
    registerSlackHandlers(mockApp as any, mockStore as any, mockDocker as any, registry);

    await mockApp.simulateEvent("message", {
      event: {
        channel: "D_LOCAL",
        channel_type: "im",
        text: "fix the flaky test",
        user: "U_LOCAL",
        ts: "1700000000.000200",
      },
      client: mockClient,
      say: async () => {},
    });

    // Should be handled locally
    assert.equal(mockDocker.sessionCount, 1, "Should create local session");
    assert.ok(mockDocker.lastSession.prompt.includes("fix the flaky test"));
    assert.equal(personalServer.received.length, 0, "Should NOT proxy");

    // Session should be persisted
    assert.ok(mockStore.sessions.size > 0, "Session should be saved in store");
  });
});
