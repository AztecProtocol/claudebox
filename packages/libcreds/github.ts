/**
 * GitHub credential client — high-level typed operations.
 *
 * Every GitHub API call in ClaudeBox goes through this module.
 * Operations are policy-checked and audit-logged automatically.
 * Fully async — no sync filesystem or child_process calls.
 */

import type { SessionContext, ProfileGrant, GitHubOperationName } from "./types.ts";
import { checkGitHubPolicy, enforce } from "./policy.ts";
import { getOperationOrThrow } from "./operations.ts";
import { execFile } from "child_process";
import { writeFile, unlink } from "fs/promises";
import { join } from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export interface GitHubClientOpts {
  token: string;
  ctx: SessionContext;
  grant: ProfileGrant["github"];
}

interface GhFetchOpts {
  method?: string;
  body?: any;
  accept?: string;
}

function validateRepo(repo: string): void {
  if (typeof repo !== "string" || repo.length === 0 || repo.length > 200) {
    throw new Error("[libcreds] Invalid GitHub repo identifier");
  }
  // Require "owner/repo" with safe characters only.
  const repoPattern = /^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/;
  if (!repoPattern.test(repo)) {
    throw new Error("[libcreds] Invalid GitHub repo identifier");
  }
}

export class GitHubClient {
  private token: string;
  private ctx: SessionContext;
  private grant: ProfileGrant["github"];

  constructor(opts: GitHubClientOpts) {
    this.token = opts.token;
    this.ctx = opts.ctx;
    this.grant = opts.grant;
  }

  /** Whether a GitHub token is available (direct or proxied). */
  get hasToken(): boolean { return !!this.token; }

  // ── Internal ───────────────────────────────────────────────────

  private async check(operation: GitHubOperationName, repo: string, detail: string): Promise<void> {
    const decision = checkGitHubPolicy(operation, repo, this.ctx, this.grant);
    const op = getOperationOrThrow(operation);
    await enforce(decision, "github", operation, detail, op.danger);
  }

