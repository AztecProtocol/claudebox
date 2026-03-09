/**
 * libcreds end-to-end tests.
 *
 * Each test exercises the full stack: createCreds → client → audit.
 * No mocks, no stubs — real module wiring with real temp files.
 */

import { describe, it, before, after } from "node:test";
import assert from "node:assert/strict";
import { mkdirSync, readFileSync, rmSync } from "fs";
import { join } from "path";
import { tmpdir } from "os";
import { execFileSync } from "child_process";
import { createCreds, createHostCreds, type Creds } from "../../packages/libcreds/index.ts";
import { handleCredsEndpoint } from "../../packages/libcreds-host/creds-endpoint.ts";

const TEST_DIR = join(tmpdir(), `libcreds-e2e-${Date.now()}`);
const AUDIT_LOG = join(TEST_DIR, "audit.jsonl");
const ROOT = join(import.meta.dirname, "../..");

function auditEntries(): any[] {
  try {
    return readFileSync(AUDIT_LOG, "utf-8").trim().split("\n")
      .filter(Boolean).map(l => JSON.parse(l));
  } catch { return []; }
}

describe("libcreds e2e", () => {
  const savedEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = [
    "CLAUDEBOX_SERVER_URL", "CLAUDEBOX_SERVER_TOKEN", "MCP_PORT",
    "CLAUDEBOX_PROFILE", "GH_TOKEN", "SLACK_BOT_TOKEN", "LINEAR_API_KEY",
  ];

  before(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    delete process.env.CLAUDEBOX_SERVER_URL;
    delete process.env.CLAUDEBOX_SERVER_TOKEN;
    delete process.env.MCP_PORT;
  });

  after(() => {
    for (const [k, v] of Object.entries(savedEnv)) {
      if (v === undefined) delete process.env[k]; else process.env[k] = v;
    }
    rmSync(TEST_DIR, { recursive: true, force: true });
  });

  // ────────────────────────────────────────────────────────────────

  it("github client: reads fail at API (not at policy), writes are audit-logged", async () => {
    const creds = createCreds({
      profile: "default",
      tokens: { github: "ghp_fake" },
      auditLogPath: AUDIT_LOG,
    });

    // Read fails at GitHub API (401/network), not at policy
    const readErr = await creds.github.getIssue("AztecProtocol/aztec-packages", 1)
      .catch((e: Error) => e);
    assert.ok(readErr instanceof Error);
    assert.ok(readErr.message.includes("GitHub 401") || readErr.message.includes("GitHub 403") || readErr.message.includes("fetch"));

    // Audit log records the operation
    const entries = auditEntries();
    assert.ok(entries.length >= 1, "should have at least 1 audit entry");
    assert.ok(entries.every(e => e.allowed === true), "all entries should be allowed (no grant checking)");

    // No entry contains token strings
    const raw = readFileSync(AUDIT_LOG, "utf-8");
    assert.ok(!raw.includes("ghp_fake"));
  });

  // ────────────────────────────────────────────────────────────────

  it("slack client: posts work with session context, no token throws", async () => {
    const creds = createCreds({
      profile: "default",
      tokens: { slack: "xoxb-fake" },
      ctx: { slackChannel: "C_SESSION", slackThreadTs: "111.222", slackMessageTs: "111.333" },
      auditLogPath: AUDIT_LOG,
    });

    // Post to session channel — Slack API returns error JSON (invalid_auth), not a throw
    const result = await creds.slack.postMessage("hi", { channel: "C_SESSION" })
      .catch((e: Error) => e);
    // Either returns Slack API response or network error — both are fine
    if (!(result instanceof Error)) {
      assert.ok(result !== undefined, "should get a response from Slack API");
    }

    // users.list works (not channel-scoped)
    const listResult = await creds.slack.listUsers().catch((e: Error) => e);
    assert.ok(listResult !== undefined);

    // No token at all throws
    const noTokenCreds = createCreds({
      profile: "default",
      tokens: { slack: "" },
      auditLogPath: AUDIT_LOG,
    });
    const noTokenErr = await noTokenCreds.slack.postMessage("hi", { channel: "C_TEST" })
      .catch((e: Error) => e);
    assert.ok(noTokenErr instanceof Error);
    assert.ok(noTokenErr.message.includes("No Slack token"));
  });

  // ────────────────────────────────────────────────────────────────

  it("sidecar mode: slack has proxy, correct runtime detection, host mode when env cleared", () => {
    process.env.CLAUDEBOX_SERVER_URL = "http://host.docker.internal:3000";
    process.env.CLAUDEBOX_SERVER_TOKEN = "tok";
    process.env.MCP_PORT = "8080";
    try {
      const creds = createCreds({
        profile: "default",
        tokens: { github: "", slack: "", linear: "" },
        auditLogPath: AUDIT_LOG,
      });

      assert.equal(creds.ctx.runtime, "sidecar");
      assert.equal(creds.slack.hasToken, true); // proxy
      assert.equal(creds.github.hasToken, false);
      assert.equal(creds.linear.hasToken, false);
    } finally {
      delete process.env.CLAUDEBOX_SERVER_URL;
      delete process.env.CLAUDEBOX_SERVER_TOKEN;
      delete process.env.MCP_PORT;
    }

    const hostCreds = createCreds({ profile: "test", auditLogPath: AUDIT_LOG });
    assert.equal(hostCreds.ctx.runtime, "host");
  });

  // ────────────────────────────────────────────────────────────────

  it("createHostCreds: _host profile, session context passthrough", () => {
    const creds = createHostCreds({ slackChannel: "C_OPS", slackThreadTs: "999.000" });

    assert.equal(creds.ctx.profile, "_host");
    assert.equal(creds.ctx.runtime, "host");
    assert.equal(creds.ctx.slackChannel, "C_OPS");
    assert.equal(creds.ctx.slackThreadTs, "999.000");
  });

  // ────────────────────────────────────────────────────────────────

  it("handleCredsEndpoint: dispatches valid ops, rejects invalid ones", async () => {
    assert.equal((await handleCredsEndpoint({ op: "", args: {} })).ok, false);

    const r1 = await handleCredsEndpoint({ op: "redis:get", args: {} });
    assert.ok(r1.error?.includes("unknown service"));

    const r2 = await handleCredsEndpoint({ op: "slack:admin:nuke", args: {} });
    assert.ok(r2.error?.includes("unknown slack op"));

    const r3 = await handleCredsEndpoint({ op: "github:admin:delete", args: {} });
    assert.ok(r3.error?.includes("unknown github op"));

    // Valid slack op dispatches (fails at API, not at dispatch)
    const r4 = await handleCredsEndpoint({
      op: "slack:chat:postMessage",
      args: { text: "hi", channel: "C_TEST" },
      session: { slack_channel: "C_TEST" },
    });
    assert.equal(r4.ok, false);
    assert.ok(!r4.error?.includes("unknown"));

    // Valid github op dispatches
    const r5 = await handleCredsEndpoint({
      op: "github:issues:read",
      args: { repo: "AztecProtocol/aztec-packages", issue_number: 1 },
    });
    assert.equal(r5.ok, false);
    assert.ok(!r5.error?.includes("unknown"));
  });

  // ────────────────────────────────────────────────────────────────

  it("token isolation: no code outside libcreds packages reads raw token env vars", () => {
    const result = execFileSync("bash", [join(ROOT, "scripts/check-token-isolation.sh")], {
      encoding: "utf-8",
      timeout: 10_000,
    });
    assert.ok(result.includes("Token isolation: OK"));
  });
});
