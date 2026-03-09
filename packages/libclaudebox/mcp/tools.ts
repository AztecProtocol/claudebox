/**
 * Common MCP tool registrar — shared tools for all profile sidecars.
 *
 * Registers: get_context, session_status, set_workspace_name, set_tag,
 * respond_to_user, github_api, slack_api, linear_get_issue, linear_create_issue,
 * ci_failures, record_stat, create_gist, create_skill.
 */

import { existsSync, writeFileSync, appendFileSync, mkdirSync } from "fs";
import { join } from "path";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";
import { z } from "zod";

import { getSchema, allSchemas, schemasPrompt } from "../stat-schemas.ts";
import { SESSION_META, QUIET_MODE, CI_ALLOW, STATS_DIR, WORKTREE_ID } from "./env.ts";
import {
  logActivity, addProgress, addTrackedPR, updateRootComment,
  otherArtifacts, truncateForSlack,
  respondToUserCalled, setRespondToUserCalled,
} from "./activity.ts";
import { getCreds, _hasGhToken, _hasSlackToken, _hasLinearToken, git, sanitizeError, SLACK_WHITELIST } from "./helpers.ts";
import { pushToRemote } from "./git-tools.ts";

// ── Workspace name (shared state for branch naming) ─────────────
export let workspaceName = "";

export interface ProfileOpts {
  repo: string;
  workspace: string;
  tools: string;
  ghWhitelist?: Array<{ method: string; pattern: RegExp }>;
}

