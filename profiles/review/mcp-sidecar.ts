#!/usr/bin/env -S node --experimental-strip-types --no-warnings
/**
 * ClaudeBox Review Profile Sidecar
 *
 * Repo: AztecProtocol/aztec-packages (public)
 * Clone strategy: local reference repo (/reference-repo/.git)
 */

import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerAztecPackagesTools, REPO } from "../shared/aztec-packages-sidecar.ts";
import { getCreds, sanitizeError } from "../../packages/libclaudebox/mcp/helpers.ts";
import { startMcpHttpServer } from "../../packages/libclaudebox/mcp/server.ts";

function createServer(): McpServer {
  const server = new McpServer({ name: "claudebox-review", version: "1.0.0" });

  registerAztecPackagesTools(server, {
    createPRDescription: "Push workspace commits and create a draft PR with a fix found during review.",
    updatePRDescription: "Push workspace commits and/or update an existing PR. Only works on PRs with the 'claudebox' label.",
  });

  // ── manage_review_labels — swap claude-review → claude-review-complete ──
  server.tool("manage_review_labels",
    `Remove 'claude-review' label and add 'claude-review-complete' on a PR. Call this when your review is finished.`,
    {
      pr_number: z.number().describe("PR number to update labels on"),
    },
    async ({ pr_number }) => {
      const creds = getCreds();
      if (!creds.github.hasToken) {
        return { content: [{ type: "text", text: "No GitHub token available" }], isError: true };
      }
      try {
        // Remove claude-review (ignore 404 if already removed)
        await creds.github.removeLabel(REPO, pr_number, "claude-review").catch(() => {});
        // Add claude-review-complete
        await creds.github.addLabels(REPO, pr_number, ["claude-review-complete"]);
        return { content: [{ type: "text", text: `Labels updated on PR #${pr_number}: removed 'claude-review', added 'claude-review-complete'` }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Failed to update labels: ${sanitizeError(e.message)}` }], isError: true };
      }
    }
  );

  return server;
}

startMcpHttpServer(createServer);
