#!/usr/bin/env -S node --experimental-strip-types --no-warnings
/**
 * ClaudeBox Barretenberg Audit Profile Sidecar
 *
 * Repo: AztecProtocol/barretenberg-claude (private fork)
 * Clone strategy: remote authenticated URL (no local reference)
 * Docker proxy: disabled
 * Extra tools: create_issue, close_issue, create_audit_label, add_log_link, self_assess
 */

import { mkdirSync, appendFileSync, readFileSync, existsSync } from "fs";
import { join } from "path";
import { z } from "zod";
import { McpServer } from "@modelcontextprotocol/sdk/server/mcp.js";

import { SESSION_META, WORKTREE_ID, statusPageUrl, STATS_DIR, hasScope } from "../../packages/libclaudebox/mcp/env.ts";
import { logActivity, updateRootComment, otherArtifacts } from "../../packages/libclaudebox/mcp/activity.ts";
import { getCreds, sanitizeError } from "../../packages/libclaudebox/mcp/helpers.ts";
import { registerCommonTools } from "../../packages/libclaudebox/mcp/tools.ts";
import { pushToRemote, registerCloneRepo, registerPRTools } from "../../packages/libclaudebox/mcp/git-tools.ts";
import { startMcpHttpServer } from "../../packages/libclaudebox/mcp/server.ts";

// ── Profile config ──────────────────────────────────────────────
const REPO = "AztecProtocol/barretenberg-claude";
const WORKSPACE = "/workspace/barretenberg-claude";

SESSION_META.repo = REPO;

const UPSTREAM_REPO = "AztecProtocol/barretenberg";

const TOOL_LIST = "clone_repo, respond_to_user, get_context, session_status, github_api, slack_api, create_pr, update_pr, create_external_pr, create_issue, close_issue, add_labels, create_audit_label, add_log_link, self_assess, audit_history, create_gist, list_gists, read_gist, update_meta_issue, create_skill, ci_failures, linear_get_issue, linear_create_issue, record_stat";

// ── Auth check at startup ───────────────────────────────────────
try {
  const creds = getCreds();
  await creds.github.rawGet(REPO, `repos/${REPO}`);
  console.log(`[AUDIT] Verified access to ${REPO}`);
} catch (e: any) {
  console.error(`[FATAL] Cannot access ${REPO}: ${e.message}`);
  process.exit(1);
}

// ── MCP Server factory ──────────────────────────────────────────

