import type { Profile } from "../../packages/libclaudebox/profile.ts";
import { register } from "../../packages/libclaudebox/stat-schemas.ts";

const plugin: Profile = {
  name: "review",
  docker: { mountReferenceRepo: true },
  tagCategories: [
    "pr-review",
    "code-quality",
    "security",
    "performance",
    "test-coverage",
  ],
  schemas: [{
    name: "pr_review",
    description: "Code review findings for a PR. Record one entry per significant finding.",
    fields: [
      { name: "pr", type: "number", description: "PR number" },
      { name: "pr_title", type: "string", description: "PR title" },
      { name: "pr_author", type: "string", description: "GitHub username of the PR author" },
      { name: "file", type: "string", description: "File path of the finding" },
      { name: "line", type: "number?", description: "Line number if applicable" },
      { name: "severity", type: "string", description: "critical | high | medium | low | info" },
      { name: "category", type: "string", description: "bug | security | performance | correctness | style | test-gap | concurrency | compatibility" },
      { name: "area", type: "string", description: "barretenberg | yarn-project | noir-projects | l1-contracts | ci | docs" },
      { name: "finding", type: "string", description: "1-3 sentence description of the issue" },
      { name: "suggestion", type: "string?", description: "Suggested fix if applicable" },
      { name: "confidence", type: "number", description: "0-1 confidence in the finding" },
    ],
  }],
  promptSuffix: `## Response Style
When reviewing, create a GitHub gist with your full review (all findings, analysis, and reasoning).
Then call respond_to_user with a terse summary: number of findings by severity, and a link to the gist.
Keep the Slack message short — all depth goes in the gist.

## Review Priorities
1. Correctness: Does the code do what it claims?
2. Security: Are there exploitable paths, missing checks, or unsafe patterns?
3. Concurrency: Race conditions, deadlocks, missing locks?
4. Edge cases: Zero values, empty collections, overflow, underflow?
5. Test coverage: Are new paths tested? Are edge cases covered?
6. Compatibility: Does this break existing callers, APIs, or wire formats?

When triggered by the 'claude-review' label, call manage_review_labels(pr_number=<N>) after finishing your review to swap labels.`,

  summaryPrompt: `Summarize your review. Call respond_to_user with a one-line summary (e.g. "Reviewed PR #1234: 2 high, 3 medium findings").
Then create a gist with the full review breakdown.`,

  buildPromptContext(store) {
    const recent = store.listAll().slice(0, 10);
    if (recent.length === 0) return "";
    const lines = recent.map(s => {
      const status = s.status || "?";
      const prompt = (s.prompt || "").slice(0, 100);
      return `- [${status}] ${prompt}`;
    });
    return `## Recent review sessions\n${lines.join("\n")}`;
  },

  setup() {
    for (const s of plugin.schemas || []) register(s);
  },
};

export default plugin;
