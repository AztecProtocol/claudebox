/**
 * Barretenberg Audit Plugin — self-contained audit profile.
 *
 * Registers:
 *   - /audit dashboard page
 *   - /api/audit/* routes (coverage, findings, questions, assessments)
 *   - Slack channel claim for C0AJCUKUNGP
 */

import type { Plugin } from "../../packages/libclaudebox/plugin.ts";
import { auditDashboardHTML } from "../../packages/libclaudebox/html/audit-dashboard.ts";
import { QuestionStore } from "../../packages/libclaudebox/question-store.ts";
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { MAX_CONCURRENT, getActiveSessions, GH_TOKEN } from "../../packages/libclaudebox/config.ts";

const AUDIT_CHANNEL = "C0AJCUKUNGP";
const AUDIT_REPO = "AztecProtocol/barretenberg-claude";

// ── Helpers ──────────────────────────────────────────────────────

function jsonResponse(res: any, status: number, data: any): void {
  res.writeHead(status, { "Content-Type": "application/json" });
  res.end(JSON.stringify(data));
}

function readBody(req: any): Promise<string> {
  return new Promise((resolve, reject) => {
    const chunks: Buffer[] = [];
    let total = 0;
    req.on("data", (c: Buffer) => {
      total += c.length;
      if (total > 1024 * 1024) { req.destroy(); reject(new Error("body too large")); return; }
      chunks.push(c);
    });
    req.on("end", () => resolve(Buffer.concat(chunks).toString()));
    req.on("error", reject);
  });
}

function readJsonl(statsDir: string, filename: string): any[] {
  const f = join(statsDir, filename);
  if (!existsSync(f)) return [];
  const entries: any[] = [];
  readFileSync(f, "utf-8").split("\n").filter(l => l.trim()).forEach(l => {
    try { entries.push(JSON.parse(l)); } catch {}
  });
  return entries;
}

// ── Plugin ───────────────────────────────────────────────────────

