/**
 * GitHub API client with audit logging.
 *
 * Clean wrapper — no grant checking. Security boundary is the token.
 */

import type { SessionContext } from "./types.ts";
import { audit } from "./audit.ts";
import { execFile } from "child_process";
import { writeFile, unlink } from "fs/promises";
import { join } from "path";
import { promisify } from "util";

const execFileAsync = promisify(execFile);

export interface GitHubClientOpts {
  token: string;
  ctx: SessionContext;
}

export class GitHubClient {
  private token: string;
  private ctx: SessionContext;

  constructor(opts: GitHubClientOpts) {
    this.token = opts.token;
    this.ctx = opts.ctx;
  }

  get hasToken(): boolean { return !!this.token; }

  // ── HTTP transport ──────────────────────────────────────────────

  private async ghFetch(path: string, opts: { method?: string; body?: any; accept?: string } = {}): Promise<Response> {
    if (!this.token) throw new Error("[libcreds] No GitHub token available");
    const method = opts.method || "GET";
    const url = `https://api.github.com/${path.replace(/^\//, "")}`;
    const headers: Record<string, string> = {
      Authorization: `Bearer ${this.token}`,
      Accept: opts.accept || "application/vnd.github.v3+json",
    };
    if (opts.body) headers["Content-Type"] = "application/json";

    const res = await fetch(url, {
      method, headers,
      ...(opts.body ? { body: JSON.stringify(opts.body) } : {}),
    });
    if (!res.ok) {
      const text = await res.text().catch(() => "");
      throw new Error(`GitHub ${res.status}: ${text.slice(0, 500)}`);
    }
    return res;
  }

  private async ghJson(path: string, opts: { method?: string; body?: any; accept?: string } = {}): Promise<any> {
    return (await this.ghFetch(path, opts)).json();
  }

  // ── READ ────────────────────────────────────────────────────────

  async rawGet(repo: string, path: string, opts?: { accept?: string }): Promise<any> {
    audit("github", "read", `GET ${path}`, true);
    const res = await this.ghFetch(path, { accept: opts?.accept });
    const ct = res.headers.get("content-type") || "";
    return ct.includes("json") ? res.json() : res.text();
  }

  async getIssue(repo: string, issueNumber: number): Promise<any> {
    audit("github", "read", `GET repos/${repo}/issues/${issueNumber}`, true);
    return this.ghJson(`repos/${repo}/issues/${issueNumber}`);
  }

  async listIssues(repo: string, params?: Record<string, string>): Promise<any[]> {
    audit("github", "read", `GET repos/${repo}/issues`, true);
    const qs = params ? "?" + new URLSearchParams(params).toString() : "";
    return this.ghJson(`repos/${repo}/issues${qs}`);
  }

  async getIssueComments(repo: string, issueNumber: number): Promise<any[]> {
    audit("github", "read", `GET repos/${repo}/issues/${issueNumber}/comments`, true);
    return this.ghJson(`repos/${repo}/issues/${issueNumber}/comments`);
  }

  async getIssueTimeline(repo: string, issueNumber: number): Promise<any[]> {
    audit("github", "read", `GET repos/${repo}/issues/${issueNumber}/timeline`, true);
    return this.ghJson(`repos/${repo}/issues/${issueNumber}/timeline`);
  }

  async getPull(repo: string, prNumber: number): Promise<any> {
    audit("github", "read", `GET repos/${repo}/pulls/${prNumber}`, true);
    return this.ghJson(`repos/${repo}/pulls/${prNumber}`);
  }

  async listPulls(repo: string, params?: Record<string, string>): Promise<any[]> {
    audit("github", "read", `GET repos/${repo}/pulls`, true);
    const qs = params ? "?" + new URLSearchParams(params).toString() : "";
    return this.ghJson(`repos/${repo}/pulls${qs}`);
  }

  async getPullFiles(repo: string, prNumber: number): Promise<any[]> {
    audit("github", "read", `GET repos/${repo}/pulls/${prNumber}/files`, true);
    return this.ghJson(`repos/${repo}/pulls/${prNumber}/files`);
  }

