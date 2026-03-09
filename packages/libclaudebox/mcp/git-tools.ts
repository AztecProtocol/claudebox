/**
 * Clone and PR tool registration for MCP sidecars.
 */

import { execFileSync } from "child_process";
import { existsSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { SESSION_META, CI_ALLOW } from "./env.ts";
import { logActivity, addTrackedPR, updateRootComment } from "./activity.ts";
import { getCreds, git, sanitizeError } from "./helpers.ts";
import { workspaceName } from "./tools.ts";

// ── Shared clone helper ─────────────────────────────────────────

export function cloneRepoCheckoutAndInit(targetDir: string, ref: string, fallbackRef = "origin/next", opts?: { skipSubmodules?: boolean }): { text: string; isError?: boolean } {
  let checkedOutRef = ref;
  try {
    execFileSync("git", ["-C", targetDir, "checkout", "--detach", ref], { timeout: 30_000, stdio: "pipe" });
  } catch {
    try {
      execFileSync("git", ["-C", targetDir, "fetch", "origin", ref], { timeout: 120_000, stdio: "pipe" });
      execFileSync("git", ["-C", targetDir, "checkout", "--detach", "FETCH_HEAD"], { timeout: 30_000, stdio: "pipe" });
    } catch {
      try {
        execFileSync("git", ["-C", targetDir, "checkout", "--detach", fallbackRef], { timeout: 30_000, stdio: "pipe" });
        checkedOutRef = fallbackRef;
      } catch (e: any) {
        return { text: `Checkout failed for both ${ref} and ${fallbackRef}: ${e.message}`, isError: true };
      }
    }
  }
  const head = execFileSync("git", ["-C", targetDir, "rev-parse", "--short", "HEAD"], { encoding: "utf-8", timeout: 5_000 }).trim();
  const refNote = checkedOutRef !== ref ? ` (WARNING: ${ref} not found, fell back to ${checkedOutRef})` : "";

  let submoduleMsg = "";
  if (!opts?.skipSubmodules) {
    try {
      execFileSync("git", ["-C", targetDir, "submodule", "update", "--init", "--recursive"], { timeout: 300_000, stdio: "pipe" });
      submoduleMsg = " Submodules initialized.";
    } catch (e: any) {
      submoduleMsg = ` ERROR: submodule init failed: ${e.message}. Builds may fail — try running: git submodule update --init --recursive`;
    }
  }

  return { text: `${head}${refNote}.${submoduleMsg}` };
}

// ── Staging + push helpers ──────────────────────────────────────

function stageAndCommit(workspace: string, commitMsg: string, opts: {
  blockClaudeFiles?: boolean; includeClaudeFiles?: boolean;
  blockGithubFiles?: boolean;
  resetNoirSubmodule?: boolean;
}): { error?: string; noirReset?: boolean } {
  let noirReset = false;
  if (opts.resetNoirSubmodule) {
    try {
      git(workspace, "checkout", "HEAD", "--", "noir/noir-repo");
      git(workspace, "submodule", "update", "--init", "noir/noir-repo");
      noirReset = true;
    } catch {}
  }

  git(workspace, "add", "-A");
  try {
    git(workspace, "diff", "--cached", "--quiet");
    return {};
  } catch {
    const staged = git(workspace, "diff", "--cached", "--name-only").trim();
    if (opts.blockClaudeFiles && !opts.includeClaudeFiles) {
      const claudeFiles = staged.split("\n").filter(f => f.startsWith(".claude/"));
      if (claudeFiles.length > 0) {
        git(workspace, "reset", "HEAD", "--", ".claude");
        return { error: `Blocked: .claude/ files (${claudeFiles.join(", ")}). Pass include_claude_files=true to include.` };
      }
    }
    if (opts.blockGithubFiles && !CI_ALLOW) {
      const ciFiles = staged.split("\n").filter(f => f.startsWith(".github/"));
      if (ciFiles.length > 0) {
        git(workspace, "reset", "HEAD", "--", ".github");
        return { error: `Blocked: .github/ workflow files. Requires 'ci-allow' prefix.` };
      }
    }
    git(workspace, "commit", "-m", commitMsg);
    return { noirReset };
  }
}

export async function pushToRemote(workspace: string, repo: string, branch: string, forcePush?: boolean): Promise<void> {
  await getCreds().github.pushToRemote(workspace, repo, branch, forcePush);
}

// ── Config interfaces ───────────────────────────────────────────

export interface CloneToolConfig {
  repo: string;
  workspace: string;
  strategy: "local-reference" | "authenticated-url";
  remoteUrl?: string;
  fallbackRef?: string;
  refHint?: string;
  description?: string;
  skipSubmodules?: boolean;
}

export interface PRToolConfig {
  repo: string;
  workspace: string;
  branchPrefix: string;
  defaultBase: string;
  blockedBases?: RegExp;
  blockClaudeFiles?: boolean;
  blockGithubFiles?: boolean;
  checkNoirSubmodule?: boolean;
  label?: string;
  createDescription?: string;
  updateDescription?: string;
}

// ── registerCloneRepo ───────────────────────────────────────────

export function registerCloneRepo(server: McpServer, config: CloneToolConfig): void {
  const desc = config.description ||
    `Clone the repo into ${config.workspace}. Safe to call on resume — fetches new refs. Call FIRST before doing any work.`;
  const refHint = config.refHint || "'origin/next', 'abc123'";

  server.tool("clone_repo", desc,
    { ref: z.string().regex(/^[a-zA-Z0-9._\/@-]+$/).describe(`Branch, tag, or commit hash to check out (e.g. ${refHint})`) },
    async ({ ref }) => {
      if (ref.startsWith("-")) return { content: [{ type: "text", text: "Invalid ref: must not start with -" }], isError: true };
      const targetDir = config.workspace;

      if (existsSync(join(targetDir, ".git"))) {
        try {
          try {
            execFileSync("git", ["-C", targetDir, "fetch", "origin"], { timeout: 120_000, stdio: "pipe" });
          } catch {}

          const result = cloneRepoCheckoutAndInit(targetDir, ref, config.fallbackRef, { skipSubmodules: config.skipSubmodules });
          if (result.isError) return { content: [{ type: "text", text: result.text }], isError: true };
          return { content: [{ type: "text", text: `Repo already cloned. Checked out ${ref} (${result.text}) Work in ${targetDir}.` }] };
        } catch (e: any) {
          return { content: [{ type: "text", text: `Repo exists but operation failed: ${sanitizeError(e.message)}` }], isError: true };
        }
      }

      try {
        if (config.strategy === "local-reference") {
          const refGit = "/reference-repo/.git";
          execFileSync("git", ["config", "--global", "--add", "safe.directory", refGit], { timeout: 5_000 });
          execFileSync("git", ["config", "--global", "--add", "safe.directory", targetDir], { timeout: 5_000 });
          execFileSync("git", ["clone", "--shared", refGit, targetDir], { timeout: 120_000, stdio: "pipe" });
          if (config.remoteUrl) {
            execFileSync("git", ["-C", targetDir, "remote", "set-url", "origin", config.remoteUrl], { timeout: 5_000 });
          }
        } else {
          const askpass = join("/tmp", `.git-askpass-${process.pid}`);
          writeFileSync(askpass, `#!/bin/sh\necho "$GIT_PASSWORD"\n`, { mode: 0o700 });
          const cloneUrl = `https://x-access-token@github.com/${config.repo}.git`;
          execFileSync("git", ["config", "--global", "--add", "safe.directory", targetDir], { timeout: 5_000 });
          try {
            execFileSync("git", ["clone", cloneUrl, targetDir], {
              timeout: 300_000, stdio: "pipe",
              env: { ...process.env, GIT_ASKPASS: askpass, GIT_PASSWORD: process.env.GH_TOKEN || "" }, // libcreds-exempt: sync git clone needs raw token
            });
          } finally { try { unlinkSync(askpass); } catch {} }
        }

        const result = cloneRepoCheckoutAndInit(targetDir, ref, config.fallbackRef, { skipSubmodules: config.skipSubmodules });
        if (result.isError) return { content: [{ type: "text", text: `Clone succeeded but: ${result.text}` }], isError: true };
        logActivity("clone", `Cloned ${config.repo} at ${ref} (${result.text})`);
        return { content: [{ type: "text", text: `Cloned ${config.repo} to ${targetDir} at ${ref} (${result.text}) Work in ${targetDir}.` }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Clone failed: ${sanitizeError(e.message)}` }], isError: true };
      }
    });
}

// ── registerPRTools (create_pr + update_pr) ─────────────────────

export function registerPRTools(server: McpServer, config: PRToolConfig): void {
  // ── create_pr ──
  const createSchema: Record<string, any> = {
    title: z.string().describe("PR title"),
    body: z.string().describe("PR description"),
    base: z.string().default(config.defaultBase).describe(`Base branch (default: ${config.defaultBase})`),
    closes: z.array(z.number()).optional().describe("Issue numbers to close"),
    force_push: z.boolean().optional().describe("Force-push to the branch"),
  };
  if (config.blockClaudeFiles) createSchema.include_claude_files = z.boolean().optional().describe("Force-include .claude/ files.");
  if (config.checkNoirSubmodule) createSchema.include_noir_submodule = z.boolean().optional().describe("Include noir/noir-repo submodule changes.");

  server.tool("create_pr",
    config.createDescription || "Push workspace commits and create a draft PR.",
    createSchema,
    async (params: any) => {
      const { title, body, closes, force_push, include_claude_files, include_noir_submodule } = params;
      let base: string = params.base;
      if (/^v\d+/.test(base)) base = `backport-to-${base}-staging`;
      if (!getCreds().github.hasToken) return { content: [{ type: "text", text: "No GitHub access configured" }], isError: true };

      if (base !== SESSION_META.base_branch) {
        try {
          git(config.workspace, "fetch", "origin", base);
          const mergeBase = git(config.workspace, "merge-base", `origin/${base}`, "HEAD").trim();
          const remoteTip = git(config.workspace, "rev-parse", `origin/${base}`).trim();
          if (mergeBase !== remoteTip) {
            return { content: [{ type: "text", text: `Your commits are not based on origin/${base}. Rebase first:\ngit fetch origin ${base} && git rebase --onto origin/${base} origin/${SESSION_META.base_branch || "next"} HEAD` }], isError: true };
          }
        } catch {}
      }

      if (config.blockedBases) {
        if (!/^[\w./-]+$/.test(base)) return { content: [{ type: "text", text: `Invalid base: ${base}` }], isError: true };
        if (config.blockedBases.test(base))
          return { content: [{ type: "text", text: `Blocked: never target '${base}'. Use '${config.defaultBase}' or a version branch.` }], isError: true };
      }

      try {
        const branch = `${config.branchPrefix}${workspaceName || SESSION_META.log_id || Date.now()}`;

        const stage = stageAndCommit(config.workspace, title, {
          blockClaudeFiles: config.blockClaudeFiles, includeClaudeFiles: include_claude_files,
          blockGithubFiles: config.blockGithubFiles,
          resetNoirSubmodule: config.checkNoirSubmodule && !include_noir_submodule,
        });
        if (stage.error) return { content: [{ type: "text", text: stage.error }], isError: true };

        let logOutput: string;
        try { logOutput = git(config.workspace, "log", "--oneline", `origin/${base}..HEAD`); }
        catch { logOutput = git(config.workspace, "log", "--oneline", "-5"); }
        if (!logOutput.trim()) return { content: [{ type: "text", text: "No commits to push" }], isError: true };

        await pushToRemote(config.workspace, config.repo, branch, force_push);

        const creds = getCreds();
        const pr = await creds.github.createPull(config.repo, {
          title, base, draft: true, head: branch,
          body: body
            + (closes?.length ? "\n\n" + closes.map((n: number) => `Closes #${n}`).join("\n") : "")
            + (SESSION_META.log_url ? `\n\nClaudeBox log: ${SESSION_META.log_url}` : ""),
        });

        if (config.label) {
          try { await creds.github.addLabels(config.repo, pr.number, [config.label]); } catch {}
        }

        addTrackedPR(pr.number, title, pr.html_url, "created");
        logActivity("artifact", `- [PR #${pr.number}: ${title}](${pr.html_url})`);
        await updateRootComment();
        return { content: [{ type: "text", text: `${pr.html_url}\nBranch: ${branch}\n#${pr.number}` }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: `create_pr: ${sanitizeError(e.message)}` }], isError: true };
      }
    });

  // ── update_pr ──
  const updateSchema: Record<string, any> = {
    pr_number: z.number().describe("PR number"),
    push: z.boolean().optional().describe("Push current workspace commits to the PR's branch"),
    title: z.string().optional().describe("New title"),
    body: z.string().optional().describe("New body"),
    base: z.string().optional().describe("New base branch"),
    state: z.enum(["open", "closed"]).optional().describe("PR state"),
    force_push: z.boolean().optional(),
  };
  if (config.blockClaudeFiles) updateSchema.include_claude_files = z.boolean().optional();
  if (config.checkNoirSubmodule) updateSchema.include_noir_submodule = z.boolean().optional();

  server.tool("update_pr",
    config.updateDescription || "Push workspace commits and/or update an existing PR.",
    updateSchema,
    async (params: any) => {
      const { pr_number, push, title, body, state, force_push, include_claude_files, include_noir_submodule } = params;
      let base: string | undefined = params.base;
      if (base && /^v\d+/.test(base)) base = `backport-to-${base}-staging`;
      if (!getCreds().github.hasToken) return { content: [{ type: "text", text: "No GitHub access configured" }], isError: true };

      try {
        const creds = getCreds();
        let prData: any;
        try {
          prData = await creds.github.getPull(config.repo, pr_number);
        } catch {
          return { content: [{ type: "text", text: `PR #${pr_number} not found. Verify the number via github_api(method="GET", path="repos/${config.repo}/pulls/${pr_number}").` }], isError: true };
        }

        if (config.label) {
          const labels: string[] = (prData.labels || []).map((l: any) => l.name);
          if (!labels.includes(config.label))
            return { content: [{ type: "text", text: `PR #${pr_number} was not created by ClaudeBox (missing '${config.label}' label). You can only update PRs that were created via create_pr.` }], isError: true };
        }

        const results: string[] = [];

        if (push) {
          const branch = prData.head?.ref;
          if (!branch) return { content: [{ type: "text", text: "Cannot determine PR branch" }], isError: true };

          const stage = stageAndCommit(config.workspace, title || `update PR #${pr_number}`, {
            blockClaudeFiles: config.blockClaudeFiles, includeClaudeFiles: include_claude_files,
            blockGithubFiles: config.blockGithubFiles,
            resetNoirSubmodule: config.checkNoirSubmodule && !include_noir_submodule,
          });
          if (stage.error) return { content: [{ type: "text", text: stage.error }], isError: true };

          await pushToRemote(config.workspace, config.repo, branch, force_push);
          results.push(`${force_push ? "Force-pushed" : "Pushed"} to ${branch}`);
        }

        if (config.blockedBases && base && config.blockedBases.test(base))
          return { content: [{ type: "text", text: `Blocked: never target '${base}'.` }], isError: true };

        const update: any = {};
        if (title) update.title = title;
        if (body) update.body = body;
        if (base) update.base = base;
        if (state) update.state = state;

        if (Object.keys(update).length > 0) {
          await creds.github.updatePull(config.repo, pr_number, update);
          results.push(`Updated PR metadata`);
        }

        if (results.length === 0)
          return { content: [{ type: "text", text: "Nothing to do — specify push=true or fields to update" }], isError: true };

        const prTitle = title || prData.title || `PR #${pr_number}`;
        addTrackedPR(pr_number, prTitle, prData.html_url, "updated");
        logActivity("artifact", `- [PR #${pr_number}: ${prTitle} — updated](${prData.html_url})`);
        await updateRootComment();
        return { content: [{ type: "text", text: `PR #${pr_number}: ${results.join(", ")}\n${prData.html_url}` }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: `update_pr: ${sanitizeError(e.message)}` }], isError: true };
      }
    });
}
