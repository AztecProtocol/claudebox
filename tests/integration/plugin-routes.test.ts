/**
 * Integration tests for the plugin system end-to-end.
 *
 * Tests plugin route registration, Express-style path params, auth modes,
 * multi-plugin coexistence, channel/branch maps, and requiredCredentials.
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

const { PluginRuntime } = await import("../../packages/libclaudebox/plugin.ts");
const { createHttpServer } = await import("../../packages/libclaudebox/http-routes.ts");

import type { Plugin, RouteContext } from "../../packages/libclaudebox/plugin.ts";

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

describe("Plugin Routes", () => {
  let server: http.Server;
  let runtime: InstanceType<typeof PluginRuntime>;

  // Define test plugins
  const noAuthPlugin: Plugin = {
    name: "no-auth-plugin",
    setup(ctx) {
      ctx.route("GET", "/test-route", async (rc) => {
        jsonResponse(rc, 200, { ok: true, source: "no-auth-plugin" });
      }, "none");
    },
  };

  const paramPlugin: Plugin = {
    name: "param-plugin",
    setup(ctx) {
      ctx.route("GET", "/items/:id", async (rc) => {
        jsonResponse(rc, 200, { id: rc.params["0"] });
      }, "basic");
    },
  };

  const apiAuthPlugin: Plugin = {
    name: "api-auth-plugin",
    setup(ctx) {
      ctx.route("POST", "/data", async (rc) => {
        jsonResponse(rc, 200, { accepted: true });
      }, "api");
    },
  };

  const secondPlugin: Plugin = {
    name: "second-plugin",
    setup(ctx) {
      ctx.route("GET", "/second-route", async (rc) => {
        jsonResponse(rc, 200, { source: "second-plugin" });
      }, "none");
    },
  };

  before(async () => {
    runtime = new PluginRuntime(mockDocker, mockStore);
    await runtime.loadPlugin(noAuthPlugin);
    await runtime.loadPlugin(paramPlugin);
    await runtime.loadPlugin(apiAuthPlugin);
    await runtime.loadPlugin(secondPlugin);

    server = createHttpServer(mockStore, mockDocker, runtime);
    server.listen(TEST_PORT);
  });

  after(() => {
    server.close();
  });

  // ── 1. Plugin registers a route accessible via HTTP ──

  describe("plugin route registration", () => {
    it("GET /test-route returns plugin JSON (auth: none)", async () => {
      const res = await request(TEST_PORT, "/test-route");
      assert.equal(res.status, 200);
      const data = JSON.parse(res.body);
      assert.equal(data.ok, true);
      assert.equal(data.source, "no-auth-plugin");
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

  // ── 4. Multiple plugins register routes ──

  describe("multiple plugins", () => {
    it("first plugin route is accessible", async () => {
      const res = await request(TEST_PORT, "/test-route");
      assert.equal(res.status, 200);
      const data = JSON.parse(res.body);
      assert.equal(data.source, "no-auth-plugin");
    });

    it("second plugin route is accessible", async () => {
      const res = await request(TEST_PORT, "/second-route");
      assert.equal(res.status, 200);
      const data = JSON.parse(res.body);
      assert.equal(data.source, "second-plugin");
    });

    it("all four plugin routes are registered", () => {
      const registered = runtime.getRoutes();
      assert.equal(registered.length, 4);
    });
  });

  // ── 5. Channel/branch maps ──

  describe("channel and branch maps", () => {
    it("builds channel→profile map from plugins with channels", async () => {
      const mapRuntime = new PluginRuntime(mockDocker, mockStore);

      const pluginA: Plugin = {
        name: "profile-alpha",
        channels: ["C001", "C002"],
        setup() {},
      };
      const pluginB: Plugin = {
        name: "profile-beta",
        channels: ["C003"],
        setup() {},
      };

      await mapRuntime.loadPlugin(pluginA);
      await mapRuntime.loadPlugin(pluginB);

      const channelMap = mapRuntime.buildChannelProfileMap();
      assert.equal(channelMap.get("C001"), "profile-alpha");
      assert.equal(channelMap.get("C002"), "profile-alpha");
      assert.equal(channelMap.get("C003"), "profile-beta");
      assert.equal(channelMap.size, 3);
    });

    it("builds channel→branch map from plugins with branchOverrides", async () => {
      const mapRuntime = new PluginRuntime(mockDocker, mockStore);

      const plugin: Plugin = {
        name: "branching",
        branchOverrides: { "C010": "develop", "C011": "staging" },
        setup() {},
      };

      await mapRuntime.loadPlugin(plugin);

      const branchMap = mapRuntime.buildChannelBranchMap();
      assert.equal(branchMap.get("C010"), "develop");
      assert.equal(branchMap.get("C011"), "staging");
      assert.equal(branchMap.size, 2);
    });

    it("returns empty maps when plugins have no channels/branches", async () => {
      const mapRuntime = new PluginRuntime(mockDocker, mockStore);

      const bare: Plugin = { name: "bare", setup() {} };
      await mapRuntime.loadPlugin(bare);

      assert.equal(mapRuntime.buildChannelProfileMap().size, 0);
      assert.equal(mapRuntime.buildChannelBranchMap().size, 0);
    });
  });

  // ── 6. requiredCredentials field ──

  describe("requiredCredentials", () => {
    it("preserves requiredCredentials after loading", async () => {
      const credRuntime = new PluginRuntime(mockDocker, mockStore);

      const plugin: Plugin = {
        name: "cred-plugin",
        requiredCredentials: ["GH_TOKEN", "LINEAR_API_KEY"],
        setup() {},
      };

      await credRuntime.loadPlugin(plugin);

      const loaded = credRuntime.getPlugins();
      assert.equal(loaded.length, 1);
      assert.deepEqual(loaded[0].requiredCredentials, ["GH_TOKEN", "LINEAR_API_KEY"]);
    });

    it("plugin without requiredCredentials has undefined field", async () => {
      const credRuntime = new PluginRuntime(mockDocker, mockStore);

      const plugin: Plugin = {
        name: "no-creds",
        setup() {},
      };

      await credRuntime.loadPlugin(plugin);

      const loaded = credRuntime.getPlugins();
      assert.equal(loaded[0].requiredCredentials, undefined);
    });
  });
});
