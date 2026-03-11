#!/usr/bin/env -S node --experimental-strip-types --no-warnings
/**
 * ClaudeBox Default Profile Sidecar
 *
 * Repo: AztecProtocol/aztec-packages (public)
 * Clone strategy: local reference repo (/reference-repo/.git)
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerCommonTools } from "../../packages/libclaudebox/mcp/tools.ts";
import { registerCloneRepo, registerPRTools, registerGitProxy, registerLogTools, registerIssueTools } from "../../packages/libclaudebox/mcp/git-tools.ts";
import { registerBuildTools, formatChangedFiles } from "../../packages/libclaudebox/mcp/build-tools.ts";
import { startMcpHttpServer } from "../../packages/libclaudebox/mcp/server.ts";

// ── Profile config ──────────────────────────────────────────────
const REPO = "AztecProtocol/aztec-packages";
const WORKSPACE = process.env.WORKSPACE || "/workspace/aztec-packages";

// ── MCP Server factory ──────────────────────────────────────────

function createServer(): McpServer {
  const server = new McpServer({ name: "claudebox-default", version: "1.0.0" });

  registerCommonTools(server, { repo: REPO, workspace: WORKSPACE });

  registerCloneRepo(server, {
    repo: REPO, workspace: WORKSPACE,
    strategy: "local-reference",
    remoteUrl: "https://github.com/AztecProtocol/aztec-packages.git",
    fallbackRef: "origin/next",
    refHint: "'origin/next' (default branch), 'abc123'",
    description: `Clone the repo into ${WORKSPACE}. MUST be your FIRST tool call — the workspace is empty until you clone. Do NOT run git, ls, Read, or any file operations before calling this. Safe to call on resume — fetches new refs. Default branch is 'next' — use ref='origin/next' unless told otherwise.`,
  });

  const REF_REPO = "/reference-repo";

  registerPRTools(server, {
    repo: REPO, workspace: WORKSPACE,
    branchPrefix: "claudebox/", defaultBase: "next",
    blockedBases: /^(master|main)$/,
    blockClaudeFiles: true, blockGithubFiles: true, checkNoirSubmodule: true,
    label: "claudebox",
    createDescription: "Push workspace commits and create a draft PR. WARNING: .claude/ files are blocked by default — pass include_claude_files=true ONLY if your PR intentionally modifies ClaudeBox infrastructure. .github/ workflow files are also blocked unless the session was started with 'ci-allow'.",
    updateDescription: "Push workspace commits and/or update an existing PR. Only works on PRs with the 'claudebox' label.",
    formatBeforePush: () => formatChangedFiles(WORKSPACE, REF_REPO),
  });

  registerGitProxy(server, { workspace: WORKSPACE });
  registerLogTools(server, { workspace: WORKSPACE });
  registerBuildTools(server, { workspace: WORKSPACE, referenceRepo: REF_REPO });

  registerIssueTools(server, [
    { name: "aztec_packages_create_issue", repo: REPO, description: "Create a GitHub issue in AztecProtocol/aztec-packages." },
    { name: "barretenberg_create_issue", repo: "AztecProtocol/barretenberg", description: "Create a GitHub issue in AztecProtocol/barretenberg." },
  ]);

  return server;
}

// ── Start server ────────────────────────────────────────────────

startMcpHttpServer(createServer);
