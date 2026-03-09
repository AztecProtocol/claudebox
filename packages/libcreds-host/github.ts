/**
 * Host-side GitHub operations — privileged server-side helpers.
 *
 * Wraps libcreds GitHubClient for host-specific use cases:
 * updating issue comments (from /api/internal/comment) and
 * listing issues (from audit endpoints).
 */

import { getHostCreds } from "./index.ts";

export class HostGitHub {
  /** Update an issue comment body. Used by /api/internal/comment handler. */
  static async updateIssueComment(repo: string, commentId: string, body: string): Promise<any> {
    const creds = getHostCreds();
    return creds.github.updateIssueComment(repo, commentId, body);
  }

  /** List issues for a repo. Used by audit findings endpoint. */
  static async listIssues(repo: string, params?: Record<string, string>): Promise<any[]> {
    const creds = getHostCreds();
    return creds.github.listIssues(repo, params);
  }

  /** Get a single issue. */
  static async getIssue(repo: string, issueNumber: number): Promise<any> {
    const creds = getHostCreds();
    return creds.github.getIssue(repo, issueNumber);
  }

  /** Get pull request details. */
  static async getPull(repo: string, prNumber: number): Promise<any> {
    const creds = getHostCreds();
    return creds.github.getPull(repo, prNumber);
  }

  /** Add a comment to an issue or PR. */
  static async addIssueComment(repo: string, issueNumber: number, body: string): Promise<any> {
    const creds = getHostCreds();
    return creds.github.addIssueComment(repo, issueNumber, body);
  }
}