  private async ghFetch(path: string, opts: GhFetchOpts = {}): Promise<Response> {
    if (!this.token) throw new Error("[libcreds] No GitHub token available");

    const method = opts.method || "GET";
    const url = `https://api.github.com/${path.replace(/^\//, "")}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: opts.accept || "application/vnd.github.v3+json",
    };
    if (opts.body) headers["Content-Type"] = "application/json";

    const res = await fetch(url, {
      method,
      headers,
      ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
    });

    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`GitHub ${res.status}: ${text.slice(0, 500)}`);
    }

    return res;
  }

  private async ghJson(path: string, opts: GhFetchOpts = {}): Promise<any> {
    const res = await this.ghFetch(path, opts);
    return res.json();
  }

  // ── READ operations ────────────────────────────────────────────

  /** Generic read-only API call with policy enforcement. */
  async apiGet(repo: string, path: string, opts?: { accept?: string }): Promise<any> {
    await this.check("github:issues:read", repo, `GET ${path}`);
    const res = await this.ghFetch(path, { accept: opts?.accept });
    const ct = res.headers.get("content-type") || "";
    if (ct.includes("json")) return res.json();
    return res.text();
  }

  async getIssue(repo: string, issueNumber: number): Promise<any> {
    await this.check("github:issues:read", repo, `GET repos/${repo}/issues/${issueNumber}`);
    return this.ghJson(`repos/${repo}/issues/${issueNumber}`);
  }

  async listIssues(repo: string, params?: Record<string, string>): Promise<any[]> {
    await this.check("github:issues:read", repo, `GET repos/${repo}/issues`);
    const qs = params ? "?" + new URLSearchParams(params).toString() : "";
    return this.ghJson(`repos/${repo}/issues${qs}`);
  }

  async getIssueComments(repo: string, issueNumber: number): Promise<any[]> {
    await this.check("github:issues:read", repo, `GET repos/${repo}/issues/${issueNumber}/comments`);
    return this.ghJson(`repos/${repo}/issues/${issueNumber}/comments`);
  }

  async getIssueTimeline(repo: string, issueNumber: number): Promise<any[]> {
    await this.check("github:issues:read", repo, `GET repos/${repo}/issues/${issueNumber}/timeline`);
    return this.ghJson(`repos/${repo}/issues/${issueNumber}/timeline`);
  }

  async getPull(repo: string, prNumber: number): Promise<any> {
    await this.check("github:pulls:read", repo, `GET repos/${repo}/pulls/${prNumber}`);
    return this.ghJson(`repos/${repo}/pulls/${prNumber}`);
  }

  async listPulls(repo: string, params?: Record<string, string>): Promise<any[]> {
    await this.check("github:pulls:read", repo, `GET repos/${repo}/pulls`);
    const qs = params ? "?" + new URLSearchParams(params).toString() : "";
    return this.ghJson(`repos/${repo}/pulls${qs}`);
  }

  async getPullFiles(repo: string, prNumber: number): Promise<any[]> {
    await this.check("github:pulls:read", repo, `GET repos/${repo}/pulls/${prNumber}/files`);
    return this.ghJson(`repos/${repo}/pulls/${prNumber}/files`);
  }

  async getPullDiff(repo: string, prNumber: number): Promise<string> {
    await this.check("github:pulls:read", repo, `GET repos/${repo}/pulls/${prNumber} (diff)`);
    const res = await this.ghFetch(`repos/${repo}/pulls/${prNumber}`, { accept: "application/vnd.github.v3.diff" });
    return res.text();
  }

  async getContents(repo: string, path: string, ref?: string): Promise<any> {
    await this.check("github:contents:read", repo, `GET repos/${repo}/contents/${path}`);
    const qs = ref ? `?ref=${encodeURIComponent(ref)}` : "";
    return this.ghJson(`repos/${repo}/contents/${path}${qs}`);
  }

  async getWorkflowRuns(repo: string, params?: Record<string, string>): Promise<any> {
    await this.check("github:actions:read", repo, `GET repos/${repo}/actions/runs`);
    const qs = params ? "?" + new URLSearchParams(params).toString() : "";
    return this.ghJson(`repos/${repo}/actions/runs${qs}`);
  }

  async getWorkflowRunsByName(repo: string, workflow: string, params?: Record<string, string>): Promise<any> {
    await this.check("github:actions:read", repo, `GET repos/${repo}/actions/workflows/${workflow}/runs`);
    const qs = params ? "?" + new URLSearchParams(params).toString() : "";
    return this.ghJson(`repos/${repo}/actions/workflows/${workflow}/runs${qs}`);
  }

  async getJobLogs(repo: string, jobId: number): Promise<string> {
    await this.check("github:actions:read", repo, `GET repos/${repo}/actions/jobs/${jobId}/logs`);
    const res = await this.ghFetch(`repos/${repo}/actions/jobs/${jobId}/logs`);
    return res.text();
  }

  async getCommitStatus(repo: string, sha: string): Promise<any> {
    await this.check("github:commits:read", repo, `GET repos/${repo}/commits/${sha}/status`);
    return this.ghJson(`repos/${repo}/commits/${sha}/status`);
  }

  async getCommitCheckRuns(repo: string, sha: string): Promise<any> {
    await this.check("github:commits:read", repo, `GET repos/${repo}/commits/${sha}/check-runs`);
    return this.ghJson(`repos/${repo}/commits/${sha}/check-runs`);
  }

  async getBranches(repo: string): Promise<any[]> {
    await this.check("github:branches:read", repo, `GET repos/${repo}/branches`);
    return this.ghJson(`repos/${repo}/branches`);
  }

  async getCompare(repo: string, base: string, head: string): Promise<any> {
    await this.check("github:contents:read", repo, `GET repos/${repo}/compare/${base}...${head}`);
    return this.ghJson(`repos/${repo}/compare/${base}...${head}`);
  }

  async listGists(params?: Record<string, string>): Promise<any[]> {
    const auditRepo = this.grant?.repos[0] || "unknown";
    await this.check("github:gists:read", auditRepo, "GET gists");
    const qs = params ? "?" + new URLSearchParams(params).toString() : "";
    return this.ghJson(`gists${qs}`);
  }

  async getGist(gistId: string): Promise<any> {
    const auditRepo = this.grant?.repos[0] || "unknown";
    await this.check("github:gists:read", auditRepo, `GET gists/${gistId}`);
    return this.ghJson(`gists/${gistId}`);
  }

  async searchIssues(query: string): Promise<any> {
    const auditRepo = this.grant?.repos[0] || "unknown";
    await this.check("github:search", auditRepo, `GET search/issues?q=${query.slice(0, 50)}`);
    return this.ghJson(`search/issues?q=${encodeURIComponent(query)}`);
  }

  async searchCode(query: string): Promise<any> {
    const auditRepo = this.grant?.repos[0] || "unknown";
    await this.check("github:search", auditRepo, `GET search/code?q=${query.slice(0, 50)}`);
    return this.ghJson(`search/code?q=${encodeURIComponent(query)}`);
  }

  async getUser(username: string): Promise<any> {
    const auditRepo = this.grant?.repos[0] || "unknown";
    await this.check("github:users:read", auditRepo, `GET users/${username}`);
    return this.ghJson(`users/${username}`);
  }

  // ── WRITE operations ───────────────────────────────────────────

  async createIssue(repo: string, opts: { title: string; body?: string; labels?: string[] }): Promise<any> {
    await this.check("github:issues:create", repo, `POST repos/${repo}/issues`);
    return this.ghJson(`repos/${repo}/issues`, { method: "POST", body: opts });
  }

  async updateIssue(repo: string, issueNumber: number, opts: { title?: string; body?: string; state?: string; labels?: string[] }): Promise<any> {
    if (opts.state === "closed") {
      await this.check("github:issues:close", repo, `PATCH repos/${repo}/issues/${issueNumber} (close)`);
    } else {
      await this.check("github:issues:comment", repo, `PATCH repos/${repo}/issues/${issueNumber}`);
    }
    return this.ghJson(`repos/${repo}/issues/${issueNumber}`, { method: "PATCH", body: opts });
  }

  async addIssueComment(repo: string, issueNumber: number, body: string): Promise<any> {
    validateRepo(repo);
    await this.check("github:issues:comment", repo, `POST repos/${repo}/issues/${issueNumber}/comments`);
    return this.ghJson(`repos/${repo}/issues/${issueNumber}/comments`, { method: "POST", body: { body } });
  }

  async updateIssueComment(repo: string, commentId: string, body: string): Promise<any> {
    validateRepo(repo);
    await this.check("github:issues:comment", repo, `PATCH repos/${repo}/issues/comments/${commentId}`);
    return this.ghJson(`repos/${repo}/issues/comments/${commentId}`, { method: "PATCH", body: { body } });
  }

  async addLabels(repo: string, issueNumber: number, labels: string[]): Promise<any> {
    validateRepo(repo);
    await this.check("github:issues:label", repo, `POST repos/${repo}/issues/${issueNumber}/labels`);
    return this.ghJson(`repos/${repo}/issues/${issueNumber}/labels`, { method: "POST", body: { labels } });
  }

  async createLabel(repo: string, opts: { name: string; color: string; description?: string }): Promise<any> {
    await this.check("github:issues:label", repo, `POST repos/${repo}/labels`);
    return this.ghJson(`repos/${repo}/labels`, { method: "POST", body: opts });
  }

  async createPull(repo: string, opts: {
    title: string; body: string; base: string; head: string; draft?: boolean;
  }): Promise<any> {
    await this.check("github:pulls:create", repo, `POST repos/${repo}/pulls`);
    return this.ghJson(`repos/${repo}/pulls`, { method: "POST", body: opts });
  }

  async updatePull(repo: string, prNumber: number, opts: {
    title?: string; body?: string; base?: string; state?: string;
  }): Promise<any> {
    if (opts.state === "closed") {
      await this.check("github:pulls:close", repo, `PATCH repos/${repo}/pulls/${prNumber} (close)`);
    } else {
      await this.check("github:pulls:update", repo, `PATCH repos/${repo}/pulls/${prNumber}`);
    }
    return this.ghJson(`repos/${repo}/pulls/${prNumber}`, { method: "PATCH", body: opts });
  }

  async createGist(opts: {
    description: string;
    files: Record<string, { content: string }>;
    public?: boolean;
  }): Promise<any> {
    const auditRepo = this.grant?.repos[0] || "unknown";
    await this.check("github:gists:create", auditRepo, "POST gists");
    return this.ghJson("gists", {
      method: "POST",
      body: { description: opts.description, files: opts.files, public: opts.public ?? false },
    });
  }

  async putContents(repo: string, path: string, opts: {
    message: string; content: string; branch?: string; sha?: string;
  }): Promise<any> {
    await this.check("github:contents:write", repo, `PUT repos/${repo}/contents/${path}`);
    return this.ghJson(`repos/${repo}/contents/${path}`, {
      method: "PUT",
      body: {
        message: opts.message,
        content: Buffer.from(opts.content).toString("base64"),
        ...(opts.branch ? { branch: opts.branch } : {}),
        ...(opts.sha ? { sha: opts.sha } : {}),
      },
    });
  }

  async createRef(repo: string, ref: string, sha: string): Promise<any> {
    await this.check("github:refs:create", repo, `POST repos/${repo}/git/refs`);
    return this.ghJson(`repos/${repo}/git/refs`, { method: "POST", body: { ref, sha } });
  }

  async getRef(repo: string, ref: string): Promise<any> {
    await this.check("github:branches:read", repo, `GET repos/${repo}/git/ref/${ref}`);
    return this.ghJson(`repos/${repo}/git/ref/${ref}`);
  }

  // ── Git push (shell-based, async) ──────────────────────────────
  // Uses GIT_ASKPASS to avoid leaking tokens in process arguments.

  async pushToRemote(workspace: string, repo: string, branch: string, forcePush?: boolean): Promise<void> {
    if (forcePush) {
      await this.check("github:git:force-push", repo, `force-push ${branch}`);
    } else {
      await this.check("github:git:push", repo, `push ${branch}`);
    }

    const askpass = join("/tmp", `.git-askpass-${process.pid}-${Date.now()}`);
    await writeFile(askpass, `#!/bin/sh\necho "$GIT_PASSWORD"\n`, { mode: 0o700 });
    try {
      const pushUrl = `https://x-access-token@github.com/${repo}.git`;
      const pushArgs = ["push", ...(forcePush ? ["--force"] : []), pushUrl, `HEAD:refs/heads/${branch}`];
      await execFileAsync("git", pushArgs, {
        cwd: workspace, encoding: "utf-8", timeout: 120_000,
        env: { ...process.env, GIT_TERMINAL_PROMPT: "0", GIT_ASKPASS: askpass, GIT_PASSWORD: this.token },
      });
    } finally {
      await unlink(askpass).catch(() => {});
    }
  }
}
