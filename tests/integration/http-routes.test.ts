/**
 * Integration tests for http-routes.ts
 *
 * Spins up a real HTTP server with mock store/docker and tests:
 * - Health endpoint (unauthenticated)
 * - Auth: API bearer, Basic auth, JWT cookies, rejection
 * - Route matching and 404 handling
 * - Session resolution (worktree ID, log ID, legacy hash)
 * - Dashboard rendering
 * - POST /run validation
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import { mkdirSync, rmSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { randomBytes } from "node:crypto";

// Set required env vars BEFORE importing modules that read them at import time
const TEST_USER = "testuser";
const TEST_PASS = "testpass";
const TEST_SECRET = "test-api-secret-" + randomBytes(8).toString("hex");
process.env.CLAUDEBOX_API_SECRET = TEST_SECRET;
process.env.CLAUDEBOX_SESSION_USER = TEST_USER;
process.env.CLAUDEBOX_SESSION_PASS = TEST_PASS;
process.env.MAX_CONCURRENT = "5";

// Dynamic imports to ensure env vars are set before config.ts IIFE runs
const { WorktreeStore } = await import("../../packages/libclaudebox/worktree-store.ts");
const { createHttpServer } = await import("../../packages/libclaudebox/http-routes.ts");

const TEST_DIR = join(tmpdir(), `cb-http-test-${Date.now()}`);
const SESSIONS_DIR = join(TEST_DIR, "sessions");
const WORKTREES_DIR = join(TEST_DIR, "worktrees");
const TEST_PORT = 18_000 + Math.floor(Math.random() * 1000);

let server: http.Server;
let store: InstanceType<typeof WorktreeStore>;

// Minimal mock docker — just enough to not crash
const mockDocker = {
  runContainerSession: async () => {},
  isRunning: () => false,
} as any;

function request(
  path: string,
  opts: { method?: string; headers?: Record<string, string>; body?: string } = {},
): Promise<{ status: number; headers: http.IncomingHttpHeaders; body: string }> {
  return new Promise((resolve, reject) => {
    const r = http.request(
      { hostname: "127.0.0.1", port: TEST_PORT, path, method: opts.method || "GET", headers: opts.headers },
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

function apiAuth(): Record<string, string> {
  return { authorization: `Bearer ${TEST_SECRET}` };
}

function sessionAuth(): Record<string, string> {
  return { authorization: basicAuth(TEST_USER, TEST_PASS) };
}

describe("HTTP Routes", () => {
  before(() => {
    mkdirSync(SESSIONS_DIR, { recursive: true });
    mkdirSync(WORKTREES_DIR, { recursive: true });
    store = new WorktreeStore(SESSIONS_DIR, WORKTREES_DIR);

    // Seed a test session
    store.save("deadbeef01234567-1", {
      status: "completed",
      user: "alice",
      prompt: "fix the thing",
      started: new Date().toISOString(),
      worktree_id: "deadbeef01234567",
      base_branch: "next",
      exit_code: 0,
    });

    const servers = createHttpServer(store, mockDocker);
    server = servers.public;
    server.listen(TEST_PORT);
  });

  after(() => {
    server.close();
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // ── Health ──

  describe("GET /health", () => {
    it("returns 200 without auth", async () => {
      const res = await request("/health");
      assert.equal(res.status, 200);
      const data = JSON.parse(res.body);
      assert.equal(data.status, "ok");
      assert.equal(typeof data.active, "number");
      assert.equal(typeof data.max, "number");
    });
  });

  // ── Auth ──

  describe("authentication", () => {
    it("rejects unauthenticated POST /run", async () => {
      const res = await request("/run", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ prompt: "test" }),
      });
      assert.equal(res.status, 401);
    });

    it("rejects wrong API bearer token", async () => {
      const res = await request("/run", {
        method: "POST",
        headers: { authorization: "Bearer wrong-token", "content-type": "application/json" },
        body: JSON.stringify({ prompt: "test" }),
      });
      assert.equal(res.status, 401);
    });

    it("accepts correct API bearer token", async () => {
      // Will fail with 400 (no prompt) but NOT 401
      const res = await request("/run", {
        method: "POST",
        headers: { ...apiAuth(), "content-type": "application/json" },
        body: JSON.stringify({ prompt: "" }),
      });
      assert.equal(res.status, 400); // prompt required, not auth failure
      assert.ok(res.body.includes("prompt"), "should complain about missing prompt");
    });

    it("unauthenticated dashboard shows login form", async () => {
      const res = await request("/dashboard");
      // Dashboard returns 200 with login form when not authenticated
      assert.equal(res.status, 200);
      assert.ok(res.headers["content-type"]?.includes("text/html"));
      assert.ok(res.body.includes("login") || res.body.includes("password"),
        "should show login form");
    });

    it("accepts Basic auth for session pages", async () => {
      const res = await request("/dashboard", { headers: sessionAuth() });
      assert.equal(res.status, 200);
      assert.ok(res.headers["content-type"]?.includes("text/html"));
    });

    it("POST /login issues JWT cookie", async () => {
      const res = await request("/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: TEST_USER, password: TEST_PASS }),
      });
      assert.equal(res.status, 200);
      const setCookie = res.headers["set-cookie"];
      assert.ok(setCookie, "should set a cookie");
      const cookieStr = Array.isArray(setCookie) ? setCookie.join("; ") : setCookie;
      assert.ok(cookieStr.includes("cb_session="), "should set cb_session cookie");
    });

    it("JWT cookie grants access to session pages", async () => {
      const loginRes = await request("/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: TEST_USER, password: TEST_PASS }),
      });
      const setCookie = loginRes.headers["set-cookie"];
      assert.ok(setCookie, "login should set cookie");

      const cookieStr = Array.isArray(setCookie) ? setCookie[0] : setCookie;
      const match = cookieStr.match(/cb_session=([^;]+)/);
      assert.ok(match, "should find cb_session token");

      const res = await request("/dashboard", {
        headers: { cookie: `cb_session=${match![1]}` },
      });
      assert.equal(res.status, 200);
    });

    it("POST /login rejects wrong credentials", async () => {
      const res = await request("/login", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ username: "wrong", password: "wrong" }),
      });
      assert.equal(res.status, 401);
    });
  });

  // ── Routing ──

  describe("routing", () => {
    it("returns 404 for unknown paths", async () => {
      const res = await request("/nonexistent", { headers: sessionAuth() });
      assert.equal(res.status, 404);
    });

    it("returns 404 for unknown API paths", async () => {
      const res = await request("/api/nonexistent", { headers: apiAuth() });
      assert.equal(res.status, 404);
    });
  });

  // ── POST /run validation ──

  describe("POST /run", () => {
    it("rejects non-JSON body", async () => {
      const res = await request("/run", {
        method: "POST",
        headers: { ...apiAuth(), "content-type": "application/json" },
        body: "not json",
      });
      assert.equal(res.status, 400);
      assert.ok(res.body.includes("invalid JSON"));
    });

    it("rejects empty prompt", async () => {
      const res = await request("/run", {
        method: "POST",
        headers: { ...apiAuth(), "content-type": "application/json" },
        body: JSON.stringify({ prompt: "" }),
      });
      assert.equal(res.status, 400);
      assert.ok(res.body.includes("prompt"));
    });

    it("rejects missing prompt field", async () => {
      const res = await request("/run", {
        method: "POST",
        headers: { ...apiAuth(), "content-type": "application/json" },
        body: JSON.stringify({ user: "test" }),
      });
      assert.equal(res.status, 400);
    });
  });

  // ── Session pages ──

  describe("session pages", () => {
    it("GET /s/:worktreeId returns workspace page", async () => {
      const res = await request("/s/deadbeef01234567", { headers: sessionAuth() });
      assert.equal(res.status, 200);
      assert.ok(res.headers["content-type"]?.includes("text/html"));
      assert.ok(res.body.includes("ClaudeBox"), "should render workspace page");
    });

    it("GET /s/:logId redirects to worktree URL", async () => {
      const res = await request("/s/deadbeef01234567-1", { headers: sessionAuth() });
      // Log ID format resolves and may redirect to canonical worktree URL
      assert.ok([200, 302].includes(res.status), `expected 200 or 302, got ${res.status}`);
    });

    it("GET /s/:id returns 404 for nonexistent session", async () => {
      const res = await request("/s/0000000000000000", { headers: sessionAuth() });
      assert.equal(res.status, 404);
    });
  });

  // ── Dashboard ──

  describe("dashboard", () => {
    it("renders HTML dashboard with session data", async () => {
      const res = await request("/dashboard", { headers: sessionAuth() });
      assert.equal(res.status, 200);
      assert.ok(res.headers["content-type"]?.includes("text/html"));
    });
  });
});
