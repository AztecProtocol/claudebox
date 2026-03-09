/**
 * Integration tests for the profile system end-to-end.
 *
 * Tests profile route registration, Express-style path params, auth modes,
 * multi-profile coexistence, channel/branch maps, and requiredCredentials.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";
import { randomBytes } from "node:crypto";

// Set required env vars BEFORE importing modules that read them at import time
const TEST_SECRET = "test-secret-" + randomBytes(8).toString("hex");
process.env.CLAUDEBOX_API_SECRET = TEST_SECRET;
process.env.CLAUDEBOX_SESSION_USER = "testuser";
process.env.CLAUDEBOX_SESSION_PASS = "testpass";
process.env.MAX_CONCURRENT = "5";
process.env.SLACK_BOT_TOKEN = "";

const { ProfileRuntime } = await import("../../packages/libclaudebox/profile.ts");
const { createHttpServer } = await import("../../packages/libclaudebox/http-routes.ts");

import type { Profile, RouteContext } from "../../packages/libclaudebox/profile.ts";

const TEST_PORT = 19_000 + Math.floor(Math.random() * 1000);

// ── Mocks ───────────────────────────────────────────────────────

const mockStore = {
  findByHash: () => undefined,
  findByWorktreeId: () => undefined,
  listByWorktree: () => [],
  listAll: () => [],
  worktreesDir: "/tmp/cb-plugin-test-worktrees",
  isWorktreeAlive: () => false,
  getWorktreeMeta: () => undefined,
} as any;

const mockDocker = {
  runContainerSession: async () => {},
  isRunning: () => false,
} as any;

// ── HTTP helpers ────────────────────────────────────────────────

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
  return { authorization: basicAuth("testuser", "testpass") };
}

function apiAuth(): Record<string, string> {
  return { authorization: `Bearer ${TEST_SECRET}` };
}

// ── Helpers to build inline JSON responses from route handlers ──

function jsonResponse(ctx: RouteContext, status: number, data: unknown): void {
  ctx.res.writeHead(status, { "content-type": "application/json" });
  ctx.res.end(JSON.stringify(data));
}

// ── Tests ───────────────────────────────────────────────────────

describe("Profile Routes", () => {
  let server: http.Server;
  let runtime: InstanceType<typeof ProfileRuntime>;

  // Define test profiles
  const noAuthProfile: Profile = {
    name: "no-auth-profile",
    setup(ctx) {
      ctx.route("GET", "/test-route", async (rc) => {
        jsonResponse(rc, 200, { ok: true, source: "no-auth-profile" });
      }, "none");
    },
  };

  const paramProfile: Profile = {
    name: "param-profile",
    setup(ctx) {
      ctx.route("GET", "/items/:id", async (rc) => {
        jsonResponse(rc, 200, { id: rc.params["0"] });
      }, "basic");
    },
  };

  const apiAuthProfile: Profile = {
    name: "api-auth-profile",
    setup(ctx) {
      ctx.route("POST", "/data", async (rc) => {
        jsonResponse(rc, 200, { accepted: true });
      }, "api");
    },
  };

  const secondProfile: Profile = {
    name: "second-profile",
    setup(ctx) {
      ctx.route("GET", "/second-route", async (rc) => {
        jsonResponse(rc, 200, { source: "second-profile" });
      }, "none");
    },
  };

  before(async () => {
    runtime = new ProfileRuntime(mockDocker, mockStore);
    await runtime.loadProfile(noAuthProfile);
    await runtime.loadProfile(paramProfile);
    await runtime.loadProfile(apiAuthProfile);
    await runtime.loadProfile(secondProfile);

    const servers = createHttpServer(mockStore, mockDocker, runtime);
    server = servers.public;
    server.listen(TEST_PORT);
  });

  after(() => {
    server.close();
  });

  // ── 1. Profile registers a route accessible via HTTP ──

  describe("profile route registration", () => {
    it("GET /test-route returns profile JSON (auth: none)", async () => {
      const res = await request(TEST_PORT, "/test-route");
      assert.equal(res.status, 200);
      const data = JSON.parse(res.body);
      assert.equal(data.ok, true);
      assert.equal(data.source, "no-auth-profile");
    });
  });

  // ── 2. Express-style path parameters ──

  describe("path parameters", () => {
    it("GET /items/:id extracts param correctly", async () => {
      const res = await request(TEST_PORT, "/items/abc-123", { headers: sessionAuth() });
      assert.equal(res.status, 200);
      const data = JSON.parse(res.body);
      assert.equal(data.id, "abc-123");
    });

    it("GET /items/:id with numeric id", async () => {
      const res = await request(TEST_PORT, "/items/42", { headers: sessionAuth() });
      assert.equal(res.status, 200);
      const data = JSON.parse(res.body);
      assert.equal(data.id, "42");
    });

    it("GET /items/:id rejects unauthenticated (auth: basic)", async () => {
      const res = await request(TEST_PORT, "/items/abc-123");
      assert.equal(res.status, 401);
    });
  });

  // ── 3. API auth mode enforcement ──

  describe("API auth enforcement", () => {
    it("POST /data rejects unauthenticated request", async () => {
      const res = await request(TEST_PORT, "/data", {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ value: 1 }),
      });
      assert.equal(res.status, 401);
    });

    it("POST /data rejects wrong bearer token", async () => {
      const res = await request(TEST_PORT, "/data", {
        method: "POST",
        headers: { authorization: "Bearer wrong-token", "content-type": "application/json" },
        body: JSON.stringify({ value: 1 }),
      });
      assert.equal(res.status, 401);
    });

    it("POST /data accepts correct bearer token", async () => {
      const res = await request(TEST_PORT, "/data", {
        method: "POST",
        headers: { ...apiAuth(), "content-type": "application/json" },
        body: JSON.stringify({ value: 1 }),
      });
      assert.equal(res.status, 200);
      const data = JSON.parse(res.body);
      assert.equal(data.accepted, true);
    });
  });

  // ── 4. Multiple profiles register routes ──

  describe("multiple profiles", () => {
    it("first profile route is accessible", async () => {
      const res = await request(TEST_PORT, "/test-route");
      assert.equal(res.status, 200);
      const data = JSON.parse(res.body);
      assert.equal(data.source, "no-auth-profile");
    });

    it("second profile route is accessible", async () => {
      const res = await request(TEST_PORT, "/second-route");
      assert.equal(res.status, 200);
      const data = JSON.parse(res.body);
      assert.equal(data.source, "second-profile");
    });

    it("all four profile routes are registered", () => {
      const registered = runtime.getRoutes();
      assert.equal(registered.length, 4);
    });
  });

  // ── 5. requiredCredentials field ──

  describe("requiredCredentials", () => {
    it("preserves requiredCredentials after loading profile", async () => {
      const credRuntime = new ProfileRuntime(mockDocker, mockStore);

      const prof: Profile = {
        name: "cred-profile",
        requiredCredentials: ["GH_TOKEN", "LINEAR_API_KEY"],
        setup() {},
      };

      await credRuntime.loadProfile(prof);

      const loaded = credRuntime.getProfiles();
      assert.equal(loaded.length, 1);
      assert.deepEqual(loaded[0].requiredCredentials, ["GH_TOKEN", "LINEAR_API_KEY"]);
    });

    it("profile without requiredCredentials has undefined field", async () => {
      const credRuntime = new ProfileRuntime(mockDocker, mockStore);

      const prof: Profile = {
        name: "no-creds",
        setup() {},
      };

      await credRuntime.loadProfile(prof);

      const loaded = credRuntime.getProfiles();
      assert.equal(loaded[0].requiredCredentials, undefined);
    });
  });
});
