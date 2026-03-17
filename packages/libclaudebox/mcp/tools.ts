/**
 * Common MCP tool registrar — shared tools for all profile sidecars.
 *
 * Registers: get_context, session_status, set_workspace_name, set_tag,
 * respond_to_user, github_api, linear_get_issue, linear_create_issue,
 * ci_failures, record_stat, create_gist.
 */

import { appendFileSync, mkdirSync } from "fs";
import { join } from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { getSchema, allSchemas, schemasPrompt } from "../stat-schemas.ts";
import { SESSION_META, QUIET_MODE, CI_ALLOW, STATS_DIR, WORKTREE_ID } from "./env.ts";
import {
  logActivity, addProgress, updateRootComment,
  otherArtifacts, truncateForSlack,
  respondToUserCalled, setRespondToUserCalled,
  getHostClient,
} from "./activity.ts";
import { getCreds, hasGhToken, hasLinearToken } from "./helpers.ts";

// ── Workspace name (shared state for branch naming) ─────────────
export let workspaceName = "";

export interface ProfileOpts {
  repo: string;
  workspace: string;
  ghWhitelist?: Array<{ method: string; pattern: RegExp }>;
}

export function registerCommonTools(server: McpServer, opts: ProfileOpts): void {
  const { repo } = opts;

  // ── get_context ────────────────────────────────────────────────
  server.tool("get_context", "Session metadata: user, repo, log_url, trigger source, git ref.", {},
    async () => {
      const ctx: Record<string, string> = {};
      for (const [k, v] of Object.entries(SESSION_META)) {
        if (v) ctx[k] = v;
      }
      ctx.ci_allow = CI_ALLOW ? "true — you CAN modify .github/ workflow files" : "false — .github/ workflow files are blocked. If you need to propose CI changes, write them to .github-new/ instead.";
      return { content: [{ type: "text", text: JSON.stringify(ctx, null, 2) }] };
    });

  // ── session_status ─────────────────────────────────────────────
  server.tool("session_status",
    "Update status in both Slack and GitHub. Log link + accumulated PR/issue links auto-appended.",
    { status: z.string().describe("Status text") },
    async ({ status }) => {
      logActivity("status", status);
      addProgress("status", status);
      const results = await updateRootComment(status);
      return { content: [{ type: "text", text: results.length ? results.join("\n") : "Status updated" }] };
    });

  // ── set_workspace_name ─────────────────────────────────────────
  server.tool("set_workspace_name",
    `MANDATORY — call immediately after clone_repo. Sets the workspace name used as the git branch name (e.g. "claudebox/<name>" or "audit/<name>") and displayed in the dashboard and Slack.
The name should be a concise slug describing the task (2-5 words, lowercase, hyphens).
Examples: "fix-flaky-p2p-test", "audit-polynomial-commitment", "add-g0-flag"
If you skip this, branches will have ugly auto-generated IDs instead of meaningful names.`,
    { name: z.string().describe("Short descriptive slug, e.g. fix-flaky-p2p-test") },
    async ({ name }) => {
      const slug = name.toLowerCase().replace(/[^a-z0-9-]/g, "-").replace(/-+/g, "-").replace(/^-|-$/g, "").slice(0, 60);
      workspaceName = slug;
      logActivity("name", slug);
      return { content: [{ type: "text", text: `Workspace named: ${slug}` }] };
    });

  // ── set_tag ────────────────────────────────────────────────────
  const tagCatsEnv = process.env.CLAUDEBOX_TAG_CATEGORIES || "";
  if (tagCatsEnv) {
    const TAG_CATEGORIES = tagCatsEnv.split(",").filter(Boolean);
    server.tool("set_tag",
      `Categorize this session into one of the fixed tags. Call this early (after reading the prompt).
Tags: ${TAG_CATEGORIES.join(", ")}
Choose the tag that best describes the work being done.`,
      { tag: z.enum(TAG_CATEGORIES as [string, ...string[]]).describe("Session category tag") },
      async ({ tag }) => {
        logActivity("tag", tag);
        return { content: [{ type: "text", text: `Tagged: ${tag}` }] };
      });
  }

  // ── claim_work ───────────────────────────────────────────────
  server.tool("claim_work",
    `MANDATORY first action — call this before doing any work. Atomically records what you're about to do and returns all sessions from the last 24 hours.

You MUST analyze the returned sessions for overlap with your task. If another RUNNING session is working on the same thing:
1. Call respond_to_user with: the other session's log URL, a summary of what it's doing, and a suggested action ("wait for it to finish", "check that thread for results", etc.)
2. Exit immediately — do NOT duplicate work.

IMPORTANT — be STRICT about overlap detection:
- Same PR number = same work, even if branches differ (e.g. "v4-next" and "backport-to-v4-next-staging" targeting the same PR are the SAME work)
- Same issue number = same work
- Same error/file being investigated = same work
- Automation-triggered sessions are ESPECIALLY suspect for duplicates — they often fire multiple times for the same event
- Do NOT rationalize continuing. If there is ANY reasonable overlap with a running session, EXIT.

If there is ANY reasonable overlap with a running session, you MUST exit. No exceptions.`,
    {
      work_description: z.string().describe("1-2 sentence summary of what you're about to do. Be specific: mention PR numbers, issue numbers, file paths, or error types."),
    },
    async ({ work_description }) => {
      logActivity("claim", work_description);
      try {
        const result = await getHostClient().claimWork(work_description);
        if (!result) return { content: [{ type: "text", text: "Work claimed (no server — dedup unavailable). Proceed." }] };

        const { sessions } = result;
        // Filter out this session itself
        const myLogId = SESSION_META.log_id;
        const others = sessions.filter((s: any) => s.log_id !== myLogId);

        if (others.length === 0) {
          return { content: [{ type: "text", text: "Work claimed. No recent sessions found — you are clear to proceed." }] };
        }

        const lines = others.map((s: any) => {
          const status = s.status === "running" ? "🔴 RUNNING" : `✅ ${s.status}`;
          const desc = s.work_description || s.prompt?.slice(0, 150) || "(no description)";
          const link = s.link || "";
          const logUrl = s.log_url || "";
          const user = s.user || "unknown";
          const started = s.started ? new Date(s.started).toISOString().slice(0, 16) : "";
          return `- [${status}] ${desc}\n  User: ${user} | Started: ${started}\n  Link: ${link}\n  Log: ${logUrl}`;
        });

        return { content: [{ type: "text", text:
          `Work claimed. Review these recent sessions for overlap:\n\n${lines.join("\n\n")}\n\n` +
          `If any session is already handling your task, call respond_to_user with the other session's log URL and a suggested action, then exit. ` +
          `If the user explicitly insisted on this work, or there is no overlap, proceed normally.`
        }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Work claimed (dedup check failed: ${e.message}). Proceed with caution.` }] };
      }
    });

  // ── respond_to_user ───────────────────────────────────────────
  server.tool("respond_to_user",
    `Send your final response to the user. Updates the Slack message inline. You MUST call this before ending.

Keep it to 1-3 SHORT sentences. **Never send long explanations** — put details in a gist (create_gist) and link it.

ALWAYS reference PRs and issues as full GitHub links (https://github.com/${repo}/pull/123), never just "#123". This makes messages clickable in Slack.

PRs you create/update are automatically shown as compact #NNN links — no need to repeat them unless adding context.

- GOOD: "Fixed flaky test — race condition in p2p layer. Applied the same pattern from the stdlib fix."
- GOOD: "Reviewed 12 files. Filed 3 issues. Full analysis: <GIST_URL>"
- BAD: Multi-paragraph explanations (use create_gist instead)
- BAD: "Created PR #5678" — not clickable, and PR is already shown

No code blocks, bullet lists, or long text — those belong in a gist.`,
    { message: z.string().describe(`1-3 sentences max. Use full GitHub URLs. Put long analysis in create_gist.`) },
    async (params) => {
      // Unescape literal \n sequences the model sometimes sends
      const message = params.message.replace(/\\n/g, "\n");
      setRespondToUserCalled(true);
      logActivity("response", message);
      addProgress("response", message);
      const results = await updateRootComment(message);
      if (!results.length) results.push("Response recorded");
      return { content: [{ type: "text", text: results.join("\n") }] };
    });

  // ── github_api ─────────────────────────────────────────────────
  server.tool("github_api",
    `GitHub REST API proxy — READ-ONLY. Auth attached automatically.
Use accept='application/vnd.github.v3.diff' for PR diffs.
For writes, use dedicated tools: create_pr, update_pr, create_gist, create_issue, etc.`,
    {
      method: z.enum(["GET"]).describe("Only GET is allowed — use dedicated tools for writes"),
      path: z.string().describe(`API path, e.g. repos/${repo}/pulls/123`),
      accept: z.string().optional().describe("Accept header override"),
    },
    async ({ method, path, accept }) => {
      if (!hasGhToken()) return { content: [{ type: "text", text: "No GitHub access configured" }], isError: true };

      try {
        const result = await getCreds().github.rawGet(repo, path.replace(/^\//, ""), { accept });
        const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
        const maxLen = 100_000;
        return { content: [{ type: "text", text: text.length > maxLen ? text.slice(0, maxLen) + "\n...(truncated)" : text }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: e.message }], isError: true };
      }
    });

  // ── linear_get_issue ───────────────────────────────────────────
  server.tool("linear_get_issue",
    "Fetch a Linear issue by identifier (e.g. UNIFIED-26). Returns title, description, state, assignee, labels, and URL.",
    { identifier: z.string().describe("Issue identifier, e.g. UNIFIED-26 or ENG-1234") },
    async ({ identifier }) => {
      if (!hasLinearToken()) return { content: [{ type: "text", text: "No Linear access configured" }], isError: true };

      try {
        const issue = await getCreds().linear.getIssue(identifier);
        return { content: [{ type: "text", text: JSON.stringify(issue, null, 2) }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Linear API error: ${e.message}` }], isError: true };
      }
    });

  // ── linear_create_issue ────────────────────────────────────────
  server.tool("linear_create_issue",
    "Create a new Linear issue. Returns the issue identifier and URL.",
    {
      team: z.string().describe("Team key: A (Alpha - sequencer/nodes), AVM (Bonobos - AVM), NOIR (Noir compiler), F (Fairies), GK (Gurkhas), CRY (Crypto), TRIAGE, ECODR (Ecosystem/DevRel), TMNT"),
      title: z.string().describe("Issue title"),
      description: z.string().optional().describe("Markdown description"),
      priority: z.number().min(0).max(4).optional().describe("0=none, 1=urgent, 2=high, 3=medium, 4=low"),
    },
    async ({ team, title, description, priority }) => {
      if (!hasLinearToken()) return { content: [{ type: "text", text: "No Linear access configured" }], isError: true };

      try {
        const result = await getCreds().linear.createIssue({ team, title, description, priority });

        const issueLink = `${result.identifier}: ${result.title} — ${result.url}`;
        otherArtifacts.push(`- [${result.identifier}: ${result.title}](${result.url})`);
        logActivity("artifact", issueLink);
        await updateRootComment();

        return { content: [{ type: "text", text: `${result.identifier}: ${result.title}\n${result.url}` }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Linear API error: ${e.message}` }], isError: true };
      }
    });

  // ── ci_failures ──────────────────────────────────────────────────
  server.tool("ci_failures",
    `CI status for a PR. Shows the CI3 workflow status on both the PR branch and merge-queue: last pass, last fail, with GitHub Actions links. CI dashboard link included.`,
    { pr: z.number().describe("PR number") },
    async ({ pr }) => {
      if (!hasGhToken()) return { content: [{ type: "text", text: "No GitHub access configured" }], isError: true };

      const creds = getCreds();
      const ghGet = async (path: string) => creds.github.rawGet(repo, path);

      const fmtRun = (r: any) =>
        `${r.conclusion ?? r.status} | ${r.head_sha?.slice(0, 10)} | ${r.created_at}\n  https://github.com/${repo}/actions/runs/${r.id}`;

      try {
        const prData = await ghGet(`repos/${repo}/pulls/${pr}`);
        const branch = prData.head.ref as string;
        const base = prData.base.ref as string;
        const prUrl = `https://github.com/${repo}/pull/${pr}`;

        const prRuns = await ghGet(`repos/${repo}/actions/workflows/ci3.yml/runs?branch=${encodeURIComponent(branch)}&per_page=20`);
        const prWorkflows: any[] = prRuns.workflow_runs ?? [];
        const prLastPass = prWorkflows.find((r: any) => r.conclusion === "success");
        const prLastFail = prWorkflows.find((r: any) => r.conclusion === "failure");
        const prLatest = prWorkflows[0];

        let mqLastPass: any = null, mqLastFail: any = null, mqLatest: any = null;
        try {
          const mqRuns = await ghGet(`repos/${repo}/actions/workflows/ci3.yml/runs?event=merge_group&per_page=30`);
          const mqForPr = (mqRuns.workflow_runs ?? []).filter((r: any) => r.head_branch?.includes(`pr-${pr}-`));
          mqLatest = mqForPr[0];
          mqLastPass = mqForPr.find((r: any) => r.conclusion === "success");
          mqLastFail = mqForPr.find((r: any) => r.conclusion === "failure");
        } catch {}

        const ciDashboard = SESSION_META.log_url ? `${new URL(SESSION_META.log_url).origin}/section/prs?filter=${encodeURIComponent(branch)}` : "";

        const lines: string[] = [];
        lines.push(`## PR #${pr}: ${prData.title}`, prUrl, `Branch: ${branch} → ${base}`, `CI Dashboard: ${ciDashboard}`, "");
        lines.push("### PR Branch (CI3)");
        if (prLatest) lines.push(`Latest: ${fmtRun(prLatest)}`);
        if (prLastFail && prLastFail !== prLatest) lines.push(`Last fail: ${fmtRun(prLastFail)}`);
        if (prLastPass && prLastPass !== prLatest) lines.push(`Last pass: ${fmtRun(prLastPass)}`);
        if (!prLatest) lines.push("No CI3 runs found");
        lines.push("", "### Merge Queue (CI3)");
        if (mqLatest) lines.push(`Latest: ${fmtRun(mqLatest)}`);
        if (mqLastFail && mqLastFail !== mqLatest) lines.push(`Last fail: ${fmtRun(mqLastFail)}`);
        if (mqLastPass && mqLastPass !== mqLatest) lines.push(`Last pass: ${fmtRun(mqLastPass)}`);
        if (!mqLatest) lines.push("No merge-queue CI3 runs found for this PR");

        return { content: [{ type: "text", text: lines.join("\n") }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: `ci_failures: ${e.message}` }], isError: true };
      }
    });

  // ── record_stat ──────────────────────────────────────────────────
  server.tool("record_stat",
    `Record a structured data point. Appends to /stats/<schema>.jsonl. Auto-adds _ts, _log_id, _worktree_id.\n\nAvailable schemas:\n${schemasPrompt()}`,
    {
      schema: z.string().describe(`Schema name: ${allSchemas().map(s => s.name).join(", ")}`),
      data: z.record(z.any()).describe("Data object matching the schema fields"),
    },
    async ({ schema, data }) => {
      const s = getSchema(schema);
      if (!s) return { content: [{ type: "text", text: `Unknown schema '${schema}'. Available: ${allSchemas().map(s => s.name).join(", ")}` }], isError: true };

      const safeData = Object.fromEntries(Object.entries(data).filter(([k]) => !k.startsWith("_")));
      const entry = {
        _ts: new Date().toISOString(),
        _log_id: SESSION_META.log_id,
        _worktree_id: WORKTREE_ID,
        _user: SESSION_META.user,
        ...safeData,
      };

      try {
        mkdirSync(STATS_DIR, { recursive: true });
        const file = join(STATS_DIR, `${schema}.jsonl`);
        appendFileSync(file, JSON.stringify(entry) + "\n");
        return { content: [{ type: "text", text: `Recorded ${schema} entry (${Object.keys(data).length} fields)` }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: `Failed to write stat: ${e.message}` }], isError: true };
      }
    });

  // ── create_gist / update_gist ───────────────────────────────────
  // Track the session gist — only one create_gist per session, then use update_gist.
  let sessionGistId = "";
  let sessionGistUrl = "";

  server.tool("create_gist",
    `Create a GitHub gist. One per session — use update_gist to add files after. Prefer write_log for build output.`,
    {
      description: z.string().describe("Short description of the gist"),
      files: z.record(z.string()).describe("Map of filename → content, e.g. {\"output.log\": \"...\", \"analysis.md\": \"...\"}"),
    },
    async ({ description, files }) => {
      if (!hasGhToken()) return { content: [{ type: "text", text: "No GitHub access configured" }], isError: true };
      if (sessionGistId) {
        return { content: [{ type: "text", text: `A gist was already created this session: ${sessionGistUrl}\nUse update_gist(gist_id="${sessionGistId}", ...) to add or update files instead of creating another gist.` }], isError: true };
      }

      // Unescape literal \n sequences the model sometimes sends
      const gistFiles: Record<string, { content: string }> = {};
      for (const [name, content] of Object.entries(files)) {
        gistFiles[name] = { content: content.replace(/\\n/g, "\n") };
      }

      try {
        const gist = await getCreds().github.createGist({ description, files: gistFiles });
        sessionGistId = gist.id;
        sessionGistUrl = gist.html_url;
        logActivity("artifact", `Gist: ${gist.html_url}`);
        otherArtifacts.push(`- [Gist: ${description}](${gist.html_url})`);
        await updateRootComment();
        return { content: [{ type: "text", text: `${gist.html_url}\nID: ${gist.id}` }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: `create_gist: ${e.message}` }], isError: true };
      }
    });

  server.tool("update_gist",
    `Update an existing gist — add new files, replace file content, or update the description. Use read_gist first to see existing files if needed.`,
    {
      gist_id: z.string().describe("Gist ID (from create_gist result or read_gist)"),
      description: z.string().optional().describe("New description (optional)"),
      files: z.record(z.string()).describe("Map of filename → new content. New filenames add files, existing filenames replace content."),
    },
    async ({ gist_id, description, files }) => {
      if (!hasGhToken()) return { content: [{ type: "text", text: "No GitHub access configured" }], isError: true };

      // Unescape literal \n sequences the model sometimes sends
      const gistFiles: Record<string, { content: string }> = {};
      for (const [name, content] of Object.entries(files)) {
        gistFiles[name] = { content: content.replace(/\\n/g, "\n") };
      }

      try {
        const gist = await getCreds().github.updateGist(gist_id, { description, files: gistFiles });
        return { content: [{ type: "text", text: `Updated: ${gist.html_url}\nFiles: ${Object.keys(files).join(", ")}` }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: `update_gist: ${e.message}` }], isError: true };
      }
    });
}