const plugin: Plugin = {
  name: "barretenberg-audit",

  docker: {
    mountReferenceRepo: false,
    extraEnv: ["CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS=1"],
  },

  channels: [AUDIT_CHANNEL],
  requiresServer: true,

  setup(ctx) {
    // ── Audit dashboard page ──
    ctx.route("GET", "/audit", async ({ res }) => {
      res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
      res.end(auditDashboardHTML());
    }, "none");

    // ── GET /api/audit/questions ──
    ctx.route("GET", "/api/audit/questions", async ({ req, res }) => {
      const url = new URL(req.url || "/", "http://localhost");
      const status = url.searchParams.get("state") || url.searchParams.get("status") || undefined;
      const worktreeId = url.searchParams.get("worktree_id") || undefined;
      const questionStore = new QuestionStore();
      if (worktreeId) {
        jsonResponse(res, 200, questionStore.getQuestions(worktreeId, status === "all" ? undefined : status));
      } else {
        jsonResponse(res, 200, questionStore.getAll(status === "all" ? undefined : status));
      }
    });

    // ── GET /api/audit/findings ──
    ctx.route("GET", "/api/audit/findings", async ({ req, res }) => {
      if (!GH_TOKEN) { jsonResponse(res, 500, { error: "No GH_TOKEN configured" }); return; }
      const url = new URL(req.url || "/", "http://localhost");
      const state = url.searchParams.get("state") || "all";
      const ghRes = await fetch(
        `https://api.github.com/repos/${AUDIT_REPO}/issues?labels=audit-finding&state=${state}&per_page=50&sort=updated`,
        { headers: { Authorization: `Bearer ${GH_TOKEN}`, Accept: "application/vnd.github.v3+json" } },
      );
      const data = await ghRes.json();
      jsonResponse(res, ghRes.status, data);
    });

    // ── GET /api/audit/assessments ──
    ctx.route("GET", "/api/audit/assessments", async ({ res }) => {
      const statsDir = process.env.CLAUDEBOX_STATS_DIR || `${process.env.HOME}/.claudebox/stats`;
      const file = join(statsDir, "audit_assessment.jsonl");
      if (!existsSync(file)) { jsonResponse(res, 200, []); return; }
      const entries = readFileSync(file, "utf-8")
        .split("\n").filter(l => l.trim())
        .map(l => { try { return JSON.parse(l); } catch { return null; } })
        .filter(Boolean);
      jsonResponse(res, 200, entries);
    });

    // ── GET /api/audit/coverage ──
    ctx.route("GET", "/api/audit/coverage", async ({ res }) => {
      const statsDir = process.env.CLAUDEBOX_STATS_DIR || `${process.env.HOME}/.claudebox/stats`;

      const reviews = readJsonl(statsDir, "audit_file_review.jsonl");
      const summaries = readJsonl(statsDir, "audit_summary.jsonl");
      const artifacts = readJsonl(statsDir, "audit_artifact.jsonl");

      const depthOrder: Record<string, number> = { cursory: 0, "line-by-line": 1, deep: 2 };
      const dims = ["code", "crypto", "test", "crypto-2nd-pass"];

      const byFile = new Map<string, any>();
      const byFileDim = new Map<string, any>();
      for (const r of reviews) {
        const dim = r.quality_dimension || "code";
        const existingFlat = byFile.get(r.file_path);
        if (!existingFlat || (depthOrder[r.review_depth] ?? 0) > (depthOrder[existingFlat.review_depth] ?? 0)) {
          byFile.set(r.file_path, r);
        }
        const key = `${r.file_path}::${dim}`;
        const existingDim = byFileDim.get(key);
        if (!existingDim || (depthOrder[r.review_depth] ?? 0) > (depthOrder[existingDim.review_depth] ?? 0)) {
          byFileDim.set(key, { ...r, quality_dimension: dim });
        }
      }

      const repoDir = process.env.CLAUDE_REPO_DIR || join(process.env.HOME || "", "repo");
      const bbSrcDir = join(repoDir, "barretenberg/cpp/src/barretenberg");
      const moduleTotals = new Map<string, string[]>();
      function scanDir(dir: string, relBase: string) {
        try {
          for (const entry of readdirSync(dir)) {
            const full = join(dir, entry);
            const rel = relBase ? `${relBase}/${entry}` : entry;
            try {
              const st = statSync(full);
              if (st.isDirectory()) scanDir(full, rel);
              else if (entry.endsWith(".hpp") || entry.endsWith(".cpp")) {
                const mod = relBase.split("/")[0] || "root";
                if (!moduleTotals.has(mod)) moduleTotals.set(mod, []);
                moduleTotals.get(mod)!.push(`barretenberg/cpp/src/barretenberg/${rel}`);
              }
            } catch {}
          }
        } catch {}
      }
      if (existsSync(bbSrcDir)) scanDir(bbSrcDir, "");

      const byModule = new Map<string, { files: any[], issues: number }>();
      for (const r of byFile.values()) {
        const mod = r.module || "unknown";
        if (!byModule.has(mod)) byModule.set(mod, { files: [], issues: 0 });
        const m = byModule.get(mod)!;
        m.files.push(r);
        m.issues += r.issues_found || 0;
      }

      type DimData = { files: any[], issues: number };
      const byModuleDim = new Map<string, Record<string, DimData>>();
      for (const r of byFileDim.values()) {
        const mod = r.module || "unknown";
        const dim = r.quality_dimension || "code";
        if (!byModuleDim.has(mod)) byModuleDim.set(mod, {});
        const modData = byModuleDim.get(mod)!;
        if (!modData[dim]) modData[dim] = { files: [], issues: 0 };
        modData[dim].files.push(r);
        modData[dim].issues += r.issues_found || 0;
      }

      const allModules = new Set([...byModule.keys(), ...moduleTotals.keys()]);
      let totalRepoFiles = 0;
      for (const files of moduleTotals.values()) totalRepoFiles += files.length;

      const moduleData: Record<string, any> = {};
      for (const mod of [...allModules].sort()) {
        const reviewed = byModule.get(mod);
        const total = moduleTotals.get(mod);
        const dimData = byModuleDim.get(mod) || {};

        const dimensions: Record<string, any> = {};
        for (const dim of dims) {
          const d = dimData[dim];
          dimensions[dim] = {
            files_reviewed: d?.files.length || 0,
            issues_found: d?.issues || 0,
            files: (d?.files || []).map((f: any) => ({
              file_path: f.file_path, review_depth: f.review_depth,
              issues_found: f.issues_found, notes: f.notes || "",
              ts: f._ts, session: f._log_id,
            })),
          };
        }

        moduleData[mod] = {
          total_files: total?.length || 0,
          files_reviewed: reviewed?.files.length || 0,
          issues_found: reviewed?.issues || 0,
          dimensions,
          files: (reviewed?.files || []).map((f: any) => ({
            file_path: f.file_path, review_depth: f.review_depth,
            issues_found: f.issues_found, notes: f.notes || "",
            ts: f._ts, session: f._log_id,
          })),
        };
      }

      const dimensionTotals: Record<string, { files: number, issues: number }> = {};
      for (const dim of dims) {
        let files = 0, issues = 0;
        for (const modData of byModuleDim.values()) {
          if (modData[dim]) { files += modData[dim].files.length; issues += modData[dim].issues; }
        }
        dimensionTotals[dim] = { files, issues };
      }

      jsonResponse(res, 200, {
        total_repo_files: totalRepoFiles,
        total_reviewed: byFile.size,
        total_reviews: reviews.length,
        modules: moduleData,
        dimension_totals: dimensionTotals,
        artifacts: {
          issues: { open: 0, closed: 0, total: artifacts.filter(a => a.artifact_type === "issue").length },
          prs: { total: artifacts.filter(a => a.artifact_type === "pr").length },
          gists: artifacts.filter(a => a.artifact_type === "gist").length,
        },
        summaries: summaries.map(s => ({
          gist_url: s.gist_url, modules_covered: s.modules_covered,
          files_reviewed: s.files_reviewed, issues_filed: s.issues_filed,
          summary: s.summary, ts: s._ts, session: s._log_id,
        })),
      });
    });

    // ── POST /api/audit/questions/:id/answer ──
    ctx.route("POST", "/api/audit/questions/:id/answer", async ({ req, res, params, store, docker }) => {
      let body: any;
      try { body = JSON.parse(await readBody(req)); }
      catch { jsonResponse(res, 400, { error: "invalid JSON" }); return; }

      const questionId = params.id || params[0 as any];
      const selectedOption = body.selected_option;
      const freeformAnswer = body.freeform_answer || "";
      const answeredBy = body.answered_by || "web";

      if (!selectedOption) { jsonResponse(res, 400, { error: "selected_option required" }); return; }

      const questionStore = new QuestionStore();
      const allQuestions = questionStore.getAll();
      const target = allQuestions.find(q => q.id === questionId);
      if (!target) { jsonResponse(res, 404, { error: `Question ${questionId} not found` }); return; }

      const ok = questionStore.answerQuestion(target.worktree_id, questionId, selectedOption, freeformAnswer, answeredBy);
      if (!ok) { jsonResponse(res, 409, { error: "Question already answered or expired" }); return; }

      const allResolved = questionStore.allResolved(target.worktree_id);
      let resumed = false;

      if (allResolved) {
        const session = store.findByWorktreeId(target.worktree_id);
        if (session && session.status !== "running" && store.isWorktreeAlive(target.worktree_id) && getActiveSessions() < MAX_CONCURRENT) {
          const resumePrompt = questionStore.buildResumePrompt(target.worktree_id);
          resumed = true;
          docker.runContainerSession({
            prompt: resumePrompt,
            userName: session.user || "auto-resume",
            worktreeId: target.worktree_id,
            targetRef: session.base_branch ? `origin/${session.base_branch}` : undefined,
            profile: session.profile || undefined,
          }, store).then(() => {
            console.log(`[AUDIT] Auto-resumed session for worktree ${target.worktree_id}`);
          }).catch(e => {
            console.error(`[AUDIT] Auto-resume failed for ${target.worktree_id}: ${e.message}`);
          });
        }
      }

      if (GH_TOKEN) {
        questionStore.pushToQuestionsBranch(target.worktree_id, AUDIT_REPO, GH_TOKEN).catch(e => {
          console.error(`[AUDIT] Failed to push to questions branch: ${e.message}`);
        });
      }

      jsonResponse(res, 200, { ok: true, all_resolved: allResolved, resumed, worktree_id: target.worktree_id });
    });

    // ── POST /api/audit/questions/direction ──
    ctx.route("POST", "/api/audit/questions/direction", async ({ req, res }) => {
      let body: any;
      try { body = JSON.parse(await readBody(req)); }
      catch { jsonResponse(res, 400, { error: "invalid JSON" }); return; }

      const { worktree_id, text, author } = body;
      if (!worktree_id || !text) { jsonResponse(res, 400, { error: "worktree_id and text required" }); return; }

      const questionStore = new QuestionStore();
      questionStore.setDirection(worktree_id, text, author || "web");
      jsonResponse(res, 200, { ok: true });
    });
  },
};

export default plugin;
