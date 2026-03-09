#!/usr/bin/env -S node --experimental-strip-types --no-warnings
/**
 * ClaudeBox Dev Profile Sidecar
 *
 * For working on ClaudeBox infrastructure itself.
 * Repo: AztecProtocol/claudebox (private)
 * Clone strategy: authenticated URL (no local reference — separate repo)
 * Key differences from default:
 *   - .claude/ files are never blocked
 *   - push_branch tool for direct pushes to main
 *   - create_pr defaults base to main
 */

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { SESSION_META } from "../../packages/libclaudebox/mcp/env.ts";
import { logActivity } from "../../packages/libclaudebox/mcp/activity.ts";
import { getCreds, git, sanitizeError } from "../../packages/libclaudebox/mcp/helpers.ts";
import { registerCommonTools } from "../../packages/libclaudebox/mcp/tools.ts";
import { pushToRemote, registerCloneRepo, registerPRTools, registerGitProxy } from "../../packages/libclaudebox/mcp/git-tools.ts";
import { startMcpHttpServer } from "../../packages/libclaudebox/mcp/server.ts";

// ── Profile config ──────────────────────────────────────────────
const REPO = "AztecProtocol/claudebox";
const WORKSPACE = "/workspace/claudebox";
const DEV_BRANCH = "main";

SESSION_META.repo = REPO;

const TOOL_LIST = "clone_repo, respond_to_user, get_context, session_status, github_api, create_pr, update_pr, push_branch, create_gist, ci_failures, linear_get_issue, linear_create_issue, record_stat, git_fetch, git_pull, submodule_update";

// ── MCP Server factory ──────────────────────────────────────────

function createServer(): McpServer {
  const server = new McpServer({ name: "claudebox-dev", version: "1.0.0" });

  registerCommonTools(server, { repo: REPO, workspace: WORKSPACE, tools: TOOL_LIST });

  registerCloneRepo(server, {
    repo: REPO, workspace: WORKSPACE,
    strategy: "authenticated-url",
    refHint: `'origin/${DEV_BRANCH}', 'abc123'`,
  });

  registerPRTools(server, {
    repo: REPO, workspace: WORKSPACE,
    branchPrefix: "claudebox/", defaultBase: DEV_BRANCH,
    blockedBases: /^(master)$/,
    blockGithubFiles: false,
    label: "claudebox",
    createDescription: `Push workspace commits and create a draft PR. Base branch defaults to '${DEV_BRANCH}'.`,
    updateDescription: "Push workspace commits and/or update an existing PR.",
  });

  // ── push_branch — direct push to dev branch ───────────────────
  server.tool("push_branch",
    `Push current commits directly to a branch (defaults to '${DEV_BRANCH}'). No PR created.`,
    {
      branch: z.string().optional().describe(`Target branch (default: '${DEV_BRANCH}')`),
      force_push: z.boolean().optional().describe("Force-push"),
    },
    async ({ branch, force_push }) => {
      if (!getCreds().github.hasToken)
        return { content: [{ type: "text", text: "No GitHub credentials available" }], isError: true };
      const targetBranch = branch || DEV_BRANCH;
      if (!/^[\w./-]+$/.test(targetBranch))
        return { content: [{ type: "text", text: `Invalid branch name: ${targetBranch}` }], isError: true };
      if (/^(master)$/.test(targetBranch))
        return { content: [{ type: "text", text: `Blocked: never push directly to '${targetBranch}'. Use create_pr instead.` }], isError: true };

      try {
        try {
          git(WORKSPACE, "add", "-A");
          git(WORKSPACE, "diff", "--cached", "--quiet");
        } catch {
          git(WORKSPACE, "commit", "-m", `claudebox-dev: update`);
        }

        await pushToRemote(WORKSPACE, REPO, targetBranch, force_push);
        logActivity("push", `Pushed to ${targetBranch}`);
        return { content: [{ type: "text", text: `Pushed to ${targetBranch}\nhttps://github.com/${REPO}/tree/${targetBranch}` }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: `push_branch: ${sanitizeError(e.message)}` }], isError: true };
      }
    });

  registerGitProxy(server, { workspace: WORKSPACE });

  return server;
}

// ── Start server ────────────────────────────────────────────────

startMcpHttpServer(createServer);
