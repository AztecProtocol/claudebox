/**
 * Barretenberg Audit HTTP routes.
 *
 * Extracted from profile config for readability — registers all /audit and /api/audit/* routes.
 */

import type { ProfileContext } from "../../packages/libclaudebox/profile.ts";
import { auditDashboardHTML } from "../../packages/libclaudebox/html/audit-dashboard.ts";
import { existsSync, readFileSync, readdirSync, statSync } from "fs";
import { join } from "path";
import { MAX_CONCURRENT } from "../../packages/libclaudebox/config.ts";
import { getActiveSessions, hasCapacity } from "../../packages/libclaudebox/runtime.ts";
import { getHostCreds } from "../../packages/libcreds-host/index.ts";
import type { InitiativeStore } from "./initiative-store.ts";

const AUDIT_REPO = "AztecProtocol/barretenberg-claude";

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

export function registerAuditRoutes(ctx: ProfileContext, initiativeStore?: InitiativeStore): void {
  // ── Audit dashboard page ──
  ctx.route("GET", "/audit", async ({ res }) => {
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(auditDashboardHTML());
  }, "none");

  // ── GET /api/audit/findings ──
  ctx.route("GET", "/api/audit/findings", async ({ req, res }) => {
    try {
      const url = new URL(req.url || "/", "http://localhost");
      const state = url.searchParams.get("state") || "all";
      const data = await getHostCreds().github.listIssues(AUDIT_REPO, {
        labels: "audit-finding", state, per_page: "50", sort: "updated",
      });
      jsonResponse(res, 200, data);
    } catch (e: any) {
      jsonResponse(res, 500, { error: e.message });
    }
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

  // ── Initiative routes ──────────────────────────────────────────

  if (!initiativeStore) return;

  // List page
  ctx.route("GET", "/audit/initiatives", async ({ res }) => {
    const { initiativesListHTML } = await import("./html/initiatives-list.ts");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(initiativesListHTML());
  }, "none");

  // Detail page
  ctx.route("GET", "/audit/initiatives/:tag", async ({ res, params }) => {
    const { initiativeDetailHTML } = await import("./html/initiative-detail.ts");
    res.writeHead(200, { "Content-Type": "text/html; charset=utf-8" });
    res.end(initiativeDetailHTML(params.tag));
  }, "none");

  // API: list initiatives
  ctx.route("GET", "/api/audit/initiatives", async ({ res }) => {
    jsonResponse(res, 200, initiativeStore.list());
  });

  // API: create initiative
  ctx.route("POST", "/api/audit/initiatives", async ({ req, res }) => {
    let body: any;
    try { body = JSON.parse(await readBody(req)); }
    catch { jsonResponse(res, 400, { error: "invalid JSON" }); return; }
    try {
      const init = initiativeStore.create({
        name: body.name || "",
        tag: body.tag || "",
        defaultPrompt: body.defaultPrompt || "",
        summaryPrompt: body.summaryPrompt,
        summaryThreshold: body.summaryThreshold,
      });
      jsonResponse(res, 201, init);
    } catch (e: any) {
      jsonResponse(res, 400, { error: e.message });
    }
  });

  // API: update initiative
  ctx.route("PUT", "/api/audit/initiatives/:id", async ({ req, res, params }) => {
    let body: any;
    try { body = JSON.parse(await readBody(req)); }
    catch { jsonResponse(res, 400, { error: "invalid JSON" }); return; }
    const init = initiativeStore.update(params.id, body);
    if (!init) { jsonResponse(res, 404, { error: "not found" }); return; }
    jsonResponse(res, 200, init);
  });

  // API: delete initiative
  ctx.route("DELETE", "/api/audit/initiatives/:id", async ({ req, res, params }) => {
    const ok = initiativeStore.delete(params.id);
    jsonResponse(res, ok ? 200 : 404, { ok });
  });

  // API: spawn worker for initiative
  ctx.route("POST", "/api/audit/initiatives/:id/worker", async ({ req, res, params, store, docker }) => {
    const init = initiativeStore.get(params.id);
    if (!init) { jsonResponse(res, 404, { error: "initiative not found" }); return; }
    if (!hasCapacity("barretenberg-audit")) {
      jsonResponse(res, 503, { error: "at capacity" });
      return;
    }
    let body: any = {};
    try { body = JSON.parse(await readBody(req)); } catch {}

    const basePrompt = body.prompt || init.defaultPrompt;
    const prompt = `${basePrompt}\n\nIMPORTANT: After cloning, call set_tag with tag "${init.tag}" to associate this session with the "${init.name}" initiative.`;
    docker.runContainerSession({
      prompt,
      userName: body.user || "initiative",
      profile: "barretenberg-audit",
    }, store);
    jsonResponse(res, 202, { ok: true, initiative: init.name, tag: init.tag });
  });

  // API: send one-off prompt to a new worker
  ctx.route("POST", "/api/audit/initiatives/:id/prompt", async ({ req, res, params, store, docker }) => {
    const init = initiativeStore.get(params.id);
    if (!init) { jsonResponse(res, 404, { error: "initiative not found" }); return; }
    if (!hasCapacity("barretenberg-audit")) {
      jsonResponse(res, 503, { error: "at capacity" });
      return;
    }
    let body: any;
    try { body = JSON.parse(await readBody(req)); }
    catch { jsonResponse(res, 400, { error: "invalid JSON" }); return; }
    if (!body.prompt) { jsonResponse(res, 400, { error: "prompt required" }); return; }

    const prompt = `${body.prompt}\n\nIMPORTANT: After cloning, call set_tag with tag "${init.tag}" to associate this session with the "${init.name}" initiative.`;
    docker.runContainerSession({
      prompt,
      userName: body.user || "initiative",
      profile: "barretenberg-audit",
    }, store);
    jsonResponse(res, 202, { ok: true, initiative: init.name, tag: init.tag });
  });

}
