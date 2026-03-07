#!/usr/bin/env -S node --experimental-strip-types --no-warnings
/**
 * ClaudeBox Test Profile Sidecar
 *
 * Registers all base MCP tools with the test repo (ludamad/test-mfh).
 * Tools that need credentials (GitHub, Slack, Linear) log the action
 * and return fake success when tokens are missing.
 *
 * clone_repo does a real git clone from /reference-repo/.git.
 */

import {
  McpServer,
  SESSION_META,
  buildCommonGhWhitelist,
  registerCommonTools, registerCloneRepo, registerPRTools,
  startMcpHttpServer,
} from "../../packages/libclaudebox/mcp/base.ts";

// ── Profile config ──────────────────────────────────────────────
const REPO = process.env.CLAUDEBOX_TEST_REPO || "ludamad/test-mfh";
const WORKSPACE = process.env.WORKSPACE || "/workspace/test-mfh";
const R = `repos/${REPO}`;

SESSION_META.repo = REPO;

const GH_WHITELIST = buildCommonGhWhitelist(R);

const TOOL_LIST = "clone_repo, respond_to_user, get_context, session_status, set_workspace_name, github_api, slack_api, create_pr, update_pr, create_gist, create_skill, ci_failures, linear_get_issue, linear_create_issue, record_stat";

// ── MCP Server factory ──────────────────────────────────────────

function createServer(): McpServer {
  const server = new McpServer({ name: "claudebox-test", version: "1.0.0" });

  registerCommonTools(server, { repo: REPO, workspace: WORKSPACE, tools: TOOL_LIST, ghWhitelist: GH_WHITELIST });

  registerCloneRepo(server, {
    repo: REPO, workspace: WORKSPACE,
    strategy: "local-reference",
    remoteUrl: `https://github.com/${REPO}.git`,
    refHint: "'origin/main', 'abc123'",
  });

  registerPRTools(server, {
    repo: REPO, workspace: WORKSPACE,
    branchPrefix: "claudebox-test/", defaultBase: "main",
    blockedBases: /^$/,  // no blocked bases in test
    blockClaudeFiles: false, blockGithubFiles: false,
    label: "claudebox-test",
  });

  return server;
}

// ── Start server ────────────────────────────────────────────────

startMcpHttpServer(createServer);
