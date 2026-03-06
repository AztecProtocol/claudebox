import { describe, it, after, before } from "node:test";
import assert from "node:assert/strict";
import * as http from "node:http";

import {
  startAnthropicProxy, addSessionToken, removeSessionToken, getStats,
} from "../../sidecar/anthropic-proxy.ts";

// Use a random high port to avoid conflicts
const TEST_PORT = 19_000 + Math.floor(Math.random() * 1000);
let server: http.Server;

function request(
  path: string,
  opts: { method?: string; headers?: Record<string, string> } = {},
): Promise<{ status: number; body: string }> {
  return new Promise((resolve, reject) => {
    const req = http.request(
      { hostname: "127.0.0.1", port: TEST_PORT, path, method: opts.method || "GET", headers: opts.headers || {} },
      (res) => {
        const chunks: Buffer[] = [];
        res.on("data", (c) => chunks.push(c));
        res.on("end", () => resolve({ status: res.statusCode!, body: Buffer.concat(chunks).toString() }));
      },
    );
    req.on("error", reject);
    req.end();
  });
}

describe("Anthropic Proxy", () => {
  before(() => {
    server = startAnthropicProxy({ port: TEST_PORT, initialTokens: ["test-token-1"] });
  });

  after(() => {
    server.close();
  });

  describe("health endpoint", () => {
    it("returns 200 with stats", async () => {
      const res = await request("/health");
      assert.equal(res.status, 200);
      const data = JSON.parse(res.body);
      assert.equal(data.status, "ok");
      assert.equal(typeof data.requestCount, "number");
      assert.equal(typeof data.activeTokens, "number");
    });
  });

  describe("path allowlist", () => {
    it("blocks non-API paths", async () => {
      const res = await request("/v2/something", {
        method: "POST",
        headers: { "x-api-key": "test-token-1" },
      });
      assert.equal(res.status, 403);
      assert.ok(res.body.includes("not allowed"));
    });

    it("blocks root path", async () => {
      const res = await request("/", {
        method: "POST",
        headers: { "x-api-key": "test-token-1" },
      });
      assert.equal(res.status, 403);
    });
  });

  describe("token validation", () => {
    // Our proxy returns {"error":"Invalid or missing session token"} for rejected auth.
    // Upstream Anthropic returns {"type":"error","error":{"type":"authentication_error",...}}.
    // We distinguish by checking our specific error message.
    const PROXY_AUTH_ERROR = "Invalid or missing session token";

    it("rejects requests without a token", async () => {
      const res = await request("/v1/messages", { method: "POST" });
      assert.equal(res.status, 401);
      assert.ok(res.body.includes(PROXY_AUTH_ERROR));
    });

    it("rejects requests with wrong token", async () => {
      const res = await request("/v1/messages", {
        method: "POST",
        headers: { "x-api-key": "wrong-token" },
      });
      assert.equal(res.status, 401);
      assert.ok(res.body.includes(PROXY_AUTH_ERROR));
    });

    it("rejects requests with wrong Bearer token", async () => {
      const res = await request("/v1/messages", {
        method: "POST",
        headers: { authorization: "Bearer wrong-token" },
      });
      assert.equal(res.status, 401);
      assert.ok(res.body.includes(PROXY_AUTH_ERROR));
    });
  });

  describe("token management", () => {
    it("valid token passes proxy auth (reaches upstream or cred error)", async () => {
      // test-token-1 passes proxy auth. We may get 502 (upstream unreachable
      // or no creds) or an upstream error — but NOT our proxy's 401 message.
      const res = await request("/v1/messages", {
        method: "POST",
        headers: { "x-api-key": "test-token-1", "content-type": "application/json" },
      });
      assert.ok(!res.body.includes("Invalid or missing session token"),
        `should pass proxy auth, got: ${res.body.slice(0, 100)}`);
    });

    it("valid Bearer token passes proxy auth", async () => {
      const res = await request("/v1/messages", {
        method: "POST",
        headers: { authorization: "Bearer test-token-1", "content-type": "application/json" },
      });
      assert.ok(!res.body.includes("Invalid or missing session token"));
    });

    it("getStats reflects token count", () => {
      const before = getStats().activeTokens;
      addSessionToken("counting-token");
      assert.equal(getStats().activeTokens, before + 1);
      removeSessionToken("counting-token");
      assert.equal(getStats().activeTokens, before);
    });
  });

  describe("getStats", () => {
    it("returns request and error counts", () => {
      const stats = getStats();
      assert.ok(stats.requestCount > 0, "should have counted requests from prior tests");
      assert.equal(typeof stats.errorCount, "number");
      assert.equal(typeof stats.bytesProxied, "number");
      assert.ok(stats.activeTokens >= 1);
    });
  });
});
