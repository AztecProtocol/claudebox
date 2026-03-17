/**
 * Clone and PR tool registration for MCP sidecars.
 */

import { execFileSync, spawnSync } from "child_process";
import { existsSync, writeFileSync, unlinkSync } from "fs";
import { join } from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { SESSION_META, CI_ALLOW } from "./env.ts";
import { logActivity, addTrackedPR, updateRootComment } from "./activity.ts";
import { getCreds, git, sanitizeError } from "./helpers.ts";
import { workspaceName } from "./tools.ts";

// ── Shared clone helper ─────────────────────────────────────────

export function cloneRepoCheckoutAndInit(targetDir: string, ref: string, fallbackRef = "origin/next", opts?: { initSubmodules?: boolean }): { text: string; isError?: boolean } {
  let checkedOutRef = ref;
  try {
    execFileSync("git", ["-C", targetDir, "checkout", "--detach", ref], { timeout: 30_000, stdio: "pipe" });
  } catch {
    try {
      // Strip origin/ prefix — it's a local tracking name, not a remote refspec
      const fetchRef = ref.replace(/^origin\//, "");
      execFileSync("git", ["-C", targetDir, "fetch", "origin", fetchRef], { timeout: 120_000, stdio: "pipe" });
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
  const refNote = checkedOutRef !== ref ? ` (used ${checkedOutRef} — ${ref} not found)` : "";

  let submoduleMsg = "";
  if (opts?.initSubmodules) {
    try {
      execFileSync("git", ["-C", targetDir, "submodule", "update", "--init", "--recursive"], { timeout: 300_000, stdio: "pipe" });
      submoduleMsg = " Submodules initialized.";
    } catch (e: any) {
      submoduleMsg = ` Warning: submodule init failed: ${e.message}`;
    }
  } else {
    submoduleMsg = " Submodules not initialized — use submodule_update tool if needed.";
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

// ── Issue tool config + registration ─────────────────────────────

export interface IssueToolConfig {
  /** Tool name, e.g. "aztec_packages_create_issue" */
  name: string;
  /** GitHub repo, e.g. "AztecProtocol/aztec-packages" */
  repo: string;
  /** Tool description */
  description?: string;
  /** Default labels to add */
  defaultLabels?: string[];
}

export function registerIssueTools(server: McpServer, configs: IssueToolConfig[]): void {
  for (const config of configs) {
    const desc = config.description || `Create a GitHub issue in ${config.repo}.`;
    server.tool(config.name, desc,
      {
        title: z.string().describe("Issue title"),
        body: z.string().describe("Issue body (Markdown). Use real newlines, not literal \\n."),
        labels: z.array(z.string()).optional().describe("Labels to add"),
      },
      async ({ title, body: rawBody, labels }) => {
        if (!getCreds().github.hasToken) return { content: [{ type: "text", text: "No GitHub access configured" }], isError: true };
        // Unescape literal \n sequences the model sometimes sends
        const body = rawBody ? rawBody.replace(/\\n/g, "\n") : rawBody;
        try {
          const allLabels = [...(config.defaultLabels || []), ...(labels || [])];
          const issue = await getCreds().github.createIssue(config.repo, {
            title, body, labels: allLabels.length ? allLabels : undefined,
          });
          logActivity("artifact", `Issue #${issue.number}: ${title} — ${issue.html_url}`);
          return { content: [{ type: "text", text: `${issue.html_url}\n#${issue.number}` }] };
        } catch (e: any) {
          return { content: [{ type: "text", text: `${config.name}: ${sanitizeError(e.message)}` }], isError: true };
        }
      });
  }
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
  initSubmodules?: boolean;
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
  /** If set, runs before staging in create_pr/update_pr. Fails gracefully. */
  formatBeforePush?: () => Promise<{ ok: boolean; text: string }>;
}

// ── registerCloneRepo ───────────────────────────────────────────

export function registerCloneRepo(server: McpServer, config: CloneToolConfig): void {
  const desc = config.description ||
    `Clone the repo into ${config.workspace}. MUST be your FIRST tool call — the workspace is empty until you clone. Do NOT run git, ls, Read, or any file operations before calling this. Safe to call on resume — fetches new refs.`;
  const refHint = config.refHint || "'origin/next', 'abc123'";

  const defaultRef = config.fallbackRef || "origin/main";
  server.tool("clone_repo", desc,
    { ref: z.string().regex(/^[a-zA-Z0-9._\/@-]+$/).default(defaultRef).describe(`Branch, tag, or commit hash to check out (default: ${defaultRef}). Examples: ${refHint}`) },
    async ({ ref }) => {
      if (ref.startsWith("-")) return { content: [{ type: "text", text: "Invalid ref: must not start with -" }], isError: true };
      const targetDir = config.workspace;

      if (existsSync(join(targetDir, ".git"))) {
        try {
          // Disable sparse checkout if active (from pre-clone) to get full working tree
          try {
            execFileSync("git", ["-C", targetDir, "sparse-checkout", "disable"], { timeout: 10_000, stdio: "pipe" });
          } catch {}

          try {
            execFileSync("git", ["-C", targetDir, "fetch", "origin"], { timeout: 120_000, stdio: "pipe" });
          } catch {}

          const result = cloneRepoCheckoutAndInit(targetDir, ref, config.fallbackRef, { initSubmodules: config.initSubmodules });
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

        const result = cloneRepoCheckoutAndInit(targetDir, ref, config.fallbackRef, { initSubmodules: config.initSubmodules });
        if (result.isError) return { content: [{ type: "text", text: `Clone succeeded but: ${result.text}` }], isError: true };
        logActivity("clone", `Cloned ${config.repo} at ${ref} (${result.text})`);
        return { content: [{ type: "text", text: `Cloned ${config.repo} to ${targetDir} at ${ref} (${result.text}) Work in ${targetDir}.` }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Clone failed: ${sanitizeError(e.message)}` }], isError: true };
      }
    });
}

// ── registerGitProxy (git_fetch + git_pull — authenticated via sidecar) ──

export function registerGitProxy(server: McpServer, config: { workspace: string }): void {
  // Helper: run git with GH_TOKEN auth via GIT_ASKPASS
  function gitWithAuth(args: string[], timeoutMs = 120_000): string {
    const askpass = join("/tmp", `.git-askpass-${process.pid}-${Date.now()}`);
    writeFileSync(askpass, `#!/bin/sh\necho "$GIT_PASSWORD"\n`, { mode: 0o700 });
    try {
      return execFileSync("git", args, {
        timeout: timeoutMs, encoding: "utf-8", stdio: "pipe",
        env: { ...process.env, GIT_ASKPASS: askpass, GIT_PASSWORD: process.env.GH_TOKEN || "" },
      });
    } finally { try { unlinkSync(askpass); } catch {} }
  }

  server.tool("git_fetch", "Fetch from origin (authenticated). Use this instead of bare `git fetch` which may lack auth for private repos.",
    { ref: z.string().optional().describe("Optional refspec to fetch (e.g. 'next', 'pull/123/head:pr-123')") },
    async ({ ref }) => {
      const workspace = config.workspace;
      if (!existsSync(join(workspace, ".git"))) {
        return { content: [{ type: "text", text: "No repo at " + workspace }], isError: true };
      }
      try {
        const args = ["-C", workspace, "fetch", "origin"];
        if (ref) args.push(ref);
        const out = gitWithAuth(args);
        return { content: [{ type: "text", text: `Fetched${ref ? " " + ref : ""} successfully.\n${out}`.trim() }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Fetch failed: ${sanitizeError(e.message)}` }], isError: true };
      }
    });

  server.tool("submodule_update", "Initialize and update all git submodules (shallow, parallel). Optionally target a single submodule. Run this before 'build' — most targets depend on submodules.",
    {
      path: z.string().optional().describe("Submodule path (e.g. 'noir/noir-repo'). If omitted, updates all submodules."),
      commit: z.string().optional().describe("Checkout submodule to this commit/ref after update"),
    },
    async ({ path, commit }) => {
      const workspace = config.workspace;
      if (!existsSync(join(workspace, ".git"))) {
        return { content: [{ type: "text", text: "No repo at " + workspace }], isError: true };
      }
      try {
        const args = ["-C", workspace, "submodule", "update", "--init", "--recursive", "--depth", "1", "--jobs", "8"];
        if (path) args.push("--", path);
        const out = gitWithAuth(args, 300_000);
        let result = "Submodule" + (path ? " " + path : "s") + " initialized and updated.\n" + out;
        if (commit && path) {
          const subDir = join(workspace, path);
          execFileSync("git", ["-C", subDir, "checkout", commit], { timeout: 30_000, encoding: "utf-8", stdio: "pipe" });
          result += "\nChecked out " + path + " to " + commit;
        }
        return { content: [{ type: "text", text: result.trim() }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Submodule update failed: ${sanitizeError(e.message)}` }], isError: true };
      }
    });

  server.tool("git_pull", "Pull from origin (authenticated rebase). Use this instead of bare `git pull`.",
    { ref: z.string().optional().describe("Remote branch to pull (default: current tracking branch)") },
    async ({ ref }) => {
      const workspace = config.workspace;
      if (!existsSync(join(workspace, ".git"))) {
        return { content: [{ type: "text", text: "No repo at " + workspace }], isError: true };
      }
      try {
        const args = ["-C", workspace, "pull", "--rebase", "origin"];
        if (ref) args.push(ref);
        const out = gitWithAuth(args);
        return { content: [{ type: "text", text: `Pulled${ref ? " " + ref : ""} successfully.\n${out}`.trim() }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Pull failed: ${sanitizeError(e.message)}` }], isError: true };
      }
    });
}

// ── registerLogTools (read_log + write_log — CI log access) ─────

export function registerLogTools(server: McpServer, config: { workspace: string }): void {
  // Locate ci3/ scripts in the workspace repo
  function findCi3(): string | null {
    // Check workspace for ci3/ (available after clone_repo)
    const wsPath = join(config.workspace, "ci3");
    if (existsSync(join(wsPath, "cache_log"))) return wsPath;
    return null;
  }

  server.tool("read_log",
    `Read a CI log by key/hash. Use instead of using CI_PASSWORD or curling the log server directly.`,
    {
      key: z.string().regex(/^[a-zA-Z0-9._-]+$/).describe("Log key/hash from a CI log URL"),
      tail: z.number().optional().describe("Only return the last N lines"),
      head: z.number().optional().describe("Only return the first N lines"),
    },
    async ({ key, tail, head }) => {
      const serverUrl = process.env.CLAUDEBOX_SERVER_URL;
      const serverToken = process.env.CLAUDEBOX_SERVER_TOKEN;
      if (!serverUrl || !serverToken) {
        return { content: [{ type: "text", text: "read_log: no server connection configured" }], isError: true };
      }

      try {
        const resp = await fetch(`${serverUrl}/api/internal/read-log?key=${encodeURIComponent(key)}`, {
          headers: { "Authorization": `Bearer ${serverToken}` },
        });
        if (!resp.ok) {
          const raw = await resp.text();
          let msg: string;
          try {
            const parsed = JSON.parse(raw);
            msg = parsed.error || raw;
          } catch { msg = raw; }
          return { content: [{ type: "text", text: `read_log failed (HTTP ${resp.status}) for key '${key}': ${msg.slice(0, 800)}` }], isError: true };
        }

        let output = await resp.text();
        if (!output.trim()) {
          return { content: [{ type: "text", text: `Log '${key}' is empty or not found.` }], isError: true };
        }

        if (tail || head) {
          const lines = output.split("\n");
          if (tail) output = lines.slice(-tail).join("\n");
          else if (head) output = lines.slice(0, head).join("\n");
        }

        const MAX = 200_000;
        if (output.length > MAX) {
          output = output.slice(0, MAX) + `\n\n...(truncated at ${MAX} chars, use tail/head params)`;
        }

        return { content: [{ type: "text", text: output }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: `read_log: ${sanitizeError(e.message)}` }], isError: true };
      }
    });

  server.tool("write_log",
    `Write content to a CI log. Creates a persistent, shareable log link.

Use this instead of create_gist for:
- Build output and CI logs
- Large command output
- Anything that needs a quick shareable link without creating a GitHub gist

Returns the log URL.`,
    {
      content: z.string().describe("Content to write to the log"),
      key: z.string().regex(/^[a-zA-Z0-9._-]+$/).optional().describe("Custom key (default: auto-generated). Use descriptive keys like 'build-output-pr-123'."),
      category: z.string().default("claudebox").describe("Log category prefix (default: 'claudebox')"),
    },
    async ({ content: logContent, key, category }) => {
      const ci3 = findCi3();
      if (!ci3) {
        return { content: [{ type: "text", text: "ci3/ not found. Run clone_repo first to make log tools available." }], isError: true };
      }

      const cacheLogBin = join(ci3, "cache_log");
      const logKey = key || `claudebox-${SESSION_META.log_id || "manual"}-${Date.now().toString(36)}`;

      try {
        const result = spawnSync(cacheLogBin, [category, logKey], {
          input: logContent,
          encoding: "utf-8",
          timeout: 15_000,
          stdio: ["pipe", "pipe", "pipe"],
          env: { ...process.env },
        });

        if (result.status !== 0) {
          const err = (result.stderr || "").trim();
          return { content: [{ type: "text", text: `write_log failed (exit ${result.status}): ${err.slice(0, 500)}` }], isError: true };
        }

        const logBase = process.env.CI_LOG_BASE_URL || "https://ci.aztec-labs.com";
        const url = `${logBase}/${logKey}`;
        logActivity("artifact", `Log: ${url}`);
        return { content: [{ type: "text", text: `${url}\nKey: ${logKey}` }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: `write_log: ${sanitizeError(e.message)}` }], isError: true };
      }
    });
}

// ── registerPRTools (create_pr + update_pr) ─────────────────────

export function registerPRTools(server: McpServer, config: PRToolConfig): void {
  // ── create_pr ──
  const createSchema: Record<string, any> = {
    title: z.string().describe("PR title"),
    body: z.string().describe("PR description (Markdown). Use real newlines, not literal \\n."),
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
      const { title, closes, force_push, include_claude_files, include_noir_submodule } = params;
      // Unescape literal \n sequences the model sometimes sends (double-escaped in JSON)
      const body: string = (params.body || "").replace(/\\n/g, "\n");
      let base: string = params.base;
      if (/^v\d+/.test(base)) base = `backport-to-${base}-staging`;
      if (!getCreds().github.hasToken) return { content: [{ type: "text", text: "No GitHub access configured" }], isError: true };

      if (base !== SESSION_META.base_branch) {
        try {
          git(config.workspace, "fetch", "origin", base);
          const mergeBase = git(config.workspace, "merge-base", `origin/${base}`, "HEAD").trim();
          const remoteTip = git(config.workspace, "rev-parse", `origin/${base}`).trim();
          if (mergeBase !== remoteTip) {
            console.log(`[create_pr] Warning: merge-base (${mergeBase.slice(0, 8)}) != origin/${base} tip (${remoteTip.slice(0, 8)}). Proceeding anyway (may contain merge commits).`);
          }
        } catch {}
      }

      if (config.blockedBases) {
        if (!/^[\w./-]+$/.test(base)) return { content: [{ type: "text", text: `Invalid base: ${base}` }], isError: true };
        if (config.blockedBases.test(base))
          return { content: [{ type: "text", text: `Blocked: never target '${base}'. Use '${config.defaultBase}' or a version branch.` }], isError: true };
      }

      try {
        if (config.formatBeforePush) {
          try {
            const fmt = await config.formatBeforePush();
            if (fmt.text) console.log(`[create_pr] format: ${fmt.text}`);
          } catch (e: any) { console.error(`[create_pr] format failed (continuing): ${e.message}`); }
        }

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
          const labels = [config.label, "ci-draft"];
          try { await creds.github.addLabels(config.repo, pr.number, labels); } catch {}
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
    body: z.string().optional().describe("New body (Markdown). Use real newlines, not literal \\n."),
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
      const { pr_number, push, title, state, force_push, include_claude_files, include_noir_submodule } = params;
      // Unescape literal \n sequences the model sometimes sends
      const body: string | undefined = params.body ? (params.body as string).replace(/\\n/g, "\n") : undefined;
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

          if (config.formatBeforePush) {
            try {
              const fmt = await config.formatBeforePush();
              if (fmt.text) console.log(`[update_pr] format: ${fmt.text}`);
            } catch (e: any) { console.error(`[update_pr] format failed (continuing): ${e.message}`); }
          }

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
