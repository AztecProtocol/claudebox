/**
 * libcreds end-to-end tests.
 *
 * Each test exercises the full stack: createCreds → client → policy → audit.
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
  // Save env, clean up between tests
  const savedEnv: Record<string, string | undefined> = {};
  const ENV_KEYS = [
    "CLAUDEBOX_SERVER_URL", "CLAUDEBOX_SERVER_TOKEN", "MCP_PORT",
    "CLAUDEBOX_PROFILE", "GH_TOKEN", "SLACK_BOT_TOKEN", "LINEAR_API_KEY",
  ];

  before(() => {
    mkdirSync(TEST_DIR, { recursive: true });
    for (const k of ENV_KEYS) savedEnv[k] = process.env[k];
    // Ensure host mode for most tests
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

  it("default profile: allowed GitHub read passes policy, denied write is blocked, both audited", async () => {
    const creds = createCreds({
      profile: "default",
      tokens: { github: "ghp_fake" },
      auditLogPath: AUDIT_LOG,
    });

    // Allowed: read issues on aztec-packages (will fail at GitHub API, not at policy)
    const readErr = await creds.github.getIssue("AztecProtocol/aztec-packages", 1)
      .catch((e: Error) => e);
    assert.ok(readErr instanceof Error);
    // Policy passed — error is from GitHub API (401/network), not "not in allowed list"
    assert.ok(!readErr.message.includes("not in allowed list"));
    assert.ok(!readErr.message.includes("Denied"));

    // Denied: force-push is destructive but granted for default; try a repo NOT in the list
    const denyErr = await creds.github.getIssue("AztecProtocol/secret-repo", 1)
      .catch((e: Error) => e);
    assert.ok(denyErr instanceof Error);
    assert.ok(denyErr.message.includes("not in allowed list"));

    // Audit log has both entries
    const entries = auditEntries();
    const allowed = entries.filter(e => e.allowed === true);
    const denied = entries.filter(e => e.allowed === false);
    assert.ok(allowed.length >= 1, "should have at least 1 allowed entry");
    assert.ok(denied.length >= 1, "should have at least 1 denied entry");
    // No entry contains token strings
    const raw = readFileSync(AUDIT_LOG, "utf-8");
    assert.ok(!raw.includes("ghp_fake"));
  });

  // ────────────────────────────────────────────────────────────────

  it("barretenberg-audit profile: read-only repo blocks writes but allows reads", async () => {
    const creds = createCreds({
      profile: "barretenberg-audit",
      tokens: { github: "ghp_fake" },
      auditLogPath: AUDIT_LOG,
    });

    // aztec-packages is in readOnlyRepos — reads pass policy
    const readErr = await creds.github.listIssues("AztecProtocol/aztec-packages")
      .catch((e: Error) => e);
    assert.ok(!readErr.message.includes("read-only"), "read should pass policy");

    // But writes are blocked on read-only repos
    const writeErr = await creds.github.createIssue("AztecProtocol/aztec-packages", { title: "x" })
      .catch((e: Error) => e);
    assert.ok(writeErr.message.includes("read-only"), "write to read-only repo should be blocked");

    // Writes to the actual audit repo pass policy
    const auditWriteErr = await creds.github.createIssue("AztecProtocol/barretenberg-claude", { title: "x" })
      .catch((e: Error) => e);
    assert.ok(!auditWriteErr.message.includes("Denied"), "write to audit repo should pass policy");
  });

  // ────────────────────────────────────────────────────────────────

  it("slack channel scoping: session channel allowed, other channels blocked, non-scoped ops pass", async () => {
    const creds = createCreds({
      profile: "default",
      tokens: { slack: "xoxb-fake" },
      ctx: { slackChannel: "C_SESSION", slackThreadTs: "111.222", slackMessageTs: "111.333" },
      auditLogPath: AUDIT_LOG,
    });

    // Post to session channel — passes policy (Slack API returns error JSON, not a throw)
    const okResult = await creds.slack.postMessage("hi", { channel: "C_SESSION" })
      .catch((e: Error) => e);
    // If it threw, the error should NOT be about scoping
    if (okResult instanceof Error) {
      assert.ok(!okResult.message.includes("not in session scope"));
    }
    // If it returned, the Slack API responded (policy passed)

    // Post to random channel — blocked by policy
    const denyErr = await creds.slack.postMessage("hi", { channel: "C_RANDOM" })
      .catch((e: Error) => e);
    assert.ok(denyErr.message.includes("not in session scope"));

    // Reactions also channel-scoped
    const reactErr = await creds.slack.addReaction("thumbsup", { channel: "C_RANDOM", timestamp: "1.2" })
      .catch((e: Error) => e);
    assert.ok(reactErr instanceof Error && reactErr.message.includes("not in session scope"));

    // users:list is NOT channel-scoped — passes policy (may fail at API)
    const listResult = await creds.slack.listUsers().catch((e: Error) => e);
    if (listResult instanceof Error) {
      assert.ok(!listResult.message.includes("scope"));
    }
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
      // Slack should report hasToken=true via proxy even without direct token
      assert.equal(creds.slack.hasToken, true);
      // GitHub/Linear don't proxy
      assert.equal(creds.github.hasToken, false);
      assert.equal(creds.linear.hasToken, false);
    } finally {
      delete process.env.CLAUDEBOX_SERVER_URL;
      delete process.env.CLAUDEBOX_SERVER_TOKEN;
      delete process.env.MCP_PORT;
    }

    // Host mode when env cleared
    const hostCreds = createCreds({ profile: "test", auditLogPath: AUDIT_LOG });
    assert.equal(hostCreds.ctx.runtime, "host");
  });

  // ────────────────────────────────────────────────────────────────

  it("minimal profile falls back correctly and unknown profiles get minimal grants", async () => {
    // Explicit minimal
    const minimal = createCreds({
      profile: "minimal",
      tokens: { github: "ghp_fake" },
      auditLogPath: AUDIT_LOG,
    });
    assert.deepStrictEqual(minimal.grant.github?.repos, []);
    assert.equal(minimal.grant.linear, undefined);

    // Any repo is blocked (empty repos list)
    const err = await minimal.github.getIssue("AztecProtocol/aztec-packages", 1)
      .catch((e: Error) => e);
    assert.ok(err.message.includes("not in allowed list"));

    // Unknown profile gets same treatment
    const unknown = createCreds({
      profile: "completely-unknown-profile-xyz",
      tokens: { github: "ghp_fake" },
      auditLogPath: AUDIT_LOG,
    });
    assert.deepStrictEqual(unknown.grant.github?.repos, []);
    assert.equal(unknown.grant.linear, undefined);
  });

  // ────────────────────────────────────────────────────────────────

  it("createHostCreds: broad permissions, _host profile, session context passthrough", async () => {
    const creds = createHostCreds({ slackChannel: "C_OPS", slackThreadTs: "999.000" });

    assert.equal(creds.ctx.profile, "_host");
    assert.equal(creds.ctx.runtime, "host");
    assert.equal(creds.ctx.slackChannel, "C_OPS");
    assert.equal(creds.ctx.slackThreadTs, "999.000");

    // Host grant covers multiple repos — verify aztec-packages AND claudebox
    assert.ok(creds.grant.github?.repos.includes("AztecProtocol/aztec-packages"));
    assert.ok(creds.grant.github?.repos.includes("AztecProtocol/claudebox"));

    // Host slack grant includes conversations:info (not in session grants)
    assert.ok(creds.grant.slack?.operations.includes("slack:conversations:info"));
  });

  // ────────────────────────────────────────────────────────────────

  it("handleCredsEndpoint: dispatches valid ops, rejects invalid ones, scopes by session", async () => {
    // Missing op
    assert.equal((await handleCredsEndpoint({ op: "", args: {} })).ok, false);

    // Unknown service
    const r1 = await handleCredsEndpoint({ op: "redis:get", args: {} });
    assert.ok(r1.error?.includes("unknown service"));

    // Unknown slack method
    const r2 = await handleCredsEndpoint({ op: "slack:admin:nuke", args: {} });
    assert.ok(r2.error?.includes("unknown slack op"));

    // Unknown github method
    const r3 = await handleCredsEndpoint({ op: "github:admin:delete", args: {} });
    assert.ok(r3.error?.includes("unknown github op"));

    // Valid slack op dispatches (fails at API layer, not at dispatch)
    const r4 = await handleCredsEndpoint({
      op: "slack:chat:postMessage",
      args: { text: "hi", channel: "C_TEST" },
      session: { slack_channel: "C_TEST" },
    });
    assert.equal(r4.ok, false);
    assert.ok(!r4.error?.includes("unknown"), "should fail at API, not dispatch");

    // Valid github op dispatches
    const r5 = await handleCredsEndpoint({
      op: "github:issues:read",
      args: { repo: "AztecProtocol/aztec-packages", issue_number: 1 },
    });
    assert.equal(r5.ok, false);
    assert.ok(!r5.error?.includes("unknown"), "should fail at API, not dispatch");
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