export function registerCommonTools(server: McpServer, opts: ProfileOpts): void {
  const { repo, tools } = opts;

  // ── get_context ────────────────────────────────────────────────
  server.tool("get_context", "Session metadata: user, repo, log_url, trigger source, git ref, available tools.", {},
    async () => {
      const ctx: Record<string, string> = {};
      for (const [k, v] of Object.entries(SESSION_META)) {
        if (v) ctx[k] = v;
      }
      ctx.tools = tools;
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
      return { content: [{ type: "text", text: results.length ? results.join("\n") : "No channels configured" }] };
    });

  // ── set_workspace_name ─────────────────────────────────────────
  server.tool("set_workspace_name",
    `Set a short, descriptive name for this workspace. Call this early (right after cloning).
The name should be a concise slug describing the task (2-5 words, lowercase, hyphens).
Examples: "fix-flaky-p2p-test", "audit-polynomial-commitment", "add-g0-flag"
The name is used as the git branch name and appears in the dashboard and Slack.`,
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

  // ── respond_to_user ───────────────────────────────────────────
  server.tool("respond_to_user",
    `Send your final response to the user. Updates the Slack message inline. You MUST call this before ending.

Your response appears directly in Slack (not quoted). Keep it concise but informative — a few sentences is fine. For detailed analysis, print to stdout and link to the log.

ALWAYS reference PRs and issues as full GitHub links (https://github.com/${repo}/pull/123), never just "#123". This makes messages clickable in Slack.

PRs you create/update are automatically shown as compact #NNN links — no need to repeat them unless adding context.

- GOOD: "Fixed flaky test — race condition in p2p layer. Applied the same pattern from the stdlib fix."
- GOOD: "Found 3 PRs needing manual backport — <LOG_URL|see full analysis>"
- BAD: "Created PR #5678" — not clickable, and PR is already shown

Avoid code blocks and long bullet lists — those belong in the log.`,
    { message: z.string().describe(`Concise response. Use full GitHub URLs for PRs/issues (https://github.com/${repo}/pull/123), not #123.`) },
    async ({ message }) => {
      setRespondToUserCalled(true);
      logActivity("response", message);
      addProgress("response", message);
      const results = await updateRootComment(message);
      if (!results.length) results.push("No channels configured — message printed to log only");
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
      if (!_hasGhToken()) return { content: [{ type: "text", text: "No GitHub access configured" }], isError: true };

      try {
        const result = await getCreds().github.rawGet(repo, path.replace(/^\//, ""), { accept });
        const text = typeof result === "string" ? result : JSON.stringify(result, null, 2);
        const maxLen = 100_000;
        return { content: [{ type: "text", text: text.length > maxLen ? text.slice(0, maxLen) + "\n...(truncated)" : text }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: e.message }], isError: true };
      }
    });

  // ── slack_api ──────────────────────────────────────────────────
  server.tool("slack_api",
    `Slack Web API proxy (thread-scoped). Whitelisted: ${[...SLACK_WHITELIST].join(", ")}.
Channel and thread are locked to this session — you can only read/write your own thread.`,
    {
      method: z.string().describe("e.g. chat.postMessage"),
      args: z.record(z.any()).describe("Method arguments"),
    },
    async ({ method, args }) => {
      if (QUIET_MODE && method === "chat.postMessage")
        return { content: [{ type: "text", text: "Quiet mode active — use respond_to_user to send your response" }], isError: true };
      if (!_hasSlackToken()) return { content: [{ type: "text", text: "No Slack access configured" }], isError: true };

      const payload = { ...args };

      if (method !== "users.list") {
        if (!SESSION_META.slack_channel)
          return { content: [{ type: "text", text: "No Slack channel configured for this session" }], isError: true };
        payload.channel = SESSION_META.slack_channel;
      }
      if (method === "chat.postMessage") {
        if (!SESSION_META.slack_thread_ts)
          return { content: [{ type: "text", text: "No Slack thread configured — use respond_to_user instead" }], isError: true };
        payload.thread_ts = SESSION_META.slack_thread_ts;
      }
      if (method === "chat.update") {
        if (!SESSION_META.slack_message_ts)
          return { content: [{ type: "text", text: "No Slack message to update" }], isError: true };
        payload.ts = SESSION_META.slack_message_ts;
      }
      if (method === "conversations.replies") {
        if (!SESSION_META.slack_thread_ts)
          return { content: [{ type: "text", text: "No Slack thread configured for this session" }], isError: true };
        payload.ts = SESSION_META.slack_thread_ts;
      }

      try {
        const slack = getCreds().slack;
        let d: any;
        switch (method) {
          case "chat.postMessage": d = await slack.postMessage(payload.text, { channel: payload.channel, threadTs: payload.thread_ts }); break;
          case "chat.update": d = await slack.updateMessage(payload.text, { channel: payload.channel, ts: payload.ts }); break;
          case "reactions.add": d = await slack.addReaction(payload.name, { channel: payload.channel, timestamp: payload.timestamp }); break;
          case "reactions.remove": d = await slack.removeReaction(payload.name, { channel: payload.channel, timestamp: payload.timestamp }); break;
          case "conversations.replies": d = await slack.getThreadReplies({ channel: payload.channel, ts: payload.ts, limit: payload.limit }); break;
          case "users.list": d = await slack.listUsers(payload.limit); break;
          default: return { content: [{ type: "text", text: `Unknown method: ${method}` }], isError: true };
        }
        if (!d?.ok) {
          const hints: Record<string, string> = {
            not_in_channel: " (bot not invited to this channel — use your session's own channel instead)",
            missing_scope: ` (need: ${d?.needed || "unknown"}, have: ${d?.provided || "unknown"})`,
            channel_not_found: " (channel ID may be wrong — check get_context for your session's channel)",
          };
          return { content: [{ type: "text", text: `${method}: ${d?.error}${hints[d?.error] || ""}` }], isError: true };
        }
        if (method === "conversations.replies") {
          const text = JSON.stringify(d, null, 2);
          const maxLen = 50_000;
          return { content: [{ type: "text", text: text.length > maxLen ? text.slice(0, maxLen) + "\n...(truncated)" : text }] };
        }
        return { content: [{ type: "text", text: `OK${d.ts ? ` (ts: ${d.ts})` : ""}` }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: e.message }], isError: true };
      }
    });

  // ── linear_get_issue ───────────────────────────────────────────
  server.tool("linear_get_issue",
    "Fetch a Linear issue by identifier (e.g. UNIFIED-26). Returns title, description, state, assignee, labels, and URL.",
    { identifier: z.string().describe("Issue identifier, e.g. UNIFIED-26 or ENG-1234") },
    async ({ identifier }) => {
      if (!_hasLinearToken()) return { content: [{ type: "text", text: "No Linear access configured" }], isError: true };

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
      if (!_hasLinearToken()) return { content: [{ type: "text", text: "No Linear access configured" }], isError: true };

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
      if (!_hasGhToken()) return { content: [{ type: "text", text: "No GitHub access configured" }], isError: true };

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

  // ── create_gist ──────────────────────────────────────────────────
  server.tool("create_gist",
    "Create a GitHub gist. Useful for sharing verbose output, logs, or large data that doesn't belong in a Slack message or PR description.",
    {
      description: z.string().describe("Short description of the gist"),
      files: z.record(z.string()).describe("Map of filename → content, e.g. {\"output.log\": \"...\", \"analysis.md\": \"...\"}"),
      public_gist: z.boolean().default(false).describe("Whether the gist is public (default: false/secret)"),
    },
    async ({ description, files, public_gist }) => {
      if (!_hasGhToken()) return { content: [{ type: "text", text: "No GitHub access configured" }], isError: true };

      const gistFiles: Record<string, { content: string }> = {};
      for (const [name, content] of Object.entries(files)) {
        gistFiles[name] = { content };
      }

      try {
        const gist = await getCreds().github.createGist({ description, files: gistFiles, public: public_gist });
        logActivity("artifact", `Gist: ${gist.html_url}`);
        otherArtifacts.push(`- [Gist: ${description}](${gist.html_url})`);
        await updateRootComment();
        return { content: [{ type: "text", text: `${gist.html_url}\nID: ${gist.id}` }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: `create_gist: ${e.message}` }], isError: true };
      }
    });

  // ── create_skill ──────────────────────────────────────────────
  server.tool("create_skill",
    `Create or update a Claude Code skill and open a draft PR for review.

A skill is a reusable prompt that Claude Code users invoke with /<name>. Skills have YAML frontmatter and a markdown body.

Example:
  name: "review-pr"
  description: "Review a PR for correctness, style, and security"
  argument_hint: "<PR number>"
  body: "# Review PR\\n\\n## Steps\\n1. Fetch the PR diff...\\n2. Check for..."

The body should be detailed, step-by-step instructions that Claude follows when the skill is invoked.
Creates a draft PR on a skill/<name> branch for human review.`,
    {
      name: z.string().regex(/^[a-z0-9-]+$/).describe("Skill name (lowercase, hyphens only). Used as /<name> command."),
      description: z.string().describe("One-line description shown in skill listings"),
      argument_hint: z.string().optional().describe("Hint for arguments, e.g. '<PR number>' or '<url-or-hash>'"),
      body: z.string().describe("Markdown body with detailed instructions for Claude to follow"),
      base: z.string().optional().describe("Base branch for the PR (defaults to current branch)"),
    },
    async ({ name, description, argument_hint, body, base }) => {
      if (!_hasGhToken()) return { content: [{ type: "text", text: "No GitHub access configured" }], isError: true };

      const workspace = (opts as any).workspace || "/workspace";
      const skillDir = join(workspace, ".claude", "claudebox", "skills", name);
      const skillFile = join(skillDir, "SKILL.md");

      let frontmatter = `---\nname: ${name}\ndescription: ${description}\n`;
      if (argument_hint) frontmatter += `argument-hint: ${argument_hint}\n`;
      frontmatter += `---\n\n`;

      const content = frontmatter + body;
      const action = existsSync(skillFile) ? "Updated" : "Created";

      try {
        mkdirSync(skillDir, { recursive: true });
        writeFileSync(skillFile, content);

        const branch = `skill/${name}`;
        const currentBranch = git(workspace, "rev-parse", "--abbrev-ref", "HEAD").trim();
        const prBase = base || currentBranch || SESSION_META.base_branch || "next";

        git(workspace, "checkout", "-B", branch);
        git(workspace, "add", skillFile);
        git(workspace, "commit", "-m", `chore: ${action.toLowerCase()} skill /${name}`);
        await pushToRemote(workspace, repo, branch, true);

        try { git(workspace, "checkout", currentBranch); } catch {}

        try {
          const pr = await getCreds().github.createPull(repo, {
            title: `skill: ${action.toLowerCase()} /${name} — ${description}`,
            base: prBase,
            head: branch,
            body: `## Skill: \`/${name}\`\n\n${description}\n\n${SESSION_META.log_url ? `Session log: ${SESSION_META.log_url}` : ""}`,
          });

          addTrackedPR(pr.number, `skill /${name}`, pr.html_url, "created");
          logActivity("artifact", `Skill PR [/${name} #${pr.number}](${pr.html_url})`);
          await updateRootComment();
          return { content: [{ type: "text", text: `${action} skill /${name} — PR ${pr.html_url}` }] };
        } catch (prErr: any) {
          logActivity("artifact", `${action} skill /${name} on branch ${branch} (PR failed: ${prErr.message})`);
          await updateRootComment();
          return { content: [{ type: "text", text: `${action} skill /${name} — pushed to ${branch} but PR creation failed: ${prErr.message}` }] };
        }
      } catch (e: any) {
        return { content: [{ type: "text", text: `create_skill: ${e.message}` }], isError: true };
      }
    });
}
