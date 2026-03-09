import type { Plugin } from "../../packages/libclaudebox/plugin.ts";
import { register } from "../../packages/libclaudebox/stat-schemas.ts";

const plugin: Plugin = {
  name: "default",
  docker: { mountReferenceRepo: true },
  tagCategories: [
    "backports",
    "merge-train/barretenberg",
    "merge-train/spartan",
    "merge-train/fairies",
    "ci",
    "general",
  ],
  branchOverrides: {
    "honk-team": "merge-train/barretenberg",
    "team-crypto": "merge-train/barretenberg",
    "team-alpha": "merge-train/spartan",
  },
  schemas: [{
    name: "pr_analysis",
    description: "Sentiment analysis of a PR commit and its CI runs. Record one entry per commit.",
    fields: [
      { name: "pr", type: "number", description: "PR number — same across all entries for this PR" },
      { name: "pr_title", type: "string", description: "PR title" },
      { name: "pr_author", type: "string", description: "GitHub username of the PR author" },
      { name: "commit_sha", type: "string", description: "The specific commit SHA" },
      { name: "commit_message", type: "string", description: "First line of the commit message" },
      { name: "commit_ordinal", type: "number", description: "1-indexed position of this commit in the PR (1 = first push)" },
      { name: "category", type: "string", description: "Change type: feature | bugfix | refactor | chore | flake_fix | merge_conflict_fix | ci_fix | revert | docs | test | deps" },
      { name: "ci_runs", type: "number", description: "Total CI workflow runs triggered by this commit (including reruns)" },
      { name: "ci_time_minutes", type: "number", description: "Total CI wall-clock time in minutes across all runs" },
      { name: "ci_outcome", type: "string", description: "Dominant outcome: pass | fail_code | fail_flake | fail_infra | fail_merge_conflict | fail_cascade | mixed" },
      { name: "change_size", type: "string", description: "trivial (<5 lines, whitespace) | small (<50 lines) | medium (50-300) | large (300+)" },
      { name: "waste_category", type: "string", description: "Primary waste type: none | guess_rerun | ci_disproportionate | flake_retry | merge_queue_cascade | infra_failure | automatable_chore | review_iteration" },
      { name: "developer_time_estimate_minutes", type: "number", description: "Estimated developer minutes wasted waiting for or dealing with CI. 0 if clean pass." },
      { name: "ci_cost_estimate_usd", type: "number?", description: "Estimated CI compute cost in USD, if calculable" },
      { name: "automatable", type: "boolean", description: "Could this commit + its CI overhead be fully automated away?" },
      { name: "assessment", type: "string", description: "1-3 sentence analysis. Flag patterns: repeated reruns, flake-heavy suites, disproportionate CI time, automatable work." },
      { name: "tags", type: "string[]?", description: "Freeform tags: e.g. p2p, flaky-e2e, yarn-project, barretenberg" },
      { name: "confidence", type: "number", description: "0-1 confidence in the categorization" },
    ],
  }],
  promptSuffix: `## Response Style
When you finish, always create a GitHub gist with your detailed analysis, reasoning, and any verbose output.
Then call respond_to_user with a terse 1-2 sentence summary that links to the gist for details.
Keep the Slack message short — all depth goes in the gist.`,

  summaryPrompt: `Write a session summary. Call respond_to_user with a short one-line summary of what was accomplished.
Then create a gist titled "Session Summary" with a detailed breakdown:
- What was requested
- What was done (files changed, PRs created, issues found)
- Key decisions and reasoning
- Any follow-up items`,

  buildPromptContext(store) {
    const recent = store.listAll().slice(0, 20);
    if (recent.length === 0) return "";
    const lines = recent.map(s => {
      const status = s.status || "?";
      const prompt = (s.prompt || "").slice(0, 100);
      const tags = store.getWorktreeTags(s.worktree_id || "").join(",");
      return `- [${status}]${tags ? ` (${tags})` : ""} ${prompt}`;
    });
    return `## Recent sessions\n${lines.join("\n")}`;
  },

  setup() {
    for (const s of plugin.schemas || []) register(s);
  },
};

export default plugin;