  async getPullDiff(repo: string, prNumber: number): Promise<string> {
    audit("github", "read", `GET repos/${repo}/pulls/${prNumber} (diff)`, true);
    const res = await this.ghFetch(`repos/${repo}/pulls/${prNumber}`, { accept: "application/vnd.github.v3.diff" });
    return res.text();
  }

  async getContents(repo: string, path: string, ref?: string): Promise<any> {
    audit("github", "read", `GET repos/${repo}/contents/${path}`, true);
    const qs = ref ? `?ref=${encodeURIComponent(ref)}` : "";
    return this.ghJson(`repos/${repo}/contents/${path}${qs}`);
  }

  async getWorkflowRuns(repo: string, params?: Record<string, string>): Promise<any> {
    audit("github", "read", `GET repos/${repo}/actions/runs`, true);
    const qs = params ? "?" + new URLSearchParams(params).toString() : "";
    return this.ghJson(`repos/${repo}/actions/runs${qs}`);
  }

  async getWorkflowRunsByName(repo: string, workflow: string, params?: Record<string, string>): Promise<any> {
    audit("github", "read", `GET repos/${repo}/actions/workflows/${workflow}/runs`, true);
    const qs = params ? "?" + new URLSearchParams(params).toString() : "";
    return this.ghJson(`repos/${repo}/actions/workflows/${workflow}/runs${qs}`);
  }

  async getJobLogs(repo: string, jobId: number): Promise<string> {
    audit("github", "read", `GET repos/${repo}/actions/jobs/${jobId}/logs`, true);
    const res = await this.ghFetch(`repos/${repo}/actions/jobs/${jobId}/logs`);
    return res.text();
  }

  async getCommitStatus(repo: string, sha: string): Promise<any> {
    audit("github", "read", `GET repos/${repo}/commits/${sha}/status`, true);
    return this.ghJson(`repos/${repo}/commits/${sha}/status`);
  }

  async getCommitCheckRuns(repo: string, sha: string): Promise<any> {
    audit("github", "read", `GET repos/${repo}/commits/${sha}/check-runs`, true);
    return this.ghJson(`repos/${repo}/commits/${sha}/check-runs`);
  }

  async getBranches(repo: string): Promise<any[]> {
    audit("github", "read", `GET repos/${repo}/branches`, true);
    return this.ghJson(`repos/${repo}/branches`);
  }

  async getCompare(repo: string, base: string, head: string): Promise<any> {
    audit("github", "read", `GET repos/${repo}/compare/${base}...${head}`, true);
    return this.ghJson(`repos/${repo}/compare/${base}...${head}`);
  }

  async listGists(params?: Record<string, string>): Promise<any[]> {
    audit("github", "read", "GET gists", true);
    const qs = params ? "?" + new URLSearchParams(params).toString() : "";
    return this.ghJson(`gists${qs}`);
  }

  async getGist(gistId: string): Promise<any> {
    audit("github", "read", `GET gists/${gistId}`, true);
    return this.ghJson(`gists/${gistId}`);
  }

  async searchIssues(query: string): Promise<any> {
    audit("github", "read", `GET search/issues?q=${query.slice(0, 50)}`, true);
    return this.ghJson(`search/issues?q=${encodeURIComponent(query)}`);
  }

  async searchCode(query: string): Promise<any> {
    audit("github", "read", `GET search/code?q=${query.slice(0, 50)}`, true);
    return this.ghJson(`search/code?q=${encodeURIComponent(query)}`);
  }

  async getUser(username: string): Promise<any> {
    audit("github", "read", `GET users/${username}`, true);
    return this.ghJson(`users/${username}`);
  }

  // ── WRITE ───────────────────────────────────────────────────────

  async createIssue(repo: string, opts: { title: string; body?: string; labels?: string[] }): Promise<any> {
    audit("github", "write", `POST repos/${repo}/issues`, true);
    return this.ghJson(`repos/${repo}/issues`, { method: "POST", body: opts });
  }