function createServer(): McpServer {
  const server = new McpServer({ name: "claudebox-audit", version: "1.0.0" });

  registerCommonTools(server, { repo: REPO, workspace: WORKSPACE, tools: TOOL_LIST });

  registerCloneRepo(server, {
    repo: REPO, workspace: WORKSPACE,
    strategy: "authenticated-url",
    fallbackRef: "origin/master",
    refHint: "'origin/main', 'abc123'",
    description: "Clone the barretenberg-claude repo (private). Uses authenticated URL. Safe to call on resume — fetches new refs. Call FIRST before doing any work.",
    skipSubmodules: true,
  });

  registerPRTools(server, {
    repo: REPO, workspace: WORKSPACE,
    branchPrefix: "audit/", defaultBase: "master",
  });

  // ── Helpers ─────────────────────────────────────────────────────

  function recordArtifact(artifact_type: string, artifact_url: string, artifact_id: string, quality_dimension: string, severity: string, modules: string[], title: string) {
    try {
      mkdirSync(STATS_DIR, { recursive: true });
      appendFileSync(join(STATS_DIR, "audit_artifact.jsonl"), JSON.stringify({
        _ts: new Date().toISOString(),
        _log_id: SESSION_META.log_id,
        _worktree_id: WORKTREE_ID,
        _user: SESSION_META.user,
        artifact_type, artifact_url, artifact_id, quality_dimension, severity, modules, title,
      }) + "\n");
    } catch {}
  }

  // ── create_issue — audit-only ─────────────────────────────────
  server.tool("create_issue",
    "Create a GitHub issue on barretenberg-claude for audit findings.",
    {
      title: z.string().describe("Issue title — short summary of the finding"),
      body: z.string().describe("Issue body (Markdown) — detailed description, affected code, severity, reproduction steps"),
      labels: z.array(z.string()).optional().describe("Labels, e.g. ['security', 'high-severity']"),
      quality_dimension: z.enum(["code", "crypto", "test", "crypto-2nd-pass"]).default("code").describe("Quality axis: code (implementation), crypto (mathematical/cryptographic), test (test quality), crypto-2nd-pass (independent re-review — only if a DIFFERENT session already reviewed this file under 'crypto')"),
      severity: z.enum(["critical", "high", "medium", "low", "info"]).default("medium").describe("Finding severity"),
      modules: z.array(z.string()).optional().describe("Affected barretenberg modules, e.g. ['ecc', 'crypto']"),
    },
    async ({ title, body, labels, quality_dimension, severity, modules }) => {
      try {
        const creds = getCreds();
        const issue = await creds.github.createIssue(REPO, { title, body, labels: labels || [] });

        otherArtifacts.push(`- [Issue #${issue.number}: ${title}](${issue.html_url})`);
        logActivity("artifact", `Issue #${issue.number}: ${title} — ${issue.html_url}`);
        await updateRootComment();

        recordArtifact("issue", issue.html_url, String(issue.number), quality_dimension, severity, modules || [], title);

        return { content: [{ type: "text", text: `${issue.html_url}\n#${issue.number}` }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: `create_issue: ${sanitizeError(e.message)}` }], isError: true };
      }
    });

  // ── close_issue — audit-only ─────────────────────────────────
  server.tool("close_issue",
    "Close a GitHub issue on barretenberg-claude. Posts a tracking comment with session log link before closing.",
    {
      issue_number: z.number().describe("Issue number to close"),
      reason: z.string().describe("Why the issue is being closed (e.g. 'fixed in PR #5', 'not a real vulnerability', 'duplicate of #3')"),
    },
    async ({ issue_number, reason }) => {
      try {
        const creds = getCreds();

        const issue = await creds.github.getIssue(REPO, issue_number);

        const logLine = SESSION_META.log_url ? `Log: ${SESSION_META.log_url}` : "";
        const statusLine = statusPageUrl ? `Status: ${statusPageUrl}` : "";
        const commentBody = [
          `**Closed by ClaudeBox** — ${reason}`,
          "",
          `Session: ${SESSION_META.user || "unknown"}`,
          logLine,
          statusLine,
        ].filter(Boolean).join("\n");

        await creds.github.addIssueComment(REPO, issue_number, commentBody);
        await creds.github.updateIssue(REPO, issue_number, { state: "closed" });

        logActivity("artifact", `Closed issue #${issue_number}: ${issue.title} — ${issue.html_url}`);
        await updateRootComment();

        return { content: [{ type: "text", text: `Closed #${issue_number}: ${issue.title}\n${issue.html_url}` }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: `close_issue: ${sanitizeError(e.message)}` }], isError: true };
      }
    });

  // ── add_labels — add labels to an issue or PR ──────────────────
  server.tool("add_labels",
    "Add labels to a GitHub issue or pull request on barretenberg-claude.",
    {
      issue_number: z.number().describe("Issue or PR number"),
      labels: z.array(z.string()).describe("Labels to add, e.g. ['merge-to-aztec-packages', 'security']"),
    },
    async ({ issue_number, labels }) => {
      try {
        const result = await getCreds().github.addLabels(REPO, issue_number, labels);
        const applied = result.map((l: any) => l.name).join(", ");
        return { content: [{ type: "text", text: `Labels on #${issue_number}: ${applied}` }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: `add_labels: ${sanitizeError(e.message)}` }], isError: true };
      }
    });

  // ── create_audit_label — create scope label + commit prompt file ─
  server.tool("create_audit_label",
    `Create a new audit scope label on barretenberg-claude AND commit a prompt file to claudebox/prompts/.
The label will be named "scope/<slug>" and the prompt file will be committed directly to the repo's default branch.
Use this when you discover a new area worth dedicated audit attention.`,
    {
      slug: z.string().describe("Label slug (becomes scope/<slug>), e.g. 'kzg-commitment', 'field-arithmetic'"),
      description: z.string().describe("Human-readable description of what this scope covers"),
      color: z.string().default("d93f0b").describe("Label color hex (6 chars, no #)"),
      prompt: z.string().describe("Full markdown prompt content — audit instructions for this scope"),
      modules: z.array(z.string()).describe("Source paths this scope covers, e.g. ['barretenberg/cpp/src/barretenberg/ecc']"),
    },
    async ({ slug, description, color, prompt, modules }) => {
      const creds = getCreds();
      const results: string[] = [];

      try {
        const labelName = `scope/${slug}`;
        try {
          await creds.github.createLabel(REPO, { name: labelName, color, description });
          results.push(`Label created: ${labelName}`);
        } catch (e: any) {
          if (e.message?.includes("already_exists") || e.message?.includes("422")) {
            results.push(`Label already exists: ${labelName}`);
          } else {
            return { content: [{ type: "text", text: `Label creation failed: ${sanitizeError(e.message)}` }], isError: true };
          }
        }

        const filePath = `claudebox/prompts/${slug}.md`;
        let sha: string | undefined;
        try {
          const existing = await creds.github.getContents(REPO, filePath);
          sha = existing.sha;
        } catch {}

        await creds.github.putContents(REPO, filePath, {
          message: `audit: add scope prompt for ${labelName}`,
          content: prompt,
          ...(sha ? { sha } : {}),
        });
        results.push(`Committed: ${filePath}`);

        const labelsJsonPath = "claudebox/labels.json";
        let labelsJson: any = { labels: [], meta_labels: [], area_labels: [] };
        let labelsJsonSha: string | undefined;
        try {
          const ljData = await creds.github.getContents(REPO, labelsJsonPath);
          labelsJsonSha = ljData.sha;
          try { labelsJson = JSON.parse(Buffer.from(ljData.content, "base64").toString()); } catch {}
        } catch {}

        const existingIdx = labelsJson.labels?.findIndex((l: any) => l.name === labelName);
        const entry = { name: labelName, color, description, prompt_file: `prompts/${slug}.md`, modules };
        if (existingIdx >= 0) labelsJson.labels[existingIdx] = entry;
        else (labelsJson.labels ??= []).push(entry);

        try {
          await creds.github.putContents(REPO, labelsJsonPath, {
            message: `audit: update labels.json for ${labelName}`,
            content: JSON.stringify(labelsJson, null, 2),
            ...(labelsJsonSha ? { sha: labelsJsonSha } : {}),
          });
          results.push("Updated labels.json");
        } catch {}

        logActivity("artifact", `Created audit label: ${labelName}`);
        await updateRootComment();

        return { content: [{ type: "text", text: results.join("\n") }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: `create_audit_label: ${sanitizeError(e.message)}` }], isError: true };
      }
    });

  // ── add_log_link — cross-reference session on an issue ──────────
  server.tool("add_log_link",
    "Add a cross-reference comment to an issue linking it to the current session's log. Use this to build an audit trail connecting issues to the sessions that investigated them.",
    {
      issue_number: z.number().describe("Issue number to link"),
      context: z.string().describe("What this session did related to this issue (1-2 sentences)"),
    },
    async ({ issue_number, context }) => {
      try {
        const body = [
          `**Session cross-reference**`,
          ``,
          context,
          ``,
          `- Log: ${SESSION_META.log_url || "n/a"}`,
          `- Status: ${statusPageUrl || "n/a"}`,
          `- Session: \`${SESSION_META.log_id || WORKTREE_ID}\``,
        ].join("\n");

        await getCreds().github.addIssueComment(REPO, issue_number, body);

        logActivity("artifact", `Cross-ref #${issue_number}: ${context}`);
        await updateRootComment();
        return { content: [{ type: "text", text: `Linked session to #${issue_number}` }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: `add_log_link: ${sanitizeError(e.message)}` }], isError: true };
      }
    });

  // ── self_assess — session self-assessment ────────────────────────
  server.tool("self_assess",
    `Rate your own audit session. Call this BEFORE respond_to_user.
Be honest about your assessment:
- critical = found security-relevant issues
- thorough = deep line-by-line review, no critical issues found
- surface = quick scan, identified areas for deeper review
- incomplete = could not finish due to complexity or missing context

Also rate each quality dimension you covered:
- code = implementation correctness (UB, memory safety, API design)
- crypto = cryptographic correctness (math, protocol security, side-channels)
- test = test adequacy (coverage, edge cases, assertions)`,
    {
      rating: z.enum(["critical", "thorough", "surface", "incomplete"]).describe("Self-assessment rating"),
      modules_reviewed: z.array(z.string()).describe("Source paths reviewed, e.g. ['barretenberg/cpp/src/barretenberg/ecc/curves']"),
      findings_count: z.number().describe("Number of issues filed this session"),
      questions_count: z.number().describe("Number of question issues posted this session"),
      confidence: z.number().min(0).max(1).describe("Confidence in the review (0 = guessing, 1 = certain)"),
      summary: z.string().describe("2-3 sentence summary of what was covered and key findings"),
      code_rating: z.enum(["thorough", "surface", "none"]).default("none").describe("Code quality review depth"),
      crypto_rating: z.enum(["thorough", "surface", "none"]).default("none").describe("Crypto quality review depth"),
      test_rating: z.enum(["thorough", "surface", "none"]).default("none").describe("Test quality review depth"),
    },
    async ({ rating, modules_reviewed, findings_count, questions_count, confidence, summary, code_rating, crypto_rating, test_rating }) => {
      try {
        const entry = {
          _ts: new Date().toISOString(),
          _log_id: SESSION_META.log_id,
          _worktree_id: WORKTREE_ID,
          _user: SESSION_META.user,
          rating, modules_reviewed, findings_count, questions_count, confidence, summary,
          code_rating, crypto_rating, test_rating,
        };

        mkdirSync(STATS_DIR, { recursive: true });
        appendFileSync(join(STATS_DIR, "audit_assessment.jsonl"), JSON.stringify(entry) + "\n");

        const dims = [code_rating !== "none" ? `code:${code_rating}` : "", crypto_rating !== "none" ? `crypto:${crypto_rating}` : "", test_rating !== "none" ? `test:${test_rating}` : ""].filter(Boolean).join(", ");
        logActivity("status", `Assessment: ${rating.toUpperCase()} (${Math.round(confidence * 100)}% confidence) [${dims}] — ${summary}`);
        await updateRootComment();

        return { content: [{ type: "text", text: `Assessment recorded: ${rating} (${modules_reviewed.length} modules, ${findings_count} findings, ${questions_count} questions) [${dims}]` }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: `self_assess: ${sanitizeError(e.message)}` }], isError: true };
      }
    });

  // ── audit_history — read prior audit stats for continuity ───────
  server.tool("audit_history",
    `Get a summary of prior audit work: module coverage by quality dimension, recent sessions, and artifacts.
Call this EARLY in your session to understand what has been reviewed and where to focus.

Quality dimensions: code, crypto, test, crypto-2nd-pass.
crypto-2nd-pass is ONLY valid when a DIFFERENT session already reviewed the file under 'crypto'. It provides independent verification of cryptographic correctness.`,
    {},
    async () => {
      const lines: string[] = [];

      function readJsonl(filename: string): any[] {
        const f = join(STATS_DIR, filename);
        if (!existsSync(f)) return [];
        const entries: any[] = [];
        readFileSync(f, "utf-8").split("\n").filter(l => l.trim()).forEach(l => {
          try { entries.push(JSON.parse(l)); } catch {}
        });
        return entries;
      }

      const reviews = readJsonl("audit_file_review.jsonl");
      const assessments = readJsonl("audit_assessment.jsonl");
      const summaries = readJsonl("audit_summary.jsonl");
      const artifacts = readJsonl("audit_artifact.jsonl");

      const depthOrder: Record<string, number> = { cursory: 0, "line-by-line": 1, deep: 2 };
      const dims = ["code", "crypto", "test", "crypto-2nd-pass"] as const;
      const byFileDim = new Map<string, any>();
      for (const r of reviews) {
        const dim = r.quality_dimension || "code";
        const key = `${r.file_path}::${dim}`;
        const existing = byFileDim.get(key);
        if (!existing || (depthOrder[r.review_depth] ?? 0) > (depthOrder[existing.review_depth] ?? 0)) {
          byFileDim.set(key, { ...r, quality_dimension: dim });
        }
      }

      type DimStats = { files: any[], issues: number };
      const byModule = new Map<string, Record<string, DimStats>>();
      for (const r of byFileDim.values()) {
        const mod = r.module || "unknown";
        const dim = r.quality_dimension || "code";
        if (!byModule.has(mod)) byModule.set(mod, {});
        const modData = byModule.get(mod)!;
        if (!modData[dim]) modData[dim] = { files: [], issues: 0 };
        modData[dim].files.push(r);
        modData[dim].issues += r.issues_found || 0;
      }

      const uniqueFiles = new Set<string>();
      for (const r of byFileDim.values()) uniqueFiles.add(r.file_path);

      lines.push(`# Audit History`);
      lines.push(`Total: ${uniqueFiles.size} unique files, ${assessments.length} sessions, ${artifacts.filter(a => a.artifact_type === "issue").length} issues filed`);
      lines.push(``);

      lines.push(`## Module Coverage`);
      const sortedMods = [...byModule.entries()].sort((a, b) => {
        const aTotal = Object.values(a[1]).reduce((s, d) => s + d.files.length, 0);
        const bTotal = Object.values(b[1]).reduce((s, d) => s + d.files.length, 0);
        return bTotal - aTotal;
      });
      for (const [mod, dimData] of sortedMods) {
        const totalIssues = Object.values(dimData).reduce((s, d) => s + d.issues, 0);
        const dimParts: string[] = [];
        for (const dim of dims) {
          const d = dimData[dim];
          if (!d) continue;
          dimParts.push(`${dim}:${d.files.length}`);
        }
        lines.push(`- **${mod}** — ${dimParts.join(", ")}${totalIssues ? ` (${totalIssues} issues)` : ""}`);
      }
      lines.push(``);

      const cryptoReviewed = new Map<string, Set<string>>();
      for (const r of reviews) {
        if ((r.quality_dimension || "code") === "crypto") {
          const sessions = cryptoReviewed.get(r.file_path) || new Set();
          sessions.add(r._log_id || r._worktree_id || "unknown");
          cryptoReviewed.set(r.file_path, sessions);
        }
      }
      const eligibleFor2ndPass = [...cryptoReviewed.entries()]
        .filter(([_, sessions]) => sessions.size > 0)
        .filter(([fp]) => !byFileDim.has(`${fp}::crypto-2nd-pass`))
        .map(([fp]) => fp);
      if (eligibleFor2ndPass.length) {
        lines.push(`## Eligible for crypto-2nd-pass (${eligibleFor2ndPass.length} files)`);
        lines.push(`These files have had crypto review and are eligible for independent re-review:`);
        for (const fp of eligibleFor2ndPass.slice(0, 30)) lines.push(`- \`${fp}\``);
        if (eligibleFor2ndPass.length > 30) lines.push(`  ... and ${eligibleFor2ndPass.length - 30} more`);
        lines.push(``);
      }

      if (assessments.length) {
        const recent = assessments.slice().reverse().slice(0, 5);
        lines.push(`## Recent Sessions (last ${recent.length} of ${assessments.length})`);
        for (const a of recent) {
          const date = a._ts ? new Date(a._ts).toISOString().slice(0, 10) : "?";
          const dimRatings = [a.code_rating && a.code_rating !== "none" ? `code:${a.code_rating}` : "", a.crypto_rating && a.crypto_rating !== "none" ? `crypto:${a.crypto_rating}` : "", a.test_rating && a.test_rating !== "none" ? `test:${a.test_rating}` : ""].filter(Boolean).join(", ");
          lines.push(`- [${date}] **${a.rating}** ${dimRatings ? `[${dimRatings}]` : ""} — ${a.summary || "no summary"}`);
        }
        lines.push(``);
      }

      if (summaries.length) {
        const recent = summaries.slice().reverse().slice(0, 3);
        lines.push(`## Recent Summary Gists (last ${recent.length} of ${summaries.length})`);
        for (const s of recent) lines.push(`- ${s.summary || "no summary"}${s.gist_url ? ` — ${s.gist_url}` : ""}`);
        lines.push(``);
      }

      if (!reviews.length && !assessments.length) {
        lines.push(`No prior audit data found. This appears to be the first session.`);
      }

      return { content: [{ type: "text", text: lines.join("\n") }] };
    });

  // ── list_gists ─────────────────────────────────────────────────
  server.tool("list_gists",
    "List all gists created by the audit bot.",
    {
      per_page: z.number().default(100).describe("Results per page (max 100)"),
      page: z.number().default(1).describe("Page number"),
    },
    async ({ per_page, page }) => {
      try {
        const gists = await getCreds().github.listGists({ per_page: String(per_page), page: String(page) });
        const lines = gists.map((g: any) => {
          const files = Object.keys(g.files || {}).join(", ");
          return `- [${g.description || "(no description)"}](${g.html_url}) — ${files} (${g.created_at})`;
        });
        if (!lines.length) return { content: [{ type: "text", text: "No gists found." }] };
        return { content: [{ type: "text", text: `**${gists.length} gists** (page ${page}):\n\n${lines.join("\n")}` }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: `list_gists: ${e.message}` }], isError: true };
      }
    });

  // ── read_gist ──────────────────────────────────────────────────
  server.tool("read_gist",
    "Read the full content of a gist by ID or URL.",
    { gist: z.string().describe("Gist ID (hex string) or full gist URL") },
    async ({ gist }) => {
      const id = gist.replace(/.*\/([a-f0-9]+)$/, "$1");
      try {
        const g = await getCreds().github.getGist(id);
        const parts = [`# ${g.description || "(no description)"}\n`];
        for (const [name, file] of Object.entries(g.files || {})) {
          const f = file as any;
          parts.push(`## ${name}\n\`\`\`\n${f.content || ""}\n\`\`\``);
        }
        return { content: [{ type: "text", text: parts.join("\n\n") }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: `read_gist: ${e.message}` }], isError: true };
      }
    });

  // ── update_meta_issue ──────────────────────────────────────────
  server.tool("update_meta_issue",
    `Create or update an audit tracking meta-issue. The body you provide is used verbatim — you compose the full markdown.

Two scopes:
- **session**: Tracks THIS session's work. Label: meta/session/<id>.
- **module**: Cross-session tracker for a module. Label: meta/module/<name>. Updated incrementally.

For module meta-issues: read the existing issue body first (via github_api), merge your new findings, then call this with the combined body.

See issue #77 for the gold-standard format — tables for findings, gists, PRs, coverage; terse status line; prioritized next steps.`,
    {
      scope: z.enum(["session", "module"]).describe("session = this session; module = cross-session module tracker"),
      module_name: z.string().optional().describe("Required for scope=module. e.g. 'ecc', 'solidity-verifier'"),
      title: z.string().describe("Issue title, e.g. '[AUDIT META] ECC Module — Tracking Issue'"),
      body: z.string().describe("Full issue body (Markdown). You compose this — include findings table, gist links, coverage, next steps."),
      labels: z.array(z.string()).optional().describe("Extra labels beyond the auto-applied meta label"),
    },
    async ({ scope, module_name, title, body, labels }) => {
      if (scope === "module" && !module_name) return { content: [{ type: "text", text: "module_name required for scope=module" }], isError: true };

      const creds = getCreds();
      const metaLabel = scope === "session"
        ? `meta/session/${SESSION_META.log_id || WORKTREE_ID}`
        : `meta/module/${module_name}`;

      try {
        await Promise.all([
          creds.github.createLabel(REPO, { name: metaLabel, color: scope === "session" ? "0e8a16" : "1d76db", description: "Audit meta-issue" }).catch(() => {}),
          creds.github.createLabel(REPO, { name: "meta-issue", color: "c5def5", description: "Audit meta-issue" }).catch(() => {}),
        ]);

        const allLabels = [metaLabel, "meta-issue", ...(labels || [])];
        const existing = await creds.github.listIssues(REPO, { labels: metaLabel, state: "open", per_page: "1" });

        if (existing.length && existing[0]?.number) {
          const num = existing[0].number;
          await creds.github.updateIssue(REPO, num, { title, body });
          logActivity("artifact", `Updated meta #${num} — ${existing[0].html_url}`);
          return { content: [{ type: "text", text: `Updated #${num}: ${existing[0].html_url}` }] };
        } else {
          const issue = await creds.github.createIssue(REPO, { title, body, labels: allLabels });
          logActivity("artifact", `Created meta #${issue.number} — ${issue.html_url}`);
          otherArtifacts.push(`- [Meta #${issue.number}](${issue.html_url})`);
          await updateRootComment();
          return { content: [{ type: "text", text: `Created #${issue.number}: ${issue.html_url}` }] };
        }
      } catch (e: any) {
        return { content: [{ type: "text", text: `update_meta_issue: ${sanitizeError(e.message)}` }], isError: true };
      }
    });

  // ── create_external_pr — push to upstream barretenberg ──────────
  server.tool("create_external_pr",
    `Create a PR on the UPSTREAM repo (AztecProtocol/barretenberg), not the audit fork.
Requires the "create-external-pr" session scope. Pushes commits from the workspace to a branch on the upstream repo and opens a draft PR.
Use this for fixes that should go directly to the main barretenberg repo.`,
    {
      title: z.string().describe("PR title"),
      body: z.string().describe("PR description (Markdown)"),
      base: z.string().default("master").describe("Base branch on upstream (default: master)"),
      branch: z.string().describe("Branch name to create on upstream (e.g. 'fix/overflow-in-evaluator')"),
      closes_issues: z.array(z.number()).optional().describe("Issue numbers on the audit fork to cross-reference"),
    },
    async ({ title, body, base, branch, closes_issues }) => {
      if (!hasScope("create-external-pr")) {
        return { content: [{ type: "text", text: "Permission denied: this session does not have the 'create-external-pr' scope. Ask the operator to grant it." }], isError: true };
      }

      try {
        await pushToRemote(WORKSPACE, UPSTREAM_REPO, branch);

        const prBody = body
          + (closes_issues?.length ? "\n\n" + closes_issues.map(n => `Audit fork ref: ${REPO}#${n}`).join("\n") : "")
          + (SESSION_META.log_url ? `\n\nClaudeBox audit log: ${SESSION_META.log_url}` : "");

        const pr = await getCreds().github.createPull(UPSTREAM_REPO, {
          title, base, draft: true, head: branch, body: prBody,
        });

        otherArtifacts.push(`- [Upstream PR #${pr.number}: ${title}](${pr.html_url})`);
        logActivity("artifact", `Upstream PR #${pr.number}: ${title} — ${pr.html_url}`);
        recordArtifact("upstream-pr", pr.html_url, String(pr.number), "code", "medium", [], title);
        await updateRootComment();

        return { content: [{ type: "text", text: `${pr.html_url}\nBranch: ${branch}\n#${pr.number} (upstream: ${UPSTREAM_REPO})` }] };
      } catch (e: any) {
        return { content: [{ type: "text", text: `create_external_pr: ${sanitizeError(e.message)}` }], isError: true };
      }
    });

  return server;
}

// ── Start server ────────────────────────────────────────────────

startMcpHttpServer(createServer);
