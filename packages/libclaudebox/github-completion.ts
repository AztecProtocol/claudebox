/**
 * GitHub PR comment updates on session completion.
 *
 * Updates the run_comment_id with final status + response,
 * and posts a new comment linking to the completed run.
 */

import type { WorktreeStore } from "./worktree-store.ts";
import { getHostCreds } from "../libcreds-host/index.ts";
import { sessionUrl } from "./util.ts";

/** Extract PR number from a GitHub link like https://github.com/org/repo/pull/123 */
function prNumberFromLink(link: string): number | null {
  const m = link.match(/\/pull\/(\d+)/);
  return m ? parseInt(m[1], 10) : null;
}

/** Extract repo from a link like https://github.com/AztecProtocol/aztec-packages/... */
function repoFromLink(link: string): string | null {
  const m = link.match(/github\.com\/([^/]+\/[^/]+)/);
  return m ? m[1] : null;
}

export async function updateGithubOnCompletion(
  store: WorktreeStore,
  logId: string,
  worktreeId: string,
  exitCode: number,
): Promise<void> {
  const session = store.get(logId);
  if (!session) return;

  // Determine repo + PR number from session metadata
  const link = session.link || "";
  const repo = session.repo || repoFromLink(link) || "";
  const prNumber = prNumberFromLink(link);
  if (!repo || !prNumber) return;

  const creds = getHostCreds();
  if (!creds.github.hasToken) return;

  const statusEmoji = exitCode === 0 ? "\u2705" : "\u26A0\uFE0F";
  const statusText = exitCode === 0 ? "completed" : `error (exit ${exitCode})`;

  const currentSeq = logId.match(/-(\d+)$/)?.[1] || "1";
  const baseUrl = sessionUrl(worktreeId);

  // Get latest response from activity
  const activity = store.readActivity(worktreeId).reverse(); // oldest first
  const currentActivity = activity.filter(a => a.log_id === logId);
  const lastResponse = currentActivity.filter(a => a.type === "response").pop();
  const artifacts = currentActivity.filter(a => a.type === "artifact");

  // Build the run comment body
  const lines: string[] = [];
  lines.push(`${statusEmoji} **Run #${currentSeq}** — ${statusText}`);
  lines.push(`[Live status](${baseUrl})`);

  // Response
  if (lastResponse?.text) {
    const text = lastResponse.text.length > 600 ? lastResponse.text.slice(0, 600) + "\u2026" : lastResponse.text;
    lines.push("");
    lines.push(text);
  }

  // Artifacts
  if (artifacts.length > 0) {
    const artifactLinks: string[] = [];
    const seenUrls = new Set<string>();
    for (const a of artifacts) {
      const urlMatch = a.text.match(/(https?:\/\/[^\s)>\]]+)/);
      if (!urlMatch) continue;
      const url = urlMatch[1].replace(/[.,;:!?]+$/, "");
      if (seenUrls.has(url)) continue;
      seenUrls.add(url);
      const prMatch = url.match(/\/pull\/(\d+)/);
      if (prMatch) { artifactLinks.push(`[PR #${prMatch[1]}](${url})`); continue; }
      const issueMatch = url.match(/\/issues\/(\d+)/);
      if (issueMatch) { artifactLinks.push(`[Issue #${issueMatch[1]}](${url})`); continue; }
      if (url.includes("gist.github")) { artifactLinks.push(`[Gist](${url})`); continue; }
      artifactLinks.push(`[Link](${url})`);
    }
    if (artifactLinks.length) {
      lines.push("");
      lines.push(artifactLinks.join(" \u00B7 "));
    }
  }

  const body = lines.join("\n");

  try {
    // Update existing run_comment_id if we have one
    if (session.run_comment_id) {
      await creds.github.updateIssueComment(repo, session.run_comment_id, body);
      console.log(`[GITHUB] Updated run comment ${session.run_comment_id} on ${repo}#${prNumber}`);
    } else {
      // Post a new comment on the PR
      await creds.github.addIssueComment(repo, prNumber, body);
      console.log(`[GITHUB] Posted completion comment on ${repo}#${prNumber}`);
    }
  } catch (e: any) {
    console.warn(`[GITHUB] Failed to update PR comment: ${e.message}`);
  }
}