  async updateIssue(repo: string, issueNumber: number, opts: { title?: string; body?: string; state?: string; labels?: string[] }): Promise<any> {
    audit("github", "write", `PATCH repos/${repo}/issues/${issueNumber}`, true);
    return this.ghJson(`repos/${repo}/issues/${issueNumber}`, { method: "PATCH", body: opts });
  }

  async addIssueComment(repo: string, issueNumber: number, body: string): Promise<any> {
    audit("github", "write", `POST repos/${repo}/issues/${issueNumber}/comments`, true);
    return this.ghJson(`repos/${repo}/issues/${issueNumber}/comments`, { method: "POST", body: { body } });
  }

  async updateIssueComment(repo: string, commentId: string, body: string): Promise<any> {
    audit("github", "write", `PATCH repos/${repo}/issues/comments/${commentId}`, true);
    return this.ghJson(`repos/${repo}/issues/comments/${commentId}`, { method: "PATCH", body: { body } });
  }

  async addLabels(repo: string, issueNumber: number, labels: string[]): Promise<any> {
    audit("github", "write", `POST repos/${repo}/issues/${issueNumber}/labels`, true);
    return this.ghJson(`repos/${repo}/issues/${issueNumber}/labels`, { method: "POST", body: { labels } });
  }

  async createLabel(repo: string, opts: { name: string; color: string; description?: string }): Promise<any> {
    audit("github", "write", `POST repos/${repo}/labels`, true);
    return this.ghJson(`repos/${repo}/labels`, { method: "POST", body: opts });
  }

  async createPull(repo: string, opts: {
    title: string; body: string; base: string; head: string; draft?: boolean;
  }): Promise<any> {
    audit("github", "write", `POST repos/${repo}/pulls`, true);
    return this.ghJson(`repos/${repo}/pulls`, { method: "POST", body: opts });
  }

  async updatePull(repo: string, prNumber: number, opts: {
    title?: string; body?: string; base?: string; state?: string;
  }): Promise<any> {
    audit("github", "write", `PATCH repos/${repo}/pulls/${prNumber}`, true);
    return this.ghJson(`repos/${repo}/pulls/${prNumber}`, { method: "PATCH", body: opts });
  }

  async createGist(opts: {
    description: string;
    files: Record<string, { content: string }>;
    public?: boolean;
  }): Promise<any> {
    audit("github", "write", "POST gists", true);
    return this.ghJson("gists", {
      method: "POST",
      body: { description: opts.description, files: opts.files, public: opts.public ?? false },
    });
  }

  async updateGist(gistId: string, opts: {
    description?: string;
    files: Record<string, { content: string } | null>;
  }): Promise<any> {
    audit("github", "write", `PATCH gists/${gistId}`, true);
    return this.ghJson(`gists/${gistId}`, {
      method: "PATCH",
      body: { ...(opts.description ? { description: opts.description } : {}), files: opts.files },
    });
  }

  async putContents(repo: string, path: string, opts: {
    message: string; content: string; branch?: string; sha?: string;
  }): Promise<any> {
    audit("github", "write", `PUT repos/${repo}/contents/${path}`, true);
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
    audit("github", "write", `POST repos/${repo}/git/refs`, true);
    return this.ghJson(`repos/${repo}/git/refs`, { method: "POST", body: { ref, sha } });
  }

  async getRef(repo: string, ref: string): Promise<any> {
    audit("github", "read", `GET repos/${repo}/git/ref/${ref}`, true);
    return this.ghJson(`repos/${repo}/git/ref/${ref}`);
  }

  // ── Git push (shell-based) ──────────────────────────────────────

  async pushToRemote(workspace: string, repo: string, branch: string, forcePush?: boolean): Promise<void> {
    audit("github", forcePush ? "destructive" : "write", `${forcePush ? "force-" : ""}push ${branch}`, true);

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
