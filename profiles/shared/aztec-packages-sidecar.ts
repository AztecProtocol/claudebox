/**
 * Shared aztec-packages sidecar setup.
 *
 * Registers clone, PR, git proxy, log, build, and issue tools
 * against AztecProtocol/aztec-packages with local reference repo cloning.
 *
 * Profiles import and call `registerAztecPackagesTools(server, opts?)` then
 * add any profile-specific tools on top.
 */

import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { registerCommonTools } from "../../packages/libclaudebox/mcp/tools.ts";
import {
  registerCloneRepo, registerPRTools, registerGitProxy,
  registerLogTools, registerIssueTools,
} from "../../packages/libclaudebox/mcp/git-tools.ts";
import { formatChangedFiles } from "../../packages/libclaudebox/mcp/build-tools.ts";

// ── Defaults ─────────────────────────────────────────────────────
export const REPO = "AztecProtocol/aztec-packages";
export const WORKSPACE = process.env.WORKSPACE || "/workspace/aztec-packages";
export const REF_REPO = "/reference-repo";

export interface AztecPackagesOpts {
  /** Override PR create description. */
  createPRDescription?: string;
  /** Override PR update description. */
  updatePRDescription?: string;
  /** Extra issue tool registrations (added after the default aztec-packages one). */
  extraIssueRepos?: Array<{ name: string; repo: string; description: string }>;
}

export function registerAztecPackagesTools(server: McpServer, opts: AztecPackagesOpts = {}): void {
  registerCommonTools(server, { repo: REPO, workspace: WORKSPACE });

  registerCloneRepo(server, {
    repo: REPO, workspace: WORKSPACE,
    strategy: "local-reference",
    remoteUrl: "https://github.com/AztecProtocol/aztec-packages.git",
    fallbackRef: "origin/next",
    refHint: "'origin/next' (default branch), 'abc123'",
    description: `Clone the repo into ${WORKSPACE}. MUST be your FIRST tool call — the workspace is empty until you clone. Do NOT run git, ls, Read, or any file operations before calling this. Safe to call on resume — fetches new refs. Default branch is 'next' — use ref='origin/next' unless told otherwise.`,
  });

  registerPRTools(server, {
    repo: REPO, workspace: WORKSPACE,
    branchPrefix: "claudebox/", defaultBase: "next",
    blockedBases: /^(master|main)$/,
    blockClaudeFiles: true, blockGithubFiles: true, checkNoirSubmodule: true,
    label: "claudebox",
    createDescription: opts.createPRDescription ??
      "Push workspace commits and create a draft PR. WARNING: .claude/ files are blocked by default — pass include_claude_files=true ONLY if your PR intentionally modifies ClaudeBox infrastructure. .github/ workflow files are also blocked unless the session was started with 'ci-allow'.",
    updateDescription: opts.updatePRDescription ??
      "Push workspace commits and/or update an existing PR. Only works on PRs with the 'claudebox' label.",
    formatBeforePush: () => formatChangedFiles(WORKSPACE, REF_REPO),
  });

  registerGitProxy(server, { workspace: WORKSPACE });
  registerLogTools(server, { workspace: WORKSPACE });

  const issueRepos = [
    { name: "aztec_packages_create_issue", repo: REPO, description: "Create a GitHub issue in AztecProtocol/aztec-packages." },
    ...(opts.extraIssueRepos || []),
  ];
  registerIssueTools(server, issueRepos);
}
