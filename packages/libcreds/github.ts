/**
 * GitHub credential client.
 *
 * Every GitHub API call goes through this module.
 * Each method checks the grant inline, audits, then calls the API.
 */

import type { SessionContext, ProfileGrant } from "./types.ts";
import { audit, deny } from "./audit.ts";
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

function validateRepo(repo: string): void {
  if (typeof repo !== "string" || repo.length === 0 || repo.length > 200) {
    throw new Error("[libcreds] Invalid GitHub repo identifier");
  }
  if (!/^[A-Za-z0-9_.-]+\/[A-Za-z0-9_.-]+$/.test(repo)) {
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

  get hasToken(): boolean { return !!this.token; }

  // ── Grant checks (inline, no policy engine) ─────────────────────

  private requireRead(repo: string, detail: string): void {
    validateRepo(repo);
    if (!this.grant) deny("github", "read", detail, `no GitHub grant for profile '${this.ctx.profile}'`);
    const all = [...this.grant.repos, ...(this.grant.readOnlyRepos || [])];
    if (!all.includes(repo)) deny("github", "read", detail, `repo '${repo}' not in allowed list for profile '${this.ctx.profile}'`);
    audit("github", "read", detail, true);
  }

  private requireWrite(repo: string, detail: string): void {
    validateRepo(repo);
    if (!this.grant) deny("github", "write", detail, `no GitHub grant for profile '${this.ctx.profile}'`);
    if (!this.grant.repos.includes(repo)) {
      if (this.grant.readOnlyRepos?.includes(repo)) {
        deny("github", "write", detail, `repo '${repo}' is read-only for profile '${this.ctx.profile}'`);
      }
      deny("github", "write", detail, `repo '${repo}' not in allowed list for profile '${this.ctx.profile}'`);
    }
    audit("github", "write", detail, true);
  }

  private requireClose(repo: string, detail: string): void {
    this.requireWrite(repo, detail); // also checks repo access
    if (!this.grant!.canClose) deny("github", "destructive", detail, `close not allowed for profile '${this.ctx.profile}'`);
    audit("github", "destructive", detail, true);
  }

  private requireForcePush(repo: string, detail: string): void {
    this.requireWrite(repo, detail);
    if (!this.grant!.canForcePush) deny("github", "destructive", detail, `force-push not allowed for profile '${this.ctx.profile}'`);
    audit("github", "destructive", detail, true);
  }

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

  /** Raw GET — for generic read tools. Checks repo read access, logs the exact path. */
  async rawGet(repo: string, path: string, opts?: { accept?: string }): Promise<any> {
    this.requireRead(repo, `GET ${path}`);
    const res = await this.ghFetch(path, { accept: opts?.accept });
    const ct = res.headers.get("content-type") || "";
    return ct.includes("json") ? res.json() : res.text();
  }

  async getIssue(repo: string, issueNumber: number): Promise<any> {
    this.requireRead(repo, `GET repos/${repo}/issues/${issueNumber}`);
    return this.ghJson(`repos/${repo}/issues/${issueNumber}`);
  }

  async listIssues(repo: string, params?: Record<string, string>): Promise<any[]> {
    this.requireRead(repo, `GET repos/${repo}/issues`);
    const qs = params ? "?" + new URLSearchParams(params).toString() : "";
    return this.ghJson(`repos/${repo}/issues${qs}`);
  }

  async getIssueComments(repo: string, issueNumber: number): Promise<any[]> {
    this.requireRead(repo, `GET repos/${repo}/issues/${issueNumber}/comments`);
    return this.ghJson(`repos/${repo}/issues/${issueNumber}/comments`);
  }

  async getIssueTimeline(repo: string, issueNumber: number): Promise<any[]> {
    this.requireRead(repo, `GET repos/${repo}/issues/${issueNumber}/timeline`);
    return this.ghJson(`repos/${repo}/issues/${issueNumber}/timeline`);
  }

  async getPull(repo: string, prNumber: number): Promise<any> {
    this.requireRead(repo, `GET repos/${repo}/pulls/${prNumber}`);
    return this.ghJson(`repos/${repo}/pulls/${prNumber}`);
  }

  async listPulls(repo: string, params?: Record<string, string>): Promise<any[]> {
    this.requireRead(repo, `GET repos/${repo}/pulls`);
    const qs = params ? "?" + new URLSearchParams(params).toString() : "";
    return this.ghJson(`repos/${repo}/pulls${qs}`);
  }

  async getPullFiles(repo: string, prNumber: number): Promise<any[]> {
    this.requireRead(repo, `GET repos/${repo}/pulls/${prNumber}/files`);
    return this.ghJson(`repos/${repo}/pulls/${prNumber}/files`);
  }

  async getPullDiff(repo: string, prNumber: number): Promise<string> {
    this.requireRead(repo, `GET repos/${repo}/pulls/${prNumber} (diff)`);
    const res = await this.ghFetch(`repos/${repo}/pulls/${prNumber}`, { accept: "application/vnd.github.v3.diff" });
    return res.text();
  }

  async getContents(repo: string, path: string, ref?: string): Promise<any> {
    this.requireRead(repo, `GET repos/${repo}/contents/${path}`);
    const qs = ref ? `?ref=${encodeURIComponent(ref)}` : "";
    return this.ghJson(`repos/${repo}/contents/${path}${qs}`);
  }

  async getWorkflowRuns(repo: string, params?: Record<string, string>): Promise<any> {
    this.requireRead(repo, `GET repos/${repo}/actions/runs`);
    const qs = params ? "?" + new URLSearchParams(params).toString() : "";
    return this.ghJson(`repos/${repo}/actions/runs${qs}`);
  }

  async getWorkflowRunsByName(repo: string, workflow: string, params?: Record<string, string>): Promise<any> {
    this.requireRead(repo, `GET repos/${repo}/actions/workflows/${workflow}/runs`);
    const qs = params ? "?" + new URLSearchParams(params).toString() : "";
    return this.ghJson(`repos/${repo}/actions/workflows/${workflow}/runs${qs}`);
  }

  async getJobLogs(repo: string, jobId: number): Promise<string> {
    this.requireRead(repo, `GET repos/${repo}/actions/jobs/${jobId}/logs`);
    const res = await this.ghFetch(`repos/${repo}/actions/jobs/${jobId}/logs`);
    return res.text();
  }

  async getCommitStatus(repo: string, sha: string): Promise<any> {
    this.requireRead(repo, `GET repos/${repo}/commits/${sha}/status`);
    return this.ghJson(`repos/${repo}/commits/${sha}/status`);
  }

  async getCommitCheckRuns(repo: string, sha: string): Promise<any> {
    this.requireRead(repo, `GET repos/${repo}/commits/${sha}/check-runs`);
    return this.ghJson(`repos/${repo}/commits/${sha}/check-runs`);
  }

  async getBranches(repo: string): Promise<any[]> {
    this.requireRead(repo, `GET repos/${repo}/branches`);
    return this.ghJson(`repos/${repo}/branches`);
  }

  async getCompare(repo: string, base: string, head: string): Promise<any> {
    this.requireRead(repo, `GET repos/${repo}/compare/${base}...${head}`);
    return this.ghJson(`repos/${repo}/compare/${base}...${head}`);
  }

  async listGists(params?: Record<string, string>): Promise<any[]> {
    const auditRepo = this.grant?.repos[0] || "unknown";
    this.requireRead(auditRepo, "GET gists");
    const qs = params ? "?" + new URLSearchParams(params).toString() : "";
    return this.ghJson(`gists${qs}`);
  }

  async getGist(gistId: string): Promise<any> {
    const auditRepo = this.grant?.repos[0] || "unknown";
    this.requireRead(auditRepo, `GET gists/${gistId}`);
    return this.ghJson(`gists/${gistId}`);
  }

  async searchIssues(query: string): Promise<any> {
    const auditRepo = this.grant?.repos[0] || "unknown";
    this.requireRead(auditRepo, `GET search/issues?q=${query.slice(0, 50)}`);
    return this.ghJson(`search/issues?q=${encodeURIComponent(query)}`);
  }

  async searchCode(query: string): Promise<any> {
    const auditRepo = this.grant?.repos[0] || "unknown";
    this.requireRead(auditRepo, `GET search/code?q=${query.slice(0, 50)}`);
    return this.ghJson(`search/code?q=${encodeURIComponent(query)}`);
  }

  async getUser(username: string): Promise<any> {
    const auditRepo = this.grant?.repos[0] || "unknown";
    this.requireRead(auditRepo, `GET users/${username}`);
    return this.ghJson(`users/${username}`);
  }

  // ── WRITE ───────────────────────────────────────────────────────

  async createIssue(repo: string, opts: { title: string; body?: string; labels?: string[] }): Promise<any> {
    this.requireWrite(repo, `POST repos/${repo}/issues`);
    return this.ghJson(`repos/${repo}/issues`, { method: "POST", body: opts });
  }

  async updateIssue(repo: string, issueNumber: number, opts: { title?: string; body?: string; state?: string; labels?: string[] }): Promise<any> {
    if (opts.state === "closed") {
      this.requireClose(repo, `PATCH repos/${repo}/issues/${issueNumber} (close)`);
    } else {
      this.requireWrite(repo, `PATCH repos/${repo}/issues/${issueNumber}`);
    }
    return this.ghJson(`repos/${repo}/issues/${issueNumber}`, { method: "PATCH", body: opts });
  }

  async addIssueComment(repo: string, issueNumber: number, body: string): Promise<any> {
    this.requireWrite(repo, `POST repos/${repo}/issues/${issueNumber}/comments`);
    return this.ghJson(`repos/${repo}/issues/${issueNumber}/comments`, { method: "POST", body: { body } });
  }

  async updateIssueComment(repo: string, commentId: string, body: string): Promise<any> {
    this.requireWrite(repo, `PATCH repos/${repo}/issues/comments/${commentId}`);
    return this.ghJson(`repos/${repo}/issues/comments/${commentId}`, { method: "PATCH", body: { body } });
  }

  async addLabels(repo: string, issueNumber: number, labels: string[]): Promise<any> {
    this.requireWrite(repo, `POST repos/${repo}/issues/${issueNumber}/labels`);
    return this.ghJson(`repos/${repo}/issues/${issueNumber}/labels`, { method: "POST", body: { labels } });
  }

  async createLabel(repo: string, opts: { name: string; color: string; description?: string }): Promise<any> {
    this.requireWrite(repo, `POST repos/${repo}/labels`);
    return this.ghJson(`repos/${repo}/labels`, { method: "POST", body: opts });
  }

  async createPull(repo: string, opts: {
    title: string; body: string; base: string; head: string; draft?: boolean;
  }): Promise<any> {
    this.requireWrite(repo, `POST repos/${repo}/pulls`);
    return this.ghJson(`repos/${repo}/pulls`, { method: "POST", body: opts });
  }

  async updatePull(repo: string, prNumber: number, opts: {
    title?: string; body?: string; base?: string; state?: string;
  }): Promise<any> {
    if (opts.state === "closed") {
      this.requireClose(repo, `PATCH repos/${repo}/pulls/${prNumber} (close)`);
    } else {
      this.requireWrite(repo, `PATCH repos/${repo}/pulls/${prNumber}`);
    }
    return this.ghJson(`repos/${repo}/pulls/${prNumber}`, { method: "PATCH", body: opts });
  }

  async createGist(opts: {
    description: string;
    files: Record<string, { content: string }>;
    public?: boolean;
  }): Promise<any> {
    const auditRepo = this.grant?.repos[0] || "unknown";
    this.requireWrite(auditRepo, "POST gists");
    return this.ghJson("gists", {
      method: "POST",
      body: { description: opts.description, files: opts.files, public: opts.public ?? false },
    });
  }

  async putContents(repo: string, path: string, opts: {
    message: string; content: string; branch?: string; sha?: string;
  }): Promise<any> {
    this.requireWrite(repo, `PUT repos/${repo}/contents/${path}`);
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
    this.requireWrite(repo, `POST repos/${repo}/git/refs`);
    return this.ghJson(`repos/${repo}/git/refs`, { method: "POST", body: { ref, sha } });
  }

  async getRef(repo: string, ref: string): Promise<any> {
    this.requireRead(repo, `GET repos/${repo}/git/ref/${ref}`);
    return this.ghJson(`repos/${repo}/git/ref/${ref}`);
  }

  // ── Git push (shell-based) ──────────────────────────────────────
  // Uses GIT_ASKPASS to avoid leaking tokens in process arguments.

  async pushToRemote(workspace: string, repo: string, branch: string, forcePush?: boolean): Promise<void> {
    if (forcePush) {
      this.requireForcePush(repo, `force-push ${branch}`);
    } else {
      this.requireWrite(repo, `push ${branch}`);
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
