/**
 * Barretenberg Audit Plugin — self-contained audit profile.
 *
 * Registers:
 *   - /audit dashboard page
 *   - /api/audit/* routes (coverage, findings, questions, assessments)
 *   - Slack channel claim for C0AJCUKUNGP
 *   - Audit stat schemas (assessment, file_review, artifact, summary)
 */

import type { Plugin } from "../../packages/libclaudebox/plugin.ts";
import { register } from "../../packages/libclaudebox/stat-schemas.ts";
import { registerAuditRoutes } from "./routes.ts";

const AUDIT_CHANNEL = "C0AJCUKUNGP";

const plugin: Plugin = {
  name: "barretenberg-audit",

  docker: {
    mountReferenceRepo: false,
    extraEnv: ["CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1"],
  },

  channels: [AUDIT_CHANNEL],
  requiresServer: true,

  schemas: [
    {
      name: "audit_assessment",
      description: "Self-assessment from an audit session. One entry per session.",
      fields: [
        { name: "rating", type: "string", description: "Session quality: critical | thorough | surface | incomplete" },
        { name: "modules_reviewed", type: "string[]", description: "Source paths reviewed, e.g. ['barretenberg/cpp/src/barretenberg/ecc']" },
        { name: "findings_count", type: "number", description: "Number of issues filed this session" },
        { name: "questions_count", type: "number", description: "Number of questions posted this session" },
        { name: "confidence", type: "number", description: "0-1 confidence in the review thoroughness" },
        { name: "summary", type: "string", description: "2-3 sentence summary of what was covered and key findings" },
        { name: "code_rating", type: "string?", description: "Code quality depth: thorough | surface | none" },
        { name: "crypto_rating", type: "string?", description: "Crypto quality depth: thorough | surface | none" },
        { name: "test_rating", type: "string?", description: "Test quality depth: thorough | surface | none" },
      ],
    },
    {
      name: "audit_file_review",
      description: "Record each file reviewed during an audit. Enables module coverage tracking.",
      fields: [
        { name: "file_path", type: "string", description: "Source file path relative to repo root" },
        { name: "module", type: "string", description: "Barretenberg module: ecc | crypto | polynomials | commitment_schemes | honk | ultra_honk | goblin | stdlib | vm2 | eccvm | common | etc." },
        { name: "review_depth", type: "string", description: "cursory | line-by-line | deep" },
        { name: "quality_dimension", type: "string", description: "Quality axis: code (implementation correctness, UB, memory safety) | crypto (mathematical/cryptographic correctness, side-channels) | test (test coverage, edge cases, assertions) | crypto-2nd-pass (independent re-review of crypto — ONLY valid if a different session already reviewed this file under 'crypto')" },
        { name: "issues_found", type: "number", description: "Number of issues found in this file" },
        { name: "notes", type: "string?", description: "Brief notes on what was reviewed" },
      ],
    },
    {
      name: "audit_artifact",
      description: "Record a GitHub artifact (issue, PR, or gist) created during an audit session. Auto-recorded by create_issue/create_pr/create_gist.",
      fields: [
        { name: "artifact_type", type: "string", description: "issue | pr | gist" },
        { name: "artifact_url", type: "string", description: "Full GitHub URL" },
        { name: "artifact_id", type: "string", description: "Issue/PR number or gist ID" },
        { name: "quality_dimension", type: "string", description: "code | crypto | test | crypto-2nd-pass" },
        { name: "severity", type: "string", description: "critical | high | medium | low | info (use info for PRs/gists)" },
        { name: "modules", type: "string[]", description: "Affected barretenberg modules" },
        { name: "title", type: "string", description: "Artifact title or description" },
      ],
    },
    {
      name: "audit_summary",
      description: "Record a session summary gist URL. Create a gist with full findings/coverage details, then record the URL here.",
      fields: [
        { name: "gist_url", type: "string", description: "URL of the summary gist" },
        { name: "modules_covered", type: "string[]", description: "Modules reviewed this session" },
        { name: "files_reviewed", type: "number", description: "Number of files reviewed" },
        { name: "issues_filed", type: "number", description: "Number of issues created" },
        { name: "summary", type: "string", description: "1-2 sentence summary" },
      ],
    },
  ],

  setup(ctx) {
    for (const s of plugin.schemas || []) register(s);
    registerAuditRoutes(ctx);
  },
};

export default plugin;
